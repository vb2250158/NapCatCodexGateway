import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import type { PersonaSyncRouteContext } from "./personaSyncRoutes.js";
import { handlePersonaSyncApi } from "./personaSyncRoutes.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";

export type PersonaSyncLanStatus = {
  state: "disabled" | "starting" | "listening" | "error";
  port?: number;
  urls: string[];
  error?: string;
};

export type PersonaSyncLanServerOptions = {
  peerHandler?: (request: http.IncomingMessage, url: URL, response: http.ServerResponse) => boolean;
  host?: string;
  port?: number;
  addresses?: () => string[];
  onStatus?: (status: PersonaSyncLanStatus) => void;
};

function privateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

export function personaSyncLanAddresses(): string[] {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === "IPv4" && !entry.internal && privateIpv4(entry.address))
    .map(entry => entry.address)))].sort();
}

function dataPlaneRequest(method: string | undefined, pathname: string): boolean {
  if (method === "GET" && pathname === "/api/persona-sync/manifest") return true;
  if (method === "GET" && /^\/api\/persona-sync\/files\/[^/]+\/.+/.test(pathname)) return true;
  return method === "POST" && new Set([
    "/api/persona-sync/merge",
    "/api/persona-sync/plan-packages/active",
    "/api/persona-sync/plan-packages/archive"
  ]).has(pathname);
}

export class PersonaSyncLanServer {
  private server: http.Server | null = null;
  private startFlight: Promise<void> | null = null;
  private startGeneration = 0;
  private cancelStart: (() => void) | null = null;
  private stopFlight: Promise<void> | null = null;
  private readonly connections = new Set<Socket>();
  private readonly connectionDrainWaiters = new Set<() => void>();
  private runtimeStatus: PersonaSyncLanStatus = { state: "disabled", urls: [] };
  private readonly host: string;
  private readonly port: number;
  private readonly addresses: () => string[];

  constructor(
    private readonly context: PersonaSyncRouteContext,
    private readonly options: PersonaSyncLanServerOptions = {}
  ) {
    this.host = options.host?.trim() || "0.0.0.0";
    const requestedPort = Number(options.port ?? 0);
    this.port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535 ? requestedPort : 0;
    this.addresses = options.addresses ?? personaSyncLanAddresses;
  }

  status(): PersonaSyncLanStatus {
    return { ...this.runtimeStatus, urls: [...this.runtimeStatus.urls] };
  }

  peerUrls(): string[] {
    return this.status().urls;
  }

  start(): Promise<void> {
    if (this.stopFlight) return this.stopFlight.then(() => this.start());
    if (this.runtimeStatus.state === "listening") return Promise.resolve();
    if (this.startFlight) return this.startFlight;
    const generation = ++this.startGeneration;
    this.updateStatus({ state: "starting", urls: [] });
    let cancel = (): void => {};
    const flight = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      cancel = () => finish();
      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url || "/", "http://persona-sync.local");
        if (requestUrl.pathname === "/api/rabilink/peer/receive" && this.options.peerHandler?.(request, requestUrl, response)) return;
        if (!dataPlaneRequest(request.method, requestUrl.pathname)) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ code: -1, message: "This LAN listener only exposes persona synchronization data-plane APIs." }));
          return;
        }
        try {
          if (!handlePersonaSyncApi(request, requestUrl, response, this.context)) {
            response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(JSON.stringify(errorResponsePresentation({ code: -1, message: "Not found" }, 404)));
          }
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(errorResponsePresentation({ code: -1, message: error instanceof Error ? error.message : String(error) }, 500)));
        }
      });
      server.on("connection", socket => {
        this.connections.add(socket);
        socket.once("close", () => {
          this.connections.delete(socket);
          if (this.connections.size === 0) {
            for (const resolve of this.connectionDrainWaiters) resolve();
            this.connectionDrainWaiters.clear();
          }
        });
      });
      this.server = server;
      const current = (): boolean => generation === this.startGeneration && this.server === server;
      const fail = (error: Error) => {
        if (!current()) {
          server.close();
          finish();
          return;
        }
        this.server = null;
        this.updateStatus({ state: "error", urls: [], error: error.message });
        finish(error);
      };
      server.once("error", fail);
      server.listen(this.port, this.host, () => {
        server.off("error", fail);
        if (!current()) {
          finish();
          return;
        }
        server.on("error", error => {
          if (!current()) return;
          this.updateStatus({ state: "error", urls: [], error: error.message });
        });
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        const urls = port > 0 ? this.addresses().map(host => `http://${host}:${port}`) : [];
        this.updateStatus({ state: "listening", port, urls });
        finish();
      });
    });
    this.startFlight = flight;
    this.cancelStart = cancel;
    void flight.finally(() => {
      if (generation !== this.startGeneration) return;
      if (this.startFlight === flight) this.startFlight = null;
      if (this.cancelStart === cancel) this.cancelStart = null;
    }).catch(() => {});
    return flight;
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    this.startGeneration += 1;
    const server = this.server;
    const startFlight = this.startFlight;
    this.server = null;
    this.cancelStart?.();
    this.cancelStart = null;
    this.startFlight = null;
    this.updateStatus({ state: "disabled", urls: [] });
    const stopFlight = (async () => {
      if (server) await this.closeServer(server);
      await startFlight?.catch(() => {});
      await this.waitForConnections();
    })();
    const tracked = stopFlight.finally(() => {
      if (this.stopFlight === tracked) this.stopFlight = null;
    });
    this.stopFlight = tracked;
    return tracked;
  }

  private closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections?.();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }
    });
  }

  private waitForConnections(): Promise<void> {
    if (this.connections.size === 0) return Promise.resolve();
    return new Promise(resolve => this.connectionDrainWaiters.add(resolve));
  }

  private updateStatus(status: PersonaSyncLanStatus): void {
    this.runtimeStatus = status;
    this.options.onStatus?.(this.status());
  }
}
