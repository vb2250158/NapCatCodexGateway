<script setup lang="ts">
import type { PlanQuestion, PlanQuestionAnswer } from "@shared/planQuestions";
import PlanFeedbackComposer from "./PlanFeedbackComposer.vue";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import { useI18n } from "../i18n";
const props = defineProps<{ questions: PlanQuestion[]; answers: Record<string, PlanQuestionAnswer>; disabled: boolean; formId: string; planAttachments: PlanAttachmentPresentation[]; attachmentUrl: (id: string) => string; submitDisabled: boolean }>();
const emit = defineEmits<{ change: [id: string, answer: PlanQuestionAnswer]; submit: []; "add-files": [payload: { files: File[]; fromClipboard: boolean }] }>();
const { t } = useI18n();
function update(id: string, value: Partial<PlanQuestionAnswer>) {
  emit("change", id, { ...props.answers[id], ...value });
}
</script>

<template>
  <div class="plan-question-fields">
    <fieldset v-for="q in questions" :key="q.id" :disabled="disabled">
      <legend data-no-i18n>{{ q.prompt }} <span v-if="q.required" aria-label="required">*</span></legend>
      <p v-if="q.context" data-no-i18n>{{ q.context }}</p>
      <label v-for="o in q.options" :key="o.id" class="plan-question-option">
        <input type="radio" :name="`${formId}-${q.id}`" :value="o.id" :checked="answers[q.id]?.optionId === o.id"
          @change="update(q.id, { optionId: o.id })">
        <span><b data-no-i18n>{{ o.label }}</b> <small v-if="o.recommended">{{ t('推荐') }}</small>
          <span v-if="o.description" class="plan-question-description" data-no-i18n>{{ o.description }}</span></span>
      </label>
      <button v-if="answers[q.id]?.optionId" type="button" @click="update(q.id, { optionId: undefined })">{{ t('清除选择') }}</button>
      <div class="plan-question-input">
        <PlanFeedbackComposer
          :composer-id="`${formId}-${q.id}`"
          :model-value="answers[q.id]?.text || ''"
          :plan-attachments="planAttachments" :attachment-url="attachmentUrl" :attachments="[]"
          :label="t(q.options.find(o => o.id === answers[q.id]?.optionId)?.requiresText ? '审批建议（必填）' : q.options.length ? '补充说明或其他答案' : '你的回答')"
          :placeholder="q.placeholder || ''"
          :hint="t('输入 @ 可引用计划附件；Enter 仅提交保存，Shift+Enter 换行。')"
          :disabled="disabled" :submit-disabled="submitDisabled" :pending="disabled"
          input-only submit-label="" submit-icon="" footer-text=""
          @update:model-value="update(q.id, { text: $event })"
          @add-files="emit('add-files', $event)" @submit="emit('submit')"
        />
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.plan-question-fields { display: grid; gap: 12px; margin: 12px 0; }
fieldset { border: 1px solid rgba(128,160,170,.35); border-radius: 10px; padding: 14px; min-width: 0; }
legend { font-weight: 600; padding: 0 5px; white-space: pre-wrap; }
p, .plan-question-description { opacity: .8; font-size: .9em; white-space: pre-wrap; }
.plan-question-option { display: flex; gap: 10px; padding: 10px; cursor: pointer; border-radius: 6px; }
.plan-question-option:has(input:checked) { background: rgba(70,190,190,.12); }
.plan-question-description, .plan-question-input { display: block; }
.plan-question-input { margin-top: 10px; }
button { text-decoration: underline; font-size: .85em; }
</style>
