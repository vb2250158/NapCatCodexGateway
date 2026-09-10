export type AgentCapabilityHintContext = {
  managerPort?: string;
  roleId: string;
};

const PERSONA_SYNC_INTENT_PATTERN = /(?:人格|角色).{0,8}(?:同步|跨机|多机|多电脑|合并)|同步.{0,8}(?:人格|角色)|多台?电脑.{0,12}(?:人格|角色|同步|数据)|persona[\s_-]*sync|(?:persona|role).{0,8}\bpeer\b/i;
const VOICE_IDENTITY_INTENT_PATTERN = /声纹|谁(?:在)?说的|说话人|哪些.{0,8}(?:是我|用户).{0,8}说|(?:用户|我).{0,8}说的.{0,8}(?:别人|其他人)|(?:别人|其他人).{0,8}说的|区分.{0,12}(?:用户|我|别人|其他人).{0,8}说|(?:一天|全天).{0,8}录音|voiceprint|speaker[\s_-]*identity/i;
const PLAN_ASSISTANT_INTENT_PATTERN = /计划|秘书|委派|委托|派发|分派|交给.{0,12}(?:处理|执行)|\b(?:plan|delegate|delegation|secretary)\b/i;
const REMOTE_AGENT_INTENT_PATTERN = /远端|远程.{0,12}(?:执行|任务|运行|构建|打包|设备)|(?:另一台|其他|其它)电脑.{0,12}(?:执行|运行|构建|打包)|\bremote[\s_-]*(?:agent|task|device|exec|build)\b/i;

// These gates select documentation only; they never grant permission or dispatch work.
export function needsPlanAssistantHint(text: string, routeKind: string): boolean {
  return routeKind === "plan_feedback" || PLAN_ASSISTANT_INTENT_PATTERN.test(text);
}

export function needsRemoteAgentHint(text: string): boolean {
  return REMOTE_AGENT_INTENT_PATTERN.test(text);
}

function managerBaseUrl(context: AgentCapabilityHintContext): string {
  const rawPort = String(context.managerPort || "").trim();
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
    throw new Error("A valid current Manager port is required for Agent capability hints.");
  }
  const port = Number(rawPort);
  if (port > 65535) {
    throw new Error("A valid current Manager port is required for Agent capability hints.");
  }
  return `http://127.0.0.1:${port}`;
}

export function personaSyncCapabilityHint(
  text: string,
  context: AgentCapabilityHintContext
): string[] | null {
  if (!PERSONA_SYNC_INTENT_PATTERN.test(text)) return null;
  const baseUrl = managerBaseUrl(context);
  return [
    "这是一次显式的人格同步请求；只执行一次查询/同步，不创建后台轮询或自动定时同步。",
    `- 查询同应用在线设备：GET ${baseUrl}/api/persona-sync/peers`,
    `- 同步当前人格：POST ${baseUrl}/api/persona-sync/sync`,
    "请求体：",
    JSON.stringify({ peerId: "<从 peers 中选择的 id>", roleId: context.roleId }, null, 2),
    "默认只同步当前人格；只有用户明确要求时才省略 roleId 同步全部人格。",
    "如果没有唯一可用 peer，不要猜目标设备；先向用户确认。",
    "必须检查 HTTP 200/409、conflicts、fileConflicts 和 semanticConflicts；存在冲突时不能声称同步完成。",
    `- 查看普通文件冲突：GET ${baseUrl}/api/persona-sync/conflicts?roleId=${encodeURIComponent(context.roleId)}`,
    `- 读取/解决冲突：GET ${baseUrl}/api/persona-sync/conflicts/content；POST ${baseUrl}/api/persona-sync/conflicts/resolve`,
    "冲突解决必须基于当前证据并携带 expectedLocalHash；不要按最后写入者自动覆盖。"
  ];
}

export function voiceIdentityReviewCapabilityHint(
  text: string,
  context: AgentCapabilityHintContext
): string[] | null {
  if (!VOICE_IDENTITY_INTENT_PATTERN.test(text)) return null;
  const baseUrl = managerBaseUrl(context);
  const rolePath = encodeURIComponent(context.roleId);
  return [
    "主机只保存不透明声纹、分段和模型证据，不判断是谁，也不判断谁是用户；归类结论只属于当前人格。",
    `- 查询当前人格语音归类：GET ${baseUrl}/api/roles/${rolePath}/voice-transcripts?from=<ISO>&to=<ISO>&speaker=<user|other|unknown|conflict>&limit=200`,
    "省略 speaker 可同时取得 user/other/unknown/conflict 汇总；matchedCount 和 summary 基于完整筛选结果，不受明细 limit 截断。",
    `- 查询语音消息端账号的兼容归类：GET ${baseUrl}/api/roles/${rolePath}/voice-identities`,
    `- 确认或修正语音账号归类：PUT ${baseUrl}/api/roles/${rolePath}/voice-identities`,
    "关系写入示例：",
    JSON.stringify({
      sourceHostId: "<从语音记录取得>",
      voiceprintId: "<不透明声纹 ID>",
      displayName: "<当前人格理解的称呼>",
      relationship: "<与当前人格的关系>",
      isUser: "<确认后填 true/false；不确定时省略>"
    }, null, 2),
    "只根据当前人格自己的会话、记忆、用户确认和关系证据判断；证据不足时保持 unknown，不把主机候选或高分直接当作用户。",
    "PUT 会追加关系事件并显式收敛当前并发分支，不重写原始语音；只执行当前请求需要的查询，不周期轮询覆盖率。"
  ];
}
