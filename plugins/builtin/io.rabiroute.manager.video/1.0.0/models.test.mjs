import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VideoModels, downloadFile, safeTarget } from "./models.mjs";

test("model settings persist without installing; stale writes and running service are rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-model-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = false, installs = 0;
  const runtime = { stateRoot: root, defaultModelRoot: path.join(root, "models"), alive: () => running, installed: async () => false, validateModelRoot: value => value, install: async () => { installs++; }, stopInstaller: async () => {} };
  const models = new VideoModels(runtime, { models: [] }, () => {});
  await models.initialize(); assert.equal(installs, 0);
  assert.equal((await models.snapshot()).runtimeInstalled, false);
  await models.configure({ modelRoot: path.join(root, "chosen"), expectedRevision: 0 });
  await assert.rejects(models.configure({ modelRoot: null, expectedRevision: 0 }), /刷新/);
  const restored = new VideoModels(runtime, { models: [] }, () => {});
  await restored.initialize(); assert.equal(restored.root(), path.join(root, "chosen"));
  running = true; await assert.rejects(restored.configure({ modelRoot: null, expectedRevision: 1 }), /停止/);
  running = false; models.installRuntime(); await models.flight; assert.equal(installs, 1);
  await models.close(); assert.throws(() => models.installRuntime(), /停止/);
});

test("download verifies hash and length, never overwrites an existing model, rejects redirected hosts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-download-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test model bytes"), hash = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(root, "model.safetensors"), signal = new AbortController().signal;
  const source = "https://huggingface.co/test/model";
  const fetcher = async () => new Response(bytes);
  await downloadFile(source, target, bytes.length, hash, signal, () => {}, fetcher);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(downloadFile(source, target, bytes.length, hash, signal, () => {}, fetcher), /EEXIST/);
  const bad = path.join(root, "bad.safetensors");
  await assert.rejects(downloadFile(source, bad, bytes.length, "0".repeat(64), signal, () => {}, fetcher), /SHA-256/);
  await assert.rejects(fs.access(bad));
  await assert.rejects(downloadFile(source, bad, bytes.length, hash, signal, () => {}, async () => new Response(null, { status: 302, headers: { location: "https://example.com/model" } })), /不受信任/);
  await assert.rejects(safeTarget(root, "../escape"), /路径/);
});

test("model target refuses a junction beneath the selected directory", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-junction-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "real"));
  await fs.symlink(path.join(root, "real"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(safeTarget(root, "link/model"), /联接/);
});
