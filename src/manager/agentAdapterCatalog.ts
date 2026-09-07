import type http from "node:http";
import { fileURLToPath } from "node:url";
import { updateAgentHooks } from "../agentAdapters/hookInstallation.js";
import { listRegisteredAgentAdapterManifests } from "../agentAdapters/agentAdapter.js";
import type {
  AgentScanOptions,
  AgentScanPerformanceOperation,
  AgentScanRuntimeSnapshot
} from "../agentAdapters/managerApi.js";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import type { AgentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import {
  AgentAdapterCatalogWorkerError,
  AgentAdapterCatalogWorkerPool,
  type AgentAdapterCatalogWorkerPoolStatus
} from "./agentAdapterCatalogWorkerPool.js";

export const AGENT_ADAPTER_CATALOG_PLUGIN_INSTANCE_ID = "manager:agent-adapter-catalog";

export type AgentAdapterCatalogServiceOptions = {
  rootDir: string;
  getRuntimes(): Iterable<AgentScanRuntimeSnapshot>;
  workerPool?: AgentAdapterCatalogWorkerPool;
  listManifests?: () => Promise<AgentAdapterManifest[]>;
  recordOperation?: (operation: string, durationMs: number, error?: boolean) => void;
};

export type AgentAdapterCatalogSnapshot = {
  schemaVersion: 1;
  adapters: Array<{
    type: AgentAdapterManifest["type"];
    label: string;
    maturity: AgentAdapterManifest["maturity"];
    transport: { protocol: string; mode: string };
    host?: { name: string; required: boolean };
    capabilities: AgentAdapterManifest["capabilities"];
  }>;
};

export type AgentAdapterCatalogRoutesContext = {
  service: AgentAdapterCatalogService;
  jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void;
};

export type AgentAdapterCatalogPluginMountOptions = AgentAdapterCatalogServiceOptions & {
  jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void;
  registerRoutes(
    instanceId: string,
    routeIdPrefix: string,
    handlers: readonly ManagerPluginRouteHandler[]
  ): () => void;
};

export type AgentAdapterCatalogPluginMount = {
  service: AgentAdapterCatalogService;
  handler: ManagerPluginRouteHandler;
  cancel(reason?: string): Promise<void>;
  drain(): Promise<void>;
  stop(reason?: string): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queryNumber(value: string | null, fallback: number): number {
  return Number(value || String(fallback));
}

function cloneManifest(manifest: AgentAdapterManifest): AgentAdapterCatalogSnapshot["adapters"][number] {
  return {
    type: manifest.type,
    label: manifest.label,
    maturity: manifest.maturity,
    transport: { ...manifest.transport },
    ...(manifest.host ? { host: { ...manifest.host } } : {}),
    capabilities: {
      ...(manifest.capabilities.managedTasks
        ? { managedTasks: { ...manifest.capabilities.managedTasks } }
        : {})
    }
  };
}

function fullScanOptions(requestUrl: URL): AgentScanOptions {
  return {
    codexLimit: queryNumber(requestUrl.searchParams.get("codexLimit"), 200),
    codexOffset: queryNumber(requestUrl.searchParams.get("codexOffset"), 0),
    codexQuery: requestUrl.searchParams.get("codexQuery") || undefined,
    dshLimit: queryNumber(requestUrl.searchParams.get("dshLimit"), 200),
    dshOffset: queryNumber(requestUrl.searchParams.get("dshOffset"), 0),
    dshQuery: requestUrl.searchParams.get("dshQuery") || undefined,
    dshBaseUrl: requestUrl.searchParams.get("dshBaseUrl") || undefined
  };
}

function dshScanOptions(
  requestUrl: URL
): Pick<AgentScanOptions, "dshLimit" | "dshOffset" | "dshQuery" | "dshBaseUrl"> {
  return {
    dshLimit: queryNumber(requestUrl.searchParams.get("dshLimit"), 200),
    dshOffset: queryNumber(requestUrl.searchParams.get("dshOffset"), 0),
    dshQuery: requestUrl.searchParams.get("dshQuery") || undefined,
    dshBaseUrl: requestUrl.searchParams.get("dshBaseUrl") || undefined
  };
}

function responseAbortSignal(
  request: http.IncomingMessage,
  response: http.ServerResponse
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded && !response.destroyed) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}

export class AgentAdapterCatalogService {
  private readonly rootDir: string;
  private readonly getRuntimes: () => Iterable<AgentScanRuntimeSnapshot>;
  private readonly workerPool: AgentAdapterCatalogWorkerPool;
  private readonly listManifests: () => Promise<AgentAdapterManifest[]>;
  private readonly recordOperation: (operation: string, durationMs: number, error?: boolean) => void;
  private state: "accepting" | "draining" | "stopped" = "accepting";
  private readonly active = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();

  constructor(options: AgentAdapterCatalogServiceOptions) {
    this.rootDir = options.rootDir;
    this.getRuntimes = options.getRuntimes;
    this.workerPool = options.workerPool ?? new AgentAdapterCatalogWorkerPool();
    this.listManifests = options.listManifests ?? listRegisteredAgentAdapterManifests;
    this.recordOperation = options.recordOperation ?? recordPerformanceOperation;
  }

  async updateHooks(adapter: string): Promise<{ message: string }> {
    this.assertAccepting();
    return updateAgentHooks(fileURLToPath(new URL("../../", import.meta.url)), adapter);
  }

  async catalog(): Promise<AgentAdapterCatalogSnapshot> {
    this.assertAccepting();
    const manifests = await this.track(this.listManifests());
    return {
      schemaVersion: 1,
      adapters: manifests.map(cloneManifest)
    };
  }

  scanAll(options: AgentScanOptions = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.assertAccepting();
    const operation = this.runControlled(
      controller => this.workerPool.query<Record<string, unknown>>({
        kind: "all",
        rootDir: this.rootDir,
        runtimes: this.runtimeSnapshots(),
        options
      }, { signal: controller.signal }),
      signal
    ).then(result => this.consumePerformanceOperations(result));
    return this.track(operation);
  }

  scanDsh(
    options: Pick<AgentScanOptions, "dshLimit" | "dshOffset" | "dshQuery" | "dshBaseUrl"> = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    this.assertAccepting();
    return this.track(this.runControlled(
      controller => this.workerPool.query<Record<string, unknown>>({
        kind: "dsh",
        rootDir: this.rootDir,
        runtimes: this.runtimeSnapshots(),
        options
      }, { signal: controller.signal }),
      signal
    ));
  }

  workerStatus(): AgentAdapterCatalogWorkerPoolStatus {
    return this.workerPool.status();
  }

  activeCount(): number {
    return this.active.size;
  }

  async cancel(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.settleActive();
      return;
    }
    for (const controller of this.controllers) controller.abort(reason);
    await this.workerPool.cancel(reason);
    await this.settleActive();
  }

  async drain(): Promise<void> {
    if (this.state === "accepting") this.state = "draining";
    await this.settleActive();
    await this.workerPool.drain();
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.settleActive();
      await this.workerPool.drain();
      return;
    }
    this.state = "stopped";
    for (const controller of this.controllers) controller.abort(reason);
    await this.workerPool.stop(reason);
    await this.settleActive();
  }

  private assertAccepting(): void {
    if (this.state !== "accepting") {
      throw new AgentAdapterCatalogWorkerError("Agent adapter catalog is stopping.", "aborted");
    }
  }

  private runtimeSnapshots(): AgentScanRuntimeSnapshot[] {
    return [...this.getRuntimes()].map(runtime => ({ definition: runtime.definition }));
  }

  private runControlled<T>(
    run: (controller: AbortController) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return run(controller).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    );
    return operation;
  }

  private async settleActive(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private consumePerformanceOperations(result: Record<string, unknown>): Record<string, unknown> {
    const operations = Array.isArray(result.__performanceOperations)
      ? result.__performanceOperations as AgentScanPerformanceOperation[]
      : [];
    for (const operation of operations) {
      this.recordOperation(
        String(operation.operation || "manager.agent_scan.unknown"),
        Number(operation.durationMs || 0),
        operation.error === true
      );
    }
    const response = { ...result };
    delete response.__performanceOperations;
    return response;
  }
}

function routeErrorStatus(error: unknown): number {
  return error instanceof AgentAdapterCatalogWorkerError && error.code === "busy" ? 503 : 500;
}

export function handleAgentAdapterCatalogApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentAdapterCatalogRoutesContext
): boolean {
  if (request.method === "POST" && requestUrl.pathname === "/api/agent-adapters/hooks/update") {
    void context.service.updateHooks(requestUrl.searchParams.get("adapter") || "")
      .then(data => context.jsonResponse(response, 200, { ok: true, ...data }))
      .catch(error => context.jsonResponse(response, 500, { ok: false, message: errorMessage(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/agent-adapters/catalog") {
    void context.service.catalog()
      .then(data => context.jsonResponse(response, 200, { code: 0, data }))
      .catch(error => context.jsonResponse(response, routeErrorStatus(error), {
        code: -1,
        message: errorMessage(error)
      }));
    return true;
  }

  const allScan = requestUrl.pathname === "/api/scan/agents";
  const dshScan = requestUrl.pathname === "/api/scan/agents/dsh";
  if (request.method !== "GET" || (!allScan && !dshScan)) return false;

  const requestLifetime = responseAbortSignal(request, response);
  const operation = dshScan
    ? context.service.scanDsh(dshScanOptions(requestUrl), requestLifetime.signal)
    : context.service.scanAll(fullScanOptions(requestUrl), requestLifetime.signal);
  void operation
    .then(data => {
      if (!response.writableEnded && !response.destroyed) context.jsonResponse(response, 200, data);
    })
    .catch(error => {
      if (!response.writableEnded && !response.destroyed) {
        context.jsonResponse(response, routeErrorStatus(error), {
          code: -1,
          message: errorMessage(error)
        });
      }
    })
    .finally(() => requestLifetime.dispose());
  return true;
}

export function mountAgentAdapterCatalogPlugin(
  options: AgentAdapterCatalogPluginMountOptions
): AgentAdapterCatalogPluginMount {
  const service = new AgentAdapterCatalogService(options);
  const requestTracker = new ManagerPluginRequestTracker();
  const handler: ManagerPluginRouteHandler = requestTracker.wrap((request, requestUrl, response) => (
    handleAgentAdapterCatalogApi(request, requestUrl, response, {
      service,
      jsonResponse: options.jsonResponse
    })
  ));
  const unregister = options.registerRoutes(
    AGENT_ADAPTER_CATALOG_PLUGIN_INSTANCE_ID,
    "manager.agent-adapter-catalog.api",
    [handler]
  );
  let registered = true;
  const unregisterOnce = (): void => {
    if (!registered) return;
    registered = false;
    unregister();
  };
  return {
    service,
    handler,
    cancel: reason => service.cancel(reason),
    async drain() {
      unregisterOnce();
      await requestTracker.stop();
      await service.drain();
    },
    async stop(reason?: string) {
      unregisterOnce();
      await requestTracker.stop();
      await service.stop(reason);
    }
  };
}
