import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";
import {
  durableDeliveryReceiptPath,
  executeDurableDelivery,
  readDurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

const mainThreadBlock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr }));
  });
}

test("durable delivery recovery completes from accepted readback and reloads without replay", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-recovery-"));
  let sends = 0;
  const options = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "12345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); },
    recover: async () => ({ state: "completed" as const, result: { accepted: true } })
  };
  const first = await executeDurableDelivery(options);
  const reloaded = await executeDurableDelivery(options);
  assert.equal(first.state, "completed");
  assert.equal(reloaded.state, "completed");
  assert.equal(sends, 1);
  assert.equal(readDurableDeliveryReceipt(rootDir, options.namespace, options.deliveryId)?.state, "completed");
});

test("an active sending owner fences same-key recovery retries until the first delivery settles", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-active-owner-"));
  let releaseFirst!: (value: { memoryId: string }) => void;
  const firstResult = new Promise<{ memoryId: string }>(resolve => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let sends = 0;
  let recoveries = 0;
  const base = {
    rootDir,
    namespace: "storage-mutation-idempotency",
    deliveryId: "17345678-1234-4567-8123-123456789abc",
    payload: { roleId: "YeYu", task: { type: "recent_memory_create", input: { title: "one" } } },
    waitForCompletionMs: 0,
    executionLeaseMs: 100
  };
  const first = executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      firstStarted();
      return firstResult;
    },
    recover: async () => { recoveries += 1; return { state: "retry" as const }; }
  });
  await started;

  const concurrent = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      return { memoryId: "duplicate" };
    },
    recover: async () => { recoveries += 1; return { state: "retry" as const }; }
  });
  assert.equal(concurrent.state, "in_progress");
  assert.equal(sends, 1);
  assert.equal(recoveries, 0);

  releaseFirst({ memoryId: "only-record" });
  const completed = await first;
  const replay = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      return { memoryId: "duplicate" };
    }
  });
  assert.equal(completed.state, "completed");
  assert.equal(replay.state, "completed");
  assert.equal(sends, 1);
  if (replay.state === "completed") assert.deepEqual(replay.result, { memoryId: "only-record" });
});

test("durable delivery retries only once when authoritative readback says missing", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-missing-"));
  let sends = 0;
  const outcome = await executeDurableDelivery({
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "22345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    deliver: async () => {
      sends += 1;
      if (sends === 1) throw new Error("Desktop request timed out");
      return { accepted: true };
    },
    recover: async () => ({ state: "retry" as const })
  });
  assert.equal(outcome.state, "completed");
  assert.equal(sends, 2);
});

test("durable delivery keeps in-progress pending and uncertain terminal without replay", async () => {
  for (const state of ["in_progress", "uncertain"] as const) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-durable-${state}-`));
    let sends = 0;
    const outcome = await executeDurableDelivery({
      rootDir,
      namespace: "message-requirement-delivery",
      deliveryId: state === "in_progress" ? "32345678-1234-4567-8123-123456789abc" : "42345678-1234-4567-8123-123456789abc",
      payload: { batch: 1 },
      deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); },
      recover: async () => ({ state, reason: state })
    });
    assert.equal(outcome.state, state);
    assert.equal(sends, 1);
  }
});

test("a new instance authoritatively recovers an earlier sending receipt without replay", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-reload-sending-"));
  let sends = 0;
  const base = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "52345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    waitForCompletionMs: 0,
    deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); }
  };
  const pending = await executeDurableDelivery({
    ...base,
    recover: async () => ({ state: "in_progress" as const, reason: "still active" })
  });
  const recovered = await executeDurableDelivery({
    ...base,
    recover: async () => ({ state: "completed" as const, result: { accepted: true } })
  });
  assert.equal(pending.state, "in_progress");
  assert.equal(recovered.state, "completed");
  assert.equal(sends, 1);
});

test("a new instance retries an earlier sending receipt once after authoritative missing readback", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-reload-missing-"));
  let sends = 0;
  const base = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "62345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    waitForCompletionMs: 0
  };
  const pending = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      throw new Error("Desktop request timed out");
    },
    recover: async () => ({ state: "in_progress" as const, reason: "still active" })
  });
  const recovered = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      return { accepted: true };
    },
    recover: async () => ({ state: "retry" as const })
  });

  assert.equal(pending.state, "in_progress");
  assert.equal(recovered.state, "completed");
  assert.equal(sends, 2);
  assert.equal(readDurableDeliveryReceipt(rootDir, base.namespace, base.deliveryId)?.state, "completed");
});

test("existing uncertain receipts are recoverable only through the mutation opt-in", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-reload-uncertain-"));
  const base = {
    rootDir,
    namespace: "storage-mutation-idempotency",
    deliveryId: "72345678-1234-4567-8123-123456789abc",
    payload: { mutation: "one" }
  };
  await executeDurableDelivery({
    ...base,
    deliver: async () => { throw new Error("response lost after mutation"); },
    recover: async () => ({ state: "uncertain" as const, reason: "proof unavailable" })
  });
  let proofs = 0;
  const unchanged = await executeDurableDelivery({
    ...base,
    deliver: async () => ({ committed: true }),
    recover: async () => { proofs += 1; return { state: "completed" as const, result: { committed: true } }; }
  });
  assert.equal(unchanged.state, "uncertain");
  assert.equal(proofs, 0);

  const recovered = await executeDurableDelivery({
    ...base,
    deliver: async () => ({ committed: true }),
    recoverExistingUncertain: true,
    recover: async () => { proofs += 1; return { state: "completed" as const, result: { committed: true } }; }
  });
  assert.equal(recovered.state, "completed");
  assert.equal(proofs, 1);
  assert.equal(readDurableDeliveryReceipt(rootDir, base.namespace, base.deliveryId)?.state, "completed");
});

test("a proven non-committing CAS rejection releases its receipt for same-key retry", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-cas-retry-"));
  const base = {
    rootDir,
    namespace: "storage-mutation-idempotency",
    deliveryId: "82345678-1234-4567-8123-123456789abc",
    payload: { roleId: "YeYu", planId: "plan-one", task: { type: "plan_update", patch: { nextAction: "B" } } },
    retryableRejection: (result: { domain: string }) => result.domain === "rejected"
  };
  const rejected = await executeDurableDelivery({
    ...base,
    audit: { expectedRevision: "revision-a" },
    deliver: async () => ({ domain: "rejected", error: "STORAGE_MUTATION_REVISION_CONFLICT" })
  });
  assert.equal(rejected.state, "completed");
  assert.equal(readDurableDeliveryReceipt(rootDir, base.namespace, base.deliveryId), null);

  const committed = await executeDurableDelivery({
    ...base,
    audit: { expectedRevision: "revision-b" },
    deliver: async () => ({ domain: "committed", value: { nextAction: "B" } })
  });
  assert.equal(committed.state, "completed");
  assert.equal(readDurableDeliveryReceipt(rootDir, base.namespace, base.deliveryId)?.state, "completed");
});

test("an independent heartbeat fences a remote retry while the main thread is synchronously blocked", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-worker-heartbeat-"));
  const namespace = "storage-mutation-idempotency";
  const deliveryId = "92345678-1234-4567-8123-123456789abc";
  const payload = { roleId: "YeYu", mutation: "long-running" };
  const resultPath = path.join(rootDir, "contender-result.json");
  const duplicateMarker = path.join(rootDir, "duplicate-delivery.txt");
  const moduleUrl = new URL("./durableDeliveryIdempotency.ts", import.meta.url).href;
  const remoteHost = `${os.hostname()}-simulated-remote`;
  let heartbeatBefore = 0;
  let heartbeatAfter = 0;
  const contenderSource = `
    import fs from "node:fs";
    import os from "node:os";
    Object.defineProperty(os, "hostname", { configurable: true, value: () => ${JSON.stringify(remoteHost)} });
    const { executeDurableDelivery } = await import(${JSON.stringify(moduleUrl)});
    await new Promise(resolve => setTimeout(resolve, 650));
    const outcome = await executeDurableDelivery({
      rootDir: ${JSON.stringify(rootDir)},
      namespace: ${JSON.stringify(namespace)},
      deliveryId: ${JSON.stringify(deliveryId)},
      payload: ${JSON.stringify(payload)},
      waitForCompletionMs: 0,
      executionLeaseMs: 300,
      deliver: async () => {
        fs.writeFileSync(${JSON.stringify(duplicateMarker)}, "duplicate", "utf8");
        return { accepted: "duplicate" };
      },
      recover: async () => ({ state: "retry" })
    });
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(outcome), "utf8");
  `;
  let contenderCompletion: Promise<{ code: number | null; stderr: string }> | undefined;

  const first = executeDurableDelivery({
    rootDir,
    namespace,
    deliveryId,
    payload,
    executionLeaseMs: 300,
    deliver: async () => {
      const contender = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", contenderSource],
        { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] }
      );
      contenderCompletion = waitForChild(contender);
      heartbeatBefore = fs.statSync(durableDeliveryReceiptPath(rootDir, namespace, deliveryId)).mtimeMs;
      Atomics.wait(mainThreadBlock, 0, 0, 3_000);
      heartbeatAfter = fs.statSync(durableDeliveryReceiptPath(rootDir, namespace, deliveryId)).mtimeMs;
      const renewed = readDurableDeliveryReceipt(rootDir, namespace, deliveryId);
      assert.ok(heartbeatAfter > heartbeatBefore, "the Worker must advance the observed receipt mtime");
      assert.ok(Date.parse(String(renewed?.leaseExpiresAt || "")) > Date.now(), "the renewed lease must remain live");
      return { accepted: "owner" };
    }
  });

  const completed = await first;
  assert.ok(contenderCompletion, "the remote contender must start before the blocking operation");
  const contender = await contenderCompletion;
  assert.equal(contender.code, 0, contender.stderr);
  const contenderOutcome = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { state?: unknown };
  assert.equal(contenderOutcome.state, "in_progress");
  assert.equal(completed.state, "completed");
  assert.equal(fs.existsSync(duplicateMarker), false);
});

test("a replaced owner fences both completed and uncertain settlement without touching the replacement", async () => {
  for (const terminal of ["completed", "uncertain"] as const) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-durable-replaced-${terminal}-`));
    const namespace = "storage-mutation-idempotency";
    const deliveryId = terminal === "completed"
      ? "a2345678-1234-4567-8123-123456789abc"
      : "b2345678-1234-4567-8123-123456789abc";
    const payload = { roleId: "YeYu", terminal };
    let resolveDelivery!: (value: { accepted: boolean }) => void;
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<{ accepted: boolean }>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    let announceStarted!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const execution = executeDurableDelivery({
      rootDir,
      namespace,
      deliveryId,
      payload,
      executionLeaseMs: 300,
      deliver: async () => {
        announceStarted();
        return delivery;
      }
    });
    await started;

    const receiptPath = durableDeliveryReceiptPath(rootDir, namespace, deliveryId);
    const replacementRaw = withFileLockSync(`${receiptPath}.mutation.lock`, () => {
      const current = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
      const replacement = {
        ...current,
        state: "sending",
        updatedAt: new Date().toISOString(),
        executionId: `replacement-${terminal}`,
        ownerHost: `${os.hostname()}-replacement`,
        ownerPid: 424_242,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseDurationMs: 60_000,
        renewal: "mtime"
      };
      const raw = `${JSON.stringify(replacement)}\n`;
      atomicWriteFileSync(receiptPath, raw);
      return raw;
    });
    const replacementMtime = fs.statSync(receiptPath).mtimeMs;
    Atomics.wait(mainThreadBlock, 0, 0, 250);

    if (terminal === "completed") resolveDelivery({ accepted: true });
    else rejectDelivery(new Error("delivery result unavailable"));
    const outcome = await execution;

    assert.equal(outcome.state, "uncertain");
    assert.equal(fs.readFileSync(receiptPath, "utf8"), replacementRaw);
    assert.equal(fs.statSync(receiptPath).mtimeMs, replacementMtime);
    assert.equal(JSON.stringify(outcome).includes(rootDir), false);
    assert.equal(fs.readFileSync(receiptPath, "utf8").includes(rootDir), false);
  }
});

test("a contender that read an expired receipt under the mutation lock fences heartbeat revival", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-claim-linearization-"));
  const namespace = "storage-mutation-idempotency";
  const deliveryId = "d2345678-1234-4567-8123-123456789abc";
  const payload = { roleId: "YeYu", mutation: "claim-linearization" };
  const receiptPath = durableDeliveryReceiptPath(rootDir, namespace, deliveryId);
  const mutationLockPath = `${receiptPath}.mutation.lock`;
  const replacementExecutionId = "replacement-after-expired-read";
  let replacementRaw = "";

  const outcome = await executeDurableDelivery({
    rootDir,
    namespace,
    deliveryId,
    payload,
    executionLeaseMs: 300,
    deliver: async () => {
      replacementRaw = withFileLockSync(mutationLockPath, () => {
        const expired = new Date(Date.now() - 1_000);
        fs.utimesSync(receiptPath, expired, expired);
        const observed = readDurableDeliveryReceipt(rootDir, namespace, deliveryId);
        assert.ok(observed, "the contender must read the current sending receipt");
        assert.ok(
          Date.parse(String(observed.leaseExpiresAt || "")) <= Date.now(),
          "the contender must decide from an expired receipt while holding the mutation lock"
        );
        const expiredMtime = fs.statSync(receiptPath).mtimeMs;
        Atomics.wait(mainThreadBlock, 0, 0, 250);
        assert.equal(
          fs.statSync(receiptPath).mtimeMs,
          expiredMtime,
          "the old heartbeat must not revive a receipt after a contender has begun its claim decision"
        );
        const replacement = {
          ...observed,
          state: "sending",
          updatedAt: new Date().toISOString(),
          executionId: replacementExecutionId,
          ownerHost: `${os.hostname()}-replacement`,
          ownerPid: 424_243,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          leaseDurationMs: 60_000,
          renewal: "mtime"
        };
        const raw = `${JSON.stringify(replacement)}\n`;
        atomicWriteFileSync(receiptPath, raw);
        return raw;
      });
      return { accepted: "stale-owner" };
    }
  });

  assert.equal(outcome.state, "uncertain");
  assert.equal(fs.readFileSync(receiptPath, "utf8"), replacementRaw);
  assert.equal(readDurableDeliveryReceipt(rootDir, namespace, deliveryId)?.executionId, replacementExecutionId);
  assert.equal(fs.existsSync(mutationLockPath), false);
});

test("a stopped receipt heartbeat worker does not keep a completed child process alive", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-worker-shutdown-"));
  const moduleUrl = new URL("./durableDeliveryIdempotency.ts", import.meta.url).href;
  const source = `
    const { executeDurableDelivery } = await import(${JSON.stringify(moduleUrl)});
    const outcome = await executeDurableDelivery({
      rootDir: ${JSON.stringify(rootDir)},
      namespace: "storage-mutation-idempotency",
      deliveryId: "c2345678-1234-4567-8123-123456789abc",
      payload: { mutation: "worker-shutdown" },
      executionLeaseMs: 300,
      deliver: async () => ({ accepted: true })
    });
    if (outcome.state !== "completed") throw new Error("delivery did not complete");
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 }
  );

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readDurableDeliveryReceipt(
      rootDir,
      "storage-mutation-idempotency",
      "c2345678-1234-4567-8123-123456789abc"
    )?.state,
    "completed"
  );
});
