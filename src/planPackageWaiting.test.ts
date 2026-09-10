import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "./roleKnowledge.js";
import {
  migrateLegacyPackageGatePlan,
  planHasPackageLifecycle,
  planIsWaitingForPackage,
  planIsWaitingForQaAcceptance
} from "./planPackageWaiting.js";
import { loadDefaultPersonaPlanWorkflow } from "./personaPlanWorkflow.js";

const workflow = loadDefaultPersonaPlanWorkflow();

function plan(status: PlanItem["status"], patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-status",
    title: "Plan status",
    focus: "Plan status",
    status,
    attachments: [],
    steps: [{ id: "work", title: "Work" }],
    currentStepId: "work",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    keywords: ["status"],
    ...patch,
    archiveStatus: patch.archiveStatus ?? "未归档"
  };
}

test("package and QA waits use plan.status as their only truth", () => {
  const waitingPackage = plan("等待打包", { waitingFor: "任意文字" });
  const waitingQa = plan("等待 QA", { waitingFor: "没有包体关键词" });
  const executing = plan("执行中", { waitingFor: "等待打包和 QA" });

  assert.equal(planIsWaitingForPackage(waitingPackage, workflow), true);
  assert.equal(planIsWaitingForQaAcceptance(waitingPackage, workflow), false);
  assert.equal(planIsWaitingForQaAcceptance(waitingQa, workflow), true);
  assert.equal(planIsWaitingForPackage(executing, workflow), false);
  assert.equal(planIsWaitingForQaAcceptance(executing, workflow), false);
});

test("package lifecycle detection remains evidence-only and does not change status", () => {
  const item = plan("执行中", {
    steps: [
      { id: "implement", title: "Implement", completedAt: "2026-09-03T00:00:00.000Z" },
      { id: "package-build", title: "Build package" }
    ],
    currentStepId: "package-build"
  });
  assert.equal(planHasPackageLifecycle(item), true);
  assert.equal(planIsWaitingForPackage(item, workflow), false);
});

test("non-project-content plans do not enter package or QA waits from generic waiting text", () => {
  const investigation = plan("执行中", {
    title: "调查与资料收集",
    focus: "核对现有资料并整理结论，不修改项目内容。",
    waitingFor: "等待打包、等待 QA",
    steps: [{ id: "investigate", title: "调查与资料收集" }],
    currentStepId: "investigate"
  });
  assert.equal(planHasPackageLifecycle(investigation), false);
  assert.equal(planIsWaitingForPackage(investigation, workflow), false);
  assert.equal(planIsWaitingForQaAcceptance(investigation, workflow), false);
});

test("legacy global package gate migration writes a canonical single status", () => {
  const legacy = {
    ...plan("执行中"),
    status: "进行中",
    blockedBy: "等待统一打包任务门禁",
    steps: [{
      id: "package-build",
      title: "Build package",
      status: "进行中",
      workPhase: "execution",
      blockedBy: "等待统一打包任务门禁"
    }],
    currentStepId: "package-build"
  } as unknown as PlanItem;
  const migrated = migrateLegacyPackageGatePlan(legacy, workflow, "2026-09-03T01:00:00.000Z");
  assert.ok(migrated);
  assert.ok(["执行中", "等待打包"].includes(migrated.plan.status));
  assert.notEqual(migrated.plan.status, "进行中");
});
