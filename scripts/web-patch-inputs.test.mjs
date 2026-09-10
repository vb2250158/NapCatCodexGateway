import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isWebPatchInput, webPatchInputHash } from "./lib/web-patch-inputs.mjs";

test("Web build watch includes new source modules and resources but excludes output and its own lock", async context => {
  for (const name of ["ribiwebgui/src/new/module.ts", "docs/user-guide/page.md", "assets/image.svg", "src/shared/contract.ts"]) assert.equal(isWebPatchInput(name), true);
  for (const name of ["ribiwebgui/dist/index.html", "ribiwebgui/.web-patch-build.lock", "node_modules/file.js", "src/manager.ts"]) assert.equal(isWebPatchInput(name), false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-inputs-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "ribiwebgui/src"), { recursive: true });
  const first = await webPatchInputHash(root);
  await fs.writeFile(path.join(root, "ribiwebgui/.web-patch-build.lock"), "locked");
  assert.equal(await webPatchInputHash(root), first);
  await fs.writeFile(path.join(root, "ribiwebgui/src/new.ts"), "export const value = 1;");
  assert.notEqual(await webPatchInputHash(root), first);
});
