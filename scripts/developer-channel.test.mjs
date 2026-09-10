import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeveloperCandidate } from "./new-rabiroute-developer-candidate.mjs";

function write(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("developer candidate overlays only built runtime layers and leaves the immutable base unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-developer-candidate-"));
  const base = path.join(root, "base");
  const build = path.join(root, "build");
  const tray = path.join(root, "tray");
  const host = path.join(root, "host");
  const versions = path.join(root, "versions");
  try {
    write(base, "dist/manager.js", "old manager\n");
    write(base, "ribiwebgui/dist/index.html", "old web\n");
    write(base, "desktop-runtime/main.py", "old tray\n");
    write(base, "desktop-runtime/rabiroute_tray/tray_app.py", "old tray module\n");
    write(base, "RabiRouteHost.Core.dll", "old core\n");
    write(base, "assets/default-persona-plan-workflow.json", "old workflow\n");
    write(base, "docs/rabi-agent-interfaces.md", "old contract\n");
    write(base, "plugins/builtin/test/manager.mjs", "old plugin\n");
    write(base, "plugins/builtin/retired/manager.mjs", "retired plugin\n");
    write(base, "skills/retired/SKILL.md", "retired skill\n");
    write(base, "source-patches/retired.json", "retired catalog\n");
    write(base, "node.exe", "node\n");
    write(base, "node_modules/dep/index.js", "dependency\n");
    write(base, "release-manifest.json", "old manifest\n");
    write(build, "dist/manager.js", "new manager\n");
    write(build, "ribiwebgui/dist/index.html", "new web\n");
    write(build, "assets/default-persona-plan-workflow.json", "new workflow\n");
    write(build, "docs/rabi-agent-interfaces.md", "new contract\n");
    write(build, "plugins/builtin/test/manager.mjs", "new plugin\n");
    write(build, "skills/rabi-knowledge-search/SKILL.md", "new knowledge search contract\n");
    write(build, "skills/source-hot-patch-development/SKILL.md", "new source patch contract\n");
    write(build, "source-patches/modules.json", '{"modules":[]}\n');
    for (const name of ["README.md", "README_zh.md", "版本更新日志.md", "版本更新日志_en.md"]) {
      write(base, name, "old release guide\n");
      write(build, name, "current release guide\n");
    }
    write(tray, "main.py", "new tray\n");
    write(tray, "rabiroute_tray/tray_app.py", "new tray module\n");
    write(host, "RabiRouteHost.Core.dll", "new core\n");

    const result = createDeveloperCandidate({
      baseRoot: base,
      buildRoot: build,
      traySourceRoot: tray,
      hostCoreRoot: host,
      versionsRoot: versions,
      packageVersion: "0.2.2-dev.20260901T120000Z"
    });

    assert.equal(fs.readFileSync(path.join(base, "dist", "manager.js"), "utf8"), "old manager\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "dist", "manager.js"), "utf8"), "new manager\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "ribiwebgui", "dist", "index.html"), "utf8"), "new web\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "assets", "default-persona-plan-workflow.json"), "utf8"), "new workflow\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "docs", "rabi-agent-interfaces.md"), "utf8"), "new contract\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "plugins", "builtin", "test", "manager.mjs"), "utf8"), "new plugin\n");
    assert.equal(fs.existsSync(path.join(result.packageRoot, "plugins", "builtin", "retired")), false);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "skills/retired")), false);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "source-patches/retired.json")), false);
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "skills/source-hot-patch-development/SKILL.md"), "utf8"), "new source patch contract\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "source-patches/modules.json"), "utf8"), '{"modules":[]}\n');
    for (const name of ["README.md", "README_zh.md", "版本更新日志.md", "版本更新日志_en.md"]) {
      assert.equal(fs.readFileSync(path.join(result.packageRoot, name), "utf8"), "current release guide\n");
      assert.equal(fs.readFileSync(path.join(base, name), "utf8"), "old release guide\n");
    }
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "skills/rabi-knowledge-search/SKILL.md"), "utf8"), "new knowledge search contract\n");
    assert.equal(fs.readFileSync(path.join(base, "docs", "rabi-agent-interfaces.md"), "utf8"), "old contract\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "desktop-runtime", "main.py"), "utf8"), "new tray\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "RabiRouteHost.Core.dll"), "utf8"), "new core\n");
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "node_modules", "dep", "index.js"), "utf8"), "dependency\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(result.packageRoot, "release-manifest.json"), "utf8"));
    assert.equal(manifest.releaseId, result.releaseId);
    assert.equal(manifest.payloadSha256, result.payloadSha256);
    assert.ok(manifest.files.some(entry => entry.path === "dist/manager.js"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate construction removes only its private staging directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-developer-candidate-failure-"));
  const base = path.join(root, "base");
  const build = path.join(root, "build");
  const tray = path.join(root, "tray");
  const host = path.join(root, "host");
  const versions = path.join(root, "versions");
  try {
    write(base, "dist/manager.js", "old manager\n");
    write(base, "ribiwebgui/dist/index.html", "old web\n");
    write(base, "desktop-runtime/main.py", "old tray\n");
    write(base, "RabiRouteHost.Core.dll", "old core\n");
    write(base, "assets/default-persona-plan-workflow.json", "old workflow\n");
    write(base, "node.exe", "node\n");
    write(build, "dist/manager.js", "new manager\n");
    write(build, "assets/default-persona-plan-workflow.json", "new workflow\n");
    write(tray, "main.py", "new tray\n");
    write(host, "RabiRouteHost.Core.dll", "new core\n");
    fs.mkdirSync(versions, { recursive: true });
    write(versions, "stable/keep.txt", "keep\n");

    assert.throws(() => createDeveloperCandidate({
      baseRoot: base,
      buildRoot: build,
      traySourceRoot: tray,
      hostCoreRoot: host,
      versionsRoot: versions,
      packageVersion: "0.2.2-dev.failure"
    }), /ribiwebgui/i);
    assert.equal(fs.readFileSync(path.join(versions, "stable", "keep.txt"), "utf8"), "keep\n");
    assert.deepEqual(fs.readdirSync(versions), ["stable"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("developer activation contract uses one fenced Host replacement and never packages or starts children directly", () => {
  const source = fs.readFileSync(new URL("./Invoke-RabiRouteDeveloperApply.ps1", import.meta.url), "utf8");
  assert.match(source, /--command["']?,\s*["']status/);
  assert.match(source, /--command["']?,\s*["']quit/);
  assert.match(source, /--application-generation-id/);
  assert.match(source, /RabiRouteHost\.exe/);
  assert.match(source, /\$hostProcesses/);
  assert.match(source, /meta\.managerRuntime\.pid/);
  assert.doesNotMatch(source, /\$host\s*=/i);
  assert.doesNotMatch(source, /\[int\]\$meta\.pid/);
  assert.doesNotMatch(source, /Expand-Archive|Compress-Archive|ISCC|setup\.exe/i);
  assert.doesNotMatch(source, /dist\\manager\.js[^\r\n]*Start-Process|desktop-runtime[^\r\n]*Start-Process/i);
  assert.doesNotMatch(source, /879[0-9]/);
  assert.doesNotMatch(source, /NapCat|PersonaSync|Xiaomi/i);
});

test("developer activation serializes install mutation, CASes the pointer, and fences rollback identity", () => {
  const apply = fs.readFileSync(new URL("./Invoke-RabiRouteDeveloperApply.ps1", import.meta.url), "utf8");
  const install = fs.readFileSync(new URL("./Install-RabiRouteReleaseTransaction.ps1", import.meta.url), "utf8");

  for (const source of [apply, install]) {
    assert.match(source, /Local\\RabiRoute\.Install\./);
    assert.match(source, /SHA256/);
    assert.match(source, /WaitOne\(0\)/);
    assert.match(source, /AbandonedMutexException/);
    assert.match(source, /ReleaseMutex\(\)/);
  }

  const acquireIndex = apply.indexOf("$installMutex = Enter-InstallMutex $InstallRoot");
  const snapshotIndex = apply.indexOf("[IO.File]::ReadAllBytes($currentPath)");
  const stopIndex = apply.indexOf("Stop-HostGeneration $hostExe $previousStatus");
  const casIndex = apply.indexOf("Assert-CurrentPointerToken $currentPath $previousPointerToken");
  const switchIndex = apply.indexOf("Set-CurrentPointer $currentPath $nextPointerBytes");
  for (const index of [acquireIndex, snapshotIndex, stopIndex, casIndex, switchIndex]) assert.notEqual(index, -1);
  assert.ok(acquireIndex < snapshotIndex);
  assert.ok(stopIndex < casIndex && casIndex < switchIndex);

  assert.match(apply, /Assert-CurrentPointerToken \$currentPath \$candidatePointerToken/);
  assert.match(apply, /Assert-CurrentPointerReleaseId \$currentPath \$previousReleaseId/);
  assert.match(apply, /Wait-Ready \$hostExe \$currentPath \$manifest\.releaseId \$ReadyTimeoutSeconds/);
  assert.match(apply, /Wait-Ready \$hostExe \$currentPath \$previousReleaseId \$ReadyTimeoutSeconds/);
  assert.match(apply, /\$candidateStopFailure/);
  assert.doesNotMatch(apply, /catch\s*\{\s*\}/);
});

test("developer publishing rebuilds the Desktop runtime and Host Core by default", () => {
  const publish = fs.readFileSync(new URL("./Publish-RabiRouteDeveloperCandidate.ps1", import.meta.url), "utf8");
  assert.match(publish, /\[switch\]\$RebuildDesktopRuntime\s*=\s*\$true/);
  assert.match(publish, /\[switch\]\$RebuildHostCore\s*=\s*\$true/);
  assert.match(publish, /build-desktop-runtime\.ps1/);
  assert.match(publish, /build-windows-host\.ps1/);
});
