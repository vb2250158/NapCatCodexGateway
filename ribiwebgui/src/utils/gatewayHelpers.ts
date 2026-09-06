import type { AgentAdapterType, GatewayDefinition, MessageAdapterPolicy, MessageAdapterType, MessageEndpointType, NotificationRule, NotificationScheduleDefinition, PersonaAutomationRuleDefinition, RuntimeStatus } from "../types";
import {
  defaultRolePanelNotificationRule,
  defaultMessageAdapterNotificationRules,
  ensureDefaultPersonaRules,
  ensureMessageAdapterAutomationRules,
  ensureMessageAdapterNotificationRules,
  gatewayAdapterTypes as sharedGatewayAdapterTypes,
  isBuiltinRolePanelNotificationRule,
  messageAdapterPolicyFor as sharedMessageAdapterPolicyFor,
  normalizeMessageAdapterPolicies,
  normalizePersonaAutomationRules,
  normalizeRuleDefinitions,
  notificationRulesFromPersonaAutomations,
  personaAutomationRulesFromNotificationRules,
  normalizeTemplateText as sharedNormalizeTemplateText,
  sanitizeConfigName as sharedSanitizeConfigName,
  setGatewayAdapters as sharedSetGatewayAdapters
} from "@shared/gatewayConfigModel";
import { isGatewayMessageAdapterType, isMessageEndpointType } from "@shared/messageEndpointTypes";
import { applySpeechRouteVariableDefaults } from "@shared/speechControlContract";
import { SPEECH_ROUTE_AUTO_SUBMIT } from "../speech/speechDeliveryMode";

export const routeKindLabels: Record<string, string> = {
  direct_at: "群聊-直接 @",
  direct_reply: "群聊-直接回复",
  indirect_reply: "群聊-间接回复",
  group_message: "群聊-普通消息",
  private: "私聊",
  heartbeat: "定时触发",
  manual_trigger: "手动触发",
  role_panel_message: "角色面板消息",
  plan_feedback: "计划审批",
  voice_transcript: "语音转写",
  wearable_health_alert: "智能手表/手环健康告警",
  wecom_message: "企业微信消息",
  weixin_message: "个人微信消息"
};

export const templateVars = [
  { name: "routeKind", description: "当前命中的路由类型，例如 direct_at、private、group_message、heartbeat、manual_trigger、role_panel_message、voice_transcript。" },
  { name: "RobotQQId", description: "机器人 QQ 号，来自当前消息事件 self_id。" },
  { name: "SenderQQId", description: "发送者 QQ 号。" },
  { name: "GroupId", description: "群号；私聊时为空。" },
  { name: "ReplyMessageId", description: "被回复消息 ID；非回复消息时为空。" },
  { name: "time", description: "消息时间，已格式化为本地时间。" },
  { name: "now", description: "模板渲染时的当前本地时间，等同 currentTime。" },
  { name: "currentTime", description: "模板渲染时的当前本地时间。" },
  { name: "currentDate", description: "当前日期，格式 YYYY-MM-DD。" },
  { name: "currentClock", description: "当前时分秒，格式 HH:mm:ss。" },
  { name: "currentIsoTime", description: "当前 ISO 时间字符串。" },
  { name: "currentTimestamp", description: "当前 Unix 时间戳，单位秒。" },
  { name: "currentYear", description: "当前年份。" },
  { name: "currentMonth", description: "当前月份，补零为两位。" },
  { name: "currentDay", description: "当前日期中的日，补零为两位。" },
  { name: "currentWeekday", description: "当前星期，例如 星期四。" },
  { name: "currentHour", description: "当前小时，补零为两位。" },
  { name: "currentMinute", description: "当前分钟，补零为两位。" },
  { name: "currentSecond", description: "当前秒数，补零为两位。" },
  { name: "messageTarget", description: "目标会话描述，例如群号或私聊对象。" },
  { name: "groupId", description: "群消息的群号；私聊时不填充。" },
  { name: "userId", description: "发送者 QQ 号。" },
  { name: "sender", description: "发送者显示名，优先使用群名片或昵称。" },
  { name: "message", description: "原始消息文本，包含 CQ 码。" },
  { name: "routeText", description: "用于路由匹配的消息文本，@ 和回复 CQ 码会转成更易匹配的文本。" },
  { name: "repliedRouteText", description: "被回复消息对应的路由匹配文本。" },
  { name: "repliedMessage", description: "被回复消息的原始文本。" },
  { name: "routeProfileId", description: "当前命中的 route profile ID。" },
  { name: "routeProfileName", description: "当前命中的 route profile 名称。" },
  { name: "pipelinePreset", description: "当前 pipeline preset / channel preset ID，例如 qq_chat、voice_chat、webhook_task。" },
  { name: "channelPreset", description: "pipelinePreset 的别名，供使用 channel 命名的模板使用。" },
  { name: "inputAdapter", description: "pipeline 默认输入适配端。" },
  { name: "outputAdapter", description: "pipeline 默认输出适配端，例如 qq、tts、file、agent。" },
  { name: "outputPipeline", description: "输出管道 ID，例如 qq、rabispeech、file。" },
  { name: "promptOutputMode", description: "提示词输出模式，例如 qq_text、voice_short、markdown、json。" },
  { name: "ttsProvider", description: "TTS provider，现行本地语音模式使用 rabispeech。" },
  { name: "ttsVoice", description: "TTS 声线 / character_id。" },
  { name: "ttsWorkerUrl", description: "TTS worker 地址，只作为路由决策上下文。" },
  { name: "ttsPlay", description: "是否建议 worker 播放，true / false。" },
  { name: "preventFeedbackLoop", description: "是否开启防回流策略，true / false。" },
  { name: "replyToSource", description: "是否默认回到原来消息端，true / false。" },
  { name: "agentRoleId", description: "当前选择的路由人格 ID。" },
  { name: "agentRolePath", description: "当前路由人格文件路径。" },
  { name: "agentRoleDir", description: "当前路由人格配置目录。" },
  { name: "groupLogPath", description: "群聊消息 JSONL 记录路径。" },
  { name: "privateLogPath", description: "私聊消息 JSONL 记录路径。" },
  { name: "heartbeatLogPath", description: "定时触发事件 JSONL 记录路径。" },
  { name: "manualTriggerLogPath", description: "手动触发事件 JSONL 记录路径。" },
  { name: "rolePanelLogPath", description: "角色面板聊天记录 JSONL 路径。" },
  { name: "heartbeatIntervalSeconds", description: "定时触发间隔，单位秒。" },
  { name: "heartbeatSkipWhenAgentBusy", description: "未开启消息处理 Agent 模式时，为 true 会在主人格会话工作中跳过本次 heartbeat；开启该模式后 heartbeat 改由独立消息处理 Agent 立即处理。" },
  { name: "scheduleId", description: "当前定时计划 ID；仅定时触发时填充。" },
  { name: "scheduleName", description: "当前定时计划显示名称；仅定时触发时填充。" },
  { name: "automationRuleId", description: "当前人格自动化规则 ID。" },
  { name: "automationRuleName", description: "当前人格自动化规则名称。" },
  { name: "triggerId", description: "手动触发 ID。" },
  { name: "triggerName", description: "手动触发显示名称。" },
  { name: "voiceTranscriptLogPath", description: "语音转写 JSONL 记录路径。" },
  { name: "voiceSource", description: "语音转写来源，例如 fennenote、xiaoai 或 webhook。" },
  { name: "voiceDurationSeconds", description: "语音片段时长，单位秒。" },
  { name: "voicePeak", description: "语音片段峰值音量。" },
  { name: "healthAlertType", description: "穿戴健康告警类型，例如 heart_rate_high、heart_rate_low、sleep_state_changed。" },
  { name: "healthMetric", description: "健康指标类型，例如 heart_rate、sleep_state。" },
  { name: "heartRateBpm", description: "触发告警的心率值，单位 bpm。" },
  { name: "sourceDeviceId", description: "产生当前穿戴健康事件的稳定设备 ID。" },
  { name: "wecomReqId", description: "企业微信 WebSocket 请求 ID，用于定位来源消息。" },
  { name: "wecomConversationId", description: "企业微信会话 ID。" },
  { name: "wecomChatId", description: "企业微信群聊 chat id；模板里的 groupId 会优先使用这个值。" },
  { name: "wecomSenderId", description: "企业微信发送者 userid；模板里的 userId 会优先使用这个值。" },
  { name: "wecomMessageType", description: "企业微信消息类型，例如 text、mixed、image、voice、file。" },
  { name: "weixinSessionId", description: "个人微信来源会话 ID；回复只能返回这条来源会话。" },
  { name: "weixinUserId", description: "个人微信发送者 ID。" },
  { name: "weixinMessageType", description: "个人微信消息类型，例如 text、mixed、image、voice、file。" }
];

export function normalizeTemplateText(value: unknown): string {
  return sharedNormalizeTemplateText(value);
}

export function groupTemplate(title: string): string {
  void title;
  return "";
}

export function defaultGroupAtTemplate(): string {
  return groupTemplate("群聊里有人 @ 了机器人");
}

export function defaultGroupDirectReplyTemplate(): string {
  return groupTemplate("群聊里有人直接回复机器人");
}

export function defaultGroupIndirectReplyTemplate(): string {
  return "";
}

export function defaultPrivateTemplate(): string {
  return "";
}

export function defaultHeartbeatMessage(): string {
  return "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。";
}

export function defaultHeartbeatTemplate(): string {
  return "";
}

export function defaultVoiceTranscriptTemplate(): string {
  return "";
}

export function normalizeRule(rule: Partial<NotificationRule> | undefined, index: number): NotificationRule {
  const [normalized] = normalizeRuleDefinitions([rule ?? {}]) ?? [];
  return {
    ...normalized,
    id: rule?.id || normalized.id || `rule-${index + 1}`,
    name: rule?.name || rule?.id || `规则 ${index + 1}`
  };
}

export function cloneRules(rules: NotificationRule[] | undefined): NotificationRule[] {
  return JSON.parse(JSON.stringify(Array.isArray(rules) ? rules : [])).map((rule: NotificationRule, index: number) => normalizeRule(rule, index));
}

export function gatewayAdapterTypes(gateway: GatewayDefinition): MessageEndpointType[] {
  return sharedGatewayAdapterTypes(gateway);
}

export function isAdapterDisabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  if (type === "disabled") return true;
  return gateway.messageAdaptersDisabled?.includes(type) === true || sharedMessageAdapterPolicyFor(gateway, type).inputEnabled === false;
}

export function toggleAdapterDisabled(gateway: GatewayDefinition, type: MessageAdapterType): void {
  if (type === "disabled") return;
  const disabled = gateway.messageAdaptersDisabled ?? [];
  gateway.messageAdapterPolicies = gateway.messageAdapterPolicies ?? {};
  const current = sharedMessageAdapterPolicyFor(gateway, type);
  if (disabled.includes(type) || current.inputEnabled === false) {
    gateway.messageAdaptersDisabled = disabled.filter(t => t !== type);
    gateway.messageAdapterPolicies[type] = { ...current, inputEnabled: true };
  } else {
    gateway.messageAdaptersDisabled = [...disabled, type];
    gateway.messageAdapterPolicies[type] = { ...current, inputEnabled: false };
  }
}

export function isMessageInputsDisabled(gateway: GatewayDefinition): boolean {
  return gateway.messageInputsDisabled === true || gateway.messageAdapters?.includes("disabled") === true;
}

export function setGatewayAdapters(gateway: GatewayDefinition, adapters: MessageAdapterType[]): void {
  sharedSetGatewayAdapters(gateway, adapters);
  automationRulesForGateway(gateway);
}

export function messageAdapterPolicyFor(gateway: GatewayDefinition, type: MessageAdapterType): Required<MessageAdapterPolicy> {
  return sharedMessageAdapterPolicyFor(gateway, type);
}

export function setMessageAdapterPolicy(gateway: GatewayDefinition, type: MessageAdapterType, patch: Partial<MessageAdapterPolicy>): void {
  if (type === "disabled") return;
  gateway.messageAdapterPolicies = gateway.messageAdapterPolicies ?? {};
  gateway.messageAdapterPolicies[type] = {
    ...sharedMessageAdapterPolicyFor(gateway, type),
    ...patch
  };
  if (patch.inputEnabled != null) {
    const disabled = gateway.messageAdaptersDisabled ?? [];
    gateway.messageAdaptersDisabled = patch.inputEnabled
      ? disabled.filter(item => item !== type)
      : [...new Set([...disabled, type])];
  }
}

export function adapterLabel(type: string): string {
  if (type === "napcat") return "NapCat / OneBot";
  if (type === "remoteAgent") return "远端 Agent";
  if (type === "heartbeat") return "定时触发";
  if (type === "rolePanel") return "角色面板";
  if (type === "speech") return "语音消息端";
  if (type === "fennenote") return "FenneNote / 芬妮笔记";
  if (type === "xiaoai") return "小米音箱 / 小爱";
  if (type === "xiaomiHome") return "米家 / Xiaomi Home";
  if (type === "rabilink") return "眼镜端（经 RabiLink）";
  if (type === "wearable") return "智能手表/手环";
  if (type === "wecom") return "企业微信 / WeCom";
  if (type === "weixin") return "个人微信 / Weixin";
  if (type === "feishu") return "飞书 / Feishu";
  if (type === "webhook") return "通用 Webhook";
  if (type === "disabled") return "已禁用";
  return type;
}

export function adapterRuntimeKey(type: string): string {
  return type;
}

export function isWebhookLikeAdapter(type: string): boolean {
  return type === "webhook" || type === "fennenote" || type === "xiaoai" || type === "rabilink";
}

export function adapterNeedsGatewayRuntime(type: MessageAdapterType): boolean {
  return isGatewayMessageAdapterType(type);
}

export function adaptersNeedGatewayRuntime(types: MessageAdapterType[]): boolean {
  return types.some(adapterNeedsGatewayRuntime);
}

export function adapterSourceAliases(type: string): string[] {
  if (type === "fennenote") return ["fennenote", "fenne_note", "fenne-note", "fenne", "芬妮笔记", "芬妮"];
  if (type === "speech") return ["speech", "rabispeech", "rabipc", "语音消息端"];
  if (type === "xiaoai") return ["xiaoai", "xiao_ai", "xiao-ai", "mi_speaker", "mi-speaker", "xiaomi", "小爱", "小米音箱"];
  if (type === "xiaomiHome") return ["xiaomiHome", "xiaomi_home", "xiaomi-home", "home_assistant", "home-assistant", "米家", "智能家居"];
  if (type === "rabilink") return ["rabilink", "rabi_link", "rabi-link", "rokid", "rokid_glass", "rizon", "lingzhu", "relay", "服务器", "直连", "乐奇", "乐棋"];
  if (type === "wearable") return ["wearable", "watch", "band", "health", "smartwatch", "手表", "手环", "健康", "心率", "睡眠"];
  if (type === "wecom") return ["wecom", "wechat-work", "企业微信", "企微"];
  if (type === "feishu") return ["feishu", "lark", "飞书"];
  if (type === "webhook") return ["webhook", "generic_webhook", "generic-webhook"];
  return [type];
}

export function adapterDefaultWebhookPath(type: string): string {
  if (type === "fennenote") return "/fennenote";
  if (type === "xiaoai") return "/xiaoai";
  if (type === "rabilink") return "/rabilink";
  if (type === "feishu") return "/feishu";
  return "/webhook";
}

export function applyAdapterDefaults(gateway: GatewayDefinition): void {
  const configuredAdapters = Array.isArray(gateway.messageAdapters) && gateway.messageAdapters.length > 0
    ? gateway.messageAdapters
    : [gateway.messageAdapterType || "napcat"];
  const endpointAdapters = configuredAdapters.filter(isMessageEndpointType);
  const disabledEndpointAdapters = (gateway.messageAdaptersDisabled ?? []).filter(isMessageEndpointType);
  gateway.messageAdapterPolicies = normalizeMessageAdapterPolicies(gateway.messageAdapterPolicies, endpointAdapters, disabledEndpointAdapters);
  const adapters = gatewayAdapterTypes(gateway);
  if (adapters.includes("napcat")) {
    gateway.gatewayPort = Number(gateway.gatewayPort || 8790);
    gateway.napcatHttpUrl = gateway.napcatHttpUrl || "http://127.0.0.1:3000";
    gateway.napcatWebuiUrl = gateway.napcatWebuiUrl || "http://127.0.0.1:6099/webui";
    if (!Array.isArray(gateway.napcatInstances) || gateway.napcatInstances.length === 0) {
      gateway.napcatInstances = [{
        id: "default",
        name: "默认 NapCat",
        enabled: true,
        gatewayPort: gateway.gatewayPort,
        httpUrl: gateway.napcatHttpUrl,
        webuiUrl: gateway.napcatWebuiUrl,
        accessToken: gateway.napcatAccessToken || "",
        webuiToken: gateway.napcatWebuiToken || ""
      }];
    } else {
      const primary = gateway.napcatInstances.find(instance => instance.enabled !== false)
        ?? gateway.napcatInstances[0];
      primary.enabled = true;
      gateway.napcatInstances = [primary];
    }
  }
  if (adapters.includes("heartbeat")) {
    gateway.heartbeatIntervalSeconds = Number(gateway.heartbeatIntervalSeconds || 900);
    gateway.heartbeatMessage = gateway.heartbeatMessage || defaultHeartbeatMessage();
    gateway.heartbeatSkipWhenAgentBusy = gateway.heartbeatSkipWhenAgentBusy === true;
    migrateLegacyHeartbeatSchedules(gateway);
  }
  if (adapters.includes("speech")) {
    gateway.routeVariables = applySpeechRouteVariableDefaults(gateway.routeVariables, gateway.agentRoleId || "Rabi");
    // A speech endpoint always submits completed transcripts to RabiRoute so they can be
    // recorded. speechPushMode alone decides whether the Agent is notified immediately.
    gateway.routeVariables.speechAutoSubmit = String(SPEECH_ROUTE_AUTO_SUBMIT);
    gateway.pipelinePreset = gateway.pipelinePreset || "voice_chat";
    gateway.pipeline = {
      ...gateway.pipeline,
      inputAdapter: "speech",
      outputAdapter: "tts",
      outputPipeline: "rabispeech",
      promptOutputMode: gateway.pipeline?.promptOutputMode || "voice_short",
      ttsProvider: gateway.pipeline?.ttsProvider,
      ttsVoice: gateway.agentRoleId || gateway.pipeline?.ttsVoice,
      ttsWorkerUrl: "http://127.0.0.1:8781/v1/audio/speech",
      ttsPlay: gateway.routeVariables.speechAutoPlay !== "false",
      preventFeedbackLoop: true,
      replyToSource: false
    };
  }
  if (adapters.includes("webhook")) {
    gateway.webhookPort = Number(gateway.webhookPort || Number(gateway.gatewayPort || 8790) + 1);
    gateway.webhookPath = gateway.webhookPath || adapterDefaultWebhookPath("webhook");
  }
  if (adapters.includes("fennenote")) {
    gateway.fenneNoteWebhookPort = Number(gateway.fenneNoteWebhookPort || Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    gateway.fenneNoteWebhookPath = gateway.fenneNoteWebhookPath || adapterDefaultWebhookPath("fennenote");
  }
  if (adapters.includes("xiaoai")) {
    gateway.xiaoaiWebhookPort = Number(gateway.xiaoaiWebhookPort || Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    gateway.xiaoaiWebhookPath = gateway.xiaoaiWebhookPath || adapterDefaultWebhookPath("xiaoai");
  }
  if (adapters.includes("rabilink") || adapters.includes("wearable")) {
    gateway.rabiLinkWebhookPort = Number(gateway.rabiLinkWebhookPort || Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    gateway.rabiLinkWebhookPath = gateway.rabiLinkWebhookPath || adapterDefaultWebhookPath("rabilink");
    gateway.rabiLinkWebhookHost = gateway.rabiLinkWebhookHost || "0.0.0.0";
  }
  if (adapters.includes("wecom")) {
    gateway.wecomBotId = gateway.wecomBotId || "";
    gateway.wecomBotSecret = gateway.wecomBotSecret || "";
    gateway.wecomWsUrl = gateway.wecomWsUrl || "";
  }
  if (adapters.includes("feishu")) {
    gateway.feishuAppId = gateway.feishuAppId || "";
    gateway.feishuAppSecret = gateway.feishuAppSecret || "";
    gateway.feishuVerificationToken = gateway.feishuVerificationToken || "";
    gateway.feishuEncryptKey = gateway.feishuEncryptKey || "";
    gateway.feishuEventSubscriptionEnabled = gateway.feishuEventSubscriptionEnabled === true;
    gateway.feishuWebhookPort = Number(gateway.feishuWebhookPort || Number(gateway.gatewayPort || 8790) + 1);
    gateway.feishuWebhookPath = gateway.feishuWebhookPath || adapterDefaultWebhookPath("feishu");
  }
}

export function configNameFor(gateway: GatewayDefinition): string {
  if (gateway.configName) return gateway.configName;
  const parts = String(gateway.id || "").split("__");
  return parts.length > 1 ? parts.slice(1).join("__") : gateway.id || "default";
}

export function sanitizeConfigName(value: unknown): string {
  return sharedSanitizeConfigName(value);
}

export function adapterConfigPathFor(gateway: GatewayDefinition): string {
  return `./data/route/${configNameFor(gateway)}/adapterConfig.json`;
}

export function routeDataDirFor(gateway: GatewayDefinition): string {
  return `./data/route`;
}

export function ensureRouteVariables(gateway: GatewayDefinition): Record<string, string> {
  if (!gateway.routeVariables || typeof gateway.routeVariables !== "object" || Array.isArray(gateway.routeVariables)) {
    gateway.routeVariables = {};
  }
  return gateway.routeVariables;
}

export function activeRoleKey(gateway: GatewayDefinition): string {
  return gateway.agentRoleId || "";
}

export function ensureActiveRoleRules(gateway: GatewayDefinition): NotificationRule[] {
  return notificationRulesForGateway(gateway);
}

export function saveActiveRoleRules(_gateway: GatewayDefinition): void {
  // Rules are shared per persona; no per-gateway cache needed
}

export function defaultHeartbeatSchedule(gateway: GatewayDefinition, name = "定时触发"): NotificationScheduleDefinition {
  return {
    id: `schedule-${Date.now().toString(36)}`,
    name,
    enabled: true,
    type: "interval",
    intervalSeconds: Number(gateway.heartbeatIntervalSeconds || 900)
  };
}

export function migrateLegacyHeartbeatSchedules(gateway: GatewayDefinition): void {
  automationRulesForGateway(gateway);
}

export function automationRulesForGateway(gateway: GatewayDefinition): PersonaAutomationRuleDefinition[] {
  const configured = normalizePersonaAutomationRules(gateway.automationRules);
  const migrated = configured.length > 0
    ? configured
    : personaAutomationRulesFromNotificationRules(
      gateway.notificationRules,
      Number(gateway.heartbeatIntervalSeconds || 900)
    );
  gateway.automationRules = ensureMessageAdapterAutomationRules(migrated, gatewayAdapterTypes(gateway), {
    includeRolePanel: Boolean(gateway.agentRoleId)
  });
  gateway.notificationRules = notificationRulesFromPersonaAutomations(gateway.automationRules)
    .map((rule, index) => normalizeRule(rule, index));
  return gateway.automationRules;
}

export function syncAutomationRuleProjection(gateway: GatewayDefinition): void {
  gateway.automationRules = normalizePersonaAutomationRules(gateway.automationRules);
  gateway.notificationRules = notificationRulesFromPersonaAutomations(gateway.automationRules)
    .map((rule, index) => normalizeRule(rule, index));
}

export function notificationRulesForGateway(gateway: GatewayDefinition): NotificationRule[] {
  automationRulesForGateway(gateway);
  return gateway.notificationRules ?? [];
}

export function defaultRolePanelRule(): NotificationRule {
  return defaultRolePanelNotificationRule();
}

export function isBuiltinRolePanelRule(rule: NotificationRule | null | undefined): boolean {
  return isBuiltinRolePanelNotificationRule(rule);
}

export function routeKindDefinitionsForGateway(_gateway?: GatewayDefinition) {
  return [
    {
      adapter: "napcat",
      title: "NapCat / OneBot",
      note: "QQ 实时消息；可先配置规则，再回到消息适配器启用入口。",
      groups: [
        { title: "群聊事件", routeKinds: ["direct_at", "direct_reply", "indirect_reply", "group_message"] },
        { title: "私聊事件", routeKinds: ["private"] }
      ]
    },
    {
      adapter: "heartbeat",
      title: "定时触发",
      note: "内部定时事件；勾选后仅在规则启用且入口产生 heartbeat 时投递。",
      groups: [{ title: "定时事件", routeKinds: ["heartbeat"] }]
    },
    {
      adapter: "rolePanel",
      title: "角色面板",
      note: "托盘打开的本地桌面入口；自由聊天使用角色面板消息，按钮动作使用手动触发。",
      groups: [
        { title: "聊天事件", routeKinds: ["role_panel_message"] },
        { title: "手动事件", routeKinds: ["manual_trigger"] }
      ]
    },
    {
      adapter: "remoteAgent",
      title: "远端 Agent",
      note: "远端 Agent 设备入口；本机人格可通过 Rabi API 把任务投递到远端设备。",
      groups: [{ title: "远端任务结果", routeKinds: ["manual_trigger"] }]
    },
    {
      adapter: "speech",
      title: "语音消息端",
      note: "本机语音转写入口；语音热投递或关键词模式仍由 Route 单独控制。",
      groups: [{ title: "语音转写", routeKinds: ["voice_transcript"] }]
    },
    {
      adapter: "fennenote",
      title: "FenneNote / 芬妮笔记",
      note: "FenneNote 转写回调入口；默认作为语音转写事件投递。",
      groups: [{ title: "语音转写", routeKinds: ["voice_transcript"] }]
    },
    {
      adapter: "xiaomiHome",
      title: "米家 / Xiaomi Home",
      note: "Home Assistant 中的米家状态与摄像头事件；由 Manager 集成投递到当前人格，不会启动 Gateway 常驻 adapter。",
      groups: [{ title: "米家设备事件", routeKinds: ["xiaomi_home_event"] }]
    },
    {
      adapter: "rabilink",
      title: "眼镜端（经 RabiLink）",
      note: "眼镜是消息来源；系统内置 RabiLink 负责转接，再由当前路由决定是否投递 Agent。",
      groups: [{ title: "眼镜文本事件", routeKinds: ["rabilink"] }]
    },
    {
      adapter: "wearable",
      title: "智能手表/手环",
      note: "结构化心率与睡眠先记录到角色健康时间线，只有规则命中时才投递 Agent。",
      groups: [{ title: "健康告警", routeKinds: ["wearable_health_alert"] }]
    },
    {
      adapter: "wecom",
      title: "企业微信 / WeCom",
      note: "企业微信群聊消息；变量尽量对齐 NapCat 群聊，并额外提供 wecomReqId / wecomChatId。",
      groups: [{ title: "企业微信群聊", routeKinds: ["wecom_message"] }]
    },
    {
      adapter: "weixin",
      title: "个人微信 / Weixin",
      note: "个人微信私聊消息；文本进入 Agent，回复只回到原会话。",
      groups: [{ title: "个人微信私聊", routeKinds: ["weixin_message"] }]
    },
    {
      adapter: "webhook",
      title: "通用 Webhook",
      note: "通用 HTTP 事件兜底入口；用于尚未命名的外部系统。",
      groups: [{ title: "通用外部事件", routeKinds: ["voice_transcript"] }]
    }
  ];
}

export function isGroupRouteKind(routeKind: string): boolean {
  return ["direct_at", "direct_reply", "indirect_reply", "group_message"].includes(routeKind);
}

export function ruleHasGroupRoute(rule: NotificationRule): boolean {
  return (Array.isArray(rule.routeKinds) ? rule.routeKinds : []).some(isGroupRouteKind);
}

export function routeKindSummary(rule: NotificationRule): string {
  const kinds = Array.isArray(rule.routeKinds) ? rule.routeKinds : [];
  return kinds.length ? kinds.map(kind => routeKindLabels[kind] || kind).join(" / ") : "未选择路由类型";
}

export function ruleTemplateSnippet(rule: NotificationRule): string {
  return normalizeTemplateText(rule.template || "").replace(/\s+/g, " ").trim().slice(0, 120) || "暂无模板正文";
}

export function explainAgentError(error: unknown): string {
  const text = String(error || "");
  if (!text) return "";
  if (text.includes("Codex app-server")) {
    return `Codex app-server 连接失败：${text}。请检查项目锁定的 @openai/codex runtime、工作目录与登录状态。`;
  }
  if (text.includes("thread not found")) {
    return "Codex 线程 ID 已失效。请在 RibiWebGUI 中重新绑定或让 manager 重新发现目标线程。";
  }
  if (text.includes("ASTRBOT_PASSWORD environment variable is not set")) {
    return "AstrBot 密码未配置。请在 AstrBot Agent 卡片里填写密码并保存，或设置 ASTRBOT_PASSWORD 环境变量。";
  }
  return text;
}

export function adapterConnectionReasons(gateway: GatewayDefinition, runtime: RuntimeStatus, adapterTypes: MessageAdapterType[]): string[] {
  const gatewayStatus = runtime.gatewayStatus || {};
  const adapterState = gatewayStatus.messageAdapter || {};
  const napcatState = gatewayStatus.napcat || {};
  const heartbeatState = gatewayStatus.heartbeat || {};
  const externalAdapterTypes = adapterTypes.filter(type => type !== "rolePanel");
  const externalAdaptersNeedRuntime = externalAdapterTypes.some(adapterNeedsGatewayRuntime);
  const expectedRuntimeAdapters: MessageAdapterType[] = isMessageInputsDisabled(gateway) ? ["disabled"] : externalAdapterTypes;
  const runtimeAdapterTypes = isMessageInputsDisabled(gateway)
    ? [adapterState.type || "disabled"]
    : Array.isArray(runtime.messageAdapters) && runtime.messageAdapters.length > 0
      ? runtime.messageAdapters
      : [runtime.messageAdapterType || adapterState.type || "napcat"];
  const externalRuntimeAdapterTypes = runtimeAdapterTypes.filter(type => type !== "rolePanel");
  const adapterPendingRestart = externalAdaptersNeedRuntime && expectedRuntimeAdapters.join(",") !== externalRuntimeAdapterTypes.join(",");
  const reasons: string[] = [];
  if (gateway.enabled === false || runtime.enabled === false) {
    return reasons;
  }
  if (isMessageInputsDisabled(gateway)) {
    return reasons;
  }
  if (!runtime.running && externalAdaptersNeedRuntime) {
    reasons.push(externalAdapterTypes.includes("napcat")
      ? "RabiRoute 监听进程未运行。请启动当前 Route 的 NapCat 监听。"
      : "RabiRoute 监听进程未运行。当前消息端需要本地监听服务；请启动当前路由。");
  }
  if (adapterPendingRestart) {
    reasons.push(`配置已变更但尚未重启：当前运行 ${runtimeAdapterTypes.map(adapterLabel).join(" + ")}，保存并重启后切换到 ${expectedRuntimeAdapters.map(adapterLabel).join(" + ")}。`);
  }
  if (externalAdapterTypes.includes("napcat")) {
    const wsUrl = `ws://127.0.0.1:${gateway.gatewayPort || runtime.gatewayPort || "-"}`;
    const httpUrl = gateway.napcatHttpUrl || runtime.napcatHttpUrl || "-";
    if (!napcatState.connected) {
      reasons.push(napcatState.lastDisconnectedAt
        ? `NapCat WebSocket 当前未连接；最后断开时间：${napcatState.lastDisconnectedAt}。请检查 NapCat WebSocket Client 是否启用并连接到 ${wsUrl}。`
        : `NapCat WebSocket 尚未连接。请在 NapCat OneBot 网络配置中启用 WebSocket Client，并连接到 ${wsUrl}。`);
    }
    if (napcatState.loginInfoError) {
      reasons.push(`NapCat HTTP 不可用或登录资料读取失败：${napcatState.loginInfoError}。当前 HTTP 地址：${httpUrl}。`);
    }
  }
  if (externalAdapterTypes.includes("heartbeat") && heartbeatState.enabled === false) reasons.push("定时触发消息端未启用。");
  return reasons;
}

export function adapterErrorsFor(type: MessageAdapterType, gateway: GatewayDefinition, runtime: RuntimeStatus): string[] {
  const gatewayStatus = runtime.gatewayStatus || {};
  const napcatState = gatewayStatus.napcat || {};
  const heartbeatState = gatewayStatus.heartbeat || {};
  const reasons: string[] = [];
  if (gateway.enabled === false || runtime.enabled === false || isMessageInputsDisabled(gateway)) {
    return [];
  }
  if (!runtime.running && adapterNeedsGatewayRuntime(type)) {
    reasons.push(type === "napcat"
      ? "RabiRoute 监听进程未运行。请启动当前 Route 的 NapCat 监听。"
      : "RabiRoute 监听进程未运行。当前消息端需要本地监听服务；请启动当前路由。");
    return reasons;
  }
  if (type === "napcat") {
    const wsUrl = `ws://127.0.0.1:${gateway.gatewayPort || runtime.gatewayPort || "-"}`;
    const httpUrl = gateway.napcatHttpUrl || runtime.napcatHttpUrl || "-";
    if (!napcatState.connected) {
      reasons.push(napcatState.lastDisconnectedAt
        ? `WebSocket 当前未连接；最后断开：${napcatState.lastDisconnectedAt}。请检查 NapCat WebSocket Client 是否连接到 ${wsUrl}。`
        : `WebSocket 尚未连接。请在 NapCat 网络配置中启用 WebSocket Client，连接到 ${wsUrl}。`);
    }
    if (napcatState.loginInfoError) {
      reasons.push(`HTTP 不可用或登录资料读取失败：${napcatState.loginInfoError}。地址：${httpUrl}`);
    }
  }
  if (type === "heartbeat" && heartbeatState.enabled === false) {
    reasons.push("定时触发消息端未启用。");
  }
  return reasons;
}

export function agentConnectionReasons(gateway: GatewayDefinition, runtime: RuntimeStatus): string[] {
  const adapters = Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : [];
  const states = runtime.agentStates ?? {};
  const reasons: string[] = [];
  if (gateway.enabled === false || runtime.enabled === false) return reasons;
  if (!adapters.length) {
    return ["尚未配置 Agent 处理端；请选择 Codex、Copilot CLI、AstrBot 或 Marvis。"];
  }
  for (const adapter of adapters) {
    const state = states[adapter] ?? {};
    if (!state.monitorThreadId) {
      if (state.message) {
        reasons.push(String(state.message));
      } else if (adapter === "marvis") {
        reasons.push("Marvis 当前是人工接力适配，不能验证会话绑定。");
      } else if (adapter === "astrbot") {
        reasons.push(gateway.astrbotSessionId
          ? "AstrBot 已选择 ChatUI 会话，但尚未完成真实投递验证。"
          : "AstrBot 未选择 ChatUI 会话，无法通过 /api/chat/send 投递。");
      } else if (adapter === "copilotCli") {
        reasons.push("Copilot CLI 尚未成功投递到目标 session；请完成同一会话连续两次注入烟测后再视为可用。");
      } else if (adapter === "codex") {
        reasons.push(`尚未绑定 Codex Desktop 任务。请先打开 Desktop，并确认任务“${gateway.codexThreadName || gateway.name || gateway.id}”属于当前工作目录。`);
      }
    }
    if (state.lastNotificationError) reasons.push(explainAgentError(state.lastNotificationError));
  }
  return [...new Set(reasons)];
}

export function createDefaultGateway(next: number): GatewayDefinition {
  const configName = `config-${next}`;
  return {
    id: configName,
    configName,
    name: `路由配置 ${next}`,
    enabled: true,
    messageAdapterType: "napcat",
    messageAdapters: ["napcat"],
    messageAdapterPolicies: {
      napcat: {
        inputEnabled: true,
        outputEnabled: true,
        supportedOutputs: ["text", "image", "voice", "file"],
        messageGrouping: {
          settleSeconds: 6,
          incompleteSettleSeconds: 12,
          maxWaitSeconds: 20
        }
      }
    },
    gatewayPort: 8789 + next,
    napcatHttpUrl: "http://127.0.0.1:3000",
    heartbeatIntervalSeconds: 900,
    heartbeatMessage: defaultHeartbeatMessage(),
    heartbeatSkipWhenAgentBusy: false,
    routeVariables: {},
    agentModel: "",
    codexThreadName: `路由配置 ${next}`,
    copilotThreadName: `路由配置 ${next}`,
    codexCwd: "",
    codexMemoryConsolidationAgentEnabled: false,
    codexMemoryConsolidationAgentModel: "gpt-5.6-terra",
    agentRoleId: "",
    agentRoleFile: "persona.md",
    agentAdapters: ["codex"],
    primaryAgentAdapter: "codex",
    messageProcessingAgents: {
      codex: {
        enabled: false,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    },
    notificationRules: []
  };
}

export function isQuickSetupNeeded(gateways: GatewayDefinition[]): boolean {
  if (gateways.length === 0) return true;
  return gateways.some((gateway) => {
    const adapters = gatewayAdapterTypes(gateway);
    const agentAdapters = Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : [];
    const missingCopilotBinding = agentAdapters.includes("copilotCli")
      && (!gateway.copilotThreadName || !gateway.copilotCwd);
    const missingMessageConfig = adapters.includes("napcat") && (!gateway.gatewayPort || !gateway.napcatHttpUrl);
    return agentAdapters.length === 0 || missingCopilotBinding || missingMessageConfig;
  });
}
