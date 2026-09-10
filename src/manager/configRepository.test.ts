import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ManagerConfigRepository } from "./configRepository.js";
import {
  DEFAULT_RECENT_MESSAGE_LIMIT,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-repo-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("persona Hook migration preserves settings across Agent changes and removes adapter copies", () => {
  const rootDir = makeTempRoot();
  try {
    const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
    const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
    writeJson(adapterPath, { gatewayPort: 8789, agentRoleId: "Rabi", agentAdapters: ["codex"], codexHooks: { sessionContextEnabled: false, onlyPrimaryPersonaCanSendMessages: true } });
    const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
    repo.migrateLegacyConfigs();
    assert.equal(JSON.parse(fs.readFileSync(adapterPath, "utf8")).codexHooks, undefined);
    assert.equal(JSON.parse(fs.readFileSync(personaPath, "utf8")).codexHooks.sessionContextEnabled, false);
    const config = repo.readConfig();
    const completionRule = { id: "completion-test", enabled: true, event: "task_completed",
      conditions: [{ type: "project", path: "C:/example/project" }, { type: "bound_plan" },
        { type: "include_sessions", sessions: [{ id: "session-a", name: "Task A" }] },
        { type: "exclude_sessions", sessions: [{ id: "session-b", name: "Task B" }] }],
      destination: { channel: "napcat", gatewayId: "main", params: { target: "group", instanceId: "qq", targetId: "12345" } } };
    config.gateways[0].codexHooks!.completionDeliveries = [completionRule];
    const followup = { enabled: true, cooldownSeconds: 90, rules: [{ id: "review", enabled: true, statusKeys: ["custom-review"], prompt: "Check remaining work" }] };
    config.gateways[0].codexHooks!.planFollowup = followup;
    config.gateways[0].agentAdapters = ["copilotCli"];
    repo.writeConfig(config);
    const saved = repo.readConfig().gateways[0];
    assert.equal(saved.codexHooks?.sessionContextEnabled, false);
    assert.equal(saved.codexHooks?.onlyPrimaryPersonaCanSendMessages, true);
    assert.deepEqual(saved.codexHooks?.completionDeliveries, [completionRule]);
    assert.deepEqual(saved.codexHooks?.planFollowup, followup);
    assert.deepEqual(JSON.parse(fs.readFileSync(personaPath, "utf8")).codexHooks.planFollowup, followup);
    assert.deepEqual(JSON.parse(fs.readFileSync(personaPath, "utf8")).codexHooks.completionDeliveries, [completionRule]);
    assert.equal(JSON.parse(fs.readFileSync(adapterPath, "utf8")).codexHooks, undefined);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("repository reads route config and falls back to personaConfig rules", () => {
  const rootDir = makeTempRoot();
  writeJson(path.join(rootDir, "data", "route", "main", "adapterConfig.json"), {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi"
  });
  writeJson(path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json"), {
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "tick\\ntock" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways.length, 1);
  assert.equal(config.gateways[0].id, "main");
  assert.equal(config.gateways[0].agentRoleId, "Rabi");
  assert.equal(config.gateways[0].notificationRules?.[0]?.template, "tick\ntock");
});

test("async repository read preserves the route and persona merge contract", async () => {
  const rootDir = makeTempRoot();
  writeJson(path.join(rootDir, "data", "route", "main", "adapterConfig.json"), {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi"
  });
  writeJson(path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json"), {
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "async" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  await repo.ensureDataDirsAsync();
  const persona = await repo.readRoleMessageConfigAsync("Rabi");

  assert.equal(persona.notificationRules?.[0]?.template, "async");
  assert.deepEqual(persona, repo.readRoleMessageConfig("Rabi"));
});

test("repository migrates the legacy persona limit and writes split Route/persona speech settings", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["speech", "heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    speechPushMode: "keyword"
  });
  writeJson(personaPath, {
    recentMessageLimit: 3,
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "tick" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways[0].recentMessageLimit, undefined);
  assert.equal(config.gateways[0].recentMessageLimits?.speech, 3);
  assert.equal(config.gateways[0].recentMessageLimits?.heartbeat, 3);
  assert.equal(config.gateways[0].routeProfiles?.[0]?.recentMessageLimits?.speech, 3);
  assert.equal(config.gateways[0].speechPushMode, "keyword");

  config.gateways[0].recentMessageLimits = {
    ...config.gateways[0].recentMessageLimits,
    speech: 180,
    heartbeat: 2
  };
  config.gateways[0].speechTriggerKeywords = [" 星海 ", "星海", "XinghaiBuilder"];
  repo.writeConfig(config);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as GatewayDefinition;
  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition;
  assert.equal(adapter.recentMessageLimit, undefined);
  assert.equal(adapter.recentMessageLimits, undefined);
  assert.equal(adapter.speechTriggerKeywords, undefined);
  assert.equal(adapter.speechPushMode, "keyword");
  assert.equal(persona.recentMessageLimit, undefined);
  assert.equal(persona.recentMessageLimits?.speech, 180);
  assert.equal(persona.recentMessageLimits?.heartbeat, 2);
  assert.deepEqual(persona.speechTriggerKeywords, ["星海", "XinghaiBuilder"]);
});

test("repository migrates persona-owned fields out of legacy adapter and profile data", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["speech"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    recentMessageLimit: 23,
    speechTriggerKeywords: [" Rabi ", "rabi", "兔叽"],
    routeProfiles: [{
      id: "Rabi__main",
      agentRoleId: "Rabi",
      speechPushMode: "keyword",
      notificationRules: [{ id: "speech", routeKinds: ["voice_transcript"], template: "" }]
    }]
  });
  writeJson(personaPath, {
    notificationRules: [{ id: "existing", routeKinds: ["private"], template: "keep" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.migrateLegacyConfigs();
  const config = repo.readConfig();
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as GatewayDefinition;
  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition;

  assert.equal(adapter.recentMessageLimit, undefined);
  assert.equal(adapter.recentMessageLimits, undefined);
  assert.equal(adapter.speechTriggerKeywords, undefined);
  assert.equal(adapter.routeProfiles, undefined);
  assert.equal(adapter.speechPushMode, "keyword");
  assert.equal(persona.recentMessageLimit, undefined);
  assert.equal(persona.recentMessageLimits?.napcat, 23);
  assert.equal(persona.recentMessageLimits?.speech, 23);
  assert.deepEqual(persona.speechTriggerKeywords, ["Rabi", "兔叽"]);
  assert.deepEqual(persona.automationRules?.filter(rule => rule.trigger.type === "message").map(rule => rule.id), ["existing", "speech", "role-panel-message"]);
  assert.equal(config.gateways[0].speechPushMode, "keyword");
  assert.equal(config.gateways[0].recentMessageLimits?.wecom, 23);
});

test("repository migrates legacy role rules to personaConfig and keeps adapter config clean", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "config-1", "adapterConfig.json");
  const legacyPath = path.join(rootDir, "data", "roles", "Rabi", "roleMessageConfig.json");
  const routesPath = path.join(rootDir, "data", "roles", "Rabi", "routes.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["rolePanel"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "legacy-adapter", routeKinds: ["private"], template: "" }],
    roleNotificationRules: {
      "Rabi__config-1": [{ id: "legacy-role-map", routeKinds: ["group_message"], template: "" }]
    },
    roleRouteNames: {
      "Rabi__config-1": "Old Route"
    },
    routeProfiles: [{
      id: "profile-rabi",
      agentRoleId: "Rabi",
      notificationRules: [{ id: "legacy-profile", routeKinds: ["heartbeat"], template: "" }]
    }, {
      id: "profile-momo",
      agentRoleId: "Momo",
      notificationRules: [{ id: "momo-profile", routeKinds: ["private"], template: "" }]
    }]
  });
  writeJson(legacyPath, {
    configs: [{
      configName: "main",
      notificationRules: [{ id: "legacy-role", routeKinds: ["heartbeat"], template: "" }]
    }]
  });
  writeJson(routesPath, {
    notificationRules: [{ id: "legacy-routes", routeKinds: ["group_message"], template: "" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.migrateLegacyConfigs();
  const config = repo.readConfig();

  assert.equal(fs.existsSync(adapterPath), true);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(routesPath), false);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as GatewayDefinition;
  assert.equal(Array.isArray(adapter.notificationRules), false);
  assert.equal(Array.isArray(adapter.routeProfiles), false);
  assert.equal(adapter.roleNotificationRules, undefined);
  assert.equal(adapter.roleRouteNames, undefined);
  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition;
  assert.deepEqual(persona.automationRules?.filter(rule => rule.trigger.type === "message").map(rule => rule.id), [
    "legacy-role",
    "legacy-routes",
    "legacy-adapter",
    "legacy-profile",
    "legacy-role-map",
    "role-panel-message"
  ]);
  assert.deepEqual(config.gateways[0].notificationRules?.map(rule => rule.id), [
    "legacy-role",
    "legacy-routes",
    "legacy-adapter",
    "legacy-profile",
    "legacy-role-map",
    "role-panel-message",
    "default-rolePanel"
  ]);
  assert.deepEqual(
    config.gateways[0].notificationRules?.find(rule => rule.id === "default-rolePanel")?.routeKinds,
    ["manual_trigger"]
  );
  const momoPersona = JSON.parse(fs.readFileSync(path.join(rootDir, "data", "roles", "Momo", "personaConfig.json"), "utf8")) as GatewayDefinition;
  assert.deepEqual(momoPersona.automationRules?.filter(rule => rule.trigger.type === "message").map(rule => rule.id), [
    "momo-profile",
    "role-panel-message"
  ]);
});

test("repository migration preserves existing personaConfig fields and rules", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "adapter-new", routeKinds: ["heartbeat"], template: "from adapter" }]
  });
  writeJson(personaPath, {
    routeVariables: { tone: "warm" },
    notificationRules: [
      { id: "existing", routeKinds: ["private"], template: "keep me" },
      { id: "adapter-new", routeKinds: ["private"], template: "persona wins by id" }
    ]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.migrateLegacyConfigs();

  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition & { routeVariables?: Record<string, string> };
  assert.deepEqual(persona.routeVariables, { tone: "warm" });
  assert.deepEqual(persona.automationRules
    ?.filter(rule => rule.trigger.type === "message" && rule.action.type === "deliver_agent")
    .map(rule => [rule.id, rule.action.type === "deliver_agent" ? rule.action.template : ""]), [
    ["existing", "keep me"],
    ["adapter-new", "persona wins by id"],
    ["role-panel-message", ""]
  ]);

  repo.writePersonaConfig("Rabi", {
    recentMessageLimits: { speech: 42 },
    speechTriggerKeywords: ["Rabi"],
    languageStyle: { styleSkillUrl: "file:///styles/rabi" }
  });
  const updated = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition & { routeVariables?: Record<string, string> };
  assert.deepEqual(updated.routeVariables, { tone: "warm" });
  assert.deepEqual(updated.automationRules
    ?.filter(rule => rule.trigger.type === "message" && rule.action.type === "deliver_agent")
    .map(rule => [rule.id, rule.action.type === "deliver_agent" ? rule.action.template : ""]), [
    ["existing", "keep me"],
    ["adapter-new", "persona wins by id"],
    ["role-panel-message", ""]
  ]);
  assert.equal(updated.recentMessageLimits?.speech, 42);
  assert.equal(updated.recentMessageLimits?.napcat, DEFAULT_RECENT_MESSAGE_LIMIT);
  assert.deepEqual(updated.speechTriggerKeywords, ["Rabi"]);
  assert.deepEqual(updated.languageStyle, { styleSkillUrl: "file:///styles/rabi" });
});

test("repository writes normalized configs and removes renamed route files", () => {
  const rootDir = makeTempRoot();
  const oldConfigPath = path.join(rootDir, "data", "route", "old", "adapterConfig.json");
  writeJson(oldConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8789 });
  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const next: GatewayDefinition = {
    id: "old",
    configName: "new",
    enabled: true,
    messageAdapters: ["webhook"],
    gatewayPort: 8790,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "hello" }]
  };

  const written = repo.writeConfig({ gateways: [next] });
  const newConfigPath = path.join(rootDir, "data", "route", "new", "adapterConfig.json");

  assert.equal(written.gateways[0].configName, "new");
  assert.equal(written.gateways[0].webhookPort, 8791);
  assert.equal(fs.existsSync(oldConfigPath), false);
  assert.equal(fs.existsSync(newConfigPath), true);
});

test("repository upgrades legacy Codex agent adapters on read and write", () => {
  const rootDir = makeTempRoot();
  const configPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  writeJson(configPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["codexDesktop", "codexApp", "copilotCli"]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.deepEqual(config.gateways[0].agentAdapters, ["codex", "copilotCli"]);
  assert.equal(config.gateways[0].primaryAgentAdapter, "codex");

  repo.writeConfig(config);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayDefinition;
  assert.deepEqual(saved.agentAdapters, ["codex", "copilotCli"]);
  assert.equal(saved.primaryAgentAdapter, "codex");
});

test("repository migrates a Copilot-only legacy thread name and saves only the new field", () => {
  const rootDir = makeTempRoot();
  const configPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  writeJson(configPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["copilotCli"],
    codexThreadName: "Legacy Copilot Session"
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways[0].copilotThreadName, "Legacy Copilot Session");
  assert.equal(config.gateways[0].codexThreadName, undefined);

  repo.writeConfig(config);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayDefinition;
  assert.equal(saved.copilotThreadName, "Legacy Copilot Session");
  assert.equal(saved.codexThreadName, undefined);
});

test("repository does not reinterpret a Codex thread name for mixed agent routes", () => {
  const rootDir = makeTempRoot();
  const configPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  writeJson(configPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["codex", "copilotCli"],
    codexThreadName: "Codex Session"
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways[0].codexThreadName, "Codex Session");
  assert.equal(config.gateways[0].copilotThreadName, undefined);
});

test("repository writes local cwd-like config paths as project relative paths", () => {
  const rootDir = makeTempRoot();
  const configPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.writeConfig({
    gateways: [{
      id: "main",
      configName: "main",
      enabled: true,
      messageAdapters: ["napcat"],
      gatewayPort: 8789,
      remoteAgentDefaultCwd: path.join(rootDir, "remote-agent"),
      codexCwd: rootDir,
      copilotCwd: path.join(rootDir, "copilot-project"),
      rolesDir: path.join(rootDir, "data", "roles"),
      napcatInstances: [{
        id: "default",
        enabled: true,
        gatewayPort: 8789,
        httpUrl: "http://127.0.0.1:3000",
        workingDir: path.join(rootDir, "tools", "NapCat")
      }],
      notificationRules: []
    }]
  });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayDefinition;
  assert.equal(saved.remoteAgentDefaultCwd, "remote-agent");
  assert.equal(saved.codexCwd, ".");
  assert.equal(saved.copilotCwd, "copilot-project");
  assert.equal(saved.rolesDir, "data/roles");
  assert.equal(saved.napcatInstances?.[0]?.workingDir, "tools/NapCat");
});

test("repository rebases stale same-workspace drive cwd when saving", () => {
  const tempRoot = makeTempRoot();
  const configPath = path.join(tempRoot, "data", "route", "main", "adapterConfig.json");
  const repo = new ManagerConfigRepository({ rootDir: tempRoot, managerPort: 8790 });
  const staleSameWorkspace = tempRoot.replace(/^[A-Za-z]:/, "X:");
  repo.writeConfig({
    gateways: [{
      id: "main",
      configName: "main",
      enabled: true,
      messageAdapters: ["heartbeat"],
      gatewayPort: 8789,
      codexCwd: staleSameWorkspace,
      notificationRules: []
    }]
  });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayDefinition;
  assert.equal(saved.codexCwd, ".");
});

test("repository fails closed for explicitly invalid agent adapters", () => {
  const rootDir = makeTempRoot();
  writeJson(path.join(rootDir, "data", "route", "main", "adapterConfig.json"), {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["unknown"]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.deepEqual(config.gateways[0].agentAdapters, []);
});

test("repository removes deleted route config files but preserves route history", () => {
  const rootDir = makeTempRoot();
  const keepConfigPath = path.join(rootDir, "data", "route", "keep", "adapterConfig.json");
  const removedConfigPath = path.join(rootDir, "data", "route", "removed", "adapterConfig.json");
  const removedHistoryPath = path.join(rootDir, "data", "route", "removed", "group-messages.jsonl");
  writeJson(keepConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8791 });
  writeJson(removedConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8792 });
  fs.writeFileSync(removedHistoryPath, `${JSON.stringify({ message: "keep me" })}\n`, "utf8");

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.writeConfig({
    gateways: [{
      id: "keep",
      configName: "keep",
      enabled: true,
      messageAdapters: ["heartbeat"],
      gatewayPort: 8791,
      agentRoleId: "Rabi",
      notificationRules: []
    }]
  });

  assert.equal(fs.existsSync(keepConfigPath), true);
  assert.equal(fs.existsSync(removedConfigPath), false);
  assert.equal(fs.existsSync(removedHistoryPath), true);
});
