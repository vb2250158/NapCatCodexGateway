import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HotPatchResourceStore } from "../src/plugin-kernel/hotPatchResourceStore.ts";

const resource = value => {
  const bytes = Buffer.from(value);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
};

test("resource snapshots are immutable and expose verified bytes", () => {
  const first = resource('{"v":1}');
  const store = new HotPatchResourceStore({ "ui.json": first });
  assert.equal(store.text("ui.json"), '{"v":1}');
  assert.equal(store.hashes["ui.json"], first.sha256);
  const bytes = store.read("ui.json");
  bytes[0] = 0;
  assert.equal(store.text("ui.json"), '{"v":1}');
  assert.throws(() => new HotPatchResourceStore({ "ui.json": { ...first, sha256: "0".repeat(64) } }), /content, hash/);
});

test("resource paths and missing resources are rejected", () => {
  assert.throws(() => new HotPatchResourceStore({ "../secret": { sha256: "0".repeat(64), base64: "" } }), /normalized/);
  const store = new HotPatchResourceStore();
  assert.throws(() => store.read("missing"), /not found/);
});
