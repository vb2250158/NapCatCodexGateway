import type { PersonaChatHistoryPage, PersonaChatReply } from "@shared/personaChatHistory";

/** Follow backward cursors until the loaded boundary; reconnect gaps can span multiple pages. */
export async function readChatHistoryAddition(
  known: ReadonlySet<string>,
  readPage: (cursor?: number) => Promise<PersonaChatHistoryPage>
): Promise<PersonaChatHistoryPage> {
  const entries: PersonaChatReply[] = [];
  const seen = new Set<string>();
  const cursors = new Set<number>();
  let cursor: number | undefined;
  while (true) {
    const page = await readPage(cursor);
    for (const entry of page.entries) {
      if (known.has(entry.id)) return { entries, nextCursor: page.nextCursor };
      if (!seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
    }
    if (!known.size || page.nextCursor === null) return { entries, nextCursor: page.nextCursor };
    if (cursors.has(page.nextCursor)) throw new Error("Chat history cursor did not advance.");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
