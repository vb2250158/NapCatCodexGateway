import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, type RecentMemoryItem } from "../roleKnowledge.js";
import { createPlanFeedbackRecord } from "../planFeedback.js";
import { storageRevisionToken } from "../shared/storageRevision.js";
import {
  RoleStorageApplication,
  RoleStorageApplicationError,
  roleStorageHttpError,
  type RoleStorageApplicationOptions
} from "./roleStorageApplication.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { ManagerStorageMutationError } from "./managerStorageMutationPool.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

test("memory update and touch publish point reads without full catalog recapture", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-memory-point-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let memory: RecentMemoryItem = { id: "one", title: "Example", focus: "test", content: "body", keywords: ["topic"],
    createdAt: "2026-01-01", updatedAt: "2026-01-01", storageRevision: "revision-one" };
  const identity = { applicationGenerationId: "test-generation", managerInstanceId: "test-instance" };
  let pointReads = 0;
  let catalogReads = 0;
  const readPool = {
    run: async (task: { type: string; fresh?: boolean }) => {
      assert.equal(task.type, "role_storage_memory_projection");
      assert.equal(task.fresh, true);
      pointReads++;
      return { memory, revision: storageRevisionToken(memory) };
    },
    queryRoleKnowledgeCatalogSnapshot: async () => { catalogReads++; throw new Error("full role read forbidden"); }
  } as unknown as NonNullable<RoleStorageApplicationOptions["readPool"]>;
  const mutationPool = {
    status: () => ({ ...identity }), stop: async () => undefined,
    updateRecentMemory: async () => { memory = { ...memory, title: "Updated", storageRevision: "revision-two" }; return memory; },
    touchRecentMemory: async () => { memory = { ...memory, viewedAt: "2026-01-02", storageRevision: "revision-three" }; return memory; }
  } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, readPool, catalogReadPool: readPool, mutationPool });
  t.after(() => application.stop());
  const changed = await application.commands.updateRecentMemory("Example", "one", { title: "Updated" }, {
    idempotencyKey: "update-one", expectedRevision: storageRevisionToken(memory)
  });
  assert.equal(changed.projection.memory.title, "Updated");
  const touched = await application.commands.touchRecentMemory("Example", "one", { idempotencyKey: "view-one" });
  assert.equal(touched.projection.memory.viewedAt, "2026-01-02");
  assert.equal(pointReads, 3);
  assert.equal(catalogReads, 0);
});

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

test("plan updates publish one point projection without recapturing the full role catalog", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-storage-plan-point-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "YeYu");
  fs.mkdirSync(roleDir, { recursive: true });
  const original = createPlan(roleDir, {
    id: "point-projection-plan",
    title: "Before point projection",
    focus: "Avoid a full catalog scan after one plan write",
    status: "分析中",
    currentStepId: "verify",
    steps: [{ id: "verify", title: "Verify point projection", status: "进行中" }],
    keywords: ["concurrency"]
  });
  const updated = Object.freeze({
    ...original,
    title: "After point projection",
    updatedAt: "2026-09-04T00:00:00.000Z",
    storageRevision: "point-projection-revision"
  });
  let pointReads = 0;
  let catalogReads = 0;
  const identity = {
    applicationGenerationId: "point-application-generation",
    managerInstanceId: "point-manager-instance"
  };
  const mutationPool = {
    status: () => ({
      state: "idle",
      active: 0,
      queued: 0,
      spawnedChildren: 0,
      ...identity,
      storageGenerationLease: "point-storage-generation"
    }),
    stop: async () => undefined,
    updatePlan: async () => updated
  } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
  const readPool = {
    run: async () => {
      pointReads += 1;
      return {
        plan: updated,
        revision: "point-projection-revision",
        approval: { count: 0 }
      };
    },
    queryRoleKnowledgeCatalogSnapshot: async () => {
      catalogReads += 1;
      throw new Error("full catalog recapture must not run");
    }
  } as unknown as NonNullable<RoleStorageApplicationOptions["readPool"]>;
  const application = new RoleStorageApplication({
    rolesRoot,
    ...identity,
    mutationPool,
    readPool,
    catalogReadPool: readPool
  });
  t.after(() => application.stop());
  const auditRecords: RecordedDataMutationAudit[] = [];
  const uninstallAudit = installDataMutationAuditSink(record => auditRecords.push(record));
  t.after(uninstallAudit);

  const committed = await application.commands.updatePlan("YeYu", original.id, {
    title: updated.title
  }, {
    idempotencyKey: "point-projection-update",
    expectedRevision: storageRevisionToken(original)
  });

  assert.equal(committed.projection.plan.title, updated.title);
  assert.equal(pointReads, 1);
  assert.equal(catalogReads, 0);
  assert.equal("catalog" in committed, false);
  assert.deepEqual(
    auditRecords.filter(record => record.operationId === "point-projection-update").map(record => record.outcome),
    ["started", "committed"]
  );
  assert.equal(auditRecords.find(record => record.operationId === "point-projection-update")?.group, "plan");
  assert.doesNotMatch(JSON.stringify(auditRecords), /After point projection/);
});

test("49 plan updates complete through bounded lanes without full catalog recapture", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-storage-plan-load-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "LoadRole");
  fs.mkdirSync(roleDir, { recursive: true });
  const plans = Array.from({ length: 49 }, (_, index) => createPlan(roleDir, {
    id: `bounded-plan-${String(index).padStart(2, "0")}`,
    title: `Bounded plan ${index}`,
    focus: "Verify bounded concurrent plan writes",
    status: "分析中",
    currentStepId: "verify",
    steps: [{ id: "verify", title: "Verify bounded update", status: "进行中" }],
    keywords: ["concurrency"]
  }));
  const identity = {
    applicationGenerationId: "load-application-generation",
    managerInstanceId: "load-manager-instance"
  };
  const readPool = new ManagerReadWorkerPool({ maxConcurrency: 4, maxQueue: 16, timeoutMs: 30_000 });
  let catalogReads = 0;
  const catalogReadPool = {
    run: readPool.run.bind(readPool),
    queryRoleKnowledgeCatalogSnapshot: async () => {
      catalogReads += 1;
      throw new Error("full catalog recapture must not run");
    }
  } as unknown as NonNullable<RoleStorageApplicationOptions["catalogReadPool"]>;
  const application = new RoleStorageApplication({
    rolesRoot,
    ...identity,
    readPool,
    catalogReadPool
  });
  t.after(async () => {
    await application.stop();
    await readPool.stop();
  });

  const before = await mapWithConcurrency(plans, 4, async plan => {
    const projection = await application.queries.plan("LoadRole", plan.id);
    assert.ok(projection);
    return projection;
  });

  const committed = await mapWithConcurrency(plans, 6, (plan, index) => application.commands.updatePlan(
    "LoadRole",
    plan.id,
    { title: `Updated bounded plan ${index}` },
    {
      idempotencyKey: `bounded-plan-update-${index}`,
      expectedRevision: before[index].revision
    }
  ));

  assert.equal(committed.length, 49);
  assert.equal(committed.every((item, index) => item.projection.plan.title === `Updated bounded plan ${index}`), true);
  assert.equal(catalogReads, 0);
  assert.equal(application.status().spawnedChildren, 1);
  assert.ok(readPool.status().workers <= 4);
});

test("role storage recent-memory read-after-write uses one stable view event per call", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-storage-touch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  let currentIdentity: { applicationGenerationId: string; managerInstanceId: string } | null = {
    applicationGenerationId: "touch-application-generation",
    managerInstanceId: "touch-manager-instance"
  };
  const application = new RoleStorageApplication({
    rolesRoot,
    ...currentIdentity,
    currentIdentity: () => currentIdentity
  });
  t.after(() => application.stop());

  const created = await application.commands.createRecentMemory("YeYu", {
    id: "application-touch-memory",
    title: "Application touch",
    focus: "Read through a fenced mutation",
    content: "Each logical view owns one event id.",
    keywords: ["application", "touch"]
  }, { idempotencyKey: "application-touch-create" });
  assert.equal(created.projection.memory.viewedAt, undefined);

  const first = await application.commands.touchRecentMemory("YeYu", "application-touch-memory");
  const second = await application.commands.touchRecentMemory("YeYu", "application-touch-memory");
  assert.notEqual(first.operationId, second.operationId);
  assert.notEqual(first.commit.storageRevision, second.commit.storageRevision);
  assert.equal(first.commit.updatedAt, created.commit.updatedAt);
  assert.equal(second.commit.updatedAt, created.commit.updatedAt);
  assert.equal(first.projection.memory.id, first.commit.id);
  assert.equal(first.projection.memory.viewedAt, first.commit.viewedAt);
  assert.equal(first.projection.revision, storageRevisionToken(first.commit));
  assert.equal(second.projection.memory.id, second.commit.id);
  assert.equal(second.projection.memory.viewedAt, second.commit.viewedAt);
  assert.equal(second.projection.revision, storageRevisionToken(second.commit));

  const explicit = await application.commands.touchRecentMemory("YeYu", "application-touch-memory", {
    idempotencyKey: "application-touch-explicit"
  });
  const replay = await application.commands.touchRecentMemory("YeYu", "application-touch-memory", {
    idempotencyKey: "application-touch-explicit"
  });
  assert.equal(replay.operationId, explicit.operationId);
  assert.deepEqual(replay.commit, explicit.commit);

  currentIdentity = null;
  await assert.rejects(
    application.commands.touchRecentMemory("YeYu", "application-touch-memory"),
    (error: unknown) => error instanceof RoleStorageApplicationError && error.code === "generation_mismatch"
  );
});

test("domain validation gives actionable HTTP 400 without retrying an unchanged payload", async () => {
  const identity = { applicationGenerationId: "validation-generation", managerInstanceId: "validation-manager" };
  const mutationPool = {
    status: () => ({ ...identity }), stop: async () => undefined,
    updatePlan: async () => { throw new ManagerStorageMutationError("Plan status 完成 forbids currentStepId.", "validation_rejected"); }
  } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
  const application = new RoleStorageApplication({ rolesRoot: "C:/example/roles", ...identity, mutationPool });
  await assert.rejects(application.commands.updatePlan("ExampleRole", "example-plan", { status: "完成" }, {
    idempotencyKey: "rejected-completion", expectedRevision: "before"
  }), (error: unknown) => {
    const response = roleStorageHttpError(error);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.state, "invalid_request");
    assert.equal(response.body.commitState, "not_started");
    assert.match(String(response.body.message), /forbids currentStepId/);
    assert.equal(response.body.retry, "correct_request_with_new_idempotency_key");
    assert.equal(response.body.reason, "invalid_request");
    assert.match(String(response.body.nextAction), /Correct the field/);
    assert.equal(response.body.retryable, false);
    assert.equal(response.headers["retry-after"], undefined);
    return true;
  });
});

test("feedback commits remain readable when unrelated role catalog loading fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-feedback-point-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "Planner");
  fs.mkdirSync(roleDir, { recursive: true });
  const plan = createPlan(roleDir, { id: "plan-one", title: "Example", focus: "Feedback", status: "分析中",
    currentStepId: "analyze", steps: [{ id: "analyze", title: "Analyze" }], keywords: ["feedback"] });
  const record = createPlanFeedbackRecord({ id: "feedback-one", roleId: "Planner", planId: plan.id,
    planTitle: plan.title, kind: "guidance", author: "agent", source: "agent", text: "Analysis updated" });
  const identity = { applicationGenerationId: "feedback-generation", managerInstanceId: "feedback-manager" };
  let pointReads = 0;
  const readPool = {
    run: async (task: { type: string }) => {
      assert.equal(task.type, "role_storage_plan_feedback_projection");
      pointReads++;
      return { plan, planRevision: "after", records: [record], recordRevisions: { [record.id]: "record-after" } };
    },
    queryRoleKnowledgeCatalogSnapshot: async () => { throw new Error("Unrelated catalog is unavailable"); }
  } as unknown as NonNullable<RoleStorageApplicationOptions["readPool"]>;
  const mutationPool = { status: () => identity, stop: async () => undefined,
    submitPlanFeedback: async () => ({ plan, record, created: true })
  } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, readPool, catalogReadPool: readPool, mutationPool });
  t.after(() => application.stop());
  const result = await application.commands.submitPlanFeedback("Planner", plan.id,
    { feedbackId: record.id, text: record.text, author: "agent", kind: "guidance" },
    { expectedRevision: "before", idempotencyKey: "feedback-one" });
  assert.equal(result.commit.record.id, record.id);
  assert.equal(result.projection.records[0].id, record.id);
  assert.equal(pointReads, 1);
});

test("plan storage errors explain version conflicts and committed-but-unreadable writes", () => {
  const conflict = roleStorageHttpError(new RoleStorageApplicationError("Revision changed", "revision_conflict", 412));
  assert.match(String(conflict.body.nextAction), /GET the latest resource/);
  const committed = roleStorageHttpError(new RoleStorageApplicationError("Projection unavailable", "projection_unavailable", 503, "original-key", "committed"));
  assert.equal(committed.body.commitState, "committed");
  assert.match(String(committed.body.nextAction), /write succeeded/);
  assert.equal(committed.body.idempotencyKey, "original-key");
});

test("active-child failures expose an unknown commit state and same-key-only retry", async () => {
  const uncertainCodes = [
    "timeout",
    "aborted",
    "worker_failed",
    "termination_unconfirmed",
    "fence_mismatch"
  ] as const;

  for (const code of uncertainCodes) {
    const mutationPool = {
      status: () => ({
        state: "idle",
        active: 0,
        queued: 0,
        spawnedChildren: 0,
        applicationGenerationId: "uncertain-application-generation",
        managerInstanceId: "uncertain-manager-instance",
        storageGenerationLease: "uncertain-storage-generation"
      }),
      stop: async () => undefined,
      createRecentMemory: async () => {
        throw new ManagerStorageMutationError("private child diagnostic", code);
      }
    } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
    const application = new RoleStorageApplication({
      rolesRoot: "C:/example/roles",
      applicationGenerationId: "uncertain-application-generation",
      managerInstanceId: "uncertain-manager-instance",
      mutationPool
    });

    await assert.rejects(
      application.commands.createRecentMemory("ExampleRole", {
        title: "Uncertain memory",
        focus: "Preserve the idempotency key",
        content: "The child may have committed before its response was lost.",
        keywords: ["idempotency"]
      }, { idempotencyKey: `uncertain-${code}` }),
      (error: unknown) => {
        const response = roleStorageHttpError(error);
        assert.equal(response.statusCode, 503, code);
        assert.equal(response.body.commitState, "unknown", code);
        assert.equal(response.body.causeCode, code);
        assert.equal(response.body.retry, "same_idempotency_key_only", code);
        assert.equal(response.body.idempotencyKey, `uncertain-${code}`, code);
        assert.doesNotMatch(JSON.stringify(response), /private child diagnostic/);
        return true;
      }
    );
  }
});
