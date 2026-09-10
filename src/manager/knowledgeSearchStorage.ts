import fs from "node:fs";
import path from "node:path";
import { readKnowledgeSearchFileInWorker } from "../roleKnowledge.js";
import { knowledgeReference, type KnowledgeChange, type KnowledgeKind } from "../roleKnowledgeSearch.js";

export type KnowledgeFileStamp = { fingerprint: string; reference: string };
export type KnowledgeInventory = Record<string, KnowledgeFileStamp>;
export type KnowledgeStorageDelta = {
  inventory: KnowledgeInventory; changes: KnowledgeChange[]; removed: string[];
  errors: number; filesRead: number;
};

function list(directory: string): fs.Dirent[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function stamp(file: string): string {
  const stat = fs.statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Metadata reconciliation is worker-only. Only changed documents are parsed. */
export function readKnowledgeStorageDelta(roleDir: string, previous: KnowledgeInventory): KnowledgeStorageDelta {
  if (!fs.statSync(roleDir).isDirectory()) throw new Error("Knowledge role directory is unavailable");
  const files: Array<{ file: string; kind: KnowledgeKind }> = [];
  for (const bucket of ["active", "archive"]) {
    const directory = path.join(roleDir, "plans", bucket);
    for (const entry of list(directory)) if (entry.isDirectory()) {
      files.push({ file: path.join(directory, entry.name, "plan.json"), kind: "plan" });
    }
  }
  for (const kind of ["recent", "consolidated"] as const) {
    const directory = path.join(roleDir, "memory", kind);
    for (const entry of list(directory)) if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) {
      files.push({ file: path.join(directory, entry.name), kind });
    }
  }
  const inventory: KnowledgeInventory = {};
  const changedFiles = new Map<string, KnowledgeChange>();
  let errors = 0;
  let filesRead = 0;
  for (const { file, kind } of files) {
    const old = previous[file];
    try {
      const before = stamp(file);
      if (old?.fingerprint === before) { inventory[file] = old; continue; }
      filesRead += 1;
      const change = readKnowledgeSearchFileInWorker(file, kind);
      if (stamp(file) !== before) throw new Error("Knowledge file changed during read");
      inventory[file] = { fingerprint: before, reference: knowledgeReference(kind, change.item.id) };
      changedFiles.set(file, change);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors += 1;
      if (old) inventory[file] = old;
    }
  }
  if (errors) for (const [file, entry] of Object.entries(previous)) inventory[file] ??= entry;
  const winners = (entries: KnowledgeInventory) => {
    const selected = new Map<string, string>();
    // Match the existing memory catalog: Markdown takes precedence over legacy JSON.
    const ordered = Object.keys(entries).sort((a, b) => Number(!a.toLowerCase().endsWith(".md"))
      - Number(!b.toLowerCase().endsWith(".md")) || a.localeCompare(b));
    for (const file of ordered) {
      const ref = entries[file].reference;
      if (selected.has(ref) && JSON.parse(ref)[0] === "plan") throw new Error("Duplicate plan identity; retaining the previous index");
      if (!selected.has(ref)) selected.set(ref, file);
    }
    return selected;
  };
  const current = winners(inventory);
  const prior = winners(previous);
  const changes: KnowledgeChange[] = [];
  for (const [ref, file] of current) {
    let change = changedFiles.get(file);
    if (!change && prior.get(ref) !== file) {
      try {
        filesRead += 1;
        change = readKnowledgeSearchFileInWorker(file, JSON.parse(ref)[0] as KnowledgeKind);
        if (stamp(file) !== inventory[file].fingerprint) throw new Error("Knowledge file changed during read");
      } catch { errors += 1; inventory[file] = { ...inventory[file], fingerprint: "" }; continue; }
    }
    if (change) changes.push(change);
  }
  const currentRefs = new Set(current.keys());
  return { inventory, changes, removed: errors ? [] : [...new Set(Object.values(previous).map(entry => entry.reference))]
    .filter(ref => !currentRefs.has(ref)), errors, filesRead };
}
