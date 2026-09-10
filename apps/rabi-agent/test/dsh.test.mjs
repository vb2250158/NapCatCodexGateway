import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { normalizeDshBinding, sendDshTask } from "../lib/dsh.mjs";

test("DSH binds one exact local session and queues both messages without creation", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: body.payload.content[0].text !== "reject" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const binding = { baseUrl: `http://127.0.0.1:${server.address().port}`, sessionId: "session-fixture" };
  try {
    await sendDshTask(binding, "one");
    await sendDshTask(binding, "two");
    assert.deepEqual(requests.map(item => [item.method, item.payload.sessionId, item.payload.mode]), [["session.prompt", "session-fixture", "queue"], ["session.prompt", "session-fixture", "queue"]]);
    await assert.rejects(sendDshTask(binding, "reject"), /rejected/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(sendDshTask(binding, "offline"));
});

test("DSH rejects a remote endpoint and a missing session", () => {
  assert.throws(() => normalizeDshBinding({ baseUrl: "http://192.168.1.20", sessionId: "session-test" }), /local API/);
  assert.throws(() => normalizeDshBinding({ baseUrl: "http://localhost:1234" }), /session ID/);
});
