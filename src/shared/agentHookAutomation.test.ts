import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentCompletionDeliveries, agentHookRuleErrors } from "./agentHookAutomation.js";

test("session condition normalization retains IDs and display names and rejects empty selections", () => {
  const base = { id: "rule", enabled: true, event: "task_completed",
    destination: { channel: "speech", gatewayId: "route", params: {} } };
  for (const type of ["include_sessions", "exclude_sessions"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ ...base, conditions: [{ type,
      sessions: [{ id: " first ", name: " Renamed task " }, { id: "first", name: "Current name" }, { id: "", name: "Invalid" }] }] }]);
    assert.deepEqual(rule.conditions, [{ type, sessions: [{ id: "first", name: "Current name" }] }]);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
    assert.deepEqual(agentHookRuleErrors(rule), []);
    for (const sessions of [undefined, [], [{ id: "", name: "Invalid" }]]) {
      assert.ok(agentHookRuleErrors({ ...base, conditions: [{ type, sessions }] }).length);
    }
  }
});

test("legacy group rules migrate to one event, an AND condition list, and endpoint parameters", () => {
  const [rule] = normalizeAgentCompletionDeliveries([{ id: "saved-rule", enabled: true, projectPath: "C:/project",
    requireBoundPlan: true, gatewayId: "route", instanceId: "qq", groupId: "12345" }]);
  assert.deepEqual(rule, { id: "saved-rule", enabled: true, event: "task_completed",
    conditions: [{ type: "project", path: "C:/project" }, { type: "bound_plan" }],
    destination: { channel: "napcat", gatewayId: "route", params: { target: "group", targetId: "12345", instanceId: "qq" } } });
  assert.deepEqual(agentHookRuleErrors(rule), []);
  assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  assert.equal("projectPath" in rule, false);
  assert.equal("requireBoundPlan" in rule, false);
});

test("conditions and endpoint-specific parameters fail closed without imposing QQ fields on speech", () => {
  const base = { id: "rule", enabled: true, event: "task_completed", conditions: [],
    destination: { channel: "speech", gatewayId: "route", params: {} } };
  assert.deepEqual(agentHookRuleErrors(base), []);
  for (const change of [
    { event: "unknown" }, { conditions: [{ type: "unknown" }] },
    { conditions: [{ type: "project", path: "relative" }] },
    { conditions: [{ type: "bound_plan" }, { type: "bound_plan" }] },
    { destination: { channel: "napcat", gatewayId: "route", params: {} } }
  ]) assert.ok(agentHookRuleErrors({ ...base, ...change }).length);
  const [invalid] = normalizeAgentCompletionDeliveries([{ ...base, conditions: [{ type: "future-condition" }] }]);
  assert.ok(agentHookRuleErrors(invalid).length, "unknown conditions cannot become an unconditional rule");
  assert.deepEqual(agentHookRuleErrors({ ...base, destination: { channel: "napcat", gatewayId: "route",
    params: { target: "private", targetId: "67890", instanceId: "qq" } } }), []);
});
