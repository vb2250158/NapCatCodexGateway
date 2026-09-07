import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

test("speech proxy allowlists completed mobile ASR messages for the target Manager", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-speech-messages-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const account = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "speech-message-test", password: "strong-test-password" })
    });
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Speech messages" })
    });
    const app = (await appResponse.json()).app;
    const token = app.token;
    await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech,video-direct`, {
      headers: { "x-rabilink-token": token }
    });
    const target = await fetch(`${baseUrl}/manage/api/apps/${encodeURIComponent(app.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetDeviceId: "pc-a" })
    });
    assert.equal(target.status, 200);

    const signalHeaders = { "content-type": "application/json", "x-rabilink-token": token };
    const signal = { deviceId: "phone-video", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
    assert.equal((await fetch(`${baseUrl}/api/rabilink/video/offer`, {
      method: "POST", headers: signalHeaders, body: JSON.stringify({ ...signal, bytes: "camera payload" })
    })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/rabilink/video/offer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signal)
    })).status, 401);
    const pendingVideo = fetch(`${baseUrl}/api/rabilink/video/offer`, {
      method: "POST", headers: signalHeaders, body: JSON.stringify(signal)
    });
    let videoRequest;
    for (let attempt = 0; attempt < 50 && !videoRequest; attempt++) {
      const claimed = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&waitMs=0&capabilities=webgui,speech,video-direct`, { headers: signalHeaders });
      videoRequest = (await claimed.json()).requests?.[0];
      if (!videoRequest) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(videoRequest.path, "/api/rabilink/video/offer");
    assert.deepEqual(JSON.parse(Buffer.from(videoRequest.bodyBase64, "base64").toString()), signal);
    await fetch(`${baseUrl}/worker/speech-requests/${videoRequest.id}/response`, {
      method: "POST", headers: signalHeaders,
      body: JSON.stringify({ deviceId: "pc-a", deviceGuid: "guid-a", ok: true, statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ type: "answer", sdp: "v=0", relay: false })).toString("base64") })
    });
    assert.equal((await (await pendingVideo).json()).relay, false);

    const pendingPreview = fetch(`${baseUrl}/api/rabilink/speech/v1/records?kind=asr&source_device_id=phone-a&since=123&limit=1000`, {
      headers: { "x-rabilink-token": token }
    });
    let claimedPreview;
    for (let attempt = 0; attempt < 50 && !claimedPreview; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimedPreview = (await response.json()).requests?.[0];
      if (!claimedPreview) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimedPreview.method, "GET");
    assert.equal(claimedPreview.path, "/v1/records?kind=asr&source_device_id=phone-a&since=123&limit=1000");
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimedPreview.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ data: [{ id: "asr-one", kind: "asr", text: "预览成功" }] })).toString("base64")
      })
    });
    const previewResult = await pendingPreview;
    assert.equal(previewResult.status, 200);
    assert.equal((await previewResult.json()).data[0].text, "预览成功");

    const payload = {
      recordId: "phone-one",
      text: "手机语音",
      messageAdapterType: "rabilink",
      channelType: "rabilink.mobile_audio",
      routeProfileId: "mobile-main",
      sourceDeviceId: "phone-a"
    };
    const pending = fetch(`${baseUrl}/api/rabilink/speech/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify(payload)
    });
    let claimed;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimed = (await response.json()).requests?.[0];
      if (!claimed) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimed.path, "/api/speech/messages");
    assert.deepEqual(JSON.parse(Buffer.from(claimed.bodyBase64, "base64").toString("utf8")), payload);
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimed.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ code: 0, data: { status: "delivered" } })).toString("base64")
      })
    });
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.status, "delivered");

    const startPayload = {
      stream_id: "phone-a-audio",
      name: "Phone A",
      device_kind: "mobile",
      source_device_id: "phone-a",
      message_adapter_type: "rabilink",
      route_profile_id: "mobile-main",
      session_id: "phone-a"
    };
    const pendingStart = fetch(`${baseUrl}/api/rabilink/speech/v1/audio-streams/rabilink/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify(startPayload)
    });
    let claimedStart;
    for (let attempt = 0; attempt < 50 && !claimedStart; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimedStart = (await response.json()).requests?.[0];
      if (!claimedStart) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimedStart.path, "/v1/audio-streams/rabilink/start");
    assert.deepEqual(JSON.parse(Buffer.from(claimedStart.bodyBase64, "base64").toString("utf8")), startPayload);
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimedStart.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({
          ok: true,
          rabilink_chunk_protocol: {
            version: 2,
            durable_ack_tuple: true,
            cross_process_claim: true,
            ambiguous_replay_policy: "retain_without_ack"
          }
        })).toString("base64")
      })
    });
    const startResult = await pendingStart;
    assert.equal(startResult.status, 200);
    assert.equal((await startResult.json()).rabilink_chunk_protocol.version, 2);

    const pcm = Buffer.from([0, 0, 1, 0, 255, 255]);
    const pendingChunk = fetch(`${baseUrl}/api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=phone-a-audio&sequence=1&chunkId=phone-a-chunk-1`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-rabilink-token": token },
      body: pcm
    });
    let claimedChunk;
    for (let attempt = 0; attempt < 50 && !claimedChunk; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimedChunk = (await response.json()).requests?.[0];
      if (!claimedChunk) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimedChunk.path, "/v1/audio-streams/rabilink/chunk?streamId=phone-a-audio&sequence=1&chunkId=phone-a-chunk-1");
    assert.equal(claimedChunk.headers["content-type"], "application/octet-stream");
    assert.deepEqual(Buffer.from(claimedChunk.bodyBase64, "base64"), pcm);
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimedChunk.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({
          ok: true,
          accepted_bytes: pcm.length,
          sequence: 1,
          chunk_id: "phone-a-chunk-1",
          sha256: createHash("sha256").update(pcm).digest("hex")
        })).toString("base64")
      })
    });
    const chunkResult = await pendingChunk;
    assert.equal(chunkResult.status, 200);
    const chunkAck = await chunkResult.json();
    assert.equal(chunkAck.sequence, 1);
    assert.equal(chunkAck.chunk_id, "phone-a-chunk-1");
    assert.equal(chunkAck.sha256, createHash("sha256").update(pcm).digest("hex"));

    const pendingKeepalive = fetch(`${baseUrl}/api/rabilink/speech/v1/audio-streams/rabilink/keepalive?streamId=phone-a-audio`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-rabilink-token": token },
      body: Buffer.alloc(0)
    });
    let claimedKeepalive;
    for (let attempt = 0; attempt < 50 && !claimedKeepalive; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimedKeepalive = (await response.json()).requests?.[0];
      if (!claimedKeepalive) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimedKeepalive.path, "/v1/audio-streams/rabilink/keepalive?streamId=phone-a-audio");
    assert.equal(Buffer.from(claimedKeepalive.bodyBase64, "base64").length, 0);
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimedKeepalive.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ ok: true, received_bytes: 0 })).toString("base64")
      })
    });
    const keepaliveResult = await pendingKeepalive;
    assert.equal(keepaliveResult.status, 200);
    assert.equal((await keepaliveResult.json()).received_bytes, 0);

    const pendingStop = fetch(`${baseUrl}/api/rabilink/speech/v1/audio-streams/rabilink/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({ stream_id: "phone-a-audio" })
    });
    let claimedStop;
    for (let attempt = 0; attempt < 50 && !claimedStop; attempt += 1) {
      const response = await fetch(`${baseUrl}/worker/speech-requests?deviceId=pc-a&deviceGuid=guid-a&deviceName=PC-A&waitMs=0&capabilities=webgui,speech`, {
        headers: { "x-rabilink-token": token }
      });
      claimedStop = (await response.json()).requests?.[0];
      if (!claimedStop) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(claimedStop.path, "/v1/audio-streams/rabilink/stop");
    await fetch(`${baseUrl}/worker/speech-requests/${encodeURIComponent(claimedStop.id)}/response`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deviceId: "pc-a",
        deviceGuid: "guid-a",
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ ok: true })).toString("base64")
      })
    });
    assert.equal((await pendingStop).status, 200);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
