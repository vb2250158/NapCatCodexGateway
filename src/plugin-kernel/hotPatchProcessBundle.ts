import type { CompiledHotPatchModule } from "./hotPatchModule.js";
import { HotPatchProcess, type HotPatchProcessSnapshot } from "./hotPatchProcess.js";
import { HotPatchBundleJournal } from "./hotPatchBundleJournal.js";

export type HotPatchProcessBundleEntry = Readonly<{
  id: string;
  process: HotPatchProcess;
  compiled: CompiledHotPatchModule;
  expectedRevision: number;
  contract?: Readonly<Record<string, unknown>>;
}>;

export type HotPatchProcessBundleResult = Readonly<{
  id: string;
  snapshot: HotPatchProcessSnapshot;
}>;

export class HotPatchProcessBundle {
  private active = false;

  constructor(readonly id: string, private readonly entries: readonly HotPatchProcessBundleEntry[], private readonly options: Readonly<{ journal?: HotPatchBundleJournal; claimJournal?: boolean; finalizeJournal?: boolean }> = {}) {
    if (!id.trim() || entries.length === 0) throw new Error("Hot patch process bundle requires an identity and at least one Worker.");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.id.trim() || ids.has(entry.id)) throw new Error("Hot patch process bundle contains duplicate module identities.");
      ids.add(entry.id);
    }
  }

  async apply(): Promise<readonly HotPatchProcessBundleResult[]> {
    if (this.active) throw new Error("Hot patch process bundle publication is already in progress.");
    this.active = true;
    const journal = this.options.journal;
    const journalPayload = { id: this.id, entries: this.entries.map(entry => ({ id: entry.id, sourceHash: entry.compiled.sourceHash, expectedRevision: entry.expectedRevision, contract: entry.contract ?? {} })) };
    const prepared: Array<{ entry: HotPatchProcessBundleEntry; token: string }> = [];
    const committed: Array<{ entry: HotPatchProcessBundleEntry; snapshot: HotPatchProcessSnapshot }> = [];
    try {
      if (journal && this.options.claimJournal !== false) {
        const record = await journal.begin(this.id, journalPayload, true);
        if (record.state !== "pending") throw new Error("Hot patch bundle operation already has a recorded terminal state.");
      }
      try {
        for (const entry of this.entries) {
          const result = await entry.process.prepare(entry.compiled, entry.expectedRevision, entry.contract);
          prepared.push({ entry, token: result.token });
        }
      } catch (error) {
        await Promise.allSettled(prepared.map(item => item.entry.process.discard(item.token)));
        await journal?.mark(this.id, "failed", undefined, error);
        throw error;
      }
      try {
        for (const item of prepared) {
          const snapshot = await item.entry.process.commit(item.token);
          committed.push({ entry: item.entry, snapshot });
        }
      } catch (error) {
        for (const item of committed.reverse()) {
          await item.entry.process.rollback(item.snapshot.snapshot.revision).catch(() => undefined);
        }
        await Promise.allSettled(prepared.slice(committed.length).map(item => item.entry.process.discard(item.token)));
        await journal?.mark(this.id, "indeterminate", { committed: committed.map(item => ({ id: item.entry.id, snapshot: item.snapshot })) }, error);
        throw error;
      }
      const result = Object.freeze(committed.map(item => Object.freeze({ id: item.entry.id, snapshot: item.snapshot })));
      if (this.options.finalizeJournal !== false) await journal?.mark(this.id, "committed", result);
      return result;
    } finally {
      this.active = false;
    }
  }
}
