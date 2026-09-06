import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configuredModelPaths, modelFilesPresent, speechConfigPath, type ModelFileSpec } from "./speechModelFiles.js";

const spec: ModelFileSpec = { alias: "asr-whisper-small", family: "faster-whisper", kind: "huggingface", target: "asr/cache", repository: "example/small" };
function file(root: string, name: string, content = "fixture"): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}
function fixture(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "speech-model-files-"));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("shared cache ignores ambiguous root weights and unrelated root snapshots", () => fixture(root => {
  for (const name of ["config.json", "model.bin", "tokenizer.json"]) {
    file(root, name);
    file(root, `snapshots/wrong/${name}`);
  }
  assert.equal(modelFilesPresent(root, { ...spec, download_mode: "cache" }), false);
}));

test("shard paths cannot escape model directory or select Windows streams/devices", () => fixture(root => {
  file(root, "config.json");
  file(root, "model.safetensors");
  const model = { ...spec, family: "Fixture" };
  for (const shard of ["../model.safetensors", "C:model.safetensors", "model.safetensors:stream", "sub\\model.bin", "NUL.bin", "/model.bin"]) {
    file(root, "model.safetensors.index.json", JSON.stringify({ weight_map: { tensor: shard } }));
    assert.equal(modelFilesPresent(root, model), false, shard);
  }
  file(root, "model.safetensors.index.json", " ".repeat(2 * 1024 * 1024 + 1));
  assert.equal(modelFilesPresent(root, model), false);
}));

test("HF shared cache checks only the matching repository snapshots", () => fixture(root => {
  for (const name of ["config.json", "model.bin", "tokenizer.json"]) file(root, `models--example--other/snapshots/revision/${name}`);
  assert.equal(modelFilesPresent(root, spec), false);
  for (const name of ["config.json", "model.bin", "tokenizer.json"]) file(root, `models--example--small/snapshots/revision/${name}`);
  assert.equal(modelFilesPresent(root, spec), true);
}));

test("Qwen TTS requires tokenizer weights and every declared shard", () => fixture(root => {
  const model = { ...spec, family: "Qwen3-TTS" };
  for (const name of ["config.json", "tokenizer_config.json", "vocab.json", "merges.txt", "speech_tokenizer/config.json", "model.safetensors"]) file(root, name);
  assert.equal(modelFilesPresent(root, model), false);
  file(root, "speech_tokenizer/model.safetensors");
  assert.equal(modelFilesPresent(root, model), true);
  file(root, "model.safetensors.index.json", JSON.stringify({ weight_map: { a: "one.safetensors", b: "two.safetensors" } }));
  file(root, "one.safetensors");
  assert.equal(modelFilesPresent(root, model), false);
  file(root, "two.safetensors");
  assert.equal(modelFilesPresent(root, model), true);
}));

test("junctions work and broken junctions fail closed", () => fixture(root => {
  const target = path.join(root, "target");
  for (const name of ["config.json", "model.bin", "tokenizer.json"]) file(target, name);
  const link = path.join(root, "link");
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(modelFilesPresent(link, spec), true);
  fs.rmSync(target, { recursive: true });
  assert.equal(modelFilesPresent(link, spec), false);
}));

test("worker path discovery reads existing command and working_directory without installed flags", () => fixture(root => {
  const config = path.join(root, "config.json");
  file(root, "config.json", JSON.stringify({ providers: { tts: { local_tts: { models: [
    { id: "indextts2", installed: false, command: ["python", "worker.py", "--model", "weights"], working_directory: "runtime" },
    { id: "gpt-sovits", command: ["python", "worker.py", "--repository-root", "sovits"], working_directory: "runtime" }
  ] } } } }));
  assert.deepEqual(configuredModelPaths({ ...spec, alias: "tts-indextts2" }, config), [path.join(root, "runtime/weights")]);
  assert.deepEqual(configuredModelPaths({ ...spec, alias: "tts-gpt-sovits" }, config), [path.join(root, "runtime/sovits/GPT_SoVITS/pretrained_models")]);
}));

test("explicit user config overrides package config even when missing", () => fixture(root => {
  const old = process.env.RABISPEECH_CONFIG;
  try {
    process.env.RABISPEECH_CONFIG = path.join(root, "missing-user-config.json");
    file(root, "config.json", "{}");
    assert.equal(speechConfigPath(root), process.env.RABISPEECH_CONFIG);
  } finally {
    if (old === undefined) delete process.env.RABISPEECH_CONFIG; else process.env.RABISPEECH_CONFIG = old;
  }
}));
