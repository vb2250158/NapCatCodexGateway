import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import {
  GenerationRuntime,
  RequiredPluginCapabilitiesUnavailableError,
  selectReadyPluginCandidates
} from "./generationRuntime.js";
import type { PluginCandidate, PluginManifest, PluginModule } from "./types.js";

const testModules = new WeakMap<PluginCandidate, PluginModule>();
const testExecutor = Object.freeze({
  async prepare(item: PluginCandidate): Promise<PluginModule> {
    const module = testModules.get(item);
    if (!module) throw new Error(`Missing test module: ${item.instanceId}.`);
    return module;
  }
});

function manifest(id: string, input: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 2, id, version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: [], ...input
  };
}
function candidate(input: Partial<PluginCandidate> & Pick<PluginCandidate, "instanceId" | "manifest"> & { module: PluginModule }): PluginCandidate {
  const { module, ...candidateInput } = input;
  const result: PluginCandidate = {
    revision: "one", config: {}, entry: { execution: "in_process", path: "virtual.mjs" }, ...candidateInput
  };
  testModules.set(result, module);
  return result;
}
function createRuntime(options: Omit<ConstructorParameters<typeof GenerationRuntime>[0], "host" | "executor"> = {}): GenerationRuntime {
  return new GenerationRuntime({ host: "manager", executor: testExecutor, ...options });
}

test("source publication shares the generation mutation fence without blocking snapshot reads", async () => {
  const runtime = createRuntime();
  const original = runtime.current().id;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const publication = runtime.publishSourcePatch(original, async () => { entered(); await gate; return "published"; });
    await started;
    const switching = runtime.switch([candidate({ instanceId: "next", manifest: manifest("io.test.next"), module: { activate() {} } })]);
    assert.equal(runtime.current().id, original);
    release();
    assert.equal(await publication, "published");
    await switching;
    await assert.rejects(runtime.publishSourcePatch(original, async () => "unexpected"), /no longer active/);
  } finally { release(); await runtime.dispose(); }
});

test("GenerationRuntime keeps candidate routes invisible until publication and hides failed candidates", async () => {
  const runtime = createRuntime();
  const routes = new ManagerPluginRouteRegistry(() => new Set(runtime.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId)));
  let observed = "";
  const read = () => {
    observed = "";
    routes.handle({ method: "GET" } as IncomingMessage, new URL("http://localhost/test"), {} as ServerResponse);
    return observed;
  };
  const revision = (label: string, barrier: () => Promise<void> = async () => {}) => candidate({
    instanceId: "routes", revision: label, manifest: manifest("io.test.routes"),
    module: { activate(context) {
      context.effects.add(async () => {
        const unregister = routes.register("routes", [{ routeId: "test", match: { kind: "exact", path: "/test" },
          handler: () => { observed = label; return true; } }]);
        try { await barrier(); } catch (error) { unregister(); throw error; }
        return unregister;
      });
    } }
  });
  try {
    assert.throws(() => routes.register("outside", []), /activation context/);
    await runtime.switch([revision("old")]);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const switching = runtime.switch([revision("new", async () => { entered(); await waiting; })]);
    await started;
    assert.equal(read(), "old");
    release();
    await switching;
    assert.equal(read(), "new");
    await runtime.switch([revision("failed", async () => {
      assert.equal(read(), "new");
      throw new Error("candidate failed");
    })]);
    assert.equal(read(), "new");
  } finally { await runtime.dispose(); }
  assert.equal(read(), "");
});

test("GenerationRuntime publishes services and contributions atomically", async () => {
  const lifecycle: string[] = [];
  const runtime = createRuntime();
  const result = await runtime.switch([
    candidate({
      instanceId: "provider", manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
      module: { activate(ctx) {
        ctx.services.provide("test.value@1", 42);
        ctx.contributions.register({ kind: "page", id: "test", value: { path: "/test" } });
        ctx.effects.add(() => { lifecycle.push("start-provider"); return () => { lifecycle.push("stop-provider"); }; });
      } }
    }),
    candidate({
      instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"] }),
      module: { activate(ctx) {
        assert.equal(ctx.services.require("test.value@1"), 42);
        ctx.effects.add(() => { lifecycle.push("start-consumer"); return () => { lifecycle.push("stop-consumer"); }; });
      } }
    })
  ]);
  assert.deepEqual(lifecycle, ["start-provider", "start-consumer"]);
  assert.equal(result.generation.services.services.get("test.value@1")?.value, 42);
  assert.equal(result.generation.contributions.contributions[0]?.id, "test");
  await runtime.dispose();
  assert.deepEqual(lifecycle, ["start-provider", "start-consumer", "stop-consumer", "stop-provider"]);
});

test("GenerationRuntime isolates a failed plugin from independent active plugins", async () => {
  const runtime = createRuntime();
  const stable = candidate({ instanceId: "stable", manifest: manifest("io.test.stable"), module: { activate() {} } });
  await runtime.switch([stable]);
  const result = await runtime.switch([
    stable,
    candidate({ instanceId: "broken", manifest: manifest("io.test.broken"), module: { activate() { throw new Error("broken"); } } })
  ]);
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "stable")?.status, "active");
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "broken")?.status, "failed");
  assert.match(result.generation.records.find(record => record.identity.instanceId === "broken")?.error?.message ?? "", /broken/);
});

test("GenerationRuntime fails closed when permissions were not granted", async () => {
  const runtime = createRuntime({ grantedPermissions: () => [] });
  const result = await runtime.switch([
    candidate({
      instanceId: "desktop", manifest: manifest("io.test.desktop", { permissions: ["desktop.ipc.codex"] }),
      module: { activate() {} }
    })
  ]);
  assert.equal(result.generation.records[0]?.status, "failed");
  assert.match(result.generation.records[0]?.error?.message ?? "", /not granted/);
});

test("GenerationRuntime keeps the previous component when effect publication fails", async () => {
  const runtime = createRuntime();
  let stableStarts = 0;
  let stableStops = 0;
  await runtime.switch([
    candidate({
      instanceId: "stable",
      manifest: manifest("io.test.stable"),
      module: { activate(ctx) {
        ctx.effects.add(() => { stableStarts += 1; return () => { stableStops += 1; }; });
      } }
    })
  ]);
  const result = await runtime.switch([
    candidate({
      instanceId: "stable",
      revision: "two",
      manifest: manifest("io.test.stable"),
      module: { activate(ctx) { ctx.effects.add(() => { throw new Error("publish failed"); }); } }
    })
  ]);
  const record = result.generation.records[0];
  assert.equal(record?.status, "active");
  assert.equal(record?.identity.revision, "one");
  assert.equal(record?.error?.code, "update_failed_using_previous_revision");
  assert.match(record?.error?.message ?? "", /publish failed/);
  assert.equal(stableStarts, 1);
  assert.equal(stableStops, 0);
  await runtime.dispose();
  assert.equal(stableStops, 1);
});

test("GenerationRuntime skips unchanged plugins and restarts only the dependency component", async () => {
  const lifecycle: string[] = [];
  const runtime = createRuntime({
    applicationIdentity: { applicationGenerationId: "app-one", managerInstanceId: "manager-one" }
  });
  const createProvider = (revision: string) => candidate({
    instanceId: "provider", revision, manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
    module: { activate(ctx) {
      ctx.services.provide("test.value@1", revision);
      ctx.effects.add(() => { lifecycle.push(`start-provider-${revision}`); return () => { lifecycle.push(`stop-provider-${revision}`); }; });
    } }
  });
  const consumer = candidate({
    instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"] }),
    module: { activate(ctx) {
      const value = ctx.services.require<string>("test.value@1");
      ctx.effects.add(() => { lifecycle.push(`start-consumer-${value}`); return () => { lifecycle.push(`stop-consumer-${value}`); }; });
    } }
  });
  const independent = candidate({
    instanceId: "independent", manifest: manifest("io.test.independent"),
    module: { activate(ctx) { ctx.effects.add(() => { lifecycle.push("start-independent"); return () => { lifecycle.push("stop-independent"); }; }); } }
  });

  await runtime.switch([createProvider("one"), consumer, independent]);
  const unchanged = await runtime.switch([createProvider("one"), consumer, independent]);
  assert.equal(unchanged.changed, false);
  await runtime.switch([createProvider("two"), consumer, independent]);
  assert.deepEqual(lifecycle, [
    "start-independent", "start-provider-one", "start-consumer-one",
    "start-provider-two", "start-consumer-two",
    "stop-consumer-one", "stop-provider-one"
  ]);
  await runtime.dispose();
  assert.equal(lifecycle.filter(item => item === "start-independent").length, 1);
  assert.equal(lifecycle.filter(item => item === "stop-independent").length, 1);
});

test("GenerationRuntime keeps activation identity and rejects a hot switch that loses required capabilities", async () => {
  const runtime = createRuntime({
    applicationIdentity: { applicationGenerationId: "app-one", managerInstanceId: "manager-one" }
  });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const first = await runtime.switch([core], { readyRequires: ["manager.core@1"] });
  const coreActivation = first.generation.records[0]!.identity.activationId;
  assert.equal(first.generation.readiness.state, "ready");
  assert.equal(first.generation.applicationGenerationId, "app-one");
  const optional = candidate({ instanceId: "optional", manifest: manifest("io.test.optional"), module: { activate() {} } });
  const second = await runtime.switch([core, optional], { readyRequires: ["manager.core@1"] });
  assert.equal(second.generation.records.find(record => record.identity.instanceId === "core")?.identity.activationId, coreActivation);
  await assert.rejects(
    runtime.switch([optional], { readyRequires: ["manager.core@1"] }),
    (error: unknown) => error instanceof Error
      && error.name === "RequiredPluginCapabilitiesUnavailableError"
      && /manager\.core@1/.test(error.message)
  );
  assert.equal(runtime.current().id, second.generation.id);
  assert.equal(runtime.current().services.services.get("manager.core@1")?.value !== undefined, true);
  await runtime.dispose();
});

test("required readiness failure preserves bounded plugin activation diagnostics", async () => {
  const runtime = createRuntime();
  const brokenCore = candidate({
    instanceId: "broken-core",
    manifest: manifest("io.test.broken-core", { provides: ["manager.core@1"] }),
    module: { activate() { throw new Error("fixture activation failed"); } }
  });
  await assert.rejects(
    runtime.switch([brokenCore], { readyRequires: ["manager.core@1"] }),
    (error: unknown) => error instanceof RequiredPluginCapabilitiesUnavailableError
      && error.diagnostics.length === 1
      && error.diagnostics[0]?.identity.instanceId === "broken-core"
      && error.diagnostics[0]?.error?.message === "fixture activation failed"
      && error.message.includes("broken-core: fixture activation failed")
  );
  await runtime.dispose();
});

test("an optional activation failure reports degraded health without removing core readiness", async () => {
  const runtime = createRuntime();
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const brokenOptional = candidate({
    instanceId: "optional",
    manifest: manifest("io.test.optional"),
    module: { activate() { throw new Error("optional dependency unavailable"); } }
  });

  const result = await runtime.switch([core, brokenOptional], { readyRequires: ["manager.core@1"] });
  assert.equal(result.generation.readiness.state, "degraded");
  assert.deepEqual(result.generation.readiness.missingCapabilities, []);
  assert.ok(result.generation.services.services.has("manager.core@1"));
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "optional")?.status, "failed");
  await runtime.dispose();
});

test("ready candidate selection excludes unrelated optional plugins and keeps the required dependency closure", () => {
  const hostProvided = candidate({
    instanceId: "host-only-consumer",
    manifest: manifest("io.test.host-only", {
      provides: ["manager.core@1"],
      requires: ["host.manager.core@1", "plugin.storage@1"]
    }),
    module: { activate() {} }
  });
  const storage = candidate({
    instanceId: "storage",
    manifest: manifest("io.test.storage", { provides: ["plugin.storage@1"] }),
    module: { activate() {} }
  });
  const unrelated = candidate({
    instanceId: "unrelated",
    manifest: manifest("io.test.unrelated", { provides: ["plugin.optional@1"] }),
    module: { activate() {} }
  });

  const selected = selectReadyPluginCandidates(
    [unrelated, hostProvided, storage],
    ["manager.core@1"],
    ["host.manager.core@1"]
  );
  assert.deepEqual(selected.map(item => item.instanceId), ["host-only-consumer", "storage"]);
});

test("a non-settling optional activation is bounded and cannot block core publication", async () => {
  const runtime = createRuntime({ activationTimeoutMs: 20 });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const hung = candidate({
    instanceId: "hung",
    manifest: manifest("io.test.hung"),
    module: { async activate() { await new Promise(() => {}); } }
  });

  const result = await runtime.switch([core, hung], { readyRequires: ["manager.core@1"] });
  assert.equal(result.generation.readiness.state, "degraded");
  assert.ok(result.generation.services.services.has("manager.core@1"));
  assert.match(
    result.generation.records.find(record => record.identity.instanceId === "hung")?.error?.message ?? "",
    /activation timed out.*20ms/i
  );
  await runtime.dispose();
});

test("an optional runtime failure degrades health while independent core stays active", async () => {
  let failOptional = (_error: unknown): void => {};
  let failureObserved!: () => void;
  const observed = new Promise<void>(resolve => { failureObserved = resolve; });
  const runtime = createRuntime({ onRuntimeFailure: () => failureObserved() });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const optional = candidate({
    instanceId: "optional",
    manifest: manifest("io.test.optional"),
    module: { activate(ctx) { failOptional = ctx.lifecycle.fail; } }
  });
  await runtime.switch([core, optional], { readyRequires: ["manager.core@1"] });
  failOptional(new Error("worker exhausted"));
  await observed;

  assert.equal(runtime.current().readiness.state, "degraded");
  assert.deepEqual(runtime.current().readiness.missingCapabilities, []);
  assert.ok(runtime.current().services.services.has("manager.core@1"));
  assert.equal(runtime.current().records.find(record => record.identity.instanceId === "core")?.status, "active");
  await runtime.dispose();
});

test("Effect lifecycle aborts before plugin disposers run", async () => {
  const runtime = createRuntime();
  const observed: boolean[] = [];
  await runtime.switch([candidate({
    instanceId: "signal",
    manifest: manifest("io.test.signal"),
    module: { activate(ctx) {
      ctx.effects.add(() => () => { observed.push(ctx.lifecycle.signal.aborted); });
    } }
  })]);
  await runtime.dispose();
  assert.deepEqual(observed, [true]);
});

test("GenerationRuntime records every superseded cleanup failure without skipping later scopes", async () => {
  const runtime = createRuntime();
  const disposed: string[] = [];
  const broken = (instanceId: string) => candidate({
    instanceId,
    manifest: manifest(`io.test.${instanceId}`),
    module: { activate(ctx) {
      ctx.effects.add(() => () => {
        disposed.push(instanceId);
        throw new Error(`cleanup ${instanceId} failed`);
      });
    } }
  });
  await runtime.switch([broken("one"), broken("two")]);
  const result = await runtime.switch([]);
  assert.deepEqual(disposed.sort(), ["one", "two"]);
  assert.deepEqual(result.generation.cleanupDiagnostics.map(item => item.instanceId).sort(), ["one", "two"]);
  assert.ok(result.generation.cleanupDiagnostics.every(item => item.phase === "superseded"));
});

test("GenerationRuntime shutdown attempts every active scope before reporting cleanup errors", async () => {
  const runtime = createRuntime();
  const disposed: string[] = [];
  const broken = (instanceId: string) => candidate({
    instanceId,
    manifest: manifest(`io.test.${instanceId}`),
    module: { activate(ctx) {
      ctx.effects.add(() => () => {
        disposed.push(instanceId);
        throw new Error(`shutdown ${instanceId} failed`);
      });
    } }
  });
  await runtime.switch([broken("one"), broken("two")]);
  await assert.rejects(runtime.dispose(), AggregateError);
  assert.deepEqual(disposed.sort(), ["one", "two"]);
  assert.equal(runtime.current().cleanupDiagnostics.filter(item => item.phase === "shutdown").length, 2);
});

test("GenerationRuntime removes a failed runtime component and publishes the fault", async () => {
  let reportFailure = (_error: unknown): void => {};
  let observedFailure: Promise<void>;
  let resolveFailure = (): void => {};
  observedFailure = new Promise(resolve => { resolveFailure = resolve; });
  const runtime = createRuntime({ onRuntimeFailure: () => { resolveFailure(); } });
  const provider = candidate({
    instanceId: "provider",
    manifest: manifest("io.test.provider", { provides: ["manager.core@1"] }),
    module: { activate(ctx) {
      ctx.services.provide("manager.core@1", { ready: true });
      reportFailure = ctx.lifecycle.fail;
    } }
  });
  const consumer = candidate({
    instanceId: "consumer",
    manifest: manifest("io.test.consumer", { requires: ["manager.core@1"] }),
    module: { activate(ctx) { assert.ok(ctx.services.require("manager.core@1")); } }
  });
  const independent = candidate({
    instanceId: "independent",
    manifest: manifest("io.test.independent"),
    module: { activate() {} }
  });
  await runtime.switch([provider, consumer, independent], { readyRequires: ["manager.core@1"] });
  reportFailure(new Error("child exited"));
  await observedFailure;
  const failed = runtime.current();
  assert.equal(failed.readiness.state, "degraded");
  assert.deepEqual(failed.readiness.missingCapabilities, ["manager.core@1"]);
  assert.equal(failed.records.find(record => record.identity.instanceId === "provider")?.error?.code, "runtime_failed");
  assert.equal(failed.records.find(record => record.identity.instanceId === "consumer")?.status, "waiting_dependency");
  assert.equal(failed.records.find(record => record.identity.instanceId === "independent")?.status, "active");
  assert.equal(failed.services.services.has("manager.core@1"), false);
  await runtime.dispose();
});

test("GenerationRuntime publishes required invalidation before bounded failed-plugin cleanup", async () => {
  let reportFailure = (_error: unknown): void => {};
  let observedRequiredReady: boolean | undefined;
  const observed = new Promise<void>(resolve => {
    const runtime = createRuntime({
      onRuntimeFailure: event => {
        observedRequiredReady = event.generation.readiness.missingCapabilities.length === 0;
        resolve();
      }
    });
    void runtime.switch([candidate({
      instanceId: "core",
      manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
      policy: {
        restart: { mode: "never", maxAttempts: 0, windowMs: 60_000, initialBackoffMs: 0, maximumBackoffMs: 1 },
        resources: { maxChildProcesses: 1, shutdownTimeoutMs: 20 }
      },
      module: { activate(ctx) {
        ctx.services.provide("manager.core@1", { ready: true });
        reportFailure = ctx.lifecycle.fail;
        ctx.effects.add(() => async () => { await new Promise(() => {}); }, "hung required cleanup");
      } }
    })], { readyRequires: ["manager.core@1"] }).then(() => reportFailure(new Error("core failed")));
  });

  await Promise.race([
    observed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("required invalidation publication timed out")), 100))
  ]);
  assert.equal(observedRequiredReady, false);
});
