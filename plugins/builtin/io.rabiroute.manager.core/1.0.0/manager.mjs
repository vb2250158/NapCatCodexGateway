import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.core@1");
        context.services.provide("manager.core@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "overview-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "控制台"
                    },
                    "routeId": "route.overview",
                    "rendererId": "builtin.web-page.overview.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "navigation",
                "id": "overview",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "控制台"
                    },
                    "routeId": "route.overview",
                    "icon": "mdi-view-dashboard-outline",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "page",
                "id": "lan-agents-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "远端 Agent"
                    },
                    "routeId": "global.lan-agents",
                    "rendererId": "builtin.web-page.lan-agents.v1",
                    "slot": "global",
                    "hosts": [
                        "web"
                    ],
                    "order": 65
                }
            },
            {
                "kind": "navigation",
                "id": "lan-agents",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "远端 Agent"
                    },
                    "routeId": "global.lan-agents",
                    "icon": "mdi-lan-connect",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 65
                }
            },
            {
                "kind": "page",
                "id": "settings-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "设置"
                    },
                    "routeId": "global.settings",
                    "rendererId": "builtin.web-page.settings.v1",
                    "slot": "global",
                    "hosts": [
                        "web"
                    ],
                    "order": 80
                }
            },
            {
                "kind": "navigation",
                "id": "settings",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "设置"
                    },
                    "routeId": "global.settings",
                    "icon": "mdi-cog-outline",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 80
                }
            },
            {
                "kind": "page",
                "id": "docs-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "使用手册"
                    },
                    "routeId": "global.docs",
                    "rendererId": "builtin.web-page.docs.v1",
                    "slot": "global",
                    "hosts": [
                        "web"
                    ],
                    "order": 90
                }
            },
            {
                "kind": "navigation",
                "id": "docs",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "使用手册"
                    },
                    "routeId": "global.docs",
                    "icon": "mdi-book-open-page-variant-outline",
                    "slot": "footer",
                    "hosts": [
                        "web"
                    ],
                    "order": 90
                }
            },
            {
                "kind": "command",
                "id": "save-page",
                "value": {
                    "surface": "web.commands",
                    "label": {
                        "fallback": "保存"
                    },
                    "handlerId": "web.save-page",
                    "requiredCapabilities": [
                        "web.command"
                    ],
                    "icon": "mdi-content-save",
                    "slot": "topbar-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 90
                }
            },
            {
                "kind": "theme",
                "id": "system-theme",
                "value": {
                    "surface": "shared.themes",
                    "label": {
                        "fallback": "跟随系统"
                    },
                    "themeId": "system",
                    "webResourceId": "builtin.web-theme.system.v1",
                    "desktopResourceId": "builtin.desktop-theme.system.v1",
                    "slot": "interface",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "theme",
                "id": "light-theme",
                "value": {
                    "surface": "shared.themes",
                    "label": {
                        "fallback": "浅色"
                    },
                    "themeId": "light",
                    "webResourceId": "builtin.web-theme.light.v1",
                    "desktopResourceId": "builtin.desktop-theme.light.v1",
                    "slot": "interface",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "theme",
                "id": "dark-theme",
                "value": {
                    "surface": "shared.themes",
                    "label": {
                        "fallback": "深色"
                    },
                    "themeId": "dark",
                    "webResourceId": "builtin.web-theme.dark.v1",
                    "desktopResourceId": "builtin.desktop-theme.dark.v1",
                    "slot": "interface",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 30
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
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:core", "manager.core.api", [
                requestTracker.wrap((request, requestUrl, response) => (runtime.handleWebguiLanAccessApi(request, requestUrl, response)
                    || runtime.handleLanAgentApi(request, requestUrl, response, {
                        readJsonBody: runtime.readJsonBody,
                        jsonResponse: runtime.jsonResponse,
                        registry: runtime.lanAgentRegistry,
                          releases: runtime.lanAgentReleaseStore,
                          localAgents: runtime.localInstanceAgents,
                          handleInstanceHook: runtime.handleInstanceHook,
                          manageLocalAgent: runtime.manageLocalAgent,
                        isManagementRequestAuthorized: (candidate) => {
                            const config = runtime.rabiGlobalConfig.read().webguiLan;
                            const header = candidate.headers["x-rabiroute-webgui-token"];
                            const bearer = String(candidate.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
                              const address = String(candidate.socket.remoteAddress || "").replace(/^::ffff:/, "");
                              const local = address === "127.0.0.1" || address === "::1";
                              const pathname = new URL(candidate.url || "/", "http://localhost").pathname;
                              if (local && !config.enabled && (pathname === "/api/lan-agent/instances" || pathname.startsWith(`/api/lan-agent/instances/${runtime.lanAgentRegistry.localInstanceId}/agents/`))) return true;
                              return (config.enabled || local) && runtime.webguiTokenMatches(bearer || (typeof header === "string" ? header : ""), config.accessToken);
                        },
                        isReleaseRequestAuthorized: candidate => {
                            const config = runtime.rabiGlobalConfig.read().webguiLan;
                            const authorization = Array.isArray(candidate.headers.authorization)
                                ? candidate.headers.authorization[0] ?? ""
                                : candidate.headers.authorization ?? "";
                            const match = authorization.match(/^Bearer\s+(.+)$/i);
                            return config.enabled && runtime.webguiTokenMatches(match?.[1]?.trim() ?? "", config.accessToken);
                        }
                    })))
            ], [
                { routeId: "webgui-access", kind: "exact", path: "/api/webgui-access", methods: ["*"] },
                { routeId: "lan-agent", kind: "prefix", pathPrefix: "/api/lan-agent/", methods: ["*"] }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
            };
        }, "activate Manager core recovery routes");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.core");
    }
}).activate;
