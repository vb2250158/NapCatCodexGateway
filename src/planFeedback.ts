import { randomUUID } from "node:crypto";
import { normalizeStoredPlanAttachments } from "./planAttachments.js";
import {
  appendPlanFeedback,
  appendPlanFeedbackAsync,
  commitPlanFeedback,
  listPlanFeedback,
  listPlanFeedbackAsync,
  listPlanFeedbackFiles,
  normalizeStoredPlanFeedbackAttachments,
  planFeedbackAttachmentsEqual,
  planFeedbackPlanAttachmentsEqual,
  recoverPlanFeedbackStoreTransactions
} from "./planFeedbackStore.js";
import type { PlanStorageTransactionHooks } from "./planStorageRepository.js";
import { PLAN_MAX_ATTACHMENTS, type PlanAttachment } from "./shared/planAttachmentContract.js";
import type { PlanFeedbackAttachment } from "./shared/planFeedbackContract.js";
import { createStorageRevision, type StorageMutationStamp } from "./shared/storageRevision.js";

export type { PlanFeedbackAttachment } from "./shared/planFeedbackContract.js";

export type PlanFeedbackKind = "guidance" | "guidance_response" | "approval_suggestion" | "approval_response";
export type PlanFeedbackAuthor = "user" | "agent" | "system";
export type PlanFeedbackSource = "webgui" | "tray" | "qq" | "agent" | "api";
export type PlanFeedbackDeliveryStatus = "record_only" | "pending" | "delivered" | "failed";

export type PlanFeedbackPostCommit = {
  deliveryId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  updatedAt: string;
  message?: string;
};

export type PlanQaFeedbackHandling = {
  outcome: "failed" | "passed";
  issueType: "generic" | "account" | "version" | "timing" | "visual" | "crash";
  status: "waiting_for_evidence" | "dispatching" | "dispatched" | "completed" | "dispatch_failed";
  missingEvidence: string[];
  consumedAt: string;
  message?: string;
};

export type PlanFeedbackRecord = {
  id: string;
  roleId: string;
  planId: string;
  planTitle: string;
  stepId?: string;
  stepTitle?: string;
  gatewayId?: string;
  kind: PlanFeedbackKind;
  author: PlanFeedbackAuthor;
  source: PlanFeedbackSource;
  text: string;
  attachments: PlanFeedbackAttachment[];
  planAttachments: PlanAttachment[];
  createdAt: string;
  updatedAt: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
  deliveryStatus: PlanFeedbackDeliveryStatus;
  deliveryMessage?: string;
  qaHandling?: PlanQaFeedbackHandling;
  postCommit?: PlanFeedbackPostCommit;
};

export type CreatePlanFeedbackInput = {
  id?: unknown;
  roleId: string;
  planId: string;
  planTitle: string;
  stepId?: unknown;
  stepTitle?: unknown;
  gatewayId?: unknown;
  kind?: unknown;
  author?: unknown;
  source?: unknown;
  text?: unknown;
  attachments?: PlanFeedbackAttachment[];
  planAttachments?: PlanAttachment[];
  notifyAgent?: unknown;
};

export type PlanFeedbackCommitOptions = {
  /** Test-only seam translated into repository transaction hooks by the store. */
  faultInjector?: (
    point: "attachment_staged" | "attachments_committed" | "feedback_committed",
    attachmentIndex?: number
  ) => void;
  repositoryTransaction?: { hooks?: PlanStorageTransactionHooks };
};

export type PlanFeedbackCommitResult = {
  record: PlanFeedbackRecord;
  created: boolean;
};

const MAX_FEEDBACK_CHARS = 2_000;

function safeIdPart(value: string): string {
  return value
    .trim()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function optionalText(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function normalizeKind(value: unknown): PlanFeedbackKind {
  if (value === "guidance" || value === "guidance_response" || value === "approval_response") return value;
  return "approval_suggestion";
}

function normalizeAuthor(value: unknown): PlanFeedbackAuthor {
  return value === "agent" || value === "system" ? value : "user";
}

function normalizeSource(value: unknown, author: PlanFeedbackAuthor): PlanFeedbackSource {
  if (value === "webgui" || value === "tray" || value === "qq" || value === "agent") return value;
  return author === "agent" ? "agent" : "api";
}

export function planFeedbackResponseId(feedback: Pick<PlanFeedbackRecord, "id"> | string): string {
  const feedbackId = typeof feedback === "string" ? feedback : feedback.id;
  return `response-${feedbackId}`;
}

export function resolvePlanFeedbackPlanAttachments(
  availableValue: unknown,
  requestedValue: unknown,
  existingValue?: unknown
): PlanAttachment[] {
  const existing = normalizeStoredPlanAttachments(existingValue);
  if (requestedValue === undefined) return existing;
  if (!Array.isArray(requestedValue)) throw new Error("Plan attachment mentions must be an array of attachment ids.");
  if (requestedValue.length > PLAN_MAX_ATTACHMENTS) {
    throw new Error(`Approval feedback can mention at most ${PLAN_MAX_ATTACHMENTS} plan attachments.`);
  }
  const requestedIds = requestedValue.map((value) => String(value || "").trim());
  if (requestedIds.some((id) => !id)) throw new Error("Plan attachment mention id is required.");
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new Error("Plan attachment mention ids must be unique.");
  }
  if (requestedIds.length === existing.length && requestedIds.every((id, index) => existing[index]?.id === id)) {
    return existing;
  }
  const available = normalizeStoredPlanAttachments(availableValue);
  const byId = new Map(available.map((attachment) => [attachment.id, attachment]));
  return requestedIds.map((id) => {
    const attachment = byId.get(id);
    if (!attachment) throw new Error(`Plan attachment not found: ${id}`);
    return attachment;
  });
}

export function createPlanFeedbackRecord(input: CreatePlanFeedbackInput): PlanFeedbackRecord {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("Plan feedback text is required.");
  if (Array.from(text).length > MAX_FEEDBACK_CHARS) {
    throw new Error(`Plan feedback exceeds ${MAX_FEEDBACK_CHARS} characters.`);
  }
  const author = normalizeAuthor(input.author);
  const notifyAgent = input.notifyAgent !== false && author !== "agent";
  const createdAt = new Date().toISOString();
  const id = safeIdPart(String(input.id || "")) || `feedback-${randomUUID()}`;
  return {
    id,
    roleId: input.roleId,
    planId: input.planId,
    planTitle: input.planTitle,
    stepId: optionalText(input.stepId),
    stepTitle: optionalText(input.stepTitle),
    gatewayId: optionalText(input.gatewayId),
    kind: normalizeKind(input.kind),
    author,
    source: normalizeSource(input.source, author),
    text,
    attachments: normalizeStoredPlanFeedbackAttachments(input.attachments),
    planAttachments: normalizeStoredPlanAttachments(input.planAttachments),
    createdAt,
    updatedAt: createdAt,
    storageRevision: createStorageRevision(),
    deliveryStatus: notifyAgent ? "pending" : "record_only",
    ...(author === "agent" || !notifyAgent ? {} : {
      postCommit: {
        deliveryId: id,
        status: "pending" as const,
        attempts: 0,
        updatedAt: createdAt
      }
    })
  };
}

export function updatePlanFeedbackDelivery(
  roleDir: string,
  record: PlanFeedbackRecord,
  deliveryStatus: "pending" | "delivered" | "failed",
  deliveryMessage?: string,
  expectedRevision?: string,
  mutation?: StorageMutationStamp
): PlanFeedbackRecord {
  return appendPlanFeedback(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId,
    deliveryStatus,
    deliveryMessage: optionalText(deliveryMessage)
  }, expectedRevision);
}

export function updatePlanFeedbackDeliveryAsync(
  roleDir: string,
  record: PlanFeedbackRecord,
  deliveryStatus: "pending" | "delivered" | "failed",
  deliveryMessage?: string,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<PlanFeedbackRecord> {
  return appendPlanFeedbackAsync(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    storageRevision: createStorageRevision(),
    deliveryStatus,
    deliveryMessage: optionalText(deliveryMessage)
  }, signal, expectedRevision);
}

export function updatePlanFeedbackQaHandling(
  roleDir: string,
  record: PlanFeedbackRecord,
  qaHandling: PlanQaFeedbackHandling,
  expectedRevision?: string,
  mutation?: StorageMutationStamp
): PlanFeedbackRecord {
  return appendPlanFeedback(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId,
    deliveryStatus: qaHandling.status === "dispatch_failed"
      ? "failed"
      : qaHandling.status === "dispatching"
        ? "pending"
        : "delivered",
    qaHandling
  }, expectedRevision);
}

export function updatePlanFeedbackPostCommit(
  roleDir: string,
  record: PlanFeedbackRecord,
  status: PlanFeedbackPostCommit["status"],
  message?: string,
  expectedRevision?: string,
  mutation?: StorageMutationStamp
): PlanFeedbackRecord {
  const updatedAt = new Date().toISOString();
  const current = record.postCommit;
  return appendPlanFeedback(roleDir, {
    ...record,
    updatedAt,
    storageRevision: mutation?.revision ?? createStorageRevision(),
    storageMutationRequestId: mutation?.requestId,
    postCommit: {
      deliveryId: current?.deliveryId || record.id,
      status,
      attempts: (current?.attempts || 0) + (status === "processing" ? 1 : 0),
      updatedAt,
      message: optionalText(message)
    }
  }, expectedRevision);
}

export function planFeedbackSummary(roleDir: string, planId: string): { count: number; latest?: PlanFeedbackRecord } {
  const records = listPlanFeedback(roleDir, planId);
  return { count: records.length, latest: records[0] };
}

export {
  appendPlanFeedback,
  appendPlanFeedbackAsync,
  commitPlanFeedback,
  listPlanFeedback,
  listPlanFeedbackAsync,
  listPlanFeedbackFiles,
  planFeedbackAttachmentsEqual,
  planFeedbackPlanAttachmentsEqual,
  recoverPlanFeedbackStoreTransactions
};
