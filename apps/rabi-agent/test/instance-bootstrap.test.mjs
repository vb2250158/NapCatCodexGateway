import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __test } from "../rabi-agent.mjs";

test("reinstalling preserves instance and Agent identities instead of replacing the catalog", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-bootstrap-")));
  const configPath = path.join(directory, "config.json");
  const variables = { RABI_MANAGER_URL: "http://manager.test:54321", RABI_LAN_LINK_TOKEN: "fixture-only", RABI_AGENT_DEFAULT_CWD: directory, RABI_AGENT_ALLOWED_CWDS: JSON.stringify([directory]), RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256: "a".repeat(64), RABI_AGENT_TYPE: "codex-desktop", RABI_AGENT_CODEX_THREAD_ID: "new-task", RABI_NODE_ID: "replacement-id" };
  const previousEnv = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const agents = [{ agentId: "stable-agent", provider: "codex-desktop", sessionId: "saved-task", enabled: false, workspace: directory }];
  try {
    fs.writeFileSync(configPath, JSON.stringify({ nodeId: "stable-instance", agents, allowedWorkspaces: [directory] }));
    const result = __test.bootstrapConfig(configPath);
    assert.equal(result.nodeId, "stable-instance");
    assert.deepEqual(result.agents, agents);
    assert.equal(result.managerUrl, "http://manager.test:54321");
    fs.writeFileSync(configPath, "invalid");
    assert.throws(() => __test.bootstrapConfig(configPath), /refusing/);
    assert.equal(fs.readFileSync(configPath, "utf8"), "invalid");
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
