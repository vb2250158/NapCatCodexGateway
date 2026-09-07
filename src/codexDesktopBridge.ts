import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalCodexWorkspacePath } from "./codexTaskIdentity.js";

export type CodexDesktopSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexDesktopReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type CodexDesktopThread = {
  id: string;
  /** Name shown in the Codex Desktop left sidebar; empty when the index has no Name. */
  title: string;
  /** Raw SQLite metadata retained only for diagnostics; never use for name decisions. */
  stateTitle?: string;
  cwd: string;
  updatedAt: string;
  rolloutPath: string;
  firstUserMessage: string;
  archived?: boolean;
};

type CodexDesktopThreadRow = {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  rollout_path?: unknown;
  updated_at?: unknown;
  updated_at_ms?: unknown;
  recency_at?: unknown;
  recency_at_ms?: unknown;
  archived?: unknown;
  first_user_message?: unknown;
};

type IpcResponse = {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  result?: unknown;
  error?: string;
};

type IpcMessage = IpcResponse | {
  type: "broadcast";
  method: string;
  params?: unknown;
} | {
  type: "client-discovery-request";
  requestId: string;
};

type PendingRequest = {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const desktopIpcProtocolVersion = {
  followerSteerTurn: 1,
  followerStartTurn: 2
} as const;

export type CodexDesktopDelivery = {
  threadId: string;
  action: "started" | "steered";
  openedThread: boolean;
  transport: "desktop-ipc";
};

export type CodexDesktopDeliveryStage =
  | "queued"
  | "queue_released"
  | "model_checked"
  | "model_rejected"
  | "steer_requested"
  | "steer_accepted"
  | "steer_rejected"
  | "start_fallback"
  | "start_requested"
  | "start_accepted"
  | "start_rejected"
  | "delivery_receipt_confirmed"
  | "delivery_receipt_missing"
  | "delivery_unconfirmed"
  | "delivery_accepted"
  | "owner_load_retry";

export type CodexDesktopDeliveryEvent = {
  stage: CodexDesktopDeliveryStage;
  threadId: string;
  deliveryMarker?: string;
  method?: "thread-follower-steer-turn" | "thread-follower-start-turn";
  action?: "started" | "steered";
  attempt?: number;
  openedThread?: boolean;
  payloadShape?: "turnStart.request+context";
  protocolVersion?: number;
  error?: string;
  requestId?: string;
  elapsedMs?: number;
  receiptWaitMs?: number;
  model?: string;
  modelSource?: "request" | "desktop-owner";
  outcome?: "accepted" | "rejected" | "timeout" | "confirmed" | "unconfirmed";
};

export type CodexDesktopBridgeOptions = {
  pipePaths?: string[];
  requestTimeoutMs?: number;
  deliveryReceiptGraceMs?: number;
  deliveryReceiptPollMs?: number;
  deliveryReceiptReader?: (threadId: string, marker: string) => boolean | Promise<boolean>;
  loadRetryAttempts?: number;
  loadRetryDelayMs?: number;
  openThread?: (threadId: string) => Promise<void>;
  onBroadcast?: (message: Extract<IpcMessage, { type: "broadcast" }>) => void;
  onDeliveryEvent?: (event: CodexDesktopDeliveryEvent) => void;
};

type CodexDesktopTurnDelivery = {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexDesktopSandbox;
  model?: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
  imagePaths?: string[];
};

type CodexSidebarTaskIndexRow = {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function rowUpdatedAtMs(row: CodexDesktopThreadRow): number {
  return numericTime(row.recency_at_ms)
    || numericTime(row.updated_at_ms)
    || numericTime(row.recency_at) * 1000
    || numericTime(row.updated_at) * 1000;
}

function codexDesktopSessionIndexPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "session_index.jsonl");
}

/**
 * Applies the task names shown by Codex Desktop's left sidebar. SQLite
 * `threads.title` is only owner state metadata and may contain the first
 * prompt, so it must never overwrite the sidebar name exposed to callers.
 */
export function applyCodexSidebarTaskNamesForTest(
  threads: CodexDesktopThread[],
  sessionIndexContent: string
): CodexDesktopThread[] {
  const latestById = new Map<string, { title: string; updatedAt: string }>();
  for (const line of sessionIndexContent.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as CodexSidebarTaskIndexRow;
      const id = nonEmptyString(row.id);
      const title = nonEmptyString(row.thread_name);
      const updatedAt = nonEmptyString(row.updated_at);
      if (!id || !title) continue;
      const current = latestById.get(id);
      const candidateTime = Date.parse(updatedAt);
      const currentTime = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
      if (!current
        || !Number.isFinite(currentTime)
        || (Number.isFinite(candidateTime) && candidateTime >= currentTime)) {
        latestById.set(id, { title, updatedAt });
      }
    } catch {
      // Ignore incomplete records while Desktop is appending the index.
    }
  }
  return threads.map((thread) => {
    const sidebar = latestById.get(thread.id);
    return {
      ...thread,
      stateTitle: thread.stateTitle ?? thread.title,
      title: sidebar?.title ?? "",
      updatedAt: sidebar?.updatedAt || thread.updatedAt
    };
  });
}

function applyCodexSidebarTaskNames(
  threads: CodexDesktopThread[],
  sessionIndexPath = codexDesktopSessionIndexPath()
): CodexDesktopThread[] {
  if (!fs.existsSync(sessionIndexPath)) return applyCodexSidebarTaskNamesForTest(threads, "");
  return applyCodexSidebarTaskNamesForTest(threads, fs.readFileSync(sessionIndexPath, "utf8"));
}

export function listCodexDesktopThreadsFromRowsForTest(
  rows: CodexDesktopThreadRow[],
  options: { query?: string; limit?: number; offset?: number; allowedWorkspaces?: string[]; includeArchived?: boolean } = {}
): CodexDesktopThread[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const allowed = new Set((options.allowedWorkspaces ?? []).filter(Boolean).map(canonicalCodexWorkspacePath));
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 20) || 20));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  const byId = new Map<string, CodexDesktopThread>();

  for (const row of rows) {
    const id = nonEmptyString(row.id);
    const title = nonEmptyString(row.title) || id;
    const cwd = nonEmptyString(row.cwd);
    const rolloutPath = nonEmptyString(row.rollout_path);
    const updatedAtMs = rowUpdatedAtMs(row);
    const archived = Number(row.archived ?? 0) !== 0;
    if (!id || (archived && !options.includeArchived)) continue;
    if (query && !title.toLocaleLowerCase().includes(query)) continue;
    if (allowed.size > 0 && (!cwd || !allowed.has(canonicalCodexWorkspacePath(cwd)))) continue;

    const candidate = {
      id,
      title,
      cwd,
      rolloutPath,
      firstUserMessage: nonEmptyString(row.first_user_message),
      updatedAt: new Date(updatedAtMs).toISOString(),
      archived
    };
    const current = byId.get(id);
    if (!current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)) byId.set(id, candidate);
  }

  return [...byId.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(offset, offset + limit);
}

function codexStateRoots(): string[] {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const sqliteHome = process.env.CODEX_SQLITE_HOME?.trim();
  return [...new Set([sqliteHome, codexHome].filter(Boolean) as string[])];
}

export function findCodexDesktopStateDatabase(): string | null {
  const candidates: Array<{ filePath: string; version: number; modifiedAt: number }> = [];
  for (const root of codexStateRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (!match) continue;
      const filePath = path.join(root, name);
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, version: Number(match[1]), modifiedAt: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.version - left.version || right.modifiedAt - left.modifiedAt);
  return candidates[0]?.filePath ?? null;
}

function readDesktopThreadRows(databasePath: string): CodexDesktopThreadRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT id, title, cwd, rollout_path, updated_at, updated_at_ms,
             recency_at, recency_at_ms, archived, first_user_message
      FROM threads
      ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), recency_at * 1000, updated_at * 1000) DESC
      LIMIT 10000
    `).all() as CodexDesktopThreadRow[];
  } finally {
    database.close();
  }
}

export function listCodexDesktopThreads(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces?: string[];
  databasePath?: string;
  sessionIndexPath?: string;
} = {}): CodexDesktopThread[] {
  const databasePath = options.databasePath ?? findCodexDesktopStateDatabase();
  if (!databasePath) return [];
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 20) || 20));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  return applyCodexSidebarTaskNames(listCodexDesktopThreadsFromRowsForTest(
    readDesktopThreadRows(databasePath),
    { ...options, query: "", limit: 10_000, offset: 0 }
  ), options.sessionIndexPath)
    .filter((thread) => !query || thread.title.toLocaleLowerCase().includes(query))
    .slice(offset, offset + limit);
}

export function readCodexDesktopThread(
  threadId: string,
  databasePath = findCodexDesktopStateDatabase(),
  sessionIndexPath = codexDesktopSessionIndexPath()
): CodexDesktopThread | null {
  if (!databasePath) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT id, title, cwd, rollout_path, updated_at, updated_at_ms,
             recency_at, recency_at_ms, archived, first_user_message
      FROM threads WHERE id = ? LIMIT 1
    `).get(threadId) as CodexDesktopThreadRow | undefined;
    if (!row) return null;
    const thread = listCodexDesktopThreadsFromRowsForTest([row], { limit: 1, includeArchived: true })[0] ?? null;
    return thread ? applyCodexSidebarTaskNames([thread], sessionIndexPath)[0] ?? null : null;
  } finally {
    database.close();
  }
}

export function codexDesktopDeepLinkForTest(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export async function openCodexDesktopThread(threadId: string): Promise<void> {
  const deepLink = codexDesktopDeepLinkForTest(threadId);
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [deepLink], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
}

function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function responseError(response: IpcResponse, method: string): Error | null {
  return response.resultType === "success"
    ? null
    : new Error(`Codex Desktop IPC ${method} failed: ${response.error || "unknown-error"}`);
}

function diagnosticErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDesktopOwnerLoading(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found")
    || text.includes("no rollout found for thread id");
}

function isInactiveTurn(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("SteerTurnInactiveError")
    || text.includes("NoActiveTurn")
    || text.includes("active turn already ended")
    || text.includes("no active turn to steer")
    || text.includes("not being streamed");
}

function isTurnDeliveryTimeout(error: unknown, method: "thread-follower-steer-turn" | "thread-follower-start-turn"): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(`IPC request timed out: ${method}`)
    || text.includes(`${method}-timeout`);
}

export function agentDeliveryMarkerForTest(prompt: string): string {
  return /\bdeliveryId[：:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(prompt)?.[1] ?? "";
}

function rolloutTailContainsMarker(filePath: string, marker: string, maxBytes = 4 * 1024 * 1024): boolean {
  if (!marker || !fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  if (length <= 0) return false;
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.includes(Buffer.from(marker, "utf8"));
  } finally {
    fs.closeSync(handle);
  }
}

export function codexDesktopRolloutContainsDeliveryMarker(threadId: string, marker: string): boolean {
  const thread = readCodexDesktopThread(threadId);
  return Boolean(thread?.rolloutPath && rolloutTailContainsMarker(thread.rolloutPath, marker));
}

function defaultDeliveryReceiptReader(threadId: string, marker: string): boolean {
  return codexDesktopRolloutContainsDeliveryMarker(threadId, marker);
}

export class CodexDesktopBridge {
  private readonly options: Required<Pick<CodexDesktopBridgeOptions,
    "requestTimeoutMs" | "deliveryReceiptGraceMs" | "deliveryReceiptPollMs" | "deliveryReceiptReader" | "loadRetryAttempts" | "loadRetryDelayMs" | "openThread">> & CodexDesktopBridgeOptions;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private clientId = "initializing-client";
  private readBuffer = Buffer.alloc(0);
  private nextFrameLength: number | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeThreads = new Set<string>();
  private readonly activeThreadSinceMs = new Map<string, number>();
  private readonly deliveryQueues = new Map<string, Promise<CodexDesktopDelivery>>();
  private readonly snapshotReaders = new Map<string, (state: Record<string, any>) => void>();

  constructor(options: CodexDesktopBridgeOptions = {}) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      deliveryReceiptGraceMs: Math.max(0, options.deliveryReceiptGraceMs ?? 5_000),
      deliveryReceiptPollMs: Math.max(10, options.deliveryReceiptPollMs ?? 250),
      deliveryReceiptReader: options.deliveryReceiptReader ?? defaultDeliveryReceiptReader,
      loadRetryAttempts: Math.max(1, options.loadRetryAttempts ?? 24),
      loadRetryDelayMs: Math.max(1, options.loadRetryDelayMs ?? 1_000),
      openThread: options.openThread ?? openCodexDesktopThread
    };
  }

  private pipePaths(): string[] {
    if (this.options.pipePaths?.length) return this.options.pipePaths;
    return [...new Set([
      process.env.CODEX_DESKTOP_IPC_PATH?.trim(),
      process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(os.tmpdir(), "codex-ipc", `ipc-${process.getuid?.() ?? "user"}.sock`)
    ].filter(Boolean) as string[])];
  }

  private write(message: unknown): void {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    this.socket.write(encodeFrame(message));
  }

  private handleData(data: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, data]);
    for (;;) {
      if (this.nextFrameLength == null) {
        if (this.readBuffer.length < 4) return;
        this.nextFrameLength = this.readBuffer.readUInt32LE(0);
        this.readBuffer = this.readBuffer.subarray(4);
      }
      if (this.readBuffer.length < this.nextFrameLength) return;
      const frame = this.readBuffer.subarray(0, this.nextFrameLength);
      this.readBuffer = this.readBuffer.subarray(this.nextFrameLength);
      this.nextFrameLength = null;
      this.handleMessage(JSON.parse(frame.toString("utf8")) as IpcMessage);
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type === "broadcast") {
      if (message.method === "thread-stream-state-changed" && message.params && typeof message.params === "object") {
        const params = message.params as { conversationId?: unknown; threadId?: unknown; change?: unknown };
        const threadId = nonEmptyString(params.conversationId) || nonEmptyString(params.threadId);
        const snapshot = params.change as { type?: string; conversationState?: Record<string, any> } | undefined;
        if (snapshot?.type === "snapshot" && snapshot.conversationState) {
          this.snapshotReaders.get(threadId)?.(snapshot.conversationState);
        }
        const change = JSON.stringify(params.change ?? params);
        if (threadId && (change.includes('"threadRuntimeStatus":{"type":"active"') || change.includes('"status":"inProgress"'))) {
          this.activeThreads.add(threadId);
          this.activeThreadSinceMs.set(threadId, Date.now());
        } else if (threadId && (
          change.includes('"threadRuntimeStatus":{"type":"idle"')
          || change.includes('"status":"completed"')
          || change.includes('"status":"failed"')
          || change.includes('"status":"interrupted"')
        )) {
          this.activeThreads.delete(threadId);
          this.activeThreadSinceMs.delete(threadId);
        }
      }
      this.options.onBroadcast?.(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private async connectPath(pipePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(pipePath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        socket.unref();
        this.readBuffer = Buffer.alloc(0);
        this.nextFrameLength = null;
        socket.on("data", (data) => this.handleData(data));
        socket.on("error", (error) => this.rejectPending(error));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = null;
          this.clientId = "initializing-client";
          this.activeThreads.clear();
          this.activeThreadSinceMs.clear();
          this.rejectPending(new Error("Codex Desktop IPC connection closed"));
        });
        resolve();
      });
    });
  }

  async connect(): Promise<void> {
    if (this.socket?.writable && this.clientId !== "initializing-client") return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const errors: string[] = [];
      for (const pipePath of this.pipePaths()) {
        try {
          await this.connectPath(pipePath);
          const response = await this.request("initialize", { clientType: "rabiroute" }, 0, true);
          const result = response.result as { clientId?: unknown } | undefined;
          if (response.resultType !== "success" || typeof result?.clientId !== "string") {
            throw new Error(response.error || "initialize did not return clientId");
          }
          this.clientId = result.clientId;
          return;
        } catch (error) {
          this.socket?.destroy();
          this.socket = null;
          errors.push(`${pipePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Codex Desktop 未就绪。RabiRoute 只连接 Desktop IPC，不会启动备用 Runtime。${errors.length ? ` ${errors.join("; ")}` : ""}`);
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async request(method: string, params: unknown, version = 1, beforeInitialized = false, requestId = randomUUID()): Promise<IpcResponse> {
    if (!beforeInitialized) await this.connect();
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.write({
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params
    });
    return response;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  isThreadActive(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  threadActiveSince(threadId: string): number | null {
    return this.activeThreadSinceMs.get(threadId) ?? null;
  }

  private turnInput(prompt: string, imagePaths: string[] = []): Array<Record<string, unknown>> {
    return [
      { type: "text", text: prompt, text_elements: [] },
      ...imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath }))
    ];
  }

  private imageAttachments(imagePaths: string[] = []): Array<Record<string, unknown>> {
    return imagePaths.map((imagePath) => ({
      id: randomUUID(),
      src: imagePath,
      localPath: imagePath,
      filename: path.basename(imagePath),
      uploadStatus: "idle"
    }));
  }

  private emitDeliveryEvent(event: CodexDesktopDeliveryEvent): void {
    try {
      this.options.onDeliveryEvent?.(event);
    } catch {
      // Diagnostics must not alter the Desktop-owner delivery result.
    }
  }

  private deliveryMarker(params: CodexDesktopTurnDelivery): string | undefined {
    return agentDeliveryMarkerForTest(params.prompt) || undefined;
  }

  private deliveryEvent(
    params: CodexDesktopTurnDelivery,
    stage: CodexDesktopDeliveryStage,
    extra: Omit<CodexDesktopDeliveryEvent, "stage" | "threadId" | "deliveryMarker"> = {}
  ): void {
    this.emitDeliveryEvent({
      stage,
      threadId: params.threadId,
      ...(this.deliveryMarker(params) ? { deliveryMarker: this.deliveryMarker(params) } : {}),
      ...extra
    });
  }

  private async confirmDeliveryReceipt(params: CodexDesktopTurnDelivery): Promise<boolean> {
    const marker = agentDeliveryMarkerForTest(params.prompt);
    if (!marker) return false;
    const deadline = Date.now() + this.options.deliveryReceiptGraceMs;
    do {
      if (await this.options.deliveryReceiptReader(params.threadId, marker)) return true;
      if (Date.now() >= deadline) return false;
      await wait(Math.min(this.options.deliveryReceiptPollMs, Math.max(1, deadline - Date.now())));
    } while (true);
  }

  private async deliveryReceiptConfirmed(params: CodexDesktopTurnDelivery): Promise<boolean> {
    const marker = this.deliveryMarker(params);
    if (!marker) return true;
    const startedAt = Date.now();
    const confirmed = await this.confirmDeliveryReceipt(params);
    this.deliveryEvent(params, confirmed ? "delivery_receipt_confirmed" : "delivery_receipt_missing", {
      elapsedMs: Date.now() - startedAt,
      receiptWaitMs: this.options.deliveryReceiptGraceMs,
      outcome: confirmed ? "confirmed" : "unconfirmed"
    });
    return confirmed;
  }

  private unconfirmedDelivery(params: CodexDesktopTurnDelivery, method: CodexDesktopDeliveryEvent["method"], error?: unknown): Error {
    const message = `Codex Desktop delivery unconfirmed for ${params.threadId}: ${method}. The message may already be accepted; no automatic resend was attempted. Read the original task before retrying.${error ? ` Original error: ${diagnosticErrorMessage(error)}` : ""}`;
    this.deliveryEvent(params, "delivery_unconfirmed", { method, outcome: "unconfirmed", error: message });
    const result = new Error(message);
    result.name = "CodexDesktopDeliveryUnconfirmedError";
    return result;
  }

  private async steer(params: CodexDesktopTurnDelivery): Promise<boolean> {
    const imageAttachments = this.imageAttachments(params.imagePaths);
    const method = "thread-follower-steer-turn";
    const requestId = randomUUID();
    const startedAt = Date.now();
    this.deliveryEvent(params, "steer_requested", { method, requestId, protocolVersion: desktopIpcProtocolVersion.followerSteerTurn });
    try {
      const response = await this.request(method, {
        conversationId: params.threadId,
        input: this.turnInput(params.prompt, params.imagePaths),
        attachments: [],
        restoreMessage: {
          id: randomUUID(),
          text: params.prompt,
          context: {
            prompt: params.prompt,
            addedFiles: [],
            fileAttachments: [],
            imageAttachments,
            workspaceRoots: [params.cwd]
          },
          cwd: params.cwd,
          createdAt: Date.now()
        }
      }, desktopIpcProtocolVersion.followerSteerTurn, false, requestId);
      const error = responseError(response, method);
      if (error) throw error;
      this.deliveryEvent(params, "steer_accepted", { method, requestId, elapsedMs: Date.now() - startedAt, outcome: "accepted" });
      return false;
    } catch (error) {
      const timedOut = isTurnDeliveryTimeout(error, method);
      this.deliveryEvent(params, "steer_rejected", { method, requestId, elapsedMs: Date.now() - startedAt, outcome: timedOut ? "timeout" : "rejected", error: diagnosticErrorMessage(error) });
      if (timedOut) {
        if (this.deliveryMarker(params) && await this.deliveryReceiptConfirmed(params)) return true;
        throw this.unconfirmedDelivery(params, method, error);
      }
      throw error;
    }
  }

  /** Read the live owner, never a cached rollout or an independently resumed runtime. */
  async readThreadModel(threadId: string): Promise<string> {
    await this.connect();
    if (this.snapshotReaders.has(threadId)) throw new Error("Codex Desktop model check already pending");
    let timer: NodeJS.Timeout | undefined;
    const following = (value: boolean) => this.write({
      type: "broadcast", sourceClientId: this.clientId, version: 1,
      method: "thread-stream-following-changed",
      params: { conversationId: threadId, hostId: "local", following: value }
    });
    try {
      const snapshot = new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Codex Desktop 未返回任务模型设置；消息未发送，请打开目标任务后重试。")), Math.min(this.options.requestTimeoutMs, 3_000));
        this.snapshotReaders.set(threadId, (state) => {
          const collaboration = state.latestThreadSettings?.collaborationMode ?? state.latestCollaborationMode;
          // Collaboration settings override the model in Desktop's turn/start preparation.
          const model = collaboration != null
            ? collaboration.settings?.model
            : state.latestThreadSettings?.model ?? state.latestModel;
          resolve(nonEmptyString(model));
        });
      });
      following(true);
      return await snapshot;
    } finally {
      clearTimeout(timer);
      this.snapshotReaders.delete(threadId);
      if (this.socket && !this.socket.destroyed) following(false);
    }
  }

  private async checkStartModel(params: CodexDesktopTurnDelivery): Promise<void> {
    const startedAt = Date.now();
    const modelSource = params.model === undefined ? "desktop-owner" : "request";
    try {
      const model = params.model === undefined ? await this.readThreadModel(params.threadId) : nonEmptyString(params.model);
      if (!model) throw new Error("Codex Desktop 任务的模型名称为空；消息未发送。请在该任务选择模型后重试。");
      this.deliveryEvent(params, "model_checked", { model, modelSource, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      this.deliveryEvent(params, "model_rejected", { modelSource, elapsedMs: Date.now() - startedAt, error: diagnosticErrorMessage(error) });
      const failure = new Error(diagnosticErrorMessage(error));
      failure.name = "CodexDesktopModelSettingsError";
      throw failure;
    }
  }

  private startTurnEnvelope(params: CodexDesktopTurnDelivery): Record<string, unknown> {
    const request: Record<string, unknown> = {
      threadId: params.threadId,
      clientUserMessageId: randomUUID(),
      input: this.turnInput(params.prompt, params.imagePaths),
      cwd: params.cwd
    };
    const model = nonEmptyString(params.model);
    if (model) {
      const effort = params.reasoningEffort ?? "medium";
      request.model = model;
      request.effort = effort;
      request.collaborationMode = {
        mode: "default",
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: ""
        }
      };
    }
    return {
      request,
      context: {
        attachments: [],
        commentAttachments: []
      }
    };
  }

  private async start(params: CodexDesktopTurnDelivery): Promise<boolean> {
    await this.checkStartModel(params);
    const method = "thread-follower-start-turn";
    const requestId = randomUUID();
    const startedAt = Date.now();
    this.deliveryEvent(params, "start_requested", {
      method,
      requestId,
      payloadShape: "turnStart.request+context",
      protocolVersion: desktopIpcProtocolVersion.followerStartTurn
    });
    try {
      const response = await this.request(method, {
        conversationId: params.threadId,
        turnStart: this.startTurnEnvelope(params)
      }, desktopIpcProtocolVersion.followerStartTurn, false, requestId);
      const error = responseError(response, method);
      if (error) throw error;
      this.deliveryEvent(params, "start_accepted", { method, requestId, elapsedMs: Date.now() - startedAt, outcome: "accepted", action: "started" });
      return false;
    } catch (error) {
      const timedOut = isTurnDeliveryTimeout(error, method);
      this.deliveryEvent(params, "start_rejected", { method, requestId, elapsedMs: Date.now() - startedAt, outcome: timedOut ? "timeout" : "rejected", error: diagnosticErrorMessage(error) });
      if (timedOut) {
        if (this.deliveryMarker(params) && await this.deliveryReceiptConfirmed(params)) return true;
        throw this.unconfirmedDelivery(params, method, error);
      }
      throw error;
    }
  }

  private async deliverToOwner(params: CodexDesktopTurnDelivery): Promise<"started" | "steered"> {
    try {
      const steerReceiptConfirmed = await this.steer(params);
      if (steerReceiptConfirmed || await this.deliveryReceiptConfirmed(params)) return "steered";
      // A delayed rollout is not proof of non-delivery. Starting again can duplicate accepted input.
      throw this.unconfirmedDelivery(params, "thread-follower-steer-turn");
    } catch (error) {
      if (error instanceof Error && error.name === "CodexDesktopDeliveryUnconfirmedError") throw error;
      if (!isInactiveTurn(error)) throw error;
      this.deliveryEvent(params, "start_fallback", {
        method: "thread-follower-steer-turn",
        error: diagnosticErrorMessage(error)
      });
    }
    const startReceiptConfirmed = await this.start(params);
    if (!startReceiptConfirmed && !await this.deliveryReceiptConfirmed(params)) {
      throw this.unconfirmedDelivery(params, "thread-follower-start-turn");
    }
    return "started";
  }

  private async deliverNow(params: CodexDesktopTurnDelivery): Promise<CodexDesktopDelivery> {
    let openedThread = false;
    let lastError: unknown;
    const deliveryStartedAtMs = Date.now();
    for (let attempt = 0; attempt < this.options.loadRetryAttempts; attempt += 1) {
      try {
        const action = await this.deliverToOwner(params);
        this.activeThreads.add(params.threadId);
        this.activeThreadSinceMs.set(params.threadId, deliveryStartedAtMs);
        this.deliveryEvent(params, "delivery_accepted", { action, openedThread, elapsedMs: Date.now() - deliveryStartedAtMs });
        return { threadId: params.threadId, action, openedThread, transport: "desktop-ipc" };
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.name === "CodexDesktopDeliveryUnconfirmedError") throw error;
        if (!isDesktopOwnerLoading(error)) throw error;
        if (!openedThread) {
          openedThread = true;
          await this.options.openThread(params.threadId);
        }
        this.deliveryEvent(params, "owner_load_retry", {
          attempt: attempt + 1,
          openedThread,
          error: diagnosticErrorMessage(error)
        });
        if (attempt + 1 < this.options.loadRetryAttempts) await wait(this.options.loadRetryDelayMs);
      }
    }
    throw new Error(`Codex Desktop 只请求打开一次任务 ${params.threadId}，但当前窗口没有加载该任务 owner（工作目录：${params.cwd}）。消息未投递，也没有启动备用 Runtime。请在 Codex Desktop 左侧手动打开目标任务后重试；如果仍停在项目层，请回到 RabiRoute 重新选择任务。原始错误：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  async deliver(params: CodexDesktopTurnDelivery): Promise<CodexDesktopDelivery> {
    const queuedAt = Date.now();
    this.deliveryEvent(params, "queued");
    const key = params.threadId;
    const previous = this.deliveryQueues.get(key);
    const scheduled = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => {
        this.deliveryEvent(params, "queue_released", { elapsedMs: Date.now() - queuedAt });
        return this.deliverNow(params);
      });
    this.deliveryQueues.set(key, scheduled);
    try {
      return await scheduled;
    } finally {
      if (this.deliveryQueues.get(key) === scheduled) this.deliveryQueues.delete(key);
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.clientId = "initializing-client";
    this.activeThreads.clear();
    this.activeThreadSinceMs.clear();
    this.rejectPending(new Error("Codex Desktop bridge closed"));
  }
}
