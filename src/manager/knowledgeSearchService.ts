import fs from "node:fs";
import path from "node:path";
import { requiresWorkerFilesystemAccess } from "../shared/pathPolicy.js";
import { RoleKnowledgeSearchIndex, subscribeKnowledgeChanges, type KnowledgeChange } from "../roleKnowledgeSearch.js";
import type { KnowledgeInventory, KnowledgeStorageDelta } from "./knowledgeSearchStorage.js";

type RoleState = {
  directory: string; index: RoleKnowledgeSearchIndex; inventory: KnowledgeInventory;
  epoch: number; full: boolean; pending: boolean; flight?: Promise<void>;
  debounce?: NodeJS.Timeout; reconcile?: NodeJS.Timeout; watcher?: fs.FSWatcher;
  errors: number; filesRead: number; refreshedAt?: string;
};
export type KnowledgeSearchServiceOptions = {
  readDelta: (directory: string, previous: KnowledgeInventory, signal: AbortSignal) => Promise<KnowledgeStorageDelta>;
  reconcileMs?: number; debounceMs?: number; watch?: boolean;
  onError?: (roleId: string, error: unknown) => void;
};

/** One Manager-owned index; workers return deltas, never own the search truth. */
export class KnowledgeSearchService {
  private readonly roles = new Map<string, RoleState>();
  private readonly controller = new AbortController();
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(private readonly options: KnowledgeSearchServiceOptions) {
    this.unsubscribe = subscribeKnowledgeChanges((directory, change) => this.committed(directory, change));
  }

  ensure(roleId: string, directory: string): RoleKnowledgeSearchIndex {
    if (this.closed) throw new Error("Knowledge search service is closed");
    const key = path.resolve(directory);
    let state = this.roles.get(key);
    if (!state) {
      state = { directory: key, index: new RoleKnowledgeSearchIndex(roleId), inventory: {},
        epoch: 0, full: false, pending: false, errors: 0, filesRead: 0 };
      this.roles.set(key, state);
      this.armWatcher(state);
      this.schedule(state, 0);
      this.armReconciliation(state);
    }
    return state.index;
  }

  status(directory: string) {
    const state = this.roles.get(path.resolve(directory));
    return state ? { ...state.index.status(), refreshing: Boolean(state.flight) || state.pending, errors: state.errors,
      filesRead: state.filesRead, refreshedAt: state.refreshedAt, watchActive: Boolean(state.watcher) } : { ready: false };
  }

  private committed(directory: string, change: KnowledgeChange): void {
    const state = this.roles.get(path.resolve(directory));
    if (!state || this.closed) return;
    state.epoch += 1;
    state.index.upsert(change);
    this.schedule(state);
  }

  private armWatcher(state: RoleState): void {
    if (this.options.watch === false || state.watcher || requiresWorkerFilesystemAccess(state.directory)) return;
    try {
      const watcher = fs.watch(state.directory, { recursive: true, persistent: false }, (_event, filename) => {
        const name = filename?.toString().replace(/\\/g, "/");
        if (name && !/^(plans|memory)(\/|$)/i.test(name)) return;
        if (name?.startsWith("plans/") && /\.[^/]+$/.test(name) && !name.endsWith("/plan.json")) return;
        state.epoch += 1;
        this.schedule(state);
      });
      watcher.on("error", error => {
        watcher.close();
        if (state.watcher === watcher) state.watcher = undefined;
        state.errors += 1;
        this.options.onError?.(state.index.roleId, error);
        this.schedule(state);
      });
      state.watcher = watcher;
    } catch (error) { this.options.onError?.(state.index.roleId, error); }
  }

  private armReconciliation(state: RoleState): void {
    if (this.closed) return;
    // Low-frequency metadata repair covers dropped watcher events and remote shares.
    state.reconcile = setTimeout(() => {
      this.armWatcher(state);
      this.schedule(state, 0);
      this.armReconciliation(state);
    }, this.options.reconcileMs ?? 60_000);
    state.reconcile.unref();
  }

  private schedule(state: RoleState, delay = this.options.debounceMs ?? 150): void {
    if (this.closed) return;
    state.pending = true;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = undefined;
      void this.refresh(state);
    }, delay);
    state.debounce.unref();
  }

  private refresh(state: RoleState): Promise<void> {
    if (state.flight) return state.flight;
    if (this.closed) return Promise.resolve();
    state.pending = false;
    const epoch = state.epoch;
    const full = state.full;
    state.full = false;
    state.flight = this.options.readDelta(state.directory, full ? {} : state.inventory, this.controller.signal)
      .then(delta => {
        if (this.closed) return;
        if (epoch !== state.epoch) { state.full ||= full; state.pending = true; return; }
        state.errors = delta.errors;
        state.filesRead += delta.filesRead;
        if (delta.errors && (full || !state.index.ready)) { state.full ||= full; state.pending = true; return; }
        const next = full ? new RoleKnowledgeSearchIndex(state.index.roleId, state.index.status().version + 1) : state.index;
        for (const ref of delta.removed) next.remove(ref);
        for (const change of delta.changes) next.upsert(change);
        next.ready = true;
        state.index = next;
        state.inventory = delta.inventory;
        state.refreshedAt = new Date().toISOString();
        if (delta.errors) state.pending = true;
      })
      .catch(error => {
        if (this.closed) return;
        state.errors += 1;
        state.full ||= full;
        state.pending = true;
        this.options.onError?.(state.index.roleId, error);
      })
      .finally(() => {
        state.flight = undefined;
        if (state.pending && !this.closed) this.schedule(state, state.errors ? 2_000 : undefined);
      });
    return state.flight;
  }

  async reload(roleId: string, directory: string, full = false, reference?: string): Promise<void> {
    this.ensure(roleId, directory);
    const state = this.roles.get(path.resolve(directory))!;
    state.epoch += 1;
    state.full ||= full;
    if (state.flight) await state.flight;
    if (reference) for (const [file, stamp] of Object.entries(state.inventory)) {
      if (stamp.reference === reference) state.inventory[file] = { ...stamp, fingerprint: "" };
    }
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = undefined;
    await this.refresh(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    this.controller.abort();
    for (const state of this.roles.values()) {
      state.watcher?.close();
      if (state.debounce) clearTimeout(state.debounce);
      if (state.reconcile) clearTimeout(state.reconcile);
    }
    await Promise.all([...this.roles.values()].map(state => state.flight));
    this.roles.clear();
  }
}
