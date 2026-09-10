import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import { createPlan, createRecentMemory, listRecentMemories, touchRecentMemory } from "../roleKnowledge.js";
import { ROLE_MEMORY_CATALOG_LEASE_ID } from "../memoryStorageIdentity.js";
import {
  planStorageLeasePath,
  readPlanStoragePackage,
  withPlanStorageLeaseAsync
} from "../planStorageRepository.js";
import {
  appendRolePanelTimelineMessageIfAbsent,
  readRolePanelTimeline,
  type RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import { storageInventoryRevisionToken, storageMutationRevision, storageRevisionToken } from "../shared/storageRevision.js";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
  type ManagerStorageMutationRequest,
  type ManagerStorageMutationResponse
} from "./managerStorageMutationProtocol.js";
import {
  ManagerStorageMutationError,
  ManagerStorageMutationPool,
  type ManagerStorageMutationChild,
  type ManagerStorageMutationOptions
} from "./managerStorageMutationPool.js";

class FakeDiagnosticStream extends EventEmitter {
  destroy(): void {}
}

class FakeChild extends EventEmitter implements ManagerStorageMutationChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly stdout = new FakeDiagnosticStream();
  readonly stderr = new FakeDiagnosticStream();
  readonly channel = { unref(): void {} };
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(
    readonly pid: number,
    private readonly onSend: (request: ManagerStorageMutationRequest, child: FakeChild) => void,
    private readonly onKill: (signal: NodeJS.Signals | number | undefined, child: FakeChild) => void = () => {}
  ) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.onSend(message as ManagerStorageMutationRequest, this);
    callback?.(null);
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.onKill(signal, this);
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  unref(): void {}

  respond(request: ManagerStorageMutationRequest, value: unknown): void {
    this.emit("message", {
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: request.requestId,
      fence: request.fence,
      ok: true,
      value
    } satisfies ManagerStorageMutationResponse);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit("close", code, signal);
  }
}

function operation(idempotencyKey: string, expectedRevision: string | null = null): ManagerStorageMutationOptions {
  return { idempotencyKey, expectedRevision, timeoutMs: 15_000 };
}

function planRevision(roleDir: string, planId: string): string {
  const plan = readPlanStoragePackage(roleDir, planId, "active");
  return storageInventoryRevisionToken(plan.inventoryHash);
}

function tempRolesRoot(t: test.TestContext): { rolesRoot: string; roleDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-storage-mutation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "YeYu");
  fs.mkdirSync(roleDir, { recursive: true });
  return { rolesRoot, roleDir };
}

test("terminal plan validation resolves legacy uncertain receipts without changing the plan", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const plan = createPlan(roleDir, {
    id: "terminal-validation", title: "Terminal validation", focus: "Report invalid completion accurately",
    status: "分析中", currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }], keywords: ["validation"]
  });
  const before = planRevision(roleDir, plan.id);
  const patch = { status: "完成", currentStepId: "verify" };
  const key = "legacy-terminal-validation";
  const rootDir = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir, namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, deliveryId: key,
    payload: { roleId: "YeYu", planId: plan.id, task: { type: "plan_update", patch } },
    deliver: async () => { throw new Error("Plan status 完成 forbids currentStepId."); }
  });
  const pool = new ManagerStorageMutationPool({ rolesRoot, applicationGenerationId: "validation-generation", managerInstanceId: "validation-manager" });
  t.after(() => pool.stop());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(pool.updatePlan("YeYu", plan.id, patch, operation(key, before)),
      (error: unknown) => error instanceof ManagerStorageMutationError
        && error.code === "validation_rejected" && /forbids currentStepId/.test(error.message));
    assert.equal(planRevision(roleDir, plan.id), before);
  }
  const receipt = readDurableDeliveryReceipt(rootDir, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, key);
  assert.equal(receipt?.state, "completed");
  assert.equal((receipt?.result as { domain: string }).domain, "rejected");
  const corrected = await pool.updatePlan("YeYu", plan.id, { status: "完成", currentStepId: null }, operation("corrected-terminal-validation", before));
  assert.equal(corrected.status, "完成");
  assert.equal(corrected.currentStepId, undefined);
});

test("plan mutation revision checks ignore unrelated malformed plan packages", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const plan = createPlan(roleDir, {
    id: "point-revision", title: "Point revision", focus: "Read the addressed plan only", status: "分析中",
    currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }], keywords: ["revision"]
  });
  const before = planRevision(roleDir, plan.id);
  const unrelated = path.join(roleDir, "plans", "active", "unrelated");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "plan.json"), "invalid JSON");
  const pool = new ManagerStorageMutationPool({ rolesRoot, applicationGenerationId: "point-generation", managerInstanceId: "point-manager" });
  t.after(() => pool.stop());
  const result = await pool.updatePlan("YeYu", plan.id, { title: "Point revision updated" }, operation("point-revision-update", before));
  assert.equal(result.title, "Point revision updated");
});

test("storage mutation child serializes plan, memory, secretary, and feedback writes with durable replay", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-one",
    managerInstanceId: "manager-instance-one",
    storageGenerationLeaseFactory: ({ applicationGenerationId, managerInstanceId }) =>
      `storage-${applicationGenerationId}-${managerInstanceId}`
  });
  t.after(() => pool.stop());

  const createdPlan = await pool.createPlan("YeYu", "plan-one", {
    title: "Storage mutation plan",
    focus: "Prove one fenced mutation channel",
    status: "执行中",
    currentStepId: "verify",
    nextAction: "Run the next command",
    steps: [{ id: "verify", title: "Verify the channel", status: "进行中" }],
    keywords: ["storage", "mutation"]
  }, operation("create-plan-one"));
  assert.equal(createdPlan.id, "plan-one");

  const replayedPlan = await pool.createPlan("YeYu", "plan-one", {
    title: "Storage mutation plan",
    focus: "Prove one fenced mutation channel",
    status: "执行中",
    currentStepId: "verify",
    nextAction: "Run the next command",
    steps: [{ id: "verify", title: "Verify the channel", status: "进行中" }],
    keywords: ["storage", "mutation"]
  }, operation("create-plan-one"));
  assert.deepEqual(replayedPlan, createdPlan);

  const assigned = await pool.updatePlanSecretaryBinding("YeYu", createdPlan.id, {
    agentType: "codex",
    sessionId: "secretary-one",
    sessionTitle: "Secretary",
    workspace: "C:\\workspace",
    assignedAt: new Date().toISOString()
  }, operation("assign-secretary-one", planRevision(roleDir, createdPlan.id)));
  assert.equal(assigned.secretaryBinding?.sessionId, "secretary-one");

  const taskBinding = {
    agentType: "codex" as const,
    sessionId: "task-one",
    sessionTitle: "Task one",
    workspace: "C:\\workspace"
  };
  const taskBindingRevision = planRevision(roleDir, assigned.id);
  const bound = await pool.updatePlanTaskBinding(
    "YeYu",
    assigned.id,
    taskBinding,
    operation("bind-task-one", taskBindingRevision)
  );
  const replayedBinding = await pool.updatePlanTaskBinding(
    "YeYu",
    assigned.id,
    taskBinding,
    operation("bind-task-one", taskBindingRevision)
  );
  assert.equal(bound.taskBinding?.sessionId, "task-one");
  assert.deepEqual(replayedBinding, bound);

  const memory = await pool.createRecentMemory("YeYu", {
    id: "memory-one",
    title: "Mutation result",
    focus: "Remember the storage mutation contract",
    content: "The child returned a serializable result.",
    keywords: ["storage", "child"]
  }, operation("create-memory-one"));
  const updatedMemory = await pool.updateRecentMemory("YeYu", memory.id, {
    content: "The child returned one durable serializable result."
  }, operation("update-memory-one", storageRevisionToken(memory)));
  assert.match(updatedMemory.content, /durable/);

  const submitted = await pool.submitPlanFeedback("YeYu", bound.id, {
    feedbackId: "feedback-one",
    kind: "approval_suggestion",
    author: "user",
    source: "api",
    text: "Keep the mutation channel fenced.",
    notifyAgent: true
  }, operation("submit-feedback-one", planRevision(roleDir, bound.id)));
  const delivered = await pool.updatePlanFeedbackDelivery(
    "YeYu",
    bound.id,
    submitted.record,
    "delivered",
    operation("deliver-feedback-one", storageRevisionToken(submitted.record)),
    "accepted"
  );
  assert.equal(delivered.deliveryStatus, "delivered");

  assert.deepEqual(delivered, JSON.parse(JSON.stringify(delivered)));
  assert.equal(pool.status().spawnedChildren, 1);
  assert.match(pool.status().storageGenerationLease, /application-generation-one-manager-instance-one/);
  const receiptDirectory = path.join(roleDir, "runtime", "data", "storage-mutation-idempotency");
  assert.equal(fs.readdirSync(receiptDirectory).filter(name => name.endsWith(".json")).length, 7);

  await pool.stop();
  assert.equal(pool.status().state, "stopped");
});

test("recent-memory touch is CAS-guarded, replay-safe, and distinct view events do not deduplicate", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "recent-memory-touch-generation",
    managerInstanceId: "recent-memory-touch-manager"
  });
  t.after(() => pool.stop());
  const created = await pool.createRecentMemory("YeYu", {
    id: "memory-touch",
    title: "Touch contract",
    focus: "Keep view metadata on the mutation child",
    content: "The content timestamp must remain stable.",
    keywords: ["touch", "memory"]
  }, operation("memory-touch-create"));
  const originalUpdatedAt = created.updatedAt;

  const first = await pool.touchRecentMemory(
    "YeYu",
    created.id,
    operation("memory-touch-view-one", storageRevisionToken(created))
  );
  const replay = await pool.touchRecentMemory(
    "YeYu",
    created.id,
    operation("memory-touch-view-one", storageRevisionToken(created))
  );
  assert.deepEqual(replay, first);
  assert.equal(first.updatedAt, originalUpdatedAt);
  assert.equal(first.storageMutationRequestId, "memory-touch-view-one");
  assert.equal(first.storageRevision, storageMutationRevision("memory-touch-view-one"));

  const second = await pool.touchRecentMemory(
    "YeYu",
    created.id,
    operation("memory-touch-view-two", storageRevisionToken(first))
  );
  assert.equal(second.updatedAt, originalUpdatedAt);
  assert.equal(second.storageMutationRequestId, "memory-touch-view-two");
  assert.equal(second.storageRevision, storageMutationRevision("memory-touch-view-two"));
  assert.notEqual(second.storageRevision, first.storageRevision);

  await assert.rejects(
    pool.touchRecentMemory("YeYu", created.id, operation("memory-touch-stale", storageRevisionToken(created))),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "revision_conflict"
  );
  const stored = listRecentMemories(roleDir).find(item => item.id === created.id);
  assert.equal(stored?.id, second.id);
  assert.equal(stored?.updatedAt, second.updatedAt);
  assert.equal(stored?.viewedAt, second.viewedAt);
  assert.equal(stored?.storageRevision, second.storageRevision);
  assert.equal(stored?.storageMutationRequestId, second.storageMutationRequestId);
  assert.equal(
    readDurableDeliveryReceipt(
      path.join(roleDir, "runtime"),
      MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
      "memory-touch-stale"
    ),
    null
  );
});

test("independent Managers cannot commit two logical memory ids with one lossy storage key", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const firstPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "memory-collision-generation-one",
    managerInstanceId: "memory-collision-manager-one"
  });
  const secondPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "memory-collision-generation-two",
    managerInstanceId: "memory-collision-manager-two"
  });
  t.after(async () => { await Promise.allSettled([firstPool.stop(), secondPool.stop()]); });

  const results = await Promise.allSettled([
    firstPool.createRecentMemory("YeYu", {
      id: "shared memory",
      title: "First logical memory",
      focus: "Compete for one physical memory key",
      content: "First contender.",
      keywords: ["identity", "concurrency"]
    }, operation("memory-collision-manager-one")),
    secondPool.createRecentMemory("YeYu", {
      id: "shared-memory",
      title: "Second logical memory",
      focus: "Compete for one physical memory key",
      content: "Second contender.",
      keywords: ["identity", "concurrency"]
    }, operation("memory-collision-manager-two"))
  ]);

  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /storage key already exists for a different logical id/i);
  const stored = listRecentMemories(roleDir);
  assert.equal(stored.length, 1);
  assert.ok(stored[0]?.id === "shared memory" || stored[0]?.id === "shared-memory");
});

test("independent Manager update and touch mutations re-read CAS state after acquiring the shared lease", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const initial = createRecentMemory(roleDir, {
    id: "memory-cross-manager-cas",
    title: "Cross-Manager memory CAS",
    focus: "Allow exactly one mutation for one expected revision",
    content: "Initial content.",
    keywords: ["lease", "revision"]
  });
  const expectedRevision = storageRevisionToken(initial);
  const updatePool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "memory-cas-generation-update",
    managerInstanceId: "memory-cas-manager-update"
  });
  const touchPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "memory-cas-generation-touch",
    managerInstanceId: "memory-cas-manager-touch"
  });
  t.after(async () => { await Promise.allSettled([updatePool.stop(), touchPool.stop()]); });

  const results = await Promise.allSettled([
    updatePool.updateRecentMemory("YeYu", initial.id, {
      content: "Updated by one Manager."
    }, operation("memory-cross-manager-update", expectedRevision)),
    touchPool.touchRecentMemory(
      "YeYu",
      initial.id,
      operation("memory-cross-manager-touch", expectedRevision)
    )
  ]);

  const fulfilled = results.find(result => result.status === "fulfilled");
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(fulfilled && fulfilled.status === "fulfilled");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(
    rejected.reason instanceof ManagerStorageMutationError
      && rejected.reason.code === "revision_conflict"
  );
  const stored = listRecentMemories(roleDir).find(memory => memory.id === initial.id);
  assert.equal(stored?.storageRevision, fulfilled.value.storageRevision);
  assert.equal(stored?.storageMutationRequestId, fulfilled.value.storageMutationRequestId);
});

test("a Manager memory mutation waits for the shared cross-process role catalog lease", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "memory-lease-generation",
    managerInstanceId: "memory-lease-manager"
  });
  t.after(() => pool.stop());

  let enterLease = (): void => {};
  const leaseEntered = new Promise<void>(resolve => { enterLease = resolve; });
  let releaseLease = (): void => {};
  const leaseRelease = new Promise<void>(resolve => { releaseLease = resolve; });
  const heldLease = withPlanStorageLeaseAsync(roleDir, ROLE_MEMORY_CATALOG_LEASE_ID, async () => {
    enterLease();
    await leaseRelease;
  });
  await leaseEntered;

  let settled = false;
  const mutation = pool.createRecentMemory("YeYu", {
    id: "memory-shared-lease",
    title: "Shared lease",
    focus: "Wait for the role memory catalog lease",
    content: "The storage child must not bypass another Manager's lease.",
    keywords: ["lease", "concurrency"]
  }, { ...operation("memory-shared-lease-create"), timeoutMs: 15_000 }).finally(() => { settled = true; });
  const lockPath = planStorageLeasePath(roleDir, ROLE_MEMORY_CATALOG_LEASE_ID);
  const candidatePrefix = `.${path.basename(lockPath)}.`;
  const contenderDeadline = Date.now() + 5_000;
  let contenderObserved = false;
  while (Date.now() < contenderDeadline) {
    contenderObserved = fs.readdirSync(path.dirname(lockPath)).some(name =>
      name.startsWith(candidatePrefix) && name.endsWith(".candidate"));
    if (contenderObserved) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const settledWhileLeaseHeld = settled;
  releaseLease();
  await heldLease;
  assert.equal(contenderObserved, true, "storage child did not contend for the shared memory lease");
  assert.equal(settledWhileLeaseHeld, false);
  const created = await mutation;
  assert.equal(created.id, "memory-shared-lease");
});

test("a replacement child proves an uncertain recent-memory touch only by its exact view event", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const created = createRecentMemory(roleDir, {
    id: "memory-touch-proof",
    title: "Touch recovery",
    focus: "Recover one committed view event",
    content: "The request id is the proof.",
    keywords: ["touch", "proof"]
  });
  const requestId = "memory-touch-proof-request";
  const task = { type: "recent_memory_touch" as const, memoryId: created.id };
  const committed = touchRecentMemory(roleDir, created.id, {
    requestId,
    revision: storageMutationRevision(requestId)
  }, "2026-09-01T02:03:04.000Z");
  const receiptRoot = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: { roleId: "YeYu", planId: undefined, task },
    audit: { expectedRevision: storageRevisionToken(created) },
    deliver: async () => { throw new Error("response lost after recent-memory touch"); },
    recover: async () => ({ state: "uncertain" as const, reason: "replacement required" })
  });

  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "recent-memory-touch-proof-generation",
    managerInstanceId: "recent-memory-touch-proof-manager"
  });
  t.after(() => pool.stop());
  const recovered = await pool.touchRecentMemory(
    "YeYu",
    created.id,
    operation(requestId, storageRevisionToken(created))
  );
  assert.equal(recovered.id, committed.id);
  assert.equal(recovered.updatedAt, committed.updatedAt);
  assert.equal(recovered.viewedAt, committed.viewedAt);
  assert.equal(recovered.storageRevision, committed.storageRevision);
  assert.equal(recovered.storageMutationRequestId, committed.storageMutationRequestId);
  assert.equal(readDurableDeliveryReceipt(
    receiptRoot,
    MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    requestId
  )?.state, "completed");
});

test("storage mutation pool rejects stale expected revisions before reserving a receipt", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-two",
    managerInstanceId: "manager-instance-two"
  });
  t.after(() => pool.stop());
  const plan = await pool.createPlan("YeYu", "plan-revision", {
    title: "Revision plan",
    focus: "Reject stale revisions",
    status: "执行中",
    currentStepId: "reject",
    steps: [{ id: "reject", title: "Reject stale revisions", status: "进行中" }],
    keywords: ["revision"]
  }, operation("create-plan-revision"));

  await assert.rejects(
    pool.updatePlan("YeYu", plan.id, { nextAction: "must not commit" }, operation("stale-plan-update", "stale")),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "revision_conflict"
  );
  const receiptDirectory = path.join(roleDir, "runtime", "data", "storage-mutation-idempotency");
  assert.equal(fs.readdirSync(receiptDirectory).filter(name => name.endsWith(".json")).length, 1);
});

test("a completed commit replays across Manager generations without a second domain write", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const input = {
    title: "Lost response plan",
    focus: "Recover a committed mutation by request id",
    status: "执行中",
    currentStepId: "recover",
    steps: [{ id: "recover", title: "Recover the receipt", status: "进行中" }],
    keywords: ["idempotency", "receipt"]
  };
  const firstPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-before-loss",
    managerInstanceId: "manager-instance-before-loss"
  });
  const first = await firstPool.createPlan("YeYu", "lost-response-plan", input, operation("lost-response-request"));
  await firstPool.stop();

  const replacementPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-after-loss",
    managerInstanceId: "manager-instance-after-loss"
  });
  t.after(() => replacementPool.stop());
  const replay = await replacementPool.createPlan(
    "YeYu",
    "lost-response-plan",
    input,
    operation("lost-response-request")
  );
  assert.deepEqual(replay, first);
  const history = fs.readFileSync(
    path.join(roleDir, "plans", "active", "lost-response-plan", "history.jsonl"),
    "utf8"
  ).split(/\r?\n/).filter(Boolean);
  assert.equal(history.length, 1);

  await assert.rejects(
    replacementPool.createPlan("YeYu", "lost-response-plan", {
      ...input,
      title: "Different semantic request"
    }, operation("lost-response-request")),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "idempotency_conflict"
  );
});

test("a committed domain mutation with a sending receipt is indeterminate and never executes twice", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const planId = "commit-without-receipt-plan";
  const requestId = "commit-without-receipt-request";
  const input = {
    title: "Committed without terminal receipt",
    focus: "Do not repeat an indeterminate commit",
    status: "执行中",
    currentStepId: "recover",
    steps: [{ id: "recover", title: "Recover from the ledger", status: "进行中" }],
    keywords: ["idempotency", "indeterminate"]
  };
  const task = { type: "plan_create" as const, input: { ...input, id: planId } };
  let releaseDelivery!: () => void;
  const deliveryRelease = new Promise<void>(resolve => { releaseDelivery = resolve; });
  let domainCommitted!: () => void;
  const commitObserved = new Promise<void>(resolve => { domainCommitted = resolve; });
  const interruptedDelivery = executeDurableDelivery({
    rootDir: path.join(roleDir, "runtime"),
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: {
      roleId: "YeYu",
      planId,
      task
    },
    deliver: async () => {
      const result = createPlan(roleDir, task.input);
      domainCommitted();
      await deliveryRelease;
      return result;
    }
  });
  await commitObserved;

  const replacementPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-after-interruption",
    managerInstanceId: "manager-instance-after-interruption"
  });
  t.after(() => replacementPool.stop());
  await assert.rejects(
    replacementPool.createPlan("YeYu", planId, input, operation(requestId)),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "indeterminate"
  );
  const historyPath = path.join(roleDir, "plans", "active", planId, "history.jsonl");
  assert.equal(fs.readFileSync(historyPath, "utf8").split(/\r?\n/).filter(Boolean).length, 1);

  releaseDelivery();
  const terminal = await interruptedDelivery;
  assert.equal(terminal.state, "completed");
  assert.equal(fs.readFileSync(historyPath, "utf8").split(/\r?\n/).filter(Boolean).length, 1);
});

test("a replacement child proves an uncertain committed mutation by exact request id and backfills completed", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const planId = "uncertain-proof-plan";
  const requestId = "uncertain-proof-request";
  const input = {
    title: "Uncertain proof plan",
    focus: "Recover by exact mutation identity",
    status: "执行中",
    currentStepId: "recover",
    steps: [{ id: "recover", title: "Recover", status: "进行中" }],
    keywords: ["proof"]
  };
  const task = { type: "plan_create" as const, input: { ...input, id: planId } };
  createPlan(roleDir, task.input, {
    requestId,
    revision: storageMutationRevision(requestId)
  });
  const receiptRoot = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: { roleId: "YeYu", planId, task },
    deliver: async () => { throw new Error("response lost after commit"); },
    recover: async () => ({ state: "uncertain" as const, reason: "replacement required" })
  });
  assert.equal(readDurableDeliveryReceipt(receiptRoot, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, requestId)?.state, "uncertain");

  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-proof",
    managerInstanceId: "manager-instance-proof"
  });
  t.after(() => pool.stop());
  const recovered = await pool.createPlan("YeYu", planId, input, operation(requestId));
  assert.equal(recovered.storageMutationRequestId, requestId);
  assert.equal(readDurableDeliveryReceipt(receiptRoot, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, requestId)?.state, "completed");
});

test("timeline append is exact-id idempotent and a replacement child proves role plus message identity", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const message: RolePanelTimelineMessage = {
    id: "timeline-proof-message",
    time: 1_788_192_000,
    roleId: "YeYu",
    direction: "user",
    sender: "本地用户",
    text: "只追加一次",
    attachments: [],
    status: "sent"
  };
  const firstPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "timeline-generation-one",
    managerInstanceId: "timeline-manager-one"
  });
  const first = await firstPool.appendRolePanelTimeline("YeYu", message, operation("timeline-first"));
  const receiptReplay = await firstPool.appendRolePanelTimeline("YeYu", message, operation("timeline-first"));
  const identityReplay = await firstPool.appendRolePanelTimeline("YeYu", message, operation("timeline-second"));
  assert.equal(first.appended, true);
  assert.deepEqual(receiptReplay, first);
  assert.equal(identityReplay.appended, false);
  assert.equal(readRolePanelTimeline(roleDir).length, 1);
  await assert.rejects(
    firstPool.appendRolePanelTimeline("YeYu", message, operation("timeline-revision", "not-null")),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "mutation_failed"
  );
  await firstPool.stop();

  const recoveryMessage = { ...message, id: "timeline-replacement-proof" };
  appendRolePanelTimelineMessageIfAbsent(roleDir, recoveryMessage);
  const requestId = "timeline-replacement-request";
  const task = { type: "role_panel_timeline_append" as const, message: recoveryMessage };
  const receiptRoot = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: { roleId: "YeYu", planId: undefined, task },
    audit: { expectedRevision: null },
    deliver: async () => { throw new Error("response lost after timeline append"); },
    recover: async () => ({ state: "uncertain" as const, reason: "replacement required" })
  });
  const replacementPool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "timeline-generation-two",
    managerInstanceId: "timeline-manager-two"
  });
  t.after(() => replacementPool.stop());
  const recovered = await replacementPool.appendRolePanelTimeline("YeYu", recoveryMessage, operation(requestId));
  assert.equal(recovered.appended, false);
  assert.equal(recovered.message.id, recoveryMessage.id);
  assert.equal(readRolePanelTimeline(roleDir).filter(item => item.id === recoveryMessage.id).length, 1);
  assert.equal(readDurableDeliveryReceipt(receiptRoot, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, requestId)?.state, "completed");
});

test("an unrelated completed mutation never satisfies uncertain recovery proof", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const planId = "unrelated-proof-plan";
  const requestId = "target-proof-request";
  const input = {
    title: "Unrelated proof plan",
    focus: "Reject unrelated mutation evidence",
    status: "执行中",
    currentStepId: "verify",
    steps: [{ id: "verify", title: "Verify", status: "进行中" }],
    keywords: ["proof"]
  };
  const task = { type: "plan_create" as const, input: { ...input, id: planId } };
  createPlan(roleDir, task.input, {
    requestId: "another-request",
    revision: storageMutationRevision("another-request")
  });
  const receiptRoot = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: { roleId: "YeYu", planId, task },
    deliver: async () => { throw new Error("target result unknown"); },
    recover: async () => ({ state: "uncertain" as const, reason: "replacement required" })
  });
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-unrelated",
    managerInstanceId: "manager-instance-unrelated"
  });
  t.after(() => pool.stop());
  await assert.rejects(
    pool.createPlan("YeYu", planId, input, operation(requestId)),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "indeterminate"
  );
  assert.equal(readDurableDeliveryReceipt(receiptRoot, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, requestId)?.state, "uncertain");
});

test("uncertain recovery finds a generated recent-memory id only by exact mutation request id", async t => {
  const { rolesRoot, roleDir } = tempRolesRoot(t);
  const requestId = "generated-memory-proof-request";
  const input = {
    title: "Generated memory",
    focus: "Recover without a caller-provided id",
    content: "The mutation stamp is the recovery identity.",
    keywords: ["proof"]
  };
  const task = { type: "recent_memory_create" as const, input };
  const committed = createRecentMemory(roleDir, input, {
    requestId,
    revision: storageMutationRevision(requestId)
  });
  const receiptRoot = path.join(roleDir, "runtime");
  await executeDurableDelivery({
    rootDir: receiptRoot,
    namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
    deliveryId: requestId,
    payload: { roleId: "YeYu", planId: undefined, task },
    deliver: async () => { throw new Error("response lost after generated id commit"); },
    recover: async () => ({ state: "uncertain" as const, reason: "replacement required" })
  });
  const pool = new ManagerStorageMutationPool({
    rolesRoot,
    applicationGenerationId: "application-generation-memory-proof",
    managerInstanceId: "manager-instance-memory-proof"
  });
  t.after(() => pool.stop());
  const recovered = await pool.createRecentMemory("YeYu", input, operation(requestId));
  assert.equal(recovered.id, committed.id);
  assert.equal(recovered.storageMutationRequestId, requestId);
  assert.equal(readDurableDeliveryReceipt(receiptRoot, MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, requestId)?.state, "completed");
});

test("storage mutation pool runs exactly one command at a time", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const child = new FakeChild(41001, (request, current) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start:${request.requestId}`);
    setTimeout(() => {
      order.push(`finish:${request.requestId}`);
      inFlight -= 1;
      current.respond(request, { requestId: request.requestId });
    }, 10);
  }, (_signal, current) => current.close(0, "SIGTERM"));
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-roles"),
    applicationGenerationId: "application-generation-three",
    managerInstanceId: "manager-instance-three",
    childFactory: () => child
  });

  const first = pool.createRecentMemory("YeYu", { title: "one" }, operation("serial-one"));
  const second = pool.createRecentMemory("YeYu", { title: "two" }, operation("serial-two"));
  assert.deepEqual(await Promise.all([first, second]), [
    { requestId: "serial-one" },
    { requestId: "serial-two" }
  ]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ["start:serial-one", "finish:serial-one", "start:serial-two", "finish:serial-two"]);
  await pool.stop();
});

test("storage mutation worker failures never expose spawn or child diagnostic content", async () => {
  const privateSpawnDetail = "Q:\\example-private\\settings.json sensitive-diagnostic-marker";
  const spawnPool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-spawn-diagnostics"),
    applicationGenerationId: "application-generation-spawn-diagnostics",
    managerInstanceId: "manager-instance-spawn-diagnostics",
    childFactory: () => { throw new Error(privateSpawnDetail); }
  });
  await assert.rejects(
    spawnPool.createRecentMemory("YeYu", { title: "spawn" }, operation("spawn-diagnostics")),
    (error: unknown) => error instanceof ManagerStorageMutationError
      && error.code === "worker_failed"
      && error.message === "Storage mutation child failed to start."
      && !error.message.includes(privateSpawnDetail)
  );
  await spawnPool.stop();

  const privateChildDetail = "\\\\example-host\\private-share\\roles\\YeYu\\memory.json sensitive-diagnostic-marker";
  const child = new FakeChild(41501, (_request, current) => {
    current.stderr.emit("data", privateChildDetail);
    current.close(17, null);
  });
  const childPool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-child-diagnostics"),
    applicationGenerationId: "application-generation-child-diagnostics",
    managerInstanceId: "manager-instance-child-diagnostics",
    childFactory: () => child
  });
  await assert.rejects(
    childPool.createRecentMemory("YeYu", { title: "child" }, operation("child-diagnostics")),
    (error: unknown) => error instanceof ManagerStorageMutationError
      && error.code === "worker_failed"
      && error.message.includes(`diagnosticBytes=${Buffer.byteLength(privateChildDetail, "utf8")}`)
      && !error.message.includes(privateChildDetail)
      && !error.message.includes("sensitive-diagnostic-marker")
  );
  await childPool.stop();
});

test("timeout ignores a late response and starts the next command only after child close", async () => {
  const events: string[] = [];
  let firstRequest: ManagerStorageMutationRequest | undefined;
  let childNumber = 0;
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-timeout"),
    applicationGenerationId: "application-generation-four",
    managerInstanceId: "manager-instance-four",
    timeoutMs: 15,
    terminationTimeoutMs: 5,
    forceTerminationTimeoutMs: 50,
    childFactory: () => {
      childNumber += 1;
      if (childNumber === 1) {
        return new FakeChild(42001, request => {
          firstRequest = request;
          events.push("first-send");
        }, (signal, current) => {
          events.push(`first-${signal}`);
          if (signal !== "SIGKILL") return;
          if (firstRequest) current.respond(firstRequest, { late: true });
          setTimeout(() => {
            events.push("first-close");
            current.close(null, "SIGKILL");
          }, 10);
        });
      }
      return new FakeChild(42002, (request, current) => {
        events.push("second-send");
        current.respond(request, { ok: "second" });
      }, (_signal, current) => current.close(0, "SIGTERM"));
    }
  });

  const first = pool.createRecentMemory("YeYu", { title: "hung" }, {
    idempotencyKey: "timeout-one",
    expectedRevision: null,
    timeoutMs: 15
  });
  const second = pool.createRecentMemory("YeYu", { title: "after" }, operation("timeout-two"));
  await assert.rejects(
    first,
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "timeout"
  );
  assert.deepEqual(await second, { ok: "second" });
  assert.ok(events.indexOf("second-send") > events.indexOf("first-close"));
  assert.deepEqual(events.slice(0, 4), ["first-send", "first-SIGTERM", "first-SIGKILL", "first-close"]);
  await pool.stop();
});

test("abort terminates and confirms the active child before reporting cancellation", async () => {
  const controller = new AbortController();
  const child = new FakeChild(42501, () => {
    controller.abort(new Error("caller cancelled"));
  }, (_signal, current) => {
    setTimeout(() => current.close(null, "SIGTERM"), 5);
  });
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-abort"),
    applicationGenerationId: "application-generation-abort",
    managerInstanceId: "manager-instance-abort",
    terminationTimeoutMs: 50,
    childFactory: () => child
  });
  await assert.rejects(
    pool.createRecentMemory("YeYu", { title: "abort" }, {
      idempotencyKey: "abort-one",
      expectedRevision: null,
      signal: controller.signal
    }),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "aborted"
  );
  assert.equal(child.signals[0], "SIGTERM");
  assert.equal(pool.status().active, 0);
  await pool.stop();
});

test("a response with another Manager identity is fenced and the child is discarded", async () => {
  const child = new FakeChild(42601, (request, current) => {
    current.emit("message", {
      protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
      requestId: request.requestId,
      fence: { ...request.fence, managerInstanceId: "manager-instance-stale" },
      ok: true,
      value: { mustNotApply: true }
    } satisfies ManagerStorageMutationResponse);
  }, (_signal, current) => current.close(null, "SIGTERM"));
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-fence"),
    applicationGenerationId: "application-generation-fence",
    managerInstanceId: "manager-instance-current",
    childFactory: () => child
  });
  await assert.rejects(
    pool.createRecentMemory("YeYu", { title: "fenced" }, operation("fence-one")),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "fence_mismatch"
  );
  assert.equal(child.signals[0], "SIGTERM");
  await pool.stop();
});

test("unconfirmed child termination blocks commands and stop cannot masquerade as stopped", async () => {
  const child = new FakeChild(43001, () => {}, () => {});
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-blocked"),
    applicationGenerationId: "application-generation-five",
    managerInstanceId: "manager-instance-five",
    timeoutMs: 10,
    terminationTimeoutMs: 5,
    forceTerminationTimeoutMs: 5,
    childFactory: () => child
  });

  await assert.rejects(
    pool.createRecentMemory("YeYu", { title: "hung" }, {
      idempotencyKey: "blocked-one",
      expectedRevision: null,
      timeoutMs: 10
    }),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "termination_unconfirmed"
  );
  assert.equal(pool.status().state, "blocked");
  assert.equal(pool.status().childPid, 43001);
  await assert.rejects(
    pool.createRecentMemory("YeYu", { title: "must-not-run" }, operation("blocked-two")),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "termination_unconfirmed"
  );
  await assert.rejects(
    pool.stop(),
    (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "termination_unconfirmed"
  );
  assert.notEqual(pool.status().state, "stopped");

  child.close(null, "SIGKILL");
  await new Promise(resolve => setImmediate(resolve));
  await pool.stop();
  assert.equal(pool.status().state, "stopped");
});

test("typed mutation surface carries consolidation and feedback update tasks through one fenced envelope", async () => {
  const seen: ManagerStorageMutationRequest[] = [];
  const child = new FakeChild(44001, (request, current) => {
    seen.push(request);
    current.respond(request, { type: request.task.type });
  }, (_signal, current) => current.close(0, "SIGTERM"));
  const pool = new ManagerStorageMutationPool({
    rolesRoot: path.join(os.tmpdir(), "fake-storage-surface"),
    applicationGenerationId: "application-generation-six",
    managerInstanceId: "manager-instance-six",
    childFactory: () => child,
    storageGenerationLeaseFactory: () => "stable-storage-lease-six"
  });
  const record: PlanFeedbackRecord = {
    id: "feedback-one",
    roleId: "YeYu",
    planId: "plan-one",
    planTitle: "Plan",
    kind: "guidance",
    author: "user",
    source: "api",
    text: "text",
    attachments: [],
    planAttachments: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deliveryStatus: "pending"
  };

  await pool.requestMemoryConsolidation("YeYu", { force: true }, operation("surface-request"));
  await pool.markMemoryConsolidationDelivered("YeYu", "run-one", operation("surface-delivered", "run-revision"));
  await pool.applyMemoryConsolidation("YeYu", "run-one", { memories: [] }, operation("surface-apply", "run-revision"));
  await pool.updatePlanFeedbackQaHandling("YeYu", "plan-one", record, {
    outcome: "passed",
    issueType: "generic",
    status: "completed",
    missingEvidence: [],
    consumedAt: "2026-09-01T00:00:00.000Z"
  }, operation("surface-qa", record.updatedAt));
  await pool.updatePlanFeedbackPostCommit(
    "YeYu",
    "plan-one",
    record,
    "completed",
    operation("surface-post", record.updatedAt)
  );
  await pool.appendRolePanelTimeline("YeYu", {
    id: "surface-timeline",
    time: 1_788_192_000,
    roleId: "YeYu",
    direction: "user",
    sender: "test",
    text: "surface",
    attachments: [],
    status: "sent"
  }, operation("surface-timeline"));

  assert.deepEqual(seen.map(item => item.task.type), [
    "memory_consolidation_request",
    "memory_consolidation_mark_delivered",
    "memory_consolidation_apply",
    "plan_feedback_qa_update",
    "plan_feedback_post_commit_update",
    "role_panel_timeline_append"
  ]);
  assert.ok(seen.every(item => item.fence.applicationGenerationId === "application-generation-six"));
  assert.ok(seen.every(item => item.fence.managerInstanceId === "manager-instance-six"));
  assert.ok(seen.every(item => item.fence.storageGenerationLease === "stable-storage-lease-six"));
  await pool.stop();
});
