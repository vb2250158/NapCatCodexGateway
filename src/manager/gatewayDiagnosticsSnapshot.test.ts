import assert from "node:assert/strict";
import http from "node:http";
import { Worker } from "node:worker_threads";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  GatewayDiagnosticsSnapshotService,
  type GatewayDiagnosticsWorkerResult
} from "./gatewayDiagnosticsSnapshot.js";

const initialSnapshot: GatewayDiagnosticsWorkerResult = {
  diagnostics: [{ id: "route-a", marker: "cached-diagnostics" }],
  summary: [{ id: "route-a", marker: "cached-summary" }],
  refreshedAt: "2026-09-01T08:00:00.000Z"
};

test("a stuck diagnostics worker cannot delay the real Manager health HTTP response", async () => {
  let worker: Worker | undefined;
  let markWorkerStarted = (): void => {};
  const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
  const service = new GatewayDiagnosticsSnapshotService({
    capture: () => ({ runtimes: [], personaPresentations: [] }),
    initialSnapshot,
    minRefreshIntervalMs: 0,
    load: async () => {
      worker = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.postMessage("started");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      `, { eval: true });
      worker.once("message", () => markWorkerStarted());
      return await new Promise<GatewayDiagnosticsWorkerResult>((_resolve, reject) => {
        worker!.once("error", reject);
        worker!.once("exit", code => reject(new Error(`diagnostics fixture worker exited: ${code}`)));
      });
    }
  });

  const server = http.createServer((request, response) => {
    if (request.url === "/gateways") {
      service.requestRefresh({ force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: service.read(true) }));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ health: { live: true } }));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const gateways = await fetch(`${baseUrl}/gateways`);
    assert.equal(gateways.status, 200);
    const gatewaysBody = await gateways.json() as any;
    assert.deepEqual(gatewaysBody.data.records, initialSnapshot.diagnostics);
    assert.equal(gatewaysBody.data.revision, 1);
    assert.equal(gatewaysBody.data.state, "refreshing");
    assert.equal(typeof gatewaysBody.data.refreshStartedAt, "string");
    await workerStarted;

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 750);
    const startedAt = performance.now();
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      assert.equal(health.status, 200);
      assert.equal((await health.json() as any).health.live, true);
      assert.ok(performance.now() - startedAt < 750);
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await worker?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("published diagnostics snapshots are structurally copied, deeply frozen, and monotonically revised", async () => {
  const mutableInitial = {
    diagnostics: [{ id: "route-a", nested: { marker: "initial" } }],
    summary: [{ id: "route-a", nested: { marker: "initial-summary" } }],
    refreshedAt: "2026-09-01T08:00:00.000Z"
  } satisfies GatewayDiagnosticsWorkerResult;
  const mutableRefresh = {
    diagnostics: [{ id: "route-a", nested: { marker: "refreshed" } }],
    summary: [{ id: "route-a", nested: { marker: "refreshed-summary" } }],
    refreshedAt: "2026-09-01T08:01:00.000Z"
  } satisfies GatewayDiagnosticsWorkerResult;
  const service = new GatewayDiagnosticsSnapshotService({
    capture: () => ({ runtimes: [], personaPresentations: [] }),
    initialSnapshot: mutableInitial,
    minRefreshIntervalMs: 0,
    now: () => Date.parse("2026-09-01T08:00:30.000Z"),
    load: async () => mutableRefresh
  });

  (mutableInitial.diagnostics[0]!.nested as { marker: string }).marker = "mutated-outside";
  const initial = service.read(true);
  assert.equal((initial.records[0]!.nested as { marker: string }).marker, "initial");
  assert.equal(initial.revision, 1);
  assert.equal(initial.state, "ready");
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.records));
  assert.ok(Object.isFrozen(initial.records[0]!.nested));
  assert.throws(() => {
    (initial.records[0]!.nested as { marker: string }).marker = "mutated-through-read";
  }, TypeError);

  await service.refresh({ force: true });
  (mutableRefresh.diagnostics[0]!.nested as { marker: string }).marker = "mutated-after-commit";
  const refreshed = service.read(true);
  assert.equal((refreshed.records[0]!.nested as { marker: string }).marker, "refreshed");
  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.state, "ready");
  assert.equal(refreshed.refreshStartedAt, "2026-09-01T08:00:30.000Z");
  assert.equal(refreshed.refreshedAt, mutableRefresh.refreshedAt);
});

test("warming and failed refreshes expose lifecycle state without publishing a partial revision", async () => {
  const service = new GatewayDiagnosticsSnapshotService({
    capture: () => ({ runtimes: [], personaPresentations: [] }),
    minRefreshIntervalMs: 0,
    load: async () => { throw new Error("NAS diagnostics unavailable"); }
  });

  assert.deepEqual(service.read(false), {
    records: [],
    revision: 0,
    state: "warming",
    refreshedAt: undefined,
    refreshStartedAt: undefined,
    refreshError: undefined
  });
  await service.refresh({ force: true });
  const failed = service.read(false);
  assert.equal(failed.state, "stale");
  assert.equal(failed.revision, 0);
  assert.equal(failed.records.length, 0);
  assert.match(failed.refreshError ?? "", /NAS diagnostics unavailable/);
});
