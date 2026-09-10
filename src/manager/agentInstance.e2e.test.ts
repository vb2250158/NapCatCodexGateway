import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
test("headless instance configures two Agents and dispatches only to the stable selected owner", { timeout: 30_000 }, async () => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-e2e-")));
  const sessions: string[] = [];
  const read = async <T>(request: http.IncomingMessage): Promise<T> => { let raw = ""; for await (const chunk of request) raw += chunk; return JSON.parse(raw || "{}"); };
  const dsh = http.createServer(async (request, response) => {
    const body = await read<{ rpcId: string; method: string; payload: { sessionId: string } }>(request);
    if (body.method === "session.prompt") sessions.push(body.payload.sessionId);
    const value = body.method === "session.list" ? { items: ["session-11111111-1111-4111-8111-111111111111", "session-22222222-2222-4222-8222-222222222222", "session-33333333-3333-4333-8333-333333333333"].map(sessionId => ({ sessionId, cwd: directory, updatedAt: Date.now(), projections: { values: { title: sessionId === "session-33333333-3333-4333-8333-333333333333" ? "Managed task" : sessionId } } })) } : {};
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const dshUrl = await listen(dsh);
  const registry = new LanAgentRegistry({ statePath: path.join(directory, "registry.json") });
  const manager = http.createServer((request, response) => {
    if (!handleLanAgentApi(request, new URL(request.url!, "http://localhost"), response, {
      registry, releases: {} as LanAgentReleaseStore, readJsonBody: read,
      isReleaseRequestAuthorized: () => false,
      isManagementRequestAuthorized: request => request.headers.authorization === "Bearer test-instance",
      jsonResponse: (response, code, body) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
    })) response.writeHead(404).end();
  });
  registry.attach(manager, { enabled: () => true, getToken: () => "test-instance" });
  const managerUrl = await listen(manager);
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, managerUrl, lanLinkToken: "test-instance", nodeId: "remote-fixture", releasePublicKeySha256: "a".repeat(64), agentType: "dsh", dsh: { baseUrl: dshUrl, sessionId: "session-11111111-1111-4111-8111-111111111111" }, defaultWorkspace: directory, allowedWorkspaces: [directory] }));
  const worker = spawn(process.execPath, [path.resolve("apps/rabi-agent/rabi-agent.mjs"), "--run", "--config", configPath], { windowsHide: true, stdio: "ignore" });
  const request = async (suffix: string, body: unknown) => {
    const response = await fetch(`${managerUrl}/api/lan-agent/instances/remote-fixture/agents${suffix}`, { method: "POST", headers: { authorization: "Bearer test-instance", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { response, body: await response.json() as any };
  };
  try {
    const deadline = Date.now() + 8000;
    while (!registry.listNodes()[0]?.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(registry.listNodes()[0]?.connected, true);
    const created = await request("", { provider: "dsh", name: "Second Agent", sessionId: "session-22222222-2222-4222-8222-222222222222", workspace: directory });
    assert.equal(created.body.code, 0);
    const second = created.body.result.find((agent: any) => agent.name === "Second Agent");
    assert.ok(second.agentId);
    const sent = await request(`/${second.agentId}/tasks`, { message: "fixture message", provider: "dsh", idempotencyKey: "delivery-1" });
    assert.equal(sent.body.result.status, "progress");
    await request(`/${second.agentId}/tasks`, { message: "fixture message", provider: "dsh", idempotencyKey: "delivery-1" });
    assert.deepEqual(sessions, ["session-22222222-2222-4222-8222-222222222222"]);
    const readTask = await request(`/${second.agentId}/threads`, { action: "read", agentAdapter: "dsh", threadId: "session-22222222-2222-4222-8222-222222222222" });
    assert.equal(readTask.body.code, 0, JSON.stringify(readTask.body));
    assert.equal(readTask.body.result.statusCode, 200);
    assert.equal(readTask.body.result.data.thread.id, "session-22222222-2222-4222-8222-222222222222");
    const managed = await request(`/${second.agentId}/threads`, { action: "resolve", agentAdapter: "dsh", title: "Managed task", cwd: directory, createIfMissing: false });
    assert.equal(managed.body.code, 0, JSON.stringify(managed.body));
    assert.equal(managed.body.result.statusCode, 200);
    assert.equal(managed.body.result.data.thread.id, "session-33333333-3333-4333-8333-333333333333");
    assert.deepEqual(registry.getInstanceAgent("remote-fixture", second.agentId)?.managedSessionIds, ["session-33333333-3333-4333-8333-333333333333"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.find((agent: any) => agent.agentId === second.agentId).managedSessionIds, ["session-33333333-3333-4333-8333-333333333333"]);
    await request(`/${second.agentId}/configure`, { enabled: false });
    const disabled = await request(`/${second.agentId}/tasks`, { message: "must not deliver", provider: "dsh" });
    assert.equal(disabled.response.status, 400);
    assert.deepEqual(sessions, ["session-22222222-2222-4222-8222-222222222222"]);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.find((agent: any) => agent.agentId === second.agentId).enabled, false);
  } finally {
    worker.kill();
    await new Promise(resolve => worker.once("exit", resolve));
    registry.close();
    await Promise.all([new Promise(resolve => manager.close(resolve)), new Promise(resolve => dsh.close(resolve))]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
