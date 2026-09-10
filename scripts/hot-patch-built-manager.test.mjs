import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";

const packageRoot = path.resolve(process.env.RABIROUTE_HOT_PATCH_TEST_PACKAGE_ROOT || fileURLToPath(new URL("..", import.meta.url)));

test("built Manager keeps its identity while discovering modules and updating source, resources and documentation", { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-built-source-patch-"));
  const stateRoot = path.join(root, "state");
  const sourceRoot = path.join(root, "sources");
  const profile = path.join(root, "profile.json");
  const applicationGenerationId = randomUUID();
  const controlToken = randomUUID();
  await fs.mkdir(stateRoot);
  await fs.mkdir(sourceRoot);
  await fs.writeFile(profile, JSON.stringify({ schemaVersion: 2, readyRequires: ["manager.core@1", "manager.diagnostics@1"],
    instances: ["core", "diagnostics"].map(name => ({ id: `manager:${name}`, package: `io.rabiroute.manager.${name}`, version: "1.0.0", enabled: true, config: {}, grants: [] })) }));
  const source = await fs.readFile(path.join(packageRoot, "src/manager/pluginCatalogPresentation.ts"), "utf8");
  const compiled = compileHotPatchModule(source.replace('host || "all"', 'host || "patched"'),
    path.join(packageRoot, "src/manager/pluginCatalogPresentation.ts"));
  const bytes = JSON.stringify(compiled);
  const candidateSha256 = createHash("sha256").update(bytes).digest("hex");
  const candidates = path.join(stateRoot, "data/.runtime/source-patches/candidates");
  await fs.mkdir(candidates, { recursive: true });
  await fs.writeFile(path.join(candidates, `${candidateSha256}.json`), bytes);
  const entry = pathToFileURL(path.join(packageRoot, "dist/manager/controlPlaneRoutes.js")).href;
  const worker = spawn(process.execPath, ["--input-type=module", "--eval", `const {startManager}=await import(${JSON.stringify(entry)}); await startManager();`], {
    cwd: stateRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      HOME: path.join(root, "home"), USERPROFILE: path.join(root, "userprofile"),
      GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: "0", GATEWAY_MANAGER_URL: "",
      RABIROUTE_APPLICATION_GENERATION_ID: applicationGenerationId,
      RABIROUTE_HOST_CONTROL_TOKEN: controlToken, RABIROUTE_HOSTED: "1",
      RABIROUTE_MANAGER_AUTOSTART: "0", RABIROUTE_MANAGER_READ_ONLY: "0", REMOTE_AGENT_DISCOVERABLE: "0",
      RABIROUTE_PACKAGE_ROOT: packageRoot, RABIROUTE_STATE_ROOT: stateRoot,
      RABIROUTE_HOT_PATCH_SOURCE_ROOT: sourceRoot, RABIROUTE_HOT_PATCH_WATCH: "1",
      RABIROUTE_PLUGIN_PROFILE: profile, RABIROUTE_PLUGIN_PACKAGE_ROOTS: path.join(packageRoot, "dist/plugins/packages"),
      ROLES_DIR: path.join(root, "roles"), ROUTE_DIR: path.join(root, "routes")
    }
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
  worker.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
  const exited = once(worker, "exit");
  let ready;
  let polling = true;
  let pollingWork;
  let pollError;
  let healthReads = 0;
  const request = async (endpoint, body) => {
    const response = await fetch(ready.baseUrl + endpoint, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(10000),
      headers: body ? { "content-type": "application/json", "x-rabiroute-host-token": controlToken } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify({ endpoint, status: response.status, value }));
    return { response, value };
  };
  try {
    const deadline = Date.now() + 30000;
    while (!ready) {
      const line = stdout.split(/\r?\n/).find(line => line.startsWith("RABIROUTE_MANAGER_READY:"));
      if (line) ready = JSON.parse(line.slice("RABIROUTE_MANAGER_READY:".length));
      else {
        assert.ok(worker.exitCode === null && worker.signalCode === null && Date.now() < deadline, `Manager startup failed: ${stdout}\n${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.equal(ready.applicationGenerationId, applicationGenerationId);
    assert.equal(ready.pid, worker.pid);
    assert.equal(new URL(ready.baseUrl).hostname, "127.0.0.1");
    const initial = (await request("/meta")).value;
    assert.equal(initial.managerInstanceId, ready.managerInstanceId);
    assert.equal(initial.health.requiredReady, true);
    const builtHtml = await fs.readFile(path.join(packageRoot, "ribiwebgui/dist/index.html"), "utf8");
    const scriptSource = builtHtml.match(/<script[^>]*src="([^"]+)"/)?.[1];
    assert.ok(scriptSource, "The built root document must reference its hashed script.");
    const rootResponse = await fetch(`${ready.baseUrl}/`, { signal: AbortSignal.timeout(10000) });
    assert.equal(rootResponse.status, 200);
    const servedHtml = await rootResponse.text();
    const servedScript = servedHtml.match(/<script[^>]*src="([^"]+)"/)?.[1];
    assert.ok(servedScript?.endsWith(scriptSource.replace(/^\.\//, "")), "Manager did not serve the newly built root document.");
    const bundleResponse = await fetch(new URL(servedScript, `${ready.baseUrl}/`), { signal: AbortSignal.timeout(10000) });
    assert.equal(bundleResponse.status, 200);
    const bundleBytes = await fs.readFile(path.join(packageRoot, "ribiwebgui/dist", scriptSource));
    assert.equal(createHash("sha256").update(Buffer.from(await bundleResponse.arrayBuffer())).digest("hex"), createHash("sha256").update(bundleBytes).digest("hex"));
    const before = await request("/api/plugins/catalog");
    assert.equal(before.value.data.host, "all");
    const beforeStatus = (await request("/api/source-patches")).value.data;
    const module = beforeStatus.modules.find(entry => entry.id === "manager.plugin-catalog");
    const sourcePid = module.active.pid;
    const originalSource = module.active.snapshot.sourceHash;
    pollingWork = (async () => {
      while (polling) {
        const health = (await request("/health")).value;
        assert.equal(health.health.live, true);
        assert.equal(health.health.requiredReady, true);
        healthReads++;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })().catch(error => { pollError = error; });
    const publication = {
      operationId: randomUUID(), action: "apply", moduleId: "manager.plugin-catalog", expectedRevision: 0,
      applicationGenerationId, managerInstanceId: ready.managerInstanceId, pluginGenerationId: initial.pluginGeneration.id,
      candidateSha256, contract: { schema: 2, description: "patched catalog" }
    };
    const applied = (await request("/_rabiroute/host/source-patches", publication)).value.data;
    assert.equal(applied.commitState, "committed");
    assert.equal(applied.result.pid, sourcePid);
    assert.equal(applied.result.snapshot.sourceHash, compiled.sourceHash);
    const changed = await request("/api/plugins/catalog");
    assert.equal(changed.value.data.host, "patched");
    assert.equal(changed.response.headers.get("x-rabiroute-source-revision"), "1");
    const contract = { schema: 2, description: "clarified catalog" };
    const described = (await request("/_rabiroute/host/source-patches", {
      ...publication, operationId: randomUUID(), expectedRevision: 1, contract
    })).value.data;
    assert.equal(described.result.snapshot.revision, 2);
    assert.deepEqual(described.result.snapshot.contract, contract);
    const restored = (await request("/_rabiroute/host/source-patches", {
      ...publication, operationId: randomUUID(), action: "rollback", expectedRevision: 2
    })).value.data;
    assert.equal(restored.result.snapshot.revision, 3);
    assert.equal(restored.result.snapshot.contract.description, "patched catalog");
    assert.notEqual(originalSource, restored.result.snapshot.sourceHash);
    const sameOperation = (await request("/_rabiroute/host/source-patches", publication)).value.data;
    assert.equal(sameOperation.result.snapshot.revision, 1);
    const sourceDirectory = path.join(sourceRoot, "source-patches");
    await fs.mkdir(sourceDirectory);
    const dynamicSource = `declare const __rabiResources: { text(path: string): string }; export function read() { return { label: 'first', resource: __rabiResources.text('source-patches/value.txt') }; }`;
    const dynamicPath = path.join(sourceDirectory, "dynamic.ts");
    await fs.writeFile(dynamicPath, dynamicSource);
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "first");
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "dynamic", source: "source-patches/dynamic.ts", resources: ["source-patches/value.txt"], contract: { label: "dynamic contract" } }] }));
    const waitDynamic = async revision => {
      const expires = Date.now() + 20000;
      while (Date.now() < expires) {
        const status = (await request("/api/source-patches")).value.data;
        const module = status.modules.find(entry => entry.id === "dynamic");
        if (module?.state === "ready" && module.active.snapshot.revision === revision) return module;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      assert.fail(`Dynamic module revision ${revision} unavailable: ${stderr}\n${stdout}`);
    };
    const registered = await waitDynamic(0);
    assert.equal(registered.active.snapshot.contract.label, "dynamic contract");
    const updatedSource = dynamicSource.replace("label: 'first'", "label: 'second'");
    await fs.writeFile(dynamicPath, updatedSource);
    const updated = await waitDynamic(1);
    assert.equal(updated.active.pid, registered.active.pid);
    assert.equal(updated.active.snapshot.sourceHash, compileHotPatchModule(updatedSource, dynamicPath).sourceHash);
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "second");
    const resourceUpdated = await waitDynamic(2);
    assert.equal(resourceUpdated.active.pid, registered.active.pid);
    assert.equal(resourceUpdated.active.snapshot.contract.resources["source-patches/value.txt"], createHash("sha256").update("second").digest("hex"));
    assert.equal((await request("/api/plugins/catalog")).value.data.host, "patched");
    const current = (await request("/meta")).value;
    assert.equal(current.applicationGenerationId, initial.applicationGenerationId);
    assert.equal(current.managerInstanceId, initial.managerInstanceId);
    assert.equal(current.pluginGeneration.id, initial.pluginGeneration.id);
    polling = false;
    await pollingWork;
    if (pollError) throw pollError;
    assert.ok(healthReads > 0);
  } finally {
    polling = false;
    await pollingWork;
    if (worker.exitCode === null && worker.signalCode === null && ready) {
      await request("/_rabiroute/host/shutdown", {}).catch(() => {});
      let timer;
      const completed = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); })]);
      clearTimeout(timer);
      if (!completed) worker.kill("SIGKILL");
    } else if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await exited;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-built-source-patch-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
