import assert from "node:assert/strict";
import test from "node:test";
import { updateAgentHooks } from "./hookInstallation.js";

test("Codex installation is serialized and never removes other plugins", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); };
  const first = updateAgentHooks("test-codex", "codex", run);
  const duplicate = updateAgentHooks("test-codex", "codex", run);
  assert.equal(first, duplicate);
  await first;
  assert.deepEqual(calls.map(args => args.slice(0, 3)), [["plugin", "marketplace", "add"], ["plugin", "add", "rabi-codex-context@rabiroute-local"]]);
});

test("failed installation can be retried and DSH uses its own plugin manager", async () => {
  await assert.rejects(updateAgentHooks("test-failure", "codex", async () => { throw new Error("installer failed"); }), /installer failed/);
  await updateAgentHooks("test-failure", "codex", async () => {});
  const calls: string[][] = [];
  await updateAgentHooks("test-dsh", "dsh", async args => { calls.push(args); });
  assert.deepEqual(calls[0].slice(0, 4), ["plugin", "--profile", "web", "add"]);
  assert.match(calls[0][4], /rabi-dsh-context$/);
  await assert.rejects(updateAgentHooks("test-invalid", "unknown"), /安装包/);
});
