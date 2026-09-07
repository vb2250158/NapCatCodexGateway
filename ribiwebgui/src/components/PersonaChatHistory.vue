<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { PersonaChatHistoryPage, PersonaChatReply } from "@shared/personaChatHistory";
import { useI18n } from "../i18n";

const props = defineProps<{ roleId: string; version: number }>();
const { t } = useI18n();
const entries = ref<PersonaChatReply[]>([]);
const nextCursor = ref<number | null>(null);
const loading = ref(false);
const error = ref("");
let request: AbortController | undefined;

async function load(older = false): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = "";
  if (!older) { entries.value = []; nextCursor.value = null; }
  try {
    const query = new URLSearchParams({ limit: "50" });
    if (older && nextCursor.value !== null) query.set("cursor", String(nextCursor.value));
    const response = await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/chat-history?${query}`, { signal: controller.signal });
    const result = await response.json() as { code: number; data: PersonaChatHistoryPage; message?: string };
    if (!response.ok || result.code !== 0) throw new Error(result.message || t("聊天记录读取失败"));
    if (controller.signal.aborted) return;
    entries.value = older ? [...entries.value, ...result.data.entries] : result.data.entries;
    nextCursor.value = result.data.nextCursor;
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === controller) loading.value = false;
  }
}

watch(() => [props.roleId, props.version], () => { void load(); }, { immediate: true });
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <v-card class="app-card glass-card pa-4">
    <div class="d-flex align-center justify-space-between ga-3 mb-3">
      <div>
        <div class="text-h6">{{ t('聊天记录') }}</div>
        <div class="text-body-2 text-medium-emphasis">{{ t('显示当前人格各任务通过 Hook 捕获的最终回复，最新在前。') }}</div>
      </div>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load()">{{ t('刷新') }}</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="secondary" :aria-label="t('正在读取聊天记录')" />
    <v-alert v-else-if="!entries.length && !error" type="info" variant="tonal">
      {{ t('暂无聊天记录。安装 Agent Hook 并绑定人格后，新产生的最终回复会显示在这里。') }}
    </v-alert>
    <div class="chat-history-list" aria-live="polite" :aria-busy="loading">
      <article v-for="entry in entries" :key="entry.id" class="chat-reply">
        <div class="text-caption text-medium-emphasis mb-2">
          <time :datetime="entry.receivedAt">{{ new Date(entry.receivedAt).toLocaleString() }}</time>
          <details class="mt-1">
            <summary>{{ t('来源任务') }}</summary>
            <div data-no-i18n>{{ entry.sessionId }}</div>
            <div data-no-i18n>{{ entry.turnId }}</div>
          </details>
        </div>
        <div class="chat-reply-text" data-no-i18n>{{ entry.text }}</div>
      </article>
    </div>
    <v-btn v-if="nextCursor !== null" class="mt-3" variant="tonal" :disabled="loading" @click="load(true)">{{ t('加载更早的回复') }}</v-btn>
  </v-card>
</template>

<style scoped>
.chat-history-list { display: grid; gap: 16px; }
.chat-reply { padding: 16px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; min-width: 0; }
.chat-reply-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
details { overflow-wrap: anywhere; }
summary { cursor: pointer; }
</style>
