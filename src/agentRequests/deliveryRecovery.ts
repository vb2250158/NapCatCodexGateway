import { readRolloutUserMessages } from "./rolloutReceipt.js";
import { readCodexDesktopThread } from "../codexDesktopBridge.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { AgentRequestStore, agentDeliveryPromptHash, type AgentCommunicationPreparation } from "./store.js";
import { readAgentResponseContent } from "./responseContent.js";
import { currentEnvelopeDeliveryId, withoutLegacyTransportSuffix, deliveryUserMessagesFromRollout } from "../shared/deliveryIdentity.js";
export { deliveryUserMessagesFromRollout } from "../shared/deliveryIdentity.js";

export function recoverAgentResponseDelivery(
  store: AgentRequestStore,
  threadId: string,
  deliveryId: string,
  readMessages: (threadId: string) => string[]
): { status: string; inReplyToRequestId?: string; requestId?: string; deliveryId: string } {
  const records = store.list();
  const original = records.find(record => record.source.threadId === threadId
    && (record.pendingResponseDeliveryId === deliveryId || record.response?.deliveryId === deliveryId));
  if (!original) return { status: "reservation_missing", deliveryId };
  const followup = records.find(record => record.deliveryId === deliveryId);
  const communication = { deliveryId, inReplyToRequestId: original.id, requestId: followup?.id };
  if (original.status === "responded" && original.response?.deliveryId === deliveryId) {
    return { ...communication, status: "already_recorded" };
  }
  if (original.status !== "awaiting_response" || original.source.agentAdapter !== "codex"
    || original.target.agentAdapter !== "codex") return { ...communication, status: "not_recoverable" };
  if (followup && (followup.status === "cancelled"
    || followup.source.threadId !== original.target.threadId
    || followup.target.threadId !== original.source.threadId
    || !sameCodexWorkspace(followup.source.workspace || "", original.target.workspace || "")
    || !sameCodexWorkspace(followup.target.workspace || "", original.source.workspace || ""))) {
    return { ...communication, status: "identity_mismatch" };
  }
  for (const raw of readMessages(threadId)) {
    const text = raw.replace(/\r\n/g, "\n");
    if (original.pendingResponseEvidence) {
      const { promptHash, preparation } = original.pendingResponseEvidence;
      const prefix = withoutLegacyTransportSuffix(text);
      const exactEvidence = agentDeliveryPromptHash(text) === promptHash
        || (prefix !== undefined && currentEnvelopeDeliveryId(prefix) === deliveryId
          && agentDeliveryPromptHash(prefix) === promptHash);
      if (!exactEvidence || preparation.deliveryId !== deliveryId
        || preparation.inReplyToRequestId !== original.id
        || preparation.source.threadId !== original.target.threadId
        || preparation.target.threadId !== original.source.threadId
        || !sameCodexWorkspace(preparation.source.workspace || "", original.target.workspace || "")
        || !sameCodexWorkspace(preparation.target.workspace || "", original.source.workspace || "")) continue;
      store.commit(preparation, { action: "receipt_recovered", transport: "desktop-ipc" });
      return { ...communication, status: "receipt_recovered" };
    }
    if (!text.startsWith("[消息源]\n")) continue;
    const header = text.split("\n\n[消息内容]\n")[0];
    if (!header.includes(`\n会话 ID：${original.target.threadId}\n`)
      || !header.includes("\nAgent 端：codex\n")) continue;
    const workspace = /^工作目录：(.*)$/m.exec(header)?.[1];
    if (!workspace || !sameCodexWorkspace(workspace, original.target.workspace || "")) continue;
    // Read-only compatibility for accepted historical messages with outstanding reservations.
    // New deliveries only use replyParameters.ts; retire this branch after old reservations close.
    if (text.split("[Agent 回复合同]\n").length !== 2) continue;
    const contract = text.split("[Agent 回复合同]\n")[1];
    const identityPrefix = `本次投递 deliveryId：${deliveryId}\n是否要求回复：${followup ? "是" : "否"}\n本次消息已经正式回复请求：${original.id}\n`;
    if (contract.startsWith(identityPrefix + "回复字段：见消息内容（v2）")) {
      const expectedTail = followup
        ? `\n必须回复的 requestId：${followup.id}\n需要回答：${followup.responseInstruction}\nPOST /api/agent/threads：`
        : "";
      const rest = contract.slice((identityPrefix + "回复字段：见消息内容（v2）").length);
      if (followup ? !rest.startsWith(expectedTail) : !!rest.trim()) continue;
      if (followup && (!rest.includes(`sessionId=${threadId}，`)
        || !rest.includes(`sourceThreadId=${threadId}，`)
        || !rest.includes(`inReplyToRequestId=${followup.id}，`))) continue;
      const content = text.split("\n\n[消息内容]\n")[1]?.split("\n\n[Agent 回复合同]\n")[0];
      const response = content && readAgentResponseContent(content);
      if (!response) continue;
      store.commit({ ...communication, source: followup?.source ?? original.target, target: original.source,
        responsePolicy: followup ? "required" : "none", responseInstruction: followup?.responseInstruction,
        ...response }, { action: "receipt_recovered", transport: "desktop-ipc" });
      return { ...communication, status: "receipt_recovered" };
    }
    // Historical delivered prompts remain evidence until their reservations close.
    const prefix = identityPrefix + "回复结果：";
    if (!contract.startsWith(prefix)) continue;
    const suffix = followup
      ? `\n必须回复的 requestId：${followup.id}\n需要回答：${followup.responseInstruction}\n当前接收会话 ID：${threadId}\n`
      : "\n本次投递不要求回复。后续投递仍需填写 responsePolicy=required 或 none。";
    const end = contract.indexOf(suffix, prefix.length);
    if (end < 0) continue;
    const response = contract.slice(prefix.length, end).split("\n下一步：");
    if (response.length !== 2 || !response[0].trim() || !response[1].trim()) continue;
    const preparation: AgentCommunicationPreparation = {
      ...communication, source: followup?.source ?? original.target, target: original.source,
      responsePolicy: followup ? "required" : "none", responseInstruction: followup?.responseInstruction,
      result: response[0], nextAction: response[1]
    };
    store.commit(preparation, { action: "receipt_recovered", transport: "desktop-ipc" });
    return { ...communication, status: "receipt_recovered" };
  }
  return { ...communication, status: "delivery_unconfirmed" };
}

/** Use the entire exact rollout for explicit recovery; keep the pure verifier shared. */
export async function recoverAgentResponseDeliveryFromRollout(
  store: AgentRequestStore,
  threadId: string,
  deliveryId: string
): Promise<ReturnType<typeof recoverAgentResponseDelivery>> {
  const initial = recoverAgentResponseDelivery(store, threadId, deliveryId, () => []);
  if (initial.status !== "delivery_unconfirmed") return initial;
  const thread = readCodexDesktopThread(threadId);
  if (!thread?.rolloutPath) return { ...initial, status: "receipt_source_missing" };
  const evidenceHash = initial.inReplyToRequestId
    ? store.get(initial.inReplyToRequestId)?.pendingResponseEvidence?.promptHash : undefined;
  try {
    for await (const prompt of readRolloutUserMessages(thread.rolloutPath)) {
      if (!prompt.includes(deliveryId) && agentDeliveryPromptHash(prompt) !== evidenceHash) continue;
      const result = recoverAgentResponseDelivery(store, threadId, deliveryId, () => [prompt]);
      if (result.status !== "delivery_unconfirmed") return result;
    }
  } catch (error) {
    throw new Error(`Reply receipt recovery could not complete: ${(error as NodeJS.ErrnoException).code || (error as Error).name || "recovery_failed"}. Keep the original deliveryId and verify task-record access and request-storage persistence before retrying recovery.`);
  }
  return initial;
}
