<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onMounted, ref } from "vue";
import type { AgentInstance } from "@shared/agentInstance";
import InstanceAgentSettings from "../components/InstanceAgentSettings.vue";
import { routeScopedAdaptersPath } from "../routeScopedNavigation";
import { copyTextToClipboard } from "../clipboard";
import { managerAccessToken } from "../managerApi";
import { buildLanAgentBootstrapPrompt } from "../lanAgentBootstrap";
import { useGatewayStore } from "../stores/gatewayStore";
const gatewayStore = useGatewayStore();
function agentRoutes(instance: AgentInstance, agentId: string, routeId?: string) {
  return gatewayStore.gateways.filter(route => instance.local ? route.id === routeId : Object.values(route.agentInstanceBindings || {}).some(binding => binding.instanceId === instance.instanceId && binding.agentId === agentId));
}

type NodeStatus = {
  nodeId: string;
  remoteAddress?: string;
  version: string;
  platform: string;
  agentTypes?: string[];
  allowedWorkspaces?: string[];
  connected: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  targetVersion?: string;
  updateState?: string;
  lastUpdateAt?: string;
  lastUpdateError?: string;
};

type Task = {
  taskId: string;
  nodeId: string;
  targetAgent: string;
  status: string;
  updatedAt: string;
  result?: string;
  error?: string;
};

const nodes = ref<NodeStatus[]>([]);
const instances = ref<AgentInstance[]>([]);
const addingInstanceId = ref("");
const tasks = ref<Task[]>([]);
const releaseVersion = ref("");
const releasePublicKeySha256 = ref("");
const loading = ref(false);
const updatingNodeId = ref("");
const error = ref("");
const copied = ref(false);
const managerUrl = ref(window.location.origin);
const connectionToken = ref("");
const connectionAvailable = ref(false);

async function copyInstallPrompt(): Promise<void> {
  error.value = "";
  copied.value = false;
  try {
    await copyTextToClipboard(buildLanAgentBootstrapPrompt({ managerUrl: managerUrl.value, token: connectionToken.value, publicKeySha256: releasePublicKeySha256.value }));
    copied.value = true;
  } catch (reason) {
    error.value = userFacingError(reason);
  }
}

const onlineCount = computed(() => nodes.value.filter(node => node.connected).length);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatTime(value: string | undefined): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.code !== 0) throw new Error(text(body.message) || `请求失败：HTTP ${response.status}`);
  return body;
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const access = await readJson(await fetch("/api/webgui-access", { cache: "no-store" }));
    const data = access.data as { enabled?: boolean; token?: string; listeningOnLan?: boolean; urls?: { url: string }[] };
    connectionToken.value = data.token || managerAccessToken();
    connectionAvailable.value = data.enabled === true && data.listeningOnLan === true;
    const instanceCatalog = await readJson(await fetch("/api/lan-agent/instances", { cache: "no-store", headers: { "x-rabiroute-webgui-token": connectionToken.value } }));
    instances.value = instanceCatalog.instances as AgentInstance[];
    if (!data.enabled) { nodes.value = []; tasks.value = []; return; }
    if (["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) && data.urls?.[0]) managerUrl.value = new URL(data.urls[0].url).origin;
    const body = await readJson(await fetch("/api/lan-agent/nodes", { cache: "no-store", headers: { "x-rabiroute-webgui-token": connectionToken.value } }));
    nodes.value = Array.isArray(body.nodes) ? body.nodes as NodeStatus[] : [];
    tasks.value = Array.isArray(body.tasks) ? body.tasks as Task[] : [];
    releaseVersion.value = text(body.releaseVersion);
    releasePublicKeySha256.value = text(body.releasePublicKeySha256);
  } catch (reason) {
    error.value = userFacingError(reason);
  } finally {
    loading.value = false;
  }
}

async function requestUpdate(node: NodeStatus): Promise<void> {
  updatingNodeId.value = node.nodeId;
  error.value = "";
  try {
    await readJson(await fetch(`/api/lan-agent/nodes/${encodeURIComponent(node.nodeId)}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabiroute-webgui-token": connectionToken.value },
      body: JSON.stringify({ version: releaseVersion.value || undefined })
    }));
    await refresh();
  } catch (reason) {
    error.value = userFacingError(reason);
  } finally {
    updatingNodeId.value = "";
  }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <v-container class="lan-agents-page" fluid>
    <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-5">
      <div>
        <h1 class="text-h5">远端 Agent</h1>
        <p class="text-body-2 lan-muted mb-0">在线 {{ onlineCount }} / {{ nodes.length }} 个节点。发布版本：{{ releaseVersion || "未发布" }}。</p>
        <p v-if="releasePublicKeySha256" class="text-caption lan-muted mb-0 fingerprint">发布公钥 SHA-256：{{ releasePublicKeySha256 }}</p>
      </div>
      <v-btn :loading="loading" prepend-icon="mdi-refresh" variant="tonal" @click="refresh">刷新</v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-card variant="outlined" class="mb-4">
      <v-card-title>接入一台电脑</v-card-title>
      <v-card-text>
        <p class="mb-3">1. 复制接入提示词。2. 粘贴给目标电脑上的 Agent，让它下载并配置环境。3. 节点上线后，在路由的消息适配器中添加“远端 Agent”并选择该节点。</p>
        <v-text-field v-model="managerUrl" label="目标电脑可访问的 Manager 地址" hint="使用当前 Manager 的局域网地址" persistent-hint />
        <v-btn prepend-icon="mdi-content-copy" color="primary" :disabled="loading || !connectionAvailable || !connectionToken || !releasePublicKeySha256" @click="copyInstallPrompt">复制接入提示词</v-btn>
        <p v-if="!connectionAvailable" class="text-caption mt-2">接入其他电脑前，请在设置中开启局域网访问，并通过 Host 重启应用。</p>
        <p class="text-caption mt-2">提示词包含连接密钥，只粘贴到目标电脑的私密 Agent 任务中。</p>
        <v-alert v-if="copied" type="success" variant="tonal" density="compact" class="mt-2">已复制，粘贴给目标电脑上的 Agent 即可。</v-alert>
      </v-card-text>
    </v-card>
    <v-alert v-if="!loading && !nodes.length" type="info" variant="tonal" class="mb-4">
      暂无已接入节点。新电脑完成 Rabi Agent 自助接入后会显示在这里。
    </v-alert>

    <v-expansion-panels multiple>
      <v-expansion-panel v-for="instance in instances" :key="instance.instanceId">
        <v-expansion-panel-title>
          {{ instance.local ? "实例：本机" : `远端Agent(${instance.address || "离线"})` }}
          <v-chip class="ml-3" size="small" :color="instance.connected ? 'success' : 'default'">{{ instance.connected ? "在线" : "离线" }}</v-chip>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-expansion-panels multiple>
            <v-expansion-panel v-for="agent in instance.agents" :key="agent.agentId">
              <v-expansion-panel-title>{{ agent.name }}</v-expansion-panel-title>
              <v-expansion-panel-text>
                <InstanceAgentSettings v-if="!instance.local || ['codex-desktop', 'dsh'].includes(agent.provider)" :instance="instance" :agent="agent" @saved="refresh" />
                <v-btn v-for="route in agentRoutes(instance, agent.agentId, agent.routeId)" :key="route.id" class="mt-3 mr-2" :to="routeScopedAdaptersPath(route.id)">{{ route.routeName || route.id }}：路由与完整 Agent 设置</v-btn>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
          <p v-if="!instance.agents.length" class="text-body-2 my-3">此实例还没有 Agent。</p>
          <template v-if="!instance.local">
            <v-btn class="mt-3 mr-2" :disabled="!instance.connected" @click="addingInstanceId = addingInstanceId === instance.instanceId ? '' : instance.instanceId">添加 Agent</v-btn>
            <InstanceAgentSettings v-if="addingInstanceId === instance.instanceId" class="mt-4" :instance="instance" :agent="{ agentId: '', name: 'Agent', provider: instance.agents[0]?.provider || 'codex-desktop', enabled: true }" @saved="addingInstanceId = ''; refresh()" />
            <v-btn v-for="node in nodes.filter(node => node.nodeId === instance.instanceId)" :key="node.nodeId" class="mt-3" :disabled="!node.connected" :loading="updatingNodeId === node.nodeId" @click="requestUpdate(node)">更新连接程序至 {{ releaseVersion }}</v-btn>
          </template>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <v-card class="mt-6" variant="outlined">
      <v-card-title>最近任务</v-card-title>
      <v-table density="comfortable">
        <thead><tr><th>节点</th><th>状态</th><th>更新时间</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.taskId">
            <td>{{ task.nodeId }}</td><td>{{ task.status }}</td><td>{{ formatTime(task.updatedAt) }}</td><td>{{ task.error || task.result || "—" }}</td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="4" class="lan-muted">暂无任务记录。</td></tr>
        </tbody>
      </v-table>
    </v-card>
  </v-container>
</template>

<style scoped>
.lan-agents-page { max-width: 1480px; }
.detail-row { display: grid; grid-template-columns: minmax(0, 110px) minmax(0, 1fr); gap: 12px; margin: 8px 0; }
.lan-muted { color: var(--rr-muted) !important; opacity: 1 !important; }
.detail-row span { color: var(--rr-muted-soft); opacity: 1; }
.detail-row b { overflow-wrap: anywhere; }
.fingerprint { overflow-wrap: anywhere; }
</style>
