import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildWebPatch, writeWebPatchJson } from "../dist/manager/webPatchCatalog.js";

const root = process.cwd();
const output = path.join(root, "dist/web-patches");
const revision = await buildWebPatch(root, output);
await writeWebPatchJson(path.join(output, "latest.json"), { revision, operationId: randomUUID() });
console.log(`Web patch candidate ready: ${revision}`);
