import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { CompiledHotPatchModule } from "./hotPatchModule.js";
import { HotPatchResourceStore, type HotPatchResourceData } from "./hotPatchResourceStore.js";

export class HotPatchCandidateStore {
  constructor(private readonly directory: string, private readonly maximumBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
      throw new RangeError("Hot patch candidate size limit is invalid.");
    }
  }

  async read(sha256: string): Promise<CompiledHotPatchModule> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Hot patch candidate must be a lowercase SHA-256 identity.");
    const root = await realpath(this.directory);
    const candidate = path.join(root, `${sha256}.json`);
    const initial = await lstat(candidate);
    if (!initial.isFile() || initial.isSymbolicLink() || await realpath(candidate) !== candidate) {
      throw new Error("Hot patch candidate must be a regular file inside its managed directory.");
    }
    const handle = await open(candidate, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
        throw new Error("Hot patch candidate identity changed while opening.");
      }
      if (opened.size > this.maximumBytes) throw new Error("Hot patch candidate exceeds its size limit.");
      const buffer = Buffer.alloc(this.maximumBytes + 1);
      let received = 0;
      while (received < buffer.length) {
        const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received);
        if (!bytesRead) break;
        received += bytesRead;
      }
      if (received > this.maximumBytes) throw new Error("Hot patch candidate exceeds its size limit.");
      const bytes = buffer.subarray(0, received);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Hot patch candidate content hash does not match.");
      return parseCompiledModule(JSON.parse(bytes.toString("utf8")));
    } finally { await handle.close(); }
  }
}

function parseCompiledModule(value: unknown): CompiledHotPatchModule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hot patch artifact.");
  const candidate = value as Record<string, unknown>;
  const strings = (items: unknown): items is string[] => Array.isArray(items)
    && items.every(item => typeof item === "string") && new Set(items).size === items.length;
  if (candidate.schemaVersion !== 1
    || typeof candidate.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sourceHash)
    || typeof candidate.compatibilityHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.compatibilityHash)
    || typeof candidate.initializationSource !== "string" || typeof candidate.environmentDescriptors !== "string"
    || !candidate.sourceMaps || typeof candidate.sourceMaps !== "object" || Array.isArray(candidate.sourceMaps)
    || !strings(candidate.dependencies) || !strings(candidate.functionNames) || !strings(candidate.exported)
    || !candidate.implementations || typeof candidate.implementations !== "object" || Array.isArray(candidate.implementations)
    || !Object.keys(candidate.implementations).length
    || !Object.values(candidate.implementations).every(code => typeof code === "string")) {
    throw new Error("Invalid hot patch artifact schema.");
  }
  return Object.freeze({
    schemaVersion: 1, sourceHash: candidate.sourceHash, compatibilityHash: candidate.compatibilityHash,
    initializationSource: candidate.initializationSource, environmentDescriptors: candidate.environmentDescriptors,
    dependencies: Object.freeze([...candidate.dependencies]), functionNames: Object.freeze([...candidate.functionNames]),
    exported: Object.freeze([...candidate.exported]),
    implementations: Object.freeze({ ...candidate.implementations as Record<string, string> }),
    ...(candidate.resources === undefined ? {} : { resources: new HotPatchResourceStore(candidate.resources as HotPatchResourceData).data }),
    sourceMaps: Object.freeze(Object.fromEntries(Object.entries(candidate.sourceMaps).map(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid source map for hot patch symbol: ${id}`);
      const map = value as Record<string, unknown>;
      if (map.version !== 3 || typeof map.file !== "string" || typeof map.mappings !== "string"
        || !Array.isArray(map.sources) || !map.sources.every(source => typeof source === "string")
        || !Array.isArray(map.sourcesContent) || !map.sourcesContent.every(source => typeof source === "string")) {
        throw new Error(`Invalid source map for hot patch symbol: ${id}`);
      }
      return [id, Object.freeze({ ...map, sources: Object.freeze([...map.sources]), sourcesContent: Object.freeze([...map.sourcesContent]) })];
    })))
  });
}
