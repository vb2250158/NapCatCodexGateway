import { createFeishuAdapter } from "./feishuAdapter.js";
import { createHeartbeatAdapter } from "./heartbeatAdapter.js";
import { createNapCatAdapter } from "./napcatAdapter.js";
import { createRabiLinkAdapter } from "./rabilinkAdapter.js";
import { createFenneNoteAdapter, createWebhookAdapter } from "./webhookAdapter.js";
import { createWeComAdapter } from "./wecomAdapter.js";
import { createWeixinAdapter } from "./weixinAdapter.js";
import type { MessageAdapterDefinition } from "./messageAdapter.js";

export const webhookMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "webhook",
    label: "通用 Webhook",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createWebhookAdapter()
};

export const fenneNoteMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createFenneNoteAdapter()
};

export const rabiLinkMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createRabiLinkAdapter()
};

export const heartbeatMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "heartbeat",
    label: "定时触发",
    host: "gateway",
    transport: "timer",
    lifecycle: "fiber"
  },
  create: () => createHeartbeatAdapter()
};

export const napcatMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "napcat",
    label: "NapCat / OneBot",
    host: "gateway",
    transport: "websocket",
    lifecycle: "fiber"
  },
  create: () => createNapCatAdapter()
};

export const wecomMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "wecom",
    label: "企业微信",
    host: "gateway",
    transport: "websocket",
    lifecycle: "fiber"
  },
  create: () => createWeComAdapter()
};

export const weixinMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "weixin",
    label: "个人微信",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createWeixinAdapter()
};

export const feishuMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "feishu",
    label: "飞书",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createFeishuAdapter()
};

export function builtinMessageAdapterDefinitions(): MessageAdapterDefinition[] {
  return [
    webhookMessageAdapterDefinition,
    fenneNoteMessageAdapterDefinition,
    rabiLinkMessageAdapterDefinition,
    heartbeatMessageAdapterDefinition,
    napcatMessageAdapterDefinition,
    wecomMessageAdapterDefinition,
    weixinMessageAdapterDefinition,
    feishuMessageAdapterDefinition
  ];
}
