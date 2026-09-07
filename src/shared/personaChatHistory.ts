/** Final replies received through an Agent completion Hook, scoped to one persona. */
export type PersonaChatReply = {
  id: string;
  receivedAt: string;
  sessionId: string;
  turnId: string;
  text: string;
};

export type PersonaChatHistoryPage = {
  entries: PersonaChatReply[];
  /** Exclusive byte offset in the append-only history; null means the beginning. */
  nextCursor: number | null;
};
