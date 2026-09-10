import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  handleGatewayControlApi,
  type GatewayControlRoutesContext,
  type GatewayPayloadOptions,
  type GatewayWeixinLoginTarget
} from "./gatewayControlRoutes.js";

type RecordedCall = {
  name: string;
  args: unknown[];
};

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function createFixture() {
  const calls: RecordedCall[] = [];
  const failures = new Map<string, Error>();
  const weixinTargets = new Map<string, GatewayWeixinLoginTarget>();
  const trackedOperations: Promise<unknown>[] = [];
  let manualAlreadyRunning = false;

  function record(name: string, ...args: unknown[]): void {
    calls.push({ name, args });
    const failure = failures.get(name);
    if (failure) throw failure;
  }

  const runtimeStatuses = [{ id: "route-a", status: "running" }];
  const context: GatewayControlRoutesContext = {
    readJsonBody,
    jsonResponse(response, statusCode, body) {
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    },
    redirectResponse(response, statusCode, location) {
      response.writeHead(statusCode, { location });
      response.end();
    },
    gatewayPayload(options?: GatewayPayloadOptions) {
      record("gatewayPayload", options);
      return { code: 0, data: { options: options ?? null, marker: "gateways" } };
    },
    async writeConfig(config, expectedContentHash, operationId) {
      record("writeConfig", config, expectedContentHash, operationId);
      return config;
    },
    async writeGatewayConfig(id, definition, hash, operationId) { record("writeGatewayConfig", id, definition, hash, operationId); },
    async resolveRouteMutation(operationId) { record("resolveRouteMutation", operationId); return { state: "committed" }; },
    async loadRuntimes() {
      record("loadRuntimes");
    },
    syncRunningGateways() {
      record("syncRunningGateways");
    },
    runtimeStatuses() {
      record("runtimeStatuses");
      return runtimeStatuses;
    },
    routeCatalogVersion() {
      return {
        contentHash: "a".repeat(64),
        routeConfigHash: "a".repeat(64),
        presentationHash: "b".repeat(64),
        revision: 7
      };
    },
    networkOptionsPayload() {
      record("networkOptionsPayload");
      return { code: 0, data: { localAddresses: [] } };
    },
    startGateway(id) {
      record("startGateway", id);
    },
    stopGateway(id) {
      record("stopGateway", id);
    },
    restartGateway(id) {
      record("restartGateway", id);
    },
    async removeGatewayConfig(id, expectedContentHash, operationId) {
      record("removeGatewayConfig", id, expectedContentHash, operationId);
    },
    weixinLoginTarget(id) {
      record("weixinLoginTarget", id);
      return weixinTargets.get(id);
    },
    requestWeixinLogin(dataDir) {
      record("requestWeixinLogin", dataDir);
    },
    triggerManualRule(id, body) {
      record("triggerManualRule", id, body);
      return { accepted: true, alreadyRunning: manualAlreadyRunning };
    },
    async testAgentDelivery(id, body) {
      record("testAgentDelivery", id, body);
      return {
        deliveryId: "12345678-1234-4234-8234-123456789abc",
        gatewayId: id,
        agentAdapterType: body.agentAdapterType ?? "codex",
        status: "delivered",
        completedAt: "2026-08-28T00:00:00.000Z"
      };
    },
    listDeliveryReplayAttempts(id, limit, status) {
      record("listDeliveryReplayAttempts", id, limit, status);
      return { gatewayId: id, attempts: [{ attemptId: "attempt-1" }] };
    },
    async replayDelivery(id, body) {
      record("replayDelivery", id, body);
    },
    trackOperation<T>(operation: Promise<T>): Promise<T> {
      trackedOperations.push(operation);
      return operation;
    }
  };

  return {
    calls,
    context,
    trackedOperations,
    failures,
    weixinTargets,
    setManualAlreadyRunning(value: boolean) {
      manualAlreadyRunning = value;
    }
  };
}

async function startServer(context: GatewayControlRoutesContext) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!handleGatewayControlApi(request, requestUrl, response, context)) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ fallback: true }));
    }
  });
  let address: AddressInfo;
  do {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.removeAllListeners("error");
    address = server.address() as AddressInfo;
    if (address.port > 10_080) break;
    // Fetch rejects several historical service ports even when a local test server owns them.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } while (true);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("scoped save reports persistence separately from activation and supports recovery lookup", async () => {
  const fixture = createFixture();
  const server = await startServer(fixture.context);
  try {
    fixture.failures.set("syncRunningGateways", new Error("activation unavailable"));
    const response = await fetch(`${server.baseUrl}/gateways/route-a/config`, {
      method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "test:scoped", "if-match": `"${"a".repeat(64)}"` },
      body: JSON.stringify({ id: "route-a", configName: "route-a", enabled: false })
    });
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.receipt.state, "committed");
    assert.equal(body.activation.state, "failed");
    assert.equal(fixture.calls.filter(call => call.name === "writeConfig").length, 0);
    assert.equal(fixture.calls.filter(call => call.name === "writeGatewayConfig").length, 1);
    const recovered = await json(await fetch(`${server.baseUrl}/gateways/mutations/test%3Ascoped`));
    assert.equal(recovered.receipt.state, "committed");
    assert.equal(recovered.receipt.operationId, "test:scoped");
  } finally { await server.close(); }
});

async function post(
  baseUrl: string,
  pathname: string,
  body?: unknown,
  accept?: string,
  idempotencyKey = "gateway-test-operation",
  expectedContentHash = "a".repeat(64)
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(accept ? { accept } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(expectedContentHash ? { "if-match": expectedContentHash } : {})
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual"
  });
}

test("GET /gateways preserves diagnostic and config query semantics", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const full = await fetch(`${app.baseUrl}/gateways`);
    assert.equal(full.status, 200);
    assert.deepEqual((await json(full)).data.options, {
      includeDiagnostics: true,
      includeConfigDefinitions: true
    });

    const summary = await fetch(`${app.baseUrl}/gateways?summary=1`);
    assert.equal(summary.status, 200);
    assert.deepEqual((await json(summary)).data.options, {
      includeDiagnostics: false,
      includeConfigDefinitions: false
    });

    const summaryWithConfig = await fetch(`${app.baseUrl}/gateways?summary=1&includeConfig=1`);
    assert.equal(summaryWithConfig.status, 200);
    assert.deepEqual((await json(summaryWithConfig)).data.options, {
      includeDiagnostics: false,
      includeConfigDefinitions: true
    });
  } finally {
    await app.close();
  }
});

test("POST /gateways awaits the committed config snapshot and keeps 400 errors", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 200);
    const responseBody = await json(response);
    assert.equal(responseBody.data.marker, "gateways");
    assert.deepEqual(responseBody.receipt, {
      state: "committed",
      operationId: "gateway-test-operation",
      routeConfigHash: "a".repeat(64)
    });
    assert.deepEqual(
      fixture.calls.map((call) => call.name),
      ["writeConfig", "syncRunningGateways", "gatewayPayload"]
    );
    assert.deepEqual(fixture.calls[0].args.slice(1), ["a".repeat(64), "gateway-test-operation"]);

    const invalid = await post(app.baseUrl, "/gateways", "{");
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).code, -1);
  } finally {
    await app.close();
  }
});

test("route mutations require a valid upstream Idempotency-Key and never invent one", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const missing = await post(app.baseUrl, "/gateways", { gateways: [] }, undefined, "");
    assert.equal(missing.status, 400);
    assert.deepEqual(await json(missing), {
      code: -1,
      errorCode: "idempotency_key_required",
      message: "Idempotency-Key is required for route catalog mutations."
    });
    const invalid = await post(app.baseUrl, "/gateways/route-a/delete", undefined, undefined, "bad key");
    assert.equal(invalid.status, 400);
    assert.deepEqual(await json(invalid), {
      code: -1,
      errorCode: "idempotency_key_invalid",
      message: "Idempotency-Key is invalid for a route catalog mutation."
    });
    const missingRevision = await post(
      app.baseUrl,
      "/gateways",
      { gateways: [] },
      undefined,
      "gateway-test-operation",
      ""
    );
    assert.equal(missingRevision.status, 400);
    assert.equal((await json(missingRevision)).errorCode, "route_catalog_revision_required");
    assert.deepEqual(fixture.calls, []);
  } finally {
    await app.close();
  }
});

test("stale route catalog mutations return HTTP 412", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("private child detail"),
    { code: "ROUTE_CATALOG_REVISION_CONFLICT" }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 412);
    assert.deepEqual(await json(response), {
      code: -1,
      errorCode: "route_catalog_conflict",
      message: "Route catalog changed; refresh and retry this update."
    });
  } finally {
    await app.close();
  }
});

test("route mutation failures expose stable codes without child diagnostics", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("child diagnostics=C:\\private\\roles"),
    { code: "ROUTE_CATALOG_TRANSACTION_FAILED" }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), {
      code: -1,
      errorCode: "route_catalog_transaction_failed",
      message: "Route catalog update failed."
    });
  } finally {
    await app.close();
  }
});

test("POST /gateways fails closed without publishing uncommitted memory or private diagnostics", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("Route catalog update is temporarily unavailable."),
    {
      statusCode: 503,
      code: "route_catalog_unavailable",
      cause: new Error("private \\\\nas\\route path")
    }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    const body = await json(response);
    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      code: -1,
      errorCode: "route_catalog_unavailable",
      message: "Route catalog update is temporarily unavailable."
    });
    assert.equal(JSON.stringify(body).includes("nas"), false);
    assert.deepEqual(fixture.calls.map(call => call.name), ["writeConfig"]);
  } finally {
    await app.close();
  }
});

test("Gateway lifecycle actions keep success, delete, and error responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    for (const action of ["start", "stop", "restart"] as const) {
      const response = await post(app.baseUrl, `/gateways/route%20a/${action}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), {
        code: 0,
        message: `requested ${action}`,
        data: [{ id: "route-a", status: "running" }]
      });
    }

    const deleted = await post(app.baseUrl, "/gateways/route-a/delete");
    assert.equal(deleted.status, 200);
    const deletedBody = await json(deleted);
    assert.equal(deletedBody.data.marker, "gateways");
    assert.equal(deletedBody.receipt.operationId, "gateway-test-operation");
    assert.equal(deletedBody.receipt.routeConfigHash, "a".repeat(64));
    assert.deepEqual(
      fixture.calls.slice(-3).map((call) => call.name),
      ["removeGatewayConfig", "syncRunningGateways", "gatewayPayload"]
    );
    const removeCall = fixture.calls.find(call => call.name === "removeGatewayConfig");
    assert.deepEqual(removeCall?.args, ["route-a", "a".repeat(64), "gateway-test-operation"]);

    fixture.failures.set("startGateway", new Error("start failed"));
    const failed = await post(app.baseUrl, "/gateways/route-a/start");
    assert.equal(failed.status, 400);
    assert.deepEqual(await json(failed), { code: -1, message: "start failed" });
  } finally {
    await app.close();
  }
});

test("Weixin login preserves missing, disabled, accepted, and failure responses", async () => {
  const fixture = createFixture();
  fixture.weixinTargets.set("disabled", { enabled: false, dataDir: "C:/routes/disabled" });
  fixture.weixinTargets.set("ready", { enabled: true, dataDir: "C:/routes/ready" });
  const app = await startServer(fixture.context);
  try {
    const missing = await post(app.baseUrl, "/gateways/missing/weixin-login");
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(missing), { code: -1, message: "Gateway not found: missing" });

    const disabled = await post(app.baseUrl, "/gateways/disabled/weixin-login");
    assert.equal(disabled.status, 400);
    assert.equal((await json(disabled)).message, "该 Route 未启用个人微信消息端。");

    const accepted = await post(app.baseUrl, "/gateways/ready/weixin-login");
    assert.equal(accepted.status, 202);
    assert.deepEqual(await json(accepted), {
      code: 0,
      message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。"
    });
    assert.equal(
      fixture.calls.some((call) => call.name === "requestWeixinLogin" && call.args[0] === "C:/routes/ready"),
      true
    );

    fixture.failures.set("requestWeixinLogin", new Error("login failed"));
    const failed = await post(app.baseUrl, "/gateways/ready/weixin-login");
    assert.equal(failed.status, 500);
    assert.deepEqual(await json(failed), { code: -1, message: "login failed" });
  } finally {
    await app.close();
  }
});

test("Agent delivery test returns the real target receipt", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const delivered = await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", {
      agentAdapterType: "dsh"
    });
    assert.equal(delivered.status, 200);
    assert.deepEqual(await json(delivered), {
      code: 0,
      message: "agent delivery test completed",
      data: {
        deliveryId: "12345678-1234-4234-8234-123456789abc",
        gatewayId: "route-a",
        agentAdapterType: "dsh",
        status: "delivered",
        completedAt: "2026-08-28T00:00:00.000Z"
      }
    });
    assert.deepEqual(fixture.calls.find(call => call.name === "testAgentDelivery")?.args, [
      "route-a",
      { agentAdapterType: "dsh" }
    ]);

    fixture.failures.set("testAgentDelivery", new Error("Desktop owner unavailable"));
    const failed = await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", {
      agentAdapterType: "codex"
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await json(failed), { code: -1, message: "Desktop owner unavailable" });
  } finally {
    await app.close();
  }
});

test("Manual trigger keeps accepted, already-running, and parse failure responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const accepted = await post(app.baseUrl, "/gateways/route-a/manual-trigger", {
      triggerId: "manual",
      message: "run"
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await json(accepted), {
      code: 0,
      message: "manual trigger accepted",
      data: { accepted: true, alreadyRunning: false }
    });

    fixture.setManualAlreadyRunning(true);
    const running = await post(app.baseUrl, "/gateways/route-a/manual-trigger", {});
    assert.equal(running.status, 202);
    assert.equal((await json(running)).message, "manual trigger already running");

    const invalid = await post(app.baseUrl, "/gateways/route-a/manual-trigger", "{");
    assert.equal(invalid.status, 500);
    assert.equal((await json(invalid)).code, -1);
  } finally {
    await app.close();
  }
});

test("Delivery replay preserves list, replay, and error responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const listed = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay?limit=25&status=failed`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await json(listed), {
      code: 0,
      gatewayId: "route-a",
      attempts: [{ attemptId: "attempt-1" }]
    });
    assert.deepEqual(
      fixture.calls.find((call) => call.name === "listDeliveryReplayAttempts")?.args,
      ["route-a", 25, "failed"]
    );

    const replayed = await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-1" });
    assert.equal(replayed.status, 202);
    assert.deepEqual(await json(replayed), {
      code: 0,
      message: "delivery replay requested",
      data: [{ id: "route-a", status: "running" }]
    });

    const method = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay`, { method: "PUT" });
    assert.equal(method.status, 405);
    assert.deepEqual(await json(method), { code: -1, message: "Method not allowed" });

    fixture.failures.set("listDeliveryReplayAttempts", new Error("list failed"));
    const listFailed = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay`);
    assert.equal(listFailed.status, 400);
    assert.deepEqual(await json(listFailed), { code: -1, message: "list failed" });

    fixture.failures.set("replayDelivery", new Error("replay failed"));
    const replayFailed = await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-2" });
    assert.equal(replayFailed.status, 500);
    assert.deepEqual(await json(replayFailed), { code: -1, message: "replay failed" });
  } finally {
    await app.close();
  }
});

test("Network options and reload preserve JSON and redirect responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const network = await fetch(`${app.baseUrl}/network-options`);
    assert.equal(network.status, 200);
    assert.deepEqual(await json(network), { code: 0, data: { localAddresses: [] } });

    const reloadJson = await post(app.baseUrl, "/reload", undefined, "application/json");
    assert.equal(reloadJson.status, 200);
    assert.deepEqual(await json(reloadJson), {
      ok: true,
      gateways: [{ id: "route-a", status: "running" }],
      routeCatalog: {
        contentHash: "a".repeat(64),
        routeConfigHash: "a".repeat(64),
        presentationHash: "b".repeat(64),
        revision: 7
      }
    });

    const reloadRedirect = await post(app.baseUrl, "/reload");
    assert.equal(reloadRedirect.status, 303);
    assert.equal(reloadRedirect.headers.get("location"), "/");

    assert.equal(fixture.calls.filter((call) => call.name === "loadRuntimes").length, 2);
    assert.equal(fixture.calls.filter((call) => call.name === "syncRunningGateways").length, 2);
  } finally {
    await app.close();
  }
});

test("Unrelated paths and unsupported top-level methods fall through", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const unrelated = await fetch(`${app.baseUrl}/api/unrelated`);
    assert.equal(unrelated.status, 404);
    assert.deepEqual(await json(unrelated), { fallback: true });

    const getReload = await fetch(`${app.baseUrl}/reload`);
    assert.equal(getReload.status, 404);

    const putGateways = await fetch(`${app.baseUrl}/gateways`, { method: "PUT" });
    assert.equal(putGateways.status, 404);
  } finally {
    await app.close();
  }
});


test("registers complete asynchronous gateway request chains", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    await post(app.baseUrl, "/gateways", { gateways: [] });
    await post(app.baseUrl, "/gateways/route-a/manual-trigger", { triggerId: "manual" });
    await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", { agentAdapterType: "codex" });
    await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-1" });

    assert.equal(fixture.trackedOperations.length, 4);
    assert.deepEqual(
      (await Promise.allSettled(fixture.trackedOperations)).map((result) => result.status),
      ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]
    );
  } finally {
    await app.close();
  }
});
