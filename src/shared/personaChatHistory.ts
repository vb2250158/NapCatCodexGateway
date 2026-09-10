/** Persona messages: Hook final replies and managed Agent-to-Agent deliveries. */
export type PersonaChatReply = {
  id: string;
  receivedAt: string;
  sessionId: string;
  turnId?: string;
  kind?: "final_reply" | "agent_delivery";
  deliveryId?: string;
  deliveryStatus?: "delivered" | "unconfirmed";
  targetSessionId?: string;
  targetSessionTitle?: string;
  targetTaskUrl?: string;
  text: string;
  /** Current Desktop sidebar name; resolved when reading, never persisted in the reply ledger. */
  sessionTitle?: string;
  taskUrl?: string;
};

export type PersonaChatHistoryPage = {
  entries: PersonaChatReply[];
  /** Exclusive byte offset in the append-only history; null means the beginning. */
  nextCursor: number | null;
};
