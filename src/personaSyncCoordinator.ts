import { createHash } from "node:crypto";
import { discoverRabiPeers } from "./rabiPeerDiscovery.js";
import fs from "node:fs";
import path from "node:path";
import {
  PERSONA_SYNC_DELETED_HASH,
  type PersonaSyncFile,
  type PersonaSyncConflictResolution,
  type PersonaSyncManifest,
  type PersonaSyncMergeResult,
  type PersonaSyncService
} from "./personaSync.js";
import { personaSyncFileEligible } from "./personaSyncManifestIndex.js";
import {
  listPersonaVoiceIdentities,
  type PersonaVoiceIdentityConflictField
} from "./personaVoiceIdentities.js";
import { listIdentityRelationConflicts } from "./identityRelations.js";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";
import {
  canonicalPlanIdForStorageIdentity,
  personaPlanStoragePath
} from "./personaPlanStorage.js";
import {
  canonicalPlanStorageCollisionIdentity,
  canonicalPlanStorageName,
  planStorageDirectory
} from "./planStorageLayout.js";
import { canonicalLogicalPlanId } from "./planStorageIdentity.js";
import {
  createActivePlanPackageCommand,
  createActivePlanPackageCommandFromFiles,
  createArchivedPlanPackageCommand,
  createArchivedPlanPackageCommandFromFiles,
  PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY,
  type PersonaSyncActivePlanPackageCommand,
  type PersonaSyncArchivedPlanPackageCommand,
  type PersonaSyncPlanPackageFile,
  type PersonaSyncPlanPackageResult
} from "./personaSyncPlanPackage.js";

export type PersonaSyncPeer = {
  id: string;
  guid?: string;
  name: string;
  online: boolean;
  capabilities: string[];
  peerUrls: string[];
};

export type PersonaSyncRelayConfig = {
  url: string;
  token: string;
  deviceId: string;
  deviceGuid: string;
};

export type PersonaSyncResult = {
  peer: PersonaSyncPeer;
  baseUrl: string;
  transport: "lan" | "relay";
  files: Array<PersonaSyncMergeResult & { direction: "pull" | "push" | "converged" }>;
  fileConflicts: number;
  semanticConflicts: PersonaSyncSemanticConflict[];
  conflicts: number;
};

export type PersonaSyncPreviewOperation =
  | "unchanged"
  | "pull_create"
  | "pull_update"
  | "pull_delete"
  | "push_create"
  | "push_update"
  | "push_delete"
  | "auto_merge"
  | "conflict";

export type PersonaSyncPreviewFile = {
  roleId: string;
  path: string;
  operation: PersonaSyncPreviewOperation;
  direction: "pull" | "push" | "merge" | "conflict" | "converged";
  mergeStrategy: PersonaSyncFile["mergeStrategy"];
  localHash?: string;
  remoteHash?: string;
  baseHash?: string;
  localSize?: number;
  remoteSize?: number;
};

export type PersonaSyncPreview = {
  peer: PersonaSyncPeer;
  transport: "lan" | "relay";
  files: PersonaSyncPreviewFile[];
  changedFiles: number;
  conflicts: number;
};

export type PersonaSyncSemanticConflict =
  | {
      kind: "persona_voice_identity";
      roleId: string;
      path: "voice/voice-identities.jsonl";
      identityKey: string;
      sourceHostId: string;
      voiceprintId: string;
      fields: PersonaVoiceIdentityConflictField[];
      candidateEventIds: string[];
    }
  | {
      kind: "identity_relation";
      roleId: string;
      path: "identity-relations/events.jsonl";
      recordKind: "endpoint_account" | "participant" | "relation_card";
      recordId: string;
      candidateEventIds: string[];
    };

export type PersonaSyncResolutionPublishResult = {
  status: "published" | "not_published";
  peerId?: string;
  transport?: "lan" | "relay";
  message?: string;
  merge?: PersonaSyncMergeResult;
};

type SyncState = {
  schemaVersion: 1;
  peerId: string;
  hashes: Record<string, string>;
  updatedAt: string;
  updatedHashKeys: string[];
  removedPlanScopeKeys: string[];
};

export class PersonaSyncStaleManifestError extends Error {
  readonly code = "PERSONA_SYNC_STALE_MANIFEST";

  constructor(
    readonly roleId: string,
    readonly relativePath: string,
    detail?: string,
    readonly manifestRevision?: number
  ) {
    super(detail || `Persona sync manifest became stale while reading ${roleId}/${relativePath}.`);
    this.name = "PersonaSyncStaleManifestError";
  }
}

export class PersonaSyncTransactionIdentityChangedError extends Error {
  readonly code = "PERSONA_SYNC_TRANSACTION_IDENTITY_CHANGED";

  constructor(detail: string) {
    super(`Persona sync transaction identity changed before a safe restart: ${detail}`);
    this.name = "PersonaSyncTransactionIdentityChangedError";
  }
}

const PERSONA_SYNC_PUBLICATION_ADVANCE_TIMEOUT_MS = 1_500;
const PERSONA_SYNC_PUBLICATION_PROBE_INTERVAL_MS = 25;
const PERSONA_SYNC_PUBLICATION_STABLE_PROBES = 4;

function safePeerId(value: string): string {
  return value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "peer";
}

function fileKey(file: Pick<PersonaSyncFile, "roleId" | "path">): string {
  return `${file.roleId}/${file.path}`;
}

function planScopeKey(file: Pick<PersonaSyncFile, "roleId" | "path">): string | null {
  const planPath = personaPlanStoragePath(file.path);
  return planPath ? `${file.roleId}\u0000${canonicalPlanStorageCollisionIdentity(planPath.storageId)}` : null;
}

type PersonaPlanScope = {
  key: string;
  roleId: string;
  local: PersonaSyncFile[];
  remote: PersonaSyncFile[];
};

type PersonaPlanScopeSide = {
  roleId: string;
  bucket: "active" | "archive";
  storageId: string;
  files: PersonaSyncFile[];
  identity: PersonaSyncFile;
};

type PersonaPlanScopeAction =
  | "conflict"
  | "unchanged"
  | "push_active"
  | "pull_active"
  | "push_archive"
  | "pull_archive";

type PersonaPlanScopePlan = {
  scope: PersonaPlanScope;
  local: PersonaPlanScopeSide | null;
  remote: PersonaPlanScopeSide | null;
  action: PersonaPlanScopeAction;
  reason?: "peer_missing_package_capability" | "storage_identity_mismatch" | "diverged_inventory";
};

type CompletedPersonaPlanScope = {
  key: string;
  action: PersonaPlanScopeAction;
  bucket: "active" | "archive";
  storageId: string;
  expectedFiles: PersonaSyncFile[];
};

function collectPlanScopes(
  localFiles: ReadonlyMap<string, PersonaSyncFile>,
  remoteFiles: ReadonlyMap<string, PersonaSyncFile>
): Map<string, PersonaPlanScope> {
  const scopes = new Map<string, PersonaPlanScope>();
  const add = (file: PersonaSyncFile, side: "local" | "remote"): void => {
    const planPath = personaPlanStoragePath(file.path);
    if (!planPath) return;
    const key = `${file.roleId}\u0000${canonicalPlanStorageCollisionIdentity(planPath.storageId)}`;
    const scope = scopes.get(key) ?? {
      key,
      roleId: file.roleId,
      local: [],
      remote: []
    };
    scope[side].push(file);
    scopes.set(key, scope);
  };
  for (const file of localFiles.values()) add(file, "local");
  for (const file of remoteFiles.values()) add(file, "remote");
  for (const scope of scopes.values()) {
    scope.local.sort((a, b) => a.path.localeCompare(b.path));
    scope.remote.sort((a, b) => a.path.localeCompare(b.path));
  }
  return scopes;
}

function sameFileSet(left: PersonaSyncFile[], right: PersonaSyncFile[]): boolean {
  if (left.length !== right.length) return false;
  const remote = new Map(right.map(file => [file.path, file]));
  return left.every(file => {
    const candidate = remote.get(file.path);
    return candidate?.sha256 === file.sha256 && candidate.size === file.size;
  });
}

function describePlanScopeSide(
  scope: PersonaPlanScope,
  files: PersonaSyncFile[],
  side: string
): PersonaPlanScopeSide | null {
  if (files.length === 0) return null;
  let bucket: "active" | "archive" | undefined;
  let storageId: string | undefined;
  let identity: PersonaSyncFile | undefined;
  for (const file of files) {
    const planPath = personaPlanStoragePath(file.path);
    if (!planPath || file.roleId !== scope.roleId) {
      throw new Error(`Persona sync ${side} plan scope is malformed: ${scope.key}`);
    }
    if (bucket && bucket !== planPath.bucket) {
      throw new Error(`Persona sync ${side} plan scope crosses active and archive buckets: ${scope.key}`);
    }
    if (storageId && storageId !== planPath.storageId) {
      throw new Error(`Persona sync ${side} plan scope aliases more than one physical storage id: ${scope.key}`);
    }
    bucket = planPath.bucket;
    storageId = planPath.storageId;
    const normalizedPath = file.path.replace(/\\/g, "/");
    const prefix = `plans/${planPath.bucket}/${planPath.storageId}/`;
    if (!normalizedPath.startsWith(prefix) || !personaSyncFileEligible(normalizedPath, file.size)) {
      throw new Error(`Persona sync ${side} plan package contains a non-manifest-eligible member: ${file.roleId}/${file.path}`);
    }
    if (normalizedPath === `${prefix}plan.json`) {
      if (identity) throw new Error(`Persona sync ${side} plan scope has more than one identity: ${scope.key}`);
      identity = file;
    }
  }
  if (!bucket || !storageId || !identity) {
    throw new Error(`Persona sync ${side} plan scope has no exact plan.json identity: ${scope.key}`);
  }
  if (!files.some(file => file.path.replace(/\\/g, "/") === `plans/${bucket}/${storageId}/history.jsonl`)) {
    throw new Error(`Persona sync ${side} plan scope has no exact history.jsonl member: ${scope.key}`);
  }
  return { roleId: scope.roleId, bucket, storageId, files, identity };
}

function planPersonaPlanScopes(
  localFiles: ReadonlyMap<string, PersonaSyncFile>,
  remoteFiles: ReadonlyMap<string, PersonaSyncFile>,
  packageCapable: boolean
): PersonaPlanScopePlan[] {
  return [...collectPlanScopes(localFiles, remoteFiles).values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(scope => {
      const local = describePlanScopeSide(scope, scope.local, "local");
      const remote = describePlanScopeSide(scope, scope.remote, "remote");
      if (!packageCapable) {
        return { scope, local, remote, action: "conflict", reason: "peer_missing_package_capability" };
      }
      if (local && remote && local.storageId !== remote.storageId) {
        return { scope, local, remote, action: "conflict", reason: "storage_identity_mismatch" };
      }
      if (local?.bucket === "archive" || remote?.bucket === "archive") {
        if (local?.bucket === "archive" && remote?.bucket === "archive") {
          return sameFileSet(local.files, remote.files)
            ? { scope, local, remote, action: "unchanged" }
            : { scope, local, remote, action: "conflict", reason: "diverged_inventory" };
        }
        return local?.bucket === "archive"
          ? { scope, local, remote, action: "push_archive" }
          : { scope, local, remote, action: "pull_archive" };
      }
      if (local && remote) {
        return sameFileSet(local.files, remote.files)
          ? { scope, local, remote, action: "unchanged" }
          : { scope, local, remote, action: "conflict", reason: "diverged_inventory" };
      }
      return local
        ? { scope, local, remote, action: "push_active" }
        : { scope, local, remote, action: "pull_active" };
    });
}

function planScopeRepresentative(plan: PersonaPlanScopePlan): PersonaSyncFile {
  return plan.local?.identity || plan.remote?.identity || plan.scope.local[0] || plan.scope.remote[0]!;
}

function planScopeConflictPreview(plan: PersonaPlanScopePlan, state: SyncState): PersonaSyncPreviewFile {
  const source = planScopeRepresentative(plan);
  const local = plan.local?.identity;
  const remote = plan.remote?.identity;
  return {
    roleId: source.roleId,
    path: source.path,
    operation: "conflict",
    direction: "conflict",
    mergeStrategy: source.mergeStrategy,
    localHash: local?.sha256,
    remoteHash: remote?.sha256,
    baseHash: state.hashes[fileKey(source)],
    localSize: local?.size,
    remoteSize: remote?.size
  };
}

function previewPlanScope(plan: PersonaPlanScopePlan, state: SyncState): PersonaSyncPreviewFile[] {
  if (plan.action === "conflict") return [planScopeConflictPreview(plan, state)];
  if (plan.action === "unchanged") {
    return (plan.local?.files || plan.remote?.files || []).map(file => ({
      roleId: file.roleId,
      path: file.path,
      operation: "unchanged",
      direction: "converged",
      mergeStrategy: file.mergeStrategy,
      localHash: file.sha256,
      remoteHash: file.sha256,
      baseHash: state.hashes[fileKey(file)],
      localSize: file.size,
      remoteSize: file.size
    }));
  }
  const direction = plan.action.startsWith("push_") ? "push" as const : "pull" as const;
  const source = direction === "push" ? plan.local! : plan.remote!;
  const target = direction === "push" ? plan.remote : plan.local;
  const targetByPath = new Map((target?.files || []).map(file => [file.path, file]));
  return source.files.map(file => {
    const counterpart = targetByPath.get(file.path);
    return {
      roleId: file.roleId,
      path: file.path,
      operation: counterpart ? `${direction}_update` as const : `${direction}_create` as const,
      direction,
      mergeStrategy: file.mergeStrategy,
      localHash: direction === "push" ? file.sha256 : counterpart?.sha256,
      remoteHash: direction === "pull" ? file.sha256 : counterpart?.sha256,
      baseHash: state.hashes[fileKey(file)],
      localSize: direction === "push" ? file.size : counterpart?.size,
      remoteSize: direction === "pull" ? file.size : counterpart?.size
    };
  });
}

function personaSyncKeyPriority(
  key: string,
  localFiles: ReadonlyMap<string, PersonaSyncFile>,
  remoteFiles: ReadonlyMap<string, PersonaSyncFile>
): number {
  const source = localFiles.get(key) || remoteFiles.get(key);
  if (!source) return 2;
  const planPath = personaPlanStoragePath(source.path);
  if (!planPath) return 2;
  const isIdentity = source.path.replace(/\\/g, "/").toLowerCase().endsWith("/plan.json");
  if (planPath.bucket === "active") return isIdentity ? 3 : 4;
  return isIdentity ? 0 : 1;
}

function sortedPersonaSyncKeys(
  localFiles: ReadonlyMap<string, PersonaSyncFile>,
  remoteFiles: ReadonlyMap<string, PersonaSyncFile>
): string[] {
  return [...new Set([...localFiles.keys(), ...remoteFiles.keys()])]
    .sort((left, right) =>
      personaSyncKeyPriority(left, localFiles, remoteFiles)
        - personaSyncKeyPriority(right, localFiles, remoteFiles)
      || left.localeCompare(right)
    );
}

function assertCompletePersonaSyncManifest(
  value: unknown,
  expectedRoleId?: string
): asserts value is PersonaSyncManifest {
  const manifest = value as Partial<PersonaSyncManifest> | null;
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.roles)) {
    throw new Error("Persona sync peer returned an unsupported manifest schema.");
  }
  const keys = new Set<string>();
  const roleIds = new Set<string>();
  for (const role of manifest.roles) {
    if (!role || typeof role.roleId !== "string" || !role.roleId.trim() || !Array.isArray(role.files)) {
      throw new Error("Persona sync peer returned a malformed role manifest.");
    }
    if (role.roleId !== role.roleId.trim() || role.roleId.includes("/") || role.roleId.includes("\\")) {
      throw new Error("Persona sync peer returned a non-canonical role identity.");
    }
    if (expectedRoleId && role.roleId !== expectedRoleId) {
      throw new Error(`Persona sync peer returned role ${role.roleId} while ${expectedRoleId} was requested.`);
    }
    if (roleIds.has(role.roleId)) throw new Error(`Persona sync peer returned duplicate role identity: ${role.roleId}`);
    roleIds.add(role.roleId);
    for (const file of role.files) {
      if (!file || file.roleId !== role.roleId || typeof file.path !== "string"
        || !Number.isSafeInteger(file.size) || file.size < 0
        || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ""))
        || !personaSyncFileEligible(file.path, file.size)) {
        throw new Error("Persona sync peer returned a malformed file manifest.");
      }
      const key = fileKey(file);
      if (keys.has(key)) throw new Error(`Persona sync peer returned a duplicate file identity: ${key}`);
      keys.add(key);
    }
  }
}

function assertPlanPackageCommandMatchesManifest(
  command: PersonaSyncArchivedPlanPackageCommand,
  side: PersonaPlanScopeSide
): void {
  if (command.roleId !== side.roleId || command.storageId !== side.storageId) {
    throw new Error("Persona sync plan package command changed its bound role or physical storage identity.");
  }
  const prefix = `plans/${side.bucket}/${side.storageId}/`;
  const manifestFiles = new Map(side.files.map(file => [file.path, file]));
  if (command.files.length !== side.files.length) {
    throw new Error("Persona sync plan package physical inventory is not the complete manifest inventory.");
  }
  for (const file of command.files) {
    const fullPath = `${prefix}${file.path.replace(/\\/g, "/")}`;
    const manifestFile = manifestFiles.get(fullPath);
    if (!manifestFile
      || manifestFile.roleId !== side.roleId
      || manifestFile.size !== file.size
      || manifestFile.sha256.toLowerCase() !== file.sha256.toLowerCase()
      || !personaSyncFileEligible(fullPath, file.size)) {
      throw new Error(`Persona sync plan package member is outside the exact manifest inventory: ${fullPath}`);
    }
  }
}

function setSyncStateHash(state: SyncState, key: string, hash: string): void {
  state.hashes[key] = hash;
  if (!state.updatedHashKeys.includes(key)) state.updatedHashKeys.push(key);
}

function removeSyncStatePlanScope(state: SyncState, scopeKey: string): void {
  if (!state.removedPlanScopeKeys.includes(scopeKey)) state.removedPlanScopeKeys.push(scopeKey);
  for (const key of Object.keys(state.hashes)) {
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    const candidate = { roleId: key.slice(0, slash), path: key.slice(slash + 1) };
    if (planScopeKey(candidate) === scopeKey) {
      delete state.hashes[key];
      const updatedIndex = state.updatedHashKeys.indexOf(key);
      if (updatedIndex >= 0) state.updatedHashKeys.splice(updatedIndex, 1);
    }
  }
}

function isAnyPersonaPlanPath(relativePath: string): boolean {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase().startsWith("plans/");
}

function assertPlanPackageResult(
  command: PersonaSyncArchivedPlanPackageCommand,
  value: unknown
): asserts value is PersonaSyncPlanPackageResult {
  const result = value as Partial<PersonaSyncPlanPackageResult> | null;
  if (!result || !new Set(["applied", "unchanged", "conflict"]).has(String(result.status || ""))
    || result.roleId !== command.roleId
    || result.planId !== command.planId
    || result.storageId !== command.storageId
    || !/^[a-f0-9]{64}$/i.test(String(result.inventoryHash || ""))) {
    throw new Error("Persona sync peer returned an unfenced plan package result.");
  }
  if (result.status !== "conflict"
    && String(result.inventoryHash).toLowerCase() !== command.inventoryHash.toLowerCase()) {
    throw new Error("Persona sync peer acknowledged a different plan package inventory.");
  }
}

function applicationScope(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function previewFile(
  local: PersonaSyncFile | undefined,
  remote: PersonaSyncFile | undefined,
  baseHash: string | undefined
): PersonaSyncPreviewFile | null {
  const source = local || remote;
  if (!source) return null;
  const common = {
    roleId: source.roleId,
    path: source.path,
    mergeStrategy: source.mergeStrategy,
    localHash: local?.sha256,
    remoteHash: remote?.sha256,
    baseHash,
    localSize: local?.size,
    remoteSize: remote?.size
  };
  if (local && remote && local.sha256 === remote.sha256) {
    return { ...common, operation: "unchanged", direction: "converged" };
  }
  if (local && !remote) {
    if (personaPlanStoragePath(local.path)?.bucket === "archive") {
      return { ...common, operation: "push_create", direction: "push" };
    }
    if (baseHash && local.mergeStrategy === "three-way-file") {
      return local.sha256 === baseHash
        ? { ...common, operation: "pull_delete", direction: "pull" }
        : { ...common, operation: "conflict", direction: "conflict" };
    }
    return { ...common, operation: "push_create", direction: "push" };
  }
  if (!local && remote) {
    if (personaPlanStoragePath(remote.path)?.bucket === "archive") {
      return { ...common, operation: "pull_create", direction: "pull" };
    }
    if (baseHash && remote.mergeStrategy === "three-way-file" && remote.sha256 === baseHash) {
      return { ...common, operation: "push_delete", direction: "push" };
    }
    if (baseHash && baseHash !== PERSONA_SYNC_DELETED_HASH && remote.mergeStrategy === "three-way-file") {
      return { ...common, operation: "conflict", direction: "conflict" };
    }
    return { ...common, operation: "pull_create", direction: "pull" };
  }
  if (!local || !remote) return null;
  if (baseHash && local.sha256 === baseHash) {
    return { ...common, operation: "pull_update", direction: "pull" };
  }
  if (baseHash && remote.sha256 === baseHash) {
    return { ...common, operation: "push_update", direction: "push" };
  }
  if (local.mergeStrategy === "jsonl-union") {
    return { ...common, operation: "auto_merge", direction: "merge" };
  }
  return { ...common, operation: "conflict", direction: "conflict" };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class PersonaSyncCoordinator {
  private readonly syncFlights = new Map<string, Promise<PersonaSyncResult>>();

  constructor(
    readonly service: PersonaSyncService,
    readonly stateRoot: string,
    readonly relayConfig: () => PersonaSyncRelayConfig
  ) {}

  async peers(): Promise<PersonaSyncPeer[]> {
    return discoverRabiPeers(this.relayConfig());
  }

  async sync(peerId: string, roleId?: string): Promise<PersonaSyncResult> {
    const key = `${safePeerId(peerId)}:${roleId || "*"}`;
    const existing = this.syncFlights.get(key);
    if (existing) return existing;
    const flight = this.runSync(peerId, roleId).finally(() => {
      if (this.syncFlights.get(key) === flight) this.syncFlights.delete(key);
    });
    this.syncFlights.set(key, flight);
    return flight;
  }

  async preview(peerId: string, roleId?: string): Promise<PersonaSyncPreview> {
    const peers = await this.peers();
    const peer = peers.find(item => item.id === peerId || item.guid === peerId);
    if (!peer) throw new Error(`Persona sync peer was not found: ${peerId}`);
    if (!peer.capabilities.includes("persona-sync")) throw new Error(`Peer ${peer.name} does not advertise persona-sync.`);
    const relay = this.relayConfig();
    const connection = await this.connect(peer, relay, roleId);
    const localManifest = await this.service.manifest(roleId);
    assertCompletePersonaSyncManifest(localManifest, roleId);
    const localFiles = new Map(localManifest.roles
      .flatMap(role => role.files)
      .map(file => [fileKey(file), file]));
    const remoteFiles = new Map(connection.manifest.roles
      .flatMap(role => role.files)
      .map(file => [fileKey(file), file]));
    const state = this.readState(peer.guid || peer.id, relay.token);
    const planScopes = planPersonaPlanScopes(
      localFiles,
      remoteFiles,
      peer.capabilities.includes(PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY)
    );
    const planFiles = planScopes.flatMap(plan => previewPlanScope(plan, state));
    const regularFiles = sortedPersonaSyncKeys(localFiles, remoteFiles)
      .filter(key => {
        const source = localFiles.get(key) || remoteFiles.get(key);
        return source ? !planScopeKey(source) : false;
      })
      .map(key => previewFile(localFiles.get(key), remoteFiles.get(key), state.hashes[key]))
      .filter((file): file is PersonaSyncPreviewFile => Boolean(file));
    const files = [...planFiles, ...regularFiles]
      .sort((left, right) => fileKey(left).localeCompare(fileKey(right)));
    return {
      peer,
      transport: connection.transport,
      files,
      changedFiles: files.filter(file => file.operation !== "unchanged").length,
      conflicts: files.filter(file => file.operation === "conflict").length
    };
  }

  async publishConflictResolution(
    resolution: PersonaSyncConflictResolution
  ): Promise<PersonaSyncResolutionPublishResult> {
    const peerId = String(resolution.peerId || "").trim();
    if (!peerId) {
      return { status: "not_published", message: "Conflict evidence does not identify the source peer." };
    }
    if (isAnyPersonaPlanPath(resolution.path)) {
      return {
        status: "not_published",
        peerId,
        message: "Plan conflict resolution must be published as one fenced plan package, never as a single file."
      };
    }
    try {
      const peers = await this.peers();
      const peer = peers.find(item => item.id === peerId || item.guid === peerId);
      if (!peer) return { status: "not_published", peerId, message: "The source peer is not currently discoverable." };
      if (!peer.capabilities.includes("persona-sync")) {
        return { status: "not_published", peerId, message: `Peer ${peer.name} does not advertise persona-sync.` };
      }
      const relay = this.relayConfig();
      const connection = await this.connect(peer, relay, resolution.roleId);
      const key = `${resolution.roleId}/${resolution.path}`;
      const remote = connection.manifest.roles
        .flatMap(role => role.files)
        .find(file => fileKey(file) === key);
      const remoteMatchesEvidence = resolution.remoteDeleted
        ? !remote
        : remote?.sha256 === resolution.remoteHash;
      if (!remoteMatchesEvidence) {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The peer changed after this conflict evidence was captured; synchronize again to create current evidence."
        };
      }
      const local = (await this.service.manifest(resolution.roleId)).roles
        .flatMap(role => role.files)
        .find(file => fileKey(file) === key);
      const localMatchesResolution = resolution.resultHash
        ? local?.sha256 === resolution.resultHash
        : !local;
      if (!localMatchesResolution) {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The local file changed after conflict resolution; synchronize again instead of publishing stale content."
        };
      }

      let merge: PersonaSyncMergeResult | undefined;
      if (local && (!remote || local.sha256 !== remote.sha256)) {
        const content = this.service.readFile(local.roleId, local.path).content;
        merge = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: content.toString("base64"),
          remoteHash: local.sha256,
          baseHash: resolution.remoteDeleted ? PERSONA_SYNC_DELETED_HASH : resolution.remoteHash,
          peerId: relay.deviceId
        });
      } else if (!local && remote) {
        const planPath = personaPlanStoragePath(resolution.path);
        if (planPath?.bucket === "archive") {
          return {
            status: "not_published",
            peerId,
            transport: connection.transport,
            message: "Canonical archived plan storage cannot be published as a deletion."
          };
        }
        merge = await this.remoteMerge(connection, relay, {
          roleId: resolution.roleId,
          path: resolution.path,
          deleted: true,
          remoteHash: PERSONA_SYNC_DELETED_HASH,
          baseHash: resolution.remoteHash,
          peerId: relay.deviceId
        });
      }
      if (merge?.status === "conflict") {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The peer refused the resolved version because its current file no longer matches the evidence.",
          merge
        };
      }

      const statePeerId = peer.guid || peer.id;
      const state = this.readState(statePeerId, relay.token);
      if (local) setSyncStateHash(state, key, local.sha256);
      else if (resolution.baseHash) setSyncStateHash(state, key, resolution.baseHash);
      else if (!resolution.remoteDeleted) setSyncStateHash(state, key, resolution.remoteHash);
      this.writeState(state, relay.token);
      return { status: "published", peerId, transport: connection.transport, merge };
    } catch (error) {
      return {
        status: "not_published",
        peerId,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async runSync(peerId: string, roleId?: string): Promise<PersonaSyncResult> {
    let expectedIdentity: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const peers = await this.peers();
      const peer = peers.find(item => item.id === peerId || item.guid === peerId);
      if (!peer) throw new Error(`Persona sync peer was not found: ${peerId}`);
      if (!peer.capabilities.includes("persona-sync")) throw new Error(`Peer ${peer.name} does not advertise persona-sync.`);
      const relay = this.relayConfig();
      const identity = JSON.stringify({
        peerId: peer.id,
        peerGuid: peer.guid || "",
        applicationDeviceId: relay.deviceId,
        applicationDeviceGuid: relay.deviceGuid,
        applicationTokenDigest: createHash("sha256").update(relay.token).digest("hex"),
        personaId: roleId || "*"
      });
      if (expectedIdentity !== undefined && identity !== expectedIdentity) {
        throw new PersonaSyncTransactionIdentityChangedError("peer, application, or persona identity no longer matches the first attempt");
      }
      expectedIdentity ??= identity;
      try {
        return await this.runSyncAttempt(peer, relay, roleId);
      } catch (error) {
        if (!(error instanceof PersonaSyncStaleManifestError)) throw error;
        if (attempt === 1) {
          throw new PersonaSyncStaleManifestError(
            error.roleId,
            error.relativePath,
            `Persona sync manifest changed again after one complete transaction restart: ${error.message}`,
            error.manifestRevision
          );
        }
        await this.waitForPeerManifestAdvance(
          peer,
          relay,
          roleId,
          error.manifestRevision,
          { roleId: error.roleId, path: error.relativePath }
        );
      }
    }
    throw new Error("Persona sync transaction restart invariant was not satisfied.");
  }

  private async runSyncAttempt(
    peer: PersonaSyncPeer,
    relay: PersonaSyncRelayConfig,
    roleId?: string
  ): Promise<PersonaSyncResult> {
    const connection = await this.connect(peer, relay, roleId);
    const localManifest = await this.service.manifest(roleId);
    assertCompletePersonaSyncManifest(localManifest, roleId);
    const localFiles = new Map(localManifest.roles
      .flatMap(role => role.files)
      .map(file => [fileKey(file), file]));
    const remoteFiles = new Map(connection.manifest.roles
      .flatMap(role => role.files)
      .map(file => [fileKey(file), file]));
    const statePeerId = peer.guid || peer.id;
    const state = this.readState(statePeerId, relay.token);
    const results: PersonaSyncResult["files"] = [];
    const planScopes = planPersonaPlanScopes(
      localFiles,
      remoteFiles,
      peer.capabilities.includes(PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY)
    );
    const completedPlanScopes: CompletedPersonaPlanScope[] = [];
    for (const plan of planScopes) {
      if (plan.action === "conflict") {
        const source = planScopeRepresentative(plan);
        results.push({
          status: "conflict",
          roleId: source.roleId,
          path: source.path,
          localHash: plan.local?.identity.sha256,
          remoteHash: plan.remote?.identity.sha256 ?? PERSONA_SYNC_DELETED_HASH,
          resultHash: plan.local?.identity.sha256,
          remoteDeleted: !plan.remote,
          direction: "converged"
        });
        continue;
      }
      if (plan.action === "unchanged") {
        const source = plan.local || plan.remote!;
        for (const file of source.files) {
          results.push({
            status: "unchanged",
            roleId: file.roleId,
            path: file.path,
            localHash: file.sha256,
            remoteHash: file.sha256,
            resultHash: file.sha256,
            direction: "converged"
          });
        }
        completedPlanScopes.push({
          key: plan.scope.key,
          action: plan.action,
          bucket: source.bucket,
          storageId: source.storageId,
          expectedFiles: source.files
        });
        continue;
      }

      const direction = plan.action.startsWith("push_") ? "push" as const : "pull" as const;
      const bucket = plan.action.endsWith("_archive") ? "archive" as const : "active" as const;
      const source = direction === "push" ? plan.local! : plan.remote!;
      if (source.bucket !== bucket) {
        throw new Error(`Persona sync plan planner selected the wrong package bucket: ${plan.scope.key}`);
      }
      let command: PersonaSyncArchivedPlanPackageCommand;
      let packageResult: PersonaSyncPlanPackageResult;
      if (direction === "push") {
        const roleDir = path.join(this.service.rolesRoot(), source.roleId);
        const storedPlanId = canonicalPlanIdForStorageIdentity(roleDir, source.storageId);
        let planId: string;
        try {
          planId = canonicalLogicalPlanId(storedPlanId);
        } catch {
          throw new Error(`Persona sync could not bind local ${bucket} identity: ${source.roleId}/${source.storageId}`);
        }
        if (canonicalPlanStorageName(planId) !== source.storageId) {
          throw new Error(`Persona sync could not bind local ${bucket} identity: ${source.roleId}/${source.storageId}`);
        }
        command = bucket === "archive"
          ? createArchivedPlanPackageCommand(
              source.roleId,
              planId,
              planStorageDirectory(roleDir, planId, "archive"),
              relay.deviceId
            )
          : createActivePlanPackageCommand(
              source.roleId,
              planId,
              planStorageDirectory(roleDir, planId, "active"),
              relay.deviceId
            );
        assertPlanPackageCommandMatchesManifest(command, source);
        packageResult = bucket === "archive"
          ? await this.remoteArchivedPlanPackage(connection, relay, command)
          : await this.remoteActivePlanPackage(connection, relay, command);
      } else {
        command = bucket === "archive"
          ? await this.readRemoteArchivedPlanPackage(connection, relay, source, peer.id)
          : await this.readRemoteActivePlanPackage(connection, relay, source, peer.id);
        assertPlanPackageCommandMatchesManifest(command, source);
        packageResult = bucket === "archive"
          ? this.service.applyArchivedPlanPackage(command)
          : this.service.applyActivePlanPackage(command);
        assertPlanPackageResult(command, packageResult);
      }
      if (packageResult.status === "conflict") {
        results.push({
          status: "conflict",
          roleId: source.identity.roleId,
          path: source.identity.path,
          localHash: plan.local?.identity.sha256,
          remoteHash: plan.remote?.identity.sha256 ?? PERSONA_SYNC_DELETED_HASH,
          resultHash: plan.local?.identity.sha256,
          direction
        });
        continue;
      }
      for (const file of source.files) {
        results.push({
          status: packageResult.status === "unchanged" ? "unchanged" : "fast_forwarded",
          roleId: file.roleId,
          path: file.path,
          localHash: localFiles.get(fileKey(file))?.sha256,
          remoteHash: remoteFiles.get(fileKey(file))?.sha256 ?? file.sha256,
          resultHash: file.sha256,
          direction
        });
      }
      completedPlanScopes.push({
        key: plan.scope.key,
        action: plan.action,
        bucket,
        storageId: source.storageId,
        expectedFiles: source.files
      });
    }
    for (const key of sortedPersonaSyncKeys(localFiles, remoteFiles)) {
      let local = localFiles.get(key);
      const remote = remoteFiles.get(key);
      const source = local || remote;
      if (source && planScopeKey(source)) continue;
      if (local && remote && local.sha256 === remote.sha256) {
        setSyncStateHash(state, key, local.sha256);
        results.push({
          status: "unchanged",
          roleId: local.roleId,
          path: local.path,
          localHash: local.sha256,
          remoteHash: remote.sha256,
          resultHash: local.sha256,
          direction: "converged"
        });
        continue;
      }
      if (!remote && local) {
        const baseHash = state.hashes[key];
        const planPath = personaPlanStoragePath(local.path);
        if (baseHash && local.mergeStrategy === "three-way-file" && !planPath) {
          const pulledDeletion = this.service.merge({
            roleId: local.roleId,
            path: local.path,
            deleted: true,
            remoteHash: PERSONA_SYNC_DELETED_HASH,
            baseHash,
            peerId: peer.id
          });
          results.push({ ...pulledDeletion, direction: "pull" });
          continue;
        }
        const localContent = this.service.readFile(local.roleId, local.path).content;
        const pushed = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: localContent.toString("base64"),
          remoteHash: local.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushed, direction: "push" });
        if (pushed.status !== "conflict" && pushed.resultHash) setSyncStateHash(state, key, pushed.resultHash);
        continue;
      }
      if (!remote) continue;
      if (!local
        && remote.mergeStrategy === "three-way-file"
        && state.hashes[key]
        && remote.sha256 === state.hashes[key]
        && !personaPlanStoragePath(remote.path)) {
        const pushedDeletion = await this.remoteMerge(connection, relay, {
          roleId: remote.roleId,
          path: remote.path,
          deleted: true,
          remoteHash: PERSONA_SYNC_DELETED_HASH,
          baseHash: remote.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushedDeletion, direction: "push" });
        continue;
      }
      const remoteContent = await this.remoteFile(connection, relay, remote);
      const pulled = this.service.merge({
        roleId: remote.roleId,
        path: remote.path,
        contentBase64: remoteContent.toString("base64"),
        remoteHash: remote.sha256,
        baseHash: state.hashes[key],
        peerId: peer.id
      });
      results.push({ ...pulled, direction: "pull" });
      if (pulled.status === "conflict") continue;
      local = (await this.service.manifest(remote.roleId)).roles[0]?.files.find(file => file.path === remote.path);
      if (!local) continue;
      if (local.sha256 !== remote.sha256) {
        const content = this.service.readFile(local.roleId, local.path).content;
        const pushed = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: content.toString("base64"),
          remoteHash: local.sha256,
          baseHash: remote.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushed, direction: "push" });
        if (pushed.status === "conflict") continue;
      }
      setSyncStateHash(state, key, local.sha256);
    }
    if (completedPlanScopes.length > 0) {
      const verifiedLocalManifest = await this.service.manifest(roleId);
      assertCompletePersonaSyncManifest(verifiedLocalManifest, roleId);
      const verifiedRemote = await this.connect(peer, relay, roleId);
      const verifiedLocalFiles = new Map(verifiedLocalManifest.roles
        .flatMap(role => role.files)
        .map(file => [fileKey(file), file]));
      const verifiedRemoteFiles = new Map(verifiedRemote.manifest.roles
        .flatMap(role => role.files)
        .map(file => [fileKey(file), file]));
      const verifiedScopes = collectPlanScopes(verifiedLocalFiles, verifiedRemoteFiles);
      for (const expected of completedPlanScopes) {
        const scope = verifiedScopes.get(expected.key);
        const local = scope ? describePlanScopeSide(scope, scope.local, "local postverify") : null;
        const remote = scope ? describePlanScopeSide(scope, scope.remote, "remote postverify") : null;
        const localMatchesExpected = Boolean(local && sameFileSet(local.files, expected.expectedFiles));
        const remoteMatchesExpected = Boolean(remote && sameFileSet(remote.files, expected.expectedFiles));
        if (!scope
          || !local
          || !remote
          || local.bucket !== expected.bucket
          || remote.bucket !== expected.bucket
          || local.storageId !== expected.storageId
          || remote.storageId !== expected.storageId
          || !sameFileSet(local.files, remote.files)
          || !sameFileSet(local.files, expected.expectedFiles)) {
          const representative = expected.expectedFiles[0];
          throw new PersonaSyncStaleManifestError(
            representative?.roleId || roleId || "*",
            representative?.path || `${expected.bucket}-plan-package`,
            `Persona sync ${expected.bucket} plan package post-verification observed a stale manifest after ${expected.action}: ${expected.key}; local=${local?.bucket || "missing"}/${local?.storageId || "missing"}/${local?.files.length ?? 0}/${localMatchesExpected}; remote=${remote?.bucket || "missing"}/${remote?.storageId || "missing"}/${remote?.files.length ?? 0}/${remoteMatchesExpected}; expected=${expected.expectedFiles.length}`,
            verifiedRemote.manifestRevision
          );
        }
        removeSyncStatePlanScope(state, expected.key);
        for (const file of local.files) setSyncStateHash(state, fileKey(file), file.sha256);
      }
    }
    this.writeState(state, relay.token);
    const fileConflicts = results.filter(item => item.status === "conflict").length;
    const semanticConflicts = await this.semanticConflicts(roleId);
    return {
      peer,
      baseUrl: connection.baseUrl,
      transport: connection.transport,
      files: results,
      fileConflicts,
      semanticConflicts,
      conflicts: fileConflicts + semanticConflicts.length
    };
  }

  private async semanticConflicts(roleId?: string): Promise<PersonaSyncSemanticConflict[]> {
    const manifest = await this.service.manifest(roleId);
    return manifest.roles.flatMap(role => {
      const roleDir = path.join(this.service.rolesRoot(), role.roleId);
      const voiceConflicts: PersonaSyncSemanticConflict[] = listPersonaVoiceIdentities(roleDir).flatMap(identity => identity.conflicted ? [{
        kind: "persona_voice_identity" as const,
        roleId: role.roleId,
        path: "voice/voice-identities.jsonl" as const,
        identityKey: identity.identityKey,
        sourceHostId: identity.sourceHostId,
        voiceprintId: identity.voiceprintId,
        fields: identity.conflictFields ?? [],
        candidateEventIds: identity.conflictCandidates?.map(candidate => candidate.eventId).sort() ?? []
      }] : []);
      const identityConflicts: PersonaSyncSemanticConflict[] = listIdentityRelationConflicts(roleDir).map(conflict => ({
        kind: "identity_relation" as const,
        roleId: role.roleId,
        path: "identity-relations/events.jsonl" as const,
        recordKind: conflict.recordKind,
        recordId: conflict.recordId,
        candidateEventIds: conflict.candidateEventIds
      }));
      return [...voiceConflicts, ...identityConflicts];
    });
  }

  private async connect(
    peer: PersonaSyncPeer,
    relay: PersonaSyncRelayConfig,
    roleId?: string
  ): Promise<{ baseUrl: string; transport: "lan" | "relay"; peerId: string; manifest: PersonaSyncManifest; manifestRevision?: number }> {
    let lastError: unknown;
    for (const baseUrl of peer.peerUrls) {
      try {
        const params = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
        const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/api/persona-sync/manifest${params}`, {
          headers: { "x-rabilink-token": relay.token }
        }, 3_000);
        const body = await response.json() as {
          data?: PersonaSyncManifest;
          message?: string;
          scan?: { partial?: boolean; state?: string; revision?: number };
        };
        if (!response.ok || !body.data) throw new Error(body.message || `HTTP ${response.status}`);
        if (body.scan?.state !== "ok" || body.scan.partial !== false) {
          throw new Error(`Persona sync refused a peer manifest without an explicit complete scan: ${body.scan?.state || "missing"}`);
        }
        assertCompletePersonaSyncManifest(body.data, roleId);
        return {
          baseUrl: baseUrl.replace(/\/+$/, ""), transport: "lan", peerId: peer.id,
          manifest: body.data, manifestRevision: body.scan?.revision
        };
      } catch (error) {
        lastError = error;
      }
    }
    try {
      const params = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
      const response = await this.relayProxy(relay, peer.id, "GET", `/api/persona-sync/manifest${params}`);
      const body = await response.json() as {
        data?: PersonaSyncManifest;
        message?: string;
        scan?: { partial?: boolean; state?: string; revision?: number };
      };
      if (!response.ok || !body.data) throw new Error(body.message || `HTTP ${response.status}`);
      if (body.scan?.state !== "ok" || body.scan.partial !== false) {
        throw new Error(`Persona sync refused a peer manifest without an explicit complete scan: ${body.scan?.state || "missing"}`);
      }
      assertCompletePersonaSyncManifest(body.data, roleId);
      return {
        baseUrl: relay.url.replace(/\/+$/, ""),
        transport: "relay",
        peerId: peer.id,
        manifest: body.data,
        manifestRevision: body.scan?.revision
      };
    } catch (relayError) {
      const directMessage = lastError instanceof Error ? lastError.message : "no direct endpoint";
      const relayMessage = relayError instanceof Error ? relayError.message : String(relayError);
      throw new Error(`Persona sync could not reach ${peer.name} directly or through Relay: direct=${directMessage}; relay=${relayMessage}`);
    }
  }

  private async remoteFile(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string; manifestRevision?: number },
    relay: PersonaSyncRelayConfig,
    file: PersonaSyncFile
  ): Promise<Buffer> {
    const remotePath = `/api/persona-sync/files/${encodeURIComponent(file.roleId)}/${encodeURIComponent(file.path)}`;
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}${remotePath}`, { headers: { "x-rabilink-token": relay.token } })
      : await this.relayProxy(relay, connection.peerId, "GET", remotePath, undefined, "application/octet-stream");
    if (!response.ok) {
      if (response.status === 404 || response.status === 409 || response.status === 412) {
        throw new PersonaSyncStaleManifestError(
          file.roleId,
          file.path,
          `Persona sync peer no longer serves the manifest version for ${file.roleId}/${file.path}: HTTP ${response.status}`,
          connection.manifestRevision
        );
      }
      throw new Error(`Failed to read ${file.roleId}/${file.path} from peer: HTTP ${response.status}`);
    }
    const content = Buffer.from(await response.arrayBuffer());
    const roleHeader = response.headers.get("x-rabi-role-id") || "";
    const pathHeader = response.headers.get("x-rabi-relative-path") || "";
    const hashHeader = (response.headers.get("x-rabi-sha256") || "").toLowerCase();
    let responsePath = "";
    try {
      responsePath = decodeURIComponent(pathHeader);
    } catch {
      throw new Error(`Peer file returned an invalid path identity: ${file.roleId}/${file.path}`);
    }
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (roleHeader !== file.roleId
      || responsePath !== file.path
      || hashHeader !== file.sha256.toLowerCase()
      || content.byteLength !== file.size
      || contentHash !== file.sha256.toLowerCase()) {
      throw new PersonaSyncStaleManifestError(
        file.roleId,
        file.path,
        `Persona sync peer file changed after the manifest was captured: ${file.roleId}/${file.path}`,
        connection.manifestRevision
      );
    }
    return content;
  }

  private async waitForPeerManifestAdvance(
    peer: PersonaSyncPeer,
    relay: PersonaSyncRelayConfig,
    roleId: string | undefined,
    previousRevision: number | undefined,
    staleFile: Pick<PersonaSyncFile, "roleId" | "path">
  ): Promise<void> {
    if (previousRevision === undefined) return;
    const deadline = Date.now() + PERSONA_SYNC_PUBLICATION_ADVANCE_TIMEOUT_MS;
    let observedRevision = previousRevision;
    let stableProbes = 0;
    while (Date.now() < deadline) {
      try {
        const refreshed = await this.connect(peer, relay, roleId);
        const revision = refreshed.manifestRevision;
        if (revision === undefined) return;
        if (revision > previousRevision) {
          if (!await this.peerManifestPathMatches(refreshed, relay, staleFile)) {
            stableProbes = 0;
            await new Promise<void>(resolve => setTimeout(resolve, PERSONA_SYNC_PUBLICATION_PROBE_INTERVAL_MS));
            continue;
          }
          if (revision === observedRevision) stableProbes += 1;
          else {
            observedRevision = revision;
            stableProbes = 1;
          }
          if (stableProbes >= PERSONA_SYNC_PUBLICATION_STABLE_PROBES) return;
        }
      } catch {
        // A refreshing/degraded publication is not a transaction attempt.
      }
      await new Promise<void>(resolve => setTimeout(resolve, PERSONA_SYNC_PUBLICATION_PROBE_INTERVAL_MS));
    }
  }

  private async peerManifestPathMatches(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string; manifest: PersonaSyncManifest; manifestRevision?: number },
    relay: PersonaSyncRelayConfig,
    expected: Pick<PersonaSyncFile, "roleId" | "path">
  ): Promise<boolean> {
    const file = connection.manifest.roles
      .flatMap(role => role.files)
      .find(item => item.roleId === expected.roleId && item.path === expected.path);
    if (file) {
      try {
        await this.remoteFile(connection, relay, file);
        return true;
      } catch (error) {
        if (error instanceof PersonaSyncStaleManifestError) return false;
        throw error;
      }
    }
    const remotePath = `/api/persona-sync/files/${encodeURIComponent(expected.roleId)}/${encodeURIComponent(expected.path)}`;
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}${remotePath}`, { headers: { "x-rabilink-token": relay.token } })
      : await this.relayProxy(relay, connection.peerId, "GET", remotePath, undefined, "application/octet-stream");
    await response.arrayBuffer();
    return response.status === 404;
  }

  private async readRemoteArchivedPlanPackage(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string; manifestRevision?: number },
    relay: PersonaSyncRelayConfig,
    side: PersonaPlanScopeSide,
    peerId: string
  ): Promise<PersonaSyncArchivedPlanPackageCommand> {
    if (side.bucket !== "archive") throw new Error("Persona sync peer archive package was bound to the wrong bucket.");
    return this.readRemotePlanPackage(connection, relay, side, peerId);
  }

  private async readRemoteActivePlanPackage(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    side: PersonaPlanScopeSide,
    peerId: string
  ): Promise<PersonaSyncActivePlanPackageCommand> {
    if (side.bucket !== "active") throw new Error("Persona sync peer active package was bound to the wrong bucket.");
    return this.readRemotePlanPackage(connection, relay, side, peerId);
  }

  private async readRemotePlanPackage(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    side: PersonaPlanScopeSide,
    peerId: string
  ): Promise<PersonaSyncArchivedPlanPackageCommand> {
    const prefix = `plans/${side.bucket}/${side.storageId}/`;
    const expectedIdentityPath = `${prefix}plan.json`;
    if (side.identity.roleId !== side.roleId
      || side.identity.path.replace(/\\/g, "/") !== expectedIdentityPath) {
      throw new Error("Persona sync peer plan package has no exact role/bucket/storage identity.");
    }

    // The identity is the only remote body allowed before the entire package is
    // bound. A malicious plan.json therefore cannot make us fetch an attachment,
    // history, or feedback member under another logical plan.
    const identityContent = await this.remoteFile(connection, relay, side.identity);
    let planId: string;
    try {
      const parsed = JSON.parse(identityContent.toString("utf8")) as { id?: unknown; status?: unknown };
      if (typeof parsed.id !== "string") throw new Error("missing string id");
      planId = canonicalLogicalPlanId(parsed.id);
      if (canonicalPlanStorageName(planId) !== side.storageId) {
        throw new Error("non-canonical logical identity");
      }
      const archived = (parsed as { archiveStatus?: unknown }).archiveStatus === "已归档" || parsed.status === "已归档";
      if (side.bucket === "archive" ? !archived : archived) {
        throw new Error("bucket/status mismatch");
      }
    } catch {
      throw new Error(`Persona sync peer ${side.bucket} package has an invalid bound plan identity.`);
    }

    const packageFiles: PersonaSyncPlanPackageFile[] = [];
    for (const file of side.files) {
      const normalized = file.path.replace(/\\/g, "/");
      const planPath = personaPlanStoragePath(normalized);
      if (!planPath
        || file.roleId !== side.roleId
        || planPath.bucket !== side.bucket
        || planPath.storageId !== side.storageId
        || !normalized.startsWith(prefix)) {
        throw new Error("Persona sync peer plan package crosses its bound role, bucket, or storage identity.");
      }
      const content = normalized === expectedIdentityPath
        ? identityContent
        : await this.remoteFile(connection, relay, file);
      packageFiles.push({
        path: normalized.slice(prefix.length),
        size: content.byteLength,
        sha256: file.sha256,
        contentBase64: content.toString("base64")
      });
    }
    return side.bucket === "archive"
      ? createArchivedPlanPackageCommandFromFiles(side.roleId, planId, packageFiles, peerId)
      : createActivePlanPackageCommandFromFiles(side.roleId, planId, packageFiles, peerId);
  }

  private async remoteArchivedPlanPackage(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    command: PersonaSyncArchivedPlanPackageCommand
  ): Promise<PersonaSyncPlanPackageResult> {
    const bodyBuffer = Buffer.from(JSON.stringify(command), "utf8");
    const remotePath = "/api/persona-sync/plan-packages/archive";
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}${remotePath}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
          body: bodyBuffer
        }, 70_000)
      : await this.relayProxy(relay, connection.peerId, "POST", remotePath, bodyBuffer);
    const body = await response.json().catch(() => ({})) as { data?: PersonaSyncPlanPackageResult; message?: string };
    if (!body.data) throw new Error(body.message || `Peer plan package commit failed: HTTP ${response.status}`);
    assertPlanPackageResult(command, body.data);
    if (!response.ok && body.data.status !== "conflict") {
      throw new Error(body.message || `Peer plan package commit failed: HTTP ${response.status}`);
    }
    return body.data;
  }

  private async remoteActivePlanPackage(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    command: PersonaSyncActivePlanPackageCommand
  ): Promise<PersonaSyncPlanPackageResult> {
    const bodyBuffer = Buffer.from(JSON.stringify(command), "utf8");
    const remotePath = "/api/persona-sync/plan-packages/active";
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}${remotePath}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
          body: bodyBuffer
        }, 70_000)
      : await this.relayProxy(relay, connection.peerId, "POST", remotePath, bodyBuffer);
    const body = await response.json().catch(() => ({})) as { data?: PersonaSyncPlanPackageResult; message?: string };
    if (!body.data) throw new Error(body.message || `Peer active plan package commit failed: HTTP ${response.status}`);
    assertPlanPackageResult(command, body.data);
    if (!response.ok && body.data.status !== "conflict") {
      throw new Error(body.message || `Peer active plan package commit failed: HTTP ${response.status}`);
    }
    return body.data;
  }

  private async remoteMerge(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    command: Record<string, unknown>
  ): Promise<PersonaSyncMergeResult> {
    const bodyBuffer = Buffer.from(JSON.stringify(command), "utf8");
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}/api/persona-sync/merge`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
          body: bodyBuffer
        })
      : await this.relayProxy(relay, connection.peerId, "POST", "/api/persona-sync/merge", bodyBuffer);
    const body = await response.json().catch(() => ({})) as { data?: PersonaSyncMergeResult; message?: string };
    if (!body.data) throw new Error(body.message || `Peer merge failed: HTTP ${response.status}`);
    return body.data;
  }

  private relayProxy(
    relay: PersonaSyncRelayConfig,
    targetDeviceId: string,
    method: "GET" | "POST",
    remotePath: string,
    body?: Buffer,
    accept = "application/json"
  ): Promise<Response> {
    return fetchWithTimeout(`${relay.url.replace(/\/+$/, "")}/api/rabilink/persona-sync/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
      body: JSON.stringify({
        targetDeviceId,
        method,
        path: remotePath,
        accept,
        bodyBase64: body?.toString("base64") || ""
      })
    }, 70_000);
  }

  private statePath(peerId: string, applicationToken: string): string {
    return path.join(this.stateRoot, "peers", applicationScope(applicationToken), `${safePeerId(peerId)}.json`);
  }

  private readState(peerId: string, applicationToken: string): SyncState {
    const filePath = this.statePath(peerId, applicationToken);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SyncState>;
      return {
        schemaVersion: 1,
        peerId,
        hashes: parsed.hashes && typeof parsed.hashes === "object" ? parsed.hashes : {},
        updatedAt: String(parsed.updatedAt || new Date().toISOString()),
        updatedHashKeys: [],
        removedPlanScopeKeys: []
      };
    } catch {
      return {
        schemaVersion: 1,
        peerId,
        hashes: {},
        updatedAt: new Date().toISOString(),
        updatedHashKeys: [],
        removedPlanScopeKeys: []
      };
    }
  }

  private writeState(state: SyncState, applicationToken: string): void {
    const filePath = this.statePath(state.peerId, applicationToken);
    withFileLockSync(`${filePath}.lock`, () => {
      const latest = this.readState(state.peerId, applicationToken);
      const hashes = { ...latest.hashes };
      for (const scopeKey of new Set(state.removedPlanScopeKeys)) {
        for (const key of Object.keys(hashes)) {
          const slash = key.indexOf("/");
          if (slash < 0) continue;
          const candidate = { roleId: key.slice(0, slash), path: key.slice(slash + 1) };
          try {
            if (planScopeKey(candidate) === scopeKey) delete hashes[key];
          } catch {
            // A malformed historical key is unrelated to this exact scope. Keep
            // it for a separate state migration instead of broad deletion here.
          }
        }
      }
      for (const key of new Set(state.updatedHashKeys)) {
        if (Object.prototype.hasOwnProperty.call(state.hashes, key)) hashes[key] = state.hashes[key]!;
      }
      atomicWriteFileSync(filePath, `${JSON.stringify({
        schemaVersion: 1,
        peerId: state.peerId,
        hashes,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`);
    });
  }
}
