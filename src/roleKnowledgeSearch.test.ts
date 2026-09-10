import assert from "node:assert/strict";
import test from "node:test";
import { RoleKnowledgeSearchIndex } from "./roleKnowledgeSearch.js";
import type { PlanItem, RecentMemoryItem } from "./roleKnowledge.js";

function memory(id: string, keywords = ["launch"]): RecentMemoryItem {
  return { id, title: `Title ${id}`, focus: "Release schedule", content: "Original body with unique phrase",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", keywords };
}

test("keyword search returns summaries; fulltext is explicit and old mappings disappear", () => {
  const index = new RoleKnowledgeSearchIndex("Example");
  const item = memory("one");
  index.upsert({ kind: "recent", item });
  index.ready = true;
  assert.equal(index.search({ query: "launch" }).items[0].id, "one");
  assert.equal("content" in index.search({ query: "launch" }).items[0], false);
  assert.equal(index.search({ query: "unique phrase" }).total, 0);
  assert.equal(index.search({ query: "unique phrase", mode: "fulltext" }).total, 1);
  index.upsert({ kind: "recent", item: { ...item, keywords: ["opening"], content: "Replacement body" } });
  assert.equal(index.search({ query: "launch" }).total, 0);
  assert.equal(index.search({ query: "unique phrase", mode: "fulltext" }).total, 0);
  assert.equal(index.search({ query: "opening" }).total, 1);
});

test("view activity updates metadata without rebuilding terms and duplicate publication is a no-op", () => {
  const index = new RoleKnowledgeSearchIndex("Example");
  const item = memory("one");
  index.upsert({ kind: "recent", item });
  const before = index.status();
  index.upsert({ kind: "recent", item: { ...item, viewedAt: "2026-02-01T00:00:00Z", storageRevision: "next" } });
  assert.equal(index.status().indexedUpdates, before.indexedUpdates);
  const after = index.status();
  index.upsert({ kind: "recent", item: { ...item, viewedAt: "2026-02-01T00:00:00Z", storageRevision: "next" } });
  assert.deepEqual(index.status(), after);
});

test("plan summaries use the next action as their excerpt", () => {
  const index = new RoleKnowledgeSearchIndex("Example");
  const plan: PlanItem = {
    id: "release-plan", title: "Release plan", focus: "Prepare the release", status: "执行中", archiveStatus: "未归档",
    nextAction: "Build the release package", attachments: [], steps: [], createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", keywords: ["release"]
  };
  index.upsert({ kind: "plan", item: plan });
  index.ready = true;
  assert.equal(index.search({ query: "release" }).items[0]?.excerpt, "Build the release package");
});

test("roles and memory kinds remain isolated; archive is explicit and cursors reject changed results", () => {
  const index = new RoleKnowledgeSearchIndex("Example");
  index.upsert({ kind: "recent", item: memory("same") });
  index.upsert({ kind: "consolidated", item: memory("same") });
  index.upsert({ kind: "recent", item: { ...memory("archived"), consolidatedAt: "2026-02-01T00:00:00Z" } });
  index.ready = true;
  assert.equal(index.search({ query: "launch" }).total, 2);
  assert.equal(index.search({ query: "launch", archived: true }).total, 3);
  assert.match(index.search({ query: "archived", archived: true }).items[0].detailUrl, /memory\?kind=archived&limit=10&query=archived$/);
  const cursor = index.search({ query: "launch", limit: 1 }).nextCursor;
  assert.equal(index.search({ query: "launch", limit: 1, cursor }).items.length, 1);
  index.upsert({ kind: "recent", item: memory("next") });
  assert.throws(() => index.search({ query: "launch", cursor }), /CURSOR_EXPIRED/);
  assert.throws(() => new RoleKnowledgeSearchIndex("Other").search({ query: "launch" }), /WARMING/);
});
