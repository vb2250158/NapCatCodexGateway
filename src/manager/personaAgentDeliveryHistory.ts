import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import { appendPersonaChatReply } from "../personaChatHistory.js";

export async function recordPersonaAgentDelivery(
  request: AgentThreadRequest,
  result: AgentThreadRequestResult,
  dependencies: {
    roleForTask: (sessionId: string, workspace?: string) => string | undefined;
    roleDir: (roleId: string) => string;
    changed: (roleId: string) => void;
  }
): Promise<void> {
  if (request.messageSource?.type !== "agent") return;
  const delivery = result.data.delivery as { deliveryId?: string; status?: string } | undefined;
  const source = result.data.source as { threadId?: string; threadName?: string; workspace?: string } | undefined;
  const sessionId = source?.threadId || request.sourceThreadId;
  const targetSessionId = String(result.data.threadId || "");
  const text = request.prompt?.trim() || [request.result, request.nextAction].filter(Boolean).join("\n");
  if (!delivery?.deliveryId || !sessionId || !targetSessionId || !text) return;
  if (!["delivered", "unconfirmed"].includes(delivery.status || "")) return;
  const roleIds = new Set([
    dependencies.roleForTask(sessionId, source?.workspace || request.messageSource.workspace),
    dependencies.roleForTask(targetSessionId, request.cwd)
  ].filter((id): id is string => Boolean(id)));
  for (const roleId of roleIds) {
    const added = await appendPersonaChatReply(dependencies.roleDir(roleId), {
      kind: "agent_delivery", sessionId, targetSessionId, text,
      sessionTitle: source?.threadName || request.messageSource.sessionName,
      deliveryId: delivery.deliveryId,
      deliveryStatus: delivery.status === "delivered" ? "delivered" : "unconfirmed"
    });
    if (added) dependencies.changed(roleId);
  }
}
