import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.gateway-runtime@1");
        context.services.provide("manager.gateway-runtime@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "command",
                "id": "open-runtime-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "状态目录"
                    },
                    "handlerId": "desktop.open-runtime-directory",
                    "slot": "runtime",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "command",
                "id": "manual-trigger",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "手动触发"
                    },
                    "handlerId": "desktop.manual-trigger",
                    "slot": "runtime",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 60
                }
            }
        ])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const pendingEffects = [];
            const disposers = [];
            const disposeStartedEffects = async () => {
                let firstError;
                for (const dispose of [...disposers].reverse()) {
                    try { await dispose(); } catch (error) { firstError ??= error; }
                }
                if (firstError) throw firstError;
            };
            const ctx = Object.freeze({
                effect(starter, label) {
                    const pending = Promise.resolve().then(starter).then(dispose => {
                        if (typeof dispose !== "function") throw new Error(`Plugin effect did not return a disposer: ${label ?? "effect"}.`);
                        disposers.push(dispose);
                        return dispose;
                    });
                    pendingEffects.push(pending);
                    return pending;
                }
            });
            try {
        ctx.effect(async () => {
            const requestTracker = new runtime.ManagerPluginRequestTracker();
            const unregisterRoutes = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:gateway-runtime", "manager.gateway-runtime.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleGatewayControlApi(request, requestUrl, response, {
                    readJsonBody: runtime.readJsonBody,
                    jsonResponse: runtime.jsonResponse,
                    redirectResponse: (target, statusCode, location) => {
                        target.writeHead(statusCode, { location });
                        target.end();
                    },
                    gatewayPayload: options => runtime.standaloneGatewayPayload(options?.includeDiagnostics ?? true, options?.includeConfigDefinitions ?? (options?.includeDiagnostics ?? true)),
                    writeConfig: runtime.writeConfig,
                    writeGatewayConfig: runtime.writeGatewayConfig,
                    resolveRouteMutation: runtime.resolveRouteMutation,
                    loadRuntimes: runtime.loadRuntimes,
                    syncRunningGateways: runtime.syncRunningGateways,
                    runtimeStatuses: () => [...runtime.runtimes.values()].map(runtime.runtimeStatus),
                    networkOptionsPayload: runtime.networkOptionsPayload,
                    startGateway: runtime.startGateway,
                    stopGateway: runtime.stopGateway,
                    restartGateway: runtime.restartGateway,
                    removeGatewayConfig: runtime.removeGatewayConfig,
                    routeCatalogVersion: runtime.routeCatalogVersion,
                    weixinLoginTarget: id => {
                        // Keep the host service available while inspecting one GatewayRuntime.
                        const gatewayRuntime = runtime.runtimes.get(id);
                        return gatewayRuntime
                            ? {
                                enabled: runtime.sharedGatewayAdapterTypes(gatewayRuntime.definition).includes("weixin"),
                                dataDir: runtime.dataDirFor(gatewayRuntime.definition)
                            }
                            : undefined;
                    },
                    requestWeixinLogin: runtime.requestWeixinLogin,
                    triggerManualRule: (id, request) => runtime.triggerGatewayManualRule(id, request, {}, "manager:gateway-runtime"),
                    testAgentDelivery: runtime.testAgentDelivery,
                    listDeliveryReplayAttempts: runtime.listGatewayDeliveryReplayAttempts,
                    replayDelivery: runtime.replayGatewayDelivery,
                    trackOperation: operation => requestTracker.trackOperation(operation)
                }))
            ], [
                { routeId: "gateways", kind: "exact", path: "/gateways", methods: ["GET", "POST"] },
                { routeId: "gateway-resource", kind: "prefix", pathPrefix: "/gateways/" },
                { routeId: "network-options", kind: "exact", path: "/network-options", methods: ["GET"] },
                { routeId: "reload", kind: "exact", path: "/reload", methods: ["POST"] }
            ]);
            const releaseRuntimeLease = runtime.acquireGatewayRuntimePluginLease();
            try {
                if (runtime.managerServicesReady && !runtime.managerReadOnly)
                    runtime.syncRunningGateways();
            } catch (error) {
                unregisterRoutes();
                await requestTracker.stop();
                if (releaseRuntimeLease()) {
                    await Promise.all([
                        runtime.manualTriggerProcesses.stopOwner("manager:gateway-runtime"),
                        runtime.stopAllGatewaysAndWait()
                    ]);
                }
                throw error;
            }
            return async () => {
                unregisterRoutes();
                await requestTracker.stop();
                if (!releaseRuntimeLease()) return;
                await Promise.all([
                    runtime.manualTriggerProcesses.stopOwner("manager:gateway-runtime"),
                    runtime.stopAllGatewaysAndWait()
                ]);
            };
        }, "activate Manager Gateway runtime plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.gateway-runtime");
    }
}).activate;
