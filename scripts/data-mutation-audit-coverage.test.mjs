import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "src");

const mutationPattern = /\bfs(?:\.promises)?\.(?:writeFile|appendFile|rename|unlink|rm|copyFile|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|copyFileSync|futimesSync|utimesSync|createWriteStream)\s*\(/;
const auditPattern = /\brecordDataMutationAudit\s*\(|\batomicWriteFileSync\s*\(|\bappendAdapterLog\s*\(/;

const infrastructureExclusions = new Map([
  ["src/manager/sourcePatchService.ts", "source patch publication journals and recovery fences; publication events use the injected audit callback"],
  ["src/manager/webPatchService.ts", "immutable Web bundle cache; committed state emits web_patch_committed through the injected audit callback"],
  ["src/manager/webPatchCatalog.ts", "content-addressed Web artifacts and atomic patch-state writer owned by WebPatchService"],
  ["src/plugin-kernel/hotPatchBundleJournal.ts", "dependency-free hot patch transaction journal with fsync and exclusive recovery locks"],
  ["src/codexAppServerClient.ts", "app-server stderr log sink"],
  ["src/managerInstanceLock.ts", "Manager ownership lock and lease files"],
  ["src/managerRuntimeDiagnostics.ts", "runtime diagnostic log sink"],
  ["src/marvis.ts", "temporary prompt file removed after process execution"],
  ["src/plan-storage/internal/lease.ts", "plan storage coordination locks and lease heartbeats"],
  ["src/manager/operationalLog.ts", "unified operational log sink and retention"],
  ["src/manager/performanceStore.ts", "performance telemetry log sink and retention"],
  ["src/plugin-kernel/packageLoader.ts", "immutable rebuildable plugin runtime cache owned by the dependency-free plugin kernel"],
  ["src/manager/routeCatalogTransaction.ts", "isolated transaction worker audited by routeCatalogStartupLifecycle"]
]);

function sourceFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) output.push(absolute);
  }
  return output;
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

test("production file mutations are audited or explicitly classified as infrastructure", () => {
  const directMutationFiles = sourceFiles(sourceRoot)
    .map(absolute => ({ absolute, relative: relativePath(absolute) }))
    .filter(file => !file.relative.startsWith("src/acceptance/"))
    .filter(file => mutationPattern.test(fs.readFileSync(file.absolute, "utf8")));

  const uncovered = directMutationFiles
    .filter(file => {
      const source = fs.readFileSync(file.absolute, "utf8");
      return !auditPattern.test(source) && !infrastructureExclusions.has(file.relative);
    })
    .map(file => file.relative);

  assert.deepEqual(uncovered, [], `Direct data mutations need recordDataMutationAudit(), atomicWriteFileSync(), or a reviewed infrastructure exclusion:\n${uncovered.join("\n")}`);

  const directPaths = new Set(directMutationFiles.map(file => file.relative));
  const staleExclusions = [...infrastructureExclusions.keys()].filter(file => !directPaths.has(file));
  assert.deepEqual(staleExclusions, [], `Remove stale mutation coverage exclusions:\n${staleExclusions.join("\n")}`);
});
