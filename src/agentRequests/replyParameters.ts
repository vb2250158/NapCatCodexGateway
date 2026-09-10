import type { AgentCommunicationPreparation, AgentRequestRecord } from "./store.js";

export function agentReplyRequest({ source, target, requestId }: Pick<AgentCommunicationPreparation,
  "source" | "target" | "requestId">): Record<string, unknown> {
  return {
    action: "send", threadId: source.threadId, cwd: source.workspace,
    messageSource: { type: "agent", agentAdapter: target.agentAdapter,
      sessionId: target.threadId, sessionName: target.threadName || target.threadId, workspace: target.workspace },
    sourceThreadId: target.threadId, sourceAgentType: target.agentType || "agent",
    inReplyToRequestId: requestId,
    prompt: "<回复正文；与 result、nextAction 相同的内容无需重复>",
    result: "<结果>", nextAction: "<下一步>", responsePolicy: "none"
  };
}

export function agentRequestReminderPrompt(request: AgentRequestRecord): string {
  return [
    "[Rabi Agent 请求回复提醒]",
    `原请求时间：${request.createdAt}`,
    `需要回答：${request.responseInstruction}`,
    "尚未记录正式回传；普通任务最终文字不替代接口回执。",
    "[回传参数]",
    JSON.stringify({ requestId: request.id, endpoint: "POST /api/agent/threads",
      request: agentReplyRequest({ source: request.source, target: request.target, requestId: request.id }) }, null, 2),
    "需要继续往返时填写 responsePolicy=required 和 responseInstruction。"
  ].join("\n");
}

/** Delivery and reminders share one reply request schema; recovery uses durable evidence. */
export function agentReplyParameters(preparation: AgentCommunicationPreparation): Record<string, unknown> {
  return {
    deliveryId: preparation.deliveryId,
    responsePolicy: preparation.responsePolicy,
    ...(preparation.inReplyToRequestId ? { inReplyToRequestId: preparation.inReplyToRequestId } : {}),
    ...(preparation.requestId ? {
      requestId: preparation.requestId,
      responseInstruction: preparation.responseInstruction,
      endpoint: "POST /api/agent/threads",
      request: agentReplyRequest(preparation),
      continuation: "需要继续往返时，将 request.responsePolicy 改为 required 并填写 responseInstruction。"
    } : {})
  };
}

export function renderAgentReplyParameters(preparation: AgentCommunicationPreparation): string {
  return `[回传参数]\n${JSON.stringify(agentReplyParameters(preparation), null, 2)}`;
}
