import type { ConsolidatedMemoryItem, PlanItem, RecentMemoryItem } from "./roleKnowledge.js";

export type KnowledgeKind = "plan" | "recent" | "consolidated";
export type KnowledgeRecord = PlanItem | RecentMemoryItem | ConsolidatedMemoryItem;
export type KnowledgeChange = { kind: KnowledgeKind; item: KnowledgeRecord };
export type KnowledgeSummary = {
  id: string; kind: KnowledgeKind; title: string; focus: string; keywords: string[];
  status?: string; archived: boolean; updatedAt: string; viewedAt?: string;
  revision?: string; excerpt: string; detailUrl: string;
};
type Entry = { summary: KnowledgeSummary; terms: string[]; text: string; contentKey: string };
export type KnowledgeSearchOptions = {
  query: string; mode?: "keywords" | "fulltext"; kind?: KnowledgeKind;
  archived?: boolean; limit?: number; cursor?: string;
};

const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
export const knowledgeReference = (kind: KnowledgeKind, id: string) => JSON.stringify([kind, id]);
const ignoredSearchFields = new Set(["viewedAt", "recalledAt", "storageRevision", "storageMutationRequestId"]);
function collectText(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) collectText(item, result);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (!ignoredSearchFields.has(key)) collectText(item, result);
  }
  return result;
}

/** Derived, memory-only index. Its owner applies a batch synchronously, without yielding between entries. */
export class RoleKnowledgeSearchIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly keywords = new Map<string, Set<string>>();
  private generation = 0;
  private indexedUpdates = 0;
  private queries = 0;
  private lastCandidates = 0;
  ready = false;

  constructor(readonly roleId: string, initialVersion = 0) { this.generation = initialVersion; }

  upsert({ kind, item }: KnowledgeChange): void {
    const ref = knowledgeReference(kind, item.id);
    const old = this.entries.get(ref);
    const plan = kind === "plan" ? item as PlanItem : undefined;
    const memory = kind !== "plan" ? item as RecentMemoryItem : undefined;
    const text = normalize(collectText(item).join("\n"));
    const terms = [...new Set([item.id, item.title, ...item.keywords].map(normalize).filter(Boolean))];
    const contentKey = JSON.stringify([terms, text]);
    const summary: KnowledgeSummary = {
      id: item.id, kind, title: item.title, focus: item.focus, keywords: [...item.keywords],
      status: plan?.status, archived: plan ? plan.archiveStatus === "已归档" : Boolean(memory?.consolidatedAt),
      updatedAt: item.updatedAt, viewedAt: memory?.viewedAt, revision: item.storageRevision,
      excerpt: (memory?.content ?? plan?.nextAction ?? plan?.currentStep ?? plan?.focus ?? "").slice(0, 160),
      detailUrl: kind === "recent" && memory?.consolidatedAt
        ? `/api/roles/${encodeURIComponent(this.roleId)}/memory?kind=archived&limit=10&query=${encodeURIComponent(item.id)}`
        : `/api/roles/${encodeURIComponent(this.roleId)}/${kind === "plan" ? "plans" : `memory/${kind}`}/${encodeURIComponent(item.id)}`
    };
    if (old?.contentKey === contentKey && JSON.stringify(old.summary) === JSON.stringify(summary)) return;
    if (!old || JSON.stringify(old.terms) !== JSON.stringify(terms)) {
      this.removeTerms(ref, old);
      for (const term of terms) {
        let ids = this.keywords.get(term);
        if (!ids) this.keywords.set(term, ids = new Set());
        ids.add(ref);
      }
      this.indexedUpdates += 1;
    }
    this.entries.set(ref, { summary, terms, text, contentKey });
    this.generation += 1;
  }

  private removeTerms(ref: string, entry?: Entry): void {
    for (const term of entry?.terms ?? []) {
      const ids = this.keywords.get(term);
      ids?.delete(ref);
      if (!ids?.size) this.keywords.delete(term);
    }
  }

  remove(ref: string): void {
    const old = this.entries.get(ref);
    if (!old) return;
    this.removeTerms(ref, old);
    this.entries.delete(ref);
    this.generation += 1;
  }

  references(): string[] { return [...this.entries.keys()]; }
  status() {
    return { ready: this.ready, version: this.generation, entries: this.entries.size,
      keywords: this.keywords.size, indexedUpdates: this.indexedUpdates, queries: this.queries,
      lastCandidates: this.lastCandidates };
  }

  search(options: KnowledgeSearchOptions) {
    if (!this.ready) throw new Error("KNOWLEDGE_INDEX_WARMING");
    const query = normalize(options.query);
    if (!query || query.length > 512) throw new Error("query must contain 1–512 characters");
    const mode = options.mode ?? "keywords";
    if (mode !== "keywords" && mode !== "fulltext") throw new Error("Invalid search mode");
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    let offset = 0;
    if (options.cursor) {
      const [version, position] = options.cursor.split(":");
      if (!/^\d+$/.test(version ?? "") || !/^\d+$/.test(position ?? "")) throw new Error("Invalid cursor");
      if (Number(version) !== this.generation) throw new Error("KNOWLEDGE_CURSOR_EXPIRED");
      offset = Number(position);
    }
    const terms = [...new Set([query, ...query.split(/\s+/)].filter(Boolean))];
    const candidates = new Set<string>();
    if (mode === "keywords") {
      for (const term of terms) for (const ref of this.keywords.get(term) ?? []) candidates.add(ref);
    } else {
      for (const [ref, entry] of this.entries) if (entry.text.includes(query)) candidates.add(ref);
    }
    this.lastCandidates = mode === "keywords" ? candidates.size : this.entries.size;
    this.queries += 1;
    const matched = [...candidates].map(ref => this.entries.get(ref)!).filter(entry =>
      (!options.kind || entry.summary.kind === options.kind) && (options.archived === true || !entry.summary.archived));
    matched.sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt)
      || knowledgeReference(a.summary.kind, a.summary.id).localeCompare(knowledgeReference(b.summary.kind, b.summary.id)));
    return {
      version: this.generation, mode, total: matched.length,
      items: matched.slice(offset, offset + limit).map(entry => ({ ...entry.summary, keywords: [...entry.summary.keywords],
        matchedBy: mode === "fulltext" ? ["fulltext"] : terms.filter(term => entry.terms.includes(term)) })),
      nextCursor: offset + limit < matched.length ? `${this.generation}:${offset + limit}` : ""
    };
  }
}

type MutationListener = (roleDir: string, change: KnowledgeChange) => void;
const listeners = new Set<MutationListener>();
export function subscribeKnowledgeChanges(listener: MutationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function publishKnowledgeChange(roleDir: string, change: KnowledgeChange): void {
  for (const listener of listeners) listener(roleDir, change);
}
