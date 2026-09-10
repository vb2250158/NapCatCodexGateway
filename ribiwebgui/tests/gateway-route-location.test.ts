import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { routeKeyFromWebguiHash } from "../src/routeScopedNavigation";

const location = { pathname: "/", hash: "", href: "http://localhost/" };
Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
const { useGatewayStore } = await import("../src/stores/gatewayStore");
const { createDefaultGateway } = await import("../src/utils/gatewayHelpers");

function fixtures() {
  return [
    { ...createDefaultGateway(1), id: "first-id", configName: "first", agentRoleId: "FirstPersona" },
    { ...createDefaultGateway(2), id: "second-id", configName: "second", agentRoleId: "SecondPersona" }
  ];
}
function newStore(hash: string) {
  location.hash = hash;
  setActivePinia(createPinia());
  return useGatewayStore();
}
function serveGateways(configResponse?: Promise<Response>) {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "/meta") return Response.json({ applicationGenerationId: "generation", managerInstanceId: "manager" });
    if (url.includes("includeConfig=1")) return configResponse ?? Response.json({ code: 0, data: { config: { gateways: fixtures() }, manager: fixtures() } });
    if (url.includes("/gateways?summary=1")) return Response.json({ code: 0, data: { manager: fixtures() } });
    if (url === "/network-options") return Response.json({ code: 0, data: {} });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

test("lazy recovery retains the bookmarked Route including encoded names and query parameters", () => {
  for (const page of ["knowledge", "adapters", "persona", "persona/document", "persona/sync", "overview", "speech", "runtime"]) {
    const target = `/routes/${encodeURIComponent("测试 路线")}/${page}?view=archived`;
    assert.equal(routeKeyFromWebguiHash(`#${target}`), "测试 路线");
    assert.equal(routeKeyFromWebguiHash(`#/plugin-recovery?from=${encodeURIComponent(target)}`), "测试 路线");
  }
  assert.equal(routeKeyFromWebguiHash("#/plugin-recovery?from=https%3A%2F%2Fexample.com"), "");
});

test("cold summary then full-config loading never selects the first persona for a bookmarked second Route", async () => {
  const target = "/routes/second/knowledge";
  const store = newStore(`#/plugin-recovery?from=${encodeURIComponent(target)}`);
  serveGateways();
  await store.loadRouteSummaries();
  assert.equal(store.selectedGateway, null);
  assert.equal(store.selectedRouteSummary?.id, "second-id");
  await store.load();
  assert.equal(store.error, "");
  assert.equal(store.selectedGatewayId, "second-id");
  assert.equal(store.selectedGateway?.agentRoleId, "SecondPersona");
  location.hash = `#${target}`;
  store.syncRouteSelection();
  assert.equal(store.selectedGatewayId, "second-id");
});

test("a slow startup response follows the latest URL rather than its original target", async () => {
  const store = newStore("#/routes/first/persona");
  let resolveConfig!: (value: Response) => void;
  const config = new Promise<Response>(resolve => { resolveConfig = resolve; });
  serveGateways(config);
  const loading = store.load();
  location.hash = "#/routes/second/persona";
  store.syncRouteSelection();
  resolveConfig(Response.json({ code: 0, data: { config: { gateways: fixtures() }, manager: fixtures() } }));
  await loading;
  assert.equal(store.selectedGatewayId, "second-id");
});

test("history navigation updates selected config and summary without overwriting unsaved drafts", async () => {
  const store = newStore("#/routes/second/knowledge");
  serveGateways();
  await store.load();
  store.gateways[1]!.name = "unsaved draft";
  for (const key of ["first", "second", "first", "second"]) {
    store.syncRouteSelection(`#/routes/${key}/knowledge`);
    assert.equal(store.selectedGateway?.configName, key);
    assert.equal(store.selectedRouteSummary?.configName, key);
  }
  assert.equal(store.gateways[1]!.name, "unsaved draft");
  assert.equal(store.dirty, true);
});

test("unknown explicit URLs stay unresolved; only unscoped visits may default to the first Route", async () => {
  const store = newStore("#/routes/missing/knowledge");
  serveGateways();
  await store.load();
  assert.equal(store.selectedGatewayId, "");
  assert.equal(store.selectedGateway, null);
  assert.equal(store.selectedRouteSummary, null);
  assert.equal(store.routeSelectionMissing, true);
  store.syncRouteSelection("#/overview");
  assert.equal(store.selectedGatewayId, "first-id");
  assert.equal(store.routeSelectionMissing, false);
});

test("App owns URL selection; startup and page watchers cannot overwrite explicit links", () => {
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(app, /watch\(\(\) => route.fullPath, path => store.syncRouteSelection/);
  assert.match(app, /selectedRouteKey.value && !routeKeyFromWebguiHash/);
  assert.match(app, /router.push\(\{ path: scopedPath, query: route.query, hash: route.hash \}\)/);
  assert.match(main, /await router.isReady\(\);\s*app.mount/);
  for (const page of ["RouteConfigPage", "PersonaTemplatePage", "PersonaSyncPage"]) {
    const source = fs.readFileSync(new URL(`../src/pages/${page}.vue`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /watch\(\(\) => store.selectedGatewayId/);
    assert.doesNotMatch(source, /store.selectGateway\(/);
  }
});
