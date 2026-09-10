import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeAgentInstanceBindings, type AgentInstance, type AgentInstanceBinding } from "../shared/agentInstance.js";

export function configuredInstanceBinding(provider: string): AgentInstanceBinding | undefined {
  return normalizeAgentInstanceBindings(JSON.parse(process.env.AGENT_INSTANCE_BINDINGS || "{}"))?.[provider];
}

async function instanceRequest(suffix: string, body?: unknown): Promise<any> {
  const baseUrl = process.env.GATEWAY_MANAGER_URL?.trim();
  const token = process.env.LAN_AGENT_ACCESS_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("The owning Manager has not supplied the instance connection.");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/lan-agent/instances${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000)
  });
  const result = await response.json() as any;
  if (!response.ok || result.code !== 0) throw new Error(result.message || `Instance request failed: HTTP ${response.status}`);
  return result;
}

export async function readBoundInstanceAgent(binding: AgentInstanceBinding) {
  const result = await instanceRequest("");
  const instance = (result.instances as AgentInstance[]).find(item => item.instanceId === binding.instanceId);
  const agent = instance?.agents.find(item => item.agentId === binding.agentId);
  if (!instance?.connected || !agent?.enabled || !agent.sessionId || !agent.workspace) throw new Error("The bound instance Agent is offline, disabled, or has no task owner.");
  return agent;
}

export async function requestInstanceThread(binding: AgentInstanceBinding, payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (Array.isArray(payload.imagePaths) && payload.imagePaths.length) throw new Error("Instance tasks require remotely accessible attachments; local image paths cannot be sent to another computer.");
  const { result } = await instanceRequest(`/${encodeURIComponent(binding.instanceId)}/agents/${encodeURIComponent(binding.agentId)}/threads`, payload);
  if (!result || result.statusCode >= 400) throw new Error(result?.data?.message || "Instance task operation failed.");
  return result.data;
}

/** Changing computer or primary task cannot revive workers from an unrelated owner. */
export function instanceWorkerStateDirectory(dataDir: string, binding: AgentInstanceBinding, sessionId: string): string {
  const scope = createHash("sha256").update(JSON.stringify([binding.instanceId, binding.agentId, sessionId])).digest("hex");
  return path.join(dataDir, "instance-workers", scope);
}
