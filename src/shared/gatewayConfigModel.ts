import { normalizeAgentCompletionDeliveries, type AgentCompletionDeliveryRule } from "./agentHookAutomation.js";
export { normalizeAgentCompletionDeliveries, type AgentCompletionDeliveryRule } from "./agentHookAutomation.js";
import {
  resolveRouteIdentity,
  sanitizeRoleId
} from "./routeIdentity.js";

export {
  routeRuntimeId,
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "./routeIdentity.js";

import {
  createBuiltinRolePanelRule,
  ensureBuiltinPersonaRules,
  isBuiltinRolePanelRule as sharedIsBuiltinRolePanelRule
} from "./personaRulePolicy.js";
import { isCodexTaskId } from "./codexTaskId.js";
import { sameCodexWorkspaceSyntax } from "./codexWorkspaceIdentity.js";
import {
  normalizeCodexPlanAssistantModel,
  normalizeCodexPlanAssistantSessions,
  planAssistantSessionAgentAdapter,
  type CodexPlanAssistantSession
} from "./codexPlanAssistantSessions.js";
import { normalizeCodexMemoryConsolidationAgentModel } from "./codexMemoryConsolidationAgent.js";
import { applySpeechRouteVariableDefaults } from "./speechControlContract.js";
import {
  agentAdapterSupportsManagedTaskFeature,
  agentAdapterTypes,
  type AgentAdapterType
} from "./agentAdapterCapabilities.js";
import {
  normalizeLanguageStyleBinding,
  type LanguageStyleBinding
} from "./languageStyle.js";
import {
  isMessageEndpointType,
  selectGatewayMessageAdapterTypes,
  type GatewayMessageAdapterType,
  type LegacyMessageAdapterType,
  type MessageEndpointType
} from "./messageEndpointTypes.js";

export type { CodexPlanAssistantSession } from "./codexPlanAssistantSessions.js";
export {
  agentAdapterCapabilities,
  agentAdapterSupportsManagedTaskFeature,
  agentAdapterTypes,
  type AgentAdapterCapabilities,
  type AgentAdapterType,
  type ManagedTaskAgentFeature
} from "./agentAdapterCapabilities.js";

export {
  builtinRolePanelRouteKind,
  builtinRolePanelRuleId,
  builtinRolePanelRuleName,
  canonicalizeBuiltinRolePanelRule,
  createBuiltinRolePanelRule,
  ensureBuiltinPersonaRules,
  isBuiltinRolePanelRule,
  rolePanelPersonaRulePolicy,
  type BuiltinPersonaRulePolicy
} from "./personaRulePolicy.js";

export {
  GATEWAY_MESSAGE_ADAPTER_TYPES,
  MESSAGE_ENDPOINT_TYPES,
  isGatewayMessageAdapterType,
  isMessageEndpointType,
  selectGatewayMessageAdapterTypes,
  type GatewayMessageAdapterType,
  type LegacyMessageAdapterType,
  type MessageEndpointType
} from "./messageEndpointTypes.js";

/** @deprecated Use MessageEndpointType; `disabled` is accepted only for legacy configuration reads. */
export type MessageAdapterType = LegacyMessageAdapterType;
export type OutputAdapterType = "qq" | "agent" | "file" | "console" | "tts" | "webhook" | "fennenote" | "wecom" | "weixin" | "feishu" | "none";
export type PipelineOutputAdapterInput = OutputAdapterType | "codex";
export type PromptOutputMode = "qq_text" | "voice_short" | "markdown" | "json" | "plain_text";
export type MessagePayloadKind = "text" | "image" | "voice" | "file";
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type SpeechPushMode = "hot" | "keyword";
export type CodexHookSettings = {
  sessionContextEnabled: boolean;
  reasoningContextEnabled: boolean;
  planTaskCompletionEnabled: boolean;
  agentCommunicationEnforcementEnabled: boolean;
  onlyPrimaryPersonaCanSendMessages?: boolean;
  completionDeliveries?: AgentCompletionDeliveryRule[];
};
export const DEFAULT_CODEX_HOOK_SETTINGS: CodexHookSettings = {
  sessionContextEnabled: true,
  reasoningContextEnabled: true,
  planTaskCompletionEnabled: true,
  agentCommunicationEnforcementEnabled: true,
  onlyPrimaryPersonaCanSendMessages: false
};
export type RecentMessageEndpoint = MessageEndpointType;
export type RecentMessageLimits = Partial<Record<RecentMessageEndpoint, number>>;
export const RECENT_MESSAGE_ENDPOINTS: readonly RecentMessageEndpoint[] = [
  "napcat",
  "remoteAgent",
  "heartbeat",
  "rolePanel",
  "speech",
  "fennenote",
  "xiaoai",
  "rabilink",
  "wearable",
  "webhook",
  "wecom",
  "weixin",
  "feishu",
  "xiaomiHome"
];
export const DEFAULT_RECENT_MESSAGE_LIMIT = 12;
export const MAX_RECENT_MESSAGE_LIMIT = 200;

export const DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL = "gpt-5.6-luna";
export const DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT: CodexReasoningEffort = "medium";
export const DEFAULT_MESSAGE_PROCESSING_AGENT_MAX_AGENTS = 1;
export const MAX_MESSAGE_PROCESSING_AGENTS = 32;

export type MessageGroupingPolicy = {
  enabled?: boolean;
  settleSeconds?: number;
  incompleteSettleSeconds?: number;
  maxWaitSeconds?: number;
};

export type MessageAdapterPolicy = {
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  supportedOutputs?: MessagePayloadKind[];
  allowedFileRoots?: string[];
  messageGrouping?: MessageGroupingPolicy;
};

export type MessageAdapterPolicies = Partial<Record<MessageEndpointType, MessageAdapterPolicy>>;

export type MessageProcessingAgentPolicy = {
  enabled?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  maxAgents?: number;
};

export type MessageProcessingAgentPolicies = Partial<Record<AgentAdapterType, MessageProcessingAgentPolicy>>;

export function normalizeCodexHookSettings(value: unknown): CodexHookSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<CodexHookSettings>
    : {};
  return {
    sessionContextEnabled: raw.sessionContextEnabled !== false,
    reasoningContextEnabled: raw.reasoningContextEnabled !== false,
    planTaskCompletionEnabled: raw.planTaskCompletionEnabled !== false,
    agentCommunicationEnforcementEnabled: raw.agentCommunicationEnforcementEnabled !== false,
    onlyPrimaryPersonaCanSendMessages: raw.onlyPrimaryPersonaCanSendMessages === true,
    completionDeliveries: normalizeAgentCompletionDeliveries(raw.completionDeliveries)
  };
}

export type PipelineDefinition = {
  id?: string;
  name?: string;
  inputAdapter?: MessageEndpointType;
  /** `codex` is accepted only as a legacy input and normalizes to `agent`. */
  outputAdapter?: PipelineOutputAdapterInput;
  outputPipeline?: string;
  promptOutputMode?: PromptOutputMode;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsWorkerUrl?: string;
  ttsPlay?: boolean;
  preventFeedbackLoop?: boolean;
  replyToSource?: boolean;
};

export type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  allowedSpeakerNames?: string[];
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

export type NotificationScheduleType = "interval" | "daily_time" | "once_at";

export type NotificationScheduleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  type: NotificationScheduleType;
  intervalSeconds?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  timeOfDay?: string;
  onceAt?: string;
};

export type PersonaAutomationTriggerDefinition =
  | {
    type: "message";
    routeKinds?: string[];
    targetGroupId?: string;
    allowedSpeakerNames?: string[];
    regex?: string;
  }
  | {
    type: "schedule";
    schedule: NotificationScheduleDefinition;
  };

export type PersonaAutomationActionDefinition =
  | {
    type: "deliver_agent";
    message?: string;
    template?: string;
  }
  | {
    type: "run_script";
    scriptPath?: string;
    arguments?: string[];
    timeoutSeconds?: number;
  };

export type PersonaAutomationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  trigger: PersonaAutomationTriggerDefinition;
  action: PersonaAutomationActionDefinition;
};

export type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: LanguageStyleBinding;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  automationRules?: PersonaAutomationRuleDefinition[];
  personaAutomationScriptsEnabled?: boolean;
  notificationRules?: NotificationRuleDefinition[];
};

export type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  autoLoginOnRabiStart?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
  botNickname?: string;
  connected?: boolean;
  remoteAddress?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  loginInfoError?: string;
};

export type ResolvedNapCatInstances = {
  instances: NapCatInstanceDefinition[];
  primary?: NapCatInstanceDefinition;
  primaryIndex: number;
};

export type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: MessageAdapterPolicies;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  rabiLinkWebhookPort?: number;
  rabiLinkWebhookPath?: string;
  rabiLinkWebhookHost?: string;
  rabiLinkRelayEnabled?: boolean;
  rabiLinkRelayUrl?: string;
  rabiLinkRelayToken?: string;
  rabiLinkRelayDeviceId?: string;
  rabiLinkRelayClaimWaitMs?: number;
  rabiLinkRelayReplyIdleTimeoutMs?: number;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  weixinBaseUrl?: string;
  weixinBotType?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuEncryptKey?: string;
  feishuEventSubscriptionEnabled?: boolean;
  feishuWebhookPort?: number;
  feishuWebhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  heartbeatSkipWhenAgentBusy?: boolean;
  personaAutomationScriptsEnabled?: boolean;
  remoteAgentDefaultDeviceId?: string;
  remoteAgentDefaultCwd?: string;
  remoteAgentDefaultThreadName?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
  ignoredNapcatInstanceIds?: string[];
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  agentModel?: string;
  agentReasoningEffort?: CodexReasoningEffort;
  codexThreadId?: string;
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
  dshModelProvider?: string;
  dshModel?: string;
  dshReasoningEffort?: string;
  codexPlanAssistantEnabled?: boolean;
  codexPlanAssistantModel?: string;
  codexPlanAssistantSessions?: CodexPlanAssistantSession[];
  codexMemoryConsolidationAgentEnabled?: boolean;
  codexMemoryConsolidationAgentModel?: string;
  codexHooks?: CodexHookSettings;
  copilotThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  primaryAgentAdapter?: AgentAdapterType;
  messageProcessingAgents?: MessageProcessingAgentPolicies;
  routeProfiles?: RouteProfileDefinition[];
  dataDir?: string;
  groupNotificationTemplate?: string;
  groupAtNotificationTemplate?: string;
  groupDirectReplyNotificationTemplate?: string;
  groupIndirectReplyNotificationTemplate?: string;
  groupReplyNotificationTemplate?: string;
  groupNicknameNotificationTemplate?: string;
  privateNotificationTemplate?: string;
  heartbeatNotificationTemplate?: string;
  voiceTranscriptNotificationTemplate?: string;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: LanguageStyleBinding;
  automationRules?: PersonaAutomationRuleDefinition[];
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

export type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

export type GatewayPortClaimKind =
  | "manager"
  | "gateway-ws"
  | "napcat-ws"
  | "napcat-http"
  | "webhook"
  | "fennenote-webhook"
  | "xiaoai-webhook"
  | "rabilink-webhook"
  | "feishu-webhook";

export type GatewayPortClaim = {
  port: number;
  label: string;
  kind: GatewayPortClaimKind;
  gatewayId?: string;
  instanceId?: string;
};

export type GatewayConfigModelOptions = {
  managerPort?: number;
  routeDataDir?: (configName: string) => string;
  rolesDir?: string;
  normalizePipeline?: (pipeline: PipelineDefinition | undefined) => PipelineDefinition | undefined;
  normalizeAgentAdapters?: (adapters: AgentAdapterType[] | undefined) => AgentAdapterType[];
};

export const agentAdapterValues: ReadonlySet<AgentAdapterType> = new Set(agentAdapterTypes);
const messagePayloadKindValues = new Set<MessagePayloadKind>(["text", "image", "voice", "file"]);
const defaultSupportedOutputs: MessagePayloadKind[] = ["text", "image", "voice", "file"];
const codexReasoningEffortValues = new Set<CodexReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const dshSessionIdPattern = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeDshSessionId(value: unknown): string | undefined {
  const raw = String(value || "").trim();
  return raw && dshSessionIdPattern.test(raw) ? raw : undefined;
}

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return codexReasoningEffortValues.has(value as CodexReasoningEffort)
    ? value as CodexReasoningEffort
    : undefined;
}

export function messageAdapterUsesAutomaticGrouping(adapterType: MessageEndpointType): boolean {
  return adapterType === "napcat"
    || adapterType === "rolePanel"
    || adapterType === "rabilink"
    || adapterType === "wecom"
    || adapterType === "weixin"
    || adapterType === "feishu";
}

function defaultMessageGroupingPolicy(adapterType: MessageEndpointType): Required<MessageGroupingPolicy> {
  const speechLike = adapterType === "speech"
    || adapterType === "fennenote"
    || adapterType === "xiaoai";
  const conversational = messageAdapterUsesAutomaticGrouping(adapterType);
  return speechLike
    ? { enabled: conversational, settleSeconds: 3, incompleteSettleSeconds: 8, maxWaitSeconds: 15 }
    : { enabled: conversational, settleSeconds: 6, incompleteSettleSeconds: 12, maxWaitSeconds: 20 };
}

export function normalizeMessageGroupingPolicy(
  value: unknown,
  adapterType: MessageEndpointType
): Required<MessageGroupingPolicy> {
  const defaults = defaultMessageGroupingPolicy(adapterType);
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as MessageGroupingPolicy
    : {};
  const positive = (candidate: unknown, fallback: number): number => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0 ? Math.min(300, Math.max(1, number)) : fallback;
  };
  const settleSeconds = positive(raw.settleSeconds, defaults.settleSeconds);
  const incompleteSettleSeconds = Math.max(
    settleSeconds,
    positive(raw.incompleteSettleSeconds, defaults.incompleteSettleSeconds)
  );
  const maxWaitSeconds = Math.max(
    incompleteSettleSeconds,
    positive(raw.maxWaitSeconds, defaults.maxWaitSeconds)
  );
  return {
    // Kept in the normalized shape for compatibility with existing config files.
    // Endpoint classification owns this value; an old per-endpoint switch cannot
    // disable grouping for chat or enable extra settling for ASR/system events.
    enabled: defaults.enabled,
    settleSeconds,
    incompleteSettleSeconds,
    maxWaitSeconds
  };
}

export function normalizeMessageProcessingAgentPolicies(
  value: unknown,
  adapters: readonly AgentAdapterType[]
): MessageProcessingAgentPolicies {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as MessageProcessingAgentPolicies
    : {};
  const result: MessageProcessingAgentPolicies = {};
  for (const adapter of adapters) {
    if (!agentAdapterSupportsManagedTaskFeature(adapter, "messageProcessingAgent")) continue;
    const policy = raw[adapter];
    const model = typeof policy?.model === "string" && policy.model.trim()
      ? policy.model.trim()
      : DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL;
    const reasoningEffort = normalizeCodexReasoningEffort(policy?.reasoningEffort)
      ?? DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT;
    const parsedMaxAgents = Math.floor(Number(policy?.maxAgents));
    const maxAgents = Number.isFinite(parsedMaxAgents) && parsedMaxAgents > 0
      ? Math.min(MAX_MESSAGE_PROCESSING_AGENTS, parsedMaxAgents)
      : DEFAULT_MESSAGE_PROCESSING_AGENT_MAX_AGENTS;
    result[adapter] = {
      enabled: policy?.enabled === true,
      model,
      reasoningEffort,
      maxAgents
    };
  }
  return result;
}

export function normalizeTemplateText(value: unknown): string {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

export function normalizeOptionalTemplate(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeTemplateText(value) : undefined;
}

export function normalizeRuleDefinitions(rules: unknown): NotificationRuleDefinition[] | undefined {
  if (!Array.isArray(rules)) {
    return undefined;
  }

  return rules.map((rule, index) => {
    const raw = rule && typeof rule === "object" ? rule as Partial<NotificationRuleDefinition> : {};
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `rule-${index + 1}`,
      name: raw.name,
      enabled: raw.enabled !== false,
      routeKinds: Array.isArray(raw.routeKinds) ? raw.routeKinds.map(String) : [],
      targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId : "",
      allowedSpeakerNames: Array.isArray(raw.allowedSpeakerNames)
        ? raw.allowedSpeakerNames.map((item) => String(item).trim()).filter(Boolean)
        : [],
      regex: typeof raw.regex === "string" ? raw.regex : "",
      schedules: normalizeScheduleDefinitions(raw.schedules),
      template: normalizeTemplateText(typeof raw.template === "string" && raw.template.trim() ? raw.template : "")
    };
  });
}

export function defaultRolePanelNotificationRule(): NotificationRuleDefinition {
  return createBuiltinRolePanelRule();
}

function defaultRouteKindsForMessageAdapter(adapter: MessageEndpointType): string[] {
  if (adapter === "napcat") return ["private", "direct_at", "direct_reply", "indirect_reply"];
  if (adapter === "remoteAgent") return ["manual_trigger"];
  if (adapter === "heartbeat") return ["heartbeat"];
  if (adapter === "rolePanel") return ["role_panel_message", "manual_trigger"];
  if (adapter === "speech") return ["voice_transcript"];
  if (adapter === "fennenote" || adapter === "xiaoai" || adapter === "webhook") return ["voice_transcript"];
  if (adapter === "rabilink") return ["rabilink"];
  if (adapter === "wearable") return ["wearable_health_alert"];
  if (adapter === "wecom") return ["wecom_message"];
  if (adapter === "weixin") return ["weixin_message"];
  if (adapter === "feishu") return ["feishu_message"];
  if (adapter === "xiaomiHome") return ["xiaomi_home_event"];
  return [];
}

function defaultRuleNameForMessageAdapter(adapter: MessageEndpointType): string {
  if (adapter === "napcat") return "QQ 默认消息";
  if (adapter === "heartbeat") return "定时默认消息";
  if (adapter === "rolePanel") return "面板默认消息";
  if (adapter === "speech") return "语音消息端默认消息";
  if (adapter === "fennenote") return "FenneNote 默认语音";
  if (adapter === "xiaoai") return "小爱默认语音";
  if (adapter === "rabilink") return "RabiLink 默认消息";
  if (adapter === "wearable") return "智能手表/手环健康告警";
  if (adapter === "wecom") return "企业微信默认消息";
  if (adapter === "weixin") return "个人微信默认消息";
  if (adapter === "feishu") return "飞书默认消息";
  if (adapter === "xiaomiHome") return "米家设备事件";
  if (adapter === "webhook") return "Webhook 默认消息";
  return "默认消息";
}

export function defaultMessageAdapterNotificationRules(adapters: MessageEndpointType[]): NotificationRuleDefinition[] {
  return adapters.flatMap((adapter) => {
    const routeKinds = defaultRouteKindsForMessageAdapter(adapter);
    if (routeKinds.length === 0) return [];
    return [{
      id: `default-${adapter}`,
      name: defaultRuleNameForMessageAdapter(adapter),
      enabled: true,
      routeKinds,
      targetGroupId: "",
      allowedSpeakerNames: [],
      regex: "",
      template: ""
    }];
  });
}

export function ensureMessageAdapterNotificationRules(
  rules: NotificationRuleDefinition[] | undefined,
  adapters: MessageEndpointType[]
): NotificationRuleDefinition[] {
  const next = normalizeRuleDefinitions(rules) ?? [];
  const coveredRouteKinds = new Set(next.flatMap((rule) => rule.routeKinds ?? []));
  const existingRuleIds = new Set(next.map((rule) => rule.id));

  for (const fallback of defaultMessageAdapterNotificationRules(adapters)) {
    if (existingRuleIds.has(fallback.id)) continue;
    const missingRouteKinds = (fallback.routeKinds ?? []).filter((routeKind) => !coveredRouteKinds.has(routeKind));
    if (missingRouteKinds.length === 0) continue;
    next.push({ ...fallback, routeKinds: missingRouteKinds });
    existingRuleIds.add(fallback.id);
    for (const routeKind of missingRouteKinds) coveredRouteKinds.add(routeKind);
  }
  return next;
}

export function ensureSpeechRouteNotificationRule(rules: NotificationRuleDefinition[]): NotificationRuleDefinition[] {
  if (rules.some((rule) => rule.enabled !== false && (rule.routeKinds ?? []).includes("voice_transcript"))) {
    return rules;
  }
  const [speechRule] = defaultMessageAdapterNotificationRules(["speech"]);
  return speechRule ? [...rules, speechRule] : rules;
}

export function ensureDefaultPersonaRules(rules: NotificationRuleDefinition[] | undefined): NotificationRuleDefinition[] {
  const normalized = normalizeRuleDefinitions(rules) ?? [];
  return ensureBuiltinPersonaRules(normalized);
}

export function isBuiltinRolePanelNotificationRule(rule: NotificationRuleDefinition | null | undefined): boolean {
  return sharedIsBuiltinRolePanelRule(rule);
}

function normalizeScheduleType(value: unknown): NotificationScheduleType {
  return value === "daily_time" || value === "once_at" || value === "interval" ? value : "interval";
}

function normalizeOptionalTimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeScheduleDefinitions(schedules: unknown): NotificationScheduleDefinition[] | undefined {
  if (!Array.isArray(schedules)) {
    return undefined;
  }

  return schedules.map((schedule, index) => {
    const raw = schedule && typeof schedule === "object" ? schedule as Partial<NotificationScheduleDefinition> : {};
    const type = normalizeScheduleType(raw.type);
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `schedule-${index + 1}`,
      name: typeof raw.name === "string" ? raw.name : undefined,
      enabled: raw.enabled !== false,
      type,
      intervalSeconds: type === "interval" ? normalizePositiveNumber(raw.intervalSeconds, 900) : undefined,
      windowStartTime: type === "interval" ? normalizeOptionalTimeString(raw.windowStartTime) : undefined,
      windowEndTime: type === "interval" ? normalizeOptionalTimeString(raw.windowEndTime) : undefined,
      timeOfDay: type === "daily_time" ? normalizeOptionalTimeString(raw.timeOfDay) : undefined,
      onceAt: type === "once_at" ? normalizeOptionalTimeString(raw.onceAt) : undefined
    };
  });
}

function normalizeAutomationAction(value: unknown): PersonaAutomationActionDefinition {
  const raw = value && typeof value === "object"
    ? value as Partial<PersonaAutomationActionDefinition> & Record<string, unknown>
    : {};
  if (raw.type === "run_script") {
    return {
      type: "run_script",
      scriptPath: typeof raw.scriptPath === "string" ? raw.scriptPath.trim() : "",
      arguments: Array.isArray(raw.arguments) ? raw.arguments.map(String) : [],
      timeoutSeconds: Math.min(3600, Math.max(5, normalizePositiveNumber(raw.timeoutSeconds, 300)))
    };
  }
  return {
    type: "deliver_agent",
    message: typeof raw.message === "string" ? normalizeTemplateText(raw.message) : "",
    template: typeof raw.template === "string" ? normalizeTemplateText(raw.template) : ""
  };
}

function normalizeAutomationTrigger(value: unknown, index: number): PersonaAutomationTriggerDefinition {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (raw.type === "schedule") {
    const schedule = normalizeScheduleDefinitions([raw.schedule])?.[0];
    return {
      type: "schedule",
      schedule: schedule ?? {
        id: `schedule-${index + 1}`,
        enabled: true,
        type: "interval",
        intervalSeconds: 900
      }
    };
  }
  return {
    type: "message",
    routeKinds: Array.isArray(raw.routeKinds) ? raw.routeKinds.map(String) : [],
    targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId : "",
    allowedSpeakerNames: Array.isArray(raw.allowedSpeakerNames)
      ? raw.allowedSpeakerNames.map((item) => String(item).trim()).filter(Boolean)
      : [],
    regex: typeof raw.regex === "string" ? raw.regex : ""
  };
}

export function normalizePersonaAutomationRules(value: unknown): PersonaAutomationRuleDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const raw = item && typeof item === "object"
      ? item as Partial<PersonaAutomationRuleDefinition>
      : {};
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `automation-${index + 1}`,
      name: typeof raw.name === "string" ? raw.name : undefined,
      enabled: raw.enabled !== false,
      trigger: normalizeAutomationTrigger(raw.trigger, index),
      action: normalizeAutomationAction(raw.action)
    };
  });
}

export function mergePersonaAutomationRules(
  ...ruleSets: Array<PersonaAutomationRuleDefinition[] | undefined>
): PersonaAutomationRuleDefinition[] {
  const merged: PersonaAutomationRuleDefinition[] = [];
  const seen = new Set<string>();
  for (const rules of ruleSets) {
    for (const rule of rules ?? []) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      merged.push(rule);
    }
  }
  return merged;
}

function notificationRuleAutomation(rule: NotificationRuleDefinition): PersonaAutomationRuleDefinition {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled !== false,
    trigger: {
      type: "message",
      routeKinds: rule.routeKinds ?? [],
      targetGroupId: rule.targetGroupId ?? "",
      allowedSpeakerNames: rule.allowedSpeakerNames ?? [],
      regex: rule.regex ?? ""
    },
    action: {
      type: "deliver_agent",
      template: rule.template ?? ""
    }
  };
}

export function personaAutomationRulesFromNotificationRules(
  rules: NotificationRuleDefinition[] | undefined,
  legacyIntervalSeconds = 900,
  options: { includeSchedules?: boolean } = {}
): PersonaAutomationRuleDefinition[] {
  const normalizedRules = normalizeRuleDefinitions(rules) ?? [];
  const automations = normalizedRules.map(notificationRuleAutomation);
  if (options.includeSchedules === false) return automations;

  for (const rule of normalizedRules) {
    if (rule.enabled === false || !(rule.routeKinds ?? []).includes("heartbeat")) continue;
    const schedules = rule.schedules?.length
      ? rule.schedules
      : [{
        id: "legacy-interval",
        name: rule.name || rule.id,
        enabled: true,
        type: "interval" as const,
        intervalSeconds: normalizePositiveNumber(legacyIntervalSeconds, 900)
      }];
    for (const schedule of schedules) {
      automations.push({
        id: `scheduled-${rule.id}-${schedule.id}`,
        name: schedule.name || rule.name || rule.id,
        enabled: schedule.enabled !== false,
        trigger: { type: "schedule", schedule },
        action: {
          type: "deliver_agent",
          message: `定时计划触发：${rule.name || rule.id} / ${schedule.name || schedule.id}`,
          template: rule.template ?? ""
        }
      });
    }
  }
  return automations;
}

export function notificationRulesFromPersonaAutomations(
  automations: PersonaAutomationRuleDefinition[] | undefined
): NotificationRuleDefinition[] {
  const rules: NotificationRuleDefinition[] = [];
  for (const automation of normalizePersonaAutomationRules(automations)) {
    if (automation.trigger.type !== "message" || automation.action.type !== "deliver_agent") continue;
    rules.push({
      id: automation.id,
      name: automation.name,
      enabled: automation.enabled !== false,
      routeKinds: automation.trigger.routeKinds ?? [],
      targetGroupId: automation.trigger.targetGroupId ?? "",
      allowedSpeakerNames: automation.trigger.allowedSpeakerNames ?? [],
      regex: automation.trigger.regex ?? "",
      template: automation.action.template ?? ""
    });
  }
  return rules;
}

export function ensureDefaultPersonaAutomations(
  automations: PersonaAutomationRuleDefinition[] | undefined
): PersonaAutomationRuleDefinition[] {
  const normalized = normalizePersonaAutomationRules(automations);
  if (!normalized.some((rule) => rule.id === "role-panel-message")) {
    normalized.push(notificationRuleAutomation(defaultRolePanelNotificationRule()));
  }
  const rolePanelIndex = normalized.findIndex((rule) => rule.id === "role-panel-message");
  if (rolePanelIndex >= 0 && rolePanelIndex < normalized.length - 1) {
    const [rolePanelRule] = normalized.splice(rolePanelIndex, 1);
    normalized.push(rolePanelRule);
  }
  return normalized;
}

export function ensureMessageAdapterAutomationRules(
  automations: PersonaAutomationRuleDefinition[] | undefined,
  adapters: MessageEndpointType[],
  options: { includeRolePanel?: boolean } = {}
): PersonaAutomationRuleDefinition[] {
  const normalized = options.includeRolePanel === false
    ? normalizePersonaAutomationRules(automations)
    : ensureDefaultPersonaAutomations(automations);
  const currentMessageRules = notificationRulesFromPersonaAutomations(normalized);
  const ensuredMessageRules = ensureMessageAdapterNotificationRules(currentMessageRules, adapters);
  const missing = ensuredMessageRules.filter((rule) => !currentMessageRules.some((current) => current.id === rule.id));
  return mergePersonaAutomationRules(
    normalized,
    personaAutomationRulesFromNotificationRules(missing, 900, { includeSchedules: false })
  );
}

export function normalizeMessageAdapters(items: unknown[]): MessageEndpointType[] {
  return [...new Set(items
    .map((item) => item == null ? "" : String(item))
    .filter(isMessageEndpointType))];
}

function normalizeOptionalMessageAdapters(items: unknown): MessageEndpointType[] {
  if (!Array.isArray(items)) return [];
  return [...new Set(items
    .map((item) => item == null ? "" : String(item))
    .filter(isMessageEndpointType))];
}

function normalizePayloadKinds(value: unknown, adapterType: MessageEndpointType): MessagePayloadKind[] {
  const defaults = adapterType === "feishu" ? ["text"] as MessagePayloadKind[] : defaultSupportedOutputs;
  if (!Array.isArray(value)) return defaults;
  const kinds = [...new Set(value
    .map(item => String(item || "").trim())
    .filter((item): item is MessagePayloadKind => messagePayloadKindValues.has(item as MessagePayloadKind)))];
  return kinds.length > 0 ? kinds : defaults;
}

function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

export function normalizeMessageAdapterPolicy(
  value: unknown,
  adapterType: MessageEndpointType,
  options: { legacyInputDisabled?: boolean } = {}
): Required<MessageAdapterPolicy> {
  const raw = value && typeof value === "object" ? value as MessageAdapterPolicy : {};
  return {
    inputEnabled: raw.inputEnabled ?? !options.legacyInputDisabled,
    outputEnabled: raw.outputEnabled ?? true,
    supportedOutputs: normalizePayloadKinds(raw.supportedOutputs, adapterType),
    allowedFileRoots: normalizePathList(raw.allowedFileRoots),
    messageGrouping: normalizeMessageGroupingPolicy(raw.messageGrouping, adapterType)
  };
}

export function normalizeMessageAdapterPolicies(
  value: unknown,
  adapters: MessageEndpointType[],
  disabledAdapters: MessageEndpointType[] = []
): MessageAdapterPolicies {
  const raw = value && typeof value === "object" ? value as MessageAdapterPolicies : {};
  const disabled = new Set(disabledAdapters);
  const result: MessageAdapterPolicies = {};
  for (const adapter of adapters) {
    result[adapter] = normalizeMessageAdapterPolicy(raw[adapter], adapter, { legacyInputDisabled: disabled.has(adapter) });
  }
  return result;
}

export function messageAdapterPolicyFor(gateway: GatewayDefinition, type: MessageAdapterType): Required<MessageAdapterPolicy> {
  if (type === "disabled") {
    return normalizeMessageAdapterPolicy(undefined, "napcat", { legacyInputDisabled: true });
  }
  return normalizeMessageAdapterPolicy(gateway.messageAdapterPolicies?.[type], type, {
    legacyInputDisabled: gateway.messageAdaptersDisabled?.includes(type) === true
  });
}

export function messageAdapterInputEnabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  return !gateway.messageInputsDisabled && type !== "disabled" && messageAdapterPolicyFor(gateway, type).inputEnabled;
}

export function messageAdapterOutputEnabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  return type !== "disabled" && messageAdapterPolicyFor(gateway, type).outputEnabled;
}

export function gatewayAdapterTypes(gateway: GatewayDefinition): MessageEndpointType[] {
  if (gateway.messageInputsDisabled) return [];
  const configured = Array.isArray(gateway.messageAdapters) && gateway.messageAdapters.length > 0
    ? gateway.messageAdapters
    : [gateway.messageAdapterType || "napcat"];
  const adapters = configured.filter(isMessageEndpointType);
  const disabled = new Set((gateway.messageAdaptersDisabled ?? []).filter(isMessageEndpointType));
  return [...new Set(adapters)]
    .filter((type) => !disabled.has(type) && messageAdapterPolicyFor(gateway, type).inputEnabled);
}

export function gatewayMessageAdapterTypes(gateway: GatewayDefinition): GatewayMessageAdapterType[] {
  return selectGatewayMessageAdapterTypes(gatewayAdapterTypes(gateway));
}

export function setGatewayAdapters(gateway: GatewayDefinition, adapters: MessageAdapterType[]): void {
  const next = normalizeMessageAdapters(adapters);
  gateway.messageAdapters = next.length > 0 ? next : ["napcat"];
  gateway.messageAdapterType = gateway.messageAdapters[0];
  const disabledAdapters = normalizeOptionalMessageAdapters(gateway.messageAdaptersDisabled)
    .filter((type) => next.includes(type));
  gateway.messageAdaptersDisabled = disabledAdapters;
  gateway.messageAdapterPolicies = normalizeMessageAdapterPolicies(gateway.messageAdapterPolicies, next, disabledAdapters);
}

export function definitionUsesNapcat(definition: GatewayDefinition): boolean {
  return gatewayAdapterTypes(definition).includes("napcat");
}

export function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

export function assertValidPort(value: unknown, label: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}. Port must be an integer from 1 to 65535.`);
  }
}

export function portFromUrl(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

export function normalizeRecentMessageLimit(value: unknown, fallback = DEFAULT_RECENT_MESSAGE_LIMIT): number {
  if (value == null || (typeof value === "string" && !value.trim())) return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(MAX_RECENT_MESSAGE_LIMIT, Math.max(0, Math.floor(numberValue)));
}


export function normalizeRecentMessageLimits(
  value: unknown,
  legacyValue?: unknown
): RecentMessageLimits {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const legacyFallback = legacyValue == null
    ? DEFAULT_RECENT_MESSAGE_LIMIT
    : normalizeRecentMessageLimit(legacyValue);
  const result: RecentMessageLimits = {};
  for (const adapter of RECENT_MESSAGE_ENDPOINTS) {
    result[adapter] = normalizeRecentMessageLimit(raw[adapter], legacyFallback);
  }
  return result;
}

export function recentMessageLimitFor(
  limits: RecentMessageLimits | null | undefined,
  endpoint: RecentMessageEndpoint
): number {
  return normalizeRecentMessageLimit(limits?.[endpoint]);
}

export function normalizeSpeechPushMode(value: unknown): SpeechPushMode {
  return value === "keyword" ? "keyword" : "hot";
}

export function normalizeSpeechTriggerKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => String(item ?? "").trim())
    .filter((keyword) => {
      const key = keyword.toLocaleLowerCase();
      if (!keyword || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function matchSpeechTriggerKeyword(
  text: string,
  keywords: string[]
): string | undefined {
  const normalizedText = text.toLocaleLowerCase();
  return normalizeSpeechTriggerKeywords(keywords)
    .find((keyword) => normalizedText.includes(keyword.toLocaleLowerCase()));
}

export function normalizeCodexCwd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  const compact = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") {
    return undefined;
  }

  return trimmed;
}

export function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

export function validateNapcatRouteCardinality(definition: GatewayDefinition): void {
  if (Array.isArray(definition.napcatInstances) && definition.napcatInstances.length > 1) {
    throw new Error("一条路由只能绑定一个 QQ，请为另一个 QQ 新建路由。");
  }
}

export function normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[] {
  const source = Array.isArray(definition.napcatInstances) ? definition.napcatInstances : [];
  // A Route owns exactly one NapCat endpoint. Older configurations may contain
  // several entries; preserve the endpoint that previously acted as primary
  // (the first enabled entry, otherwise the first entry) and discard the rest.
  // Multiple QQ accounts belong in separate Routes so their policy, logs and
  // lifecycle stay isolated.
  const item = source.find((candidate) => candidate.enabled !== false) ?? source[0];
  if (!item) return [];

  const id = sanitizeInstanceId(item.id, "default");
  const gatewayPort = Number(item.gatewayPort || definition.gatewayPort || 8790);
    assertValidPort(gatewayPort, `NapCat instance port for ${definition.id}/${id}`);
  return [{
    ...item,
    id,
    name: item.name?.trim() || id,
    enabled: item.enabled !== false,
    autoLoginOnRabiStart: item.autoLoginOnRabiStart !== false,
    gatewayPort,
    httpUrl: item.httpUrl?.trim() || definition.napcatHttpUrl || "http://127.0.0.1:3000",
    webuiUrl: item.webuiUrl?.trim() || definition.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
    accessToken: item.accessToken ?? definition.napcatAccessToken ?? "",
    webuiToken: item.webuiToken ?? definition.napcatWebuiToken ?? "",
    launchCommand: item.launchCommand?.trim() || undefined,
    workingDir: item.workingDir?.trim() || undefined
  }];
}

export function resolvePrimaryNapCatInstance(
  definition: GatewayDefinition,
  instances: NapCatInstanceDefinition[] = normalizeNapCatInstances(definition)
): ResolvedNapCatInstances {
  const enabledIndex = instances.findIndex((item) => item.enabled !== false);
  const primaryIndex = enabledIndex >= 0 ? enabledIndex : (instances.length > 0 ? 0 : -1);
  return {
    instances,
    primary: primaryIndex >= 0 ? instances[primaryIndex] : undefined,
    primaryIndex
  };
}

export function normalizeGatewayNapCatConfig(definition: GatewayDefinition): ResolvedNapCatInstances {
  return resolvePrimaryNapCatInstance(definition, normalizeNapCatInstances(definition));
}

export function syncPrimaryNapCatInstanceFields(
  definition: GatewayDefinition,
  instances: NapCatInstanceDefinition[] = normalizeNapCatInstances(definition)
): ResolvedNapCatInstances {
  const resolved = resolvePrimaryNapCatInstance(definition, normalizeNapCatInstances({
    ...definition,
    napcatInstances: instances
  }));
  definition.napcatInstances = resolved.instances;
  if (resolved.primary) {
    definition.gatewayPort = resolved.primary.gatewayPort;
    definition.napcatHttpUrl = resolved.primary.httpUrl;
    definition.napcatWebuiUrl = resolved.primary.webuiUrl;
    definition.napcatAccessToken = resolved.primary.accessToken ?? "";
    definition.napcatWebuiToken = resolved.primary.webuiToken ?? "";
  }
  return resolved;
}

function normalizeAgentAdaptersFallback(adapters: AgentAdapterType[] | undefined): AgentAdapterType[] {
  if (adapters === undefined) {
    return ["codex"];
  }
  const rawItems = adapters as unknown[];
  const next = rawItems
    .filter((item): item is AgentAdapterType => agentAdapterValues.has(item as AgentAdapterType));
  const unique = [...new Set(next)];
  return unique;
}

export function resolvePrimaryAgentAdapter(
  agentAdapters: readonly AgentAdapterType[] | undefined,
  requestedPrimary: unknown
): AgentAdapterType | undefined {
  const adapters = agentAdapters ?? ["codex"];
  const requested = agentAdapterValues.has(requestedPrimary as AgentAdapterType)
    ? requestedPrimary as AgentAdapterType
    : undefined;
  return requested && adapters.includes(requested) ? requested : adapters[0];
}

export function primaryMessageProcessingAgentAdapter(definition: Pick<
  GatewayDefinition,
  "agentAdapters" | "primaryAgentAdapter" | "messageProcessingAgents"
>): AgentAdapterType | undefined {
  const primary = resolvePrimaryAgentAdapter(definition.agentAdapters, definition.primaryAgentAdapter);
  return primary
    && agentAdapterSupportsManagedTaskFeature(primary, "messageProcessingAgent")
    && definition.messageProcessingAgents?.[primary]?.enabled === true
    ? primary
    : undefined;
}

export function primaryMessageProcessingAgentEnabled(definition: Pick<
  GatewayDefinition,
  "agentAdapters" | "primaryAgentAdapter" | "messageProcessingAgents"
>): boolean {
  return Boolean(primaryMessageProcessingAgentAdapter(definition));
}

/** Compatibility helper for callers that specifically require Codex ownership. */
export function codexMessageProcessingAgentEnabled(definition: Pick<
  GatewayDefinition,
  "agentAdapters" | "primaryAgentAdapter" | "messageProcessingAgents"
>): boolean {
  return primaryMessageProcessingAgentAdapter(definition) === "codex";
}

function normalizePipelineFallback(pipeline: PipelineDefinition | undefined): PipelineDefinition | undefined {
  if (!pipeline) return undefined;
  return {
    ...pipeline,
    outputAdapter: pipeline.outputAdapter === "codex" ? "agent" : pipeline.outputAdapter,
    outputPipeline: pipeline.outputPipeline === "codex" ? "agent" : pipeline.outputPipeline
  };
}

function normalizeRouteProfile(
  profile: RouteProfileDefinition,
  index: number,
  definition: GatewayDefinition,
  dataDir: string,
  rolesDir: string,
  options: GatewayConfigModelOptions
): RouteProfileDefinition | null {
  const roleId = sanitizeRoleId(profile.agentRoleId);
  const id = sanitizeRoleId(profile.id) || roleId || `route-${index + 1}`;
  const profileAutomations = normalizePersonaAutomationRules(profile.automationRules ?? definition.automationRules);
  const baseRules = profileAutomations.length > 0
    ? notificationRulesFromPersonaAutomations(profileAutomations)
    : normalizeRuleDefinitions(profile.notificationRules) ?? [];
  const rules = gatewayAdapterTypes(definition).includes("speech")
    ? ensureSpeechRouteNotificationRule(baseRules)
    : baseRules;
  if (rules.length === 0 && profileAutomations.length === 0) {
    return null;
  }

  const normalizePipeline = options.normalizePipeline ?? normalizePipelineFallback;
  return {
    id,
    name: profile.name?.trim() || id,
    enabled: profile.enabled !== false,
    recentMessageLimit: undefined,
    recentMessageLimits: normalizeRecentMessageLimits(profile.recentMessageLimits ?? definition.recentMessageLimits, profile.recentMessageLimit ?? definition.recentMessageLimit),
    speechPushMode: normalizeSpeechPushMode(profile.speechPushMode ?? definition.speechPushMode),
    speechTriggerKeywords: normalizeSpeechTriggerKeywords(profile.speechTriggerKeywords ?? definition.speechTriggerKeywords),
    pipelinePreset: typeof profile.pipelinePreset === "string" && profile.pipelinePreset.trim()
      ? profile.pipelinePreset.trim()
      : definition.pipelinePreset,
    pipeline: normalizePipeline(profile.pipeline) ?? normalizePipeline(definition.pipeline),
    agentRoleId: roleId,
    agentRoleFile: profile.agentRoleFile?.trim() || definition.agentRoleFile || "persona.md",
    rolesDir: profile.rolesDir?.trim() || rolesDir,
    dataDir: profile.dataDir?.trim() || dataDir,
    routeVariables: profile.routeVariables ?? definition.routeVariables ?? {},
    automationRules: profileAutomations,
    personaAutomationScriptsEnabled: profile.personaAutomationScriptsEnabled ?? definition.personaAutomationScriptsEnabled === true,
    notificationRules: rules
  };
}

export function normalizeGatewayDefinition(definition: GatewayDefinition, options: GatewayConfigModelOptions = {}): GatewayDefinition {
  if (!definition.id || !sanitizeRoleId(definition.id)) {
    throw new Error(`Invalid gateway id: ${definition.id}`);
  }
  assertValidPort(definition.gatewayPort, `gateway port for ${definition.id}`);
  if (definition.webhookPort != null) assertValidPort(definition.webhookPort, `webhook port for ${definition.id}`);
  if (definition.fenneNoteWebhookPort != null) assertValidPort(definition.fenneNoteWebhookPort, `FenneNote webhook port for ${definition.id}`);
  if (definition.xiaoaiWebhookPort != null) assertValidPort(definition.xiaoaiWebhookPort, `XiaoAI webhook port for ${definition.id}`);
  if (definition.rabiLinkWebhookPort != null) assertValidPort(definition.rabiLinkWebhookPort, `RabiLink webhook port for ${definition.id}`);
  if (definition.feishuWebhookPort != null) assertValidPort(definition.feishuWebhookPort, `Feishu webhook port for ${definition.id}`);

  const identity = resolveRouteIdentity(definition);
  const agentRoleId = identity.roleId;
  const configName = identity.configName;
  const runtimeId = identity.runtimeId;
  const dataDir = options.routeDataDir?.(configName) ?? `data/route/${configName}`;
  const rolesDir = options.rolesDir ?? definition.rolesDir ?? "data/roles";
  const routeName = definition.routeName?.trim() || definition.name?.trim() || configName;
  const {
    botNickname: _legacyBotNickname,
    codexOnlyPrimaryPersonaCanSendMessages: _legacyCodexOnlyPrimaryPersonaCanSendMessages,
    ...cleanDefinition
  } = definition as GatewayDefinition & {
    botNickname?: string;
    codexOnlyPrimaryPersonaCanSendMessages?: boolean;
  };
  const rawMessageAdapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  const messageInputsDisabled = definition.messageInputsDisabled === true || rawMessageAdapters.includes("disabled");
  const normalizedMessageAdapters = normalizeMessageAdapters(rawMessageAdapters);
  const messageAdapters = normalizedMessageAdapters.length > 0 ? normalizedMessageAdapters : ["napcat" as MessageEndpointType];
  const messageAdaptersDisabled = normalizeOptionalMessageAdapters(definition.messageAdaptersDisabled).filter((type) => messageAdapters.includes(type));
  const messageAdapterPolicies = normalizeMessageAdapterPolicies(definition.messageAdapterPolicies, messageAdapters, messageAdaptersDisabled);
  const activeMessageAdapters = gatewayAdapterTypes({
    ...definition,
    messageAdapters,
    messageAdaptersDisabled,
    messageAdapterPolicies,
    messageInputsDisabled
  });
  const usesNapcat = activeMessageAdapters.includes("napcat");
  const napcatConfig = usesNapcat ? normalizeGatewayNapCatConfig(definition) : undefined;
  const napcatInstances = napcatConfig?.instances ?? [];
  const primaryNapcat = napcatConfig?.primary;
  const normalizeAgentAdapters = options.normalizeAgentAdapters ?? normalizeAgentAdaptersFallback;
  const normalizePipeline = options.normalizePipeline ?? normalizePipelineFallback;
  const agentAdapters = normalizeAgentAdapters(definition.agentAdapters);
  const primaryAgentAdapter = resolvePrimaryAgentAdapter(agentAdapters, definition.primaryAgentAdapter);
  const messageProcessingAgents = normalizeMessageProcessingAgentPolicies(definition.messageProcessingAgents, agentAdapters);
  const pipelinePreset = typeof definition.pipelinePreset === "string" && definition.pipelinePreset.trim()
    ? definition.pipelinePreset.trim()
    : activeMessageAdapters.includes("speech") ? "voice_chat" : undefined;
  const pipeline = normalizePipeline(definition.pipeline);
  const routeVariables = activeMessageAdapters.includes("speech")
    ? applySpeechRouteVariableDefaults(definition.routeVariables, agentRoleId || "Rabi")
    : definition.routeVariables;
  const configuredNotificationRules = normalizeRuleDefinitions(definition.notificationRules) ?? [];
  const configuredAutomations = normalizePersonaAutomationRules(definition.automationRules);
  const hasPersonaOnlyRules = !agentRoleId && configuredNotificationRules.some(sharedIsBuiltinRolePanelRule);
  const baseNotificationRules = (configuredNotificationRules.length > 0 && !hasPersonaOnlyRules) || agentRoleId
    ? configuredNotificationRules
    : defaultMessageAdapterNotificationRules(activeMessageAdapters);
  const baseAutomations = configuredAutomations.length > 0
    ? configuredAutomations
    : personaAutomationRulesFromNotificationRules(
      baseNotificationRules,
      normalizePositiveNumber(definition.heartbeatIntervalSeconds, 900)
    );
  const automationRules = ensureMessageAdapterAutomationRules(baseAutomations, activeMessageAdapters, {
    includeRolePanel: false
  });
  const notificationRules = notificationRulesFromPersonaAutomations(automationRules);
  const recentMessageLimits = normalizeRecentMessageLimits(definition.recentMessageLimits, definition.recentMessageLimit);
  const speechPushMode = normalizeSpeechPushMode(definition.speechPushMode);
  const speechTriggerKeywords = normalizeSpeechTriggerKeywords(definition.speechTriggerKeywords);
  const languageStyle = normalizeLanguageStyleBinding(definition.languageStyle);
  const rawCodexThreadId = definition.codexThreadId?.trim() || "";
  const legacyCodexThreadName = rawCodexThreadId && !isCodexTaskId(rawCodexThreadId)
    ? rawCodexThreadId
    : "";
  const codexCwd = normalizeCodexCwd(definition.codexCwd);
  const dshCwd = normalizeCodexCwd(definition.dshCwd);
  const planAssistantSupported = primaryAgentAdapter
    ? agentAdapterSupportsManagedTaskFeature(primaryAgentAdapter, "planAssistantSessions")
    : false;
  const memoryConsolidationSupported = primaryAgentAdapter
    ? agentAdapterSupportsManagedTaskFeature(primaryAgentAdapter, "memoryConsolidationAgent")
    : false;
  const hooksSupported = primaryAgentAdapter
    ? agentAdapterSupportsManagedTaskFeature(primaryAgentAdapter, "hooks")
    : false;
  const normalizedCodexPlanAssistantSessions = normalizeCodexPlanAssistantSessions(definition.codexPlanAssistantSessions)
    .filter((session) => {
      const adapter = planAssistantSessionAgentAdapter(session);
      if (adapter !== primaryAgentAdapter || !planAssistantSupported) return false;
      const ownerWorkspace = adapter === "dsh" ? dshCwd : codexCwd;
      return Boolean(ownerWorkspace) && sameCodexWorkspaceSyntax(session.workspace, ownerWorkspace);
    });
  const codexPlanAssistantModel = normalizeCodexPlanAssistantModel(
    definition.codexPlanAssistantModel
      ?? normalizedCodexPlanAssistantSessions.find((session) => session.model)?.model
  );
  const codexPlanAssistantSessions = normalizedCodexPlanAssistantSessions.map(({ model: _legacyModel, ...session }) => session);
  const codexPlanAssistantEnabled = definition.codexPlanAssistantEnabled == null
    ? codexPlanAssistantSessions.length > 0
    : definition.codexPlanAssistantEnabled === true;
  return {
    ...cleanDefinition,
    id: runtimeId,
    name: definition.name ?? routeName,
    configName,
    enabled: definition.enabled !== false,
    messageAdapterType: messageAdapters[0] ?? "napcat",
    messageAdapters,
    messageAdaptersDisabled,
    messageInputsDisabled,
    messageAdapterPolicies,
    agentAdapters,
    primaryAgentAdapter,
    messageProcessingAgents,
    agentModel: definition.agentModel?.trim() || "",
    agentReasoningEffort: normalizeCodexReasoningEffort(definition.agentReasoningEffort),
    pipelinePreset,
    pipeline,
    routeVariables,
    routeName,
    heartbeatIntervalSeconds: normalizePositiveNumber(definition.heartbeatIntervalSeconds, 900),
    heartbeatMessage: definition.heartbeatMessage ?? "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。",
    heartbeatSkipWhenAgentBusy: definition.heartbeatSkipWhenAgentBusy === true,
    personaAutomationScriptsEnabled: definition.personaAutomationScriptsEnabled === true,
    gatewayPort: primaryNapcat?.gatewayPort ?? definition.gatewayPort,
    rabiLinkWebhookHost: definition.rabiLinkWebhookHost?.trim() || "0.0.0.0",
    rabiLinkRelayEnabled: definition.rabiLinkRelayEnabled ?? Boolean(definition.rabiLinkRelayUrl?.trim()),
    rabiLinkRelayUrl: definition.rabiLinkRelayUrl?.trim() || "",
    rabiLinkRelayToken: definition.rabiLinkRelayToken?.trim() || "",
    rabiLinkRelayDeviceId: definition.rabiLinkRelayDeviceId?.trim() || runtimeId,
    rabiLinkRelayClaimWaitMs: normalizePositiveNumber(definition.rabiLinkRelayClaimWaitMs, 60000),
    rabiLinkRelayReplyIdleTimeoutMs: normalizePositiveNumber(definition.rabiLinkRelayReplyIdleTimeoutMs, 60000),
    feishuAppId: definition.feishuAppId?.trim() || "",
    feishuAppSecret: definition.feishuAppSecret?.trim() || "",
    feishuVerificationToken: definition.feishuVerificationToken?.trim() || "",
    feishuEncryptKey: definition.feishuEncryptKey?.trim() || "",
    feishuEventSubscriptionEnabled: definition.feishuEventSubscriptionEnabled === true,
    feishuWebhookPort: definition.feishuWebhookPort ?? definition.gatewayPort,
    feishuWebhookPath: definition.feishuWebhookPath?.trim() || "/feishu",
    napcatHttpUrl: primaryNapcat?.httpUrl ?? definition.napcatHttpUrl,
    napcatWebuiUrl: primaryNapcat?.webuiUrl ?? definition.napcatWebuiUrl,
    napcatAccessToken: primaryNapcat?.accessToken ?? definition.napcatAccessToken,
    napcatWebuiToken: primaryNapcat?.webuiToken ?? definition.napcatWebuiToken,
    napcatInstances: usesNapcat ? napcatInstances : undefined,
    ignoredNapcatInstanceIds: normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds),
    codexThreadId: isCodexTaskId(rawCodexThreadId) ? rawCodexThreadId : undefined,
    codexThreadName: definition.codexThreadName?.trim() || legacyCodexThreadName || undefined,
    dshSessionId: normalizeDshSessionId(definition.dshSessionId),
    dshSessionName: definition.dshSessionName?.trim() || undefined,
    dshCwd,
    dshBaseUrl: definition.dshBaseUrl?.trim() || undefined,
    dshModelProvider: definition.dshModelProvider?.trim() || undefined,
    dshModel: definition.dshModel?.trim() || undefined,
    dshReasoningEffort: definition.dshReasoningEffort?.trim() || undefined,
    codexPlanAssistantEnabled: planAssistantSupported
      ? codexPlanAssistantEnabled
      : undefined,
    codexPlanAssistantModel: planAssistantSupported
      ? codexPlanAssistantModel
      : undefined,
    codexPlanAssistantSessions: codexPlanAssistantSessions.length > 0
      ? codexPlanAssistantSessions
      : undefined,
    codexMemoryConsolidationAgentEnabled: memoryConsolidationSupported
      ? definition.codexMemoryConsolidationAgentEnabled === true
      : undefined,
    codexMemoryConsolidationAgentModel: memoryConsolidationSupported
      ? normalizeCodexMemoryConsolidationAgentModel(definition.codexMemoryConsolidationAgentModel)
      : undefined,
    codexHooks: definition.agentRoleId
      ? normalizeCodexHookSettings(definition.codexHooks)
      : hooksSupported
      ? {
          ...normalizeCodexHookSettings(definition.codexHooks),
          onlyPrimaryPersonaCanSendMessages: (primaryAgentAdapter === "codex" || primaryAgentAdapter === "dsh")
            && definition.codexHooks?.onlyPrimaryPersonaCanSendMessages === true
        }
      : undefined,
    copilotThreadName: definition.copilotThreadName?.trim() || undefined,
    groupNotificationTemplate: normalizeOptionalTemplate(definition.groupNotificationTemplate),
    groupAtNotificationTemplate: normalizeOptionalTemplate(definition.groupAtNotificationTemplate),
    groupDirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupDirectReplyNotificationTemplate),
    groupIndirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupIndirectReplyNotificationTemplate),
    groupReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupReplyNotificationTemplate),
    groupNicknameNotificationTemplate: normalizeOptionalTemplate(definition.groupNicknameNotificationTemplate),
    privateNotificationTemplate: normalizeOptionalTemplate(definition.privateNotificationTemplate),
    heartbeatNotificationTemplate: normalizeOptionalTemplate(definition.heartbeatNotificationTemplate),
    voiceTranscriptNotificationTemplate: normalizeOptionalTemplate(definition.voiceTranscriptNotificationTemplate),
    recentMessageLimit: undefined,
    recentMessageLimits,
    speechPushMode,
    speechTriggerKeywords,
    languageStyle,
    automationRules,
    notificationRules,
    dataDir,
    rolesDir,
    agentRoleId,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    roleNotificationRules: agentRoleId ? { [runtimeId]: notificationRules } : {},
    roleRouteNames: { [runtimeId]: routeName },
    routeProfiles: [normalizeRouteProfile({
      id: runtimeId,
      name: routeName,
      enabled: definition.enabled !== false,
      agentRoleId,
      agentRoleFile: definition.agentRoleFile ?? "persona.md",
      rolesDir,
      dataDir,
      recentMessageLimit: undefined,
      recentMessageLimits,
      speechPushMode,
      speechTriggerKeywords,
      languageStyle,
      pipelinePreset,
      pipeline,
      routeVariables,
      automationRules,
      personaAutomationScriptsEnabled: definition.personaAutomationScriptsEnabled === true,
      notificationRules
    }, 0, definition, dataDir, rolesDir, options)].filter((profile): profile is RouteProfileDefinition => Boolean(profile))
  };
}

export function collectGatewayPortClaims(
  gateways: GatewayDefinition[],
  options: { managerPort?: number } = {}
): GatewayPortClaim[] {
  const claims: GatewayPortClaim[] = [];
  const claim = (
    port: number | null | undefined,
    label: string,
    kind: GatewayPortClaimKind,
    gatewayId?: string,
    instanceId?: string
  ): void => {
    if (port == null) return;
    assertValidPort(port, label);
    claims.push({ port, label, kind, gatewayId, instanceId });
  };

  if (options.managerPort != null) {
    claim(options.managerPort, "manager", "manager");
  }

  for (const gateway of gateways) {
    const activeAdapters = new Set(gatewayAdapterTypes(gateway));
    const enabledNapcatInstances = activeAdapters.has("napcat")
      ? (gateway.napcatInstances ?? []).filter((instance) => instance.enabled !== false)
      : [];
    if (activeAdapters.has("napcat") && enabledNapcatInstances.length === 0) {
      claim(gateway.gatewayPort, `${gateway.id} gateway WS`, "gateway-ws", gateway.id);
    }
    if (activeAdapters.has("webhook")) claim(gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} webhook`, "webhook", gateway.id);
    if (activeAdapters.has("fennenote")) claim(gateway.fenneNoteWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} FenneNote webhook`, "fennenote-webhook", gateway.id);
    if (activeAdapters.has("xiaoai")) claim(gateway.xiaoaiWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} XiaoAI webhook`, "xiaoai-webhook", gateway.id);
    if (activeAdapters.has("rabilink")) claim(gateway.rabiLinkWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} RabiLink webhook`, "rabilink-webhook", gateway.id);
    if (activeAdapters.has("feishu")) claim(gateway.feishuWebhookPort ?? gateway.gatewayPort, `${gateway.id} Feishu webhook`, "feishu-webhook", gateway.id);
    for (const instance of enabledNapcatInstances) {
      const prefix = `${gateway.id}/${instance.id}`;
      claim(instance.gatewayPort, `${prefix} RabiRoute WS`, "napcat-ws", gateway.id, instance.id);
      claim(portFromUrl(instance.httpUrl), `${prefix} NapCat HTTP`, "napcat-http", gateway.id, instance.id);
    }
  }

  return claims;
}

export function validateGatewayPortConflicts(gateways: GatewayDefinition[]): void {
  const ports = new Map<number, GatewayPortClaim>();
  for (const claim of collectGatewayPortClaims(gateways)) {
    // NapCat HTTP is an outbound service endpoint, not a listener owned by a
    // Route. Multiple Routes may intentionally use the same NapCat instance.
    if (claim.kind === "napcat-http") continue;
    const existing = ports.get(claim.port);
    if (existing) {
      throw new Error(`Port conflict: ${claim.label} uses ${claim.port}, already used by ${existing.label}.`);
    }
    ports.set(claim.port, claim);
  }
}

export function nextAvailablePort(used: Set<number>, preferred: number): number {
  let port = Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535 ? preferred : 8790;
  while (port <= 65535 && used.has(port)) port += 1;
  if (port > 65535) {
    throw new Error("No available port in the 1-65535 range.");
  }
  used.add(port);
  return port;
}

export function autoAssignGatewayPorts(gateways: GatewayDefinition[], managerPort?: number): void {
  const usedIngress = new Set<number>();
  const publishedManagerPort = typeof managerPort === "number"
    && Number.isInteger(managerPort)
    && managerPort >= 1
    && managerPort <= 65535
    ? managerPort
    : null;
  if (publishedManagerPort != null) {
    usedIngress.add(publishedManagerPort);
  }

  const assignIngress = (value: unknown, fallback: number): number => {
    const current = Number(value || 0);
    if (Number.isInteger(current) && current >= 1 && current <= 65535 && !usedIngress.has(current)) {
      usedIngress.add(current);
      return current;
    }
    return nextAvailablePort(usedIngress, Math.max(1, Math.min(65535, Number(fallback) || 8790)));
  };

  const normalizeHttpUrl = (value: string | undefined, fallbackPort: number): string => {
    let parsed: URL;
    try {
      parsed = new URL(value || `http://127.0.0.1:${fallbackPort}`);
    } catch {
      parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
    }
    return parsed.toString().replace(/\/$/, "");
  };

  for (const gateway of gateways) {
    const activeAdapters = new Set(gatewayAdapterTypes(gateway));
    const enabledNapcatInstances = activeAdapters.has("napcat")
      ? (gateway.napcatInstances ?? []).filter((instance) => instance.enabled !== false)
      : [];

    if (activeAdapters.has("napcat") && enabledNapcatInstances.length > 0) {
      for (const instance of enabledNapcatInstances) {
        instance.gatewayPort = assignIngress(instance.gatewayPort, Number(gateway.gatewayPort || 8790) + 1);
        instance.httpUrl = normalizeHttpUrl(instance.httpUrl || gateway.napcatHttpUrl, 3000);
      }
      syncPrimaryNapCatInstanceFields(gateway, gateway.napcatInstances ?? enabledNapcatInstances);
    } else if (activeAdapters.has("napcat")) {
      gateway.gatewayPort = assignIngress(gateway.gatewayPort, 8790);
    }

    if (activeAdapters.has("webhook")) {
      gateway.webhookPort = assignIngress(gateway.webhookPort, Number(gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("fennenote")) {
      gateway.fenneNoteWebhookPort = assignIngress(gateway.fenneNoteWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("xiaoai")) {
      gateway.xiaoaiWebhookPort = assignIngress(gateway.xiaoaiWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("rabilink")) {
      gateway.rabiLinkWebhookPort = assignIngress(gateway.rabiLinkWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("feishu")) {
      gateway.feishuWebhookPort = assignIngress(gateway.feishuWebhookPort, Number(gateway.gatewayPort || 8790) + 1);
    }
  }
}
