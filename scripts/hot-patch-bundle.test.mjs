import assert from "node:assert/strict";
import test from "node:test";
const { compileHotPatchModule } = await import("./lib/hot-patch-compiler.mjs");
const { HotPatchBundle } = await import("../src/plugin-kernel/hotPatchBundle.ts");
const { HotPatchModule } = await import("../src/plugin-kernel/hotPatchModule.ts");

test("bundle validates every module before publishing any module", () => {
  const baseline = compileHotPatchModule("export function read() { return 'old'; }");
  const changed = compileHotPatchModule("export function read() { return 'new'; }");
  const first = new HotPatchModule("first", baseline);
  const second = new HotPatchModule("second", baseline);
  assert.throws(() => new HotPatchBundle("bundle", [
    { id: "first", module: first, compiled: changed, expectedRevision: 0 },
    { id: "second", module: second, compiled: { ...changed, compatibilityHash: "invalid" }, expectedRevision: 0 }
  ]).apply());
  assert.equal(first.snapshot().revision, 0);
  assert.equal(first.exports.read(), "old");
  assert.equal(second.snapshot().revision, 0);
  first.runtime.close();
  second.runtime.close();
});

test("bundle publishes all prepared modules as one guarded operation", () => {
  const baseline = compileHotPatchModule("export function read() { return 'old'; }");
  const changed = compileHotPatchModule("export function read() { return 'new'; }");
  const first = new HotPatchModule("first", baseline);
  const second = new HotPatchModule("second", baseline);
  try {
    const result = new HotPatchBundle("bundle", [
      { id: "first", module: first, compiled: changed, expectedRevision: 0, contract: { document: 2 } },
      { id: "second", module: second, compiled: changed, expectedRevision: 0, contract: { document: 2 } }
    ]).apply();
    assert.deepEqual(result.map(entry => entry.revision), [1, 1]);
    assert.equal(first.exports.read(), "new");
    assert.equal(second.exports.read(), "new");
  } finally {
    first.runtime.close();
    second.runtime.close();
  }
});

test("bundle pins every module lease for one asynchronous request", async () => {
  const baseline = compileHotPatchModule("export async function read() { await new Promise(resolve => setTimeout(resolve, 40)); return 'old'; }");
  const changed = compileHotPatchModule("export async function read() { await new Promise(resolve => setTimeout(resolve, 40)); return 'new'; }");
  const first = new HotPatchModule("first", baseline);
  const second = new HotPatchModule("second", baseline);
  try {
    const bundle = new HotPatchBundle("bundle", [
      { id: "first", module: first, compiled: changed, expectedRevision: 0 },
      { id: "second", module: second, compiled: changed, expectedRevision: 0 }
    ]);
    const request = bundle.run(() => Promise.all([first.exports.read(), second.exports.read()]));
    bundle.apply();
    assert.deepEqual(await request, ["old", "old"]);
    assert.deepEqual(await Promise.all([first.exports.read(), second.exports.read()]), ["new", "new"]);
  } finally {
    first.runtime.close();
    second.runtime.close();
  }
});
