import fs from "node:fs";
import path from "node:path";
import { canonicalLogicalPlanId } from "./planStorageIdentity.js";

type IdentityEntry = { fingerprint: string; id: string | null };
const MAX_CACHED_IDENTITIES = 4096;
const entries = new Map<string, IdentityEntry>();

function fingerprint(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function identity(text: string): string | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!raw || !String(raw.title || "").trim() || !raw.id) return null;
  return canonicalLogicalPlanId(raw.id);
}

function remember(file: string, entry: IdentityEntry): string | null {
  entries.delete(file);
  entries.set(file, entry);
  if (entries.size > MAX_CACHED_IDENTITIES) entries.delete(entries.keys().next().value!);
  return entry.id;
}

/** Derived identity only. Every lookup rechecks file metadata, including atomic replacement and restored mtime. */
export function readPlanIdentity(filePath: string): string | null {
  const file = path.resolve(filePath);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = fingerprint(fs.statSync(file));
      const cached = entries.get(file);
      if (cached?.fingerprint === before) return cached.id;
      const id = identity(fs.readFileSync(file, "utf8"));
      if (fingerprint(fs.statSync(file)) === before) return remember(file, { fingerprint: before, id });
    }
    throw new Error("Plan identity file changed during verification.");
  } catch (error) {
    entries.delete(file);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export async function readPlanIdentityAsync(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const file = path.resolve(filePath);
  signal?.throwIfAborted();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = fingerprint(await abortable(fs.promises.stat(file), signal));
      const cached = entries.get(file);
      if (cached?.fingerprint === before) return cached.id;
      const id = identity(await fs.promises.readFile(file, { encoding: "utf8", signal }));
      const after = fingerprint(await abortable(fs.promises.stat(file), signal));
      signal?.throwIfAborted();
      if (after === before) return remember(file, { fingerprint: before, id });
    }
    throw new Error("Plan identity file changed during verification.");
  } catch (error) {
    entries.delete(file);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
