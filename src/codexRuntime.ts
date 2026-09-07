import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";
import { appendAdapterLog } from "./history.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import {
  CodexDesktopBridge,
  agentDeliveryMarkerForTest,
  listCodexDesktopThreads,
  readCodexDesktopThread,
  type CodexDesktopDelivery,
  type CodexDesktopDeliveryEvent,
  type CodexDesktopReasoningEffort,
  type CodexDesktopThread
} from "./codexDesktopBridge.js";
import { canonicalCodexWorkspacePath, isCodexTaskId, sameCodexWorkspace } from "./codexTaskIdentity.js";
import { normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import {
  resolveAndDeliverCodexSession,
  resolveCodexSession,
  type CodexSessionResolverDependencies
} from "./codexSessionResolver.js";
import {
  readCodexRolloutActivity,
  type CodexRolloutActivity
} from "./codexRolloutActivity.js";
import { rabiRoutePackageVersion } from "./packageInfo.js";

export type CodexMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
  cwd?: string;
};

export type CodexIdleNotificationResult = {
  status: "delivered" | "busy";
  thread: CodexMonitorThread;
};

export type CodexTurnSandbox = "read-only" | "workspace-write" | "danger-full-access";

export function resolvePrimaryCodexTurnOptions(settings: {
  agentModel?: string;
  agentReasoningEffort?: CodexDesktopReasoningEffort;
}): { model?: string; reasoningEffort?: CodexDesktopReasoningEffort } {
  const model = settings.agentModel?.trim();
  return {
    ...(model ? { model } : {}),
    ...(settings.agentReasoningEffort ? { reasoningEffort: settings.agentReasoningEffort } : {})
  };
}

export type CodexThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived?: boolean;
};

export type CodexThreadRuntimeStatus = "active" | "idle" | "notLoaded" | "unavailable";

export type CodexThreadCreateParams = {
  title: string;
  prompt: string;
  cwd: string;
  developerInstructions: string;
  sandbox: CodexTurnSandbox;
  onCreationStage?: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void;
};

export type CodexThreadCreateResult = CodexThreadSummary & {
  source: string;
  initialTurnStatus: "not-requested" | "started" | "failed";
  initialTurnError?: string;
};

type CodexState = {
  monitorThreadId?: string;
  monitorThreadName?: string;
  monitorThreadCwd?: string;
  monitorThreadUpdatedAt?: string;
  monitorThreadSource?: string;
  lastAutoDiscoveryAt?: string;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
  lastDeliveryChannel?: string;
  lastDeliveryId?: string;
  lastDeliveryStatus?: "accepted" | "delivered" | "failed";
  lastDeliveryAcceptedAt?: string;
  lastDeliveryDeliveredAt?: string;
  lastDeliveryFailedAt?: string;
  bindingUpdateRequestedAt?: string;
  bindingPreviousThreadId?: string;
  bindingThreadId?: string;
  bindingThreadName?: string;
  bindingWorkspace?: string;
  desktopHostRequired?: boolean;
};

function logCodexDesktopDeliveryEvent(event: CodexDesktopDeliveryEvent): void {
  const level = event.stage === "start_rejected" || event.stage === "model_rejected"
    ? "error"
    : event.stage === "steer_rejected" || event.stage === "owner_load_retry" || event.stage === "delivery_unconfirmed" || event.stage === "delivery_receipt_missing"
      ? "warning"
      : "info";
  appendAdapterLog("codex", {
    event: `desktop_delivery_${event.stage}`,
    level,
    message: `Codex Desktop delivery stage=${event.stage} threadId=${event.threadId}${event.method ? ` method=${event.method}` : ""}${event.action ? ` action=${event.action}` : ""}`,
    data: event
  });
}

const desktopBridge = new CodexDesktopBridge({ onDeliveryEvent: logCodexDesktopDeliveryEvent });
let memoryState: CodexState = {};
let notificationQueue: Promise<unknown> = Promise.resolve();

process.once("exit", () => desktopBridge.close());

function readState(): CodexState {
  return memoryState;
}

function writeState(state: CodexState): void {
  memoryState = state;
  reportAgentState("codex", state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordCodexFailure(error: unknown, deliveryId?: string): void {
  const failedAt = new Date().toISOString();
  writeState({
    ...readState(),
    lastDeliveryChannel: "desktop-ipc",
    lastDeliveryId: deliveryId ?? readState().lastDeliveryId,
    lastDeliveryStatus: "failed",
    lastDeliveryFailedAt: failedAt,
    desktopHostRequired: true,
    lastNotificationError: errorMessage(error),
    lastNotificationErrorAt: failedAt
  });
}

function recordAcceptedDelivery(deliveryId: string): void {
  const acceptedAt = new Date().toISOString();
  writeState({
    ...readState(),
    lastDeliveryChannel: "desktop-ipc",
    lastDeliveryId: deliveryId,
    lastDeliveryStatus: "accepted",
    lastDeliveryAcceptedAt: acceptedAt,
    lastNotificationError: "",
    lastNotificationErrorAt: "",
    desktopHostRequired: true
  });
}

export function codexThreadMatchesConfiguredTargetForTest(
  thread: { name?: string; cwd?: string },
  threadName: string,
  codexCwd: string
): boolean {
  return thread.name === threadName
    && sameCodexWorkspace(thread.cwd, codexCwd);
}

export function codexThreadDeliveryTargetIsStaleForTest(error: unknown): boolean {
  const message = errorMessage(error).toLocaleLowerCase();
  return message.includes("thread not found")
    || message.includes("task was not found")
    || message.includes("no rollout found for thread id");
}

function codexLaunchCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url))]
  };
}

function createCodexMetadataClient(cwd: string): CodexAppServerClient {
  const launch = codexLaunchCommand();
  return new CodexAppServerClient({
    command: launch.command,
    commandArgs: launch.args,
    cwd,
    dataDir: config.dataDir,
    env: buildCodexBootstrapEnv(),
    clientVersion: rabiRoutePackageVersion()
  });
}

export type CodexModelCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts: Array<{ id: string; description?: string }>;
};

type CodexModelListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

export function normalizeCodexModelListForTest(value: unknown): {
  models: CodexModelCatalogEntry[];
  nextCursor?: string;
} {
  const response = value && typeof value === "object" ? value as CodexModelListResponse : {};
  const models = Array.isArray(response.data)
    ? response.data.flatMap((item): CodexModelCatalogEntry[] => {
        if (!item || typeof item !== "object") return [];
        const raw = item as Record<string, unknown>;
        if (raw.hidden === true) return [];
        const id = typeof raw.model === "string" && raw.model.trim()
          ? raw.model.trim()
          : typeof raw.id === "string"
            ? raw.id.trim()
            : "";
        if (!id) return [];
        const name = typeof raw.displayName === "string" && raw.displayName.trim()
          ? raw.displayName.trim()
          : id;
        const reasoningEfforts = Array.isArray(raw.supportedReasoningEfforts)
          ? raw.supportedReasoningEfforts.flatMap((effort): Array<{ id: string; description?: string }> => {
              if (!effort || typeof effort !== "object") return [];
              const option = effort as Record<string, unknown>;
              const reasoningEffort = typeof option.reasoningEffort === "string" ? option.reasoningEffort.trim() : "";
              if (!reasoningEffort) return [];
              const description = typeof option.description === "string" && option.description.trim()
                ? option.description.trim()
                : undefined;
              return [{ id: reasoningEffort, ...(description ? { description } : {}) }];
            })
          : [];
        const description = typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : undefined;
        const defaultReasoningEffort = typeof raw.defaultReasoningEffort === "string" && raw.defaultReasoningEffort.trim()
          ? raw.defaultReasoningEffort.trim()
          : undefined;
        return [{
          id,
          name,
          ...(description ? { description } : {}),
          ...(raw.isDefault === true ? { isDefault: true } : {}),
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          reasoningEfforts
        }];
      })
    : [];
  const nextCursor = typeof response.nextCursor === "string" && response.nextCursor.trim()
    ? response.nextCursor.trim()
    : undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

export async function listCodexModels(cwd: string, timeoutMs = 8_000): Promise<CodexModelCatalogEntry[]> {
  const client = createCodexMetadataClient(cwd);
  const timer = setTimeout(() => client.close(), Math.max(100, timeoutMs));
  try {
    const byId = new Map<string, CodexModelCatalogEntry>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const parsed = normalizeCodexModelListForTest(await client.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {})
      }));
      for (const model of parsed.models) byId.set(model.id, model);
      if (!parsed.nextCursor) break;
      cursor = parsed.nextCursor;
    }
    return [...byId.values()];
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

type CodexAppServerThreadMetadata = {
  id?: unknown;
  name?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
};

function appServerThreadUpdatedAt(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const timestampMs = value < 1_000_000_000_000 ? value * 1000 : value;
  const parsed = new Date(timestampMs);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function mergeCodexDesktopThreadsWithMetadataForTest(
  localThreads: CodexDesktopThread[],
  metadataThreads: CodexAppServerThreadMetadata[],
  options: { query?: string; limit?: number; offset?: number; allowedWorkspaces?: string[] } = {}
): CodexDesktopThread[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const allowed = new Set((options.allowedWorkspaces ?? []).filter(Boolean).map(canonicalCodexWorkspacePath));
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 20) || 20));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  const localById = new Map(localThreads.map((thread) => [thread.id, thread]));

  return metadataThreads.flatMap((metadata) => {
    const id = typeof metadata.id === "string" ? metadata.id.trim() : "";
    const local = localById.get(id);
    if (!local || local.archived) return [];
    // app-server metadata is used only for identity, workspace, recency, and
    // pagination. The left-sidebar Name already stored in local.title is the
    // only name source.
    const title = local.title;
    const metadataCwd = typeof metadata.cwd === "string" ? metadata.cwd.trim() : "";
    const cwd = metadataCwd || local.cwd;
    if (query && !title.toLocaleLowerCase().includes(query)) return [];
    if (allowed.size > 0 && (!cwd || !allowed.has(canonicalCodexWorkspacePath(cwd)))) return [];
    if (metadataCwd && local.cwd && !sameCodexWorkspace(metadataCwd, local.cwd)) return [];
    return [{
      ...local,
      title,
      cwd,
      updatedAt: appServerThreadUpdatedAt(metadata.updatedAt, local.updatedAt)
    }];
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(offset, offset + limit);
}

type CodexTaskBootstrap = {
  client: CodexAppServerClient;
  threadId: string;
};

/**
 * The bootstrap process is only used to create an empty persistent task when a
 * user typed a new title. It never executes the user's prompt. Actual turns are
 * always started by the Desktop owner over Desktop IPC.
 */
export function buildCodexBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  delimiter: string = path.delimiter
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase() === "path") ?? "PATH";
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toLocaleLowerCase();
    if (normalizedKey !== "path" && normalizedKey !== "codex_app_server_ws_url") nextEnv[key] = value;
  }
  nextEnv[pathKey] = [path.dirname(execPath), env[pathKey] || ""].filter(Boolean).join(delimiter);
  return nextEnv;
}

async function bootstrapEmptyDesktopThread(params: CodexThreadCreateParams): Promise<CodexTaskBootstrap> {
  const client = createCodexMetadataClient(params.cwd);
  try {
    const result = await client.request("thread/start", {
      cwd: params.cwd,
      sandbox: params.sandbox,
      ephemeral: false,
      serviceName: "rabiroute-desktop-bootstrap",
      developerInstructions: params.developerInstructions
    }) as { thread?: { id?: string } };
    const threadId = result.thread?.id;
    if (!threadId) throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
    params.onCreationStage?.("thread_created", threadId);
    params.onCreationStage?.("naming", threadId);
    await client.request("thread/name/set", { threadId, name: params.title });
    return { client, threadId };
  } catch (error) {
    client.close();
    throw error;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForDesktopFirstMessage(threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readCodexDesktopThread(threadId)?.firstUserMessage) return;
    await wait(100);
  }
}

async function setCodexTaskName(
  threadId: string,
  title: string,
  cwd: string,
  existingClient?: CodexAppServerClient
): Promise<void> {
  const client = existingClient ?? createCodexMetadataClient(cwd);
  try {
    await client.request("thread/name/set", { threadId, name: title });
  } finally {
    if (!existingClient) client.close();
  }
}

export function ensureCodexDesktopDeliveryMarkerForTest(
  prompt: string,
  requestedDeliveryId?: string
): { prompt: string; deliveryId: string } {
  const existingDeliveryId = agentDeliveryMarkerForTest(prompt);
  if (existingDeliveryId) return { prompt, deliveryId: existingDeliveryId };
  const deliveryId = requestedDeliveryId || randomUUID();
  return {
    prompt: `${prompt.trimEnd()}\n\n[投递编号]\ndeliveryId: ${deliveryId}`,
    deliveryId
  };
}

async function deliverDesktopMessage(params: {
  thread: CodexDesktopThread;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
  deliveryId?: string;
  model?: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
  imagePaths?: string[];
}): Promise<CodexDesktopDelivery & { deliveryId: string; warning?: string }> {
  const prepared = ensureCodexDesktopDeliveryMarkerForTest(params.prompt, params.deliveryId);
  const preserveEmptyTaskTitle = !params.thread.firstUserMessage && Boolean(params.thread.title);
  const delivery = await desktopBridge.deliver({
    threadId: params.thread.id,
    prompt: prepared.prompt,
    cwd: params.cwd,
    sandbox: params.sandbox,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    imagePaths: params.imagePaths
  });
  if (preserveEmptyTaskTitle) {
    try {
      await waitForDesktopFirstMessage(params.thread.id);
      await setCodexTaskName(params.thread.id, params.thread.title, params.cwd);
    } catch (error) {
      return {
        ...delivery,
        deliveryId: prepared.deliveryId,
        warning: `Desktop 已接收消息，但任务名恢复失败：${errorMessage(error)}`
      };
    }
  }
  return { ...delivery, deliveryId: prepared.deliveryId };
}

function asSummary(thread: CodexDesktopThread): CodexThreadSummary {
  return { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, cwd: thread.cwd, archived: thread.archived };
}

export async function listCodexThreads(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces: string[];
  stateDbOnly?: boolean;
  signal?: AbortSignal;
}): Promise<CodexThreadSummary[]> {
  return listCodexDesktopThreads({
    query: options.query,
    limit: options.limit,
    offset: options.offset,
    allowedWorkspaces: options.allowedWorkspaces
  }).map(asSummary);
}

export async function readCodexThread(threadId: string): Promise<unknown> {
  const thread = readCodexDesktopThread(threadId);
  if (!thread) throw new Error(`Codex Desktop task was not found: ${threadId}`);
  const status = await codexDesktopThreadRuntimeStatus(thread);
  return {
    id: thread.id,
    name: thread.title,
    title: thread.title,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    source: "Codex Desktop state",
    rolloutPath: thread.rolloutPath,
    active: status === "active",
    status: { type: status }
  };
}

export function codexThreadRuntimeStatusFromSourcesForTest(
  desktopReady: boolean,
  desktopActiveSinceMs: number | null,
  rollout: CodexRolloutActivity
): CodexThreadRuntimeStatus {
  if (!desktopReady) return "unavailable";
  if (rollout.state === "active") return "active";
  if (desktopActiveSinceMs != null && (rollout.state === "unknown" || desktopActiveSinceMs > rollout.observedAtMs)) {
    return "active";
  }
  if (rollout.state === "inactive") return "idle";
  return "notLoaded";
}

export function codexThreadIsActiveFromSourcesForTest(
  desktopActiveSinceMs: number | null,
  rollout: CodexRolloutActivity
): boolean {
  if (rollout.state === "active") return true;
  if (desktopActiveSinceMs == null) return false;
  if (rollout.state === "unknown") return true;
  return desktopActiveSinceMs > rollout.observedAtMs;
}

async function codexDesktopThreadIsActive(thread: CodexDesktopThread): Promise<boolean> {
  return (await codexDesktopThreadRuntimeStatus(thread)) === "active";
}

async function codexDesktopThreadRuntimeStatus(thread: CodexDesktopThread): Promise<CodexThreadRuntimeStatus> {
  const desktopReady = await desktopBridge.isReady();
  const rollout = thread.rolloutPath
    ? await readCodexRolloutActivity(thread.rolloutPath)
    : { state: "unknown", observedAtMs: 0 } satisfies CodexRolloutActivity;
  return codexThreadRuntimeStatusFromSourcesForTest(desktopReady, desktopBridge.threadActiveSince(thread.id), rollout);
}

export async function renameCodexThread(params: {
  threadId: string;
  title: string;
  cwd: string;
}): Promise<CodexThreadSummary> {
  const thread = readCodexDesktopThread(params.threadId);
  if (!thread) throw new Error(`Codex Desktop task was not found: ${params.threadId}`);
  if (thread.archived) throw new Error(`Codex Desktop task is archived: ${params.threadId}`);
  const title = normalizeCodexThreadTitle(params.title);
  await setCodexTaskName(thread.id, title, params.cwd);
  return {
    id: thread.id,
    title,
    updatedAt: new Date().toISOString(),
    cwd: thread.cwd,
    archived: false
  };
}

export async function createCodexThread(params: CodexThreadCreateParams): Promise<CodexThreadCreateResult> {
  const normalizedParams = {
    ...params,
    title: normalizeCodexThreadTitle(params.title)
  };
  const bootstrap = await bootstrapEmptyDesktopThread(normalizedParams);
  const created: CodexThreadCreateResult = {
    id: bootstrap.threadId,
    title: normalizedParams.title,
    updatedAt: new Date().toISOString(),
    source: "Codex Desktop task bootstrap",
    initialTurnStatus: normalizedParams.prompt.trim() ? "started" : "not-requested"
  };
  try {
    if (!normalizedParams.prompt.trim()) return created;
    normalizedParams.onCreationStage?.("initial_turn", bootstrap.threadId);
    const initialDelivery = ensureCodexDesktopDeliveryMarkerForTest(normalizedParams.prompt);
    await desktopBridge.deliver({
      threadId: bootstrap.threadId,
      prompt: initialDelivery.prompt,
      cwd: normalizedParams.cwd,
      sandbox: normalizedParams.sandbox
    });
    try {
      await waitForDesktopFirstMessage(bootstrap.threadId);
      await setCodexTaskName(bootstrap.threadId, normalizedParams.title, normalizedParams.cwd, bootstrap.client);
    } catch (error) {
      created.initialTurnError = `Desktop 已接收消息，但任务名恢复失败：${errorMessage(error)}`;
    }
  } catch (error) {
    created.initialTurnStatus = "failed";
    created.initialTurnError = errorMessage(error);
  } finally {
    bootstrap.client.close();
  }
  return created;
}

export async function waitForCodexDesktopThreadForTest(
  params: { threadId: string; cwd: string; expectedName?: string; attempts?: number; delayMs?: number },
  dependencies: {
    read: (threadId: string) => CodexDesktopThread | null;
    wait: (delayMs: number) => Promise<void>;
  } = { read: readCodexDesktopThread, wait }
): Promise<CodexDesktopThread> {
  const attempts = Math.max(1, params.attempts ?? 20);
  const delayMs = Math.max(1, params.delayMs ?? 100);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const thread = dependencies.read(params.threadId);
    if (thread) {
      if (!sameCodexWorkspace(thread.cwd, params.cwd)) {
        throw new Error(`Codex Desktop task belongs to another workspace. Task: ${thread.cwd}; configured: ${params.cwd}`);
      }
      if (!params.expectedName || thread.title === params.expectedName) return thread;
    }
    if (attempt + 1 < attempts) await dependencies.wait(delayMs);
  }
  throw new Error(params.expectedName
    ? `Codex Desktop sidebar Name was not available after waiting for the Desktop index: ${params.threadId}`
    : `Codex Desktop task was not found after waiting for the Desktop index: ${params.threadId}`);
}

export async function sendCodexThreadMessage(params: {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
  model?: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
  imagePaths?: string[];
}): Promise<CodexDesktopDelivery & { warning?: string }> {
  const thread = readCodexDesktopThread(params.threadId);
  if (!thread) throw new Error(`Codex Desktop task was not found: ${params.threadId}`);
  if (thread.archived) throw new Error(`Codex Desktop task is archived: ${params.threadId}`);
  return deliverDesktopMessage({
    thread,
    prompt: params.prompt,
    cwd: params.cwd,
    sandbox: params.sandbox,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    imagePaths: params.imagePaths
  });
}

function monitorThreadFromDesktop(thread: CodexDesktopThread): CodexMonitorThread {
  return {
    id: thread.id,
    threadName: thread.title,
    updatedAt: thread.updatedAt,
    source: "Codex Desktop state + Desktop IPC",
    cwd: thread.cwd
  };
}

function bindDesktopThread(thread: CodexDesktopThread): CodexMonitorThread {
  const now = new Date().toISOString();
  writeState({
    ...readState(),
    monitorThreadId: thread.id,
    monitorThreadName: thread.title,
    monitorThreadCwd: thread.cwd,
    monitorThreadUpdatedAt: thread.updatedAt,
    monitorThreadSource: "Codex Desktop state + Desktop IPC",
    lastAutoDiscoveryAt: now,
    desktopHostRequired: true
  });
  return monitorThreadFromDesktop(thread);
}

function currentCodexThreadId(): string {
  const rememberedThreadId = readState().monitorThreadId;
  return isCodexTaskId(config.codexThreadId)
    ? config.codexThreadId
    : (isCodexTaskId(rememberedThreadId) ? rememberedThreadId : "");
}

function codexSessionDependencies(): CodexSessionResolverDependencies<CodexDesktopThread> {
  return {
    scope: desktopBridge,
    // readCodexDesktopThread is the canonical Desktop task read model: opaque
    // identity/workspace come from owner state, while the displayed title is
    // overlaid from the same index used by Desktop's left sidebar.
    read: async (candidateId) => readCodexDesktopThread(candidateId),
    list: async ({ title, cwd }) => listCodexDesktopThreads({
      query: title,
      limit: 10_000,
      allowedWorkspaces: [cwd]
    }),
    create: async () => {
      const created = await createCodexThread({
        title: config.codexThreadName,
        prompt: "",
        cwd: config.codexCwd,
        developerInstructions: "这是由 RabiRoute 创建并交给 Codex Desktop 执行的任务。实际消息仅通过 Desktop IPC 投递。",
        sandbox: "workspace-write"
      });
      return waitForCodexDesktopThreadForTest({
        threadId: created.id,
        cwd: config.codexCwd,
        expectedName: config.codexThreadName
      });
    }
  };
}

async function resolveMonitorThread(createIfMissing: boolean): Promise<{
  thread: CodexDesktopThread;
  replacementForThreadId?: string;
} | null> {
  const previousThreadId = currentCodexThreadId();
  const resolution = await resolveCodexSession({
    threadId: previousThreadId,
    title: config.codexThreadName,
    cwd: config.codexCwd,
    createIfMissing
  }, codexSessionDependencies());

  if (resolution.kind === "ambiguous") {
    throw new Error(`Codex Desktop task name is ambiguous; select the exact task in RibiWebGUI: ${config.codexThreadName}`);
  }
  if (resolution.kind === "archived") {
    throw new Error(`Codex Desktop task is archived; restore it or select another task in RibiWebGUI: ${config.codexThreadName}`);
  }
  if (resolution.kind === "missing") return null;
  if (resolution.kind === "created") config.codexThreadId = resolution.thread.id;
  return {
    thread: resolution.thread,
    ...(resolution.kind === "created" && previousThreadId !== resolution.thread.id
      ? { replacementForThreadId: previousThreadId }
      : {})
  };
}

export async function isCodexMonitorThreadActive(): Promise<boolean> {
  const resolved = await resolveMonitorThread(false);
  if (!resolved) return false;
  bindDesktopThread(resolved.thread);
  return codexDesktopThreadIsActive(resolved.thread);
}

function recordDeliveredNotification(
  thread: CodexDesktopThread,
  now: Date,
  deliveryId: string,
  replacementForThreadId?: string
): CodexMonitorThread {
  const nextState: CodexState = {
    ...readState(),
    monitorThreadId: thread.id,
    monitorThreadName: thread.title,
    monitorThreadCwd: thread.cwd,
    monitorThreadUpdatedAt: now.toISOString(),
    monitorThreadSource: "Codex Desktop state + Desktop IPC",
    notificationCount: (readState().notificationCount ?? 0) + 1,
    lastNotificationAt: now.toISOString(),
    lastDeliveryChannel: "desktop-ipc",
    lastDeliveryId: deliveryId,
    lastDeliveryStatus: "delivered",
    lastDeliveryDeliveredAt: now.toISOString(),
    lastNotificationError: "",
    lastNotificationErrorAt: "",
    desktopHostRequired: true,
    ...(replacementForThreadId !== undefined ? {
      bindingUpdateRequestedAt: now.toISOString(),
      bindingPreviousThreadId: replacementForThreadId,
      bindingThreadId: thread.id,
      bindingThreadName: thread.title,
      bindingWorkspace: thread.cwd
    } : {})
  };
  writeState(nextState);
  return {
    id: thread.id,
    threadName: thread.title,
    updatedAt: nextState.monitorThreadUpdatedAt ?? now.toISOString(),
    source: nextState.monitorThreadSource ?? "Codex Desktop IPC",
    cwd: thread.cwd
  };
}

async function deliverNotification(message: string, deliveryId: string, imagePaths: string[] = []): Promise<CodexMonitorThread> {
  const turnOptions = resolvePrimaryCodexTurnOptions(config);
  const previousThreadId = currentCodexThreadId();
  const resolution = await resolveAndDeliverCodexSession({
    threadId: currentCodexThreadId(),
    title: config.codexThreadName,
    cwd: config.codexCwd,
    prompt: message
  }, {
    ...codexSessionDependencies(),
    deliver: ({ thread, prompt }) => deliverDesktopMessage({
      thread,
      prompt,
      cwd: config.codexCwd,
      deliveryId,
      sandbox: "workspace-write",
      imagePaths,
      ...turnOptions
    }).then(() => undefined)
  }, ({ thread }) => {
    config.codexThreadId = thread.id;
    bindDesktopThread(thread);
  });
  return recordDeliveredNotification(
    resolution.thread,
    new Date(),
    deliveryId,
    resolution.kind === "created" && previousThreadId !== resolution.thread.id ? previousThreadId : undefined
  );
}

export async function notifyCodex(message: string, imagePaths: string[] = []): Promise<CodexMonitorThread> {
  const result = notificationQueue.catch(() => undefined).then(async () => {
    const deliveryId = randomUUID();
    recordAcceptedDelivery(deliveryId);
    try {
      return await deliverNotification(message, deliveryId, imagePaths);
    } catch (error) {
      recordCodexFailure(error, deliveryId);
      throw error;
    }
  });
  notificationQueue = result;
  return result;
}

export async function notifyCodexWhenIdle(message: string): Promise<CodexIdleNotificationResult> {
  const result = notificationQueue.catch(() => undefined).then(async () => {
    const resolved = await resolveMonitorThread(true);
    if (!resolved) throw new Error("Codex Desktop task could not be resolved.");
    bindDesktopThread(resolved.thread);
    if (await codexDesktopThreadIsActive(resolved.thread)) {
      return { status: "busy", thread: monitorThreadFromDesktop(resolved.thread) } satisfies CodexIdleNotificationResult;
    }
    const deliveryId = randomUUID();
    recordAcceptedDelivery(deliveryId);
    try {
      await deliverDesktopMessage({
        thread: resolved.thread,
        prompt: message,
        cwd: config.codexCwd,
        deliveryId,
        sandbox: "workspace-write",
        ...resolvePrimaryCodexTurnOptions(config)
      });
      return {
        status: "delivered",
        thread: recordDeliveredNotification(
          resolved.thread,
          new Date(),
          deliveryId,
          resolved.replacementForThreadId
        )
      } satisfies CodexIdleNotificationResult;
    } catch (error) {
      recordCodexFailure(error, deliveryId);
      throw error;
    }
  });
  notificationQueue = result;
  return result;
}
