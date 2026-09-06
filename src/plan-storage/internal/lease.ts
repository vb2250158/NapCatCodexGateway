import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  canonicalLogicalPlanId,
  canonicalPlanStorageCollisionKey,
  canonicalPlanStorageKey
} from "../../planStorageIdentity.js";

const leaseBrand: unique symbol = Symbol("PlanStorageLease");
const PLAN_LOCK_TIMEOUT_MS = 10_000;
const PLAN_LOCK_HEARTBEAT_MS = 10_000;
const PLAN_LOCK_EXPIRY_MS = 60_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const SYNC_HEARTBEAT_STOP_INDEX = 0;
const SYNC_HEARTBEAT_STATUS_INDEX = 1;
const SYNC_HEARTBEAT_FAILURE_INDEX = 2;
const SYNC_HEARTBEAT_STARTING = 0;
const SYNC_HEARTBEAT_ACTIVE = 1;
const SYNC_HEARTBEAT_STOPPED = 3;
const SYNC_HEARTBEAT_CONTROL_WORDS = 4;
const SYNC_HEARTBEAT_WAIT_TIMEOUT_MS = 10_000;

const SYNC_LEASE_HEARTBEAT_WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const STOP_INDEX = 0;
const STATUS_INDEX = 1;
const FAILURE_INDEX = 2;
const COUNT_INDEX = 3;
const STARTING = 0;
const ACTIVE = 1;
const FAILED = 2;
const STOPPED = 3;
const FAILURE_MISSING = 1;
const FAILURE_INVALID = 2;
const FAILURE_OWNER_CHANGED = 3;
const FAILURE_FENCED = 4;
const FAILURE_EXPIRED = 5;
const FAILURE_IO = 6;

function publishStatus(status) {
  Atomics.store(control, STATUS_INDEX, status);
  Atomics.notify(control, STATUS_INDEX);
}

function fail(code) {
  if (Atomics.load(control, STATUS_INDEX) === FAILED) return false;
  Atomics.store(control, FAILURE_INDEX, code);
  publishStatus(FAILED);
  return false;
}

function leaseFailure(code) {
  const error = new Error("lease heartbeat failed");
  error.leaseFailure = code;
  throw error;
}

function sameStat(left, right) {
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino;
}

function parseRecord(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function renew() {
  let descriptor;
  let failure = 0;
  try {
    descriptor = fs.openSync(workerData.lockPath, "r+");
    const before = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (!sameStat(before, after)) leaseFailure(FAILURE_INVALID);
    const record = parseRecord(raw);
    if (!record || record.schemaVersion !== 2 || record.renewal !== "mtime") {
      leaseFailure(FAILURE_INVALID);
    }
    if (record.owner !== workerData.owner) leaseFailure(FAILURE_OWNER_CHANGED);
    if (fs.existsSync(workerData.fencePath)) leaseFailure(FAILURE_FENCED);
    const leaseDurationMs = Number(record.leaseDurationMs);
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) leaseFailure(FAILURE_INVALID);
    if (after.mtimeMs + leaseDurationMs <= Date.now()) leaseFailure(FAILURE_EXPIRED);
    const renewedAt = new Date(Math.max(Date.now(), Math.ceil(after.mtimeMs) + 1));
    if (workerData.testFault !== "mtime-not-advance") {
      fs.futimesSync(descriptor, renewedAt, renewedAt);
    }
    const renewed = fs.fstatSync(descriptor);
    if (!(renewed.mtimeMs > after.mtimeMs)) leaseFailure(FAILURE_INVALID);
    if (renewed.mtimeMs + leaseDurationMs <= Date.now()) leaseFailure(FAILURE_EXPIRED);
    const current = fs.statSync(workerData.lockPath);
    if (renewed.dev !== current.dev || renewed.ino !== current.ino) {
      leaseFailure(FAILURE_OWNER_CHANGED);
    }
    const currentRecord = parseRecord(fs.readFileSync(workerData.lockPath, "utf8"));
    if (currentRecord?.owner !== workerData.owner) leaseFailure(FAILURE_OWNER_CHANGED);
    Atomics.add(control, COUNT_INDEX, 1);
  } catch (error) {
    failure = error && Number.isInteger(error.leaseFailure)
      ? Number(error.leaseFailure)
      : error && error.code === "ENOENT" ? FAILURE_MISSING : FAILURE_IO;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { failure ||= FAILURE_IO; }
    }
  }
  return failure ? fail(failure) : true;
}

try {
  if (renew()) {
    publishStatus(ACTIVE);
    while (Atomics.load(control, STOP_INDEX) === 0) {
      Atomics.wait(control, STOP_INDEX, 0, workerData.intervalMs);
      if (Atomics.load(control, STOP_INDEX) !== 0) break;
      if (!renew()) break;
    }
    if (Atomics.load(control, STATUS_INDEX) === ACTIVE && renew()) publishStatus(STOPPED);
  }
} catch {
  fail(FAILURE_IO);
}
`;

type LeaseRecord = {
  schemaVersion?: number;
  kind?: "plan_storage_lease" | "plan_storage_candidate" | "plan_storage_reclaim_fence";
  owner?: string;
  host?: string;
  pid?: number;
  createdAt?: number;
  expiresAt?: number;
  leaseDurationMs?: number;
  renewal?: "mtime";
};

type LeaseFileSnapshot = {
  raw: string;
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
};

export type PlanStorageLease = Readonly<{
  roleDir: string;
  planId: string;
  storageId: string;
  lockPath: string;
  owner: string;
  [leaseBrand]: true;
}>;

export type PlanStorageSyncLeaseOptions = Readonly<{
  /** May shorten, but never lengthen, the production heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Test-only fault injection for proving that an ineffective timestamp renewal fails closed. */
  testFault?: "mtime-not-advance";
}>;

type SyncLeaseHeartbeat = Readonly<{
  assertHealthy: (phase?: string) => void;
  stop: () => void;
}>;

type ActiveSyncLease = Readonly<{
  lease: PlanStorageLease;
  heartbeat: SyncLeaseHeartbeat;
}>;

const activeSyncLeases = new Map<string, ActiveSyncLease>();
const activeLeaseHeartbeats = new WeakMap<PlanStorageLease, SyncLeaseHeartbeat>();

function syncHeartbeatInterval(options: PlanStorageSyncLeaseOptions): number {
  const requested = Number(options.heartbeatIntervalMs);
  if (!Number.isFinite(requested) || requested <= 0) return PLAN_LOCK_HEARTBEAT_MS;
  return Math.min(PLAN_LOCK_HEARTBEAT_MS, Math.max(10, Math.floor(requested)));
}

function heartbeatFailure(lockPath: string, failure: number, phase: string): Error & { code: string } {
  const detail = new Map<number, string>([
    [1, "lock file disappeared"],
    [2, "lease record became invalid or unstable"],
    [3, "lease ownership changed"],
    [4, "lease was fenced for reclamation"],
    [5, "lease expired before renewal"],
    [6, "heartbeat I/O failed"]
  ]).get(failure) ?? "heartbeat worker did not confirm ownership";
  return Object.assign(new Error(
    `Plan storage lease lost during ${phase}: ${detail} (${path.basename(lockPath)}).`
  ), {
    code: "PLAN_STORAGE_LEASE_LOST"
  });
}

function waitForHeartbeatTransition(control: Int32Array, expected: number): number {
  const deadline = Date.now() + SYNC_HEARTBEAT_WAIT_TIMEOUT_MS;
  let status = Atomics.load(control, SYNC_HEARTBEAT_STATUS_INDEX);
  while (status === expected) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return status;
    Atomics.wait(control, SYNC_HEARTBEAT_STATUS_INDEX, expected, Math.min(remaining, 250));
    status = Atomics.load(control, SYNC_HEARTBEAT_STATUS_INDEX);
  }
  return status;
}

function startSyncLeaseHeartbeat(
  lockPath: string,
  owner: string,
  options: PlanStorageSyncLeaseOptions
): SyncLeaseHeartbeat {
  const control = new Int32Array(new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * SYNC_HEARTBEAT_CONTROL_WORDS
  ));
  const worker = new Worker(SYNC_LEASE_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: {
      control: control.buffer,
      fencePath: reclaimFencePath(lockPath),
      intervalMs: syncHeartbeatInterval(options),
      lockPath,
      owner,
      testFault: options.testFault
    }
  });
  worker.unref();
  worker.on("error", () => undefined);

  const startupStatus = waitForHeartbeatTransition(control, SYNC_HEARTBEAT_STARTING);
  if (startupStatus !== SYNC_HEARTBEAT_ACTIVE) {
    Atomics.store(control, SYNC_HEARTBEAT_STOP_INDEX, 1);
    Atomics.notify(control, SYNC_HEARTBEAT_STOP_INDEX);
    void worker.terminate().catch(() => undefined);
    throw heartbeatFailure(
      lockPath,
      Atomics.load(control, SYNC_HEARTBEAT_FAILURE_INDEX),
      startupStatus === SYNC_HEARTBEAT_STARTING ? "heartbeat startup" : "initial renewal"
    );
  }

  let stopped = false;
  const assertHealthy = (phase = "transaction"): void => {
    if (Atomics.load(control, SYNC_HEARTBEAT_STATUS_INDEX) !== SYNC_HEARTBEAT_ACTIVE) {
      throw heartbeatFailure(
        lockPath,
        Atomics.load(control, SYNC_HEARTBEAT_FAILURE_INDEX),
        phase
      );
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    Atomics.store(control, SYNC_HEARTBEAT_STOP_INDEX, 1);
    Atomics.notify(control, SYNC_HEARTBEAT_STOP_INDEX);
    const status = waitForHeartbeatTransition(control, SYNC_HEARTBEAT_ACTIVE);
    if (status !== SYNC_HEARTBEAT_STOPPED) {
      void worker.terminate().catch(() => undefined);
      throw heartbeatFailure(
        lockPath,
        Atomics.load(control, SYNC_HEARTBEAT_FAILURE_INDEX),
        status === SYNC_HEARTBEAT_ACTIVE ? "final renewal timeout" : "final renewal"
      );
    }
  };
  return Object.freeze({ assertHealthy, stop });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException).code || "");
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || (process.platform === "win32" && code === "EPERM");
}

function recordFor(
  kind: NonNullable<LeaseRecord["kind"]>,
  owner: string,
  leaseDurationMs: number
): LeaseRecord {
  const createdAt = Date.now();
  return {
    schemaVersion: 2,
    kind,
    owner,
    host: os.hostname(),
    pid: process.pid,
    createdAt,
    expiresAt: createdAt + leaseDurationMs,
    leaseDurationMs,
    renewal: "mtime"
  };
}

function parseLeaseRecord(raw: string): LeaseRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as LeaseRecord : null;
  } catch {
    return null;
  }
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino;
}

function snapshotFrom(raw: string, stat: fs.Stats): LeaseFileSnapshot {
  return { raw, mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino };
}

function sameSnapshot(left: LeaseFileSnapshot, right: LeaseFileSnapshot): boolean {
  return left.raw === right.raw
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino;
}

function readStableSnapshotSync(filePath: string): LeaseFileSnapshot | null {
  try {
    const before = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const after = fs.statSync(filePath);
    return sameStat(before, after) ? snapshotFrom(raw, after) : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function readStableOwnedSnapshotSync(filePath: string, owner: string): LeaseFileSnapshot | null {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = readStableSnapshotSync(filePath);
    if (snapshot && parseLeaseRecord(snapshot.raw)?.owner === owner) return snapshot;
    if (!snapshot && fs.existsSync(filePath) && attempt < 4) {
      Atomics.wait(lockWaitBuffer, 0, 0, 1);
      continue;
    }
    return snapshot;
  }
  return null;
}

async function readStableSnapshot(filePath: string): Promise<LeaseFileSnapshot | null> {
  try {
    const before = await fs.promises.stat(filePath);
    const raw = await fs.promises.readFile(filePath, "utf8");
    const after = await fs.promises.stat(filePath);
    return sameStat(before, after) ? snapshotFrom(raw, after) : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function readLeaseMetadata(lockPath: string): LeaseRecord | null {
  try {
    return parseLeaseRecord(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function sameHost(record: LeaseRecord): boolean {
  return typeof record.host === "string"
    && record.host.toLocaleLowerCase("en-US") === os.hostname().toLocaleLowerCase("en-US");
}

function sameHostProcessAlive(record: LeaseRecord): boolean | null {
  if (!sameHost(record) || !Number.isInteger(record.pid) || Number(record.pid) <= 0) return null;
  try {
    process.kill(Number(record.pid), 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    return null;
  }
}

function isRecoverableSnapshot(snapshot: LeaseFileSnapshot, now = Date.now()): boolean {
  const record = parseLeaseRecord(snapshot.raw);
  if (!record?.owner || !record.host) return false;
  const localProcessAlive = sameHostProcessAlive(record);
  if (localProcessAlive !== null) return localProcessAlive === false;
  if (sameHost(record)) return false;
  if (record.schemaVersion !== 2 || record.renewal !== "mtime") return false;
  if (!Number.isFinite(record.expiresAt) || !Number.isFinite(record.leaseDurationMs)) return false;
  const leaseDurationMs = Number(record.leaseDurationMs);
  if (leaseDurationMs < PLAN_LOCK_HEARTBEAT_MS || leaseDurationMs > 24 * 60 * 60 * 1_000) return false;
  return Number(record.expiresAt) <= now && snapshot.mtimeMs + leaseDurationMs <= now;
}

function isRecoverableUnpublishedSnapshot(snapshot: LeaseFileSnapshot, now = Date.now()): boolean {
  if (parseLeaseRecord(snapshot.raw)) return isRecoverableSnapshot(snapshot, now);
  return snapshot.mtimeMs + PLAN_LOCK_EXPIRY_MS <= now;
}

function writeRecordSync(filePath: string, record: LeaseRecord): void {
  const descriptor = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function writeRecord(filePath: string, record: LeaseRecord): Promise<void> {
  const descriptor = await fs.promises.open(filePath, "wx");
  try {
    await descriptor.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function reclaimUnpublishedFileSync(filePath: string): boolean {
  const before = readStableSnapshotSync(filePath);
  if (!before || !isRecoverableUnpublishedSnapshot(before)) return before === null;
  const after = readStableSnapshotSync(filePath);
  if (!after || !sameSnapshot(before, after)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function reclaimUnpublishedFile(filePath: string): Promise<boolean> {
  const before = await readStableSnapshot(filePath);
  if (!before || !isRecoverableUnpublishedSnapshot(before)) return before === null;
  const after = await readStableSnapshot(filePath);
  if (!after || !sameSnapshot(before, after)) return false;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function reclaimFencePath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

function acquireReclaimFenceSync(lockPath: string, owner: string): boolean {
  const fencePath = reclaimFencePath(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeRecordSync(fencePath, recordFor("plan_storage_reclaim_fence", owner, PLAN_LOCK_EXPIRY_MS));
      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (attempt > 0 || !reclaimUnpublishedFileSync(fencePath)) return false;
    }
  }
  return false;
}

async function acquireReclaimFence(lockPath: string, owner: string): Promise<boolean> {
  const fencePath = reclaimFencePath(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeRecord(fencePath, recordFor("plan_storage_reclaim_fence", owner, PLAN_LOCK_EXPIRY_MS));
      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (attempt > 0 || !await reclaimUnpublishedFile(fencePath)) return false;
    }
  }
  return false;
}

function releaseReclaimFenceSync(lockPath: string, owner: string): void {
  const fencePath = reclaimFencePath(lockPath);
  try {
    if (readLeaseMetadata(fencePath)?.owner === owner) fs.unlinkSync(fencePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function releaseReclaimFence(lockPath: string, owner: string): Promise<void> {
  const fencePath = reclaimFencePath(lockPath);
  try {
    const snapshot = await readStableSnapshot(fencePath);
    if (snapshot && parseLeaseRecord(snapshot.raw)?.owner === owner) await fs.promises.unlink(fencePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function reclaimOrphanCandidatesSync(lockPath: string): void {
  const directory = path.dirname(lockPath);
  const prefix = `.${path.basename(lockPath)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || (!name.endsWith(".candidate") && !name.endsWith(".stale"))) continue;
    reclaimUnpublishedFileSync(path.join(directory, name));
  }
}

async function reclaimOrphanCandidates(lockPath: string): Promise<void> {
  const directory = path.dirname(lockPath);
  const prefix = `.${path.basename(lockPath)}.`;
  for (const name of await fs.promises.readdir(directory)) {
    if (!name.startsWith(prefix) || (!name.endsWith(".candidate") && !name.endsWith(".stale"))) continue;
    await reclaimUnpublishedFile(path.join(directory, name));
  }
}

function replaceRecoverableLockSync(lockPath: string, candidatePath: string, owner: string): boolean {
  const observed = readStableSnapshotSync(lockPath);
  if (!observed || !isRecoverableSnapshot(observed)) return false;
  const fenceOwner = `${owner}:reclaim`;
  if (!acquireReclaimFenceSync(lockPath, fenceOwner)) return false;
  const stalePath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.stale`);
  let staleLinked = false;
  let detached = false;
  let published = false;
  try {
    const checked = readStableSnapshotSync(lockPath);
    if (!checked || !sameSnapshot(observed, checked) || !isRecoverableSnapshot(checked)) return false;
    // Rename to an unused name: SMB rejects overwrite and can keep an unlinked
    // name delete-pending. Preserve the old inode under the reclaim fence, then
    // publish exclusively so a late contender can never be overwritten.
    fs.renameSync(lockPath, stalePath);
    staleLinked = true;
    detached = true;
    const linked = readStableSnapshotSync(stalePath);
    if (!linked || !sameSnapshot(checked, linked)) {
      throw new Error(`Plan storage stale lease renewed during fencing (${path.basename(lockPath)}).`);
    }
    fs.linkSync(candidatePath, lockPath);
    published = true;
    const fenced = readStableSnapshotSync(stalePath);
    if (!fenced || !sameSnapshot(checked, fenced)) {
      throw new Error(`Plan storage stale lease renewed during fencing (${path.basename(lockPath)}).`);
    }
    if (readLeaseMetadata(lockPath)?.owner !== owner) {
      throw new Error(`Plan storage stale-lease fencing lost its candidate (${path.basename(lockPath)}).`);
    }
    detached = false;
    return true;
  } finally {
    try {
      if (detached) {
        // On renewal/publication failure restore without replacing another owner.
        // If restoration fails, retain the stale inode as recovery evidence.
        if (published && readLeaseMetadata(lockPath)?.owner === owner) fs.unlinkSync(lockPath);
        fs.linkSync(stalePath, lockPath);
        detached = false;
      }
      if (staleLinked) {
        try { fs.unlinkSync(stalePath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
    } finally {
      releaseReclaimFenceSync(lockPath, fenceOwner);
    }
  }
}

async function replaceRecoverableLock(lockPath: string, candidatePath: string, owner: string): Promise<boolean> {
  const observed = await readStableSnapshot(lockPath);
  if (!observed || !isRecoverableSnapshot(observed)) return false;
  const fenceOwner = `${owner}:reclaim`;
  if (!await acquireReclaimFence(lockPath, fenceOwner)) return false;
  const stalePath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.stale`);
  let staleLinked = false;
  let detached = false;
  let published = false;
  try {
    const checked = await readStableSnapshot(lockPath);
    if (!checked || !sameSnapshot(observed, checked) || !isRecoverableSnapshot(checked)) return false;
    // Rename to an unused name: SMB rejects overwrite and can keep an unlinked
    // name delete-pending. Preserve the old inode under the reclaim fence, then
    // publish exclusively so a late contender can never be overwritten.
    await fs.promises.rename(lockPath, stalePath);
    staleLinked = true;
    detached = true;
    const linked = await readStableSnapshot(stalePath);
    if (!linked || !sameSnapshot(checked, linked)) {
      throw new Error(`Plan storage stale lease renewed during fencing (${path.basename(lockPath)}).`);
    }
    await fs.promises.link(candidatePath, lockPath);
    published = true;
    const fenced = await readStableSnapshot(stalePath);
    if (!fenced || !sameSnapshot(checked, fenced)) {
      throw new Error(`Plan storage stale lease renewed during fencing (${path.basename(lockPath)}).`);
    }
    if (readLeaseMetadata(lockPath)?.owner !== owner) {
      throw new Error(`Plan storage stale-lease fencing lost its candidate (${path.basename(lockPath)}).`);
    }
    detached = false;
    return true;
  } finally {
    try {
      if (detached) {
        // On renewal/publication failure restore without replacing another owner.
        // If restoration fails, retain the stale inode as recovery evidence.
        if (published && readLeaseMetadata(lockPath)?.owner === owner) await fs.promises.unlink(lockPath);
        await fs.promises.link(stalePath, lockPath);
        detached = false;
      }
      if (staleLinked) {
        try { await fs.promises.unlink(stalePath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
    } finally {
      await releaseReclaimFence(lockPath, fenceOwner);
    }
  }
}

function releaseOwnedLease(lockPath: string, owner: string): void {
  const before = readStableSnapshotSync(lockPath);
  if (!before || parseLeaseRecord(before.raw)?.owner !== owner) return;
  const fenceOwner = `${owner}:release`;
  if (!acquireReclaimFenceSync(lockPath, fenceOwner)) return;
  const releasedPath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.stale`);
  let moved = false;
  try {
    const checked = readStableSnapshotSync(lockPath);
    if (!checked || !sameSnapshot(before, checked) || parseLeaseRecord(checked.raw)?.owner !== owner) return;
    fs.renameSync(lockPath, releasedPath);
    moved = true;
    const released = readStableSnapshotSync(releasedPath);
    if (!released || !sameSnapshot(checked, released)) {
      fs.renameSync(releasedPath, lockPath);
      moved = false;
      return;
    }
    fs.unlinkSync(releasedPath);
    moved = false;
  } finally {
    if (moved && !fs.existsSync(lockPath)) fs.renameSync(releasedPath, lockPath);
    releaseReclaimFenceSync(lockPath, fenceOwner);
  }
}

export function planStorageLeasePath(roleDir: string, planId: string): string {
  const collisionId = canonicalPlanStorageCollisionKey(planId);
  return path.join(roleDir, "plans", ".locks", `${sha256(collisionId).slice(0, 32)}.lock`);
}

function createLease(roleDir: string, planId: string, lockPath: string, owner: string): PlanStorageLease {
  return Object.freeze({
    roleDir: path.resolve(roleDir),
    planId: canonicalLogicalPlanId(planId),
    storageId: canonicalPlanStorageKey(planId),
    lockPath,
    owner,
    [leaseBrand]: true as const
  });
}

export function assertPlanStorageLeaseOwner(lease: PlanStorageLease): void {
  if (!lease || lease[leaseBrand] !== true) throw new Error("A repository-issued plan storage lease is required.");
  const heartbeat = activeLeaseHeartbeats.get(lease);
  heartbeat?.assertHealthy("repository checkpoint");
  if (fs.existsSync(reclaimFencePath(lease.lockPath))) {
    throw heartbeatFailure(lease.lockPath, 4, "repository checkpoint");
  }
  const snapshot = readStableOwnedSnapshotSync(lease.lockPath, lease.owner);
  const record = snapshot && parseLeaseRecord(snapshot.raw);
  if (!snapshot || record?.owner !== lease.owner) {
    throw heartbeatFailure(lease.lockPath, 3, "repository checkpoint");
  }
  if (record.schemaVersion === 2 && record.renewal === "mtime"
    && Number.isFinite(record.leaseDurationMs)
    && snapshot.mtimeMs + Number(record.leaseDurationMs) <= Date.now()) {
    throw heartbeatFailure(lease.lockPath, 5, "repository checkpoint");
  }
  heartbeat?.assertHealthy("repository checkpoint");
  if (fs.existsSync(reclaimFencePath(lease.lockPath))) {
    throw heartbeatFailure(lease.lockPath, 4, "repository checkpoint");
  }
}

export function requireCurrentPlanStorageLease(roleDir: string, planId: string): PlanStorageLease {
  const logicalPlanId = canonicalLogicalPlanId(planId);
  const lockPath = planStorageLeasePath(roleDir, logicalPlanId);
  const active = activeSyncLeases.get(lockPath);
  if (!active) {
    throw new Error(
      `A current plan storage lease is required for this repository mutation (${path.basename(lockPath)}).`
    );
  }
  if (active.lease.planId !== logicalPlanId) {
    throw new Error(`Plan storage identity collision: ${logicalPlanId} shares a lease with ${active.lease.planId}`);
  }
  active.heartbeat.assertHealthy("repository checkpoint");
  assertPlanStorageLeaseOwner(active.lease);
  return active.lease;
}

export function withPlanStorageLease<T>(
  roleDir: string,
  planId: string,
  action: (lease: PlanStorageLease) => T,
  options: PlanStorageSyncLeaseOptions = {}
): T {
  const logicalPlanId = canonicalLogicalPlanId(planId);
  const lockPath = planStorageLeasePath(roleDir, logicalPlanId);
  if (activeSyncLeases.has(lockPath)) {
    throw new Error(
      `Re-entrant plan storage lock is forbidden; call an under-lease repository primitive (${path.basename(lockPath)}).`
    );
  }
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  reclaimOrphanCandidatesSync(lockPath);
  const candidatePath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.candidate`);
  writeRecordSync(candidatePath, recordFor("plan_storage_lease", owner, PLAN_LOCK_EXPIRY_MS));
  const deadline = Date.now() + PLAN_LOCK_TIMEOUT_MS;
  let acquired = false;
  try {
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for plan storage lock (${path.basename(lockPath)}).`);
      }
      if (fs.existsSync(reclaimFencePath(lockPath))) {
        reclaimUnpublishedFileSync(reclaimFencePath(lockPath));
        Atomics.wait(lockWaitBuffer, 0, 0, 10);
        continue;
      }
      try {
        fs.linkSync(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        if (replaceRecoverableLockSync(lockPath, candidatePath, owner)) {
          acquired = true;
          break;
        }
        Atomics.wait(lockWaitBuffer, 0, 0, 10);
      }
    }
  } finally {
    try {
      fs.unlinkSync(candidatePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        if (acquired) releaseOwnedLease(lockPath, owner);
        throw error;
      }
    }
  }
  const lease = createLease(roleDir, logicalPlanId, lockPath, owner);
  let heartbeat: SyncLeaseHeartbeat | undefined;
  try {
    heartbeat = startSyncLeaseHeartbeat(lockPath, owner, options);
    activeLeaseHeartbeats.set(lease, heartbeat);
    activeSyncLeases.set(lockPath, Object.freeze({ lease, heartbeat }));
    assertPlanStorageLeaseOwner(lease);
    const result = action(lease);
    heartbeat.assertHealthy();
    assertPlanStorageLeaseOwner(lease);
    return result;
  } finally {
    const finalizationErrors: unknown[] = [];
    try {
      heartbeat?.stop();
    } catch (error) {
      finalizationErrors.push(error);
    }
    activeSyncLeases.delete(lockPath);
    activeLeaseHeartbeats.delete(lease);
    try {
      releaseOwnedLease(lockPath, owner);
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length === 1) throw finalizationErrors[0];
    if (finalizationErrors.length > 1) {
      const aggregate = new AggregateError(
        finalizationErrors,
        `Plan storage lease finalization failed (${path.basename(lockPath)}).`
      );
      if (finalizationErrors.some(error => (
        error instanceof Error && (error as Error & { code?: string }).code === "PLAN_STORAGE_LEASE_LOST"
      ))) {
        Object.assign(aggregate, { code: "PLAN_STORAGE_LEASE_LOST" });
      }
      throw aggregate;
    }
  }
}

export async function withPlanStorageLeaseAsync<T>(
  roleDir: string,
  planId: string,
  action: (lease: PlanStorageLease) => Promise<T>,
  options: PlanStorageSyncLeaseOptions = {}
): Promise<T> {
  const logicalPlanId = canonicalLogicalPlanId(planId);
  const lockPath = planStorageLeasePath(roleDir, logicalPlanId);
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  await reclaimOrphanCandidates(lockPath);
  const candidatePath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.candidate`);
  await writeRecord(candidatePath, recordFor("plan_storage_lease", owner, PLAN_LOCK_EXPIRY_MS));
  const deadline = Date.now() + PLAN_LOCK_TIMEOUT_MS;
  let acquired = false;
  try {
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for plan storage lock (${path.basename(lockPath)}).`);
      }
      try {
        await fs.promises.stat(reclaimFencePath(lockPath));
        await reclaimUnpublishedFile(reclaimFencePath(lockPath));
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      try {
        await fs.promises.link(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        if (await replaceRecoverableLock(lockPath, candidatePath, owner)) {
          acquired = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    try {
      await fs.promises.unlink(candidatePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        if (acquired) releaseOwnedLease(lockPath, owner);
        throw error;
      }
    }
  }
  const lease = createLease(roleDir, logicalPlanId, lockPath, owner);
  let heartbeat: SyncLeaseHeartbeat | undefined;
  try {
    // The action may synchronously block this event loop while scanning or
    // publishing storage. Keep renewal in the independent Worker shared with
    // synchronous transactions so ownership, fence, inode, deadline, and
    // post-futimes mtime checks continue throughout that stall.
    heartbeat = startSyncLeaseHeartbeat(lockPath, owner, options);
    activeLeaseHeartbeats.set(lease, heartbeat);
    assertPlanStorageLeaseOwner(lease);
    const result = await action(lease);
    heartbeat.assertHealthy();
    assertPlanStorageLeaseOwner(lease);
    return result;
  } finally {
    const finalizationErrors: unknown[] = [];
    try {
      heartbeat?.stop();
    } catch (error) {
      finalizationErrors.push(error);
    }
    activeLeaseHeartbeats.delete(lease);
    try {
      releaseOwnedLease(lockPath, owner);
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length === 1) throw finalizationErrors[0];
    if (finalizationErrors.length > 1) {
      const aggregate = new AggregateError(
        finalizationErrors,
        `Plan storage lease finalization failed (${path.basename(lockPath)}).`
      );
      if (finalizationErrors.some(error => (
        error instanceof Error && (error as Error & { code?: string }).code === "PLAN_STORAGE_LEASE_LOST"
      ))) {
        Object.assign(aggregate, { code: "PLAN_STORAGE_LEASE_LOST" });
      }
      throw aggregate;
    }
  }
}
