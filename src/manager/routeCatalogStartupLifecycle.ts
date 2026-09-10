import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import type { GatewayConfigFile, GatewayDefinition } from "../shared/gatewayConfigModel.js";
import {
  type RouteCatalogChildResult,
  type RouteCatalogSnapshot,
  type RouteCatalogTransactionInput,
  type RouteCatalogTransactionOperation
} from "./routeCatalogTransaction.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

export const ROUTE_CATALOG_STARTUP_ERROR_CODE = "ROUTE_CATALOG_STARTUP_FAILED";
export const ROUTE_CATALOG_STARTUP_TIMEOUT_CODE = "ROUTE_CATALOG_STARTUP_TIMEOUT";
export const ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE = "ROUTE_CATALOG_TERMINATION_UNCONFIRMED";

export type RouteCatalogStartupErrorCode =
  | typeof ROUTE_CATALOG_STARTUP_ERROR_CODE
  | typeof ROUTE_CATALOG_STARTUP_TIMEOUT_CODE
  | typeof ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE;

export type RouteCatalogStartupLifecycleState =
  | "idle"
  | "running"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped";

export type RouteCatalogStartupLifecycleSnapshot = Readonly<{
  state: RouteCatalogStartupLifecycleState;
  attempt: number;
  incidents: number;
  lastTransitionAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  nextRetryAt?: string;
  childPid?: number;
  lastErrorCode?: RouteCatalogStartupErrorCode;
  contentHash?: string;
  routeConfigHash?: string;
  presentationHash?: string;
  revision?: number;
}>;

export type RouteCatalogAttemptIdentity = Readonly<{
  requestId: string;
  attemptToken: string;
  operationId: string;
}>;

export type RouteCatalogStartupAttempt = Readonly<{
  pid?: number;
  result: Promise<RouteCatalogSnapshot>;
  cancel(): Promise<void>;
}>;

type RouteCatalogInput = Omit<
  RouteCatalogTransactionInput,
  "operation" | "requestId" | "attemptToken" | "operationId"
>;

export type RouteCatalogStartupLifecycleOptions = Readonly<{
  input?: () => RouteCatalogInput;
  apply(snapshot: RouteCatalogSnapshot): void | Promise<void>;
  attemptTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  maxPending?: number;
  terminateTimeoutMs?: number;
  attemptFactory?: (
    operation: RouteCatalogTransactionOperation,
    identity: RouteCatalogAttemptIdentity
  ) => RouteCatalogStartupAttempt;
  onStatus?: (snapshot: RouteCatalogStartupLifecycleSnapshot) => void;
  onFailure?: (error: Error, snapshot: RouteCatalogStartupLifecycleSnapshot) => void;
}>;

type AttemptToken = {
  attempt: RouteCatalogStartupAttempt;
  identity: RouteCatalogAttemptIdentity;
  sequence: number;
  settled: boolean;
  exitConfirmed?: boolean;
  exitObserverAttached?: boolean;
  timeout?: NodeJS.Timeout;
};

type QueueEntry = {
  requestId: string;
  operationId: string;
  operation: RouteCatalogTransactionOperation;
  attempts: number;
  resolve(snapshot: RouteCatalogSnapshot): void;
  reject(error: Error): void;
};

class RouteCatalogTerminationUnconfirmedError extends Error {
  constructor(pid?: number) {
    super(`Route catalog child exit could not be confirmed: pid=${pid ?? "unknown"}`);
    this.name = "RouteCatalogTerminationUnconfirmedError";
  }
}

export class RouteCatalogOperationError extends Error {
  readonly code: "ROUTE_CATALOG_REVISION_CONFLICT"
    | "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT"
    | "ROUTE_CATALOG_BUSY"
    | "ROUTE_CATALOG_TRANSACTION_FAILED";

  constructor(
    code: RouteCatalogOperationError["code"],
    message: string
  ) {
    super(message);
    this.name = "RouteCatalogOperationError";
    this.code = code;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function reportObserverFailure(error: unknown): void {
  console.error("Route catalog startup lifecycle observer failed.", error);
}

function cloneSnapshot(snapshot: RouteCatalogSnapshot): RouteCatalogSnapshot {
  return Object.freeze({
    requestId: snapshot.requestId,
    attemptToken: snapshot.attemptToken,
    contentHash: snapshot.contentHash,
    routeConfigHash: snapshot.routeConfigHash,
    presentationHash: snapshot.presentationHash,
    routeRoot: snapshot.routeRoot,
    rolesRoot: snapshot.rolesRoot,
    gateways: Object.freeze(structuredClone([...snapshot.gateways])),
    personas: Object.freeze(structuredClone([...snapshot.personas]))
  });
}

function validateSnapshot(
  value: unknown,
  expected?: Pick<RouteCatalogAttemptIdentity, "requestId" | "attemptToken">
): RouteCatalogSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Route catalog child returned an invalid snapshot.");
  }
  const candidate = value as Partial<RouteCatalogSnapshot>;
  if (typeof candidate.requestId !== "string" || !candidate.requestId.trim()) {
    throw new Error("Route catalog child snapshot is missing requestId.");
  }
  if (typeof candidate.attemptToken !== "string" || !candidate.attemptToken.trim()) {
    throw new Error("Route catalog child snapshot is missing attemptToken.");
  }
  if (expected && (
    candidate.requestId !== expected.requestId
    || candidate.attemptToken !== expected.attemptToken
  )) {
    throw new Error("Route catalog child snapshot identity did not match the active attempt.");
  }
  if (
    typeof candidate.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.contentHash)
    || typeof candidate.routeConfigHash !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.routeConfigHash)
    || typeof candidate.presentationHash !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.presentationHash)
  ) {
    throw new Error("Route catalog child snapshot is missing canonical SHA-256 identities.");
  }
  if (typeof candidate.routeRoot !== "string" || !candidate.routeRoot.trim()) {
    throw new Error("Route catalog child snapshot is missing routeRoot.");
  }
  if (typeof candidate.rolesRoot !== "string" || !candidate.rolesRoot.trim()) {
    throw new Error("Route catalog child snapshot is missing rolesRoot.");
  }
  if (!Array.isArray(candidate.gateways)) {
    throw new Error("Route catalog child snapshot is missing gateways.");
  }
  for (const definition of candidate.gateways) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error("Route catalog child returned an invalid gateway definition.");
    }
    if (
      typeof (definition as Partial<GatewayDefinition>).id !== "string"
      || !(definition as GatewayDefinition).id.trim()
    ) {
      throw new Error("Route catalog child returned a gateway without an id.");
    }
  }
  if (!Array.isArray(candidate.personas)) {
    throw new Error("Route catalog child snapshot is missing persona presentations.");
  }
  for (const persona of candidate.personas) {
    if (!persona || typeof persona !== "object" || Array.isArray(persona)) {
      throw new Error("Route catalog child returned an invalid persona presentation.");
    }
    const item = persona as Record<string, unknown>;
    if (
      typeof item.rolesRoot !== "string"
      || !item.rolesRoot.trim()
      || typeof item.roleId !== "string"
      || !item.roleId.trim()
      || typeof item.displayName !== "string"
      || typeof item.isPersona !== "boolean"
      || typeof item.avatarConfigured !== "boolean"
      || (item.avatarVersion !== undefined && typeof item.avatarVersion !== "string")
    ) {
      throw new Error("Route catalog child returned an invalid persona presentation.");
    }
  }
  const expectedIdentities = routeCatalogSnapshotIdentities({
    routeRoot: candidate.routeRoot,
    rolesRoot: candidate.rolesRoot,
    gateways: candidate.gateways,
    personas: candidate.personas
  });
  if (
    candidate.routeConfigHash !== expectedIdentities.routeConfigHash
    || candidate.presentationHash !== expectedIdentities.presentationHash
    || candidate.contentHash !== expectedIdentities.contentHash
  ) {
    throw new Error("Route catalog child snapshot identities did not match their canonical payloads.");
  }
  return cloneSnapshot(candidate as RouteCatalogSnapshot);
}

export function createRouteCatalogStartupAttempt(
  input: RouteCatalogTransactionInput & Readonly<{ terminateTimeoutMs?: number }>
): RouteCatalogStartupAttempt {
  const childPath = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./routeCatalogStartupChild.ts" : "./routeCatalogStartupChild.js",
    import.meta.url
  ));
  const child = fork(childPath, [], {
    env: {
      ...process.env,
      RABIROUTE_ROUTE_CATALOG_STARTUP_INPUT: Buffer.from(JSON.stringify(input), "utf8").toString("base64url")
    },
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let diagnosticBytes = 0;
  let childResult: RouteCatalogChildResult | undefined;
  let processFailed = false;
  let closed = false;
  const closeListeners = new Set<() => void>();
  const captureDiagnostic = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8");
    diagnosticBytes = Math.min(Number.MAX_SAFE_INTEGER, diagnosticBytes + bytes);
  };
  child.stdout?.on("data", captureDiagnostic);
  child.stderr?.on("data", captureDiagnostic);
  child.on("message", message => { childResult = message as RouteCatalogChildResult; });
  child.on("error", () => { processFailed = true; });

  const result = new Promise<RouteCatalogSnapshot>((resolve, reject) => {
    child.once("close", (code, signal) => {
      closed = true;
      for (const listener of [...closeListeners]) listener();
      closeListeners.clear();
      if (processFailed) {
        reject(new RouteCatalogOperationError(
          "ROUTE_CATALOG_TRANSACTION_FAILED",
          "Route catalog child process failed."
        ));
        return;
      }
      if (childResult?.ok === true && code === 0) {
        try {
          resolve(validateSnapshot(childResult.snapshot, {
            requestId: input.requestId,
            attemptToken: input.attemptToken
          }));
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (childResult?.ok === false) {
        const errorCode = childResult.errorCode === "revision_conflict"
          ? "ROUTE_CATALOG_REVISION_CONFLICT"
          : childResult.errorCode === "idempotency_conflict"
            ? "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT"
            : "ROUTE_CATALOG_TRANSACTION_FAILED";
        const message = errorCode === "ROUTE_CATALOG_REVISION_CONFLICT"
          ? "Route catalog revision does not match the current state."
          : errorCode === "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT"
            ? "Route catalog idempotency key conflicts with an earlier payload."
            : "Route catalog transaction failed.";
        reject(new RouteCatalogOperationError(
          errorCode,
          message + (diagnosticBytes > 0 ? ` Diagnostic bytes: ${diagnosticBytes}.` : "")
        ));
        return;
      }
      reject(new RouteCatalogOperationError(
        "ROUTE_CATALOG_TRANSACTION_FAILED",
        `Route catalog child exited without a valid result: code=${code ?? "none"}; signal=${signal ?? "none"}`
        + (diagnosticBytes > 0 ? `; diagnosticBytes=${diagnosticBytes}` : "")
      ));
    });
  });

  const waitForClose = (timeoutMs: number): Promise<boolean> => {
    if (closed || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const onClose = (): void => {
        clearTimeout(timer);
        closeListeners.delete(onClose);
        resolve(true);
      };
      const timer = setTimeout(() => {
        closeListeners.delete(onClose);
        resolve(closed || child.exitCode !== null || child.signalCode !== null);
      }, timeoutMs);
      timer.unref();
      closeListeners.add(onClose);
    });
  };

  let cancelFlight: Promise<void> | undefined;
  return Object.freeze({
    pid: child.pid,
    result,
    cancel(): Promise<void> {
      if (cancelFlight) return cancelFlight;
      cancelFlight = (async () => {
        const timeoutMs = positiveInteger(input.terminateTimeoutMs, 5_000);
        if (await waitForClose(1)) return;
        child.kill("SIGTERM");
        if (await waitForClose(timeoutMs)) return;
        child.kill("SIGKILL");
        if (!await waitForClose(timeoutMs)) {
          throw new RouteCatalogTerminationUnconfirmedError(child.pid);
        }
      })();
      return cancelFlight;
    }
  });
}

export class RouteCatalogStartupLifecycle {
  private applicationFlight: Promise<void> | undefined;
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly maxPending: number;
  private readonly terminateTimeoutMs: number;
  private readonly attemptFactory: (
    operation: RouteCatalogTransactionOperation,
    identity: RouteCatalogAttemptIdentity
  ) => RouteCatalogStartupAttempt;
  private readonly readyListeners = new Set<(snapshot: RouteCatalogSnapshot) => void>();
  private readonly queue: QueueEntry[] = [];
  private currentAttempt: AttemptToken | undefined;
  private activeEntry: QueueEntry | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private cleanupFlight: Promise<void> | undefined;
  private stopFlight: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private hardBlocked = false;
  private revision = 0;
  private latestCatalog: RouteCatalogSnapshot | undefined;
  private runtimeSnapshot: RouteCatalogStartupLifecycleSnapshot;

  constructor(private readonly options: RouteCatalogStartupLifecycleOptions) {
    this.attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 30_000);
    this.retryBaseMs = positiveInteger(options.retryBaseMs, 5_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(options.retryMaxMs, 60_000));
    this.maxAttempts = positiveInteger(options.maxAttempts, 5);
    this.maxPending = positiveInteger(options.maxPending, 32);
    this.terminateTimeoutMs = positiveInteger(options.terminateTimeoutMs, 5_000);
    this.attemptFactory = options.attemptFactory ?? ((operation, identity) => {
      if (!options.input) throw new Error("Route catalog lifecycle input is missing.");
      return createRouteCatalogStartupAttempt({
        ...options.input(),
        ...identity,
        operation,
        terminateTimeoutMs: this.terminateTimeoutMs
      });
    });
    this.runtimeSnapshot = Object.freeze({
      state: "idle",
      attempt: 0,
      incidents: 0,
      lastTransitionAt: new Date().toISOString()
    });
  }

  snapshot(): RouteCatalogStartupLifecycleSnapshot {
    return Object.freeze({ ...this.runtimeSnapshot });
  }

  catalog(): RouteCatalogSnapshot | undefined {
    return this.latestCatalog ? cloneSnapshot(this.latestCatalog) : undefined;
  }

  onReady(listener: (snapshot: RouteCatalogSnapshot) => void): () => void {
    this.readyListeners.add(listener);
    if (this.runtimeSnapshot.state === "ready" && this.latestCatalog) {
      const catalog = cloneSnapshot(this.latestCatalog);
      queueMicrotask(() => {
        if (!this.readyListeners.has(listener)) return;
        try {
          listener(catalog);
        } catch (error) {
          reportObserverFailure(error);
        }
      });
    }
    return () => this.readyListeners.delete(listener);
  }

  start(): void {
    if (this.started || this.stopped || this.hardBlocked) return;
    this.started = true;
    void this.enqueue({ kind: "capture" }).catch(() => {});
  }

  recapture(operationId?: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "capture" }, operationId);
  }

  replace(config: GatewayConfigFile, expectedContentHash?: string, operationId?: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({
      kind: "replace",
      config: structuredClone(config),
      expectedContentHash
    }, operationId);
  }

  upsert(definition: GatewayDefinition, expectedContentHash?: string, operationId?: string, previousId?: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({
      kind: "upsert",
      definition: structuredClone(definition),
      ...(previousId ? { previousId } : {}),
      expectedContentHash
    }, operationId);
  }

  resolveMutation(operationId: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "capture", resolveOperationId: operationId });
  }

  remove(routeId: string, expectedContentHash?: string, operationId?: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "remove", routeId, expectedContentHash }, operationId);
  }

  ensurePersona(roleId: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "ensure_persona", roleId });
  }

  ensureRoleFile(roleId: string, roleFile: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "ensure_role_file", roleId, roleFile });
  }

  ensureRoleFolder(roleId: string): Promise<RouteCatalogSnapshot> {
    return this.enqueue({ kind: "ensure_role_folder", roleId });
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    if (this.runtimeSnapshot.state === "stopped") return Promise.resolve();
    const flight = this.stopOnce().finally(() => {
      if (this.stopFlight === flight) this.stopFlight = undefined;
    });
    this.stopFlight = flight;
    return flight;
  }

  private enqueue(operation: RouteCatalogTransactionOperation, operationIdValue?: string): Promise<RouteCatalogSnapshot> {
    if (this.stopped || this.runtimeSnapshot.state === "stopped" || this.runtimeSnapshot.state === "stopping") {
      return Promise.reject(new Error("Route catalog lifecycle is stopped."));
    }
    if (this.hardBlocked) {
      return Promise.reject(new Error(
        "Route catalog lifecycle is blocked because child termination was not confirmed."
      ));
    }
    const pendingCount = this.queue.length + (this.activeEntry ? 1 : 0);
    if (pendingCount >= this.maxPending) {
      return Promise.reject(new RouteCatalogOperationError(
        "ROUTE_CATALOG_BUSY",
        "Route catalog transaction queue is full."
      ));
    }
    const operationId = String(operationIdValue || "").trim() || randomUUID();
    if (!/^[A-Za-z0-9:._-]{1,256}$/.test(operationId)) {
      return Promise.reject(new RouteCatalogOperationError(
        "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT",
        "Route catalog operationId is invalid."
      ));
    }
    const isMutation = operation.kind !== "capture";
    const startedAt = Date.now();
    const targetId = operation.kind === "replace"
      ? "catalog"
      : operation.kind === "upsert"
        ? operation.definition.id
        : operation.kind === "remove"
          ? operation.routeId
          : "roleId" in operation ? operation.roleId : "catalog";
    const dataSourceId = operation.kind === "replace" || operation.kind === "upsert" || operation.kind === "remove"
      ? "config/gateways.json"
      : `roles/${"roleId" in operation ? operation.roleId : "unknown"}`;
    const expectedContentHash = operation.kind === "replace" || operation.kind === "upsert" || operation.kind === "remove"
      ? operation.expectedContentHash
      : undefined;
    if (isMutation) {
      recordDataMutationAudit({
        group: operation.kind.startsWith("ensure_") ? "persona" : "route",
        event: "route_catalog_mutation_queued",
        owner: "route-catalog",
        action: operation.kind,
        target: { type: operation.kind.startsWith("ensure_") ? "persona" : "route", id: targetId },
        dataSource: { kind: "file", id: dataSourceId },
        outcome: "queued",
        operationId,
        before: expectedContentHash ? { digest: expectedContentHash } : undefined
      });
    }
    const promise = new Promise<RouteCatalogSnapshot>((resolve, reject) => {
      this.queue.push({
        requestId: randomUUID(),
        operationId,
        operation,
        attempts: 0,
        resolve,
        reject
      });
    });
    this.pump();
    if (!isMutation) return promise;
    return promise.then(snapshot => {
      recordDataMutationAudit({
        group: operation.kind.startsWith("ensure_") ? "persona" : "route",
        event: "route_catalog_mutation_committed",
        owner: "route-catalog",
        action: operation.kind,
        target: { type: operation.kind.startsWith("ensure_") ? "persona" : "route", id: targetId },
        dataSource: { kind: "file", id: dataSourceId },
        outcome: "committed",
        operationId,
        before: expectedContentHash ? { digest: expectedContentHash } : undefined,
        after: { digest: snapshot.contentHash, revision: snapshot.routeConfigHash },
        durationMs: Date.now() - startedAt
      });
      return snapshot;
    }, error => {
      const rejected = error instanceof RouteCatalogOperationError
        && (error.code === "ROUTE_CATALOG_REVISION_CONFLICT" || error.code === "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT");
      recordDataMutationAudit({
        level: rejected ? "warn" : "error",
        group: operation.kind.startsWith("ensure_") ? "persona" : "route",
        event: "route_catalog_mutation_failed",
        owner: "route-catalog",
        action: operation.kind,
        target: { type: operation.kind.startsWith("ensure_") ? "persona" : "route", id: targetId },
        dataSource: { kind: "file", id: dataSourceId },
        outcome: rejected ? "rejected" : "failed",
        operationId,
        before: expectedContentHash ? { digest: expectedContentHash } : undefined,
        durationMs: Date.now() - startedAt,
        result: error instanceof RouteCatalogOperationError ? error.code : "route_catalog_transaction_failed",
        error
      });
      throw error;
    });
  }

  private pump(): void {
    if (this.stopped || this.hardBlocked || this.currentAttempt || this.cleanupFlight || this.retryTimer) return;
    if (!this.activeEntry) this.activeEntry = this.queue.shift();
    if (!this.activeEntry) return;
    this.startAttempt(this.activeEntry);
  }

  private startAttempt(entry: QueueEntry): void {
    if (this.stopped || this.hardBlocked || this.currentAttempt) return;
    entry.attempts += 1;
    const sequence = this.runtimeSnapshot.attempt + 1;
    const identity = Object.freeze({
      requestId: entry.requestId,
      attemptToken: randomUUID(),
      operationId: entry.operationId
    });
    let attempt: RouteCatalogStartupAttempt;
    try {
      attempt = this.attemptFactory(entry.operation, identity);
    } catch (error) {
      this.failEntry(
        entry,
        error instanceof Error ? error : new Error(String(error)),
        ROUTE_CATALOG_STARTUP_ERROR_CODE
      );
      return;
    }
    const startedAt = new Date();
    const token: AttemptToken = { attempt, identity, sequence, settled: false };
    this.currentAttempt = token;
    this.transition({
      state: "running",
      attempt: sequence,
      incidents: Math.max(0, entry.attempts - 1),
      startedAt: startedAt.toISOString(),
      completedAt: undefined,
      deadlineAt: new Date(startedAt.getTime() + this.attemptTimeoutMs).toISOString(),
      nextRetryAt: undefined,
      childPid: attempt.pid,
      lastErrorCode: undefined
    });
    token.timeout = setTimeout(() => {
      if (token.settled || this.currentAttempt !== token) return;
      this.cleanupFailedAttempt(
        token,
        entry,
        new Error(`Route catalog attempt timed out after ${this.attemptTimeoutMs}ms.`),
        ROUTE_CATALOG_STARTUP_TIMEOUT_CODE
      );
    }, this.attemptTimeoutMs);
    token.timeout.unref();
    void attempt.result.then(async snapshot => {
      if (token.settled || this.currentAttempt !== token || this.stopped) return;
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      this.currentAttempt = undefined;
      try {
        const validated = validateSnapshot(snapshot, token.identity);
        const application = Promise.resolve(this.options.apply(validated));
        this.applicationFlight = application;
        try { await application; } finally { if (this.applicationFlight === application) this.applicationFlight = undefined; }
        if (this.stopped) return;
        this.latestCatalog = cloneSnapshot(validated);
        this.completeEntry(entry, validated);
      } catch (error) {
        this.failEntry(
          entry,
          error instanceof Error ? error : new Error(String(error)),
          ROUTE_CATALOG_STARTUP_ERROR_CODE
        );
      }
    }).catch(error => {
      if (token.settled || this.currentAttempt !== token || this.stopped) return;
      this.cleanupFailedAttempt(
        token,
        entry,
        error instanceof Error ? error : new Error(String(error)),
        ROUTE_CATALOG_STARTUP_ERROR_CODE
      );
    });
  }

  private cleanupFailedAttempt(
    token: AttemptToken,
    entry: QueueEntry,
    error: Error,
    errorCode: RouteCatalogStartupErrorCode
  ): void {
    if (token.settled || this.currentAttempt !== token) return;
    token.settled = true;
    if (token.timeout) clearTimeout(token.timeout);
    const cleanup = Promise.resolve()
      .then(() => token.attempt.cancel())
      .then(() => {
        if (this.currentAttempt === token) this.currentAttempt = undefined;
        if (!this.stopped) this.failEntry(entry, error, errorCode);
      })
      .catch(terminationError => {
        const normalized = terminationError instanceof Error
          ? terminationError
          : new Error(String(terminationError));
        if (this.stopped) {
          this.observeLateAttemptExit(token);
          throw normalized;
        }
        this.blockAfterUnconfirmedTermination(token, entry, normalized);
      });
    const tracked = cleanup.finally(() => {
      if (this.cleanupFlight === tracked) this.cleanupFlight = undefined;
      this.pump();
    });
    this.cleanupFlight = tracked;
  }

  private completeEntry(entry: QueueEntry, snapshot: RouteCatalogSnapshot): void {
    if (this.activeEntry !== entry) return;
    this.activeEntry = undefined;
    this.revision += 1;
    this.transition({
      state: "ready",
      incidents: 0,
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      nextRetryAt: undefined,
      childPid: undefined,
      lastErrorCode: undefined,
      contentHash: snapshot.contentHash,
      routeConfigHash: snapshot.routeConfigHash,
      presentationHash: snapshot.presentationHash,
      revision: this.revision
    });
    entry.resolve(cloneSnapshot(snapshot));
    for (const listener of [...this.readyListeners]) {
      try {
        listener(cloneSnapshot(snapshot));
      } catch (error) {
        reportObserverFailure(error);
      }
    }
    queueMicrotask(() => this.pump());
  }

  private failEntry(
    entry: QueueEntry,
    error: Error,
    errorCode: RouteCatalogStartupErrorCode
  ): void {
    if (this.stopped || this.activeEntry !== entry) return;
    if (
      error instanceof RouteCatalogOperationError
      && error.code === "ROUTE_CATALOG_REVISION_CONFLICT"
    ) {
      this.activeEntry = undefined;
      this.transition({
        state: this.latestCatalog ? "ready" : "degraded",
        incidents: 0,
        completedAt: new Date().toISOString(),
        deadlineAt: undefined,
        nextRetryAt: undefined,
        childPid: undefined,
        lastErrorCode: undefined,
        contentHash: this.latestCatalog?.contentHash,
        routeConfigHash: this.latestCatalog?.routeConfigHash,
        presentationHash: this.latestCatalog?.presentationHash,
        revision: this.revision
      });
      entry.reject(error);
      queueMicrotask(() => this.pump());
      return;
    }
    const canRetry = entry.attempts < this.maxAttempts;
    const exponent = Math.max(0, Math.min(20, entry.attempts - 1));
    const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    this.transition({
      state: "degraded",
      incidents: entry.attempts,
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      nextRetryAt: canRetry ? new Date(Date.now() + retryMs).toISOString() : undefined,
      childPid: undefined,
      lastErrorCode: errorCode
    });
    try {
      this.options.onFailure?.(error, this.snapshot());
    } catch (observerError) {
      reportObserverFailure(observerError);
    }
    if (!canRetry) {
      this.activeEntry = undefined;
      entry.reject(error);
      queueMicrotask(() => this.pump());
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt(entry);
    }, retryMs);
    this.retryTimer.unref();
  }

  private blockAfterUnconfirmedTermination(token: AttemptToken, entry: QueueEntry, error: Error): void {
    this.hardBlocked = true;
    this.activeEntry = undefined;
    this.transition({
      state: "degraded",
      incidents: Math.max(1, entry.attempts),
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      nextRetryAt: undefined,
      childPid: token.attempt.pid,
      lastErrorCode: ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE
    });
    try {
      this.options.onFailure?.(error, this.snapshot());
    } catch (observerError) {
      reportObserverFailure(observerError);
    }
    entry.reject(error);
    while (this.queue.length > 0) this.queue.shift()?.reject(error);
    this.observeLateAttemptExit(token);
  }

  private observeLateAttemptExit(token: AttemptToken): void {
    if (token.exitObserverAttached) return;
    token.exitObserverAttached = true;
    void token.attempt.result.catch(() => {}).finally(() => {
      token.exitConfirmed = true;
      if (this.currentAttempt === token) this.currentAttempt = undefined;
      if (this.runtimeSnapshot.state !== "stopped") {
        this.transition({ childPid: undefined });
      }
    });
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.transition({ state: "stopping", incidents: 0, nextRetryAt: undefined });
    const stoppedError = new Error("Route catalog lifecycle stopped.");
    while (this.queue.length > 0) this.queue.shift()?.reject(stoppedError);
    this.activeEntry?.reject(stoppedError);
    this.activeEntry = undefined;
    let cleanupError: Error | undefined;
    if (this.cleanupFlight) {
      try {
        await this.cleanupFlight;
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        if (this.currentAttempt) this.observeLateAttemptExit(this.currentAttempt);
      }
    }
    const token = this.currentAttempt;
    if (token && !token.exitConfirmed) {
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      try {
        await token.attempt.cancel();
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        this.observeLateAttemptExit(token);
      } finally {
        if (!cleanupError && this.currentAttempt === token) this.currentAttempt = undefined;
      }
    }
    await this.applicationFlight?.catch(() => undefined);
    this.readyListeners.clear();
    if (cleanupError) {
      this.transition({
        state: "degraded",
        incidents: Math.max(1, this.runtimeSnapshot.incidents),
        completedAt: new Date().toISOString(),
        deadlineAt: undefined,
        nextRetryAt: undefined,
        childPid: token?.attempt.pid,
        lastErrorCode: ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE
      });
      throw cleanupError;
    }
    this.transition({
      state: "stopped",
      incidents: 0,
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      nextRetryAt: undefined,
      childPid: undefined,
      lastErrorCode: undefined
    });
  }

  private transition(patch: Partial<RouteCatalogStartupLifecycleSnapshot>): void {
    this.runtimeSnapshot = Object.freeze({
      ...this.runtimeSnapshot,
      ...patch,
      lastTransitionAt: new Date().toISOString()
    });
    try {
      this.options.onStatus?.(this.snapshot());
    } catch (error) {
      reportObserverFailure(error);
    }
  }
}
