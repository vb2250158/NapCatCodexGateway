import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export type HotPatchResourceData = Readonly<Record<string, Readonly<{ sha256: string; base64: string }>>>;

export class HotPatchResourceStore {
  static readonly maximumFiles = 128;
  static readonly maximumFileBytes = 512 * 1024;
  static readonly maximumTotalBytes = 2 * 1024 * 1024;
  readonly data: HotPatchResourceData;
  readonly hashes: Readonly<Record<string, string>>;
  readonly sha256: string;

  constructor(input: HotPatchResourceData = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid hot patch resource snapshot.");
    const entries = Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length > HotPatchResourceStore.maximumFiles) throw new Error("Hot patch resource count exceeds its limit.");
    let totalBytes = 0;
    const values = entries.map(([name, value]) => {
      validatePath(name);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.base64 !== "string" || typeof value.sha256 !== "string"
        || Object.keys(value).some(key => key !== "base64" && key !== "sha256")
        || value.base64.length > Math.ceil(HotPatchResourceStore.maximumFileBytes / 3) * 4) {
        throw new Error("Invalid or oversized hot patch resource.");
      }
      const bytes = Buffer.from(value.base64, "base64");
      totalBytes += bytes.length;
      if (bytes.length > HotPatchResourceStore.maximumFileBytes || totalBytes > HotPatchResourceStore.maximumTotalBytes
        || bytes.toString("base64") !== value.base64 || digest(bytes) !== value.sha256) {
        throw new Error("Hot patch resource content, hash or size is invalid.");
      }
      return [name, Object.freeze({ sha256: value.sha256, base64: value.base64 })] as const;
    });
    this.data = Object.freeze(Object.fromEntries(values));
    this.hashes = Object.freeze(Object.fromEntries(values.map(([name, value]) => [name, value.sha256])));
    this.sha256 = digest(JSON.stringify(this.hashes));
    Object.freeze(this);
  }

  read(name: string): Uint8Array {
    if (!Object.hasOwn(this.data, name)) throw new Error(`Hot patch resource was not found: ${name}.`);
    return Uint8Array.from(Buffer.from(this.data[name]!.base64, "base64"));
  }

  text(name: string): string { return new TextDecoder("utf-8", { fatal: true }).decode(this.read(name)); }

  static async capture(root: string, files: readonly string[]): Promise<HotPatchResourceStore> {
    if (!Array.isArray(files) || files.length > HotPatchResourceStore.maximumFiles || new Set(files).size !== files.length) {
      throw new Error("Invalid hot patch resource catalog.");
    }
    const canonicalRoot = await realpath(root);
    const resources: Record<string, Readonly<{ sha256: string; base64: string }>> = {};
    let totalBytes = 0;
    for (const name of [...files].sort()) {
      validatePath(name);
      const target = path.join(canonicalRoot, name);
      const canonical = await realpath(target);
      if (canonical !== target) throw new Error("Hot patch resources must not traverse symbolic links.");
      const initial = await lstat(target);
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Hot patch resources must be regular files.");
      const handle = await open(target, "r");
      try {
        const before = await handle.stat();
        if (before.ino !== initial.ino || before.dev !== initial.dev || before.size > HotPatchResourceStore.maximumFileBytes) {
          throw new Error("Hot patch resource identity or size changed while opening.");
        }
        const buffer = Buffer.alloc(HotPatchResourceStore.maximumFileBytes + 1);
        let received = 0;
        while (received < buffer.length) {
          const result = await handle.read(buffer, received, buffer.length - received, received);
          if (!result.bytesRead) break;
          received += result.bytesRead;
        }
        const after = await handle.stat();
        totalBytes += received;
        if (received > HotPatchResourceStore.maximumFileBytes || totalBytes > HotPatchResourceStore.maximumTotalBytes
          || before.size !== received || after.size !== received || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error("Hot patch resource changed during capture or exceeds its limit.");
        }
        const bytes = buffer.subarray(0, received);
        resources[name] = { sha256: digest(bytes), base64: bytes.toString("base64") };
      } finally { await handle.close(); }
    }
    return new HotPatchResourceStore(resources);
  }
}

function validatePath(name: string): void {
  if (typeof name !== "string" || !name.trim() || name.includes("\\") || name.includes(":") || name.includes("\0")
    || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Hot patch resource paths must be normalized relative paths.");
  }
}

function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
