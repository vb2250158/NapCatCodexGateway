import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export type SourcePatchDefinition = Readonly<{ id: string; source: string; resources?: readonly string[]; dependencies?: Readonly<Record<string, unknown>>; contract?: Readonly<Record<string, unknown>> }>;

export function sourcePatchDependencyHash(dependencies: Readonly<Record<string, unknown>> = {}): string {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("Source patch dependencies must be a JSON object.");
  for (const name of Object.keys(dependencies)) if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name.startsWith("__rabi")) throw new Error("Invalid or reserved source patch dependency name.");
  const bytes = JSON.stringify(dependencies);
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error("Source patch dependencies exceed 64 KiB.");
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readSourcePatchCatalog(root: string): Promise<readonly SourcePatchDefinition[]> {
  const filename = path.join(root, "source-patches", "modules.json");
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Source patch catalog exceeds 256 KiB or is not a file.");
  const configuration = JSON.parse(await fs.readFile(filename, "utf8"));
  if (configuration?.schemaVersion !== 1 || !Array.isArray(configuration.modules) || configuration.modules.length > 128) throw new Error("Invalid source patch watch catalog.");
  const identities = new Set<string>();
  for (const entry of configuration.modules) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.id) || identities.has(entry.id)) throw new Error("Invalid or duplicate source patch module identity.");
    identities.add(entry.id);
    if (typeof entry.source !== "string" || !entry.source.endsWith(".ts")) throw new Error("Source patch module must be TypeScript.");
    if (entry.resources !== undefined && (!Array.isArray(entry.resources) || entry.resources.length > 128 || new Set(entry.resources).size !== entry.resources.length)) throw new Error("Invalid source patch resources.");
    for (const file of [entry.source, ...(entry.resources ?? [])]) {
      if (typeof file !== "string" || !file || file.includes("\\") || file.includes(":") || file.includes("\0") || file.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(file)) throw new Error("Source patch paths must be relative files inside the source root.");
    }
    if (entry.contract !== undefined && (!entry.contract || typeof entry.contract !== "object" || Array.isArray(entry.contract))) throw new Error("Invalid source patch contract.");
    sourcePatchDependencyHash(entry.dependencies);
  }
  return configuration.modules;
}
