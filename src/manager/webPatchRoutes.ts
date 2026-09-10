import type http from "node:http";
import path from "node:path";
import { managerHostRequestAuthorized, type ManagerHostIdentity } from "./hostLifecycle.js";
import { WEB_PATCH_PREFIX } from "./webPatchCatalog.js";
import type { WebPatchRequest, WebPatchService } from "./webPatchService.js";

function contentType(filename: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon" } as Record<string, string>)[path.extname(filename)] ?? "application/octet-stream";
}

export function handleWebPatchApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, options: {
  service: WebPatchService; identity: ManagerHostIdentity | null;
  readJson(request: http.IncomingMessage, maximum: number): Promise<unknown>;
  json(response: http.ServerResponse, status: number, body: unknown): void;
}): boolean {
  const send = (status: number, data: unknown) => { response.setHeader("cache-control", "no-store"); options.json(response, status, data); };
  if (url.pathname === "/api/web-patches" && request.method === "GET") {
    send(200, { code: 0, data: options.service.status() }); return true;
  }
  const operation = url.pathname.match(/^\/api\/web-patches\/operations\/([A-Za-z0-9_-]{1,128})$/);
  if (operation && request.method === "GET") {
    const receipt = options.service.operation(operation[1]!);
    const blocked = options.service.status().state !== "ready";
    send(receipt ? 200 : blocked ? 503 : 404, { code: receipt ? 0 : -1, data: receipt, operationState: receipt ? "committed" : blocked ? "unknown" : "not_started" }); return true;
  }
  if (url.pathname === "/_rabiroute/host/web-patches") {
    if (request.method !== "POST") { send(405, { code: -1 }); return true; }
    if (!managerHostRequestAuthorized(request, options.identity)) { send(403, { code: -1, message: "Web publication requires local Host authority." }); return true; }
    void options.readJson(request, 8192).then(async body => {
      const input = body as WebPatchRequest & { action?: string };
      return input?.action === "reconcile" ? options.service.reconcile(input.operationId) : options.service.publish(input);
    })
      .then(receipt => send(200, { code: 0, data: receipt }))
      .catch(error => send(409, { code: -1, message: String(error), operationState: options.service.status().state === "blocked" ? "unknown" : "not_started" }));
    return true;
  }
  if (url.pathname.startsWith(WEB_PATCH_PREFIX)) {
    if (request.method !== "GET" && request.method !== "HEAD") { send(405, { code: -1 }); return true; }
    const match = url.pathname.match(/^\/_rabiroute\/web\/([a-f0-9]{64})\/(.+)$/);
    if (!match) { send(404, { code: -1 }); return true; }
    let filename: string;
    try { filename = decodeURIComponent(match[2]!); }
    catch { send(400, { code: -1 }); return true; }
    void options.service.read(match[1]!, filename).then(file => {
      response.writeHead(200, { "content-type": contentType(file.path), "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff", "x-rabiroute-web-revision": file.revision });
      response.end(request.method === "HEAD" ? undefined : file.body);
    }).catch(error => send(404, { code: -1, message: String(error) }));
    return true;
  }
  return false;
}
