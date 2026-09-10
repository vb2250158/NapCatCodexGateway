import type http from "node:http";
import { managerHostRequestAuthorized, type ManagerHostIdentity } from "./hostLifecycle.js";
import { SourcePatchError, type ManagerSourcePatchService, type SourcePatchRequest, type SourcePatchBundleRequest, type SourcePatchBundleReconcileRequest, type SourcePatchReconcileRequest, type SourcePatchOperation } from "./sourcePatchService.js";

function operationView(operation: SourcePatchOperation) {
  return { operationId: operation.operationId, moduleId: operation.moduleId, state: operation.state,
    commitState: operation.commitState, createdAt: operation.createdAt, result: operation.result, error: operation.error };
}

export function handleSourcePatchApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, options: Readonly<{
  service: ManagerSourcePatchService;
  identity: ManagerHostIdentity | null;
  readJson(request: http.IncomingMessage, maximumBytes: number): Promise<unknown>;
  json(response: http.ServerResponse, status: number, body: unknown): void;
}>): boolean {
  if (request.method === "GET" && url.pathname === "/api/source-patches") {
    options.json(response, 200, { code: 0, data: options.service.status() });
    return true;
  }
  const operationMatch = url.pathname.match(/^\/api\/source-patches\/operations\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  if (request.method === "GET" && operationMatch) {
    void options.service.operation(operationMatch[1]!).then(record => options.json(response, record ? 200 : 404, { code: record ? 0 : -1, data: record ? operationView(record) : undefined }))
      .catch(() => options.json(response, 503, { code: -1, message: "Source patch operation record is unavailable; do not replay." }));
    return true;
  }
  const reconcile = url.pathname === "/_rabiroute/host/source-patches/reconcile";
  if (!reconcile && url.pathname !== "/_rabiroute/host/source-patches") return false;
  if (!options.identity) { options.json(response, 404, { code: -1, message: "Manager is not Host-owned." }); return true; }
  if (request.method !== "POST") { options.json(response, 405, { code: -1, message: "Method not allowed." }); return true; }
  if (!managerHostRequestAuthorized(request, options.identity)) {
    options.json(response, 403, { code: -1, message: "Source patch publication requires local Host authority." });
    return true;
  }
  void options.readJson(request, 16 * 1024).then(body => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SourcePatchError("Invalid source patch request.", 400);
    if (reconcile) return (body as { action?: string }).action === "reconcile-bundle"
      ? options.service.reconcileBundle(body as SourcePatchBundleReconcileRequest)
      : options.service.reconcile(body as SourcePatchReconcileRequest);
    return (body as { action?: string }).action === "apply-bundle"
      ? options.service.publishBundle(body as SourcePatchBundleRequest)
      : options.service.publish(body as SourcePatchRequest);
  }).then(result => options.json(response, result.state === "committed" ? 200 : result.commitState === "not_started" ? 409 : 202, { code: 0, data: operationView(result) }))
    .catch(error => options.json(response, error instanceof SourcePatchError ? error.statusCode : 503, {
      code: -1, message: error instanceof SourcePatchError ? error.message : "Source patch publication did not confirm a result; query its operation ID before continuing."
    }));
  return true;
}
