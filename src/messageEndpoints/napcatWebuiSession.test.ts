import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { NapcatWebuiSessions } from "./napcatWebuiSession.js";

async function serverFor(t: test.TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return `http://127.0.0.1:${address.port}`;
}

test("parallel panels and repeated status reads reuse one authentication request under login rate limiting", async t => {
  let logins = 0;
  let reads = 0;
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") {
      logins++;
      response.statusCode = logins > 1 ? 429 : 200;
      response.end(JSON.stringify(logins > 1 ? { code: -1 } : { code: 0, data: { Credential: "test-credential" } }));
    } else { reads++; response.end(JSON.stringify({ code: 0, data: { isLogin: true } })); }
  });
  const sessions = new NapcatWebuiSessions();
  const panels = await Promise.all(Array.from({ length: 12 }, () => sessions.open(base, "test-token")));
  for (const panel of panels) {
    assert.ok(panel);
    assert.equal((await (await panel.request("/api/QQLogin/CheckLoginStatus")).json()).data.isLogin, true);
  }
  assert.equal(logins, 1);
  assert.equal(reads, 12);
  assert.equal(JSON.stringify(panels).includes("test-credential"), false);
});

test("expired server credentials refresh once for concurrent requests without replaying accepted actions", async t => {
  let logins = 0;
  let accepted = 0;
  let requiredCredential = "credential-1";
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") {
      logins++;
      response.end(JSON.stringify({ code: 0, data: { Credential: `credential-${logins}` } }));
    } else if (request.headers.authorization !== `Bearer ${requiredCredential}`) {
      response.statusCode = 401; response.end(JSON.stringify({ code: -1, message: "Unauthorized" }));
    } else {
      accepted++;
      response.end(JSON.stringify({ code: -1, message: "ordinary action failure" }));
    }
  });
  const sessions = new NapcatWebuiSessions();
  const panel = await sessions.open(base, "test-token");
  assert.ok(panel);
  requiredCredential = "credential-2";
  await Promise.all(Array.from({ length: 3 }, () => panel.request("/api/QQLogin/SetQuickLogin", { uin: "10000" })));
  assert.equal(logins, 2);
  assert.equal(accepted, 3);
  await sessions.open(base, "rotated-test-token");
  assert.equal(logins, 3);
});
