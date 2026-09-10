import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approvalDecisionQuestions, normalizePlanQuestions, planQuestionReply } from "./shared/planQuestions.js";
import { createPlan, getPlan, updatePlan } from "./roleKnowledge.js";

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
