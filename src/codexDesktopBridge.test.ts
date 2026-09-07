import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexDesktopBridge,
  type CodexDesktopDeliveryEvent,
  agentDeliveryMarkerForTest,
  applyCodexSidebarTaskNamesForTest,
  codexDesktopDeepLinkForTest,
  listCodexDesktopThreadsFromRowsForTest
} from "./codexDesktopBridge.js";

test("Desktop left sidebar is the only displayed task-name source", () => {
  const id = "019f0000-0000-7000-8000-000000000065";
  const result = applyCodexSidebarTaskNamesForTest([{
    id,
    title: "[rabi:bind XinghaiBuilder]\n[消息处理 Agent 初始化]",
    cwd: "C:\\Work\\PangHu",
    rolloutPath: "task.jsonl",
    firstUserMessage: "[rabi:bind XinghaiBuilder]",
    updatedAt: "2026-08-04T08:00:00.000Z"
  }], [
    JSON.stringify({ id, thread_name: "星海建造师 策划 程序 协助处理消息3", updated_at: "2026-08-04T08:01:00.000Z" }),
    JSON.stringify({ id, thread_name: "旧侧栏名称", updated_at: "2026-08-04T07:59:00.000Z" })
  ].join("\n"));

  assert.equal(result[0]?.id, id);
  assert.equal(result[0]?.title, "星海建造师 策划 程序 协助处理消息3");
  assert.equal(result[0]?.updatedAt, "2026-08-04T08:01:00.000Z");
  assert.equal(result[0]?.stateTitle, "[rabi:bind XinghaiBuilder]\n[消息处理 Agent 初始化]");
});

test("Desktop tasks without a sidebar Name do not fall back to SQLite title", () => {
  const result = applyCodexSidebarTaskNamesForTest([{
    id: "019f0000-0000-7000-8000-000000000066",
    title: "SQLite 原始 title",
    cwd: "C:\\Work\\PangHu",
    rolloutPath: "task.jsonl",
    firstUserMessage: "首条消息",
    updatedAt: "2026-08-04T08:00:00.000Z"
  }], "");

  assert.equal(result[0]?.title, "");
  assert.equal(result[0]?.stateTitle, "SQLite 原始 title");
});

type IpcRequest = {
  type?: string;
  requestId?: string;
  method?: string;
  version?: number;
  params?: {
    conversationId?: string;
    following?: boolean;
    turnStart?: {
      request?: Record<string, any>;
      context?: Record<string, any>;
    };
    input?: Array<Record<string, unknown>>;
    restoreMessage?: Record<string, any>;
  };
};

function testPipePath(name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.sock`);
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function createMockDesktopRouter(
  handler: (request: IpcRequest, methods: string[]) => Record<string, unknown> | Promise<Record<string, unknown>>,
  snapshot: Record<string, unknown> | null = { latestModel: "test-owner-model" }
): Promise<{ pipePath: string; methods: string[]; close: () => Promise<void> }> {
  const pipePath = testPipePath("rabiroute-codex-desktop");
  const methods: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (pending.length < 4 + length) return;
        const request = JSON.parse(pending.subarray(4, 4 + length).toString("utf8")) as IpcRequest;
        pending = pending.subarray(4 + length);
        if (request.type === "broadcast" && request.method === "thread-stream-following-changed") {
          if (request.params?.following && snapshot) socket.write(encodeFrame({
            type: "broadcast", method: "thread-stream-state-changed",
            params: { conversationId: request.params.conversationId, change: { type: "snapshot", conversationState: snapshot } }
          }));
          continue;
        }
        if (request.method) methods.push(request.method);
        void Promise.resolve(handler(request, methods))
          .then((response) => socket.write(encodeFrame(response)))
          .catch(() => socket.destroy());
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  return {
    pipePath,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for mock Desktop IPC state.");
    await wait(5);
  }
}

test("Desktop thread discovery uses exact id while displaying title and latest time", () => {
  const result = listCodexDesktopThreadsFromRowsForTest([
    {
      id: "thread-old",
      title: "夜雨会话",
      cwd: "C:\\Work\\RabiRoute",
      rollout_path: "old.jsonl",
      updated_at_ms: 1_000,
      updated_at: 1,
      archived: 0
    },
    {
      id: "thread-new",
      title: "夜雨会话",
      cwd: "C:\\Work\\RabiRoute",
      rollout_path: "new.jsonl",
      first_user_message: "第一条消息",
      updated_at_ms: 2_000,
      updated_at: 2,
      archived: 0
    },
    {
      id: "thread-other",
      title: "其它项目",
      cwd: "D:\\Other",
      rollout_path: "other.jsonl",
      updated_at_ms: 3_000,
      updated_at: 3,
      archived: 0
    }
  ], { query: "夜雨", allowedWorkspaces: ["C:\\Work\\RabiRoute"], limit: 20 });

  assert.deepEqual(result.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt })), [
    { id: "thread-new", title: "夜雨会话", updatedAt: "1970-01-01T00:00:02.000Z" },
    { id: "thread-old", title: "夜雨会话", updatedAt: "1970-01-01T00:00:01.000Z" }
  ]);
  assert.equal(result[0]?.firstUserMessage, "第一条消息");
  assert.equal(result[1]?.firstUserMessage, "");
});

test("Desktop exact task metadata preserves archived state without listing archived tasks", () => {
  const rows = [{
    id: "019f0000-0000-7000-8000-000000000045",
    title: "已归档的固定任务",
    cwd: "C:\\Work\\RabiRoute",
    rollout_path: "archived.jsonl",
    updated_at_ms: 3_000,
    archived: 1
  }];

  assert.deepEqual(listCodexDesktopThreadsFromRowsForTest(rows, { limit: 10 }), []);
  const exact = listCodexDesktopThreadsFromRowsForTest(rows, { limit: 1, includeArchived: true })[0];
  assert.equal(exact.id, rows[0].id);
  assert.equal(exact.archived, true);
});

test("Desktop thread discovery supports pages beyond the first 100 tasks", () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: `thread-${index}`,
    title: `任务 ${index}`,
    cwd: "C:\\Work\\RabiRoute",
    rollout_path: `${index}.jsonl`,
    updated_at_ms: index + 1,
    archived: 0
  }));
  const page = listCodexDesktopThreadsFromRowsForTest(rows, { limit: 100, offset: 100 });

  assert.equal(page.length, 100);
  assert.equal(page[0]?.id, "thread-104");
  assert.equal(page[99]?.id, "thread-5");
});

test("Desktop bridge steers an active task instead of starting a concurrent turn", async () => {
  const router = await createMockDesktopRouter((request) => request.method === "initialize"
    ? { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } }
    : { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000050",
      prompt: "active task message",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "steered");
    assert.deepEqual(router.methods, ["initialize", "thread-follower-steer-turn"]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge starts a new turn when the task is idle", async () => {
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000051",
      prompt: "idle task message",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "started");
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});


test("Desktop bridge never resends an accepted steer when its receipt is delayed", async () => {
  const methods: string[] = [];
  const events: CodexDesktopDeliveryEvent[] = [];
  let receiptReads = 0;
  const router = await createMockDesktopRouter((request) => {
    methods.push(request.method ?? "");
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: { clientId: "rabi" } };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    deliveryReceiptGraceMs: 0,
    deliveryReceiptReader: async () => ++receiptReads >= 2,
    onDeliveryEvent: event => { events.push(event); }
  });

  try {
    await assert.rejects(bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000113",
      prompt: "[投递编号] deliveryId: 88888888-1111-4222-8333-444444444444\n验证投递",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    }), { name: "CodexDesktopDeliveryUnconfirmedError" });
    assert.deepEqual(methods.filter(method => method.startsWith("thread-follower-")), [
      "thread-follower-steer-turn"
    ]);
    assert.deepEqual(events.map(event => event.stage), [
      "queued",
      "queue_released",
      "steer_requested",
      "steer_accepted",
      "delivery_receipt_missing",
      "delivery_unconfirmed"
    ]);
    const requested = events.find(event => event.stage === "steer_requested")!;
    const accepted = events.find(event => event.stage === "steer_accepted")!;
    assert.ok(requested.requestId);
    assert.equal(accepted.requestId, requested.requestId);
    assert.equal(accepted.outcome, "accepted");
    assert.ok(accepted.elapsedMs! >= 0);
    assert.ok(events.every(event => event.deliveryMarker === "88888888-1111-4222-8333-444444444444"));
    assert.ok(!JSON.stringify(events).includes("验证投递"));
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge starts a new turn when current Desktop reports NoActiveTurn", async () => {
  let turnStart: { request?: Record<string, any>; context?: Record<string, any> } | undefined;
  let startRequestVersion: number | undefined;
  const events: Array<{ stage: string; method?: string; payloadShape?: string }> = [];
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "NoActiveTurn" };
    }
    if (request.method === "thread-follower-start-turn") {
      turnStart = request.params?.turnStart;
      startRequestVersion = request.version;
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    onDeliveryEvent: (event) => events.push(event)
  });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000057",
      prompt: "idle task current Desktop message",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "started");
    assert.equal(turnStart?.request?.threadId, "019f0000-0000-7000-8000-000000000057");
    assert.equal(typeof turnStart?.request?.clientUserMessageId, "string");
    assert.equal(startRequestVersion, 2);
    assert.deepEqual(turnStart?.request?.input, [{ type: "text", text: "idle task current Desktop message", text_elements: [] }]);
    assert.equal(turnStart?.request?.turnStartParams, undefined);
    assert.deepEqual(turnStart?.context, { attachments: [], commentAttachments: [] });
    assert.deepEqual(events.map((event) => event.stage), [
      "queued",
      "queue_released",
      "steer_requested",
      "steer_rejected",
      "start_fallback",
      "model_checked",
      "start_requested",
      "start_accepted",
      "delivery_accepted"
    ]);
    const startRequested = events.find((event) => event.stage === "start_requested");
    assert.equal(startRequested?.method, "thread-follower-start-turn");
    assert.equal(startRequested?.payloadShape, "turnStart.request+context");
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

for (const scenario of ["delayed-receipt", "timeout-confirmed", "timeout-unconfirmed", "start-unconfirmed"] as const) {
  test(`Desktop delivery diagnostics and no resend: ${scenario}`, async () => {
    const events: CodexDesktopDeliveryEvent[] = [];
    const marker = "55555555-1111-4222-8333-444444444444";
    let receiptReads = 0;
    const router = await createMockDesktopRouter(request => {
      if (request.method === "initialize") return { type: "response", requestId: request.requestId, resultType: "success", result: { clientId: "rabi" } };
      if (scenario === "start-unconfirmed" && request.method === "thread-follower-steer-turn") {
        return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
      }
      if (scenario.startsWith("timeout")) return { type: "response", requestId: request.requestId, resultType: "error", error: "thread-follower-steer-turn-timeout" };
      return { type: "response", requestId: request.requestId, resultType: "success", result: {} };
    });
    const bridge = new CodexDesktopBridge({
      pipePaths: [router.pipePath],
      deliveryReceiptGraceMs: 40,
      deliveryReceiptPollMs: 10,
      deliveryReceiptReader: () => ++receiptReads >= 2 && (scenario === "delayed-receipt" || scenario === "timeout-confirmed"),
      onDeliveryEvent: event => events.push(event)
    });
    try {
      const pending = bridge.deliver({ threadId: "019f0000-0000-7000-8000-000000000114", prompt: `private prompt\ndeliveryId: ${marker}`, cwd: process.cwd(), sandbox: "workspace-write" });
      if (scenario.endsWith("unconfirmed")) {
        await assert.rejects(pending, { name: "CodexDesktopDeliveryUnconfirmedError" });
        assert.equal(events.at(-1)?.stage, "delivery_unconfirmed");
        assert.ok(!events.some(event => event.stage === "delivery_accepted"));
      } else {
        assert.equal((await pending).action, "steered");
        assert.ok(events.some(event => event.stage === "delivery_receipt_confirmed"));
      }
      assert.deepEqual(router.methods.filter(method => method.startsWith("thread-follower-")), scenario === "start-unconfirmed"
        ? ["thread-follower-steer-turn", "thread-follower-start-turn"] : ["thread-follower-steer-turn"]);
      assert.ok(receiptReads >= 2);
      assert.ok(events.every(event => event.deliveryMarker === marker));
      assert.ok(!JSON.stringify(events).includes("private prompt"));
      if (scenario.startsWith("timeout")) {
        const rejected = events.find(event => event.stage === "steer_rejected")!;
        assert.equal(rejected.outcome, "timeout");
        assert.equal(rejected.requestId, events.find(event => event.stage === "steer_requested")?.requestId);
      }
    } finally {
      bridge.close();
      await router.close();
    }
  });
}
test("Desktop bridge accepts a timed-out start when the exact Agent delivery marker reached the rollout", async () => {
  const prompt = "[Agent 回复合同]\n本次投递 deliveryId：11111111-2222-4333-8444-555555555555\n\n[消息内容]\ncontinue";
  const seen: Array<{ threadId: string; marker: string }> = [];
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "error", error: "thread-follower-start-turn-timeout" };
  });
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    deliveryReceiptGraceMs: 0,
    deliveryReceiptReader: (threadId, marker) => {
      seen.push({ threadId, marker });
      return marker === "11111111-2222-4333-8444-555555555555";
    }
  });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000052",
      prompt,
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.equal(result.action, "started");
    assert.deepEqual(seen, [{
      threadId: "019f0000-0000-7000-8000-000000000052",
      marker: "11111111-2222-4333-8444-555555555555"
    }]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge keeps a timed-out Agent delivery failed when its marker is absent", async () => {
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "error", error: "thread-follower-start-turn-timeout" };
  });
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    deliveryReceiptGraceMs: 0,
    deliveryReceiptReader: () => false
  });

  try {
    await assert.rejects(bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000053",
      prompt: "本次投递 deliveryId：aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    }), /thread-follower-start-turn-timeout/);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Agent delivery marker extraction ignores ordinary prompts", () => {
  assert.equal(agentDeliveryMarkerForTest("ordinary prompt"), "");
  assert.equal(
    agentDeliveryMarkerForTest("本次投递 deliveryId: ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF"),
    "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF"
  );
});

test("Desktop bridge sends local images as model input for both start and restored message context", async () => {
  const requests: IpcRequest[] = [];
  const router = await createMockDesktopRouter((request) => {
    requests.push(request);
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });
  const imagePath = path.join(os.tmpdir(), "rabiroute-message-image.png");

  try {
    await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000059",
      prompt: "inspect the image",
      cwd: process.cwd(),
      sandbox: "workspace-write",
      imagePaths: [imagePath]
    });
    const steer = requests.find((request) => request.method === "thread-follower-steer-turn");
    const start = requests.find((request) => request.method === "thread-follower-start-turn");
    assert.deepEqual(steer?.params?.input, [
      { type: "text", text: "inspect the image", text_elements: [] },
      { type: "localImage", path: imagePath }
    ]);
    assert.equal(steer?.params?.restoreMessage?.context.imageAttachments[0]?.localPath, imagePath);
    assert.deepEqual(start?.params?.turnStart?.request?.input, [
      { type: "text", text: "inspect the image", text_elements: [] },
      { type: "localImage", path: imagePath }
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge drops connection-scoped active state when it closes", async () => {
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });
  const threadId = "019f0000-0000-7000-8000-000000000053";

  try {
    await bridge.deliver({
      threadId,
      prompt: "start then close",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.equal(bridge.isThreadActive(threadId), true);
    bridge.close();
    assert.equal(bridge.isThreadActive(threadId), false);
  } finally {
    bridge.close();
    await router.close();
  }
});

for (const scenario of [
  { name: "blank owner collaboration overrides valid latestModel", snapshot: { latestModel: "valid-model", latestCollaborationMode: { settings: { model: "" } } } },
  { name: "blank explicit request model", snapshot: { latestModel: "valid-model" }, model: "  " },
  { name: "owner snapshot unavailable", snapshot: null }
]) {
  test(`Desktop bridge refuses start: ${scenario.name}`, async () => {
    const events: CodexDesktopDeliveryEvent[] = [];
    const router = await createMockDesktopRouter(request => ({
      type: "response", requestId: request.requestId,
      resultType: request.method === "thread-follower-steer-turn" ? "error" : "success",
      error: request.method === "thread-follower-steer-turn" ? "NoActiveTurn" : undefined,
      result: { clientId: "rabi" }
    }), scenario.snapshot);
    const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath], requestTimeoutMs: 100, onDeliveryEvent: event => events.push(event) });
    try {
      await assert.rejects(bridge.deliver({ threadId: "model-test", prompt: "private message", cwd: process.cwd(), sandbox: "workspace-write", model: scenario.model }), { name: "CodexDesktopModelSettingsError" });
      assert.equal(router.methods.includes("thread-follower-start-turn"), false);
      assert.equal(events.filter(event => event.stage === "model_rejected").length, 1);
      assert.equal(JSON.stringify(events).includes("private message"), false);
    } finally { bridge.close(); await router.close(); }
  });
}

test("Desktop bridge starts a message processing turn with the configured Luna model", async () => {
  let turnStartParams: Record<string, any> | undefined;
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    if (request.method === "thread-follower-start-turn") turnStartParams = request.params?.turnStart?.request;
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });

  try {
    await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000052",
      prompt: "message group",
      cwd: process.cwd(),
      sandbox: "workspace-write",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium"
    });

    assert.equal(turnStartParams?.model, "gpt-5.6-luna");
    assert.equal(turnStartParams?.effort, "medium");
    assert.deepEqual(turnStartParams?.collaborationMode, {
      mode: "default",
      settings: {
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
        developer_instructions: ""
      }
    });
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge serializes deliveries to the same task across requested workspaces", async () => {
  const pendingSteers: Array<{
    requestId?: string;
    threadId: string;
    resolve: (response: Record<string, unknown>) => void;
  }> = [];
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return new Promise<Record<string, unknown>>((resolve) => pendingSteers.push({
        requestId: request.requestId,
        threadId: String(request.params?.conversationId || ""),
        resolve
      }));
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });
  const threadId = "019f0000-0000-7000-8000-000000000061";

  try {
    const first = bridge.deliver({ threadId, prompt: "first", cwd: process.cwd(), sandbox: "workspace-write" });
    const second = bridge.deliver({ threadId, prompt: "second", cwd: path.dirname(process.cwd()), sandbox: "workspace-write" });
    await waitFor(() => pendingSteers.length >= 1);
    await wait(20);
    const pendingBeforeFirstCompletes = pendingSteers.length;

    pendingSteers[0]!.resolve({
      type: "response",
      requestId: pendingSteers[0]!.requestId,
      resultType: "success",
      method: "thread-follower-steer-turn",
      result: {}
    });
    await first;
    await waitFor(() => pendingSteers.length >= 2);
    pendingSteers[1]!.resolve({
      type: "response",
      requestId: pendingSteers[1]!.requestId,
      resultType: "success",
      method: "thread-follower-steer-turn",
      result: {}
    });
    await second;

    assert.equal(pendingBeforeFirstCompletes, 1);
    assert.deepEqual(pendingSteers.map((item) => item.threadId), [threadId, threadId]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge delivers to different tasks concurrently", async () => {
  const pendingSteers: Array<{
    requestId?: string;
    threadId: string;
    resolve: (response: Record<string, unknown>) => void;
  }> = [];
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return new Promise<Record<string, unknown>>((resolve) => pendingSteers.push({
        requestId: request.requestId,
        threadId: String(request.params?.conversationId || ""),
        resolve
      }));
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });
  const firstThreadId = "019f0000-0000-7000-8000-000000000062";
  const secondThreadId = "019f0000-0000-7000-8000-000000000063";

  try {
    const deliveries = [
      bridge.deliver({ threadId: firstThreadId, prompt: "first task", cwd: process.cwd(), sandbox: "workspace-write" }),
      bridge.deliver({ threadId: secondThreadId, prompt: "second task", cwd: process.cwd(), sandbox: "workspace-write" })
    ];
    await waitFor(() => pendingSteers.length === 2);
    for (const pending of pendingSteers) {
      pending.resolve({
        type: "response",
        requestId: pending.requestId,
        resultType: "success",
        method: "thread-follower-steer-turn",
        result: {}
      });
    }
    await Promise.all(deliveries);

    assert.deepEqual(new Set(pendingSteers.map((item) => item.threadId)), new Set([firstThreadId, secondThreadId]));
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge loads an unowned task and delivers through the Desktop owner", async () => {
  let deliveryAttempt = 0;
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      deliveryAttempt += 1;
      return deliveryAttempt === 1
        ? { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }
        : { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const opened: string[] = [];
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async (threadId) => { opened.push(threadId); }
  });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000001",
      prompt: "RabiRoute Desktop IPC test",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.deepEqual(opened, ["019f0000-0000-7000-8000-000000000001"]);
    assert.equal(result.action, "started");
    assert.equal(result.openedThread, true);
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge opens a bound task only once while waiting for its owner", async () => {
  let deliveryAttempt = 0;
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      deliveryAttempt += 1;
      return deliveryAttempt < 6
        ? { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }
        : { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const opened: string[] = [];
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 6,
    loadRetryDelayMs: 1,
    openThread: async (threadId) => { opened.push(threadId); }
  });
  const threadId = "019f0000-0000-7000-8000-000000000064";

  try {
    const result = await bridge.deliver({
      threadId,
      prompt: "wait for the original Desktop owner",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "started");
    assert.deepEqual(opened, [threadId]);
    assert.equal(router.methods.filter((method) => method === "thread-follower-steer-turn").length, 6);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge retries a freshly created task until its rollout owner is ready", async () => {
  let deliveryAttempt = 0;
  const threadId = "019f0000-0000-7000-8000-000000000004";
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      deliveryAttempt += 1;
      return deliveryAttempt === 1
        ? { type: "response", requestId: request.requestId, resultType: "error", error: `no rollout found for thread id ${threadId}` }
        : { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const opened: string[] = [];
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async (openedThreadId) => { opened.push(openedThreadId); }
  });

  try {
    const result = await bridge.deliver({
      threadId,
      prompt: "fresh Desktop task",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.deepEqual(opened, [threadId]);
    assert.equal(result.action, "started");
    assert.equal(result.openedThread, true);
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge fails closed when no Desktop owner loads the task", async () => {
  const router = await createMockDesktopRouter((request) => request.method === "initialize"
    ? { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } }
    : { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" });
  let openCount = 0;
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async () => { openCount += 1; }
  });

  try {
    await assert.rejects(bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000002",
      prompt: "must stay in Desktop",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    }), /只请求打开一次.*手动打开目标任务.*no-client-found/i);
    assert.equal(openCount, 1);
    assert.equal(router.methods.filter((method) => method === "thread-follower-steer-turn").length, 2);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop task deep link keeps the opaque thread id intact", () => {
  assert.equal(
    codexDesktopDeepLinkForTest("019f0000-0000-7000-8000-000000000003"),
    "codex://threads/019f0000-0000-7000-8000-000000000003"
  );
});
