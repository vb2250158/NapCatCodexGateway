<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { ref, watch } from "vue";
import type { AgentInstance, InstanceAgent } from "@shared/agentInstance";
import { managerAccessToken } from "../managerApi";
const props = defineProps<{ instance: AgentInstance; agent: InstanceAgent }>();
const emit = defineEmits<{ saved: [] }>();
const draft = ref({ ...props.agent });
const busy = ref(false);
const error = ref("");
const notice = ref("");
const sessions = ref<Array<{ id?: string; name: string }>>([]);
const models = ref<Array<{ id: string; name: string }>>([]);
const warnings = ref<string[]>([]);
const projects = ref<string[]>([]);
watch(() => props.agent, value => { draft.value = { ...value }; });
async function operate(operation: string, params: Record<string, unknown>): Promise<any> {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const access = await fetch("/api/webgui-access").then(response => response.json());
    const suffix = !props.agent.agentId && operation === "configure" ? "" : `/${encodeURIComponent(props.agent.agentId || "new-agent")}/${operation}`;
    const response = await fetch(`/api/lan-agent/instances/${encodeURIComponent(props.instance.instanceId)}/agents${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", "x-rabiroute-webgui-token": access.data?.token || managerAccessToken() }, body: JSON.stringify(params)
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || "保存失败");
    if (body.result?.statusCode >= 400) throw new Error(body.result.data?.message || body.result.data?.error || "任务操作失败");
    return body.result;
  } catch (reason) { error.value = userFacingError(reason); }
  finally { busy.value = false; }
}
async function save() { if (await operate("configure", draft.value)) { notice.value = "已保存到实例"; emit("saved"); } }
async function scan() {
  const result = await operate("scan", { provider: draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider, dshBaseUrl: draft.value.dshBaseUrl });
  const scan = result?.agents?.[draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider];
  if (scan) { sessions.value = scan.sessions || []; models.value = scan.models || []; warnings.value = scan.warnings || []; projects.value = (scan.projects || []).map((project: any) => project.path || project.projectPath).filter(Boolean); }
}
async function hooks() {
  const result = await operate("hooks", { provider: props.agent.provider === "codex-desktop" ? "codex" : props.agent.provider });
  if (result) notice.value = result.message;
}
async function openTask() {
  const result = await operate("threads", { action: "open", threadId: draft.value.sessionId, cwd: draft.value.workspace, agentAdapter: props.agent.provider === "codex-desktop" ? "codex" : props.agent.provider });
  if (result) notice.value = "已请求在此实例的任务宿主中打开任务";
}
async function initializeTask() {
  const result = await operate("threads", { action: "resolve", title: draft.value.name, cwd: draft.value.workspace, createIfMissing: true, agentAdapter: draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider, dshBaseUrl: draft.value.dshBaseUrl });
  if (result?.data?.thread?.id) {
    draft.value.sessionId = result.data.thread.id;
    draft.value.workspace = result.data.thread.cwd || draft.value.workspace;
    notice.value = "任务已就绪，保存到实例后开始使用";
  }
}
</script>
<template>
  <div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="info" variant="tonal" class="mb-3">{{ notice }}</v-alert>
    <v-switch v-model="draft.enabled" label="启用 Agent" :disabled="!instance.connected || busy" />
    <v-text-field v-model="draft.name" label="Agent 名称" />
    <v-select v-if="!agent.agentId" v-model="draft.provider" label="此 Agent 的执行程序" :items="[{ title: 'Codex Desktop', value: 'codex-desktop' }, { title: 'DSH', value: 'dsh' }]" />
    <v-text-field v-if="draft.provider === 'dsh'" v-model="draft.dshBaseUrl" label="该电脑上的 DSH 服务地址" hint="使用该电脑实际运行的本机 DSH 地址" persistent-hint />
    <v-combobox v-model="draft.workspace" :items="projects" label="工作目录" />
    <v-combobox v-model="draft.sessionId" label="任务（名称与 ID）" :items="sessions.map(session => ({ title: `${session.name} · ${session.id}`, value: session.id }))" :return-object="false" />
    <v-combobox v-model="draft.model" label="模型" :items="models.map(model => ({ title: model.name, value: model.id }))" :return-object="false" />
    <v-combobox v-model="draft.reasoningEffort" label="推理强度" :items="['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']" />
    <v-btn :disabled="!instance.connected" :loading="busy" color="primary" @click="save">保存到实例</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="scan">刷新任务与环境</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="openTask">打开任务</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy || !draft.name || !draft.workspace" @click="initializeTask">初始化任务</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="hooks">更新 Hook</v-btn>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mt-2">{{ warning }}</v-alert>
  </div>
</template>
