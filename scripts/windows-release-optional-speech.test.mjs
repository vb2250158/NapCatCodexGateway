import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const releaseScript = fs.readFileSync(
  new URL("./build-windows-release.ps1", import.meta.url),
  "utf8"
);
const releaseWorkflow = fs.readFileSync(
  new URL("../.github/workflows/release-windows.yml", import.meta.url),
  "utf8"
);

test("Windows release excludes the RabiSpeech runtime unless explicitly requested", () => {
  assert.match(releaseScript, /\[switch\]\$IncludeSpeech/);
  assert.match(releaseScript, /if \(\$IncludeSpeech -and -not \$SkipBuild\)/);
  assert.match(releaseScript, /if \(\$IncludeSpeech\) \{ \$required \+= \$speechHostRelative \}/);
  assert.match(releaseScript, /if \(\$IncludeSpeech\) \{\s*\$speechHostDestination/s);
  assert.doesNotMatch(
    releaseWorkflow,
    /build-windows-release\.ps1[^\r\n]*-IncludeSpeech/,
    "the public release workflow should keep speech opt-in"
  );
});

test("Windows release explicitly includes only the dynamic Manager discovery helpers", () => {
  const allowlist = releaseScript.match(
    /\$requiredPortableRuntimeFiles\s*=\s*@\(([\s\S]*?)\r?\n\)/
  );
  assert.ok(allowlist, "required portable runtime allowlist must exist");
  assert.deepEqual(
    [...allowlist[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [
      "scripts/Resolve-RabiRouteManagerUrl.ps1",
      "scripts/lib/discover-manager-url.mjs",
    ]
  );
  assert.match(
    releaseScript,
    /function Copy-RequiredPortableRuntimeFiles[\s\S]*Required portable runtime file is missing:[\s\S]*Copy-Item[\s\S]*Required portable runtime file was not copied:/
  );
  assert.match(
    releaseScript,
    /Copy-RequiredPortableRuntimeFiles\s*\r?\n\s*foreach \(\$relative in @\("apps\\rabi-agent\\runtime", "apps\\rabi-agent\\dist\\agent-hooks", "skills\\rabi-knowledge-search"\)\)[\s\S]*?if \(\$IncludeSpeech\)/
  );
});

test("Windows PowerShell 5.1 can parse every release path without a source-code code page", () => {
  assert.doesNotMatch(
    releaseScript,
    /[^\x00-\x7f]/,
    "the release script must remain ASCII-only because Windows PowerShell 5.1 does not assume UTF-8 without a BOM"
  );
  assert.match(releaseScript, /\[char\]0x7248/);
  assert.match(releaseScript, /\$versionLogBaseName \+ "_en\.md"/);
});

test("Windows PowerShell 5.1 removes a payload junction without deleting its target", {
  skip: process.platform !== "win32",
}, () => {
  assert.match(
    releaseScript,
    /function Remove-PayloadEntry[\s\S]*Refusing to remove a path outside the release payload:[\s\S]*\$item\.Delete\(\)[\s\S]*Release payload entry was not removed:/
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-payload-junction-test-"));
  const target = path.join(root, "target");
  const sentinel = path.join(target, "sentinel");
  const link = path.join(root, "link");
  try {
    fs.mkdirSync(sentinel, { recursive: true });
    fs.symlinkSync(target, link, "junction");
    const escapedLink = link.replaceAll("'", "''");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$item=Get-Item -LiteralPath '${escapedLink}' -Force; $item.Delete()`,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(sentinel), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
