import assert from "node:assert/strict";
import test from "node:test";
import { HotPatchRuntime } from "./hotPatchRuntime.js";

test("generator errors release leases and accepted iteration can drain after admission closes", async () => {
  const runtime = new HotPatchRuntime();
  runtime.register("stream", function*() { yield "first"; throw new Error("iterator failed"); });
  runtime.register("asyncStream", async function*() { yield "first"; throw new Error("async iterator failed"); });
  const iterator = runtime.bind("stream")() as Generator<unknown>;
  const asyncIterator = runtime.bind("asyncStream")() as AsyncGenerator<unknown>;
  assert.equal(iterator.next().value, "first");
  assert.equal((await asyncIterator.next()).value, "first");
  runtime.close();
  assert.throws(() => iterator.throw(new Error("injected")), /injected/);
  await assert.rejects(asyncIterator.next(), /async iterator failed/);
  assert.equal(runtime.snapshot().retained.length, 0);
});

test("generator cleanup may yield and reentrant next must not release a suspended revision", () => {
  const runtime = new HotPatchRuntime();
  let iterator: Generator<unknown>;
  runtime.register("value", () => "old");
  const value = runtime.bind("value");
  runtime.register("stream", function*() {
    try {
      assert.throws(() => iterator.next(), /already running/);
      yield value();
    } finally { yield value(); }
  });
  iterator = runtime.bind("stream")() as Generator<unknown>;
  assert.equal(iterator.next().value, "old");
  runtime.apply({ baseRevision: 0, changes: [{ id: "value", implementation: () => "new" }], contract: {} });
  assert.deepEqual(iterator.return(undefined), { value: "old", done: false });
  assert.ok(runtime.snapshot().retained.some(revision => revision.revision === 0 && revision.leases > 0));
  assert.equal(iterator.next().done, true);
  assert.ok(runtime.snapshot().retained.every(revision => revision.leases === 0));
});

test("contract-only publication pins old documentation and rolls back without replacing code", () => {
  const runtime = new HotPatchRuntime(32, { language: "en", schema: 1 });
  let calls = 0;
  runtime.register("read", () => ++calls);
  const read = runtime.bind("read");
  const old = runtime.acquire();
  try {
    assert.equal(runtime.apply({ baseRevision: 0, changes: [], contract: { language: "en", schema: 2 } }), 1);
    assert.equal(read(), 1);
    assert.equal(old.run(read), 2);
    assert.equal(old.contract.schema, 1);
    assert.equal(runtime.snapshot().contract.schema, 2);
    assert.throws(() => runtime.apply({ baseRevision: 1, changes: [], contract: { schema: 2, language: "en" } }), /no changes/);
    assert.equal(runtime.rollback(1), 2);
    assert.equal(runtime.snapshot().contract.schema, 1);
    assert.equal(read(), 3);
  } finally { old.release(); }
});

test("retained callbacks use new code while environment and receiver survive", () => {
  const runtime = new HotPatchRuntime();
  const environment = { count: 0 };
  runtime.register("counter", (state, receiver) => ++(state as typeof environment).count + (receiver as { offset: number }).offset);
  const object = { offset: 10, call: runtime.bind("counter", environment) };
  assert.equal(object.call(), 11);
  runtime.apply({ baseRevision: 0, changes: [{ id: "counter", implementation: state => ++(state as typeof environment).count * 2 }], contract: {} });
  assert.equal(object.call(), 4);
  assert.equal(environment.count, 2);
});

test("async request keeps one revision across nested calls and rollback", async () => {
  const runtime = new HotPatchRuntime();
  runtime.register("value", () => "old");
  const value = runtime.bind("value");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const oldRequest = runtime.run(async () => { await waiting; return value(); });
  runtime.apply({ baseRevision: 0, changes: [{ id: "value", implementation: () => "new" }], contract: { version: 1 } });
  assert.equal(value(), "new");
  assert.equal(runtime.rollback(1), 2);
  assert.equal(value(), "old");
  release();
  assert.equal(await oldRequest, "old");
  assert.deepEqual(runtime.snapshot().contract, {});
  assert.equal(runtime.snapshot().retained.length, 2);
});

test("whole candidate is rejected on stale revision, invalid symbol or invalid contract", () => {
  const runtime = new HotPatchRuntime();
  runtime.register("value", () => 1);
  const value = runtime.bind("value");
  const changes = [{ id: "value", implementation: () => 2 }];
  assert.throws(() => runtime.apply({ baseRevision: 7, changes, contract: {} }), /base revision/);
  assert.throws(() => runtime.apply({ baseRevision: 0, changes: [...changes, { id: "missing", implementation: () => 3 }], contract: {} }), /Invalid/);
  assert.throws(() => runtime.apply({ baseRevision: 0, changes, contract: { invalid: () => {} } }));
  assert.equal(value(), 1);
  assert.equal(runtime.snapshot().revision, 0);
});

test("request leases are idempotent, bounded and protect retained revisions", () => {
  const runtime = new HotPatchRuntime(2);
  runtime.register("value", () => 0);
  const lease = runtime.acquire();
  runtime.apply({ baseRevision: 0, changes: [{ id: "value", implementation: () => 1 }], contract: {} });
  assert.throws(() => runtime.apply({ baseRevision: 1, changes: [{ id: "value", implementation: () => 2 }], contract: {} }), /retention limit/);
  lease.release();
  lease.release();
  assert.throws(() => lease.run(() => 1), /released/);
  for (let revision = 1; revision < 101; revision++) {
    runtime.apply({ baseRevision: revision, changes: [{ id: "value", implementation: () => revision }], contract: {} });
  }
  assert.equal(runtime.snapshot().retained.length, 2);
});

test("errors release leases and contracts cannot be changed after publication", async () => {
  const runtime = new HotPatchRuntime();
  runtime.register("value", () => 1);
  assert.throws(() => runtime.run(() => { throw new Error("sync"); }), /sync/);
  await assert.rejects(runtime.run(async () => { throw new Error("async"); }), /async/);
  const contract = { schema: { version: 1 } };
  runtime.apply({ baseRevision: 0, changes: [{ id: "value", implementation: () => 2 }], contract });
  contract.schema.version = 7;
  assert.deepEqual(runtime.snapshot().contract, { schema: { version: 1 } });
  assert.ok(runtime.snapshot().retained.every(revision => revision.leases === 0));
  runtime.close();
  assert.equal(runtime.snapshot().retained.length, 0);
  assert.throws(() => runtime.run(() => 1), /closed/);
});

test("accepted async work can finish nested calls after closing admission", async () => {
  const runtime = new HotPatchRuntime();
  runtime.register("read", () => 42);
  const read = runtime.bind("read");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const work = runtime.run(async () => { await waiting; return read(); });
  runtime.close();
  assert.throws(() => runtime.runFresh(() => 1), /closed/);
  release();
  assert.equal(await work, 42);
  assert.equal(runtime.snapshot().retained.length, 0);
});

test("state migration is atomic and preserves the caller-owned state object", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("value", () => 1);
  const state = { version: 1, count: 3 };
  const identity = state;
  assert.equal(runtime.applyWithStateMigration({
    baseRevision: 0,
    changes: [{ id: "value", implementation: () => 2 }],
    contract: { stateSchema: 2 }
  }, state, current => ({ version: 2, count: (current.count as number) + 1 })), 1);
  assert.equal(state, identity);
  assert.deepEqual(state, { version: 2, count: 4 });
  assert.equal(runtime.snapshot().revision, 1);
});

test("failed state migration restores state and does not publish a revision", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("value", () => 1);
  const state = { version: 1, count: 3 };
  assert.throws(() => runtime.applyWithStateMigration({
    baseRevision: 0,
    changes: [{ id: "value", implementation: () => 2 }],
    contract: { stateSchema: 2 }
  }, state, current => {
    current.count = 99;
    throw new Error("migration failed");
  }), /migration failed/);
  assert.deepEqual(state, { version: 1, count: 3 });
  assert.equal(runtime.snapshot().revision, 0);
});

test("migration failures preserve nested state identity and do not run stale candidates", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", () => 1);
  const nested = { count: 4 };
  const state = { nested };
  const candidate = { baseRevision: 0, changes: [], contract: { stateSchema: 2 } };
  let attempts = 0;
  assert.throws(() => runtime.applyWithStateMigration({ ...candidate, baseRevision: 9 }, state, () => {
    attempts += 1;
  }), /base revision/);
  assert.equal(attempts, 0);
  assert.throws(() => runtime.applyWithStateMigration(candidate, state, draft => {
    (draft.nested as typeof nested).count = 90;
    throw new Error("draft failed");
  }), /draft failed/);
  assert.equal(state.nested, nested);
  assert.equal(nested.count, 4);
});

test("state migration waits for leases of every retained code revision", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", environment => (environment as { count: number }).count);
  const state = { count: 7 };
  const read = runtime.bind("read", state);
  const lease = runtime.acquire();
  runtime.apply({ baseRevision: 0, changes: [], contract: { stateSchema: 1, description: "new docs" } });
  let attempts = 0;
  try {
    assert.throws(() => runtime.applyWithStateMigration({ baseRevision: 1, changes: [], contract: { stateSchema: 2 } }, state, () => {
      attempts += 1;
    }), /drain/);
    assert.equal(attempts, 0);
    assert.equal(lease.run(read), 7);
    assert.equal(runtime.snapshot().revision, 1);
  } finally { lease.release(); }
  assert.equal(runtime.applyWithStateMigration({ baseRevision: 1, changes: [], contract: { stateSchema: 2 } }, state, draft => {
    draft.count = 8;
  }), 2);
});

test("migration rejects asynchronous work and isolates late draft mutation", async () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", () => 1);
  const state = { count: 1 };
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const migration = (async (draft: Record<string, unknown>) => { await waiting; draft.count = 50; throw new Error("late failure"); }) as unknown as Parameters<typeof runtime.applyWithStateMigration>[2];
  assert.throws(() => runtime.applyWithStateMigration({ baseRevision: 0, changes: [], contract: { stateSchema: 2 } }, state, migration), /synchronous/);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.count, 1);
  assert.equal(runtime.snapshot().revision, 0);
});

test("migration cannot reenter admission or publication and detached drafts cannot mutate published state", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", () => 1);
  const state = { nested: { count: 1 } };
  let escapedDraft!: Record<string, unknown>;
  const candidate = { baseRevision: 0, changes: [], contract: { stateSchema: 2 } };
  runtime.applyWithStateMigration(candidate, state, draft => {
    assert.throws(() => runtime.runFresh(() => 1), /migration/);
    assert.throws(() => runtime.apply(candidate), /migration/);
    assert.throws(() => runtime.close(), /migration/);
    escapedDraft = draft;
    (draft.nested as { count: number }).count = 2;
  });
  (escapedDraft.nested as { count: number }).count = 100;
  assert.equal(state.nested.count, 2);
});

test("migration rejects unsafe state shapes without invoking getters or proxy traps", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", () => 1);
  const candidate = { baseRevision: 0, changes: [], contract: { stateSchema: 2 } };
  let reads = 0;
  const accessor = { get value() { reads += 1; return 1; } };
  const proxy = new Proxy({}, { ownKeys() { reads += 1; return []; } });
  for (const state of [accessor, proxy, Object.freeze({ count: 1 }), { nested: accessor }]) {
    assert.throws(() => runtime.applyWithStateMigration(candidate, state, () => {}), /state/);
  }
  assert.equal(reads, 0);
  assert.equal(runtime.snapshot().revision, 0);
});

test("state migration can roll back across schema versions with an explicit reverse migration", () => {
  const runtime = new HotPatchRuntime(32, { stateSchema: 1 });
  runtime.register("read", environment => (environment as { count: number }).count);
  const state = { count: 1 };
  runtime.applyWithStateMigration({ baseRevision: 0, changes: [], contract: { stateSchema: 2 } }, state, draft => {
    draft.count = 2;
  });
  assert.throws(() => runtime.rollback(1), /reverse migration/);
  assert.equal(runtime.rollbackWithStateMigration(1, state, draft => {
    draft.count = (draft.count as number) - 1;
  }), 2);
  assert.deepEqual(state, { count: 1 });
  assert.equal(runtime.snapshot().stateVersion, 2);
});
