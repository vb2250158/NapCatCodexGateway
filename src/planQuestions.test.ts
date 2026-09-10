import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approvalDecisionQuestions, normalizePlanQuestions, planQuestionReply, selectPlanQuestionOption, type PlanQuestionAnswer } from "./shared/planQuestions.js";
import { approvalRequestMissingFields, createPlan, getPlan, updatePlan } from "./roleKnowledge.js";

const questions = [{ id: "scope", prompt: "Which action failed?", context: "Both handlers were inspected.", required: true,
  options: [{ id: "refresh", label: "Refresh", recommended: true }, { id: "deliver", label: "Deliver" }], placeholder: "Describe another result" },
{ id: "detail", prompt: "What happened?", options: [], required: false }];

test("recommendations are not answers; choice or custom text can answer a required question", () => {
  const q = normalizePlanQuestions(questions);
  assert.equal(planQuestionReply(q, {}).valid, false);
  assert.equal(planQuestionReply(q, { scope: { optionId: "refresh" } }).valid, true);
  assert.equal(planQuestionReply(q, { scope: { text: "Both buttons" } }).valid, true);
  assert.equal(planQuestionReply(q, { scope: { optionId: "removed" } }).valid, false);
  assert.equal(planQuestionReply(q, { scope: { optionId: "deliver", text: "Only on first visit" } }).text,
    "Which action failed?\nDeliver\nOnly on first visit");
});

test("question definitions reject duplicate identities, malformed options and excessive input", () => {
  assert.throws(() => normalizePlanQuestions([questions[0], questions[0]]), /duplicate question/);
  assert.throws(() => normalizePlanQuestions([{ ...questions[0], options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }]), /duplicate option/);
  assert.throws(() => normalizePlanQuestions([{ ...questions[0], prompt: "x".repeat(501) }]), /oversized/);
  assert.throws(() => normalizePlanQuestions([{ ...questions[0], options: "text" }]), /options/);
});

test("plan questions survive canonical create, update and GET without inventing answers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-questions-"));
  try {
    const plan = createPlan(root, { title: "Question persistence", focus: "Verify question storage", keywords: ["questions"], status: "待补充信息",
      currentStepId: "ask", steps: [{ id: "ask", title: "Clarify after analysis", questions }] });
    assert.deepEqual(getPlan(root, plan.id)?.steps[0]?.questions, normalizePlanQuestions(questions));
    const mixed = normalizePlanQuestions([...questions, { id: "changes", prompt: "选择要修改的项目", selectionMode: "multiple", requireOption: true, options: [{ id: "a", label: "调整页面提示" }, { id: "keep", label: "保持现状", exclusive: true }] }]);
    updatePlan(root, plan.id, { steps: [{ id: "ask", title: "确认修改范围", questions: mixed }] });
    assert.deepEqual(getPlan(root, plan.id)?.steps[0]?.questions, mixed);
    updatePlan(root, plan.id, { steps: [{ id: "ask", title: "Clarify after analysis", questions: [{ id: "new", prompt: "New question?", options: [] }] }] });
    assert.equal(getPlan(root, plan.id)?.steps[0]?.questions?.[0]?.id, "new");
    assert.throws(() => updatePlan(root, plan.id, { steps: [{ id: "ask", title: "Invalid", questions: [{ id: "", prompt: "?" }] }] }), /Plan questions/);
    assert.equal(getPlan(root, plan.id)?.steps[0]?.questions?.[0]?.id, "new");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("default approval requires a deliberate choice and written suggestions", () => {
  const q = approvalDecisionQuestions([]);
  assert.equal(q[0].options.length, 2);
  assert.equal(planQuestionReply(q, {}).valid, false);
  assert.equal(planQuestionReply(q, { "approval-decision": { text: "Some text" } }).valid, false);
  assert.equal(planQuestionReply(q, { "approval-decision": { optionId: "execute" } }).valid, true);
  assert.equal(planQuestionReply(q, { "approval-decision": { optionId: "suggest", text: "  " } }).valid, false);
  assert.equal(planQuestionReply(q, { "approval-decision": { optionId: "suggest", text: "Change the scope" } }).valid, true);
  const merged = approvalDecisionQuestions([{ ...q[0], prompt: "Agent question" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].prompt, "Agent question");
  assert.equal(planQuestionReply(merged, { [merged[0].id]: { optionId: "execute" } }).valid, true);
  assert.equal(approvalDecisionQuestions([normalizePlanQuestions(questions)[1]]).length, 2);
  assert.deepEqual(normalizePlanQuestions(q), normalizePlanQuestions(normalizePlanQuestions(q)));
});


test("单选兼容与Agent配置的多选题按类型规范化", () => {
  assert.equal(normalizePlanQuestions(questions)[0].selectionMode, "single");
  const [q] = normalizePlanQuestions([{ ...questions[0], selectionMode: "multiple",
    options: [{ id: "a", label: "调整刷新按钮" }, { id: "keep", label: "保持现状", exclusive: true }] }]);
  assert.equal(q.selectionMode, "multiple");
  assert.equal(q.options[1].exclusive, true);
  assert.throws(() => normalizePlanQuestions([{ ...questions[0], selectionMode: "unexpected" }]), /selectionMode/);
  assert.throws(() => normalizePlanQuestions([{ id: "q", prompt: "?", selectionMode: "multiple", options: [] }]), /options/);
  assert.throws(() => normalizePlanQuestions([{ ...questions[0], options: [{ id: "a", label: "A", exclusive: "yes" }] }]), /exclusive/);
});

test("多选保留全部选项并拒绝重复、未知和单选答案混用", () => {
  const q = normalizePlanQuestions([{ ...questions[0], selectionMode: "multiple", requireOption: true }]);
  const reply = planQuestionReply(q, { scope: { optionIds: ["deliver", "refresh"], text: "保留其它行为" } });
  assert.equal(reply.valid, true);
  assert.equal(reply.text, "Which action failed?\nRefresh\nDeliver\n保留其它行为");
  for (const optionIds of [[], ["refresh", "refresh"], ["removed"]]) {
    assert.equal(planQuestionReply(q, { scope: { optionIds } }).valid, false);
  }
  assert.equal(planQuestionReply(q, { scope: { optionId: "refresh" } }).valid, false);
  assert.equal(planQuestionReply(normalizePlanQuestions(questions), { scope: { optionIds: ["refresh", "deliver"] } }).valid, false);
});

test("多选的保持现状为互斥选项，所选建议仍要求补充文字", () => {
  const q = normalizePlanQuestions([{ id: "changes", prompt: "要调整哪些行为？", selectionMode: "multiple", requireOption: true,
    options: [{ id: "a", label: "修改按钮提示" }, { id: "suggest", label: "提出修改建议", requiresText: true },
      { id: "keep", label: "都不做，保持现状", exclusive: true }] }]);
  assert.equal(planQuestionReply(q, { changes: { optionIds: ["keep"] } }).valid, true);
  assert.equal(planQuestionReply(q, { changes: { optionIds: ["keep", "a"] } }).valid, false);
  assert.equal(planQuestionReply(q, { changes: { optionIds: ["a", "suggest"] } }).valid, false);
  assert.equal(planQuestionReply(q, { changes: { optionIds: ["a", "suggest"], text: "调整提示位置" } }).valid, true);
});

test("同一次审批可混合单选、多选和文字题，并逐题检查必答", () => {
  const q = approvalDecisionQuestions(normalizePlanQuestions([
    { id: "one", prompt: "选择处理方式", requireOption: true, options: [{ id: "a", label: "保留手动操作" }] },
    { id: "many", prompt: "选择要修改的项目", selectionMode: "multiple", requireOption: true,
      options: [{ id: "x", label: "修改按钮文字" }, { id: "y", label: "修改页面提示" }] },
    { id: "notes", prompt: "其它要求", required: false, options: [] }
  ]));
  const answers = { "question:one": { optionId: "a" }, "question:many": { optionIds: ["x", "y"] } };
  assert.equal(q.length, 3);
  assert.equal(planQuestionReply(q, answers).valid, true);
  assert.equal(planQuestionReply(q, { "question:one": answers["question:one"] }).valid, false);
  assert.equal(planQuestionReply(q, answers).text, "选择处理方式\n保留手动操作\n\n选择要修改的项目\n修改按钮文字\n修改页面提示");
});

test("选择事件支持切换、取消及保持现状互斥，不修改其它题目的答案", () => {
  const [q] = normalizePlanQuestions([{ id: "changes", prompt: "选择改动", selectionMode: "multiple", options: [
    { id: "a", label: "调整按钮" }, { id: "b", label: "调整提示" }, { id: "keep", label: "保持现状", exclusive: true }
  ] }]);
  const original = { optionIds: ["a"], text: "补充条件" };
  let answer = selectPlanQuestionOption(q, original, "b");
  assert.deepEqual(answer, { optionIds: ["a", "b"], text: "补充条件" });
  assert.deepEqual(original.optionIds, ["a"]);
  answer = selectPlanQuestionOption(q, answer, "a");
  assert.deepEqual(answer.optionIds, ["b"]);
  answer = selectPlanQuestionOption(q, answer, "keep");
  assert.deepEqual(answer.optionIds, ["keep"]);
  answer = selectPlanQuestionOption(q, answer, "a");
  assert.deepEqual(answer.optionIds, ["a"]);
  assert.deepEqual(selectPlanQuestionOption(q, answer, "a").optionIds, []);
  assert.equal(selectPlanQuestionOption(q, answer, "unknown"), answer);
  const single = { ...q, selectionMode: "single" as const };
  assert.deepEqual(selectPlanQuestionOption(single, { optionId: "a" }, "b"), { optionId: "b", text: undefined });
});

test("异常答案不得绕过题目校验", () => {
  const q = normalizePlanQuestions([{ ...questions[0], requireOption: true }]);
  for (const value of [false, 1, "refresh", [], { optionId: 0 }, { text: 12 }, { optionIds: "refresh" }]) {
    assert.equal(planQuestionReply(q, { scope: value as PlanQuestionAnswer }).valid, false);
  }
});


test("方案明细区分代码、预制体、美术和配置，并随多题计划持久化", () => {
  const implementation = { changes: [
    { kind: "code", path: "src/Inventory.cs", target: "RefreshItems", change: "列表刷新时过滤数量为零的物品。" },
    { kind: "prefab", path: "Assets/UI/Inventory.prefab", target: "RefreshButton.onClick", change: "把按钮绑定到已有刷新方法。" },
    { kind: "art", path: "Assets/UI/refresh.png", change: "替换刷新图标，保留尺寸和引用。" },
    { kind: "configuration", path: "Config/Inventory.json", target: "emptyHint", change: "设置空列表提示。" }
  ], validation: "验证空列表和非空列表。", rollback: "还原上述修改。" };
  const q = normalizePlanQuestions([{ id: "fix", prompt: "是否修改库存列表？", implementation, options: [
    { id: "apply", label: "按方案修改" }, { id: "keep", label: "保持现状" }
  ] }, { id: "design", prompt: "选择图标设计", options: [
    { id: "a", label: "使用文字按钮", implementation: { changes: [implementation.changes[1]] } },
    { id: "b", label: "使用图标按钮", implementation: { changes: [implementation.changes[2]] } }
  ] }]);
  assert.deepEqual(normalizePlanQuestions(q), q);
  assert.equal(q[0].implementation?.changes.length, 4);
  assert.notDeepEqual(q[1].options[0].implementation, q[1].options[1].implementation);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-question-details-"));
  try {
    const plan = createPlan(root, { title: "审批明细", focus: "验证结构化明细", keywords: ["approval"], status: "分析中",
      currentStepId: "ask", steps: [{ id: "ask", title: "确认范围", questions: q }] });
    assert.deepEqual(getPlan(root, plan.id)?.steps[0]?.questions, q);
    const updated = normalizePlanQuestions([{ ...q[0], implementation: { ...implementation, changes: [implementation.changes[0]] } }]);
    updatePlan(root, plan.id, { steps: [{ id: "ask", title: "确认范围", questions: updated }] });
    assert.deepEqual(getPlan(root, plan.id)?.steps[0]?.questions, updated);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("实施明细拒绝空改动、未知类型及超长内容", () => {
  for (const implementation of [null, "text", { changes: [] }, { changes: [{ kind: "code", path: "x", change: "" }] },
    { changes: [{ kind: "unknown", path: "x", change: "y" }] },
    { changes: [{ kind: "code", path: "x", change: "x".repeat(3001) }] },
    { changes: Array.from({ length: 31 }, () => ({ kind: "art", path: "x", change: "y" })) }]) {
    assert.throws(() => normalizePlanQuestions([{ ...questions[0], implementation }]), /Plan questions/);
    assert.throws(() => normalizePlanQuestions([{ ...questions[0], options: [{ id: "x", label: "X", implementation }] }]), /Plan questions/);
  }
});


test("明确的单一方案不再要求编造备选方案", () => {
  const contract = { approver: "负责人", request: "批准修复列表", recommendation: "列表过滤零数量物品", reason: "已定位过滤条件缺失",
    files: [{ path: "src/Inventory.cs", action: "modify" as const, change: "增加数量条件" }], commands: [], changes: [],
    validation: ["验证列表"], rollback: ["还原文件"], outOfScope: ["不改存档"], requestedAt: "2026-09-10T00:00:00Z",
    sourceMessageId: "source-example", responseStatus: "pending" as const };
  assert.deepEqual(approvalRequestMissingFields(contract), []);
  assert.deepEqual(approvalRequestMissingFields({ ...contract, alternatives: [] }), []);
  assert.ok(!approvalRequestMissingFields(undefined).includes("alternatives"));
  assert.ok(approvalRequestMissingFields({ ...contract, files: [] }).includes("affectedActions"));
});
