<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { managerEventSource, managerResourceUrl } from "../managerApi";

type Model = { id: string; label: string; fps: number; width: number; height: number; frames: number };
type Job = { id: string; prompt: string; status: string; progress: number; createdAt: string; error?: string; videoUrl?: string };
type Snapshot = { online: boolean; models: Model[]; states: Record<string, { label: string; terminal: boolean }>; jobs: Job[] };
const snapshot = ref<Snapshot>();
type ModelManagement = { runtimeInstalled: boolean; models: { id: string; label: string; bytes: number; installed: boolean }[]; job: { kind: string; state: string; bytes: number; total: number; message?: string } | null };
type Directories = { revision: number; modelRoot: string | null; effectiveModelRoot: string; defaultModelRoot: string };
const management = ref<ModelManagement>();
const directories = ref<Directories>();
const modelDirectory = ref("");
const showModels = ref(false);
const installing = computed(() => management.value?.job?.state === "running");
async function refreshModels() { management.value = await request<ModelManagement>("/models"); }
async function openModels() {
  showModels.value = true;
  await refreshModels();
  directories.value = await request<Directories>("/models/settings");
  modelDirectory.value = directories.value.modelRoot || "";
}
async function saveDirectory() {
  directories.value = await request<Directories>("/models/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelRoot: modelDirectory.value.trim() || null, expectedRevision: directories.value?.revision }) });
  await refreshModels();
}
async function install(route: string) { await request(route, { method: "POST" }); await refreshModels(); }
const error = ref("");
const busy = ref(false);
const prompt = ref("");
const model = ref("");
const width = ref(768), height = ref(768), frames = ref(107), seed = ref(1);
const firstFrame = ref(""), lastFrame = ref("");
const firstName = ref(""), lastName = ref("");
let events: EventSource | undefined;
let refreshFlight: Promise<void> | undefined;
let pendingSubmission: { body: string; key: string } | undefined;
let disposed = false;
const duration = computed(() => (frames.value / (snapshot.value?.models.find(item => item.id === model.value)?.fps || 24)).toFixed(2));
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/video${route}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body as T;
}
function refresh(): Promise<void> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = request<Snapshot>("/status").then(value => {
    if (disposed) return;
    snapshot.value = value;
    if (!model.value) model.value = value.models[0]?.id || "";
  }).finally(() => { refreshFlight = undefined; });
  return refreshFlight;
}
async function action(operation: () => Promise<unknown>) {
  busy.value = true; error.value = "";
  try { await operation(); await refresh(); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : "请求失败。"; }
  finally { busy.value = false; }
}
async function loadImage(event: Event, first: boolean) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) { if (first) { firstFrame.value = ""; firstName.value = ""; } else { lastFrame.value = ""; lastName.value = ""; } return; }
  if (file.type !== "image/png" || file.size > 9 * 1024 * 1024) { error.value = "请选择不超过 9 MB 的 PNG。"; return; }
  try {
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file);
    });
    if (first) { firstFrame.value = encoded; firstName.value = file.name; } else { lastFrame.value = encoded; lastName.value = file.name; }
  } catch { error.value = "图片读取失败，请重新选择。"; }
}
async function submit() {
  const body = JSON.stringify({ model: model.value, prompt: prompt.value, width: width.value, height: height.value, frames: frames.value, seed: seed.value, ...(firstFrame.value ? { firstFrame: firstFrame.value } : {}), ...(lastFrame.value ? { lastFrame: lastFrame.value } : {}) });
  if (!pendingSubmission || pendingSubmission.body !== body) pendingSubmission = { body, key: crypto.randomUUID() };
  await request("/jobs", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": pendingSubmission.key }, body });
  pendingSubmission = undefined;
}
onMounted(() => {
  void action(refresh);
  events = managerEventSource("/api/events");
  events.addEventListener("plugin_event", event => {
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      const value = payload.data?.instanceId ? payload.data : payload;
      if (value.instanceId !== "manager:video") return;
      if (value.name === "video.models") { if (showModels.value) void refreshModels().catch(() => { error.value = "无法更新模型状态。"; }); return; }
      if (value.name === "video.progress") {
        const job = snapshot.value?.jobs.find(item => item.id === value.data.jobId);
        if (job) job.progress = value.data.progress;
      } else if (value.name === "video.changed") void refresh().catch(() => { error.value = "任务状态更新失败，请刷新。"; });
    } catch { error.value = "任务事件读取失败，请刷新。"; }
  });
  events.onopen = () => { void refresh().catch(() => { error.value = "无法读取视频服务状态。"; }); };
});
onBeforeUnmount(() => { disposed = true; events?.close(); });
</script>

<template>
  <div class="video-page">
    <div class="video-heading">
      <div><h1>视频生成</h1><span>{{ snapshot ? (snapshot.online ? '服务已就绪' : '服务未启动') : '正在连接' }}</span></div>
      <v-btn variant="outlined" @click="action(openModels)">模型管理</v-btn>
      <v-switch :model-value="snapshot?.online || false" :loading="busy" :disabled="busy || !snapshot || installing" hide-details color="primary" aria-label="视频生成服务开关" @update:model-value="value => action(() => request(value ? '/runtime/start' : '/runtime/stop', { method: 'POST' }))" />
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-dialog v-model="showModels" max-width="760">
      <v-card title="视频模型管理" class="pa-4">
        <v-card-text>
          <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
          <v-text-field v-model="modelDirectory" label="模型目录" :placeholder="directories?.defaultModelRoot" hint="留空使用默认目录。修改目录不会移动已有模型。" persistent-hint :disabled="busy || installing || snapshot?.online" />
          <p v-if="directories" class="video-hint">当前目录：{{ directories.effectiveModelRoot }}</p>
          <v-btn variant="outlined" :disabled="busy || installing || snapshot?.online || !directories" @click="action(saveDirectory)">保存目录</v-btn>
          <v-divider class="my-5" />
          <div class="video-heading"><strong>视频运行环境</strong><v-btn :disabled="busy || installing || snapshot?.online || management?.runtimeInstalled" @click="action(() => install('/models/runtime'))">{{ management?.runtimeInstalled ? '已安装' : '安装运行环境' }}</v-btn></div>
          <p class="video-hint">需要 NVIDIA CUDA 显卡。首次安装会下载 Python、ComfyUI 和推理依赖。</p>
          <div v-for="item in management?.models || []" :key="item.id" class="video-heading"><div><strong>{{ item.label }}</strong><p>{{ (item.bytes / 1024 ** 3).toFixed(1) }} GiB · {{ item.installed ? '已下载' : '未下载完整' }}</p></div><v-btn :disabled="busy || installing || snapshot?.online || item.installed" @click="action(() => install(`/models/${item.id}/download`))">{{ item.installed ? '已下载' : '下载模型' }}</v-btn></div>
          <v-progress-linear v-if="installing" :model-value="management?.job?.total ? management.job.bytes / management.job.total * 100 : 0" :indeterminate="!management?.job?.total" color="primary" />
          <p v-if="management?.job" role="status">{{ management.job.state === 'running' ? '正在安装，请保持程序运行' : management.job.state === 'completed' ? '安装完成' : management.job.message }}</p>
          <p v-if="snapshot?.online" class="video-hint">停止视频服务后可以修改目录或安装。</p>
        </v-card-text>
        <v-card-actions><v-btn @click="action(refreshModels)">刷新状态</v-btn><v-spacer /><v-btn @click="showModels = false">关闭</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-card class="pa-5 mb-5" variant="outlined">
      <v-select v-model="model" :items="snapshot?.models || []" item-title="label" item-value="id" label="生成模型" :disabled="busy" />
      <v-textarea v-model="prompt" label="画面与动作描述" placeholder="描述人物或物体、动作、场景和镜头。" :maxlength="12000" rows="4" counter />
      <div class="video-parameters">
        <v-text-field v-model.number="width" type="number" label="宽度（像素）" min="256" step="32" />
        <v-text-field v-model.number="height" type="number" label="高度（像素）" min="256" step="32" />
        <v-text-field v-model.number="frames" type="number" label="帧数" min="22" max="260" step="17" :hint="`${duration} 秒 · 24 FPS`" persistent-hint />
        <v-text-field v-model.number="seed" type="number" label="随机种子" min="0" step="1" />
      </div>
      <div class="video-frames">
        <label>首帧（可选）<input type="file" accept="image/png" @change="event => loadImage(event, true)" /><small>{{ firstName || 'PNG，不超过 9 MB' }}</small></label>
        <label>尾帧（可选）<input type="file" accept="image/png" @change="event => loadImage(event, false)" /><small>{{ lastName || 'PNG，不超过 9 MB' }}</small></label>
      </div>
      <p class="video-hint">图片宽高须与输出一致。视频默认无音轨。</p>
      <v-btn color="primary" :disabled="busy || !snapshot?.online || !prompt.trim()" :loading="busy" @click="action(submit)">加入生成队列</v-btn>
    </v-card>
    <div class="video-heading"><h2>最近任务</h2><v-btn variant="text" :disabled="busy" @click="action(refresh)">刷新</v-btn></div>
    <p v-if="snapshot && !snapshot.jobs.length" class="video-hint">还没有生成任务。</p>
    <v-card v-for="job in snapshot?.jobs || []" :key="job.id" variant="outlined" class="pa-4 mb-3">
      <div class="video-heading"><strong>{{ snapshot?.states[job.status]?.label || job.status }}</strong><time>{{ new Date(job.createdAt).toLocaleString() }}</time></div>
      <p class="video-prompt">{{ job.prompt }}</p>
      <v-progress-linear v-if="job.status === 'running'" :model-value="job.progress * 100" :indeterminate="job.progress === 0" color="primary" />
      <p v-if="job.error" role="alert">{{ job.error }}</p>
      <video v-if="job.videoUrl" :src="managerResourceUrl(job.videoUrl)" controls preload="metadata" />
      <v-btn v-if="job.videoUrl" :href="managerResourceUrl(job.videoUrl)" :download="`${job.id}.mp4`" variant="text">下载视频</v-btn>
      <v-btn v-if="job.status === 'queued'" variant="text" :disabled="busy" @click="action(() => request(`/jobs/${job.id}/cancel`, { method: 'POST' }))">取消排队</v-btn>
    </v-card>
  </div>
</template>

<style scoped>
.video-page { max-width: 1100px; margin: 0 auto; padding: 24px; color: var(--rr-text); }
.video-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.video-heading h1 { font-size: 26px; margin-bottom: 4px; }
.video-heading h2 { font-size: 20px; }
.video-heading span, .video-hint, small, time { color: var(--rr-muted); }
.video-parameters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.video-frames { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
.video-frames label { display: grid; gap: 8px; min-width: 0; }
.video-frames input { max-width: 100%; }
.video-hint { margin: 12px 0; font-size: 14px; }
.video-prompt { white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
video { display: block; width: 100%; max-height: 480px; margin: 12px 0; border-radius: 8px; background: #111; }
@media (max-width: 650px) { .video-page { padding: 12px; } .video-parameters { grid-template-columns: 1fr 1fr; } .video-frames { grid-template-columns: 1fr; } }
</style>
