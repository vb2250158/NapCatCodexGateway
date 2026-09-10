import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CompiledHotPatchModule, HotPatchModule } from "./hotPatchModule.js";
import type { HotPatchChildRequest, HotPatchChildResponse } from "./hotPatchChild.js";

export type HotPatchProcessSnapshot = Readonly<{ pid: number; executionId: string; snapshot: ReturnType<HotPatchModule["snapshot"]>; state?: Record<string, unknown> }>;
export type HotPatchInvocation<T> = Readonly<{ revision: number; contract: Readonly<Record<string, unknown>>; value: T }>;
export type HotPatchPrepared = Readonly<{ pid: number; executionId: string; token: string; snapshot: ReturnType<HotPatchModule["snapshot"]> }>;

export class HotPatchProcessError extends Error {
  constructor(message: string, readonly code: "busy" | "timeout" | "closed" | "worker_failed" | "rejected") {
    super(message);
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class HotPatchProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private lastSnapshot?: HotPatchProcessSnapshot;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private stopPromise?: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private queuedMutations = 0;
  private admissionClosed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(readonly moduleId: string, baseline: CompiledHotPatchModule, private readonly options: Readonly<{
    timeoutMs?: number;
    startupTimeoutMs?: number;
    maximumPending?: number;
    contract?: Readonly<Record<string, unknown>>;
    dependencies?: Readonly<Record<string, unknown>>;
  }> = {}) {
    for (const value of [options.timeoutMs ?? 15_000, options.startupTimeoutMs ?? 15_000, options.maximumPending ?? 64]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Hot patch process limits must be positive safe integers.");
    }
    const dependencies = structuredClone(options.dependencies ?? {});
    const source = import.meta.url.endsWith(".ts");
    this.child = fork(fileURLToPath(new URL(source ? "./hotPatchChild.ts" : "./hotPatchChild.js", import.meta.url)), [], {
      execArgv: source ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      ...{ windowsHide: true }
    });
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.fail(new HotPatchProcessError("Hot patch worker exited; accepted calls are not replayed.", "worker_failed"));
      resolve();
    }));
    this.child.on("error", error => this.fail(new HotPatchProcessError(error.message, "worker_failed")));
    this.child.on("message", (response: HotPatchChildResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new HotPatchProcessError(response.error, "rejected"));
      else pending.resolve(response.value);
      this.notifyIdle();
    });
    this.ready = this.request({ operation: "initialize", moduleId, compiled: baseline, contract: options.contract, dependencies }).then(value => {
      if (this.state !== "starting") throw new HotPatchProcessError("Hot patch worker stopped during initialization.", "closed");
      this.lastSnapshot = value as HotPatchProcessSnapshot;
      this.state = "ready";
    }).catch(error => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    void this.ready.catch(() => {});
  }

  async call<T>(symbol: string, arguments_: readonly unknown[]): Promise<T> {
    if (this.admissionClosed) throw new HotPatchProcessError("Hot patch worker admission is closed.", "closed");
    const acceptedArguments = structuredClone(arguments_);
    await this.ready;
    return this.request({ operation: "call", symbol, arguments: acceptedArguments }) as Promise<T>;
  }

  apply(compiled: CompiledHotPatchModule, expectedRevision: number, contract: Readonly<Record<string, unknown>> = {}): Promise<HotPatchProcessSnapshot> {
    return this.mutate({ operation: "apply", compiled, expectedRevision, contract });
  }

  prepare(compiled: CompiledHotPatchModule, expectedRevision: number, contract: Readonly<Record<string, unknown>> = {}): Promise<HotPatchPrepared> {
    return this.mutate({ operation: "prepare", compiled, expectedRevision, contract }) as Promise<HotPatchPrepared>;
  }

  commit(token: string): Promise<HotPatchProcessSnapshot> {
    if (!token.trim()) return Promise.reject(new HotPatchProcessError("Hot patch prepare token is required.", "rejected"));
    return this.mutate({ operation: "commit", token });
  }

  discard(token: string): Promise<HotPatchProcessSnapshot> {
    if (!token.trim()) return Promise.reject(new HotPatchProcessError("Hot patch prepare token is required.", "rejected"));
    return this.mutate({ operation: "discard", token });
  }

  async invoke<T>(symbol: string, arguments_: readonly unknown[]): Promise<HotPatchInvocation<T>> {
    if (this.admissionClosed) throw new HotPatchProcessError("Hot patch worker admission is closed.", "closed");
    const acceptedArguments = structuredClone(arguments_);
    await this.ready;
    return this.request({ operation: "invoke", symbol, arguments: acceptedArguments }) as Promise<HotPatchInvocation<T>>;
  }

  rollback(expectedRevision: number): Promise<HotPatchProcessSnapshot> {
    return this.mutate({ operation: "rollback", expectedRevision });
  }

  applyWithStateMigration(compiled: CompiledHotPatchModule, expectedRevision: number, stateDependency: string, migrationSource: string, contract: Readonly<Record<string, unknown>>): Promise<HotPatchProcessSnapshot> {
    if (!stateDependency.trim() || !migrationSource.trim()) return Promise.reject(new HotPatchProcessError("Hot patch state dependency and migration source are required.", "rejected"));
    return this.mutate({ operation: "apply-migration", compiled, expectedRevision, stateDependency, migrationSource, contract });
  }

  rollbackWithStateMigration(expectedRevision: number, stateDependency: string, migrationSource: string): Promise<HotPatchProcessSnapshot> {
    if (!stateDependency.trim() || !migrationSource.trim()) return Promise.reject(new HotPatchProcessError("Hot patch state dependency and migration source are required.", "rejected"));
    return this.mutate({ operation: "rollback-migration", expectedRevision, stateDependency, migrationSource });
  }

  status() {
    return Object.freeze({ moduleId: this.moduleId, state: this.state, pending: this.pending.size,
      admissionClosed: this.admissionClosed, queuedMutations: this.queuedMutations, active: this.lastSnapshot });
  }

  async snapshot(stateDependency?: string): Promise<HotPatchProcessSnapshot> {
    if (this.admissionClosed) throw new HotPatchProcessError("Hot patch worker admission is closed.", "closed");
    await this.ready;
    const snapshot = await this.request({ operation: "snapshot", stateDependency }) as HotPatchProcessSnapshot;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  stop(options: Readonly<{ force?: boolean }> = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.admissionClosed = true;
    this.stopPromise = (async () => {
      if (!options.force) {
        await this.ready.catch(() => {});
        await this.mutationTail;
        if (this.pending.size) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
      }
      this.state = "closed";
      this.rejectAll(new HotPatchProcessError("Hot patch worker is stopping; accepted calls are not replayed.", "closed"));
      this.child.kill();
      await this.exited;
    })();
    return this.stopPromise;
  }

  private mutate(request: Omit<HotPatchChildRequest, "id">): Promise<HotPatchProcessSnapshot> {
    if (this.admissionClosed) return Promise.reject(new HotPatchProcessError("Hot patch worker admission is closed.", "closed"));
    if (this.queuedMutations >= (this.options.maximumPending ?? 64)) return Promise.reject(new HotPatchProcessError("Hot patch mutation queue is full.", "busy"));
    let accepted: Omit<HotPatchChildRequest, "id">;
    try { accepted = structuredClone(request); } catch (error) { return Promise.reject(error); }
    this.queuedMutations++;
    const result = this.mutationTail.then(async () => {
      await this.ready;
      const snapshot = await this.request(accepted) as HotPatchProcessSnapshot;
      this.lastSnapshot = snapshot;
      return snapshot;
    });
    this.mutationTail = result.then(() => {}, () => {}).finally(() => { this.queuedMutations--; });
    return result;
  }

  private request(request: Omit<HotPatchChildRequest, "id">): Promise<unknown> {
    if (this.state === "failed" || this.state === "closed") return Promise.reject(new HotPatchProcessError("Hot patch worker is unavailable.", "closed"));
    if (this.pending.size >= (this.options.maximumPending ?? 64)) return Promise.reject(new HotPatchProcessError("Hot patch request queue is full.", "busy"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new HotPatchProcessError("Hot patch worker timed out; accepted calls are not replayed.", "timeout"));
        this.child.kill();
      }, request.operation === "initialize" ? this.options.startupTimeoutMs ?? 15_000 : this.options.timeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.send({ ...request, id }, error => {
          if (error) this.fail(new HotPatchProcessError(error.message, "worker_failed"));
        });
      } catch (error) {
        this.fail(new HotPatchProcessError(error instanceof Error ? error.message : String(error), "worker_failed"));
      }
    });
  }

  private fail(error: Error): void {
    if (this.state !== "closed") this.state = "failed";
    this.rejectAll(error);
    this.child.kill();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.pending.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
