import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileHotPatchModule, diffHotPatchModules } from "./lib/hot-patch-compiler.mjs";

export async function buildHotPatchCandidate({ sourcePath, sourceContent, outputDirectory, baselinePath, resourceData }) {
  const source = sourceContent ?? await fs.readFile(sourcePath, "utf8");
  const compiled = { ...compileHotPatchModule(source, path.resolve(sourcePath)), ...(resourceData === undefined ? {} : { resources: resourceData }) };
  const baseline = baselinePath ? JSON.parse(await fs.readFile(baselinePath, "utf8")) : undefined;
  const changes = baseline ? diffHotPatchModules(baseline, compiled).map(change => change.name) : Object.keys(compiled.implementations);
  if (baseline && !changes.length) return Object.freeze({ changed: false, sourceHash: compiled.sourceHash, symbols: [] });
  const bytes = JSON.stringify(compiled, null, 2) + "\n";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.resolve(outputDirectory, `${sha256}.json`);
  try {
    await fs.writeFile(outputPath, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST" || await fs.readFile(outputPath, "utf8") !== bytes) throw error;
  }
  return Object.freeze({ changed: true, outputPath, sha256, sourceHash: compiled.sourceHash, symbols: changes });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = new Map();
  const allowed = new Set(["--source", "--output-directory", "--baseline"]);
  for (let position = 2; position < process.argv.length; position += 2) {
    const key = process.argv[position];
    const value = process.argv[position + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid hot patch compiler arguments.");
    values.set(key, value);
  }
  if (!values.has("--source") || !values.has("--output-directory")) {
    throw new Error("Usage: node scripts/compile-hot-patch.mjs --source module.ts --output-directory local-candidates [--baseline candidate.json]");
  }
  const result = await buildHotPatchCandidate({
    sourcePath: values.get("--source"), outputDirectory: values.get("--output-directory"), baselinePath: values.get("--baseline")
  });
  console.log(JSON.stringify(result));
}
