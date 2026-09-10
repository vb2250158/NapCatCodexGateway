<script setup lang="ts">
import type { PlanImplementation } from "@shared/planQuestions";
import { useI18n } from "../i18n";
defineProps<{ implementation: PlanImplementation }>();
const { t } = useI18n();
const kindLabels = { code: "代码", prefab: "预制体", art: "美术资源", configuration: "游戏配置", other: "其它改动" };
</script>

<template>
  <details class="plan-implementation">
    <summary>{{ t("查看实施明细") }} <span>{{ implementation.changes.length }} {{ t("项改动") }}</span></summary>
    <div class="plan-implementation-body">
      <article v-for="(item, index) in implementation.changes" :key="index">
        <span class="plan-implementation-kind">{{ t(kindLabels[item.kind]) }}</span>
        <code data-no-i18n>{{ item.path }}</code>
        <b v-if="item.target" data-no-i18n>{{ item.target }}</b>
        <p data-no-i18n>{{ item.change }}</p>
      </article>
      <section v-if="implementation.validation"><h4>{{ t("如何验证") }}</h4><p data-no-i18n>{{ implementation.validation }}</p></section>
      <section v-if="implementation.rollback"><h4>{{ t("如何回退") }}</h4><p data-no-i18n>{{ implementation.rollback }}</p></section>
    </div>
  </details>
</template>

<style scoped>
.plan-implementation { margin: 10px 0; border: 1px solid rgba(128,160,170,.3); border-radius: 8px; min-width: 0; }
summary { cursor: pointer; padding: 10px 12px; font-weight: 600; }
summary span { font-weight: 400; opacity: .7; margin-left: 8px; }
.plan-implementation-body { padding: 0 12px 12px; display: grid; gap: 12px; }
article { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid rgba(128,160,170,.2); }
code, b, p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.plan-implementation-kind { font-size: .8em; opacity: .7; }
h4 { margin: 0 0 6px; }
</style>
