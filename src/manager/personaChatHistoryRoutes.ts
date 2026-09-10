import type http from "node:http";
import { readPersonaChatHistory } from "../personaChatHistory.js";
import { codexDesktopDeepLinkForTest, readCodexDesktopThreadsByIds } from "../codexDesktopBridge.js";

export function handlePersonaChatHistoryApi(
  request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  roleDir: (roleId: string) => string,
  readTasks = readCodexDesktopThreadsByIds
): boolean {
  const match = url.pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/chat-history$/);
  if (!match) return false;
  const send = (status: number, body: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (request.method !== "GET") {
    send(405, { code: -1, message: "Method not allowed." });
    return true;
  }
  void Promise.resolve().then(() => readPersonaChatHistory(
    roleDir(decodeURIComponent(match[1])),
    url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : undefined,
    Number(url.searchParams.get("limit") ?? 50)
  )).then(data => {
    // Missing/unavailable Desktop metadata must not hide recorded replies.
    try {
      const tasks = new Map(readTasks([...new Set(data.entries.flatMap(entry => [entry.sessionId, ...(entry.targetSessionId ? [entry.targetSessionId] : [])]))]).map(task => [task.id, task]));
      data.entries = data.entries.map(entry => {
        const task = tasks.get(entry.sessionId);
        const target = entry.targetSessionId ? tasks.get(entry.targetSessionId) : undefined;
        return {
          ...entry,
          ...(task ? { sessionTitle: task.title || entry.sessionTitle, taskUrl: codexDesktopDeepLinkForTest(task.id) } : {}),
          ...(target ? { targetSessionTitle: target.title || entry.targetSessionTitle, targetTaskUrl: codexDesktopDeepLinkForTest(target.id) } : {})
        };
      });
    } catch { /* The original task ID remains available when Desktop cannot be read. */ }
    send(200, { code: 0, data });
  })
    .catch(error => send(400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
