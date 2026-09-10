import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentThreadRequest, type AgentThreadDriver, type AgentThreadRequest } from "../agentThreads.js";
import { readPersonaChatHistory } from "../personaChatHistory.js";
import { recordPersonaAgentDelivery } from "./personaAgentDeliveryHistory.js";

const source = "019f0000-0000-7000-8000-000000000011";
const target = "019f0000-0000-7000-8000-000000000012";
const request: AgentThreadRequest = {
  action: "send", threadId: target, sourceThreadId: source, sourceAgentType: "agent", responsePolicy: "none",
  cwd: process.cwd(), prompt: "**Delivery body**", messageSource: {
    type: "agent", agentAdapter: "codex", sessionId: source, sessionName: "Source task", workspace: process.cwd()
  }
};

for (const state of ["delivered", "unconfirmed", "failed"] as const) {
  test(`Agent delivery ${state} records the actual send outcome and preserves routing`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-delivery-history-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const changed: string[] = [];
    const dependencies = {
      roleForTask: (id: string) => id === source ? "SourcePersona" : "TargetPersona",
      roleDir: (id: string) => path.join(root, id), changed: (id: string) => { changed.push(id); }
    };
    const driver: AgentThreadDriver = {
      read: async id => ({ id, title: "Verified task", cwd: process.cwd() }),
      create: async () => { throw new Error("unexpected create"); },
      send: async () => {
        if (state !== "delivered") {
          const error = new Error("delivery fixture");
          if (state === "unconfirmed") error.name = "CodexDesktopDeliveryUnconfirmedError";
          throw error;
        }
      }
    };
    const operation = handleAgentThreadRequest(request, {
      allowedWorkspaces: [process.cwd()],
      onChatHistoryDelivery: (body, result) => recordPersonaAgentDelivery(body, result, dependencies)
    }, driver);
    if (state === "failed") {
      await assert.rejects(operation, /delivery fixture/);
      assert.deepEqual(changed, []);
      return;
    }
    const result = await operation;
    assert.equal(result.data.status, state === "unconfirmed" ? "delivery_unconfirmed" : "delivered");
    await recordPersonaAgentDelivery(request, result, dependencies);
    assert.deepEqual(changed, ["SourcePersona", "TargetPersona"]);
    for (const role of changed) {
      const page = await readPersonaChatHistory(path.join(root, role));
      assert.equal(page.entries.length, 1);
      assert.equal(page.entries[0].sessionId, source);
      assert.equal(page.entries[0].targetSessionId, target);
      assert.equal(page.entries[0].deliveryStatus, state);
      assert.equal(page.entries[0].turnId, undefined);
      assert.equal(page.entries[0].text, request.prompt);
    }
  });
}

test("same-persona delivery emits once; unknown ownership emits nothing", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-delivery-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let changed = 0;
  const result = { statusCode: 202, data: { threadId: target, delivery: { deliveryId: "delivery", status: "delivered" } } };
  await recordPersonaAgentDelivery(request, result, { roleForTask: () => "Example", roleDir: () => root, changed: () => { changed++; } });
  await recordPersonaAgentDelivery(request, result, { roleForTask: () => undefined, roleDir: () => root, changed: () => { changed++; } });
  assert.equal(changed, 1);
  assert.equal((await readPersonaChatHistory(root)).entries.length, 1);
});

test("history write failure cannot turn accepted delivery into a failed send", async () => {
  const result = await handleAgentThreadRequest(request, {
    allowedWorkspaces: [process.cwd()], onChatHistoryDelivery: async () => { throw new Error("history unavailable"); }
  }, {
    read: async id => ({ id, title: "Source task", cwd: process.cwd() }),
    create: async () => { throw new Error("unexpected create"); }, send: async () => undefined
  });
  assert.equal(result.data.status, "delivered");
  assert.equal(result.data.chatHistoryWarning, "history unavailable");
});
