import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import {
  CodexHookContextService,
  CodexHookPlanStorageUnavailableError,
  type CodexHookEventName
} from "./codexHookContext.js";

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody(request: http.IncomingMessage, maximumBytes = 256 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        reject(new Error("Codex hook request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function managerBaseUrl(request: http.IncomingMessage): string {
  const host = String(request.headers.host || "").replace(/[\r\n]/g, "").trim();
  if (!host) throw new Error("Manager request Host header is required.");
  return `http://${host}`;
}

export function hookContextRequest(body: Record<string, unknown>, request: http.IncomingMessage) {
  return {
    agentType: typeof body.agentType === "string" ? body.agentType : "codex",
    sessionId: String(body.session_id || body.sessionId || ""),
    eventName: String(body.hook_event_name || body.eventName || "") as CodexHookEventName,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    source: typeof body.source === "string" ? body.source : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    turnId: typeof body.turn_id === "string" ? body.turn_id : typeof body.turnId === "string" ? body.turnId : undefined,
    toolName: typeof body.tool_name === "string" ? body.tool_name : typeof body.toolName === "string" ? body.toolName : undefined,
    toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : typeof body.toolUseId === "string" ? body.toolUseId : undefined,
    toolInput: body.tool_input ?? body.toolInput,
    toolResponse: body.tool_response ?? body.toolResponse,
    stopHookActive: body.stop_hook_active === true || body.stopHookActive === true,
    lastAssistantMessage: typeof body.last_assistant_message === "string"
      ? body.last_assistant_message
      : typeof body.lastAssistantMessage === "string"
        ? body.lastAssistantMessage
        : undefined,
    managerBaseUrl: managerBaseUrl(request)
  };
}

export function handleCodexHookApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  service: CodexHookContextService
): boolean {
  const pathname = requestUrl.pathname;

  if (request.method === "POST" && pathname === "/api/codex-hook/context") {
    void readJsonBody(request)
      .then((body) => service.handleHook(hookContextRequest(body, request)))
      .then((data) => jsonResponse(response, 200, { code: 0, data }))
      .catch((error) => {
        if (error instanceof CodexHookPlanStorageUnavailableError) {
          jsonResponse(response, error.statusCode, {
            code: -1,
            error: error.code,
            message: error.message
          });
          return;
        }
        jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/codex-hook/roles") {
    try {
      jsonResponse(response, 200, { code: 0, data: { roleIds: service.listRoles() } });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/codex-hook/doctor") {
    try {
      jsonResponse(response, 200, { code: 0, data: service.doctor() });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/codex-hook/sessions") {
    jsonResponse(response, 200, { code: 0, data: { sessions: service.listBindings() } });
    return true;
  }

  const sessionMatch = pathname.match(/^\/api\/codex-hook\/sessions\/([^/]+)$/);
  if (!sessionMatch) return false;
  const sessionId = decodeURIComponent(sessionMatch[1]);

  if (request.method === "GET") {
    jsonResponse(response, 200, { code: 0, data: service.getBinding(sessionId) });
    return true;
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    void readJsonBody(request)
      .then((body) => service.bindSession(sessionId, String(body.roleId || "")))
      .then((data) => jsonResponse(response, 200, { code: 0, data }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "DELETE") {
    try {
      jsonResponse(response, 200, { code: 0, data: { removed: service.unbindSession(sessionId) } });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
  return true;
}
