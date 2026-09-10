export type ManagerPluginReadiness = Readonly<{
  state: "ready" | "degraded";
  missingCapabilities: readonly string[];
}>;

export type ManagerHealthSnapshot = Readonly<{
  state: "healthy" | "degraded";
  scope: "application_generation";
  checkedAt: string;
  pid: number;
  live: true;
  requiredReady: boolean;
  businessReady: boolean;
  backgroundState: "healthy" | "degraded";
  backgroundIncidentCount: number;
  message: string;
}>;

export function buildManagerHealthSnapshot(input: Readonly<{
  pluginReadiness: ManagerPluginReadiness;
  planStorageReady: boolean;
  routesReady: boolean;
  routeReadyCount: number;
  routeRequiredCount: number;
  blockedRouteIds: readonly string[];
  failedRouteIds: readonly string[];
  backgroundIncidentCount: number;
  sourcePatchesReady?: boolean;
  pid?: number;
  checkedAt?: string;
}>): ManagerHealthSnapshot {
  const requiredReady = input.pluginReadiness.missingCapabilities.length === 0;
  const businessReady = input.routesReady && input.planStorageReady;
  const healthy = input.pluginReadiness.state === "ready"
    && requiredReady
    && businessReady
    && input.sourcePatchesReady !== false;
  const message = !requiredReady
    ? `Manager event loop is live, but required plugin capabilities are unavailable: ${input.pluginReadiness.missingCapabilities.join(", ")}`
    : input.pluginReadiness.state !== "ready"
      ? "Manager event loop and required capabilities are ready, but optional plugins are degraded."
      : input.sourcePatchesReady === false
        ? "Manager event loop and required capabilities are ready, but source-patched APIs are unavailable; inspect /api/source-patches."
      : !input.planStorageReady
        ? "Manager event loop and required capabilities are ready, but plan storage startup recovery is not ready."
      : input.routesReady
          ? input.backgroundIncidentCount > 0
            ? `Manager event loop, required capabilities, and enabled Route ingress are ready; background incidents=${input.backgroundIncidentCount} are isolated from API readiness.`
            : "Manager event loop, required capabilities, and enabled Route ingress are ready."
          : `Manager event loop and required capabilities are ready, but Route ingress is degraded: ready=${input.routeReadyCount}/${input.routeRequiredCount}; blocked=${input.blockedRouteIds.join(",") || "none"}; failed=${input.failedRouteIds.join(",") || "none"}`;
  return Object.freeze({
    state: healthy ? "healthy" : "degraded",
    scope: "application_generation",
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    pid: input.pid ?? process.pid,
    live: true,
    requiredReady,
    businessReady,
    backgroundState: input.backgroundIncidentCount > 0 ? "degraded" : "healthy",
    backgroundIncidentCount: input.backgroundIncidentCount,
    message
  });
}
