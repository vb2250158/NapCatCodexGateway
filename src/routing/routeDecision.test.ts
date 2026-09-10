import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RouteProfile } from "../config.js";
import type { GroupMessageRecord, HeartbeatEventRecord, ManualTriggerRecord, PlanFeedbackMessageRecord, VoiceTranscriptEventRecord } from "../history.js";
import { resolvePipeline } from "../pipelines.js";
import { buildAgentPacket as buildPublishedAgentPacket, type AgentPacket, type AgentRoleContext } from "./agentPacket.js";
import { publishRoleKnowledgeCatalogSnapshot, readRoleKnowledgeCatalogSnapshot } from "../roleKnowledge.js";
import { createRouteDecision, type RouteDecision } from "./routeDecision.js";

function buildAgentPacket(
  decision: RouteDecision,
  rule: RouteDecision["matchedRules"][number],
  roleContext: AgentRoleContext
): AgentPacket {
  if (roleContext.roleDir) {
    publishRoleKnowledgeCatalogSnapshot(roleContext.roleDir, readRoleKnowledgeCatalogSnapshot(roleContext.roleDir));
  }
  return buildPublishedAgentPacket(decision, rule, roleContext);
}

function routeProfile(patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "main",
    name: "Main route",
    enabled: true,
    recentMessageLimit: 10,
    resolvedPipeline: resolvePipeline("qq_chat"),
    agentRoleFile: "persona.md",
    rolesDir: "data/roles",
    routeVariables: {},
    notificationRules: [],
    ...patch
  };
}

function groupMessage(patch: Partial<GroupMessageRecord> = {}): GroupMessageRecord {
  return {
    time: 1710000000,
    groupId: 10001,
    userId: 42,
    rawMessage: "[CQ:at,qq=12345] hello",
    messageId: "msg-1",
    senderName: "Alice",
    ...patch
  };
}

function voiceTranscript(patch: Partial<VoiceTranscriptEventRecord> = {}): VoiceTranscriptEventRecord {
  return {
    time: 1710000000,
    rawMessage: "语音输入测试",
    messageId: "voice-1",
    senderName: "fennenote",
    adapterType: "fennenote",
    source: "fennenote",
    ...patch
  };
}

function manualTrigger(patch: Partial<ManualTriggerRecord> = {}): ManualTriggerRecord {
  return {
    time: 1710000000,
    rawMessage: "记忆沉淀",
    messageId: "manual-memory-consolidation",
    senderName: "RabiRoute 自动调度",
    triggerId: "memory-consolidation",
    triggerName: "记忆沉淀",
    ...patch
  };
}

function planFeedback(patch: Partial<PlanFeedbackMessageRecord> = {}): PlanFeedbackMessageRecord {
  return {
    time: 1710000000,
    rawMessage: "请确认计划改动范围。",
    messageId: "plan-feedback-1",
    senderName: "本地用户",
    roleId: "Rabi",
    adapterType: "planFeedback",
    replyContext: {
      targetType: "plan_feedback",
      planId: "plan-1"
    },
    ...patch
  };
}

test("plan feedback is an independent system event that does not depend on message rules", () => {
  const route = routeProfile({
    notificationRules: [{
      id: "role-panel-only",
      name: "role panel only",
      enabled: true,
      routeKinds: ["role_panel_message"],
      template: ""
    }]
  });

  const decision = createRouteDecision(route, "plan_feedback", planFeedback());

  assert.ok(decision);
  assert.deepEqual(decision.matchedRules.map((rule) => rule.id), ["plan-feedback"]);
  assert.equal(decision.routeKind, "plan_feedback");
});

function makeRoleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-packet-role-"));
}

function writeRecentMemory(roleDir: string, memory: Record<string, unknown>): void {
  const filePath = path.join(roleDir, "memory", "recent", `${memory.id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf8");
}

function writeSkill(roleDir: string, fileName: string, text: string): void {
  const filePath = path.join(roleDir, "skills", fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function appendJsonl(filePath: string, items: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

test("RouteDecision records matched rules and normalized route text", () => {
  const route = routeProfile({
    routeVariables: { BotAlias: "12345" },
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      regex: "@{BotAlias} hello",
      template: "matched"
    }]
  });

  const decision = createRouteDecision(route, "direct_at", groupMessage(), {
    selfId: 12345,
    repliedMessage: "[CQ:reply,id=old] previous"
  });

  assert.ok(decision);
  assert.equal(decision.matchedRules[0].id, "direct");
  assert.equal(decision.routeVariables.SenderQQId, "42");
  assert.equal(decision.routeVariables.RobotQQId, "12345");
  assert.equal(decision.routeText, "@12345 hello");
  assert.equal(decision.repliedRouteText, "[Reply:old] previous");
});

test("RouteDecision respects manual trigger rule selection", () => {
  const route = routeProfile({
    notificationRules: [
      { id: "skip", name: "skip", enabled: true, routeKinds: ["manual_trigger"], template: "skip" },
      { id: "run", name: "run", enabled: true, routeKinds: ["manual_trigger"], template: "run" }
    ]
  });

  const decision = createRouteDecision(route, "manual_trigger", groupMessage(), {
    triggerRuleId: "run"
  });

  assert.ok(decision);
  assert.deepEqual(decision.matchedRules.map((rule) => rule.id), ["run"]);
});

test("memory consolidation is a Manager-owned trigger and does not require a user notification rule", () => {
  const decision = createRouteDecision(routeProfile(), "manual_trigger", manualTrigger());

  assert.ok(decision);
  assert.deepEqual(decision.matchedRules.map((rule) => rule.id), ["memory-consolidation"]);
});

test("scheduled persona automation supplies its own Agent template without a heartbeat message rule", () => {
  const record: HeartbeatEventRecord = {
    time: 1710000000,
    rawMessage: "review open plans",
    messageId: "scheduled-review"
  };
  const decision = createRouteDecision(routeProfile(), "heartbeat", record, {
    automationRuleId: "scheduled-review",
    automationRuleName: "Daily review",
    automationTemplate: "report only new blockers"
  });

  assert.equal(decision?.matchedRules[0]?.id, "scheduled-review");
  assert.equal(decision?.matchedRules[0]?.template, "report only new blockers");
});

test("AgentPacket renders rule template and reply context from a decision", () => {
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "route={routeKind} sender={SenderQQId}"
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage(), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.equal(packet.templateValues.routeKind, "direct_at");
  assert.equal(packet.templateValues.SenderQQId, "42");
  assert.match(packet.message, /route=direct_at sender=42/);

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.routeKind, "direct_at");
  assert.equal(replyContext.outputAdapter, "qq");
  assert.equal(replyContext.replyToSource, true);
});

test("AgentPacket exposes workspace paths as relative paths", () => {
  const fixtureParent = path.join(process.cwd(), ".tmp");
  fs.mkdirSync(fixtureParent, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "route-decision-relative-"));
  try {
    const route = routeProfile({
      notificationRules: [{
        id: "direct",
        name: "direct",
        enabled: true,
        routeKinds: ["direct_at"],
        template: "role={agentRolePath} data={dataDir}"
      }]
    });
    const decision = createRouteDecision(route, "direct_at", groupMessage(), {});
    assert.ok(decision);

    const dataDir = path.join(fixtureRoot, "data", "route", "main");
    const roleDir = path.join(fixtureRoot, "data", "roles", "Rabi");
    const rolePath = path.join(roleDir, "persona.md");
    fs.mkdirSync(roleDir, { recursive: true });
    const relativeRoot = path.relative(process.cwd(), fixtureRoot).replaceAll("\\", "/");
    const packet = buildAgentPacket(decision, decision.matchedRules[0], {
      roleId: "Rabi",
      roleDir,
      rolePath,
      dataDir
    });

    assert.equal(packet.templateValues.dataDir, `${relativeRoot}/data/route/main`);
    assert.equal(packet.templateValues.agentRoleDir, `${relativeRoot}/data/roles/Rabi`);
    assert.equal(packet.templateValues.agentRolePath, `${relativeRoot}/data/roles/Rabi/persona.md`);
    assert.equal(packet.templateValues.groupLogPath, `${relativeRoot}/data/route/main/group-messages.jsonl`);
    assert.equal(packet.templateValues.agentInterfaceDocPath, "docs/rabi-agent-interfaces.md");
    assert.match(packet.message, new RegExp(`角色文件：${relativeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/data\/roles\/Rabi\/persona\.md`));
    assert.doesNotMatch(packet.message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
    assert.equal(replyContext.dataDir, `${relativeRoot}/data/route/main`);
    assert.equal(replyContext.groupLogPath, `${relativeRoot}/data/route/main/group-messages.jsonl`);
    assert.equal(replyContext.privateLogPath, `${relativeRoot}/data/route/main/private-messages.jsonl`);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("AgentPacket migrates legacy FenneNote transcripts to RabiSpeech TTS output", () => {
  const route = routeProfile({
    resolvedPipeline: resolvePipeline(undefined, {
      outputAdapter: "codex",
      outputPipeline: "codex",
      replyToSource: false
    }),
    notificationRules: [{
      id: "voice",
      name: "voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "voice={message}"
    }]
  });
  const decision = createRouteDecision(route, "voice_transcript", voiceTranscript(), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir: "data/route/main"
  });

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.routeKind, "voice_transcript");
  assert.equal(replyContext.adapterType, "fennenote");
  assert.equal(replyContext.outputAdapter, "tts");
  assert.equal(replyContext.outputPipeline, "rabispeech");
  assert.equal(replyContext.replyToSource, false);
  assert.equal(packet.templateValues.promptOutputMode, "voice_short");
  assert.match(packet.message, /发送要求/);
  assert.match(packet.message, /自然语言回复通过明确发送 API 投递/);
  assert.match(packet.message, /明确发送 API/);
  assert.match(packet.message, /"channel": "speech"/);
});

test("AgentPacket enters character TTS dialogue for RabiSpeech message endpoint transcripts", (t) => {
  const roleDir = makeRoleDir();
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const route = routeProfile({
    resolvedPipeline: resolvePipeline("qq_chat", {
      inputAdapter: "speech",
      outputAdapter: "agent",
      outputPipeline: "agent",
      replyToSource: false
    }),
    routeVariables: {
      speechTtsModel: "local-tts/qwen3-tts-0.6b-base",
      speechVoice: "Ilias",
      speechLanguage: "zh",
      speechAutoPlay: "true"
    },
    notificationRules: [{
      id: "speech-message-endpoint",
      name: "speech message endpoint",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "voice={message}"
    }]
  });
  const decision = createRouteDecision(route, "voice_transcript", voiceTranscript({
    adapterType: "speech",
    source: "rabispeech",
    transport: "rabipc",
    sessionId: "speech-main"
  }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Ilias",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.routeKind, "voice_transcript");
  assert.equal(replyContext.adapterType, "speech");
  assert.equal(replyContext.sessionId, "speech-main");
  assert.equal(replyContext.outputAdapter, "tts");
  assert.equal(replyContext.outputPipeline, "rabispeech");
  assert.equal(packet.templateValues.promptOutputMode, "voice_short");
  assert.equal(packet.templateValues.ttsVoice, "Ilias");
  assert.equal(packet.templateValues.ttsPlay, "true");
  assert.match(packet.message, /生成同义的屏幕文本和朗读文本/);
  assert.match(packet.message, /语音通过明确发送 API 投递/);
  assert.match(packet.message, /明确发送 API/);
  assert.match(packet.message, /"sessionId": "speech-main"/);
});

test("AgentPacket injects processing-time context confirmation protocol", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-required",
    title: "任务发布上下文",
    content: "发布任务前需要先确认角色计划和近期记忆。",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["任务发布"]
  });
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: ""
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage({ rawMessage: "[CQ:at,qq=12345] 准备任务发布" }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir,
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.match(packet.message, /\[处理前上下文确认\]/);
  assert.match(packet.message, /回复、发布任务、更新计划、写入记忆或执行外部动作之前/);
  assert.match(packet.message, /GET \/api\/roles\/Rabi\/memory\/recent\/memory-required/);
  assert.match(packet.message, /memory-required：任务发布上下文 — 任务发布上下文（近期记忆，score=20）/);
});

test("AgentPacket injects skill indexes without embedding skill bodies", () => {
  const roleDir = makeRoleDir();
  writeSkill(roleDir, "routing-guide.md", `---
id: routing-guide
title: Routing guide
summary: Explain route kind and policy router concepts.
keywords: route kind, policy router
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Routing guide

SECRET BODY SHOULD NOT BE IN PACKET
`);
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: ""
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage({ rawMessage: "[CQ:at,qq=12345] explain route kind" }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir,
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.match(packet.message, /\[处理前上下文确认\]/);
  assert.match(packet.message, /routing-guide：Routing guide — Explain route kind and policy router concepts.（角色技能，score=25）/);
  assert.match(packet.message, /GET \/api\/roles\/Rabi\/skills\/routing-guide/);
  assert.doesNotMatch(packet.message, /SECRET BODY SHOULD NOT BE IN PACKET/);
});

test("AgentPacket injects route recent messages using the persona limit", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-packet-data-"));
  appendJsonl(path.join(dataDir, "group-messages.jsonl"), [
    { time: 1710000000, groupId: 10001, userId: 1, senderName: "Old", rawMessage: "old message", messageId: "old" },
    { time: 1710000001, groupId: 10001, userId: 12345, botNickname: "Rabi", isSelf: true, rawMessage: "first recent", messageId: "first" },
    { time: 1710000002, groupId: 10001, userId: 2, senderName: "Bob", rawMessage: "second recent", messageId: "second" },
    { time: 1710000003, groupId: 10001, userId: 42, senderName: "Alice", rawMessage: "current prompt", messageId: "msg-1" }
  ]);
  const route = routeProfile({
    recentMessageLimit: 2,
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "recent={recentMessages}"
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage({ rawMessage: "current prompt" }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir
  });

  assert.equal(packet.templateValues.recentMessageLimit, 2);
  assert.match(packet.message, /\[最近消息\]/);
  assert.match(packet.message, /first recent/);
  assert.match(packet.message, /second recent/);
  assert.match(packet.message, /出站/);
  assert.doesNotMatch(packet.message, /old message/);
  assert.equal(packet.message.match(/current prompt/g)?.length, 1);
});

test("AgentPacket never injects conversation history into heartbeat events", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-heartbeat-packet-data-"));
  appendJsonl(path.join(dataDir, "heartbeat-events.jsonl"), [
    { time: 1710000000, rawMessage: "older heartbeat history must not be injected", messageId: "heartbeat-old" }
  ]);
  const route = routeProfile({
    recentMessageLimit: 100,
    recentMessageLimits: { heartbeat: 100 },
    notificationRules: [{
      id: "heartbeat",
      name: "heartbeat",
      enabled: true,
      routeKinds: ["heartbeat"],
      template: "recent={recentMessages};limit={recentMessageLimit}"
    }]
  });
  const record: HeartbeatEventRecord = {
    time: 1710000001,
    rawMessage: "current heartbeat task",
    messageId: "heartbeat-current",
    senderName: "RabiRoute scheduled trigger"
  };
  const decision = createRouteDecision(route, "heartbeat", record, {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir
  });

  assert.equal(packet.templateValues.recentMessageLimit, 0);
  assert.equal(packet.templateValues.recentMessages, "");
  assert.doesNotMatch(packet.message, /\[最近消息\]/);
  assert.doesNotMatch(packet.message, /older heartbeat history must not be injected/);
  assert.match(packet.message, /current heartbeat task/);
  assert.match(packet.message, /recent=;limit=0/);
});
