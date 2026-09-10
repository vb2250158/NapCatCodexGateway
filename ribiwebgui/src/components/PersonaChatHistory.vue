<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { PersonaChatHistoryPage, PersonaChatReply } from "@shared/personaChatHistory";
import { readChatHistoryAddition } from "../personaChatHistoryUpdates";
import { renderMarkdownPreview } from "../markdownPreview";
import { useI18n } from "../i18n";

const props = defineProps<{ roleId: string; version: number }>();
const { t } = useI18n();
const entries = ref<PersonaChatReply[]>([]);
const nextCursor = ref<number | null>(null);
const loading = ref(false);
const error = ref("");
const listElement = ref<HTMLElement>();
let request: AbortController | undefined;
let pendingUpdate = false;

async function load(older = false): Promise<void> {
  if (request) { if (!older) pendingUpdate = true; return; }
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = "";
  const roleId = props.roleId;
  const readPage = async (cursor?: number): Promise<PersonaChatHistoryPage> => {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor !== undefined) query.set("cursor", String(cursor));
    const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/chat-history?${query}`, { signal: controller.signal });
    const result = await response.json() as { code: number; data: PersonaChatHistoryPage; message?: string };
    if (!response.ok || result.code !== 0) throw new Error(result.message || t("聊天记录读取失败"));
    return result.data;
  };
  try {
    const hadEntries = entries.value.length > 0;
    const page = older
      ? await readPage(nextCursor.value ?? undefined)
      : await readChatHistoryAddition(new Set(entries.value.map(entry => entry.id)), readPage);
    if (controller.signal.aborted) return;
    const known = new Set(entries.value.map(entry => entry.id));
    const added = page.entries.filter(entry => !known.has(entry.id));
    // Retain existing keyed nodes and the visible reading anchor during a prepend.
    const anchor = [...(listElement.value?.querySelectorAll<HTMLElement>(".chat-reply") ?? [])]
      .find(element => element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < window.innerHeight);
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    let scroller = anchor?.parentElement;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const readingScroller = scroller ?? document.scrollingElement;
    const preservePosition = (readingScroller?.scrollTop ?? 0) > 0;
    if (added.length) {
      if (older) entries.value.push(...added);
      else entries.value.unshift(...added);
    }
    if (older || !hadEntries) nextCursor.value = page.nextCursor;
    await nextTick();
    if (!controller.signal.aborted && anchor?.isConnected && !older && added.length && preservePosition) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      readingScroller?.scrollBy(0, delta);
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = userFacingError(cause);
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
      if (pendingUpdate) { pendingUpdate = false; void load(); }
    }
  }
}

watch(() => props.roleId, () => {
  request?.abort();
  request = undefined;
  pendingUpdate = false;
  entries.value = [];
  nextCursor.value = null;
  void load();
}, { immediate: true });
watch(() => props.version, () => { void load(); });
onBeforeUnmount(() => { pendingUpdate = false; request?.abort(); request = undefined; });
</script>

<template>
  <v-card class="app-card glass-card pa-4">
    <div class="d-flex align-center justify-space-between ga-3 mb-3">
      <div>
        <div class="text-h6">{{ t('聊天记录') }}</div>
        <div class="text-body-2 text-medium-emphasis">{{ t('显示当前人格的最终回复和 Agent 之间的投递，最新在前。') }}</div>
      </div>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load()">{{ t('刷新') }}</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-progress-linear v-if="loading && !entries.length" indeterminate color="secondary" :aria-label="t('正在读取聊天记录')" />
    <v-alert v-else-if="!entries.length && !error" type="info" variant="tonal">
      {{ t('暂无聊天记录。绑定人格后，新产生的 Hook 最终回复和 Agent 投递会显示在这里。') }}
    </v-alert>
    <div ref="listElement" class="chat-history-list" aria-live="polite" :aria-busy="loading">
      <article v-for="entry in entries" :key="entry.id" class="chat-reply">
        <div class="text-caption text-medium-emphasis mb-2">
          <time :datetime="entry.receivedAt">{{ new Date(entry.receivedAt).toLocaleString() }}</time>
          <div class="chat-task-row mt-1">
            <div class="chat-task-source">
            {{ t('来源任务') }}：
            <a v-if="entry.taskUrl" :href="entry.taskUrl" class="chat-task-link" :title="entry.sessionId" data-no-i18n>{{ entry.sessionTitle || entry.sessionId }}</a>
            <span v-else :title="entry.sessionId" data-no-i18n>{{ entry.sessionTitle || entry.sessionId }}</span>
            </div>
            <div v-if="entry.targetSessionId" class="chat-task-target">
              {{ t('目标任务') }}：
              <a v-if="entry.targetTaskUrl" :href="entry.targetTaskUrl" class="chat-task-link" :title="entry.targetSessionId" data-no-i18n>{{ entry.targetSessionTitle || entry.targetSessionId }}</a>
              <span v-else :title="entry.targetSessionId" data-no-i18n>{{ entry.targetSessionTitle || entry.targetSessionId }}</span>
            </div>
          </div>
          <div v-if="entry.kind === 'agent_delivery'" class="mt-1">{{ t(entry.deliveryStatus === 'unconfirmed' ? 'Agent 投递（记录时尚未确认送达）' : 'Agent 投递') }}</div>
          <details class="mt-1">
            <summary>ID</summary>
            <div data-no-i18n>Task: {{ entry.sessionId }}</div>
            <div v-if="entry.targetSessionId" data-no-i18n>Target: {{ entry.targetSessionId }}</div>
            <div v-if="entry.turnId" data-no-i18n>Turn: {{ entry.turnId }}</div>
            <div v-if="entry.deliveryId" data-no-i18n>Delivery: {{ entry.deliveryId }}</div>
          </details>
        </div>
        <div class="chat-reply-text" data-no-i18n v-html="renderMarkdownPreview(entry.text)"></div>
      </article>
    </div>
    <v-btn v-if="nextCursor !== null" class="mt-3" variant="tonal" :disabled="loading" @click="load(true)">{{ t('加载更早的回复') }}</v-btn>
  </v-card>
</template>

<style scoped>
.chat-history-list { display: grid; gap: 16px; }
.chat-reply { padding: 16px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; min-width: 0; }
.chat-reply-text { overflow-wrap: anywhere; line-height: 1.65; }
.chat-reply-text :deep(> :first-child) { margin-top: 0; }
.chat-reply-text :deep(> :last-child) { margin-bottom: 0; }
.chat-reply-text :deep(p) { margin: .75em 0; }
.chat-reply-text :deep(h1), .chat-reply-text :deep(h2), .chat-reply-text :deep(h3),
.chat-reply-text :deep(h4), .chat-reply-text :deep(h5), .chat-reply-text :deep(h6) { margin: 1.2em 0 .5em; line-height: 1.35; }
.chat-reply-text :deep(h1) { font-size: 1.45em; }
.chat-reply-text :deep(h2) { font-size: 1.3em; }
.chat-reply-text :deep(h3) { font-size: 1.15em; }
.chat-reply-text :deep(ul), .chat-reply-text :deep(ol) { padding-left: 1.5em; margin: .6em 0; }
.chat-reply-text :deep(li + li) { margin-top: .3em; }
.chat-reply-text :deep(code) { padding: .12em .35em; border-radius: 4px; background: rgba(var(--v-theme-on-surface), .07); font-size: .9em; }
.chat-reply-text :deep(pre) { overflow-x: auto; padding: 12px 16px; margin: .8em 0; border-radius: 8px; background: rgba(var(--v-theme-on-surface), .05); }
.chat-reply-text :deep(pre code) { padding: 0; background: none; overflow-wrap: normal; }
.chat-reply-text :deep(blockquote) { border-left: 3px solid rgba(var(--v-theme-secondary), .5); padding-left: 1em; margin: .8em 0; color: rgba(var(--v-theme-on-surface), .75); }
.chat-reply-text :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: .8em 0; }
.chat-reply-text :deep(th), .chat-reply-text :deep(td) { border: 1px solid rgba(var(--v-theme-on-surface), .15); padding: 8px 12px; text-align: left; }
.chat-reply-text :deep(a) { color: rgb(var(--v-theme-secondary)); text-underline-offset: 3px; }
details { overflow-wrap: anywhere; }
summary { cursor: pointer; }
.chat-task-link { color: rgb(var(--v-theme-secondary)); text-underline-offset: 3px; overflow-wrap: anywhere; }
.chat-task-row { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; }
.chat-task-source, .chat-task-target { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 50%; }
.chat-task-target { text-align: right; }
@media (max-width: 600px) { .chat-task-row { gap: 12px; } }
</style>
