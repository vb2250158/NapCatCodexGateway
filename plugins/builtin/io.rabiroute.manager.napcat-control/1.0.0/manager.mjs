import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.napcat-control@1");
        context.services.provide("manager.napcat-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [])
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
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        let accepting = true;
        const activeOperations = new Set();
        const assertAccepting = () => {
            if (!accepting)
                throw new Error("NapCat control plugin is stopping.");
        };
        const runOperation = (action) => {
            const operation = Promise.resolve().then(() => {
                assertAccepting();
                return action();
            });
            activeOperations.add(operation);
            void operation.then(() => activeOperations.delete(operation), () => activeOperations.delete(operation));
            return operation;
        };
        const drainOperations = async () => {
            while (activeOperations.size > 0) {
                await Promise.allSettled([...activeOperations]);
            }
        };
        const controlContext = runtime.napcatManagerCtx(assertAccepting);
        runtime.activeNapcatControlContext = controlContext;
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:napcat-control", "manager.napcat-control.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleNapcatControlApi(request, requestUrl, response, {
                    readJsonBody: runtime.readJsonBody,
                    jsonResponse: runtime.jsonResponse,
                    repairAll: () => runOperation(runtime.repairAllNapcatInstances),
                    ensureReady: body => runOperation(() => runtime.ensureNapcatInstanceReady(controlContext, body)),
                    health: body => runOperation(() => runtime.checkNapcatHealthWithBackfill(body)),
                    loginPanel: body => runOperation(() => runtime.readNapcatLoginPanel(controlContext, body)),
                    loginAction: body => runOperation(() => runtime.runNapcatLoginAction(controlContext, body)),
                    configureOneBot: body => runOperation(() => runtime.configureNapcatOneBot(controlContext, body)),
                    add: body => runOperation(() => runtime.addManagedNapcatInstance(body, controlContext)),
                    launch: body => runOperation(() => runtime.launchNapcatInstanceEndpoint(controlContext, body)),
                    restart: body => runOperation(() => runtime.restartNapcatInstanceEndpoint(controlContext, body)),
                    remove: body => runOperation(async () => {
                        const result = await runtime.removeManagedNapcatInstance(body);
                        return result;
                    })
                }))
            ], [
                { routeId: "repair-all", kind: "exact", path: "/api/message/napcat-repair-all", methods: ["POST"] },
                { routeId: "ensure-ready", kind: "exact", path: "/api/message/napcat-ensure-ready", methods: ["POST"] },
                { routeId: "health", kind: "exact", path: "/api/message/napcat-health", methods: ["POST"] },
                { routeId: "login-panel", kind: "exact", path: "/api/message/napcat-login-panel", methods: ["POST"] },
                { routeId: "login-action", kind: "exact", path: "/api/message/napcat-login-action", methods: ["POST"] },
                { routeId: "configure-onebot", kind: "exact", path: "/api/message/napcat-configure-onebot", methods: ["POST"] },
                { routeId: "add", kind: "exact", path: "/api/message/napcat-add", methods: ["POST"] },
                { routeId: "launch", kind: "exact", path: "/api/message/napcat-launch", methods: ["POST"] },
                { routeId: "restart", kind: "exact", path: "/api/message/napcat-restart", methods: ["POST"] },
                { routeId: "remove", kind: "exact", path: "/api/message/napcat-remove", methods: ["POST"] }
            ]);
            if (runtime.managerListenerReady)
                runtime.startActiveNapcatSupervisor();
            return async () => {
                unregister();
                accepting = false;
                await Promise.all([
                    requestTracker.stop(),
                    runtime.stopActiveNapcatSupervisor()
                ]);
                await drainOperations();
                // Bound processes survive Manager handover; the persisted owner reconciles
                // them with the next committed Route snapshot before admitting commands.
                if (runtime.activeNapcatControlContext === controlContext)
                    runtime.activeNapcatControlContext = undefined;
            };
        }, "activate Manager NapCat control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.napcat-control");
    }
}).activate;
