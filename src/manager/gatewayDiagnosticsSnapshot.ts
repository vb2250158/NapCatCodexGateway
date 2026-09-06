import path from "node:path";
import type { GatewayEndpoint } from "../gatewayLifecycle.js";
import {
  definitionUsesNapcat,
  normalizeNapCatInstances,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";
import { sanitizeConfigName, sanitizeRoleId, routeRuntimeParts } from "../shared/routeIdentity.js";
import { roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

export type GatewayDiagnosticsRuntimeInput = Readonly<{
  definition: GatewayDefinition;
  processPid: number | null;
  needsRestart: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastExit: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  }> | null;
  readiness: "stopped" | "starting" | "ready" | "blocked" | "failed" | "stopping";
  endpoints: readonly GatewayEndpoint[];
  lastError: string | null;
  log: readonly string[];
  agentStates: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

export type GatewayDiagnosticsWorkerInput = Readonly<{
  runtimes: readonly GatewayDiagnosticsRuntimeInput[];
  personaPresentations: readonly RouteCatalogPersonaPresentation[];
}>;

export type GatewayDiagnosticsWorkerResult = Readonly<{
  diagnostics: readonly Record<string, unknown>[];
  summary: readonly Record<string, unknown>[];
  refreshedAt: string;
}>;

export type GatewayDiagnosticsSnapshotRead = Readonly<{
  records: readonly Record<string, unknown>[];
  revision: number;
  state: "warming" | "refreshing" | "ready" | "stale";
  refreshedAt?: string;
  refreshStartedAt?: string;
  refreshError?: string;
}>;

export type GatewayDiagnosticsSnapshotLoader = (
  input: GatewayDiagnosticsWorkerInput,
  options: Readonly<{ signal: AbortSignal; timeoutMs: number }>
) => Promise<GatewayDiagnosticsWorkerResult>;

export type GatewayDiagnosticsSnapshotServiceOptions = Readonly<{
  capture: () => GatewayDiagnosticsWorkerInput;
  load: GatewayDiagnosticsSnapshotLoader;
  initialSnapshot?: GatewayDiagnosticsWorkerResult;
  minRefreshIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}>;

export function captureGatewayDiagnosticsWorkerInput(
  runtimes: readonly GatewayRuntime[],
  agentStatesFor: (gatewayId: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  personaPresentations: readonly RouteCatalogPersonaPresentation[]
): GatewayDiagnosticsWorkerInput {
  return structuredClone({
    personaPresentations,
    runtimes: runtimes.map((runtime): GatewayDiagnosticsRuntimeInput => ({
      definition: runtime.definition,
      processPid: runtime.process?.pid ?? null,
      needsRestart: runtime.needsRestart,
      startedAt: runtime.startedAt,
      stoppedAt: runtime.stoppedAt,
      lastExit: runtime.lastExit,
      readiness: runtime.readiness,
      endpoints: runtime.endpoints,
      lastError: runtime.lastError,
      log: runtime.log,
      agentStates: agentStatesFor(runtime.definition.id) ?? {}
    }))
  });
}

export function memoryOnlyGatewayRuntimeStatus(
  rootDir: string,
  runtime: GatewayRuntime,
  cached?: Record<string, unknown>
): Record<string, unknown> {
  const definition = runtime.definition;
  const roleId = sanitizeRoleId(definition.agentRoleId);
  const activeRolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleFileName = definition.agentRoleFile ?? "persona.md";
  const memoryStatus: Record<string, unknown> = {
    id: definition.id,
    name: definition.name,
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    routeName: definition.routeName,
    enabled: definition.enabled,
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
    messageAdapterType: definition.messageAdapterType ?? "napcat",
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    rolesDir: definition.rolesDir,
    roleInfo: {
      rolesDir: activeRolesDir,
      selectedRoleId: roleId,
      selectedRolePath: roleId ? roleFilePath(activeRolesDir, roleId, roleFileName) : "",
      selectedRoleDataDir: roleId ? roleFolderPath(activeRolesDir, roleId) : "",
      options: []
    },
    roleRouteNames: definition.roleRouteNames,
    napcatInstances: definitionUsesNapcat(definition)
      ? (definition.napcatInstances ?? normalizeNapCatInstances(definition)).map(instance => ({
          id: instance.id,
          name: instance.name,
          enabled: instance.enabled,
          botNickname: instance.botNickname
        }))
      : [],
    codexCwd: definition.codexCwd,
    dataDir: definition.dataDir,
    notificationRules: definition.notificationRules,
    endpoints: runtime.endpoints,
    lastError: runtime.lastError,
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    log: runtime.log.slice(-30)
  };
  return {
    ...memoryStatus,
    ...(cached ?? {}),
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
    endpoints: runtime.endpoints,
    lastError: runtime.lastError,
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    log: runtime.log.slice(-30)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function publishResult(result: GatewayDiagnosticsWorkerResult): GatewayDiagnosticsWorkerResult {
  return deepFreeze(structuredClone(result));
}

/**
 * Owns the last committed diagnostics snapshot. HTTP handlers only call read(),
 * while capture/load run in a bounded background worker owned by the caller.
 */
export class GatewayDiagnosticsSnapshotService {
  private readonly capture: () => GatewayDiagnosticsWorkerInput;
  private readonly load: GatewayDiagnosticsSnapshotLoader;
  private readonly minRefreshIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private snapshot?: GatewayDiagnosticsWorkerResult;
  private revision = 0;
  private refreshError?: string;
  private refreshStartedAt?: string;
  private lastRefreshStartedAt = Number.NEGATIVE_INFINITY;
  private inFlight?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;

  constructor(options: GatewayDiagnosticsSnapshotServiceOptions) {
    this.capture = options.capture;
    this.load = options.load;
    this.minRefreshIntervalMs = Math.max(0, Math.floor(options.minRefreshIntervalMs ?? 5_000));
    this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 30_000));
    this.now = options.now ?? Date.now;
    this.snapshot = options.initialSnapshot ? publishResult(options.initialSnapshot) : undefined;
    if (this.snapshot) this.revision = 1;
  }

  read(includeDiagnostics: boolean): GatewayDiagnosticsSnapshotRead {
    const snapshot = this.snapshot;
    const state = this.inFlight
      ? "refreshing"
      : this.refreshError
        ? "stale"
        : snapshot
          ? "ready"
          : "warming";
    return deepFreeze({
      records: snapshot
        ? includeDiagnostics ? snapshot.diagnostics : snapshot.summary
        : [],
      revision: this.revision,
      state,
      refreshedAt: snapshot?.refreshedAt,
      refreshStartedAt: this.refreshStartedAt,
      refreshError: this.refreshError
    });
  }

  requestRefresh(options: Readonly<{ force?: boolean }> = {}): void {
    void this.refresh(options).catch(() => {
      // refresh() records failures and preserves the last committed snapshot.
    });
  }

  refresh(options: Readonly<{ force?: boolean }> = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const startedAt = this.now();
    if (!options.force && startedAt - this.lastRefreshStartedAt < this.minRefreshIntervalMs) {
      return Promise.resolve();
    }
    this.lastRefreshStartedAt = startedAt;
    this.refreshStartedAt = new Date(startedAt).toISOString();
    let input: GatewayDiagnosticsWorkerInput;
    try {
      input = this.capture();
    } catch (error) {
      this.refreshError = errorMessage(error);
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    const current = this.load(input, { signal: controller.signal, timeoutMs: this.timeoutMs })
      .then(result => {
        if (this.stopped || controller.signal.aborted) return;
        this.snapshot = publishResult(result);
        this.revision += 1;
        this.refreshError = undefined;
      })
      .catch(error => {
        if (!this.stopped) this.refreshError = errorMessage(error);
      })
      .finally(() => {
        if (this.inFlight === current) this.inFlight = undefined;
        if (this.controller === controller) this.controller = undefined;
      });
    this.inFlight = current;
    return current;
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = undefined;
  }
}
