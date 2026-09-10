import assert from "node:assert/strict";
import test from "node:test";
import { skipArchitectureDirectory } from "./lib/architecture-scan-boundary.mjs";

test("architecture scan excludes generated environments but retains first-party source", () => {
  for (const name of [".venv-build310", ".venv", "bin", "obj", "build-package", "dist-fast"]) {
    assert.equal(skipArchitectureDirectory(name, `desktop/rabi-voice-client/${name}`), true);
  }
  for (const name of ["rabi_voice_client", "scripts", "tests", "buildRules"]) {
    assert.equal(skipArchitectureDirectory(name, `desktop/rabi-voice-client/${name}`), false);
  }
  assert.equal(skipArchitectureDirectory("build", "src/build"), false);
});
