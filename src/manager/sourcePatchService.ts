import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HotPatchCandidateStore } from "../plugin-kernel/hotPatchCandidateStore.js";
import { HotPatchProcess, type HotPatchInvocation, type HotPatchProcessSnapshot } from "../plugin-kernel/hotPatchProcess.js";
import type { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { HotPatchProcessBundle } from "../plugin-kernel/hotPatchProcessBundle.js";
import { HotPatchBundleJournal } from "../plugin-kernel/hotPatchBundleJournal.js";
import { sourcePatchDependencyHash } from "./sourcePatchCatalog.js";

export type SourcePatchRequest = Readonly<{
  operationId: string;
  action: "apply" | "rollback";
  moduleId: string;
  candidateSha256?: string;
  expectedRevision: number;
  applicationGenerationId: string;
  managerInstanceId: string;
  pluginGenerationId: string;
  contract?: Readonly<Record<string, unknown>>;
}>;

type ActiveSource = Readonly<{ sha256: string; contract: Readonly<Record<string, unknown>> }>;
type DynamicRegistration = Readonly<{ schemaVersion: 1; id: string; sha256: string; contract: Readonly<Record<string, unknown>>; dependencies?: Readonly<Record<string, unknown>>; state: "preparing" | "active" }>;
type Pointer = Readonly<{ baselineSha256: string; active: ActiveSource; previous?: ActiveSource; operation?: SourcePatchOperation }>;
export type SourcePatchReconcileRequest = Pick<SourcePatchRequest,
  "operationId" | "moduleId" | "applicationGenerationId" | "managerInstanceId" | "pluginGenerationId">;

export type SourcePatchBundleReconcileRequest = Readonly<{
  operationId: string;
  action: "reconcile-bundle";
  applicationGenerationId: string;
  managerInstanceId: string;
  pluginGenerationId: string;
}>;

export type SourcePatchBundleRequest = Readonly<{
  operationId: string;
  action: "apply-bundle";
  entries: readonly Readonly<{ moduleId: string; candidateSha256: string; expectedRevision: number; contract?: Readonly<Record<string, unknown>> }>[];
  applicationGenerationId: string;
  managerInstanceId: string;
  pluginGenerationId: string;
}>;
type ModuleState = { worker: HotPatchProcess; pointer: Pointer; dependencyHash: string; uncertainOperation?: string };
export type SourcePatchOperation = Readonly<{
  operationId: string;
  fingerprint: string;
  moduleId: string;
  state: "pending" | "committed" | "failed" | "indeterminate";
  commitState: "unknown" | "committed" | "not_started";
  createdAt: string;
  proof?: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
    before: HotPatchProcessSnapshot;
    baselineSha256: string;
    previous: ActiveSource;
    target: ActiveSource;
    targetSourceHash: string;
    bundleModuleIds?: readonly string[];
    bundleEntries?: readonly Readonly<{ moduleId: string; before: HotPatchProcessSnapshot; targetSourceHash: string; target: ActiveSource }>[];
  }>;
  result?: HotPatchProcessSnapshot;
  error?: "candidate_rejected" | "worker_unavailable" | "persistence_unconfirmed" | "publication_not_applied";
}>;

export class SourcePatchError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function createSourcePatchHostService(resolve: () => ManagerSourcePatchService) {
  return Object.freeze({ capability: "host.manager.source-patches@1", value: Object.freeze({
    invoke: (moduleId: string, symbol: string, arguments_: readonly unknown[]) => resolve().invoke(moduleId, symbol, arguments_),
    status: () => resolve().status()
  }) });
}

export class ManagerSourcePatchService {
  private readonly modules = new Map<string, ModuleState>();
  private readonly moduleReady = new Map<string, Promise<ModuleState>>();
  private readonly moduleErrors = new Set<string>();
  private readonly dynamicBaselines = new Set<string>();
  private readonly bundleFences = new Map<string, string>();
  private readonly candidates: HotPatchCandidateStore;
  private readonly baselines: HotPatchCandidateStore;
  private readonly ready: Promise<void>;
  private loadError = false;
  private loaded = false;
  private closed = false;
  private queued = 0;
  private readonly bundleJournal?: HotPatchBundleJournal;

  constructor(private readonly options: Readonly<{
    baselineRoot: string;
    stateRoot: string;
    runtime: GenerationRuntime;
    workerTimeoutMs?: number;
    audit?: (event: string, fields: Readonly<{ operationId: string; moduleId: string; state: string }>) => void;
    bundleJournalRoot?: string;
  }>) {
    this.baselines = new HotPatchCandidateStore(options.baselineRoot);
    this.candidates = new HotPatchCandidateStore(path.join(options.stateRoot, "candidates"));
    this.bundleJournal = options.bundleJournalRoot ? new HotPatchBundleJournal(options.bundleJournalRoot) : undefined;
    this.ready = this.load().then(() => { this.loaded = true; }).catch(async error => {
      this.loadError = true;
      throw error;
    });
    void this.ready.catch(() => {});
  }

  status() {
    const modules = [...this.moduleReady.keys()].map(id => {
      const state = this.modules.get(id);
      const worker = state?.worker.status();
      return state && worker ? { id, dependencyHash: state.dependencyHash, uncertainOperation: state.uncertainOperation, activeCandidateSha256: state.pointer.active.sha256, ...worker, state: this.moduleErrors.has(id) ? "failed" : worker.state }
        : { id, moduleId: id, state: this.moduleErrors.has(id) ? "failed" : "starting", uncertainOperation: undefined };
    });
    const degraded = modules.some(module => module.uncertainOperation || module.state === "failed");
    const starting = !this.loaded || modules.some(module => module.state === "starting");
    return { state: this.closed ? "closed" : this.loadError ? "failed" : degraded ? "degraded" : starting ? "starting" : "ready",
      queued: this.queued, modules };
  }

  async invoke<T>(moduleId: string, symbol: string, arguments_: readonly unknown[]): Promise<HotPatchInvocation<T>> {
    await this.ready;
    return (await this.module(moduleId)).worker.invoke<T>(symbol, arguments_);
  }

  async ensureModule(moduleId: string, candidateSha256: string, contract: Readonly<Record<string, unknown>> = {}, dependencies: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await this.ready;
    if (this.closed) throw new SourcePatchError("Source patch service is closed.", 503);
    this.moduleId(moduleId);
    if (!/^[a-f0-9]{64}$/.test(candidateSha256)) throw new SourcePatchError("Invalid source patch candidate identity.", 400);
    const existing = this.moduleReady.get(moduleId);
    if (existing) { await existing; return; }
    if (this.moduleReady.size >= 128) throw new SourcePatchError("Source patch module limit reached.", 409);
    const captured = structuredClone(contract);
    const capturedDependencies = structuredClone(dependencies);
    sourcePatchDependencyHash(capturedDependencies);
    if (!captured || typeof captured !== "object" || Array.isArray(captured) || Buffer.byteLength(JSON.stringify(captured)) > 64 * 1024) throw new SourcePatchError("Invalid source patch module contract.", 400);
    const generationId = this.options.runtime.current().id;
    const pending = this.options.runtime.publishSourcePatch(generationId, () => this.registerDynamicModule(moduleId, candidateSha256, captured, capturedDependencies));
    this.moduleReady.set(moduleId, pending);
    void pending.catch(() => { this.moduleErrors.add(moduleId); });
    await pending;
  }

  async operation(operationId: string): Promise<SourcePatchOperation | undefined> {
    this.operationId(operationId);
    try {
      return JSON.parse(await fs.readFile(this.operationPath(operationId), "utf8")) as SourcePatchOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  publish(input: SourcePatchRequest): Promise<SourcePatchOperation> {
    this.validate(input);
    if (this.closed) return Promise.reject(new SourcePatchError("Source patch service is closed.", 503));
    if (this.queued >= 16) return Promise.reject(new SourcePatchError("Source patch publication queue is full.", 503));
    const request = structuredClone(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    this.queued++;
    return this.options.runtime.publishSourcePatch(request.pluginGenerationId, async () => {
      await this.ready;
      this.validate(request);
      const existing = await this.operation(request.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new SourcePatchError("Source patch operation ID was reused with different contents.", 409);
        return existing;
      }
      const state = await this.module(request.moduleId);
      if (state.uncertainOperation) throw new SourcePatchError("An earlier source patch outcome requires reconciliation; no new publication is allowed.", 409);
      const before = await state.worker.snapshot();
      if (before.snapshot.revision !== request.expectedRevision) throw new SourcePatchError("Source patch base revision is no longer active.", 409);
      const active: ActiveSource = request.action === "rollback"
        ? state.pointer.previous ?? (() => { throw new SourcePatchError("No previous source patch is retained.", 409); })()
        : { sha256: request.candidateSha256!, contract: request.contract ?? {} };
      const compiled = await this.readCandidate(active.sha256, state.pointer.baselineSha256);
      const pending: SourcePatchOperation = {
        operationId: request.operationId, fingerprint, moduleId: request.moduleId,
        state: "pending", commitState: "unknown", createdAt: new Date().toISOString(),
        proof: { applicationGenerationId: request.applicationGenerationId, managerInstanceId: request.managerInstanceId,
          before, baselineSha256: state.pointer.baselineSha256, previous: state.pointer.active, target: active,
          targetSourceHash: compiled.sourceHash }
      };
      state.uncertainOperation = request.operationId;
      try {
        await this.writeJson(this.pendingPath(request.moduleId), { operationId: request.operationId });
        await fs.mkdir(path.dirname(this.operationPath(request.operationId)), { recursive: true });
        const journal = await fs.open(this.operationPath(request.operationId), "wx");
        try { await journal.writeFile(JSON.stringify(pending)); await journal.sync(); } finally { await journal.close(); }
      } catch {
        const rejected: SourcePatchOperation = { ...pending, state: "failed", commitState: "not_started", error: "publication_not_applied" };
        await this.writeJson(this.operationPath(request.operationId), rejected);
        await this.clearPending(rejected);
        this.audit(rejected);
        return rejected;
      }
      this.audit(pending);
      let operation: SourcePatchOperation;
      let applied = false;
      try {
        const result = await state.worker.apply(compiled, request.expectedRevision, active.contract);
        applied = true;
        operation = { ...pending, state: "committed", commitState: "committed", result };
        const pointer: Pointer = { baselineSha256: state.pointer.baselineSha256, active, previous: state.pointer.active, operation };
        await this.writeJson(this.pointerPath(request.moduleId), pointer);
        state.pointer = pointer;
      } catch (error) {
        const rejected = !applied && (error as { code?: string }).code === "rejected";
        operation = { ...pending, state: rejected ? "failed" : "indeterminate", commitState: rejected ? "not_started" : "unknown",
          error: rejected ? "candidate_rejected" : applied ? "persistence_unconfirmed" : "worker_unavailable" };
      }
      await this.writeJson(this.operationPath(request.operationId), operation);
      if (operation.state === "committed" || operation.state === "failed") {
        await fs.unlink(this.pendingPath(request.moduleId));
        state.uncertainOperation = undefined;
      }
      this.audit(operation);
      return operation;
    }).finally(() => { this.queued--; });
  }

  publishBundle(input: SourcePatchBundleRequest): Promise<SourcePatchOperation> {
    this.validateBundle(input);
    if (this.closed) return Promise.reject(new SourcePatchError("Source patch service is closed.", 503));
    if (this.queued >= 16) return Promise.reject(new SourcePatchError("Source patch publication queue is full.", 503));
    const request = structuredClone(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    this.queued++;
    return this.options.runtime.publishSourcePatch(request.pluginGenerationId, async () => {
      await this.ready;
      this.validateBundle(request);
      const existing = await this.operation(request.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new SourcePatchError("Source patch operation ID was reused with different contents.", 409);
        return existing;
      }
      const states = await Promise.all(request.entries.map(async entry => {
        const state = await this.module(entry.moduleId);
        if (state.uncertainOperation) throw new SourcePatchError("An earlier source patch outcome requires reconciliation; no new publication is allowed.", 409);
        const before = await state.worker.snapshot();
        if (before.snapshot.revision !== entry.expectedRevision) throw new SourcePatchError("Source patch bundle base revision is no longer active.", 409);
        const compiled = await this.readCandidate(entry.candidateSha256, state.pointer.baselineSha256);
        return { entry, state, before, compiled };
      }));
      const pending: SourcePatchOperation = {
        operationId: request.operationId, fingerprint, moduleId: "__bundle__", state: "pending", commitState: "unknown", createdAt: new Date().toISOString(),
        proof: { applicationGenerationId: request.applicationGenerationId, managerInstanceId: request.managerInstanceId,
          before: states[0]!.before, baselineSha256: states[0]!.state.pointer.baselineSha256, previous: states[0]!.state.pointer.active,
          target: { sha256: states[0]!.entry.candidateSha256, contract: states[0]!.entry.contract ?? {} }, targetSourceHash: states[0]!.compiled.sourceHash,
          bundleModuleIds: states.map(item => item.entry.moduleId),
          bundleEntries: states.map(item => ({ moduleId: item.entry.moduleId, before: item.before, targetSourceHash: item.compiled.sourceHash, target: { sha256: item.entry.candidateSha256, contract: item.entry.contract ?? {} } })) }
      };
      await this.bundleJournal?.begin(request.operationId, pending, true);
      for (const item of states) item.state.uncertainOperation = request.operationId;
      await this.writeJson(this.operationPath(request.operationId), pending);
      const bundle = new HotPatchProcessBundle(request.operationId, states.map(({ entry, state, compiled }) => ({
        id: entry.moduleId, process: state.worker, compiled, expectedRevision: entry.expectedRevision, contract: entry.contract
      })), this.bundleJournal ? { journal: this.bundleJournal, claimJournal: false, finalizeJournal: false } : {});
      try {
        const result = await bundle.apply();
        const operation: SourcePatchOperation = { ...pending, state: "committed", commitState: "committed", result: result[0]?.snapshot };
        for (const item of states) {
          const published = result.find(value => value.id === item.entry.moduleId);
          if (!published) throw new Error("Source patch bundle returned an incomplete result.");
          const active: ActiveSource = { sha256: item.entry.candidateSha256, contract: item.entry.contract ?? {} };
          const pointer: Pointer = { baselineSha256: item.state.pointer.baselineSha256, active, previous: item.state.pointer.active, operation };
          await this.writeJson(this.pointerPath(item.entry.moduleId), pointer);
          item.state.pointer = pointer;
        }
        await this.writeJson(this.operationPath(request.operationId), operation);
        await this.bundleJournal?.mark(request.operationId, "committed", result);
        for (const item of states) item.state.uncertainOperation = undefined;
        this.audit(operation);
        return operation;
      } catch (error) {
        const operation: SourcePatchOperation = { ...pending, state: "indeterminate", commitState: "unknown", error: "persistence_unconfirmed" };
        await this.writeJson(this.operationPath(request.operationId), operation).catch(() => undefined);
        await this.bundleJournal?.mark(request.operationId, "indeterminate", undefined, error).catch(() => undefined);
        this.audit(operation);
        throw error;
      }
    }).finally(() => { this.queued--; });
  }
  reconcileBundle(input: SourcePatchBundleReconcileRequest): Promise<SourcePatchOperation> {
    this.operationId(input.operationId);
    this.validateIdentity(input);
    if (this.closed) return Promise.reject(new SourcePatchError("Source patch service is closed.", 503));
    if (this.queued >= 16) return Promise.reject(new SourcePatchError("Source patch publication queue is full.", 503));
    const request = structuredClone(input);
    this.queued++;
    return this.options.runtime.publishSourcePatch(request.pluginGenerationId, async () => {
      await this.ready;
      this.validateIdentity(request);
      const original = await this.operation(request.operationId);
      if (!original || original.moduleId !== "__bundle__") throw new SourcePatchError("Source patch bundle operation was not found.", 404);
      if (original.state === "committed" || original.state === "failed") return original;
      const entries = original.proof?.bundleEntries;
      if (!entries || entries.length < 2 || original.proof.applicationGenerationId !== request.applicationGenerationId || original.proof.managerInstanceId !== request.managerInstanceId) return original;
      const snapshots = await Promise.all(entries.map(async entry => ({ entry, snapshot: await (await this.module(entry.moduleId)).worker.snapshot() })));
      const allCommitted = snapshots.every(({ entry, snapshot }) => snapshot.snapshot.revision === entry.before.snapshot.revision + 1 && snapshot.snapshot.sourceHash === entry.targetSourceHash && JSON.stringify(snapshot.snapshot.contract) === JSON.stringify(entry.target.contract));
      const allUnchanged = snapshots.every(({ entry, snapshot }) => snapshot.snapshot.revision === entry.before.snapshot.revision && snapshot.snapshot.sourceHash === entry.before.snapshot.sourceHash);
      if (!allCommitted && !allUnchanged) return original;
      const recovered: SourcePatchOperation = { ...original, state: allCommitted ? "committed" : "failed", commitState: allCommitted ? "committed" : "not_started", result: allCommitted ? snapshots[0]!.snapshot : undefined, error: allCommitted ? undefined : "publication_not_applied" };
      if (allCommitted) for (const { entry, snapshot } of snapshots) {
        const active = entry.target;
        const state = this.modules.get(entry.moduleId)!;
        const previous = state.pointer.operation?.operationId === original.operationId ? state.pointer.previous : state.pointer.active;
        const pointer: Pointer = { baselineSha256: state.pointer.baselineSha256, active, previous, operation: recovered };
        await this.writeJson(this.pointerPath(entry.moduleId), pointer);
        state.pointer = pointer;
      }
      await this.writeJson(this.operationPath(request.operationId), recovered);
      for (const entry of entries) {
        if (this.bundleFences.get(entry.moduleId) === request.operationId) this.bundleFences.delete(entry.moduleId);
        const state = this.modules.get(entry.moduleId);
        if (state?.uncertainOperation === request.operationId) state.uncertainOperation = undefined;
      }
      this.audit(recovered);
      return recovered;
    }).finally(() => { this.queued--; });
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.options.runtime.publishSourcePatch(this.options.runtime.current().id, async () => {}).catch(() => {});
    await this.ready.catch(() => {});
    await Promise.allSettled(this.moduleReady.values());
    await Promise.all([...this.modules.values()].map(state => state.worker.stop()));
  }

  reconcile(input: SourcePatchReconcileRequest): Promise<SourcePatchOperation> {
    this.operationId(input.operationId);
    this.moduleId(input.moduleId);
    this.validateIdentity(input);
    if (this.closed) return Promise.reject(new SourcePatchError("Source patch service is closed.", 503));
    if (this.queued >= 16) return Promise.reject(new SourcePatchError("Source patch publication queue is full.", 503));
    const request = structuredClone(input);
    this.queued++;
    return this.options.runtime.publishSourcePatch(request.pluginGenerationId, async () => {
      await this.ready;
      this.validateIdentity(request);
      await this.moduleReady.get(request.moduleId)?.catch(() => {});
      const original = await this.operation(request.operationId);
      if (!original || original.moduleId !== request.moduleId) throw new SourcePatchError("Source patch operation was not found for this module.", 404);
      if (original.state === "committed" || original.state === "failed") {
        await this.clearPending(original);
        return original;
      }
      const proof = original.proof;
      if (!proof) return original;
      let pointer: Pointer | undefined;
      try { pointer = JSON.parse(await fs.readFile(this.pointerPath(original.moduleId), "utf8")) as Pointer; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let recovered: SourcePatchOperation | undefined;
      if (pointer?.operation?.state === "committed" && pointer.operation.operationId === original.operationId
        && pointer.operation.moduleId === original.moduleId && pointer.operation.fingerprint === original.fingerprint
        && pointer.baselineSha256 === proof.baselineSha256 && pointer.active.sha256 === proof.target.sha256
        && pointer.operation.result?.snapshot.sourceHash === proof.targetSourceHash
        && JSON.stringify(pointer.active.contract) === JSON.stringify(proof.target.contract)) {
        recovered = pointer.operation;
      } else {
        let current: HotPatchProcessSnapshot;
        try { current = await (await this.module(original.moduleId)).worker.snapshot(); }
        catch { return original; }
        if (request.applicationGenerationId !== proof.applicationGenerationId || request.managerInstanceId !== proof.managerInstanceId
          || !proof.before.executionId || current.executionId !== proof.before.executionId || current.pid !== proof.before.pid) return original;
        if (current.snapshot.revision === proof.before.snapshot.revision + 1 && current.snapshot.sourceHash === proof.targetSourceHash
          && JSON.stringify(current.snapshot.contract) === JSON.stringify(proof.target.contract)) {
          recovered = { ...original, state: "committed", commitState: "committed", result: current, error: undefined };
          pointer = { baselineSha256: proof.baselineSha256, active: proof.target, previous: proof.previous, operation: recovered };
          await this.writeJson(this.pointerPath(original.moduleId), pointer);
        } else if (current.snapshot.revision === proof.before.snapshot.revision && current.snapshot.sourceHash === proof.before.snapshot.sourceHash
          && JSON.stringify(current.snapshot.contract) === JSON.stringify(proof.before.snapshot.contract)) {
          recovered = { ...original, state: "failed", commitState: "not_started", error: "publication_not_applied" };
        }
      }
      if (!recovered) return original;
      await this.writeJson(this.operationPath(original.operationId), recovered);
      const state = this.modules.get(original.moduleId);
      if (state && pointer && recovered.state === "committed") state.pointer = pointer;
      await this.clearPending(recovered);
      this.audit(recovered);
      return recovered;
    }).finally(() => { this.queued--; });
  }

  private async load(): Promise<void> {
    const catalog = JSON.parse(await fs.readFile(path.join(this.options.baselineRoot, "catalog.json"), "utf8")) as {
      schemaVersion: number; modules: Array<{ id: string; sha256: string; contract: Readonly<Record<string, unknown>> }>;
    };
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.modules) || catalog.modules.length > 128) throw new Error("Invalid source patch baseline catalog.");
    const ids = new Set<string>();
    for (const entry of catalog.modules) {
      this.moduleId(entry.id);
      if (ids.has(entry.id)) throw new Error("Duplicate source patch module.");
      ids.add(entry.id);
    }
    await this.restoreBundleFences();
    for (const entry of catalog.modules) {
      const ready = this.loadModule(entry).catch(async error => {
        this.moduleErrors.add(entry.id);
        await this.modules.get(entry.id)?.worker.stop({ force: true });
        throw error;
      });
      this.moduleReady.set(entry.id, ready);
      void ready.catch(() => {});
    }
    const directory = path.join(this.options.stateRoot, "registrations");
    let files: string[];
    try { files = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (files.filter(file => file.endsWith(".json")).length + ids.size > 128) throw new Error("Source patch module limit reached.");
    for (const file of files.filter(file => file.endsWith(".json"))) {
      const moduleId = file.slice(0, -5);
      this.moduleId(moduleId);
      const packaged = this.moduleReady.get(moduleId);
      const ready = (async () => {
        if (packaged) {
          await packaged.catch(() => {});
          throw new Error("Dynamic source patch module conflicts with a packaged baseline; explicit rebase is required.");
        }
        const target = path.join(directory, file);
        if ((await fs.stat(target)).size > 160 * 1024) throw new Error("Source patch registration exceeds its size limit.");
        const entry = JSON.parse(await fs.readFile(target, "utf8")) as DynamicRegistration;
        if (entry.schemaVersion !== 1 || entry.id !== moduleId || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.state !== "active") throw new Error("Source patch registration is unconfirmed; initialization will not be replayed.");
        this.dynamicBaselines.add(entry.sha256);
        return this.loadModule(entry);
      })().catch(async error => {
        this.moduleErrors.add(moduleId);
        await this.modules.get(moduleId)?.worker.stop({ force: true });
        throw error;
      });
      this.moduleReady.set(moduleId, ready);
      void ready.catch(() => {});
    }
  }

  private async restoreBundleFences(): Promise<void> {
    const directory = path.join(this.options.stateRoot, "operations");
    let files: string[];
    try { files = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const operation = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) as SourcePatchOperation;
        if ((operation.state === "pending" || operation.state === "indeterminate") && operation.proof?.bundleModuleIds) {
          for (const moduleId of operation.proof.bundleModuleIds) {
            this.moduleId(moduleId);
            const existing = this.bundleFences.get(moduleId);
            if (existing && existing !== operation.operationId) throw new Error("Overlapping unresolved source patch bundles require recovery.");
            this.bundleFences.set(moduleId, operation.operationId);
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private async loadModule(entry: { id: string; sha256: string; contract: Readonly<Record<string, unknown>>; dependencies?: Readonly<Record<string, unknown>> }): Promise<ModuleState> {
      let pointer: Pointer = { baselineSha256: entry.sha256, active: { sha256: entry.sha256, contract: entry.contract } };
      try {
        pointer = JSON.parse(await fs.readFile(this.pointerPath(entry.id), "utf8")) as Pointer;
        if (pointer.baselineSha256 !== entry.sha256) throw new Error("Source patch baseline changed; explicit rebase is required.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const compiled = await this.readCandidate(pointer.active.sha256, entry.sha256);
      const dependencyHash = sourcePatchDependencyHash(entry.dependencies);
      const worker = new HotPatchProcess(entry.id, compiled, { contract: pointer.active.contract, dependencies: entry.dependencies, timeoutMs: this.options.workerTimeoutMs });
      const state: ModuleState = { worker, pointer, dependencyHash, uncertainOperation: this.bundleFences.get(entry.id) };
      this.modules.set(entry.id, state);
      try {
        const pending = JSON.parse(await fs.readFile(this.pendingPath(entry.id), "utf8")) as { operationId: string };
        this.operationId(pending.operationId);
        const operation = await this.operation(pending.operationId);
        if (operation?.state === "committed" || operation?.state === "failed") await fs.unlink(this.pendingPath(entry.id));
        else state.uncertainOperation = pending.operationId;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await worker.snapshot();
      return state;
  }

  private async registerDynamicModule(moduleId: string, candidateSha256: string, contract: Readonly<Record<string, unknown>>, dependencies: Readonly<Record<string, unknown>>): Promise<ModuleState> {
    if (this.closed) throw new SourcePatchError("Source patch service is closed.", 503);
    const compiled = await this.candidates.read(candidateSha256);
    const registrationPath = path.join(this.options.stateRoot, "registrations", `${moduleId}.json`);
    const registration: DynamicRegistration = { schemaVersion: 1, id: moduleId, sha256: candidateSha256, contract, dependencies, state: "preparing" };
    await this.writeJson(registrationPath, registration);
    const worker = new HotPatchProcess(moduleId, compiled, { contract, dependencies, timeoutMs: this.options.workerTimeoutMs });
    const pointer: Pointer = { baselineSha256: candidateSha256, active: { sha256: candidateSha256, contract } };
    const state: ModuleState = { worker, pointer, dependencyHash: sourcePatchDependencyHash(dependencies) };
    try {
      await worker.snapshot();
      if (this.closed) throw new SourcePatchError("Source patch service is closed.", 503);
      await this.writeJson(registrationPath, { ...registration, state: "active" });
      this.dynamicBaselines.add(candidateSha256);
      this.modules.set(moduleId, state);
      return state;
    } catch (error) {
      this.moduleErrors.add(moduleId);
      await worker.stop({ force: true }).catch(() => {});
      throw error;
    }
  }

  private readCandidate(sha256: string, baselineSha256: string) {
    return sha256 === baselineSha256 && !this.dynamicBaselines.has(baselineSha256) ? this.baselines.read(sha256) : this.candidates.read(sha256);
  }

  private async module(id: string): Promise<ModuleState> {
    if (this.closed) throw new SourcePatchError("Source patch service is closed.", 503);
    const pending = this.moduleReady.get(id);
    if (!pending) throw new SourcePatchError("Source patch module was not found.", 404);
    const state = await pending;
    if (this.closed) throw new SourcePatchError("Source patch service is closed.", 503);
    return state;
  }

  private validateBundle(input: SourcePatchBundleRequest): void {
    this.operationId(input.operationId);
    this.validateIdentity(input);
    if (input.action !== "apply-bundle" || !Array.isArray(input.entries) || input.entries.length < 2 || input.entries.length > 128) {
      throw new SourcePatchError("Invalid source patch bundle request.", 400);
    }
    const ids = new Set<string>();
    for (const entry of input.entries) {
      this.moduleId(entry.moduleId);
      if (ids.has(entry.moduleId) || !/^[a-f0-9]{64}$/.test(entry.candidateSha256) || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision < 0) {
        throw new SourcePatchError("Invalid source patch bundle entry.", 400);
      }
      ids.add(entry.moduleId);
    }
  }
  private validate(input: SourcePatchRequest): void {
    this.operationId(input.operationId);
    this.moduleId(input.moduleId);
    if (!["apply", "rollback"].includes(input.action) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || (input.action === "apply" && !/^[a-f0-9]{64}$/.test(input.candidateSha256 ?? ""))) {
      throw new SourcePatchError("Invalid source patch publication request.", 400);
    }
    this.validateIdentity(input);
  }

  private validateIdentity(input: Pick<SourcePatchRequest, "applicationGenerationId" | "managerInstanceId" | "pluginGenerationId">): void {
    const current = this.options.runtime.current();
    if (input.applicationGenerationId !== current.applicationGenerationId || input.managerInstanceId !== current.managerInstanceId
      || input.pluginGenerationId !== current.id) throw new SourcePatchError("Source patch application identity is no longer active.", 409);
  }

  private operationId(id: string): void {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new SourcePatchError("Invalid source patch operation ID.", 400);
  }

  private moduleId(id: string): void {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new SourcePatchError("Invalid source patch module ID.", 400);
  }

  private operationPath(id: string): string { return path.join(this.options.stateRoot, "operations", `${id}.json`); }
  private pointerPath(id: string): string { return path.join(this.options.stateRoot, "active", `${id}.json`); }
  private pendingPath(id: string): string { return path.join(this.options.stateRoot, "pending", `${id}.json`); }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, "wx");
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, target);
    }
    finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  private async clearPending(operation: SourcePatchOperation): Promise<void> {
    try {
      const pending = JSON.parse(await fs.readFile(this.pendingPath(operation.moduleId), "utf8")) as { operationId: string };
      if (pending.operationId === operation.operationId) await fs.unlink(this.pendingPath(operation.moduleId));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const state = this.modules.get(operation.moduleId);
    if (state?.uncertainOperation === operation.operationId) state.uncertainOperation = undefined;
  }

  private audit(operation: SourcePatchOperation): void {
    try { this.options.audit?.("source_patch_publication", { operationId: operation.operationId, moduleId: operation.moduleId, state: operation.state }); }
    catch { }
  }
}
