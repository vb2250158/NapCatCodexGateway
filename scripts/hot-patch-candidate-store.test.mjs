import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HotPatchCandidateStore } from "../src/plugin-kernel/hotPatchCandidateStore.ts";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";

test("managed candidates verify identity, bounded contents and schema without executing code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-hot-patch-store-"));
  try {
    const compiled = compileHotPatchModule(`export function read() { throw new Error('not executed'); }`);
    const bytes = JSON.stringify(compiled);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const candidate = path.join(root, `${sha256}.json`);
    await fs.writeFile(candidate, bytes);
    const store = new HotPatchCandidateStore(root);
    assert.deepEqual(await store.read(sha256), compiled);
    await assert.rejects(store.read("../candidate"), /SHA-256/);
    await assert.rejects(new HotPatchCandidateStore(root, 1).read(sha256), /size limit/);
    await fs.writeFile(candidate, bytes + " ");
    await assert.rejects(store.read(sha256), /hash/);
    const malformed = JSON.stringify({ ...compiled, implementations: [] });
    const malformedHash = createHash("sha256").update(malformed).digest("hex");
    await fs.writeFile(path.join(root, `${malformedHash}.json`), malformed);
    await assert.rejects(store.read(malformedHash), /schema/);
    await fs.unlink(candidate);
    await fs.mkdir(candidate);
    await assert.rejects(store.read(sha256), /regular file/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-hot-patch-store-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
