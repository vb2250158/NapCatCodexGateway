import { parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";

export type RabiAgentMessageSource = {
  type: "agent";
  agentAdapter: AgentAdapterType;
  agentType?: string;
  sessionName: string;
  sessionId: string;
  workspace?: string;
};

export type RabiPlanMessageSource = {
  type: "plan";
  planName: string;
  planId: string;
  sourceAgent?: Omit<RabiAgentMessageSource, "type">;
};

export type RabiMessageAdapterSource = {
  type: "message_adapter";
  messageAdapter: string;
  conversationType: string;
  conversationName?: string;
  conversationId: string;
  senderName?: string;
  senderId?: string;
  messageId: string;
  messageGroupId?: string;
  routeName?: string;
  routeId?: string;
};

export type RabiSystemMessageSource = {
  type: "system";
  eventType: string;
  eventName: string;
  eventId: string;
  actorType?: string;
  actorName?: string;
  actorId?: string;
  routeName?: string;
  routeId?: string;
};

export type RabiMessageSource =
  | RabiAgentMessageSource
  | RabiPlanMessageSource
  | RabiMessageAdapterSource
  | RabiSystemMessageSource;

export const RABI_MESSAGE_SOURCE_HEADER = "[消息源]";
export const RABI_MESSAGE_CONTENT_HEADER = "[消息内容]";
const RABI_MESSAGE_ENVELOPE_HEADER_PATTERN = /^\s*\[(?:消息源|消息内容|投递源)\]\s*$/m;

export type RabiDeliveryEnvelope = {
  messageSource: RabiMessageSource;
  messageContent: string;
  contextBlocks?: readonly string[];
  controlBlocks?: readonly string[];
  escapeMessageContentHeaders?: boolean;
  /** The time this envelope is rendered for delivery. Tests and replays may provide a stable value. */
  sentAt?: string;
};

function optionalLine(label: string, value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? `${label}：${text}` : undefined;
}

function agentSourceLines(source: Omit<RabiAgentMessageSource, "type">): Array<string | undefined> {
  return [
    `Agent 端：${source.agentAdapter}`,
    optionalLine("Agent 类型", source.agentType),
    `会话名称：${source.sessionName}`,
    `会话 ID：${source.sessionId}`,
    optionalLine("工作目录", source.workspace)
  ];
}

function deliverySentAt(value: unknown): string {
  return optionalSourceText(value, "delivery.sentAt", 100)
    ?? new Date().toLocaleString("zh-CN", { hour12: false });
}

export function rabiMessageSourceLines(source: RabiMessageSource, sentAt?: string): string[] {
  const lines: Array<string | undefined> = [RABI_MESSAGE_SOURCE_HEADER];
  if (source.type === "agent") {
    lines.push("消息源类型：Agent", ...agentSourceLines(source));
  } else if (source.type === "plan") {
    lines.push(
      "消息源类型：计划",
      `计划名称：${source.planName}`,
      `计划 ID：${source.planId}`,
      ...(source.sourceAgent ? agentSourceLines(source.sourceAgent) : [])
    );
  } else if (source.type === "message_adapter") {
    lines.push(
      "消息源类型：消息端",
      `消息端：${source.messageAdapter}`,
      optionalLine("会话类型", source.conversationType),
      optionalLine("会话名称", source.conversationName),
      optionalLine("会话 ID", source.conversationId),
      optionalLine("发送者名称", source.senderName),
      optionalLine("发送者 ID", source.senderId),
      optionalLine("消息 ID", source.messageId),
      optionalLine("消息组 ID", source.messageGroupId),
      optionalLine("消息路线", source.routeName),
      optionalLine("消息路线 ID", source.routeId)
    );
  } else {
    lines.push(
      "消息源类型：系统",
      `事件类型：${source.eventType}`,
      `事件名称：${source.eventName}`,
      `事件 ID：${source.eventId}`,
      optionalLine("触发方类型", source.actorType),
      optionalLine("触发方名称", source.actorName),
      optionalLine("触发方 ID", source.actorId),
      optionalLine("消息路线", source.routeName),
      optionalLine("消息路线 ID", source.routeId)
    );
  }
  lines.push(`消息包发送时间：${deliverySentAt(sentAt)}`);
  return lines.filter((line): line is string => Boolean(line));
}

function stripLeadingRabiEnvelope(value: string): string {
  let text = value.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    if (text.startsWith(RABI_MESSAGE_SOURCE_HEADER)) {
      const lines = text.split(/\r?\n/);
      const contentIndex = lines.findIndex((line) => line.trim() === RABI_MESSAGE_CONTENT_HEADER);
      if (contentIndex < 0) break;
      text = lines.slice(contentIndex + 1).join("\n").trim();
      continue;
    }
    if (text.startsWith("[投递源]")) {
      const lines = text.split(/\r?\n/);
      let contentIndex = 1;
      while (contentIndex < lines.length) {
        const line = lines[contentIndex].trim();
        if (!line) {
          while (contentIndex < lines.length && !lines[contentIndex].trim()) contentIndex += 1;
          break;
        }
        if (/^(?:消息源类型|投递源类型|Agent 端|来源 Agent|来源会话|来源会话名称|来源会话 ID|来源工作目录|会话名称|会话 ID|工作目录)：/.test(line)) {
          contentIndex += 1;
          continue;
        }
        break;
      }
      text = lines.slice(contentIndex).join("\n").trim();
      continue;
    }
    break;
  }
  return text;
}

export function normalizeRabiDeliveryBlock(value: unknown, field = "delivery block"): string {
  const block = String(value ?? "").trim();
  if (block && RABI_MESSAGE_ENVELOPE_HEADER_PATTERN.test(block)) {
    throw new Error(`${field} must not contain a message envelope header.`);
  }
  return block;
}

export function normalizeRabiMessageContent(value: unknown, escapeReservedHeaders = false): string {
  const migrated = stripLeadingRabiEnvelope(String(value ?? ""));
  if (!escapeReservedHeaders) return migrated;
  return migrated
    .split(/\r?\n/)
    .map((line) => /^\[[^\]\r\n]{1,100}\]$/.test(line.trim()) ? `> ${line}` : line)
    .join("\n");
}

export function renderRabiDelivery(envelope: RabiDeliveryEnvelope): string {
  const messageSource = normalizeRabiMessageSource(envelope.messageSource);
  const sentAt = deliverySentAt(envelope.sentAt);
  const messageContent = normalizeRabiMessageContent(
    envelope.messageContent,
    envelope.escapeMessageContentHeaders !== false
  );
  const contextBlocks = (envelope.contextBlocks ?? [])
    .map((block, index) => normalizeRabiDeliveryBlock(block, `contextBlocks[${index}]`))
    .filter(Boolean);
  const controlBlocks = (envelope.controlBlocks ?? [])
    .map((block, index) => normalizeRabiDeliveryBlock(block, `controlBlocks[${index}]`))
    .filter(Boolean);
  return [
    ...rabiMessageSourceLines(messageSource, sentAt),
    "",
    RABI_MESSAGE_CONTENT_HEADER,
    messageContent,
    ...contextBlocks.flatMap((block) => ["", block]),
    ...controlBlocks.flatMap((block) => ["", block])
  ].join("\n").trimEnd();
}

export function renderRabiMessage(source: RabiMessageSource, content: string, sentAt?: string): string {
  return renderRabiDelivery({
    messageSource: source,
    messageContent: content,
    escapeMessageContentHeaders: false,
    sentAt
  });
}

export function agentIdentityForMessageSource(
  source: RabiMessageSource
): Omit<RabiAgentMessageSource, "type"> | undefined {
  if (source.type === "agent") {
    const { type: _type, ...identity } = source;
    return identity;
  }
  return source.type === "plan" ? source.sourceAgent : undefined;
}

function requiredSourceText(value: unknown, field: string, maxLength = 500): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${field}.`);
  if (text.length > maxLength) throw new Error(`${field} is too long.`);
  if (/[\r\n\u2028\u2029]/.test(text)) throw new Error(`${field} must be single-line.`);
  return text;
}

function optionalSourceText(value: unknown, field: string, maxLength = 500): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`${field} is too long.`);
  if (/[\r\n\u2028\u2029]/.test(text)) throw new Error(`${field} must be single-line.`);
  return text;
}

function normalizeAgentIdentity(value: unknown, field: string): Omit<RabiAgentMessageSource, "type"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing ${field}.`);
  const raw = value as Record<string, unknown>;
  const rawAdapter = requiredSourceText(raw.agentAdapter, `${field}.agentAdapter`, 40);
  const agentAdapter = parseAgentAdapterType(rawAdapter);
  if (!agentAdapter) throw new Error(`Invalid ${field}.agentAdapter.`);
  return {
    agentAdapter,
    agentType: optionalSourceText(raw.agentType, `${field}.agentType`, 80),
    sessionName: requiredSourceText(raw.sessionName, `${field}.sessionName`),
    sessionId: requiredSourceText(raw.sessionId, `${field}.sessionId`, 200),
    workspace: optionalSourceText(raw.workspace, `${field}.workspace`, 2000)
  };
}

export function normalizeRabiMessageSource(value: unknown): RabiMessageSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing messageSource.");
  const raw = value as Record<string, unknown>;
  const type = requiredSourceText(raw.type, "messageSource.type", 40);
  if (type === "agent") return { type, ...normalizeAgentIdentity(raw, "messageSource") };
  if (type === "plan") {
    return {
      type,
      planName: requiredSourceText(raw.planName, "messageSource.planName"),
      planId: requiredSourceText(raw.planId, "messageSource.planId", 300),
      sourceAgent: raw.sourceAgent == null
        ? undefined
        : normalizeAgentIdentity(raw.sourceAgent, "messageSource.sourceAgent")
    };
  }
  if (type === "message_adapter") {
    const messageAdapter = requiredSourceText(raw.messageAdapter, "messageSource.messageAdapter", 100);
    const conversationType = requiredSourceText(raw.conversationType, "messageSource.conversationType", 100);
    const conversationId = requiredSourceText(raw.conversationId, "messageSource.conversationId", 300);
    const messageId = requiredSourceText(raw.messageId, "messageSource.messageId", 300);
    const senderName = optionalSourceText(raw.senderName, "messageSource.senderName");
    const senderId = optionalSourceText(raw.senderId, "messageSource.senderId", 300);
    if (!senderName && !senderId) throw new Error("Missing messageSource.senderName or messageSource.senderId.");
    return {
      type,
      messageAdapter,
      conversationType,
      conversationName: optionalSourceText(raw.conversationName, "messageSource.conversationName"),
      conversationId,
      senderName,
      senderId,
      messageId,
      messageGroupId: optionalSourceText(raw.messageGroupId, "messageSource.messageGroupId", 300),
      routeName: optionalSourceText(raw.routeName, "messageSource.routeName"),
      routeId: optionalSourceText(raw.routeId, "messageSource.routeId", 300)
    };
  }
  if (type === "system") {
    return {
      type,
      eventType: requiredSourceText(raw.eventType, "messageSource.eventType", 100),
      eventName: requiredSourceText(raw.eventName, "messageSource.eventName"),
      eventId: requiredSourceText(raw.eventId, "messageSource.eventId", 300),
      actorType: optionalSourceText(raw.actorType, "messageSource.actorType", 100),
      actorName: optionalSourceText(raw.actorName, "messageSource.actorName"),
      actorId: optionalSourceText(raw.actorId, "messageSource.actorId", 300),
      routeName: optionalSourceText(raw.routeName, "messageSource.routeName"),
      routeId: optionalSourceText(raw.routeId, "messageSource.routeId", 300)
    };
  }
  throw new Error("Invalid messageSource.type. Expected message_adapter, agent, plan, or system.");
}
