import assert from "node:assert/strict";
import test from "node:test";
import { agentReplyParameters, agentReplyRequest, agentRequestReminderPrompt } from "./replyParameters.js";
import type { AgentRequestRecord } from "./store.js";

test("reply reminders use the same complete destination and sender contract as original deliveries", () => {
  const source = { threadId: "requester", threadName: "Requester", agentAdapter: "codex" as const, agentType: "agent", workspace: "C:/requester" };
  const target = { threadId: "responder", threadName: "Responder", agentAdapter: "dsh" as const, agentType: "plan_agent", workspace: "C:/responder" };
  const preparation = { deliveryId: "delivery", requestId: "request", responsePolicy: "required" as const,
    responseInstruction: "Return verified results", source, target };
  const parameters = agentReplyParameters(preparation);
  const request = agentReplyRequest(preparation);
  assert.deepEqual(parameters.request, request);
  assert.equal(request.threadId, source.threadId);
  assert.equal(Object.hasOwn(request, "prompt"), false);
  assert.equal(request.sourceThreadId, target.threadId);
  assert.equal(request.cwd, source.workspace);
  assert.deepEqual(request.messageSource, { type: "agent", agentAdapter: "dsh", sessionId: "responder", sessionName: "Responder", workspace: "C:/responder" });
  const record: AgentRequestRecord = { ...preparation, id: "request", status: "awaiting_response",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", reminderCount: 0 };
  const reminder = agentRequestReminderPrompt(record);
  assert.ok(reminder.includes(JSON.stringify({ requestId: record.id, endpoint: "POST /api/agent/threads", request }, null, 2)));
  assert.match(reminder, /原请求时间：2026-09-01/);
  assert.doesNotMatch(reminder, /协作要求|action=send|当前任务完整 ID/);
});
