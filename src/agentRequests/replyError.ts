import type { AgentRequestRecord } from "./store.js";

/** A rejected reply has not been sent; the original delivery may already exist. */
export class AgentReplyStateError extends Error {
  readonly code = "agent_reply_state_conflict";
  readonly commitState = "not_started";
  readonly retryable = false;
  readonly requestId: string;
  readonly currentState: string;
  readonly expectedState = "awaiting_response";
  readonly nextAction: string;

  constructor(record: AgentRequestRecord, readonly reason: string) {
    const nextAction = reason === "reply_sender_does_not_match_original_target"
      ? `Reply from the original target task ${record.target.threadId}; keep the same requestId.`
      : reason === "reply_destination_does_not_match_original_source"
        ? `Send the reply to the original source task ${record.source.threadId}; keep the same requestId.`
        : reason === "reply_sender_workspace_mismatch" || reason === "reply_destination_workspace_mismatch"
          ? "Read the original request source/target workspace values and use the matching execution directory, then retry with the same requestId."
          : record.status === "pending_delivery"
      ? "Verify the original delivery in the original target task, then retry this reply with the same requestId. Do not resend the original task or create a replacement request."
      : record.status === "responded"
        ? "Read the original request response; it is already recorded. Do not send it again."
        : "Read the cancellation reason and current plan before deciding whether a new task is needed.";
    super(`Agent request is not awaiting a response: ${record.id}; currentState=${record.status}; reason=${reason}. ${nextAction}`);
    this.name = "AgentReplyStateError";
    this.requestId = record.id;
    this.currentState = record.status;
    this.nextAction = nextAction;
  }
}
