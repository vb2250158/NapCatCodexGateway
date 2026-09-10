import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";

const built = process.env.RABIROUTE_HOT_PATCH_TEST_BUILT === "1";
const implementation = module => new URL(`../${built ? "dist" : "src"}/${module}.${built ? "js" : "ts"}`, import.meta.url);
const [{ GenerationRuntime }, { ManagerSourcePatchService }, { handleSourcePatchApi }, { handlePluginCatalogApi }] = await Promise.all([
  import(implementation("plugin-kernel/generationRuntime")), import(implementation("manager/sourcePatchService")),
  import(implementation("manager/sourcePatchRoutes")), import(implementation("manager/pluginCatalogRoutes"))
]);

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-source-patch-api-"));
  const baselineRoot = path.join(root, "baselines");
  const stateRoot = path.join(root, "state");
  const store = async (directory, compiled) => {
    const bytes = JSON.stringify(compiled);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${hash}.json`), bytes);
    return hash;
  };
  const source = await fs.readFile(new URL("../src/manager/pluginCatalogPresentation.ts", import.meta.url), "utf8");
  const sourcePath = fileURLToPath(new URL("../src/manager/pluginCatalogPresentation.ts", import.meta.url));
  const baseline = compileHotPatchModule(source, sourcePath);
  const baselineHash = await store(baselineRoot, baseline);
  await store(path.join(stateRoot, "candidates"), baseline);
  const candidateHash = await store(path.join(stateRoot, "candidates"), compileHotPatchModule(source.replace('host || "all"', 'host || "patched"'), sourcePath));
  const broken = options.brokenModule === "initialization" ? { ...baseline, initializationSource: "for (;;) {}" }
    : { ...baseline, schemaVersion: 99 };
  const brokenHash = options.brokenModule ? await store(baselineRoot, broken) : undefined;
  await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [
    ...(brokenHash ? [{ id: "broken", sha256: brokenHash, contract: {} }] : []),
    { id: "manager.plugin-catalog", sha256: baselineHash, contract: { responseSchema: 2, label: "original" } }
  ] }));
  const runtime = new GenerationRuntime({ host: "manager" });
  const makeService = () => new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime, workerTimeoutMs: 2000 });
  let service = makeService();
  const identity = { applicationGenerationId: runtime.current().applicationGenerationId, controlToken: randomUUID() };
  const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") { json(response, 200, { healthy: true }); return; }
    if (handleSourcePatchApi(request, url, response, { service, identity, json, readJson: async (request, maximumBytes) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > maximumBytes) throw new Error("Body too large"); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } })) return;
    if (handlePluginCatalogApi(request, url, response, { runtime,
      renderCatalog: (input, host) => service.invoke("manager.plugin-catalog", "renderPluginCatalog", [input, host]) })) return;
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = () => ({ operationId: randomUUID(), action: "apply", moduleId: "manager.plugin-catalog", candidateSha256: candidateHash,
    expectedRevision: 0, applicationGenerationId: runtime.current().applicationGenerationId,
    managerInstanceId: runtime.current().managerInstanceId, pluginGenerationId: runtime.current().id, contract: { responseSchema: 2, label: "updated" } });
  const publish = (body, token = identity.controlToken, suffix = "") => fetch(`${baseUrl}/_rabiroute/host/source-patches${suffix}`, {
    method: "POST", headers: { "content-type": "application/json", "x-rabiroute-host-token": token }, body: JSON.stringify(body)
  });
  return { root, stateRoot, baselineRoot, baseline, baselineHash, runtime, baseUrl, request, publish, store,
    reconcile: body => publish(body, identity.controlToken, "/reconcile"),
    service: () => service,
    async restart() { await service.stop(); service = makeService(); },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await service.stop(); await runtime.dispose();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("rabi-source-patch-api-"));
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test("clean baseline upgrade archives history and survives restart and package rollback", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 200);
    assert.equal((await app.publish(app.request())).status, 200);
    const request = { ...app.request(), action: "rollback", expectedRevision: 1 };
    assert.equal((await app.publish(request)).status, 200);
    const pointerPath = path.join(app.stateRoot, "active/manager.plugin-catalog.json");
    const pointer = await fs.readFile(pointerPath, "utf8");
    const receiptPath = path.join(app.stateRoot, "operations", `${request.operationId}.json`);
    const receipt = await fs.readFile(receiptPath, "utf8");
    const catalogPath = path.join(app.baselineRoot, "catalog.json");
    const originalCatalog = await fs.readFile(catalogPath, "utf8");
    const catalog = JSON.parse(originalCatalog);
    const next = { ...app.baseline, sourceHash: createHash("sha256").update("new package source").digest("hex") };
    catalog.modules[0].sha256 = await app.store(app.baselineRoot, next);
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    await app.restart();
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 200);
    assert.equal(JSON.parse(await fs.readFile(pointerPath, "utf8")).baselineSha256, catalog.modules[0].sha256);
    const archivePath = path.join(app.stateRoot, "baseline-history/manager.plugin-catalog", `${createHash("sha256").update(pointer).digest("hex")}.json`);
    assert.equal(await fs.readFile(archivePath, "utf8"), pointer);
    assert.equal(await fs.readFile(receiptPath, "utf8"), receipt);
    await app.restart();
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 200);
    await fs.writeFile(catalogPath, originalCatalog);
    await app.restart();
    assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 200);
    assert.equal(JSON.parse(await fs.readFile(pointerPath, "utf8")).baselineSha256, app.baselineHash);
    assert.equal(await fs.readFile(receiptPath, "utf8"), receipt);
  } finally { await app.close(); }
});

for (const conflict of ["override", "pending", "uncertain", "contract", "invalid-baseline", "archive-failure"]) {
  test(`baseline upgrade preserves old state when ${conflict} blocks migration`, async () => {
    const app = await fixture();
    const rename = fs.rename;
    try {
      assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 200);
      const request = app.request();
      assert.equal((await app.publish(request)).status, 200);
      if (conflict !== "override") assert.equal((await app.publish({ ...app.request(), action: "rollback", expectedRevision: 1 })).status, 200);
      const pointerPath = path.join(app.stateRoot, "active/manager.plugin-catalog.json");
      const pointer = await fs.readFile(pointerPath, "utf8");
      if (conflict === "pending") {
        await fs.mkdir(path.join(app.stateRoot, "pending"), { recursive: true });
        await fs.writeFile(path.join(app.stateRoot, "pending/manager.plugin-catalog.json"), JSON.stringify({ operationId: "unknown" }));
      }
      if (conflict === "uncertain") await fs.writeFile(path.join(app.stateRoot, "operations/unknown.json"), JSON.stringify({ operationId: "unknown", moduleId: "manager.plugin-catalog", state: "indeterminate", commitState: "unknown" }));
      const catalogPath = path.join(app.baselineRoot, "catalog.json");
      const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
      const compiled = { ...app.baseline, sourceHash: "a".repeat(64), ...(conflict === "invalid-baseline" ? { schemaVersion: 99 } : {}) };
      catalog.modules[0].sha256 = await app.store(app.baselineRoot, compiled);
      if (conflict === "contract") catalog.modules[0].contract = { changed: true };
      await fs.writeFile(catalogPath, JSON.stringify(catalog));
      if (conflict === "archive-failure") fs.rename = async (source, target) => {
        if (String(target).includes("baseline-history")) throw new Error("archive unavailable");
        return rename(source, target);
      };
      await app.restart();
      assert.equal((await fetch(`${app.baseUrl}/api/plugins/catalog`)).status, 503);
      assert.equal(await fs.readFile(pointerPath, "utf8"), pointer);
      assert.equal(app.service().status().modules[0].state, "failed");
      assert.ok(app.service().status().modules[0].error);
    } finally { fs.rename = rename; await app.close(); }
  });
}

test("formal catalog route applies a hashed source candidate through Host authority, retains receipts and rolls back", async () => {
  const app = await fixture();
  try {
    const get = async () => {
      const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
      assert.equal(response.status, 200);
      return { revision: response.headers.get("x-rabiroute-source-revision"), body: await response.json() };
    };
    assert.equal((await get()).body.data.host, "all");
    const pid = app.service().status().modules[0].active.pid;
    const request = app.request();
    assert.equal((await app.publish(request, "wrong")).status, 403);
    assert.equal((await app.publish({ ...request, managerInstanceId: "old-instance" })).status, 409);
    assert.equal((await app.publish({ ...request, candidateSha256: "../outside" })).status, 400);
    const applied = await app.publish(request);
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).data.commitState, "committed");
    const results = await Promise.all(Array.from({ length: 12 }, get));
    assert.ok(results.every(result => result.body.data.host === "patched" && result.revision === "1"));
    assert.equal(app.service().status().modules[0].active.pid, pid);
    assert.equal(app.service().status().modules[0].active.snapshot.contract.label, "updated");
    assert.equal((await app.publish(request)).status, 200);
    assert.equal((await get()).revision, "1");
    assert.equal((await app.publish({ ...request, contract: {} })).status, 409);
    const record = await fetch(`${app.baseUrl}/api/source-patches/operations/${request.operationId}`).then(response => response.json());
    assert.equal(record.data.state, "committed");
    await app.restart();
    assert.equal((await get()).body.data.host, "patched");
    const rollback = { ...app.request(), action: "rollback" };
    delete rollback.candidateSha256;
    assert.equal((await app.publish(rollback)).status, 200);
    assert.equal((await get()).body.data.host, "all");
    assert.equal(app.service().status().modules[0].active.snapshot.contract.label, "original");
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
  } finally { await app.close(); }
});

test("the formal interface publishes and rolls back documentation without changing source", async () => {
  const app = await fixture();
  try {
    const request = { ...app.request(), candidateSha256: app.baselineHash, contract: { responseSchema: 2, label: "clarified" } };
    const published = await app.publish(request);
    assert.equal(published.status, 200, JSON.stringify(await published.json()));
    const catalog = await fetch(`${app.baseUrl}/api/plugins/catalog`);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get("x-rabiroute-source-revision"), "1");
    assert.equal((await catalog.json()).data.host, "all");
    assert.equal(app.service().status().modules[0].active.snapshot.contract.label, "clarified");
    const rollback = await app.publish({ ...app.request(), action: "rollback", expectedRevision: 1 });
    assert.equal(rollback.status, 200, JSON.stringify(await rollback.json()));
    assert.equal(app.service().status().modules[0].active.snapshot.contract.label, "original");
  } finally { await app.close(); }
});

test("a failed module does not prevent an independent catalog module from serving requests", async () => {
  const app = await fixture({ brokenModule: true });
  try {
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.host, "all");
    assert.equal(app.service().status().state, "degraded");
    assert.equal(app.service().status().modules.find(module => module.id === "broken").state, "failed");
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
  } finally { await app.close(); }
});

test("a stuck module initializer does not block healthy module admission or cached control status", async () => {
  const app = await fixture({ brokenModule: "initialization" });
  try {
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
    assert.equal(response.status, 200);
    const status = await fetch(`${app.baseUrl}/api/source-patches`).then(response => response.json());
    assert.equal(status.data.modules.find(module => module.id === "manager.plugin-catalog").state, "ready");
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
  } finally { await app.close(); }
});

test("rejected candidates preserve the original route and pending receipts are not replayed", async () => {
  const app = await fixture();
  try {
    const invalid = { ...app.baseline, implementations: { ...app.baseline.implementations, renderPluginCatalog: "invalid(" } };
    const hash = await app.store(path.join(app.stateRoot, "candidates"), invalid);
    const request = { ...app.request(), candidateSha256: hash };
    const rejected = await app.publish(request);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).data.commitState, "not_started");
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog`).then(response => response.json());
    assert.equal(response.data.host, "all");
    assert.equal(app.service().status().modules[0].uncertainOperation, undefined);
    const pending = app.request();
    await fs.writeFile(path.join(app.stateRoot, "operations", `${pending.operationId}.json`), JSON.stringify({
      operationId: pending.operationId, moduleId: pending.moduleId, fingerprint: createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
      state: "pending", commitState: "unknown", createdAt: new Date().toISOString()
    }));
    assert.equal((await app.publish(pending)).status, 202);
    assert.equal(app.service().status().modules[0].active.snapshot.revision, 0);
  } finally { await app.close(); }
});

for (const failure of ["active", "operations", "pending"]) {
  test(`precise reconciliation recovers a ${failure} persistence failure without replaying source`, async () => {
    const app = await fixture();
    const rename = fs.rename;
    let injected = false;
    try {
      const request = app.request();
      const failedTarget = path.join(app.stateRoot, failure, `${failure === "operations" ? request.operationId : request.moduleId}.json`);
      fs.rename = async (source, target) => {
        if (!injected && target === failedTarget) {
          injected = true;
          throw Object.assign(new Error("Injected persistence failure"), { code: "EIO" });
        }
        return rename(source, target);
      };
      const uncertain = await app.publish(request);
      assert.ok((failure === "pending" ? [409] : [202, 503]).includes(uncertain.status));
      assert.equal(injected, true);
      fs.rename = rename;
      assert.equal((await app.publish({ ...app.request(), expectedRevision: 1 })).status, 409);
      if (failure === "operations") await app.restart();
      const recovered = await app.reconcile(request);
      const recoveredBody = await recovered.json();
      assert.equal(recovered.status, failure === "pending" ? 409 : 200, JSON.stringify(recoveredBody));
      const record = recoveredBody.data;
      assert.equal(record.operationId, request.operationId);
      assert.equal(record.commitState, failure === "pending" ? "not_started" : "committed");
      const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-rabiroute-source-revision"), failure === "active" ? "1" : "0");
      assert.equal((await response.json()).data.host, failure === "pending" ? "all" : "patched");
      assert.equal(app.service().status().modules[0].uncertainOperation, undefined);
      assert.equal((await app.reconcile(request)).status, recovered.status);
    } finally { fs.rename = rename; await app.close(); }
  });
}

test("a durable admission latch blocks publication after a journal failure and restart", async () => {
  const app = await fixture();
  const open = fs.open;
  const rename = fs.rename;
  try {
    const request = app.request();
    const receiptPath = path.join(app.stateRoot, "operations", `${request.operationId}.json`);
    fs.open = async (filename, ...arguments_) => {
      if (filename === receiptPath) throw Object.assign(new Error("Journal unavailable"), { code: "EIO" });
      return open(filename, ...arguments_);
    };
    fs.rename = async (source, target) => {
      if (target === receiptPath) throw Object.assign(new Error("Journal unavailable"), { code: "EIO" });
      return rename(source, target);
    };
    assert.equal((await app.publish(request)).status, 503);
    fs.open = open;
    fs.rename = rename;
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.stateRoot, "pending", `${request.moduleId}.json`))), { operationId: request.operationId });
    await app.restart();
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.host, "all");
    assert.equal((await app.publish(app.request())).status, 409);
    assert.equal(app.service().status().modules[0].uncertainOperation, request.operationId);
    assert.equal((await app.reconcile(request)).status, 404);
  } finally { fs.open = open; fs.rename = rename; await app.close(); }
});

test("reconciliation waits for the target module recovery reader before replacing its receipt", async () => {
  const app = await fixture();
  const rename = fs.rename;
  const readFile = fs.readFile;
  let releaseReader;
  const readerGate = new Promise(resolve => { releaseReader = resolve; });
  let readerEntered;
  const entered = new Promise(resolve => { readerEntered = resolve; });
  try {
    const request = app.request();
    const receiptPath = path.join(app.stateRoot, "operations", `${request.operationId}.json`);
    let injected = false;
    fs.rename = async (source, target) => {
      if (!injected && target === receiptPath) { injected = true; throw Object.assign(new Error("Receipt write unavailable"), { code: "EIO" }); }
      return rename(source, target);
    };
    assert.equal((await app.publish(request)).status, 503);
    assert.equal(injected, true);
    fs.rename = rename;
    let reading = false;
    fs.readFile = async (filename, ...arguments_) => {
      if (!reading && filename === receiptPath) {
        reading = true;
        readerEntered();
        await readerGate;
      }
      return readFile(filename, ...arguments_);
    };
    await app.restart();
    await entered;
    let settled = false;
    const recovery = app.reconcile(request).then(response => { settled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
    releaseReader();
    const response = await recovery;
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(app.service().status().modules[0].uncertainOperation, undefined);
  } finally { releaseReader(); fs.rename = rename; fs.readFile = readFile; await app.close(); }
});

test("a restarted worker without durable commit proof cannot manufacture a successful receipt", async () => {
  const app = await fixture();
  const rename = fs.rename;
  let injected = false;
  try {
    const request = app.request();
    const targetPath = path.join(app.stateRoot, "active", `${request.moduleId}.json`);
    fs.rename = async (source, target) => {
      if (!injected && target === targetPath) { injected = true; throw Object.assign(new Error("Injected pointer failure"), { code: "EIO" }); }
      return rename(source, target);
    };
    assert.equal((await app.publish(request)).status, 202);
    fs.rename = rename;
    await app.restart();
    const recovered = await app.reconcile(request);
    assert.equal(recovered.status, 202);
    assert.equal((await recovered.json()).data.commitState, "unknown");
    assert.equal(app.service().status().modules[0].uncertainOperation, request.operationId);
    assert.equal((await app.publish(app.request())).status, 409);
  } finally { fs.rename = rename; await app.close(); }
});
