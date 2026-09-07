import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RTCPeerConnection } from "werift";
import { DIRECT_VIDEO_CHANNEL, RabiDirectVideo, validateDirectVideoOffer } from "./rabiDirectVideo.js";

test("video signalling refuses payloads, relay candidates and TURN configuration", () => {
  assert.throws(() => validateDirectVideoOffer({ deviceId: "phone", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel", bytes: "camera" }));
  assert.throws(() => validateDirectVideoOffer({ deviceId: "phone", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 1 1.2.3.4 1234 typ relay\r\n" }));
  assert.throws(() => new RabiDirectVideo("unused", ["turn:example.org:3478"]));
});

test("direct peers deliver ordered binary camera data, reject duplicate sessions and release sockets", { timeout: 25000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rabi-direct-video-"));
  const receiver = new RabiDirectVideo(directory, []);
  const sender = new RTCPeerConnection({ iceServers: [] });
  try {
    const channel = sender.createDataChannel(DIRECT_VIDEO_CHANNEL);
    const opened = channel.stateChange.watch(state => state === "open", 12000);
    await sender.setLocalDescription(await sender.createOffer());
    const offer = { deviceId: "test-phone", sdp: sender.localDescription!.sdp };
    const answer = await receiver.offer(offer);
    assert.equal(answer.relay, false);
    assert.ok(!answer.sdp.includes(" typ relay"));
    await assert.rejects(receiver.offer(offer), /already active/);
    await sender.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await opened;
    const bytes = Buffer.alloc(32000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    channel.send(bytes.subarray(0, 16000));
    channel.send(bytes.subarray(16000));
    channel.send("stop");
    const deadline = Date.now() + 5000;
    while (receiver.status().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(receiver.status().length, 0);
    assert.deepEqual(await readFile(path.join(directory, `${answer.sessionId}.h264`)), bytes);
    const metadata = JSON.parse(await readFile(path.join(directory, `${answer.sessionId}.h264.json`), "utf8"));
    assert.equal(metadata.bytes, bytes.length);
    assert.equal(metadata.state, "stopped");
    assert.equal(metadata.relay, false);
    assert.equal(metadata.localCandidateType, "host");
    assert.equal(metadata.remoteCandidateType, "host");
  } finally {
    await sender.close();
    await receiver.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopped receiver refuses new sessions", async () => {
  const receiver = new RabiDirectVideo("unused", []);
  await receiver.stop();
  await assert.rejects(receiver.offer({ deviceId: "phone", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel" }), /stopped/);
});
