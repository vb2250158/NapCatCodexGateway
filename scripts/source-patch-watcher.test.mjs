import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHotPatchCandidate } from "./compile-hot-patch.mjs";
const built = process.env.RABIROUTE_HOT_PATCH_TEST_BUILT === "1";
const packageRoot = process.env.RABIROUTE_HOT_PATCH_TEST_PACKAGE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const implementation = name => pathToFileURL(path.join(packageRoot, built ? "dist" : "src", `${name}.${built ? "js" : "ts"}`));
const { SourcePatchWatcher } = await import(implementation("manager/sourcePatchWatcher"));
const { SourcePatchCompiler } = await import(implementation("manager/sourcePatchCompiler"));
const { ManagerSourcePatchService, createSourcePatchHostService } = await import(implementation("manager/sourcePatchService"));
const { GenerationRuntime } = await import(implementation("plugin-kernel/generationRuntime"));
const { HotPatchResourceStore } = await import(implementation("plugin-kernel/hotPatchResourceStore"));

async function until(predicate, failure) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, failure());
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

test("external source watcher commits repeated code and resource versions without reusing old receipts", { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-watcher-service-"));
  const sourceRoot = path.join(root, "source");
  const sourceDirectory = path.join(sourceRoot, "source-patches");
  const sourcePath = path.join(sourceDirectory, "module.ts");
  const resourcePath = path.join(sourceDirectory, "value.txt");
  const baselineRoot = path.join(root, "baselines");
  const stateRoot = path.join(root, "state");
  const runtime = new GenerationRuntime({ host: "manager" });
  const committed = [];
  const errors = [];
  const moduleSource = value => `declare const __rabiResources: { text(path: string): string };\nlet count = 0;\nexport function read() { return { value: ${JSON.stringify(value)}, resource: __rabiResources.text("source-patches/value.txt"), count: ++count }; }\n`;
  let watcher;
  let service;
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(sourcePath, moduleSource("initial"));
    await fs.writeFile(resourcePath, "one");
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [
      { id: "watched", source: "source-patches/module.ts", resources: ["source-patches/value.txt"] }
    ] }));
    const resources = await HotPatchResourceStore.capture(sourceRoot, ["source-patches/value.txt"]);
    const baseline = await buildHotPatchCandidate({ sourcePath, outputDirectory: baselineRoot, resourceData: resources.data });
    await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [
      { id: "watched", sha256: baseline.sha256, contract: { resources: resources.hashes } }
    ] }));
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime, workerTimeoutMs: 10000,
      audit: (_event, fields) => { if (fields.state === "committed") committed.push(fields.operationId); } });
    const initial = await service.invoke("watched", "read", []);
    assert.equal(initial.value.count, 1);
    const workerPid = service.status().modules[0].active.pid;
    watcher = await SourcePatchWatcher.start({ root: packageRoot, sourceRoot, service, runtime,
      outputDirectory: path.join(stateRoot, "candidates"), onError: error => errors.push(error.message) });
    assert.ok(watcher);
    for (const [index, value] of ["second", "third", "second"].entries()) {
      await fs.writeFile(sourcePath, moduleSource(value));
      await until(() => committed.length >= index + 1, () => `Missing code revision ${index + 1}: ${errors.join("; ")}`);
      const result = await service.invoke("watched", "read", []);
      assert.equal(result.value.value, value);
      assert.equal(result.value.count, index + 2);
      assert.equal(result.value.resource, "one");
    }
    for (const [index, value] of ["two", "one"].entries()) {
      await fs.writeFile(resourcePath, value);
      await until(() => committed.length >= index + 4, () => `Missing resource revision ${index + 4}: ${errors.join("; ")}`);
      const result = await service.invoke("watched", "read", []);
      assert.equal(result.value.resource, value);
      assert.equal(result.value.count, index + 5);
    }
    assert.equal(new Set(committed).size, 5);
    assert.deepEqual(errors, []);
    assert.equal(service.status().modules[0].active.pid, workerPid);
    assert.equal(service.status().modules[0].active.snapshot.revision, 5);
    for (const operationId of committed) assert.equal((await service.operation(operationId)).state, "committed");
  } finally {
    watcher?.stop();
    await service?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source watcher compiles and publishes a changed declared module", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-source-watcher-"));
  const sourceDirectory = path.join(root, "source-patches");
  const sourcePath = path.join(sourceDirectory, "module.ts");
  const outputDirectory = path.join(root, "candidates");
  const published = [];
  const errors = [];
  const service = {
    status: () => ({ modules: [{ id: "watched", state: "ready", uncertainOperation: undefined, activeCandidateSha256: "active-candidate", active: { snapshot: { revision: 0 } } }] }),
    publish: async request => { published.push(request); return { state: "committed" }; },
  };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "watched", source: "source-patches/module.ts", resources: ["source-patches/resource.json"], contract: { schemaVersion: 1 } }] }));
    await fs.writeFile(sourcePath, "export function read() { return 'old'; }\n");
    await fs.writeFile(path.join(sourceDirectory, "resource.json"), "{\"version\":1}\n");
    const firstResourceHash = createHash("sha256").update("{\"version\":1}\n").digest("hex");
    const watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory, onError: error => errors.push(error) });
    assert.ok(watcher);
    await fs.writeFile(sourcePath, "export function read() { return 'new'; }\n");
    for (let attempt = 0; attempt < 50 && published.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(published.length, 1);
    assert.deepEqual(errors, []);
    assert.equal(published[0].moduleId, "watched");
    assert.equal(published[0].expectedRevision, 0);
    assert.match(published[0].operationId, /^auto-[a-f0-9]{32}$/);
    assert.equal(typeof published[0].contract.resources["source-patches/resource.json"], "string");
    assert.equal((await fs.readdir(outputDirectory)).length, 1);
    published.length = 0;
    await fs.writeFile(path.join(sourceDirectory, "resource.json"), "{\"version\":2}\n");
    for (let attempt = 0; attempt < 50 && published.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    watcher.stop();
    assert.equal(published.length, 1);
    assert.equal(typeof published[0].candidateSha256, "string");
    assert.notEqual(published[0].contract.resources["source-patches/resource.json"], firstResourceHash);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("source watcher coalesces rapid saves and applies the latest candidate serially", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-source-watcher-rapid-"));
  const sourceDirectory = path.join(root, "source-patches");
  const sourcePath = path.join(sourceDirectory, "module.ts");
  const outputDirectory = path.join(root, "candidates");
  const published = [];
  const service = { status: () => ({ modules: [{ id: "watched", state: "ready", uncertainOperation: undefined, activeCandidateSha256: "active", active: { snapshot: { revision: published.length } } }] }), publish: async request => { published.push(request); await new Promise(resolve => setTimeout(resolve, 250)); return { state: "committed" }; } };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "watched", source: "source-patches/module.ts" }] }));
    await fs.writeFile(sourcePath, "export function read() { return 'old'; }\n");
    const watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory });
    await fs.writeFile(sourcePath, "export function read() { return 'one'; }\n");
    await until(() => published.length === 1, () => "First candidate was not published.");
    await fs.writeFile(sourcePath, "export function read() { return 'two'; }\n");
    for (let attempt = 0; attempt < 80 && published.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    watcher.stop();
    assert.equal(published.length, 2);
    assert.notEqual(published[0].candidateSha256, published[1].candidateSha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("source watcher preserves a code change when a resource save arrives during compilation", { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-source-watcher-mixed-"));
  const sourceDirectory = path.join(root, "source-patches");
  const sourcePath = path.join(sourceDirectory, "module.ts");
  const resourcePath = path.join(sourceDirectory, "resource.json");
  const outputDirectory = path.join(root, "candidates");
  const published = [];
  let release;
  let watcher;
  const service = { status: () => ({ modules: [{ id: "watched", state: "ready", uncertainOperation: undefined, activeCandidateSha256: "active", active: { snapshot: { revision: published.length } } }] }), publish: async request => { published.push(request); await new Promise(resolve => { release = resolve; }); return { state: "committed" }; } };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "watched", source: "source-patches/module.ts", resources: ["source-patches/resource.json"] }] }));
    await fs.writeFile(sourcePath, "export function read() { return 'old'; }\n");
    await fs.writeFile(resourcePath, "one\n");
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory });
    await fs.writeFile(sourcePath, "export function read() { return 'code-new'; }\n");
    await until(() => typeof release === "function", () => "The first publication did not reach its release gate.");
    await fs.writeFile(resourcePath, "two\n");
    release();
    await until(() => published.length >= 2, () => "The resource edit was not published after releasing the first update.");
    watcher.stop();
    assert.equal(published.length, 2);
    assert.notEqual(published[0].candidateSha256, "active");
    assert.notEqual(published[1].candidateSha256, "active");
  } finally { watcher?.stop(); release?.(); await fs.rm(root, { recursive: true, force: true }); }
});

test("compiler preserves captured source and keeps the parent responsive during compilation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-compiler-isolation-"));
  const compiler = new SourcePatchCompiler();
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 10);
  try {
    const sourcePath = path.join(root, "module.ts");
    await fs.writeFile(sourcePath, "export function read() { return 'later'; }");
    const result = await compiler.build({ sourcePath, sourceContent: "export function read() { return 'captured'; }", outputDirectory: root });
    const candidate = await fs.readFile(result.outputPath, "utf8");
    assert.match(candidate, /captured/);
    assert.doesNotMatch(candidate, /later/);
    assert.ok(ticks >= 5, `Only ${ticks} parent heartbeat ticks completed during compilation.`);
    await assert.rejects(compiler.build({ sourcePath, sourceContent: "export function read( {", outputDirectory: root }));
    assert.equal((await compiler.build({ sourcePath, outputDirectory: root })).changed, true);
  } finally {
    clearInterval(heartbeat);
    await compiler.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compiler shutdown settles active and queued work without starting more workers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-compiler-stop-"));
  const compiler = new SourcePatchCompiler();
  const options = { sourcePath: path.join(root, "module.ts"), sourceContent: "export function read() { return 1; }", outputDirectory: root };
  try {
    const pending = Promise.allSettled([compiler.build(options), compiler.build(options)]);
    await new Promise(resolve => setTimeout(resolve, 25));
    await compiler.close();
    assert.deepEqual((await pending).map(result => result.status), ["rejected", "rejected"]);
    await assert.rejects(compiler.build(options), /closed/);
  } finally { await compiler.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("compiler Workers do not inherit eval-only flags from their Manager launcher", { timeout: 20000 }, async () => {
  const { execFile } = await import("node:child_process");
  const source = `const {SourcePatchCompiler}=await import(${JSON.stringify(implementation("manager/sourcePatchCompiler").href)}); const compiler=new SourcePatchCompiler(); try { console.log(JSON.stringify(await compiler.inspect(${JSON.stringify(packageRoot)}, []))); } finally { await compiler.close(); }`;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [...(built ? [] : ["--import", "tsx"]), "--input-type=module", "--eval", source],
      { cwd: packageRoot, windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve(stdout));
  });
  assert.deepEqual(JSON.parse(stdout), { modules: [] });
});

test("shared resource atomic replacement updates every declaring module and keeps watching", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-shared-resource-"));
  const definitions = ["first", "second"].map(id => ({ id, source: "source-patches/module.ts", resources: ["source-patches/resource.txt"] }));
  const published = [];
  const errors = [];
  const service = {
    status: () => ({ modules: definitions.map(({ id }) => ({ id, state: "ready", activeCandidateSha256: "initial", active: { snapshot: { revision: 0 } } })) }),
    publish: async () => { assert.fail("Shared resource updates must use the managed bundle transaction."); },
    publishBundle: async request => { published.push(...request.entries.map(entry => ({ ...entry, operationId: request.operationId }))); return { state: "committed" }; },
  };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  let watcher;
  try {
    const directory = path.join(root, "source-patches");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: definitions }));
    await fs.writeFile(path.join(directory, "module.ts"), "export function read() { return 1; }");
    const resource = path.join(directory, "resource.txt");
    await fs.writeFile(resource, "initial");
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory: path.join(root, "candidates"), onError: error => errors.push(error) });
    for (const [index, text] of ["replacement", "another-replacement"].entries()) {
      const temporary = path.join(directory, "resource.next");
      await fs.writeFile(temporary, text);
      await fs.rename(temporary, resource);
      await until(() => published.length >= (index + 1) * 2, () => `Missing shared resource updates: ${errors.join("; ")}`);
      assert.deepEqual(published.slice(index * 2).map(entry => entry.moduleId).sort(), ["first", "second"]);
      for (const entry of published.slice(index * 2)) assert.equal(entry.contract.resources["source-patches/resource.txt"], createHash("sha256").update(text).digest("hex"));
    }
    assert.equal(new Set(published.map(entry => entry.operationId)).size, 2);
    assert.deepEqual(errors, []);
  } finally { watcher?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test("local TypeScript dependency changes trigger the owning module", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-dependency-watcher-"));
  const published = [];
  const service = { status: () => ({ modules: [{ id: "watched", state: "ready", activeCandidateSha256: "active", active: { snapshot: { revision: published.length } } }] }), publish: async request => { published.push(request); return { state: "committed" }; } };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  let watcher;
  try {
    const directory = path.join(root, "source-patches");
    await fs.mkdir(directory, { recursive: true });
    const sourcePath = path.join(directory, "module.ts");
    const dependencyPath = path.join(directory, "dependency.ts");
    await fs.writeFile(path.join(directory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "watched", source: "source-patches/module.ts" }] }));
    await fs.writeFile(sourcePath, "import type { Value } from './dependency'; export function read(value: Value) { return value; }");
    await fs.writeFile(dependencyPath, "export type Value = 'one';");
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory: path.join(root, "candidates") });
    await fs.writeFile(dependencyPath, "export type Value = 'one' | 'two';");
    await until(() => published.length === 1, () => "Dependency change was not published.");
    assert.equal(published[0].moduleId, "watched");
  } finally { watcher?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test("catalog changes replace resource watches and invalid edits keep the last valid catalog", { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-catalog-reload-"));
  const published = [];
  const errors = [];
  let active;
  const service = {
    status: () => ({ modules: [{ id: "watched", state: "ready", activeCandidateSha256: active?.candidateSha256 ?? "active", active: { snapshot: { revision: published.length, contract: active?.contract } } }] }),
    publish: async request => { active = request; published.push(request); return { state: "committed" }; },
  };
  const runtime = { current: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", id: "plugin" }) };
  let watcher;
  try {
    const directory = path.join(root, "source-patches");
    await fs.mkdir(directory);
    await fs.mkdir(path.join(root, "resources"));
    const catalogPath = path.join(directory, "modules.json");
    const catalog = { schemaVersion: 1, modules: [{ id: "watched", source: "source-patches/module.ts", resources: [] }] };
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    await fs.writeFile(path.join(directory, "module.ts"), "export function read() { return 1; }");
    await fs.writeFile(path.join(root, "resources", "label.txt"), "first");
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory: path.join(root, "candidates"), onError: error => errors.push(error) });
    catalog.modules[0].resources = ["resources/label.txt"];
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    await until(() => published.length === 1, () => errors.join("; "));
    assert.equal(published[0].contract.resources["resources/label.txt"], createHash("sha256").update("first").digest("hex"));
    await fs.writeFile(catalogPath, "{");
    await until(() => errors.length === 1, () => "Invalid catalog error was not reported.");
    await fs.writeFile(path.join(root, "resources", "label.txt"), "second");
    await until(() => published.length === 2, () => "Previous valid watches were lost.");
    catalog.modules[0].resources = [];
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    await until(() => published.length === 3, () => errors.join("; "));
    await fs.writeFile(path.join(root, "resources", "label.txt"), "ignored");
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(published.length, 3);
    assert.equal(errors.length, 1);
  } finally { watcher?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test("catalog path escapes and duplicate identities are rejected before installing watches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-catalog-invalid-"));
  try {
    const directory = path.join(root, "source-patches");
    await fs.mkdir(directory);
    for (const modules of [[{ id: "escape", source: "../outside.ts" }], [{ id: "duplicate", source: "a.ts" }, { id: "duplicate", source: "b.ts" }]]) {
      await fs.writeFile(path.join(directory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules }));
      await assert.rejects(SourcePatchWatcher.start({ root, service: {}, runtime: {}, outputDirectory: path.join(root, "candidates") }), /relative|duplicate/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("new catalog modules register automatically and retain resources, state, identity and durable rollback", { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-dynamic-module-"));
  const sourceDirectory = path.join(root, "source-patches");
  const baselineRoot = path.join(root, "baselines");
  const stateRoot = path.join(root, "state");
  const sourcePath = path.join(sourceDirectory, "new-module.ts");
  const runtime = new GenerationRuntime({ host: "manager" });
  const errors = [];
  const moduleSource = value => `declare const __rabiResources: { text(path: string): string }; let count = 0; export function read() { return { value: '${value}', count: ++count, resource: __rabiResources.text('source-patches/value.txt') }; }`;
  let service;
  let watcher;
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(baselineRoot, { recursive: true });
    await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [] }));
    await fs.writeFile(sourcePath, moduleSource("one"));
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "first");
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [] }));
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime, workerTimeoutMs: 10000 });
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory: path.join(stateRoot, "candidates"), onError: error => errors.push(error.message) });
    const generation = runtime.current().id;
    const parentPid = process.pid;
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "new-module", source: "source-patches/new-module.ts", resources: ["source-patches/value.txt"], contract: { version: 1 } }] }));
    await until(() => service.status().modules.some(module => module.id === "new-module" && module.state === "ready"), () => JSON.stringify(service.status()));
    assert.equal(service.status().modules.length, 1);
    const hostService = createSourcePatchHostService(() => service);
    assert.equal(hostService.capability, "host.manager.source-patches@1");
    assert.equal(hostService.value.status().modules.length, 1);
    const workerPid = service.status().modules[0].active.pid;
    assert.deepEqual((await hostService.value.invoke("new-module", "read", [])).value, { value: "one", count: 1, resource: "first" });
    await fs.writeFile(sourcePath, moduleSource("two"));
    await until(() => service.status().modules.find(module => module.id === "new-module")?.active?.snapshot?.revision === 1, () => JSON.stringify(service.status()));
    assert.deepEqual((await service.invoke("new-module", "read", [])).value, { value: "two", count: 2, resource: "first" });
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "second");
    await until(() => service.status().modules[0]?.active?.snapshot.revision === 2, () => errors.join("; "));
    assert.deepEqual((await service.invoke("new-module", "read", [])).value, { value: "two", count: 3, resource: "second" });
    await fs.writeFile(sourcePath, "export function read( {");
    await until(() => errors.length > 0, () => "Invalid source was not rejected.");
    assert.deepEqual((await service.invoke("new-module", "read", [])).value, { value: "two", count: 4, resource: "second" });
    assert.equal(service.status().modules[0].active.pid, workerPid);
    assert.equal(process.pid, parentPid);
    assert.equal(runtime.current().id, generation);
    const registration = JSON.parse(await fs.readFile(path.join(stateRoot, "registrations/new-module.json"), "utf8"));
    assert.equal(registration.state, "active");
    watcher.stop();
    await service.stop();
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime });
    assert.deepEqual((await service.invoke("new-module", "read", [])).value, { value: "two", count: 1, resource: "second" });
    const current = runtime.current();
    const rollback = await service.publish({ operationId: "dynamic-rollback", action: "rollback", moduleId: "new-module", expectedRevision: 0,
      applicationGenerationId: current.applicationGenerationId, managerInstanceId: current.managerInstanceId, pluginGenerationId: current.id });
    assert.equal(rollback.state, "committed");
    assert.deepEqual((await service.invoke("new-module", "read", [])).value, { value: "two", count: 2, resource: "first" });
  } finally {
    watcher?.stop();
    await service?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a catalog created after startup discovers independent modules and injects declared state without core changes", { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-discovery-first-catalog-"));
  const baselineRoot = path.join(root, "baseline");
  const stateRoot = path.join(root, "state");
  const runtime = new GenerationRuntime({ host: "manager" });
  const errors = [];
  let watcher;
  let service;
  try {
    await fs.mkdir(baselineRoot);
    await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [] }));
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime });
    watcher = await SourcePatchWatcher.start({ root, service, runtime, outputDirectory: path.join(stateRoot, "candidates"), onError: error => errors.push(error.message) });
    const directory = path.join(root, "source-patches");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "bad.ts"), "export function read( {");
    await fs.writeFile(path.join(directory, "good.ts"), "declare const state: { count: number }; declare const options: { increment: number }; export function read() { state.count += options.increment; return state.count; }");
    const configuration = { schemaVersion: 1, modules: [
      { id: "bad", source: "source-patches/bad.ts" },
      { id: "good", source: "source-patches/good.ts", dependencies: { state: { count: 5 }, options: { increment: 2 } } }
    ] };
    await fs.writeFile(path.join(directory, "modules.json"), JSON.stringify(configuration));
    await until(() => service.status().modules.some(module => module.id === "good" && module.state === "ready"), () => errors.join("; "));
    assert.ok(errors.length > 0);
    assert.equal((await service.invoke("good", "read", [])).value, 7);
    await fs.writeFile(path.join(directory, "bad.ts"), "export function read() { return 3; }");
    await until(() => service.status().modules.some(module => module.id === "bad" && module.state === "ready"), () => errors.join("; "));
    assert.equal((await service.invoke("bad", "read", [])).value, 3);
    const errorCount = errors.length;
    configuration.modules[1].dependencies.state.count = 100;
    await fs.writeFile(path.join(directory, "modules.json"), JSON.stringify(configuration));
    await until(() => errors.length > errorCount, () => "Changed state initializer was not rejected.");
    assert.match(errors.at(-1), /module-owned migration/);
    assert.equal((await service.invoke("good", "read", [])).value, 9);
    watcher.stop();
    await service.stop();
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime });
    assert.equal((await service.invoke("good", "read", [])).value, 7);
  } finally { watcher?.stop(); await service?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test("unconfirmed dynamic registration fences initialization across restart instead of replaying it", { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-registration-fence-"));
  const baselineRoot = path.join(root, "baseline");
  const stateRoot = path.join(root, "state");
  const runtime = new GenerationRuntime({ host: "manager" });
  const rename = fs.rename;
  let service;
  try {
    await fs.mkdir(baselineRoot);
    await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [] }));
    const sourcePath = path.join(root, "module.ts");
    await fs.writeFile(sourcePath, "export function read() { return 1; }");
    const candidate = await buildHotPatchCandidate({ sourcePath, outputDirectory: path.join(stateRoot, "candidates") });
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime });
    let writes = 0;
    fs.rename = async (source, target) => {
      if (target === path.join(stateRoot, "registrations", "new-module.json") && ++writes === 2) throw new Error("injected registration persistence failure");
      return rename(source, target);
    };
    await assert.rejects(service.ensureModule("new-module", candidate.sha256), /persistence failure/);
    fs.rename = rename;
    assert.equal(service.status().modules[0].state, "failed");
    await service.stop();
    service = new ManagerSourcePatchService({ baselineRoot, stateRoot, runtime });
    await assert.rejects(service.invoke("new-module", "read", []), /unconfirmed/);
    assert.equal(service.status().modules[0].active, undefined);
    await assert.rejects(service.ensureModule("new-module", candidate.sha256), /unconfirmed/);
    await service.ensureModule("independent", candidate.sha256);
    assert.equal((await service.invoke("independent", "read", [])).value, 1);
  } finally { fs.rename = rename; await service?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
