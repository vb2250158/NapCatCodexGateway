import assert from "node:assert/strict";
import test from "node:test";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";
const { HotPatchProcess } = await import(process.env.RABIROUTE_HOT_PATCH_TEST_BUILT === "1"
  ? "../dist/plugin-kernel/hotPatchProcess.js" : "../src/plugin-kernel/hotPatchProcess.ts");

test("worker consumes internal generators but rejects iterator IPC without leaking leases", async () => {
  const source = `export function* stream() { yield 1; yield 2; }
    export async function* asyncStream() { yield 3; }
    export function collect() { return [...stream()]; }`;
  const process = new HotPatchProcess("iterator-boundary", compileHotPatchModule(source));
  try {
    await assert.rejects(process.call("stream", []), /IPC streaming/);
    await assert.rejects(process.invoke("asyncStream", []), /IPC streaming/);
    assert.deepEqual(await process.call("collect", []), [1, 2]);
    assert.ok((await process.snapshot()).snapshot.retained.every(revision => revision.leases === 0));
    assert.equal(process.status().state, "ready");
  } finally { await process.stop(); }
});

test("accepted arguments are captured before startup and invalid serialization does not kill a worker", async () => {
  const process = new HotPatchProcess("arguments", compileHotPatchModule(`export function read(value: { count: number }) { return value.count; }`));
  try {
    const input = { count: 1 };
    const result = process.call("read", [input]);
    input.count = 2;
    assert.equal(await result, 1);
    await assert.rejects(process.call("read", [() => 3]));
    assert.equal(await process.call("read", [{ count: 4 }]), 4);
    assert.equal(process.status().state, "ready");
  } finally { await process.stop(); }
});

test("invocations return the documentation and revision pinned to their actual execution", async () => {
  const source = `let release: (() => void) | undefined;
    function label() { return 'old'; }
    export async function read() { await new Promise<void>(resolve => { release = resolve; }); return label(); }
    export function finish() { release?.(); }`;
  const process = new HotPatchProcess("documents", compileHotPatchModule(source), { contract: { label: "old" } });
  try {
    await process.snapshot();
    const invocation = process.invoke("read", []);
    const pinned = await process.snapshot();
    assert.ok(pinned.snapshot.retained.some(item => item.leases > 0));
    await process.apply(compileHotPatchModule(source.replace("'old'", "'new'")), 0, { label: "new" });
    await process.call("finish", []);
    assert.deepEqual(await invocation, { revision: 0, contract: { label: "old" }, value: "old" });
    assert.equal((await process.invoke("finish", [])).contract.label, "new");
  } finally { await process.stop(); }
});

test("worker validates bounds before starting and closes after rejected initialization", async () => {
  const compiled = compileHotPatchModule(`export function read() { return 1; }`);
  assert.throws(() => new HotPatchProcess("invalid", compiled, { maximumPending: 0 }), /positive/);
  assert.throws(() => new HotPatchProcess("invalid", compiled, { startupTimeoutMs: 0 }), /positive/);
  const process = new HotPatchProcess("invalid", { ...compiled, schemaVersion: 99 });
  try {
    await assert.rejects(process.snapshot());
    assert.equal(process.status().state, "failed");
  } finally { await process.stop(); }
});

test("initialization and accepted calls have independent deadlines", async () => {
  const source = `const initialized = (() => { const started = Date.now(); while (Date.now() - started < 750) {} return true; })(); export function read() { return 1; }`;
  const process = new HotPatchProcess("startup-budget", compileHotPatchModule(source), { timeoutMs: 500, startupTimeoutMs: 15000 });
  try {
    assert.equal((await process.snapshot()).snapshot.revision, 0);
    assert.equal(await process.call("read", []), 1);
  } finally { await process.stop(); }
});

test("graceful stop preserves accepted asynchronous calls and rejects new admission", async () => {
  const source = `export async function read() { await new Promise(resolve => setTimeout(resolve, 100)); return 'completed'; }`;
  const process = new HotPatchProcess("drain", compileHotPatchModule(source));
  const accepted = process.call("read", []);
  const stopped = process.stop();
  await assert.rejects(process.call("read", []), /admission/);
  assert.equal(await accepted, "completed");
  await stopped;
  assert.equal(process.status().state, "closed");
  assert.equal(process.status().pending, 0);
});

test("worker applies and rolls back source without replacing the process or resetting state", async () => {
  const source = `let calls = 0; export function read() { calls++; return { label: 'old', calls }; }`;
  const process = new HotPatchProcess("worker", compileHotPatchModule(source));
  try {
    const before = await process.snapshot();
    assert.deepEqual(await process.call("read", []), { label: "old", calls: 1 });
    const after = await process.apply(compileHotPatchModule(source.replace("'old'", "'new'")), 0);
    assert.equal(before.pid, after.pid);
    assert.deepEqual(await process.call("read", []), { label: "new", calls: 2 });
    await assert.rejects(process.apply(compileHotPatchModule(source.replace("'old'", "'third'")), 0), /base revision/);
    await process.rollback(1);
    assert.deepEqual(await process.call("read", []), { label: "old", calls: 3 });
  } finally { await process.stop(); }
});

test("worker synchronous stalls do not block parent event loop and timeout calls are never replayed", async () => {
  const source = `export function stall() { for (;;) {} }`;
  const process = new HotPatchProcess("stall", compileHotPatchModule(source), { timeoutMs: 2000 });
  try {
    await process.snapshot();
    const rejected = assert.rejects(process.call("stall", []), /timed out/);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try { await rejected; } finally { clearInterval(timer); }
    assert.ok(ticks >= 5, `Parent event loop stalled: ${ticks} ticks`);
    assert.equal(process.status().state, "failed");
    await assert.rejects(process.call("stall", []), /unavailable/);
  } finally { await process.stop(); }
});
test("worker migrates an owned dependency without replacing the process", async () => {
  const source = `declare const state: { count: number; total?: number }; export function read() { return state.count ?? state.total; } export function add() { state.count++; return read(); }`;
  const process = new HotPatchProcess("worker-state", compileHotPatchModule(source), { dependencies: { state: { count: 2 } }, contract: { stateSchema: 1 } });
  try {
    const before = await process.snapshot("state");
    const candidate = compileHotPatchModule(source.replace("state.count ?? state.total", "state.total ?? state.count").replace("state.count++;", "state.total++;"));
    const after = await process.applyWithStateMigration(candidate, 0, "state", "draft => { draft.total = draft.count; delete draft.count; }", { stateSchema: 2 });
    assert.equal(after.pid, before.pid);
    assert.deepEqual(after.state, { total: 2 });
    assert.equal(await process.call("add", []), 3);
  } finally { await process.stop(); }
});
