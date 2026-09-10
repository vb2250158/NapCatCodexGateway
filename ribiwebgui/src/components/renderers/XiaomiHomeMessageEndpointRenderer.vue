<script setup lang="ts">
import { userFacingError } from "../../userFacingError";
import { computed, onMounted, ref } from "vue";
import type { XiaomiHomeAuthorizationSnapshot } from "@shared/xiaomiHomeAuthContract";
import type { XiaomiHomeSettingsSnapshot } from "@shared/xiaomiHomeSettingsContract";
import { xiaomiHomeAuthClient } from "../../xiaomiHomeAuthClient";
import {
  HOME_ASSISTANT_AUTHENTICATION_DOCS_URL,
  HOME_ASSISTANT_INSTALLATION_URL,
  HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL,
  homeAssistantLoginUrl,
  homeAssistantProfileUrl
} from "../../xiaomiHomeCredentialHelp";
import { xiaomiHomeSettingsClient } from "../../xiaomiHomeSettingsClient";

const authorization = ref<XiaomiHomeAuthorizationSnapshot | null>(null);
const settings = ref<XiaomiHomeSettingsSnapshot | null>(null);
const baseUrl = ref("");
const accessToken = ref("");
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const baseUrlError = ref("");
const accessTokenError = ref("");
const confirmationOpen = ref(false);

const stateLabel = computed(() => ({
  ready: "已连接",
  authorization_required: "需要凭证",
  authorization_failed: "凭证失效",
  unreachable: "服务不可达",
  timeout: "连接超时"
}[authorization.value?.state || "authorization_required"]));

const stateColor = computed(() => authorization.value?.state === "ready"
  ? "success"
  : authorization.value?.state === "authorization_required"
    ? "info"
    : "warning");

const stateAlertType = computed<"success" | "info" | "warning">(() => authorization.value?.state === "ready"
  ? "success"
  : authorization.value?.state === "authorization_required"
    ? "info"
    : "warning");

const stateDetail = computed(() => ({
  ready: "Home Assistant 已验证，当前凭证保存在本机受保护凭证库。",
  authorization_required: "尚未保存 Home Assistant 长期访问令牌。",
  authorization_failed: "Home Assistant 拒绝了当前凭证。请在令牌管理页重新创建长期访问令牌后替换。",
  unreachable: "当前地址没有响应。请先确认 Home Assistant 已启动，并且这台电脑能打开该地址。",
  timeout: "连接 Home Assistant 超时。请检查地址、网络和 Home Assistant 运行状态。"
}[authorization.value?.state || "authorization_required"]));

const loginUrl = computed(() => homeAssistantLoginUrl(baseUrl.value));
const profileUrl = computed(() => homeAssistantProfileUrl(baseUrl.value));

const sourceLabel = computed(() => authorization.value?.credentialSource === "protected"
  ? "本机受保护凭证"
  : "尚未保存凭证");

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [nextSettings, nextAuthorization] = await Promise.all([
      xiaomiHomeSettingsClient.read(),
      xiaomiHomeAuthClient.read()
    ]);
    settings.value = nextSettings;
    baseUrl.value = nextSettings.settings.baseUrl;
    authorization.value = nextAuthorization;
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    loading.value = false;
  }
}

async function connect(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  baseUrlError.value = "";
  accessTokenError.value = "";
  if (!settings.value) {
    error.value = "米家设置尚未加载。";
    return;
  }
  const normalizedBaseUrl = baseUrl.value.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    baseUrlError.value = "请填写 Home Assistant 地址。";
    return;
  }
  const candidate = accessToken.value.trim();
  if (!candidate) {
    accessTokenError.value = "请粘贴 Home Assistant 长期访问令牌。";
    return;
  }
  if (!authorization.value) {
    error.value = "米家授权状态尚未加载。";
    return;
  }
  const authorizationRevision = authorization.value.revision;
  busy.value = true;
  try {
    authorization.value = await xiaomiHomeAuthClient.connect({
      accessToken: candidate,
      baseUrl: normalizedBaseUrl,
      settingsRevision: settings.value.revision,
      authorizationRevision
    });
    settings.value = await xiaomiHomeSettingsClient.read();
    baseUrl.value = settings.value.settings.baseUrl;
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    accessToken.value = "";
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!authorization.value) throw new Error("米家授权状态尚未加载。");
    authorization.value = await xiaomiHomeAuthClient.refresh(authorization.value.revision);
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  if (busy.value) return;
  confirmationOpen.value = false;
  busy.value = true;
  try {
    if (!authorization.value) throw new Error("米家授权状态尚未加载。");
    authorization.value = await xiaomiHomeAuthClient.disconnect(authorization.value.revision);
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="xiaomi-home-endpoint-auth">
    <div class="section-title-row">
      <div>
        <div class="section-title small-title">连接 Home Assistant</div>
        <div class="section-note">令牌验证后仅保存在本机受保护凭证库。</div>
      </div>
      <v-chip v-if="authorization" size="small" variant="tonal" :color="stateColor">{{ stateLabel }}</v-chip>
    </div>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="my-3" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="my-3">{{ error }}</v-alert>

    <template v-if="!loading && settings && authorization">
      <v-alert :type="stateAlertType" variant="tonal" density="compact" class="mt-3">
        {{ stateDetail }}
      </v-alert>
      <v-text-field
        v-model="baseUrl"
        label="Home Assistant 地址"
        placeholder="http://homeassistant.local:8123"
        hint="填写这台电脑能打开的 Home Assistant 首页地址。"
        :error-messages="baseUrlError"
        class="mt-3"
        @update:model-value="baseUrlError = ''"
      />
      <div class="credential-help-actions">
        <v-btn
          :href="loginUrl || undefined"
          :disabled="!loginUrl"
          target="_blank"
          rel="noopener noreferrer"
          variant="tonal"
          size="small"
          prepend-icon="mdi-home-assistant"
        >打开 Home Assistant</v-btn>
        <v-btn
          :href="profileUrl || undefined"
          :disabled="!profileUrl"
          target="_blank"
          rel="noopener noreferrer"
          variant="tonal"
          size="small"
          prepend-icon="mdi-account-key-outline"
        >打开令牌管理</v-btn>
      </div>
      <div v-if="!loginUrl" class="section-note">先填写有效的 Home Assistant 地址。</div>
      <v-text-field
        v-model="accessToken"
        type="password"
        autocomplete="new-password"
        label="长期访问令牌"
        placeholder="只在本次连接请求中发送"
        hint="Home Assistant 长期访问令牌，不是小米账号密码或设备 token。"
        :error-messages="accessTokenError"
        :disabled="busy"
        class="mt-3"
        @update:model-value="accessTokenError = ''"
        @keyup.enter="connect"
      />
      <v-expansion-panels variant="accordion" density="compact" class="credential-help-panel">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <span class="credential-help-title"><v-icon icon="mdi-help-circle-outline" size="small" />怎样获取令牌？</span>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <ol class="credential-help-steps">
              <li>先打开 Home Assistant 并完成登录。</li>
              <li>打开“令牌管理”，在“长期访问令牌”中创建并立即复制；旧令牌无法再次显示。</li>
              <li>把令牌直接粘贴到上方，不要发送到聊天，再点“验证并连接”。</li>
            </ol>
            <div class="credential-setup-links">
              <a :href="HOME_ASSISTANT_AUTHENTICATION_DOCS_URL" target="_blank" rel="noopener noreferrer">官方令牌说明</a>
              <a :href="HOME_ASSISTANT_INSTALLATION_URL" target="_blank" rel="noopener noreferrer">安装 Home Assistant</a>
              <a :href="HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL" target="_blank" rel="noopener noreferrer">接入 Xiaomi Home</a>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <div class="endpoint-actions">
        <v-btn color="primary" :loading="busy" prepend-icon="mdi-shield-key-outline" @click="connect">
          {{ authorization.configured ? "验证并替换凭证" : "验证并连接" }}
        </v-btn>
        <v-btn variant="tonal" :disabled="busy || !authorization.configured" prepend-icon="mdi-refresh" @click="refresh">检查连接</v-btn>
        <v-btn
          v-if="authorization.removable"
          color="error"
          variant="text"
          :disabled="busy"
          prepend-icon="mdi-logout"
          @click="confirmationOpen = true"
        >移除本机凭证</v-btn>
      </div>
      <div class="credential-summary mt-3">
        <span>{{ sourceLabel }}</span>
        <span v-if="authorization.providerName">{{ authorization.providerName }}</span>
        <span v-if="authorization.providerVersion">Home Assistant {{ authorization.providerVersion }}</span>
      </div>
    </template>

    <v-dialog v-model="confirmationOpen" max-width="480">
      <v-card>
        <v-card-title>移除米家凭证？</v-card-title>
        <v-card-text>事件监听和设备读取会立即停止；Home Assistant 地址与其他米家设置仍会保留。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmationOpen = false">取消</v-btn>
          <v-btn color="error" variant="flat" @click="disconnect">确认移除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.xiaomi-home-endpoint-auth {
  display: grid;
  gap: 4px;
}
.endpoint-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.credential-help-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.credential-help-panel {
  margin-top: 8px;
}
.credential-help-steps {
  display: grid;
  gap: 8px;
  margin: 0 0 12px;
  padding-left: 20px;
}
.credential-help-actions,
.credential-setup-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.credential-setup-links {
  font-size: 0.86rem;
}
.credential-setup-links a {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.credential-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.82rem;
}
@media (max-width: 600px) {
  .credential-help-actions .v-btn {
    width: 100%;
  }
}
</style>
