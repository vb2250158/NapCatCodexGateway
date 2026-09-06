import type http from "node:http";
import type { MessageEndpointType } from "../shared/messageEndpointTypes.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";
import type { RabiUiContribution } from "../runtime/contributionRegistry.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import {
  runBoundedScans,
  type BoundedScanTask,
  type ScanDiagnostic
} from "./scanController.js";
import {
  summarizeIndependentAdapterHealth,
  type AdapterOperationalHealth,
  type IndependentAdapterHealthSummary
} from "./messageAdapterHealth.js";
import type { NapcatHealthScanPayload } from "../messageEndpoints/napcatHealthScan.js";
import {
  scanFenneNoteEndpoint,
  scanRabiLinkEndpoint,
  scanWearableEndpoint,
  scanWebhookEndpoint
} from "../messageEndpoints/webhookLikeScans.js";
import { scanWeComEndpoint } from "../messageEndpoints/wecomManager.js";

export const MESSAGE_ADAPTER_CONTROL_INSTANCE_ID = "manager:message-adapter-control";
export const MESSAGE_ADAPTER_SCAN_DEADLINE_MS = 6_000;

export type MessageAdapterMaturity = "verified" | "experimental" | "stub";

export type MessageAdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type MessageAdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type MessageAdapterScanResult = {
  type: MessageEndpointType;
  label: string;
  maturity: MessageAdapterMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: MessageAdapterEndpoint[];
  requirements?: MessageAdapterRequirement[];
  warnings?: string[];
  scan?: ScanDiagnostic;
  health?: AdapterOperationalHealth;
};

export type MessageAdapterScanProvider = {
  type: MessageEndpointType;
  label: string;
  maturity: MessageAdapterMaturity;
  mode?: "bounded" | "immediate";
  scan(): MessageAdapterScanResult | Promise<MessageAdapterScanResult>;
  fallback?(diagnostic: ScanDiagnostic): MessageAdapterScanResult;
};

export type MessageAdapterScanBundle = {
  adapters: Record<MessageEndpointType, MessageAdapterScanResult>;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
};

export type NapcatHealthScanBundle = {
  payload: NapcatHealthScanPayload;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
};

export type MessageAdapterControlScanContext = {
  rootDir: string;
  adapterRuntimes(type: MessageEndpointType): GatewayRuntime[];
  routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageEndpointType): MessageAdapterEndpoint | null;
  routeHasRecentMessages(runtime: GatewayRuntime, type: MessageEndpointType): boolean;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
  fenneNotePlaybackUrl: string;
  scanNapcatEndpoint(): MessageAdapterScanResult | Promise<MessageAdapterScanResult>;
  remoteAgentScanResult(): MessageAdapterScanResult;
  speechStatus(): Promise<SpeechRuntimeStatus>;
  xiaomiHomeHealth(): Promise<Record<string, unknown>>;
  readGatewayStatus(definition: GatewayDefinition): Record<string, any>;
  weixinDefaultBaseUrl(): string;
};

export type MessageAdapterControlApiContext = {
  service: MessageAdapterControlService;
  scanNapcatHealth(): Promise<NapcatHealthScanBundle>;
  gatewayPayload(): unknown;
  jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void;
  trackOperation<T>(operation: Promise<T>): Promise<T>;
};

export const MESSAGE_ADAPTER_CONFIG_PAGE_CONTRIBUTION = {
  kind: "page",
  surface: "web.pages",
  id: "message-adapters-page",
  label: { fallback: "消息适配器" },
  routeId: "route.adapters",
  rendererId: "builtin.web-page.adapters.v1",
  slot: "route",
  hosts: ["web"],
  order: 20
} as const satisfies RabiUiContribution;

export const MESSAGE_ADAPTER_NAVIGATION_CONTRIBUTION = {
  kind: "navigation",
  surface: "web.navigation",
  id: "message-adapters",
  label: { fallback: "消息适配器" },
  routeId: "route.adapters",
  icon: "mdi-puzzle-outline",
  slot: "route-primary",
  hosts: ["web"],
  order: 20
} as const satisfies RabiUiContribution;

/**
 * The page and navigation stay declarative. The WebGUI host owns the Vue
 * renderer; this plugin instance only owns whether the route is contributed.
 */
export const MESSAGE_ADAPTER_CONTROL_CONTRIBUTIONS = [
  MESSAGE_ADAPTER_CONFIG_PAGE_CONTRIBUTION,
  MESSAGE_ADAPTER_NAVIGATION_CONTRIBUTION
] as const satisfies readonly RabiUiContribution[];

function fallbackScanResult(provider: MessageAdapterScanProvider, diagnostic: ScanDiagnostic): MessageAdapterScanResult {
  if (provider.fallback) return provider.fallback(diagnostic);
  return {
    type: provider.type,
    label: provider.label,
    maturity: provider.maturity,
    installed: false,
    scan: diagnostic,
    warnings: [
      diagnostic.state === "timeout"
        ? `${provider.label} 检查超过本轮 ${MESSAGE_ADAPTER_SCAN_DEADLINE_MS} ms 截止时间；没有把超时推断为离线。`
        : `${provider.label} 检查失败：${diagnostic.message || "未知错误"}`
    ]
  };
}

export class MessageAdapterScanProviderRegistry {
  private readonly providers = new Map<MessageEndpointType, MessageAdapterScanProvider>();

  register(provider: MessageAdapterScanProvider): () => void {
    if (this.providers.has(provider.type)) {
      throw new Error(`Message adapter scan provider already registered: ${provider.type}`);
    }
    this.providers.set(provider.type, provider);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.providers.get(provider.type) === provider) this.providers.delete(provider.type);
    };
  }

  registerMany(providers: readonly MessageAdapterScanProvider[]): () => void {
    const disposers: Array<() => void> = [];
    try {
      for (const provider of providers) disposers.push(this.register(provider));
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  snapshot(): MessageAdapterScanProvider[] {
    return [...this.providers.values()];
  }

}

export class MessageAdapterControlService {
  private accepting = true;
  private readonly activeProbes = new Set<Promise<unknown>>();

  constructor(
    readonly providers: MessageAdapterScanProviderRegistry,
    private readonly deadlineMs = MESSAGE_ADAPTER_SCAN_DEADLINE_MS
  ) {}

  async scanAdapters(): Promise<MessageAdapterScanBundle> {
    if (!this.accepting) throw new Error("Message adapter control plugin is stopping or inactive.");
    const providers = this.providers.snapshot();
    const boundedProviders = providers.filter(provider => provider.mode !== "immediate");
    const tasks: Array<BoundedScanTask<string, MessageAdapterScanResult>> = boundedProviders.map(provider => ({
      key: provider.type,
      run: () => this.trackProbe(provider.scan()),
      fallback: diagnostic => fallbackScanResult(provider, diagnostic)
    }));
    const bounded = await runBoundedScans(tasks, { deadlineMs: this.deadlineMs });
    const values = new Map<MessageEndpointType, MessageAdapterScanResult>();
    for (const provider of boundedProviders) {
      const result = bounded.values[provider.type];
      if (result) values.set(provider.type, result);
    }
    for (const provider of providers.filter(provider => provider.mode === "immediate")) {
      values.set(provider.type, await this.trackProbe(provider.scan()));
    }
    const adapters = Object.fromEntries(
      providers
        .map(provider => [provider.type, values.get(provider.type)] as const)
        .filter((entry): entry is readonly [MessageEndpointType, MessageAdapterScanResult] => entry[1] !== undefined)
    ) as Record<MessageEndpointType, MessageAdapterScanResult>;
    for (const [type, diagnostic] of Object.entries(bounded.diagnostics)) {
      const adapter = adapters[type as MessageEndpointType];
      if (adapter) adapter.scan = diagnostic;
    }
    return {
      adapters,
      diagnostics: bounded.diagnostics,
      partial: bounded.partial,
      durationMs: bounded.durationMs,
      deadlineMs: bounded.deadlineMs
    };
  }

  async stop(): Promise<void> {
    this.accepting = false;
    while (this.activeProbes.size > 0) {
      await Promise.allSettled([...this.activeProbes]);
    }
  }

  activeProbeCount(): number {
    return this.activeProbes.size;
  }

  private trackProbe<T>(probe: T | Promise<T>): Promise<T> {
    const tracked = Promise.resolve(probe);
    this.activeProbes.add(tracked);
    void tracked.then(
      () => this.activeProbes.delete(tracked),
      () => this.activeProbes.delete(tracked)
    );
    return tracked;
  }
}

function provider(
  type: MessageEndpointType,
  label: string,
  maturity: MessageAdapterMaturity,
  scan: MessageAdapterScanProvider["scan"],
  mode: MessageAdapterScanProvider["mode"] = "bounded"
): MessageAdapterScanProvider {
  return { type, label, maturity, mode, scan };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayBaseUrl(value: unknown): string {
  try {
    const url = new URL(String(value || "http://127.0.0.1:8123"));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "Home Assistant（地址不可用）";
  }
}

export function scanXiaomiHomeEndpoint(healthInput: Record<string, unknown>): MessageAdapterScanResult {
  const health = recordValue(healthInput);
  const monitor = recordValue(health.eventMonitor);
  const camera = recordValue(health.cameraCapture);
  const status = String(health.status || "unavailable");
  const tokenConfigured = health.tokenConfigured === true;
  const ready = status === "ready" && tokenConfigured;
  const monitorState = String(monitor.connectionState || (tokenConfigured ? "stopped" : "authorization_required"));
  const monitorReady = ready && monitor.enabled === true && monitorState === "subscribed";
  const cameraReady = camera.ready === true;
  const authorizationDetail = status === "authorization_required"
    ? "待授权：请在当前 Route 的米家消息端卡片连接 Home Assistant；凭证只写入本机受保护凭证库。"
    : status === "authorization_failed"
      ? "本机凭证已被 Home Assistant 拒绝；请在米家消息端卡片验证并替换。"
      : status === "timeout"
        ? "本机已有授权配置，但 Home Assistant 健康检查超时。"
        : status === "unreachable"
          ? "本机已有授权配置，但 Home Assistant 当前不可达。"
          : ready
            ? "Home Assistant 已确认授权可用。"
            : "尚未确认 Home Assistant 授权状态。";
  const monitorLabels: Record<string, string> = {
    disabled: "事件监听已关闭。",
    authorization_required: "待授权；授权完成前不会建立事件连接。",
    authorization_failed: "Home Assistant 拒绝授权，事件监听已停止重连。",
    stopped: "事件监听当前未运行。",
    connecting: "正在连接 Home Assistant 事件流。",
    authorizing: "正在验证 Home Assistant 授权。",
    subscribing: "已授权，正在订阅状态变化事件。",
    subscribed: "正在订阅状态变化事件。",
    reconnecting: "事件流已断开，正在有界重连。"
  };
  return {
    type: "xiaomiHome",
    label: "米家 / Xiaomi Home",
    maturity: "experimental",
    installed: true,
    endpoints: [{
      label: "Home Assistant",
      url: displayBaseUrl(health.baseUrl),
      healthy: ready
    }],
    requirements: [
      { id: "authorization", label: "Home Assistant 授权", required: true, ok: ready, detail: authorizationDetail },
      { id: "event-monitor", label: "米家事件监听", required: true, ok: monitorReady, detail: monitorLabels[monitorState] || `事件监听状态：${monitorState}` },
      { id: "write-control", label: "设备控制", required: false, ok: health.writeEnabled === true, detail: health.writeEnabled === true ? "控制已显式开启；所有动作仍经过能力与幂等校验。" : "默认关闭；当前消息端只读取状态和事件。" },
      { id: "camera-capture", label: "摄像头事件录像", required: false, ok: cameraReady, detail: cameraReady ? `已就绪；当前 ${Number(camera.inFlight || 0)} 个抓取任务。` : camera.enabled === true ? "已开启，但尚未配置允许的媒体主机。" : "未开启；普通米家状态事件不受影响。" }
    ],
    warnings: [
      "米家只把 Home Assistant 状态与摄像头事件投递到当前人格；它不是 Gateway 常驻 adapter，也不同于小米音箱 / 小爱。",
      ...(ready ? [] : ["未取得 Home Assistant 的真实成功响应前，状态保持为待授权或未连接。"])
    ]
  };
}

export function createBuiltinMessageAdapterScanProviders(
  context: MessageAdapterControlScanContext
): MessageAdapterScanProvider[] {
  const webhookLikeContext = {
    rootDir: context.rootDir,
    adapterRuntimes: context.adapterRuntimes,
    routeCallbackEndpoint: context.routeCallbackEndpoint,
    routeHasRecentMessages: context.routeHasRecentMessages,
    checkHttpEndpoint: context.checkHttpEndpoint,
    fenneNotePlaybackUrl: context.fenneNotePlaybackUrl
  };

  return [
    provider("napcat", "NapCat / OneBot", "verified", context.scanNapcatEndpoint),
    provider("remoteAgent", "远端 Agent", "experimental", context.remoteAgentScanResult, "immediate"),
    provider("heartbeat", "定时触发", "verified", () => ({
      type: "heartbeat",
      label: "定时触发",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "route", label: "RabiRoute 内部定时器", required: true, ok: true, detail: "无需额外安装。" },
        { id: "agent", label: "Agent 端可接收消息", required: true, ok: undefined, detail: "保存后用“立即触发”或日志页验证投递。" }
      ],
      warnings: ["定时触发不会证明外部平台可用，只能验证路由到 Agent 的链路。"]
    }), "immediate"),
    provider("rolePanel", "角色面板", "verified", () => ({
      type: "rolePanel",
      label: "角色面板",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "builtin", label: "RabiRoute 内置角色面板", required: true, ok: true, detail: "无需安装；托盘打开后可作为本地消息端使用。" },
        { id: "timeline", label: "角色聊天记录", required: true, ok: true, detail: "按角色写入 data/roles/<RoleId>/role-panel/messages.jsonl。" }
      ],
      warnings: ["角色面板是固定内置消息端，不能删除或禁用；自由聊天使用 role_panel_message 路由类型。"]
    }), "immediate"),
    provider("speech", "语音消息端", "verified", async () => {
      const speechStatus = await context.speechStatus();
      return {
        type: "speech",
        label: "语音消息端",
        maturity: "verified",
        installed: speechStatus.state === "online",
        endpoints: [{
          label: "RabiSpeech 本机服务",
          url: speechStatus.configuredUrl,
          healthy: speechStatus.state === "online"
        }],
        requirements: [
          { id: "builtin", label: "RabiPC 内置语音消息端", required: true, ok: true, detail: "麦克风、阈值、常驻转录和 Route 投递由 RabiPC 提供。" },
          { id: "runtime", label: "RabiSpeech 本地模型服务", required: true, ok: speechStatus.state === "online", detail: speechStatus.error || `${speechStatus.providers.tts.length} 个 TTS provider，${speechStatus.providers.asr.length} 个 ASR provider。` },
          { id: "provider-mode", label: "语音 Provider 模式", required: true, ok: true, detail: speechStatus.localOnly === true ? "当前仅启用本地 TTS/ASR Provider。" : "已显式启用 API Provider；密钥由 RabiSpeech 进程环境持有。" }
        ],
        warnings: speechStatus.state === "online" ? [] : ["先启动 RabiSpeech，再做麦克风实机 ASR 和 TTS 排队播放测试。"]
      };
    }),
    provider("fennenote", "FenneNote / 芬妮笔记", "experimental", () => scanFenneNoteEndpoint(webhookLikeContext)),
    provider("xiaomiHome", "米家 / Xiaomi Home", "experimental", async () => scanXiaomiHomeEndpoint(await context.xiaomiHomeHealth())),
    provider("rabilink", "RabiLink / Relay 直连", "experimental", () => scanRabiLinkEndpoint(webhookLikeContext)),
    provider("wearable", "智能手表/手环", "experimental", () => scanWearableEndpoint(webhookLikeContext)),
    provider("wecom", "企业微信 / WeCom", "experimental", () => scanWeComEndpoint({
      rootDir: context.rootDir,
      adapterRuntimes: context.adapterRuntimes,
      routeHasRecentMessages: context.routeHasRecentMessages
    })),
    provider("weixin", "个人微信 / Weixin", "experimental", () => {
      const runtimes = context.adapterRuntimes("weixin");
      const statuses = runtimes.map(runtime => context.readGatewayStatus(runtime.definition).messageAdapters?.weixin ?? {});
      const loggedIn = statuses.some(status => status.loggedIn === true && status.sessionPhase === "restored");
      const restoring = statuses.some(status => status.sessionPhase === "restoring");
      const credentialsRetained = statuses.some(status =>
        status.credentialsRetained === true
        && (status.sessionPhase === "restoring" || status.sessionPhase === "temporarily_unreachable"));
      const loginDetail = loggedIn
        ? "当前个人微信会话已由服务端确认并完成恢复。"
        : restoring
          ? "正在从安全存储恢复会话；这不影响 Manager 或其它消息入口。"
          : credentialsRetained
            ? "外部 API 暂时不可达，但会话凭据仍保留，不要求扫码。"
            : "当前没有可用会话；请明确点击生成二维码后扫码。";
      const hasRecentMessages = runtimes.some(runtime => context.routeHasRecentMessages(runtime, "weixin"));
      return {
        type: "weixin",
        label: "个人微信 / Weixin",
        maturity: "experimental",
        installed: true,
        endpoints: [{
          label: "OpenClaw iLink API",
          url: runtimes[0]?.definition.weixinBaseUrl || context.weixinDefaultBaseUrl(),
          healthy: loggedIn
        }],
        requirements: [
          { id: "route", label: "已配置个人微信消息端", required: true, ok: runtimes.length > 0, detail: runtimes.length > 0 ? "已存在使用 weixin adapter 的 Route。" : "在 Route 中启用个人微信消息端。" },
          { id: "login", label: "个人微信当前会话", required: true, ok: loggedIn, detail: loginDetail },
          { id: "recent-message", label: "历史个人微信消息证据", required: false, ok: hasRecentMessages, detail: hasRecentMessages ? "存在历史消息记录；它不代表当前登录。" : "尚无历史消息记录；它与当前登录状态相互独立。" }
        ],
        warnings: [
          "个人微信接入仍是实验能力，依赖 OpenClaw iLink API；单入口故障不会升级为 Manager 或 QQ 全局故障。",
          "二维码只在管理面明确请求后生成；临时网络失败会保留安全会话，不要求重新扫码。"
        ]
      };
    }, "immediate"),
    provider("feishu", "飞书 / Feishu", "experimental", () => {
      const runtimes = context.adapterRuntimes("feishu");
      return {
        type: "feishu",
        label: "飞书 / Feishu",
        maturity: "experimental",
        installed: runtimes.length > 0,
        requirements: [
          { id: "route", label: "已配置飞书消息端", required: true, ok: runtimes.length > 0, detail: runtimes.length > 0 ? "Route 已启用独立 feishu adapter。" : "在 Route 中启用 feishu adapter。" },
          { id: "app", label: "飞书应用凭据", required: true, ok: runtimes.some(runtime => Boolean(runtime.definition.feishuAppId && runtime.definition.feishuAppSecret)), detail: "需要 App ID 和 App Secret，群机器人 webhook 不能替代。" },
          { id: "event", label: "事件订阅与签名", required: true, ok: runtimes.some(runtime => runtime.definition.feishuEventSubscriptionEnabled === true && Boolean(runtime.definition.feishuVerificationToken && runtime.definition.feishuEncryptKey)), detail: "需要配置公网 HTTPS 回调、Verification Token、Encrypt Key，订阅 im.message.receive_v1 后再显式确认。" }
        ],
        warnings: ["飞书是独立消息端；通用 webhook 不会作为飞书入站或出站替代。"]
      };
    }, "immediate"),
    provider("webhook", "通用 Webhook", "experimental", () => scanWebhookEndpoint(webhookLikeContext))
  ];
}

export function registerBuiltinMessageAdapterScanProviders(
  registry: MessageAdapterScanProviderRegistry,
  context: MessageAdapterControlScanContext
): () => void {
  return registry.registerMany(createBuiltinMessageAdapterScanProviders(context));
}

export async function messageAdapterControlPayload(
  gatewayId: string | undefined,
  context: MessageAdapterControlApiContext
): Promise<Record<string, unknown>> {
  const [adapterScan, napcatScan] = await Promise.all([
    context.service.scanAdapters(),
    context.scanNapcatHealth()
  ]);
  const health: IndependentAdapterHealthSummary = summarizeIndependentAdapterHealth({
    adapters: adapterScan.adapters,
    napcatHealth: napcatScan.payload
  });
  for (const [type, adapterHealth] of Object.entries(health.adapters)) {
    const adapter = adapterScan.adapters[type as MessageEndpointType];
    if (adapter) adapter.health = adapterHealth;
  }
  return {
    adapters: adapterScan.adapters,
    health,
    scan: {
      requestedGatewayId: gatewayId,
      partial: adapterScan.partial || napcatScan.partial,
      durationMs: Math.max(adapterScan.durationMs, napcatScan.durationMs),
      deadlineMs: Math.max(adapterScan.deadlineMs, napcatScan.deadlineMs),
      adapters: adapterScan.diagnostics,
      napcatInstances: napcatScan.diagnostics
    },
    repair: {
      changed: false,
      messages: ["本轮扫描只读取状态；未启动进程、未修改配置、未触发登录或修复。"]
    },
    napcatHealth: napcatScan.payload,
    gatewayPayload: context.gatewayPayload()
  };
}

export function handleMessageAdapterControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: MessageAdapterControlApiContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/scan/message-adapters") return false;
  const gatewayId = requestUrl.searchParams.get("gatewayId") || undefined;
  void context.trackOperation(messageAdapterControlPayload(gatewayId, context)
    .then(payload => context.jsonResponse(response, 200, payload))
    .catch(error => {
      context.jsonResponse(response, 500, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      });
    }));
  return true;
}
