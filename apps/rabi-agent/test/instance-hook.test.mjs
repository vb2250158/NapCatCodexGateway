import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestInstanceHook } from "../lib/instance-hook.mjs";

test("remote Hook uses its registered instance and Agent, and leaves unrelated sessions alone", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-hook-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: "http://manager.test:54321", nodeId: "instance-a", lanLinkToken: "fixture-only", agents: [{ agentId: "agent-b", sessionId: "session-b", enabled: true }] }));
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(url.endsWith("/meta") ? { health: { state: "healthy", requiredReady: true } } : { code: 0, data: { additionalContext: "fixture-context" } }), { headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(await requestInstanceHook({ session_id: "unrelated" }, configPath, fetcher), undefined);
    assert.equal(requests.length, 0);
    const result = await requestInstanceHook({ session_id: "session-b", hook_event_name: "SessionStart" }, configPath, fetcher);
    assert.equal(result.additionalContext, "fixture-context");
    assert.equal(requests[1].url, "http://manager.test:54321/api/lan-agent/instances/instance-a/agents/agent-b/context");
    assert.equal(requests[1].init.headers.authorization, "Bearer fixture-only");
    assert.equal(JSON.parse(requests[1].init.body).session_id, "session-b");
    await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, async () => new Response(JSON.stringify({ health: { state: "starting", requiredReady: false } }))), /not ready/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
