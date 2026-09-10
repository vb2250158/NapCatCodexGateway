import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { sameCodexWorkspace } from "./codexTaskIdentity.js";
import { parseAgentAdapterType, type AgentAdapterType } from "./agentAdapters/types.js";
import { proactiveCommunicationPolicyLines } from "./shared/agentCommunicationPolicy.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import type { CodexReasoningEffort } from "./shared/gatewayConfigModel.js";
import type { RabiMessageSource } from "./shared/rabiMessage.js";
import type { PendingMessageGroup } from "./messageGrouping.js";
import { executeDurableDelivery } from "./manager/durableDeliveryIdempotency.js";
import {
  buildManagedMessageImageBatches,
  stageManagedMessageImages,
  type ManagedMessageImageInput
} from "./messageProcessing/managedAttachmentDelivery.js";
import type { MessageAgentReferencedSender } from "./messageProcessing/referencedAgentSender.js";

export const MESSAGE_AGENT_POOL_SCHEMA_VERSION = 2;
export const MESSAGE_AGENT_AFFINITY_SCHEMA_VERSION = 1;

export type MessageAgentAffinity = {
  groupId: string;
  endpoint: string;
  conversationKey: string;
  sender: string;
  preview?: string;
  messageIds?: string[];
  lastUsedAt: string;
};

export type MessageAgentWorker = {
  agentAdapter?: AgentAdapterType;
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  createdAt: string;
  initializedAt?: string;
  affinities: MessageAgentAffinity[];
};

export type PersistedMessageAgentWorker = Omit<MessageAgentWorker, "affinities">;

export type MessageAgentWorkerReference = Pick<MessageAgentWorker, "threadId" | "threadName" | "workspace">;

export type MessageAgentPoolState = {
  schemaVersion: 2;
  updatedAt: string;
  workers: PersistedMessageAgentWorker[];
};

export type MessageAgentAffinityState = {
  schemaVersion: 1;
  updatedAt: string;
  workers: Array<{
    threadId: string;
    affinities: MessageAgentAffinity[];
  }>;
};

export type MessageAgentPoolOptions = {
  statePath: string;
  managerBaseUrl: string;
  sourceThreadName: string;
  sourceThreadId: string;
  agentAdapter?: AgentAdapterType;
  workspace: string;
  roleId: string;
  roleDisplayName?: string;
  rolePath?: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  maxAgents?: number;
};

export type MessageAgentPoolDependencies = {
  request?: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  now?: () => Date;
};

export type MessageAgentDeliveryRouting = {
  messageSource: RabiMessageSource;
  requirementId?: string;
  referencedSenders?: MessageAgentReferencedSender[];
  imagePaths?: string[];
  imageAttachments?: ManagedMessageImageInput[];
};

export type MessageAgentPriorityContext = Pick<
  PendingMessageGroup,
  "groupId" | "endpoint" | "conversationKey" | "sender" | "replyToMessageId"
>;

export type MessageAgentSelectionRouting = Pick<MessageAgentDeliveryRouting, "referencedSenders">;

const managerResponseLimitBytes = 1024 * 1024;
const REFERENCED_AGENT_SESSION_WEIGHT = 6_000;

export function requestMessageAgentManager(
  managerBaseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<Record<string, any>> {
  const target = new URL("/api/agent/threads", `${managerBaseUrl.replace(/\/+$/, "")}/`);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error(`Unsupported Manager protocol: ${target.protocol}`));
  }
  const requestBody = JSON.stringify(payload);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseEnded = false;
    let socketClosed = false;
    let responseStatus = 0;
    let responseBody: Record<string, any> = {};

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (): void => {
      if (settled || !responseEnded || !socketClosed) return;
      settled = true;
      if (responseStatus < 200 || responseStatus >= 300 || responseBody.code === -1) {
        reject(Object.assign(new Error(String(responseBody.message || `Manager returned HTTP ${responseStatus}.`)), {
          statusCode: responseStatus,
          response: responseBody
        }));
        return;
      }
      resolve(responseBody);
    };

    const request = transport.request(target, {
      method: "POST",
      agent: false,
      headers: {
        "connection": "close",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody)
      }
    }, (response) => {
      responseStatus = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > managerResponseLimitBytes) {
          request.destroy(new Error(`Manager response exceeded ${managerResponseLimitBytes} bytes.`));
          return;
        }
        chunks.push(buffer);
      });
      response.once("aborted", () => fail(new Error("Manager response was aborted.")));
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          responseBody = text ? JSON.parse(text) as Record<string, any> : {};
        } catch {
          responseBody = {};
        }
        responseEnded = true;
        finish();
      });
    });
    request.once("error", fail);
    request.once("socket", (socket) => {
      socket.once("close", () => {
        socketClosed = true;
        finish();
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Manager request timed out after ${timeoutMs} ms.`));
    });
    request.end(requestBody);
  });
}

function workerTitle(baseTitle: string, index: number, count = index, numberSingleWorker = false): string {
  const suffix = count === 1 && !numberSingleWorker ? " 协助处理消息" : ` 协助处理消息${index}`;
  const fallback = "RabiRoute";
  const base = String(baseTitle || fallback).trim() || fallback;
  return normalizeCodexThreadTitle(`${base.slice(0, Math.max(1, codexThreadTitleMaxLength - suffix.length))}${suffix}`);
}

function roleDisplayNameFromFile(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    const content = fs.readFileSync(filePath, "utf8").slice(0, 8192);
    for (const line of content.split(/\r?\n/)) {
      const text = line.trim().replace(/^\uFEFF/, "");
      if (text.startsWith("# ")) return text.slice(2).trim();
      if (text) return "";
    }
  } catch {
    // The configured task name remains the fallback when persona metadata is unavailable.
  }
  return "";
}

function poolAgentAdapter(options: MessageAgentPoolOptions): AgentAdapterType {
  return options.agentAdapter ?? "codex";
}

function workerAgentAdapter(worker: Pick<MessageAgentWorker, "agentAdapter" | "threadId">): AgentAdapterType {
  return worker.agentAdapter ?? (worker.threadId.startsWith("session-") ? "dsh" : "codex");
}

function workerBaseTitle(options: MessageAgentPoolOptions, sourceThreadDisplayName: string): string {
  return String(sourceThreadDisplayName || options.roleDisplayName || roleDisplayNameFromFile(options.rolePath) || options.sourceThreadName).trim();
}

function normalizeWorker(value: unknown): MessageAgentWorker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const worker = value as Partial<MessageAgentWorker>;
  if (!worker.threadId || !worker.threadName || !worker.workspace) return undefined;
  return {
    agentAdapter: parseAgentAdapterType(String(worker.agentAdapter || "")) ?? "codex",
    threadId: String(worker.threadId),
    threadName: normalizeCodexThreadTitle(String(worker.threadName)),
    workspace: String(worker.workspace),
    index: Math.max(1, Math.floor(Number(worker.index) || 1)),
    createdAt: typeof worker.createdAt === "string" ? worker.createdAt : new Date(0).toISOString(),
    initializedAt: typeof worker.initializedAt === "string" && worker.initializedAt ? worker.initializedAt : undefined,
    affinities: Array.isArray(worker.affinities)
      ? worker.affinities.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const affinity = item as Partial<MessageAgentAffinity>;
          return affinity.groupId && affinity.endpoint && affinity.conversationKey
            ? [{
                groupId: String(affinity.groupId),
                endpoint: String(affinity.endpoint),
                conversationKey: String(affinity.conversationKey),
                sender: String(affinity.sender || "unknown"),
                preview: typeof affinity.preview === "string" ? affinity.preview.slice(0, 2_000) : undefined,
                messageIds: Array.isArray(affinity.messageIds)
                  ? affinity.messageIds.map(String).filter(Boolean).slice(-50)
                  : undefined,
                lastUsedAt: String(affinity.lastUsedAt || new Date(0).toISOString())
              }]
            : [];
        }).slice(-100)
      : []
  };
}

function mergeWorkersByThreadId(workers: MessageAgentWorker[]): MessageAgentWorker[] {
  const merged = new Map<string, MessageAgentWorker>();
  for (const worker of workers) {
    const current = merged.get(worker.threadId);
    if (!current) {
      merged.set(worker.threadId, structuredClone(worker));
      continue;
    }
    current.index = Math.min(current.index, worker.index);
    if ((Date.parse(worker.createdAt) || 0) < (Date.parse(current.createdAt) || 0)) {
      current.createdAt = worker.createdAt;
    }
    current.initializedAt ||= worker.initializedAt;
    const affinities = new Map<string, MessageAgentAffinity>();
    for (const affinity of [...current.affinities, ...worker.affinities]) {
      const existing = affinities.get(affinity.groupId);
      if (!existing || (Date.parse(affinity.lastUsedAt) || 0) >= (Date.parse(existing.lastUsedAt) || 0)) {
        affinities.set(affinity.groupId, affinity);
      }
    }
    current.affinities = [...affinities.values()]
      .sort((left, right) => (Date.parse(left.lastUsedAt) || 0) - (Date.parse(right.lastUsedAt) || 0))
      .slice(-100);
  }
  return [...merged.values()].sort((left, right) => left.index - right.index);
}

function readPoolState(statePath: string): { updatedAt: string; workers: MessageAgentWorker[] } {
  if (!fs.existsSync(statePath)) {
    return { updatedAt: new Date(0).toISOString(), workers: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      updatedAt?: unknown;
      workers?: unknown;
    };
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      workers: Array.isArray(parsed.workers)
        ? mergeWorkersByThreadId(parsed.workers.flatMap((worker) => normalizeWorker(worker) ?? []))
        : []
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), workers: [] };
  }
}

function messageAgentWorkerOrder(
  left: MessageAgentWorker,
  right: MessageAgentWorker,
  group?: MessageAgentPriorityContext,
  routing: MessageAgentSelectionRouting = {}
): number {
  const leftScore = group ? affinityScore(left, group, routing) : 0;
  const rightScore = group ? affinityScore(right, group, routing) : 0;
  return rightScore - leftScore
    || latestAffinityTime(right) - latestAffinityTime(left)
    || left.index - right.index
    || (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0)
    || left.threadId.localeCompare(right.threadId);
}

export function rankMessageAgentWorkers(
  workers: readonly MessageAgentWorker[],
  group?: MessageAgentPriorityContext,
  routing: MessageAgentSelectionRouting = {}
): MessageAgentWorker[] {
  return [...workers].sort((left, right) => messageAgentWorkerOrder(left, right, group, routing));
}

export function readCurrentMessageAgentWorkers(
  statePath: string,
  maxAgents?: number,
  workspace?: string
): MessageAgentWorker[] {
  const workers = readPoolState(statePath).workers
    .filter((worker) => !workspace || sameCodexWorkspace(worker.workspace, workspace));
  const affinityByThreadId = readAffinityState(affinityStatePathForPoolState(statePath));
  for (const worker of workers) mergeWorkerAffinities(worker, affinityByThreadId.get(worker.threadId) ?? []);
  const ranked = rankMessageAgentWorkers(workers);
  const normalizedLimit = Number.isFinite(maxAgents) && Number(maxAgents) > 0
    ? Math.max(1, Math.floor(Number(maxAgents)))
    : Number.POSITIVE_INFINITY;
  return ranked.slice(0, normalizedLimit);
}

export function resolveCurrentMessageAgentWorker(
  statePath: string,
  historicalWorker?: MessageAgentWorkerReference,
  maxAgents?: number,
  context?: MessageAgentPriorityContext,
  routing: MessageAgentSelectionRouting = {},
  workspace?: string
): MessageAgentWorkerReference | undefined {
  const currentWorkers = readCurrentMessageAgentWorkers(statePath, maxAgents, workspace);
  if (currentWorkers.length === 0) return undefined;
  const current = rankMessageAgentWorkers(currentWorkers, context, routing)[0];
  if (!current) return undefined;
  return {
    threadId: current.threadId,
    threadName: current.threadName,
    workspace: current.workspace
  };
}

function affinityStatePathForPoolState(statePath: string): string {
  return path.join(path.dirname(path.resolve(statePath)), "routing-affinity.json");
}

function readAffinityState(statePath: string): Map<string, MessageAgentAffinity[]> {
  const result = new Map<string, MessageAgentAffinity[]>();
  if (!fs.existsSync(statePath)) return result;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MessageAgentAffinityState>;
    if (!Array.isArray(parsed.workers)) return result;
    for (const value of parsed.workers) {
      if (!value || typeof value !== "object") continue;
      const row = value as { threadId?: unknown; affinities?: unknown };
      const threadId = String(row.threadId || "").trim();
      if (!threadId) continue;
      const normalized = normalizeWorker({
        threadId,
        threadName: threadId,
        workspace: ".",
        index: 1,
        createdAt: new Date(0).toISOString(),
        affinities: row.affinities
      });
      result.set(threadId, normalized?.affinities ?? []);
    }
  } catch {
    // Missing or interrupted affinity history only reduces routing preference;
    // it must never invent task availability or prevent exact task recovery.
  }
  return result;
}

export function replacePersistedMessageAgentWorker(
  statePath: string,
  previousThreadId: string,
  replacement: MessageAgentWorkerReference,
  now = new Date()
): boolean {
  const pool = readPoolState(statePath);
  if (!pool.workers.some((worker) => worker.threadId === previousThreadId)) return false;
  const workers = mergeWorkersByThreadId(pool.workers.map((worker) => worker.threadId === previousThreadId
    ? {
        ...worker,
        threadId: replacement.threadId,
        threadName: replacement.threadName,
        workspace: replacement.workspace,
        initializedAt: undefined
      }
    : worker));
  const updatedAt = now.toISOString();
  atomicWriteFileSync(statePath, `${JSON.stringify({
    schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION,
    updatedAt,
    workers: workers.map(({ affinities: _affinities, ...worker }) => worker)
  }, null, 2)}\n`);

  const affinityPath = affinityStatePathForPoolState(statePath);
  const affinities = readAffinityState(affinityPath);
  const previousAffinities = affinities.get(previousThreadId) ?? [];
  const replacementAffinities = affinities.get(replacement.threadId) ?? [];
  affinities.delete(previousThreadId);
  const affinityWorker: MessageAgentWorker = {
    threadId: replacement.threadId,
    threadName: replacement.threadName,
    workspace: replacement.workspace,
    index: 1,
    createdAt: new Date(0).toISOString(),
    affinities: []
  };
  mergeWorkerAffinities(affinityWorker, replacementAffinities);
  mergeWorkerAffinities(affinityWorker, previousAffinities);
  affinities.set(replacement.threadId, affinityWorker.affinities);
  atomicWriteFileSync(affinityPath, `${JSON.stringify({
    schemaVersion: MESSAGE_AGENT_AFFINITY_SCHEMA_VERSION,
    updatedAt,
    workers: [...affinities.entries()].map(([threadId, workerAffinities]) => ({
      threadId,
      affinities: workerAffinities
    }))
  }, null, 2)}\n`);
  return true;
}

function mergeWorkerAffinities(worker: MessageAgentWorker, affinities: MessageAgentAffinity[]): void {
  const merged = new Map<string, MessageAgentAffinity>();
  for (const affinity of [...worker.affinities, ...affinities]) {
    const current = merged.get(affinity.groupId);
    if (!current || (Date.parse(affinity.lastUsedAt) || 0) >= (Date.parse(current.lastUsedAt) || 0)) {
      merged.set(affinity.groupId, affinity);
    }
  }
  worker.affinities = [...merged.values()]
    .sort((left, right) => (Date.parse(left.lastUsedAt) || 0) - (Date.parse(right.lastUsedAt) || 0))
    .slice(-100);
}

function affinityScore(
  worker: MessageAgentWorker,
  group: MessageAgentPriorityContext,
  routing: MessageAgentSelectionRouting = {}
): number {
  const affinityWeight = worker.affinities.reduce((best, affinity) => {
    if (group.replyToMessageId && affinity.messageIds?.includes(group.replyToMessageId)) return Math.max(best, 5_000);
    if (affinity.groupId === group.groupId) return Math.max(best, 4_000);
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey && affinity.sender === group.sender) {
      return Math.max(best, 3_000);
    }
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey) return Math.max(best, 2_000);
    if (affinity.endpoint === group.endpoint) return Math.max(best, 1_000);
    return best;
  }, 0);
  const referencedAgentWeight = routing.referencedSenders?.some((sender) => sender.sessionId === worker.threadId)
    ? REFERENCED_AGENT_SESSION_WEIGHT
    : 0;
  return affinityWeight + referencedAgentWeight;
}

function latestAffinityTime(worker: MessageAgentWorker): number {
  return worker.affinities.reduce((latest, affinity) => Math.max(latest, Date.parse(affinity.lastUsedAt) || 0), 0);
}

function affinityForGroup(worker: MessageAgentWorker, group: MessageAgentPriorityContext): MessageAgentAffinity | undefined {
  return [...worker.affinities]
    .reverse()
    .sort((left, right) => {
      const leftScore = affinityScore({ ...worker, affinities: [left] }, group);
      const rightScore = affinityScore({ ...worker, affinities: [right] }, group);
      return rightScore - leftScore || (Date.parse(right.lastUsedAt) || 0) - (Date.parse(left.lastUsedAt) || 0);
    })[0];
}

function groupPreview(group: PendingMessageGroup): string {
  return group.items
    .map((item) => String(item.payload.record.rawMessage ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

function groupMessageIds(group: PendingMessageGroup): string[] {
  return group.items
    .map((item) => String(item.payload.record.messageId ?? "").trim())
    .filter(Boolean)
    .slice(-50);
}


type ActiveContinuationCandidate = {
  worker: MessageAgentWorker;
  affinity?: MessageAgentAffinity;
};

type MessageAgentWorkerAvailability = "active" | "idle" | "notLoaded" | "archived" | "unavailable" | "missing";

function continuationCheckPrompt(
  candidate: ActiveContinuationCandidate,
  currentWorker: MessageAgentWorker,
  managerBaseUrl: string,
  requirementId?: string
): string {
  const affinity = candidate.affinity;
  return [
    "[接续判断]",
    "判断当前消息是否接续下列任务。",
    `正在处理的任务：${candidate.worker.threadName}`,
    `正在处理的任务 ID：${candidate.worker.threadId}`,
    affinity?.groupId ? `正在处理的消息组：${affinity.groupId}` : undefined,
    affinity ? `消息端 / 会话 / 说话人：${affinity.endpoint} / ${affinity.conversationKey} / ${affinity.sender}` : undefined,
    affinity?.messageIds?.length ? `原始消息编号：${affinity.messageIds.join(", ")}` : undefined,
    affinity?.preview ? `正在处理的内容：\n${affinity.preview}` : undefined,
    `确认接续时 POST ${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads：action=send、threadId=上方任务 ID、cwd=当前工作目录、messageSource={"type":"agent","agentAdapter":"${workerAgentAdapter(currentWorker)}","sessionId":"${currentWorker.threadId}","sessionName":"当前消息处理任务名称"}、sourceThreadId=${currentWorker.threadId}、sourceAgentType=message_processing、responsePolicy=required、responseInstruction=返回处理结果和下一步${requirementId ? `、messageProcessing={"requirementId":"${requirementId}","outcome":"handoff","targetAgentType":"message_processing"}` : ""}。交接只写当前消息组 ID、消息端、会话、说话人、引用消息 ID 和新增原始消息；不得复制 [rabi:bind]、初始化、索引、角色路径或整份输入。`,
    "code=0、status=delivered、delivery.status=delivered 才算接收；delivered_tracking_failed 不重投。无法确认接续时独立处理。"
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function workerHandoffPrompt(
  worker: MessageAgentWorker,
  group: PendingMessageGroup,
  managerBaseUrl: string,
  options: MessageAgentPoolOptions,
  requirementId?: string
): string {
  const threadsApi = `${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads`;
  const criticalFactInstructions = [
    "",
    "[项目事实判断由 Agent 负责]",
    "读取原消息、回复链和附件；Manager 的召回结果只算候选。逐项提交 knowledgeMatchDispositions。",
    "无召回结果时换两组关键词查询。调查类请求先查清事实；附件必须实际查看，无法查看时取图、追问或 handoff。",
    "写计划或记忆时提交 recordType、recordId、原消息 ID 和 verifiedAt；source.evidenceReviewRequired=true 时提交 sourceEvidenceReview。",
    "回复 QQ 图片时，params.replyImageDescriptions 按原图顺序说明内容和含义。",
    "群内回复默认一至两句，只回答问题；内部调查和计划细节留在任务内。",
    "回答排期、版本、负责人或审批状态前，核对本群最新消息和已登记事实；其它项目事实也区分候选、决定和公告。",
    "关闭或回复前提交 projectFactAssessment；critical 时先记录，再提交 criticalFactDisposition。"
  ];
  const heartbeatInstructions = group.endpoint === "heartbeat"
    ? [
        "",
        "[Heartbeat 专用职责]",
        "按游标增量比对群消息、计划、问题映射和回执；证据不足时再查历史。",
        "项目事实缺失、projectFactAssessment 缺失或 criticalFactDisposition 缺失时优先处理。",
        "只做只读比对、遗漏识别、汇总和分诊。新证据交原计划 Agent；计划维护交秘书。",
        "需要决定、跨计划冲突或已有可发送正文时才交给主人格，并附消息、planId、证据和正文。",
        "没有遗漏或新进展时写：处理结果：仅更新控制面，无需外部通知。"
      ]
    : [];
  return [
    "[当前消息处理归属]",
    `消息处理任务：${worker.threadName}`,
    `消息处理任务 ID：${worker.threadId}`,
    `消息组 ID：${group.groupId}`,
    requirementId ? `消息处理需求 ID：${requirementId}` : "",
    `工作目录：${worker.workspace}`,
    `当前主人格任务：${options.sourceThreadName}`,
    `当前主人格任务 ID：${options.sourceThreadId}`,
    `向其它 Agent 投递时填写 messageSource={"type":"agent","agentAdapter":"${workerAgentAdapter(worker)}","sessionId":"${worker.threadId}","sessionName":"当前消息处理任务名称"}、sourceThreadId=${worker.threadId}、sourceAgentType=message_processing 和 responsePolicy；要求回复时填写 responseInstruction。`,
    `对方通过 POST ${threadsApi} 回复本任务，填写 inReplyToRequestId、result、nextAction 和 responsePolicy。`,
    "code=0、status=delivered、delivery.status=delivered 才表示任务已接收；delivered_tracking_failed 不得重投。",
    "收到结果后，由本任务结合最新上下文决定是否外发。",
    ...heartbeatInstructions,
    ...criticalFactInstructions,
    "",
    "[本轮可见性与结束条件]",
    "当前任务输出只供内部查看。外部消息必须取得渠道回执；待决定事项必须实际交给主人格。",
    `交给主人格时 POST ${threadsApi}，目标 threadId=${options.sourceThreadId}，messageSource={"type":"agent","agentAdapter":"${workerAgentAdapter(worker)}","sessionId":"${worker.threadId}","sessionName":"当前消息处理任务名称"}，sourceThreadId=${worker.threadId}，sourceAgentType=message_processing，responsePolicy=required${requirementId ? `，并带 messageProcessing.requirementId=${requirementId}` : ""}。只保留必要上下文，要求回传发送回执或决定。`,
    "无需外发时写“处理结果：无需对外回复”，并注明结束语、重复、自身消息或他人已完整回答。",
    "Agent 返回新结果后重新判断是否外发。"
  ].join("\n");
}

export function messageAgentInitializationPrompt(options: MessageAgentPoolOptions): string {
  return [
    `[rabi:bind ${options.roleId}]`,
    "[消息处理 Agent 初始化]",
    `主人格任务：${options.sourceThreadName}`,
    `主人格任务 ID：${options.sourceThreadId}`,
    `工作目录：${options.workspace}`,
    "",
    "你是消息处理 Agent：处理普通对话；计划增量交原计划 Agent；新计划或计划维护交秘书；关键决定、跨计划冲突和无法判断事项交主人格。",
    ...proactiveCommunicationPolicyLines("internal"),
    "明确 @、回复和私聊默认需要回应；计划操作与外部回复分开判断。",
    "Heartbeat 只做增量比对和汇总。不实施计划业务，不写 taskBinding。",
    "渠道回执证明外发；Manager 回执证明 Agent 投递。Agent 间投递填写 messageSource、sourceThreadId、sourceAgentType、responsePolicy；需要回复时补 responseInstruction。",
    "同组补充并入当前上下文；无关消息重新分配。"
  ].join("\n");
}

export class MessageAgentPool {
  private readonly workers: MessageAgentWorker[];
  private readonly affinityStatePath: string;
  private readonly request: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  private readonly now: () => Date;
  private readonly reservedWorkerIds = new Set<string>();
  private readonly initializingWorkerIds = new Set<string>();
  private allocationTail: Promise<void> = Promise.resolve();
  private workerTitlesNormalized = false;
  private sourceThreadName: string;
  private sourceThreadDisplayName = "";
  private sourceThreadDisplayNameUnavailable = false;
  private sourceThreadNameResolved = false;
  private sourceThreadAvailability: MessageAgentWorkerAvailability | undefined;
  private readonly maxAgents: number;

  constructor(private readonly options: MessageAgentPoolOptions, dependencies: MessageAgentPoolDependencies = {}) {
    const restored = readPoolState(options.statePath);
    this.affinityStatePath = affinityStatePathForPoolState(options.statePath);
    const affinityByThreadId = readAffinityState(this.affinityStatePath);
    this.maxAgents = Number.isFinite(options.maxAgents) && Number(options.maxAgents) > 0
      ? Math.max(1, Math.floor(Number(options.maxAgents)))
      : Number.POSITIVE_INFINITY;
    const restoredWorkers = restored.workers.filter((worker) =>
      worker.threadId !== options.sourceThreadId
      && workerAgentAdapter(worker) === poolAgentAdapter(options)
      && sameCodexWorkspace(worker.workspace, options.workspace)
    );
    for (const worker of restoredWorkers) mergeWorkerAffinities(worker, affinityByThreadId.get(worker.threadId) ?? []);
    const rankedWorkers = rankMessageAgentWorkers(restoredWorkers);
    this.workers = rankedWorkers.slice(0, this.maxAgents);
    if (this.workers.length === 1 && restoredWorkers.length > 1) {
      for (const detached of rankedWorkers.slice(1)) mergeWorkerAffinities(this.workers[0], detached.affinities);
      this.workers[0].index = 1;
    }
    this.now = dependencies.now ?? (() => new Date());
    this.request = dependencies.request ?? ((payload) => this.managerRequest(payload));
    this.sourceThreadName = options.sourceThreadName;
    // Persist the normalized state once so duplicate rows left by an older
    // concurrent allocator are repaired as soon as the Route starts.
    this.persist();
  }

  async deliver(
    group: PendingMessageGroup,
    prompt: string,
    routing: MessageAgentDeliveryRouting
  ): Promise<MessageAgentWorker> {
    if (!routing?.messageSource) throw new Error("Message Agent delivery requires messageSource.");
    const messageSource = routing.messageSource;
    const allocation = await this.withAllocationLock(async () => {
      await this.ensureSourceThreadName();
      await this.ensureWorkerTitles();
      const selection = await this.selectWorker(group, routing);
      const worker = selection.worker;
      if (selection.replaceArchived) await this.replaceArchivedWorker(worker);
      const currentOptions = { ...this.options, sourceThreadName: this.sourceThreadName };
      const shouldInitialize = !worker.initializedAt && !this.initializingWorkerIds.has(worker.threadId);
      if (shouldInitialize) this.initializingWorkerIds.add(worker.threadId);
      this.reservedWorkerIds.add(worker.threadId);
      this.remember(worker, group);
      this.persist();
      return {
        worker,
        shouldInitialize,
        prompt,
        controlBlocks: [
          ...(shouldInitialize ? [messageAgentInitializationPrompt(currentOptions)] : []),
          workerHandoffPrompt(worker, group, this.options.managerBaseUrl, currentOptions, routing.requirementId),
          ...(selection.activeCandidate
            ? [continuationCheckPrompt(selection.activeCandidate, worker, this.options.managerBaseUrl, routing.requirementId)]
            : [])
        ]
      };
    });
    try {
      const staged = routing.requirementId && routing.imageAttachments
        ? stageManagedMessageImages({
            workspace: allocation.worker.workspace,
            requirementId: routing.requirementId,
            attachments: routing.imageAttachments
          })
        : {
            ready: (routing.imagePaths || []).map((imagePath, index) => ({
              id: `legacy-image-${index + 1}`,
              path: imagePath,
              contentHash: imagePath
            })),
            unavailable: []
          };
      const unavailableContext = staged.unavailable.length
        ? `[不可用图片附件]\n${staged.unavailable.map((item) => `${item.id}：${item.error}`).join("\n")}\n需要查看图片才能判断时，等待附件恢复或交接，不得推断内容。`
        : undefined;
      const batches = buildManagedMessageImageBatches({
        requirementId: routing.requirementId || `${group.groupId}:${allocation.worker.threadId}`,
        prompt: allocation.prompt,
        images: staged.ready
      });
      for (const [batchIndex, batch] of batches.entries()) {
        const firstBatch = batchIndex === 0;
        const deliveryContextBlocks = firstBatch && unavailableContext ? [unavailableContext] : undefined;
        const deliveryControlBlocks = firstBatch ? allocation.controlBlocks : undefined;
        if (!routing.requirementId) {
          const response = await this.request({
            action: "send",
            agentAdapter: workerAgentAdapter(allocation.worker),
            threadId: allocation.worker.threadId,
            title: allocation.worker.threadName,
            createIfMissing: true,
            cwd: allocation.worker.workspace,
            messageSource,
            contextBlocks: deliveryContextBlocks,
            controlBlocks: deliveryControlBlocks,
            sandbox: "workspace-write",
            prompt: batch.prompt,
            model: this.options.model,
            reasoningEffort: this.options.reasoningEffort,
            imagePaths: batch.imagePaths
          });
          this.adoptResolvedWorker(allocation.worker, response);
          continue;
        }
        const outcome = await executeDurableDelivery({
          rootDir: path.dirname(path.resolve(this.options.statePath)),
          namespace: "message-requirement-delivery",
          deliveryId: batch.deliveryId,
          payload: {
            threadId: allocation.worker.threadId,
            requirementId: routing.requirementId,
            batchIndex: batch.batchIndex,
            batchCount: batch.batchCount,
            imagePaths: batch.imagePaths
          },
          deliver: () => this.request({
            action: "send",
            agentAdapter: workerAgentAdapter(allocation.worker),
            threadId: allocation.worker.threadId,
            title: allocation.worker.threadName,
            createIfMissing: true,
            cwd: allocation.worker.workspace,
            messageSource,
            contextBlocks: deliveryContextBlocks,
            controlBlocks: deliveryControlBlocks,
            sandbox: "workspace-write",
            prompt: batch.prompt,
            model: this.options.model,
            reasoningEffort: this.options.reasoningEffort,
            imagePaths: batch.imagePaths,
            messageDelivery: {
              requirementId: routing.requirementId,
              deliveryId: batch.deliveryId,
              batchIndex: batch.batchIndex,
              batchCount: batch.batchCount
            }
          }),
          recover: async (error) => {
            if (!/timeout|timed out|aborted|connection closed|EPIPE/i.test(error instanceof Error ? error.message : String(error))) throw error;
            const readback = await this.request({ action: "read", agentAdapter: workerAgentAdapter(allocation.worker), threadId: allocation.worker.threadId, deliveryId: batch.deliveryId });
            const state = String(readback.delivery?.state || "uncertain");
            if (state === "accepted" || state === "completed") return { state: "completed", result: readback };
            if (state === "missing") return { state: "retry" };
            if (state === "in_progress") return { state: "in_progress", reason: "The target task is still processing this delivery." };
            return { state: "uncertain", reason: "The target task could not authoritatively confirm this delivery; do not resend automatically." };
          }
        });
        if (outcome.state !== "completed") throw new Error(outcome.reason);
        this.adoptResolvedWorker(allocation.worker, outcome.result as Record<string, any> | undefined);
      }
      if (allocation.shouldInitialize) allocation.worker.initializedAt = this.now().toISOString();
      this.persist();
      return structuredClone(allocation.worker);
    } finally {
      this.reservedWorkerIds.delete(allocation.worker.threadId);
      if (allocation.shouldInitialize) this.initializingWorkerIds.delete(allocation.worker.threadId);
    }
  }

  snapshot(): MessageAgentPoolState {
    return {
      schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      workers: this.workers.map(({ affinities: _affinities, ...worker }) => structuredClone(worker))
    };
  }

  affinitySnapshot(): MessageAgentAffinityState {
    return {
      schemaVersion: MESSAGE_AGENT_AFFINITY_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      workers: this.workers.map((worker) => ({
        threadId: worker.threadId,
        affinities: structuredClone(worker.affinities)
      }))
    };
  }

  private async selectWorker(group: PendingMessageGroup, routing: MessageAgentDeliveryRouting): Promise<{
    worker: MessageAgentWorker;
    activeCandidate?: ActiveContinuationCandidate;
    replaceArchived?: boolean;
  }> {
    const ranked = rankMessageAgentWorkers(this.workers, group, routing)
      .map((worker) => ({ worker, score: affinityScore(worker, group, routing) }))
      .filter((candidate) => candidate.score > 0)
      .filter((candidate) => Boolean(candidate.worker));
    // Heartbeat is one continuing control-plane responsibility, not a new
    // conversation every time the timer fires. Always steer the next tick to
    // the most familiar heartbeat worker, even while its current turn is
    // active, so a stale busy signal can never grow one task per schedule.
    if (group.endpoint === "heartbeat" && ranked[0]) {
      return { worker: ranked[0].worker };
    }
    const availability = await this.readWorkerAvailability(this.workers);
    for (const candidate of ranked) {
      if (candidate.score >= 4_000) return { worker: candidate.worker };
      if (availability.get(candidate.worker.threadId) === "idle") return { worker: candidate.worker };
    }
    const activeCandidateRow = ranked.find((candidate) => availability.get(candidate.worker.threadId) === "active");
    const activeCandidate = activeCandidateRow
      ? { worker: activeCandidateRow.worker, affinity: affinityForGroup(activeCandidateRow.worker, group) }
      : undefined;
    const idleFallbacks = rankMessageAgentWorkers(this.workers, group, routing);
    for (const worker of idleFallbacks) {
      if (availability.get(worker.threadId) === "idle") return { worker, activeCandidate };
    }

    // A session that is not currently loaded is still an existing Agent session. It
    // can be loaded by the normal owner delivery path, so reusing it is
    // safer than creating another task from an uncertain availability signal.
    for (const candidate of ranked) {
      if (availability.get(candidate.worker.threadId) === "notLoaded") return { worker: candidate.worker };
    }
    for (const worker of idleFallbacks) {
      if (availability.get(worker.threadId) === "notLoaded") return { worker, activeCandidate };
    }
    for (const worker of idleFallbacks) {
      if (availability.get(worker.threadId) === "archived") {
        return { worker, activeCandidate, replaceArchived: true };
      }
    }

    if (this.workers.length >= this.maxAgents && this.workers.length > 0) {
      const cappedWorker = ranked[0]?.worker ?? idleFallbacks[0] ?? this.workers[0];
      return {
        worker: cappedWorker,
        activeCandidate: activeCandidate?.worker.threadId === cappedWorker.threadId ? undefined : activeCandidate
      };
    }

    const desktopAvailable = await this.desktopAvailableForCreation(availability);
    if (!desktopAvailable) {
      throw new Error("目标 Agent 端当前不可用，消息组已保留等待恢复；RabiRoute 不会依据本地状态新建消息处理会话。");
    }
    return { worker: await this.createWorker(), activeCandidate };
  }

  private async ensureSourceThreadName(): Promise<void> {
    if (this.sourceThreadNameResolved) return;
    const agentAdapter = poolAgentAdapter(this.options);
    try {
      const response = await this.request({ action: "read", agentAdapter, threadId: this.options.sourceThreadId });
      this.sourceThreadAvailability = this.availabilityFromResponse(response);
      const thread = response.thread && typeof response.thread === "object" ? response.thread : {};
      const returnedThreadId = String(thread.id || "").trim();
      const readMatchesSource = !returnedThreadId || returnedThreadId === this.options.sourceThreadId;
      const hasDisplayedNameField = readMatchesSource && (Object.prototype.hasOwnProperty.call(thread, "name")
        || Object.prototype.hasOwnProperty.call(thread, "title"));
      const displayName = readMatchesSource ? String(thread.name || thread.title || "").trim() : "";
      if (displayName && !displayName.includes("\n")) {
        this.sourceThreadDisplayName = displayName;
        this.sourceThreadName = displayName;
      } else if (agentAdapter === "codex" && hasDisplayedNameField) {
        this.sourceThreadDisplayNameUnavailable = true;
      }
    } catch {
      // Keep the saved Route display name when the owner read itself is unavailable.
      this.sourceThreadAvailability = "unavailable";
    } finally {
      this.sourceThreadNameResolved = true;
    }
  }

  private async withAllocationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail;
    let release = (): void => undefined;
    this.allocationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async createWorker(): Promise<MessageAgentWorker> {
    if (this.sourceThreadDisplayNameUnavailable) {
      throw new Error(`Codex Desktop sidebar Name is unavailable for the Primary Persona task: ${this.options.sourceThreadId}`);
    }
    if (this.workers.length >= this.maxAgents) {
      throw new Error(`Message Agent pool reached its configured limit of ${this.maxAgents}.`);
    }
    const index = this.workers.reduce((maximum, worker) => Math.max(maximum, worker.index), 0) + 1;
    const baseTitle = workerBaseTitle(this.options, this.sourceThreadDisplayName);
    if (this.workers.length === 1 && index === 2) {
      const first = this.workers[0];
      const firstTitle = workerTitle(baseTitle, 1, 2);
      await this.request({
        action: "rename",
        agentAdapter: workerAgentAdapter(first),
        threadId: first.threadId,
        title: firstTitle,
        cwd: first.workspace
      });
      first.threadName = firstTitle;
      this.persist();
    }
    const title = workerTitle(baseTitle, index, Math.max(1, this.workers.length + 1), this.maxAgents === 1);
    const response = await this.request({
      action: "resolve",
      agentAdapter: poolAgentAdapter(this.options),
      title,
      cwd: this.options.workspace,
      createIfMissing: true,
      lookupMode: "state_db"
    });
    const thread = response.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
    if (!thread?.id) throw new Error(`Message Agent task resolution did not return a task id for ${title}.`);
    if (String(thread.id) === this.options.sourceThreadId) {
      throw new Error("Message Agent task resolution returned the Primary Persona task id; refusing role crossover.");
    }
    const workspace = String(thread.cwd || this.options.workspace);
    this.assertWorkerWorkspace(workspace);
    const worker: MessageAgentWorker = {
      agentAdapter: poolAgentAdapter(this.options),
      threadId: String(thread.id),
      threadName: String(thread.title || title),
      workspace,
      index,
      createdAt: this.now().toISOString(),
      affinities: []
    };
    this.workers.push(worker);
    this.persist();
    return worker;
  }

  private async ensureWorkerTitles(): Promise<void> {
    if (this.workerTitlesNormalized) return;
    if (this.sourceThreadDisplayNameUnavailable) {
      throw new Error(`Codex Desktop sidebar Name is unavailable for the Primary Persona task: ${this.options.sourceThreadId}`);
    }
    const count = this.workers.length;
    const baseTitle = workerBaseTitle(this.options, this.sourceThreadDisplayName);
    let changed = false;
    let allNormalized = true;
    for (const worker of this.workers) {
      const title = workerTitle(baseTitle, worker.index, count, this.maxAgents === 1);
      if (worker.threadName === title) continue;
      try {
        await this.request({
          action: "rename",
          agentAdapter: workerAgentAdapter(worker),
          threadId: worker.threadId,
          title,
          cwd: worker.workspace
        });
        worker.threadName = title;
        changed = true;
      } catch {
        allNormalized = false;
      }
    }
    if (changed) this.persist();
    this.workerTitlesNormalized = allNormalized;
  }

  private async readWorkerAvailability(workers: MessageAgentWorker[]): Promise<Map<string, MessageAgentWorkerAvailability>> {
    const rows = await Promise.all(workers.map(async (worker) => {
      if (this.reservedWorkerIds.has(worker.threadId)) {
        return [worker.threadId, "active"] as const;
      }
      try {
        const response = await this.request({ action: "read", agentAdapter: workerAgentAdapter(worker), threadId: worker.threadId });
        return [worker.threadId, this.availabilityFromResponse(response)] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
        return [worker.threadId, message.includes("not found") ? "missing" : "unavailable"] as const;
      }
    }));
    return new Map(rows);
  }

  private async desktopAvailableForCreation(
    availability: Map<string, MessageAgentWorkerAvailability>
  ): Promise<boolean> {
    if ([...availability.values()].some((status) => status === "active" || status === "idle" || status === "notLoaded")) {
      return true;
    }
    return this.sourceThreadAvailability === "active"
      || this.sourceThreadAvailability === "idle"
      || this.sourceThreadAvailability === "notLoaded";
  }

  private availabilityFromResponse(response: Record<string, any>): MessageAgentWorkerAvailability {
    if (response.thread?.archived === true) return "archived";
    const type = String(response.thread?.status?.type || "").trim();
    if (type === "active" || type === "idle" || type === "notLoaded" || type === "unavailable") return type;
    // Compatibility with an older Manager during a rolling restart. The new
    // Manager always returns status.type; this boolean is never persisted.
    if (response.thread?.active === true) return "active";
    if (response.thread?.active === false) return "idle";
    return "unavailable";
  }

  private async replaceArchivedWorker(worker: MessageAgentWorker): Promise<void> {
    const response = await this.request({
      action: "resolve",
      agentAdapter: workerAgentAdapter(worker),
      threadId: worker.threadId,
      title: worker.threadName,
      cwd: this.options.workspace,
      createIfMissing: true,
      lookupMode: "state_db"
    });
    if (!this.adoptResolvedWorker(worker, response)) {
      throw new Error(`Archived Message Agent task did not return a replacement task: ${worker.threadName}`);
    }
  }

  private adoptResolvedWorker(worker: MessageAgentWorker, response?: Record<string, any>): boolean {
    const thread = response?.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
    const nextThreadId = String(thread?.id || response?.threadId || "").trim();
    if (!nextThreadId) return false;
    if (nextThreadId === this.options.sourceThreadId) {
      throw new Error("Message Agent task resolution returned the Primary Persona task id; refusing role crossover.");
    }
    const workspace = String(thread?.cwd || worker.workspace);
    this.assertWorkerWorkspace(workspace);
    if (nextThreadId === worker.threadId) return true;
    worker.threadId = nextThreadId;
    worker.threadName = String(thread?.title || worker.threadName);
    worker.workspace = workspace;
    worker.initializedAt = undefined;
    this.persist();
    return true;
  }

  private assertWorkerWorkspace(workspace: string): void {
    if (!sameCodexWorkspace(workspace, this.options.workspace)) {
      throw new Error("Message Agent task resolution returned a workspace different from the Primary Persona.");
    }
  }

  private remember(worker: MessageAgentWorker, group: PendingMessageGroup): void {
    const now = this.now().toISOString();
    worker.affinities = worker.affinities.filter((affinity) => affinity.groupId !== group.groupId);
    worker.affinities.push({
      groupId: group.groupId,
      endpoint: group.endpoint,
      conversationKey: group.conversationKey,
      sender: group.sender,
      preview: groupPreview(group),
      messageIds: groupMessageIds(group),
      lastUsedAt: now
    });
    worker.affinities = worker.affinities.slice(-100);
  }

  private persist(): void {
    atomicWriteFileSync(this.options.statePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
    atomicWriteFileSync(this.affinityStatePath, `${JSON.stringify(this.affinitySnapshot(), null, 2)}\n`);
  }

  private async managerRequest(payload: Record<string, unknown>): Promise<Record<string, any>> {
    return requestMessageAgentManager(this.options.managerBaseUrl, payload);
  }
}

export function messageAgentPoolStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "agents.json");
}

export function messageAgentAffinityStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "routing-affinity.json");
}
