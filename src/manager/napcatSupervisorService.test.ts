import assert from "node:assert/strict";
import test from "node:test";
import { NapcatSupervisorService } from "./napcatSupervisorService.js";

test("startup plugin waits for bound Route readiness before consuming its one automatic login run", async () => {
  const pluginUrl = new URL("../../plugins/builtin/io.rabiroute.manager.napcat-supervisor/1.0.0/manager.mjs", import.meta.url).href;
  const plugin = await import(pluginUrl);
  let runs = 0;
  const runtime = {
    NapcatSupervisorService, managerReadOnly: false, managerShouldAutostart: true,
    managerListenerReady: true, routeCatalogReady: false, activeNapcatControlContext: {},
    startActiveNapcatSupervisor: () => {}, stopActiveNapcatSupervisor: async () => {},
    autoLoginNapcatInstancesOnRabiStart: async () => { runs++; }
  };
  const starters: Array<() => Promise<() => Promise<void>>> = [];
  await plugin.activate({ identity: { instanceId: "supervisor-test" },
    services: { require: () => runtime, provide: () => {} },
    contributions: { register: () => {} }, effects: { add: (start: typeof starters[number]) => { starters.push(start); } }
  });
  const dispose = await starters[0]!();
  try {
    runtime.startActiveNapcatSupervisor();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 0);
    runtime.routeCatalogReady = true;
    runtime.startActiveNapcatSupervisor();
    runtime.startActiveNapcatSupervisor();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
  } finally { await dispose(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("NapCat supervisor deduplicates one activation run", async () => {
  const pending = deferred<string>();
  let runs = 0;
  const results: string[] = [];
  const service = new NapcatSupervisorService({
    run: () => {
      runs += 1;
      return pending.promise;
    },
    onResult: result => results.push(result)
  });

  const first = service.start();
  const second = service.start();
  assert.strictEqual(first, second);
  assert.equal(runs, 0);
  await Promise.resolve();
  assert.equal(runs, 1);

  pending.resolve("ready");
  await first;
  assert.deepEqual(results, ["ready"]);
});

test("NapCat supervisor stop aborts the active run, waits for it, and suppresses stale callbacks", async () => {
  const pending = deferred<string>();
  const results: string[] = [];
  const errors: string[] = [];
  let signal: AbortSignal | undefined;
  const service = new NapcatSupervisorService({
    run: currentSignal => {
      signal = currentSignal;
      return pending.promise;
    },
    onResult: result => results.push(result),
    onError: error => errors.push(String(error))
  });

  void service.start();
  await Promise.resolve();
  assert.equal(signal?.aborted, false);

  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  assert.equal(signal?.aborted, true);
  await Promise.resolve();
  assert.equal(stopped, false);

  pending.resolve("late");
  await stop;
  assert.equal(stopped, true);
  assert.deepEqual(results, []);
  assert.deepEqual(errors, []);
  assert.equal(service.isActive(), false);
});

test("NapCat supervisor can start a fresh generation after stop", async () => {
  const pending = [deferred<number>(), deferred<number>()];
  const results: number[] = [];
  const signals: AbortSignal[] = [];
  let runs = 0;
  const service = new NapcatSupervisorService({
    run: signal => {
      signals.push(signal);
      return pending[runs++]!.promise;
    },
    onResult: result => results.push(result)
  });

  const first = service.start();
  await Promise.resolve();
  pending[0]!.resolve(1);
  await first;
  await service.stop();

  const second = service.start();
  await Promise.resolve();
  pending[1]!.resolve(2);
  await second;

  assert.equal(runs, 2);
  assert.notStrictEqual(signals[0], signals[1]);
  assert.deepEqual(results, [1, 2]);
});

test("NapCat supervisor reports active-generation failures", async () => {
  const errors: string[] = [];
  const service = new NapcatSupervisorService({
    run: async () => { throw new Error("login failed"); },
    onError: error => errors.push(error instanceof Error ? error.message : String(error))
  });

  await service.start();
  assert.deepEqual(errors, ["login failed"]);
});
