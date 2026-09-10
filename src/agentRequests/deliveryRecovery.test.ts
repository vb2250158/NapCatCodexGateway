import assert from "node:assert/strict";
import test from "node:test";
import { AgentRequestStore, type AgentRequestPersistence } from "./store.js";
import { deliveryUserMessagesFromRollout, recoverAgentResponseDelivery } from "./deliveryRecovery.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";
import { renderAgentReplyParameters } from "./replyParameters.js";

class MemoryPersistence implements AgentRequestPersistence {
  value: unknown;
  read(): unknown { return this.value; }
  write(value: unknown): void { this.value = structuredClone(value); }
}

test("historical transport suffix requires exact reserved bytes and rejects quoted or altered evidence", () => {
  const { persistence, store, initial, reply } = fixture(false);
  const prompt = renderRabiDelivery({
    messageSource: { type: "agent", agentAdapter: "codex", sessionName: "Target", sessionId: "target", workspace: "C:/repo" },
    messageContent: "Exact original evidence", controlBlocks: [renderAgentReplyParameters(reply)]
  });
  store.bindResponseEvidence(reply, prompt);
  const suffix = "\n\n[投递编号]\ndeliveryId: 12345678-1234-4567-8123-123456789abc";
  const restarted = new AgentRequestStore(persistence);
  for (const altered of ["", "quoted\n" + prompt + suffix, prompt.replace("Exact", "Altered") + suffix,
    prompt + suffix + suffix, prompt + suffix + "\nextra", prompt + suffix.replace("deliveryId:", "deliveryId：")]) {
    assert.equal(recoverAgentResponseDelivery(restarted, "source", reply.deliveryId, () => [altered]).status, "delivery_unconfirmed");
    assert.equal(restarted.get(initial.requestId!)?.status, "awaiting_response");
  }
  assert.equal(recoverAgentResponseDelivery(restarted, "source", reply.deliveryId, () => [prompt + suffix]).status, "receipt_recovered");
  assert.equal(restarted.get(initial.requestId!)?.response?.result, reply.result);
});

test("new response recovery uses durable structured evidence, independent of presentation", () => {
  const { persistence, store, initial, reply } = fixture();
  const prompt = "A future presentation\nwith arbitrary headings\n[消息内容]\nnot parsed";
  store.bindResponseEvidence(reply, prompt);
  const restarted = new AgentRequestStore(persistence);
  assert.equal(recoverAgentResponseDelivery(restarted, "source", reply.deliveryId,
    () => [prompt + " altered"]).status, "delivery_unconfirmed");
  assert.equal(recoverAgentResponseDelivery(restarted, "source", reply.deliveryId,
    () => [prompt.replace(/\n/g, "\r\n")]).status, "receipt_recovered");
  assert.equal(restarted.get(initial.requestId!)?.response?.result, reply.result);
  assert.equal(restarted.get(initial.requestId!)?.pendingResponseEvidence, undefined);
});

test("failed evidence persistence prevents a false in-memory receipt", () => {
  const { persistence, store, reply } = fixture(false);
  persistence.write = () => { throw new Error("disk failure"); };
  assert.throws(() => store.bindResponseEvidence(reply, "not sent"), /disk failure/);
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId,
    () => ["not sent"]).status, "delivery_unconfirmed");
});

test("failed receipt persistence retains recoverable evidence for a same-process retry", () => {
  const { persistence, store, initial, reply } = fixture();
  store.bindResponseEvidence(reply, "accepted prompt");
  const write = persistence.write.bind(persistence);
  persistence.write = () => { throw new Error("disk failure"); };
  assert.throws(() => store.commit(reply), /disk failure/);
  assert.equal(store.get(initial.requestId!)?.status, "awaiting_response");
  assert.ok(store.get(initial.requestId!)?.pendingResponseEvidence);
  persistence.write = write;
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId,
    () => ["accepted prompt"]).status, "receipt_recovered");
});

function fixture(required = true) {
  const persistence = new MemoryPersistence();
  const store = new AgentRequestStore(persistence);
  const source = { threadId: "source", agentAdapter: "codex" as const, agentType: "agent", workspace: "C:\\repo" };
  const target = { ...source, threadId: "target" };
  const initial = store.prepare({ source, target, responsePolicy: "required", responseInstruction: "修复" });
  store.commit(initial);
  const reply = store.prepare({ source: target, target: source,
    inReplyToRequestId: initial.requestId, responsePolicy: required ? "required" : "none",
    responseInstruction: required ? "验收新包" : undefined, result: "修复完成\n测试通过", nextAction: "构建\n验收" });
  const message = `[消息源]\n消息源类型：Agent\nAgent 端：codex\n会话 ID：target\n工作目录：C:\\repo\n消息包发送时间：today\n\n[消息内容]\n已完成\n\n[Agent 回复合同]\n本次投递 deliveryId：${reply.deliveryId}\n是否要求回复：${required ? "是" : "否"}\n本次消息已经正式回复请求：${initial.requestId}\n回复结果：${reply.result}\n下一步：${reply.nextAction}`
    + (required ? `\n必须回复的 requestId：${reply.requestId}\n需要回答：验收新包\n当前接收会话 ID：source\n后续合同`
      : "\n本次投递不要求回复。后续投递仍需填写 responsePolicy=required 或 none。");
  return { store, persistence, initial, reply, message };
}

test("exact accepted response recovers both reservations after restart without completing followup", () => {
  const { persistence, initial, reply, message } = fixture();
  const store = new AgentRequestStore(persistence);
  store.recordTargetTurnEnded("target", "C:\\repo", "turn");
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => [message]).status, "receipt_recovered");
  assert.equal(store.get(initial.requestId!)?.response?.result, reply.result);
  assert.equal(store.get(initial.requestId!)?.nextReminderAt, undefined);
  assert.equal(store.get(reply.requestId!)?.status, "awaiting_response");
  assert.equal(store.get(reply.requestId!)?.deliveryAction, "receipt_recovered");
  const saved = structuredClone(persistence.value);
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => { throw Error("must not read"); }).status, "already_recorded");
  store.commit(reply);
  assert.deepEqual(persistence.value, saved);
});

test("response ending the exchange recovers without inventing a new request", () => {
  const { store, initial, reply, message } = fixture(false);
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => [message]).status, "receipt_recovered");
  assert.equal(store.get(initial.requestId!)?.status, "responded");
  assert.equal(store.list().length, 1);
});

test("missing evidence and identity or contract mismatches never commit", () => {
  const { store, persistence, reply, message } = fixture();
  const saved = structuredClone(persistence.value);
  for (const altered of ["", reply.deliveryId, message.replace("会话 ID：target", "会话 ID：intruder"),
    message.replace("C:\\repo", "C:\\wrong"), message.replace("需要回答：验收新包", "需要回答：取消"),
    message.replace(reply.requestId!, "wrong-id"), `quoted\n${message}`]) {
    assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => [altered]).status, "delivery_unconfirmed");
    assert.deepEqual(persistence.value, saved);
  }
  assert.equal(recoverAgentResponseDelivery(store, "wrong-target", reply.deliveryId, () => [message]).status, "reservation_missing");
});

test("cancelled followup cannot partially close original response", () => {
  const { store, initial, reply, message } = fixture();
  store.cancel(reply.requestId!, "user cancellation");
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => [message]).status, "identity_mismatch");
  assert.throws(() => store.commit(reply), /cancelled/);
  assert.equal(store.get(initial.requestId!)?.status, "awaiting_response");
});

test("uncertain response suspends false reminders with explicit pending evidence", () => {
  const { store, initial, reply } = fixture();
  store.recordTargetTurnEnded("target", "C:\\repo", "turn", new Date(0));
  store.recordPendingResponseCheck(initial.requestId!, reply.deliveryId, "delivery_unconfirmed");
  assert.deepEqual(store.dueReminders(), []);
  assert.equal(store.get(initial.requestId!)?.status, "awaiting_response");
  assert.equal(store.get(initial.requestId!)?.reminderCount, 0);
  assert.match(store.get(initial.requestId!)!.lastReminderError!, /reconciliation/);
});

test("receipt recovery preserves an already completed followup", () => {
  const { store, initial, reply, message } = fixture();
  store.commit({ ...reply, inReplyToRequestId: undefined });
  const completion = store.prepare({ source: reply.target, target: reply.source,
    inReplyToRequestId: reply.requestId, result: "验收通过", nextAction: "结束", responsePolicy: "none" });
  store.commit(completion);
  assert.equal(recoverAgentResponseDelivery(store, "source", reply.deliveryId, () => [message]).status, "receipt_recovered");
  assert.equal(store.get(initial.requestId!)?.status, "responded");
  assert.equal(store.get(reply.requestId!)?.status, "responded");
  assert.equal(store.get(reply.requestId!)?.response?.result, "验收通过");
});

test("rollout proof excludes tool output, assistant quotations and incomplete tail records", () => {
  const record = (role: string) => JSON.stringify({ type: "response_item", payload: {
    type: "message", role, content: [{ type: "input_text", text: "accepted message" }]
  } });
  assert.deepEqual(deliveryUserMessagesFromRollout(`partial\n${record("assistant")}\n${record("tool")}\n${record("user")}\n{`), ["accepted message"]);
});
