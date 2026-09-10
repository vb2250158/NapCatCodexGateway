import {
  listPlanFeedback,
  updatePlanFeedbackDelivery,
  updatePlanFeedbackPostCommit,
  updatePlanFeedbackQaHandling
} from "../planFeedback.js";
import { submitPlanFeedback } from "../planFeedbackSubmission.js";
import {
  appendRolePanelTimelineMessageIfAbsent,
  findRolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import {
  applyMemoryConsolidationResult,
  createMemoryConsolidationRequest,
  createPlan,
  createRecentMemory,
  invalidateRoleMemoryCatalogForMutation,
  listConsolidatedMemories,
  listConsolidationRuns,
  listPlanHistory,
  listRecentMemories,
  readPlansFromStorageInWorker,
  markMemoryConsolidationRunDelivered,
  touchRecentMemory,
  updatePlan,
  updateRecentMemory
} from "../roleKnowledge.js";
import path from "node:path";
import { RoleStorageValidationError } from "../shared/roleStorageValidationError.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ROLE_MEMORY_CATALOG_LEASE_ID } from "../memoryStorageIdentity.js";
import {
  addPersonaPlanStatusDefinition,
  assertWritablePlanStatus,
  beginPersonaPlanStatusRetirement,
  completePersonaPlanStatusRetirement,
  readPersonaPlanWorkflow,
  updatePersonaPlanStatusDefinition,
  writePersonaPlanWorkflow,
  type PersonaPlanWorkflow,
  type PersonaPlanWorkflowStatus
} from "../personaPlanWorkflow.js";
import {
  readPlanStoragePackage,
  resolveCanonicalPlanStorageLocation,
  recoverPlanLifecycleTransitions,
  recoverPlanStorageTransactions,
  assertPlanStorageLeaseOwner,
  withPlanStorageLease,
  withPlanStorageLeaseAsync
} from "../planStorageRepository.js";
import {
  storageInventoryRevisionToken,
  storageMutationRevision,
  type StorageMutationStamp
} from "../shared/storageRevision.js";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
  storageMutationRoleDirectory,
  storageMutationRevisionToken,
  validateManagerStorageMutationRequest,
  type ManagerStorageMutationChildIdentity,
  type ManagerStorageMutationRequest,
  type ManagerStorageMutationResponse
} from "./managerStorageMutationProtocol.js";

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Storage mutation child requires ${name}.`);
  return value;
}

function childIdentity(): ManagerStorageMutationChildIdentity {
  return Object.freeze({
    applicationGenerationId: requiredEnvironment("RABIROUTE_APPLICATION_GENERATION_ID"),
    managerInstanceId: requiredEnvironment("RABIROUTE_MANAGER_INSTANCE_ID"),
    storageGenerationLease: requiredEnvironment("RABIROUTE_STORAGE_GENERATION_LEASE"),
    rolesRoot: requiredEnvironment("RABIROUTE_STORAGE_ROLES_ROOT")
  });
}

function serializable<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Storage mutation result is not JSON serializable.");
  return JSON.parse(encoded) as T;
}

function currentPlanRevision(roleDir: string, planId: string | undefined): string | null {
  if (!planId) return null;
  const location = resolveCanonicalPlanStorageLocation(roleDir, planId);
  if (!location) return null;
  return storageInventoryRevisionToken(readPlanStoragePackage(
    roleDir,
    location.planId,
    location.bucket
  ).inventoryHash);
}

function nonPlanStorageLeaseId(request: ManagerStorageMutationRequest): string {
  const task = request.task;
  if (task.type === "recent_memory_create"
    || task.type === "recent_memory_update"
    || task.type === "recent_memory_touch"
    || task.type === "memory_consolidation_request"
    || task.type === "memory_consolidation_mark_delivered"
    || task.type === "memory_consolidation_apply") {
    return ROLE_MEMORY_CATALOG_LEASE_ID;
  }
  const resource = task.type === "role_panel_timeline_append"
    ? `role-panel-timeline:${request.fence.roleId}:${task.message.id}`
    : `role-storage:${request.fence.roleId}`;
  return `storage-${createHash("sha256").update(resource, "utf8").digest("hex").slice(0, 40)}`;
}

function currentRevision(request: ManagerStorageMutationRequest, roleDir: string): string | null {
  const planId = request.fence.planId;
  const task = request.task;
  switch (task.type) {
    case "plan_status_create":
    case "plan_status_update":
    case "plan_status_delete":
      return readPersonaPlanWorkflow(roleDir)?.revision ?? null;
    case "plan_create":
      return currentPlanRevision(roleDir, planId);
    case "recent_memory_create": {
      const memoryId = String(task.input.id || "").trim();
      return memoryId
        ? storageMutationRevisionToken(listRecentMemories(roleDir).find(item => item.id === memoryId))
        : null;
    }
    case "memory_consolidation_request":
    case "role_panel_timeline_append":
      return null;
    case "plan_update":
    case "plan_secretary_binding_update":
    case "plan_task_binding_update":
    case "plan_feedback_submit":
      return currentPlanRevision(roleDir, planId);
    case "recent_memory_update":
    case "recent_memory_touch":
      return storageMutationRevisionToken(listRecentMemories(roleDir).find(item => item.id === task.memoryId));
    case "memory_consolidation_mark_delivered":
    case "memory_consolidation_apply": {
      const run = listConsolidationRuns(roleDir).find(item => item.id === task.runId);
      return storageMutationRevisionToken(run);
    }
    case "plan_feedback_delivery_update":
    case "plan_feedback_qa_update":
    case "plan_feedback_post_commit_update":
      return storageMutationRevisionToken(listPlanFeedback(roleDir, planId!)
        .find(item => item.id === task.record.id));
  }
}

type PersonaPlanStatusMutationResult = Readonly<{
  workflow: PersonaPlanWorkflow;
  revision: string;
  status: PersonaPlanWorkflowStatus;
  migratedPlanIds: string[];
}>;

function requiredPlanWorkflow(roleDir: string) {
  const current = readPersonaPlanWorkflow(roleDir);
  if (!current) throw new Error("Persona plan workflow is required before changing plan statuses.");
  return current;
}

function mutatePersonaPlanStatus(
  validated: ManagerStorageMutationRequest,
  roleDir: string,
  mutation: StorageMutationStamp
): PersonaPlanStatusMutationResult {
  return withPlanStorageLease(roleDir, nonPlanStorageLeaseId(validated), lease => {
    const checkpoint = (): void => assertPlanStorageLeaseOwner(lease);
    checkpoint();
    assertExpectedRevision(validated, roleDir);
    const current = requiredPlanWorkflow(roleDir);
    const task = validated.task;
    const workflow: PersonaPlanWorkflow = JSON.parse(JSON.stringify(current.workflow)) as PersonaPlanWorkflow;
    let status: PersonaPlanWorkflowStatus;
    const migratedPlanIds: string[] = [];
    if (task.type === "plan_status_create") {
      const input = { ...task.input } as PersonaPlanWorkflowStatus;
      const nextWorkflow = addPersonaPlanStatusDefinition(workflow, input);
      status = nextWorkflow.statuses.find(candidate => candidate.key === input.key)!;
      const written = writePersonaPlanWorkflow(roleDir, nextWorkflow, current.revision);
      checkpoint();
      return { ...written, status, migratedPlanIds };
    }
    if (task.type === "plan_status_update") {
      const index = workflow.statuses.findIndex(candidate => candidate.key === task.statusKey);
      if (index < 0) throw new Error(`Plan status not found: ${task.statusKey}.`);
      const nextWorkflow = updatePersonaPlanStatusDefinition(workflow, task.statusKey, task.patch);
      status = nextWorkflow.statuses.find(candidate => candidate.key === task.statusKey)!;
      const written = writePersonaPlanWorkflow(roleDir, nextWorkflow, current.revision);
      checkpoint();
      return { ...written, status, migratedPlanIds };
    }
    if (task.type !== "plan_status_delete") {
      throw new Error(`Unsupported persona plan status mutation: ${task.type}.`);
    }
    if (task.statusKey === task.replacementKey) {
      throw new Error("replacementKey must differ from the retired plan status key.");
    }
    const index = workflow.statuses.findIndex(candidate => candidate.key === task.statusKey);
    if (index < 0) throw new Error(`Plan status not found: ${task.statusKey}.`);
    const replacement = assertWritablePlanStatus(workflow, task.replacementKey);
    const retiringWorkflow = beginPersonaPlanStatusRetirement(workflow, task.statusKey, replacement.key);
    for (const plan of readPlansFromStorageInWorker(roleDir)) {
      if (plan.archiveStatus === "已归档" || plan.status !== task.statusKey) continue;
      updatePlan(roleDir, plan.id, { status: replacement.key }, undefined, mutation);
      migratedPlanIds.push(plan.id);
      checkpoint();
    }
    const retiredWorkflow = completePersonaPlanStatusRetirement(retiringWorkflow, task.statusKey);
    status = retiredWorkflow.statuses.find(candidate => candidate.key === task.statusKey)!;
    const written = writePersonaPlanWorkflow(roleDir, retiredWorkflow, current.revision);
    checkpoint();
    return { ...written, status, migratedPlanIds };
  });
}

function assertExpectedRevision(request: ManagerStorageMutationRequest, roleDir: string): void {
  const current = currentRevision(request, roleDir);
  if (request.expectedRevision === current) return;
  throw new Error(
    `STORAGE_MUTATION_REVISION_CONFLICT: expected=${request.expectedRevision ?? "absent"}; current=${current ?? "absent"}.`
  );
}

function executeMemoryCatalogMutation<T>(
  validated: ManagerStorageMutationRequest,
  roleDir: string,
  action: (checkpoint: () => void) => T
): T {
  return withPlanStorageLease(roleDir, nonPlanStorageLeaseId(validated), lease => {
    const checkpoint = (): void => assertPlanStorageLeaseOwner(lease);
    checkpoint();
    invalidateRoleMemoryCatalogForMutation(roleDir);
    assertExpectedRevision(validated, roleDir);
    checkpoint();
    const result = action(checkpoint);
    checkpoint();
    return result;
  });
}

type DomainDeliveryResult =
  | Readonly<{ domain: "committed"; value: unknown }>
  | Readonly<{ domain: "rejected"; error: string }>;

function deterministicDomainRejection(error: unknown): string | undefined {
  if (error instanceof RoleStorageValidationError) {
    return `STORAGE_MUTATION_VALIDATION_REJECTED: ${error.message}`;
  }
  if (error instanceof Error
    && (error as Error & { code?: string }).code === "PLAN_STORAGE_LEASE_LOST") return undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("STORAGE_MUTATION_REVISION_CONFLICT:")
    || message.startsWith("PERSONA_PLAN_WORKFLOW_REVISION_CONFLICT:")
    || /\bnot found\b/i.test(message)
    || /\balready exists\b/i.test(message)
    || /\b(?:required|invalid|unsupported|immutable)\b/i.test(message)
    || /\bnot enabled\b/i.test(message)
    || /immutable terminal/i.test(message)
    || /does not match/i.test(message)) return message;
  return undefined;
}

async function executeDomainMutation(
  validated: ManagerStorageMutationRequest,
  roleDir: string
): Promise<unknown> {
  const planId = validated.fence.planId;
  const mutation: StorageMutationStamp = Object.freeze({
    requestId: validated.requestId,
    revision: storageMutationRevision(validated.requestId)
  });
  switch (validated.task.type) {
    case "plan_status_create":
    case "plan_status_update":
    case "plan_status_delete":
      return mutatePersonaPlanStatus(validated, roleDir, mutation);
    case "plan_create":
      return createPlan(roleDir, { ...validated.task.input, id: planId }, mutation);
    case "plan_update":
      return updatePlan(roleDir, planId!, validated.task.patch, validated.expectedRevision ?? undefined, mutation);
    case "plan_secretary_binding_update":
      return updatePlan(
        roleDir,
        planId!,
        { secretaryBinding: validated.task.binding },
        validated.expectedRevision ?? undefined,
        mutation
      );
    case "plan_task_binding_update":
      return updatePlan(
        roleDir,
        planId!,
        { taskBinding: validated.task.binding },
        validated.expectedRevision ?? undefined,
        mutation
      );
    case "recent_memory_create": {
      const task = validated.task;
      return executeMemoryCatalogMutation(validated, roleDir, checkpoint =>
        createRecentMemory(roleDir, task.input, mutation, checkpoint)
      );
    }
    case "recent_memory_update": {
      const task = validated.task;
      return executeMemoryCatalogMutation(validated, roleDir, checkpoint =>
        updateRecentMemory(roleDir, task.memoryId, task.patch, mutation, checkpoint)
      );
    }
    case "recent_memory_touch": {
      const task = validated.task;
      return executeMemoryCatalogMutation(validated, roleDir, checkpoint =>
        touchRecentMemory(roleDir, task.memoryId, mutation, undefined, checkpoint)
      );
    }
    case "memory_consolidation_request": {
      const task = validated.task;
      return executeMemoryCatalogMutation(validated, roleDir, checkpoint =>
        createMemoryConsolidationRequest(roleDir, task.options, mutation, checkpoint)
      );
    }
    case "memory_consolidation_mark_delivered": {
      const task = validated.task;
      return executeMemoryCatalogMutation(validated, roleDir, checkpoint =>
        markMemoryConsolidationRunDelivered(roleDir, task.runId, task.deliveredAt, mutation, checkpoint)
      );
    }
    case "memory_consolidation_apply": {
      const task = validated.task;
      return await withPlanStorageLeaseAsync(roleDir, nonPlanStorageLeaseId(validated), async lease => {
        const checkpoint = (): void => assertPlanStorageLeaseOwner(lease);
        checkpoint();
        invalidateRoleMemoryCatalogForMutation(roleDir);
        assertExpectedRevision(validated, roleDir);
        checkpoint();
        const result = await applyMemoryConsolidationResult(
          roleDir,
          task.runId,
          task.body,
          mutation,
          checkpoint
        );
        checkpoint();
        return result;
      });
    }
    case "role_panel_timeline_append": {
      const task = validated.task;
      return withPlanStorageLease(roleDir, nonPlanStorageLeaseId(validated), () => {
        assertExpectedRevision(validated, roleDir);
        return appendRolePanelTimelineMessageIfAbsent(roleDir, task.message);
      });
    }
    case "plan_feedback_submit":
      return submitPlanFeedback({
        ...validated.task.input,
        roleDir,
        roleId: validated.fence.roleId,
        planId: planId!,
        expectedRevision: validated.expectedRevision ?? undefined,
        storageRevision: mutation.revision,
        storageMutationRequestId: mutation.requestId
      });
    case "plan_feedback_delivery_update":
      return updatePlanFeedbackDelivery(
        roleDir,
        validated.task.record,
        validated.task.deliveryStatus,
        validated.task.deliveryMessage,
        validated.expectedRevision ?? undefined,
        mutation
      );
    case "plan_feedback_qa_update":
      return updatePlanFeedbackQaHandling(
        roleDir,
        validated.task.record,
        validated.task.qaHandling,
        validated.expectedRevision ?? undefined,
        mutation
      );
    case "plan_feedback_post_commit_update":
      return updatePlanFeedbackPostCommit(
        roleDir,
        validated.task.record,
        validated.task.status,
        validated.task.message,
        validated.expectedRevision ?? undefined,
        mutation
      );
  }
}

function committedEnvelope(value: unknown): DomainDeliveryResult {
  return { domain: "committed", value: serializable(value) };
}

function recoveredDomainValue(
  validated: ManagerStorageMutationRequest,
  roleDir: string
): unknown | undefined {
  const requestId = validated.requestId;
  const planId = validated.fence.planId;
  const task = validated.task;
  switch (task.type) {
    case "plan_status_create": {
      const current = readPersonaPlanWorkflow(roleDir);
      if (!current) return undefined;
      const input = task.input as Partial<PersonaPlanWorkflowStatus>;
      const status = current.workflow.statuses.find(candidate => candidate.key === input.key);
      return status && isDeepStrictEqual(status, input)
        ? { ...current, status, migratedPlanIds: [] }
        : undefined;
    }
    case "plan_status_update": {
      const current = readPersonaPlanWorkflow(roleDir);
      const status = current?.workflow.statuses.find(candidate => candidate.key === task.statusKey);
      if (!current || !status) return undefined;
      const desired = { ...status, ...task.patch, key: status.key };
      return isDeepStrictEqual(status, desired)
        ? { ...current, status, migratedPlanIds: [] }
        : undefined;
    }
    case "plan_status_delete": {
      const current = readPersonaPlanWorkflow(roleDir);
      const status = current?.workflow.statuses.find(candidate => candidate.key === task.statusKey);
      if (!current || status?.state !== "retired") return undefined;
      const remaining = readPlansFromStorageInWorker(roleDir)
        .filter(plan => plan.archiveStatus !== "已归档" && plan.status === task.statusKey);
      if (remaining.length > 0 || Object.values(current.workflow.roles).includes(task.statusKey)) return undefined;
      return { ...current, status, migratedPlanIds: [] };
    }
    case "plan_create":
    case "plan_update":
    case "plan_secretary_binding_update":
    case "plan_task_binding_update": {
      const history = listPlanHistory(roleDir, planId!);
      return [...history].reverse().find(record => record.after.storageMutationRequestId === requestId)?.after;
    }
    case "recent_memory_create": {
      const memoryId = String(task.input.id || "").trim();
      return listRecentMemories(roleDir).find(item =>
        (!memoryId || item.id === memoryId) && item.storageMutationRequestId === requestId
      );
    }
    case "recent_memory_update":
    case "recent_memory_touch":
      return listRecentMemories(roleDir).find(item =>
        item.id === task.memoryId && item.storageMutationRequestId === requestId
      );
    case "memory_consolidation_request": {
      const run = listConsolidationRuns(roleDir).find(item => item.storageMutationRequestId === requestId);
      if (!run) return undefined;
      const memories = listRecentMemories(roleDir).filter(item => run.inputMemoryIds.includes(item.id));
      return { run, memories };
    }
    case "memory_consolidation_mark_delivered": {
      const run = listConsolidationRuns(roleDir).find(item => item.id === task.runId);
      return run?.storageMutationRequestId === requestId ? run : undefined;
    }
    case "memory_consolidation_apply": {
      const run = listConsolidationRuns(roleDir).find(item => item.id === task.runId);
      if (!run || run.storageMutationRequestId !== requestId) return undefined;
      const memories = listConsolidatedMemories(roleDir)
        .filter(item => item.consolidationRunId === run.id || run.outputMemoryIds?.includes(item.id));
      return { run, memories };
    }
    case "role_panel_timeline_append": {
      const message = findRolePanelTimelineMessage(
        roleDir,
        validated.fence.roleId,
        task.message.id
      );
      return message ? { message, appended: false } : undefined;
    }
    case "plan_feedback_submit": {
      const record = listPlanFeedback(roleDir, planId!)
        .find(item => item.storageMutationRequestId === requestId);
      if (!record) return undefined;
      const plan = readPlansFromStorageInWorker(roleDir).find(item => item.id === planId);
      if (!plan) return undefined;
      return {
        record,
        created: true,
        plan
      };
    }
    case "plan_feedback_delivery_update":
    case "plan_feedback_qa_update":
    case "plan_feedback_post_commit_update":
      return listPlanFeedback(roleDir, planId!).find(item =>
        item.id === task.record.id && item.storageMutationRequestId === requestId
      );
  }
}

function recoverDomainTransactions(validated: ManagerStorageMutationRequest, roleDir: string): string[] {
  if (!validated.fence.planId) return [];
  const failures = recoverPlanLifecycleTransitions(roleDir).failures.map(item => item.error);
  if (validated.task.type.startsWith("plan_feedback_")) {
    failures.push(...recoverPlanStorageTransactions(roleDir).failures.map(item => item.error));
  }
  return failures;
}

async function recoverDomainMutation(
  validated: ManagerStorageMutationRequest,
  roleDir: string
): Promise<
  | { state: "completed"; result: DomainDeliveryResult }
  | { state: "retry" }
  | { state: "uncertain"; reason: string }
> {
  const recoveryFailures = recoverDomainTransactions(validated, roleDir);
  if (recoveryFailures.length > 0) {
    return {
      state: "uncertain",
      reason: `Domain transaction recovery failed: ${recoveryFailures.join("; ")}`
    };
  }
  const recovered = recoveredDomainValue(validated, roleDir);
  if (recovered !== undefined) {
    return { state: "completed", result: committedEnvelope(recovered) };
  }
  if (currentRevision(validated, roleDir) === validated.expectedRevision) {
    return { state: "retry" };
  }
  return {
    state: "uncertain",
    reason: "The domain revision changed without a matching mutation proof; manual recovery is required."
  };
}

async function execute(request: ManagerStorageMutationRequest, identity: ManagerStorageMutationChildIdentity): Promise<unknown> {
  const validated = validateManagerStorageMutationRequest(request, identity);
  const roleDir = storageMutationRoleDirectory(identity.rolesRoot, validated.fence.roleId);
  const receiptRoot = path.join(roleDir, "runtime");
  const receiptNamespace = MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE;
  // A stale caller is rejected before reserving an idempotency receipt. Once a
  // receipt enters sending, every failure is conservatively non-retryable until
  // the domain WAL/startup recovery proves the commit state.
  if (!readDurableDeliveryReceipt(receiptRoot, receiptNamespace, validated.requestId)) {
    assertExpectedRevision(validated, roleDir);
  }
  const outcome = await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: receiptNamespace,
    deliveryId: validated.requestId,
    payload: {
      roleId: validated.fence.roleId,
      planId: validated.fence.planId,
      task: validated.task
    },
    audit: {
      expectedRevision: validated.expectedRevision
    },
    deliver: async (): Promise<DomainDeliveryResult> => {
      try {
        return committedEnvelope(await executeDomainMutation(validated, roleDir));
      } catch (error) {
        const rejection = deterministicDomainRejection(error);
        if (rejection) return { domain: "rejected", error: rejection };
        throw error;
      }
    },
    recover: () => recoverDomainMutation(validated, roleDir),
    recoverExistingUncertain: true,
    retryableRejection: result => result.domain === "rejected"
      && result.error.startsWith("STORAGE_MUTATION_REVISION_CONFLICT:"),
    waitForCompletionMs: 250
  });
  if (outcome.state === "completed") {
    const result = outcome.result as DomainDeliveryResult | unknown;
    if (result && typeof result === "object" && (result as { domain?: unknown }).domain === "rejected") {
      throw new Error(String((result as { error?: unknown }).error || "STORAGE_MUTATION_REVISION_CONFLICT: rejected."));
    }
    if (result && typeof result === "object" && (result as { domain?: unknown }).domain === "committed") {
      return (result as { value: unknown }).value;
    }
    // Backward-compatible replay of receipts written before the domain envelope.
    return result;
  }
  throw new Error(
    `STORAGE_MUTATION_${outcome.state.toUpperCase()}: ${outcome.reason}`
  );
}

function send(response: ManagerStorageMutationResponse): void {
  if (typeof process.send !== "function") throw new Error("Storage mutation child requires an IPC channel.");
  process.send(serializable(response));
}

const identity = childIdentity();
let running = false;

process.on("message", (raw: unknown) => {
  const request = raw as ManagerStorageMutationRequest;
  if (running) {
    send({
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: String(request?.requestId || "invalid"),
      fence: request?.fence,
      ok: false,
      message: "Storage mutation child rejects concurrent commands."
    } as ManagerStorageMutationResponse);
    return;
  }
  running = true;
  void execute(request, identity).then(value => {
    send({
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: request.requestId,
      fence: request.fence,
      ok: true,
      value: serializable(value)
    });
  }, error => {
    send({
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: String(request?.requestId || "invalid"),
      fence: request?.fence,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(-8 * 1024) : undefined
    } as ManagerStorageMutationResponse);
  }).finally(() => {
    running = false;
  });
});

process.once("disconnect", () => process.exit(0));
