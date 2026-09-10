import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

export function inspectSourcePatchDependencies(root, sources) {
  root = fs.realpathSync(root);
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const cache = new Map();
  let totalBytes = 0;
  const inside = file => {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const inspect = file => {
    file = path.resolve(file);
    if (!inside(file)) throw new Error("Source patch dependency escapes its source root.");
    if (cache.has(file)) return cache.get(file);
    if (cache.size >= 2048) throw new Error("Source patch dependency graph exceeds 2048 files.");
    let text;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error("Source patch dependencies must be regular files without symbolic links.");
      if (stat.isDirectory()) { cache.set(file, { sha256: null, imports: [] }); return cache.get(file); }
      if (!stat.isFile()) throw new Error("Source patch dependencies must be regular files without symbolic links.");
      if (stat.size > 2 * 1024 * 1024) throw new Error("Source patch dependency exceeds 2 MiB.");
      totalBytes += stat.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error("Source patch dependency graph exceeds 32 MiB.");
      text = fs.readFileSync(file, "utf8");
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    const result = { sha256: text === undefined ? null : createHash("sha256").update(text).digest("hex"), imports: [] };
    cache.set(file, result);
    if (text === undefined) return result;
    const parsed = ts.preProcessFile(text, true, true);
    for (const reference of [...parsed.importedFiles, ...parsed.referencedFiles]) {
      if (!reference.fileName.startsWith(".")) continue;
      const resolved = ts.resolveModuleName(reference.fileName, file, options, ts.sys).resolvedModule;
      if (resolved) result.imports.push(path.resolve(resolved.resolvedFileName));
      else {
        const base = path.resolve(path.dirname(file), reference.fileName).replace(/\.(?:m?js|cjs)$/, "");
        result.imports.push(base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, "index.ts"));
      }
    }
    return result;
  };
  const modules = sources.map(source => {
    const visited = new Set();
    const queue = [path.resolve(root, source)];
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const node = inspect(file);
      queue.push(...node.imports);
    }
    return { source, files: Object.fromEntries([...visited].sort().map(file => [file, cache.get(file).sha256])) };
  });
  return { modules };
}
