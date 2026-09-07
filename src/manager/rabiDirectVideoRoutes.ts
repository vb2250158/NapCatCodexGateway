import type { IncomingMessage, ServerResponse } from "node:http";
import { DIRECT_VIDEO_SIGNAL_MAX_BYTES, RabiDirectVideo } from "./rabiDirectVideo.js";

export function createDirectVideoRoutes(receiver: RabiDirectVideo, readOnly: boolean,
  readJson: (request: IncomingMessage, maxBytes: number) => Promise<unknown>,
  json: (response: ServerResponse, status: number, body: unknown) => void) {
  return (request: IncomingMessage, url: URL, response: ServerResponse): boolean => {
    if (url.pathname === "/api/rabilink/video/status" && request.method === "GET") {
      json(response, 200, { sessions: receiver.status(), relay: false }); return true;
    }
    if (url.pathname !== "/api/rabilink/video/offer" || request.method !== "POST") return false;
    if (readOnly) { json(response, 403, { error: "Read-only Manager cannot start video." }); return true; }
    void readJson(request, DIRECT_VIDEO_SIGNAL_MAX_BYTES).then(body => receiver.offer(body))
      .then(answer => json(response, 200, answer))
      .catch(() => json(response, 400, { error: "Video negotiation failed; check direct connectivity, session capacity and SDP." }));
    return true;
  };
}
