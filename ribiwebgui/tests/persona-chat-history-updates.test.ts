import assert from "node:assert/strict";
import test from "node:test";
import { readChatHistoryAddition } from "../src/personaChatHistoryUpdates";
import type { PersonaChatReply } from "../../src/shared/personaChatHistory";

const entry = (id: string): PersonaChatReply => ({ id, sessionId: "task", turnId: id, text: id, receivedAt: "2026-09-08T00:00:00Z" });

test("initial load reads one page and preserves the older cursor", async () => {
  const result = await readChatHistoryAddition(new Set(), async cursor => {
    assert.equal(cursor, undefined);
    return { entries: [entry("a")], nextCursor: 20 };
  });
  assert.equal(result.nextCursor, 20);
  assert.deepEqual(result.entries.map(e => e.id), ["a"]);
});

test("reconnect catches up multiple pages once and stops at the existing boundary", async () => {
  const cursors: (number | undefined)[] = [];
  const result = await readChatHistoryAddition(new Set(["old"]), async cursor => {
    cursors.push(cursor);
    return cursor === undefined
      ? { entries: [entry("new2"), entry("new1")], nextCursor: 20 }
      : { entries: [entry("new1"), entry("old"), entry("unloaded-older")], nextCursor: 10 };
  });
  assert.deepEqual(cursors, [undefined, 20]);
  assert.deepEqual(result.entries.map(e => e.id), ["new2", "new1"]);
});

test("replayed events add nothing and read failures are surfaced without mutating known entries", async () => {
  const known = new Set(["old"]);
  assert.deepEqual((await readChatHistoryAddition(known, async () => ({ entries: [entry("old")], nextCursor: null }))).entries, []);
  await assert.rejects(readChatHistoryAddition(known, async () => { throw new Error("offline"); }), /offline/);
  assert.deepEqual([...known], ["old"]);
});

test("invalid repeated cursors fail instead of looping forever", async () => {
  await assert.rejects(readChatHistoryAddition(new Set(["old"]), async () => ({ entries: [entry("new")], nextCursor: 1 })), /did not advance/);
});
