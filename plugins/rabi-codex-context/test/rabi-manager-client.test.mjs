import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { handleHookInput } from "../scripts/lib/rabi-manager-client.mjs";

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  return {
    instance,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()))
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runHookCommand(command, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env, windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("the hook forwards the original event and injects only Manager output", async (t) => {
  let received;
  const mock = await server(async (request, response) => {
    assert.equal(request.url, "/api/codex-hook/context");
    received = await readBody(request);
    json(response, 200, { code: 0, data: { additionalContext: "[Rabi Manager]\n统一上下文" } });
  });
  t.after(() => mock.close());
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-manager",
    prompt: "触发器和注入器",
    cwd: "C:\\workspace"
  };
  const output = await handleHookInput(input, { managerUrl: mock.url });
  assert.deepEqual(received, input);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(output.hookSpecificOutput.additionalContext, "[Rabi Manager]\n统一上下文");
});

test("Stop applies Manager persona followup once without interpreting reply text", async (t) => {
  const followup = { decision: "block", reason: "Configured followup" };
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { followup } }));
  t.after(() => mock.close());
  assert.deepEqual(await handleHookInput({ hook_event_name: "Stop", session_id: "worker" }, { managerUrl: mock.url }), followup);
  assert.equal(await handleHookInput({ hook_event_name: "Stop", session_id: "worker", stop_hook_active: true }, { managerUrl: mock.url }), null);
});

test("an unbound Manager response produces no hook output", async (t) => {
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { additionalContext: "" } }));
  t.after(() => mock.close());
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "unbound", prompt: "hello" }, { managerUrl: mock.url });
  assert.equal(output, null);
});

test("PreToolUse injects Manager context without unsupported continue output", async (t) => {
  let received;
  const mock = await server(async (request, response) => {
    received = await readBody(request);
    json(response, 200, { code: 0, data: { additionalContext: "reasoning delta" } });
  });
  t.after(() => mock.close());
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "session-reasoning",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "echo memory-hook" }
  };
  const output = await handleHookInput(input, { managerUrl: mock.url });
  assert.deepEqual(received, input);
  assert.equal(output.continue, undefined);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.additionalContext, "reasoning delta");
});

test("PreToolUse returns the supported deny shape for direct Agent task delivery", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: {
      toolDecision: {
        permissionDecision: "deny",
        reason: "请改用 RabiRoute Agent 任务桥并填写 responsePolicy。"
      }
    }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "PreToolUse",
    session_id: "session-rabi-agent",
    tool_name: "send_message_to_thread",
    tool_input: { threadId: "target" }
  }, { managerUrl: mock.url });
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /responsePolicy/);
  assert.equal(output.continue, undefined);
});

test("Stop forwards the final assistant message but emits no hook output", async (t) => {
  let received;
  const mock = await server(async (request, response) => {
    received = await readBody(request);
    json(response, 200, { code: 0, data: { planTaskCompletion: { status: "delivered" } } });
  });
  t.after(() => mock.close());
  const input = {
    hook_event_name: "Stop",
    session_id: "session-plan-worker",
    turn_id: "turn-plan-1",
    stop_hook_active: false,
    last_assistant_message: "实现完成，测试通过。"
  };
  const output = await handleHookInput(input, { managerUrl: mock.url });
  assert.deepEqual(received, input);
  assert.equal(output, null);
});

test("Stop returns one non-blocking reminder after confirmed project file changes", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: {
      planTaskCompletion: { status: "failed", error: "completion recipient unavailable" },
      projectFileChangeReminder: { status: "delivered", planId: "plan-hook", files: ["src/example.ts"] }
    }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "Stop",
    session_id: "session-plan-worker",
    turn_id: "turn-project-change"
  }, { managerUrl: mock.url });
  assert.match(output.systemMessage, /项目文件/);
  assert.match(output.systemMessage, /currentStep/);
  assert.match(output.systemMessage, /completion recipient unavailable/);
  assert.equal(output.continue, undefined);
});

test("Stop ignores unrelated application payloads", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: {
      unrelatedNotification: {
        status: "failed",
        reason: "UNRELATED_CONTEXT_REQUIRED"
      }
    }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "Stop",
    session_id: "session-example",
    turn_id: "turn-missing-context"
  }, { managerUrl: mock.url });
  assert.equal(output, null);
});

test("Stop surfaces a non-blocking system warning when reminder delivery fails", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: { planTaskCompletion: { status: "failed", error: "reminder gateway offline" } }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "Stop",
    session_id: "session-plan-worker",
    turn_id: "turn-plan-failed",
    last_assistant_message: "阶段结果"
  }, { managerUrl: mock.url });
  assert.match(output.systemMessage, /reminder gateway offline/);
  assert.equal(output.continue, undefined);
});

test("Stop names both reminder kinds when Manager cannot be reached", async () => {
  const output = await handleHookInput({ hook_event_name: "Stop", session_id: "offline-stop", turn_id: "turn-offline" }, {
    managerUrl: "http://127.0.0.1:1",
    timeoutMs: 200
  });
  assert.match(output.systemMessage, /计划完成提醒/);
  assert.match(output.systemMessage, /项目文件改动检查提醒/);
  assert.match(output.systemMessage, /未送达/);
  assert.equal(output.continue, undefined);
});

test("Stop surfaces an Agent request scheduling failure without continuing the turn", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: {
      planTaskCompletion: { status: "ignored" },
      agentRequestStop: { status: "failed", error: "request store unavailable" }
    }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "Stop",
    session_id: "session-agent",
    turn_id: "turn-agent-1"
  }, { managerUrl: mock.url });
  assert.match(output.systemMessage, /request store unavailable/);
  assert.equal(output.continue, undefined);
});

test("explicit control receives a fail-open diagnostic when Manager is unavailable", async () => {
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "offline", prompt: "[rabi:use YeYu]" }, {
    managerUrl: "http://127.0.0.1:1",
    timeoutMs: 200
  });
  assert.match(output.hookSpecificOutput.additionalContext, /Rabi PC Manager 当前不可用/);
  assert.match(output.hookSpecificOutput.additionalContext, /不得使用插件本地缓存补造上下文/);
});

test("the plugin hook command imports from PLUGIN_ROOT and reaches Manager", async (t) => {
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { additionalContext: "process integration" } }));
  t.after(() => mock.close());
  const pluginRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-process",
    prompt: "hello"
  }, { ...process.env, PLUGIN_ROOT: pluginRoot, RABI_MANAGER_URL: mock.url });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "process integration");
});

test("the plugin registers entry, reasoning, and turn-completion lifecycle hooks", async () => {
  const pluginRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("the plugin stays self-contained and does not replace unrelated Codex hooks", async () => {
  const pluginRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks)
    .flatMap((groups) => groups)
    .flatMap((group) => group.hooks)
    .map((hook) => hook.command);

  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.match(command, /PLUGIN_ROOT/);
    assert.doesNotMatch(command, /\.codex|\.agents|config\.toml|marketplace\.json|codex-language-style/i);
  }
});
