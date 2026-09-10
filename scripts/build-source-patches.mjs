import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHotPatchCandidate } from "./compile-hot-patch.mjs";
import { HotPatchResourceStore } from "../dist/plugin-kernel/hotPatchResourceStore.js";
import { readSourcePatchCatalog } from "../dist/manager/sourcePatchCatalog.js";

export async function buildSourcePatches(root = process.cwd()) {
  const definitions = await readSourcePatchCatalog(root);
  const outputDirectory = path.join(root, "dist", "source-patches");
  const modules = [];
  for (const definition of definitions) {
    const sourcePath = path.resolve(root, definition.source);
    const relative = path.relative(path.resolve(root), sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".ts")) throw new Error("Source patch module must be TypeScript inside the source tree.");
    const resourceStore = await HotPatchResourceStore.capture(root, definition.resources ?? []);
    const result = await buildHotPatchCandidate({ sourcePath, outputDirectory, resourceData: resourceStore.data });
    modules.push({ id: definition.id, sha256: result.sha256, dependencies: definition.dependencies, contract: { ...definition.contract, resources: resourceStore.hashes } });
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules }, null, 2) + "\n");
  return modules;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modules = await buildSourcePatches();
  console.log(`Built ${modules.length} source patch baselines.`);
}
