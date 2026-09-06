import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { atomicWriteFileSync } from "../../shared/filePersistence.js";
import {
  assertPlanStorageLeaseOwner,
  planStorageLeasePath,
  requireCurrentPlanStorageLease,
  withPlanStorageLease,
  withPlanStorageLeaseAsync
} from "./lease.js";

const synchronousWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(synchronousWaitBuffer, 0, 0, milliseconds);
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === "PLAN_STORAGE_LEASE_LOST";
}

function temporaryRole(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "roles", "YeYu");
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.ok(Number.isInteger(child.pid) && Number(child.pid) > 0);
  return Number(child.pid);
}

function writeLock(lockPath: string, record: Record<string, unknown>, ageMs = 0): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, "utf8");
  if (ageMs > 0) {
    const timestamp = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, timestamp, timestamp);
  }
}

function expiredRemoteRecord(owner: string): Record<string, unknown> {
  const createdAt = Date.now() - 120_000;
  return {
    schemaVersion: 2,
    kind: "plan_storage_lease",
    owner,
    host: `${os.hostname()}-remote`,
    pid: 1234,
    createdAt,
    expiresAt: createdAt + 60_000,
    leaseDurationMs: 60_000,
    renewal: "mtime"
  };
}

test("same-host dead PID lease is reclaimed only after stable content and mtime checks", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "dead-local-owner";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const stalePid = deadPid();
  const staleOwner = `${os.hostname()}:${stalePid}:stale`;
  writeLock(lockPath, { owner: staleOwner, host: os.hostname(), pid: stalePid });

  withPlanStorageLease(roleDir, planId, (lease) => {
    assert.notEqual(lease.owner, staleOwner);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, lease.owner);
  });

  assert.equal(fs.existsSync(lockPath), false);
});

test("expired remote heartbeat lease is atomically fenced and replaced", async (t) => {
  const roleDir = temporaryRole(t);
  const planId = "expired-remote-owner";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const staleOwner = "remote-host:4321:stale";
  writeLock(lockPath, expiredRemoteRecord(staleOwner), 120_000);

  await withPlanStorageLeaseAsync(roleDir, planId, async (lease) => {
    assert.notEqual(lease.owner, staleOwner);
    const current = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as Record<string, unknown>;
    assert.equal(current.owner, lease.owner);
    assert.equal(current.renewal, "mtime");
    assert.equal(current.leaseDurationMs, 60_000);
  });

  assert.equal(fs.existsSync(lockPath), false);
});

test("orphan candidate from a dead local process is reclaimed before acquisition", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "orphan-candidate";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const orphanPath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.orphan.candidate`);
  writeLock(orphanPath, {
    owner: `${os.hostname()}:dead:orphan`,
    host: os.hostname(),
    pid: deadPid(),
    createdAt: Date.now()
  });

  withPlanStorageLease(roleDir, planId, () => {
    assert.equal(fs.existsSync(orphanPath), false);
  });

  assert.equal(fs.existsSync(orphanPath), false);
});

test("an expired malformed reclaim fence cannot permanently block plan storage", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "malformed-reclaim-fence";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const fencePath = `${lockPath}.reclaim`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(fencePath, "", "utf8");
  const expired = new Date(Date.now() - 120_000);
  fs.utimesSync(fencePath, expired, expired);

  withPlanStorageLease(roleDir, planId, () => {
    assert.equal(fs.existsSync(fencePath), false);
  });

  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(fencePath), false);
});

test("a renewal during stale fencing restores the previous owner instead of deleting it", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "renewed-during-fence";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const staleOwner = "remote-host:9876:renewing";
  writeLock(lockPath, expiredRemoteRecord(staleOwner), 120_000);
  const originalLink = fs.linkSync;
  let injected = false;
  (fs as typeof fs & { linkSync: typeof fs.linkSync }).linkSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && path.resolve(String(destination)) === path.resolve(lockPath)
      && String(source).endsWith(".candidate") && !fs.existsSync(lockPath)) {
      injected = true;
      const renewed = new Date();
      const stale = fs.readdirSync(path.dirname(lockPath)).find(name => name.endsWith(".stale"));
      assert.ok(stale);
      fs.utimesSync(path.join(path.dirname(lockPath), stale), renewed, renewed);
    }
    return originalLink(source, destination);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => withPlanStorageLease(roleDir, planId, () => undefined),
      /renewed during fencing/
    );
  } finally {
    (fs as typeof fs & { linkSync: typeof fs.linkSync }).linkSync = originalLink;
  }

  assert.equal(injected, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, staleOwner);
  assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(lockPath)).filter((name) => name.endsWith(".candidate") || name.endsWith(".stale")),
    []
  );
});

test("a synchronous long-running holder renews while its event loop is blocked", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "sync-long-running-holder";
  const lockPath = planStorageLeasePath(roleDir, planId);

  withPlanStorageLease(roleDir, planId, (lease) => {
    const before = fs.statSync(lockPath).mtimeMs;
    waitSynchronously(200);
    const after = fs.statSync(lockPath).mtimeMs;
    assert.ok(after > before, `expected heartbeat mtime to advance beyond ${before}, received ${after}`);
    assert.ok(after + 60_000 > Date.now(), "expected the renewed mtime to derive a live lease deadline");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, lease.owner);
    assertPlanStorageLeaseOwner(lease);
  }, { heartbeatIntervalMs: 20 });

  assert.equal(fs.existsSync(lockPath), false);
});

test("a synchronous heartbeat fails closed when futimes does not advance the lease mtime", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "sync-mtime-not-advanced";
  const lockPath = planStorageLeasePath(roleDir, planId);

  assert.throws(
    () => withPlanStorageLease(roleDir, planId, () => undefined, {
      heartbeatIntervalMs: 10,
      testFault: "mtime-not-advance"
    }),
    isLeaseLost
  );

  assert.equal(fs.existsSync(lockPath), false);
});

test("an expired synchronous lease fails closed instead of being renewed after its deadline", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "sync-expired-holder";
  const lockPath = planStorageLeasePath(roleDir, planId);

  assert.throws(() => withPlanStorageLease(roleDir, planId, (lease) => {
    const expired = new Date(Date.now() - 61_000);
    fs.utimesSync(lockPath, expired, expired);
    assertPlanStorageLeaseOwner(lease);
  }), isLeaseLost);

  assert.equal(fs.existsSync(lockPath), false);
});

test("a synchronous holder reports concurrent lease loss and never releases the replacement owner", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "sync-concurrent-owner";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const replacementOwner = "replacement-host:4321:replacement";

  assert.throws(() => withPlanStorageLease(roleDir, planId, () => {
    const replacement = {
      ...(JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>),
      owner: replacementOwner,
      host: `${os.hostname()}-replacement`,
      pid: 4321
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, "utf8");
    waitSynchronously(100);
  }, { heartbeatIntervalMs: 10 }), isLeaseLost);

  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, replacementOwner);
});

test("a repository checkpoint observes synchronous heartbeat loss before another publication", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "sync-checkpoint-owner-loss";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const replacementOwner = "replacement-host:5432:checkpoint";
  let checkpointRejected = false;

  assert.throws(() => withPlanStorageLease(roleDir, planId, () => {
    const replacement = {
      ...(JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>),
      owner: replacementOwner,
      host: `${os.hostname()}-replacement`,
      pid: 5432
    };
    atomicWriteFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
    waitSynchronously(100);
    assert.throws(() => requireCurrentPlanStorageLease(roleDir, planId), error => {
      checkpointRejected = true;
      return isLeaseLost(error);
    });
  }, { heartbeatIntervalMs: 10 }), isLeaseLost);

  assert.equal(checkpointRejected, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, replacementOwner);
});

test("an asynchronous long-running holder renews while its event loop is blocked", async (t) => {
  const roleDir = temporaryRole(t);
  const planId = "async-long-running-holder";
  const lockPath = planStorageLeasePath(roleDir, planId);

  await withPlanStorageLeaseAsync(roleDir, planId, async (lease) => {
    const before = fs.statSync(lockPath).mtimeMs;
    waitSynchronously(200);
    const after = fs.statSync(lockPath).mtimeMs;
    assert.ok(after > before, `expected heartbeat mtime to advance beyond ${before}, received ${after}`);
    assert.ok(after + 60_000 > Date.now(), "expected the renewed mtime to derive a live lease deadline");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, lease.owner);
    assertPlanStorageLeaseOwner(lease);
  }, { heartbeatIntervalMs: 20 });

  assert.equal(fs.existsSync(lockPath), false);
});

test("an asynchronous holder fails closed and preserves an atomically replaced owner", async (t) => {
  const roleDir = temporaryRole(t);
  const planId = "async-replaced-owner";
  const lockPath = planStorageLeasePath(roleDir, planId);
  const replacementOwner = "replacement-host:8765:replacement";

  await assert.rejects(withPlanStorageLeaseAsync(roleDir, planId, async () => {
    const replacement = {
      ...(JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>),
      owner: replacementOwner,
      host: `${os.hostname()}-replacement`,
      pid: 8765
    };
    atomicWriteFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }, { heartbeatIntervalMs: 10 }), isLeaseLost);

  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, replacementOwner);
});

for (const asynchronous of [false, true]) {
  test(`stale lease publication avoids SMB rename-over-existing (${asynchronous ? "async" : "sync"})`, async (t) => {
    const roleDir = temporaryRole(t);
    const planId = "smb-stale";
    const lockPath = planStorageLeasePath(roleDir, planId);
    writeLock(lockPath, expiredRemoteRecord("old-owner"), 120_000);
    const rejectOverwrite = (source: fs.PathLike, destination: fs.PathLike) => {
      if (fs.existsSync(destination)) throw Object.assign(new Error("SMB overwrite denied"), { code: "EPERM" });
    };
    const renameSync = fs.renameSync;
    const rename = fs.promises.rename;
    t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
      rejectOverwrite(source, destination);
      return renameSync(source, destination);
    });
    t.mock.method(fs.promises, "rename", async (source: fs.PathLike, destination: fs.PathLike) => {
      rejectOverwrite(source, destination);
      return rename(source, destination);
    });
    let ran = false;
    if (asynchronous) await withPlanStorageLeaseAsync(roleDir, planId, async () => { ran = true; });
    else withPlanStorageLease(roleDir, planId, () => { ran = true; });
    assert.equal(ran, true);
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
  });

  test(`failed stale lease publication restores old owner (${asynchronous ? "async" : "sync"})`, async (t) => {
    const roleDir = temporaryRole(t);
    const planId = "failed-publication";
    const lockPath = planStorageLeasePath(roleDir, planId);
    writeLock(lockPath, expiredRemoteRecord("preserved-owner"), 120_000);
    const linkSync = fs.linkSync;
    const link = fs.promises.link;
    const injectFailure = (source: fs.PathLike, destination: fs.PathLike) => {
      if (String(source).endsWith(".candidate") && String(destination) === lockPath && !fs.existsSync(lockPath)) {
        throw Object.assign(new Error("publication denied"), { code: "EACCES" });
      }
    };
    t.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
      injectFailure(source, destination);
      return linkSync(source, destination);
    });
    t.mock.method(fs.promises, "link", async (source: fs.PathLike, destination: fs.PathLike) => {
      injectFailure(source, destination);
      return link(source, destination);
    });
    if (asynchronous) await assert.rejects(withPlanStorageLeaseAsync(roleDir, planId, async () => assert.fail("must not run")), /publication denied/);
    else assert.throws(() => withPlanStorageLease(roleDir, planId, () => assert.fail("must not run")), /publication denied/);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, "preserved-owner");
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
  });
}

test("a late contender is preserved when exclusive stale replacement loses publication", (t) => {
  const roleDir = temporaryRole(t);
  const planId = "late-contender";
  const lockPath = planStorageLeasePath(roleDir, planId);
  writeLock(lockPath, expiredRemoteRecord("previous-owner"), 120_000);
  const linkSync = fs.linkSync;
  let injected = false;
  t.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && String(source).endsWith(".candidate") && String(destination) === lockPath && !fs.existsSync(lockPath)) {
      injected = true;
      writeLock(lockPath, { owner: "late-contender", host: os.hostname(), pid: process.pid });
    }
    return linkSync(source, destination);
  });
  assert.throws(() => withPlanStorageLease(roleDir, planId, () => assert.fail("must not run")), { code: "EEXIST" });
  assert.equal(injected, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner, "late-contender");
  assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);
  const retained = fs.readdirSync(path.dirname(lockPath)).filter(name => name.endsWith(".stale"));
  assert.equal(retained.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(lockPath), retained[0]!), "utf8")).owner, "previous-owner");
});
