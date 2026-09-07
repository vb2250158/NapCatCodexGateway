import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ManagerWatchBroker,
  isUncPath,
  publicManagerWatchBrokerStatus,
  spawnConfigWatchSnapshotAttempt,
  type ConfigWatchSnapshotAttempt,
  type ManagerWatchDiagnostic,
  type ConfigWatchSnapshotResult
} from "./managerWatchBroker.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for config watch broker state.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test health server did not bind TCP.");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("UNC detection is independent of the current platform path implementation", () => {
  assert.equal(isUncPath("\\\\example-host\\example-share\\project"), true);
  assert.equal(isUncPath("//example-host/example-share/project"), true);
  assert.equal(isUncPath("G:\\ExampleApp\\data\\route"), false);
  assert.equal(isUncPath("C:\\RabiRoute\\data"), false);
  assert.equal(isUncPath("/var/lib/rabiroute"), false);
});

test("public watch status exposes stable diagnostics without local or NAS error paths", () => {
  const status = publicManagerWatchBrokerStatus({
    state: "degraded",
    partial: true,
    errors: ["\\\\example-host\\private-share\\route: EACCES", "C:\\Users\\example-user\\private.json"],
    attempts: 3,
    timeouts: 1,
    restarts: 2,
    activeWorkerPid: 41_007,
    lastSuccessAt: "2026-09-01T00:00:00.000Z"
  });

  assert.deepEqual(status, {
    state: "degraded",
    partial: true,
    errorCount: 2,
    lastErrorCode: "MANAGER_WATCH_DEGRADED",
    attempts: 3,
    timeouts: 1,
    restarts: 2,
    activeWorkerPid: 41_007,
    lastSuccessAt: "2026-09-01T00:00:00.000Z"
  });
  assert.doesNotMatch(JSON.stringify(status), /example-host|Users|private\.json/);
});

test("a ten-second UNC snapshot hang is killed, retried, and never blocks a real health socket", async (t) => {
  const firstResult = deferred<ConfigWatchSnapshotResult>();
  let longHangTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let terminated = 0;
  let firstClosedAt = 0;
  let secondStartedAt = 0;
  const terminationSignals: string[] = [];
  const lifecycleStates: string[] = [];
  const diagnostics: ManagerWatchDiagnostic[] = [];
  const createAttempt = (): ConfigWatchSnapshotAttempt => {
    attempts += 1;
    if (attempts === 2) secondStartedAt = performance.now();
    const closed = deferred<void>();
    if (attempts === 1) {
      longHangTimer = setTimeout(() => firstResult.resolve({
        files: [],
        snapshot: "late",
        partial: false,
        errors: []
      }), 10_000);
      longHangTimer.unref();
      return {
        pid: 41_001,
        result: firstResult.promise,
        closed: closed.promise,
        terminate(signal = "SIGTERM") {
          terminated += 1;
          terminationSignals.push(signal);
          if (longHangTimer) clearTimeout(longHangTimer);
          if (signal === "SIGKILL") {
            setTimeout(() => {
              firstClosedAt = performance.now();
              closed.resolve();
            }, 5);
          }
        }
      };
    }
    const result = new Promise<ConfigWatchSnapshotResult>(resolve => setTimeout(() => resolve({
      files: [],
      snapshot: "recovered",
      partial: false,
      errors: []
    }), 20));
    return {
      pid: 41_002,
      result,
      closed: closed.promise,
      terminate() {
        terminated += 1;
        closed.resolve();
      }
    };
  };

  const broker = new ManagerWatchBroker({
    request: {
      routeRoot: "G:\\ExampleApp\\data\\route",
      rolesRoot: "\\\\example-host\\example-share\\project\\data\\roles",
      explicitFiles: ["G:\\ExampleApp\\data\\manager.json"],
      operationTimeoutMs: 1_500
    },
    attemptTimeoutMs: 40,
    terminationCloseTimeoutMs: 10,
    forceTerminationCloseTimeoutMs: 20,
    retryDelayMs: 5,
    remotePollIntervalMs: 60_000,
    createAttempt,
    watchDirectory(directory) {
      assert.equal(isUncPath(directory), false, "UNC paths must never reach Manager fs.watch");
      return { close() {} };
    },
    onSnapshot: async () => {},
    onStatus: status => lifecycleStates.push(status.state),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic)
  });
  t.after(() => broker.close());

  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ live: true, configWatch: broker.status() }));
  });
  t.after(() => closeServer(server));
  const port = await listen(server);

  broker.start();
  const durations: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    durations.push(performance.now() - startedAt);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { live: boolean }).live, true);
    await new Promise(resolve => setTimeout(resolve, 8));
  }

  await waitFor(() => broker.status().state === "ready");
  assert.equal(attempts, 2);
  assert.equal(broker.status().timeouts, 1);
  assert.equal(broker.status().restarts, 1);
  assert.equal(broker.status().partial, false);
  assert.deepEqual(terminationSignals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
  assert.ok(secondStartedAt >= firstClosedAt, "replacement starts only after the killed child closes");
  assert.ok(terminated >= 2, "both the timed-out and completed one-shot workers are reaped");
  assert.ok(lifecycleStates.includes("degraded"));
  assert.deepEqual(diagnostics.map(item => item.event), ["manager_watch_degraded", "manager_watch_recovered"]);
  assert.equal(diagnostics[0]!.status.activeWorkerPid, 41_001);
  assert.equal(diagnostics[0]!.timeoutMs, 40);
  assert.ok(diagnostics[0]!.durationMs >= 35);
  assert.match(diagnostics[0]!.error!.stack!, /Manager watch snapshot worker exceeded/);
  assert.equal(diagnostics[1]!.status.activeWorkerPid, 41_002);
  assert.equal(diagnostics[1]!.status.restarts, 1);
  assert.equal(diagnostics[1]!.error, undefined);
  assert.ok(Math.max(...durations) < 250, `health response exceeded budget: ${Math.max(...durations)}ms`);
});

test("an unconfirmed hard kill stays degraded without stacking another worker", async (t) => {
  const hanging = deferred<ConfigWatchSnapshotResult>();
  const neverClosed = deferred<void>();
  const terminationSignals: string[] = [];
  let attempts = 0;
  const diagnostics: ManagerWatchDiagnostic[] = [];
  const broker = new ManagerWatchBroker({
    request: {
      routeRoot: "G:\\ExampleApp\\data\\route",
      rolesRoot: "\\\\example-host\\example-share\\project\\data\\roles"
    },
    attemptTimeoutMs: 20,
    terminationCloseTimeoutMs: 10,
    forceTerminationCloseTimeoutMs: 10,
    retryDelayMs: 5,
    createAttempt: () => {
      attempts += 1;
      return {
        pid: 41_006,
        result: hanging.promise,
        closed: neverClosed.promise,
        terminate(signal = "SIGTERM") {
          terminationSignals.push(signal);
        }
      };
    },
    onSnapshot: async () => {},
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic);
      throw new Error("diagnostic sink unavailable");
    }
  });
  t.after(() => broker.close());

  broker.start();
  await waitFor(() => broker.status().errors.some(error => error.startsWith("termination_failed:")));
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(broker.status().state, "degraded");
  assert.equal(broker.status().partial, true);
  assert.equal(broker.status().activeWorkerPid, 41_006);
  assert.equal(attempts, 1, "an unconfirmed child must not overlap a replacement");
  assert.deepEqual(terminationSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(diagnostics.length, 2, "timeout and unconfirmed termination are separate incidents");
  assert.match(diagnostics[1]!.error!.message, /termination_failed:/);
  assert.equal(diagnostics[1]!.status.activeWorkerPid, 41_006);

  const closeStartedAt = performance.now();
  broker.close();
  await assert.rejects(broker.closed(), /termination_failed:/);
  assert.ok(performance.now() - closeStartedAt < 100, "broker.close must reject within its termination deadlines");
  assert.equal(broker.status().state, "degraded");
  assert.equal(broker.status().partial, true);
  assert.equal(broker.status().activeWorkerPid, 41_006);
});

test("plugin roots share the broker: local trees use native watch and UNC trees only use child polling", async (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plugin-watch-local-"));
  cleanupRoots.push(localRoot);
  const remoteRoot = "\\\\example-host\\example-share\\project\\plugins";
  const unprovenDriveRoot = "G:\\ExampleApp\\plugins";
  const watched: Array<{ directory: string; recursive: boolean }> = [];
  const ensured: string[] = [];
  const closed: string[] = [];
  const attemptClosed = deferred<void>();
  const snapshots: string[] = [];
  const broker = new ManagerWatchBroker({
    request: { kind: "plugin_tree", roots: [localRoot, remoteRoot, unprovenDriveRoot] },
    remotePollIntervalMs: 60_000,
    createAttempt: () => ({
      pid: 41_005,
      result: Promise.resolve({
        files: [
          path.join(localRoot, "bundle.json"),
          `${remoteRoot}\\bundle.json`,
          `${unprovenDriveRoot}\\bundle.json`
        ],
        snapshot: "plugin-snapshot-a",
        partial: false,
        errors: []
      }),
      closed: attemptClosed.promise,
      terminate: () => attemptClosed.resolve()
    }),
    watchDirectory(directory, options) {
      watched.push({ directory, recursive: options.recursive === true });
      return { close: () => closed.push(directory) };
    },
    ensureLocalDirectory(directory) {
      ensured.push(directory);
    },
    onSnapshot: result => { snapshots.push(result.snapshot); }
  });
  t.after(() => broker.close());

  broker.start();
  await waitFor(() => broker.status().state === "ready");

  assert.deepEqual(watched, [{ directory: path.resolve(localRoot), recursive: true }]);
  assert.deepEqual(ensured, [path.resolve(localRoot)]);
  assert.equal(watched.some(item => isUncPath(item.directory)), false);
  assert.deepEqual(snapshots, ["plugin-snapshot-a"]);
  broker.close();
  await broker.closed();
  assert.deepEqual(closed, [path.resolve(localRoot)]);
  assert.equal(broker.status().activeWorkerPid, undefined);
});

test("only local directories are armed with fs.watch while UNC directories use polling", async (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-config-watch-local-"));
  cleanupRoots.push(localRoot);
  const localRouteRoot = path.join(localRoot, "route");
  const remoteRolesRoot = "\\\\example-host\\example-share\\project\\data\\roles";
  fs.mkdirSync(localRouteRoot, { recursive: true });
  const watched: string[] = [];
  const closed: string[] = [];
  const attemptClosed = deferred<void>();
  const broker = new ManagerWatchBroker({
    request: {
      routeRoot: localRouteRoot,
      rolesRoot: remoteRolesRoot,
      explicitFiles: [path.join(localRoot, "manager.json")]
    },
    remotePollIntervalMs: 60_000,
    createAttempt: () => ({
      pid: 41_003,
      result: Promise.resolve({
        files: [
          path.join(localRouteRoot, "YeYu", "adapterConfig.json"),
          path.join(localRoot, "manager.json"),
          `${remoteRolesRoot}\\YeYu\\personaConfig.json`
        ],
        snapshot: "snapshot-a",
        partial: false,
        errors: []
      }),
      closed: attemptClosed.promise,
      terminate: () => attemptClosed.resolve()
    }),
    watchDirectory(directory) {
      watched.push(directory);
      return { close: () => closed.push(directory) };
    },
    onSnapshot: async () => {}
  });
  t.after(() => broker.close());

  broker.start();
  await waitFor(() => broker.status().state === "ready");

  assert.ok(watched.includes(path.resolve(localRouteRoot)));
  assert.ok(watched.includes(path.resolve(localRoot)));
  assert.equal(watched.some(isUncPath), false);
  broker.close();
  await broker.closed();
  assert.deepEqual(new Set(closed), new Set(watched));
  assert.equal(broker.status().activeWorkerPid, undefined);
});

test("a completed one-shot worker may exit naturally before termination is attempted", async (t) => {
  const closed = deferred<void>();
  let terminationAttempts = 0;
  const broker = new ManagerWatchBroker({
    request: {
      routeRoot: "G:\\ExampleApp\\data\\route",
      rolesRoot: "G:\\ExampleApp\\data\\roles"
    },
    terminationCloseTimeoutMs: 50,
    remotePollIntervalMs: 60_000,
    createAttempt: () => ({
      pid: 41_008,
      result: Promise.resolve({
        files: [],
        snapshot: "snapshot-a",
        partial: false,
        errors: []
      }),
      closed: closed.promise,
      terminate() {
        terminationAttempts += 1;
        closed.resolve();
      }
    }),
    onSnapshot: async () => {}
  });
  t.after(() => broker.close());

  setTimeout(() => closed.resolve(), 10);
  broker.start();
  await waitFor(() => broker.status().activeWorkerPid === undefined);

  assert.equal(terminationAttempts, 0);
  assert.equal(broker.status().state, "ready");
  assert.deepEqual(broker.status().errors, []);
});

test("close terminates an active worker and suppresses timeout retries", async () => {
  const hanging = deferred<ConfigWatchSnapshotResult>();
  const closed = deferred<void>();
  let attempts = 0;
  let terminated = 0;
  const broker = new ManagerWatchBroker({
    request: {
      routeRoot: "G:\\ExampleApp\\data\\route",
      rolesRoot: "\\\\example-host\\example-share\\project\\data\\roles"
    },
    attemptTimeoutMs: 30,
    retryDelayMs: 5,
    createAttempt: () => {
      attempts += 1;
      return {
        pid: 41_004,
        result: hanging.promise,
        closed: closed.promise,
        terminate() {
          terminated += 1;
          closed.resolve();
        }
      };
    },
    onSnapshot: async () => {}
  });

  broker.start();
  await waitFor(() => broker.status().activeWorkerPid === 41_004);
  broker.close();
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(terminated, 1);
  assert.equal(attempts, 1);
  assert.equal(broker.status().state, "closed");
  assert.equal(broker.status().activeWorkerPid, undefined);
});

test("the production snapshot attempt exits after reading a local fixture", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-config-watch-worker-"));
  cleanupRoots.push(root);
  const routeRoot = path.join(root, "route");
  const rolesRoot = path.join(root, "roles");
  fs.mkdirSync(path.join(routeRoot, "route-a"), { recursive: true });
  fs.mkdirSync(path.join(rolesRoot, "YeYu"), { recursive: true });
  fs.writeFileSync(path.join(routeRoot, "route-a", "adapterConfig.json"), "{}", "utf8");
  fs.writeFileSync(path.join(rolesRoot, "YeYu", "personaConfig.json"), "{}", "utf8");

  const attempt = spawnConfigWatchSnapshotAttempt({ routeRoot, rolesRoot, operationTimeoutMs: 500 });
  t.after(() => attempt.terminate());
  const result = await attempt.result;
  await attempt.closed;

  assert.equal(result.partial, false);
  assert.ok(result.files.includes(path.join(routeRoot, "route-a", "adapterConfig.json")));
  assert.ok(result.files.includes(path.join(rolesRoot, "YeYu", "personaConfig.json")));
});
