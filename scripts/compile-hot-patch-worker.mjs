import { parentPort } from "node:worker_threads";
import { buildHotPatchCandidate } from "./compile-hot-patch.mjs";
import { inspectSourcePatchDependencies } from "./lib/source-patch-dependencies.mjs";

if (!parentPort) throw new Error("Hot patch compiler worker requires a parent port.");

parentPort.on("message", async message => {
  try {
    const result = message.action === "inspect-dependencies"
      ? inspectSourcePatchDependencies(message.root, message.sources)
      : await buildHotPatchCandidate(message);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { name: error?.name, message: error?.message, stack: error?.stack } });
  }
});
