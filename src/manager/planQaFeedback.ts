import type { PlanFeedbackRecord, PlanQaFeedbackHandling } from "../planFeedback.js";
import { planStepIsCompleted, type PlanItem, type PlanStep } from "../roleKnowledge.js";
import { roleStorageOperationKey } from "./roleStorageApplication.js";
import { planTaskDeliveryTarget } from "./planTaskBindingDelivery.js";
import { planStatusKeyForRole, type PersonaPlanWorkflow } from "../personaPlanWorkflow.js";

export type PlanQaTaskRequest = {
  agentAdapter: "codex" | "dsh";
  threadId: string;
  title: string;
  cwd: string;
  createIfMissing: true;
  deliveryId: string;
  prompt: string;
};

export type PlanQaTaskDeliveryReadRequest = {
  threadId: string;
  cwd: string;
  deliveryId: string;
};

export type PlanQaStorageProjection = Readonly<{
  plan: PlanItem;
  planRevision: string;
  records: PlanFeedbackRecord[];
  recordRevisions: Readonly<Record<string, string | null>>;
}>;

export type PlanQaMutationContext = Readonly<{
  idempotencyKey: string;
  expectedRevision: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type PlanQaStoragePort = Readonly<{
  query: (
    roleId: string,
    planId: string,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
  ) => Promise<PlanQaStorageProjection | null>;
  updatePlan: (
    roleId: string,
    planId: string,
    patch: Record<string, unknown>,
    context: PlanQaMutationContext
  ) => Promise<Readonly<{ plan: PlanItem; revision: string }>>;
  updateQaHandling: (
    roleId: string,
    planId: string,
    record: PlanFeedbackRecord,
    qaHandling: PlanQaFeedbackHandling,
    context: PlanQaMutationContext
  ) => Promise<PlanQaStorageProjection>;
}>;

export type ConsumePlanQaFeedbackOptions = {
  roleId: string;
  workflow: PersonaPlanWorkflow;
  storage: PlanQaStoragePort;
  feedback: PlanFeedbackRecord;
  signal?: AbortSignal;
  sendToTask: (request: PlanQaTaskRequest) => Promise<void>;
  readTaskDelivery?: (
    request: PlanQaTaskDeliveryReadRequest
  ) => Promise<"accepted" | "in_progress" | "missing">;
};

export type PlanQaFeedbackResult = {
  outcome: "ignored" | "failed" | "passed";
  status: "ignored" | PlanQaFeedbackHandling["status"];
  missingEvidence: string[];
  plan?: PlanItem;
};

const QA_FAILURE_PATTERN = /问题仍存在|仍然存在|未解决|失败复现|仍可复现|依旧存在|没有修复|未通过|验收失败|QA\s+failed|not\s+fixed|still\s+(?:exists|reproducible)|reproduced\s+again/i;
const QA_PASS_PATTERN = /QA\s*明确通过|QA\s*通过|QA\s+(?:passed|verified)|验收通过|问题已解决|确认未再复现|acceptance\s+passed/i;
const QA_STEP_ID = /^(?:qa|verify)(?:[-_:].*)?$/i;

function isQaVerdictFeedback(feedback: PlanFeedbackRecord): boolean {
  return feedback.kind === "approval_suggestion"
    && feedback.deliveryStatus !== "record_only"
    && feedback.author === "user"
    && feedback.source !== "agent";
}

function isQaStep(step: PlanStep | undefined): step is PlanStep {
  return Boolean(step && QA_STEP_ID.test(String(step.id || "")));
}

function qaStepFor(plan: PlanItem, feedback: PlanFeedbackRecord, allowHistorical = false): PlanStep | undefined {
  const requested = feedback.stepId
    ? plan.steps.find((step) => step.id === feedback.stepId)
    : undefined;
  if (isQaStep(requested) && (
    allowHistorical
    || requested.id === plan.currentStepId
  )) return requested;
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  return isQaStep(current) ? current : undefined;
}

function issueType(feedback: PlanFeedbackRecord, plan: PlanItem): PlanQaFeedbackHandling["issueType"] {
  const text = [
    plan.title,
    plan.focus,
    plan.currentStep,
    feedback.stepTitle,
    feedback.text
  ].filter(Boolean).join(" ");
  if (/账号|玩家|用户|角色|存档|订单|付费/i.test(text)) return "account";
  if (/崩溃|闪退|报错|crash|exception|fatal/i.test(text)) return "crash";
  if (/版本|渠道|包体|客户端|安卓|android|ios|taptap|build/i.test(text)) return "version";
  if (/时间|重置|刷新|结算|延迟|不到账|未到账|定时|北京时间/i.test(text)) return "timing";
  if (/界面|显示|UI|图标|红点|文案|布局|动画|视觉/i.test(text)) return "visual";
  return "generic";
}

function hasReproductionSteps(text: string): boolean {
  return /复现步骤|操作步骤|步骤[:：]|repro(?:duction)?\s+steps?/i.test(text);
}

function hasBeforeAfterState(text: string): boolean {
  const hasBefore = /修复前|操作前|前状态|原状态|之前|before/i.test(text);
  const hasAfter = /修复后|操作后|后状态|当前|实际|现在|after|actual|observed/i.test(text);
  return (hasBefore && hasAfter) || (/预期|期望|expected/i.test(text) && hasAfter);
}

function hasAccountId(text: string): boolean {
  return /(?:账号|玩家|用户|角色)(?:\s*(?:ID|编号|id))\s*[:：#]?\s*[A-Za-z0-9_-]{3,}/i.test(text);
}

function hasBeijingTime(text: string): boolean {
  return /北京时间|20\d{2}[-/年]\d{1,2}|\d{1,2}[:：]\d{2}/i.test(text);
}

function hasVersionChannel(text: string): boolean {
  return /\b\d+\.\d+(?:\.\d+)+\b|(?:版本|渠道|build)\s*[:：#]?\s*[A-Za-z0-9._-]{2,}|TapTap|App\s*Store|Google\s*Play/i.test(text);
}

function hasScreenshotOrVideo(feedback: PlanFeedbackRecord): boolean {
  return feedback.attachments.some((attachment) => attachment.kind === "image"
    || /\.(?:mp4|m4v|webm|mov|avi)$/i.test(attachment.name));
}

function hasLogs(feedback: PlanFeedbackRecord): boolean {
  return feedback.attachments.some((attachment) => /\.(?:log|txt|json|zip|7z)$/i.test(attachment.name));
}

function missingEvidenceFor(
  feedback: PlanFeedbackRecord,
  type: PlanQaFeedbackHandling["issueType"]
): string[] {
  const text = feedback.text;
  if (type === "account") {
    return [
      !hasAccountId(text) ? "账号或玩家编号" : "",
      !hasBeijingTime(text) ? "北京时间" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "version") {
    return [
      !hasVersionChannel(text) ? "版本渠道" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "timing") {
    return [
      !hasBeijingTime(text) ? "北京时间" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "visual") {
    return [
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasScreenshotOrVideo(feedback) ? "截图或视频" : ""
    ].filter(Boolean);
  }
  if (type === "crash") {
    return [
      !hasVersionChannel(text) ? "版本渠道" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasLogs(feedback) ? "日志" : ""
    ].filter(Boolean);
  }
  return [
    !hasReproductionSteps(text) ? "复现步骤" : "",
    !hasBeforeAfterState(text) ? "前后状态或实际/预期结果" : ""
  ].filter(Boolean);
}

function investigationStepId(qaStep: PlanStep): string {
  return "investigate-" + qaStep.id;
}

function feedbackDetail(feedback: PlanFeedbackRecord): string {
  const prefix = "QA 失败反馈 " + feedback.id + "：";
  const limit = Math.max(0, 600 - prefix.length);
  const content = feedback.text.length > limit ? feedback.text.slice(0, Math.max(0, limit - 1)) + "…" : feedback.text;
  return prefix + content;
}

function reopenForInvestigation(
  plan: PlanItem,
  qaStep: PlanStep,
  feedback: PlanFeedbackRecord,
  missingEvidence: string[],
  workflow: PersonaPlanWorkflow
): Record<string, unknown> {
  const investigateId = investigationStepId(qaStep);
  const existingInvestigation = plan.steps.find((step) => step.id === investigateId);
  const investigation: PlanStep = {
    ...(existingInvestigation || {
      id: investigateId,
      title: "深化调查：" + qaStep.title
    }),
    completedAt: undefined,
    detail: feedbackDetail(feedback),
    waitingFor: missingEvidence.length ? "QA 补充：" + missingEvidence.join("、") : undefined,
    isBlocked: false,
    blockedBy: undefined
  };
  const steps = plan.steps
    .filter((step) => step.id !== investigateId)
    .map((step) => step.id === qaStep.id
      ? { ...step, startedAt: null, completedAt: null, waitingFor: undefined, isBlocked: false, blockedBy: undefined }
      : step);
  const qaIndex = steps.findIndex((step) => step.id === qaStep.id);
  steps.splice(qaIndex < 0 ? steps.length : qaIndex, 0, investigation);
  return {
    status: planStatusKeyForRole(workflow, "analysis"),
    currentStepId: investigateId,
    currentStep: "QA 失败回传已消费，进入深化根因调查",
    nextAction: missingEvidence.length
      ? "取得" + missingEvidence.join("、") + "后继续深化调查并安排复测"
      : "原业务任务根据新证据深化根因分析、修正并重新安排 QA",
    waitingFor: missingEvidence.length ? "QA 补充：" + missingEvidence.join("、") : null,
    isBlocked: false,
    blockedBy: null,
    completedAt: null,
    steps
  };
}

function taskPrompt(plan: PlanItem, feedback: PlanFeedbackRecord): string {
  return [
    "[QA失败回传：继续原业务任务]",
    "计划：" + plan.title,
    "计划 ID：" + plan.id,
    "反馈 ID：" + feedback.id,
    "QA 反馈：" + feedback.text,
    "请基于这份新证据深化根因分析，完成最小修正与针对性验证后重新进入 QA。",
    "必须复用当前计划与原 taskBinding；绑定任务已归档时创建替代任务并更新同一 taskBinding，不得创建重复计划或重复业务任务。",
    "只有 QA 明确通过后才可进入验收完成。"
  ].join("\n");
}

function completeAcceptance(
  plan: PlanItem,
  qaStep: PlanStep,
  feedback: PlanFeedbackRecord,
  workflow: PersonaPlanWorkflow
): Record<string, unknown> {
  const completedAt = new Date().toISOString();
  const steps = plan.steps.map((step) => step.id === qaStep.id
    ? {
        ...step,
        completedAt,
        startedAt: step.startedAt || completedAt,
        detail: "QA 明确通过（" + feedback.id + "）：" + feedback.text.slice(0, 500),
        waitingFor: undefined,
        isBlocked: false,
        blockedBy: undefined
      }
    : step);
  const qaIndex = steps.findIndex((step) => step.id === qaStep.id);
  const nextIndex = steps.findIndex((step, index) => index > qaIndex && !planStepIsCompleted(step));
  if (nextIndex >= 0) {
    return {
      status: planStatusKeyForRole(workflow, "execution"),
      currentStepId: steps[nextIndex].id,
      currentStep: steps[nextIndex].title,
      nextAction: steps[nextIndex].title,
      waitingFor: null,
      isBlocked: false,
      blockedBy: null,
      steps
    };
  }
  return {
    status: planStatusKeyForRole(workflow, "completed"),
    currentStepId: null,
    currentStep: "QA 明确通过，验收完成",
    nextAction: null,
    waitingFor: null,
    isBlocked: false,
    blockedBy: null,
    steps
  };
}

function requiredFeedback(
  projection: PlanQaStorageProjection,
  feedbackId: string
): Readonly<{ record: PlanFeedbackRecord; revision: string }> {
  const record = projection.records.find((candidate) => candidate.id === feedbackId);
  if (!record) throw new Error(`Plan feedback not found in the authoritative storage projection: ${feedbackId}`);
  const revision = projection.recordRevisions[feedbackId];
  if (!revision) throw new Error(`Plan feedback revision is unavailable: ${feedbackId}`);
  return { record, revision };
}

function mutationContext(
  operation: string,
  roleId: string,
  resourceId: string,
  expectedRevision: string,
  payload: unknown,
  signal?: AbortSignal
): PlanQaMutationContext {
  return {
    idempotencyKey: roleStorageOperationKey(
      operation,
      roleId,
      resourceId,
      expectedRevision,
      JSON.stringify(payload) ?? "null"
    ),
    expectedRevision,
    signal,
    timeoutMs: 30_000
  };
}

async function commitPlanPatch(
  options: ConsumePlanQaFeedbackOptions,
  projection: PlanQaStorageProjection,
  feedbackId: string,
  patch: Record<string, unknown>
): Promise<PlanItem> {
  const committed = await options.storage.updatePlan(
    options.roleId,
    projection.plan.id,
    patch,
    mutationContext(
      "plan-qa-plan-transition",
      options.roleId,
      `${projection.plan.id}:${feedbackId}`,
      projection.planRevision,
      patch,
      options.signal
    )
  );
  return committed.plan;
}

async function commitQaHandling(
  options: ConsumePlanQaFeedbackOptions,
  projection: PlanQaStorageProjection,
  feedbackId: string,
  qaHandling: PlanQaFeedbackHandling
): Promise<Readonly<{ projection: PlanQaStorageProjection; record: PlanFeedbackRecord }>> {
  const current = requiredFeedback(projection, feedbackId);
  const committedProjection = await options.storage.updateQaHandling(
    options.roleId,
    current.record.planId,
    current.record,
    qaHandling,
    mutationContext(
      "plan-qa-feedback-transition",
      options.roleId,
      `${current.record.planId}:${current.record.id}`,
      current.revision,
      qaHandling,
      options.signal
    )
  );
  return {
    projection: committedProjection,
    record: requiredFeedback(committedProjection, feedbackId).record
  };
}

export async function consumePlanQaFeedback(
  options: ConsumePlanQaFeedbackOptions
): Promise<PlanQaFeedbackResult> {
  let projection = await options.storage.query(options.roleId, options.feedback.planId, {
    signal: options.signal,
    timeoutMs: 30_000
  });
  if (!projection) throw new Error("Plan not found: " + options.feedback.planId);
  const latest = requiredFeedback(projection, options.feedback.id).record;
  if (!isQaVerdictFeedback(latest)) {
    return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  }
  const feedbackRecords = projection.records;
  if (latest.qaHandling
    && latest.qaHandling.status !== "dispatch_failed"
    && latest.qaHandling.status !== "dispatching") {
    return {
      outcome: latest.qaHandling.outcome,
      status: latest.qaHandling.status,
      missingEvidence: latest.qaHandling.missingEvidence,
      plan: projection.plan
    };
  }
  const failed = latest.qaHandling?.status === "dispatch_failed" || QA_FAILURE_PATTERN.test(latest.text);
  const passed = !failed && QA_PASS_PATTERN.test(latest.text);
  const plan = projection.plan;
  const priorWaiting = [...feedbackRecords].reverse().find((record) => (
    record.id !== latest.id
    && record.qaHandling?.outcome === "failed"
    && record.qaHandling.status === "waiting_for_evidence"
  ));
  const evidenceFollowUp = !failed
    && !passed
    && Boolean(priorWaiting)
    && String(plan.currentStepId || "").startsWith("investigate-");
  if (!failed && !passed && !evidenceFollowUp) {
    return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  }
  const effectiveFeedback: PlanFeedbackRecord = evidenceFollowUp && priorWaiting
    ? {
        ...latest,
        stepId: priorWaiting.stepId,
        stepTitle: priorWaiting.stepTitle,
        text: priorWaiting.text + "\n补充证据：" + latest.text,
        attachments: [...priorWaiting.attachments, ...latest.attachments],
        planAttachments: [...priorWaiting.planAttachments, ...latest.planAttachments]
      }
    : latest;
  const qaStep = qaStepFor(
    plan,
    effectiveFeedback,
    evidenceFollowUp
      || latest.qaHandling?.status === "dispatch_failed"
      || latest.qaHandling?.status === "dispatching"
      || latest.postCommit?.status === "processing"
      || latest.postCommit?.status === "failed"
  );
  if (!qaStep) return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  if (passed) {
    const updatedPlan = planStepIsCompleted(qaStep)
      ? plan
      : await commitPlanPatch(options, projection, latest.id, completeAcceptance(plan, qaStep, latest, options.workflow));
    await commitQaHandling(options, projection, latest.id, {
      outcome: "passed",
      issueType: "generic",
      status: "completed",
      missingEvidence: [],
      consumedAt: new Date().toISOString()
    });
    return { outcome: "passed", status: "completed", missingEvidence: [], plan: updatedPlan };
  }
  const detectedIssueType = priorWaiting?.qaHandling?.issueType || issueType(effectiveFeedback, plan);
  const missingEvidence = missingEvidenceFor(effectiveFeedback, detectedIssueType);
  const updatedPlan = plan.currentStepId === investigationStepId(qaStep)
    ? plan
    : await commitPlanPatch(
        options,
        projection,
        latest.id,
        reopenForInvestigation(plan, qaStep, effectiveFeedback, missingEvidence, options.workflow)
      );
  if (missingEvidence.length) {
    await commitQaHandling(options, projection, latest.id, {
      outcome: "failed",
      issueType: detectedIssueType,
      status: "waiting_for_evidence",
      missingEvidence,
      consumedAt: new Date().toISOString()
    });
    return { outcome: "failed", status: "waiting_for_evidence", missingEvidence, plan: updatedPlan };
  }
  const taskTarget = planTaskDeliveryTarget(updatedPlan);
  if (!taskTarget) {
    const message = "QA failure cannot continue because the original taskBinding sessionId/workspace is incomplete.";
    await commitQaHandling(options, projection, latest.id, {
      outcome: "failed",
      issueType: detectedIssueType,
      status: "dispatch_failed",
      missingEvidence: [],
      consumedAt: new Date().toISOString(),
      message
    });
    throw new Error(message);
  }
  if (latest.qaHandling?.status === "dispatching" || latest.qaHandling?.status === "dispatch_failed") {
    if (!options.readTaskDelivery) {
      throw new Error(`QA feedback ${latest.id} requires authoritative delivery readback before retry.`);
    }
    const readback = await options.readTaskDelivery({
      threadId: taskTarget.threadId,
      cwd: taskTarget.cwd,
      deliveryId: latest.id
    });
    if (readback === "accepted") {
      await commitQaHandling(options, projection, latest.id, {
        ...latest.qaHandling,
        status: "dispatched",
        message: undefined
      });
      return { outcome: "failed", status: "dispatched", missingEvidence: [], plan: updatedPlan };
    }
    if (readback === "in_progress") {
      return { outcome: "failed", status: "dispatching", missingEvidence: [], plan: updatedPlan };
    }
  }
  const dispatchingCommit = await commitQaHandling(options, projection, latest.id, {
    outcome: "failed",
    issueType: detectedIssueType,
    status: "dispatching",
    missingEvidence: [],
    consumedAt: new Date().toISOString()
  });
  projection = dispatchingCommit.projection;
  const dispatching = dispatchingCommit.record;
  try {
    await options.sendToTask({
      ...taskTarget,
      deliveryId: latest.id,
      prompt: taskPrompt(updatedPlan, effectiveFeedback)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.readTaskDelivery) {
      try {
        const readback = await options.readTaskDelivery({
          threadId: taskTarget.threadId,
          cwd: taskTarget.cwd,
          deliveryId: latest.id
        });
        if (readback === "accepted") {
          await commitQaHandling(options, projection, dispatching.id, {
            ...dispatching.qaHandling!,
            status: "dispatched",
            message: undefined
          });
          return { outcome: "failed", status: "dispatched", missingEvidence: [], plan: updatedPlan };
        }
        if (readback === "in_progress") throw error;
      } catch (readbackError) {
        if (readbackError !== error) throw readbackError;
        throw error;
      }
    }
    await commitQaHandling(options, projection, dispatching.id, {
      ...dispatching.qaHandling!,
      status: "dispatch_failed",
      message
    });
    throw error;
  }
  await commitQaHandling(options, projection, dispatching.id, {
    ...dispatching.qaHandling!,
    status: "dispatched"
  });
  return { outcome: "failed", status: "dispatched", missingEvidence: [], plan: updatedPlan };
}
