import { planFeedbackResponseId, type PlanFeedbackRecord } from "../planFeedback.js";
import type { PlanItem } from "../roleKnowledge.js";
import { planFeedbackResponseMutationInstruction } from "../shared/roleStorageMutationContract.js";
import { planTaskDeliveryTarget } from "./planTaskBindingDelivery.js";

export type PlanApprovalFeedbackTaskRequest = {
  agentAdapter: "codex" | "dsh";
  threadId: string;
  title: string;
  cwd: string;
  createIfMissing: true;
  prompt: string;
};

export type PlanApprovalFeedbackTaskDeliveryReadRequest = {
  threadId: string;
  cwd: string;
  deliveryId: string;
};

export type PlanApprovalFeedbackPersonaRequest = {
  kind: "auto_delivered_notice" | "auto_delivery_pending_notice" | "auto_delivery_failed_notice" | "full_feedback";
  text: string;
};

export type PlanApprovalFeedbackSecretaryTarget = {
  threadId: string;
  threadName: string;
  workspace: string;
  model?: string;
};

export type DeliverPlanApprovalFeedbackOptions = {
  roleId: string;
  managerBaseUrl: string;
  plan: PlanItem;
  feedback: PlanFeedbackRecord;
  secretary?: PlanApprovalFeedbackSecretaryTarget;
  sendToTask: (request: PlanApprovalFeedbackTaskRequest) => Promise<void>;
  readTaskDelivery?: (
    request: PlanApprovalFeedbackTaskDeliveryReadRequest
  ) => Promise<"accepted" | "in_progress" | "missing">;
  sendToSecretary?: (target: PlanApprovalFeedbackSecretaryTarget, request: PlanApprovalFeedbackPersonaRequest) => Promise<void>;
  sendToPersona: (request: PlanApprovalFeedbackPersonaRequest) => Promise<void>;
  directRetryAttempts?: number;
  directRetryDelayMs?: number;
};

export type PlanApprovalFeedbackDeliveryResult = {
  mode: "bound_task" | "secretary_fallback" | "persona_fallback";
  message?: string;
};

export class PlanFeedbackDeliveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanFeedbackDeliveryPendingError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** HTTP acceptance is not proof that Desktop accepted the message. */
export function requireConfirmedPlanDelivery(result: { statusCode: number; data: Record<string, unknown> }): void {
  const { data, statusCode } = result;
  const error = data.error as { message?: string } | undefined;
  if (data.status === "delivery_unconfirmed" || data.status === "delivered_tracking_failed") {
    const delivery = data.delivery as { deliveryId?: string } | undefined;
    throw new PlanFeedbackDeliveryPendingError(
      `Plan delivery is awaiting confirmation (status=${data.status}, deliveryId=${delivery?.deliveryId || "unavailable"}). `
      + `${error?.message || data.warning || "No confirmed delivery receipt is available."} `
      + "Read the original delivery receipt; do not resend the message or mark the feedback delivered."
    );
  }
  if (statusCode < 200 || statusCode >= 300 || data.ok === false || data.status !== "delivered") {
    throw new Error(String(data.message || error?.message || `Plan delivery did not confirm acceptance (HTTP ${statusCode}, status=${data.status || "missing"}).`));
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableBoundTaskDeliveryError(error: unknown): boolean {
  const text = errorMessage(error).toLocaleLowerCase();
  return text.includes("no-client-found")
    || text.includes("desktop owner")
    || text.includes("owner 没有完成加载")
    || text.includes("desktop 未就绪")
    || text.includes("ipc is not connected");
}

function isGuidance(feedback: PlanFeedbackRecord): boolean {
  return feedback.kind === "guidance" || feedback.kind === "guidance_response";
}

function feedbackLabel(feedback: PlanFeedbackRecord): string {
  return isGuidance(feedback) ? "执行引导" : "审批意见";
}

function responseKind(feedback: PlanFeedbackRecord): "guidance_response" | "approval_response" {
  return isGuidance(feedback) ? "guidance_response" : "approval_response";
}

function feedbackLines(feedback: PlanFeedbackRecord): string[] {
  const lines = [
    `计划：${feedback.planTitle}`,
    `计划 ID：${feedback.planId}`,
    `反馈 ID：${feedback.id}`
  ];
  if (feedback.stepId || feedback.stepTitle) {
    lines.push(`对应步骤：${feedback.stepTitle || feedback.stepId}${feedback.stepId ? `（${feedback.stepId}）` : ""}`);
  }
  const label = feedbackLabel(feedback);
  lines.push(`${label}：${feedback.text}`);
  if (feedback.attachments.length) {
    lines.push(
      `${label}附件：`,
      ...feedback.attachments.map((attachment) => `- ${attachment.name}（${attachment.path}）`)
    );
  }
  if (feedback.planAttachments.length) {
    lines.push(
      "本次 @ 的计划附件：",
      ...feedback.planAttachments.map((attachment) => `- ${attachment.name}（${attachment.path}）`)
    );
  }
  return lines;
}

function feedbackApiUrl(options: DeliverPlanApprovalFeedbackOptions): string {
  return `${options.managerBaseUrl}/api/roles/${encodeURIComponent(options.roleId)}/plans/${encodeURIComponent(options.plan.id)}/feedback`;
}

function boundTaskPrompt(options: DeliverPlanApprovalFeedbackOptions): string {
  const responseId = planFeedbackResponseId(options.feedback);
  if (isGuidance(options.feedback)) {
    return [
      "[计划引导：已直接投递到绑定业务会话]",
      ...feedbackLines(options.feedback),
      "这是原业务任务。直接消费引导；秘书同步跟进控制面。",
      "读取当前计划与反馈。引导影响范围、优先级或路径时，PATCH 计划和后续步骤；引导不等于审批。",
      planFeedbackResponseMutationInstruction({
        endpoint: feedbackApiUrl(options),
        planId: options.plan.id,
        feedbackId: responseId,
        kind: responseKind(options.feedback),
        scope: "只写当前 planId"
      })
    ].join("\n");
  }
  return [
    "[计划审批：已直接投递到绑定业务会话]",
    ...feedbackLines(options.feedback),
    "这是原业务任务。直接消费审批；秘书同步跟进控制面。",
    "读取当前计划与审批记录，按意见更新计划或步骤。说明实际改动、命令、外部变化、验证、回退和排除范围。",
    planFeedbackResponseMutationInstruction({
      endpoint: feedbackApiUrl(options),
      planId: options.plan.id,
      feedbackId: responseId,
      kind: responseKind(options.feedback),
      scope: "写当前 planId / stepId"
    })
  ].join("\n");
}

async function readTaskDeliveryAfterError(
  options: DeliverPlanApprovalFeedbackOptions,
  taskRequest: PlanApprovalFeedbackTaskRequest,
  attempts: number,
  delayMs: number
): Promise<"accepted" | "in_progress" | "missing" | undefined> {
  if (!options.readTaskDelivery) return undefined;
  let lastState: "accepted" | "in_progress" | "missing" | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastState = await options.readTaskDelivery({
        threadId: taskRequest.threadId,
        cwd: taskRequest.cwd,
        deliveryId: options.feedback.id
      });
      if (lastState === "accepted" || lastState === "missing") return lastState;
    } catch {
      // Keep polling briefly because Desktop readback can become available after the send response times out.
    }
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  return lastState;
}

function controlFeedbackText(
  options: DeliverPlanApprovalFeedbackOptions,
  directFailure?: string
): string {
  const guidance = isGuidance(options.feedback);
  const recipient = options.secretary ? "计划秘书" : "人格 Agent";
  return [
    guidance ? "[计划执行引导]" : "[计划审批建议]",
    ...feedbackLines(options.feedback),
    ...(directFailure ? [`绑定业务会话自动直投失败：${directFailure}`] : []),
    guidance
      ? `引导未直达业务任务。由${recipient}记录失败并续投原任务。`
      : `审批未直达业务任务。由${recipient}记录失败并续投原任务。`,
    guidance
      ? "读取计划与反馈；必要时调整后续步骤。引导不等于审批。"
      : "读取计划与审批记录，按意见更新计划或步骤。"
  ].join("\n");
}

function controlNoticeText(options: DeliverPlanApprovalFeedbackOptions): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动投递通知]`,
    ...feedbackLines(options.feedback),
    `系统已自动投递到绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    options.secretary
      ? "秘书跟进计划和结果；仅在需要决定、授权、输入或最终复核时通知主人格。"
      : "人格 Agent 只需复核后续结果。"
  ].join("\n");
}

function controlPendingNoticeText(options: DeliverPlanApprovalFeedbackOptions, failure: string): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动直投等待通知]`,
    ...feedbackLines(options.feedback),
    `已找到绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    `Desktop owner 尚未接管，系统重试同一会话：${failure}`,
    `${label}保持 pending。${options.secretary ? "秘书" : "人格 Agent"}等待重试结果。`
  ].join("\n");
}

function controlFailedNoticeText(options: DeliverPlanApprovalFeedbackOptions, failure: string): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动直投失败通知]`,
    ...feedbackLines(options.feedback),
    `绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    `有界重试后仍未交给 Desktop owner：${failure}`,
    `${label}未投递。保留原 taskBinding，等待 Desktop owner 可用后重试。`
  ].join("\n");
}

async function sendToControl(
  options: DeliverPlanApprovalFeedbackOptions,
  request: PlanApprovalFeedbackPersonaRequest
): Promise<void> {
  if (options.secretary) {
    if (!options.sendToSecretary) throw new Error("Plan secretary delivery is configured without a secretary sender.");
    await options.sendToSecretary(options.secretary, request);
    return;
  }
  await options.sendToPersona(request);
}

export async function deliverPlanApprovalFeedback(
  options: DeliverPlanApprovalFeedbackOptions
): Promise<PlanApprovalFeedbackDeliveryResult> {
  const taskRequest = planTaskDeliveryTarget(options.plan);
  if (!taskRequest) {
    await sendToControl(options, {
      kind: "full_feedback",
      text: controlFeedbackText(options)
    });
    return {
      mode: options.secretary ? "secretary_fallback" : "persona_fallback",
      message: `Plan taskBinding sessionId/workspace is incomplete; delivered to ${options.secretary ? "secretary" : "persona"}.`
    };
  }

  const deliveryTaskRequest: PlanApprovalFeedbackTaskRequest = {
    ...taskRequest,
    prompt: boundTaskPrompt(options)
  };
  const retryAttempts = Math.max(1, Math.floor(options.directRetryAttempts ?? 12));
  const retryDelayMs = Math.max(1, Math.floor(options.directRetryDelayMs ?? 15_000));
  const readbackAttempts = Math.min(3, retryAttempts);
  let lastError: unknown;
  let pendingNoticeFailure = "";

  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    try {
      await options.sendToTask(deliveryTaskRequest);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const readback = await readTaskDeliveryAfterError(options, deliveryTaskRequest, readbackAttempts, retryDelayMs);
      if (readback === "accepted") {
        lastError = undefined;
        break;
      }
      if (readback === "in_progress") {
        lastError = new PlanFeedbackDeliveryPendingError(errorMessage(error));
        break;
      }
      if (error instanceof PlanFeedbackDeliveryPendingError) break;
      const retryable = isRetryableBoundTaskDeliveryError(error);
      if (attempt === 0 && retryable) {
        try {
          await sendToControl(options, {
            kind: "auto_delivery_pending_notice",
            text: controlPendingNoticeText(options, errorMessage(error))
          });
        } catch (noticeError) {
          pendingNoticeFailure = errorMessage(noticeError);
        }
      }
      if (!retryable || attempt + 1 >= retryAttempts) break;
      await wait(retryDelayMs);
    }
  }

  if (lastError !== undefined) {
    const message = errorMessage(lastError);
    if (lastError instanceof PlanFeedbackDeliveryPendingError) throw lastError;
    try {
      await sendToControl(options, {
        kind: "auto_delivery_failed_notice",
        text: controlFailedNoticeText(options, message)
      });
    } catch {
      // The bound-task delivery failure remains authoritative even if its control-plane notice also fails.
    }
    throw new Error(message);
  }

  try {
    await sendToControl(options, {
      kind: "auto_delivered_notice",
      text: controlNoticeText(options)
    });
    return pendingNoticeFailure
      ? { mode: "bound_task", message: `Plan feedback reached the bound business task; pending control notice failed earlier: ${pendingNoticeFailure}` }
      : { mode: "bound_task" };
  } catch (error) {
    return {
      mode: "bound_task",
      message: `Plan feedback reached the bound business task, but ${options.secretary ? "secretary" : "persona"} notification failed: ${errorMessage(error)}`
    };
  }
}
