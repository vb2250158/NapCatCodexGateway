import { parentPort, workerData } from "node:worker_threads";
import { readKnowledgeStorageDelta, type KnowledgeInventory } from "./knowledgeSearchStorage.js";
import fs from "node:fs";
import path from "node:path";
import {
  queryPersonaVoiceTranscriptViews,
  type PersonaVoiceTranscriptQuery
} from "../personaVoiceTranscriptView.js";
import { PersonaSyncService } from "../personaSync.js";
import { readPersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import {
  getPlan,
  getRoleSkill,
  listActiveRecentMemories,
  listArchivedMemories,
  listConsolidatedMemories,
  listConsolidationRuns,
  listPlanHistory,
  listRoleSkills,
  readPlansFromStorageInWorker,
  readRoleKnowledgeCatalogSnapshot,
  roleKnowledgeFileCounts,
  roleMemoryCounts,
  presentRoleMemories,
  readRecentMemoryFromStorageInWorker,
  type RoleKnowledgeCatalogSnapshot
} from "../roleKnowledge.js";
import { listPlanFeedback, planFeedbackSummary } from "../planFeedback.js";
import { readPlanStoragePackage } from "../planStorageRepository.js";
import { readRolePanelTimeline } from "../rolePanelTimeline.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { storageInventoryRevisionToken, storageRevisionToken } from "../shared/storageRevision.js";
import { paginateRoleMemory, paginateRolePlans, summarizeRolePlan } from "../roleKnowledgePagination.js";
import { presentPlans, sortKnowledgeByUpdatedAt } from "../roleKnowledgePresentation.js";
import type {
  PerformanceMonitoringConfig,
  PerformanceSample,
  PerformanceStoreStatus
} from "../shared/performanceContract.js";
import { buildPerformanceSummary, isPerformanceSample } from "./performanceStore.js";
import { listOpenPlanFeedbackRecoveryCandidates } from "./planFeedbackRecoveryDiscovery.js";
import type { GatewayDiagnosticsWorkerInput } from "./gatewayDiagnosticsSnapshot.js";

export type ManagerReadWorkerTask =
  | { type: "knowledge_search_delta"; roleDir: string; previous: KnowledgeInventory }
  | {
      type: "gateway_diagnostics_snapshot";
      input: GatewayDiagnosticsWorkerInput;
    }
  | {
      type: "persona_voice_transcripts";
      roleDir: string;
      query: PersonaVoiceTranscriptQuery;
    }
  | {
      type: "persona_sync_conflicts";
      rolesRoot: string;
      stateRoot: string;
      roleId?: string;
    }
  | {
      type: "plan_feedback_recovery_candidates";
      rolesRoot: string;
    }
  | {
      type: "role_directories";
      rolesRoot: string;
    }
  | {
      type: "role_panel_timeline_read";
      rolesRoot: string;
      roleId: string;
      limit: number;
    }
  | {
      type: "role_knowledge_catalog_snapshot";
      roleDir: string;
    }
  | {
      type: "role_plan_catalog";
      roleDir: string;
    }
  | {
      type: "role_plan_workflow";
      roleDir: string;
    }
  | {
      type: "role_plan_page";
      roleDir: string;
      cursor: string;
      limit: number;
      view?: "current" | "plans" | "archived";
      query: string;
      sort: "status" | "updated" | "importance" | "urgency";
      statuses: string[];
      tags: string[];
      includeFacets: boolean;
      summary: boolean;
    }
  | {
      type: "role_plan_detail" | "role_plan_history" | "role_plan_feedback";
      roleDir: string;
      planId: string;
    }
  | {
      type: "role_storage_plan_projection" | "role_storage_plan_feedback_projection";
      roleDir: string;
      planId: string;
    }
  | {
      type: "role_knowledge_file_counts";
      roleDir: string;
    }
  | {
      type: "role_skill_catalog";
      roleDir: string;
      skillId?: string;
    }
  | {
      type: "role_consolidation_runs";
      roleDir: string;
      runId?: string;
    }
  | {
      type: "role_storage_consolidation_projection";
      roleDir: string;
      runId: string;
    }
  | {
      type: "role_memory_catalog";
      roleDir: string;
      kind: "recent" | "consolidated" | "archived";
      memoryId?: string;
    }
  | {
      type: "role_storage_memory_projection";
      roleDir: string;
      memoryId: string;
      fresh?: boolean;
    }
  | {
      type: "role_memory_page";
      roleDir: string;
      kind: "recent" | "consolidated" | "archived";
      cursor: string;
      limit: number;
      query: string;
    }
  | {
      type: "role_memory_overview";
      roleDir: string;
    }
  | {
      type: "role_memory_counts";
      roleDir: string;
    }
  | {
      type: "performance_summary";
      logDirectory: string;
      rangeMs: number;
      config: PerformanceMonitoringConfig;
      status: PerformanceStoreStatus;
    }
  | {
      type: "performance_logs";
      logDirectory: string;
      limit: number;
      status: PerformanceStoreStatus;
    };

export type ManagerReadWorkerResponse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string };

export type ManagerReadWorkerRequest = {
  requestId: string;
  task: ManagerReadWorkerTask;
};

export type ManagerReadWorkerMessage = ManagerReadWorkerResponse & {
  requestId: string;
};

function performanceShardStart(filename: string): number {
  const match = filename.match(/^performance-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.jsonl$/);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00.000Z`);
}

function parsePerformanceLines(content: string): PerformanceSample[] {
  const samples: PerformanceSample[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isPerformanceSample(value)) samples.push(value);
    } catch {
      // A partially written final line is ignored.
    }
  }
  return samples;
}

function planStorageRevision(roleDir: string, plan: { id: string; status: string; archiveStatus: string }): string {
  const storagePackage = readPlanStoragePackage(
    roleDir,
    plan.id,
    plan.archiveStatus === "已归档" ? "archive" : "active"
  );
  return storageInventoryRevisionToken(storagePackage.inventoryHash);
}

async function performanceLogFiles(logDirectory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(logDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && /^performance-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

async function readPerformanceSummarySamples(logDirectory: string, rangeMs: number): Promise<PerformanceSample[]> {
  const safeRangeMs = Math.min(48 * 60 * 60 * 1_000, Math.max(60_000, rangeMs));
  const from = Date.now() - safeRangeMs;
  const filenames = (await performanceLogFiles(logDirectory))
    .filter(filename => performanceShardStart(filename) + 60 * 60 * 1_000 >= from);
  const samples: PerformanceSample[] = [];
  for (const filename of filenames) {
    const content = await fs.promises.readFile(path.join(logDirectory, filename), "utf8");
    for (const sample of parsePerformanceLines(content)) {
      if (Date.parse(sample.time) >= from) samples.push(sample);
    }
  }
  return samples.sort((left, right) => left.time.localeCompare(right.time));
}

async function readRecentPerformanceSamples(logDirectory: string, limit: number): Promise<PerformanceSample[]> {
  const safeLimit = Math.min(1_000, Math.max(1, Math.floor(limit) || 100));
  const filenames = (await performanceLogFiles(logDirectory)).reverse();
  let samples: PerformanceSample[] = [];
  for (const filename of filenames) {
    const content = await fs.promises.readFile(path.join(logDirectory, filename), "utf8");
    samples = [...parsePerformanceLines(content), ...samples];
    if (samples.length >= safeLimit) break;
  }
  return samples
    .sort((left, right) => left.time.localeCompare(right.time))
    .slice(-safeLimit);
}

async function execute(task: ManagerReadWorkerTask): Promise<unknown> {
  switch (task.type) {
    case "gateway_diagnostics_snapshot": {
      const { buildGatewayDiagnosticsWorkerSnapshot } = await import("./controlPlaneRoutes.js");
      return buildGatewayDiagnosticsWorkerSnapshot(task.input);
    }
    case "persona_voice_transcripts":
      return queryPersonaVoiceTranscriptViews(task.roleDir, task.query);
    case "persona_sync_conflicts": {
      const service = new PersonaSyncService(() => task.rolesRoot, task.stateRoot);
      return service.listConflictsAsync(task.roleId, {
        pauseEveryEntries: 64,
        pauseMs: 10
      });
    }
    case "plan_feedback_recovery_candidates":
      return await listOpenPlanFeedbackRecoveryCandidates(task.rolesRoot);
    case "role_directories":
      return fs.readdirSync(task.rolesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(task.rolesRoot, entry.name));
    case "role_panel_timeline_read": {
      const roleId = sanitizeRoleId(task.roleId);
      if (!roleId || roleId !== task.roleId) throw new Error("Role panel timeline roleId is invalid.");
      const limit = Math.min(5_000, Math.max(1, Math.floor(task.limit) || 120));
      return readRolePanelTimeline(roleFolderPath(task.rolesRoot, roleId), limit);
    }
    case "knowledge_search_delta":
      return readKnowledgeStorageDelta(task.roleDir, task.previous);
    case "role_knowledge_catalog_snapshot":
      return readRoleKnowledgeCatalogSnapshot(task.roleDir) satisfies RoleKnowledgeCatalogSnapshot;
    case "role_plan_catalog": {
      const plans = readPlansFromStorageInWorker(task.roleDir);
      return {
        plans,
        approvalByPlanId: Object.fromEntries(
          plans.map(plan => [plan.id, planFeedbackSummary(task.roleDir, plan.id)])
        )
      };
    }
    case "role_plan_workflow":
      return readPersonaPlanWorkflow(task.roleDir);
    case "role_plan_page": {
      const workflow = readPersonaPlanWorkflow(task.roleDir)?.workflow;
      if (!workflow) throw new Error(`PLAN_STATUS_CONFIG_MISSING: ${task.roleDir}`);
      const page = paginateRolePlans(
        presentPlans(readPlansFromStorageInWorker(task.roleDir), workflow),
        task.cursor,
        task.limit,
        {
          view: task.view,
          query: task.query,
          sort: task.sort,
          statuses: task.statuses,
          tags: task.tags,
          includeFacets: task.includeFacets
        }
      );
      return {
        ...page,
        // The overview asks for summary rows. Do not touch every plan's feedback
        // directory before returning one eight-row page.
        items: task.summary
          ? page.items.map(summarizeRolePlan)
          : page.items.map(plan => ({ ...plan, approval: planFeedbackSummary(task.roleDir, plan.id) }))
      };
    }
    case "role_plan_detail": {
      const plan = getPlan(task.roleDir, task.planId);
      return plan ? { plan, approval: planFeedbackSummary(task.roleDir, plan.id) } : null;
    }
    case "role_storage_plan_projection": {
      const plan = getPlan(task.roleDir, task.planId);
      return plan ? {
        plan,
        revision: planStorageRevision(task.roleDir, plan),
        approval: planFeedbackSummary(task.roleDir, plan.id)
      } : null;
    }
    case "role_plan_history": {
      const plan = getPlan(task.roleDir, task.planId);
      return plan ? { plan, records: listPlanHistory(task.roleDir, plan.id) } : null;
    }
    case "role_plan_feedback": {
      const plan = getPlan(task.roleDir, task.planId);
      if (!plan) return null;
      const records = listPlanFeedback(task.roleDir, plan.id);
      return { plan, records };
    }
    case "role_storage_plan_feedback_projection": {
      const plan = getPlan(task.roleDir, task.planId);
      if (!plan) return null;
      const records = listPlanFeedback(task.roleDir, plan.id);
      return {
        plan,
        planRevision: planStorageRevision(task.roleDir, plan),
        records,
        recordRevisions: Object.fromEntries(records.map(record => [record.id, storageRevisionToken(record)]))
      };
    }
    case "role_knowledge_file_counts":
      return roleKnowledgeFileCounts(task.roleDir);
    case "role_skill_catalog":
      return task.skillId ? getRoleSkill(task.roleDir, task.skillId) ?? null : listRoleSkills(task.roleDir);
    case "role_consolidation_runs": {
      const runs = listConsolidationRuns(task.roleDir);
      return task.runId ? runs.find(run => run.id === task.runId) ?? null : runs;
    }
    case "role_storage_consolidation_projection": {
      const run = listConsolidationRuns(task.roleDir).find(item => item.id === task.runId) ?? null;
      return run ? { run, revision: storageRevisionToken(run) } : null;
    }
    case "role_memory_catalog": {
      if (task.kind === "recent" || task.kind === "archived") {
        const source = task.kind === "archived"
          ? listArchivedMemories(task.roleDir)
          : listActiveRecentMemories(task.roleDir);
        if (task.memoryId && !source.some(item => item.id === task.memoryId)) return null;
        const presented = presentRoleMemories(
          task.roleDir,
          sortKnowledgeByUpdatedAt(source),
          "recent"
        );
        return task.memoryId
          ? presented.find((item) => item.id === task.memoryId) ?? null
          : presented;
      }
      const source = listConsolidatedMemories(task.roleDir);
      if (task.memoryId && !source.some(item => item.id === task.memoryId)) return null;
      const presented = presentRoleMemories(
        task.roleDir,
        sortKnowledgeByUpdatedAt(source),
        "consolidated"
      );
      return task.memoryId
        ? presented.find((item) => item.id === task.memoryId) ?? null
        : presented;
    }
    case "role_storage_memory_projection": {
      const memory = (task.fresh
        ? readRecentMemoryFromStorageInWorker(task.roleDir, task.memoryId)
        : listActiveRecentMemories(task.roleDir).find(item => item.id === task.memoryId)) ?? null;
      if (!memory) return null;
      const projection = presentRoleMemories(task.roleDir, [memory], "recent")[0];
      return projection ? { memory: projection, revision: storageRevisionToken(memory) } : null;
    }
    case "role_memory_page": {
      const items = task.kind === "consolidated"
        ? presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listConsolidatedMemories(task.roleDir)), "consolidated")
        : presentRoleMemories(
          task.roleDir,
          sortKnowledgeByUpdatedAt(task.kind === "archived" ? listArchivedMemories(task.roleDir) : listActiveRecentMemories(task.roleDir)),
          "recent"
        );
      return paginateRoleMemory(items, task.cursor, task.limit, task.query, roleMemoryCounts(task.roleDir));
    }
    case "role_memory_overview":
      return {
        recent: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listActiveRecentMemories(task.roleDir)), "recent"),
        consolidated: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listConsolidatedMemories(task.roleDir)), "consolidated"),
        archived: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listArchivedMemories(task.roleDir)), "recent"),
        consolidationRuns: listConsolidationRuns(task.roleDir)
      };
    case "role_memory_counts":
      return roleMemoryCounts(task.roleDir);
    case "performance_summary": {
      const samples = await readPerformanceSummarySamples(task.logDirectory, task.rangeMs);
      return JSON.stringify({
        code: 0,
        data: buildPerformanceSummary(samples, task.rangeMs, task.config, task.status)
      });
    }
    case "performance_logs": {
      const samples = await readRecentPerformanceSamples(task.logDirectory, task.limit);
      return JSON.stringify({ code: 0, data: samples, status: task.status });
    }
  }
}

function send(message: ManagerReadWorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  if (process.send) {
    process.send(message);
    return;
  }
  throw new Error("Manager read process requires an IPC channel.");
}

async function respond(requestId: string, task: ManagerReadWorkerTask): Promise<void> {
  try {
    const value = await execute(task);
    send({ requestId, ok: true, value } satisfies ManagerReadWorkerMessage);
  } catch (error) {
    send({
      requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    } satisfies ManagerReadWorkerMessage);
  }
}

if (workerData) {
  void respond("one-shot", workerData as ManagerReadWorkerTask);
} else if (parentPort) {
  parentPort.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
} else if (process.send) {
  process.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
  process.once("disconnect", () => process.exit(0));
} else {
  throw new Error("Manager read process requires a parent channel.");
}
