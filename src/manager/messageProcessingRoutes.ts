import { errorResponsePresentation } from "../shared/errorPresentation.js";
import type http from "node:http";
import type {
  CriticalProjectFactDisposition,
  KnowledgeMatchCallbackInput,
  KnowledgeRecallMatch,
  MessageProcessingGroupRegistrationResult,
  MessageProcessingOutcomeInput,
  MessageProcessingRequirement,
  RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import type { MessageProcessingSendContextApprovalInput } from "../messageProcessing/sendContextReview.js";
import type { ManagerOperationalLog } from "./operationalLog.js";

type MessageProcessingRegistrationInput = {
  action?: "register_group" | "dispatch" | "dispatch_failed";
  requirementId?: string;
  messageGroupId?: string;
  source?: RegisterMessageGroupRequirementInput["source"];
  worker?: MessageProcessingRequirement["worker"];
  error?: string;
};

type CriticalFactVerificationInput = {
  roleId?: string;
  requirement?: MessageProcessingRequirement;
  disposition?: CriticalProjectFactDisposition;
};

export type MessageProcessingApiContext = {
  boardPayload: (routeId?: string, limit?: number) => Promise<Record<string, unknown>>;
  board: {
    getRequirement: (requirementId: string) => MessageProcessingRequirement | undefined;
    registerMessageGroup: (input: RegisterMessageGroupRequirementInput) => MessageProcessingGroupRegistrationResult;
    recordDispatch: (
      requirementId: string,
      worker: NonNullable<MessageProcessingRequirement["worker"]>
    ) => MessageProcessingRequirement;
    recordDispatchFailure: (requirementId: string, error: string) => MessageProcessingRequirement;
    submitOutcome: (
      requirementId: string,
      input: MessageProcessingOutcomeInput
    ) => MessageProcessingRequirement;
    recordKnowledgeCallback: (
      requirementId: string,
      input: KnowledgeMatchCallbackInput
    ) => MessageProcessingRequirement;
  };
  sendContextReview: {
    snapshot: (requirementId: string, sourceMessageId?: string) => unknown;
    approve: (
      requirementId: string,
      input: MessageProcessingSendContextApprovalInput
    ) => { expiresAt: string } & Record<string, unknown>;
  };
  operationalLog: Pick<ManagerOperationalLog, "record">;
  recallKnowledge: (source: RegisterMessageGroupRequirementInput["source"]) => KnowledgeRecallMatch[];
  verifyCriticalFactRecord: (input: CriticalFactVerificationInput) => void;
  setPlanBaseline: (
    requirement: MessageProcessingRequirement,
    roleId?: string,
    planId?: string
  ) => void;
  scheduleKnowledgeCallbackReminder: (requirement: MessageProcessingRequirement) => void;
  publishEvent: (eventType: string, data: unknown) => void;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function runTrackedOperation<T>(
  context: Pick<MessageProcessingApiContext, "trackOperation">,
  operation: Promise<T>
): void {
  void (context.trackOperation?.(operation) ?? operation);
}

function publishBoardChange(
  context: MessageProcessingApiContext,
  requirement: MessageProcessingRequirement
): void {
  context.publishEvent("message_processing_board_changed", {
    requirementId: requirement.id,
    status: requirement.status
  });
}

function verifyOutcomeRecords(
  context: MessageProcessingApiContext,
  requirement: MessageProcessingRequirement | undefined,
  body: MessageProcessingOutcomeInput
): void {
  const roleId = String(body.roleId || requirement?.source.roleId || "").trim() || undefined;
  for (const disposition of body.knowledgeMatchDispositions || []) {
    for (const action of disposition.actions || []) {
      if (!action.recordType || !action.recordId || !action.verifiedAt) continue;
      context.verifyCriticalFactRecord({
        roleId,
        requirement: requirement
          ? { ...requirement, criticalFacts: [{ kind: "scope", evidence: action.evidence }] }
          : undefined,
        disposition: {
          status: "recorded",
          record: action.recordType === "memory"
            ? { type: "memory", memoryId: action.recordId }
            : { type: "plan", planId: action.recordId },
          evidence: action.evidence,
          verifiedAt: action.verifiedAt
        }
      });
    }
  }
  context.verifyCriticalFactRecord({
    roleId,
    requirement: requirement && body.projectFactAssessment?.status === "critical"
      ? { ...requirement, criticalFacts: body.projectFactAssessment.facts }
      : requirement,
    disposition: body.criticalFactDisposition
  });
}

export function handleMessageProcessingApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: MessageProcessingApiContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/message-processing/board") {
    const routeId = requestUrl.searchParams.get("routeId")?.trim() || undefined;
    const limit = Number(requestUrl.searchParams.get("limit") || "100");
    runTrackedOperation(context, context.boardPayload(routeId, limit)
      .then((data) => jsonResponse(response, 200, { code: 0, data }))
      .catch((error) => jsonResponse(response, 500, { code: -1, message: errorMessage(error) })));
    return true;
  }

  const requirementMatch = requestUrl.pathname.match(/^\/api\/message-processing\/requirements\/([^/]+)$/);
  if (request.method === "GET" && requirementMatch) {
    const requirementId = decodeURIComponent(requirementMatch[1]);
    const requirement = context.board.getRequirement(requirementId);
    if (!requirement) {
      jsonResponse(response, 404, {
        code: -1,
        message: `Message processing requirement not found: ${requirementId}`
      });
      return true;
    }
    jsonResponse(response, 200, { code: 0, data: requirement });
    return true;
  }

  const sendContextMatch = requestUrl.pathname.match(
    /^\/api\/message-processing\/requirements\/([^/]+)\/send-context$/
  );
  if (request.method === "GET" && sendContextMatch) {
    const requirementId = decodeURIComponent(sendContextMatch[1]);
    const sourceMessageId = requestUrl.searchParams.get("sourceMessageId")?.trim() || undefined;
    try {
      const data = context.sendContextReview.snapshot(requirementId, sourceMessageId);
      jsonResponse(response, 200, { code: 0, data });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
    }
    return true;
  }
  if (request.method === "POST" && sendContextMatch) {
    const requirementId = decodeURIComponent(sendContextMatch[1]);
    runTrackedOperation(context, readJsonBody<MessageProcessingSendContextApprovalInput>(request)
      .then((body) => context.sendContextReview.approve(requirementId, body))
      .then((data) => {
        context.operationalLog.record("info", "message_processing_send_context_review_approved", {
          action: requirementId,
          result: `expiresAt=${data.expiresAt}`
        });
        jsonResponse(response, 200, { code: 0, data });
      })
      .catch((error) => jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/message-processing/requirements") {
    runTrackedOperation(context, readJsonBody<MessageProcessingRegistrationInput>(request)
      .then((body) => {
        const requirementId = String(body.requirementId || "").trim();
        if (!requirementId) throw new Error("Missing requirementId.");
        if (body.action === "register_group") {
          const registration = context.board.registerMessageGroup({
            requirementId,
            messageGroupId: String(body.messageGroupId || "").trim(),
            source: body.source as RegisterMessageGroupRequirementInput["source"],
            knowledgeMatches: context.recallKnowledge(body.source as RegisterMessageGroupRequirementInput["source"])
          });
          if (registration.outcome !== "replay_suppressed") {
            context.scheduleKnowledgeCallbackReminder(registration.requirement);
            publishBoardChange(context, registration.requirement);
          }
          return registration;
        }
        const item = body.action === "dispatch"
          ? context.board.recordDispatch(
              requirementId,
              body.worker as NonNullable<MessageProcessingRequirement["worker"]>
            )
          : body.action === "dispatch_failed"
            ? context.board.recordDispatchFailure(
                requirementId,
                body.error || "Message Agent dispatch failed."
              )
            : (() => { throw new Error("Unsupported message-processing action."); })();
        context.scheduleKnowledgeCallbackReminder(item);
        publishBoardChange(context, item);
        return item;
      })
      .then((data) => jsonResponse(response, 200, { code: 0, data }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  const outcomeMatch = requestUrl.pathname.match(
    /^\/api\/message-processing\/requirements\/([^/]+)\/outcome$/
  );
  if (request.method === "POST" && outcomeMatch) {
    const requirementId = decodeURIComponent(outcomeMatch[1]);
    runTrackedOperation(context, readJsonBody<MessageProcessingOutcomeInput>(request)
      .then((body) => {
        const requirement = context.board.getRequirement(requirementId);
        verifyOutcomeRecords(context, requirement, body);
        return { body, data: context.board.submitOutcome(requirementId, body) };
      })
      .then(({ body, data }) => {
        context.setPlanBaseline(data, body.roleId, body.planId);
        context.scheduleKnowledgeCallbackReminder(data);
        publishBoardChange(context, data);
        jsonResponse(response, 200, { code: 0, data });
      })
      .catch((error) => jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  const knowledgeCallbackMatch = requestUrl.pathname.match(
    /^\/api\/message-processing\/requirements\/([^/]+)\/knowledge-callback$/
  );
  if (request.method === "POST" && knowledgeCallbackMatch) {
    const requirementId = decodeURIComponent(knowledgeCallbackMatch[1]);
    runTrackedOperation(context, readJsonBody<KnowledgeMatchCallbackInput>(request)
      .then((body) => {
        const requirement = context.board.getRequirement(requirementId);
        if (!requirement) throw new Error(`Message processing requirement not found: ${requirementId}`);
        const roleId = String(requirement.source.roleId || "").trim() || undefined;
        if ((body.result === "updated" || body.result === "created") && body.recordType && body.recordId) {
          context.verifyCriticalFactRecord({
            roleId,
            requirement: {
              ...requirement,
              criticalFacts: [{ kind: "scope", evidence: body.evidence }]
            },
            disposition: {
              status: "recorded",
              record: body.recordType === "memory"
                ? { type: "memory", memoryId: body.recordId }
                : { type: "plan", planId: body.recordId },
              evidence: body.evidence,
              verifiedAt: body.verifiedAt
            }
          });
        }
        return context.board.recordKnowledgeCallback(requirementId, body);
      })
      .then((data) => {
        context.scheduleKnowledgeCallbackReminder(data);
        publishBoardChange(context, data);
        jsonResponse(response, 200, { code: 0, data });
      })
      .catch((error) => jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  return false;
}
