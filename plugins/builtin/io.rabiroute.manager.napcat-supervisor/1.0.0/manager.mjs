import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.napcat-supervisor@1");
        context.services.provide("manager.napcat-supervisor@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        if (runtime.managerReadOnly || !runtime.managerShouldAutostart)
            return () => { };
        const supervisor = new runtime.NapcatSupervisorService({
            run: async (signal) => {
                if (runtime.activeNapcatControlContext) {
                    await runtime.autoLoginNapcatInstancesOnRabiStart(runtime.activeNapcatControlContext, undefined, signal);
                }
            },
            onError: error => console.warn(`NapCat startup auto login failed: ${error instanceof Error ? error.message : String(error)}`)
        });
        const start = () => {
            if (!runtime.routeCatalogReady) return;
            void supervisor.start();
        };
        const stop = async () => { await supervisor.stop(); };
        runtime.startActiveNapcatSupervisor = start;
        runtime.stopActiveNapcatSupervisor = stop;
        ctx.effect(() => async () => {
            if (runtime.startActiveNapcatSupervisor === start)
                runtime.startActiveNapcatSupervisor = () => { };
            if (runtime.stopActiveNapcatSupervisor === stop)
                runtime.stopActiveNapcatSupervisor = async () => { };
            await stop();
        }, "stop Manager NapCat supervisor plugin");
        if (runtime.managerListenerReady)
            start();

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.napcat-supervisor");
    }
}).activate;
