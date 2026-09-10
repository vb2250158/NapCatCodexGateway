<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, markRaw, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES,
  PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES,
  PLAN_FEEDBACK_MAX_ATTACHMENTS,
  type PlanFeedbackAttachmentUpload
} from "@shared/planFeedbackContract";
import {
  planAttachmentMentionCandidates,
  referencedPlanAttachmentIds
} from "@shared/planAttachmentMentions";
import PlanAttachmentGallery from "../components/PlanAttachmentGallery.vue";
import PlanFeedbackComposer from "../components/PlanFeedbackComposer.vue";
import PlanQuestionFields from "../components/PlanQuestionFields.vue";
import { approvalDecisionQuestions, planQuestionReply, type PlanQuestionAnswer } from "@shared/planQuestions";
import PlanStepDetail from "../components/PlanStepDetail.vue";
import { useI18n } from "../i18n";
import { knowledgeItemMatchesQuery, normalizeKnowledgeQuery } from "../knowledgeSearch";
import { knowledgePageShouldWork } from "../knowledgePageActivity";
import { managerEventSource, managerResourceUrl } from "../managerApi";
import {
  isPlanMarkdownAttachment,
  PLAN_MARKDOWN_PREVIEW_MAX_BYTES,
  PLAN_MARKDOWN_TEASER_READ_BYTES,
  planMarkdownPreviewExcerpt,
  responseTextByByteLimit,
  renderMemoryMarkdownPreview,
  renderPlanMarkdownPreview
} from "../markdownPreview";
import { activePlanIdAtAnchor, directoryScrollTopForItem } from "../planDirectoryScrollSync";
import {
  hasMoreKnowledgeAfterWindow,
  hasMoreKnowledgeBeforeWindow,
  knowledgeRenderWindow,
  mergeKnowledgePage,
  drainKnowledgePages,
  nextKnowledgeRenderLimit,
  previousKnowledgeRenderWindow,
  shouldAutoLoadNextKnowledgeBatch
} from "../knowledgePagination";
import {
  loadPlanFeedbackWithRevision,
  loadPlanHistory,
  loadPlanAgentStatuses,
  loadPendingMemoryConsolidationRunCount,
  loadRoleMemoryPage,
  loadRoleKnowledgeFileCounts,
  loadRolePlan,
  loadRolePlanPage,
  loadRolePlanPreview,
  openPlanAgentTask,
  submitPlanFeedback,
  ManagerRequestError,
  type PlanAgentBindingStatus,
  type PlanAgentRole,
  type PlanAgentSessionStatus,
  type PlanAgentStatus,
  type RoleMemoryKind,
  type RoleMemoryPageCounts,
  type RolePlanPageCounts,
  type RolePlanPageFilter
} from "../roleKnowledgeClient";
import { localizedPlanError, planFeedbackSubmissionErrorMessage } from "../approvalFeedbackUi";
import { planFeedbackMutationLedger } from "../planFeedbackMutationLedger";
import { formatPlanDirectorySortLabel, formatPlanDirectorySortLabelTitle, formatPlanVideoDuration, planCardStyle, planDescriptionForDisplay, planDirectorySortPalette, planStatusDescriptionForDisplay, planStatusLabelForDisplay, planStatusStyle, plansForKnowledgeView, planTitleForDirectory } from "../planPresentationStyles";
import type { PlanKnowledgeView, PlanListSortMode } from "../planPresentationStyles";
import { useGatewayStore } from "../stores/gatewayStore";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import type { RoleMemory, RolePlan, RolePlanApprovalContract, RolePlanFeedback, RolePlanHistoryRecord, RolePlanStep } from "../types";

const store = useGatewayStore();
const route = useRoute();
const { isEnglish, t } = useI18n();
const plans = ref<RolePlan[]>([]);
const recentMemory = ref<RoleMemory[]>([]);
const consolidatedMemory = ref<RoleMemory[]>([]);
const archivedMemory = ref<RoleMemory[]>([]);
const loading = ref(false);
const loadingMorePlans = ref(false);
const memoryLoading = ref(false);
const planError = ref("");
const memoryError = ref("");
const activeView = ref<PlanKnowledgeView>("plans");
const query = ref<string | null>("");
const expandedPlans = reactive<Record<string, boolean>>({});
const planWorkHistoryExpanded = reactive<Record<string, boolean>>({});
const planHistoryRecords = reactive<Record<string, RolePlanHistoryRecord[]>>({});
const planHistoryLoading = reactive<Record<string, boolean>>({});
const planVideoDurations = reactive<Record<string, number>>({});
const activeDirectoryPlanId = ref("");
const planListSortMode = ref<PlanListSortMode>("status");
const planListHiddenStatuses = ref<string[]>([]);
const planListSelectedTags = ref<string[]>([]);
const planListDraftSortMode = ref<PlanListSortMode>("status");
const planListDraftHiddenStatuses = ref<string[]>([]);
const planListDraftSelectedTags = ref<string[]>([]);
const planListTagQuery = ref("");
const planListDialogOpen = ref(false);
const planListDialogContentCached = ref(false);
const planListResultTotal = ref(0);
type PlanStatusOption = {
  status: string;
  count: number;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  tone: string;
  statusLevel: number;
  palette: RolePlan["presentation"]["palette"];
};
const planListStatusOptions = ref<PlanStatusOption[]>([]);
const planListTagOptions = ref<Array<{
  tag: string;
  count: number;
}>>([]);
const approvalDrafts = reactive<Record<string, string>>({});
const questionDrafts = reactive<Record<string, { signature: string; answers: Record<string, PlanQuestionAnswer> }>>({});
function feedbackQuestions(plan: RolePlan) {
  const questions = currentStep(plan)?.questions ?? [];
  return plan.presentation.approval.state !== "none" ? approvalDecisionQuestions(questions, t) : questions;
}
function questionSignature(plan: RolePlan): string {
  return JSON.stringify([roleId.value, plan.status, plan.currentStepId, currentStep(plan)?.questions ?? [], plan.presentation.approval]);
}
function questionAnswers(plan: RolePlan): Record<string, PlanQuestionAnswer> {
  const draft = questionDrafts[plan.id];
  return draft?.signature === questionSignature(plan) ? draft.answers : {};
}
function updateQuestionAnswer(plan: RolePlan, id: string, answer: PlanQuestionAnswer): void {
  questionDrafts[plan.id] = { signature: questionSignature(plan), answers: { ...questionAnswers(plan), [id]: answer } };
}
function composedFeedback(plan: RolePlan): { text: string; valid: boolean } {
  const reply = planQuestionReply(feedbackQuestions(plan), questionAnswers(plan));
  const text = [reply.text, feedbackQuestions(plan).length ? "" : String(approvalDrafts[plan.id] || "").trim()].filter(Boolean).join("\n\n");
  return { text, valid: reply.valid && text.length <= 2000 };
}
const approvalPending = reactive<Record<string, boolean>>({});
const approvalDeliveryPending = reactive<Record<string, boolean>>({});
const approvalRequestIds = reactive<Record<string, string>>({});
const approvalRequestSignatures = reactive<Record<string, string>>({});
const approvalRevisions = reactive<Record<string, string>>({});
const approvalNotices = reactive<Record<string, { tone: "success" | "warning" | "error"; text: string }>>({});
const submittedApprovalTexts = new Map<string, string>();
type ApprovalAttachmentDraft = {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "image";
  previewUrl?: string;
};
const approvalAttachments = reactive<Record<string, ApprovalAttachmentDraft[]>>({});
const submittedApprovalAttachments = new Map<string, ApprovalAttachmentDraft[]>();
const planAttachmentPreview = ref<{ name: string; url: string; kind: "image" | "video" } | null>(null);
const planMarkdownPreview = ref<{ name: string; url: string; html: string; error: string; loading: boolean } | null>(null);
const memoryDetailPreview = ref<{ memory: RoleMemory; kind: RoleMemoryKind } | null>(null);
type PlanMarkdownTeaserState = { text: string; loading: boolean };
const planMarkdownTeasers = reactive<Record<string, PlanMarkdownTeaserState>>({});
type PlanMediaLoadState = "loading" | "loaded" | "error";
const planMediaLoadStates = reactive<Record<string, PlanMediaLoadState>>({});
const planDetailsLoaded = reactive<Record<string, boolean>>({});
const planDetailsLoading = reactive<Record<string, boolean>>({});
const planFullDetailsLoaded = reactive<Record<string, boolean>>({});
const planFullDetailsLoading = reactive<Record<string, boolean>>({});
const planAgentStatuses = reactive<Record<string, PlanAgentStatus>>({});
const planAgentStatusLoading = reactive<Record<string, boolean>>({});
const planAgentOpenPending = reactive<Record<string, boolean>>({});
const planAgentNotices = reactive<Record<string, { tone: "success" | "error"; text: string }>>({});
const planPageCounts = ref<RolePlanPageCounts>({
  total: 0,
  current: 0,
  plans: 0,
  archived: 0,
  blocked: 0,
  qa: 0,
  active: 0,
  stages: {
    analyzing: 0,
    executing: 0,
    discussion: 0,
    qa: 0,
    waitingPackage: 0,
    approval: 0,
    paused: 0,
    completed: 0,
    archived: 0
  }
});
const planNextCursor = ref("");
const memoryNextCursor = ref("");
const memoryPageCounts = ref<RoleMemoryPageCounts>({ recent: 0, consolidated: 0, archived: 0, consolidationRuns: 0 });
const pendingMemoryConsolidationRuns = ref(0);
const planRenderStart = ref(0);
const planRenderLimit = ref(8);
const memoryRenderLimit = ref(24);
const memoryClock = ref(Date.now());
const knowledgeToolbar = ref<HTMLElement | null>(null);
const planDirectoryList = ref<HTMLElement | null>(null);
const planLoadPreviousSentinel = ref<HTMLElement | null>(null);
const planLoadMoreSentinel = ref<HTMLElement | null>(null);
const memoryLoadMoreSentinel = ref<HTMLElement | null>(null);
let requestVersion = 0;
let managerEvents: EventSource | null = null;
let planCardObserver: IntersectionObserver | null = null;
let toolbarResizeObserver: ResizeObserver | null = null;
let planPageObserver: IntersectionObserver | null = null;
let memoryPageObserver: IntersectionObserver | null = null;
let planDetailObserver: IntersectionObserver | null = null;
let planDirectorySyncFrame = 0;
let planObserverRefreshFrame = 0;
let planDirectoryMounted = false;
let usesPlanScrollFallback = false;
let knowledgeScrollDirection: "up" | "down" | "" = "";
let lastKnowledgeScrollY = 0;
let directoryJumpTargetId = "";
let directoryJumpSettleTimer = 0;
let planMarkdownPreviewAbort: AbortController | null = null;
let planMarkdownTeaserAbort: AbortController | null = null;
let planDetailQueue: Array<{ planId: string; request: number }> = [];
const queuedPlanDetailIds = new Set<string>();
const pendingPlanAgentStatusIds = new Set<string>();
let activePlanDetailRequests = 0;
const MAX_CONCURRENT_PLAN_DETAILS = 4;
let knowledgeFilterTimer = 0;
let memoryClockTimer = 0;
let planPageBackgroundRequest = 0;
let planAgentStatusGeneration = 0;
let cachedKnowledgeScrollY = 0;
let planListDialogContentRequest: Promise<void> | null = null;

const routeSummary = computed(() => store.routeSummaryForKey(String(route.params.id || "")) || store.selectedRouteSummary);
const roleId = computed(() => String(store.selectedGateway?.agentRoleId || routeSummary.value?.agentRoleId || "").trim());
const gatewayId = computed(() => String(store.selectedGateway?.id || routeSummary.value?.id || "").trim());
const dateFormatter = computed(() => new Intl.DateTimeFormat(isEnglish.value ? "en" : "zh-CN", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
}));

const planCounts = computed(() => planPageCounts.value);
const normalizedQuery = computed(() => normalizeKnowledgeQuery(query.value));
const planRequestView = computed<RolePlanPageFilter["view"]>(() =>
  activeView.value === "plans" || activeView.value === "archived"
    ? activeView.value
    : undefined
);

function currentPlanPageFilter(): RolePlanPageFilter {
  const statuses = planListHiddenStatuses.value.length
    ? planListStatusOptions.value
      .filter((option) => !planListHiddenStatuses.value.includes(option.status))
      .map((option) => option.status)
    : undefined;
  return {
    view: planRequestView.value,
    query: normalizedQuery.value,
    sort: planListSortMode.value,
    statuses,
    tags: planListSelectedTags.value.length ? [...planListSelectedTags.value] : undefined
  };
}

function matchesQuery(item: RolePlan | RoleMemory): boolean {
  return knowledgeItemMatchesQuery(item, normalizedQuery.value);
}

const activePlans = computed(() => plansForKnowledgeView(plans.value, "plans"));
const archivedPlans = computed(() => plansForKnowledgeView(plans.value, "archived"));
const visiblePlansForView = computed(() => {
  const source = activeView.value === "plans"
    ? activePlans.value
    : activeView.value === "archived"
      ? archivedPlans.value
      : [];
  return source.filter(matchesQuery);
});
const renderedPlansForView = computed(() => knowledgeRenderWindow(
  visiblePlansForView.value,
  planRenderStart.value,
  planRenderLimit.value
));
const visibleRecentMemory = computed(() => recentMemory.value.filter(matchesQuery));
const visibleConsolidatedMemory = computed(() => consolidatedMemory.value.filter(matchesQuery));
const visibleArchivedMemory = computed(() => archivedMemory.value.filter(matchesQuery));
const visibleMemoryForView = computed(() => activeView.value === "consolidated_memory"
  ? visibleConsolidatedMemory.value
  : activeView.value === "archived"
    ? visibleArchivedMemory.value
    : visibleRecentMemory.value);
const renderedMemoryForView = computed(() => visibleMemoryForView.value.slice(0, memoryRenderLimit.value));
const hasMorePlans = computed(() => Boolean(planNextCursor.value));
const hasMoreRenderedPlans = computed(() => hasMoreKnowledgeAfterWindow(
  visiblePlansForView.value.length,
  planRenderStart.value,
  planRenderLimit.value
));
const hasMoreRenderedPlansBefore = computed(() => hasMoreKnowledgeBeforeWindow(planRenderStart.value));
const hasMoreMemory = computed(() => Boolean(memoryNextCursor.value));
const hasMoreRenderedMemory = computed(() => renderedMemoryForView.value.length < visibleMemoryForView.value.length);
const showsPlanList = computed(() => ["plans", "archived"].includes(activeView.value));
const showsMemoryList = computed(() => ["recent_memory", "consolidated_memory", "archived"].includes(activeView.value));
const totalMemoryForView = computed(() => activeView.value === "consolidated_memory"
  ? memoryPageCounts.value.consolidated
  : activeView.value === "archived"
    ? memoryPageCounts.value.archived
    : memoryPageCounts.value.recent);
const knowledgeListLoading = computed(() => loading.value || memoryLoading.value);
const knowledgeListStatus = computed(() => {
  const counts: string[] = [];
  if (showsPlanList.value) counts.push(isEnglish.value
    ? `${visiblePlansForView.value.length} / ${planListResultTotal.value} plans`
    : `计划 ${visiblePlansForView.value.length} / ${planListResultTotal.value}`);
  if (showsMemoryList.value) counts.push(isEnglish.value
    ? `${visibleMemoryForView.value.length} / ${totalMemoryForView.value} memories`
    : `记忆 ${visibleMemoryForView.value.length} / ${totalMemoryForView.value}`);
  const prefix = knowledgeListLoading.value
    ? (isEnglish.value ? "Loading the first visible items" : "正在加载首屏内容")
    : loadingMorePlans.value
      ? (isEnglish.value ? "The visible list is ready; loading more titles in background" : "当前列表已可用，正在后台补齐更多标题")
      : (isEnglish.value ? "List data loaded" : "列表数据已加载");
  const detailHint = showsPlanList.value
    ? (isEnglish.value
      ? "Plan bodies and attachments load near the reading position."
      : "计划正文和附件按阅读位置加载。")
    : (isEnglish.value
      ? "Memory cards render in bounded batches while scrolling."
      : "记忆卡片随滚动分批显示。");
  return `${prefix}: ${counts.join(", ")}. ${detailHint}`;
});

function knowledgePageWorkAllowed(): boolean {
  return typeof document === "undefined"
    || knowledgePageShouldWork(document.visibilityState, planDirectoryMounted);
}

function planReadingAnchorTop(): number {
  if (typeof window === "undefined") return 0;
  if (window.matchMedia?.("(max-width: 960px)").matches) return 16;
  const toolbarBottom = knowledgeToolbar.value?.getBoundingClientRect().bottom || 140;
  return Math.max(80, Math.min(toolbarBottom + 12, window.innerHeight * 0.45));
}

function syncActiveDirectoryPlan(): void {
  planDirectorySyncFrame = 0;
  if (directoryJumpTargetId) return;
  const rects = renderedPlansForView.value.flatMap((plan) => {
    const element = document.getElementById(planCardDomId(plan.id));
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return [{ id: plan.id, top: rect.top, bottom: rect.bottom }];
  });
  const nextPlanId = activePlanIdAtAnchor(rects, planReadingAnchorTop(), activeDirectoryPlanId.value);
  if (nextPlanId && nextPlanId !== activeDirectoryPlanId.value) activeDirectoryPlanId.value = nextPlanId;
}

function scheduleActiveDirectoryPlanSync(): void {
  if (directoryJumpTargetId || planDirectorySyncFrame || typeof window === "undefined") return;
  planDirectorySyncFrame = window.requestAnimationFrame(syncActiveDirectoryPlan);
}

function releaseDirectoryJumpTarget(syncCurrentPlan = true, refreshSentinel = true): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("scroll", waitForDirectoryJumpSettle);
    if (directoryJumpSettleTimer) window.clearTimeout(directoryJumpSettleTimer);
  }
  directoryJumpSettleTimer = 0;
  directoryJumpTargetId = "";
  knowledgeScrollDirection = "";
  if (syncCurrentPlan) scheduleActiveDirectoryPlanSync();
  if (refreshSentinel) scheduleProgressiveSentinelRefresh();
}

function waitForDirectoryJumpSettle(): void {
  if (!directoryJumpTargetId) return;
  if (directoryJumpSettleTimer) window.clearTimeout(directoryJumpSettleTimer);
  directoryJumpSettleTimer = window.setTimeout(releaseDirectoryJumpTarget, 120);
}

function holdDirectoryJumpTarget(planId: string, smooth: boolean): void {
  releaseDirectoryJumpTarget(false, false);
  directoryJumpTargetId = planId;
  if (smooth) window.addEventListener("scroll", waitForDirectoryJumpSettle, { passive: true });
  directoryJumpSettleTimer = window.setTimeout(releaseDirectoryJumpTarget, smooth ? 240 : 0);
}

function enablePlanScrollFallback(enabled: boolean): void {
  if (usesPlanScrollFallback === enabled || typeof window === "undefined") return;
  usesPlanScrollFallback = enabled;
  if (enabled) window.addEventListener("scroll", scheduleActiveDirectoryPlanSync, { passive: true });
  else window.removeEventListener("scroll", scheduleActiveDirectoryPlanSync);
}

function rebuildPlanCardObserver(): void {
  planObserverRefreshFrame = 0;
  planCardObserver?.disconnect();
  planCardObserver = null;
  enablePlanScrollFallback(false);
  if (!planDirectoryMounted || !visiblePlansForView.value.length) return;

  const cardElements = visiblePlansForView.value.flatMap((plan) => {
    const element = document.getElementById(planCardDomId(plan.id));
    return element ? [element] : [];
  });
  if (!cardElements.length) return;

  if (typeof IntersectionObserver === "undefined") {
    enablePlanScrollFallback(true);
    scheduleActiveDirectoryPlanSync();
    return;
  }

  const anchorTop = planReadingAnchorTop();
  const bandHeight = Math.max(72, Math.min(160, window.innerHeight - anchorTop));
  const bottomMargin = Math.max(0, window.innerHeight - anchorTop - bandHeight);
  planCardObserver = new IntersectionObserver(scheduleActiveDirectoryPlanSync, {
    rootMargin: `-${Math.round(anchorTop)}px 0px -${Math.round(bottomMargin)}px 0px`,
    threshold: [0, 0.01]
  });
  for (const element of cardElements) planCardObserver.observe(element);
  scheduleActiveDirectoryPlanSync();
}

function schedulePlanCardObserverRefresh(): void {
  if (planObserverRefreshFrame || typeof window === "undefined") return;
  planObserverRefreshFrame = window.requestAnimationFrame(rebuildPlanCardObserver);
}

function keepActiveDirectoryLinkVisible(): void {
  const list = planDirectoryList.value;
  if (!list || !activeDirectoryPlanId.value) return;
  const link = Array.from(list.querySelectorAll<HTMLElement>("[data-plan-directory-id]"))
    .find((item) => item.dataset.planDirectoryId === activeDirectoryPlanId.value);
  if (!link) return;
  const viewport = list.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  const nextScrollTop = directoryScrollTopForItem({
    scrollTop: list.scrollTop,
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    itemTop: item.top,
    itemBottom: item.bottom,
    padding: 6
  });
  if (nextScrollTop !== null) list.scrollTop = nextScrollTop;
}

function handleKnowledgeWindowScroll(): void {
  const nextScrollY = Math.max(0, window.scrollY);
  if (directoryJumpTargetId) {
    lastKnowledgeScrollY = nextScrollY;
    knowledgeScrollDirection = "";
    return;
  }
  if (nextScrollY < lastKnowledgeScrollY - 1) knowledgeScrollDirection = "up";
  else if (nextScrollY > lastKnowledgeScrollY + 1) knowledgeScrollDirection = "down";
  lastKnowledgeScrollY = nextScrollY;
}

function setPlanDirectoryMarquee(event: Event, active: boolean): void {
  const link = event.currentTarget as HTMLElement | null;
  const title = link?.querySelector<HTMLElement>(".knowledge-plan-directory-title");
  if (!title) return;
  if (!active && link?.matches(":hover, :focus")) return;
  title.dataset.marquee = "";
  title.style.removeProperty("--directory-marquee-distance");
  title.style.removeProperty("--directory-marquee-duration");
  if (!active) return;
  const distance = Math.ceil(title.scrollWidth - title.clientWidth);
  if (distance <= 1) return;
  title.style.setProperty("--directory-marquee-distance", `-${distance}px`);
  title.style.setProperty("--directory-marquee-duration", `${distance / (26 * 0.76)}s`);
  title.dataset.marquee = "active";
}

watch(
  () => visiblePlansForView.value.map((plan) => plan.id).join("\u001f"),
  () => {
    if (!visiblePlansForView.value.some((plan) => plan.id === activeDirectoryPlanId.value)) {
      activeDirectoryPlanId.value = visiblePlansForView.value[0]?.id || "";
    }
    void nextTick(schedulePlanCardObserverRefresh);
    schedulePlanDetailObserverRefresh();
  },
  { immediate: true }
);

watch(
  () => planListStatusOptions.value.map((option) => option.status).join("\u001f"),
  () => {
    const available = new Set(planListStatusOptions.value.map((option) => option.status));
    planListHiddenStatuses.value = planListHiddenStatuses.value.filter((status) => available.has(status));
    planListDraftHiddenStatuses.value = planListDraftHiddenStatuses.value.filter((status) => available.has(status));
  }
);

watch(
  () => planListTagOptions.value.map((option) => option.tag).join("\u001f"),
  () => {
    const available = new Set(planListTagOptions.value.map((option) => option.tag));
    planListSelectedTags.value = planListSelectedTags.value.filter((tag) => available.has(tag));
    planListDraftSelectedTags.value = planListDraftSelectedTags.value.filter((tag) => available.has(tag));
  }
);

watch(activeView, () => {
  planListHiddenStatuses.value = [];
  planListSelectedTags.value = [];
  planListDialogOpen.value = false;
});

watch([activeView, query, planListSortMode, () => planListHiddenStatuses.value.join("\u001f"), () => planListSelectedTags.value.join("\u001f")], () => {
  planRenderStart.value = 0;
  planRenderLimit.value = 8;
  memoryRenderLimit.value = 24;
  schedulePlanDetailObserverRefresh();
  scheduleProgressiveSentinelRefresh();
});

watch(activeDirectoryPlanId, () => void nextTick(keepActiveDirectoryLinkVisible), { flush: "post" });

function resetPlanPageCounts(): void {
  planPageCounts.value = {
    total: 0,
    current: 0,
    plans: 0,
    archived: 0,
    blocked: 0,
    qa: 0,
    active: 0,
    stages: {
      analyzing: 0,
      executing: 0,
      discussion: 0,
      qa: 0,
      waitingPackage: 0,
      approval: 0,
      paused: 0,
      completed: 0,
      archived: 0
    }
  };
}

function resetPlanDetailHydration(): void {
  planDetailObserver?.disconnect();
  planDetailObserver = null;
  planDetailQueue = [];
  queuedPlanDetailIds.clear();
  for (const key of Object.keys(planDetailsLoaded)) delete planDetailsLoaded[key];
  for (const key of Object.keys(planDetailsLoading)) delete planDetailsLoading[key];
  for (const key of Object.keys(planFullDetailsLoaded)) delete planFullDetailsLoaded[key];
  for (const key of Object.keys(planFullDetailsLoading)) delete planFullDetailsLoading[key];
  for (const key of Object.keys(planWorkHistoryExpanded)) delete planWorkHistoryExpanded[key];
  for (const key of Object.keys(planHistoryRecords)) delete planHistoryRecords[key];
  for (const key of Object.keys(planHistoryLoading)) delete planHistoryLoading[key];
}

function resetPlanAgentStatusState(): void {
  planAgentStatusGeneration += 1;
  pendingPlanAgentStatusIds.clear();
  for (const key of Object.keys(planAgentStatuses)) delete planAgentStatuses[key];
  for (const key of Object.keys(planAgentStatusLoading)) delete planAgentStatusLoading[key];
  for (const key of Object.keys(planAgentOpenPending)) delete planAgentOpenPending[key];
  for (const key of Object.keys(planAgentNotices)) delete planAgentNotices[key];
}

function planAgentBinding(plan: RolePlan, role: PlanAgentRole): RolePlan["taskBinding"] | RolePlan["secretaryBinding"] | undefined {
  return role === "secretary" ? plan.secretaryBinding : plan.taskBinding;
}

function fallbackPlanAgentBindingStatus(
  plan: RolePlan,
  role: PlanAgentRole,
  message = ""
): PlanAgentBindingStatus {
  const binding = planAgentBinding(plan, role);
  return {
    role,
    configured: Boolean(binding?.sessionId),
    agentType: binding?.agentType === "dsh" ? "dsh" : "codex",
    threadId: String(binding?.sessionId || ""),
    threadTitle: String(binding?.sessionTitle || ""),
    workspace: String(binding?.workspace || ""),
    working: false,
    agentStatus: "unknown",
    sessionStatus: binding?.sessionId ? "unknown" : "unbound",
    canOpen: false,
    checkedAt: new Date().toISOString(),
    ...(message ? { message } : {})
  };
}

function unknownPlanAgentStatus(plan: RolePlan, message: string): PlanAgentStatus {
  const checkedAt = new Date().toISOString();
  const taskAgent = { ...fallbackPlanAgentBindingStatus(plan, "task", message), checkedAt };
  const secretaryAgent = plan.secretaryBinding
    ? { ...fallbackPlanAgentBindingStatus(plan, "secretary", message), checkedAt }
    : undefined;
  return {
    planId: plan.id,
    checkedAt,
    taskAgent,
    ...(secretaryAgent ? { secretaryAgent } : {})
  };
}

async function refreshPlanAgentStatuses(planIds: string[], force = false): Promise<void> {
  const selectedRoleId = roleId.value;
  const request = requestVersion;
  const generation = planAgentStatusGeneration;
  if (!selectedRoleId || !knowledgePageWorkAllowed()) return;
  const ids = [...new Set(planIds)]
    .filter((planId) => plans.value.some((plan) => plan.id === planId))
    .filter((planId) => !pendingPlanAgentStatusIds.has(planId))
    .filter((planId) => force || !planAgentStatuses[planId]);
  if (!ids.length) return;
  for (const planId of ids) {
    pendingPlanAgentStatusIds.add(planId);
    planAgentStatusLoading[planId] = true;
  }
  try {
    const batch = await loadPlanAgentStatuses(selectedRoleId, ids, 3_000);
    if (request !== requestVersion || generation !== planAgentStatusGeneration || selectedRoleId !== roleId.value) return;
    for (const status of batch.items) planAgentStatuses[status.planId] = status;
    for (const planId of [...batch.failedPlanIds, ...batch.missingPlanIds]) {
      const plan = plans.value.find((item) => item.id === planId);
      if (plan) planAgentStatuses[planId] = unknownPlanAgentStatus(plan, isEnglish.value
        ? "The Agent status could not be confirmed within 3 seconds."
        : "未能在 3 秒内确认 Agent 状态。"
      );
    }
  } catch (statusError) {
    if (request !== requestVersion || generation !== planAgentStatusGeneration || selectedRoleId !== roleId.value) return;
    const message = userFacingError(statusError);
    for (const planId of ids) {
      const plan = plans.value.find((item) => item.id === planId);
      if (plan) planAgentStatuses[planId] = unknownPlanAgentStatus(plan, message);
    }
  } finally {
    if (generation === planAgentStatusGeneration) {
      for (const planId of ids) {
        pendingPlanAgentStatusIds.delete(planId);
        planAgentStatusLoading[planId] = false;
      }
    }
  }
}

function refreshExpandedPlanAgentStatuses(): void {
  const ids = plans.value
    .filter((plan) => expandedPlans[plan.id])
    .map((plan) => plan.id);
  if (ids.length) void refreshPlanAgentStatuses(ids);
}

function planAgentStatusFor(plan: RolePlan): PlanAgentStatus {
  return planAgentStatuses[plan.id] || unknownPlanAgentStatus(plan, "");
}

function planAgentBindingStatus(plan: RolePlan, role: PlanAgentRole): PlanAgentBindingStatus | undefined {
  const status = planAgentStatusFor(plan);
  return role === "secretary" ? status.secretaryAgent : status.taskAgent;
}

function planTaskAgentWorking(plan: RolePlan): boolean {
  return planAgentStatuses[plan.id]?.taskAgent.working === true;
}

function planAgentStatusIsFresh(planId: string): boolean {
  const checkedAt = Date.parse(planAgentStatuses[planId]?.checkedAt || "");
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < 5_000;
}

function planAgentOpenKey(planId: string, role: PlanAgentRole): string {
  return `${planId}:${role}`;
}

function planAgentRoleLabel(role: PlanAgentRole): string {
  if (isEnglish.value) return role === "secretary" ? "Plan Secretary" : "Task Agent";
  return role === "secretary" ? "协助秘书" : "任务 Agent";
}

function planAgentWorkLabel(status: PlanAgentBindingStatus | undefined): string {
  if (!status || status.agentStatus === "unknown") return isEnglish.value ? "Unknown" : "未知";
  if (status.agentStatus === "working") return isEnglish.value ? "Working" : "工作中";
  return isEnglish.value ? "Not working" : "未工作";
}

function planAgentSessionLabel(status: PlanAgentSessionStatus | undefined): string {
  const labels: Record<PlanAgentSessionStatus, [string, string]> = {
    active: ["会话任务正在运行", "Task is running"],
    idle: ["会话任务空闲", "Task is idle"],
    not_loaded: ["会话任务未载入", "Task is not loaded"],
    unavailable: ["Agent 未就绪", "Agent is unavailable"],
    archived: ["会话已归档", "Session is archived"],
    missing: ["会话不存在", "Session is missing"],
    workspace_mismatch: ["会话工作目录不一致", "Session workspace does not match"],
    unbound: ["未关联会话", "No session is linked"],
    unknown: ["会话状态未知", "Session status is unknown"]
  };
  const label = labels[status || "unknown"];
  return label[isEnglish.value ? 1 : 0];
}

function planAgentStatusTone(status: PlanAgentBindingStatus | undefined): string {
  if (status?.sessionStatus === "missing" || status?.sessionStatus === "workspace_mismatch") return "danger";
  if (status?.working) return "working";
  if (status?.agentStatus === "idle") return "idle";
  return "unknown";
}

function planAgentRoles(plan: RolePlan): PlanAgentRole[] {
  const status = planAgentStatuses[plan.id];
  return status?.secretaryAgent || plan.secretaryBinding ? ["task", "secretary"] : ["task"];
}

function planAgentTitle(plan: RolePlan, role: PlanAgentRole): string {
  const status = planAgentBindingStatus(plan, role);
  return status?.threadTitle || status?.threadId || (isEnglish.value ? "Not linked" : "未关联任务");
}

function planAgentShouldRetry(plan: RolePlan): boolean {
  return planAgentRoles(plan).some((role) => {
    const status = planAgentBindingStatus(plan, role);
    return status?.sessionStatus === "unknown" || status?.sessionStatus === "unavailable";
  });
}

async function openPlanAgent(plan: RolePlan, role: PlanAgentRole): Promise<void> {
  const status = planAgentBindingStatus(plan, role);
  if (!status?.canOpen || status.working) return;
  const key = planAgentOpenKey(plan.id, role);
  planAgentOpenPending[key] = true;
  delete planAgentNotices[key];
  try {
    const opened = await openPlanAgentTask(roleId.value, plan.id, role);
    const agentName = opened.agentType === "dsh" ? "DSH" : "Codex";
    planAgentNotices[key] = {
      tone: "success",
      text: isEnglish.value ? `Opened the bound session in ${agentName}.` : `已在 ${agentName} 中定位绑定会话。`
    };
  } catch (openError) {
    planAgentNotices[key] = {
      tone: "error",
      text: userFacingError(openError)
    };
    void refreshPlanAgentStatuses([plan.id], true);
  } finally {
    planAgentOpenPending[key] = false;
  }
}

function drainPlanDetailQueue(): void {
  if (!knowledgePageWorkAllowed()) return;
  while (activePlanDetailRequests < MAX_CONCURRENT_PLAN_DETAILS && planDetailQueue.length) {
    const task = planDetailQueue.shift()!;
    queuedPlanDetailIds.delete(task.planId);
    if (
      task.request !== requestVersion
      || planDetailsLoaded[task.planId]
      || planDetailsLoading[task.planId]
      || planFullDetailsLoaded[task.planId]
      || planFullDetailsLoading[task.planId]
    ) continue;
    activePlanDetailRequests += 1;
    planDetailsLoading[task.planId] = true;
    void loadRolePlanPreview(roleId.value, task.planId)
      .then((plan) => {
        if (
          task.request !== requestVersion
          || !plans.value.some((item) => item.id === task.planId)
          || planFullDetailsLoaded[task.planId]
        ) return;
        plans.value = mergeKnowledgePage(plans.value, [plan]);
        planDetailsLoaded[task.planId] = true;
        applyFeedbackDeliveryState(plan.id, plan.approval.latest);
        void refreshPlanMarkdownTeasers([plan], task.request);
      })
      .catch((loadError) => {
        if (task.request === requestVersion) {
          planError.value = userFacingError(loadError);
        }
      })
      .finally(() => {
        if (task.request === requestVersion) planDetailsLoading[task.planId] = false;
        activePlanDetailRequests = Math.max(0, activePlanDetailRequests - 1);
        drainPlanDetailQueue();
      });
  }
}

function queuePlanDetails(nextPlans: RolePlan[], request: number, priority = false): void {
  const priorityTasks: Array<{ planId: string; request: number }> = [];
  for (const plan of nextPlans) {
    if (
      planDetailsLoaded[plan.id]
      || planDetailsLoading[plan.id]
      || planFullDetailsLoaded[plan.id]
      || planFullDetailsLoading[plan.id]
    ) continue;
    const existingIndex = planDetailQueue.findIndex((task) => task.planId === plan.id);
    if (existingIndex >= 0) {
      if (priority) priorityTasks.push(...planDetailQueue.splice(existingIndex, 1));
      continue;
    }
    if (queuedPlanDetailIds.has(plan.id)) continue;
    queuedPlanDetailIds.add(plan.id);
    const task = { planId: plan.id, request };
    if (priority) priorityTasks.push(task);
    else planDetailQueue.push(task);
  }
  if (priorityTasks.length) planDetailQueue = [...priorityTasks, ...planDetailQueue];
  window.setTimeout(drainPlanDetailQueue, 0);
}

function rebuildPlanDetailObserver(): void {
  planDetailObserver?.disconnect();
  planDetailObserver = null;
  const pendingPlans = renderedPlansForView.value.filter((plan) => !planDetailsLoaded[plan.id]);
  if (!pendingPlans.length) return;
  if (typeof IntersectionObserver === "undefined") {
    queuePlanDetails(pendingPlans.slice(0, 2), requestVersion);
    return;
  }
  planDetailObserver = new IntersectionObserver((entries) => {
    const visibleIds = new Set(entries.filter((entry) => entry.isIntersecting)
      .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      .slice(0, 10)
      .map((entry) => (entry.target as HTMLElement).dataset.planId || "")
      .filter(Boolean));
    queuePlanDetails(pendingPlans.filter((plan) => visibleIds.has(plan.id)), requestVersion, true);
  }, { rootMargin: "160px 0px" });
  for (const plan of pendingPlans) {
    const element = document.getElementById(planCardDomId(plan.id));
    if (element) planDetailObserver.observe(element);
  }
}

function schedulePlanDetailObserverRefresh(): void {
  void nextTick(rebuildPlanDetailObserver);
}

function applyPlanSnapshots(nextPlans: RolePlan[], replace: boolean, request: number): void {
  const unresolvedPlans = replace ? nextPlans : nextPlans.filter((plan) => !planDetailsLoaded[plan.id]);
  plans.value = replace ? unresolvedPlans : mergeKnowledgePage(plans.value, unresolvedPlans);
  if (replace) resetPlanMarkdownTeasers();
  for (const plan of unresolvedPlans) planDetailsLoaded[plan.id] = false;
  if (normalizedQuery.value) queuePlanDetails(unresolvedPlans, request);
  else schedulePlanDetailObserverRefresh();
}

function observeProgressiveSentinels(): void {
  planPageObserver?.disconnect();
  memoryPageObserver?.disconnect();
  if (typeof IntersectionObserver === "undefined" || !knowledgePageWorkAllowed()) return;
  const observesPreviousPlans = Boolean(planLoadPreviousSentinel.value && hasMoreRenderedPlansBefore.value);
  const observesNextPlans = Boolean(planLoadMoreSentinel.value && (hasMorePlans.value || hasMoreRenderedPlans.value));
  if (observesPreviousPlans || observesNextPlans) {
    planPageObserver = new IntersectionObserver((entries) => {
      const previousPlansIntersect = entries.some((entry) => (
        entry.target === planLoadPreviousSentinel.value && entry.isIntersecting
      ));
      if (previousPlansIntersect && knowledgeScrollDirection === "up" && !directoryJumpTargetId) {
        loadPreviousRenderedPlans();
      }
      const nextPlansIntersect = entries.some((entry) => (
        entry.target === planLoadMoreSentinel.value && entry.isIntersecting
      ));
      if (!shouldAutoLoadNextKnowledgeBatch(
        nextPlansIntersect,
        Boolean(directoryJumpTargetId)
      )) return;
      if (hasMoreRenderedPlans.value) loadMoreRenderedPlans();
      if (hasMorePlans.value && !planPageBackgroundRequest) void loadMorePlans();
    }, { rootMargin: "700px 0px" });
    if (observesPreviousPlans && planLoadPreviousSentinel.value) {
      planPageObserver.observe(planLoadPreviousSentinel.value);
    }
    if (observesNextPlans && planLoadMoreSentinel.value) {
      planPageObserver.observe(planLoadMoreSentinel.value);
    }
  }
  if (memoryLoadMoreSentinel.value && (hasMoreMemory.value || hasMoreRenderedMemory.value)) {
    memoryPageObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (hasMoreRenderedMemory.value) loadMoreRenderedMemory();
      if (hasMoreMemory.value) void loadMoreMemory();
    }, { rootMargin: "700px 0px" });
    memoryPageObserver.observe(memoryLoadMoreSentinel.value);
  }
}

function scheduleProgressiveSentinelRefresh(): void {
  void nextTick(observeProgressiveSentinels);
}

function currentMemoryKind(): RoleMemoryKind {
  if (activeView.value === "consolidated_memory") return "consolidated";
  if (activeView.value === "archived") return "archived";
  return "recent";
}

function resetMemoryPageCounts(): void {
  memoryPageCounts.value = { recent: 0, consolidated: 0, archived: 0, consolidationRuns: 0 };
  pendingMemoryConsolidationRuns.value = 0;
}

async function loadMoreMemory(limit = 24): Promise<void> {
  const selectedRoleId = roleId.value;
  const cursor = memoryNextCursor.value;
  const currentRequest = requestVersion;
  if (!selectedRoleId || !cursor || memoryLoading.value || !showsMemoryList.value || !knowledgePageWorkAllowed()) return;
  memoryLoading.value = true;
  try {
    const kind = currentMemoryKind();
    const page = await loadRoleMemoryPage(selectedRoleId, kind, cursor, limit, normalizedQuery.value);
    if (currentRequest !== requestVersion || selectedRoleId !== roleId.value || kind !== currentMemoryKind()) return;
    if (kind === "recent") recentMemory.value = mergeKnowledgePage(recentMemory.value, page.items);
    else if (kind === "consolidated") consolidatedMemory.value = mergeKnowledgePage(consolidatedMemory.value, page.items);
    else archivedMemory.value = mergeKnowledgePage(archivedMemory.value, page.items);
    memoryNextCursor.value = page.nextCursor;
    memoryPageCounts.value = page.counts;
  } catch (loadError) {
    if (currentRequest === requestVersion) memoryError.value = userFacingError(loadError);
  } finally {
    if (currentRequest === requestVersion) memoryLoading.value = false;
    scheduleProgressiveSentinelRefresh();
  }
}

function loadPreviousRenderedPlans(): void {
  if (!hasMoreRenderedPlansBefore.value) return;
  const anchorPlanId = renderedPlansForView.value[0]?.id || "";
  const anchor = anchorPlanId ? document.getElementById(planCardDomId(anchorPlanId)) : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const previousWindow = previousKnowledgeRenderWindow(planRenderStart.value, planRenderLimit.value, 8);
  planRenderStart.value = previousWindow.start;
  planRenderLimit.value = previousWindow.count;
  knowledgeScrollDirection = "";
  void nextTick(() => {
    if (anchor && anchorTop !== undefined) {
      const nextAnchorTop = anchor.getBoundingClientRect().top;
      window.scrollBy({ top: nextAnchorTop - anchorTop, behavior: "auto" });
    }
    schedulePlanCardObserverRefresh();
    schedulePlanDetailObserverRefresh();
    scheduleProgressiveSentinelRefresh();
  });
}

function loadMoreRenderedPlans(): void {
  const remainingPlans = Math.max(0, visiblePlansForView.value.length - planRenderStart.value);
  planRenderLimit.value = nextKnowledgeRenderLimit(
    planRenderLimit.value,
    remainingPlans,
    8
  );
  schedulePlanCardObserverRefresh();
  schedulePlanDetailObserverRefresh();
}

async function loadMorePlans(limit = 8, fromBackground = false): Promise<void> {
  const selectedRoleId = roleId.value;
  const cursor = planNextCursor.value;
  const currentRequest = requestVersion;
  if (
    !selectedRoleId
    || !cursor
    || loadingMorePlans.value
    || (!fromBackground && planPageBackgroundRequest === currentRequest)
    || !knowledgePageWorkAllowed()
  ) return;
  loadingMorePlans.value = true;
  try {
    const page = await loadRolePlanPage(selectedRoleId, cursor, limit, {
      ...currentPlanPageFilter(),
      includeFacets: false
    });
    if (currentRequest !== requestVersion || selectedRoleId !== roleId.value) return;
    applyPlanSnapshots(page.items, false, currentRequest);
    planPageCounts.value = page.counts;
    planListResultTotal.value = page.total;
    planNextCursor.value = page.nextCursor;
  } catch (loadError) {
    if (currentRequest === requestVersion) {
      planError.value = userFacingError(loadError);
    }
  } finally {
    if (currentRequest === requestVersion) loadingMorePlans.value = false;
    scheduleProgressiveSentinelRefresh();
  }
}

function loadMoreRenderedMemory(): void {
  memoryRenderLimit.value = nextKnowledgeRenderLimit(
    memoryRenderLimit.value,
    visibleMemoryForView.value.length,
    24
  );
}

async function yieldToKnowledgePaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

// 计划目录必须在页面可工作时自动读到 nextCursor 为空；缺失或提前停止属于功能缺陷。
// 滚动只控制已缓存计划卡片的挂载窗口，不能决定目录数据是否继续加载。
function loadAllRemainingPlans(selectedRoleId: string, currentRequest: number): void {
  if (!planNextCursor.value || planPageBackgroundRequest === currentRequest) return;
  planPageBackgroundRequest = currentRequest;
  void drainKnowledgePages({
    nextCursor: () => (
      currentRequest === requestVersion
      && selectedRoleId === roleId.value
      && showsPlanList.value
      && knowledgePageWorkAllowed()
        ? planNextCursor.value
        : ""
    ),
    shouldContinue: () => (
      currentRequest === requestVersion
      && selectedRoleId === roleId.value
      && showsPlanList.value
      && knowledgePageWorkAllowed()
    ),
    yieldToUi: yieldToKnowledgePaint,
    loadNextPage: () => loadMorePlans(8, true)
  }).finally(() => {
    if (planPageBackgroundRequest === currentRequest) planPageBackgroundRequest = 0;
  });
}

async function refreshPlanKnowledge(selectedRoleId: string, currentRequest: number): Promise<void> {
  if (!showsPlanList.value) {
    plans.value = [];
    planListResultTotal.value = 0;
    planListStatusOptions.value = [];
    planListTagOptions.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await loadRolePlanPage(selectedRoleId, "", 8, currentPlanPageFilter());
    if (currentRequest !== requestVersion || selectedRoleId !== roleId.value) return;
    applyPlanSnapshots(result.items, true, currentRequest);
    planPageCounts.value = result.counts;
    planListResultTotal.value = result.total;
    planListStatusOptions.value = result.facets?.statuses || [];
    planListTagOptions.value = result.facets?.tags || [];
    planNextCursor.value = result.nextCursor;
  } catch (loadError) {
    if (currentRequest === requestVersion) planError.value = userFacingError(loadError);
  } finally {
    if (currentRequest === requestVersion) loading.value = false;
    scheduleProgressiveSentinelRefresh();
  }
  if (currentRequest !== requestVersion || selectedRoleId !== roleId.value) return;
  refreshExpandedPlanAgentStatuses();
  loadAllRemainingPlans(selectedRoleId, currentRequest);
}

async function refreshMemoryKnowledge(selectedRoleId: string, currentRequest: number): Promise<void> {
  if (!showsMemoryList.value) {
    recentMemory.value = [];
    consolidatedMemory.value = [];
    archivedMemory.value = [];
    memoryLoading.value = false;
    return;
  }
  memoryLoading.value = true;
  try {
    const kind = currentMemoryKind();
    const memory = await loadRoleMemoryPage(selectedRoleId, kind, "", 24, normalizedQuery.value);
    if (currentRequest !== requestVersion || selectedRoleId !== roleId.value || kind !== currentMemoryKind()) return;
    if (kind === "recent") {
      recentMemory.value = memory.items;
      consolidatedMemory.value = [];
      archivedMemory.value = [];
    } else if (kind === "consolidated") {
      consolidatedMemory.value = memory.items;
      recentMemory.value = [];
      archivedMemory.value = [];
    } else {
      archivedMemory.value = memory.items;
      recentMemory.value = [];
      consolidatedMemory.value = [];
    }
    memoryNextCursor.value = memory.nextCursor;
    memoryPageCounts.value = memory.counts;
  } catch (loadError) {
    if (currentRequest === requestVersion) memoryError.value = userFacingError(loadError);
  } finally {
    if (currentRequest === requestVersion) memoryLoading.value = false;
    scheduleProgressiveSentinelRefresh();
  }
}

async function refreshKnowledge(): Promise<void> {
  const selectedRoleId = roleId.value;
  if (!knowledgePageWorkAllowed()) return;
  if (!selectedRoleId) {
    resetPlanMarkdownTeasers();
    resetPlanMediaLoadStates();
    resetPlanDetailHydration();
    resetPlanAgentStatusState();
    plans.value = [];
    recentMemory.value = [];
    consolidatedMemory.value = [];
    archivedMemory.value = [];
    planNextCursor.value = "";
    planListResultTotal.value = 0;
    planListStatusOptions.value = [];
    planListTagOptions.value = [];
    memoryNextCursor.value = "";
    planRenderStart.value = 0;
    resetPlanPageCounts();
    resetMemoryPageCounts();
    planError.value = "";
    memoryError.value = "";
    return;
  }
  const currentRequest = ++requestVersion;
  resetPlanAgentStatusState();
  loadingMorePlans.value = false;
  planError.value = "";
  memoryError.value = "";
  planNextCursor.value = "";
  memoryNextCursor.value = "";
  planRenderStart.value = 0;
  planRenderLimit.value = 8;
  memoryRenderLimit.value = 24;
  resetPlanMediaLoadStates();
  resetPlanDetailHydration();
  void loadRoleKnowledgeFileCounts(selectedRoleId)
    .then((counts) => {
      if (currentRequest !== requestVersion || selectedRoleId !== roleId.value) return;
      planPageCounts.value = {
        ...planPageCounts.value,
        total: counts.activePlans + counts.archivedPlans,
        current: counts.activePlans,
        plans: counts.activePlans,
        archived: counts.archivedPlans
      };
      memoryPageCounts.value = {
        recent: counts.recentMemory,
        consolidated: counts.consolidatedMemory,
        archived: 0,
        consolidationRuns: counts.consolidationRuns
      };
    })
    .catch((loadError) => {
      if (currentRequest === requestVersion && selectedRoleId === roleId.value) {
        planError.value = userFacingError(loadError);
      }
    });
  if (showsPlanList.value) {
    await refreshPlanKnowledge(selectedRoleId, currentRequest);
    return;
  }
  await refreshMemoryKnowledge(selectedRoleId, currentRequest);
  if (activeView.value === "recent_memory") {
    void refreshPendingMemoryConsolidationRuns(selectedRoleId).catch((loadError) => {
      if (currentRequest === requestVersion && selectedRoleId === roleId.value) {
        memoryError.value = userFacingError(loadError);
      }
    });
  }
}

watch([activeView, query], () => {
  requestVersion += 1;
  loading.value = false;
  loadingMorePlans.value = false;
  memoryLoading.value = false;
  planNextCursor.value = "";
  memoryNextCursor.value = "";
  planDetailQueue = [];
  queuedPlanDetailIds.clear();
  schedulePlanDetailObserverRefresh();
  scheduleProgressiveSentinelRefresh();
  if (knowledgeFilterTimer) window.clearTimeout(knowledgeFilterTimer);
  knowledgeFilterTimer = window.setTimeout(() => void refreshKnowledge(), 180);
});

watch([hasMorePlans, hasMoreMemory, hasMoreRenderedPlansBefore, hasMoreRenderedPlans, hasMoreRenderedMemory], () => {
  scheduleProgressiveSentinelRefresh();
});

watch(
  [roleId, () => store.routeBootstrapLoading],
  (current, previous) => {
    const [nextRoleId, managerLoading] = current;
    const previousRoleId = previous?.[0];
    const previousRouteBootstrapLoading = previous?.[1];
    if (previous && nextRoleId !== previousRoleId) {
      planListSortMode.value = "status";
      planListHiddenStatuses.value = [];
      planListSelectedTags.value = [];
      planListDraftSortMode.value = "status";
      planListDraftHiddenStatuses.value = [];
      planListDraftSelectedTags.value = [];
      planListTagQuery.value = "";
      planListDialogOpen.value = false;
      resetApprovalAttachmentState();
      resetMemoryPageCounts();
      closePlanMediaPreview();
      closePlanMarkdownPreview();
      closeMemoryDetail();
    }
    if (!nextRoleId || managerLoading) return;
    if (!previous || nextRoleId !== previousRoleId || previousRouteBootstrapLoading === true) void refreshKnowledge();
  },
  { immediate: true }
);

function stepColor(plan: RolePlan, step: RolePlanStep): string {
  if (stepIsBlocked(plan, step)) return "error";
  if (step.completedAt) return "success";
  if (step.id === plan.currentStepId) return "primary";
  return "grey";
}

function currentStep(plan: RolePlan): RolePlanStep | undefined {
  return plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.currentStepPreview;
}

function planStepCount(plan: RolePlan): number {
  return Number.isFinite(plan.stepCount) ? Number(plan.stepCount) : plan.steps.length;
}

function blocker(plan: RolePlan): string {
  if (plan.presentation.approval.state !== "ready") return "";
  return currentStep(plan)?.blockedBy || plan.blockedBy || "";
}

function stepIsBlocked(plan: RolePlan, step: RolePlanStep): boolean {
  return plan.presentation.approval.state === "ready" && step.id === currentStep(plan)?.id;
}

function completedSteps(plan: RolePlan): number {
  return Number.isFinite(plan.completedStepCount)
    ? Number(plan.completedStepCount)
    : plan.steps.filter((step) => Boolean(step.completedAt)).length;
}

function progressValue(plan: RolePlan): number {
  const total = planStepCount(plan);
  return total ? Math.round(completedSteps(plan) * 100 / total) : 0;
}

function currentStepPosition(plan: RolePlan): number {
  if (Number.isFinite(plan.currentStepPosition)) return Number(plan.currentStepPosition);
  const index = plan.steps.findIndex((step) => step.id === plan.currentStepId);
  return index >= 0 ? index + 1 : 0;
}

function formatDate(value: string | undefined): string {
  if (!value) return t("未记录");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.value.format(date);
}

function formatMemoryRemaining(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return isEnglish.value ? `${minutes} min` : `${minutes} 分钟`;
  if (minutes === 0) return isEnglish.value ? `${hours} hr` : `${hours} 小时`;
  return isEnglish.value ? `${hours} hr ${minutes} min` : `${hours} 小时 ${minutes} 分钟`;
}

const nextMemoryConsolidationTriggerMemory = computed(() => {
  if (activeView.value !== "recent_memory" || normalizedQuery.value || memoryLoading.value || hasMoreMemory.value) return undefined;
  return recentMemory.value.find((memory) => memory.lifecycle?.triggersNextConsolidation === true);
});

const nextMemoryConsolidationTriggerAt = computed(() => {
  const memory = nextMemoryConsolidationTriggerMemory.value;
  return memory ? Date.parse(memory.lifecycle?.consolidationTriggerAt || "") : Number.NaN;
});

const memoryIdsEnteringNextConsolidation = computed(() => {
  const triggerAt = nextMemoryConsolidationTriggerAt.value;
  if (!Number.isFinite(triggerAt)) return new Set<string>();
  const remaining = triggerAt - memoryClock.value;
  if (remaining >= 24 * 60 * 60_000) return new Set<string>();
  return new Set(recentMemory.value
    .filter((memory) => memory.lifecycle?.willEnterNextConsolidation === true)
    .map((memory) => memory.id));
});

const recentMemoryConsolidationNotice = computed(() => {
  const nextTriggerAt = nextMemoryConsolidationTriggerAt.value;
  if (!Number.isFinite(nextTriggerAt)) return "";
  const remaining = nextTriggerAt - memoryClock.value;
  if (remaining <= 0 && pendingMemoryConsolidationRuns.value > 0) return isEnglish.value
    ? "Triggered; consolidation is in progress"
    : "已触发，正在沉淀";
  if (remaining <= 0) return isEnglish.value
    ? "Time until trigger: 0 min (trigger time reached)"
    : "距离触发还剩 0 分钟（已到触发时间）";
  if (remaining >= 24 * 60 * 60_000) return "";
  return isEnglish.value
    ? `Time until trigger: ${formatMemoryRemaining(remaining)}`
    : `距离触发还剩 ${formatMemoryRemaining(remaining)}`;
});

function planDirectorySortValue(plan: RolePlan): string {
  return formatPlanDirectorySortLabel(
    plan,
    planListSortMode.value,
    Date.now(),
    isEnglish.value ? "en" : "zh"
  );
}

function planDirectorySortTitle(plan: RolePlan): string {
  return formatPlanDirectorySortLabelTitle(
    plan,
    planListSortMode.value,
    Date.now(),
    isEnglish.value ? "en" : "zh"
  );
}

function planDirectorySortStyle(plan: RolePlan): Record<string, string> {
  return planStatusStyle(planDirectorySortPalette(plan, planListSortMode.value));
}

function planAttachmentUrl(planId: string, attachmentId: string): string {
  return managerResourceUrl(
    `/api/roles/${encodeURIComponent(roleId.value)}/plans/${encodeURIComponent(planId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
}

function planVideoThumbnailUrl(planId: string, attachmentId: string): string {
  return `${planAttachmentUrl(planId, attachmentId)}#t=0.001`;
}

function planVideoDurationKey(planId: string, attachmentId: string): string {
  return `${roleId.value}:${planId}:${attachmentId}`;
}

function capturePlanVideoDuration(planId: string, attachmentId: string, event: Event): void {
  const video = event.currentTarget as HTMLVideoElement;
  if (!Number.isFinite(video.duration) || video.duration < 0) return;
  planVideoDurations[planVideoDurationKey(planId, attachmentId)] = video.duration;
}

function displayedPlanVideoDuration(planId: string, attachmentId: string): string {
  return formatPlanVideoDuration(planVideoDurations[planVideoDurationKey(planId, attachmentId)]);
}

function planMarkdownTeaserKey(planId: string, attachmentId: string): string {
  return `${planId}\u001f${attachmentId}`;
}

function planMarkdownTeaser(planId: string, attachmentId: string): PlanMarkdownTeaserState {
  return planMarkdownTeasers[planMarkdownTeaserKey(planId, attachmentId)] || { text: "", loading: true };
}

function resetPlanMarkdownTeasers(): void {
  planMarkdownTeaserAbort?.abort();
  planMarkdownTeaserAbort = null;
  for (const key of Object.keys(planMarkdownTeasers)) delete planMarkdownTeasers[key];
}

function responseTextPrefix(response: Response, byteLimit: number): Promise<string> {
  return responseTextByByteLimit(response, byteLimit, true);
}

function responseTextWithinLimit(response: Response, byteLimit: number, overflowMessage: string): Promise<string> {
  return responseTextByByteLimit(response, byteLimit, false, overflowMessage);
}

async function loadPlanMarkdownTeaser(
  plan: RolePlan,
  attachment: PlanAttachmentPresentation,
  request: number,
  signal: AbortSignal
): Promise<void> {
  const key = planMarkdownTeaserKey(plan.id, attachment.id);
  const state = reactive<PlanMarkdownTeaserState>({ text: "", loading: true });
  planMarkdownTeasers[key] = state;
  if (attachment.size > PLAN_MARKDOWN_PREVIEW_MAX_BYTES) {
    state.text = t("Markdown 文件过大，无法在页面内预览，请下载原文件。");
    state.loading = false;
    return;
  }
  try {
    const response = await fetch(planAttachmentUrl(plan.id, attachment.id), {
      headers: { accept: "text/markdown, text/plain;q=0.9" },
      signal
    });
    if (!response.ok) throw new Error(String(response.status));
    const source = await responseTextPrefix(response, PLAN_MARKDOWN_TEASER_READ_BYTES);
    if (signal.aborted || request !== requestVersion || planMarkdownTeasers[key] !== state) return;
    state.text = planMarkdownPreviewExcerpt(source);
  } catch {
    if (signal.aborted || request !== requestVersion || planMarkdownTeasers[key] !== state) return;
  } finally {
    if (planMarkdownTeasers[key] === state) state.loading = false;
  }
}

async function refreshPlanMarkdownTeasers(nextPlans: RolePlan[], request: number, reset = false): Promise<void> {
  if (reset) resetPlanMarkdownTeasers();
  const controller = planMarkdownTeaserAbort || new AbortController();
  planMarkdownTeaserAbort = controller;
  const markdownAttachments = nextPlans.flatMap((plan) => plan.attachments
    .filter((attachment) => attachment.kind === "file" && isPlanMarkdownAttachment(attachment.name, attachment.mimeType))
    .filter((attachment) => !planMarkdownTeasers[planMarkdownTeaserKey(plan.id, attachment.id)])
    .map((attachment) => ({ plan, attachment })));
  await Promise.allSettled(markdownAttachments.map(({ plan, attachment }) => (
    loadPlanMarkdownTeaser(plan, attachment, request, controller.signal)
  )));
}

function planMediaLoadKey(planId: string, attachmentId: string): string {
  return `${planId}\u001f${attachmentId}`;
}

function planMediaLoadState(planId: string, attachmentId: string): PlanMediaLoadState {
  return planMediaLoadStates[planMediaLoadKey(planId, attachmentId)] || "loading";
}

function setPlanMediaLoadState(planId: string, attachmentId: string, state: PlanMediaLoadState): void {
  planMediaLoadStates[planMediaLoadKey(planId, attachmentId)] = state;
}

function resetPlanMediaLoadStates(): void {
  for (const key of Object.keys(planMediaLoadStates)) delete planMediaLoadStates[key];
}

function openPlanMediaPreview(plan: RolePlan, attachment: PlanAttachmentPresentation): void {
  if (attachment.kind !== "image" && attachment.kind !== "video") return;
  planAttachmentPreview.value = {
    name: attachment.name,
    url: planAttachmentUrl(plan.id, attachment.id),
    kind: attachment.kind
  };
}

function closePlanMediaPreview(): void {
  planAttachmentPreview.value = null;
}

async function openPlanMarkdownPreview(plan: RolePlan, attachment: PlanAttachmentPresentation): Promise<void> {
  if (attachment.kind !== "file" || !isPlanMarkdownAttachment(attachment.name, attachment.mimeType)) return;
  planMarkdownPreviewAbort?.abort();
  const controller = new AbortController();
  planMarkdownPreviewAbort = controller;
  const preview = reactive({
    name: attachment.name,
    url: planAttachmentUrl(plan.id, attachment.id),
    html: "",
    error: "",
    loading: true
  });
  planMarkdownPreview.value = preview;
  if (attachment.size > PLAN_MARKDOWN_PREVIEW_MAX_BYTES) {
    preview.error = t("Markdown 文件过大，无法在页面内预览，请下载原文件。");
    preview.loading = false;
    return;
  }
  try {
    const response = await fetch(preview.url, {
      headers: { accept: "text/markdown, text/plain;q=0.9" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${t("Markdown 预览加载失败")} (${response.status})`);
    const source = await responseTextWithinLimit(
      response,
      PLAN_MARKDOWN_PREVIEW_MAX_BYTES,
      t("Markdown 文件过大，无法在页面内预览，请下载原文件。")
    );
    if (controller.signal.aborted || planMarkdownPreview.value !== preview) return;
    preview.html = renderPlanMarkdownPreview(source);
  } catch (previewError) {
    if (controller.signal.aborted || planMarkdownPreview.value !== preview) return;
    preview.error = previewError instanceof Error ? previewError.message : t("Markdown 预览加载失败");
  } finally {
    if (planMarkdownPreview.value === preview) preview.loading = false;
  }
}

function closePlanMarkdownPreview(): void {
  planMarkdownPreviewAbort?.abort();
  planMarkdownPreviewAbort = null;
  planMarkdownPreview.value = null;
}

function feedbackRecordLabel(feedback: RolePlanFeedback): string {
  if (feedback.author === "agent") return isEnglish.value ? "Agent reply" : "Agent 回复";
  if (feedback.author === "system") return isEnglish.value ? "System record" : "系统记录";
  if (feedback.kind === "guidance") return isEnglish.value ? "Your guidance" : "你的引导";
  return isEnglish.value ? "Your approval feedback" : "你的审批意见";
}

function approvalRecordsForDisplay(plan: RolePlan): RolePlanFeedback[] {
  const records = plan.approval.records?.length
    ? plan.approval.records
    : plan.approval.latest
      ? [plan.approval.latest]
      : [];
  return records
    .filter((feedback) => feedback.kind === "approval_suggestion" || feedback.kind === "approval_response")
    .reverse();
}

function guidanceRecordsForDisplay(plan: RolePlan): RolePlanFeedback[] {
  const records = plan.approval.records?.length
    ? plan.approval.records
    : plan.approval.latest
      ? [plan.approval.latest]
      : [];
  return records
    .filter((feedback) => feedback.kind === "guidance" || feedback.kind === "guidance_response")
    .reverse();
}

function planHistoryLabel(record: RolePlanHistoryRecord): string {
  if (record.kind === "created") return t("创建计划");
  if (record.kind === "archived") return t("归档计划");
  return t("更新计划");
}

function planHistoryApprovalSteps(record: RolePlanHistoryRecord): RolePlanStep[] {
  return Array.isArray(record.after.steps)
    ? record.after.steps.filter((step) => Boolean(step.approvalRequest))
    : [];
}

function planApprovalContractsForHistory(plan: RolePlan): RolePlanStep[] {
  return plan.steps.filter((step) => Boolean(step.approvalRequest));
}

function planHistoryCurrentStep(record: RolePlanHistoryRecord): RolePlanStep | undefined {
  return record.after.steps.find((step) => step.id === record.after.currentStepId);
}

function planAcceptsGuidance(plan: RolePlan): boolean {
  return plan.presentation.acceptsGuidance === true && plan.presentation.approval.state === "none";
}

function planStatusLabel(plan: RolePlan): string {
  return planStatusLabelForDisplay(plan.presentation, isEnglish.value ? "en" : "zh");
}

function planStatusDescription(plan: RolePlan): string {
  return planStatusDescriptionForDisplay(plan.presentation, isEnglish.value ? "en" : "zh");
}

function planStatusOptionLabel(option: PlanStatusOption): string {
  return planStatusLabelForDisplay(option, isEnglish.value ? "en" : "zh");
}

function planStatusOptionDescription(option: PlanStatusOption): string {
  return planStatusDescriptionForDisplay(option, isEnglish.value ? "en" : "zh");
}

function planCardDomId(planId: string): string {
  return `plan-card-${encodeURIComponent(planId)}`;
}

async function loadFullPlanDetails(planId: string): Promise<void> {
  const selectedRoleId = roleId.value;
  const currentRequest = requestVersion;
  if (
    !selectedRoleId
    || planFullDetailsLoaded[planId]
    || planFullDetailsLoading[planId]
    || !plans.value.some((plan) => plan.id === planId)
  ) return;
  const queuedIndex = planDetailQueue.findIndex((task) => task.planId === planId);
  if (queuedIndex >= 0) planDetailQueue.splice(queuedIndex, 1);
  queuedPlanDetailIds.delete(planId);
  planFullDetailsLoading[planId] = true;
  try {
    const plan = await loadRolePlan(selectedRoleId, planId);
    if (currentRequest !== requestVersion || selectedRoleId !== roleId.value) return;
    plans.value = mergeKnowledgePage(plans.value, [plan]);
    planDetailsLoaded[planId] = true;
    planFullDetailsLoaded[planId] = true;
    applyFeedbackDeliveryState(plan.id, plan.approval.latest);
    void refreshPlanMarkdownTeasers([plan], currentRequest);
  } catch (loadError) {
    if (currentRequest === requestVersion) {
      planError.value = userFacingError(loadError);
    }
  } finally {
    if (currentRequest === requestVersion) planFullDetailsLoading[planId] = false;
  }
}

function togglePlan(plan: RolePlan): void {
  const expanded = !expandedPlans[plan.id];
  expandedPlans[plan.id] = expanded;
  if (expanded) {
    void loadFullPlanDetails(plan.id);
    if (!planAgentStatusIsFresh(plan.id)) void refreshPlanAgentStatuses([plan.id], true);
    void refreshPlanApproval(plan.id);
  }
}

function togglePlanWorkHistory(plan: RolePlan): void {
  const expanded = !planWorkHistoryExpanded[plan.id];
  planWorkHistoryExpanded[plan.id] = expanded;
  if (expanded) void refreshPlanHistory(plan.id);
}

function planDirectoryStyle(plan: RolePlan): Record<string, string> {
  return { "--plan-tone": plan.presentation.palette.accent };
}

function planListSortLabelFor(mode: PlanListSortMode): string {
  if (mode === "updated") return t("时间排序");
  if (mode === "importance") return t("重要程度");
  if (mode === "urgency") return t("紧急程度");
  return t("状态排序");
}

function planListSortIconFor(mode: PlanListSortMode): string {
  if (mode === "updated") return "mdi-clock-outline";
  if (mode === "importance") return "mdi-star-outline";
  if (mode === "urgency") return "mdi-calendar-clock-outline";
  return "mdi-sort-variant";
}

const planListSortLabel = computed(() => planListSortLabelFor(planListSortMode.value));
const planListHasFilters = computed(() => planListHiddenStatuses.value.length > 0 || planListSelectedTags.value.length > 0);
const planListDraftSortLabel = computed(() => planListSortLabelFor(planListDraftSortMode.value));
const planListDraftHasFilters = computed(() => planListDraftHiddenStatuses.value.length > 0 || planListDraftSelectedTags.value.length > 0);
const planListActiveFilterCount = computed(() => (planListHiddenStatuses.value.length ? 1 : 0) + planListSelectedTags.value.length);
const planListDraftActiveFilterCount = computed(() => (planListDraftHiddenStatuses.value.length ? 1 : 0) + planListDraftSelectedTags.value.length);
const normalizedPlanListTagQuery = computed(() => planListTagQuery.value.trim().toLocaleLowerCase());
const visiblePlanListTagOptions = computed(() => {
  if (!normalizedPlanListTagQuery.value) return planListTagOptions.value;
  return planListTagOptions.value.filter((option) => option.tag.toLocaleLowerCase().includes(normalizedPlanListTagQuery.value));
});

function ensurePlanListDialogContentCached(): void {
  if (planListDialogContentCached.value || planListDialogContentRequest) return;
  planListDialogContentRequest = (async () => {
    await nextTick();
    await yieldToKnowledgePaint();
    if (planDirectoryMounted) planListDialogContentCached.value = true;
  })().finally(() => {
    planListDialogContentRequest = null;
  });
}

function openPlanListDialog(): void {
  planListDraftSortMode.value = planListSortMode.value;
  planListDraftHiddenStatuses.value = [...planListHiddenStatuses.value];
  planListDraftSelectedTags.value = [...planListSelectedTags.value];
  planListTagQuery.value = "";
  planListDialogOpen.value = true;
  ensurePlanListDialogContentCached();
}

function applyPlanListDialog(): void {
  planListSortMode.value = planListDraftSortMode.value;
  planListHiddenStatuses.value = [...planListDraftHiddenStatuses.value];
  planListSelectedTags.value = [...planListDraftSelectedTags.value];
  planListDialogOpen.value = false;
  if (knowledgeFilterTimer) {
    window.clearTimeout(knowledgeFilterTimer);
    knowledgeFilterTimer = 0;
  }
  void refreshKnowledge();
}

function togglePlanListStatus(status: string): void {
  const isVisible = !planListDraftHiddenStatuses.value.includes(status);
  const visibleCount = planListStatusOptions.value.length - planListDraftHiddenStatuses.value.length;
  if (isVisible && visibleCount <= 1) return;
  planListDraftHiddenStatuses.value = planListDraftHiddenStatuses.value.includes(status)
    ? planListDraftHiddenStatuses.value.filter((item) => item !== status)
    : [...planListDraftHiddenStatuses.value, status];
}

function clearPlanListFilters(): void {
  planListDraftHiddenStatuses.value = [];
  planListDraftSelectedTags.value = [];
  planListTagQuery.value = "";
}

function togglePlanListTag(tag: string): void {
  planListDraftSelectedTags.value = planListDraftSelectedTags.value.includes(tag)
    ? planListDraftSelectedTags.value.filter((item) => item !== tag)
    : [...planListDraftSelectedTags.value, tag];
}

function planListStatusIsOnlyVisible(status: string): boolean {
  return !planListDraftHiddenStatuses.value.includes(status)
    && planListStatusOptions.value.length - planListDraftHiddenStatuses.value.length <= 1;
}

async function focusPlanCardAfterDirectoryJump(planId: string, reduceMotion: boolean): Promise<void> {
  await yieldToKnowledgePaint();
  let target = document.getElementById(planCardDomId(planId));
  if (!target) {
    // The card window can take one additional frame to mount after a large directory jump.
    await yieldToKnowledgePaint();
    target = document.getElementById(planCardDomId(planId));
  }
  if (!target) return;
  holdDirectoryJumpTarget(planId, !reduceMotion);
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
  schedulePlanCardObserverRefresh();
  schedulePlanDetailObserverRefresh();
}

function jumpToPlan(event: MouseEvent, plan: RolePlan): void {
  event.preventDefault();
  const targetIndex = visiblePlansForView.value.findIndex((item) => item.id === plan.id);
  if (targetIndex < 0) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  activeDirectoryPlanId.value = plan.id;
  planRenderStart.value = Math.max(0, targetIndex);
  planRenderLimit.value = 8;
  queuePlanDetails([plan], requestVersion, true);
  void focusPlanCardAfterDirectoryJump(plan.id, reduceMotion);
}

function isApprovalStep(plan: RolePlan, step: RolePlanStep): boolean {
  if (plan.presentation.approval.state === "none") return false;
  return step.id === (plan.presentation.approval.stepId || currentStep(plan)?.id);
}

function approvalMissingLabel(field: string): string {
  const labels: Record<string, string> = {
    approver: "审批人 / 责任人",
    request: "批准、调整或否决的具体决定",
    recommendation: "推荐方案",
    alternatives: "必要备选",
    reason: "审批原因",
    affectedActions: "文件、命令或外部变更",
    validation: "验证方式",
    rollback: "回退方案",
    outOfScope: "明确不在范围内的内容",
    requestedAt: "最近审批请求时间",
    source: "来源消息 ID 或 feedback ID",
    responseStatus: "当前回执状态"
  };
  return t(labels[field] || field);
}

function approvalFileAction(action: string): string {
  return t({ create: "新建", modify: "修改", delete: "删除", move: "移动" }[action] || action);
}

async function feedbackIntentSignature(value: unknown): Promise<string> {
  const source = JSON.stringify(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // 普通 HTTP 和部分 WebView 没有 Web Crypto；使用稳定摘要，不阻断计划引导提交。
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function clearFeedbackRequestId(planId: string): void {
  approvalRequestIds[planId] = "";
  approvalRequestSignatures[planId] = "";
  planFeedbackMutationLedger.complete(roleId.value, planId);
}

function feedbackRequestId(planId: string, signature: string): string {
  const existing = approvalRequestIds[planId];
  if (existing && approvalRequestSignatures[planId] === signature) return existing;
  const pending = planFeedbackMutationLedger.retain(roleId.value, planId, signature);
  approvalRequestIds[planId] = pending.feedbackId;
  approvalRequestSignatures[planId] = signature;
  return pending.feedbackId;
}

function approvalAttachmentsFor(planId: string): ApprovalAttachmentDraft[] {
  return approvalAttachments[planId] || [];
}

function approvalAttachmentError(planId: string, zh: string, en: string): void {
  approvalNotices[planId] = { tone: "error", text: isEnglish.value ? en : zh };
}

function attachmentDraftId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clipboardImageName(mimeType: string, index: number): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `clipboard-${stamp}${index > 0 ? `-${index + 1}` : ""}.${extension}`;
}

function clipboardAttachmentName(file: File, kind: "file" | "image", index: number): string {
  if (kind === "image") return clipboardImageName(file.type, index);
  return file.name || `clipboard-attachment-${index + 1}`;
}

function addApprovalFiles(planId: string, files: File[], fromClipboard = false): void {
  if (!files.length || approvalPending[planId]) return;
  const current = approvalAttachmentsFor(planId);
  if (current.length + files.length > PLAN_FEEDBACK_MAX_ATTACHMENTS) {
    approvalAttachmentError(
      planId,
      `最多只能添加 ${PLAN_FEEDBACK_MAX_ATTACHMENTS} 个附件。`,
      `You can attach at most ${PLAN_FEEDBACK_MAX_ATTACHMENTS} files.`
    );
    return;
  }
  const oversized = files.find((file) => file.size > PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES);
  if (oversized) {
    approvalAttachmentError(
      planId,
      `附件「${oversized.name || "未命名文件"}」超过 10 MB。`,
      `Attachment “${oversized.name || "unnamed file"}” exceeds 10 MB.`
    );
    return;
  }
  const total = current.reduce((sum, item) => sum + item.size, 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (total > PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES) {
    approvalAttachmentError(planId, "附件总大小不能超过 25 MB。", "Attachments cannot exceed 25 MB in total.");
    return;
  }
  const additions = files.map((file, index) => {
    const kind = file.type.startsWith("image/") ? "image" : "file";
    return {
      id: attachmentDraftId(),
      file: markRaw(file),
      name: fromClipboard
        ? clipboardAttachmentName(file, kind, index)
        : file.name || `attachment-${current.length + index + 1}`,
      size: file.size,
      mimeType: file.type,
      kind,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined
    } satisfies ApprovalAttachmentDraft;
  });
  approvalAttachments[planId] = [...current, ...additions];
  if (approvalNotices[planId]?.tone === "error") delete approvalNotices[planId];
}

function releaseAttachmentDrafts(drafts: ApprovalAttachmentDraft[]): void {
  for (const draft of drafts) {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
}

function removeApprovalAttachment(planId: string, attachmentId: string): void {
  if (approvalPending[planId]) return;
  const current = approvalAttachmentsFor(planId);
  const removed = current.find((item) => item.id === attachmentId);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  approvalAttachments[planId] = current.filter((item) => item.id !== attachmentId);
}

function takeApprovalAttachments(planId: string): ApprovalAttachmentDraft[] {
  const current = approvalAttachmentsFor(planId);
  approvalAttachments[planId] = [];
  return current;
}

function clearApprovalAttachments(planId: string): void {
  releaseAttachmentDrafts(approvalAttachmentsFor(planId));
  approvalAttachments[planId] = [];
}

function clearSubmittedApprovalAttachments(planId: string): void {
  releaseAttachmentDrafts(submittedApprovalAttachments.get(planId) || []);
  submittedApprovalAttachments.delete(planId);
}

function restoreSubmittedApprovalAttachments(planId: string): void {
  const submitted = submittedApprovalAttachments.get(planId);
  if (!submitted) return;
  approvalAttachments[planId] = submitted;
  submittedApprovalAttachments.delete(planId);
}

function resetApprovalAttachmentState(): void {
  for (const drafts of Object.values(approvalAttachments)) releaseAttachmentDrafts(drafts);
  for (const drafts of submittedApprovalAttachments.values()) releaseAttachmentDrafts(drafts);
  for (const key of Object.keys(approvalAttachments)) delete approvalAttachments[key];
  for (const key of Object.keys(approvalDeliveryPending)) delete approvalDeliveryPending[key];
  for (const key of Object.keys(approvalRequestIds)) delete approvalRequestIds[key];
  for (const key of Object.keys(approvalRequestSignatures)) delete approvalRequestSignatures[key];
  for (const key of Object.keys(approvalRevisions)) delete approvalRevisions[key];
  submittedApprovalTexts.clear();
  submittedApprovalAttachments.clear();
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function allApprovalMentionCandidates(plan: RolePlan) {
  return planAttachmentMentionCandidates(plan.attachments);
}

function attachmentContentBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Unable to read attachment."));
    reader.readAsDataURL(file);
  });
}

async function approvalAttachmentUploads(planId: string): Promise<PlanFeedbackAttachmentUpload[]> {
  return Promise.all(approvalAttachmentsFor(planId).map(async (attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType || undefined,
    contentBase64: await attachmentContentBase64(attachment.file)
  })));
}

function approvalResponseStatusLabel(status: RolePlanApprovalContract["responseStatus"]): string {
  return t({
    pending: "等待审批回执",
    approved: "已批准",
    rejected: "已否决",
    changes_requested: "要求调整方案",
    cancelled: "已取消"
  }[String(status)] || "未记录回执状态");
}

function approvalFeedbackBaseAvailable(plan: RolePlan): boolean {
  const approval = plan.presentation.approval;
  return Boolean(approval.stepId) && approval.enabled;
}

function canEditApprovalFeedback(plan: RolePlan): boolean {
  return approvalFeedbackBaseAvailable(plan) && !approvalPending[plan.id];
}

function canSubmitApproval(plan: RolePlan, notifyAgent = true): boolean {
  return canEditApprovalFeedback(plan)
    && !approvalPending[plan.id]
    && !approvalDeliveryPending[plan.id]
    && (!notifyAgent || Boolean(gatewayId.value))
    && composedFeedback(plan).valid && Boolean(composedFeedback(plan).text);
}

function canEditPlanGuidance(plan: RolePlan): boolean {
  return planAcceptsGuidance(plan) && !approvalPending[plan.id];
}

function canSubmitPlanGuidance(plan: RolePlan, notifyAgent = true): boolean {
  return canEditPlanGuidance(plan)
    && !approvalDeliveryPending[plan.id]
    && (!notifyAgent || Boolean(gatewayId.value))
    && composedFeedback(plan).valid && Boolean(composedFeedback(plan).text);
}

type ApprovalComposeStatus = {
  icon: string;
  text: string;
  title: string;
  tone: "info" | "warning";
};

function approvalComposeStatus(plan: RolePlan): ApprovalComposeStatus | null {
  if (plan.presentation.approval.state === "incomplete") {
    return {
      icon: "mdi-file-alert-outline",
      text: t("审批资料不完整，补齐前禁止输入或提交审批意见。"),
      title: t("审批资料不完整 / 禁止审批"),
      tone: "warning"
    };
  }
  if (!approvalFeedbackBaseAvailable(plan)) {
    return {
      icon: "mdi-alert-circle-outline",
      text: t("当前步骤未关联可用的审批入口；请让 Agent 更新 stepId 或审批状态。"),
      title: t("当前步骤不能填写审批意见"),
      tone: "warning"
    };
  }
  if (approvalPending[plan.id]) {
    return {
      icon: "mdi-content-save-clock-outline",
      text: t("正在保存本次意见，请稍候；保存完成后可继续编辑。"),
      title: t("正在保存审批意见"),
      tone: "info"
    };
  }
  if (approvalDeliveryPending[plan.id]) {
    return {
      icon: "mdi-send-clock-outline",
      text: t("上一条意见已记录，正在通知 Agent；你可以继续编辑下一条，通知完成后即可提交。"),
      title: t("上一条意见正在通知 Agent"),
      tone: "info"
    };
  }
  if (!gatewayId.value) {
    return {
      icon: "mdi-routes",
      text: t("当前没有可投递的 Route；仍可“提交”保存，绑定 Route 后才能“提交并投递”。"),
      title: t("当前 Route 不可用"),
      tone: "warning"
    };
  }
  return null;
}

function guidanceComposeStatus(plan: RolePlan): ApprovalComposeStatus | null {
  if (!planAcceptsGuidance(plan)) {
    return {
      icon: "mdi-alert-circle-outline",
      text: isEnglish.value
        ? "This plan status does not accept guidance, or the plan has already entered approval."
        : "当前计划状态不接受引导，或计划已经进入审批。",
      title: t("当前计划不能填写引导"),
      tone: "warning"
    };
  }
  if (approvalPending[plan.id]) {
    return {
      icon: "mdi-content-save-clock-outline",
      text: t("正在保存本次引导，请稍候；保存完成后可继续编辑。"),
      title: t("正在保存计划引导"),
      tone: "info"
    };
  }
  if (approvalDeliveryPending[plan.id]) {
    return {
      icon: "mdi-send-clock-outline",
      text: t("上一条引导已记录，正在通知 Agent；通知完成后即可提交下一条。"),
      title: t("上一条引导正在通知 Agent"),
      tone: "info"
    };
  }
  if (!gatewayId.value) {
    return {
      icon: "mdi-routes",
      text: t("当前没有可投递的 Route；仍可“提交”保存，绑定 Route 后才能“提交并投递”。"),
      title: t("当前 Route 不可用"),
      tone: "warning"
    };
  }
  return null;
}

function approvalFeedbackLabel(plan: RolePlan): string {
  return t(plan.presentation.approval.state === "incomplete" ? "审批建议（资料不完整）" : "审批建议");
}

function approvalFeedbackPlaceholder(plan: RolePlan): string {
  return t(plan.presentation.approval.state === "incomplete"
    ? "请先由 Agent 补齐审批合同。"
    : "例如：建议先补充回归范围，再进入下一步。");
}

function approvalFeedbackHint(plan: RolePlan): string {
  return t(plan.presentation.approval.state === "incomplete"
    ? "审批资料不完整，补齐前禁止输入或提交审批意见。"
    : "输入 @ 可引用计划附件；Enter 仅提交保存，Shift+Enter 换行。选择“提交并投递”才会通知 Agent。");
}

function applyPlanApproval(planId: string, approval: RolePlan["approval"]): void {
  const index = plans.value.findIndex((plan) => plan.id === planId);
  if (index < 0) return;
  const plan = plans.value[index];
  plans.value[index] = { ...plan, approval };
}

function feedbackNoticeName(feedback: RolePlanFeedback): string {
  return feedback.kind === "guidance" || feedback.kind === "guidance_response" ? "计划引导" : "审批建议";
}

function applyFeedbackDeliveryState(planId: string, feedback: RolePlanFeedback | undefined): void {
  const requestId = approvalRequestIds[planId];
  if (!feedback || !requestId || feedback.id !== requestId) return;
  const noticeName = feedbackNoticeName(feedback);
  if (feedback.deliveryStatus === "delivered" || feedback.deliveryStatus === "record_only") {
    delete questionDrafts[planId];
    approvalDeliveryPending[planId] = false;
    approvalNotices[planId] = { tone: "success", text: feedback.deliveryStatus === "record_only" ? t("已提交，尚未投递；Agent 可稍后读取审阅。") : t(`${noticeName}已记录并交给 Agent 处理。`) };
    clearFeedbackRequestId(planId);
    submittedApprovalTexts.delete(planId);
    clearSubmittedApprovalAttachments(planId);
    return;
  }
  if (feedback.deliveryStatus === "failed") {
    approvalDeliveryPending[planId] = false;
    const submittedText = submittedApprovalTexts.get(planId);
    if (submittedText && !approvalDrafts[planId]) approvalDrafts[planId] = submittedText;
    restoreSubmittedApprovalAttachments(planId);
    approvalNotices[planId] = {
      tone: "warning",
      text: t(`${noticeName}已记录，但通知 Agent 失败；可以保留内容后重试。`)
    };
  }
}

async function refreshPlanApproval(planId: string): Promise<void> {
  const selectedRoleId = roleId.value;
  if (!selectedRoleId || !plans.value.some((plan) => plan.id === planId)) return;
  try {
    const resource = await loadPlanFeedbackWithRevision(selectedRoleId, planId);
    if (selectedRoleId !== roleId.value) return;
    approvalRevisions[planId] = resource.etag;
    applyPlanApproval(planId, resource.approval);
    applyFeedbackDeliveryState(planId, resource.approval.latest);
  } catch {
    // The submission result remains visible; a later Manager event or manual refresh can reconcile it.
  }
}

async function refreshPlanHistory(planId: string): Promise<void> {
  const selectedRoleId = roleId.value;
  if (!selectedRoleId || !plans.value.some((plan) => plan.id === planId) || planHistoryLoading[planId]) return;
  planHistoryLoading[planId] = true;
  try {
    const records = await loadPlanHistory(selectedRoleId, planId);
    if (selectedRoleId === roleId.value) planHistoryRecords[planId] = records;
  } finally {
    if (selectedRoleId === roleId.value) planHistoryLoading[planId] = false;
  }
}

function openMemoryDetail(memory: RoleMemory): void {
  memoryDetailPreview.value = {
    memory,
    kind: currentMemoryKind()
  };
}

function closeMemoryDetail(): void {
  memoryDetailPreview.value = null;
}

function handlePlanFeedbackChanged(raw: Event): void {
  try {
    const data = JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; planId?: string };
    if (data.roleId === roleId.value && data.planId) void refreshPlanApproval(data.planId);
  } catch {
    // Ignore malformed event payloads and keep the latest valid plan snapshot.
  }
}

async function refreshPendingMemoryConsolidationRuns(expectedRoleId = roleId.value): Promise<void> {
  if (!expectedRoleId) {
    pendingMemoryConsolidationRuns.value = 0;
    return;
  }
  const pendingRuns = await loadPendingMemoryConsolidationRunCount(expectedRoleId);
  if (expectedRoleId !== roleId.value) return;
  pendingMemoryConsolidationRuns.value = pendingRuns;
}

function handleMemoryConsolidationChanged(raw: Event): void {
  try {
    const data = JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; status?: string };
    if (data.roleId !== roleId.value) return;
    if (activeView.value === "recent_memory") {
      void refreshPendingMemoryConsolidationRuns().catch((loadError) => {
        memoryError.value = userFacingError(loadError);
      });
    }
    if (data.status === "completed" && showsMemoryList.value) void refreshKnowledge();
  } catch {
    // Ignore malformed event payloads and keep the latest valid memory snapshot.
  }
}

function connectManagerEvents(): void {
  if (managerEvents || !knowledgePageWorkAllowed()) return;
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("plan_feedback_changed", handlePlanFeedbackChanged);
  managerEvents.addEventListener("memory_consolidation_changed", handleMemoryConsolidationChanged);
}

function disconnectManagerEvents(): void {
  managerEvents?.close();
  managerEvents = null;
}

function scheduleMemoryClockDeadline(): void {
  if (memoryClockTimer) window.clearTimeout(memoryClockTimer);
  memoryClockTimer = 0;
  if (!knowledgePageWorkAllowed()) return;
  const now = Date.now();
  const delay = 60_000 - (now % 60_000) + 25;
  memoryClockTimer = window.setTimeout(() => {
    memoryClock.value = Date.now();
    scheduleMemoryClockDeadline();
  }, delay);
}

function handleKnowledgeVisibilityChange(): void {
  if (!knowledgePageShouldWork(document.visibilityState, planDirectoryMounted)) {
    planPageObserver?.disconnect();
    memoryPageObserver?.disconnect();
    planDetailObserver?.disconnect();
    if (memoryClockTimer) window.clearTimeout(memoryClockTimer);
    memoryClockTimer = 0;
    return;
  }
  connectManagerEvents();
  memoryClock.value = Date.now();
  scheduleMemoryClockDeadline();
  schedulePlanCardObserverRefresh();
  schedulePlanDetailObserverRefresh();
  scheduleProgressiveSentinelRefresh();
  window.setTimeout(() => {
    if (showsPlanList.value && planNextCursor.value && !planPageBackgroundRequest) {
      loadAllRemainingPlans(roleId.value, requestVersion);
    }
  }, 0);
}

function activateKnowledgePage(): void {
  if (planDirectoryMounted) return;
  planDirectoryMounted = true;
  lastKnowledgeScrollY = cachedKnowledgeScrollY;
  document.addEventListener("visibilitychange", handleKnowledgeVisibilityChange);
  window.addEventListener("scroll", handleKnowledgeWindowScroll, { passive: true });
  window.addEventListener("resize", schedulePlanCardObserverRefresh, { passive: true });
  if (typeof ResizeObserver !== "undefined" && !toolbarResizeObserver) {
    toolbarResizeObserver = new ResizeObserver(schedulePlanCardObserverRefresh);
  }
  if (toolbarResizeObserver && knowledgeToolbar.value) {
    toolbarResizeObserver.observe(knowledgeToolbar.value);
  }
  schedulePlanCardObserverRefresh();
  schedulePlanDetailObserverRefresh();
  scheduleProgressiveSentinelRefresh();
  connectManagerEvents();
  scheduleMemoryClockDeadline();
  void nextTick(() => {
    window.scrollTo({ top: cachedKnowledgeScrollY, behavior: "auto" });
  });
  window.setTimeout(() => {
    if (showsPlanList.value && planNextCursor.value && !planPageBackgroundRequest) {
      loadAllRemainingPlans(roleId.value, requestVersion);
    }
  }, 0);
}

function deactivateKnowledgePage(): void {
  if (!planDirectoryMounted) return;
  cachedKnowledgeScrollY = Math.max(0, window.scrollY);
  planDirectoryMounted = false;
  document.removeEventListener("visibilitychange", handleKnowledgeVisibilityChange);
  window.removeEventListener("scroll", handleKnowledgeWindowScroll);
  window.removeEventListener("resize", schedulePlanCardObserverRefresh);
  releaseDirectoryJumpTarget(false, false);
  planCardObserver?.disconnect();
  toolbarResizeObserver?.disconnect();
  planPageObserver?.disconnect();
  memoryPageObserver?.disconnect();
  planDetailObserver?.disconnect();
  enablePlanScrollFallback(false);
  if (planDirectorySyncFrame) window.cancelAnimationFrame(planDirectorySyncFrame);
  planDirectorySyncFrame = 0;
  if (planObserverRefreshFrame) window.cancelAnimationFrame(planObserverRefreshFrame);
  planObserverRefreshFrame = 0;
  if (memoryClockTimer) window.clearTimeout(memoryClockTimer);
  memoryClockTimer = 0;
  disconnectManagerEvents();
}

onMounted(() => {
  cachedKnowledgeScrollY = Math.max(0, window.scrollY);
  activateKnowledgePage();
  void refreshKnowledge();
});

onActivated(activateKnowledgePage);
onDeactivated(deactivateKnowledgePage);

onBeforeUnmount(() => {
  requestVersion += 1;
  planPageBackgroundRequest = 0;
  deactivateKnowledgePage();
  if (knowledgeFilterTimer) window.clearTimeout(knowledgeFilterTimer);
  resetPlanAgentStatusState();
  closePlanMarkdownPreview();
  closeMemoryDetail();
  resetPlanMarkdownTeasers();
  resetApprovalAttachmentState();
});

async function sendApprovalSuggestion(plan: RolePlan, notifyAgent = true): Promise<void> {
  await sendPlanFeedback(plan, "approval_suggestion", notifyAgent);
}

async function sendPlanGuidance(plan: RolePlan, notifyAgent = true): Promise<void> {
  await sendPlanFeedback(plan, "guidance", notifyAgent);
}

async function sendPlanFeedback(plan: RolePlan, kind: "guidance" | "approval_suggestion", notifyAgent = true): Promise<void> {
  const reply = composedFeedback(plan);
  if (!reply.valid) {
    approvalNotices[plan.id] = { tone: "error", text: t("请回答必填问题，回答与补充说明合计不超过 2000 字。") };
    return;
  }
  const text = reply.text;
  const guidance = kind === "guidance";
  const noticeName = guidance ? "计划引导" : "审批建议";
  if (!text) {
    approvalNotices[plan.id] = { tone: "error", text: t(guidance ? "请先填写计划引导。" : "请先填写审批建议。") };
    return;
  }
  if (notifyAgent && !gatewayId.value) {
    approvalNotices[plan.id] = { tone: "error", text: t("当前没有可投递的 Route。") };
    return;
  }
  approvalPending[plan.id] = true;
  delete approvalNotices[plan.id];
  try {
    const attachments = await approvalAttachmentUploads(plan.id);
    const planAttachmentIds = referencedPlanAttachmentIds(text, allApprovalMentionCandidates(plan));
    const stepId = guidance ? undefined : plan.presentation.approval.stepId;
    const signature = await feedbackIntentSignature({
      roleId: roleId.value,
      planId: plan.id,
      gatewayId: notifyAgent ? gatewayId.value : undefined,
      stepId,
      text,
      attachments,
      planAttachmentIds,
      source: "webgui",
      kind,
      notifyAgent
    });
    const feedbackId = feedbackRequestId(plan.id, signature);
    // A mutation must fence against a GET from the current Manager generation,
    // never against an ETag retained from an earlier page refresh or generation.
    const resource = await loadPlanFeedbackWithRevision(roleId.value, plan.id);
    if (feedbackQuestions(plan).length) {
      const latestPlan = await loadRolePlan(roleId.value, plan.id);
      if (questionSignature(latestPlan) !== questionSignature(plan)) {
        throw new Error(t("计划问题已更新，请刷新计划后重新确认回答。"));
      }
    }
    approvalRevisions[plan.id] = resource.etag;
    applyPlanApproval(plan.id, resource.approval);
    const committed = await submitPlanFeedback({
      roleId: roleId.value,
      planId: plan.id,
      gatewayId: notifyAgent ? gatewayId.value : undefined,
      stepId,
      feedbackId,
      text,
      attachments,
      planAttachmentIds,
      source: "webgui",
      kind,
      notifyAgent,
      expectedRevision: approvalRevisions[plan.id]
    });
    approvalRevisions[plan.id] = committed.etag;
    const result = committed.feedback;
    const existingRecords = plan.approval.records?.length
      ? plan.approval.records
      : plan.approval.latest
        ? [plan.approval.latest]
        : [];
    const isExisting = existingRecords.some((feedback) => feedback.id === result.id);
    applyPlanApproval(plan.id, {
      count: plan.approval.count + (isExisting ? 0 : 1),
      latest: result,
      records: [result, ...existingRecords.filter((feedback) => feedback.id !== result.id)]
    });
    if (result.deliveryStatus === "failed") {
      approvalNotices[plan.id] = {
        tone: "warning",
        text: t(`${noticeName}已记录，但通知 Agent 失败；可以保留内容后重试。`)
      };
    } else if (result.deliveryStatus === "pending") {
      submittedApprovalTexts.set(plan.id, approvalDrafts[plan.id] || "");
      submittedApprovalAttachments.set(plan.id, takeApprovalAttachments(plan.id));
      approvalDeliveryPending[plan.id] = true;
      approvalDrafts[plan.id] = "";
      approvalNotices[plan.id] = { tone: "success", text: t(`${noticeName}已记录，正在后台通知 Agent。`) };
    } else {
      delete questionDrafts[plan.id];
      approvalDrafts[plan.id] = "";
      clearFeedbackRequestId(plan.id);
      submittedApprovalTexts.delete(plan.id);
      clearApprovalAttachments(plan.id);
      approvalNotices[plan.id] = { tone: "success", text: result.deliveryStatus === "record_only" ? t("已提交，尚未投递；Agent 可稍后读取审阅。") : t(`${noticeName}已记录并交给 Agent 处理。`) };
    }
  } catch (submitError) {
    if (submitError instanceof ManagerRequestError && submitError.status === 412) {
      await refreshPlanApproval(plan.id);
      approvalNotices[plan.id] = {
        tone: "warning",
        text: t("计划已经更新，已重新读取最新版本；请确认内容后使用原提交重试。")
      };
      return;
    }
    approvalNotices[plan.id] = {
      tone: "error",
      text: localizedPlanError(submitError, isEnglish.value)
    };
  } finally {
    approvalPending[plan.id] = false;
  }
}
</script>

<template>
  <div class="page-shell knowledge-page">
    <div class="knowledge-metrics">
      <div class="knowledge-metric blocked"><span>当前计划文件</span><b>{{ planCounts.plans }}</b><small>plans/active/&lt;planId&gt;</small></div>
      <div class="knowledge-metric qa"><span>已归档计划文件</span><b>{{ planCounts.archived }}</b><small>plans/archive/&lt;planId&gt;</small></div>
      <div class="knowledge-metric active"><span>近期记忆文件</span><b>{{ memoryPageCounts.recent }}</b><small>memory/recent</small></div>
      <div class="knowledge-metric memory"><span>沉淀记忆文件</span><b>{{ memoryPageCounts.consolidated }}</b><small>memory/consolidated</small></div>
    </div>

    <div
      class="knowledge-browser-layout"
      :class="{ 'has-plan-directory': roleId && showsPlanList && (visiblePlansForView.length || planListStatusOptions.length) }"
    >
      <nav
        v-if="roleId && showsPlanList && (visiblePlansForView.length || planListStatusOptions.length)"
        class="knowledge-plan-directory"
        :aria-label="t('计划目录')"
      >
        <div class="knowledge-plan-directory-head">
          <div class="knowledge-plan-directory-heading">
            <v-icon size="18">mdi-format-list-bulleted-square</v-icon>
            <b>计划目录</b>
            <span class="knowledge-plan-directory-count">{{ visiblePlansForView.length }} / {{ planListResultTotal }}</span>
          </div>
          <v-btn
            class="knowledge-plan-directory-sort-trigger"
            :class="{ filtered: planListHasFilters }"
            size="x-small"
            variant="tonal"
            :prepend-icon="planListSortIconFor(planListSortMode)"
            append-icon="mdi-tune-variant"
            :aria-label="isEnglish ? `Open plan list sorting and filters: ${planListSortLabel}` : `打开列表排序与筛选：${planListSortLabel}`"
            @click="openPlanListDialog"
          >
            {{ planListSortLabel }}
            <span v-if="planListActiveFilterCount" class="knowledge-plan-directory-filter-count">{{ planListActiveFilterCount }}</span>
          </v-btn>
          <v-dialog
            v-model="planListDialogOpen"
            width="calc(100vw - 48px)"
            max-width="1180"
            scrollable
            scrim="rgba(9, 22, 36, 0.56)"
            aria-labelledby="plan-list-dialog-title"
          >
            <v-card class="knowledge-plan-list-dialog" elevation="18">
              <div class="knowledge-plan-list-dialog-title">
                <div class="knowledge-plan-list-dialog-heading">
                  <span class="knowledge-plan-list-dialog-icon" aria-hidden="true">
                    <v-icon size="20">mdi-tune-variant</v-icon>
                  </span>
                  <span>
                    <b id="plan-list-dialog-title">{{ t("列表排序与筛选") }}</b>
                    <small>{{ t("目录和计划卡片保持一致") }}</small>
                  </span>
                </div>
                <v-btn
                  class="knowledge-plan-list-dialog-close"
                  icon="mdi-close"
                  size="small"
                  variant="text"
                  :aria-label="t('关闭')"
                  @click="planListDialogOpen = false"
                />
              </div>
              <v-card-text class="knowledge-plan-list-dialog-content">
                <div class="knowledge-plan-list-summary">
                  <div>
                    <span>{{ t("当前结果") }}</span>
                    <b>{{ visiblePlansForView.length }} / {{ planListResultTotal }}</b>
                  </div>
                  <div class="knowledge-plan-list-summary-actions">
                    <span class="knowledge-plan-list-current-mode">
                      <v-icon size="15">{{ planListSortIconFor(planListDraftSortMode) }}</v-icon>
                      {{ planListDraftSortLabel }}
                    </span>
                    <span v-if="planListDraftActiveFilterCount" class="knowledge-plan-list-filter-summary">
                      {{ isEnglish ? `${planListDraftActiveFilterCount} filters` : `${planListDraftActiveFilterCount} 项筛选` }}
                    </span>
                    <v-btn
                      class="knowledge-plan-list-clear-all"
                      size="small"
                      variant="text"
                      :disabled="!planListDraftHasFilters"
                      @click="clearPlanListFilters"
                    >{{ t("清除筛选") }}</v-btn>
                  </div>
                </div>
                <div v-if="!planListDialogContentCached" class="knowledge-plan-list-dialog-loading" aria-live="polite">
                  <v-progress-circular indeterminate color="primary" size="32" width="3" />
                  <span>
                    <b>{{ t("正在准备筛选项…") }}</b>
                    <small>{{ t("弹窗已经打开，状态和标签将在下一帧显示。") }}</small>
                  </span>
                </div>
                <div v-else class="knowledge-plan-list-control-layout">
                  <div class="knowledge-plan-list-control-column">
                    <fieldset class="knowledge-plan-list-panel knowledge-plan-list-sort-panel">
                      <legend>{{ t("排序方式") }}</legend>
                      <p>{{ t("选择整个计划列表的排列方式") }}</p>
                      <div class="knowledge-plan-list-sort-options">
                        <button
                          type="button"
                          :class="{ selected: planListDraftSortMode === 'status' }"
                          :aria-pressed="planListDraftSortMode === 'status'"
                          @click="planListDraftSortMode = 'status'"
                        >
                          <span class="knowledge-plan-list-sort-icon"><v-icon size="20">mdi-sort-variant</v-icon></span>
                          <span><b>{{ t("状态排序") }}</b><small>{{ t("相同工作阶段集中显示") }}</small></span>
                          <v-icon class="knowledge-plan-list-sort-check" size="18">{{ planListDraftSortMode === "status" ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                        </button>
                        <button
                          type="button"
                          :class="{ selected: planListDraftSortMode === 'updated' }"
                          :aria-pressed="planListDraftSortMode === 'updated'"
                          @click="planListDraftSortMode = 'updated'"
                        >
                          <span class="knowledge-plan-list-sort-icon"><v-icon size="20">mdi-clock-outline</v-icon></span>
                          <span><b>{{ t("时间排序") }}</b><small>{{ t("最近更新的计划优先") }}</small></span>
                          <v-icon class="knowledge-plan-list-sort-check" size="18">{{ planListDraftSortMode === "updated" ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                        </button>
                        <button
                          type="button"
                          :class="{ selected: planListDraftSortMode === 'importance' }"
                          :aria-pressed="planListDraftSortMode === 'importance'"
                          @click="planListDraftSortMode = 'importance'"
                        >
                          <span class="knowledge-plan-list-sort-icon"><v-icon size="20">mdi-star-outline</v-icon></span>
                          <span><b>{{ t("重要程度") }}</b><small>{{ t("重要程度高的计划优先") }}</small></span>
                          <v-icon class="knowledge-plan-list-sort-check" size="18">{{ planListDraftSortMode === "importance" ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                        </button>
                        <button
                          type="button"
                          :class="{ selected: planListDraftSortMode === 'urgency' }"
                          :aria-pressed="planListDraftSortMode === 'urgency'"
                          @click="planListDraftSortMode = 'urgency'"
                        >
                          <span class="knowledge-plan-list-sort-icon"><v-icon size="20">mdi-calendar-clock-outline</v-icon></span>
                          <span><b>{{ t("紧急程度") }}</b><small>{{ t("截止时间近的计划优先") }}</small></span>
                          <v-icon class="knowledge-plan-list-sort-check" size="18">{{ planListDraftSortMode === "urgency" ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                        </button>
                      </div>
                    </fieldset>
                    <fieldset class="knowledge-plan-list-panel knowledge-plan-list-filter-panel">
                      <legend>{{ t("筛选状态") }}</legend>
                      <div class="knowledge-plan-list-filter-head">
                        <p>{{ t("可多选，同组匹配任一状态") }}</p>
                        <v-btn
                          class="knowledge-plan-list-show-all"
                          size="small"
                          variant="text"
                          :disabled="!planListDraftHiddenStatuses.length"
                          @click="planListDraftHiddenStatuses = []"
                        >
                          {{ t("显示全部") }}
                        </v-btn>
                      </div>
                      <div class="knowledge-plan-list-filter-options knowledge-plan-list-status-options">
                        <label
                          v-for="option in planListStatusOptions"
                          :key="option.status"
                          :class="{
                            disabled: planListStatusIsOnlyVisible(option.status),
                            selected: !planListDraftHiddenStatuses.includes(option.status)
                          }"
                        >
                          <input
                            type="checkbox"
                            :checked="!planListDraftHiddenStatuses.includes(option.status)"
                            :disabled="planListStatusIsOnlyVisible(option.status)"
                            @change="togglePlanListStatus(option.status)"
                          >
                          <span class="knowledge-plan-list-filter-swatch" :style="{ backgroundColor: option.palette.accent }" />
                          <span :title="planStatusOptionDescription(option)">{{ planStatusOptionLabel(option) }}</span>
                          <b>{{ option.count }}</b>
                        </label>
                      </div>
                    </fieldset>
                  </div>
                  <fieldset class="knowledge-plan-list-panel knowledge-plan-list-filter-panel knowledge-plan-list-tag-panel">
                    <legend>{{ t("筛选标签") }}</legend>
                    <div class="knowledge-plan-list-filter-head">
                      <p>{{ t("可多选，同组匹配任一标签") }}</p>
                      <v-btn
                        class="knowledge-plan-list-show-all"
                        size="small"
                        variant="text"
                        :disabled="!planListDraftSelectedTags.length"
                        @click="planListDraftSelectedTags = []"
                      >{{ t("清除") }}</v-btn>
                    </div>
                    <v-text-field
                      v-model="planListTagQuery"
                      class="knowledge-plan-list-tag-search"
                      density="compact"
                      variant="outlined"
                      prepend-inner-icon="mdi-magnify"
                      :placeholder="t('搜索标签')"
                      :aria-label="t('搜索标签')"
                      clearable
                      hide-details
                    />
                    <v-virtual-scroll
                      v-if="visiblePlanListTagOptions.length"
                      class="knowledge-plan-list-filter-options knowledge-plan-list-tag-options"
                      :items="visiblePlanListTagOptions"
                      height="420"
                      item-height="44"
                    >
                      <template #default="{ item: option }">
                        <label :class="{ selected: planListDraftSelectedTags.includes(option.tag) }">
                          <input
                            type="checkbox"
                            :checked="planListDraftSelectedTags.includes(option.tag)"
                            @change="togglePlanListTag(option.tag)"
                          >
                          <v-icon class="knowledge-plan-list-tag-icon" size="15">mdi-tag-outline</v-icon>
                          <span data-no-i18n>{{ option.tag }}</span>
                          <b>{{ option.count }}</b>
                        </label>
                      </template>
                    </v-virtual-scroll>
                    <div v-else class="knowledge-plan-list-no-tags">
                      {{ planListTagOptions.length ? t("没有匹配的标签") : t("当前计划没有标签") }}
                    </div>
                  </fieldset>
                </div>
                <p class="knowledge-plan-list-filter-rule">{{ t("状态与标签同时满足时，计划才会显示。") }}</p>
              </v-card-text>
              <v-divider />
              <v-card-actions class="knowledge-plan-list-dialog-actions">
                <span>{{ t("点击完成后更新目录和计划卡片") }}</span>
                <v-btn color="primary" variant="flat" size="large" @click="applyPlanListDialog">{{ t("完成") }}</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>
        </div>
        <p>点击计划快速跳转</p>
        <div ref="planDirectoryList" class="knowledge-plan-directory-list">
          <a
            v-for="plan in visiblePlansForView"
            :key="`directory-${plan.id}`"
            :href="`#${planCardDomId(plan.id)}`"
            class="knowledge-plan-directory-link"
            :class="{ active: activeDirectoryPlanId === plan.id }"
            :data-tone="plan.presentation.tone"
            :style="planDirectoryStyle(plan)"
            :aria-current="activeDirectoryPlanId === plan.id ? 'location' : undefined"
            :data-plan-directory-id="plan.id"
            @click="jumpToPlan($event, plan)"
            @mouseenter="setPlanDirectoryMarquee($event, true)"
            @mouseleave="setPlanDirectoryMarquee($event, false)"
            @focus="setPlanDirectoryMarquee($event, true)"
            @blur="setPlanDirectoryMarquee($event, false)"
          >
            <span class="knowledge-plan-directory-copy">
              <b class="knowledge-plan-directory-title" :title="plan.title" data-no-i18n>
                <span>{{ planTitleForDirectory(plan.title) }}</span>
              </b>
            </span>
            <span
              class="knowledge-plan-directory-sort-label"
              :style="planDirectorySortStyle(plan)"
              :title="planDirectorySortTitle(plan)"
              role="status"
              :aria-label="planDirectorySortTitle(plan)"
              data-no-i18n
            >{{ planDirectorySortValue(plan) }}</span>
          </a>
          <div v-if="!visiblePlansForView.length" class="knowledge-plan-directory-empty">
            {{ t("没有符合当前筛选的计划") }}
          </div>
        </div>
      </nav>

      <v-card class="app-card knowledge-browser" variant="flat">
      <div ref="knowledgeToolbar" class="knowledge-toolbar">
        <v-btn-toggle v-model="activeView" mandatory color="primary" density="comfortable" class="knowledge-tabs">
          <v-btn value="plans" prepend-icon="mdi-clipboard-play-outline"><span>{{ t("当前计划") }}</span><b>{{ planPageCounts.plans }}</b></v-btn>
          <v-btn value="recent_memory" prepend-icon="mdi-memory"><span>{{ t("近期记忆") }}</span><b>{{ memoryPageCounts.recent }}</b></v-btn>
          <v-btn value="consolidated_memory" prepend-icon="mdi-bookshelf"><span>{{ t("沉淀记忆") }}</span><b>{{ memoryPageCounts.consolidated }}</b></v-btn>
          <v-btn value="archived" prepend-icon="mdi-archive-outline"><span>{{ isEnglish ? "Archived" : "已归档" }}</span><b>{{ planPageCounts.archived + memoryPageCounts.archived }}</b></v-btn>
        </v-btn-toggle>
        <div class="knowledge-tools">
          <v-text-field
            v-model="query"
            label="搜索计划或记忆的任意内容"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details
            density="compact"
          />
          <v-btn prepend-icon="mdi-refresh" variant="tonal" color="primary" :loading="loading || memoryLoading" @click="refreshKnowledge">刷新</v-btn>
        </div>
      </div>

      <v-progress-linear v-if="knowledgeListLoading" indeterminate color="secondary" />
      <div v-if="roleId && (showsPlanList || showsMemoryList)" class="knowledge-progressive-status" aria-live="polite">
        <v-progress-circular v-if="knowledgeListLoading" indeterminate size="16" width="2" color="primary" />
        <v-icon v-else size="16" color="success">mdi-check-circle-outline</v-icon>
        <span data-no-i18n>{{ knowledgeListStatus }}</span>
      </div>
      <v-alert v-if="roleId && showsPlanList && planError" type="error" variant="tonal" class="ma-5">
        {{ t("计划加载失败") }}：{{ planError }}
      </v-alert>
      <v-alert v-if="roleId && showsMemoryList && memoryError" type="error" variant="tonal" class="ma-5">
        {{ t("记忆加载失败") }}：{{ memoryError }}
      </v-alert>
      <v-alert v-if="!roleId" type="warning" variant="tonal" class="ma-5">当前 Route 尚未绑定人格。</v-alert>

      <div v-if="roleId && showsPlanList" class="knowledge-list">
        <div v-if="activeView === 'archived'" class="knowledge-subsection-heading">
          <v-icon size="20">mdi-archive-outline</v-icon>
          <b>{{ isEnglish ? "Archived plans" : "已归档计划" }}</b>
        </div>
        <div v-if="loading && !plans.length" class="knowledge-plan-skeletons" aria-live="polite">
          <div v-for="index in 3" :key="index" class="knowledge-plan-skeleton">
            <v-skeleton-loader type="heading, paragraph, paragraph, actions" />
          </div>
        </div>
        <div
          v-if="hasMoreRenderedPlansBefore"
          ref="planLoadPreviousSentinel"
          class="knowledge-load-more"
          aria-live="polite"
        >
          <span>{{ t("继续向上滚动加载上方计划卡片") }}</span>
          <v-btn size="small" variant="text" @click="loadPreviousRenderedPlans">{{ t("加载上方计划") }}</v-btn>
        </div>
        <div v-if="renderedPlansForView.length" class="knowledge-plan-cards">
            <article
              v-for="plan in renderedPlansForView"
              :id="planCardDomId(plan.id)"
              :key="plan.id"
              class="knowledge-plan-card"
              :class="{ expanded: expandedPlans[plan.id] }"
              :data-tone="plan.presentation.tone"
              :data-plan-id="plan.id"
              :style="planCardStyle(plan.presentation.palette)"
              tabindex="-1"
            >
          <div class="knowledge-plan-accent" />
          <div class="knowledge-plan-main">
            <div class="knowledge-plan-head">
              <div class="knowledge-plan-title-copy">
                <div class="knowledge-kicker" data-no-i18n>{{ plan.project?.name || plan.kind || "PLAN" }}</div>
                <h2 data-no-i18n>{{ plan.title }}</h2>
              </div>
              <div class="knowledge-plan-head-actions">
                <v-chip class="knowledge-plan-status" :title="planStatusDescription(plan)" :style="planStatusStyle(plan.presentation.palette)" variant="flat" size="small">{{ planStatusLabel(plan) }}</v-chip>
                <v-btn
                  v-if="planAgentBindingStatus(plan, 'task')?.canOpen && !planTaskAgentWorking(plan)"
                  class="knowledge-plan-open-task"
                  size="small"
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-open-in-new"
                  :loading="planAgentOpenPending[planAgentOpenKey(plan.id, 'task')]"
                  :aria-label="isEnglish ? `Open ${planAgentTitle(plan, 'task')} in ${planAgentBindingStatus(plan, 'task')?.agentType === 'dsh' ? 'DSH' : 'Codex'}` : `在${planAgentBindingStatus(plan, 'task')?.agentType === 'dsh' ? 'DSH' : 'Codex'}中打开${planAgentTitle(plan, 'task')}`"
                  @click.stop="openPlanAgent(plan, 'task')"
                >
                  {{ isEnglish ? "Open task" : "打开任务" }}
                </v-btn>
              </div>
            </div>

            <div
              v-if="planAgentNotices[planAgentOpenKey(plan.id, 'task')]"
              class="knowledge-plan-agent-inline-notice"
              :data-tone="planAgentNotices[planAgentOpenKey(plan.id, 'task')]?.tone"
              role="status"
            >
              {{ planAgentNotices[planAgentOpenKey(plan.id, "task")]?.text }}
            </div>

            <div v-if="planDetailsLoading[plan.id]" class="knowledge-plan-detail-loading" aria-live="polite">
              <div>
                <v-progress-circular indeterminate size="22" width="2" color="primary" />
                <b>{{ t("正在加载计划详情…") }}</b>
              </div>
              <div class="knowledge-plan-detail-loading-lines" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>

            <div v-else-if="!planDetailsLoaded[plan.id]" class="knowledge-plan-detail-pending">
              <v-icon size="17">mdi-progress-clock</v-icon>
              <span>{{ t("计划详情将在进入视口时加载") }}</span>
            </div>

            <div v-if="planDetailsLoaded[plan.id] && planDescriptionForDisplay(plan)" class="knowledge-plan-focus">
              <span>计划描述</span>
              <p data-no-i18n>{{ planDescriptionForDisplay(plan) }}</p>
            </div>

            <section v-if="planDetailsLoaded[plan.id] && plan.attachments.length" class="knowledge-plan-attachments" :aria-label="t('计划附件')">
              <div class="knowledge-plan-attachments-head">
                <span><v-icon size="16">mdi-paperclip</v-icon>{{ t("计划附件") }}</span>
                <small>{{ plan.attachments.length }}</small>
              </div>
              <PlanAttachmentGallery
                :plan="plan"
                :plan-attachment-url="planAttachmentUrl"
                :plan-video-thumbnail-url="planVideoThumbnailUrl"
                :plan-media-load-state="planMediaLoadState"
                :set-plan-media-load-state="setPlanMediaLoadState"
                :capture-plan-video-duration="capturePlanVideoDuration"
                :displayed-plan-video-duration="displayedPlanVideoDuration"
                :plan-markdown-teaser="planMarkdownTeaser"
                :open-plan-media-preview="openPlanMediaPreview"
                :open-plan-markdown-preview="openPlanMarkdownPreview"
                :format-attachment-size="formatAttachmentSize"
              />
            </section>

            <div class="knowledge-plan-summary">
              <div class="knowledge-plan-current" :class="{ blocked: Boolean(blocker(plan)) }">
                <v-icon size="19">{{ blocker(plan) ? "mdi-alert-circle-outline" : "mdi-progress-wrench" }}</v-icon>
                <div class="knowledge-plan-current-copy">
                  <div class="knowledge-plan-current-heading">
                    <span>{{ blocker(plan) ? "当前阻塞" : "当前步骤" }}</span>
                    <small v-if="planStepCount(plan)">{{ currentStepPosition(plan) || "—" }}/{{ planStepCount(plan) }} · {{ t("执行步骤") }}</small>
                  </div>
                  <b
                    v-if="currentStep(plan)?.title || plan.currentStep"
                    data-no-i18n
                    :title="currentStep(plan)?.title || plan.currentStep"
                  >{{ currentStep(plan)?.title || plan.currentStep }}</b>
                  <b v-else>{{ t("暂无进行中的步骤") }}</b>
                  <PlanStepDetail v-if="currentStep(plan)?.detail" class="knowledge-plan-current-detail" :text="currentStep(plan)?.detail || ''" />
                </div>
              </div>
              <div class="knowledge-plan-timing">
                <div class="knowledge-plan-timing-item">
                  <span>更新时间</span>
                  <b data-no-i18n>{{ formatDate(plan.updatedAt) }}</b>
                </div>
                <div v-if="plan.dueAt" class="knowledge-plan-timing-item">
                  <span>截止时间</span>
                  <b data-no-i18n>{{ formatDate(plan.dueAt) }}</b>
                </div>
              </div>
            </div>

            <v-alert v-if="planDetailsLoaded[plan.id] && blocker(plan)" data-no-i18n type="error" variant="tonal" density="compact" class="knowledge-blocker">
              {{ blocker(plan) }}
            </v-alert>

            <div v-if="planStepCount(plan)" class="knowledge-progress-row">
              <div class="knowledge-progress-copy">
                <span>{{ t("步骤进度") }}</span>
                <b>{{ completedSteps(plan) }}/{{ planStepCount(plan) }}</b>
              </div>
              <v-progress-linear :model-value="progressValue(plan)" color="secondary" height="7" rounded />
            </div>

            <div v-if="plan.keywords.length" class="knowledge-keywords">
              <v-chip v-for="keyword in plan.keywords" :key="keyword" data-no-i18n size="x-small" variant="outlined">{{ keyword }}</v-chip>
            </div>

            <button
              class="knowledge-expand"
              type="button"
              :aria-expanded="Boolean(expandedPlans[plan.id])"
              @click="togglePlan(plan)"
            >
              <span>{{ expandedPlans[plan.id] ? t("收起计划详情") : plan.presentation.approval.state === "ready" ? t("查看执行合同并审批") : plan.presentation.approval.state === "incomplete" ? t("查看缺失的审批信息") : planAcceptsGuidance(plan) ? t("查看计划详情并引导") : planStepCount(plan) ? `${t("查看全部")} ${planStepCount(plan)} ${t("个步骤")}` : t("查看计划详情") }}</span>
              <v-icon size="18">{{ expandedPlans[plan.id] ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>

            <div v-if="expandedPlans[plan.id]" class="knowledge-plan-details">
              <v-alert
                v-if="planFullDetailsLoading[plan.id]"
                type="info"
                variant="tonal"
                density="compact"
                class="knowledge-plan-full-detail-loading"
              >
                {{ t("正在加载计划详情…") }}
              </v-alert>
              <section class="knowledge-plan-agents" :aria-label="t('计划关联 Agent')">
                <div class="knowledge-plan-agents-head">
                  <div>
                    <span><v-icon size="17">mdi-robot-outline</v-icon>{{ t("计划关联 Agent") }}</span>
                    <small>{{ t("状态来自绑定 Agent 的对应会话") }}</small>
                  </div>
                  <v-btn
                    v-if="planAgentShouldRetry(plan)"
                    size="small"
                    variant="text"
                    prepend-icon="mdi-refresh"
                    :loading="planAgentStatusLoading[plan.id]"
                    @click="refreshPlanAgentStatuses([plan.id], true)"
                  >
                    {{ t("重试状态") }}
                  </v-btn>
                </div>
                <div v-if="planAgentStatusLoading[plan.id]" class="knowledge-plan-agent-query" role="status">
                  <v-progress-circular indeterminate size="18" width="2" />
                  <span>{{ t("正在确认 Agent 与会话任务状态…") }}</span>
                </div>
                <div class="knowledge-plan-agent-list">
                  <button
                    v-for="agentRole in planAgentRoles(plan)"
                    :key="`${plan.id}-${agentRole}`"
                    type="button"
                    class="knowledge-plan-agent-row"
                    :class="{ actionable: planAgentBindingStatus(plan, agentRole)?.canOpen && !planAgentBindingStatus(plan, agentRole)?.working }"
                    :data-tone="planAgentStatusTone(planAgentBindingStatus(plan, agentRole))"
                    :disabled="!planAgentBindingStatus(plan, agentRole)?.canOpen || planAgentBindingStatus(plan, agentRole)?.working"
                    :aria-label="planAgentBindingStatus(plan, agentRole)?.canOpen && !planAgentBindingStatus(plan, agentRole)?.working
                      ? (isEnglish ? `Open ${planAgentTitle(plan, agentRole)} in Codex` : `在 Codex 中打开${planAgentTitle(plan, agentRole)}`)
                      : undefined"
                    @click="openPlanAgent(plan, agentRole)"
                  >
                    <span class="knowledge-plan-agent-identity">
                      <span class="knowledge-plan-agent-icon" aria-hidden="true">
                        <v-icon size="20">{{ agentRole === "secretary" ? "mdi-account-tie-outline" : "mdi-robot-outline" }}</v-icon>
                      </span>
                      <span class="knowledge-plan-agent-copy">
                        <small>{{ planAgentRoleLabel(agentRole) }}</small>
                        <b data-no-i18n :title="planAgentTitle(plan, agentRole)">{{ planAgentTitle(plan, agentRole) }}</b>
                        <em v-if="planAgentBindingStatus(plan, agentRole)?.workspace" data-no-i18n :title="planAgentBindingStatus(plan, agentRole)?.workspace">
                          {{ planAgentBindingStatus(plan, agentRole)?.workspace }}
                        </em>
                      </span>
                    </span>
                    <span class="knowledge-plan-agent-states">
                      <span class="knowledge-plan-agent-work-state">
                        <v-icon v-if="planAgentBindingStatus(plan, agentRole)?.working" class="knowledge-plan-agent-working-icon" size="14">mdi-loading</v-icon>
                        <v-icon v-else size="14">{{ planAgentBindingStatus(plan, agentRole)?.agentStatus === "idle" ? "mdi-pause-circle-outline" : "mdi-help-circle-outline" }}</v-icon>
                        {{ planAgentWorkLabel(planAgentBindingStatus(plan, agentRole)) }}
                      </span>
                      <span class="knowledge-plan-agent-session-state">
                        {{ planAgentSessionLabel(planAgentBindingStatus(plan, agentRole)?.sessionStatus) }}
                      </span>
                      <span
                        v-if="planAgentBindingStatus(plan, agentRole)?.sessionStatus === 'missing'"
                        class="knowledge-plan-agent-missing"
                      >
                        <v-icon size="14">mdi-alert-circle-outline</v-icon>
                        {{ isEnglish ? "Task Agent session is missing" : "会话任务 Agent 已丢失" }}
                      </span>
                      <v-icon
                        v-if="planAgentBindingStatus(plan, agentRole)?.canOpen && !planAgentBindingStatus(plan, agentRole)?.working"
                        class="knowledge-plan-agent-open-icon"
                        size="18"
                      >mdi-open-in-new</v-icon>
                    </span>
                  </button>
                </div>
                <div
                  v-for="agentRole in planAgentRoles(plan)"
                  v-show="planAgentNotices[planAgentOpenKey(plan.id, agentRole)]"
                  :key="`${plan.id}-${agentRole}-notice`"
                  class="knowledge-plan-agent-notice"
                  :data-tone="planAgentNotices[planAgentOpenKey(plan.id, agentRole)]?.tone"
                  role="status"
                >
                  {{ planAgentNotices[planAgentOpenKey(plan.id, agentRole)]?.text }}
                </div>
              </section>

              <section v-if="planAcceptsGuidance(plan)" class="knowledge-approval-panel" data-state="guidance">
                <div class="knowledge-approval-head">
                  <div>
                    <span>{{ t("计划引导") }}</span>
                    <b>{{ t("给 Agent 补充整个计划的方向、范围或优先级") }}</b>
                  </div>
                  <v-chip color="primary" size="x-small" variant="tonal">{{ t("可引导") }}</v-chip>
                </div>
                <p>{{ t("引导属于整个计划，不绑定某个步骤。Agent 会据此继续推进，并在需要时调整后续步骤；引导不会被视为审批，也不会自动改变计划状态。") }}</p>
                <div v-if="guidanceRecordsForDisplay(plan).length" class="knowledge-approval-history" :aria-label="t('计划引导记录')">
                  <article
                    v-for="feedback in guidanceRecordsForDisplay(plan)"
                    :key="feedback.id"
                    class="knowledge-approval-record"
                    :data-author="feedback.author"
                  >
                    <span>{{ feedbackRecordLabel(feedback) }} · <time data-no-i18n>{{ formatDate(feedback.createdAt) }}</time></span>
                    <b data-no-i18n>{{ feedback.text }}</b>
                    <div v-if="(feedback.attachments || []).length" class="knowledge-approval-record-attachments">
                      <v-chip
                        v-for="attachment in feedback.attachments"
                        :key="`${feedback.id}-${attachment.sha256}`"
                        prepend-icon="mdi-paperclip"
                        size="x-small"
                        variant="tonal"
                        data-no-i18n
                      >
                        {{ attachment.name }} · {{ formatAttachmentSize(attachment.size) }}
                      </v-chip>
                    </div>
                    <div v-if="(feedback.planAttachments || []).length" class="knowledge-approval-record-attachments">
                      <v-chip
                        v-for="attachment in feedback.planAttachments"
                        :key="`${feedback.id}-plan-${attachment.id}`"
                        prepend-icon="mdi-at"
                        size="x-small"
                        variant="tonal"
                        color="primary"
                        data-no-i18n
                      >
                        {{ attachment.name }} · {{ formatAttachmentSize(attachment.size) }}
                      </v-chip>
                    </div>
                  </article>
                </div>
                <div
                  v-if="guidanceComposeStatus(plan)"
                  class="knowledge-approval-compose-status"
                  :data-tone="guidanceComposeStatus(plan)?.tone"
                  role="status"
                >
                  <span class="knowledge-approval-compose-status-icon">
                    <v-icon size="18">{{ guidanceComposeStatus(plan)?.icon }}</v-icon>
                  </span>
                  <span class="knowledge-approval-compose-status-copy">
                    <b>{{ guidanceComposeStatus(plan)?.title }}</b>
                    <span>{{ guidanceComposeStatus(plan)?.text }}</span>
                  </span>
                </div>
                <PlanQuestionFields
                  v-if="feedbackQuestions(plan).length"
                  :questions="feedbackQuestions(plan)" :answers="questionAnswers(plan)" :form-id="`guidance-${plan.id}`"
                    :plan-attachments="plan.attachments" :attachment-url="(id) => planAttachmentUrl(plan.id, id)"
                    :submit-disabled="!canSubmitPlanGuidance(plan, false)"
                    @add-files="addApprovalFiles(plan.id, $event.files, $event.fromClipboard)"
                    @submit="sendPlanGuidance(plan, false)"
                  :disabled="!canEditPlanGuidance(plan) || Boolean(approvalDeliveryPending[plan.id])"
                  @change="(id, answer) => updateQuestionAnswer(plan, id, answer)"
                />
                <PlanFeedbackComposer
                  :composer-id="`guidance-${plan.id}`"
                    :footer-only="Boolean(feedbackQuestions(plan).length)"
                  :model-value="approvalDrafts[plan.id] || ''"
                  :plan-attachments="plan.attachments"
                  :attachments="approvalAttachmentsFor(plan.id)"
                  :attachment-url="(attachmentId) => planAttachmentUrl(plan.id, attachmentId)"
                  :label="t('计划引导')"
                  :placeholder="t('例如：先确认入口关闭后的整体体验，再根据结果调整后续步骤。')"
                  :hint="t('输入 @ 可引用计划附件；Enter 仅提交保存，Shift+Enter 换行。选择“提交并投递”才会通知 Agent。')"
                  :disabled="!canEditPlanGuidance(plan)"
                  :submit-disabled="!canSubmitPlanGuidance(plan)"
                  :pending="Boolean(approvalPending[plan.id])"
                  :notice="approvalNotices[plan.id]"
                  :submit-label="t('提交并投递')"
                  :submit-record-only-label="t('提交')"
                  :record-only-disabled="!canSubmitPlanGuidance(plan, false)"
                  submit-icon="mdi-send-outline"
                  :footer-text="t('提交仅保存；提交并投递会通知 Agent。')"
                  @update:model-value="approvalDrafts[plan.id] = $event"
                  @add-files="addApprovalFiles(plan.id, $event.files, $event.fromClipboard)"
                  @remove-attachment="removeApprovalAttachment(plan.id, $event)"
                  @submit="sendPlanGuidance(plan)"
                  @submit-record-only="sendPlanGuidance(plan, false)"
                />
              </section>
              <div v-if="planFullDetailsLoaded[plan.id] && plan.steps.length" class="knowledge-steps">
                <div class="knowledge-steps-head">
                  <div>
                    <span>{{ t("执行计划") }}</span>
                    <b>{{ plan.steps.length }} {{ t("个步骤") }}</b>
                  </div>
                  <small>{{ completedSteps(plan) }}/{{ plan.steps.length }} {{ t("已完成") }}</small>
                </div>
                <div
                  v-for="(step, index) in plan.steps"
                  :key="step.id"
                  class="knowledge-step"
                  :class="{
                    current: step.id === plan.currentStepId,
                    completed: Boolean(step.completedAt),
                    blocked: stepIsBlocked(plan, step),
                    'has-approval': isApprovalStep(plan, step)
                  }"
                >
                    <div class="knowledge-step-index">{{ index + 1 }}</div>
                    <div class="knowledge-step-copy">
                      <div class="knowledge-step-title-row">
                        <b data-no-i18n>{{ step.title }}</b>
                        <span v-if="step.id === plan.currentStepId">{{ blocker(plan) ? t("当前阻塞") : t("正在执行") }}</span>
                      </div>
                      <details v-if="step.detail && isApprovalStep(plan, step)" class="knowledge-approval-disclosure">
                        <summary>{{ t('步骤说明') }}</summary>
                        <PlanStepDetail class="knowledge-step-detail" :text="step.detail" />
                      </details>
                      <PlanStepDetail v-else-if="step.detail" class="knowledge-step-detail" :text="step.detail" />
                      <small v-if="step.waitingFor" data-no-i18n>等待：{{ step.waitingFor }}</small>
                      <small v-if="stepIsBlocked(plan, step) && step.blockedBy" data-no-i18n>{{ step.blockedBy }}</small>
                      <small v-if="step.id === plan.currentStepId && step.startedAt" class="knowledge-step-time">
                        <span>{{ t("开始时间") }}</span>
                        <b data-no-i18n>{{ formatDate(step.startedAt) }}</b>
                      </small>
                      <small v-else-if="step.completedAt" class="knowledge-step-time">
                        <span>{{ t("完成时间") }}</span>
                        <b data-no-i18n>{{ formatDate(step.completedAt) }}</b>
                      </small>
                    </div>
                    <v-chip
                      v-if="stepIsBlocked(plan, step) || step.id === plan.currentStepId || step.completedAt"
                      :color="stepColor(plan, step)"
                      size="x-small"
                      variant="tonal"
                    >{{ stepIsBlocked(plan, step) ? "已阻塞" : step.completedAt ? "已完成" : "进行中" }}</v-chip>
                    <section v-if="isApprovalStep(plan, step)" class="knowledge-approval-panel" :data-state="plan.presentation.approval.state">
                  <div class="knowledge-approval-head">
                    <div>
                      <span>{{ plan.presentation.approval.label }}</span>
                      <b>{{ t("审批确认") }}</b>
                    </div>
                    <v-chip :color="plan.presentation.approval.state === 'ready' ? 'primary' : 'warning'" size="x-small" variant="tonal">
                      {{ plan.presentation.approval.state === "ready" ? "可审批" : "审批资料不完整 · 禁止审批" }}
                    </v-chip>
                  </div>
                  <v-alert
                    v-if="plan.presentation.approval.missing.length"
                    type="warning"
                    variant="tonal"
                    density="compact"
                    class="knowledge-approval-missing"
                  >
                    <b>审批资料不完整，禁止审批。缺少：</b>
                    <span>{{ plan.presentation.approval.missing.map(approvalMissingLabel).join("、") }}</span>
                    <small>请先由 Agent 在同一计划补齐审批合同；补齐前输入、附件和提交均不可用。</small>
                  </v-alert>
                  <div v-if="plan.presentation.approval.contract" class="knowledge-approval-contract">
                    <div class="knowledge-approval-contract-lead">
                      <span>{{ t("待决定事项") }}</span>
                      <b data-no-i18n>{{ plan.presentation.approval.contract.request || "未填写" }}</b>
                      <span>推荐方案</span>
                      <b data-no-i18n>{{ plan.presentation.approval.contract.recommendation || "未填写" }}</b>

                    </div>

                    <section v-if="plan.attachments.length" class="knowledge-approval-evidence">
                      <h4>{{ t('附件与预览') }} <small>{{ plan.attachments.length }}</small></h4>
              <PlanAttachmentGallery
                :plan="plan"
                :plan-attachment-url="planAttachmentUrl"
                :plan-video-thumbnail-url="planVideoThumbnailUrl"
                :plan-media-load-state="planMediaLoadState"
                :set-plan-media-load-state="setPlanMediaLoadState"
                :capture-plan-video-duration="capturePlanVideoDuration"
                :displayed-plan-video-duration="displayedPlanVideoDuration"
                :plan-markdown-teaser="planMarkdownTeaser"
                :open-plan-media-preview="openPlanMediaPreview"
                :open-plan-markdown-preview="openPlanMarkdownPreview"
                :format-attachment-size="formatAttachmentSize"
              />
                    </section>
                    <details class="knowledge-approval-disclosure">
                      <summary>{{ t('方案依据与备选') }}</summary>
                      <div class="knowledge-approval-disclosure-body">
                      <h4>必要备选</h4>
                      <ul class="knowledge-approval-alternatives">
                        <li v-for="(item, index) in (plan.presentation.approval.contract.alternatives || [])" :key="`alternative-${index}`" data-no-i18n>{{ item }}</li>
                        <li v-if="!(plan.presentation.approval.contract.alternatives || []).length">未填写</li>
                      </ul>
                      <h4>{{ t("方案依据") }}</h4>
                      <small data-no-i18n>{{ plan.presentation.approval.contract.reason || "未填写审批原因" }}</small>
                      </div>
                    </details>
                    <details v-if="plan.presentation.approval.contract.files.length" class="knowledge-approval-disclosure">
                      <summary>{{ t("文件改动") }} <small>{{ plan.presentation.approval.contract.files.length }}</small></summary>
                      <div class="knowledge-approval-disclosure-body">
                      <div v-for="(item, index) in plan.presentation.approval.contract.files" :key="`file-${index}`" class="knowledge-approval-contract-item">
                        <div><v-chip size="x-small" variant="tonal">{{ approvalFileAction(item.action) }}</v-chip><code data-no-i18n>{{ item.path }}</code></div>
                        <p data-no-i18n>{{ item.change }}</p>
                        <small v-if="item.destination" data-no-i18n>目标：{{ item.destination }}</small>
                      </div>
                    </div>
                    </details>
                    <details v-if="plan.presentation.approval.contract.commands.length" class="knowledge-approval-disclosure">
                      <summary>{{ t("执行命令") }} <small>{{ plan.presentation.approval.contract.commands.length }}</small></summary>
                      <div class="knowledge-approval-disclosure-body">
                      <div v-for="(item, index) in plan.presentation.approval.contract.commands" :key="`command-${index}`" class="knowledge-approval-contract-item">
                        <code data-no-i18n>{{ item.command }}</code>
                        <p data-no-i18n>{{ item.purpose }}</p>
                        <small v-if="item.expectedEffect" data-no-i18n>预期影响：{{ item.expectedEffect }}</small>
                      </div>
                    </div>
                    </details>
                    <section v-if="plan.presentation.approval.contract.changes.length" class="knowledge-approval-contract-section knowledge-approval-impact">
                      <h4>{{ t("配置与外部影响") }}</h4>
                      <div v-for="(item, index) in plan.presentation.approval.contract.changes" :key="`change-${index}`" class="knowledge-approval-contract-item">
                        <b data-no-i18n>{{ item.target }}</b>
                        <p data-no-i18n>{{ item.change }}</p>
                        <small v-if="item.impact" data-no-i18n>影响：{{ item.impact }}</small>
                      </div>
                    </section>
                    <details class="knowledge-approval-disclosure">
                      <summary>{{ t('验收、回退与范围') }}</summary>
                    <div class="knowledge-approval-contract-grid">
                      <section>
                        <h4>批准后如何验证</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.validation" :key="`validation-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                      <section>
                        <h4>失败时如何回退</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.rollback" :key="`rollback-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                      <section>
                        <h4>明确不在本次范围</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.outOfScope" :key="`scope-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                    </div>
                    </details>

                    <details class="knowledge-approval-disclosure">
                      <summary>{{ t("审批请求与回执") }}</summary>
                      <div class="knowledge-approval-disclosure-body">
                        <span>审批人 / 责任人</span>
                        <p data-no-i18n>{{ plan.presentation.approval.contract.approver || "未填写" }}</p>
                      <div class="knowledge-approval-contract-item">
                        <b>最近请求时间</b>
                        <p data-no-i18n>{{ plan.presentation.approval.contract.requestedAt ? formatDate(plan.presentation.approval.contract.requestedAt) : "未填写" }}</p>
                        <b>来源消息 / Feedback</b>
                        <p data-no-i18n>{{ plan.presentation.approval.contract.sourceMessageId || plan.presentation.approval.contract.feedbackId || "未填写" }}</p>
                        <b>当前回执状态</b>
                        <p>{{ approvalResponseStatusLabel(plan.presentation.approval.contract.responseStatus) }}</p>
                        <small v-if="plan.approval.latest" data-no-i18n>最近记录：{{ plan.approval.latest.id }} · {{ plan.approval.latest.deliveryStatus }} · {{ formatDate(plan.approval.latest.updatedAt) }}</small>
                      </div>
                    </div>
                    </details>
                  </div>
                  <details v-if="approvalRecordsForDisplay(plan).length" class="knowledge-approval-disclosure">
                    <summary>{{ t('审批意见记录') }} <small>{{ approvalRecordsForDisplay(plan).length }}</small></summary>
                  <div v-if="approvalRecordsForDisplay(plan).length" class="knowledge-approval-history" :aria-label="t('审批意见记录')">
                    <article
                      v-for="feedback in approvalRecordsForDisplay(plan)"
                      :key="feedback.id"
                      class="knowledge-approval-record"
                      :data-author="feedback.author"
                    >
                      <span>{{ feedbackRecordLabel(feedback) }} · <time data-no-i18n>{{ formatDate(feedback.createdAt) }}</time></span>
                      <b data-no-i18n>{{ feedback.text }}</b>
                      <div v-if="(feedback.attachments || []).length" class="knowledge-approval-record-attachments">
                        <v-chip
                          v-for="attachment in feedback.attachments"
                          :key="`${feedback.id}-${attachment.sha256}`"
                          prepend-icon="mdi-paperclip"
                          size="x-small"
                          variant="tonal"
                          data-no-i18n
                        >
                          {{ attachment.name }} · {{ formatAttachmentSize(attachment.size) }}
                        </v-chip>
                      </div>
                      <div v-if="(feedback.planAttachments || []).length" class="knowledge-approval-record-attachments">
                        <v-chip
                          v-for="attachment in feedback.planAttachments"
                          :key="`${feedback.id}-plan-${attachment.id}`"
                          prepend-icon="mdi-at"
                          size="x-small"
                          variant="tonal"
                          color="primary"
                          data-no-i18n
                        >
                          {{ attachment.name }} · {{ formatAttachmentSize(attachment.size) }}
                        </v-chip>
                      </div>
                    </article>
                  </div>
                  </details>
                  <div
                    v-if="approvalComposeStatus(plan)"
                    class="knowledge-approval-compose-status"
                    :data-tone="approvalComposeStatus(plan)?.tone"
                    role="status"
                  >
                    <span class="knowledge-approval-compose-status-icon">
                      <v-icon size="18">{{ approvalComposeStatus(plan)?.icon }}</v-icon>
                    </span>
                    <span class="knowledge-approval-compose-status-copy">
                      <b>{{ approvalComposeStatus(plan)?.title }}</b>
                      <span>{{ approvalComposeStatus(plan)?.text }}</span>
                    </span>
                  </div>
                  <PlanQuestionFields
                    v-if="feedbackQuestions(plan).length"
                    :questions="feedbackQuestions(plan)" :answers="questionAnswers(plan)" :form-id="`approval-${plan.id}`"
                    :plan-attachments="plan.attachments" :attachment-url="(id) => planAttachmentUrl(plan.id, id)"
                    :submit-disabled="!canSubmitApproval(plan, false)"
                    @add-files="addApprovalFiles(plan.id, $event.files, $event.fromClipboard)"
                    @submit="sendApprovalSuggestion(plan, false)"
                    :disabled="!canEditApprovalFeedback(plan) || Boolean(approvalDeliveryPending[plan.id])"
                    @change="(id, answer) => updateQuestionAnswer(plan, id, answer)"
                  />
                  <PlanFeedbackComposer
                    :composer-id="`approval-${plan.id}`"
                    :footer-only="Boolean(feedbackQuestions(plan).length)"
                    :model-value="approvalDrafts[plan.id] || ''"
                    :plan-attachments="plan.attachments"
                    :attachments="approvalAttachmentsFor(plan.id)"
                    :attachment-url="(attachmentId) => planAttachmentUrl(plan.id, attachmentId)"
                    :label="approvalFeedbackLabel(plan)"
                    :placeholder="approvalFeedbackPlaceholder(plan)"
                    :hint="approvalFeedbackHint(plan)"
                    :disabled="!canEditApprovalFeedback(plan)"
                    :submit-disabled="!canSubmitApproval(plan)"
                    :pending="Boolean(approvalPending[plan.id])"
                    :notice="approvalNotices[plan.id]"
                    :submit-label="t('提交并投递')"
                    :submit-record-only-label="t('提交')"
                    :record-only-disabled="!canSubmitApproval(plan, false)"
                    submit-icon="mdi-send-check-outline"
                    footer-text="提交仅保存；提交并投递会通知 Agent。"
                    @update:model-value="approvalDrafts[plan.id] = $event"
                    @add-files="addApprovalFiles(plan.id, $event.files, $event.fromClipboard)"
                    @remove-attachment="removeApprovalAttachment(plan.id, $event)"
                    @submit="sendApprovalSuggestion(plan, true)"
                    @submit-record-only="sendApprovalSuggestion(plan, false)"
                  />
                    </section>
                </div>
                <section class="knowledge-work-history" :data-expanded="Boolean(planWorkHistoryExpanded[plan.id])">
                  <button
                    class="knowledge-work-history-toggle"
                    type="button"
                    :aria-expanded="Boolean(planWorkHistoryExpanded[plan.id])"
                    :aria-controls="`plan-work-history-${plan.id}`"
                    @click="togglePlanWorkHistory(plan)"
                  >
                    <span>
                      <v-icon size="18">mdi-history</v-icon>
                      <b>{{ t("工作留痕") }}</b>
                      <small>
                        {{ plan.approval.count }} {{ t("条反馈") }}
                        <template v-if="planHistoryRecords[plan.id]"> · {{ planHistoryRecords[plan.id].length }} {{ t("次计划记录") }}</template>
                      </small>
                    </span>
                    <v-icon size="18">{{ planWorkHistoryExpanded[plan.id] ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
                  </button>
                  <div v-if="planWorkHistoryExpanded[plan.id]" :id="`plan-work-history-${plan.id}`" class="knowledge-work-history-body">
                    <p>{{ t("这里保留整个计划的引导、审批意见、Agent 回复和计划版本；计划完成或归档后仍可查看。") }}</p>
                    <div class="knowledge-work-history-groups">
                      <section class="knowledge-work-history-group">
                        <h4>{{ t("计划引导记录") }}</h4>
                        <div v-if="guidanceRecordsForDisplay(plan).length" class="knowledge-approval-history">
                          <article
                            v-for="feedback in guidanceRecordsForDisplay(plan)"
                            :key="`work-guidance-${feedback.id}`"
                            class="knowledge-approval-record"
                            :data-author="feedback.author"
                          >
                            <span>{{ feedbackRecordLabel(feedback) }} · <time data-no-i18n>{{ formatDate(feedback.createdAt) }}</time></span>
                            <b data-no-i18n>{{ feedback.text }}</b>
                            <small data-no-i18n>{{ feedback.deliveryStatus }}</small>
                          </article>
                        </div>
                        <p v-else>{{ t("还没有计划引导记录。") }}</p>
                      </section>
                      <section class="knowledge-work-history-group">
                        <h4>{{ t("审批意见记录") }}</h4>
                        <div v-if="approvalRecordsForDisplay(plan).length" class="knowledge-approval-history">
                          <article
                            v-for="feedback in approvalRecordsForDisplay(plan)"
                            :key="`work-approval-${feedback.id}`"
                            class="knowledge-approval-record"
                            :data-author="feedback.author"
                          >
                            <span>{{ feedbackRecordLabel(feedback) }} · <time data-no-i18n>{{ formatDate(feedback.createdAt) }}</time></span>
                            <b data-no-i18n>{{ feedback.text }}</b>
                            <small v-if="feedback.stepTitle || feedback.stepId" data-no-i18n>{{ feedback.stepTitle || feedback.stepId }}</small>
                            <small data-no-i18n>{{ feedback.deliveryStatus }}</small>
                          </article>
                        </div>
                        <p v-else>{{ t("还没有审批意见记录。") }}</p>
                      </section>
                    </div>
                    <section class="knowledge-work-history-group knowledge-current-approval-history">
                      <h4>{{ t("步骤审批合同") }}</h4>
                      <p>{{ t("当前计划中的审批合同会保留在对应步骤；计划完成后仍可在这里查看。") }}</p>
                      <div v-if="planApprovalContractsForHistory(plan).length" class="knowledge-plan-history-records">
                        <details v-for="step in planApprovalContractsForHistory(plan)" :key="`current-contract-${step.id}`" class="knowledge-plan-history-record">
                          <summary>
                            <span>{{ step.title }}</span>
                            <span>{{ approvalResponseStatusLabel(step.approvalRequest?.responseStatus) }}</span>
                          </summary>
                          <section class="knowledge-plan-history-approval">
                            <p><b>{{ t("审批请求") }}：</b><span data-no-i18n>{{ step.approvalRequest?.request }}</span></p>
                            <p><b>{{ t("推荐方案") }}：</b><span data-no-i18n>{{ step.approvalRequest?.recommendation || t("未填写") }}</span></p>
                            <p><b>{{ t("审批原因") }}：</b><span data-no-i18n>{{ step.approvalRequest?.reason }}</span></p>
                            <p><b>{{ t("审批回执") }}：</b><span>{{ approvalResponseStatusLabel(step.approvalRequest?.responseStatus) }}</span></p>
                            <div class="knowledge-plan-history-contract-lists">
                              <div v-if="step.approvalRequest?.validation.length"><b>{{ t("验证方式") }}</b><ul><li v-for="item in step.approvalRequest?.validation || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                              <div v-if="step.approvalRequest?.rollback.length"><b>{{ t("回退方案") }}</b><ul><li v-for="item in step.approvalRequest?.rollback || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                              <div v-if="step.approvalRequest?.outOfScope.length"><b>{{ t("范围外内容") }}</b><ul><li v-for="item in step.approvalRequest?.outOfScope || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                            </div>
                          </section>
                        </details>
                      </div>
                      <p v-else>{{ t("当前计划没有步骤审批合同。") }}</p>
                    </section>
                    <section class="knowledge-work-history-group knowledge-plan-version-history">
                      <h4>{{ t("计划版本记录") }}</h4>
                      <div v-if="planHistoryLoading[plan.id]" class="knowledge-plan-history-loading" role="status">
                        <v-progress-circular indeterminate size="16" width="2" color="primary" />
                        <span>{{ t("正在读取工作留痕…") }}</span>
                      </div>
                      <div v-else-if="planHistoryRecords[plan.id]?.length" class="knowledge-plan-history-records">
                        <details v-for="record in planHistoryRecords[plan.id]" :key="record.id" class="knowledge-plan-history-record">
                          <summary>
                            <span>{{ planHistoryLabel(record) }}</span>
                            <time data-no-i18n>{{ formatDate(record.recordedAt) }}</time>
                          </summary>
                          <div class="knowledge-plan-history-summary">
                            <span>{{ t("计划状态") }}：{{ record.after.status }}</span>
                            <span v-if="planHistoryCurrentStep(record)">{{ t("当前步骤") }}：{{ planHistoryCurrentStep(record)?.title }}</span>
                            <span v-if="record.before">{{ t("变更前") }}：{{ record.before.status }}</span>
                          </div>
                          <section
                            v-for="step in planHistoryApprovalSteps(record)"
                            :key="`${record.id}-${step.id}`"
                            class="knowledge-plan-history-approval"
                          >
                            <h5>{{ step.title }}</h5>
                            <p><b>{{ t("审批请求") }}：</b><span data-no-i18n>{{ step.approvalRequest?.request }}</span></p>
                            <p><b>{{ t("推荐方案") }}：</b><span data-no-i18n>{{ step.approvalRequest?.recommendation || t("未填写") }}</span></p>
                            <p><b>{{ t("审批原因") }}：</b><span data-no-i18n>{{ step.approvalRequest?.reason }}</span></p>
                            <p><b>{{ t("审批回执") }}：</b><span>{{ approvalResponseStatusLabel(step.approvalRequest?.responseStatus) }}</span></p>
                            <div v-if="step.approvalRequest?.files.length || step.approvalRequest?.commands.length || step.approvalRequest?.changes.length" class="knowledge-plan-history-actions">
                              <b>{{ t("涉及改动") }}</b>
                              <ul>
                                <li v-for="file in step.approvalRequest?.files || []" :key="`${file.action}-${file.path}`" data-no-i18n>{{ approvalFileAction(file.action) }} · {{ file.path }} · {{ file.change }}</li>
                                <li v-for="command in step.approvalRequest?.commands || []" :key="command.command" data-no-i18n>{{ command.command }} · {{ command.purpose }}</li>
                                <li v-for="change in step.approvalRequest?.changes || []" :key="change.target" data-no-i18n>{{ change.target }} · {{ change.change }}</li>
                              </ul>
                            </div>
                            <div class="knowledge-plan-history-contract-lists">
                              <div v-if="step.approvalRequest?.validation.length"><b>{{ t("验证方式") }}</b><ul><li v-for="item in step.approvalRequest?.validation || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                              <div v-if="step.approvalRequest?.rollback.length"><b>{{ t("回退方案") }}</b><ul><li v-for="item in step.approvalRequest?.rollback || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                              <div v-if="step.approvalRequest?.outOfScope.length"><b>{{ t("范围外内容") }}</b><ul><li v-for="item in step.approvalRequest?.outOfScope || []" :key="item" data-no-i18n>{{ item }}</li></ul></div>
                            </div>
                          </section>
                        </details>
                      </div>
                      <p v-else>{{ t("当前计划没有可读取的版本记录。") }}</p>
                    </section>
                  </div>
                </section>
              </div>
            </div>
              </div>
            </article>
        </div>

        <div
          v-if="hasMorePlans || hasMoreRenderedPlans"
          ref="planLoadMoreSentinel"
          class="knowledge-load-more"
          aria-live="polite"
        >
          <v-progress-circular v-if="loadingMorePlans" indeterminate size="20" width="2" color="primary" />
          <span>{{ t(hasMoreRenderedPlans ? "继续向下滚动加载更多计划卡片" : "正在持续加载更多计划…") }}</span>
          <v-btn v-if="!loadingMorePlans" size="small" variant="text" @click="hasMoreRenderedPlans ? loadMoreRenderedPlans() : loadMorePlans()">{{ t("加载更多") }}</v-btn>
        </div>

        <div v-if="!loading && !loadingMorePlans && !hasMorePlans && !visiblePlansForView.length" class="knowledge-empty">
          <v-icon size="32">mdi-clipboard-text-off-outline</v-icon>
          <b>没有匹配的计划</b>
          <span>{{ planListHasFilters ? t("可以调整筛选条件，恢复其它计划。") : activeView === "archived" ? t("当前没有匹配的已归档计划。") : t("可以清空搜索，或等待 Agent 通过 Manager 写入计划。") }}</span>
        </div>
      </div>

      <div v-if="roleId && showsMemoryList" class="knowledge-memory-grid">
        <div v-if="activeView === 'archived'" class="knowledge-subsection-heading knowledge-memory-heading">
          <v-icon size="20">mdi-archive-outline</v-icon>
          <b>{{ t("已归档记忆") }}</b>
        </div>
        <div v-if="activeView === 'recent_memory' && recentMemoryConsolidationNotice" class="knowledge-memory-consolidation-panel">
          <div class="knowledge-memory-consolidation-icon">
            <v-icon size="22">mdi-timer-sand</v-icon>
          </div>
          <div>
            <small>{{ t("近期记忆沉淀") }}</small>
            <b>{{ recentMemoryConsolidationNotice }}</b>
            <strong v-if="nextMemoryConsolidationTriggerMemory">
              {{ t("最不活跃记忆") }}：<span data-no-i18n>{{ nextMemoryConsolidationTriggerMemory.title }}</span>
            </strong>
            <em>{{ isEnglish ? `${memoryIdsEnteringNextConsolidation.size} memories will enter this consolidation` : `预计 ${memoryIdsEnteringNextConsolidation.size} 条记忆进入本次沉淀` }}</em>
          </div>
          <span>{{ t("24 / 72 小时规则") }}</span>
        </div>
        <article
          v-for="memory in renderedMemoryForView"
          :key="memory.id"
          class="knowledge-memory-card"
          :class="{ 'will-consolidate': memoryIdsEnteringNextConsolidation.has(memory.id) }"
        >
          <div class="knowledge-memory-icon">
            <v-icon>{{ activeView === "consolidated_memory" ? "mdi-bookshelf" : activeView === "archived" ? "mdi-archive-outline" : "mdi-memory" }}</v-icon>
          </div>
          <div class="knowledge-memory-copy">
            <div class="knowledge-memory-head">
              <div>
                <div class="knowledge-memory-kicker-row">
                  <div class="knowledge-kicker">{{ activeView === "consolidated_memory" ? "CONSOLIDATED" : activeView === "archived" ? "ARCHIVED" : "RECENT" }}</div>
                  <span v-if="memoryIdsEnteringNextConsolidation.has(memory.id)">{{ t("将进入本次沉淀") }}</span>
                </div>
                <h2 data-no-i18n>{{ memory.title }}</h2>
              </div>
              <div class="knowledge-memory-times">
                <span>
                  <small>{{ t("记录时间") }}</small>
                  <time data-no-i18n :datetime="memory.createdAt">{{ formatDate(memory.createdAt) }}</time>
                </span>
                <span v-if="activeView === 'archived'">
                  <small>{{ t("归档时间") }}</small>
                  <time v-if="memory.consolidatedAt" data-no-i18n :datetime="memory.consolidatedAt">{{ formatDate(memory.consolidatedAt) }}</time>
                  <b v-else>—</b>
                </span>
                <span v-else>
                  <small>{{ t("上次命中召回") }}</small>
                  <time v-if="memory.recalledAt" data-no-i18n :datetime="memory.recalledAt">{{ formatDate(memory.recalledAt) }}</time>
                  <b v-else>{{ t("尚未命中召回") }}</b>
                </span>
              </div>
            </div>
            <div class="knowledge-memory-body">
              <div class="knowledge-memory-markdown" data-no-i18n v-html="renderMemoryMarkdownPreview(memory.content)"></div>
              <div v-if="memory.source?.summary" class="knowledge-source" data-no-i18n>{{ memory.source.summary }}</div>
              <div v-if="memory.keywords.length" class="knowledge-keywords">
                <v-chip v-for="keyword in memory.keywords" :key="keyword" data-no-i18n size="x-small" variant="outlined">{{ keyword }}</v-chip>
              </div>
            </div>
            <div class="knowledge-memory-actions">
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-book-open-page-variant-outline"
                @click="openMemoryDetail(memory)"
              >{{ t("查看详情") }}</v-btn>
            </div>
          </div>
        </article>

        <div
          v-if="hasMoreMemory || hasMoreRenderedMemory"
          ref="memoryLoadMoreSentinel"
          class="knowledge-load-more memory"
          aria-live="polite"
        >
          <span>{{ t(hasMoreRenderedMemory ? "继续向下滚动加载更多记忆" : "正在持续加载更多记忆…") }}</span>
          <v-btn size="small" variant="text" @click="hasMoreRenderedMemory ? loadMoreRenderedMemory() : loadMoreMemory()">{{ t("加载更多") }}</v-btn>
        </div>

        <div
          v-if="!memoryLoading && !visibleMemoryForView.length"
          class="knowledge-empty"
        >
          <v-icon size="32">mdi-book-open-blank-variant-outline</v-icon>
          <b>没有匹配的记忆</b>
          <span>当前视图只展示 Manager 返回的只读人格记忆。</span>
        </div>
      </div>
      </v-card>
    </div>

    <v-dialog
      :model-value="Boolean(memoryDetailPreview)"
      max-width="min(820px, 94vw)"
      @update:model-value="(open) => { if (!open) closeMemoryDetail(); }"
    >
      <v-card v-if="memoryDetailPreview" class="knowledge-memory-detail" variant="flat">
        <div class="knowledge-memory-detail-head">
          <div>
            <span>{{ t(memoryDetailPreview.kind === "consolidated" ? "沉淀记忆" : memoryDetailPreview.kind === "archived" ? "已归档记忆" : "近期记忆") }}</span>
            <b data-no-i18n>{{ memoryDetailPreview.memory.title }}</b>
          </div>
          <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭预览')" @click="closeMemoryDetail" />
        </div>
        <div class="knowledge-memory-detail-times">
          <span>
            <small>{{ t("记录时间") }}</small>
            <time data-no-i18n :datetime="memoryDetailPreview.memory.createdAt">{{ formatDate(memoryDetailPreview.memory.createdAt) }}</time>
          </span>
          <span v-if="memoryDetailPreview.kind === 'archived'">
            <small>{{ t("归档时间") }}</small>
            <time
              v-if="memoryDetailPreview.memory.consolidatedAt"
              data-no-i18n
              :datetime="memoryDetailPreview.memory.consolidatedAt"
            >{{ formatDate(memoryDetailPreview.memory.consolidatedAt) }}</time>
            <b v-else>—</b>
          </span>
          <span v-else>
            <small>{{ t("上次命中召回") }}</small>
            <time
              v-if="memoryDetailPreview.memory.recalledAt"
              data-no-i18n
              :datetime="memoryDetailPreview.memory.recalledAt"
            >{{ formatDate(memoryDetailPreview.memory.recalledAt) }}</time>
            <b v-else>{{ t("尚未命中召回") }}</b>
          </span>
        </div>
        <div class="knowledge-memory-detail-body">
          <div class="knowledge-memory-markdown" data-no-i18n v-html="renderMemoryMarkdownPreview(memoryDetailPreview.memory.content)"></div>
          <div v-if="memoryDetailPreview.memory.source?.summary" class="knowledge-source" data-no-i18n>{{ memoryDetailPreview.memory.source.summary }}</div>
          <div v-if="memoryDetailPreview.memory.keywords.length" class="knowledge-keywords">
            <v-chip
              v-for="keyword in memoryDetailPreview.memory.keywords"
              :key="keyword"
              data-no-i18n
              size="small"
              variant="outlined"
            >{{ keyword }}</v-chip>
          </div>
        </div>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="Boolean(planAttachmentPreview)"
      max-width="min(1120px, 94vw)"
      @update:model-value="(open) => { if (!open) closePlanMediaPreview(); }"
    >
      <v-card class="knowledge-plan-media-preview" variant="flat">
        <div class="knowledge-plan-media-preview-head">
          <div>
            <span>{{ t(planAttachmentPreview?.kind === "video" ? "视频预览" : "图片预览") }}</span>
            <b v-if="planAttachmentPreview" data-no-i18n>{{ planAttachmentPreview.name }}</b>
          </div>
          <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭预览')" @click="closePlanMediaPreview" />
        </div>
        <div class="knowledge-plan-media-preview-stage">
          <video
            v-if="planAttachmentPreview?.kind === 'video'"
            :src="planAttachmentPreview.url"
            :aria-label="planAttachmentPreview.name"
            controls
            playsinline
            preload="metadata"
            data-no-i18n
          ></video>
          <img
            v-else-if="planAttachmentPreview"
            :src="planAttachmentPreview.url"
            :alt="planAttachmentPreview.name"
            data-no-i18n
          >
        </div>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="Boolean(planMarkdownPreview)"
      max-width="min(1040px, 94vw)"
      @update:model-value="(open) => { if (!open) closePlanMarkdownPreview(); }"
    >
      <v-card class="knowledge-plan-media-preview knowledge-plan-markdown-preview" variant="flat">
        <div class="knowledge-plan-media-preview-head">
          <div>
            <span>{{ t("Markdown 预览") }}</span>
            <b v-if="planMarkdownPreview" data-no-i18n>{{ planMarkdownPreview.name }}</b>
          </div>
          <div class="knowledge-plan-preview-actions">
            <v-btn
              v-if="planMarkdownPreview"
              :href="planMarkdownPreview.url"
              :download="planMarkdownPreview.name"
              target="_blank"
              rel="noopener noreferrer"
              prepend-icon="mdi-download-outline"
              variant="text"
              size="small"
            >{{ t("下载原文件") }}</v-btn>
            <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭预览')" @click="closePlanMarkdownPreview" />
          </div>
        </div>
        <div class="knowledge-plan-markdown-preview-stage">
          <div v-if="planMarkdownPreview?.loading" class="knowledge-plan-markdown-loading">
            <v-progress-circular indeterminate color="primary" size="26" width="3" />
            <span>{{ t("正在加载 Markdown…") }}</span>
          </div>
          <v-alert
            v-else-if="planMarkdownPreview?.error"
            type="warning"
            variant="tonal"
            class="knowledge-plan-markdown-error"
            data-no-i18n
          >{{ planMarkdownPreview.error }}</v-alert>
          <article
            v-else-if="planMarkdownPreview"
            class="knowledge-plan-markdown-document"
            data-no-i18n
            v-html="planMarkdownPreview.html"
          ></article>
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>
