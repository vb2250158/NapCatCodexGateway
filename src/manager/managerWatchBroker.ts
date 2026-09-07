import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configWatchDirectoryRules, configWatchEventMatches } from "./configWatchPolicy.js";
import { isUncPath, requiresWorkerFilesystemAccess } from "../shared/pathPolicy.js";
import type {
  ConfigWatchSnapshotRequest,
  ManagerWatchSnapshotRequest,
  ManagerWatchSnapshotResult,
  ManagerWatchWorkerResponse,
  PluginTreeWatchSnapshotRequest
} from "./managerWatchBrokerWorker.js";

export { isUncPath, requiresWorkerFilesystemAccess } from "../shared/pathPolicy.js";
export type {
  ConfigWatchSnapshotRequest,
  ManagerWatchSnapshotRequest,
  ManagerWatchSnapshotResult,
  PluginTreeWatchSnapshotRequest
} from "./managerWatchBrokerWorker.js";

export type ConfigWatchSnapshotResult = ManagerWatchSnapshotResult;

export type ConfigWatchSnapshotAttempt = {
  pid?: number;
  result: Promise<ManagerWatchSnapshotResult>;
  closed: Promise<void>;
  terminate(signal?: NodeJS.Signals): void;
};

export type ManagerWatchBrokerStatus = Readonly<{
  state: "disabled" | "initializing" | "ready" | "degraded" | "closing" | "closed";
  partial: boolean;
  errors: readonly string[];
  attempts: number;
  timeouts: number;
  restarts: number;
  activeWorkerPid?: number;
  lastSuccessAt?: string;
}>;

export type PublicManagerWatchBrokerStatus = Readonly<{
  state: ManagerWatchBrokerStatus["state"];
  partial: boolean;
  errorCount: number;
  lastErrorCode?: "MANAGER_WATCH_DEGRADED";
  attempts: number;
  timeouts: number;
  restarts: number;
  activeWorkerPid?: number;
  lastSuccessAt?: string;
}>;

export function publicManagerWatchBrokerStatus(
  status: ManagerWatchBrokerStatus
): PublicManagerWatchBrokerStatus {
  return Object.freeze({
    state: status.state,
    partial: status.partial,
    errorCount: status.errors.length,
    lastErrorCode: status.errors.length > 0 ? "MANAGER_WATCH_DEGRADED" : undefined,
    attempts: status.attempts,
    timeouts: status.timeouts,
    restarts: status.restarts,
    activeWorkerPid: status.activeWorkerPid,
    lastSuccessAt: status.lastSuccessAt
  });
}

type WatchHandle = {
  close(): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
};

type ManagerWatchBrokerOptions = {
  request: ManagerWatchSnapshotRequest | (() => ManagerWatchSnapshotRequest);
  attemptTimeoutMs?: number;
  terminationCloseTimeoutMs?: number;
  forceTerminationCloseTimeoutMs?: number;
  retryDelayMs?: number;
  remotePollIntervalMs?: number;
  debounceMs?: number;
  createAttempt?: (request: ManagerWatchSnapshotRequest) => ConfigWatchSnapshotAttempt;
  watchDirectory?: (
    directory: string,
    options: { recursive?: boolean },
    listener: (eventType: string, fileName: string | Buffer | null) => void
  ) => WatchHandle;
  ensureLocalDirectory?: (directory: string) => void;
  onSnapshot: (result: ManagerWatchSnapshotResult, reason: string) => void | Promise<void>;
  onStatus?: (status: ManagerWatchBrokerStatus) => void;
  onDiagnostic?: (diagnostic: ManagerWatchDiagnostic) => void;
};

export type ManagerWatchDiagnostic = Readonly<{
  event: "manager_watch_degraded" | "manager_watch_recovered";
  status: ManagerWatchBrokerStatus;
  previousState: ManagerWatchBrokerStatus["state"];
  reason: string;
  durationMs: number;
  timeoutMs: number;
  error?: Error;
}>;

type ArmedWatcher = {
  handle: WatchHandle;
  signature: string;
};

class ManagerWatchAttemptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Manager watch snapshot worker exceeded ${timeoutMs}ms.`);
    this.name = "ManagerWatchAttemptTimeoutError";
  }
}

async function closesWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed.then(() => true, () => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workerEntryPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./managerWatchBrokerWorker.ts" : "./managerWatchBrokerWorker.js",
    import.meta.url
  ));
}

function workerExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

export function spawnConfigWatchSnapshotAttempt(
  request: ManagerWatchSnapshotRequest
): ConfigWatchSnapshotAttempt {
  const worker: ChildProcess = fork(workerEntryPath(), [], {
    execArgv: workerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      RABIROUTE_MANAGER_WATCH_PROCESS: "1"
    }
  });
  let settled = false;
  let resolveResult!: (result: ManagerWatchSnapshotResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ManagerWatchSnapshotResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  // `exit` is the authoritative signal that the OS process no longer exists.
  // Keep `close` below for the stronger "exited before responding" diagnosis,
  // but do not leave the broker blocked when an already-reaped child never
  // produces a later stream-close notification.
  worker.once("exit", () => resolveClosed());
  worker.once("close", (code, signal) => {
    resolveClosed();
    if (!settled) fail(new Error(
      `Manager watch snapshot worker exited before responding (code=${code ?? "none"}, signal=${signal ?? "none"}).`
    ));
  });
  worker.once("error", error => fail(error));
  worker.on("message", raw => {
    if (settled) return;
    const message = raw as ManagerWatchWorkerResponse;
    settled = true;
    if (message.ok) resolveResult(message.result);
    else rejectResult(Object.assign(new Error(message.message), { stack: message.stack }));
  });
  worker.unref();
  worker.channel?.unref?.();
  worker.send(request.kind ? request : { ...request, kind: "config" });
  let disconnected = false;
  return {
    pid: worker.pid,
    result,
    closed,
    terminate(signal = "SIGTERM"): void {
      if (!disconnected) {
        disconnected = true;
        if (worker.connected) worker.disconnect();
      }
      if (worker.exitCode === null && worker.signalCode === null) worker.kill(signal);
    }
  };
}

function initialStatus(): ManagerWatchBrokerStatus {
  return Object.freeze({
    state: "initializing",
    partial: true,
    errors: Object.freeze([]),
    attempts: 0,
    timeouts: 0,
    restarts: 0
  });
}

export function disabledManagerWatchBrokerStatus(): ManagerWatchBrokerStatus {
  return Object.freeze({
    state: "disabled",
    partial: false,
    errors: Object.freeze([]),
    attempts: 0,
    timeouts: 0,
    restarts: 0
  });
}

function requestRoots(request: ManagerWatchSnapshotRequest): readonly string[] {
  return request.kind === "plugin_tree"
    ? request.roots
    : [request.routeRoot, request.rolesRoot, ...(request.explicitFiles ?? [])];
}

export class ManagerWatchBroker {
  private readonly options: Required<Pick<ManagerWatchBrokerOptions,
    "attemptTimeoutMs"
    | "terminationCloseTimeoutMs"
    | "forceTerminationCloseTimeoutMs"
    | "retryDelayMs"
    | "remotePollIntervalMs"
    | "debounceMs"
  >> & ManagerWatchBrokerOptions;
  private readonly watchers = new Map<string, ArmedWatcher>();
  private currentStatus = initialStatus();
  private attemptStartedAt = 0;
  private attemptReason = "startup";
  private activeAttempt?: ConfigWatchSnapshotAttempt;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private running = false;
  private queuedReason?: string;
  private started = false;
  private closedFlag = false;
  private restartPending = false;
  private terminationBlockedAttempt?: ConfigWatchSnapshotAttempt;
  private closeCompletion?: Promise<void>;
  private terminationAttempts = new WeakMap<ConfigWatchSnapshotAttempt, Promise<boolean>>();
  private terminationFailureHandlers = new WeakSet<ConfigWatchSnapshotAttempt>();

  constructor(options: ManagerWatchBrokerOptions) {
    this.options = {
      ...options,
      attemptTimeoutMs: Math.max(20, options.attemptTimeoutMs ?? 4_000),
      terminationCloseTimeoutMs: Math.max(1, options.terminationCloseTimeoutMs ?? 250),
      forceTerminationCloseTimeoutMs: Math.max(1, options.forceTerminationCloseTimeoutMs ?? 1_000),
      retryDelayMs: Math.max(1, options.retryDelayMs ?? 500),
      remotePollIntervalMs: Math.max(10, options.remotePollIntervalMs ?? 5_000),
      debounceMs: Math.max(1, options.debounceMs ?? 120)
    };
  }

  start(): void {
    if (this.started || this.closedFlag) return;
    this.started = true;
    this.publish({ state: "initializing", partial: true, errors: [] });
    this.requestRefresh("during watch initialization");
  }

  status(): ManagerWatchBrokerStatus {
    return this.currentStatus;
  }

  requestRefresh(reason: string): void {
    if (this.closedFlag) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.terminationBlockedAttempt) {
      this.queuedReason = reason;
      return;
    }
    if (this.running) {
      this.queuedReason = reason;
      return;
    }
    this.running = true;
    void this.refresh(reason).finally(() => {
      this.running = false;
      if (this.closedFlag) return;
      if (this.terminationBlockedAttempt) return;
      const queued = this.queuedReason;
      this.queuedReason = undefined;
      if (queued) {
        queueMicrotask(() => this.requestRefresh(queued));
        return;
      }
      const delay = this.currentStatus.state === "degraded"
        ? this.options.retryDelayMs
        : this.options.remotePollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.requestRefresh("during bounded watch polling");
      }, delay);
      this.pollTimer.unref?.();
    });
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.queuedReason = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = undefined;
    this.debounceTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.handle.close();
    this.watchers.clear();
    const attempt = this.activeAttempt;
    if (!attempt) {
      this.publish({ state: "closed", partial: false, errors: [], activeWorkerPid: undefined });
      return;
    }
    this.publish({ state: "closing", partial: true, activeWorkerPid: attempt.pid });
    const completion = this.finishClose(attempt);
    this.closeCompletion = completion;
    void completion.catch(() => {});
  }

  async closed(): Promise<void> {
    if (this.currentStatus.state === "closed") return;
    if (this.closeCompletion) await this.closeCompletion;
  }

  private currentRequest(): ManagerWatchSnapshotRequest {
    const request = typeof this.options.request === "function"
      ? this.options.request()
      : this.options.request;
    return request.kind ? request : { ...request, kind: "config" };
  }

  private async refresh(reason: string): Promise<void> {
    const request = this.currentRequest();
    this.attemptStartedAt = Date.now();
    this.attemptReason = reason;
    let attempt: ConfigWatchSnapshotAttempt | undefined;
    let resultReceived = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (this.restartPending) {
        this.restartPending = false;
        this.publish({ restarts: this.currentStatus.restarts + 1 });
      }
      attempt = (this.options.createAttempt ?? spawnConfigWatchSnapshotAttempt)(request);
      this.activeAttempt = attempt;
      this.publish({
        attempts: this.currentStatus.attempts + 1,
        activeWorkerPid: attempt.pid
      });
      const result = await Promise.race([
        attempt.result,
        new Promise<ManagerWatchSnapshotResult>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ManagerWatchAttemptTimeoutError(this.options.attemptTimeoutMs)),
            this.options.attemptTimeoutMs
          );
          timer.unref?.();
        })
      ]);
      resultReceived = true;
      if (this.closedFlag) return;
      const localErrors = this.armLocalWatchers(request, result.files);
      await this.options.onSnapshot(result, reason);
      if (this.closedFlag) return;
      const errors = [...result.errors, ...localErrors];
      this.publish({
        state: result.partial || errors.length > 0 ? "degraded" : "ready",
        partial: result.partial || errors.length > 0,
        errors,
        lastSuccessAt: new Date().toISOString()
      });
    } catch (error) {
      if (this.closedFlag) return;
      const timedOut = error instanceof ManagerWatchAttemptTimeoutError;
      this.restartPending = true;
      this.publish({
        state: "degraded",
        partial: true,
        errors: [error instanceof Error ? error.message : String(error)],
        timeouts: this.currentStatus.timeouts + (timedOut ? 1 : 0)
      }, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (timer) clearTimeout(timer);
      if (attempt) {
        const confirmed = resultReceived
          ? await this.closeCompletedAttempt(attempt)
          : await this.terminateAttempt(attempt);
        if (!confirmed) {
          if (!this.closedFlag) this.handleTerminationFailure(attempt);
        } else if (this.activeAttempt === attempt) {
          this.activeAttempt = undefined;
          this.publish({ activeWorkerPid: undefined });
        }
      }
    }
  }

  private async closeCompletedAttempt(attempt: ConfigWatchSnapshotAttempt): Promise<boolean> {
    if (await closesWithin(attempt.closed, this.options.terminationCloseTimeoutMs)) return true;
    return this.terminateAttempt(attempt);
  }

  private armLocalWatchers(request: ManagerWatchSnapshotRequest, files: string[]): string[] {
    const desired = new Map<string, {
      signature: string;
      recursive: boolean;
      matches(eventType: string, fileName: string | Buffer | null): boolean;
    }>();
    if (request.kind === "plugin_tree") {
      for (const root of request.roots) {
        if (requiresWorkerFilesystemAccess(root)) continue;
        const directory = path.resolve(root);
        desired.set(directory, {
          signature: "plugin-tree-recursive",
          recursive: true,
          matches: (_eventType, fileName) => {
            const name = fileName?.toString().replace(/\\/g, "/") ?? "";
            return !name.includes(".runtime") && !name.endsWith(".tmp");
          }
        });
      }
    } else {
      const rules = configWatchDirectoryRules(request.routeRoot, request.rolesRoot, files);
      for (const [directory, rule] of rules) {
        if (requiresWorkerFilesystemAccess(directory)) continue;
        desired.set(directory, {
          signature: `${rule.discovery}|${[...rule.fileNames].sort().join("|")}`,
          recursive: false,
          matches: (eventType, fileName) => configWatchEventMatches(rule, eventType, fileName)
        });
      }
    }

    for (const [directory, watcher] of this.watchers) {
      const rule = desired.get(directory);
      if (rule?.signature === watcher.signature) continue;
      watcher.handle.close();
      this.watchers.delete(directory);
    }

    const errors: string[] = [];
    for (const [directory, rule] of desired) {
      if (this.closedFlag || this.watchers.get(directory)?.signature === rule.signature) continue;
      try {
        if (request.kind === "plugin_tree") {
          (this.options.ensureLocalDirectory ?? (target => fs.mkdirSync(target, { recursive: true })))(directory);
        }
        const watchDirectory = this.options.watchDirectory
          ?? ((target, watchOptions, listener) => fs.watch(target, watchOptions, listener));
        const handle = watchDirectory(directory, { recursive: rule.recursive }, (eventType, fileName) => {
          if (!rule.matches(eventType, fileName)) return;
          this.scheduleDebouncedRefresh(request.kind === "plugin_tree"
            ? "after plugin profile or bundle event"
            : "after config file event");
        });
        handle.on?.("error", error => {
          if (this.closedFlag) return;
          this.publish({ state: "degraded", partial: true, errors: [
            `Watch failed for ${directory}: ${error.message}`
          ] });
          this.scheduleDebouncedRefresh("after native watch error");
        });
        this.watchers.set(directory, { handle, signature: rule.signature });
      } catch (error) {
        errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return errors;
  }

  private scheduleDebouncedRefresh(reason: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.requestRefresh(reason);
    }, this.options.debounceMs);
    this.debounceTimer.unref?.();
  }

  private publish(patch: Partial<ManagerWatchBrokerStatus>, error?: Error): void {
    const previous = this.currentStatus;
    this.currentStatus = Object.freeze({
      ...this.currentStatus,
      ...patch,
      errors: Object.freeze([...(patch.errors ?? this.currentStatus.errors)])
    });
    this.options.onStatus?.(this.currentStatus);
    const status = this.currentStatus;
    const degraded = patch.state === "degraded" && (
      previous.state !== "degraded" || previous.timeouts !== status.timeouts
      || JSON.stringify(previous.errors) !== JSON.stringify(status.errors)
    );
    const recovered = previous.state === "degraded" && status.state === "ready";
    if (degraded || recovered) {
      // Diagnostic sinks must not change watcher recovery or termination behavior.
      try {
        this.options.onDiagnostic?.({
          event: degraded ? "manager_watch_degraded" : "manager_watch_recovered",
          status, previousState: previous.state, reason: this.attemptReason,
          durationMs: this.attemptStartedAt ? Date.now() - this.attemptStartedAt : 0,
          timeoutMs: this.options.attemptTimeoutMs,
          error: degraded ? error ?? new Error(status.errors.join("\n") || "Partial watch snapshot") : undefined
        });
      } catch { /* Diagnostics are observational; the log sink owns write failures. */ }
    }
  }

  private handleTerminationFailure(attempt: ConfigWatchSnapshotAttempt): void {
    const pid = attempt.pid ?? "unknown";
    const failure = `termination_failed: Manager watch snapshot worker ${pid} did not close after SIGKILL.`;
    this.terminationBlockedAttempt = attempt;
    this.publish({
      state: "degraded",
      partial: true,
      activeWorkerPid: attempt.pid,
      errors: [...this.currentStatus.errors.filter(error => !error.startsWith("termination_failed:")), failure]
    });
    if (this.terminationFailureHandlers.has(attempt)) return;
    this.terminationFailureHandlers.add(attempt);
    void attempt.closed.then(() => {
      if (this.terminationBlockedAttempt !== attempt) return;
      this.terminationBlockedAttempt = undefined;
      if (this.activeAttempt === attempt) {
        this.activeAttempt = undefined;
        this.publish({ activeWorkerPid: undefined });
      }
      if (this.closedFlag) {
        this.publish({ state: "closed", partial: false, errors: [], activeWorkerPid: undefined });
        return;
      }
      const reason = this.queuedReason ?? "after delayed worker termination confirmation";
      this.queuedReason = undefined;
      queueMicrotask(() => this.requestRefresh(reason));
    }, () => {});
  }

  private async finishClose(attempt: ConfigWatchSnapshotAttempt): Promise<void> {
    if (await this.terminateAttempt(attempt)) {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      if (this.terminationBlockedAttempt === attempt) this.terminationBlockedAttempt = undefined;
      this.publish({ state: "closed", partial: false, errors: [], activeWorkerPid: undefined });
      return;
    }
    this.handleTerminationFailure(attempt);
    const pid = attempt.pid ?? "unknown";
    throw new Error(`termination_failed: Manager watch snapshot worker ${pid} remains active after close deadlines.`);
  }

  private terminateAttempt(attempt: ConfigWatchSnapshotAttempt): Promise<boolean> {
    const active = this.terminationAttempts.get(attempt);
    if (active) return active;
    const termination = (async () => {
      attempt.terminate("SIGTERM");
      if (await closesWithin(attempt.closed, this.options.terminationCloseTimeoutMs)) return true;
      attempt.terminate("SIGKILL");
      return closesWithin(attempt.closed, this.options.forceTerminationCloseTimeoutMs);
    })();
    this.terminationAttempts.set(attempt, termination);
    return termination;
  }
}
