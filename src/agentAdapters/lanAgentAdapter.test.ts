import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { notifyInstanceAgent } from "./lanAgentAdapter.js";

test("LAN adapter sends the selected node and stable delivery identity; offline and missing binding fail", async () => {
  const keys = ["LAN_AGENT_NODE_ID", "LAN_AGENT_ACCESS_TOKEN", "GATEWAY_MANAGER_URL", "GATEWAY_ID"];
  const previous = keys.map(key => process.env[key]);
  const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, body: JSON.parse(raw) });
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 0, result: { taskId: "task-fixture", status: "delivered" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const envelope = { messageSource: { type: "system" as const, eventType: "test", eventName: "LAN test", eventId: "fixture" }, messageContent: "hello", deliveryId: "delivery-fixture" };
  try {
    process.env.LAN_AGENT_NODE_ID = "node-fixture";
    process.env.LAN_AGENT_ACCESS_TOKEN = "fixture-only";
    process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.GATEWAY_ID;
    await notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope);
    assert.equal(requests[0]?.url, "/api/lan-agent/instances/node-fixture/agents/agent-fixture/tasks");
    assert.equal(requests[0]?.body.idempotencyKey, "delivery-fixture");
    assert.equal(requests[0]?.body.provider, "codex-desktop");
    await assert.rejects(notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope, { imagePaths: ["local.png"] }), /图片/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await assert.rejects(notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope));

  } finally {
    server.close();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
