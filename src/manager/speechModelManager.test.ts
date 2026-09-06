import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { spawn } from "node:child_process";
import { SpeechModelManager, SpeechModelManagerError } from "./speechModelManager.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

function makeFixture(): {
  root: string;
  pluginRoot: string;
  modelRoot: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-model-manager-"));
  const pluginRoot = path.join(root, "plugin-adapters", "rabi-speech");
  const modelRoot = path.join(root, "private-models");
  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "scripts", "install.ps1"), "# fixture\n");
  fs.writeFileSync(path.join(pluginRoot, "scripts", "install_models.ps1"), "# fixture\n");
  fs.writeFileSync(path.join(pluginRoot, "model-catalog.json"), JSON.stringify({
    schema_version: 1,
    models: [
      {
        alias: "asr-fixture",
        capability: "asr",
        name: "Fixture ASR",
        family: "Fixture",
        kind: "huggingface",
        repository: "example/fixture-asr",
        target: "asr/fixture",
        size_gib: 0.5,
        runtime: "core",
        purpose_zh: "测试识别模型",
        purpose_en: "Fixture recognition model"
      }
    ]
  }, null, 2));
  return {
    root,
    pluginRoot,
    modelRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function fakeInstaller(calls: Array<{ command: string; args: string[] }>): {
  spawnInstaller: typeof spawn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawnInstaller = ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push({ command, args: [...args] });
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { spawnInstaller, children };
}

function putFile(filename: string, content = "fixture model bytes"): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

test("model files without an installation manifest are recognized; empty and zero-byte targets are not", () => {
  const fixture = makeFixture();
  try {
    const manager = new SpeechModelManager({ rootDir: fixture.root, modelRoot: fixture.modelRoot });
    const target = path.join(fixture.modelRoot, "asr/fixture");
    putFile(path.join(target, "config.json"), "{}");
    putFile(path.join(target, "model.safetensors"), "");
    assert.equal(manager.snapshot().models[0]?.downloaded, false);
    putFile(path.join(target, "model.safetensors"));
    assert.equal(manager.snapshot().models[0]?.downloaded, true);
    assert.equal(fs.existsSync(path.join(fixture.modelRoot, "install-manifest.json")), false);
  } finally { fixture.cleanup(); }
});

test("an installed manifest does not make an empty directory downloaded", () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(path.join(fixture.modelRoot, "asr/fixture"), { recursive: true });
    putFile(path.join(fixture.modelRoot, "install-manifest.json"), JSON.stringify({ models: [{ alias: "asr-fixture", status: "installed" }] }));
    assert.equal(new SpeechModelManager({ rootDir: fixture.root, modelRoot: fixture.modelRoot }).snapshot().models[0]?.downloaded, false);
  } finally { fixture.cleanup(); }
});

test("state-owned runtime dependencies are reported with separate immutable package assets", () => {
  const fixture = makeFixture();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "speech-state-regression-"));
  try {
    fs.mkdirSync(path.join(stateRoot, "plugin-adapters/rabi-speech/.deps"), { recursive: true });
    putFile(path.join(stateRoot, "plugin-adapters/rabi-speech/runtime/RabiSpeech.exe"));
    putFile(path.join(stateRoot, "plugin-adapters/rabi-speech/scripts/install_models.ps1"));
    putFile(path.join(stateRoot, "plugin-adapters/rabi-speech/scripts/install.ps1"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const fake = fakeInstaller(calls);
    const manager = new SpeechModelManager({ rootDir: stateRoot, packageRoot: fixture.root, modelRoot: fixture.modelRoot, platform: "win32", spawnInstaller: fake.spawnInstaller });
    const state = manager.snapshot();
    assert.equal(state.dependenciesInstalled, true);
    assert.equal(state.windowsHostInstalled, true);
    manager.installModel("asr-fixture");
    assert.ok(calls[0]?.args.includes(path.join(stateRoot, "plugin-adapters/rabi-speech/scripts/install_models.ps1")));
    fake.children[0]?.emit("close", 0);
    manager.installRuntime();
    assert.ok(calls[1]?.args.includes(path.join(stateRoot, "plugin-adapters/rabi-speech/scripts/install.ps1")));
    fake.children[1]?.emit("close", 0);
  } finally { fixture.cleanup(); fs.rmSync(stateRoot, { recursive: true, force: true }); }
});

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("speech model manager lists allowlisted models without installing speech by default", () => {
  const fixture = makeFixture();
  try {
    const manager = new SpeechModelManager({ rootDir: fixture.root, modelRoot: fixture.modelRoot, platform: "win32" });
    const snapshot = manager.snapshot();
    assert.equal(snapshot.platformSupported, true);
    assert.equal(snapshot.dependenciesInstalled, false);
    assert.equal(snapshot.windowsHostInstalled, false);
    assert.equal(snapshot.models.length, 1);
    assert.equal(snapshot.models[0]?.alias, "asr-fixture");
    assert.equal(snapshot.models[0]?.status, "not_downloaded");
    assert.equal(snapshot.models[0]?.sourceUrl, "https://huggingface.co/example/fixture-asr");
  } finally {
    fixture.cleanup();
  }
});

test("speech model manager reads immutable adapter assets from package root while state remains separate", () => {
  const fixture = makeFixture();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-model-state-"));
  try {
    const manager = new SpeechModelManager({
      packageRoot: fixture.root,
      rootDir: stateRoot,
      modelRoot: path.join(stateRoot, "models"),
      platform: "win32"
    });
    const snapshot = manager.snapshot();
    assert.equal(snapshot.models[0]?.alias, "asr-fixture");
    assert.equal(snapshot.dependenciesInstalled, false);
    assert.equal(fs.existsSync(path.join(stateRoot, "plugin-adapters")), false);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("repository model catalog exposes unique allowlisted download targets", () => {
  const payload = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "plugin-adapters", "rabi-speech", "model-catalog.json"),
    "utf8"
  )) as { schema_version?: unknown; models?: Array<Record<string, unknown>> };
  assert.equal(payload.schema_version, 1);
  assert.ok(Array.isArray(payload.models));
  assert.ok((payload.models?.length || 0) >= 10);
  const aliases = new Set<string>();
  for (const model of payload.models || []) {
    const alias = String(model.alias || "");
    const target = String(model.target || "");
    assert.match(alias, /^[a-z0-9][a-z0-9.-]+$/);
    assert.equal(aliases.has(alias), false);
    aliases.add(alias);
    assert.ok(model.kind === "huggingface" || model.kind === "file");
    assert.ok(Boolean(model.repository || model.download_url));
    assert.ok(target.length > 0);
    assert.equal(path.isAbsolute(target), false);
    assert.equal(target.split(/[\\/]+/).includes(".."), false);
  }
});

test("speech model manager requires the private speech environment and rejects unknown aliases", () => {
  const fixture = makeFixture();
  try {
    const manager = new SpeechModelManager({ rootDir: fixture.root, modelRoot: fixture.modelRoot, platform: "win32" });
    assert.throws(
      () => manager.installModel("missing"),
      (error: unknown) => error instanceof SpeechModelManagerError && error.status === 404
    );
    assert.throws(
      () => manager.installModel("asr-fixture"),
      (error: unknown) => error instanceof SpeechModelManagerError && error.status === 409
    );
  } finally {
    fixture.cleanup();
  }
});

test("speech model manager launches one allowlisted download and reports installed manifest state", async () => {
  const fixture = makeFixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const fake = fakeInstaller(calls);
  try {
    fs.mkdirSync(path.join(fixture.pluginRoot, ".deps"));
    const manager = new SpeechModelManager({
      rootDir: fixture.root,
      modelRoot: fixture.modelRoot,
      platform: "win32",
      spawnInstaller: fake.spawnInstaller
    });
    const running = manager.installModel("asr-fixture");
    assert.equal(running.activeJob?.modelAlias, "asr-fixture");
    assert.throws(() => manager.updateDirectorySettings({ modelRoot: null, expectedRevision: 0 }),
      (error: unknown) => error instanceof SpeechModelManagerError && error.status === 409);
    assert.equal(running.models[0]?.status, "downloading");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "powershell.exe");
    assert.deepEqual(calls[0]?.args.slice(0, 6), [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(fixture.pluginRoot, "scripts", "install_models.ps1")
    ]);
    assert.ok(calls[0]?.args.includes("asr-fixture"));
    assert.ok(calls[0]?.args.includes(fixture.modelRoot));
    assert.throws(
      () => manager.installRuntime(),
      (error: unknown) => error instanceof SpeechModelManagerError && error.status === 409
    );

    putFile(path.join(fixture.modelRoot, "asr", "fixture", "config.json"), "{}");
    putFile(path.join(fixture.modelRoot, "asr", "fixture", "model.safetensors"));
    fs.writeFileSync(path.join(fixture.modelRoot, "install-manifest.json"), JSON.stringify({
      models: [{ alias: "asr-fixture", status: "installed" }]
    }));
    fake.children[0]?.emit("close", 0);
    await nextTurn();

    const completed = manager.snapshot();
    assert.equal(completed.activeJob, undefined);
    assert.equal(completed.lastJob?.state, "completed");
    assert.equal(completed.models[0]?.downloaded, true);
    assert.equal(completed.models[0]?.status, "downloaded");
  } finally {
    fixture.cleanup();
  }
});

test("speech model manager redacts private paths from installer failures", async () => {
  const fixture = makeFixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const fake = fakeInstaller(calls);
  try {
    const manager = new SpeechModelManager({
      rootDir: fixture.root,
      modelRoot: fixture.modelRoot,
      platform: "win32",
      spawnInstaller: fake.spawnInstaller
    });
    manager.installRuntime();
    fake.children[0]?.stderr.write(`failed at ${fixture.modelRoot} and ${fixture.pluginRoot}\n`);
    fake.children[0]?.emit("close", 1);
    await nextTurn();
    const error = manager.snapshot().lastJob?.error || "";
    assert.match(error, /<model-root>|<speech-plugin>/);
    assert.doesNotMatch(error, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fixture.cleanup();
  }
});
