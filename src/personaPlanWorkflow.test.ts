import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addPersonaPlanStatusDefinition,
  beginPersonaPlanStatusRetirement,
  completePersonaPlanStatusRetirement,
  ensurePersonaPlanWorkflow,
  loadDefaultPersonaPlanWorkflow,
  mergePersonaPlanWorkflowConfig,
  planStatusDefinition,
  planStatusKeyForRole,
  personaPlanWorkflowRevision,
  readPersonaPlanWorkflow,
  requireEnabledPersonaPlanStatus,
  resolvePersonaPlanStatus,
  resolvePersonaPlanWorkflowRole,
  validatePersonaPlanWorkflow,
  writePersonaPlanWorkflow,
  type PersonaPlanWorkflow
} from "./personaPlanWorkflow.js";

function roleFixture(t: test.TestContext): string {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-workflow-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  return roleDir;
}

function cloneDefault(): PersonaPlanWorkflow {
  return structuredClone(loadDefaultPersonaPlanWorkflow());
}

test("default persona plan workflow defines the ten current statuses and legacy read aliases", () => {
  const workflow = loadDefaultPersonaPlanWorkflow();
  assert.equal(workflow.schemaVersion, 4);
  assert.equal(workflow.archiveAfterHours, 72);
  assert.deepEqual(workflow.statuses.map((status) => status.key), [
    "分析中", "待补充信息", "待审批", "执行中", "等待打包", "等待 QA", "待讨论", "暂停", "完成", "关闭"
  ]);
  assert.deepEqual(workflow.roles, {
    initial: "分析中",
    analysis: "分析中",
    informationNeeded: "待补充信息",
    approval: "待审批",
    execution: "执行中",
    waitingPackage: "等待打包",
    waitingQa: "等待 QA",
    discussion: "待讨论",
    paused: "暂停",
    completed: "完成",
    closed: "关闭"
  });
  assert.equal(resolvePersonaPlanStatus(workflow, "进行中")?.key, "分析中");
  assert.equal(resolvePersonaPlanStatus(workflow, "已完成")?.key, "完成");
  assert.equal(resolvePersonaPlanStatus(workflow, "已归档")?.key, "关闭");
  assert.equal(resolvePersonaPlanStatus(workflow, "未开始")?.key, "暂停");
  assert.equal(planStatusKeyForRole(workflow, "approval"), "待审批");
  assert.equal(planStatusKeyForRole(workflow, "informationNeeded"), "待补充信息");
  assert.equal(planStatusDefinition(workflow, "执行中")?.label, "执行中");
  assert.throws(() => requireEnabledPersonaPlanStatus(workflow, "进行中"), /Unsupported plan status key/);
});

test("status keys and labels are independent while workflow roles resolve enabled entries", () => {
  const workflow = cloneDefault();
  const analysis = workflow.statuses.find((status) => status.key === "分析中")!;
  analysis.key = "analysis";
  analysis.label = "方案研究中";
  workflow.roles.initial = "analysis";
  workflow.roles.analysis = "analysis";
  const validated = validatePersonaPlanWorkflow(workflow);
  assert.equal(resolvePersonaPlanWorkflowRole(validated, "analysis").key, "analysis");
  assert.equal(resolvePersonaPlanWorkflowRole(validated, "analysis").label, "方案研究中");
  assert.equal(resolvePersonaPlanStatus(validated, "进行中")?.key, "analysis");
});

test("workflow validation rejects ambiguous identifiers and invalid lifecycle semantics", () => {
  const duplicateKey = cloneDefault();
  duplicateKey.statuses[1]!.key = duplicateKey.statuses[0]!.key;
  assert.throws(() => validatePersonaPlanWorkflow(duplicateKey), /keys must be unique|identifier/);

  const duplicateAlias = cloneDefault();
  duplicateAlias.statuses[1]!.legacyAliases = ["进行中"];
  assert.throws(() => validatePersonaPlanWorkflow(duplicateAlias), /identifier 进行中 is shared/);

  const retiredRole = cloneDefault();
  retiredRole.statuses.find((status) => status.key === retiredRole.roles.execution)!.state = "retiring";
  assert.throws(() => validatePersonaPlanWorkflow(retiredRole), /roles\.execution must reference an enabled status/);

  const nonTerminalArchive = cloneDefault();
  nonTerminalArchive.statuses[0]!.archiveEligible = true;
  assert.throws(() => validatePersonaPlanWorkflow(nonTerminalArchive), /terminal when it is archive eligible/);

  const terminalCurrent = cloneDefault();
  terminalCurrent.statuses.find((status) => status.key === "完成")!.views = ["current", "plans"];
  assert.throws(() => validatePersonaPlanWorkflow(terminalCurrent), /cannot appear in the current view/);

  const invalidPalette = cloneDefault();
  invalidPalette.statuses[0]!.palette.accent = "cyan";
  assert.throws(() => validatePersonaPlanWorkflow(invalidPalette), /#RRGGBB/);

  const misspelledField = cloneDefault() as PersonaPlanWorkflow & { archiveAfterHour?: number };
  misspelledField.archiveAfterHour = 72;
  assert.throws(() => validatePersonaPlanWorkflow(misspelledField), /unsupported fields: archiveAfterHour/);
});

test("a retiring or retired status remains readable but is rejected by normal write validation", () => {
  const workflow = cloneDefault();
  const discussion = workflow.statuses.find((status) => status.key === "待讨论")!;
  discussion.state = "retiring";
  workflow.roles.discussion = "执行中";
  const validated = validatePersonaPlanWorkflow(workflow);
  assert.equal(resolvePersonaPlanStatus(validated, "待讨论")?.status.state, "retiring");
  assert.equal(planStatusDefinition(validated, "待讨论"), null);
  assert.equal(planStatusDefinition(validated, "待讨论", { allowRetired: true })?.state, "retiring");
  assert.throws(() => requireEnabledPersonaPlanStatus(validated, "待讨论"), /not enabled/);
  discussion.state = "retired";
  const retired = validatePersonaPlanWorkflow(workflow);
  assert.equal(resolvePersonaPlanStatus(retired, "待讨论")?.status.state, "retired");
});

test("status additions and two-phase retirement keep keys immutable and roles valid", () => {
  const workflow = cloneDefault();
  const analysis = resolvePersonaPlanWorkflowRole(workflow, "analysis");
  const added = addPersonaPlanStatusDefinition(workflow, {
    ...analysis,
    key: "需求分析",
    label: "需求分析",
    labelEn: "Requirement analysis",
    order: 20,
    legacyAliases: []
  });
  assert.equal(requireEnabledPersonaPlanStatus(added, "需求分析").label, "需求分析");
  assert.throws(
    () => beginPersonaPlanStatusRetirement(added, "分析中", "暂停"),
    /roles\.analysis|roles\.initial/
  );
  const retiring = beginPersonaPlanStatusRetirement(added, "分析中", "需求分析");
  assert.equal(retiring.roles.analysis, "需求分析");
  assert.equal(retiring.roles.initial, "需求分析");
  assert.equal(planStatusDefinition(retiring, "分析中", { allowRetired: true })?.state, "retiring");
  const retired = completePersonaPlanStatusRetirement(retiring, "分析中");
  assert.equal(planStatusDefinition(retired, "分析中", { allowRetired: true })?.state, "retired");
});

test("first materialization preserves unrelated persona settings and is idempotent", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ avatar: "avatar.png", recentMessageLimit: 12 })}\n`, "utf8");

  assert.equal(readPersonaPlanWorkflow(roleDir), null);
  const first = ensurePersonaPlanWorkflow(roleDir);
  const firstBytes = fs.readFileSync(configPath, "utf8");
  const stored = JSON.parse(firstBytes) as Record<string, unknown>;
  assert.equal(stored.avatar, "avatar.png");
  assert.equal(stored.recentMessageLimit, 12);
  assert.equal(first.revision, personaPlanWorkflowRevision(first.workflow));

  const second = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(second.revision, first.revision);
  assert.equal(fs.readFileSync(configPath, "utf8"), firstBytes);
});

test("schema v1 workflows migrate once without restoring removed statuses later", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  const current = cloneDefault();
  const legacyWorkflow = {
    ...current,
    schemaVersion: 1,
    statuses: current.statuses
      .filter((status) => status.key !== current.roles.informationNeeded)
      .map((status, order) => ({ ...status, order })),
    roles: Object.fromEntries(
      Object.entries(current.roles).filter(([role]) => role !== "informationNeeded")
    )
  };
  fs.writeFileSync(configPath, `${JSON.stringify({ custom: { keep: true }, planWorkflow: legacyWorkflow }, null, 2)}\n`, "utf8");

  const migrated = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(migrated.workflow.schemaVersion, 4);
  assert.equal(migrated.workflow.roles.informationNeeded, "待补充信息");
  assert.deepEqual(migrated.workflow.statuses.map((status) => status.key), [
    "分析中", "待补充信息", "待审批", "执行中", "等待打包", "等待 QA", "待讨论", "暂停", "完成", "关闭"
  ]);
  const firstBytes = fs.readFileSync(configPath, "utf8");
  assert.equal((JSON.parse(firstBytes) as Record<string, unknown>).custom != null, true);
  assert.equal(ensurePersonaPlanWorkflow(roleDir).revision, migrated.revision);
  assert.equal(fs.readFileSync(configPath, "utf8"), firstBytes);

  const withoutInformationNeeded = beginPersonaPlanStatusRetirement(
    migrated.workflow,
    migrated.workflow.roles.informationNeeded,
    migrated.workflow.roles.analysis
  );
  const retired = completePersonaPlanStatusRetirement(withoutInformationNeeded, "待补充信息");
  writePersonaPlanWorkflow(roleDir, retired, { expectedRevision: migrated.revision });
  const afterRemoval = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(afterRemoval.workflow.roles.informationNeeded, "分析中");
  assert.equal(planStatusDefinition(afterRemoval.workflow, "待补充信息", { allowRetired: true })?.state, "retired");
});

test("schema v3 workflows narrow the stock information-needed meaning without changing the catalog", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  const current = cloneDefault();
  const informationNeeded = current.statuses.find((status) => status.key === current.roles.informationNeeded)!;
  informationNeeded.description = "分析已完成，但目标、范围、验收标准或实施依据仍不足，正在等待补充信息。";
  informationNeeded.descriptionEn = "Analysis is complete, but the goal, scope, acceptance criteria, or implementation evidence is still insufficient and requires more information.";
  const legacyWorkflow = { ...current, schemaVersion: 3 };
  fs.writeFileSync(configPath, `${JSON.stringify({ custom: { keep: true }, planWorkflow: legacyWorkflow }, null, 2)}\n`, "utf8");

  const migrated = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(migrated.workflow.schemaVersion, 4);
  assert.equal(migrated.workflow.statuses.length, 10);
  assert.deepEqual(migrated.workflow.statuses.map((status) => status.key), [
    "分析中", "待补充信息", "待审批", "执行中", "等待打包", "等待 QA", "待讨论", "暂停", "完成", "关闭"
  ]);
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息")?.description, "分析已完成，但无法根据现有信息形成可审批的具体方案。");
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息")?.descriptionEn, "Analysis is complete, but the available information is insufficient to form a concrete proposal for approval.");
  const firstBytes = fs.readFileSync(configPath, "utf8");
  assert.deepEqual((JSON.parse(firstBytes) as Record<string, unknown>).custom, { keep: true });
  assert.equal(ensurePersonaPlanWorkflow(roleDir).revision, migrated.revision);
  assert.equal(fs.readFileSync(configPath, "utf8"), firstBytes);
});

test("schema v2 workflows use the same one-time stock description migration", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  const current = cloneDefault();
  const informationNeeded = current.statuses.find((status) => status.key === current.roles.informationNeeded)!;
  informationNeeded.description = "分析已完成，但目标、范围、验收标准或实施依据仍不足，正在等待补充信息。";
  informationNeeded.descriptionEn = "Analysis is complete, but the goal, scope, acceptance criteria, or implementation evidence is still insufficient and requires more information.";
  fs.writeFileSync(configPath, `${JSON.stringify({ planWorkflow: { ...current, schemaVersion: 2 } }, null, 2)}\n`, "utf8");

  const migrated = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(migrated.workflow.schemaVersion, 4);
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息")?.description, "分析已完成，但无法根据现有信息形成可审批的具体方案。");
  assert.equal(migrated.workflow.statuses.length, 10);
});

test("schema v3 migration preserves customized information-needed descriptions", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  const current = cloneDefault();
  const informationNeeded = current.statuses.find((status) => status.key === current.roles.informationNeeded)!;
  informationNeeded.description = "由人格自定义的中文说明。";
  informationNeeded.descriptionEn = "Persona-specific English description.";
  fs.writeFileSync(configPath, `${JSON.stringify({ planWorkflow: { ...current, schemaVersion: 3 } }, null, 2)}\n`, "utf8");

  const migrated = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息")?.description, "由人格自定义的中文说明。");
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息")?.descriptionEn, "Persona-specific English description.");
});

test("schema v3 migration does not restore a retired information-needed status", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  const current = cloneDefault();
  const retiring = beginPersonaPlanStatusRetirement(current, "待补充信息", "分析中");
  const retired = completePersonaPlanStatusRetirement(retiring, "待补充信息");
  fs.writeFileSync(configPath, `${JSON.stringify({ planWorkflow: { ...retired, schemaVersion: 3 } }, null, 2)}\n`, "utf8");

  const migrated = ensurePersonaPlanWorkflow(roleDir);
  assert.equal(migrated.workflow.roles.informationNeeded, "分析中");
  assert.equal(planStatusDefinition(migrated.workflow, "待补充信息", { allowRetired: true })?.state, "retired");
  assert.equal(migrated.workflow.statuses.length, 10);
});

test("atomic workflow writes use revision fencing and preserve the rest of personaConfig", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ languageStyle: { skill: "current-language-style" } })}\n`, "utf8");
  const initial = ensurePersonaPlanWorkflow(roleDir);
  const changed = structuredClone(initial.workflow);
  changed.statuses[0]!.label = "正在分析";

  const written = writePersonaPlanWorkflow(roleDir, changed, { expectedRevision: initial.revision });
  assert.notEqual(written.revision, initial.revision);
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.languageStyle, { skill: "current-language-style" });
  assert.equal((stored.planWorkflow as PersonaPlanWorkflow).statuses[0]?.label, "正在分析");
  assert.throws(
    () => writePersonaPlanWorkflow(roleDir, initial.workflow, { expectedRevision: initial.revision }),
    /PERSONA_PLAN_WORKFLOW_REVISION_CONFLICT/
  );
  assert.equal(readPersonaPlanWorkflow(roleDir)?.revision, written.revision);
});

test("malformed persona configuration is never overwritten during materialization", (t) => {
  const roleDir = roleFixture(t);
  const configPath = path.join(roleDir, "personaConfig.json");
  fs.writeFileSync(configPath, "{broken", "utf8");
  assert.throws(() => ensurePersonaPlanWorkflow(roleDir), /malformed personaConfig/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "{broken");
});

test("pure workflow merge retains every unrelated top-level field", () => {
  const workflow = cloneDefault();
  const merged = mergePersonaPlanWorkflowConfig({
    avatar: "a.png",
    automationRules: [{ id: "rule" }],
    custom: { keep: true }
  }, workflow);
  assert.equal(merged.avatar, "a.png");
  assert.deepEqual(merged.automationRules, [{ id: "rule" }]);
  assert.deepEqual(merged.custom, { keep: true });
  assert.deepEqual(merged.planWorkflow, workflow);
});
