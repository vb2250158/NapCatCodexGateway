import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type WebPatchFile = { path: string; sha256: string; size: number };
export type WebPatchManifest = {
  schemaVersion: 1;
  backend: string;
  files: WebPatchFile[];
  modules: { pluginId: string; version: string; entry: string }[];
};
export const WEB_PATCH_HASH = /^[a-f0-9]{64}$/;
export const WEB_PATCH_PREFIX = "/_rabiroute/web/";
const maximumBytes = 128 * 1024 * 1024;

export function webPatchHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function webPatchPath(value: string): string {
  if (typeof value !== "string" || !/^(web|docs)\/[A-Za-z0-9_./\-\u0080-\uffff]+$/.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith("."))) throw new Error("Invalid Web patch path.");
  return value;
}

async function walk(root: string, prefix = "", excluded: string[] = []): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excluded.some(name => relative === name || relative.startsWith(name + "/"))) continue;
    if (entry.isDirectory()) result.push(...await walk(root, relative, excluded));
    else if (entry.isFile()) result.push(relative);
    if (result.length > 8192) throw new Error("Web patch input has too many files.");
  }
  return result.sort();
}

async function fileHash(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function webPatchBackend(packageRoot: string): Promise<string> {
  const root = path.join(packageRoot, "dist");
  const files = (await walk(root, "", ["web-patches", "agent-hooks"])).filter(file => /\.(js|mjs|json)$/.test(file)
    && !file.endsWith(".test.js") && !file.includes("/web/") && !file.startsWith("agent-hooks/") && !file.startsWith("web-patches/"));
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0${await fileHash(path.join(root, file))}\n`);
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await fs.readFile(path.join(packageRoot, name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    hash.update(`${name}\0${bytes ? webPatchHash(bytes) : "absent"}\n`);
  }
  return hash.digest("hex");
}

export async function writeWebPatchJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

export async function verifyWebPatch(root: string, expected: string): Promise<WebPatchManifest> {
  if (!WEB_PATCH_HASH.test(expected)) throw new Error("Invalid Web patch hash.");
  if ((await fs.lstat(root)).isSymbolicLink() || (await fs.lstat(path.join(root, "manifest.json"))).isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
  const raw = await fs.readFile(path.join(root, "manifest.json"));
  if (raw.length > 2 * 1024 * 1024 || webPatchHash(raw) !== expected) throw new Error("Web patch manifest hash mismatch.");
  const manifest = JSON.parse(raw.toString()) as WebPatchManifest;
  if (manifest.schemaVersion !== 1 || !WEB_PATCH_HASH.test(manifest.backend) || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > 8192 || !Array.isArray(manifest.modules) || manifest.modules.length > 128) throw new Error("Invalid Web patch manifest.");
  const names = new Set<string>();
  const portableNames = new Set<string>();
  let bytes = 0;
  const realRoot = await fs.realpath(root);
  for (const file of manifest.files) {
    webPatchPath(file.path);
    if (portableNames.has(file.path.toLowerCase()) || !WEB_PATCH_HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid Web patch file record.");
    names.add(file.path);
    portableNames.add(file.path.toLowerCase());
    bytes += file.size;
    if (bytes > maximumBytes || file.size > 16 * 1024 * 1024) throw new Error("Web patch exceeds its byte budget.");
    const filename = await fs.realpath(path.join(root, file.path));
    let ancestor = root;
    for (const segment of file.path.split("/")) {
      ancestor = path.join(ancestor, segment);
      if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
    }
    if (!filename.startsWith(realRoot + path.sep) || (await fs.lstat(path.join(root, file.path))).isSymbolicLink()
      || (await fs.stat(filename)).size !== file.size || await fileHash(filename) !== file.sha256) throw new Error("Web patch file verification failed.");
  }
  if (!names.has("web/index.html") || !manifest.files.some(file => file.path.startsWith("docs/"))) throw new Error("Web patch requires a root document and versioned documentation.");
  const moduleIds = new Set<string>();
  for (const module of manifest.modules) {
    const id = `${module.pluginId}@${module.version}`;
    if (typeof module.pluginId !== "string" || typeof module.version !== "string" || moduleIds.has(id)
      || !module.entry.startsWith("web/assets/") || !names.has(module.entry)) throw new Error("Invalid Web Bundle entry.");
    moduleIds.add(id);
  }
  const html = await fs.readFile(path.join(root, "web/index.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)=["']((?:\.\/|\/)?assets\/[^"']+)["']/g)) {
    const target = `web/${match[1]!.replace(/^\.?\//, "").split(/[?#]/)[0]}`;
    if (!names.has(target)) throw new Error(`Web root references a missing asset: ${target}`);
  }
  return manifest;
}

export async function buildWebPatch(packageRoot: string, outputRoot: string): Promise<string> {
  const temporary = path.join(outputRoot, `.staging-${randomUUID()}`);
  const manifest: WebPatchManifest = { schemaVersion: 1, backend: await webPatchBackend(packageRoot), files: [], modules: [] };
  await fs.mkdir(temporary, { recursive: true });
  try {
    for (const [source, destination] of [["ribiwebgui/dist", "web"], ["assets", "web/assets"], ["docs", "docs"]]) {
      for (const relative of await walk(path.join(packageRoot, source!))) {
        const name = webPatchPath(`${destination}/${relative}`);
        const target = path.join(temporary, name);
        if (manifest.files.some(file => file.path === name)) continue;
        const origin = path.join(packageRoot, source!, relative);
        const size = (await fs.stat(origin)).size;
        if (size > maximumBytes || manifest.files.reduce((sum, file) => sum + file.size, size) > maximumBytes) throw new Error("Web patch exceeds its byte budget.");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(origin, target);
        manifest.files.push({ path: name, size, sha256: await fileHash(target) });
      }
    }
    const packages = path.join(packageRoot, "dist/plugins/packages");
    for (const name of await walk(packages)) {
      if (!name.endsWith("/rabi.plugin.json")) continue;
      const pluginRoot = path.dirname(path.join(packages, name));
      const plugin = JSON.parse(await fs.readFile(path.join(packages, name), "utf8"));
      const entry = plugin.entries?.web?.module;
      if (!entry) continue;
      const source = await fs.readFile(path.join(pluginRoot, entry), "utf8");
      const match = source.match(/^export \{ activate \} from "\/(assets\/[A-Za-z0-9._/-]+)";\s*$/);
      if (!match) throw new Error(`Web Bundle wrapper is not supported: ${plugin.id}`);
      manifest.modules.push({ pluginId: plugin.id, version: plugin.version, entry: `web/${match[1]}` });
    }
    manifest.files.sort((left, right) => left.path.localeCompare(right.path));
    manifest.modules.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    const raw = JSON.stringify(manifest);
    const revision = webPatchHash(raw);
    await fs.writeFile(path.join(temporary, "manifest.json"), raw);
    await verifyWebPatch(temporary, revision);
    const destination = path.join(outputRoot, revision);
    try { await fs.rename(temporary, destination); }
    catch (error) {
      if (!await fs.stat(destination).catch(() => undefined)) throw error;
      await verifyWebPatch(destination, revision);
    }
    return revision;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
