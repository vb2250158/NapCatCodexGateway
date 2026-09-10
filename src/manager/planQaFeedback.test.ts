import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback,
  updatePlanFeedbackQaHandling as updateStoredPlanFeedbackQaHandling
} from "../planFeedback.js";
import type { PlanQaFeedbackHandling } from "../planFeedback.js";
import { readPlanStoragePackage } from "../planStorageRepository.js";
import {
  createPlan,
  readPlansFromStorageInWorker,
  updatePlan as updateStoredPlan,
  type PlanItem
} from "../roleKnowledge.js";
import { loadDefaultPersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import {
  storageInventoryRevisionToken,
  storageMutationRevision,
  storageRevisionToken
} from "../shared/storageRevision.js";
import {
  consumePlanQaFeedback,
  type PlanQaMutationContext,
  type PlanQaStoragePort,
  type PlanQaStorageProjection
} from "./planQaFeedback.js";

function planRevision(roleDir: string, plan: PlanItem): string {
  return storageInventoryRevisionToken(readPlanStoragePackage(
    roleDir,
    plan.id,
    plan.archiveStatus === "已归档" ? "archive" : "active"
  ).inventoryHash);
}

function storageProjection(roleDir: string, planId: string): PlanQaStorageProjection | null {
  const plan = readPlansFromStorageInWorker(roleDir).find((candidate) => candidate.id === planId);
  if (!plan) return null;
  const records = listPlanFeedback(roleDir, planId);
  return {
    plan,
    planRevision: planRevision(roleDir, plan),
    records,
    recordRevisions: Object.fromEntries(records.map((record) => [record.id, storageRevisionToken(record)]))
  };
}

function storagePort(
  roleDir: string,
  options: Readonly<{
    beforeUpdatePlan?: (context: PlanQaMutationContext) => void;
    beforeUpdateQaHandling?: (
      record: Parameters<PlanQaStoragePort["updateQaHandling"]>[2],
      qaHandling: PlanQaFeedbackHandling,
      context: PlanQaMutationContext
    ) => void;
    contexts?: PlanQaMutationContext[];
  }> = {}
): PlanQaStoragePort {
  return {
    query: async (_roleId, planId) => storageProjection(roleDir, planId),
    updatePlan: async (_roleId, planId, patch, context) => {
      options.contexts?.push(context);
      options.beforeUpdatePlan?.(context);
      const plan = updateStoredPlan(roleDir, planId, patch, context.expectedRevision, {
        requestId: context.idempotencyKey,
        revision: storageMutationRevision(context.idempotencyKey)
      });
      return { plan, revision: planRevision(roleDir, plan) };
    },
    updateQaHandling: async (_roleId, planId, record, qaHandling, context) => {
      options.contexts?.push(context);
      options.beforeUpdateQaHandling?.(record, qaHandling, context);
      updateStoredPlanFeedbackQaHandling(roleDir, record, qaHandling, context.expectedRevision, {
        requestId: context.idempotencyKey,
        revision: storageMutationRevision(context.idempotencyKey)
      });
      const projection = storageProjection(roleDir, planId);
      if (!projection) throw new Error(`Plan not found after QA feedback mutation: ${planId}`);
      return projection;
    }
  };
}

function fixture(t: test.TestContext): { roleDir: string; planId: string } {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-qa-post-commit-"));
  const planId = "plan-qa-post-commit";
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: planId,
    title: "QA post-commit",
    focus: "Recover uncertain QA dispatch without replay",
    status: "等待 QA",
    currentStepId: "verify-post-commit",
    steps: [{ id: "verify-post-commit", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000099",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA", "post-commit"]
  });
  return { roleDir, planId };
}

test("QA post-commit confirms an uncertain send by deliveryId and never replays it", async (t) => {
  const { roleDir, planId } = fixture(t);
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-uncertain-send",
    roleId: "Rabi",
    planId,
    planTitle: "QA post-commit",
    stepId: "verify-post-commit",
    stepTitle: "QA 验收",
    text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
    author: "user",
    source: "webgui",
    notifyAgent: true
  }));
  let sends = 0;
  let readbacks = 0;
  const consume = () => consumePlanQaFeedback({
    roleId: "Rabi",
    workflow: loadDefaultPersonaPlanWorkflow(),
    storage: storagePort(roleDir),
    feedback,
    sendToTask: async (request) => {
      sends += 1;
      assert.equal((request as { deliveryId?: string }).deliveryId, feedback.id);
      throw new Error("send response lost after Desktop accepted it");
    },
    readTaskDelivery: async (request) => {
      readbacks += 1;
      assert.equal(request.deliveryId, feedback.id);
      return "accepted";
    }
  });

  const first = await consume();
  assert.equal(first.status, "dispatched");
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
  assert.equal(listPlanFeedback(roleDir, planId)[0]?.qaHandling?.status, "dispatched");

  const retry = await consume();
  assert.equal(retry.status, "dispatched");
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
});

test("QA post-commit reads back persisted dispatching before any replay", async (t) => {
  const { roleDir, planId } = fixture(t);
  const created = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-persisted-dispatching",
    roleId: "Rabi",
    planId,
    planTitle: "QA post-commit",
    stepId: "verify-post-commit",
    stepTitle: "QA 验收",
    text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
    author: "user",
    source: "webgui",
    notifyAgent: true
  }));
  const dispatching = updateStoredPlanFeedbackQaHandling(roleDir, created, {
    outcome: "failed",
    issueType: "generic",
    status: "dispatching",
    missingEvidence: [],
    consumedAt: new Date().toISOString()
  });
  let sends = 0;
  const result = await consumePlanQaFeedback({
    roleId: "Rabi",
    workflow: loadDefaultPersonaPlanWorkflow(),
    storage: storagePort(roleDir),
    feedback: dispatching,
    sendToTask: async () => { sends += 1; },
    readTaskDelivery: async (request) => {
      assert.equal(request.deliveryId, dispatching.id);
      return "accepted";
    }
  });

  assert.equal(result.status, "dispatched");
  assert.equal(sends, 0);
  assert.equal(listPlanFeedback(roleDir, planId)[0]?.qaHandling?.status, "dispatched");
});

test("QA post-commit retries dispatch-failed only after readback proves it missing", async (t) => {
  const { roleDir, planId } = fixture(t);
  const created = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-persisted-dispatch-failed",
    roleId: "Rabi",
    planId,
    planTitle: "QA post-commit",
    stepId: "verify-post-commit",
    stepTitle: "QA 验收",
    text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
    author: "user",
    source: "webgui",
    notifyAgent: true
  }));
  const failed = updateStoredPlanFeedbackQaHandling(roleDir, created, {
    outcome: "failed",
    issueType: "generic",
    status: "dispatch_failed",
    missingEvidence: [],
    consumedAt: new Date().toISOString(),
    message: "previous delivery was not accepted"
  });
  let sends = 0;
  let readbacks = 0;
  const consume = () => consumePlanQaFeedback({
    roleId: "Rabi",
    workflow: loadDefaultPersonaPlanWorkflow(),
    storage: storagePort(roleDir),
    feedback: failed,
    sendToTask: async (request) => {
      sends += 1;
      assert.equal(request.deliveryId, failed.id);
    },
    readTaskDelivery: async () => {
      readbacks += 1;
      return "missing";
    }
  });

  const first = await consume();
  assert.equal(first.status, "dispatched");
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
  const retry = await consume();
  assert.equal(retry.status, "dispatched");
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
});

test("QA plan transition rejects a stale projection instead of overwriting a concurrent plan edit", async (t) => {
  const { roleDir, planId } = fixture(t);
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-stale-plan-projection",
    roleId: "Rabi",
    planId,
    planTitle: "QA post-commit",
    stepId: "verify-post-commit",
    stepTitle: "QA 验收",
    text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
    author: "user",
    source: "webgui",
    notifyAgent: true
  }));
  const contexts: PlanQaMutationContext[] = [];
  let injected = false;
  let sends = 0;
  const port = storagePort(roleDir, {
    contexts,
    beforeUpdatePlan: (context) => {
      if (injected) return;
      injected = true;
      updateStoredPlan(roleDir, planId, {
        nextAction: "preserve this concurrent Manager edit"
      }, context.expectedRevision, {
        requestId: "concurrent-plan-update",
        revision: storageMutationRevision("concurrent-plan-update")
      });
    }
  });

  await assert.rejects(
    consumePlanQaFeedback({
      roleId: "Rabi",
      workflow: loadDefaultPersonaPlanWorkflow(),
      storage: port,
      feedback,
      sendToTask: async () => { sends += 1; }
    }),
    /STORAGE_MUTATION_REVISION_CONFLICT/
  );

  const plan = readPlansFromStorageInWorker(roleDir).find((candidate) => candidate.id === planId)!;
  assert.equal(plan.nextAction, "preserve this concurrent Manager edit");
  assert.equal(plan.steps.some((step) => step.id === "investigate-verify-post-commit"), false);
  assert.equal(listPlanFeedback(roleDir, planId)[0]?.qaHandling, undefined);
  assert.equal(sends, 0);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0]!.idempotencyKey, /^rsm:event:plan-qa-plan-transition:/);
  assert.ok(contexts[0]!.expectedRevision.startsWith("inventory-sha256:"));
});

test("QA feedback transition rejects a stale record revision and preserves the concurrent handling", async (t) => {
  const { roleDir, planId } = fixture(t);
  const initialPlan = readPlansFromStorageInWorker(roleDir).find((candidate) => candidate.id === planId)!;
  updateStoredPlan(roleDir, planId, {
    status: "完成",
    currentStepId: null,
    steps: initialPlan.steps.map((step) => ({ ...step, completedAt: "2026-09-03T00:00:00.000Z" }))
  }, planRevision(roleDir, initialPlan), {
    requestId: "prepare-completed-qa-step",
    revision: storageMutationRevision("prepare-completed-qa-step")
  });
  const preparedFeedback = createPlanFeedbackRecord({
    id: "qa-stale-feedback-projection",
    roleId: "Rabi",
    planId,
    planTitle: "QA post-commit",
    stepId: "verify-post-commit",
    stepTitle: "QA 验收",
    text: "QA 明确通过，本轮未再复现。",
    author: "user",
    source: "webgui",
    notifyAgent: true
  });
  const feedback = appendPlanFeedback(roleDir, {
    ...preparedFeedback,
    postCommit: {
      deliveryId: preparedFeedback.id,
      status: "processing",
      attempts: 1,
      updatedAt: new Date().toISOString()
    }
  });
  const contexts: PlanQaMutationContext[] = [];
  let injected = false;
  const concurrentHandling: PlanQaFeedbackHandling = {
    outcome: "failed",
    issueType: "generic",
    status: "waiting_for_evidence",
    missingEvidence: ["concurrent evidence"],
    consumedAt: "2026-09-01T00:00:00.000Z",
    message: "preserve this concurrent feedback edit"
  };
  const port = storagePort(roleDir, {
    contexts,
    beforeUpdateQaHandling: (record, _qaHandling, context) => {
      if (injected) return;
      injected = true;
      updateStoredPlanFeedbackQaHandling(roleDir, record, concurrentHandling, context.expectedRevision, {
        requestId: "concurrent-feedback-update",
        revision: storageMutationRevision("concurrent-feedback-update")
      });
    }
  });

  await assert.rejects(
    consumePlanQaFeedback({
      roleId: "Rabi",
      workflow: loadDefaultPersonaPlanWorkflow(),
      storage: port,
      feedback,
      sendToTask: async () => { throw new Error("must not send"); }
    }),
    /STORAGE_MUTATION_REVISION_CONFLICT/
  );

  const persisted = listPlanFeedback(roleDir, planId)
    .find((candidate) => candidate.id === feedback.id)!;
  assert.deepEqual(persisted.qaHandling, concurrentHandling);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0]!.idempotencyKey, /^rsm:event:plan-qa-feedback-transition:/);
  assert.ok(contexts[0]!.expectedRevision.startsWith("revision:"));
});
