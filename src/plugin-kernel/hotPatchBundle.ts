import type { CompiledHotPatchModule } from "./hotPatchModule.js";
import { HotPatchModule } from "./hotPatchModule.js";
import { retainHotPatchResult } from "./hotPatchIterator.js";

export type HotPatchBundleEntry = Readonly<{
  id: string;
  module: HotPatchModule;
  compiled: CompiledHotPatchModule;
  expectedRevision: number;
  contract?: Readonly<Record<string, unknown>>;
}>;

export type HotPatchBundleResult = Readonly<{
  id: string;
  revision: number;
  sourceHash: string;
}>;

export class HotPatchBundle {
  private active = false;

  constructor(readonly id: string, private readonly entries: readonly HotPatchBundleEntry[]) {
    if (!id.trim() || entries.length === 0) throw new Error("Hot patch bundle requires an identity and at least one module.");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.id.trim() || ids.has(entry.id) || entry.module.id !== entry.id) throw new Error("Hot patch bundle contains duplicate or mismatched module identities.");
      ids.add(entry.id);
    }
  }

  run<T>(operation: () => T): T {
    if (this.active) throw new Error("Hot patch bundle cannot admit work during publication.");
    const leases = this.entries.map(entry => entry.module.runtime.acquire());
    const release = () => leases.forEach(lease => lease.release());
    const execute = (index: number): T => index === leases.length - 1
      ? leases[index]!.run(operation)
      : leases[index]!.run(() => execute(index + 1));
    try {
      return retainHotPatchResult(execute(0), { ...leases[0]!, release });
    } catch (error) {
      release();
      throw error;
    }
  }

  apply(): readonly HotPatchBundleResult[] {
    if (this.active) throw new Error("Hot patch bundle publication is already in progress.");
    this.active = true;
    try {
      const prepared = this.entries.map(entry => {
        const changes = entry.module.prepare(entry.compiled);
        entry.module.validatePrepared(entry.compiled, entry.expectedRevision, entry.contract);
        return { entry, changes };
      });
      const applied: Array<{ entry: HotPatchBundleEntry; revision: number }> = [];
      try {
        for (const { entry, changes } of prepared) {
          const revision = entry.module.applyPreparedModule(entry.compiled, changes, entry.expectedRevision, entry.contract);
          applied.push({ entry, revision });
        }
      } catch (error) {
        for (const { entry, revision } of applied.reverse()) {
          try { entry.module.rollback(revision); } catch { }
        }
        throw error;
      }
      return Object.freeze(applied.map(({ entry, revision }) => Object.freeze({
        id: entry.id, revision, sourceHash: entry.compiled.sourceHash
      })));
    } finally {
      this.active = false;
    }
  }

  snapshots(): readonly ReturnType<HotPatchModule["snapshot"]>[] {
    return Object.freeze(this.entries.map(entry => entry.module.snapshot()));
  }
}
