import type { RoleMemory, RoleMemoryPayload, RolePlan, RolePlanFeedback, RolePlanHistoryRecord } from "./types";
import type { PlanFeedbackAttachmentUpload } from "@shared/planFeedbackContract";
import { FALLBACK_PLAN_PRESENTATION_PALETTE, normalizePlanPresentationPalette } from "./planPresentationStyles";
import { knowledgeItemMatchesQuery } from "./knowledgeSearch";

export type RolePlanPageCounts = {
  total: number;
  current: number;
  plans: number;
  archived: number;
  blocked: number;
  qa: number;
  active: number;
  stages: {
    analyzing: number;
    executing: number;
    discussion: number;
    qa: number;
    waitingPackage: number;
    approval: number;
    paused: number;
    completed: number;
    archived: number;
  };
};

export type RolePlanPage = {
  items: RolePlan[];
  total: number;
  nextCursor: string;
  counts: RolePlanPageCounts;
  facets: {
    statuses: Array<{
      status: string;
      count: number;
      label: string;
      labelEn: string;
      description: string;
      descriptionEn: string;
      tone: string;
      statusLevel: number;
      palette: RolePlan["presentation"]["palette"];
    }>;
    tags: Array<{
      tag: string;
      count: number;
    }>;
  };
};

export type PlanAgentRole = "task" | "secretary";
export type PlanAgentWorkStatus = "working" | "idle" | "unknown";
export type PlanAgentSessionStatus =
  | "active"
  | "idle"
  | "not_loaded"
  | "unavailable"
  | "archived"
  | "missing"
  | "workspace_mismatch"
  | "unbound"
  | "unknown";

export type PlanAgentBindingStatus = {
  role: PlanAgentRole;
  configured: boolean;
  agentType: "codex" | "dsh";
  threadId: string;
  threadTitle: string;
  workspace: string;
  working: boolean;
  agentStatus: PlanAgentWorkStatus;
  sessionStatus: PlanAgentSessionStatus;
  canOpen: boolean;
  checkedAt: string;
  message?: string;
};

export type PlanAgentStatus = {
  planId: string;
  checkedAt: string;
  taskAgent: PlanAgentBindingStatus;
  secretaryAgent?: PlanAgentBindingStatus;
};

export type PlanAgentStatusBatch = {
  items: PlanAgentStatus[];
  missingPlanIds: string[];
  failedPlanIds: string[];
};

export type RoleMemoryPageCounts = {
  recent: number;
  consolidated: number;
  archived: number;
  consolidationRuns: number;
};

export type RoleKnowledgeFileCounts = {
  activePlans: number;
  archivedPlans: number;
  recentMemory: number;
  consolidatedMemory: number;
  consolidationRuns: number;
};

export type RoleMemoryKind = "recent" | "consolidated" | "archived";

export type RoleMemoryPage = {
  items: RoleMemory[];
  total: number;
  nextCursor: string;
  counts: RoleMemoryPageCounts;
};

export const ROLE_PLAN_PAGE_SIZE = 8;
export const ROLE_MEMORY_BACKGROUND_PAGE_SIZE = 100;

export type RolePlanPageFilter = {
  view?: "current" | "plans" | "archived";
  query?: string;
  sort?: "status" | "updated" | "importance" | "urgency";
  statuses?: string[];
  tags?: string[];
  includeFacets?: boolean;
};

type RolePlanSummary = Pick<
  RolePlan,
  "id" | "title" | "status" | "archiveStatus" | "importance" | "urgency" | "priority" | "kind" | "currentStep" | "currentStepId" | "currentStepPreview" | "currentStepPosition" | "dueAt" | "project" | "secretaryBinding" | "taskBinding" | "createdAt" | "updatedAt" | "keywords" | "presentation" | "detailLevel"
> & {
  attachmentCount: number;
  stepCount: number;
  completedStepCount: number;
};

type ManagerEnvelope<T> = {
  errorMessages?: { "zh-CN"?: string; en?: string };
  reason?: string;
  commitState?: string;
  nextAction?: string;
  code: number;
  message?: string;
  data?: T;
};

export type ManagerResource<T> = {
  data: T;
  etag: string;
};

export class ManagerRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number, readonly details?: { reason?: string; commitState?: string; nextAction?: string; causeCode?: string; errorMessages?: { "zh-CN"?: string; en?: string } }) {
    super(details?.nextAction ? `${message}\n${details.nextAction}` : message);
    this.name = "ManagerRequestError";
    this.status = status;
  }
}

export type PlanFeedbackMutationResult = {
  feedback: RolePlanFeedback;
  etag: string;
  idempotencyKey: string;
};

export const ROLE_KNOWLEDGE_REQUEST_TIMEOUT_MS = 12_000;
const managerResourceEtags = new Map<string, string>();
let activeManagerLifecycleKey = "";

type ManagerLifecycleIdentity = {
  applicationGenerationId: string;
  managerInstanceId: string;
};

function managerLifecycleKey(identity: ManagerLifecycleIdentity): string {
  return `${identity.applicationGenerationId}\u0000${identity.managerInstanceId}`;
}

async function readManagerLifecycleIdentity(): Promise<ManagerLifecycleIdentity> {
  const response = await boundedManagerFetch("/meta", {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  const body = await response.json().catch(() => ({})) as Partial<ManagerLifecycleIdentity>;
  const applicationGenerationId = String(body.applicationGenerationId || "").trim();
  const managerInstanceId = String(body.managerInstanceId || "").trim();
  if (!response.ok || !applicationGenerationId || !managerInstanceId) {
    throw new ManagerRequestError("Manager did not publish a complete lifecycle identity.", response.status || 502);
  }
  return { applicationGenerationId, managerInstanceId };
}

export async function synchronizeRoleKnowledgeLifecycle(): Promise<string> {
  try {
    const nextKey = managerLifecycleKey(await readManagerLifecycleIdentity());
    if (activeManagerLifecycleKey !== nextKey) managerResourceEtags.clear();
    activeManagerLifecycleKey = nextKey;
    return nextKey;
  } catch (error) {
    activeManagerLifecycleKey = "";
    managerResourceEtags.clear();
    throw error;
  }
}

function managerResourceEtagKey(lifecycleKey: string, path: string): string {
  return `${lifecycleKey}\u0000${path}`;
}

function strongEtag(response: Response): string {
  const etag = String(response.headers.get("etag") || "").trim();
  if (!etag || /^W\//i.test(etag) || !/^"[^"\r\n]+"$/.test(etag)) return "";
  return etag;
}

async function boundedManagerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const inheritedSignal = init.signal;
  const abortInheritedRequest = () => controller.abort(inheritedSignal?.reason);
  if (inheritedSignal?.aborted) abortInheritedRequest();
  else inheritedSignal?.addEventListener("abort", abortInheritedRequest, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), ROLE_KNOWLEDGE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !inheritedSignal?.aborted) {
      throw new ManagerRequestError(`Manager request timed out after ${ROLE_KNOWLEDGE_REQUEST_TIMEOUT_MS}ms.`, 0);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    inheritedSignal?.removeEventListener("abort", abortInheritedRequest);
  }
}

async function managerResource<T>(
  path: string,
  init: RequestInit = {},
  lifecycleKey = ""
): Promise<ManagerResource<T>> {
  try {
    const response = await boundedManagerFetch(path, init);
    const body = await response.json().catch(() => ({})) as ManagerEnvelope<T>;
    if (!response.ok || body.code !== 0 || body.data == null) {
      throw new ManagerRequestError(body.message || `Manager request failed (HTTP ${response.status}).`, response.status, body);
    }
    const etag = strongEtag(response);
    if (etag && lifecycleKey) managerResourceEtags.set(managerResourceEtagKey(lifecycleKey, path), etag);
    return { data: body.data, etag };
  } catch (error) {
    throw error;
  }
}

async function managerData<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await managerResource<T>(path, init)).data;
}

export function normalizeRolePlanFromManager(plan: RolePlan): RolePlan {
  const attachments = Array.isArray(plan.attachments) ? plan.attachments : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const normalizedCounts = {
    attachments,
    steps,
    attachmentCount: Number.isFinite(plan.attachmentCount) ? plan.attachmentCount : attachments.length,
    stepCount: Number.isFinite(plan.stepCount) ? plan.stepCount : steps.length,
    completedStepCount: Number.isFinite(plan.completedStepCount)
      ? plan.completedStepCount
      : steps.filter((step) => Boolean(step.completedAt)).length,
    detailLevel: plan.detailLevel || (steps.length || attachments.length || plan.focus ? "full" : "summary")
  } satisfies Pick<RolePlan, "attachments" | "steps" | "attachmentCount" | "stepCount" | "completedStepCount" | "detailLevel">;
  if (plan.presentation && plan.presentation.approval) {
    return {
      ...plan,
      ...normalizedCounts,
      presentation: {
        ...plan.presentation,
        status: String(plan.presentation.status || ""),
        label: String(plan.presentation.label || ""),
        labelEn: String(plan.presentation.labelEn || ""),
        description: String(plan.presentation.description || ""),
        descriptionEn: String(plan.presentation.descriptionEn || ""),
        tone: String(plan.presentation.tone || "unknown"),
        statusLevel: Number.isFinite(plan.presentation.statusLevel) ? plan.presentation.statusLevel : Number.MAX_SAFE_INTEGER,
        acceptsGuidance: plan.presentation.acceptsGuidance === true,
        views: Array.isArray(plan.presentation.views) ? plan.presentation.views : [],
        palette: normalizePlanPresentationPalette(plan.presentation.palette),
        importance: plan.presentation.importance ? {
          ...plan.presentation.importance,
          palette: normalizePlanPresentationPalette(plan.presentation.importance.palette)
        } : undefined,
        urgency: plan.presentation.urgency ? {
          ...plan.presentation.urgency,
          palette: normalizePlanPresentationPalette(plan.presentation.urgency.palette)
        } : undefined,
        approval: {
          ...plan.presentation.approval,
          state: plan.presentation.approval.state || (plan.presentation.approval.enabled ? "ready" : "none"),
          missing: Array.isArray(plan.presentation.approval.missing) ? plan.presentation.approval.missing : []
        }
      },
      approval: plan.approval || { count: 0 }
    };
  }
  return {
    ...plan,
    ...normalizedCounts,
    presentation: {
      status: "",
      label: "",
      labelEn: "",
      description: "",
      descriptionEn: "",
      tone: "unknown",
      statusLevel: Number.MAX_SAFE_INTEGER,
      acceptsGuidance: false,
      views: [],
      palette: { ...FALLBACK_PLAN_PRESENTATION_PALETTE },
      approval: {
        state: "none",
        enabled: false,
        label: "无需审批",
        helper: "当前步骤没有声明人工审批门禁。",
        missing: []
      }
    },
    approval: plan.approval || { count: 0 }
  };
}

export async function loadRoleKnowledgeFileCounts(roleId: string): Promise<RoleKnowledgeFileCounts> {
  return managerData<RoleKnowledgeFileCounts>(`/api/roles/${encodeURIComponent(roleId)}/counts`, { cache: "no-store" });
}

export async function loadRoleKnowledge(roleId: string): Promise<{ plans: RolePlan[]; memory: RoleMemoryPayload }> {
  const encodedRoleId = encodeURIComponent(roleId);
  const [plans, memory] = await Promise.all([
    managerData<RolePlan[]>(`/api/roles/${encodedRoleId}/plans`),
    managerData<RoleMemoryPayload>(`/api/roles/${encodedRoleId}/memory`)
  ]);
  return { plans: plans.map(normalizeRolePlanFromManager), memory };
}

export async function loadPlanHistory(roleId: string, planId: string): Promise<RolePlanHistoryRecord[]> {
  const data = await managerData<{ records?: RolePlanHistoryRecord[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}/history`
  );
  return Array.isArray(data.records) ? data.records : [];
}

function planFeedbackPath(roleId: string, planId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}/feedback`;
}

function normalizedPlanApproval(data: RolePlan["approval"] & { records?: RolePlanFeedback[] }): RolePlan["approval"] {
  const records = Array.isArray(data.records) ? data.records : [];
  return {
    count: Number(data.count || records.length),
    latest: data.latest || records[0],
    records
  };
}

export async function loadPlanFeedbackWithRevision(
  roleId: string,
  planId: string
): Promise<{ approval: RolePlan["approval"]; etag: string }> {
  const path = planFeedbackPath(roleId, planId);
  let lifecycleKey = await synchronizeRoleKnowledgeLifecycle();
  let resource = await managerResource<RolePlan["approval"] & { records?: RolePlanFeedback[] }>(path, { cache: "no-store" }, lifecycleKey);
  const verifiedLifecycleKey = await synchronizeRoleKnowledgeLifecycle();
  if (lifecycleKey !== verifiedLifecycleKey) {
    lifecycleKey = verifiedLifecycleKey;
    resource = await managerResource<RolePlan["approval"] & { records?: RolePlanFeedback[] }>(path, { cache: "no-store" }, lifecycleKey);
    if (lifecycleKey !== await synchronizeRoleKnowledgeLifecycle()) {
      throw new ManagerRequestError("Manager lifecycle changed while reading plan feedback; retry after it is ready.", 503);
    }
  }
  if (!resource.etag) throw new ManagerRequestError("Manager did not return a strong plan storage ETag.", 502);
  return { approval: normalizedPlanApproval(resource.data), etag: resource.etag };
}

export async function loadPlanFeedback(roleId: string, planId: string): Promise<RolePlan["approval"]> {
  return (await loadPlanFeedbackWithRevision(roleId, planId)).approval;
}

export function cachedPlanFeedbackRevision(roleId: string, planId: string): string {
  if (!activeManagerLifecycleKey) return "";
  return managerResourceEtags.get(managerResourceEtagKey(activeManagerLifecycleKey, planFeedbackPath(roleId, planId))) || "";
}

function summaryAsPlan(summary: RolePlanSummary): RolePlan {
  return normalizeRolePlanFromManager({
    ...summary,
    focus: "",
    attachments: [],
    steps: [],
    approval: { count: 0 }
  });
}

function normalizedPlanStatusFacet(
  facet: RolePlanPage["facets"]["statuses"][number]
): RolePlanPage["facets"]["statuses"][number] {
  return {
    status: String(facet.status || ""),
    count: Number.isFinite(facet.count) ? facet.count : 0,
    label: String(facet.label || ""),
    labelEn: String(facet.labelEn || ""),
    description: String(facet.description || ""),
    descriptionEn: String(facet.descriptionEn || ""),
    tone: String(facet.tone || "unknown"),
    statusLevel: Number.isFinite(facet.statusLevel) ? facet.statusLevel : Number.MAX_SAFE_INTEGER,
    palette: normalizePlanPresentationPalette(facet.palette)
  };
}

export async function loadRolePlanPage(
  roleId: string,
  cursor = "",
  limit = ROLE_PLAN_PAGE_SIZE,
  filter: RolePlanPageFilter = {}
): Promise<RolePlanPage> {
  const params = new URLSearchParams({ limit: String(limit), detail: "summary" });
  if (cursor) params.set("cursor", cursor);
  if (filter.view) params.set("view", filter.view);
  if (filter.query?.trim()) params.set("query", filter.query.trim());
  if (filter.sort && filter.sort !== "status") params.set("sort", filter.sort);
  for (const status of filter.statuses || []) params.append("status", status);
  for (const tag of filter.tags || []) params.append("tag", tag);
  if (filter.includeFacets === false) params.set("facets", "0");
  const page = await managerData<Omit<RolePlanPage, "items"> & { items: RolePlanSummary[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans?${params.toString()}`
  );
  return {
    ...page,
    items: page.items.map(summaryAsPlan),
    facets: page.facets ? {
      ...page.facets,
      statuses: page.facets.statuses.map(normalizedPlanStatusFacet)
    } : page.facets
  };
}

export async function loadRolePlanPreview(roleId: string, planId: string): Promise<RolePlan> {
  return normalizeRolePlanFromManager(await managerData<RolePlan>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}?detail=preview`
  ));
}

export async function loadRolePlan(roleId: string, planId: string): Promise<RolePlan> {
  const plan = normalizeRolePlanFromManager(await managerData<RolePlan>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}`
  ));
  return {
    ...plan,
    attachmentCount: plan.attachments.length,
    stepCount: plan.steps.length,
    completedStepCount: plan.steps.filter((step) => Boolean(step.completedAt)).length,
    detailLevel: "full"
  };
}

const PLAN_AGENT_STATUS_CHUNK_SIZE = 40;

function planAgentStatusChunks(planIds: string[]): string[][] {
  const unique = [...new Set(planIds.map((planId) => planId.trim()).filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += PLAN_AGENT_STATUS_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + PLAN_AGENT_STATUS_CHUNK_SIZE));
  }
  return chunks;
}

export async function loadPlanAgentStatuses(
  roleId: string,
  planIds: string[],
  timeoutMs = 3_000
): Promise<PlanAgentStatusBatch> {
  const chunks = planAgentStatusChunks(planIds);
  if (!chunks.length) return { items: [], missingPlanIds: [], failedPlanIds: [] };
  const results = await Promise.allSettled(chunks.map(async (chunk) => {
    const params = new URLSearchParams();
    for (const planId of chunk) params.append("planId", planId);
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const data = await managerData<{ items: PlanAgentStatus[]; missingPlanIds?: string[] }>(
        `/api/roles/${encodeURIComponent(roleId)}/plan-agents/status?${params.toString()}`,
        { signal: controller.signal }
      );
      return {
        planIds: chunk,
        items: Array.isArray(data.items) ? data.items : [],
        missingPlanIds: Array.isArray(data.missingPlanIds) ? data.missingPlanIds : []
      };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }));
  const items: PlanAgentStatus[] = [];
  const missingPlanIds: string[] = [];
  const failedPlanIds: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
      missingPlanIds.push(...result.value.missingPlanIds);
    } else {
      const index = results.indexOf(result);
      failedPlanIds.push(...(chunks[index] || []));
    }
  }
  return {
    items,
    missingPlanIds: [...new Set(missingPlanIds)],
    failedPlanIds: [...new Set(failedPlanIds)]
  };
}

export async function openPlanAgentTask(
  roleId: string,
  planId: string,
  role: PlanAgentRole
): Promise<{ opened: true; agentType: "codex" | "dsh"; threadId: string; threadTitle: string; workspace: string }> {
  return managerData(
    `/api/roles/${encodeURIComponent(roleId)}/plan-agents/${encodeURIComponent(planId)}/open`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role })
    }
  );
}

export async function loadRoleMemory(roleId: string): Promise<RoleMemoryPayload> {
  return managerData<RoleMemoryPayload>(`/api/roles/${encodeURIComponent(roleId)}/memory`);
}

export async function loadRoleMemoryCounts(roleId: string): Promise<RoleMemoryPageCounts> {
  const data = await managerData<RoleMemoryPageCounts | RoleMemoryPayload>(
    `/api/roles/${encodeURIComponent(roleId)}/memory?counts=1`
  );
  if (typeof data.recent === "number" && typeof data.consolidated === "number") {
    const counts = data as RoleMemoryPageCounts;
    return {
      recent: counts.recent,
      consolidated: counts.consolidated,
      archived: typeof counts.archived === "number" ? counts.archived : 0,
      consolidationRuns: typeof counts.consolidationRuns === "number" ? counts.consolidationRuns : 0
    };
  }
  const payload = data as RoleMemoryPayload;
  const archived = payload.archived || payload.recent.filter((memory) => Boolean(memory.consolidatedAt));
  const recent = payload.archived ? payload.recent : payload.recent.filter((memory) => !memory.consolidatedAt);
  return {
    recent: recent.length,
    consolidated: payload.consolidated.length,
    archived: archived.length,
    consolidationRuns: 0
  };
}

export async function loadPendingMemoryConsolidationRunCount(roleId: string): Promise<number> {
  const runs = await managerData<unknown>(
    `/api/roles/${encodeURIComponent(roleId)}/memory/consolidation-runs`,
    { cache: "no-store" }
  );
  if (!Array.isArray(runs)) throw new Error("Manager returned an invalid memory consolidation run list.");
  return runs.filter((run) => (
    run !== null
    && typeof run === "object"
    && "status" in run
    && run.status === "requested"
  )).length;
}

export async function loadRoleMemoryPage(
  roleId: string,
  kind: RoleMemoryKind,
  cursor = "",
  limit = 24,
  query = ""
): Promise<RoleMemoryPage> {
  const params = new URLSearchParams({ kind, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (query.trim()) params.set("query", query.trim());
  const data = await managerData<RoleMemoryPage | RoleMemoryPayload>(
    `/api/roles/${encodeURIComponent(roleId)}/memory?${params.toString()}`
  );
  if ("items" in data) {
    return {
      ...data,
      counts: {
        ...data.counts,
        archived: typeof data.counts.archived === "number" ? data.counts.archived : 0
      }
    };
  }

  const start = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const pageLimit = Math.min(100, Math.max(1, Math.floor(limit) || 24));
  const archived = data.archived || data.recent.filter((memory) => Boolean(memory.consolidatedAt));
  const recent = data.archived ? data.recent : data.recent.filter((memory) => !memory.consolidatedAt);
  const source = kind === "archived" ? archived : kind === "consolidated" ? data.consolidated : recent;
  const items = source.filter((item) => knowledgeItemMatchesQuery(item, query));
  const end = Math.min(items.length, start + pageLimit);
  return {
    items: items.slice(start, end),
    total: items.length,
    nextCursor: end < items.length ? String(end) : "",
    counts: {
      recent: recent.length,
      consolidated: data.consolidated.length,
      archived: archived.length,
      consolidationRuns: 0
    }
  };
}

export async function submitPlanFeedback(input: {
  roleId: string;
  planId: string;
  gatewayId?: string;
  stepId?: string;
  feedbackId: string;
  text: string;
  attachments: PlanFeedbackAttachmentUpload[];
  planAttachmentIds: string[];
  source: "webgui" | "tray";
  kind: "guidance" | "approval_suggestion";
  notifyAgent?: boolean;
  expectedRevision: string;
}): Promise<PlanFeedbackMutationResult> {
  const expectedRevision = String(input.expectedRevision || "").trim();
  if (!expectedRevision || /^W\//i.test(expectedRevision) || !/^"[^"\r\n]+"$/.test(expectedRevision)) {
    throw new ManagerRequestError("Plan feedback requires the exact strong ETag returned by Manager.", 400);
  }
  const feedbackId = String(input.feedbackId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,170}$/.test(feedbackId)) {
    throw new ManagerRequestError("Plan feedback requires a stable feedbackId.", 400);
  }
  const idempotencyKey = `plan-feedback:${feedbackId}`;
  const path = planFeedbackPath(input.roleId, input.planId);
  const lifecycleKey = await synchronizeRoleKnowledgeLifecycle();
  if (managerResourceEtags.get(managerResourceEtagKey(lifecycleKey, path)) !== expectedRevision) {
    throw new ManagerRequestError("Plan feedback must use the strong ETag from a current-generation GET.", 412);
  }
  const response = await boundedManagerFetch(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "idempotency-key": idempotencyKey,
        "if-match": expectedRevision
      },
      body: JSON.stringify({
        feedbackId: input.feedbackId,
        gatewayId: input.gatewayId,
        stepId: input.stepId,
        text: input.text,
        attachments: input.attachments,
        planAttachmentIds: input.planAttachmentIds,
        source: input.source,
        kind: input.kind,
        author: "user",
        notifyAgent: input.notifyAgent !== false
      })
    }
  );
  const body = await response.json().catch(() => ({})) as ManagerEnvelope<RolePlanFeedback>;
  if (!response.ok || body.code !== 0 || !body.data) {
    throw new ManagerRequestError(body.message || `Manager request failed (HTTP ${response.status}).`, response.status, {
      errorMessages: body.errorMessages, reason: body.reason, commitState: body.commitState, nextAction: body.nextAction, causeCode: (body as ManagerEnvelope<unknown> & { causeCode?: string }).causeCode
    });
  }
  if (String(body.data.id || "").trim() !== feedbackId
    || String(body.data.planId || "").trim() !== String(input.planId || "").trim()) {
    throw new ManagerRequestError("Manager plan feedback receipt body did not confirm the submitted feedbackId and planId.", 502);
  }
  const etag = strongEtag(response);
  if (!etag) throw new ManagerRequestError("Manager committed plan feedback without returning a strong ETag.", 502);
  const receiptIdempotencyKey = String(response.headers.get("idempotency-key") || "").trim();
  if (receiptIdempotencyKey !== idempotencyKey) {
    throw new ManagerRequestError("Manager plan feedback receipt did not confirm the submitted Idempotency-Key.", 502);
  }
  if (lifecycleKey !== await synchronizeRoleKnowledgeLifecycle()) {
    throw new ManagerRequestError("Manager lifecycle changed while committing plan feedback; retry the same feedbackId after reloading.", 503);
  }
  managerResourceEtags.set(managerResourceEtagKey(lifecycleKey, path), etag);
  return {
    feedback: body.data,
    etag,
    idempotencyKey: receiptIdempotencyKey
  };
}
