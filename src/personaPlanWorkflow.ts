import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";

export type PersonaPlanStatusState = "enabled" | "retiring" | "retired";
export type PersonaPlanCurrentStepPolicy = "required" | "optional" | "forbidden";
export type PersonaPlanView = "current" | "plans";
export type PersonaPlanWorkflowRole =
  | "initial"
  | "analysis"
  | "informationNeeded"
  | "approval"
  | "execution"
  | "waitingPackage"
  | "waitingQa"
  | "discussion"
  | "paused"
  | "completed"
  | "closed";

export type PersonaPlanStatusPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export type PersonaPlanWorkflowStatus = {
  key: string;
  state: PersonaPlanStatusState;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  order: number;
  palette: PersonaPlanStatusPalette;
  views: PersonaPlanView[];
  currentStep: PersonaPlanCurrentStepPolicy;
  requiresApproval: boolean;
  acceptsGuidance: boolean;
  setsCompletedAt: boolean;
  terminal: boolean;
  archiveEligible: boolean;
  legacyAliases: string[];
};

export type PersonaPlanStatusDefinition = PersonaPlanWorkflowStatus;

export type PersonaPlanWorkflow = {
  schemaVersion: 4;
  archiveAfterHours: number;
  statuses: PersonaPlanWorkflowStatus[];
  roles: Record<PersonaPlanWorkflowRole, string>;
};

export type PersonaPlanWorkflowReadResult = {
  workflow: PersonaPlanWorkflow;
  revision: string;
  materialized: boolean;
};

export type ResolvedPersonaPlanStatus = {
  status: PersonaPlanWorkflowStatus;
  key: string;
  matchedBy: "key" | "legacyAlias";
};

const LEGACY_WORKFLOW_ROLES = [
  "initial",
  "analysis",
  "approval",
  "execution",
  "waitingPackage",
  "waitingQa",
  "discussion",
  "paused",
  "completed",
  "closed"
] as const;
const WORKFLOW_ROLES: PersonaPlanWorkflowRole[] = [
  "initial",
  "analysis",
  "informationNeeded",
  "approval",
  "execution",
  "waitingPackage",
  "waitingQa",
  "discussion",
  "paused",
  "completed",
  "closed"
];
const STATUS_STATES = new Set<PersonaPlanStatusState>(["enabled", "retiring", "retired"]);
const CURRENT_STEP_POLICIES = new Set<PersonaPlanCurrentStepPolicy>(["required", "optional", "forbidden"]);
const PLAN_VIEWS = new Set<PersonaPlanView>(["current", "plans"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_WORKFLOW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/default-persona-plan-workflow.json"
);
const LEGACY_INFORMATION_NEEDED_DESCRIPTION = "分析已完成，但目标、范围、验收标准或实施依据仍不足，正在等待补充信息。";
const LEGACY_INFORMATION_NEEDED_DESCRIPTION_EN = "Analysis is complete, but the goal, scope, acceptance criteria, or implementation evidence is still insufficient and requires more information.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}.`);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > maximum) throw new Error(`${field} exceeds ${maximum} characters.`);
  if(/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${field} contains control characters.`);
  return text;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function normalizedPalette(value: unknown, field: string): PersonaPlanStatusPalette {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertOnlyKeys(value, ["accent", "background", "foreground"], field);
  const result = {
    accent: requiredText(value.accent, `${field}.accent`, 7),
    background: requiredText(value.background, `${field}.background`, 7),
    foreground: requiredText(value.foreground, `${field}.foreground`, 7)
  };
  for (const [name, color] of Object.entries(result)) {
    if (!HEX_COLOR.test(color)) throw new Error(`${field}.${name} must be a #RRGGBB color.`);
  }
  return result;
}

function normalizedStringArray(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > maximum) throw new Error(`${field} has too many entries.`);
  const result = value.map((entry, index) => requiredText(entry, `${field}[${index}]`, 80));
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates.`);
  return result;
}

function normalizedStatus(value: unknown, index: number, schemaVersion: number): PersonaPlanWorkflowStatus {
  const field = `planWorkflow.statuses[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertOnlyKeys(value, [
    "key",
    "state",
    "label",
    "labelEn",
    "description",
    "descriptionEn",
    "order",
    "palette",
    "views",
    "currentStep",
    "requiresApproval",
    "acceptsGuidance",
    ...(schemaVersion < 3 ? ["requiresCompletedSteps"] : []),
    "setsCompletedAt",
    "terminal",
    "archiveEligible",
    "legacyAliases"
  ], field);
  const key = requiredText(value.key, `${field}.key`, 80);
  if (/[/\\]/.test(key)) throw new Error(`${field}.key must not contain path separators.`);
  const state = value.state as PersonaPlanStatusState;
  if (!STATUS_STATES.has(state)) throw new Error(`${field}.state is unsupported.`);
  const currentStep = value.currentStep as PersonaPlanCurrentStepPolicy;
  if (!CURRENT_STEP_POLICIES.has(currentStep)) throw new Error(`${field}.currentStep is unsupported.`);
  const views = normalizedStringArray(value.views, `${field}.views`, PLAN_VIEWS.size) as PersonaPlanView[];
  if (views.some((view) => !PLAN_VIEWS.has(view))) throw new Error(`${field}.views contains an unsupported view.`);
  if (!views.includes("plans")) throw new Error(`${field}.views must include plans.`);
  if (views.includes("current") && !views.includes("plans")) {
    throw new Error(`${field}.views must include plans whenever it includes current.`);
  }
  const order = Number(value.order);
  if (!Number.isInteger(order) || order < 0 || order > 10_000) {
    throw new Error(`${field}.order must be an integer from 0 to 10000.`);
  }
  const status: PersonaPlanWorkflowStatus = {
    key,
    state,
    label: requiredText(value.label, `${field}.label`, 80),
    labelEn: requiredText(value.labelEn, `${field}.labelEn`, 80),
    description: requiredText(value.description, `${field}.description`, 500),
    descriptionEn: requiredText(value.descriptionEn, `${field}.descriptionEn`, 500),
    order,
    palette: normalizedPalette(value.palette, `${field}.palette`),
    views,
    currentStep,
    requiresApproval: requiredBoolean(value.requiresApproval, `${field}.requiresApproval`),
    acceptsGuidance: requiredBoolean(value.acceptsGuidance, `${field}.acceptsGuidance`),
    setsCompletedAt: requiredBoolean(value.setsCompletedAt, `${field}.setsCompletedAt`),
    terminal: requiredBoolean(value.terminal, `${field}.terminal`),
    archiveEligible: requiredBoolean(value.archiveEligible, `${field}.archiveEligible`),
    legacyAliases: normalizedStringArray(value.legacyAliases, `${field}.legacyAliases`, 32)
  };
  if (status.legacyAliases.includes(status.key)) throw new Error(`${field}.legacyAliases must not repeat its key.`);
  if (status.requiresApproval && status.currentStep !== "required") {
    throw new Error(`${field} requires a current step when approval is required.`);
  }
  if (status.requiresApproval && status.acceptsGuidance) {
    throw new Error(`${field} cannot accept guidance while approval is required.`);
  }
  if (status.setsCompletedAt && !status.terminal) {
    throw new Error(`${field} must be terminal when it sets completedAt.`);
  }
  if (status.archiveEligible && !status.terminal) {
    throw new Error(`${field} must be terminal when it is archive eligible.`);
  }
  if (status.terminal && status.currentStep !== "forbidden") {
    throw new Error(`${field} must forbid currentStep when it is terminal.`);
  }
  if (status.terminal && status.views.includes("current")) {
    throw new Error(`${field} cannot appear in the current view when it is terminal.`);
  }
  return status;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validatePersonaPlanWorkflow(value: unknown): PersonaPlanWorkflow {
  if (!isRecord(value)) throw new Error("planWorkflow must be an object.");
  assertOnlyKeys(value, ["schemaVersion", "archiveAfterHours", "statuses", "roles"], "planWorkflow");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) {
    throw new Error("planWorkflow.schemaVersion must be 1, 2, 3, or 4.");
  }
  const archiveAfterHours = Number(value.archiveAfterHours);
  if (!Number.isInteger(archiveAfterHours) || archiveAfterHours < 1 || archiveAfterHours > 87_600) {
    throw new Error("planWorkflow.archiveAfterHours must be an integer from 1 to 87600.");
  }
  if (!Array.isArray(value.statuses) || value.statuses.length === 0 || value.statuses.length > 64) {
    throw new Error("planWorkflow.statuses must contain 1 to 64 entries.");
  }
  const statuses = value.statuses.map((status, index) => normalizedStatus(status, index, Number(value.schemaVersion)));
  const keys = statuses.map((status) => status.key);
  if (new Set(keys).size !== keys.length) throw new Error("planWorkflow status keys must be unique.");
  const orders = statuses.map((status) => status.order);
  if (new Set(orders).size !== orders.length) throw new Error("planWorkflow status order values must be unique.");
  const labels = statuses.map((status) => status.label);
  if (new Set(labels).size !== labels.length) throw new Error("planWorkflow status labels must be unique.");
  const labelsEn = statuses.map((status) => status.labelEn.toLocaleLowerCase("en-US"));
  if (new Set(labelsEn).size !== labelsEn.length) throw new Error("planWorkflow English status labels must be unique.");

  const ownedIdentifiers = new Map<string, string>();
  for (const status of statuses) {
    for (const identifier of [status.key, ...status.legacyAliases]) {
      const owner = ownedIdentifiers.get(identifier);
      if (owner) throw new Error(`planWorkflow status identifier ${identifier} is shared by ${owner} and ${status.key}.`);
      ownedIdentifiers.set(identifier, status.key);
    }
  }

  if (!isRecord(value.roles)) throw new Error("planWorkflow.roles must be an object.");
  const roleNames = value.schemaVersion === 1 ? LEGACY_WORKFLOW_ROLES : WORKFLOW_ROLES;
  assertOnlyKeys(value.roles, roleNames, "planWorkflow.roles");
  const roles = {} as Record<PersonaPlanWorkflowRole, string>;
  for (const role of roleNames) {
    const key = requiredText(value.roles[role], `planWorkflow.roles.${role}`, 80);
    const status = statuses.find((candidate) => candidate.key === key);
    if (!status) throw new Error(`planWorkflow.roles.${role} references an unknown status key: ${key}.`);
    if (status.state !== "enabled") throw new Error(`planWorkflow.roles.${role} must reference an enabled status.`);
    roles[role] = key;
  }
  if (value.schemaVersion === 1) {
    return migratePersonaPlanWorkflowV1({
      schemaVersion: 1,
      archiveAfterHours,
      statuses,
      roles
    });
  }
  const migratedStatuses = value.schemaVersion < 4
    ? migrateLegacyInformationNeededDescription(statuses, roles)
    : statuses;
  const roleStatus = (role: PersonaPlanWorkflowRole) => migratedStatuses.find((status) => status.key === roles[role])!;
  if (!roleStatus("approval").requiresApproval) throw new Error("planWorkflow.roles.approval must require approval.");
  for (const role of ["initial", "analysis", "informationNeeded", "approval", "execution", "waitingPackage", "waitingQa", "discussion"] as const) {
    if (roleStatus(role).currentStep !== "required") {
      throw new Error(`planWorkflow.roles.${role} must require a current step.`);
    }
  }
  for (const role of ["analysis", "informationNeeded", "execution"] as const) {
    if (!roleStatus(role).acceptsGuidance) {
      throw new Error(`planWorkflow.roles.${role} must accept guidance.`);
    }
  }
  if (roleStatus("paused").currentStep === "forbidden") {
    throw new Error("planWorkflow.roles.paused must allow a current step for resumption.");
  }
  if (!roleStatus("completed").setsCompletedAt) {
    throw new Error("planWorkflow.roles.completed must set completedAt.");
  }
  for (const role of ["completed", "closed"] as const) {
    if (!roleStatus(role).terminal || !roleStatus(role).archiveEligible) {
      throw new Error(`planWorkflow.roles.${role} must be terminal and archive eligible.`);
    }
  }
  for (const role of ["initial", "analysis", "informationNeeded", "approval", "execution", "waitingPackage", "waitingQa", "discussion", "paused"] as const) {
    if (roleStatus(role).terminal) throw new Error(`planWorkflow.roles.${role} must not be terminal.`);
  }
  return { schemaVersion: 4, archiveAfterHours, statuses: migratedStatuses, roles };
}

function migrateLegacyInformationNeededDescription(
  statuses: PersonaPlanWorkflowStatus[],
  roles: Partial<Record<PersonaPlanWorkflowRole, string>>
): PersonaPlanWorkflowStatus[] {
  const defaultWorkflow = loadDefaultPersonaPlanWorkflow();
  const defaultStatus = defaultWorkflow.statuses.find(
    (status) => status.key === defaultWorkflow.roles.informationNeeded
  );
  if (!defaultStatus || roles.informationNeeded !== defaultStatus.key) return statuses;
  return statuses.map((status) => {
    if (
      status.key !== defaultStatus.key
      || status.label !== defaultStatus.label
      || status.labelEn.toLocaleLowerCase("en-US") !== defaultStatus.labelEn.toLocaleLowerCase("en-US")
    ) {
      return status;
    }
    const description = status.description === LEGACY_INFORMATION_NEEDED_DESCRIPTION
      ? defaultStatus.description
      : status.description;
    const descriptionEn = status.descriptionEn === LEGACY_INFORMATION_NEEDED_DESCRIPTION_EN
      ? defaultStatus.descriptionEn
      : status.descriptionEn;
    return description === status.description && descriptionEn === status.descriptionEn
      ? status
      : { ...status, description, descriptionEn };
  });
}

type PersonaPlanWorkflowV1 = {
  schemaVersion: 1;
  archiveAfterHours: number;
  statuses: PersonaPlanWorkflowStatus[];
  roles: Partial<Record<PersonaPlanWorkflowRole, string>>;
};

function migratePersonaPlanWorkflowV1(workflow: PersonaPlanWorkflowV1): PersonaPlanWorkflow {
  const defaultWorkflow = loadDefaultPersonaPlanWorkflow();
  const defaultInformationNeeded = defaultWorkflow.statuses.find(
    (status) => status.key === defaultWorkflow.roles.informationNeeded
  );
  if (!defaultInformationNeeded) {
    throw new Error("The default persona plan workflow has no information-needed status.");
  }
  const normalizedLabelEn = defaultInformationNeeded.labelEn.toLocaleLowerCase("en-US");
  const existingInformationNeeded = workflow.statuses.find((status) =>
    status.key === defaultInformationNeeded.key
    || status.legacyAliases.includes(defaultInformationNeeded.key)
    || status.label === defaultInformationNeeded.label
    || status.labelEn.toLocaleLowerCase("en-US") === normalizedLabelEn
  );
  if (existingInformationNeeded && existingInformationNeeded.state !== "enabled") {
    throw new Error("The existing information-needed plan status must be enabled during schema migration.");
  }
  const informationNeeded = existingInformationNeeded ?? structuredClone(defaultInformationNeeded);
  const statusesWithoutInformationNeeded = workflow.statuses
    .filter((status) => status.key !== informationNeeded.key)
    .sort((left, right) => left.order - right.order);
  const analysisKey = workflow.roles.analysis!;
  const analysisIndex = statusesWithoutInformationNeeded.findIndex((status) => status.key === analysisKey);
  if (analysisIndex < 0) throw new Error("The legacy analysis role references an unknown status.");
  statusesWithoutInformationNeeded.splice(analysisIndex + 1, 0, informationNeeded);
  const statuses = statusesWithoutInformationNeeded.map((status, order) => ({ ...status, order }));
  return validatePersonaPlanWorkflow({
    schemaVersion: 4,
    archiveAfterHours: workflow.archiveAfterHours,
    statuses,
    roles: {
      ...workflow.roles,
      informationNeeded: informationNeeded.key
    }
  });
}

export function personaPlanWorkflowRevision(workflow: PersonaPlanWorkflow): string {
  const validated = validatePersonaPlanWorkflow(workflow);
  return createHash("sha256").update(stableJson(validated)).digest("hex");
}

export function loadDefaultPersonaPlanWorkflow(): PersonaPlanWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(DEFAULT_WORKFLOW_PATH, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot read the default persona plan workflow: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePersonaPlanWorkflow(parsed);
}

export function resolvePersonaPlanStatus(
  workflow: PersonaPlanWorkflow,
  value: unknown,
  options: { includeLegacyAliases?: boolean } = {}
): ResolvedPersonaPlanStatus | null {
  const validated = validatePersonaPlanWorkflow(workflow);
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return null;
  const exact = validated.statuses.find((status) => status.key === key);
  if (exact) return { status: exact, key: exact.key, matchedBy: "key" };
  if (options.includeLegacyAliases === false) return null;
  const alias = validated.statuses.find((status) => status.legacyAliases.includes(key));
  return alias ? { status: alias, key: alias.key, matchedBy: "legacyAlias" } : null;
}

export function requireEnabledPersonaPlanStatus(
  workflow: PersonaPlanWorkflow,
  value: unknown
): PersonaPlanWorkflowStatus {
  const resolved = resolvePersonaPlanStatus(workflow, value, { includeLegacyAliases: false });
  if (!resolved) throw new Error(`Unsupported plan status key: ${String(value)}.`);
  if (resolved.status.state !== "enabled") {
    throw new Error(`Plan status key is not enabled: ${resolved.key}.`);
  }
  return resolved.status;
}

export function planStatusDefinition(
  workflow: PersonaPlanWorkflow,
  key: unknown,
  options: { allowRetired?: boolean; allowLegacyAliases?: boolean } = {}
): PersonaPlanStatusDefinition | null {
  const resolved = resolvePersonaPlanStatus(workflow, key, {
    includeLegacyAliases: options.allowLegacyAliases === true
  });
  if (!resolved) return null;
  if (resolved.status.state !== "enabled" && options.allowRetired !== true) return null;
  return resolved.status;
}

export function assertWritablePlanStatus(
  workflow: PersonaPlanWorkflow,
  key: unknown
): PersonaPlanStatusDefinition {
  return requireEnabledPersonaPlanStatus(workflow, key);
}

export function resolvePersonaPlanWorkflowRole(
  workflow: PersonaPlanWorkflow,
  role: PersonaPlanWorkflowRole
): PersonaPlanWorkflowStatus {
  const validated = validatePersonaPlanWorkflow(workflow);
  if (!WORKFLOW_ROLES.includes(role)) throw new Error(`Unsupported plan workflow role: ${String(role)}.`);
  return requireEnabledPersonaPlanStatus(validated, validated.roles[role]);
}

export function planStatusKeyForRole(
  workflow: PersonaPlanWorkflow,
  role: PersonaPlanWorkflowRole
): string {
  return resolvePersonaPlanWorkflowRole(workflow, role).key;
}

export function addPersonaPlanStatusDefinition(
  workflow: PersonaPlanWorkflow,
  definition: PersonaPlanStatusDefinition
): PersonaPlanWorkflow {
  const current = validatePersonaPlanWorkflow(workflow);
  if (current.statuses.some((status) => status.key === definition.key)) {
    throw new Error(`Plan status key already exists: ${definition.key}.`);
  }
  return validatePersonaPlanWorkflow({
    ...current,
    statuses: [...current.statuses, definition]
  });
}

export function updatePersonaPlanStatusDefinition(
  workflow: PersonaPlanWorkflow,
  key: string,
  patch: Partial<PersonaPlanStatusDefinition>
): PersonaPlanWorkflow {
  const current = validatePersonaPlanWorkflow(workflow);
  const index = current.statuses.findIndex((status) => status.key === key);
  if (index < 0) throw new Error(`Plan status key does not exist: ${key}.`);
  if (patch.key !== undefined && patch.key !== key) {
    throw new Error("Plan status keys are immutable; add a replacement status and retire the old key.");
  }
  const statuses = current.statuses.map((status, statusIndex) => statusIndex === index
    ? { ...status, ...patch, key }
    : status);
  return validatePersonaPlanWorkflow({ ...current, statuses });
}

export function beginPersonaPlanStatusRetirement(
  workflow: PersonaPlanWorkflow,
  key: string,
  replacementKey: string
): PersonaPlanWorkflow {
  const current = validatePersonaPlanWorkflow(workflow);
  if (key === replacementKey) throw new Error("A retiring plan status requires a different replacement key.");
  const source = current.statuses.find((status) => status.key === key);
  if (!source) throw new Error(`Plan status key does not exist: ${key}.`);
  if (source.state !== "enabled") throw new Error(`Plan status key is not enabled: ${key}.`);
  requireEnabledPersonaPlanStatus(current, replacementKey);
  const roles = { ...current.roles };
  for (const role of WORKFLOW_ROLES) {
    if (roles[role] === key) roles[role] = replacementKey;
  }
  const statuses = current.statuses.map((status) => status.key === key
    ? { ...status, state: "retiring" as const }
    : status);
  return validatePersonaPlanWorkflow({ ...current, statuses, roles });
}

export function completePersonaPlanStatusRetirement(
  workflow: PersonaPlanWorkflow,
  key: string
): PersonaPlanWorkflow {
  const current = validatePersonaPlanWorkflow(workflow);
  const source = current.statuses.find((status) => status.key === key);
  if (!source) throw new Error(`Plan status key does not exist: ${key}.`);
  if (source.state !== "retiring") throw new Error(`Plan status key is not retiring: ${key}.`);
  return updatePersonaPlanStatusDefinition(current, key, { state: "retired" });
}

function personaConfigPath(roleDir: string): string {
  return path.join(roleDir, "personaConfig.json");
}

function readPersonaConfig(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("personaConfig.json must contain a JSON object.");
    return value;
  } catch (error) {
    throw new Error(`Cannot read persona plan workflow from malformed personaConfig.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function mergePersonaPlanWorkflowConfig(
  personaConfig: unknown,
  workflow: PersonaPlanWorkflow
): Record<string, unknown> {
  if (personaConfig != null && !isRecord(personaConfig)) {
    throw new Error("personaConfig.json must contain a JSON object.");
  }
  return { ...(personaConfig ?? {}), planWorkflow: validatePersonaPlanWorkflow(workflow) };
}

export function readPersonaPlanWorkflow(roleDir: string): PersonaPlanWorkflowReadResult | null {
  const config = readPersonaConfig(personaConfigPath(roleDir));
  if (!config || config.planWorkflow == null) return null;
  const workflow = validatePersonaPlanWorkflow(config.planWorkflow);
  return { workflow, revision: personaPlanWorkflowRevision(workflow), materialized: true };
}

export function writePersonaPlanWorkflow(
  roleDir: string,
  workflow: PersonaPlanWorkflow,
  expectedRevisionOrOptions: string | { expectedRevision?: string } = {}
): PersonaPlanWorkflowReadResult {
  if (!fs.existsSync(roleDir) || !fs.statSync(roleDir).isDirectory()) {
    throw new Error(`Persona directory does not exist: ${roleDir}`);
  }
  const validated = validatePersonaPlanWorkflow(workflow);
  const expectedRevision = typeof expectedRevisionOrOptions === "string"
    ? expectedRevisionOrOptions
    : expectedRevisionOrOptions.expectedRevision;
  const configPath = personaConfigPath(roleDir);
  const lockPath = path.join(roleDir, ".personaConfig.planWorkflow.lock");
  return withFileLockSync(lockPath, () => {
    const current = readPersonaConfig(configPath);
    const currentWorkflow = current?.planWorkflow == null ? null : validatePersonaPlanWorkflow(current.planWorkflow);
    const currentRevision = currentWorkflow ? personaPlanWorkflowRevision(currentWorkflow) : "";
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new Error(`PERSONA_PLAN_WORKFLOW_REVISION_CONFLICT: expected=${expectedRevision}; current=${currentRevision}.`);
    }
    const next = mergePersonaPlanWorkflowConfig(current, validated);
    atomicWriteFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return {
      workflow: validated,
      revision: personaPlanWorkflowRevision(validated),
      materialized: true
    };
  });
}

export function ensurePersonaPlanWorkflow(roleDir: string): PersonaPlanWorkflowReadResult {
  const existing = readPersonaPlanWorkflow(roleDir);
  if (existing) {
    const rawSchemaVersion = readPersonaConfig(personaConfigPath(roleDir))?.planWorkflow;
    if (isRecord(rawSchemaVersion) && rawSchemaVersion.schemaVersion === 4) return existing;
    return writePersonaPlanWorkflow(roleDir, existing.workflow, { expectedRevision: existing.revision });
  }
  return writePersonaPlanWorkflow(roleDir, loadDefaultPersonaPlanWorkflow(), "");
}
