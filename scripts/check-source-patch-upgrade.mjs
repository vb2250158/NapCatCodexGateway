import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function checkSourcePatchUpgrade(candidateRoot, stateRoot) {
  const { ManagerSourcePatchService } = await import(pathToFileURL(path.join(candidateRoot, "dist/manager/sourcePatchService.js")).href);
  const catalog = JSON.parse(await fs.readFile(path.join(candidateRoot, "dist/source-patches/catalog.json"), "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.modules)) throw new Error("Invalid source patch upgrade catalog.");
  const result = [];
  for (const entry of catalog.modules) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid source patch upgrade identity.");
    const raw = await fs.readFile(path.join(stateRoot, "active", `${entry.id}.json`), "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) { result.push({ moduleId: entry.id, state: "fresh" }); continue; }
    const pointer = JSON.parse(raw);
    if (pointer.baselineSha256 === entry.sha256) { result.push({ moduleId: entry.id, state: "unchanged" }); continue; }
    await ManagerSourcePatchService.validateBaselineUpgrade(stateRoot, entry.id, pointer, entry.contract);
    result.push({ moduleId: entry.id, state: "clean_baseline_upgrade", previous: pointer.baselineSha256, next: entry.sha256 });
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [candidateRoot, stateRoot] = process.argv.slice(2);
  if (!candidateRoot || !stateRoot || !path.isAbsolute(candidateRoot) || !path.isAbsolute(stateRoot)) throw new Error("Explicit absolute candidate and source-patch state roots are required.");
  console.log(JSON.stringify({ ready: true, modules: await checkSourcePatchUpgrade(candidateRoot, stateRoot) }));
}
