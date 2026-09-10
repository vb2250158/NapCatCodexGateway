<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import { registerPageSaveAction } from "../pageSaveAction";
import { routeScopedAdaptersPath, routeScopedOverviewPath } from "../routeScopedNavigation";
import { adapterLabel, configNameFor, gatewayAdapterTypes, isMessageInputsDisabled } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const router = useRouter();
const gatewayActionId = ref("");
const gatewayActionError = ref("");
const deletingGatewayId = ref("");
onBeforeUnmount(registerPageSaveAction({
  dirty: computed(() => store.dirty),
  ready: computed(() => !store.loading),
  saving: computed(() => store.saving),
  save: () => store.saveChangedRoutes()
}));

function avatarUrlForGateway(gatewayId: string, roleId?: string): string {
  const options = store.runtimeFor(gatewayId).roleInfo?.options || [];
  return options.find(option => option.value === roleId)?.avatarUrl || "";
}

function goToRoute(id: string): void {
  store.selectGateway(id);
  const gateway = store.gateways.find(item => item.id === id);
  router.push(routeScopedAdaptersPath(gateway ? configNameFor(gateway) : id));
}

function selectRouteOverview(id: string): void {
  store.selectGateway(id);
  const gateway = store.gateways.find(item => item.id === id);
  router.replace(routeScopedOverviewPath(gateway ? configNameFor(gateway) : id));
}

function toggleGatewayEnabled(gateway: any): void {
  gateway.enabled = !gateway.enabled;
  store.touch();
}

async function runGatewayAction(id: string, action: "start" | "stop" | "restart"): Promise<void> {
  if (!id || gatewayActionId.value) return;
  gatewayActionId.value = `${id}:${action}`;
  gatewayActionError.value = "";
  try {
    await store.actionGateway(id, action);
  } catch (error) {
    gatewayActionError.value = userFacingError(error);
  } finally {
    window.setTimeout(() => {
      gatewayActionId.value = "";
    }, action === "restart" ? 1000 : 700);
  }
}

async function deleteGatewayFromConsole(gateway: any): Promise<void> {
  if (!gateway?.id || deletingGatewayId.value) return;
  const name = store.configNameFor(gateway);
  const confirmed = window.confirm(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`);
  if (!confirmed) return;
  deletingGatewayId.value = gateway.id;
  gatewayActionError.value = "";
  try {
    await store.deleteGateway(gateway.id);
  } catch (error) {
    gatewayActionError.value = userFacingError(error);
  } finally {
    deletingGatewayId.value = "";
  }
}

function gatewayRuntimeLabel(gateway: any): string {
  const runtime = store.runtimeFor(gateway.id);
  return gateway.enabled === false || runtime.enabled === false ? "已禁用" : "已启用";
}

function gatewayRuntimeColor(gateway: any): string {
  const runtime = store.runtimeFor(gateway.id);
  return gateway.enabled === false || runtime.enabled === false ? "grey" : "success";
}
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <div class="eyebrow">ROUTES</div>
        <h1 class="page-title">控制台</h1>
        <div class="page-subtitle">查看并操作当前 Manager 管理的各个 Route。</div>
      </div>
    </div>

    <v-alert v-if="gatewayActionError" type="error" variant="tonal">{{ gatewayActionError }}</v-alert>

    <div v-if="store.gateways.length" class="route-card-grid">
      <v-card
        v-for="gw in store.gateways"
        :key="gw.id"
        class="app-card glass-card route-card"
        :class="{ 'route-card-selected': gw.id === store.selectedGatewayId }"
        role="button"
        tabindex="0"
        :aria-label="`打开 ${store.configNameFor(gw)} 控制台`"
        @click="selectRouteOverview(gw.id)"
        @keydown.enter="selectRouteOverview(gw.id)"
      >
        <div class="route-card-head">
          <div class="route-card-identity">
            <PersonaAvatar :role-id="gw.agentRoleId || ''" :avatar-url="avatarUrlForGateway(gw.id, gw.agentRoleId)" :size="42" />
            <div class="min-w-0">
              <div class="route-card-title">{{ store.configNameFor(gw) }}</div>
              <div class="route-card-subtitle">人格 {{ gw.agentRoleId || "未选择" }}</div>
            </div>
          </div>
          <v-chip size="small" :color="gatewayRuntimeColor(gw)" variant="tonal">
            {{ gatewayRuntimeLabel(gw) }}
          </v-chip>
        </div>

        <div class="route-card-meta">
          <div class="status-row">
            <span>消息端</span>
            <b>{{ gatewayAdapterTypes(gw).map(adapterLabel).join(" + ") || "未配置" }}</b>
          </div>
          <div class="status-row">
            <span>状态</span>
            <b>{{ gw.enabled === false || store.runtimeFor(gw.id).enabled === false ? "已禁用" : isMessageInputsDisabled(gw) ? "入口已禁用" : "可接收消息" }}</b>
          </div>
        </div>

        <div class="route-card-actions">
          <v-switch
            :model-value="gw.enabled !== false"
            color="success"
            density="compact"
            inset
            hide-details
            title="启用 / 禁用此路由"
            @click.stop
            @update:model-value="() => toggleGatewayEnabled(gw)"
          />
          <v-spacer />
          <v-btn
            icon="mdi-restart"
            size="small"
            variant="text"
            title="重启此路由"
            :loading="gatewayActionId === `${gw.id}:restart`"
            :disabled="Boolean(gatewayActionId)"
            @click.stop="runGatewayAction(gw.id, 'restart')"
          />
          <v-btn
            icon="mdi-arrow-right"
            size="small"
            variant="text"
            title="打开消息适配器配置"
            @click.stop="goToRoute(gw.id)"
          />
          <v-btn
            icon="mdi-delete"
            size="small"
            variant="text"
            color="error"
            title="删除路由配置"
            :loading="deletingGatewayId === gw.id"
            :disabled="Boolean(deletingGatewayId)"
            @click.stop="deleteGatewayFromConsole(gw)"
          />
        </div>
      </v-card>
    </div>

    <v-card v-else class="app-card glass-card empty-state">
      <strong>还没有路由配置</strong>
      <span>点击“新增路由”开始配置第一条消息路线。</span>
    </v-card>
  </div>
</template>
