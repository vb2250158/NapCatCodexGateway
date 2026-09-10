import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentThreadDeliveryStateForTest,
  agentThreadRequestFailureData,
  handleAgentThreadRequest,
  listAgentThreadsFromIndexForTest,
  validateAgentThreadHandoffPromptForTest,
  type AgentThreadDriver
} from "./agentThreads.js";
import { listCodexDesktopThreadsFromRowsForTest } from "./codexDesktopBridge.js";
import { proactiveCommunicationPolicyLines } from "./shared/agentCommunicationPolicy.js";
import { recoverAgentResponseDelivery } from "./agentRequests/deliveryRecovery.js";
import { AgentRequestStore, type AgentRequestPersistence } from "./agentRequests/store.js";
import { codexThreadCreationReservationPathForTest } from "./codexThreadCreationReservations.js";
import { canonicalCodexWorkspacePath } from "./codexTaskIdentity.js";

class MemoryAgentRequestPersistence implements AgentRequestPersistence {
  value: unknown;
  read(): unknown { return this.value; }
  write(state: unknown): void { this.value = structuredClone(state); }
}

const defaultMessageSource = {
  type: "agent" as const,
  agentAdapter: "codex" as const,
  sessionId: "019f0000-0000-7000-8000-000000000001",
  sessionName: "测试来源任务"
};

const defaultSystemMessageSource = {
  type: "system" as const,
  eventType: "test",
  eventName: "测试投递",
  eventId: "agent-thread-test"
};

function messageSourceFor(sessionId: string, sessionName = "测试来源任务") {
  return {
    type: "agent" as const,
    agentAdapter: "codex" as const,
    sessionId,
    sessionName
  };
}

test("Codex rollout receipt makes delivery readback accepted when normal task read omits the marker", () => {
  const deliveryId = "12345678-1234-4567-8123-123456789abc";
  assert.equal(agentThreadDeliveryStateForTest({ active: false, turns: [] }, deliveryId, true), "accepted");
  assert.equal(agentThreadDeliveryStateForTest({ active: false, turns: [] }, deliveryId, false), "missing");
});

test("Agent task read reports an exact delivery marker without treating idle as accepted", async () => {
  const deliveryId = "12345678-1234-4567-8123-123456789abc";
  const baseDriver: AgentThreadDriver = {
    read: async () => ({ active: false, turns: [{ items: [{ type: "userMessage", content: [{ text: `本批投递 deliveryId：${deliveryId}` }] }] }] }),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };
  const threadId = "019f0000-0000-7000-8000-000000000001";
  const accepted = await handleAgentThreadRequest({ action: "read", threadId, deliveryId }, {
    allowedWorkspaces: [process.cwd()]
  }, baseDriver);
  assert.deepEqual(accepted.data.delivery, { deliveryId, state: "accepted" });

  const missing = await handleAgentThreadRequest({ action: "read", threadId, deliveryId }, {
    allowedWorkspaces: [process.cwd()]
  }, { ...baseDriver, read: async () => ({ active: false, turns: [] }) });
  assert.deepEqual(missing.data.delivery, { deliveryId, state: "missing" });
});

test("delivery readback does not accept IDs quoted by an assistant or stored in metadata", () => {
  const deliveryId = "12345678-1234-4567-8123-123456789abc";
  assert.equal(agentThreadDeliveryStateForTest({ active: false, title: deliveryId,
    turns: [{ items: [{ type: "agentMessage", content: [{ text: `本批投递 deliveryId：${deliveryId}` }] }] }] }, deliveryId), "missing");
});

test("Agent thread list deduplicates session index entries and filters by title", () => {
  const result = listAgentThreadsFromIndexForTest([
    JSON.stringify({ id: "thread-1", thread_name: "旧标题", updated_at: "2026-07-12T00:00:00Z" }),
    JSON.stringify({ id: "thread-1", thread_name: "[Example][Bug] 功能入口", updated_at: "2026-07-13T00:00:00Z" }),
    JSON.stringify({ id: "thread-2", thread_name: "其它任务", updated_at: "2026-07-13T01:00:00Z" })
  ].join("\n"), "功能入口", 20);

  assert.deepEqual(result, [{
    id: "thread-1",
    title: "[Example][Bug] 功能入口",
    updatedAt: "2026-07-13T00:00:00Z"
  }]);
});

test("Agent task list delegates to the Desktop-backed driver within configured workspaces", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [{ id: "thread-1", title: "调查任务", updatedAt: "2026-07-15T00:00:00Z" }];
    },
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "list",
    query: "调查",
    limit: 5
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.deepEqual(calls, [{ query: "调查", limit: 6, offset: 0, allowedWorkspaces: [process.cwd()] }]);
  assert.deepEqual(result.data.threads, [
    { id: "thread-1", title: "调查任务", updatedAt: "2026-07-15T00:00:00Z" }
  ]);
});

test("Agent task list exposes every page instead of hiding tasks after a fixed cap", async () => {
  const driver: AgentThreadDriver = {
    list: async ({ offset, limit }) => Array.from({ length: limit }, (_, index) => ({
      id: `thread-${offset + index}`,
      title: `任务 ${offset + index}`,
      updatedAt: "2026-07-15T00:00:00Z"
    })),
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({ action: "list", limit: 100, offset: 100 }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal((result.data.threads as unknown[]).length, 100);
  assert.equal(result.data.nextOffset, 200);
});

test("Agent task resolver binds an existing Desktop task by exact id independently of its saved cwd", async () => {
  const calls: string[] = [];
  const driver: AgentThreadDriver = {
    list: async () => { calls.push("list"); return []; },
    read: async (threadId) => ({
      id: threadId,
      title: "[RabiRoute 事件] Desktop 自动写入的首条消息",
      cwd: path.dirname(process.cwd()),
      updatedAt: "2026-07-15T00:00:00Z"
    }),
    create: async () => { calls.push("create"); throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: "019f0000-0000-7000-8000-000000000010",
    title: "RabiLink",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "id");
  assert.deepEqual(calls, []);
});

test("Agent task continuation keeps the requested workspace for an exact existing task", async () => {
  const threadId = "019f0000-0000-7000-8000-000000000011";
  const sent: Array<{ threadId: string; cwd: string }> = [];
  const driver: AgentThreadDriver = {
    list: async () => { throw new Error("must not list"); },
    read: async () => ({
      id: threadId,
      title: "Existing task",
      cwd: path.dirname(process.cwd()),
      updatedAt: "2026-07-15T00:00:00Z"
    }),
    create: async () => { throw new Error("must not create"); },
    send: async (params) => { sent.push({ threadId: params.threadId, cwd: params.cwd }); }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId,
    title: "Existing task",
    prompt: "Continue in the configured workspace",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 202);
  assert.deepEqual(sent, [{ threadId, cwd: path.resolve(process.cwd()) }]);
});

test("Agent task resolver keeps a valid saved id even when the display title exceeds the create limit", async () => {
  const threadId = "019f0000-0000-7000-8000-000000000045";
  const longDisplayTitle = "很长的 Desktop 展示标题".repeat(30);
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => { throw new Error("must not list"); },
    read: async () => ({
      id: threadId,
      title: longDisplayTitle,
      cwd: process.cwd(),
      updatedAt: "2026-07-22T00:00:00Z"
    }),
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId,
    title: longDisplayTitle,
    cwd: process.cwd(),
    createIfMissing: true
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "id");
  assert.equal((result.data.thread as { id: string }).id, threadId);
  assert.equal(createCount, 0);
});

test("Agent task resolver migrates a route name stored in the id field and finds by name", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [{
        id: "019f0000-0000-7000-8000-000000000011",
        title: "RabiLink",
        cwd: process.cwd(),
        updatedAt: "2026-07-15T00:00:00Z"
      }];
    },
    read: async () => { throw new Error("must not read an invalid id"); },
    create: async () => { throw new Error("must not create"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: "RabiLink",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.data.resolution, "name");
  assert.deepEqual(calls, [{
    query: "RabiLink",
    limit: 10_000,
    offset: 0,
    allowedWorkspaces: [path.resolve(process.cwd())]
  }]);
});

test("Agent task resolver creates only when no exact name exists", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      calls.push(params);
      return {
        id: "019f0000-0000-7000-8000-000000000012",
        title: params.title,
        updatedAt: "2026-07-15T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title: "新会话",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal(result.data.resolution, "created");
  assert.equal(calls.length, 1);
});

test("Agent task resolver truncates an overlong new task title before create", async () => {
  const requestedTitle = `${"新任务😀".repeat(60)}结尾`;
  let createdTitle = "";
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createdTitle = params.title;
      return {
        id: "019f0000-0000-7000-8000-000000000046",
        title: params.title,
        updatedAt: "2026-07-22T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title: requestedTitle,
    cwd: process.cwd(),
    createIfMissing: true
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 201);
  assert.ok(createdTitle.length <= 240);
  assert.equal(createdTitle.endsWith("\ud800"), false);
  assert.equal(createdTitle.endsWith("\udbff"), false);
  assert.equal((result.data.thread as { title: string }).title, createdTitle);
});

test("Agent task resolver creates one task when repeated requests arrive before Desktop indexing catches up", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    // Reproduce the real boundary: thread/start has returned, but the Desktop
    // read model queried by list has not exposed the new task yet.
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        id: `019f0000-0000-7000-8000-${String(createCount).padStart(12, "0")}`,
        title: params.title,
        updatedAt: "2026-07-16T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };
  const request = {
    action: "resolve" as const,
    title: "Rabi",
    cwd: process.cwd(),
    createIfMissing: true
  };
  const options = { allowedWorkspaces: [process.cwd()] };

  const firstPair = await Promise.all([
    handleAgentThreadRequest(request, options, driver),
    handleAgentThreadRequest(request, options, driver)
  ]);
  const immediateRetry = await handleAgentThreadRequest(request, options, driver);

  assert.equal(createCount, 1);
  assert.equal((firstPair[0].data.thread as { id: string }).id, (firstPair[1].data.thread as { id: string }).id);
  assert.equal((firstPair[0].data.thread as { id: string }).id, (immediateRetry.data.thread as { id: string }).id);
});

test("Agent task resolver binds the most recently updated same-name task", async () => {
  const driver: AgentThreadDriver = {
    list: async () => [
      { id: "019f0000-0000-7000-8000-000000000014", title: "同名", updatedAt: "2026-07-15T00:00:00Z" },
      { id: "019f0000-0000-7000-8000-000000000013", title: "同名", updatedAt: "2026-07-15T01:00:00Z" }
    ],
    read: async () => ({}),
    create: async () => { throw new Error("must not create"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({ action: "resolve", title: "同名" }, {
    allowedWorkspaces: [process.cwd()],
    defaultWorkspace: process.cwd()
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, "019f0000-0000-7000-8000-000000000013");
});

test("Agent task resolver ignores archived duplicates during name lookup and binds the latest unarchived task", async () => {
  const title = "MonsterGirl / 伊莉娅 策划美术";
  const cwd = process.cwd();
  const archivedId = "019f0000-0000-7000-8000-000000000041";
  const olderId = "019f0000-0000-7000-8000-000000000042";
  const latestId = "019f0000-0000-7000-8000-000000000043";
  const rows = [
    { id: archivedId, title, cwd, archived: 1, updated_at_ms: 3_000 },
    { id: olderId, title, cwd, archived: 0, updated_at_ms: 1_000 },
    { id: latestId, title, cwd, archived: 0, updated_at_ms: 2_000 }
  ];
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ query, limit, offset, allowedWorkspaces }) => listCodexDesktopThreadsFromRowsForTest(rows, {
      query,
      limit,
      offset,
      allowedWorkspaces
    }),
    read: async (threadId) => listCodexDesktopThreadsFromRowsForTest(
      rows.filter((row) => row.id === threadId),
      { limit: 1 }
    )[0] ?? null,
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title,
    cwd,
    createIfMissing: true
  }, {
    allowedWorkspaces: [cwd],
    defaultWorkspace: cwd
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, latestId);
  assert.equal(createCount, 0);
});

test("Agent task resolver creates a replacement for an archived saved binding", async () => {
  const archived = {
    id: "019f0000-0000-7000-8000-000000000044",
    title: "已归档的固定任务",
    cwd: process.cwd(),
    updatedAt: "2026-07-18T04:00:00Z",
    archived: true
  };
  const replacement = {
    id: "019f0000-0000-7000-8000-000000000045",
    title: archived.title,
    cwd: archived.cwd,
    updatedAt: "2026-07-18T05:00:00Z",
    source: "test",
    initialTurnStatus: "not-requested" as const
  };
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => archived,
    create: async () => {
      createCount += 1;
      return replacement;
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: archived.id,
    title: archived.title,
    cwd: archived.cwd,
    createIfMissing: true
  }, {
    allowedWorkspaces: [archived.cwd]
  }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal(result.data.resolution, "created");
  assert.equal((result.data.thread as { id: string }).id, replacement.id);
  assert.equal(createCount, 1);
});

test("Agent thread create uses a configured workspace and fixed investigation instructions", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async (threadId) => ({
      id: threadId,
      title: "测试来源任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-20T00:00:00.000Z"
    }),
    create: async (params) => {
      calls.push(params);
      return {
        id: "019f0000-0000-7000-8000-000000000001",
        title: params.title,
        updatedAt: "2026-07-13T00:00:00Z",
        source: "Codex Desktop task owner",
        initialTurnStatus: "started"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "create",
    title: " [Example][Bug] 功能入口 ",
    prompt: " 只读调查功能入口。 ",
    cwd: process.cwd(),
    messageSource: messageSourceFor(defaultMessageSource.sessionId, "提交的旧名称"),
    sourceThreadId: defaultMessageSource.sessionId,
    sourceAgentType: "agent",
    sandbox: "danger-full-access"
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal(calls.length, 1);
  const createCall = calls[0] as Record<string, unknown>;
  assert.deepEqual({ ...createCall, prompt: undefined }, {
    title: "[Example][Bug] 功能入口",
    prompt: undefined,
    cwd: path.resolve(process.cwd()),
    developerInstructions: [
      "这是由 RabiRoute 会话管理层创建的独立 Codex 任务。",
      "严格按初始任务和用户后续消息处理，并遵守工作区中的 AGENTS.md 与任务明确引用的 Skill。",
      "运行沙箱权限不等于业务修改授权；没有明确授权时，只做读取、调查、证据整理和方案输出。",
      "开始工作前先读取当前任务的完整相关历史和已有结论，不得只看标题、摘要或最后一条消息。",
      ...proactiveCommunicationPolicyLines("internal"),
      "只在目标工作区执行，并遵守工作区 AGENTS.md。",
      "改动进入目标工作区并完成适用验证后，才能报告已修复或可验收。",
      "多步任务开始后要让当前任务中的人看得出你准备做什么；取得阶段结果、遇到风险或进入等待时主动更新，不要等别人追问。"
    ].join("\n"),
    sandbox: "danger-full-access"
  });
  assert.match(String(createCall.prompt), /^\[消息源\]\n类型：Agent｜处理端：codex\n会话：测试来源任务\n会话 ID：019f0000-0000-7000-8000-000000000001/);
  assert.match(String(createCall.prompt), /\[消息内容\]\n只读调查功能入口。/);
});

test("Agent thread create rejects workspaces outside configured Codex projects", async () => {
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      throw new Error("driver must not be called");
    },
    send: async () => undefined
  };

  await assert.rejects(
    handleAgentThreadRequest({
      action: "create",
      title: "任务",
      prompt: "调查",
      cwd: path.dirname(process.cwd()),
      messageSource: defaultSystemMessageSource
    }, {
      allowedWorkspaces: [process.cwd()]
    }, driver),
    /Workspace is not configured/
  );
});

test("Agent thread send starts a follow-up turn through the driver", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      throw new Error("not used");
    },
    send: async (params) => {
      calls.push(params);
    }
  };
  const threadId = "019f0000-0000-7000-8000-000000000002";

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "补充新证据",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 202);
  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string };
  assert.equal(sent.threadId, threadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.match(sent.prompt, /^\[消息源\]\n消息源类型：系统\n事件类型：test\n事件名称：测试投递\n事件 ID：agent-thread-test/);
  const deliveryId = String((result.data.delivery as Record<string, unknown>).deliveryId);
  assert.match(deliveryId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(sent.prompt.includes(`投递 ID：${deliveryId}`));
  assert.doesNotMatch(sent.prompt, /只使用正式 Main、Release 和 Art/);
  assert.match(sent.prompt, /\[消息内容\]\n补充新证据/);
});

test("Agent thread send delegates workspace restrictions to the target AGENTS.md", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-threads-"));
  const sampleWorkspace = path.join(tempRoot, "SampleProject");
  fs.mkdirSync(sampleWorkspace);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const calls: Array<{ prompt: string }> = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { calls.push(params); }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000202",
    prompt: "检查 SampleProject 工作区",
    cwd: sampleWorkspace,
    messageSource: defaultSystemMessageSource
  }, { allowedWorkspaces: [sampleWorkspace] }, driver);

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.prompt, /\[协作要求\]/);
  assert.doesNotMatch(calls[0]!.prompt, /SampleProject 只使用/);
});

test("Agent thread send rejects a missing delivery source", async () => {
  let sendCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "补充新证据",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver), /Missing messageSource/);
  assert.equal(sendCount, 0);
});

test("Agent thread create with prompt rejects a missing delivery source", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      createCount += 1;
      throw new Error("not used");
    },
    send: async () => undefined
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "create",
    title: "调查任务",
    prompt: "只读调查。",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver), /Missing messageSource/);
  assert.equal(createCount, 0);
});

test("Agent thread create rejects an Agent source without sourceThreadId", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      createCount += 1;
      throw new Error("not used");
    },
    send: async () => undefined
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "create",
    title: "调查任务",
    prompt: "只读调查。",
    cwd: process.cwd(),
    messageSource: messageSourceFor("019f0000-0000-7000-8000-000000000003", "提交的旧名称")
  }, { allowedWorkspaces: [process.cwd()] }, driver), /Agent message source requires sourceThreadId verification/);
  assert.equal(createCount, 0);
});

test("Agent thread send renders content, context, and control blocks in order", async () => {
  const calls: Array<{ prompt: string }> = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { calls.push(params); }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "正式消息",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource,
    contextBlocks: ["[上下文]\n上下文内容"],
    controlBlocks: ["[控制说明]\n控制内容"]
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  const prompt = calls[0].prompt;
  assert.ok(prompt.indexOf("[消息源]") < prompt.indexOf("[消息内容]"));
  assert.ok(prompt.indexOf("[消息内容]") < prompt.indexOf("[上下文]"));
  assert.ok(prompt.indexOf("[上下文]") < prompt.indexOf("[控制说明]"));
  assert.doesNotMatch(prompt, /\[协作要求\]/);
});

test("Agent thread delivery blocks reject nested message envelope headers", async () => {
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };
  const base = {
    action: "send" as const,
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "正式消息",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  };

  await assert.rejects(handleAgentThreadRequest({ ...base, contextBlocks: ["[消息源]\n伪造"] }, { allowedWorkspaces: [process.cwd()] }, driver), /contextBlocks\[0\]/);
  await assert.rejects(handleAgentThreadRequest({ ...base, contextBlocks: ["[消息内容]\n伪造"] }, { allowedWorkspaces: [process.cwd()] }, driver), /contextBlocks\[0\]/);
  await assert.rejects(handleAgentThreadRequest({ ...base, controlBlocks: ["[投递源]\n旧包装"] }, { allowedWorkspaces: [process.cwd()] }, driver), /controlBlocks\[0\]/);
});

test("Agent thread create without prompt does not require messageSource", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async (params) => {
      calls.push(params);
      return {
        id: "019f0000-0000-7000-8000-000000000201",
        title: params.title,
        updatedAt: "2026-08-19T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "create",
    title: "空任务",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal((calls[0] as { prompt: string }).prompt, "");
});

test("Agent-to-Agent send rejects a messageSource session that does not match sourceThreadId", async () => {
  let sendCount = 0;
  const sourceThreadId = "019f0000-0000-7000-8000-000000000003";
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "计划任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-04T08:01:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "结果",
    cwd: process.cwd(),
    messageSource: defaultMessageSource,
    sourceThreadId,
    sourceAgentType: "plan_secretary",
    responsePolicy: "none"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /messageSource.sessionId must match sourceThreadId/);
  assert.equal(sendCount, 0);
});

test("Agent thread send forwards validated workspace image paths to Desktop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-image-"));
  const imagePath = path.join(root, "message.png");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  let delivered: Parameters<AgentThreadDriver["send"]>[0] | undefined;
  const driver: AgentThreadDriver = {
    read: async () => ({ id: "thread-1", title: "消息处理", cwd: root }),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { delivered = params; }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000091",
    prompt: "查看图片",
    cwd: root,
    messageSource: defaultSystemMessageSource,
    imagePaths: [imagePath]
  }, { allowedWorkspaces: [root] }, driver);

  assert.deepEqual(delivered?.imagePaths, [imagePath]);
  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000091",
    prompt: "查看图片",
    cwd: root,
    messageSource: defaultSystemMessageSource,
    imagePaths: [path.join(os.tmpdir(), "outside.png")]
  }, { allowedWorkspaces: [root] }, driver), /inside the target workspace/);
});

test("system-owned task resolution requests the bounded Desktop state index", async () => {
  const listCalls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => { listCalls.push(params); return []; },
    read: async () => { throw new Error("not used"); },
    create: async (params) => ({
      id: "019f0000-0000-7000-8000-000000000099",
      title: params.title,
      updatedAt: "2026-08-04T00:00:00Z",
      source: "test",
      initialTurnStatus: "not-requested"
    }),
    send: async () => undefined
  };

  await handleAgentThreadRequest({
    action: "resolve",
    title: "星海主任务 协助处理消息1",
    cwd: process.cwd(),
    lookupMode: "state_db"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.deepEqual(listCalls, [{
    query: "星海主任务 协助处理消息1",
    limit: 10_000,
    offset: 0,
    allowedWorkspaces: [path.resolve(process.cwd())],
    stateDbOnly: true
  }]);
});

test("Agent thread send forwards the Message Agent model independently", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => {
      calls.push(params);
      return {
        threadId,
        action: "steered",
        openedThread: false,
        transport: "desktop-ipc"
      };
    }
  };
  const threadId = "019f0000-0000-7000-8000-000000000005";

  await handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "处理这个消息组",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string; model: string; reasoningEffort: string };
  assert.equal(sent.threadId, threadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.equal(sent.model, "gpt-5.6-luna");
  assert.equal(sent.reasoningEffort, "medium");
  assert.match(sent.prompt, /^\[消息源\]/);
  assert.doesNotMatch(sent.prompt, /只使用正式 Main、Release 和 Art/);
  assert.match(sent.prompt, /\[消息内容\]\n处理这个消息组/);
});

test("Agent-to-Agent send shows the verified source task, Agent type, and session id", async () => {
  const calls: unknown[] = [];
  const targetThreadId = "019f0000-0000-7000-8000-000000000002";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000003";
  const driver: AgentThreadDriver = {
    read: async (threadId) => {
      assert.equal(threadId, sourceThreadId);
      return {
        id: sourceThreadId,
        title: "星海建造师 策划 程序 协助处理计划4",
        cwd: process.cwd(),
        updatedAt: "2026-08-04T08:01:00.000Z"
      };
    },
    create: async () => { throw new Error("not used"); },
    send: async (params) => {
      calls.push(params);
      return {
        threadId: targetThreadId,
        action: "steered",
        openedThread: false,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "计划已经完成，请决定是否回复群消息。",
    cwd: process.cwd(),
    messageSource: messageSourceFor(sourceThreadId, "星海建造师 策划 程序 协助处理计划4"),
    sourceThreadId,
    sourceAgentType: "plan_secretary",
    responsePolicy: "none"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, "delivered");
  const delivery = { ...(result.data.delivery as Record<string, unknown>) };
  assert.match(String(delivery.deliveryId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  delete delivery.deliveryId;
  assert.deepEqual(delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "steered",
    transport: "desktop-ipc",
    openedThread: false
  });
  assert.deepEqual(result.data.source, {
    agentAdapter: "codex",
    agentType: "plan_secretary",
    agentLabel: "计划秘书 Agent",
    threadId: sourceThreadId,
    threadName: "星海建造师 策划 程序 协助处理计划4",
    workspace: process.cwd()
  });
  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string };
  assert.equal(sent.threadId, targetThreadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.match(sent.prompt, /^\[消息源\]/);
  assert.match(sent.prompt, /处理端：codex/);
  assert.match(sent.prompt, /会话：星海建造师 策划 程序 协助处理计划4/);
  assert.match(sent.prompt, /会话 ID：019f0000-0000-7000-8000-000000000003/);
  assert.match(sent.prompt, /角色：计划秘书 Agent/);
  assert.ok(sent.prompt.includes(`工作目录：${process.cwd()}`));
  assert.match(sent.prompt, /\[回传参数\]/);
  assert.match(sent.prompt, /"responsePolicy": "none"/);
  assert.doesNotMatch(sent.prompt, /本次投递不要求回复/);
  assert.doesNotMatch(sent.prompt, /\[协作要求\]/);
  assert.doesNotMatch(sent.prompt, /只使用正式 Main、Release 和 Art/);
  assert.match(sent.prompt, /\[消息内容\]\n计划已经完成，请决定是否回复群消息。/);
});

test("compact reply delivers evidence once and remains recoverable after an uncertain receipt", async () => {
  const source = { threadId: "019f0000-0000-7000-8000-000000000711", agentAdapter: "codex" as const,
    agentType: "agent", threadName: "请求任务", workspace: process.cwd() };
  const target = { ...source, threadId: "019f0000-0000-7000-8000-000000000712", threadName: "修复任务" };
  for (const required of [true, false]) {
    const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
    const initial = agentRequests.prepare({ source, target, responsePolicy: "required", responseInstruction: "修复并回传" });
    agentRequests.commit(initial);
    let prompt = "";
    const driver: AgentThreadDriver = {
      read: async (id) => ({ id, title: id === source.threadId ? source.threadName : target.threadName, cwd: process.cwd() }),
      create: async () => { throw Error("must reuse task"); },
      send: async (params) => {
        prompt = params.prompt;
        const error = new Error("receipt unavailable");
        error.name = "CodexDesktopDeliveryUnconfirmedError";
        throw error;
      }
    };
    const evidence = "修复已提交 r123；验证 6/6 通过。";
    const next = "首次下载验证并附新日志。";
    const response = await handleAgentThreadRequest({ action: "send", threadId: source.threadId,
      cwd: process.cwd(), messageSource: messageSourceFor(target.threadId, target.threadName),
      sourceThreadId: target.threadId, sourceAgentType: "agent", inReplyToRequestId: initial.requestId,
      prompt: required ? undefined : `${evidence}\n\n${next}`, result: evidence, nextAction: next,
      responsePolicy: required ? "required" : "none", responseInstruction: required ? "回传验收结果" : undefined
    }, { allowedWorkspaces: [process.cwd()], agentRequests }, driver);
    const deliveryId = (response.data.communication as { deliveryId: string }).deliveryId;
    assert.equal(prompt.split(evidence).length, 2);
    assert.equal(prompt.split(next).length, 2);
    assert.doesNotMatch(prompt, /当前接收会话|本次投递不要求回复|\[补充说明\]/);
    if (required) {
      const parameters = JSON.parse(prompt.split("[回传参数]\n")[1]);
      for (const field of ["action", "threadId", "cwd", "messageSource", "sourceThreadId", "sourceAgentType", "inReplyToRequestId", "result", "nextAction", "responsePolicy"]) {
        assert.ok(Object.hasOwn(parameters.request, field), field);
      }
      const altered = prompt.replace(evidence, "altered evidence");
      assert.equal(recoverAgentResponseDelivery(agentRequests, source.threadId, deliveryId, () => [altered]).status, "delivery_unconfirmed");
    }
    assert.equal(recoverAgentResponseDelivery(agentRequests, source.threadId, deliveryId, () => [prompt]).status, "receipt_recovered");
    assert.equal(agentRequests.get(initial.requestId!)?.response?.result, evidence);
    assert.equal(agentRequests.get(initial.requestId!)?.response?.nextAction, next);
  }
});

test("Agent thread send replaces an archived bound task before delivery", async () => {
  const archivedThreadId = "019f0000-0000-7000-8000-000000000105";
  const replacementThreadId = "019f0000-0000-7000-8000-000000000106";
  const title = "星海建造师 协助处理消息1";
  const sent: string[] = [];
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => ({
      id: threadId,
      title,
      cwd: process.cwd(),
      updatedAt: "2026-08-18T01:00:00.000Z",
      archived: threadId === archivedThreadId
    }),
    create: async (params) => {
      createCount += 1;
      return {
        id: replacementThreadId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-08-18T02:00:00.000Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async ({ threadId }) => { sent.push(threadId); }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: archivedThreadId,
    title,
    createIfMissing: true,
    prompt: "归档后继续处理",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(createCount, 1);
  assert.deepEqual(sent, [replacementThreadId]);
  assert.equal(result.data.threadId, replacementThreadId);
  assert.equal(result.data.resolution, "created");
  assert.equal(result.data.previousThreadId, archivedThreadId);
  assert.deepEqual((result.data.thread as { id: string }).id, replacementThreadId);
});

test("Agent thread send replaces a task confirmed missing after Desktop owner delivery and returns a warning", async () => {
  const missingThreadId = "019f0000-0000-7000-8000-000000000107";
  const replacementThreadId = "019f0000-0000-7000-8000-000000000108";
  const title = "星海建造师 协助处理消息2";
  let reads = 0;
  let createCount = 0;
  const sent: string[] = [];
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => {
      assert.equal(threadId, missingThreadId);
      reads += 1;
      if (reads === 1) {
        return {
          id: missingThreadId,
          title,
          cwd: process.cwd(),
          updatedAt: "2026-08-25T08:00:00.000Z"
        };
      }
      throw new Error(`Codex Desktop task was not found: ${threadId}`);
    },
    create: async (params) => {
      createCount += 1;
      return {
        id: replacementThreadId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-08-25T08:01:00.000Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async ({ threadId }) => {
      if (threadId === missingThreadId) throw new Error(`no rollout found for thread id ${threadId}`);
      sent.push(threadId);
    }
  };

  const response = await handleAgentThreadRequest({
    action: "send",
    threadId: missingThreadId,
    title,
    createIfMissing: true,
    prompt: "原任务消失后继续投递",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(createCount, 1);
  assert.deepEqual(sent, [replacementThreadId]);
  assert.equal(response.statusCode, 202);
  assert.equal(response.data.status, "delivered");
  assert.equal(response.data.threadId, replacementThreadId);
  assert.equal(response.data.resolution, "created");
  assert.equal(response.data.previousThreadId, missingThreadId);
  assert.match(String(response.data.warning), /已不存在；已创建替代任务/);
});

test("Agent thread send keeps a task that only reports no-client-found and does not create a replacement", async () => {
  const threadId = "019f0000-0000-7000-8000-000000000109";
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => ({
      id: threadId,
      title: "仍存在但未加载的 Desktop 任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-25T08:00:00.000Z"
    }),
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => { throw new Error("Codex Desktop IPC thread-follower-start-turn failed: no-client-found"); }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId,
    title: "仍存在但未加载的 Desktop 任务",
    createIfMissing: true,
    prompt: "不应创建替代任务",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  }, { allowedWorkspaces: [process.cwd()] }, driver), /no-client-found/);

  assert.equal(createCount, 0);
});

test("unconfirmed delivery retains its request across restart and recovers on an evidenced reply", async () => {
  const sourceThreadId = "019f0000-0000-7000-8000-000000000181";
  const targetThreadId = "019f0000-0000-7000-8000-000000000182";
  const persistence = new MemoryAgentRequestPersistence();
  const agentRequests = new AgentRequestStore(persistence);
  let markerVisible = false;
  let sends = 0;
  const driver: AgentThreadDriver = {
    read: async (threadId) => ({ id: threadId, title: "测试任务", cwd: process.cwd() }),
    create: async () => { throw new Error("must not create"); },
    send: async () => {
      sends += 1;
      if (sends === 1) {
        const error = new Error("Codex Desktop delivery unconfirmed");
        error.name = "CodexDesktopDeliveryUnconfirmedError";
        throw error;
      }
    }
  };
  const options = {
    allowedWorkspaces: [process.cwd()], agentRequests,
    confirmCodexDelivery: async (threadId: string, deliveryId: string) =>
      markerVisible && threadId === targetThreadId && deliveryId === agentRequests.list()[0]?.deliveryId
  };
  const initial = await handleAgentThreadRequest({
    action: "send", threadId: targetThreadId, cwd: process.cwd(), prompt: "请核对",
    messageSource: messageSourceFor(sourceThreadId), sourceThreadId, sourceAgentType: "agent",
    responsePolicy: "required", responseInstruction: "返回结果"
  }, options, driver);
  assert.equal(initial.data.status, "delivery_unconfirmed");
  assert.equal(initial.data.ok, false);
  const record = agentRequests.list()[0];
  assert.equal(record.status, "pending_delivery");
  const restarted = new AgentRequestStore(persistence);
  assert.equal(restarted.get(record.id)?.deliveryId, record.deliveryId);
  const reply = {
    action: "send" as const, threadId: sourceThreadId, cwd: process.cwd(), prompt: "核对完成",
    messageSource: messageSourceFor(targetThreadId), sourceThreadId: targetThreadId,
    sourceAgentType: "agent" as const, responsePolicy: "none" as const,
    inReplyToRequestId: record.id, result: "完成", nextAction: "无"
  };
  await assert.rejects(handleAgentThreadRequest(reply, { ...options, agentRequests: restarted }, driver), error => {
    const failure = agentThreadRequestFailureData(error, reply);
    const detail = failure.error as Record<string, unknown>;
    assert.equal(detail.code, "agent_reply_state_conflict");
    assert.equal(detail.currentState, "pending_delivery");
    assert.equal(detail.reason, "original_delivery_receipt_not_found");
    assert.equal(detail.commitState, "not_started");
    assert.match(String(detail.nextAction), /same requestId/);
    return true;
  });
  assert.equal(sends, 1);
  markerVisible = true;
  await assert.rejects(handleAgentThreadRequest({
    ...reply, messageSource: messageSourceFor(sourceThreadId), sourceThreadId
  }, { ...options, agentRequests: restarted }, driver));
  assert.equal(restarted.get(record.id)?.status, "pending_delivery");
  const response = await handleAgentThreadRequest(reply, { ...options, agentRequests: restarted }, driver);
  assert.equal(response.data.status, "delivered");
  assert.equal(restarted.get(record.id)?.status, "responded");
  assert.equal(sends, 2);
});

test("definitive owner rejection still removes an undelivered request reservation", async () => {
  const sourceThreadId = "019f0000-0000-7000-8000-000000000183";
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  await assert.rejects(handleAgentThreadRequest({
    action: "send", threadId: "019f0000-0000-7000-8000-000000000184",
    cwd: process.cwd(), prompt: "请核对", messageSource: messageSourceFor(sourceThreadId),
    sourceThreadId, sourceAgentType: "agent", responsePolicy: "required", responseInstruction: "返回结果"
  }, { allowedWorkspaces: [process.cwd()], agentRequests }, {
    read: async (threadId) => ({ id: threadId, title: "测试任务", cwd: process.cwd() }),
    create: async () => { throw new Error("must not create"); },
    send: async () => { throw new Error("Codex Desktop IPC rejected: no-client-found"); }
  }), /no-client-found/);
  assert.deepEqual(agentRequests.list(), []);
});

test("message-processing handoff reports a structured requirement after the target owner accepts it", async () => {
  const targetThreadId = "019f0000-0000-7000-8000-000000000082";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000083";
  const handoffs: unknown[] = [];
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  let sent = false;
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "星海建造师 协助处理消息2",
      cwd: process.cwd(),
      updatedAt: "2026-08-05T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => {
      sent = true;
      return {
        threadId: targetThreadId,
        action: "started",
        openedThread: true,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "请核对 plan-1 的最新进展并把结果返回消息处理任务。",
    cwd: process.cwd(),
    messageSource: messageSourceFor(sourceThreadId, "星海建造师 协助处理消息2"),
    sourceThreadId,
    sourceAgentType: "message_processing",
    responsePolicy: "required",
    responseInstruction: "核对完成后把结果和下一步返回消息处理任务",
    messageProcessing: {
      requirementId: "message-group-1:main",
      outcome: "handoff",
      targetAgentType: "plan_agent",
      planId: "plan-1",
      planTitle: "实现选择界面"
    }
  }, {
    allowedWorkspaces: [process.cwd()],
    agentRequests,
    onMessageProcessingHandoff: (event) => { handoffs.push(event); }
  }, driver);

  assert.equal(sent, true);
  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, "delivered");
  const communication = result.data.communication as Record<string, unknown>;
  assert.equal(communication.responsePolicy, "required");
  assert.equal(communication.requestStatus, "awaiting_response");
  const delivery = { ...(result.data.delivery as Record<string, unknown>) };
  assert.match(String(delivery.deliveryId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  delete delivery.deliveryId;
  assert.deepEqual(delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "started",
    transport: "desktop-ipc",
    openedThread: true
  });
  assert.deepEqual(result.data.handoff, {
    status: "recorded",
    requirementId: "message-group-1:main",
    targetAgentType: "plan_agent",
    targetThreadId
  });
  assert.deepEqual(handoffs, [{
    requirementId: "message-group-1:main",
    sourceThreadId,
    targetThreadId,
    targetAgentType: "plan_agent",
    planId: "plan-1",
    planTitle: "实现选择界面"
  }]);
});

test("a reply addressed to a detached Message Agent alias is delivered to its current successor", async () => {
  const oldMessageThreadId = "019f0000-0000-7000-8000-000000000086";
  const currentMessageThreadId = "019f0000-0000-7000-8000-000000000087";
  const targetThreadId = "019f0000-0000-7000-8000-000000000088";
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const tracked = agentRequests.prepare({
    source: { threadId: oldMessageThreadId, agentType: "message_processing", workspace: process.cwd() },
    target: { threadId: targetThreadId, agentType: "plan_agent", workspace: process.cwd() },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  agentRequests.commit(tracked);
  agentRequests.reconcileOpenParties((party, _record, role) => role === "source" && party.threadId === oldMessageThreadId
    ? { threadId: currentMessageThreadId, agentType: "message_processing", workspace: process.cwd() }
    : undefined);
  const deliveries: string[] = [];
  const driver: AgentThreadDriver = {
    read: async (threadId) => ({
      id: threadId,
      title: threadId === targetThreadId ? "计划 Agent" : "消息处理 Agent",
      cwd: process.cwd(),
      updatedAt: "2026-08-13T06:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async ({ threadId }) => {
      deliveries.push(threadId);
      return { threadId, action: "steered", openedThread: false, transport: "desktop-ipc" };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: oldMessageThreadId,
    cwd: process.cwd(),
    prompt: "已完成，返回结果。",
    messageSource: messageSourceFor(targetThreadId, "计划 Agent"),
    sourceThreadId: targetThreadId,
    sourceAgentType: "plan_agent",
    inReplyToRequestId: tracked.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  }, {
    allowedWorkspaces: [process.cwd()],
    agentRequests
  }, driver);

  assert.deepEqual(deliveries, [currentMessageThreadId]);
  assert.equal(result.data.threadId, currentMessageThreadId);
  assert.equal(agentRequests.get(tracked.requestId || "")?.status, "responded");
});

test("an Agent reply to an archived bound task creates a new replacement instead of reopening history", async () => {
  const archivedThreadId = "019f0000-0000-7000-8000-000000000096";
  const respondingThreadId = "019f0000-0000-7000-8000-000000000097";
  const replacementThreadId = "019f0000-0000-7000-8000-000000000098";
  const title = "星海建造师 策划 程序 协助处理计划1";
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const tracked = agentRequests.prepare({
    source: { threadId: archivedThreadId, agentType: "plan_agent", threadName: title, workspace: process.cwd() },
    target: { threadId: respondingThreadId, agentType: "message_processing", workspace: process.cwd() },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  agentRequests.commit(tracked);
  const deliveries: string[] = [];
  let created = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => ({
      id: threadId,
      title: threadId === archivedThreadId ? title : "消息处理 Agent",
      cwd: process.cwd(),
      updatedAt: "2026-08-25T09:30:00.000Z",
      archived: threadId === archivedThreadId
    }),
    create: async (params) => {
      created += 1;
      return {
        id: replacementThreadId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-08-25T09:31:00.000Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async ({ threadId }) => {
      deliveries.push(threadId);
      return { threadId, action: "started", openedThread: true, transport: "desktop-ipc" };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: archivedThreadId,
    cwd: process.cwd(),
    prompt: "已完成，返回结果。",
    messageSource: messageSourceFor(respondingThreadId, "消息处理 Agent"),
    sourceThreadId: respondingThreadId,
    sourceAgentType: "message_processing",
    inReplyToRequestId: tracked.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  }, { allowedWorkspaces: [process.cwd()], agentRequests }, driver);

  assert.equal(created, 1);
  assert.deepEqual(deliveries, [replacementThreadId]);
  assert.equal(result.data.previousThreadId, archivedThreadId);
  assert.equal(result.data.threadId, replacementThreadId);
  assert.equal(agentRequests.get(tracked.requestId || "")?.status, "responded");
});


test("an Agent reply replaces a task that disappears after reply redirection", async () => {
  const staleThreadId = "019f0000-0000-7000-8000-000000000110";
  const respondingThreadId = "019f0000-0000-7000-8000-000000000111";
  const replacementThreadId = "019f0000-0000-7000-8000-000000000112";
  const title = "星海建造师 策划 程序 协助处理计划2";
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const tracked = agentRequests.prepare({
    source: { threadId: staleThreadId, agentType: "plan_agent", threadName: title, workspace: process.cwd() },
    target: { threadId: respondingThreadId, agentType: "message_processing", workspace: process.cwd() },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  agentRequests.commit(tracked);
  let reads = 0;
  let created = 0;
  const deliveries: string[] = [];
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => {
      if (threadId === respondingThreadId) {
        return {
          id: respondingThreadId,
          title: "消息处理 Agent",
          cwd: process.cwd(),
          updatedAt: "2026-08-25T10:00:00.000Z"
        };
      }
      assert.equal(threadId, staleThreadId);
      reads += 1;
      if (reads === 1) {
        return {
          id: staleThreadId,
          title,
          cwd: process.cwd(),
          updatedAt: "2026-08-25T10:00:00.000Z"
        };
      }
      throw new Error(`Codex Desktop task was not found: ${threadId}`);
    },
    create: async (params) => {
      created += 1;
      return {
        id: replacementThreadId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-08-25T10:01:00.000Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async ({ threadId }) => {
      if (threadId === staleThreadId) throw new Error(`no rollout found for thread id ${threadId}`);
      deliveries.push(threadId);
      return { threadId, action: "started", openedThread: true, transport: "desktop-ipc" };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: staleThreadId,
    cwd: process.cwd(),
    prompt: "已完成，返回结果。",
    messageSource: messageSourceFor(respondingThreadId, "消息处理 Agent"),
    sourceThreadId: respondingThreadId,
    sourceAgentType: "message_processing",
    inReplyToRequestId: tracked.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  }, { allowedWorkspaces: [process.cwd()], agentRequests }, driver);

  assert.equal(created, 1);
  assert.deepEqual(deliveries, [replacementThreadId]);
  assert.equal(result.data.previousThreadId, staleThreadId);
  assert.equal(result.data.threadId, replacementThreadId);
  assert.equal(agentRequests.get(tracked.requestId || "")?.status, "responded");
});

test("message-processing handoff returns a partial failure without hiding the accepted target delivery", async () => {
  const targetThreadId = "019f0000-0000-7000-8000-000000000084";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000085";
  let sendCount = 0;
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "消息处理任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-05T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => {
      sendCount += 1;
      return {
        threadId: targetThreadId,
        action: "started",
        openedThread: true,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "请处理并返回。",
    cwd: process.cwd(),
    messageSource: messageSourceFor(sourceThreadId, "消息处理任务"),
    sourceThreadId,
    sourceAgentType: "message_processing",
    responsePolicy: "required",
    responseInstruction: "处理完成后把结果和下一步返回消息处理任务",
    messageProcessing: {
      requirementId: "message-group-2:main",
      outcome: "handoff",
      targetAgentType: "plan_secretary"
    }
  }, {
    allowedWorkspaces: [process.cwd()],
    agentRequests,
    onMessageProcessingHandoff: () => { throw new Error("board write failed"); }
  }, driver);

  assert.equal(sendCount, 1);
  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.status, "delivered_tracking_failed");
  const delivery = { ...(result.data.delivery as Record<string, unknown>) };
  assert.match(String(delivery.deliveryId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  delete delivery.deliveryId;
  assert.deepEqual(delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "started",
    transport: "desktop-ipc",
    openedThread: true
  });
  assert.deepEqual(result.data.handoff, {
    status: "tracking_failed",
    requirementId: "message-group-2:main",
    targetAgentType: "plan_secretary",
    targetThreadId,
    error: {
      stage: "message_processing_tracking",
      message: "Agent handoff was accepted, but the message-processing board update failed: board write failed",
      retryable: true
    }
  });
});

test("Agent thread create reuses the same title and workspace instead of creating a duplicate", async () => {
  const existing = {
    id: "019f0000-0000-7000-8000-000000000071",
    title: "[SampleProject][Bug] 摆放系统 - 建筑或物件位置重叠",
    updatedAt: "2026-08-11T12:36:03.891Z",
    cwd: process.cwd(),
    archived: false
  };
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ stateDbOnly }) => {
      assert.equal(stateDbOnly, true);
      return [existing];
    },
    read: async () => existing,
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "create",
    title: existing.title,
    prompt: "只读调查。",
    cwd: existing.cwd,
    messageSource: defaultSystemMessageSource
  }, {
    allowedWorkspaces: [existing.cwd]
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, existing.id);
  assert.equal(createCount, 0);
});

test("Agent thread create shares one in-flight creation across caller retries", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ stateDbOnly }) => {
      assert.equal(stateDbOnly, true);
      return [];
    },
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        id: "019f0000-0000-7000-8000-000000000072",
        title: params.title,
        updatedAt: "2026-08-11T12:36:03.891Z",
        source: "test",
        initialTurnStatus: "started"
      };
    },
    send: async () => undefined
  };
  const request = {
    action: "create" as const,
    title: "[SampleProject][Bug] 摆放系统 - 建筑或物件位置重叠",
    prompt: "只读调查。",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource
  };
  const options = { allowedWorkspaces: [process.cwd()] };

  const results = await Promise.all([
    handleAgentThreadRequest(request, options, driver),
    handleAgentThreadRequest(request, options, driver)
  ]);

  assert.equal(createCount, 1);
  assert.equal(results[0].statusCode, 201);
  assert.equal(results[1].statusCode, 201);
  assert.equal(
    (results[0].data.thread as { id: string }).id,
    (results[1].data.thread as { id: string }).id
  );
});

test("Agent thread create retries a stale creating reservation only after state_db confirms missing", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-thread-stale-creating-"));
  const title = "[SampleProject][Bug] 初始商店 - 未弹主动引导";
  const cwd = process.cwd();
  const reservationPath = codexThreadCreationReservationPathForTest(rootDir, title, cwd);
  fs.mkdirSync(path.dirname(reservationPath), { recursive: true });
  fs.writeFileSync(reservationPath, `${JSON.stringify({
    version: 1,
    key: JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(cwd), title, ""]),
    title,
    workspace: path.resolve(cwd),
    state: "creating",
    createdAt: "2026-08-14T11:34:17.000Z",
    updatedAt: "2026-08-14T11:34:17.000Z"
  }, null, 2)}\n`, "utf8");
  let listCount = 0;
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ stateDbOnly }) => {
      assert.equal(stateDbOnly, true);
      listCount += 1;
      return [];
    },
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createCount += 1;
      return {
        id: "019f0000-0000-7000-8000-000000000073",
        title: params.title,
        updatedAt: "2026-08-14T12:00:00.000Z",
        source: "test",
        initialTurnStatus: "started"
      };
    },
    send: async () => undefined
  };
  try {
    const result = await handleAgentThreadRequest({ action: "create", title, prompt: "继续处理。", cwd, messageSource: defaultSystemMessageSource }, {
      allowedWorkspaces: [cwd],
      defaultWorkspace: rootDir
    }, driver);
    assert.equal(result.statusCode, 201);
    assert.equal(createCount, 1);
    assert.equal(listCount, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Agent thread create keeps stale creating uncertain when a threadId exists", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-thread-stale-thread-id-"));
  const title = "[SampleProject][Bug] 初始商店 - 未弹主动引导";
  const cwd = process.cwd();
  const reservationPath = codexThreadCreationReservationPathForTest(rootDir, title, cwd);
  fs.mkdirSync(path.dirname(reservationPath), { recursive: true });
  fs.writeFileSync(reservationPath, `${JSON.stringify({
    version: 1,
    key: JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(cwd), title, ""]),
    title,
    workspace: path.resolve(cwd),
    state: "creating",
    createdAt: "2026-08-14T11:34:17.000Z",
    updatedAt: "2026-08-14T11:34:17.000Z",
    threadId: "019f0000-0000-7000-8000-000000000074"
  }, null, 2)}\n`, "utf8");
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };
  try {
    const result = await handleAgentThreadRequest({ action: "create", title, prompt: "继续处理。", cwd, messageSource: defaultSystemMessageSource }, {
      allowedWorkspaces: [cwd],
      defaultWorkspace: rootDir
    }, driver);
    assert.equal(result.statusCode, 409);
    assert.equal(result.data.resolution, "uncertain");
    assert.equal(createCount, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Agent thread create keeps stale creating uncertain when state_db evidence fails", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-thread-stale-evidence-failed-"));
  const title = "[SampleProject][Bug] 初始商店 - 未弹主动引导";
  const cwd = process.cwd();
  const reservationPath = codexThreadCreationReservationPathForTest(rootDir, title, cwd);
  fs.mkdirSync(path.dirname(reservationPath), { recursive: true });
  fs.writeFileSync(reservationPath, `${JSON.stringify({
    version: 1,
    key: JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(cwd), title, ""]),
    title,
    workspace: path.resolve(cwd),
    state: "creating",
    createdAt: "2026-08-14T11:34:17.000Z",
    updatedAt: "2026-08-14T11:34:17.000Z"
  }, null, 2)}\n`, "utf8");
  let listCount = 0;
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => {
      listCount += 1;
      if (listCount === 1) return [];
      throw new Error("state_db unavailable");
    },
    read: async () => { throw new Error("not used"); },
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };
  try {
    const result = await handleAgentThreadRequest({ action: "create", title, prompt: "继续处理。", cwd, messageSource: defaultSystemMessageSource }, {
      allowedWorkspaces: [cwd],
      defaultWorkspace: rootDir
    }, driver);
    assert.equal(result.statusCode, 409);
    assert.equal(result.data.resolution, "uncertain");
    assert.match(String(result.data.message), /uncertain/i);
    assert.equal(createCount, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Agent thread list can use the fast local state index for timeout readback", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [];
    },
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "list",
    query: "摆放系统",
    lookupMode: "state_db",
    cwd: process.cwd()
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { stateDbOnly?: boolean }).stateDbOnly, true);
});

test("Agent thread failures expose the action, missing field, and retry guidance", () => {
  assert.deepEqual(agentThreadRequestFailureData(new Error("Missing prompt."), { action: "send" }), {
    action: "send",
    status: "failed",
    message: "Missing prompt.",
    error: {
      stage: "validation",
      field: "prompt",
      message: "Missing prompt.",
      retryable: false
    }
  });
  assert.deepEqual(agentThreadRequestFailureData(new Error("Missing messageSource."), { action: "send" }), {
    action: "send",
    status: "failed",
    message: "Missing messageSource.",
    error: {
      stage: "validation",
      field: "messageSource",
      message: "Missing messageSource.",
      retryable: false
    }
  });
  assert.deepEqual(
    agentThreadRequestFailureData(
      new Error("Codex Desktop task is archived: 已归档任务"),
      { action: "send", sourceAgentType: "plan_agent" }
    ),
    {
      action: "send",
      status: "failed",
      message: "会话任务不存在。",
      error: {
        stage: "request",
        message: "会话任务不存在。",
        retryable: false
      }
    }
  );
  assert.equal(
    (agentThreadRequestFailureData(
      new Error("Codex Desktop task is archived: 已归档任务"),
      { action: "send" }
    ).message),
    "Codex Desktop task is archived: 已归档任务"
  );
  assert.deepEqual(agentThreadRequestFailureData(
    new Error("messageSource.sessionId must match sourceThreadId for Agent-to-Agent delivery."),
    { action: "send" }
  ), {
    action: "send",
    status: "failed",
    message: "messageSource.sessionId must match sourceThreadId for Agent-to-Agent delivery.",
    error: {
      stage: "source_verification",
      field: "messageSource.sessionId",
      message: "messageSource.sessionId must match sourceThreadId for Agent-to-Agent delivery.",
      retryable: false
    }
  });
  assert.deepEqual(agentThreadRequestFailureData(
    new Error("sourceAgentType requires sourceThreadId."),
    { action: "send" }
  ), {
    action: "send",
    status: "failed",
    message: "sourceAgentType requires sourceThreadId.",
    error: {
      stage: "source_verification",
      field: "sourceThreadId",
      message: "sourceAgentType requires sourceThreadId.",
      retryable: false
    }
  });
  assert.deepEqual(agentThreadRequestFailureData(
    new Error("responsePolicy is required for Agent-to-Agent delivery and must be required or none."),
    { action: "send" }
  ), {
    action: "send",
    status: "failed",
    message: "responsePolicy is required for Agent-to-Agent delivery and must be required or none.",
    error: {
      stage: "validation",
      field: "responsePolicy",
      message: "responsePolicy is required for Agent-to-Agent delivery and must be required or none.",
      retryable: false
    }
  });
});

test("Agent-to-Agent send requires an explicit response policy", async () => {
  const sourceThreadId = "019f0000-0000-7000-8000-000000000091";
  let sendCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({ id: sourceThreadId, title: "计划任务", cwd: process.cwd(), updatedAt: "2026-08-07T00:00:00.000Z" }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };
  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000092",
    prompt: "调查结果",
    cwd: process.cwd(),
    messageSource: messageSourceFor(sourceThreadId, "计划任务"),
    sourceThreadId,
    sourceAgentType: "plan_agent"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /responsePolicy is required/);
  assert.equal(sendCount, 0);
});

test("Agent-to-Agent send refuses an unknown source task", async () => {
  let sendCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "结果",
    cwd: process.cwd(),
    messageSource: messageSourceFor("019f0000-0000-7000-8000-000000000003", "未知来源任务"),
    sourceThreadId: "019f0000-0000-7000-8000-000000000003",
    sourceAgentType: "plan_agent"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /无法核对来源任务/);
  assert.equal(sendCount, 0);
});

test("Agent-to-Agent send rejects leaked role initialization before it reaches the target task", async () => {
  let sendCount = 0;
  const sourceThreadId = "019f0000-0000-7000-8000-000000000071";
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "星海建造师 策划 程序 协助处理消息2",
      cwd: process.cwd(),
      updatedAt: "2026-08-04T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000072",
    prompt: "[rabi:bind XinghaiBuilder]\n[消息处理 Agent 初始化]\n你是专职消息处理 Agent，不是主人格。",
    cwd: process.cwd(),
    messageSource: messageSourceFor(sourceThreadId, "星海建造师 策划 程序 协助处理消息2"),
    sourceThreadId,
    sourceAgentType: "message_processing"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /only the newly composed handoff content/);

  assert.equal(sendCount, 0);
  assert.doesNotThrow(() => validateAgentThreadHandoffPromptForTest([
    "[消息处理交接]",
    "消息组 ID：message-group-1",
    "需要主人格决定：是否现在向群里汇报。",
    "拟发送正文：当前计划已完成静态检查，等待目标包验证。"
  ].join("\n")));
});

test("Agent-to-Agent send rejects a self-targeted handoff", async () => {
  let sendCount = 0;
  const threadId = "019f0000-0000-7000-8000-000000000073";
  const driver: AgentThreadDriver = {
    read: async () => ({ id: threadId, title: "消息处理任务", cwd: process.cwd(), updatedAt: "2026-08-04T08:00:00.000Z" }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "内部结果",
    cwd: process.cwd(),
    messageSource: messageSourceFor(threadId, "消息处理任务"),
    sourceThreadId: threadId,
    sourceAgentType: "message_processing"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /source and target task must be different/);
  assert.equal(sendCount, 0);
});

test("Agent thread rename preserves the exact task id and validates the configured workspace", async () => {
  const calls: unknown[] = [];
  const threadId = "019f0000-0000-7000-8000-000000000004";
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    rename: async (params) => {
      calls.push(params);
      return { id: params.threadId, title: params.title, cwd: params.cwd, updatedAt: "2026-07-27T00:00:00.000Z" };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "rename",
    threadId,
    title: "主任务 协助处理计划1",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, [{
    threadId,
    title: "主任务 协助处理计划1",
    cwd: path.resolve(process.cwd())
  }]);
});

test("Agent thread send accepts danger-full-access for Windows sandbox recovery", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { calls.push(params); }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000003",
    prompt: "恢复调查",
    cwd: process.cwd(),
    messageSource: defaultSystemMessageSource,
    sandbox: "danger-full-access"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal((calls[0] as { sandbox: string }).sandbox, "danger-full-access");
});


test("DSH Agent thread flow discovers, creates, renames, resolves, and delivers through the selected owner", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "session-44444444-4444-4444-8444-444444444444";
  const rows: Array<{
    sessionId: string;
    updatedAt: number;
    running: boolean;
    cwd: string;
    projections: { values: { title: string } };
  }> = [];
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      rpcId: string;
      method: string;
      payload?: Record<string, unknown>;
    };
    methods.push(body.method);
    let value: unknown = {};
    if (body.method === "session.list") {
      value = { items: rows };
    } else if (body.method === "workspace.create") {
      value = { workspace: { workspaceId: "workspace-rabi", path: body.payload?.path } };
    } else if (body.method === "session.create") {
      rows.push({
        sessionId,
        updatedAt: Date.now(),
        running: false,
        cwd: body.payload?.workspaceId === "workspace-rabi" ? process.cwd() : String(body.payload?.cwd || ""),
        projections: { values: { title: sessionId } }
      });
      value = { sessionId };
    } else if (body.method === "session.rename") {
      const row = rows.find((item) => item.sessionId === body.payload?.sessionId);
      if (row) row.projections.values.title = String(body.payload?.title || "");
      value = { title: body.payload?.title };
    } else if (body.method === "session.prompt") {
      value = { accepted: true };
    }
    return new Response(JSON.stringify({
      rpcId: body.rpcId,
      result: { ok: true, value }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const options = {
      allowedWorkspaces: [process.cwd()],
      defaultWorkspace: process.cwd(),
      dshBaseUrl: "http://127.0.0.1:3080",
      dshAgentPreset: "rabi-primary"
    };
    const created = await handleAgentThreadRequest({
      action: "create",
      agentAdapter: "dsh",
      title: "DSH 主人格",
      prompt: "初始化人格",
      cwd: process.cwd(),
      messageSource: defaultSystemMessageSource
    }, options);
    assert.equal(created.statusCode, 201);
    assert.equal(created.data.agentAdapter, "dsh");
    assert.equal((created.data.thread as { id: string }).id, sessionId);
    assert.equal(created.data.initialTurnStatus, "started");

    const listed = await handleAgentThreadRequest({
      action: "list",
      agentAdapter: "dsh",
      query: "主人格"
    }, options);
    assert.deepEqual((listed.data.threads as Array<{ id: string }>).map((thread) => thread.id), [sessionId]);

    const renamed = await handleAgentThreadRequest({
      action: "rename",
      agentAdapter: "dsh",
      threadId: sessionId,
      title: "DSH 计划秘书",
      cwd: process.cwd()
    }, options);
    assert.equal((renamed.data.thread as { title: string }).title, "DSH 计划秘书");

    const sent = await handleAgentThreadRequest({
      action: "send",
      agentAdapter: "dsh",
      threadId: sessionId,
      title: "DSH 计划秘书",
      prompt: "继续处理计划",
      cwd: process.cwd(),
      messageSource: defaultSystemMessageSource
    }, options);
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.data.agentAdapter, "dsh");
    assert.equal((sent.data.delivery as { acceptedBy: string; transport: string }).acceptedBy, "dsh_session_owner");
    assert.equal((sent.data.delivery as { acceptedBy: string; transport: string }).transport, "http");
    assert.equal(methods.filter((method) => method === "workspace.create").length, 1);
    assert.equal(methods.filter((method) => method === "session.create").length, 1);
    assert.equal(methods.filter((method) => method === "session.prompt").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DSH Agent-to-Agent delivery verifies the DSH source and does not relabel it as Codex", async () => {
  const sourceThreadId = "session-00000000-0000-4000-8000-000000000031";
  const targetThreadId = "session-00000000-0000-4000-8000-000000000032";
  const calls: Array<Record<string, unknown>> = [];
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const driver: AgentThreadDriver = {
    read: async (threadId) => ({
      id: threadId,
      title: threadId === sourceThreadId ? "DSH 计划秘书" : "DSH 业务任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-20T00:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { calls.push(params); }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: "dsh",
    threadId: targetThreadId,
    prompt: "继续处理计划",
    cwd: process.cwd(),
    messageSource: {
      type: "agent",
      agentAdapter: "dsh",
      sessionId: sourceThreadId,
      sessionName: "DSH 计划秘书"
    },
    sourceThreadId,
    sourceAgentType: "plan_secretary",
    responsePolicy: "required",
    responseInstruction: "回复 DSH 计划秘书"
  }, { allowedWorkspaces: [process.cwd()], agentRequests }, driver);

  assert.equal(result.statusCode, 202);
  assert.equal((result.data.source as { agentAdapter: string }).agentAdapter, "dsh");
  assert.match(String(calls[0]?.prompt), /处理端：dsh/);
  assert.match(String(calls[0]?.prompt), /角色：计划秘书 Agent/);
  assert.match(String(calls[0]?.prompt), /"sessionId": "session-00000000-0000-4000-8000-000000000032"/);
  assert.match(String(calls[0]?.prompt), /"sourceThreadId": "session-00000000-0000-4000-8000-000000000032"/);
  assert.doesNotMatch(String(calls[0]?.prompt), /处理端：codex/);
});

test("Agent thread open verifies the exact Codex task independently of its saved cwd", async () => {
  const threadId = "019f0000-0000-7000-8000-000000000041";
  const opened: string[] = [];
  let archived = false;
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: threadId,
      title: "主人格任务",
      cwd: path.dirname(process.cwd()),
      updatedAt: "2026-08-20T00:00:00.000Z",
      archived
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "open",
    agentAdapter: "codex",
    threadId,
    cwd: process.cwd()
  }, {
    allowedWorkspaces: [process.cwd()],
    openCodexThread: async (id) => { opened.push(id); }
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.status, "opened");
  assert.equal(result.data.owner, "codex_desktop");
  assert.deepEqual(opened, [threadId]);

  archived = true;
  await assert.rejects(
    handleAgentThreadRequest({ action: "open", agentAdapter: "codex", threadId, cwd: process.cwd() }, {
      allowedWorkspaces: [process.cwd()],
      openCodexThread: async (id) => { opened.push(id); }
    }, driver),
    /archived/
  );
  assert.deepEqual(opened, [threadId]);
});

test("Agent thread open locates the exact DSH session with its configured base URL", async () => {
  const sessionId = "session-00000000-0000-4000-8000-000000000041";
  const baseUrl = "http://127.0.0.1:3080";
  const opened: Array<{ id: string; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    assert.equal(body.method, "session.list");
    return new Response(JSON.stringify({
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          items: [{
            sessionId,
            cwd: process.cwd(),
            updatedAt: Date.now(),
            running: false,
            projections: { values: { title: "DSH 主人格" } }
          }]
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await handleAgentThreadRequest({
      action: "open",
      agentAdapter: "dsh",
      threadId: sessionId,
      cwd: process.cwd()
    }, {
      allowedWorkspaces: [process.cwd()],
      dshBaseUrl: baseUrl,
      openDshSession: async (id, url) => { opened.push({ id, url }); }
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.data.owner, "dsh_web");
    assert.deepEqual(opened, [{ id: sessionId, url: baseUrl }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
