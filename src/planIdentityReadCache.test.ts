import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPlan, getPlanAsync } from "./roleKnowledge.js";
import { readPlanIdentity, readPlanIdentityAsync } from "./planIdentityReadCache.js";

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-identity-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("identity cache observes same-size replacement with restored mtime and deletion", async t => {
  const root = fixture(t);
  const file = path.join(root, "plan.json");
  fs.writeFileSync(file, JSON.stringify({ id: "first", title: "Plan" }));
  const before = fs.statSync(file);
  assert.equal(readPlanIdentity(file), "first");
  const replacement = path.join(root, "replacement.json");
  fs.writeFileSync(replacement, JSON.stringify({ id: "other", title: "Plan" }));
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, file);
  assert.equal(await readPlanIdentityAsync(file), "other");
  fs.unlinkSync(file);
  assert.equal(readPlanIdentity(file), null);
  fs.writeFileSync(file, JSON.stringify({ id: "third", title: "Plan" }));
  assert.equal(await readPlanIdentityAsync(file), "third");
});

test("warm point reads avoid unrelated bodies and still reject a misplaced duplicate", async t => {
  const root = fixture(t);
  for (let index = 0; index < 500; index += 1) {
    const id = `plan-${String(index).padStart(4, "0")}`;
    const dir = path.join(root, "plans", "active", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
      id, title: id, status: "暂停", focus: "Point read fixture", keywords: ["read"],
      steps: [{ id: "step", title: "Step", detail: "x".repeat(5000) }]
    }));
  }
  const target = "plan-0000";
  const started = performance.now();
  assert.equal(getPlan(root, target)?.id, target);
  const coldMs = performance.now() - started;
  const originalSync = fs.readFileSync;
  const originalAsync = fs.promises.readFile;
  let unrelatedReads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith("plan.json") && !String(args[0]).includes(target)) unrelatedReads += 1;
    return originalSync(...args as [fs.PathOrFileDescriptor, { encoding: BufferEncoding }]);
  }) as typeof fs.readFileSync;
  fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
    if (String(args[0]).endsWith("plan.json") && !String(args[0]).includes(target)) unrelatedReads += 1;
    return originalAsync(...args as [fs.PathLike, { encoding: BufferEncoding }]);
  }) as typeof fs.promises.readFile;
  try {
    const warmStarted = performance.now();
    assert.equal(getPlan(root, target)?.id, target);
    const warmMs = performance.now() - warmStarted;
    assert.equal((await getPlanAsync(root, target))?.id, target);
    assert.equal(unrelatedReads, 0);
    t.diagnostic(`500 plans: cold ${coldMs.toFixed(1)} ms, warm sync ${warmMs.toFixed(1)} ms; unrelated body reads on warm sync+async = 0`);
  } finally {
    fs.readFileSync = originalSync;
    fs.promises.readFile = originalAsync;
  }
  const duplicate = path.join(root, "plans", "archive", "arbitrary-physical-name");
  fs.mkdirSync(duplicate, { recursive: true });
  fs.copyFileSync(path.join(root, "plans", "active", target, "plan.json"), path.join(duplicate, "plan.json"));
  assert.throws(() => getPlan(root, target), /storage conflict/);
  await assert.rejects(getPlanAsync(root, target), /storage conflict/);
  fs.unlinkSync(path.join(duplicate, "plan.json"));
  assert.equal(getPlan(root, target)?.id, target);
});

test("async identity metadata waits are cancellable", async t => {
  const root = fixture(t);
  const originalStat = fs.promises.stat;
  const controller = new AbortController();
  fs.promises.stat = (() => new Promise(() => {})) as typeof fs.promises.stat;
  try {
    const pending = readPlanIdentityAsync(path.join(root, "plan.json"), controller.signal);
    controller.abort(new DOMException("cancel identity stat", "AbortError"));
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  } finally { fs.promises.stat = originalStat; }
});
