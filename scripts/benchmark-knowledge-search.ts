import { performance } from "node:perf_hooks";
import { RoleKnowledgeSearchIndex } from "../src/roleKnowledgeSearch.js";
import { paginateRoleMemory } from "../src/roleKnowledgePagination.js";
import type { RecentMemoryItem } from "../src/roleKnowledge.js";

// Synthetic, reproducible in-process comparison; excludes HTTP and disk latency.
const count = Number(process.argv[2] || 10_000);
if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error("count must be 1–100000");
const items: RecentMemoryItem[] = Array.from({ length: count }, (_, i) => ({
  id: `memory-${i}`, title: `Record ${i}`, focus: "Synthetic benchmark",
  content: "Reference information. ".repeat(50), keywords: [`topic-${i % 100}-end`],
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
}));
const index = new RoleKnowledgeSearchIndex("Example");
const heap = process.memoryUsage().heapUsed;
const started = performance.now();
for (const item of items) index.upsert({ kind: "recent", item });
index.ready = true;
const buildMs = performance.now() - started;
const heapGrowthBytes = process.memoryUsage().heapUsed - heap;
const query = "topic-42-end";
const counts = { recent: count, consolidated: 0, archived: 0, consolidationRuns: 0 };
const methods = {
  legacy: () => paginateRoleMemory(items, "", 10, query, counts),
  keywords: () => index.search({ query, limit: 10 }),
  fulltext: () => index.search({ query, mode: "fulltext", limit: 10 })
};
const results: Record<string, unknown> = {};
for (const [name, execute] of Object.entries(methods)) {
  for (let n = 0; n < 10; n++) execute();
  const times = Array.from({ length: 100 }, () => { const start = performance.now(); execute(); return performance.now() - start; }).sort((a, b) => a - b);
  const result = execute();
  results[name] = { p50Ms: times[50], p95Ms: times[95], total: result.total, responseBytes: Buffer.byteLength(JSON.stringify(result)) };
}
console.log(JSON.stringify({ count, buildMs, heapGrowthBytes, note: "Synthetic process-only timings; heap growth includes temporary allocations", results }, null, 2));
