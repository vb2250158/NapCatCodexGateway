import type http from "node:http";
import { readPersonaChatHistory } from "../personaChatHistory.js";

export function handlePersonaChatHistoryApi(
  request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  roleDir: (roleId: string) => string
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
  )).then(data => send(200, { code: 0, data }))
    .catch(error => send(400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
