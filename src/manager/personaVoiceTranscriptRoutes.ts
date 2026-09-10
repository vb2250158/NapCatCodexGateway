import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import {
  type PersonaVoiceTranscriptQuery,
  type PersonaVoiceTranscriptQueryResult,
  type PersonaVoiceSpeakerClassification
} from "../personaVoiceTranscriptView.js";
import { managerReadWorkerPool, ManagerReadWorkerError } from "./managerReadWorkerPool.js";

export type PersonaVoiceTranscriptRouteContext = {
  roleDir(roleId: string): string;
  query?(roleDir: string, query: PersonaVoiceTranscriptQuery, signal: AbortSignal): Promise<PersonaVoiceTranscriptQueryResult>;
};

function jsonResponse(response: http.ServerResponse, status: number, body: unknown): void {
  body = errorResponsePresentation(body, status);
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body, null, 2));
}

export function handlePersonaVoiceTranscriptApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PersonaVoiceTranscriptRouteContext
): boolean {
  const match = requestUrl.pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/voice-transcripts$/);
  if (!match) return false;
  try {
    if (request.method !== "GET") {
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    }
    const roleDir = context.roleDir(decodeURIComponent(match[1]));
    const rawSpeaker = requestUrl.searchParams.get("speaker")?.trim() || "";
    const rawIncludeDetails = requestUrl.searchParams.get("includeDetails")?.trim().toLowerCase();
    const allowedSpeakers = new Set<PersonaVoiceSpeakerClassification>(["user", "other", "unknown", "conflict"]);
    if (rawSpeaker && !allowedSpeakers.has(rawSpeaker as PersonaVoiceSpeakerClassification)) {
      throw new Error("speaker must be user, other, unknown, or conflict.");
    }
    const query: PersonaVoiceTranscriptQuery = {
      limit: Number(requestUrl.searchParams.get("limit") || 200),
      includeArchives: ["1", "true", "yes"].includes((requestUrl.searchParams.get("includeArchives") || "").toLowerCase()),
      includeDetails: rawIncludeDetails == null || !["0", "false", "no"].includes(rawIncludeDetails),
      speaker: rawSpeaker ? rawSpeaker as PersonaVoiceSpeakerClassification : undefined,
      from: requestUrl.searchParams.get("from") || undefined,
      to: requestUrl.searchParams.get("to") || undefined
    };
    const abortController = new AbortController();
    request.once("aborted", () => abortController.abort());
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    const execute = context.query
      ?? ((targetRoleDir: string, targetQuery: PersonaVoiceTranscriptQuery, signal: AbortSignal) =>
        managerReadWorkerPool.queryPersonaVoiceTranscripts(targetRoleDir, targetQuery, { signal }));
    void execute(roleDir, query, abortController.signal)
      .then(result => jsonResponse(response, 200, {
        code: 0,
        data: {
          identityPath: "voice/voice-identities.jsonl",
          conversationPath: "conversation/current.jsonl",
          ...result
        }
      }))
      .catch(error => {
        if (error instanceof ManagerReadWorkerError && error.code === "aborted") return;
        const status = error instanceof ManagerReadWorkerError && error.code === "busy" ? 503
          : error instanceof ManagerReadWorkerError && error.code === "timeout" ? 504
            : 400;
        jsonResponse(response, status, { code: -1, message: error instanceof Error ? error.message : String(error) });
      });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
