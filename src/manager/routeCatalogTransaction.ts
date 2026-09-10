import fs from "node:fs";
import path from "node:path";
import type { GatewayConfigFile, GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { readPersonaAvatar } from "../personaAvatar.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { routeRuntimeParts, sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
import { normalizePersonaFile, roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import { ManagerConfigRepository, migrateLegacyCopilotThreadName } from "./configRepository.js";
import {
  executeDurableRouteCatalogMutation,
  recoverRouteCatalogTransactions,
  readCommittedReceipt,
  RouteCatalogIdempotencyConflictError
} from "./routeCatalogDurableTransaction.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

export type RouteCatalogTransactionOperation =
  | Readonly<{ kind: "capture"; resolveOperationId?: string }>
  | Readonly<{ kind: "replace"; config: GatewayConfigFile; expectedContentHash?: string }>
  | Readonly<{ kind: "upsert"; definition: GatewayDefinition; expectedContentHash?: string; previousId?: string }>
  | Readonly<{ kind: "remove"; routeId: string; expectedContentHash?: string }>
  | Readonly<{ kind: "ensure_persona"; roleId: string }>
  | Readonly<{ kind: "ensure_role_file"; roleId: string; roleFile: string }>
  | Readonly<{ kind: "ensure_role_folder"; roleId: string }>;

export type RouteCatalogTransactionInput = Readonly<{
  requestId: string;
  attemptToken: string;
  operationId: string;
  rootDir: string;
  routeRoot: string;
  rolesRoot: string;
  managerPort: number;
  readOnly: boolean;
  operation: RouteCatalogTransactionOperation;
}>;

export type RouteCatalogSnapshot = Readonly<{
  resolvedMutation?: { operationId: string; state: "committed" | "not_committed" };
  requestId: string;
  attemptToken: string;
  contentHash: string;
  routeConfigHash: string;
  presentationHash: string;
  routeRoot: string;
  rolesRoot: string;
  gateways: readonly GatewayDefinition[];
  personas: readonly RouteCatalogPersonaPresentation[];
}>;

export type RouteCatalogPersonaPresentation = Readonly<{
  rolesRoot: string;
  roleId: string;
  isPersona: boolean;
  displayName: string;
  avatarConfigured: boolean;
  avatarVersion?: string;
  files: readonly RouteCatalogPersonaFilePresentation[];
  speech: RouteCatalogPersonaSpeechPresentation;
}>;

export type RouteCatalogPersonaFilePresentation = Readonly<{
  fileName: string;
  exists: boolean;
  title: string;
  content: string;
  contentTruncated: boolean;
  errorCode?: "PERSONA_FILE_UNAVAILABLE";
}>;

export type RouteCatalogPersonaSpeechPresentation = Readonly<{
  voiceReady: boolean;
  defaultModel?: string;
  language?: string;
  instructions?: string;
  speed?: number;
  voiceStyleSummary?: string;
}>;

export type RouteCatalogChildResult =
  | Readonly<{ ok: true; snapshot: RouteCatalogSnapshot }>
  | Readonly<{
    ok: false;
    errorCode: "revision_conflict" | "idempotency_conflict" | "transaction_failed";
    error: string;
  }>;

export class RouteCatalogRevisionConflictError extends Error {
  readonly code = "ROUTE_CATALOG_REVISION_CONFLICT";

  constructor() {
    super("Route catalog changed before this transaction could commit.");
    this.name = "RouteCatalogRevisionConflictError";
  }
}

function routeConfigName(definition: Pick<GatewayDefinition, "id" | "configName">): string {
  return sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName;
}

function readOnlyConfig(repository: ManagerConfigRepository): GatewayConfigFile {
  if (!fs.existsSync(repository.routeRoot)) return { gateways: [] };
  const gateways: GatewayDefinition[] = [];
  for (const routeEntry of fs.readdirSync(repository.routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
    const configName = sanitizeConfigName(routeEntry.name);
    const configPath = repository.adapterConfigPath(configName);
    if (!fs.existsSync(configPath)) continue;
    const raw = migrateLegacyCopilotThreadName(
      JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>
    );
    const personaConfig = repository.readRoleMessageConfig(raw.agentRoleId);
    gateways.push(repository.normalize({
      ...raw,
      ...personaConfig,
      id: configName,
      configName,
      agentRoleId: raw.agentRoleId,
      rolesDir: raw.rolesDir,
      agentRoleFile: raw.agentRoleFile
    } as GatewayDefinition));
  }
  return { gateways };
}

function safePersonaDisplayName(value: string, fallback: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return compact.replace(/(?:\s*[-—–:：]\s*)?(?:人格提示词|人格)$/u, "").trim().slice(0, 80) || fallback;
}

function resolveRolesRoot(rootDir: string, value: unknown, fallback: string): string {
  const configured = String(value || "").trim();
  if (!configured) return path.resolve(fallback);
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(rootDir, configured);
}

const PERSONA_CONTENT_MAX_BYTES = 1024 * 1024;

function personaMarkdownTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim().replace(/^\uFEFF/, "");
    if (text.startsWith("# ")) return text.slice(2).trim();
    if (text) return "";
  }
  return "";
}

function readPersonaFilePresentation(
  rolesRoot: string,
  roleId: string,
  roleFile: string
): RouteCatalogPersonaFilePresentation {
  const fileName = normalizePersonaFile(roleFile);
  const target = roleFilePath(rolesRoot, roleId, fileName);
  let handle: number | undefined;
  try {
    handle = fs.openSync(target, "r");
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error("not a file");
    const byteLimit = Math.min(stat.size, PERSONA_CONTENT_MAX_BYTES);
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = byteLimit > 0 ? fs.readSync(handle, buffer, 0, byteLimit, 0) : 0;
    const content = buffer.toString("utf8", 0, bytesRead);
    return Object.freeze({
      fileName,
      exists: true,
      title: personaMarkdownTitle(content),
      content,
      contentTruncated: stat.size > PERSONA_CONTENT_MAX_BYTES
    });
  } catch {
    return Object.freeze({
      fileName,
      exists: false,
      title: "",
      content: "",
      contentTruncated: false,
      errorCode: "PERSONA_FILE_UNAVAILABLE"
    });
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* child process owns this bounded read */ }
    }
  }
}

function optionalString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function personaSpeechPresentation(roleDir: string): RouteCatalogPersonaSpeechPresentation {
  const voiceRoot = path.join(roleDir, "voice");
  const profilePath = path.join(voiceRoot, "voice-profile.json");
  let profile: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      profile = parsed as Record<string, unknown>;
    }
  } catch { /* missing or malformed private voice metadata remains unavailable */ }
  const speed = Number(profile.speed);
  return Object.freeze({
    voiceReady: fs.existsSync(profilePath) || fs.existsSync(path.join(voiceRoot, "voice-index.json")),
    ...(optionalString(profile.default_model ?? profile.defaultModel) ? {
      defaultModel: optionalString(profile.default_model ?? profile.defaultModel)
    } : {}),
    ...(optionalString(profile.language) ? { language: optionalString(profile.language) } : {}),
    ...(optionalString(profile.instructions) ? { instructions: optionalString(profile.instructions) } : {}),
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(optionalString(profile.voice_style_summary ?? profile.voiceStyleSummary) ? {
      voiceStyleSummary: optionalString(profile.voice_style_summary ?? profile.voiceStyleSummary)
    } : {})
  });
}

function personaPresentation(
  rolesRoot: string,
  roleId: string,
  isPersona: boolean,
  roleFiles: Iterable<string>
): RouteCatalogPersonaPresentation {
  const roleDir = roleFolderPath(rolesRoot, roleId);
  const files = Object.freeze([...new Set([...roleFiles].map(file => normalizePersonaFile(file)))]
    .sort((a, b) => a.localeCompare(b))
    .map(file => readPersonaFilePresentation(rolesRoot, roleId, file)));
  const personaFile = files.find(file => file.fileName.toLowerCase() === "persona.md");
  let displayName = roleId === "YeYu" ? "夜雨" : roleId;
  if (isPersona && personaFile?.title) displayName = safePersonaDisplayName(personaFile.title, roleId);
  const avatar = isPersona ? readPersonaAvatar(roleDir) : { configured: false };
  return Object.freeze({
    rolesRoot: path.resolve(rolesRoot),
    roleId,
    isPersona,
    displayName,
    avatarConfigured: avatar.configured,
    ...(avatar.version ? { avatarVersion: avatar.version } : {}),
    files,
    speech: personaSpeechPresentation(roleDir)
  });
}

function capturePersonaPresentations(
  rootDir: string,
  repository: ManagerConfigRepository,
  gateways: readonly GatewayDefinition[]
): readonly RouteCatalogPersonaPresentation[] {
  const roots = new Set<string>([path.resolve(repository.rolesRoot)]);
  for (const definition of gateways) {
    roots.add(resolveRolesRoot(rootDir, definition.rolesDir, repository.rolesRoot));
  }
  const personas = new Map<string, {
    rolesRoot: string;
    roleId: string;
    isPersona: boolean;
    roleFiles: Set<string>;
  }>();
  const key = (rolesRoot: string, roleId: string): string =>
    `${path.resolve(rolesRoot).replace(/\\/g, "/").toLowerCase()}\0${roleId.toLowerCase()}`;
  const put = (rolesRoot: string, roleId: string, isPersona: boolean, roleFile = "persona.md"): void => {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return;
    const itemKey = key(rolesRoot, safeRoleId);
    const current = personas.get(itemKey) ?? {
      rolesRoot: path.resolve(rolesRoot),
      roleId: safeRoleId,
      isPersona: false,
      roleFiles: new Set<string>()
    };
    current.isPersona ||= isPersona;
    current.roleFiles.add(normalizePersonaFile(roleFile));
    personas.set(itemKey, current);
  };

  for (const rolesRoot of [...roots].sort((a, b) => a.localeCompare(b))) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rolesRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const roleId = sanitizeRoleId(entry.name);
      if (!roleId) continue;
      let isPersona = false;
      try {
        isPersona = fs.statSync(path.join(roleFolderPath(rolesRoot, roleId), "persona.md")).isFile();
      } catch { /* Lifecycle folders and incomplete roles are not persona profiles. */ }
      if (isPersona) put(rolesRoot, roleId, true, "persona.md");
    }
  }
  for (const definition of gateways) {
    const roleId = sanitizeRoleId(definition.agentRoleId);
    if (!roleId) continue;
    const rolesRoot = resolveRolesRoot(rootDir, definition.rolesDir, repository.rolesRoot);
    const personaPath = path.join(roleFolderPath(rolesRoot, roleId), "persona.md");
    let isPersona = false;
    try { isPersona = fs.statSync(personaPath).isFile(); } catch { /* fallback presentation */ }
    put(rolesRoot, roleId, isPersona, definition.agentRoleFile ?? "persona.md");
  }
  return Object.freeze([...personas.values()].map(item => personaPresentation(
    item.rolesRoot,
    item.roleId,
    item.isPersona,
    item.roleFiles
  )).sort((a, b) =>
    a.rolesRoot.localeCompare(b.rolesRoot) || a.roleId.localeCompare(b.roleId)
  ));
}

function capture(
  repository: ManagerConfigRepository,
  readOnly: boolean,
  identity: Pick<RouteCatalogTransactionInput, "requestId" | "attemptToken" | "rootDir">
): RouteCatalogSnapshot {
  const config = readOnly ? readOnlyConfig(repository) : repository.readConfig();
  const gateways = Object.freeze([...config.gateways].sort((left, right) =>
    routeConfigName(left).localeCompare(routeConfigName(right)) || left.id.localeCompare(right.id)
  ));
  const personas = capturePersonaPresentations(identity.rootDir, repository, gateways);
  const routeConfigContent = {
    routeRoot: repository.routeRoot,
    rolesRoot: repository.rolesRoot,
    gateways
  };
  const { routeConfigHash, presentationHash, contentHash } = routeCatalogSnapshotIdentities({
    ...routeConfigContent,
    personas
  });
  return Object.freeze({
    requestId: identity.requestId,
    attemptToken: identity.attemptToken,
    contentHash,
    routeConfigHash,
    presentationHash,
    routeRoot: routeConfigContent.routeRoot,
    rolesRoot: routeConfigContent.rolesRoot,
    gateways: Object.freeze(routeConfigContent.gateways.map(definition => Object.freeze({ ...definition }))),
    personas: Object.freeze(personas.map(persona => Object.freeze({ ...persona })))
  });
}

function requireWritable(input: RouteCatalogTransactionInput): void {
  if (input.readOnly) throw new Error(`Route catalog ${input.operation.kind} is unavailable in read-only mode.`);
}

function assertExpectedContentHash(
  operation: Exclude<RouteCatalogTransactionOperation, Readonly<{ kind: "capture" }>>,
  snapshot: RouteCatalogSnapshot
): void {
  const expected = "expectedContentHash" in operation
    ? String(operation.expectedContentHash || "").trim()
    : "";
  if (expected && expected !== snapshot.routeConfigHash) {
    throw new RouteCatalogRevisionConflictError();
  }
}

/**
 * Runs only in the one-shot route catalog child. It may block on remote storage;
 * the Manager parent owns the deadline and can terminate the entire process.
 */
export function executeRouteCatalogTransaction(input: RouteCatalogTransactionInput): RouteCatalogSnapshot {
  const repository = new ManagerConfigRepository({
    rootDir: input.rootDir,
    managerPort: input.managerPort,
    routeRoot: input.routeRoot,
    rolesRoot: input.rolesRoot
  });
  recoverRouteCatalogTransactions(input);
  const operation = input.operation;
  switch (operation.kind) {
    case "capture":
      return {
        ...capture(repository, input.readOnly, input),
        ...(operation.resolveOperationId ? {
          resolvedMutation: {
            operationId: operation.resolveOperationId,
            state: readCommittedReceipt({ routeRoot: input.routeRoot, operationId: operation.resolveOperationId }) ? "committed" as const : "not_committed" as const
          }
        } : {})
      };
    case "replace":
      requireWritable(input);
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare: current => assertExpectedContentHash(operation, current),
        mutate: () => { repository.writeConfig(operation.config); }
      });
    case "upsert": {
      requireWritable(input);
      const targetName = routeConfigName(operation.definition);
      if (!targetName) throw new Error("Route catalog upsert requires a valid config name.");
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare: current => {
          assertExpectedContentHash(operation, current);
          if (operation.previousId && current.gateways.some(definition =>
            routeConfigName(definition) === targetName && definition.id !== operation.previousId
          )) throw new Error("A different Route already uses this config name.");
        },
        mutate: currentSnapshot => {
          let replaced = false;
          const gateways = currentSnapshot.gateways.map(definition => {
            if (operation.previousId
              ? definition.id !== operation.previousId
              : routeConfigName(definition) !== targetName && definition.id !== operation.definition.id) {
              return definition;
            }
            replaced = true;
            return operation.definition;
          });
          repository.writeConfig({
            gateways: replaced ? gateways : [...gateways, operation.definition]
          }, operation.previousId ? { configName: targetName, previousId: operation.previousId } : undefined);
        }
      });
    }
    case "remove": {
      requireWritable(input);
      const routeId = String(operation.routeId || "").trim();
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare: current => {
          assertExpectedContentHash(operation, current);
          if (!current.gateways.some(definition =>
            definition.id === routeId || routeConfigName(definition) === routeId
          )) throw new Error(`Gateway config not found: ${routeId}`);
        },
        mutate: current => {
          repository.writeConfig({
            gateways: current.gateways.filter(definition =>
              definition.id !== routeId && routeConfigName(definition) !== routeId
            )
          });
        }
      });
    }
    case "ensure_persona": {
      requireWritable(input);
      const roleId = sanitizeRoleId(operation.roleId);
      if (!roleId) throw new Error("Route catalog ensure_persona requires a valid role id.");
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare() {},
        mutate: () => {
          const configPath = repository.personaConfigPath(roleId);
          if (!fs.existsSync(configPath)) repository.writePersonaConfig(roleId, { notificationRules: [] });
          ensurePersonaPlanWorkflow(roleFolderPath(repository.rolesRoot, roleId));
        }
      });
    }
    case "ensure_role_file": {
      requireWritable(input);
      const roleId = sanitizeRoleId(operation.roleId);
      if (!roleId) throw new Error("Route catalog ensure_role_file requires a valid role id.");
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare() {},
        mutate: () => {
          const target = roleFilePath(repository.rolesRoot, roleId, operation.roleFile);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (!fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
        }
      });
    }
    case "ensure_role_folder": {
      requireWritable(input);
      const roleId = sanitizeRoleId(operation.roleId);
      if (!roleId) throw new Error("Route catalog ensure_role_folder requires a valid role id.");
      return executeDurableRouteCatalogMutation(input, {
        capture: () => capture(repository, false, input),
        prepare() {},
        mutate: () => { fs.mkdirSync(roleFolderPath(repository.rolesRoot, roleId), { recursive: true }); }
      });
    }
  }
}

export { RouteCatalogIdempotencyConflictError };
