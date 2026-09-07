import { createHash } from "node:crypto";

function text(value) {
  return String(value || "").trim();
}

function notificationFlags(input) {
  return {
    inquiry: input?.inquiryNotification === true,
    qa: input?.qaNotification === true,
    approval: input?.approvalNotification === true
  };
}

export function validateWorkCycleSendNotification({ input, text: replyText, plan, planId, issueGroupId }) {
  const flags = notificationFlags(input);
  const selected = Object.entries(flags).filter(([, enabled]) => enabled).map(([kind]) => kind);
  if (selected.length > 1) throw new Error("Exactly one notification type may be selected: inquiry, QA, or approval.");
  const kind = selected[0] || "referenced";
  if (kind !== "inquiry") return { kind, proactive: kind !== "referenced" };

  if (plan?.status !== "进行中") throw new Error("Inquiry notification requires one running plan.");
  const inputPlanId = text(input?.planId);
  if (inputPlanId && inputPlanId !== planId) throw new Error(`Inquiry notification planId does not match --plan: ${inputPlanId}.`);
  if (input?.planIds !== undefined) {
    if (!Array.isArray(input.planIds) || input.planIds.length !== 1 || text(input.planIds[0]) !== planId) {
      throw new Error("Inquiry notification must bind exactly one plan.");
    }
  }

  const inputContext = input?.replyContext && typeof input.replyContext === "object" && !Array.isArray(input.replyContext)
    ? input.replyContext
    : {};
  if (text(inputContext.messageId) || text(inputContext.replyMessageId)) {
    throw new Error("Inquiry notification must not include a reply anchor; use the ordinary referenced reply path instead.");
  }
  const groupId = text(inputContext.groupId || input?.groupId);
  if (!groupId) throw new Error("Inquiry notification requires an explicit target group in replyContext.groupId.");
  const expectedGroupId = text(issueGroupId);
  if (expectedGroupId && groupId !== expectedGroupId) {
    throw new Error(`Inquiry notification target group ${groupId} does not match the tracked plan group ${expectedGroupId}.`);
  }
  const atTargets = [...String(replyText || "").matchAll(/\[CQ:at,qq=(\d+)\]/g)].map((match) => match[1]);
  if (atTargets.length === 0) throw new Error("Inquiry notification requires at least one real CQ @ target.");
  return { kind, proactive: true, groupId, atTargets };
}

export function buildProactiveGroupReplyContext({ routeConfig, issueGroupId, explicitGroupId, inputContext = {} }) {
  const instance = Array.isArray(routeConfig?.napcatInstances)
    ? routeConfig.napcatInstances.find((item) => item?.enabled !== false) || routeConfig.napcatInstances[0]
    : null;
  const routeId = text(routeConfig?.configName || routeConfig?.id || "XinghaiBuilder-main");
  const { messageId: _messageId, replyMessageId: _replyMessageId, ...safeInputContext } = inputContext;
  return {
    ...safeInputContext,
    runtimeRouteId: routeId,
    gatewayId: routeId,
    routeProfileId: routeId,
    targetType: "group",
    groupId: text(explicitGroupId || issueGroupId),
    instanceId: text(instance?.id || safeInputContext.instanceId),
    adapterType: "napcat",
    roleId: "XinghaiBuilder",
    outputAdapter: "qq",
    outputPipeline: "qq",
    proactive: true,
    replyToSource: false
  };
}

export function stableWorkCycleDeliveryId({ planId, cycleId, kind, deliveryKey }) {
  const normalizedKind = text(kind) || "send";
  const digest = createHash("sha256")
    .update(`${text(planId)}\n${text(cycleId)}\n${normalizedKind}\n${text(deliveryKey)}`, "utf8")
    .digest("hex");
  return `work-cycle-${normalizedKind}-${digest}`;
}
