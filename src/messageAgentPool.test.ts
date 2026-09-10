import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  MessageAgentPool,
  rankMessageAgentWorkers,
  replacePersistedMessageAgentWorker,
  requestMessageAgentManager,
  readCurrentMessageAgentWorkers,
  resolveCurrentMessageAgentWorker
} from "./messageAgentPool.js";
import type { MessageAgentDeliveryRouting, MessageAgentPoolState } from "./messageAgentPool.js";
import type { PendingMessageGroup } from "./messageGrouping.js";

function deliveryPayloadText(payload: Record<string, any> | undefined): string {
  if (!payload) return "";
  return [
    String(payload.prompt || ""),
    ...(Array.isArray(payload.contextBlocks) ? payload.contextBlocks.map(String) : []),
    ...(Array.isArray(payload.controlBlocks) ? payload.controlBlocks.map(String) : [])
  ].filter(Boolean).join("\n\n");
}

function group(groupId: string, patch: Partial<PendingMessageGroup> = {}): PendingMessageGroup {
  return {
    groupId,
    key: groupId,
    baseKey: "napcat|group:100|sender:200",
    endpoint: "napcat",
    conversationKey: "napcat:group:100",
    sender: "200",
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
    maxDeadlineAt: 3,
    status: "pending",
    attempts: 0,
    items: [{ identity: `${groupId}-m1`, receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { rawMessage: "hi" }, extraValues: {} } }],
    ...patch
  };
}

function messageSourceForGroup(messageGroup: PendingMessageGroup) {
  return {
    type: "message_adapter" as const,
    messageAdapter: messageGroup.endpoint,
    conversationType: messageGroup.items[0]?.payload.routeKind,
    conversationName: messageGroup.conversationKey,
    conversationId: messageGroup.conversationKey,
    senderName: messageGroup.sender,
    messageId: messageGroup.items[0]?.identity,
    messageGroupId: messageGroup.groupId
  };
}

function deliver(
  pool: MessageAgentPool,
  messageGroup: PendingMessageGroup,
  prompt: string,
  routing: Partial<MessageAgentDeliveryRouting> = {}
) {
  return pool.deliver(messageGroup, prompt, {
    ...routing,
    messageSource: routing.messageSource ?? messageSourceForGroup(messageGroup)
  });
}

function options(statePath: string) {
  return {
    statePath,
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadName: "星海主任务",
    sourceThreadId: "019f0000-0000-7000-8000-999999999999",
    workspace: process.cwd(),
    roleId: "XinghaiBuilder",
    roleDisplayName: "星海建造师 策划 程序",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium" as const
  };
}

test("Message Agent delivery rejects an omitted messageSource before allocation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-source-"));
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async () => { throw new Error("request must not run"); }
  });

  await assert.rejects(
    pool.deliver(group("missing-source"), "消息", {} as MessageAgentDeliveryRouting),
    /requires messageSource/
  );
});

test("Manager HTTP 202 preserves the uncertain delivery identity instead of losing its receipt", async (context) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: -1, status: "delivery_unconfirmed", delivery: { deliveryId: "original-delivery" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(requestMessageAgentManager(`http://127.0.0.1:${address.port}`, { action: "send" }), error => {
    const failure = error as Error & { statusCode: number; response: { delivery: { deliveryId: string } } };
    assert.equal(failure.statusCode, 202);
    assert.equal(failure.response.delivery.deliveryId, "original-delivery");
    return true;
  });
});

test("Message Agent Manager requests use a one-shot connection and close it after the response", async (t) => {
  let requestConnection = "";
  let socketClosed = false;
  let resolveSocketClosed = (): void => undefined;
  const socketClosedPromise = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = http.createServer((request, response) => {
    requestConnection = String(request.headers.connection || "");
    request.socket.once("close", () => {
      socketClosed = true;
      resolveSocketClosed();
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, thread: { id: "thread-1" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await requestMessageAgentManager(`http://127.0.0.1:${address.port}`, { action: "read" }, 5_000);
  await socketClosedPromise;

  assert.equal(result.thread?.id, "thread-1");
  assert.equal(requestConnection.toLowerCase(), "close");
  assert.equal(socketClosed, true);
});

test("a one-shot delivery child can exit immediately after its Manager request", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, thread: { id: "thread-1" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "messageAgentPool.ts")).href;
  const script = [
    `const { requestMessageAgentManager } = await import(${JSON.stringify(moduleUrl)});`,
    `await requestMessageAgentManager(${JSON.stringify(`http://127.0.0.1:${address.port}`)}, { action: "read" }, 1000);`,
    `process.exit(0);`
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING/);
});

test("Message Agent pool discards persisted workers from a previous Primary Persona workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-workspace-"));
  const statePath = path.join(root, "agents.json");
  const primaryWorkspace = path.join(root, "primary");
  const oldWorkspace = path.join(root, "old-primary");
  fs.mkdirSync(primaryWorkspace);
  fs.mkdirSync(oldWorkspace);
  const oldThreadId = "019f0000-0000-7000-8000-000000000091";
  const newThreadId = "019f0000-0000-7000-8000-000000000092";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-20T00:00:00.000Z",
    workers: [{
      threadId: oldThreadId,
      threadName: "旧主人格 协助处理消息1",
      workspace: oldWorkspace,
      index: 1,
      createdAt: "2026-08-20T00:00:00.000Z",
      affinities: []
    }]
  }), "utf8");
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({ ...options(statePath), workspace: primaryWorkspace }, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      if (payload.action === "read") return { thread: { status: { type: "idle" } } };
      if (payload.action === "resolve") {
        return { thread: { id: newThreadId, title: payload.title, cwd: primaryWorkspace } };
      }
      return {};
    }
  });

  assert.deepEqual(readCurrentMessageAgentWorkers(statePath, undefined, primaryWorkspace), []);
  await deliver(pool, group("new-workspace"), "新目录消息");

  assert.equal(calls.some((call) => call.action === "send" && call.threadId === oldThreadId), false);
  assert.equal(calls.find((call) => call.action === "resolve")?.cwd, primaryWorkspace);
  assert.deepEqual(readCurrentMessageAgentWorkers(statePath, undefined, primaryWorkspace).map((worker) => worker.threadId), [newThreadId]);
  assert.equal(readCurrentMessageAgentWorkers(statePath).some((worker) => worker.threadId === oldThreadId), false);
});

test("Message Agent pool creates a Desktop task and sends the first group with Luna initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    now: () => new Date("2026-08-04T06:00:00.000Z"),
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { name: "星海建造师 策划 程序", status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: "019f0000-0000-7000-8000-000000000010", title: payload.title, cwd: process.cwd() } };
      return {};
    }
  });

  const imagePath = path.join(root, "message.png");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  const worker = await deliver(pool, group("g1"), "[消息组 g1]\n你好", { imagePaths: [imagePath] });
  const resolveCall = calls.find((call) => call.action === "resolve");
  const sendCall = calls.find((call) => call.action === "send");
  assert.equal(worker.threadName, "星海建造师 策划 程序 协助处理消息");
  assert.equal(resolveCall?.lookupMode, "state_db");
  assert.equal(sendCall?.model, "gpt-5.6-luna");
  assert.equal(sendCall?.reasoningEffort, "medium");
  assert.deepEqual(sendCall?.messageSource, {
    type: "message_adapter",
    messageAdapter: "napcat",
    conversationType: "group_message",
    conversationName: "napcat:group:100",
    conversationId: "napcat:group:100",
    senderName: "200",
    messageId: "g1-m1",
    messageGroupId: "g1"
  });
  assert.deepEqual(sendCall?.imagePaths, [imagePath]);
  const deliveryText = deliveryPayloadText(sendCall);
  assert.match(deliveryText, /你是消息处理 Agent/);
  assert.match(deliveryText, /\[消息组 g1\]/);
  assert.match(deliveryText, /\[当前消息处理归属\]/);
  assert.match(deliveryText, new RegExp(`消息处理任务 ID：${worker.threadId}`));
  assert.match(deliveryText, /对方通过 POST .* 回复本任务/);
  assert.match(deliveryText, new RegExp(`sourceThreadId=${worker.threadId}`));
  assert.match(deliveryText, /sourceAgentType=message_processing/);
  assert.match(deliveryText, /当前任务输出只供内部查看/);
  assert.match(deliveryText, /待决定事项必须实际交给主人格/);
  assert.match(deliveryText, new RegExp(`threadId=${options(path.join(root, "unused.json")).sourceThreadId}`));
  assert.match(deliveryText, /要求回传发送回执或决定/);
  assert.match(deliveryText, /处理结果：无需对外回复/);
  assert.match(deliveryText, /计划操作与外部回复分开判断/);
  assert.doesNotMatch(deliveryText, /\[主动协作要求\]/);
  assert.match(deliveryText, /调查类请求先查清事实/);
  assert.match(deliveryText, /附件必须实际查看/);
  assert.match(deliveryText, /params\.replyImageDescriptions/);
  assert.match(deliveryText, /按原图顺序说明内容和含义/);
  assert.match(deliveryText, /群内回复默认一至两句/);
});

test("Message Agent names use the Primary Persona's displayed Codex Name", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-displayed-name-"));
  const resolvedTitles: string[] = [];
  const pool = new MessageAgentPool({
    ...options(path.join(root, "agents.json")),
    sourceThreadName: "原始任务标题",
    roleDisplayName: "角色文件标题"
  }, {
    request: async (payload) => {
      if (payload.action === "read") {
        return { thread: { name: "Desktop 显示 Name", title: "原始任务标题", status: { type: "idle" }, active: false } };
      }
      if (payload.action === "resolve") {
        resolvedTitles.push(String(payload.title));
        return { thread: { id: "019f0000-0000-7000-8000-000000000084", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("displayed-name"), "create");

  assert.deepEqual(resolvedTitles, ["Desktop 显示 Name 协助处理消息"]);
});

test("Message Agent creation fails closed when the Codex sidebar Name is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-missing-display-name-"));
  let resolveCount = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "read") {
        return { thread: { id: options(path.join(root, "unused.json")).sourceThreadId, name: "", title: "", status: { type: "idle" } } };
      }
      if (payload.action === "resolve") resolveCount += 1;
      return {};
    }
  });

  await assert.rejects(
    () => deliver(pool, group("missing-display-name"), "create"),
    /sidebar Name is unavailable/
  );
  assert.equal(resolveCount, 0);
});

test("Message Agent pool stages seventeen source images in the worker workspace and sends stable 8+8+1 batches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-image-batches-"));
  const workspace = path.join(root, "worker");
  fs.mkdirSync(workspace);
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({ ...options(path.join(root, "agents.json")), workspace }, {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: "019f0000-0000-7000-8000-000000000017", title: payload.title, cwd: workspace } };
      return { status: "delivered", delivery: { status: "delivered" } };
    }
  });
  const attachments = Array.from({ length: 17 }, (_, index) => {
    const imagePath = path.join(root, `source-${index + 1}.png`);
    fs.writeFileSync(imagePath, Buffer.from([index + 1]));
    return { id: `message:image:${index + 1}`, path: imagePath };
  });

  await deliver(pool, group("g17"), "正文只发一次", { requirementId: "requirement-17", imageAttachments: attachments });

  const sends = calls.filter((call) => call.action === "send");
  assert.deepEqual(sends.map((call) => call.imagePaths.length), [8, 8, 1]);
  assert.match(deliveryPayloadText(sends[0]), /正文只发一次/);
  assert.doesNotMatch(deliveryPayloadText(sends[1]), /正文只发一次/);
  assert.deepEqual(sends.map((call) => call.messageDelivery?.batchIndex), [1, 2, 3]);
  assert.ok(sends.every((call) => call.messageDelivery?.batchCount === 3));
  assert.ok(sends.flatMap((call) => call.imagePaths).every((imagePath: string) => imagePath.startsWith(workspace + path.sep)));

  calls.length = 0;
  await deliver(pool, group("g17"), "正文只发一次", { requirementId: "requirement-17", imageAttachments: attachments });
  assert.equal(calls.filter((call) => call.action === "send").length, 0);
});

test("Message Agent pool sends the body once with explicit attachment recovery guidance when staging fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-image-fallback-"));
  const workspace = path.join(root, "worker");
  fs.mkdirSync(workspace);
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({ ...options(path.join(root, "agents.json")), workspace }, {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: "019f0000-0000-7000-8000-000000000018", title: payload.title, cwd: workspace } };
      return { status: "delivered", delivery: { status: "delivered" } };
    }
  });

  await deliver(pool, group("gfallback"), "请判断图片中的问题", {
    requirementId: "requirement-fallback",
    imageAttachments: [{ id: "message:image:missing", path: path.join(root, "missing.png") }]
  });

  const sends = calls.filter((call) => call.action === "send");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]?.imagePaths, []);
  assert.match(deliveryPayloadText(sends[0]), /message:image:missing/);
  assert.match(deliveryPayloadText(sends[0]), /等待附件恢复或交接/);
  assert.match(deliveryPayloadText(sends[0]), /不得推断内容/);
});

test("direct replies default to a visible acknowledgement even when no plan changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-explicit-reply-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000011", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("direct-reply", {
    items: [{
      identity: "direct-reply-m1",
      receivedAt: 1,
      incomplete: false,
      payload: { routeKind: "direct_reply", record: { rawMessage: "我先搭效果，你之后再关联。" }, extraValues: {} }
    }]
  }), "[消息组 direct-reply]\n我先搭效果，你之后再关联。");

  const prompt = deliveryPayloadText(calls.find((call) => call.action === "send"));
  assert.match(prompt, /明确 @、回复和私聊默认需要回应/);
  assert.match(prompt, /明确 @、回复和私聊默认需要回应/);
  assert.match(prompt, /结束语、重复、自身消息/);
});

test("Message Agent initialization resolves the current Primary Persona displayed Name by complete task id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-primary-title-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({
    ...options(path.join(root, "agents.json")),
    sourceThreadName: "“星海建造师 策划 程序” 这个会话宕机了？"
  }, {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read" && payload.threadId === options(path.join(root, "unused.json")).sourceThreadId) {
        return { thread: { id: payload.threadId, name: "星海建造师 策划 程序", title: "“星海建造师 策划 程序” 这个会话宕机了？", cwd: process.cwd(), status: { type: "idle" }, active: false } };
      }
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000012", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("current-primary-title"), "检查名称");

  const prompt = deliveryPayloadText(calls.find((call) => call.action === "send"));
  assert.match(prompt, /主人格任务：星海建造师 策划 程序/);
  assert.match(prompt, /当前主人格任务：星海建造师 策划 程序/);
  assert.doesNotMatch(prompt, /这个会话宕机了/);
});

test("Message Agent pool refuses to initialize inside the Primary Persona task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-role-crossover-"));
  const primaryThreadId = options(path.join(root, "agents.json")).sourceThreadId;
  let sendCount = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { id: primaryThreadId, title: "星海建造师 策划 程序", cwd: process.cwd(), status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: primaryThreadId, title: payload.title, cwd: process.cwd() } };
      if (payload.action === "send") sendCount += 1;
      return {};
    }
  });

  await assert.rejects(deliver(pool, group("role-crossover"), "不得进入主人格"), /refusing role crossover/);
  assert.equal(sendCount, 0);
  assert.equal(pool.snapshot().workers.length, 0);
});

test("heartbeat Message Agent performs the omission scan itself and does not forward the scheduled task to the Primary Persona", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-heartbeat-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000011", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("heartbeat-group", {
    baseKey: "heartbeat|main",
    endpoint: "heartbeat",
    conversationKey: "heartbeat:gateway:XinghaiBuilder-main:heartbeat:heartbeat",
    sender: "RabiRoute 定时触发",
    items: [{
      identity: "heartbeat-message",
      receivedAt: 1,
      incomplete: false,
      payload: {
        routeKind: "heartbeat",
        record: { rawMessage: "检查工作群遗漏与计划登记" },
        extraValues: {}
      }
    }]
  }), "[heartbeat 巡检]");

  const prompt = deliveryPayloadText(calls.find((call) => call.action === "send"));
  assert.match(prompt, /按游标增量比对群消息/);
  assert.match(prompt, /按游标增量比对群消息、计划、问题映射和回执/);
  assert.match(prompt, /项目事实缺失/);
  assert.match(prompt, /criticalFactDisposition/);
  assert.match(prompt, /需要决定、跨计划冲突或已有可发送正文时才交给主人格/);
  assert.match(prompt, /没有遗漏或新进展时写/);
});

test("repeated heartbeat ticks always reuse the existing heartbeat worker even while it is active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-heartbeat-reuse-"));
  let created = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return {
          thread: {
            id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`,
            title: payload.title,
            cwd: process.cwd()
          }
        };
      }
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });
  const heartbeat = (groupId: string) => group(groupId, {
    baseKey: "heartbeat|main",
    endpoint: "heartbeat",
    conversationKey: "heartbeat:gateway:XinghaiBuilder-main:heartbeat:heartbeat",
    sender: "RabiRoute 定时触发"
  });

  const first = await deliver(pool, heartbeat("heartbeat-one"), "first tick");
  const second = await deliver(pool, heartbeat("heartbeat-two"), "second tick");

  assert.equal(created, 1);
  assert.equal(second.threadId, first.threadId);
  assert.deepEqual(sent, [first.threadId, first.threadId]);
});

test("Message Agent pool reuses an idle familiar worker but creates another when it is busy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-affinity-"));
  const statePath = path.join(root, "agents.json");
  let created = 0;
  let active = false;
  const sends: string[] = [];
  const prompts: string[] = [];
  const resolvedTitles: string[] = [];
  const renameCalls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        resolvedTitles.push(String(payload.title));
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "rename") {
        renameCalls.push(payload);
        return { thread: { id: payload.threadId, title: payload.title, cwd: payload.cwd } };
      }
      if (payload.action === "read") return { thread: { active } };
      if (payload.action === "send") {
        sends.push(String(payload.threadId));
        prompts.push(deliveryPayloadText(payload));
      }
      return {};
    }
  });

  const first = await deliver(pool, group("g1"), "first");
  const second = await deliver(pool, group("g2"), "second");
  assert.equal(second.threadId, first.threadId);
  active = true;
  const third = await deliver(pool, group("g3"), "third");
  assert.notEqual(third.threadId, first.threadId);
  assert.equal(created, 2);
  assert.deepEqual(resolvedTitles, [
    "星海建造师 策划 程序 协助处理消息",
    "星海建造师 策划 程序 协助处理消息2"
  ]);
  assert.deepEqual(renameCalls, [{
    action: "rename",
    agentAdapter: "codex",
    threadId: first.threadId,
    title: "星海建造师 策划 程序 协助处理消息1",
    cwd: process.cwd()
  }]);
  assert.equal(pool.snapshot().workers[0]?.threadName, "星海建造师 策划 程序 协助处理消息1");
  assert.equal(sends.length, 3);
  assert.match(prompts[2], /\[接续判断\]/);
  assert.match(prompts[2], new RegExp(first.threadId));
  assert.match(prompts[2], /正在处理的内容：\nhi/);
  assert.match(prompts[2], /POST http:\/\/127\.0\.0\.1:8790\/api\/agent\/threads/);
  assert.match(prompts[2], new RegExp(`sourceThreadId=${third.threadId}`));
  assert.match(prompts[2], /sourceAgentType=message_processing/);
  assert.match(prompts[2], /不得复制 \[rabi:bind\]/);
  assert.doesNotMatch(prompts[2], /prompt=本消息组完整内容/);
});

test("Message Agent pool reuses an idle unfamiliar worker before creating another task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-idle-unfamiliar-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000021";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [{
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:01.000Z",
      affinities: [{
        groupId: "old-heartbeat",
        endpoint: "heartbeat",
        conversationKey: "heartbeat:main",
        sender: "timer",
        lastUsedAt: "2026-08-04T06:00:00.000Z"
      }]
    }]
  }), "utf8");
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { active: false } };
      if (payload.action === "send") return {};
      if (payload.action === "resolve") throw new Error("must reuse the idle worker");
      return {};
    }
  });

  const selected = await deliver(pool, group("new-chat", {
    endpoint: "napcat",
    conversationKey: "napcat:group:200",
    sender: "new-speaker"
  }), "new chat");

  assert.equal(selected.threadId, threadId);
  assert.equal(calls.some((call) => call.action === "resolve"), false);
});

test("Message Agent pool with a limit of one keeps task 1 and reuses it while active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-limit-one-"));
  const statePath = path.join(root, "agents.json");
  const firstThreadId = "019f0000-0000-7000-8000-000000000081";
  const secondThreadId = "019f0000-0000-7000-8000-000000000082";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-12T06:00:00.000Z",
    workers: [
      {
        threadId: firstThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息1",
        workspace: process.cwd(),
        index: 1,
        createdAt: "2026-08-04T06:00:00.000Z",
        initializedAt: "2026-08-04T06:00:01.000Z"
      },
      {
        threadId: secondThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息2",
        workspace: process.cwd(),
        index: 2,
        createdAt: "2026-08-04T06:05:00.000Z",
        initializedAt: "2026-08-04T06:05:01.000Z"
      }
    ]
  }), "utf8");
  let resolveCount = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool({ ...options(statePath), maxAgents: 1 }, {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "resolve") resolveCount += 1;
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  const first = await deliver(pool, group("limited-one"), "one");
  const second = await deliver(pool, group("limited-two", { conversationKey: "napcat:group:two" }), "two");

  assert.equal(first.threadId, firstThreadId);
  assert.equal(second.threadId, firstThreadId);
  assert.equal(first.threadName, "星海建造师 策划 程序 协助处理消息1");
  assert.equal(resolveCount, 0);
  assert.deepEqual(sent, [firstThreadId, firstThreadId]);
  assert.deepEqual(pool.snapshot().workers.map((worker) => worker.threadId), [firstThreadId]);
});

test("Message Agent pool creates a numbered task 1 when its configured limit is one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-limit-one-create-"));
  const resolvedTitles: string[] = [];
  const pool = new MessageAgentPool({ ...options(path.join(root, "agents.json")), maxAgents: 1 }, {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        resolvedTitles.push(String(payload.title));
        return { thread: { id: "019f0000-0000-7000-8000-000000000083", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("limited-create"), "create");

  assert.deepEqual(resolvedTitles, ["星海建造师 策划 程序 协助处理消息1"]);
});

test("historical message-processing follow-ups move to the surviving current pool worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-current-worker-"));
  const statePath = path.join(root, "agents.json");
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-13T03:00:00.000Z",
    workers: [{
      threadId: "current-worker-1",
      threadName: "星海建造师 策划 程序 协助处理消息1",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:01.000Z"
    }]
  }), "utf8");

  assert.deepEqual(resolveCurrentMessageAgentWorker(statePath, {
    threadId: "archived-worker-3",
    threadName: "星海建造师 策划 程序 协助处理消息3",
    workspace: process.cwd()
  }), {
    threadId: "current-worker-1",
    threadName: "星海建造师 策划 程序 协助处理消息1",
    workspace: process.cwd()
  });
});

test("a Manager-owned replacement updates the persisted Message Agent worker and affinity id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-manager-replacement-"));
  const statePath = path.join(root, "agents.json");
  const affinityPath = path.join(root, "routing-affinity.json");
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-18T01:00:00.000Z",
    workers: [{
      threadId: "old-worker",
      threadName: "消息1",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-17T01:00:00.000Z",
      initializedAt: "2026-08-17T01:00:01.000Z"
    }]
  }), "utf8");
  fs.writeFileSync(affinityPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-18T01:00:00.000Z",
    workers: [{
      threadId: "old-worker",
      affinities: [{
        groupId: "group-1",
        endpoint: "napcat",
        conversationKey: "napcat:group:1",
        sender: "1",
        lastUsedAt: "2026-08-18T01:00:00.000Z"
      }]
    }]
  }), "utf8");

  assert.equal(replacePersistedMessageAgentWorker(statePath, "old-worker", {
    threadId: "new-worker",
    threadName: "消息1",
    workspace: process.cwd()
  }, new Date("2026-08-18T02:00:00.000Z")), true);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as MessageAgentPoolState;
  assert.equal(state.workers[0]?.threadId, "new-worker");
  assert.equal(state.workers[0]?.initializedAt, undefined);
  const affinity = JSON.parse(fs.readFileSync(affinityPath, "utf8")) as { workers: Array<{ threadId: string; affinities: unknown[] }> };
  assert.equal(affinity.workers[0]?.threadId, "new-worker");
  assert.equal(affinity.workers[0]?.affinities.length, 1);
});

test("Message Agent pool replaces an archived worker and persists the new task id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-archived-worker-"));
  const statePath = path.join(root, "agents.json");
  const archivedThreadId = "019f0000-0000-7000-8000-000000000107";
  const replacementThreadId = "019f0000-0000-7000-8000-000000000108";
  const threadName = "星海建造师 策划 程序 协助处理消息";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-18T01:00:00.000Z",
    workers: [{
      threadId: archivedThreadId,
      threadName,
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-17T01:00:00.000Z",
      initializedAt: "2026-08-17T01:00:01.000Z"
    }]
  }), "utf8");
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "read") {
        if (payload.threadId === archivedThreadId) {
          return { thread: { id: archivedThreadId, title: threadName, cwd: process.cwd(), archived: true } };
        }
        return { thread: { id: replacementThreadId, title: threadName, cwd: process.cwd(), status: { type: "idle" } } };
      }
      if (payload.action === "resolve") {
        assert.equal(payload.threadId, archivedThreadId);
        assert.equal(payload.title, threadName);
        return {
          resolution: "created",
          previousThreadId: archivedThreadId,
          thread: { id: replacementThreadId, title: threadName, cwd: process.cwd() }
        };
      }
      if (payload.action === "send") {
        sent.push(String(payload.threadId));
        return {
          resolution: "id",
          threadId: replacementThreadId,
          thread: { id: replacementThreadId, title: threadName, cwd: process.cwd() }
        };
      }
      return {};
    }
  });

  const worker = await deliver(pool, group("archived-worker-replacement"), "继续处理");

  assert.equal(worker.threadId, replacementThreadId);
  assert.equal(worker.initializedAt != null, true);
  assert.deepEqual(sent, [replacementThreadId]);
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as MessageAgentPoolState;
  assert.equal(persisted.workers[0]?.threadId, replacementThreadId);
});

test("Message Agent list, cap, and delivery use the same weighted order", () => {
  const groupContext = group("current-group", {
    endpoint: "napcat",
    conversationKey: "napcat:group:100",
    sender: "42",
    replyToMessageId: "quoted-message"
  });
  const workers = [
    {
      threadId: "worker-1",
      threadName: "消息1",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T00:00:00.000Z",
      affinities: []
    },
    {
      threadId: "worker-2",
      threadName: "消息2",
      workspace: process.cwd(),
      index: 2,
      createdAt: "2026-08-04T00:01:00.000Z",
      affinities: [{
        groupId: "older-group",
        endpoint: "napcat",
        conversationKey: "napcat:group:100",
        sender: "42",
        lastUsedAt: "2026-08-13T05:00:00.000Z"
      }]
    }
  ];

  assert.deepEqual(rankMessageAgentWorkers(workers, groupContext).map((worker) => worker.threadId), ["worker-2", "worker-1"]);
  assert.deepEqual(rankMessageAgentWorkers(workers, groupContext, {
    referencedSenders: [{ agentType: "message_processing", sessionId: "worker-1" }]
  }).map((worker) => worker.threadId), ["worker-1", "worker-2"]);
});

test("Message Agent prompt forces schedule decisions to be verified and recorded before closure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-critical-fact-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000031", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await deliver(pool, group("critical-schedule", {
    items: [{
      identity: "critical-schedule-message",
      receivedAt: 1,
      incomplete: false,
      payload: {
        routeKind: "group_message",
        record: { messageId: "msg-schedule-1", rawMessage: "示例项目暂以2030年10月15日为内部上线目标，尚未正式定档" },
        extraValues: {}
      }
    }]
  }), "critical schedule");

  const prompt = deliveryPayloadText(calls.find((call) => call.action === "send"));
  assert.match(prompt, /项目事实判断由 Agent 负责/);
  assert.match(prompt, /Manager 的召回结果只算候选/);
  assert.match(prompt, /projectFactAssessment/);
  assert.match(prompt, /criticalFactDisposition/);
  assert.match(prompt, /回答排期、版本、负责人或审批状态前/);
  assert.match(prompt, /核对本群最新消息和已登记事实/);
});

test("Message Agent pool loads an existing notLoaded task instead of creating another one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-not-loaded-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000023";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [{
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:01.000Z"
    }]
  }), "utf8");
  let createCount = 0;
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "notLoaded" }, active: false } };
      if (payload.action === "resolve") createCount += 1;
      return {};
    }
  });

  const selected = await deliver(pool, group("resume-existing"), "resume");

  assert.equal(selected.threadId, threadId);
  assert.equal(createCount, 0);
});

test("Message Agent pool keeps the message pending when Codex Desktop is unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-offline-"));
  let createCount = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "unavailable" }, active: false } };
      if (payload.action === "resolve") createCount += 1;
      return {};
    }
  });

  await assert.rejects(
    deliver(pool, group("desktop-offline"), "wait"),
    /消息组已保留等待恢复/
  );
  assert.equal(createCount, 0);
  assert.equal(pool.snapshot().workers.length, 0);
});

test("Message Agent pool merges duplicate persisted rows for the same Desktop task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-dedupe-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000022";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: ["one", "two"].map((groupId, offset) => ({
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息1",
      workspace: process.cwd(),
      index: 1,
      createdAt: `2026-08-04T06:00:0${offset}.000Z`,
      initializedAt: "2026-08-04T06:00:02.000Z",
      affinities: [{
        groupId,
        endpoint: "napcat",
        conversationKey: `napcat:group:${offset}`,
        sender: `sender-${offset}`,
        lastUsedAt: `2026-08-04T06:00:0${offset}.000Z`
      }]
    }))
  }), "utf8");

  const pool = new MessageAgentPool(options(statePath));
  const snapshot = pool.snapshot();
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.workers[0]?.threadId, threadId);
  assert.deepEqual(pool.affinitySnapshot().workers[0]?.affinities.map((item) => item.groupId).sort(), ["one", "two"]);
  const persistedAgents = JSON.parse(fs.readFileSync(statePath, "utf8")) as { schemaVersion: number; workers: Array<Record<string, unknown>> };
  assert.equal(persistedAgents.schemaVersion, 2);
  assert.equal("affinities" in persistedAgents.workers[0]!, false);
  const persistedAffinity = JSON.parse(fs.readFileSync(path.join(root, "routing-affinity.json"), "utf8")) as {
    workers: Array<{ threadId: string; affinities: Array<{ groupId: string }> }>;
  };
  assert.deepEqual(persistedAffinity.workers[0]?.affinities.map((item) => item.groupId).sort(), ["one", "two"]);
});

test("concurrent Message Agent allocation never records duplicate rows for one task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-concurrent-"));
  const statePath = path.join(root, "agents.json");
  let resolveCount = 0;
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        const current = ++resolveCount;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          thread: {
            id: `019f0000-0000-7000-8000-${String(current).padStart(12, "0")}`,
            title: payload.title,
            cwd: process.cwd()
          }
        };
      }
      if (payload.action === "read") return { thread: { active: true } };
      return {};
    }
  });

  await Promise.all([
    deliver(pool, group("parallel-one", { conversationKey: "napcat:group:one" }), "one"),
    deliver(pool, group("parallel-two", { conversationKey: "napcat:group:two" }), "two")
  ]);

  const workers = pool.snapshot().workers;
  assert.equal(workers.length, 2);
  assert.equal(new Set(workers.map((worker) => worker.threadId)).size, 2);
  assert.deepEqual(workers.map((worker) => worker.index), [1, 2]);
});

test("Message Agent pool renames existing workers to stable persona-owned titles without changing task ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-rename-"));
  const statePath = path.join(root, "agents.json");
  const rolePath = path.join(root, "persona.md");
  fs.writeFileSync(rolePath, "# 星海建造师 策划 程序\n\n人格正文。\n", "utf8");
  const workspace = process.cwd();
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [1, 2].map((index) => ({
      threadId: `019f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      threadName: `“星海建造师 策划 程序” 这个会话宕机了？ 消息处理 ${index}`,
      workspace,
      index,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:00.000Z",
      affinities: index === 1 ? [{
        groupId: "known",
        endpoint: "napcat",
        conversationKey: "napcat:group:100",
        sender: "200",
        lastUsedAt: "2026-08-04T06:00:00.000Z"
      }] : []
    }))
  }), "utf8");
  const renameCalls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({
    ...options(statePath),
    sourceThreadName: "“星海建造师 策划 程序” 这个会话宕机了？",
    roleDisplayName: undefined,
    rolePath
  }, {
    request: async (payload) => {
      if (payload.action === "rename") renameCalls.push(payload);
      if (payload.action === "read") return { thread: { active: false } };
      return {};
    }
  });

  await deliver(pool, group("known"), "继续处理");

  assert.deepEqual(renameCalls.map((call) => ({
    threadId: call.threadId,
    title: call.title,
    cwd: call.cwd
  })), [
    {
      threadId: "019f0000-0000-7000-8000-000000000001",
      title: "星海建造师 策划 程序 协助处理消息1",
      cwd: workspace
    },
    {
      threadId: "019f0000-0000-7000-8000-000000000002",
      title: "星海建造师 策划 程序 协助处理消息2",
      cwd: workspace
    }
  ]);
  assert.deepEqual(pool.snapshot().workers.map((worker) => ({
    threadId: worker.threadId,
    threadName: worker.threadName
  })), [
    {
      threadId: "019f0000-0000-7000-8000-000000000001",
      threadName: "星海建造师 策划 程序 协助处理消息1"
    },
    {
      threadId: "019f0000-0000-7000-8000-000000000002",
      threadName: "星海建造师 策划 程序 协助处理消息2"
    }
  ]);
});

test("Message Agent affinity has no short topic timeout and keeps a bounded preview for later continuation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-later-"));
  let created = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    now: () => new Date("2026-08-04T06:30:00.000Z"),
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: false } };
      return {};
    }
  });

  const earlier = group("earlier", {
    createdAt: Date.parse("2026-08-04T06:00:00.000Z"),
    items: [{ identity: "earlier-m1", receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { messageId: "m-old", rawMessage: "旧话题内容" }, extraValues: {} } }]
  });
  const first = await deliver(pool, earlier, "earlier");
  const later = await deliver(pool, group("later"), "later");

  assert.equal(later.threadId, first.threadId);
  assert.equal(created, 1);
  const affinity = pool.affinitySnapshot().workers[0]?.affinities.find((item) => item.groupId === "earlier");
  assert.equal(affinity?.preview, "旧话题内容");
  assert.deepEqual(affinity?.messageIds, ["m-old"]);
});

test("the exact same message group always supplements its original active worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-supplement-"));
  let created = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  await deliver(pool, group("same"), "first");
  await deliver(pool, group("same"), "supplement");
  assert.equal(created, 1);
  assert.equal(sent[0], sent[1]);
});

test("an explicit reply to an older source message returns to its original active Message Agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-explicit-reply-"));
  let created = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: true } };
      return {};
    }
  });

  const first = await deliver(pool, group("old", {
    items: [{ identity: "old-m1", receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { messageId: "source-old", rawMessage: "半小时前的消息" }, extraValues: {} } }]
  }), "old");
  const reply = await deliver(pool, group("new", {
    sender: "another-speaker",
    replyToMessageId: "source-old"
  }), "reply");

  assert.equal(reply.threadId, first.threadId);
  assert.equal(created, 1);
});

test("a reply to an Agent-sent message boosts that exact Message Agent session in the ranking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-reply-sender-"));
  const statePath = path.join(root, "agents.json");
  const familiarThreadId = "019f0000-0000-7000-8000-000000000071";
  const referencedThreadId = "019f0000-0000-7000-8000-000000000072";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-11T08:00:00.000Z",
    workers: [
      {
        threadId: familiarThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息1",
        workspace: process.cwd(),
        index: 1,
        createdAt: "2026-08-11T07:00:00.000Z",
        initializedAt: "2026-08-11T07:00:01.000Z",
        affinities: [{
          groupId: "familiar-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:100",
          sender: "200",
          lastUsedAt: "2026-08-11T07:30:00.000Z"
        }]
      },
      {
        threadId: referencedThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息2",
        workspace: process.cwd(),
        index: 2,
        createdAt: "2026-08-11T07:05:00.000Z",
        initializedAt: "2026-08-11T07:05:01.000Z",
        affinities: [{
          groupId: "other-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:999",
          sender: "999",
          lastUsedAt: "2026-08-11T07:20:00.000Z"
        }]
      }
    ]
  }), "utf8");
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "idle" } } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  const selected = await deliver(pool, group("reply-to-agent", {
    replyToMessageId: "qq-outbound-7788"
  }), "reply to Agent", {
    referencedSenders: [{
      deliveryId: "delivery-7788",
      agentType: "message_processing",
      sessionId: referencedThreadId
    }]
  });

  assert.equal(selected.threadId, referencedThreadId);
  assert.deepEqual(sent, [referencedThreadId]);
});

test("DSH Message Agent creates once, persists its owner, and reuses the same session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-dsh-"));
  const statePath = path.join(root, "agents.json");
  const calls: Array<Record<string, any>> = [];
  const dshOptions = {
    ...options(statePath),
    agentAdapter: "dsh" as const,
    sourceThreadId: "session-00000000-0000-4000-8000-000000000001"
  };
  const pool = new MessageAgentPool(dshOptions, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      assert.notEqual(payload.agentAdapter, "codex");
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return {
        thread: {
          id: "session-00000000-0000-4000-8000-000000000002",
          title: payload.title,
          cwd: process.cwd()
        }
      };
      if (payload.action === "send") return { status: "delivered" };
      throw new Error(`Unexpected action: ${String(payload.action)}`);
    }
  });

  const first = await deliver(pool, group("dsh-g1"), "first");
  const second = await deliver(pool, group("dsh-g2"), "second");

  assert.equal(first.agentAdapter, "dsh");
  assert.equal(second.threadId, first.threadId);
  assert.equal(calls.filter((call) => call.action === "resolve").length, 1);
  assert.equal(calls.filter((call) => call.action === "send").length, 2);
  assert.ok(calls.filter((call) => call.action === "send").every((call) => call.agentAdapter === "dsh"));
  assert.equal(readCurrentMessageAgentWorkers(statePath)[0]?.agentAdapter, "dsh");
});
