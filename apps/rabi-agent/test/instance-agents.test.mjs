import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { normalizeAllowedWorkspaces, resolveRealDirectory } from "../lib/cwd-policy.mjs";
import { agentCatalog, configureInstanceAgent, resolveInstanceAgent, registerManagedSession } from "../lib/instance-agents.mjs";

const config = { defaultWorkspace: resolveRealDirectory(os.tmpdir()), allowedWorkspaces: normalizeAllowedWorkspaces([], os.tmpdir()), agentType: "codex-desktop", codexDesktop: { threadId: "task-a" } };
test("instance migration retains default identity; several Agents remain independently bound", () => {
  assert.equal(agentCatalog(config)[0].agentId, "default");
  const next = configureInstanceAgent(config, { name: "Second", provider: "codex-desktop", sessionId: "task-b" });
  assert.equal(next.agents.length, 2);
  const second = next.agents[1];
  assert.notEqual(second.agentId, "default");
  assert.equal(resolveInstanceAgent(next, { agentId: second.agentId, targetAgent: "codex-desktop" }).sessionId, "task-b");
  const disabled = configureInstanceAgent(next, { agentId: second.agentId, enabled: false });
  assert.throws(() => resolveInstanceAgent(disabled, { agentId: second.agentId, targetAgent: "codex-desktop" }), /disabled/);
  assert.equal(resolveInstanceAgent(disabled, { agentId: "default", targetAgent: "codex-desktop" }).sessionId, "task-a");
  assert.throws(() => resolveInstanceAgent(next, { agentId: second.agentId, targetAgent: "dsh" }), /provider/);
  assert.throws(() => configureInstanceAgent(next, { agentId: second.agentId, provider: "dsh" }), /new Agent/);
});
test("instance catalog excludes private DSH connection settings", () => {
  const next = configureInstanceAgent(config, { provider: "dsh", sessionId: "session-b", dshBaseUrl: "http://127.0.0.1:4510" });
  assert.equal(agentCatalog(next)[1].dsh, undefined);
});

test("managed task ownership survives settings changes and is cleared when rebinding the primary", () => {
  const registered = registerManagedSession(config, "default", "task-worker");
  assert.deepEqual(agentCatalog(registered)[0].managedSessionIds, ["task-worker"]);
  assert.equal(registerManagedSession(registered, "default", "task-worker"), registered);
  assert.deepEqual(configureInstanceAgent(registered, { agentId: "default", model: "new-model" }).agents[0].managedSessionIds, ["task-worker"]);
  assert.equal(configureInstanceAgent(registered, { agentId: "default", sessionId: "task-new" }).agents[0].managedSessionIds, undefined);
  assert.throws(() => configureInstanceAgent(registered, { provider: "codex-desktop", sessionId: "task-worker" }), /belongs/);
});
