import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import os from "node:os";
import { KnowledgeSearchService } from "./knowledgeSearchService.js";
import { handleKnowledgeSearch } from "./knowledgeSearchRoutes.js";

test("HTTP knowledge search returns summaries, validates modes, and exposes cache status", async t => {
  const service = new KnowledgeSearchService({ watch: false, readDelta: async () => ({
    inventory: {}, removed: [], errors: 0, filesRead: 0,
    changes: [{ kind: "recent", item: { id: "one", title: "Example", focus: "test", content: "private body",
      keywords: ["alpha"], createdAt: "2026-01-01", updatedAt: "2026-01-01" } }]
  }) });
  await service.reload("Example", os.tmpdir());
  const server = http.createServer((req, res) => {
    if (!handleKnowledgeSearch(req, new URL(req.url!, "http://localhost").pathname, res, {
      service, roleDirectory: () => os.tmpdir(), readBody: async () => ({}),
      json: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
    })) { res.writeHead(404); res.end(); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/roles/Example/knowledge`;
  const response = await fetch(`${base}/search?query=alpha`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.items[0].detailUrl, "/api/roles/Example/memory/recent/one");
  assert.equal("content" in result.data.items[0], false);
  assert.equal((await fetch(`${base}/search?query=alpha&mode=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/cache/reload`)).status, 405);
  assert.equal((await (await fetch(`${base}/cache/status`)).json()).data.ready, true);
});
