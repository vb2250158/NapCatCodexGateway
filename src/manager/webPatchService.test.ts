import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { buildWebPatch, verifyWebPatch, webPatchHash, webPatchPath, writeWebPatchJson } from "./webPatchCatalog.js";
import { WebPatchService, type WebPatchIdentity } from "./webPatchService.js";
import { WebPatchWatcher } from "./webPatchWatcher.js";
import { handleWebPatchApi } from "./webPatchRoutes.js";

const identity: WebPatchIdentity = { applicationGenerationId: "application", managerInstanceId: "manager", pluginGenerationId: "plugins" };

async function fixture(context: { after(action: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-patch-test-"));
  const packageRoot = path.join(root, "package");
  const stateRoot = path.join(root, "state");
  const services: WebPatchService[] = [];
  context.after(async () => {
    await Promise.all(services.map(service => service.stop()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(relative: string, body: string) {
    const filename = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, body);
  }
  await write("dist/manager.js", "export const version = 1;");
  await write("dist/plugins/packages/example/rabi.plugin.json", JSON.stringify({ id: "example", version: "1", entries: { web: { module: "web/client.mjs" } } }));
  await write("dist/plugins/packages/example/web/client.mjs", 'export { activate } from "/assets/module.js";\n');
  await write("ribiwebgui/dist/index.html", '<html><head><link href="./assets/style.css"></head><body><script type="module" src="./assets/main.js"></script></body></html>');
  await write("ribiwebgui/dist/assets/main.js", 'import "./lazy.js";');
  await write("ribiwebgui/dist/assets/lazy.js", 'export const value = "old";');
  await write("ribiwebgui/dist/assets/module.js", "export function activate() { return 1; }");
  await write("ribiwebgui/dist/assets/style.css", "body { color: red; }");
  await write("assets/icon.svg", "<svg/>");
  await write("docs/guide.md", "old guide");
  function start() {
    const service = new WebPatchService({ packageRoot, stateRoot, identity: () => identity,
      serialize: async (generation, action) => { assert.equal(generation, identity.pluginGenerationId); return action(); } });
    services.push(service);
    return service;
  }
  const service = start();
  await service.ready;
  assert.equal(service.status().state, "ready", service.status().error);
  async function candidate(value = "new") {
    await write("ribiwebgui/dist/assets/lazy.js", `export const value = ${JSON.stringify(value)};`);
    await write("docs/guide.md", `${value} guide`);
    const output = path.join(packageRoot, "dist/web-patches");
    const revision = await buildWebPatch(packageRoot, output);
    return { output, revision, source: path.join(output, revision) };
  }
  return { root, packageRoot, stateRoot, service, start, write, candidate };
}

test("atomic release keeps old HTML, lazy assets, documentation and module entry pinned; rollback and restart preserve receipts", async context => {
  const sample = await fixture(context);
  const original = (await sample.service.document())!;
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const request = { ...identity, operationId: "publish", candidate: next.revision, expectedRevision: 0 };
  const receipt = await sample.service.publish(request);
  assert.equal(receipt.revision, 1);
  assert.deepEqual(await sample.service.publish(request), receipt);
  assert.match((await sample.service.document())!.body, new RegExp(`/_rabiroute/web/${next.revision}/web/assets/main.js`));
  assert.match(original.body, new RegExp(`data-rabi-web-release="${original.revision}"`));
  assert.match((await sample.service.read(original.revision, "web/assets/lazy.js")).body.toString(), /old/);
  assert.equal((await sample.service.read(original.revision, "docs/guide.md")).body.toString(), "old guide");
  assert.equal((await sample.service.read(next.revision, "docs/guide.md")).body.toString(), "new guide");
  const modules = [{ id: "web-example", pluginId: "example", version: "1", rev: "legacy", entryPath: "web/client.mjs", instances: [] }];
  assert.equal((await sample.service.modules(modules, original.revision))[0]!.rev, original.revision);
  assert.match((await sample.service.module(modules, "web-example", original.revision, "web/client.mjs"))!.source.toString(), new RegExp(original.revision));
  await assert.rejects(sample.service.publish({ ...request, candidate: original.revision }), /conflict/);
  await assert.rejects(sample.service.publish({ ...request, operationId: "stale" }), /baseline/);
  await assert.rejects(sample.service.publish({ ...request, operationId: "identity", managerInstanceId: "old" }), /identity/);
  await sample.service.publish({ ...identity, operationId: "rollback", candidate: original.revision, expectedRevision: 1 });
  assert.equal((await sample.service.document())!.revision, original.revision);
  await sample.service.stop();
  const restored = sample.start();
  await restored.ready;
  assert.equal(restored.status().state, "ready", restored.status().error);
  assert.equal(restored.status().active, original.revision);
  assert.deepEqual(restored.operation("publish"), receipt);
});

test("backend mismatch, corrupt candidate and missing entry fail without changing the live release", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active;
  const next = await sample.candidate();
  await fs.writeFile(path.join(next.source, "web/assets/lazy.js"), "tampered");
  await assert.rejects(sample.service.importCandidate(next.source, next.revision), /verification/);
  await sample.write("dist/manager.js", "export const version = 2;");
  const changed = await sample.candidate("incompatible");
  await assert.rejects(sample.service.importCandidate(changed.source, changed.revision), /incompatible/);
  await sample.write("ribiwebgui/dist/index.html", '<html><script src="./assets/absent.js"></script></html>');
  await assert.rejects(sample.candidate(), /missing asset/);
  assert.equal(sample.service.status().active, baseline);
  assert.equal(sample.service.status().revision, 0);
});

test("automatic marker consumes each operation once and does not undo a deliberate rollback", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active!;
  const next = await sample.candidate();
  await writeWebPatchJson(path.join(next.output, "latest.json"), { revision: next.revision, operationId: "automatic" });
  await sample.service.automatic(sample.packageRoot);
  assert.equal(sample.service.status().active, next.revision);
  await sample.service.publish({ ...identity, operationId: "rollback", candidate: baseline, expectedRevision: 1 });
  await sample.service.automatic(sample.packageRoot);
  assert.equal(sample.service.status().active, baseline);
  assert.equal(sample.service.status().revision, 2);
});

test("watcher picks up completed markers after output directory creation and rebuild", async context => {
  const sample = await fixture(context);
  const errors: unknown[] = [];
  const watcher = new WebPatchWatcher(sample.packageRoot, sample.service, error => errors.push(error));
  context.after(async () => watcher.stop());
  async function waitFor(revision: string) {
    const deadline = Date.now() + 10000;
    while (sample.service.status().active !== revision && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sample.service.status().active, revision, String(errors));
  }
  const first = await sample.candidate();
  await writeWebPatchJson(path.join(first.output, "latest.json"), { revision: first.revision, operationId: "first" });
  await waitFor(first.revision);
  await fs.rm(first.output, { recursive: true, force: true });
  const second = await sample.candidate("second");
  await writeWebPatchJson(path.join(second.output, "latest.json"), { revision: second.revision, operationId: "second" });
  await waitFor(second.revision);
  assert.equal(sample.service.status().revision, 2);
});

test("persisted receipt corruption blocks updates instead of losing idempotency history", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  await sample.service.publish({ ...identity, operationId: "original", candidate: next.revision, expectedRevision: 0 });
  const statePath = path.join(sample.stateRoot, "states", `${sample.service.status().backend}.json`);
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.operations[0].fingerprint = "forged";
  await fs.writeFile(statePath, JSON.stringify(state));
  await sample.service.stop();
  const restored = sample.start();
  await restored.ready;
  assert.equal(restored.status().state, "blocked");
  await assert.rejects(restored.publish({ ...identity, operationId: "new", candidate: next.revision, expectedRevision: 1 }), /unavailable/);
});

test("candidate paths reject traversal and manifest aliases", async context => {
  const sample = await fixture(context);
  for (const filename of ["web/../secret", "web//secret", "web/./secret", "docs/../../secret", "web\\secret", "/web/index.html"]) {
    assert.throws(() => webPatchPath(filename), /Invalid/);
  }
  const next = await sample.candidate();
  await assert.rejects(verifyWebPatch(next.source, "0".repeat(64)), /hash mismatch/);
  const manifest = JSON.parse(await fs.readFile(path.join(next.source, "manifest.json"), "utf8"));
  manifest.files.push({ ...manifest.files[0] });
  const raw = JSON.stringify(manifest);
  await fs.writeFile(path.join(next.source, "manifest.json"), raw);
  await assert.rejects(verifyWebPatch(next.source, webPatchHash(raw)), /file record/);
});

test("publication persistence failure is reconciled without replay and receipt reads cannot mutate history", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const originalRename = fs.rename.bind(fs);
  const rename = context.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination).endsWith(`${sample.service.status().backend}.json`)) throw new Error("injected persistence failure");
    return originalRename(source, destination);
  });
  const request = { ...identity, operationId: "original", candidate: next.revision, expectedRevision: 0 };
  await assert.rejects(sample.service.publish(request), /persistence/);
  assert.equal(sample.service.status().state, "blocked");
  assert.equal((await sample.service.reconcile("original")).state, "not_started");
  rename.mock.restore();
  assert.equal(sample.service.status().state, "ready");
  const receipt = await sample.service.publish(request);
  receipt.active = "mutated";
  sample.service.operation("original")!.active = "mutated";
  assert.equal(sample.service.operation("original")!.active, next.revision);
  assert.equal((await sample.service.reconcile("original")).state, "committed");
  assert.equal(sample.service.status().revision, 1);
});

test("rename committed before an error still returns the one persisted outcome", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const originalRename = fs.rename.bind(fs);
  const rename = context.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    await originalRename(source, destination);
    if (String(destination).endsWith(`${sample.service.status().backend}.json`)) throw new Error("injected lost acknowledgement");
  });
  const request = { ...identity, operationId: "committed", candidate: next.revision, expectedRevision: 0 };
  assert.equal((await sample.service.publish(request)).state, "committed");
  rename.mock.restore();
  assert.equal((await sample.service.publish(request)).revision, 1);
  assert.equal(sample.service.status().revision, 1);
});

test("missing versioned module never falls back to a different release", async context => {
  const sample = await fixture(context);
  await assert.rejects(sample.service.modules([{ id: "other", pluginId: "other", version: "1", rev: "legacy", entryPath: "web/client.mjs", instances: [] }], sample.service.status().active), /no compatible/);
});

test("continuous HTTP reads remain available during publication; old assets and HEAD stay valid", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active!;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (handleWebPatchApi(request, url, response, { service: sample.service, identity: null,
      readJson: async () => ({}), json: (target, status, body) => { target.writeHead(status, { "content-type": "application/json" }); target.end(JSON.stringify(body)); } })) return;
    response.end("healthy");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const publication = sample.service.publish({ ...identity, operationId: "concurrent", candidate: next.revision, expectedRevision: 0 });
  await Promise.all(Array.from({ length: 40 }, async () => {
    assert.equal(await (await fetch(`${base}/health`)).text(), "healthy");
    const asset = await fetch(`${base}/_rabiroute/web/${baseline}/web/assets/lazy.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /old/);
  }));
  await publication;
  const head = await fetch(`${base}/_rabiroute/web/${next.revision}/web/assets/lazy.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("cache-control")!, /immutable/);
  assert.equal((await fetch(`${base}/_rabiroute/host/web-patches`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${base}/api/web-patches/operations/concurrent`)).status, 200);
});
