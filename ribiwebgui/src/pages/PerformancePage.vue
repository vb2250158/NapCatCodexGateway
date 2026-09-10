<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PerformanceTimelineChart from "../components/PerformanceTimelineChart.vue";
import { managerEventSource } from "../managerApi";
import { updateFrontendPerformanceConfig } from "../performance/frontendPerformanceReporter";
import { loadPerformanceConfig, loadPerformanceLogs, loadPerformanceSummary, savePerformanceConfig } from "../performance/performanceClient";
import { defaultPerformanceMonitoringConfig, type PerformanceMonitoringConfig, type PerformanceSample, type PerformanceSeriesPoint, type PerformanceSummary } from "@shared/performanceContract";
import { registerPageSaveAction } from "../pageSaveAction";
import { pluginCatalogStore } from "../pluginCatalogStore";
import TrustedWebRendererHost from "../components/TrustedWebRendererHost.vue";
import { webRenderersAt } from "../pluginRenderers";

type PerformanceChartSeries = {
  id: string;
  name: string;
  color: string;
  values: Array<{ time: string; value: number }>;
};

const summary = ref<PerformanceSummary>();
const performanceStatusRenderers = computed(() => webRenderersAt(pluginCatalogStore.statusRenderers.value, "global.performance.summary"));
const recentLogs = ref<PerformanceSample[]>([]);
const config = ref<PerformanceMonitoringConfig>(defaultPerformanceMonitoringConfig());
const rangeMs = ref(60 * 60 * 1000);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const saved = ref("");
const configLoaded = ref(false);
const configDirty = ref(false);
const configHydrating = ref(true);
let unregisterPageSaveAction: (() => void) | undefined;
let events: EventSource | undefined;
let refreshTimer: number | undefined;

const rangeOptions = [
  { title: "最近 15 分钟", value: 15 * 60 * 1000 },
  { title: "最近 1 小时", value: 60 * 60 * 1000 },
  { title: "最近 6 小时", value: 6 * 60 * 60 * 1000 },
  { title: "最近 24 小时", value: 24 * 60 * 60 * 1000 }
];
const sourceColors = ["#55d6be", "#ffcc66", "#ef6f6c", "#75a7ff", "#d392ff", "#9be564"];
const onlineSources = computed(() => summary.value?.sources.filter(item => item.online).length ?? 0);
const totalSources = computed(() => summary.value?.sources.length ?? 0);
const managerSource = computed(() => summary.value?.sources
  .filter(item => item.source.kind === "manager")
  .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0]);
const latestRequestP95 = computed(() => managerSource.value?.latest?.requestP95Ms ?? 0);
const totalDiskMb = computed(() => (summary.value?.status.diskBytes ?? 0) / 1024 / 1024);
const logText = computed(() => recentLogs.value.slice(-30).reverse().map(item => JSON.stringify(item)).join("\n"));
const performanceStatusContext = computed(() => ({
  onlineSources: onlineSources.value,
  totalSources: totalSources.value,
  managerCpuPercent: managerSource.value?.latest?.cpuPercent ?? 0,
  latestRequestP95: latestRequestP95.value,
  totalDiskMb: totalDiskMb.value,
  logDirectory: summary.value?.status.logDirectory || "data/.runtime/performance"
}));

function sourceLabel(point: { source: { kind: string; id: string } }): string {
  if (point.source.kind === "manager") return "Manager";
  if (point.source.kind === "webgui") {
    const runtimeId = "runtimeId" in point.source ? String(point.source.runtimeId) : "";
    return runtimeId ? `WebGUI · ${runtimeId.slice(0, 6)}` : "WebGUI";
  }
  return `Gateway · ${point.source.id}`;
}

function seriesFor(metric: keyof PerformanceSeriesPoint, transform: (value: number) => number = value => value): PerformanceChartSeries[] {
  const groups = new Map<string, PerformanceSeriesPoint[]>();
  for (const point of summary.value?.points ?? []) {
    const value = point[metric];
    if (typeof value !== "number") continue;
    const key = `${point.source.kind}:${point.source.id}:${point.source.runtimeId}`;
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, points], index) => ({
    id: key,
    name: sourceLabel(points[0]),
    color: sourceColors[index % sourceColors.length],
    values: points.map(point => ({ time: point.time, value: transform(Number(point[metric] ?? 0)) }))
  }));
}

const cpuSeries = computed(() => seriesFor("cpuPercent"));
const memorySeries = computed(() => seriesFor("rssBytes", value => value / 1024 / 1024));
const requestSeries = computed(() => seriesFor("requestP95Ms"));
const eventLoopSeries = computed(() => seriesFor("eventLoopP95Ms"));
const gcSeries = computed(() => seriesFor("gcDurationMs"));

function formatBytes(value: number | undefined): string {
  if (!value) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 1_000);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [nextSummary, logs] = await Promise.all([
      loadPerformanceSummary(rangeMs.value),
      loadPerformanceLogs(40)
    ]);
    summary.value = nextSummary;
    recentLogs.value = logs;
    if (!configLoaded.value) {
      configHydrating.value = true;
      config.value = { ...nextSummary.config };
      configLoaded.value = true;
      await nextTick();
      configHydrating.value = false;
    }
  } catch (loadError) {
    error.value = userFacingError(loadError);
  } finally {
    loading.value = false;
  }
}

async function saveConfig(): Promise<void> {
  if (!configLoaded.value || saving.value) return;
  saving.value = true;
  configHydrating.value = true;
  error.value = "";
  saved.value = "";
  try {
    const next = await savePerformanceConfig(config.value);
    config.value = { ...next };
    updateFrontendPerformanceConfig(next);
    saved.value = next.enabled ? "性能记录已开启" : "性能记录已关闭";
    await refresh();
    await nextTick();
    configDirty.value = false;
  } catch (saveError) {
    error.value = userFacingError(saveError);
    throw saveError;
  } finally {
    saving.value = false;
    configHydrating.value = false;
  }
}

watch(config, () => {
  if (configLoaded.value && !configHydrating.value) configDirty.value = true;
}, { deep: true });

watch(rangeMs, () => { void refresh(); });

onMounted(async () => {
  unregisterPageSaveAction = registerPageSaveAction({
    dirty: configDirty,
    ready: configLoaded,
    saving,
    save: saveConfig
  });
  try {
    config.value = { ...await loadPerformanceConfig() };
    configLoaded.value = true;
    await nextTick();
  } catch {
    // Summary request below reports the actionable error.
  } finally {
    configHydrating.value = false;
  }
  await refresh();
  events = managerEventSource("/api/performance/events");
  events.addEventListener("sample", scheduleRefresh);
});

onBeforeUnmount(() => {
  events?.close();
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  unregisterPageSaveAction?.();
});
</script>

<template>
  <div class="page-shell performance-page">
    <header class="performance-hero">
      <div>
        <span class="performance-kicker">FLIGHT RECORDER · 本机性能记录</span>
        <h1>性能监控</h1>
        <p>持续记录 Manager、Gateway 和当前 WebGUI 的近期性能，数据写入独立 JSONL。</p>
      </div>
      <div class="performance-live" :class="{ active: config.enabled }">
        <i />
        <span>{{ config.enabled ? "记录中" : "已关闭" }}</span>
      </div>
    </header>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="saved" type="success" variant="tonal" class="mb-4">{{ saved }}</v-alert>

    <TrustedWebRendererHost :renderers="performanceStatusRenderers" :context="performanceStatusContext" />

    <section class="performance-config">
      <div class="performance-config-copy">
        <span>RECORDER CONTROL</span>
        <h2>记录设置</h2>
        <p>关闭后停止新增样本；已有文件保留到设定期限。</p>
      </div>
      <div class="performance-config-fields">
        <v-switch v-model="config.enabled" color="teal" inset label="开启性能记录" hide-details />
        <v-text-field v-model.number="config.sampleIntervalMs" type="number" min="1000" max="60000" label="采样间隔（毫秒）" density="compact" />
        <v-text-field v-model.number="config.retentionHours" type="number" min="1" max="720" label="保留时间（小时）" density="compact" />
        <v-text-field v-model.number="config.maxDiskMb" type="number" min="16" max="4096" label="最大空间（MB）" density="compact" />
        <v-text-field v-model.number="config.slowOperationMs" type="number" min="100" max="120000" label="慢操作阈值（毫秒）" density="compact" />
      </div>
    </section>

    <div class="performance-toolbar">
      <v-select v-model="rangeMs" :items="rangeOptions" label="查看范围" density="compact" hide-details />
      <v-btn variant="tonal" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">刷新</v-btn>
      <span v-if="summary">每 {{ Math.round(summary.bucketMs / 1000) }} 秒一个图表点</span>
    </div>

    <section class="performance-grid performance-charts">
      <PerformanceTimelineChart eyebrow="PROCESS LOAD" title="CPU 使用率" unit="%" :series="cpuSeries" />
      <PerformanceTimelineChart eyebrow="WORKING SET" title="内存占用" unit="MB" :series="memorySeries" />
      <PerformanceTimelineChart eyebrow="REQUEST LATENCY" title="接口 P95" unit="ms" :series="requestSeries" />
      <PerformanceTimelineChart eyebrow="EVENT LOOP" title="事件循环 P95" unit="ms" :series="eventLoopSeries" />
      <PerformanceTimelineChart eyebrow="GARBAGE COLLECTION" title="垃圾回收耗时" unit="ms" :series="gcSeries" />
    </section>

    <section class="performance-grid performance-hotspots">
      <article class="performance-panel">
        <header><div><span>INTERNAL HOTSPOTS</span><h2>内部阶段热点</h2></div></header>
        <div class="performance-table-wrap">
          <table class="performance-table">
            <thead><tr><th>阶段</th><th>来源</th><th>次数</th><th>总耗时</th><th>P95</th><th>最大</th></tr></thead>
            <tbody>
              <tr v-for="item in summary?.hotOperations || []" :key="`${item.source.runtimeId}:${item.operation}`">
                <td>{{ item.operation }}</td><td>{{ sourceLabel(item) }}</td><td>{{ item.count }}</td>
                <td>{{ item.totalMs.toFixed(1) }} ms</td><td>{{ item.p95Ms.toFixed(1) }} ms</td><td>{{ item.maxMs.toFixed(1) }} ms</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!summary?.hotOperations.length">等待内部阶段样本</p>
        </div>
      </article>

      <article class="performance-panel">
        <header><div><span>HTTP HOTSPOTS</span><h2>接口热点</h2></div></header>
        <div class="performance-table-wrap">
          <table class="performance-table">
            <thead><tr><th>接口</th><th>来源</th><th>次数</th><th>总耗时</th><th>P95</th><th>数据量</th></tr></thead>
            <tbody>
              <tr v-for="item in summary?.httpOperations || []" :key="`${item.source.runtimeId}:${item.operation}`">
                <td>{{ item.operation }}</td><td>{{ sourceLabel(item) }}</td><td>{{ item.count }}</td>
                <td>{{ item.totalMs.toFixed(1) }} ms</td><td>{{ item.p95Ms.toFixed(1) }} ms</td><td>{{ formatBytes(item.totalBytes) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!summary?.httpOperations.length">等待接口样本</p>
        </div>
      </article>
    </section>

    <section class="performance-panel performance-overhead-panel">
      <header><div><span>RECORDER OVERHEAD</span><h2>记录器自身耗时</h2></div></header>
      <div class="performance-overhead-grid">
        <div><span>追加样本</span><strong>{{ (summary?.status.lastAppendDurationMs ?? 0).toFixed(2) }} ms</strong></div>
        <div><span>生成汇总</span><strong>{{ (summary?.status.lastSummaryDurationMs ?? 0).toFixed(2) }} ms</strong></div>
        <div><span>写入文件</span><strong>{{ (summary?.status.lastFlushDurationMs ?? 0).toFixed(2) }} ms</strong></div>
        <div><span>清理文件</span><strong>{{ (summary?.status.lastCleanupDurationMs ?? 0).toFixed(2) }} ms</strong></div>
        <div><span>汇总缓存命中</span><strong>{{ summary?.status.summaryCacheHits ?? 0 }}</strong></div>
      </div>
    </section>

    <section class="performance-grid performance-bottom">
      <article class="performance-panel">
        <header><div><span>SOURCES</span><h2>采集器状态</h2></div></header>
        <div class="performance-source-list">
          <div v-for="source in summary?.sources || []" :key="`${source.source.kind}:${source.source.id}:${source.source.runtimeId}`">
            <i :class="{ online: source.online }" />
            <div><strong>{{ sourceLabel(source) }}</strong><span>{{ source.lastSeenAt }}</span></div>
            <b>{{ formatBytes(source.latest?.rssBytes) }}</b>
          </div>
          <p v-if="!summary?.sources.length">等待采集器上报</p>
        </div>
      </article>

      <article class="performance-panel slow-panel">
        <header><div><span>SLOW OPERATIONS</span><h2>最近慢操作</h2></div></header>
        <div class="performance-slow-list">
          <div v-for="item in summary?.slowOperations || []" :key="`${item.time}:${item.source.runtimeId}:${item.operation}`">
            <strong>{{ item.durationMs.toFixed(1) }} ms</strong>
            <div><b>{{ item.operation }}</b><span>{{ sourceLabel(item) }} · {{ item.time }}</span></div>
          </div>
          <p v-if="!summary?.slowOperations.length">当前范围没有慢操作</p>
        </div>
      </article>
    </section>

    <section class="performance-panel performance-log-panel">
      <header>
        <div><span>JSONL TAIL</span><h2>最近性能日志</h2></div>
        <b>{{ summary?.status.fileCount || 0 }} 个文件 · {{ summary?.status.retainedRecords || 0 }} 条内存记录</b>
      </header>
      <pre>{{ logText || "等待性能日志" }}</pre>
    </section>
  </div>
</template>

<style scoped>
.performance-page { --perf-ink: var(--rr-text); --perf-teal: var(--rr-accent-strong); --perf-amber: #e8a838; display: grid; gap: 18px; color: var(--perf-ink); }
.performance-hero { position: relative; display: flex; min-height: 190px; align-items: flex-end; justify-content: space-between; gap: 24px; overflow: hidden; border-radius: 28px; padding: 34px; background: radial-gradient(circle at 86% 18%, rgba(87, 219, 207, .2), transparent 25%), linear-gradient(125deg, #09202b, #123946 65%, #0e5553); color: #f2ffff; box-shadow: 0 22px 54px rgba(17, 53, 65, .2); }
.performance-hero::after { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 39px, rgba(187, 255, 249, .035) 40px), repeating-linear-gradient(0deg, transparent 0 39px, rgba(187, 255, 249, .035) 40px); content: ""; pointer-events: none; }
.performance-hero > * { position: relative; z-index: 1; }
.performance-kicker, .performance-panel header span, .performance-config-copy > span { font-size: 10px; font-weight: 900; letter-spacing: .17em; }
.performance-kicker { color: #b8f5f3; }
.performance-panel header span, .performance-config-copy > span { color: var(--rr-accent-text); }
.performance-hero h1 { margin: 8px 0 4px; font-family: Georgia, "Times New Roman", serif; font-size: clamp(36px, 5vw, 58px); line-height: 1; }
.performance-hero p { max-width: 640px; margin: 0; color: #b8d5d8; font-size: 14px; }
.performance-live { display: inline-flex; align-items: center; gap: 9px; border: 1px solid rgba(255,255,255,.15); border-radius: 999px; padding: 10px 14px; background: rgba(2, 16, 22, .28); font-size: 12px; font-weight: 900; }
.performance-live i { width: 9px; height: 9px; border-radius: 50%; background: #83989b; }
.performance-live.active i { background: #66e3b4; box-shadow: 0 0 0 6px rgba(102, 227, 180, .12), 0 0 18px #66e3b4; animation: perf-pulse 1.8s ease-in-out infinite; }
.performance-grid { display: grid; gap: 14px; }
.performance-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.performance-stat { min-width: 0; border: 1px solid var(--rr-border); border-radius: 20px; padding: 18px; background: var(--rr-surface); box-shadow: 0 12px 30px rgba(19, 59, 70, .07); }
.performance-stat.primary { background: linear-gradient(145deg, var(--rr-accent-surface), var(--rr-surface)); }
.performance-stat > span { color: var(--rr-muted); font-size: 11px; font-weight: 850; }
.performance-stat strong { display: block; margin: 5px 0; color: var(--rr-heading); font-family: Georgia, "Times New Roman", serif; font-size: 34px; line-height: 1; }
.performance-stat strong small { margin-left: 4px; color: var(--rr-muted-soft); font-family: inherit; font-size: 14px; }
.performance-stat p { overflow: hidden; margin: 0; color: var(--rr-muted-faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.performance-config { display: grid; grid-template-columns: minmax(220px, .72fr) minmax(0, 1.7fr); gap: 22px; border: 1px solid var(--rr-border); border-radius: 24px; padding: 22px; background: linear-gradient(120deg, var(--rr-accent-surface), var(--rr-surface) 58%); }
.performance-config-copy h2, .performance-panel h2 { margin: 4px 0 5px; font-family: Georgia, "Times New Roman", serif; font-size: 24px; }
.performance-config-copy p { margin: 0; color: var(--rr-muted); font-size: 12px; }
.performance-config-fields { display: grid; grid-template-columns: minmax(180px, .9fr) repeat(4, minmax(130px, 1fr)) auto; align-items: center; gap: 10px; }
.performance-toolbar { display: flex; align-items: center; gap: 10px; }
.performance-toolbar .v-select { max-width: 220px; }
.performance-toolbar > span { color: var(--rr-muted-soft); font-size: 11px; }
.performance-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.performance-bottom { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
.performance-hotspots { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.performance-panel { min-width: 0; border: 1px solid var(--rr-border); border-radius: 22px; padding: 20px; background: var(--rr-surface); box-shadow: 0 14px 34px rgba(19, 59, 70, .07); }
.performance-panel header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.performance-panel header > b { color: var(--rr-muted); font-size: 10px; }
.performance-source-list, .performance-slow-list { display: grid; gap: 8px; }
.performance-source-list > div { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; border-radius: 14px; padding: 11px 12px; background: var(--rr-subtle); }
.performance-source-list i { width: 9px; height: 9px; border-radius: 50%; background: var(--rr-disabled); }
.performance-source-list i.online { background: #19a978; box-shadow: 0 0 0 4px rgba(25, 169, 120, .12); }
.performance-source-list div div, .performance-slow-list div div { display: grid; min-width: 0; }
.performance-source-list strong, .performance-slow-list b { overflow: hidden; color: var(--rr-heading); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.performance-source-list span { color: var(--rr-muted-faint); font-size: 9px; }
.performance-slow-list span { color: var(--rr-muted); font-size: 9px; }
.performance-source-list b { color: var(--rr-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.performance-slow-list { max-height: 310px; overflow: auto; }
.performance-slow-list > div { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 12px; border-left: 3px solid #ef846c; border-radius: 0 12px 12px 0; padding: 10px 12px; background: var(--rr-error-surface); }
.performance-slow-list > div > strong { color: var(--rr-error-text); font-size: 12px; font-variant-numeric: tabular-nums; }
.performance-log-panel pre { max-height: 430px; overflow: auto; border-radius: 16px; padding: 16px; background: #071a22; color: #b8e7df; font: 11px/1.65 Consolas, "Courier New", monospace; white-space: pre-wrap; word-break: break-all; }
.performance-table-wrap { max-height: 360px; overflow: auto; }
.performance-table { width: 100%; border-collapse: collapse; font-size: 10px; }
.performance-table th, .performance-table td { border-bottom: 1px solid var(--rr-border); padding: 9px 8px; text-align: right; white-space: nowrap; }
.performance-table th:first-child, .performance-table td:first-child, .performance-table th:nth-child(2), .performance-table td:nth-child(2) { text-align: left; }
.performance-table td:first-child { max-width: 260px; overflow: hidden; color: var(--rr-heading); font-weight: 800; text-overflow: ellipsis; }
.performance-overhead-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.performance-overhead-grid > div { display: grid; gap: 4px; border-radius: 14px; padding: 12px; background: var(--rr-subtle); }
.performance-overhead-grid span { color: var(--rr-muted); font-size: 10px; }
.performance-overhead-grid strong { color: var(--rr-heading); font-size: 15px; font-variant-numeric: tabular-nums; }
@keyframes perf-pulse { 50% { opacity: .55; transform: scale(.82); } }
@media (max-width: 1250px) { .performance-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); } .performance-config { grid-template-columns: 1fr; } .performance-config-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) { .performance-hero { align-items: flex-start; flex-direction: column; } .performance-charts, .performance-bottom, .performance-hotspots { grid-template-columns: 1fr; } .performance-config-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } .performance-overhead-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .performance-hero { padding: 24px; } .performance-overview, .performance-config-fields { grid-template-columns: 1fr; } .performance-toolbar { align-items: stretch; flex-direction: column; } .performance-toolbar .v-select { max-width: none; } }
</style>
