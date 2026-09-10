import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual, types } from "node:util";
import { retainHotPatchResult, type HotPatchLease } from "./hotPatchIterator.js";
import { HotPatchResourceStore, type HotPatchResourceData } from "./hotPatchResourceStore.js";

export type HotPatchImplementation = (environment: object, receiver: unknown, arguments_: readonly unknown[]) => unknown;
export type HotPatchChange = Readonly<{ id: string; implementation: HotPatchImplementation }>;
export type HotPatchCandidate = Readonly<{
  baseRevision: number;
  changes: readonly HotPatchChange[];
  contract: Readonly<Record<string, unknown>>;
  resources?: HotPatchResourceData;
}>;
export type HotPatchStateMigration = (state: Record<string, unknown>, fromContract: Readonly<Record<string, unknown>>, toContract: Readonly<Record<string, unknown>>) => void | Record<string, unknown>;

type Revision = {
  sequence: number;
  stateVersion: number;
  implementations: ReadonlyMap<string, HotPatchImplementation>;
  contract: Readonly<Record<string, unknown>>;
  resources: HotPatchResourceStore;
  leases: number;
};

export class HotPatchRevisionConflict extends Error {
  readonly code = "hot_patch_revision_conflict";
  constructor() { super("Hot patch base revision is no longer active."); }
}

export class HotPatchRuntime {
  private readonly context = new AsyncLocalStorage<Revision>();
  private readonly retained = new Map<number, Revision>();
  private current: Revision = { sequence: 0, stateVersion: 0, implementations: new Map(), contract: Object.freeze({}), resources: new HotPatchResourceStore(), leases: 0 };
  private previous?: Revision;
  private closed = false;
  private registrationClosed = false;
  private migrationInProgress = false;
  private migrationState?: Record<string, unknown>;

  constructor(private readonly maximumRetainedRevisions = 32, contract: Readonly<Record<string, unknown>> = {}, resources: HotPatchResourceData = {}) {
    if (!Number.isSafeInteger(maximumRetainedRevisions) || maximumRetainedRevisions < 2) {
      throw new Error("Hot patch retention limit must be at least two revisions.");
    }
    this.current = { ...this.current, contract: freezeContract(contract), resources: new HotPatchResourceStore(resources) };
    this.retained.set(0, this.current);
  }

  register(id: string, implementation: HotPatchImplementation): void {
    this.assertOpen();
    if (this.registrationClosed || this.current.sequence !== 0) throw new Error("Initial hot patch registration is closed.");
    if (!id.trim() || this.current.implementations.has(id) || typeof implementation !== "function") {
      throw new Error(`Invalid or duplicate hot patch symbol: ${id}`);
    }
    this.current = { ...this.current, implementations: new Map([...this.current.implementations, [id, implementation]]) };
    this.retained.set(0, this.current);
  }

  bind(id: string, environment: object = {}): (...arguments_: unknown[]) => unknown {
    if (!this.current.implementations.has(id)) throw new Error(`Unknown hot patch symbol: ${id}`);
    const runtime = this;
    return function(this: unknown, ...arguments_: unknown[]) {
      return runtime.run(() => {
        const revision = runtime.context.getStore()!;
        const implementation = revision.implementations.get(id);
        if (!implementation) throw new Error(`Symbol is unavailable in revision ${revision.sequence}: ${id}`);
        return implementation(environment, this, arguments_);
      });
    };
  }

  run<T>(operation: () => T): T {
    const lease = this.acquire();
    try {
      const result = lease.run(operation);
      return retainHotPatchResult(result, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  acquire(): HotPatchLease {
    const inherited = this.context.getStore();
    if (!inherited) this.assertOpen();
    if (inherited && !this.retained.has(inherited.sequence)) throw new Error("Hot patch work outlived its request lease.");
    this.registrationClosed = true;
    const revision = inherited ?? this.current;
    revision.leases += 1;
    let released = false;
    return Object.freeze({
      revision: revision.sequence,
      contract: revision.contract,
      run: <T>(operation: () => T): T => {
        if (released) throw new Error("Hot patch request lease is already released.");
        return this.context.run(revision, operation);
      },
      release: () => {
        if (released) return;
        released = true;
        revision.leases -= 1;
        this.collect();
      }
    });
  }

  readResource(path: string): Uint8Array {
    const revision = this.context.getStore();
    if (!revision || revision.leases === 0 || !this.retained.has(revision.sequence)) {
      throw new Error("Hot patch resources require an active request lease.");
    }
    return revision.resources.read(path);
  }

  runFresh<T>(operation: () => T): T {
    return this.context.exit(() => this.run(operation));
  }

  validate(candidate: HotPatchCandidate): void {
    this.assertOpen();
    this.prepare(candidate, false);
  }

  apply(candidate: HotPatchCandidate): number {
    this.assertOpen();
    const prepared = this.prepare(candidate, false);
    if (this.migrationState && !isDeepStrictEqual(prepared.contract.stateSchema, this.current.contract.stateSchema)) {
      throw new Error("Hot patch state schema changes require an explicit migration.");
    }
    return this.publish(prepared.implementations, prepared.contract, prepared.resources);
  }

  applyWithStateMigration(candidate: HotPatchCandidate, state: Record<string, unknown>, migrate: HotPatchStateMigration): number {
    this.assertOpen();
    const prepared = this.prepare(candidate, true);
    return this.migrateAndPublish(prepared.implementations, prepared.contract, state, migrate, prepared.resources);
  }

  rollback(expectedRevision: number): number {
    this.assertOpen();
    if (expectedRevision !== this.current.sequence) throw new HotPatchRevisionConflict();
    if (!this.previous) throw new Error("No previous hot patch revision is retained.");
    if (this.previous.stateVersion !== this.current.stateVersion) {
      throw new Error("Hot patch rollback across state versions requires an explicit reverse migration.");
    }
    return this.publish(this.previous.implementations, this.previous.contract, this.previous.resources);
  }

  rollbackWithStateMigration(expectedRevision: number, state: Record<string, unknown>, migrate: HotPatchStateMigration): number {
    this.assertOpen();
    if (!this.previous) throw new Error("No previous hot patch revision is retained.");
    if (expectedRevision !== this.current.sequence) throw new HotPatchRevisionConflict();
    if (this.migrationState !== state) throw new Error("Hot patch reverse migration must use the original state owner.");
    if (this.previous.stateVersion === this.current.stateVersion) {
      throw new Error("Hot patch code-only rollback does not require a state migration.");
    }
    return this.migrateAndPublish(this.previous.implementations, this.previous.contract, state, migrate, this.previous.resources);
  }

  private migrateAndPublish(implementations: ReadonlyMap<string, HotPatchImplementation>, contract: Readonly<Record<string, unknown>>, state: Record<string, unknown>, migrate: HotPatchStateMigration, resources: HotPatchResourceStore): number {
    if (!isMutableStateObject(state) || typeof migrate !== "function") {
      throw new Error("Hot patch state migration requires a mutable state object and a migration function.");
    }
    if (this.migrationState && this.migrationState !== state) throw new Error("Hot patch migration must use the original state owner.");
    const validSchema = (value: unknown): boolean => (typeof value === "string" && !!value.trim())
      || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    if (!validSchema(this.current.contract.stateSchema) || !validSchema(contract.stateSchema)
      || this.current.contract.stateSchema === contract.stateSchema) {
      throw new Error("Hot patch migration requires distinct explicit stateSchema identities.");
    }
    if ([...this.retained.values()].some(revision => revision.leases > 0)) {
      throw new Error("Hot patch state migration requires all retained revisions to drain first.");
    }
    const draft = cloneState(state);
    this.migrationInProgress = true;
    try {
      const migrated = migrate(draft, this.current.contract, contract);
      if (types.isPromise(migrated)) {
        migrated.catch(() => undefined);
        throw new Error("Hot patch state migration must be synchronous.");
      }
      const replacement = cloneState(migrated === undefined ? draft : migrated);
      if (!isMutableStateObject(state)) throw new Error("Hot patch migration state changed during preparation.");
      replaceState(state, replacement);
      this.migrationState = state;
      return this.publish(implementations, contract, resources, this.current.sequence + 1);
    } finally {
      this.migrationInProgress = false;
    }
  }

  snapshot() {
    return Object.freeze({
      revision: this.current.sequence,
      stateVersion: this.current.stateVersion,
      contract: this.current.contract,
      resourcesSha256: this.current.resources.sha256,
      resourceHashes: this.current.resources.hashes,
      closed: this.closed,
      symbols: Object.freeze([...this.current.implementations.keys()].sort()),
      retained: Object.freeze([...this.retained.values()].map(revision => Object.freeze({
        revision: revision.sequence, leases: revision.leases
      })))
    });
  }

  close(): void {
    if (this.migrationInProgress) throw new Error("Hot patch runtime cannot close during state migration.");
    this.closed = true;
    this.previous = undefined;
    this.collect();
  }

  private publish(implementations: ReadonlyMap<string, HotPatchImplementation>, contract: Readonly<Record<string, unknown>>, resources: HotPatchResourceStore, stateVersion = this.current.stateVersion): number {
    this.collect();
    const pinned = [...this.retained.values()].filter(revision => revision.leases > 0 && revision !== this.current).length;
    if (pinned + 2 > this.maximumRetainedRevisions) throw new Error("Hot patch retention limit reached; accepted work must drain first.");
    this.previous = this.current;
    this.current = { sequence: this.current.sequence + 1, stateVersion, implementations, contract, resources, leases: 0 };
    this.retained.set(this.current.sequence, this.current);
    this.collect();
    return this.current.sequence;
  }

  private prepare(candidate: HotPatchCandidate, allowNoChanges: boolean): Readonly<{ implementations: ReadonlyMap<string, HotPatchImplementation>; contract: Readonly<Record<string, unknown>>; resources: HotPatchResourceStore }> {
    if (candidate.baseRevision !== this.current.sequence) throw new HotPatchRevisionConflict();
    const contract = freezeContract(candidate.contract);
    const resources = candidate.resources === undefined ? this.current.resources : new HotPatchResourceStore(candidate.resources);
    if (!allowNoChanges && !candidate.changes.length && isDeepStrictEqual(contract, this.current.contract)
      && resources.sha256 === this.current.resources.sha256) throw new Error("Hot patch contains no changes.");
    const implementations = new Map(this.current.implementations);
    const seen = new Set<string>();
    for (const change of candidate.changes) {
      if (!implementations.has(change.id) || seen.has(change.id) || typeof change.implementation !== "function") {
        throw new Error(`Invalid hot patch symbol: ${change.id}`);
      }
      seen.add(change.id);
      implementations.set(change.id, change.implementation);
    }
    return { implementations, contract, resources };
  }

  private collect(): void {
    for (const [sequence, revision] of this.retained) {
      if (revision.leases === 0 && (this.closed || (revision !== this.current && revision !== this.previous))) {
        this.retained.delete(sequence);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Hot patch runtime is closed.");
    if (this.migrationInProgress) throw new Error("Hot patch admission is closed during state migration.");
  }
}

function freezeContract(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const ancestors = new Set<object>();
  const validate = (node: unknown): void => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (!node || typeof node !== "object" || ancestors.has(node)
      || (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype)) {
      throw new Error("Hot patch contract must contain only acyclic JSON values.");
    }
    ancestors.add(node);
    for (const child of Object.values(node)) validate(child);
    ancestors.delete(node);
  };
  validate(value);
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== "object" || Object.isFrozen(node)) return;
    Object.freeze(node);
    for (const child of Object.values(node)) freeze(child);
  };
  freeze(copy);
  return copy;
}

function replaceState(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
}

function isMutableStateObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.isExtensible(value)
    && Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return typeof key === "string" && "value" in descriptor && descriptor.enumerable
        && descriptor.configurable && descriptor.writable;
    });
}

function cloneState(value: Record<string, unknown>): Record<string, unknown> {
  if (!isMutableStateObject(value)) throw new Error("Hot patch migration state must be a mutable plain object.");
  assertStateTree(value);
  return structuredClone(value);
}

function assertStateTree(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) {
    throw new Error("Hot patch migration state must contain acyclic JSON values.");
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Hot patch migration state must contain plain objects and arrays.");
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable
      || (array && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw new Error("Hot patch migration state contains an unsupported property.");
    }
    assertStateTree(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
