import type {
  GatewayDiagnosticsRuntimeInput,
  GatewayDiagnosticsWorkerInput,
  GatewayDiagnosticsWorkerResult
} from "./gatewayDiagnosticsSnapshot.js";

export type GatewayDiagnosticsSnapshotWorkerContext<Runtime> = Readonly<{
  reset(personaPresentations: GatewayDiagnosticsWorkerInput["personaPresentations"]): void;
  install(snapshot: GatewayDiagnosticsRuntimeInput): void;
  runtimes(): readonly Runtime[];
  diagnostics(
    runtime: Runtime,
    roleInfoCatalogCache: Map<string, Array<Record<string, unknown>>>,
    tailCache: Map<string, Array<Record<string, unknown>>>
  ): Record<string, unknown>;
  summary(
    runtime: Runtime,
    roleInfoCatalogCache: Map<string, Array<Record<string, unknown>>>
  ): Record<string, unknown>;
  now?: () => Date;
}>;

/** Runs only in the bounded Manager read child process. */
export function buildIsolatedGatewayDiagnosticsSnapshot<Runtime>(
  input: GatewayDiagnosticsWorkerInput,
  context: GatewayDiagnosticsSnapshotWorkerContext<Runtime>
): GatewayDiagnosticsWorkerResult {
  if (process.env.RABIROUTE_MANAGER_READ_PROCESS !== "1") {
    throw new Error("Gateway diagnostics snapshots must be built inside a Manager read worker.");
  }
  context.reset(input.personaPresentations);
  for (const snapshot of input.runtimes) context.install(snapshot);
  const roleInfoCatalogCache = new Map<string, Array<Record<string, unknown>>>();
  const tailCache = new Map<string, Array<Record<string, unknown>>>();
  const runtimes = context.runtimes();
  return {
    diagnostics: runtimes.map(runtime =>
      context.diagnostics(runtime, roleInfoCatalogCache, tailCache)),
    summary: runtimes.map(runtime =>
      context.summary(runtime, roleInfoCatalogCache)),
    refreshedAt: (context.now?.() ?? new Date()).toISOString()
  };
}
