import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handlePersonaChatHistoryApi } from "./personaChatHistoryRoutes.js";
import { handleCodexHookApi } from "./codexHookRoutes.js";
import { CodexHookContextService } from "./codexHookContext.js";
import { publishRoleKnowledgeCatalogSnapshot, readRoleKnowledgeCatalogSnapshot } from "../roleKnowledge.js";
import { appendPersonaChatReply } from "../personaChatHistory.js";

test("Hook HTTP ingestion and persona history API preserve scope, replay and pagination", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-chat-api-"));
  for (const roleId of ["Example", "Other"]) {
    await fs.mkdir(path.join(root, roleId));
    await fs.writeFile(path.join(root, roleId, "persona.md"), `# ${roleId}`);
    publishRoleKnowledgeCatalogSnapshot(path.join(root, roleId), readRoleKnowledgeCatalogSnapshot(path.join(root, roleId)));
  }
  const service = new CodexHookContextService({ rolesRoot: () => root, storePath: path.join(root, "sessions.json"), hookEnabled: () => false });
  service.bindSession("task", "Example");
  let title = "示例任务";
  let unavailable = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (handleCodexHookApi(request, url, response, service)) return;
    if (handlePersonaChatHistoryApi(request, url, response, roleId => {
      if (!["Example", "Other"].includes(roleId)) throw new Error("Unknown persona.");
      return path.join(root, roleId);
    }, ids => {
      if (unavailable) throw new Error("Desktop unavailable");
      assert.ok(ids.length <= 2);
      return ids.map(id => ({ id, title, cwd: "", rolloutPath: "", firstUserMessage: "", updatedAt: "" }));
    })) return;
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  for (const turn of ["1", "2", "2"]) {
    const response = await fetch(`${baseUrl}/api/codex-hook/context`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "task", hook_event_name: "Stop", turn_id: turn, last_assistant_message: `回复 ${turn}` }) });
    assert.equal(response.status, 200);
  }
  const page = await (await fetch(`${baseUrl}/api/roles/Example/chat-history?limit=1`)).json();
  assert.equal(page.data.entries[0].text, "回复 2");
  assert.equal(page.data.entries[0].sessionTitle, "示例任务");
  assert.equal(page.data.entries[0].taskUrl, "codex://threads/task");
  title = "更名后的任务";
  const older = await (await fetch(`${baseUrl}/api/roles/Example/chat-history?cursor=${page.data.nextCursor}`)).json();
  assert.deepEqual(older.data.entries.map((entry: { text: string }) => entry.text), ["回复 1"]);
  assert.equal(older.data.nextCursor, null);
  assert.equal(older.data.entries[0].sessionTitle, title);
  unavailable = true;
  const fallback = await (await fetch(`${baseUrl}/api/roles/Example/chat-history`)).json();
  assert.equal(fallback.data.entries.length, 2);
  assert.equal(fallback.data.entries[0].sessionTitle, undefined);
  assert.equal(fallback.data.entries[0].taskUrl, undefined);
  unavailable = false;
  assert.equal((await (await fetch(`${baseUrl}/api/roles/Other/chat-history`)).json()).data.entries.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/roles/Example/chat-history`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${baseUrl}/api/roles/Example/chat-history?cursor=NaN`)).status, 400);
  await appendPersonaChatReply(path.join(root, "Example"), {
    kind: "agent_delivery", sessionId: "task", targetSessionId: "target", text: "Agent body", deliveryId: "delivery", deliveryStatus: "delivered"
  });
  const delivery = (await (await fetch(`${baseUrl}/api/roles/Example/chat-history?limit=1`)).json()).data.entries[0];
  assert.equal(delivery.sessionTitle, title);
  assert.equal(delivery.targetSessionTitle, title);
  assert.equal(delivery.targetTaskUrl, "codex://threads/target");
});
