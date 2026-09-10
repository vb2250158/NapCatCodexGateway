import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { configuredInstanceBinding, readBoundInstanceAgent, requestInstanceThread, instanceWorkerStateDirectory } from "./instanceClient.js";

test("instance requests select the bound owner and never fall back to local tasks", async () => {
  const saved = { url: process.env.GATEWAY_MANAGER_URL, token: process.env.LAN_AGENT_ACCESS_TOKEN, bindings: process.env.AGENT_INSTANCE_BINDINGS };
  const binding = { instanceId: "computer-a", agentId: "agent-a" };
  let online = true;
  let failed = false;
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer instance-test");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "GET"
      ? { code: 0, instances: [{ instanceId: "computer-a", connected: online, agents: [{ agentId: "agent-a", enabled: true, sessionId: "task-a", workspace: "/remote/project" }] }] }
      : { code: 0, result: { statusCode: failed ? 409 : 200, data: failed ? { message: "owner unavailable" } : { thread: { id: "task-a" } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  process.env.LAN_AGENT_ACCESS_TOKEN = "instance-test";
  process.env.AGENT_INSTANCE_BINDINGS = JSON.stringify({ codex: binding });
  try {
    assert.deepEqual(configuredInstanceBinding("codex"), binding);
    assert.equal((await readBoundInstanceAgent(binding)).workspace, "/remote/project");
    assert.equal((await requestInstanceThread(binding, { action: "read" })).thread.id, "task-a");
    online = false;
    await assert.rejects(readBoundInstanceAgent(binding), /offline/);
    failed = true;
    await assert.rejects(requestInstanceThread(binding, { action: "open" }), /owner unavailable/);
    const before = calls;
    await assert.rejects(requestInstanceThread(binding, { action: "send", imagePaths: ["/local/image.png"] }), /local image/);
    assert.equal(calls, before);
    assert.notEqual(instanceWorkerStateDirectory("data", binding, "task-a"), instanceWorkerStateDirectory("data", binding, "task-b"));
    assert.notEqual(instanceWorkerStateDirectory("data", binding, "task-a"), instanceWorkerStateDirectory("data", { ...binding, instanceId: "computer-b" }, "task-a"));
  } finally {
    for (const [key, value] of Object.entries({ GATEWAY_MANAGER_URL: saved.url, LAN_AGENT_ACCESS_TOKEN: saved.token, AGENT_INSTANCE_BINDINGS: saved.bindings })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
