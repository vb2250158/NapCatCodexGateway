import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { AgentCompletionDeliveryService, completionProjectIdentity, completionTaskContextFromPlans, deliverCompletionToEndpoint, type CompletionRuleOwner } from "./agentCompletionDelivery.js";
import { CodexHookContextService, type CodexHookContextRequest } from "./codexHookContext.js";

const owner: CompletionRuleOwner = { roleId: "test", rule: { id: "rule", enabled: true,
  event: "task_completed", conditions: [{ type: "project", path: "/project" }],
  destination: { channel: "napcat", gatewayId: "route", params: { target: "group", instanceId: "qq", targetId: "12345" } } } };
const event = { eventName: "Stop" as const, sessionId: "agent-1", turnId: "turn-1", cwd: "/project", lastAssistantMessage: "Done" };

test("session allow and deny lists match exact IDs, combine with project and plan, and deny wins", async () => {
  const sent: string[] = [];
  const service = new AgentCompletionDeliveryService({
    rules: () => [{ ...owner, rule: { ...owner.rule, conditions: [...owner.rule.conditions,
      { type: "bound_plan" },
      { type: "include_sessions", sessions: [{ id: "agent-1", name: "Old title" }, { id: "agent-2", name: "Same title" }, { id: "unbound", name: "Other" }] },
      { type: "exclude_sessions", sessions: [{ id: "agent-2", name: "Changed title" }] }
    ] } }], projectIdentity: async value => value,
    taskContext: (_, request) => ({ taskName: "Renamed", plans: request.sessionId === "unbound" ? [] : [{ id: "p", title: "Plan" }] }),
    deliver: async (_, request) => { sent.push(request.sessionId); }
  });
  for (const sessionId of ["agent-1", "agent-2", "agent-10", "unbound"]) await service.handle({ ...event, sessionId });
  await service.handle({ ...event, cwd: "/other" });
  assert.deepEqual(sent, ["agent-1"]);
  const denyOnly = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: { ...owner.rule,
    conditions: [{ type: "exclude_sessions", sessions: [{ id: "agent-1", name: "Name" }] }] } }],
    deliver: async (_, request) => { sent.push(request.sessionId); } });
  await denyOnly.handle(event);
  await denyOnly.handle({ ...event, sessionId: "another" });
  assert.deepEqual(sent, ["agent-1", "another"]);
});

test("plan requirement skips unbound tasks and uses the current task title with actual bindings", async () => {
  const plans = [
    { id: "plan-1", title: "修复登录窗口", taskBinding: { agentType: "codex" as const, sessionId: "agent-1", sessionTitle: "旧任务名" } },
    { id: "plan-2", title: "其它任务的计划", taskBinding: { agentType: "codex" as const, sessionId: "other" } },
    { id: "plan-3", title: "DSH 的计划", taskBinding: { agentType: "dsh" as const, sessionId: "agent-1" } }
  ];
  const context = completionTaskContextFromPlans("agent-1", plans, "当前任务名");
  assert.equal(context.taskName, "当前任务名");
  assert.deepEqual(context.plans, [{ id: "plan-1", title: "修复登录窗口" }]);
  assert.equal(completionTaskContextFromPlans("agent-1", plans).taskName, "旧任务名");
  const calls: string[] = [];
  const service = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: { ...owner.rule, conditions: [...owner.rule.conditions, { type: "bound_plan" }] } }],
    projectIdentity: async value => value, taskContext: (_, hook) => completionTaskContextFromPlans(hook.sessionId, plans),
    deliver: async (_, hook) => { calls.push(hook.sessionId); } });
  await service.handle({ ...event, sessionId: "unbound" });
  await service.handle(event);
  assert.deepEqual(calls, ["agent-1"]);
  const optional = new AgentCompletionDeliveryService({ rules: () => [owner], projectIdentity: async value => value,
    taskContext: () => ({ plans: [] }), deliver: async (_, hook) => { calls.push(hook.sessionId); } });
  await optional.handle({ ...event, sessionId: "unbound" });
  assert.deepEqual(calls, ["agent-1", "unbound"]);
});

test("completion rules cover every session in the project, isolate other projects and DSH, and coalesce repeated targets", async () => {
  const sends: string[] = [];
  const service = new AgentCompletionDeliveryService({ rules: () => [owner, { ...owner, rule: { ...owner.rule, id: "duplicate" } }],
    projectIdentity: async value => value, deliver: async (_, __, id) => { sends.push(id); } });
  assert.equal((await service.handle(event)).length, 1);
  await service.handle({ ...event, sessionId: "agent-2" });
  await service.handle({ ...event, cwd: "/project-other" });
  await service.handle({ ...event, agentType: "dsh" });
  await service.handle({ ...event, turnId: "" });
  await service.handle({ ...event, lastAssistantMessage: " " });
  assert.equal(sends.length, 2);
  assert.notEqual(sends[0], sends[1]);
});

test("concurrent Stop callbacks share one delivery and retain a stable identity after restart", async () => {
  const sends: string[] = [];
  const options = { rules: () => [owner], projectIdentity: async (value: string) => value,
    deliver: async (_: unknown, __: unknown, id: string) => { sends.push(id); await Promise.resolve(); } };
  const service = new AgentCompletionDeliveryService(options);
  await Promise.all([service.handle(event), service.handle(event)]);
  assert.equal(sends.length, 1);
  await new AgentCompletionDeliveryService(options).handle(event);
  assert.equal(sends[1], sends[0]);
});

test("a failed target reports failure without suppressing another target", async () => {
  const service = new AgentCompletionDeliveryService({ rules: () => [owner, { ...owner, rule: { ...owner.rule, id: "second", destination: { ...owner.rule.destination, params: { ...owner.rule.destination.params, targetId: "67890" } } } }],
    projectIdentity: async value => value, deliver: async ({ rule }) => { if (rule.id === "rule") throw new Error("offline"); } });
  assert.deepEqual((await service.handle(event)).map(result => result.status), ["failed", "sent"]);
});

test("Git worktrees share the project identity while another repository does not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-git-"));
  const repo = path.join(root, "repo"); const worktree = path.join(root, "worktree"); const other = path.join(root, "other");
  const git = (args: string[]) => execFileSync("git", args, { windowsHide: true, stdio: "pipe" });
  try {
    git(["init", repo]); git(["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    git(["-C", repo, "worktree", "add", "--detach", worktree]); git(["init", other]);
    assert.equal(await completionProjectIdentity(repo), await completionProjectIdentity(worktree));
    assert.notEqual(await completionProjectIdentity(repo), await completionProjectIdentity(other));
    fs.mkdirSync(path.join(repo, "app")); fs.mkdirSync(path.join(worktree, "app"));
    assert.equal(await completionProjectIdentity(path.join(repo, "app")), await completionProjectIdentity(path.join(worktree, "app")));
    assert.notEqual(await completionProjectIdentity(repo), await completionProjectIdentity(path.join(repo, "app")), "separate Codex projects in a monorepo remain isolated");
    await assert.rejects(completionProjectIdentity("relative/path"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Stop completion delivery works without binding individual sessions and obeys startup recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-hook-"));
  const calls: string[] = [];
  const options = { rolesRoot: () => root, storePath: path.join(root, "sessions.json"), hookEnabled: () => false,
    deliverAgentCompletion: async (request: CodexHookContextRequest) => { calls.push(request.sessionId); return []; } };
  try {
    await new CodexHookContextService(options).handleHook(event);
    assert.deepEqual(calls, ["agent-1"]);
    await new CodexHookContextService({ ...options,
      recordAgentRequestStop: () => ({ status: "failed", reason: "completion_check_failed" })
    }).handleHook(event);
    assert.equal(calls.length, 1, "a failed completion check must not announce completion");
    await assert.rejects(new CodexHookContextService({ ...options, planStorageReady: () => false }).handleHook(event));
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completion reaches the selected group through Outbox and repeated events reuse the persistent receipt", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-send-"));
  const messages: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      messages.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 45678 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"),
    runtimes: [{ id: "route", enabled: true, napcatInstances: [{ id: "qq", httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "", enabled: true }] }] };
  try {
    const create = () => new AgentCompletionDeliveryService({ rules: () => [owner], projectIdentity: async value => value,
      taskContext: () => ({ taskName: "修复登录失败", plans: [{ id: "plan-1", title: "登录窗口修复计划" }] }),
      deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", options, context) });
    assert.equal((await create().handle(event))[0].status, "sent");
    assert.equal((await create().handle(event))[0].status, "sent");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].group_id, 12345);
    assert.match(String(messages[0].message), /Done/);
    assert.match(String(messages[0].message), /任务：修复登录失败/);
    assert.match(String(messages[0].message), /计划：登录窗口修复计划/);
    assert.doesNotMatch(String(messages[0].message), /项目：|\/project|agent-1/);
    assert.doesNotMatch(String(messages[0].message), /CQ:reply/);
    const changed = await create().handle({ ...event, lastAssistantMessage: "Changed final" });
    assert.equal(changed[0].status, "failed", "a changed payload cannot silently reuse the old identity");
    assert.equal(messages.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("endpoint selection delivers to private QQ or speech with independent parameters and receipts", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-endpoints-"));
  const received: Array<{ url?: string; body: Record<string, unknown> }> = [];
  let includePlaybackJob = true;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      received.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json", ...(includePlaybackJob ? { "x-rabispeech-playback-job": "speech-job-1" } : {}) });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 56789 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const options = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"), speechServiceUrl: url,
    runtimes: [{ id: "route", enabled: true, napcatInstances: [{ id: "qq", httpUrl: url, accessToken: "", enabled: true }],
      messageAdapterPolicies: { speech: { outputEnabled: true, supportedOutputs: ["text" as const] } } }] };
  const privateRule = { ...owner.rule, destination: { channel: "napcat", gatewayId: "route",
    params: { target: "private", targetId: "67890", instanceId: "qq" } } };
  const speechRule = { ...owner.rule, id: "speech", conditions: [], destination: { channel: "speech", gatewayId: "route", params: {} } };
  const create = () => new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: privateRule }, { ...owner, rule: speechRule }],
    projectIdentity: async value => value,
    deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", options, context) });
  try {
    const first = await create().handle(event);
    assert.deepEqual(first.map(result => result.status), ["sent", "sent"], JSON.stringify(first));
    const repeated = await create().handle(event);
    assert.deepEqual(repeated.map(result => result.status), ["sent", "sent"], JSON.stringify(repeated));
    assert.equal(received.length, 2);
    assert.equal(received[0].url, "/send_private_msg");
    assert.equal(received[0].body.user_id, 67890);
    assert.equal(received[0].body.group_id, undefined);
    assert.equal(received[1].url, "/v1/audio/speech");
    assert.equal(received[1].body.user_id, undefined);
    includePlaybackJob = false;
    const synthesisOnly = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: speechRule }],
      deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", options, context) });
    assert.equal((await synthesisOnly.handle({ ...event, turnId: "synthesis-only", cwd: undefined }))[0].status, "sent");
    assert.equal((await synthesisOnly.handle({ ...event, turnId: "synthesis-only", cwd: undefined }))[0].status, "sent");
    assert.equal(received.length, 3, "synthesis without a playback job still has an authoritative receipt");
    assert.deepEqual(await create().handle({ ...event, eventName: "PreToolUse" }), []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
