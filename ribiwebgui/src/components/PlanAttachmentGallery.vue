<script setup lang="ts">
import type { RolePlan } from "../types";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import { isPlanMarkdownAttachment } from "../markdownPreview";
import { useI18n } from "../i18n";
const { t } = useI18n();
defineProps<{
  plan: RolePlan;
  planAttachmentUrl: (planId: string, attachmentId: string) => string;
  planVideoThumbnailUrl: (planId: string, attachmentId: string) => string;
  planMediaLoadState: (planId: string, attachmentId: string) => string;
  setPlanMediaLoadState: (planId: string, attachmentId: string, state: "loading" | "loaded" | "error") => void;
  capturePlanVideoDuration: (planId: string, attachmentId: string, event: Event) => void;
  displayedPlanVideoDuration: (planId: string, attachmentId: string) => string;
  planMarkdownTeaser: (planId: string, attachmentId: string) => { text: string; loading: boolean };
  openPlanMediaPreview: (plan: RolePlan, attachment: PlanAttachmentPresentation) => void;
  openPlanMarkdownPreview: (plan: RolePlan, attachment: PlanAttachmentPresentation) => void;
  formatAttachmentSize: (size: number) => string;
}>();
</script>

<template>
  <div class="knowledge-plan-attachment-grid">
    <button
      v-for="attachment in plan.attachments.filter((item) => item.kind === 'image' || item.kind === 'video')"
      :key="attachment.id"
      type="button"
      class="knowledge-plan-attachment media"
      :class="attachment.kind"
      :aria-label="`${t(attachment.kind === 'video' ? '查看视频预览' : '查看图片预览')}：${attachment.name}`"
      @click="openPlanMediaPreview(plan, attachment)"
    >
      <span
        class="knowledge-plan-attachment-visual"
        :data-load-state="planMediaLoadState(plan.id, attachment.id)"
      >
        <span class="knowledge-plan-attachment-loading" aria-live="polite">
          <v-progress-circular
            v-if="planMediaLoadState(plan.id, attachment.id) === 'loading'"
            indeterminate
            size="22"
            width="2"
          />
          <v-icon v-else size="22">mdi-image-broken-variant</v-icon>
          <small>{{ t(planMediaLoadState(plan.id, attachment.id) === "error" ? "附件加载失败" : "附件加载中") }}</small>
        </span>
        <video
          v-if="attachment.kind === 'video'"
          :src="planVideoThumbnailUrl(plan.id, attachment.id)"
          preload="metadata"
          muted
          playsinline
          aria-hidden="true"
          @loadedmetadata="capturePlanVideoDuration(plan.id, attachment.id, $event); setPlanMediaLoadState(plan.id, attachment.id, 'loaded')"
          @error="setPlanMediaLoadState(plan.id, attachment.id, 'error')"
        ></video>
        <img
          v-else
          :src="planAttachmentUrl(plan.id, attachment.id)"
          :alt="attachment.name"
          loading="lazy"
          decoding="async"
          fetchpriority="low"
          data-no-i18n
          @load="setPlanMediaLoadState(plan.id, attachment.id, 'loaded')"
          @error="setPlanMediaLoadState(plan.id, attachment.id, 'error')"
        >
        <span class="knowledge-plan-attachment-overlay">
          <v-icon v-if="attachment.kind === 'image'" size="20">mdi-magnify-plus-outline</v-icon>
          {{ t(attachment.kind === "video" ? "点击预览视频" : "点击查看大图") }}
        </span>
        <span v-if="attachment.kind === 'video'" class="knowledge-plan-video-play" aria-hidden="true">
          <v-icon size="21">mdi-play</v-icon>
        </span>
        <span v-if="attachment.kind === 'video'" class="knowledge-plan-video-duration" data-no-i18n aria-hidden="true">
          {{ displayedPlanVideoDuration(plan.id, attachment.id) }}
        </span>
      </span>
      <span class="knowledge-plan-attachment-meta">
        <b data-no-i18n>{{ attachment.name }}</b>
        <small data-no-i18n>{{ formatAttachmentSize(attachment.size) }}</small>
      </span>
    </button>
    <button
      v-for="attachment in plan.attachments.filter((item) => item.kind === 'file' && isPlanMarkdownAttachment(item.name, item.mimeType))"
      :key="attachment.id"
      type="button"
      class="knowledge-plan-attachment media markdown"
      :aria-label="`${t('预览 Markdown')}：${attachment.name}`"
      @click="openPlanMarkdownPreview(plan, attachment)"
    >
      <span class="knowledge-plan-attachment-visual knowledge-plan-markdown-visual">
        <span class="knowledge-plan-markdown-paper">
          <span class="knowledge-plan-markdown-kicker">
            <v-icon size="14">mdi-language-markdown-outline</v-icon>
            <span data-no-i18n>MARKDOWN</span>
          </span>
          <span v-if="planMarkdownTeaser(plan.id, attachment.id).loading" class="knowledge-plan-markdown-teaser loading">
            {{ t("正在加载 Markdown…") }}
          </span>
          <span v-else class="knowledge-plan-markdown-teaser" data-no-i18n>
            {{ planMarkdownTeaser(plan.id, attachment.id).text || attachment.name }}
          </span>
        </span>
        <span class="knowledge-plan-attachment-overlay">
          <v-icon size="20">mdi-eye-outline</v-icon>
          {{ t("预览 Markdown") }}
        </span>
      </span>
      <span class="knowledge-plan-attachment-meta">
        <b data-no-i18n>{{ attachment.name }}</b>
        <small data-no-i18n>Markdown · {{ formatAttachmentSize(attachment.size) }}</small>
      </span>
    </button>
    <a
      v-for="attachment in plan.attachments.filter((item) => item.kind === 'file' && !isPlanMarkdownAttachment(item.name, item.mimeType))"
      :key="attachment.id"
      class="knowledge-plan-attachment file"
      :href="planAttachmentUrl(plan.id, attachment.id)"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="`${t('打开附件')}：${attachment.name}`"
    >
      <span class="knowledge-plan-attachment-file-icon"><v-icon size="24">mdi-file-outline</v-icon></span>
      <span class="knowledge-plan-attachment-meta">
        <b data-no-i18n>{{ attachment.name }}</b>
        <small data-no-i18n>{{ attachment.mimeType || t("文件") }} · {{ formatAttachmentSize(attachment.size) }}</small>
      </span>
      <v-icon size="17">mdi-open-in-new</v-icon>
    </a>
  </div>
</template>
