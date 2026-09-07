import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProactiveGroupReplyContext,
  stableWorkCycleDeliveryId,
  validateWorkCycleSendNotification
} from "./work-cycle-send-contract.mjs";

const plan = {
  id: "plan-placeholder",
  status: "进行中",
  currentStepId: "collect-owner-contract",
  steps: [{ id: "collect-owner-contract", status: "进行中", waitingFor: "owner response" }]
};

test("inquiry notification is mutually exclusive with QA and approval", () => {
  assert.throws(() => validateWorkCycleSendNotification({
    input: { inquiryNotification: true, qaNotification: true },
    text: "[CQ:at,qq=10001] question",
    plan,
    planId: plan.id,
    issueGroupId: "20001"
  }), /exactly one notification type/i);
  assert.throws(() => validateWorkCycleSendNotification({
    input: { inquiryNotification: true, approvalNotification: true },
    text: "[CQ:at,qq=10001] question",
    plan,
    planId: plan.id,
    issueGroupId: "20001"
  }), /exactly one notification type/i);
});

test("inquiry notification fails closed without explicit group, CQ at, or one exact plan", () => {
  const base = { inquiryNotification: true, replyContext: { groupId: "20001" } };
  assert.throws(() => validateWorkCycleSendNotification({
    input: { inquiryNotification: true }, text: "[CQ:at,qq=10001] question", plan, planId: plan.id, issueGroupId: "20001"
  }), /explicit target group/i);
  assert.throws(() => validateWorkCycleSendNotification({
    input: base, text: "plain question", plan, planId: plan.id, issueGroupId: "20001"
  }), /CQ @/i);
  assert.throws(() => validateWorkCycleSendNotification({
    input: { ...base, planIds: [plan.id, "plan-two"] }, text: "[CQ:at,qq=10001] question", plan, planId: plan.id, issueGroupId: "20001"
  }), /one plan/i);
  assert.throws(() => validateWorkCycleSendNotification({
    input: { ...base, planId: "another-plan" }, text: "[CQ:at,qq=10001] question", plan, planId: plan.id, issueGroupId: "20001"
  }), /planId/i);
  assert.throws(() => validateWorkCycleSendNotification({
    input: { ...base, replyContext: { groupId: "another-group" } }, text: "[CQ:at,qq=10001] question", plan, planId: plan.id, issueGroupId: "20001"
  }), /does not match/i);
});

test("inquiry notification never accepts or inherits a reply anchor", () => {
  assert.throws(() => validateWorkCycleSendNotification({
    input: { inquiryNotification: true, replyContext: { groupId: "20001", messageId: "old-source" } },
    text: "[CQ:at,qq=10001] question",
    plan,
    planId: plan.id,
    issueGroupId: "20001"
  }), /must not include a reply anchor/i);

  const contract = validateWorkCycleSendNotification({
    input: { inquiryNotification: true, replyContext: { groupId: "20001" } },
    text: "[CQ:at,qq=10001] question",
    plan,
    planId: plan.id,
    issueGroupId: "20001"
  });
  const context = buildProactiveGroupReplyContext({
    routeConfig: { configName: "route-placeholder", napcatInstances: [{ id: "napcat-placeholder", enabled: true }] },
    issueGroupId: "stale-source-group",
    explicitGroupId: contract.groupId,
    inputContext: { groupId: "20001" }
  });
  assert.equal(context.groupId, "20001");
  assert.equal(context.messageId, undefined);
  assert.equal(context.replyMessageId, undefined);
  assert.equal(context.replyToSource, false);
  assert.equal(context.proactive, true);
});

test("explicitly referenced ordinary replies remain on the referenced path", () => {
  const contract = validateWorkCycleSendNotification({
    input: { replyContext: { messageId: "valid-anchor" } },
    text: "ordinary referenced reply",
    plan,
    planId: plan.id,
    issueGroupId: "20001"
  });
  assert.equal(contract.kind, "referenced");
  assert.equal(contract.proactive, false);
});

test("inquiry delivery id is stable for one plan cycle and kind", () => {
  const first = stableWorkCycleDeliveryId({ planId: plan.id, cycleId: "cycle-one", kind: "inquiry" });
  const second = stableWorkCycleDeliveryId({ planId: plan.id, cycleId: "cycle-one", kind: "inquiry" });
  const nextCycle = stableWorkCycleDeliveryId({ planId: plan.id, cycleId: "cycle-two", kind: "inquiry" });
  assert.equal(first, second);
  assert.notEqual(first, nextCycle);
  assert.match(first, /^work-cycle-inquiry-/);
});

test("delivery key distinguishes multiple QA files in one plan cycle", () => {
  const android = stableWorkCycleDeliveryId({
    planId: plan.id,
    cycleId: "cycle-one",
    kind: "qa",
    deliveryKey: "android-package"
  });
  const androidRetry = stableWorkCycleDeliveryId({
    planId: plan.id,
    cycleId: "cycle-one",
    kind: "qa",
    deliveryKey: "android-package"
  });
  const windows = stableWorkCycleDeliveryId({
    planId: plan.id,
    cycleId: "cycle-one",
    kind: "qa",
    deliveryKey: "windows-package"
  });

  assert.equal(android, androidRetry);
  assert.notEqual(android, windows);
  assert.match(android, /^work-cycle-qa-/);
  assert.match(windows, /^work-cycle-qa-/);
});
