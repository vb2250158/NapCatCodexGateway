import fs from "node:fs";
import path from "node:path";
import { config, type NotificationRule } from "../config.js";
import { resolvePipeline, type ResolvedPipeline } from "../pipelines.js";
import { rabiContextManager } from "../context/rabiContextManager.js";
import { buildRoleKnowledgeContextView } from "./roleKnowledgeContext.js";
import {
  personaSyncCapabilityHint,
  voiceIdentityReviewCapabilityHint,
  needsPlanAssistantHint,
  needsRemoteAgentHint
} from "./agentCapabilityHints.js";
import { toProjectRelativePath } from "../shared/projectPaths.js";
import { resolveSpeechRouteProfile } from "../shared/speechControlContract.js";
import { recentMessageLimitFor } from "../shared/gatewayConfigModel.js";
import { memoryConsolidationResultMutationLines } from "../shared/roleStorageMutationContract.js";
import { normalizeRabiMessageContent, renderRabiDelivery, renderRabiDeliveryContent, type RabiDeliveryEnvelope, type RabiMessageSource } from "../shared/rabiMessage.js";
import {
  currentPlanStep,
  getPlan,
  planApprovalGate,
  planBlockingReason,
  planIsBlocked,
  type RoleKnowledgeSnapshot
} from "../roleKnowledge.js";
import {
  messageContextArchiveIndexPath,
  messageContextArchiveDir,
  messageContextCurrentPath,
  recentMessageContextItems,
  formatMessageContextItem,
  recentMessageContextText
} from "../messageContextStore.js";
import { resolvePersonaVoiceIdentities, type PersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import { canonicalLogicalPlanId } from "../planStorageIdentity.js";
import { agentSendRequestTemplateForSource } from "../agentSendTemplate.js";
import { identityContextsForForward, identityContextLines } from "./identityContext.js";
import {
  conversationSituationForDelivery,
  conversationSituationLines,
  type ConversationSituation
} from "./conversationSituation.js";
import type { ForwardTemplateValues } from "./types.js";
import type { RouteDecision } from "./routeDecision.js";
import { messageContextScopeForForward } from "./messageContextScope.js";
import {
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isPlanFeedbackRecord,
  isFeishuRecord,
  isRolePanelRecord,
  isWeComRecord,
  isWeixinRecord,
  isVoiceTranscriptRecord
} from "./routeDecision.js";

type AgentRoleContextIdentity = {
  roleId: string;
  roleDir: string;
  rolePath: string;
};

export type AgentRoleContext = AgentRoleContextIdentity & (
  | { routeDataDir: string; personaDataDir: string; dataDir?: never }
  | { /** @deprecated Legacy fixture/config boundary. */ dataDir: string; routeDataDir?: never; personaDataDir?: never }
);

function personaDataDirFor(roleContext: AgentRoleContext): string {
  return roleContext.personaDataDir ?? roleContext.dataDir;
}

export type AgentPacket = {
  rule: NotificationRule;
  templateValues: ForwardTemplateValues;
  messageSource: RabiMessageSource;
  delivery: RabiDeliveryEnvelope;
  content: string;
  message: string;
  /** Shadow assessment persisted only after this packet enters the delivery path. */
  conversationSituation?: ConversationSituation;
};

export type BuildAgentPacketOptions = {
  /** Manager-fenced projection for an isolated Gateway/Speech child. */
  roleKnowledge?: RoleKnowledgeSnapshot;
};

type MessageCodeRecord = {
  time: number;
  rawMessage: string;
  messageId?: string | number;
  userId?: string | number;
  senderName?: string;
  botUserId?: string;
  botNickname?: string;
  source?: "history" | "outbox" | "current";
};

type MessageCodeParseResult = {
  lines: string[];
  atNames: Map<string, string>;
};

const MESSAGE_CODE_PREVIEW_LIMIT = 200;
const MESSAGE_CODE_MAX_REPLY_DEPTH = 10;

function voiceprintIdsForRecord(record: RouteDecision["record"]): string[] {
  if (!isVoiceTranscriptRecord(record)) return [];
  const candidates = [
    record.voiceprintId,
    ...(record.segments ?? []).flatMap(segment => [
      segment.voiceprintId,
      segment.speakerClusterId
    ])
  ];
  return [...new Set(candidates.map(value => String(value ?? "").trim()).filter(Boolean))];
}

function formatPersonaVoiceIdentity(voiceprintId: string, identity?: PersonaVoiceIdentity): string {
  if (!identity) return `- ${voiceprintId}：当前人格尚未确认`;
  const conflictCandidates = identity.conflictCandidates?.slice(0, 5).map(candidate => {
    const branch = [
      candidate.deleted ? "已删除" : "保留",
      candidate.participantId ? `身份=${candidate.participantId}` : "",
      candidate.displayName ? `称呼=${candidate.displayName}` : "",
      candidate.relationship ? `关系=${candidate.relationship}` : "",
      candidate.isUser == null ? "isUser=未确认" : `isUser=${candidate.isUser}`
    ].filter(Boolean).join("/");
    return `${candidate.eventId}:${branch}`;
  }).join(" | ");
  const facts = [
    identity.participantId ? `身份=${identity.participantId}` : "",
    identity.displayName ? `称呼=${identity.displayName}` : "",
    identity.relationship ? `关系=${identity.relationship}` : "",
    identity.isUser == null ? "" : `isUser=${identity.isUser}`,
    identity.aliases.length > 0 ? `别名=${identity.aliases.join("、")}` : "",
    identity.notes ? `说明=${identity.notes}` : "",
    identity.conflicted ? `并发分支待收敛=${identity.conflictFields?.join("、") || "关系资料"}` : "",
    conflictCandidates ? `候选分支=${conflictCandidates}` : ""
  ].filter(Boolean);
  return `- ${voiceprintId}：${facts.join("；") || "已记录但未填写关系说明"}`;
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function relativeWorkspacePath(filePath: string | undefined): string | undefined {
  return toProjectRelativePath(filePath, process.cwd());
}

function attachmentLines(record: RouteDecision["record"]): string[] {
  if (!("attachments" in record) || !Array.isArray(record.attachments) || record.attachments.length === 0) {
    return [];
  }
  return record.attachments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const attachment = item as { kind?: unknown; name?: unknown; path?: unknown; url?: unknown };
    const kind = String(attachment.kind || "file");
    const name = String(attachment.name || "附件").trim();
    const filePath = typeof attachment.path === "string" ? relativeWorkspacePath(attachment.path) : undefined;
    const url = typeof attachment.url === "string" ? attachment.url.trim() : "";
    return [`- ${kind}：${name}${filePath ? `｜本地路径=${filePath}` : url ? `｜地址=${url}` : ""}`];
  });
}

function currentTimeValues(now = new Date()): ForwardTemplateValues {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = pad2(now.getHours());
  const minute = pad2(now.getMinutes());
  const second = pad2(now.getSeconds());
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  return {
    now: now.toLocaleString("zh-CN", { hour12: false }),
    currentTime: now.toLocaleString("zh-CN", { hour12: false }),
    currentDate: `${year}-${month}-${day}`,
    currentClock: `${hour}:${minute}:${second}`,
    currentIsoTime: now.toISOString(),
    currentTimestamp: Math.floor(now.getTime() / 1000),
    currentYear: year,
    currentMonth: month,
    currentDay: day,
    currentWeekday: weekdays[now.getDay()],
    currentHour: hour,
    currentMinute: minute,
    currentSecond: second
  };
}
function renderTemplate(template: string, values: ForwardTemplateValues): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value == null ? match : String(value);
  });
}

function appendAgentRoleReference(message: string, rolePath: string): string {
  if (!rolePath) {
    return message;
  }

  return `${message.trimEnd()}\n\n请遵循角色文件：${rolePath} 进行回复。`;
}

function optionalLine(label: string, value: unknown): string {
  return value == null || value === "" ? "" : `${label}：${value}`;
}

function replyDeliveryLines(values: ForwardTemplateValues, forceMessagePipeline = false): string[] {
  const outputAdapter = String(values.outputAdapter ?? "");
  const routeKind = String(values.routeKind ?? "");
  const targetType = String(values.targetType ?? "");
  const sendApiUrl = String(values.sendApiUrl ?? "");
  const sendRequestJson = String(values.sendRequestJson ?? "");
  const replyContextJson = String(values.replyContextJson ?? "");
  const messageProcessingRequirementId = String(values.messageProcessingRequirementId ?? "").trim();
  const messageProcessingOutcomeUrl = messageProcessingRequirementId
    ? `${sendApiUrl.replace(/\/api\/agent\/send$/, "")}/api/message-processing/requirements/${encodeURIComponent(messageProcessingRequirementId)}/outcome`
    : "";
  const messageProcessingSendContextUrl = messageProcessingRequirementId
    ? `${sendApiUrl.replace(/\/api\/agent\/send$/, "")}/api/message-processing/requirements/${encodeURIComponent(messageProcessingRequirementId)}/send-context`
    : "";
  const replyToSource = String(values.replyToSource ?? "").toLowerCase() === "true";
  const characterTtsDialogue = outputAdapter === "tts" && routeKind === "voice_transcript";
  let planFeedbackKind = "";
  try {
    planFeedbackKind = String((JSON.parse(replyContextJson) as { planFeedbackKind?: unknown }).planFeedbackKind || "");
  } catch {
    // The replyContext JSON is rendered below and will surface the invalid payload to the handler.
  }

  if (!sendApiUrl || !sendRequestJson || !replyContextJson) {
    return [];
  }

  const isPlanFeedback = targetType === "plan_feedback";
  const isPlanGuidance = isPlanFeedback && planFeedbackKind === "guidance";
  const shouldExplainSendApi = isPlanFeedback
    || forceMessagePipeline
    || Boolean(messageProcessingRequirementId)
    || replyToSource
    || characterTtsDialogue
    || (outputAdapter === "fennenote" && routeKind === "voice_transcript")
    || routeKind === "rabilink";
  if (!shouldExplainSendApi) return [];

  const intro = isPlanGuidance
    ? [
        "读取计划与反馈，按引导推进。范围、优先级或路径变化时 PATCH 计划和后续步骤。",
        "处理说明通过明确发送 API 写入当前 planId 的 guidance_response。"
      ]
    : isPlanFeedback
    ? [
        "读取审批记录并 PATCH 计划或步骤，同轮更新 approvalRequest.responseStatus。isBlocked 由 Manager 派生。",
        "处理说明通过明确发送 API 写入当前 planId / stepId 的 approval_response。"
      ]
    : forceMessagePipeline
    ? [
        "当前路由未绑定人格。自然语言回复通过明确发送 API 投递到指定渠道和目标。"
      ]
    : routeKind === "rabilink"
      ? [
          "RabiLink 回复通过明确发送 API 投递，使用 channel=rabilink 和目标设备。"
        ]
      : characterTtsDialogue
      ? [
          "生成同义的屏幕文本和朗读文本，保持当前人格；通常使用同一句短回复。",
          "语音通过明确发送 API 投递，使用 channel=speech 和 sessionId。"
        ]
      : outputAdapter === "fennenote" && routeKind === "voice_transcript"
      ? [
          "语音回复通过明确发送 API 投递，使用 channel=fennenote、sessionId 和 mode。"
        ]
      : [
          "需要回复时，使用下面的 channel 与 params 调用明确发送 API。"
        ];

  const processingOutcomeLines = messageProcessingRequirementId
    ? [
        `需求 ID：${messageProcessingRequirementId}。GET ${messageProcessingOutcomeUrl.replace(/\/outcome$/, "")} 读取完整 knowledgeMatches。`,
        `准备关闭或回复前 POST ${messageProcessingOutcomeUrl}，提交 projectFactAssessment、knowledgeMatchDispositions 和必要的 criticalFactDisposition。`,
        "无命中时用两组同义关键词查询。no_reply 需提交 reasonCode 和具体 reason。handoff 需带 messageProcessing.requirementId。",
        `决定回复后 GET 并 POST ${messageProcessingSendContextUrl}，核对最新消息，取得 sendContextReviewToken。`,
        "发送目标或正文变化时重新审核。QQ 图片引用需逐张填写 params.replyImageDescriptions。",
        "awaiting_send、最新上下文、原渠道和渠道回执齐全后，需求才完成。"
      ]
    : [];

  return [
    ...intro,
    "使用[回传参数]中的请求；来源上下文只用于核对。",
    "仅当当前 Route 在 Codex 的 Hook 管理中开启“仅允许主人格发送消息”时，Codex 主人格发送必须填 sender.agentType=primary_persona，sender.sessionId 必须是绑定的主人格任务 ID；其它场景按模板中的实际发送方填写。",
    "NapCat 图片引用按原图填写 params.replyImageDescriptions。",
    ...processingOutcomeLines,
    isPlanFeedback
      ? "成功后简短说明计划已更新、回复已回写。"
      : characterTtsDialogue
      ? "成功后显示同一人格回复；保持安静时记录原因。"
      : "成功后简短记录投递结果；保持安静时记录原因。"
  ];
}

function directMessageModeLines(values: ForwardTemplateValues): string[] {
  return [
    "当前路由没有绑定任何人格，这是无人格直通模式。",
    "不要扮演角色，不读取或更新角色计划、记忆、技能，也不要提示需要配置人格。",
    optionalLine("输出适配器", values.outputAdapter),
    "只根据本次消息、日志路径和路由变量处理任务。",
    "需要对消息来源说出的每一句话，都通过“回传参数”里的发送 API 投递到 RabiRoute；必须使用给出的 channel 与 params，不能让系统根据来源上下文猜测目标。"
  ];
}

function section(title: string, lines: string[]): string {
  const content = lines.filter((line) => line !== "").join("\n").trim();
  return content ? `[${title}]\n${content}` : "";
}

function formatSendRequest(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return `请求参数解析失败，请核对来源：${text}`; }
}


function parseJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function messageText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateMessageCodePreview(text: string): string {
  const normalized = messageText(text);
  if (normalized.length <= MESSAGE_CODE_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, MESSAGE_CODE_PREVIEW_LIMIT)}……(更多信息调用接口查看)`;
}

function stripCqCodes(text: string): string {
  return messageText(text.replace(/\[CQ:[^\]]+\]/g, " "));
}

function cqCode(type: string, fields: Record<string, string>): string {
  const params = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `[CQ:${type}${params ? `,${params}` : ""}]`;
}

function cqParam(rawParams: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|,)${key}=([^,\\]]+)`);
  return rawParams.match(pattern)?.[1];
}

function parseReplyIds(text: string): string[] {
  return [...text.matchAll(/\[CQ:reply,([^\]]+)\]/g)]
    .map((match) => cqParam(match[1], "id"))
    .filter((value): value is string => Boolean(value));
}

function parseAtCodes(text: string): Array<{ qq: string; code: string }> {
  return [...text.matchAll(/\[CQ:at,([^\]]+)\]/g)]
    .map((match) => {
      const qq = cqParam(match[1], "qq");
      return qq ? { qq, code: cqCode("at", { qq }) } : null;
    })
    .filter((value): value is { qq: string; code: string } => Boolean(value));
}

function readMessageCodeRecords(dataDir: string): MessageCodeRecord[] {
  if (!dataDir) return [];

  const historyDirs = [...new Set([dataDir, config.memoryDataDir].filter(Boolean).map((item) => path.resolve(item)))];
  const groupMessages = historyDirs.flatMap((historyDir) => parseJsonlFile<Record<string, unknown>>(path.join(historyDir, "group-messages.jsonl")))
    .map((item) => ({
      time: Number(item.time) || 0,
      rawMessage: String(item.rawMessage ?? ""),
      messageId: item.messageId as string | number | undefined,
      userId: item.userId as string | number | undefined,
      senderName: messageText(item.senderName),
      botUserId: item.botUserId == null ? undefined : String(item.botUserId),
      botNickname: messageText(item.botNickname),
      source: "history" as const
    }));
  const privateMessages = historyDirs.flatMap((historyDir) => parseJsonlFile<Record<string, unknown>>(path.join(historyDir, "private-messages.jsonl")))
    .map((item) => ({
      time: Number(item.time) || 0,
      rawMessage: String(item.rawMessage ?? ""),
      messageId: item.messageId as string | number | undefined,
      userId: item.userId as string | number | undefined,
      senderName: messageText(item.senderName),
      botUserId: item.botUserId == null ? undefined : String(item.botUserId),
      botNickname: messageText(item.botNickname),
      source: "history" as const
    }));
  const outboxMessages = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "outbox-adapter.log.jsonl"))
    .flatMap((item) => {
      if (item.event !== "reply_sent" && item.event !== "group_file_caption_sent") return [];
      const data = item.data && typeof item.data === "object" ? item.data as Record<string, unknown> : {};
      if (data.targetType !== "group" && data.targetType !== "private") return [];
      const sentMessageId = data.sentMessageId;
      const rawMessage = String(item.message ?? "");
      if (sentMessageId == null || !rawMessage) return [];
      return [{
        time: Number(item.time) || 0,
        rawMessage,
        messageId: sentMessageId as string | number,
        source: "outbox" as const
      }];
    });

  return [...groupMessages, ...privateMessages, ...outboxMessages]
    .filter((item) => item.rawMessage || item.messageId != null)
    .sort((left, right) => left.time - right.time);
}

function messageRecordForForwardRecord(record: RouteDecision["record"]): MessageCodeRecord {
  return {
    time: record.time,
    rawMessage: record.rawMessage,
    messageId: record.messageId,
    userId: "userId" in record ? record.userId : undefined,
    senderName: record.senderName,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    botNickname: "botNickname" in record ? record.botNickname : undefined,
    source: "current"
  };
}

function messageRecordIndex(records: MessageCodeRecord[]): Map<string, MessageCodeRecord> {
  const index = new Map<string, MessageCodeRecord>();
  const priority = { outbox: 0, history: 1, current: 2 } as const;
  for (const record of records) {
    if (record.messageId == null) continue;
    const id = String(record.messageId);
    const existing = index.get(id);
    if (!existing || priority[record.source ?? "history"] >= priority[existing.source ?? "history"]) {
      index.set(id, record);
    }
  }
  return index;
}

function atNameIndex(records: MessageCodeRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    if (record.userId != null && record.senderName) {
      index.set(String(record.userId), record.senderName);
    }
    if (record.botUserId && record.botNickname) {
      index.set(record.botUserId, record.botNickname);
    }
  }
  return index;
}

function collectAtCodes(text: string, atNames: Map<string, string>, knownNames: Map<string, string>): void {
  for (const item of parseAtCodes(text)) {
    if (!atNames.has(item.qq)) {
      atNames.set(item.qq, knownNames.get(item.qq) || item.qq);
    }
  }
}

function appendReplyCodeLines(
  rawMessage: string,
  recordsById: Map<string, MessageCodeRecord>,
  knownAtNames: Map<string, string>,
  result: MessageCodeParseResult,
  visited: Set<string>,
  depth: number
): void {
  if (depth >= MESSAGE_CODE_MAX_REPLY_DEPTH) return;

  for (const replyId of parseReplyIds(rawMessage)) {
    const indent = "  ".repeat(depth);
    const code = cqCode("reply", { id: replyId });
    if (visited.has(replyId)) {
      result.lines.push(`${indent}${code} : 引用消息 ${replyId} 已在上方展开，停止循环引用。`);
      continue;
    }

    const replied = recordsById.get(replyId);
    if (!replied) {
      result.lines.push(`${indent}${code} : 引用消息 ${replyId} 暂时无法解析。`);
      continue;
    }

    visited.add(replyId);
    collectAtCodes(replied.rawMessage, result.atNames, knownAtNames);
    result.lines.push(`${indent}${code} : ${truncateMessageCodePreview(stripCqCodes(replied.rawMessage))}`);
    appendReplyCodeLines(replied.rawMessage, recordsById, knownAtNames, result, visited, depth + 1);
  }
}

function messageCodeParseText(record: RouteDecision["record"], dataDir: string): string {
  const currentRecord = messageRecordForForwardRecord(record);
  const records = [...readMessageCodeRecords(dataDir), currentRecord];
  const recordsById = messageRecordIndex(records);
  const knownAtNames = atNameIndex(records);
  const result: MessageCodeParseResult = {
    lines: [],
    atNames: new Map()
  };

  collectAtCodes(record.rawMessage, result.atNames, knownAtNames);
  appendReplyCodeLines(
    record.rawMessage,
    recordsById,
    knownAtNames,
    result,
    new Set(currentRecord.messageId == null ? [] : [String(currentRecord.messageId)]),
    0
  );

  for (const [qq, name] of result.atNames) {
    result.lines.push(`${cqCode("at", { qq })} : ${name}`);
  }

  return result.lines.join("\n");
}

function recentMessageContextForDecision(decision: RouteDecision, roleContext: AgentRoleContext): {
  endpoint?: string;
  transport?: string;
  conversationKey?: string;
  limit: number;
  text: string;
} {
  if (decision.routeKind === "plan_feedback") {
    return { limit: 0, text: "" };
  }
  const scope = messageContextScopeForForward(decision.routeKind, decision.record, {
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: decision.route.id
  });
  if (!scope?.endpoint) return { limit: 0, text: "- 暂无" };
  if (decision.routeKind === "heartbeat") {
    return {
      endpoint: scope.endpoint,
      transport: scope.record.transport,
      conversationKey: scope.record.conversationKey,
      limit: 0,
      text: ""
    };
  }
  const limit = decision.route.recentMessageLimits
    ? recentMessageLimitFor(decision.route.recentMessageLimits, scope.endpoint)
    : Math.max(0, Math.min(200, Math.floor(Number(decision.route.recentMessageLimit) || 0)));
  const excludedMessageIds = new Set<string>();
  if (decision.record.messageId != null) excludedMessageIds.add(String(decision.record.messageId));
  for (const messageId of decision.record.messageGroupMessageIds ?? []) {
    const normalized = String(messageId).trim();
    if (normalized) excludedMessageIds.add(normalized);
  }
  return {
    endpoint: scope.endpoint,
    transport: scope.record.transport,
    conversationKey: scope.record.conversationKey,
    limit,
    text: recentMessageContextText([personaDataDirFor(roleContext)], {
      limit,
      adapter: scope.endpoint,
      conversationKey: scope.record.conversationKey,
      excludedMessageIds: [...excludedMessageIds]
    })
  };
}

function compactConversationText(value: unknown): string {
  return String(value ?? "")
    .replace(/\[CQ:image\b[^\]]*\]/gi, "[图片]")
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/gi, "@$1")
    .replace(/\[CQ:reply,id=([^,\]]+)[^\]]*\]/gi, "[引用 $1]")
    .replace(/\[CQ:([^,\]]+)[^\]]*\]/gi, "[$1]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function focusedConversationContextLines(
  decision: RouteDecision,
  roleContext: AgentRoleContext,
  historyLimit: number,
  renderedRecentMessages: string
): string[] {
  const boundedHistoryLimit = Math.max(0, Math.min(12, Math.floor(historyLimit)));
  if (boundedHistoryLimit === 0) return [];
  const scope = messageContextScopeForForward(decision.routeKind, decision.record, {
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: decision.route.id
  });
  if (!scope?.endpoint || !scope.record.conversationKey) return [];
  const currentTime = Number(decision.record.time) || Number.POSITIVE_INFINITY;
  const excludedMessageIds = [
    ...(decision.record.messageGroupMessageIds ?? []),
    decision.record.messageId
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  const recent = recentMessageContextItems([personaDataDirFor(roleContext)], {
    limit: boundedHistoryLimit,
    adapter: scope.endpoint,
    conversationKey: scope.record.conversationKey,
    excludedMessageIds
  }).filter((item) => !Number.isFinite(currentTime)
    || (item.time <= currentTime && currentTime - item.time <= 5 * 60))
    .slice(-Math.min(6, boundedHistoryLimit));
  if (recent.length === 0) return [];
  return [
    "下面是当前消息之前五分钟内、最接近本轮的讨论片段。先用它确定代词、短句、纠正和追问指向；更早的“最近消息”只作补充。",
    ...recent.map((item) => {
      const direction = item.direction === "outbound" ? "本角色已发" : "群成员";
      const sender = item.sender || "未知发送者";
      const messageId = String(item.messageId || item.id || "").trim();
      const replyTo = String(item.replyToMessageId || "").trim();
      if (item.messageId != null && renderedRecentMessages.includes(formatMessageContextItem(item))) {
        return `- ${direction}｜${sender}｜messageId=${messageId}：见[最近消息]同 ID 内容。`;
      }
      return `- ${direction}｜${sender}${messageId ? `｜messageId=${messageId}` : ""}${replyTo ? `｜replyTo=${replyTo}` : ""}：${compactConversationText(item.text) || "[无文字内容]"}`;
    }),
    "如果当前短句是在纠正上一条理解，例如“动态显示的”“不是这个”“具体内容是啥”，必须修正上一条讨论对象，不得另起一个假设问题。"
  ];
}

function immediateAddressedContextLines(decision: RouteDecision, roleContext: AgentRoleContext, renderedRecentMessages: string): string[] {
  if (!("userId" in decision.record)) return [];
  const currentUserId = String(decision.record.userId ?? "").trim();
  if (!currentUserId) return [];
  const scope = messageContextScopeForForward(decision.routeKind, decision.record, {
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: decision.route.id
  });
  if (!scope?.endpoint || !scope.record.conversationKey) return [];
  const excludedMessageIds = [
    ...(decision.record.messageGroupMessageIds ?? []),
    decision.record.messageId
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const currentTime = Number(decision.record.time) || Number.POSITIVE_INFINITY;
  const recent = recentMessageContextItems([personaDataDirFor(roleContext)], {
    limit: 8,
    adapter: scope.endpoint,
    conversationKey: scope.record.conversationKey,
    to: currentTime,
    excludedMessageIds
  });
  const mentionPattern = new RegExp(`\\[CQ:at,qq=${currentUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[,\\]])`, "i");
  const addressed = recent.at(-1);
  if (!addressed || addressed.direction !== "inbound" || !mentionPattern.test(addressed.text)) return [];
  if (Number.isFinite(currentTime) && currentTime - addressed.time > 60) return [];

  const selected = [addressed];
  for (let index = recent.length - 2; index >= 0 && selected.length < 3; index -= 1) {
    const candidate = recent[index]!;
    if (candidate.direction !== "inbound" || candidate.sender !== addressed.sender) break;
    if (addressed.time - candidate.time > 30) break;
    selected.unshift(candidate);
  }
  const lines = selected.map(item => {
    const age = Number.isFinite(currentTime) ? Math.max(0, Math.round(currentTime - item.time)) : 0;
    const sender = item.sender || "未知发送者";
    if (item.messageId != null && renderedRecentMessages.includes(formatMessageContextItem(item))) {
      return `- ${age} 秒前｜${sender}｜messageId=${item.messageId}：见[最近消息]同 ID 内容。`;
    }
    return `- ${age} 秒前｜${sender}：${compactConversationText(item.text) || "[无文字内容]"}`;
  });
  return [
    "当前发言者刚被明确 @；下面是紧接当前消息之前、来自同一人的连续消息：",
    ...lines,
    "当前消息很短或含义依赖上下文时，先按这段连续对话解释短回复。不要把数字、是/否、收到、可以等短回复单独拎出来理解；只有仍有多个同等合理指向，而且不同理解会改变后续动作时，才追问。"
  ];
}

function extractPlanIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bplan-[a-zA-Z0-9_-]+\b/g)].map((match) => match[0]))];
}

function readReferencedPlanSummaries(roleDir: string, text: string): string[] {
  if (!roleDir) {
    return [];
  }

  const summaries: string[] = [];
  for (const planId of extractPlanIds(text)) {
    const parsed = getPlan(roleDir, planId);
    if (!parsed) {
      summaries.push(`- ${planId}：未找到对应计划文件。`);
      continue;
    }
    const candidates = [
      path.join(roleDir, "plans", "items", "active", `${planId}.json`),
      path.join(roleDir, "plans", "archive", `${planId}.json`),
      path.join(roleDir, "plans", "items", "archived", `${planId}.json`),
      path.join(roleDir, "plans", `${planId}.json`)
    ];
    const planPath = candidates.find((candidate) => fs.existsSync(candidate));

    try {
      const currentStep = currentPlanStep(parsed);
      const approvalGate = planApprovalGate(parsed);
      const blocked = planIsBlocked(parsed);
      const stepLines = parsed.steps.flatMap((step, index) => {
          const title = step.title.trim();
          const id = step.id.trim();
          const isCurrent = id === currentStep?.id;
          const state = step.completedAt ? "已完成" : isCurrent ? "进行中" : "";
          const currentMarker = isCurrent ? " ← 当前步骤" : "";
          const waitingFor = String(step.waitingFor || "").trim();
          const isBlocked = blocked && isCurrent;
          const blockedBy = String(step.blockedBy || "").trim();
          const approvalPreparing = approvalGate.state === "preparing" && id === approvalGate.stepId;
          const approvalPending = approvalGate.state === "pending" && id === approvalGate.stepId;
          return [
            `    ${index + 1}. ${state ? `[${state}] ` : ""}${title} (${id})${currentMarker}`,
            waitingFor ? `       等待对象：${waitingFor}` : "",
            isBlocked && blockedBy ? `       阻塞原因：${blockedBy}` : "",
            !isBlocked && blockedBy ? `       待确认说明：${blockedBy}` : "",
            approvalPending
              ? "       巡检动作：当前合同已可审批，计划保持审批阻塞；继续追问审批回执，不得续投合同外实施。"
              : approvalPreparing
                ? "       巡检动作：审批合同尚未完整，计划保持审批前分析阶段；继续调查、补证据并补齐合同，不能把资料缺失标成阻塞。"
                : isCurrent && waitingFor
                  ? "       巡检动作：主动询问、重试、改道或补证据，直到取得明确结果；不得仅记录等待。"
                  : ""
          ].filter(Boolean);
        });
      summaries.push([
        `- ${planId}`,
        optionalLine("  标题", parsed.title),
        optionalLine("  状态", parsed.status),
        optionalLine("  当前步骤 ID", parsed.currentStepId),
        optionalLine("  当前步骤", parsed.currentStep),
        optionalLine("  下一步", parsed.nextAction),
        optionalLine("  等待", parsed.waitingFor),
        blocked ? optionalLine("  阻塞原因", planBlockingReason(parsed)) : optionalLine("  待确认说明", parsed.blockedBy),
        stepLines.length > 0 ? `  全部步骤：\n${stepLines.join("\n")}` : "",
        planPath ? `  路径：${relativeWorkspacePath(planPath)}` : ""
      ].filter(Boolean).join("\n"));
    } catch (error) {
      summaries.push(`- ${planId}：读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summaries;
}

function runtimeManagerBaseUrl(): string {
  const value = process.env.GATEWAY_MANAGER_URL?.trim();
  if (!value) throw new Error("GATEWAY_MANAGER_URL was not supplied by the owning RabiRoute Manager.");
  return value.replace(/\/+$/, "");
}

function remoteAgentApiHint(values: ForwardTemplateValues): string[] {
  const baseUrl = runtimeManagerBaseUrl();
  const gatewayId = String(values.gatewayId || values.runtimeRouteId || "");
  const replyContext = String(values.replyContextJson || "{}");
  const defaultDeviceId = String(values.remoteAgentDefaultDeviceId || config.remoteAgentDefaultDeviceId || "").trim();
  const defaultCwd = String(values.remoteAgentDefaultCwd || config.remoteAgentDefaultCwd || "").trim();
  const defaultThreadName = String(values.remoteAgentDefaultThreadName || config.remoteAgentDefaultThreadName || "").trim();
  return [
    "远端 Agent 设备 API：",
    `- 查看在线远端 Agent 设备：GET ${baseUrl}/api/remote-agent/devices`,
    `- 投递远端任务：POST ${baseUrl}/api/remote-agent/tasks`,
    defaultDeviceId ? `- 当前路由默认远端设备 deviceId：${defaultDeviceId}` : "",
    defaultCwd ? `- 当前路由默认远端 cwd：${defaultCwd}` : "",
    defaultThreadName ? `- 当前路由默认远端线程：${defaultThreadName}` : "",
    "投递请求示例：",
    JSON.stringify({
      originGatewayId: gatewayId,
      deviceId: defaultDeviceId || "<从 devices 里选择；如果当前路由已设置默认设备，也可省略>",
      taskKind: "build-desktop",
      cwd: defaultCwd || "<远端工作目录，可省略使用设备默认值>",
      threadName: defaultThreadName || "<远端 Agent 线程名，可省略使用设备默认值>",
      message: "请在远端执行任务，完成后按提示回传结果。",
      filePaths: ["<可选：本机要随任务传给远端的文件路径>"],
      originReplyContext: "__replyContextJson__"
    }, null, 2).replace("\"__replyContextJson__\"", replyContext),
    "- 可选文件传输：请求体可传 filePaths、files 或 attachments；manager 会把文件内容随任务发给远端 bridge。",
    "- 远端回传文件：远端回调可以传 artifactPath、logPath 或 files，bridge 会把文件内容带回本机并保存到 data/remote-agent-files/<taskId>/。",
    "远端结果会回传到本机 RabiRoute，并投递回当前本机人格线程；远端 Agent 不应直接回复 QQ。"
  ];
}

function eventTitleForRoute(routeKind: RouteDecision["routeKind"], record?: RouteDecision["record"]): string {
  if (routeKind === "private") return "QQ 私聊消息提醒";
  if (routeKind === "group_message") return "QQ 群聊消息提醒";
  if (routeKind === "direct_at") return "QQ 群聊直接提醒";
  if (routeKind === "direct_reply") return "QQ 直接回复提醒";
  if (routeKind === "indirect_reply") return "QQ 回复链提醒";
  if (routeKind === "heartbeat") return "定时心跳提醒";
  if (routeKind === "manual_trigger") {
    const manualRecord = record && isManualTriggerRecord(record) ? record : undefined;
    return manualRecord?.triggerSource === "auto" ? "自动到点触发" : "手动触发提醒";
  }
  if (routeKind === "role_panel_message") return "角色面板消息";
  if (routeKind === "plan_feedback") return "计划反馈";
  if (routeKind === "voice_transcript") return "语音转写提醒";
  if (routeKind === "rabilink") return "RabiLink 消息";
  if (routeKind === "wearable_health_alert") return "智能手表/手环健康告警";
  if (routeKind === "wecom_message") return "企业微信群聊消息提醒";
  if (routeKind === "weixin_message") return "个人微信消息提醒";
  if (routeKind === "feishu_message") return "飞书群聊消息提醒";
  if (routeKind === "xiaomi_home_event") return "米家设备事件";
  return "RabiRoute 消息提醒";
}

function sourceRecordId(record: RouteDecision["record"]): string {
  const messageId = String(record.messageId ?? "").trim();
  if (!messageId) throw new Error("Message source requires the original message id.");
  return messageId;
}

function sourceSenderId(record: RouteDecision["record"]): string | undefined {
  if ("senderStableId" in record && record.senderStableId) return String(record.senderStableId);
  if ("senderId" in record && record.senderId) return String(record.senderId);
  if ("userId" in record && record.userId != null) return String(record.userId);
  if (isVoiceTranscriptRecord(record)) return String(record.voiceprintId || record.speakerId || "").trim() || undefined;
  return undefined;
}

function planSourceIdentity(record: RouteDecision["record"], roleDir: string): { planId: string; planName: string } {
  const replyContext = isPlanFeedbackRecord(record) && record.replyContext && typeof record.replyContext === "object"
    ? record.replyContext
    : {};
  const planId = canonicalLogicalPlanId(replyContext.planId);
  const planName = String(replyContext.planTitle || "").trim()
    || (planId ? String(getPlan(roleDir, planId)?.title || "").trim() : "");
  if (!planName) throw new Error("Plan message source requires the exact plan id and name.");
  return { planId, planName };
}

function messageSourceForDecision(decision: RouteDecision, values: ForwardTemplateValues, roleDir: string): RabiMessageSource {
  const record = decision.record;
  const route = decision.route;
  if (decision.routeKind === "plan_feedback") {
    return { type: "plan", ...planSourceIdentity(record, roleDir) };
  }
  if (decision.routeKind === "heartbeat" || decision.routeKind === "manual_trigger") {
    return {
      type: "system",
      eventType: decision.routeKind,
      eventName: eventTitleForRoute(decision.routeKind, record),
      eventId: String(values.triggerId || record.messageId || record.time),
      routeName: route.name,
      routeId: route.id
    };
  }
  const messageAdapter = String(values.recentMessageEndpoint || values.inputAdapter || ("adapterType" in record ? record.adapterType : "")).trim();
  const conversationId = String(values.recentConversationKey || values.targetId || "").trim();
  const senderName = String(values.senderName || values.sender || "").trim() || undefined;
  const senderId = sourceSenderId(record);
  if (!messageAdapter) throw new Error("Message source requires the exact message adapter.");
  if (!conversationId) throw new Error("Message source requires the exact conversation id.");
  if (!senderName && !senderId) throw new Error("Message source requires the sender name or id.");
  return {
    type: "message_adapter",
    messageAdapter,
    conversationType: String(values.targetType || decision.routeKind),
    conversationName: String(values.messageTarget || "").trim() || undefined,
    conversationId,
    senderName,
    senderId,
    messageId: sourceRecordId(record),
    messageGroupId: String(record.messageGroupId || "").trim() || undefined,
    routeName: route.name,
    routeId: route.id
  };
}

function outputPipelineForDecision(decision: RouteDecision): ResolvedPipeline {
  const record = decision.record;
  const pipeline = decision.route.resolvedPipeline ?? config.resolvedPipeline;
  if (
    decision.routeKind === "voice_transcript" &&
    isVoiceTranscriptRecord(record) &&
    (record.adapterType === "speech" || record.source === "rabispeech")
  ) {
    const speechProfile = resolveSpeechRouteProfile(
      decision.routeVariables,
      pipeline.ttsVoice || decision.route.agentRoleId || "default"
    );
    return resolvePipeline("voice_chat", {
      inputAdapter: "speech",
      ttsProvider: pipeline.ttsProvider || undefined,
      ttsVoice: speechProfile.voice,
      ttsPlay: speechProfile.autoPlay,
      preventFeedbackLoop: true,
      replyToSource: false
    });
  }
  if (
    decision.routeKind === "voice_transcript" &&
    isVoiceTranscriptRecord(record) &&
    (record.adapterType === "fennenote" || record.source === "fennenote")
  ) {
    return resolvePipeline("voice_chat", {
      inputAdapter: "fennenote",
      ttsVoice: pipeline.ttsVoice,
      ttsWorkerUrl: pipeline.outputAdapter === "fennenote" && pipeline.ttsWorkerUrl ? pipeline.ttsWorkerUrl : undefined
    });
  }
  return pipeline;
}

function templateValuesForDecision(decision: RouteDecision, roleContext: AgentRoleContext): ForwardTemplateValues {
  const record = decision.record;
  const route = decision.route;
  const isVoiceTranscript = isVoiceTranscriptRecord(record);
  const sender = isVoiceTranscript
    ? record.senderName || record.source || "voice_transcript"
    : record.senderName || ("userId" in record ? record.userId : "RabiRoute");
  const isGroup = isGroupRecord(record);
  const isHeartbeat = isHeartbeatRecord(record);
  const isManualTrigger = isManualTriggerRecord(record);
  const isRolePanel = isRolePanelRecord(record);
  const isPlanFeedback = isPlanFeedbackRecord(record);
  const isWeCom = isWeComRecord(record);
  const isFeishu = isFeishuRecord(record);
  const isWeixin = isWeixinRecord(record);
  const localReplyContext = (isRolePanel || isPlanFeedback) && record.replyContext && typeof record.replyContext === "object"
    ? record.replyContext
    : {};
  const localTargetType = typeof localReplyContext.targetType === "string" && localReplyContext.targetType.trim()
    ? localReplyContext.targetType.trim()
    : isPlanFeedback ? "plan_feedback" : "role_panel";
  const localRoleId = isPlanFeedback ? record.roleId : isRolePanel ? record.roleId : undefined;
  const planFeedbackTargetId = typeof localReplyContext.planId === "string" && localReplyContext.planId
    ? canonicalLogicalPlanId(localReplyContext.planId)
    : localRoleId ?? "plan_feedback";
  const targetId = isGroup ? record.groupId : "userId" in record ? record.userId : isVoiceTranscript ? record.source ?? "webhook" : isManualTrigger ? record.triggerId ?? "manual_trigger" : isPlanFeedback ? planFeedbackTargetId : isRolePanel ? record.roleId ?? "rolePanel" : "heartbeat";
  const wecomGroupId = isWeCom ? record.groupId ?? record.chatId ?? record.conversationId : undefined;
  const feishuChatId = isFeishu ? record.chatId : undefined;
  const targetType = isGroup || isWeCom || isFeishu ? "group" : isHeartbeat ? "heartbeat" : isManualTrigger ? "manual_trigger" : isPlanFeedback || isRolePanel ? localTargetType : isVoiceTranscript ? decision.routeKind === "rabilink" ? "rabilink" : "voice_transcript" : "private";
  const pipeline = outputPipelineForDecision(decision);
  const sendApiPath = "/api/agent/send";
  const sendApiUrl = `${runtimeManagerBaseUrl()}${sendApiPath}`;
  const personaDataDir = personaDataDirFor(roleContext);
  const dataDirPath = relativeWorkspacePath(personaDataDir);
  const roleDirPath = relativeWorkspacePath(roleContext.roleDir);
  const rolePath = relativeWorkspacePath(roleContext.rolePath);
  const groupLogPath = relativeWorkspacePath(path.join(personaDataDir, isWeCom ? "wecom-messages.jsonl" : isFeishu ? "feishu-messages.jsonl" : "group-messages.jsonl"));
  const privateLogPath = relativeWorkspacePath(path.join(personaDataDir, isWeixin ? "weixin-messages.jsonl" : "private-messages.jsonl"));
  const heartbeatLogPath = relativeWorkspacePath(path.join(personaDataDir, "heartbeat-events.jsonl"));
  const manualTriggerLogPath = relativeWorkspacePath(path.join(personaDataDir, "manual-trigger-events.jsonl"));
  const rolePanelLogPath = relativeWorkspacePath(path.join(roleContext.roleDir || personaDataDir, "role-panel", "messages.jsonl"));
  const voiceTranscriptLogPath = relativeWorkspacePath(path.join(personaDataDir, "voice-transcripts.jsonl"));
  const voiceIdentitiesPath = relativeWorkspacePath(path.join(roleContext.roleDir || personaDataDir, "voice", "voice-identities.jsonl"));
  const conversationCurrentPath = relativeWorkspacePath(messageContextCurrentPath(personaDataDir));
  const conversationArchiveDir = relativeWorkspacePath(messageContextArchiveDir(personaDataDir));
  const conversationArchiveIndexPath = relativeWorkspacePath(messageContextArchiveIndexPath(personaDataDir));
  const recentContext = recentMessageContextForDecision(decision, roleContext);
  const voiceprintIds = isVoiceTranscript ? voiceprintIdsForRecord(record) : [];
  const personaVoiceIdentities = isVoiceTranscript && roleContext.roleDir && record.sourceHostId && voiceprintIds.length > 0
    ? resolvePersonaVoiceIdentities(roleContext.roleDir, record.sourceHostId, voiceprintIds)
    : [];
  const personaVoiceIdentitySummary = personaVoiceIdentities
    .map(item => formatPersonaVoiceIdentity(item.voiceprintId, item.identity))
    .join("\n");
  const replyContext = {
    ...localReplyContext,
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: route.id,
    routeProfileName: route.name,
    routeKind: decision.routeKind,
    targetType,
    messageId: record.messageId,
    messageGroupId: record.messageGroupId,
    messageGroupMessageIds: record.messageGroupMessageIds,
    messageProcessingRequirementId: decision.extraValues?.messageProcessingRequirementId,
    groupId: isGroup ? record.groupId : wecomGroupId ?? feishuChatId,
    userId: "userId" in record ? record.userId : undefined,
    targetGroupId: config.targetGroupId || undefined,
    instanceId: "instanceId" in record ? record.instanceId : undefined,
    logicalAdapter: recentContext.endpoint,
    transport: recentContext.transport,
    conversationKey: recentContext.conversationKey,
    personaMessagingCapability: config.personaMessagingCapability || undefined,
    adapterType: isPlanFeedback ? "planFeedback" : isRolePanel ? "rolePanel" : "adapterType" in record ? record.adapterType : undefined,
    voiceprintId: isVoiceTranscript ? record.voiceprintId : undefined,
    voiceprintIds: isVoiceTranscript ? voiceprintIds : undefined,
    sessionId: isVoiceTranscript || isWeixin ? record.sessionId : undefined,
    sourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    sourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    sourceDeviceKind: isVoiceTranscript ? record.sourceDeviceKind : undefined,
    sourceStreamId: isVoiceTranscript ? record.sourceStreamId : undefined,
    sourceHostId: isVoiceTranscript ? record.sourceHostId : undefined,
    sourceHostName: isVoiceTranscript ? record.sourceHostName : undefined,
    voiceIdentitiesPath: isVoiceTranscript ? voiceIdentitiesPath : undefined,
    personaVoiceIdentities: isVoiceTranscript ? personaVoiceIdentities : undefined,
    targetDeviceIds: isVoiceTranscript && decision.routeKind === "rabilink" && record.sourceDeviceId
      ? [record.sourceDeviceId]
      : undefined,
    roleId: localRoleId,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    wecomReqId: isWeCom ? record.reqId : undefined,
    wecomConversationId: isWeCom ? record.conversationId : undefined,
    wecomChatId: isWeCom ? record.chatId : undefined,
    wecomSenderId: isWeCom ? record.senderId ?? record.userId : undefined,
    wecomMessageType: isWeCom ? record.messageType : undefined,
    feishuChatId,
    feishuMessageId: isFeishu ? record.messageId : undefined,
    weixinSessionId: isWeixin ? record.sessionId : undefined,
    weixinUserId: isWeixin ? record.userId : undefined,
    weixinMessageType: isWeixin ? record.messageType : undefined,
    dataDir: dataDirPath,
    groupLogPath,
    privateLogPath,
    sendApiUrl,
    outputAdapter: pipeline.outputAdapter,
    outputPipeline: pipeline.outputPipeline,
    characterTtsDialogue: isVoiceTranscript
      && (record.adapterType === "speech" || record.source === "rabispeech")
      && pipeline.outputAdapter === "tts",
    replyToSource: pipeline.replyToSource
  };
  return {
    ...decision.routeVariables,
    ...currentTimeValues(),
    time: formatTime(record.time),
    sender,
    senderName: record.senderName,
    userId: "userId" in record ? record.userId : undefined,
    groupId: isGroup ? record.groupId : wecomGroupId ?? feishuChatId,
    targetType,
    targetId: isWeCom ? wecomGroupId : isFeishu ? feishuChatId : targetId,
    messageTarget: isWeixin ? `个人微信会话 ${record.sessionId}` : isWeCom ? `企业微信群 ${wecomGroupId ?? "unknown"}` : isFeishu ? `飞书群 ${feishuChatId ?? "unknown"}` : isGroup ? `群 ${targetId}` : isHeartbeat ? "RabiRoute 心跳" : isManualTrigger ? `手动触发 ${targetId}` : isPlanFeedback ? `计划反馈 ${targetId}` : isRolePanel ? `角色面板 ${targetId}` : isVoiceTranscript ? decision.routeKind === "rabilink" ? `RabiLink ${targetId}` : `语音转写 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    routeText: decision.routeText,
    repliedRouteText: decision.repliedRouteText,
    messageId: record.messageId,
    botNickname: config.botNickname,
    agentRoleId: roleContext.roleId,
    recentMessageLimit: recentContext.limit,
    recentMessageEndpoint: recentContext.endpoint,
    recentConversationKey: recentContext.conversationKey,
    recentMessages: recentContext.text,
    routeProfileId: route.id,
    routeProfileName: route.name,
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    targetGroupId: config.targetGroupId,
    agentRolePath: rolePath,
    remoteAgentDefaultDeviceId: config.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: config.remoteAgentDefaultCwd,
    remoteAgentDefaultThreadName: config.remoteAgentDefaultThreadName,
    agentRoleDir: roleDirPath,
    plansDir: relativeWorkspacePath(roleContext.roleDir ? path.join(roleContext.roleDir, "plans") : undefined),
    memoryDir: relativeWorkspacePath(roleContext.roleDir ? path.join(roleContext.roleDir, "memory") : undefined),
    agentInterfaceDocPath: relativeWorkspacePath(path.join(process.cwd(), "docs", "rabi-agent-interfaces.md")),
    sendApiPath,
    sendApiUrl,
    replyContextJson: JSON.stringify(replyContext),
    sendRequestJson: JSON.stringify(agentSendRequestTemplateForSource(replyContext), null, 2),
    dataDir: dataDirPath,
    pipelinePreset: pipeline.id,
    channelPreset: pipeline.id,
    inputAdapter: pipeline.inputAdapter,
    outputAdapter: pipeline.outputAdapter,
    outputPipeline: pipeline.outputPipeline,
    promptOutputMode: pipeline.promptOutputMode,
    ttsProvider: pipeline.ttsProvider,
    ttsVoice: pipeline.ttsVoice,
    ttsWorkerUrl: pipeline.ttsWorkerUrl,
    ttsPlay: String(pipeline.ttsPlay),
    preventFeedbackLoop: String(pipeline.preventFeedbackLoop),
    replyToSource: String(pipeline.replyToSource),
    groupLogPath,
    privateLogPath,
    heartbeatLogPath,
    manualTriggerLogPath,
    rolePanelLogPath,
    voiceTranscriptLogPath,
    voiceIdentitiesPath: isVoiceTranscript ? voiceIdentitiesPath : undefined,
    voiceprintIds: voiceprintIds.join(", ") || undefined,
    personaVoiceIdentitySummary: personaVoiceIdentitySummary || undefined,
    conversationCurrentPath,
    conversationArchiveDir,
    conversationArchiveIndexPath,
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    triggerId: isManualTrigger ? record.triggerId : undefined,
    triggerName: isManualTrigger ? record.triggerName : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    speechPushMode: isVoiceTranscript ? route.speechPushMode : undefined,
    voiceSourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    voiceSourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    voiceSourceStreamId: isVoiceTranscript ? record.sourceStreamId : undefined,
    voiceSourceHostId: isVoiceTranscript ? record.sourceHostId : undefined,
    voiceSourceHostName: isVoiceTranscript ? record.sourceHostName : undefined,
    voiceprintId: isVoiceTranscript ? record.voiceprintId : undefined,
    voiceSourceArea: isVoiceTranscript ? record.sourceArea : undefined,
    voiceSessionId: isVoiceTranscript ? record.sessionId : undefined,
    voiceStartedAt: isVoiceTranscript ? record.startedAt : undefined,
    voiceEndedAt: isVoiceTranscript ? record.endedAt : undefined,
    voiceDurationSeconds: isVoiceTranscript ? record.durationSeconds : undefined,
    voicePeak: isVoiceTranscript ? record.peak : undefined,
    configurationRequested: isVoiceTranscript && record.configurationRequested ? "true" : undefined,
    wecomReqId: isWeCom ? record.reqId : undefined,
    wecomConversationId: isWeCom ? record.conversationId : undefined,
    wecomChatId: isWeCom ? record.chatId : undefined,
    wecomSenderId: isWeCom ? record.senderId ?? record.userId : undefined,
    wecomMessageType: isWeCom ? record.messageType : undefined,
    feishuChatId,
    feishuMessageId: isFeishu ? record.messageId : undefined,
    weixinSessionId: isWeixin ? record.sessionId : undefined,
    weixinUserId: isWeixin ? record.userId : undefined,
    weixinMessageType: isWeixin ? record.messageType : undefined
  };
}

function buildAgentMessage(
  decision: RouteDecision,
  values: ForwardTemplateValues,
  userTemplateText: string,
  rolePath: string,
  roleDir: string,
  dataDir: string,
  options: BuildAgentPacketOptions
): { messageSource: RabiMessageSource; delivery: RabiDeliveryEnvelope; content: string; message: string; conversationSituation?: ConversationSituation } {
  const record = decision.record;
  const routeKind = decision.routeKind;
  const shouldAttachMemoryConsolidation = routeKind === "manual_trigger" && String(values.triggerId || "") === "memory-consolidation";
  const hasPersona = Boolean(String(values.agentRoleId || "").trim() && roleDir);
  const referencedPlanSummaries = routeKind === "manual_trigger"
    ? readReferencedPlanSummaries(roleDir, userTemplateText)
    : [];
  const contextTrigger = hasPersona
    ? {
        kind: "message_delivery",
        source: "rabi_delivery",
        roleId: String(values.agentRoleId || ""),
        roleDir,
        signalText: String(values.message || ""),
        includePendingConsolidation: shouldAttachMemoryConsolidation,
        consolidationTrigger: shouldAttachMemoryConsolidation ? "manual" : undefined
      } as const
    : null;
  const contextResolution = contextTrigger
    ? options.roleKnowledge
      ? rabiContextManager.resolveProjection(contextTrigger, options.roleKnowledge)
      : rabiContextManager.resolve(contextTrigger)
    : null;
  const knowledge = contextResolution?.knowledge ?? null;
  const knowledgeAgentInterfaceDocPath = relativeWorkspacePath(knowledge?.agentInterfaceDocPath);
  const knowledgeView = knowledge
    ? buildRoleKnowledgeContextView(values.agentRoleId, {
        ...knowledge,
        agentInterfaceDocPath: knowledgeAgentInterfaceDocPath || "docs/rabi-agent-interfaces.md"
      })
    : null;
  const activePlanIndex = knowledgeView?.activePlanIndex ?? "- 暂无";
  const activeSkillIndex = knowledgeView?.activeSkillIndex ?? "- 暂无";
  const recentMemoryIndex = knowledgeView?.recentMemoryIndex ?? "- 暂无";
  const matchedIndex = knowledgeView?.matchedIndex ?? "- 暂无";
  const matchedSkillIndex = knowledgeView?.matchedSkillIndex ?? "- 暂无";
  const requiredReadIndex = knowledgeView?.requiredReadLines ?? [];
  const pendingConsolidation = knowledge?.pendingConsolidation;
  const knowledgePlansDir = relativeWorkspacePath(knowledge?.plansDir);
  const knowledgeMemoryDir = relativeWorkspacePath(knowledge?.memoryDir);
  const recentMessageLimit = Number(values.recentMessageLimit ?? 0);
  const capabilityIntentText = [
    normalizeRabiMessageContent(String(values.message || record.rawMessage || ""), true),
    userTemplateText
  ].filter(Boolean).join("\n");
  const capabilityContext = {
    managerPort: new URL(runtimeManagerBaseUrl()).port,
    roleId: String(values.agentRoleId || "").trim()
  };
  const identityObservationUrl = capabilityContext.roleId
    ? `http://127.0.0.1:${capabilityContext.managerPort}/api/roles/${encodeURIComponent(capabilityContext.roleId)}/identity-relations/observations`
    : "";
  const personaSyncHint = hasPersona ? personaSyncCapabilityHint(capabilityIntentText, capabilityContext) : null;
  const voiceIdentityReviewHint = hasPersona
    ? voiceIdentityReviewCapabilityHint(capabilityIntentText, capabilityContext)
    : null;
  const identityContexts = hasPersona
    ? identityContextsForForward(roleDir, routeKind, record, {
        gatewayId: process.env.GATEWAY_ID,
        routeProfileId: decision.route.id
      })
    : [];
  const identityContext = identityContexts.length === 1 ? identityContexts[0] : undefined;
  const identityContextSummaryLines = identityContexts.length > 0
    ? identityContexts.flatMap((context, index) => [
        ...(identityContexts.length > 1 ? [`消息端账号 ${index + 1}：`] : []),
        ...identityContextLines(context)
      ])
    : identityContextLines(undefined);
  const identityObservationHints = identityContexts.flatMap(context => {
    if (context.confirmedParticipant || context.candidateParticipants.length !== 1 || !identityObservationUrl) return [];
    return [
      `如果本组消息为账号 ${context.endpoint.platform} / ${context.endpoint.endpointIdentityNamespace} / ${context.endpoint.senderStableId} 提供了新的、可核对的身份线索，主动 POST ${identityObservationUrl}。请求必须显式携带 platform、endpointIdentityNamespace、senderStableId，以及本组 messageId、conversationKey 和简短依据；只更新候选参与者或候选关系。没有新线索时不要重复写入。这个接口不能确认身份，也不能授予项目权限。`
    ];
  });
  const situationScope = hasPersona
    ? messageContextScopeForForward(routeKind, record, {
        gatewayId: process.env.GATEWAY_ID,
        routeProfileId: decision.route.id
      })
    : undefined;
  const messageIds = [
    ...(record.messageGroupMessageIds ?? []),
    "messageId" in record ? record.messageId : undefined
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const conversationSituation = hasPersona
    ? conversationSituationForDelivery(identityContext, routeKind, record, {
        conversationId: situationScope?.record.conversationKey,
        messageIds
      })
    : undefined;
  const immediateAddressedContext = immediateAddressedContextLines(decision, {
    roleId: String(values.agentRoleId || ""),
    roleDir,
    rolePath,
    dataDir
  }, String(values.recentMessages || ""));
  const focusedConversationContext = immediateAddressedContext.length > 0 ? [] : focusedConversationContextLines(decision, {
    roleId: String(values.agentRoleId || ""),
    roleDir,
    rolePath,
    dataDir
  }, recentMessageLimit, String(values.recentMessages || ""));
  const pendingConsolidationLines = pendingConsolidation
    ? [
        `runId：${pendingConsolidation.run.id}`,
        ...memoryConsolidationResultMutationLines({
          endpoint: `/api/roles/${values.agentRoleId}/memory/consolidation-runs/${pendingConsolidation.run.id}/result`,
          runId: pendingConsolidation.run.id
        }),
        pendingConsolidation.run.instruction,
        "",
        ...pendingConsolidation.memories.map((memory) => `- ${memory.id}：${memory.title}\n  ${memory.content}`)
      ]
    : [];
  const planAssistantLines = config.codexPlanAssistantSessions.flatMap((session) => [
    `- 槽位 ${session.index}：${session.threadName}`,
    `  threadId=${session.threadId}`,
    `  workspace=${session.workspace}`
  ]);

  const messageSource = messageSourceForDecision(decision, values, roleDir);
  const contextBlocks = [
    section("事件信息", [
      `事件：${eventTitleForRoute(routeKind, record)}`,
      `路由类型：${routeKind}`,
      optionalLine("事件时间", values.time),
      optionalLine("语音处理主机", values.voiceSourceHostName || values.voiceSourceHostId),
      optionalLine("声纹 ID", values.voiceprintId),
      optionalLine("本段声纹", values.voiceprintIds),
      optionalLine("语音账号兼容数据文件", values.voiceIdentitiesPath),
      optionalLine("语音推送模式", values.speechPushMode),
      optionalLine("命中人格关键词", values.speechTriggerKeyword),
      optionalLine("触发 ID", values.triggerId),
      optionalLine("触发名称", values.triggerName)
    ]),
    recentMessageLimit > 0 ? section("最近消息", [
      `最近 ${recentMessageLimit} 条双向消息：`,
      String(values.recentMessages || "- 暂无")
    ]) : "",
    attachmentLines(record).length > 0 ? section("消息附件", attachmentLines(record)) : "",
    focusedConversationContext.length > 0 ? section("当前讨论片段", focusedConversationContext) : "",
    immediateAddressedContext.length > 0 ? section("紧邻对话", immediateAddressedContext) : "",
    routeKind === "plan_feedback" ? "" : section("消息代码解析", [messageCodeParseText(record, dataDir)]),
    values.voiceprintIds || values.voiceprintId ? section("身份定位：语音消息端账号", [
      "RabiSpeech 和主机只提供不透明声纹 ID、处理主机与判定证据，不判断这个人是谁，也不判断谁是用户。",
      "声纹与 QQ、微信账号一样进入通用身份定位：处理主机组成消息端命名空间，声纹 ID 是稳定账号 ID。多人录音会分别建立多个待认识账号。",
      "以下内容来自当前人格保存的语音分类兼容数据，不是主机推断：",
      String(values.personaVoiceIdentitySummary || "- 当前人格尚未记录这些声纹的身份说明。"),
      "PUT /api/roles/:roleId/voice-identities 只用于维护“这是我 / 其他人”等语音分类兼容信息；认识具体是谁、补充称呼和关系线索，统一使用下方通用身份观察接口。"
    ]) : "",
    hasPersona ? section("身份定位", [
      ...identityContextSummaryLines,
      identityContexts.some(context => context.candidateParticipants.length > 0)
        ? "候选身份尚未确认；显示名仅作别名线索，不授予权限。" : "",
      ...identityObservationHints,
      "身份关系独立于知识召回；确认、纠正或冲突处理前读取接口文档中的 identity-relations 合同。"
    ]) : "",
    hasPersona && conversationSituation ? section("情景记录", conversationSituationLines(conversationSituation)) : "",
    String(values.configurationRequested || "") === "true" ? section("移动端配置助手", [
      "这是用户从 Rabi 移动设备消息端明确发起的自然语言配置请求。",
      "先读取当前真实配置；写入、删除、停止、覆盖或外部动作必须经过现有动作安全门和审批。",
      "只允许调用 Rabi PC 已公开的远程 WebGUI/路由配置接口；不要索取、复述或猜测 token、密码等凭据。",
      "只有接口返回成功并复核读回结果后才能声称配置完成；不明确时先向用户追问。"
    ]) : "",
    hasPersona ? section("角色和路径", [
      optionalLine("角色", values.agentRoleId),
      optionalLine("角色文件", values.agentRolePath || rolePath),
      optionalLine("角色目录", values.agentRoleDir || roleDir),
      optionalLine("运行数据目录", values.dataDir),
      optionalLine("计划目录", knowledgePlansDir ?? values.plansDir),
      optionalLine("记忆目录", knowledgeMemoryDir ?? values.memoryDir)
    ]) : section("无人格直通模式", directMessageModeLines(values)),
    hasPersona ? section("记忆与计划", [
      optionalLine("更新记忆与计划的说明文档", knowledgeAgentInterfaceDocPath ?? values.agentInterfaceDocPath),
      ...(knowledgeView?.apiHintLines ?? []),
      "",
      ...(knowledgeView?.mode === "focused" ? [] : [
        "可用技能：",
        activeSkillIndex,
        "",
        "当前计划：",
        activePlanIndex,
        "",
        "近期记忆：",
        recentMemoryIndex,
        "",
        "命中技能：",
        matchedSkillIndex,
        "",
        "命中召回：",
        matchedIndex
      ])
    ]) : "",
    hasPersona && planAssistantLines.length > 0 && needsPlanAssistantHint(capabilityIntentText, routeKind) ? section("计划协助会话", [
      "秘书负责计划控制面，业务执行交 taskBinding 指定任务；职责见 skills/plan-task-orchestration/SKILL.md。",
      ...planAssistantLines
    ]) : "",
    hasPersona ? section("处理前上下文确认", requiredReadIndex) : "",
    personaSyncHint ? section("多电脑人格同步", personaSyncHint) : "",
    voiceIdentityReviewHint ? section("全天语音与声纹归类", voiceIdentityReviewHint) : "",
    section("日志", [
      optionalLine("群聊日志", values.groupLogPath),
      optionalLine("私聊日志", values.privateLogPath),
      optionalLine("心跳日志", values.heartbeatLogPath),
      optionalLine("手动触发日志", values.manualTriggerLogPath),
      optionalLine("角色面板记录", values.rolePanelLogPath),
      optionalLine("语音转写日志", values.voiceTranscriptLogPath),
      optionalLine("当前双向会话", values.conversationCurrentPath),
      optionalLine("历史会话归档", values.conversationArchiveDir),
      optionalLine("会话归档索引", values.conversationArchiveIndexPath)
    ]),
    config.messageEndpointTypes.includes("remoteAgent") && needsRemoteAgentHint(capabilityIntentText)
      ? section("远端 Agent 设备", remoteAgentApiHint(values))
      : "",
    pendingConsolidation ? section("待整理记忆", pendingConsolidationLines) : "",
    referencedPlanSummaries.length > 0 ? section("指定计划内容", referencedPlanSummaries) : ""
  ];

  const delivery: RabiDeliveryEnvelope = {
    messageSource,
    messageContent: [
      String(values.message || record.rawMessage || ""),
      routeKind === "manual_trigger" || routeKind === "heartbeat" ? section("事件执行要求", [
        routeKind === "manual_trigger"
          ? isManualTriggerRecord(record) && record.triggerSource === "auto"
            ? "近期记忆到达 72 小时，执行自动沉淀。"
            : "执行本次手动触发。"
          : "执行本次定时心跳。",
        "按本次事件和模板执行；无新变化时不外发，受阻时记录原因和下一步。"
      ]) : "",
      userTemplateText.trim() && userTemplateText.trim() !== String(values.message || record.rawMessage || "").trim()
        ? section("用户模板补充", [userTemplateText.trim()]) : ""
    ].filter(Boolean).join("\n\n"),
    contextBlocks: [...contextBlocks.filter(Boolean), ...(hasPersona ? [appendAgentRoleReference("", rolePath)] : [])],
    controlBlocks: [
      section("回传参数", [
        optionalLine("明确发送 API", values.sendApiUrl),
        formatSendRequest(values.sendRequestJson),
        optionalLine("来源上下文（只用于核对来源，不可直接作为发送参数）", values.replyContextJson)
      ]),
      section("发送要求", replyDeliveryLines(values, !hasPersona))
    ],
    escapeMessageContentHeaders: false
  };
  const content = renderRabiDeliveryContent(delivery);
  return {
    messageSource,
    delivery,
    content,
    message: renderRabiDelivery(delivery),
    conversationSituation
  };
}

export function buildAgentPacket(
  decision: RouteDecision,
  rule: NotificationRule,
  roleContext: AgentRoleContext,
  options: BuildAgentPacketOptions = {}
): AgentPacket {
  const templateValues = {
    ...templateValuesForDecision(decision, roleContext),
    ...decision.extraValues,
    routeKind: decision.routeKind
  };
  const userTemplateText = renderTemplate(rule.template, templateValues);
  const rolePath = relativeWorkspacePath(roleContext.rolePath) || "";
  const roleDir = relativeWorkspacePath(roleContext.roleDir) || "";

  const built = buildAgentMessage(
    decision,
    templateValues,
    userTemplateText,
    rolePath,
    roleDir,
    personaDataDirFor(roleContext),
    options
  );
  return {
    rule,
    templateValues,
    messageSource: built.messageSource,
    delivery: built.delivery,
    content: built.content,
    message: built.message,
    conversationSituation: built.conversationSituation
  };
}
