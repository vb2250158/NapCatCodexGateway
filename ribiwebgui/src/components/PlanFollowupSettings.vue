<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref, watch } from "vue";
import { normalizePlanFollowup, type PlanFollowupSettings, type PlanFollowupRule } from "@shared/planFollowup";
const props = defineProps<{ modelValue?: PlanFollowupSettings; roleId: string }>();
const emit = defineEmits<{ "update:modelValue": [value: PlanFollowupSettings] }>();
// Preserve the user's draft, including spaces while typing; normalize at persistence/runtime boundaries.
const settings = computed(() => props.modelValue ?? normalizePlanFollowup(undefined));
const statuses = ref<{ title: string; value: string }[]>([]);
const error = ref("");
watch(() => props.roleId, async (roleId, _, cleanup) => {
  const controller = new AbortController(); cleanup(() => controller.abort());
  statuses.value = []; error.value = "";
  if (!roleId) return;
  try {
    const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/plan-statuses`, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "读取计划状态失败");
    statuses.value = result.data.statuses.filter((item: { state: string; terminal: boolean }) => item.state === "enabled" && !item.terminal)
      .map((item: { key: string; label: string }) => ({ title: item.label, value: item.key }));
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
}, { immediate: true });
function update(patch: Partial<PlanFollowupSettings>) { emit("update:modelValue", { ...settings.value, ...patch }); }
function change(rule: PlanFollowupRule, patch: Partial<PlanFollowupRule>) {
  update({ rules: settings.value.rules.map(item => item.id === rule.id ? { ...item, ...patch } : item) });
}
function add() {
  update({ rules: [...settings.value.rules, { id: crypto.randomUUID(), enabled: true, statusKeys: [], prompt: "" }] });
}
</script>

<template>
  <div class="dependency-panel mt-3">
    <div class="section-title small-title">计划任务结束后追问</div>
    <div class="section-note">只追问绑定当前人格计划的任务。选择哪些计划状态触发，并填写追问内容；规则按顺序匹配第一条。</div>
    <v-switch :model-value="settings.enabled" label="启用自动追问" color="primary" hide-details
      @update:model-value="value => update({ enabled: value === true })" />
    <v-alert v-if="error" type="warning" density="compact">{{ error }}</v-alert>
    <v-text-field :model-value="settings.cooldownSeconds" label="两次追问的最短间隔（秒）" type="number" min="0" max="86400"
      @update:model-value="value => update({ cooldownSeconds: Number(value) })" />
    <div class="section-note">同一轮最多追问一次；计划步骤、下一动作和规则均无变化时不重复追问。冷却时间不会自动唤醒任务。</div>
    <v-card v-for="rule in settings.rules" :key="rule.id" variant="outlined" class="pa-3 mt-3">
      <v-switch :model-value="rule.enabled" label="启用这条规则" color="primary" hide-details
        @update:model-value="value => change(rule, { enabled: value === true })" />
      <v-select :model-value="rule.statusKeys" :items="statuses" label="触发的计划状态" multiple chips
        :error-messages="rule.statusKeys.some(key => !statuses.some(item => item.value === key)) ? '部分状态已移除，请重新选择' : []"
        @update:model-value="value => change(rule, { statusKeys: value })" />
      <v-textarea :model-value="rule.prompt" label="追问内容" rows="3" maxlength="4000" counter
        placeholder="例如：核对当前步骤是否还有已授权且可独立完成的事项。有则继续，没有则记录原因。"
        @update:model-value="value => change(rule, { prompt: value })" />
      <div v-if="!rule.prompt.trim() || !rule.statusKeys.length" class="section-note">选择状态并填写内容后，这条规则才会生效。</div>
      <v-btn variant="text" color="error" @click="update({ rules: settings.rules.filter(item => item.id !== rule.id) })">删除规则</v-btn>
    </v-card>
    <v-btn class="mt-3" variant="tonal" prepend-icon="mdi-plus" @click="add">添加追问规则</v-btn>
  </div>
</template>
