import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const output = path.join(root, "apps", "rabi-agent", "runtime");
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, "src", "agentAdapters", "instanceManagement.ts")], outfile: path.join(output, "management.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", banner: { js: 'import { createRequire as __runtimeCreateRequire } from "node:module"; const require = __runtimeCreateRequire(import.meta.url);' },
  external: ["better-sqlite3"], logLevel: "warning" });
console.log("Built shared instance Agent management runtime.");
await fs.cp(path.join(root, "dist", "agent-hooks"), path.join(root, "apps", "rabi-agent", "dist", "agent-hooks"), { recursive: true, force: true });
