import { config, runtimeLayout } from "./config.js";
import { gatewayReadyLine, type GatewayEndpoint } from "./gatewayLifecycle.js";
import type { GatewayMessageAdapterType } from "./adapters/messageAdapter.js";
import { startGatewayPerformanceReporter } from "./performance/gatewayPerformanceReporter.js";
import { mountGatewayPerformanceReporter } from "./runtime/gatewayPerformanceRuntime.js";
import {
  ensureAgentAdapterRuntime,
  type AgentAdapterRuntimeMount
} from "./runtime/agentAdapterRuntime.js";
import {
  mountContributionRuntime,
  type ContributionRuntimeMount
} from "./runtime/contributionRuntime.js";
import {
  getBuiltinGatewayCordisRoot,
  type GatewayCordisRoot
} from "./runtime/gatewayCordisRoot.js";
import {
  mountMessageAdapterRuntime,
  type MessageAdapterRuntimeMount
} from "./runtime/messageAdapterRuntime.js";
import { createManagerOperationalLog, installOperationalMutationAuditSink } from "./manager/operationalLog.js";

const GATEWAY_CONTRIBUTION_RUNTIME_KEY = "rabi.runtime.contributions.gateway";
const GATEWAY_MESSAGE_ADAPTER_RUNTIME_KEY = "rabi.runtime.messageAdapters.gateway";
const GATEWAY_PERFORMANCE_RUNTIME_KEY = "rabi.runtime.performance.gateway";

type GatewayLifecycleEvent = "SIGINT" | "SIGTERM" | "beforeExit";
type GatewayLifecycleListener = () => void;

export type GatewayProcessLifecycle = {
  once(event: GatewayLifecycleEvent, listener: GatewayLifecycleListener): unknown;
  removeListener(event: GatewayLifecycleEvent, listener: GatewayLifecycleListener): unknown;
};

export type GatewayMainOptions = {
  adapterTypes?: readonly GatewayMessageAdapterType[];
  processLifecycle?: GatewayProcessLifecycle;
  startPerformanceReporter?: () => () => void;
};

export type GatewayMainRuntime = {
  root: GatewayCordisRoot;
  agentAdapters: AgentAdapterRuntimeMount;
  contributions: ContributionRuntimeMount;
  messageAdapters: MessageAdapterRuntimeMount;
  dispose(): Promise<void>;
};

const gatewayMainRuntimes = new WeakMap<GatewayCordisRoot, Promise<GatewayMainRuntime>>();

async function initializeGatewayMain(
  root: GatewayCordisRoot,
  options: GatewayMainOptions
): Promise<GatewayMainRuntime> {
  const adapterTypes = options.adapterTypes ?? config.gatewayMessageAdapterTypes;
  const lifecycle = options.processLifecycle ?? process;
  const startReporter = options.startPerformanceReporter ?? startGatewayPerformanceReporter;
  let gatewayDisposePromise: Promise<void> | undefined;
  const listeners = new Map<GatewayLifecycleEvent, GatewayLifecycleListener>();

  function removeLifecycleListeners(): void {
    for (const [event, listener] of listeners) {
      lifecycle.removeListener(event, listener);
    }
    listeners.clear();
  }

  function disposeGatewayRuntime(): Promise<void> {
    if (!gatewayDisposePromise) {
      gatewayDisposePromise = (async () => {
        removeLifecycleListeners();
        await root.dispose();
      })();
    }
    return gatewayDisposePromise;
  }

  try {
    const agentAdapters = await ensureAgentAdapterRuntime(root);
    const contributions = await root.ensure(
      GATEWAY_CONTRIBUTION_RUNTIME_KEY,
      (host) => mountContributionRuntime(host, [])
    );
    const messageAdapters = await root.ensure(
      GATEWAY_MESSAGE_ADAPTER_RUNTIME_KEY,
      (host) => mountMessageAdapterRuntime(host)
    );

    for (const type of adapterTypes) {
      await messageAdapters.mount(type);
    }

    await root.ensure(
      GATEWAY_PERFORMANCE_RUNTIME_KEY,
      (host) => mountGatewayPerformanceReporter(host, startReporter)
    );
    for (const event of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
      const listener = () => void disposeGatewayRuntime();
      listeners.set(event, listener);
      lifecycle.once(event, listener);
    }

    return {
      root,
      agentAdapters,
      contributions,
      messageAdapters,
      dispose: disposeGatewayRuntime
    };
  } catch (error) {
    removeLifecycleListeners();
    await root.dispose();
    throw error;
  }
}

export function startGatewayMain(
  options: GatewayMainOptions = {}
): Promise<GatewayMainRuntime> {
  const root = getBuiltinGatewayCordisRoot();
  const existing = gatewayMainRuntimes.get(root);
  if (existing) return existing;

  const starting = initializeGatewayMain(root, options);
  gatewayMainRuntimes.set(root, starting);
  void starting.catch(() => {
    if (gatewayMainRuntimes.get(root) === starting) {
      gatewayMainRuntimes.delete(root);
    }
  });
  return starting;
}

export async function runGatewayMain(): Promise<void> {
  const operationalLog = createManagerOperationalLog({ rootDir: runtimeLayout.stateRoot });
  const uninstallMutationAuditSink = installOperationalMutationAuditSink(operationalLog, runtimeLayout.stateRoot);
  const flushOperationalLog = (): void => {
    uninstallMutationAuditSink();
    void operationalLog.flush().catch(error => {
      process.stderr.write(`[RabiRoute Gateway operations] failed to flush: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  process.once("SIGINT", flushOperationalLog);
  process.once("SIGTERM", flushOperationalLog);
  process.once("beforeExit", flushOperationalLog);
  try {
    await startGatewayMain();
  } catch (error) {
    process.removeListener("SIGINT", flushOperationalLog);
    process.removeListener("SIGTERM", flushOperationalLog);
    process.removeListener("beforeExit", flushOperationalLog);
    uninstallMutationAuditSink();
    await operationalLog.flush();
    throw error;
  }
  const gatewayId = String(process.env.GATEWAY_ID || "").trim();
  const gatewayGenerationId = String(process.env.RABIROUTE_GATEWAY_GENERATION_ID || "").trim();
  if (!gatewayId || !gatewayGenerationId) {
    throw new Error("Manager-owned Gateway identity is missing.");
  }
  const endpoints: GatewayEndpoint[] = [];
  if (config.gatewayMessageAdapterTypes.includes("napcat")) {
    for (const instance of config.napcatInstances.filter(item => item.enabled !== false)) {
      endpoints.push({
        id: `napcat:${instance.id}`,
        transport: "websocket",
        host: "127.0.0.1",
        port: instance.gatewayPort
      });
    }
  }
  const addHttp = (id: string, enabled: boolean, host: string, port: number, path: string): void => {
    if (enabled) endpoints.push({ id, transport: "http", host, port, path });
  };
  addHttp("webhook", config.gatewayMessageAdapterTypes.includes("webhook"), "127.0.0.1", config.webhookPort, config.webhookPath);
  addHttp("fennenote", config.gatewayMessageAdapterTypes.includes("fennenote"), "127.0.0.1", config.fenneNoteWebhookPort, config.fenneNoteWebhookPath);
  addHttp("rabilink", config.gatewayMessageAdapterTypes.includes("rabilink"), config.rabiLinkWebhookHost, config.rabiLinkWebhookPort, config.rabiLinkWebhookPath);
  addHttp("feishu", config.gatewayMessageAdapterTypes.includes("feishu"), "127.0.0.1", config.feishuWebhookPort, config.feishuWebhookPath);
  console.log(gatewayReadyLine({
    protocolVersion: 1,
    gatewayId,
    gatewayGenerationId,
    pid: process.pid,
    readyAt: new Date().toISOString(),
    endpoints
  }));
}
