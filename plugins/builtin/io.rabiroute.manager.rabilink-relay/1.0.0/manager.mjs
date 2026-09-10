import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.rabilink-relay@1");
        context.services.provide("manager.rabilink-relay@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const sync = async () => runtime.syncRabiLinkRelayRuntime(() => runtime.syncActiveRabiLinkRelay === sync ? sync() : undefined);
        runtime.syncActiveRabiLinkRelay = sync;
        const video = runtime.createDirectVideoReceiver();
        const peer = runtime.createPeerRuntime();
        const videoRequests = new runtime.ManagerPluginRequestTracker();
        const unregisterVideo = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes,
            "manager:rabilink-relay", "manager.rabilink.video", [videoRequests.wrap(runtime.createDirectVideoRoutes(video))],
            [{ routeId: "rabilink-video", kind: "prefix", pathPrefix: "/api/rabilink/video/" }]);
        const unregisterPeer = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes,
            "manager:rabilink-relay", "manager.rabilink.peer", [videoRequests.wrap(peer.handler)],
            [{ routeId: "rabilink-peer", kind: "prefix", pathPrefix: "/api/rabilink/peer/" }]);
        ctx.effect(() => async () => {
            unregisterVideo();
            unregisterPeer();
            await peer.stop();
            await video.stop();
            await videoRequests.stop();
            if (runtime.syncActiveRabiLinkRelay === sync) {
                runtime.syncActiveRabiLinkRelay = async () => { };
            }
            await Promise.all([
                runtime.personaSyncLanServer.stop(),
                runtime.rabiLinkRelayRuntime.stop()
            ]);
        }, "stop Manager RabiLink Relay plugin");
        if (runtime.managerListenerReady)
            await sync();

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.rabilink-relay");
    }
}).activate;
