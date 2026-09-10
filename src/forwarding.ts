import path from "node:path";
import { createAgentAdapter } from "./agentAdapters/agentAdapter.js";
import { configuredInstanceBinding, readBoundInstanceAgent, requestInstanceThread, instanceWorkerStateDirectory } from "./agentAdapters/instanceClient.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import {
  measurePerformanceOperation,
  measureSyncPerformanceOperation
} from "./performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "./shared/performanceOperations.js";
import { isCodexMonitorThreadActive } from "./codexRuntime.js";
import { config, rolePathsForRoute, type RouteProfile } from "./config.js";
import {
  appendAgentPacketToDir,
  appendFeishuMessageToDir,
  appendAdapterLogToDir,
  appendGroupMessageToDir,
  appendHeartbeatEventToDir,
  appendManualTriggerEventToDir,
  appendPrivateMessageToDir,
  appendVoiceTranscriptEventToDir,
  appendWeComMessageToDir,
  appendWeixinMessageToDir
} from "./history.js";
import {
  automationRunId,
  claimAutomationRun,
  executeScriptAutomation,
  finishAutomationRun,
  matchingMessageScriptAutomations
} from "./automation/personaAutomationRuntime.js";
import { buildAgentPacket } from "./routing/agentPacket.js";
import { fetchRoleContextProjection } from "./manager/roleContextProjection.js";
import { renderRabiDelivery, type RabiDeliveryEnvelope, type RabiMessageSource } from "./shared/rabiMessage.js";
import { observeIdentityEndpoint } from "./identityRelations.js";
import { identityEndpointsForForward } from "./routing/identityContext.js";
import { recordConversationSituation } from "./conversationSituationStore.js";
import {
  createRouteDecision,
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isWeComRecord,
  isFeishuRecord,
  isWeixinRecord,
  isVoiceTranscriptRecord
} from "./routing/routeDecision.js";
import type {
  ForwardLogKind,
  ForwardRecord,
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";
import {
  appendDeliveryReplayAttempt,
  createDeliveryReplayAttemptId,
  type DeliveryReplayPacket
} from "./deliveryReplayLedger.js";
import {
  appendMessageContextToDir,
} from "./messageContextStore.js";
import { messageContextScopeForForward } from "./routing/messageContextScope.js";
import { logicalMessageAdapterForRecord } from "./routing/messageContextScope.js";
import {
  MessageGroupingQueue,
  messageGroupingStatePath,
  type PendingMessageGroup
} from "./messageGrouping.js";
import {
  mergePendingMessageGroup,
  messageGroupEnqueueInputForForward
} from "./routing/messageGroupingForward.js";
import { MessageAgentPool, messageAgentPoolStatePath } from "./messageAgentPool.js";
import { MemoryConsolidationAgent, memoryConsolidationAgentStatePath } from "./memoryConsolidationAgent.js";
import {
  findReferencedAgentSenders,
  sendMessageProcessingManagerCommand
} from "./messageProcessing/managerClient.js";
import type { MessageAgentReferencedSender } from "./messageProcessing/referencedAgentSender.js";
import { collectMessageGroupSourceEvidence, type MessageGroupSourceEvidence } from "./messageProcessing/sourceEvidence.js";
import {
  DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL,
  DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT,
  agentAdapterSupportsManagedTaskFeature,
  primaryMessageProcessingAgentAdapter,
  normalizeMessageGroupingPolicy,
  type MessageGroupingPolicy,
  type RecentMessageEndpoint
} from "./shared/gatewayConfigModel.js";

export type {
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";

export type ForwardDeliveryStatus = "delivered" | "routed" | "missed" | "failed" | "skipped";
export type ForwardDeliveryReason = "no_active_route_profile" | "no_matching_rule" | "low_signal_voice_transcript" | "no_agent_adapter" | "agent_busy";

export type ForwardAdapterOutcome = {
  routeId: string;
  ruleId: string;
  adapter: AgentAdapterType;
  status: "delivered" | "failed";
  error?: string;
};

export type ForwardRouteDeliveryResult = {
  routeId: string;
  routeName: string;
  status: ForwardDeliveryStatus;
  matchedRuleIds: string[];
  matchedRuleCount: number;
  sentPacketCount: number;
  adapterOutcomes: ForwardAdapterOutcome[];
  reason?: ForwardDeliveryReason;
};

export type ForwardDeliveryResult = {
  routeKind: ForwardRouteKind;
  messageId: string;
  status: ForwardDeliveryStatus;
  matchedRuleIds: string[];
  matchedRuleCount: number;
  sentPacketCount: number;
  adapterOutcomes: ForwardAdapterOutcome[];
  routes: ForwardRouteDeliveryResult[];
  reason?: ForwardDeliveryReason;
};

export type ForwardMessageOptions = {
  appendRoleRecord?: boolean;
  logReplayAttempt?: boolean;
  replayOfAttemptId?: string;
  recordInbound?: boolean;
  messageGroup?: PendingMessageGroup;
  signal?: AbortSignal;
};

let messageAgentPool: MessageAgentPool | undefined;
let memoryConsolidationAgent: MemoryConsolidationAgent | undefined;
let messageGroupingQueue: MessageGroupingQueue | undefined;
let messageAgentPoolScope = "";
let memoryConsolidationAgentScope = "";

/** Clears process-local grouping workers so tests and runtime reconfiguration do not reuse stale gateway settings. */
export function resetMessageProcessingRuntime(): void {
  messageGroupingQueue?.close();
  messageGroupingQueue = undefined;
  messageAgentPool = undefined;
  memoryConsolidationAgent = undefined;
  messageAgentPoolScope = "";
  memoryConsolidationAgentScope = "";
}

function primaryManagedAgentBinding(): {
  agentAdapter: "codex" | "dsh";
  sessionId: string;
  sessionName: string;
  workspace: string;
} | undefined {
  if (configuredInstanceBinding(config.primaryAgentAdapter || "")) return undefined;
  if (config.primaryAgentAdapter === "dsh" && config.dshSessionId && config.dshSessionName && config.dshCwd) {
    return {
      agentAdapter: "dsh",
      sessionId: config.dshSessionId,
      sessionName: config.dshSessionName,
      workspace: config.dshCwd
    };
  }
  if (config.primaryAgentAdapter === "codex" && config.codexThreadId && config.codexThreadName && config.codexCwd) {
    return {
      agentAdapter: "codex",
      sessionId: config.codexThreadId,
      sessionName: config.codexThreadName,
      workspace: config.codexCwd
    };
  }
  return undefined;
}

function messageAgentModeEnabled(): boolean {
  return Boolean(primaryMessageProcessingAgentAdapter(config) && (configuredInstanceBinding(config.primaryAgentAdapter || "") || primaryManagedAgentBinding()));
}

async function managedAgentExecution() {
  const instanceBinding = configuredInstanceBinding(config.primaryAgentAdapter || "");
  if (!instanceBinding) return { binding: primaryManagedAgentBinding(), dataDir: config.dataDir, dependencies: {} };
  const agent = await readBoundInstanceAgent(instanceBinding);
  const adapter = agent.provider === "codex-desktop" ? "codex" : agent.provider;
  if ((adapter !== "codex" && adapter !== "dsh") || adapter !== config.primaryAgentAdapter) throw new Error("The instance task provider does not match the configured primary Agent.");
  return {
    binding: { agentAdapter: adapter as "codex" | "dsh", sessionId: agent.sessionId!, sessionName: agent.name, workspace: agent.workspace! },
    dataDir: instanceWorkerStateDirectory(config.dataDir, instanceBinding, agent.sessionId!),
    dependencies: { request: (payload: Record<string, unknown>) => requestInstanceThread(instanceBinding, payload) }
  };
}

async function activeMessageAgentPool(): Promise<MessageAgentPool> {
  const execution = await managedAgentExecution();
  const { binding } = execution;
  if (messageAgentPool && messageAgentPoolScope === execution.dataDir) return messageAgentPool;
  const adapter = primaryMessageProcessingAgentAdapter(config);
  const policy = adapter ? config.messageProcessingAgents[adapter] : undefined;
  if (!binding || !adapter || !policy?.enabled) throw new Error("Primary Agent Message Agent mode is not enabled.");
  messageAgentPool = new MessageAgentPool({
    statePath: messageAgentPoolStatePath(execution.dataDir),
    managerBaseUrl: managerBaseUrl(),
    sourceThreadName: binding.sessionName,
    sourceThreadId: binding.sessionId,
    agentAdapter: binding.agentAdapter,
    workspace: binding.workspace,
    roleId: config.agentRoleId,
    rolePath: config.agentRolePath,
    model: policy.model || DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL,
    reasoningEffort: policy.reasoningEffort || DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT,
    maxAgents: policy.maxAgents
  }, execution.dependencies);
  messageAgentPoolScope = execution.dataDir;
  return messageAgentPool;
}

async function activeMemoryConsolidationAgent(): Promise<MemoryConsolidationAgent> {
  const execution = await managedAgentExecution();
  const { binding } = execution;
  if (memoryConsolidationAgent && memoryConsolidationAgentScope === execution.dataDir) return memoryConsolidationAgent;
  if (!binding) {
    throw new Error("Primary Agent session id and workspace are required for the dedicated memory consolidation Agent.");
  }
  memoryConsolidationAgent = new MemoryConsolidationAgent({
    statePath: memoryConsolidationAgentStatePath(execution.dataDir),
    managerBaseUrl: managerBaseUrl(),
    sourceThreadName: binding.sessionName,
    sourceThreadId: binding.sessionId,
    agentAdapter: binding.agentAdapter,
    workspace: binding.workspace,
    roleId: config.agentRoleId,
    model: config.codexMemoryConsolidationAgentModel
  }, execution.dependencies);
  memoryConsolidationAgentScope = execution.dataDir;
  return memoryConsolidationAgent;
}

function managerBaseUrl(): string {
  const value = process.env.GATEWAY_MANAGER_URL?.trim();
  if (!value) {
    throw new Error("GATEWAY_MANAGER_URL was not supplied by the owning RabiRoute Manager.");
  }
  return value.replace(/\/+$/, "");
}

async function referencedAgentSendersForMessageGroup(
  routeId: string,
  group: PendingMessageGroup
): Promise<MessageAgentReferencedSender[]> {
  if (group.endpoint !== "napcat" || !group.replyToMessageId) return [];
  try {
    const senders = await findReferencedAgentSenders(managerBaseUrl(), {
      channel: "napcat",
      sentMessageId: group.replyToMessageId,
      routeId
    });
    appendAdapterLogToDir("router", {
      event: "message_processing_reply_sender_lookup_completed",
      level: "info",
      message: `Referenced message sender lookup completed with ${senders.length} Agent session match(es).`,
      data: {
        routeId,
        replyToMessageId: group.replyToMessageId,
        referencedSenders: senders
      }
    }, config.dataDir);
    return senders;
  } catch (error) {
    appendAdapterLogToDir("router", {
      event: "message_processing_reply_sender_lookup_failed",
      level: "warning",
      message: `Could not resolve the Agent sender for referenced message ${group.replyToMessageId}; routing continues without that preference.`,
      data: {
        routeId,
        replyToMessageId: group.replyToMessageId,
        error: error instanceof Error ? error.message : String(error)
      }
    }, config.dataDir);
    return [];
  }
}

function messageProcessingRequirementId(group: PendingMessageGroup, routeId: string): string {
  const deliveryFingerprint = createHash("sha256")
    .update(group.items.map((item) => item.identity).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${group.groupId}:${routeId}:${deliveryFingerprint}`;
}

function messageGroupSummary(group: PendingMessageGroup): string {
  return group.items
    .map((item) => String(item.payload.record.rawMessage ?? item.payload.record.message ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

function messageGroupIds(group: PendingMessageGroup): string[] {
  return group.items
    .map((item) => String(item.payload.record.messageId ?? "").trim())
    .filter(Boolean)
    .slice(-100);
}

function messageGroupPrompt(
  group: PendingMessageGroup,
  packetContent: string,
  requirementId?: string,
  evidence?: MessageGroupSourceEvidence
): string {
  const evidenceLines = evidence ? [
    "[本轮必须核对的原始证据]",
    `本组原消息 ID：${messageGroupIds(group).join(", ") || "无"}`,
    `直接和递归引用链 ID：${evidence.replyChainMessageIds.join(", ") || "无"}`,
    ...(evidence.attachments.length ? evidence.attachments.map((attachment) =>
      `附件 ${attachment.id}｜消息 ${attachment.messageId}｜${attachment.status}｜${attachment.name}${attachment.path ? `｜本地文件 ${attachment.path}` : `｜${attachment.error || "不可读"}`}`
    ) : ["附件：无"]),
    "先围绕上面这组原消息、引用链和附件理解当前讨论；不要让较早的最近消息覆盖它。聚合需求保留全部证据；准备回复时，sourceEvidenceReview 和 projectFactAssessment 只声明本次 sourceMessageId、它的明确回复链和正文实际引用的附件。图片已作为本轮 Desktop 图片输入附带时，必须实际查看；引用含图片的 QQ 消息回复时，还要按图片顺序填写 params.replyImageDescriptions。"
  ] : [];
  return [
    requirementId ? `[消息处理要求]\n消息处理需求 ID：${requirementId}` : "",
    ...evidenceLines,
    packetContent
  ].filter(Boolean).join("\n\n");
}

async function deliverPacketToMessageAgent(
  routeId: string,
  ruleId: string,
  packetContent: string,
  messageSource: RabiMessageSource,
  replyContextJson: string,
  roleId: string,
  group: PendingMessageGroup
): Promise<ForwardAdapterOutcome[]> {
  if (group.endpoint === "heartbeat") {
    try {
      await measurePerformanceOperation(
        `${PERFORMANCE_OPERATIONS.gatewayAgentDeliver}.message_agent`,
        async () => (await activeMessageAgentPool()).deliver(group, messageGroupPrompt(group, packetContent), { messageSource })
      );
      return [{ routeId, ruleId, adapter: "codex", status: "delivered" }];
    } catch (error) {
      return [{
        routeId,
        ruleId,
        adapter: "codex",
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      }];
    }
  }
  const requirementId = messageProcessingRequirementId(group, routeId);
  const sourceEvidence = collectMessageGroupSourceEvidence(group, config.memoryDataDir);
  let replyContext: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(replyContextJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      replyContext = parsed as Record<string, unknown>;
    }
  } catch {
    // AgentPacket will expose the malformed context; board registration can still retain the source metadata.
  }
  try {
    const registration = await measurePerformanceOperation(
      PERFORMANCE_OPERATIONS.gatewayMessageRegister,
      () => sendMessageProcessingManagerCommand(managerBaseUrl(), {
        action: "register_group",
      requirementId,
      messageGroupId: group.groupId,
      source: {
        routeId: process.env.GATEWAY_ID || routeId,
        routeProfileId: routeId,
        roleId,
        endpoint: group.endpoint,
        conversationKey: group.conversationKey,
        sender: group.sender,
        routeKinds: [...new Set(group.items.map((item) => item.payload.routeKind))],
        messageIds: messageGroupIds(group),
        evidenceReviewRequired: true,
        replyChainMessageIds: sourceEvidence.replyChainMessageIds,
        attachments: sourceEvidence.attachments,
        summary: messageGroupSummary(group),
        replyContext
        }
      })
    );
    const registrationData = registration.data && typeof registration.data === "object"
      ? registration.data as Record<string, unknown>
      : {};
    const registered = registrationData.requirement && typeof registrationData.requirement === "object"
      ? registrationData.requirement as Record<string, unknown>
      : registrationData;
    const registrationOutcome = String(registrationData.outcome || "");
    const canonicalRequirementId = String(registered.id || requirementId);
    const registeredStatus = String(registered.status || (registrationOutcome === "replay_suppressed" ? "not_required" : "pending_dispatch"));
    if (registeredStatus !== "pending_dispatch" && registeredStatus !== "send_failed") {
      appendAdapterLogToDir("router", {
        event: "message_processing_duplicate_suppressed",
        level: "info",
        message: `Duplicate message group reused requirementId=${canonicalRequirementId}; no second Agent delivery was created.`,
        data: { requestedRequirementId: requirementId, canonicalRequirementId, status: registeredStatus }
      }, config.dataDir);
      return [{ routeId, ruleId, adapter: "codex", status: "delivered" }];
    }
    const referencedSenders = await referencedAgentSendersForMessageGroup(routeId, group);
    const worker = await measurePerformanceOperation(
      `${PERFORMANCE_OPERATIONS.gatewayAgentDeliver}.message_agent`,
      async () => (await activeMessageAgentPool()).deliver(
        group,
        messageGroupPrompt(group, packetContent, canonicalRequirementId, sourceEvidence),
        {
          messageSource,
          requirementId: canonicalRequirementId,
          referencedSenders,
          imageAttachments: sourceEvidence.attachments
            .filter((attachment) => attachment.kind === "image" && attachment.status === "ready" && attachment.path)
            .map((attachment) => ({ id: attachment.id, path: attachment.path! }))
        }
      )
    );
    if (referencedSenders.length > 0) {
      appendAdapterLogToDir("router", {
        event: "message_processing_reply_sender_weight_applied",
        level: "info",
        message: `Referenced Agent sender preference was included when selecting a Message Agent requirementId=${canonicalRequirementId}`,
        data: {
          requirementId: canonicalRequirementId,
          routeId,
          replyToMessageId: group.replyToMessageId,
          referencedSenders,
          selectedThreadId: worker.threadId,
          selectedReferencedSession: referencedSenders.some((sender) => sender.sessionId === worker.threadId)
        }
      }, config.dataDir);
    }
    try {
      await sendMessageProcessingManagerCommand(managerBaseUrl(), {
        action: "dispatch",
        requirementId: canonicalRequirementId,
        worker: {
          threadId: worker.threadId,
          threadName: worker.threadName,
          workspace: worker.workspace
        }
      });
    } catch (error) {
      appendAdapterLogToDir("router", {
        event: "message_processing_board_update_failed",
        level: "warning",
        message: `Message group reached the Agent but its board dispatch state could not be updated requirementId=${canonicalRequirementId}`,
        data: { requirementId: canonicalRequirementId, error: error instanceof Error ? error.message : String(error) }
      }, config.dataDir);
    }
    return [{ routeId, ruleId, adapter: "codex", status: "delivered" }];
  } catch (error) {
    void sendMessageProcessingManagerCommand(managerBaseUrl(), {
      action: "dispatch_failed",
      requirementId,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    return [{
      routeId,
      ruleId,
      adapter: "codex",
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    }];
  }
}

function activeMessageGroupingQueue(): MessageGroupingQueue {
  if (messageGroupingQueue) return messageGroupingQueue;
  messageGroupingQueue = new MessageGroupingQueue(
    messageGroupingStatePath(config.dataDir),
    async (group) => {
      const merged = mergePendingMessageGroup(group);
      const result = await forwardMessageAndWait(
        merged.routeKind,
        merged.record,
        merged.extraValues,
        { appendRoleRecord: false, recordInbound: false, messageGroup: group }
      );
      if (result.status === "failed") {
        const errors = result.adapterOutcomes.map((outcome) => outcome.error).filter(Boolean).join("; ");
        throw new Error(errors || `Message group ${group.groupId} delivery failed.`);
      }
    }
  );
  return messageGroupingQueue;
}

const automaticMessageGroupingRouteKinds = new Set<ForwardRouteKind>([
  "private",
  "group_message",
  "direct_at",
  "direct_reply",
  "indirect_reply",
  "role_panel_message",
  "rabilink",
  "wecom_message",
  "weixin_message",
  "feishu_message"
]);

export function routeKindUsesAutomaticMessageGrouping(routeKind: ForwardRouteKind): boolean {
  return automaticMessageGroupingRouteKinds.has(routeKind);
}

function groupingPolicyForRecord(routeKind: ForwardRouteKind, record: ForwardRecord): Required<MessageGroupingPolicy> | undefined {
  if (!routeKindUsesAutomaticMessageGrouping(routeKind)) {
    return undefined;
  }
  const endpoint = logicalMessageAdapterForRecord(routeKind, record) as RecentMessageEndpoint | undefined;
  if (!endpoint) return undefined;
  const configured = config.messageAdapterPolicies[endpoint]?.messageGrouping;
  return configured ? normalizeMessageGroupingPolicy(configured, endpoint) : undefined;
}

function logDeliveryResult(result: ForwardDeliveryResult): void {
  const failed = result.status === "failed";
  const missed = result.status === "missed" || result.status === "skipped";
  appendAdapterLogToDir("router", {
    event: "delivery_result",
    level: failed ? "error" : missed ? "warning" : "info",
    message: `Delivery ${result.status} routeKind=${result.routeKind} messageId=${result.messageId} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`,
    data: result
  }, config.dataDir);
}

function configuredPrimaryAgentAdapter(): AgentAdapterType | undefined {
  return config.primaryAgentAdapter;
}

export function memoryConsolidationAgentHandles(
  routeKind: ForwardRouteKind,
  triggerId: string | undefined,
  enabled: boolean,
  primaryAdapter: AgentAdapterType | undefined
): boolean {
  return routeKind === "manual_trigger"
    && triggerId === "memory-consolidation"
    && enabled
    && Boolean(primaryAdapter && agentAdapterSupportsManagedTaskFeature(primaryAdapter, "memoryConsolidationAgent"));
}

export function shouldSkipHeartbeatDelivery(
  routeKind: ForwardRouteKind,
  skipWhenAgentBusy: boolean,
  agentAdapters: AgentAdapterType[],
  codexThreadActive: boolean,
  messageProcessingAgentEnabled = false
): boolean {
  return routeKind === "heartbeat"
    && skipWhenAgentBusy
    && !messageProcessingAgentEnabled
    && agentAdapters.includes("codex")
    && codexThreadActive;
}

async function heartbeatShouldSkipForBusyAgent(routeKind: ForwardRouteKind): Promise<boolean> {
  const adapters = config.primaryAgentAdapter ? [config.primaryAgentAdapter] : [];
  if (!shouldSkipHeartbeatDelivery(
    routeKind,
    config.heartbeatSkipWhenAgentBusy,
    adapters,
    true,
    messageAgentModeEnabled()
  )) {
    return false;
  }
  try {
    return await isCodexMonitorThreadActive();
  } catch (error) {
    appendAdapterLogToDir("router", {
      event: "heartbeat_agent_busy_check_failed",
      level: "warning",
      message: `Heartbeat busy check failed; delivery will continue: ${error instanceof Error ? error.message : String(error)}`,
      data: { routeKind }
    }, config.dataDir);
    return false;
  }
}

function logKindForRoute(routeKind: ForwardRouteKind): ForwardLogKind {
  if (routeKind === "heartbeat") {
    return "heartbeat";
  }
  if (routeKind === "manual_trigger") {
    return "manual_trigger";
  }
  if (routeKind === "role_panel_message") {
    return "role_panel_message";
  }
  if (routeKind === "plan_feedback") {
    return "plan_feedback";
  }
  if (routeKind === "voice_transcript") {
    return "voice_transcript";
  }
  if (routeKind === "rabilink") {
    return "rabilink";
  }
  if (routeKind === "wearable_health_alert") {
    return "wearable_health_alert";
  }
  if (routeKind === "wecom_message") {
    return "wecom_message";
  }
  if (routeKind === "weixin_message") {
    return "weixin_message";
  }
  if (routeKind === "feishu_message") return "feishu_message";
  if (routeKind === "xiaomi_home_event") return "xiaomi_home_event";
  return routeKind === "private" ? "private" : "group_mention";
}

async function dispatchToAgentAdapter(type: AgentAdapterType, envelope: RabiDeliveryEnvelope, imagePaths: string[] = []): Promise<void> {
  const adapter = await createAgentAdapter(type);
  return measurePerformanceOperation(
    `${PERFORMANCE_OPERATIONS.gatewayAgentDeliver}.${type}`,
    () => adapter.deliver(envelope, imagePaths.length ? { imagePaths } : undefined)
  );
}

function imagePathsForRecord(record: ForwardRecord): string[] {
  if (!("attachments" in record) || !Array.isArray(record.attachments)) return [];
  return [...new Set(record.attachments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const attachment = item as { kind?: unknown; path?: unknown };
    if (attachment.kind !== "image" || typeof attachment.path !== "string") return [];
    const imagePath = attachment.path.trim();
    if (!path.isAbsolute(imagePath) || !fs.existsSync(imagePath) || !/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(imagePath)) return [];
    return [path.resolve(imagePath)];
  }))];
}

export async function deliverPacketToPrimaryAgentAdapter(
  routeId: string,
  ruleId: string,
  envelope: RabiDeliveryEnvelope,
  dispatch: (type: AgentAdapterType, envelope: RabiDeliveryEnvelope, imagePaths?: string[]) => Promise<void> = dispatchToAgentAdapter,
  imagePaths: string[] = []
): Promise<ForwardAdapterOutcome[]> {
  const adapter = configuredPrimaryAgentAdapter();
  if (!adapter) return [];
  try {
    await dispatch(adapter, envelope, imagePaths);
    return [{
      routeId,
      ruleId,
      adapter,
      status: "delivered"
    }];
  } catch (error) {
    return [{
      routeId,
      ruleId,
      adapter,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    }];
  }
}

async function deliverPacketToMemoryConsolidationAgent(
  routeId: string,
  ruleId: string,
  content: string,
  messageSource: RabiMessageSource
): Promise<ForwardAdapterOutcome[]> {
  const adapter = primaryManagedAgentBinding()?.agentAdapter ?? configuredPrimaryAgentAdapter() ?? "codex";
  try {
    const binding = await measurePerformanceOperation(
      `${PERFORMANCE_OPERATIONS.gatewayAgentDeliver}.memory_agent`,
      async () => (await activeMemoryConsolidationAgent()).deliver(content, messageSource)
    );
    return [{ routeId, ruleId, adapter: binding.agentAdapter, status: "delivered" }];
  } catch (error) {
    return [{
      routeId,
      ruleId,
      adapter,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    }];
  }
}

function immediateMessageAgentGroup(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues
): PendingMessageGroup {
  const now = Date.now();
  const scope = messageContextScopeForForward(routeKind, record, {
    gatewayId: process.env.GATEWAY_ID
  });
  const endpoint = scope?.endpoint || routeKind;
  const conversationKey = scope?.record.conversationKey || `${endpoint}:internal`;
  const sender = String(scope?.record.sender || "RabiRoute");
  const messageId = recordId(record);
  const groupId = `message-group-${createHash("sha256")
    .update(`${routeKind}|${messageId}`)
    .digest("hex")
    .slice(0, 24)}`;
  const baseKey = `${endpoint}|${conversationKey}|sender:${sender}`;
  return {
    groupId,
    key: `${baseKey}|message:${messageId}`,
    baseKey,
    endpoint,
    conversationKey,
    sender,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now,
    maxDeadlineAt: now,
    status: "pending",
    attempts: 0,
    items: [{
      identity: `${endpoint}|${conversationKey}|message:${messageId}`,
      receivedAt: now,
      incomplete: false,
      payload: {
        routeKind,
        record: record as unknown as Record<string, unknown>,
        extraValues
      }
    }]
  };
}

function activeRouteProfiles(): RouteProfile[] {
  return config.routeProfiles.filter((route) => route.enabled !== false);
}

function routeProfilesForRecord(record: ForwardRecord): RouteProfile[] {
  const requestedRoute = "routeProfileId" in record ? String(record.routeProfileId || "").trim().toLowerCase() : "";
  return activeRouteProfiles().filter((route) => !requestedRoute || [route.id, route.name, route.agentRoleId]
    .some((value) => String(value || "").trim().toLowerCase() === requestedRoute));
}

function recordId(record: ForwardRecord): string {
  return String(record.messageId ?? record.time ?? "unknown");
}

function previewMessage(record: ForwardRecord): string {
  return record.rawMessage.replace(/\s+/g, " ").trim().slice(0, 120);
}

function logRouteMiss(routeKind: ForwardRouteKind, record: ForwardRecord, reason: string, route?: RouteProfile): void {
  const message = route
    ? `No route rule matched routeKind=${routeKind} route=${route.id} rules=${route.notificationRules.length} messageId=${recordId(record)} message="${previewMessage(record)}"`
    : `No active route profile for routeKind=${routeKind} messageId=${recordId(record)} message="${previewMessage(record)}"`;
  appendAdapterLogToDir("router", {
    event: "route_miss",
    level: "warning",
    message,
    data: {
      reason,
      routeKind,
      routeId: route?.id,
      routeName: route?.name,
      ruleCount: route?.notificationRules.length ?? 0,
      messageId: record.messageId,
      preview: previewMessage(record)
    }
  }, config.dataDir);
  console.warn(message);
}

function routeResult(
  route: RouteProfile,
  status: ForwardDeliveryStatus,
  patch: Partial<Omit<ForwardRouteDeliveryResult, "routeId" | "routeName" | "status">> = {}
): ForwardRouteDeliveryResult {
  const matchedRuleIds = patch.matchedRuleIds ?? [];
  const adapterOutcomes = patch.adapterOutcomes ?? [];
  return {
    routeId: route.id,
    routeName: route.name,
    status,
    matchedRuleIds,
    matchedRuleCount: patch.matchedRuleCount ?? matchedRuleIds.length,
    sentPacketCount: patch.sentPacketCount ?? 0,
    adapterOutcomes,
    reason: patch.reason
  };
}

function summarizeDeliveryResult(routeKind: ForwardRouteKind, record: ForwardRecord, routes: ForwardRouteDeliveryResult[], fallbackReason?: ForwardDeliveryReason): ForwardDeliveryResult {
  const adapterOutcomes = routes.flatMap((route) => route.adapterOutcomes);
  const matchedRuleIds = routes.flatMap((route) => route.matchedRuleIds);
  const sentPacketCount = routes.reduce((sum, route) => sum + route.sentPacketCount, 0);
  const matchedRuleCount = routes.reduce((sum, route) => sum + route.matchedRuleCount, 0);
  const failed = adapterOutcomes.some((outcome) => outcome.status === "failed");
  const delivered = adapterOutcomes.some((outcome) => outcome.status === "delivered");
  const routed = routes.some((route) => route.status === "routed" || route.status === "delivered" || route.status === "failed");
  const skipped = routes.length > 0 && routes.every((route) => route.status === "skipped");
  const missed = routes.length === 0 || routes.every((route) => route.status === "missed" || route.status === "skipped");
  const status: ForwardDeliveryStatus = failed
    ? "failed"
    : delivered
      ? "delivered"
      : routed
        ? "routed"
        : skipped
          ? "skipped"
          : missed
            ? "missed"
            : "routed";
  const reasons = [...new Set(routes.map((route) => route.reason).filter((reason): reason is ForwardDeliveryReason => Boolean(reason)))];
  const reason = fallbackReason ?? (reasons.length === 1 ? reasons[0] : undefined);

  return {
    routeKind,
    messageId: recordId(record),
    status,
    matchedRuleIds,
    matchedRuleCount,
    sentPacketCount,
    adapterOutcomes,
    routes,
    reason
  };
}

function appendRecordToRoleDataDir(record: ForwardRecord, dataDir: string): void {
  if (isWeComRecord(record)) {
    appendWeComMessageToDir(record, dataDir);
  } else if (isFeishuRecord(record)) {
    appendFeishuMessageToDir(record, dataDir);
  } else if (isWeixinRecord(record)) {
    appendWeixinMessageToDir(record, dataDir);
  } else if (isGroupRecord(record)) {
    appendGroupMessageToDir(record, dataDir);
  } else if (isHeartbeatRecord(record)) {
    appendHeartbeatEventToDir(record, dataDir);
  } else if (isManualTriggerRecord(record)) {
    appendManualTriggerEventToDir(record, dataDir);
  } else if (isVoiceTranscriptRecord(record)) {
    appendVoiceTranscriptEventToDir(record, dataDir);
  } else {
    appendPrivateMessageToDir(record, dataDir);
  }
}

function appendRecordToPersonaConversation(route: RouteProfile, routeKind: ForwardRouteKind, record: ForwardRecord): boolean {
  const roleContext = rolePathsForRoute(route);
  const dataDir = roleContext.personaDataDir;
  const scope = messageContextScopeForForward(routeKind, record, { gatewayId: process.env.GATEWAY_ID, routeProfileId: route.id });
  if (!scope) return false;
  try {
    return Boolean(appendMessageContextToDir(dataDir, scope.record));
  } catch (error) {
    appendAdapterLogToDir("router", {
      event: "message_context_append_failed",
      level: "warning",
      message: `Failed to append persona conversation context route=${route.id}: ${error instanceof Error ? error.message : String(error)}`,
      data: { routeKind, routeId: route.id, messageId: record.messageId }
    }, config.dataDir);
    return false;
  }
}

function recordInboundForRoutes(
  routes: RouteProfile[],
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: ForwardMessageOptions
): number {
  // Plan feedback already has a dedicated JSONL audit record. Do not duplicate
  // it into chat history or the persona conversation ledger.
  if (routeKind === "plan_feedback") return 0;
  const recordedRawDirs = new Set<string>();
  const recordedConversationDirs = new Set<string>();
  let conversationRecordCount = 0;
  for (const route of routes) {
    const roleContext = rolePathsForRoute(route);
    const resolvedDataDir = path.resolve(roleContext.personaDataDir);
    // Initialize/append the canonical conversation ledger before writing the
    // compatibility raw-history file. Otherwise a first write can be imported
    // immediately as legacy history and then appended again as the current event.
    if (!recordedConversationDirs.has(resolvedDataDir)) {
      if (appendRecordToPersonaConversation(route, routeKind, record)) conversationRecordCount += 1;
      recordedConversationDirs.add(resolvedDataDir);
    }
    if (options.appendRoleRecord !== false
      && resolvedDataDir !== path.resolve(config.memoryDataDir)
      && !recordedRawDirs.has(resolvedDataDir)) {
      appendRecordToRoleDataDir(record, roleContext.personaDataDir);
      recordedRawDirs.add(resolvedDataDir);
    }
  }
  return conversationRecordCount;
}

/** Record an endpoint message in persona-scoped raw history and the canonical conversation ledger without notifying an Agent. */
export function recordMessageContextOnly(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: ForwardMessageOptions = {}
): number {
  const routes = routeProfilesForRecord(record);
  return recordInboundForRoutes(routes, routeKind, record, options);
}

function isLowSignalVoiceTranscript(record: ForwardRecord): boolean {
  if (!isVoiceTranscriptRecord(record)) {
    return false;
  }

  // RabiSpeech has already applied its explicit hot/keyword push policy before
  // entering forwarding. A selected hot transcript must not be silently
  // discarded by the legacy webhook/FenneNote filler filter here.
  if (record.adapterType === "speech") {
    return false;
  }

  const text = record.rawMessage
    .replace(/[\s，。！？!?、,.~…]+/g, "")
    .trim();
  if (!text) {
    return true;
  }

  const fillerOnly = /^(嗯+|呃+|啊+|唔+|哦+|咳+|咳咳|哼+)$/.test(text);
  if (!fillerOnly) {
    return false;
  }

  const speakerName = record.speakerName ?? "";
  const likelyUnstableSpeaker = record.speakerDecision === "auto_enrolled"
    || record.speakerKind === "unknown"
    || speakerName.startsWith("unknown_");
  return likelyUnstableSpeaker || text.length <= 2;
}

async function forwardMessageToRoute(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {},
  options: ForwardMessageOptions = {},
  packets: DeliveryReplayPacket[] = []
): Promise<ForwardRouteDeliveryResult> {
  if (routeKind === "voice_transcript" && isLowSignalVoiceTranscript(record)) {
    return routeResult(route, "skipped", { reason: "low_signal_voice_transcript" });
  }

  const processingRequirementId = options.messageGroup && options.messageGroup.endpoint !== "heartbeat"
    ? messageProcessingRequirementId(options.messageGroup, route.id)
    : undefined;
  const decision = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.gatewayRouteDecision,
    () => createRouteDecision(route, routeKind, record, processingRequirementId
      ? { ...extraValues, messageProcessingRequirementId: processingRequirementId }
      : extraValues)
  );
  if (!decision) {
    logRouteMiss(routeKind, record, "no_matching_rule", route);
    return routeResult(route, "missed", { reason: "no_matching_rule" });
  }

  if (await heartbeatShouldSkipForBusyAgent(routeKind)) {
    appendAdapterLogToDir("router", {
      event: "heartbeat_skipped_agent_busy",
      level: "info",
      message: `Heartbeat skipped because the Codex thread is active route=${route.id} messageId=${recordId(record)}`,
      data: {
        routeKind,
        routeId: route.id,
        routeName: route.name,
        messageId: recordId(record),
        reason: "agent_busy"
      }
    }, config.dataDir);
    return routeResult(route, "skipped", { reason: "agent_busy" });
  }

  const roleContext = rolePathsForRoute(route);
  const projectionIdentity = {
    managerBaseUrl: String(process.env.GATEWAY_MANAGER_URL || "").trim(),
    routeId: String(process.env.GATEWAY_ID || "").trim(),
    capability: String(process.env.PERSONA_MESSAGING_CAPABILITY || "").trim(),
    applicationGenerationId: String(process.env.RABIROUTE_APPLICATION_GENERATION_ID || "").trim(),
    managerInstanceId: String(process.env.RABIROUTE_MANAGER_INSTANCE_ID || "").trim()
  };
  const projectionRequired = Boolean(
    projectionIdentity.capability
    || projectionIdentity.applicationGenerationId
    || projectionIdentity.managerInstanceId
  );
  const roleKnowledge = roleContext.roleDir && projectionRequired
    ? await fetchRoleContextProjection({
        ...projectionIdentity,
        roleId: roleContext.roleId,
        signalText: String(extraValues.message || record.rawMessage || ""),
        includePendingConsolidation: routeKind === "manual_trigger"
          && String(extraValues.triggerId || "") === "memory-consolidation",
        consolidationTrigger: routeKind === "manual_trigger" ? "manual" : undefined,
        signal: options.signal
      })
    : undefined;
  if (roleContext.roleDir) {
    const identityEndpoints = identityEndpointsForForward(routeKind, record, {
      gatewayId: process.env.GATEWAY_ID,
      routeProfileId: route.id
    });
    for (const identityEndpoint of identityEndpoints) {
      try {
        observeIdentityEndpoint(roleContext.roleDir, identityEndpoint);
      } catch (error) {
        appendAdapterLogToDir("router", {
          event: "identity_endpoint_observation_failed",
          level: "warning",
          message: `Could not retain the stable sender as a candidate identity for route=${route.id}`,
          data: {
            routeId: route.id,
            routeKind,
            platform: identityEndpoint.platform,
            endpointIdentityNamespace: identityEndpoint.endpointIdentityNamespace,
            error: error instanceof Error ? error.message : String(error)
          }
        }, roleContext.personaDataDir);
      }
    }
  }
  const messageAgentGroup = options.messageGroup
    ?? (routeKind === "heartbeat" && messageAgentModeEnabled()
      ? immediateMessageAgentGroup(routeKind, record, extraValues)
      : undefined);
  const useMemoryConsolidationAgent = memoryConsolidationAgentHandles(
    routeKind,
    isManualTriggerRecord(record) ? record.triggerId : undefined,
    config.codexMemoryConsolidationAgentEnabled,
    configuredPrimaryAgentAdapter()
  );

  const adapterOutcomes: ForwardAdapterOutcome[] = [];
  const imagePaths = imagePathsForRecord(record);
  let sentPacketCount = 0;
  let situationRecorded = false;
  for (const rule of decision.matchedRules) {
    const packet = measureSyncPerformanceOperation(
      PERFORMANCE_OPERATIONS.gatewayPacketBuild,
      () => buildAgentPacket(decision, rule, roleContext, { roleKnowledge })
    );
    if (packet.conversationSituation && !situationRecorded) {
      try {
        recordConversationSituation(roleContext.personaDataDir, route.id, routeKind, packet.conversationSituation);
        situationRecorded = true;
      } catch (error) {
        appendAdapterLogToDir("router", {
          event: "conversation_situation_record_failed",
          level: "warning",
          message: `Could not retain a conversation situation for route=${route.id}`,
          data: { routeId: route.id, routeKind, error: error instanceof Error ? error.message : String(error) }
        }, roleContext.personaDataDir);
      }
    }
    packets.push({
      routeId: route.id,
      ruleId: rule.id,
      message: packet.message,
      messageSource: packet.messageSource,
      content: packet.content
    });

    appendAgentPacketToDir({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: Math.floor(Date.now() / 1000),
      kind: logKindForRoute(routeKind),
      text: packet.message
    }, roleContext.personaDataDir);

    sentPacketCount += 1;
    adapterOutcomes.push(...(useMemoryConsolidationAgent
      ? await deliverPacketToMemoryConsolidationAgent(route.id, rule.id, packet.content, packet.messageSource)
      : messageAgentGroup
        ? await deliverPacketToMessageAgent(
          route.id,
          rule.id,
          packet.content,
          packet.messageSource,
          String(packet.templateValues.replyContextJson || "{}"),
          roleContext.roleId,
          messageAgentGroup
        )
        : await deliverPacketToPrimaryAgentAdapter(route.id, rule.id, packet.delivery, undefined, imagePaths)));
  }

  const failed = adapterOutcomes.some((outcome) => outcome.status === "failed");
  const delivered = adapterOutcomes.some((outcome) => outcome.status === "delivered");
  return routeResult(route, failed ? "failed" : delivered ? "delivered" : "routed", {
    matchedRuleIds: decision.matchedRules.map((rule) => rule.id),
    sentPacketCount,
    adapterOutcomes,
    reason: adapterOutcomes.length === 0 ? "no_agent_adapter" : undefined
  });
}

async function forwardMessageAndWaitInternal(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {},
  options: ForwardMessageOptions = {}
): Promise<ForwardDeliveryResult> {
  const routes = routeProfilesForRecord(record);
  const packets: DeliveryReplayPacket[] = [];
  if (routes.length === 0) {
    logRouteMiss(routeKind, record, "no_active_route_profile");
    const result = summarizeDeliveryResult(routeKind, record, [], "no_active_route_profile");
    logDeliveryResult(result);
    if (options.logReplayAttempt !== false) {
      logDeliveryReplayAttempt(routeKind, record, extraValues, result, packets, options);
    }
    return result;
  }
  if (!options.replayOfAttemptId) {
    for (const route of routes) {
      for (const task of matchingMessageScriptAutomations(route, routeKind, record, extraValues)) {
        const runId = automationRunId(route.id, task.rule.id, { record });
        if (!claimAutomationRun(runId, {
          routeId: route.id,
          automationRuleId: task.rule.id,
          triggerType: "message",
          routeKind,
          messageId: recordId(record)
        })) continue;
        appendAdapterLogToDir("automation", {
          event: "script_started",
          message: `Persona automation script started route=${route.id} rule=${task.rule.id}`,
          data: { runId, routeId: route.id, automationRuleId: task.rule.id, routeKind, messageId: recordId(record) }
        }, config.dataDir);
        void executeScriptAutomation(task).then((result) => {
          finishAutomationRun(runId, result.status, {
            routeId: route.id,
            automationRuleId: task.rule.id,
            reason: result.reason,
            exitCode: result.exitCode,
            durationMs: result.durationMs
          });
          appendAdapterLogToDir("automation", {
            event: "script_result",
            level: result.status === "completed" ? "info" : result.status === "skipped" ? "warning" : "error",
            message: `Persona automation script ${result.status} route=${route.id} rule=${task.rule.id}`,
            data: { runId, routeId: route.id, automationRuleId: task.rule.id, routeKind, ...result }
          }, config.dataDir);
        });
      }
    }
  }
  if (options.recordInbound !== false) recordInboundForRoutes(routes, routeKind, record, options);
  const results: ForwardRouteDeliveryResult[] = [];
  for (const route of routes) {
    results.push(await forwardMessageToRoute(route, routeKind, record, extraValues, options, packets));
  }
  const result = summarizeDeliveryResult(routeKind, record, results);
  logDeliveryResult(result);
  if (options.logReplayAttempt !== false) {
    logDeliveryReplayAttempt(routeKind, record, extraValues, result, packets, options);
  }
  return result;
}

export function forwardMessageAndWait(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {},
  options: ForwardMessageOptions = {}
): Promise<ForwardDeliveryResult> {
  return measurePerformanceOperation(
    PERFORMANCE_OPERATIONS.gatewayForwardTotal,
    () => forwardMessageAndWaitInternal(routeKind, record, extraValues, options)
  );
}

function logDeliveryReplayAttempt(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  result: ForwardDeliveryResult,
  packets: DeliveryReplayPacket[],
  options: ForwardMessageOptions
): void {
  appendDeliveryReplayAttempt(config.dataDir, {
    attemptId: createDeliveryReplayAttemptId(routeKind, result.messageId),
    time: Math.floor(Date.now() / 1000),
    routeKind,
    messageId: result.messageId,
    record,
    extraValues,
    packets,
    result,
    replayOfAttemptId: options.replayOfAttemptId
  });
}

export function forwardMessage(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  const groupingPolicy = groupingPolicyForRecord(routeKind, record);
  if (groupingPolicy && messageAgentModeEnabled()) {
    const input = messageGroupEnqueueInputForForward(
      routeKind,
      record,
      extraValues,
      groupingPolicy,
      process.env.GATEWAY_ID
    );
    if (input) {
      recordMessageContextOnly(routeKind, record);
      const queued = activeMessageGroupingQueue().enqueue(input);
      appendAdapterLogToDir("router", {
        event: queued.accepted ? "message_group_queued" : "message_group_duplicate",
        level: "info",
        message: queued.accepted
          ? `Queued messageId=${recordId(record)} in ${queued.groupId} items=${queued.itemCount}`
          : `Ignored duplicate grouped messageId=${recordId(record)}`,
        data: {
          routeKind,
          messageId: recordId(record),
          groupId: queued.groupId,
          itemCount: queued.itemCount,
          endpoint: input.endpoint,
          conversationKey: input.conversationKey
        }
      }, config.dataDir);
      return;
    }
  }
  void forwardMessageAndWait(routeKind, record, extraValues)
    .catch((error) => {
      appendAdapterLogToDir("router", {
        event: "delivery_error",
        level: "error",
        message: `Failed to deliver routed message routeKind=${routeKind} messageId=${recordId(record)}`,
        data: {
          routeKind,
          messageId: recordId(record),
          error: error instanceof Error ? error.message : String(error)
        }
      }, config.dataDir);
      console.error("Failed to deliver routed message", error);
    });
}
