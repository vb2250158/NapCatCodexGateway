import { createHash, randomUUID } from "node:crypto";
import type {
  MemoryConsolidationRequest,
  MemoryConsolidationRun,
  PlanItem,
  PlanSecretaryBinding,
  PlanTaskBinding,
  RecentMemoryItem,
  RoleKnowledgeCatalogSnapshot
} from "../roleKnowledge.js";
import { presentRoleMemory, publishCommittedRolePlan, publishCommittedRoleMemory } from "../roleKnowledge.js";
import type {
  PlanFeedbackDeliveryStatus,
  PlanFeedbackPostCommit,
  PlanFeedbackRecord,
  PlanQaFeedbackHandling
} from "../planFeedback.js";
import type { SubmitPlanFeedbackInput, SubmitPlanFeedbackResult } from "../planFeedbackSubmission.js";
import type { RolePanelTimelineAppendResult, RolePanelTimelineMessage } from "../rolePanelTimeline.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import type {
  PersonaPlanWorkflow,
  PersonaPlanWorkflowReadResult,
  PersonaPlanWorkflowStatus
} from "../personaPlanWorkflow.js";
import {
  ManagerStorageMutationError,
  ManagerStorageMutationPool,
  type ManagerStorageMutationPoolStatus
} from "./managerStorageMutationPool.js";
import {
  ManagerReadWorkerError,
  ManagerReadWorkerPool,
  managerCatalogWorkerPool,
  managerReadWorkerPool
} from "./managerReadWorkerPool.js";
import type { ManagerReadWorkerTask } from "./managerReadWorker.js";
import {
  canonicalStorageMutationPlanId,
  canonicalStorageMutationRoleId,
  storageMutationRoleDirectory,
  storageMutationRevisionToken
} from "./managerStorageMutationProtocol.js";

export { storageMutationRevisionToken as roleStorageRevisionToken } from "./managerStorageMutationProtocol.js";

export type RoleStorageGenerationIdentity = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
}>;

export type RoleStorageCommandContext = Readonly<{
  idempotencyKey?: string;
  expectedRevision?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type RoleStorageCommit<TCommit, TProjection> = Readonly<{
  operationId: string;
  expectedRevision: string | null;
  commit: TCommit;
  projection: TProjection;
  catalog: RoleKnowledgeCatalogSnapshot;
}>;

export type RoleStorageProjectedCommit<TCommit, TProjection> = Readonly<{
  operationId: string;
  expectedRevision: string | null;
  commit: TCommit;
  projection: TProjection;
}>;

export type RoleStorageCommandReceipt<TCommit> = Readonly<{
  operationId: string;
  expectedRevision: null;
  commit: TCommit;
}>;

export type RoleStoragePlanProjection = Readonly<{
  plan: PlanItem;
  revision: string;
  approval: { count: number; latest?: PlanFeedbackRecord };
}>;

export type RoleStoragePlanFeedbackProjection = Readonly<{
  plan: PlanItem;
  planRevision: string;
  records: PlanFeedbackRecord[];
  recordRevisions: Readonly<Record<string, string | null>>;
}>;

export type RoleStorageMemoryProjection = Readonly<{
  memory: RecentMemoryItem & Readonly<{ lifecycle: unknown }>;
  revision: string;
}>;

export type RoleStorageConsolidationProjection = Readonly<{
  run: MemoryConsolidationRun;
  revision: string;
}>;

export type RoleStoragePlanStatusMutationResult = Readonly<{
  workflow: PersonaPlanWorkflow;
  revision: string;
  status: PersonaPlanWorkflowStatus;
  migratedPlanIds: string[];
}>;

export class RoleStorageApplicationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_request"
      | "not_found"
      | "revision_conflict"
      | "idempotency_conflict"
      | "indeterminate"
      | "busy"
      | "generation_mismatch"
      | "projection_unavailable"
      | "mutation_failed",
    readonly statusCode: number,
    readonly operationId?: string,
    readonly commitState: "not_started" | "unknown" | "committed" = "not_started",
    readonly causeCode?: string
  ) {
    super(message);
    this.name = "RoleStorageApplicationError";
  }
}

type RoleStorageReadPool = Pick<
  ManagerReadWorkerPool,
  "run" | "queryRoleKnowledgeCatalogSnapshot"
>;

type RoleStorageMutationPool = Pick<
  ManagerStorageMutationPool,
  | "status"
  | "stop"
  | "createPlan"
  | "createPlanStatus"
  | "updatePlanStatus"
  | "deletePlanStatus"
  | "updatePlan"
  | "updatePlanSecretaryBinding"
  | "updatePlanTaskBinding"
  | "createRecentMemory"
  | "updateRecentMemory"
  | "touchRecentMemory"
  | "requestMemoryConsolidation"
  | "markMemoryConsolidationDelivered"
  | "applyMemoryConsolidation"
  | "submitPlanFeedback"
  | "updatePlanFeedbackDelivery"
  | "updatePlanFeedbackQaHandling"
  | "updatePlanFeedbackPostCommit"
  | "appendRolePanelTimeline"
>;

export type RoleStorageApplicationOptions = Readonly<{
  rolesRoot: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  currentIdentity?: () => RoleStorageGenerationIdentity | null;
  mutationPool?: RoleStorageMutationPool;
  readPool?: RoleStorageReadPool;
  catalogReadPool?: RoleStorageReadPool;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requiredIdentity(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256) {
    throw new RoleStorageApplicationError(`${label} is required.`, "invalid_request", 400);
  }
  return normalized;
}

function operationName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new RoleStorageApplicationError("Storage operation name is invalid.", "invalid_request", 400);
  return normalized.slice(0, 48);
}

export function roleStorageOperationKey(operationValue: string, ...identityParts: readonly unknown[]): string {
  const operation = operationName(operationValue);
  const parts = identityParts.map(value => String(value ?? "").trim());
  if (parts.length === 0 || parts.some(part => !part)) {
    throw new RoleStorageApplicationError("Stable storage operation identity is incomplete.", "invalid_request", 400);
  }
  const digest = createHash("sha256").update(stableJson(parts), "utf8").digest("hex");
  return `rsm:event:${operation}:${digest}`;
}

export function stableRoleStorageOperationId(input: Readonly<{
  operation: string;
  roleId: string;
  resourceId?: string;
  payload?: unknown;
  explicitIdempotencyKey?: string;
  allowResourceDerivedKey?: boolean;
}>): string {
  const explicit = String(input.explicitIdempotencyKey ?? "").trim();
  if (explicit) {
    if (explicit.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(explicit)) {
      throw new RoleStorageApplicationError(
        "Idempotency-Key must contain only letters, digits, dot, underscore, colon, or hyphen and be at most 200 characters.",
        "invalid_request",
        400
      );
    }
    return explicit;
  }
  const operation = operationName(input.operation);
  const roleId = canonicalStorageMutationRoleId(input.roleId);
  const resourceId = String(input.resourceId ?? "").trim();
  if (!input.allowResourceDerivedKey || !resourceId) {
    throw new RoleStorageApplicationError(
      "Idempotency-Key is required for this storage mutation and must be reused unchanged after an uncertain response.",
      "invalid_request",
      400
    );
  }
  const digest = createHash("sha256").update(stableJson({ operation, roleId, resourceId }), "utf8").digest("hex");
  return `rsm:${operation}:${digest}`;
}

export function parseRoleStorageExpectedRevision(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(",")) {
    throw new RoleStorageApplicationError("Expected revision must contain one ETag.", "invalid_request", 400);
  }
  if (trimmed === "*") {
    throw new RoleStorageApplicationError(
      "If-Match must contain the exact strong storage revision; wildcard preconditions are not supported.",
      "invalid_request",
      400
    );
  }
  if (/^W\//i.test(trimmed)) {
    throw new RoleStorageApplicationError("Weak ETags cannot guard a storage mutation.", "invalid_request", 400);
  }
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!unquoted || unquoted.length > 256 || /[\u0000-\u001f\u007f]/.test(unquoted)) {
    throw new RoleStorageApplicationError("Expected revision is invalid.", "invalid_request", 400);
  }
  return unquoted;
}

function publicMutationError(error: unknown, operationId?: string): RoleStorageApplicationError {
  if (error instanceof RoleStorageApplicationError) return error;
  if (!(error instanceof ManagerStorageMutationError)) {
    return new RoleStorageApplicationError("Storage mutation failed.", "mutation_failed", 500, operationId, "unknown");
  }
  switch (error.code) {
    case "validation_rejected":
      return new RoleStorageApplicationError(error.message, "invalid_request", 400, operationId, "not_started");
    case "revision_conflict":
      return new RoleStorageApplicationError("The stored revision changed; reload before updating.", "revision_conflict", 412, operationId);
    case "idempotency_conflict":
      return new RoleStorageApplicationError("The idempotency key belongs to a different operation.", "idempotency_conflict", 409, operationId);
    case "indeterminate":
      return new RoleStorageApplicationError(
        "The commit result is indeterminate. Retry only with the same Idempotency-Key.",
        "indeterminate",
        503,
        operationId,
        "unknown"
      );
    case "timeout":
    case "aborted":
    case "worker_failed":
    case "termination_unconfirmed":
      return new RoleStorageApplicationError(
        `Storage operation ${error.code}; the commit result is indeterminate. Retry only with the same Idempotency-Key.`,
        "indeterminate",
        503,
        operationId,
        "unknown",
        error.code
      );
    case "busy":
    case "stopped":
      return new RoleStorageApplicationError(`Role storage is temporarily unavailable (${error.code}).`, "busy", 503, operationId, "not_started", error.code);
    case "fence_mismatch":
      return new RoleStorageApplicationError(
        "The Manager storage generation changed while the commit result was unresolved. Retry only with the same Idempotency-Key.",
        "generation_mismatch",
        503,
        operationId,
        "unknown",
        error.code
      );
    default:
      return new RoleStorageApplicationError("Storage mutation failed.", "mutation_failed", 500, operationId, "unknown");
  }
}

function publicReadError(error: unknown, operationId?: string, committed = false): RoleStorageApplicationError {
  if (error instanceof RoleStorageApplicationError && !committed) return error;
  const statusCode = error instanceof RoleStorageApplicationError
    ? error.statusCode
    : error instanceof ManagerReadWorkerError && error.code === "timeout" ? 504 : 503;
  const code = committed && error instanceof RoleStorageApplicationError && error.code === "generation_mismatch"
    ? "generation_mismatch"
    : committed ? "projection_unavailable" : "busy";
  return new RoleStorageApplicationError(
    committed
      ? "The mutation committed, but its published projection is temporarily unavailable. Retry with the same Idempotency-Key."
      : "Role storage is temporarily unavailable.",
    code,
    statusCode,
    operationId,
    committed ? "committed" : "not_started"
  );
}

function roleStorageAuditGroup(operation: string): string {
  if (operation.startsWith("plan-")) return "plan";
  if (operation.includes("memory")) return "memory";
  return "role.storage";
}

function roleStorageDataSource(roleId: string, operation: string): string {
  if (operation.startsWith("plan-")) return `roles/${roleId}/plans`;
  if (operation.includes("memory")) return `roles/${roleId}/memory`;
  if (operation === "role-panel-timeline-append") return `roles/${roleId}/timeline`;
  return `roles/${roleId}`;
}

function roleStorageMutationOutcome(error: RoleStorageApplicationError): "rejected" | "failed" {
  return error.code === "revision_conflict"
    || error.code === "idempotency_conflict"
    || error.code === "invalid_request"
    ? "rejected"
    : "failed";
}

export class RoleStorageQueries {
  private readonly rolesRoot: string;
  private readonly identity: RoleStorageGenerationIdentity;
  private readonly currentIdentity: () => RoleStorageGenerationIdentity | null;

  constructor(
    options: Pick<RoleStorageApplicationOptions, "rolesRoot" | "applicationGenerationId" | "managerInstanceId" | "currentIdentity">,
    private readonly readPool: RoleStorageReadPool = managerReadWorkerPool,
    private readonly catalogReadPool: RoleStorageReadPool = managerCatalogWorkerPool
  ) {
    this.rolesRoot = requiredIdentity(options.rolesRoot, "rolesRoot");
    this.identity = Object.freeze({
      applicationGenerationId: requiredIdentity(options.applicationGenerationId, "applicationGenerationId"),
      managerInstanceId: requiredIdentity(options.managerInstanceId, "managerInstanceId")
    });
    this.currentIdentity = options.currentIdentity ?? (() => this.identity);
  }

  private roleDir(roleId: string): string {
    return storageMutationRoleDirectory(this.rolesRoot, roleId);
  }

  assertCurrentGeneration(): void {
    const current = this.currentIdentity();
    if (!current
      || current.applicationGenerationId !== this.identity.applicationGenerationId
      || current.managerInstanceId !== this.identity.managerInstanceId) {
      throw new RoleStorageApplicationError("The Manager storage generation changed.", "generation_mismatch", 503);
    }
  }

  private async run<T>(roleId: string, task: (roleDir: string) => ManagerReadWorkerTask, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    this.assertCurrentGeneration();
    const value = await this.readPool.run<T>(task(this.roleDir(roleId)), options).catch(error => {
      throw publicReadError(error);
    });
    this.assertCurrentGeneration();
    return value;
  }

  async recaptureCatalog(roleId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RoleKnowledgeCatalogSnapshot> {
    this.assertCurrentGeneration();
    const value = await this.catalogReadPool.queryRoleKnowledgeCatalogSnapshot(this.roleDir(roleId), options).catch(error => {
      throw publicReadError(error);
    });
    this.assertCurrentGeneration();
    return value;
  }

  plan(roleId: string, planId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RoleStoragePlanProjection | null> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.run(roleId, roleDir => ({ type: "role_storage_plan_projection", roleDir, planId: canonicalPlanId }), options);
  }

  publishPlan(roleId: string, plan: PlanItem): Readonly<PlanItem> {
    this.assertCurrentGeneration();
    const published = publishCommittedRolePlan(this.roleDir(roleId), plan);
    this.assertCurrentGeneration();
    return published;
  }

  publishMemory(roleId: string, memory: RecentMemoryItem): Readonly<RecentMemoryItem> {
    this.assertCurrentGeneration();
    return publishCommittedRoleMemory(this.roleDir(roleId), memory);
  }

  planWorkflow(roleId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PersonaPlanWorkflowReadResult | null> {
    return this.run(roleId, roleDir => ({ type: "role_plan_workflow", roleDir }), options);
  }

  planFeedback(roleId: string, planId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RoleStoragePlanFeedbackProjection | null> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.run(roleId, roleDir => ({ type: "role_storage_plan_feedback_projection", roleDir, planId: canonicalPlanId }), options);
  }

  memory(roleId: string, memoryId: string, options: { signal?: AbortSignal; timeoutMs?: number; fresh?: boolean } = {}): Promise<RoleStorageMemoryProjection | null> {
    return this.run(roleId, roleDir => ({
      type: "role_storage_memory_projection",
      roleDir,
      memoryId,
      fresh: options.fresh === true
    }), options);
  }

  consolidationRun(roleId: string, runId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RoleStorageConsolidationProjection | null> {
    return this.run(roleId, roleDir => ({ type: "role_storage_consolidation_projection", roleDir, runId }), options);
  }
}

export class RoleStorageCommands {
  constructor(
    private readonly identity: RoleStorageGenerationIdentity,
    private readonly mutationPool: RoleStorageMutationPool,
    readonly queries: RoleStorageQueries
  ) {}

  private assertPoolGeneration(): void {
    this.queries.assertCurrentGeneration();
    const status = this.mutationPool.status();
    if (status.applicationGenerationId !== this.identity.applicationGenerationId
      || status.managerInstanceId !== this.identity.managerInstanceId) {
      throw new RoleStorageApplicationError("The Manager storage generation changed.", "generation_mismatch", 503);
    }
  }

  private async requiredExpectedRevision(requested: string | null | undefined): Promise<string> {
    const parsed = parseRoleStorageExpectedRevision(requested);
    if (parsed === undefined || parsed === null) {
      throw new RoleStorageApplicationError(
        "If-Match (or an equivalent expectedRevision) is required for this storage mutation.",
        "invalid_request",
        400
      );
    }
    return parsed;
  }

  private async commit<TCommit, TProjection>(input: {
    operation: string;
    roleId: string;
    resourceId?: string;
    payload: unknown;
    allowResourceDerivedKey?: boolean;
    context: RoleStorageCommandContext;
    expectedRevision: () => Promise<string | null>;
    mutate(options: { idempotencyKey: string; expectedRevision: string | null; signal?: AbortSignal; timeoutMs?: number }): Promise<TCommit>;
    project(catalog: RoleKnowledgeCatalogSnapshot): Promise<TProjection>;
  }): Promise<RoleStorageCommit<TCommit, TProjection>> {
    const roleId = canonicalStorageMutationRoleId(input.roleId);
    const operationId = stableRoleStorageOperationId({
      operation: input.operation,
      roleId,
      resourceId: input.resourceId,
      payload: input.payload,
      explicitIdempotencyKey: input.context.idempotencyKey,
      allowResourceDerivedKey: input.allowResourceDerivedKey
    });
    this.assertPoolGeneration();
    const expectedRevision = await input.expectedRevision();
    const auditBase = {
      group: roleStorageAuditGroup(input.operation),
      owner: "role-storage",
      action: input.operation,
      target: { type: input.resourceId ? "role-resource" : "role", id: input.resourceId ?? roleId },
      dataSource: { kind: "file" as const, id: roleStorageDataSource(roleId, input.operation) },
      operationId,
      before: expectedRevision ? { revision: expectedRevision } : undefined
    };
    const startedAt = Date.now();
    recordDataMutationAudit({ ...auditBase, event: "role_storage_mutation_started", outcome: "started" });
    let commit: TCommit;
    try {
      commit = await input.mutate({
        idempotencyKey: operationId,
        expectedRevision,
        signal: input.context.signal,
        timeoutMs: input.context.timeoutMs
      });
    } catch (error) {
      const publicError = publicMutationError(error, operationId);
      const outcome = roleStorageMutationOutcome(publicError);
      recordDataMutationAudit({
        ...auditBase,
        level: outcome === "rejected" ? "warn" : "error",
        event: "role_storage_mutation_failed",
        outcome,
        durationMs: Date.now() - startedAt,
        result: publicError.code,
        error: publicError
      });
      throw publicError;
    }
    const afterRevision = storageMutationRevisionToken(commit);
    recordDataMutationAudit({
      ...auditBase,
      event: "role_storage_mutation_committed",
      outcome: "committed",
      after: afterRevision ? { revision: afterRevision } : undefined,
      durationMs: Date.now() - startedAt
    });
    try {
      const catalog = await this.queries.recaptureCatalog(roleId, {
        signal: input.context.signal,
        timeoutMs: input.context.timeoutMs
      });
      const projection = await input.project(catalog);
      this.assertPoolGeneration();
      return Object.freeze({ operationId, expectedRevision, commit, projection, catalog });
    } catch (error) {
      const publicError = publicReadError(error, operationId, true);
      recordDataMutationAudit({
        ...auditBase,
        level: "error",
        event: "role_storage_projection_failed",
        outcome: "failed",
        after: afterRevision ? { revision: afterRevision } : undefined,
        durationMs: Date.now() - startedAt,
        result: "mutation_committed",
        error: publicError
      });
      throw publicError;
    }
  }

  private async commitProjection<TCommit, TProjection>(input: {
    operation: string;
    roleId: string;
    resourceId?: string;
    payload: unknown;
    allowResourceDerivedKey?: boolean;
    context: RoleStorageCommandContext;
    expectedRevision: () => Promise<string | null>;
    mutate(options: { idempotencyKey: string; expectedRevision: string | null; signal?: AbortSignal; timeoutMs?: number }): Promise<TCommit>;
    project(commit: TCommit): Promise<TProjection>;
  }): Promise<RoleStorageProjectedCommit<TCommit, TProjection>> {
    const roleId = canonicalStorageMutationRoleId(input.roleId);
    const operationId = stableRoleStorageOperationId({
      operation: input.operation,
      roleId,
      resourceId: input.resourceId,
      payload: input.payload,
      explicitIdempotencyKey: input.context.idempotencyKey,
      allowResourceDerivedKey: input.allowResourceDerivedKey
    });
    this.assertPoolGeneration();
    const expectedRevision = await input.expectedRevision();
    const auditBase = {
      group: roleStorageAuditGroup(input.operation),
      owner: "role-storage",
      action: input.operation,
      target: { type: input.resourceId ? "role-resource" : "role", id: input.resourceId ?? roleId },
      dataSource: { kind: "file" as const, id: roleStorageDataSource(roleId, input.operation) },
      operationId,
      before: expectedRevision ? { revision: expectedRevision } : undefined
    };
    const startedAt = Date.now();
    recordDataMutationAudit({ ...auditBase, event: "role_storage_mutation_started", outcome: "started" });
    let commit: TCommit;
    try {
      commit = await input.mutate({
        idempotencyKey: operationId,
        expectedRevision,
        signal: input.context.signal,
        timeoutMs: input.context.timeoutMs
      });
    } catch (error) {
      const publicError = publicMutationError(error, operationId);
      const outcome = roleStorageMutationOutcome(publicError);
      recordDataMutationAudit({
        ...auditBase,
        level: outcome === "rejected" ? "warn" : "error",
        event: "role_storage_mutation_failed",
        outcome,
        durationMs: Date.now() - startedAt,
        result: publicError.code,
        error: publicError
      });
      throw publicError;
    }
    const afterRevision = storageMutationRevisionToken(commit);
    recordDataMutationAudit({
      ...auditBase,
      event: "role_storage_mutation_committed",
      outcome: "committed",
      after: afterRevision ? { revision: afterRevision } : undefined,
      durationMs: Date.now() - startedAt
    });
    try {
      const projection = await input.project(commit);
      this.assertPoolGeneration();
      return Object.freeze({ operationId, expectedRevision, commit, projection });
    } catch (error) {
      const publicError = publicReadError(error, operationId, true);
      recordDataMutationAudit({
        ...auditBase,
        level: "error",
        event: "role_storage_projection_failed",
        outcome: "failed",
        after: afterRevision ? { revision: afterRevision } : undefined,
        durationMs: Date.now() - startedAt,
        result: "mutation_committed",
        error: publicError
      });
      throw publicError;
    }
  }

  private async requiredPlanProjection(
    roleId: string,
    planId: string,
    context: RoleStorageCommandContext,
    operationId?: string
  ): Promise<RoleStoragePlanProjection> {
    const projection = await this.queries.plan(roleId, planId, context);
    if (!projection) {
      throw new RoleStorageApplicationError(
        "The committed plan projection is unavailable.",
        "projection_unavailable",
        503,
        operationId,
        "committed"
      );
    }
    this.queries.publishPlan(roleId, projection.plan);
    return projection;
  }

  async createPlan(roleId: string, rawInput: Record<string, unknown>, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanItem, RoleStoragePlanProjection>> {
    const requestedPlanId = typeof rawInput.id === "string" && rawInput.id.trim()
      ? canonicalStorageMutationPlanId(rawInput.id)
      : undefined;
    const operationId = stableRoleStorageOperationId({
      operation: "plan-create",
      roleId,
      resourceId: requestedPlanId,
      explicitIdempotencyKey: context.idempotencyKey,
      allowResourceDerivedKey: requestedPlanId !== undefined
    });
    const planId = canonicalStorageMutationPlanId(
      requestedPlanId
        ? requestedPlanId
        : `plan-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`
    );
    const input = { ...rawInput, id: planId };
    return this.commitProjection({
      operation: "plan-create",
      roleId,
      resourceId: planId,
      payload: input,
      allowResourceDerivedKey: true,
      context: { ...context, idempotencyKey: operationId },
      expectedRevision: async () => null,
      mutate: options => this.mutationPool.createPlan(roleId, planId, input, options),
      project: () => this.requiredPlanProjection(roleId, planId, context, operationId)
    });
  }

  async createPlanStatus(
    roleId: string,
    input: Record<string, unknown>,
    context: RoleStorageCommandContext = {}
  ): Promise<RoleStorageCommit<RoleStoragePlanStatusMutationResult, PersonaPlanWorkflowReadResult>> {
    const statusKey = requiredIdentity(input.key, "status key");
    return this.commit({
      operation: "plan-status-create",
      roleId,
      resourceId: statusKey,
      payload: input,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.createPlanStatus(roleId, input, options) as Promise<RoleStoragePlanStatusMutationResult>,
      project: async () => {
        const projection = await this.queries.planWorkflow(roleId, context);
        if (!projection) throw new RoleStorageApplicationError("The committed plan status catalog is unavailable.", "projection_unavailable", 503, undefined, "committed");
        return projection;
      }
    });
  }

  async updatePlanStatus(
    roleId: string,
    statusKey: string,
    patch: Record<string, unknown>,
    context: RoleStorageCommandContext = {}
  ): Promise<RoleStorageCommit<RoleStoragePlanStatusMutationResult, PersonaPlanWorkflowReadResult>> {
    const key = requiredIdentity(statusKey, "status key");
    if (patch.key !== undefined && patch.key !== key) {
      throw new RoleStorageApplicationError("Plan status key is immutable.", "invalid_request", 400);
    }
    return this.commit({
      operation: "plan-status-update",
      roleId,
      resourceId: key,
      payload: patch,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.updatePlanStatus(roleId, key, patch, options) as Promise<RoleStoragePlanStatusMutationResult>,
      project: async () => {
        const projection = await this.queries.planWorkflow(roleId, context);
        if (!projection) throw new RoleStorageApplicationError("The committed plan status catalog is unavailable.", "projection_unavailable", 503, undefined, "committed");
        return projection;
      }
    });
  }

  async deletePlanStatus(
    roleId: string,
    statusKey: string,
    replacementKey: string,
    context: RoleStorageCommandContext = {}
  ): Promise<RoleStorageCommit<RoleStoragePlanStatusMutationResult, PersonaPlanWorkflowReadResult>> {
    const key = requiredIdentity(statusKey, "status key");
    const replacement = requiredIdentity(replacementKey, "replacementKey");
    if (key === replacement) {
      throw new RoleStorageApplicationError("replacementKey must differ from the retired plan status key.", "invalid_request", 400);
    }
    return this.commit({
      operation: "plan-status-delete",
      roleId,
      resourceId: key,
      payload: { replacementKey: replacement },
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.deletePlanStatus(roleId, key, replacement, options) as Promise<RoleStoragePlanStatusMutationResult>,
      project: async () => {
        const projection = await this.queries.planWorkflow(roleId, context);
        if (!projection) throw new RoleStorageApplicationError("The committed plan status catalog is unavailable.", "projection_unavailable", 503, undefined, "committed");
        return projection;
      }
    });
  }

  async updatePlan(roleId: string, planId: string, patch: Record<string, unknown>, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanItem, RoleStoragePlanProjection>> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.commitProjection({
      operation: "plan-update",
      roleId,
      resourceId: canonicalPlanId,
      payload: patch,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.updatePlan(roleId, canonicalPlanId, patch, options),
      project: () => this.requiredPlanProjection(roleId, canonicalPlanId, context)
    });
  }

  async updatePlanSecretaryBinding(roleId: string, planId: string, binding: PlanSecretaryBinding | null, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanItem, RoleStoragePlanProjection>> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.commitProjection({
      operation: "plan-secretary-binding-update",
      roleId,
      resourceId: canonicalPlanId,
      payload: { binding },
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.updatePlanSecretaryBinding(roleId, canonicalPlanId, binding, options),
      project: () => this.requiredPlanProjection(roleId, canonicalPlanId, context)
    });
  }

  async updatePlanTaskBinding(roleId: string, planId: string, binding: PlanTaskBinding | null, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanItem, RoleStoragePlanProjection>> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.commitProjection({
      operation: "plan-task-binding-update",
      roleId,
      resourceId: canonicalPlanId,
      payload: { binding },
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.updatePlanTaskBinding(roleId, canonicalPlanId, binding, options),
      project: () => this.requiredPlanProjection(roleId, canonicalPlanId, context)
    });
  }

  async createRecentMemory(roleId: string, input: Record<string, unknown>, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<RecentMemoryItem, RoleStorageMemoryProjection>> {
    let memoryId = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
    return this.commitProjection({
      operation: "recent-memory-create",
      roleId,
      resourceId: memoryId || undefined,
      payload: input,
      allowResourceDerivedKey: Boolean(memoryId),
      context,
      expectedRevision: async () => null,
      mutate: async options => {
        const committed = await this.mutationPool.createRecentMemory(roleId, input, options);
        memoryId = committed.id;
        return committed;
      },
      project: async () => {
        const projection = await this.queries.memory(roleId, memoryId, { ...context, fresh: true });
        if (!projection) throw new RoleStorageApplicationError("The committed memory projection is unavailable.", "projection_unavailable", 503, undefined, "committed");
        this.queries.publishMemory(roleId, projection.memory);
        return projection;
      }
    });
  }

  async updateRecentMemory(roleId: string, memoryId: string, patch: Record<string, unknown>, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<RecentMemoryItem, RoleStorageMemoryProjection>> {
    return this.commitProjection({
      operation: "recent-memory-update",
      roleId,
      resourceId: memoryId,
      payload: patch,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.updateRecentMemory(roleId, memoryId, patch, options),
      project: async () => {
        const projection = await this.queries.memory(roleId, memoryId, { ...context, fresh: true });
        if (!projection) throw new RoleStorageApplicationError("The committed memory projection is unavailable.", "projection_unavailable", 503, undefined, "committed");
        this.queries.publishMemory(roleId, projection.memory);
        return projection;
      }
    });
  }

  async touchRecentMemory(
    roleId: string,
    memoryId: string,
    context: RoleStorageCommandContext = {}
  ): Promise<RoleStorageProjectedCommit<RecentMemoryItem, RoleStorageMemoryProjection>> {
    const canonicalRoleId = canonicalStorageMutationRoleId(roleId);
    const canonicalMemoryId = requiredIdentity(memoryId, "memoryId");
    const operationId = context.idempotencyKey
      ? stableRoleStorageOperationId({
          operation: "recent-memory-touch",
          roleId: canonicalRoleId,
          resourceId: canonicalMemoryId,
          explicitIdempotencyKey: context.idempotencyKey
        })
      : roleStorageOperationKey(
          "recent-memory-touch",
          this.identity.applicationGenerationId,
          this.identity.managerInstanceId,
          canonicalRoleId,
          canonicalMemoryId,
          randomUUID()
        );
    const stableContext: RoleStorageCommandContext = Object.freeze({
      ...context,
      idempotencyKey: operationId,
      expectedRevision: undefined
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.commitProjection({
          operation: "recent-memory-touch",
          roleId: canonicalRoleId,
          resourceId: canonicalMemoryId,
          payload: { memoryId: canonicalMemoryId },
          context: stableContext,
          expectedRevision: async () => {
            const current = await this.queries.memory(canonicalRoleId, canonicalMemoryId, {
              signal: stableContext.signal,
              timeoutMs: stableContext.timeoutMs,
              fresh: true
            });
            if (!current) {
              throw new RoleStorageApplicationError(
                `Memory not found: ${canonicalMemoryId}`,
                "not_found",
                404,
                operationId
              );
            }
            return current.revision;
          },
          mutate: options => this.mutationPool.touchRecentMemory(
            canonicalRoleId,
            canonicalMemoryId,
            options
          ),
          project: async () => {
            const projection = await this.queries.memory(canonicalRoleId, canonicalMemoryId, { ...stableContext, fresh: true });
            if (!projection) throw new RoleStorageApplicationError(
              "The committed memory projection is unavailable.", "projection_unavailable", 503, operationId, "committed");
            this.queries.publishMemory(canonicalRoleId, projection.memory);
            return projection;
          }
        });
      } catch (error) {
        if (attempt === 0
          && error instanceof RoleStorageApplicationError
          && error.code === "revision_conflict") continue;
        throw error;
      }
    }
    throw new RoleStorageApplicationError(
      "Recent-memory view could not acquire a stable revision.",
      "revision_conflict",
      412,
      operationId
    );
  }

  requestMemoryConsolidation(roleId: string, input: Parameters<ManagerStorageMutationPool["requestMemoryConsolidation"]>[1], context: RoleStorageCommandContext = {}): Promise<RoleStorageCommit<MemoryConsolidationRequest, RoleStorageConsolidationProjection | null>> {
    let runId = "";
    return this.commit({
      operation: "memory-consolidation-request",
      roleId,
      payload: input,
      context,
      expectedRevision: async () => null,
      mutate: async options => {
        const committed = await this.mutationPool.requestMemoryConsolidation(roleId, input, options);
        runId = committed.run.id;
        return committed;
      },
      project: () => this.queries.consolidationRun(roleId, runId, context)
    });
  }

  markMemoryConsolidationDelivered(roleId: string, runId: string, deliveredAt: string | undefined, context: RoleStorageCommandContext = {}): Promise<RoleStorageCommit<MemoryConsolidationRun, RoleStorageConsolidationProjection | null>> {
    return this.commit({
      operation: "memory-consolidation-mark-delivered",
      roleId,
      resourceId: runId,
      payload: { deliveredAt: deliveredAt ?? null },
      allowResourceDerivedKey: true,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.markMemoryConsolidationDelivered(roleId, runId, options, deliveredAt),
      project: () => this.queries.consolidationRun(roleId, runId, context)
    });
  }

  applyMemoryConsolidation(roleId: string, runId: string, body: Record<string, unknown>, context: RoleStorageCommandContext = {}): Promise<RoleStorageCommit<unknown, RoleStorageConsolidationProjection | null>> {
    return this.commit({
      operation: "memory-consolidation-apply",
      roleId,
      resourceId: runId,
      payload: body,
      allowResourceDerivedKey: true,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.applyMemoryConsolidation(roleId, runId, body, options),
      project: () => this.queries.consolidationRun(roleId, runId, context)
    });
  }

  submitPlanFeedback(roleId: string, planId: string, input: Omit<SubmitPlanFeedbackInput, "roleDir" | "roleId" | "planId" | "expectedRevision">, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<SubmitPlanFeedbackResult, RoleStoragePlanFeedbackProjection>> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    const feedbackId = typeof input.feedbackId === "string" && input.feedbackId.trim()
      ? input.feedbackId.trim()
      : undefined;
    return this.commitProjection({
      operation: "plan-feedback-submit",
      roleId,
      resourceId: feedbackId ? `${canonicalPlanId}:${feedbackId}` : canonicalPlanId,
      payload: input,
      allowResourceDerivedKey: feedbackId !== undefined,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate: options => this.mutationPool.submitPlanFeedback(roleId, canonicalPlanId, input, options),
      project: async () => {
        const projection = await this.queries.planFeedback(roleId, canonicalPlanId, context);
        if (!projection) throw new RoleStorageApplicationError("The committed feedback projection is unavailable.", "projection_unavailable", 503, undefined, "committed");
        return projection;
      }
    });
  }

  updatePlanFeedbackDelivery(roleId: string, planId: string, record: PlanFeedbackRecord, status: Exclude<PlanFeedbackDeliveryStatus, "record_only">, message: string | undefined, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanFeedbackRecord, RoleStoragePlanFeedbackProjection>> {
    return this.feedbackTransition("plan-feedback-delivery-update", roleId, planId, record, { status, message }, context,
      options => this.mutationPool.updatePlanFeedbackDelivery(roleId, planId, record, status, options, message));
  }

  updatePlanFeedbackQaHandling(roleId: string, planId: string, record: PlanFeedbackRecord, qaHandling: PlanQaFeedbackHandling, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanFeedbackRecord, RoleStoragePlanFeedbackProjection>> {
    return this.feedbackTransition("plan-feedback-qa-update", roleId, planId, record, qaHandling, context,
      options => this.mutationPool.updatePlanFeedbackQaHandling(roleId, planId, record, qaHandling, options));
  }

  updatePlanFeedbackPostCommit(roleId: string, planId: string, record: PlanFeedbackRecord, status: PlanFeedbackPostCommit["status"], message: string | undefined, context: RoleStorageCommandContext = {}): Promise<RoleStorageProjectedCommit<PlanFeedbackRecord, RoleStoragePlanFeedbackProjection>> {
    return this.feedbackTransition("plan-feedback-post-commit-update", roleId, planId, record, { status, message }, context,
      options => this.mutationPool.updatePlanFeedbackPostCommit(roleId, planId, record, status, options, message));
  }

  async appendRolePanelTimeline(
    roleId: string,
    message: RolePanelTimelineMessage,
    context: RoleStorageCommandContext = {}
  ): Promise<RoleStorageCommandReceipt<RolePanelTimelineAppendResult>> {
    const canonicalRoleId = canonicalStorageMutationRoleId(roleId);
    if (message.roleId !== canonicalRoleId) {
      throw new RoleStorageApplicationError("Role panel timeline message identity does not match its role.", "invalid_request", 400);
    }
    const parsedRevision = parseRoleStorageExpectedRevision(context.expectedRevision);
    if (parsedRevision !== undefined && parsedRevision !== null) {
      throw new RoleStorageApplicationError("Role panel timeline append expectedRevision must be null.", "invalid_request", 400);
    }
    const operationId = stableRoleStorageOperationId({
      operation: "role-panel-timeline-append",
      roleId: canonicalRoleId,
      resourceId: message.id,
      explicitIdempotencyKey: context.idempotencyKey,
      allowResourceDerivedKey: true
    });
    this.assertPoolGeneration();
    const auditBase = {
      group: roleStorageAuditGroup("role-panel-timeline-append"),
      owner: "role-storage",
      action: "role-panel-timeline-append",
      target: { type: "timeline-message", id: message.id },
      dataSource: { kind: "ledger" as const, id: roleStorageDataSource(canonicalRoleId, "role-panel-timeline-append") },
      operationId
    };
    const startedAt = Date.now();
    recordDataMutationAudit({ ...auditBase, event: "role_storage_mutation_started", outcome: "started" });
    let commit: RolePanelTimelineAppendResult;
    try {
      commit = await this.mutationPool.appendRolePanelTimeline(canonicalRoleId, message, {
        idempotencyKey: operationId,
        expectedRevision: null,
        signal: context.signal,
        timeoutMs: context.timeoutMs
      });
    } catch (error) {
      const publicError = publicMutationError(error, operationId);
      const outcome = roleStorageMutationOutcome(publicError);
      recordDataMutationAudit({
        ...auditBase,
        level: outcome === "rejected" ? "warn" : "error",
        event: "role_storage_mutation_failed",
        outcome,
        durationMs: Date.now() - startedAt,
        result: publicError.code,
        error: publicError
      });
      throw publicError;
    }
    const afterRevision = storageMutationRevisionToken(commit);
    recordDataMutationAudit({
      ...auditBase,
      event: "role_storage_mutation_committed",
      outcome: "committed",
      after: afterRevision ? { revision: afterRevision } : undefined,
      durationMs: Date.now() - startedAt
    });
    try {
      this.assertPoolGeneration();
    } catch (error) {
      const publicError = publicReadError(error, operationId, true);
      recordDataMutationAudit({
        ...auditBase,
        level: "error",
        event: "role_storage_projection_failed",
        outcome: "failed",
        after: afterRevision ? { revision: afterRevision } : undefined,
        durationMs: Date.now() - startedAt,
        result: "mutation_committed",
        error: publicError
      });
      throw publicError;
    }
    return Object.freeze({ operationId, expectedRevision: null, commit });
  }

  private feedbackTransition(
    operation: string,
    roleId: string,
    planId: string,
    record: PlanFeedbackRecord,
    payload: unknown,
    context: RoleStorageCommandContext,
    mutate: (options: { idempotencyKey: string; expectedRevision: string | null; signal?: AbortSignal; timeoutMs?: number }) => Promise<PlanFeedbackRecord>
  ): Promise<RoleStorageProjectedCommit<PlanFeedbackRecord, RoleStoragePlanFeedbackProjection>> {
    const canonicalPlanId = canonicalStorageMutationPlanId(planId);
    return this.commitProjection({
      operation,
      roleId,
      resourceId: `${canonicalPlanId}:${record.id}`,
      payload,
      context,
      expectedRevision: () => this.requiredExpectedRevision(context.expectedRevision),
      mutate,
      project: async () => {
        const projection = await this.queries.planFeedback(roleId, canonicalPlanId, context);
        if (!projection) throw new RoleStorageApplicationError("The committed feedback projection is unavailable.", "projection_unavailable", 503, undefined, "committed");
        return projection;
      }
    });
  }
}

export class RoleStorageApplication {
  readonly queries: RoleStorageQueries;
  readonly commands: RoleStorageCommands;
  private readonly mutationPool: RoleStorageMutationPool;

  constructor(options: RoleStorageApplicationOptions) {
    const rolesRoot = requiredIdentity(options.rolesRoot, "rolesRoot");
    const identity = Object.freeze({
      applicationGenerationId: requiredIdentity(options.applicationGenerationId, "applicationGenerationId"),
      managerInstanceId: requiredIdentity(options.managerInstanceId, "managerInstanceId")
    });
    const validatedOptions: RoleStorageApplicationOptions = Object.freeze({
      ...options,
      rolesRoot,
      ...identity
    });
    const queries = new RoleStorageQueries(validatedOptions, options.readPool, options.catalogReadPool);
    const mutationPool = options.mutationPool ?? new ManagerStorageMutationPool({
      rolesRoot,
      ...identity
    });
    const commands = new RoleStorageCommands(identity, mutationPool, queries);
    this.mutationPool = mutationPool;
    this.queries = queries;
    this.commands = commands;
  }

  status(): ManagerStorageMutationPoolStatus {
    return this.mutationPool.status();
  }

  stop(): Promise<void> {
    return this.mutationPool.stop();
  }
}

export function roleStorageHttpError(error: unknown): Readonly<{
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  const mapped = error instanceof RoleStorageApplicationError
    ? error
    : new RoleStorageApplicationError("Role storage request failed.", "mutation_failed", 500, undefined, "unknown");
  const nextAction = mapped.commitState === "committed"
    ? "The write succeeded. Read the resource to confirm its current contents; replay only the original payload with the same Idempotency-Key if the receipt is still needed."
    : mapped.commitState === "unknown"
      ? "Read the resource and original operation receipt. Retry only the original payload with the same Idempotency-Key; do not create a replacement operation."
      : mapped.code === "revision_conflict"
        ? "GET the latest resource and strong ETag, merge your intended changes with the current contents, then submit with If-Match."
        : mapped.code === "idempotency_conflict"
          ? "This key already identifies a different payload. Read that operation first; use a new key only for a separate intended change."
          : mapped.code === "invalid_request"
            ? "Correct the field described in message, then submit the corrected payload with a new Idempotency-Key."
            : mapped.code === "not_found"
              ? "Verify the role and resource ID, including archived plans. Do not recreate a plan just because this lookup failed."
              : mapped.code === "generation_mismatch"
                ? "Rediscover the Manager through Host, verify /meta, then read the resource again."
                : "The operation has not started. Check Manager readiness and retry the same operation after the reported delay.";
  return Object.freeze({
    statusCode: mapped.statusCode,
    headers: Object.freeze({
      "cache-control": "no-store",
      ...(mapped.statusCode >= 500 ? { "retry-after": "1" } : {}),
      ...(mapped.operationId ? { "idempotency-key": mapped.operationId } : {})
    }),
    body: Object.freeze({
      code: -1,
      state: mapped.code,
      message: mapped.message,
      commitState: mapped.commitState,
      reason: mapped.code,
      ...(mapped.causeCode ? { causeCode: mapped.causeCode } : {}),
      nextAction,
      retryable: mapped.commitState === "not_started" && mapped.code === "busy",
      ...(mapped.operationId ? { idempotencyKey: mapped.operationId } : {}),
      ...(mapped.code === "invalid_request" && mapped.operationId
        ? { retry: "correct_request_with_new_idempotency_key" }
        : {}),
      ...(mapped.commitState === "unknown" || mapped.commitState === "committed"
        ? { retry: "same_idempotency_key_only" }
        : {})
    })
  });
}
