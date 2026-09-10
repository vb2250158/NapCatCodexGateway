import { randomUUID } from "node:crypto";
import { renderRabiDelivery, type RabiDeliveryEnvelope } from "../shared/rabiMessage.js";
import { reportAgentState } from "./stateReporter.js";
import type { AgentDeliveryOptions } from "./contracts.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import type { AgentAdapterType } from "./types.js";

/** Gateway receives the current Manager endpoint from its lifecycle owner. */
export async function notifyInstanceAgent(type: AgentAdapterType, binding: AgentInstanceBinding, envelope: RabiDeliveryEnvelope, options?: AgentDeliveryOptions): Promise<void> {
  const nodeId = binding.instanceId;
  const baseUrl = process.env.GATEWAY_MANAGER_URL?.trim();
  const token = process.env.LAN_AGENT_ACCESS_TOKEN?.trim();
  const state = { monitorThreadSource: nodeId, agentAdapterType: type, instanceId: nodeId, agentId: binding.agentId };
  try {
    if (!nodeId) throw new Error("请在消息适配器中选择已接入的远端 Agent 节点。");
    if (!baseUrl || !token) throw new Error("Manager 局域网连接未就绪；请检查局域网访问设置并重新启动此消息路线。");
    if (options?.imagePaths?.length) throw new Error("远端 Agent 尚不支持传送本机图片文件，请使用远端可访问的附件链接。");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/lan-agent/instances/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(binding.agentId)}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
      body: JSON.stringify({ message: renderRabiDelivery(envelope), provider: type === "codex" ? "codex-desktop" : type, idempotencyKey: envelope.deliveryId || randomUUID() }),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json() as { code?: number; message?: string; result?: { taskId?: string; status?: string } };
    if (!response.ok || body.code !== 0 || !body.result?.taskId) throw new Error(body.message || `远端 Agent 投递失败：HTTP ${response.status}`);
    reportAgentState(type, { ...state, bound: true, lastTaskId: body.result.taskId, lastTaskStatus: body.result.status, lastNotificationAt: new Date().toISOString(), lastNotificationError: null });
  } catch (error) {
    reportAgentState(type, { ...state, bound: false, lastNotificationError: error instanceof Error ? error.message : String(error), lastNotificationErrorAt: new Date().toISOString() });
    throw error;
  }
}
