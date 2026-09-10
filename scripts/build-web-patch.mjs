import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildWebPatch, writeWebPatchJson } from "../dist/manager/webPatchCatalog.js";
import { webPatchInputHash } from "./lib/web-patch-inputs.mjs";

const root = process.cwd();
const output = path.join(root, "dist/web-patches");
let lock;
const lockPath = path.join(root, "ribiwebgui", ".web-patch-build.lock");
try {
if (process.argv.includes("--build")) {
  lock = await fs.open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  process.env.RABIROUTE_WEB_PATCH_INPUT_HASH ||= await webPatchInputHash(root);
  for (const argumentsList of [
    ["node_modules/vue-tsc/bin/vue-tsc.js", "-p", "ribiwebgui/tsconfig.json", "--noEmit"],
    ["node_modules/vite/bin/vite.js", "build", "--config", "ribiwebgui/vite.config.ts"],
    ["scripts/sync-plugin-web-bundles.mjs"]
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argumentsList, { cwd: root, windowsHide: true, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 && !signal ? resolve() : reject(new Error("Web build failed; no completion marker was published.")));
    });
  }
}
const revision = await buildWebPatch(root, output);
if (process.env.RABIROUTE_WEB_PATCH_INPUT_HASH && await webPatchInputHash(root) !== process.env.RABIROUTE_WEB_PATCH_INPUT_HASH) {
  throw new Error("Web sources changed during the build; the obsolete candidate was not published.");
}
await writeWebPatchJson(path.join(output, "latest.json"), { revision, operationId: randomUUID() });
console.log(`Web patch candidate ready: ${revision}`);
} finally {
  if (lock) { await lock.close(); await fs.unlink(lockPath); }
}
