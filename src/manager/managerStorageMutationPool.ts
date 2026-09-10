import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MemoryConsolidationRequest,
  MemoryConsolidationRun,
  PlanItem,
  PlanSecretaryBinding,
  PlanTaskBinding,
  RecentMemoryItem,
  CreateMemoryConsolidationRequestOptions
} from "../roleKnowledge.js";
import type {
  PlanFeedbackDeliveryStatus,
  PlanFeedbackPostCommit,
  PlanFeedbackRecord,
  PlanQaFeedbackHandling
} from "../planFeedback.js";
import type { SubmitPlanFeedbackInput, SubmitPlanFeedbackResult } from "../planFeedbackSubmission.js";
import type { RolePanelTimelineAppendResult, RolePanelTimelineMessage } from "../rolePanelTimeline.js";
import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  canonicalStorageMutationPlanId,
  canonicalStorageMutationRoleId,
  sameManagerStorageMutationFence,
  storageMutationRoleDirectory,
  type ManagerStorageMutationChildIdentity,
  type ManagerStorageMutationFence,
  type ManagerStorageMutationRequest,
  type ManagerStorageMutationResponse,
  type ManagerStorageMutationTask
} from "./managerStorageMutationProtocol.js";

type ChildDiagnosticStream = Readonly<{
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  destroy(): void;
}>;

export type ManagerStorageMutationChild = {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected: boolean;
  readonly stdout?: ChildDiagnosticStream | null;
  readonly stderr?: ChildDiagnosticStream | null;
  readonly channel?: { unref?(): void } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
  unref(): void;
};

export type ManagerStorageMutationPoolOptions = Readonly<{
  rolesRoot: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  timeoutMs?: number;
  terminationTimeoutMs?: number;
  forceTerminationTimeoutMs?: number;
  maxQueue?: number;
  childFactory?: (identity: ManagerStorageMutationChildIdentity) => ManagerStorageMutationChild;
  storageGenerationLeaseFactory?: (identity: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>) => string;
}>;

export type ManagerStorageMutationPoolStatus = Readonly<{
  state: "idle" | "running" | "blocked" | "stopping" | "stopped";
  active: number;
  queued: number;
  childPid?: number;
  spawnedChildren: number;
  applicationGenerationId: string;
  managerInstanceId: string;
  storageGenerationLease: string;
  lastErrorCode?: ManagerStorageMutationError["code"];
}>;

export type ManagerStorageMutationOptions = Readonly<{
  idempotencyKey: string;
  expectedRevision: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

type PendingMutation<T = unknown> = {
  roleId: string;
  planId?: string;
  idempotencyKey: string;
  expectedRevision: string | null;
  task: ManagerStorageMutationTask;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve(value: T): void;
  reject(error: Error): void;
  abortListener?: () => void;
};

type ChildSlot = {
  child: ManagerStorageMutationChild;
  closed: boolean;
  closePromise: Promise<void>;
  resolveClosed(): void;
  terminationFlight?: Promise<boolean>;
  diagnosticBytes: number;
  captureDiagnostic(chunk: Buffer | string): void;
};

type ActiveMutation = {
  slot: ChildSlot;
  pending: PendingMutation;
  request: ManagerStorageMutationRequest;
  timer: NodeJS.Timeout;
  abortListener?: () => void;
  terminating: boolean;
};

export class ManagerStorageMutationError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "timeout" | "aborted" | "worker_failed" | "mutation_failed" | "revision_conflict"
      | "idempotency_conflict" | "indeterminate" | "fence_mismatch" | "termination_unconfirmed" | "stopped" | "validation_rejected"
  ) {
    super(message);
    this.name = "ManagerStorageMutationError";
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function requiredIdentityText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 256) throw new Error(`${label} is required and must be at most 256 characters.`);
  return text;
}

function childEntryPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./managerStorageMutationChild.ts" : "./managerStorageMutationChild.js",
    import.meta.url
  ));
}

function childExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function spawnStorageMutationChild(identity: ManagerStorageMutationChildIdentity): ManagerStorageMutationChild {
  return fork(childEntryPath(), [], {
    env: {
      ...process.env,
      RABIROUTE_APPLICATION_GENERATION_ID: identity.applicationGenerationId,
      RABIROUTE_MANAGER_INSTANCE_ID: identity.managerInstanceId,
      RABIROUTE_STORAGE_GENERATION_LEASE: identity.storageGenerationLease,
      RABIROUTE_STORAGE_ROLES_ROOT: identity.rolesRoot,
      RABIROUTE_MANAGER_STORAGE_MUTATION_PROCESS: "1"
    },
    execArgv: childExecArgv(),
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  }) as ManagerStorageMutationChild;
}

function closesWithin(slot: ChildSlot, timeoutMs: number): Promise<boolean> {
  if (slot.closed) return Promise.resolve(true);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    slot.closePromise.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function cloneSerializable<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Storage mutation payload is not JSON serializable.");
  return JSON.parse(encoded) as T;
}

function mutationResponseError(message: string): ManagerStorageMutationError {
  if (message.startsWith("STORAGE_MUTATION_VALIDATION_REJECTED:")) {
    return new ManagerStorageMutationError(message.slice("STORAGE_MUTATION_VALIDATION_REJECTED:".length).trim(), "validation_rejected");
  }
  if (message.startsWith("STORAGE_MUTATION_REVISION_CONFLICT:")
    || message.startsWith("PERSONA_PLAN_WORKFLOW_REVISION_CONFLICT:")) {
    return new ManagerStorageMutationError(message, "revision_conflict");
  }
  if (message.startsWith("STORAGE_MUTATION_CONFLICT:")) {
    return new ManagerStorageMutationError(message, "idempotency_conflict");
  }
  if (message.startsWith("STORAGE_MUTATION_UNCERTAIN:") || message.startsWith("STORAGE_MUTATION_IN_PROGRESS:")) {
    return new ManagerStorageMutationError(message, "indeterminate");
  }
  return new ManagerStorageMutationError(message, "mutation_failed");
}

export class ManagerStorageMutationPool {
  private readonly identity: ManagerStorageMutationChildIdentity;
  private readonly timeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly forceTerminationTimeoutMs: number;
  private readonly maxQueue: number;
  private readonly childFactory: (identity: ManagerStorageMutationChildIdentity) => ManagerStorageMutationChild;
  private readonly queue: PendingMutation[] = [];
  private childSlot?: ChildSlot;
  private blockedSlot?: ChildSlot;
  private activeMutation?: ActiveMutation;
  private accepting = true;
  private stateValue: ManagerStorageMutationPoolStatus["state"] = "idle";
  private spawnedChildren = 0;
  private lastErrorCode?: ManagerStorageMutationError["code"];
  private stopFlight?: Promise<void>;

  constructor(options: ManagerStorageMutationPoolOptions) {
    const rolesRoot = path.resolve(requiredIdentityText(options.rolesRoot, "rolesRoot"));
    const applicationGenerationId = requiredIdentityText(
      options.applicationGenerationId,
      "applicationGenerationId"
    );
    const managerInstanceId = requiredIdentityText(options.managerInstanceId, "managerInstanceId");
    const identityTuple = Object.freeze({ applicationGenerationId, managerInstanceId });
    const storageGenerationLease = requiredIdentityText(
      (options.storageGenerationLeaseFactory ?? (identity => `storage-${createHash("sha256")
        .update(`${identity.applicationGenerationId}\u0000${identity.managerInstanceId}\u0000${randomUUID()}`)
        .digest("hex")}`))(identityTuple),
      "storageGenerationLease"
    );
    this.identity = Object.freeze({ rolesRoot, applicationGenerationId, managerInstanceId, storageGenerationLease });
    this.timeoutMs = positiveInteger(options.timeoutMs, 30_000);
    this.terminationTimeoutMs = positiveInteger(options.terminationTimeoutMs, 1_000);
    this.forceTerminationTimeoutMs = positiveInteger(options.forceTerminationTimeoutMs, 5_000);
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 32));
    this.childFactory = options.childFactory ?? spawnStorageMutationChild;
  }

  status(): ManagerStorageMutationPoolStatus {
    return Object.freeze({
      state: this.stateValue,
      active: this.activeMutation ? 1 : 0,
      queued: this.queue.length,
      childPid: this.blockedSlot?.child.pid ?? this.childSlot?.child.pid,
      spawnedChildren: this.spawnedChildren,
      applicationGenerationId: this.identity.applicationGenerationId,
      managerInstanceId: this.identity.managerInstanceId,
      storageGenerationLease: this.identity.storageGenerationLease,
      lastErrorCode: this.lastErrorCode
    });
  }

  execute<T>(
    roleIdValue: string,
    planIdValue: string | undefined,
    task: ManagerStorageMutationTask,
    options: ManagerStorageMutationOptions
  ): Promise<T> {
    if (!this.accepting || this.stateValue === "stopping" || this.stateValue === "stopped") {
      return Promise.reject(new ManagerStorageMutationError("Storage mutation pool is stopped.", "stopped"));
    }
    if (this.blockedSlot) {
      return Promise.reject(new ManagerStorageMutationError(
        `Storage mutation child termination is not confirmed: pid=${this.blockedSlot.child.pid ?? "unknown"}.`,
        "termination_unconfirmed"
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ManagerStorageMutationError("Storage mutation request was aborted.", "aborted"));
    }
    let roleId: string;
    let planId: string | undefined;
    try {
      roleId = canonicalStorageMutationRoleId(roleIdValue);
      storageMutationRoleDirectory(this.identity.rolesRoot, roleId);
      planId = planIdValue == null ? undefined : canonicalStorageMutationPlanId(planIdValue);
      cloneSerializable(task);
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(options.idempotencyKey || ""))) {
        throw new Error("Storage mutation idempotencyKey is invalid.");
      }
      if (options.expectedRevision !== null
        && (typeof options.expectedRevision !== "string"
          || !options.expectedRevision.trim()
          || options.expectedRevision.length > 256)) {
        throw new Error("Storage mutation expectedRevision is invalid.");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if ((this.activeMutation || this.queue.length > 0) && this.queue.length >= this.maxQueue) {
      return Promise.reject(new ManagerStorageMutationError("Storage mutation queue is full.", "busy"));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingMutation<T> = {
        roleId,
        planId,
        idempotencyKey: options.idempotencyKey,
        expectedRevision: options.expectedRevision,
        task: cloneSerializable(task),
        timeoutMs: positiveInteger(options.timeoutMs, this.timeoutMs),
        signal: options.signal,
        resolve,
        reject
      };
      if (pending.signal) {
        pending.abortListener = () => {
          const index = this.queue.indexOf(pending as PendingMutation);
          if (index < 0) return;
          this.queue.splice(index, 1);
          pending.reject(new ManagerStorageMutationError("Storage mutation request was aborted.", "aborted"));
        };
        pending.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.queue.push(pending as PendingMutation);
      this.drain();
    });
  }

  createPlan(
    roleId: string,
    planId: string,
    input: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<PlanItem> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.execute(roleId, canonicalPlanId, {
      type: "plan_create",
      input: { ...input, id: canonicalPlanId }
    }, options);
  }

  createPlanStatus(
    roleId: string,
    input: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<unknown> {
    return this.execute(roleId, undefined, { type: "plan_status_create", input }, options);
  }

  updatePlanStatus(
    roleId: string,
    statusKey: string,
    patch: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<unknown> {
    return this.execute(roleId, undefined, { type: "plan_status_update", statusKey, patch }, options);
  }

  deletePlanStatus(
    roleId: string,
    statusKey: string,
    replacementKey: string,
    options: ManagerStorageMutationOptions
  ): Promise<unknown> {
    return this.execute(roleId, undefined, { type: "plan_status_delete", statusKey, replacementKey }, options);
  }

  updatePlan(
    roleId: string,
    planId: string,
    patch: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<PlanItem> {
    return this.execute(roleId, planId, { type: "plan_update", patch }, options);
  }

  updatePlanSecretaryBinding(
    roleId: string,
    planId: string,
    binding: PlanSecretaryBinding | null,
    options: ManagerStorageMutationOptions
  ): Promise<PlanItem> {
    return this.execute(roleId, planId, { type: "plan_secretary_binding_update", binding }, options);
  }

  updatePlanTaskBinding(
    roleId: string,
    planId: string,
    binding: PlanTaskBinding | null,
    options: ManagerStorageMutationOptions
  ): Promise<PlanItem> {
    return this.execute(roleId, planId, { type: "plan_task_binding_update", binding }, options);
  }

  createRecentMemory(
    roleId: string,
    input: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<RecentMemoryItem> {
    return this.execute(roleId, undefined, { type: "recent_memory_create", input }, options);
  }

  updateRecentMemory(
    roleId: string,
    memoryId: string,
    patch: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<RecentMemoryItem> {
    return this.execute(roleId, undefined, { type: "recent_memory_update", memoryId, patch }, options);
  }

  touchRecentMemory(
    roleId: string,
    memoryId: string,
    options: ManagerStorageMutationOptions
  ): Promise<RecentMemoryItem> {
    return this.execute(roleId, undefined, { type: "recent_memory_touch", memoryId }, options);
  }

  requestMemoryConsolidation(
    roleId: string,
    input: CreateMemoryConsolidationRequestOptions,
    options: ManagerStorageMutationOptions
  ): Promise<MemoryConsolidationRequest> {
    return this.execute(roleId, undefined, { type: "memory_consolidation_request", options: input }, options);
  }

  markMemoryConsolidationDelivered(
    roleId: string,
    runId: string,
    options: ManagerStorageMutationOptions,
    deliveredAt?: string
  ): Promise<MemoryConsolidationRun> {
    return this.execute(roleId, undefined, {
      type: "memory_consolidation_mark_delivered",
      runId,
      deliveredAt
    }, options);
  }

  applyMemoryConsolidation(
    roleId: string,
    runId: string,
    body: Record<string, unknown>,
    options: ManagerStorageMutationOptions
  ): Promise<unknown> {
    return this.execute(roleId, undefined, { type: "memory_consolidation_apply", runId, body }, options);
  }

  submitPlanFeedback(
    roleId: string,
    planId: string,
    input: Omit<SubmitPlanFeedbackInput, "roleDir" | "roleId" | "planId">,
    options: ManagerStorageMutationOptions
  ): Promise<SubmitPlanFeedbackResult> {
    return this.execute(roleId, planId, { type: "plan_feedback_submit", input }, options);
  }

  updatePlanFeedbackDelivery(
    roleId: string,
    planId: string,
    record: PlanFeedbackRecord,
    deliveryStatus: Exclude<PlanFeedbackDeliveryStatus, "record_only">,
    options: ManagerStorageMutationOptions,
    deliveryMessage?: string
  ): Promise<PlanFeedbackRecord> {
    return this.execute(roleId, planId, {
      type: "plan_feedback_delivery_update",
      record,
      deliveryStatus,
      deliveryMessage
    }, options);
  }

  updatePlanFeedbackQaHandling(
    roleId: string,
    planId: string,
    record: PlanFeedbackRecord,
    qaHandling: PlanQaFeedbackHandling,
    options: ManagerStorageMutationOptions
  ): Promise<PlanFeedbackRecord> {
    return this.execute(roleId, planId, { type: "plan_feedback_qa_update", record, qaHandling }, options);
  }

  updatePlanFeedbackPostCommit(
    roleId: string,
    planId: string,
    record: PlanFeedbackRecord,
    status: PlanFeedbackPostCommit["status"],
    options: ManagerStorageMutationOptions,
    message?: string
  ): Promise<PlanFeedbackRecord> {
    return this.execute(roleId, planId, {
      type: "plan_feedback_post_commit_update",
      record,
      status,
      message
    }, options);
  }

  appendRolePanelTimeline(
    roleId: string,
    message: RolePanelTimelineMessage,
    options: ManagerStorageMutationOptions
  ): Promise<RolePanelTimelineAppendResult> {
    return this.execute(roleId, undefined, { type: "role_panel_timeline_append", message }, options);
  }

  stop(): Promise<void> {
    if (this.stateValue === "stopped") return Promise.resolve();
    if (this.stopFlight) return this.stopFlight;
    const flight = this.stopOnce();
    this.stopFlight = flight.catch(error => {
      this.stopFlight = undefined;
      throw error;
    });
    return this.stopFlight;
  }

  private async stopOnce(): Promise<void> {
    this.accepting = false;
    this.stateValue = "stopping";
    this.rejectQueue(new ManagerStorageMutationError("Storage mutation pool stopped.", "stopped"));
    const active = this.activeMutation;
    if (active) {
      active.terminating = true;
      this.clearActiveDeadline(active);
      const confirmed = await this.terminateAndConfirm(active.slot);
      if (!confirmed) {
        this.blockTermination(active.slot);
        this.settleActive(active, new ManagerStorageMutationError(
          `Storage mutation child termination was not confirmed during stop: pid=${active.slot.child.pid ?? "unknown"}.`,
          "termination_unconfirmed"
        ));
        throw new ManagerStorageMutationError(
          `Storage mutation pool cannot stop while child termination is unconfirmed: pid=${active.slot.child.pid ?? "unknown"}.`,
          "termination_unconfirmed"
        );
      }
      this.settleActive(active, new ManagerStorageMutationError("Storage mutation pool stopped.", "stopped"));
    }
    const slot = this.blockedSlot ?? this.childSlot;
    if (slot && !slot.closed) {
      const confirmed = await this.terminateAndConfirm(slot);
      if (!confirmed) {
        this.blockTermination(slot);
        throw new ManagerStorageMutationError(
          `Storage mutation pool cannot stop while child termination is unconfirmed: pid=${slot.child.pid ?? "unknown"}.`,
          "termination_unconfirmed"
        );
      }
    }
    if (this.activeMutation || this.blockedSlot || (this.childSlot && !this.childSlot.closed)) {
      throw new ManagerStorageMutationError("Storage mutation pool still owns child resources after stop.", "termination_unconfirmed");
    }
    this.stateValue = "stopped";
    this.lastErrorCode = undefined;
  }

  private drain(): void {
    if (!this.accepting || this.activeMutation || this.blockedSlot || this.stateValue === "stopping" || this.stateValue === "stopped") return;
    const pending = this.queue.shift();
    if (!pending) {
      this.stateValue = "idle";
      return;
    }
    if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
    if (pending.signal?.aborted) {
      pending.reject(new ManagerStorageMutationError("Storage mutation request was aborted.", "aborted"));
      queueMicrotask(() => this.drain());
      return;
    }
    let slot = this.childSlot;
    if (!slot || slot.closed) {
      try {
        slot = this.createChildSlot();
      } catch {
        pending.reject(new ManagerStorageMutationError(
          "Storage mutation child failed to start.",
          "worker_failed"
        ));
        queueMicrotask(() => this.drain());
        return;
      }
    }
    const fence: ManagerStorageMutationFence = Object.freeze({
      applicationGenerationId: this.identity.applicationGenerationId,
      managerInstanceId: this.identity.managerInstanceId,
      storageGenerationLease: this.identity.storageGenerationLease,
      roleId: pending.roleId,
      planId: pending.planId
    });
    const request: ManagerStorageMutationRequest = Object.freeze({
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: pending.idempotencyKey,
      fence,
      expectedRevision: pending.expectedRevision,
      task: pending.task
    });
    const active: ActiveMutation = {
      slot,
      pending,
      request,
      timer: undefined as unknown as NodeJS.Timeout,
      terminating: false
    };
    active.timer = setTimeout(() => {
      void this.terminateActive(active, new ManagerStorageMutationError(
        `Storage mutation exceeded ${pending.timeoutMs} ms.`,
        "timeout"
      ));
    }, pending.timeoutMs);
    active.timer.unref?.();
    if (pending.signal) {
      active.abortListener = () => {
        void this.terminateActive(active, new ManagerStorageMutationError("Storage mutation request was aborted.", "aborted"));
      };
      pending.signal.addEventListener("abort", active.abortListener, { once: true });
    }
    this.activeMutation = active;
    this.stateValue = "running";
    try {
      slot.child.send(request, error => {
        if (!error || this.activeMutation !== active || active.terminating) return;
        void this.terminateActive(active, new ManagerStorageMutationError(
          "Storage mutation request could not be sent to the child.",
          "worker_failed"
        ));
      });
    } catch {
      void this.terminateActive(active, new ManagerStorageMutationError(
        "Storage mutation request could not be sent to the child.",
        "worker_failed"
      ));
    }
  }

  private createChildSlot(): ChildSlot {
    const child = this.childFactory(this.identity);
    let resolveClosed = (): void => {};
    const closePromise = new Promise<void>(resolve => { resolveClosed = resolve; });
    const slot: ChildSlot = {
      child,
      closed: false,
      closePromise,
      resolveClosed,
      diagnosticBytes: 0,
      captureDiagnostic(chunk: Buffer | string): void {
        const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8");
        slot.diagnosticBytes = Math.min(Number.MAX_SAFE_INTEGER, slot.diagnosticBytes + bytes);
      }
    };
    this.childSlot = slot;
    this.spawnedChildren += 1;
    child.stdout?.on("data", slot.captureDiagnostic);
    child.stderr?.on("data", slot.captureDiagnostic);
    child.on("message", raw => this.handleMessage(slot, raw as ManagerStorageMutationResponse));
    child.once("error", error => this.handleChildError(slot, error));
    child.once("close", (code, signal) => this.handleChildClose(slot, code, signal));
    child.unref();
    child.channel?.unref?.();
    return slot;
  }

  private handleMessage(slot: ChildSlot, response: ManagerStorageMutationResponse): void {
    const active = this.activeMutation;
    if (!active || active.slot !== slot || active.terminating) return;
    if (response?.protocolVersion !== MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION
      || response.requestId !== active.request.requestId
      || !response.fence
      || !sameManagerStorageMutationFence(response.fence, active.request.fence)) {
      void this.terminateActive(active, new ManagerStorageMutationError(
        "Storage mutation response failed request/generation/role/plan fencing.",
        "fence_mismatch"
      ));
      return;
    }
    if (response.ok) this.settleActive(active, undefined, cloneSerializable(response.value));
    else this.settleActive(active, mutationResponseError(response.message));
  }

  private handleChildError(slot: ChildSlot, _error: Error): void {
    const active = this.activeMutation;
    if (active?.slot === slot && !active.terminating) {
      void this.terminateActive(active, new ManagerStorageMutationError(
        "Storage mutation child process failed.",
        "worker_failed"
      ));
      return;
    }
    if (!slot.closed && !slot.terminationFlight) void this.terminateIdleChild(slot);
  }

  private handleChildClose(slot: ChildSlot, code: number | null, signal: NodeJS.Signals | null): void {
    if (slot.closed) return;
    slot.closed = true;
    slot.resolveClosed();
    slot.child.stdout?.off("data", slot.captureDiagnostic);
    slot.child.stderr?.off("data", slot.captureDiagnostic);
    if (this.childSlot === slot) this.childSlot = undefined;
    if (this.blockedSlot === slot) this.blockedSlot = undefined;
    const active = this.activeMutation;
    if (active?.slot === slot && !active.terminating) {
      this.settleActive(active, new ManagerStorageMutationError(
        `Storage mutation child exited before responding: code=${code ?? "none"}; signal=${signal ?? "none"}`
          + (slot.diagnosticBytes > 0 ? `; diagnosticBytes=${slot.diagnosticBytes}` : ""),
        "worker_failed"
      ));
    }
    if (!this.accepting) return;
    if (!this.blockedSlot && !this.activeMutation) {
      this.stateValue = "idle";
      queueMicrotask(() => this.drain());
    }
  }

  private async terminateActive(active: ActiveMutation, cause: ManagerStorageMutationError): Promise<void> {
    if (this.activeMutation !== active || active.terminating) return;
    active.terminating = true;
    this.clearActiveDeadline(active);
    const confirmed = await this.terminateAndConfirm(active.slot);
    if (!confirmed) {
      this.blockTermination(active.slot);
      const unconfirmed = new ManagerStorageMutationError(
        `${cause.message} Child termination was not confirmed: pid=${active.slot.child.pid ?? "unknown"}.`,
        "termination_unconfirmed"
      );
      this.settleActive(active, unconfirmed);
      this.rejectQueue(unconfirmed);
      return;
    }
    this.settleActive(active, cause);
  }

  private async terminateIdleChild(slot: ChildSlot): Promise<void> {
    const confirmed = await this.terminateAndConfirm(slot);
    if (confirmed) return;
    this.blockTermination(slot);
    const error = new ManagerStorageMutationError(
      `Storage mutation child process failed and termination was not confirmed: pid=${slot.child.pid ?? "unknown"}.`,
      "termination_unconfirmed"
    );
    this.rejectQueue(error);
  }

  private terminateAndConfirm(slot: ChildSlot): Promise<boolean> {
    if (slot.closed) return Promise.resolve(true);
    if (slot.terminationFlight) return slot.terminationFlight;
    slot.terminationFlight = (async () => {
      try { slot.child.kill("SIGTERM"); } catch { /* close observation is authoritative */ }
      if (await closesWithin(slot, this.terminationTimeoutMs)) return true;
      try { slot.child.kill("SIGKILL"); } catch { /* reported below if close remains absent */ }
      const confirmed = await closesWithin(slot, this.forceTerminationTimeoutMs);
      if (confirmed) return true;
      try { if (slot.child.connected) slot.child.disconnect(); } catch { /* best effort only */ }
      slot.child.stdout?.destroy();
      slot.child.stderr?.destroy();
      slot.child.unref();
      return false;
    })();
    return slot.terminationFlight;
  }

  private blockTermination(slot: ChildSlot): void {
    this.blockedSlot = slot;
    this.childSlot = slot;
    this.stateValue = "blocked";
    this.lastErrorCode = "termination_unconfirmed";
  }

  private clearActiveDeadline(active: ActiveMutation): void {
    clearTimeout(active.timer);
    if (active.abortListener) active.pending.signal?.removeEventListener("abort", active.abortListener);
  }

  private settleActive(active: ActiveMutation, error?: Error, value?: unknown): void {
    if (this.activeMutation !== active) return;
    this.clearActiveDeadline(active);
    this.activeMutation = undefined;
    if (error) {
      this.lastErrorCode = error instanceof ManagerStorageMutationError ? error.code : "worker_failed";
      active.pending.reject(error);
    } else {
      this.lastErrorCode = undefined;
      active.pending.resolve(value);
    }
    if (!this.blockedSlot && this.accepting) {
      this.stateValue = "idle";
      queueMicrotask(() => this.drain());
    }
  }

  private rejectQueue(error: Error): void {
    for (const pending of this.queue.splice(0)) {
      if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
      pending.reject(error);
    }
  }
}
