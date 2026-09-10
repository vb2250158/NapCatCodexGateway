<script setup lang="ts">
import { selectPlanQuestionOption, type PlanQuestion, type PlanQuestionAnswer } from "@shared/planQuestions";
import PlanImplementationDetails from "./PlanImplementationDetails.vue";
import PlanFeedbackComposer from "./PlanFeedbackComposer.vue";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import { useI18n } from "../i18n";
const props = defineProps<{ questions: PlanQuestion[]; answers: Record<string, PlanQuestionAnswer>; disabled: boolean; formId: string; planAttachments: PlanAttachmentPresentation[]; attachmentUrl: (id: string) => string; submitDisabled: boolean }>();
const emit = defineEmits<{ change: [id: string, answer: PlanQuestionAnswer]; submit: []; "add-files": [payload: { files: File[]; fromClipboard: boolean }] }>();
const { t } = useI18n();
function update(id: string, value: Partial<PlanQuestionAnswer>) {
  emit("change", id, { ...props.answers[id], ...value });
}
function isSelected(question: PlanQuestion, optionId: string): boolean {
  const answer = props.answers[question.id];
  return question.selectionMode === "multiple" ? (answer?.optionIds?.includes(optionId) ?? false) : answer?.optionId === optionId;
}
function selectOption(question: PlanQuestion, optionId: string): void {
  emit("change", question.id, selectPlanQuestionOption(question, props.answers[question.id] ?? {}, optionId));
}
function needsText(question: PlanQuestion): boolean {
  return question.options.some(option => option.requiresText && isSelected(question, option.id));
}
</script>

<template>
  <div class="plan-question-fields">
    <fieldset v-for="q in questions" :key="q.id" :disabled="disabled">
      <legend data-no-i18n>{{ q.prompt }} <span v-if="q.required" aria-label="required">*</span></legend>
      <p v-if="q.options.length" class="plan-question-mode">{{ t(q.selectionMode === "multiple" ? '可多选' : '单选') }}</p>
      <p v-if="q.context" data-no-i18n>{{ q.context }}</p>
      <PlanImplementationDetails v-if="q.implementation" :key="JSON.stringify(q.implementation)" :implementation="q.implementation" />
      <div v-for="o in q.options" :key="o.id" class="plan-question-choice" :data-selected="isSelected(q, o.id)">
        <label class="plan-question-option">
          <input :type="q.selectionMode === 'multiple' ? 'checkbox' : 'radio'" :name="`${formId}-${q.id}`" :value="o.id" :checked="isSelected(q, o.id)" @change="selectOption(q, o.id)">
          <span><b data-no-i18n>{{ o.label }}</b> <small v-if="o.recommended">{{ t('推荐') }}</small>
            <span v-if="o.description" class="plan-question-description" data-no-i18n>{{ o.description }}</span></span>
        </label>
        <PlanImplementationDetails v-if="o.implementation" :key="JSON.stringify(o.implementation)" :implementation="o.implementation" />
      </div>
      <button v-if="answers[q.id]?.optionId || answers[q.id]?.optionIds?.length" type="button" @click="update(q.id, { optionId: undefined, optionIds: undefined })">{{ t('清除选择') }}</button>
      <component :is="q.options.length ? 'details' : 'div'" class="plan-question-input" :open="q.options.length > 0 && (needsText(q) || Boolean(answers[q.id]?.text))">
        <summary v-if="q.options.length">{{ t(needsText(q) ? '请补充具体建议' : '补充说明（可选）') }}</summary>
        <PlanFeedbackComposer
          :composer-id="`${formId}-${q.id}`"
          :model-value="answers[q.id]?.text || ''"
          :plan-attachments="planAttachments" :attachment-url="attachmentUrl" :attachments="[]"
          :label="t(needsText(q) ? '审批建议（必填）' : q.options.length ? '补充说明或其他答案' : '你的回答')"
          :placeholder="q.placeholder || ''"
          :hint="t('输入 @ 可引用计划附件；Enter 仅提交保存，Shift+Enter 换行。')"
          :disabled="disabled" :submit-disabled="submitDisabled" :pending="disabled"
          input-only submit-label="" submit-icon="" footer-text=""
          @update:model-value="update(q.id, { text: $event })"
          @add-files="emit('add-files', $event)" @submit="emit('submit')"
        />
      </component>
    </fieldset>
  </div>
</template>

<style scoped>
.plan-question-fields { display: grid; gap: 12px; margin: 12px 0; }
fieldset { border: 1px solid rgba(128,160,170,.35); border-radius: 10px; padding: 14px; min-width: 0; }
legend { font-weight: 600; padding: 0 5px; white-space: pre-wrap; }
p, .plan-question-description { opacity: .8; font-size: .9em; white-space: pre-wrap; }
.plan-question-option { display: flex; gap: 10px; padding: 10px; cursor: pointer; border-radius: 6px; }
.plan-question-choice[data-selected="true"] { background: rgba(70,190,190,.12); }
.plan-question-description, .plan-question-input { display: block; }
.plan-question-input { margin-top: 10px; }
.plan-question-input > summary { cursor: pointer; padding: 6px 0; opacity: .8; }
.plan-question-choice { border: 1px solid rgba(128,160,170,.2); border-radius: 8px; margin: 8px 0; padding: 2px 8px; min-width: 0; }
.plan-question-option > span { min-width: 0; overflow-wrap: anywhere; }
input { flex: 0 0 auto; margin-top: 4px; accent-color: #208b8b; }
button { text-decoration: underline; font-size: .85em; }
</style>
