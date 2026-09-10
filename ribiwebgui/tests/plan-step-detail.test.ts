import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { parsePlanStepDetail } from "../src/planStepDetail";

test("human verification detail is split into readable sections and lists", () => {
  const parsed = parsePlanStepDetail(`【核验对象】活动日历\n【核验人】页面负责人或 QA\n【资源】\n- Prefab：Assets/Game/Resources/UI/Window/ActivityCalendarWindow.prefab\n【负责人要做什么】\n1. 打开页面并检查布局。\n2. 点击入口并检查跳转。\n【通过】没有错位、裁切或错误跳转。`);

  assert.equal(parsed.structured, true);
  assert.deepEqual(parsed.blocks, [
    { type: "heading", text: "核验对象" },
    { type: "paragraph", text: "活动日历" },
    { type: "heading", text: "核验人" },
    { type: "paragraph", text: "页面负责人或 QA" },
    { type: "heading", text: "资源" },
    { type: "unordered-list", items: ["Prefab：Assets/Game/Resources/UI/Window/ActivityCalendarWindow.prefab"] },
    { type: "heading", text: "负责人要做什么" },
    { type: "ordered-list", items: ["打开页面并检查布局。", "点击入口并检查跳转。"] },
    { type: "heading", text: "通过" },
    { type: "paragraph", text: "没有错位、裁切或错误跳转。" }
  ]);
});

test("legacy manual verification labels remain readable", () => {
  const parsed = parsePlanStepDetail(`[核验路径 2026-09-01]\n- Assets/Game/Test.prefab\n\n[核验步骤 2026-09-01]\n1. 打开页面。\n2. 检查按钮。\n通过标准：页面正常。`);

  assert.equal(parsed.structured, true);
  assert.deepEqual(parsed.blocks, [
    { type: "heading", text: "要看什么" },
    { type: "unordered-list", items: ["Assets/Game/Test.prefab"] },
    { type: "heading", text: "负责人要做什么" },
    { type: "ordered-list", items: ["打开页面。", "检查按钮。"] },
    { type: "heading", text: "怎样算通过" },
    { type: "paragraph", text: "页面正常。" }
  ]);
});

test("ordinary detail keeps its original line breaks as fallback text", () => {
  const text = "第一行\n第二行";
  const parsed = parsePlanStepDetail(text);

  assert.equal(parsed.structured, false);
  assert.deepEqual(parsed.blocks, [{ type: "paragraph", text }]);
});


test("plan detail renderer is wired to summaries and expanded steps without horizontal overflow", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const component = fs.readFileSync(path.join(root, "src", "components", "PlanStepDetail.vue"), "utf8");

  assert.equal((page.match(/<PlanStepDetail /g) || []).length, 3);
  assert.match(page, /<details v-if="step.detail && isApprovalStep\(plan, step\)"/);
  assert.match(page, /<PlanStepDetail v-else-if="step.detail"/);
  assert.match(component, /white-space:\s*pre-wrap/);
  assert.match(component, /overflow-wrap:\s*anywhere/);
  assert.match(component, /word-break:\s*break-word/);
  assert.match(component, /<ol[^>]*plan-step-detail__list--ordered/);
});
