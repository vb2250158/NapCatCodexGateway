import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendPersonaChatReply, readPersonaChatHistory } from "./personaChatHistory.js";
import { CodexHookContextService } from "./manager/codexHookContext.js";
import { publishRoleKnowledgeCatalogSnapshot, readRoleKnowledgeCatalogSnapshot } from "./roleKnowledge.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-chat-history-"));
  const roleDir = path.join(root, "roles", "Example");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "persona.md"), "# Example");
  publishRoleKnowledgeCatalogSnapshot(roleDir, readRoleKnowledgeCatalogSnapshot(roleDir));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, roleDir };
}

test("history preserves full Unicode replies and byte cursors across new appends", async t => {
  const { roleDir } = await fixture(t);
  const texts = ["最早", "很长的最终回复🦊\n".repeat(12000), "最新"];
  for (const [i, text] of texts.entries()) await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: String(i), text });
  const newest = await readPersonaChatHistory(roleDir, undefined, 1);
  assert.equal(newest.entries[0].text, texts[2]);
  await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "3", text: "刚到" });
  const older = await readPersonaChatHistory(roleDir, newest.nextCursor!, 1);
  assert.equal(older.entries[0].text, texts[1]);
  const oldest = await readPersonaChatHistory(roleDir, older.nextCursor!, 1);
  assert.deepEqual(oldest.entries.map(item => item.text), [texts[0]]);
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual((await readPersonaChatHistory(roleDir)).entries.map(item => item.text), ["刚到", ...texts.slice().reverse()]);
});

test("concurrent replay is idempotent and changes within a turn remain visible", async t => {
  const { roleDir } = await fixture(t);
  const reply = { sessionId: "task", turnId: "turn", text: "最终回复" };
  const results = await Promise.all(Array.from({ length: 10 }, () => appendPersonaChatReply(roleDir, reply)));
  assert.equal(results.filter(Boolean).length, 1);
  await appendPersonaChatReply(roleDir, { ...reply, text: "继续处理后的最终回复" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 2);
  assert.equal(await appendPersonaChatReply(roleDir, { ...reply, text: "  " }), null);
  const file = path.join(roleDir, "chat-history", "final-replies.jsonl");
  const content = await fs.readFile(file, "utf8");
  await fs.writeFile(file, content); // External rewrite invalidates the derived ID cache.
  assert.equal(await appendPersonaChatReply(roleDir, reply), null);
  assert.equal((await readPersonaChatHistory(path.join(roleDir, "Other"))).entries.length, 0);
});

test("history rejects invalid cursors and corrupt data instead of silently hiding replies", async t => {
  const { roleDir } = await fixture(t);
  await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "turn", text: "reply" });
  for (const cursor of [-1, 1.5, 1, Number.NaN, 99999]) await assert.rejects(readPersonaChatHistory(roleDir, cursor));
  await assert.rejects(readPersonaChatHistory(roleDir, undefined, 0));
  await fs.appendFile(path.join(roleDir, "chat-history", "final-replies.jsonl"), "bad\n");
  await assert.rejects(readPersonaChatHistory(roleDir));
  await assert.rejects(appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "next", text: "reply" }));
});

test("Stop records bound final replies even when plan notifications are disabled; other events do not", async t => {
  const { root, roleDir } = await fixture(t);
  const events: string[] = [];
  const options = {
    rolesRoot: () => path.join(root, "roles"), storePath: path.join(root, "sessions.json"),
    hookEnabled: () => false, onChatHistoryChanged: (roleId: string) => events.push(roleId)
  };
  const service = new CodexHookContextService(options);
  service.bindSession("task", "Example");
  const request = { sessionId: "task", turnId: "turn", lastAssistantMessage: "完整最终回复", eventName: "Stop" as const };
  await service.handleHook({ ...request, eventName: "PostToolUse" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 0);
  await service.handleHook(request);
  await new CodexHookContextService(options).handleHook(request);
  assert.deepEqual(events, ["Example"]);
  assert.equal((await readPersonaChatHistory(roleDir)).entries[0].text, request.lastAssistantMessage);
  await service.handleHook({ ...request, sessionId: "unbound" });
  await service.handleHook({ ...request, turnId: "" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 1);
});

test("managed task ownership records unbound sessions and refuses ambiguous persona ownership", async t => {
  const { root, roleDir } = await fixture(t);
  const candidates = ["Example"];
  const service = new CodexHookContextService({
    rolesRoot: () => path.join(root, "roles"), storePath: path.join(root, "sessions.json"),
    hookEnabled: () => false, chatHistoryRoleIds: () => candidates
  });
  await service.handleHook({ sessionId: "managed-task", turnId: "1", eventName: "Stop", lastAssistantMessage: "Plan or primary task" });
  candidates.push("Other");
  await service.handleHook({ sessionId: "managed-task", turnId: "2", eventName: "Stop", lastAssistantMessage: "Ambiguous" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 1);
});
