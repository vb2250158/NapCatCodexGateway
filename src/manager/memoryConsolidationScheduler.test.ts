import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConsolidationScheduler } from "./memoryConsolidationScheduler.js";

test("removed schedule targets no longer poison the failure summary", async () => {
  let enabled = true;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => enabled ? [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "/a" }] : [],
    requestDueRun: () => { throw new Error("offline"); },
    deliver: () => {},
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {}
  });
  await scheduler.runOnce();
  assert.equal(scheduler.failureSummary().backoff, 1);
  enabled = false;
  await scheduler.runOnce();
  assert.deepEqual(scheduler.failureSummary(), { backoff: 0, incidents: 0 });
  await scheduler.stop();
});

test("memory consolidation scheduler delivers a due run once and schedules the next future deadline", async () => {
  const delivered: string[] = [];
  const deadlines: number[] = [];
  let requestedRunId: string | undefined = "run-due";

  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [
      { gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "C:/roles/a" },
      { gatewayId: "route-a-duplicate", roleId: "role-a", roleKey: "role-a", roleDir: "C:/roles/a" },
      { gatewayId: "route-b", roleId: "role-b", roleKey: "role-b", roleDir: "C:/roles/b" }
    ],
    requestDueRun: target => target.roleKey === "role-a" && requestedRunId
      ? { runId: requestedRunId, revision: `revision:${requestedRunId}` }
      : null,
    nextTriggerAt: target => target.roleKey === "role-b" ? 20_000 : undefined,
    deliver: async (_target, run) => { delivered.push(run.runId); },
    scheduleDeadline: (_callback, delayMs) => {
      deadlines.push(delayMs);
      return { unref() {} } as NodeJS.Timeout;
    },
    clearDeadline: () => {},
    now: () => 10_000
  });

  await scheduler.runOnce();
  await scheduler.runOnce();

  assert.deepEqual(delivered, ["run-due"]);
  assert.deepEqual(deadlines, [10_000, 10_000]);

  requestedRunId = "run-next";
  scheduler.noteRunCompleted("run-due");
  await scheduler.runOnce();
  assert.deepEqual(delivered, ["run-due", "run-next"]);
});

test("memory consolidation scheduler retries a run after delivery failure", async () => {
  let attempts = 0;
  let now = 10_000;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "C:/roles/a" }],
    requestDueRun: () => ({ runId: "run-due", revision: "revision:run-due" }),
    nextTriggerAt: () => undefined,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Desktop unavailable");
    },
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {},
    now: () => now,
    retryDelayMs: 1_000
  });

  await scheduler.runOnce();
  now += 1_000;
  await scheduler.runOnce();

  assert.equal(attempts, 2);
});

test("consecutive delivery failures accumulate backoff until a successful target attempt resets it", async () => {
  let now = 10_000;
  let attempts = 0;
  let failDelivery = true;
  const reportedFailures: number[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "/a" }],
    requestDueRun: () => null,
    nextTriggerAt: () => undefined,
    evaluate: async () => ({ pending: { runId: "run-due", revision: "revision:run-due" } }),
    deliver: async () => {
      attempts += 1;
      if (failDelivery) throw new Error("desktop delivery unavailable");
    },
    retryDelayMs: 1_000,
    maximumRetryDelayMs: 4_000,
    incidentThreshold: 3,
    now: () => now,
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {},
    onError: (_target, _error, circuit) => {
      reportedFailures.push(circuit.snapshot.consecutiveFailures);
    }
  });

  await scheduler.runOnce();
  assert.equal(scheduler.failureSummary().nextRetryAt, 11_000);
  now = 11_000;
  await scheduler.runOnce();
  assert.equal(scheduler.failureSummary().nextRetryAt, 13_000);
  now = 13_000;
  await scheduler.runOnce();

  assert.equal(attempts, 3);
  assert.deepEqual(reportedFailures, [1, 3]);
  assert.deepEqual(scheduler.failureSummary(), {
    backoff: 0,
    incidents: 1,
    nextRetryAt: 17_000
  });

  failDelivery = false;
  now = 17_000;
  await scheduler.runOnce();
  assert.equal(attempts, 4);
  assert.deepEqual(scheduler.failureSummary(), { backoff: 0, incidents: 0 });
});

test("memory consolidation scheduler does not redeliver a run already accepted before Manager restart", async () => {
  let attempts = 0;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "C:/roles/a" }],
    requestDueRun: () => ({ runId: "run-delivered", revision: "revision:run-delivered", delivered: true }),
    nextTriggerAt: () => undefined,
    deliver: async () => { attempts += 1; },
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {}
  });

  await scheduler.runOnce();

  assert.equal(attempts, 0);
});

test("memory consolidation failures back off exponentially and open one incident", async () => {
  let now = 10_000;
  const deadlines: number[] = [];
  const reports: number[] = [];
  const incidents: string[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "//nas/roles/a" }],
    requestDueRun: () => null,
    nextTriggerAt: () => undefined,
    evaluate: async () => { throw new Error("NAS unavailable"); },
    deliver: () => {},
    retryDelayMs: 1_000,
    maximumRetryDelayMs: 4_000,
    incidentThreshold: 3,
    now: () => now,
    scheduleDeadline: (_callback, delayMs) => {
      deadlines.push(delayMs);
      return { unref() {} } as NodeJS.Timeout;
    },
    clearDeadline: () => {},
    onError: (_target, _error, circuit) => reports.push(circuit.snapshot.consecutiveFailures),
    onIncident: (_target, _error, circuit) => incidents.push(circuit.snapshot.incidentId || "")
  });

  await scheduler.runOnce();
  now += 1_000;
  await scheduler.runOnce();
  now += 2_000;
  await scheduler.runOnce();
  now += 4_000;
  await scheduler.runOnce();

  assert.deepEqual(deadlines, [1_000, 2_000, 4_000, 4_000]);
  assert.deepEqual(reports, [1, 3, 4]);
  assert.equal(incidents.length, 1);
  assert.ok(incidents[0]);
});

test("memory consolidation skips attempts inside backoff and resumes after explicit repair", async () => {
  let now = 100;
  let evaluations = 0;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "//nas/roles/a" }],
    requestDueRun: () => null,
    nextTriggerAt: () => undefined,
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) throw new Error("NAS unavailable");
      return { pending: null };
    },
    deliver: () => {},
    retryDelayMs: 1_000,
    now: () => now,
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {}
  });

  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.equal(evaluations, 1);
  scheduler.resetFailure("role-a");
  await scheduler.runOnce();
  assert.equal(evaluations, 2);
});

test("a failed due delivery cannot be re-armed at zero by a past business trigger", async () => {
  const deadlines: number[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "/a" }],
    requestDueRun: () => ({ runId: "due", revision: "revision:due" }),
    nextTriggerAt: () => 1,
    deliver: async () => { throw new Error("worker unavailable"); },
    retryDelayMs: 1_000,
    now: () => 10_000,
    scheduleDeadline: (_callback, delayMs) => {
      deadlines.push(delayMs);
      return { unref() {} } as NodeJS.Timeout;
    },
    clearDeadline: () => {}
  });

  await scheduler.runOnce();
  assert.deepEqual(deadlines, [1_000]);
});

test("stop aborts a hung schedule evaluation and waits for bounded cleanup", async () => {
  let evaluationStarted = false;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "/a" }],
    requestDueRun: () => null,
    nextTriggerAt: () => undefined,
    evaluate: async (_target, signal) => {
      evaluationStarted = true;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { pending: null };
    },
    deliver: () => {}
  });

  scheduler.start();
  while (!evaluationStarted) await new Promise(resolve => setImmediate(resolve));
  await scheduler.stop();
});

test("memory consolidation scheduler can evaluate NAS-backed schedules asynchronously", async () => {
  let releaseEvaluation!: () => void;
  let evaluationStarted = false;
  const delivered: string[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleId: "role-a", roleKey: "role-a", roleDir: "//nas/roles/a" }],
    requestDueRun: () => { throw new Error("synchronous memory scan must not run"); },
    nextTriggerAt: () => { throw new Error("synchronous trigger scan must not run"); },
    evaluate: async () => {
      evaluationStarted = true;
      await new Promise<void>(resolve => { releaseEvaluation = resolve; });
      return { pending: { runId: "run-async", revision: "revision:run-async" }, nextTriggerAt: undefined };
    },
    deliver: async (_target, run) => { delivered.push(run.runId); }
  });

  const running = scheduler.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(evaluationStarted, true);
  assert.deepEqual(delivered, []);
  releaseEvaluation();
  await running;
  assert.deepEqual(delivered, ["run-async"]);
});


test("stop waits for the active delivery and prevents later targets from starting", async () => {
  let release!: () => void;
  const delivered: string[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [
      { gatewayId: "a", roleId: "a", roleKey: "a", roleDir: "/a" },
      { gatewayId: "b", roleId: "b", roleKey: "b", roleDir: "/b" }
    ],
    requestDueRun: target => ({ runId: `run-${target.gatewayId}`, revision: `revision:run-${target.gatewayId}` }),
    nextTriggerAt: () => undefined,
    deliver: async target => {
      delivered.push(target.gatewayId);
      await new Promise<void>(resolve => { release = resolve; });
    }
  });

  scheduler.start();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stop;
  assert.deepEqual(delivered, ["a"]);
});
