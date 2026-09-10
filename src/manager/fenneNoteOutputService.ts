import { errorResponsePresentation } from "../shared/errorPresentation.js";
import type http from "node:http";
import { forwardFenneNoteRequest, type FenneNoteOutputMode } from "../fenneNoteOutput.js";

export type FenneNoteOutputServiceOptions = {
  playbackUrl?: string;
  playbackToken?: string;
  replyUrl?: string;
  replyToken?: string;
  timeoutMs?: number;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export class FenneNoteOutputService {
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = true;

  constructor(private readonly options: FenneNoteOutputServiceOptions = {}) {}

  handle(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
    if (request.method !== "POST") return false;
    const mode: FenneNoteOutputMode | undefined = requestUrl.pathname === "/api/fennenote/reply"
      ? "reply"
      : requestUrl.pathname === "/api/fennenote/playback"
        ? "playback"
        : undefined;
    if (!mode) return false;
    if (!this.accepting) {
      jsonResponse(response, 503, { ok: false, error: "FenneNote output plugin is stopping." });
      return true;
    }

    const target = mode === "playback" ? this.options.playbackUrl : this.options.replyUrl;
    const task = readJsonBody(request)
      .then(body => forwardFenneNoteRequest(body, {
        mode,
        playbackUrl: this.options.playbackUrl,
        playbackToken: this.options.playbackToken,
        replyUrl: this.options.replyUrl,
        replyToken: this.options.replyToken,
        signal: this.controller.signal,
        timeoutMs: this.options.timeoutMs ?? 30_000
      }))
      .then(result => jsonResponse(response, result.ok ? 202 : 502, result))
      .catch(error => {
        if (response.writableEnded) return;
        jsonResponse(response, 502, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(target ? { target } : {})
        });
      })
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
    return true;
  }

  async stop(): Promise<void> {
    if (!this.accepting && this.controller.signal.aborted) {
      await Promise.allSettled([...this.inFlight]);
      return;
    }
    this.accepting = false;
    this.controller.abort(new Error("FenneNote output plugin stopped."));
    await Promise.allSettled([...this.inFlight]);
  }
}
