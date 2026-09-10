import { getBuiltinAgentAdapterRuntime } from "../runtime/agentAdapterRuntime.js";
import type { AgentAdapterType } from "./types.js";
import { configuredInstanceBinding } from "./instanceClient.js";
import { notifyInstanceAgent } from "./lanAgentAdapter.js";
import type { AgentAdapter } from "./contracts.js";

export type { AgentAdapter, AgentDeliveryOptions } from "./contracts.js";

export async function createAgentAdapter(type: AgentAdapterType): Promise<AgentAdapter> {
  const binding = configuredInstanceBinding(type);
  if (binding) return { type, deliver: (envelope, options) => notifyInstanceAgent(type, binding, envelope, options) };
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.create(type);
}

export async function listRegisteredAgentAdapterManifests() {
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.listManifests();
}
