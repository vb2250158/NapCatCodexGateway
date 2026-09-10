import {
  FailureCircuitRegistry,
  type FailureCircuitDecision
} from "../runtime/failureCircuit.js";

export type MemoryConsolidationScheduleTarget = {
  gatewayId: string;
  roleId: string;
  roleKey: string;
  roleDir: string;
};

export type DueMemoryConsolidationRun = {
  runId: string;
  revision: string;
  delivered?: boolean;
};

export type MemoryConsolidationScheduleEvaluation = {
  pending: DueMemoryConsolidationRun | null;
  dueOperationIdentity?: string;
  nextTriggerAt?: number;
};

export type MemoryConsolidationSchedulerOptions = {
  listTargets: () => MemoryConsolidationScheduleTarget[];
  requestDueRun: (
    target: MemoryConsolidationScheduleTarget,
    dueOperationIdentity?: string
  ) => DueMemoryConsolidationRun | null | Promise<DueMemoryConsolidationRun | null>;
  nextTriggerAt?: (target: MemoryConsolidationScheduleTarget) => number | undefined;
  evaluate?: (target: MemoryConsolidationScheduleTarget, signal?: AbortSignal) => Promise<MemoryConsolidationScheduleEvaluation>;
  deliver: (target: MemoryConsolidationScheduleTarget, run: DueMemoryConsolidationRun, signal?: AbortSignal) => void | Promise<void>;
  onError?: (
    target: MemoryConsolidationScheduleTarget,
    error: unknown,
    circuit: FailureCircuitDecision
  ) => void;
  onIncident?: (
    target: MemoryConsolidationScheduleTarget,
    error: unknown,
    circuit: FailureCircuitDecision
  ) => void;
  now?: () => number;
  retryDelayMs?: number;
  maximumRetryDelayMs?: number;
  incidentThreshold?: number;
  persistencePath?: string;
  onPersistenceError?: (error: unknown) => void;
  scheduleDeadline?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearDeadline?: (timer: NodeJS.Timeout) => void;
};

export class MemoryConsolidationScheduler {
  private readonly deliveredRunIds = new Set<string>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly scheduleDeadline: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearDeadline: (timer: NodeJS.Timeout) => void;
  private readonly failureCircuits: FailureCircuitRegistry;
  private deadline?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerunRequested = false;
  private stopped = false;
  private executionCancellation?: AbortController;

  constructor(private readonly options: MemoryConsolidationSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 60_000);
    this.failureCircuits = new FailureCircuitRegistry({
      baseDelayMs: this.retryDelayMs,
      maximumDelayMs: Math.max(this.retryDelayMs, options.maximumRetryDelayMs ?? 30 * 60_000),
      incidentThreshold: options.incidentThreshold ?? 5,
      now: this.now,
      persistencePath: options.persistencePath,
      onPersistenceError: options.onPersistenceError
    });
    this.scheduleDeadline = options.scheduleDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearDeadline = options.clearDeadline ?? clearTimeout;
  }

  start(): void {
    this.stopped = false;
    void this.runOnce();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.rerunRequested = false;
    this.cancelDeadline();
    this.executionCancellation?.abort(new DOMException("Memory consolidation scheduler stopped.", "AbortError"));
    return this.running ?? Promise.resolve();
  }

  reschedule(): void {
    if (this.stopped) return;
    this.cancelDeadline();
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    void this.runOnce();
  }

  noteRunCompleted(runId: string): void {
    this.deliveredRunIds.delete(runId);
  }

  resetFailure(roleKey?: string): void {
    this.failureCircuits.reset(roleKey);
  }

  failureSummary() {
    return this.failureCircuits.summary();
  }

  runOnce(): Promise<void> {
    if (this.running) return this.running;
    const executionCancellation = new AbortController();
    this.executionCancellation = executionCancellation;
    this.running = this.execute(executionCancellation.signal).finally(() => {
      if (this.executionCancellation === executionCancellation) this.executionCancellation = undefined;
      this.running = undefined;
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false;
        void this.runOnce();
      }
    });
    return this.running;
  }

  private async execute(signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    this.cancelDeadline();
    const targets = this.uniqueTargets();
    this.failureCircuits.retain(targets.map(target => target.roleKey));
    const pendingByRole = new Map<string, DueMemoryConsolidationRun>();
    const nextTriggerByRole = new Map<string, number | undefined>();
    let retryAt: number | undefined;

    for (const target of targets) {
      if (this.stopped) break;
      if (!this.failureCircuits.canAttempt(target.roleKey)) {
        const blockedUntil = this.failureCircuits.nextRetryAt(target.roleKey);
        if (blockedUntil !== undefined) {
          retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, blockedUntil);
        }
        continue;
      }
      let pending: DueMemoryConsolidationRun | null = null;
      try {
        if (this.options.evaluate) {
          const evaluation = await this.options.evaluate(target, signal);
          pending = evaluation.pending;
          nextTriggerByRole.set(target.roleKey, evaluation.nextTriggerAt);
          if (!pending && evaluation.dueOperationIdentity) {
            pending = await this.options.requestDueRun(target, evaluation.dueOperationIdentity);
          }
        } else {
          pending = await this.options.requestDueRun(target);
        }
      } catch (error) {
        if (this.stopped || signal.aborted) break;
        const circuit = this.failureCircuits.recordFailure(target.roleKey, error);
        if (circuit.shouldReport) this.options.onError?.(target, error, circuit);
        if (circuit.incidentOpened) this.options.onIncident?.(target, error, circuit);
        retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, circuit.snapshot.retryAt);
        continue;
      }
      if (!pending) {
        this.failureCircuits.recordSuccess(target.roleKey);
        continue;
      }
      pendingByRole.set(target.roleKey, pending);
      if (pending.delivered) {
        this.deliveredRunIds.add(pending.runId);
        this.failureCircuits.recordSuccess(target.roleKey);
        continue;
      }
      if (this.deliveredRunIds.has(pending.runId)) {
        this.failureCircuits.recordSuccess(target.roleKey);
        continue;
      }

      this.deliveredRunIds.add(pending.runId);
      try {
        await this.options.deliver(target, pending, signal);
        this.failureCircuits.recordSuccess(target.roleKey);
        if (this.stopped) break;
      } catch (error) {
        if (this.stopped || signal.aborted) break;
        this.deliveredRunIds.delete(pending.runId);
        const circuit = this.failureCircuits.recordFailure(target.roleKey, error);
        if (circuit.shouldReport) this.options.onError?.(target, error, circuit);
        if (circuit.incidentOpened) this.options.onIncident?.(target, error, circuit);
        retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, circuit.snapshot.retryAt);
      }
    }

    let nextAt = retryAt;
    for (const target of targets) {
      const pending = pendingByRole.get(target.roleKey);
      const circuitRetryAt = this.failureCircuits.nextRetryAt(target.roleKey);
      if (circuitRetryAt !== undefined) {
        nextAt = Math.min(nextAt ?? Number.POSITIVE_INFINITY, circuitRetryAt);
        continue;
      }
      if (pending && this.deliveredRunIds.has(pending.runId)) continue;
      const triggerAt = this.options.evaluate
        ? nextTriggerByRole.get(target.roleKey)
        : this.options.nextTriggerAt?.(target);
      if (!Number.isFinite(triggerAt)) continue;
      nextAt = Math.min(nextAt ?? Number.POSITIVE_INFINITY, Number(triggerAt));
    }
    if (nextAt !== undefined && Number.isFinite(nextAt)) this.armDeadline(nextAt);
  }

  private uniqueTargets(): MemoryConsolidationScheduleTarget[] {
    const result: MemoryConsolidationScheduleTarget[] = [];
    const seen = new Set<string>();
    for (const target of this.options.listTargets()) {
      if (seen.has(target.roleKey)) continue;
      seen.add(target.roleKey);
      result.push(target);
    }
    return result;
  }

  private armDeadline(triggerAt: number): void {
    if (this.stopped) return;
    const delayMs = Math.max(0, triggerAt - this.now());
    this.deadline = this.scheduleDeadline(() => {
      this.deadline = undefined;
      void this.runOnce();
    }, delayMs);
    this.deadline.unref?.();
  }

  private cancelDeadline(): void {
    if (!this.deadline) return;
    this.clearDeadline(this.deadline);
    this.deadline = undefined;
  }
}
