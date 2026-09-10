<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import PersonaSyncCard from "../components/PersonaSyncCard.vue";
import { managerEventSource } from "../managerApi";
import { routeScopedPersonaPath } from "../routeScopedNavigation";
import { useGatewayStore } from "../stores/gatewayStore";
import { configNameFor } from "../utils/gatewayHelpers";

const route = useRoute();
const store = useGatewayStore();
const manifestVersion = ref(0);
const peerVersion = ref(0);
let managerEvents: EventSource | null = null;
let managerEventsReady = false;

const routeKey = computed(() => String(route.params.id || ""));
const gateway = computed(() => store.gateways.find(item => (
  configNameFor(item) === routeKey.value || item.id === routeKey.value
)) || null);
const runtime = computed(() => gateway.value ? store.runtimeFor(gateway.value.id) : null);
const roleId = computed(() => gateway.value?.agentRoleId || "");
const rolePath = computed(() => {
  const rolesDir = String(runtime.value?.roleInfo?.rolesDir || "").replace(/[\\/]+$/, "");
  if (!rolesDir) return roleId.value;
  const separator = rolesDir.includes("\\") ? "\\" : "/";
  return `${rolesDir}${separator}${roleId.value}`;
});
const backPath = computed(() => routeScopedPersonaPath(
  gateway.value ? configNameFor(gateway.value) : routeKey.value
));

function eventRoleId(raw: Event): string {
  try {
    return String((JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string }).roleId || "");
  } catch {
    return "";
  }
}

function startEvents(): void {
  if (managerEvents) return;
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("ready", () => {
    if (managerEventsReady) {
      manifestVersion.value += 1;
      peerVersion.value += 1;
    } else {
      managerEventsReady = true;
    }
  });
  managerEvents.addEventListener("persona_sync_manifest_changed", raw => {
    const changedRoleId = eventRoleId(raw);
    if (!changedRoleId || changedRoleId === roleId.value) manifestVersion.value += 1;
  });
  managerEvents.addEventListener("persona_sync_auto_status", () => {
    manifestVersion.value += 1;
    peerVersion.value += 1;
  });
  managerEvents.addEventListener("rabilink_status", () => { peerVersion.value += 1; });
  managerEvents.addEventListener("persona_sync_lan_status", () => { peerVersion.value += 1; });
}

onMounted(startEvents);

onBeforeUnmount(() => {
  managerEvents?.close();
  managerEvents = null;
  managerEventsReady = false;
});
</script>

<template>
  <div class="page-shell persona-sync-page">
    <div class="page-header">
      <div>
        <h1 class="page-title">多电脑人格同步</h1>
        <div class="page-subtitle">比较并同步当前人格的整个文件夹，像版本管理工具一样先看 Changed Files，再决定是否同步。</div>
      </div>
      <div class="page-actions">
        <v-btn
          v-if="gateway && roleId"
          prepend-icon="mdi-folder-open-outline"
          variant="tonal"
          @click="store.openConfigFile('role-folder', gateway.id, roleId)"
        >打开人格文件夹</v-btn>
        <v-btn :to="backPath" prepend-icon="mdi-arrow-left" variant="tonal">返回人格配置</v-btn>
      </div>
    </div>

    <v-alert v-if="store.loading && !gateway" type="info" variant="tonal">正在读取人格配置…</v-alert>
    <v-alert v-else-if="!gateway" type="warning" variant="tonal">没有找到这条路由，请返回人格配置页重新选择。</v-alert>
    <v-alert v-else-if="!roleId" type="info" variant="tonal">当前 Route 没有选择人格，因此没有可同步的人格文件夹。</v-alert>
    <template v-else>
      <v-card class="app-card glass-card sync-role-summary">
        <div>
          <span>当前同步目录</span>
          <strong data-no-i18n>{{ rolePath }}</strong>
        </div>
        <v-chip color="secondary" variant="tonal" prepend-icon="mdi-folder-account-outline" data-no-i18n>{{ roleId }}</v-chip>
      </v-card>
      <PersonaSyncCard
        :role-id="roleId"
        :manifest-version="manifestVersion"
        :peer-version="peerVersion"
      />
    </template>
  </div>
</template>

<style scoped>
.sync-role-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
}

.sync-role-summary div {
  min-width: 0;
}

.sync-role-summary span,
.sync-role-summary strong {
  display: block;
}

.sync-role-summary span {
  color: var(--rr-muted-soft);
  font-size: 12px;
  opacity: 1;
}

.sync-role-summary strong {
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .sync-role-summary {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
