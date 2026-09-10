import { randomUUID } from "node:crypto";
import { resolveTaskWorkspace } from "./cwd-policy.mjs";
import { normalizeDshBinding } from "./dsh.mjs";

/** The executing computer owns its Agent configuration. Catalogs never carry connection tokens. */
export function instanceAgents(config) {
  return Array.isArray(config.agents) ? config.agents : [{
    agentId: "default", name: "Agent", provider: config.agentType || "codex-desktop", enabled: true,
    workspace: config.defaultWorkspace, sessionId: config.agentType === "dsh" ? config.dsh?.sessionId : config.codexDesktop?.threadId,
    model: config.codexDesktop?.model, reasoningEffort: config.codexDesktop?.reasoningEffort, dsh: config.dsh
  }];
}

export function agentCatalog(config) {
  return instanceAgents(config).map(({ agentId, name, provider, enabled, workspace, sessionId, managedSessionIds, model, reasoningEffort, dsh }) => ({ agentId, name, provider, enabled, workspace, sessionId, managedSessionIds, model, reasoningEffort, dshBaseUrl: dsh?.baseUrl }));
}

export function configureInstanceAgent(config, input) {
  if (!input || typeof input !== "object") throw new Error("Agent configuration is required.");
  const agents = instanceAgents(config);
  const agentId = input.agentId || randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(agentId)) throw new Error("Invalid Agent identity.");
  const current = agents.find(agent => agent.agentId === agentId);
  const provider = input.provider || current?.provider;
  if (!["codex-desktop", "dsh"].includes(provider)) throw new Error("Unsupported Agent provider.");
  if (current && current.provider !== provider) throw new Error("Create a new Agent when changing providers.");
  const workspace = resolveTaskWorkspace(input.workspace || current?.workspace, config);
  const sessionId = String(input.sessionId ?? current?.sessionId ?? "").trim();
  if (!sessionId || sessionId.length > 192) throw new Error("Select an existing task owner before saving this Agent.");
  if (agents.some(agent => agent.agentId !== agentId && agent.provider === provider && (agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId)))) throw new Error("This task already belongs to another Agent in this instance.");
  const agent = {
    agentId, provider, workspace, sessionId, name: String(input.name || current?.name || "Agent").slice(0, 160),
    managedSessionIds: current?.sessionId === sessionId ? current?.managedSessionIds : undefined,
    enabled: input.enabled ?? current?.enabled ?? true,
    model: String(input.model ?? current?.model ?? "").trim() || undefined,
    reasoningEffort: String(input.reasoningEffort ?? current?.reasoningEffort ?? "medium").trim(),
    dsh: provider === "dsh" ? normalizeDshBinding({ baseUrl: input.dshBaseUrl || current?.dsh?.baseUrl || config.dsh?.baseUrl, sessionId }) : undefined
  };
  if (typeof agent.enabled !== "boolean") throw new Error("Agent enabled must be a boolean.");
  if (!current && agents.length >= 128) throw new Error("This instance already has 128 Agents.");
  return { ...config, agents: current ? agents.map(item => item.agentId === agentId ? agent : item) : [...agents, agent] };
}

/** Only tasks resolved on this computer may inherit their primary Agent's Hook context. */
export function registerManagedSession(config, agentId, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 192) return config;
  const agents = instanceAgents(config);
  const owner = agents.find(agent => agent.agentId === agentId);
  if (!owner) throw new Error("The primary instance Agent no longer exists.");
  if (agents.some(agent => agent.agentId !== agentId && (agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId)))) throw new Error("The task belongs to another instance Agent.");
  if (owner.sessionId === sessionId || owner.managedSessionIds?.includes(sessionId)) return config;
  if ((owner.managedSessionIds?.length || 0) >= 512) throw new Error("This Agent already owns 512 managed tasks.");
  return { ...config, agents: agents.map(agent => agent.agentId === agentId ? { ...agent, managedSessionIds: [...agent.managedSessionIds || [], sessionId] } : agent) };
}

export function resolveInstanceAgent(config, task) {
  const agents = instanceAgents(config);
  const agent = agents.find(agent => agent.agentId === (task.agentId || "default"));
  if (!agent || !agent.enabled) throw new Error("The requested instance Agent is missing or disabled.");
  if (task.targetAgent !== agent.provider) throw new Error("The requested provider does not match the bound Agent.");
  return agent;
}
