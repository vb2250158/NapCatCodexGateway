<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref, watch } from "vue";
import { translateText } from "../i18n";
import {
  personaSyncClient,
  type PersonaSyncAutoStatus,
  type PersonaSyncConflict,
  type PersonaSyncContent,
  type PersonaSyncIndexStatus,
  type PersonaSyncPeer,
  type PersonaSyncPreview,
  type PersonaSyncPreviewFile,
  type PersonaSyncResult
} from "../persona/personaSyncClient";

const props = withDefaults(defineProps<{
  roleId: string;
  manifestVersion?: number;
  peerVersion?: number;
}>(), {
  manifestVersion: 0,
  peerVersion: 0
});

const peers = ref<PersonaSyncPeer[]>([]);
const conflicts = ref<PersonaSyncConflict[]>([]);
const indexStatus = ref<PersonaSyncIndexStatus | null>(null);
const autoStatus = ref<PersonaSyncAutoStatus | null>(null);
const syncResult = ref<PersonaSyncResult | null>(null);
const comparison = ref<PersonaSyncPreview | null>(null);
const selectedPeerId = ref("");
const peerLoading = ref(false);
const localLoading = ref(false);
const comparisonLoading = ref(false);
const conflictLoading = ref(false);
const conflictsLoaded = ref(false);
const syncingPeerId = ref("");
const resolvingConflictId = ref("");
const peerError = ref("");
const localError = ref("");
const notice = ref("");
const previewOpen = ref(false);
const previewLoading = ref(false);
const previewError = ref("");
const previewConflict = ref<PersonaSyncConflict | null>(null);
const localPreview = ref("");
const remotePreview = ref("");

const syncablePeers = computed(() => peers.value.filter(peer => peer.online && peer.capabilities.includes("persona-sync")));
const selectedPeer = computed(() => peers.value.find(peer => peer.id === selectedPeerId.value || peer.guid === selectedPeerId.value) || null);
const changedPreviewFiles = computed(() => comparison.value?.files.filter(file => file.operation !== "unchanged") || []);
const semanticConflicts = computed(() => syncResult.value?.semanticConflicts || []);
const changedFiles = computed(() => syncResult.value?.files.filter(file => file.status !== "unchanged").length || 0);
const autoStatusLabel = computed(() => {
  switch (autoStatus.value?.state) {
    case "idle": return "自动对账已完成";
    case "scheduled": return "自动对账已排队";
    case "syncing": return "正在自动对账";
    case "waiting_relay": return "等待 Relay 恢复";
    case "waiting_peer": return "等待其它电脑上线";
    case "attention": return "自动对账需要确认";
    case "error": return "自动对账暂时失败";
    default: return "自动对账未运行";
  }
});
const autoStatusColor = computed(() => {
  switch (autoStatus.value?.state) {
    case "idle": return "success";
    case "attention":
    case "waiting_relay":
    case "waiting_peer": return "warning";
    case "error": return "error";
    default: return "info";
  }
});

function compactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function previewText(content: PersonaSyncContent, relativePath: string): string {
  if (content.bytes.byteLength === 0) return "（空文件）";
  const textLike = /\.(?:md|txt|json|jsonl|ya?ml|csv|xml|toml|ini)$/i.test(relativePath);
  if (!textLike || content.bytes.byteLength > 2 * 1024 * 1024) {
    return `二进制或大型文件 · ${content.bytes.byteLength} bytes · 不在页面展开`;
  }
  return new TextDecoder().decode(content.bytes);
}

function operationMeta(file: PersonaSyncPreviewFile): { marker: string; label: string; note: string; color: string; icon: string } {
  switch (file.operation) {
    case "pull_create": return { marker: "A", label: "从对方拉取", note: "本机将新增", color: "success", icon: "mdi-cloud-download-outline" };
    case "pull_update": return { marker: "M", label: "从对方更新", note: "本机将更新", color: "info", icon: "mdi-cloud-download-outline" };
    case "pull_delete": return { marker: "D", label: "采用对方删除", note: "本机将删除", color: "warning", icon: "mdi-delete-outline" };
    case "push_create": return { marker: "A", label: "推送到对方", note: "对方将新增", color: "secondary", icon: "mdi-cloud-upload-outline" };
    case "push_update": return { marker: "M", label: "推送本机更新", note: "对方将更新", color: "secondary", icon: "mdi-cloud-upload-outline" };
    case "push_delete": return { marker: "D", label: "推送本机删除", note: "对方将删除", color: "warning", icon: "mdi-delete-outline" };
    case "auto_merge": return { marker: "M", label: "自动合并记录", note: "两边都会收敛", color: "primary", icon: "mdi-source-merge" };
    case "conflict": return { marker: "!", label: "需要确认", note: "同步时不会覆盖", color: "error", icon: "mdi-alert-circle-outline" };
    default: return { marker: "✓", label: "已经一致", note: "无需处理", color: "success", icon: "mdi-check-circle-outline" };
  }
}

function compactBytes(value?: number): string {
  if (value == null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshPeers(): Promise<void> {
  if (!props.roleId) return;
  peerLoading.value = true;
  peerError.value = "";
  try {
    const result = await personaSyncClient.peers();
    peers.value = result.peers;
    if (!peers.value.some(peer => peer.id === selectedPeerId.value || peer.guid === selectedPeerId.value)) {
      selectedPeerId.value = syncablePeers.value[0]?.id || "";
    }
  } catch (error) {
    peers.value = [];
    peerError.value = userFacingError(error);
  } finally {
    peerLoading.value = false;
  }
}

async function refreshPreview(): Promise<void> {
  const peerId = selectedPeerId.value;
  if (!props.roleId || !peerId || comparisonLoading.value) {
    if (!peerId) comparison.value = null;
    return;
  }
  comparisonLoading.value = true;
  localError.value = "";
  try {
    comparison.value = await personaSyncClient.preview(peerId, props.roleId);
  } catch (error) {
    comparison.value = null;
    localError.value = userFacingError(error);
  } finally {
    comparisonLoading.value = false;
  }
}

async function refreshLocalState(): Promise<void> {
  if (!props.roleId) return;
  localLoading.value = true;
  localError.value = "";
  try {
    const [status, automatic] = await Promise.all([
      personaSyncClient.indexStatus(),
      personaSyncClient.autoStatus()
    ]);
    indexStatus.value = status;
    autoStatus.value = automatic;
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    localLoading.value = false;
  }
}

async function refreshConflicts(): Promise<void> {
  if (!props.roleId || conflictLoading.value) return;
  conflictLoading.value = true;
  localError.value = "";
  try {
    const result = await personaSyncClient.conflicts(props.roleId);
    conflicts.value = result.conflicts;
    conflictsLoaded.value = result.scan?.state !== "building";
    if (result.scan?.state === "building") {
      notice.value = "历史冲突正在后台整理，Manager 仍可正常使用；稍后再次点击“检查冲突”即可查看结果。";
    }
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    conflictLoading.value = false;
  }
}

async function refreshAll(): Promise<void> {
  notice.value = "";
  syncResult.value = null;
  await Promise.all([refreshPeers(), refreshLocalState()]);
  await refreshPreview();
}

async function syncPeer(peer: PersonaSyncPeer): Promise<void> {
  if (!props.roleId || syncingPeerId.value) return;
  syncingPeerId.value = peer.id;
  localError.value = "";
  notice.value = "";
  try {
    syncResult.value = await personaSyncClient.sync(peer.id, props.roleId);
    notice.value = syncResult.value.conflicts > 0
      ? "同步已完成传输，但仍有冲突需要确认。"
      : "当前人格已经和这台电脑收敛。";
    await Promise.all([refreshLocalState(), refreshConflicts()]);
    await refreshPreview();
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    syncingPeerId.value = "";
  }
}

async function openConflict(conflict: PersonaSyncConflict): Promise<void> {
  previewConflict.value = conflict;
  previewOpen.value = true;
  previewLoading.value = true;
  previewError.value = "";
  localPreview.value = "";
  remotePreview.value = "";
  try {
    const localRequest = personaSyncClient.localContent(conflict);
    const remoteRequest: Promise<PersonaSyncContent | null> = conflict.remoteDeleted
      ? Promise.resolve(null)
      : personaSyncClient.remoteContent(conflict.conflictId);
    const [local, remote] = await Promise.allSettled([localRequest, remoteRequest] as const);
    localPreview.value = local.status === "fulfilled"
      ? previewText(local.value, conflict.path)
      : "本机文件当前不存在或已经变化；解决时仍会重新校验版本。";
    if (remote.status === "rejected") throw remote.reason;
    remotePreview.value = remote.value ? previewText(remote.value, conflict.path) : "对方已删除这个文件";
  } catch (error) {
    previewError.value = userFacingError(error);
  } finally {
    previewLoading.value = false;
  }
}

async function resolveConflict(action: "keep_local" | "use_remote"): Promise<void> {
  const conflict = previewConflict.value;
  if (!conflict || resolvingConflictId.value) return;
  const adoptingDeletion = action === "use_remote" && conflict.remoteDeleted;
  const question = action === "keep_local"
    ? "确认保留本机版本，并尝试把这个决定发布回来源电脑？"
    : adoptingDeletion
      ? "对方版本是删除。确认删除本机文件，并尝试把决定发布回来源电脑？"
      : "确认用对方版本替换本机文件，并尝试把决定发布回来源电脑？";
  if (!window.confirm(translateText(question))) return;
  resolvingConflictId.value = conflict.conflictId;
  previewError.value = "";
  notice.value = "";
  try {
    const result = await personaSyncClient.resolve(conflict, action);
    notice.value = result.publish.status === "published"
      ? `冲突已解决，并通过${result.publish.transport === "lan" ? "局域网" : " Relay"}发布回来源电脑。`
      : `本机冲突已解决；来源电脑暂未收敛：${result.publish.message || "稍后需要再次显式同步。"}`;
    previewOpen.value = false;
    await Promise.all([refreshLocalState(), refreshConflicts()]);
  } catch (error) {
    previewError.value = userFacingError(error);
  } finally {
    resolvingConflictId.value = "";
  }
}

watch(() => props.roleId, roleId => {
  peers.value = [];
  conflicts.value = [];
  conflictsLoaded.value = false;
  indexStatus.value = null;
  autoStatus.value = null;
  syncResult.value = null;
  comparison.value = null;
  selectedPeerId.value = "";
  notice.value = "";
  if (roleId) void refreshAll();
}, { immediate: true });

watch(() => props.manifestVersion, () => {
  if (!props.roleId) return;
  void refreshLocalState();
  void refreshPreview();
  if (conflictsLoaded.value) void refreshConflicts();
});

watch(() => props.peerVersion, () => {
  if (!props.roleId) return;
  void refreshPeers().then(() => refreshPreview());
});

watch(selectedPeerId, () => {
  comparison.value = null;
  void refreshPreview();
});
</script>

<template>
  <div class="persona-sync-workbench">
    <div class="sync-status-strip">
      <div><span>当前人格</span><b data-no-i18n>{{ roleId }}</b></div>
      <div><span>可同步电脑</span><b>{{ syncablePeers.length }}</b></div>
      <div><span>本机人格文件</span><b>{{ indexStatus?.files ?? "-" }}</b></div>
      <div><span>待解决冲突</span><b>{{ conflictsLoaded ? conflicts.length : "未检查" }}</b></div>
    </div>

    <div class="sync-workbench-layout">
      <v-card class="app-card glass-card sync-peer-panel">
        <div class="sync-panel-heading">
          <div><strong>其它电脑</strong><span>选择要比较的人格文件夹</span></div>
          <v-btn icon="mdi-refresh" size="small" variant="text" :loading="peerLoading" aria-label="刷新设备" @click="refreshAll" />
        </div>

        <v-alert v-if="peerError" type="warning" variant="tonal" density="compact" class="sync-peer-error ma-3">
          {{ peerError }}
          <div class="mt-1">请让其它电脑使用同一个 RabiLink 应用 token。</div>
        </v-alert>
        <div v-if="peerLoading && peers.length === 0" class="sync-loading-row compact">
          <v-progress-circular indeterminate size="22" width="2" />
          <span>正在发现电脑…</span>
        </div>
        <div v-else-if="peers.length === 0 && !peerError" class="sync-peer-empty">
          <v-icon size="34">mdi-laptop-off</v-icon>
          <strong>暂未发现其它电脑</strong>
          <span>电脑上线或 Relay 重连后会自动刷新。</span>
        </div>
        <div v-else class="sync-peer-list">
          <button
            v-for="peer in peers"
            :key="peer.guid || peer.id"
            type="button"
            class="sync-peer-choice"
            :class="{ selected: selectedPeer?.id === peer.id, disabled: !peer.online || !peer.capabilities.includes('persona-sync') }"
            :disabled="!peer.online || !peer.capabilities.includes('persona-sync')"
            @click="selectedPeerId = peer.id"
          >
            <span class="sync-peer-mark" :class="{ online: peer.online }"><v-icon size="18">mdi-laptop</v-icon></span>
            <span class="sync-peer-copy">
              <strong data-no-i18n>{{ peer.name }}</strong>
              <small>{{ peer.online ? (peer.capabilities.includes("persona-sync") ? "在线 · 可比较" : "版本不支持人格同步") : "离线" }}</small>
            </span>
            <v-icon size="18">mdi-chevron-right</v-icon>
          </button>
        </div>

        <div class="sync-peer-panel-foot">
          <v-chip v-if="indexStatus" size="small" :color="indexStatus.state === 'ready' ? 'success' : indexStatus.state === 'fallback' ? 'warning' : undefined" variant="tonal">
            {{ indexStatus.watchMode === "recursive" ? "文件变化已监听" : indexStatus.watchMode === "query_reconcile" ? "比较时重新检查" : "索引只读" }}
          </v-chip>
          <v-chip v-if="autoStatus" size="small" :color="autoStatusColor" variant="tonal">{{ autoStatusLabel }}</v-chip>
        </div>
      </v-card>

      <v-card class="app-card glass-card sync-files-panel">
        <div class="sync-files-toolbar">
          <div>
            <span class="sync-eyebrow">CHANGED FILES</span>
            <h2>人格文件变化</h2>
            <p v-if="selectedPeer" data-no-i18n>{{ roleId }} ↔ {{ selectedPeer.name }}</p>
            <p v-else>先从左侧选择一台电脑。</p>
          </div>
          <div class="d-flex ga-2 flex-wrap justify-end">
            <v-chip v-if="comparison" size="small" :color="comparison.conflicts ? 'warning' : comparison.changedFiles ? 'info' : 'success'" variant="tonal">
              {{ comparison.changedFiles }} 个变化 · {{ comparison.conflicts }} 个冲突
            </v-chip>
            <v-chip v-if="comparison" size="small" variant="tonal">{{ comparison.transport === "lan" ? "局域网直连" : "Relay 中转" }}</v-chip>
            <v-btn size="small" variant="text" prepend-icon="mdi-source-branch-sync" :loading="comparisonLoading" :disabled="!selectedPeer" @click="refreshPreview">重新比较</v-btn>
          </div>
        </div>

        <div class="sync-files-body">
          <v-alert v-if="localError" type="error" variant="tonal" density="compact" class="ma-4">{{ localError }}</v-alert>
          <v-alert v-if="autoStatus?.lastError" type="warning" variant="tonal" density="compact" class="ma-4">
            自动同步仍保留待处理标记：{{ autoStatus.lastError }}
          </v-alert>
          <v-alert v-if="notice" :type="syncResult?.conflicts ? 'warning' : 'success'" variant="tonal" density="compact" class="ma-4">{{ notice }}</v-alert>

          <div v-if="comparisonLoading" class="sync-loading-row">
            <v-progress-circular indeterminate size="26" width="2" />
            <span>正在比较两台电脑的人格文件夹…</span>
          </div>
          <div v-else-if="!selectedPeer" class="sync-files-empty">
            <v-icon size="42">mdi-folder-search-outline</v-icon>
            <strong>选择一台电脑开始比较</strong>
            <span>这里只读取文件清单和哈希，不会在比较时修改任何人格文件。</span>
          </div>
          <div v-else-if="comparison && changedPreviewFiles.length === 0" class="sync-files-empty">
            <v-icon color="success" size="42">mdi-check-decagram-outline</v-icon>
            <strong>人格文件夹已经一致</strong>
            <span>本机和所选电脑没有待拉取、待推送或待确认的文件。</span>
          </div>
          <div v-else-if="comparison" class="changed-files-list">
            <article v-for="file in changedPreviewFiles" :key="`${file.roleId}/${file.path}`" class="changed-file-row">
              <span class="changed-file-marker" :class="`is-${operationMeta(file).color}`">{{ operationMeta(file).marker }}</span>
              <v-icon :color="operationMeta(file).color" size="19">{{ operationMeta(file).icon }}</v-icon>
              <div class="changed-file-copy">
                <strong data-no-i18n>{{ file.path }}</strong>
                <span>{{ operationMeta(file).label }} · {{ operationMeta(file).note }}</span>
              </div>
              <div class="changed-file-size">
                <span>本机 {{ compactBytes(file.localSize) }}</span>
                <span>对方 {{ compactBytes(file.remoteSize) }}</span>
              </div>
            </article>
          </div>
        </div>

        <div class="sync-files-footer">
          <div>
            <strong>{{ comparison?.conflicts ? "存在冲突，安全文件仍可同步" : comparison?.changedFiles ? "准备同步人格文件夹" : "等待文件变化" }}</strong>
            <span>同步会按共同基线拉取、推送或合并；冲突文件不会被最后写入者直接覆盖。</span>
          </div>
          <v-btn
            color="secondary"
            size="large"
            prepend-icon="mdi-folder-sync-outline"
            :loading="Boolean(selectedPeer && syncingPeerId === selectedPeer.id)"
            :disabled="!selectedPeer || Boolean(syncingPeerId) || comparisonLoading"
            @click="selectedPeer && syncPeer(selectedPeer)"
          >拉取并同步</v-btn>
        </div>
      </v-card>
    </div>

    <v-card class="app-card glass-card section-card sync-conflict-panel">
      <div class="section-title-row">
        <div>
          <div class="section-title">文件冲突</div>
          <div class="section-note">只有点击检查后才读取历史冲突证据；比较文件夹不会遍历这部分历史。</div>
        </div>
        <v-btn size="small" variant="text" prepend-icon="mdi-file-alert-outline" :loading="conflictLoading" @click="refreshConflicts">检查冲突</v-btn>
      </div>
      <div v-if="conflicts.length || semanticConflicts.length" class="sync-conflicts">
        <button v-for="conflict in conflicts" :key="conflict.conflictId" type="button" class="sync-conflict-row" @click="openConflict(conflict)">
          <v-icon color="warning" size="20">mdi-file-alert-outline</v-icon>
          <span class="sync-conflict-copy">
            <strong data-no-i18n>{{ conflict.path }}</strong>
            <small>{{ conflict.remoteDeleted ? "对方删除 / 本机保留" : "双方文件都发生了修改" }} · {{ compactTime(conflict.createdAt) }}</small>
          </span>
          <v-icon size="18">mdi-chevron-right</v-icon>
        </button>
        <div
          v-for="conflict in semanticConflicts"
          :key="conflict.kind === 'persona_voice_identity' ? `voice:${conflict.identityKey}` : `identity:${conflict.recordKind}:${conflict.recordId}`"
          class="sync-conflict-row semantic-row"
        >
          <v-icon color="warning" size="20">{{ conflict.kind === "persona_voice_identity" ? "mdi-account-voice" : "mdi-account-search-outline" }}</v-icon>
          <span v-if="conflict.kind === 'persona_voice_identity'" class="sync-conflict-copy">
            <strong>语音账号归类存在多电脑分支</strong>
            <small>返回人格配置，在“身份关系”的语音消息端账号中重新确认。</small>
          </span>
          <span v-else class="sync-conflict-copy">
            <strong>身份关系存在多电脑分支</strong>
            <small>返回人格配置，在“身份关系”中比较候选记录并保存完整修正。</small>
          </span>
        </div>
      </div>
      <div v-else-if="conflictsLoaded" class="sync-inline-empty"><v-icon color="success">mdi-check-circle-outline</v-icon><span>没有待解决的文件冲突。</span></div>
      <div v-else class="sync-inline-empty"><v-icon>mdi-file-question-outline</v-icon><span>尚未检查历史冲突。</span></div>
    </v-card>

    <v-alert type="info" variant="tonal" density="compact">
      同步对象是当前人格的整个文件夹，不是头像。人格正文、计划、可同步记忆、技能和配置会按文件规则比较；运行期历史、锁文件和临时文件不会加入同步。
    </v-alert>

    <v-dialog v-model="previewOpen" max-width="1120">
      <v-card class="app-card sync-preview-dialog">
        <v-card-title class="d-flex justify-space-between align-center ga-3">
          <div class="min-w-0">
            <div class="section-title">确认文件冲突</div>
            <div class="section-note text-truncate" data-no-i18n>{{ previewConflict?.path }}</div>
          </div>
          <v-btn icon="mdi-close" variant="text" @click="previewOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-alert v-if="previewError" type="error" variant="tonal" density="compact" class="mb-3">{{ previewError }}</v-alert>
          <div v-if="previewLoading" class="sync-loading-row"><v-progress-circular indeterminate size="24" width="2" /><span>正在读取本机和对方证据…</span></div>
          <div v-else class="sync-preview-grid">
            <section>
              <div class="sync-preview-title"><strong>本机版本</strong><span>当前人格文件</span></div>
              <pre data-no-i18n>{{ localPreview }}</pre>
            </section>
            <section>
              <div class="sync-preview-title"><strong>对方版本</strong><span>{{ previewConflict?.remoteDeleted ? "删除意图" : "冲突证据" }}</span></div>
              <pre data-no-i18n>{{ remotePreview }}</pre>
            </section>
          </div>
        </v-card-text>
        <v-card-actions class="px-6 pb-5 flex-wrap">
          <span class="section-note">需要手工合并正文时，仍可让本机 Agent 调用 <code>use_merged</code> 接口。</span>
          <v-spacer />
          <v-btn variant="tonal" :loading="resolvingConflictId === previewConflict?.conflictId" @click="resolveConflict('keep_local')">保留本机</v-btn>
          <v-btn color="warning" variant="tonal" :loading="resolvingConflictId === previewConflict?.conflictId" @click="resolveConflict('use_remote')">
            {{ previewConflict?.remoteDeleted ? "采用对方删除" : "采用对方版本" }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.persona-sync-workbench {
  display: grid;
  gap: 16px;
}

.sync-status-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.sync-status-strip > div {
  padding: 12px 14px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 14px;
  background: rgba(var(--v-theme-surface), .48);
}

.sync-status-strip span,
.sync-peer-copy small,
.sync-panel-heading span,
.sync-files-toolbar p,
.sync-files-footer span {
  display: block;
  color: var(--rr-muted-soft);
  font-size: 12px;
  opacity: 1;
}

.sync-status-strip b {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-workbench-layout {
  display: grid;
  grid-template-columns: minmax(250px, 310px) minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}

.sync-peer-panel,
.sync-files-panel {
  overflow: hidden;
}

.sync-peer-panel {
  display: flex;
  min-height: 570px;
  flex-direction: column;
}

.sync-panel-heading,
.sync-files-toolbar,
.sync-files-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.sync-panel-heading {
  padding: 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.sync-panel-heading > div,
.sync-files-footer > div {
  min-width: 0;
}

.sync-panel-heading strong,
.sync-files-footer strong {
  display: block;
}

.sync-loading-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 96px;
  color: var(--rr-muted-soft);
  opacity: 1;
}

.sync-loading-row.compact {
  min-height: 160px;
}

.sync-peer-list {
  display: grid;
  gap: 4px;
  padding: 8px;
}

.sync-peer-choice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.sync-peer-choice:hover,
.sync-peer-choice.selected {
  border-color: rgba(var(--v-theme-secondary), .28);
  background: rgba(var(--v-theme-secondary), .09);
}

.sync-peer-choice.disabled {
  border-color: var(--rr-border-soft);
  color: var(--rr-muted);
  background: var(--rr-subtle);
  cursor: not-allowed;
  opacity: 1;
}

.sync-peer-choice.disabled :is(.sync-peer-mark, .sync-peer-copy strong, .sync-peer-copy small) {
  color: var(--rr-muted);
}

.sync-peer-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: var(--rr-muted-faint);
  background: rgba(var(--v-theme-on-surface), .06);
}

.sync-peer-mark.online {
  color: var(--rr-success-text);
  background: rgba(var(--v-theme-success), .12);
}

.sync-peer-copy {
  min-width: 0;
}

.sync-peer-copy strong,
.sync-peer-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-peer-empty,
.sync-files-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  min-height: 250px;
  padding: 24px;
  color: var(--rr-muted-soft);
  text-align: center;
  opacity: 1;
}

.sync-peer-panel-foot {
  display: flex;
  gap: 7px;
  margin-top: auto;
  padding: 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex-wrap: wrap;
}

.sync-peer-error {
  flex: 0 0 auto;
}

.sync-files-panel {
  display: flex;
  min-height: 570px;
  flex-direction: column;
}

.sync-files-toolbar {
  padding: 16px 18px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.sync-eyebrow {
  color: var(--rr-accent-text);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .14em;
}

.sync-files-toolbar h2 {
  margin: 2px 0 0;
  font-size: 20px;
}

.sync-files-toolbar p {
  margin: 2px 0 0;
}

.sync-files-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.changed-files-list {
  display: grid;
}

.changed-file-row {
  display: grid;
  grid-template-columns: 28px 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 58px;
  padding: 9px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.changed-file-marker {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font: 800 12px/1 "Cascadia Mono", Consolas, monospace;
  background: rgba(var(--v-theme-on-surface), .07);
}

.changed-file-marker.is-success { color: var(--rr-success-text); background: rgba(var(--v-theme-success), .12); }
.changed-file-marker.is-info { color: var(--rr-info-text); background: rgba(var(--v-theme-info), .12); }
.changed-file-marker.is-secondary { color: var(--rr-accent-text); background: rgba(var(--v-theme-secondary), .12); }
.changed-file-marker.is-primary { color: var(--rr-accent-text); background: rgba(var(--v-theme-primary), .12); }
.changed-file-marker.is-warning { color: var(--rr-warning-text); background: rgba(var(--v-theme-warning), .12); }
.changed-file-marker.is-error { color: var(--rr-error-text); background: rgba(var(--v-theme-error), .12); }

.changed-file-copy {
  min-width: 0;
}

.changed-file-copy strong,
.changed-file-copy span,
.changed-file-size span {
  display: block;
}

.changed-file-copy strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.changed-file-copy span,
.changed-file-size {
  color: var(--rr-muted-faint);
  font-size: 11px;
  opacity: 1;
}

.changed-file-size {
  min-width: 108px;
  text-align: right;
}

.sync-files-footer {
  padding: 14px 16px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface), .76);
}

.sync-inline-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 70px;
  color: var(--rr-muted-soft);
  opacity: 1;
}

.sync-conflicts {
  display: grid;
  gap: 8px;
}

.sync-conflict-row {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
  color: inherit;
  text-align: left;
  border: 1px solid rgba(var(--v-theme-warning), .24);
  border-radius: 14px;
  background: rgba(var(--v-theme-warning), .07);
}

button.sync-conflict-row {
  cursor: pointer;
  transition: transform .16s ease, border-color .16s ease, background .16s ease;
}

button.sync-conflict-row:hover {
  transform: translateY(-1px);
  border-color: rgba(var(--v-theme-warning), .46);
  background: rgba(var(--v-theme-warning), .11);
}

.semantic-row {
  grid-template-columns: auto minmax(0, 1fr);
}

.sync-conflict-copy strong,
.sync-conflict-copy small {
  display: block;
}

.sync-conflict-copy small {
  margin-top: 2px;
  color: var(--rr-muted-soft);
  opacity: 1;
}

.sync-preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.sync-preview-grid section {
  min-width: 0;
}

.sync-preview-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.sync-preview-title span {
  color: var(--rr-muted-faint);
  font-size: 12px;
  opacity: 1;
}

.sync-preview-grid pre {
  min-height: 340px;
  max-height: 58vh;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 14px;
  background: rgba(6, 12, 20, .78);
  color: #d8e6ef;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.6 "Cascadia Mono", Consolas, monospace;
}

@media (max-width: 820px) {
  .sync-status-strip,
  .sync-workbench-layout,
  .sync-preview-grid {
    grid-template-columns: 1fr;
  }

  .sync-peer-panel,
  .sync-files-panel {
    min-height: auto;
  }

  .sync-files-toolbar,
  .sync-files-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .changed-file-row {
    grid-template-columns: 28px 24px minmax(0, 1fr);
  }

  .changed-file-size {
    display: none;
  }
}
</style>
