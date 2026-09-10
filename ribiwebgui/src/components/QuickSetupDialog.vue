<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { AgentAdapterType, AgentMaturity, AgentScanResult, AgentScanSession, MessageAdapterType } from "../types";
import { adapterDefaultWebhookPath, adapterLabel, adapterSourceAliases, defaultHeartbeatMessage, gatewayAdapterTypes, isWebhookLikeAdapter } from "../utils/gatewayHelpers";
import { bindAgentSessionsForSave } from "@shared/codexSessionBinding";
import { agentAdapterValues } from "@shared/gatewayConfigModel";
import PersonaAvatar from "./PersonaAvatar.vue";
import { codexThreadItems, selectCodexThread, type CodexThreadSummary } from "@shared/codexThreadSelection";
import { copyTextToClipboard } from "../clipboard";
import { routeScopedRuntimePath } from "../routeScopedNavigation";
import { personaOptionDisplayName } from "../personaPresentation";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const store = useGatewayStore();
const router = useRouter();
const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const activeStep = ref(1);
const form = reactive({
  adapters: ["napcat"] as MessageAdapterType[],
  agentAdapters: ["codex"] as AgentAdapterType[],
  agentRoleId: "",
  agentModel: "",
  codexThreadId: "",
  codexThreadName: "",
  copilotThreadName: "",
  codexCwd: "",
  copilotCliBin: "",
  copilotCwd: "",
  marvisAppId: "",
  astrbotUrl: "http://127.0.0.1:6185",
  astrbotUsername: "",
  astrbotPassword: "",
  astrbotProjectId: "",
  astrbotSessionId: "",
  dshSessionId: "",
  dshSessionName: "",
  dshCwd: "",
  dshBaseUrl: "http://127.0.0.1:3080",
  gatewayPort: 8790,
  napcatHttpUrl: "http://127.0.0.1:3000",
  napcatWebuiUrl: "http://127.0.0.1:6099/webui",
  heartbeatIntervalSeconds: 900,
  heartbeatMessage: defaultHeartbeatMessage(),
  heartbeatSkipWhenAgentBusy: false,
  webhookPort: 8790,
  webhookPath: "/webhook",
  fenneNoteWebhookPort: 8790,
  fenneNoteWebhookPath: "/fennenote",
  xiaoaiWebhookPort: 8790,
  xiaoaiWebhookPath: "/xiaoai",
  rabiLinkWebhookPort: 8790,
  rabiLinkWebhookPath: "/rabilink",
  rabiLinkWebhookHost: "0.0.0.0",
  wecomBotId: "",
  wecomBotSecret: "",
  wecomWsUrl: ""
});

const quickMessageAgentModeEnabled = computed(() => (
  form.agentAdapters.includes("codex")
  && store.selectedGateway?.messageProcessingAgents?.codex?.enabled === true
));

const adapterChoices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> = [
  { type: "napcat", title: "NapCat / OneBot", note: "QQ 群聊、私聊实时入口", icon: "mdi-message-badge-outline" },
  { type: "wecom", title: "企业微信 / WeCom", note: "企业微信群聊双向入口", icon: "mdi-domain" },
  { type: "remoteAgent", title: "远端 Agent", note: "下游 Agent 设备入口，支持局域网发现和任务投递", icon: "mdi-lan-connect" },
  { type: "heartbeat", title: "定时触发", note: "按固定间隔投递内部提醒", icon: "mdi-timer-outline" },
  { type: "fennenote", title: "FenneNote / 芬妮笔记", note: "桌面语音笔记转写入口", icon: "mdi-note-edit-outline" },
  { type: "rabilink", title: "眼镜端（经 RabiLink）", note: "眼镜是消息来源；系统内置 RabiLink 负责转接", icon: "mdi-glasses" },
  { type: "webhook", title: "通用 Webhook", note: "没有专用消息端时的通用 POST 兜底入口", icon: "mdi-webhook" }
];

const quickAgentChoices: Array<{ type: AgentAdapterType; title: string; note: string; icon: string }> = [
  { type: "codex", title: "Codex Agent", note: "真实消息由 Codex/ChatGPT Desktop 当前任务执行", icon: "mdi-monitor-dashboard" },
  { type: "copilotCli", title: "Copilot CLI", note: "实验支持，需要本机登录状态", icon: "mdi-robot-outline" },
  { type: "marvis", title: "Marvis", note: "占位支持，人工接力模式", icon: "mdi-message-processing-outline" },
  { type: "astrbot", title: "AstrBot", note: "实验支持，可绑定 ChatUI 会话", icon: "mdi-robot-happy-outline" },
  { type: "dsh", title: "DSH（DeepSeek Harness）", note: "实验支持，通过 session.prompt API 投递消息", icon: "mdi-brain" }
];

const agentModelChoices: string[] = [
  "gpt-5.3",
  "gpt-5.6"
];

const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  agents: {} as Partial<Record<AgentAdapterType, AgentScanResult>>,
  loading: false
});
const testingAstrbotLogin = ref(false);
const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);
const testingNapcatHealth = ref(false);
const napcatHealthResult = ref<{
  ok?: boolean;
  http?: { ok?: boolean; message?: string; userId?: string | number; nickname?: string };
  webui?: {
    url?: string;
    reachable?: boolean;
    found?: boolean;
    tokenFound?: boolean;
    tokenLength?: number;
    configPath?: string;
    source?: "provided" | "config";
    message?: string;
  };
  process?: { found?: boolean; candidates?: Array<{ name: string; pid: string }> };
  wsUrl?: string;
  message?: string;
} | null>(null);
const copyResult = ref("");
const openingMarvis = ref(false);
const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);
const applySaving = ref(false);
const applyError = ref("");

async function runAgentScan(): Promise<void> {
  if (agentScan.value.loading) return;
  agentScan.value.loading = true;
  try {
    const res = await fetch("/api/scan/agents");
    const data = await res.json();
    agentScan.value.threadNames = data.threadNames ?? [];
    agentScan.value.cwdOptions = data.cwdOptions ?? [];
    agentScan.value.copilotSessions = data.copilotSessions ?? [];
    agentScan.value.copilotBins = data.copilotBins ?? [];
    agentScan.value.marvisAppIds = data.marvisAppIds ?? [];
    agentScan.value.agents = data.agents ?? {};
  } catch {
    // Quick setup remains usable with manual values.
  } finally {
    agentScan.value.loading = false;
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

const runtime = computed(() => store.selectedRuntime);
const selectedAgent = computed<AgentAdapterType>(() => form.agentAdapters[0] ?? "codex");
const selectedSessionName = computed(() => {
  if (selectedAgent.value === "codex") return form.codexThreadId || form.codexThreadName;
  if (selectedAgent.value === "copilotCli") return form.copilotThreadName;
  if (selectedAgent.value === "dsh") return form.dshSessionId || form.dshSessionName;
  return "";
});
const roleOptions = computed(() => [
  { title: "不配置人格", subtitle: "", value: "", avatarUrl: "" },
  ...((runtime.value.roleInfo?.options || []).map(role => ({
    title: personaOptionDisplayName(role),
    subtitle: personaOptionDisplayName(role) !== role.value ? `人格 ID · ${role.value}` : "",
    value: role.value,
    avatarUrl: role.avatarUrl || ""
  })))
]);
const agentNeedsCodexProject = computed(() => selectedAgent.value === "codex");
const agentNeedsCopilotProject = computed(() => selectedAgent.value === "copilotCli");
const agentNeedsAstrbotEndpoint = computed(() => selectedAgent.value === "astrbot");
const agentNeedsMarvisApp = computed(() => selectedAgent.value === "marvis");
const agentNeedsDshSession = computed(() => selectedAgent.value === "dsh");

function selectAgent(type: AgentAdapterType): void {
  form.agentAdapters = [type];
  if (type === "copilotCli" && !form.copilotCwd && form.codexCwd) {
    form.copilotCwd = form.codexCwd;
  }
  if (type === "dsh" && !form.dshCwd && form.codexCwd) {
    form.dshCwd = form.codexCwd;
  }
}

function normalizeAgentAdapterValue(value: unknown): AgentAdapterType | null {
  const text = String(value || "") as AgentAdapterType;
  return agentAdapterValues.has(text) ? text : null;
}

function selectAgentValue(value: unknown): void {
  const normalized = normalizeAgentAdapterValue(value);
  if (normalized) selectAgent(normalized);
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
  if (type !== "astrbot") return scan;

  const localUrl = form.astrbotUrl?.trim();
  const localPassword = form.astrbotPassword?.trim();
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
  if (!value) return agentScan.value.loading ? "扫描中" : "未扫描";
  if (value === "verified") return "已验证";
  if (value === "stub") return "占位";
  return "实验";
}

function maturityColor(value?: AgentMaturity): string {
  if (!value) return "secondary";
  if (value === "verified") return "success";
  if (value === "stub") return "grey";
  return "warning";
}

function currentProject(): string {
  if (agentNeedsAstrbotEndpoint.value) return astrbotProjectItems().find(project => project.value === form.astrbotProjectId)?.title || form.astrbotUrl;
  if (agentNeedsMarvisApp.value) return form.marvisAppId || "Tencent.Marvis";
  if (agentNeedsDshSession.value) return form.dshCwd || form.codexCwd;
  return agentNeedsCopilotProject.value ? form.copilotCwd : form.codexCwd;
}

function fallbackCodexThreadName(): string {
  const gateway = store.selectedGateway;
  if (!gateway) return "RabiRoute";
  return gateway.routeName || gateway.name || store.configNameFor(gateway) || gateway.id || "RabiRoute";
}

function codexBindingSummary(): string {
  const project = form.codexCwd || "RabiRoute 根目录";
  const thread = form.codexThreadName || `自动：${fallbackCodexThreadName()}`;
  return `${project} / ${thread}`;
}

function agentPrimaryLabel(): string {
  if (agentNeedsAstrbotEndpoint.value) return "AstrBot 地址/项目";
  if (agentNeedsMarvisApp.value) return "应用 ID";
  if (agentNeedsDshSession.value) return "DSH 会话 ID";
  return agentNeedsCopilotProject.value ? "项目目录 (-C)" : "项目目录";
}

function agentSessionLabel(): string {
  if (agentNeedsAstrbotEndpoint.value) return "AstrBot 会话";
  if (agentNeedsMarvisApp.value) return "接力模式";
  if (agentNeedsDshSession.value) return "DSH 会话";
  return "线程";
}

function agentSessionSummary(): string {
  if (agentNeedsAstrbotEndpoint.value) {
    return astrbotSessionItems().find(session => session.value === form.astrbotSessionId)?.title || "未选择，使用插件默认管线";
  }
  if (agentNeedsMarvisApp.value) return "不绑定会话";
  if (agentNeedsDshSession.value) return form.dshSessionId || "未填写 DSH 会话 ID";
  if (selectedAgent.value === "codex") return form.codexThreadName || `自动：${fallbackCodexThreadName()}`;
  if (selectedAgent.value === "copilotCli") return form.copilotThreadName || "未填写";
  return "未填写";
}

function projectItems(): string[] {
  const projects = agentScanFor(selectedAgent.value)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(): AgentScanSession[] {
  const scanSessions = agentScanFor(selectedAgent.value)?.sessions;
  if (scanSessions) return scanSessions;
  if (selectedAgent.value === "copilotCli") {
    return agentScan.value.copilotSessions.map(session => ({
      name: session.name,
      projectPath: session.cwd,
      userNamed: session.userNamed
    }));
  }
  return agentScan.value.threadNames.map(name => ({ name }));
}

function astrbotProjectItems(): Array<{ title: string; value: string; path?: string }> {
  return (agentScanFor("astrbot")?.projects ?? []).map(project => ({
    title: project.label || project.path || project.id || "未命名项目",
    value: project.id || project.path,
    path: project.path
  }));
}

function astrbotSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return (agentScanFor("astrbot")?.sessions ?? [])
    .filter(session => !form.astrbotProjectId || session.projectId === form.astrbotProjectId)
    .map(session => ({
      title: session.name,
      value: session.id || session.name,
      subtitle: session.projectPath || session.updatedAt
    }));
}

function selectAstrbotProject(value: unknown): void {
  form.astrbotProjectId = String(value || "");
  const sessions = astrbotSessionItems();
  if (form.astrbotSessionId && !sessions.some(session => session.value === form.astrbotSessionId)) {
    form.astrbotSessionId = "";
  }
}

function selectAstrbotSession(value: unknown): void {
  form.astrbotSessionId = String(value || "");
  const selected = (agentScanFor("astrbot")?.sessions ?? []).find(session => (session.id || session.name) === form.astrbotSessionId);
  if (selected?.projectId && !form.astrbotProjectId) {
    form.astrbotProjectId = selected.projectId;
  }
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function defaultNapcatWebuiUrl(): string {
  return form.napcatWebuiUrl.trim() || "http://127.0.0.1:6099/webui";
}

function napcatWsUrl(): string {
  return `ws://127.0.0.1:${form.gatewayPort || 8790}`;
}

function selectedWebhookAdapter(): MessageAdapterType {
  return form.adapters.find(isWebhookLikeAdapter) ?? "webhook";
}

function selectedWebhookAdapters(): MessageAdapterType[] {
  return form.adapters.filter(isWebhookLikeAdapter);
}

function webhookPortFor(type: MessageAdapterType): number {
  if (type === "fennenote") return Number(form.fenneNoteWebhookPort || form.webhookPort || form.gatewayPort || 8790);
  if (type === "xiaoai") return Number(form.xiaoaiWebhookPort || form.webhookPort || form.gatewayPort || 8790);
  if (type === "rabilink") return Number(form.rabiLinkWebhookPort || form.webhookPort || form.gatewayPort || 8790);
  return Number(form.webhookPort || form.gatewayPort || 8790);
}

function webhookPathFor(type: MessageAdapterType): string {
  if (type === "fennenote") return form.fenneNoteWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "xiaoai") return form.xiaoaiWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "rabilink") return form.rabiLinkWebhookPath || adapterDefaultWebhookPath(type);
  return form.webhookPath || adapterDefaultWebhookPath(type);
}

function webhookHostFor(type: MessageAdapterType): string {
  if (type === "rabilink") return form.rabiLinkWebhookHost || "0.0.0.0";
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
  const port = Number(value || 0);
  if (type === "fennenote") form.fenneNoteWebhookPort = port;
  else if (type === "xiaoai") form.xiaoaiWebhookPort = port;
  else if (type === "rabilink") form.rabiLinkWebhookPort = port;
  else form.webhookPort = port;
}

function setWebhookPath(type: MessageAdapterType, value: unknown): void {
  const path = String(value || "");
  if (type === "fennenote") form.fenneNoteWebhookPath = path;
  else if (type === "xiaoai") form.xiaoaiWebhookPath = path;
  else if (type === "rabilink") form.rabiLinkWebhookPath = path;
  else form.webhookPath = path;
}

function setWebhookHost(type: MessageAdapterType, value: unknown): void {
  if (type !== "rabilink") return;
  form.rabiLinkWebhookHost = String(value || "").trim() || "0.0.0.0";
}

function webhookUrl(type: MessageAdapterType = selectedWebhookAdapter()): string {
  return `http://${webhookHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function callbackUrl(type: MessageAdapterType = selectedWebhookAdapter()): string {
  return `http://${callbackHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookTestEventType(type: MessageAdapterType): string {
  if (type === "fennenote") return "fennenote.transcript";
  if (type === "xiaoai") return "xiaoai.transcript";
  if (type === "rabilink") return "rabilink.message";
  return "webhook.text";
}

function webhookCurl(type: MessageAdapterType = selectedWebhookAdapter()): string {
  const source = adapterSourceAliases(type)[0] || type;
  const eventType = webhookTestEventType(type);
  return `curl -X POST "${callbackUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"${eventType}\",\"message\":\"hello from RabiRoute\"}"`;
}
function webhookSetupHint(type: MessageAdapterType): string {
  if (type === "fennenote") {
    return "需要先安装并运行 FenneNote/芬妮笔记，再把语音转写 webhook 指到这个地址；需要播报回复时再接 OumuQ/TTS worker。";
  }
  if (type === "xiaoai") {
    return "需要小爱桥接层：PC 侧 xiaoai-rabiroute 服务 + 音箱侧 open-xiaoai/xiaogpt/自定义桥，把语音文本转发到这个地址。";
  }
  if (type === "rabilink") {
    return "RabiLink 电脑端直连 Relay：在全局 RabiLink 配置里填写公网 Relay 地址和应用 token 后，可把 Rokid/灵珠文本转给所选 Agent，并把回复写回眼镜侧。";
  }
  return "通用 Webhook 只适合未命名外部系统；如果来源是具体工具，建议添加对应的专用消息端。";
}

function webhookSetupDocUrl(type: MessageAdapterType): string {
  if (type === "xiaoai") return "https://github.com/vb2250158/RabiRoute/blob/main/docs/xiaoai-integration/xiaoai-rabiroute-intercept-route.md";
  if (type === "rabilink") return "https://github.com/vb2250158/RabiRoute/blob/main/docs/rabilink-relay-server.md";
  if (type === "fennenote") return "https://github.com/vb2250158/RabiRoute/blob/main/docs/voice-interaction-workstation.md";
  return "https://github.com/vb2250158/RabiRoute/blob/main/docs/configuration.md";
}

function openExternalUrl(url: string | undefined): void {
  const target = url?.trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  let result = message;
  try {
    await copyTextToClipboard(text);
  } catch (error) {
    result = `复制失败：${userFacingError(error)}`;
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
  open.value = false;
  const name = store.selectedGateway ? store.configNameFor(store.selectedGateway) : "";
  void router.push(routeScopedRuntimePath(name));
}

async function testNapcatHealth(): Promise<void> {
  testingNapcatHealth.value = true;
  napcatHealthResult.value = null;
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: form.napcatHttpUrl,
        webuiUrl: defaultNapcatWebuiUrl(),
        gatewayPort: form.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
  } catch (e: unknown) {
    napcatHealthResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    testingNapcatHealth.value = false;
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
      body: JSON.stringify({ appId: form.marvisAppId })
    });
    const body = await resp.json().catch(() => ({}));
    marvisOpenResult.value = {
      ok: resp.ok && body.ok !== false,
      message: body.message || (resp.ok ? "已尝试打开 Marvis。" : "打开 Marvis 失败。")
    };
  } catch (e: unknown) {
    marvisOpenResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    openingMarvis.value = false;
  }
}

function sessionNames(): Array<string | { title: string; value: string }> {
  const project = currentProject();
  const sessions = selectedAgent.value === "codex"
    ? agentSessions()
    : agentSessions().filter(session => !project || !session.projectPath || samePath(session.projectPath, project));
  if (selectedAgent.value !== "codex") return [...new Set(sessions.map(session => session.name))];
  return codexThreadItems(codexThreadSummaries());
}

function codexThreadSummaries(): CodexThreadSummary[] {
  return agentSessions()
    .filter(session => session.id)
    .map(session => ({
      id: session.id!,
      title: session.name,
      updatedAt: session.updatedAt,
      cwd: session.projectPath
    }));
}

function selectSession(value: unknown): void {
  if (selectedAgent.value === "codex") {
    const selection = selectCodexThread(value, codexThreadSummaries());
    form.codexThreadId = selection.threadId;
    form.codexThreadName = selection.threadName;
    if (selection.selected?.cwd) form.codexCwd = selection.selected.cwd;
    return;
  }
  const selectedValue = String(value || "");
  const selectedById = agentSessions().find(session => session.id === selectedValue);
  const threadName = selectedById?.name || selectedValue;
  form.copilotThreadName = threadName;
  const selected = selectedById || agentSessions().find(session => session.name === threadName);
  if (selected?.projectPath) {
    if (selectedAgent.value === "copilotCli" && !form.copilotCwd) form.copilotCwd = selected.projectPath;
  }
}

async function testAstrbotLogin(): Promise<void> {
  testingAstrbotLogin.value = true;
  astrbotLoginResult.value = null;
  try {
    const resp = await fetch("/api/agent/astrbot-login-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: form.astrbotUrl,
        username: form.astrbotUsername,
        password: form.astrbotPassword
      })
    });
    const body = await resp.json().catch(() => ({}));
    astrbotLoginResult.value = {
      ok: Boolean(body.ok),
      message: body.message || (resp.ok ? "AstrBot 登录验证成功。" : "AstrBot 登录验证失败。")
    };
  } catch (e: unknown) {
    astrbotLoginResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    testingAstrbotLogin.value = false;
  }
}

const messageReady = computed(() => {
  if (form.adapters.includes("napcat") && (!form.gatewayPort || !form.napcatHttpUrl.trim())) return false;
  if (form.adapters.some(isWebhookLikeAdapter) && selectedWebhookAdapters().some(type => !webhookPortFor(type) || !webhookPathFor(type).trim())) return false;
  return form.adapters.length > 0;
});

const agentReady = computed(() => {
  if (!form.agentAdapters.length) return false;
  if (agentNeedsAstrbotEndpoint.value) return Boolean(form.astrbotUrl.trim());
  if (agentNeedsMarvisApp.value) return true;
  if (agentNeedsDshSession.value) return Boolean(form.dshSessionId.trim() && form.dshCwd.trim());
  if (agentNeedsCopilotProject.value) return Boolean(form.copilotThreadName.trim() && form.copilotCwd.trim());
  if (agentNeedsCodexProject.value) return true;
  return true;
});
const personaReady = computed(() => true);
const canSave = computed(() => messageReady.value && agentReady.value && personaReady.value);
const completedSteps = computed(() => [messageReady.value, agentReady.value, personaReady.value].filter(Boolean).length);
const saveBlockReason = computed(() => {
  if (!messageReady.value) return "消息入口还有必要字段没有填写，请回到第一步补全端口、地址或路径。";
  if (agentNeedsDshSession.value && (!form.dshSessionId.trim() || !form.dshCwd.trim())) {
    return "DSH 需要填写完整的 session-<uuid> 会话 ID 和工作目录；会话请先在 DSH WebGUI 中创建。";
  }
  if (!agentReady.value) return "Agent 绑定还有必要字段没有填写，请回到第二步补全项目目录、会话或服务地址。";
  return "";
});

const steps = computed(() => [
  {
    value: 1,
    title: "消息入口",
    note: form.adapters.map(adapterLabel).join(" + "),
    done: messageReady.value,
    icon: "mdi-numeric-1"
  },
  {
    value: 2,
    title: "Agent 绑定",
    note: selectedAgent.value === "codex"
      ? codexBindingSummary()
      : (currentProject() || form.copilotThreadName || "选择项目目录和会话线程"),
    done: agentReady.value,
    icon: "mdi-numeric-2"
  },
  {
    value: 3,
    title: "人格与保存",
    note: `${form.agentRoleId || "不配置人格"}${form.agentModel ? ` · ${form.agentModel}` : " · 默认模型"}`,
    done: personaReady.value,
    icon: "mdi-numeric-3"
  }
]);

function syncFromGateway() {
  const gateway = store.selectedGateway;
  form.adapters = gateway ? gatewayAdapterTypes(gateway) : ["napcat"];
  const rawAgentAdapters = Array.isArray(gateway?.agentAdapters) ? gateway.agentAdapters as unknown[] : [];
  const normalizedAgentAdapters = rawAgentAdapters
    .map(normalizeAgentAdapterValue)
    .filter((adapter): adapter is AgentAdapterType => Boolean(adapter));
  form.agentAdapters = normalizedAgentAdapters.length
    ? [...new Set(normalizedAgentAdapters)]
    : ["codex"];
  form.agentRoleId = gateway?.agentRoleId || "";
  form.agentModel = gateway?.agentModel || "";
  form.codexThreadId = gateway?.codexThreadId || "";
  form.codexThreadName = gateway?.codexThreadName || "";
  form.copilotThreadName = gateway?.copilotThreadName || "";
  form.codexCwd = gateway?.codexCwd || "";
  form.copilotCliBin = gateway?.copilotCliBin || "";
  form.copilotCwd = gateway?.copilotCwd || gateway?.codexCwd || "";
  form.marvisAppId = gateway?.marvisAppId || "";
  form.astrbotUrl = gateway?.astrbotUrl || "http://127.0.0.1:6185";
  form.astrbotUsername = gateway?.astrbotUsername || "";
  form.astrbotPassword = gateway?.astrbotPassword || "";
  form.astrbotProjectId = gateway?.astrbotProjectId || "";
  form.astrbotSessionId = gateway?.astrbotSessionId || "";
  form.gatewayPort = Number(gateway?.gatewayPort || 8790);
  form.napcatHttpUrl = gateway?.napcatHttpUrl || "http://127.0.0.1:3000";
  form.napcatWebuiUrl = gateway?.napcatWebuiUrl || "http://127.0.0.1:6099/webui";
  form.heartbeatIntervalSeconds = Number(gateway?.heartbeatIntervalSeconds || 900);
  form.heartbeatMessage = gateway?.heartbeatMessage || defaultHeartbeatMessage();
  form.heartbeatSkipWhenAgentBusy = gateway?.heartbeatSkipWhenAgentBusy === true;
  form.webhookPort = Number(gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.webhookPath = gateway?.webhookPath || "/webhook";
  form.fenneNoteWebhookPort = Number(gateway?.fenneNoteWebhookPort || gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.fenneNoteWebhookPath = gateway?.fenneNoteWebhookPath || "/fennenote";
  form.xiaoaiWebhookPort = Number(gateway?.xiaoaiWebhookPort || gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.xiaoaiWebhookPath = gateway?.xiaoaiWebhookPath || "/xiaoai";
  form.rabiLinkWebhookPort = Number(gateway?.rabiLinkWebhookPort || gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.rabiLinkWebhookPath = gateway?.rabiLinkWebhookPath || "/rabilink";
  form.rabiLinkWebhookHost = gateway?.rabiLinkWebhookHost || "0.0.0.0";
  form.wecomBotId = gateway?.wecomBotId || "";
  form.wecomBotSecret = gateway?.wecomBotSecret || "";
  form.wecomWsUrl = gateway?.wecomWsUrl || "";
  form.dshSessionId = gateway?.dshSessionId || "";
  form.dshSessionName = gateway?.dshSessionName || "";
  form.dshCwd = gateway?.dshCwd || gateway?.codexCwd || "";
  form.dshBaseUrl = gateway?.dshBaseUrl || "http://127.0.0.1:3080";
  napcatHealthResult.value = null;
  astrbotLoginResult.value = null;
  marvisOpenResult.value = null;
  copyResult.value = "";
  applyError.value = "";
}

watch(
  () => [open.value, store.selectedGateway?.id] as const,
  ([visible]) => {
    if (visible) {
      syncFromGateway();
      void runAgentScan();
      activeStep.value = messageReady.value ? (agentReady.value ? 3 : 2) : 1;
    }
  },
  { immediate: true }
);

function toggleAdapter(type: MessageAdapterType) {
  const next = new Set<MessageAdapterType>(form.adapters.filter(adapter => adapter !== "disabled"));
  if (next.has(type)) next.delete(type);
  else next.add(type);
  form.adapters = next.size ? [...next] : ["napcat"];
}

function goNext() {
  if (activeStep.value < 3) activeStep.value += 1;
}

async function apply() {
  if (!canSave.value || applySaving.value) {
    applyError.value = saveBlockReason.value || "当前配置还不能保存。";
    return;
  }
  applySaving.value = true;
    applyError.value = "";
  try {
    if (selectedAgent.value === "codex" && !form.codexThreadName.trim()) {
      form.codexThreadName = fallbackCodexThreadName();
    }
    if (selectedAgent.value === "dsh" && !form.dshSessionName.trim()) {
      form.dshSessionName = fallbackCodexThreadName();
    }
    if (selectedAgent.value === "codex" || selectedAgent.value === "dsh") {
      await bindAgentSessionsForSave(form, async (request) => {
        const response = await fetch("/api/agent/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request)
        });
        return {
          statusCode: response.status,
          data: await response.json().catch(() => ({})) as Record<string, unknown>
        };
      });
    }
    store.applyQuickSetup({
      ...form,
      primaryAgentAdapter: selectedAgent.value,
      agentRoleId: String(form.agentRoleId || "")
    });
    await store.save();
    open.value = false;
  } catch (error: unknown) {
    applyError.value = userFacingError(error);
    activeStep.value = messageReady.value ? (agentReady.value ? 3 : 2) : 1;
  } finally {
    applySaving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="1040" persistent>
    <v-card class="app-card quick-setup-card">
      <v-card-title class="quick-setup-title">
        <v-avatar rounded="lg" size="44">
          <v-img src="/assets/rabiroute-icon.png" alt="RabiRoute" />
        </v-avatar>
        <div class="min-w-0">
          <div class="section-title">快速配置 RabiRoute</div>
          <div class="section-note">按消息入口、Agent 绑定、人格确认三步完成首次配置。</div>
        </div>
        <v-spacer />
        <v-chip color="secondary" variant="tonal" size="small">
          {{ completedSteps }}/3 已完成
        </v-chip>
      </v-card-title>

      <v-card-text>
        <div class="quick-setup-layout">
          <aside class="quick-setup-rail">
            <v-timeline align="start" side="end" density="compact" truncate-line="both" class="quick-setup-timeline">
              <v-timeline-item
                v-for="step in steps"
                :key="step.value"
                :dot-color="step.done ? 'success' : activeStep === step.value ? 'secondary' : 'grey-lighten-1'"
                :icon="step.done ? 'mdi-check' : step.icon"
                fill-dot
                size="small"
              >
                <button class="quick-step-button" :class="{ active: activeStep === step.value }" @click="activeStep = step.value">
                  <span>{{ step.title }}</span>
                  <small>{{ step.note }}</small>
                </button>
              </v-timeline-item>
            </v-timeline>

            <div class="quick-setup-summary">
              <div class="status-row"><span>当前路由</span><b>{{ store.selectedGateway ? store.configNameFor(store.selectedGateway) : "新建配置" }}</b></div>
              <div class="status-row"><span>版本</span><b>v{{ store.meta.version }}</b></div>
            </div>
          </aside>

          <section class="quick-setup-main">
            <v-window v-model="activeStep">
              <v-window-item :value="1">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">选择消息入口</div>
                    <div class="section-note">可以组合多个入口；单个入口可在消息适配器页继续停用或调整权限。</div>
                  </div>
                </div>

                <div class="catalog-param-panel quick-agent-panel">
                  <div class="catalog-param-grid">
                    <v-select
                      v-model="form.adapters"
                      :items="adapterChoices"
                      item-title="title"
                      item-value="type"
                      label="消息入口"
                      hint="可多选；下面只显示已选入口的参数"
                      persistent-hint
                      multiple
                      chips
                      closable-chips
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :prepend-icon="item.raw.icon" :subtitle="item.raw.note" />
                      </template>

                    </v-select>
                  </div>

                <div class="catalog-param-grid">
                  <template v-if="form.adapters.includes('napcat')">
                    <v-text-field v-model.number="form.gatewayPort" type="number" label="RabiRoute WS 端口" />
                    <v-text-field v-model="form.napcatHttpUrl" label="NapCat HTTP 地址" />
                    <v-text-field v-model="form.napcatWebuiUrl" class="full-span" label="NapCat 管理接口地址" />
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">先检查 HTTP、管理接口与本机进程；保存 Route 后，直接在 NapCat 卡片完成快速、密码或扫码登录。</span>
                        </div>
                        <div class="d-flex ga-2 flex-wrap">
                          <v-btn
                            size="small"
                            variant="tonal"
                            color="secondary"
                            prepend-icon="mdi-stethoscope"
                            :loading="testingNapcatHealth"
                            :disabled="testingNapcatHealth"
                            @click="testNapcatHealth"
                          >
                            检查并补齐
                          </v-btn>
                          <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyText(napcatWsUrl(), '已复制 NapCat WS 地址')">
                            复制 WS
                          </v-btn>
                        </div>
                      </div>
                      <v-alert v-if="napcatHealthResult" :type="napcatHealthResult.ok ? 'success' : 'error'" variant="tonal" density="compact" class="mt-2">
                        <div v-if="napcatHealthResult.message">{{ napcatHealthResult.message }}</div>
                        <div v-if="napcatHealthResult.http">
                          HTTP：{{ napcatHealthResult.http.ok ? `可用，${napcatHealthResult.http.nickname || napcatHealthResult.http.userId || '已登录'}` : (napcatHealthResult.http.message || '不可用') }}
                        </div>
                        <div v-if="napcatHealthResult.webui">
                          管理接口：{{ napcatHealthResult.webui.reachable ? "可访问" : "未响应" }} · {{ napcatHealthResult.webui.url }}
                        </div>
                        <div v-if="napcatHealthResult.webui?.found">
                          管理凭据：已从 NapCat webui.json 读取 {{ napcatHealthResult.webui.tokenLength || "-" }} 位；仅由 Rabi 后端代理使用。
                        </div>
                        <div v-else-if="napcatHealthResult.webui?.source === 'provided'">
                          管理凭据：使用当前 Route 保存的 {{ napcatHealthResult.webui.tokenLength || "-" }} 位凭据。
                        </div>
                        <div v-else-if="napcatHealthResult.webui?.message">
                          管理凭据：{{ napcatHealthResult.webui.message }}
                        </div>
                        <div>WS：请在 NapCat WebSocket Client 里连接 {{ napcatHealthResult.wsUrl || napcatWsUrl() }}</div>
                        <div v-if="napcatHealthResult.process">
                          进程：{{ napcatHealthResult.process.found ? napcatHealthResult.process.candidates?.map(item => `${item.name}(${item.pid})`).join(", ") : "未发现 NapCat/QQNT 相关进程" }}
                        </div>
                      </v-alert>
                    </div>
                  </template>
                  <template v-if="form.adapters.includes('wecom')">
                    <v-text-field
                      v-model="form.wecomBotId"
                      label="企业微信 Bot ID"
                      placeholder="可留空后改用 WECOM_BOT_ID"
                      hint="企业微信智能机器人 Bot ID；群聊消息会映射到 groupId。"
                      persistent-hint
                    />
                    <v-text-field
                      v-model="form.wecomBotSecret"
                      type="password"
                      label="企业微信 Bot Secret"
                      placeholder="可留空后改用 WECOM_BOT_SECRET"
                      hint="保存到本地 route 配置；公开示例不要写真实密钥。"
                      persistent-hint
                    />
                    <v-text-field
                      v-model="form.wecomWsUrl"
                      class="full-span"
                      label="企业微信 WebSocket 地址"
                      placeholder="留空使用 SDK 默认地址；私有部署或调试时填写"
                    />
                    <div class="quick-agent-status full-span">
                      <div class="status-row"><span>消息端</span><b>企业微信智能机器人 WebSocket</b></div>
                      <div class="status-row"><span>群聊变量</span><b>groupId / userId / sender / message / messageId</b></div>
                      <v-alert type="info" variant="tonal" density="compact" class="mt-2">
                        WeCom 会作为独立消息端启动，本地 gateway 主动连接企业微信；Agent 回发仍经过 RabiRoute outbox 和 messageAdapterPolicies.wecom。
                      </v-alert>
                    </div>
                  </template>
                  <template v-if="form.adapters.includes('heartbeat')">
                    <v-alert v-if="quickMessageAgentModeEnabled" type="success" variant="tonal" density="compact" class="full-span">
                      Codex 消息处理 Agent 模式已开启。heartbeat 会立即交给独立消息处理 Agent，不会因为主人格会话正在工作而跳过，也不进入聊天消息合并等待。
                    </v-alert>
                    <v-alert v-else type="info" variant="tonal" density="compact" class="full-span">
                      定时计划在“人格配置 / 消息模板规则”的 heartbeat 规则里维护。下面的忙时策略只影响 heartbeat，普通群聊、私聊和其他消息仍按正常路由直接投递。
                    </v-alert>
                    <v-switch
                      v-if="!quickMessageAgentModeEnabled"
                      v-model="form.heartbeatSkipWhenAgentBusy"
                      class="full-span"
                      color="primary"
                      label="会话工作中时跳过心跳"
                      hint="开启后，仅当 Agent 会话仍在工作时把本次 heartbeat 记为 skipped；普通消息不受影响。"
                      persistent-hint
                    />
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">保存后可在运行日志里手动触发一次，用来验证 Agent 端是否能收到心跳。</span>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                  </template>
                  <template v-if="form.adapters.includes('remoteAgent')">
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      远端 Agent 是下游 Agent 设备入口；远端设备只运行独立 bridge，无人值守等待 RabiGUI 扫描。保存后在“消息适配器”页扫描局域网，选择设备并输入密码连接。
                    </v-alert>
                  </template>
                  <template v-for="webhookAdapter in selectedWebhookAdapters()" :key="webhookAdapter">
                    <v-text-field v-if="webhookAdapter === 'rabilink'" :model-value="webhookHostFor(webhookAdapter)" :label="`${adapterLabel(webhookAdapter)} 监听地址`" placeholder="0.0.0.0" @update:model-value="value => setWebhookHost(webhookAdapter, value)" />
                    <v-text-field :model-value="webhookPortFor(webhookAdapter)" type="number" :label="`${adapterLabel(webhookAdapter)} 端口`" @update:model-value="value => setWebhookPort(webhookAdapter, value)" />
                    <v-text-field :model-value="webhookPathFor(webhookAdapter)" :label="`${adapterLabel(webhookAdapter)} 路径`" :placeholder="adapterDefaultWebhookPath(webhookAdapter)" @update:model-value="value => setWebhookPath(webhookAdapter, value)" />
                    <div class="quick-agent-status full-span">
                      <div class="status-row"><span>{{ adapterLabel(webhookAdapter) }} 监听</span><b>{{ webhookUrl(webhookAdapter) }}</b></div>
                      <div v-if="webhookAdapter === 'rabilink'" class="status-row"><span>{{ adapterLabel(webhookAdapter) }} 回调</span><b>{{ callbackUrl(webhookAdapter) }}</b></div>
                      <v-alert type="info" variant="tonal" density="compact" class="mt-2">
                        {{ webhookSetupHint(webhookAdapter) }}
                      </v-alert>
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">这里只复制 {{ adapterLabel(webhookAdapter) }} 测试入口，不会自动发送。</span>
                        </div>
                        <div class="d-flex ga-2 flex-wrap">
                          <v-btn size="small" variant="tonal" color="secondary" prepend-icon="mdi-book-open-variant" @click="openExternalUrl(webhookSetupDocUrl(webhookAdapter))">
                            配置说明
                          </v-btn>
                          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl(webhookAdapter), `已复制 ${adapterLabel(webhookAdapter)} 回调地址`)">
                            复制回调
                          </v-btn>
                          <v-btn v-if="webhookAdapter === 'rabilink'" size="small" variant="text" prepend-icon="mdi-access-point" @click="copyText(webhookUrl(webhookAdapter), '已复制监听地址')">
                            复制监听
                          </v-btn>
                          <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl(webhookAdapter), '已复制 curl 示例')">
                            复制 curl
                          </v-btn>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
                <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                  {{ copyResult }}
                </v-alert>
                </div>
              </v-window-item>

              <v-window-item :value="2">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">绑定 Agent 处理端</div>
                    <div class="section-note">快速配置只绑定一个 Agent；先确定处理端和项目目录，再选择会话。</div>
                  </div>
                </div>

                <div class="catalog-param-panel quick-agent-panel">
                  <div class="catalog-param-grid">
                    <v-select
                      :model-value="selectedAgent"
                      :items="quickAgentChoices"
                      item-title="title"
                      item-value="type"
                      label="Agent 处理端"
                      hint="所有已支持的 Agent 都在这里选择；高级字段会随处理端变化"
                      persistent-hint
                      @update:model-value="selectAgentValue"
                    >
                      <template #selection="{ item }">
                        <div class="quick-agent-select">
                          <v-icon size="18" color="secondary">{{ item.raw.icon }}</v-icon>
                          <span>{{ item.raw.title }}</span>
                          <v-chip size="x-small" :color="maturityColor(agentScanFor(item.raw.type)?.maturity)" variant="tonal">
                            {{ maturityLabel(agentScanFor(item.raw.type)?.maturity) }}
                          </v-chip>
                        </div>
                      </template>
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :prepend-icon="item.raw.icon" :subtitle="item.raw.note">
                          <template #append>
                            <v-chip size="x-small" :color="maturityColor(agentScanFor(item.raw.type)?.maturity)" variant="tonal">
                              {{ maturityLabel(agentScanFor(item.raw.type)?.maturity) }}
                            </v-chip>
                          </template>
                        </v-list-item>
                      </template>
                    </v-select>
                  </div>

                  <v-alert v-if="selectedAgent === 'codex'" type="info" variant="tonal" density="compact" class="mb-3">
                    Codex/ChatGPT Desktop 是真实消息的唯一 owner。RabiRoute 读取 Desktop 可见任务目录并通过 Desktop IPC 投递；Codex CLI 是独立 Runtime，不作为 Desktop 投递的备用路径。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'copilotCli'" type="warning" variant="tonal" density="compact" class="mb-3">
                    Copilot CLI 仍是实验适配；同一会话重复注入还需要单独烟测确认。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'astrbot'" type="info" variant="tonal" density="compact" class="mb-3">
                    AstrBot 必须绑定 ChatUI 项目和会话；消息只通过 /api/chat/send 投递。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'marvis'" type="info" variant="tonal" density="compact" class="mb-3">
                    Marvis 当前是人工接力模式：RabiRoute 会打开应用并复制 prompt，不会绑定会话线程。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'dsh'" type="info" variant="tonal" density="compact" class="mb-3">
                    DSH 会话是主人格投递目标：通过 DSH apiproxy <code>session.prompt</code>（mode=queue）注入消息。DSH 会话在 DeepSeek Harness Web GUI 中创建和管理；RabiRoute 不创建、不重命名、不归档 DSH 会话。仍为实验性：尚未自动执行真实消息注入烟测。
                  </v-alert>

                  <div class="catalog-param-grid">
                  <template v-if="selectedAgent === 'marvis'">
                    <v-combobox
                      v-model="form.marvisAppId"
                      :items="agentScan.marvisAppIds"
                      class="full-span"
                      label="Marvis 应用 ID"
                      placeholder="Tencent.Marvis"
                      hint="留空使用默认 Tencent.Marvis"
                      persistent-hint
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">先打开 Marvis 确认应用可用；路由触发时会把 prompt 放到剪贴板。</span>
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
                    </div>
                  </template>

                  <template v-if="selectedAgent === 'dsh'">
                    <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                      DSH 会话是主人格投递目标；通过 DSH apiproxy <code>session.prompt</code>（mode=queue）注入消息。
                      DSH 会话在 DeepSeek Harness Web GUI 中创建和管理；RabiRoute 不创建、不重命名、不归档 DSH 会话。
                      仍为实验性：尚未自动执行真实消息注入烟测。
                    </v-alert>
                    <div class="catalog-param-grid">
                      <v-text-field
                        v-model="form.dshSessionId"
                        label="DSH 会话 ID"
                        placeholder="session-<uuid>"
                        hint="在 DeepSeek Harness Web GUI 的会话页复制。格式固定：session-<uuid>"
                        persistent-hint
                        data-no-i18n
                      />
                      <v-text-field
                        v-model="form.dshSessionName"
                        label="DSH 会话名称"
                        placeholder="DSH Example Agent"
                        hint="可选标识，只用于显示，不改变 Harness 的会话名"
                        persistent-hint
                        data-no-i18n
                      />
                      <v-combobox
                        v-model="form.dshCwd"
                        :items="projectItems()"
                        label="工作目录"
                        placeholder="C:/Path/To/Project"
                        hint="DSH 绑定需要明确工作目录；应与 DSH 会话的 cwd 一致"
                        persistent-hint
                      >
                        <template #append-inner>
                          <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                          <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                        </template>
                      </v-combobox>
                      <v-text-field
                        v-model="form.dshBaseUrl"
                        label="DSH API 基地址"
                        placeholder="http://127.0.0.1:3080"
                        hint="本机 DeepSeek Harness 的 apiproxy 入口；默认 http://127.0.0.1:3080"
                        persistent-hint
                        data-no-i18n
                      />
                    </div>
                  </template>

                  <template v-if="selectedAgent === 'astrbot'">
                    <v-combobox
                      v-model="form.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      class="full-span"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot Dashboard / API 地址"
                      persistent-hint
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="form.astrbotUsername"
                      label="AstrBot 用户名"
                      placeholder="留空使用环境变量 ASTRBOT_USERNAME"
                    />
                    <v-text-field
                      v-model="form.astrbotPassword"
                      type="password"
                      label="AstrBot 密码"
                      placeholder="留空使用环境变量 ASTRBOT_PASSWORD"
                    />
                    <v-select
                      v-model="form.astrbotProjectId"
                      :items="astrbotProjectItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 项目"
                      placeholder="可选：先选项目再筛选会话"
                      clearable
                      @update:model-value="selectAstrbotProject"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                    <v-select
                      v-model="form.astrbotSessionId"
                      :items="astrbotSessionItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 会话"
                      placeholder="选择一个 ChatUI 会话"
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
                    <div class="quick-agent-status full-span">
                      <div
                        v-for="endpoint in agentScanFor('astrbot')?.endpoints ?? []"
                        :key="endpoint.url"
                        class="status-row"
                      >
                        <span>{{ endpoint.label }}</span>
                        <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                      </div>
                      <div
                        v-for="plugin in agentScanFor('astrbot')?.plugins ?? []"
                        :key="plugin.id"
                        class="status-row"
                      >
                        <span>{{ plugin.name }}</span>
                        <b :class="plugin.installed ? 'text-success' : 'text-warning'">{{ plugin.installed ? "已安装" : "未安装" }}</b>
                      </div>
                      <div class="status-row">
                        <span>鉴权</span>
                        <b :class="agentScanFor('astrbot')?.auth?.loggedIn ? 'text-success' : 'text-warning'">
                          {{ agentScanFor('astrbot')?.auth?.message || "-" }}
                        </b>
                      </div>
                      <div class="status-row">
                        <span>会话</span>
                        <b :class="astrbotSessionItems().length ? 'text-success' : 'text-warning'">
                          {{ astrbotSessionItems().length ? `可选 ${astrbotSessionItems().length} 个` : "未读取到会话" }}
                        </b>
                      </div>
                      <div class="status-row">
                        <span>验证</span>
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
                    </div>
                    <v-alert
                      v-if="astrbotLoginResult"
                      :type="astrbotLoginResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="full-span"
                    >
                      {{ astrbotLoginResult.message }}
                    </v-alert>
                  </template>

                  <v-combobox
                    v-if="selectedAgent === 'copilotCli'"
                    v-model="form.copilotCliBin"
                    :items="agentScan.copilotBins"
                    label="CLI 可执行路径"
                    placeholder="copilot"
                    hint="留空使用 PATH 中的 copilot"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-if="selectedAgent === 'copilotCli'"
                    v-model="form.copilotCwd"
                    :items="projectItems()"
                    class="full-span"
                    label="项目目录 (-C)"
                    placeholder="C:/Path/To/Project"
                    hint="会话列表会按这个目录过滤"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-else-if="selectedAgent !== 'astrbot' && selectedAgent !== 'marvis'"
                    v-model="form.codexCwd"
                    :items="projectItems()"
                    class="full-span"
                    label="项目目录"
                    placeholder="留空，使用 RabiRoute 根目录"
                    hint="用于同名任务的自动查找和新建；选择已有任务时会采用任务自己的目录"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-if="selectedAgent !== 'astrbot' && selectedAgent !== 'marvis'"
                    :model-value="selectedSessionName"
                    :items="sessionNames()"
                    item-title="title"
                    item-value="value"
                    :return-object="false"
                    :label="selectedAgent === 'codex' ? '会话名 + 最后会话时间' : '会话线程名'"
                    placeholder="选择已有会话，或输入新会话名"
                    :hint="selectedAgent === 'codex' ? '每次读取 200 个 Desktop 任务；可继续加载，输入名称后先自动查找，只有不存在时才创建' : '没有扫到时也可以手动填写'"
                    persistent-hint
                    @update:model-value="selectSession"
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>
                  <v-btn
                    v-if="selectedAgent === 'codex' && agentScanFor('codex')?.sessionPage?.hasMore"
                    class="full-span"
                    size="small"
                    variant="text"
                    prepend-icon="mdi-chevron-down"
                    :loading="agentScan.loading"
                    @click="loadMoreCodexSessions"
                  >
                    加载更多 Desktop 任务
                  </v-btn>
                  </div>
                </div>
              </v-window-item>

              <v-window-item :value="3">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">人格可选与配置确认</div>
                    <div class="section-note">不配置人格时，只按消息入口默认模板把来源和回传 API 投递给 Agent。</div>
                  </div>
                </div>
                <v-combobox
                  v-model="form.agentRoleId"
                  :items="roleOptions"
                  item-title="title"
                  item-value="value"
                  :return-object="false"
                  label="默认人格 ID"
                  placeholder="留空，不配置人格"
                  clearable
                  class="mb-4"
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
                </v-combobox>
                <v-combobox
                  v-model="form.agentModel"
                  :items="agentModelChoices"
                  label="Agent 模型（播放文字）"
                  placeholder="留空使用默认"
                  hint="额度不足时可切到 gpt-5.3。可手动输入自定义模型名。"
                  clearable
                />
                <div class="quick-review">
                  <div class="status-row"><span>消息入口</span><b>{{ form.adapters.map(adapterLabel).join(" + ") }}</b></div>
                  <div class="status-row"><span>Agent</span><b>{{ quickAgentChoices.find(agent => agent.type === selectedAgent)?.title || selectedAgent }}</b></div>
                  <div class="status-row"><span>{{ agentPrimaryLabel() }}</span><b>{{ currentProject() || "未填写" }}</b></div>
                  <div class="status-row"><span>{{ agentSessionLabel() }}</span><b>{{ agentSessionSummary() }}</b></div>
                  <div class="status-row"><span>人格</span><b>{{ form.agentRoleId || "不配置人格" }}</b></div>
                  <div class="status-row"><span>模型</span><b>{{ form.agentModel || "默认模型" }}</b></div>
                </div>
                <v-alert v-if="!canSave" class="mt-4" type="warning" variant="tonal">
                  {{ saveBlockReason || "还有必要字段没有填写，请回到对应步骤补全。" }}
                </v-alert>
                <v-alert v-if="applyError" class="mt-4" type="error" variant="tonal">
                  {{ applyError }}
                </v-alert>
              </v-window-item>
            </v-window>
          </section>
        </div>
      </v-card-text>

      <v-card-actions class="px-6 pb-5">
        <v-btn variant="text" :disabled="activeStep === 1" @click="activeStep -= 1">上一步</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="open = false">稍后再配</v-btn>
        <v-btn v-if="activeStep < 3" color="primary" variant="tonal" @click="goNext">下一步</v-btn>
        <v-btn v-else color="primary" :disabled="!canSave || applySaving" :loading="applySaving || store.saving" @click="apply">保存配置</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
:deep(.v-list-item-subtitle) {
  color: var(--rr-muted-soft) !important;
  opacity: 1 !important;
}
</style>
