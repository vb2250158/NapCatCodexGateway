import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { appendAdapterLogToDir } from "./history.js";
import {
  deliverPacketToPrimaryAgentAdapter,
  forwardMessageAndWait,
  type ForwardAdapterOutcome,
  type ForwardDeliveryResult
} from "./forwarding.js";
import {
  appendDeliveryReplayAttempt,
  createDeliveryReplayAttemptId,
  findDeliveryReplayAttempt,
  listDeliveryReplayAttempts,
  type DeliveryReplayAttempt
} from "./deliveryReplayLedger.js";
import type { ForwardRecord, ForwardRouteKind } from "./routing/types.js";
import {
  normalizeRabiMessageContent,
  rabiMessageSourceLines,
  renderRabiDelivery,
  type RabiDeliveryEnvelope
} from "./shared/rabiMessage.js";

export type DeliveryReplayMode = "single" | "merge";

export type DeliveryReplayRequest = {
  attemptId?: string;
  attemptIds?: string[];
  routeKind?: ForwardRouteKind;
  messageId?: string;
  mode?: DeliveryReplayMode;
};

export type DeliveryReplayResult = {
  ok: boolean;
  mode: DeliveryReplayMode;
  replayedAttemptIds: string[];
  result?: ForwardDeliveryResult;
  adapterOutcomes?: ForwardAdapterOutcome[];
  error?: string;
};

export function listFailedDeliveryReplayAttempts(dataDir: string, limit = 50): DeliveryReplayAttempt[] {
  return listDeliveryReplayAttempts(dataDir, { status: "failed", limit });
}

export async function replayDeliveryAttempts(dataDir: string, request: DeliveryReplayRequest): Promise<DeliveryReplayResult> {
  const attemptIds = normalizeAttemptIds(request);
  if (attemptIds.length === 0 && request.routeKind && request.messageId) {
    return replayStoredDeliveryRecord(dataDir, request.routeKind, request.messageId);
  }
  if (attemptIds.length === 0) {
    return { ok: false, mode: request.mode ?? "single", replayedAttemptIds: [], error: "No delivery replay attempt id was provided." };
  }

  const attempts = attemptIds.map((attemptId) => {
    const attempt = findDeliveryReplayAttempt(dataDir, attemptId);
    if (!attempt) {
      throw new Error(`Delivery replay attempt not found: ${attemptId}`);
    }
    return attempt;
  });

  const mode = request.mode ?? (attempts.length > 1 ? "merge" : "single");
  return mode === "merge"
    ? replayMergedDeliveryAttempts(dataDir, attempts)
    : replaySingleDeliveryAttempt(dataDir, attempts[0]);
}

async function replayStoredDeliveryRecord(dataDir: string, routeKind: ForwardRouteKind, messageId: string): Promise<DeliveryReplayResult> {
  const record = findStoredRecord(routeKind, messageId);
  if (!record) {
    return {
      ok: false,
      mode: "single",
      replayedAttemptIds: [],
      error: `Stored ${routeKind} record not found: ${messageId}`
    };
  }

  const result = await forwardMessageAndWait(routeKind, record, {}, {
    appendRoleRecord: false,
    replayOfAttemptId: `stored:${routeKind}:${messageId}`
  });
  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: result.status === "failed" ? "error" : "info",
    message: `Delivery replay ${result.status} mode=stored routeKind=${routeKind} messageId=${messageId}`,
    data: { mode: "stored", routeKind, messageId, result }
  }, dataDir);

  return {
    ok: result.status !== "failed",
    mode: "single",
    replayedAttemptIds: [`stored:${routeKind}:${messageId}`],
    result
  };
}

function findStoredRecord(routeKind: ForwardRouteKind, messageId: string): ForwardRecord | null {
  const fileName = recordFileNameForRouteKind(routeKind);
  if (!fileName) {
    return null;
  }

  const filePath = path.join(config.memoryDataDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const records = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ForwardRecord);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (String(records[index].messageId ?? "") === messageId) {
      return records[index];
    }
  }
  return null;
}

function recordFileNameForRouteKind(routeKind: ForwardRouteKind): string | null {
  if (routeKind === "private") return "private-messages.jsonl";
  if (routeKind === "group_message" || routeKind === "direct_at" || routeKind === "direct_reply" || routeKind === "indirect_reply") return "group-messages.jsonl";
  if (routeKind === "heartbeat") return "heartbeat-events.jsonl";
  if (routeKind === "manual_trigger") return "manual-trigger-events.jsonl";
  if (routeKind === "voice_transcript") return "voice-transcripts.jsonl";
  if (routeKind === "rabilink") return "rabilink-voice-transcripts.jsonl";
  return null;
}

function normalizeAttemptIds(request: DeliveryReplayRequest): string[] {
  const raw = request.attemptIds?.length ? request.attemptIds : request.attemptId ? [request.attemptId] : [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}

async function replaySingleDeliveryAttempt(dataDir: string, attempt: DeliveryReplayAttempt): Promise<DeliveryReplayResult> {
  let result: ForwardDeliveryResult;
  try {
    result = await forwardMessageAndWait(attempt.routeKind, attempt.record, attempt.extraValues, {
      appendRoleRecord: false,
      replayOfAttemptId: attempt.attemptId
    });
  } catch (error) {
    if (!legacyReplayCanFallback(attempt, error)) throw error;
    return replayLegacySingleDeliveryAttempt(dataDir, attempt);
  }
  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: result.status === "failed" ? "error" : "info",
    message: `Delivery replay ${result.status} mode=single replayOf=${attempt.attemptId}`,
    data: { mode: "single", replayOfAttemptId: attempt.attemptId, result }
  }, dataDir);

  return {
    ok: result.status !== "failed",
    mode: "single",
    replayedAttemptIds: [attempt.attemptId],
    result
  };
}

async function replayMergedDeliveryAttempts(dataDir: string, attempts: DeliveryReplayAttempt[]): Promise<DeliveryReplayResult> {
  const packets = attempts.flatMap((attempt) => attempt.packets.map((packet) => ({ attempt, packet })));
  if (packets.length === 0) {
    return {
      ok: false,
      mode: "merge",
      replayedAttemptIds: attempts.map((attempt) => attempt.attemptId),
      error: "Selected delivery attempts do not contain replayable agent packets."
    };
  }

  const envelope = buildMergedReplayEnvelope(attempts);
  const message = renderRabiDelivery(envelope);
  const outcomes = await deliverPacketToPrimaryAgentAdapter("delivery-replay", "merged", envelope);
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  const delivered = outcomes.some((outcome) => outcome.status === "delivered");
  const status: ForwardDeliveryResult["status"] = failed ? "failed" : delivered ? "delivered" : "routed";
  const result: ForwardDeliveryResult = {
    routeKind: attempts[0].routeKind,
    messageId: attempts.map((attempt) => attempt.messageId).join(","),
    status,
    matchedRuleIds: ["merged"],
    matchedRuleCount: attempts.length,
    sentPacketCount: 1,
    adapterOutcomes: outcomes,
    routes: [{
      routeId: "delivery-replay",
      routeName: "Delivery Replay",
      status,
      matchedRuleIds: ["merged"],
      matchedRuleCount: attempts.length,
      sentPacketCount: 1,
      adapterOutcomes: outcomes
    }]
  };

  appendDeliveryReplayAttempt(dataDir, {
    attemptId: createDeliveryReplayAttemptId("manual_trigger", `merged-${Date.now()}`),
    time: Math.floor(Date.now() / 1000),
    routeKind: "manual_trigger",
    messageId: result.messageId,
    record: {
      time: Math.floor(Date.now() / 1000),
      rawMessage: envelope.messageContent,
      messageId: result.messageId,
      senderName: "RabiRoute Delivery Replay",
      triggerId: "delivery-replay",
      triggerName: "Delivery Replay"
    },
    extraValues: {},
    packets: [{
      routeId: "delivery-replay",
      ruleId: "merged",
      message,
      messageSource: envelope.messageSource,
      content: envelope.messageContent
    }],
    result,
    replayOfAttemptId: attempts.map((attempt) => attempt.attemptId).join(",")
  });

  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: failed ? "error" : "info",
    message: `Delivery replay ${status} mode=merge count=${attempts.length}`,
    data: { mode: "merge", replayOfAttemptIds: attempts.map((attempt) => attempt.attemptId), result }
  }, dataDir);

  return {
    ok: !failed,
    mode: "merge",
    replayedAttemptIds: attempts.map((attempt) => attempt.attemptId),
    result,
    adapterOutcomes: outcomes
  };
}

function buildMergedReplayEnvelope(attempts: DeliveryReplayAttempt[]): RabiDeliveryEnvelope {
  const eventId = attempts.map((attempt) => attempt.attemptId).join(",").slice(0, 300);
  const contextBlocks = attempts.flatMap((attempt, attemptIndex) => attempt.packets.map((packet, packetIndex) => {
    const sourceLines = packet.messageSource
      ? rabiMessageSourceLines(packet.messageSource, originalDeliveryTime(packet.message)).slice(1)
      : rabiMessageSourceLines({
          type: "system",
          eventType: "legacy_delivery_record",
          eventName: "历史投递记录",
          eventId: `${attempt.attemptId}:${packet.ruleId}`.slice(0, 300)
        }, originalDeliveryTime(packet.message)).slice(1);
    const content = normalizeRabiMessageContent(packet.content ?? packet.message, true);
    return [
      `[重放消息 ${attemptIndex + 1}.${packetIndex + 1}]`,
      `attemptId：${attempt.attemptId}`,
      `原投递记录时间：${new Date(attempt.time).toISOString()}`,
      `routeKind：${attempt.routeKind}`,
      `messageId：${attempt.messageId}`,
      ...sourceLines,
      ...(!packet.messageSource ? ["原消息源字段：旧记录未保存"] : []),
      "原消息内容：",
      content
    ].join("\n");
  }));
  return {
    messageSource: {
      type: "system",
      eventType: "delivery_replay",
      eventName: "失败消息合并重放",
      eventId
    },
    messageContent: `重放 ${attempts.length} 次失败投递。按原顺序处理；外发仍需通过原有发送安全门。`,
    contextBlocks
  };
}

function originalDeliveryTime(message: string): string {
  const header = message.split(/\r?\n\r?\n\[消息内容\]/)[0];
  return /^(?:投递时间|消息包发送时间)：([^\r\n]+)$/m.exec(header)?.[1] || "旧记录未保存";
}

function legacyReplayCanFallback(attempt: DeliveryReplayAttempt, error: unknown): boolean {
  if (attempt.packets.length === 0 || attempt.packets.every((packet) => packet.messageSource)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /Message source requires|Plan message source requires|Missing messageSource\.|Missing messageSource$/.test(message);
}

async function replayLegacySingleDeliveryAttempt(
  dataDir: string,
  attempt: DeliveryReplayAttempt
): Promise<DeliveryReplayResult> {
  const envelope = buildLegacySingleReplayEnvelope(attempt);
  const message = renderRabiDelivery(envelope);
  const outcomes = await deliverPacketToPrimaryAgentAdapter("delivery-replay", "legacy-single", envelope);
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  const delivered = outcomes.some((outcome) => outcome.status === "delivered");
  const status: ForwardDeliveryResult["status"] = failed ? "failed" : delivered ? "delivered" : "routed";
  const matchedRuleIds = [...new Set(attempt.packets.map((packet) => packet.ruleId))];
  const result: ForwardDeliveryResult = {
    routeKind: attempt.routeKind,
    messageId: attempt.messageId,
    status,
    matchedRuleIds,
    matchedRuleCount: matchedRuleIds.length,
    sentPacketCount: 1,
    adapterOutcomes: outcomes,
    routes: [{
      routeId: "delivery-replay",
      routeName: "Delivery Replay",
      status,
      matchedRuleIds,
      matchedRuleCount: matchedRuleIds.length,
      sentPacketCount: 1,
      adapterOutcomes: outcomes
    }]
  };

  appendDeliveryReplayAttempt(dataDir, {
    attemptId: createDeliveryReplayAttemptId(attempt.routeKind, `${attempt.messageId}-legacy`),
    time: Math.floor(Date.now() / 1000),
    routeKind: attempt.routeKind,
    messageId: attempt.messageId,
    record: attempt.record,
    extraValues: attempt.extraValues,
    packets: [{
      routeId: "delivery-replay",
      ruleId: "legacy-single",
      message,
      messageSource: envelope.messageSource,
      content: envelope.messageContent
    }],
    result,
    replayOfAttemptId: attempt.attemptId
  });

  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: failed ? "error" : "warning",
    message: `Delivery replay ${status} mode=legacy-single replayOf=${attempt.attemptId}`,
    data: { mode: "legacy-single", replayOfAttemptId: attempt.attemptId, result }
  }, dataDir);

  return {
    ok: !failed,
    mode: "single",
    replayedAttemptIds: [attempt.attemptId],
    result,
    adapterOutcomes: outcomes
  };
}

function buildLegacySingleReplayEnvelope(attempt: DeliveryReplayAttempt): RabiDeliveryEnvelope {
  const contents = attempt.packets.map((packet) => normalizeRabiMessageContent(packet.content ?? packet.message, true));
  const singlePacket = attempt.packets.length === 1;
  return {
    messageSource: {
      type: "system",
      eventType: "legacy_delivery_record",
      eventName: "历史投递记录",
      eventId: attempt.attemptId.slice(0, 300)
    },
    messageContent: singlePacket
      ? contents[0]
      : `重放 1 次历史投递记录，其中包含 ${attempt.packets.length} 条旧消息。`,
    contextBlocks: attempt.packets.map((packet, index) => [
      `[历史消息 ${index + 1}]`,
      `routeKind：${attempt.routeKind}`,
      `routeId：${packet.routeId}`,
      `ruleId：${packet.ruleId}`,
      `messageId：${attempt.messageId}`,
      "原消息源字段：旧记录未保存",
      ...(!singlePacket ? ["原消息内容：", contents[index]] : [])
    ].join("\n"))
  };
}
