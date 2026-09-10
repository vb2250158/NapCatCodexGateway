import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeSearchService } from "./knowledgeSearchService.js";
import { readKnowledgeStorageDelta, type KnowledgeStorageDelta } from "./knowledgeSearchStorage.js";
import { knowledgeReference, publishKnowledgeChange } from "../roleKnowledgeSearch.js";
import type { RecentMemoryItem } from "../roleKnowledge.js";

function item(id = "one"): RecentMemoryItem {
  return { id, title: id, focus: "Search test", content: "Test body", keywords: ["alpha"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-search-"));
  const directory = path.join(root, "memory", "recent");
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(directory, "one.json");
  const write = (value: RecentMemoryItem) => fs.writeFileSync(file, JSON.stringify(value));
  write(item());
  return { root, file, write };
}

test("reconciliation reads only changed files, preserves invalid content, and removes verified deletions", t => {
  const { root, file, write } = fixture(t);
  const first = readKnowledgeStorageDelta(root, {});
  assert.equal(first.filesRead, 1);
  assert.equal(readKnowledgeStorageDelta(root, first.inventory).filesRead, 0);
  fs.writeFileSync(file, "{");
  const invalid = readKnowledgeStorageDelta(root, first.inventory);
  assert.equal(invalid.errors, 1);
  assert.equal(invalid.removed.length, 0);
  write({ ...item(), keywords: ["beta"] });
  const next = readKnowledgeStorageDelta(root, invalid.inventory);
  assert.equal(next.filesRead, 1);
  assert.deepEqual(next.changes[0].item.keywords, ["beta"]);
  fs.unlinkSync(file);
  assert.deepEqual(readKnowledgeStorageDelta(root, next.inventory).removed, [knowledgeReference("recent", "one")]);
});

test("legacy JSON duplicates defer to Markdown and return when Markdown is removed", t => {
  const { root, file, write } = fixture(t);
  const markdown = file.replace(/\.json$/, ".md");
  const { content, ...metadata } = { ...item(), keywords: ["markdown"] };
  fs.writeFileSync(markdown, `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${content}\n`);
  const first = readKnowledgeStorageDelta(root, {});
  assert.equal(first.errors, 0);
  assert.equal(first.changes.length, 1);
  assert.deepEqual(first.changes[0].item.keywords, ["markdown"]);
  write({ ...item(), keywords: ["legacy"] });
  const changedLegacy = readKnowledgeStorageDelta(root, first.inventory);
  assert.equal(changedLegacy.changes.length, 0);
  fs.unlinkSync(markdown);
  const fallback = readKnowledgeStorageDelta(root, changedLegacy.inventory);
  assert.deepEqual(fallback.changes[0].item.keywords, ["legacy"]);
  assert.equal(fallback.removed.length, 0);
});

test("hot searches do not call storage and reconciliation does not reindex unchanged documents", async t => {
  const { root } = fixture(t);
  let reads = 0;
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (directory, previous) => {
    reads += 1;
    return readKnowledgeStorageDelta(directory, previous);
  } });
  t.after(() => service.close());
  await service.reload("Example", root);
  const count = reads;
  const index = service.ensure("Example", root);
  for (let query = 0; query < 100; query++) assert.equal(index.search({ query: "alpha" }).total, 1);
  assert.equal(reads, count);
  const updates = index.status().indexedUpdates;
  await service.reload("Example", root);
  assert.equal(index.status().indexedUpdates, updates);
});

test("filesystem watcher refreshes automatically and clears removed keywords", async t => {
  const { root, write } = fixture(t);
  const service = new KnowledgeSearchService({ debounceMs: 10,
    readDelta: async (directory, previous) => readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  write({ ...item(), keywords: ["beta"] });
  const deadline = Date.now() + 3_000;
  while (service.ensure("Example", root).search({ query: "beta" }).total === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(service.ensure("Example", root).search({ query: "beta" }).total, 1);
  assert.equal(service.ensure("Example", root).search({ query: "alpha" }).total, 0);
});

test("automatic reconciliation repairs changes without a watcher", async t => {
  const { root, write } = fixture(t);
  const service = new KnowledgeSearchService({ watch: false, reconcileMs: 30, debounceMs: 5,
    readDelta: async (directory, previous) => readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  write({ ...item(), keywords: ["repaired"] });
  const deadline = Date.now() + 3_000;
  while (service.ensure("Example", root).search({ query: "repaired" }).total === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(service.ensure("Example", root).search({ query: "repaired" }).total, 1);
});

test("a late disk snapshot cannot overwrite a committed mutation", async t => {
  const { root } = fixture(t);
  let finish: ((delta: KnowledgeStorageDelta) => void) | undefined;
  let delayed = false;
  const service = new KnowledgeSearchService({ watch: false, debounceMs: 5_000,
    readDelta: async (directory, previous) => delayed
      ? new Promise(resolve => { finish = resolve; }) : readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  delayed = true;
  const reloading = service.reload("Example", root, true);
  publishKnowledgeChange(root, { kind: "recent", item: { ...item(), keywords: ["new"] } });
  assert.ok(finish);
  finish(readKnowledgeStorageDelta(root, {}));
  await reloading;
  assert.equal(service.ensure("Example", root).search({ query: "new" }).total, 1);
  assert.equal(service.ensure("Example", root).search({ query: "alpha" }).total, 0);
});
