import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertSourceRetainsRoutes(relativePath: string, routes: readonly string[]): void {
  const owner = source(relativePath);
  for (const route of routes) {
    assert.equal(owner.includes(route), true, `${relativePath} must retain ${route}`);
  }
}

const migratedCentralRouteFragments = [
  "/api/playback/request",
  "/api/fennenote/playback",
  "/api/fennenote/reply",
  "/api/message-processing/board",
  "/gateways",
  "/network-options",
  "/reload",
  "/api/scan/message-adapters",
  "/api/scan/agents",
  "/api/agent-adapters/",
  "/api/agent-state",
  "/api/agent/threads",
  "/api/agent/requests",
  "/api/agent/send",
  "/api/agent/copilot-install",
  "/api/agent/copilot-login",
  "/api/agent/copilot-status",
  "/api/agent/astrbot-login-test",
  "/api/deploy-astrbot-adapter",
  "/api/agent/marvis-open",
  "/api/remote-agent/",
  "/meta",
  "/api/gateways",
  "/open-config-file",
  "/manager/start",
  "/manager/desktop-lifecycle/start",
  "/manager/shutdown",
  "/api/message/napcat-"
] as const;

test("plugin-owned Manager APIs have no legacy central dispatch branches", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const handlerStart = central.indexOf("const handleManagerRequest =");
  const handlerEnd = central.indexOf("activeServer.requestTimeout", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const centralDispatch = central.slice(handlerStart, handlerEnd);

  for (const route of migratedCentralRouteFragments) {
    assert.equal(
      centralDispatch.includes(route),
      false,
      `${route} must remain outside the central HTTP dispatch chain`
    );
  }
  assert.doesNotMatch(central, /function forwardFenneNoteRequest\s*\(/);
  assert.doesNotMatch(central, /function forwardPlaybackRequest\s*\(/);
});

test("plugin route modules retain every migrated endpoint family", () => {
  assertSourceRetainsRoutes("src/manager/fenneNoteOutputService.ts", [
    "/api/fennenote/playback",
    "/api/fennenote/reply"
  ]);
  assertSourceRetainsRoutes("src/manager/messageProcessingRoutes.ts", [
    "/api/message-processing/board",
    "/api/message-processing/requirements"
  ]);
  assertSourceRetainsRoutes("src/manager/gatewayControlRoutes.ts", [
    "/gateways",
    "/network-options",
    "/reload",
    "manual-trigger",
    "agent-delivery-test",
    "delivery-replay",
    "weixin-login"
  ]);
  assertSourceRetainsRoutes("src/manager/messageAdapterControl.ts", [
    "/api/scan/message-adapters"
  ]);
  assertSourceRetainsRoutes("src/manager/agentAdapterCatalog.ts", [
    "/api/scan/agents",
    "/api/scan/agents/dsh",
    "/api/agent-adapters/catalog"
  ]);
  assertSourceRetainsRoutes("src/manager/agentThreadControlRoutes.ts", [
    "/api/agent/threads"
  ]);
  assertSourceRetainsRoutes("src/manager/agentCommunicationRoutes.ts", [
    "/api/agent/requests",
    "/api/agent/send",
    "/api/agent/send/traces",
    "receipts"
  ]);
  assertSourceRetainsRoutes("src/manager/agentProviderControlRoutes.ts", [
    "/api/agent/copilot-install",
    "/api/agent/copilot-login",
    "/api/agent/copilot-status",
    "/api/agent/astrbot-login-test",
    "/api/agent/marvis-open"
  ]);
  assertSourceRetainsRoutes("src/manager/remoteAgentRoutes.ts", [
    "/api/remote-agent/devices",
    "/api/remote-agent/scan",
    "/api/remote-agent/connect",
    "/api/remote-agent/disconnect",
    "/api/remote-agent/tasks",
    "/api/remote-agent/task-events"
  ]);
  assertSourceRetainsRoutes("src/manager/diagnosticsRoutes.ts", [
    "/meta",
    "/api/gateways"
  ]);
  assertSourceRetainsRoutes("src/manager/desktopControlRoutes.ts", [
    "/open-config-file"
  ]);
  assert.equal(fs.existsSync(path.join(root, "src/manager/desktopLifecycleRoutes.ts")), false);
  assertSourceRetainsRoutes("src/manager/napcatControlRoutes.ts", [
    "/api/message/napcat-repair-all",
    "/api/message/napcat-ensure-ready",
    "/api/message/napcat-health",
    "/api/message/napcat-configure-onebot",
    "/api/message/napcat-add",
    "/api/message/napcat-launch",
    "/api/message/napcat-restart",
    "/api/message/napcat-remove"
  ]);
});

test("Agent state reporting is registered by the Agent state plugin package", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.agent-state-control/1.0.0/manager.mjs");
  assert.match(plugin, /registerManagerPluginHandlerRoutes\(runtime\.managerPluginRoutes, "manager:agent-state-control"/);
  assert.match(plugin, /handleAgentStateReport\(request, requestUrl\.pathname, response\)/);
  assert.match(source("src/manager/controlPlaneRoutes.ts"), /function handleAgentStateReport[\s\S]*pathname !== "\/api\/agent-state"/);
});

test("Outbox imports the shared FenneNote output implementation", () => {
  const outbox = source("src/outbox.ts");
  assert.match(outbox, /from "\.\/fenneNoteOutput\.js"/);
  assert.doesNotMatch(outbox, /async function postFenneNoteOutput\s*\(/);
});


test("NapCat plugin shutdown uses only launch-owned child processes and recorded PIDs", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.napcat-control/1.0.0/manager.mjs");
  assert.match(plugin, /const activeOperations = new Set/);
  assert.match(plugin, /napcatManagerCtx\(assertAccepting\)/);
  assert.match(plugin, /accepting = false;[\s\S]*requestTracker\.stop\(\)[\s\S]*drainOperations\(\)/);
  assert.match(plugin, /runtime\.removeManagedNapcatInstance\(body\)/);
  // Persisted NapcatLifecycleOwner owns process identity across Manager handovers.
  assert.doesNotMatch(plugin, /rememberLaunchPids|ownedInstances|releaseOwnership|runWindowsTaskkill|process\.kill|stopNapcatInstanceEndpoint\(controlContext/);
});

test("Remote Agent rejects WebSocket work before HTTP request drain", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.remote-agent/1.0.0/manager.mjs");
  assert.match(plugin, /unregisterRoutes\(\);[\s\S]*hub\.stopAccepting\(\);[\s\S]*await requestTracker\.stop\(\);[\s\S]*await hub\.shutdown\(\)/);
});

test("Manager forced shutdown is bounded after the owner teardown flight starts", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const teardownStart = central.indexOf("managerRuntimeOwner.teardown(`signal:${reason}`)");
  const forcedExitStart = central.indexOf("const forcedExit = setTimeout(", teardownStart);
  assert.ok(teardownStart >= 0 && forcedExitStart > teardownStart);
  const forcedExitContract = central.slice(forcedExitStart, forcedExitStart + 500);
  assert.match(forcedExitContract, /\(\) => process\.exit\(1\)/);
  assert.match(
    forcedExitContract,
    /DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS \+ 1_000/
  );
});

test("Manager RuntimeOwner gives the Cordis root sole ownership of shared Fiber disposal", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const rootOwner = central.indexOf('managerRuntimeOwner.register("cordis_root"');
  const pluginOwner = central.indexOf('managerRuntimeOwner.register("manager_plugin_kernel"');
  assert.ok(rootOwner >= 0 && pluginOwner > rootOwner);
  assert.doesNotMatch(central, /managerSharedResourcesRuntime\.unmount\(\)|disposeManagerCordisRuntime/);
});

test("removed compatibility APIs stay absent from their former owners", () => {
  assert.doesNotMatch(source("src/manager/pluginCatalogRoutes.ts"), /\/api\/plugins\/reconcile(?:["/])/);
  assert.doesNotMatch(source("src/manager/agentAdapterCatalog.ts"), /\/api\/agent-adapters\/(?:dsh\/)?availability/);
  assert.doesNotMatch(source("src/manager/fenneNoteOutputService.ts"), /\/api\/playback\/request/);
  assert.doesNotMatch(source("src/manager/agentProviderControlRoutes.ts"), /\/api\/deploy-astrbot-adapter/);
  assert.doesNotMatch(source("src/agentAdapters/astrbotAdapter.ts"), /rabiroute_agent|\/api\/plug\//);
});
