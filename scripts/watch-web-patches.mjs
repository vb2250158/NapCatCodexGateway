import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWebPatchInput, webPatchInputHash } from "./lib/web-patch-inputs.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let dirty = false;
let running = false;
let stopped = false;
let timer;
let lastAttempt;
const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
  if (!filename || isWebPatchInput(String(filename))) schedule();
});

function schedule() {
  if (stopped) return;
  dirty = true;
  if (running || timer) return;
  timer = setTimeout(() => { timer = undefined; void build(); }, 300);
}

async function build() {
  if (stopped) return;
  running = true;
  dirty = false;
  try {
    const digest = await webPatchInputHash(root);
    if (digest === lastAttempt) return;
    lastAttempt = digest;
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/build-web-patch.mjs", "--build"], {
        cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env, RABIROUTE_WEB_PATCH_INPUT_HASH: digest }
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ? 1 : code));
    });
    if (status !== 0) console.error("Web candidate build failed; the installed release is unchanged. Save a corrected input to retry.");
  } catch (error) { console.error(String(error)); }
  finally { running = false; if (dirty) schedule(); }
}

function stop() {
  stopped = true;
  watcher.close();
  if (timer) clearTimeout(timer);
}
watcher.on("error", error => { console.error(String(error)); stop(); process.exitCode = 1; });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
schedule();
