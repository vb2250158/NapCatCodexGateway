import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";
const { GenerationRuntime } = await import("../src/plugin-kernel/generationRuntime.ts");
const { ManagerSourcePatchService } = await import("../src/manager/sourcePatchService.ts");

async function fixture(moduleIds = ["first", "second"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-source-patch-bundle-"));
  const baselineRoot = path.join(root, "baselines");
  const stateRoot = path.join(root, "state");
  const write = async (directory, compiled) => {
    await fs.mkdir(directory, { recursive: true });
    const bytes = JSON.stringify(compiled);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(directory, `${hash}.json`), bytes);
    return hash;
  };
  const modules = [];
  for (const id of moduleIds) {
    const baseline = compileHotPatchModule(`export function read() { return '${id}-old'; }`);
    const candidate = compileHotPatchModule(`export function read() { return '${id}-new'; }`);
    const baselineHash = await write(baselineRoot, baseline);
    const candidateHash = await write(path.join(stateRoot, "candidates"), candidate);
    modules.push({ id, sha256: baselineHash, candidateSha256: candidateHash });
  }
  await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: modules.map(({ id, sha256 }) => ({ id, sha256, contract: {} })) }));
  const runtime = new GenerationRuntime({ host: "manager" });
  const service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime, bundleJournalRoot: path.join(stateRoot, "bundles"), workerTimeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const identity = { applicationGenerationId: runtime.current().applicationGenerationId, managerInstanceId: runtime.current().managerInstanceId, pluginGenerationId: runtime.current().id };
  return { root, service, runtime, modules, identity, async close() { await service.stop(); } };
}

test("formal bundle publication commits every module and reuses its receipt", async () => {
  const app = await fixture();
  try {
    const request = { operationId: "bundle-operation", action: "apply-bundle", entries: app.modules.map(({ id, candidateSha256 }) => ({ moduleId: id, candidateSha256, expectedRevision: 0, contract: {} })), ...app.identity };
    const committed = await app.service.publishBundle(request);
    assert.equal(committed.state, "committed");
    assert.equal(committed.moduleId, "__bundle__");
    assert.equal((await app.service.invoke("first", "read", [])).value, "first-new");
    assert.equal((await app.service.invoke("second", "read", [])).value, "second-new");
    assert.deepEqual(await app.service.publishBundle(request), committed);
  } finally { await app.close(); }
});

test("bundle reconciliation keeps an unchanged worker as not started", async () => {
  const app = await fixture();
  try {
    const request = { operationId: "bundle-reconcile", action: "apply-bundle", entries: app.modules.map(({ id, candidateSha256 }) => ({ moduleId: id, candidateSha256, expectedRevision: 0, contract: {} })), ...app.identity };
    const pending = { operationId: request.operationId, fingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"), moduleId: "__bundle__", state: "pending", commitState: "unknown", createdAt: new Date().toISOString(), proof: { applicationGenerationId: app.identity.applicationGenerationId, managerInstanceId: app.identity.managerInstanceId, before: (await app.service.invoke("first", "read", [])).revision, baselineSha256: app.modules[0].sha256, previous: { sha256: app.modules[0].sha256, contract: {} }, target: { sha256: app.modules[0].candidateSha256, contract: {} }, targetSourceHash: "", bundleModuleIds: app.modules.map(({ id }) => id), bundleEntries: [] } };
    await fs.mkdir(path.join(app.root, "state", "operations"), { recursive: true });
    await fs.writeFile(path.join(app.root, "state", "operations", `${request.operationId}.json`), JSON.stringify(pending));
    const result = await app.service.reconcileBundle({ operationId: request.operationId, action: "reconcile-bundle", ...app.identity });
    assert.equal(result.state, "pending");
  } finally { await app.close(); }
});

test("bundle pointer failure remains fenced until every pointer and receipt are durable", async () => {
  const app = await fixture();
  const writeJson = app.service.writeJson.bind(app.service);
  const pointerPath = path.join(app.root, "state", "active", "second.json");
  app.service.writeJson = async (file, value) => {
    if (file === pointerPath) throw new Error("injected pointer failure");
    return writeJson(file, value);
  };
  try {
    const request = { operationId: "pointer-failure", action: "apply-bundle", entries: app.modules.map(({ id, candidateSha256 }) => ({ moduleId: id, candidateSha256, expectedRevision: 0, contract: {} })), ...app.identity };
    await assert.rejects(app.service.publishBundle(request), /injected pointer failure/);
    const reconcile = { operationId: request.operationId, action: "reconcile-bundle", ...app.identity };
    assert.equal((await app.service.operation(request.operationId)).state, "indeterminate");
    await assert.rejects(app.service.reconcileBundle(reconcile), /injected pointer failure/);
    assert.equal((await app.service.operation(request.operationId)).state, "indeterminate");
    for (const { id, candidateSha256 } of app.modules) await assert.rejects(app.service.publish({ operationId: `blocked-${id}`, action: "apply", moduleId: id, candidateSha256, expectedRevision: 0, ...app.identity }), /reconcil|uncertain|unconfirmed|earlier source patch/i);
    app.service.writeJson = writeJson;
    const recovered = await app.service.reconcileBundle(reconcile);
    assert.equal(recovered.state, "committed");
    for (const module of app.modules) {
      const pointer = JSON.parse(await fs.readFile(path.join(app.root, "state", "active", `${module.id}.json`), "utf8"));
      assert.equal(pointer.active.sha256, module.candidateSha256);
      assert.equal(pointer.previous.sha256, module.sha256);
      assert.equal(pointer.operation.state, "committed");
      assert.equal(pointer.operation.operationId, recovered.operationId);
      assert.equal(pointer.operation.fingerprint, recovered.fingerprint);
      assert.equal((await app.service.invoke(module.id, "read", [])).value, `${module.id}-new`);
    }
    const repeated = await app.service.reconcileBundle(reconcile);
    assert.equal(repeated.state, recovered.state);
    assert.equal(repeated.operationId, recovered.operationId);
  } finally { await app.close(); await fs.rm(app.root, { recursive: true, force: true }); }
});

test("restart restores all bundle fences before admission without waiting for unrelated Workers", async () => {
  const app = await fixture(["first", "second", "healthy"]);
  const writeJson = app.service.writeJson.bind(app.service);
  app.service.writeJson = async (file, value) => {
    if (file === path.join(app.root, "state", "active", "second.json")) throw new Error("injected pointer failure");
    return writeJson(file, value);
  };
  let restarted;
  let release;
  try {
    const request = { operationId: "restart-fence", action: "apply-bundle", entries: app.modules.slice(0, 2).map(({ id, candidateSha256 }) => ({ moduleId: id, candidateSha256, expectedRevision: 0, contract: {} })), ...app.identity };
    await assert.rejects(app.service.publishBundle(request), /injected pointer failure/);
    await app.service.stop();
    const blocked = new Promise(resolve => { release = resolve; });
    class DelayedService extends ManagerSourcePatchService {
      async loadModule(entry) {
        if (entry.id === "second") await blocked;
        return super.loadModule(entry);
      }
    }
    const runtime = new GenerationRuntime({ host: "manager" });
    restarted = new DelayedService({ baselineRoot: path.join(app.root, "baselines"), stateRoot: path.join(app.root, "state"), runtime, workerTimeoutMs: 2000 });
    await assert.rejects(restarted.publish({ operationId: "blocked-restart", action: "apply", moduleId: "first", candidateSha256: app.modules[0].candidateSha256, expectedRevision: 0, ...(() => { const identity = runtime.current(); return { applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId, pluginGenerationId: identity.id }; })() }), /reconcil|uncertain|unconfirmed|earlier source patch/i);
    assert.equal((await restarted.invoke("healthy", "read", [])).value, "healthy-old");
    release();
    assert.equal((await restarted.invoke("second", "read", [])).value, "second-old");
    assert.equal(restarted.status().modules.find(module => module.id === "second").uncertainOperation, request.operationId);
    const generation = runtime.current();
    const result = await restarted.reconcileBundle({ operationId: request.operationId, action: "reconcile-bundle", applicationGenerationId: generation.applicationGenerationId, managerInstanceId: generation.managerInstanceId, pluginGenerationId: generation.id });
    assert.equal(result.state, "indeterminate");
  } finally { release?.(); await restarted?.stop(); await app.close(); await fs.rm(app.root, { recursive: true, force: true }); }
});
