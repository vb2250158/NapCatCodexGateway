<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { managerEventSource } from "../managerApi";

type BoardItem = {
  id: string;
  kind: "message_reply" | "plan_progress_notification";
  replyPolicy: "required" | "agent_decides";
  status: string;
  source: {
    endpoint: string;
    conversationKey: string;
    sender: string;
    routeKinds: string[];
    messageIds: string[];
    summary?: string;
  };
  plan?: { planId: string; planTitle: string; changes: string[] };
  worker?: { threadName: string; threadId: string; active?: boolean; runtimeStatus?: "active" | "idle" | "notLoaded" | "unavailable" };
  decision?: { type: string; reasonCode?: string; reason?: string };
  handoff?: { targetAgentType: string; targetThreadName?: string; targetThreadId?: string };
  delivery?: { status: string; sentMessageId?: string; reason?: string };
  criticalFacts?: Array<{ kind: string; evidence: string }>;
  criticalFactDisposition?: {
    status: string;
    record?:
      | { type: "plan"; planId: string }
      | { type: "memory"; memoryId: string }
      | { type: "document"; relativePath: string };
    evidence?: string;
    verifiedAt?: string;
  };
  knowledgeMatches?: Array<{ id: string; title: string; type: "plan" | "recent_memory" | "consolidated_memory"; score?: number }>;
  knowledgeCallbacks?: Array<{
    knowledgeId: string;
    knowledgeType: "plan" | "recent_memory" | "consolidated_memory";
    result: "unchanged" | "updated" | "created" | "not_relevant" | "deferred";
    responseAction: "none" | "reply" | "discuss" | "handoff";
    evidence: string;
    recordId?: string;
  }>;
  knowledgeCallbackDueAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  overdueMs: number;
  missingOutcome: boolean;
};

type BoardPayload = {
  updatedAt?: string;
  counts: {
    total: number;
    requiredOpen: number;
    agentDecisionOpen: number;
    handedOff: number;
    overdue: number;
    sendFailed: number;
    missingOutcome: number;
    factAssessmentOpen: number;
    knowledgeCallbackOpen: number;
    criticalFactOpen: number;
    sent24h: number;
  };
  items: BoardItem[];
};

const props = defineProps<{ gatewayId: string; enabled: boolean }>();
const emptyCounts = () => ({ total: 0, requiredOpen: 0, agentDecisionOpen: 0, handedOff: 0, overdue: 0, sendFailed: 0, missingOutcome: 0, factAssessmentOpen: 0, knowledgeCallbackOpen: 0, criticalFactOpen: 0, sent24h: 0 });
const board = ref<BoardPayload>({ counts: emptyCounts(), items: [] });
const loading = ref(false);
const error = ref("");
const showCompleted = ref(false);
let events: EventSource | undefined;

const visibleItems = computed(() => board.value.items.filter((item) => showCompleted.value || !["sent", "not_required"].includes(item.status)));

function workerRuntimeLabel(item: BoardItem): string {
  if (!item.worker?.runtimeStatus) return "";
  if (item.worker.runtimeStatus === "active") return "（正在运行）";
  if (item.worker.runtimeStatus === "idle") return "（空闲）";
  if (item.worker.runtimeStatus === "notLoaded") return "（尚未加载）";
  return "（当前无法确认）";
}

function statusLabel(item: BoardItem): string {
  if (item.missingOutcome) return "Agent 已空闲，未提交结果";
  if (pendingKnowledgeMatches(item).length) return "计划/记忆等待回调";
  return ({
    pending_dispatch: "等待投递",
    processing: item.worker?.active === true ? "Agent 正在处理" : "等待处理结果",
    handed_off: "已转交，等待返回",
    awaiting_send: "已决定回复，等待发送",
    awaiting_approval: "等待发送审批",
    fact_record_pending: "消息已发送，待登记项目事实",
    sent: "已发送",
    not_required: "已确认无需回复",
    send_failed: "投递或发送失败"
  } as Record<string, string>)[item.status] || item.status;
}

function statusColor(item: BoardItem): string {
  if (item.missingOutcome || pendingKnowledgeMatches(item).length || item.overdueMs > 0 || item.status === "send_failed" || item.status === "fact_record_pending") return "error";
  if (item.status === "sent") return "success";
  if (item.status === "not_required") return "secondary";
  if (item.status === "handed_off" || item.status === "awaiting_approval") return "warning";
  return "primary";
}

function knowledgeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function pendingKnowledgeMatches(item: BoardItem): NonNullable<BoardItem["knowledgeMatches"]> {
  const callbacks = new Map((item.knowledgeCallbacks || []).map((callback) => [knowledgeKey(callback.knowledgeType, callback.knowledgeId), callback]));
  return (item.knowledgeMatches || []).filter((match) => {
    const callback = callbacks.get(knowledgeKey(match.type, match.id));
    return !callback || callback.result === "deferred";
  });
}

function knowledgeCallback(item: BoardItem, type: string, id: string): NonNullable<BoardItem["knowledgeCallbacks"]>[number] | undefined {
  return (item.knowledgeCallbacks || []).find((callback) => callback.knowledgeType === type && callback.knowledgeId === id);
}

function knowledgeTypeLabel(type: string): string {
  return type === "plan" ? "计划" : "记忆";
}

function knowledgeResultLabel(result?: string): string {
  return ({
    unchanged: "无变化",
    updated: "已更新",
    created: "已新建",
    not_relevant: "不相关",
    deferred: "暂缓处理"
  } as Record<string, string>)[result || ""] || "等待回调";
}

function kindLabel(item: BoardItem): string {
  if (item.kind === "plan_progress_notification") return "计划进展通知";
  return item.replyPolicy === "required" ? "必须回复" : "Agent 判断";
}

function routeLabel(item: BoardItem): string {
  const kinds = item.source.routeKinds || [];
  if (kinds.includes("direct_at")) return "明确 @";
  if (kinds.includes("direct_reply")) return "直接回复";
  if (kinds.includes("private")) return "私聊";
  if (kinds.includes("indirect_reply")) return "间接回复";
  return kinds[0] || item.source.endpoint;
}

function criticalFactRecordLabel(item: BoardItem): string {
  const record = item.criticalFactDisposition?.record;
  if (!record) return "";
  if (record.type === "plan") return `计划 · ${record.planId}`;
  if (record.type === "memory") return `记忆 · ${record.memoryId}`;
  return `项目文档 · ${record.relativePath}`;
}

function elapsed(ms: number): string {
  if (ms <= 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function timeLabel(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function refresh(): Promise<void> {
  if (!props.enabled || !props.gatewayId || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch(`/api/message-processing/board?routeId=${encodeURIComponent(props.gatewayId)}&limit=100`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code === -1) throw new Error(body.message || `HTTP ${response.status}`);
    board.value = body.data || { counts: emptyCounts(), items: [] };
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    loading.value = false;
  }
}

function start(): void {
  events?.close();
  if (!props.enabled) return;
  void refresh();
  events = managerEventSource("/api/events");
  events.addEventListener("message_processing_board_changed", () => { void refresh(); });
}

watch(() => [props.gatewayId, props.enabled], start);
onMounted(start);
onBeforeUnmount(() => {
  events?.close();
});
</script>

<template>
  <div class="message-board">
    <div class="board-header">
      <div>
        <div class="section-title small-title">消息处理看板</div>
        <div class="section-note">RabiManager 自动生成必须回复和计划通知需求；普通群讨论由 Agent 判断。实际发送回执是完成依据。</div>
      </div>
      <div class="board-actions">
        <v-switch v-model="showCompleted" label="显示已完成" density="compact" hide-details />
        <v-btn icon="mdi-refresh" size="small" variant="text" :loading="loading" title="刷新" @click="refresh" />
      </div>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-2">{{ error }}</v-alert>

    <div class="board-metrics mt-3">
      <div class="metric required"><b>{{ board.counts.requiredOpen }}</b><span>必须发送待处理</span></div>
      <div class="metric"><b>{{ board.counts.agentDecisionOpen }}</b><span>等待 Agent 判断</span></div>
      <div class="metric warning"><b>{{ board.counts.handedOff }}</b><span>已转交待返回</span></div>
      <div class="metric error"><b>{{ board.counts.overdue }}</b><span>已超时</span></div>
      <div class="metric error"><b>{{ board.counts.missingOutcome }}</b><span>Agent 无处理结果</span></div>
      <div class="metric error"><b>{{ board.counts.knowledgeCallbackOpen }}</b><span>计划/记忆待回调</span></div>
      <div class="metric error"><b>{{ board.counts.criticalFactOpen }}</b><span>项目事实待登记</span></div>
      <div class="metric success"><b>{{ board.counts.sent24h }}</b><span>24 小时内已发送</span></div>
    </div>

    <div v-if="visibleItems.length" class="board-list mt-3">
      <div v-for="item in visibleItems" :key="item.id" class="board-item">
        <div class="item-topline">
          <div class="item-labels">
            <v-chip size="x-small" :color="item.replyPolicy === 'required' ? 'error' : 'primary'" variant="tonal">{{ kindLabel(item) }}</v-chip>
            <v-chip size="x-small" variant="tonal">{{ routeLabel(item) }}</v-chip>
            <v-chip size="x-small" :color="statusColor(item)" variant="tonal">{{ statusLabel(item) }}</v-chip>
            <v-chip v-if="item.criticalFacts?.length" size="x-small" color="error" variant="tonal">项目关键信息</v-chip>
            <v-chip v-if="item.knowledgeMatches?.length" size="x-small" :color="pendingKnowledgeMatches(item).length ? 'error' : 'success'" variant="tonal">
              关联资料 {{ item.knowledgeMatches.length }} 项
            </v-chip>
          </div>
          <span class="item-time">{{ timeLabel(item.updatedAt) }}</span>
        </div>

        <div v-if="item.plan" class="item-title">{{ item.plan.planTitle }} · {{ item.plan.changes.join("；") }}</div>
        <div v-else class="item-title">{{ item.source.summary || "没有文本摘要" }}</div>
        <div class="item-meta">{{ item.source.endpoint }} · {{ item.source.conversationKey }} · {{ item.source.sender }}</div>

        <div class="item-details">
          <span v-if="item.worker">处理：{{ item.worker.threadName }}{{ workerRuntimeLabel(item) }}</span>
          <span v-if="item.handoff">转交：{{ item.handoff.targetThreadName || item.handoff.targetAgentType }}</span>
          <span v-if="item.decision?.reason">判断：{{ item.decision.reason }}</span>
          <span v-if="item.delivery?.sentMessageId">发送回执：{{ item.delivery.sentMessageId }}</span>
          <span v-if="item.criticalFactDisposition?.record">事实记录：{{ criticalFactRecordLabel(item) }}</span>
          <span v-else-if="item.criticalFacts?.length" class="text-error">仍需核对并写入计划、记忆或项目文档。</span>
          <div v-if="item.knowledgeMatches?.length" class="knowledge-list">
            <div v-for="match in item.knowledgeMatches" :key="knowledgeKey(match.type, match.id)" class="knowledge-row">
              <span>{{ knowledgeTypeLabel(match.type) }}：{{ match.title || match.id }}<template v-if="match.score != null">（{{ match.score }}）</template></span>
              <span :class="knowledgeCallback(item, match.type, match.id)?.result === 'deferred' || !knowledgeCallback(item, match.type, match.id) ? 'text-error' : 'text-success'">
                {{ knowledgeResultLabel(knowledgeCallback(item, match.type, match.id)?.result) }}
                <template v-if="knowledgeCallback(item, match.type, match.id)?.responseAction !== 'none'"> · {{ knowledgeCallback(item, match.type, match.id)?.responseAction }}</template>
              </span>
              <span v-if="knowledgeCallback(item, match.type, match.id)?.evidence" class="knowledge-evidence">{{ knowledgeCallback(item, match.type, match.id)?.evidence }}</span>
            </div>
            <span v-if="pendingKnowledgeMatches(item).length" class="text-error">回调截止：{{ timeLabel(item.knowledgeCallbackDueAt) }}；超时后 RabiManager 会再次投递给原 Agent。</span>
          </div>
          <span v-if="item.lastError" class="text-error">错误：{{ item.lastError }}</span>
          <span v-if="item.missingOutcome" class="text-error">Agent 轮次已经空闲，但没有通过接口提交回复、不回复或转交结果。</span>
          <span v-if="item.overdueMs > 0" class="text-error">已超时 {{ elapsed(item.overdueMs) }}</span>
          <span v-else-if="![ 'sent', 'not_required' ].includes(item.status)">截止：{{ timeLabel(item.dueAt) }}</span>
        </div>
      </div>
    </div>
    <v-alert v-else-if="!loading" type="success" variant="tonal" density="compact" class="mt-3">
      当前没有需要处理的消息发送需求。
    </v-alert>
  </div>
</template>

<style scoped>
.message-board { margin-top: 12px; padding: 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 12px; background: rgba(var(--v-theme-surface-variant), .18); }
.board-header, .item-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.board-actions, .item-labels { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.board-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 8px; }
.metric { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 9px; background: rgba(var(--v-theme-primary), .08); }
.metric b { font-size: 20px; line-height: 1; }
.metric span { color: var(--rr-muted); font-size: 12px; opacity: 1; }
.metric.required, .metric.error { background: rgba(var(--v-theme-error), .09); }
.metric.warning { background: rgba(var(--v-theme-warning), .11); }
.metric.success { background: rgba(var(--v-theme-success), .10); }
.board-list { display: flex; flex-direction: column; gap: 8px; }
.board-item { padding: 12px; border-radius: 10px; background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.item-time, .item-meta { color: var(--rr-muted-soft); font-size: 12px; opacity: 1; }
.item-title { margin-top: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
.item-meta { margin-top: 5px; }
.item-details { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; font-size: 12px; }
.knowledge-list { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; padding: 8px; border-radius: 8px; background: rgba(var(--v-theme-primary), .05); }
.knowledge-row { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 4px 12px; }
.knowledge-evidence { grid-column: 1 / -1; color: var(--rr-muted-soft); opacity: 1; overflow-wrap: anywhere; }
.text-success { color: var(--rr-success-text); }
@media (max-width: 720px) { .board-header { flex-direction: column; } .board-actions { width: 100%; justify-content: space-between; } }
</style>
