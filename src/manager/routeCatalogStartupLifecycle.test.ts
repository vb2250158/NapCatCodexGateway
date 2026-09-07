import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ROUTE_CATALOG_STARTUP_ERROR_CODE,
  ROUTE_CATALOG_STARTUP_TIMEOUT_CODE,
  ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE,
  RouteCatalogStartupLifecycle,
  type RouteCatalogAttemptIdentity,
  type RouteCatalogStartupAttempt,
  type RouteCatalogStartupLifecycleSnapshot
} from "./routeCatalogStartupLifecycle.js";
import type {
  RouteCatalogSnapshot,
  RouteCatalogTransactionOperation
} from "./routeCatalogTransaction.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

function catalog(
  identity: RouteCatalogAttemptIdentity,
  ids: readonly string[] = []
): RouteCatalogSnapshot {
  const content = {
    routeRoot: "C:\\route",
    rolesRoot: "C:\\roles",
    gateways: ids.map((id, index) => ({
      id,
      configName: id,
      gatewayPort: 20_000 + index
    })),
    personas: []
  };
  const identities = routeCatalogSnapshotIdentities(content);
  return Object.freeze({
    requestId: identity.requestId,
    attemptToken: identity.attemptToken,
    ...identities,
    ...content
  });
}

test("route mutation waits for asynchronous process reconciliation before publishing ready", async () => {
  const applied = deferred<void>();
  let applying = false;
  const lifecycle = new RouteCatalogStartupLifecycle({
    async apply() { applying = true; await applied.promise; },
    attemptFactory(_operation, identity) { return { result: Promise.resolve(catalog(identity)), async cancel() {} }; }
  });
  lifecycle.start();
  await waitFor(() => applying, "apply was not invoked");
  assert.equal(lifecycle.snapshot().state, "running");
  applied.resolve();
  await waitFor(() => lifecycle.snapshot().state === "ready", "reconciliation never completed");
  await lifecycle.stop();
});

test("route catalog failure degrades, retries one confirmed-exit child, applies, then becomes ready", async () => {
  const second = deferred<RouteCatalogSnapshot>();
  const statuses: RouteCatalogStartupLifecycleSnapshot[] = [];
  const failures: Error[] = [];
  const events: string[] = [];
  let attempts = 0;
  let cancels = 0;
  let secondIdentity: RouteCatalogAttemptIdentity | undefined;
  const lifecycle = new RouteCatalogStartupLifecycle({
    retryBaseMs: 5,
    retryMaxMs: 5,
    maxAttempts: 3,
    apply(snapshot) {
      events.push(`apply:${snapshot.gateways.length}`);
    },
    onStatus: status => statuses.push(status),
    onFailure: error => failures.push(error),
    attemptFactory(_operation, identity): RouteCatalogStartupAttempt {
      attempts += 1;
      if (attempts === 1) {
        return {
          pid: 101,
          result: Promise.reject(new Error("private \\server\\roles path")),
          async cancel() { cancels += 1; }
        };
      }
      secondIdentity = identity;
      return {
        pid: 102,
        result: second.promise,
        async cancel() { cancels += 1; }
      };
    }
  });
  lifecycle.onReady(() => { events.push("ready"); });

  lifecycle.start();
  await waitFor(
    () => lifecycle.snapshot().state === "running" && lifecycle.snapshot().attempt === 2,
    "route catalog retry did not start after confirmed child exit"
  );
  assert.ok(secondIdentity);
  second.resolve(catalog(secondIdentity, ["Rabi"]));
  await waitFor(() => lifecycle.snapshot().state === "ready", "route catalog did not become ready");

  assert.equal(attempts, 2);
  assert.equal(cancels, 1);
  assert.deepEqual(events, ["apply:1", "ready"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /private/);
  assert.deepEqual(statuses.map(status => status.state), ["running", "degraded", "running", "ready"]);
  assert.equal(statuses[1].lastErrorCode, ROUTE_CATALOG_STARTUP_ERROR_CODE);
  assert.equal(JSON.stringify(statuses[1]).includes("server"), false);
});

test("attempt timeout waits for confirmed termination before retry and never overlaps replacements", async () => {
  const cancelled = deferred<void>();
  const never = deferred<RouteCatalogSnapshot>();
  let attempts = 0;
  let cancelCalls = 0;
  const lifecycle = new RouteCatalogStartupLifecycle({
    attemptTimeoutMs: 10,
    retryBaseMs: 5,
    retryMaxMs: 5,
    apply() {},
    attemptFactory(_operation, identity) {
      attempts += 1;
      if (attempts === 1) {
        return {
          pid: 201,
          result: never.promise,
          cancel() {
            cancelCalls += 1;
            return cancelled.promise;
          }
        };
      }
      return {
        pid: 202,
        result: Promise.resolve(catalog(identity, ["retry"])),
        async cancel() {}
      };
    }
  });

  lifecycle.start();
  await waitFor(() => cancelCalls === 1, "timed out route catalog child was not terminated");
  await new Promise<void>(resolve => setTimeout(resolve, 25));
  assert.equal(attempts, 1, "replacement child started before previous child exit confirmation");
  cancelled.resolve();
  await waitFor(() => lifecycle.snapshot().state === "ready", "retry did not recover after termination confirmation");
  assert.equal(attempts, 2);
  assert.ok(lifecycle.snapshot().attempt >= 2);
});

test("unconfirmed termination blocks retry and stop remains failed with the child pid until late exit", async () => {
  const lateExit = deferred<RouteCatalogSnapshot>();
  let attempts = 0;
  let cancels = 0;
  const lifecycle = new RouteCatalogStartupLifecycle({
    attemptTimeoutMs: 10,
    retryBaseMs: 5,
    retryMaxMs: 5,
    apply() {},
    attemptFactory() {
      attempts += 1;
      return {
        pid: 301,
        result: lateExit.promise,
        cancel() {
          cancels += 1;
          return Promise.reject(new Error("termination not confirmed"));
        }
      };
    }
  });

  lifecycle.start();
  await waitFor(
    () => lifecycle.snapshot().lastErrorCode === ROUTE_CATALOG_TERMINATION_UNCONFIRMED_CODE,
    "unconfirmed termination did not hard-block the lifecycle"
  );
  await new Promise<void>(resolve => setTimeout(resolve, 25));
  assert.equal(attempts, 1);
  assert.equal(lifecycle.snapshot().childPid, 301);
  assert.equal(lifecycle.snapshot().nextRetryAt, undefined);

  const firstStop = lifecycle.stop();
  const concurrentStop = lifecycle.stop();
  assert.strictEqual(firstStop, concurrentStop);
  await assert.rejects(firstStop, /termination not confirmed/);
  assert.equal(lifecycle.snapshot().state, "degraded");
  assert.equal(lifecycle.snapshot().childPid, 301);
  assert.ok(cancels >= 2);

  lateExit.reject(new Error("child finally closed"));
  await waitFor(() => lifecycle.snapshot().childPid === undefined, "late child exit was not observed");
  await lifecycle.stop();
  assert.equal(lifecycle.snapshot().state, "stopped");
});

test("stop shares one stopFlight, awaits cancellation, and fences a late successful result", async () => {
  const result = deferred<RouteCatalogSnapshot>();
  const cancelled = deferred<void>();
  let identity: RouteCatalogAttemptIdentity | undefined;
  let applies = 0;
  const lifecycle = new RouteCatalogStartupLifecycle({
    apply() { applies += 1; },
    attemptFactory(_operation, attemptIdentity) {
      identity = attemptIdentity;
      return {
        pid: 401,
        result: result.promise,
        cancel: () => cancelled.promise
      };
    }
  });
  lifecycle.start();
  await waitFor(() => lifecycle.snapshot().state === "running", "route catalog child did not start");

  const firstStop = lifecycle.stop();
  const secondStop = lifecycle.stop();
  assert.strictEqual(firstStop, secondStop);
  let stopped = false;
  void firstStop.then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  cancelled.resolve();
  await firstStop;
  assert.ok(identity);
  result.resolve(catalog(identity, ["late"]));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(applies, 0);
  assert.equal(lifecycle.snapshot().state, "stopped");
});

test("a direct stop cancellation failure keeps the pid until late close, then a second stop succeeds", async () => {
  const lateClose = deferred<RouteCatalogSnapshot>();
  let cancels = 0;
  const lifecycle = new RouteCatalogStartupLifecycle({
    apply() {},
    attemptFactory() {
      return {
        pid: 451,
        result: lateClose.promise,
        cancel() {
          cancels += 1;
          return Promise.reject(new Error("direct stop could not confirm child exit"));
        }
      };
    }
  });
  lifecycle.start();
  await waitFor(() => lifecycle.snapshot().state === "running", "route catalog child did not start");

  await assert.rejects(lifecycle.stop(), /could not confirm child exit/);
  assert.equal(lifecycle.snapshot().state, "degraded");
  assert.equal(lifecycle.snapshot().childPid, 451);
  assert.equal(cancels, 1);

  lateClose.reject(new Error("child closed after cancellation deadline"));
  await waitFor(() => lifecycle.snapshot().childPid === undefined, "late direct-stop close did not clear pid");
  await lifecycle.stop();
  assert.equal(lifecycle.snapshot().state, "stopped");
});

test("route catalog queue is bounded across the active attempt and waiting mutations", async () => {
  const active = deferred<RouteCatalogSnapshot>();
  const queuedAttempt = deferred<RouteCatalogSnapshot>();
  let activeIdentity: RouteCatalogAttemptIdentity | undefined;
  let attempts = 0;
  const lifecycle = new RouteCatalogStartupLifecycle({
    maxPending: 2,
    apply() {},
    attemptFactory(_operation, identity) {
      attempts += 1;
      activeIdentity = identity;
      return { result: attempts === 1 ? active.promise : queuedAttempt.promise, async cancel() {} };
    }
  });
  lifecycle.start();
  await waitFor(() => lifecycle.snapshot().state === "running", "route catalog capture did not start");
  const queued = lifecycle.upsert({ id: "B", configName: "B", gatewayPort: 20_002 });
  await assert.rejects(
    lifecycle.upsert({ id: "C", configName: "C", gatewayPort: 20_003 }),
    (error: unknown) => (error as { code?: unknown }).code === "ROUTE_CATALOG_BUSY"
  );
  assert.ok(activeIdentity);
  active.resolve(catalog(activeIdentity, ["A"]));
  await waitFor(() => attempts === 2, "queued mutation did not start");
  await lifecycle.stop();
  await assert.rejects(queued, /stopped/);
});

test("startup capture and concurrent mutations are strictly serialized and each apply carries its own echo fence", async () => {
  const attempts: Array<{
    operation: RouteCatalogTransactionOperation;
    identity: RouteCatalogAttemptIdentity;
    completion: ReturnType<typeof deferred<RouteCatalogSnapshot>>;
  }> = [];
  const applied: string[][] = [];
  const lifecycle = new RouteCatalogStartupLifecycle({
    apply(snapshot) {
      applied.push(snapshot.gateways.map(item => item.id));
    },
    attemptFactory(operation, identity) {
      const completion = deferred<RouteCatalogSnapshot>();
      attempts.push({ operation, identity, completion });
      return { result: completion.promise, async cancel() {} };
    }
  });

  lifecycle.start();
  const firstMutation = lifecycle.upsert({ id: "B", configName: "B", gatewayPort: 20_002 });
  const secondMutation = lifecycle.upsert({ id: "C", configName: "C", gatewayPort: 20_003 });
  await waitFor(() => attempts.length === 1, "startup capture did not start");
  assert.equal(attempts[0].operation.kind, "capture");
  attempts[0].completion.resolve(catalog(attempts[0].identity, ["A"]));
  await waitFor(() => attempts.length === 2, "queued mutation did not start after capture closed");
  assert.equal(attempts[1].operation.kind, "upsert");
  attempts[1].completion.resolve(catalog(attempts[1].identity, ["A", "B"]));
  await firstMutation;
  await waitFor(() => attempts.length === 3, "second queued mutation overlapped or did not start");
  assert.equal(attempts[2].operation.kind, "upsert");
  attempts[2].completion.resolve(catalog(attempts[2].identity, ["A", "B", "C"]));
  await secondMutation;

  assert.equal(attempts.length, 3);
  assert.notEqual(attempts[0].identity.attemptToken, attempts[1].identity.attemptToken);
  assert.notEqual(attempts[1].identity.attemptToken, attempts[2].identity.attemptToken);
  assert.deepEqual(applied, [["A"], ["A", "B"], ["A", "B", "C"]]);
});

test("Manager publishes fenced READY before route catalog recovery and gates HTTP until a snapshot is installed", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./controlPlaneRoutes.ts", import.meta.url)), "utf8");
  const desktopSource = fs.readFileSync(fileURLToPath(new URL("./desktopControlRoutes.ts", import.meta.url)), "utf8");
  const desktopPluginSource = fs.readFileSync(fileURLToPath(new URL(
    "../../plugins/builtin/io.rabiroute.manager.desktop/1.0.0/manager.mjs",
    import.meta.url
  )), "utf8");
  const routeControlPluginSource = fs.readFileSync(fileURLToPath(new URL(
    "../../plugins/builtin/io.rabiroute.manager.route-control/1.0.0/manager.mjs",
    import.meta.url
  )), "utf8");
  const roleInfoSource = fs.readFileSync(fileURLToPath(new URL("./roleInfoPayload.ts", import.meta.url)), "utf8");
  const personaMessagingSource = fs.readFileSync(fileURLToPath(new URL("./personaMessagingRoutes.ts", import.meta.url)), "utf8");
  const speechSource = fs.readFileSync(fileURLToPath(new URL("./speechControl.ts", import.meta.url)), "utf8");
  const transactionSource = fs.readFileSync(fileURLToPath(new URL("./routeCatalogTransaction.ts", import.meta.url)), "utf8");
  const startManagerSource = source.slice(source.indexOf("export async function startManager"));
  const readyIndex = startManagerSource.indexOf("console.log(managerReadyLine({");
  const routeCatalogStartIndex = startManagerSource.indexOf("routeCatalogStartupLifecycle.start();");

  assert.ok(readyIndex >= 0, "Manager structured READY publication is missing");
  assert.ok(routeCatalogStartIndex > readyIndex, "route catalog recovery must start only after fenced Manager READY");
  assert.match(source, /routeCatalogStartupUnavailable\([\s\S]*?routeCatalogStartupLifecycle\.snapshot\(\)[\s\S]*?\)/);
  assert.match(source, /response\.setHeader\("cache-control", "no-store"\)/);
  assert.match(source, /response\.setHeader\("retry-after", String\(routeCatalogRejection\.retryAfterSeconds\)\)/);
  const syncRunningGatewaysSource = source.slice(
    source.indexOf("function syncRunningGateways"),
    source.indexOf("async function reloadChangedConfig")
  );
  const startGatewayRuntimeSource = source.slice(
    source.indexOf("function startGatewayRuntime"),
    source.indexOf("function stopGatewayRuntime")
  );
  assert.doesNotMatch(syncRunningGatewaysSource, /planStorageStartupStatus/);
  assert.doesNotMatch(syncRunningGatewaysSource, /roleKnowledgeCatalogsReady/);
  assert.doesNotMatch(startGatewayRuntimeSource, /planStorageStartupStatus/);
  const routeCatalogReadyHandler = startManagerSource.slice(
    startManagerSource.indexOf("routeCatalogStartupLifecycle.onReady"),
    startManagerSource.indexOf("const lanDiscoveryEnabled")
  );
  assert.match(routeCatalogReadyHandler, /syncRunningGateways\(\);[\s\S]*?startPlanDependentBackground\(\)/);
  assert.match(source, /roleKnowledgeCatalogsReady = await prewarmRolePlanCatalogs\(\);/);
  assert.equal(source.includes("readConfigAsync"), false);
  assert.equal(source.includes("loadRuntimesAsync"), false);
  assert.equal(source.includes("configRepository.readRoleMessageConfigAsync"), false);
  assert.match(source, /input:\s*\(\) => \(\{[\s\S]*?routeRoot,[\s\S]*?rolesRoot,[\s\S]*?readOnly: managerReadOnly/);
  assert.match(source, /apply: applyRouteCatalogSnapshot/);
  assert.match(source, /await routeCatalogLifecycle\.recapture\(\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.replace\(normalized, expectedContentHash, operationId\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.upsert\(desired\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.remove\(configName, expectedContentHash, operationId\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.ensurePersona\(roleId\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.ensureRoleFile\(roleId, roleFile\)/);
  assert.match(source, /await requireRouteCatalogLifecycle\(\)\.ensureRoleFolder\(roleId\)/);
  assert.match(source, /contentHash: snapshot\.routeConfigHash/);
  assert.match(transactionSource, /expected !== snapshot\.routeConfigHash/);
  assert.match(transactionSource, /presentationHash/);
  assert.doesNotMatch(desktopSource, /node:fs|writeFileSync|mkdirSync|existsSync/);
  assert.match(desktopSource, /await context\.ensurePersonaConfigFile\(safeRoleId\)/);
  assert.match(desktopSource, /await context\.writeAdapterConfigFile\(route\)/);
  assert.match(desktopPluginSource, /ensureRoleFile: runtime\.ensureRoleFile/);
  assert.match(routeControlPluginSource, /await runtime\.ensureDataDirs\(\)/);
  assert.doesNotMatch(roleInfoSource, /node:fs|PersonaCatalog|readFileSync|readdirSync|statSync|existsSync/);
  assert.doesNotMatch(personaMessagingSource, /PersonaCatalog|catalog\.list|readdirSync|readFileSync|statSync|existsSync/);
  const speechPersonaSource = speechSource.slice(
    speechSource.indexOf("  personas():"),
    speechSource.indexOf("  async playbackStatus")
  );
  assert.doesNotMatch(speechPersonaSource, /fs\.|path\.|readdirSync|readFileSync|statSync|existsSync/);
  assert.equal(
    source.match(/memoryConsolidationScheduler\?\.start\(\)/g)?.length,
    1,
    "memory scheduler must have one plan+route-gated start owner"
  );
  const gatedStart = source.indexOf("const startPlanDependentBackground");
  const memoryStart = source.indexOf("memoryConsolidationScheduler?.start()");
  const lifecycleSubscriptions = source.indexOf("planStorageStartupLifecycle.onReady", gatedStart);
  assert.ok(memoryStart > gatedStart && memoryStart < lifecycleSubscriptions);
});

test("route catalog child diagnostics remain opaque outside the child boundary", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./routeCatalogStartupLifecycle.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /diagnosticTail|diagnostics=/);
  assert.doesNotMatch(source, /childResult\.error\b|reject\(processError\)/);
  assert.match(source, /diagnosticBytes/);
  assert.match(source, /Route catalog transaction failed\./);
});
