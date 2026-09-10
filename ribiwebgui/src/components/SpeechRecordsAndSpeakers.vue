<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import type {
  SpeechRecord,
  SpeechSpeakerBinding,
  SpeechSpeakerProfile,
  SpeechTranscriptSegment
} from "@shared/speechControlContract";
import { useI18n } from "../i18n";
import {
  formatSpeechEpochSeconds,
  speechAudioCacheReferenceKind
} from "../speech/speechRecordPresentation";
import { unknownVoiceprintGroupLabel, voiceprintPresentation } from "../speech/speechSpeakerPresentation";
import { useSpeechStore } from "../stores/speechStore";

const props = withDefaults(defineProps<{
  sessionId?: string;
  routeId?: string;
}>(), {
  sessionId: "",
  routeId: ""
});

type SpeakerDraft = { displayName: string; aliases: string[] };
type BindingTarget = {
  sessionId: string;
  recordId: string;
  speakerLabel: string;
  speakerName?: string;
};
type SpeakerPreviewLine = BindingTarget & {
  key: string;
  time: number;
  text: string;
  speakerId?: string;
  speakerClusterId?: string;
  speakerScore?: number;
  speakerSuggestionId?: string;
  speakerSuggestionName?: string;
};
type SpeakerPreviewGroup = {
  key: string;
  title: string;
  known: boolean;
  total: number;
  sessionIds: string[];
  speakerLabels: string[];
  lines: SpeakerPreviewLine[];
};

const speech = useSpeechStore();
const { locale } = useI18n();
const {
  records,
  recordsLoading,
  speakerRegistry,
  speakersLoading,
  status
} = storeToRefs(speech);

const localError = ref("");
const actionMessage = ref("");
const profileDialog = ref(false);
const bindingDialog = ref(false);
const speakerPreviewPanels = ref<number[]>([0]);
const actionBusy = ref(false);
const newSpeakerName = ref("");
const newSpeakerAliases = ref<string[]>([]);
const speakerDrafts = ref<Record<string, SpeakerDraft>>({});
const bindingTarget = ref<BindingTarget | null>(null);
const selectedSpeakerId = ref("");

const profiles = computed(() => speakerRegistry.value?.profiles ?? []);
const bindings = computed(() => speakerRegistry.value?.bindings ?? []);
const capability = computed(() => speakerRegistry.value?.capability ?? status.value?.speakerIdentity);
const voiceprintSupported = computed(() => capability.value?.voiceprint.supported === true);
const experimentalAutoAssign = computed(() => (
  capability.value?.voiceprint.available === true
  && capability.value?.voiceprint.experimental === true
  && capability.value?.voiceprint.autoAssign === true
));
const voiceprintStatus = computed(() => voiceprintPresentation(capability.value));
const voiceprintReason = computed(() => capability.value?.voiceprint.reason?.trim() ?? "");
const speakerCapabilityDescription = computed(() => {
  if (!capability.value) return "正在读取本机声纹模型与人物资料状态。";
  if (voiceprintSupported.value) return "人物资料、人工确认原型和已校准的自动认人共用本机资料库。";
  if (experimentalAutoAssign.value) return "人物资料与人工确认原型共用本机资料库；自动认人处于明确启用的实验状态。";
  if (capability.value.voiceprint.available) return "人物资料与人工确认原型共用本机资料库；当前只提供声纹聚类和候选提示。";
  return "人物资料、别名和人工绑定共用本机资料库；自动声纹 matcher 当前不可用。";
});

const speakerPreviewLines = computed<SpeakerPreviewLine[]>(() => records.value
  .filter(record => record.kind === "asr" && Boolean(record.sessionId))
  .flatMap(record => record.segments
    .filter(segment => Boolean(diarizationLabel(segment).trim()) && Boolean(segment.text.trim()))
    .map(segment => ({
      key: `${record.id}-${segment.id}-${segment.start}`,
      time: record.time + Math.max(0, segment.start || 0),
      text: segment.text.trim(),
      sessionId: String(record.sessionId),
      recordId: record.id,
      speakerLabel: diarizationLabel(segment).trim(),
      speakerId: segment.speakerId,
      speakerName: segment.speakerName,
      speakerClusterId: segment.speakerClusterId,
      speakerScore: segment.speakerScore,
      speakerSuggestionId: segment.speakerSuggestionId,
      speakerSuggestionName: segment.speakerSuggestionName
    })))
  .sort((left, right) => right.time - left.time));

function previewGroups(known: boolean): SpeakerPreviewGroup[] {
  const grouped = new Map<string, SpeakerPreviewLine[]>();
  for (const line of speakerPreviewLines.value) {
    const isKnown = Boolean(line.speakerId || line.speakerName);
    if (isKnown !== known) continue;
    const key = known
      ? `known:${line.speakerId || line.speakerName}`
      : line.speakerClusterId
        ? `unknown-cluster:${line.speakerClusterId}`
        : `unknown:${line.recordId}:${line.speakerLabel.toLocaleLowerCase()}`;
    const current = grouped.get(key) ?? [];
    current.push(line);
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, lines]) => ({
    key,
    known,
    title: known
      ? (lines[0]?.speakerName || "已知说话人")
      : unknownVoiceprintGroupLabel(lines[0]?.speakerClusterId),
    total: lines.length,
    sessionIds: [...new Set(lines.map(line => line.sessionId))],
    speakerLabels: [...new Set(lines.map(line => line.speakerLabel))],
    lines: lines.slice(0, 10)
  }));
}

const unknownSpeakerGroups = computed(() => previewGroups(false));
const knownSpeakerGroups = computed(() => previewGroups(true));
const bindingPreviewLines = computed(() => {
  const target = bindingTarget.value;
  if (!target) return [];
  const normalizedLabel = target.speakerLabel.toLocaleLowerCase();
  return speakerPreviewLines.value.filter(line => (
    line.recordId === target.recordId
    && line.speakerLabel.toLocaleLowerCase() === normalizedLabel
  )).slice(0, 10);
});

function normalizedAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))];
}

function syncSpeakerDrafts(): void {
  speakerDrafts.value = Object.fromEntries(profiles.value.map(profile => [
    profile.id,
    { displayName: profile.displayName, aliases: [...profile.aliases] }
  ]));
}

function formatTime(value: number): string {
  return formatSpeechEpochSeconds(value, locale.value);
}

function cacheReferenceKind(record: SpeechRecord) {
  return speechAudioCacheReferenceKind(record.audioFile);
}

function sourceAudioAvailable(record: SpeechRecord): boolean {
  return Boolean(
    record.kind === "asr"
    && record.audioFile
    && (!record.audioExpiresAt || record.audioExpiresAt > Date.now() / 1000)
  );
}

function segmentLabel(segment: SpeechTranscriptSegment): string {
  return segment.speakerName || segment.speakerLabel || segment.speaker || "未标注说话人";
}

function diarizationLabel(segment: SpeechTranscriptSegment): string {
  return segment.speakerLabel || segment.speaker || "";
}

function bindingFor(recordId: string, speakerLabel: string): SpeechSpeakerBinding | undefined {
  const normalized = speakerLabel.toLocaleLowerCase();
  return bindings.value.find(item => (
    item.recordId === recordId
    && item.speakerLabel.toLocaleLowerCase() === normalized
  ));
}

function openBinding(record: SpeechRecord, segment: SpeechTranscriptSegment): void {
  const sessionId = String(record.sessionId || "").trim();
  const speakerLabel = diarizationLabel(segment).trim();
  if (!sessionId || !speakerLabel) return;
  openBindingTarget(
    { sessionId, recordId: record.id, speakerLabel, speakerName: segment.speakerName },
    segment.speakerId || segment.speakerSuggestionId
  );
}

function openBindingTarget(target: BindingTarget, suggestedSpeakerId?: string): void {
  const current = bindingFor(target.recordId, target.speakerLabel);
  bindingTarget.value = target;
  selectedSpeakerId.value = current?.speakerId || suggestedSpeakerId || profiles.value[0]?.id || "";
  localError.value = "";
  actionMessage.value = "";
  bindingDialog.value = true;
}

function openPreviewBinding(group: SpeakerPreviewGroup): void {
  const latest = group.lines[0];
  if (!latest) return;
  openBindingTarget(latest, latest.speakerId || latest.speakerSuggestionId);
}

function visibleRecordsQuery() {
  return {
    limit: 100,
    sessionId: props.sessionId || undefined,
    routeId: props.routeId || undefined
  };
}

function refreshVisibleRecords(): Promise<void> {
  return speech.refreshRecords(visibleRecordsQuery());
}

async function refreshData(): Promise<void> {
  localError.value = "";
  try {
    await Promise.all([
      refreshVisibleRecords(),
      speech.refreshSpeakers()
    ]);
  } catch (error) {
    localError.value = userFacingError(error);
  }
}

async function createSpeaker(): Promise<void> {
  const displayName = newSpeakerName.value.trim();
  if (!displayName || actionBusy.value) return;
  actionBusy.value = true;
  localError.value = "";
  try {
    await speech.createSpeaker({ displayName, aliases: normalizedAliases(newSpeakerAliases.value) });
    newSpeakerName.value = "";
    newSpeakerAliases.value = [];
    syncSpeakerDrafts();
    actionMessage.value = "说话人资料已创建。";
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    actionBusy.value = false;
  }
}

async function saveSpeaker(profile: SpeechSpeakerProfile): Promise<void> {
  const draft = speakerDrafts.value[profile.id];
  if (!draft?.displayName.trim() || actionBusy.value) return;
  actionBusy.value = true;
  localError.value = "";
  try {
    await speech.updateSpeaker(profile.id, {
      displayName: draft.displayName.trim(),
      aliases: normalizedAliases(draft.aliases)
    });
    syncSpeakerDrafts();
    await refreshVisibleRecords();
    actionMessage.value = "说话人资料已更新，历史记录显示名已重新解析。";
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    actionBusy.value = false;
  }
}

async function deleteSpeaker(profile: SpeechSpeakerProfile): Promise<void> {
  if (actionBusy.value) return;
  if (!window.confirm(`删除说话人资料“${profile.displayName}”？关联的手工绑定也会解除。`)) return;
  actionBusy.value = true;
  localError.value = "";
  try {
    const result = await speech.deleteSpeaker(profile.id);
    syncSpeakerDrafts();
    await refreshVisibleRecords();
    actionMessage.value = `已删除说话人资料，并解除 ${result.removedBindings} 条绑定。`;
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    actionBusy.value = false;
  }
}

async function bindSelectedSpeaker(): Promise<void> {
  const target = bindingTarget.value;
  if (!target || !selectedSpeakerId.value || actionBusy.value) return;
  actionBusy.value = true;
  localError.value = "";
  try {
    await speech.bindSpeaker({
      sessionId: target.sessionId,
      recordId: target.recordId,
      speakerLabel: target.speakerLabel,
      speakerId: selectedSpeakerId.value
    });
    await refreshVisibleRecords();
    actionMessage.value = "说话人绑定已保存；只修正当前录音中的相同分段标签。";
    bindingDialog.value = false;
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    actionBusy.value = false;
  }
}

async function unbindSelectedSpeaker(): Promise<void> {
  const target = bindingTarget.value;
  if (!target || actionBusy.value) return;
  actionBusy.value = true;
  localError.value = "";
  try {
    await speech.unbindSpeaker(target.sessionId, target.recordId, target.speakerLabel);
    await refreshVisibleRecords();
    actionMessage.value = "已解除说话人绑定；记录恢复显示原始分段标签。";
    bindingDialog.value = false;
  } catch (error) {
    localError.value = userFacingError(error);
  } finally {
    actionBusy.value = false;
  }
}

watch(profiles, syncSpeakerDrafts, { immediate: true });
watch(() => [props.sessionId, props.routeId], () => void refreshData());
watch(() => speech.recordsVersion, () => void refreshVisibleRecords().catch(() => undefined));

onMounted(() => {
  void refreshData();
});
</script>

<template>
  <section class="speaker-records-panel">
    <div class="speaker-records-head">
      <div>
        <strong>最近 ASR/TTS 双向记录</strong>
        <span>读取后台持久化的双向文本记录；ASR 只缓存实际送入识别的短语音 24 小时，可直接回听，不保存全天连续原始录音。</span>
      </div>
      <div class="speaker-record-actions">
        <v-btn
          size="small"
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="recordsLoading || speakersLoading"
          @click="refreshData"
        >
          刷新记录
        </v-btn>
        <v-btn
          size="small"
          color="secondary"
          variant="tonal"
          prepend-icon="mdi-account-multiple-outline"
          @click="profileDialog = true"
        >
          说话人 / 声纹设置
        </v-btn>
      </div>
    </div>

    <v-alert v-if="localError" class="mb-3" type="error" variant="tonal" density="compact">
      {{ localError }}
    </v-alert>
    <v-alert v-if="actionMessage" class="mb-3" type="success" variant="tonal" density="compact" closable @click:close="actionMessage = ''">
      {{ actionMessage }}
    </v-alert>
    <v-alert class="speaker-boundary" type="info" variant="tonal" density="compact">
      <div class="speaker-boundary-title">
        <strong>Speaker 1 / Speaker 2 只是当前会话里的分段标签，不是生物声纹身份。</strong>
        <v-chip size="small" :color="voiceprintStatus.color" :variant="voiceprintStatus.color === 'grey' ? 'outlined' : 'tonal'">{{ voiceprintStatus.label }}</v-chip>
      </div>
      <span v-if="experimentalAutoAssign">
        实验性自动认人已显式开启，但尚未通过本机基准；界面会保留人工确认入口，并明确标记实验结果。
      </span>
      <span v-else-if="capability?.voiceprint.available && !voiceprintSupported">
        当前只能通过 <code>recordId + speakerLabel</code> 手工绑定或纠正“谁是谁”。模型未通过本机基准前，即使可提取 embedding，也只做未知聚类和候选提示，不会强行认人。
      </span>
      <span v-else-if="voiceprintSupported">
        当前服务声明支持声纹能力；分段标签仍需结合明确身份结果展示。
      </span>
      <span v-else-if="capability">
        自动声纹 matcher 当前不可用，仍可使用当前录音范围内的人工绑定与纠正。
      </span>
      <small v-if="voiceprintReason" class="speaker-capability-reason">{{ voiceprintReason }}</small>
    </v-alert>

    <v-expansion-panels v-model="speakerPreviewPanels" multiple class="speaker-preview-panels">
      <v-expansion-panel>
        <v-expansion-panel-title>
          <div class="speaker-preview-panel-title">
            <span>未知说话人</span>
            <v-chip size="x-small" color="warning" variant="tonal">{{ unknownSpeakerGroups.length }}</v-chip>
            <small>{{ capability?.voiceprint.available ? "优先按声纹聚类，过短片段仍按当前录音分组" : "按当前录音的分段标签分组" }}</small>
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div v-if="unknownSpeakerGroups.length" class="speaker-preview-grid">
            <article v-for="group in unknownSpeakerGroups" :key="group.key" class="speaker-preview-card unknown">
              <div class="speaker-preview-card-head">
                <div>
                  <strong>{{ group.title }}</strong>
                  <span data-no-i18n>{{ group.sessionIds[0] }}</span>
                </div>
                <v-btn size="small" color="secondary" variant="tonal" @click="openPreviewBinding(group)">
                  标注为某人
                </v-btn>
              </div>
              <div class="speaker-preview-count">已看到 {{ group.total }} 句话 · 预览最近 {{ Math.min(10, group.total) }} 句</div>
              <ol class="speaker-preview-lines">
                <li v-for="line in group.lines" :key="line.key">
                  <time>{{ formatTime(line.time) }}</time>
                  <span>{{ line.text }}</span>
                </li>
              </ol>
            </article>
          </div>
          <div v-else class="speaker-record-empty compact-speaker-empty">当前记录里没有待标注的说话人。</div>
        </v-expansion-panel-text>
      </v-expansion-panel>

      <v-expansion-panel>
        <v-expansion-panel-title>
          <div class="speaker-preview-panel-title">
            <span>已知说话人</span>
            <v-chip size="x-small" color="success" variant="tonal">{{ knownSpeakerGroups.length }}</v-chip>
            <small>按人物资料聚类</small>
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div v-if="knownSpeakerGroups.length" class="speaker-preview-grid">
            <article v-for="group in knownSpeakerGroups" :key="group.key" class="speaker-preview-card known">
              <div class="speaker-preview-card-head">
                <div>
                  <strong>{{ group.title }}</strong>
                  <span data-no-i18n>{{ group.speakerLabels.join(" / ") }}</span>
                </div>
                <v-btn size="small" variant="text" @click="openPreviewBinding(group)">纠正最近绑定</v-btn>
              </div>
              <div class="speaker-preview-count">
                {{ group.sessionIds.length }} 个会话 · {{ group.total }} 句话 · 预览最近 {{ Math.min(10, group.total) }} 句
              </div>
              <ol class="speaker-preview-lines">
                <li v-for="line in group.lines" :key="line.key">
                  <time>{{ formatTime(line.time) }}</time>
                  <span>{{ line.text }}</span>
                </li>
              </ol>
            </article>
          </div>
          <div v-else class="speaker-record-empty compact-speaker-empty">当前记录里还没有已绑定的人物。</div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <div v-if="records.length" class="speech-record-list">
      <article v-for="record in records" :key="record.id" class="speech-record-row">
        <div class="speech-record-meta">
          <v-chip size="x-small" :color="record.kind === 'asr' ? 'info' : 'secondary'" variant="tonal">
            {{ record.kind.toUpperCase() }}
          </v-chip>
          <time>{{ formatTime(record.time) }}</time>
          <span>{{ record.provider }}/{{ record.model }}</span>
          <span v-if="record.sessionId" data-no-i18n>session: {{ record.sessionId }}</span>
          <span v-if="record.routeId" data-no-i18n>Route: {{ record.routeId }}</span>
          <span v-if="record.kind === 'tts' && record.voice" data-no-i18n>voice: {{ record.voice }}</span>
        </div>

        <div v-if="record.kind === 'tts' && (record.audioFile || record.audioExpiresAt)" class="speech-record-cache">
          <div v-if="record.audioFile" class="speech-record-cache-fact">
            <span>{{ cacheReferenceKind(record) === 'legacy-filename' ? "缓存文件（旧记录）" : "相对缓存路径" }}</span>
            <code data-no-i18n>{{ record.audioFile }}</code>
          </div>
          <div v-if="record.audioExpiresAt" class="speech-record-cache-fact">
            <span>预计过期时间</span>
            <time data-no-i18n>{{ formatTime(record.audioExpiresAt) }}</time>
          </div>
        </div>

        <div v-if="record.kind === 'asr' && record.segments.length" class="speech-segment-list">
          <div v-for="segment in record.segments" :key="`${record.id}-${segment.id}-${segment.start}`" class="speech-segment-row">
            <div class="speech-segment-speaker">
              <v-chip size="small" :color="segment.speakerName ? 'success' : 'warning'" variant="tonal">
                {{ segmentLabel(segment) }}
              </v-chip>
              <small v-if="segment.speakerName && diarizationLabel(segment)" data-no-i18n>
                {{ diarizationLabel(segment) }}
              </small>
              <v-btn
                v-if="record.sessionId && diarizationLabel(segment)"
                size="x-small"
                variant="text"
                prepend-icon="mdi-account-switch-outline"
                @click="openBinding(record, segment)"
              >
                绑定 / 纠正
              </v-btn>
            </div>
            <p>{{ segment.text }}</p>
          </div>
        </div>
        <p v-else class="speech-record-text">{{ record.text }}</p>
        <div v-if="record.kind === 'asr' && (record.audioFile || record.audioExpiresAt)" class="speech-record-source-audio">
          <audio
            v-if="sourceAudioAvailable(record)"
            controls
            preload="none"
            :src="`/api/speech/records/${encodeURIComponent(record.id)}/audio`"
          />
          <span v-else>原声缓存已过期或不可用。</span>
          <time v-if="record.audioExpiresAt">保留至 {{ formatTime(record.audioExpiresAt) }}</time>
        </div>
      </article>
    </div>
    <div v-else class="speaker-record-empty">
      <v-icon size="28">mdi-text-box-search-outline</v-icon>
      <span>当前会话还没有持久化 ASR/TTS 文本记录。</span>
    </div>
  </section>

  <v-dialog v-model="profileDialog" max-width="920">
    <v-card class="app-card speaker-dialog-card">
      <v-card-title class="speaker-dialog-title">
        <div>
          <strong>说话人 / 声纹设置</strong>
          <span>{{ speakerCapabilityDescription }}</span>
        </div>
        <v-btn icon="mdi-close" variant="text" @click="profileDialog = false" />
      </v-card-title>
      <v-card-text>
        <v-alert v-if="capability?.storageError" class="mb-4" type="error" variant="tonal" density="compact">
          说话人资料存储不可写：{{ capability.storageError }}
        </v-alert>
        <div class="speaker-create-row">
          <v-text-field v-model="newSpeakerName" label="新说话人显示名" maxlength="100" hide-details />
          <v-combobox
            v-model="newSpeakerAliases"
            label="别名（可选）"
            multiple
            chips
            closable-chips
            clearable
            hide-details
          />
          <v-btn
            color="secondary"
            variant="tonal"
            prepend-icon="mdi-account-plus-outline"
            :loading="actionBusy"
            :disabled="!newSpeakerName.trim() || Boolean(capability?.storageError)"
            @click="createSpeaker"
          >
            新建资料
          </v-btn>
        </div>

        <div v-if="profiles.length" class="speaker-profile-list">
          <div v-for="profile in profiles" :key="profile.id" class="speaker-profile-row">
            <v-text-field
              v-model="speakerDrafts[profile.id].displayName"
              label="显示名"
              maxlength="100"
              hide-details
            />
            <v-combobox
              v-model="speakerDrafts[profile.id].aliases"
              label="别名"
              multiple
              chips
              closable-chips
              clearable
              hide-details
            />
            <div class="speaker-profile-actions">
              <v-btn
                size="small"
                color="secondary"
                variant="tonal"
                :loading="actionBusy"
                :disabled="!speakerDrafts[profile.id].displayName.trim() || Boolean(capability?.storageError)"
                @click="saveSpeaker(profile)"
              >
                保存
              </v-btn>
              <v-btn
                size="small"
                color="error"
                variant="text"
                :disabled="actionBusy || Boolean(capability?.storageError)"
                @click="deleteSpeaker(profile)"
              >
                删除
              </v-btn>
            </div>
          </div>
        </div>
        <div v-else class="speaker-record-empty compact-speaker-empty">
          <span>还没有说话人资料。先创建人员，再给 Speaker 1/2 等标签做手工绑定。</span>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" @click="profileDialog = false">完成</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="bindingDialog" max-width="620">
    <v-card class="app-card speaker-dialog-card">
      <v-card-title>绑定 / 纠正说话人</v-card-title>
      <v-card-text v-if="bindingTarget">
        <v-alert class="mb-4" type="info" variant="tonal" density="compact">
          这次绑定只作用于当前录音的同名分段标签，不会把临时标签带到下一段录音。
        </v-alert>
        <div class="speaker-binding-facts">
          <div><span>会话 ID</span><code data-no-i18n>{{ bindingTarget.sessionId }}</code></div>
          <div><span>录音 ID</span><code data-no-i18n>{{ bindingTarget.recordId }}</code></div>
          <div><span>分段标签</span><code data-no-i18n>{{ bindingTarget.speakerLabel }}</code></div>
          <div v-if="bindingTarget.speakerName"><span>当前解析</span><b>{{ bindingTarget.speakerName }}</b></div>
        </div>
        <div class="speaker-binding-preview">
          <strong>这个分段说话人的最近 {{ bindingPreviewLines.length }} 句话</strong>
          <ol v-if="bindingPreviewLines.length" class="speaker-preview-lines">
            <li v-for="line in bindingPreviewLines" :key="line.key">
              <time>{{ formatTime(line.time) }}</time>
              <span>{{ line.text }}</span>
            </li>
          </ol>
          <span v-else>当前已加载记录中没有可预览的句子。</span>
        </div>
        <v-select
          v-model="selectedSpeakerId"
          class="mt-4"
          label="绑定到说话人资料"
          :items="profiles"
          item-title="displayName"
          item-value="id"
          :disabled="!profiles.length"
        />
        <v-alert v-if="!profiles.length" type="warning" variant="tonal" density="compact">
          还没有可绑定的说话人资料。请先打开“说话人 / 声纹设置”创建人员。
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="bindingTarget && bindingFor(bindingTarget.recordId, bindingTarget.speakerLabel)"
          color="error"
          variant="text"
          :loading="actionBusy"
          @click="unbindSelectedSpeaker"
        >
          解除绑定
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="bindingDialog = false">取消</v-btn>
        <v-btn
          color="primary"
          :loading="actionBusy"
          :disabled="!selectedSpeakerId || Boolean(capability?.storageError)"
          @click="bindSelectedSpeaker"
        >
          保存绑定
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.speaker-records-panel { display: grid; gap: 14px; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--rr-border); }
.speaker-records-head, .speaker-boundary-title, .speaker-dialog-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.speaker-records-head > div:first-child, .speaker-dialog-title > div { display: grid; gap: 4px; }
.speaker-records-head span, .speaker-dialog-title span { color: var(--rr-muted); font-size: 12px; line-height: 1.5; }
.speaker-record-actions, .speaker-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.speaker-boundary { line-height: 1.55; }
.speaker-boundary-title { align-items: center; margin-bottom: 4px; }
.speaker-capability-reason { display: block; margin-top: 6px; color: var(--rr-muted); overflow-wrap: anywhere; }
.speaker-preview-panels { margin: 2px 0; }
.speaker-preview-panel-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.speaker-preview-panel-title small { color: var(--rr-muted-faint); font-weight: 500; }
.speaker-preview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; padding: 4px 0 10px; }
.speaker-preview-card { padding: 14px; border: 1px solid var(--rr-border); border-radius: 13px; background: var(--rr-subtle); }
.speaker-preview-card.unknown { border-left: 4px solid rgba(237, 168, 41, .72); }
.speaker-preview-card.known { border-left: 4px solid rgba(42, 169, 104, .65); }
.speaker-preview-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.speaker-preview-card-head > div { display: grid; gap: 3px; min-width: 0; }
.speaker-preview-card-head span { overflow: hidden; color: var(--rr-muted-faint); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.speaker-preview-count { margin-top: 9px; color: var(--rr-muted); font-size: 11px; }
.speaker-preview-lines { display: grid; gap: 7px; margin: 10px 0 0; padding-left: 22px; }
.speaker-preview-lines li { padding-left: 3px; color: var(--rr-text); line-height: 1.45; }
.speaker-preview-lines time { display: block; color: var(--rr-muted-faint); font-size: 10px; }
.speaker-preview-lines span { white-space: pre-wrap; }
.speech-record-list, .speech-segment-list, .speaker-profile-list { display: grid; gap: 10px; }
.speech-record-row { padding: 14px 16px; border: 1px solid var(--rr-border); border-radius: 13px; background: var(--rr-subtle); }
.speech-record-meta { display: flex; flex-wrap: wrap; gap: 7px 12px; align-items: center; color: var(--rr-muted-faint); font-size: 11px; }
.speech-record-cache { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 9px; padding: 8px 10px; border-radius: 9px; background: var(--rr-accent-surface); }
.speech-record-cache-fact { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; min-width: 0; color: var(--rr-muted); font-size: 11px; }
.speech-record-cache-fact code { overflow-wrap: anywhere; color: var(--rr-accent-text); }
.speech-record-cache-fact time { color: var(--rr-text); }
.speech-record-text, .speech-segment-row p { margin: 8px 0 0; color: var(--rr-text); line-height: 1.6; white-space: pre-wrap; }
.speech-segment-list { margin-top: 10px; }
.speech-segment-row { padding: 10px 12px; border-left: 3px solid var(--rr-accent-border); border-radius: 8px; background: var(--rr-surface); }
.speech-segment-speaker { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.speech-segment-speaker small { color: var(--rr-muted-faint); }
.speech-record-source-audio { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 10px; color: var(--rr-muted-faint); font-size: 11px; }
.speech-record-source-audio audio { width: min(100%, 520px); height: 34px; }
.speech-record-source-audio time { color: var(--rr-muted); }
.speaker-record-empty { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 88px; color: var(--rr-muted-faint); border: 1px dashed var(--rr-border-strong); border-radius: 12px; }
.compact-speaker-empty { min-height: 64px; margin-top: 12px; padding: 12px; text-align: center; }
.speaker-dialog-card { overflow: hidden; }
.speaker-dialog-title { padding: 20px 24px 12px; }
.speaker-create-row, .speaker-profile-row { display: grid; grid-template-columns: minmax(160px, .7fr) minmax(240px, 1.3fr) auto; gap: 12px; align-items: center; }
.speaker-profile-list { margin-top: 18px; }
.speaker-profile-row { padding: 12px; border: 1px solid var(--rr-border); border-radius: 12px; background: var(--rr-subtle); }
.speaker-binding-facts { display: grid; gap: 9px; }
.speaker-binding-facts > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; align-items: center; }
.speaker-binding-facts span { color: var(--rr-muted-faint); font-size: 12px; }
.speaker-binding-facts code { overflow-wrap: anywhere; color: var(--rr-accent-text); }
.speaker-binding-preview { margin-top: 16px; padding: 13px 14px; border: 1px solid var(--rr-accent-border); border-radius: 12px; background: var(--rr-accent-surface); }
.speaker-binding-preview > span { display: block; margin-top: 7px; color: var(--rr-muted-faint); font-size: 12px; }
@media (max-width: 760px) {
  .speaker-records-head, .speaker-boundary-title, .speaker-dialog-title, .speaker-preview-card-head { align-items: stretch; flex-direction: column; }
  .speaker-create-row, .speaker-profile-row { grid-template-columns: 1fr; }
  .speaker-profile-actions { justify-content: flex-end; }
}
</style>
