import test from "node:test";
import assert from "node:assert/strict";
import { routeInstanceThread } from "./instanceThreadRouting.js";
import type { AgentInstance } from "../shared/agentInstance.js";

test("primary and managed tasks use their owning instance, including scheduled followups", async () => {
  const instances: AgentInstance[] = [{ instanceId: "remote-a", local: false, connected: true, agents: [{ agentId: "agent-a", name: "Agent", provider: "dsh", enabled: true, sessionId: "primary", managedSessionIds: ["secretary"] }] }];
  const calls: unknown[] = [];
  const transport = { instances: () => instances, manage: async (instanceId: string, params: Record<string, unknown>) => { calls.push({ instanceId, params }); return { statusCode: 200, data: { thread: { id: params.threadId } } }; } };
  assert.equal((await routeInstanceThread({ action: "read", threadId: "secretary" }, transport))?.data.thread != null, true);
  assert.deepEqual(calls, [{ instanceId: "remote-a", params: { action: "read", threadId: "secretary", agentId: "agent-a", agentAdapter: "dsh" } }]);
  assert.equal(await routeInstanceThread({ action: "read", threadId: "local-task" }, transport), undefined);
  instances[0]!.connected = false;
  await assert.rejects(routeInstanceThread({ action: "send", threadId: "secretary" }, transport), /offline/);
  await assert.rejects(routeInstanceThread({ action: "create", instanceBinding: { instanceId: "missing", agentId: "agent" } }, transport), /offline/);
  assert.equal(calls.length, 1);
});

test("ambiguous session ids require a stable instance binding", async () => {
  const instances: AgentInstance[] = ["a", "b"].map(instanceId => ({ instanceId, local: false, connected: true, agents: [{ agentId: "agent", name: "Agent", provider: "codex-desktop", enabled: true, sessionId: "same-id" }] }));
  const transport = { instances: () => instances, manage: async () => ({ statusCode: 200, data: {} }) };
  await assert.rejects(routeInstanceThread({ action: "read", threadId: "same-id" }, transport), /multiple instances/);
  assert.equal((await routeInstanceThread({ action: "read", threadId: "same-id", instanceBinding: { instanceId: "b", agentId: "agent" } }, transport))?.statusCode, 200);
  await assert.rejects(routeInstanceThread({ action: "read", threadId: "same-id", agentAdapter: "dsh", instanceBinding: { instanceId: "b", agentId: "agent" } }, transport), /provider/);
});
