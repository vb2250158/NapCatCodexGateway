import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import type {
  PersonaSyncConflict,
  PersonaSyncActivePlanPackageCommand,
  PersonaSyncArchivedPlanPackageCommand,
  PersonaSyncConflictResolutionCommand,
  PersonaSyncMergeCommand,
  PersonaSyncService
} from "../personaSync.js";
import type { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import type { PersonaSyncAutoReconciler } from "../personaSyncAutoReconciler.js";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { planStorageStartupUnavailable } from "./planStorageStartupHttpGate.js";
import type { PlanStorageStartupLifecycleSnapshot } from "./planStorageStartupLifecycle.js";

function jsonResponse(response: http.ServerResponse, status: number, body: unknown): void {
  body = errorResponsePresentation(body, status);
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage, maximumBytes = 24 * 1024 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", chunk => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > maximumBytes) {
        reject(new Error("Persona sync request is too large."));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function loopback(request: http.IncomingMessage): boolean {
  const address = String(request.socket.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const scheduledConflictScans = new WeakMap<PersonaSyncService, Set<string>>();

function scheduleConflictScan(ctx: PersonaSyncRouteContext, roleId?: string): void {
  if (!ctx.listConflicts) return;
  const key = roleId || "*";
  const scheduled = scheduledConflictScans.get(ctx.service) ?? new Set<string>();
  scheduledConflictScans.set(ctx.service, scheduled);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const timer = setTimeout(() => {
    void ctx.listConflicts!(roleId)
      .catch(error => console.warn(`Persona conflict history scan failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => scheduled.delete(key));
  }, Math.max(0, ctx.conflictScheduleDelayMs ?? 1_000));
  timer.unref?.();
}

export type PersonaSyncRouteContext = {
  service: PersonaSyncService;
  coordinator: PersonaSyncCoordinator;
  autoReconciler?: PersonaSyncAutoReconciler;
  token(): string;
  relay(): { url: string; token: string; deviceId: string; deviceGuid: string };
  manifestTimeoutMs?: number;
  conflictListDeadlineMs?: number;
  conflictScheduleDelayMs?: number;
  listConflicts?(roleId?: string): Promise<PersonaSyncConflict[]>;
  readOnlySnapshot?: boolean;
  controlPlaneAuthorized?: boolean;
  planStorageStartup?(): PlanStorageStartupLifecycleSnapshot;
};

function authorized(request: http.IncomingMessage, ctx: PersonaSyncRouteContext): boolean {
  if (loopback(request) || ctx.controlPlaneAuthorized === true) return true;
  const expected = ctx.token().trim();
  if (!expected) return false;
  const header = String(request.headers["x-rabilink-token"] || "").trim();
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  return header === expected || bearer === expected;
}

function localControlAllowed(request: http.IncomingMessage, ctx: PersonaSyncRouteContext): boolean {
  return loopback(request) || ctx.controlPlaneAuthorized === true;
}

export function handlePersonaSyncApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  ctx: PersonaSyncRouteContext
): boolean {
  if (!requestUrl.pathname.startsWith("/api/persona-sync")) return false;
  if (!authorized(request, ctx)) {
    jsonResponse(response, 401, { code: -1, message: "Persona sync requires the same RabiLink application token." });
    return true;
  }
  if (new Set(["/api/persona-sync/index-status", "/api/persona-sync/auto-status", "/api/persona-sync/preview"]).has(requestUrl.pathname) && !localControlAllowed(request, ctx)) {
    jsonResponse(response, 403, { code: -1, message: "Persona sync diagnostics are loopback-only." });
    return true;
  }
  if (requestUrl.pathname.startsWith("/api/persona-sync/conflicts") && !localControlAllowed(request, ctx)) {
    jsonResponse(response, 403, { code: -1, message: "Persona sync conflict control is loopback-only." });
    return true;
  }
  const startupRejection = planStorageStartupUnavailable(request.method, requestUrl.pathname, ctx.planStorageStartup?.());
  if (startupRejection) {
    response.setHeader("retry-after", String(startupRejection.retryAfterSeconds));
    jsonResponse(response, startupRejection.statusCode, startupRejection.body);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/index-status") {
    jsonResponse(response, 200, { code: 0, data: ctx.service.manifestIndexStatus() });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/auto-status") {
    jsonResponse(response, 200, {
      code: 0,
      data: ctx.autoReconciler?.status() || {
        state: "stopped",
        relayOnline: false,
        pending: false,
        pendingFullSync: false,
        pendingRoleCount: 0,
        retryAttempt: 0
      }
    });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/conflicts") {
    if (ctx.readOnlySnapshot) {
      jsonResponse(response, 200, {
        code: 0,
        data: { conflicts: [] },
        scan: {
          state: "snapshot",
          partial: true,
          message: "Read-only Manager acceptance does not walk conflict payloads."
        }
      });
      return true;
    }
    const roleId = requestUrl.searchParams.get("roleId") || undefined;
    if (ctx.listConflicts) {
      const snapshot = ctx.service.conflictListSnapshot(roleId);
      if (snapshot) {
        jsonResponse(response, 200, {
          code: 0,
          data: {
            conflicts: snapshot,
            scan: { state: "ready", partial: false }
          }
        });
        return true;
      }
      scheduleConflictScan(ctx, roleId);
      jsonResponse(response, 202, {
        code: 0,
        data: {
          conflicts: [],
          scan: {
            state: "building",
            partial: true,
            retryAfterMs: 1_000,
            message: "Conflict history is being organized in the background; Manager remains available."
          }
        }
      });
      return true;
    }
    const deadlineMs = Math.max(50, ctx.conflictListDeadlineMs ?? 750);
    let timer: NodeJS.Timeout | undefined;
    const scan = ctx.service.listConflictsAsync(roleId).then(
      conflicts => ({ state: "complete" as const, conflicts }),
      error => ({ state: "failed" as const, error })
    );
    const deadline = new Promise<{ state: "building" }>(resolve => {
      timer = setTimeout(() => resolve({ state: "building" }), deadlineMs);
      timer.unref?.();
    });
    void Promise.race([scan, deadline])
      .then(result => {
        if (result.state === "failed") throw result.error;
        if (result.state === "building") {
          jsonResponse(response, 202, {
            code: 0,
            data: {
              conflicts: ctx.service.conflictListSnapshot(roleId) || [],
              scan: {
                state: "building",
                partial: true,
                retryAfterMs: 1_000,
                message: "Conflict history is being organized in the background; Manager remains available."
              }
            }
          });
          return;
        }
        jsonResponse(response, 200, {
          code: 0,
          data: {
            conflicts: result.conflicts,
            scan: { state: "ready", partial: false }
          }
        });
      })
      .catch(error => {
        const status = error instanceof ManagerReadWorkerError && error.code === "busy" ? 503
          : error instanceof ManagerReadWorkerError && error.code === "timeout" ? 504
            : 400;
        jsonResponse(response, status, { code: -1, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/conflicts/content") {
    try {
      const result = ctx.service.readConflict(requestUrl.searchParams.get("conflictId") || "");
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(result.content.byteLength),
        "x-rabi-conflict-id": encodeURIComponent(result.conflict.conflictId),
        "x-rabi-role-id": result.conflict.roleId,
        "x-rabi-relative-path": encodeURIComponent(result.conflict.path),
        "x-rabi-local-sha256": result.conflict.localHash || "",
        "x-rabi-remote-sha256": result.conflict.remoteHash,
        "cache-control": "no-store"
      });
      response.end(result.content);
    } catch (error) {
      jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/conflicts/resolve") {
    void readJsonBody<PersonaSyncConflictResolutionCommand>(request)
      .then(async command => {
        const resolution = ctx.service.resolveConflict(command);
        const publish = await ctx.coordinator.publishConflictResolution(resolution);
        return { ...resolution, publish };
      })
      .then(result => jsonResponse(response, 200, { code: 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/peers") {
    void ctx.coordinator.peers()
      .then(peers => jsonResponse(response, 200, { code: 0, data: { peers } }))
      .catch(error => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/preview") {
    const peerId = String(requestUrl.searchParams.get("peerId") || "").trim();
    const roleId = String(requestUrl.searchParams.get("roleId") || "").trim() || undefined;
    if (!peerId) {
      jsonResponse(response, 400, { code: -1, message: "Persona sync peerId is required." });
      return true;
    }
    void ctx.coordinator.preview(peerId, roleId)
      .then(result => jsonResponse(response, 200, { code: 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/sync") {
    void readJsonBody<{ peerId?: string; roleId?: string }>(request)
      .then(body => {
        const peerId = String(body.peerId || "").trim();
        if (!peerId) throw new Error("Persona sync peerId is required.");
        return ctx.coordinator.sync(peerId, String(body.roleId || "").trim() || undefined);
      })
      .then(result => jsonResponse(response, result.conflicts ? 409 : 200, { code: result.conflicts ? 1 : 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/manifest") {
    const roleId = requestUrl.searchParams.get("roleId") || undefined;
    const published = ctx.service.publishedManifestSnapshot(roleId);
    const publication = published.publication;
    const scan = {
      state: publication.state === "ready" && !publication.stale ? "ok" : publication.state,
      partial: publication.stale,
      revision: publication.revision,
      stale: publication.stale,
      refreshedAt: publication.refreshedAt,
      refreshStartedAt: publication.refreshStartedAt,
      deadlineMs: publication.deadlineMs,
      error: publication.error
    };
    if (!published.manifest) {
      jsonResponse(response, 503, {
        code: -1,
        scan,
        message: publication.error || "Persona manifest snapshot is still being built outside the Manager event loop."
      });
      return true;
    }
    jsonResponse(response, 200, {
      code: 0,
      data: published.manifest,
      scan
    });
    return true;
  }
  const fileMatch = requestUrl.pathname.match(/^\/api\/persona-sync\/files\/([^/]+)\/(.+)$/);
  if (request.method === "GET" && fileMatch) {
    try {
      const result = ctx.service.readFile(decodeURIComponent(fileMatch[1]), decodeURIComponent(fileMatch[2]));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(result.content.byteLength),
        "x-rabi-role-id": result.file.roleId,
        "x-rabi-relative-path": encodeURIComponent(result.file.path),
        "x-rabi-sha256": result.file.sha256,
        "cache-control": "no-store"
      });
      response.end(result.content);
    } catch (error) {
      jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/plan-packages/archive") {
    void readJsonBody<PersonaSyncArchivedPlanPackageCommand>(request, 128 * 1024 * 1024)
      .then(async command => {
        const result = ctx.service.applyArchivedPlanPackage(command);
        await ctx.service.manifest(command.roleId);
        return result;
      })
      .then(result => jsonResponse(response, result.status === "conflict" ? 409 : 200, {
        code: result.status === "conflict" ? 1 : 0,
        data: result
      }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/plan-packages/active") {
    void readJsonBody<PersonaSyncActivePlanPackageCommand>(request, 128 * 1024 * 1024)
      .then(async command => {
        const result = ctx.service.applyActivePlanPackage(command);
        await ctx.service.manifest(command.roleId);
        return result;
      })
      .then(result => jsonResponse(response, result.status === "conflict" ? 409 : 200, {
        code: result.status === "conflict" ? 1 : 0,
        data: result
      }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/merge") {
    void readJsonBody<PersonaSyncMergeCommand>(request)
      .then(async command => {
        const result = ctx.service.merge(command);
        // The manifest endpoint intentionally serves only the last published
        // snapshot. Publish the owner mutation before acknowledging it so a
        // following sync transaction cannot receive the previous file hash.
        await ctx.service.manifest(command.roleId);
        return result;
      })
      .then(result => jsonResponse(response, result.status === "conflict" ? 409 : 200, { code: result.status === "conflict" ? 1 : 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}
