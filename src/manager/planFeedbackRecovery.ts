import {
  planFeedbackResponseId,
  type PlanFeedbackDeliveryStatus,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import type { PlanItem } from "../roleKnowledge.js";

export type PlanFeedbackRecoveryCandidate = {
  roleDir: string;
  roleId: string;
  plan: PlanItem;
  feedback: PlanFeedbackRecord;
};

export type PlanFeedbackDeliveryInspection = "accepted" | "in_progress" | "missing";

export type PlanFeedbackRecoveryTaskRequest = {
  threadId: string;
  cwd: string;
  deliveryId: string;
};

export type PlanFeedbackRecoveryOutcome =
  | { state: "delivered"; record: PlanFeedbackRecord }
  | { state: "scheduled" }
  | { state: "deferred"; reason: string }
  | { state: "failed"; error: unknown };

export type PlanFeedbackRecoveryProjection = Readonly<{
  plan: PlanItem;
  records: PlanFeedbackRecord[];
}>;

function hasOpenPostCommit(record: PlanFeedbackRecord): boolean {
  return record.postCommit?.deliveryId === record.id
    && record.postCommit.status !== "completed";
}

function hasRecoverableQa(record: PlanFeedbackRecord): boolean {
  return record.kind === "approval_suggestion"
    && (record.qaHandling?.status === "dispatching" || record.qaHandling?.status === "dispatch_failed");
}

export function isRecoverablePlanFeedback(record: PlanFeedbackRecord): boolean {
  if (record.author === "agent" || record.deliveryStatus === "record_only") return false;
  const recoverableDelivery = (record.deliveryStatus === "pending" || record.deliveryStatus === "failed")
    && (record.kind === "guidance" || record.kind === "approval_suggestion")
    && !record.qaHandling;
  return hasOpenPostCommit(record) || hasRecoverableQa(record) || recoverableDelivery;
}

export async function recoverPlanFeedbackCandidate(
  candidate: PlanFeedbackRecoveryCandidate,
  options: {
    signal?: AbortSignal;
    query: (
      candidate: PlanFeedbackRecoveryCandidate,
      signal?: AbortSignal
    ) => Promise<PlanFeedbackRecoveryProjection | null>;
    inspect: (request: PlanFeedbackRecoveryTaskRequest) => Promise<PlanFeedbackDeliveryInspection>;
    schedule: (candidate: PlanFeedbackRecoveryCandidate) => Promise<void>;
    updateDelivery: (
      candidate: PlanFeedbackRecoveryCandidate,
      record: PlanFeedbackRecord,
      status: Exclude<PlanFeedbackDeliveryStatus, "record_only">,
      message?: string,
      signal?: AbortSignal
    ) => Promise<PlanFeedbackRecord>;
    postCommit?: (candidate: PlanFeedbackRecoveryCandidate) => Promise<{
      outcome: "handled" | "ignored";
      record: PlanFeedbackRecord;
    }>;
  }
): Promise<PlanFeedbackRecoveryOutcome> {
  options.signal?.throwIfAborted();
  let authoritative = await options.query(candidate, options.signal);
  if (!authoritative) {
    return { state: "deferred", reason: "The plan is no longer available in the authoritative storage projection." };
  }
  let currentFeedback = authoritative.records;
  let latestCandidate = currentFeedback.find(record => record.id === candidate.feedback.id);
  if (!latestCandidate || !isRecoverablePlanFeedback(latestCandidate)) {
    return latestCandidate?.deliveryStatus === "delivered"
      ? { state: "delivered", record: latestCandidate }
      : { state: "deferred", reason: "Feedback is no longer recoverable in the authoritative ledger." };
  }
  let currentCandidate: PlanFeedbackRecoveryCandidate = {
    ...candidate,
    plan: authoritative.plan,
    feedback: latestCandidate
  };
  if ((hasOpenPostCommit(latestCandidate) || hasRecoverableQa(latestCandidate)) && options.postCommit) {
    try {
      const processed = await options.postCommit(currentCandidate);
      if (processed.outcome === "handled") return { state: "delivered", record: processed.record };
      authoritative = await options.query(currentCandidate, options.signal);
      if (!authoritative) return { state: "deferred", reason: "The plan disappeared after post-commit recovery." };
      currentFeedback = authoritative.records;
      latestCandidate = currentFeedback.find(record => record.id === candidate.feedback.id);
      if (!latestCandidate) return { state: "deferred", reason: "Feedback disappeared after post-commit recovery." };
      if (latestCandidate.deliveryStatus === "delivered" || latestCandidate.deliveryStatus === "record_only") {
        return { state: "delivered", record: latestCandidate };
      }
      currentCandidate = { ...candidate, plan: authoritative.plan, feedback: latestCandidate };
    } catch (error) {
      return { state: "failed", error };
    }
  } else if (latestCandidate.deliveryStatus === "delivered") {
    return { state: "delivered", record: latestCandidate };
  }
  const responseKind = latestCandidate.kind === "guidance"
    ? "guidance_response"
    : "approval_response";
  const linkedResponse = currentFeedback.find((record) => (
    record.id === planFeedbackResponseId(latestCandidate)
    && record.kind === responseKind
    && record.author === "agent"
  ));
  if (linkedResponse) {
    return {
      state: "delivered",
      record: await options.updateDelivery(
        currentCandidate,
        latestCandidate,
        "delivered",
        `Manager recovery confirmed linked ${responseKind} ${linkedResponse.id}.`,
        options.signal
      )
    };
  }

  const binding = currentCandidate.plan.taskBinding;
  if (!binding?.sessionId?.trim() || !binding.workspace?.trim()) {
    await options.schedule(currentCandidate);
    return { state: "scheduled" };
  }

  let state: PlanFeedbackDeliveryInspection;
  try {
    state = await options.inspect({
      threadId: binding.sessionId.trim(),
      cwd: binding.workspace.trim(),
      deliveryId: latestCandidate.id
    });
  } catch (error) {
    return {
      state: "failed",
      error
    };
  }

  if (state === "accepted") {
    return {
      state: "delivered",
      record: await options.updateDelivery(
        currentCandidate,
        latestCandidate,
        "delivered",
        "Manager recovery confirmed the feedback in the bound Desktop task.",
        options.signal
      )
    };
  }
  if (state === "in_progress") {
    return {
      state: "deferred",
      reason: "The bound Desktop task is active; wait for an authoritative delivery readback."
    };
  }

  await options.schedule(currentCandidate);
  return { state: "scheduled" };
}
