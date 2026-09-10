<script setup lang="ts">
import { userFacingError } from "../../userFacingError";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { XiaomiHomeRuntimeSettings, XiaomiHomeSettingsSnapshot } from "@shared/xiaomiHomeSettingsContract";
import { registerPageSaveAction } from "../../pageSaveAction";
import { xiaomiHomeSettingsClient } from "../../xiaomiHomeSettingsClient";

type XiaomiHomeSettingsDraft = { -readonly [Key in keyof XiaomiHomeRuntimeSettings]: XiaomiHomeRuntimeSettings[Key] };

const snapshot = ref<XiaomiHomeSettingsSnapshot | null>(null);
const draft = ref<XiaomiHomeSettingsDraft | null>(null);
const cameraMotionEntities = ref("");
const cameraAllowedHosts = ref("");
const loading = ref(true);
const saving = ref(false);
const hydrating = ref(true);
const dirty = ref(false);
const error = ref("");
const ready = computed(() => !loading.value && !!snapshot.value && !!draft.value);
let unregisterSaveAction: (() => void) | undefined;

function lines(value: readonly string[]): string {
  return value.join("\n");
}

function parsedLines(value: string): readonly string[] {
  return [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))];
}

function hydrate(value: XiaomiHomeSettingsSnapshot): void {
  hydrating.value = true;
  snapshot.value = value;
  draft.value = structuredClone(value.settings);
  cameraMotionEntities.value = lines(value.settings.cameraMotionEntityIds);
  cameraAllowedHosts.value = lines(value.settings.cameraClipAllowedHosts);
  void nextTick(() => {
    dirty.value = false;
    hydrating.value = false;
  });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    hydrate(await xiaomiHomeSettingsClient.read());
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!snapshot.value || !draft.value || saving.value) return;
  saving.value = true;
  try {
    const settings: XiaomiHomeRuntimeSettings = {
      ...draft.value,
      cameraMotionEntityIds: parsedLines(cameraMotionEntities.value),
      cameraClipAllowedHosts: parsedLines(cameraAllowedHosts.value)
    };
    hydrate(await xiaomiHomeSettingsClient.update(snapshot.value, settings));
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
    throw cause;
  } finally {
    saving.value = false;
  }
}

watch([draft, cameraMotionEntities, cameraAllowedHosts], () => {
  if (!hydrating.value && ready.value) dirty.value = true;
}, { deep: true });

onMounted(() => {
  unregisterSaveAction = registerPageSaveAction({ dirty, ready, saving, save });
  void load();
});

onBeforeUnmount(() => unregisterSaveAction?.());
</script>

<template>
  <v-card class="app-card glass-card section-card xiaomi-home-message-endpoint-settings">
    <div class="section-title-row">
      <div>
        <div class="section-title">Home Assistant 连接与事件</div>
        <div class="section-note">此配置属于米家消息端，用于接收设备状态、有人移动事件和本机留存的摄像头录像。</div>
      </div>
      <v-chip v-if="snapshot" size="small" variant="tonal" :color="snapshot.source === 'runtime' ? 'success' : 'info'">
        {{ snapshot.source === "runtime" ? "本机设置" : "Profile 默认值" }}
      </v-chip>
    </div>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>

    <template v-if="draft">
      <v-alert type="info" variant="tonal" density="compact" class="mb-4">
        地址与登录凭据都在当前 Route 的“米家 / Xiaomi Home 连接”卡片完成；此页只保存事件、设备控制与录像策略。
      </v-alert>
      <div class="xiaomi-switch-grid mt-2">
        <v-switch v-model="draft.eventMonitorEnabled" label="监听设备事件" color="success" inset hide-details />
        <v-switch v-model="draft.writeEnabled" label="允许控制设备" color="warning" inset hide-details />
        <v-switch v-model="draft.cameraClipCaptureEnabled" label="保存移动事件录像" color="warning" inset hide-details />
      </div>
      <v-alert v-if="draft.writeEnabled" type="warning" variant="tonal" density="compact" class="my-3">
        开启后 Agent 才能实际控制设备；动作仍要求幂等键、最新状态版本和当前 Manager 代际围栏。
      </v-alert>
      <v-alert v-if="draft.cameraClipCaptureEnabled && !cameraAllowedHosts.trim()" type="warning" variant="tonal" density="compact" class="my-3">
        录像抓取已开启，但媒体域名白名单为空，因此仍不会下载录像。
      </v-alert>
      <div class="xiaomi-form-grid mt-3">
        <v-textarea v-model="cameraMotionEntities" label="摄像头移动事件实体" placeholder="binary_sensor.living_room_camera_motion" rows="3" hint="每行一个 Home Assistant entity_id；先从真实设备枚举确认。" persistent-hint />
        <v-textarea v-model="cameraAllowedHosts" label="录像媒体域名白名单" placeholder="example.xiaomi.com\n*.example.xiaomi.com" rows="3" hint="每行一个 HTTPS 主机；只登记真实事件录像 URL 使用的域名。" persistent-hint />
      </div>
      <v-expansion-panels variant="accordion" class="mt-3">
        <v-expansion-panel>
          <v-expansion-panel-title>高级设置</v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="xiaomi-form-grid">
              <v-select v-model="draft.eventDeliveryMode" label="事件投递范围" :items="[{ title: '重要事件', value: 'significant' }, { title: '全部状态变化', value: 'all' }]" />
              <v-text-field v-model="draft.agentRoleId" label="事件接收人格" />
              <v-text-field v-model="draft.artifactReadTokenEnv" label="录像读取 token 环境变量" />
              <v-text-field v-model.number="draft.requestTimeoutMs" type="number" min="250" max="30000" label="Home Assistant 请求超时（毫秒）" />
              <v-text-field v-model="draft.ffmpegPath" label="ffmpeg 路径" />
              <v-text-field v-model="draft.ffprobePath" label="ffprobe 路径" />
              <v-text-field v-model.number="draft.cameraClipRequestTimeoutMs" type="number" min="1000" max="30000" label="录像分片请求超时（毫秒）" />
              <v-text-field v-model.number="draft.cameraClipMaxSegments" type="number" min="1" max="500" label="单段录像最大分片数" />
              <v-text-field v-model.number="draft.cameraClipMaxSegmentBytes" type="number" min="1024" max="134217728" label="单分片最大字节数" />
            </div>
            <v-switch v-model="draft.allowPublicBaseUrl" label="允许 Home Assistant 域名或公网地址（仍禁止重定向）" color="warning" inset hide-details />
            <v-switch v-model="draft.allowInsecurePrivateHttp" label="允许非回环私网使用不安全 HTTP（令牌可能被局域网截获）" color="error" inset hide-details />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <div class="section-note mt-3">修改由页面顶部“保存”统一提交；保存成功后 Manager 热加载，无需重启正式 Host。</div>
    </template>
  </v-card>
</template>

<style scoped>
.xiaomi-form-grid,
.xiaomi-switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.xiaomi-switch-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
@media (max-width: 760px) {
  .xiaomi-form-grid,
  .xiaomi-switch-grid { grid-template-columns: 1fr; }
}
</style>
