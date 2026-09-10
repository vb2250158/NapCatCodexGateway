<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  SpeechManagedModel,
  SpeechManagedModelCapability,
  SpeechModelManagementJob,
  SpeechModelManagementSnapshot,
  SpeechModelDirectorySettings
} from "@shared/speechModelManagement";
import { managerEventSource } from "../managerApi";
import { useI18n } from "../i18n";
import { speechModelManagementClient, SpeechModelManagementRequestError } from "../speech/speechModelManagementClient";

type CapabilityFilter = SpeechManagedModelCapability;

const { isEnglish } = useI18n();
const snapshot = ref<SpeechModelManagementSnapshot>();
const loading = ref(false);
const actionError = ref("");
const search = ref("");
const capability = ref<CapabilityFilter>("tts");
const directorySettings = ref<SpeechModelDirectorySettings>();
const directoryDraft = ref("");
const directoryLoading = ref(false);
const directorySaving = ref(false);
const directoryLocalOnly = ref(false);
const directoryError = ref("");
const directorySaved = ref(false);
let managerEvents: EventSource | null = null;
let loadVersion = 0;

const copy = computed(() => isEnglish.value ? {
  refresh: "Refresh",
  runtimeTitle: "Speech environment",
  runtimeCopy: "Installs the private Python dependencies and Windows speech host. It does not download any model weights.",
  environment: "Dependencies",
  host: "Windows host",
  installed: "Installed",
  missing: "Not installed",
  unsupported: "Windows only",
  installRuntime: "Install speech environment",
  reinstallRuntime: "Reinstall speech environment",
  installingRuntime: "Installing environment",
  modelLibrary: "Model library",
  modelCount: "models",
  model: "Model",
  capability: "Capability",
  purpose: "Purpose",
  size: "Size",
  runtime: "Runtime",
  status: "Status",
  action: "Action",
  search: "Search name, family, or alias",
  tts: "Text to speech",
  asr: "Speech recognition",
  speaker: "Speaker recognition",
  sizeUnknown: "Size not measured",
  coreRuntime: "Uses the core environment",
  isolatedRuntime: "Requires an isolated environment",
  notDownloaded: "Not downloaded",
  downloaded: "Model downloaded",
  failed: "Last download failed",
  downloading: "Downloading",
  download: "Download model",
  redownload: "Download again",
  prepareFirst: "Install the speech environment first",
  empty: "No models match the current filters.",
  source: "Official source",
  boundaryTitle: "Downloaded does not mean ready to run",
  boundaryCopy: "The page verifies that model files were downloaded. Qwen3, CosyVoice, GPT-SoVITS, IndexTTS, SenseVoice, and FireRed still need their own isolated runtime before RabiSpeech can load them. Licensed ONNX-VITS packages must be imported manually and are not offered as a public download.",
  currentTask: "Current task",
  lastTask: "Last task",
  jobRunning: "Running",
  jobCompleted: "Completed",
  jobFailed: "Failed"
} : {
  refresh: "刷新",
  runtimeTitle: "语音运行环境",
  runtimeCopy: "安装私有 Python 依赖和 Windows 语音宿主，不会顺带下载任何模型权重。",
  environment: "运行依赖",
  host: "Windows 宿主",
  installed: "已安装",
  missing: "未安装",
  unsupported: "仅支持 Windows",
  installRuntime: "安装语音运行环境",
  reinstallRuntime: "重新安装语音运行环境",
  installingRuntime: "正在安装运行环境",
  modelLibrary: "模型库",
  modelCount: "个模型",
  model: "模型",
  capability: "类型",
  purpose: "用途",
  size: "大小",
  runtime: "运行环境",
  status: "状态",
  action: "操作",
  search: "搜索名称、系列或别名",
  tts: "语音合成",
  asr: "语音识别",
  speaker: "说话人识别",
  sizeUnknown: "尚未测量大小",
  coreRuntime: "使用核心环境",
  isolatedRuntime: "需独立环境",
  notDownloaded: "未下载",
  downloaded: "模型已下载",
  failed: "上次下载失败",
  downloading: "正在下载",
  download: "下载模型",
  redownload: "重新下载",
  prepareFirst: "请先安装语音运行环境",
  empty: "没有符合当前筛选条件的模型。",
  source: "官方来源",
  boundaryTitle: "权重下载完成，不等于模型已经可以运行",
  boundaryCopy: "此页面只确认模型文件已经下载。Qwen3、CosyVoice、GPT-SoVITS、IndexTTS、SenseVoice 和 FireRed 仍需各自的隔离运行环境，RabiSpeech 才能加载。需要授权的 ONNX-VITS 模型包只能手动导入，不提供公开下载。",
  currentTask: "当前任务",
  lastTask: "最近任务",
  jobRunning: "执行中",
  jobCompleted: "已完成",
  jobFailed: "失败"
});

const capabilityItems = computed(() => [
  { value: "tts", label: copy.value.tts, icon: "mdi-account-voice" },
  { value: "asr", label: copy.value.asr, icon: "mdi-waveform" },
  { value: "speaker", label: copy.value.speaker, icon: "mdi-account-search-outline" }
]);

const models = computed(() => (snapshot.value?.models ?? []).filter(model => model.capability === capability.value));
const filteredModels = computed(() => {
  const query = (search.value ?? "").trim().toLocaleLowerCase();
  return models.value.filter(model => {
    if (!query) return true;
    return [model.name, model.family, model.alias, model.purposeZh, model.purposeEn]
      .some(value => value.toLocaleLowerCase().includes(query));
  });
});
const downloadedCount = computed(() => models.value.filter(model => model.downloaded).length);
const activeJob = computed(() => snapshot.value?.activeJob);
const displayedJob = computed(() => activeJob.value ?? snapshot.value?.lastJob);
const runtimeBusy = computed(() => activeJob.value?.kind === "runtime");

const directoryCopy = computed(() => isEnglish.value ? {
  title: "Model directory", label: "Model root (blank uses environment or default)",
  effective: "Effective directory", default: "Platform default", save: "Save directory",
  note: "Saving changes future downloads and file detection only; existing models are not moved. Blank removes the override: environment configuration takes precedence over the platform default.",
  localOnly: "Model directory settings are available on this computer only.", saved: "Directory saved.",
  configured: "Configured", environment: "Environment", fallback: "Default"
} : {
  title: "模型目录", label: "模型总目录（留空使用环境配置或默认值）",
  effective: "当前生效目录", default: "平台默认目录", save: "保存目录",
  note: "保存只改变后续下载和文件检测的位置，不会搬动已有模型。留空移除覆盖值：优先使用环境配置，否则使用平台默认目录。",
  localOnly: "模型目录仅可在本机设置。", saved: "目录已保存。",
  configured: "自定义", environment: "环境配置", fallback: "默认"
});
const directorySource = computed(() => directorySettings.value?.source === "configured" ? directoryCopy.value.configured
  : directorySettings.value?.source === "environment" ? directoryCopy.value.environment : directoryCopy.value.fallback);

async function loadDirectorySettings(): Promise<void> {
  if (directoryLoading.value || directorySaving.value) return;
  directoryLoading.value = true;
  directoryError.value = "";
  try {
    directorySettings.value = await speechModelManagementClient.directorySettings();
    directoryDraft.value = directorySettings.value.configuredModelRoot ?? "";
    directoryLocalOnly.value = false;
  } catch (error) {
    directorySettings.value = undefined;
    directoryLocalOnly.value = error instanceof SpeechModelManagementRequestError && error.status === 403;
    if (!directoryLocalOnly.value) directoryError.value = userFacingError(error);
  } finally {
    directoryLoading.value = false;
  }
}

async function saveDirectorySettings(): Promise<void> {
  if (!directorySettings.value || directorySaving.value || activeJob.value) return;
  directorySaving.value = true;
  directorySaved.value = false;
  directoryError.value = "";
  try {
    directorySettings.value = await speechModelManagementClient.updateDirectorySettings({
      modelRoot: (directoryDraft.value ?? "").trim() || null,
      expectedRevision: directorySettings.value.revision
    });
    directoryDraft.value = directorySettings.value.configuredModelRoot ?? "";
    directorySaved.value = true;
    await loadSnapshot();
  } catch (error) {
    if (error instanceof SpeechModelManagementRequestError && error.status === 403) {
      directoryLocalOnly.value = true;
      directorySettings.value = undefined;
      directoryDraft.value = "";
    } else {
      directoryError.value = userFacingError(error);
    }
  } finally {
    directorySaving.value = false;
  }
}

function capabilityLabel(value: SpeechManagedModelCapability): string {
  return value === "tts" ? copy.value.tts : value === "asr" ? copy.value.asr : copy.value.speaker;
}

function capabilityIcon(value: SpeechManagedModelCapability): string {
  return value === "tts" ? "mdi-account-voice" : value === "asr" ? "mdi-waveform" : "mdi-account-search-outline";
}

function capabilityColor(value: SpeechManagedModelCapability): string {
  return value === "tts" ? "primary" : value === "asr" ? "secondary" : "info";
}

function modelStatus(model: SpeechManagedModel): { label: string; color: string; icon: string } {
  if (model.status === "downloading") return { label: copy.value.downloading, color: "primary", icon: "mdi-progress-download" };
  if (model.status === "downloaded") return { label: copy.value.downloaded, color: "success", icon: "mdi-check-circle-outline" };
  if (model.status === "failed") return { label: copy.value.failed, color: "error", icon: "mdi-alert-circle-outline" };
  return { label: copy.value.notDownloaded, color: "grey", icon: "mdi-cloud-download-outline" };
}

function jobPresentation(job: SpeechModelManagementJob): { label: string; color: string; icon: string } {
  if (job.state === "running") return { label: copy.value.jobRunning, color: "primary", icon: "mdi-progress-clock" };
  if (job.state === "completed") return { label: copy.value.jobCompleted, color: "success", icon: "mdi-check-circle-outline" };
  return { label: copy.value.jobFailed, color: "error", icon: "mdi-alert-circle-outline" };
}

function jobMessage(job: SpeechModelManagementJob): string {
  if (job.state === "running") {
    if (job.kind === "runtime") return isEnglish.value ? "Installing the RabiSpeech environment." : "正在安装 RabiSpeech 语音运行环境。";
    return isEnglish.value ? `Downloading ${job.modelAlias}.` : `正在下载 ${job.modelAlias}。`;
  }
  if (job.state === "completed") {
    if (job.kind === "runtime") return isEnglish.value ? "The speech environment installation completed." : "语音运行环境安装完成。";
    return isEnglish.value ? `${job.modelAlias} download completed.` : `${job.modelAlias} 下载完成。`;
  }
  return isEnglish.value ? "The installation or download did not complete." : "安装或下载没有完成。";
}

function sizeLabel(model: SpeechManagedModel): string {
  return model.sizeGiB == null ? copy.value.sizeUnknown : `≈ ${model.sizeGiB.toFixed(2)} GiB`;
}

function runtimeLabel(model: SpeechManagedModel): string {
  return model.runtime === "core" ? copy.value.coreRuntime : copy.value.isolatedRuntime;
}

function purpose(model: SpeechManagedModel): string {
  return isEnglish.value ? model.purposeEn : model.purposeZh;
}

function modelActionLabel(model: SpeechManagedModel): string {
  if (model.status === "downloading") return copy.value.downloading;
  return model.downloaded ? copy.value.redownload : copy.value.download;
}

function modelActionDisabled(model: SpeechManagedModel): boolean {
  return !snapshot.value?.platformSupported
    || !snapshot.value?.dependenciesInstalled
    || Boolean(activeJob.value)
    || model.status === "downloading";
}

async function loadSnapshot(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  actionError.value = "";
  try {
    const next = await speechModelManagementClient.snapshot();
    if (version === loadVersion) snapshot.value = next;
  } catch (error) {
    if (version === loadVersion) actionError.value = userFacingError(error);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function installRuntime(): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installRuntime();
  } catch (error) {
    actionError.value = userFacingError(error);
  }
}

async function installModel(model: SpeechManagedModel): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installModel(model.alias);
  } catch (error) {
    actionError.value = userFacingError(error);
  }
}

function connectEvents(): void {
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("ready", () => void loadSnapshot());
  managerEvents.addEventListener("speech_model_management_changed", () => void loadSnapshot());
}

onMounted(async () => {
  void loadDirectorySettings();
  await loadSnapshot();
  connectEvents();
});

onBeforeUnmount(() => managerEvents?.close());
</script>

<template>
  <div class="page-shell model-management-page">
    <v-alert v-if="actionError" type="error" variant="tonal" closable @click:close="actionError = ''">
      {{ actionError }}
    </v-alert>

    <section class="environment-bar" :aria-label="copy.runtimeTitle" :aria-busy="loading">
      <strong>{{ copy.runtimeTitle }}</strong>
      <div class="runtime-statuses">
        <span class="runtime-status">
          <v-icon size="18" :color="snapshot?.dependenciesInstalled ? 'success' : undefined">
            {{ snapshot?.dependenciesInstalled ? "mdi-check-circle-outline" : "mdi-circle-outline" }}
          </v-icon>
          {{ copy.environment }}: {{ snapshot ? (snapshot.dependenciesInstalled ? copy.installed : copy.missing) : '—' }}
        </span>
        <span class="runtime-status">
          <v-icon size="18" :color="snapshot?.windowsHostInstalled ? 'success' : undefined">
            {{ snapshot?.windowsHostInstalled ? "mdi-check-circle-outline" : "mdi-circle-outline" }}
          </v-icon>
          {{ copy.host }}: {{ snapshot ? (snapshot.windowsHostInstalled ? copy.installed : copy.missing) : '—' }}
        </span>
      </div>
      <div class="environment-actions">
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-tools"
          :loading="runtimeBusy"
          :disabled="!snapshot?.platformSupported || Boolean(activeJob)"
          @click="installRuntime"
        >
          {{ !snapshot ? copy.runtimeTitle : !snapshot.platformSupported
            ? copy.unsupported
            : runtimeBusy
              ? copy.installingRuntime
              : snapshot.dependenciesInstalled && snapshot.windowsHostInstalled
                ? copy.reinstallRuntime
                : copy.installRuntime }}
        </v-btn>
        <v-btn icon="mdi-refresh" variant="text" :loading="loading" :aria-label="copy.refresh" @click="loadSnapshot" />
      </div>
    </section>

    <section v-if="displayedJob" class="job-row" role="status" aria-live="polite" aria-atomic="true">
      <span>{{ activeJob ? copy.currentTask : copy.lastTask }}</span>
      <v-chip size="small" :color="jobPresentation(displayedJob).color" variant="tonal" :prepend-icon="jobPresentation(displayedJob).icon">
        {{ jobPresentation(displayedJob).label }}
      </v-chip>
      <span class="job-message">{{ jobMessage(displayedJob) }}</span>
      <v-progress-linear v-if="displayedJob.state === 'running'" class="job-progress" indeterminate color="primary" :aria-label="copy.jobRunning" />
      <v-alert v-if="displayedJob.error" class="job-error" type="error" density="compact" variant="tonal">
        {{ displayedJob.error }}
      </v-alert>
    </section>

    <details class="model-help directory-settings">
      <summary>{{ directoryCopy.title }}</summary>
      <p v-if="directoryLocalOnly">{{ directoryCopy.localOnly }}</p>
      <template v-else>
        <v-alert v-if="directoryError" type="error" density="compact" variant="tonal">{{ directoryError }}</v-alert>
        <div v-if="directorySettings" class="directory-editor">
          <p class="directory-path">{{ directoryCopy.effective }} ({{ directorySource }}): <code>{{ directorySettings.effectiveModelRoot }}</code></p>
          <p class="directory-path">{{ directoryCopy.default }}: <code>{{ directorySettings.defaultModelRoot }}</code></p>
          <form class="directory-form" @submit.prevent="saveDirectorySettings">
            <v-text-field v-model="directoryDraft" :label="directoryCopy.label" variant="outlined" density="compact" hide-details clearable :disabled="directorySaving || Boolean(activeJob)" @update:model-value="directorySaved = false" />
            <v-btn type="submit" color="primary" variant="tonal" :loading="directorySaving" :disabled="directoryLoading || Boolean(activeJob)">{{ directoryCopy.save }}</v-btn>
          </form>
          <p>{{ directoryCopy.note }}</p>
          <p v-if="directorySaved" role="status">{{ directoryCopy.saved }}</p>
        </div>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="directoryLoading" :disabled="directorySaving" @click="loadDirectorySettings">{{ copy.refresh }}</v-btn>
      </template>
    </details>

    <details class="model-help">
      <summary>{{ copy.boundaryTitle }}</summary>
      <p>{{ copy.runtimeCopy }}</p>
      <p>{{ copy.boundaryCopy }}</p>
    </details>

    <section class="library-section">
      <div class="library-header">
        <div>
          <h2>{{ copy.modelLibrary }}</h2>
          <p>{{ downloadedCount }} / {{ models.length }} {{ copy.modelCount }}</p>
        </div>
        <v-text-field
          v-model="search"
          class="model-search"
          density="compact"
          variant="solo-filled"
          flat
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          :label="copy.search"
          :aria-label="copy.search"
        />
      </div>

      <div class="capability-filter" role="group" :aria-label="copy.modelLibrary">
        <v-btn
          v-for="item in capabilityItems"
          :key="item.value"
          :variant="capability === item.value ? 'flat' : 'text'"
          :color="capability === item.value ? 'primary' : undefined"
          :prepend-icon="item.icon"
          :aria-pressed="capability === item.value"
          @click="capability = item.value as CapabilityFilter"
        >
          {{ item.label }}
        </v-btn>
      </div>

      <div v-if="filteredModels.length" class="model-table-shell" tabindex="0" role="region" :aria-label="copy.modelLibrary">
        <table class="model-table">
          <thead>
            <tr>
              <th class="model-column">{{ copy.model }}</th>
              <th class="capability-column">{{ copy.capability }}</th>
              <th class="purpose-column">{{ copy.purpose }}</th>
              <th class="size-column">{{ copy.size }}</th>
              <th class="runtime-column">{{ copy.runtime }}</th>
              <th class="status-column">{{ copy.status }}</th>
              <th class="source-column">{{ copy.source }}</th>
              <th class="action-column">{{ copy.action }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="model in filteredModels" :key="model.alias">
              <tr class="model-row">
                <td>
                  <div class="model-table-name">
                    <span>{{ model.family }}</span>
                    <strong>{{ model.name }}</strong>
                    <code>{{ model.alias }}</code>
                  </div>
                </td>
                <td>
                  <v-chip :color="capabilityColor(model.capability)" size="small" variant="tonal" :prepend-icon="capabilityIcon(model.capability)">
                    {{ capabilityLabel(model.capability) }}
                  </v-chip>
                </td>
                <td class="model-table-purpose">{{ purpose(model) }}</td>
                <td class="model-table-size">{{ sizeLabel(model) }}</td>
                <td class="model-table-runtime">
                  <v-icon size="16">{{ model.runtime === "core" ? "mdi-layers-outline" : "mdi-call-split" }}</v-icon>
                  <span>{{ runtimeLabel(model) }}</span>
                </td>
                <td>
                  <v-chip :color="modelStatus(model).color" size="small" variant="text" :prepend-icon="modelStatus(model).icon">
                    {{ modelStatus(model).label }}
                  </v-chip>
                </td>
                <td>
                  <v-btn variant="text" size="small" append-icon="mdi-open-in-new" :href="model.sourceUrl" target="_blank" rel="noreferrer">
                    {{ copy.source }}
                  </v-btn>
                </td>
                <td>
                  <v-tooltip :text="!snapshot?.dependenciesInstalled ? copy.prepareFirst : ''" location="top">
                    <template #activator="{ props }">
                      <span v-bind="props">
                        <v-btn
                          color="primary"
                          variant="tonal"
                          size="small"
                          prepend-icon="mdi-download"
                          :loading="model.status === 'downloading'"
                          :disabled="modelActionDisabled(model)"
                          @click="installModel(model)"
                        >
                          {{ modelActionLabel(model) }}
                        </v-btn>
                      </span>
                    </template>
                  </v-tooltip>
                </td>
              </tr>
              <tr v-if="model.lastError" class="model-error-row">
                <td colspan="8">
                  <v-alert type="error" density="compact" variant="tonal">{{ model.lastError }}</v-alert>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <v-empty-state v-else icon="mdi-cube-off-outline" :title="copy.empty" />
    </section>
  </div>
</template>

<style scoped>
.model-management-page {
  --model-ink: var(--rr-heading);
  min-width: 0;
  gap: 12px;
  color: var(--rr-text);
}

.environment-bar, .job-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 12px; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-surface); }
.environment-bar > strong { color: var(--model-ink); }
.runtime-statuses, .environment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.environment-actions { margin-left: auto; gap: 8px; }
.runtime-status { display: inline-flex; align-items: center; gap: 6px; color: var(--rr-muted-soft); font-size: 13px; }
.job-row { color: var(--rr-muted-soft); font-size: 13px; }
.job-message { flex: 1 1 220px; overflow-wrap: anywhere; }
.job-progress, .job-error { flex-basis: 100%; min-width: 0; }
.job-error { overflow-wrap: anywhere; }
.model-help { color: var(--rr-muted-soft); font-size: 13px; }
.model-help summary { cursor: pointer; padding: 8px 0; }
.model-help p { margin: 4px 0 8px; line-height: 1.6; }
.model-help summary:focus-visible, .model-table-shell:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
.directory-editor, .directory-path { min-width: 0; overflow-wrap: anywhere; }
.directory-form { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.directory-form :deep(.v-input) { flex: 1 1 280px; min-width: 0; }
.library-section { display: grid; min-width: 0; gap: 12px; }
.library-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.library-header h2 { margin: 0; color: var(--model-ink); font-size: 20px; }
.library-header p { margin: 0; color: var(--rr-muted-soft); font-size: 13px; }
.model-search { width: min(390px, 100%); flex: 0 1 390px; }
.capability-filter { display: flex; gap: 6px; overflow-x: auto; padding: 5px; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-input); }
.model-table-shell { overflow-x: auto; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-surface); }
.model-table { width: 100%; min-width: 1120px; border-collapse: collapse; table-layout: fixed; }
.model-table th { position: sticky; top: 0; z-index: 1; padding: 11px 14px; color: var(--rr-muted-soft); background: var(--rr-input); font-size: 11px; font-weight: 800; letter-spacing: .04em; text-align: left; white-space: nowrap; }
.model-table td { padding: 14px; border-top: 1px solid var(--rr-border); color: var(--rr-muted-soft); font-size: 13px; vertical-align: middle; }
.model-row { transition: background-color .15s ease; }
.model-row:hover { background: var(--rr-subtle); }
.model-column { width: 20%; }
.capability-column { width: 10%; }
.purpose-column { width: 19%; }
.size-column { width: 8%; }
.runtime-column { width: 14%; }
.status-column { width: 9%; }
.source-column { width: 8%; }
.action-column { width: 12%; }
.model-table-name { display: grid; min-width: 0; gap: 3px; }
.model-table-name > span { color: var(--rr-muted-faint); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
.model-table-name strong { overflow: hidden; color: var(--model-ink); font-size: 15px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.model-table-name code { overflow: hidden; color: var(--rr-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.model-table-purpose { line-height: 1.45; }
.model-table-size { white-space: nowrap; }
.model-table-runtime { display: table-cell; }
.model-table-runtime .v-icon { margin-right: 6px; vertical-align: -3px; }
.model-table td:last-child, .model-table th:last-child { text-align: right; }
.model-table td:nth-last-child(2), .model-table th:nth-last-child(2) { text-align: center; }
.model-error-row td { padding: 0 14px 14px; background: var(--rr-surface); }
.model-error-row :deep(.v-alert) { overflow-wrap: anywhere; }

@media (max-width: 820px) {
  .library-header { align-items: stretch; flex-direction: column; }
  .model-search { width: 100%; flex-basis: auto; }
}

@media (max-width: 640px) {
  .model-management-page { padding: 16px; }
  .environment-actions { margin-left: 0; }
  .capability-filter { flex-wrap: wrap; }
  .model-table { min-width: 1040px; }
}

@media (prefers-reduced-motion: reduce) {
  .model-row { transition: none; }
}
</style>
