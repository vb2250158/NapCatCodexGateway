import assert from "node:assert/strict";
import test from "node:test";
import {
  agentAdapterSupportsManagedTaskFeature,
  autoAssignGatewayPorts,
  codexMessageProcessingAgentEnabled,
  collectGatewayPortClaims,
  DEFAULT_RECENT_MESSAGE_LIMIT,
  defaultMessageAdapterNotificationRules,
  ensureDefaultPersonaRules,
  GATEWAY_MESSAGE_ADAPTER_TYPES,
  MESSAGE_ENDPOINT_TYPES,
  gatewayAdapterTypes,
  gatewayMessageAdapterTypes,
  isBuiltinRolePanelNotificationRule,
  matchSpeechTriggerKeyword,
  messageAdapterPolicyFor,
  normalizeGatewayDefinition,
  normalizeGatewayNapCatConfig,
  normalizeCodexHookSettings,
  normalizeNapCatInstances,
  normalizePersonaAutomationRules,
  normalizeRecentMessageLimits,
  normalizeRuleDefinitions,
  notificationRulesFromPersonaAutomations,
  personaAutomationRulesFromNotificationRules,
  RECENT_MESSAGE_ENDPOINTS,
  resolvePrimaryNapCatInstance,
  sanitizeConfigName,
  syncPrimaryNapCatInstanceFields,
  validateGatewayPortConflicts,
  type GatewayDefinition
} from "./gatewayConfigModel.js";

function localUrl(port: number, pathname = ""): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function gateway(patch: Partial<GatewayDefinition> = {}): GatewayDefinition {
  return {
    id: "Rabi__main",
    enabled: true,
    messageAdapters: ["napcat"],
    gatewayPort: 8789,
    napcatHttpUrl: localUrl(3000),
    agentRoleId: "Rabi",
    notificationRules: [{
      id: "direct",
      routeKinds: ["direct_at"],
      template: "hello"
    }],
    ...patch
  };
}

test("route id and config names are normalized", () => {
  assert.equal(sanitizeConfigName(" main route!! "), "main-route");
  const normalized = normalizeGatewayDefinition(gateway({ id: "Rabi__main-route" }));
  assert.equal(normalized.id, "main-route");
  assert.equal(normalized.agentRoleId, "Rabi");
  assert.equal(normalized.configName, "main-route");
});

test("message endpoint and Gateway adapter contracts have exact host-owned members", () => {
  assert.deepEqual([...MESSAGE_ENDPOINT_TYPES], [
    "napcat", "remoteAgent", "heartbeat", "rolePanel", "speech", "fennenote", "xiaoai",
    "rabilink", "wearable", "webhook", "wecom", "weixin", "feishu", "xiaomiHome"
  ]);
  assert.deepEqual([...GATEWAY_MESSAGE_ADAPTER_TYPES], [
    "napcat", "heartbeat", "fennenote", "xiaoai", "rabilink", "webhook", "wecom", "weixin", "feishu"
  ]);
  assert.equal(MESSAGE_ENDPOINT_TYPES.includes("disabled" as never), false);
  assert.equal(GATEWAY_MESSAGE_ADAPTER_TYPES.includes("wearable" as never), false);
  assert.equal(GATEWAY_MESSAGE_ADAPTER_TYPES.includes("speech" as never), false);
  assert.equal(GATEWAY_MESSAGE_ADAPTER_TYPES.includes("xiaomiHome" as never), false);
});

test("legacy disabled selection normalizes to state instead of an endpoint type", () => {
  const normalized = normalizeGatewayDefinition(gateway({ messageAdapters: ["disabled"] }));
  assert.equal(normalized.messageInputsDisabled, true);
  assert.equal(normalized.messageAdapterType, "napcat");
  assert.deepEqual(normalized.messageAdapters, ["napcat"]);
  assert.deepEqual(gatewayAdapterTypes(normalized), []);
  assert.deepEqual(gatewayMessageAdapterTypes(normalized), []);
});

test("message adapters honor disabled input and disabled adapter lists", () => {
  assert.deepEqual(gatewayAdapterTypes(gateway({ messageAdapters: ["napcat", "heartbeat"], messageAdaptersDisabled: ["napcat"] })), ["heartbeat"]);
  assert.deepEqual(gatewayAdapterTypes(gateway({ messageInputsDisabled: true, messageAdapters: ["napcat"] })), []);
});

test("message adapter policies control input while keeping output defaults enabled", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat", "heartbeat"],
    messageAdapterPolicies: {
      napcat: { inputEnabled: false },
      heartbeat: { outputEnabled: false }
    }
  }));
  assert.deepEqual(gatewayAdapterTypes(normalized), ["heartbeat"]);
  assert.equal(messageAdapterPolicyFor(normalized, "napcat").outputEnabled, true);
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").outputEnabled, false);
  assert.deepEqual(messageAdapterPolicyFor(normalized, "heartbeat").supportedOutputs, ["text", "image", "voice", "file"]);
  assert.deepEqual(messageAdapterPolicyFor(normalized, "heartbeat").allowedFileRoots, []);
  assert.deepEqual(messageAdapterPolicyFor(normalized, "napcat").messageGrouping, {
    enabled: true,
    settleSeconds: 6,
    incompleteSettleSeconds: 12,
    maxWaitSeconds: 20
  });
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").messageGrouping.enabled, false);
});

test("chat grouping is automatic while ASR stays direct and wait values remain configurable", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["speech", "weixin"],
    messageAdapterPolicies: {
      speech: {},
      weixin: {
        messageGrouping: {
          enabled: false,
          settleSeconds: 10,
          incompleteSettleSeconds: 4,
          maxWaitSeconds: 5
        }
      }
    }
  }));

  assert.deepEqual(messageAdapterPolicyFor(normalized, "speech").messageGrouping, {
    enabled: false,
    settleSeconds: 3,
    incompleteSettleSeconds: 8,
    maxWaitSeconds: 15
  });
  assert.deepEqual(messageAdapterPolicyFor(normalized, "weixin").messageGrouping, {
    enabled: true,
    settleSeconds: 10,
    incompleteSettleSeconds: 10,
    maxWaitSeconds: 10
  });
});

test("managed task capabilities keep Codex-only settings off unsupported Agent adapters", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    agentModel: "gpt-5.6-sol",
    agentReasoningEffort: "high",
    dshModelProvider: " deepseek-official ",
    dshModel: " deepseek-v4-pro ",
    dshReasoningEffort: " max ",
    agentAdapters: ["codex", "copilotCli"],
    messageProcessingAgents: {
      codex: { enabled: true, maxAgents: 40 },
      copilotCli: { enabled: false, model: "custom-model", reasoningEffort: "high" }
    }
  }));

  assert.equal(normalized.agentModel, "gpt-5.6-sol");
  assert.equal(normalized.agentReasoningEffort, "high");
  assert.equal(normalized.dshModelProvider, "deepseek-official");
  assert.equal(normalized.dshModel, "deepseek-v4-pro");
  assert.equal(normalized.dshReasoningEffort, "max");
  assert.deepEqual(normalized.messageProcessingAgents, {
    codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium", maxAgents: 32 }
  });
});

test("Codex message processing requires Codex to be the selected primary Agent", () => {
  const messageProcessingAgents: GatewayDefinition["messageProcessingAgents"] = {
    codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" }
  };
  assert.equal(codexMessageProcessingAgentEnabled({
    agentAdapters: ["codex", "dsh"],
    primaryAgentAdapter: "dsh",
    messageProcessingAgents
  }), false);
  assert.equal(codexMessageProcessingAgentEnabled({
    agentAdapters: ["codex", "dsh"],
    primaryAgentAdapter: "codex",
    messageProcessingAgents
  }), true);
});

test("a Route keeps only its primary NapCat endpoint when migrating a multi-instance config", () => {
  const firstEnabled = normalizeNapCatInstances(gateway({
    napcatInstances: [{
      id: "disabled-old-primary",
      enabled: false,
      gatewayPort: 8789,
      httpUrl: localUrl(3000)
    }, {
      id: "selected-primary",
      gatewayPort: 8791,
      httpUrl: localUrl(3001),
      autoLoginOnRabiStart: false
    }, {
      id: "discarded-secondary",
      gatewayPort: 8792,
      httpUrl: localUrl(3002)
    }]
  }));

  assert.equal(firstEnabled.length, 1);
  assert.equal(firstEnabled[0]?.id, "selected-primary");
  assert.equal(firstEnabled[0]?.enabled, true);
  assert.equal(firstEnabled[0]?.autoLoginOnRabiStart, false);
});

test("Xiaomi Home survives Route save and reload without becoming a Gateway runtime adapter", () => {
  const saved = JSON.stringify(normalizeGatewayDefinition(gateway({
    messageAdapters: ["xiaoai", "xiaomiHome"]
  })));
  const reloaded = normalizeGatewayDefinition(JSON.parse(saved));
  assert.deepEqual(reloaded.messageAdapters, ["xiaoai", "xiaomiHome"]);
  assert.deepEqual(gatewayAdapterTypes(reloaded), ["xiaoai", "xiaomiHome"]);
  assert.deepEqual(gatewayMessageAdapterTypes(reloaded), ["xiaoai"]);
  assert.deepEqual(
    reloaded.notificationRules?.find(rule => rule.routeKinds?.includes("xiaomi_home_event"))?.routeKinds,
    ["xiaomi_home_event"]
  );
});

test("a single NapCat endpoint defaults auto login on", () => {
  const normalized = normalizeNapCatInstances(gateway({
    napcatInstances: [{
      id: "default",
      gatewayPort: 8789,
      httpUrl: localUrl(3000)
    }]
  }));

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.autoLoginOnRabiStart, true);
});

test("Message Agent limit defaults to one and ignores invalid values", () => {
  const defaulted = normalizeGatewayDefinition(gateway({
    agentAdapters: ["codex"],
    messageProcessingAgents: { codex: { enabled: true } }
  }));
  const invalid = normalizeGatewayDefinition(gateway({
    agentAdapters: ["codex"],
    messageProcessingAgents: { codex: { enabled: true, maxAgents: 0 } }
  }));

  assert.equal(defaulted.messageProcessingAgents?.codex?.maxAgents, 1);
  assert.equal(invalid.messageProcessingAgents?.codex?.maxAgents, 1);
});

test("managed task capability layer exposes the three Codex task features independently", () => {
  assert.equal(agentAdapterSupportsManagedTaskFeature("codex", "messageProcessingAgent"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("codex", "planAssistantSessions"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("codex", "memoryConsolidationAgent"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("codex", "hooks"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("dsh", "messageProcessingAgent"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("dsh", "planAssistantSessions"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("dsh", "memoryConsolidationAgent"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("dsh", "hooks"), true);
  assert.equal(agentAdapterSupportsManagedTaskFeature("copilotCli", "messageProcessingAgent"), false);
  assert.equal(agentAdapterSupportsManagedTaskFeature("astrbot", "planAssistantSessions"), false);
  assert.equal(agentAdapterSupportsManagedTaskFeature("marvis", "hooks"), false);
});

test("Codex managed-task settings are removed when a route has no Codex adapter", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    agentAdapters: ["copilotCli"],
    messageProcessingAgents: {
      codex: { enabled: true },
      copilotCli: { enabled: true, model: "custom-model", reasoningEffort: "high" }
    },
    codexPlanAssistantSessions: [{
      threadId: "019f0000-0000-7000-8000-000000000001",
      threadName: "Plan assistant",
      workspace: "C:/Project",
      index: 1
    }],
    codexMemoryConsolidationAgentEnabled: true,
    codexMemoryConsolidationAgentModel: "custom-memory-model",
    codexHooks: {
      sessionContextEnabled: true,
      reasoningContextEnabled: true,
      planTaskCompletionEnabled: true,
      agentCommunicationEnforcementEnabled: true,
      onlyPrimaryPersonaCanSendMessages: false
    }
  }));

  assert.deepEqual(normalized.messageProcessingAgents, {});
  assert.equal(normalized.codexPlanAssistantEnabled, undefined);
  assert.equal(normalized.codexPlanAssistantModel, undefined);
  assert.equal(normalized.codexPlanAssistantSessions, undefined);
  assert.equal(normalized.codexMemoryConsolidationAgentEnabled, undefined);
  assert.equal(normalized.codexMemoryConsolidationAgentModel, undefined);
  // Hook settings belong to the persona and survive changes to its Agent adapter.
  assert.deepEqual(normalized.codexHooks, normalizeCodexHookSettings(undefined));
});

test("message adapter policies normalize allowed outbound file roots", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapterPolicies: {
      napcat: {
        supportedOutputs: ["text", "file"],
        allowedFileRoots: [" C:/Builds ", "C:/Builds", "D:/Artifacts"]
      }
    }
  }));
  assert.deepEqual(messageAdapterPolicyFor(normalized, "napcat").allowedFileRoots, ["C:/Builds", "D:/Artifacts"]);
});

test("WeCom is a message/output adapter and does not claim a local ingress port", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["wecom"],
    pipeline: {
      inputAdapter: "wecom",
      outputAdapter: "wecom",
      outputPipeline: "wecom"
    },
    wecomBotId: "bot-id-placeholder",
    wecomBotSecret: "secret-placeholder",
    wecomWsUrl: "wss://example.invalid/wecom"
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["wecom"]);
  assert.equal(normalized.pipeline?.inputAdapter, "wecom");
  assert.equal(normalized.pipeline?.outputAdapter, "wecom");
  assert.equal(messageAdapterPolicyFor(normalized, "wecom").outputEnabled, true);

  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.deepEqual(claims.map((claim) => claim.kind), ["manager"]);
});

test("personal Weixin is a source-bound message/output adapter without a local port", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["weixin"],
    pipeline: {
      inputAdapter: "weixin",
      outputAdapter: "weixin",
      outputPipeline: "weixin"
    },
    weixinBaseUrl: "https://example.invalid/ilink",
    weixinBotType: "3"
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["weixin"]);
  assert.equal(normalized.pipeline?.inputAdapter, "weixin");
  assert.equal(normalized.pipeline?.outputAdapter, "weixin");
  assert.equal(normalized.weixinBaseUrl, "https://example.invalid/ilink");
  assert.equal(normalized.weixinBotType, "3");
  assert.equal(messageAdapterPolicyFor(normalized, "weixin").outputEnabled, true);

  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.deepEqual(claims.map((claim) => claim.kind), ["manager"]);
});

test("legacy Codex pipeline output normalizes to canonical Agent output", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    pipeline: {
      outputAdapter: "codex",
      outputPipeline: "codex"
    }
  }));

  assert.equal(normalized.pipeline?.outputAdapter, "agent");
  assert.equal(normalized.pipeline?.outputPipeline, "agent");
  assert.equal(normalized.routeProfiles?.[0]?.pipeline?.outputAdapter, "agent");
  assert.equal(normalized.routeProfiles?.[0]?.pipeline?.outputPipeline, "agent");
});

test("shared config normalization accepts canonical Agent adapter ids only", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexDesktop"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp", "copilotCli"] as any })).agentAdapters, ["copilotCli"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["unknown"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: [] })).agentAdapters, []);
});

test("primary Agent defaults to the first configured adapter and must remain configured", () => {
  const defaulted = normalizeGatewayDefinition(gateway({
    agentAdapters: ["codex", "copilotCli"]
  }));
  assert.equal(defaulted.primaryAgentAdapter, "codex");

  const selected = normalizeGatewayDefinition(gateway({
    agentAdapters: ["codex", "copilotCli"],
    primaryAgentAdapter: "copilotCli"
  }));
  assert.equal(selected.primaryAgentAdapter, "copilotCli");

  const repaired = normalizeGatewayDefinition(gateway({
    agentAdapters: ["codex"],
    primaryAgentAdapter: "copilotCli"
  }));
  assert.equal(repaired.primaryAgentAdapter, "codex");
  assert.equal(normalizeGatewayDefinition(gateway({ agentAdapters: [] })).primaryAgentAdapter, undefined);
});

test("route names accidentally stored as Codex task ids migrate back to names", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexThreadId: "RabiLink",
    codexThreadName: undefined
  }));

  assert.equal(normalized.codexThreadId, undefined);
  assert.equal(normalized.codexThreadName, "RabiLink");
});

test("valid Codex task ids remain internal bindings", () => {
  const codexThreadId = "019f0000-0000-7000-8000-000000000015";
  const normalized = normalizeGatewayDefinition(gateway({ codexThreadId, codexThreadName: "RabiLink" }));

  assert.equal(normalized.codexThreadId, codexThreadId);
  assert.equal(normalized.codexThreadName, "RabiLink");
});

test("default gateway agent adapter uses codex", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway()).agentAdapters, ["codex"]);
});

test("Codex Hook settings default enabled and preserve explicit opt-out", () => {
  assert.deepEqual(normalizeCodexHookSettings(undefined), {
    sessionContextEnabled: true,
    reasoningContextEnabled: true,
    planTaskCompletionEnabled: true,
    agentCommunicationEnforcementEnabled: true,
    onlyPrimaryPersonaCanSendMessages: false,
    completionDeliveries: [],
    planFollowup: { enabled: false, cooldownSeconds: 300, rules: [] }
  });
  const normalized = normalizeGatewayDefinition(gateway({
    codexHooks: {
      sessionContextEnabled: false,
      reasoningContextEnabled: true,
      planTaskCompletionEnabled: false,
      agentCommunicationEnforcementEnabled: false,
      onlyPrimaryPersonaCanSendMessages: true
    }
  }));
  assert.deepEqual(normalized.codexHooks, {
    sessionContextEnabled: false,
    reasoningContextEnabled: true,
    planTaskCompletionEnabled: false,
    agentCommunicationEnforcementEnabled: false,
    onlyPrimaryPersonaCanSendMessages: true,
    completionDeliveries: [],
    planFollowup: { enabled: false, cooldownSeconds: 300, rules: [] }
  });
});

test("heartbeat busy guard defaults off and preserves an explicit opt-in", () => {
  assert.equal(normalizeGatewayDefinition(gateway()).heartbeatSkipWhenAgentBusy, false);
  assert.equal(normalizeGatewayDefinition(gateway({ heartbeatSkipWhenAgentBusy: true })).heartbeatSkipWhenAgentBusy, true);
});

test("persona recent message limits default per endpoint and migrate the legacy scalar", () => {
  assert.equal(DEFAULT_RECENT_MESSAGE_LIMIT, 12);
  const defaulted = normalizeGatewayDefinition(gateway());
  assert.equal(defaulted.recentMessageLimit, undefined);
  assert.equal(Object.keys(defaulted.recentMessageLimits ?? {}).length, RECENT_MESSAGE_ENDPOINTS.length);
  for (const endpoint of RECENT_MESSAGE_ENDPOINTS) {
    assert.equal(defaulted.recentMessageLimits?.[endpoint], DEFAULT_RECENT_MESSAGE_LIMIT);
    assert.equal(defaulted.routeProfiles?.[0]?.recentMessageLimits?.[endpoint], DEFAULT_RECENT_MESSAGE_LIMIT);
  }

  const customized = normalizeGatewayDefinition(gateway({ recentMessageLimit: 4 }));
  assert.equal(customized.recentMessageLimit, undefined);
  for (const endpoint of RECENT_MESSAGE_ENDPOINTS) {
    assert.equal(customized.recentMessageLimits?.[endpoint], 4);
  }
});

test("persona recent message limits clamp each endpoint independently", () => {
  const normalized = normalizeRecentMessageLimits({
    napcat: 31.8,
    speech: 999,
    heartbeat: -4
  });

  assert.equal(normalized.napcat, 31);
  assert.equal(normalized.speech, 200);
  assert.equal(normalized.heartbeat, 0);
  assert.equal(normalized.wecom, DEFAULT_RECENT_MESSAGE_LIMIT);
  assert.equal(normalized.weixin, DEFAULT_RECENT_MESSAGE_LIMIT);
});

test("Codex plan assistant sessions keep exact Desktop task bindings", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexCwd: "C:\\workspace\\project",
    codexPlanAssistantSessions: [{
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "主任务 协助处理计划",
      workspace: "C:\\workspace\\project",
      index: 4
    }]
  }));

  assert.deepEqual(normalized.codexPlanAssistantSessions, [{
    threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
    threadName: "主任务 协助处理计划",
    workspace: "C:\\workspace\\project",
    index: 1,
    initializedAt: undefined
  }]);
  assert.equal(normalized.codexPlanAssistantEnabled, true);
  assert.equal(normalized.codexPlanAssistantModel, "gpt-5.6-terra");
});

test("Codex plan assistant sessions retain only the Primary Persona workspace", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexCwd: "C:\\workspace\\project",
    codexPlanAssistantSessions: [{
      threadId: "019fa314-2c07-7523-896f-9bb6b638054a",
      threadName: "主任务 协助处理计划1",
      workspace: "\\\\?\\C:\\workspace\\project\\",
      index: 1
    }, {
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "旧目录 协助处理计划2",
      workspace: "C:\\workspace\\other-project",
      index: 2
    }]
  }));

  assert.deepEqual(normalized.codexPlanAssistantSessions?.map((session) => session.threadId), [
    "019fa314-2c07-7523-896f-9bb6b638054a"
  ]);
});

test("Primary Agent reasoning effort rejects unsupported values", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    agentReasoningEffort: "unsupported" as never
  }));
  assert.equal(normalized.agentReasoningEffort, undefined);
});

test("Codex plan assistant model is one Manager-owned setting and overrides legacy per-session models", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexCwd: "C:\\workspace\\project",
    codexPlanAssistantModel: "gpt-5.6-terra",
    codexPlanAssistantSessions: [{
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "主任务 协助处理计划",
      workspace: "C:\\workspace\\project",
      index: 1,
      model: "legacy-session-model"
    }]
  }));

  assert.equal(normalized.codexPlanAssistantModel, "gpt-5.6-terra");
  assert.equal(normalized.codexPlanAssistantSessions?.[0]?.model, undefined);
});

test("legacy per-session secretary model migrates to the Manager-owned shared setting", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexCwd: "C:\\workspace\\project",
    codexPlanAssistantSessions: [{
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "主任务 协助处理计划",
      workspace: "C:\\workspace\\project",
      index: 1,
      model: "legacy-shared-model"
    }]
  }));

  assert.equal(normalized.codexPlanAssistantModel, "legacy-shared-model");
  assert.equal(normalized.codexPlanAssistantSessions?.[0]?.model, undefined);
});

test("Codex plan assistant switch can disable existing task bindings without deleting them", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    codexCwd: "C:\\workspace\\project",
    codexPlanAssistantEnabled: false,
    codexPlanAssistantSessions: [{
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "主任务 协助处理计划",
      workspace: "C:\\workspace\\project",
      index: 1
    }]
  }));

  assert.equal(normalized.codexPlanAssistantEnabled, false);
  assert.equal(normalized.codexPlanAssistantSessions?.length, 1);
});

test("Codex memory consolidation Agent is opt-in and defaults to GPT-5.6 Terra", () => {
  const disabled = normalizeGatewayDefinition(gateway());
  assert.equal(disabled.codexMemoryConsolidationAgentEnabled, false);
  assert.equal(disabled.codexMemoryConsolidationAgentModel, "gpt-5.6-terra");

  const enabled = normalizeGatewayDefinition(gateway({
    codexMemoryConsolidationAgentEnabled: true,
    codexMemoryConsolidationAgentModel: ""
  }));
  assert.equal(enabled.codexMemoryConsolidationAgentEnabled, true);
  assert.equal(enabled.codexMemoryConsolidationAgentModel, "gpt-5.6-terra");
});

test("speech push mode belongs to the Route while trigger keywords are normalized as persona data", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["speech"],
    speechPushMode: "keyword",
    speechTriggerKeywords: [" 星海 ", "星海", "XinghaiBuilder", "xinghaibuilder", ""]
  }));

  assert.equal(normalized.speechPushMode, "keyword");
  assert.equal(normalized.routeProfiles?.[0]?.speechPushMode, "keyword");
  assert.deepEqual(normalized.speechTriggerKeywords, ["星海", "XinghaiBuilder"]);
  assert.equal(matchSpeechTriggerKeyword("请让星海看一下上下文", normalized.speechTriggerKeywords ?? []), "星海");
  assert.equal(matchSpeechTriggerKeyword("xinghaibuilder, wake up", normalized.speechTriggerKeywords ?? []), "XinghaiBuilder");
  assert.equal(matchSpeechTriggerKeyword("继续记录，不要唤醒", normalized.speechTriggerKeywords ?? []), undefined);
});

test("persona-free gateways get default message adapter rules", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    id: "Rabi__plain",
    agentRoleId: "",
    messageAdapters: ["napcat", "fennenote"],
    notificationRules: []
  }));

  assert.equal(normalized.id, "plain");
  assert.equal(normalized.agentRoleId, "");
  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["default-napcat", "default-fennenote"]);
  assert.deepEqual(normalized.notificationRules?.[0]?.routeKinds, ["private", "direct_at", "direct_reply", "indirect_reply"]);
  assert.deepEqual(normalized.notificationRules?.[1]?.routeKinds, ["voice_transcript"]);
  assert.deepEqual(normalized.roleNotificationRules, {});
  assert.equal(normalized.routeProfiles?.[0]?.agentRoleId, "");
});

test("every message adapter has a default whiteboard route template", () => {
  const adapters = [
    "napcat",
    "remoteAgent",
    "heartbeat",
    "rolePanel",
    "speech",
    "fennenote",
    "xiaoai",
    "rabilink",
    "wearable",
    "webhook",
    "wecom",
    "weixin"
  ] as const;

  for (const adapter of adapters) {
    const rules = defaultMessageAdapterNotificationRules([adapter]);
    assert.equal(rules.length, 1, `${adapter} should have one default whiteboard rule`);
    assert.ok((rules[0]?.routeKinds?.length ?? 0) > 0, `${adapter} should cover at least one route kind`);
    assert.equal(rules[0]?.template, "");
  }
});

test("persona gateways backfill an uncovered message adapter with one whiteboard rule", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat", "weixin"],
    notificationRules: [{
      id: "direct",
      name: "已有 QQ 规则",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "hello"
    }]
  }));

  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["direct", "default-napcat", "default-weixin"]);
  assert.deepEqual(
    normalized.notificationRules?.find(rule => rule.id === "default-napcat")?.routeKinds,
    ["private", "direct_reply", "indirect_reply"]
  );
  assert.deepEqual(normalized.notificationRules?.find(rule => rule.id === "default-weixin")?.routeKinds, ["weixin_message"]);
  assert.equal(normalized.notificationRules?.find(rule => rule.id === "default-weixin")?.template, "");
  assert.equal(normalized.routeProfiles?.[0]?.notificationRules?.filter(rule => rule.id === "default-weixin").length, 1);
});

test("an explicit disabled adapter rule prevents whiteboard backfill", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["weixin"],
    notificationRules: [{
      id: "disabled-weixin",
      name: "明确关闭个人微信投递",
      enabled: false,
      routeKinds: ["weixin_message"],
      template: ""
    }]
  }));

  assert.equal(normalized.notificationRules?.filter(rule => rule.routeKinds?.includes("weixin_message")).length, 1);
  assert.equal(normalized.notificationRules?.some(rule => rule.id === "default-weixin"), false);
});

test("RabiLink is a named webhook-like message adapter", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    id: "Rabi__rabilink",
    agentRoleId: "",
    messageAdapters: ["rabilink"],
    rabiLinkWebhookPort: 8794,
    rabiLinkWebhookPath: "/rabilink",
    notificationRules: []
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["rabilink"]);
  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["default-rabilink"]);
  assert.deepEqual(normalized.notificationRules?.[0]?.routeKinds, ["rabilink"]);

  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.equal(claims.find(claim => claim.kind === "rabilink-webhook")?.port, 8794);
});

test("wearable health is a Relay-backed message adapter without its own listener", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    id: "Rabi__wearable",
    agentRoleId: "",
    messageAdapters: ["rabilink", "wearable"],
    rabiLinkWebhookPort: 8794,
    notificationRules: []
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["rabilink", "wearable"]);
  assert.deepEqual(gatewayMessageAdapterTypes(normalized), ["rabilink"]);
  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["default-rabilink", "default-wearable"]);
  assert.deepEqual(normalized.notificationRules?.[1]?.routeKinds, ["wearable_health_alert"]);
  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.equal(claims.filter(claim => claim.port === 8794).length, 1);
});

test("legacy message adapter target restrictions are ignored", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat"],
    messageAdapterPolicies: {
      napcat: { allowedGroups: ["10001"], allowedUsers: ["10002"], allowBroadcast: false, disabledPipelines: ["qq"] } as any
    }
  }));

  assert.deepEqual(Object.keys(messageAdapterPolicyFor(normalized, "napcat")).sort(), [
    "allowedFileRoots",
    "inputEnabled",
    "messageGrouping",
    "outputEnabled",
    "supportedOutputs"
  ].sort());
});

test("legacy disabled adapter list backfills policy input state", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat", "heartbeat"],
    messageAdaptersDisabled: ["napcat"]
  }));
  assert.equal(messageAdapterPolicyFor(normalized, "napcat").inputEnabled, false);
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").inputEnabled, true);
});

test("NapCat normalization keeps one endpoint and applies defaults", () => {
  const instances = normalizeNapCatInstances(gateway({
    napcatInstances: [
      { id: "bot", gatewayPort: 8791, httpUrl: localUrl(3001) },
      { id: "bot", gatewayPort: 8792, httpUrl: localUrl(3002) }
    ]
  }));
  assert.equal(instances.length, 1);
  assert.equal(instances[0].id, "bot");
  assert.equal(instances[0].webuiUrl, localUrl(6099, "/webui"));
});

test("legacy NapCat endpoint fields do not create a runnable default instance", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatWebuiUrl: localUrl(6099, "/webui")
  }));

  assert.deepEqual(normalized.napcatInstances, []);
  assert.equal(normalized.gatewayPort, 8791);
  assert.equal(normalized.napcatHttpUrl, localUrl(3001));
});

test("NapCat primary resolution chooses the first enabled normalized instance", () => {
  const resolved = normalizeGatewayNapCatConfig(gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatInstances: [
      { id: "off", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) },
      { id: "on", gatewayPort: 8793, httpUrl: localUrl(3003), accessToken: "bot-token" }
    ]
  }));

  assert.equal(resolved.primaryIndex, 0);
  assert.equal(resolved.primary?.id, "on");
  assert.equal(resolved.instances.length, 1);
  assert.equal(resolved.instances[0].enabled, true);
  assert.equal(resolved.instances[0].webuiUrl, localUrl(6099, "/webui"));
});

test("NapCat primary sync backfills gateway fields and clears stale tokens", () => {
  const definition = gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatAccessToken: "stale-access",
    napcatWebuiToken: "stale-webui",
    napcatInstances: [
      { id: "old", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002), accessToken: "old-access", webuiToken: "old-webui" },
      { id: "primary", gatewayPort: 8793, httpUrl: localUrl(3003), webuiUrl: localUrl(6103, "/webui"), accessToken: "", webuiToken: "" }
    ]
  });

  const resolved = syncPrimaryNapCatInstanceFields(definition);

  assert.equal(resolved.primary?.id, "primary");
  assert.equal(definition.gatewayPort, 8793);
  assert.equal(definition.napcatHttpUrl, localUrl(3003));
  assert.equal(definition.napcatWebuiUrl, localUrl(6103, "/webui"));
  assert.equal(definition.napcatAccessToken, "");
  assert.equal(definition.napcatWebuiToken, "");
});

test("NapCat primary resolution falls back to the first instance when all are disabled", () => {
  const instances = normalizeNapCatInstances(gateway({
    napcatInstances: [
      { id: "a", enabled: false, gatewayPort: 8791, httpUrl: localUrl(3001) },
      { id: "b", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) }
    ]
  }));

  const resolved = resolvePrimaryNapCatInstance(gateway(), instances);

  assert.equal(resolved.primaryIndex, 0);
  assert.equal(resolved.primary?.id, "a");
});

test("NapCat invalid ports are rejected", () => {
  assert.throws(
    () => normalizeNapCatInstances(gateway({ napcatInstances: [{ id: "bad", gatewayPort: 70000, httpUrl: localUrl(3000) }] })),
    /Port must be an integer/
  );
});

test("auto assignment fences the dynamic Manager port published by Host READY", () => {
  const managerPort = 13486;
  const items = [gateway({ gatewayPort: managerPort })];
  autoAssignGatewayPorts(items, managerPort);
  const assignedPort = Number(items[0].gatewayPort);
  assert.notEqual(assignedPort, managerPort);
  assert.ok(Number.isInteger(assignedPort) && assignedPort >= 1 && assignedPort <= 65535);
  const listenerPorts = collectGatewayPortClaims(items, { managerPort })
    .filter((claim) => claim.kind !== "napcat-http")
    .map((claim) => claim.port);
  assert.equal(new Set(listenerPorts).size, listenerPorts.length);
});

test("auto assignment does not reserve a Manager port before Host READY", () => {
  const preferredGatewayPort = 13486;
  const items = [gateway({ gatewayPort: preferredGatewayPort })];
  autoAssignGatewayPorts(items);
  assert.equal(items[0].gatewayPort, preferredGatewayPort);
});

test("auto assignment allocates unique Route listener ports and preserves NapCat endpoints", () => {
  const items = [
    gateway({
      id: "Rabi__a",
      gatewayPort: 8790,
      napcatInstances: [
        { id: "a1", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6099, "/webui"), accessToken: "a1" },
        { id: "a2", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6100, "/webui"), accessToken: "a2" }
      ]
    }),
    gateway({
      id: "Rabi__b",
      gatewayPort: 8790,
      messageAdapters: ["napcat", "webhook"],
      webhookPort: 8790,
      napcatInstances: [
        { id: "b1", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6101, "/webui"), accessToken: "b1" }
      ]
    })
  ];

  autoAssignGatewayPorts(items, 8790);

  const claims = collectGatewayPortClaims(items, { managerPort: 8790 });
  const listenerClaims = claims.filter((claim) => claim.kind !== "napcat-http");
  assert.equal(new Set(listenerClaims.map((claim) => claim.port)).size, listenerClaims.length);
  assert.equal(items[0].gatewayPort, items[0].napcatInstances?.[0].gatewayPort);
  assert.equal(items[0].napcatHttpUrl, items[0].napcatInstances?.[0].httpUrl);
  assert.equal(items[0].napcatAccessToken, "a1");
  assert.equal(items[0].napcatInstances?.length, 1);
  validateGatewayPortConflicts(items);
});

test("port claims expose NapCat WS listeners and HTTP endpoints", () => {
  const claims = collectGatewayPortClaims([
    gateway({
      id: "Rabi__a",
      napcatInstances: [
        { id: "a1", gatewayPort: 8791, httpUrl: localUrl(3001) },
        { id: "a2", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) }
      ]
    })
  ], { managerPort: 8790 });

  assert.deepEqual(claims.map((claim) => [claim.kind, claim.gatewayId, claim.instanceId, claim.port]), [
    ["manager", undefined, undefined, 8790],
    ["napcat-ws", "Rabi__a", "a1", 8791],
    ["napcat-http", "Rabi__a", "a1", 3001]
  ]);
});

test("port conflicts are detected across Route-owned listeners", () => {
  assert.throws(
    () => validateGatewayPortConflicts([
      gateway({ id: "Rabi__main", gatewayPort: 8789, messageAdapters: ["napcat"], napcatInstances: [] }),
      gateway({ id: "Rabi__web", gatewayPort: 8799, messageAdapters: ["webhook"], webhookPort: 8789 })
    ]),
    /Port conflict/
  );
});

test("shared NapCat HTTP endpoints stay unchanged across routes", () => {
  const gateways = [
    gateway({
      id: "Rabi__a",
      gatewayPort: 8791,
      napcatInstances: [{ id: "a", gatewayPort: 8791, httpUrl: localUrl(3000) }]
    }),
    gateway({
      id: "Rabi__b",
      gatewayPort: 8792,
      napcatInstances: [{ id: "b", gatewayPort: 8792, httpUrl: localUrl(3000) }]
    })
  ];

  assert.doesNotThrow(() => validateGatewayPortConflicts(gateways));
  autoAssignGatewayPorts(gateways);

  assert.equal(gateways[0].napcatInstances?.[0].httpUrl, localUrl(3000));
  assert.equal(gateways[1].napcatInstances?.[0].httpUrl, localUrl(3000));
});

test("notification rules and escaped newlines are normalized", () => {
  const [rule] = normalizeRuleDefinitions([{
    routeKinds: [123],
    template: "a\\nb",
    schedules: [{
      id: "daytime",
      type: "interval",
      intervalSeconds: 900,
      windowStartTime: "09:30",
      windowEndTime: "19:00"
    }]
  }]) ?? [];
  assert.equal(rule.id, "rule-1");
  assert.deepEqual(rule.routeKinds, ["123"]);
  assert.equal(rule.template, "a\nb");
  assert.deepEqual(rule.schedules?.[0], {
    id: "daytime",
    name: undefined,
    enabled: true,
    type: "interval",
    intervalSeconds: 900,
    windowStartTime: "09:30",
    windowEndTime: "19:00",
    timeOfDay: undefined,
    onceAt: undefined
  });
});

test("persona rules always include the builtin role panel message rule", () => {
  const rules = ensureDefaultPersonaRules([
    { id: "direct", routeKinds: ["direct_at"], template: "hello" }
  ]);

  assert.deepEqual(rules.map(rule => rule.id), ["direct", "role-panel-message"]);
  assert.equal(isBuiltinRolePanelNotificationRule(rules[1]), true);
  assert.deepEqual(rules[1].routeKinds, ["role_panel_message"]);
  assert.equal(rules[1].enabled, true);
});

test("legacy role panel persona rules are canonicalized", () => {
  const rules = ensureDefaultPersonaRules([
    {
      id: "old-role-panel",
      name: "  ",
      enabled: false,
      routeKinds: ["role_panel_message", "manual_trigger"],
      targetGroupId: "10001",
      regex: "hello",
      template: "a\\nb",
      schedules: [{ id: "unused", type: "interval", intervalSeconds: 30 }]
    }
  ]);

  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    id: "role-panel-message",
    name: "角色面板消息",
    enabled: true,
    routeKinds: ["role_panel_message"],
    targetGroupId: "",
    allowedSpeakerNames: [],
    regex: "",
    schedules: undefined,
    template: "a\nb"
  });
});

test("backend normalization owns speech Route defaults", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["speech"],
    routeVariables: { speechThreshold: "0.025", custom: "kept" }
  }));

  assert.equal(normalized.pipelinePreset, "voice_chat");
  assert.equal(normalized.routeVariables?.speechAsrModel, "faster-whisper/small");
  assert.equal(normalized.routeVariables?.speechTtsModel, undefined);
  assert.equal(normalized.routeVariables?.speechVoice, undefined);
  assert.equal(normalized.routeVariables?.speechLanguage, undefined);
  assert.equal(normalized.routeVariables?.speechThreshold, "0.025");
  assert.equal(normalized.routeVariables?.speechAutoSubmit, "true");
  assert.equal(normalized.routeVariables?.custom, "kept");
  assert.deepEqual(normalized.routeProfiles?.[0]?.routeVariables, normalized.routeVariables);
});

test("Feishu owns an independent recent-message budget and text-only default output policy", () => {
  assert.equal(RECENT_MESSAGE_ENDPOINTS.includes("feishu"), true);
  const definition = gateway({
    messageAdapters: ["feishu"],
    feishuWebhookPort: 8891,
    feishuWebhookPath: " /feishu-events ",
    feishuEventSubscriptionEnabled: false
  });
  const normalized = normalizeGatewayDefinition(definition);
  assert.deepEqual(messageAdapterPolicyFor(normalized, "feishu").supportedOutputs, ["text"]);
  assert.equal(normalized.feishuWebhookPath, "/feishu-events");
  assert.equal(normalized.feishuEventSubscriptionEnabled, false);
  assert.equal(
    collectGatewayPortClaims([normalized]).some((claim) =>
      claim.kind === "feishu-webhook" && claim.port === 8891
    ),
    true
  );
});

test("legacy heartbeat templates migrate into separate message and scheduled automations", () => {
  const automations = personaAutomationRulesFromNotificationRules([{
    id: "daily-check",
    name: "Daily check",
    enabled: true,
    routeKinds: ["heartbeat"],
    schedules: [{ id: "morning", type: "daily_time", timeOfDay: "09:30" }],
    template: "inspect open work"
  }]);

  assert.deepEqual(automations.map(rule => [rule.id, rule.trigger.type, rule.action.type]), [
    ["daily-check", "message", "deliver_agent"],
    ["scheduled-daily-check-morning", "schedule", "deliver_agent"]
  ]);
  const scheduled = automations[1];
  assert.equal(scheduled.trigger.type === "schedule" ? scheduled.trigger.schedule.timeOfDay : "", "09:30");
  assert.equal(scheduled.action.type === "deliver_agent" ? scheduled.action.template : "", "inspect open work");
});

test("automation projection sends only message-to-Agent rules through RouteDecision", () => {
  const automations = normalizePersonaAutomationRules([{
    id: "message-script",
    trigger: { type: "message", routeKinds: ["private"], regex: "build" },
    action: { type: "run_script", scriptPath: "build.cmd" }
  }, {
    id: "message-agent",
    trigger: { type: "message", routeKinds: ["private"] },
    action: { type: "deliver_agent", template: "answer briefly" }
  }, {
    id: "scheduled-agent",
    trigger: { type: "schedule", schedule: { id: "daily", type: "daily_time", timeOfDay: "10:00" } },
    action: { type: "deliver_agent", message: "daily review" }
  }]);

  assert.deepEqual(notificationRulesFromPersonaAutomations(automations).map(rule => rule.id), ["message-agent"]);
});
