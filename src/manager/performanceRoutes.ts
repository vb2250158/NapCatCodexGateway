import { errorResponsePresentation } from "../shared/errorPresentation.js";
import type http from "node:http";
import { normalizePerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import type { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: http.IncomingMessage, maximumBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maximumBytes) {
        reject(new Error("Performance payload exceeds the size limit."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

export class PerformanceApi {
  private streams = new Set<http.ServerResponse>();
  private unsubscribe: () => void;

  constructor(private context: {
    service: PerformanceMonitoringService;
    globalConfig: RabiGlobalConfigStore;
    gatewayExists: (gatewayId: string) => boolean;
    readWorkerPool: ManagerReadWorkerPool;
  }) {
    this.unsubscribe = context.service.store.subscribe(sample => {
      const frame = `event: sample\ndata: ${JSON.stringify({ time: sample.time, source: sample.source })}\n\n`;
      for (const stream of [...this.streams]) {
        if (stream.writableEnded || stream.destroyed) this.streams.delete(stream);
        else stream.write(frame);
      }
    });
  }

  handle(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
    if (!requestUrl.pathname.startsWith("/api/performance/")) return false;

    if (request.method === "GET" && requestUrl.pathname === "/api/performance/config") {
      jsonResponse(response, 200, { code: 0, data: this.context.service.configSnapshot() });
      return true;
    }

    if (request.method === "PATCH" && requestUrl.pathname === "/api/performance/config") {
      void readJsonBody(request, 16 * 1024)
        .then(body => {
          const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
          const current = this.context.globalConfig.read().performance;
          const performance = normalizePerformanceMonitoringConfig({ ...current, ...source });
          const saved = this.context.globalConfig.patch({ performance }).performance;
          this.context.service.applyConfig(saved);
          jsonResponse(response, 200, { code: 0, data: saved });
        })
        .catch(error => jsonResponse(response, 400, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/performance/batches") {
      void readJsonBody(request)
        .then(body => {
          const candidate = body as { samples?: unknown[] };
          const samples = Array.isArray(candidate?.samples) ? candidate.samples : [body];
          let accepted = 0;
          for (const item of samples) {
            const sample = item as PerformanceSample;
            if (sample?.source?.kind === "manager") continue;
            if (sample?.source?.kind === "gateway") {
              if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) continue;
              if (!this.context.gatewayExists(sample.source.id)) continue;
            }
            if (sample?.source?.kind !== "gateway" && sample?.source?.kind !== "webgui") continue;
            if (this.context.service.ingest(sample)) accepted += 1;
          }
          jsonResponse(response, accepted ? 202 : 400, {
            code: accepted ? 0 : -1,
            accepted,
            rejected: samples.length - accepted
          });
        })
        .catch(error => jsonResponse(response, 400, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/performance/summary") {
      const rangeMs = Number(requestUrl.searchParams.get("rangeMs") || 60 * 60 * 1_000);
      try {
        jsonResponse(response, 200, { code: 0, data: this.context.service.summary(rangeMs) });
      } catch (error) {
        jsonResponse(response, 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/performance/logs") {
      const requestedLimit = Number(requestUrl.searchParams.get("limit") || 100);
      const limit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100;
      try {
        jsonResponse(response, 200, {
          code: 0,
          data: this.context.service.store.recent(limit),
          status: this.context.service.store.status()
        });
      } catch (error) {
        jsonResponse(response, 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/performance/status") {
      jsonResponse(response, 200, {
        code: 0,
        data: this.context.service.store.status(),
        config: this.context.service.configSnapshot()
      });
      return true;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/performance/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
      this.streams.add(response);
      // event-driven-allow: SSE protocol keepalive; no performance or business state is queried.
      const keepAlive = setInterval(() => {
        if (!response.writableEnded) response.write(`: keepalive ${Date.now()}\n\n`);
      }, 15_000);
      keepAlive.unref();
      request.once("close", () => {
        clearInterval(keepAlive);
        this.streams.delete(response);
      });
      return true;
    }

    jsonResponse(response, 404, { code: -1, message: "Performance API route not found." });
    return true;
  }

  close(): void {
    this.unsubscribe();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }
}
