<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onMounted, ref } from "vue";
import type { SpeechPersona } from "@shared/speechControlContract";
import type {
  TaskCompletionAnnouncementRecord,
  TaskCompletionAnnouncementSettings
} from "@shared/taskCompletionAnnouncementContract";
import { speechControlClient } from "../speech/speechControlClient";

const settings = ref<TaskCompletionAnnouncementSettings | null>(null);
const records = ref<TaskCompletionAnnouncementRecord[]>([]);
const personas = ref<SpeechPersona[]>([]);
const loading = ref(true);
const saving = ref(false);
const previewing = ref(false);
const message = ref("");
const error = ref("");
const personaOptions = computed(() => {
  const items = personas.value.map(persona => ({
    title: persona.id,
    value: persona.id,
    subtitle: persona.voiceReady ? "人格声线已就绪" : "仅使用默认声线"
  }));
  const current = settings.value?.voice || "";
  if (current && !items.some(item => item.value === current)) {
    items.unshift({ title: current, value: current, subtitle: "当前保存的声线" });
  }
  return items;
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [nextSettings, history, personaPayload] = await Promise.all([
      speechControlClient.taskCompletionAnnouncementSettings(),
      speechControlClient.taskCompletionAnnouncementRecords(),
      speechControlClient.personas()
    ]);
    settings.value = nextSettings;
    records.value = history.records;
    personas.value = personaPayload.personas;
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!settings.value || saving.value) return;
  saving.value = true;
  error.value = "";
  message.value = "";
  try {
    settings.value = await speechControlClient.updateTaskCompletionAnnouncementSettings(settings.value);
    message.value = "已保存。";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    saving.value = false;
  }
}

async function preview(): Promise<void> {
  if (previewing.value) return;
  previewing.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await speechControlClient.previewTaskCompletionAnnouncement();
    message.value = result.spoken ? "测试已进入主机全局播放队列。" : `未播报：${result.reason || "未知原因"}`;
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    previewing.value = false;
  }
}

function stateLabel(record: TaskCompletionAnnouncementRecord): string {
  if (record.decision === "spoken") return "已播报";
  if (record.decision === "failed") return "失败";
  return `未播报${record.reason ? ` · ${record.reason}` : ""}`;
}

function sourceLabel(source: TaskCompletionAnnouncementRecord["source"]): string {
  return source === "codex" ? "Codex" : "DSH";
}

onMounted(() => { void refresh(); });
</script>

<template>
  <v-card class="app-card glass-card task-announcement-card" :loading="loading">
    <div class="task-announcement-head">
      <div>
        <div class="speech-eyebrow">TASK COMPLETION VOICE</div>
        <h2>任务完成播报</h2>
        <p>Codex 和 DSH 只上报完成事件；脱敏、文本整理、夜雨声线与全局 FIFO 播放都由 Rabi 统一处理。</p>
      </div>
      <v-btn size="small" variant="tonal" prepend-icon="mdi-volume-high" :loading="previewing" @click="preview">测试播报</v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="message" type="success" density="compact" variant="tonal" class="mb-3">{{ message }}</v-alert>

    <template v-if="settings">
      <div class="task-announcement-switches">
        <v-switch v-model="settings.enabled" label="启用任务完成播报" color="primary" hide-details @update:model-value="save" />
        <v-switch v-model="settings.sources.codex.enabled" label="Codex" color="primary" hide-details :disabled="!settings.enabled" @update:model-value="save" />
        <v-switch v-model="settings.sources.dsh.enabled" label="DSH（等待完成事件适配）" color="primary" hide-details :disabled="!settings.enabled" @update:model-value="save" />
      </div>
      <div class="task-announcement-fields">
        <v-text-field v-model.number="settings.maxChars" type="number" min="40" max="1000" label="最长播报字数" :disabled="!settings.enabled" @change="save" />
        <v-select
          v-model="settings.voice"
          :items="personaOptions"
          item-title="title"
          item-value="value"
          label="人格 / 声线"
          :disabled="!settings.enabled || saving"
          hint="选择完成任务时使用的人格声线"
          persistent-hint
          @update:model-value="save"
        >
          <template #item="{ props, item }">
            <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
      </div>
      <div class="task-announcement-switches task-announcement-secondary">
        <v-switch v-model="settings.redactSensitive" label="敏感字段改为 ----" color="primary" hide-details :disabled="!settings.enabled" @update:model-value="save" />
        <v-switch v-model="settings.cleanMarkdown" label="清理列表、分隔线和 Markdown" color="primary" hide-details :disabled="!settings.enabled" @update:model-value="save" />
        <v-switch v-model="settings.sources.codex.includeChildTasks" label="播报 Codex 子任务" color="primary" hide-details :disabled="!settings.enabled || !settings.sources.codex.enabled" @update:model-value="save" />
      </div>
    </template>

    <div class="task-announcement-history">
      <div class="task-announcement-history-head"><strong>最近事件</strong><v-btn size="x-small" variant="text" icon="mdi-refresh" aria-label="刷新最近播报事件" @click="refresh" /></div>
      <div v-if="records.length" class="task-announcement-records">
        <div v-for="record in records" :key="record.id" class="task-announcement-record">
          <span>{{ sourceLabel(record.source) }} · {{ record.taskName || record.sessionId }}</span>
          <span :class="`task-announcement-${record.decision}`">{{ stateLabel(record) }}</span>
          <time>{{ new Date(record.receivedAt).toLocaleString() }}</time>
        </div>
      </div>
      <div v-else class="section-note">尚无任务完成事件。事件记录不保存原始总结正文。</div>
    </div>
  </v-card>
</template>

<style scoped>
.task-announcement-card { display: grid; gap: 16px; min-width: 0; padding: 26px; }
.task-announcement-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.task-announcement-head h2 { margin: 6px 0; color: var(--rr-heading); font-size: 23px; }
.task-announcement-head p { max-width: 760px; margin: 0; color: var(--rr-muted); font-size: 13px; line-height: 1.65; }
.task-announcement-switches { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.task-announcement-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.task-announcement-secondary { padding-top: 4px; border-top: 1px solid var(--rr-border); }
.task-announcement-history { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--rr-border); }
.task-announcement-history-head { display: flex; align-items: center; justify-content: space-between; }
.task-announcement-records { display: grid; overflow: auto; max-height: 260px; border: 1px solid var(--rr-border); border-radius: 12px; }
.task-announcement-record { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: center; padding: 9px 11px; border-bottom: 1px solid var(--rr-border); color: var(--rr-muted); font-size: 12px; }
.task-announcement-record:last-child { border-bottom: 0; }
.task-announcement-record > span:first-child { min-width: 0; overflow: hidden; color: var(--rr-text); text-overflow: ellipsis; white-space: nowrap; }
.task-announcement-record time { color: var(--rr-muted-faint); font-variant-numeric: tabular-nums; font-size: 11px; }
.task-announcement-spoken { color: var(--rr-success-text); }
.task-announcement-failed { color: var(--rr-error-text); }
@media (max-width: 700px) { .task-announcement-head { align-items: stretch; flex-direction: column; } .task-announcement-fields, .task-announcement-record { grid-template-columns: 1fr; } }
</style>
