import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { discoverRabiPeers, peerDeviceKind, peerDiscoveryPage } from "./rabiPeerDiscovery.js";

test("device types remain extensible and legacy names or capabilities never imply a PC", () => {
  assert.equal(peerDeviceKind(" PC "), "pc");
  assert.equal(peerDeviceKind("sensor"), "sensor");
  assert.equal(peerDeviceKind(undefined), "unknown");
  assert.equal(peerDeviceKind("invalid/type"), "unknown");
  const peers = [
    { id: "a", deviceKind: "pc", online: true },
    { id: "b", deviceKind: "phone", online: false },
    { id: "c", deviceKind: "glasses", online: true },
    { id: "rabi-pc-legacy", online: true, capabilities: ["tasks"] }
  ];
  const all = peerDiscoveryPage(peers, new URLSearchParams());
  assert.equal(all.summary.total, 4);
  assert.equal(all.summary.online, 3);
  assert.equal(all.summary.byDeviceKind.pc, 1);
  assert.equal(all.summary.byDeviceKind.unknown, 1);
  assert.deepEqual(peerDiscoveryPage(peers, new URLSearchParams("deviceKind=pc&online=true")).peers.map(peer => peer.id), ["a"]);
  assert.deepEqual(peerDiscoveryPage(peers, new URLSearchParams("online=false")).peers.map(peer => peer.id), ["b"]);
  assert.equal(peerDiscoveryPage(peers, new URLSearchParams("deviceKind=watch")).summary.total, 0);
  assert.throws(() => peerDiscoveryPage(peers, new URLSearchParams("online=yes")));
  assert.throws(() => peerDiscoveryPage(peers, new URLSearchParams("deviceKind=bad/type")));
  assert.equal(peers[3].deviceKind, undefined);
});

test("discovery normalizes missing types from an older Relay without guessing from IDs", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ peers: [
      { id: "rabi-phone", name: "rabi-phone", online: false, capabilities: [], peerUrls: [] },
      { id: "explicit", name: "explicit", deviceKind: "pc", online: true, capabilities: [], peerUrls: [] }
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const peers = await discoverRabiPeers({ url: `http://127.0.0.1:${address.port}`, token: "fixture", deviceId: "self", deviceGuid: "self-guid" });
    assert.equal(peers[0].deviceKind, "unknown");
    assert.equal(peers[1].deviceKind, "pc");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
