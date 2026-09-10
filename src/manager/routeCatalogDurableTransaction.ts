import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { adapterConfigPath, personaConfigPath, roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import { sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
import { canonicalRouteCatalogDigest } from "./routeCatalogIdentity.js";
import type {
  RouteCatalogSnapshot,
  RouteCatalogTransactionInput,
  RouteCatalogTransactionOperation
} from "./routeCatalogTransaction.js";

const JOURNAL_VERSION = 1 as const;
const JOURNAL_DIRECTORY = ".rabiroute-route-catalog";

type FileBackup = Readonly<{
  target: string;
  existed: boolean;
  contentBase64?: string;
}>;

type DirectoryBackup = Readonly<{
  target: string;
  existed: boolean;
}>;

type PendingJournal = Readonly<{
  version: typeof JOURNAL_VERSION;
  state: "applying";
  operationId: string;
  operationDigest: string;
  routeRoot: string;
  rolesRoot: string;
  fullRouteConfigSet: boolean;
  fullPersonaConfigSet: boolean;
  files: readonly FileBackup[];
  directories: readonly DirectoryBackup[];
}>;

type CommittedReceipt = Readonly<{
  version: typeof JOURNAL_VERSION;
  state: "committed";
  operationId: string;
  operationDigest: string;
  routeConfigHash: string;
  committedAt: string;
}>;

export class RouteCatalogIdempotencyConflictError extends Error {
  readonly code = "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("Route catalog operationId is already committed for a different mutation.");
    this.name = "RouteCatalogIdempotencyConflictError";
  }
}

function journalRoot(routeRoot: string): string {
  return path.join(path.resolve(routeRoot), JOURNAL_DIRECTORY);
}

function pendingDirectory(routeRoot: string): string {
  return path.join(journalRoot(routeRoot), "pending");
}

function receiptDirectory(routeRoot: string): string {
  return path.join(journalRoot(routeRoot), "receipts");
}

function journalName(operationId: string): string {
  return `${canonicalRouteCatalogDigest(operationId)}.json`;
}

function pendingPath(routeRoot: string, operationId: string): string {
  return path.join(pendingDirectory(routeRoot), journalName(operationId));
}

function receiptPath(routeRoot: string, operationId: string): string {
  return path.join(receiptDirectory(routeRoot), journalName(operationId));
}

function resolvedWithin(rootValue: string, targetValue: string): string {
  const root = path.resolve(rootValue);
  const target = path.resolve(targetValue);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Route catalog transaction journal contains a target outside its storage root.");
  }
  return target;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function existingImmediateDirectories(rootValue: string): string[] {
  const root = path.resolve(rootValue);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== JOURNAL_DIRECTORY)
    .map(entry => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function existingRouteConfigFiles(routeRoot: string): string[] {
  const result: string[] = [];
  for (const directory of existingImmediateDirectories(routeRoot)) {
    const configName = sanitizeConfigName(path.basename(directory));
    if (!configName) continue;
    const target = adapterConfigPath(routeRoot, configName);
    if (fs.existsSync(target)) result.push(target);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function existingPersonaConfigFiles(rolesRoot: string): string[] {
  const result: string[] = [];
  for (const directory of existingImmediateDirectories(rolesRoot)) {
    const roleId = sanitizeRoleId(path.basename(directory));
    if (!roleId) continue;
    const target = personaConfigPath(rolesRoot, roleId);
    if (fs.existsSync(target)) result.push(target);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function backupFile(targetValue: string): FileBackup {
  const target = path.resolve(targetValue);
  try {
    return Object.freeze({
      target,
      existed: true,
      contentBase64: fs.readFileSync(target).toString("base64")
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Object.freeze({ target, existed: false });
  }
}

function directoryChainWithin(rootValue: string, targetValue: string): string[] {
  const root = path.resolve(rootValue);
  let current = resolvedWithin(root, targetValue);
  const result: string[] = [];
  while (current !== root) {
    result.push(current);
    current = path.dirname(current);
  }
  return result;
}

function operationSpecificTargets(input: RouteCatalogTransactionInput): string[] {
  const operation = input.operation;
  if (operation.kind === "ensure_persona") {
    const roleId = sanitizeRoleId(operation.roleId);
    return roleId ? [personaConfigPath(input.rolesRoot, roleId)] : [];
  }
  if (operation.kind === "ensure_role_file") {
    const roleId = sanitizeRoleId(operation.roleId);
    return roleId ? [roleFilePath(input.rolesRoot, roleId, operation.roleFile)] : [];
  }
  return [];
}

function operationSpecificDirectories(input: RouteCatalogTransactionInput): string[] {
  const operation = input.operation;
  if (operation.kind === "ensure_persona") {
    const roleId = sanitizeRoleId(operation.roleId);
    return roleId ? directoryChainWithin(input.rolesRoot, roleFolderPath(input.rolesRoot, roleId)) : [];
  }
  if (operation.kind === "ensure_role_file") {
    const roleId = sanitizeRoleId(operation.roleId);
    if (!roleId) return [];
    const target = roleFilePath(input.rolesRoot, roleId, operation.roleFile);
    return directoryChainWithin(input.rolesRoot, path.dirname(target));
  }
  if (operation.kind === "ensure_role_folder") {
    const roleId = sanitizeRoleId(operation.roleId);
    return roleId ? directoryChainWithin(input.rolesRoot, roleFolderPath(input.rolesRoot, roleId)) : [];
  }
  return [];
}

function capturePendingJournal(input: RouteCatalogTransactionInput, operationDigest: string): PendingJournal {
  const fullConfigSet = ["replace", "upsert", "remove"].includes(input.operation.kind);
  const targets = new Set<string>(operationSpecificTargets(input).map(target => path.resolve(target)));
  if (fullConfigSet) {
    for (const target of existingRouteConfigFiles(input.routeRoot)) targets.add(path.resolve(target));
    for (const target of existingPersonaConfigFiles(input.rolesRoot)) targets.add(path.resolve(target));
  }
  const directoryTargets = new Set<string>([
    ...existingImmediateDirectories(input.routeRoot),
    ...existingImmediateDirectories(input.rolesRoot),
    ...operationSpecificDirectories(input)
  ].map(target => path.resolve(target)));
  const directories = [...directoryTargets]
    .sort((left, right) => left.localeCompare(right))
    .map(target => Object.freeze({ target, existed: fs.existsSync(target) }));
  return Object.freeze({
    version: JOURNAL_VERSION,
    state: "applying",
    operationId: input.operationId,
    operationDigest,
    routeRoot: path.resolve(input.routeRoot),
    rolesRoot: path.resolve(input.rolesRoot),
    fullRouteConfigSet: fullConfigSet,
    fullPersonaConfigSet: fullConfigSet,
    files: Object.freeze([...targets].sort((a, b) => a.localeCompare(b)).map(backupFile)),
    directories: Object.freeze(directories)
  });
}

function validatePendingJournal(
  journal: PendingJournal,
  roots: Pick<RouteCatalogTransactionInput, "routeRoot" | "rolesRoot">
): void {
  if (journal?.version !== JOURNAL_VERSION || journal.state !== "applying"
    || typeof journal.operationId !== "string" || !journal.operationId
    || !/^[a-f0-9]{64}$/.test(String(journal.operationDigest || ""))
    || path.resolve(journal.routeRoot) !== path.resolve(roots.routeRoot)
    || path.resolve(journal.rolesRoot) !== path.resolve(roots.rolesRoot)
    || !Array.isArray(journal.files) || !Array.isArray(journal.directories)) {
    throw new Error("Route catalog transaction journal is invalid.");
  }
  for (const file of journal.files) {
    if (!file || typeof file.target !== "string" || typeof file.existed !== "boolean") {
      throw new Error("Route catalog transaction file backup is invalid.");
    }
    const target = path.resolve(file.target);
    const inRouteRoot = (() => { try { resolvedWithin(roots.routeRoot, target); return true; } catch { return false; } })();
    const inRolesRoot = (() => { try { resolvedWithin(roots.rolesRoot, target); return true; } catch { return false; } })();
    if (!inRouteRoot && !inRolesRoot) throw new Error("Route catalog transaction file backup escaped its roots.");
    if (file.existed && typeof file.contentBase64 !== "string") {
      throw new Error("Route catalog transaction file backup is incomplete.");
    }
    if (file.existed && Buffer.from(file.contentBase64!, "base64").toString("base64") !== file.contentBase64) {
      throw new Error("Route catalog transaction file backup encoding is invalid.");
    }
  }
  for (const directory of journal.directories) {
    if (!directory || typeof directory.target !== "string" || typeof directory.existed !== "boolean") {
      throw new Error("Route catalog transaction directory backup is invalid.");
    }
    const target = path.resolve(directory.target);
    try { resolvedWithin(roots.routeRoot, target); } catch { resolvedWithin(roots.rolesRoot, target); }
  }
}

function removeIfExists(target: string): void {
  try { fs.unlinkSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function restorePendingJournal(journal: PendingJournal): void {
  const backupByTarget = new Map(journal.files.map(item => [path.resolve(item.target), item]));
  const managedNow = [
    ...(journal.fullRouteConfigSet ? existingRouteConfigFiles(journal.routeRoot) : []),
    ...(journal.fullPersonaConfigSet ? existingPersonaConfigFiles(journal.rolesRoot) : [])
  ];
  for (const target of managedNow) {
    if (!backupByTarget.has(path.resolve(target))) removeIfExists(target);
  }
  for (const backup of journal.files) {
    if (!backup.existed) {
      removeIfExists(backup.target);
      continue;
    }
    atomicWriteFileSync(backup.target, Buffer.from(backup.contentBase64!, "base64"));
  }
  const existingBefore = new Set(journal.directories.filter(item => item.existed).map(item => path.resolve(item.target)));
  const directoriesNow = new Set([
    ...journal.directories.filter(item => !item.existed).map(item => path.resolve(item.target)),
    ...existingImmediateDirectories(journal.routeRoot),
    ...existingImmediateDirectories(journal.rolesRoot)
  ]);
  for (const directory of [...directoriesNow].sort((left, right) =>
    right.length - left.length || right.localeCompare(left)
  )) {
    if (existingBefore.has(path.resolve(directory))) continue;
    try { fs.rmdirSync(directory); } catch (error) {
      if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(String((error as NodeJS.ErrnoException).code || ""))) {
        throw error;
      }
    }
  }
}

export function readCommittedReceipt(
  input: Pick<RouteCatalogTransactionInput, "routeRoot" | "operationId">
): CommittedReceipt | undefined {
  const target = receiptPath(input.routeRoot, input.operationId);
  if (!fs.existsSync(target)) return undefined;
  const receipt = readJson<CommittedReceipt>(target);
  if (receipt?.version !== JOURNAL_VERSION || receipt.state !== "committed"
    || receipt.operationId !== input.operationId
    || !/^[a-f0-9]{64}$/.test(String(receipt.operationDigest || ""))
    || !/^[a-f0-9]{64}$/.test(String(receipt.routeConfigHash || ""))) {
    throw new Error("Route catalog committed receipt is invalid.");
  }
  return receipt;
}

export function recoverRouteCatalogTransactions(
  roots: Pick<RouteCatalogTransactionInput, "routeRoot" | "rolesRoot">
): void {
  const directory = pendingDirectory(roots.routeRoot);
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const journal = readJson<PendingJournal>(target);
    validatePendingJournal(journal, roots);
    if (entry.name !== journalName(journal.operationId)) {
      throw new Error("Route catalog transaction journal filename does not match its operationId.");
    }
    const receipt = readCommittedReceipt({ routeRoot: roots.routeRoot, operationId: journal.operationId });
    if (!receipt || receipt.operationDigest !== journal.operationDigest) restorePendingJournal(journal);
    removeIfExists(target);
  }
}

function operationForDigest(operation: RouteCatalogTransactionOperation): unknown {
  switch (operation.kind) {
    case "replace":
      return { kind: operation.kind, config: operation.config };
    case "upsert":
      return { kind: operation.kind, definition: operation.definition, ...(operation.previousId ? { previousId: operation.previousId } : {}) };
    case "remove":
      return { kind: operation.kind, routeId: operation.routeId };
    case "ensure_persona":
      return { kind: operation.kind, roleId: operation.roleId };
    case "ensure_role_file":
      return { kind: operation.kind, roleId: operation.roleId, roleFile: operation.roleFile };
    case "ensure_role_folder":
      return { kind: operation.kind, roleId: operation.roleId };
    case "capture":
      return { kind: operation.kind };
  }
}

export function routeCatalogOperationDigest(input: RouteCatalogTransactionInput): string {
  return canonicalRouteCatalogDigest({
    routeRoot: path.resolve(input.routeRoot),
    rolesRoot: path.resolve(input.rolesRoot),
    operation: operationForDigest(input.operation)
  });
}

export function executeDurableRouteCatalogMutation(
  input: RouteCatalogTransactionInput,
  hooks: Readonly<{
    capture(): RouteCatalogSnapshot;
    prepare(current: RouteCatalogSnapshot): void;
    mutate(current: RouteCatalogSnapshot): void;
  }>
): RouteCatalogSnapshot {
  const operationDigest = routeCatalogOperationDigest(input);
  const receipt = readCommittedReceipt(input);
  if (receipt) {
    if (receipt.operationDigest !== operationDigest) throw new RouteCatalogIdempotencyConflictError();
    return hooks.capture();
  }
  const current = hooks.capture();
  hooks.prepare(current);
  const pending = capturePendingJournal(input, operationDigest);
  const pendingFile = pendingPath(input.routeRoot, input.operationId);
  writeJson(pendingFile, pending);
  let committed = false;
  try {
    hooks.mutate(current);
    const snapshot = hooks.capture();
    writeJson(receiptPath(input.routeRoot, input.operationId), Object.freeze({
      version: JOURNAL_VERSION,
      state: "committed",
      operationId: input.operationId,
      operationDigest,
      routeConfigHash: snapshot.routeConfigHash,
      committedAt: new Date().toISOString()
    }) satisfies CommittedReceipt);
    committed = true;
    removeIfExists(pendingFile);
    return snapshot;
  } catch (error) {
    if (!committed) {
      restorePendingJournal(pending);
      removeIfExists(pendingFile);
    }
    throw error;
  }
}
