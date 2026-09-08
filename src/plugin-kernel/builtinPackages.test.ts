import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parsePluginManifest } from "./manifest.js";
import { parsePluginProfile } from "./profile.js";

test("built-in Manager capabilities are independent SDK packages", async () => {
  const root = path.resolve("plugins");
  const profile = parsePluginProfile(JSON.parse(await fs.readFile(path.join(root, "profiles", "desktop.json"), "utf8")) as unknown);
  const packageDirectories = (await fs.readdir(path.join(root, "builtin"), { withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(profile.instances.length, packageDirectories.length);
  assert.equal(new Set(profile.instances.map(instance => instance.package)).size, packageDirectories.length);
  assert.equal(
    profile.instances.some(instance => instance.package === "io.rabiroute.manager.wearable-companion"),
    true
  );
  for (const instance of profile.instances) {
    const packageRoot = path.join(root, "builtin", encodeURIComponent(instance.package), instance.version);
    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(packageRoot, "rabi.plugin.json"), "utf8")) as unknown);
    const source = await fs.readFile(path.join(packageRoot, "manager.mjs"), "utf8");
    assert.equal(manifest.id, instance.package);
    assert.deepEqual(manifest.entries.manager, { execution: "in_process", module: "./manager.mjs" });
    if (manifest.entries.web) assert.deepEqual(manifest.entries.web, { execution: "in_process", module: "./web/client.mjs" });
    assert.match(source, /from "@rabiroute\/plugin-sdk"/);
    assert.doesNotMatch(source, /from ["'][^"']*src\/|from ["'][^"']*manager\/controlPlaneRoutes/);
    assert.doesNotMatch(source, /^ {8}if [^\n]+\r?\n {12}return;$/m);
    assert.doesNotMatch(source, /\b(?:const|let)\s+runtime\s*=\s*runtime\./);
    assert.doesNotMatch(source, /\b(?:map|filter|find)\(\s*runtime\s*=>/);
    if (manifest.id === "io.rabiroute.manager.gateway-runtime") {
      assert.match(source, /acquireGatewayRuntimePluginLease/);
      assert.match(source, /testAgentDelivery:\s*runtime\.testAgentDelivery/);
      assert.doesNotMatch(source, /gatewayRuntimePluginActive/);
    }
    await fs.access(path.join(packageRoot, "README.md"));
    await fs.access(path.join(packageRoot, "README_en.md"));
  }
});

