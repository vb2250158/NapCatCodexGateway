import { createHash } from "node:crypto";
import fs from "node:fs";
import { open, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";
import type { PersonaChatReply, PersonaChatHistoryPage } from "./shared/personaChatHistory.js";

const HISTORY_PATH = "chat-history/final-replies.jsonl";
const writes = new Map<string, Promise<unknown>>();
// Rebuilt from the ledger after restart or an external file change; never authoritative.
const idCaches = new Map<string, { size: number; mtimeMs: number; ids: Set<string> }>();

function parseReply(line: string): PersonaChatReply {
  const value = JSON.parse(line) as PersonaChatReply;
  const identity = value?.kind === "agent_delivery" ? [value.deliveryId, value.targetSessionId] : [value?.turnId];
  if (!value || ![value.id, value.receivedAt, value.sessionId, value.text, ...identity].every(item => typeof item === "string" && item.length > 0)) {
    throw new Error("Invalid persona chat history record.");
  }
  return value;
}

async function historyIds(file: string): Promise<Set<string>> {
  const info = await stat(file).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return new Set();
  const cached = idCaches.get(file);
  if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.ids;
  const ids = new Set<string>();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim()) ids.add(parseReply(line).id);
  } finally {
    lines.close();
    input.destroy();
  }
  idCaches.set(file, { size: info.size, mtimeMs: info.mtimeMs, ids });
  return ids;
}

export async function appendPersonaChatReply(
  roleDir: string,
  input: Pick<PersonaChatReply, "sessionId" | "turnId" | "text" | "kind" | "deliveryId" | "deliveryStatus" | "targetSessionId" | "sessionTitle" | "targetSessionTitle">
): Promise<PersonaChatReply | null> {
  if (!input.sessionId.trim() || !input.text.trim()) return null;
  if (input.kind === "agent_delivery" ? !input.deliveryId?.trim() || !input.targetSessionId?.trim() : !input.turnId?.trim()) return null;
  const file = path.resolve(roleDir, HISTORY_PATH);
  const record: PersonaChatReply = {
    ...input,
    id: createHash("sha256").update(JSON.stringify(input.kind === "agent_delivery"
      ? ["agent_delivery", input.deliveryId]
      : [input.sessionId, input.turnId, input.text])).digest("hex"),
    receivedAt: new Date().toISOString()
  };
  // One append transaction per persona. Replayed hooks do not create a second row.
  const previous = writes.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const ids = await historyIds(file);
    if (ids.has(record.id)) return null;
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      const info = await handle.stat();
      ids.add(record.id);
      idCaches.set(file, { size: info.size, mtimeMs: info.mtimeMs, ids });
    } finally {
      await handle.close();
    }
    recordDataMutationAudit({
      group: "persona.chat-history", event: "persona_chat_reply_recorded", owner: "personaChatHistory",
      action: "append", target: { type: "persona-chat-reply", id: record.id },
      dataSource: { kind: "ledger", id: file }, outcome: "committed"
    });
    return record;
  });
  writes.set(file, write);
  try { return await write; }
  finally { if (writes.get(file) === write) writes.delete(file); }
}

/** Reads backwards by byte offset, so paging never reloads the complete history. */
export async function readPersonaChatHistory(roleDir: string, cursor?: number, limit = 50): Promise<PersonaChatHistoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100.");
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid chat history cursor.");
  const file = path.resolve(roleDir, HISTORY_PATH);
  await writes.get(file);
  const handle = await open(file, "r").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return { entries: [], nextCursor: null };
  try {
    const size = (await handle.stat()).size;
    let position = cursor ?? size;
    if (position > size) throw new Error("Chat history changed; refresh the list.");
    if (position > 0) {
      const newline = Buffer.alloc(1);
      await handle.read(newline, 0, 1, position - 1);
      if (newline[0] !== 10) throw new Error("Incomplete chat history record or invalid cursor.");
    }
    let pending = Buffer.alloc(0);
    const entries: PersonaChatReply[] = [];
    let responseBytes = 0;
    while (position > 0) {
      const start = Math.max(0, position - 64 * 1024);
      const buffer = Buffer.alloc(position - start);
      await handle.read(buffer, 0, buffer.length, start);
      const combined = Buffer.concat([buffer, pending]);
      let end = combined.length;
      if (combined[end - 1] === 10) end -= 1;
      while (end > 0) {
        const newline = combined.lastIndexOf(10, end - 1);
        if (newline < 0 && start > 0) break;
        const lineStart = newline + 1;
        const line = combined.subarray(lineStart, end);
        if (line.length) {
          entries.push(parseReply(line.toString("utf8")));
          responseBytes += line.length;
        }
        const nextCursor = start + lineStart;
        if (entries.length >= limit || responseBytes >= 1024 * 1024) {
          return { entries, nextCursor: nextCursor > 0 ? nextCursor : null };
        }
        end = newline;
      }
      pending = combined.subarray(0, Math.max(0, end));
      if (pending.length > 1024 * 1024) throw new Error("Persona chat history record is too large.");
      position = start;
    }
    return { entries, nextCursor: null };
  } finally {
    await handle.close();
  }
}
