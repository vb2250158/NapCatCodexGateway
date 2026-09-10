/** Computer identity is independent of its current network address and provider. */
export type AgentInstanceBinding = { instanceId: string; agentId: string };

export type InstanceAgent = {
  agentId: string;
  name: string;
  provider: string;
  enabled: boolean;
  workspace?: string;
  sessionId?: string;
  managedSessionIds?: string[];
  model?: string;
  reasoningEffort?: string;
  routeId?: string;
  configRevision?: string;
  dshBaseUrl?: string;
};

export type AgentInstance = {
  instanceId: string;
  local: boolean;
  address?: string;
  connected: boolean;
  version?: string;
  agents: InstanceAgent[];
};

export function normalizeAgentInstanceBinding(value: unknown): AgentInstanceBinding | undefined {
  if (value == null) return undefined;
  const raw = value as Partial<AgentInstanceBinding>;
  const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id);
  if (!validId(raw.instanceId) || !validId(raw.agentId)) throw new Error("Agent binding requires stable instanceId and agentId.");
  return { instanceId: raw.instanceId, agentId: raw.agentId };
}

export function normalizeAgentInstanceBindings(value: unknown): Record<string, AgentInstanceBinding> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid instance bindings.");
  const bindings = Object.fromEntries(Object.entries(value).map(([provider, binding]) => {
    if (!["codex", "copilotCli", "marvis", "astrbot", "dsh"].includes(provider)) throw new Error("Unknown bound Agent provider.");
    const normalized = normalizeAgentInstanceBinding(binding);
    if (!normalized) throw new Error("Empty instance binding.");
    return [provider, normalized];
  }));
  return Object.keys(bindings).length ? bindings : undefined;
}

export function normalizeInstanceAgents(value: unknown): InstanceAgent[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid instance Agent catalog.");
  const ids = new Set<string>();
  return value.map(raw => {
    const binding = normalizeAgentInstanceBinding({ instanceId: "instance", agentId: raw?.agentId })!;
    if (ids.has(binding.agentId)) throw new Error("Duplicate instance Agent identity.");
    ids.add(binding.agentId);
    if (typeof raw.provider !== "string" || !raw.provider.trim() || raw.provider.length > 80) throw new Error("Agent provider is required.");
    const text = (value: unknown, limit = 1024) => typeof value === "string" ? value.trim().slice(0, limit) || undefined : undefined;
    return { agentId: binding.agentId, name: text(raw.name, 160) || binding.agentId, provider: raw.provider, enabled: raw.enabled !== false,
      workspace: text(raw.workspace), sessionId: text(raw.sessionId, 192),
      managedSessionIds: Array.isArray(raw.managedSessionIds) ? [...new Set(raw.managedSessionIds.map((id: unknown) => text(id, 192)).filter((id: string | undefined): id is string => Boolean(id)))].slice(0, 512) as string[] : undefined,
      model: text(raw.model, 160), reasoningEffort: text(raw.reasoningEffort, 32), dshBaseUrl: text(raw.dshBaseUrl) };
  });
}
