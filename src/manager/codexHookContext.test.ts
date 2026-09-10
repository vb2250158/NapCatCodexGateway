import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planJsonFile } from "../planStorageLayout.js";
import {
  listRecentMemories,
  publishRoleKnowledgeCatalogSnapshot,
  readPlansFromStorageInWorker,
  readRoleKnowledgeCatalogSnapshot
} from "../roleKnowledge.js";
import {
  CodexHookContextService,
  parseCodexHookControl,
  type CodexHookContextRequest,
  type PlanTaskCompletionDelivery
} from "./codexHookContext.js";

function publishFixtureRoleKnowledge(roleDir: string): void {
  publishRoleKnowledgeCatalogSnapshot(roleDir, readRoleKnowledgeCatalogSnapshot(roleDir));
}

function fixture(options: {
  deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  deliverAgentCompletion?: (request: CodexHookContextRequest) => Promise<import("./agentCompletionDelivery.js").CompletionDeliveryResult[]>;
  hookEnabled?: (request: CodexHookContextRequest) => boolean;
  isManagedAgentSession?: (request: CodexHookContextRequest) => boolean;
  recordAgentRequestStop?: (request: CodexHookContextRequest) => { status: "scheduled"; reason: string; requestIds: string[]; turnId?: string };
  planStorageReady?: () => boolean;
} = {}): { root: string; rolesRoot: string; roleDir: string; storePath: string; service: CodexHookContextService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "YeYu");
  const storePath = path.join(root, "data", "codex-hook", "sessions.json");
  const timestamp = new Date().toISOString();
  const planPath = planJsonFile(roleDir, "plan-hook", "active");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.join(roleDir, "memory", "recent"), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n温柔、清楚，只根据真实上下文行动。", "utf8");
  fs.writeFileSync(path.join(roleDir, "growth.md"), "# 成长\n\n不确定时承认不确定。", "utf8");
  fs.writeFileSync(planPath, JSON.stringify({
    id: "plan-hook",
    title: "统一 Codex Hook 上下文",
    focus: "统一 Codex Hook 上下文",
    status: "执行中",
    currentStep: "复用 RabiRoute 管理机制",
    nextAction: "验证 Manager API",
    steps: [],
    taskBinding: {
      agentType: "codex",
      sessionId: "session-plan-worker",
      sessionTitle: "计划执行任务",
      workspace: root,
      completionHook: { enabled: true, gatewayId: "YeYu__reminder" }
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["统一管理"]
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), JSON.stringify({
    id: "memory-hook",
    title: "Hook 只做触发和注入",
    focus: "Hook 只做触发和注入",
    content: "人格、计划和记忆由 Rabi PC 管理。",
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["触发器和注入器"]
  }, null, 2), "utf8");
  publishFixtureRoleKnowledge(roleDir);
  return {
    root,
    rolesRoot,
    roleDir,
    storePath,
    service: new CodexHookContextService({
      rolesRoot: () => rolesRoot,
      storePath,
      deliverPlanTaskCompletion: options.deliverPlanTaskCompletion,
      deliverAgentCompletion: options.deliverAgentCompletion,
      hookEnabled: options.hookEnabled,
      isManagedAgentSession: options.isManagedAgentSession,
      recordAgentRequestStop: options.recordAgentRequestStop,
      planStorageReady: options.planStorageReady
    })
  };
}

test("Stop completion is rejected before internal plan reads or mutations while recovery is not ready", async (t) => {
  let deliveries = 0;
  const { root, storePath, service } = fixture({
    planStorageReady: () => false,
    deliverPlanTaskCompletion: async () => { deliveries += 1; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    service.handleHook({
      sessionId: "session-plan-worker",
      eventName: "Stop",
      turnId: "turn-gated",
      cwd: root,
      lastAssistantMessage: "done"
    }),
    (error: unknown) => (error as { code?: string }).code === "PLAN_STORAGE_STARTUP_UNAVAILABLE"
  );
  assert.equal(deliveries, 0);
  assert.equal(fs.existsSync(storePath), false);
});

test("persona followup reads saved config, deduplicates and delays completion delivery", async (t) => {
  let deliveries = 0;
  const { root, roleDir, storePath, service } = fixture({ deliverPlanTaskCompletion: async () => { deliveries++; } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(roleDir, "personaConfig.json");
  const saved = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  fs.writeFileSync(configPath, JSON.stringify({ ...saved, codexHooks: { ...saved.codexHooks,
    planFollowup: { enabled: true, cooldownSeconds: 0, rules: [
      { id: "execution", enabled: true, statusKeys: ["执行中"], prompt: "Check the approved work" }
    ] } } }));
  const request: CodexHookContextRequest = { sessionId: "session-plan-worker", eventName: "Stop", turnId: "followup", cwd: root, lastAssistantMessage: "Result" };
  assert.match((await service.handleHook(request)).followup!.reason, /Check the approved work/);
  assert.equal(deliveries, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(storePath, "utf8")).planFollowups).length, 1);
  assert.equal((await service.handleHook({ ...request, stopHookActive: true })).followup, undefined);
  assert.equal(deliveries, 1);
  assert.equal((await service.handleHook({ ...request, turnId: "later" })).followup, undefined);
});

test("Codex hook control markers remain strict", () => {
  assert.deepEqual(parseCodexHookControl("[rabi:use YeYu]"), { action: "bind", roleId: "YeYu" });
  assert.deepEqual(parseCodexHookControl("hello [rabi:refresh]"), { action: "refresh" });
  assert.equal(parseCodexHookControl("please use YeYu"), null);
});

test("an unbound Codex session receives no Rabi context", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({ sessionId: "session-unbound", eventName: "UserPromptSubmit", prompt: "hello" });
  assert.equal(result.binding, null);
  assert.equal(result.additionalContext, "");
});

test("a changed project file produces one Stop reminder for the bound plan", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.handleContext({
    sessionId: "session-plan-worker",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]",
    managerBaseUrl: "http://127.0.0.1:8790"
  });
  service.handleContext({
    sessionId: "session-plan-worker",
    eventName: "PostToolUse",
    turnId: "turn-project-change",
    cwd: root,
    toolName: "apply_patch",
    toolInput: "*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch",
    toolResponse: "Done!"
  });
  const first = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-project-change",
    cwd: root,
    lastAssistantMessage: "已完成实现。"
  });
  assert.equal(first.projectFileChangeReminder?.status, "delivered");
  assert.deepEqual(first.projectFileChangeReminder?.files, ["src/example.ts"]);
  assert.match(first.additionalContext, /请检查绑定计划/);
  const duplicate = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-project-change",
    cwd: root,
    lastAssistantMessage: "已完成实现。"
  });
  assert.equal(duplicate.projectFileChangeReminder?.reason, "turn_already_reminded");
});

test("a project-file reminder does not wait for slow plan-completion delivery", async (t) => {
  let completionStarted = false;
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {
      completionStarted = true;
      await new Promise<void>(() => undefined);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.handleContext({
    sessionId: "session-plan-worker",
    eventName: "PostToolUse",
    turnId: "turn-fast-reminder",
    cwd: root,
    toolName: "apply_patch",
    toolInput: "*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch",
    toolResponse: "Done!"
  });
  const result = await Promise.race([
    service.handleHook({
      sessionId: "session-plan-worker",
      eventName: "Stop",
      turnId: "turn-fast-reminder",
      cwd: root,
      lastAssistantMessage: "已完成实现。"
    }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("reminder response timed out")), 200))
  ]);
  assert.equal(completionStarted, true);
  assert.equal(result.projectFileChangeReminder?.status, "delivered");
  assert.equal(result.planTaskCompletion?.reason, "deferred_after_project_file_change_reminder");
});

test("read-only, failed, and out-of-workspace tools do not create a plan reminder", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.handleContext({ sessionId: "session-plan-worker", eventName: "UserPromptSubmit", prompt: "[rabi:use YeYu]", managerBaseUrl: "http://127.0.0.1:8790" });
  for (const request of [
    { turnId: "turn-read", toolName: "exec_command", toolInput: { cmd: "rg TODO" }, toolResponse: "ok" },
    { turnId: "turn-failed", toolName: "apply_patch", toolInput: "*** Begin Patch\n*** Update File: src/nope.ts\n*** End Patch", toolResponse: "Patch failed" },
    { turnId: "turn-outside", toolName: "apply_patch", toolInput: "*** Begin Patch\n*** Update File: C:/outside/nope.ts\n*** End Patch", toolResponse: "Done!" }
  ]) service.handleContext({ sessionId: "session-plan-worker", eventName: "PostToolUse", cwd: root, ...request });
  for (const turnId of ["turn-read", "turn-failed", "turn-outside"]) {
    const result = await service.handleHook({ sessionId: "session-plan-worker", eventName: "Stop", turnId, cwd: root });
    assert.equal(result.projectFileChangeReminder?.status, "ignored");
    assert.equal(result.projectFileChangeReminder?.reason, "no_confirmed_project_file_change");
  }
});

test("a plan task without a persona binding still receives one project-change reminder", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.handleContext({
    sessionId: "session-plan-worker",
    eventName: "PostToolUse",
    turnId: "turn-unbound-plan",
    cwd: path.join(root, "src"),
    toolName: "apply_patch",
    toolInput: "*** Begin Patch\n*** Update File: example.ts\n*** End Patch",
    toolResponse: "Done!"
  });
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-unbound-plan",
    cwd: path.join(root, "src")
  });
  assert.equal(result.projectFileChangeReminder?.status, "delivered");
  assert.deepEqual(result.projectFileChangeReminder?.files, ["src/example.ts"]);
});

test("structured patches and supported PowerShell writes merge into one turn reminder", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const request of [
    { toolName: "apply_patch", toolInput: { patch: "*** Begin Patch\n*** Update File: src/first.ts\n*** End Patch" } },
    { toolName: "exec_command", toolInput: { cmd: "Set-Content -Path src/second.ts -Value ready" } }
  ]) service.handleContext({ sessionId: "session-plan-worker", eventName: "PostToolUse", turnId: "turn-structured-write", cwd: root, toolResponse: "Done!", ...request });
  const result = await service.handleHook({ sessionId: "session-plan-worker", eventName: "Stop", turnId: "turn-structured-write", cwd: root });
  assert.equal(result.projectFileChangeReminder?.status, "delivered");
  assert.deepEqual(result.projectFileChangeReminder?.files, ["src/first.ts", "src/second.ts"]);
});

test("PowerShell named write destinations are tracked without treating flags or copy sources as files", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const command of [
    "Out-File -FilePath src/output.md -InputObject ready",
    "New-Item -Path src/new.ts -ItemType File",
    "Remove-Item -LiteralPath src/removed.ts",
    "Copy-Item -Path src/source.ts -Destination src/copied.ts",
    "Move-Item -Path src/old.ts -Destination src/moved.ts"
  ]) service.handleContext({ sessionId: "session-plan-worker", eventName: "PostToolUse", turnId: "turn-powershell-named", cwd: root, toolName: "exec_command", toolInput: { cmd: command }, toolResponse: "Done!" });
  const result = await service.handleHook({ sessionId: "session-plan-worker", eventName: "Stop", turnId: "turn-powershell-named", cwd: root });
  assert.equal(result.projectFileChangeReminder?.status, "delivered");
  assert.deepEqual(result.projectFileChangeReminder?.files, ["src/copied.ts", "src/moved.ts", "src/new.ts", "src/output.md", "src/removed.ts"]);
});

test("one task may receive one reminder covering multiple bound plans in the same workspace", async (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = JSON.parse(fs.readFileSync(planJsonFile(roleDir, "plan-hook", "active"), "utf8"));
  const secondPlanPath = planJsonFile(roleDir, "plan-hook-second", "active");
  fs.mkdirSync(path.dirname(secondPlanPath), { recursive: true });
  fs.writeFileSync(secondPlanPath, JSON.stringify({
    ...original,
    id: "plan-hook-second",
    title: "第二个绑定计划",
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
  readPlansFromStorageInWorker(roleDir);
  service.handleContext({
    sessionId: "session-plan-worker",
    eventName: "PostToolUse",
    turnId: "turn-multiple-plans",
    cwd: root,
    toolName: "apply_patch",
    toolInput: "*** Begin Patch\n*** Update File: src/shared.ts\n*** End Patch",
    toolResponse: "Done!"
  });
  const result = await service.handleHook({ sessionId: "session-plan-worker", eventName: "Stop", turnId: "turn-multiple-plans", cwd: root });
  assert.equal(result.projectFileChangeReminder?.status, "delivered");
  assert.deepEqual(new Set(result.projectFileChangeReminder?.planIds), new Set(["plan-hook", "plan-hook-second"]));
  assert.match(result.additionalContext, /第二个绑定计划/);
});

test("unfinished project-change turns are bounded per Codex session", (t) => {
  const { root, storePath, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 65; index += 1) {
    service.handleContext({
      sessionId: "session-plan-worker",
      eventName: "PostToolUse",
      turnId: `turn-unfinished-${index}`,
      cwd: root,
      toolName: "apply_patch",
      toolInput: `*** Begin Patch\n*** Update File: src/${index}.ts\n*** End Patch`,
      toolResponse: "Done!"
    });
  }
  const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const changes = stored.projectFileChanges["session-plan-worker"];
  assert.equal(Object.keys(changes).length, 64);
  assert.equal(changes["turn-unfinished-0"], undefined);
  assert.ok(changes["turn-unfinished-64"]);
});

test("binding and base context are owned by Rabi Manager", (t) => {
  const { root, storePath, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({
    sessionId: "session-yeyu",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]",
    managerBaseUrl: "http://127.0.0.1:8790"
  });
  assert.equal(result.binding?.roleId, "YeYu");
  assert.match(result.additionalContext, /人格、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理/);
  assert.match(result.additionalContext, /温柔、清楚/);
  assert.doesNotMatch(result.additionalContext, /plan-hook/);
  assert.ok(fs.existsSync(storePath));
  assert.ok(result.additionalContext.length <= 6200);
});

test("default Codex hook context keeps unrelated plan and memory indexes on demand", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({
    sessionId: "session-focused",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]",
    managerBaseUrl: "http://127.0.0.1:8790"
  });
  assert.doesNotMatch(result.additionalContext, /plan-hook/);
  assert.doesNotMatch(result.additionalContext, /memory-hook/);
  assert.match(result.additionalContext, /按需查询/);
  assert.match(result.additionalContext, /处理前上下文确认/);
});

test("legacy context injection mode restores full indexes", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), JSON.stringify({
    contextInjection: { mode: "legacy" }
  }), "utf8");
  const result = service.handleContext({
    sessionId: "session-legacy",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]"
  });
  assert.match(result.additionalContext, /plan-hook/);
  assert.match(result.additionalContext, /memory-hook/);
  assert.match(result.additionalContext, /可用 API 提示/);
});

test("focused context is materially smaller than legacy context for the same role", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(roleDir, "persona.md"), `# 夜雨\n\n${"人格核心与边界。".repeat(700)}`, "utf8");

  const focused = service.handleContext({
    sessionId: "session-size-focused",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]"
  }).additionalContext;
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), JSON.stringify({
    contextInjection: { mode: "legacy" }
  }), "utf8");
  const legacy = service.handleContext({
    sessionId: "session-size-legacy",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]"
  }).additionalContext;

  assert.ok(focused.length + 1200 < legacy.length, `${focused.length} should be materially below ${legacy.length}`);
});

test("prompt recall uses roleKnowledgeSnapshot and refreshes memory viewedAt", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-recall", "YeYu");
  service.handleContext({ sessionId: "session-recall", eventName: "SessionStart", source: "startup" });
  const result = service.handleContext({
    sessionId: "session-recall",
    eventName: "UserPromptSubmit",
    prompt: "这个 Hook 应该只是触发器和注入器"
  });
  assert.match(result.additionalContext, /memory-hook/);
  assert.match(result.additionalContext, /GET \/api\/roles\/YeYu\/memory\/recent\/memory-hook/);
  assert.doesNotMatch(result.additionalContext, /\[人格工作集\]/);
  const memory = listRecentMemories(roleDir).find((item) => item.id === "memory-hook");
  assert.ok(memory);
  assert.equal(typeof memory.viewedAt, "string");
});

test("Rabi PC can proactively bind and unbind an exact Codex session", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = service.bindSession("session-direct", "YeYu");
  assert.equal(service.getBinding("session-direct")?.roleId, "YeYu");
  assert.equal(service.listBindings().length, 1);
  assert.equal(service.unbindSession("session-direct")?.sessionId, binding.sessionId);
  assert.equal(service.getBinding("session-direct"), null);
});

test("reasoning hooks inject new keyword matches once per turn", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-reasoning", "YeYu");
  service.handleContext({ sessionId: "session-reasoning", eventName: "SessionStart", source: "startup" });
  service.handleContext({
    sessionId: "session-reasoning",
    eventName: "UserPromptSubmit",
    turnId: "turn-1",
    prompt: "继续处理"
  });
  const pre = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PreToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" }
  });
  assert.match(pre.additionalContext, /Rabi 推理期上下文刷新/);
  assert.match(pre.additionalContext, /memory-hook/);
  const firstViewedAt = listRecentMemories(roleDir).find((item) => item.id === "memory-hook")?.viewedAt;
  const duplicatePost = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" },
    toolResponse: "触发器和注入器"
  });
  assert.equal(duplicatePost.additionalContext, "");
  assert.equal(
    listRecentMemories(roleDir).find((item) => item.id === "memory-hook")?.viewedAt,
    firstViewedAt
  );
  const nextTurn = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-2",
    toolName: "Bash",
    toolUseId: "tool-2",
    toolResponse: "触发器和注入器"
  });
  assert.match(nextTurn.additionalContext, /memory-hook/);
});

test("irrelevant reasoning hooks remain silent", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-quiet", "YeYu");
  service.handleContext({ sessionId: "session-quiet", eventName: "SessionStart" });
  const result = service.handleContext({
    sessionId: "session-quiet",
    eventName: "PreToolUse",
    turnId: "turn-quiet",
    toolName: "Bash",
    toolInput: { command: "npm test" }
  });
  assert.equal(result.additionalContext, "");
});

test("disabled Codex endpoint hooks stay silent and do not deliver completion reminders", async (t) => {
  let deliveryCount = 0;
  const { root, service } = fixture({
    hookEnabled: () => false,
    deliverPlanTaskCompletion: async () => { deliveryCount += 1; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");

  const context = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:refresh]"
  });
  assert.equal(context.additionalContext, "");
  const completion = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-disabled",
    cwd: root,
    lastAssistantMessage: "不应投递。"
  });
  assert.equal(completion.planTaskCompletion?.status, "ignored");
  assert.equal(completion.planTaskCompletion?.reason, "hook_disabled_by_codex_endpoint");
  assert.equal(deliveryCount, 0);
});

test("Stop hooks deliver a bound plan task final message once through Manager", async (t) => {
  const deliveries: PlanTaskCompletionDelivery[] = [];
  const { root, storePath, service } = fixture({
    deliverPlanTaskCompletion: async (delivery) => {
      deliveries.push(delivery);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-1",
    cwd: root,
    lastAssistantMessage: "实现完成，测试通过。"
  });
  assert.equal(first.binding, null);
  assert.equal(first.additionalContext, "");
  assert.equal(first.planTaskCompletion?.status, "delivered");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.plan.id, "plan-hook");
  assert.equal(deliveries[0]?.gatewayId, "YeYu__reminder");
  assert.equal(deliveries[0]?.finalMessage, "实现完成，测试通过。");

  const duplicate = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-1",
    cwd: root,
    lastAssistantMessage: "实现完成，测试通过。"
  });
  assert.equal(duplicate.planTaskCompletion?.status, "duplicate");
  assert.equal(deliveries.length, 1);
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(Object.values(store.planTaskCompletions).some((state: any) => (
    state.sessionId === "session-plan-worker"
    && state.turnId === "turn-plan-1"
    && state.status === "delivered"
  )), true);
});

test("paused plans do not deliver bound task completion reminders", async (t) => {
  let deliveryCount = 0;
  const { root, roleDir, service } = fixture({
    deliverPlanTaskCompletion: async () => { deliveryCount += 1; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = planJsonFile(roleDir, "plan-hook", "active");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  fs.writeFileSync(planPath, JSON.stringify({ ...plan, status: "暂停" }, null, 2), "utf8");
  publishFixtureRoleKnowledge(roleDir);

  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-paused",
    cwd: root,
    lastAssistantMessage: "暂停期间不应唤醒人格任务。"
  });

  assert.equal(result.planTaskCompletion?.status, "ignored");
  assert.equal(result.planTaskCompletion?.reason, "no_enabled_plan_task_binding");
  assert.equal(deliveryCount, 0);
});

test("managed Codex tasks cannot bypass the Rabi Agent bridge for persistent task delivery", async (t) => {
  const { root, service } = fixture({ isManagedAgentSession: () => true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "PreToolUse",
    toolName: "send_message_to_thread",
    toolInput: { threadId: "other-task", message: "结果" },
    cwd: root
  });
  assert.equal(result.toolDecision?.permissionDecision, "deny");
  assert.match(result.toolDecision?.reason || "", /responsePolicy/);
  assert.match(result.toolDecision?.reason || "", /inReplyToRequestId/);
});

test("Stop records unanswered Agent requests even when plan completion Hook delivery is disabled", async (t) => {
  const stops: CodexHookContextRequest[] = [];
  const { root, service } = fixture({
    hookEnabled: () => false,
    recordAgentRequestStop: (request) => {
      stops.push(request);
      return { status: "scheduled", reason: "target_turn_ended_without_response", requestIds: ["agent-request-1"], turnId: request.turnId };
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-agent-request",
    cwd: root,
    lastAssistantMessage: "调查完成。"
  });
  assert.equal(stops.length, 1);
  assert.equal(result.agentRequestStop?.status, "scheduled");
  assert.deepEqual(result.agentRequestStop?.requestIds, ["agent-request-1"]);
  assert.equal(result.planTaskCompletion?.reason, "hook_disabled_by_codex_endpoint");
});

test("completed plans suppress completion reminders while retaining business binding history", async (t) => {
  let deliveryCount = 0;
  const { root, roleDir, service } = fixture({
    deliverPlanTaskCompletion: async () => { deliveryCount += 1; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = planJsonFile(roleDir, "plan-hook", "active");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  fs.writeFileSync(planPath, JSON.stringify({ ...plan, status: "完成" }, null, 2), "utf8");
  publishFixtureRoleKnowledge(roleDir);

  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-after-complete",
    cwd: root,
    lastAssistantMessage: "计划已完成，业务绑定保留为历史证据且不再触发提醒。"
  });

  assert.equal(result.planTaskCompletion?.status, "ignored");
  assert.equal(result.planTaskCompletion?.reason, "no_enabled_plan_task_binding");
  assert.equal(deliveryCount, 0);
});

test("Stop hook deduplication survives later turns in the same session", async (t) => {
  const deliveries: PlanTaskCompletionDelivery[] = [];
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async (delivery) => {
      deliveries.push(delivery);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const turnId of ["turn-plan-1", "turn-plan-2", "turn-plan-1"]) {
    await service.handleHook({
      sessionId: "session-plan-worker",
      eventName: "Stop",
      turnId,
      cwd: root,
      lastAssistantMessage: `final ${turnId}`
    });
  }

  assert.deepEqual(deliveries.map((item) => item.sourceTurnId), ["turn-plan-1", "turn-plan-2"]);
});

test("Stop hooks fail closed on a plan task workspace mismatch", async (t) => {
  let called = false;
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {
      called = true;
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-mismatch",
    cwd: path.join(root, "other-project"),
    lastAssistantMessage: "不应投递。"
  });
  assert.equal(result.planTaskCompletion?.status, "failed");
  assert.equal(result.planTaskCompletion?.reason, "workspace_mismatch");
  assert.equal(called, false);
});

test("Stop hook delivery failures are recorded without blocking the Codex turn", async (t) => {
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {
      throw new Error("reminder gateway offline");
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-failed",
    cwd: root,
    lastAssistantMessage: "阶段结果已经生成。"
  });
  assert.equal(result.additionalContext, "");
  assert.equal(result.planTaskCompletion?.status, "failed");
  assert.match(result.planTaskCompletion?.error || "", /reminder gateway offline/);
  const binding = service.getBinding("session-plan-worker");
  assert.equal(binding?.lastPlanCompletionStatus, "failed");
  assert.match(binding?.lastPlanCompletionError || "", /reminder gateway offline/);
});




test("bound tasks forward the entire final to configured event delivery without business-specific progress", async t => {
  const messages: string[] = [];
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {},
    deliverAgentCompletion: async request => { messages.push(request.lastAssistantMessage!); return [{ ruleId: "configured", status: "sent" }]; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const final = "文档已写好：\n\n[说明](https://example.com/mechanism)\n\n机制：保留完整内容。\n验证：等待实际验收。";
  const result = await service.handleHook({ sessionId: "session-plan-worker", eventName: "Stop", turnId: "full-final", cwd: root, lastAssistantMessage: final });
  assert.deepEqual(messages, [final]);
  assert.deepEqual(result.completionDeliveries, [{ ruleId: "configured", status: "sent" }]);
});
