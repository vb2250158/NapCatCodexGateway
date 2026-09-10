import {
  handleAgentReply,
  inspectAgentReplyDelivery,
  type AgentReplyOptions,
  type AgentReplyDeliveryInspection,
  type AgentReplyRequest,
  type AgentReplyResult
} from "./outbox.js";
import {
  archiveReplyImageDescriptions,
  prepareReplyImageDescriptions,
  type ReviewedReplySourceEvidence,
  type ReplyImageDescriptionArchive,
  type ReplyImageDescriptionPlan
} from "./replyImageDescriptions.js";
import { normalizeStyleValidationMode, type StyleValidationMode } from "./shared/languageStyle.js";
import type { LanguageStyleValidationResult } from "./languageStyleValidation.js";

export type AgentSendChannel =
  | "napcat"
  | "wecom"
  | "weixin"
  | "feishu"
  | "rabilink"
  | "speech"
  | "fennenote"
  | "role_panel"
  | "plan_feedback";

export type AgentSendSender = {
  agentType: string;
  sessionId: string;
};

export type AgentSendRequest = {
  deliveryId?: unknown;
  sender?: unknown;
  routeId?: unknown;
  channel?: unknown;
  params?: unknown;
  payload?: unknown;
  tracking?: unknown;
  styleValidation?: unknown;
};

export type AgentSendResult = AgentReplyResult & {
  deliveryId?: string;
  sender?: AgentSendSender;
  channel?: AgentSendChannel;
  routeId?: string;
  target?: Record<string, unknown>;
  replyImageDescriptionArchive?: ReplyImageDescriptionArchive;
  languageStyleValidation?: {
    mode: StyleValidationMode;
    bypassed: boolean;
    styleSkillUrl: string;
    result?: LanguageStyleValidationResult;
  };
};

export type AgentSendDeliveryInspection =
  | { state: "completed"; result: AgentSendResult }
  | Exclude<AgentReplyDeliveryInspection, { state: "completed" }>;

type NormalizedAgentSend = {
  deliveryId: string;
  sender: AgentSendSender;
  routeId: string;
  channel: AgentSendChannel;
  allowAdditionalReply: boolean;
  replyImageDescriptions: string[];
  target: Record<string, unknown>;
  styleValidation: StyleValidationMode;
  internal: AgentReplyRequest;
};

const SEND_CHANNELS = new Set<AgentSendChannel>([
  "napcat",
  "wecom",
  "weixin",
  "feishu",
  "rabilink",
  "speech",
  "fennenote",
  "role_panel",
  "plan_feedback"
]);

function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${field} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function objectValue(value: unknown, field: string, required = true): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!required && value == null) return {};
  throw new Error(`${field} must be an object.`);
}

function textValue(value: unknown, field: string, required = true): string | undefined {
  const text = value == null ? "" : String(value).trim();
  if (text) return text;
  if (!required) return undefined;
  throw new Error(`Missing ${field}.`);
}

function senderValue(value: unknown): AgentSendSender {
  const sender = objectValue(value, "sender");
  assertOnlyFields(sender, ["agentType", "sessionId"], "sender");
  const agentType = textValue(sender.agentType, "sender.agentType") as string;
  const sessionId = textValue(sender.sessionId, "sender.sessionId") as string;
  if (agentType.length > 80 || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(agentType)) {
    throw new Error("sender.agentType must be a stable Agent type identifier.");
  }
  if (sessionId.length > 500 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error("sender.sessionId must be a stable session identifier without control characters.");
  }
  return { agentType, sessionId };
}

function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean.`);
}

function stringList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => textValue(item, `${field}[${index}]`) as string);
}

function payloadFields(payload: Record<string, unknown>): Pick<AgentReplyRequest, "payload" | "payloadType" | "text"> {
  assertOnlyFields(payload, ["type", "text", "path", "url", "fileName"], "payload");
  const type = textValue(payload.type, "payload.type") as "text" | "image" | "voice" | "file";
  if (!(["text", "image", "voice", "file"] as string[]).includes(type)) {
    throw new Error("payload.type must be text, image, voice, or file.");
  }
  const validatedText = textValue(payload.text, "payload.text", type === "text");
  // Validation rejects empty input; message whitespace belongs to the sender.
  const text = validatedText && typeof payload.text === "string" ? payload.text : validatedText;
  const path = textValue(payload.path, "payload.path", false);
  const url = textValue(payload.url, "payload.url", false);
  if (type !== "text" && !path && !url) throw new Error(`${type} payload requires payload.path or payload.url.`);
  return {
    payloadType: type,
    text,
    payload: {
      type,
      text,
      path,
      url,
      fileName: textValue(payload.fileName, "payload.fileName", false)
    }
  };
}

function normalizeAgentSend(request: AgentSendRequest): NormalizedAgentSend {
  assertOnlyFields(request as Record<string, unknown>, ["deliveryId", "sender", "routeId", "channel", "params", "payload", "tracking", "styleValidation"], "request");
  const deliveryId = textValue(request.deliveryId, "deliveryId") as string;
  const sender = senderValue(request.sender);
  const routeId = textValue(request.routeId, "routeId") as string;
  const channel = textValue(request.channel, "channel") as AgentSendChannel;
  if (!SEND_CHANNELS.has(channel)) throw new Error(`Unsupported send channel: ${channel}.`);
  const params = objectValue(request.params, "params");
  const payload = payloadFields(objectValue(request.payload, "payload"));
  const tracking = objectValue(request.tracking, "tracking", false);
  const styleValidation = normalizeStyleValidationMode(request.styleValidation);
  assertOnlyFields(tracking, ["requirementId", "sendContextReviewToken"], "tracking");
  const requirementId = textValue(tracking.requirementId, "tracking.requirementId", false);
  const replyContext: Record<string, unknown> = requirementId
    ? { messageProcessingRequirementId: requirementId }
    : {};
  const internal: AgentReplyRequest = {
    ...payload,
    deliveryId,
    senderAgentType: sender.agentType,
    senderSessionId: sender.sessionId,
    routeProfileId: routeId,
    explicitTarget: true,
    sendChannel: channel,
    replyContext
  };
  let allowAdditionalReply = false;
  let replyImageDescriptions: string[] = [];
  let target: Record<string, unknown>;

  if (channel === "napcat") {
    assertOnlyFields(params, ["target", "groupId", "userId", "instanceId", "replyToMessageId", "replyImageDescriptions", "allowAdditionalReply"], "params");
    const targetType = textValue(params.target, "params.target") as "group" | "private";
    if (targetType !== "group" && targetType !== "private") throw new Error("params.target must be group or private for napcat.");
    const groupId = targetType === "group" ? textValue(params.groupId, "params.groupId") : undefined;
    const userId = targetType === "private" ? textValue(params.userId, "params.userId") : undefined;
    const hasReplyToMessageId = Object.prototype.hasOwnProperty.call(params, "replyToMessageId");
    if (targetType === "group" && !hasReplyToMessageId) {
      throw new Error(
        "NapCat group sends must include params.replyToMessageId. "
        + "Use the source QQ message ID whenever the message can be quoted, "
        + "or pass an empty string (\"\") for an intentional unquoted group message."
      );
    }
    if (hasReplyToMessageId && typeof params.replyToMessageId !== "string" && typeof params.replyToMessageId !== "number") {
      throw new Error("params.replyToMessageId must be a QQ message ID string/number, or an empty string for an intentional unquoted group message.");
    }
    const replyToMessageId = textValue(params.replyToMessageId, "params.replyToMessageId", false);
    replyImageDescriptions = stringList(params.replyImageDescriptions, "params.replyImageDescriptions");
    allowAdditionalReply = booleanValue(params.allowAdditionalReply, "params.allowAdditionalReply");
    if (targetType === "group" && sender.agentType === "message_processing" && !replyToMessageId) {
      throw new Error("message_processing NapCat group sends require a non-empty params.replyToMessageId so the reply stays attached to its source message.");
    }
    target = { target: targetType, groupId, userId, instanceId: textValue(params.instanceId, "params.instanceId", false), replyToMessageId };
    Object.assign(internal, {
      adapterType: "napcat",
      targetType,
      groupId,
      userId,
      instanceId: target.instanceId,
      messageId: replyToMessageId
    });
    Object.assign(replyContext, { replyToSource: Boolean(replyToMessageId) });
  } else if (channel === "wecom") {
    assertOnlyFields(params, ["chatId", "userId", "reqId"], "params");
    const chatId = textValue(params.chatId, "params.chatId") as string;
    target = { chatId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "wecom", targetType: "group", groupId: chatId, wecomChatId: chatId, userId: target.userId, wecomReqId: textValue(params.reqId, "params.reqId", false) });
  } else if (channel === "feishu") {
    assertOnlyFields(params, ["chatId", "userId"], "params");
    const chatId = textValue(params.chatId, "params.chatId") as string;
    target = { chatId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "feishu", targetType: "group", groupId: chatId, feishuChatId: chatId, userId: target.userId });
  } else if (channel === "weixin") {
    assertOnlyFields(params, ["sessionId", "userId"], "params");
    const sessionId = textValue(params.sessionId, "params.sessionId") as string;
    target = { sessionId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "weixin", targetType: "private", userId: target.userId ?? sessionId, weixinSessionId: sessionId, sessionId });
  } else if (channel === "rabilink") {
    assertOnlyFields(params, ["proactive", "sourceMessageId", "source", "targetDeviceIds", "targetDeviceKinds", "presentation", "priority"], "params");
    const proactive = booleanValue(params.proactive, "params.proactive");
    const sourceMessageId = textValue(params.sourceMessageId, "params.sourceMessageId", false);
    const targetDeviceIds = stringList(params.targetDeviceIds, "params.targetDeviceIds");
    const targetDeviceKinds = stringList(params.targetDeviceKinds, "params.targetDeviceKinds");
    if (!proactive && !sourceMessageId) throw new Error("RabiLink non-proactive sends require params.sourceMessageId.");
    if (targetDeviceIds.length === 0 && targetDeviceKinds.length === 0) {
      throw new Error("RabiLink sends require params.targetDeviceIds or params.targetDeviceKinds.");
    }
    target = { proactive, sourceMessageId, targetDeviceIds, targetDeviceKinds };
    Object.assign(internal, {
      adapterType: "rabilink",
      targetType: "rabilink",
      messageId: sourceMessageId,
      proactive,
      source: textValue(params.source, "params.source", false),
      targetDeviceIds,
      targetDeviceKinds,
      presentation: stringList(params.presentation, "params.presentation"),
      priority: textValue(params.priority, "params.priority", false)
    });
  } else if (channel === "speech") {
    assertOnlyFields(params, ["sessionId"], "params");
    const sessionId = textValue(params.sessionId, "params.sessionId", false);
    target = { sessionId };
    Object.assign(internal, { adapterType: "speech", targetType: "voice_transcript", sessionId });
    Object.assign(replyContext, { adapterType: "speech", sessionId, characterTtsDialogue: true });
  } else if (channel === "fennenote") {
    assertOnlyFields(params, ["sessionId", "mode"], "params");
    const sessionId = textValue(params.sessionId, "params.sessionId") as string;
    const mode = textValue(params.mode, "params.mode") as "message" | "playback";
    if (mode !== "message" && mode !== "playback") throw new Error("params.mode must be message or playback for fennenote.");
    target = { sessionId, mode };
    Object.assign(internal, { adapterType: "fennenote", targetType: "voice_transcript", sessionId });
    Object.assign(replyContext, { adapterType: "fennenote", sessionId, routeKind: "voice_transcript" });
    if (mode === "playback") (internal.payload as Record<string, unknown>).play = true;
  } else if (channel === "role_panel") {
    assertOnlyFields(params, ["roleId", "messageId"], "params");
    const roleId = textValue(params.roleId, "params.roleId") as string;
    target = { roleId, messageId: textValue(params.messageId, "params.messageId", false) };
    Object.assign(internal, { adapterType: "rolePanel", targetType: "role_panel", roleId, messageId: target.messageId });
    Object.assign(replyContext, { targetType: "role_panel", roleId });
  } else {
    assertOnlyFields(params, ["roleId", "planId", "stepId", "feedbackId", "kind"], "params");
    const roleId = textValue(params.roleId, "params.roleId") as string;
    const planId = textValue(params.planId, "params.planId") as string;
    const kind = textValue(params.kind, "params.kind") as "guidance" | "approval";
    if (kind !== "guidance" && kind !== "approval") throw new Error("params.kind must be guidance or approval for plan_feedback.");
    target = { roleId, planId, stepId: textValue(params.stepId, "params.stepId", false), feedbackId: textValue(params.feedbackId, "params.feedbackId", false), kind };
    Object.assign(internal, { adapterType: "planFeedback", targetType: "plan_feedback", roleId });
    Object.assign(replyContext, {
      targetType: "plan_feedback",
      roleId,
      planId,
      stepId: target.stepId,
      planFeedbackId: target.feedbackId,
      planFeedbackKind: kind
    });
  }

  return { deliveryId, sender, routeId, channel, allowAdditionalReply, replyImageDescriptions, target, styleValidation, internal };
}

export function prepareAgentSendRequest(request: AgentSendRequest): NormalizedAgentSend {
  return normalizeAgentSend(request);
}

export async function inspectAgentSendDelivery(
  request: AgentSendRequest,
  options: AgentReplyOptions
): Promise<AgentSendDeliveryInspection> {
  const normalized = normalizeAgentSend(request);
  const inspection = await inspectAgentReplyDelivery(normalized.internal, options);
  if (inspection.state !== "completed") return inspection;
  return {
    state: "completed",
    result: {
      ...inspection.result,
      deliveryId: normalized.deliveryId,
      sender: normalized.sender,
      channel: normalized.channel,
      routeId: normalized.routeId,
      target: normalized.target
    }
  };
}

function replyImageDescriptionPlan(
  normalized: NormalizedAgentSend,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): ReplyImageDescriptionPlan | undefined {
  return prepareReplyImageDescriptions({
    deliveryId: normalized.deliveryId,
    sender: normalized.sender,
    routeId: normalized.routeId,
    channel: normalized.channel,
    target: normalized.target,
    replyImageDescriptions: normalized.replyImageDescriptions
  }, options, reviewedSource);
}

export function validateAgentSendReplyImageDescriptions(
  request: AgentSendRequest,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): void {
  replyImageDescriptionPlan(normalizeAgentSend(request), options, reviewedSource);
}

export async function handleAgentSend(
  request: AgentSendRequest,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): Promise<AgentSendResult> {
  const normalized = normalizeAgentSend(request);
  const imageDescriptionPlan = replyImageDescriptionPlan(normalized, options, reviewedSource);
  const result = await handleAgentReply(normalized.internal, options);
  const replyImageDescriptionArchive = result.status === "sent" && imageDescriptionPlan
    ? archiveReplyImageDescriptions(imageDescriptionPlan, {
        rootDir: options.rootDir,
        sentMessageId: result.sentMessageId
      })
    : undefined;
  return {
    ...result,
    deliveryId: normalized.deliveryId,
    sender: normalized.sender,
    channel: normalized.channel,
    routeId: normalized.routeId,
    target: normalized.target,
    replyImageDescriptionArchive
  };
}
