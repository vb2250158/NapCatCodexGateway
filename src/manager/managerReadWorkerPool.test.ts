import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import { PersonaSyncService } from "../personaSync.js";
import { appendPlanFeedback, createPlanFeedbackRecord } from "../planFeedback.js";
import { createPlan, createRecentMemory, listRecentMemories, publishedRolePlans } from "../roleKnowledge.js";
import { appendRolePanelTimelineMessageIfAbsent } from "../rolePanelTimeline.js";
import {
  ManagerReadWorkerError,
  ManagerReadWorkerPool,
  type ManagerReadWorkerChild
} from "./managerReadWorkerPool.js";
import { PerformanceStore } from "./performanceStore.js";

type FakeReadRequest = Readonly<{ requestId: string; task: unknown }>;

class FakeReadWorker extends EventEmitter implements ManagerReadWorkerChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly channel = { unref(): void {} };
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  private closed = false;

  constructor(
    readonly pid: number | undefined,
    private readonly onSend: (request: FakeReadRequest, worker: FakeReadWorker) => void,
    private readonly onKill: (
      signal: NodeJS.Signals | number | undefined,
      worker: FakeReadWorker
    ) => void = () => {}
  ) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.onSend(message as FakeReadRequest, this);
    callback?.(null);
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.onKill(signal, this);
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  unref(): void {}

  respond(request: FakeReadRequest, value: unknown): void {
    this.emit("message", { requestId: request.requestId, ok: true, value });
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function fakeReadTask(roleDir: string) {
  return { type: "role_memory_counts" as const, roleDir };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function voiceArchiveFixture(archiveCount = 8, entriesPerArchive = 500): string {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-read-worker-"));
  const conversationDir = path.join(roleDir, "conversation");
  const archiveDir = path.join(conversationDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "current.jsonl"), "", "utf8");
  const archives: Array<Record<string, unknown>> = [];
  let sequence = 1;
  for (let archiveIndex = 0; archiveIndex < archiveCount; archiveIndex += 1) {
    const firstSequence = sequence;
    const rows: string[] = [];
    for (let rowIndex = 0; rowIndex < entriesPerArchive; rowIndex += 1) {
      const time = Date.UTC(2026, 0, 1 + archiveIndex, 0, 0, rowIndex) / 1_000;
      rows.push(JSON.stringify({
        schemaVersion: 1,
        sequence,
        recordedAt: new Date(time * 1_000).toISOString(),
        time,
        direction: "inbound",
        adapter: "speech",
        kind: "asr",
        text: `voice-${sequence}`,
        voiceprintId: `voiceprint-${sequence % 4}`
      }));
      sequence += 1;
    }
    const lastSequence = sequence - 1;
    const file = `${firstSequence}~${lastSequence}.jsonl`;
    fs.writeFileSync(path.join(archiveDir, file), `${rows.join("\n")}\n`, "utf8");
    archives.push({
      file,
      startedAt: JSON.parse(rows[0]!).recordedAt,
      endedAt: JSON.parse(rows[rows.length - 1]!).recordedAt,
      entryCount: rows.length,
      firstSequence,
      lastSequence
    });
  }
  fs.writeFileSync(path.join(archiveDir, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: sequence,
    archives
  }, null, 2)}\n`, "utf8");
  return roleDir;
}

function planFeedbackRecoveryFixture(unrelatedPlanDirectories = 500): string {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-recovery-worker-"));
  const roleId = "Planner";
  const roleDir = path.join(rolesRoot, roleId);
  fs.mkdirSync(roleDir, { recursive: true });
  const plan = createPlan(roleDir, {
    id: "worker-recovery-plan",
    title: "Worker recovery plan",
    focus: "Keep UNC recovery outside the Manager event loop",
    status: "执行中",
    currentStepId: "recover",
    steps: [{ id: "recover", title: "Recover", status: "进行中" }],
    keywords: ["worker", "recovery"]
  });
  appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "worker-recovery-feedback",
    roleId,
    planId: plan.id,
    planTitle: plan.title,
    kind: "guidance",
    author: "user",
    source: "webgui",
    text: "Resume this feedback after Manager recovery",
    notifyAgent: true
  }));
  const activeDirectory = path.join(roleDir, "plans", "active");
  for (let index = 0; index < unrelatedPlanDirectories; index += 1) {
    fs.mkdirSync(path.join(activeDirectory, `unrelated-${index}`), { recursive: true });
  }
  return rolesRoot;
}

test("manager read workers keep the main event loop responsive during archive queries", async () => {
  const roleDir = voiceArchiveFixture();
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 60_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: false,
      limit: 200
    });
    assert.equal(result.matchedCount, 4_000);
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers publish a deeply immutable RoleKnowledge catalog", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-catalog-worker-"));
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 });
  try {
    createPlan(roleDir, {
      id: "worker-catalog",
      title: "Worker catalog",
      focus: "Publish the RoleKnowledge catalog",
      status: "执行中",
      currentStepId: "read",
      steps: [{ id: "read", title: "Read in worker", status: "进行中" }],
      keywords: ["worker"]
    });
    const snapshot = await pool.queryRoleKnowledgeCatalogSnapshot(roleDir);
    assert.equal(snapshot.plans[0]?.id, "worker-catalog");
    assert.equal(publishedRolePlans(roleDir)?.[0]?.id, "worker-catalog");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.plans[0]?.steps), true);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("knowledge plan pages coalesce identical concurrent summary reads", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-plan-page-worker-"));
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 2, maxQueue: 0, timeoutMs: 10_000 });
  try {
    for (let index = 0; index < 12; index += 1) {
      createPlan(roleDir, {
        id: `page-${index}`,
        title: `Page ${index}`,
        focus: "Keep knowledge pages bounded",
        status: "执行中",
        currentStepId: "read",
        steps: [{ id: "read", title: "Read", status: "进行中" }],
        keywords: ["page"]
      });
    }
    const input = {
      cursor: "",
      limit: 8,
      query: "",
      sort: "status" as const,
      statuses: [],
      tags: [],
      includeFacets: true,
      summary: true
    };
    const [first, second] = await Promise.all([
      pool.queryRolePlanPage<{ items: Array<{ id: string }>; total: number }>(roleDir, input),
      pool.queryRolePlanPage<{ items: Array<{ id: string }>; total: number }>(roleDir, input)
    ]);
    assert.equal(first.items.length, 8);
    assert.deepEqual(second, first);
    assert.equal(pool.status().spawnedWorkers, 1);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("role panel timeline reads resolve a validated role id inside the read child", async () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-panel-read-worker-"));
  const roleDir = path.join(rolesRoot, "YeYu");
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 30_000 });
  try {
    appendRolePanelTimelineMessageIfAbsent(roleDir, {
      id: "worker-timeline-one",
      time: 1_788_192_000,
      roleId: "YeYu",
      direction: "user",
      sender: "test",
      text: "worker read",
      attachments: [],
      status: "sent"
    });
    const messages = await pool.queryRolePanelTimeline(rolesRoot, "YeYu", 10);
    assert.deepEqual(messages.map(message => message.id), ["worker-timeline-one"]);
    await assert.rejects(pool.queryRolePanelTimeline(rolesRoot, "../YeYu", 10));
  } finally {
    await pool.stop();
    fs.rmSync(rolesRoot, { recursive: true, force: true });
  }
});

test("plan feedback recovery stays ledger-first inside a bounded read worker", async () => {
  const rolesRoot = planFeedbackRecoveryFixture();
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 0, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 2);
  try {
    const candidates = await pool.queryPlanFeedbackRecoveryCandidates(rolesRoot);
    assert.deepEqual(candidates.map(candidate => candidate.feedback.id), ["worker-recovery-feedback"]);
    assert.equal(candidates[0]?.plan.id, "worker-recovery-plan");
    assert.ok(ticks >= 1, `expected the Manager event loop to remain responsive, got ${ticks} ticks`);
    assert.equal(pool.status().maxConcurrency, 1);
    assert.equal(pool.status().maxQueue, 0);
  } finally {
    clearInterval(timer);
    await pool.stop();
    fs.rmSync(rolesRoot, { recursive: true, force: true });
  }
});

test("manager read workers reject excess heavy reads instead of growing an unbounded queue", async () => {
  const roleDir = voiceArchiveFixture(4, 250);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 0, timeoutMs: 30_000 });
  try {
    const first = pool.queryPersonaVoiceTranscripts(roleDir, { includeArchives: true, includeDetails: true });
    await assert.rejects(
      pool.queryPersonaVoiceTranscripts(roleDir, { includeArchives: true, includeDetails: true }),
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "busy"
    );
    await first;
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read worker pools keep six bounded lanes available for concurrent interactive reads", async () => {
  const roleDir = voiceArchiveFixture(6, 400);
  const pools = Array.from({ length: 7 }, () => new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 30_000
  }));
  try {
    const tasks = pools.map(pool => pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: true,
      limit: 200
    }));
    const statuses = pools.map(pool => pool.status());
    await Promise.all(tasks);
    assert.equal(statuses.reduce((sum, status) => sum + status.active, 0), 6);
    assert.equal(statuses.reduce((sum, status) => sum + status.queued, 0), 1);
    assert.equal(statuses[0].globalActive, 6);
    assert.equal(statuses[0].globalMaxConcurrency, 6);
  } finally {
    await Promise.all(pools.map(pool => pool.stop()));
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers coalesce simultaneous voice-summary scans", async () => {
  const roleDir = voiceArchiveFixture(6, 400);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 0, timeoutMs: 30_000 });
  try {
    const first = pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: false,
      from: 0,
      limit: 200
    });
    const second = pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: false,
      from: 0,
      limit: 50
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.matchedCount, 2_400);
    assert.deepEqual(secondResult, firstResult);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers keep conflict-history scans off the main event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-conflict-worker-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const stateRoot = path.join(root, "sync-state");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, stateRoot);
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash: hash("base\n"),
    peerId: "pc-b"
  });
  const original = path.join(stateRoot, conflict.conflictPath!);
  const directory = path.dirname(original);
  for (let index = 0; index < 500; index += 1) {
    const duplicate = path.join(directory, `legacy-${String(index).padStart(4, "0")}-${path.basename(original)}`);
    fs.copyFileSync(original, duplicate);
    fs.copyFileSync(`${original}.meta.json`, `${duplicate}.meta.json`);
  }

  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const conflicts = await pool.queryPersonaSyncConflicts(rolesRoot, stateRoot, "Rabi");
    assert.equal(conflicts.length, 1);
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
    await pool.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manager read workers keep recent-memory detail scans pure and off the main event loop", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-memory-worker-"));
  for (let index = 0; index < 600; index += 1) {
    createRecentMemory(roleDir, {
      id: `memory-${String(index).padStart(4, "0")}`,
      title: `性能记忆 ${index}`,
      focus: `验证近期记忆 ${index} 的读取性能`,
      content: "x".repeat(3_500),
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      keywords: ["性能"]
    });
  }

  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const memory = await pool.queryRecentMemoryDetail(roleDir, "memory-0599");
    assert.equal(memory?.id, "memory-0599");
    assert.equal(memory?.viewedAt, undefined);
    assert.equal(listRecentMemories(roleDir).find(item => item.id === "memory-0599")?.viewedAt, undefined);
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers reuse a resident worker across sequential memory reads", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-memory-worker-reuse-"));
  createRecentMemory(roleDir, {
    id: "memory-reuse",
    title: "常驻 Worker",
    focus: "验证连续读取不会重复启动 Worker",
    content: "worker reuse",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["性能"]
  });
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "memory-reuse"))?.id, "memory-reuse");
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "missing-memory")), null);
    assert.equal(pool.status().workers, 1);
    assert.equal(pool.status().spawnedWorkers, 1);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager heavy reads run in a separate low-priority process", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-read-process-"));
  createRecentMemory(roleDir, {
    id: "memory-process",
    title: "独立进程",
    focus: "验证重任务不与 Manager 共享进程",
    content: "separate process",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["性能"]
  });
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "memory-process"))?.id, "memory-process");
    const status = pool.status();
    assert.equal(status.executionMode, "child_process");
    assert.equal(status.workerPids.length, 1);
    assert.notEqual(status.workerPids[0], process.pid);
    assert.equal(os.getPriority(status.workerPids[0]), os.constants.priority.PRIORITY_BELOW_NORMAL);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers build performance summaries and JSON outside the main event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-performance-worker-"));
  const config = { ...defaultPerformanceMonitoringConfig(), enabled: true, retentionHours: 720 };
  const store = new PerformanceStore(root, config);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    await store.start();
    const baseTime = Date.now() - 3_000 * 5_000;
    for (let index = 0; index < 3_000; index += 1) {
      const time = new Date(baseTime + index * 5_000).toISOString();
      store.append({
        schemaVersion: 1,
        kind: "performance_sample",
        sampleId: `worker-sample-${index}`,
        time,
        intervalMs: 5_000,
        source: { kind: "manager", id: "manager", runtimeId: "runtime-worker", pid: 1 },
        system: {
          cpuPercent: 1,
          rssBytes: 1_000,
          heapUsedBytes: 500,
          heapTotalBytes: 800,
          externalBytes: 10,
          eventLoopP50Ms: 1,
          eventLoopP95Ms: 2,
          eventLoopMaxMs: 3,
          eventLoopUtilization: 0.1
        }
      } satisfies PerformanceSample);
    }
    await store.flush();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const summaryJson = await pool.queryPerformanceSummaryJson(
        store.logDirectory,
        60 * 60 * 1_000,
        config,
        store.status()
      );
      const logsJson = await pool.queryPerformanceLogsJson(store.logDirectory, 100, store.status());
      const summary = JSON.parse(summaryJson) as { data: { sources: unknown[]; points: unknown[] } };
      const logs = JSON.parse(logsJson) as { data: unknown[] };
      assert.equal(summary.data.sources.length, 1);
      assert.ok(summary.data.points.length > 0);
      assert.equal(logs.data.length, 100);
      assert.equal(pool.status().spawnedWorkers, 1);
      assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
    } finally {
      clearInterval(timer);
    }
  } finally {
    await pool.stop();
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manager read worker pools stop active and queued work, reject new work, and restart", async () => {
  const roleDir = voiceArchiveFixture(4, 250);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    const active = pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: true,
      limit: 200
    });
    const queued = pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: true,
      from: 1,
      limit: 200
    });
    assert.equal(pool.status().active, 1);
    assert.equal(pool.status().queued, 1);

    const activeRejected = assert.rejects(
      active,
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "aborted"
    );
    const queuedRejected = assert.rejects(
      queued,
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "aborted"
    );
    const firstStop = pool.stop();
    const secondStop = pool.stop();
    assert.strictEqual(secondStop, firstStop);
    await Promise.all([activeRejected, queuedRejected]);
    await firstStop;
    assert.equal(pool.status().active, 0);
    assert.equal(pool.status().queued, 0);
    assert.equal(pool.status().workers, 0);
    await assert.rejects(
      pool.queryPersonaVoiceTranscripts(roleDir, { includeArchives: true, includeDetails: false }),
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "aborted"
    );

    pool.start();
    const restarted = await pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: false,
      limit: 20
    });
    assert.equal(restarted.matchedCount, 1_000);
  } finally {
    await pool.stop();
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read timeout keeps its local and global lease until the worker actually closes", async () => {
  const events: string[] = [];
  let spawned = 0;
  let activeBeforeClose = -1;
  let globalActiveBeforeClose = -1;
  let pool: ManagerReadWorkerPool;
  pool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 100,
    terminationTimeoutMs: 5,
    forceTerminationTimeoutMs: 100,
    setWorkerPriority: () => {},
    workerFactory: () => {
      spawned += 1;
      if (spawned === 1) {
        let firstRequest: FakeReadRequest | undefined;
        return new FakeReadWorker(51_001, (request) => {
          firstRequest = request;
          events.push("first-send");
        }, (signal, worker) => {
          events.push(`first-${String(signal)}`);
          if (signal !== "SIGKILL") return;
          if (firstRequest) worker.respond(firstRequest, { late: true });
          setTimeout(() => {
            activeBeforeClose = pool.status().active;
            globalActiveBeforeClose = pool.status().globalActive;
            events.push("first-close");
            worker.close(null, "SIGKILL");
          }, 10);
        });
      }
      return new FakeReadWorker(51_002, (request, worker) => {
        events.push("second-send");
        worker.respond(request, { recovered: true });
      }, (_signal, worker) => worker.close(0, "SIGTERM"));
    }
  });
  try {
    const timedOut = pool.run(fakeReadTask("first"));
    const queued = pool.run<{ recovered: boolean }>(fakeReadTask("second"));
    await assert.rejects(
      timedOut,
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "timeout"
    );
    assert.equal(activeBeforeClose, 1);
    assert.ok(globalActiveBeforeClose >= 1);
    assert.deepEqual(await queued, { recovered: true });
    assert.deepEqual(events.slice(0, 5), [
      "first-send",
      "first-SIGTERM",
      "first-SIGKILL",
      "first-close",
      "second-send"
    ]);
  } finally {
    await pool.stop();
  }
});

test("manager read abort keeps its lease until SIGTERM close is observed", async () => {
  const controller = new AbortController();
  let activeBeforeClose = -1;
  let globalActiveBeforeClose = -1;
  let pool: ManagerReadWorkerPool;
  const child = new FakeReadWorker(52_001, () => {}, (signal, worker) => {
    if (signal !== "SIGTERM") return;
    setTimeout(() => {
      activeBeforeClose = pool.status().active;
      globalActiveBeforeClose = pool.status().globalActive;
      worker.close(null, "SIGTERM");
    }, 10);
  });
  pool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 0,
    timeoutMs: 10_000,
    terminationTimeoutMs: 100,
    forceTerminationTimeoutMs: 100,
    setWorkerPriority: () => {},
    workerFactory: () => child
  });
  try {
    const active = pool.run(fakeReadTask("abort"), { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      active,
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "aborted"
    );
    assert.equal(activeBeforeClose, 1);
    assert.ok(globalActiveBeforeClose >= 1);
    assert.deepEqual(child.signals, ["SIGTERM"]);
  } finally {
    await pool.stop();
  }
});

test("unconfirmed read-worker termination blocks only its owning pool until a real close", async () => {
  const blockedChild = new FakeReadWorker(53_001, () => {}, () => {});
  const blockedPool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 100,
    terminationTimeoutMs: 5,
    forceTerminationTimeoutMs: 5,
    setWorkerPriority: () => {},
    workerFactory: () => blockedChild
  });
  const recoveryChild = new FakeReadWorker(53_002, (request, worker) => {
    worker.respond(request, { restored: true });
  }, (_signal, worker) => worker.close(0, "SIGTERM"));
  const recoveryPool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 1_000,
    terminationTimeoutMs: 20,
    forceTerminationTimeoutMs: 20,
    setWorkerPriority: () => {},
    workerFactory: () => recoveryChild
  });
  try {
    await assert.rejects(
      blockedPool.run(fakeReadTask("never-close")),
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "termination_unconfirmed"
    );
    assert.equal(blockedPool.status().active, 1);
    assert.equal(blockedPool.status().workers, 1);
    assert.equal(blockedPool.status().terminationBlocked, true);
    assert.deepEqual(blockedPool.status().blockedWorkerPids, [53_001]);

    assert.deepEqual(
      await recoveryPool.run<{ restored: boolean }>(fakeReadTask("other-pool-still-serves")),
      { restored: true }
    );
    assert.equal(recoveryPool.status().queued, 0);
    assert.equal(recoveryPool.status().terminationBlocked, false);
    await assert.rejects(
      blockedPool.stop(),
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "termination_unconfirmed"
    );
    assert.equal(blockedPool.status().active, 1);
    assert.equal(blockedPool.status().workers, 1);

    blockedChild.close(null, "SIGKILL");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(blockedPool.status().active, 0);
    assert.equal(blockedPool.status().workers, 0);
    assert.equal(recoveryPool.status().terminationBlocked, false);
    assert.deepEqual(
      await recoveryPool.run<{ restored: boolean }>(fakeReadTask("after-close")),
      { restored: true }
    );
    await blockedPool.stop();
  } finally {
    blockedChild.close(null, "SIGKILL");
    recoveryChild.close(0, "SIGTERM");
    await Promise.allSettled([blockedPool.stop(), recoveryPool.stop()]);
  }
});

test("no-pid and priority setup failures cannot dispatch another child before close", async () => {
  for (const scenario of ["no-pid", "priority"] as const) {
    let spawned = 0;
    const invalidChild = new FakeReadWorker(scenario === "no-pid" ? undefined : 54_001, () => {}, () => {});
    const recoveredChild = new FakeReadWorker(54_002, (request, worker) => {
      worker.respond(request, { scenario, recovered: true });
    }, (_signal, worker) => worker.close(0, "SIGTERM"));
    const pool = new ManagerReadWorkerPool({
      maxConcurrency: 1,
      maxQueue: 1,
      timeoutMs: 1_000,
      terminationTimeoutMs: 100,
      forceTerminationTimeoutMs: 100,
      workerFactory: () => {
        spawned += 1;
        return spawned === 1 ? invalidChild : recoveredChild;
      },
      setWorkerPriority: (pid) => {
        if (scenario === "priority" && pid === 54_001) throw new Error("priority denied");
      }
    });
    try {
      await assert.rejects(
        pool.run(fakeReadTask(`${scenario}-failure`)),
        (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "worker_failed"
      );
      await assert.rejects(
        pool.run(fakeReadTask(`${scenario}-pending-close`)),
        (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "busy"
      );
      assert.equal(spawned, 1);
      invalidChild.close(null, "SIGTERM");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(
        await pool.run(fakeReadTask(`${scenario}-recovered`)),
        { scenario, recovered: true }
      );
      assert.equal(spawned, 2);
    } finally {
      invalidChild.close(null, "SIGTERM");
      recoveredChild.close(0, "SIGTERM");
      await pool.stop();
    }
  }
});

test("a stopped pool can restart while another pool has an unconfirmed worker", async () => {
  const blockedChild = new FakeReadWorker(55_001, () => {}, () => {});
  const blockedPool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 0,
    timeoutMs: 100,
    terminationTimeoutMs: 5,
    forceTerminationTimeoutMs: 5,
    setWorkerPriority: () => {},
    workerFactory: () => blockedChild
  });
  const restartedChild = new FakeReadWorker(55_002, (request, worker) => {
    worker.respond(request, { restarted: true });
  }, (_signal, worker) => worker.close(0, "SIGTERM"));
  const stoppedPool = new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 0,
    timeoutMs: 1_000,
    terminationTimeoutMs: 20,
    forceTerminationTimeoutMs: 20,
    setWorkerPriority: () => {},
    workerFactory: () => restartedChild
  });
  await stoppedPool.stop();
  try {
    await assert.rejects(
      blockedPool.run(fakeReadTask("block-restart")),
      (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "termination_unconfirmed"
    );
    stoppedPool.start();
    assert.deepEqual(
      await stoppedPool.run(fakeReadTask("restart-isolated")),
      { restarted: true }
    );

    blockedChild.close(null, "SIGKILL");
    await new Promise<void>(resolve => setImmediate(resolve));
    await blockedPool.stop();
  } finally {
    blockedChild.close(null, "SIGKILL");
    restartedChild.close(0, "SIGTERM");
    await Promise.allSettled([blockedPool.stop(), stoppedPool.stop()]);
  }
});
