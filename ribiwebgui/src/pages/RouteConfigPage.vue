<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { useSpeechStore } from "../stores/speechStore";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import TrustedWebRendererHost from "../components/TrustedWebRendererHost.vue";
import { managerEventSource } from "../managerApi";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { webRenderersAt } from "../pluginRenderers";
import { hotDeliveryEnabled, speechPushModeForHotDelivery } from "../speech/speechDeliveryMode";
import type { MessageAdapterType, MessageEndpointType, AgentAdapterType, AgentDeliveryTestResult, AgentMaturity, AgentScanResult, AgentScanSession, CodexHookSettings, MessageAdapterScanResult, NapCatInstance } from "../types";
import { codexModelPickerItems, dshModelPickerItems, dshModelValue, parseDshModelValue, reasoningEffortPickerItems } from "../agentModelPicker";
import { adapterDefaultWebhookPath, adapterLabel, adapterRuntimeKey, adapterSourceAliases, adapterErrorsFor, applyAdapterDefaults, configNameFor, gatewayAdapterTypes, isAdapterDisabled, isMessageInputsDisabled, isWebhookLikeAdapter, adapterConfigPathFor, messageAdapterPolicyFor, setGatewayAdapters, setMessageAdapterPolicy, toggleAdapterDisabled } from "../utils/gatewayHelpers";
import { initializeAgentSessionForRoute } from "@shared/codexSessionInitialization";
import { codexThreadItems, selectCodexThread, type CodexThreadSummary } from "@shared/codexThreadSelection";
import { DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL, codexMemoryConsolidationAgentTitle } from "@shared/codexMemoryConsolidationAgent";
import { agentAdapterSupportsManagedTaskFeature, primaryMessageProcessingAgentEnabled, DEFAULT_CODEX_HOOK_SETTINGS, DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL, DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT, MAX_MESSAGE_PROCESSING_AGENTS, messageAdapterUsesAutomaticGrouping, resolvePrimaryAgentAdapter } from "@shared/gatewayConfigModel";
import {
  DEFAULT_CODEX_PLAN_ASSISTANT_MODEL,
  codexPlanAssistantInitializationPrompt,
  codexPlanAssistantSessionTitles,
  normalizeCodexPlanAssistantCount,
  planAssistantSessionAgentAdapter
} from "@shared/codexPlanAssistantSessions";
import { applySpeechRouteVariableDefaults } from "@shared/speechControlContract";
import { copyTextToClipboard } from "../clipboard";
import { routeScopedAdaptersPath, routeScopedRuntimePath } from "../routeScopedNavigation";

const MessageProcessingBoard = defineAsyncComponent(() => import("../components/MessageProcessingBoard.vue"));

const messageEndpointSettingsRenderers = computed(() => webRenderersAt(
  pluginCatalogStore.settingsRenderers.value,
  "route.adapters.message-endpoint-settings"
));

function settingsRenderersForMessageEndpoint(type: MessageAdapterType) {
  return messageEndpointSettingsRenderers.value.filter(renderer => renderer.slot === type);
}

const store = useGatewayStore();
const speech = useSpeechStore();
const route = useRoute();
const router = useRouter();
const messageProcessingBoardOpen = ref(false);
const channelCheckDialogOpen = ref(false);
const agentDeliveryTest = ref<{ loading: AgentAdapterType | null; result: AgentDeliveryTestResult | null; error: string }>({
  loading: null,
  result: null,
  error: ""
});
const runtime = computed(() => store.selectedRuntime);
const personaAvatarUrl = computed(() => (runtime.value.roleInfo?.options || [])
  .find(option => option.value === store.selectedGateway?.agentRoleId)?.avatarUrl || "");
const speechDefaultVariables = applySpeechRouteVariableDefaults(undefined);
const speechAdapterActionBusy = ref(false);
const speechAdapterActionError = ref("");
const weixinLoginBusy = ref(false);
const weixinLoginError = ref("");
let speechConfigSaveTimer = 0;
const adapterQuery = ref("");
const configNameError = ref("");
const codexBinding = ref({ loading: false, error: "", pending: false });
const managedAgentSessionAction = ref({ loading: false, message: "", error: "" });
const codexPlanAssistants = ref({ count: 1, loading: false, message: "", error: "" });
const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  agents: {} as Partial<Record<AgentAdapterType, AgentScanResult>>,
  loading: false,
});
const dshScanLoading = ref(false);
const dshScanRevision = ref(0);

const codexModelItems = computed(() => codexModelPickerItems(agentScan.value.agents.codex?.models ?? []));
const codexReasoningEffortItems = computed(() => {
  const discovered = reasoningEffortPickerItems(
    agentScan.value.agents.codex?.models ?? [],
    store.selectedGateway?.agentModel
  );
  return discovered.length > 0 ? discovered : ["low", "medium", "high", "xhigh", "max"];
});
const dshModelItems = computed(() => dshModelPickerItems(agentScan.value.agents.dsh?.models ?? []));
const configuredDshModelValue = computed(() => dshModelValue(
  store.selectedGateway?.dshModelProvider,
  store.selectedGateway?.dshModel
));
const dshReasoningEffortItems = computed(() => reasoningEffortPickerItems(
  agentScan.value.agents.dsh?.models ?? [],
  store.selectedGateway?.dshModel,
  store.selectedGateway?.dshModelProvider
));

function selectCodexModel(value: unknown): void {
  if (!store.selectedGateway) return;
  store.selectedGateway.agentModel = String(value || "").trim();
  const selected = agentScan.value.agents.codex?.models?.find(model => model.id === store.selectedGateway?.agentModel);
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!store.selectedGateway.agentReasoningEffort || !efforts.includes(store.selectedGateway.agentReasoningEffort))) {
    store.selectedGateway.agentReasoningEffort = selected.defaultReasoningEffort as typeof store.selectedGateway.agentReasoningEffort;
  }
  touch();
}

function selectDshModel(value: unknown): void {
  if (!store.selectedGateway) return;
  const parsed = parseDshModelValue(value, agentScan.value.agents.dsh?.models ?? []);
  store.selectedGateway.dshModelProvider = parsed.provider;
  store.selectedGateway.dshModel = parsed.model;
  const selected = agentScan.value.agents.dsh?.models?.find(model => (
    model.provider === parsed.provider && model.id === parsed.model
  ));
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!store.selectedGateway.dshReasoningEffort || !efforts.includes(store.selectedGateway.dshReasoningEffort))) {
    store.selectedGateway.dshReasoningEffort = selected.defaultReasoningEffort || "";
  }
  touch();
}

const messageAdapterScan = ref({
  adapters: {} as Partial<Record<MessageAdapterType, MessageAdapterScanResult>>,
  loading: false,
  error: "",
  overall: null as null | { state: "healthy" | "degraded" | "unknown"; message: string },
  partial: false,
  durationMs: 0,
  checkedAt: ""
});
type RemoteAgentDeviceStatus = {
  deviceId: string;
  deviceName?: string;
  agentType?: string;
  os?: string;
  osVersion?: string;
  arch?: string;
  declaredIp?: string;
  observedIp?: string;
  host?: string;
  port?: number;
  controlUrl?: string;
  discoveryPort?: number;
  protocolVersion?: number;
  defaultCwd?: string;
  defaultThreadName?: string;
  connected?: boolean;
  passwordSaved?: boolean;
  connectionError?: string;
  discoveredAt?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  lastTaskAt?: string;
};
const remoteAgentDevices = ref<RemoteAgentDeviceStatus[]>([]);
const remoteAgentDevicesLoading = ref(false);
const remoteAgentConnecting = ref(false);
const remoteAgentPassword = ref("");
const remoteAgentConnectResult = ref<{ ok: boolean; message: string } | null>(null);
const remoteAgentDeviceError = ref("");
const remoteAgentDeviceMenu = ref(false);
const repairingNapcatAll = ref(false);
const napcatAutoSteps = ref<Record<string, { ok?: boolean; message: string; steps: string[] }>>({});

type NapCatAccountRow = {
  key: string;
  instance: NapCatInstance;
  endpointLabel: string;
  endpointHealthy?: boolean;
  source: "scan" | "configured" | "runtime" | "discovered";
};

type NapcatLoginMode = "quick" | "password" | "qrcode";

type NapcatLoginPanelData = {
  ok?: boolean;
  state?: "logged-in" | "offline" | "account-mismatch" | "login-required";
  loggedIn?: boolean;
  offline?: boolean;
  expectedUserId?: string;
  currentAccount?: { userId?: string; nickname?: string; online?: boolean; avatarUrl?: string } | null;
  quickAccounts?: Array<{
    userId: string;
    nickname?: string;
    avatarUrl?: string;
    savedLogin?: boolean;
    quickLoginAvailable?: boolean;
  }>;
  qrCodeDataUrl?: string;
  loginError?: string;
  warnings?: string[];
  message?: string;
};

type NapcatLoginUiState = {
  visible: boolean;
  loading: boolean;
  busy: boolean;
  mode: NapcatLoginMode;
  quickUserId: string;
  userId: string;
  password: string;
  message: string;
  error: string;
  panel: NapcatLoginPanelData | null;
  captcha: { proofWaterUrl: string } | null;
  newDevice: {
    jumpUrl: string;
    newDevicePullQrCodeSig: string;
    qrCodeDataUrl: string;
    bytesToken: string;
    status: "loading" | "waiting" | "scanned" | "confirmed" | "error";
  } | null;
};

type NapCatScanHealthEntry = Record<string, any> & {
  gatewayName?: string;
  instanceName?: string;
};

async function runMessageAdapterScan(): Promise<void> {
  if (messageAdapterScan.value.loading) return;
  messageAdapterScan.value.loading = true;
  messageAdapterScan.value.error = "";
  try {
    const params = new URLSearchParams();
    if (gateway.value?.id) params.set("gatewayId", gateway.value.id);
    const res = await fetch(`/api/scan/message-adapters${params.toString() ? `?${params}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `消息端扫描失败（HTTP ${res.status}）`);
    messageAdapterScan.value.adapters = data.adapters ?? {};
    messageAdapterScan.value.overall = data.health?.overall ?? null;
    messageAdapterScan.value.partial = data.scan?.partial === true;
    messageAdapterScan.value.durationMs = Number(data.scan?.durationMs || 0);
    messageAdapterScan.value.checkedAt = new Date().toISOString();
    if (data.repair?.changed) {
      await store.load();
    }
    await applyNapcatScanHealth(data.napcatHealth);
    if (data.repair?.messages?.length) {
      napcatAutoSteps.value = {
        ...napcatAutoSteps.value,
        backendScan: {
          ok: true,
          message: data.repair.changed ? "后端检查完成，已修复基础配置。" : "只读扫描完成，未启动、登录或修复任何消息端。",
          steps: data.repair.messages
        }
      };
    }
  } catch (error) {
    messageAdapterScan.value.adapters = {};
    messageAdapterScan.value.overall = null;
    messageAdapterScan.value.partial = false;
    messageAdapterScan.value.durationMs = 0;
    messageAdapterScan.value.checkedAt = "";
    messageAdapterScan.value.error = error instanceof Error ? error.message : String(error);
  }
  finally { messageAdapterScan.value.loading = false; }
}

async function rescanNapcatInstances(): Promise<void> {
  await runMessageAdapterScan();
}

async function runAgentScan(): Promise<void> {
  if (agentScan.value.loading) return;
  agentScan.value.loading = true;
  const dshRevisionAtStart = dshScanRevision.value;
  try {
    const params = new URLSearchParams();
    const dshBaseUrl = gateway.value?.dshBaseUrl?.trim();
    if (dshBaseUrl) params.set("dshBaseUrl", dshBaseUrl);
    const res = await fetch(`/api/scan/agents${params.size ? `?${params}` : ""}`);
    const data = await res.json();
    agentScan.value.threadNames = data.threadNames ?? [];
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
    agentScan.value.copilotSessions = data.copilotSessions ?? [];
    agentScan.value.copilotBins = data.copilotBins ?? [];
    agentScan.value.marvisAppIds = data.marvisAppIds ?? [];
    const currentDsh = agentScan.value.agents.dsh;
    agentScan.value.agents = {
      ...(data.agents ?? {}),
      ...(dshScanRevision.value !== dshRevisionAtStart && currentDsh ? { dsh: currentDsh } : {})
    };
  } catch { /* ignore */ }
  finally { agentScan.value.loading = false; }
}

function refreshAgentScan(type: AgentAdapterType): void {
  const scan = type === "dsh" ? runDshAgentScan : runAgentScan;
  void scan();
}

async function runDshAgentScan(options: { append?: boolean; offset?: number; limit?: number } = {}): Promise<void> {
  if (dshScanLoading.value) return;
  dshScanLoading.value = true;
  try {
    const params = new URLSearchParams();
    if (options.offset != null) params.set("dshOffset", String(options.offset));
    if (options.limit != null) params.set("dshLimit", String(options.limit));
    const dshBaseUrl = gateway.value?.dshBaseUrl?.trim();
    if (dshBaseUrl) params.set("dshBaseUrl", dshBaseUrl);
    const res = await fetch(`/api/scan/agents/dsh${params.size ? `?${params}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `DSH 扫描失败（HTTP ${res.status}）`);
    const currentDsh = agentScan.value.agents.dsh;
    const nextDsh = data.agents?.dsh as AgentScanResult | undefined;
    const sessions = options.append
      ? [...(currentDsh?.sessions ?? []), ...(nextDsh?.sessions ?? [])]
      : [...(nextDsh?.sessions ?? [])];
    const uniqueSessions = [...new Map(sessions.map(session => [
      session.id || `${session.name}:${session.projectPath || ""}:${session.updatedAt || ""}`,
      session
    ])).values()];
    agentScan.value.agents = {
      ...agentScan.value.agents,
      dsh: nextDsh ? { ...nextDsh, sessions: uniqueSessions } : currentDsh
    };
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
    dshScanRevision.value += 1;
  } catch {
    // Keep the last successful DSH scan visible.
  } finally {
    dshScanLoading.value = false;
  }
}

async function loadMoreCodexSessions(): Promise<void> {
  const page = agentScan.value.agents.codex?.sessionPage;
  if (agentScan.value.loading || !page?.hasMore || page.nextOffset == null) return;
  agentScan.value.loading = true;
  try {
    const params = new URLSearchParams({
      codexOffset: String(page.nextOffset),
      codexLimit: String(page.limit)
    });
    const res = await fetch(`/api/scan/agents?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Agent 扫描失败（HTTP ${res.status}）`);
    const currentCodex = agentScan.value.agents.codex;
    const nextCodex = data.agents?.codex as AgentScanResult | undefined;
    const sessions = [...(currentCodex?.sessions ?? []), ...(nextCodex?.sessions ?? [])];
    const uniqueSessions = [...new Map(sessions.map(session => [
      session.id || `${session.name}:${session.projectPath || ""}:${session.updatedAt || ""}`,
      session
    ])).values()];
    agentScan.value.agents = {
      ...agentScan.value.agents,
      ...(data.agents ?? {}),
      codex: nextCodex ? { ...nextCodex, sessions: uniqueSessions } : currentCodex
    };
    agentScan.value.threadNames = [...new Set([...agentScan.value.threadNames, ...(data.threadNames ?? [])])];
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
  } catch {
    // Keep the already loaded task page available.
  } finally {
    agentScan.value.loading = false;
  }
}

async function loadMoreDshSessions(): Promise<void> {
  const page = agentScan.value.agents.dsh?.sessionPage;
  if (!page?.hasMore || page.nextOffset == null) return;
  await runDshAgentScan({ append: true, offset: page.nextOffset, limit: page.limit });
}

// 会话/项目扫描只在进入设置页时自动执行一次；后续刷新必须由用户点击扫描按钮触发。
onMounted(() => { void runAgentScan(); });
onMounted(() => { void speech.refreshPersonas().catch(() => undefined); });

onBeforeUnmount(() => {
  window.clearTimeout(speechConfigSaveTimer);
  for (const timer of napcatNewDevicePollTimers.values()) window.clearTimeout(timer);
  napcatNewDevicePollTimers.clear();
});

// Copilot CLI 安装/登录
const copilotStatus = ref<{ installed?: boolean; binPath?: string; loggedIn?: boolean; copilotHome?: string } | null>(null);
const copilotInstalling = ref(false);
const copilotLoginState = ref<{ loading: boolean; code: string | null; url: string | null; done: boolean; error: string | null }>({
  loading: false, code: null, url: null, done: false, error: null
});
const agentParamOpen = ref<Record<string, boolean>>({});

async function fetchCopilotStatus(): Promise<void> {
  try {
    const res = await fetch("/api/agent/copilot-status");
    copilotStatus.value = await res.json();
  } catch { /* ignore */ }
}

async function installCopilotCli(): Promise<void> {
  if (copilotInstalling.value) return;
  copilotInstalling.value = true;
  try {
    const res = await fetch("/api/agent/copilot-install", { method: "POST" });
    const data = await res.json();
    if (data.ok) await fetchCopilotStatus();
    else copilotLoginState.value.error = data.stderr || data.error || "安装失败";
  } catch (e) { copilotLoginState.value.error = String(e); }
  finally { copilotInstalling.value = false; }
}

async function startCopilotLogin(): Promise<void> {
  copilotLoginState.value = { loading: true, code: null, url: null, done: false, error: null };
  try {
    const res = await fetch("/api/agent/copilot-login", { method: "POST" });
    const data = await res.json();
    if (data.done) {
      copilotLoginState.value = { loading: false, code: null, url: null, done: true, error: null };
      await fetchCopilotStatus();
    } else if (data.code) {
      copilotLoginState.value = { loading: false, code: data.code, url: data.url, done: false, error: null };
      const events = managerEventSource("/api/events");
      events.addEventListener("copilot_login_status", async (raw) => {
        const event = JSON.parse((raw as MessageEvent).data || "{}");
        events.close();
        if (event.done) {
          await fetchCopilotStatus();
          copilotLoginState.value.done = true;
          copilotLoginState.value.code = null;
        } else {
          copilotLoginState.value.error = event.error || "登录失败";
        }
      });
    } else {
      copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: data.error || "启动失败" };
    }
  } catch (e) {
    copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: String(e) };
  }
}

watch(
  () => agentParamOpen.value["copilotCli"],
  (open) => { if (open && copilotStatus.value === null) fetchCopilotStatus(); }
);


const adapterParamOpen = ref<Record<string, boolean>>({
  speech: false,
  napcat: false,
  wecom: false,
  weixin: false,
  feishu: false,
  remoteAgent: false,
  heartbeat: false,
  fennenote: false,
  xiaoai: false,
  xiaomiHome: false,
  rabilink: false,
  wearable: false,
  webhook: false
});
const addAdapterMenu = ref(false);
const adapterCatalogCache = ref<Record<string, MessageAdapterType[]>>({});
const adapterGroups: Array<{ title: string; note: string; choices: Array<{ type: MessageEndpointType; title: string; note: string; icon: string }> }> = [
  {
    title: "本地桌面",
    note: "由本机常驻服务提供的消息入口。",
    choices: [
      { type: "speech", title: "语音消息端", note: "订阅主机 ASR，并配置投递策略与回复播放", icon: "mdi-microphone-message" }
    ]
  },
  {
    title: "实时消息",
    note: "来自聊天软件或即时通信平台的入口。",
    choices: [
      { type: "napcat", title: "NapCat / OneBot", note: "接收 QQ 群聊和私聊实时消息", icon: "mdi-message-badge-outline" },
      { type: "wecom", title: "企业微信 / WeCom", note: "接收企业微信群聊并支持回发消息", icon: "mdi-domain" },
      { type: "weixin", title: "个人微信 / Weixin", note: "RabiRoute 原生扫码登录，接收个人微信私聊，并向来源会话回传文本或受控本地文件", icon: "mdi-wechat" },
      { type: "feishu", title: "飞书 / Feishu", note: "独立应用事件订阅，按来源 chat 收发文本", icon: "mdi-message-text-outline" }
    ]
  },
  {
    title: "远端设备",
    note: "连接远端 Agent 设备，让本机人格按需投递下游任务。",
    choices: [
      { type: "remoteAgent", title: "远端 Agent", note: "远端设备只运行独立 bridge，按参数声明实际 Agent 类型", icon: "mdi-lan-connect" }
    ]
  },
  {
    title: "内部触发",
    note: "由 RabiRoute 自己产生的事件。",
    choices: [
      { type: "heartbeat", title: "定时触发", note: "按间隔主动生成内部消息", icon: "mdi-timer-outline" }
    ]
  },
  {
    title: "语音转写",
    note: "来自本机 RabiSpeech 或具体设备的语音输入。",
    choices: [
      { type: "rabilink", title: "眼镜端（经 RabiLink）", note: "眼镜是消息来源；RabiLink 只是系统内置的转接服务", icon: "mdi-glasses" }
    ]
  },
  {
    title: "健康与穿戴",
    note: "来自手机、智能手表或手环的结构化健康记录与规则告警。",
    choices: [
      { type: "wearable", title: "智能手表 / 手环", note: "持续记录心率和睡眠，阈值命中时提示 Agent", icon: "mdi-watch-variant" }
    ]
  },
  {
    title: "智能家居",
    note: "来自 Home Assistant 的米家设备状态与摄像头事件。",
    choices: [
      { type: "xiaomiHome", title: "米家 / Xiaomi Home", note: "把米家状态和摄像头事件投递到当前人格", icon: "mdi-home-automation" }
    ]
  },
  {
    title: "外部接口",
    note: "未命名系统的 HTTP 兜底入口。",
    choices: [
      { type: "webhook", title: "通用 Webhook", note: "没有专用消息端时的通用外部 POST 兜底入口", icon: "mdi-webhook" }
    ]
  }
];
const gateway = computed(() => store.selectedGateway);
const speechPersonaConfig = computed(() => speech.personas.find(item => item.id === gateway.value?.agentRoleId));
const personaConfigRoute = computed(() => gateway.value
  ? `/persona/${encodeURIComponent(configNameFor(gateway.value))}`
  : "/persona");

function uniqueAdapters(types: MessageAdapterType[]): MessageAdapterType[] {
  return [...new Set(types.filter((type) => type !== "disabled" && type !== "rolePanel"))];
}

function configuredAdapterCatalog(gw: NonNullable<typeof gateway.value>): MessageAdapterType[] {
  if (Array.isArray(gw.messageAdapters) && gw.messageAdapters.length > 0) {
    return uniqueAdapters(gw.messageAdapters);
  }
  const cached = adapterCatalogCache.value[gw.id];
  if (cached?.length) return uniqueAdapters(cached);
  return uniqueAdapters([gw.messageAdapterType || "napcat"]);
}

// 所有已添加的 adapter（含禁用），用于 UI 列表显示
const addedAdapters = computed<MessageAdapterType[]>(() => {
  const gw = gateway.value;
  if (!gw) return [];
  return configuredAdapterCatalog(gw);
});
// 仅启用的 adapter（不含禁用）
const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);
const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);
const messageAdapterInactive = computed(() => Boolean(gateway.value?.enabled === false || runtime.value.enabled === false || messageInputsDisabled.value));
const napcatState = computed(() => runtime.value.gatewayStatus?.napcat || {} as Record<string, any>);
const wecomState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.wecom || runtime.value.gatewayStatus?.wecom || {} as Record<string, any>);
const weixinState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.weixin || {} as Record<string, any>);
const feishuState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.feishu || runtime.value.gatewayStatus?.feishu || {} as Record<string, any>);
const heartbeatState = computed(() => runtime.value.gatewayStatus?.heartbeat || {} as Record<string, any>);
const adapterErrors = (type: MessageAdapterType) => gateway.value ? adapterErrorsFor(type, gateway.value, runtime.value) : [];

async function requestPersonalWeixinLogin(): Promise<void> {
  if (!gateway.value || weixinLoginBusy.value) return;
  weixinLoginBusy.value = true;
  weixinLoginError.value = "";
  try {
    const response = await fetch(`/gateways/${encodeURIComponent(gateway.value.id)}/weixin-login`, { method: "POST" });
    const payload = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    await store.load();
  } catch (error) {
    weixinLoginError.value = error instanceof Error ? error.message : String(error);
  } finally {
    weixinLoginBusy.value = false;
  }
}

function weixinSessionPhaseLabel(value: unknown): string {
  const labels: Record<string, string> = {
    never_logged_in: "从未登录",
    restoring: "正在恢复",
    restored: "已恢复",
    temporarily_unreachable: "暂时不可达（凭据保留）",
    invalid: "会话已失效"
  };
  return labels[String(value || "")] || "未知";
}
const visibleActiveAdapters = computed<MessageAdapterType[]>(() => uniqueAdapters(adapters.value));
const activeAdapterCount = computed(() => visibleActiveAdapters.value.length);
const selectedRemoteAgentDeviceId = computed({
  get: () => gateway.value?.remoteAgentDefaultDeviceId || "",
  set: (value: string | null) => {
    if (!gateway.value) return;
    gateway.value.remoteAgentDefaultDeviceId = String(value || "");
    const selected = remoteAgentDevices.value.find(device => device.deviceId === gateway.value?.remoteAgentDefaultDeviceId);
    if (selected?.defaultCwd && !gateway.value.remoteAgentDefaultCwd) gateway.value.remoteAgentDefaultCwd = selected.defaultCwd;
    if (selected?.defaultThreadName && !gateway.value.remoteAgentDefaultThreadName) gateway.value.remoteAgentDefaultThreadName = selected.defaultThreadName;
    store.touch();
  }
});
const remoteAgentDeviceOptions = computed(() => {
  const configuredId = gateway.value?.remoteAgentDefaultDeviceId?.trim();
  const devices = [...remoteAgentDevices.value];
  if (configuredId && !devices.some(device => device.deviceId === configuredId)) {
    devices.push({ deviceId: configuredId, deviceName: `${configuredId}（未连接）`, connected: false });
  }
  return devices.map(device => ({
    ...device,
    label: remoteAgentDeviceTitle(device),
    subtitle: remoteAgentDeviceSubtitle(device)
  }));
});
const selectedRemoteAgentDevice = computed(() => remoteAgentDevices.value.find(device => device.deviceId === selectedRemoteAgentDeviceId.value));
const selectedRemoteAgentDeviceLabel = computed(() => {
  const option = remoteAgentDeviceOptions.value.find(device => device.deviceId === selectedRemoteAgentDeviceId.value);
  return option?.label || "选择远端 Agent 设备";
});
const remoteAgentConnected = computed(() => remoteAgentDevices.value.some(device => device.connected));
const remoteAgentDiscoveryDetail = computed(() => {
  const requirement = messageScanFor("remoteAgent")?.requirements?.find(item => item.id === "discovery");
  return requirement?.detail || "扫描远端 bridge 公告，无需输入端口。";
});
const testingNapcatHealth = ref(false);
const testingNapcatInstance = ref<Record<string, boolean>>({});
const launchingNapcatInstance = ref<Record<string, boolean>>({});
const restartingNapcatInstance = ref<Record<string, boolean>>({});
const managingNapcatLogin = ref<Record<string, boolean>>({});
const napcatLoginPanels = ref<Record<string, NapcatLoginUiState>>({});
const napcatNewDevicePollTimers = new Map<string, number>();
const adoptingNapcatOwner = ref<Record<string, boolean>>({});
const fixingNapcatPorts = ref(false);
const napcatPortFixResult = ref<Record<string, { ok: boolean; message: string }>>({});
const configuringNapcatOneBot = ref<Record<string, boolean>>({});
const napcatOneBotFixResult = ref<Record<string, { ok: boolean; message: string }>>({});
const napcatHealthResult = ref<{
  ok?: boolean;
  loginState?: "ready" | "account-online-elsewhere" | "account-mismatch" | "quick-login-available" | "quick-login-invalid" | "qr-login-required" | "login-conflict" | "manual-login" | "start-failed";
  accountOwner?: {
    userId?: string;
    nickname?: string;
    httpUrl?: string;
    webuiUrl?: string;
    workingDir?: string;
    instanceName?: string;
    routesToGateway?: boolean;
  };
  fixAvailable?: boolean;
  diagnostics?: string[];
  onebot?: { configPath?: string; currentUserId?: string | number; currentNickname?: string };
  loginInfo?: { userId?: string | number; nickname?: string; online?: boolean; source?: string };
  http?: { ok?: boolean; status?: number; message?: string; userId?: string | number; nickname?: string };
  webui?: {
    url?: string;
    reachable?: boolean;
    found?: boolean;
    tokenFound?: boolean;
    tokenLength?: number;
    configPath?: string;
    source?: "provided" | "config";
    message?: string;
    loginInfo?: { userId?: string | number; nickname?: string; online?: boolean; status?: string; message?: string };
  };
  process?: { found?: boolean; candidates?: Array<{ name: string; pid: string }> };
  wsUrl?: string;
  message?: string;
} | null>(null);
const napcatInstanceHealthResult = ref<Record<string, typeof napcatHealthResult.value>>({});
const napcatScanHealthByWebui = ref<Record<string, NapCatScanHealthEntry[]>>({});
const napcatLaunchResult = ref<Record<string, { ok: boolean; message: string }>>({});
const autoCheckingNapcat = ref(false);
const lastAutoNapcatHealthKey = ref("");
const napcatHealthPausedAfterFix = ref<Record<string, boolean>>({});
const copyResult = ref("");
const triggeringHeartbeat = ref(false);
const heartbeatTriggerResult = ref<{ ok: boolean; message: string } | null>(null);
const deletingGateway = ref(false);
const deleteError = ref("");
const openingMarvis = ref(false);
const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);
const visibleAdapterGroups = computed(() => {
  const query = adapterQuery.value.trim().toLowerCase();
  return adapterGroups
    .map(group => ({
      ...group,
      choices: group.choices.filter(choice => {
        if (!addedAdapters.value.includes(choice.type)) return false;
        if (!query) return true;
        return [
          group.title,
          group.note,
          choice.type,
          choice.title,
          choice.note
        ].join(" ").toLowerCase().includes(query);
      })
    }))
    .filter(group => group.choices.length > 0);
});
const codexCwdOptions = computed(() => {
  const values = new Set<string>();
  store.gateways.forEach(item => {
    if (item.codexCwd) values.add(item.codexCwd);
  });
  return [...values];
});

async function setAdapterEnabled(type: MessageAdapterType, value: unknown): Promise<void> {
  if (!gateway.value) return;
  const enabled = value === true;
  if (enabled === !isAdapterDisabled(gateway.value, type)) return;
  toggleAdapterDisabled(gateway.value, type);
  store.touch();
  if (type !== "speech") return;

  await persistAndSyncSpeechAdapter();
}

async function persistAndSyncSpeechAdapter(): Promise<void> {
  if (!gateway.value) return;
  speechAdapterActionBusy.value = true;
  speechAdapterActionError.value = "";
  try {
    await store.save();
    await speech.reconcileMicrophone();
  } catch (cause) {
    speechAdapterActionError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    speechAdapterActionBusy.value = false;
  }
}

function scheduleSpeechConfigSave(): void {
  window.clearTimeout(speechConfigSaveTimer);
  if (!gateway.value || isAdapterDisabled(gateway.value, "speech")) return;
  speechConfigSaveTimer = window.setTimeout(() => void persistAndSyncSpeechAdapter(), 700);
}

function hasAdapterParams(type: MessageAdapterType): boolean {
  return type !== "disabled";
}

function messageGroupingPolicy(type: MessageAdapterType) {
  if (!gateway.value || type === "disabled") return undefined;
  return messageAdapterPolicyFor(gateway.value, type).messageGrouping;
}

function usesAutomaticMessageGrouping(type: MessageAdapterType): boolean {
  return type !== "disabled" && messageAdapterUsesAutomaticGrouping(type);
}

function setMessageGroupingPolicy(type: MessageAdapterType, patch: Record<string, unknown>): void {
  if (!gateway.value || type === "disabled") return;
  const current = messageAdapterPolicyFor(gateway.value, type);
  setMessageAdapterPolicy(gateway.value, type, {
    messageGrouping: { ...current.messageGrouping, ...patch }
  });
  store.touch();
}

function speechVariable(name: string, fallback = ""): string {
  return String(gateway.value?.routeVariables?.[name] ?? fallback);
}

function setSpeechVariable(name: string, value: unknown): void {
  if (!gateway.value) return;
  gateway.value.routeVariables = gateway.value.routeVariables ?? {};
  gateway.value.routeVariables[name] = String(value ?? "");
  store.touch();
  scheduleSpeechConfigSave();
}

function setSpeechHotDelivery(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.speechPushMode = speechPushModeForHotDelivery(value === true);
  store.touch();
  scheduleSpeechConfigSave();
}

function setSpeechAutoPlay(value: unknown): void {
  if (!gateway.value) return;
  const enabled = value === true;
  setSpeechVariable("speechAutoPlay", String(enabled));
  gateway.value.pipeline = { ...gateway.value.pipeline, ttsPlay: enabled };
  store.touch();
}

function adapterLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function adapterLogPaths(type: MessageAdapterType): string[] {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function messageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function messageFilePaths(type: MessageAdapterType): string[] {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function formatLogTime(entry: Record<string, any>): string {
  const ms = Number(entry.timeMs || 0);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toLocaleString();
  }
  if (entry.time) return String(entry.time);
  return "-";
}

function logPreview(entry: Record<string, any>): string {
  const text = String(entry.text || entry.message || "");
  if (text) return text;
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function logEventTitle(entry: Record<string, any>): string {
  return [entry.level && entry.level !== "info" ? String(entry.level) : "", entry.event || entry.source || "log"]
    .filter(Boolean)
    .join(" · ");
}

function rawLogJson(entry: Record<string, any>): string {
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function toggleAdapterParams(type: MessageAdapterType): void {
  adapterParamOpen.value[type] = !adapterParamOpen.value[type];
  if (adapterParamOpen.value[type]) void runMessageAdapterScan();
  if (adapterParamOpen.value[type] && type === "remoteAgent") void refreshRemoteAgentDevices();
}

function removeAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = adapters.value.filter(t => t !== type);
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = false;
  store.touch();
}

const availableToAdd = computed(() => {
  const allTypes: MessageAdapterType[] = ["napcat", "wecom", "weixin", "feishu", "remoteAgent", "speech", "heartbeat", "xiaomiHome", "rabilink", "wearable", "webhook"];
  return allTypes.filter(t => !addedAdapters.value.includes(t));
});

watch(
  () => [gateway.value?.id, gateway.value?.messageAdapterType, JSON.stringify(gateway.value?.messageAdapters ?? [])] as const,
  ([id]) => {
    const configured = Array.isArray(gateway.value?.messageAdapters)
      ? uniqueAdapters(gateway.value.messageAdapters)
      : [];
    if (!id || configured.length === 0) return;
    adapterCatalogCache.value = {
      ...adapterCatalogCache.value,
      [id]: addedAdapters.value
    };
  },
  { immediate: true }
);

watch(
  () => [gateway.value?.id, adapterParamOpen.value.remoteAgent] as const,
  ([id, open]) => {
    if (id && open) void refreshRemoteAgentDevices();
  }
);

function addAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = [...addedAdapters.value, type];
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = true;
  void runMessageAdapterScan();
  if (type === "remoteAgent") void refreshRemoteAgentDevices();
  store.touch();
}

function touch(): void {
  if (gateway.value) applyAdapterDefaults(gateway.value);
  if (gateway.value?.messageAdapters?.includes("napcat") || gateway.value?.messageAdapterType === "napcat") {
    syncPrimaryNapcatFromInstances();
  }
  store.touch();
}

function defaultNapcatWebuiUrl(): string {
  const scanned = messageAdapterScan.value.adapters.napcat?.endpoints?.find(endpoint => endpoint.healthy)?.url;
  return scanned || gateway.value?.napcatWebuiUrl?.trim() || "http://127.0.0.1:6099/webui";
}

function ensureNapcatInstances(): NapCatInstance[] {
  if (!gateway.value) return [];
  if (!Array.isArray(gateway.value.napcatInstances) || gateway.value.napcatInstances.length === 0) {
    gateway.value.napcatInstances = [{
      id: "default",
      name: "默认 NapCat",
      enabled: true,
      autoLoginOnRabiStart: true,
      gatewayPort: gateway.value.gatewayPort || 8789,
      httpUrl: gateway.value.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: gateway.value.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: gateway.value.napcatAccessToken || "",
      webuiToken: gateway.value.napcatWebuiToken || ""
    }];
  } else {
    const primary = gateway.value.napcatInstances.find(item => item.enabled !== false)
      ?? gateway.value.napcatInstances[0];
    primary.enabled = true;
    if (gateway.value.napcatInstances.length !== 1 || gateway.value.napcatInstances[0] !== primary) {
      gateway.value.napcatInstances = [primary];
    }
  }
  return gateway.value.napcatInstances;
}

function syncPrimaryNapcatFromInstances(): void {
  if (!gateway.value) return;
  const primary = ensureNapcatInstances().find((item) => item.enabled !== false) ?? ensureNapcatInstances()[0];
  if (!primary) return;
  gateway.value.gatewayPort = Number(primary.gatewayPort || gateway.value.gatewayPort || 8790);
  gateway.value.napcatHttpUrl = primary.httpUrl || gateway.value.napcatHttpUrl;
  gateway.value.napcatWebuiUrl = primary.webuiUrl || gateway.value.napcatWebuiUrl;
  gateway.value.napcatAccessToken = primary.accessToken || gateway.value.napcatAccessToken;
  gateway.value.napcatWebuiToken = primary.webuiToken || gateway.value.napcatWebuiToken;
}

function nextNapcatPort(base: number): number {
  const used = new Set<number>([
    Number(store.meta.managerPort || 0),
    ...ensureNapcatInstances().map((item) => Number(item.gatewayPort)),
    ...store.gateways.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.fenneNoteWebhookPort),
      Number(item.xiaoaiWebhookPort),
      Number(item.rabiLinkWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ]),
    ...store.managerRows.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.fenneNoteWebhookPort),
      Number(item.xiaoaiWebhookPort),
      Number(item.rabiLinkWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ])
  ].filter(port => Number.isFinite(port) && port > 0));
  let port = base;
  while (used.has(port)) port += 1;
  return port;
}

function allocateAvailablePort(used: Set<number>, base: number): number {
  let port = Math.max(1, Math.min(65535, Number(base) || 8790));
  while (port <= 65535 && used.has(port)) port += 1;
  if (port > 65535) {
    throw new Error("没有可用端口了，请手动释放一个 1-65535 范围内的端口。");
  }
  used.add(port);
  return port;
}

function autoAssignNapcatPortsForAllGateways(): boolean {
  const usedWs = new Set<number>();
  const usedWebui = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWs.add(port);
  };

  claim(store.meta.managerPort || 0);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("fennenote")) claim(item.fenneNoteWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("xiaoai")) claim(item.xiaoaiWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("rabilink")) claim(item.rabiLinkWebhookPort ?? item.webhookPort ?? item.gatewayPort);
  }

  let changed = false;
  const claimWebui = (url: string | undefined): void => {
    const port = portFromLocalUrl(url);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWebui.add(port);
  };
  for (const item of store.gateways) {
    if (!gatewayAdapterTypes(item).includes("napcat")) continue;
    const configuredInstances = Array.isArray(item.napcatInstances) && item.napcatInstances.length > 0
      ? item.napcatInstances
      : [{
          id: "default",
          name: "默认 NapCat",
          enabled: true,
          gatewayPort: item.gatewayPort,
          httpUrl: item.napcatHttpUrl || "http://127.0.0.1:3000",
          webuiUrl: item.napcatWebuiUrl || defaultNapcatWebuiUrl(),
          accessToken: item.napcatAccessToken || "",
          webuiToken: item.napcatWebuiToken || ""
        } as NapCatInstance];
    const instances = [configuredInstances.find(instance => instance.enabled !== false) ?? configuredInstances[0]];
    instances[0].enabled = true;
    item.napcatInstances = instances;
    for (const instance of instances) {
      if (instance.enabled === false) continue;
      const current = Number(instance.gatewayPort || 0);
      if (!Number.isInteger(current) || current < 1 || current > 65535 || usedWs.has(current)) {
        instance.gatewayPort = allocateAvailablePort(usedWs, Math.max(current + 1, Number(item.gatewayPort || 8789) + 1));
        changed = true;
      } else {
        usedWs.add(current);
      }

      if (!portFromLocalUrl(instance.httpUrl)) {
        const configuredHttpUrl = item.napcatHttpUrl;
        instance.httpUrl = configuredHttpUrl && portFromLocalUrl(configuredHttpUrl)
          ? configuredHttpUrl
          : "http://127.0.0.1:3000";
        changed = true;
      }

      const webuiPort = portFromLocalUrl(instance.webuiUrl);
      if (!webuiPort || usedWebui.has(webuiPort)) {
        instance.webuiUrl = nextAvailableLocalUrl(instance.webuiUrl || item.napcatWebuiUrl || defaultNapcatWebuiUrl(), usedWebui, 6099);
        changed = true;
      } else {
        claimWebui(instance.webuiUrl);
      }
    }
    const primary = instances.find(instance => instance.enabled !== false) ?? instances[0];
    if (primary && Number(item.gatewayPort || 0) !== Number(primary.gatewayPort || 0)) {
      item.gatewayPort = Number(primary.gatewayPort);
      item.napcatHttpUrl = primary.httpUrl || item.napcatHttpUrl;
      item.napcatWebuiUrl = primary.webuiUrl || item.napcatWebuiUrl;
      item.napcatAccessToken = primary.accessToken || item.napcatAccessToken;
      item.napcatWebuiToken = primary.webuiToken || item.napcatWebuiToken;
      changed = true;
    }
  }
  if (changed) store.touch();
  return changed;
}

function portFromLocalUrl(value: string | undefined): number {
  try {
    return Number(new URL(value || "").port || 0);
  } catch {
    return 0;
  }
}

function nextAvailableLocalUrl(baseUrl: string, used: Set<number>, fallbackPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
  } catch {
    parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
  }
  const original = Number(parsed.port || fallbackPort);
  const port = allocateAvailablePort(used, original || fallbackPort);
  parsed.port = String(port);
  return parsed.toString().replace(/\/$/, "");
}

function nextLocalHttpUrl(baseUrl: string, fallbackPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
  } catch {
    parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
  }
  const used = new Set<number>([
    ...ensureNapcatInstances().flatMap(item => [
      portFromLocalUrl(item.httpUrl),
      portFromLocalUrl(item.webuiUrl)
    ]),
    ...store.gateways.flatMap(item => [
      portFromLocalUrl(item.napcatHttpUrl),
      portFromLocalUrl(item.napcatWebuiUrl),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.flatMap(instance => [
        portFromLocalUrl(instance.httpUrl),
        portFromLocalUrl(instance.webuiUrl)
      ]) : [])
    ])
  ].filter(port => Number.isFinite(port) && port > 0));
  let port = Number(parsed.port || fallbackPort);
  while (used.has(port)) port += 1;
  parsed.port = String(port);
  return parsed.toString().replace(/\/$/, "");
}

function recentNapcatTemplate(): Partial<NapCatInstance> {
  const configured = ensureNapcatInstances();
  return [...configured].reverse().find(instance =>
    Boolean(instance.launchCommand || instance.workingDir || instance.webuiUrl || instance.accessToken)
  ) || configured[0] || {};
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstance>): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoredNapcatKeys(): Set<string> {
  return new Set((gateway.value?.ignoredNapcatInstanceIds ?? []).map(item => String(item || "").trim()).filter(Boolean));
}

function isIgnoredNapcatInstance(instance: Partial<NapCatInstance>): boolean {
  const ignored = ignoredNapcatKeys();
  return napcatInstanceIgnoreKeys(instance).some(key => ignored.has(key));
}

function clearIgnoredNapcatInstance(instance: Partial<NapCatInstance>): void {
  if (!gateway.value?.ignoredNapcatInstanceIds?.length) return;
  const keys = new Set(napcatInstanceIgnoreKeys(instance));
  const next = gateway.value.ignoredNapcatInstanceIds.filter(item => !keys.has(String(item || "").trim()));
  if (next.length !== gateway.value.ignoredNapcatInstanceIds.length) {
    gateway.value.ignoredNapcatInstanceIds = next;
    store.touch();
  }
}

function ignoreNapcatInstance(instance: Partial<NapCatInstance>): void {
  if (!gateway.value) return;
  const next = new Set((gateway.value.ignoredNapcatInstanceIds ?? []).map(item => String(item || "").trim()).filter(Boolean));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  gateway.value.ignoredNapcatInstanceIds = [...next];
  store.touch();
}

function clearNapcatInstanceUiState(id: string): void {
  for (const state of [
    napcatInstanceHealthResult,
    napcatLaunchResult,
    napcatPortFixResult,
    napcatOneBotFixResult,
    napcatHealthPausedAfterFix,
    testingNapcatInstance,
    launchingNapcatInstance,
    managingNapcatLogin,
    napcatLoginPanels,
    configuringNapcatOneBot
  ]) {
    const next = { ...state.value };
    delete next[id];
    state.value = next;
  }
}

function napcatRemovePayload(instance: NapCatInstance): Record<string, unknown> {
  return {
    gatewayId: gateway.value?.id,
    instanceId: instance.id,
    name: instance.name,
    gatewayPort: instance.gatewayPort,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl,
    accessToken: instance.accessToken,
    webuiToken: instance.webuiToken,
    launchCommand: instance.launchCommand,
    workingDir: instance.workingDir,
    botUserId: napcatAccountUserId(instance),
    botNickname: napcatAccountNickname(instance)
  };
}

async function removeNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  napcatLaunchResult.value = {
    ...napcatLaunchResult.value,
    [instance.id]: { ok: true, message: "正在退出登录并停止 NapCat..." }
  };
  try {
    if (store.dirty) await store.save();
    const resp = await fetch("/api/message/napcat-remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatRemovePayload(instance))
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已退出登录、停止并移除。" : "删除失败。")
      }
    };
    if (resp.ok && body.ok !== false) {
      ignoreNapcatInstance(instance);
      clearNapcatInstanceUiState(instance.id);
      if (store.dirty) await store.save();
    }
    await store.load();
    await runMessageAdapterScan();
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  }
}

function removeNapcatInstanceById(id: string): void {
  const instance = napcatAccountInstances().find(item => item.id === id);
  if (instance) void removeNapcatInstance(instance);
}

function isConfiguredNapcatInstance(instance: NapCatInstance): boolean {
  return ensureNapcatInstances().some(item => sameNapcatInstance(item as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>));
}

function openExternalUrl(url: string | undefined): void {
  const target = url?.trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function napcatWsUrl(): string {
  return `ws://127.0.0.1:${gateway.value?.gatewayPort || 8790}`;
}

function napcatInstanceWsUrl(instance: NapCatInstance): string {
  return `ws://127.0.0.1:${instance.gatewayPort || 8790}`;
}

function webhookPortFor(type: MessageAdapterType): number {
  if (type === "fennenote") return Number(gateway.value?.fenneNoteWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  if (type === "xiaoai") return Number(gateway.value?.xiaoaiWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  if (type === "rabilink") return Number(gateway.value?.rabiLinkWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  if (type === "feishu") return Number(gateway.value?.feishuWebhookPort || gateway.value?.gatewayPort || 8790);
  return Number(gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
}

function webhookPathFor(type: MessageAdapterType): string {
  if (type === "fennenote") return gateway.value?.fenneNoteWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "xiaoai") return gateway.value?.xiaoaiWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "rabilink") return gateway.value?.rabiLinkWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "feishu") return gateway.value?.feishuWebhookPath || adapterDefaultWebhookPath(type);
  return gateway.value?.webhookPath || adapterDefaultWebhookPath(type);
}

function webhookHostFor(type: MessageAdapterType): string {
  if (type === "rabilink") return gateway.value?.rabiLinkWebhookHost || "0.0.0.0";
  return "127.0.0.1";
}

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function localCallbackHost(): string {
  const browserHost = window.location.hostname;
  if (browserHost && !isUnspecifiedHttpHost(browserHost) && browserHost !== "localhost" && !browserHost.startsWith("127.")) {
    return browserHost;
  }
  return store.networkOptions.localAddresses?.find((item) => item.address)?.address || "127.0.0.1";
}

function callbackHostFor(type: MessageAdapterType): string {
  const host = webhookHostFor(type);
  return type === "rabilink" && isUnspecifiedHttpHost(host) ? localCallbackHost() : host;
}

function setWebhookPort(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const port = Number(value || 0);
  if (type === "fennenote") gateway.value.fenneNoteWebhookPort = port;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPort = port;
  else if (type === "rabilink") gateway.value.rabiLinkWebhookPort = port;
  else if (type === "feishu") gateway.value.feishuWebhookPort = port;
  else gateway.value.webhookPort = port;
  touch();
}

function setWebhookPath(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const path = String(value || "");
  if (type === "fennenote") gateway.value.fenneNoteWebhookPath = path;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPath = path;
  else if (type === "rabilink") gateway.value.rabiLinkWebhookPath = path;
  else if (type === "feishu") gateway.value.feishuWebhookPath = path;
  else gateway.value.webhookPath = path;
  touch();
}

function setWebhookHost(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value || type !== "rabilink") return;
  gateway.value.rabiLinkWebhookHost = String(value || "").trim() || "0.0.0.0";
  touch();
}

function webhookUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${webhookHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function callbackUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${callbackHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookTestEventType(type: MessageAdapterType): string {
  if (type === "fennenote") return "fennenote.transcript";
  if (type === "xiaoai") return "xiaoai.transcript";
  if (type === "rabilink") return "rabilink.message";
  return "webhook.text";
}

function webhookCurl(type: MessageAdapterType = "webhook"): string {
  const source = adapterSourceAliases(type)[0] || type;
  const eventType = webhookTestEventType(type);
  return `curl -X POST "${callbackUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"${eventType}\",\"message\":\"hello from RabiRoute\"}"`;
}
function sourceLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return adapterLogEntries(type);
}

function sourceMessageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return messageFileEntries(type);
}

function sourceTitle(type: MessageAdapterType): string {
  return adapterLabel(type);
}

function messageScanFor(type: MessageAdapterType): MessageAdapterScanResult | undefined {
  return messageAdapterScan.value.adapters[type];
}

const channelCheckItems = computed(() => {
  const catalog = new Map(adapterGroups.flatMap(group => group.choices).map(choice => [choice.type, choice]));
  return addedAdapters.value
    .filter((type): type is MessageEndpointType => type !== "disabled")
    .map(type => catalog.get(type) ?? {
      type,
      title: adapterLabel(type),
      note: "当前 Route 已添加的消息端。",
      icon: "mdi-connection"
    });
});

async function runChannelCheck(): Promise<void> {
  const scanAgents = runAgentScan;
  await Promise.all([runMessageAdapterScan(), scanAgents()]);
}

function openChannelCheckDialog(): void {
  channelCheckDialogOpen.value = true;
  void runChannelCheck();
}

function openChannelCheckDetails(type: MessageAdapterType): void {
  channelCheckDialogOpen.value = false;
  adapterQuery.value = "";
  adapterParamOpen.value[type] = true;
}

function openChannelCheckAgentDetails(type: AgentAdapterType): void {
  channelCheckDialogOpen.value = false;
  agentParamOpen.value[type] = true;
}

function agentDeliveryTestCompletedAt(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

async function runAgentDeliveryTest(type: AgentAdapterType): Promise<void> {
  if (!gateway.value) return;
  agentDeliveryTest.value = { loading: type, result: null, error: "" };
  try {
    if (store.dirty) {
      throw new Error("请先保存当前配置，再执行投递测试。");
    }
    const result = await store.testAgentDelivery(gateway.value.id, type);
    agentDeliveryTest.value = { loading: null, result, error: "" };
  } catch (error) {
    agentDeliveryTest.value = {
      loading: null,
      result: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function enabledChannelCheckScans(): Array<MessageAdapterScanResult | undefined> {
  if (!gateway.value) return [];
  return channelCheckItems.value
    .filter(item => !isAdapterDisabled(gateway.value!, item.type))
    .map(item => messageScanFor(item.type));
}

function channelCheckOverallLabel(): string {
  if (messageAdapterScan.value.loading || agentScan.value.loading) return "正在检查通道";
  if (messageAdapterScan.value.error) return "通道检查失败";
  if (!messageAdapterScan.value.checkedAt) return "尚未检查";
  if (gateway.value?.enabled === false || runtime.value.enabled === false) return "当前 Route 已停用";
  if (runtime.value.running === false) return "Manager 未运行";
  const scans = enabledChannelCheckScans();
  if (!scans.length) return "没有启用的通道";
  if (!channelCheckAgentItems.value.length) return "尚未配置 Agent 端";
  if (scans.some(scan => !scan)) return "检查完成，状态待确认";
  if (scans.some(scan => scan?.scan?.state === "timeout" || scan?.scan?.state === "error")) {
    return "检查完成，部分结果超时";
  }
  const agentsReady = channelCheckAgentItems.value.every(item => ["可投递", "已绑定", "已发现"].includes(channelAgentConnectionLabel(item.type)));
  if (agentsReady && scans.every(scan => ["可用", "已发现"].includes(scanConnectionLabel(scan)))) return "通道状态正常";
  return "发现需要处理的通道";
}

function channelCheckOverallColor(): string {
  const label = channelCheckOverallLabel();
  if (label === "通道检查失败") return "error";
  if (["正在检查通道", "尚未检查", "没有启用的通道", "当前 Route 已停用"].includes(label)) return "secondary";
  if (label !== "通道状态正常") return "warning";
  return "success";
}

function channelCheckDetail(scan?: MessageAdapterScanResult): string {
  if (!scan) return messageAdapterScan.value.loading ? "正在读取连接和依赖状态。" : "本轮没有返回检查结果。";
  if (scan.health?.message) return scan.health.message;
  if (scan.scan?.message) return scan.scan.message;
  const missing = scan.requirements?.filter(item => item.required && item.ok === false) ?? [];
  if (missing.length) return `缺少：${missing.map(item => item.label).join("、")}`;
  return scan.installed ? "已发现消息端，连接状态需要进一步确认。" : "尚未发现所需配置或服务。";
}

function remoteAgentDeviceTitle(device: RemoteAgentDeviceStatus): string {
  const name = device.deviceName || device.deviceId;
  return name === device.deviceId ? name : `${name} (${device.deviceId})`;
}

function remoteAgentDeviceSubtitle(device: RemoteAgentDeviceStatus): string {
  const status = device.connected ? "已连接" : device.connectionError ? "连接异常" : "已发现";
  const system = [device.os, device.osVersion, device.arch].filter(Boolean).join(" ");
  const ip = device.observedIp || device.declaredIp || device.host || "";
  const password = device.passwordSaved ? "已记住密码" : "";
  return [status, device.agentType, system, ip, password].filter(Boolean).join(" · ");
}

function selectRemoteAgentDevice(deviceId: string): void {
  selectedRemoteAgentDeviceId.value = deviceId;
  remoteAgentConnectResult.value = null;
  remoteAgentDeviceMenu.value = false;
}

async function refreshRemoteAgentDevices(): Promise<void> {
  if (remoteAgentDevicesLoading.value) return;
  remoteAgentDevicesLoading.value = true;
  remoteAgentDeviceError.value = "";
  try {
    const res = await fetch("/api/remote-agent/devices");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : [];
  } catch (error: unknown) {
    remoteAgentDeviceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteAgentDevicesLoading.value = false;
  }
}

async function scanRemoteAgentDevices(): Promise<void> {
  if (remoteAgentDevicesLoading.value) return;
  remoteAgentDevicesLoading.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/scan", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : [];
    const selectedId = selectedRemoteAgentDeviceId.value;
    if (!selectedId && remoteAgentDevices.value[0]) {
      selectedRemoteAgentDeviceId.value = remoteAgentDevices.value[0].deviceId;
    }
  } catch (error: unknown) {
    remoteAgentDeviceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteAgentDevicesLoading.value = false;
  }
}

async function connectRemoteAgentDevice(): Promise<void> {
  if (!selectedRemoteAgentDeviceId.value || remoteAgentConnecting.value) return;
  remoteAgentConnecting.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: selectedRemoteAgentDeviceId.value,
        password: remoteAgentPassword.value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : remoteAgentDevices.value;
    const device = data.device as RemoteAgentDeviceStatus | undefined;
    if (device?.deviceId && gateway.value) {
      gateway.value.remoteAgentDefaultDeviceId = device.deviceId;
      if (device.defaultCwd && !gateway.value.remoteAgentDefaultCwd) gateway.value.remoteAgentDefaultCwd = device.defaultCwd;
      if (device.defaultThreadName && !gateway.value.remoteAgentDefaultThreadName) gateway.value.remoteAgentDefaultThreadName = device.defaultThreadName;
      store.touch();
    }
    remoteAgentPassword.value = "";
    remoteAgentConnectResult.value = { ok: true, message: "已连接远端 Agent，密码已记住。" };
  } catch (error: unknown) {
    remoteAgentConnectResult.value = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    remoteAgentConnecting.value = false;
  }
}

async function disconnectRemoteAgentDevice(): Promise<void> {
  if (!selectedRemoteAgentDeviceId.value || remoteAgentConnecting.value) return;
  remoteAgentConnecting.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: selectedRemoteAgentDeviceId.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : remoteAgentDevices.value;
    remoteAgentConnectResult.value = { ok: true, message: "已断开远端 Agent。" };
  } catch (error: unknown) {
    remoteAgentConnectResult.value = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    remoteAgentConnecting.value = false;
  }
}

function requirementColor(requirement: { ok?: boolean }): string {
  if (requirement.ok === true) return "success";
  if (requirement.ok === false) return "warning";
  return "secondary";
}

function requirementLabel(requirement: { ok?: boolean; required?: boolean }): string {
  if (requirement.ok === true) return "已满足";
  if (requirement.ok === false) return requirement.required ? "缺少" : "未发现";
  return "需确认";
}

function scanConnectionLabel(scan?: MessageAdapterScanResult): string {
  if (!scan) return messageAdapterScan.value.loading ? "扫描中" : "未扫描";
  const labels: Record<NonNullable<MessageAdapterScanResult["health"]>["state"], string> = {
    healthy: "可用",
    degraded: "部分可用",
    offline: scan.type === "napcat" ? "QQ 离线" : "未连接",
    needs_login: scan.type === "napcat" ? "QQ 未登录" : "未登录",
    unconfigured: "未配置",
    unknown: "待确认",
    timeout: "检查超时",
    error: "检查失败"
  };
  if (scan.health) return labels[scan.health.state];
  const required = scan.requirements?.filter(item => item.required) ?? [];
  if (required.some(item => item.ok === false)) return "缺配置";
  if (scan.endpoints?.length && scan.endpoints.every(endpoint => endpoint.healthy === false)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function scanConnectionColor(scan?: MessageAdapterScanResult): string {
  const label = scanConnectionLabel(scan);
  if (label === "可用" || label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描") return "secondary";
  if (label === "检查失败") return "error";
  return "warning";
}

function openScanCandidate(candidate: { url?: string; path?: string }): void {
  if (candidate.url) {
    openExternalUrl(candidate.url);
    return;
  }
  if (candidate.path) void copyText(candidate.path, "已复制本地路径");
}

function napcatRuntimeInstances(): Record<string, any>[] {
  const raw = napcatState.value.instances ?? napcatState.value.napcatInstances ?? runtime.value.gatewayStatus?.napcatInstances;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.entries(raw).map(([id, value]) => ({ id, ...(value as Record<string, any>) }));
  return [];
}

function napcatInstanceSourceId(instance: Partial<NapCatInstance> & Record<string, any>): string {
  return String(instance.sourceInstanceId || instance.instanceId || instance.id || "").trim();
}

function napcatInstanceScope(instance: Partial<NapCatInstance> & Record<string, any>): string {
  return String(instance.routeId || instance.gatewayId || instance.configName || gateway.value?.id || "").trim();
}

function sameNapcatInstance(left: Partial<NapCatInstance> & Record<string, any>, right: Partial<NapCatInstance> & Record<string, any>): boolean {
  const leftWebui = String(left.webuiUrl || left.napcatWebuiUrl || "").trim();
  const rightWebui = String(right.webuiUrl || right.napcatWebuiUrl || "").trim();
  if (leftWebui && rightWebui) return leftWebui === rightWebui;

  const leftHttp = String(left.httpUrl || left.napcatHttpUrl || "").trim();
  const rightHttp = String(right.httpUrl || right.napcatHttpUrl || "").trim();
  if (leftHttp && rightHttp) return leftHttp === rightHttp;

  const leftPort = Number(left.gatewayPort || left.port || left.wsPort || 0);
  const rightPort = Number(right.gatewayPort || right.port || right.wsPort || 0);
  if (leftPort > 0 && rightPort > 0 && leftPort === rightPort) return true;

  const leftId = napcatInstanceSourceId(left);
  const rightId = napcatInstanceSourceId(right);
  if (!leftId || !rightId || leftId !== rightId) return false;

  return napcatInstanceScope(left) === napcatInstanceScope(right);
}

function scopedRuntimeNapcatId(item: Record<string, any>, rawId: string, port: number): string {
  const scope = napcatInstanceScope(item).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  const id = rawId || `ws-${port || "unknown"}`;
  if (!scope || scope === gateway.value?.id || scope === store.configNameFor(gateway.value as any)) return id;
  return `${scope}-${id}`;
}

function napcatIdFromFile(file: string | undefined, fallback: string): string {
  const raw = String(file || "").replace(/\.json$/i, "");
  const match = raw.match(/onebot11[_-]?(.+)?$/i);
  return (match?.[1] || raw || fallback).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || fallback;
}

function portFromWsOption(option: Record<string, any>): number {
  const raw = option.value || option.port || option.url;
  const direct = Number(raw);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    return Number(new URL(String(option.url || raw)).port || 0);
  } catch {
    const match = String(raw || "").match(/:(\d+)(?:\/|$)/);
    return Number(match?.[1] || 0);
  }
}

function napcatDiscoveredInstances(): NapCatInstance[] {
  const napcatOptions = ((store.networkOptions.adapters as Record<string, any>)?.napcat || {}) as {
    httpServers?: Array<Record<string, any>>;
    websocketClients?: Array<Record<string, any>>;
  };
  const byKey = new Map<string, Partial<NapCatInstance> & { file?: string }>();
  const keyFor = (item: Record<string, any>, index: number) => String(item.file || item.configPath || item.value || item.url || `discovered-${index + 1}`);

  (napcatOptions.httpServers || []).forEach((server, index) => {
    const key = keyFor(server, index);
    const current = byKey.get(key) || {};
    byKey.set(key, {
      ...current,
      file: server.file,
      id: current.id || napcatIdFromFile(server.file, `discovered-${index + 1}`),
      name: current.name || napcatIdFromFile(server.file, `QQ ${index + 1}`),
      httpUrl: String(server.value || server.url || current.httpUrl || ""),
      webuiUrl: current.webuiUrl || defaultNapcatWebuiUrl()
    });
  });

  (napcatOptions.websocketClients || []).forEach((client, index) => {
    const key = keyFor(client, index);
    const current = byKey.get(key) || {};
    const port = portFromWsOption(client);
    byKey.set(key, {
      ...current,
      file: client.file,
      id: current.id || napcatIdFromFile(client.file, `discovered-${index + 1}`),
      name: current.name || napcatIdFromFile(client.file, `QQ ${index + 1}`),
      gatewayPort: port || current.gatewayPort,
      webuiUrl: current.webuiUrl || defaultNapcatWebuiUrl()
    });
  });

  return [...byKey.values()]
    .filter(item => {
      const httpPort = portFromLocalUrl(item.httpUrl);
      const webuiPort = portFromLocalUrl(item.webuiUrl);
      return Boolean((item.gatewayPort || httpPort) && (httpPort || webuiPort));
    })
    .map((item, index) => ({
      id: String(item.id || `discovered-${index + 1}`),
      name: String(item.name || item.id || `QQ ${index + 1}`),
      enabled: false,
      gatewayPort: Number(item.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + index + 1)),
      httpUrl: String(item.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000 + index)),
      webuiUrl: String(item.webuiUrl || defaultNapcatWebuiUrl()),
      accessToken: "",
      webuiToken: "",
      ...(item as Record<string, any>),
      __discovered: true
    } as NapCatInstance));
}

function napcatEndpointLabelFromInstance(instance: Partial<NapCatInstance> & Record<string, any>, fallback = "NapCat WebUI"): string {
  const base = String(instance.name || instance.id || "").trim();
  if (!base) return fallback;
  return /\bWebUI\b/i.test(base) ? base : `${base} WebUI`;
}

function normalizeNapcatDisplayName(value: unknown): string {
  return String(value || "")
    .replace(/\s*NapCat\s*WebUI$/i, "")
    .replace(/\s*WebUI$/i, "")
    .replace(/\s*NapCat$/i, "")
    .trim();
}

function napcatNamesLookRelated(left: unknown, right: unknown): boolean {
  const a = normalizeNapcatDisplayName(left);
  const b = normalizeNapcatDisplayName(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function napcatAccountRowKey(instance: NapCatInstance, source: NapCatAccountRow["source"], endpointLabel: string): string {
  const identity = String(instance.webuiUrl || instance.httpUrl || instance.gatewayPort || instance.id || endpointLabel || "unknown");
  return `${source}:${identity}`;
}

function napcatScanHealthForEndpoint(endpointLabel: string | undefined, webuiUrl: string): NapCatScanHealthEntry | undefined {
  const candidates = napcatScanHealthByWebui.value[webuiUrl] || [];
  if (candidates.length <= 1) return candidates[0];
  return candidates.find(item =>
    napcatNamesLookRelated(endpointLabel, item.gatewayName)
    || napcatNamesLookRelated(endpointLabel, item.instanceName)
    || (item.loginInfo?.source !== "webui" && napcatNamesLookRelated(endpointLabel, item.loginInfo?.nickname))
  ) || candidates[0];
}

function napcatScanWebuiRows(): NapCatAccountRow[] {
  const endpoints = messageScanFor("napcat")?.endpoints ?? [];
  return endpoints
    .filter(endpoint => endpoint?.url)
    .map((endpoint, index) => {
      const endpointLabel = String(endpoint.label || "");
      const scanHealth = napcatScanHealthForEndpoint(endpointLabel, endpoint.url);
      const gatewayMatched = (gateway.value?.napcatInstances ?? [])
        .find(instance =>
          String(instance.webuiUrl || "") === endpoint.url
          && (!endpointLabel || napcatNamesLookRelated(endpointLabel, instance.name || instance.id))
        );
      const anyMatched = store.gateways
        .flatMap(item => item.napcatInstances ?? [])
        .find(instance =>
          String(instance.webuiUrl || "") === endpoint.url
          && (!endpointLabel || napcatNamesLookRelated(endpointLabel, instance.name || instance.id))
        );
      const matched = gatewayMatched || anyMatched;
      const instance = gatewayMatched || {
        id: `webui-${portFromLocalUrl(endpoint.url) || index + 1}`,
        name: matched?.name || normalizeNapcatDisplayName(endpointLabel) || `QQ ${index + 1}`,
        enabled: false,
        gatewayPort: Number(scanHealth?.gatewayPort || matched?.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + index + 1)),
        httpUrl: matched?.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000 + index),
        webuiUrl: endpoint.url,
        accessToken: matched?.accessToken || "",
        webuiToken: matched?.webuiToken || "",
        botUserId: matched?.botUserId,
        botNickname: matched?.botNickname,
        __discovered: true
      } as NapCatInstance;
      const label = endpointLabel || napcatEndpointLabelFromInstance(instance);
      return {
        key: napcatAccountRowKey(instance, "scan", label),
        instance,
        endpointLabel: label,
        endpointHealthy: endpoint.healthy,
        source: "scan"
      };
    });
}

function napcatAccountRows(): NapCatAccountRow[] {
  const configured = ensureNapcatInstances();
  const scanRows = napcatScanWebuiRows();
  const rows: NapCatAccountRow[] = configured
    .filter(instance => !isIgnoredNapcatInstance(instance))
    .map(instance => {
      const scanned = scanRows.find(row =>
        sameNapcatInstance(row.instance as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>)
      );
      const label = scanned?.endpointLabel || napcatEndpointLabelFromInstance(instance);
      return {
        key: napcatAccountRowKey(instance, "configured", label),
        instance,
        endpointLabel: label,
        endpointHealthy: scanned?.endpointHealthy,
        source: "configured"
      };
    });
  const belongsToOtherGateway = (candidate: NapCatInstance): boolean => {
    return store.gateways.some(item =>
      item.id !== gateway.value?.id
      && (item.napcatInstances ?? []).some(instance =>
        sameNapcatInstance(instance as NapCatInstance & Record<string, any>, candidate as NapCatInstance & Record<string, any>)
      )
    );
  };
  const pushIfMissing = (candidate: NapCatInstance, source: NapCatAccountRow["source"], endpointLabel?: string, endpointHealthy?: boolean) => {
    if (isIgnoredNapcatInstance(candidate)) return;
    const exists = rows.some(row => sameNapcatInstance(row.instance as NapCatInstance & Record<string, any>, candidate as NapCatInstance & Record<string, any>));
    if (!exists) {
      const label = endpointLabel || napcatEndpointLabelFromInstance(candidate);
      rows.push({
        key: napcatAccountRowKey(candidate, source, label),
        instance: candidate,
        endpointLabel: label,
        endpointHealthy,
        source
      });
    }
  };
  for (const row of scanRows) {
    if (belongsToOtherGateway(row.instance)) continue;
    pushIfMissing(row.instance, "scan", row.endpointLabel, row.endpointHealthy);
  }
  for (const item of napcatRuntimeInstances()) {
    if (belongsToOtherGateway(item as NapCatInstance)) continue;
    const sourceInstanceId = String(item.id || item.instanceId || item.name || item.botUserId || item.userId || item.selfId || "");
    const port = Number(item.gatewayPort || item.port || item.wsPort || 0);
    const exists = rows.some(row => sameNapcatInstance(row.instance as NapCatInstance & Record<string, any>, item as Record<string, any>));
    if (exists) continue;
    const candidate = {
      id: scopedRuntimeNapcatId(item, sourceInstanceId, port) || `runtime-${rows.length + 1}`,
      sourceInstanceId,
      routeId: item.routeId,
      configName: item.configName,
      name: item.name || item.instanceName || "运行中 NapCat",
      enabled: false,
      gatewayPort: port || Number(gateway.value?.gatewayPort || 8790),
      httpUrl: item.httpUrl || item.napcatHttpUrl || gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl || item.napcatWebuiUrl || gateway.value?.napcatWebuiUrl,
      accessToken: item.accessToken || "",
      webuiToken: item.webuiToken || "",
      botUserId: item.botUserId || item.userId || item.selfId,
      botNickname: item.botNickname || item.nickname,
      connected: item.connected
    };
    pushIfMissing(candidate as NapCatInstance, "runtime");
  }
  for (const instance of napcatDiscoveredInstances()) {
    if (belongsToOtherGateway(instance)) continue;
    pushIfMissing(instance, "discovered");
  }
  return rows;
}

function napcatAccountInstances(): NapCatInstance[] {
  return ensureNapcatInstances().slice(0, 1);
}

function napcatAccountRowFor(instance: NapCatInstance): NapCatAccountRow | undefined {
  return napcatAccountRows().find(row => row.instance === instance || sameNapcatInstance(row.instance as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>));
}

function napcatDisplayEndpointLabel(instance: NapCatInstance): string {
  return napcatAccountRowFor(instance)?.endpointLabel || napcatEndpointLabelFromInstance(instance);
}

function napcatDisplayInstanceName(instance: NapCatInstance): string {
  const configuredName = String(instance.name || instance.id || "").trim();
  if (configuredName) return configuredName;
  return napcatDisplayEndpointLabel(instance)
    .replace(/\s*NapCat\s*WebUI$/i, " NapCat")
    .replace(/\s*WebUI$/i, "")
    .trim() || "QQ 实例";
}

function napcatDisplayEndpointHealthy(instance: NapCatInstance): boolean | undefined {
  return napcatAccountRowFor(instance)?.endpointHealthy;
}

function napcatWebuiStatusLabel(instance: NapCatInstance): string {
  const reachable = napcatHealthFor(instance).webui?.reachable;
  if (reachable === true) return "可用";
  if (reachable === false) return "未响应";
  const healthy = napcatDisplayEndpointHealthy(instance);
  if (healthy === true) return "可用";
  if (healthy === false) return "未响应";
  return "未扫描";
}

function napcatWebuiStatusClass(instance: NapCatInstance): string {
  const reachable = napcatHealthFor(instance).webui?.reachable;
  if (reachable === true) return "text-success";
  if (reachable === false) return "text-warning";
  const healthy = napcatDisplayEndpointHealthy(instance);
  if (healthy === true) return "text-success";
  if (healthy === false) return "text-warning";
  return "text-info";
}

function isDiscoveredNapcatAccount(instance: NapCatInstance): boolean {
  const row = napcatAccountRowFor(instance);
  return Boolean((instance as Record<string, any>).__discovered || (row && row.source !== "configured" && !isConfiguredNapcatInstance(instance)));
}

function addDiscoveredNapcatInstance(instance: NapCatInstance): void {
  clearIgnoredNapcatInstance(instance);
  const clean = { ...instance } as NapCatInstance & Record<string, any>;
  delete clean.__discovered;
  delete clean.sourceInstanceId;
  delete clean.routeId;
  delete clean.configName;
  delete clean.botUserId;
  delete clean.botNickname;
  delete clean.connected;
  clean.enabled = true;
  clean.name = clean.name || "NapCat";
  clean.gatewayPort = Number(clean.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + 1));
  clean.httpUrl = clean.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000);
  clean.webuiUrl = clean.webuiUrl || defaultNapcatWebuiUrl();
  if (gateway.value) gateway.value.napcatInstances = [clean];
  syncPrimaryNapcatFromInstances();
  store.touch();
}

function matchingDiscoveredNapcatInstance(instance: NapCatInstance): NapCatInstance | undefined {
  const id = String(instance.id || "");
  const port = Number(instance.gatewayPort || 0);
  const httpUrl = String(instance.httpUrl || "");
  return napcatDiscoveredInstances().find(item =>
    (id && String(item.id) === id) ||
    (port && Number(item.gatewayPort || 0) === port) ||
    (httpUrl && String(item.httpUrl || "") === httpUrl)
  );
}

async function autofillNapcatInstance(instance: NapCatInstance): Promise<boolean> {
  if (!messageAdapterScan.value.adapters.napcat && !messageAdapterScan.value.loading) {
    await runMessageAdapterScan();
  }
  const discovered = matchingDiscoveredNapcatInstance(instance);
  const template = recentNapcatTemplate();
  let changed = false;
  const fill = <K extends keyof NapCatInstance>(key: K, value: NapCatInstance[K] | undefined): void => {
    if (instance[key] != null && String(instance[key]).trim()) return;
    if (value == null || !String(value).trim()) return;
    instance[key] = value;
    changed = true;
  };

  fill("httpUrl", discovered?.httpUrl || template.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000));
  fill("webuiUrl", discovered?.webuiUrl || template.webuiUrl || defaultNapcatWebuiUrl());
  fill("accessToken", template.accessToken || "");
  fill("launchCommand", discovered?.launchCommand || template.launchCommand);
  fill("workingDir", discovered?.workingDir || template.workingDir);
  if (!isValidPort(instance.gatewayPort)) {
    instance.gatewayPort = discovered?.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + 1);
    changed = true;
  }
  if (changed) {
    syncPrimaryNapcatFromInstances();
    store.touch();
  }
  return changed;
}

function webuiTokenMissing(body: Record<string, any>): boolean {
  return !(body.webui?.tokenFound || body.webui?.found);
}

async function launchNapcatInstanceAndRecheck(
  instance: NapCatInstance,
  startMessage = "NapCat WebUI 未响应，正在启动 NapCat 后台...",
  healthPayloadPatch: Record<string, unknown> = {},
  options: { forceRestart?: boolean; visible?: boolean } = {}
): Promise<{ ok: boolean; message: string; target: NapCatInstance; health?: Record<string, any>; launch?: Record<string, any> }> {
  if (!gateway.value) {
    return { ok: false, message: "当前路由未加载，无法启动 NapCat。", target: instance };
  }
  if (!instance.launchCommand || !isConfiguredNapcatInstance(instance)) {
    return {
      ok: false,
      message: "NapCat 管理服务未响应，且此 QQ 实例没有可用启动命令。",
      target: instance
    };
  }
  launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: true };
  napcatLaunchResult.value = {
    ...napcatLaunchResult.value,
    [instance.id]: { ok: true, message: startMessage }
  };
  try {
    const launchResp = await fetch("/api/message/napcat-launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gatewayId: gateway.value.id,
        instanceId: instance.id,
        forceRestart: options.forceRestart === true,
        visible: options.visible === true
      })
    });
    const launchBody = await launchResp.json().catch(() => ({}));
    const launchOk = launchResp.ok && launchBody.ok !== false;
    const launchMessage = launchBody.message || (launchOk ? "已尝试启动 NapCat 后台，正在复查。" : "启动失败。");
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: launchOk, message: launchMessage }
    };
    if (!launchOk) return { ok: false, message: launchMessage, target: instance, launch: launchBody };

    await sleep(2500);
    let target = resolveConfiguredNapcatInstance(instance);
    const health = await runNapcatInstanceHealth(target, healthPayloadPatch);
    if (applyNapcatHealthToInstance(target, health) && store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }
    return { ok: true, message: launchMessage, target, health, launch: launchBody };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message }
    };
    return { ok: false, message, target: instance };
  } finally {
    launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function runNapcatInstanceHealth(instance: NapCatInstance, payloadPatch: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const resp = await fetch("/api/message/napcat-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...napcatHealthPayload(instance), ...payloadPatch })
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: Boolean(body.ok), ...body };
}

function resolveConfiguredNapcatInstance(instance: NapCatInstance): NapCatInstance {
  return ensureNapcatInstances().find(item => item.id === instance.id) ?? instance;
}

function applyNapcatHealthToInstance(instance: NapCatInstance, body: Record<string, any>, options: { updateConfig?: boolean } = {}): boolean {
  if (options.updateConfig === false) return false;
  let changed = false;
  const userId = body.http?.userId || (body.loginInfo?.source !== "webui" ? body.loginInfo?.userId : "");
  const nickname = body.http?.nickname || (body.loginInfo?.source !== "webui" ? body.loginInfo?.nickname : "");
  if (userId && !instance.botUserId) {
    instance.botUserId = userId;
    changed = true;
  }
  if (nickname && !instance.botNickname) {
    instance.botNickname = nickname;
    changed = true;
  }
  const correctedWebuiUrl = body.webui?.correctedUrl || body.webui?.correctedWebuiUrl || body.webui?.url;
  if (correctedWebuiUrl && instance.webuiUrl !== correctedWebuiUrl) {
    instance.webuiUrl = correctedWebuiUrl;
    changed = true;
  }
  if (changed) store.touch();
  return changed;
}

async function applyNapcatScanHealth(payload: unknown): Promise<void> {
  if (!gateway.value || !payload || typeof payload !== "object") return;
  const byGateway = payload as Record<string, { instances?: Record<string, Record<string, any>> }>;
  const nextByWebui: Record<string, NapCatScanHealthEntry[]> = {};
  for (const [gatewayName, gatewayHealth] of Object.entries(byGateway)) {
    const instances = gatewayHealth?.instances;
    if (!instances || typeof instances !== "object") continue;
    for (const [instanceName, raw] of Object.entries(instances)) {
      const body = { ok: Boolean(raw?.ok), ...(raw || {}), gatewayName, instanceName } as NapCatScanHealthEntry;
      const webuiUrl = String(body.webui?.url || body.webui?.configuredUrl || "");
      if (!webuiUrl) continue;
      nextByWebui[webuiUrl] = [...(nextByWebui[webuiUrl] || []), body];
    }
  }
  napcatScanHealthByWebui.value = nextByWebui;
  const current = byGateway[gateway.value.id]?.instances;
  if (!current || typeof current !== "object") return;
  const nextHealth = { ...napcatInstanceHealthResult.value };
  const nextPaused = { ...napcatHealthPausedAfterFix.value };
  for (const [id, raw] of Object.entries(current)) {
    const body = { ok: Boolean(raw?.ok), ...(raw || {}) };
    nextHealth[id] = body;
    delete nextPaused[id];
  }
  napcatInstanceHealthResult.value = nextHealth;
  napcatHealthPausedAfterFix.value = nextPaused;
}

function napcatHealthUserId(body: Record<string, any>): string {
  return String(body.http?.userId || body.loginInfo?.userId || body.webui?.loginInfo?.userId || "");
}

function napcatHealthShowsExpectedLogin(instance: NapCatInstance, body: Record<string, any> | undefined): boolean {
  if (!body) return false;
  const qqLoggedIn = Boolean(
    body.http?.ok
    || body.http?.online === true
    || (body.loginInfo?.source !== "webui" && body.loginInfo?.online === true)
    || (body.loginInfo?.source === "webui" && body.loginInfo?.online === true)
    || body.webui?.loginInfo?.online === true
  );
  if (!qqLoggedIn) return false;
  const expected = napcatExpectedUserId(instance);
  const actual = napcatHealthUserId(body);
  return !expected || !actual || expected === actual;
}

function scheduleNapcatLoginRecheck(instance: NapCatInstance): void {
  for (const delay of [8000, 20000, 45000]) {
    window.setTimeout(async () => {
      const target = resolveConfiguredNapcatInstance(instance);
      try {
        const health = await runNapcatInstanceHealth(target);
        napcatInstanceHealthResult.value = {
          ...napcatInstanceHealthResult.value,
          [target.id]: health
        };
        if (napcatHealthShowsExpectedLogin(target, health)) {
          napcatLaunchResult.value = {
            ...napcatLaunchResult.value,
            [target.id]: {
              ok: true,
              message: "QQ 已登录，NapCat 已进入可用状态。"
            }
          };
        }
      } catch {
        // The visible health panel already keeps the latest explicit check result.
      }
    }, delay);
  }
}

function napcatLoginUi(instance: NapCatInstance): NapcatLoginUiState {
  const existing = napcatLoginPanels.value[instance.id];
  if (existing) return existing;
  const created: NapcatLoginUiState = {
    visible: false,
    loading: false,
    busy: false,
    mode: "quick",
    quickUserId: String(instance.botUserId || ""),
    userId: String(instance.botUserId || ""),
    password: "",
    message: "",
    error: "",
    panel: null,
    captcha: null,
    newDevice: null
  };
  napcatLoginPanels.value = { ...napcatLoginPanels.value, [instance.id]: created };
  return created;
}

function napcatQuickLoginOptions(instance: NapCatInstance): Array<{ title: string; value: string }> {
  return (napcatLoginUi(instance).panel?.quickAccounts ?? []).map(account => ({
    title: account.nickname ? `${account.nickname}（${account.userId}）` : `QQ ${account.userId}`,
    value: account.userId
  }));
}

async function loadNapcatLoginPanel(instance: NapCatInstance): Promise<void> {
  const target = resolveConfiguredNapcatInstance(instance);
  const ui = napcatLoginUi(target);
  ui.loading = true;
  ui.error = "";
  try {
    const response = await fetch("/api/message/napcat-login-panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value?.id, instanceId: target.id })
    });
    const body = await response.json().catch(() => ({})) as NapcatLoginPanelData;
    if (!response.ok || body.ok === false) throw new Error(body.message || "NapCat 登录控制加载失败。");
    ui.panel = body;
    ui.message = body.message || "";
    const expected = String(body.expectedUserId || target.botUserId || "");
    const firstQuick = body.quickAccounts?.find(account => account.userId === expected)
      ?? body.quickAccounts?.find(account => account.quickLoginAvailable)
      ?? body.quickAccounts?.[0];
    if (!ui.quickUserId) ui.quickUserId = firstQuick?.userId || expected;
    if (!ui.userId) ui.userId = expected || firstQuick?.userId || "";
    if (!body.loggedIn && ui.mode === "quick" && !body.quickAccounts?.length) ui.mode = "qrcode";
    if (body.loggedIn) {
      ui.password = "";
      ui.captcha = null;
      cancelNapcatNewDevice(target);
    }
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.loading = false;
  }
}

async function postNapcatLoginAction(instance: NapCatInstance, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch("/api/message/napcat-login-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gatewayId: gateway.value?.id, instanceId: instance.id, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.message || "NapCat 登录请求失败。");
  return body;
}

function scheduleNapcatPanelRefresh(instance: NapCatInstance): void {
  for (const delay of [1500, 5000, 10000]) {
    window.setTimeout(() => {
      const ui = napcatLoginUi(instance);
      if (!ui.visible) return;
      void loadNapcatLoginPanel(resolveConfiguredNapcatInstance(instance));
    }, delay);
  }
  scheduleNapcatLoginRecheck(instance);
}

async function submitNapcatQuickLogin(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.quickUserId) {
    ui.error = "当前没有可用的快速登录账号。";
    return;
  }
  ui.busy = true;
  ui.error = "";
  try {
    const result = await postNapcatLoginAction(instance, { action: "quick-login", userId: ui.quickUserId });
    ui.message = result.message || "已提交快速登录请求。";
    scheduleNapcatPanelRefresh(instance);
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.busy = false;
  }
}

async function refreshNapcatLoginQr(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  ui.busy = true;
  ui.error = "";
  try {
    const result = await postNapcatLoginAction(instance, { action: "refresh-qr" });
    ui.message = result.message || "已刷新二维码。";
    await sleep(350);
    await loadNapcatLoginPanel(instance);
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.busy = false;
  }
}

async function handleNapcatPasswordChallenge(instance: NapCatInstance, result: Record<string, any>): Promise<void> {
  const ui = napcatLoginUi(instance);
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, any> : {};
  if (data.needCaptcha && data.proofWaterUrl) {
    ui.captcha = { proofWaterUrl: String(data.proofWaterUrl) };
    ui.message = "QQ 要求完成安全验证码。";
    return;
  }
  if (data.needNewDevice && data.jumpUrl) {
    ui.newDevice = {
      jumpUrl: String(data.jumpUrl),
      newDevicePullQrCodeSig: String(data.newDevicePullQrCodeSig || ""),
      qrCodeDataUrl: "",
      bytesToken: "",
      status: "loading"
    };
    ui.message = "QQ 检测到新设备，请扫码确认。";
    await prepareNapcatNewDeviceQr(instance);
    return;
  }
  ui.message = result.message || "已提交密码登录请求。";
  scheduleNapcatPanelRefresh(instance);
}

async function submitNapcatPasswordLogin(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.userId || !ui.password) {
    ui.error = "请填写 QQ 号和密码。";
    return;
  }
  ui.busy = true;
  ui.error = "";
  ui.captcha = null;
  cancelNapcatNewDevice(instance);
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "password-login",
      userId: ui.userId,
      password: ui.password
    });
    await handleNapcatPasswordChallenge(instance, result);
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.busy = false;
  }
}

async function loadTencentCaptchaScript(): Promise<void> {
  const captchaWindow = window as Window & { TencentCaptcha?: unknown };
  if (captchaWindow.TencentCaptcha) return;
  const existing = document.querySelector<HTMLScriptElement>('script[data-rabi-napcat-captcha="true"]');
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("QQ 验证码脚本加载失败。")), { once: true });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://captcha.gtimg.com/TCaptcha.js";
    script.dataset.rabiNapcatCaptcha = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("QQ 验证码脚本加载失败。"));
    document.head.appendChild(script);
  });
}

async function startNapcatCaptcha(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  const proofWaterUrl = ui.captcha?.proofWaterUrl;
  if (!proofWaterUrl) return;
  ui.busy = true;
  ui.error = "";
  try {
    await loadTencentCaptchaScript();
    const parsed = new URL(proofWaterUrl);
    const appId = parsed.searchParams.get("aid") || "2081081773";
    const sid = parsed.searchParams.get("sid") || "";
    const Captcha = (window as Window & {
      TencentCaptcha?: new (
        appId: string,
        callback: (result: { ret?: number; ticket?: string; randstr?: string }) => void,
        options?: Record<string, unknown>
      ) => { show(): void; destroy?(): void };
    }).TencentCaptcha;
    if (!Captcha) throw new Error("QQ 验证码组件没有正确加载。");
    let captcha: { show(): void; destroy?(): void } | null = null;
    captcha = new Captcha(appId, (result) => {
      captcha?.destroy?.();
      if (result.ret !== 0 || !result.ticket || !result.randstr) {
        ui.busy = false;
        ui.error = "验证码未完成，请重试。";
        return;
      }
      void submitNapcatCaptcha(instance, result.ticket, result.randstr, sid);
    }, {
      type: "popup",
      showHeader: false,
      login_appid: parsed.searchParams.get("login_appid") || undefined,
      uin: parsed.searchParams.get("uin") || ui.userId,
      sid,
      enableAged: true
    });
    captcha.show();
  } catch (error) {
    ui.busy = false;
    ui.error = error instanceof Error ? error.message : String(error);
  }
}

async function submitNapcatCaptcha(instance: NapCatInstance, ticket: string, randstr: string, sid: string): Promise<void> {
  const ui = napcatLoginUi(instance);
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "captcha-login",
      userId: ui.userId,
      password: ui.password,
      ticket,
      randstr,
      sid
    });
    ui.captcha = null;
    await handleNapcatPasswordChallenge(instance, result);
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.busy = false;
  }
}

function cancelNapcatNewDevice(instance: NapCatInstance): void {
  const timer = napcatNewDevicePollTimers.get(instance.id);
  if (timer) window.clearTimeout(timer);
  napcatNewDevicePollTimers.delete(instance.id);
  const ui = napcatLoginPanels.value[instance.id];
  if (ui) ui.newDevice = null;
}

async function prepareNapcatNewDeviceQr(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.newDevice) return;
  ui.newDevice.status = "loading";
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "new-device-qr",
      userId: ui.userId,
      jumpUrl: ui.newDevice.jumpUrl
    });
    if (!ui.newDevice) return;
    ui.newDevice.qrCodeDataUrl = String(result.data?.qrCodeDataUrl || "");
    ui.newDevice.bytesToken = String(result.data?.bytes_token || "");
    if (!ui.newDevice.qrCodeDataUrl || !ui.newDevice.bytesToken) throw new Error("新设备二维码内容不完整，请重试。");
    ui.newDevice.status = "waiting";
    scheduleNapcatNewDevicePoll(instance);
  } catch (error) {
    if (ui.newDevice) ui.newDevice.status = "error";
    ui.error = error instanceof Error ? error.message : String(error);
  }
}

function scheduleNapcatNewDevicePoll(instance: NapCatInstance): void {
  const current = napcatNewDevicePollTimers.get(instance.id);
  if (current) window.clearTimeout(current);
  const timer = window.setTimeout(() => void pollNapcatNewDevice(instance), 2500);
  napcatNewDevicePollTimers.set(instance.id, timer);
}

async function pollNapcatNewDevice(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  const challenge = ui.newDevice;
  if (!challenge?.bytesToken) return;
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "new-device-poll",
      userId: ui.userId,
      bytesToken: challenge.bytesToken
    });
    const status = Number(result.data?.uint32_guarantee_status ?? -1);
    if (status === 3) challenge.status = "scanned";
    if (status === 1) {
      challenge.status = "confirmed";
      const token = String(result.data?.str_nt_succ_token || challenge.newDevicePullQrCodeSig || "");
      const login = await postNapcatLoginAction(instance, {
        action: "new-device-login",
        userId: ui.userId,
        password: ui.password,
        newDevicePullQrCodeSig: token
      });
      cancelNapcatNewDevice(instance);
      await handleNapcatPasswordChallenge(instance, login);
      return;
    }
    scheduleNapcatNewDevicePoll(instance);
  } catch (error) {
    if (ui.newDevice) ui.newDevice.status = "error";
    ui.error = error instanceof Error ? error.message : String(error);
  }
}

async function startNapcatAndManage(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  let target = resolveConfiguredNapcatInstance(instance);
  managingNapcatLogin.value = { ...managingNapcatLogin.value, [instance.id]: true };
  napcatLaunchResult.value = {
    ...napcatLaunchResult.value,
    [instance.id]: { ok: true, message: "正在准备 QQ，请稍候..." }
  };
  try {
    await autofillNapcatInstance(target);
    autoAssignNapcatPortsForAllGateways();
    if (store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }
    const response = await fetch("/api/message/napcat-ensure-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: target.id })
    });
    const body = await response.json().catch(() => ({}));
    if (body.health) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [target.id]: { ok: Boolean(body.health.ok), ...body.health }
      };
      if (applyNapcatHealthToInstance(target, body.health) && store.dirty) {
        await store.save();
        target = resolveConfiguredNapcatInstance(target);
      }
    }
    if (body.needsUserAction === true) scheduleNapcatLoginRecheck(target);
    const loginUi = napcatLoginUi(target);
    loginUi.visible = true;
    await loadNapcatLoginPanel(target);
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [target.id]: {
        ok: response.ok && body.ok !== false,
        message: body.message || (response.ok ? "NapCat 已启动，登录控制已加载。" : "NapCat 暂时无法启动，请再试一次。")
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    managingNapcatLogin.value = { ...managingNapcatLogin.value, [instance.id]: false };
  }
}

function napcatLoginState(instance: NapCatInstance): string {
  return String(napcatHealthFor(instance).loginState || "");
}

function napcatAccountOwner(instance: NapCatInstance): Record<string, any> | null {
  const owner = napcatHealthFor(instance).accountOwner;
  return owner && typeof owner === "object" ? owner : null;
}

function napcatAccountOwnerLabel(instance: NapCatInstance): string {
  const owner = napcatAccountOwner(instance);
  if (!owner) return "";
  const account = owner.nickname
    ? `QQ ${owner.userId || napcatExpectedUserId(instance)} / ${owner.nickname}`
    : `QQ ${owner.userId || napcatExpectedUserId(instance)}`;
  return `${account} 正在 ${owner.instanceName || owner.workingDir || owner.httpUrl || "另一 NapCat 实例"} 在线`;
}

async function adoptNapcatAccountOwner(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  const owner = napcatAccountOwner(instance);
  if (!owner?.httpUrl) return;
  const expected = napcatExpectedUserId(instance);
  const actual = String(owner.userId || "");
  if (expected && actual && expected !== actual) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: `在线实例属于 QQ ${actual}，与当前绑定 QQ ${expected} 不一致，未采用。` }
    };
    return;
  }
  adoptingNapcatOwner.value = { ...adoptingNapcatOwner.value, [instance.id]: true };
  try {
    const target = resolveConfiguredNapcatInstance(instance);
    target.httpUrl = String(owner.httpUrl);
    if (owner.webuiUrl) target.webuiUrl = String(owner.webuiUrl);
    if (owner.workingDir) target.workingDir = String(owner.workingDir);
    syncPrimaryNapcatFromInstances();
    store.touch();
    await store.save();
    const health = await runNapcatInstanceHealth(target);
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: health
    };
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [target.id]: {
        ok: Boolean(health.ok),
        message: health.ok
          ? "已采用现有在线 NapCat，会话未被中断。"
          : owner.routesToGateway
            ? "已采用在线实例，但健康检查尚未通过，请稍后再检查。"
            : "已采用在线实例；它尚未连接当前 RabiRoute，请在详情中修复 OneBot 路由。"
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    adoptingNapcatOwner.value = { ...adoptingNapcatOwner.value, [instance.id]: false };
  }
}

function napcatExpectedUserId(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || "");
}

function napcatWebuiSessionUserId(instance: NapCatInstance): string {
  const health = napcatHealthFor(instance);
  return String(health.webui?.loginInfo?.userId || (health.loginInfo?.source === "webui" ? health.loginInfo?.userId : "") || "");
}

function napcatWebuiSessionLabel(instance: NapCatInstance): string {
  const health = napcatHealthFor(instance);
  const userId = napcatWebuiSessionUserId(instance);
  const nickname = String(health.webui?.loginInfo?.nickname || (health.loginInfo?.source === "webui" ? health.loginInfo?.nickname : "") || "");
  if (userId && nickname) return `QQ ${userId} / ${nickname}`;
  if (userId) return `QQ ${userId}`;
  return "";
}

function napcatWebuiSessionMismatch(instance: NapCatInstance): boolean {
  const expected = napcatExpectedUserId(instance);
  const webuiUser = napcatWebuiSessionUserId(instance);
  return Boolean(expected && webuiUser && expected !== webuiUser);
}

function napcatInstanceCanBeManaged(instance: NapCatInstance): boolean {
  return Boolean(instance.launchCommand?.trim() && instance.workingDir?.trim());
}

function normalizedLocalEndpoint(value: string | undefined): string {
  try {
    const parsed = new URL(value || "");
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${parsed.hostname}:${port}`.toLowerCase();
  } catch {
    return "";
  }
}

async function cleanupNapcatInstancesAfterScan(): Promise<boolean> {
  if (!gateway.value || !gatewayAdapterTypes(gateway.value).includes("napcat")) return false;
  const instances = Array.isArray(gateway.value.napcatInstances) ? gateway.value.napcatInstances : [];
  if (instances.length === 0) return false;

  let changed = false;
  const seenUsers = new Set<string>();
  const seenWebui = new Set<string>();
  const seenHttp = new Set<string>();
  const seenWs = new Set<number>();
  const kept: NapCatInstance[] = [];

  for (const instance of instances) {
    let health: Record<string, any> = {};
    try {
      health = await runNapcatInstanceHealth(instance);
      napcatInstanceHealthResult.value[instance.id] = health;
      if (applyNapcatHealthToInstance(instance, health)) changed = true;
    } catch {
      health = {};
    }

    const userId = napcatHealthUserId(health) || String(instance.botUserId || "");
    const webuiKey = normalizedLocalEndpoint(instance.webuiUrl);
    const httpKey = normalizedLocalEndpoint(instance.httpUrl);
    const wsPort = Number(instance.gatewayPort || 0);
    const healthy = Boolean(health.ok || userId);
    const manageable = napcatInstanceCanBeManaged(instance);
    const duplicateUser = Boolean(userId && seenUsers.has(userId));
    const duplicateWebui = Boolean(webuiKey && seenWebui.has(webuiKey));
    const duplicateHttp = Boolean(httpKey && seenHttp.has(httpKey));
    const duplicateWs = Boolean(Number.isInteger(wsPort) && wsPort > 0 && seenWs.has(wsPort));
    const staleGenerated = !manageable && !healthy;
    const duplicate = duplicateUser || duplicateWebui || duplicateHttp || duplicateWs;

    if (duplicate || staleGenerated) {
      changed = true;
      continue;
    }

    kept.push(instance);
    if (userId) seenUsers.add(userId);
    if (webuiKey) seenWebui.add(webuiKey);
    if (httpKey) seenHttp.add(httpKey);
    if (Number.isInteger(wsPort) && wsPort > 0) seenWs.add(wsPort);
  }

  if (kept.length !== instances.length) {
    gateway.value.napcatInstances = kept;
    changed = true;
  }
  if (autoAssignNapcatPortsForAllGateways()) changed = true;
  syncPrimaryNapcatFromInstances();
  if (changed) store.touch();
  return changed;
}

function collectUsedWsPorts(excludeInstance?: NapCatInstance): Set<number> {
  const used = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) used.add(port);
  };
  claim(store.meta.managerPort || 0);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("fennenote")) claim(item.fenneNoteWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("xiaoai")) claim(item.xiaoaiWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("rabilink")) claim(item.rabiLinkWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    for (const instance of item.napcatInstances ?? []) {
      if (excludeInstance && item.id === gateway.value?.id && instance.id === excludeInstance.id) continue;
      if (instance.enabled === false) continue;
      claim(instance.gatewayPort);
    }
  }
  return used;
}

async function fixNapcatPorts(instance?: NapCatInstance): Promise<void> {
  if (fixingNapcatPorts.value) return;
  fixingNapcatPorts.value = true;
  const resultKey = instance?.id || "_global";
  try {
    const beforePort = Number(instance?.gatewayPort || 0);
    if (instance && !isConfiguredNapcatInstance(instance)) {
      addDiscoveredNapcatInstance(instance);
    }
    autoAssignNapcatPortsForAllGateways();
    if (instance) {
      const target = resolveConfiguredNapcatInstance(instance);
      if (Number(target.gatewayPort || 0) === beforePort || !isValidPort(target.gatewayPort)) {
        const used = collectUsedWsPorts(target);
        target.gatewayPort = allocateAvailablePort(used, Math.max(beforePort + 1, Number(gateway.value?.gatewayPort || 8789) + 1));
        syncPrimaryNapcatFromInstances();
        store.touch();
      }
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [target.id]: {
          ok: true,
          fixAvailable: false,
          message: `已自动分配 RabiRoute WS 端口：${target.gatewayPort}。请把对应 NapCat WebSocket Client 连接到 ws://127.0.0.1:${target.gatewayPort}。`,
          diagnostics: ["旧检查结果已失效，请在 NapCat 侧重载网络配置后再点检查。"],
          wsUrl: `ws://127.0.0.1:${target.gatewayPort}`
        }
      };
      napcatPortFixResult.value = {
        ...napcatPortFixResult.value,
        [resultKey]: { ok: true, message: `已分配端口 ${target.gatewayPort} 并保存。` }
      };
    }
    if (store.dirty) {
      await store.save();
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    store.error = message;
    napcatPortFixResult.value = {
      ...napcatPortFixResult.value,
      [resultKey]: { ok: false, message }
    };
  } finally {
    fixingNapcatPorts.value = false;
  }
}

async function configureNapcatOneBot(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  if (napcatWebuiSessionMismatch(instance)) {
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [instance.id]: {
        ok: false,
        message: `当前 WebUI 登录的是 ${napcatWebuiSessionLabel(instance)}，但这个实例绑定的是 QQ ${napcatExpectedUserId(instance)}；请先在对应 NapCat WebUI 切换到正确账号后再修复。`
      }
    };
    return;
  }
  configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: true };
  napcatOneBotFixResult.value = { ...napcatOneBotFixResult.value, [instance.id]: { ok: true, message: "正在写入 NapCat OneBot 配置..." } };
  try {
    let target = resolveConfiguredNapcatInstance(instance);
    const resp = await fetch("/api/message/napcat-configure-onebot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(target))
    });
    const body = await resp.json().catch(() => ({}));
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [target.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已写入 NapCat OneBot 配置。" : "写入失败。")
      }
    };
    if (body.userId && !target.botUserId) target.botUserId = body.userId;
    if (body.nickname && !target.botNickname) target.botNickname = body.nickname;
    if (body.userId || body.nickname) {
      store.touch();
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: {
        ok: Boolean(body.httpReady),
        fixAvailable: false,
        message: body.message || "已写入 NapCat OneBot 配置；请重载 NapCat 网络配置后复查。",
        diagnostics: Array.isArray(body.steps) && body.steps.length
          ? body.steps
          : ["配置已写入当前登录 QQ 的 OneBot 文件。", "如果 HTTP 仍未连通，请稍后再点检查。"],
        onebot: {
          ...(napcatInstanceHealthResult.value[target.id]?.onebot || {}),
          currentUserId: body.userId,
          currentNickname: body.nickname,
          configPath: body.configPath
        },
        wsUrl: body.wsUrl || napcatInstanceWsUrl(target)
      }
    };
    napcatHealthPausedAfterFix.value = {
      ...napcatHealthPausedAfterFix.value,
      [target.id]: true,
      [instance.id]: true
    };
  } catch (e: unknown) {
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: false };
  }
}

function napcatRuntimeFor(instance: NapCatInstance): Record<string, any> {
  const id = String(instance.id || "");
  const port = Number(instance.gatewayPort || 0);
  const found = napcatRuntimeInstances().find(item =>
    sameNapcatInstance(instance as NapCatInstance & Record<string, any>, item as Record<string, any>)
  );
  if (found) return found;
  if (id === "default" || port === Number(gateway.value?.gatewayPort || 0)) return napcatState.value;
  return {};
}

function napcatHealthFor(instance: NapCatInstance): Record<string, any> {
  const byId = napcatInstanceHealthResult.value[instance.id];
  if (byId) return byId;
  const candidates = napcatScanHealthByWebui.value[String(instance.webuiUrl || "")] || [];
  if (candidates.length === 0) return {};
  const port = Number(instance.gatewayPort || 0);
  return candidates.find(item => Number(item.gatewayPort || 0) === port)
    || candidates.find(item => napcatNamesLookRelated(instance.name || instance.id, item.gatewayName) || napcatNamesLookRelated(instance.name || instance.id, item.instanceName))
    || candidates[0]
    || {};
}

function napcatAccountUserId(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || (health.loginInfo?.source !== "webui" ? health.loginInfo?.userId : "") || "");
}

function napcatAccountNickname(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botNickname || runtimeInfo.botNickname || runtimeInfo.nickname || health.http?.nickname || (health.loginInfo?.source !== "webui" ? health.loginInfo?.nickname : "") || "");
}

function napcatMeaningfulNickname(instance: NapCatInstance): string {
  const nickname = napcatAccountNickname(instance).trim();
  if (!nickname || /^QQ小助手$/i.test(nickname)) return "";
  return nickname;
}

function napcatAccountTitle(instance: NapCatInstance): string {
  if (managingNapcatLogin.value[instance.id]) return "正在准备登录控制";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动 NapCat";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询 QQ 状态";
  return napcatDisplayInstanceName(instance);
}

function napcatAccountSubtitle(instance: NapCatInstance): string {
  if (managingNapcatLogin.value[instance.id]) return "正在启动 NapCat 并加载登录状态...";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动 NapCat 后台...";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "加载 NapCat 登录资料...";
  const userId = napcatAccountUserId(instance);
  const nickname = napcatMeaningfulNickname(instance);
  if (userId && nickname) return `QQ ${userId} / ${nickname}`;
  if (userId) return `QQ ${userId}`;
  return "等待 QQ 登录";
}

function napcatAccountLogTitle(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const nickname = napcatMeaningfulNickname(instance);
  if (userId && nickname) return `${userId} / ${nickname}`;
  return userId || nickname || napcatDisplayInstanceName(instance);
}

function napcatAccountConnected(instance: NapCatInstance): boolean {
  if (napcatAccountOffline(instance)) return false;
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  if (typeof instance.connected === "boolean") return instance.connected;
  if (typeof runtimeInfo.connected === "boolean") return runtimeInfo.connected;
  if (health.http?.ok) return true;
  if (health.loginInfo?.source !== "webui" && health.loginInfo?.online === true) return true;
  return false;
}

function napcatAccountOffline(instance: NapCatInstance): boolean {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return runtimeInfo.online === false
    || runtimeInfo.good === false
    || health.http?.online === false
    || health.http?.good === false
    || (health.loginInfo?.source !== "webui" && health.loginInfo?.online === false)
    || /online:false|已离线/.test(String(runtimeInfo.loginInfoError || instance.loginInfoError || ""));
}

function napcatPrimaryOffline(): boolean {
  return napcatState.value.online === false
    || napcatState.value.good === false
    || /online:false|已离线/.test(String(napcatState.value.loginInfoError || ""));
}

function napcatAccountLoginLabel(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询";
  if (napcatLoginState(instance) === "account-online-elsewhere") return "QQ 在其他实例在线";
  if (napcatLoginState(instance) === "quick-login-invalid") return "快速登录已过期，需扫码";
  if (napcatLoginState(instance) === "qr-login-required") return "无快速登录身份，需扫码";
  if (napcatLoginState(instance) === "login-conflict") return "QQ 登录冲突";
  if (napcatLoginState(instance) === "account-mismatch") return "WebUI 登录了其他 QQ";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return String(runtimeInfo.loginInfoError || instance.loginInfoError);
  if (napcatAccountConnected(instance) || health.http?.ok) return "已登录";
  if (userId) return "已绑定 QQ";
  if (napcatHealthFor(instance).webui?.loginInfo?.userId) return "WebUI 有其他账号会话";
  return "等待 QQ 登录";
}

function napcatAccountLoginClass(instance: NapCatInstance): string {
  if (napcatLoginState(instance) === "account-online-elsewhere") return "text-warning";
  if (["quick-login-invalid", "qr-login-required", "login-conflict", "account-mismatch"].includes(napcatLoginState(instance))) return "text-error";
  if (napcatAccountOffline(instance)) return "text-error";
  if (napcatAccountConnected(instance) || napcatHealthFor(instance).http?.ok) return "text-success";
  if (napcatAccountUserId(instance) || napcatWebuiSessionUserId(instance)) return "text-info";
  return "text-warning";
}

function isValidPort(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function napcatInstancePortError(instance: NapCatInstance): string {
  return isValidPort(instance.gatewayPort) ? "" : "端口必须是 1-65535 的整数";
}

function napcatInstanceStatusLabel(instance: NapCatInstance): string {
  if (isDiscoveredNapcatAccount(instance)) return "已发现";
  if (managingNapcatLogin.value[instance.id]) return "正在准备";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动";
  if (restartingNapcatInstance.value[instance.id]) return "正在重启";
  if (instance.enabled === false) return "已停用";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "查询中";
  if (napcatLoginState(instance) === "account-online-elsewhere") return "账号在别处在线";
  if (napcatLoginState(instance) === "quick-login-invalid") return "需要扫码";
  if (napcatLoginState(instance) === "qr-login-required") return "需要扫码";
  if (napcatLoginState(instance) === "login-conflict") return "登录冲突";
  if (napcatLoginState(instance) === "account-mismatch") return "账号不匹配";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  if (napcatAccountConnected(instance)) return "WS 已连接";
  if (napcatHealthFor(instance).http?.ok) return "OneBot 已登录";
  if (napcatAccountUserId(instance)) return "已绑定";
  if (napcatHealthFor(instance).webui?.loginInfo?.userId) return "WebUI 有会话";
  if (napcatAccountLoginLabel(instance) !== "等待 QQ 登录") return "登录异常";
  return "待检查";
}

function napcatInstanceStatusColor(instance: NapCatInstance): string {
  if (isDiscoveredNapcatAccount(instance)) return "info";
  if (managingNapcatLogin.value[instance.id] || launchingNapcatInstance.value[instance.id] || restartingNapcatInstance.value[instance.id]) return "info";
  if (instance.enabled === false) return "secondary";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "info";
  if (napcatLoginState(instance) === "account-online-elsewhere") return "warning";
  if (["quick-login-invalid", "qr-login-required", "login-conflict", "account-mismatch"].includes(napcatLoginState(instance))) return "error";
  if (napcatAccountOffline(instance)) return "error";
  if (napcatAccountConnected(instance)) return "success";
  if (napcatAccountUserId(instance)) return "secondary";
  const runtimeInfo = napcatRuntimeFor(instance);
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return "error";
  return "warning";
}

function napcatConnectedCount(): number {
  return napcatAccountInstances().filter(instance => instance.enabled !== false && napcatAccountConnected(instance)).length;
}

function napcatAutoFixTargets(): NapCatInstance[] {
  return ensureNapcatInstances().filter(instance =>
    instance.enabled !== false && Boolean(napcatInstanceHealthResult.value[instance.id]?.fixAvailable) && !napcatWebuiSessionMismatch(instance)
  );
}

function napcatAutoFixCount(): number {
  return napcatAutoFixTargets().length;
}

function napcatRepairAllSteps(body: Record<string, any>): string[] {
  const steps: string[] = [];
  if (Array.isArray(body.repair?.messages)) steps.push(...body.repair.messages);
  for (const result of Array.isArray(body.results) ? body.results : []) {
    const instanceId = result?.instanceId ? ` ${result.instanceId}` : "";
    const message = result?.message || (result?.ok ? "已处理。" : "处理失败。");
    if (result?.action === "configure-onebot") {
      steps.push(`NapCat${instanceId}：${message}`);
    } else if (result?.action === "health-check") {
      steps.push(`自测${instanceId}：${message}`);
    } else {
      steps.push(String(message));
    }
  }
  return steps.length ? steps : ["没有发现可自动修复项。"];
}

async function repairAllNapcatIssues(): Promise<void> {
  if (repairingNapcatAll.value || !gateway.value) return;
  repairingNapcatAll.value = true;
  napcatAutoSteps.value = {
    ...napcatAutoSteps.value,
    repairAll: {
      message: "正在修复扫描发现的可自动处理项...",
      steps: ["正在写入 RabiRoute 端口配置和 NapCat OneBot 配置。"]
    }
  };
  try {
    const resp = await fetch("/api/message/napcat-repair-all", { method: "POST" });
    const body = await resp.json().catch(() => ({}));
    if (body.repair?.changed || body.gatewayPayload?.data?.config) {
      await store.load();
    }
    await applyNapcatScanHealth(body.napcatHealth);
    const fixedResults = new Map<string, Record<string, any>>();
    for (const result of Array.isArray(body.results) ? body.results : []) {
      if (
        result?.ok &&
        result?.instanceId &&
        (result?.action === "configure-onebot" || result?.reloadRequired || result?.wsUrl)
      ) {
        fixedResults.set(String(result.instanceId), result);
      }
    }
    if (fixedResults.size > 0) {
      napcatHealthPausedAfterFix.value = {
        ...napcatHealthPausedAfterFix.value,
        ...Object.fromEntries([...fixedResults.keys()].map(id => [id, true]))
      };
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        ...Object.fromEntries([...fixedResults.entries()].map(([id, result]) => {
          const current = napcatInstanceHealthResult.value[id] || {};
          return [id, {
            ok: true,
            fixAvailable: false,
            message: result.message || "已写入 NapCat OneBot 配置；请在 NapCat WebUI 保存/重载网络配置或重启 NapCat 后重新扫描。",
            diagnostics: [
              "配置已写入，但运行中的 NapCat 可能需要保存/重载网络配置后才会开放 OneBot HTTP。"
            ],
            onebot: {
              ...(current.onebot || {}),
              currentUserId: result.userId || current.onebot?.currentUserId,
              currentNickname: result.nickname || current.onebot?.currentNickname,
              configPath: result.configPath || current.onebot?.configPath
            },
            webui: current.webui,
            wsUrl: result.wsUrl || current.wsUrl
          }];
        }))
      };
    }
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      repairAll: {
        ok: resp.ok && body.ok !== false,
        message: resp.ok && body.ok !== false ? "已修复全部可自动处理项。" : (body.message || "修复失败。"),
        steps: napcatRepairAllSteps(body)
      }
    };
  } catch (e: unknown) {
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      repairAll: {
        ok: false,
        message: "修复失败。",
        steps: [e instanceof Error ? e.message : String(e)]
      }
    };
  } finally {
    repairingNapcatAll.value = false;
  }
}

function napcatSetupHint(): string {
  const instances = ensureNapcatInstances();
  if (instances.length === 0) return "请配置当前 Route 的 NapCat 连接。";
  const invalid = instances.find(instance => instance.enabled !== false && !isValidPort(instance.gatewayPort));
  if (invalid) return `${invalid.name || invalid.id} 的 WS 端口无效，保存前需要改成 1-65535。`;
  const enabled = instances.filter(instance => instance.enabled !== false);
  if (enabled.length === 0) return "当前 NapCat 连接未启用。";
  if (!enabled.some(instance => napcatAccountConnected(instance))) return "下一步：在当前卡片启动 NapCat、完成 QQ 登录，并修复 OneBot 连接。";
  return "NapCat 已连接；收到消息后会投递到当前 Route。";
}

function napcatEntryMatchesInstance(entry: Record<string, any>, instance: NapCatInstance, allowUnscoped: boolean): boolean {
  const instanceIds = [entry.instanceId, entry.napcatInstanceId, entry.adapterInstanceId, entry.raw?.instanceId].filter(Boolean).map(String);
  const userIds = [entry.botUserId, entry.selfId, entry.RobotQQId, entry.raw?.botUserId, entry.raw?.self_id].filter(Boolean).map(String);
  const ports = [entry.gatewayPort, entry.port, entry.wsPort, entry.raw?.gatewayPort].filter(Boolean).map(Number);
  const hasScope = instanceIds.length > 0 || userIds.length > 0 || ports.length > 0;
  if (!hasScope) return allowUnscoped;
  const targetUserId = napcatAccountUserId(instance);
  return instanceIds.includes(String(instance.id)) ||
    (targetUserId ? userIds.includes(targetUserId) : false) ||
    ports.includes(Number(instance.gatewayPort || 0));
}

function napcatLogEntriesFor(instance: NapCatInstance): Array<Record<string, any>> {
  const instances = napcatAccountInstances();
  const allowUnscoped = instances.length === 1;
  return adapterLogEntries("napcat").filter(entry => napcatEntryMatchesInstance(entry, instance, allowUnscoped));
}

function napcatMessageFileEntriesFor(instance: NapCatInstance): Array<Record<string, any>> {
  const instances = napcatAccountInstances();
  const allowUnscoped = instances.length === 1;
  return messageFileEntries("napcat").filter(entry => napcatEntryMatchesInstance(entry, instance, allowUnscoped));
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  let result = message;
  try {
    await copyTextToClipboard(text);
  } catch (error) {
    result = `复制失败：${error instanceof Error ? error.message : String(error)}`;
  }
  copyResult.value = result;
  window.setTimeout(() => {
    if (copyResult.value === result) copyResult.value = "";
  }, 1800);
}

function showCopyResult(message: string): void {
  copyResult.value = message;
  window.setTimeout(() => {
    if (copyResult.value === message) copyResult.value = "";
  }, 2400);
}

function openRuntimeLog(): void {
  const name = store.selectedGateway ? configNameFor(store.selectedGateway) : "";
  void router.push(routeScopedRuntimePath(name));
}

async function deleteCurrentGateway(): Promise<void> {
  if (!gateway.value || deletingGateway.value) return;
  const name = store.configNameFor(gateway.value);
  const confirmed = window.confirm(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`);
  if (!confirmed) return;
  deletingGateway.value = true;
  deleteError.value = "";
  try {
    await store.deleteGateway(gateway.value.id);
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingGateway.value = false;
  }
}

async function triggerHeartbeatNow(): Promise<void> {
  if (!gateway.value || triggeringHeartbeat.value) return;
  triggeringHeartbeat.value = true;
  heartbeatTriggerResult.value = null;
  try {
    const result = await store.manualTriggerGateway(gateway.value.id, {
      triggerId: "heartbeat-now",
      triggerName: "立即触发心跳",
      routeKind: "heartbeat",
      message: gateway.value.heartbeatMessage || "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。"
    });
    heartbeatTriggerResult.value = {
      ok: true,
      message: result.alreadyRunning
        ? "这次心跳已经在后台投递中，没有重复启动；请到运行日志查看最终结果。"
        : "心跳已接受，正在后台投递；请到运行日志查看最终结果。"
    };
  } catch (e: unknown) {
    heartbeatTriggerResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    triggeringHeartbeat.value = false;
  }
}

async function openMarvis(): Promise<void> {
  if (openingMarvis.value) return;
  openingMarvis.value = true;
  marvisOpenResult.value = null;
  try {
    const resp = await fetch("/api/agent/marvis-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: gateway.value?.marvisAppId })
    });
    const body = await resp.json().catch(() => ({}));
    marvisOpenResult.value = {
      ok: resp.ok && body.ok !== false,
      message: body.message || (resp.ok ? "已尝试打开 Marvis。" : "打开 Marvis 失败。")
    };
  } catch (e: unknown) {
    marvisOpenResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    openingMarvis.value = false;
  }
}

async function testNapcatHealth(): Promise<void> {
  if (!gateway.value) return;
  testingNapcatHealth.value = true;
  napcatHealthResult.value = null;
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: gateway.value.napcatHttpUrl,
        webuiUrl: defaultNapcatWebuiUrl(),
        accessToken: gateway.value.napcatAccessToken,
        webuiToken: gateway.value.napcatWebuiToken,
        gatewayPort: gateway.value.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
  } catch (e: unknown) {
    napcatHealthResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    testingNapcatHealth.value = false;
  }
}

function napcatHealthPayload(instance?: NapCatInstance): Record<string, unknown> {
  if (instance) {
    return {
      gatewayId: gateway.value?.id,
      instanceId: instance.id,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl || defaultNapcatWebuiUrl(),
      accessToken: instance.accessToken,
      webuiToken: instance.webuiToken,
      gatewayPort: instance.gatewayPort,
      botUserId: instance.botUserId,
      botNickname: instance.botNickname
    };
  }
  return {
    gatewayId: gateway.value?.id,
    httpUrl: gateway.value?.napcatHttpUrl,
    webuiUrl: defaultNapcatWebuiUrl(),
    accessToken: gateway.value?.napcatAccessToken,
    webuiToken: gateway.value?.napcatWebuiToken,
    gatewayPort: gateway.value?.gatewayPort
  };
}

async function testNapcatInstanceHealth(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  testingNapcatInstance.value = { ...testingNapcatInstance.value, [instance.id]: true };
  napcatInstanceHealthResult.value = { ...napcatInstanceHealthResult.value, [instance.id]: null };
  const nextPaused = { ...napcatHealthPausedAfterFix.value };
  delete nextPaused[instance.id];
  napcatHealthPausedAfterFix.value = nextPaused;
  const nextOneBotFix = { ...napcatOneBotFixResult.value };
  delete nextOneBotFix[instance.id];
  napcatOneBotFixResult.value = nextOneBotFix;
  try {
    let target = instance;
    if (!isConfiguredNapcatInstance(target)) {
      addDiscoveredNapcatInstance(target);
      target = ensureNapcatInstances().find(item => item.id === instance.id) ?? target;
    }
    await autofillNapcatInstance(target);
    autoAssignNapcatPortsForAllGateways();
    if (store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }

    let body = await runNapcatInstanceHealth(target);
    if (applyNapcatHealthToInstance(target, body) && store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }

    if (webuiTokenMissing(body) && target.launchCommand && isConfiguredNapcatInstance(target)) {
      const launched = await launchNapcatInstanceAndRecheck(target, "未读到 WebUI 登录密钥，正在尝试启动 NapCat 后台后复查...");
      if (launched.health) {
        target = launched.target;
        body = launched.health;
      }
    }

    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: body
    };
    if (store.dirty) {
      await store.save();
    }
  } catch (e: unknown) {
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    testingNapcatInstance.value = { ...testingNapcatInstance.value, [instance.id]: false };
  }
}

async function launchNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: true };
  napcatLaunchResult.value = { ...napcatLaunchResult.value, [instance.id]: { ok: true, message: "正在启动..." } };
  try {
    const resp = await fetch("/api/message/napcat-launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: instance.id })
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已尝试启动 NapCat 后台。" : "启动失败。")
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: false };
  }
}

async function restartNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  restartingNapcatInstance.value = { ...restartingNapcatInstance.value, [instance.id]: true };
  napcatLaunchResult.value = { ...napcatLaunchResult.value, [instance.id]: { ok: true, message: "正在重启 NapCat..." } };
  try {
    if (store.dirty) await store.save();
    const resp = await fetch("/api/message/napcat-restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: instance.id })
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已尝试重启 NapCat。" : "重启失败。")
      }
    };
    await sleep(2500);
    await testNapcatInstanceHealth(resolveConfiguredNapcatInstance(instance));
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    restartingNapcatInstance.value = { ...restartingNapcatInstance.value, [instance.id]: false };
  }
}

function renameCurrentConfig(value: unknown): void {
  if (!gateway.value) return;
  const result = store.renameGatewayConfig(gateway.value.id, value);
  configNameError.value = result.message || "";
}

const agentDefs: Array<{ type: AgentAdapterType; title: string; note: string; icon: string; hasCwd: boolean; hasThread: boolean }> = [
  { type: "codex",       title: "Codex Agent",    note: "消息由桌面任务执行并实时显示", icon: "mdi-monitor-dashboard", hasCwd: true, hasThread: true },
  { type: "copilotCli",  title: "Copilot CLI",   note: "通过 GitHub Copilot CLI 投递消息",  icon: "mdi-robot-outline", hasCwd: true, hasThread: true },
  { type: "marvis",      title: "Marvis",         note: "打开 Marvis 并复制 prompt（人工接力）", icon: "mdi-message-processing-outline", hasCwd: false, hasThread: false },
  { type: "astrbot",     title: "AstrBot",         note: "通过 AstrBot ChatUI / 机器人框架投递消息",    icon: "mdi-robot-happy-outline", hasCwd: false, hasThread: false },
  { type: "dsh",         title: "DSH（DeepSeek Harness 会话）", note: "通过 session.prompt API 投递到本机 DSH 会话", icon: "mdi-brain", hasCwd: true, hasThread: true },
];

const addAgentMenu = ref(false);
const testingAstrbotLogin = ref(false);
const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);

const agentTypes = computed(() => gateway.value?.agentAdapters ?? []);
const visibleAgentItems = computed(() => agentDefs.filter(a => agentTypes.value.includes(a.type)));
const availableAgentsToAdd = computed(() => agentDefs.filter(a => !agentTypes.value.includes(a.type)));
const primaryAgentType = computed(() => resolvePrimaryAgentAdapter(
  agentTypes.value,
  gateway.value?.primaryAgentAdapter
));
const managedMessageAgentModeEnabled = computed(() => (
  gateway.value ? primaryMessageProcessingAgentEnabled(gateway.value) : false
));
const primaryAgentItems = computed(() => visibleAgentItems.value.map(agent => ({
  title: agent.title,
  value: agent.type
})));

const channelCheckAgentItems = computed(() => visibleAgentItems.value.map(agent => ({
  ...agent,
  primary: primaryAgentType.value === agent.type
})));

function channelManagerConnectionLabel(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false ? "已禁用" : "已启用";
}

function channelManagerConnectionColor(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false ? "secondary" : "success";
}

function channelManagerDetail(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false
    ? "当前 Route 已禁用。"
    : "当前 Route 已启用。";
}

function channelAgentConnectionLabel(type: AgentAdapterType): string {
  const state = agentStateFor(type);
  if (state.deliveryHealthy === true) return "可投递";
  if (state.lastNotificationError) return "投递失败";
  if (state.bound === true) return "已绑定";
  return agentConnectionLabel(type);
}

function channelAgentConnectionColor(type: AgentAdapterType): string {
  const label = channelAgentConnectionLabel(type);
  if (["可投递", "已绑定", "已发现"].includes(label)) return "success";
  if (["扫描中", "未扫描"].includes(label)) return "secondary";
  if (["投递失败", "未安装"].includes(label)) return "error";
  return "warning";
}

function channelAgentDetail(type: AgentAdapterType): string {
  const state = agentStateFor(type);
  if (typeof state.message === "string" && state.message.trim()) return state.message;
  const scan = agentScanFor(type);
  if (scan?.auth?.message) return scan.auth.message;
  return agentDefs.find(agent => agent.type === type)?.note || "当前 Route 已添加的 Agent 端。";
}

function messageProcessingAgentPolicy(type: AgentAdapterType) {
  const policy = gateway.value?.messageProcessingAgents?.[type];
  return {
    enabled: policy?.enabled === true,
    model: policy?.model || (type === "codex" ? DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL : ""),
    reasoningEffort: policy?.reasoningEffort || DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT,
    maxAgents: policy?.maxAgents
  };
}

function supportsManagedTaskFeature(type: AgentAdapterType, feature: "messageProcessingAgent" | "memoryConsolidationAgent" | "planAssistantSessions" | "hooks"): boolean {
  return agentAdapterSupportsManagedTaskFeature(type, feature);
}

function setMessageProcessingAgentPolicy(type: AgentAdapterType, patch: Record<string, unknown>): void {
  if (!gateway.value) return;
  gateway.value.messageProcessingAgents = gateway.value.messageProcessingAgents ?? {};
  gateway.value.messageProcessingAgents[type] = {
    ...messageProcessingAgentPolicy(type),
    ...patch
  };
  store.touch();
}

function agentStateFor(type: AgentAdapterType): Record<string, any> {
  return runtime.value.agentStates?.[type] ?? {};
}

function codexDeliveryChannelLabel(state: Record<string, any>): string {
  if (state.lastDeliveryChannel === "desktop-ipc") return "Codex Desktop IPC";
  return "-";
}

function normalizeClientPath(value?: string): string {
  return (value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left?: string, right?: string): boolean {
  const a = normalizeClientPath(left);
  const b = normalizeClientPath(right);
  return Boolean(a && b && a === b);
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined {
  const scan = agentScan.value.agents[type];
  if (type !== "astrbot" || !gateway.value) return scan;

  const localUrl = gateway.value.astrbotUrl?.trim();
  const localPassword = gateway.value.astrbotPassword?.trim();
  const endpoints = [...(scan?.endpoints ?? [])];
  if (localUrl && !endpoints.some(endpoint => endpoint.url === localUrl)) {
    endpoints.unshift({ label: "当前 AstrBot", url: localUrl });
  }

  if (!scan) {
    return {
      type: "astrbot",
      label: "AstrBot",
      maturity: "experimental",
      installed: false,
      auth: {
        required: true,
        loggedIn: false,
        message: localPassword ? "已填写本地 AstrBot 密码，保存后写入 route 配置。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。"
      },
      endpoints,
      warnings: []
    };
  }

  return {
    ...scan,
    endpoints,
    auth: localPassword
      ? {
          ...(scan.auth ?? { required: true }),
          required: true,
          loggedIn: scan.auth?.loggedIn,
          message: scan.auth?.loggedIn ? scan.auth.message : (scan.auth?.message || "已填写本地 AstrBot 密码，尚未验证登录。")
        }
      : scan.auth
  };
}

function maturityLabel(value?: AgentMaturity): string {
  if (value === "verified") return "已验证";
  if (value === "stub") return "占位";
  return "实验";
}

function maturityColor(value?: AgentMaturity): string {
  if (value === "verified") return "success";
  if (value === "stub") return "grey";
  return "warning";
}

function agentConnectionLabel(type: AgentAdapterType): string {
  const scan = agentScanFor(type);
  if (!scan) return agentScan.value.loading ? "扫描中" : "未扫描";
  if (scan.auth?.required && scan.auth.loggedIn === false) return "未登录";
  if (scan.plugins?.some(plugin => !plugin.installed)) return "插件缺失";
  if (scan.endpoints?.length && !scan.endpoints.some(endpoint => endpoint.healthy)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function agentConnectionColor(type: AgentAdapterType): string {
  const label = agentConnectionLabel(type);
  if (label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描") return "secondary";
  if (label === "未登录" || label === "插件缺失" || label === "未连接") return "warning";
  return "error";
}

function currentAgentProject(type: AgentAdapterType): string {
  if (!gateway.value) return "";
  if (type === "copilotCli") return gateway.value.copilotCwd || "";
  if (type === "codex") return gateway.value.codexCwd || "";
  if (type === "dsh") return gateway.value.dshCwd || "";
  return "";
}

function fallbackCodexThreadName(): string {
  if (!gateway.value) return "RabiRoute";
  return gateway.value.routeName || gateway.value.name || store.configNameFor(gateway.value) || gateway.value.id || "RabiRoute";
}

function agentProjectItems(type: AgentAdapterType): string[] {
  const projects = agentScanFor(type)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(type: AgentAdapterType): AgentScanSession[] {
  const sessions = agentScanFor(type)?.sessions;
  if (sessions) return sessions;
  if (type === "copilotCli") {
    return agentScan.value.copilotSessions.map(session => ({
      name: session.name,
      projectPath: session.cwd,
      userNamed: session.userNamed
    }));
  }
  if (type === "codex") {
    return agentScan.value.threadNames.map(name => ({ name }));
  }
  return [];
}

function astrbotProjectItems(): Array<{ title: string; value: string; path?: string }> {
  return (agentScanFor("astrbot")?.projects ?? []).map(project => ({
    title: project.label || project.path || project.id || "未命名项目",
    value: project.id || project.path,
    path: project.path
  }));
}

function astrbotSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  const projectId = gateway.value?.astrbotProjectId || "";
  return (agentScanFor("astrbot")?.sessions ?? [])
    .filter(session => !projectId || session.projectId === projectId)
    .map(session => ({
      title: session.name,
      value: session.id || session.name,
      subtitle: session.projectPath || session.updatedAt
    }));
}

function selectAstrbotProject(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotProjectId = String(value || "");
  const sessions = astrbotSessionItems();
  if (gateway.value.astrbotSessionId && !sessions.some(session => session.value === gateway.value?.astrbotSessionId)) {
    gateway.value.astrbotSessionId = "";
  }
  touch();
}

function selectAstrbotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotSessionId = String(value || "");
  const selected = (agentScanFor("astrbot")?.sessions ?? []).find(session => (session.id || session.name) === gateway.value?.astrbotSessionId);
  if (selected?.projectId && !gateway.value.astrbotProjectId) {
    gateway.value.astrbotProjectId = selected.projectId;
  }
  touch();
}

function sessionNamesFor(type: AgentAdapterType): string[] {
  const selectedProject = currentAgentProject(type);
  return [...new Set(agentSessions(type)
    .filter(session => !selectedProject || !session.projectPath || samePath(session.projectPath, selectedProject))
    .map(session => session.name))];
}

function codexSessionItems(): Array<{ title: string; value: string }> {
  return codexThreadItems(codexThreadSummaries());
}

function codexThreadSummaries(): CodexThreadSummary[] {
  return agentSessions("codex")
    .filter(session => session.id)
    .map(session => ({
      id: session.id!,
      title: session.name,
      updatedAt: session.updatedAt,
      cwd: session.projectPath
    }));
}

function dshSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return agentSessions("dsh")
    .filter((session) => session.id)
    .filter((session) => !gateway.value?.dshCwd || !session.projectPath || samePath(session.projectPath, gateway.value.dshCwd))
    .map((session) => ({
      title: session.name,
      value: session.id!,
      subtitle: [session.projectPath, session.updatedAt].filter(Boolean).join(" · ")
    }));
}

function selectDshSession(value: unknown): void {
  if (!gateway.value) return;
  const raw = String(value || "").trim();
  const selected = agentSessions("dsh").find((session) => session.id === raw);
  if (selected?.id) {
    gateway.value.dshSessionId = selected.id;
    gateway.value.dshSessionName = selected.name;
    if (selected.projectPath) gateway.value.dshCwd = selected.projectPath;
  } else {
    gateway.value.dshSessionId = "";
    gateway.value.dshSessionName = raw;
  }
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

function managedAgentSessionContext(type: AgentAdapterType): {
  agentAdapter: "codex" | "dsh";
  sessionId: string;
  sessionName: string;
  workspace: string;
  dshBaseUrl?: string;
} | null {
  if (!gateway.value || (type !== "codex" && type !== "dsh")) return null;
  if (type === "dsh") {
    return {
      agentAdapter: "dsh",
      sessionId: String(gateway.value.dshSessionId || "").trim(),
      sessionName: String(gateway.value.dshSessionName || fallbackCodexThreadName()).trim(),
      workspace: String(gateway.value.dshCwd || "").trim(),
      dshBaseUrl: String(gateway.value.dshBaseUrl || "").trim() || undefined
    };
  }
  return {
    agentAdapter: "codex",
    sessionId: String(gateway.value.codexThreadId || "").trim(),
    sessionName: String(gateway.value.codexThreadName || fallbackCodexThreadName()).trim(),
    workspace: String(gateway.value.codexCwd || "").trim()
  };
}

function managedAgentLabel(type: AgentAdapterType): string {
  return type === "dsh" ? "DSH" : "Codex Desktop";
}

function hasManagedAgentSessionBinding(type: "codex" | "dsh"): boolean {
  const session = managedAgentSessionContext(type);
  return Boolean(session?.sessionId && session.workspace);
}

async function openManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (managedAgentSessionAction.value.loading) return;
  const session = managedAgentSessionContext(agentAdapter);
  if (!session?.sessionId || !session.workspace) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await postAgentThreadAction({
      action: "open",
      agentAdapter: session.agentAdapter,
      threadId: session.sessionId,
      cwd: session.workspace,
      ...(session.dshBaseUrl ? { dshBaseUrl: session.dshBaseUrl } : {})
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh" ? "已在 DSH 中定位主人格会话。" : "已在 Codex Desktop 中定位主人格任务。",
      error: ""
    };
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function selectCodexSession(value: unknown): void {
  if (!gateway.value) return;
  const selection = selectCodexThread(value, codexThreadSummaries());
  gateway.value.codexThreadId = selection.threadId;
  gateway.value.codexThreadName = selection.threadName;
  if (selection.selected?.cwd) gateway.value.codexCwd = selection.selected.cwd;
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

function codexHookEnabled(key: keyof CodexHookSettings): boolean {
  return gateway.value?.codexHooks?.[key] !== false;
}

function setCodexHookSetting(key: keyof CodexHookSettings, enabled: boolean | null): void {
  if (!gateway.value) return;
  gateway.value.codexHooks = {
    sessionContextEnabled: gateway.value.codexHooks?.sessionContextEnabled !== false,
    reasoningContextEnabled: gateway.value.codexHooks?.reasoningContextEnabled !== false,
    planTaskCompletionEnabled: gateway.value.codexHooks?.planTaskCompletionEnabled !== false,
    agentCommunicationEnforcementEnabled: gateway.value.codexHooks?.agentCommunicationEnforcementEnabled !== false,
    onlyPrimaryPersonaCanSendMessages: gateway.value.codexHooks?.onlyPrimaryPersonaCanSendMessages === true,
    [key]: enabled === true
  };
  touch();
}

async function lookupCodexThreadBinding(): Promise<void> {
  if (!gateway.value || codexBinding.value.loading) return;
  const title = gateway.value.codexThreadName?.trim() || fallbackCodexThreadName();
  codexBinding.value = { loading: true, error: "", pending: false };
  try {
    const response = await fetch("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        threadId: gateway.value.codexThreadId || undefined,
        title,
        cwd: gateway.value.codexCwd || undefined,
        createIfMissing: false
      })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && body.resolution === "missing") {
      gateway.value.codexThreadId = "";
      codexBinding.value.pending = true;
      touch();
      return;
    }
    if (!response.ok || !body.thread?.id) {
      throw new Error(body.message || "无法查找 Codex Desktop 会话。");
    }
    gateway.value.codexThreadId = body.thread.id;
    gateway.value.codexThreadName = body.thread.title || title;
    if (body.thread.cwd) gateway.value.codexCwd = body.thread.cwd;
    touch();
  } catch (error) {
    codexBinding.value.error = error instanceof Error ? error.message : String(error);
  } finally {
    codexBinding.value.loading = false;
  }
}

async function initializeManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (!gateway.value || managedAgentSessionAction.value.loading) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await initializeAgentSessionForRoute({
      agentAdapter,
      save: () => store.save(),
      currentGatewayId: () => gateway.value?.id || "",
      deliver: async ({ gatewayId, text }) => {
        const response = await fetch("/api/role-panel/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayId, text, attachments: [] })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.code !== 0) {
          throw new Error(body.message || "人格初始化消息投递失败。");
        }
      }
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh"
        ? "已保存名称 + 会话 ID，并通过 DSH owner 投递人格初始化消息。"
        : "已保存名称 + 线程 ID，并通过 Desktop owner 投递人格初始化消息。",
      error: ""
    };
    await store.load();
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function selectCopilotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.copilotThreadName = String(value || "");
  touch();
  const selected = agentSessions("copilotCli").find(session => session.name === gateway.value?.copilotThreadName);
  if (selected?.projectPath && !gateway.value.copilotCwd) {
    gateway.value.copilotCwd = selected.projectPath;
  }
}

function agentWarnings(type: AgentAdapterType): string[] {
  const warnings = [...(agentScanFor(type)?.warnings ?? [])];
  if (type === "astrbot") {
    const hasLocalPassword = Boolean(gateway.value?.astrbotPassword?.trim());
    const scan = agentScanFor("astrbot");
    const pluginReady = scan?.plugins?.every(plugin => plugin.installed) ?? false;
    const endpointReady = scan?.endpoints?.some(endpoint => endpoint.healthy) ?? false;
    return [...new Set(warnings.filter(warning => {
      if (hasLocalPassword && warning.includes("缺少 AstrBot 密码")) return false;
      if (warning.includes("默认管线") || warning.includes("无可选会话列表")) return false;
      if (hasLocalPassword && pluginReady && endpointReady && warning.includes("尚未验证列会话")) return false;
      return true;
    }))];
  }
  if (type === "copilotCli" && gateway.value?.copilotCwd && gateway.value.copilotThreadName) {
    const selected = agentSessions(type).find(session => session.name === gateway.value?.copilotThreadName);
    if (selected?.projectPath && !samePath(selected.projectPath, gateway.value.copilotCwd)) {
      warnings.push(`当前会话属于 ${selected.projectPath}，和工作目录不一致。`);
    }
  }
  return [...new Set(warnings)];
}

function addAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = [...agentTypes.value, type];
  gateway.value.primaryAgentAdapter = resolvePrimaryAgentAdapter(
    gateway.value.agentAdapters,
    gateway.value.primaryAgentAdapter
  );
  agentParamOpen.value[type] = true;
  if (supportsManagedTaskFeature(type, "hooks") && !gateway.value.codexHooks) {
    gateway.value.codexHooks = { ...DEFAULT_CODEX_HOOK_SETTINGS };
  }
  if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  store.touch();
}

async function postAgentThreadAction(payload: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch("/api/agent/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code === -1) throw new Error(body.message || "Agent 会话操作失败。");
  return body;
}

async function initializePlanAssistants(): Promise<void> {
  if (!gateway.value || codexPlanAssistants.value.loading) return;
  codexPlanAssistants.value = {
    count: normalizeCodexPlanAssistantCount(codexPlanAssistants.value.count),
    loading: true,
    message: "",
    error: ""
  };
  try {
    if (!String(gateway.value.agentRoleId || "").trim()) {
      throw new Error("请先为当前 Route 绑定人格，再初始化计划协助会话。");
    }
    await store.save();
    const current = gateway.value;
    const source = managedAgentSessionContext(primaryAgentType.value || "codex");
    if (!source?.sessionId || !source.workspace) {
      throw new Error(`主 ${managedAgentLabel(primaryAgentType.value || "codex")} 会话尚未完成名称 + ID + workspace 绑定。`);
    }
    const count = normalizeCodexPlanAssistantCount(codexPlanAssistants.value.count);
    const sourceRead = await postAgentThreadAction({
      action: "read",
      agentAdapter: source.agentAdapter,
      threadId: source.sessionId,
      ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
    });
    const sourceThreadName = String(source.agentAdapter === "codex"
      ? sourceRead.thread?.name
      : sourceRead.thread?.name || sourceRead.thread?.title || source.sessionName || fallbackCodexThreadName()).trim();
    if (!sourceThreadName) {
      throw new Error("无法读取 Codex 侧栏显示的 Name，未创建计划秘书 Agent。");
    }
    const titles = codexPlanAssistantSessionTitles(sourceThreadName, count);
    const existing = (current.codexPlanAssistantSessions ?? [])
      .filter((session) => planAssistantSessionAgentAdapter(session) === source.agentAdapter);
    const resolved = [] as NonNullable<typeof current.codexPlanAssistantSessions>;

    for (let index = 0; index < titles.length; index += 1) {
      const desiredTitle = titles[index];
      const previous = existing[index];
      const result = await postAgentThreadAction({
        action: "resolve",
        agentAdapter: source.agentAdapter,
        threadId: previous?.threadId,
        title: desiredTitle,
        cwd: previous?.workspace || source.workspace,
        createIfMissing: true,
        lookupMode: "state_db",
        ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
      });
      const thread = result.thread;
      if (!thread?.id) throw new Error(`计划协助会话 ${index + 1} 没有返回完整任务 ID。`);
      resolved.push({
        ...(source.agentAdapter === "dsh" ? { agentAdapter: "dsh" as const } : {}),
        threadId: thread.id,
        threadName: thread.title || desiredTitle,
        workspace: thread.cwd || previous?.workspace || source.workspace,
        index: index + 1,
        initializedAt: previous?.threadId === thread.id ? previous.initializedAt : undefined
      });
    }

    current.codexPlanAssistantSessions = resolved;
    touch();
    await store.save();

    for (const session of resolved) {
      if (session.initializedAt) continue;
      await postAgentThreadAction({
        action: "send",
        agentAdapter: source.agentAdapter,
        threadId: session.threadId,
        cwd: session.workspace,
        sandbox: "workspace-write",
        model: current.codexPlanAssistantModel || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL,
        prompt: codexPlanAssistantInitializationPrompt({
          roleId: current.agentRoleId || "",
          sourceAgentAdapter: source.agentAdapter,
          assistantAgentAdapter: source.agentAdapter,
          sourceThreadId: source.sessionId,
          sourceThreadName,
          assistantThreadId: session.threadId,
          assistantThreadName: session.threadName,
          workspace: session.workspace,
          managerBaseUrl: window.location.origin,
          count,
          index: session.index
        }),
        messageSource: {
          type: "agent",
          agentAdapter: source.agentAdapter,
          agentType: "primary_persona",
          sessionId: source.sessionId,
          sessionName: sourceThreadName,
          workspace: source.workspace
        },
        sourceThreadId: source.sessionId,
        sourceAgentType: "primary_persona",
        responsePolicy: "none",
        ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
      });
      session.initializedAt = new Date().toISOString();
      touch();
      await store.save();
    }
    const detached = Math.max(0, existing.length - resolved.length);
    codexPlanAssistants.value = {
      count,
      loading: false,
      message: `已绑定 ${resolved.length} 个持久计划协助会话${detached ? `；另有 ${detached} 个旧会话已从 Route 解绑但未删除` : ""}。`,
      error: ""
    };
    await store.load();
  } catch (error) {
    codexPlanAssistants.value = {
      ...codexPlanAssistants.value,
      loading: false,
      message: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function removeAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = agentTypes.value.filter(t => t !== type);
  gateway.value.primaryAgentAdapter = resolvePrimaryAgentAdapter(
    gateway.value.agentAdapters,
    gateway.value.primaryAgentAdapter
  );
  agentParamOpen.value[type] = false;
  store.touch();
}

function selectPrimaryAgent(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.primaryAgentAdapter = resolvePrimaryAgentAdapter(agentTypes.value, value);
  store.touch();
}

async function testAstrbotLogin(): Promise<void> {
  if (!gateway.value) return;
  testingAstrbotLogin.value = true;
  astrbotLoginResult.value = null;
  try {
    const resp = await fetch("/api/agent/astrbot-login-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: gateway.value.astrbotUrl,
        username: gateway.value.astrbotUsername,
        password: gateway.value.astrbotPassword
      })
    });
    const body = await resp.json().catch(() => ({}));
    astrbotLoginResult.value = {
      ok: Boolean(body.ok),
      message: body.message || (resp.ok ? "AstrBot 登录验证成功。" : "AstrBot 登录验证失败。")
    };
  } catch (e: unknown) {
    astrbotLoginResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    testingAstrbotLogin.value = false;
  }
}

function toggleAgentParams(type: AgentAdapterType): void {
  const nextOpen = !agentParamOpen.value[type];
  agentParamOpen.value[type] = nextOpen;
  if (nextOpen) {
    if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  }
}

async function refreshVisibleNapcatHealth(): Promise<void> {
  if (!gateway.value || !gatewayAdapterTypes(gateway.value).includes("napcat")) return;
  if (store.dirty) return;
  if (repairingNapcatAll.value) return;
  const instances = ensureNapcatInstances().filter(instance => instance.enabled !== false && !napcatHealthPausedAfterFix.value[instance.id]);
  if (instances.length === 0) return;
  autoCheckingNapcat.value = true;
  try {
    const results = await Promise.all(instances.map(async (instance) => {
      try {
        const body = await runNapcatInstanceHealth(instance);
        return [instance.id, body] as const;
      } catch (e: unknown) {
        return [instance.id, { ok: false, message: e instanceof Error ? e.message : String(e) }] as const;
      }
    }));
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      ...Object.fromEntries(results)
    };
  } finally {
    autoCheckingNapcat.value = false;
  }
}

function gatewayFromRouteParam(id: string | undefined) {
  if (!id || !store.gateways.length) return null;
  const decodedId = decodeURIComponent(id);
  return store.gateways.find(g => configNameFor(g) === decodedId || g.id === decodedId || configNameFor(g) === id || g.id === id) || null;
}

// URL ↔ gateway 双向同步（放最后避免 TDZ）
watch([() => route.params.id as string, () => store.gateways], ([id]) => {
  const found = gatewayFromRouteParam(id);
  if (found && found.id !== store.selectedGatewayId) store.selectGateway(found.id);
}, { immediate: true });

watch(() => store.selectedGatewayId, (id) => {
  const routeGateway = gatewayFromRouteParam(route.params.id as string | undefined);
  if (routeGateway && routeGateway.id !== id) return;
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  if (name && route.params.id !== name) router.replace(routeScopedAdaptersPath(name));
});

watch(() => gateway.value?.configName, (name) => {
  configNameError.value = "";
  if (name && route.params.id !== name) router.replace(routeScopedAdaptersPath(name));
});

watch(() => gateway.value?.id, () => {
  codexPlanAssistants.value = {
    count: Math.max(1, gateway.value?.codexPlanAssistantSessions?.length || 1),
    loading: false,
    message: "",
    error: ""
  };
}, { immediate: true });

watch(
  () => [store.loading, store.dirty, gateway.value?.id, JSON.stringify((gateway.value?.napcatInstances ?? []).map(instance => ({
    id: instance.id,
    enabled: instance.enabled,
    gatewayPort: instance.gatewayPort,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl
  })))],
  ([loading, dirty, gatewayId, instancesKey]) => {
    if (loading || dirty || autoCheckingNapcat.value || repairingNapcatAll.value) return;
    const key = `${gatewayId || ""}:${instancesKey || ""}`;
    if (key === lastAutoNapcatHealthKey.value) return;
    lastAutoNapcatHealthKey.value = key;
    void refreshVisibleNapcatHealth();
  },
  { immediate: true }
);
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">消息适配器</h1>
        <div class="page-subtitle">配置消息端和 Agent 端。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-switch v-model="gateway.enabled" label="是否启用" color="success" inset hide-details @update:model-value="touch" />
        <v-btn prepend-icon="mdi-connection" color="secondary" variant="tonal" :loading="messageAdapterScan.loading && channelCheckDialogOpen" @click="openChannelCheckDialog">
          通道检查
        </v-btn>
        <v-btn prepend-icon="mdi-folder-open-outline" variant="tonal" @click="store.openConfigFile('route-folder', gateway.id, gateway.agentRoleId || '')">
          打开航线配置
        </v-btn>
        <v-btn prepend-icon="mdi-delete" color="error" variant="text" :loading="deletingGateway" @click="deleteCurrentGateway">
          删除
        </v-btn>
      </div>
    </div>

    <v-alert v-if="deleteError" type="error" variant="tonal" class="mb-4">{{ deleteError }}</v-alert>
    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="status-row mb-4" style="gap:8px">
        <span class="route-config-muted-label">配置名</span>
        <v-text-field
          :model-value="gateway.configName"
          density="compact"
          variant="outlined"
          style="max-width:260px"
          hint="用于 data/route 下的目录名"
          persistent-hint
          :error-messages="configNameError"
          @update:model-value="renameCurrentConfig"
        />
      </div>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息端</div>
            <div class="section-note">这里决定 RabiRoute 从哪些入口接收消息。多个入口可以并存，也可以分别停用或调整权限。</div>
          </div>
          <div class="adapter-master-actions">
            <v-chip color="secondary" variant="tonal">{{ activeAdapterCount }} 个入口启用</v-chip>
          </div>
        </div>

        <div class="config-toolbar">
          <v-text-field
            v-model="adapterQuery"
            density="compact"
            prepend-inner-icon="mdi-magnify"
            label="搜索入口"
            hide-details
            clearable
          />
          <div class="selected-pill-row">
            <v-chip v-for="type in visibleActiveAdapters" :key="type" size="small" color="secondary" variant="tonal">
              {{ adapterLabel(type) }}
            </v-chip>
          </div>
        </div>

        <div class="catalog-list mb-2">
          <section v-for="group in visibleAdapterGroups" :key="group.title" class="catalog-section">
            <div class="catalog-section-head">
              <div>
                <div class="catalog-section-title">{{ group.title }}</div>
                <div class="section-note">{{ group.note }}</div>
              </div>
            </div>
            <div
              v-for="choice in group.choices"
              :key="choice.type"
              class="catalog-item"
            >
              <div
                class="catalog-row"
                :class="{ active: adapters.includes(choice.type) }"
                @click="toggleAdapterParams(choice.type)"
              >
                <v-icon class="catalog-row-icon" color="secondary">{{ choice.icon }}</v-icon>
                <span class="catalog-row-main">
                  <strong>{{ choice.title }}</strong>
                  <small>{{ choice.note }}</small>
                </span>
                <div class="catalog-row-actions">
                  <v-chip size="x-small" :color="maturityColor(messageScanFor(choice.type)?.maturity)" variant="tonal">
                    {{ maturityLabel(messageScanFor(choice.type)?.maturity) }}
                  </v-chip>
                  <v-chip size="x-small" :color="scanConnectionColor(messageScanFor(choice.type))" variant="tonal">
                    {{ scanConnectionLabel(messageScanFor(choice.type)) }}
                  </v-chip>
                  <v-btn
                    v-if="hasAdapterParams(choice.type)"
                    :icon="adapterParamOpen[choice.type] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    size="small"
                    variant="text"
                    :title="adapterParamOpen[choice.type] ? '收起参数' : '展开参数'"
                    @click.stop="toggleAdapterParams(choice.type)"
                  />
                  <div @click.stop>
                    <v-switch
                      class="catalog-row-toggle"
                      color="success"
                      density="compact"
                      inset
                      hide-details
                      :model-value="!isAdapterDisabled(gateway, choice.type)"
                      :loading="choice.type === 'speech' && speechAdapterActionBusy"
                      :disabled="choice.type === 'speech' && speechAdapterActionBusy"
                      @update:model-value="value => void setAdapterEnabled(choice.type, value)"
                    />
                  </div>
                  <v-btn
                    icon="mdi-close"
                    size="small"
                    variant="text"
                    color="error"
                    title="移除此消息端"
                    @click.stop="removeAdapter(choice.type)"
                  />
                </div>
              </div>
              <v-expand-transition>
                <div v-if="adapterParamOpen[choice.type]" class="catalog-param-panel">
                  <div class="dependency-panel mb-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">环境和依赖</div>
                        <div class="section-note">先确认这个消息端需要的外部工具、桥接服务和回调入口是否就绪。</div>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-chip size="small" :color="scanConnectionColor(messageScanFor(choice.type))" variant="tonal">
                          {{ scanConnectionLabel(messageScanFor(choice.type)) }}
                        </v-chip>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="messageAdapterScan.loading" @click="choice.type === 'napcat' ? rescanNapcatInstances() : runMessageAdapterScan()">
                          {{ choice.type === "napcat" ? "只读扫描" : "重新扫描" }}
                        </v-btn>
                      </div>
                    </div>
                    <v-alert
                      v-if="messageAdapterScan.error"
                      type="warning"
                      variant="tonal"
                      density="compact"
                      class="mb-3"
                    >
                      {{ messageAdapterScan.error }}
                    </v-alert>
                    <template v-if="messageScanFor(choice.type)">
                      <v-alert
                        v-if="messageScanFor(choice.type)?.health?.message"
                        :type="messageScanFor(choice.type)?.health?.state === 'healthy' ? 'success' : 'warning'"
                        variant="tonal"
                        density="compact"
                        class="mb-3"
                      >
                        {{ messageScanFor(choice.type)?.health?.message }}
                      </v-alert>
                      <div v-if="messageScanFor(choice.type)?.requirements?.length" class="dependency-list">
                        <div
                          v-for="requirement in messageScanFor(choice.type)?.requirements"
                          :key="requirement.id"
                          class="dependency-row"
                        >
                          <v-chip size="x-small" :color="requirementColor(requirement)" variant="tonal">
                            {{ requirementLabel(requirement) }}
                          </v-chip>
                          <div>
                            <strong>{{ requirement.label }}</strong>
                            <span>{{ requirement.detail || (requirement.required ? "这是必需项。" : "这是可选项。") }}</span>
                          </div>
                          <v-btn
                            v-if="requirement.url || requirement.path"
                            size="small"
                            variant="text"
                            :prepend-icon="requirement.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                            @click="openScanCandidate(requirement)"
                          >
                            {{ requirement.actionLabel || (requirement.url ? "打开" : "复制路径") }}
                          </v-btn>
                        </div>
                      </div>
                      <div v-if="choice.type !== 'napcat' && messageScanFor(choice.type)?.endpoints?.length" class="dependency-endpoints mt-2">
                        <div
                          v-for="endpoint in messageScanFor(choice.type)?.endpoints"
                          :key="`${endpoint.label}-${endpoint.url}`"
                          class="status-row compact-status-row"
                        >
                          <span>{{ endpoint.label }}</span>
                          <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可用" : "未响应" }}</b>
                        </div>
                      </div>
                      <div v-if="messageScanFor(choice.type)?.installCandidates?.length" class="dependency-actions mt-2">
                        <v-btn
                          v-for="candidate in messageScanFor(choice.type)?.installCandidates"
                          :key="candidate.label"
                          size="small"
                          variant="tonal"
                          :prepend-icon="candidate.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                          @click="openScanCandidate(candidate)"
                        >
                          {{ candidate.label }}
                        </v-btn>
                      </div>
                      <v-alert
                        v-for="warning in messageScanFor(choice.type)?.warnings ?? []"
                        :key="warning"
                        type="warning"
                        variant="tonal"
                        density="compact"
                        class="mt-2"
                      >
                        {{ warning }}
                      </v-alert>
                    </template>

                    <div v-else class="section-note">尚未扫描。展开面板后会自动扫描，也可以手动刷新。</div>
                  </div>
                  <TrustedWebRendererHost
                    v-if="settingsRenderersForMessageEndpoint(choice.type).length"
                    :renderers="settingsRenderersForMessageEndpoint(choice.type)"
                    :context="{ messageEndpointType: choice.type, routeId: gateway?.id ?? '' }"
                  />
                  <div v-if="usesAutomaticMessageGrouping(choice.type)" class="dependency-panel mb-3">
                    <div class="section-title small-title">消息组等待</div>
                    <div class="section-note">聊天消息默认使用消息组，不需要单独开启。这里仅调整等待一句话说完的时间。</div>
                    <v-alert type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                      主控选择 Codex 且开启消息处理模式后，聊天消息会先立即记录，再按这些参数合并。ASR、心跳和结构化事件不在这里等待。
                    </v-alert>
                    <div class="catalog-param-grid mt-2">
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.settleSeconds"
                        label="普通停顿（秒）"
                        hint="连续片段在这段时间内到达时先合并。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { settleSeconds: Number(value) })"
                      />
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.incompleteSettleSeconds"
                        label="未说完等待（秒）"
                        hint="“还有、然后、这个”等明显未说完的片段使用更长等待。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { incompleteSettleSeconds: Number(value) })"
                      />
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.maxWaitSeconds"
                        label="最长等待（秒）"
                        hint="达到上限后先形成消息组；半小时后的相关消息仍可依靠回复关系和历史摘要续接。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { maxWaitSeconds: Number(value) })"
                      />
                    </div>
                  </div>
                  <div v-if="choice.type === 'napcat'" class="catalog-param-grid napcat-manager-panel">
                    <div class="full-span napcat-setup-strip">
                      <div class="napcat-setup-main">
                        <v-icon size="22">mdi-connection</v-icon>
                        <div>
                          <strong>NapCat 连接</strong>
                          <span>{{ napcatSetupHint() }}</span>
                        </div>
                      </div>
                      <div class="napcat-setup-stats">
                        <div><b>1</b><span>每个 Route</span></div>
                        <div><b>{{ napcatConnectedCount() }}</b><span>已连接</span></div>
                      </div>
                    </div>
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      当前 Route 只绑定一个 NapCat。需要连接另一个 QQ 时，请新建 Route，让账号的策略、日志和运行状态彼此隔离。
                    </v-alert>
                    <v-alert
                      v-for="(auto, key) in napcatAutoSteps"
                      :key="key"
                      :type="auto.ok === false ? 'error' : auto.ok === true ? 'success' : 'info'"
                      variant="tonal"
                      density="compact"
                      class="full-span"
                    >
                      <div>{{ auto.message }}</div>
                      <div v-for="step in auto.steps" :key="step" class="section-note">{{ step }}</div>
                    </v-alert>
                    <div class="full-span">
                      <div class="section-title-row mb-2">
                        <div>
                          <div class="section-title small-title">当前绑定</div>
                          <div class="section-note">Rabi 直接管理这个 NapCat 的启动、登录、OneBot 配置和连接状态。</div>
                        </div>
                      </div>
                      <div class="napcat-account-grid">
                        <div
                          v-for="instance in napcatAccountInstances()"
                          :key="instance.id"
                          class="napcat-account-card"
                          :class="{ disabled: instance.enabled === false }"
                        >
                          <div class="napcat-account-head">
                            <div>
                              <div class="napcat-account-title">{{ napcatAccountTitle(instance) }}</div>
                              <div class="section-note">{{ napcatAccountSubtitle(instance) }}</div>
                            </div>
                            <div class="napcat-card-controls">
                              <v-chip size="x-small" :color="napcatInstanceStatusColor(instance)" variant="tonal">
                                {{ napcatInstanceStatusLabel(instance) }}
                              </v-chip>
                            </div>
                          </div>
                          <div class="napcat-card-summary">
                            <div><span>WS</span><b :class="napcatInstancePortError(instance) ? 'text-error' : ''">{{ napcatInstanceWsUrl(instance) }}</b></div>
                            <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                            <div><span>管理接口</span><b :class="napcatWebuiStatusClass(instance)">{{ instance.webuiUrl || "-" }} · {{ napcatWebuiStatusLabel(instance) }}</b></div>
                            <div><span>OneBot</span><b :class="napcatAccountLoginClass(instance)">{{ napcatAccountLoginLabel(instance) }}</b></div>
                            <div v-if="napcatWebuiSessionLabel(instance)"><span>NapCat 会话</span><b :class="napcatWebuiSessionMismatch(instance) ? 'text-warning' : 'text-info'">{{ napcatWebuiSessionLabel(instance) }}</b></div>
                          </div>
                          <v-alert
                            v-if="napcatLoginState(instance) === 'account-online-elsewhere' && napcatAccountOwner(instance)"
                            type="warning"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            <div>{{ napcatAccountOwnerLabel(instance) }}。Rabi 已保留这份会话，没有启动重复实例。</div>
                            <div class="section-note mt-1">
                              {{ napcatAccountOwner(instance)?.routesToGateway ? "该实例已经指向当前 RabiRoute，可以直接采用。" : "采用后还需要在详情中修复 OneBot 路由。" }}
                            </div>
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                size="small"
                                color="warning"
                                variant="tonal"
                                prepend-icon="mdi-connection"
                                :loading="adoptingNapcatOwner[instance.id]"
                                :disabled="adoptingNapcatOwner[instance.id]"
                                @click="adoptNapcatAccountOwner(instance)"
                              >
                                采用在线实例
                              </v-btn>
                            </div>
                          </v-alert>
                          <v-alert
                            v-else-if="['quick-login-invalid', 'qr-login-required'].includes(napcatLoginState(instance))"
                            type="error"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatLoginState(instance) === "qr-login-required" ? "这个 QQ 没有可用的快速登录身份，或当前二维码已经过期。" : "NapCat 保存的快速登录身份已经过期。" }}
                            请在下方登录控制中刷新二维码后扫码；扫码完成前 Rabi 不会误用其他 QQ，也不会反复重试旧身份。
                          </v-alert>
                          <div class="agent-action-bar mt-2">
                            <div class="agent-action-status">
                              <span class="section-note">一键启动并在当前卡片管理登录；只有 QQ 安全验证需要你确认</span>
                            </div>
                            <div class="d-flex ga-2 flex-wrap">
                              <v-btn
                                size="small"
                                variant="tonal"
                                color="primary"
                                prepend-icon="mdi-play-circle-outline"
                                :loading="managingNapcatLogin[instance.id]"
                                :disabled="managingNapcatLogin[instance.id]"
                                @click="startNapcatAndManage(instance)"
                              >
                                {{ managingNapcatLogin[instance.id] ? "正在准备..." : "启动并管理登录" }}
                              </v-btn>
                              <v-btn
                                v-if="isConfiguredNapcatInstance(instance) || isDiscoveredNapcatAccount(instance)"
                                size="small"
                                variant="text"
                                color="error"
                                prepend-icon="mdi-delete-outline"
                                @click="removeNapcatInstanceById(instance.id)"
                              >
                                删除
                              </v-btn>
                            </div>
                          </div>
                          <v-card
                            v-if="napcatLoginUi(instance).visible"
                            class="napcat-login-control mt-3"
                            variant="flat"
                          >
                            <div class="napcat-login-control-head">
                              <div>
                                <div class="section-title small-title">QQ 登录控制</div>
                                <div class="section-note">登录请求由 Rabi 转交本机 NapCat；WebUI 密钥和密码不会显示在这里的结果中。</div>
                              </div>
                              <v-btn
                                size="small"
                                variant="text"
                                prepend-icon="mdi-refresh"
                                :loading="napcatLoginUi(instance).loading"
                                @click="loadNapcatLoginPanel(instance)"
                              >
                                刷新状态
                              </v-btn>
                            </div>
                            <v-alert
                              v-if="napcatLoginUi(instance).panel?.loggedIn"
                              :type="napcatLoginUi(instance).panel?.state === 'account-mismatch' ? 'warning' : 'success'"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).panel?.message }}
                            </v-alert>
                            <v-alert
                              v-if="napcatLoginUi(instance).error"
                              type="error"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).error }}
                            </v-alert>
                            <v-alert
                              v-else-if="napcatLoginUi(instance).message && !napcatLoginUi(instance).panel?.loggedIn"
                              type="info"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).message }}
                            </v-alert>
                            <v-tabs v-model="napcatLoginUi(instance).mode" density="compact" color="primary" grow>
                              <v-tab value="quick">快速登录</v-tab>
                              <v-tab value="password">密码登录</v-tab>
                              <v-tab value="qrcode">扫码登录</v-tab>
                            </v-tabs>
                            <v-window v-model="napcatLoginUi(instance).mode" class="napcat-login-window">
                              <v-window-item value="quick">
                                <div class="napcat-login-pane">
                                  <v-select
                                    v-if="napcatQuickLoginOptions(instance).length"
                                    v-model="napcatLoginUi(instance).quickUserId"
                                    :items="napcatQuickLoginOptions(instance)"
                                    label="已保存的 QQ 登录身份"
                                    hide-details="auto"
                                  />
                                  <v-alert v-else type="info" variant="tonal" density="compact">
                                    这个 NapCat 还没有可用的快速登录身份，请先扫码或使用密码登录一次。
                                  </v-alert>
                                  <v-btn
                                    color="primary"
                                    variant="tonal"
                                    prepend-icon="mdi-lightning-bolt-outline"
                                    :loading="napcatLoginUi(instance).busy"
                                    :disabled="!napcatLoginUi(instance).quickUserId"
                                    @click="submitNapcatQuickLogin(instance)"
                                  >
                                    快速登录
                                  </v-btn>
                                </div>
                              </v-window-item>
                              <v-window-item value="password">
                                <div class="napcat-login-pane">
                                  <template v-if="napcatLoginUi(instance).newDevice">
                                    <v-alert type="warning" variant="tonal" density="compact">
                                      检测到新设备登录。请使用手机 QQ 扫码，并在手机上确认。
                                    </v-alert>
                                    <img
                                      v-if="napcatLoginUi(instance).newDevice?.qrCodeDataUrl"
                                      class="napcat-login-qr"
                                      :src="napcatLoginUi(instance).newDevice?.qrCodeDataUrl"
                                      alt="QQ 新设备验证二维码"
                                    />
                                    <v-progress-circular v-else indeterminate color="primary" />
                                    <div class="section-note">
                                      {{ napcatLoginUi(instance).newDevice?.status === 'scanned' ? '已扫码，请在手机 QQ 上确认。' : napcatLoginUi(instance).newDevice?.status === 'confirmed' ? '验证完成，正在登录。' : napcatLoginUi(instance).newDevice?.status === 'error' ? '验证状态读取失败，请重新获取二维码。' : '等待扫码确认。' }}
                                    </div>
                                    <div class="d-flex ga-2 flex-wrap">
                                      <v-btn size="small" variant="tonal" @click="prepareNapcatNewDeviceQr(instance)">重新获取二维码</v-btn>
                                      <v-btn size="small" variant="text" color="error" @click="cancelNapcatNewDevice(instance)">取消验证</v-btn>
                                    </div>
                                  </template>
                                  <template v-else-if="napcatLoginUi(instance).captcha">
                                    <v-alert type="warning" variant="tonal" density="compact">
                                      QQ 要求完成安全验证码。验证码由腾讯页面处理，结果只用于本次登录。
                                    </v-alert>
                                    <v-btn
                                      color="warning"
                                      variant="tonal"
                                      prepend-icon="mdi-shield-check-outline"
                                      :loading="napcatLoginUi(instance).busy"
                                      @click="startNapcatCaptcha(instance)"
                                    >
                                      打开安全验证
                                    </v-btn>
                                    <v-btn size="small" variant="text" color="error" @click="napcatLoginUi(instance).captcha = null">取消验证</v-btn>
                                  </template>
                                  <template v-else>
                                    <v-text-field
                                      v-model="napcatLoginUi(instance).userId"
                                      label="QQ 号"
                                      inputmode="numeric"
                                      autocomplete="off"
                                      hide-details="auto"
                                    />
                                    <v-text-field
                                      v-model="napcatLoginUi(instance).password"
                                      label="QQ 密码"
                                      type="password"
                                      autocomplete="new-password"
                                      hint="仅用于本次本机登录请求，不保存到 Route 配置。"
                                      persistent-hint
                                    />
                                    <v-btn
                                      color="primary"
                                      variant="tonal"
                                      prepend-icon="mdi-login-variant"
                                      :loading="napcatLoginUi(instance).busy"
                                      @click="submitNapcatPasswordLogin(instance)"
                                    >
                                      密码登录
                                    </v-btn>
                                  </template>
                                </div>
                              </v-window-item>
                              <v-window-item value="qrcode">
                                <div class="napcat-login-pane napcat-login-qr-pane">
                                  <img
                                    v-if="napcatLoginUi(instance).panel?.qrCodeDataUrl"
                                    class="napcat-login-qr"
                                    :src="napcatLoginUi(instance).panel?.qrCodeDataUrl"
                                    alt="QQ 登录二维码"
                                  />
                                  <v-alert v-else type="info" variant="tonal" density="compact">
                                    暂时没有可用二维码，请刷新；如果 NapCat 尚未启动，先点上方“启动并管理登录”。
                                  </v-alert>
                                  <div class="section-note">请使用手机 QQ 或 TIM 扫描二维码。</div>
                                  <v-btn
                                    color="primary"
                                    variant="tonal"
                                    prepend-icon="mdi-qrcode-scan"
                                    :loading="napcatLoginUi(instance).busy || napcatLoginUi(instance).loading"
                                    @click="refreshNapcatLoginQr(instance)"
                                  >
                                    刷新二维码
                                  </v-btn>
                                </div>
                              </v-window-item>
                            </v-window>
                          </v-card>
                          <v-expansion-panels class="napcat-detail-panel mt-2" variant="accordion">
                            <v-expansion-panel>
                              <v-expansion-panel-title>更多详情</v-expansion-panel-title>
                              <v-expansion-panel-text>
                          <v-alert
                            v-if="napcatInstancePortError(instance)"
                            type="error"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatInstancePortError(instance) }}
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                size="small"
                                color="error"
                                variant="tonal"
                                prepend-icon="mdi-auto-fix"
                                :loading="fixingNapcatPorts"
                                :disabled="fixingNapcatPorts"
                                @click="fixNapcatPorts(instance)"
                              >
                                自动分配端口并保存
                              </v-btn>
                            </div>
                          </v-alert>
                          <v-alert
                            v-if="napcatPortFixResult[instance.id]"
                            :type="napcatPortFixResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatPortFixResult[instance.id].message }}
                          </v-alert>
                          <v-alert
                            v-if="napcatOneBotFixResult[instance.id]"
                            :type="napcatOneBotFixResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatOneBotFixResult[instance.id].message }}
                          </v-alert>
                          <v-alert
                            v-if="napcatWebuiSessionMismatch(instance)"
                            type="warning"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            当前 NapCat 会话是 {{ napcatWebuiSessionLabel(instance) }}，但这个 Route 绑定的是 QQ {{ napcatExpectedUserId(instance) }}。它不会覆盖 Route 身份；修复 OneBot 前请先在上方登录卡片切到正确 QQ。
                          </v-alert>
                          <v-expansion-panels class="napcat-detail-panel mt-2" variant="accordion">
                            <v-expansion-panel>
                              <v-expansion-panel-title>自动分配详情</v-expansion-panel-title>
                              <v-expansion-panel-text>
                                <v-alert type="info" variant="tonal" density="compact" class="mb-3">
                                  RabiRoute 会自动生成和维护这些值，用户通常只需要登录 QQ 并勾选是否作为消息渠道。
                                </v-alert>
                                <div class="napcat-auto-summary">
                                  <div><span>管理接口</span><b>{{ instance.webuiUrl || "-" }}</b></div>
                                  <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                                  <div><span>WS</span><b>{{ napcatInstanceWsUrl(instance) }}</b></div>
                                  <div><span>工作目录</span><b>{{ instance.workingDir || "自动生成" }}</b></div>
                                </div>
                                <v-switch
                                  v-model="instance.autoLoginOnRabiStart"
                                  class="mt-2"
                                  label="启动 Rabi 时自动登录"
                                  hint="默认开启。Manager 启动完成后在后台启动该 NapCat，并使用已保存的快速登录身份。"
                                  persistent-hint
                                  color="primary"
                                  @update:model-value="touch"
                                />
                                <v-expansion-panels class="mt-3" variant="accordion">
                                  <v-expansion-panel>
                                    <v-expansion-panel-title>高级配置</v-expansion-panel-title>
                                    <v-expansion-panel-text>
                                      <div class="catalog-param-grid">
                                        <v-text-field v-model="instance.name" label="内部备注" placeholder="可选，仅用于排障" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model.number="instance.gatewayPort" type="number" label="RabiRoute WS 端口" :error-messages="napcatInstancePortError(instance)" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.httpUrl" label="NapCat HTTP 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.webuiUrl" label="NapCat 管理接口地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.accessToken" label="OneBot HTTP 鉴权密钥" placeholder="一般留空；仅 HTTP Server 设置 token 时填写" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.launchCommand" class="full-span" label="启动命令" placeholder="自动生成" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.workingDir" class="full-span" label="NapCat Shell 工作目录" placeholder="自动生成" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                      </div>
                                    </v-expansion-panel-text>
                                  </v-expansion-panel>
                                </v-expansion-panels>
                              </v-expansion-panel-text>
                            </v-expansion-panel>
                          </v-expansion-panels>
                          <v-alert
                            v-if="!instance.launchCommand && !napcatAccountUserId(instance)"
                            type="info"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            当前绑定还没有启动命令；RabiRoute 只能检查连接并给出 WS 地址，不能自动拉起 NapCat 后台。
                          </v-alert>
                          <v-alert
                            v-if="napcatLaunchResult[instance.id]"
                            :type="napcatLaunchResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatLaunchResult[instance.id].message }}
                          </v-alert>
                          <v-alert
                            v-if="napcatInstanceHealthResult[instance.id]"
                            :type="napcatInstanceHealthResult[instance.id]?.ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            <div v-if="napcatInstanceHealthResult[instance.id]?.message">{{ napcatInstanceHealthResult[instance.id]?.message }}</div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.http">
                              HTTP：{{ napcatInstanceHealthResult[instance.id]?.http?.ok ? `可用，${napcatInstanceHealthResult[instance.id]?.http?.nickname || napcatInstanceHealthResult[instance.id]?.http?.userId || '已登录'}` : (napcatInstanceHealthResult[instance.id]?.http?.message || '不可用') }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.onebot?.currentUserId">
                              当前 NapCat QQ：{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentUserId }}{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname ? ` / ${napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname}` : "" }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui">
                              管理接口：{{ napcatInstanceHealthResult[instance.id]?.webui?.reachable ? "可访问" : "未响应" }} · {{ napcatInstanceHealthResult[instance.id]?.webui?.url }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.found">
                              管理凭据：已从 NapCat webui.json 读取 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位；仅由 Rabi 后端代理使用。
                            </div>
                            <div v-else-if="napcatInstanceHealthResult[instance.id]?.webui?.source === 'provided'">
                              管理凭据：使用当前 Route 保存的 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位凭据。
                            </div>
                            <div v-else-if="napcatInstanceHealthResult[instance.id]?.webui?.message">
                              管理凭据：{{ napcatInstanceHealthResult[instance.id]?.webui?.message }}
                            </div>
                            <div>WS：请在对应 NapCat WebSocket Client 里连接 {{ napcatInstanceHealthResult[instance.id]?.wsUrl || napcatInstanceWsUrl(instance) }}</div>
                            <ul v-if="napcatInstanceHealthResult[instance.id]?.diagnostics?.length" class="health-diagnostics">
                              <li v-for="item in napcatInstanceHealthResult[instance.id]?.diagnostics" :key="item">{{ item }}</li>
                            </ul>
                          </v-alert>
                          <div class="adapter-log-panel mt-3">
                            <div class="section-title-row compact-row">
                              <div>
                                <div class="section-title small-title">{{ napcatAccountLogTitle(instance) }} 日志</div>
                                <div class="section-note">只展示此 QQ / 实例对应的连接、登录、入站和解析日志。</div>
                              </div>
                              <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                            </div>
                            <div v-if="napcatLogEntriesFor(instance).length" class="adapter-log-list">
                              <v-expansion-panels variant="accordion" density="compact">
                                <v-expansion-panel
                                  v-for="(entry, logIndex) in napcatLogEntriesFor(instance)"
                                  :key="`${entry.path}-${entry.messageId || logIndex}`"
                                >
                                  <v-expansion-panel-title>
                                    <div class="adapter-log-title">
                                      <span>{{ formatLogTime(entry) }}</span>
                                      <b>{{ logEventTitle(entry) }}</b>
                                      <span>{{ entry.target || "-" }}</span>
                                      <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                                    </div>
                                  </v-expansion-panel-title>
                                  <v-expansion-panel-text>
                                    <div class="status-row"><span>实例</span><b>{{ entry.instanceId || instance.id || "-" }}</b></div>
                                    <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                                    <div class="status-row"><span>来源</span><b>{{ entry.sender || entry.target || "-" }}</b></div>
                                    <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                                    <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                                  </v-expansion-panel-text>
                                </v-expansion-panel>
                              </v-expansion-panels>
                            </div>
                            <div v-else class="empty-state compact-empty">
                              <div>
                                <strong>暂无此账号日志</strong>
                                <span>{{ adapterLogPaths('napcat').join(' / ') || '等待启动或收到连接后生成日志。' }}</span>
                              </div>
                            </div>
                            <div class="adapter-message-file-panel mt-2">
                              <div class="section-title small-title">{{ napcatAccountLogTitle(instance) }} 消息文件</div>
                              <div class="section-note">{{ messageFilePaths('napcat').join(' / ') || '尚未生成消息文件。' }}</div>
                              <div v-if="napcatMessageFileEntriesFor(instance).length" class="adapter-message-preview">
                                <div
                                  v-for="(entry, messageIndex) in napcatMessageFileEntriesFor(instance).slice(0, 3)"
                                  :key="`${entry.path}-${entry.messageId || messageIndex}`"
                                >
                                  {{ formatLogTime(entry) }} · {{ entry.source }} · {{ logPreview(entry) }}
                                </div>
                              </div>
                            </div>
                          </div>
                              </v-expansion-panel-text>
                            </v-expansion-panel>
                          </v-expansion-panels>
                        </div>
                      </div>
                    </div>
                  </div>
                  <template v-if="choice.type === 'napcat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('napcat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('napcat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>WS 连接</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : napcatPrimaryOffline() ? 'text-error' : napcatState.connected ? 'text-success' : 'text-error'">{{ messageAdapterInactive ? "未启用" : napcatPrimaryOffline() ? "QQ 已离线" : napcatState.connected ? "已连接" : "未连接" }}</b></div>
                    <div class="status-row"><span>远端地址</span><b>{{ napcatState.remoteAddress || "-" }}</b></div>
                    <div class="status-row"><span>最后连接</span><b>{{ napcatState.lastConnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>最后断开</span><b>{{ napcatState.lastDisconnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>登录资料</span><b :class="napcatState.loginInfoError ? 'text-error' : ''">{{ napcatState.loginInfoError || napcatState.lastLoginInfoAt || "-" }}</b></div>
                  </template>
                  <div v-else-if="choice.type === 'speech'" class="catalog-param-grid">
                    <v-alert v-if="speechAdapterActionError" class="full-span" type="error" variant="tonal" density="compact">
                      {{ speechAdapterActionError }}
                    </v-alert>
                    <div class="full-span">
                      <v-switch
                        :model-value="hotDeliveryEnabled(gateway.speechPushMode)"
                        color="primary"
                        label="热投递"
                        hint="开启（hot）：每段 ASR 立即投递。关闭（keyword）：未命中关键词时只记录，命中当前人格关键词时才投递。"
                        persistent-hint
                        @update:model-value="setSpeechHotDelivery"
                      />
                      <v-alert
                        v-if="!hotDeliveryEnabled(gateway.speechPushMode) && !(gateway.speechTriggerKeywords || []).length"
                        class="mt-2"
                        type="warning"
                        variant="tonal"
                        density="compact"
                      >
                        <div>当前人格没有语音唤醒关键词。关闭热投递后，转写仍会记录，但不会唤醒 Agent。</div>
                        <v-btn
                          class="mt-2"
                          size="small"
                          variant="tonal"
                          prepend-icon="mdi-account-cog-outline"
                          :to="personaConfigRoute"
                        >
                          配置人格关键词
                        </v-btn>
                      </v-alert>
                    </div>
                    <div class="full-span persona-speech-summary">
                      <div>
                        <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="personaAvatarUrl" :size="42" />
                        <span>人格</span>
                        <b>{{ gateway.agentRoleId || "未选择" }}</b>
                      </div>
                      <div>
                        <span>TTS 模型</span>
                        <b>{{ speechPersonaConfig?.defaultModel || "由人格 voice-profile 配置" }}</b>
                      </div>
                      <div>
                        <span>语言</span>
                        <b>{{ speechPersonaConfig?.language || "由人格 voice-profile 配置" }}</b>
                      </div>
                      <div>
                        <span>声音风格</span>
                        <b>{{ speechPersonaConfig?.voiceStyleSummary || speechPersonaConfig?.instructions || "尚未配置" }}</b>
                      </div>
                    </div>
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      当前 Route 只负责订阅主机 ASR 广播、热投递/人格关键词策略和是否播放回复。ASR 模型、麦克风、VAD 与切句参数属于整台电脑，请到“语音服务”统一设置；TTS 模型、声线、语言、语速和发声说明归当前人格的 <code>voice/voice-profile.json</code> 管理。
                    </v-alert>
                    <v-switch
                      color="primary"
                      label="Agent 回复自动排队播放"
                      :model-value="speechVariable('speechAutoPlay', speechDefaultVariables.speechAutoPlay) !== 'false'"
                      @update:model-value="setSpeechAutoPlay"
                    />
                    <v-alert class="full-span" type="warning" variant="tonal" density="compact">
                      主机只做一次 ASR，再把同一份文字广播给订阅 Route；不会为每个人格重复占用麦克风或重复跑识别模型。
                    </v-alert>
                  </div>
                  <div v-else-if="choice.type === 'remoteAgent'" class="catalog-param-grid">
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      远端 Agent 是下游 Agent 设备入口。远端机器只运行 <code>plugin-adapters/remote-agent-rabiroute</code> bridge，无人值守等待 RabiGUI 扫描；选择设备并输入密码后，本机人格会通过 Rabi API 投递任务。
                    </v-alert>
                    <div class="full-span">
                      <v-menu v-model="remoteAgentDeviceMenu" location="bottom start" :close-on-content-click="false">
                        <template #activator="{ props }">
                          <v-btn
                            v-bind="props"
                            class="remote-agent-device-select"
                            variant="outlined"
                            block
                            append-icon="mdi-menu-down"
                            :loading="remoteAgentDevicesLoading"
                            @click="remoteAgentDeviceOptions.length ? undefined : scanRemoteAgentDevices()"
                          >
                            <span class="remote-agent-device-select-main">{{ selectedRemoteAgentDeviceLabel }}</span>
                          </v-btn>
                        </template>
                        <v-list class="remote-agent-device-menu" density="compact">
                          <v-list-item
                            v-for="device in remoteAgentDeviceOptions"
                            :key="device.deviceId"
                            prepend-icon="mdi-lan-connect"
                            :title="device.label"
                            :subtitle="device.subtitle"
                            @click="selectRemoteAgentDevice(device.deviceId)"
                          />
                          <v-list-item
                            v-if="remoteAgentDeviceOptions.length === 0"
                            prepend-icon="mdi-lan-disconnect"
                            title="还没有扫描到远端 Agent 设备"
                            subtitle="先在另一台设备运行 remote-agent-rabiroute bridge，再扫描局域网。"
                          />
                        </v-list>
                      </v-menu>
                      <div class="field-hint">选择当前路由默认投递的远端设备；端口占用会由 bridge 和 Rabi 扫描自动处理。</div>
                    </div>
                    <v-text-field
                      v-model="remoteAgentPassword"
                      class="full-span"
                      type="password"
                      label="连接密码"
                      :placeholder="selectedRemoteAgentDevice?.passwordSaved ? '已记住密码，留空可直接连接' : '输入远端 bridge 启动时显示的密码'"
                      autocomplete="current-password"
                    />
                    <v-alert v-if="remoteAgentConnectResult" class="full-span" :type="remoteAgentConnectResult.ok ? 'success' : 'warning'" variant="tonal" density="compact">
                      {{ remoteAgentConnectResult.message }}
                    </v-alert>
                    <v-alert v-if="remoteAgentDeviceError" class="full-span" type="warning" variant="tonal" density="compact">
                      {{ remoteAgentDeviceError }}
                    </v-alert>
                    <div v-if="selectedRemoteAgentDevice" class="full-span">
                      <div class="status-row"><span>选中设备</span><b>{{ remoteAgentDeviceTitle(selectedRemoteAgentDevice) }}</b></div>
                      <div class="status-row"><span>连接状态</span><b :class="selectedRemoteAgentDevice.connected ? 'text-success' : 'text-warning'">{{ selectedRemoteAgentDevice.connected ? "已连接" : "未连接" }}</b></div>
                      <div class="status-row"><span>Agent 类型</span><b>{{ selectedRemoteAgentDevice.agentType || "agent" }}</b></div>
                      <div class="status-row"><span>系统</span><b>{{ [selectedRemoteAgentDevice.os, selectedRemoteAgentDevice.osVersion, selectedRemoteAgentDevice.arch].filter(Boolean).join(" ") || "-" }}</b></div>
                      <div class="status-row"><span>IP</span><b>{{ selectedRemoteAgentDevice.observedIp || selectedRemoteAgentDevice.declaredIp || selectedRemoteAgentDevice.host || "-" }}</b></div>
                      <div class="status-row"><span>密码</span><b>{{ selectedRemoteAgentDevice.passwordSaved ? "已记住" : "未保存" }}</b></div>
                      <div class="status-row"><span>默认 cwd</span><b>{{ selectedRemoteAgentDevice.defaultCwd || "-" }}</b></div>
                      <div class="status-row"><span>默认线程</span><b>{{ selectedRemoteAgentDevice.defaultThreadName || "-" }}</b></div>
                      <div v-if="selectedRemoteAgentDevice.connectionError" class="status-row"><span>连接诊断</span><b class="text-warning">{{ selectedRemoteAgentDevice.connectionError }}</b></div>
                    </div>
                    <div class="full-span">
                      <div class="status-row"><span>设备发现 API</span><b>/api/remote-agent/devices</b></div>
                      <div class="status-row"><span>任务投递 API</span><b>/api/remote-agent/tasks</b></div>
                      <div class="status-row"><span>局域网扫描</span><b>{{ remoteAgentDiscoveryDetail }}</b></div>
                      <div class="status-row"><span>在线状态</span><b :class="remoteAgentConnected ? 'text-success' : 'text-warning'">{{ remoteAgentConnected ? '已有设备连接' : '等待扫描并连接' }}</b></div>
                    </div>
                    <div class="agent-action-bar full-span mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">开启后，Agent prompt 会注入远端 Agent 设备 API。bridge 没有公知默认密码；请使用远端终端显示的临时密码或预先配置的高熵密码。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="secondary" prepend-icon="mdi-lan-pending" :loading="remoteAgentDevicesLoading" @click="scanRemoteAgentDevices">
                          扫描局域网
                        </v-btn>
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-lan-connect" :loading="remoteAgentConnecting" :disabled="!selectedRemoteAgentDeviceId" @click="connectRemoteAgentDevice">
                          连接
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-lan-disconnect" :loading="remoteAgentConnecting" :disabled="!selectedRemoteAgentDeviceId || !selectedRemoteAgentDevice?.connected" @click="disconnectRemoteAgentDevice">
                          断开
                        </v-btn>
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText('/api/remote-agent/devices', '已复制远端 Agent 设备 API')">
                          复制设备 API
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="choice.type === 'heartbeat'" class="catalog-param-grid">
                    <v-alert v-if="managedMessageAgentModeEnabled" class="full-span" type="success" variant="tonal" density="compact">
                      Codex 消息处理 Agent 模式已开启。heartbeat 会立即交给独立消息处理 Agent，不会因为主人格会话正在工作而跳过，也不进入聊天消息合并等待。
                    </v-alert>
                    <v-alert v-else class="full-span" type="info" variant="tonal" density="compact">
                      定时计划在“人格配置 / 消息模板规则”的 heartbeat 规则里维护。下面的忙时策略只影响 heartbeat，普通群聊、私聊和其他消息仍按正常路由直接投递。
                    </v-alert>
                    <v-switch
                      v-if="!managedMessageAgentModeEnabled"
                      v-model="gateway.heartbeatSkipWhenAgentBusy"
                      class="full-span"
                      color="primary"
                      label="会话工作中时跳过心跳"
                      hint="开启后，仅当 Agent 会话仍在工作时把本次 heartbeat 记为 skipped；普通消息不受影响。"
                      persistent-hint
                      @update:model-value="touch"
                    />
                  </div>
                  <template v-if="choice.type === 'heartbeat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('heartbeat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('heartbeat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>触发器状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : heartbeatState.enabled === false ? 'text-error' : 'text-success'">{{ messageAdapterInactive ? "未启用" : heartbeatState.enabled === false ? "未启用" : "已启用" }}</b></div>
                    <div class="status-row"><span>计划数量</span><b>{{ heartbeatState.scheduleCount ?? "-" }}</b></div>
                    <div class="status-row"><span>下次触发</span><b>{{ heartbeatState.nextTickAt || "-" }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">立即触发会向当前 Agent 端投递一条心跳消息；日志页可看完整结果。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="secondary"
                          prepend-icon="mdi-play-circle-outline"
                          :loading="triggeringHeartbeat"
                          :disabled="triggeringHeartbeat || !runtime.running"
                          @click="triggerHeartbeatNow"
                        >
                          立即触发
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert
                      v-if="heartbeatTriggerResult"
                      :type="heartbeatTriggerResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="mt-2"
                    >
                      {{ heartbeatTriggerResult.message }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">适配器日志</div>
                          <div class="section-note">启用、tick 和投递过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('heartbeat').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('heartbeat')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无心跳适配器日志</strong>
                          <span>{{ adapterLogPaths('heartbeat').join(' / ') || '等待启动或触发后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('heartbeat').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('heartbeat').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('heartbeat').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="choice.type === 'feishu'" class="catalog-param-grid">
                    <v-text-field v-model="gateway.feishuAppId" label="飞书 App ID" placeholder="cli_xxx" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuAppSecret" type="password" label="飞书 App Secret" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuVerificationToken" type="password" label="Verification Token" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuEncryptKey" type="password" label="Encrypt Key" @update:model-value="touch" />
                    <v-text-field :model-value="webhookPortFor('feishu')" type="number" label="本机回调端口" @update:model-value="value => setWebhookPort('feishu', value)" />
                    <v-text-field :model-value="webhookPathFor('feishu')" label="独立回调路径" placeholder="/feishu" @update:model-value="value => setWebhookPath('feishu', value)" />
                    <v-switch
                      v-model="gateway.feishuEventSubscriptionEnabled"
                      class="full-span"
                      color="primary"
                      density="compact"
                      hide-details
                      label="已在飞书应用中配置公网 HTTPS 回调并订阅 im.message.receive_v1"
                      @update:model-value="touch"
                    />
                    <v-alert type="warning" variant="tonal" density="compact" class="full-span">
                      这里仅接受飞书应用凭据与事件订阅配置。群机器人 Webhook 属于通用 Webhook 预留，不能作为飞书消息端。
                    </v-alert>
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      未同时配置 App ID、App Secret、Verification Token、Encrypt Key，并勾选事件订阅确认时，监听和出站都会保持关闭。
                    </v-alert>
                  </div>
                  <template v-if="choice.type === 'feishu' && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>回调监听</span><b :class="feishuState.listenerReady ? 'text-success' : 'text-warning'">{{ feishuState.listenerReady ? "已监听" : feishuState.message || "保持关闭" }}</b></div>
                    <div class="status-row"><span>订阅验证</span><b :class="feishuState.subscriptionVerified ? 'text-success' : 'text-warning'">{{ feishuState.subscriptionVerified ? "已收到验证/事件" : "尚未验证" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ feishuState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>最近事件 ID</span><b>{{ feishuState.lastEventId || "-" }}</b></div>
                  </template>
                  <div v-else-if="choice.type === 'wecom'" class="catalog-param-grid">
                    <v-text-field v-model="gateway.wecomBotId" label="企业微信 Bot ID" placeholder="可留空使用 WECOM_BOT_ID" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomBotSecret" type="password" label="企业微信 Bot Secret" placeholder="可留空使用 WECOM_BOT_SECRET" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomWsUrl" class="full-span" label="企业微信 WebSocket 地址" placeholder="留空使用 SDK 默认地址；私有部署时填写" @update:model-value="touch" />
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      企业微信消息端使用智能机器人 WebSocket 长连接，主场景是企业微信群聊；模板变量会尽量对齐 NapCat 的 groupId、userId、sender、message 和 messageId。
                    </v-alert>
                  </div>
                  <template v-if="choice.type === 'wecom' && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>连接</span><b :class="wecomState.connected && wecomState.authenticated ? 'text-success' : 'text-warning'">{{ wecomState.connected && wecomState.authenticated ? "已认证" : wecomState.message || "未连接" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ wecomState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>消息数</span><b>{{ wecomState.messageCount ?? 0 }}</b></div>
                    <v-alert v-if="wecomState.lastError" type="error" variant="tonal" density="compact" class="mt-2">
                      {{ wecomState.lastError }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">企业微信适配器日志</div>
                          <div class="section-note">连接、认证、消息接收和错误日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('wecom').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('wecom')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无企业微信适配器日志</strong>
                          <span>{{ adapterLogPaths('wecom').join(' / ') || '等待启动后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('wecom').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('wecom').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('wecom').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="choice.type === 'weixin'" class="catalog-param-grid">
                    <v-expansion-panels class="full-span" variant="accordion">
                      <v-expansion-panel>
                        <v-expansion-panel-title>高级设置（通常无需修改）</v-expansion-panel-title>
                        <v-expansion-panel-text>
                          <div class="catalog-param-grid">
                            <v-text-field v-model="gateway.weixinBaseUrl" class="full-span" label="个人微信 iLink API" placeholder="https://ilinkai.weixin.qq.com" @update:model-value="touch" />
                            <v-text-field v-model="gateway.weixinBotType" label="Bot Type" placeholder="3" @update:model-value="touch" />
                          </div>
                        </v-expansion-panel-text>
                      </v-expansion-panel>
                    </v-expansion-panels>
                  </div>
                  <template v-if="choice.type === 'weixin' && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>会话</span><b :class="weixinState.loggedIn ? 'text-success' : 'text-warning'">{{ weixinState.message || "状态未知" }}</b></div>
                    <div class="status-row"><span>恢复状态</span><b>{{ weixinSessionPhaseLabel(weixinState.sessionPhase) }}</b></div>
                    <div class="status-row"><span>凭据保留</span><b>{{ weixinState.credentialsRetained ? "是" : "否" }}</b></div>
                    <div class="status-row"><span>扫码状态</span><b>{{ weixinState.qrStatus || "-" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ weixinState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>消息数</span><b>{{ weixinState.messageCount ?? 0 }}</b></div>
                    <div v-if="!weixinState.loggedIn && weixinState.qrCodeDataUrl" class="full-span d-flex flex-column align-center ga-2 mt-2">
                      <v-img :src="weixinState.qrCodeDataUrl" width="320" max-width="100%" aspect-ratio="1" alt="个人微信登录二维码" />
                      <span class="section-note">请使用手机微信扫码；二维码约 5 分钟后自动刷新。</span>
                    </div>
                    <v-alert v-if="weixinState.lastError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinState.lastError }}
                    </v-alert>
                    <v-alert v-if="weixinLoginError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinLoginError }}
                    </v-alert>
                    <div class="agent-action-bar full-span mt-2">
                      <div class="agent-action-status"><span class="section-note">登录态只保存在当前 Route 的运行期 data 目录，不写进公开配置。</span></div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          v-if="weixinState.loginRequired && !weixinState.qrCodeDataUrl"
                          size="small"
                          color="warning"
                          variant="tonal"
                          prepend-icon="mdi-qrcode"
                          :loading="weixinLoginBusy"
                          @click="requestPersonalWeixinLogin"
                        >
                          生成登录二维码
                        </v-btn>
                        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" @click="store.load">刷新状态</v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">打开日志</v-btn>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="choice.type === 'wearable'" class="catalog-param-grid">
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      此消息端复用控制台里的全局 RabiLink Relay，不另开监听端口。RabiLink 手机端负责配置设备、加密保存小米密钥、读取 Health Connect 并上报；普通样本只记录，阈值或睡眠状态规则命中后才投递 Agent。
                    </v-alert>
                    <div class="status-row full-span"><span>角色健康状态 API</span><b>/api/roles/{{ gateway.agentRoleId || "Rabi" }}/health/state</b></div>
                    <div class="status-row full-span"><span>健康历史 API</span><b>/api/roles/{{ gateway.agentRoleId || "Rabi" }}/health/history</b></div>
                    <div class="status-row full-span"><span>健康摘要 API</span><b>/api/roles/{{ gateway.agentRoleId || "Rabi" }}/health/summary</b></div>
                  </div>
                  <div v-else-if="isWebhookLikeAdapter(choice.type)" class="catalog-param-grid">
                    <v-text-field v-if="choice.type === 'rabilink'" :model-value="webhookHostFor(choice.type)" :label="`${sourceTitle(choice.type)} 监听地址`" placeholder="0.0.0.0" @update:model-value="value => setWebhookHost(choice.type, value)" />
                    <v-text-field :model-value="webhookPortFor(choice.type)" type="number" :label="`${sourceTitle(choice.type)} 监听端口`" @update:model-value="value => setWebhookPort(choice.type, value)" />
                    <v-text-field :model-value="webhookPathFor(choice.type)" :label="`${sourceTitle(choice.type)} 路径`" :placeholder="adapterDefaultWebhookPath(choice.type)" @update:model-value="value => setWebhookPath(choice.type, value)" />
                    <v-alert v-if="choice.type === 'rabilink'" class="full-span" type="info" variant="tonal" density="compact">
                      Relay 服务器、应用 token 和本机 Rabi PC 标识在控制台的 Rabi 实例里统一配置；这里添加消息端即可接收 RabiLink 输入。
                    </v-alert>
                  </div>
                  <template v-if="isWebhookLikeAdapter(choice.type) && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl(choice.type) }}</b></div>
                    <div v-if="choice.type === 'rabilink'" class="status-row"><span>复制回调</span><b>{{ callbackUrl(choice.type) }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">{{ sourceTitle(choice.type) }} 使用底层 HTTP 回调；RabiLink 的回调地址会把 0.0.0.0 换成本机可访问 IP。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl(choice.type), `已复制 ${sourceTitle(choice.type)} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn v-if="choice.type === 'rabilink'" size="small" variant="text" prepend-icon="mdi-access-point" @click="copyText(webhookUrl(choice.type), '已复制监听地址')">
                          复制监听
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl(choice.type), '已复制 curl 示例')">
                          复制 curl
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                      {{ copyResult }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">{{ sourceTitle(choice.type) }} 适配器日志</div>
                          <div class="section-note">按 voiceSource / source 匹配请求、接收、拒绝和错误等过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="sourceLogEntries(choice.type).length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in sourceLogEntries(choice.type)"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span>{{ entry.sender || "-" }}</span>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>来源</span><b>{{ entry.sender || entry.target || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无 {{ sourceTitle(choice.type) }} 日志</strong>
                          <span>{{ adapterLogPaths(choice.type).join(' / ') || '等待启动或收到请求后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">{{ sourceTitle(choice.type) }} 消息文件</div>
                        <div class="section-note">{{ messageFilePaths(choice.type).join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="sourceMessageFileEntries(choice.type).length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in sourceMessageFileEntries(choice.type).slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ entry.source }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </v-expand-transition>
            </div>
          </section>
          <div v-if="visibleAdapterGroups.length === 0 && adapterQuery" class="empty-state compact-empty">
            <div>
              <strong>没有匹配的入口</strong>
              <span>换个关键词，或先清空搜索。</span>
            </div>
          </div>
          <div v-else-if="visibleAdapterGroups.length === 0" class="empty-state compact-empty">
            <div>
              <strong>尚未添加任何消息端</strong>
              <span>点击下方按钮添加入口。</span>
            </div>
          </div>
        </div>

        <div class="adapter-add-row">
          <v-menu v-model="addAdapterMenu" location="bottom start">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                prepend-icon="mdi-plus"
                variant="tonal"
                size="small"
                :disabled="availableToAdd.length === 0"
              >
                添加消息端
              </v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="type in availableToAdd"
                :key="type"
                :title="adapterLabel(type)"
                @click="addAdapter(type)"
              />
            </v-list>
          </v-menu>
        </div>

        <v-alert v-if="messageInputsDisabled" type="info" variant="tonal">当前配置仍带有旧版全局消息禁用字段；请移除该字段，或分别关闭不需要的消息端。</v-alert>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">Agent 端</div>
            <div class="section-note">这里决定分诊后的消息送给哪个处理端，以及 Agent 在哪个项目目录里工作。</div>
          </div>
        </div>

        <div v-if="primaryAgentType" class="catalog-param-grid mb-4">
          <v-select
            class="full-span"
            :model-value="primaryAgentType"
            :items="primaryAgentItems"
            item-title="title"
            item-value="value"
            label="主控 Agent"
            hint="命中规则的消息只投递给主控 Agent；其他 Agent 保留配置，不会收到默认消息。"
            persistent-hint
            @update:model-value="selectPrimaryAgent"
          />
        </div>

        <div class="catalog-list mb-2">
          <div v-for="agent in visibleAgentItems" :key="agent.type" class="catalog-item">
            <div
              class="catalog-row active"
              @click="toggleAgentParams(agent.type)"
            >
              <v-icon class="catalog-row-icon" color="secondary">{{ agent.icon }}</v-icon>
              <span class="catalog-row-main">
                <strong>{{ agent.title }}</strong>
                <small>{{ agent.note }}</small>
              </span>
              <div class="catalog-row-actions">
                <v-chip size="x-small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                  {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                </v-chip>
                <v-chip size="x-small" :color="agentConnectionColor(agent.type)" variant="tonal">
                  {{ agentConnectionLabel(agent.type) }}
                </v-chip>
                <v-btn
                  :icon="agentParamOpen[agent.type] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                  size="small"
                  variant="text"
                  :title="agentParamOpen[agent.type] ? '收起参数' : '展开参数'"
                  @click.stop="toggleAgentParams(agent.type)"
                />
                <v-btn
                  icon="mdi-close"
                  size="small"
                  variant="text"
                  color="error"
                  title="移除此 Agent"
                  @click.stop="removeAgent(agent.type)"
                />
              </div>
            </div>
            <v-expand-transition>
              <div v-if="agentParamOpen[agent.type]" class="catalog-param-panel">
                <div class="dependency-panel mb-3">
                  <div class="section-title-row compact-row">
                    <div>
                      <div class="section-title small-title">环境和依赖</div>
                      <div class="section-note">先确认处理端是否安装、登录、插件可用，以及能否读取项目和会话。</div>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-chip size="small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                        {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                      </v-chip>
                      <v-chip size="small" :color="agentConnectionColor(agent.type)" variant="tonal">
                        {{ agentConnectionLabel(agent.type) }}
                      </v-chip>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agent.type === 'dsh' ? dshScanLoading : agentScan.loading" @click="refreshAgentScan(agent.type)">
                        重新扫描
                      </v-btn>
                    </div>
                  </div>
                  <div class="dependency-list">
                    <div class="dependency-row">
                      <v-chip size="x-small" :color="agentScanFor(agent.type)?.installed ? 'success' : 'warning'" variant="tonal">
                        {{ agentScanFor(agent.type)?.installed ? "已发现" : "未安装" }}
                      </v-chip>
                      <div>
                        <strong>安装状态</strong>
                        <span>{{ agentScanFor(agent.type)?.installed ? "已通过本机扫描发现可用入口。" : "没有发现可用安装或服务；请按下方候选入口安装/打开。" }}</span>
                      </div>
                    </div>
                    <div v-if="agentScanFor(agent.type)?.auth" class="dependency-row">
                      <v-chip size="x-small" :color="agentScanFor(agent.type)?.auth?.loggedIn ? 'success' : 'warning'" variant="tonal">
                        {{ agentScanFor(agent.type)?.auth?.loggedIn ? "已登录" : "未登录" }}
                      </v-chip>
                      <div>
                        <strong>鉴权</strong>
                        <span>{{ agentScanFor(agent.type)?.auth?.message || "需要确认登录状态。" }}</span>
                      </div>
                      <v-btn
                        v-if="agentScanFor(agent.type)?.auth?.loginUrl"
                        size="small"
                        variant="text"
                        prepend-icon="mdi-open-in-new"
                        @click="openExternalUrl(agentScanFor(agent.type)?.auth?.loginUrl)"
                      >
                        打开登录
                      </v-btn>
                    </div>
                    <div
                      v-for="plugin in agentScanFor(agent.type)?.plugins ?? []"
                      :key="plugin.id"
                      class="dependency-row"
                    >
                      <v-chip size="x-small" :color="plugin.installed && plugin.healthy !== false ? 'success' : 'warning'" variant="tonal">
                        {{ !plugin.installed ? "缺插件" : plugin.healthy === false ? "未就绪" : "已加载" }}
                      </v-chip>
                      <div>
                        <strong>{{ plugin.name }}</strong>
                        <span>{{ plugin.version ? `版本：${plugin.version}` : "未读取到插件版本。" }}</span>
                        <span v-for="detail in plugin.details ?? []" :key="`${plugin.id}-${detail}`">{{ detail }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-if="agentScanFor(agent.type)?.endpoints?.length" class="dependency-endpoints mt-2">
                    <div
                      v-for="endpoint in agentScanFor(agent.type)?.endpoints ?? []"
                      :key="`${agent.type}-${endpoint.url}`"
                      class="status-row compact-status-row"
                    >
                      <span>{{ endpoint.label }}</span>
                      <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                    </div>
                  </div>
                  <div v-if="agentScanFor(agent.type)?.installCandidates?.length" class="dependency-actions mt-2">
                    <v-btn
                      v-for="candidate in agentScanFor(agent.type)?.installCandidates"
                      :key="candidate.label"
                      size="small"
                      variant="tonal"
                      :prepend-icon="candidate.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                      @click="openScanCandidate(candidate)"
                    >
                      {{ candidate.label }}
                    </v-btn>
                  </div>
                </div>
                <v-alert
                  v-for="warning in agentWarnings(agent.type)"
                  :key="warning"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mb-2"
                >
                  {{ warning }}
                </v-alert>
                <div v-if="supportsManagedTaskFeature(agent.type, 'messageProcessingAgent') && primaryAgentType === agent.type" class="dependency-panel mb-3">
                  <div class="section-title-row compact-row">
                    <div>
                      <div class="section-title small-title">消息处理 Agent 模式</div>
                      <div class="section-note">开启时，聊天消息和相关后续通知交给消息处理 Agent；关闭时改投给主人格。计划秘书和一计划一 Agent 的绑定不会改变。</div>
                    </div>
                    <v-switch
                      color="primary"
                      density="compact"
                      hide-details
                      inset
                      label="启用"
                      :model-value="messageProcessingAgentPolicy(agent.type).enabled"
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { enabled: value === true })"
                    />
                  </div>
                  <v-alert type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                    开启后，聊天消息默认形成消息组，并动态创建或复用当前主 Agent 端的消息处理 Agent；关闭后，新消息、计划进展通知、回调提醒和 Agent 间待回复改投给主人格，不再打开消息处理会话。ASR 和结构化事件照常直接投递。
                  </v-alert>
                  <div v-if="messageProcessingAgentPolicy(agent.type).enabled" class="catalog-param-grid mt-2">
                    <v-text-field
                      :model-value="messageProcessingAgentPolicy(agent.type).model"
                      label="消息处理模型"
                      hint="默认使用 GPT-5.6 Luna；只影响消息处理 Agent 的新轮次。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { model: String(value || DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL) })"
                    />
                    <v-select
                      :model-value="messageProcessingAgentPolicy(agent.type).reasoningEffort"
                      :items="['low', 'medium', 'high', 'xhigh', 'max']"
                      label="推理强度"
                      hint="默认 medium；同一消息组的后续补充沿用已开始的轮次。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { reasoningEffort: value })"
                    />
                    <v-text-field
                      :model-value="messageProcessingAgentPolicy(agent.type).maxAgents"
                      type="number"
                      min="1"
                      :max="MAX_MESSAGE_PROCESSING_AGENTS"
                      label="消息处理 Agent 上限"
                      hint="Agent 列表统一按消息引用、消息组、会话、说话人和最近使用时间加权排序；上限保留排序后的前 N 个。设置为 1 时，所有新消息和未完成后续都集中到“协助处理消息1”。"
                      persistent-hint
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { maxAgents: value === '' || value == null ? undefined : Number(value) })"
                    />
                  </div>
                  <v-btn
                    v-if="messageProcessingAgentPolicy(agent.type).enabled"
                    class="mt-3"
                    variant="tonal"
                    prepend-icon="mdi-view-dashboard-outline"
                    @click="messageProcessingBoardOpen = true"
                  >
                    打开消息处理看板
                  </v-btn>
                  <v-dialog v-model="messageProcessingBoardOpen" max-width="1200" scrollable>
                    <v-card>
                      <v-card-title class="d-flex align-center justify-space-between">
                        <span>消息处理看板</span>
                        <v-btn icon="mdi-close" variant="text" size="small" title="关闭" @click="messageProcessingBoardOpen = false" />
                      </v-card-title>
                      <v-card-text>
                        <MessageProcessingBoard
                          v-if="messageProcessingBoardOpen && managedMessageAgentModeEnabled"
                          :gateway-id="gateway.id"
                          :enabled="true"
                        />
                      </v-card-text>
                    </v-card>
                  </v-dialog>
                </div>
                <!-- Codex -->
                <template v-if="agent.type === 'codex'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    实际消息只交给 Codex/ChatGPT Desktop 当前任务执行，因此桌面端会立即显示消息并沿用该任务的工具、模型与权限。Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      :model-value="gateway.agentModel"
                      :items="codexModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主人格模型"
                      hint="Desktop 可用时读取当前账号的模型目录；读取失败时仍可手动输入。留空则沿用目标任务自己的模型。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectCodexModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-select
                      v-model="gateway.agentReasoningEffort"
                      :items="codexReasoningEffortItems"
                      label="主人格推理强度"
                      hint="与主人格模型一起应用到 Desktop 新轮次；留空时沿用 Desktop 当前设置。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codex')" label="工作目录" placeholder="留空，使用 RabiRoute 根目录" hint="用于同名任务的自动查找和新建；选择已有任务时会自动采用任务自己的目录" persistent-hint @update:model-value="touch">
                    </v-combobox>
                    <v-combobox :model-value="gateway.codexThreadId || gateway.codexThreadName" :items="codexSessionItems()" item-title="title" item-value="value" :return-object="false" label="会话名 + 最后会话时间" placeholder="选择已有会话，或输入新会话名" hint="每次读取 200 个 Desktop 任务且不显示 ID；可继续加载，输入名称后只查找，唯一匹配就绑定，没有匹配则在点击保存时创建" persistent-hint @update:model-value="selectCodexSession" @blur="lookupCodexThreadBinding">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading || codexBinding.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="codexSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-btn
                      v-if="agentScanFor('codex')?.sessionPage?.hasMore"
                      size="small"
                      variant="text"
                      prepend-icon="mdi-chevron-down"
                      :loading="agentScan.loading"
                      @click="loadMoreCodexSessions"
                    >
                      加载更多 Desktop 任务
                    </v-btn>
                  </div>
                  <div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('codex')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('codex')"
                    >
                      定位会话
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-account-sync-outline"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="initializeManagedAgentSession('codex')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 Desktop 任务；未绑定时可初始化会话。</span>
                  </div>
                  <v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert>
                  <v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert>
                  <v-alert v-if="codexBinding.error" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ codexBinding.error }}
                  </v-alert>
                  <v-alert v-else-if="codexBinding.pending" type="info" variant="tonal" density="compact" class="mt-2 mb-1">
                    尚无同名 Desktop 会话；点击保存时会创建任务、写入完整 ID 并切换绑定。
                  </v-alert>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="agentStateFor('codex').lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').lastNotificationError }}
                    </v-alert>
                    <v-alert v-else-if="agentStateFor('codex').message" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').message }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="agentStateFor('codex').monitorThreadId ? 'text-success' : 'text-warning'">{{ agentStateFor('codex').monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ agentStateFor('codex').monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('codex').lastNotificationAt || "-" }}</b></div>
                    <div class="status-row"><span>投递协议</span><b>{{ codexDeliveryChannelLabel(agentStateFor('codex')) }}</b></div>
                    <div class="status-row"><span>桌面宿主</span><b>Codex/ChatGPT Desktop（必需）</b></div>
                  </template>
                </template>
                <!-- Copilot CLI -->
                <template v-else-if="agent.type === 'copilotCli'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.copilotCliBin" :items="agentScan.copilotBins" label="CLI 可执行路径" placeholder="copilot" hint="留空则使用 PATH 中的 copilot" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.copilotBins.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotCwd" :items="agentProjectItems('copilotCli')" label="工作目录 (-C)" placeholder="留空则使用 RabiRoute 根目录" hint="copilot -C &lt;目录&gt;，影响会话分组" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotThreadName" :items="sessionNamesFor('copilotCli')" label="会话线程名" placeholder="Rabi" hint="Copilot CLI session 名称（--name 参数）" persistent-hint @update:model-value="selectCopilotSession">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <!-- 安装/登录操作区 -->
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span v-if="copilotStatus === null" class="section-note">检测中…</span>
                      <template v-else>
                        <v-chip size="x-small" :color="copilotStatus.installed ? 'success' : 'error'" variant="tonal" class="mr-1">
                          {{ copilotStatus.installed ? '已安装' : '未安装' }}
                        </v-chip>
                        <v-chip size="x-small" :color="copilotStatus.loggedIn ? 'success' : 'warning'" variant="tonal">
                          {{ copilotStatus.loggedIn ? '已登录' : '未登录' }}
                        </v-chip>
                      </template>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn v-if="copilotStatus && !copilotStatus.installed" size="small" variant="tonal" color="primary"
                        :loading="copilotInstalling" prepend-icon="mdi-download" @click="installCopilotCli">
                        安装 Copilot CLI
                      </v-btn>
                      <v-btn v-if="copilotStatus && copilotStatus.installed && !copilotStatus.loggedIn && !copilotLoginState.code"
                        size="small" variant="tonal" color="secondary"
                        :loading="copilotLoginState.loading" prepend-icon="mdi-login" @click="startCopilotLogin">
                        登录
                      </v-btn>
                      <v-btn v-if="copilotStatus" size="small" variant="text" icon="mdi-refresh" @click="fetchCopilotStatus" title="刷新状态" />
                    </div>
                  </div>
                  <!-- 登录 device code -->
                  <v-alert v-if="copilotLoginState.code" type="info" variant="tonal" density="compact" class="mt-2">
                    <div class="d-flex align-center justify-space-between flex-wrap ga-2">
                      <div>
                        在浏览器访问 <a :href="copilotLoginState.url ?? 'https://github.com/login/device'" target="_blank">github.com/login/device</a>，输入验证码：
                        <strong class="ml-1" style="font-size:1.1em;letter-spacing:2px">{{ copilotLoginState.code }}</strong>
                      </div>
                      <v-chip size="small" color="info" variant="tonal">等待授权…</v-chip>
                    </div>
                  </v-alert>
                  <v-alert v-if="copilotLoginState.done" type="success" variant="tonal" density="compact" class="mt-2">登录成功</v-alert>
                  <v-alert v-if="copilotLoginState.error" type="error" variant="tonal" density="compact" class="mt-2">{{ copilotLoginState.error }}</v-alert>
                  <!-- 运行时诊断 -->
                  <template v-if="runtime.running !== undefined">
                    <div class="mt-2">
                      <template v-if="agentStateFor('copilotCli').lastNotificationError">
                        <v-alert type="warning" variant="tonal" density="compact" class="mb-1">
                          {{ agentStateFor('copilotCli').lastNotificationError }}
                        </v-alert>
                      </template>
                      <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('copilotCli').lastNotificationAt || "-" }}</b></div>
                      <div class="status-row"><span>来源</span><b>{{ agentStateFor('copilotCli').monitorThreadSource || "-" }}</b></div>
                      <div class="status-row"><span>状态文件</span><b>{{ agentStateFor('copilotCli').statePath || "-" }}</b></div>
                    </div>
                  </template>
                </template>
                <!-- Marvis -->
                <template v-else-if="agent.type === 'marvis'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    当前 Marvis 适配器不会列出会话，也不会创建或复用线程；它只负责打开目标 App 并把 prompt 放到剪贴板。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.marvisAppId" :items="agentScan.marvisAppIds" label="应用 ID" placeholder="Tencent.Marvis" hint="留空使用默认 Tencent.Marvis" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.marvisAppIds.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">可先打开 Marvis 确认桌面端可用；真正消息会在路由触发时复制为 prompt。</span>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        prepend-icon="mdi-open-in-app"
                        :loading="openingMarvis"
                        :disabled="openingMarvis"
                        @click="openMarvis"
                      >
                        打开 Marvis
                      </v-btn>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agentScan.loading" @click="runAgentScan">
                        重新扫描
                      </v-btn>
                    </div>
                  </div>
                  <v-alert
                    v-if="marvisOpenResult"
                    :type="marvisOpenResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ marvisOpenResult.message }}
                  </v-alert>
                </template>
                <template v-else-if="agent.type === 'dsh'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过 DSH apiproxy 发现、创建、重命名、绑定和续投会话。实际消息由同一个 DSH session owner 执行；失败时不会改投 Codex。
                  </v-alert>
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    DSH 扫描会读取 <code>RabiRoute Agent</code> 的运行状态、版本、Manager 地址、通信约束和模型工具。显示“未就绪”时按上方诊断更新插件并重启 DSH。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.dshBaseUrl"
                      :items="agentScanFor('dsh')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="DSH API 基地址"
                      placeholder="http://127.0.0.1:3080"
                      hint="先填写 apiproxy 地址，再扫描项目和会话；默认 http://127.0.0.1:3080"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="按当前地址扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="configuredDshModelValue"
                      :items="dshModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主人格模型"
                      placeholder="provider/model"
                      hint="DSH 可用时读取模型目录；读取失败时可手动输入 provider/model。配置会在主人格下一次投递前应用到绑定会话。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectDshModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      v-model="gateway.dshReasoningEffort"
                      :items="dshReasoningEffortItems"
                      label="主人格推理强度"
                      hint="优先显示所选 DSH 模型支持的值；目录不可用时可以手动输入。留空则沿用模型或 DSH 当前默认值。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.dshCwd"
                      :items="agentProjectItems('dsh')"
                      label="工作目录"
                      placeholder="C:/Path/To/Project"
                      hint="用于同名会话消歧和新建；选择已有会话时自动采用会话目录"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('dsh').length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="gateway.dshSessionId || gateway.dshSessionName"
                      :items="dshSessionItems()"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="DSH 会话"
                      placeholder="选择已有会话，或输入新会话名"
                      hint="选择后保存完整 ID、名称和工作目录；输入新名称会清空旧 ID，保存时查找或只创建一次"
                      persistent-hint
                      @update:model-value="selectDshSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="dshSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-btn
                      v-if="agentScanFor('dsh')?.sessionPage?.hasMore"
                      size="small"
                      variant="text"
                      prepend-icon="mdi-chevron-down"
                      :loading="dshScanLoading"
                      @click="loadMoreDshSessions"
                    >
                      加载更多 DSH 会话
                    </v-btn>
                  </div>
                  <div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('dsh')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('dsh')"
                    >
                      定位会话
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-account-sync-outline"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="initializeManagedAgentSession('dsh')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 DSH 会话；未绑定时可初始化会话。</span>
                  </div>
                  <v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert>
                  <v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert>
                  <div class="mt-2">
                    <div class="status-row">
                      <span>会话发现</span>
                      <b :class="dshSessionItems().length ? 'text-success' : 'text-warning'">{{ dshSessionItems().length ? `可选 ${dshSessionItems().length} 个` : '未读取到会话' }}</b>
                    </div>
                    <div class="status-row">
                      <span>项目发现</span>
                      <b :class="agentProjectItems('dsh').length ? 'text-success' : 'text-warning'">{{ agentProjectItems('dsh').length ? `可选 ${agentProjectItems('dsh').length} 个` : '未读取到项目目录' }}</b>
                    </div>
                    <div class="status-row">
                      <span>投递协议</span>
                      <b>session.prompt · mode=queue</b>
                    </div>
                  </div>
                </template>
                <template v-else-if="agent.type === 'astrbot'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    AstrBot 必须绑定 ChatUI 项目和会话；消息只通过 /api/chat/send 投递。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot ChatUI 地址；消息只通过 /api/chat/send 投递"
                      persistent-hint
                      @update:model-value="touch"
                    >
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.astrbotUsername"
                      label="AstrBot 用户名"
                      placeholder="留空使用环境变量 ASTRBOT_USERNAME"
                      hint="不填则默认沿用适配器默认用户名"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-text-field
                      v-model="gateway.astrbotPassword"
                      type="password"
                      label="AstrBot 密码"
                      placeholder="留空则使用环境变量 ASTRBOT_PASSWORD"
                      hint="仅写入本地 route 配置；也可用私有环境变量提供"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-select
                      v-model="gateway.astrbotProjectId"
                      :items="astrbotProjectItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 项目"
                      placeholder="可选：先选项目再筛选会话"
                      hint="来自 AstrBot ChatUI 项目列表；没有项目也可以直接选会话"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotProject"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                    <v-select
                      v-model="gateway.astrbotSessionId"
                      :items="astrbotSessionItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 会话"
                      placeholder="选择一个 ChatUI 会话"
                      hint="选择后消息通过 /api/chat/send 投递；未选择时不可用"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                  </div>
                  <div class="mt-2">
                    <div
                      v-for="endpoint in agentScanFor('astrbot')?.endpoints ?? []"
                      :key="endpoint.url"
                      class="status-row"
                    >
                      <span>{{ endpoint.label }}</span>
                      <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                    </div>
                    <div class="status-row">
                      <span>鉴权</span>
                      <b :class="agentScanFor('astrbot')?.auth?.loggedIn ? 'text-success' : 'text-warning'">
                        {{ agentScanFor('astrbot')?.auth?.message || "-" }}
                      </b>
                    </div>
                    <div class="status-row">
                      <span>ChatUI 会话</span>
                      <b :class="astrbotSessionItems().length ? 'text-success' : 'text-warning'">
                        {{ astrbotSessionItems().length ? `可选 ${astrbotSessionItems().length} 个` : "未读取到会话" }}
                      </b>
                    </div>
                    <div
                      v-for="plugin in agentScanFor('astrbot')?.plugins ?? []"
                      :key="plugin.id"
                      class="status-row"
                    >
                      <span>{{ plugin.name }}</span>
                      <b :class="plugin.installed ? 'text-success' : 'text-warning'">{{ plugin.installed ? "已安装" : "未安装" }}</b>
                    </div>
                  </div>
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">用当前填写的地址、用户名和密码请求 AstrBot 登录接口。</span>
                    </div>
                    <v-btn
                      size="small"
                      variant="tonal"
                      color="secondary"
                      prepend-icon="mdi-login-variant"
                      :loading="testingAstrbotLogin"
                      :disabled="testingAstrbotLogin"
                      @click="testAstrbotLogin"
                    >
                      验证登录
                    </v-btn>
                  </div>
                  <v-alert
                    v-if="astrbotLoginResult"
                    :type="astrbotLoginResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ astrbotLoginResult.message }}
                  </v-alert>
                </template>
                  <div v-if="primaryAgentType === agent.type && supportsManagedTaskFeature(agent.type, 'memoryConsolidationAgent')" class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">独立记忆整理 Agent</div>
                        <div class="section-note">开启后，记忆沉淀请求交给独立的 {{ managedAgentLabel(agent.type) }} 会话，不占用主人格当前上下文。</div>
                      </div>
                      <v-switch
                        color="primary"
                        density="compact"
                        hide-details
                        inset
                        :model-value="gateway.codexMemoryConsolidationAgentEnabled === true"
                        @update:model-value="value => { gateway.codexMemoryConsolidationAgentEnabled = value === true; touch(); }"
                      />
                    </div>
                    <v-alert v-if="gateway.codexMemoryConsolidationAgentEnabled" type="info" variant="tonal" density="compact" class="mt-2 mb-2">
                      触发沉淀时会创建或复用“{{ codexMemoryConsolidationAgentTitle(managedAgentSessionContext(agent.type)?.sessionName || fallbackCodexThreadName()) }}”。请求不会再投给主人格；目标 Agent 端不可用或会话投递失败时，本轮会明确失败，不会切换到备用处理端。
                    </v-alert>
                    <v-alert v-else type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                      关闭时，记忆沉淀请求仍由当前主人格处理。
                    </v-alert>
                    <div v-if="gateway.codexMemoryConsolidationAgentEnabled" class="catalog-param-grid mt-2">
                      <v-text-field
                        v-if="agent.type === 'codex'"
                        :model-value="gateway.codexMemoryConsolidationAgentModel || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL"
                        label="记忆整理模型"
                        hint="默认使用 GPT-5.6 Terra；只影响独立记忆整理 Agent 的新轮次。"
                        persistent-hint
                        @update:model-value="value => { gateway.codexMemoryConsolidationAgentModel = String(value || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL); touch(); }"
                      />
                    </div>
                  </div>
                  <div v-if="primaryAgentType === agent.type && supportsManagedTaskFeature(agent.type, 'planAssistantSessions')" class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">计划协助会话</div>
                        <div class="section-note">持久秘书任务负责计划推进和结果汇总；全部秘书统一使用 Manager 配置的模型，并且不会随临时子 Agent 结束而失去 owner。</div>
                      </div>
                      <v-switch
                        color="primary"
                        density="compact"
                        hide-details
                        inset
                        :model-value="gateway.codexPlanAssistantEnabled === true"
                        @update:model-value="value => { gateway.codexPlanAssistantEnabled = value === true; touch(); }"
                      />
                    </div>
                    <v-alert v-if="gateway.codexPlanAssistantEnabled" :type="agent.type === 'dsh' ? 'success' : 'warning'" variant="tonal" density="compact" class="mt-2 mb-2">
                      <template v-if="agent.type === 'dsh'">
                        当前本机已读回 6 个 DSH 计划协助会话，并验证同一秘书会话复用、计划绑定迁移和正式回复来源；发布包与全新环境回归待完成。
                      </template>
                      <template v-else>
                        实验能力：代码和契约测试已覆盖精确 ID、命名与复用；仍需在真实 {{ managedAgentLabel(agent.type) }} 中确认多会话可见、同 ID 续投和工具 owner。
                      </template>
                    </v-alert>
                    <v-alert v-else type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                      关闭后不再把计划交给秘书处理；已经绑定的秘书任务会保留，重新开启后继续复用。
                    </v-alert>
                    <div v-if="gateway.codexPlanAssistantEnabled" class="catalog-param-grid mt-2">
                      <v-text-field
                        v-if="agent.type === 'codex'"
                        :model-value="gateway.codexPlanAssistantModel || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL"
                        label="计划秘书模型"
                        hint="Manager 统一应用到当前 Route 的全部计划秘书；默认使用 GPT-5.6 Terra。"
                        persistent-hint
                        @update:model-value="value => { gateway.codexPlanAssistantModel = String(value || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL); touch(); }"
                      />
                      <v-text-field
                        v-model.number="codexPlanAssistants.count"
                        type="number"
                        :min="1"
                        :max="8"
                        :step="1"
                        label="协助会话数量"
                        hint="1 个时命名为“主会话名 协助处理计划”；多个时依次命名为“…计划1、…计划2”"
                        persistent-hint
                      />
                      <div class="d-flex align-center ga-2 flex-wrap">
                        <v-btn
                          color="secondary"
                          variant="tonal"
                          prepend-icon="mdi-account-multiple-plus-outline"
                          :loading="codexPlanAssistants.loading"
                          :disabled="codexPlanAssistants.loading"
                          @click="initializePlanAssistants"
                        >
                          创建 / 同步协助会话
                        </v-btn>
                      </div>
                    </div>
                    <div v-if="gateway.codexPlanAssistantEnabled && gateway.codexPlanAssistantSessions?.length" class="d-flex ga-2 flex-wrap mt-2">
                      <v-chip
                        v-for="session in gateway.codexPlanAssistantSessions"
                        :key="session.threadId"
                        size="small"
                        variant="tonal"
                        color="secondary"
                        data-no-i18n
                      >
                        {{ session.threadName }}
                      </v-chip>
                    </div>
                    <v-alert v-if="codexPlanAssistants.error" type="error" variant="tonal" density="compact" class="mt-2 mb-0">
                      {{ codexPlanAssistants.error }}
                    </v-alert>
                    <v-alert v-else-if="codexPlanAssistants.message" type="success" variant="tonal" density="compact" class="mt-2 mb-0">
                      {{ codexPlanAssistants.message }}
                    </v-alert>
                  </div>
                  <div v-if="primaryAgentType === agent.type && supportsManagedTaskFeature(agent.type, 'hooks')" class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">Hook 管理</div>
                        <div class="section-note">关闭开关只让 Manager 忽略对应 Hook；目标 Agent 端的插件注册保持不变。</div>
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
                        <div class="section-note">默认关闭。开启后只有当前绑定的 {{ managedAgentLabel(agent.type) }} 主人格会话可发送；计划 Agent、计划秘书和消息处理 Agent 会被拒绝。</div>
                      </div>
                    </div>
                  </div>
              </div>
            </v-expand-transition>
          </div>

          <div v-if="visibleAgentItems.length === 0" class="empty-state compact-empty">
            <div>
              <strong>尚未添加任何 Agent 端</strong>
              <span>点击下方按钮添加。</span>
            </div>
          </div>
        </div>

        <div class="adapter-add-row">
          <v-menu v-model="addAgentMenu" location="bottom start">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                prepend-icon="mdi-plus"
                variant="tonal"
                size="small"
                :disabled="availableAgentsToAdd.length === 0"
              >
                添加 Agent
              </v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="agent in availableAgentsToAdd"
                :key="agent.type"
                :title="agent.title"
                @click="addAgent(agent.type)"
              />
            </v-list>
          </v-menu>
        </div>
      </v-card>
    </template>

    <v-dialog v-model="channelCheckDialogOpen" max-width="1180" scrollable>
      <v-card class="app-card channel-check-dialog">
        <v-card-title class="d-flex align-center ga-3">
          <v-icon color="secondary">mdi-connection</v-icon>
          <div>
            <div>通道检查</div>
            <div class="section-note">检查当前 Route 从消息端经过 Manager 到 Agent 端的完整链路。</div>
          </div>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" title="关闭" @click="channelCheckDialogOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            状态检查不会修改配置或触发登录。点击 Agent 节点的“投递测试”会发送一条带测试编号的真实消息，用于确认对应 Agent 是否收到。
          </v-alert>

          <div class="d-flex align-center ga-2 flex-wrap mb-4">
            <v-chip :color="channelCheckOverallColor()" variant="tonal">{{ channelCheckOverallLabel() }}</v-chip>
            <span v-if="messageAdapterScan.checkedAt" class="section-note">
              用时 {{ messageAdapterScan.durationMs }} ms
            </span>
          </div>

          <v-progress-linear v-if="messageAdapterScan.loading || agentScan.loading" indeterminate color="secondary" class="mb-4" />
          <v-alert v-if="messageAdapterScan.error" type="error" variant="tonal" density="compact" class="mb-4">
            {{ messageAdapterScan.error }}
          </v-alert>

          <div class="channel-topology" aria-label="消息端到 Agent 端的通道拓扑">
            <section class="channel-topology-column channel-topology-messages">
              <div class="channel-topology-heading">
                <v-icon size="18">mdi-message-processing-outline</v-icon>
                <span>消息端</span>
                <small>消息进入</small>
              </div>
              <button
                v-for="item in channelCheckItems"
                :key="item.type"
                type="button"
                class="channel-topology-node channel-topology-message-node"
                :data-tone="gateway && isAdapterDisabled(gateway, item.type) ? 'secondary' : scanConnectionColor(messageScanFor(item.type))"
                @click="openChannelCheckDetails(item.type)"
              >
                <v-icon class="channel-topology-node-icon">{{ item.icon }}</v-icon>
                <span class="channel-topology-node-main">
                  <strong>{{ item.title }}</strong>
                  <small>{{ channelCheckDetail(messageScanFor(item.type)) }}</small>
                </span>
                <span class="channel-topology-node-status">
                  <v-chip size="x-small" :color="gateway && !isAdapterDisabled(gateway, item.type) ? 'success' : 'secondary'" variant="tonal">
                    {{ gateway && !isAdapterDisabled(gateway, item.type) ? "已启用" : "已停用" }}
                  </v-chip>
                  <v-chip size="x-small" :color="scanConnectionColor(messageScanFor(item.type))" variant="tonal">
                    {{ scanConnectionLabel(messageScanFor(item.type)) }}
                  </v-chip>
                </span>
                <span class="channel-topology-node-action">查看配置</span>
              </button>
              <div v-if="channelCheckItems.length === 0" class="channel-topology-empty">
                <strong>尚未添加消息端</strong>
                <span>先在消息配置页添加一个消息端。</span>
              </div>
            </section>

            <div class="channel-topology-bridge" aria-hidden="true" />

            <section class="channel-topology-manager">
              <div class="channel-topology-heading channel-topology-heading-center">
                <v-icon size="18">mdi-routes</v-icon>
                <span>分诊与路由</span>
              </div>
              <div class="channel-topology-node channel-topology-manager-node" :data-tone="channelManagerConnectionColor()">
                <v-icon class="channel-topology-manager-icon">mdi-router-network</v-icon>
                <strong>Rabi Manager</strong>
                <v-chip size="small" :color="channelManagerConnectionColor()" variant="tonal">
                  {{ channelManagerConnectionLabel() }}
                </v-chip>
                <small>{{ channelManagerDetail() }}</small>
              </div>
            </section>

            <div class="channel-topology-bridge" aria-hidden="true" />

            <section class="channel-topology-column channel-topology-agents">
              <div class="channel-topology-heading">
                <v-icon size="18">mdi-robot-outline</v-icon>
                <span>Agent 端</span>
                <small>处理与回复</small>
              </div>
              <div
                v-for="agent in channelCheckAgentItems"
                :key="agent.type"
                class="channel-topology-node channel-topology-agent-node"
                :data-tone="channelAgentConnectionColor(agent.type)"
              >
                <v-icon class="channel-topology-node-icon">{{ agent.icon }}</v-icon>
                <span class="channel-topology-node-main">
                  <strong>{{ agent.title }}</strong>
                  <small>{{ channelAgentDetail(agent.type) }}</small>
                </span>
                <span class="channel-topology-node-status">
                  <v-chip v-if="agent.primary" size="x-small" color="primary" variant="tonal">主控</v-chip>
                  <v-chip v-else size="x-small" color="secondary" variant="tonal">备用</v-chip>
                  <v-chip size="x-small" :color="channelAgentConnectionColor(agent.type)" variant="tonal">
                    {{ channelAgentConnectionLabel(agent.type) }}
                  </v-chip>
                </span>
                <span class="channel-topology-node-actions">
                  <v-btn
                    size="x-small"
                    color="secondary"
                    variant="tonal"
                    prepend-icon="mdi-send-check-outline"
                    :loading="agentDeliveryTest.loading === agent.type"
                    :disabled="Boolean(agentDeliveryTest.loading) || store.dirty || agent.type === 'marvis'"
                    @click="runAgentDeliveryTest(agent.type)"
                  >
                    {{ agent.type === "marvis" ? "仅人工接力" : "投递测试" }}
                  </v-btn>
                  <button type="button" class="channel-topology-config-action" @click="openChannelCheckAgentDetails(agent.type)">
                    查看配置
                  </button>
                </span>
              </div>
              <div v-if="channelCheckAgentItems.length === 0" class="channel-topology-empty">
                <strong>尚未添加 Agent 端</strong>
                <span>先在消息配置页添加处理端。</span>
              </div>
            </section>
          </div>

          <v-alert
            v-if="agentDeliveryTest.loading"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
          >
            正在向 {{ channelCheckAgentItems.find(item => item.type === agentDeliveryTest.loading)?.title || agentDeliveryTest.loading }} 投递真实测试消息…
          </v-alert>
          <v-alert
            v-else-if="agentDeliveryTest.result"
            type="success"
            variant="tonal"
            density="compact"
            class="mt-4"
            title="目标 Agent 已收到测试消息"
          >
            <div class="channel-delivery-test-details">
              <span>目标：{{ channelCheckAgentItems.find(item => item.type === agentDeliveryTest.result?.agentAdapterType)?.title || agentDeliveryTest.result.agentAdapterType }}</span>
              <span>测试编号：<code>{{ agentDeliveryTest.result.deliveryId }}</code></span>
              <span>完成时间：{{ agentDeliveryTestCompletedAt(agentDeliveryTest.result.completedAt) }}</span>
            </div>
          </v-alert>
          <v-alert
            v-else-if="agentDeliveryTest.error"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-4"
            title="投递测试失败"
          >
            {{ agentDeliveryTest.error }}
          </v-alert>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="channelCheckDialogOpen = false">关闭</v-btn>
          <v-btn color="secondary" variant="tonal" prepend-icon="mdi-refresh" :loading="messageAdapterScan.loading || agentScan.loading" @click="runChannelCheck">
            重新检查
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
