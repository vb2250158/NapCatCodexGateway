<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import {
  findPlanAttachmentMentionQuery,
  insertPlanAttachmentMention,
  planAttachmentMentionCandidates,
  referencedPlanAttachmentIds,
  type PlanAttachmentMentionCandidate
} from "@shared/planAttachmentMentions";
import { useI18n } from "../i18n";

type FeedbackAttachmentDraftView = {
  id: string;
  name: string;
  size: number;
  kind: "file" | "image";
  previewUrl?: string;
};

type FeedbackComposerNotice = {
  tone: "success" | "warning" | "error";
  text: string;
};

type MentionMenuState = {
  open: boolean;
  query: string;
  start: number;
  end: number;
  activeIndex: number;
};

const props = withDefaults(defineProps<{
  composerId: string;
  modelValue: string;
  planAttachments: PlanAttachmentPresentation[];
  attachments: FeedbackAttachmentDraftView[];
  attachmentUrl: (attachmentId: string) => string;
  label: string;
  placeholder: string;
  hint: string;
  disabled: boolean;
  submitDisabled: boolean;
  pending: boolean;
  submitLabel: string;
  submitIcon: string;
  submitRecordOnlyLabel?: string;
  recordOnlyDisabled?: boolean;
  footerText: string;
  notice?: FeedbackComposerNotice;
  maxLength?: number;
  inputOnly?: boolean;
  footerOnly?: boolean;
}>(), {
  notice: undefined,
  maxLength: 2_000
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [];
  "submit-record-only": [];
  "add-files": [payload: { files: File[]; fromClipboard: boolean }];
  "remove-attachment": [attachmentId: string];
}>();

const { t } = useI18n();
const fileInput = ref<HTMLInputElement | null>(null);
const textareaRoot = ref<unknown>(null);
const localError = ref("");
const mention = reactive<MentionMenuState>({
  open: false,
  query: "",
  start: 0,
  end: 0,
  activeIndex: 0
});

const draft = computed({
  get: () => props.modelValue,
  set: (value: string) => emit("update:modelValue", value)
});
const mentionCandidates = computed(() => planAttachmentMentionCandidates(props.planAttachments));
const mentionResults = computed(() => {
  const query = mention.query.trim().toLocaleLowerCase();
  if (!query) return mentionCandidates.value;
  return mentionCandidates.value.filter((candidate) => (
    candidate.name.toLocaleLowerCase().includes(query)
    || candidate.id.toLocaleLowerCase().includes(query)
  ));
});
const mentionedAttachmentIds = computed(() => new Set(
  referencedPlanAttachmentIds(props.modelValue, mentionCandidates.value)
));
const safeComposerId = computed(() => props.composerId.replace(/[^\p{L}\p{N}_-]+/gu, "-"));
const mentionListId = computed(() => `plan-feedback-mention-${safeComposerId.value}`);

watch(() => props.modelValue, () => {
  localError.value = "";
});

function textareaElement(): HTMLTextAreaElement | undefined {
  const value = textareaRoot.value;
  const root = value && typeof value === "object" && "$el" in value
    ? (value as { $el?: HTMLElement }).$el
    : value instanceof HTMLElement
      ? value
      : undefined;
  return root instanceof HTMLTextAreaElement ? root : root?.querySelector<HTMLTextAreaElement>("textarea") || undefined;
}

function updateMentionMenu(textarea = textareaElement()): void {
  if (!textarea) return;
  const query = findPlanAttachmentMentionQuery(textarea.value, textarea.selectionStart ?? textarea.value.length);
  if (!query || props.disabled) {
    mention.open = false;
    return;
  }
  mention.open = true;
  mention.query = query.query;
  mention.start = query.start;
  mention.end = query.end;
  mention.activeIndex = 0;
}

function handleInput(event: Event): void {
  updateMentionMenu(event.target instanceof HTMLTextAreaElement ? event.target : undefined);
}

function closeMentionMenu(): void {
  mention.open = false;
  mention.query = "";
  mention.activeIndex = 0;
}

function handleBlur(): void {
  window.setTimeout(closeMentionMenu, 120);
}

function selectMention(candidate: PlanAttachmentMentionCandidate): void {
  const textarea = textareaElement();
  const currentText = textarea?.value ?? props.modelValue;
  const inserted = insertPlanAttachmentMention(currentText, mention, candidate.token);
  if (Array.from(inserted.text).length > props.maxLength) {
    localError.value = t("引用附件后会超过 2000 字，请先精简内容。");
    return;
  }
  emit("update:modelValue", inserted.text);
  closeMentionMenu();
  void nextTick(() => {
    const target = textareaElement();
    target?.focus();
    target?.setSelectionRange(inserted.caret, inserted.caret);
  });
}

function handleKeydown(event: KeyboardEvent): void {
  if (mention.open) {
    const results = mentionResults.value;
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      mention.activeIndex = (mention.activeIndex + 1) % results.length;
      return;
    }
    if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      mention.activeIndex = (mention.activeIndex - 1 + results.length) % results.length;
      return;
    }
    if (event.key === "Home" && results.length) {
      event.preventDefault();
      mention.activeIndex = 0;
      return;
    }
    if (event.key === "End" && results.length) {
      event.preventDefault();
      mention.activeIndex = results.length - 1;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionMenu();
      return;
    }
    if (plainEnter(event)) {
      event.preventDefault();
      if (results.length) selectMention(results[Math.min(mention.activeIndex, results.length - 1)]!);
      return;
    }
  }
  if (!plainEnter(event)) return;
  event.preventDefault();
  if (props.submitRecordOnlyLabel) {
    if (!(props.recordOnlyDisabled ?? props.submitDisabled)) emit("submit-record-only");
  } else if (!props.submitDisabled) emit("submit");
}

function plainEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter"
    && !event.isComposing
    && event.keyCode !== 229
    && !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey;
}

function handlePaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (!files.length) return;
  if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
  emit("add-files", { files, fromClipboard: true });
}

function openFilePicker(): void {
  if (props.disabled) return;
  if (fileInput.value) {
    fileInput.value.value = "";
    fileInput.value.click();
  }
}

function handleFileSelection(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (files.length) emit("add-files", { files, fromClipboard: false });
  input.value = "";
}

function mentionOptionId(index: number): string {
  return `${mentionListId.value}-${index}`;
}

function mentionAttachment(candidate: PlanAttachmentMentionCandidate): PlanAttachmentPresentation | undefined {
  return props.planAttachments.find((attachment) => attachment.id === candidate.id);
}

function mentionAttachmentIcon(candidate: PlanAttachmentMentionCandidate): string {
  const kind = mentionAttachment(candidate)?.kind;
  return kind === "image" ? "mdi-image-outline" : kind === "video" ? "mdi-video-outline" : "mdi-file-outline";
}

function handleMentionPreviewError(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.hidden = true;
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}
</script>

<template>
  <div v-if="!footerOnly" class="knowledge-approval-composer">
    <input
      ref="fileInput"
      class="knowledge-approval-file-input"
      type="file"
      multiple
      @change="handleFileSelection"
    >
    <v-textarea
      ref="textareaRoot"
      v-model="draft"
      :label="label"
      :placeholder="placeholder"
      persistent-hint
      :hint="hint"
      variant="outlined"
      rows="3"
      :counter="maxLength"
      :maxlength="maxLength"
      :disabled="disabled"
      aria-autocomplete="list"
      :aria-controls="mentionListId"
      :aria-expanded="mention.open"
      :aria-activedescendant="mention.open && mentionResults.length ? mentionOptionId(mention.activeIndex) : undefined"
      @input="handleInput"
      @click="updateMentionMenu()"
      @keydown="handleKeydown"
      @blur="handleBlur"
      @paste="handlePaste"
    />
    <div
      v-if="mention.open"
      :id="mentionListId"
      class="knowledge-approval-mention-menu"
      role="listbox"
      :aria-label="t('引用计划附件')"
    >
      <div class="knowledge-approval-mention-head">
        <span><v-icon size="16">mdi-at</v-icon>{{ t("引用计划附件") }}</span>
        <small>{{ t("输入文件名筛选，方向键选择，Enter 确认") }}</small>
      </div>
      <button
        v-for="(candidate, candidateIndex) in mentionResults"
        :id="mentionOptionId(candidateIndex)"
        :key="candidate.id"
        class="knowledge-approval-mention-option"
        :data-active="candidateIndex === mention.activeIndex"
        :data-selected="mentionedAttachmentIds.has(candidate.id)"
        type="button"
        role="option"
        :aria-selected="mentionedAttachmentIds.has(candidate.id)"
        @mouseenter="mention.activeIndex = candidateIndex"
        @mousedown.prevent
        @click="selectMention(candidate)"
      >
        <span class="knowledge-approval-mention-preview" :data-kind="mentionAttachment(candidate)?.kind || 'file'">
          <span class="knowledge-approval-mention-preview-fallback">
            <v-icon size="21">{{ mentionAttachmentIcon(candidate) }}</v-icon>
          </span>
          <img
            v-if="mentionAttachment(candidate)?.kind === 'image'"
            :src="attachmentUrl(candidate.id)"
            alt=""
            width="88"
            height="50"
            loading="lazy"
            decoding="async"
            fetchpriority="low"
            @error="handleMentionPreviewError"
          >
        </span>
        <span class="knowledge-approval-mention-copy">
          <b data-no-i18n>{{ candidate.name }}</b>
          <small data-no-i18n>
            {{ candidate.duplicateCount ? `${candidate.duplicateIndex}/${candidate.duplicateCount} · ` : "" }}{{ formatAttachmentSize(mentionAttachment(candidate)?.size || 0) }}
          </small>
        </span>
        <v-icon v-if="mentionedAttachmentIds.has(candidate.id)" size="18" color="primary">mdi-check-circle</v-icon>
      </button>
      <div v-if="!mentionResults.length" class="knowledge-approval-mention-empty" role="status">
        <v-icon size="20">mdi-file-search-outline</v-icon>
        <span>{{ planAttachments.length ? t("没有匹配的计划附件") : t("当前计划没有可引用的附件") }}</span>
      </div>
    </div>
  </div>
  <div v-if="!footerOnly" class="knowledge-approval-attachment-tools">
    <v-btn
      prepend-icon="mdi-paperclip-plus"
      variant="tonal"
      size="small"
      :disabled="disabled"
      @click="openFilePicker"
    >
      {{ t("添加附件") }}
    </v-btn>
    <span>{{ t("支持选择文件，也可以在输入框中按 Ctrl+V 粘贴文件或图片。") }}</span>
    <small>{{ t("最多 8 个，单个不超过 10 MB，总计不超过 25 MB。") }}</small>
  </div>
  <div v-if="attachments.length" class="knowledge-approval-attachments">
    <article
      v-for="attachment in attachments"
      :key="attachment.id"
      class="knowledge-approval-attachment"
      :class="{ image: attachment.kind === 'image' }"
    >
      <img v-if="attachment.previewUrl" :src="attachment.previewUrl" alt="">
      <div v-else class="knowledge-approval-attachment-icon">
        <v-icon size="22">mdi-file-outline</v-icon>
      </div>
      <div class="knowledge-approval-attachment-copy">
        <b data-no-i18n>{{ attachment.name }}</b>
        <span data-no-i18n>{{ formatAttachmentSize(attachment.size) }}</span>
      </div>
      <v-btn
        icon="mdi-close"
        variant="text"
        size="x-small"
        :aria-label="t('删除附件')"
        :disabled="pending"
        @click="emit('remove-attachment', attachment.id)"
      />
    </article>
  </div>
  <v-alert
    v-if="localError || notice"
    :type="localError ? 'error' : notice?.tone"
    variant="tonal"
    density="compact"
    data-no-i18n
  >
    {{ localError || notice?.text }}
  </v-alert>
  <div v-if="!inputOnly" class="knowledge-approval-actions">
    <span>{{ footerText }}</span>
    <div class="knowledge-approval-action-buttons">
      <v-btn
        v-if="submitRecordOnlyLabel"
        variant="outlined"
        :disabled="recordOnlyDisabled ?? submitDisabled"
        @click="emit('submit-record-only')"
      >
        {{ submitRecordOnlyLabel }}
      </v-btn>
      <v-btn
        color="primary"
        :prepend-icon="submitIcon"
        :loading="pending"
        :disabled="submitDisabled"
        @click="emit('submit')"
      >
        {{ submitLabel }}
      </v-btn>
    </div>
  </div>
</template>
