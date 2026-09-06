import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeechModelSettingsStore, SpeechModelSettingsError, validateModelRoot } from "./speechModelSettings.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import type { IncomingMessage } from "node:http";

test("model settings persist revisions, clear to environment fallback, and never create the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "speech-settings-"));
  const target = path.join(root, "nonexistent-models");
  const validate = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  try {
    const store = new SpeechModelSettingsStore(root, [], validate);
    assert.equal(store.read("default", "env").source, "environment");
    store.write({ modelRoot: target, expectedRevision: 0 });
    assert.equal(fs.existsSync(target), false);
    assert.equal(new SpeechModelSettingsStore(root, [], validate).read("default", "env").effectiveModelRoot, target);
    assert.throws(() => store.write({ modelRoot: "other", expectedRevision: 0 }), (error: unknown) => error instanceof SpeechModelSettingsError && error.status === 409);
    store.write({ modelRoot: "", expectedRevision: 1 });
    assert.deepEqual(store.read("default", "env"), { revision: 2, configuredModelRoot: null, effectiveModelRoot: "env", defaultModelRoot: "env", source: "environment" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("model path validation rejects relative, UNC, device, root, ADS and ambiguous paths", () => {
  for (const value of ["relative", "C:relative", "\\\\server\\share", "\\\\?\\C:\\models", "C:\\", "C:\\model:stream", "C:\\NUL", "C:\\models.\\target"]) assert.throws(() => validateModelRoot(value, [], () => true), value);
});

test("Windows path validation uses fixed local drive and protects install/source roots", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "speech-path-"));
  try {
    const target = path.join(root, "models");
    assert.equal(validateModelRoot(target, [], () => true), target);
    assert.equal(fs.existsSync(target), false);
    assert.throws(() => validateModelRoot(target, [], () => false));
    assert.throws(() => validateModelRoot(target, [root], () => true));
    fs.mkdirSync(path.join(root, ".git"));
    assert.throws(() => validateModelRoot(target, [], () => true));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings access rejects LAN, rebinding, cross-origin and forwarded requests", () => {
  const request = (remoteAddress: string, headers: IncomingMessage["headers"]) => ({ socket: { remoteAddress }, headers }) as Pick<IncomingMessage, "socket" | "headers">;
  assert.equal(localModelSettingsRequestAllowed(request("127.0.0.1", { host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234" })), true);
  assert.equal(localModelSettingsRequestAllowed(request("192.0.2.1", { host: "127.0.0.1:1234" })), false);
  assert.equal(localModelSettingsRequestAllowed(request("127.0.0.1", { host: "attacker.example" })), false);
  assert.equal(localModelSettingsRequestAllowed(request("127.0.0.1", { host: "127.0.0.1:1234", origin: "https://attacker.example" })), false);
  assert.equal(localModelSettingsRequestAllowed(request("127.0.0.1", { host: "127.0.0.1:1234", "x-forwarded-for": "192.0.2.1" })), false);
});
