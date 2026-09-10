import type http from "node:http";
import { knowledgeReference, type KnowledgeKind } from "../roleKnowledgeSearch.js";
import type { KnowledgeSearchService } from "./knowledgeSearchService.js";

type Context = {
  service?: KnowledgeSearchService;
  roleDirectory: (roleId: string) => string;
  readBody: (request: http.IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
};
function kind(value: unknown): KnowledgeKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "plan" && value !== "recent" && value !== "consolidated") throw new Error("Invalid knowledge kind");
  return value;
}

/** Invoked behind the Manager's existing LAN authorization and read-only gates. */
export function handleKnowledgeSearch(request: http.IncomingMessage, pathname: string, response: http.ServerResponse, context: Context): boolean {
  const match = pathname.match(/^\/api\/roles\/([^/]+)\/knowledge\/(search|cache\/status|cache\/reload)$/);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "KNOWLEDGE_INDEX_WARMING" ? 503 : message === "KNOWLEDGE_CURSOR_EXPIRED" ? 409 : 400;
    context.json(response, status, { code: -1, message });
  };
  try {
    const roleId = decodeURIComponent(match[1]);
    const directory = context.roleDirectory(roleId);
    const service = context.service;
    if (!service) { context.json(response, 503, { code: -1, message: "KNOWLEDGE_INDEX_WARMING" }); return true; }
    const index = service.ensure(roleId, directory);
    const action = match[2];
    if (action === "cache/reload") {
      if (request.method !== "POST") { context.json(response, 405, { code: -1, message: "POST is required" }); return true; }
      void context.readBody(request).then(async body => {
        const targetKind = kind(body.kind);
        const id = body.id;
        if ((id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 512)) || Boolean(targetKind) !== Boolean(id)) {
          throw new Error("Provide both kind and id for a point reload");
        }
        if (body.all !== undefined && typeof body.all !== "boolean") throw new Error("all must be boolean");
        if (body.all === true && targetKind) throw new Error("Choose either all or a point reload");
        await service.reload(roleId, directory, body.all === true, targetKind ? knowledgeReference(targetKind, id as string) : undefined);
        const data = service.status(directory);
        context.json(response, "refreshing" in data && data.refreshing ? 202 : 200, { code: 0, data });
      }).catch(fail);
      return true;
    }
    if (request.method !== "GET") { context.json(response, 405, { code: -1, message: "GET is required" }); return true; }
    if (action === "cache/status") { context.json(response, 200, { code: 0, data: service.status(directory) }); return true; }
    const parameters = new URL(request.url || pathname, "http://localhost").searchParams;
    const mode = parameters.get("mode") ?? "keywords";
    if (mode !== "keywords" && mode !== "fulltext") throw new Error("Invalid search mode");
    const data = index.search({ query: parameters.get("query") ?? "", mode, kind: kind(parameters.get("kind")),
      archived: parameters.get("archived") === "1", limit: Number(parameters.get("limit") ?? "10"),
      cursor: parameters.get("cursor") ?? undefined });
    context.json(response, 200, { code: 0, data });
  } catch (error) { fail(error); }
  return true;
}
