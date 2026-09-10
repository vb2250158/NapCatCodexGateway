import assert from "node:assert/strict";
import test from "node:test";
import { decidePlanFollowup } from "./planFollowup.js";
import type { PlanItem } from "../roleKnowledge.js";
import type { PersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { normalizePlanFollowup } from "../shared/planFollowup.js";

const config = { enabled: true, cooldownSeconds: 10, rules: [
  { id: "custom", enabled: true, statusKeys: ["review-custom"], prompt: "核对当前可执行事项" }
] };
const plan = { id: "p", title: "Review", status: "review-custom", archiveStatus: "未归档", steps: [],
  taskBinding: { agentType: "codex", sessionId: "worker" } } as unknown as PlanItem;
const workflow = { statuses: [{ key: "review-custom", label: "自定义审查", state: "enabled", terminal: false }] } as PersonaPlanWorkflow;
const input = { config, plan, workflow, sessionId: "worker", turnId: "one", now: 10000 };

test("persona selects custom status and text; missing configuration never prompts", () => {
  assert.match(decidePlanFollowup(input)!.reason, /核对当前可执行事项/);
  assert.equal(decidePlanFollowup({ ...input, config: undefined }), null);
  assert.equal(decidePlanFollowup({ ...input, config: { ...config, enabled: false } }), null);
  assert.equal(decidePlanFollowup({ ...input, plan: { ...plan, status: "执行中" } }), null);
  assert.equal(decidePlanFollowup({ ...input, sessionId: "other" }), null);
  assert.equal(decidePlanFollowup({ ...input, config: { ...config, rules: [] } }), null);
});
test("duplicate, same-turn, cooldown, recursion and terminal guards", () => {
  const previous = decidePlanFollowup(input)!.receipt;
  assert.equal(decidePlanFollowup({ ...input, previous, turnId: "two", now: 30000 }), null);
  const changed = { ...plan, nextAction: "new evidence" };
  assert.equal(decidePlanFollowup({ ...input, plan: changed, previous, now: 30000 }), null);
  assert.equal(decidePlanFollowup({ ...input, plan: changed, previous, turnId: "two", now: 15000 }), null);
  assert.ok(decidePlanFollowup({ ...input, plan: changed, previous, turnId: "two", now: 30000 }));
  assert.equal(decidePlanFollowup({ ...input, stopHookActive: true }), null);
  assert.equal(decidePlanFollowup({ ...input, workflow: { ...workflow, statuses: workflow.statuses.map(s => ({ ...s, terminal: true })) } }), null);
});
test("normalization preserves explicit empty selection and bounds invalid numbers", () => {
  assert.deepEqual(normalizePlanFollowup(undefined), { enabled: false, cooldownSeconds: 300, rules: [] });
  assert.equal(normalizePlanFollowup({ ...config, cooldownSeconds: NaN }).cooldownSeconds, 300);
  assert.deepEqual(normalizePlanFollowup(config), config);
});
