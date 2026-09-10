import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";
import { HotPatchModule } from "../src/plugin-kernel/hotPatchModule.ts";

const source = `declare const __rabiResources: { text(path: string): string };
export async function read(delay: number) {
  await new Promise(resolve => setTimeout(resolve, delay));
  return __rabiResources.text("x.txt");
}`;
const resource = value => {
  const bytes = Buffer.from(value);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
};

test("resource reads follow the request code revision across an automatic replacement", async () => {
  const baseline = compileHotPatchModule(source);
  const changed = compileHotPatchModule(source);
  const module = new HotPatchModule("resource-module", { ...baseline, resources: { "x.txt": resource("old") } });
  const oldRequest = module.exports.read(35);
  await new Promise(resolve => setTimeout(resolve, 5));
  module.apply({ ...changed, resources: { "x.txt": resource("new") } }, 0);
  assert.equal(await oldRequest, "old");
  assert.equal(await module.exports.read(0), "new");
  assert.throws(() => module.runtime.readResource("x.txt"), /active request lease/);
});
