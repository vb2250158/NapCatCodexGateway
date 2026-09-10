import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { normalizeAgentInstanceBindings, type AgentInstanceBinding } from "../shared/agentInstance.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayAdapterTypes, type GatewayDefinition, type GatewayConfigFile } from "../shared/gatewayConfigModel.js";
import { isAgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import { sanitizeConfigName } from "../shared/routeIdentity.js";
import { routeFolderPath } from "../shared/routePaths.js";
import type { RabiGlobalConfigStore, RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import {
  discoverManagerLanEndpoints,
  verifyManagerDiscoveryEndpoint,
  type DiscoveredManagerEndpoint
} from "./managerLanDiscoveryConsumer.js";

export type RabiApiContext = {
  rootDir: string;
  routeRoot: string;
  managerPort: number;
  managerHost: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  version: () => string;
  globalConfig: RabiGlobalConfigStore;
  runtimes: () => Iterable<GatewayRuntime>;
  runtimeStatus: (runtime: GatewayRuntime) => Record<string, unknown>;
  readConfig: () => GatewayConfigFile;
  writeConfig: (
    config: GatewayConfigFile,
    expectedContentHash: string | undefined,
    operationId: string
  ) => Promise<GatewayConfigFile>;
  loadRuntimes: () => Promise<void>;
  routeCatalogVersion: () => Readonly<{
    contentHash: string;
    routeConfigHash: string;
    presentationHash: string;
    revision: number;
  }>;
  routeCatalogPersonas: () => readonly RouteCatalogPersonaPresentation[];
  syncRunningGateways: () => void;
  syncRabiLinkRelay: () => Promise<void>;
  scanAgentAdapters: () => Promise<Record<string, unknown>>;
  routeDataDir: (definition: GatewayDefinition) => string;
};

type RabiInstance = {
  guid: string;
  name: string;
  computerName: string;
  deviceType: string;
  baseUrl: string;
  host: string;
  port: number;
  version?: string;
  addresses?: string[];
  self?: boolean;
  applicationGenerationId: string;
  managerInstanceId: string;
};

export function publicRabiLinkRelayConfig(config: RabiLinkRelayGlobalConfig): Record<string, unknown> {
  const { token: _token, ...safe } = config;
  return {
    ...safe,
    tokenConfigured: Boolean(config.token)
  };
}

type AgentBindingPatch = {
  agentAdapter?: string;
  codexCwd?: string;
  codexThreadId?: string;
  codexThreadName?: string;
  copilotThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  agentInstanceBindings?: Record<string, AgentInstanceBinding>;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function localIpv4Addresses(): string[] {
  const result: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal) result.push(item.address);
    }
  }
  return [...new Set(result)];
}

function hostFromRequest(request: http.IncomingMessage, fallbackPort: number): { host: string; port: number; baseUrl: string } {
  const hostHeader = String(request.headers.host || `127.0.0.1:${fallbackPort}`);
  const rawHost = hostHeader.replace(/^\[/, "").replace(/\]$/, "");
  const [hostPart, portPart] = rawHost.split(":");
  const host = hostPart || "127.0.0.1";
  const port = Number(portPart || fallbackPort) || fallbackPort;
  return { host, port, baseUrl: `http://${host}:${port}` };
}

function identityPayload(ctx: RabiApiContext, request: http.IncomingMessage): { code: number; data: RabiInstance & Record<string, unknown> } {
  const config = ctx.globalConfig.read();
  const fromRequest = hostFromRequest(request, ctx.managerPort);
  const publicHost = fromRequest.host === "127.0.0.1" || fromRequest.host === "localhost"
    ? localIpv4Addresses()[0] || fromRequest.host
    : fromRequest.host;
  const port = fromRequest.port || ctx.managerPort;
  return {
    code: 0,
    data: {
      guid: config.rabiGuid,
      name: config.rabiName,
      computerName: os.hostname(),
      deviceType: "RabiRoute Manager",
      host: publicHost,
      port,
      baseUrl: `http://${publicHost}:${port}`,
      version: ctx.version(),
      applicationGenerationId: ctx.applicationGenerationId,
      managerInstanceId: ctx.managerInstanceId,
      addresses: localIpv4Addresses(),
      managerHost: ctx.managerHost,
      rabiLinkRelay: publicRabiLinkRelayConfig(config.rabiLinkRelay),
      configPath: ctx.globalConfig.configPath,
      self: true
    }
  };
}

type MobileAdapterState = {
  type: string;
  label: string;
  state: "connected" | "ready" | "login_required" | "waiting" | "stopped" | "disabled" | "attention";
  summary: string;
};

type MobileRouteStatusInput = {
  enabled?: boolean;
  running: boolean;
  messageAdapters?: string[];
  messageAdaptersDisabled?: string[];
  runtimeStatus?: Record<string, unknown>;
};

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function adapterLabel(type: string): string {
  return ({
    napcat: "QQ",
    weixin: "个人微信",
    wecom: "企业微信",
    feishu: "飞书",
    rabilink: "手机消息",
    speech: "语音",
    wearable: "穿戴设备",
    heartbeat: "定时触发",
    webhook: "Webhook",
    rolePanel: "角色面板"
  } as Record<string, string>)[type] ?? type;
}

/**
 * Builds the deliberately small status contract used by mobile clients.
 * It never forwards account ids, paths, message samples, raw errors, logs,
 * ports, URLs, process ids, or other diagnostics from gatewayStatus.
 */
export function mobileAdapterStates(input: MobileRouteStatusInput): MobileAdapterState[] {
  const adapters = [...new Set((input.messageAdapters ?? []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const disabled = new Set((input.messageAdaptersDisabled ?? []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const runtimeStatus = recordValue(input.runtimeStatus);
  const gatewayStatus = recordValue(runtimeStatus.gatewayStatus);
  const liveAdapters = recordValue(gatewayStatus.messageAdapters);
  const napcatInstancesValue = gatewayStatus.napcatInstances;
  const napcatInstances = Array.isArray(napcatInstancesValue)
    ? napcatInstancesValue.map(recordValue)
    : Object.values(recordValue(napcatInstancesValue)).map(recordValue);

  return adapters.map((type): MobileAdapterState => {
    const label = adapterLabel(type);
    if (input.enabled === false || disabled.has(type)) {
      return { type, label, state: "disabled", summary: "已停用" };
    }
    if (!input.running) {
      return { type, label, state: "stopped", summary: "等待 Rabi PC 启动" };
    }

    const live = recordValue(liveAdapters[type]);
    if (type === "weixin") {
      return live.loggedIn === true
        ? { type, label, state: "connected", summary: "已登录" }
        : { type, label, state: "login_required", summary: "未登录" };
    }
    if (type === "napcat") {
      const legacy = recordValue(gatewayStatus.napcat);
      const connected = napcatInstances.some((item) => item.connected === true)
        || legacy.connected === true
        || live.connected === true;
      return connected
        ? { type, label, state: "connected", summary: "已连接" }
        : { type, label, state: "waiting", summary: "等待 QQ 连接" };
    }
    if (type === "wecom") {
      const connected = live.connected === true && live.authenticated !== false;
      return connected
        ? { type, label, state: "connected", summary: "已连接" }
        : { type, label, state: "waiting", summary: "等待连接" };
    }
    if (type === "feishu") {
      return live.connected === true
        ? { type, label, state: "connected", summary: "已连接" }
        : { type, label, state: "waiting", summary: "等待连接" };
    }
    if (String(live.status || "").toLowerCase() === "error") {
      return { type, label, state: "attention", summary: "需要在 Rabi PC 检查" };
    }
    return {
      type,
      label,
      state: "ready",
      summary: type === "rabilink" ? "已就绪" : "运行中"
    };
  });
}

function routeSummary(
  runtime: GatewayRuntime,
  runtimeStatus: Record<string, unknown>,
  rootDir: string,
  defaultRolesRoot: string,
  personaPresentations: readonly RouteCatalogPersonaPresentation[],
  mobilePresentation = false
): Record<string, unknown> {
  const definition = runtime.definition;
  const roleId = definition.agentRoleId ?? "";
  const rolesRoot = resolveRolesRoot(rootDir, definition.rolesDir, defaultRolesRoot);
  const presentation = routeCatalogPersona(personaPresentations, rolesRoot, roleId);
  const avatar = roleId ? personaAvatarFromCatalog(roleId, presentation) : {};
  const enabled = definition.enabled !== false;
  const running = Boolean(runtime.process);
  const messageAdapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  const messageAdaptersDisabled = definition.messageAdaptersDisabled ?? [];
  const normalizedMessageAdapters = new Set(messageAdapters.map((type) => String(type).toLowerCase()));
  const normalizedDisabledAdapters = new Set(messageAdaptersDisabled.map((type) => String(type).toLowerCase()));
  if (mobilePresentation) {
    const adapterStates = mobileAdapterStates({
      enabled,
      running,
      messageAdapters,
      messageAdaptersDisabled,
      runtimeStatus
    });
    return {
      id: definition.id,
      name: definition.name,
      enabled,
      running,
      messageAdapters,
      messageAdaptersDisabled,
      agentRoleId: roleId,
      personaDisplayName: presentation?.displayName || roleId,
      chatAvailable: enabled
        && normalizedMessageAdapters.has("rabilink")
        && !normalizedDisabledAdapters.has("rabilink"),
      adapterStates,
      ...avatar
    };
  }
  return {
    id: definition.id,
    name: definition.name,
    configName: sanitizeConfigName(definition.configName) || definition.id,
    routeName: definition.routeName,
    enabled,
    running,
    agentAdapters: definition.agentAdapters ?? ["codex"],
    primaryAgentAdapter: definition.primaryAgentAdapter,
    codexCwd: definition.codexCwd ?? "",
    codexThreadId: definition.codexThreadId ?? "",
    codexThreadName: definition.codexThreadName ?? "",
    copilotThreadName: definition.copilotThreadName ?? "",
    copilotCwd: definition.copilotCwd ?? "",
    copilotCliBin: definition.copilotCliBin ?? "",
    marvisAppId: definition.marvisAppId ?? "",
    agentInstanceBindings: definition.agentInstanceBindings,
    astrbotUrl: definition.astrbotUrl ?? "",
    astrbotProjectId: definition.astrbotProjectId ?? "",
    astrbotSessionId: definition.astrbotSessionId ?? "",
    messageAdapters,
    messageAdaptersDisabled,
    agentRoleId: roleId,
    personaDisplayName: presentation?.displayName || roleId,
    ...avatar,
    runtimeStatus
  };
}

function resolveRolesRoot(rootDir: string, value: unknown, fallback: string): string {
  const configured = String(value || "").trim();
  if (!configured) return path.resolve(fallback);
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(rootDir, configured);
}

function routeCatalogPersonaKey(rolesRoot: string, roleId: string): string {
  return `${path.resolve(rolesRoot).replace(/\\/g, "/").toLowerCase()}\0${roleId.toLowerCase()}`;
}

function routeCatalogPersona(
  presentations: readonly RouteCatalogPersonaPresentation[],
  rolesRoot: string,
  roleId: string
): RouteCatalogPersonaPresentation | undefined {
  const expected = routeCatalogPersonaKey(rolesRoot, roleId);
  return presentations.find(item => routeCatalogPersonaKey(item.rolesRoot, item.roleId) === expected);
}

function personaAvatarFromCatalog(
  roleId: string,
  presentation: RouteCatalogPersonaPresentation | undefined
): Record<string, unknown> {
  const version = presentation?.avatarVersion;
  return {
    avatarConfigured: presentation?.avatarConfigured === true,
    ...(version ? {
      avatarUrl: `/api/roles/${encodeURIComponent(roleId)}/avatar?v=${encodeURIComponent(version)}`,
      avatarVersion: version
    } : {})
  };
}

export function personaProfileIds(
  presentations: readonly RouteCatalogPersonaPresentation[],
  boundRoleIds: Iterable<string>
): RouteCatalogPersonaPresentation[] {
  const known = new Set([...boundRoleIds].map((value) => String(value || "").trim()).filter(Boolean));
  const profiles: RouteCatalogPersonaPresentation[] = [];
  for (const presentation of presentations) {
    if (!presentation.isPersona || known.has(presentation.roleId)) continue;
    known.add(presentation.roleId);
    profiles.push(presentation);
  }
  return profiles;
}

function localRoutes(ctx: RabiApiContext, includeProfiles = false, mobilePresentation = false): Record<string, unknown> {
  const defaultRolesRoot = path.join(ctx.rootDir, "data", "roles");
  const personaPresentations = ctx.routeCatalogPersonas();
  const routes = [...ctx.runtimes()].map((runtime) => routeSummary(
    runtime,
    ctx.runtimeStatus(runtime),
    ctx.rootDir,
    defaultRolesRoot,
    personaPresentations,
    mobilePresentation
  ));
  if (includeProfiles) {
    const boundRoleIds = new Set(routes.map((route) => String(route.agentRoleId || "").trim()).filter(Boolean));
    for (const profile of personaProfileIds(personaPresentations, boundRoleIds)) {
        routes.push({
          id: `role:${profile.roleId}`,
          name: profile.displayName,
          configName: "",
          routeName: "",
          enabled: false,
          running: false,
          agentAdapters: [],
          messageAdapters: [],
          messageAdaptersDisabled: [],
          agentRoleId: profile.roleId,
          personaDisplayName: profile.displayName,
          ...personaAvatarFromCatalog(profile.roleId, profile),
          chatAvailable: false,
          adapterStates: [],
          isPersonaOnly: true,
          ...(mobilePresentation ? {} : { runtimeStatus: {} })
        });
    }
  }
  return { code: 0, data: { routes }, routeCatalog: ctx.routeCatalogVersion() };
}

function findGateway(config: GatewayConfigFile, routeId: string): GatewayDefinition | undefined {
  return config.gateways.find((gateway) => gateway.id === routeId || sanitizeConfigName(gateway.configName) === routeId);
}

function routeOptionsFromAgentScan(route: GatewayDefinition, scan: Record<string, any>): Record<string, unknown> {
  const agents = scan.agents ?? {};
  const activeAdapters = Array.isArray(route.agentAdapters) ? route.agentAdapters : ["codex"];
  return {
    route: {
      id: route.id,
      name: route.name,
      configName: sanitizeConfigName(route.configName) || route.id,
      routeName: route.routeName,
      agentAdapters: activeAdapters,
      primaryAgentAdapter: route.primaryAgentAdapter,
      codexCwd: route.codexCwd ?? "",
      codexThreadId: route.codexThreadId ?? "",
      codexThreadName: route.codexThreadName ?? "",
      copilotThreadName: route.copilotThreadName ?? "",
      copilotCwd: route.copilotCwd ?? "",
      astrbotProjectId: route.astrbotProjectId ?? "",
      astrbotSessionId: route.astrbotSessionId ?? ""
    },
    cwdOptions: scan.cwdOptions ?? [],
    threadNames: scan.threadNames ?? [],
    agents: activeAdapters.reduce((result: Record<string, unknown>, adapter) => {
      result[adapter] = agents[adapter] ?? null;
      return result;
    }, {}),
    allAgents: agents
  };
}

async function localAgentOptions(ctx: RabiApiContext, routeId: string): Promise<Record<string, unknown>> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  const scan = await ctx.scanAgentAdapters() as Record<string, any>;
  return { code: 0, data: routeOptionsFromAgentScan(route, scan) };
}

function readJsonlTail(filePath: string, limit: number, afterId: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const afterIndex = afterId ? rows.findIndex((item) => String(item.id ?? "") === afterId) : -1;
  const selected = afterIndex >= 0 ? rows.slice(afterIndex + 1) : rows.slice(-limit);
  return selected.slice(-limit);
}

function apiErrorStatus(error: unknown, fallback = 500): number {
  const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : fallback;
}

type RouteMutationContract = Readonly<{
  operationId: string;
  expectedContentHash: string;
}>;

function requestHeader(request: http.IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

function requireRouteMutationContract(request: http.IncomingMessage): RouteMutationContract {
  const operationId = requestHeader(request, "idempotency-key");
  const rawIfMatch = requestHeader(request, "if-match");
  const quotedHash = /^"([a-f0-9]{64})"$/i.exec(rawIfMatch)?.[1];
  const expectedContentHash = (/^[a-f0-9]{64}$/i.test(rawIfMatch) ? rawIfMatch : quotedHash ?? "")
    .toLowerCase();
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(operationId)) {
    throw Object.assign(new Error("A valid Idempotency-Key is required for this Route mutation."), {
      statusCode: 400,
      code: "idempotency_key_required"
    });
  }
  if (/^W\//i.test(rawIfMatch) || !/^[a-f0-9]{64}$/.test(expectedContentHash)) {
    throw Object.assign(new Error("A strong If-Match Route catalog hash is required for this mutation."), {
      statusCode: 428,
      code: "route_catalog_precondition_required"
    });
  }
  return Object.freeze({ operationId, expectedContentHash });
}

function routeMutationProxyHeaders(contract: RouteMutationContract): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": contract.operationId,
    "if-match": contract.expectedContentHash
  };
}

function nestedErrorCodes(error: unknown): string[] {
  let current = error as ({ code?: unknown; cause?: unknown } | null);
  const codes: string[] = [];
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === "string" && current.code) codes.push(current.code);
    current = current.cause && typeof current.cause === "object"
      ? current.cause as { code?: unknown; cause?: unknown }
      : null;
  }
  return codes;
}

function publicRouteMutationFailure(error: unknown): Readonly<{
  statusCode: number;
  errorCode: string;
  message: string;
}> {
  const codes = nestedErrorCodes(error);
  const code = codes[0] || "";
  if (codes.includes("ROUTE_CATALOG_REVISION_CONFLICT") || codes.includes("route_catalog_conflict")) {
    return Object.freeze({
      statusCode: 412,
      errorCode: "route_catalog_conflict",
      message: "Route catalog changed; reload and retry with its new hash."
    });
  }
  if (codes.includes("ROUTE_CATALOG_IDEMPOTENCY_CONFLICT") || codes.includes("route_catalog_idempotency_conflict")) {
    return Object.freeze({
      statusCode: 409,
      errorCode: "route_catalog_idempotency_conflict",
      message: "Idempotency-Key is already committed for a different Route mutation."
    });
  }
  const statusCode = apiErrorStatus(error, 503);
  if (statusCode === 400 || statusCode === 428) {
    return Object.freeze({
      statusCode,
      errorCode: code || "route_mutation_contract_invalid",
      message: error instanceof Error ? error.message : "Route mutation contract is invalid."
    });
  }
  return Object.freeze({
    statusCode: statusCode === 409 ? 409 : 503,
    errorCode: code || "route_catalog_unavailable",
    message: statusCode === 409
      ? "Route catalog mutation conflicts with an existing operation."
      : "Route catalog is temporarily unavailable. Retry with the same Idempotency-Key."
  });
}

function localRabiLinkReplies(ctx: RabiApiContext, routeId: string, requestUrl: URL): Record<string, unknown> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  const configName = sanitizeConfigName(route.configName) || route.id;
  const limit = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get("limit") || 20) || 20));
  const afterId = String(requestUrl.searchParams.get("afterId") || "");
  const filePath = path.join(routeFolderPath(ctx.routeRoot, configName), "rabilink-replies.jsonl");
  return {
    code: 0,
    data: {
      route: {
        id: route.id,
        name: route.name,
        configName,
        routeName: route.routeName
      },
      file: path.relative(ctx.rootDir, filePath).replace(/\\/g, "/"),
      replies: readJsonlTail(filePath, limit, afterId)
    }
  };
}

async function setLocalAgentBinding(
  ctx: RabiApiContext,
  routeId: string,
  patch: AgentBindingPatch,
  mutation: RouteMutationContract
): Promise<Record<string, unknown>> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  if (patch.agentAdapter) {
    if (!isAgentAdapterType(patch.agentAdapter)) {
      return { code: -1, message: `Unsupported agent adapter: ${patch.agentAdapter}` };
    }
    route.agentAdapters = [patch.agentAdapter];
    route.primaryAgentAdapter = patch.agentAdapter;
  }
  if (patch.codexCwd !== undefined) route.codexCwd = String(patch.codexCwd || "");
  if (patch.codexThreadId !== undefined) route.codexThreadId = String(patch.codexThreadId || "");
  if (patch.codexThreadName !== undefined) route.codexThreadName = String(patch.codexThreadName || "");
  if (patch.copilotThreadName !== undefined) route.copilotThreadName = String(patch.copilotThreadName || "");
  if (patch.copilotCwd !== undefined) route.copilotCwd = String(patch.copilotCwd || "");
  if (patch.copilotCliBin !== undefined) route.copilotCliBin = String(patch.copilotCliBin || "");
  if (patch.marvisAppId !== undefined) route.marvisAppId = String(patch.marvisAppId || "");
  if (patch.astrbotUrl !== undefined) route.astrbotUrl = String(patch.astrbotUrl || "");
  if (patch.astrbotUsername !== undefined) route.astrbotUsername = String(patch.astrbotUsername || "");
  if (patch.astrbotPassword !== undefined) route.astrbotPassword = String(patch.astrbotPassword || "");
  if (patch.astrbotProjectId !== undefined) route.astrbotProjectId = String(patch.astrbotProjectId || "");
  if (patch.agentInstanceBindings !== undefined) route.agentInstanceBindings = normalizeAgentInstanceBindings(patch.agentInstanceBindings);
  if (patch.astrbotSessionId !== undefined) route.astrbotSessionId = String(patch.astrbotSessionId || "");
  if (patch.dshSessionId !== undefined) route.dshSessionId = String(patch.dshSessionId || "");
  if (patch.dshSessionName !== undefined) route.dshSessionName = String(patch.dshSessionName || "");
  if (patch.dshCwd !== undefined) route.dshCwd = String(patch.dshCwd || "");
  if (patch.dshBaseUrl !== undefined) route.dshBaseUrl = String(patch.dshBaseUrl || "");
  const normalized = await ctx.writeConfig(config, mutation.expectedContentHash, mutation.operationId);
  ctx.syncRunningGateways();
  const updated = findGateway(normalized, routeId) ?? route;
  const routeCatalog = ctx.routeCatalogVersion();
  return {
    code: 0,
    data: { route: updated },
    receipt: {
      state: "committed",
      operationId: mutation.operationId,
      routeConfigHash: routeCatalog.routeConfigHash
    },
    routeCatalog
  };
}

async function discoverInstances(ctx: RabiApiContext, request: http.IncomingMessage, requestUrl: URL): Promise<RabiInstance[]> {
  if (requestUrl.searchParams.has("ports")) {
    throw Object.assign(new Error("The ports discovery query is retired; Manager discovery uses DNS-SD and generation fencing."), { statusCode: 400 });
  }
  const timeoutMs = Math.max(120, Math.min(3000, Number(requestUrl.searchParams.get("timeoutMs") || 450)));
  const found = new Map<string, RabiInstance>();
  const self = identityPayload(ctx, request).data;
  found.set(self.guid, self);
  const discovery = await discoverManagerLanEndpoints({ timeoutMs });
  for (const endpoint of discovery.endpoints) {
    found.set(endpoint.guid, {
      ...endpoint,
      self: endpoint.guid === self.guid
    });
  }
  return [...found.values()].sort((left, right) => Number(Boolean(right.self)) - Number(Boolean(left.self)) || left.name.localeCompare(right.name));
}

async function findInstance(ctx: RabiApiContext, request: http.IncomingMessage, requestUrl: URL, guid: string): Promise<RabiInstance | null> {
  const self = identityPayload(ctx, request).data;
  if (guid === self.guid) return self;
  return (await discoverInstances(ctx, request, requestUrl)).find((item) => item.guid === guid) ?? null;
}

async function proxyJson(instance: RabiInstance, path: string, init: RequestInit, timeoutMs = 3000): Promise<{ status: number; body: unknown }> {
  if (!instance.self) {
    await verifyManagerDiscoveryEndpoint(instance as DiscoveredManagerEndpoint, { timeoutMs });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("x-rabiroute-expected-application-generation-id", instance.applicationGenerationId);
    headers.set("x-rabiroute-expected-manager-instance-id", instance.managerInstanceId);
    const response = await fetch(`${instance.baseUrl}${path}`, { ...init, headers, redirect: "error", signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length") || 0);
    const maxResponseBytes = 4 * 1024 * 1024;
    if (declaredLength > maxResponseBytes) throw Object.assign(new Error("Remote Manager response exceeds the bounded proxy size."), { statusCode: 502 });
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    if (responseBytes.byteLength > maxResponseBytes) throw Object.assign(new Error("Remote Manager response exceeds the bounded proxy size."), { statusCode: 502 });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { code: -1, message: text };
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function isSelfGuid(ctx: RabiApiContext, guid: string): boolean {
  return ctx.globalConfig.read().rabiGuid === guid;
}


function messageProcessingStatePaths(ctx: RabiApiContext, route: GatewayDefinition): { agents: string; affinity: string } {
  const dir = path.join(ctx.routeDataDir(route), "message-groups");
  return { agents: path.join(dir, "agents.json"), affinity: path.join(dir, "routing-affinity.json") };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "message.processing",
      event: "message_agent_state_write_failed",
      owner: "rabi-api",
      action: "persist-message-agent-state",
      target: { type: "message-agent-state", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `message-groups/${path.basename(filePath)}` },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "message.processing",
    event: "message_agent_state_written",
    owner: "rabi-api",
    action: "persist-message-agent-state",
    target: { type: "message-agent-state", id: path.basename(filePath) },
    dataSource: { kind: "file", id: `message-groups/${path.basename(filePath)}` },
    outcome: "committed"
  });
}

function messageProcessingPayload(ctx: RabiApiContext, route: GatewayDefinition): Record<string, unknown> {
  const paths = messageProcessingStatePaths(ctx, route);
  const agents = readJsonFile<{ workers?: unknown[] }>(paths.agents, {});
  const affinity = readJsonFile<{ workers?: unknown[] }>(paths.affinity, {});
  return {
    code: 0,
    data: {
      route: { id: route.id, name: route.name, messageProcessingAgents: route.messageProcessingAgents ?? {} },
      stateFiles: {
        agents: path.relative(ctx.rootDir, paths.agents).replace(/\\/g, "/"),
        affinity: path.relative(ctx.rootDir, paths.affinity).replace(/\\/g, "/")
      },
      workers: Array.isArray(agents.workers) ? agents.workers : [],
      affinities: Array.isArray(affinity.workers) ? affinity.workers : []
    }
  };
}

function managedMessageWorker(worker: Record<string, unknown>, route: GatewayDefinition, adapter?: string): boolean {
  const workerAdapter = String(worker.agentAdapter || (String(worker.threadId || "").startsWith("session-") ? "dsh" : "codex"));
  const expectedWorkspace = workerAdapter === "dsh" ? route.dshCwd : route.codexCwd;
  const title = String(worker.threadName || "");
  return (!adapter || workerAdapter === adapter)
    && (!expectedWorkspace || path.resolve(String(worker.workspace || "")) === path.resolve(expectedWorkspace))
    && title.includes("协助处理消息");
}

async function listDshMessageWorkers(route: GatewayDefinition): Promise<Record<string, unknown>[]> {
  const baseUrl = (route.dshBaseUrl || "http://127.0.0.1:3080").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/session.list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `rabi-message-workers-${Date.now()}`,
      method: "session.list",
      payload: {}
    })
  });
  const body = await response.json() as Record<string, any>;
  const items = body.result?.ok === true && Array.isArray(body.result.value?.items)
    ? body.result.value.items as Record<string, any>[]
    : undefined;
  if (!response.ok || items === undefined) {
    throw new Error(String(body.result?.error?.message || body.message || `DSH session.list failed with HTTP ${response.status}`));
  }
  return items.flatMap((item) => {
    const sessionId = String(item.sessionId || "");
    const workspace = String(item.cwd || "");
    const title = String(item.projections?.values?.title || "");
    const worker = { agentAdapter: "dsh", threadId: sessionId, threadName: title, workspace };
    return sessionId && managedMessageWorker(worker, route, "dsh") ? [worker] : [];
  });
}

async function deleteDshSession(baseUrl: string, sessionId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/session.delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: `rabi-cleanup-${sessionId}`, method: "session.delete", payload: { sessionId } })
  });
  const body = await response.json() as Record<string, any>;
  if (!response.ok || body.result?.ok !== true) {
    throw new Error(String(body.result?.error?.message || body.message || `DSH session.delete failed with HTTP ${response.status}`));
  }
  return body;
}

async function localMessageProcessingCleanup(
  ctx: RabiApiContext,
  route: GatewayDefinition,
  body: { adapter?: string; keepSessionIds?: string[] }
): Promise<Record<string, unknown>> {
  const paths = messageProcessingStatePaths(ctx, route);
  const state = readJsonFile<{ schemaVersion?: number; updatedAt?: string; workers?: Record<string, unknown>[] }>(paths.agents, {});
  const affinity = readJsonFile<{ schemaVersion?: number; updatedAt?: string; workers?: Record<string, unknown>[] }>(paths.affinity, {});
  const keep = new Set((body.keepSessionIds ?? []).map(String));
  const workers = Array.isArray(state.workers) ? state.workers : [];
  const candidates = new Map<string, Record<string, unknown>>();
  for (const worker of workers) {
    if (managedMessageWorker(worker, route, body.adapter)) candidates.set(String(worker.threadId || ""), worker);
  }
  if (!body.adapter || body.adapter === "dsh") {
    for (const worker of await listDshMessageWorkers(route)) candidates.set(String(worker.threadId || ""), worker);
  }
  const selected = [...candidates.values()].filter(worker => !keep.has(String(worker.threadId || "")));
  const deleted: string[] = [];
  const failed: Array<Record<string, string>> = [];
  for (const worker of selected) {
    const threadId = String(worker.threadId || "");
    const adapter = String(worker.agentAdapter || (threadId.startsWith("session-") ? "dsh" : "codex"));
    try {
      if (adapter === "dsh" && threadId) {
        await deleteDshSession(route.dshBaseUrl || "http://127.0.0.1:3080", threadId);
      }
      deleted.push(threadId);
    } catch (error) {
      failed.push({ threadId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const deletedSet = new Set(deleted);
  writeJsonFile(paths.agents, {
    schemaVersion: state.schemaVersion ?? 2,
    updatedAt: new Date().toISOString(),
    workers: workers.filter(worker => !deletedSet.has(String(worker.threadId || "")))
  });
  const affinityWorkers = Array.isArray(affinity.workers) ? affinity.workers : [];
  writeJsonFile(paths.affinity, {
    schemaVersion: affinity.schemaVersion ?? 1,
    updatedAt: new Date().toISOString(),
    workers: affinityWorkers.filter(worker => !deletedSet.has(String(worker.threadId || "")))
  });
  return { code: failed.length ? -1 : 0, data: { selected: selected.map(worker => String(worker.threadId || "")), deleted, failed, kept: [...keep] } };
}

export function handleRabiApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, ctx: RabiApiContext): boolean {
  const pathname = requestUrl.pathname;
  const expectedGeneration = String(request.headers["x-rabiroute-expected-application-generation-id"] || "").trim();
  const expectedManager = String(request.headers["x-rabiroute-expected-manager-instance-id"] || "").trim();
  if (Boolean(expectedGeneration) !== Boolean(expectedManager)) {
    jsonResponse(response, 400, { code: -1, message: "Manager lifecycle fencing requires both generation and instance headers." });
    return true;
  }
  if ((expectedGeneration && expectedGeneration !== ctx.applicationGenerationId)
    || (expectedManager && expectedManager !== ctx.managerInstanceId)) {
    jsonResponse(response, 409, { code: -1, message: "The requested Manager generation is no longer active." });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/rabi/identity") {
    jsonResponse(response, 200, identityPayload(ctx, request));
    return true;
  }
  if (request.method === "PATCH" && pathname === "/api/rabi/identity") {
    void readJsonBody<Partial<{ rabiName: string; rabiLinkRelay: unknown }>>(request)
      .then(async (body) => {
        const current = ctx.globalConfig.read();
        const relayPatch = body.rabiLinkRelay && typeof body.rabiLinkRelay === "object" && !Array.isArray(body.rabiLinkRelay)
          ? body.rabiLinkRelay as Record<string, unknown>
          : undefined;
        const nextRelay = relayPatch ? { ...current.rabiLinkRelay, ...relayPatch } : current.rabiLinkRelay;
        if (nextRelay.enabled === true && (!String(nextRelay.url || "").trim() || !String(nextRelay.token || "").trim())) {
          throw new Error("开启 RabiLink Relay 前，请先填写服务器地址和应用 token。");
        }
        const beforeRelay = JSON.stringify(current.rabiLinkRelay);
        const config = ctx.globalConfig.patch({ rabiName: body.rabiName, rabiLinkRelay: body.rabiLinkRelay as any });
        const relayChanged = beforeRelay !== JSON.stringify(config.rabiLinkRelay);
        await ctx.syncRabiLinkRelay();
        if (relayChanged) {
          for (const runtime of ctx.runtimes()) {
            if (gatewayAdapterTypes(runtime.definition).includes("rabilink")) {
              runtime.needsRestart = true;
            }
          }
          ctx.syncRunningGateways();
        }
        return config;
      })
      .then((config) => jsonResponse(response, 200, {
        code: 0,
        data: {
          ...config,
          rabiLinkRelay: publicRabiLinkRelayConfig(config.rabiLinkRelay)
        }
      }))
      .catch((error) => jsonResponse(
        response,
        apiErrorStatus(error, 400),
        { code: -1, message: error instanceof Error ? error.message : String(error) }
      ));
    return true;
  }
  if (request.method === "GET" && pathname === "/api/rabi/instances") {
    void discoverInstances(ctx, request, requestUrl)
      .then((items) => jsonResponse(response, 200, { code: 0, data: { instances: items } }))
      .catch((error) => jsonResponse(response, apiErrorStatus(error), { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  const routeMatch = pathname.match(/^\/api\/rabi\/instances\/([^/]+)\/routes(?:\/([^/]+)(?:\/(agent-options|agent-binding|rabilink-replies|message-processing|message-processing-cleanup))?)?$/);
  if (!routeMatch) return false;

  const guid = decodeURIComponent(routeMatch[1]);
  const routeId = routeMatch[2] ? decodeURIComponent(routeMatch[2]) : "";
  const action = routeMatch[3] || "";

  if ((request.method === "GET" || request.method === "PATCH") && routeId && action === "message-processing") {
    let mutation: RouteMutationContract | undefined;
    if (request.method === "PATCH") {
      try {
        mutation = requireRouteMutationContract(request);
      } catch (error) {
        const failure = publicRouteMutationFailure(error);
        jsonResponse(response, failure.statusCode, { code: -1, errorCode: failure.errorCode, message: failure.message });
        return true;
      }
    }
    if (!isSelfGuid(ctx, guid)) {
      void (async () => {
        const body = request.method === "PATCH"
          ? await readJsonBody<Record<string, unknown>>(request)
          : undefined;
        const instance = await findInstance(ctx, request, requestUrl, guid);
        return instance
          ? proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/message-processing`, {
            method: request.method,
            ...(body === undefined ? {} : { headers: routeMutationProxyHeaders(mutation!), body: JSON.stringify(body) })
          })
          : { status: 404, body: { code: -1, message: `RabiRoute instance not found: ${guid}` } };
      })()
        .then(result => jsonResponse(response, result.status, result.body))
        .catch(error => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    const run = async (): Promise<Record<string, unknown>> => {
      const config = ctx.readConfig();
      const route = findGateway(config, routeId);
      if (!route) return { code: -1, message: `Route not found: ${routeId}` };
      if (request.method === "GET") return messageProcessingPayload(ctx, route);
      const body = await readJsonBody<{ adapter?: string; maxAgents?: number }>(request);
      const maxAgents = Math.max(1, Math.min(32, Math.floor(Number(body.maxAgents)) || 1));
      const adapters = body.adapter ? [body.adapter] : ["codex", "dsh"];
      route.messageProcessingAgents = { ...(route.messageProcessingAgents ?? {}) };
      for (const adapter of adapters) {
        if (!isAgentAdapterType(adapter)) continue;
        route.messageProcessingAgents[adapter] = {
          ...(route.messageProcessingAgents[adapter] ?? { enabled: false, model: "gpt-5.6-luna", reasoningEffort: "medium" }),
          maxAgents
        };
      }
      const normalized = await ctx.writeConfig(config, mutation!.expectedContentHash, mutation!.operationId);
      ctx.syncRunningGateways();
      const updated = findGateway(normalized, routeId) ?? route;
      const routeCatalog = ctx.routeCatalogVersion();
      return {
        ...messageProcessingPayload(ctx, updated),
        receipt: {
          state: "committed",
          operationId: mutation!.operationId,
          routeConfigHash: routeCatalog.routeConfigHash
        },
        routeCatalog
      };
    };
    void run()
      .then(result => jsonResponse(response, result.code === 0 ? 200 : 404, result))
      .catch(error => {
        const failure = publicRouteMutationFailure(error);
        jsonResponse(response, failure.statusCode, { code: -1, errorCode: failure.errorCode, message: failure.message });
      });
    return true;
  }

  if (request.method === "POST" && routeId && action === "message-processing-cleanup") {
    if (!isSelfGuid(ctx, guid)) {
      void (async () => {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const instance = await findInstance(ctx, request, requestUrl, guid);
        return instance
          ? proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/message-processing-cleanup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          })
          : { status: 404, body: { code: -1, message: `RabiRoute instance not found: ${guid}` } };
      })()
        .then(result => jsonResponse(response, result.status, result.body))
        .catch(error => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    void readJsonBody<{ adapter?: string; keepSessionIds?: string[] }>(request)
      .then(async body => {
        const route = findGateway(ctx.readConfig(), routeId);
        if (!route) return { status: 404, body: { code: -1, message: `Route not found: ${routeId}` } };
        return { status: 200, body: await localMessageProcessingCleanup(ctx, route, body) };
      })
      .then(result => jsonResponse(response, result.status, result.body))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && !routeId && !action) {
    if (isSelfGuid(ctx, guid)) {
      jsonResponse(response, 200, localRoutes(
        ctx,
        requestUrl.searchParams.get("includeProfiles") === "true",
        requestUrl.searchParams.get("presentation") === "mobile"
      ));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes${requestUrl.search}`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && routeId && action === "agent-options") {
    if (isSelfGuid(ctx, guid)) {
      void localAgentOptions(ctx, routeId)
        .then((result) => jsonResponse(response, result.code === 0 ? 200 : 404, result))
        .catch((error) => jsonResponse(response, apiErrorStatus(error), { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/agent-options`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && routeId && action === "rabilink-replies") {
    if (isSelfGuid(ctx, guid)) {
      jsonResponse(response, 200, localRabiLinkReplies(ctx, routeId, requestUrl));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/rabilink-replies${requestUrl.search}`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if ((request.method === "PATCH" || request.method === "POST") && routeId && action === "agent-binding") {
    let mutation: RouteMutationContract;
    try {
      mutation = requireRouteMutationContract(request);
    } catch (error) {
      const failure = publicRouteMutationFailure(error);
      jsonResponse(response, failure.statusCode, { code: -1, errorCode: failure.errorCode, message: failure.message });
      return true;
    }
    void readJsonBody<AgentBindingPatch>(request)
      .then(async (body) => {
        if (isSelfGuid(ctx, guid)) {
          return { status: 200, body: await setLocalAgentBinding(ctx, routeId, body, mutation) };
        }
        const instance = await findInstance(ctx, request, requestUrl, guid);
        if (!instance) return { status: 404, body: { code: -1, message: `RabiRoute instance not found: ${guid}` } };
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/agent-binding`, {
          method: "PATCH",
          headers: routeMutationProxyHeaders(mutation),
          body: JSON.stringify(body)
        });
      })
      .then((result) => jsonResponse(response, result.status, result.body))
      .catch((error) => {
        const failure = publicRouteMutationFailure(error);
        jsonResponse(response, failure.statusCode, { code: -1, errorCode: failure.errorCode, message: failure.message });
      });
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}
