import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime, loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/index.js";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";
import { handlePluginCatalogApi } from "./pluginCatalogRoutes.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";
import { renderPluginCatalog } from "./pluginCatalogPresentation.js";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-catalog-"));
  const packageRoot = path.join(root, "packages");
  const packageDirectory = path.join(packageRoot, encodeURIComponent("io.test.catalog"), "1.0.0");
  const profilePath = path.join(root, "profile.json");
  await fs.mkdir(path.join(packageDirectory, "web"), { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2,
    id: "io.test.catalog",
    version: "1.0.0",
    entries: {
      manager: { execution: "in_process", module: "./manager.mjs" },
      web: { execution: "in_process", module: "./web/client.mjs" }
    },
    provides: ["test.catalog@1"],
    requires: [],
    optional: [],
    permissions: []
  }), "utf8");
  await fs.writeFile(path.join(packageDirectory, "manager.mjs"), `
export async function activate(context) {
  context.services.provide("test.catalog@1", Object.freeze({ ready: true }));
  context.contributions.register({ kind: "navigation", id: "test-nav", value: { hosts: ["web"], label: "Test" } });
  context.contributions.register({ kind: "hotkey", id: "test-hotkey", value: { hosts: ["desktop"], label: "Test" } });
}
`, "utf8");
  await fs.writeFile(path.join(packageDirectory, "web", "client.mjs"), "export function activate() { return 'catalog'; }\n", "utf8");
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 2,
    readyRequires: [],
    instances: [{
      id: "manager:test-catalog",
      package: "io.test.catalog",
      version: "1.0.0",
      enabled: true,
      config: {},
      grants: []
    }]
  }), "utf8");
  return { root, packageRoot, packageDirectory, profilePath };
}

async function startCatalogServer() {
  const fixture = await createFixture();
  const catalog = new PluginPackageCatalog([fixture.packageRoot], {
    trustedInProcessRoots: [fixture.packageRoot]
  });
  const runtimeRoot = path.join(fixture.root, "runtime");
  let loaded = await loadPluginProfile({
    profilePath: fixture.profilePath,
    packageCatalog: catalog,
    runtimeRoot,
    host: "manager"
  });
  const runtime = new GenerationRuntime({ host: "manager", grantedPermissions: loaded.grants });
  const modules = new WebPluginModuleRegistry();
  const initial = await runtime.switch(loaded.candidates);
  modules.update(loaded, initial.generation);
  let reconcileCount = 0;

  const reconcile = async () => {
    reconcileCount += 1;
    loaded = await loadPluginProfile({
      profilePath: fixture.profilePath,
      packageCatalog: catalog,
      runtimeRoot,
      host: "manager"
    });
    const result = await runtime.switch(loaded.candidates);
    modules.update(loaded, result.generation);
    return result.generation;
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!handlePluginCatalogApi(request, url, response, {
      runtime,
      renderCatalog: async (input, host) => ({ revision: 0, contract: {}, value: renderPluginCatalog(input, host) }),
      reconciliation: { diagnostics: () => [], reconcile },
      webModules: { list: () => modules.list(), read: (id, rev, relativePath) => modules.read(id, rev, relativePath) }
    })) response.writeHead(404).end();
  });
  const endpoint = await listenManagerEndpoint({
    server,
    host: "127.0.0.1",
    policy: { mode: "auto" }
  });

  return {
    runtime,
    modules,
    reconcileCount: () => reconcileCount,
    baseUrl: endpoint.baseUrl,
    async close() {
      await runtime.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  };
}

test("Plugin Catalog API publishes manifest capabilities and host-filtered contributions", async () => {
  const app = await startCatalogServer();
  try {
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog?host=web`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as {
      data: {
        schemaVersion: number;
        host: string;
        generation: string;
        plugins: Array<{ instanceId: string; status: string; manifest: { hosts: string[]; capabilities: string[] } }>;
        contributions: Array<{ id: string; kind: string; hosts: string[] }>;
      };
    };
    assert.equal(body.data.schemaVersion, 2);
    assert.equal(body.data.host, "web");
    assert.match(body.data.generation, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.data.plugins, [{
      instanceId: "manager:test-catalog",
      pluginId: "io.test.catalog",
      manifest: {
        id: "io.test.catalog",
        version: "1.0.0",
        kind: "package",
        hosts: ["manager", "web"],
        capabilities: ["test.catalog@1"]
      },
      host: "manager",
      scope: "global",
      status: "active",
      missingCapabilities: []
    }]);
    assert.deepEqual(body.data.contributions.map(item => [item.kind, item.id]), [["navigation", "test-nav"]]);
  } finally {
    await app.close();
  }
});

test("Plugin reconciliation API rereads the profile through GenerationRuntime", async () => {
  const app = await startCatalogServer();
  try {
    const current = await fetch(`${app.baseUrl}/api/plugins/reconciliation`);
    assert.equal(current.status, 200);
    const currentBody = await current.json() as { data: { active: string[]; waiting: string[]; failed: string[] } };
    assert.deepEqual(currentBody.data.active, ["manager:test-catalog"]);
    assert.deepEqual(currentBody.data.waiting, []);
    assert.deepEqual(currentBody.data.failed, []);

    const refreshed = await fetch(`${app.baseUrl}/api/plugins/reconciliation`, { method: "POST" });
    assert.equal(refreshed.status, 200);
    assert.equal(app.reconcileCount(), 1);
  } finally {
    await app.close();
  }
});

test("Plugin module API serves immutable revision content", async () => {
  const app = await startCatalogServer();
  try {
    const modulesResponse = await fetch(`${app.baseUrl}/api/plugins/modules`);
    const modulesBody = await modulesResponse.json() as { data: { modules: Array<{ id: string; rev: string; entryPath: string }> } };
    const [module] = modulesBody.data.modules;
    assert.ok(module);
    const response = await fetch(`${app.baseUrl}/api/plugins/modules/${encodeURIComponent(module.id)}/${module.rev}/${module.entryPath}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(await response.text(), /catalog/);
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/modules/${encodeURIComponent(module.id)}/${"b".repeat(64)}/${module.entryPath}`)).status, 404);
  } finally {
    await app.close();
  }
});

test("Plugin Catalog API rejects unsupported hosts and ignores unrelated paths", async () => {
  const app = await startCatalogServer();
  try {
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog?host=gateway`)).status, 400);
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/other`)).status, 404);
  } finally {
    await app.close();
  }
});
