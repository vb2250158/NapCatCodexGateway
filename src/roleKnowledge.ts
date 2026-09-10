import { RoleStorageValidationError } from "./shared/roleStorageValidationError.js";
import { publishKnowledgeChange, type KnowledgeChange, type KnowledgeKind } from "./roleKnowledgeSearch.js";
import { readPlanIdentity, readPlanIdentityAsync } from "./planIdentityReadCache.js";
import { normalizePlanQuestions, type PlanQuestion } from "./shared/planQuestions.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { normalizePlanMessageChannels, validatePlanMessageChannels, type AgentHookDestination } from "./shared/agentHookAutomation.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  measurePerformanceOperation,
  recordPerformanceOperation
} from "./performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "./shared/performanceOperations.js";
import {
  normalizeStoredPlanAttachments,
  preparePlanAttachments,
  type PreparedPlanAttachment
} from "./planAttachments.js";
import type { PlanAttachment } from "./shared/planAttachmentContract.js";
import type { PlanImportanceLevel, PlanUrgencyLevel } from "./shared/planSortContract.js";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import {
  createStorageRevision,
  storageInventoryRevisionToken,
  storageRevisionToken,
  type StorageMutationStamp
} from "./shared/storageRevision.js";
import { requiresWorkerFilesystemAccess } from "./shared/pathPolicy.js";
import { canonicalLogicalPlanId } from "./planStorageIdentity.js";
import {
  memoryStorageCaseFold,
  memoryStorageCollisionKey,
  safeMemoryStorageSegment
} from "./memoryStorageIdentity.js";
import {
  assertPlanStorageIdentityAvailable,
  commitPlanLifecycleTransitionUnderLease,
  readCanonicalPlanStoragePackageUnderLease,
  subscribePlanStorageBeforeMutation,
  withPlanStorageLease as withPlanStorageLock,
  type PlanStorageLease,
  type PlanStoragePackageFile
} from "./planStorageRepository.js";
import {
  planAttachmentDirectory,
  planBucketForArchiveStatus,
  planDirectory,
  planFeedbackAttachmentDirectory,
  planFeedbackFile as planStorageFeedbackFile,
  planHistoryFile as planStorageHistoryFile,
  planJsonFile,
  type PlanStorageBucket
} from "./planStorageLayout.js";
import {
  assertWritablePlanStatus,
  ensurePersonaPlanWorkflow,
  planStatusDefinition,
  planStatusKeyForRole,
  readPersonaPlanWorkflow,
  resolvePersonaPlanStatus,
  validatePersonaPlanWorkflow,
  type PersonaPlanWorkflow,
  type PersonaPlanWorkflowRole
} from "./personaPlanWorkflow.js";

const packageRoot = resolveRuntimeLayout(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
).packageRoot;

/** Stable key from the owning persona's personaConfig.planWorkflow.statuses. */
export type PlanStatus = string;
export type PlanArchiveStatus = "未归档" | "已归档";

export type PlanApprovalFileAction = "create" | "modify" | "delete" | "move";

export type PlanApprovalFileChange = {
  path: string;
  action: PlanApprovalFileAction;
  change: string;
  destination?: string;
};

export type PlanApprovalCommand = {
  command: string;
  purpose: string;
  expectedEffect?: string;
};

export type PlanApprovalExternalChange = {
  target: string;
  change: string;
  impact?: string;
};

export type PlanApprovalRequest = {
  approver?: string;
  request: string;
  recommendation?: string;
  alternatives?: string[];
  reason: string;
  files: PlanApprovalFileChange[];
  commands: PlanApprovalCommand[];
  changes: PlanApprovalExternalChange[];
  validation: string[];
  rollback: string[];
  outOfScope: string[];
  requestedAt?: string;
  sourceMessageId?: string;
  feedbackId?: string;
  responseStatus?: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled";
};

export type PlanApprovalGateState = "none" | "preparing" | "pending";

export type PlanApprovalGate = {
  state: PlanApprovalGateState;
  stepId?: string;
  missing: string[];
  contract?: PlanApprovalRequest;
};

export type PlanStep = {
  id: string;
  title: string;
  detail?: string;
  waitingFor?: string;
  /** Compatibility projection. Manager derives this from a complete pending approvalRequest. */
  isBlocked?: boolean;
  /** Human-readable explanation only; it does not decide blocked state. */
  blockedBy?: string;
  startedAt?: string;
  completedAt?: string;
  approvalRequest?: PlanApprovalRequest;
  questions?: PlanQuestion[];
};

export type KnowledgeSource = {
  kind?: string;
  summary?: string;
};

export type PlanTaskCompletionHook = {
  enabled: boolean;
  gatewayId?: string;
};

export type PlanTaskBinding = {
  agentType: "codex" | "dsh";
  sessionId: string;
  sessionTitle?: string;
  workspace?: string;
  /** DSH apiproxy origin used to read and open this DSH session. */
  baseUrl?: string;
  completionHook?: PlanTaskCompletionHook;
};

export type PlanSecretaryBinding = {
  agentType: "codex" | "dsh";
  sessionId: string;
  sessionTitle?: string;
  workspace: string;
  /** DSH apiproxy origin used to read and open this DSH session. */
  baseUrl?: string;
  assignedAt?: string;
};

export type PlanItem = {
  /** Optional final-result destinations. Persona event rules still apply when omitted. */
  messageChannels?: AgentHookDestination[];
  id: string;
  title: string;
  focus: string;
  status: PlanStatus;
  archiveStatus: PlanArchiveStatus;
  /** Integer sort value. 0 is highest; 4 means unset. */
  importance?: PlanImportanceLevel;
  /** Integer sort value. 0 is most urgent; 4 means unset. */
  urgency?: PlanUrgencyLevel;
  /** Legacy compatibility input. New writers should use importance. */
  priority?: string;
  kind?: string;
  currentStep?: string;
  currentStepId?: string;
  nextAction?: string;
  waitingFor?: string;
  /** Compatibility projection. Manager derives this from the current approval gate. */
  isBlocked?: boolean;
  /** Human-readable explanation only; it does not decide blocked state. */
  blockedBy?: string;
  attachments: PlanAttachment[];
  steps: PlanStep[];
  project?: {
    name?: string;
    path?: string;
  };
  source?: KnowledgeSource;
  /** Control-plane owner. This is separate from the business taskBinding. */
  secretaryBinding?: PlanSecretaryBinding;
  taskBinding?: PlanTaskBinding;
  dueAt?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
  keywords: string[];
};

export type PlanHistoryRecord = {
  id: string;
  planId: string;
  kind: "created" | "updated" | "archived";
  recordedAt: string;
  before?: PlanItem;
  after: PlanItem;
};

export type PlanUpdatedEvent = {
  roleDir: string;
  before: PlanItem;
  after: PlanItem;
};

const planUpdatedListeners = new Set<(event: PlanUpdatedEvent) => void>();

export function subscribePlanUpdates(listener: (event: PlanUpdatedEvent) => void): () => void {
  planUpdatedListeners.add(listener);
  return () => planUpdatedListeners.delete(listener);
}

function notifyPlanUpdated(event: PlanUpdatedEvent): void {
  for (const listener of planUpdatedListeners) {
    try {
      listener(event);
    } catch {
      // Plan persistence already succeeded. Observers report their own delivery failures.
    }
  }
}

export type RecentMemoryItem = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
  viewedAt?: string;
  recalledAt?: string;
  consolidatedAt?: string;
  consolidationRunId?: string;
  keywords: string[];
};

export type ConsolidatedMemoryItem = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
  viewedAt?: string;
  recalledAt?: string;
  inputMemoryIds?: string[];
  consolidationRunId?: string;
  keywords: string[];
};

export type RoleSkillStatus = "active" | "draft" | "archived";

export type RoleSkillItem = {
  id: string;
  title: string;
  summary: string;
  source?: KnowledgeSource;
  updatedAt: string;
  status: RoleSkillStatus;
  keywords: string[];
  path: string;
};

export type RoleSkillDetail = RoleSkillItem & {
  content: string;
};

export type MemoryConsolidationRun = {
  id: string;
  roleDir: string;
  requestedAt: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
  deliveredAt?: string;
  completedAt?: string;
  trigger: "auto" | "manual" | "api";
  recentEditableHours: number;
  recentConsolidationHours: number;
  triggerMemoryId?: string;
  triggerAt?: string;
  candidateCutoffAt?: string;
  inputMemoryIds: string[];
  outputMemoryIds?: string[];
  status: "requested" | "completed";
  instruction: string;
};

export type MemoryConsolidationRequest = {
  run: MemoryConsolidationRun;
  memories: RecentMemoryItem[];
};

export type RoleKnowledgeItemType = "plan" | "recent_memory" | "consolidated_memory" | "role_skill";

export type RoleKnowledgeIndexItem = {
  id: string;
  title: string;
  type: RoleKnowledgeItemType;
  summary?: string;
};

export type RequiredReadItem = RoleKnowledgeIndexItem & {
  endpoint: string;
  score: number;
  revisionAt: string;
};

export type CreateMemoryConsolidationRequestOptions = {
  roleId?: string;
  triggerSource?: "auto" | "manual" | "api";
  triggerOlderThanHours?: number;
  includeOlderThanHours?: number;
  force?: boolean;
};

export type RoleKnowledgeSnapshot = {
  roleDir: string;
  plansDir: string;
  memoryDir: string;
  agentInterfaceDocPath: string;
  activePlans: PlanItem[];
  activeSkills: RoleSkillItem[];
  recentMemories: RecentMemoryItem[];
  matchedItems: RoleKnowledgeIndexItem[];
  matchedSkills: RoleSkillItem[];
  requiredReadItems: RequiredReadItem[];
  contextInjection: RoleContextInjectionPolicy;
  pendingConsolidation?: MemoryConsolidationRequest;
};

export type RoleContextInjectionMode = "focused" | "legacy";

export type RoleContextInjectionPolicy = {
  mode: RoleContextInjectionMode;
  requiredReadLimit: number;
  matchedItemLimit: number;
  personaMaxChars: number;
};

export const DEFAULT_FOCUSED_CONTEXT_INJECTION: RoleContextInjectionPolicy = {
  mode: "focused",
  requiredReadLimit: 3,
  matchedItemLimit: 3,
  personaMaxChars: 1600
};

export const DEFAULT_LEGACY_CONTEXT_INJECTION: RoleContextInjectionPolicy = {
  mode: "legacy",
  requiredReadLimit: 5,
  matchedItemLimit: 12,
  personaMaxChars: 3200
};

export type RoleKnowledgeSnapshotOptions = {
  roleId?: string;
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
  forceConsolidation?: boolean;
  requiredReadLimit?: number;
  archiveCompletedPlans?: boolean;
  touchViewedAt?: boolean;
  touchRequiredRead?: (item: RequiredReadItem) => boolean;
};

export const DEFAULT_PLAN_ARCHIVE_AFTER_HOURS = 72;
export const DEFAULT_RECENT_EDITABLE_HOURS = 24;
export const DEFAULT_RECENT_CONSOLIDATION_HOURS = 72;

export type PlanWriteLimits = {
  titleChars: number;
  focusChars: number;
  currentStepChars: number;
  stepTitleChars: number;
  stepDetailChars: number;
  stepWaitingForChars: number;
  stepBlockedByChars: number;
  approvalRequestChars: number;
  approvalReasonChars: number;
  approvalPathChars: number;
  approvalDetailChars: number;
  approvalCommandChars: number;
  approvalListItemChars: number;
  maxSteps: number;
  nextActionChars: number;
  waitingForChars: number;
  blockedByChars: number;
  sourceSummaryChars: number;
  keywordChars: number;
  maxKeywords: number;
  totalChars: number;
};

export type MemoryWriteLimits = {
  titleChars: number;
  focusChars: number;
  contentChars: number;
  sourceSummaryChars: number;
  keywordChars: number;
  maxKeywords: number;
  totalChars: number;
};

export type RoleKnowledgeWriteLimits = {
  plan: PlanWriteLimits;
  memory: MemoryWriteLimits;
};

export const DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS: RoleKnowledgeWriteLimits = {
  plan: {
    titleChars: 80,
    focusChars: 80,
    currentStepChars: 1200,
    stepTitleChars: 120,
    stepDetailChars: 600,
    stepWaitingForChars: 300,
    stepBlockedByChars: 300,
    approvalRequestChars: 600,
    approvalReasonChars: 600,
    approvalPathChars: 1000,
    approvalDetailChars: 800,
    approvalCommandChars: 2000,
    approvalListItemChars: 800,
    maxSteps: 100,
    nextActionChars: 600,
    waitingForChars: 300,
    blockedByChars: 600,
    sourceSummaryChars: 240,
    keywordChars: 32,
    maxKeywords: 24,
    totalChars: 12000
  },
  memory: {
    titleChars: 80,
    focusChars: 80,
    contentChars: 4000,
    sourceSummaryChars: 240,
    keywordChars: 32,
    maxKeywords: 24,
    totalChars: 4600
  }
};

export type RoleKnowledgeValidationIssue = {
  type: "plan" | "plan_storage" | "recent_memory" | "consolidated_memory";
  id: string;
  message: string;
};

export type RoleKnowledgeValidationResult = {
  ok: boolean;
  limits: RoleKnowledgeWriteLimits;
  issues: RoleKnowledgeValidationIssue[];
};

export class RoleKnowledgeCacheUnavailableError extends Error {
  readonly code = "cache_unavailable";

  constructor(readonly roleDir: string) {
    super(`Role knowledge catalog is not published for ${path.resolve(roleDir)}.`);
    this.name = "RoleKnowledgeCacheUnavailableError";
  }
}

/**
 * Rebuildable read projection loaded by a bounded Manager read worker.
 * Physical role storage remains authoritative; the parent process only
 * publishes a normalized clone for request/event hot paths.
 */
export type RoleKnowledgeCatalogSnapshot = {
  plans: PlanItem[];
  planWorkflow: PersonaPlanWorkflow;
  recentMemories: RecentMemoryItem[];
  consolidatedMemories: ConsolidatedMemoryItem[];
  skills: RoleSkillItem[];
  limits: RoleKnowledgeWriteLimits;
  contextInjection: RoleContextInjectionPolicy;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeIdPart(value: string): string {
  return safeMemoryStorageSegment(value);
}

function generatedId(prefix: string, title: string): string {
  const suffix = safeIdPart(title) || Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${suffix}`;
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

function jsonFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function markdownFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export type RoleKnowledgeFileCounts = {
  activePlans: number;
  archivedPlans: number;
  recentMemory: number;
  consolidatedMemory: number;
  consolidationRuns: number;
};

/**
 * Counts the files that own the role-knowledge categories without parsing their JSON or Markdown bodies.
 * Listing and filtering content remain separate, on-demand operations.
 */
function planJsonFilesInBucket(roleDir: string, bucket: PlanStorageBucket): string[] {
  const directory = path.join(plansDir(roleDir), bucket);
  try {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, "plan.json"))
      .filter((filePath) => fs.existsSync(filePath))
      .sort();
  } catch {
    return [];
  }
}

export function roleKnowledgeFileCounts(roleDir: string): RoleKnowledgeFileCounts {
  return {
    activePlans: planJsonFilesInBucket(roleDir, "active").length,
    archivedPlans: planJsonFilesInBucket(roleDir, "archive").length,
    recentMemory: markdownFiles(path.join(memoryDir(roleDir), "recent")).length,
    consolidatedMemory: markdownFiles(path.join(memoryDir(roleDir), "consolidated")).length,
    consolidationRuns: jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).length
  };
}

function ageHours(updatedAt: string, now = Date.now()): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now - parsed) / 3_600_000);
}

function laterIso(left?: string, right?: string): string {
  const leftMs = Date.parse(left || "");
  const rightMs = Date.parse(right || "");
  if (!Number.isFinite(leftMs)) return right || left || nowIso();
  if (!Number.isFinite(rightMs)) return left || right || nowIso();
  return rightMs > leftMs ? right as string : left as string;
}

function memoryActivityAt(memory: { updatedAt: string; viewedAt?: string }): string {
  return laterIso(memory.updatedAt, memory.viewedAt);
}

function parseMemoryMarkdown(filePath: string): Record<string, unknown> | null {
  try {
    const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const metadata: Record<string, unknown> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!pair) continue;
      const rawValue = pair[2].trim();
      try {
        metadata[pair[1]] = JSON.parse(rawValue);
      } catch {
        metadata[pair[1]] = rawValue.replace(/^["']|["']$/g, "");
      }
    }
    metadata.content = source.slice(match[0].length).trim();
    return metadata;
  } catch {
    return null;
  }
}

function memoryMarkdown(value: RecentMemoryItem | ConsolidatedMemoryItem): string {
  const { content, ...metadata } = value;
  const frontmatter = Object.entries(metadata)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${key}: ${JSON.stringify(field)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${content.trim()}\n`;
}

function writeMemoryMarkdown(filePath: string, value: RecentMemoryItem | ConsolidatedMemoryItem): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, memoryMarkdown(value));
}

function memoryConsolidationActivityAt(memory: { updatedAt: string; recalledAt?: string }): string {
  return laterIso(memory.updatedAt, memory.recalledAt);
}

export type MemoryLifecyclePresentation = {
  kind: "recent" | "consolidated";
  state: "active" | "eligible" | "trigger_due" | "consolidated_source" | "consolidated";
  activityAt: string;
  consolidationEligibleAt?: string;
  consolidationTriggerAt?: string;
  triggersNextConsolidation?: boolean;
  willEnterNextConsolidation?: boolean;
};

type RecentMemoryConsolidationProjectionItem = {
  activityAt: string;
  consolidationEligibleAt: string;
  consolidationTriggerAt: string;
  triggersNextConsolidation: boolean;
  willEnterNextConsolidation: boolean;
};

type RecentMemoryConsolidationProjection = Map<string, RecentMemoryConsolidationProjectionItem>;

type RecentMemoryConsolidationScheduleItem = {
  memory: RecentMemoryItem;
  activityAt: string;
  consolidationEligibleAt: string;
  consolidationTriggerAt: string;
};

type RecentMemoryConsolidationCohort = {
  schedule: RecentMemoryConsolidationScheduleItem[];
  trigger?: RecentMemoryConsolidationScheduleItem;
  candidateCutoffAt?: string;
  candidates: RecentMemoryItem[];
};

type RecentMemoryConsolidationProjectionCacheEntry = {
  validUntil: number;
  projection: RecentMemoryConsolidationProjection;
};

const recentMemoryConsolidationProjectionCache = new Map<string, RecentMemoryConsolidationProjectionCacheEntry>();

function isoAfterHours(value: string, hours: number): string {
  const parsed = Date.parse(value);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + hours * 3_600_000).toISOString();
}

function recentMemoryConsolidationCohort(
  memories: RecentMemoryItem[],
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS
): RecentMemoryConsolidationCohort {
  const schedule = memories
    .filter((memory) => !memory.consolidatedAt)
    .map((memory) => {
      const activityAt = memoryConsolidationActivityAt(memory);
      return {
        memory,
        activityAt,
        consolidationEligibleAt: isoAfterHours(activityAt, recentEditableHours),
        consolidationTriggerAt: isoAfterHours(activityAt, recentConsolidationHours)
      };
    })
    .sort((left, right) => {
      const timeDifference = Date.parse(left.consolidationTriggerAt) - Date.parse(right.consolidationTriggerAt);
      return timeDifference || left.memory.id.localeCompare(right.memory.id);
    });
  const trigger = schedule[0];
  const triggerAt = Date.parse(trigger?.consolidationTriggerAt || "");
  if (!Number.isFinite(triggerAt)) return { schedule, trigger, candidates: [] };
  const candidateCutoffAt = new Date(triggerAt - recentEditableHours * 3_600_000).toISOString();
  return {
    schedule,
    trigger,
    candidateCutoffAt,
    candidates: schedule
      .filter((item) => Date.parse(item.activityAt) < Date.parse(candidateCutoffAt))
      .map((item) => item.memory)
  };
}

export function presentRoleMemory<T extends RecentMemoryItem | ConsolidatedMemoryItem>(
  memory: T,
  kind: "recent" | "consolidated",
  now = Date.now(),
  consolidationProjection?: RecentMemoryConsolidationProjection
): T & { lifecycle: MemoryLifecyclePresentation } {
  const activityAt = kind === "recent"
    ? memoryConsolidationActivityAt(memory)
    : memoryActivityAt(memory);
  if (kind === "consolidated") {
    return {
      ...memory,
      lifecycle: { kind, state: "consolidated", activityAt }
    };
  }
  if ("consolidatedAt" in memory && memory.consolidatedAt) {
    return {
      ...memory,
      lifecycle: { kind, state: "consolidated_source", activityAt }
    };
  }
  const projection = consolidationProjection?.get(memory.id);
  const consolidationEligibleAt = projection?.consolidationEligibleAt
    ?? isoAfterHours(activityAt, DEFAULT_RECENT_EDITABLE_HOURS);
  const consolidationTriggerAt = projection?.consolidationTriggerAt
    ?? isoAfterHours(activityAt, DEFAULT_RECENT_CONSOLIDATION_HOURS);
  const state = now >= Date.parse(consolidationTriggerAt)
    ? "trigger_due"
    : now >= Date.parse(consolidationEligibleAt)
      ? "eligible"
      : "active";
  return {
    ...memory,
    lifecycle: {
      kind,
      state,
      activityAt,
      consolidationEligibleAt,
      consolidationTriggerAt,
      triggersNextConsolidation: projection?.triggersNextConsolidation,
      willEnterNextConsolidation: projection?.willEnterNextConsolidation
    }
  };
}

function recentMemoryConsolidationProjection(
  roleDir: string,
  memories: RecentMemoryItem[]
): RecentMemoryConsolidationProjection {
  const cacheKey = memoryCatalogDirectory(roleDir, "recent");
  const cached = recentMemoryConsolidationProjectionCache.get(cacheKey);
  if (cached && cached.validUntil > Date.now()) return cached.projection;

  const cohort = recentMemoryConsolidationCohort(memories);
  const nextTrigger = cohort.trigger;
  const candidateIds = new Set(cohort.candidates.map((memory) => memory.id));
  const projection = new Map<string, RecentMemoryConsolidationProjectionItem>();
  for (const item of cohort.schedule) {
    projection.set(item.memory.id, {
      activityAt: item.activityAt,
      consolidationEligibleAt: item.consolidationEligibleAt,
      consolidationTriggerAt: item.consolidationTriggerAt,
      triggersNextConsolidation: item.memory.id === nextTrigger?.memory.id,
      willEnterNextConsolidation: candidateIds.has(item.memory.id)
    });
  }
  recentMemoryConsolidationProjectionCache.set(cacheKey, {
    validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS,
    projection
  });
  return projection;
}

export function presentRoleMemories<T extends RecentMemoryItem | ConsolidatedMemoryItem>(
  roleDir: string,
  memories: T[],
  kind: "recent" | "consolidated",
  now = Date.now()
): Array<T & { lifecycle: MemoryLifecyclePresentation }> {
  const projection = kind === "recent"
    ? recentMemoryConsolidationProjection(roleDir, memories as RecentMemoryItem[])
    : undefined;
  return memories.map((memory) => presentRoleMemory(memory, kind, now, projection));
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseKeywordValue(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeKeywords(value);
  const text = String(value || "").trim();
  if (!text) return [];
  const inner = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return normalizeKeywords(inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")));
}

function requireKeywords(keywords: string[], label: string): void {
  if (keywords.length === 0) {
    throw new RoleStorageValidationError(`${label} keywords are required.`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(100_000, Math.floor(parsed));
}

function boundedContextLimit(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function normalizeRoleContextInjection(value: unknown): RoleContextInjectionPolicy {
  const raw = recordValue(value);
  const defaults = raw.mode === "legacy"
    ? DEFAULT_LEGACY_CONTEXT_INJECTION
    : DEFAULT_FOCUSED_CONTEXT_INJECTION;
  const relevantKnowledgeLimit = raw.relevantKnowledgeLimit == null
    ? undefined
    : boundedContextLimit(raw.relevantKnowledgeLimit, defaults.requiredReadLimit, 1, 12);
  return {
    mode: defaults.mode,
    requiredReadLimit: relevantKnowledgeLimit ?? defaults.requiredReadLimit,
    matchedItemLimit: relevantKnowledgeLimit ?? defaults.matchedItemLimit,
    personaMaxChars: boundedContextLimit(raw.personaMaxChars, defaults.personaMaxChars, 800, 6000)
  };
}

export function roleContextInjectionPolicy(roleDir: string): RoleContextInjectionPolicy {
  const config = readJson<Record<string, unknown>>(path.join(roleDir, "personaConfig.json")) ?? {};
  return normalizeRoleContextInjection(config.contextInjection);
}

function mergeLimits<T extends Record<string, number>>(defaults: T, raw: unknown): T {
  const source = recordValue(raw);
  const output = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    output[key] = positiveLimit(source[String(key)], defaults[key]) as T[keyof T];
  }
  return output;
}

export function roleKnowledgeWriteLimits(roleDir: string): RoleKnowledgeWriteLimits {
  const config = readJson<Record<string, unknown>>(path.join(roleDir, "personaConfig.json")) ?? {};
  const knowledgeLimits = recordValue(config.knowledgeLimits);
  return {
    plan: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.plan, knowledgeLimits.plan),
    memory: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.memory, knowledgeLimits.memory)
  };
}

function textChars(value: unknown): number {
  return Array.from(String(value || "")).length;
}

function assertTextLimit(label: string, value: unknown, maximum: number): void {
  const actual = textChars(value);
  if (actual > maximum) {
    throw new RoleStorageValidationError(`${label} exceeds ${maximum} characters (received ${actual}). Split it into focused items.`);
  }
}

function assertSingleFocus(label: string, focus: string, maximum: number): void {
  if (!focus.trim()) throw new RoleStorageValidationError(`${label} focus is required.`);
  if (/\r|\n/.test(focus)) throw new RoleStorageValidationError(`${label} focus must be a single line and describe one subject.`);
  assertTextLimit(`${label} focus`, focus, maximum);
}

function assertKeywordLimits(label: string, keywords: string[], maximumItems: number, maximumChars: number): void {
  if (keywords.length > maximumItems) {
    throw new RoleStorageValidationError(`${label} has ${keywords.length} keywords; maximum is ${maximumItems}. Keep one focused subject.`);
  }
  for (const keyword of keywords) {
    assertTextLimit(`${label} keyword`, keyword, maximumChars);
  }
}

function approvalRequestText(contract: PlanApprovalRequest | undefined): unknown[] {
  if (!contract) return [];
  return [
    contract.approver,
    contract.request,
    contract.recommendation,
    ...(contract.alternatives || []),
    contract.reason,
    ...contract.files.flatMap((item) => [item.path, item.action, item.change, item.destination]),
    ...contract.commands.flatMap((item) => [item.command, item.purpose, item.expectedEffect]),
    ...contract.changes.flatMap((item) => [item.target, item.change, item.impact]),
    ...contract.validation,
    ...contract.rollback,
    ...contract.outOfScope,
    contract.requestedAt,
    contract.sourceMessageId,
    contract.feedbackId,
    contract.responseStatus
  ];
}

function planTextTotal(plan: PlanItem): number {
  return [
    plan.title,
    plan.focus,
    plan.currentStep,
    plan.currentStepId,
    plan.nextAction,
    plan.waitingFor,
    plan.blockedBy,
    plan.project?.name,
    plan.project?.path,
    plan.source?.kind,
    plan.source?.summary,
    plan.secretaryBinding?.agentType,
    plan.secretaryBinding?.sessionId,
    plan.secretaryBinding?.sessionTitle,
    plan.secretaryBinding?.workspace,
    plan.secretaryBinding?.baseUrl,
    plan.secretaryBinding?.assignedAt,
    plan.taskBinding?.agentType,
    plan.taskBinding?.sessionId,
    plan.taskBinding?.sessionTitle,
    plan.taskBinding?.workspace,
    plan.taskBinding?.baseUrl,
    plan.taskBinding?.completionHook?.gatewayId,
    ...plan.steps.flatMap((step) => [
      step.id,
      step.title,
      step.detail,
      step.waitingFor,
      step.blockedBy,
      step.startedAt,
      step.completedAt,
      ...approvalRequestText(step.approvalRequest)
    ]),
    ...plan.keywords
  ].reduce<number>((total, value) => total + textChars(value), 0);
}

export function currentPlanStep(plan: PlanItem): PlanStep | undefined {
  return plan.currentStepId
    ? plan.steps.find((step) => step.id === plan.currentStepId)
    : undefined;
}

export function planStepIsCompleted(step: PlanStep): boolean {
  return Boolean(step.completedAt);
}

function planHasApprovalIntent(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  if (step?.approvalRequest) {
    const responseStatus = step.approvalRequest.responseStatus;
    if (responseStatus === "approved" || responseStatus === "rejected" || responseStatus === "changes_requested" || responseStatus === "cancelled") return false;
    return true;
  }
  if (/human-gate/i.test(String(plan.kind || ""))) return true;
  const explicitGate = [
    step?.id,
    step?.title,
    step?.waitingFor,
    step?.blockedBy,
    plan.waitingFor,
    plan.blockedBy
  ];
  return explicitGate.some((signal) => {
    const normalized = String(signal || "").replace(/\s+/g, "");
    return /(等待|待|需要|未经).*(审批|批准|授权|审核|人工决策)|^(审批|批准|授权|审核|人工决策)/i.test(normalized);
  });
}

export function approvalRequestMissingFields(contract: PlanApprovalRequest | undefined): string[] {
  if (!contract) return [
    "approver",
    "request",
    "recommendation",
    "reason",
    "affectedActions",
    "validation",
    "rollback",
    "outOfScope",
    "requestedAt",
    "source",
    "responseStatus"
  ];
  const missing: string[] = [];
  if (!contract.approver?.trim()) missing.push("approver");
  if (!contract.request.trim()) missing.push("request");
  if (!contract.recommendation?.trim()) missing.push("recommendation");
  if (!contract.reason.trim()) missing.push("reason");
  const hasFile = contract.files.some((item) => item.path.trim() && item.change.trim() && (item.action !== "move" || item.destination?.trim()));
  const hasCommand = contract.commands.some((item) => item.command.trim() && item.purpose.trim());
  const hasChange = contract.changes.some((item) => item.target.trim() && item.change.trim());
  if (!hasFile && !hasCommand && !hasChange) missing.push("affectedActions");
  if (contract.validation.length === 0) missing.push("validation");
  if (contract.rollback.length === 0) missing.push("rollback");
  if (contract.outOfScope.length === 0) missing.push("outOfScope");
  if (!contract.requestedAt?.trim()) missing.push("requestedAt");
  if (!contract.sourceMessageId?.trim() && !contract.feedbackId?.trim()) missing.push("source");
  if (!contract.responseStatus) missing.push("responseStatus");
  return missing;
}

export function planApprovalGate(plan: PlanItem): PlanApprovalGate {
  if (!planHasApprovalIntent(plan)) return { state: "none", missing: [] };
  const step = currentPlanStep(plan);
  const contract = step?.approvalRequest;
  const missing = approvalRequestMissingFields(contract);
  return {
    state: missing.length === 0 ? "pending" : "preparing",
    stepId: step?.id,
    missing,
    contract
  };
}

export function planRequiresApproval(plan: PlanItem): boolean {
  return planApprovalGate(plan).state !== "none";
}

export function planAcceptsGuidance(plan: PlanItem, workflow: PersonaPlanWorkflow): boolean {
  return planStatusDefinition(workflow, plan.status, { allowRetired: true })?.acceptsGuidance === true
    && planApprovalGate(plan).state === "none";
}

function validateApprovalRequest(contract: PlanApprovalRequest, limits: PlanWriteLimits): void {
  assertTextLimit("Plan approvalRequest.approver", contract.approver, limits.approvalDetailChars);
  assertTextLimit("Plan approvalRequest.request", contract.request, limits.approvalRequestChars);
  assertTextLimit("Plan approvalRequest.recommendation", contract.recommendation, limits.approvalRequestChars);
  assertTextLimit("Plan approvalRequest.reason", contract.reason, limits.approvalReasonChars);
  if (contract.files.length > 50) throw new RoleStorageValidationError("Plan approvalRequest.files cannot contain more than 50 items.");
  if (contract.commands.length > 50) throw new RoleStorageValidationError("Plan approvalRequest.commands cannot contain more than 50 items.");
  if (contract.changes.length > 50) throw new RoleStorageValidationError("Plan approvalRequest.changes cannot contain more than 50 items.");
  for (const item of contract.files) {
    assertTextLimit("Plan approvalRequest file path", item.path, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest file destination", item.destination, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest file change", item.change, limits.approvalDetailChars);
  }
  for (const item of contract.commands) {
    assertTextLimit("Plan approvalRequest command", item.command, limits.approvalCommandChars);
    assertTextLimit("Plan approvalRequest command purpose", item.purpose, limits.approvalDetailChars);
    assertTextLimit("Plan approvalRequest command expectedEffect", item.expectedEffect, limits.approvalDetailChars);
  }
  for (const item of contract.changes) {
    assertTextLimit("Plan approvalRequest change target", item.target, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest change", item.change, limits.approvalDetailChars);
    assertTextLimit("Plan approvalRequest impact", item.impact, limits.approvalDetailChars);
  }
  for (const [label, items] of [
    ["alternatives", contract.alternatives || []],
    ["validation", contract.validation],
    ["rollback", contract.rollback],
    ["outOfScope", contract.outOfScope]
  ] as const) {
    if (items.length > 50) throw new RoleStorageValidationError(`Plan approvalRequest.${label} cannot contain more than 50 items.`);
    for (const item of items) assertTextLimit(`Plan approvalRequest.${label} item`, item, limits.approvalListItemChars);
  }
  assertTextLimit("Plan approvalRequest.requestedAt", contract.requestedAt, 80);
  assertTextLimit("Plan approvalRequest.sourceMessageId", contract.sourceMessageId, 240);
  assertTextLimit("Plan approvalRequest.feedbackId", contract.feedbackId, 240);
}

function memoryTextTotal(memory: RecentMemoryItem | ConsolidatedMemoryItem): number {
  return [
    memory.title,
    memory.focus,
    memory.content,
    memory.source?.kind,
    memory.source?.summary,
    ...memory.keywords
  ].reduce((total, value) => total + textChars(value), 0);
}

function validatePlanSteps(
  plan: PlanItem,
  limits: PlanWriteLimits,
  requireSteps: boolean,
  workflow: PersonaPlanWorkflow
): void {
  const status = assertWritablePlanStatus(workflow, plan.status);
  if (requireSteps && plan.steps.length === 0) {
    throw new RoleStorageValidationError("Plan steps are required. List every ordered step and identify the current step when work is in progress.");
  }
  if (plan.steps.length > limits.maxSteps) {
    throw new RoleStorageValidationError(`Plan has ${plan.steps.length} steps; maximum is ${limits.maxSteps}. Split the plan into focused plans.`);
  }

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id.trim()) throw new RoleStorageValidationError("Plan step id is required.");
    if (ids.has(step.id)) throw new RoleStorageValidationError(`Plan step id must be unique: ${step.id}`);
    ids.add(step.id);
    assertTextLimit("Plan step id", step.id, 80);
    assertTextLimit("Plan step title", step.title, limits.stepTitleChars);
    assertTextLimit("Plan step detail", step.detail, limits.stepDetailChars);
    assertTextLimit("Plan step waitingFor", step.waitingFor, limits.stepWaitingForChars);
    assertTextLimit("Plan step blockedBy", step.blockedBy, limits.stepBlockedByChars);
    if (step.isBlocked === true && !step.blockedBy?.trim()) {
      throw new RoleStorageValidationError("A blocked plan step must provide blockedBy.");
    }
    if (step.isBlocked === true && step.id !== plan.currentStepId) {
      throw new RoleStorageValidationError("Only the current plan step can be blocked.");
    }
    if (step.approvalRequest) validateApprovalRequest(step.approvalRequest, limits);
  }

  if (plan.currentStepId && !ids.has(plan.currentStepId)) {
    throw new RoleStorageValidationError(`Plan currentStepId does not match a step: ${plan.currentStepId}`);
  }
  if (plan.steps.length > 0 && status.currentStep === "required") {
    if (!plan.currentStepId) throw new RoleStorageValidationError("An active plan must provide currentStepId.");
  }
  if (status.currentStep === "forbidden" && plan.currentStepId) {
    throw new RoleStorageValidationError(`Plan status ${status.key} forbids currentStepId.`);
  }
  if (plan.archiveStatus === "已归档" && !status.archiveEligible) {
    throw new RoleStorageValidationError(`Plan status ${status.key} is not eligible for archival.`);
  }
  const approvalGate = planApprovalGate(plan);
  if (status.requiresApproval && approvalGate.state !== "pending") {
    throw new RoleStorageValidationError(`Plan status ${status.key} requires one complete pending approvalRequest on its current step.`);
  }
  if (approvalGate.state === "pending" && !status.requiresApproval) {
    throw new RoleStorageValidationError("A complete pending approvalRequest requires a plan status configured with requiresApproval=true.");
  }
}

function validatePlanWrite(
  roleDir: string,
  plan: PlanItem,
  requireSteps = false,
  limits = roleKnowledgeWriteLimits(roleDir).plan
): void {
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  const status = assertWritablePlanStatus(workflow, plan.status);
  assertTextLimit("Plan title", plan.title, limits.titleChars);
  assertSingleFocus("Plan", plan.focus, limits.focusChars);
  assertTextLimit("Plan currentStep", plan.currentStep, limits.currentStepChars);
  assertTextLimit("Plan nextAction", plan.nextAction, limits.nextActionChars);
  assertTextLimit("Plan waitingFor", plan.waitingFor, limits.waitingForChars);
  assertTextLimit("Plan blockedBy", plan.blockedBy, limits.blockedByChars);
  if (plan.isBlocked === true && !plan.blockedBy?.trim()) {
    throw new RoleStorageValidationError("A blocked plan must provide blockedBy.");
  }
  if (plan.isBlocked === true && !status.requiresApproval) {
    throw new RoleStorageValidationError("Only a plan status configured to require approval can be blocked by a pending approval.");
  }
  assertTextLimit("Plan source.summary", plan.source?.summary, limits.sourceSummaryChars);
  assertTextLimit("Plan taskBinding.sessionId", plan.taskBinding?.sessionId, 240);
  assertTextLimit("Plan taskBinding.sessionTitle", plan.taskBinding?.sessionTitle, 240);
  assertTextLimit("Plan taskBinding.workspace", plan.taskBinding?.workspace, 1000);
  assertTextLimit("Plan taskBinding.completionHook.gatewayId", plan.taskBinding?.completionHook?.gatewayId, 120);
  assertKeywordLimits("Plan", plan.keywords, limits.maxKeywords, limits.keywordChars);
  validatePlanSteps(plan, limits, requireSteps, workflow);
  const approvalGate = planApprovalGate(plan);
  if (approvalGate.state === "pending") {
    const step = currentPlanStep(plan);
    if (plan.isBlocked !== true || step?.isBlocked !== true) {
      throw new RoleStorageValidationError("Manager must derive isBlocked=true from a complete pending approval contract.");
    }
    if (!planBlockingReason(plan)) {
      throw new RoleStorageValidationError("An approval-blocked plan must identify the approver and requested decision.");
    }
  } else if (plan.isBlocked === true || plan.steps.some((step) => step.isBlocked === true)) {
    throw new RoleStorageValidationError("isBlocked is Manager-derived and is only valid for a complete pending approval contract.");
  }
  const total = planTextTotal(plan);
  if (total > limits.totalChars) {
    throw new RoleStorageValidationError(`Plan text exceeds ${limits.totalChars} characters in total (received ${total}). Split it into one plan per subject.`);
  }
}

function validateMemoryWrite(
  roleDir: string,
  memory: RecentMemoryItem | ConsolidatedMemoryItem,
  label = "Memory",
  limits = roleKnowledgeWriteLimits(roleDir).memory
): void {
  assertTextLimit(`${label} title`, memory.title, limits.titleChars);
  assertSingleFocus(label, memory.focus, limits.focusChars);
  assertTextLimit(`${label} content`, memory.content, limits.contentChars);
  assertTextLimit(`${label} source.summary`, memory.source?.summary, limits.sourceSummaryChars);
  assertKeywordLimits(label, memory.keywords, limits.maxKeywords, limits.keywordChars);
  const total = memoryTextTotal(memory);
  if (total > limits.totalChars) {
    throw new RoleStorageValidationError(`${label} text exceeds ${limits.totalChars} characters in total (received ${total}). Split it into one memory per subject.`);
  }
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeApprovalRequest(value: unknown): PlanApprovalRequest | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const files = Array.isArray(raw.files) ? raw.files.flatMap<PlanApprovalFileChange>((value) => {
    const item = recordValue(value);
    const action = item.action === "create" || item.action === "delete" || item.action === "move" ? item.action : "modify";
    return [{
      path: String(item.path || "").trim(),
      action,
      change: String(item.change || item.summary || "").trim(),
      destination: typeof item.destination === "string" ? item.destination.trim() || undefined : undefined
    }];
  }) : [];
  const commands = Array.isArray(raw.commands) ? raw.commands.flatMap<PlanApprovalCommand>((value) => {
    const item = recordValue(value);
    return [{
      command: String(item.command || "").trim(),
      purpose: String(item.purpose || "").trim(),
      expectedEffect: typeof item.expectedEffect === "string" ? item.expectedEffect.trim() || undefined : undefined
    }];
  }) : [];
  const changes = Array.isArray(raw.changes) ? raw.changes.flatMap<PlanApprovalExternalChange>((value) => {
    const item = recordValue(value);
    return [{
      target: String(item.target || "").trim(),
      change: String(item.change || item.summary || "").trim(),
      impact: typeof item.impact === "string" ? item.impact.trim() || undefined : undefined
    }];
  }) : [];
  return {
    approver: typeof raw.approver === "string" ? raw.approver.trim() || undefined : undefined,
    request: String(raw.request || "").trim(),
    recommendation: typeof raw.recommendation === "string" ? raw.recommendation.trim() || undefined : undefined,
    alternatives: normalizedStringList(raw.alternatives),
    reason: String(raw.reason || "").trim(),
    files,
    commands,
    changes,
    validation: normalizedStringList(raw.validation),
    rollback: normalizedStringList(raw.rollback),
    outOfScope: normalizedStringList(raw.outOfScope),
    requestedAt: typeof raw.requestedAt === "string" ? raw.requestedAt.trim() || undefined : undefined,
    sourceMessageId: typeof raw.sourceMessageId === "string" ? raw.sourceMessageId.trim() || undefined : undefined,
    feedbackId: typeof raw.feedbackId === "string" ? raw.feedbackId.trim() || undefined : undefined,
    responseStatus: raw.responseStatus === "approved"
      || raw.responseStatus === "rejected"
      || raw.responseStatus === "changes_requested"
      || raw.responseStatus === "cancelled"
      ? raw.responseStatus
      : raw.responseStatus === "pending"
        ? "pending"
        : undefined
  };
}

function normalizePlanSteps(value: unknown, legacyCompletedAt: string): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<PlanStep>((rawStep, index) => {
    if (typeof rawStep === "string") {
      const title = rawStep.trim();
      return title ? [{ id: `step-${index + 1}`, title }] : [];
    }
    const raw = recordValue(rawStep);
    const title = String(raw.title || raw.name || raw.label || "").trim();
    if (!title) return [];
    const rawStatus = String(raw.status || "").trim();
    const completedAt = typeof raw.completedAt === "string" && raw.completedAt
      ? raw.completedAt
      : rawStatus === "已完成" || raw.completed === true
        ? legacyCompletedAt
        : undefined;
    return [{
      id: String(raw.id || raw.stepId || `step-${index + 1}`).trim(),
      title,
      detail: typeof raw.detail === "string" ? raw.detail : typeof raw.description === "string" ? raw.description : undefined,
      waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
      isBlocked: typeof raw.isBlocked === "boolean" ? raw.isBlocked : undefined,
      blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : completedAt,
      completedAt,
      approvalRequest: normalizeApprovalRequest(raw.approvalRequest),
      questions: raw.questions == null ? undefined : normalizePlanQuestions(raw.questions)
    }];
  });
}

function planStepIdsWithClearedTime(value: unknown, field: "startedAt" | "completedAt"): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((rawStep, index) => {
    const raw = recordValue(rawStep);
    if (!Object.prototype.hasOwnProperty.call(raw, field) || raw[field]) return [];
    const id = String(raw.id || raw.stepId || `step-${index + 1}`).trim();
    return id ? [id] : [];
  }));
}

export function planIsBlocked(plan: PlanItem): boolean {
  return planApprovalGate(plan).state === "pending";
}

export function planBlockingReason(plan: PlanItem): string {
  const step = currentPlanStep(plan);
  const explicit = step?.blockedBy?.trim() || plan.blockedBy?.trim();
  if (explicit) return explicit;
  const contract = planApprovalGate(plan).contract;
  if (!contract) return "";
  const approver = contract.approver?.trim() || "审批人";
  return `等待${approver}审批：${contract.request.trim()}`;
}

function withDerivedPlanBlockingState(plan: PlanItem): PlanItem {
  const blocked = planIsBlocked(plan);
  const currentStepId = currentPlanStep(plan)?.id;
  const derivedReason = blocked ? planBlockingReason(plan) : "";
  return {
    ...plan,
    isBlocked: blocked ? true : undefined,
    blockedBy: blocked && !plan.blockedBy?.trim() ? derivedReason : plan.blockedBy,
    steps: plan.steps.map((step) => ({
      ...step,
      isBlocked: blocked && step.id === currentStepId ? true : undefined,
      blockedBy: blocked && step.id === currentStepId && !step.blockedBy?.trim()
        ? derivedReason
        : step.blockedBy
    }))
  };
}

function recordPlanStepTimes(
  steps: PlanStep[],
  previousSteps: PlanStep[],
  currentStepId: string | undefined,
  recordedAt: string,
  clearedStartedAt = new Set<string>(),
  clearedCompletedAt = new Set<string>()
): PlanStep[] {
  const previousById = new Map(previousSteps.map((step) => [step.id, step]));
  return steps.map((step) => {
    const previous = previousById.get(step.id);
    if (step.id === currentStepId) {
      return {
        ...step,
        startedAt: step.startedAt || (clearedStartedAt.has(step.id) ? undefined : previous?.startedAt) || recordedAt,
        completedAt: undefined
      };
    }
    const completedAt = step.completedAt || (clearedCompletedAt.has(step.id) ? undefined : previous?.completedAt);
    if (!completedAt) return { ...step, startedAt: undefined, completedAt: undefined };
    return {
      ...step,
      startedAt: step.startedAt || (clearedStartedAt.has(step.id) ? undefined : previous?.startedAt) || completedAt,
      completedAt
    };
  });
}

function validatePlanBindingBaseUrl(value: unknown, label: string): void {
  if (value == null) return;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.baseUrl must be a non-empty HTTP URL when provided.`);
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error(`${label}.baseUrl must be a non-empty HTTP URL when provided.`);
  }
}

function validatePlanTaskBindingInput(value: unknown): void {
  if (value == null) return;
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) throw new Error("Plan taskBinding must be an object with an Agent sessionId.");
  if (raw.agentType != null && raw.agentType !== "codex" && raw.agentType !== "dsh") {
    throw new Error(`Unsupported plan taskBinding agentType: ${String(raw.agentType)}`);
  }
  if (!String(raw.sessionId || "").trim()) throw new Error("Plan taskBinding.sessionId is required.");
  validatePlanBindingBaseUrl(raw.baseUrl, "Plan taskBinding");
  if (raw.completionHook != null) {
    const hook = recordValue(raw.completionHook);
    if (Object.keys(hook).length === 0) throw new Error("Plan taskBinding.completionHook must be an object.");
    if (typeof hook.enabled !== "boolean") throw new Error("Plan taskBinding.completionHook.enabled must be boolean.");
  }
}

function validatePlanSecretaryBindingInput(value: unknown): void {
  if (value == null) return;
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) throw new Error("Plan secretaryBinding must identify a configured secretary session.");
  if (raw.agentType != null && raw.agentType !== "codex" && raw.agentType !== "dsh") {
    throw new Error(`Unsupported plan secretaryBinding agentType: ${String(raw.agentType)}`);
  }
  if (!String(raw.sessionId || "").trim()) throw new Error("Plan secretaryBinding.sessionId is required.");
  if (!String(raw.workspace || "").trim()) throw new Error("Plan secretaryBinding.workspace is required.");
  validatePlanBindingBaseUrl(raw.baseUrl, "Plan secretaryBinding");
}

function normalizePlanSecretaryBinding(value: unknown): PlanSecretaryBinding | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const sessionId = String(raw.sessionId || "").trim();
  const workspace = String(raw.workspace || "").trim();
  if (!sessionId || !workspace) return undefined;
  return {
    agentType: raw.agentType === "dsh" ? "dsh" : "codex",
    sessionId,
    sessionTitle: typeof raw.sessionTitle === "string" ? raw.sessionTitle.trim() || undefined : undefined,
    workspace,
    ...(typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? { baseUrl: raw.baseUrl.trim() } : {}),
    assignedAt: typeof raw.assignedAt === "string" ? raw.assignedAt.trim() || undefined : undefined
  };
}

function normalizePlanTaskBinding(value: unknown): PlanTaskBinding | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const sessionId = String(raw.sessionId || "").trim();
  if (!sessionId) return undefined;
  const hook = recordValue(raw.completionHook);
  return {
    agentType: raw.agentType === "dsh" ? "dsh" : "codex",
    sessionId,
    sessionTitle: typeof raw.sessionTitle === "string" ? raw.sessionTitle.trim() || undefined : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace.trim() || undefined : undefined,
    ...(typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? { baseUrl: raw.baseUrl.trim() } : {}),
    completionHook: {
      enabled: hook.enabled !== false,
      gatewayId: typeof hook.gatewayId === "string" ? hook.gatewayId.trim() || undefined : undefined
    }
  };
}

function validatePlanStatusInput(workflow: PersonaPlanWorkflow, value: unknown): void {
  if (value === undefined) return;
  assertWritablePlanStatus(workflow, value);
}

function normalizedPlanStatus(raw: Partial<PlanItem> & Record<string, unknown>): PlanStatus {
  const value = typeof raw.status === "string" ? raw.status.trim() : "";
  return value;
}

function normalizePlan(raw: Partial<PlanItem> & Record<string, unknown>, fallbackId?: string): PlanItem | null {
  const title = String(raw.title || "").trim();
  if (!title) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  const status = normalizedPlanStatus(raw);
  const steps = normalizePlanSteps(raw.steps, updatedAt);
  const explicitCurrentStepId = typeof raw.currentStepId === "string" ? raw.currentStepId.trim() : "";
  const legacyCurrentStepId = Array.isArray(raw.steps)
    ? raw.steps.flatMap((rawStep, index) => {
        const value = recordValue(rawStep);
        const isCurrent = value.status === "进行中" || value.current === true;
        return isCurrent ? [String(value.id || value.stepId || `step-${index + 1}`).trim()] : [];
      })[0]
    : undefined;
  const currentStepId = explicitCurrentStepId || legacyCurrentStepId;
  const archiveStatus: PlanArchiveStatus = raw.archiveStatus === "已归档"
    ? "已归档"
    : raw.archiveStatus === "未归档"
      ? "未归档"
      : (raw as Record<string, unknown>).status === "已归档" || (typeof raw.archivedAt === "string" && Boolean(raw.archivedAt.trim()))
        ? "已归档"
        : "未归档";
  return withDerivedPlanBlockingState({
    id: canonicalLogicalPlanId(raw.id || fallbackId || generatedId("plan", title)),
    title,
    focus: String(raw.focus || title).trim(),
    status,
    archiveStatus,
    importance: typeof raw.importance === "number" && Number.isInteger(raw.importance) && raw.importance >= 0 && raw.importance <= 4
      ? raw.importance as PlanImportanceLevel
      : undefined,
    urgency: typeof raw.urgency === "number" && Number.isInteger(raw.urgency) && raw.urgency >= 0 && raw.urgency <= 4
      ? raw.urgency as PlanUrgencyLevel
      : undefined,
    priority: typeof raw.priority === "string" ? raw.priority : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    currentStep: typeof raw.currentStep === "string" ? raw.currentStep : undefined,
    currentStepId: currentStepId || undefined,
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction : undefined,
    waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
    isBlocked: typeof raw.isBlocked === "boolean" ? raw.isBlocked : undefined,
    blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
    attachments: normalizeStoredPlanAttachments(raw.attachments),
    steps,
    project: raw.project && typeof raw.project === "object" && !Array.isArray(raw.project) ? raw.project as PlanItem["project"] : undefined,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    secretaryBinding: normalizePlanSecretaryBinding(raw.secretaryBinding),
    taskBinding: normalizePlanTaskBinding(raw.taskBinding),
    messageChannels: raw.messageChannels === undefined ? undefined : normalizePlanMessageChannels(raw.messageChannels),
    dueAt: typeof raw.dueAt === "string" ? raw.dueAt : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    archivedAt: archiveStatus === "已归档" && typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    storageRevision: typeof raw.storageRevision === "string" && raw.storageRevision
      ? raw.storageRevision
      : undefined,
    storageMutationRequestId: typeof raw.storageMutationRequestId === "string" && raw.storageMutationRequestId
      ? raw.storageMutationRequestId
      : undefined,
    keywords: normalizeKeywords(raw.keywords)
  });
}

function normalizeRecentMemory(raw: Partial<RecentMemoryItem> & Record<string, unknown>, fallbackId?: string): RecentMemoryItem | null {
  const title = String(raw.title || "").trim();
  const content = String(raw.content || "").trim();
  if (!title || !content) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  return {
    id: String(raw.id || fallbackId || generatedId("memory", title)),
    title,
    focus: String(raw.focus || title).trim(),
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    storageRevision: typeof raw.storageRevision === "string" && raw.storageRevision
      ? raw.storageRevision
      : undefined,
    storageMutationRequestId: typeof raw.storageMutationRequestId === "string" && raw.storageMutationRequestId
      ? raw.storageMutationRequestId
      : undefined,
    viewedAt: typeof raw.viewedAt === "string" ? raw.viewedAt : undefined,
    recalledAt: typeof raw.recalledAt === "string" ? raw.recalledAt : undefined,
    consolidatedAt: typeof raw.consolidatedAt === "string" ? raw.consolidatedAt : undefined,
    consolidationRunId: typeof raw.consolidationRunId === "string" ? raw.consolidationRunId : undefined,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function normalizeConsolidatedMemory(raw: Partial<ConsolidatedMemoryItem> & Record<string, unknown>, fallbackId?: string): ConsolidatedMemoryItem | null {
  const title = String(raw.title || "").trim();
  const content = String(raw.content || "").trim();
  if (!title || !content) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  return {
    id: String(raw.id || fallbackId || generatedId("consolidated-memory", title)),
    title,
    focus: String(raw.focus || title).trim(),
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    storageRevision: typeof raw.storageRevision === "string" && raw.storageRevision
      ? raw.storageRevision
      : undefined,
    storageMutationRequestId: typeof raw.storageMutationRequestId === "string" && raw.storageMutationRequestId
      ? raw.storageMutationRequestId
      : undefined,
    viewedAt: typeof raw.viewedAt === "string" ? raw.viewedAt : undefined,
    recalledAt: typeof raw.recalledAt === "string" ? raw.recalledAt : undefined,
    inputMemoryIds: Array.isArray(raw.inputMemoryIds) ? raw.inputMemoryIds.map(String) : undefined,
    consolidationRunId: typeof raw.consolidationRunId === "string" ? raw.consolidationRunId : undefined,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function parseSkillMarkdown(filePath: string): RoleSkillDetail | null {
  const raw = fs.readFileSync(filePath, "utf8");
  const metadata: Record<string, string> = {};
  let content = raw.trim();
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatter) {
    content = raw.slice(frontmatter[0].length).trim();
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (pair) {
        metadata[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  const fallbackId = path.basename(filePath, ".md");
  const title = String(metadata.title || content.match(/^#\s+(.+)$/m)?.[1] || fallbackId).trim();
  const summary = String(metadata.summary || content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) || "").trim();
  const keywords = parseKeywordValue(metadata.keywords);
  if (!title || !summary || keywords.length === 0) return null;

  const statusText = String(metadata.status || "active").trim();
  const status: RoleSkillStatus = statusText === "draft" || statusText === "archived" ? statusText : "active";
  const sourceSummary = String(metadata.source || "").trim();
  return {
    id: String(metadata.id || fallbackId).trim(),
    title,
    summary,
    source: sourceSummary ? { kind: "skill", summary: sourceSummary } : undefined,
    updatedAt: String(metadata.updatedAt || "").trim() || fs.statSync(filePath).mtime.toISOString(),
    status,
    keywords,
    path: filePath,
    content
  };
}

function plansDir(roleDir: string): string {
  return path.join(roleDir, "plans");
}

function memoryDir(roleDir: string): string {
  return path.join(roleDir, "memory");
}

function skillsDir(roleDir: string): string {
  return path.join(roleDir, "skills");
}

function planFile(roleDir: string, plan: PlanItem): string {
  return planJsonFile(roleDir, plan.id, planBucketForArchiveStatus(plan.archiveStatus));
}

function planHistoryFiles(roleDir: string, planId: string): string[] {
  return [
    planStorageHistoryFile(roleDir, planId, "active"),
    planStorageHistoryFile(roleDir, planId, "archive")
  ];
}

function planLifecycleTransactionId(kind: "plan-create" | "plan-update" | "plan-archive", ...identity: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${kind}-${digest.slice(0, 48)}`;
}

function planHistoryFile(roleDir: string, plan: Pick<PlanItem, "id" | "archiveStatus">): string {
  return planStorageHistoryFile(roleDir, plan.id, planBucketForArchiveStatus(plan.archiveStatus));
}

function planHistoryKind(before: PlanItem | undefined, after: PlanItem): PlanHistoryRecord["kind"] {
  if (!before) return "created";
  if (before.archiveStatus !== "已归档" && after.archiveStatus === "已归档") return "archived";
  return "updated";
}

function createPlanHistoryRecord(before: PlanItem | undefined, after: PlanItem): PlanHistoryRecord {
  const recordedAt = after.updatedAt || nowIso();
  return {
    id: generatedId("plan-history", `${after.id}-${recordedAt}`),
    planId: after.id,
    kind: planHistoryKind(before, after),
    recordedAt,
    ...(before ? { before } : {}),
    after
  };
}

function appendPlanHistoryContent(current: string, record: PlanHistoryRecord): string {
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  return `${prefix}${JSON.stringify(record)}\n`;
}

export function listPlanHistory(roleDir: string, planId: string): PlanHistoryRecord[] {
  const canonicalPlanId = canonicalLogicalPlanId(planId);
  const records = new Map<string, PlanHistoryRecord>();
  for (const filePath of planHistoryFiles(roleDir, canonicalPlanId)) {
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as Partial<PlanHistoryRecord>;
        if (!value.id || value.planId !== canonicalPlanId || !value.recordedAt || !value.after || typeof value.after !== "object") continue;
        if (value.kind !== "created" && value.kind !== "updated" && value.kind !== "archived") continue;
        records.set(value.id, {
          id: value.id,
          planId: canonicalPlanId,
          kind: value.kind,
          recordedAt: value.recordedAt,
          ...(value.before && typeof value.before === "object" ? { before: value.before as PlanItem } : {}),
          after: value.after as PlanItem
        });
      } catch {
        // A damaged audit line must not hide later valid history entries.
      }
    }
  }
  return [...records.values()].sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
}

function recentMemoryFile(roleDir: string, memory: RecentMemoryItem): string {
  return path.join(memoryDir(roleDir), "recent", `${safeIdPart(memory.id) || "memory"}.md`);
}

function consolidatedMemoryFile(roleDir: string, memory: ConsolidatedMemoryItem): string {
  return path.join(memoryDir(roleDir), "consolidated", `${safeIdPart(memory.id) || "consolidated-memory"}.md`);
}

function consolidationRunFile(roleDir: string, runId: string): string {
  return path.join(memoryDir(roleDir), "consolidation-runs", `${safeIdPart(runId) || "run"}.json`);
}

function allPlanFiles(roleDir: string): string[] {
  return [
    ...planJsonFilesInBucket(roleDir, "active"),
    ...planJsonFilesInBucket(roleDir, "archive")
  ].sort();
}

type PlanListCacheEntry = {
  signature: string;
  validUntil: number;
  plans: PlanItem[];
};

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function immutablePublication<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function immutablePlanCatalog(plans: PlanItem[]): PlanItem[] {
  return immutablePublication(plans);
}

type PlanFileCacheEntry = {
  size: number;
  mtimeMs: number;
  plan: PlanItem | null;
};

const PLAN_LIST_CACHE_TTL_MS = 500;
const PLAN_LIST_WATCH_DEBOUNCE_MS = 120;
const planListCache = new Map<string, PlanListCacheEntry>();
const planFileCache = new Map<string, Map<string, PlanFileCacheEntry>>();
const planListWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const planListDirtyAt = new Map<string, number>();
const planListDirtyFiles = new Map<string, Set<string> | null>();
const planListRefreshTimers = new Map<string, NodeJS.Timeout>();
const planListRefreshInFlight = new Set<string>();
const planListLoadInFlight = new Map<string, Promise<PlanItem[]>>();
const planListGeneration = new Map<string, number>();

function planListCacheKey(roleDir: string): string {
  return path.resolve(roleDir);
}

function clearPlanListCache(roleDir: string): void {
  const cacheKey = planListCacheKey(roleDir);
  planListGeneration.set(cacheKey, (planListGeneration.get(cacheKey) ?? 0) + 1);
  planListCache.delete(cacheKey);
  planFileCache.delete(cacheKey);
  planListDirtyAt.delete(cacheKey);
  planListDirtyFiles.delete(cacheKey);
  const timer = planListRefreshTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  planListRefreshTimers.delete(cacheKey);
  const watchers = planListWatchers.get(cacheKey);
  for (const watcher of watchers?.values() || []) watcher.close();
  planListWatchers.delete(cacheKey);
}

subscribePlanStorageBeforeMutation(({ roleDir }) => clearPlanListCache(roleDir));

function markPlanListCacheDirty(roleDir: string, filePath?: string): void {
  const cacheKey = planListCacheKey(roleDir);
  planListDirtyAt.set(cacheKey, Date.now());
  if (!filePath) {
    planListDirtyFiles.set(cacheKey, null);
    schedulePlanListCacheRefresh(roleDir);
    return;
  }
  const current = planListDirtyFiles.get(cacheKey);
  if (current === null) {
    schedulePlanListCacheRefresh(roleDir);
    return;
  }
  const dirtyFiles = current || new Set<string>();
  dirtyFiles.add(path.resolve(filePath));
  planListDirtyFiles.set(cacheKey, dirtyFiles);
  schedulePlanListCacheRefresh(roleDir);
}

function readPlansWithFileCache(roleDir: string, files: string[]): { signature: string; items: PlanItem[] } {
  const cacheKey = planListCacheKey(roleDir);
  let cachedFiles = planFileCache.get(cacheKey);
  if (!cachedFiles) {
    cachedFiles = new Map<string, PlanFileCacheEntry>();
    planFileCache.set(cacheKey, cachedFiles);
  }
  const resolvedFiles = files.map((filePath) => path.resolve(filePath));
  const currentFiles = new Set(resolvedFiles);
  for (const filePath of cachedFiles.keys()) {
    if (!currentFiles.has(filePath)) cachedFiles.delete(filePath);
  }
  const signatureParts: string[] = [];
  const items: PlanItem[] = [];
  for (const filePath of resolvedFiles) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cachedFiles.delete(filePath);
      signatureParts.push(`${filePath}\u001fmissing`);
      continue;
    }
    signatureParts.push(`${filePath}\u001f${stat.size}\u001f${stat.mtimeMs}`);
    let cachedFile = cachedFiles.get(filePath);
    if (!cachedFile || cachedFile.size !== stat.size || cachedFile.mtimeMs !== stat.mtimeMs) {
      const raw = readJson<Record<string, unknown>>(filePath);
      cachedFile = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        plan: raw ? normalizePlan(raw) : null
      };
      cachedFiles.set(filePath, cachedFile);
    }
    if (cachedFile.plan) items.push(cachedFile.plan);
  }
  return { signature: signatureParts.join("\u001e"), items };
}

function plansFromFileCache(roleDir: string): { signature: string; items: PlanItem[] } | null {
  const cachedFiles = planFileCache.get(planListCacheKey(roleDir));
  if (!cachedFiles) return null;
  const activePrefix = `${path.resolve(path.join(plansDir(roleDir), "active"))}${path.sep}`;
  const entries = [...cachedFiles.entries()].sort(([left], [right]) => {
    const priorityDelta = Number(!left.startsWith(activePrefix)) - Number(!right.startsWith(activePrefix));
    return priorityDelta || left.localeCompare(right);
  });
  return {
    signature: entries.map(([filePath, entry]) => `${filePath}\u001f${entry.size}\u001f${entry.mtimeMs}`).join("\u001e"),
    items: entries.flatMap(([, entry]) => entry.plan ? [entry.plan] : [])
  };
}

function uniquePlans(items: PlanItem[]): PlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      throw new Error(`Plan storage conflict for ${item.id}: the stable plan id exists in more than one storage bucket.`);
    }
    seen.add(item.id);
    return true;
  });
}

type AsyncPlanFileCacheResult = {
  filePath: string;
  entry?: PlanFileCacheEntry;
  missing?: boolean;
  retry?: boolean;
};

async function readChangedPlanFile(filePath: string, retryOnTransient = true): Promise<AsyncPlanFileCacheResult> {
  try {
    const [stat, text] = await Promise.all([
      fs.promises.stat(filePath),
      fs.promises.readFile(filePath, "utf8")
    ]);
    const after = await fs.promises.stat(filePath);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      return { filePath, retry: true };
    }
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (retryOnTransient) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return readChangedPlanFile(filePath, false);
      }
    }
    return {
      filePath,
      entry: {
        size: after.size,
        mtimeMs: after.mtimeMs,
        plan: raw ? normalizePlan(raw) : null
      }
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? { filePath, missing: true } : { filePath, retry: true };
  }
}

function awaitAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      value => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}

async function allPlanFilesAsync(roleDir: string, signal?: AbortSignal): Promise<string[]> {
  const storageGroups = await Promise.all((["active", "archive"] as const).map(async (bucket) => {
    const directory = path.join(plansDir(roleDir), bucket);
    try {
      const entries = await awaitAbortable(
        fs.promises.readdir(directory, { withFileTypes: true }),
        signal
      );
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name, "plan.json"))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }));
  return storageGroups.flat().sort((left, right) => left.localeCompare(right));
}

async function readPlanFileForCatalog(filePath: string): Promise<AsyncPlanFileCacheResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readChangedPlanFile(filePath);
    if (!result.retry) return result;
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  return { filePath, retry: true };
}

function schedulePlanListCacheRefresh(roleDir: string): void {
  const cacheKey = planListCacheKey(roleDir);
  const current = planListRefreshTimers.get(cacheKey);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    planListRefreshTimers.delete(cacheKey);
    void refreshPlanListCacheFromDirtyFiles(roleDir);
  }, PLAN_LIST_WATCH_DEBOUNCE_MS);
  timer.unref?.();
  planListRefreshTimers.set(cacheKey, timer);
}

async function refreshPlanListCacheFromDirtyFiles(roleDir: string): Promise<void> {
  const cacheKey = planListCacheKey(roleDir);
  if (planListRefreshInFlight.has(cacheKey)) return;
  const dirtyFiles = planListDirtyFiles.get(cacheKey);
  const cachedFiles = planFileCache.get(cacheKey);
  if (dirtyFiles === undefined || !cachedFiles || !planListCache.has(cacheKey)) return;
  planListDirtyFiles.delete(cacheKey);
  planListDirtyAt.delete(cacheKey);
  planListRefreshInFlight.add(cacheKey);
  await measurePerformanceOperation(PERFORMANCE_OPERATIONS.managerPlanCatalogRefresh, async () => {
    if (dirtyFiles === null) {
      const files = await allPlanFilesAsync(roleDir);
      const results = await Promise.all(files.map((filePath) => readPlanFileForCatalog(filePath)));
      if (results.some((result) => result.retry)) {
        markPlanListCacheDirty(roleDir);
        return;
      }
      const refreshedFiles = new Map<string, PlanFileCacheEntry>();
      for (const result of results) {
        if (result.entry) refreshedFiles.set(path.resolve(result.filePath), result.entry);
      }
      planFileCache.set(cacheKey, refreshedFiles);
      const refreshed = plansFromFileCache(roleDir) ?? { signature: "", items: [] };
      planListCache.set(cacheKey, {
        signature: refreshed.signature,
        validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
        plans: immutablePlanCatalog(uniquePlans(refreshed.items))
      });
      return;
    }
    if (!dirtyFiles.size) return;
    const results = await Promise.all([...dirtyFiles].map((filePath) => readChangedPlanFile(filePath)));
    for (const result of results) {
      if (result.missing) cachedFiles.delete(result.filePath);
      else if (result.entry) cachedFiles.set(result.filePath, result.entry);
      else if (result.retry) markPlanListCacheDirty(roleDir, result.filePath);
    }
    const refreshed = plansFromFileCache(roleDir);
    if (refreshed) {
      planListCache.set(cacheKey, {
        signature: refreshed.signature,
        validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
        plans: immutablePlanCatalog(uniquePlans(refreshed.items))
      });
    }
  }).finally(() => {
    planListRefreshInFlight.delete(cacheKey);
    if (planListDirtyFiles.has(cacheKey) && !planListRefreshTimers.has(cacheKey)) {
      schedulePlanListCacheRefresh(roleDir);
    }
  });
}

function updatePlanListCacheAfterWrite(
  roleDir: string,
  destination: string,
  plan: PlanItem,
  relatedFiles: string[],
  previousCache?: {
    catalog?: PlanListCacheEntry;
    files?: Map<string, PlanFileCacheEntry>;
  }
): void {
  const cacheKey = planListCacheKey(roleDir);
  const cachedFiles = planFileCache.get(cacheKey) ?? previousCache?.files;
  const cachedCatalog = planListCache.get(cacheKey) ?? previousCache?.catalog;
  if (!cachedCatalog) {
    clearPlanListCache(roleDir);
    return;
  }
  if (!cachedFiles) {
    const plans = immutablePlanCatalog(uniquePlans([
      ...cachedCatalog.plans.filter((item) => item.id !== plan.id),
      structuredClone(plan)
    ]));
    planListCache.set(cacheKey, {
      signature: JSON.stringify(plans.map((item) => [item.id, item.status, item.updatedAt])),
      validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
      plans
    });
    planListDirtyAt.delete(cacheKey);
    planListDirtyFiles.delete(cacheKey);
    return;
  }
  const resolvedFiles = [...new Set(relatedFiles.map((filePath) => path.resolve(filePath)))];
  for (const filePath of resolvedFiles) cachedFiles.delete(filePath);
  const resolvedDestination = path.resolve(destination);
  try {
    const stat = fs.statSync(resolvedDestination);
    cachedFiles.set(resolvedDestination, { size: stat.size, mtimeMs: stat.mtimeMs, plan });
  } catch {
    clearPlanListCache(roleDir);
    return;
  }
  planFileCache.set(cacheKey, cachedFiles);
  const refreshed = plansFromFileCache(roleDir);
  if (!refreshed) {
    clearPlanListCache(roleDir);
    return;
  }
  planListCache.set(cacheKey, {
    signature: refreshed.signature,
    validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
    plans: immutablePlanCatalog(uniquePlans(refreshed.items))
  });
  const dirtyFiles = planListDirtyFiles.get(cacheKey);
  if (dirtyFiles instanceof Set) {
    for (const filePath of resolvedFiles) dirtyFiles.delete(filePath);
    dirtyFiles.delete(resolvedDestination);
    if (!dirtyFiles.size) {
      planListDirtyFiles.delete(cacheKey);
      planListDirtyAt.delete(cacheKey);
    }
  }
}

function ensurePlanListWatchers(roleDir: string): boolean {
  const cacheKey = planListCacheKey(roleDir);
  const directory = plansDir(roleDir);
  // fs.watch() itself is a synchronous Windows call. Never invoke it against
  // shared persona storage: an unavailable SMB server would block Manager's
  // health event loop before a Promise or timeout could run. UNC catalogs use
  // the existing async read + bounded TTL fallback instead.
  if (requiresWorkerFilesystemAccess(directory)) return false;
  if (!fs.existsSync(directory)) return false;
  let watchers = planListWatchers.get(cacheKey);
  if (!watchers) {
    watchers = new Map<string, fs.FSWatcher>();
    planListWatchers.set(cacheKey, watchers);
  }
  if (watchers.has(directory)) return true;
  try {
    const watcher = fs.watch(directory, { persistent: false, recursive: true }, (_eventType, fileName) => {
      if (!fs.existsSync(directory)) {
        watcher.close();
        watchers?.delete(directory);
        markPlanListCacheDirty(roleDir);
        return;
      }
      if (!fileName) {
        markPlanListCacheDirty(roleDir);
        return;
      }
      const relativeName = fileName.toString();
      if (!relativeName.toLowerCase().endsWith(".json")) return;
      markPlanListCacheDirty(roleDir, path.join(directory, relativeName));
    });
    watcher.unref();
    watcher.on("error", () => {
      watcher.close();
      watchers?.delete(directory);
      markPlanListCacheDirty(roleDir);
    });
    watchers.set(directory, watcher);
    return true;
  } catch {
    // Recursive watching is unavailable on this filesystem. The 500 ms TTL below is the fallback.
    return false;
  }
}

type PlanRecord = {
  filePath: string;
  plan: PlanItem;
};

function planCandidateFiles(roleDir: string, planId: string): string[] {
  return [
    planJsonFile(roleDir, planId, "active"),
    planJsonFile(roleDir, planId, "archive")
  ];
}

function planRecordFromFile(filePath: string, planId: string): PlanRecord | null {
  const raw = readJson<Record<string, unknown>>(filePath);
  const plan = raw ? normalizePlan(raw) : null;
  return plan?.id === planId ? { filePath, plan } : null;
}

function findPlanRecord(roleDir: string, planId: string): PlanRecord | null {
  const candidates = planCandidateFiles(roleDir, planId);
  const records: PlanRecord[] = [];
  for (const filePath of candidates) {
    const record = planRecordFromFile(filePath, planId);
    if (record) records.push(record);
  }
  const candidateSet = new Set(candidates.map((filePath) => path.resolve(filePath)));
  for (const filePath of allPlanFiles(roleDir)) {
    if (candidateSet.has(path.resolve(filePath))) continue;
    if (readPlanIdentity(filePath) !== planId) continue;
    const record = planRecordFromFile(filePath, planId);
    if (record) records.push(record);
  }
  if (records.length > 1) {
    throw new Error(`Plan storage conflict for ${planId}: the stable plan id exists in more than one storage bucket.`);
  }
  return records[0] ?? null;
}

export function listPlans(roleDir: string): PlanItem[] {
  const cacheKey = planListCacheKey(roleDir);
  const cached = planListCache.get(cacheKey);
  if (cached) return cached.plans;
  throw new RoleKnowledgeCacheUnavailableError(roleDir);
}

/**
 * Authoritative synchronous storage scan for a bounded child/startup worker.
 * Manager request and event paths must use listPlans()/publishedRolePlans()
 * and treat RoleKnowledgeCacheUnavailableError as an explicit cold state.
 */
export function readPlansFromStorageInWorker(roleDir: string): PlanItem[] {
  const cacheKey = planListCacheKey(roleDir);
  const now = Date.now();
  try {
    const files = allPlanFiles(roleDir);
    const { signature, items } = readPlansWithFileCache(roleDir, files);
    const plans = immutablePlanCatalog(uniquePlans(items));
    planListCache.set(cacheKey, { signature, validUntil: now + PLAN_LIST_CACHE_TTL_MS, plans });
    planListDirtyAt.delete(cacheKey);
    planListDirtyFiles.delete(cacheKey);
    return plans;
  } catch (error) {
    clearPlanListCache(roleDir);
    throw error;
  }
}

export async function listPlansAsync(
  roleDir: string,
  options: { watch?: boolean } = {}
): Promise<PlanItem[]> {
  const cacheKey = planListCacheKey(roleDir);
  const cached = planListCache.get(cacheKey);
  const watchBacked = options.watch !== false && ensurePlanListWatchers(roleDir);
  const dirtyAt = planListDirtyAt.get(cacheKey);
  if (cached && watchBacked && dirtyAt === undefined) {
    recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerPlanCatalogCacheHit, 0);
    return cached.plans;
  }
  if (cached && watchBacked && dirtyAt !== undefined) {
    if (!planListRefreshTimers.has(cacheKey)) schedulePlanListCacheRefresh(roleDir);
    recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerPlanCatalogCacheHit, 0);
    return cached.plans;
  }
  if (cached && !watchBacked && cached.validUntil > Date.now()) {
    recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerPlanCatalogCacheHit, 0);
    return cached.plans;
  }

  const existingLoad = planListLoadInFlight.get(cacheKey);
  if (existingLoad) return existingLoad;
  let load!: Promise<PlanItem[]>;
  load = measurePerformanceOperation(PERFORMANCE_OPERATIONS.managerPlanCatalogColdLoad, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = planListGeneration.get(cacheKey) ?? 0;
      const loadStartedAt = Date.now();
      const files = await allPlanFilesAsync(roleDir);
      const results = await Promise.all(files.map((filePath) => readPlanFileForCatalog(filePath)));
      const retry = results.find((result) => result.retry);
      if (retry || generation !== (planListGeneration.get(cacheKey) ?? 0)) continue;
      const cachedFiles = new Map<string, PlanFileCacheEntry>();
      for (const result of results) {
        if (result.entry) cachedFiles.set(path.resolve(result.filePath), result.entry);
      }
      planFileCache.set(cacheKey, cachedFiles);
      const refreshed = plansFromFileCache(roleDir) ?? { signature: "", items: [] };
      const plans = immutablePlanCatalog(uniquePlans(refreshed.items));
      planListCache.set(cacheKey, {
        signature: refreshed.signature,
        validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
        plans
      });
      const changedDuringLoad = (planListDirtyAt.get(cacheKey) ?? 0) > loadStartedAt;
      if (changedDuringLoad) {
        if (planListDirtyFiles.get(cacheKey) instanceof Set && !planListRefreshTimers.has(cacheKey)) {
          schedulePlanListCacheRefresh(roleDir);
        }
      } else {
        planListDirtyAt.delete(cacheKey);
        planListDirtyFiles.delete(cacheKey);
      }
      return plans;
    }
    throw new Error("Plan catalog kept changing while loading; retry shortly.");
  }).catch((error) => {
    if (!cached) clearPlanListCache(roleDir);
    throw error;
  }).finally(() => {
    if (planListLoadInFlight.get(cacheKey) === load) planListLoadInFlight.delete(cacheKey);
  });
  planListLoadInFlight.set(cacheKey, load);
  return load;
}

export function getPlan(roleDir: string, planId: string): PlanItem | null {
  const canonicalPlanId = canonicalLogicalPlanId(planId);
  const cacheKey = planListCacheKey(roleDir);
  const cached = planListCache.get(cacheKey);
  const dirtyFiles = planListDirtyFiles.get(cacheKey);
  if (cached && dirtyFiles !== null) {
    const candidateFiles = planCandidateFiles(roleDir, canonicalPlanId).map((filePath) => path.resolve(filePath));
    const targetIsDirty = dirtyFiles instanceof Set
      && candidateFiles.some((filePath) => dirtyFiles.has(filePath));
    if (!targetIsDirty) {
      const cachedPlan = cached.plans.find((plan) => plan.id === canonicalPlanId);
      if (cachedPlan) return cachedPlan;
    }
  }
  return findPlanRecord(roleDir, canonicalPlanId)?.plan ?? null;
}

const PLAN_BY_ID_ASYNC_READ_CONCURRENCY = 8;

async function readPlanRecordAsync(
  filePath: string,
  planId: string,
  signal?: AbortSignal
): Promise<PlanRecord | null> {
  signal?.throwIfAborted();
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  signal?.throwIfAborted();
  try {
    const plan = normalizePlan(JSON.parse(text) as Record<string, unknown>);
    return plan?.id === planId ? { filePath, plan } : null;
  } catch {
    return null;
  }
}

/**
 * Reads one plan without synchronous filesystem work. Recovery workers use
 * this path so a slow UNC role root remains cancellable and cannot pin an
 * event loop while resolving feedback ledgers back to their owning plans.
 */
export async function getPlanAsync(
  roleDir: string,
  planId: string,
  options: { signal?: AbortSignal } = {}
): Promise<PlanItem | null> {
  const canonicalPlanId = canonicalLogicalPlanId(planId);
  const { signal } = options;
  signal?.throwIfAborted();
  const candidates = planCandidateFiles(roleDir, canonicalPlanId);
  const matches: PlanRecord[] = [];
  const candidateRecords = await Promise.all(
    candidates.map((filePath) => readPlanRecordAsync(filePath, canonicalPlanId, signal))
  );
  matches.push(...candidateRecords.filter((record): record is PlanRecord => record !== null));

  const candidateSet = new Set(candidates.map(filePath => path.resolve(filePath)));
  const fallbackFiles = (await allPlanFilesAsync(roleDir, signal))
    .filter(filePath => !candidateSet.has(path.resolve(filePath)));
  signal?.throwIfAborted();
  for (let offset = 0; offset < fallbackFiles.length; offset += PLAN_BY_ID_ASYNC_READ_CONCURRENCY) {
    const records = await Promise.all(
      fallbackFiles
        .slice(offset, offset + PLAN_BY_ID_ASYNC_READ_CONCURRENCY)
        .map(async filePath => await readPlanIdentityAsync(filePath, signal) === canonicalPlanId
          ? readPlanRecordAsync(filePath, canonicalPlanId, signal)
          : null)
    );
    matches.push(...records.filter((record): record is PlanRecord => record !== null));
    signal?.throwIfAborted();
  }
  if (matches.length > 1) {
    throw new Error(`Plan storage conflict for ${canonicalPlanId}: the stable plan id exists in more than one storage bucket.`);
  }
  return matches[0]?.plan ?? null;
}

type MemoryCatalogItem = RecentMemoryItem | ConsolidatedMemoryItem;
type MemoryCatalogCacheEntry = { validUntil: number; items: MemoryCatalogItem[] };
const MEMORY_CATALOG_CACHE_TTL_MS = 500;
const memoryCatalogCache = new Map<string, MemoryCatalogCacheEntry>();
const memoryCatalogWatchers = new Map<string, fs.FSWatcher>();
const roleKnowledgeCatalogMetadataCache = new Map<string, {
  skills: RoleSkillItem[];
  limits: RoleKnowledgeWriteLimits;
  contextInjection: RoleContextInjectionPolicy;
  planWorkflow: PersonaPlanWorkflow;
}>();

function memoryCatalogDirectory(roleDir: string, kind: "recent" | "consolidated"): string {
  return path.resolve(memoryDir(roleDir), kind);
}

function invalidateMemoryCatalog(directory: string): void {
  const cacheKey = path.resolve(directory);
  memoryCatalogCache.delete(cacheKey);
  recentMemoryConsolidationProjectionCache.delete(cacheKey);
}

function ensureMemoryCatalogWatcher(directory: string): boolean {
  const cacheKey = path.resolve(directory);
  if (memoryCatalogWatchers.has(cacheKey)) return true;
  // See ensurePlanListWatchers(): UNC storage is refreshed in worker-backed
  // reads and must never be passed to a synchronous fs.watch() call here.
  if (requiresWorkerFilesystemAccess(directory)) return false;
  if (!fs.existsSync(cacheKey)) return false;
  try {
    const watcher = fs.watch(cacheKey, { persistent: false }, (_eventType, fileName) => {
      if (!fs.existsSync(cacheKey)) {
        watcher.close();
        memoryCatalogWatchers.delete(cacheKey);
        invalidateMemoryCatalog(cacheKey);
        return;
      }
      if (fileName && !/\.(?:json|md)$/i.test(fileName.toString())) return;
      invalidateMemoryCatalog(cacheKey);
    });
    watcher.unref();
    watcher.on("error", () => {
      watcher.close();
      memoryCatalogWatchers.delete(cacheKey);
      invalidateMemoryCatalog(cacheKey);
    });
    memoryCatalogWatchers.set(cacheKey, watcher);
    return true;
  } catch {
    return false;
  }
}

function listMemoryCatalog<T extends MemoryCatalogItem>(
  directory: string,
  normalize: (raw: Record<string, unknown>, fallbackId: string) => T | null
): T[] {
  const cacheKey = path.resolve(directory);
  const cached = memoryCatalogCache.get(cacheKey);
  const watchBacked = ensureMemoryCatalogWatcher(cacheKey);
  if (cached && (watchBacked || cached.validUntil > Date.now())) return cached.items as T[];
  const items: T[] = [];
  const seen = new Set<string>();
  for (const file of [...markdownFiles(cacheKey), ...jsonFiles(cacheKey)]) {
    const markdown = file.toLowerCase().endsWith(".md");
    const raw = markdown ? parseMemoryMarkdown(file) : readJson<Record<string, unknown>>(file);
    const item = raw ? normalize(raw, path.basename(file, path.extname(file))) : null;
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  memoryCatalogCache.set(cacheKey, { validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS, items });
  return items;
}

/** Bounded read-worker entry; never used on a Manager request event loop. */
export function readKnowledgeSearchFileInWorker(filePath: string, kind: KnowledgeKind): KnowledgeChange {
  const raw = kind !== "plan" && filePath.toLowerCase().endsWith(".md")
    ? parseMemoryMarkdown(filePath) : JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (!raw) throw new Error("Knowledge file is incomplete or invalid");
  const fallback = path.basename(filePath, path.extname(filePath));
  const item = kind === "plan" ? normalizePlan(raw)
    : kind === "recent" ? normalizeRecentMemory(raw, fallback) : normalizeConsolidatedMemory(raw, fallback);
  if (!item) throw new Error("Knowledge file is incomplete or invalid");
  return { kind, item };
}

/** A point result updates a published projection, but never warms an incomplete catalog. */
export function publishCommittedRoleMemory(roleDir: string, rawMemory: RecentMemoryItem): Readonly<RecentMemoryItem> {
  const memory = immutablePublication(rawMemory);
  const key = memoryCatalogDirectory(roleDir, "recent");
  const cached = memoryCatalogCache.get(key);
  if (cached) {
    const found = cached.items.some(item => item.id === memory.id);
    memoryCatalogCache.set(key, { validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS,
      items: found ? cached.items.map(item => item.id === memory.id ? memory : item) : [...cached.items, memory] });
    recentMemoryConsolidationProjectionCache.delete(key);
  }
  publishKnowledgeChange(roleDir, { kind: "recent", item: memory });
  return memory;
}

function memoryCatalogPathIdentity(filePath: string): string {
  return memoryStorageCaseFold(path.resolve(filePath));
}

function memoryCatalogFallback(directory: string): string {
  return path.basename(directory).toLocaleLowerCase("en-US") === "consolidated"
    ? "consolidated-memory"
    : "memory";
}

function memoryCatalogRaw(filePath: string): Record<string, unknown> | null {
  return filePath.toLocaleLowerCase("en-US").endsWith(".md")
    ? parseMemoryMarkdown(filePath)
    : readJson<Record<string, unknown>>(filePath);
}

function memoryCatalogStorageFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:md|json)$/i.test(entry.name))
    .map(entry => path.join(directory, entry.name))
    .sort();
}

function assertMemoryCatalogWriteAvailable(
  filePath: string,
  value: RecentMemoryItem | ConsolidatedMemoryItem,
  allowExistingLogicalId: boolean
): void {
  const directory = path.resolve(path.dirname(filePath));
  const fallback = memoryCatalogFallback(directory);
  const desiredId = String(value.id);
  const desiredKey = memoryStorageCollisionKey(desiredId, fallback);
  const targetIdentity = memoryCatalogPathIdentity(filePath);

  for (const existingPath of memoryCatalogStorageFiles(directory)) {
    const raw = memoryCatalogRaw(existingPath);
    const sameTarget = memoryCatalogPathIdentity(existingPath) === targetIdentity;
    if (!raw && sameTarget) {
      throw new Error(
        `Memory storage target already exists but its logical id cannot be verified: ${JSON.stringify(desiredId)}`
      );
    }
    const fallbackId = path.basename(existingPath, path.extname(existingPath));
    const existingId = raw && raw.id ? String(raw.id) : fallbackId;
    const existingKey = memoryStorageCollisionKey(existingId, fallback);
    if ((sameTarget || existingKey === desiredKey) && existingId !== desiredId) {
      throw new Error(
        `Memory storage key already exists for a different logical id: requested=${JSON.stringify(desiredId)}; existing=${JSON.stringify(existingId)}.`
      );
    }
    if (existingId === desiredId && !allowExistingLogicalId) {
      throw new Error(`Memory already exists: ${JSON.stringify(desiredId)}`);
    }
  }
}

function writeMemoryCatalog(
  filePath: string,
  value: RecentMemoryItem | ConsolidatedMemoryItem,
  allowExistingLogicalId = true,
  checkpoint?: () => void
): void {
  assertMemoryCatalogWriteAvailable(filePath, value, allowExistingLogicalId);
  try {
    checkpoint?.();
    writeMemoryMarkdown(filePath, value);
    checkpoint?.();
  } finally {
    invalidateMemoryCatalog(path.dirname(filePath));
  }
}

type MemoryCatalogWrite = {
  filePath: string;
  value: RecentMemoryItem | ConsolidatedMemoryItem;
  /** Consolidated outputs are immutable after their first atomic publication. */
  existingLogicalIdPolicy?: "update" | "idempotent_only";
};

type MemoryCatalogBatchOptions = Readonly<{
  /** Deterministic fault boundary used only by the exported recovery regression helper. */
  failAfterPublishedEntries?: number;
  /** Synchronous lease/fence proof immediately before and after every publication. */
  checkpoint?: () => void;
}>;

function normalizedMemoryCatalogItem(
  directory: string,
  raw: Record<string, unknown>,
  fallbackId: string
): MemoryCatalogItem | null {
  return path.basename(directory).toLocaleLowerCase("en-US") === "consolidated"
    ? normalizeConsolidatedMemory(raw, fallbackId)
    : normalizeRecentMemory(raw, fallbackId);
}

function matchingStoredMemoryItems(
  directory: string,
  logicalId: string
): Array<{ filePath: string; value: MemoryCatalogItem }> {
  return memoryCatalogStorageFiles(directory).flatMap(filePath => {
    const raw = memoryCatalogRaw(filePath);
    const value = raw
      ? normalizedMemoryCatalogItem(directory, raw, path.basename(filePath, path.extname(filePath)))
      : null;
    return value?.id === logicalId ? [{ filePath, value }] : [];
  });
}

function assertImmutableMemoryWriteIsIdempotent(entry: MemoryCatalogWrite): boolean {
  const directory = path.resolve(path.dirname(entry.filePath));
  const matches = matchingStoredMemoryItems(directory, entry.value.id);
  if (matches.length === 0) return false;
  const expected = memoryMarkdown(entry.value);
  for (const existing of matches) {
    if (!entry.value.storageMutationRequestId
      || existing.value.storageMutationRequestId !== entry.value.storageMutationRequestId
      || existing.value.consolidationRunId !== entry.value.consolidationRunId
      || memoryMarkdown(existing.value) !== expected) {
      throw new Error(
        `Consolidated memory already exists and is immutable: ${JSON.stringify(entry.value.id)}.`
      );
    }
  }
  return true;
}

async function writeMemoryCatalogBatch(
  entries: MemoryCatalogWrite[],
  options: MemoryCatalogBatchOptions = {}
): Promise<void> {
  if (entries.length === 0) return;
  options.checkpoint?.();
  const batchStorageKeys = new Map<string, string>();
  const batchLogicalIds = new Set<string>();
  for (const entry of entries) {
    const directoryIdentity = memoryCatalogPathIdentity(path.dirname(entry.filePath));
    const logicalIdentity = `${directoryIdentity}\u0000${entry.value.id}`;
    if (batchLogicalIds.has(logicalIdentity)) {
      throw new Error(`Memory catalog batch repeats a logical id: ${JSON.stringify(entry.value.id)}.`);
    }
    batchLogicalIds.add(logicalIdentity);
  }
  const pendingWrites: MemoryCatalogWrite[] = [];
  for (const entry of entries) {
    const directory = path.resolve(path.dirname(entry.filePath));
    const storageKey = `${memoryCatalogPathIdentity(directory)}\u0000${memoryStorageCollisionKey(
      entry.value.id,
      memoryCatalogFallback(directory)
    )}`;
    const existingId = batchStorageKeys.get(storageKey);
    if (existingId !== undefined && existingId !== entry.value.id) {
      throw new Error(
        `Memory storage key already exists for a different logical id: requested=${JSON.stringify(entry.value.id)}; existing=${JSON.stringify(existingId)}.`
      );
    }
    batchStorageKeys.set(storageKey, entry.value.id);
    const alreadyPublished = entry.existingLogicalIdPolicy === "idempotent_only"
      ? assertImmutableMemoryWriteIsIdempotent(entry)
      : false;
    assertMemoryCatalogWriteAvailable(entry.filePath, entry.value, true);
    if (!alreadyPublished) pendingWrites.push(entry);
  }
  const directories = [...new Set(entries.map((entry) => path.dirname(entry.filePath)))];
  let published = 0;
  try {
    for (const entry of pendingWrites) {
      // Each bounded memory file is published atomically. Yield between files so
      // large consolidations do not monopolize the storage child's event loop.
      await new Promise<void>(resolve => setImmediate(resolve));
      options.checkpoint?.();
      atomicWriteFileSync(entry.filePath, memoryMarkdown(entry.value));
      options.checkpoint?.();
      published += 1;
      if (options.failAfterPublishedEntries !== undefined
        && published >= options.failAfterPublishedEntries) {
        throw new Error(`Injected memory catalog batch failure after ${published} atomic publication(s).`);
      }
    }
    options.checkpoint?.();
  } finally {
    for (const directory of directories) invalidateMemoryCatalog(directory);
  }
}

export function listRecentMemories(roleDir: string): RecentMemoryItem[] {
  return listMemoryCatalog(memoryCatalogDirectory(roleDir, "recent"), normalizeRecentMemory);
}

/** Refreshes mutation fencing reads after a cross-process catalog lease is acquired. */
export function invalidateRoleMemoryCatalogForMutation(roleDir: string): void {
  invalidateMemoryCatalog(memoryCatalogDirectory(roleDir, "recent"));
  invalidateMemoryCatalog(memoryCatalogDirectory(roleDir, "consolidated"));
}

export function listActiveRecentMemories(roleDir: string): RecentMemoryItem[] {
  return listRecentMemories(roleDir).filter((memory) => !memory.consolidatedAt);
}

/** Bypasses the resident read-worker cache for optimistic mutation fencing. */
export function readRecentMemoryFromStorageInWorker(
  roleDir: string,
  memoryId: string
): RecentMemoryItem | undefined {
  const directory = memoryCatalogDirectory(roleDir, "recent");
  // Canonical Markdown reads are point reads; the catalog fallback is only for legacy filenames.
  const canonical = path.join(directory, `${safeIdPart(memoryId) || "memory"}.md`);
  if (fs.existsSync(canonical)) {
    const raw = parseMemoryMarkdown(canonical);
    const memory = raw ? normalizeRecentMemory(raw, memoryId) : null;
    if (!memory || memory.id !== memoryId) throw new Error("Memory identity could not be verified");
    return memory.consolidatedAt ? undefined : memory;
  }
  invalidateMemoryCatalog(directory);
  return listActiveRecentMemories(roleDir).find((memory) => memory.id === memoryId);
}

export function listArchivedMemories(roleDir: string): RecentMemoryItem[] {
  return listRecentMemories(roleDir).filter((memory) => Boolean(memory.consolidatedAt));
}

export function getRecentMemory(roleDir: string, memoryId: string): RecentMemoryItem | undefined {
  const memory = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) return undefined;
  const viewed = { ...memory, viewedAt: nowIso(), storageRevision: createStorageRevision() };
  writeMemoryCatalog(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

/**
 * Persists one explicit recent-memory view event. The caller-owned mutation
 * stamp is the durable exactly-once proof; content activity (`updatedAt`) is
 * deliberately unchanged.
 */
export function touchRecentMemory(
  roleDir: string,
  memoryId: string,
  mutation: StorageMutationStamp,
  viewedAt = nowIso(),
  checkpoint?: () => void
): RecentMemoryItem {
  const memory = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) throw new Error(`Memory not found: ${memoryId}`);
  const touchedAt = new Date(viewedAt).toISOString();
  const viewed = {
    ...memory,
    viewedAt: touchedAt,
    storageRevision: mutation.revision,
    storageMutationRequestId: mutation.requestId
  };
  writeMemoryCatalog(recentMemoryFile(roleDir, viewed), viewed, true, checkpoint);
  return viewed;
}

function touchRecentMemoryView(roleDir: string, memory: RecentMemoryItem, viewedAt = nowIso()): RecentMemoryItem {
  const viewed = { ...memory, viewedAt, recalledAt: viewedAt, storageRevision: createStorageRevision() };
  writeMemoryCatalog(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidatedMemories(roleDir: string): ConsolidatedMemoryItem[] {
  return listMemoryCatalog(memoryCatalogDirectory(roleDir, "consolidated"), normalizeConsolidatedMemory);
}

export function listRoleSkillDetails(roleDir: string): RoleSkillDetail[] {
  return markdownFiles(skillsDir(roleDir)).flatMap((file) => {
    try {
      const item = parseSkillMarkdown(file);
      return item ? [item] : [];
    } catch {
      return [];
    }
  });
}

export function listRoleSkills(roleDir: string): RoleSkillItem[] {
  return listRoleSkillDetails(roleDir).map(({ content: _content, ...item }) => item);
}

function normalizedPublishedPlans(rawPlans: unknown): PlanItem[] {
  if (!Array.isArray(rawPlans)) throw new Error("Role plan catalog snapshot must contain a plans array.");
  const plans = rawPlans.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Role plan catalog entry ${index} is invalid.`);
    }
    const source = structuredClone(raw) as Partial<PlanItem> & Record<string, unknown>;
    const plan = normalizePlan(source, typeof source.id === "string" ? source.id : undefined);
    if (!plan) throw new Error(`Role plan catalog entry ${index} is invalid.`);
    return plan;
  });
  const unique = uniquePlans(plans);
  if (unique.length !== plans.length) {
    throw new Error("Role plan catalog snapshot contains duplicate stable plan ids.");
  }
  return unique;
}

function normalizedPublishedMemories<T extends RecentMemoryItem | ConsolidatedMemoryItem>(
  rawMemories: unknown,
  normalize: (raw: Partial<T> & Record<string, unknown>, fallbackId?: string) => T | null,
  label: string
): T[] {
  if (!Array.isArray(rawMemories)) throw new Error(`Role knowledge snapshot must contain a ${label} array.`);
  const seen = new Set<string>();
  return rawMemories.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${label} entry ${index} is invalid.`);
    }
    const source = structuredClone(raw) as Partial<T> & Record<string, unknown>;
    const memory = normalize(source, typeof source.id === "string" ? source.id : undefined);
    if (!memory) throw new Error(`${label} entry ${index} is invalid.`);
    if (seen.has(memory.id)) throw new Error(`${label} contains duplicate id ${memory.id}.`);
    seen.add(memory.id);
    return memory;
  });
}

/** Publishes a normalized worker result into the existing plan catalog cache. */
export function publishRolePlanCatalog(roleDir: string, rawPlans: unknown): readonly PlanItem[] {
  const plans = immutablePlanCatalog(normalizedPublishedPlans(rawPlans));
  const cacheKey = planListCacheKey(roleDir);
  planListCache.set(cacheKey, {
    signature: JSON.stringify(plans.map((plan) => [plan.id, plan.status, plan.updatedAt])),
    validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
    plans
  });
  // A worker snapshot has no trustworthy parent-process stat metadata. The
  // next physical refresh rebuilds this derived file cache when needed.
  planFileCache.delete(cacheKey);
  planListDirtyAt.delete(cacheKey);
  planListDirtyFiles.delete(cacheKey);
  return plans;
}

/**
 * Publishes one committed plan into an already complete parent-process catalog.
 * A cold catalog stays cold: one committed item must never masquerade as a full
 * role catalog.
 */
export function publishCommittedRolePlan(roleDir: string, rawPlan: unknown): Readonly<PlanItem> {
  const [plan] = immutablePlanCatalog(normalizedPublishedPlans([rawPlan]));
  publishKnowledgeChange(roleDir, { kind: "plan", item: plan });
  const cacheKey = planListCacheKey(roleDir);
  const cached = planListCache.get(cacheKey);
  if (!cached) return plan;
  const replaced = cached.plans.some(item => item.id === plan.id);
  const plans = immutablePlanCatalog(uniquePlans(replaced
    ? cached.plans.map(item => item.id === plan.id ? plan : item)
    : [...cached.plans, plan]));
  planListCache.set(cacheKey, {
    signature: JSON.stringify(plans.map(item => [item.id, item.status, item.updatedAt])),
    validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
    plans
  });
  // The child commit does not publish parent-process file stat metadata.
  planFileCache.delete(cacheKey);
  return plan;
}

/** Publishes a complete, rebuildable RoleKnowledge read projection. */
export function publishRoleKnowledgeCatalogSnapshot(
  roleDir: string,
  rawSnapshot: RoleKnowledgeCatalogSnapshot
): RoleKnowledgeCatalogSnapshot {
  if (!rawSnapshot || typeof rawSnapshot !== "object") {
    throw new Error("Role knowledge catalog snapshot is invalid.");
  }
  const plans = normalizedPublishedPlans(rawSnapshot.plans);
  const recentMemories = normalizedPublishedMemories(
    rawSnapshot.recentMemories,
    normalizeRecentMemory,
    "recentMemories"
  );
  const consolidatedMemories = normalizedPublishedMemories(
    rawSnapshot.consolidatedMemories,
    normalizeConsolidatedMemory,
    "consolidatedMemories"
  );
  if (!Array.isArray(rawSnapshot.skills)) throw new Error("Role knowledge snapshot must contain a skills array.");
  const skills = rawSnapshot.skills;
  const limits: RoleKnowledgeWriteLimits = {
    plan: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.plan, rawSnapshot.limits?.plan),
    memory: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.memory, rawSnapshot.limits?.memory)
  };
  const contextInjection = normalizeRoleContextInjection(rawSnapshot.contextInjection);
  const published = immutablePublication({
    plans,
    planWorkflow: validatePersonaPlanWorkflow(rawSnapshot.planWorkflow),
    recentMemories,
    consolidatedMemories,
    skills,
    limits,
    contextInjection
  } satisfies RoleKnowledgeCatalogSnapshot);
  publishRolePlanCatalog(roleDir, published.plans);
  memoryCatalogCache.set(memoryCatalogDirectory(roleDir, "recent"), {
    validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS,
    items: published.recentMemories
  });
  memoryCatalogCache.set(memoryCatalogDirectory(roleDir, "consolidated"), {
    validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS,
    items: published.consolidatedMemories
  });
  roleKnowledgeCatalogMetadataCache.set(planListCacheKey(roleDir), {
    skills: published.skills,
    limits: published.limits,
    contextInjection: published.contextInjection,
    planWorkflow: published.planWorkflow
  });
  return published;
}

/** Reads physical storage; call this only inside a bounded read worker. */
export function readRoleKnowledgeCatalogSnapshot(roleDir: string): RoleKnowledgeCatalogSnapshot {
  // This API is executed by the bounded catalog worker specifically to
  // recapture physical truth after a storage-child commit. Resident TTL or
  // watcher caches must not turn read-after-write into a stale projection.
  invalidateMemoryCatalog(memoryCatalogDirectory(roleDir, "recent"));
  invalidateMemoryCatalog(memoryCatalogDirectory(roleDir, "consolidated"));
  return {
    plans: readPlansFromStorageInWorker(roleDir),
    planWorkflow: ensurePersonaPlanWorkflow(roleDir).workflow,
    recentMemories: listRecentMemories(roleDir),
    consolidatedMemories: listConsolidatedMemories(roleDir),
    skills: listRoleSkills(roleDir),
    limits: roleKnowledgeWriteLimits(roleDir),
    contextInjection: roleContextInjectionPolicy(roleDir)
  };
}

/** Returns undefined on a cold/invalidated cache and never probes the filesystem. */
export function publishedRoleKnowledgeCatalogSnapshot(
  roleDir: string
): Readonly<RoleKnowledgeCatalogSnapshot> | undefined {
  const cacheKey = planListCacheKey(roleDir);
  const plans = planListCache.get(cacheKey)?.plans;
  const recentMemories = memoryCatalogCache.get(memoryCatalogDirectory(roleDir, "recent"))?.items;
  const consolidatedMemories = memoryCatalogCache.get(memoryCatalogDirectory(roleDir, "consolidated"))?.items;
  const metadata = roleKnowledgeCatalogMetadataCache.get(cacheKey);
  if (!plans || !recentMemories || !consolidatedMemories || !metadata) return undefined;
  return deepFreeze({
    plans,
    recentMemories: recentMemories as RecentMemoryItem[],
    consolidatedMemories: consolidatedMemories as ConsolidatedMemoryItem[],
    skills: metadata.skills,
    limits: metadata.limits,
    contextInjection: metadata.contextInjection,
    planWorkflow: metadata.planWorkflow
  });
}

/** Memory-only plan lookup for Manager routing/event decisions. */
export function getPublishedPlan(roleDir: string, planId: string): PlanItem | undefined {
  let canonicalPlanId: string;
  try {
    canonicalPlanId = canonicalLogicalPlanId(planId);
  } catch {
    return undefined;
  }
  return planListCache.get(planListCacheKey(roleDir))?.plans.find((plan) => plan.id === canonicalPlanId);
}

/** Memory-only plan catalog lookup; undefined means the cache is not published. */
export function publishedRolePlans(roleDir: string): readonly PlanItem[] | undefined {
  return planListCache.get(planListCacheKey(roleDir))?.plans;
}

export function getRoleSkill(roleDir: string, skillId: string): RoleSkillDetail | undefined {
  return listRoleSkillDetails(roleDir).find((item) => item.id === skillId);
}

export function getConsolidatedMemory(roleDir: string, memoryId: string): ConsolidatedMemoryItem | undefined {
  const memory = listConsolidatedMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) return undefined;
  const viewed = { ...memory, viewedAt: nowIso(), storageRevision: createStorageRevision() };
  writeMemoryCatalog(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

function touchConsolidatedMemoryView(roleDir: string, memory: ConsolidatedMemoryItem, viewedAt = nowIso()): ConsolidatedMemoryItem {
  const viewed = { ...memory, viewedAt, recalledAt: viewedAt, storageRevision: createStorageRevision() };
  writeMemoryCatalog(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidationRuns(roleDir: string): MemoryConsolidationRun[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).flatMap((file) => {
    const raw = readJson<MemoryConsolidationRun>(file);
    return raw ? [raw] : [];
  });
}

export function roleMemoryCounts(roleDir: string): {
  recent: number;
  consolidated: number;
  archived: number;
  consolidationRuns: number;
} {
  const recentMemories = listRecentMemories(roleDir);
  return {
    recent: recentMemories.filter((memory) => !memory.consolidatedAt).length,
    consolidated: listConsolidatedMemories(roleDir).length,
    archived: recentMemories.filter((memory) => Boolean(memory.consolidatedAt)).length,
    consolidationRuns: jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).length
  };
}

function remapManagedPath(filePath: string, mappings: Array<{ from: string; to: string }>): string {
  const candidate = path.resolve(filePath);
  for (const mapping of mappings) {
    const from = path.resolve(mapping.from);
    const relative = path.relative(from, candidate);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(mapping.to, relative);
  }
  return filePath;
}

function rewritePlanStoragePaths(value: unknown, mappings: Array<{ from: string; to: string }>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewritePlanStoragePaths(item, mappings));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = key === "path" && typeof item === "string"
      ? remapManagedPath(item, mappings)
      : rewritePlanStoragePaths(item, mappings);
  }
  return output;
}

function rewriteJsonlContent(content: Buffer, mappings: Array<{ from: string; to: string }>): Buffer {
  const lines = content.toString("utf8").split(/\r?\n/);
  const rewritten = lines.map((line) => {
    if (!line) return line;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify(rewritePlanStoragePaths(parsed, mappings));
    } catch {
      return line;
    }
  });
  return Buffer.from(rewritten.join("\n"), "utf8");
}

function remapPlanAttachmentPaths(
  roleDir: string,
  planId: string,
  attachments: PlanAttachment[],
  fromBucket: PlanStorageBucket,
  toBucket: PlanStorageBucket
): PlanAttachment[] {
  const from = planAttachmentDirectory(roleDir, planId, fromBucket);
  const to = planAttachmentDirectory(roleDir, planId, toBucket);
  return attachments.map((attachment) => ({ ...attachment, path: remapManagedPath(attachment.path, [{ from, to }]) }));
}

function remapPreparedPlanAttachments(
  roleDir: string,
  planId: string,
  prepared: PreparedPlanAttachment[],
  fromBucket: PlanStorageBucket,
  toBucket: PlanStorageBucket
): PreparedPlanAttachment[] {
  const from = planAttachmentDirectory(roleDir, planId, fromBucket);
  const to = planAttachmentDirectory(roleDir, planId, toBucket);
  return prepared.map((item) => ({
    ...item,
    metadata: { ...item.metadata, path: remapManagedPath(item.metadata.path, [{ from, to }]) }
  }));
}

function planStoragePackageFile(filePath: string, content: string | Buffer): PlanStoragePackageFile {
  const body = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
  return {
    path: filePath.replace(/\\/g, "/"),
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    content: body
  };
}

function planStoragePackageMap(files: PlanStoragePackageFile[]): Map<string, Buffer> {
  return new Map(files.map((file) => [file.path.replace(/\\/g, "/"), Buffer.from(file.content)]));
}

function planStoragePackageFiles(files: Map<string, Buffer>): PlanStoragePackageFile[] {
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => planStoragePackageFile(filePath, content));
}

function remapPlanStoragePackage(
  files: Map<string, Buffer>,
  roleDir: string,
  planId: string,
  fromBucket: PlanStorageBucket,
  toBucket: PlanStorageBucket
): void {
  const source = planDirectory(roleDir, planId, fromBucket);
  const destination = planDirectory(roleDir, planId, toBucket);
  const mappings = [{ from: source, to: destination }];
  for (const filePath of ["history.jsonl", "feedback.jsonl"]) {
    const content = files.get(filePath);
    if (content) files.set(filePath, rewriteJsonlContent(content, mappings));
  }
}

function applyPreparedPlanAttachments(
  files: Map<string, Buffer>,
  planRoot: string,
  prepared: PreparedPlanAttachment[]
): PlanAttachment[] {
  const before = new Map(files);
  for (const filePath of [...files.keys()]) {
    if (filePath === "attachments" || filePath.startsWith("attachments/")) files.delete(filePath);
  }
  for (const item of prepared) {
    const relative = path.relative(planRoot, item.metadata.path).replace(/\\/g, "/");
    if (!relative.startsWith("attachments/") || relative.includes("../")) {
      throw new Error(`Prepared plan attachment escaped its managed directory: ${item.metadata.name}.`);
    }
    const content = item.content ? Buffer.from(item.content) : before.get(relative);
    if (!content || createHash("sha256").update(content).digest("hex") !== item.metadata.sha256) {
      throw new Error(`Prepared plan attachment is missing or changed: ${item.metadata.name}.`);
    }
    files.set(relative, content);
  }
  return prepared.map((item) => item.metadata);
}

/** Startup-child adapter; runtime message and Gateway entry points never import migration code. */
export function normalizePlanForStartupMigration(
  raw: Record<string, unknown>,
  fallbackId: string
): Pick<PlanItem, "id" | "status" | "archiveStatus"> | null {
  return normalizePlan(raw, fallbackId);
}

export type PersonaPlanStatusStartupMigrationResult = {
  migrated: number;
  failures: Array<{ planId: string; error: string }>;
};

function hasLegacyPlanStepState(value: unknown): boolean {
  return Array.isArray(value) && value.some((step) => {
    const raw = recordValue(step);
    return Object.prototype.hasOwnProperty.call(raw, "status")
      || Object.prototype.hasOwnProperty.call(raw, "completed")
      || Object.prototype.hasOwnProperty.call(raw, "current");
  });
}

/** Startup-only canonicalization of plan status keys and legacy step state fields. */
export function migratePersonaPlanStatusesAtStartup(roleDir: string): PersonaPlanStatusStartupMigrationResult {
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  const result: PersonaPlanStatusStartupMigrationResult = { migrated: 0, failures: [] };
  for (const filePath of allPlanFiles(roleDir)) {
    const stored = readJson<Record<string, unknown>>(filePath);
    const fallbackId = path.basename(path.dirname(filePath));
    if (!stored) {
      result.failures.push({ planId: fallbackId, error: `Cannot read plan JSON: ${filePath}` });
      continue;
    }
    const normalized = normalizePlan(stored, fallbackId);
    if (!normalized) {
      result.failures.push({ planId: fallbackId, error: `Cannot normalize plan JSON: ${filePath}` });
      continue;
    }
    const resolved = resolvePersonaPlanStatus(workflow, normalized.status, { includeLegacyAliases: true });
    if (!resolved) {
      result.failures.push({ planId: normalized.id, error: `PLAN_STATUS_CONFIG_INVALID: ${normalized.status}` });
      continue;
    }
    if (resolved.matchedBy === "key" && !hasLegacyPlanStepState(stored.steps)) continue;
    try {
      withPlanStorageLock(roleDir, normalized.id, (lease) => {
        const sourcePackage = readCanonicalPlanStoragePackageUnderLease(lease);
        const rawPlanFile = sourcePackage.files.find((file) => file.path === "plan.json");
        if (!rawPlanFile) throw new Error("Canonical plan package has no plan.json.");
        const beforeRaw = JSON.parse(rawPlanFile.content.toString("utf8")) as Record<string, unknown>;
        const latestStatus = resolvePersonaPlanStatus(workflow, beforeRaw.status, { includeLegacyAliases: true });
        if (!latestStatus) throw new Error(`PLAN_STATUS_CONFIG_INVALID: ${String(beforeRaw.status)}`);
        if (latestStatus.matchedBy === "key" && !hasLegacyPlanStepState(beforeRaw.steps)) return;
        const recordedAt = nowIso();
        const next = normalizePlan({
          ...beforeRaw,
          status: latestStatus.key,
          archiveStatus: beforeRaw.archiveStatus === "已归档" || beforeRaw.status === "已归档" ? "已归档" : "未归档",
          steps: Array.isArray(beforeRaw.steps)
            ? beforeRaw.steps.map((step) => {
                const { workPhase: _workPhase, discussionState: _discussionState, ...clean } = recordValue(step);
                return clean;
              }) as unknown as PlanStep[]
            : [],
          updatedAt: recordedAt,
          storageRevision: createStorageRevision()
        }, normalized.id);
        if (!next) throw new Error("Canonical status migration produced an invalid plan.");
        const files = planStoragePackageMap(sourcePackage.files);
        const history = createPlanHistoryRecord(beforeRaw as unknown as PlanItem, next);
        files.set("history.jsonl", Buffer.from(appendPlanHistoryContent(files.get("history.jsonl")?.toString("utf8") || "", history), "utf8"));
        files.set("plan.json", Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
        commitPlanLifecycleTransitionUnderLease(lease, {
          transactionId: planLifecycleTransactionId("plan-update", next.id, "plan-state-v2", sourcePackage.inventoryHash),
          kind: "plan-update",
          fromBucket: sourcePackage.bucket,
          toBucket: sourcePackage.bucket,
          expectedSourceInventoryHash: sourcePackage.inventoryHash,
          files: planStoragePackageFiles(files)
        });
        result.migrated += 1;
      });
    } catch (error) {
      result.failures.push({ planId: normalized.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (result.migrated > 0) clearPlanListCache(roleDir);
  return result;
}

/** Startup-child adapter; a completed migration invalidates any test/preflight cache. */
export function clearPlanCatalogAfterStartupMigration(roleDir: string): void {
  clearPlanListCache(roleDir);
}

export function createPlan(
  roleDir: string,
  input: Record<string, unknown>,
  mutation?: StorageMutationStamp
): PlanItem {
  if (!String(input.focus || "").trim()) throw new Error("Plan focus is required and must describe one subject.");
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  validatePlanStatusInput(workflow, input.status);
  if (input.archiveStatus !== undefined && input.archiveStatus !== "未归档" && input.archiveStatus !== "已归档") {
    throw new Error("Unsupported plan archiveStatus. Use 未归档 or 已归档.");
  }
  validatePlanSecretaryBindingInput(input.secretaryBinding);
  validatePlanTaskBindingInput(input.taskBinding);
  validatePlanMessageChannels(input.messageChannels);
  const id = typeof input.id === "string" && input.id.trim()
    ? canonicalLogicalPlanId(input.id)
    : generatedId("plan", String(input.title || ""));
  const cacheKey = planListCacheKey(roleDir);
  const previousCache = {
    catalog: planListCache.get(cacheKey),
    files: planFileCache.get(cacheKey)
  };
  return withPlanStorageLock(roleDir, id, (lease) => {
    assertPlanStorageIdentityAvailable(roleDir, id);
    if (findPlanRecord(roleDir, id)) throw new Error(`Plan already exists: ${id}`);
    const recordedAt = nowIso();
    const plan = normalizePlan({
      ...input,
      status: input.status === undefined ? planStatusKeyForRole(workflow, "initial") : input.status as PlanStatus,
      attachments: [],
      id,
      createdAt: recordedAt,
      updatedAt: recordedAt,
      storageRevision: mutation?.revision ?? createStorageRevision(),
      storageMutationRequestId: mutation?.requestId
    });
    if (!plan) throw new Error("Plan title is required.");
    plan.steps = recordPlanStepTimes(plan.steps, [], plan.currentStepId, recordedAt);
    requireKeywords(plan.keywords, "Plan");
    validatePlanWrite(roleDir, plan, true);
    const files = new Map<string, Buffer>();
    if (Object.prototype.hasOwnProperty.call(input, "attachments")) {
      const prepared = preparePlanAttachments(roleDir, plan.id, input.attachments, [], planBucketForArchiveStatus(plan.archiveStatus));
      plan.attachments = applyPreparedPlanAttachments(
        files,
        planDirectory(roleDir, plan.id, planBucketForArchiveStatus(plan.archiveStatus)),
        prepared
      );
    }
    const history = createPlanHistoryRecord(undefined, plan);
    files.set("plan.json", Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8"));
    files.set("history.jsonl", Buffer.from(appendPlanHistoryContent("", history), "utf8"));
    commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: planLifecycleTransactionId("plan-create", plan.id, recordedAt),
      kind: "plan-create",
      fromBucket: null,
      toBucket: planBucketForArchiveStatus(plan.archiveStatus),
      files: planStoragePackageFiles(files)
    });
    const destination = planFile(roleDir, plan);
    updatePlanListCacheAfterWrite(roleDir, destination, plan, [destination], previousCache);
    return plan;
  });
}

export function updatePlan(
  roleDir: string,
  planId: string,
  patch: Record<string, unknown>,
  expectedRevision?: string,
  mutation?: StorageMutationStamp
): PlanItem {
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  const canonicalPlanId = canonicalLogicalPlanId(planId);
  const cacheKey = planListCacheKey(roleDir);
  const previousCache = {
    catalog: planListCache.get(cacheKey),
    files: planFileCache.get(cacheKey)
  };
  return withPlanStorageLock(roleDir, canonicalPlanId, (lease) => {
    const record = findPlanRecord(roleDir, canonicalPlanId);
    if (!record) throw new Error(`Plan not found: ${canonicalPlanId}`);
    const sourcePackage = readCanonicalPlanStoragePackageUnderLease(lease);
    const currentRevision = storageInventoryRevisionToken(sourcePackage.inventoryHash);
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new Error(`STORAGE_MUTATION_REVISION_CONFLICT: expected=${expectedRevision}; current=${currentRevision}.`);
    }
    const existing = record.plan;
    if (existing.archiveStatus === "已归档") {
      throw new Error(`Archived plans are immutable terminal records: ${canonicalPlanId}`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "status")) validatePlanStatusInput(workflow, patch.status);
    if (Object.prototype.hasOwnProperty.call(patch, "archiveStatus") && patch.archiveStatus !== "未归档" && patch.archiveStatus !== "已归档") {
      throw new Error("Unsupported plan archiveStatus. Use 未归档 or 已归档.");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "secretaryBinding")) validatePlanSecretaryBindingInput(patch.secretaryBinding);
    if (Object.prototype.hasOwnProperty.call(patch, "taskBinding")) validatePlanTaskBindingInput(patch.taskBinding);
    if (Object.prototype.hasOwnProperty.call(patch, "messageChannels")) validatePlanMessageChannels(patch.messageChannels);
    const recordedAt = nowIso();
    const clearedStartedAt = planStepIdsWithClearedTime(patch.steps, "startedAt");
    const clearedCompletedAt = planStepIdsWithClearedTime(patch.steps, "completedAt");
    const next = normalizePlan({
      ...existing,
      ...patch,
      attachments: existing.attachments,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: recordedAt,
      storageRevision: mutation?.revision ?? createStorageRevision(),
      storageMutationRequestId: mutation?.requestId
    });
    if (!next) throw new Error("Plan title is required.");
    next.steps = recordPlanStepTimes(
      next.steps,
      existing.steps,
      next.currentStepId,
      recordedAt,
      clearedStartedAt,
      clearedCompletedAt
    );
    requireKeywords(next.keywords, "Plan");
    validatePlanWrite(roleDir, next);
    const nextStatusDefinition = assertWritablePlanStatus(workflow, next.status);
    const previousStatusDefinition = planStatusDefinition(workflow, existing.status, { allowRetired: true });
    if (nextStatusDefinition.setsCompletedAt && previousStatusDefinition?.setsCompletedAt !== true && !next.completedAt) {
      next.completedAt = next.updatedAt;
    }
    const currentBucket = planBucketForArchiveStatus(existing.archiveStatus);
    const destinationBucket = planBucketForArchiveStatus(next.archiveStatus);
    if (sourcePackage.bucket !== currentBucket) {
      throw new Error(`Plan storage bucket changed while updating: ${canonicalPlanId}`);
    }
    const files = planStoragePackageMap(sourcePackage.files);
    let preparedAttachments: PreparedPlanAttachment[] | undefined;
    if (Object.prototype.hasOwnProperty.call(patch, "attachments")) {
      preparedAttachments = preparePlanAttachments(
        roleDir,
        next.id,
        patch.attachments,
        existing.attachments,
        destinationBucket
      );
    }
    if (currentBucket !== destinationBucket) {
      remapPlanStoragePackage(files, roleDir, next.id, currentBucket, destinationBucket);
      next.attachments = remapPlanAttachmentPaths(roleDir, next.id, next.attachments, currentBucket, destinationBucket);
      if (preparedAttachments) {
        preparedAttachments = remapPreparedPlanAttachments(
          roleDir,
          next.id,
          preparedAttachments,
          currentBucket,
          destinationBucket
        );
      }
    }
    if (preparedAttachments) {
      next.attachments = applyPreparedPlanAttachments(
        files,
        planDirectory(roleDir, next.id, destinationBucket),
        preparedAttachments
      );
    }
    const storedBefore = JSON.parse(sourcePackage.files.find((file) => file.path === "plan.json")?.content.toString("utf8") || "{}") as PlanItem;
    const historyBefore = currentBucket === destinationBucket
      ? storedBefore
      : rewritePlanStoragePaths(storedBefore, [{
        from: planDirectory(roleDir, next.id, currentBucket),
        to: planDirectory(roleDir, next.id, destinationBucket)
      }]) as PlanItem;
    const historyRecord = createPlanHistoryRecord(historyBefore, next);
    const currentHistory = files.get("history.jsonl")?.toString("utf8") || "";
    files.set("history.jsonl", Buffer.from(appendPlanHistoryContent(currentHistory, historyRecord), "utf8"));
    files.set("plan.json", Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
    commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: planLifecycleTransactionId(
        currentBucket === destinationBucket ? "plan-update" : "plan-archive",
        next.id,
        recordedAt,
        sourcePackage.inventoryHash
      ),
      kind: currentBucket === destinationBucket ? "plan-update" : "plan-archive",
      fromBucket: currentBucket,
      toBucket: destinationBucket,
      expectedSourceInventoryHash: sourcePackage.inventoryHash,
      files: planStoragePackageFiles(files)
    });
    const destination = planFile(roleDir, next);
    updatePlanListCacheAfterWrite(
      roleDir,
      destination,
      next,
      [destination, record.filePath, ...planCandidateFiles(roleDir, canonicalPlanId)],
      previousCache
    );
    notifyPlanUpdated({ roleDir: path.resolve(roleDir), before: existing, after: next });
    return next;
  });
}

export function createRecentMemory(
  roleDir: string,
  input: Record<string, unknown>,
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): RecentMemoryItem {
  if (!String(input.focus || "").trim()) throw new Error("Memory focus is required and must describe one subject.");
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("memory", String(input.title || ""));
  const memory = normalizeRecentMemory({
    ...input,
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId
  });
  if (!memory) throw new Error("Memory title and content are required.");
  requireKeywords(memory.keywords, "Memory");
  validateMemoryWrite(roleDir, memory);
  writeMemoryCatalog(recentMemoryFile(roleDir, memory), memory, false, checkpoint);
  return memory;
}

export function updateRecentMemory(
  roleDir: string,
  memoryId: string,
  patch: Record<string, unknown>,
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): RecentMemoryItem {
  const existing = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!existing) throw new Error(`Memory not found: ${memoryId}`);
  if (ageHours(memoryActivityAt(existing)) > DEFAULT_RECENT_EDITABLE_HOURS) {
    throw new Error(
      `Recent memory is outside the ${DEFAULT_RECENT_EDITABLE_HOURS}-hour editable window. Read it by ID before updating or record a new correction.`
    );
  }
  const touchedAt = nowIso();
  const next = normalizeRecentMemory({
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: touchedAt,
    viewedAt: touchedAt,
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId
  });
  if (!next) throw new Error("Memory title and content are required.");
  requireKeywords(next.keywords, "Memory");
  validateMemoryWrite(roleDir, next);
  writeMemoryCatalog(recentMemoryFile(roleDir, next), next, true, checkpoint);
  return next;
}

export function archiveCompletedPlans(roleDir: string, archiveAfterHours?: number): PlanItem[] {
  const archived: PlanItem[] = [];
  const plans = publishedRolePlans(roleDir);
  if (!plans) return archived;
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  const effectiveArchiveAfterHours = archiveAfterHours ?? workflow.archiveAfterHours;
  for (const plan of plans) {
    const definition = planStatusDefinition(workflow, plan.status, { allowRetired: true });
    if (definition?.archiveEligible !== true || plan.archiveStatus === "已归档" || ageHours(plan.updatedAt) <= effectiveArchiveAfterHours) continue;
    const next = {
      ...plan,
      archiveStatus: "已归档" as const,
      currentStepId: undefined,
      archivedAt: nowIso(),
      updatedAt: nowIso()
    };
    updatePlan(roleDir, plan.id, next);
    archived.push(next);
  }
  return archived;
}

function archiveCompletedPlansFromStorage(roleDir: string, archiveAfterHours: number): PlanItem[] {
  const archived: PlanItem[] = [];
  const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
  for (const plan of readPlansFromStorageInWorker(roleDir)) {
    const definition = planStatusDefinition(workflow, plan.status, { allowRetired: true });
    if (definition?.archiveEligible !== true || plan.archiveStatus === "已归档" || ageHours(plan.updatedAt) <= archiveAfterHours) continue;
    const next = {
      ...plan,
      archiveStatus: "已归档" as const,
      currentStepId: undefined,
      archivedAt: nowIso(),
      updatedAt: nowIso()
    };
    updatePlan(roleDir, plan.id, next);
    archived.push(next);
  }
  return archived;
}

export type MemoryConsolidationScheduleInspection = Readonly<{
  pending: MemoryConsolidationRequest | null;
  due: boolean;
  dueOperationIdentity?: string;
  nextTriggerAt?: number;
  input: RecentMemoryItem[];
  triggerMemoryId?: string;
  triggerAt?: string;
  candidateCutoffAt?: string;
}>;

export function inspectMemoryConsolidationSchedule(
  roleDir: string,
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS,
  force = false
): MemoryConsolidationScheduleInspection {
  const memories = listRecentMemories(roleDir).filter((item) => !item.consolidatedAt);
  const cohort = recentMemoryConsolidationCohort(memories, recentEditableHours, recentConsolidationHours);
  const triggerAt = Date.parse(cohort.trigger?.consolidationTriggerAt || "");
  const shouldTrigger = force || (Number.isFinite(triggerAt) && Date.now() >= triggerAt);
  const input = force
    ? memories.filter((item) => ageHours(memoryConsolidationActivityAt(item)) > recentEditableHours)
    : cohort.candidates;
  const inputIds = input.map((item) => item.id).sort();
  const existingRun = inputIds.length === 0 ? undefined : listConsolidationRuns(roleDir)
    .filter((run) => run.status === "requested")
    .find((run) => {
      const runIds = [...run.inputMemoryIds].sort();
      return runIds.length === inputIds.length && runIds.every((id, index) => id === inputIds[index]);
    });
  const nextTriggerAt = Number.isFinite(triggerAt) ? triggerAt : undefined;
  const due = shouldTrigger && input.length > 0;
  return Object.freeze({
    pending: existingRun ? { run: existingRun, memories: input } : null,
    due,
    ...(due && !existingRun
      ? {
          dueOperationIdentity: createHash("sha256").update(JSON.stringify({
            inputIds,
            triggerMemoryId: cohort.trigger?.memory.id ?? null,
            triggerAt: cohort.trigger?.consolidationTriggerAt ?? null,
            force
          }), "utf8").digest("hex")
        }
      : {}),
    ...(nextTriggerAt === undefined ? {} : { nextTriggerAt }),
    input,
    triggerMemoryId: cohort.trigger?.memory.id,
    triggerAt: cohort.trigger?.consolidationTriggerAt,
    candidateCutoffAt: force
      ? new Date(Date.now() - recentEditableHours * 3_600_000).toISOString()
      : cohort.candidateCutoffAt
  });
}

export function pendingMemoryConsolidation(
  roleDir: string,
  trigger: "auto" | "manual" | "api" = "auto",
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS,
  force = false,
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): MemoryConsolidationRequest | null {
  const inspection = inspectMemoryConsolidationSchedule(
    roleDir,
    recentEditableHours,
    recentConsolidationHours,
    force
  );
  if (inspection.pending) return inspection.pending;
  if (!inspection.due) return null;
  const inputIds = inspection.input.map((item) => item.id).sort();

  const run: MemoryConsolidationRun = {
    id: generatedId("memory-consolidation", "run"),
    roleDir,
    requestedAt: nowIso(),
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId,
    trigger,
    recentEditableHours,
    recentConsolidationHours,
    triggerMemoryId: inspection.triggerMemoryId,
    triggerAt: inspection.triggerAt,
    candidateCutoffAt: inspection.candidateCutoffAt,
    inputMemoryIds: inputIds,
    status: "requested",
    instruction: "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。"
  };
  checkpoint?.();
  writeJson(consolidationRunFile(roleDir, run.id), run);
  checkpoint?.();
  return { run, memories: inspection.input };
}

export function nextMemoryConsolidationTriggerAt(
  roleDir: string,
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS
): number | undefined {
  const memories = listRecentMemories(roleDir).filter((item) => !item.consolidatedAt);
  const cohort = recentMemoryConsolidationCohort(memories, recentEditableHours, recentConsolidationHours);
  const triggerAt = Date.parse(cohort.trigger?.consolidationTriggerAt || "");
  return Number.isFinite(triggerAt) ? triggerAt : undefined;
}

export function memoryConsolidationRunRevision(run: MemoryConsolidationRun): string {
  return storageRevisionToken(run)!;
}

export function markMemoryConsolidationRunDelivered(
  roleDir: string,
  runId: string,
  deliveredAt = nowIso(),
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): MemoryConsolidationRun {
  const run = readJson<MemoryConsolidationRun>(consolidationRunFile(roleDir, runId));
  if (!run) throw new Error(`Memory consolidation run not found: ${runId}`);
  if (run.deliveredAt || run.status === "completed") return run;
  const delivered = {
    ...run,
    deliveredAt,
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId
  };
  checkpoint?.();
  writeJson(consolidationRunFile(roleDir, runId), delivered);
  checkpoint?.();
  return delivered;
}

export function createMemoryConsolidationRequest(
  roleDir: string,
  options: CreateMemoryConsolidationRequestOptions = {},
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): MemoryConsolidationRequest {
  const request = pendingMemoryConsolidation(
    roleDir,
    options.triggerSource ?? "api",
    options.includeOlderThanHours ?? DEFAULT_RECENT_EDITABLE_HOURS,
    options.triggerOlderThanHours ?? DEFAULT_RECENT_CONSOLIDATION_HOURS,
    options.force === true,
    mutation,
    checkpoint
  );
  if (!request) {
    throw new Error("No recent memories are eligible for consolidation.");
  }
  return request;
}

type MemoryConsolidationCompletionResult = {
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
};

const memoryConsolidationCompletions = new Map<string, Promise<MemoryConsolidationCompletionResult>>();

function storedConsolidatedMemoryForRetry(
  roleDir: string,
  memoryId: string,
  runId: string,
  mutation?: StorageMutationStamp
): ConsolidatedMemoryItem | undefined {
  if (!mutation) return undefined;
  return matchingStoredMemoryItems(memoryCatalogDirectory(roleDir, "consolidated"), memoryId)
    .map(item => item.value as ConsolidatedMemoryItem)
    .find(item => item.storageMutationRequestId === mutation.requestId && item.consolidationRunId === runId);
}

function partialConsolidationCompletedAt(
  roleDir: string,
  run: MemoryConsolidationRun,
  mutation?: StorageMutationStamp
): string | undefined {
  if (!mutation) return undefined;
  const inputIds = new Set(run.inputMemoryIds);
  const completedAt = new Set(
    matchingStoredMemoryItemsForIds(memoryCatalogDirectory(roleDir, "recent"), inputIds)
      .map(item => item.value as RecentMemoryItem)
      .filter(item => item.storageMutationRequestId === mutation.requestId
        && item.consolidationRunId === run.id
        && typeof item.consolidatedAt === "string")
      .map(item => item.consolidatedAt as string)
  );
  if (completedAt.size > 1) {
    throw new Error(`Memory consolidation retry found inconsistent completion timestamps: ${run.id}.`);
  }
  return completedAt.values().next().value as string | undefined;
}

function matchingStoredMemoryItemsForIds(
  directory: string,
  logicalIds: ReadonlySet<string>
): Array<{ filePath: string; value: MemoryCatalogItem }> {
  return memoryCatalogStorageFiles(directory).flatMap(filePath => {
    const raw = memoryCatalogRaw(filePath);
    const value = raw
      ? normalizedMemoryCatalogItem(directory, raw, path.basename(filePath, path.extname(filePath)))
      : null;
    return value && logicalIds.has(value.id) ? [{ filePath, value }] : [];
  });
}

async function completeMemoryConsolidationUnlocked(
  roleDir: string,
  runId: string,
  rawItems: unknown,
  mutation?: StorageMutationStamp,
  batchOptions: MemoryCatalogBatchOptions = {}
): Promise<MemoryConsolidationCompletionResult> {
  const run = readJson<MemoryConsolidationRun>(consolidationRunFile(roleDir, runId));
  if (!run) throw new Error(`Memory consolidation run not found: ${runId}`);
  if (run.status === "completed") {
    const memories = listConsolidatedMemories(roleDir)
      .filter((item) => item.consolidationRunId === run.id || run.outputMemoryIds?.includes(item.id));
    return { run, memories };
  }

  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const output = items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    if (!String(source.focus || "").trim()) {
      throw new Error("Consolidated memory focus is required and must describe one subject.");
    }
    const id = typeof source.id === "string" && source.id
      ? source.id
      : mutation
        ? `consolidated-${createHash("sha256").update(`${mutation.requestId}:${index}`, "utf8").digest("hex").slice(0, 32)}`
        : generatedId("consolidated-memory", String(source.title || `memory-${index + 1}`));
    const existingRetry = storedConsolidatedMemoryForRetry(roleDir, id, run.id, mutation);
    const generatedAt = nowIso();
    const memory = normalizeConsolidatedMemory({
      ...source,
      id,
      createdAt: existingRetry?.createdAt ?? generatedAt,
      updatedAt: existingRetry?.updatedAt ?? generatedAt,
      storageRevision: mutation?.revision ?? createStorageRevision(),
      storageMutationRequestId: mutation?.requestId,
      inputMemoryIds: Array.isArray(source.inputMemoryIds) ? source.inputMemoryIds : run.inputMemoryIds,
      consolidationRunId: run.id
    });
    if (!memory) return [];
    return [memory];
  });

  if (output.length === 0) {
    throw new Error("At least one consolidated memory is required.");
  }

  for (const memory of output) {
    requireKeywords(memory.keywords, "Consolidated memory");
    validateMemoryWrite(roleDir, memory, "Consolidated memory");
  }

  const completedAt = partialConsolidationCompletedAt(roleDir, run, mutation) ?? nowIso();
  const inputMemoryIds = new Set(run.inputMemoryIds);
  const recentWrites = listRecentMemories(roleDir)
    .filter((item) => inputMemoryIds.has(item.id))
    .map((memory) => ({
      filePath: recentMemoryFile(roleDir, memory),
      value: {
      ...memory,
      consolidatedAt: completedAt,
      consolidationRunId: run.id,
      storageRevision: mutation?.revision ?? createStorageRevision(),
      storageMutationRequestId: mutation?.requestId
      }
    } satisfies MemoryCatalogWrite));
  const outputWrites = output.map((memory) => ({
    filePath: consolidatedMemoryFile(roleDir, memory),
    value: memory,
    existingLogicalIdPolicy: "idempotent_only" as const
  } satisfies MemoryCatalogWrite));
  await writeMemoryCatalogBatch([...outputWrites, ...recentWrites], batchOptions);

  const completedRun: MemoryConsolidationRun = {
    ...run,
    completedAt,
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId,
    outputMemoryIds: output.map((item) => item.id),
    status: "completed"
  };
  batchOptions.checkpoint?.();
  writeJson(consolidationRunFile(roleDir, run.id), completedRun);
  batchOptions.checkpoint?.();

  return { run: completedRun, memories: output };
}

export function completeMemoryConsolidation(
  roleDir: string,
  runId: string,
  rawItems: unknown,
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): Promise<MemoryConsolidationCompletionResult> {
  const key = `${path.resolve(roleDir)}\u0000${runId}`;
  const active = memoryConsolidationCompletions.get(key);
  if (active) return active;
  const completion = completeMemoryConsolidationUnlocked(roleDir, runId, rawItems, mutation, { checkpoint })
    .finally(() => {
      if (memoryConsolidationCompletions.get(key) === completion) {
        memoryConsolidationCompletions.delete(key);
      }
    });
  memoryConsolidationCompletions.set(key, completion);
  return completion;
}

/** Exercises an actual post-rename batch failure without exposing a production route option. */
export function completeMemoryConsolidationWithAtomicBatchFaultForTest(
  roleDir: string,
  runId: string,
  rawItems: unknown,
  mutation: StorageMutationStamp,
  failAfterPublishedEntries: number
): Promise<MemoryConsolidationCompletionResult> {
  if (!Number.isSafeInteger(failAfterPublishedEntries) || failAfterPublishedEntries <= 0) {
    throw new Error("Memory catalog batch fault boundary must be a positive integer.");
  }
  return completeMemoryConsolidationUnlocked(roleDir, runId, rawItems, mutation, {
    failAfterPublishedEntries
  });
}

function validateRoleKnowledgeCatalog(
  roleDir: string,
  catalog: Pick<RoleKnowledgeCatalogSnapshot, "plans" | "recentMemories" | "consolidatedMemories" | "limits">
): RoleKnowledgeValidationResult {
  const issues: RoleKnowledgeValidationIssue[] = [];
  for (const plan of catalog.plans) {
    try {
      requireKeywords(plan.keywords, "Plan");
      validatePlanWrite(roleDir, plan, false, catalog.limits.plan);
    } catch (error) {
      issues.push({ type: "plan", id: plan.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const memory of catalog.recentMemories) {
    try {
      requireKeywords(memory.keywords, "Memory");
      validateMemoryWrite(roleDir, memory, "Memory", catalog.limits.memory);
    } catch (error) {
      issues.push({ type: "recent_memory", id: memory.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const memory of catalog.consolidatedMemories) {
    try {
      requireKeywords(memory.keywords, "Consolidated memory");
      validateMemoryWrite(roleDir, memory, "Consolidated memory", catalog.limits.memory);
    } catch (error) {
      issues.push({ type: "consolidated_memory", id: memory.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: issues.length === 0, limits: catalog.limits, issues };
}

/** Memory-only validation. Undefined is an explicit cold/invalidated state. */
export function validatePublishedRoleKnowledge(roleDir: string): RoleKnowledgeValidationResult | undefined {
  const catalog = publishedRoleKnowledgeCatalogSnapshot(roleDir);
  return catalog ? validateRoleKnowledgeCatalog(roleDir, catalog) : undefined;
}

export function validateRoleKnowledge(roleDir: string): RoleKnowledgeValidationResult {
  let plans: PlanItem[] = [];
  const storageIssues: RoleKnowledgeValidationIssue[] = [];
  try {
    plans = readPlansFromStorageInWorker(roleDir);
  } catch (error) {
    storageIssues.push({
      type: "plan_storage",
      id: "*",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const limits = roleKnowledgeWriteLimits(roleDir);
  const result = validateRoleKnowledgeCatalog(roleDir, {
    plans,
    recentMemories: listRecentMemories(roleDir),
    consolidatedMemories: listConsolidatedMemories(roleDir),
    limits
  });
  return { ...result, ok: result.ok && storageIssues.length === 0, issues: [...storageIssues, ...result.issues] };
}

export function applyMemoryConsolidationResult(
  roleDir: string,
  runId: string,
  body: Record<string, unknown>,
  mutation?: StorageMutationStamp,
  checkpoint?: () => void
): Promise<{
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
}> {
  const items = Array.isArray(body.memories)
    ? body.memories
    : Array.isArray(body.consolidatedMemories)
      ? body.consolidatedMemories
      : Array.isArray(body.items)
        ? body.items
        : body;
  return completeMemoryConsolidation(roleDir, runId, items, mutation, checkpoint);
}

type ScoredKnowledgeCandidate = RoleKnowledgeIndexItem & {
  endpoint: string;
  score: number;
  activityAt: string;
  revisionAt: string;
  memory?: RecentMemoryItem | ConsolidatedMemoryItem;
  skill?: RoleSkillItem;
};

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function usefulKeyword(keyword: string): string {
  const normalized = normalizedText(keyword);
  if (normalized.length < 2) return "";
  if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) return "";
  return normalized;
}

function scoreKnowledgeMatch(
  messageText: string,
  item: { id: string; title: string; keywords?: string[] },
  activeBoost = 0
): number {
  const normalized = normalizedText(messageText);
  if (!normalized) return 0;

  let baseScore = 0;
  const id = normalizedText(item.id);
  const title = normalizedText(item.title);
  if (id && normalized.includes(id)) baseScore += 100;
  if (title.length >= 2 && normalized.includes(title)) baseScore += 80;

  let keywordScore = 0;
  for (const keyword of item.keywords ?? []) {
    const normalizedKeyword = usefulKeyword(keyword);
    if (normalizedKeyword && normalized.includes(normalizedKeyword)) {
      keywordScore += 20;
    }
  }
  baseScore += Math.min(keywordScore, 60);

  return baseScore > 0 ? baseScore + activeBoost : 0;
}

export function scoreSkillMatch(messageText: string, skill: RoleSkillItem): number {
  return scoreKnowledgeMatch(messageText, {
    id: skill.id,
    title: skill.title,
    keywords: [skill.summary, ...skill.keywords]
  }, skill.status === "active" ? 5 : 0);
}

function roleApiBase(roleId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}`;
}

function requiredReadEndpoint(roleId: string, type: RoleKnowledgeItemType, id: string): string {
  const base = roleApiBase(roleId);
  const encodedId = encodeURIComponent(id);
  if (type === "plan") return `${base}/plans/${encodedId}`;
  if (type === "recent_memory") return `${base}/memory/recent/${encodedId}`;
  if (type === "role_skill") return `${base}/skills/${encodedId}`;
  return `${base}/memory/consolidated/${encodedId}`;
}

function sortScoredCandidates(left: ScoredKnowledgeCandidate, right: ScoredKnowledgeCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = Date.parse(right.activityAt);
  const leftTime = Date.parse(left.activityAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
}

function buildRoleKnowledgeSnapshot(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions,
  catalog: Pick<
    RoleKnowledgeCatalogSnapshot,
    "plans" | "planWorkflow" | "recentMemories" | "consolidatedMemories" | "skills" | "contextInjection"
  >,
  allowPersistence: boolean
): RoleKnowledgeSnapshot {
  const plans = catalog.plans;
  const workflow = catalog.planWorkflow;
  const memories = catalog.recentMemories;
  const consolidatedMemories = catalog.consolidatedMemories;
  const skills = catalog.skills;
  const appearsInCurrent = (plan: PlanItem): boolean =>
    plan.archiveStatus !== "已归档"
      && planStatusDefinition(workflow, plan.status, { allowRetired: true })?.views.includes("current") === true;
  const activePlans = plans.filter(appearsInCurrent);
  const activeSkills = skills.filter((item) => item.status === "active");
  const recentMemories = memories.filter((item) => !item.consolidatedAt && ageHours(memoryActivityAt(item)) <= DEFAULT_RECENT_EDITABLE_HOURS);
  const roleId = options.roleId || path.basename(roleDir);
  const contextInjection = catalog.contextInjection;
  const recentMemoryIds = new Set(recentMemories.map((item) => item.id));
  const scoredCandidates: ScoredKnowledgeCandidate[] = [
    ...plans
      .filter((item) => item.archiveStatus !== "已归档")
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.focus,
        type: "plan" as const,
        endpoint: requiredReadEndpoint(roleId, "plan", item.id),
        score: scoreKnowledgeMatch(messageText, item, appearsInCurrent(item) ? 5 : 0),
        activityAt: item.updatedAt,
        revisionAt: item.updatedAt
      })),
    ...memories
      .filter((item) => !item.consolidatedAt)
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.focus,
        type: "recent_memory" as const,
        endpoint: requiredReadEndpoint(roleId, "recent_memory", item.id),
        score: scoreKnowledgeMatch(messageText, item, recentMemoryIds.has(item.id) ? 5 : 0),
        activityAt: memoryActivityAt(item),
        revisionAt: item.updatedAt,
        memory: item
      })),
    ...consolidatedMemories.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.focus,
      type: "consolidated_memory" as const,
      endpoint: requiredReadEndpoint(roleId, "consolidated_memory", item.id),
      score: scoreKnowledgeMatch(messageText, item),
      activityAt: memoryActivityAt(item),
      revisionAt: item.updatedAt,
      memory: item
    })),
    ...skills
      .filter((item) => item.status !== "archived")
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        type: "role_skill" as const,
        endpoint: requiredReadEndpoint(roleId, "role_skill", item.id),
        score: scoreSkillMatch(messageText, item),
        activityAt: item.updatedAt,
        revisionAt: item.updatedAt,
        skill: item
      }))
  ].filter((item) => item.score > 0).sort(sortScoredCandidates);

  const requiredReadItems = scoredCandidates
    .slice(0, options.requiredReadLimit ?? contextInjection.requiredReadLimit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      type: item.type,
      endpoint: item.endpoint,
      score: item.score,
      revisionAt: item.revisionAt
    }));

  if (allowPersistence && options.touchViewedAt !== false) {
    const touchedAt = nowIso();
    for (const item of requiredReadItems.filter((item) => options.touchRequiredRead?.(item) !== false)) {
      const candidate = scoredCandidates.find((candidateItem) => candidateItem.type === item.type && candidateItem.id === item.id);
      if (candidate?.type === "recent_memory" && candidate.memory) {
        touchRecentMemoryView(roleDir, candidate.memory as RecentMemoryItem, touchedAt);
      }
      if (candidate?.type === "consolidated_memory" && candidate.memory) {
        touchConsolidatedMemoryView(roleDir, candidate.memory as ConsolidatedMemoryItem, touchedAt);
      }
    }
  }

  return {
    roleDir,
    plansDir: plansDir(roleDir),
    memoryDir: memoryDir(roleDir),
    agentInterfaceDocPath: path.join(packageRoot, "docs", "rabi-agent-interfaces.md"),
    activePlans,
    activeSkills,
    recentMemories,
    matchedItems: scoredCandidates.slice(0, contextInjection.matchedItemLimit).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type
    })),
    matchedSkills: scoredCandidates
      .filter((item) => item.type === "role_skill" && item.skill)
      .slice(0, contextInjection.matchedItemLimit)
      .map((item) => item.skill as RoleSkillItem),
    requiredReadItems,
    contextInjection,
    pendingConsolidation: allowPersistence && options.includePendingConsolidation
      ? pendingMemoryConsolidation(
          roleDir,
          options.consolidationTrigger ?? "auto",
          DEFAULT_RECENT_EDITABLE_HOURS,
          DEFAULT_RECENT_CONSOLIDATION_HOURS,
          options.forceConsolidation === true
        ) ?? undefined
      : undefined
  };
}

export function roleKnowledgeSnapshot(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions = {}
): RoleKnowledgeSnapshot {
  const snapshot = roleKnowledgeSnapshotFromPublishedCatalog(roleDir, messageText, options);
  if (!snapshot) throw new RoleKnowledgeCacheUnavailableError(roleDir);
  return snapshot;
}

/**
 * Physical RoleKnowledge read for an isolated codex-hook process or bounded
 * storage worker. Manager request/event paths must use the published resolver.
 */
export function roleKnowledgeSnapshotFromStorage(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions = {}
): RoleKnowledgeSnapshot {
  if (options.archiveCompletedPlans === true) {
    const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
    archiveCompletedPlansFromStorage(roleDir, workflow.archiveAfterHours);
  }
  return buildRoleKnowledgeSnapshot(roleDir, messageText, options, {
    plans: readPlansFromStorageInWorker(roleDir),
    planWorkflow: ensurePersonaPlanWorkflow(roleDir).workflow,
    recentMemories: listRecentMemories(roleDir),
    consolidatedMemories: listConsolidatedMemories(roleDir),
    skills: listRoleSkills(roleDir),
    contextInjection: roleContextInjectionPolicy(roleDir)
  }, true);
}

/** Memory-only recall projection. Undefined is an explicit cold state. */
export function roleKnowledgeSnapshotFromPublishedCatalog(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions = {}
): RoleKnowledgeSnapshot | undefined {
  const catalog = publishedRoleKnowledgeCatalogSnapshot(roleDir);
  if (!catalog) return undefined;
  return buildRoleKnowledgeSnapshot(roleDir, messageText, {
    ...options,
    archiveCompletedPlans: false,
    includePendingConsolidation: false,
    touchViewedAt: false
  }, catalog, false);
}

function indexTypeLabel(type: RoleKnowledgeItemType): string {
  if (type === "plan") return "计划";
  if (type === "recent_memory") return "近期记忆";
  if (type === "role_skill") return "角色技能";
  return "沉淀记忆";
}

export function indexLines<T extends { id: string; title: string }>(items: T[], empty = "- 暂无"): string {
  if (items.length === 0) return empty;
  return items.map((item) => {
    const type = "type" in item ? (item as T & { type?: RoleKnowledgeItemType }).type : undefined;
    const prefix = type ? `[${indexTypeLabel(type)}] ` : "";
    return `- ${prefix}${item.id}：${item.title}`;
  }).join("\n");
}
