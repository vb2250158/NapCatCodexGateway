import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MemoryConsolidationAgent,
  memoryConsolidationAgentStatePath
} from "./memoryConsolidationAgent.js";

function deliveryPayloadText(payload: Record<string, any> | undefined): string {
  if (!payload) return "";
  return [
    String(payload.prompt || ""),
    ...(Array.isArray(payload.contextBlocks) ? payload.contextBlocks.map(String) : []),
    ...(Array.isArray(payload.controlBlocks) ? payload.controlBlocks.map(String) : [])
  ].filter(Boolean).join("\n\n");
}

test("uncertain memory delivery survives reload and verifies its receipt without resending", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-receipt-"));
  const options = { statePath: memoryConsolidationAgentStatePath(root), managerBaseUrl: "http://localhost:1", sourceThreadId: "primary", sourceThreadName: "Primary", workspace: "C:/Project", roleId: "role-a" };
  let sends = 0;
  let accepted = false;
  const request = async (payload: Record<string, unknown>) => {
    if (payload.action === "resolve") return { thread: { id: "worker", title: "Worker", cwd: options.workspace } };
    if (payload.action === "send") {
      sends++;
      throw Object.assign(new Error("Manager returned HTTP 202."), { statusCode: 202, response: { code: -1, delivery: { deliveryId: "delivery-original" } } });
    }
    assert.equal(payload.action, "read");
    assert.equal(payload.deliveryId, "delivery-original");
    return { delivery: { state: accepted ? "accepted" : "missing" } };
  };
  try {
    await assert.rejects(new MemoryConsolidationAgent(options, { request }).deliver("batch", primaryMessageSource()), { code: "MEMORY_DELIVERY_UNCONFIRMED" });
    const resumed = new MemoryConsolidationAgent(options, { request });
    await assert.rejects(resumed.deliver("batch", primaryMessageSource()), { code: "MEMORY_DELIVERY_UNCONFIRMED" });
    await assert.rejects(resumed.deliver("different batch", primaryMessageSource()), { code: "MEMORY_DELIVERY_UNCONFIRMED" });
    accepted = true;
    assert.equal((await resumed.deliver("batch", primaryMessageSource())).threadId, "worker");
    assert.equal(sends, 1);
    assert.equal(JSON.parse(fs.readFileSync(options.statePath, "utf8")).pendingDelivery, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function primaryMessageSource(
  sessionId = "019f0000-0000-7000-8000-000000000001",
  sessionName = "主人格",
  agentAdapter: "codex" | "dsh" = "codex",
  workspace = "C:/Project"
) {
  return {
    type: "agent" as const,
    agentAdapter,
    agentType: "primary_persona",
    sessionId,
    sessionName,
    workspace
  };
}

test("memory consolidation delivery rejects an omitted messageSource", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-source-"));
  const agent = new MemoryConsolidationAgent({
    statePath: memoryConsolidationAgentStatePath(root),
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/Project",
    roleId: "Rabi"
  }, { request: async () => { throw new Error("request must not run"); } });

  await assert.rejects(
    agent.deliver("consolidate", undefined as never),
    /requires messageSource/
  );
});

test("dedicated memory consolidation reuses one Desktop task and defaults to GPT-5.6 Terra", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-"));
  const statePath = memoryConsolidationAgentStatePath(root);
  const calls: Array<Record<string, unknown>> = [];
  const worker = {
    id: "019f0000-0000-7000-8000-000000000020",
    title: "主人格 记忆整理",
    cwd: "C:/Project"
  };
  let created = false;
  const request = async (payload: Record<string, unknown>): Promise<Record<string, any>> => {
    calls.push(structuredClone(payload));
    if (payload.action === "resolve" && payload.createIfMissing === false && !created) {
      throw new Error("没有找到 Codex Desktop 任务");
    }
    if (payload.action === "read") {
      return { thread: { status: { type: "idle" } } };
    }
    if (payload.action === "resolve") {
      created = true;
      return { resolution: "created", thread: worker };
    }
    if (payload.action === "send") {
      return { status: "delivered", delivery: { status: "delivered" } };
    }
    throw new Error(`Unexpected action: ${String(payload.action)}`);
  };

  const agent = new MemoryConsolidationAgent({
    statePath,
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/Project",
    roleId: "Rabi",
    model: ""
  }, { request });

  const first = await agent.deliver("first consolidation request", primaryMessageSource());
  assert.equal(first.threadId, worker.id);
  const firstSend = calls.find((call) => call.action === "send");
  assert.equal(firstSend?.threadId, worker.id);
  assert.equal(firstSend?.model, "gpt-5.6-terra");
  assert.deepEqual(firstSend?.messageSource, {
    type: "agent",
    agentAdapter: "codex",
    agentType: "primary_persona",
    sessionId: "019f0000-0000-7000-8000-000000000001",
    sessionName: "主人格",
    workspace: "C:/Project"
  });
  assert.match(deliveryPayloadText(firstSend), /记忆整理 Agent 初始化/);
  assert.match(deliveryPayloadText(firstSend), /first consolidation request/);
  assert.equal(fs.existsSync(statePath), true);

  calls.length = 0;
  await agent.deliver("second consolidation request", primaryMessageSource());
  assert.equal(calls.some((call) => call.action === "resolve" && call.createIfMissing === true), false);
  const secondSend = calls.find((call) => call.action === "send");
  assert.doesNotMatch(deliveryPayloadText(secondSend), /记忆整理 Agent 初始化/);
  assert.match(deliveryPayloadText(secondSend), /second consolidation request/);
});

test("memory consolidation replaces a binding from another Primary Persona workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-workspace-"));
  const statePath = memoryConsolidationAgentStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-20T00:00:00.000Z",
    binding: {
      threadId: "019f0000-0000-7000-8000-000000000021",
      threadName: "旧主人格 记忆整理",
      workspace: "C:/OldProject",
      initializedAt: "2026-08-20T00:00:00.000Z"
    }
  }), "utf8");
  const calls: Array<Record<string, unknown>> = [];
  const agent = new MemoryConsolidationAgent({
    statePath,
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/CurrentProject",
    roleId: "Rabi"
  }, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      if (payload.action === "resolve") {
        return {
          resolution: "created",
          thread: {
            id: "019f0000-0000-7000-8000-000000000022",
            title: "主人格 记忆整理",
            cwd: "C:/CurrentProject"
          }
        };
      }
      if (payload.action === "send") return { status: "delivered" };
      throw new Error(`Unexpected action: ${String(payload.action)}`);
    }
  });

  const binding = await agent.deliver("consolidate", primaryMessageSource("019f0000-0000-7000-8000-000000000001", "主人格", "codex", "C:/CurrentProject"));

  const resolve = calls.find((call) => call.action === "resolve");
  assert.equal(resolve?.threadId, undefined);
  assert.equal(resolve?.cwd, "C:/CurrentProject");
  assert.equal(binding.threadId, "019f0000-0000-7000-8000-000000000022");
  assert.equal(binding.workspace, "C:/CurrentProject");
  assert.equal(calls.find((call) => call.action === "send")?.threadId, binding.threadId);
});

test("dedicated memory consolidation accepts a state-database task match without cwd metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-state-db-"));
  const calls: Array<Record<string, unknown>> = [];
  const agent = new MemoryConsolidationAgent({
    statePath: memoryConsolidationAgentStatePath(root),
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/Project",
    roleId: "Rabi"
  }, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      if (payload.action === "resolve") {
        return {
          resolution: "name",
          thread: {
            id: "019f0000-0000-7000-8000-000000000020",
            title: "主人格 记忆整理"
          }
        };
      }
      if (payload.action === "send") return { status: "delivered" };
      throw new Error(`Unexpected action: ${String(payload.action)}`);
    }
  });

  const binding = await agent.deliver("consolidate", primaryMessageSource());

  assert.equal(binding.workspace, "C:/Project");
  assert.equal(calls.find((call) => call.action === "send")?.cwd, "C:/Project");
});

test("DSH memory consolidation keeps an independent DSH binding and never falls back to Codex", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-dsh-"));
  const calls: Array<Record<string, any>> = [];
  const agent = new MemoryConsolidationAgent({
    statePath: memoryConsolidationAgentStatePath(root),
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "session-00000000-0000-4000-8000-000000000011",
    sourceThreadName: "DSH 主人格",
    agentAdapter: "dsh",
    workspace: "C:/Project",
    roleId: "Rabi"
  }, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      assert.notEqual(payload.agentAdapter, "codex");
      if (payload.action === "read") return { thread: { status: { type: "idle" } } };
      if (payload.action === "resolve") return {
        thread: {
          id: "session-00000000-0000-4000-8000-000000000012",
          title: payload.title,
          cwd: "C:/Project"
        }
      };
      if (payload.action === "send") return { status: "delivered" };
      throw new Error(`Unexpected action: ${String(payload.action)}`);
    }
  });

  const first = await agent.deliver("first", primaryMessageSource("session-00000000-0000-4000-8000-000000000011", "DSH 主人格", "dsh"));
  const second = await agent.deliver("second", primaryMessageSource("session-00000000-0000-4000-8000-000000000011", "DSH 主人格", "dsh"));

  assert.equal(first.agentAdapter, "dsh");
  assert.equal(second.threadId, first.threadId);
  assert.equal(calls.filter((call) => call.action === "resolve").length, 2);
  assert.equal(calls.filter((call) => call.action === "send").length, 2);
  assert.ok(calls.filter((call) => call.action === "send").every((call) => call.agentAdapter === "dsh"));
  assert.equal(calls.find((call) => call.action === "send")?.messageSource.agentAdapter, "dsh");
});
