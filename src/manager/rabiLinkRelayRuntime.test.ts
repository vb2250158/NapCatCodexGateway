import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";

const FETCH_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);
const MAX_FETCH_SAFE_LISTEN_ATTEMPTS = 16;

function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

function listenOnce(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test server port."));
      resolve(address.port);
    });
  });
}

async function listen(server: http.Server): Promise<number> {
  const blockedPorts: number[] = [];
  for (let attempt = 1; attempt <= MAX_FETCH_SAFE_LISTEN_ATTEMPTS; attempt += 1) {
    const port = await listenOnce(server);
    if (!isFetchBlockedPort(port)) return port;
    blockedPorts.push(port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(
    `Unable to allocate a Fetch-safe test server port after ${MAX_FETCH_SAFE_LISTEN_ATTEMPTS} attempts; `
      + `blockedPorts=${JSON.stringify(blockedPorts)}`
  );
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForRelayRuntime(
  runtime: RabiLinkRelayRuntime,
  description: string,
  predicate: () => boolean,
  details: () => Record<string, unknown>,
  timeoutMs = 10_000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error([
        `Timed out waiting for ${description}.`,
        `relayStatus=${JSON.stringify(runtime.status())}`,
        `details=${JSON.stringify(details())}`
      ].join(" "));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openRelayEvents(response: http.ServerResponse, extra = ""): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  response.write("event: ready\ndata: {}\n\n");
  if (extra) response.write(extra);
}

test("test HTTP server helper excludes WHATWG Fetch blocked ports", async () => {
  assert.equal(isFetchBlockedPort(0), true);
  assert.equal(isFetchBlockedPort(5060), true);
  assert.equal(isFetchBlockedPort(10080), true);
  assert.equal(isFetchBlockedPort(24001), false);

  const server = http.createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  try {
    assert.equal(isFetchBlockedPort(port), false);
  } finally {
    await close(server);
  }
});

test("Relay never forwards local-only model directory settings", async (t) => {
  let forwarded = 0;
  const local = http.createServer((request, response) => {
    if (decodeURIComponent(request.url || "").includes("/model-management/")) forwarded += 1;
    response.end("test response");
  });
  const localPort = await listen(local);
  t.after(() => close(local));
  const paths = ["/api/speech/model-management/settings", "/api/speech/model-management/../model-management/settings?x=1", "/api/speech/model-management/%73ettings"];
  const completed = new Set<string>();
  let claimed = false;
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/rabilink/events") { openRelayEvents(response); return; }
    if (url.pathname === "/worker/webgui-requests") {
      const requests = claimed ? [] : paths.map((path, index) => ({ id: `private-${index}`, method: index === 1 ? "PATCH" : "GET", path }));
      claimed = true;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, requests }));
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/response")) {
      request.resume();
      request.on("end", () => { completed.add(url.pathname); response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({ enabled: true, url: `http://127.0.0.1:${relayPort}`, token: "test-only-token", deviceId: "test-pc", deviceGuid: "test-guid", deviceName: "Test PC", claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`, speechProxyEnabled: false, localSpeechUrl: `http://127.0.0.1:${localPort}` });
  await waitForRelayRuntime(runtime, "local-only settings rejection", () => completed.size === paths.length, () => ({ completed: completed.size }));
  assert.equal(forwarded, 0);
});

test("global Relay runtime registers the PC and proxies remote WebGUI requests", async (t) => {
  const localWebgui = http.createServer((request, response) => {
    response.writeHead(request.url === "/meta" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ local: request.url === "/meta" }));
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let speechClaimCount = 0;
  let claimedIdentity: Record<string, string> = {};
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(
        response,
        "event: outbox_receipt\ndata: {\"deliveryId\":\"delivery-a\",\"deviceId\":\"phone-a\",\"state\":\"played\",\"routeProfileId\":\"route-a\"}\n\n"
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      speechClaimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      if (claimCount === 1) {
        claimedIdentity = {
          token: String(request.headers["x-rabilink-token"] || ""),
          deviceId: url.searchParams.get("deviceId") || "",
          deviceGuid: url.searchParams.get("deviceGuid") || "",
          deviceKind: url.searchParams.get("deviceKind") || "",
          deviceName: url.searchParams.get("deviceName") || "",
          waitMs: url.searchParams.get("waitMs") || "",
          capabilities: url.searchParams.get("capabilities") || "",
          peerUrls: url.searchParams.get("peerUrls") || ""
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{ id: "request-1", method: "GET", path: "/meta" }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-1/response") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const relayEvents: Array<{ eventType: string; data: Record<string, unknown> }> = [];
  const runtime = new RabiLinkRelayRuntime({ onEvent: (eventType, data) => relayEvents.push({ eventType, data }) });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    peerUrls: ["http://192.168.1.10:24001"],
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "the initial WebGUI proxy completion",
    () => relayState.finishedBody !== undefined && speechClaimCount > 0,
    () => ({ claimCount, speechClaimCount, relayReceiptReceived: relayState.finishedBody !== undefined })
  );
  const finishedBody = relayState.finishedBody;
  assert.ok(finishedBody);
  assert.equal(runtime.status().state, "online", JSON.stringify(runtime.status()));
  assert.ok(relayEvents.some((event) => event.eventType === "ready"));
  assert.deepEqual(
    relayEvents.find((event) => event.eventType === "outbox_receipt")?.data,
    { deliveryId: "delivery-a", deviceId: "phone-a", state: "played", routeProfileId: "route-a" }
  );
  assert.deepEqual(claimedIdentity, {
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceKind: "pc",
    deviceName: "Test PC",
    waitMs: "0",
    capabilities: "webgui,video-direct,peer-rpc-v1,persona-sync,persona-sync-plan-package-v1",
    peerUrls: JSON.stringify(["http://192.168.1.10:24001"])
  });
  assert.equal(finishedBody?.deviceId, "pc-a");
  assert.equal(finishedBody?.deviceGuid, "guid-a");
  assert.equal(finishedBody?.statusCode, 200);
  assert.deepEqual(JSON.parse(Buffer.from(String(finishedBody?.bodyBase64), "base64").toString("utf8")), { local: true });

  await runtime.stop();
  assert.equal(runtime.status().state, "disabled");
});

test("global Relay runtime forwards media ranges and Manager SSE events without exposing Relay credentials locally", async (t) => {
  const mediaBody = Buffer.from("part", "utf8");
  const localState: {
    eventHeaders?: http.IncomingHttpHeaders;
    mediaHeaders?: http.IncomingHttpHeaders;
  } = {};
  const localWebgui = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/events") {
      localState.eventHeaders = request.headers;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      response.write("event: ready\ndata: {}\n\n");
      response.write(": keepalive\n\n");
      response.write("event: gateway_status\ndata: {\"gatewayId\":\"route-a\",\"running\":true}\n\n");
      return;
    }
    if (request.method === "GET" && request.url === "/api/roles/Rabi/plans/plan-a/attachments/video-a") {
      localState.mediaHeaders = request.headers;
      response.writeHead(206, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-range": "bytes 0-3/10"
      });
      response.end(mediaBody);
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let eventPostCount = 0;
  const relayState: {
    finishedBody?: Record<string, unknown>;
    eventBody?: Record<string, unknown>;
  } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{
          id: "request-range",
          method: "GET",
          path: "/api/roles/Rabi/plans/plan-a/attachments/video-a",
          headers: {
            range: "bytes=0-3",
            "if-range": "media-etag",
            authorization: "Bearer must-not-reach-manager",
            "x-rabilink-token": "must-not-reach-manager"
          }
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-range/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-events") {
      eventPostCount += 1;
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.eventBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-range",
    deviceGuid: "guid-range",
    deviceName: "Range PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "the ranged media completion and Manager event forward",
    () => relayState.finishedBody !== undefined && relayState.eventBody !== undefined,
    () => ({
      relayReceiptReceived: relayState.finishedBody !== undefined,
      managerEventReceived: relayState.eventBody !== undefined
    })
  );
  assert.equal(localState.mediaHeaders?.range, "bytes=0-3");
  assert.equal(localState.mediaHeaders?.["if-range"], "media-etag");
  assert.equal(localState.mediaHeaders?.authorization, undefined);
  assert.equal(localState.mediaHeaders?.["x-rabilink-token"], undefined);
  assert.equal(localState.eventHeaders?.authorization, undefined);
  assert.equal(localState.eventHeaders?.["x-rabilink-token"], undefined);
  assert.equal(relayState.finishedBody?.statusCode, 206);
  assert.deepEqual(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64"), mediaBody);
  assert.deepEqual(relayState.eventBody, {
    streamPath: "/api/events",
    eventType: "gateway_status",
    data: { gatewayId: "route-a", running: true },
    deviceId: "pc-range",
    deviceGuid: "guid-range"
  });
  assert.equal(eventPostCount, 1);
});

test("global Relay runtime hot-forwards supported SSE channels without finite-response self-proxy leaks", async (t) => {
  const localConnections = new Map<string, number>();
  const localWebgui = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    localConnections.set(pathname, (localConnections.get(pathname) || 0) + 1);
    if (request.method === "GET" && ["/api/events", "/api/speech/events"].includes(pathname)) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      response.write("event: ready\ndata: {}\n\n");
      if (pathname === "/api/events") {
        response.write("event: gateway_status\ndata: {\"gatewayId\":\"route-hot\",\"running\":true}\n\n");
      } else {
        response.write("event: speech_status\ndata: {\"state\":\"ready\"}\n\n");
      }
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  const relayState: {
    eventBodies: Record<string, unknown>[];
    rejectedBody?: Record<string, unknown>;
  } = { eventBodies: [] };
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{
          id: "request-invalid-sse-proxy",
          method: "GET",
          path: "/api/speech/events",
          headers: { accept: "text/event-stream" }
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-events") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.eventBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-invalid-sse-proxy/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.rejectedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-hot-token",
    deviceId: "pc-hot",
    deviceGuid: "guid-hot",
    deviceName: "Hot PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "both hot SSE forwards and finite-proxy rejection",
    () => {
      const paths = new Set(relayState.eventBodies.map(body => String(body.streamPath || "")));
      return paths.has("/api/events") && paths.has("/api/speech/events") && relayState.rejectedBody !== undefined;
    },
    () => ({
      streamPaths: relayState.eventBodies.map(body => String(body.streamPath || "")),
      finiteProxyRejected: relayState.rejectedBody !== undefined
    })
  );

  assert.equal(localConnections.get("/api/events"), 1);
  assert.equal(localConnections.get("/api/speech/events"), 1);
  assert.equal(relayState.rejectedBody?.ok, false);
  assert.equal(relayState.rejectedBody?.statusCode, 502);
  assert.match(
    Buffer.from(String(relayState.rejectedBody?.bodyBase64 || ""), "base64").toString("utf8"),
    /SSE event streams must use the Relay event channel/
  );
});

test("global Relay runtime bounds a stuck local GET and retries an uncertain Relay completion", async (t) => {
  let localRequestCount = 0;
  const localWebgui = http.createServer((request, response) => {
    if (request.url !== "/gateways") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ recovered: false }));
      return;
    }
    localRequestCount += 1;
    if (localRequestCount === 1) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ recovered: true }));
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let finishCount = 0;
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{ id: "request-retry", method: "GET", path: "/gateways" }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-retry/response") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        finishCount += 1;
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (finishCount === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, deduplicated: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({
    localRequestTimeoutMs: 100,
    localRequestAttempts: 2,
    relayWriteTimeoutMs: 200,
    relayWriteAttempts: 2
  });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "the retried uncertain Relay completion",
    () => finishCount >= 2,
    () => ({ localRequestCount, finishCount, relayReceiptReceived: relayState.finishedBody !== undefined })
  );
  assert.equal(localRequestCount, 2);
  assert.equal(finishCount, 2);
  assert.equal(relayState.finishedBody?.statusCode, 200);
  assert.deepEqual(
    JSON.parse(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64").toString("utf8")),
    { recovered: true }
  );
});

test("global Relay runtime proxies the independent speech plugin without exposing Relay credentials", async (t) => {
  const requestPayload = Buffer.from("fake-multipart-audio", "utf8");
  const wavPayload = Buffer.from("RIFF-test-wave", "utf8");
  const localState: Record<string, unknown> = {};
  const localSpeech = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      localState.method = request.method;
      localState.url = request.url;
      localState.authorization = request.headers.authorization;
      localState.contentType = request.headers["content-type"];
      localState.body = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "audio/wav", "x-rabi-provider": "fake-tts" });
      response.end(wavPayload);
    });
  });
  const localSpeechPort = await listen(localSpeech);
  t.after(() => close(localSpeech));

  let speechClaimCount = 0;
  let declaredCapabilities = "";
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      speechClaimCount += 1;
      declaredCapabilities = url.searchParams.get("capabilities") || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: speechClaimCount === 1 ? [{
          id: "speech-1",
          method: "POST",
          path: "/v1/audio/transcriptions?language=zh",
          headers: {
            authorization: "Bearer must-not-reach-local-service",
            "content-type": "multipart/form-data; boundary=test-boundary"
          },
          bodyBase64: requestPayload.toString("base64")
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/speech-requests/speech-1/response") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({ localSpeechRequestTimeoutMs: 1000 });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: "http://127.0.0.1:24001",
    speechProxyEnabled: true,
    localSpeechUrl: `http://127.0.0.1:${localSpeechPort}`
  });

  await waitForRelayRuntime(
    runtime,
    "the independent speech proxy completion",
    () => relayState.finishedBody !== undefined,
    () => ({ declaredCapabilities, localMethod: localState.method, relayReceiptReceived: relayState.finishedBody !== undefined })
  );
  assert.equal(declaredCapabilities, "webgui,video-direct,peer-rpc-v1,persona-sync,persona-sync-plan-package-v1,speech");
  assert.equal(localState.method, "POST");
  assert.equal(localState.url, "/v1/audio/transcriptions?language=zh");
  assert.equal(localState.authorization, undefined);
  assert.equal(localState.contentType, "multipart/form-data; boundary=test-boundary");
  assert.deepEqual(localState.body, requestPayload);
  assert.equal(relayState.finishedBody?.statusCode, 200);
  assert.deepEqual(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64"), wavPayload);
});

test("global Relay runtime sends completed mobile ASR messages to Manager instead of the speech worker", async (t) => {
  const payload = Buffer.from(JSON.stringify({
    recordId: "phone-audio-one",
    text: "手机语音",
    messageAdapterType: "rabilink",
    channelType: "rabilink.mobile_audio",
    routeProfileId: "mobile-main",
    sourceDeviceId: "phone-one"
  }), "utf8");
  const managerState: { messageBody?: Buffer; requestedPaths: string[] } = { requestedPaths: [] };
  const manager = http.createServer((request, response) => {
    managerState.requestedPaths.push(`${request.method || ""} ${request.url || ""}`);
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/speech/messages") {
        managerState.messageBody = Buffer.concat(chunks);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: { status: "delivered" } }));
    });
  });
  const managerPort = await listen(manager);
  t.after(() => close(manager));

  let claimCount = 0;
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{
          id: "speech-message-1",
          method: "POST",
          path: "/api/speech/messages",
          headers: { "content-type": "application/json" },
          bodyBase64: payload.toString("base64")
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/speech-requests/speech-message-1/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${managerPort}`,
    speechProxyEnabled: true,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "mobile ASR delivery receipt and Manager ingress",
    () => relayState.finishedBody !== undefined && managerState.messageBody !== undefined,
    () => ({
      managerPort,
      relayPort,
      claimCount,
      managerRequestedPaths: [...managerState.requestedPaths],
      managerMessageReceived: managerState.messageBody !== undefined,
      relayReceiptReceived: relayState.finishedBody !== undefined,
      relayReceipt: relayState.finishedBody
    })
  );
  assert.ok(managerState.requestedPaths.includes("POST /api/speech/messages"));
  assert.deepEqual(managerState.messageBody, payload);
  assert.equal(relayState.finishedBody?.statusCode, 200);
});

test("global Relay runtime reports incomplete configuration without making a request", () => {
  const runtime = new RabiLinkRelayRuntime();
  runtime.sync({
    enabled: true,
    url: "",
    token: "",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: "http://127.0.0.1:24001",
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });
  assert.equal(runtime.status().state, "incomplete");
});


test("stop aborts active local proxies, suppresses completion writes, and permits restart", async (t) => {
  let slowRequestStarted = false;
  let slowRequestClosed = false;
  const localWebgui = http.createServer((request, response) => {
    if (request.url === "/slow") {
      slowRequestStarted = true;
      response.once("close", () => { slowRequestClosed = true; });
      return;
    }
    if (request.url === "/fast") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ restarted: true }));
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let phase: "stopping" | "restarted" = "stopping";
  let slowClaimed = false;
  let fastClaimed = false;
  const completionIds: string[] = [];
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      let requests: Array<{ id: string; method: string; path: string }> = [];
      if (phase === "stopping" && !slowClaimed) {
        slowClaimed = true;
        requests = [{ id: "request-stop", method: "GET", path: "/slow" }];
      } else if (phase === "restarted" && !fastClaimed) {
        fastClaimed = true;
        requests = [{ id: "request-restart", method: "GET", path: "/fast" }];
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests }));
      return;
    }
    const completion = /^\/worker\/webgui-requests\/([^/]+)\/response$/.exec(url.pathname);
    if (request.method === "POST" && completion) {
      completionIds.push(decodeURIComponent(completion[1]));
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({ localRequestTimeoutMs: 10_000 });
  t.after(() => runtime.stop());
  const config = {
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-stop",
    deviceGuid: "guid-stop",
    deviceName: "Stop PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  };
  await runtime.sync(config);
  await waitForRelayRuntime(
    runtime,
    "the initial slow local proxy request",
    () => slowRequestStarted,
    () => ({ slowRequestStarted, slowClaimed, completionIds: [...completionIds] })
  );

  const firstStop = runtime.stop();
  const queuedSync = runtime.sync(config);
  const secondStop = runtime.stop();
  assert.strictEqual(firstStop, secondStop);
  await Promise.all([firstStop, queuedSync]);
  assert.equal(runtime.status().state, "disabled");
  await waitForRelayRuntime(
    runtime,
    "the aborted slow local proxy socket to close",
    () => slowRequestClosed,
    () => ({ slowRequestStarted, slowRequestClosed, completionIds: [...completionIds] })
  );
  assert.equal(completionIds.length, 0);

  phase = "restarted";
  await runtime.sync(config);
  await waitForRelayRuntime(
    runtime,
    "the restarted proxy completion and online Relay state",
    () => completionIds.includes("request-restart") && runtime.status().state === "online",
    () => ({ phase, fastClaimed, completionIds: [...completionIds] })
  );
  assert.equal(completionIds.includes("request-stop"), false);
  assert.equal(runtime.status().state, "online");
  await runtime.stop();
});

test("WebGUI drain retries inside the same generation and returns to online", async (t) => {
  let claimCount = 0;
  const statuses: Array<ReturnType<RabiLinkRelayRuntime["status"]>> = [];
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      if (claimCount === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({
    channelRetryDelayMs: 20,
    onStatus: status => statuses.push(status)
  });
  t.after(() => runtime.stop());
  await runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-webgui-retry",
    deviceGuid: "guid-webgui-retry",
    deviceName: "WebGUI Retry PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${relayPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "WebGUI drain recovery",
    () => claimCount >= 2 && runtime.status().state === "online",
    () => ({ claimCount, statuses })
  );
  assert.ok(statuses.some(status => status.state === "error" && /WebGUI.*fetch failed/.test(status.message)));
  assert.equal(runtime.status().error, undefined);
});

test("speech drain retries inside the same generation and returns to online", async (t) => {
  let speechClaimCount = 0;
  const statuses: Array<ReturnType<RabiLinkRelayRuntime["status"]>> = [];
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      speechClaimCount += 1;
      if (speechClaimCount === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({
    channelRetryDelayMs: 20,
    onStatus: status => statuses.push(status)
  });
  t.after(() => runtime.stop());
  await runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-speech-retry",
    deviceGuid: "guid-speech-retry",
    deviceName: "Speech Retry PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${relayPort}`,
    speechProxyEnabled: true,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "speech drain recovery",
    () => speechClaimCount >= 2
      && statuses.some(status => status.state === "error" && /语音.*fetch failed/.test(status.message))
      && statuses.at(-1)?.state === "online",
    () => ({ speechClaimCount, statuses })
  );
  assert.equal(runtime.status().error, undefined);
  await runtime.stop();
});

test("stop cancels a pending channel retry without cross-generation relaunch", async (t) => {
  let claimCount = 0;
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({ channelRetryDelayMs: 100 });
  t.after(() => runtime.stop());
  await runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-stop-retry",
    deviceGuid: "guid-stop-retry",
    deviceName: "Stop Retry PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${relayPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });
  await waitForRelayRuntime(
    runtime,
    "the first diagnosable WebGUI drain error",
    () => claimCount === 1
      && runtime.status().state === "error"
      && /WebGUI/.test(runtime.status().message),
    () => ({ claimCount, relayStatus: runtime.status() })
  );

  await runtime.stop();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(claimCount, 1);
  assert.equal(runtime.status().state, "disabled");
});

test("global Relay runtime preserves route mutation fencing and committed receipts", async (t) => {
  const operationId = "relay-runtime-route-mutation-1";
  const expectedContentHash = "a".repeat(64);
  const committedContentHash = "b".repeat(64);
  const localState: Record<string, unknown> = {};
  const localWebgui = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/gateways") {
      response.writeHead(404).end();
      return;
    }
    localState.operationId = request.headers["idempotency-key"];
    localState.expectedContentHash = request.headers["if-match"];
    localState.privateDiagnostic = request.headers["x-private-diagnostic"];
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      localState.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "content-type": "application/json",
        "idempotency-key": operationId,
        etag: `"${committedContentHash}"`
      });
      response.end(JSON.stringify({
        code: 0,
        receipt: { state: "committed", operationId, routeConfigHash: committedContentHash },
        routeCatalog: { contentHash: committedContentHash, routeConfigHash: committedContentHash, revision: 2 }
      }));
    });
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claims = 0;
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claims += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claims === 1 ? [{
          id: "request-route-mutation",
          method: "POST",
          path: "/gateways",
          headers: {
            "content-type": "application/json",
            "idempotency-key": operationId,
            "if-match": expectedContentHash,
            "x-private-diagnostic": "must-not-forward"
          },
          bodyBase64: Buffer.from(JSON.stringify({ gateways: [] }), "utf8").toString("base64")
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-route-mutation/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitForRelayRuntime(
    runtime,
    "route mutation proxy completion",
    () => relayState.finishedBody !== undefined,
    () => ({ claims, localState, finished: Boolean(relayState.finishedBody) })
  );
  assert.equal(localState.operationId, operationId);
  assert.equal(localState.expectedContentHash, expectedContentHash);
  assert.deepEqual(localState.body, { gateways: [] });
  const finished = relayState.finishedBody!;
  const responseBody = JSON.parse(Buffer.from(String(finished.bodyBase64), "base64").toString("utf8"));
  assert.equal(responseBody.receipt.operationId, operationId, "route mutations must not be compacted into a receipt-less success body");
  assert.equal((finished.headers as Record<string, string>)["idempotency-key"], operationId);
  assert.equal((finished.headers as Record<string, string>).etag, `"${committedContentHash}"`);
  assert.equal(localState.privateDiagnostic, undefined);
  await runtime.stop();
});

test("duplicate Relay availability events keep a single WebGUI drain flight", async (t) => {
  let claimCount = 0;
  let activeClaims = 0;
  let maximumActiveClaims = 0;
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(
        response,
        "event: webgui_available\ndata: {}\n\nevent: webgui_available\ndata: {}\n\n"
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      activeClaims += 1;
      maximumActiveClaims = Math.max(maximumActiveClaims, activeClaims);
      setTimeout(() => {
        activeClaims -= 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, requests: [] }));
      }, 50);
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({ channelRetryDelayMs: 20 });
  t.after(() => runtime.stop());
  await runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-single-drain",
    deviceGuid: "guid-single-drain",
    deviceName: "Single Drain PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${relayPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });
  await waitForRelayRuntime(
    runtime,
    "the single WebGUI drain flight",
    () => claimCount === 1 && activeClaims === 0 && runtime.status().state === "online",
    () => ({ claimCount, activeClaims, maximumActiveClaims })
  );
  assert.equal(maximumActiveClaims, 1);
});
