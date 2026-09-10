<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  type SpeechEvent,
  type SpeechHistoryItem,
  type SpeechMicrophoneStats
} from "@shared/speechControlContract";
import { speechHistoryDeliveryPresentation } from "../speech/speechDeliveryPresentation";
import { useSpeechStore } from "../stores/speechStore";
import SpeechLevelWaveform from "./SpeechLevelWaveform.vue";

const props = defineProps<{ subscriberCount: number }>();
const speech = useSpeechStore();
const { microphone: status, playback } = storeToRefs(speech);
const refreshing = ref(false);
const localError = ref("");
const error = computed(() => localError.value || speech.error);
const showLog = ref(true);
const stats = computed<SpeechMicrophoneStats>(() => status.value?.stats ?? {
  captured: 0,
  recognized: 0,
  empty: 0,
  delivered: 0,
  recorded: 0,
  deliveryFailed: 0,
  submitted: 0,
  submitFailed: 0,
  dropped: 0
});
const events = computed(() => status.value?.events ?? []);
const history = computed(() => status.value?.history ?? []);
const latestPlayback = computed(() => [...(playback.value?.jobs ?? [])]
  .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]);
const latestRouteEvent = computed(() => events.value.find(event => event.stage === "route"));
type PipelineState = "idle" | "ready" | "active" | "success" | "warning" | "error";
type PipelineStage = { key: string; label: string; detail: string; state: PipelineState; icon: string };

const pipelineStages = computed<PipelineStage[]>(() => {
  const current = status.value;
  const playbackJob = latestPlayback.value;
  const routeEvent = latestRouteEvent.value;
  const microphoneState: PipelineState = current?.state === "error" ? "error" : current?.running ? "success" : "idle";
  const vadState: PipelineState = current?.utteranceActive ? "active" : Number(stats.value.captured || 0) > 0 ? "success" : current?.running ? "ready" : "idle";
  const asrState: PipelineState = current?.state === "transcribing" ? "active" : events.value[0]?.kind === "transcription_failed" ? "error" : Number(stats.value.recognized || 0) > 0 ? "success" : current?.running ? "ready" : "idle";
  let broadcastState: PipelineState = props.subscriberCount === 0 || !current?.running ? "warning" : "ready";
  if (routeEvent?.kind === "route_submission_failed") broadcastState = "error";
  else if (routeEvent?.kind === "route_submission_started") broadcastState = "active";
  else if (routeEvent?.kind === "route_recorded_only") broadcastState = "warning";
  else if (routeEvent?.kind === "route_delivery_succeeded" || Number(stats.value.submitted || 0) > 0) broadcastState = "success";
  const broadcastDetail = props.subscriberCount === 0
    ? "没有 Route 订阅语音消息"
    : !current?.running
      ? "等待常驻监听启动"
      : routeEvent?.message || `等待广播给 ${props.subscriberCount} 个 Route`;
  let playbackState: PipelineState = "idle";
  if (playbackJob?.status === "playing" || playbackJob?.status === "queued") playbackState = "active";
  else if (playbackJob?.status === "done") playbackState = "success";
  else if (playbackJob?.status === "error") playbackState = "error";

  return [
    { key: "microphone", label: "麦克风", detail: current?.running ? current.state === "playback_suppressed" ? "播放防回流" : "常驻监听中" : "未启动", state: microphoneState, icon: "mdi-microphone-outline" },
    { key: "vad", label: "VAD 切句", detail: current?.utteranceActive ? "正在收音" : `已捕获 ${Number(stats.value.captured || 0)} 段`, state: vadState, icon: "mdi-waveform" },
    { key: "asr", label: "ASR 转写", detail: current?.state === "transcribing" ? "正在识别" : `已识别 ${Number(stats.value.recognized || 0)} 段`, state: asrState, icon: "mdi-text-box-search-outline" },
    { key: "route", label: "广播投递", detail: broadcastDetail, state: broadcastState, icon: "mdi-broadcast" },
    { key: "playback", label: "回复与播放", detail: playbackJob ? playbackJob.status === "playing" ? "正在播放" : playbackJob.status === "queued" ? "等待播放" : playbackJob.status === "done" ? "最近播放完成" : playbackJob.status === "error" ? "播放失败" : playbackJob.status : "尚无回复音频", state: playbackState, icon: "mdi-account-voice" }
  ];
});

function stageClass(state: PipelineState): string { return `is-${state}`; }
function stageLabel(state: PipelineState): string {
  return ({ idle: "未运行", ready: "等待", active: "处理中", success: "正常", warning: "需检查", error: "异常" } as Record<PipelineState, string>)[state];
}
function eventIcon(event: SpeechEvent): string {
  if (event.level === "error") return "mdi-alert-circle-outline";
  if (event.stage === "route") return "mdi-broadcast";
  if (event.stage === "asr") return "mdi-text-box-search-outline";
  if (event.stage === "vad") return "mdi-waveform";
  return "mdi-microphone-outline";
}
function formatTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : "-";
}
function eventDetail(event: SpeechEvent): string {
  const details = event.details;
  const parts: string[] = [];
  if (details.duration != null) parts.push(`${Number(details.duration).toFixed(2)} 秒`);
  if (details.model) parts.push(String(details.model));
  if (details.routeId) parts.push(`Route: ${details.routeId}`);
  if (details.messageId) parts.push(`messageId: ${details.messageId}`);
  if (details.reason) parts.push(String(details.reason));
  if (details.error) parts.push(String(details.error));
  return parts.join(" · ");
}
function historySpeakerSummary(item: SpeechHistoryItem): string {
  return [...new Set((item.segments || []).map(segment => segment.speakerName || segment.speakerLabel || segment.speaker || "").filter(Boolean))].join(" / ");
}
function historyDeliveryLabel(item: SpeechHistoryItem): string { return speechHistoryDeliveryPresentation(item).label; }
function historyDeliveryColor(item: SpeechHistoryItem): string { return speechHistoryDeliveryPresentation(item).color; }
async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await Promise.all([speech.refreshMicrophone(), speech.refreshPlayback()]);
    localError.value = "";
  } catch (cause) {
    localError.value = userFacingError(cause);
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <section class="speech-host-monitor" aria-label="主机语音实时监视器">
    <header class="monitor-toolbar">
      <div>
        <div class="monitor-kicker">HOST SPEECH PIPELINE</div>
        <h4>主机语音链路</h4>
        <p>麦克风、VAD、ASR、广播投递和播放属于整台电脑；同一段转写只识别一次。</p>
      </div>
      <div class="monitor-actions">
        <v-chip :color="status?.running ? 'success' : subscriberCount ? 'warning' : 'grey'" :variant="status?.running || subscriberCount ? 'tonal' : 'outlined'">
          {{ status?.running ? `常驻监听中 · ${subscriberCount} 个 Route 已订阅` : subscriberCount ? "等待常驻监听启动" : "没有 Route 订阅语音消息" }}
        </v-chip>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="refreshing" @click="refresh">刷新</v-btn>
      </div>
    </header>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-else-if="subscriberCount === 0" type="info" variant="tonal" density="compact" class="mb-3">
      当前没有 Route 订阅语音消息。到对应 Route 打开“语音消息端”后，主机才会保持常驻监听。
    </v-alert>
    <v-alert v-else-if="!status?.running" type="warning" variant="tonal" density="compact" class="mb-3">
      已有 Route 订阅，但常驻监听尚未启动；系统正在恢复主机语音服务，可刷新查看最新状态。
    </v-alert>

    <div class="pipeline-strip">
      <article v-for="stage in pipelineStages" :key="stage.key" class="pipeline-stage" :class="stageClass(stage.state)">
        <div class="pipeline-icon"><v-icon size="22">{{ stage.icon }}</v-icon></div>
        <div class="pipeline-copy"><strong>{{ stage.label }}</strong><span>{{ stage.detail }}</span></div>
        <em>{{ stageLabel(stage.state) }}</em>
      </article>
    </div>

    <div class="monitor-meter">
      <div class="meter-head">
        <span>实时电平 <b>{{ Number(status?.level || 0).toFixed(4) }}</b></span>
        <span>底噪 {{ Number(status?.noiseFloor || 0).toFixed(4) }}</span>
        <span>动态阈值 {{ Number(status?.dynamicThreshold || status?.config.recordThreshold || 0).toFixed(4) }}</span>
      </div>
      <SpeechLevelWaveform
        :levels="status?.levelHistory || []"
        :record-threshold="Number(status?.config.recordThreshold || 0)"
        :transcribe-threshold="Number(status?.config.transcribeThreshold || 0)"
        :dynamic-threshold="Number(status?.dynamicThreshold || 0)"
        :running="status?.running"
        :state="status?.state"
      />
      <div class="meter-thresholds">
        <span>录音线 {{ Number(status?.config.recordThreshold || 0).toFixed(3) }}</span>
        <span>转写线 {{ Number(status?.config.transcribeThreshold || 0).toFixed(3) }}</span>
        <span>待识别 {{ status?.pending || 0 }}</span>
      </div>
    </div>

    <div class="monitor-counters">
      <div><span>捕获片段</span><b>{{ Number(stats.captured || 0) }}</b></div>
      <div><span>识别成功</span><b>{{ Number(stats.recognized || 0) }}</b></div>
      <div><span>Desktop 已投递</span><b>{{ Number(stats.delivered || 0) }}</b></div>
      <div :class="Number(stats.recorded || 0) ? 'counter-warning' : ''"><span>仅记录</span><b>{{ Number(stats.recorded || 0) }}</b></div>
      <div :class="Number(stats.deliveryFailed || stats.submitFailed || 0) ? 'counter-error' : ''"><span>投递失败</span><b>{{ Number(stats.deliveryFailed || stats.submitFailed || 0) }}</b></div>
      <div :class="Number(stats.dropped || 0) ? 'counter-warning' : ''"><span>队列丢弃</span><b>{{ Number(stats.dropped || 0) }}</b></div>
    </div>

    <div class="log-toolbar">
        <div><strong>运行日志与转写预览</strong><span>诊断事件属于当前主机进程；下方持久化记录保留完整 ASR/TTS 文本。</span></div>
      <v-btn size="small" variant="text" :prepend-icon="showLog ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="showLog = !showLog">{{ showLog ? "收起日志" : "展开日志" }}</v-btn>
    </div>
    <div v-if="showLog" class="monitor-log-grid">
      <div class="monitor-log-panel">
        <div class="panel-title">最近事件</div>
        <div v-if="events.length" class="event-list">
          <div v-for="event in events.slice(0, 20)" :key="event.sequence" class="event-row" :class="`event-${event.level}`">
            <v-icon size="17">{{ eventIcon(event) }}</v-icon>
            <time>{{ formatTime(event.time) }}</time>
            <div><strong>{{ event.message }}</strong><span v-if="eventDetail(event)">{{ eventDetail(event) }}</span></div>
          </div>
        </div>
        <div v-else class="empty-log">暂无事件。任意 Route 开启语音消息端后，这里会显示收音、识别和广播投递。</div>
      </div>
      <div class="monitor-log-panel">
        <div class="panel-title">最近转写</div>
        <div v-if="history.length" class="transcript-list">
          <div v-for="item in history.slice(0, 8)" :key="`${item.time}-${item.text}`">
            <div><time>{{ formatTime(item.time) }}</time><v-chip size="x-small" :color="historyDeliveryColor(item)" :variant="historyDeliveryColor(item) === 'grey' ? 'outlined' : 'tonal'">{{ historyDeliveryLabel(item) }}</v-chip></div>
            <p>{{ item.text }}</p>
            <span>{{ item.provider }}/{{ item.model }} · {{ Number(item.duration || 0).toFixed(2) }} 秒<span v-if="historySpeakerSummary(item)"> · 说话人：{{ historySpeakerSummary(item) }}</span></span>
          </div>
        </div>
        <div v-else class="empty-log">还没有转写结果。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.speech-host-monitor { grid-column: 1 / -1; padding: 18px; border: 1px solid var(--rr-accent-border); border-radius: 16px; background: var(--rr-surface); }
.monitor-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
.monitor-kicker { color: var(--rr-accent-text); font-size: 10px; font-weight: 900; letter-spacing: .13em; }
.monitor-toolbar h4 { margin: 4px 0; color: var(--rr-heading); font-size: 18px; }
.monitor-toolbar p { margin: 0; color: var(--rr-muted); font-size: 12px; }
.monitor-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pipeline-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
.pipeline-stage { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 76px; padding: 11px; border: 1px solid var(--rr-border); border-radius: 13px; background: var(--rr-subtle); }
.pipeline-stage:not(:last-child)::after { position: absolute; z-index: 2; top: 50%; right: -9px; width: 10px; height: 2px; content: ""; background: var(--rr-accent-border); }
.pipeline-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 10px; color: var(--rr-muted); background: var(--rr-input); }
.pipeline-copy { display: grid; min-width: 0; gap: 2px; }
.pipeline-copy strong { color: var(--rr-text); font-size: 12px; }
.pipeline-copy span { overflow: hidden; color: var(--rr-muted-faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pipeline-stage em { grid-column: 1 / -1; color: var(--rr-muted-faint); font-size: 10px; font-style: normal; font-weight: 800; text-align: right; }
.pipeline-stage.is-success { border-color: var(--rr-success-border); background: var(--rr-success-surface); }
.pipeline-stage.is-success .pipeline-icon { color: var(--rr-success-text); background: var(--rr-success-surface); }
.pipeline-stage.is-active { border-color: var(--rr-warning-border); background: var(--rr-warning-surface); box-shadow: 0 0 0 2px rgba(220, 147, 24, .08); }
.pipeline-stage.is-active .pipeline-icon { color: var(--rr-warning-text); background: var(--rr-warning-surface); }
.pipeline-stage.is-warning { border-color: var(--rr-warning-border); background: var(--rr-warning-surface); }
.pipeline-stage.is-error { border-color: var(--rr-error-border); background: var(--rr-error-surface); }
.pipeline-stage.is-error .pipeline-icon { color: var(--rr-error-text); background: var(--rr-error-surface); }
.monitor-meter { padding: 13px 14px; border: 1px solid var(--rr-border); border-radius: 13px; background: var(--rr-subtle); }
.meter-head, .meter-thresholds { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; color: var(--rr-muted); font-size: 11px; }
.meter-head { margin-bottom: 8px; }
.meter-thresholds { margin-top: 7px; }
.monitor-counters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.monitor-counters > div { display: flex; align-items: baseline; justify-content: space-between; padding: 9px 11px; border-radius: 10px; background: var(--rr-subtle); }
.monitor-counters span { color: var(--rr-muted-faint); font-size: 10px; }
.monitor-counters b { color: var(--rr-heading); font-size: 16px; }
.monitor-counters .counter-error b { color: var(--rr-error-text); }
.monitor-counters .counter-warning b { color: var(--rr-warning-text); }
.log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--rr-border); }
.log-toolbar > div { display: grid; gap: 2px; }
.log-toolbar strong { color: var(--rr-text); font-size: 13px; }
.log-toolbar span { color: var(--rr-muted-faint); font-size: 10px; }
.monitor-log-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.monitor-log-panel { min-width: 0; max-height: 310px; overflow: auto; padding: 12px; border: 1px solid var(--rr-border); border-radius: 12px; background: var(--rr-subtle); }
.panel-title { margin-bottom: 8px; color: var(--rr-muted); font-size: 11px; font-weight: 900; }
.event-list, .transcript-list { display: grid; gap: 7px; }
.event-row { display: grid; grid-template-columns: 20px 62px minmax(0, 1fr); gap: 7px; align-items: start; padding: 7px; border-radius: 8px; color: var(--rr-muted); background: var(--rr-input); }
.event-row time, .transcript-list time { color: var(--rr-muted-faint); font-size: 10px; }
.event-row > div { display: grid; min-width: 0; gap: 2px; }
.event-row strong { color: var(--rr-text); font-size: 11px; }
.event-row span { overflow-wrap: anywhere; color: var(--rr-muted-faint); font-size: 10px; }
.event-row.event-error { color: var(--rr-error-text); background: var(--rr-error-surface); }
.transcript-list > div { padding: 8px; border-radius: 8px; background: var(--rr-input); }
.transcript-list > div > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.transcript-list p { margin: 6px 0 3px; color: var(--rr-text); font-size: 12px; line-height: 1.5; }
.transcript-list > div > span { color: var(--rr-muted-faint); font-size: 10px; }
.empty-log { padding: 18px 8px; color: var(--rr-muted-faint); font-size: 11px; text-align: center; }
@media (max-width: 1100px) { .monitor-toolbar { align-items: stretch; flex-direction: column; } .monitor-actions { justify-content: flex-start; } .pipeline-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pipeline-stage::after { display: none; } }
@media (max-width: 720px) { .pipeline-strip, .monitor-counters, .monitor-log-grid { grid-template-columns: 1fr; } }
</style>
