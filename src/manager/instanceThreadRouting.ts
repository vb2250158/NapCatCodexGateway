import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import type { AgentInstance } from "../shared/agentInstance.js";
import { normalizeAgentInstanceBinding } from "../shared/agentInstance.js";

export type InstanceThreadTransport = {
  instances: () => AgentInstance[];
  manage: (instanceId: string, params: Record<string, unknown>) => Promise<unknown>;
};

/** Resolve identity before any local provider lookup, including when the remote computer is offline. */
export async function routeInstanceThread(request: AgentThreadRequest, transport: InstanceThreadTransport): Promise<AgentThreadRequestResult | undefined> {
  const instances = transport.instances();
  let binding = normalizeAgentInstanceBinding(request.instanceBinding);
  if (!binding) {
    const sessionId = request.threadId || request.sourceThreadId;
    if (!sessionId) return undefined;
    const owners = instances.filter(instance => !instance.local).flatMap(instance => instance.agents
      .filter(agent => agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId))
      .map(agent => ({ instanceId: instance.instanceId, agentId: agent.agentId })));
    if (owners.length > 1) throw new Error("Task identity exists on multiple instances; specify instanceId and agentId.");
    binding = owners[0];
    if (!binding) return undefined;
  }
  const instance = instances.find(item => item.instanceId === binding!.instanceId);
  if (instance?.local) return undefined;
  const agent = instance?.agents.find(item => item.agentId === binding!.agentId);
  if (!instance?.connected || !agent?.enabled) throw new Error("The target instance Agent is offline or disabled.");
  const provider = agent.provider === "codex-desktop" ? "codex" : agent.provider;
  if (request.agentAdapter && request.agentAdapter !== provider) throw new Error("Task provider does not match its instance Agent.");
  if (request.imagePaths?.length) throw new Error("Local image paths cannot be used on another instance.");
  const { instanceBinding: _binding, ...params } = request;
  const result = await transport.manage(instance.instanceId, { ...params, agentId: agent.agentId, agentAdapter: provider }) as AgentThreadRequestResult;
  if (!result || !Number.isInteger(result.statusCode) || !result.data) throw new Error("The instance returned an invalid task result.");
  return result;
}
