import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const webPatchInputs = ["ribiwebgui", "assets", "docs", "src/shared", "package.json", "package-lock.json", "scripts/sync-plugin-web-bundles.mjs"];

export function isWebPatchInput(relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.split("/").some(part => ["dist", "node_modules", ".git", ".web-patch-build.lock"].includes(part))) return false;
  return webPatchInputs.some(input => normalized === input || normalized.startsWith(`${input}/`));
}

export async function webPatchInputHash(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) { hash.update(`${relative}\0absent\n`); return; }
    if (stat.isSymbolicLink()) throw new Error("Web build inputs cannot contain symbolic links.");
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) {
        const child = `${relative}/${name}`;
        if (isWebPatchInput(child)) await visit(child);
      }
    } else if (stat.isFile()) {
      hash.update(`${relative}\0${createHash("sha256").update(await fs.readFile(filename)).digest("hex")}\n`);
    }
  }
  for (const input of webPatchInputs) await visit(input);
  return hash.digest("hex");
}
