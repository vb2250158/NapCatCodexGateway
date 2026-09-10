import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const { HotPatchBundleJournal } = await import("../src/plugin-kernel/hotPatchBundleJournal.ts");
const { compileHotPatchModule } = await import("./lib/hot-patch-compiler.mjs");
const { HotPatchProcessBundle } = await import("../src/plugin-kernel/hotPatchProcessBundle.ts");
const { HotPatchProcess } = await import("../src/plugin-kernel/hotPatchProcess.ts");

test("bundle journal serializes independent instances and preserves recorded outcomes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-bundle-journal-"));
  try {
    const journals = Array.from({ length: 8 }, () => new HotPatchBundleJournal(root));
    const claims = await Promise.allSettled(journals.map(journal => journal.begin("same-operation", { source: "same" }, true)));
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
    await assert.rejects(journals[0].begin("same-operation", { source: "different" }), /different contents/);
    const outcomes = await Promise.allSettled([
      journals[0].mark("same-operation", "committed", { revision: 1 }),
      journals[1].mark("same-operation", "failed", undefined, "late failure"),
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    const final = await journals[0].read("same-operation");
    assert.deepEqual(await journals[1].mark("same-operation", final.state, { revision: 999 }), final);
    await assert.rejects(journals[0].mark("same-operation", "pending"), /already recorded/);
    await assert.rejects(journals[0].begin("../invalid", {}), /Invalid/);
    assert.deepEqual(await fs.readdir(root), ["same-operation.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("bundle journal gives only one process execution ownership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-bundle-journal-process-"));
  try {
    const moduleUrl = new URL("../src/plugin-kernel/hotPatchBundleJournal.ts", import.meta.url).href;
    const script = `const { HotPatchBundleJournal } = await import(${JSON.stringify(moduleUrl)}); const journal = new HotPatchBundleJournal(${JSON.stringify(root)}); try { await journal.begin('cross-process', { source: 'same' }, true); process.stdout.write('claimed'); } catch (error) { if (!error.message.includes('already exists')) throw error; process.stdout.write('existing'); }`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { windowsHide: true });
      let output = "";
      let errors = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { errors += data; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter(result => result === "claimed").length, 1);
    assert.equal(results.filter(result => result === "existing").length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("process bundle prepares every Worker before committing", async () => {
  const baseline = compileHotPatchModule("export function read() { return 'old'; }");
  const changed = compileHotPatchModule("export function read() { return 'new'; }");
  const first = new HotPatchProcess("first", baseline);
  const second = new HotPatchProcess("second", baseline);
  try {
    await assert.rejects(new HotPatchProcessBundle("bundle", [
      { id: "first", process: first, compiled: changed, expectedRevision: 0 },
      { id: "second", process: second, compiled: { ...changed, compatibilityHash: "invalid" }, expectedRevision: 0 }
    ]).apply());
    assert.equal((await first.snapshot()).snapshot.revision, 0);
    assert.equal((await second.snapshot()).snapshot.revision, 0);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("process bundle commits all Workers after preparation", async () => {
  const baseline = compileHotPatchModule("export function read() { return 'old'; }");
  const changed = compileHotPatchModule("export function read() { return 'new'; }");
  const first = new HotPatchProcess("first", baseline);
  const second = new HotPatchProcess("second", baseline);
  try {
    const result = await new HotPatchProcessBundle("bundle", [
      { id: "first", process: first, compiled: changed, expectedRevision: 0 },
      { id: "second", process: second, compiled: changed, expectedRevision: 0 }
    ]).apply();
    assert.deepEqual(result.map(entry => entry.snapshot.snapshot.revision), [1, 1]);
    assert.equal(await first.call("read", []), "new");
    assert.equal(await second.call("read", []), "new");
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
