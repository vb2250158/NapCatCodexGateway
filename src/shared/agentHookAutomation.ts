export const AGENT_HOOK_EVENTS = [{ value: "task_completed", title: "任务完成", hookEvent: "Stop" }] as const;
export const AGENT_HOOK_CONDITIONS = [
  { value: "project", title: "限定项目" },
  { value: "bound_plan", title: "必须绑定计划" },
  { value: "include_sessions", title: "限定聊天会话" },
  { value: "exclude_sessions", title: "排除聊天会话" }
] as const;
export const AGENT_HOOK_DESTINATIONS = [
  { value: "napcat", title: "NapCat（QQ）" },
  { value: "speech", title: "语音" }
] as const;

export type AgentHookSession = { id: string; name: string };
export type AgentHookCondition = { type: string; path?: string; sessions?: AgentHookSession[] };
export type AgentHookDestination = { channel: string; gatewayId: string; params: Record<string, string> };
export type AgentCompletionDeliveryRule = {
  id: string;
  enabled: boolean;
  event: string;
  conditions: AgentHookCondition[];
  destination: AgentHookDestination;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Old project/group rules migrate at the configuration boundary; only the new shape is written. */
export function normalizeAgentCompletionDeliveries(value: unknown): AgentCompletionDeliveryRule[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap(entry => {
    const raw = object(entry); const id = text(raw.id);
    if (!id || ids.has(id)) return [];
    ids.add(id);
    const legacy = !raw.destination && ("projectPath" in raw || "groupId" in raw);
    const destination = object(raw.destination);
    const params = object(destination.params);
    const channel = text(destination.channel);
    const normalizedParams: Record<string, string> = channel === "napcat"
      ? { target: text(params.target), targetId: text(params.targetId), instanceId: text(params.instanceId) }
      : channel === "speech" ? (text(params.sessionId) ? { sessionId: text(params.sessionId) } : {})
      : Object.fromEntries(Object.entries(params).map(([key, value]) => [key, text(value)]));
    const conditions: AgentHookCondition[] = legacy
      ? [{ type: "project", path: text(raw.projectPath) }, ...(raw.requireBoundPlan === true ? [{ type: "bound_plan" }] : [])]
      : Array.isArray(raw.conditions) ? raw.conditions.map(item => {
        const condition = object(item);
        const sessions = Array.isArray(condition.sessions) ? [...new Map(condition.sessions.map(entry => {
          const session = object(entry);
          return [text(session.id), { id: text(session.id), name: text(session.name) }] as const;
        }).filter(([id]) => id)).values()] : [];
        return { type: text(condition.type), ...(condition.path !== undefined ? { path: text(condition.path) } : {}),
          ...(condition.sessions !== undefined ? { sessions } : {}) };
      }) : [{ type: "invalid" }];
    return [{ id, enabled: raw.enabled === true, event: legacy ? "task_completed" : text(raw.event), conditions,
      destination: legacy
        ? { channel: "napcat", gatewayId: text(raw.gatewayId), params: { target: "group", targetId: text(raw.groupId), instanceId: text(raw.instanceId) } }
        : { channel, gatewayId: text(destination.gatewayId), params: normalizedParams } }];
  });
}

export function agentHookRuleErrors(rule: AgentCompletionDeliveryRule): string[] {
  const errors: string[] = [];
  if (!AGENT_HOOK_EVENTS.some(event => event.value === rule.event)) errors.push("请选择支持的事件。");
  const seen = new Set<string>();
  for (const condition of rule.conditions) {
    if (!AGENT_HOOK_CONDITIONS.some(item => item.value === condition.type)) errors.push("存在不支持的条件。");
    if (seen.has(condition.type)) errors.push("同一种条件只能添加一次。");
    seen.add(condition.type);
    if (["include_sessions", "exclude_sessions"].includes(condition.type)
      && (!condition.sessions?.length || condition.sessions.some(session => !session.id?.trim()))) errors.push("会话条件至少需要选择一个聊天会话。");
    if (condition.type === "project" && !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(condition.path || "")) errors.push("项目条件需要填写绝对目录。");
  }
  const destination = rule.destination;
  if (!destination.gatewayId) errors.push("请选择消息路线。");
  if (!AGENT_HOOK_DESTINATIONS.some(item => item.value === destination.channel)) errors.push("请选择支持的消息端。");
  if (destination.channel === "napcat") {
    if (!destination.params.instanceId) errors.push("请选择 QQ 账号。");
    if (!["group", "private"].includes(destination.params.target)) errors.push("请选择群或个人 QQ。");
    if (!/^\d+$/.test(destination.params.targetId || "")) errors.push("请填写有效的群号或 QQ 号。");
  }
  return errors;
}
