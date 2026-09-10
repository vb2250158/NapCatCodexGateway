import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AgentAdapterType, AgentDeliveryTestResult, GatewayDefinition, GatewayPayload, MessageAdapterType, MetaPayload, NetworkOptions, NotificationRule, PersonaAutomationRuleDefinition, RouteCatalogVersion, RuntimeStatus } from "../types";
import {
  applyAdapterDefaults,
  automationRulesForGateway,
  adaptersNeedGatewayRuntime,
  configNameFor,
  createDefaultGateway,
  ensureActiveRoleRules,
  gatewayAdapterTypes,
  isBuiltinRolePanelRule,
  isQuickSetupNeeded,
  notificationRulesForGateway,
  normalizeRule,
  sanitizeConfigName,
  saveActiveRoleRules,
  syncAutomationRuleProjection,
  setGatewayAdapters
} from "../utils/gatewayHelpers";
import { routeKeyFromWebguiHash } from "../routeScopedNavigation";
import {
  agentAdapterValues,
  resolvePrimaryAgentAdapter
} from "@shared/gatewayConfigModel";
import { cloneGatewayValue, mergeGatewayDraft, sameGatewayValue } from "../gatewayDraft";
import {
  boundedRouteCatalogMutationFetch,
  committedRouteCatalogRevision,
  routeCatalogMutationFailureIsDefinitive,
  type PendingRouteCatalogMutation,
  RouteCatalogMutationLedger
} from "../routeCatalogMutationLedger";

const pluginApiBase = "/plugin/napcat-plugin-rabiroute/api";
const isPluginShell = window.location.pathname.startsWith("/plugin/");
const apiBase = isPluginShell ? pluginApiBase : "";

type LoadOptions = {
  replaceDirtyConfig?: boolean;
};

const routeCatalogMutationLedger = new RouteCatalogMutationLedger();

export type GatewayRouteSummary = Readonly<{
  id: string;
  configName: string;
  name: string;
  agentRoleId: string;
  running: boolean;
}>;

function asManagerRows(value: unknown): RuntimeStatus[] {
  return Array.isArray(value) ? value as RuntimeStatus[] : [];
}

function managerErrorOf(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error?: unknown }).error || "");
  }
  return "";
}

function routeSummariesFrom(value: unknown): GatewayRouteSummary[] {
  return asManagerRows(value)
    .map((gateway) => ({
      id: String(gateway.id || "").trim(),
      configName: String(gateway.configName || configNameFor(gateway)).trim(),
      name: String(gateway.name || "").trim(),
      agentRoleId: String(gateway.agentRoleId || "").trim(),
      running: gateway.running === true
    }))
    .filter((gateway) => Boolean(gateway.id));
}

function isAgentAdapterType(value: unknown): value is AgentAdapterType {
  return typeof value === "string" && agentAdapterValues.has(value as AgentAdapterType);
}

function normalizeAgentAdapterType(value: unknown): AgentAdapterType | null {
  return isAgentAdapterType(value) ? value : null;
}

export const useGatewayStore = defineStore("gateway", () => {
  const gateways = ref<GatewayDefinition[]>([]);
  const managerRows = ref<RuntimeStatus[]>([]);
  const routeSummaries = ref<GatewayRouteSummary[]>([]);
  const routeBootstrapLoading = ref(false);
  const routeBootstrapError = ref("");
  const routeCatalogRevisionHash = ref("");
  const managerLifecycleKey = ref("");
  const managerError = ref("");
  const networkOptions = ref<NetworkOptions>({ adapters: {}, localAddresses: [], httpServers: [], websocketClients: [] });
  const configFiles = ref<Record<string, string>>({});
  const selectedGatewayId = ref("");
  const requestedRouteKey = ref(routeKeyFromWebguiHash(window.location.hash));
  const routeConfigLoaded = ref(false);
  const loading = ref(false);
  const diagnosticsLoading = ref(false);
  const diagnosticsLoaded = ref(false);
  const saving = ref(false);
  const savedGateways = ref<GatewayDefinition[]>([]);
  const dirty = computed(() => !sameGatewayValue(
    [...gateways.value].sort((a, b) => a.id.localeCompare(b.id)),
    [...savedGateways.value].sort((a, b) => a.id.localeCompare(b.id))
  ));
  const saveState = ref<"idle" | "saving" | "confirming" | "saved" | "conflict" | "error">("idle");
  const saveMessage = ref("");
  let saveFlight: Promise<void> | undefined;
  const pendingSaveDrafts = new Map<string, { id: string; submitted: GatewayDefinition }>();
  const error = ref("");
  const quickSetupDialogOpen = ref(false);
  const pendingSelectedConfigName = ref("");
  const meta = ref<MetaPayload>({
    version: "0.1.0",
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort: 0,
    rabiGuid: "",
    rabiName: "",
    webguiLan: {
      enabled: false,
      tokenConfigured: false,
      listeningOnLan: false,
      restartRequired: false
    },
    rabiLinkRelay: {
      enabled: false,
      url: "",
      token: "",
      tokenConfigured: false,
      deviceId: "",
      claimWaitMs: 60000,
      replyIdleTimeoutMs: 60000,
      speechProxyEnabled: false,
      speechServiceUrl: "http://127.0.0.1:8781"
    },
    rabiLinkRelayRuntime: {
      state: "disabled",
      message: "RabiLink Relay 全局连接已关闭。"
    },
    computerName: ""
  });

  const selectedIndex = computed(() => gateways.value.findIndex(gateway => gateway.id === selectedGatewayId.value));
  const selectedGateway = computed(() => gateways.value[selectedIndex.value] || null);
  const routeSelectionMissing = computed(() => routeConfigLoaded.value && Boolean(requestedRouteKey.value) && !selectedGateway.value);

  function syncRouteSelection(hash = window.location.hash): void {
    requestedRouteKey.value = routeKeyFromWebguiHash(hash);
    if (requestedRouteKey.value) {
      selectedGatewayId.value = gateways.value.find(gateway =>
        configNameFor(gateway) === requestedRouteKey.value || gateway.id === requestedRouteKey.value
      )?.id || "";
      return;
    }
    if (!gateways.value.some(gateway => gateway.id === selectedGatewayId.value)) {
      selectedGatewayId.value = gateways.value[0]?.id || "";
    }
  }

  function routeSummaryForKey(value: string): GatewayRouteSummary | null {
    const key = String(value || "").trim();
    if (!key) return null;
    return routeSummaries.value.find((gateway) => gateway.id === key || gateway.configName === key) || null;
  }

  const selectedRouteSummary = computed(() => {
    if (requestedRouteKey.value) return routeSummaryForKey(requestedRouteKey.value);
    const selected = selectedGateway.value;
    return selected ? routeSummaryForKey(selected.id) : null;
  });

  const selectedRuntime = computed(() => {
    const gateway = selectedGateway.value;
    if (!gateway) return {} as RuntimeStatus;
    return managerRows.value.find(row => row.id === gateway.id) || {} as RuntimeStatus;
  });

  const runningCount = computed(() => gateways.value.filter(gateway => {
    const runtime = runtimeFor(gateway.id);
    if (gateway.enabled === false || runtime.enabled === false) return false;
    if (!adaptersNeedGatewayRuntime(gatewayAdapterTypes(gateway))) return true;
    return runtime.running;
  }).length);
  const quickSetupNeeded = computed(() => isQuickSetupNeeded(gateways.value));

  function runtimeFor(id: string): RuntimeStatus {
    return managerRows.value.find(row => row.id === id) || {} as RuntimeStatus;
  }

  function touch(): void {
    if (saveState.value === "saved") saveMessage.value = "";
  }

  function openQuickSetup(): void {
    quickSetupDialogOpen.value = true;
  }

  function closeQuickSetup(): void {
    quickSetupDialogOpen.value = false;
  }

  function normalizeGateways(items = gateways.value): void {
    items.forEach(gateway => {
      const agentAdapters = (Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : [])
        .map(normalizeAgentAdapterType)
        .filter((item): item is AgentAdapterType => Boolean(item));
      gateway.agentAdapters = [...new Set(agentAdapters)];
      gateway.primaryAgentAdapter = resolvePrimaryAgentAdapter(
        gateway.agentAdapters,
        gateway.primaryAgentAdapter
      );
      if (Array.isArray(gateway.notificationRules)) {
        gateway.notificationRules = gateway.notificationRules.map((rule, index) => normalizeRule(rule, index));
      }
      automationRulesForGateway(gateway);
      if (gateway.roleNotificationRules && typeof gateway.roleNotificationRules === "object" && !Array.isArray(gateway.roleNotificationRules)) {
        Object.keys(gateway.roleNotificationRules).forEach(roleId => {
          const rules = gateway.roleNotificationRules?.[roleId];
          if (Array.isArray(rules)) {
            gateway.roleNotificationRules![roleId] = rules.map((rule, index) => normalizeRule(rule, index));
          }
        });
      }
      applyAdapterDefaults(gateway);
      ensureActiveRoleRules(gateway);
    });
  }

  function applyRouteCatalogVersion(value: RouteCatalogVersion | undefined): void {
    const routeConfigHash = String(value?.routeConfigHash || "").trim().toLowerCase();
    routeCatalogRevisionHash.value = /^[a-f0-9]{64}$/.test(routeConfigHash) ? routeConfigHash : "";
  }

  async function loadMeta(required = false): Promise<string> {
    try {
      const response = await fetch(`${apiBase}/meta`);
      if (!response.ok) throw new Error(`Manager /meta failed (HTTP ${response.status}).`);
      const nextMeta = await response.json() as MetaPayload;
      const applicationGenerationId = String(nextMeta.applicationGenerationId || "").trim();
      const managerInstanceId = String(nextMeta.managerInstanceId || "").trim();
      if (!applicationGenerationId || !managerInstanceId) {
        throw new Error("Manager /meta did not publish applicationGenerationId and managerInstanceId.");
      }
      const nextLifecycleKey = `${applicationGenerationId}\u0000${managerInstanceId}`;
      if (managerLifecycleKey.value !== nextLifecycleKey) routeCatalogRevisionHash.value = "";
      managerLifecycleKey.value = nextLifecycleKey;
      meta.value = nextMeta;
      return nextLifecycleKey;
    } catch (metaError) {
      managerLifecycleKey.value = "";
      routeCatalogRevisionHash.value = "";
      if (required) {
        throw new Error(metaError instanceof Error ? metaError.message : String(metaError));
      }
      return "";
    }
  }

  async function retireRejectedRouteMutation(
    response: Response,
    pending: PendingRouteCatalogMutation,
    expectedLifecycleKey: string
  ): Promise<void> {
    if (!routeCatalogMutationFailureIsDefinitive(response.status)) return;
    routeCatalogMutationLedger.complete(pending);
    if (response.status !== 412) return;
    if (await loadMeta(true) !== expectedLifecycleKey) {
      throw new Error("Manager lifecycle changed while retiring the rejected Route mutation.");
    }
    await loadRouteSummaries();
    if (!routeCatalogRevisionHash.value) {
      throw new Error("Manager did not return a current routeConfigHash after rejecting the Route mutation.");
    }
    if (await loadMeta(true) !== expectedLifecycleKey) {
      throw new Error("Manager lifecycle changed while reloading the rejected Route mutation.");
    }
  }

  async function loadNetworkOptions(): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/network-options`);
      const body = await response.json();
      if (response.ok && body.code === 0 && body.data) {
        networkOptions.value = {
          adapters: body.data.adapters || {},
          localAddresses: body.data.localAddresses || [],
          httpServers: body.data.httpServers || [],
          websocketClients: body.data.websocketClients || []
        };
      }
    } catch {
      networkOptions.value = { adapters: {}, localAddresses: [], httpServers: [], websocketClients: [] };
    }
  }

  async function loadRouteSummaries(): Promise<void> {
    routeBootstrapLoading.value = true;
    routeBootstrapError.value = "";
    try {
      const response = await fetch(`${apiBase}/gateways?summary=1`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data) {
        throw new Error(body.message || "插件 API 没有返回 route 摘要");
      }
      managerRows.value = asManagerRows(body.data.manager);
      applyRouteCatalogVersion(body.routeCatalog);
      managerError.value = managerErrorOf(body.data.manager);
      routeSummaries.value = routeSummariesFrom(body.data.manager);
    } catch (loadError) {
      routeCatalogRevisionHash.value = "";
      routeBootstrapError.value = loadError instanceof Error ? loadError.message : String(loadError);
      managerError.value = routeBootstrapError.value;
      routeSummaries.value = [];
    } finally {
      routeBootstrapLoading.value = false;
    }
  }

  async function load(options: LoadOptions = {}): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      await loadMeta();
      const response = await fetch(`${apiBase}/gateways?summary=1&includeConfig=1`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data?.config) {
        throw new Error(body.message || "插件 API 没有返回 gateway 配置");
      }
      managerRows.value = asManagerRows(body.data.manager);
      applyRouteCatalogVersion(body.routeCatalog);
      managerError.value = managerErrorOf(body.data.manager);
      routeSummaries.value = routeSummariesFrom(body.data.manager);
      diagnosticsLoaded.value = false;
      if (!dirty.value || options.replaceDirtyConfig) {
        gateways.value = body.data.config.gateways || [];
        configFiles.value = body.data.configFiles || {};
        normalizeGateways();
        if (!routeKeyFromWebguiHash(window.location.hash) && pendingSelectedConfigName.value) {
          const renamed = gateways.value.find(gateway => configNameFor(gateway) === pendingSelectedConfigName.value);
          if (renamed) selectedGatewayId.value = renamed.id;
        }
        pendingSelectedConfigName.value = "";
        syncRouteSelection();
        routeConfigLoaded.value = true;
        savedGateways.value = cloneGatewayValue(gateways.value);
      }
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
      managerRows.value = [];
      managerError.value = error.value;
    } finally {
      loading.value = false;
    }
    void loadNetworkOptions();
  }

  async function ensureDiagnostics(force = false): Promise<void> {
    if (diagnosticsLoading.value || (diagnosticsLoaded.value && !force)) return;
    diagnosticsLoading.value = true;
    try {
      const response = await fetch(`${apiBase}/gateways`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data) {
        throw new Error(body.message || "Manager 没有返回运行诊断");
      }
      managerRows.value = asManagerRows(body.data.manager);
      managerError.value = managerErrorOf(body.data.manager);
      diagnosticsLoaded.value = true;
    } catch (diagnosticsError) {
      managerError.value = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
    } finally {
      diagnosticsLoading.value = false;
    }
  }

  function acceptSavedGateway(id: string, submitted: GatewayDefinition, body: GatewayPayload): void {
    const persisted = body.data?.config?.gateways;
    if (!Array.isArray(persisted)) throw new Error("配置已提交，但未返回保存后的配置。请点击保存重新确认。");
    const normalized = cloneGatewayValue(persisted);
    normalizeGateways(normalized);
    const saved = normalized.find(item => item.configName === submitted.configName || item.id === id);
    if (!saved) throw new Error("配置已提交，但回读未找到当前路线。请点击保存重新确认。");
    for (const item of normalized) {
      if (item.id === saved.id) continue;
      const old = savedGateways.value.find(row => row.id === item.id);
      const localIndex = gateways.value.findIndex(row => row.id === item.id);
      if (old && localIndex >= 0 && sameGatewayValue(gateways.value[localIndex], old)) {
        gateways.value[localIndex] = cloneGatewayValue(item);
        savedGateways.value = savedGateways.value.map(row => row.id === item.id ? cloneGatewayValue(item) : row);
      }
    }
    const index = gateways.value.findIndex(item => item.id === id);
    if (index >= 0) {
      const local = gateways.value[index];
      // Only replace the exact submitted draft. Later edits survive a delayed response.
      if (sameGatewayValue(local, submitted)) gateways.value[index] = cloneGatewayValue(saved);
      else gateways.value[index] = { ...local, id: saved.id };
      if (selectedGatewayId.value === id) selectedGatewayId.value = saved.id;
    }
    savedGateways.value = [...savedGateways.value.filter(item => item.id !== id && item.id !== saved.id), cloneGatewayValue(saved)];
    // Keep ordering stable: dirty compares values, not server enumeration order.
    savedGateways.value.sort((a, b) => a.id.localeCompare(b.id));
    pendingSelectedConfigName.value = "";
    applyRouteCatalogVersion(body.routeCatalog);
  }

  async function recoverPendingMutation(pending: PendingRouteCatalogMutation): Promise<GatewayPayload & { receipt?: { state?: string } }> {
    saveState.value = "confirming";
    saveMessage.value = "正在确认上次保存结果";
    const lifecycleKey = await loadMeta(true);
    const response = await boundedRouteCatalogMutationFetch(`${apiBase}/gateways/mutations/${encodeURIComponent(pending.operationId)}`, {});
    const body = await response.json() as GatewayPayload & { receipt?: { state?: string; operationId?: string } };
    if (!response.ok || body.code !== 0 || body.receipt?.operationId !== pending.operationId
      || !["committed", "not_committed"].includes(body.receipt?.state || "")) {
      throw new Error("上次保存结果仍待确认，请稍后点击保存重试；当前修改已保留。");
    }
    if (await loadMeta(true) !== lifecycleKey) throw new Error("Manager 已重启，保存结果仍待确认，请重试。");
    const draft = pendingSaveDrafts.get(pending.operationId);
    if (body.receipt?.state === "committed" && draft) acceptSavedGateway(draft.id, draft.submitted, body);
    routeCatalogMutationLedger.complete(pending);
    pendingSaveDrafts.delete(pending.operationId);
    applyRouteCatalogVersion(body.routeCatalog);
    return body;
  }

  function save(routeId = selectedGateway.value?.id): Promise<void> {
    if (saveFlight) return saveFlight;
    if (saving.value) return Promise.reject(new Error("另一项配置操作正在执行，请稍后重试。"));
    const flight = saveSelectedGateway(routeId).finally(() => {
      if (saveFlight === flight) saveFlight = undefined;
    });
    saveFlight = flight;
    return flight;
  }

  async function saveChangedRoutes(): Promise<void> {
    const ids = gateways.value.filter(row => !sameGatewayValue(row, savedGateways.value.find(saved => saved.id === row.id))).map(row => row.id);
    for (const id of ids) await save(id);
  }

  async function reloadSelectedGateway(): Promise<void> {
    const id = selectedGateway.value?.id;
    if (!id || saving.value) return;
    if (!window.confirm("放弃当前路线的未保存修改，重新加载最新配置？其他路线的修改会保留。")) return;
    const lifecycleKey = await loadMeta(true);
    const response = await boundedRouteCatalogMutationFetch(`${apiBase}/gateways?summary=1&includeConfig=1`, {});
    const body = await response.json() as GatewayPayload;
    if (!response.ok || body.code !== 0 || !body.data?.config) throw new Error("读取最新配置失败，修改已保留。");
    if (await loadMeta(true) !== lifecycleKey) throw new Error("Manager 已重启，请重试。");
    const rows = cloneGatewayValue(body.data.config.gateways || []);
    normalizeGateways(rows);
    const saved = rows.find(row => row.id === id);
    gateways.value = gateways.value.flatMap(row => row.id === id ? saved ? [cloneGatewayValue(saved)] : [] : [row]);
    savedGateways.value = savedGateways.value.filter(row => row.id !== id);
    if (saved) savedGateways.value.push(saved);
    applyRouteCatalogVersion(body.routeCatalog);
    saveState.value = "idle";
    error.value = "";
    saveMessage.value = "";
  }

  async function saveSelectedGateway(routeId: string | undefined): Promise<void> {
    if (!routeId) return;
    saving.value = true;
    error.value = "";
    saveState.value = "saving";
    saveMessage.value = "正在保存当前路线";
    let pending: PendingRouteCatalogMutation | undefined;
    let submitted: GatewayDefinition | undefined;
    let id = routeId;
    try {
      // v2 metadata from older pages is resolved through the durable receipt too.
      // Do not copy configuration secrets into browser storage to support retries.
      for (const previous of routeCatalogMutationLedger.unresolved()) await recoverPendingMutation(previous);
      const target = gateways.value.find(row => row.id === routeId);
      if (!target) throw new Error("当前路线已变化，请重新选择后保存。");
      normalizeGateways([target]);
      const draft = cloneGatewayValue(target);
      id = draft.id;
      const base = savedGateways.value.find(item => item.id === id);
      const lifecycleKey = await loadMeta(true);
      const response = await boundedRouteCatalogMutationFetch(`${apiBase}/gateways?summary=1&includeConfig=1`, {});
      const latest = await response.json() as GatewayPayload;
      if (!response.ok || latest.code !== 0 || !latest.data?.config) throw new Error("无法读取最新配置，当前修改已保留。");
      if (await loadMeta(true) !== lifecycleKey) throw new Error("Manager 已重启，请重试保存。");
      const currentItems = cloneGatewayValue(latest.data.config.gateways || []);
      normalizeGateways(currentItems);
      const current = currentItems.find(item => item.id === id);
      if (base && !current) throw new Error("配置冲突：当前路线已被删除，请核对后重试。");
      if (!base && current) throw new Error("配置冲突：当前路线名称已存在，请更换名称。");
      const definition = base && current ? mergeGatewayDraft(base, draft, current) : draft;
      // Freeze before any await: signature, body and acknowledgement describe the same request.
      submitted = draft;
      applyRouteCatalogVersion(latest.routeCatalog);
      pending = await routeCatalogMutationLedger.retain("save", { id, definition }, routeCatalogRevisionHash.value);
      pendingSaveDrafts.set(pending.operationId, { id, submitted });
      saveState.value = "saving";
      saveMessage.value = "正在保存当前路线";
      const result = await boundedRouteCatalogMutationFetch(`${apiBase}/gateways/${encodeURIComponent(id)}/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.operationId,
          "if-match": `"${pending.expectedContentHash}"`
        },
        body: JSON.stringify(definition)
      });
      const body = await result.json().catch(() => ({})) as GatewayPayload & { error?: string; activation?: { state: string; message?: string } };
      if (!result.ok || body.code !== 0) {
        if (routeCatalogMutationFailureIsDefinitive(result.status)) {
          routeCatalogMutationLedger.complete(pending);
          pendingSaveDrafts.delete(pending.operationId);
          pending = undefined;
        }
        if (result.status === 412) throw new Error("配置冲突：保存期间配置已变化，请再次保存以重新核对。");
        throw new Error(body.message || body.error || "保存失败，当前修改已保留。");
      }
      committedRouteCatalogRevision(body, pending);
      acceptSavedGateway(id, submitted, body);
      routeCatalogMutationLedger.complete(pending);
      pendingSaveDrafts.delete(pending.operationId);
      pending = undefined;
      saveState.value = "saved";
      saveMessage.value = body.activation?.state === "failed"
        ? `已保存，运行生效失败：${body.activation.message || "请查看日志"}`
        : "当前路线已保存";
    } catch (saveError) {
      if (pending && submitted) {
        try {
          const recovered = await recoverPendingMutation(pending);
          if (recovered.receipt?.state === "committed") {
            saveState.value = "saved";
            saveMessage.value = "已确认当前路线保存成功";
            return;
          }
        } catch (recoveryError) {
          error.value = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          saveState.value = "confirming";
          saveMessage.value = "保存结果待确认，修改已保留";
          throw recoveryError;
        }
      }
      error.value = saveError instanceof Error ? saveError.message : String(saveError);
      saveState.value = routeCatalogMutationLedger.unresolved().length ? "confirming"
        : error.value.includes("配置冲突") ? "conflict" : "error";
      saveMessage.value = error.value;
      throw saveError;
    } finally {
      saving.value = false;
    }
  }

  async function actionGateway(id: string, action: "start" | "stop" | "restart"): Promise<void> {
    const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) {
      throw new Error(body.message || body.error || `${action} gateway failed`);
    }
    window.setTimeout(() => void load(), action === "restart" ? 1000 : 700);
  }

  async function manualTriggerGateway(id: string, payload: {
    triggerId: string;
    triggerName?: string;
    message?: string;
    routeKind?: "manual_trigger" | "heartbeat";
    ruleId?: string;
  }): Promise<{ accepted: true; alreadyRunning: boolean }> {
    const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/manual-trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) {
      throw new Error(body.message || body.error || "manual trigger failed");
    }
    return {
      accepted: true,
      alreadyRunning: body.data?.alreadyRunning === true
    };
  }

  async function testAgentDelivery(id: string, agentAdapterType: AgentAdapterType): Promise<AgentDeliveryTestResult> {
    const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/agent-delivery-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentAdapterType })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || body.data?.status !== "delivered") {
      throw new Error(body.message || body.error || body.data?.error || "Agent 投递测试失败");
    }
    return body.data as AgentDeliveryTestResult;
  }

  async function openConfigFile(type: string, gatewayId = "", roleId = ""): Promise<void> {
    const params = new URLSearchParams({ type });
    if (gatewayId) params.set("gatewayId", gatewayId);
    if (roleId) params.set("roleId", roleId);
    const response = await fetch(`${apiBase}/open-config-file?${params.toString()}`, { method: "POST" });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`打开配置文件接口没有返回 JSON。响应：${text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (!response.ok || body.code !== 0) throw new Error(body.message || body.error || "打开配置文件失败");
  }

  function selectGateway(id: string): void {
    selectedGatewayId.value = id;
  }

  function addGateway(): void {
    const gateway = createDefaultGateway(gateways.value.length + 1);
    gateways.value.push(gateway);
    selectedGatewayId.value = gateway.id;
    touch();
  }

  function addGatewayAndOpenQuickSetup(): void {
    addGateway();
    openQuickSetup();
  }

  function renameGatewayConfig(id: string, rawName: unknown): { ok: boolean; name: string; message?: string } {
    const gateway = gateways.value.find(item => item.id === id);
    if (!gateway) return { ok: false, name: "", message: "未找到当前路由" };
    const currentName = configNameFor(gateway);
    const nextName = sanitizeConfigName(rawName);
    if (!nextName) {
      return { ok: false, name: currentName, message: "配置名只能包含中文、字母、数字、下划线或短横线" };
    }
    const duplicated = gateways.value.some(item => item.id !== id && configNameFor(item) === nextName);
    if (duplicated) {
      return { ok: false, name: currentName, message: `配置名 ${nextName} 已存在` };
    }
    gateway.configName = nextName;
    pendingSelectedConfigName.value = nextName;
    touch();
    return { ok: true, name: nextName };
  }

  function removeGateway(id: string): void {
    gateways.value = gateways.value.filter(gateway => gateway.id !== id);
    if (selectedGatewayId.value === id) selectedGatewayId.value = gateways.value[0]?.id || "";
    touch();
  }

  async function deleteGateway(id: string): Promise<void> {
    if (saving.value) throw new Error("另一项配置操作正在执行，请稍后重试。");
    const nextSelectedGatewayId = selectedGatewayId.value === id
      ? gateways.value.find(gateway => gateway.id !== id)?.id || ""
      : selectedGatewayId.value;
    saving.value = true;
    error.value = "";
    try {
      for (const previous of routeCatalogMutationLedger.unresolved()) await recoverPendingMutation(previous);
      const mutationLifecycleKey = await loadMeta(true);
      const pendingMutation = await routeCatalogMutationLedger.retain(
        "delete",
        { id },
        routeCatalogRevisionHash.value
      );
      const response = await boundedRouteCatalogMutationFetch(`${apiBase}/gateways/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        headers: {
          "idempotency-key": pendingMutation.operationId,
          "if-match": `"${pendingMutation.expectedContentHash}"`
        }
      });
      const text = await response.text();
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (!response.ok || body.code !== 0) {
        await retireRejectedRouteMutation(response, pendingMutation, mutationLifecycleKey);
        const fallbackMessage = response.status === 404 || /<!doctype html|<html/i.test(text)
          ? "当前 Manager 还没有加载删除接口，请重启 Manager 后再删除。"
          : `删除路由失败（HTTP ${response.status}）：${text.replace(/\s+/g, " ").slice(0, 160) || "没有返回错误详情"}`;
        throw new Error(body.message || body.error || fallbackMessage);
      }
      const committedRevision = committedRouteCatalogRevision(body, pendingMutation);
      if (await loadMeta(true) !== mutationLifecycleKey) {
        throw new Error("Manager lifecycle changed after the Route deletion; retry the same delete operation.");
      }
      applyRouteCatalogVersion(body.routeCatalog);
      routeCatalogRevisionHash.value = committedRevision;
      routeCatalogMutationLedger.complete(pendingMutation);
      selectedGatewayId.value = nextSelectedGatewayId;
      gateways.value = gateways.value.filter(item => item.id !== id);
      savedGateways.value = savedGateways.value.filter(item => item.id !== id);
      await load();
      if (gateways.value.some(gateway => gateway.id === id)) {
        throw new Error("删除请求已返回成功，但 Manager 刷新后仍返回该路由；请重启 Manager 后再试。");
      }
    } catch (deleteError) {
      error.value = deleteError instanceof Error ? deleteError.message : String(deleteError);
      throw deleteError;
    } finally {
      saving.value = false;
    }
  }

  function updateGatewayField<K extends keyof GatewayDefinition>(field: K, value: GatewayDefinition[K]): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    gateway[field] = value;
    if (field === "id") selectedGatewayId.value = String(value || "");
    if (field === "agentRoleId") {
      if (!String(value || "").trim()) {
        gateway.automationRules = [];
        gateway.notificationRules = [];
      }
      ensureActiveRoleRules(gateway);
    }
    touch();
  }

  function updateAdapters(adapters: MessageAdapterType[]): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    setGatewayAdapters(gateway, adapters);
    applyAdapterDefaults(gateway);
    touch();
  }

  function addRule(): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const messageRules = automations.filter(rule => rule.trigger.type === "message" && rule.action.type === "deliver_agent");
    const next = messageRules.length + 1;
    automations.push({
      id: `rule-${Date.now().toString(36)}-${next}`,
      name: `规则 ${next}`,
      enabled: true,
      trigger: { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
      action: { type: "deliver_agent", template: "" }
    });
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function removeRule(ruleIndex: number): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const entry = automations
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.type === "message" && rule.action.type === "deliver_agent")[ruleIndex];
    if (!entry || isBuiltinRolePanelRule(notificationRulesForGateway(gateway)[ruleIndex])) return;
    automations.splice(entry.index, 1);
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function updateRule(ruleIndex: number, patch: Partial<NotificationRule>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const entry = automations
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.type === "message" && rule.action.type === "deliver_agent")[ruleIndex];
    if (!entry || entry.rule.trigger.type !== "message" || entry.rule.action.type !== "deliver_agent") return;
    entry.rule = {
      ...entry.rule,
      name: patch.name ?? entry.rule.name,
      enabled: patch.enabled ?? entry.rule.enabled,
      trigger: {
        ...entry.rule.trigger,
        routeKinds: patch.routeKinds ?? entry.rule.trigger.routeKinds,
        targetGroupId: patch.targetGroupId ?? entry.rule.trigger.targetGroupId,
        allowedSpeakerNames: patch.allowedSpeakerNames ?? entry.rule.trigger.allowedSpeakerNames,
        regex: patch.regex ?? entry.rule.trigger.regex
      },
      action: {
        ...entry.rule.action,
        template: patch.template ?? entry.rule.action.template
      }
    };
    automations[entry.index] = entry.rule;
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function addAutomation(triggerType: "message" | "schedule", actionType: "deliver_agent" | "run_script"): string | undefined {
    const gateway = selectedGateway.value;
    if (!gateway) return undefined;
    const automations = automationRulesForGateway(gateway);
    const id = `automation-${Date.now().toString(36)}-${automations.length + 1}`;
    const next: PersonaAutomationRuleDefinition = {
      id,
      name: triggerType === "schedule" ? "新定时任务" : "新消息动作",
      enabled: true,
      trigger: triggerType === "schedule"
        ? {
          type: "schedule",
          schedule: {
            id: `schedule-${Date.now().toString(36)}`,
            name: "触发时间",
            enabled: true,
            type: "interval",
            intervalSeconds: Number(gateway.heartbeatIntervalSeconds || 900)
          }
        }
        : { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
      action: actionType === "run_script"
        ? { type: "run_script", scriptPath: "", arguments: [], timeoutSeconds: 300 }
        : { type: "deliver_agent", message: "", template: "" }
    };
    automations.push(next);
    syncAutomationRuleProjection(gateway);
    touch();
    return id;
  }

  function updateAutomation(ruleId: string, patch: Partial<PersonaAutomationRuleDefinition>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    const current = automations[index];
    automations[index] = {
      ...current,
      ...patch,
      trigger: patch.trigger ?? current.trigger,
      action: patch.action ?? current.action
    };
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function removeAutomation(ruleId: string): void {
    const gateway = selectedGateway.value;
    if (!gateway || ruleId === "role-panel-message") return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    automations.splice(index, 1);
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function addRouteVariable(): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (!gateway.routeVariables) gateway.routeVariables = {};
    let next = 1;
    while (gateway.routeVariables[`Variable${next}`] != null) next += 1;
    gateway.routeVariables[`Variable${next}`] = "";
    touch();
  }

  function updateRouteVariable(oldKey: string, key: string, value: string): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (!gateway.routeVariables) gateway.routeVariables = {};
    if (key !== oldKey && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      gateway.routeVariables[key] = value;
      delete gateway.routeVariables[oldKey];
    } else {
      gateway.routeVariables[oldKey] = value;
    }
    touch();
  }

  function removeRouteVariable(key: string): void {
    const gateway = selectedGateway.value;
    if (!gateway?.routeVariables) return;
    delete gateway.routeVariables[key];
    touch();
  }

  function applyQuickSetup(values: {
    agentRoleId: string;
    agentModel?: string;
    codexThreadId?: string;
    codexThreadName: string;
    copilotThreadName: string;
    codexCwd: string;
    copilotCliBin?: string;
    copilotCwd?: string;
    marvisAppId?: string;
    astrbotUrl?: string;
    astrbotUsername?: string;
    astrbotPassword?: string;
    astrbotProjectId?: string;
    astrbotSessionId?: string;
    dshSessionId?: string;
    dshSessionName?: string;
    dshCwd?: string;
    dshBaseUrl?: string;
    gatewayPort: number;
    napcatHttpUrl: string;
    napcatWebuiUrl?: string;
    adapters?: MessageAdapterType[];
    messageInputsDisabled?: boolean;
    agentAdapters?: AgentAdapterType[];
    primaryAgentAdapter?: AgentAdapterType;
    heartbeatIntervalSeconds?: number;
    heartbeatMessage?: string;
    heartbeatSkipWhenAgentBusy?: boolean;
    webhookPort?: number;
    webhookPath?: string;
    fenneNoteWebhookPort?: number;
    fenneNoteWebhookPath?: string;
    xiaoaiWebhookPort?: number;
    xiaoaiWebhookPath?: string;
    rabiLinkWebhookPort?: number;
    rabiLinkWebhookPath?: string;
    rabiLinkWebhookHost?: string;
    wecomBotId?: string;
    wecomBotSecret?: string;
    wecomWsUrl?: string;
  }): void {
    if (gateways.value.length === 0) addGateway();
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (values.adapters?.length) {
      setGatewayAdapters(gateway, values.adapters);
    }
    gateway.messageInputsDisabled = values.messageInputsDisabled === true;
    gateway.agentRoleId = values.agentRoleId;
    if (!gateway.agentRoleId) {
      gateway.automationRules = [];
      gateway.notificationRules = [];
    }
    gateway.agentModel = values.agentModel?.trim() || "";
    gateway.codexCwd = values.codexCwd;
    gateway.agentAdapters = values.agentAdapters?.length ? values.agentAdapters : gateway.agentAdapters;
    gateway.primaryAgentAdapter = resolvePrimaryAgentAdapter(
      gateway.agentAdapters,
      values.primaryAgentAdapter ?? gateway.primaryAgentAdapter
    );
    if (gateway.agentAdapters?.includes("codex")) {
      gateway.codexThreadId = values.codexThreadId;
      gateway.codexThreadName = values.codexThreadName;
    }
    if (gateway.agentAdapters?.includes("copilotCli")) {
      gateway.copilotThreadName = values.copilotThreadName;
      gateway.copilotCliBin = values.copilotCliBin || gateway.copilotCliBin;
      gateway.copilotCwd = values.copilotCwd || values.codexCwd;
    }
    if (gateway.agentAdapters?.includes("marvis")) {
      gateway.marvisAppId = values.marvisAppId || gateway.marvisAppId;
    }
    if (gateway.agentAdapters?.includes("astrbot")) {
      gateway.astrbotUrl = values.astrbotUrl || gateway.astrbotUrl;
      gateway.astrbotUsername = values.astrbotUsername || gateway.astrbotUsername;
      gateway.astrbotPassword = values.astrbotPassword || gateway.astrbotPassword;
      gateway.astrbotProjectId = values.astrbotProjectId || gateway.astrbotProjectId;
      gateway.astrbotSessionId = values.astrbotSessionId || gateway.astrbotSessionId;
    }
    if (gateway.agentAdapters?.includes("dsh")) {
      gateway.dshSessionId = values.dshSessionId || gateway.dshSessionId;
      gateway.dshSessionName = values.dshSessionName || gateway.dshSessionName;
      gateway.dshCwd = values.dshCwd || values.codexCwd;
      gateway.dshBaseUrl = values.dshBaseUrl || gateway.dshBaseUrl;
    }
    gateway.gatewayPort = values.gatewayPort;
    gateway.napcatHttpUrl = values.napcatHttpUrl;
    gateway.napcatWebuiUrl = values.napcatWebuiUrl || gateway.napcatWebuiUrl;
    if (gateway.messageAdapters?.includes("napcat") || gateway.messageAdapterType === "napcat") {
      if (!Array.isArray(gateway.napcatInstances) || gateway.napcatInstances.length === 0) {
        gateway.napcatInstances = [{
          id: "default",
          name: "默认 NapCat",
          enabled: true,
          gatewayPort: values.gatewayPort,
          httpUrl: values.napcatHttpUrl,
          webuiUrl: values.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
          accessToken: gateway.napcatAccessToken || "",
          webuiToken: gateway.napcatWebuiToken || ""
        }];
      } else {
        const primary = gateway.napcatInstances.find(instance => instance.enabled !== false)
          ?? gateway.napcatInstances[0];
        gateway.napcatInstances = [{
          ...primary,
          enabled: true,
          gatewayPort: values.gatewayPort,
          httpUrl: values.napcatHttpUrl,
          webuiUrl: values.napcatWebuiUrl || primary.webuiUrl
        }];
      }
    }
    gateway.heartbeatIntervalSeconds = values.heartbeatIntervalSeconds || gateway.heartbeatIntervalSeconds;
    gateway.heartbeatMessage = values.heartbeatMessage || gateway.heartbeatMessage;
    gateway.heartbeatSkipWhenAgentBusy = values.heartbeatSkipWhenAgentBusy === true;
    gateway.webhookPort = values.webhookPort || gateway.webhookPort;
    gateway.webhookPath = values.webhookPath || gateway.webhookPath;
    gateway.fenneNoteWebhookPort = values.fenneNoteWebhookPort || gateway.fenneNoteWebhookPort;
    gateway.fenneNoteWebhookPath = values.fenneNoteWebhookPath || gateway.fenneNoteWebhookPath;
    gateway.xiaoaiWebhookPort = values.xiaoaiWebhookPort || gateway.xiaoaiWebhookPort;
    gateway.xiaoaiWebhookPath = values.xiaoaiWebhookPath || gateway.xiaoaiWebhookPath;
    gateway.rabiLinkWebhookPort = values.rabiLinkWebhookPort || gateway.rabiLinkWebhookPort;
    gateway.rabiLinkWebhookPath = values.rabiLinkWebhookPath || gateway.rabiLinkWebhookPath;
    gateway.rabiLinkWebhookHost = values.rabiLinkWebhookHost || gateway.rabiLinkWebhookHost;
    gateway.wecomBotId = values.wecomBotId || gateway.wecomBotId;
    gateway.wecomBotSecret = values.wecomBotSecret || gateway.wecomBotSecret;
    gateway.wecomWsUrl = values.wecomWsUrl || gateway.wecomWsUrl;
    gateway.agentRoleFile = gateway.agentRoleFile || "persona.md";
    applyAdapterDefaults(gateway);
    touch();
  }

  return {
    gateways,
    managerRows,
    routeSummaries,
    routeBootstrapLoading,
    routeBootstrapError,
    routeCatalogRevisionHash,
    selectedRouteSummary,
    managerError,
    networkOptions,
    configFiles,
    selectedGatewayId,
    requestedRouteKey,
    routeSelectionMissing,
    syncRouteSelection,
    selectedIndex,
    selectedGateway,
    selectedRuntime,
    loading,
    diagnosticsLoading,
    diagnosticsLoaded,
    saving,
    saveState,
    saveMessage,
    dirty,
    error,
    quickSetupDialogOpen,
    meta,
    runningCount,
    quickSetupNeeded,
    routeSummaryForKey,
    runtimeFor,
    touch,
    openQuickSetup,
    closeQuickSetup,
    loadRouteSummaries,
    load,
    ensureDiagnostics,
    save,
    saveChangedRoutes,
    reloadSelectedGateway,
    actionGateway,
    manualTriggerGateway,
    testAgentDelivery,
    openConfigFile,
    selectGateway,
    addGateway,
    addGatewayAndOpenQuickSetup,
    renameGatewayConfig,
    removeGateway,
    deleteGateway,
    updateGatewayField,
    updateAdapters,
    addRule,
    removeRule,
    updateRule,
    addAutomation,
    updateAutomation,
    removeAutomation,
    addRouteVariable,
    updateRouteVariable,
    removeRouteVariable,
    applyQuickSetup,
    gatewayAdapterTypes,
    configNameFor
  };
});
