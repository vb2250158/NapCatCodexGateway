import path from "node:path";
import type { GatewayMessageAdapterType, MessageEndpointType } from "../adapters/messageAdapter.js";

type AgentMaturity = "verified" | "experimental" | "stub";

type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type MessageAdapterScanResult = {
  type: MessageEndpointType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
};

export type WebhookLikeScanContext<Runtime> = {
  rootDir: string;
  adapterRuntimes: (type: MessageEndpointType) => Runtime[];
  routeCallbackEndpoint: (runtime: Runtime, type: MessageEndpointType) => AdapterEndpoint | null;
  routeHasRecentMessages: (runtime: Runtime, type: MessageEndpointType) => boolean;
  checkHttpEndpoint: (url: string, timeoutMs?: number) => Promise<boolean>;
  fenneNotePlaybackUrl: string;
};

function scanCallbacks<Runtime>(ctx: WebhookLikeScanContext<Runtime>, type: Extract<GatewayMessageAdapterType, "fennenote" | "rabilink" | "webhook">): {
  runtimes: Runtime[];
  callbacks: AdapterEndpoint[];
  callbackReady: boolean;
} {
  const runtimes = ctx.adapterRuntimes(type);
  const callbacks = runtimes.map((runtime) => ctx.routeCallbackEndpoint(runtime, type)).filter(Boolean) as AdapterEndpoint[];
  const callbackReady = callbacks.some((endpoint) => endpoint.healthy);
  return { runtimes, callbacks, callbackReady };
}

export async function scanFenneNoteEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: fenneRuntimes, callbacks: fenneCallbacks, callbackReady: fenneCallbackReady } = scanCallbacks(ctx, "fennenote");
  const fennePlaybackUrl = ctx.fenneNotePlaybackUrl.trim();
  const fennePlaybackHealthy = fennePlaybackUrl
    ? await ctx.checkHttpEndpoint(fennePlaybackUrl, 1200)
    : false;
  const fenneRecent = fenneRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "fennenote"));

  return {
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    maturity: "experimental",
    installed: fenneCallbackReady || fennePlaybackHealthy,
    installCandidates: [
      { label: "语音交互工作站接线说明", url: "https://github.com/vb2250158/RabiRoute/blob/main/docs/voice-interaction-workstation.md" },
      { label: "本地说明：docs/voice-interaction-workstation.md", path: path.join(ctx.rootDir, "docs", "voice-interaction-workstation.md") }
    ],
    endpoints: [
      ...fenneCallbacks,
      ...(fennePlaybackUrl
        ? [{ label: "FenneNote 播放/回复端", url: fennePlaybackUrl, healthy: fennePlaybackHealthy }]
        : [])
    ],
    requirements: [
      { id: "callback", label: "RabiRoute FenneNote 回调入口", required: true, ok: fenneCallbackReady, detail: fenneCallbacks[0]?.url || "添加 FenneNote 消息端并重启 route 后生成。" },
      { id: "app", label: "FenneNote 桌面端/语音转写端", required: true, ok: fennePlaybackHealthy, detail: fennePlaybackHealthy ? "检测到 FenneNote 本地播放/回复端可达。" : fennePlaybackUrl ? "已配置 FenneNote 播放/回复端，但当前不可达。" : "未配置 FENNOTE_PLAYBACK_URL；RabiRoute 不会猜测或占用固定端口。" },
      { id: "webhook-config", label: "FenneNote 已配置转写 webhook", required: true, ok: fenneRecent, detail: fenneRecent ? "已收到过 FenneNote 语音转写事件。" : "尚未收到 FenneNote 请求；请把回调地址填到 FenneNote 的转写/事件配置里。" },
      { id: "tts", label: "OumuQ / TTS worker", required: false, ok: undefined, detail: "只做语音输入时可先不配；需要播报回复时再配置。" }
    ],
    warnings: [
      "RabiRoute 只能检测自己的回调入口和可选播放端；FenneNote 是否真正录音/转写，需要 FenneNote 端或最近请求日志确认。",
      "不要把 FenneNote 叫成 Webhook；日志和消息文件会按 FenneNote 独立分组。"
    ]
  };
}

export async function scanRabiLinkEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: rabiLinkRuntimes, callbacks: rabiLinkCallbacks, callbackReady: rabiLinkCallbackReady } = scanCallbacks(ctx, "rabilink");
  const rabiLinkRecent = rabiLinkRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "rabilink"));

  return {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    maturity: "experimental",
    installed: rabiLinkCallbackReady,
    endpoints: rabiLinkCallbacks,
    requirements: [
      { id: "callback", label: "RabiRoute RabiLink 本地入口", required: true, ok: rabiLinkCallbackReady, detail: rabiLinkCallbacks[0]?.url || "添加 RabiLink 消息端并重启 route 后生成。" },
      { id: "relay-worker", label: "电脑端 Relay worker 已接入", required: true, ok: rabiLinkRecent, detail: rabiLinkRecent ? "已收到过 RabiLink Relay 事件。" : "尚未收到 RabiLink Relay 任务。" },
      { id: "public-url", label: "公网 HTTPS Relay 地址", required: true, ok: undefined, detail: "Rokid/灵珠插件调用公网 Relay；RabiRoute 电脑端负责从 Relay 领取任务并回填回复。" }
    ],
    warnings: ["RabiLink 现在走电脑端直连 Relay；手机 App 只保留为可选调试入口，不再作为主消息中转。"]
  };
}

export async function scanWearableEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const runtimes = ctx.adapterRuntimes("wearable");
  const relayRuntimes = ctx.adapterRuntimes("rabilink");
  const recent = runtimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "wearable"));
  return {
    type: "wearable",
    label: "智能手表/手环",
    maturity: "experimental",
    installed: runtimes.length > 0,
    requirements: [
      { id: "route", label: "智能手表/手环消息端", required: true, ok: runtimes.length > 0, detail: runtimes.length > 0 ? "当前 Route 已添加健康消息端。" : "请先在当前 Route 添加智能手表/手环消息端。" },
      { id: "relay", label: "RabiLink Relay 转接", required: true, ok: relayRuntimes.length > 0 || runtimes.length > 0, detail: "健康消息端复用全局 RabiLink Relay 与所选 Rabi PC。" },
      { id: "mobile", label: "RabiLink 手机健康采集", required: true, ok: recent || undefined, detail: recent ? "已收到过穿戴健康事件。" : "请在 RabiLink 手机端配置设备、Health Connect 与同步规则。" }
    ],
    warnings: [
      "小米 auth key 只能保存在手机 Android Keystore；不要填进 Route、Relay 或公开配置。",
      "Health Connect 是否有数据取决于厂商写入；小米健康当前真机可能仍为空。"
    ]
  };
}

export async function scanWebhookEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: webhookRuntimes, callbacks: webhookCallbacks, callbackReady: webhookCallbackReady } = scanCallbacks(ctx, "webhook");

  return {
    type: "webhook",
    label: "通用 Webhook",
    maturity: "experimental",
    installed: webhookCallbackReady,
    endpoints: webhookCallbacks,
    requirements: [
      { id: "callback", label: "RabiRoute 通用回调入口", required: true, ok: webhookCallbackReady, detail: webhookCallbacks[0]?.url || "添加通用 Webhook 消息端并重启 route 后生成。" },
      { id: "sender", label: "外部系统已配置 POST", required: true, ok: webhookRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "webhook")), detail: "RabiRoute 无法自动知道外部系统是否已配置；以最近请求日志为准。" }
    ],
    warnings: ["只有真正不知道来源的外部 POST 才用通用 Webhook；FenneNote、小爱、Home Assistant 等应拆成具体消息端。"]
  };
}
