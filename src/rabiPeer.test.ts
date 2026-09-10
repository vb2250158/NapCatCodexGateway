import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { RabiPeerDispatcher, openPeerPacket, sealPeerPacket, type PeerRequest, type PeerReply } from "./rabiPeerProtocol.js";
import { RabiPeerDirect } from "./rabiPeerDirect.js";
import { RabiPeerClient } from "./rabiPeerClient.js";

const token = "isolated-test-application";
const identity = { deviceId: "pc-b", generation: "generation-b", instanceId: "instance-b" };
function request(overrides: Partial<PeerRequest> = {}): PeerRequest {
  return { requestId: randomUUID(), targetDeviceId: identity.deviceId, generation: identity.generation,
    capability: "plans", operation: "list", input: { roleId: "test" }, expiresAt: Date.now() + 60_000, ...overrides };
}
test("peer packets protect content and dispatcher rejects expired, stale, foreign and ungranted calls", async () => {
  let executed = 0;
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => ["plans.list"], operations: [{ capability: "plans", operation: "list", execute: () => { executed++; return ["private plan"]; } }] });
  const wire = sealPeerPacket(request(), token);
  assert.ok(!JSON.stringify(wire).includes("plans"));
  await assert.rejects(dispatcher.receive(sealPeerPacket(request(), "another-app")));
  await assert.rejects(dispatcher.receive(sealPeerPacket(request({ expiresAt: Date.now() - 1 }), token)));
  for (const change of [{ generation: "old" }, { targetDeviceId: "pc-c" }, { operation: "delete" }]) {
    const reply = openPeerPacket<PeerReply>(await dispatcher.receive(sealPeerPacket(request(change), token)), token);
    assert.equal(reply.ok, false);
  }
  assert.equal(executed, 0);
  const reply = openPeerPacket<PeerReply>(await dispatcher.receive(wire), token);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.data, ["private plan"]);
  assert.equal(executed, 1);
});

test("real P2P data channel carries encrypted chunked RPC and releases both peers", { timeout: 30_000 }, async () => {
  const payload = "large response ".repeat(15_000);
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => ["plans.list"], operations: [{ capability: "plans", operation: "list", execute: () => payload }] });
  const target = new RabiPeerDirect(packet => dispatcher.receive(packet), [], 15_000);
  const caller = new RabiPeerDirect(packet => dispatcher.receive(packet), [], 15_000);
  try {
    const sent = request();
    const wire = await caller.exchange(sealPeerPacket(sent, token), offer => target.offer(offer));
    const reply = openPeerPacket<PeerReply>(wire, token);
    assert.equal(reply.requestId, sent.requestId);
    assert.equal(reply.data, payload);
  } finally { await Promise.all([target.stop(), caller.stop()]); }
  await assert.rejects(target.offer({ sdp: "invalid" }));
});

test("client uses authenticated LAN, then P2P, then Relay after a failed direct attempt", { timeout: 35_000 }, async () => {
  let allowDirect = true;
  let lanAvailable = true;
  const counts = { lan: 0, relay: 0, calls: 0 };
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => ["plans.list", "transport.offer"], operations: [
      { capability: "plans", operation: "list", execute: () => { counts.calls++; return [{ id: "one" }]; } },
      { capability: "transport", operation: "offer", execute: input => {
        if (!allowDirect) throw new Error("disabled");
        return target.offer(input);
      } }
    ] });
  const target = new RabiPeerDirect(packet => dispatcher.receive(packet), [], 10_000);
  const caller = new RabiPeerDirect(packet => dispatcher.receive(packet), [], 10_000);
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const relay = req.url === "/api/rabilink/peer/proxy";
      if (relay) { assert.equal(req.headers["x-rabilink-token"], token); counts.relay++; }
      else { counts.lan++; if (!lanAvailable) { res.writeHead(503).end(); return; } }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(await dispatcher.receive(relay ? body.packet : body)));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new RabiPeerClient({ direct: caller, relay: () => ({ url: baseUrl, token }),
    peers: async () => [{ id: identity.deviceId, online: true, capabilities: ["peer-rpc-v1"], peerUrls: [baseUrl] }] });
  try {
    const call = { targetDeviceId: identity.deviceId, capability: "plans", operation: "list" };
    assert.equal((await client.call(call)).transport, "lan");
    assert.equal(counts.relay, 0);
    lanAvailable = false;
    assert.equal((await client.call(call)).transport, "p2p");
    allowDirect = false;
    const result = await client.call(call);
    assert.equal(result.transport, "relay");
    assert.equal(result.reply.ok, true);
    assert.equal(counts.calls, 3);
    const denied = await client.call({ ...call, operation: "delete" });
    assert.equal(denied.reply.error, "peer_operation_denied");
    assert.equal(counts.calls, 3);
  } finally {
    await Promise.all([target.stop(), caller.stop()]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
