<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import SpeechParameterSlider from "../components/SpeechParameterSlider.vue";
import PlanFollowupSettings from "../components/PlanFollowupSettings.vue";
import type { PlanFollowupSettings as PlanFollowupConfig } from "@shared/planFollowup";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import PersonaDesktopPetPanel from "../components/PersonaDesktopPetPanel.vue";
import PersonaIdentityRelationsCard from "../components/PersonaIdentityRelationsCard.vue";
import PersonaChatHistory from "../components/PersonaChatHistory.vue";
import AgentCompletionDeliveryRules from "../components/AgentCompletionDeliveryRules.vue";
import { managerEventSource } from "../managerApi";
import { useI18n } from "../i18n";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { buildWebNavigation } from "../pluginNavigation";
import { personaAvatarClient } from "../persona/personaAvatarClient";
import { loadPersonaDocument } from "../persona/personaDocumentClient";
import type { IdentityEndpointAccount, IdentityParticipant } from "../persona/personaIdentityRelationClient";
import {
  personaVoiceIdentityClient,
  type PersonaVoiceIdentity,
  type PersonaVoiceIdentityPatch,
  type PersonaVoiceTranscriptSummary
} from "../persona/personaVoiceIdentityClient";
import {
  beginPersonaVoiceConfirmation,
  idlePersonaVoiceConfirmation,
  isPersonaVoiceConfirmationCandidate,
  observePersonaVoiceConfirmation,
  orderPersonaVoiceConfirmationCandidates,
  personaVoiceprintEvidenceKey
} from "../persona/personaVoiceConfirmation";
import { useGatewayStore } from "../stores/gatewayStore";
import { useSpeechStore } from "../stores/speechStore";
import type { CodexHookSettings, NotificationRule, NotificationScheduleDefinition, PersonaAutomationRuleDefinition } from "../types";
import {
  DEFAULT_RECENT_MESSAGE_LIMIT,
  MAX_RECENT_MESSAGE_LIMIT,
  RECENT_MESSAGE_ENDPOINTS,
  normalizeRecentMessageLimit,
  normalizeSpeechTriggerKeywords,
  normalizeCodexHookSettings,
  type AgentCompletionDeliveryRule,
  type RecentMessageEndpoint
} from "@shared/gatewayConfigModel";
import { isSpeechRouteVariableKey } from "@shared/speechControlContract";
import { PERSONA_AVATAR_ACCEPT } from "@shared/personaAvatarContract";
import { copyTextToClipboard } from "../clipboard";
import { markdownPreviewExcerpt } from "../markdownPreview";
import { routeScopedPersonaDocumentPath } from "../routeScopedNavigation";
import {
  adapterLabel,
  automationRulesForGateway,
  configNameFor,
  defaultHeartbeatSchedule,
  gatewayAdapterTypes,
  isBuiltinRolePanelRule,
  notificationRulesForGateway,
  routeKindDefinitionsForGateway,
  routeKindLabels,
  routeKindSummary,
  ruleHasGroupRoute,
  ruleTemplateSnippet,
  templateVars
} from "../utils/gatewayHelpers";
import { personaOptionDisplayName } from "../personaPresentation";

const store = useGatewayStore();
const speech = useSpeechStore();
const { t } = useI18n();
const ruleDialog = ref(false);
const automationDialog = ref(false);
const automationWorkspaceTab = ref<"messages" | "schedule" | "hooks">("messages");
const templateVariablesDialog = ref(false);
type PersonaPageTab = "profile" | "expression" | "avatar" | "identity" | "context" | "automation" | "chat-history";
const activePersonaPageTab = ref<PersonaPageTab>("profile");
const chatHistoryVersion = ref(0);
const activeAutomationId = ref("");
const activeRuleIndex = ref(0);
const ruleMatchParamsOpen = ref(true);
const ruleRouteKindsOpen = ref(true);
const ruleSchedulesOpen = ref(true);
const ruleTemplateOpen = ref(true);
const voiceProfileRefreshing = ref(false);
const voiceProfileError = ref("");
const voiceProfileCopyResult = ref("");
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarSaving = ref(false);
const avatarError = ref("");
const voiceIdentityLoading = ref(false);
const voiceIdentityLoaded = ref(false);
const voiceIdentityError = ref("");
const voiceIdentityNotice = ref("");
const voiceIdentitySummary = ref<PersonaVoiceTranscriptSummary | null>(null);
const voiceIdentities = ref<PersonaVoiceIdentity[]>([]);
const voiceIdentityBusyKey = ref("");
const voiceParticipantSelections = ref<Record<string, string>>({});
const voiceConfirmation = ref(idlePersonaVoiceConfirmation());
const identityRelationsVersion = ref(0);
const identityParticipants = ref<IdentityParticipant[]>([]);
const identityEndpointAccounts = ref<IdentityEndpointAccount[]>([]);
const voiceToolsDialog = ref(false);
const personaMarkdownContent = ref("");
const personaMarkdownLoading = ref(false);
const personaMarkdownLoadError = ref("");
let releaseSpeech: (() => void) | null = null;
let managerEvents: EventSource | null = null;
let managerEventsReady = false;
let voiceIdentityRefreshRunning = false;
let voiceIdentityRefreshQueued = false;
let voiceIdentityRefreshObserveQueued = false;
let personaMarkdownRequestVersion = 0;
const PERSONA_SUMMARY_MAX_CHARACTERS = 420;

const recentMessageEndpoints: RecentMessageEndpoint[] = RECENT_MESSAGE_ENDPOINTS.filter(endpoint => endpoint !== "heartbeat");

const gateway = computed(() => store.selectedGateway);
const personaSecondaryNavItems = computed(() => buildWebNavigation(
  pluginCatalogStore.contributions.value,
  gateway.value ? configNameFor(gateway.value) : ""
).personaSecondary.map(item => ({ ...item, title: t(item.title) })));
const runtime = computed(() => store.selectedRuntime);
const roleOptions = computed(() => [
  { title: "不注入人格", subtitle: "", value: "", avatarUrl: "" },
  ...((runtime.value.roleInfo?.options || []).map(role => ({
    title: personaOptionDisplayName(role),
    subtitle: personaOptionDisplayName(role) !== role.value ? `人格 ID · ${role.value}` : "",
    value: role.value,
    avatarUrl: role.avatarUrl || ""
  })))
]);
const selectedRole = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  return (runtime.value.roleInfo?.options || []).find(role => role.value === roleId);
});
const personaMarkdownSource = computed(() => personaMarkdownContent.value
  || selectedRole.value?.roleContent
  || runtime.value.roleInfo?.selectedRoleContent
  || "");
const personaMarkdownError = computed(() => personaMarkdownLoadError.value
  || selectedRole.value?.roleError
  || runtime.value.roleInfo?.selectedRoleError
  || "");
const personaMarkdownSummary = computed(() => markdownPreviewExcerpt(
  personaMarkdownSource.value,
  PERSONA_SUMMARY_MAX_CHARACTERS
));
const personaDocumentPath = computed(() => routeScopedPersonaDocumentPath(
  gateway.value ? configNameFor(gateway.value) : ""
));
const voiceProfile = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  return speech.personas.find(persona => persona.id === roleId);
});
const hasPersona = computed(() => Boolean(gateway.value?.agentRoleId));
const authoritativeIdentityParticipantIds = computed(() => new Set(identityParticipants.value
  .filter(item => !item.conflicted && (item.status === "confirmed" || item.status === "corrected"))
  .map(item => item.id)));
const genericVoiceAccountKeys = computed(() => new Set(identityEndpointAccounts.value
  .filter(account => !account.conflicted && ["voice", "speech", "voiceprint"].includes(account.platform.trim().toLocaleLowerCase()))
  .map(account => `${account.endpointIdentityNamespace}|${account.senderStableId}`)));
function hasGenericVoiceAccount(sourceHostId: string | undefined, voiceprintId: string): boolean {
  return Boolean(sourceHostId && genericVoiceAccountKeys.value.has(`host:${sourceHostId}|${voiceprintId}`));
}
const assignedVoiceIdentityKeys = computed(() => new Set(
  voiceIdentities.value
    .filter(identity => !identity.conflicted && identity.participantId && authoritativeIdentityParticipantIds.value.has(identity.participantId))
    .map(identity => voiceIdentityKey(identity.sourceHostId, identity.voiceprintId))
));
const unresolvedVoiceprints = computed(() => (voiceIdentitySummary.value?.unresolvedVoiceprints || []).filter(item =>
  !assignedVoiceIdentityKeys.value.has(voiceIdentityKey(item.sourceHostId, item.voiceprintId))
  && !hasGenericVoiceAccount(item.sourceHostId, item.voiceprintId)
));
const orderedUnresolvedVoiceprints = computed(() => orderPersonaVoiceConfirmationCandidates(
  voiceConfirmation.value,
  unresolvedVoiceprints.value
));
const voiceConfirmationCandidateCount = computed(() => voiceConfirmation.value.candidateKeys.length);
const sortedVoiceIdentities = computed(() => [...voiceIdentities.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const unassignedVoiceIdentities = computed(() => sortedVoiceIdentities.value.filter(identity =>
  !identity.participantId || !authoritativeIdentityParticipantIds.value.has(identity.participantId)
));
const unresolvedVoiceIdentityKeys = computed(() => new Set(unresolvedVoiceprints.value.map(item =>
  voiceIdentityKey(item.sourceHostId, item.voiceprintId)
)));
const storedUnassignedVoiceIdentities = computed(() => unassignedVoiceIdentities.value.filter(identity =>
  !unresolvedVoiceIdentityKeys.value.has(voiceIdentityKey(identity.sourceHostId, identity.voiceprintId))
  && !hasGenericVoiceAccount(identity.sourceHostId, identity.voiceprintId)
));
const unidentifiedVoiceCount = computed(() => unresolvedVoiceprints.value.length + storedUnassignedVoiceIdentities.value.length);
const rules = computed(() => gateway.value ? notificationRulesForGateway(gateway.value) : []);
const automations = computed(() => gateway.value ? automationRulesForGateway(gateway.value) : []);
const messageAutomations = computed(() => automations.value.filter(rule => rule.trigger.type === "message"));
const scheduledAutomations = computed(() => automations.value.filter(rule => rule.trigger.type === "schedule"));
const activeAutomation = computed(() => automations.value.find(rule => rule.id === activeAutomationId.value) || null);
const timerInputEnabled = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value).includes("heartbeat") : false);
const activeRule = computed(() => rules.value[activeRuleIndex.value] || null);
const variableEntries = computed(() => Object.entries(gateway.value?.routeVariables || {})
  .filter(([key]) => !isSpeechRouteVariableKey(key)));
const roleDirLabel = computed(() => runtime.value.roleInfo?.rolesDir || "./data/roles");
const voiceProfilePath = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  const personaPath = selectedRole.value?.rolePath || runtime.value.roleInfo?.selectedRolePath || "";
  if (!personaPath) return `${roleDirLabel.value}/${roleId}/voice/voice-profile.json`;
  const separator = personaPath.includes("\\") ? "\\" : "/";
  const lastSeparator = Math.max(personaPath.lastIndexOf("/"), personaPath.lastIndexOf("\\"));
  const roleDir = lastSeparator >= 0 ? personaPath.slice(0, lastSeparator) : personaPath;
  return `${roleDir}${separator}voice${separator}voice-profile.json`;
});
const routeKindQuery = ref("");
const routeKindDefinitions = computed(() => routeKindDefinitionsForGateway(gateway.value || undefined));
const selectedRouteKindCount = computed(() => activeRule.value?.routeKinds?.length || 0);
const activeRuleDiagnostics = computed(() => activeRule.value ? ruleDiagnostics(activeRule.value) : []);
const activeRuleNotes = computed(() => activeRule.value ? ruleNotes(activeRule.value) : []);
const ruleDiagnosticsCount = computed(() => rules.value.reduce((count, rule) => count + ruleDiagnostics(rule).length, 0));
const scheduleTypeOptions = [
  { title: "每隔一段时间", value: "interval" },
  { title: "每天指定时间", value: "daily_time" },
  { title: "某一天指定时间", value: "once_at" }
];
const actionTypeOptions = [
  { title: "通知 Agent", value: "deliver_agent", icon: "mdi-message-arrow-right-outline", note: "把当前消息或定时说明交给这个人格处理" },
  { title: "运行脚本", value: "run_script", icon: "mdi-console-line", note: "运行人格 scripts 目录中的 cmd、bat 或 py 文件" }
];
const messageAutomationGroups = computed(() => {
  const definitions = [
    { key: "chat", title: "聊天消息", note: "私聊、群聊、回复和 @", kinds: ["private", "group_message", "direct_at", "direct_reply", "indirect_reply", "wecom_message", "weixin_message", "feishu_message"] },
    { key: "voice", title: "语音与设备", note: "语音转写、穿戴设备和 RabiLink", kinds: ["voice_transcript", "wearable_health_alert", "rabilink"] },
    { key: "system", title: "手动与系统消息", note: "手动触发、角色面板和兼容事件", kinds: ["manual_trigger", "role_panel_message", "plan_feedback", "heartbeat"] },
    { key: "other", title: "其他来源", note: "未归入以上分组的消息类型", kinds: [] as string[] }
  ];
  const assigned = new Set<string>();
  return definitions.map(definition => {
    const items = messageAutomations.value.filter(rule => {
      if (assigned.has(rule.id) || rule.trigger.type !== "message") return false;
      const routeKinds = rule.trigger.routeKinds ?? [];
      const matches = definition.key === "other"
        ? true
        : routeKinds.some(kind => definition.kinds.includes(kind));
      if (matches) assigned.add(rule.id);
      return matches;
    });
    return { ...definition, items };
  }).filter(group => group.items.length > 0);
});
const activeRuleHasHeartbeat = computed(() => activeRule.value?.routeKinds?.includes("heartbeat") === true);
const visibleRouteKindDefinitions = computed(() => {
  const query = routeKindQuery.value.trim().toLowerCase();
  if (!query) return routeKindDefinitions.value;
  return routeKindDefinitions.value
    .map(definition => ({
      ...definition,
      groups: definition.groups
        .map(group => ({
          ...group,
          routeKinds: group.routeKinds.filter(kind => {
            return [
              definition.title,
              definition.note,
              group.title,
              kind,
              routeKindLabels[kind] || ""
            ].join(" ").toLowerCase().includes(query);
          })
        }))
        .filter(group => group.routeKinds.length > 0)
    }))
    .filter(definition => definition.groups.length > 0);
});

function openRule(index: number): void {
  activeRuleIndex.value = index;
  ruleMatchParamsOpen.value = true;
  ruleRouteKindsOpen.value = true;
  ruleSchedulesOpen.value = true;
  ruleTemplateOpen.value = true;
  ruleDialog.value = true;
}

function patchRule(patch: Partial<NotificationRule>): void {
  store.updateRule(activeRuleIndex.value, patch);
}

function ruleDiagnostics(rule: NotificationRule): string[] {
  const issues: string[] = [];
  if (!Array.isArray(rule.routeKinds) || rule.routeKinds.length === 0) {
    issues.push("未选择路由类型时会匹配全部入口；建议明确选择要接收的消息来源。");
  }
  if (rule.regex && !/\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    try {
      new RegExp(rule.regex);
    } catch {
      issues.push("消息匹配正则无法解析，保存后可能导致匹配失败。");
    }
  }
  if (rule.routeKinds?.includes("heartbeat") && (!Array.isArray(rule.schedules) || rule.schedules.length === 0)) {
    issues.push("包含 heartbeat 但没有定时计划，只能通过手动触发验证。");
  }
  return issues;
}

function ruleNotes(rule: NotificationRule): string[] {
  const notes: string[] = [];
  if (!String(rule.template || "").trim()) {
    notes.push("模板为空时仍会发送基础 AgentPacket，只是不追加自定义模板正文。");
  }
  if (rule.regex && /\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    notes.push("正则包含路由变量，保存后会按运行时变量展开再匹配。");
  }
  return notes;
}

function toggleRouteKind(kind: string, checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  if (checked) next.add(kind);
  else next.delete(kind);
  patchRule({ routeKinds: [...next] });
}

function setRouteKinds(kinds: string[], checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  kinds.forEach(kind => {
    if (checked) next.add(kind);
    else next.delete(kind);
  });
  patchRule({ routeKinds: [...next] });
}

function addSchedule(): void {
  if (!activeRule.value || !gateway.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const schedule = defaultHeartbeatSchedule(gateway.value, `计划 ${schedules.length + 1}`);
  patchRule({ schedules: [...schedules, schedule] });
}

function updateSchedule(index: number, patch: Partial<NotificationScheduleDefinition>): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const current = schedules[index];
  if (!current) return;
  schedules[index] = { ...current, ...patch };
  patchRule({ schedules });
}

function setScheduleType(index: number, type: string): void {
  if (type !== "interval" && type !== "daily_time" && type !== "once_at") return;
  updateSchedule(index, { type });
}

function removeSchedule(index: number): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  schedules.splice(index, 1);
  patchRule({ schedules });
}

function openAutomation(ruleId: string): void {
  activeAutomationId.value = ruleId;
  automationDialog.value = true;
  routeKindQuery.value = "";
}

function createAutomation(triggerType: "message" | "schedule", actionType: string): void {
  const normalizedAction = actionType === "run_script" ? "run_script" : "deliver_agent";
  const id = store.addAutomation(triggerType, normalizedAction);
  if (!id) return;
  automationWorkspaceTab.value = triggerType === "schedule" ? "schedule" : "messages";
  openAutomation(id);
}

function patchAutomation(patch: Partial<PersonaAutomationRuleDefinition>): void {
  if (!activeAutomation.value) return;
  store.updateAutomation(activeAutomation.value.id, patch);
}

function setAutomationTriggerType(type: "message" | "schedule"): void {
  if (!activeAutomation.value || !gateway.value || activeAutomation.value.trigger.type === type) return;
  patchAutomation({
    trigger: type === "schedule"
      ? { type: "schedule", schedule: defaultHeartbeatSchedule(gateway.value, "触发时间") }
      : { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" }
  });
  automationWorkspaceTab.value = type === "schedule" ? "schedule" : "messages";
}

function setAutomationActionType(type: "deliver_agent" | "run_script"): void {
  if (!activeAutomation.value || activeAutomation.value.action.type === type) return;
  patchAutomation({
    action: type === "run_script"
      ? { type: "run_script", scriptPath: "", arguments: [], timeoutSeconds: 300 }
      : { type: "deliver_agent", message: "", template: "" }
  });
}

function patchAutomationMessageTrigger(patch: Record<string, unknown>): void {
  if (!activeAutomation.value || activeAutomation.value.trigger.type !== "message") return;
  patchAutomation({ trigger: { ...activeAutomation.value.trigger, ...patch } as PersonaAutomationRuleDefinition["trigger"] });
}

function toggleAutomationRouteKind(kind: string): void {
  if (!activeAutomation.value || activeAutomation.value.trigger.type !== "message") return;
  const next = new Set(activeAutomation.value.trigger.routeKinds || []);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  patchAutomationMessageTrigger({ routeKinds: [...next] });
}

function patchAutomationSchedule(patch: Partial<NotificationScheduleDefinition>): void {
  if (!activeAutomation.value || activeAutomation.value.trigger.type !== "schedule") return;
  patchAutomation({
    trigger: {
      type: "schedule",
      schedule: { ...activeAutomation.value.trigger.schedule, ...patch }
    }
  });
}

function setAutomationScheduleType(type: string): void {
  if (type !== "interval" && type !== "daily_time" && type !== "once_at") return;
  patchAutomationSchedule({ type });
}

function patchAutomationAction(patch: Record<string, unknown>): void {
  if (!activeAutomation.value) return;
  patchAutomation({ action: { ...activeAutomation.value.action, ...patch } as PersonaAutomationRuleDefinition["action"] });
}

function automationSourceSummary(rule: PersonaAutomationRuleDefinition): string {
  if (rule.trigger.type === "schedule") {
    const schedule = rule.trigger.schedule;
    if (schedule.type === "daily_time") return `每天 ${schedule.timeOfDay || "未设置时间"}`;
    if (schedule.type === "once_at") return schedule.onceAt ? `一次：${schedule.onceAt.replace("T", " ")}` : "一次性时间未设置";
    const window = schedule.windowStartTime && schedule.windowEndTime
      ? `，${schedule.windowStartTime}–${schedule.windowEndTime}`
      : "";
    return `每 ${schedule.intervalSeconds || 0} 秒${window}`;
  }
  const kinds = rule.trigger.routeKinds || [];
  return kinds.length > 0 ? kinds.map(kind => routeKindLabels[kind] || kind).join("、") : "所有收到的消息";
}

function automationActionSummary(rule: PersonaAutomationRuleDefinition): string {
  if (rule.action.type === "run_script") return rule.action.scriptPath ? `运行 ${rule.action.scriptPath}` : "脚本路径未设置";
  if (rule.trigger.type === "schedule") return rule.action.message?.trim() || "通知内容未填写";
  return rule.action.template?.trim() ? rule.action.template.trim().replace(/\s+/g, " ").slice(0, 90) : "使用基础消息内容，不附加额外说明";
}

function automationDiagnostics(rule: PersonaAutomationRuleDefinition): string[] {
  const issues: string[] = [];
  if (rule.trigger.type === "message" && (rule.trigger.routeKinds?.length || 0) === 0) {
    issues.push("没有选择消息来源时会匹配所有收到的消息。");
  }
  if (rule.trigger.type === "message" && rule.trigger.regex) {
    try { new RegExp(rule.trigger.regex); } catch { issues.push("消息匹配正则无法解析。"); }
  }
  if (rule.trigger.type === "schedule") {
    const schedule = rule.trigger.schedule;
    if (schedule.type === "interval" && Number(schedule.intervalSeconds || 0) <= 0) issues.push("间隔必须大于 0 秒。");
    if (schedule.type === "daily_time" && !schedule.timeOfDay) issues.push("还没有设置每天执行时间。");
    if (schedule.type === "once_at" && !schedule.onceAt) issues.push("还没有设置执行日期和时间。");
    if (!timerInputEnabled.value) issues.push("当前 Route 尚未启用定时任务入口。");
  }
  if (rule.action.type === "run_script") {
    if (!rule.action.scriptPath?.trim()) issues.push("还没有选择人格 scripts 目录中的脚本。");
    if (!gateway.value?.personaAutomationScriptsEnabled) issues.push("当前 Route 尚未允许运行人格脚本。");
  }
  return issues;
}

function automationActionLabel(rule: PersonaAutomationRuleDefinition): string {
  return rule.action.type === "run_script" ? "运行脚本" : "通知 Agent";
}

function automationActionColor(rule: PersonaAutomationRuleDefinition): string {
  return rule.action.type === "run_script" ? "warning" : "secondary";
}

function enableTimerInput(): void {
  if (!gateway.value || timerInputEnabled.value) return;
  store.updateAdapters([...gatewayAdapterTypes(gateway.value), "heartbeat"]);
}

function setScriptExecutionEnabled(value: boolean): void {
  if (!gateway.value) return;
  gateway.value.personaAutomationScriptsEnabled = value;
  store.touch();
}

function scriptArgumentsText(rule: PersonaAutomationRuleDefinition): string {
  return rule.action.type === "run_script" ? (rule.action.arguments || []).join("\n") : "";
}

function setScriptArguments(value: unknown): void {
  patchAutomationAction({
    arguments: String(value || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean)
  });
}

function setRole(value: string): void {
  if (!gateway.value) return;
  gateway.value.agentRoleId = value;
  if (!value) {
    gateway.value.automationRules = [];
    gateway.value.notificationRules = [];
  }
  store.touch();
}

function chooseAvatar(): void {
  avatarInput.value?.click();
}

async function uploadAvatar(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !gateway.value?.agentRoleId) return;
  avatarSaving.value = true;
  avatarError.value = "";
  try {
    await personaAvatarClient.upload(gateway.value.agentRoleId, file);
    await Promise.all([store.load({ replaceDirtyConfig: !store.dirty }), speech.refreshPersonas()]);
  } catch (error) {
    avatarError.value = userFacingError(error);
  } finally {
    avatarSaving.value = false;
  }
}

async function removeAvatar(): Promise<void> {
  if (!gateway.value?.agentRoleId) return;
  avatarSaving.value = true;
  avatarError.value = "";
  try {
    await personaAvatarClient.remove(gateway.value.agentRoleId);
    await Promise.all([store.load({ replaceDirtyConfig: !store.dirty }), speech.refreshPersonas()]);
  } catch (error) {
    avatarError.value = userFacingError(error);
  } finally {
    avatarSaving.value = false;
  }
}

function setSpeechTriggerKeywords(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.speechTriggerKeywords = normalizeSpeechTriggerKeywords(value);
  store.touch();
}

function setLanguageStyleSkillUrl(value: unknown): void {
  if (!gateway.value) return;
  const styleSkillUrl = String(value || "").trim();
  gateway.value.languageStyle = styleSkillUrl ? { styleSkillUrl } : undefined;
  store.touch();
}

function codexHookEnabled(key: Exclude<keyof CodexHookSettings, "completionDeliveries" | "planFollowup">): boolean {
  return gateway.value?.codexHooks?.[key] !== false;
}

function setCodexHookSetting(key: Exclude<keyof CodexHookSettings, "completionDeliveries" | "planFollowup">, enabled: boolean | null): void {
  if (!gateway.value) return;
  gateway.value.codexHooks = {
    ...gateway.value.codexHooks,
    sessionContextEnabled: gateway.value.codexHooks?.sessionContextEnabled !== false,
    reasoningContextEnabled: gateway.value.codexHooks?.reasoningContextEnabled !== false,
    planTaskCompletionEnabled: gateway.value.codexHooks?.planTaskCompletionEnabled !== false,
    agentCommunicationEnforcementEnabled: gateway.value.codexHooks?.agentCommunicationEnforcementEnabled !== false,
    onlyPrimaryPersonaCanSendMessages: gateway.value.codexHooks?.onlyPrimaryPersonaCanSendMessages === true,
    [key]: enabled === true
  };
  for (const other of store.gateways) {
    if (other.agentRoleId === gateway.value.agentRoleId) other.codexHooks = { ...gateway.value.codexHooks };
  }
  store.touch();
}

function setPlanFollowup(planFollowup: PlanFollowupConfig): void {
  if (!gateway.value) return;
  const hooks = { ...normalizeCodexHookSettings(gateway.value.codexHooks), planFollowup };
  for (const other of store.gateways) {
    if (other.agentRoleId === gateway.value.agentRoleId) other.codexHooks = { ...hooks };
  }
  store.touch();
}

function setCompletionDeliveries(rules: AgentCompletionDeliveryRule[]): void {
  if (!gateway.value) return;
  const hooks = { ...normalizeCodexHookSettings(gateway.value.codexHooks), completionDeliveries: rules };
  for (const other of store.gateways) {
    if (other.agentRoleId === gateway.value.agentRoleId) other.codexHooks = { ...hooks };
  }
  store.touch();
}

function recentMessageLimitFor(endpoint: RecentMessageEndpoint): number {
  return normalizeRecentMessageLimit(gateway.value?.recentMessageLimits?.[endpoint]);
}

function setRecentMessageLimit(endpoint: RecentMessageEndpoint, value: unknown): void {
  if (!gateway.value) return;
  gateway.value.recentMessageLimits = {
    ...(gateway.value.recentMessageLimits || {}),
    [endpoint]: normalizeRecentMessageLimit(value)
  };
  store.touch();
}

async function refreshVoiceProfile(): Promise<void> {
  voiceProfileRefreshing.value = true;
  voiceProfileError.value = "";
  try {
    await speech.refreshPersonas();
  } catch (error) {
    voiceProfileError.value = userFacingError(error);
  } finally {
    voiceProfileRefreshing.value = false;
  }
}

async function copyVoiceProfilePath(): Promise<void> {
  voiceProfileCopyResult.value = "";
  try {
    await copyTextToClipboard(voiceProfilePath.value);
    voiceProfileCopyResult.value = "voice-profile.json 路径已复制";
  } catch (error) {
    voiceProfileCopyResult.value = userFacingError(error);
  }
}

async function loadPersonaMarkdown(): Promise<void> {
  const roleId = gateway.value?.agentRoleId || "";
  const fileName = gateway.value?.agentRoleFile || "persona.md";
  const requestVersion = ++personaMarkdownRequestVersion;
  personaMarkdownContent.value = "";
  personaMarkdownLoadError.value = "";
  if (!roleId) return;
  const embedded = selectedRole.value?.roleContent || runtime.value.roleInfo?.selectedRoleContent || "";
  if (embedded) {
    personaMarkdownContent.value = embedded;
    return;
  }
  personaMarkdownLoading.value = true;
  try {
    const result = await loadPersonaDocument(roleId, fileName);
    if (requestVersion === personaMarkdownRequestVersion) {
      personaMarkdownContent.value = result;
    }
  } catch (loadError) {
    if (requestVersion === personaMarkdownRequestVersion) {
      personaMarkdownLoadError.value = userFacingError(loadError);
    }
  } finally {
    if (requestVersion === personaMarkdownRequestVersion) personaMarkdownLoading.value = false;
  }
}

function clearVoiceIdentityReview(): void {
  voiceIdentitySummary.value = null;
  voiceIdentities.value = [];
  voiceIdentityError.value = "";
  voiceIdentityNotice.value = "";
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
}

async function refreshVoiceIdentityReview(observeConfirmation = false): Promise<void> {
  voiceIdentityLoaded.value = true;
  if (observeConfirmation) voiceIdentityRefreshObserveQueued = true;
  if (voiceIdentityRefreshRunning) {
    voiceIdentityRefreshQueued = true;
    return;
  }
  voiceIdentityRefreshRunning = true;
  voiceIdentityLoading.value = true;
  voiceIdentityError.value = "";
  try {
    do {
      voiceIdentityRefreshQueued = false;
      const shouldObserveConfirmation = voiceIdentityRefreshObserveQueued;
      voiceIdentityRefreshObserveQueued = false;
      const roleId = gateway.value?.agentRoleId || "";
      if (!roleId) {
        clearVoiceIdentityReview();
        break;
      }
      const now = Date.now();
      const from = new Date(now - 24 * 60 * 60 * 1_000).toISOString();
      const to = new Date(now).toISOString();
      const [summary, identities] = await Promise.all([
        personaVoiceIdentityClient.summary(roleId, from, to),
        personaVoiceIdentityClient.identities(roleId)
      ]);
      if (gateway.value?.agentRoleId !== roleId) {
        voiceIdentityRefreshQueued = true;
        continue;
      }
      voiceIdentitySummary.value = summary.summary;
      voiceIdentities.value = identities.identities;
      if (shouldObserveConfirmation) {
        voiceConfirmation.value = observePersonaVoiceConfirmation(
          voiceConfirmation.value,
          summary.summary.unresolvedVoiceprints
        );
      }
    } while (voiceIdentityRefreshQueued);
  } catch (error) {
    voiceIdentityError.value = userFacingError(error);
  } finally {
    voiceIdentityLoading.value = false;
    voiceIdentityRefreshRunning = false;
  }
}

function voiceIdentityKey(sourceHostId: string | undefined, voiceprintId: string): string {
  return personaVoiceprintEvidenceKey(sourceHostId, voiceprintId);
}

async function startVoiceConfirmation(): Promise<void> {
  if (!voiceIdentityLoaded.value) await refreshVoiceIdentityReview();
  voiceIdentityNotice.value = "";
  voiceIdentityError.value = "";
  voiceConfirmation.value = beginPersonaVoiceConfirmation(unresolvedVoiceprints.value);
}

function cancelVoiceConfirmation(): void {
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
}

function shortVoiceprint(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function shortHost(value: string | undefined): string {
  if (!value) return "缺少主机标识";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function compactDuration(value: number): string {
  const seconds = Math.max(0, Number(value) || 0);
  return `${seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10} s`;
}

function voiceIdentityLabel(identity: PersonaVoiceIdentity): string {
  if (identity.conflicted) return "有冲突";
  if (identity.isUser === true) return "这是我";
  if (identity.isUser === false) return "其他人";
  return "未判断";
}

function voiceIdentityColor(identity: PersonaVoiceIdentity): string | undefined {
  if (identity.conflicted) return "warning";
  if (identity.isUser === true) return "success";
  if (identity.isUser === false) return "secondary";
  return undefined;
}

function voiceParticipantOptions(items: IdentityParticipant[]): Array<{ title: string; value: string }> {
  return items
    .filter(item => !item.conflicted && (item.status === "confirmed" || item.status === "corrected"))
    .map(item => ({ title: item.displayName || item.id, value: item.id }));
}

function voiceParticipantName(items: IdentityParticipant[], participantId: string | undefined): string {
  if (!participantId) return "未关联身份";
  const participant = items.find(item => item.id === participantId);
  return participant?.displayName || participantId;
}

function updateIdentityParticipants(items: IdentityParticipant[]): void {
  identityParticipants.value = items;
}

function updateIdentityEndpointAccounts(items: IdentityEndpointAccount[]): void {
  identityEndpointAccounts.value = items;
}

function voiceIdentityAssignmentIssue(items: IdentityParticipant[], identity: PersonaVoiceIdentity): string {
  if (!identity.participantId) return "";
  const participant = items.find(item => item.id === identity.participantId);
  if (!participant) return "原来关联的身份已不存在，需要重新确认。";
  if (participant.conflicted) return "原来关联的身份存在冲突，需要重新确认。";
  if (participant.status === "retired") return "原来关联的身份已停用，需要重新确认。";
  if (participant.status === "candidate") return "原来关联的身份仍是候选，不能作为已识别身份。";
  return "";
}

async function openVoiceTools(): Promise<void> {
  voiceToolsDialog.value = true;
  if (!voiceIdentityLoaded.value) await refreshVoiceIdentityReview();
}

async function setVoiceIdentity(
  sourceHostId: string | undefined,
  sourceHostName: string | undefined,
  voiceprintId: string,
  isUser?: boolean | null,
  participantId?: string | null
): Promise<void> {
  const roleId = gateway.value?.agentRoleId || "";
  if (!roleId || !sourceHostId) return;
  const key = voiceIdentityKey(sourceHostId, voiceprintId);
  voiceIdentityBusyKey.value = key;
  voiceIdentityError.value = "";
  voiceIdentityNotice.value = "";
  try {
    const patch: PersonaVoiceIdentityPatch = {
      sourceHostId,
      sourceHostName,
      voiceprintId
    };
    if (isUser !== undefined) patch.isUser = isUser;
    if (participantId !== undefined) patch.participantId = participantId;
    const result = await personaVoiceIdentityClient.update(roleId, patch);
    voiceIdentityNotice.value = result.appended ? "语音消息端账号归类已更新。" : "当前人格已经是这个判断。";
    if (participantId) delete voiceParticipantSelections.value[key];
    if (voiceConfirmation.value.candidateKeys.includes(key)) cancelVoiceConfirmation();
    await refreshVoiceIdentityReview();
  } catch (error) {
    voiceIdentityError.value = userFacingError(error);
  } finally {
    voiceIdentityBusyKey.value = "";
  }
}


async function linkVoiceIdentity(
  sourceHostId: string | undefined,
  sourceHostName: string | undefined,
  voiceprintId: string
): Promise<void> {
  const key = voiceIdentityKey(sourceHostId, voiceprintId);
  const participantId = voiceParticipantSelections.value[key];
  if (!participantId) {
    voiceIdentityError.value = "请先选择要关联的身份。";
    return;
  }
  await setVoiceIdentity(sourceHostId, sourceHostName, voiceprintId, undefined, participantId);
}

async function unlinkVoiceIdentity(identity: PersonaVoiceIdentity): Promise<void> {
  await setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, undefined, null);
}

function personaSyncEventData(raw: Event): { roleId?: string; path?: string } | null {
  try {
    return JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; path?: string };
  } catch {
    return null;
  }
}

function relevantPersonaSyncEvent(raw: Event): boolean {
  const data = personaSyncEventData(raw);
  if (!data) return false;
  try {
    const roleId = gateway.value?.agentRoleId || "";
    if (!roleId || data.roleId !== roleId) return false;
    const relativePath = String(data.path || "").replace(/\\/g, "/");
    return !relativePath
      || relativePath === "voice/voice-identities.jsonl"
      || relativePath === "voice-transcripts.jsonl"
      || relativePath.startsWith("conversation/");
  } catch {
    return false;
  }
}

function startPersonaEvents(): void {
  if (managerEvents) return;
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("ready", () => {
    chatHistoryVersion.value += 1;
    if (managerEventsReady) {
      if (voiceIdentityLoaded.value) void refreshVoiceIdentityReview();
    }
    else managerEventsReady = true;
  });
  managerEvents.addEventListener("persona_voice_identity_changed", (raw) => {
    if (voiceIdentityLoaded.value && relevantPersonaSyncEvent(raw)) void refreshVoiceIdentityReview();
  });
  managerEvents.addEventListener("persona_chat_history_changed", (raw) => {
    if (personaSyncEventData(raw)?.roleId === gateway.value?.agentRoleId) chatHistoryVersion.value += 1;
  });
  managerEvents.addEventListener("identity_relation_changed", (raw) => {
    if (relevantPersonaSyncEvent(raw)) identityRelationsVersion.value += 1;
  });
  managerEvents.addEventListener("persona_sync_manifest_changed", (raw) => {
    const data = personaSyncEventData(raw);
    const roleId = gateway.value?.agentRoleId || "";
    if (roleId && (!data?.roleId || data.roleId === roleId)) identityRelationsVersion.value += 1;
    if (roleId && (!data?.roleId || data.roleId === roleId)) chatHistoryVersion.value += 1;
    if (voiceIdentityLoaded.value && relevantPersonaSyncEvent(raw)) void refreshVoiceIdentityReview();
  });
}

function updateVariableKey(oldKey: string, value: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  store.updateRouteVariable(oldKey, target?.value || oldKey, value);
}

watch(() => gateway.value?.agentRoleId, (roleId) => {
  voiceProfileCopyResult.value = "";
  voiceIdentityNotice.value = "";
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
  voiceIdentityLoaded.value = false;
  identityParticipants.value = [];
  identityEndpointAccounts.value = [];
  voiceToolsDialog.value = false;
  if (roleId) {
    void refreshVoiceProfile();
    clearVoiceIdentityReview();
  } else {
    voiceProfileError.value = "";
    clearVoiceIdentityReview();
  }
}, { immediate: true });

watch(hasPersona, (enabled) => {
  if (!enabled && ["expression", "avatar", "identity", "chat-history"].includes(activePersonaPageTab.value)) {
    activePersonaPageTab.value = "profile";
  }
});

watch(() => speech.recordsVersion, () => {
  if (hasPersona.value && voiceIdentityLoaded.value) void refreshVoiceIdentityReview(true);
});

watch(
  [() => gateway.value?.agentRoleId, () => gateway.value?.agentRoleFile, () => selectedRole.value?.roleContent],
  () => { void loadPersonaMarkdown(); },
  { immediate: true }
);

onMounted(async () => {
  releaseSpeech = await speech.acquire();
  startPersonaEvents();
});

onBeforeUnmount(() => {
  releaseSpeech?.();
  releaseSpeech = null;
  managerEvents?.close();
  managerEvents = null;
  managerEventsReady = false;
});

</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">人格配置</h1>
        <div class="page-subtitle">人格可以留空；留空时只使用消息入口默认包装和回传 API。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <template v-if="hasPersona">
          <v-btn v-for="item in personaSecondaryNavItems" :key="item.key" :to="item.to" :prepend-icon="item.icon" color="secondary" variant="tonal">{{ item.title }}</v-btn>
        </template>
        <v-btn v-if="hasPersona" prepend-icon="mdi-account-edit-outline" variant="tonal" @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')">打开人格配置</v-btn>
        <v-btn v-if="hasPersona" prepend-icon="mdi-file-code-outline" variant="tonal" @click="store.openConfigFile('role-message-config', gateway.id, gateway.agentRoleId || '')">打开人格自动化配置</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="summary-grid">
        <div class="summary-tile persona-summary-tile">
          <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="selectedRole?.avatarUrl" :size="42" />
          <div>
            <span>当前人格</span>
            <b data-no-i18n>{{ gateway.agentRoleId || "不注入人格" }}</b>
          </div>
        </div>
        <div class="summary-tile">
          <span>消息规则</span>
          <b>{{ hasPersona ? `${messageAutomations.length} 条规则` : "入口默认" }}</b>
        </div>
        <div class="summary-tile">
          <span>定时任务</span>
          <b>{{ hasPersona ? `${scheduledAutomations.length} 条任务` : "未启用" }}</b>
        </div>
        <div class="summary-tile">
          <span>{{ hasPersona ? "角色目录" : "运行模式" }}</span>
          <b :data-no-i18n="hasPersona ? '' : undefined">{{ hasPersona ? roleDirLabel : "无人格直通" }}</b>
        </div>
      </div>

      <v-card class="app-card glass-card overflow-hidden">
        <v-tabs
          v-model="activePersonaPageTab"
          class="persona-page-tabs"
          color="secondary"
          show-arrows
          :aria-label="t('人格配置分区')"
        >
          <v-tab value="profile" prepend-icon="mdi-account-card-outline">基础资料</v-tab>
          <v-tab value="expression" prepend-icon="mdi-account-voice" :disabled="!hasPersona">表达与语音</v-tab>
          <v-tab value="avatar" prepend-icon="mdi-account-box-outline" :disabled="!hasPersona">虚拟形象</v-tab>
          <v-tab value="identity" prepend-icon="mdi-account-group-outline" :disabled="!hasPersona">身份关系</v-tab>
          <v-tab value="context" prepend-icon="mdi-message-text-clock-outline">消息上下文</v-tab>
          <v-tab value="automation" prepend-icon="mdi-robot-outline">自动化</v-tab>
          <v-tab value="chat-history" prepend-icon="mdi-message-text-outline" :disabled="!hasPersona">聊天记录</v-tab>
        </v-tabs>
      </v-card>

      <v-window v-model="activePersonaPageTab" class="persona-page-window" :touch="false">
        <v-window-item value="chat-history">
          <div class="persona-tab-panel">
            <PersonaChatHistory v-if="hasPersona && activePersonaPageTab === 'chat-history'" :role-id="gateway.agentRoleId || ''" :version="chatHistoryVersion" />
          </div>
        </v-window-item>
        <v-window-item value="profile">
          <div class="persona-tab-panel">

      <div class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格配置</div>
              <div class="section-note">当前路由指向 {{ gateway.agentRoleId || "无人格直通模式" }}。</div>
            </div>
          </div>
          <div class="form-grid">
            <v-select
              :model-value="gateway.agentRoleId || ''"
              :items="roleOptions"
              label="指向人格"
              @update:model-value="value => setRole(String(value || ''))"
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps" :subtitle="item.raw.subtitle">
                  <template #prepend><PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="32" /></template>
                </v-list-item>
              </template>
              <template #selection="{ item }">
                <div class="d-flex align-center ga-2">
                  <PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="26" />
                  <span>{{ item.raw.title }}</span>
                </div>
              </template>
            </v-select>
            <v-text-field v-if="hasPersona" v-model="gateway.agentRoleFile" label="人格文件名" placeholder="persona.md" @update:model-value="store.touch" />
          </div>
          <template v-if="hasPersona">
            <div class="persona-identity-row mt-3">
              <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="selectedRole?.avatarUrl" :size="76" rounded="xl" />
              <div class="persona-identity-copy">
                <strong data-no-i18n>{{ gateway.agentRoleId }}</strong>
                <span>头像会用于人格选择、总览、语音和本地角色面板；未设置时显示人格首字。</span>
                <div class="d-flex ga-2 flex-wrap mt-2">
                  <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-image-edit-outline" :loading="avatarSaving" @click="chooseAvatar">
                    {{ selectedRole?.avatarConfigured ? "更换头像" : "设置头像" }}
                  </v-btn>
                  <v-btn v-if="selectedRole?.avatarConfigured" size="small" color="error" variant="text" prepend-icon="mdi-image-remove-outline" :disabled="avatarSaving" @click="removeAvatar">移除</v-btn>
                </div>
                <input ref="avatarInput" class="d-none" type="file" :accept="PERSONA_AVATAR_ACCEPT" @change="uploadAvatar" />
              </div>
            </div>
            <v-alert v-if="avatarError" class="mt-3" type="error" variant="tonal" density="compact">{{ avatarError }}</v-alert>
            <div class="status-row mt-3"><span>角色目录</span><b data-no-i18n>{{ roleDirLabel }}</b></div>
            <div class="status-row"><span>人格路径</span><b data-no-i18n>{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "-" }}</b></div>
          </template>
          <v-alert v-else class="mt-3" type="info" variant="tonal">
            这条路由不会注入人格、计划或记忆；RabiRoute 只把消息来源、原文和回复 API 包装后投递给 Agent。
          </v-alert>
        </v-card>

        <v-card v-if="hasPersona" class="app-card glass-card section-card persona-summary-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">persona.md 摘要</div>
              <div class="section-note" :data-no-i18n="selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath ? '' : undefined">{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "未读取到人格文件" }}</div>
            </div>
            <v-btn
              :to="personaDocumentPath"
              color="secondary"
              variant="tonal"
              prepend-icon="mdi-file-document-outline"
            >
              查看完整正文
            </v-btn>
          </div>
          <v-alert v-if="personaMarkdownError" type="error" variant="tonal">
            {{ personaMarkdownError }}
          </v-alert>
          <div v-else-if="personaMarkdownLoading" class="persona-summary-loading" aria-live="polite">
            <v-progress-circular indeterminate color="secondary" size="24" />
            <span>正在读取正文摘要…</span>
          </div>
          <div v-else-if="personaMarkdownSummary" class="persona-summary-preview" data-no-i18n>
            {{ personaMarkdownSummary }}
          </div>
          <v-alert v-else type="info" variant="tonal" density="compact">角色文件为空或尚未刷新。</v-alert>
        </v-card>
        <v-card v-else class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">默认消息包装</div>
              <div class="section-note">消息命中后会直接进入 Agent，不读取角色文件。</div>
            </div>
          </div>
          <div class="empty-state compact-empty">
            <div>
              <strong>回复必须走 RabiRoute 回传 API</strong>
              <span>Agent 会看到来源、发送者、消息目标和 `/api/agent/send`，需要发回消息端的文本都应通过该 API 投递。</span>
            </div>
          </div>
        </v-card>
      </div>

          </div>
        </v-window-item>

        <v-window-item value="expression">
          <div class="persona-tab-panel">

      <div v-if="hasPersona" class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">语言风格风控</div>
              <div class="section-note">人格外发消息默认按目标 Skill 校验。</div>
            </div>
          </div>
          <v-text-field
            :model-value="gateway.languageStyle?.styleSkillUrl || ''"
            label="目标语言风格 Skill URL"
            placeholder="file:///.../Skill 或 https://.../Skill"
            hint="可填写 Skill 目录、SKILL.md 或 references/style-data.json。留空表示不校验。"
            persistent-hint
            clearable
            @update:model-value="setLanguageStyleSkillUrl"
          />
          <v-alert class="mt-3" type="info" variant="tonal" density="compact">
            styleValidation 默认为 1。校验失败先返回原因；确认原文合适后，使用同一 deliveryId 并传 styleValidation=0。
          </v-alert>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格语音</div>
              <div class="section-note">
                TTS 模型、声线、语言、语速和发声说明统一由当前人格的 <code>voice/voice-profile.json</code> 管理。
              </div>
            </div>
            <div class="d-flex ga-2 flex-wrap">
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-refresh"
                :loading="voiceProfileRefreshing"
                @click="refreshVoiceProfile"
              >
                刷新摘要
              </v-btn>
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-account-edit-outline"
                @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')"
              >
                打开 persona.md
              </v-btn>
              <v-btn
                size="small"
                color="secondary"
                variant="tonal"
                prepend-icon="mdi-content-copy"
                @click="copyVoiceProfilePath"
              >
                复制 voice-profile 路径
              </v-btn>
              <v-btn size="small" variant="text" prepend-icon="mdi-account-voice" to="/speech">
                测试人格 TTS
              </v-btn>
            </div>
          </div>
          <v-alert v-if="voiceProfileError" type="warning" variant="tonal" density="compact" class="mb-3">
            {{ voiceProfileError }}
          </v-alert>
          <v-alert v-if="voiceProfileCopyResult" type="info" variant="tonal" density="compact" class="mb-3">
            {{ voiceProfileCopyResult }}
          </v-alert>
          <div class="persona-speech-summary">
            <div>
              <span>声线状态</span>
              <b>{{ voiceProfile ? (voiceProfile.voiceReady ? "已配置人格声线" : "使用模型默认声线") : "尚未读取" }}</b>
            </div>
            <div>
              <span>TTS 模型</span>
              <b data-no-i18n>{{ voiceProfile?.defaultModel || "未配置" }}</b>
            </div>
            <div>
              <span>语言</span>
              <b data-no-i18n>{{ voiceProfile?.language || "未配置" }}</b>
            </div>
            <div>
              <span>语速</span>
              <b>{{ voiceProfile?.speed != null ? `${voiceProfile.speed}×` : "未配置" }}</b>
            </div>
          </div>
          <v-textarea
            class="mt-3"
            :model-value="voiceProfile?.instructions || voiceProfile?.voiceStyleSummary || '未配置'"
            label="发声说明 / 表达方式"
            rows="3"
            auto-grow
            readonly
            hide-details
          />
          <v-text-field
            class="mt-3"
            :model-value="voiceProfilePath"
            label="voice-profile.json 路径"
            readonly
            hide-details
            data-no-i18n
          />
          <v-alert class="mt-3" type="info" variant="tonal" density="compact">
            <code>voice-profile.json</code> 是人格 TTS 的唯一配置入口。WebGUI 只读取安全摘要，不显示真实 voice ID 或 API key；复制路径后可直接编辑模型、声线绑定、语言、语速和发声说明。
          </v-alert>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">语音唤醒</div>
              <div class="section-note">关键词归人格所有，所有绑定该人格的语音 Route 共用。</div>
            </div>
            <v-chip
              :color="gateway.speechPushMode === 'keyword' ? 'success' : 'secondary'"
              variant="tonal"
            >
              {{ gateway.speechPushMode === "keyword" ? "当前 Route：关键词唤醒" : "当前 Route：热投递" }}
            </v-chip>
          </div>
          <v-combobox
            :model-value="gateway.speechTriggerKeywords || []"
            label="语音唤醒关键词"
            multiple
            chips
            closable-chips
            clearable
            hint="输入关键词后按 Enter。空白、重复项和大小写匹配由配置层统一归一化。"
            persistent-hint
            @update:model-value="setSpeechTriggerKeywords"
          />
          <v-alert class="mt-3" type="info" variant="tonal" density="compact">
            关闭 Route 的“热投递”后，只有 ASR 文本命中这里的关键词才提醒 Agent；所有 ASR 仍会持续记录。
          </v-alert>
          <v-alert
            v-if="gateway.speechPushMode === 'keyword' && !(gateway.speechTriggerKeywords || []).length"
            class="mt-3"
            type="warning"
            variant="tonal"
            density="compact"
          >
            当前关键词为空：转写会继续记录，但不会唤醒 Agent。建议至少加入人格名和常用称呼。
          </v-alert>
        </v-card>
      </div>

          </div>
        </v-window-item>

        <v-window-item value="avatar">
          <div class="persona-tab-panel">
            <PersonaDesktopPetPanel v-if="hasPersona" :persona-id="gateway.agentRoleId || ''" />
          </div>
        </v-window-item>

        <v-window-item value="identity">
          <div class="persona-tab-panel">

      <PersonaIdentityRelationsCard
        v-if="hasPersona"
        :role-id="gateway.agentRoleId || ''"
        :version="identityRelationsVersion"
        :voice-identities="voiceIdentities"
        :unidentified-voice-count="unidentifiedVoiceCount"
        @unlink-voice="unlinkVoiceIdentity"
        @participants-change="updateIdentityParticipants"
        @accounts-change="updateIdentityEndpointAccounts"
      >
        <template #unidentified-actions>
          <v-btn size="small" variant="text" prepend-icon="mdi-account-voice" @click="openVoiceTools">声纹工具</v-btn>
        </template>
        <template #voice-endpoint="{ participants }">
          <div class="identity-voice-channel">
            <div class="identity-channel-panel-head">
              <div><strong>待确认声纹</strong><span>声纹只显示缩写、出现情况和处理主机；关联后会进入对应的人物卡。</span></div>
              <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="voiceIdentityLoading" @click="refreshVoiceIdentityReview(true)">刷新声纹</v-btn>
            </div>
            <v-alert v-if="voiceIdentityError" type="error" variant="tonal" density="compact" class="mb-3">{{ voiceIdentityError }}</v-alert>
            <v-alert v-if="voiceIdentityNotice" type="success" variant="tonal" density="compact" class="mb-3">{{ voiceIdentityNotice }}</v-alert>
            <v-progress-linear v-if="voiceIdentityLoading" indeterminate color="secondary" class="mb-3" />

            <div class="identity-unrecognized-grid">
              <article
                v-for="item in orderedUnresolvedVoiceprints"
                :key="voiceIdentityKey(item.sourceHostId, item.voiceprintId)"
                class="identity-endpoint-card identity-voice-card"
              >
                <div class="identity-endpoint-card-main">
                  <div class="min-w-0">
                    <div class="d-flex ga-2 align-center flex-wrap">
                      <strong data-no-i18n>{{ shortVoiceprint(item.voiceprintId) }}</strong>
                      <v-chip size="x-small" :color="item.classification === 'conflict' ? 'warning' : 'secondary'" variant="tonal">{{ item.classification === "conflict" ? "有冲突" : "未判断" }}</v-chip>
                      <v-chip v-if="isPersonaVoiceConfirmationCandidate(voiceConfirmation, item)" size="x-small" color="success" variant="tonal">本次出现</v-chip>
                    </div>
                    <div class="identity-endpoint-id">{{ item.segments }} 段 · <span data-no-i18n>{{ compactDuration(item.speakerDurationSeconds) }}</span> · <span data-no-i18n>{{ item.sourceHostName || shortHost(item.sourceHostId) }}</span></div>
                    <div v-if="!item.sourceHostId" class="text-warning text-caption mt-1">旧记录缺少处理主机标识，不能建立稳定关联。</div>
                  </div>
                </div>
                <div class="identity-voice-actions">
                  <v-select v-model="voiceParticipantSelections[voiceIdentityKey(item.sourceHostId, item.voiceprintId)]" :items="voiceParticipantOptions(participants)" label="关联到身份" density="compact" hide-details :disabled="!item.sourceHostId" />
                  <v-btn size="small" color="secondary" variant="tonal" :disabled="!item.sourceHostId || !voiceParticipantSelections[voiceIdentityKey(item.sourceHostId, item.voiceprintId)]" :loading="voiceIdentityBusyKey === voiceIdentityKey(item.sourceHostId, item.voiceprintId)" @click="linkVoiceIdentity(item.sourceHostId, item.sourceHostName, item.voiceprintId)">关联</v-btn>
                  <v-btn size="small" variant="text" :disabled="!item.sourceHostId" :loading="voiceIdentityBusyKey === voiceIdentityKey(item.sourceHostId, item.voiceprintId)" @click="setVoiceIdentity(item.sourceHostId, item.sourceHostName, item.voiceprintId, true)">这是我</v-btn>
                  <v-btn size="small" variant="text" :disabled="!item.sourceHostId" :loading="voiceIdentityBusyKey === voiceIdentityKey(item.sourceHostId, item.voiceprintId)" @click="setVoiceIdentity(item.sourceHostId, item.sourceHostName, item.voiceprintId, false)">其他人</v-btn>
                </div>
              </article>

              <article v-for="identity in storedUnassignedVoiceIdentities" :key="identity.identityKey" class="identity-endpoint-card identity-voice-card">
                <div class="identity-endpoint-card-main">
                  <div class="min-w-0">
                    <div class="d-flex ga-2 align-center flex-wrap">
                      <strong data-no-i18n>{{ shortVoiceprint(identity.voiceprintId) }}</strong>
                      <v-chip size="x-small" :color="voiceIdentityColor(identity)" variant="tonal">{{ voiceIdentityLabel(identity) }}</v-chip>
                    </div>
                    <div class="identity-endpoint-id"><span data-no-i18n>{{ identity.sourceHostName || shortHost(identity.sourceHostId) }}</span><template v-if="identity.displayName"> · <span data-no-i18n>{{ identity.displayName }}</span></template></div>
                    <div v-if="voiceIdentityAssignmentIssue(participants, identity)" class="text-warning text-caption mt-1">{{ voiceIdentityAssignmentIssue(participants, identity) }}</div>
                  </div>
                </div>
                <div class="identity-voice-actions">
                  <v-select v-model="voiceParticipantSelections[voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)]" :items="voiceParticipantOptions(participants)" label="关联到身份" density="compact" hide-details />
                  <v-btn size="small" color="secondary" variant="tonal" :disabled="!voiceParticipantSelections[voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)]" :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)" @click="linkVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId)">关联</v-btn>
                  <v-btn size="small" variant="text" :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)" @click="setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, true)">这是我</v-btn>
                  <v-btn size="small" variant="text" :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)" @click="setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, false)">其他人</v-btn>
                </div>
              </article>
            </div>
          </div>
        </template>
      </PersonaIdentityRelationsCard>

      <v-dialog v-model="voiceToolsDialog" max-width="780">
        <v-card class="app-card identity-support-dialog">
          <v-card-title class="identity-dialog-title">
            <div><strong>声纹识别工具</strong><span>辅助找到待确认声纹；统计和捕获结果都不会自动判断一个人是谁。</span></div>
            <v-btn icon="mdi-close" variant="text" @click="voiceToolsDialog = false" />
          </v-card-title>
          <v-card-text>
            <div class="d-flex justify-end mb-3"><v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="voiceIdentityLoading" @click="refreshVoiceIdentityReview(true)">刷新最近 24 小时</v-btn></div>
            <v-alert v-if="voiceIdentityError" type="error" variant="tonal" density="compact" class="mb-3">{{ voiceIdentityError }}</v-alert>
            <v-alert v-if="voiceIdentityNotice" type="success" variant="tonal" density="compact" class="mb-3">{{ voiceIdentityNotice }}</v-alert>
            <v-progress-linear v-if="voiceIdentityLoading" indeterminate color="secondary" class="mb-3" />
            <div class="persona-speech-summary">
              <div><span>归类覆盖率</span><b>{{ Math.round((voiceIdentitySummary?.coverageRate || 0) * 100) }}%</b></div>
              <div><span>我的发言</span><b>{{ voiceIdentitySummary?.byClassification.user.segments || 0 }} 个分段</b><small data-no-i18n>{{ compactDuration(voiceIdentitySummary?.byClassification.user.speakerDurationSeconds || 0) }}</small></div>
              <div><span>其他人</span><b>{{ voiceIdentitySummary?.byClassification.other.segments || 0 }} 个分段</b><small data-no-i18n>{{ compactDuration(voiceIdentitySummary?.byClassification.other.speakerDurationSeconds || 0) }}</small></div>
              <div><span>未判断 / 冲突</span><b>{{ (voiceIdentitySummary?.byClassification.unknown.segments || 0) + (voiceIdentitySummary?.byClassification.conflict.segments || 0) }} 个分段</b><small data-no-i18n>{{ compactDuration((voiceIdentitySummary?.byClassification.unknown.speakerDurationSeconds || 0) + (voiceIdentitySummary?.byClassification.conflict.speakerDurationSeconds || 0)) }}</small></div>
            </div>
            <v-alert class="mt-4" :type="voiceConfirmation.status === 'found' ? 'success' : 'info'" variant="tonal" density="compact">
              <div class="d-flex justify-space-between ga-3 align-center flex-wrap">
                <div v-if="voiceConfirmation.status === 'idle'"><strong>不知道哪个声纹是自己？</strong><div>开始后，只让本人连续说一句；下一次录音会把本次新出现的未归类声纹标出来。</div></div>
                <div v-else-if="voiceConfirmation.status === 'waiting'"><strong>正在等待下一段未归类声纹</strong><div>请尽量保持环境安静，只让本人说话。系统只标记候选，不会自动确认身份。</div></div>
                <div v-else><strong>已找到 {{ voiceConfirmationCandidateCount }} 个本次候选</strong><div>返回“未识别身份”的声纹分类，只确认你能确定的项。</div></div>
                <div class="d-flex ga-2 flex-wrap">
                  <v-btn v-if="voiceConfirmation.status !== 'waiting'" size="small" color="secondary" variant="tonal" prepend-icon="mdi-account-voice" @click="startVoiceConfirmation">{{ voiceConfirmation.status === "found" ? "重新捕获" : "标记下一段" }}</v-btn>
                  <v-btn v-if="voiceConfirmation.status !== 'idle'" size="small" variant="text" @click="cancelVoiceConfirmation">取消</v-btn>
                </div>
              </div>
            </v-alert>
            <div class="section-note mt-3">页面只读取统计、声纹缩写和人格关系，不读取或展示转写正文。</div>
          </v-card-text>
        </v-card>
      </v-dialog>

          </div>
        </v-window-item>

        <v-window-item value="context">
          <div class="persona-tab-panel">

      <v-card v-if="hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">最近消息上下文</div>
            <div class="section-note">分别控制每个消息端自动注入给当前人格的最近消息数量。</div>
          </div>
          <v-chip color="secondary" variant="tonal">
            默认 {{ DEFAULT_RECENT_MESSAGE_LIMIT }} · 上限 {{ MAX_RECENT_MESSAGE_LIMIT }}
          </v-chip>
        </div>
        <v-alert type="info" variant="tonal" density="compact" class="mb-3">
          设为 0 只停止把该消息端历史自动注入 Agent，不会删除已有消息记录或审计数据。
        </v-alert>
        <div class="rule-list">
          <SpeechParameterSlider
            v-for="endpoint in recentMessageEndpoints"
            :key="endpoint"
            :label="adapterLabel(endpoint)"
            :min="0"
            :max="MAX_RECENT_MESSAGE_LIMIT"
            :step="1"
            suffix="条"
            :hint="`0 表示不注入 ${adapterLabel(endpoint)} 历史；未单独设置时使用 ${DEFAULT_RECENT_MESSAGE_LIMIT} 条。`"
            :model-value="recentMessageLimitFor(endpoint)"
            @update:model-value="value => setRecentMessageLimit(endpoint, value)"
          />
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">路由变量</div>
            <div class="section-note">变量会在规则匹配前按字面量替换，用于昵称、关键词或项目别名。</div>
          </div>
          <v-btn color="secondary" variant="tonal" prepend-icon="mdi-plus" @click="store.addRouteVariable">新增变量</v-btn>
        </div>
        <div v-if="variableEntries.length === 0" class="empty-state">
          <div>
            <strong>暂无自定义路由变量</strong>
            <span>需要给群名、项目名或关键词做别名时，再新增变量。</span>
          </div>
        </div>
        <div v-else class="form-grid">
          <template v-for="[key, value] in variableEntries" :key="key">
            <v-text-field :model-value="key" label="变量名" @change="updateVariableKey(key, value, $event)" />
            <div class="d-flex ga-2 variable-value-row">
              <v-text-field class="flex-grow-1" :model-value="value" label="变量值" @update:model-value="next => store.updateRouteVariable(key, key, String(next || ''))" />
              <v-btn icon="mdi-delete" color="error" variant="text" @click="store.removeRouteVariable(key)" />
            </div>
          </template>
        </div>
      </v-card>

          </div>
        </v-window-item>

        <v-window-item value="automation">
          <div class="persona-tab-panel">

      <v-card v-if="!hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">默认消息规则</div>
            <div class="section-note">无人格模式按已启用消息入口生成默认命中规则。</div>
          </div>
          <v-chip color="secondary" variant="tonal">入口默认</v-chip>
        </div>
        <div class="rule-list">
          <div v-for="rule in rules" :key="rule.id" class="rule-card">
            <div class="font-weight-bold text-primary" data-no-i18n>{{ rule.name }}</div>
            <div class="section-note">{{ routeKindSummary(rule) }}</div>
          </div>
        </div>
      </v-card>

      <v-card v-if="hasPersona" class="app-card glass-card section-card automation-workspace">
        <div class="section-title-row automation-workspace-head">
          <div>
            <div class="section-title">人格自动化</div>
            <div class="section-note">先选择什么时候触发，再选择通知 Agent 或运行脚本。</div>
          </div>
          <v-chip color="secondary" variant="tonal">{{ automations.length }} 条规则</v-chip>
        </div>

        <v-tabs v-model="automationWorkspaceTab" class="automation-tabs" color="secondary" grow>
          <v-tab value="messages" prepend-icon="mdi-message-processing-outline">接收消息</v-tab>
          <v-tab value="schedule" prepend-icon="mdi-calendar-clock-outline">定制任务</v-tab>
          <v-tab value="hooks" prepend-icon="mdi-hook">Agent Hook</v-tab>
        </v-tabs>

        <v-window v-model="automationWorkspaceTab" class="automation-window">
          <v-window-item value="messages">
            <div class="automation-toolbar">
              <div>
                <strong>收到哪些消息后做什么</strong>
                <span>规则按消息来源分组；只有选中的条件和动作参数会显示。</span>
              </div>
              <v-menu>
                <template #activator="{ props }">
                  <v-btn v-bind="props" color="secondary" variant="tonal" prepend-icon="mdi-plus">新增消息规则</v-btn>
                </template>
                <v-list>
                  <v-list-item
                    v-for="option in actionTypeOptions"
                    :key="option.value"
                    :prepend-icon="option.icon"
                    :title="option.title"
                    :subtitle="option.note"
                    @click="createAutomation('message', option.value)"
                  />
                </v-list>
              </v-menu>
            </div>

            <div v-if="messageAutomations.length === 0" class="empty-state">
              <div>
                <strong>还没有消息规则</strong>
                <span>新增后，可以把指定消息交给 Agent，也可以运行人格脚本。</span>
              </div>
            </div>
            <div v-else class="automation-groups">
              <section v-for="group in messageAutomationGroups" :key="group.key" class="automation-group">
                <div class="automation-group-head">
                  <div>
                    <strong>{{ group.title }}</strong>
                    <span>{{ group.note }}</span>
                  </div>
                  <v-chip size="small" variant="tonal">{{ group.items.length }}</v-chip>
                </div>
                <div class="automation-card-grid">
                  <button
                    v-for="rule in group.items"
                    :key="rule.id"
                    type="button"
                    class="automation-card"
                    :class="{ disabled: rule.enabled === false, warning: automationDiagnostics(rule).length > 0 }"
                    @click="openAutomation(rule.id)"
                  >
                    <span class="automation-card-topline">
                      <strong data-no-i18n>{{ rule.name || rule.id }}</strong>
                      <v-chip size="x-small" :color="automationActionColor(rule)" variant="tonal">{{ automationActionLabel(rule) }}</v-chip>
                    </span>
                    <span class="automation-card-source">{{ automationSourceSummary(rule) }}</span>
                    <span class="automation-card-action">{{ automationActionSummary(rule) }}</span>
                    <span v-if="automationDiagnostics(rule).length" class="automation-card-warning">
                      <v-icon size="16">mdi-alert-circle-outline</v-icon>
                      {{ automationDiagnostics(rule)[0] }}
                    </span>
                  </button>
                </div>
              </section>
            </div>
          </v-window-item>

          <v-window-item value="schedule">
            <div class="automation-toolbar">
              <div>
                <strong>按时间自动运行</strong>
                <span>支持固定间隔、每天某时和一次性日期时间。</span>
              </div>
              <v-menu>
                <template #activator="{ props }">
                  <v-btn v-bind="props" color="secondary" variant="tonal" prepend-icon="mdi-plus">新增定时任务</v-btn>
                </template>
                <v-list>
                  <v-list-item
                    v-for="option in actionTypeOptions"
                    :key="option.value"
                    :prepend-icon="option.icon"
                    :title="option.title"
                    :subtitle="option.note"
                    @click="createAutomation('schedule', option.value)"
                  />
                </v-list>
              </v-menu>
            </div>

            <v-alert v-if="!timerInputEnabled" type="warning" variant="tonal" density="compact" class="mb-4">
              <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
                <span>当前 Route 没有启用定时任务入口，保存任务后也不会自动运行。</span>
                <v-btn size="small" color="warning" variant="tonal" @click="enableTimerInput">启用定时任务</v-btn>
              </div>
            </v-alert>

            <div v-if="scheduledAutomations.length === 0" class="empty-state">
              <div>
                <strong>还没有定时任务</strong>
                <span>新增后，RabiRoute 会在本机时间到达时通知 Agent 或运行脚本。</span>
              </div>
            </div>
            <div v-else class="automation-card-grid scheduled-grid">
              <button
                v-for="rule in scheduledAutomations"
                :key="rule.id"
                type="button"
                class="automation-card scheduled-card"
                :class="{ disabled: rule.enabled === false, warning: automationDiagnostics(rule).length > 0 }"
                @click="openAutomation(rule.id)"
              >
                <span class="automation-card-topline">
                  <strong data-no-i18n>{{ rule.name || rule.id }}</strong>
                  <v-chip size="x-small" :color="automationActionColor(rule)" variant="tonal">{{ automationActionLabel(rule) }}</v-chip>
                </span>
                <span class="automation-schedule-line">
                  <v-icon size="18">mdi-clock-outline</v-icon>
                  {{ automationSourceSummary(rule) }}
                </span>
                <span class="automation-card-action">{{ automationActionSummary(rule) }}</span>
                <span v-if="automationDiagnostics(rule).length" class="automation-card-warning">
                  <v-icon size="16">mdi-alert-circle-outline</v-icon>
                  {{ automationDiagnostics(rule)[0] }}
                </span>
              </button>
            </div>
          </v-window-item>
          <v-window-item value="hooks">
                  <div class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">Agent Hook</div>
                        <div class="section-note">统一管理当前人格的 Hook。首次使用时，在 Agent 端点击“更新 Hook 到 Agent”安装事件埋点。</div>
                      </div>
                    </div>
                    <div class="catalog-param-grid mt-2">
                      <div class="full-span">
                        <v-switch
                          :model-value="codexHookEnabled('sessionContextEnabled')"
                          color="primary"
                          density="compact"
                          hide-details
                          label="会话入口上下文"
                          @update:model-value="value => setCodexHookSetting('sessionContextEnabled', value)"
                        />
                        <div class="section-note">打开、恢复、清空或压缩 Agent 会话，以及用户提交新消息时触发。Hook：<code>SessionStart</code> / <code>UserPromptSubmit</code>。</div>
                      </div>
                      <div class="full-span">
                        <v-switch
                          :model-value="codexHookEnabled('reasoningContextEnabled')"
                          color="primary"
                          density="compact"
                          hide-details
                          label="推理期上下文刷新"
                          @update:model-value="value => setCodexHookSetting('reasoningContextEnabled', value)"
                        />
                        <div class="section-note">Agent 调用工具前后触发，只注入本轮新命中的计划、记忆或技能上下文。Hook：<code>PreToolUse</code> / <code>PostToolUse</code>。</div>
                      </div>
                      <div class="full-span">
                        <v-switch
                          :model-value="codexHookEnabled('planTaskCompletionEnabled')"
                          color="primary"
                          density="compact"
                          hide-details
                          label="计划任务会话完成通知"
                          @update:model-value="value => setCodexHookSetting('planTaskCompletionEnabled', value)"
                        />
                        <div class="section-note">绑定计划的执行任务输出本轮最终回答后触发，经 Rabi 投递到该人格 Route 绑定的会话。Hook：<code>Stop</code>；默认开启。</div>
                      </div>
                      <div class="full-span">
                        <v-switch
                          :model-value="codexHookEnabled('agentCommunicationEnforcementEnabled')"
                          color="primary"
                          density="compact"
                          hide-details
                          label="强制使用 RabiAgent 消息投递接口"
                          @update:model-value="value => setCodexHookSetting('agentCommunicationEnforcementEnabled', value)"
                        />
                        <div class="section-note">开启后，本 Route 的主人格、计划 Agent、计划秘书和消息处理 Agent 不能绕过 Rabi 直接操作其它持久 Agent 会话。通过 Rabi 投递时，发送方必须明确是否要求回复；要求回复后，目标 Agent 每轮结束仍未正式回复，Manager 会在五分钟后提醒。Hook：<code>PreToolUse</code> / <code>Stop</code>；默认开启。</div>
                      </div>
                      <div class="full-span">
                        <v-switch
                          :model-value="gateway.codexHooks?.onlyPrimaryPersonaCanSendMessages === true"
                          color="warning"
                          density="compact"
                          hide-details
                          label="仅允许主人格发送消息"
                          @update:model-value="value => setCodexHookSetting('onlyPrimaryPersonaCanSendMessages', value)"
                        />
                        <div class="section-note">默认关闭。开启后只有当前绑定的 主人格会话可发送；计划 Agent、计划秘书和消息处理 Agent 会被拒绝。</div>
                      </div>
                    </div>
                  </div>
            <PlanFollowupSettings :model-value="gateway.codexHooks?.planFollowup" :role-id="gateway.agentRoleId || ''"
              @update:model-value="setPlanFollowup" />
            <AgentCompletionDeliveryRules :model-value="gateway.codexHooks?.completionDeliveries ?? []"
              :gateways="store.gateways" @update:model-value="setCompletionDeliveries" />
          </v-window-item>
        </v-window>
      </v-card>

      <div>
        <v-btn variant="text" prepend-icon="mdi-code-braces" @click="templateVariablesDialog = true">可用模板变量</v-btn>
      </div>

          </div>
        </v-window-item>
      </v-window>
    </template>

    <v-dialog v-model="templateVariablesDialog" max-width="760" scrollable aria-labelledby="template-variables-title">
      <v-card>
        <v-card-title id="template-variables-title">可用模板变量</v-card-title>
        <v-card-text>
          <div class="section-note mb-4">模板中用 `{变量名}` 引用。</div>
          <div class="template-vars">
            <div v-for="item in templateVars" :key="item.name" class="template-var">
              <code>{ {{ item.name }} }</code>
              <span>{{ item.description }}</span>
            </div>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="templateVariablesDialog = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="automationDialog" max-width="1040" class="editor-dialog">
      <v-card v-if="activeAutomation && gateway" class="app-card editor-dialog-card automation-editor">
        <v-card-title class="automation-editor-head">
          <div>
            <div class="section-title">自动化规则</div>
            <div class="section-note" data-no-i18n>{{ gateway.agentRoleId }} · {{ activeAutomation.id }}</div>
          </div>
          <div class="rule-dialog-actions">
            <v-switch
              v-if="activeAutomation.id !== 'role-panel-message'"
              :model-value="activeAutomation.enabled !== false"
              label="启用"
              color="success"
              inset
              hide-details
              @update:model-value="value => patchAutomation({ enabled: Boolean(value) })"
            />
            <v-btn icon="mdi-close" variant="text" @click="automationDialog = false" />
          </div>
        </v-card-title>

        <v-card-text>
          <v-alert v-if="automationDiagnostics(activeAutomation).length" type="warning" variant="tonal" density="compact" class="mb-4">
            <div v-for="issue in automationDiagnostics(activeAutomation)" :key="issue">{{ issue }}</div>
          </v-alert>

          <div class="automation-editor-section identity-section">
            <span class="automation-step-number">1</span>
            <div class="automation-editor-section-body">
              <div class="automation-section-heading">
                <strong>这条规则叫什么</strong>
                <span>名称只用于在列表、日志和排障时辨认。</span>
              </div>
              <v-text-field
                :model-value="activeAutomation.name"
                label="规则名称"
                @update:model-value="value => patchAutomation({ name: String(value || '') })"
              />
            </div>
          </div>

          <div class="automation-editor-section">
            <span class="automation-step-number">2</span>
            <div class="automation-editor-section-body">
              <div class="automation-section-heading">
                <strong>什么时候触发</strong>
                <span>切换类型后，只显示这一类触发条件需要的参数。</span>
              </div>
              <v-btn-toggle
                :model-value="activeAutomation.trigger.type"
                color="secondary"
                mandatory
                divided
                class="automation-type-toggle"
                @update:model-value="value => setAutomationTriggerType(value === 'schedule' ? 'schedule' : 'message')"
              >
                <v-btn value="message" prepend-icon="mdi-message-processing-outline">收到消息</v-btn>
                <v-btn value="schedule" prepend-icon="mdi-calendar-clock-outline">到达时间</v-btn>
              </v-btn-toggle>

              <template v-if="activeAutomation.trigger.type === 'message'">
                <div class="config-toolbar mt-4">
                  <v-text-field
                    v-model="routeKindQuery"
                    density="compact"
                    prepend-inner-icon="mdi-magnify"
                    label="搜索消息来源"
                    hide-details
                    clearable
                  />
                  <v-chip size="small" color="secondary" variant="tonal">已选 {{ activeAutomation.trigger.routeKinds?.length || 0 }}</v-chip>
                </div>
                <div class="route-kind-catalog compact-catalog">
                  <section v-for="definition in visibleRouteKindDefinitions" :key="definition.adapter" class="catalog-section">
                    <div class="catalog-section-head">
                      <div>
                        <div class="catalog-section-title">{{ definition.title }}</div>
                        <div class="section-note">{{ definition.note }}</div>
                      </div>
                    </div>
                    <div v-for="group in definition.groups" :key="group.title" class="route-kind-group">
                      <div class="route-kind-group-head"><span>{{ group.title }}</span></div>
                      <div class="route-kind-chip-grid">
                        <button
                          v-for="kind in group.routeKinds"
                          :key="kind"
                          class="route-kind-chip"
                          :class="{ active: activeAutomation.trigger.routeKinds?.includes(kind) }"
                          type="button"
                          @click="toggleAutomationRouteKind(kind)"
                        >
                          <v-icon size="18">{{ activeAutomation.trigger.routeKinds?.includes(kind) ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                          <span>{{ routeKindLabels[kind] || kind }}</span>
                          <code>{{ kind }}</code>
                        </button>
                      </div>
                    </div>
                  </section>
                </div>

                <div class="automation-subsection">
                  <div class="automation-section-heading compact-heading">
                    <strong>进一步筛选（可选）</strong>
                    <span>不填写时，只按上面选择的消息来源判断。</span>
                  </div>
                  <div class="form-grid">
                    <v-text-field
                      :model-value="activeAutomation.trigger.regex"
                      label="消息包含或匹配"
                      placeholder="例如：需求|报错|构建失败"
                      @update:model-value="value => patchAutomationMessageTrigger({ regex: String(value || '') })"
                    />
                    <v-text-field
                      v-if="(activeAutomation.trigger.routeKinds || []).some(kind => ['group_message', 'direct_at', 'direct_reply', 'indirect_reply', 'wecom_message', 'feishu_message'].includes(kind))"
                      :model-value="activeAutomation.trigger.targetGroupId"
                      label="只限这个群"
                      placeholder="留空表示不限群"
                      @update:model-value="value => patchAutomationMessageTrigger({ targetGroupId: String(value || '') })"
                    />
                    <v-combobox
                      v-if="activeAutomation.trigger.routeKinds?.includes('voice_transcript')"
                      class="full-span"
                      :model-value="activeAutomation.trigger.allowedSpeakerNames || []"
                      label="只限这些说话人"
                      chips
                      multiple
                      closable-chips
                      @update:model-value="value => patchAutomationMessageTrigger({ allowedSpeakerNames: Array.isArray(value) ? value.map(String) : [] })"
                    />
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="form-grid mt-4">
                  <v-select
                    :model-value="activeAutomation.trigger.schedule.type"
                    :items="scheduleTypeOptions"
                    label="时间类型"
                    @update:model-value="value => setAutomationScheduleType(String(value || 'interval'))"
                  />
                  <template v-if="activeAutomation.trigger.schedule.type === 'interval'">
                    <v-text-field
                      :model-value="activeAutomation.trigger.schedule.intervalSeconds"
                      type="number"
                      min="1"
                      step="1"
                      label="间隔秒数"
                      @update:model-value="value => patchAutomationSchedule({ intervalSeconds: Number(value || 900) })"
                    />
                    <v-text-field
                      :model-value="activeAutomation.trigger.schedule.windowStartTime"
                      label="每天从几点开始（可选）"
                      placeholder="09:30"
                      @update:model-value="value => patchAutomationSchedule({ windowStartTime: String(value || '') })"
                    />
                    <v-text-field
                      :model-value="activeAutomation.trigger.schedule.windowEndTime"
                      label="每天到几点结束（可选）"
                      placeholder="19:00"
                      @update:model-value="value => patchAutomationSchedule({ windowEndTime: String(value || '') })"
                    />
                  </template>
                  <v-text-field
                    v-else-if="activeAutomation.trigger.schedule.type === 'daily_time'"
                    :model-value="activeAutomation.trigger.schedule.timeOfDay"
                    type="time"
                    label="每天执行时间"
                    @update:model-value="value => patchAutomationSchedule({ timeOfDay: String(value || '') })"
                  />
                  <v-text-field
                    v-else
                    :model-value="activeAutomation.trigger.schedule.onceAt"
                    type="datetime-local"
                    label="执行日期和时间"
                    @update:model-value="value => patchAutomationSchedule({ onceAt: String(value || '') })"
                  />
                </div>
                <v-alert v-if="!timerInputEnabled" type="warning" variant="tonal" density="compact" class="mt-3">
                  <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
                    <span>当前 Route 还没有启用定时任务入口。</span>
                    <v-btn size="small" color="warning" variant="tonal" @click="enableTimerInput">现在启用</v-btn>
                  </div>
                </v-alert>
              </template>
            </div>
          </div>

          <div class="automation-editor-section">
            <span class="automation-step-number">3</span>
            <div class="automation-editor-section-body">
              <div class="automation-section-heading">
                <strong>触发后做什么</strong>
                <span>Agent 投递和脚本执行分别记录结果，互不冒充成功。</span>
              </div>
              <v-btn-toggle
                :model-value="activeAutomation.action.type"
                color="secondary"
                mandatory
                divided
                class="automation-type-toggle"
                @update:model-value="value => setAutomationActionType(value === 'run_script' ? 'run_script' : 'deliver_agent')"
              >
                <v-btn value="deliver_agent" prepend-icon="mdi-message-arrow-right-outline">通知 Agent</v-btn>
                <v-btn value="run_script" prepend-icon="mdi-console-line">运行脚本</v-btn>
              </v-btn-toggle>

              <template v-if="activeAutomation.action.type === 'deliver_agent'">
                <v-textarea
                  v-if="activeAutomation.trigger.type === 'schedule'"
                  class="mt-4"
                  :model-value="activeAutomation.action.message"
                  label="到时间后交给 Agent 的任务"
                  placeholder="例如：检查今天仍未完成的计划，并只报告新增阻塞。"
                  rows="4"
                  auto-grow
                  @update:model-value="value => patchAutomationAction({ message: String(value || '') })"
                />
                <v-textarea
                  class="mt-4"
                  :model-value="activeAutomation.action.template"
                  :label="activeAutomation.trigger.type === 'message' ? '给 Agent 的附加说明（可选）' : '额外处理要求（可选）'"
                  placeholder="RabiRoute 已经附带消息来源、原文、人格路径和必要上下文；这里只写额外判断要求。"
                  rows="7"
                  auto-grow
                  spellcheck="false"
                  @update:model-value="value => patchAutomationAction({ template: String(value || '') })"
                />
              </template>

              <template v-else>
                <v-alert type="warning" variant="tonal" density="compact" class="mt-4 mb-4">
                  脚本只能来自当前人格的 <code>scripts/</code> 目录，支持 .cmd、.bat 和 .py。不会执行任意命令文本，也不会把 Manager 中的 token 和密码传给脚本。
                </v-alert>
                <div class="form-grid">
                  <v-text-field
                    :model-value="activeAutomation.action.scriptPath"
                    label="脚本相对路径"
                    placeholder="daily-check.py 或 scripts/daily-check.py"
                    @update:model-value="value => patchAutomationAction({ scriptPath: String(value || '') })"
                  />
                  <v-text-field
                    :model-value="activeAutomation.action.timeoutSeconds"
                    type="number"
                    min="5"
                    max="3600"
                    label="最长运行秒数"
                    @update:model-value="value => patchAutomationAction({ timeoutSeconds: Number(value || 300) })"
                  />
                  <v-textarea
                    class="full-span"
                    :model-value="scriptArgumentsText(activeAutomation)"
                    label="脚本参数（每行一个）"
                    rows="3"
                    @update:model-value="setScriptArguments"
                  />
                </div>
                <div class="script-permission-row">
                  <div>
                    <strong>允许当前 Route 运行人格脚本</strong>
                    <span>这是本机 Route 的权限，不会跟随人格同步到其他电脑。</span>
                  </div>
                  <v-switch
                    :model-value="gateway.personaAutomationScriptsEnabled === true"
                    color="warning"
                    inset
                    hide-details
                    @update:model-value="value => setScriptExecutionEnabled(Boolean(value))"
                  />
                </div>
              </template>
            </div>
          </div>
        </v-card-text>

        <v-card-actions class="px-6 pb-5">
          <v-btn
            v-if="activeAutomation.id !== 'role-panel-message'"
            color="error"
            variant="text"
            @click="store.removeAutomation(activeAutomation.id); automationDialog = false"
          >删除规则</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="automationDialog = false">完成</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.persona-page-tabs {
  min-height: 56px;
  border-bottom: 1px solid var(--rr-border-faint);
  background: var(--rr-subtle);
}

.persona-page-tabs :deep(.v-tab) {
  min-width: 168px;
  min-height: 56px;
  font-weight: 850;
  letter-spacing: 0;
  text-transform: none;
}

.persona-page-window,
.persona-page-window :deep(.v-window__container) {
  overflow: visible;
}

.persona-tab-panel {
  display: grid;
  gap: 18px;
  min-width: 0;
}

@media (max-width: 600px) {
  .persona-page-tabs :deep(.v-tab) {
    min-width: 144px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .persona-page-window :deep(.v-window-item) {
    transition: none !important;
  }
}
</style>
