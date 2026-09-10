/**
 * DSH (DeepSeek Harness) session bridge — the DSH-side counterpart of the
 * Codex Desktop bridge. A route can bind its primary persona
 * (主人格) to a local DSH session; incoming RabiRoute deliveries are then
 * injected into that live session through the DSH apiproxy HTTP API
 * (`POST /api/session.prompt`, `POST /api/session.list`).
 *
 * The DSH binding lives in the route's adapterConfig.json (dshSessionId +
 * dshSessionName + dshCwd + dshBaseUrl), which keeps a single source of truth
 * shared with the DSH-side preset plugin (`rabi-tools-v2.js` reads the same
 * file). This module deliberately reads the file at call time instead of
 * plumbing the binding through every delivery call site.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DSH_BASE_URL = "http://127.0.0.1:3080";
export const DEFAULT_DSH_SESSION_NAME = "Rabi Agent";
export const DSH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const EXPECTED_DSH_RABIROUTE_PLUGIN_VERSION = "0.1.2";
export const DSH_RABIROUTE_TOOL_NAMES = [
  "rabiroute_agent_threads",
  "rabiroute_agent_send",
  "rabiroute_manager_api"
] as const;

const dshSessionIdPattern = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDshSessionId(value: string): boolean {
  return dshSessionIdPattern.test(String(value || "").trim());
}

export type DshModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type DshModelCatalogEntry = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  description?: string;
  defaultReasoningEffort?: string;
  reasoningEfforts: Array<{ id: string; description?: string }>;
};

export type DshPrimaryBinding = {
  sessionId: string;
  sessionName: string;
  cwd: string;
  baseUrl: string;
  modelSelection?: DshModelSelection;
};

export function dshRouteConfigPath(): string {
  return process.env.RABI_DSH_ROUTE_CONFIG_PATH
    || path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "route",
      "main",
      "adapterConfig.json"
    );
}

/**
 * Read the DSH primary binding from the route adapterConfig.json. Returns null
 * when the route has no complete DSH primary binding (pure Codex deployment).
 */
export function readDshPrimaryBinding(routeConfigPath: string = dshRouteConfigPath()): DshPrimaryBinding | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(routeConfigPath, "utf8")) as Record<string, unknown>;
    const sessionId = typeof parsed.dshSessionId === "string" ? parsed.dshSessionId.trim() : "";
    const cwd = typeof parsed.dshCwd === "string" ? parsed.dshCwd.trim() : "";
    if (!sessionId || !isDshSessionId(sessionId) || !cwd) return null;
    const baseUrl = typeof parsed.dshBaseUrl === "string" && parsed.dshBaseUrl.trim()
      ? parsed.dshBaseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_DSH_BASE_URL;
    const sessionName = typeof parsed.dshSessionName === "string" && parsed.dshSessionName.trim()
      ? parsed.dshSessionName.trim()
      : DEFAULT_DSH_SESSION_NAME;
    const modelProvider = (typeof parsed.dshModelProvider === "string" ? parsed.dshModelProvider.trim() : "")
      || process.env.DSH_MODEL_PROVIDER?.trim()
      || "";
    const model = (typeof parsed.dshModel === "string" ? parsed.dshModel.trim() : "")
      || process.env.DSH_MODEL?.trim()
      || "";
    const reasoningEffort = (typeof parsed.dshReasoningEffort === "string" && parsed.dshReasoningEffort.trim()
      ? parsed.dshReasoningEffort.trim()
      : undefined)
      || process.env.DSH_REASONING_EFFORT?.trim()
      || undefined;
    return {
      sessionId,
      sessionName,
      cwd,
      baseUrl,
      ...(modelProvider && model ? {
        modelSelection: {
          provider: modelProvider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {})
        }
      } : {})
    };
  } catch {
    return null;
  }
}

type DshRpcOk<T> = { ok: true; value: T };
type DshRpcError = { ok: false; error: { code?: string; message?: string } };

async function dshRpc<T>(baseUrl: string, method: string, payload: unknown): Promise<DshRpcOk<T> | DshRpcError> {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload })
  });
  if (!response.ok) {
    throw new Error(`DSH ${method} transport failed with HTTP ${response.status}.`);
  }
  const full = await response.json() as {
    rpcId?: unknown;
    result?: { ok?: boolean; value?: unknown; error?: unknown };
  };
  if (full.rpcId !== rpcId) {
    throw new Error(`DSH ${method} rpcId mismatch (possible cross-talk).`);
  }
  const result = full.result;
  if (!result || result.ok !== true) {
    const error = result?.error && typeof result.error === "object"
      ? result.error as Record<string, unknown>
      : {};
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : JSON.stringify(error)
      }
    };
  }
  return { ok: true, value: result.value as T };
}

type DshModelCatalogResponse = {
  groups?: unknown;
  failures?: unknown;
};

export function normalizeDshModelCatalogForTest(value: unknown): {
  models: DshModelCatalogEntry[];
  warnings: string[];
} {
  const response = value && typeof value === "object" ? value as DshModelCatalogResponse : {};
  const models = Array.isArray(response.groups)
    ? response.groups.flatMap((group): DshModelCatalogEntry[] => {
        if (!group || typeof group !== "object") return [];
        const provider = group as Record<string, unknown>;
        const providerId = typeof provider.id === "string" ? provider.id.trim() : "";
        if (!providerId || !Array.isArray(provider.models)) return [];
        const providerName = typeof provider.name === "string" && provider.name.trim()
          ? provider.name.trim()
          : providerId;
        return provider.models.flatMap((model): DshModelCatalogEntry[] => {
          if (!model || typeof model !== "object") return [];
          const raw = model as Record<string, unknown>;
          const id = typeof raw.id === "string" ? raw.id.trim() : "";
          if (!id) return [];
          const reasoning = raw.reasoning && typeof raw.reasoning === "object"
            ? raw.reasoning as Record<string, unknown>
            : {};
          const reasoningEfforts = Array.isArray(reasoning.efforts)
            ? reasoning.efforts.flatMap((effort): Array<{ id: string; description?: string }> => {
                if (!effort || typeof effort !== "object") return [];
                const option = effort as Record<string, unknown>;
                const effortId = typeof option.id === "string" ? option.id.trim() : "";
                if (!effortId) return [];
                const description = typeof option.description === "string" && option.description.trim()
                  ? option.description.trim()
                  : undefined;
                return [{ id: effortId, ...(description ? { description } : {}) }];
              })
            : [];
          const description = typeof raw.description === "string" && raw.description.trim()
            ? raw.description.trim()
            : undefined;
          const defaultReasoningEffort = typeof reasoning.defaultEffort === "string" && reasoning.defaultEffort.trim()
            ? reasoning.defaultEffort.trim()
            : undefined;
          return [{
            provider: providerId,
            providerName,
            id,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
            ...(description ? { description } : {}),
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            reasoningEfforts
          }];
        });
      })
    : [];
  const warnings = Array.isArray(response.failures)
    ? response.failures.flatMap((failure): string[] => {
        if (!failure || typeof failure !== "object") return [];
        const raw = failure as Record<string, unknown>;
        const name = typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : typeof raw.id === "string"
            ? raw.id.trim()
            : "DSH provider";
        const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : "模型目录读取失败";
        return [`${name}：${message}`];
      })
    : [];
  return { models, warnings };
}

export async function listDshModels(baseUrl: string = DEFAULT_DSH_BASE_URL): Promise<{
  models: DshModelCatalogEntry[];
  warnings: string[];
}> {
  const result = await dshRpc<DshModelCatalogResponse>(normalizedDshBaseUrl(baseUrl), "llm.models", {});
  if (!result.ok) {
    throw new Error(`DSH llm.models failed: ${result.error.message || result.error.code || "unknown error"}`);
  }
  return normalizeDshModelCatalogForTest(result.value);
}

async function applyDshSessionModel(
  baseUrl: string,
  sessionId: string,
  selection: DshModelSelection | undefined
): Promise<void> {
  if (!selection) return;
  const current = await dshRpc<{ current?: { provider?: string; model?: string; reasoningEffort?: string } }>(
    baseUrl,
    "session.models",
    { sessionId }
  );
  if (!current.ok) {
    throw new Error(`DSH session.models failed: ${current.error.message || current.error.code || "unknown error"}`);
  }
  const active = current.value.current;
  const modelMatches = active?.provider === selection.provider && active?.model === selection.model;
  const reasoningMatches = !selection.reasoningEffort || active?.reasoningEffort === selection.reasoningEffort;
  if (modelMatches && reasoningMatches) return;
  const selected = await dshRpc<{ selected?: DshModelSelection }>(baseUrl, "session.selectModel", {
    sessionId,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
  });
  if (!selected.ok) {
    throw new Error(`DSH session.selectModel failed: ${selected.error.message || selected.error.code || "unknown error"}`);
  }
}

export type DshRabiRoutePluginStatus = {
  active: boolean;
  version?: string;
  managerBaseUrl?: string;
  enforceAgentCommunication?: boolean;
  requestTimeoutMs?: number;
  tools: string[];
};

async function dshRemoteRpc<T>(
  baseUrl: string,
  endpoint: string,
  args: Record<string, unknown> = {}
): Promise<DshRpcOk<T> | DshRpcError> {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } })
  });
  if (!response.ok) {
    throw new Error(`DSH ${endpoint} transport failed with HTTP ${response.status}.`);
  }
  const full = await response.json() as {
    rpcId?: unknown;
    result?: { ok?: boolean; value?: unknown; error?: unknown };
  };
  if (full.rpcId !== rpcId) {
    throw new Error(`DSH ${endpoint} rpcId mismatch (possible cross-talk).`);
  }
  const result = full.result;
  if (!result || result.ok !== true) {
    const error = result?.error && typeof result.error === "object"
      ? result.error as Record<string, unknown>
      : {};
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : JSON.stringify(error)
      }
    };
  }
  return { ok: true, value: result.value as T };
}

export async function readDshRabiRoutePluginStatus(
  baseUrl: string = DEFAULT_DSH_BASE_URL
): Promise<DshRabiRoutePluginStatus> {
  const result = await dshRemoteRpc<Record<string, unknown>>(
    normalizedDshBaseUrl(baseUrl),
    "rabirouteAgent/status"
  );
  if (!result.ok) {
    throw new Error(`DSH RabiRoute plugin status failed: ${result.error.message || result.error.code || "unknown error"}`);
  }
  const runtime = result.value;
  const version = typeof runtime.version === "string" && runtime.version.trim()
    ? runtime.version.trim()
    : undefined;
  return {
    active: runtime.active === true,
    ...(version ? { version } : {}),
    ...(typeof runtime.managerBaseUrl === "string" && runtime.managerBaseUrl.trim()
      ? { managerBaseUrl: runtime.managerBaseUrl.trim().replace(/\/+$/, "") }
      : {}),
    ...(typeof runtime.enforceAgentCommunication === "boolean"
      ? { enforceAgentCommunication: runtime.enforceAgentCommunication }
      : {}),
    ...(typeof runtime.requestTimeoutMs === "number" && Number.isFinite(runtime.requestTimeoutMs)
      ? { requestTimeoutMs: runtime.requestTimeoutMs }
      : {}),
    tools: Array.isArray(runtime.tools)
      ? runtime.tools.filter((item): item is string => typeof item === "string")
      : []
  };
}

type DshSessionListItem = {
  sessionId?: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  cwd?: string;
  agentPreset?: string;
  projections?: { values?: { title?: string } };
};

export type DshSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived: false;
  active: boolean;
  status: { type: "active" | "idle" };
  source: "DSH session (apiproxy)";
};

export type DshSessionResolution =
  | { kind: "id" | "name" | "created"; thread: DshSessionSummary }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: DshSessionSummary[] }
  | { kind: "workspace-mismatch"; thread: DshSessionSummary };

const recentDshCreationTtlMs = 60_000;
const dshCreations = new Map<string, { promise: Promise<DshSessionSummary>; settledAt?: number }>();

function normalizedDshBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_DSH_BASE_URL).replace(/\/+$/, "");
}

function canonicalDshWorkspace(value: string): string {
  let normalized = String(value || "").trim();
  if (!normalized) return "";
  normalized = normalized.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/i, "");
  normalized = normalized.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) {
    return normalized.toLocaleLowerCase();
  }
  return path.resolve(normalized).replace(/\\/g, "/").replace(/\/+$/, "");
}

function sameDshWorkspace(left: string | undefined, right: string | undefined): boolean {
  const leftKey = canonicalDshWorkspace(left || "");
  const rightKey = canonicalDshWorkspace(right || "");
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function dshSessionSummary(item: DshSessionListItem): DshSessionSummary | null {
  const id = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
  if (!isDshSessionId(id)) return null;
  const updatedAtMs = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    ? item.updatedAt
    : 0;
  const title = typeof item.projections?.values?.title === "string" && item.projections.values.title.trim()
    ? item.projections.values.title.trim()
    : id;
  const cwd = typeof item.cwd === "string" && item.cwd.trim() ? item.cwd.trim() : undefined;
  const active = item.running === true;
  return {
    id,
    title,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
    cwd,
    archived: false,
    active,
    status: { type: active ? "active" : "idle" },
    source: "DSH session (apiproxy)"
  };
}

async function readDshSessionCatalog(baseUrl: string): Promise<DshSessionSummary[]> {
  const result = await dshRpc<{ items?: DshSessionListItem[] }>(normalizedDshBaseUrl(baseUrl), "session.list", {});
  if (!result.ok) {
    throw new Error(`DSH session list failed: ${result.error.message || result.error.code || "unknown error"}`);
  }
  return (result.value.items || [])
    .map(dshSessionSummary)
    .filter((item): item is DshSessionSummary => item !== null);
}

export async function listDshSessions(options: {
  baseUrl?: string;
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces?: string[];
} = {}): Promise<DshSessionSummary[]> {
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const workspaceKeys = new Set(
    (options.allowedWorkspaces || []).map(canonicalDshWorkspace).filter(Boolean)
  );
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.max(0, Math.trunc(options.limit ?? 100));
  const rows = await readDshSessionCatalog(options.baseUrl || DEFAULT_DSH_BASE_URL);
  return rows
    .filter((item) => workspaceKeys.size === 0 || (item.cwd && workspaceKeys.has(canonicalDshWorkspace(item.cwd))))
    .filter((item) => !query || `${item.title}\n${item.id}\n${item.cwd || ""}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(offset, offset + limit);
}

export async function renameDshSession(params: {
  sessionId: string;
  title: string;
  cwd: string;
  baseUrl?: string;
}): Promise<DshSessionSummary> {
  const sessionId = params.sessionId.trim();
  const title = params.title.trim();
  const cwd = params.cwd.trim();
  if (!isDshSessionId(sessionId)) throw new Error(`Invalid DSH session id: ${params.sessionId}`);
  if (!title) throw new Error("DSH session title is required.");
  if (!cwd) throw new Error("DSH session workspace is required.");
  const baseUrl = normalizedDshBaseUrl(params.baseUrl);
  const existing = (await readDshSessionCatalog(baseUrl)).find((item) => item.id === sessionId);
  if (!existing) throw new Error(`DSH session was not found: ${sessionId}`);
  if (!existing.cwd || !sameDshWorkspace(existing.cwd, cwd)) {
    throw new Error(`DSH session workspace different from requested workspace: ${existing.cwd || "unknown"} != ${cwd}`);
  }
  const renamed = await dshRpc<{ title?: string }>(baseUrl, "session.rename", { sessionId, title });
  if (!renamed.ok) {
    throw new Error(`DSH session rename failed: ${renamed.error.message || renamed.error.code || "unknown error"}`);
  }
  return { ...existing, title, updatedAt: new Date().toISOString() };
}

export async function createDshSession(params: {
  title: string;
  cwd: string;
  baseUrl?: string;
  agentPreset?: string;
  sessionId?: string;
}): Promise<DshSessionSummary> {
  const title = params.title.trim();
  const cwd = params.cwd.trim();
  const baseUrl = normalizedDshBaseUrl(params.baseUrl);
  if (!title) throw new Error("DSH session title is required.");
  if (!cwd) throw new Error("DSH session workspace is required.");
  if (params.sessionId && !isDshSessionId(params.sessionId)) {
    throw new Error(`Invalid DSH session id: ${params.sessionId}`);
  }
  const registered = await dshRpc<{ workspace?: { workspaceId?: string; path?: string } }>(
    baseUrl,
    "workspace.create",
    { path: cwd }
  );
  if (!registered.ok) {
    throw new Error(`DSH workspace registration failed: ${registered.error.message || registered.error.code || "unknown error"}`);
  }
  const workspaceId = typeof registered.value.workspace?.workspaceId === "string"
    ? registered.value.workspace.workspaceId.trim()
    : "";
  const workspacePath = typeof registered.value.workspace?.path === "string"
    ? registered.value.workspace.path.trim()
    : "";
  if (!workspaceId || !workspacePath || !sameDshWorkspace(workspacePath, cwd)) {
    throw new Error(`DSH workspace registration returned an invalid workspace for requested path: ${workspacePath || "unknown"} != ${cwd}`);
  }
  const payload: Record<string, string> = { workspaceId };
  if (params.agentPreset?.trim()) payload.agentPreset = params.agentPreset.trim();
  if (params.sessionId?.trim()) payload.sessionId = params.sessionId.trim();
  const created = await dshRpc<{ sessionId?: string }>(baseUrl, "session.create", payload);
  if (!created.ok) {
    throw new Error(`DSH session creation failed: ${created.error.message || created.error.code || "unknown error"}`);
  }
  const sessionId = typeof created.value.sessionId === "string" ? created.value.sessionId.trim() : "";
  if (!isDshSessionId(sessionId)) throw new Error("DSH session creation returned an invalid sessionId.");
  const renamed = await dshRpc<{ title?: string }>(baseUrl, "session.rename", { sessionId, title });
  if (!renamed.ok) {
    throw new Error(`DSH session was created but rename failed: ${renamed.error.message || renamed.error.code || "unknown error"}`);
  }
  const listed = (await readDshSessionCatalog(baseUrl)).find((item) => item.id === sessionId);
  if (!listed) throw new Error(`DSH session was created but is missing from the owner catalog: ${sessionId}`);
  if (!listed.cwd || !sameDshWorkspace(listed.cwd, cwd)) {
    throw new Error(`DSH session creation returned a workspace different from requested workspace: ${listed.cwd || "unknown"} != ${cwd}`);
  }
  return { ...listed, title };
}

function uniquelyLatestDshSession(matches: DshSessionSummary[]): DshSessionSummary | null {
  if (matches.length === 0) return null;
  const latestTime = Math.max(...matches.map((item) => Date.parse(item.updatedAt)));
  const latest = matches.filter((item) => Date.parse(item.updatedAt) === latestTime);
  return latest.length === 1 ? latest[0]! : null;
}

async function createDshSessionIdempotently(params: {
  title: string;
  cwd: string;
  baseUrl: string;
  agentPreset?: string;
}): Promise<DshSessionSummary> {
  const key = JSON.stringify([
    normalizedDshBaseUrl(params.baseUrl),
    canonicalDshWorkspace(params.cwd),
    params.title.trim(),
    params.agentPreset?.trim() || ""
  ]);
  const existing = dshCreations.get(key);
  if (existing && (existing.settledAt === undefined || Date.now() - existing.settledAt <= recentDshCreationTtlMs)) {
    return existing.promise;
  }
  if (existing) dshCreations.delete(key);
  const entry = { promise: createDshSession(params), settledAt: undefined as number | undefined };
  dshCreations.set(key, entry);
  entry.promise.then(
    () => { entry.settledAt = Date.now(); },
    () => { if (dshCreations.get(key) === entry) dshCreations.delete(key); }
  );
  return entry.promise;
}

export async function resolveDshSession(params: {
  sessionId?: string;
  title: string;
  cwd: string;
  createIfMissing: boolean;
  baseUrl?: string;
  agentPreset?: string;
}): Promise<DshSessionResolution> {
  const title = params.title.trim();
  const cwd = params.cwd.trim();
  const baseUrl = normalizedDshBaseUrl(params.baseUrl);
  if (!title) throw new Error("DSH session title is required.");
  if (!cwd) throw new Error("DSH session workspace is required.");
  const rows = await readDshSessionCatalog(baseUrl);
  const sessionId = params.sessionId?.trim() || "";
  if (isDshSessionId(sessionId)) {
    const exact = rows.find((item) => item.id === sessionId);
    if (exact) {
      if (!exact.cwd || !sameDshWorkspace(exact.cwd, cwd)) {
        return { kind: "workspace-mismatch", thread: exact };
      }
      return { kind: "id", thread: exact };
    }
  }
  const matches = rows
    .filter((item) => item.title === title)
    .filter((item) => item.cwd && sameDshWorkspace(item.cwd, cwd));
  if (matches.length > 1) {
    const latest = uniquelyLatestDshSession(matches);
    return latest ? { kind: "name", thread: latest } : { kind: "ambiguous", candidates: matches };
  }
  if (matches[0]) return { kind: "name", thread: matches[0] };
  if (!params.createIfMissing) return { kind: "missing" };
  return {
    kind: "created",
    thread: await createDshSessionIdempotently({ title, cwd, baseUrl, agentPreset: params.agentPreset })
  };
}

/**
 * Read one DSH session through the apiproxy. The result shape mirrors
 * Codex thread reads so existing consumers (agentThreads read, thread
 * summaries, agent-to-agent source verification) work unchanged.
 */
export async function readDshSession(
  sessionId: string,
  baseUrl: string = DEFAULT_DSH_BASE_URL
): Promise<{
  id: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  archived: boolean;
  source: string;
  active: boolean;
  status: { type: "active" | "idle" };
}> {
  const result = await dshRpc<{ items?: DshSessionListItem[] }>(baseUrl, "session.list", {});
  if (!result.ok) {
    throw new Error(`DSH session read failed: ${result.error.message || result.error.code || "unknown error"}`);
  }
  const item = (result.value.items || []).find((candidate) => candidate.sessionId === sessionId);
  if (!item) {
    throw new Error(`DSH session was not found: ${sessionId}`);
  }
  const updatedAtMs = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    ? item.updatedAt
    : 0;
  const title = typeof item.projections?.values?.title === "string" && item.projections.values.title.trim()
    ? item.projections.values.title.trim()
    : sessionId;
  const running = item.running === true;
  return {
    id: sessionId,
    title,
    cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd : undefined,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
    archived: false,
    source: "DSH session (apiproxy)",
    active: running,
    status: { type: running ? "active" : "idle" }
  };
}

/** URL understood by DSH Web to select one exact session without sending it a prompt. */
export function dshSessionFocusUrl(sessionId: string, baseUrl: string = DEFAULT_DSH_BASE_URL): string {
  const id = sessionId.trim();
  if (!isDshSessionId(id)) throw new Error(`Invalid DSH session id: ${sessionId}`);
  const url = new URL(normalizedDshBaseUrl(baseUrl));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`DSH session focus requires an HTTP(S) base URL: ${baseUrl}`);
  }
  url.searchParams.set("rabiSessionId", id);
  return url.toString();
}

/** Open the DSH Web owner with an exact session-selection request. */
export async function openDshSession(sessionId: string, baseUrl: string = DEFAULT_DSH_BASE_URL): Promise<void> {
  const target = dshSessionFocusUrl(sessionId, baseUrl);
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [target], { detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
}

function imageContentPart(imagePath: string): { type: "image"; mediaType: string; data: string; name: string } {
  const stat = fs.statSync(imagePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`DSH delivery image does not exist: ${imagePath}`);
  if (stat.size > DSH_IMAGE_MAX_BYTES) {
    throw new Error(`DSH delivery image exceeds 5 MiB: ${imagePath}`);
  }
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp"
          : ext === ".bmp" ? "image/bmp"
            : undefined;
  if (!mediaType) throw new Error(`Unsupported DSH delivery image type: ${imagePath}`);
  return {
    type: "image",
    mediaType,
    data: fs.readFileSync(imagePath).toString("base64"),
    name: path.basename(imagePath)
  };
}

export type DshSessionDelivery = {
  threadId: string;
  action: "started";
  openedThread: false;
  transport: "http";
  warning?: string;
};

/**
 * Deliver one prompt into a live DSH session through `session.prompt`
 * (mode=queue: the host appends a user message and the agent loop picks it up).
 *
 * Image handling: images are first attached as image content parts. When the
 * session's model rejects image input (e.g. DeepSeek V4 Flash is text-only),
 * the delivery degrades to a text part carrying the local image paths plus an
 * explicit instruction to inspect them with the `analyze_image` tool — the
 * DSH session runs on the same machine and can read those files.
 */
export async function sendDshSessionMessage(params: {
  sessionId: string;
  prompt: string;
  cwd: string;
  baseUrl?: string;
  imagePaths?: string[];
  modelSelection?: DshModelSelection;
}): Promise<DshSessionDelivery> {
  const baseUrl = (params.baseUrl || DEFAULT_DSH_BASE_URL).replace(/\/+$/, "");
  await applyDshSessionModel(baseUrl, params.sessionId, params.modelSelection);
  const imagePaths = params.imagePaths || [];
  const content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string; name: string }> = [
    { type: "text", text: params.prompt }
  ];
  for (const imagePath of imagePaths) {
    content.push(imageContentPart(imagePath));
  }
  const result = await dshRpc<{ accepted?: boolean }>(baseUrl, "session.prompt", {
    sessionId: params.sessionId,
    mode: "queue",
    content
  });
  if (result.ok) {
    return {
      threadId: params.sessionId,
      action: "started",
      openedThread: false,
      transport: "http"
    };
  }
  const rejection = `${result.error.message || result.error.code || ""}`;
  if (imagePaths.length > 0 && /image input|image.*not support|not support.*image|image.*unsupported|unsupported.*image/i.test(rejection)) {
    const degraded = buildImagePathDegradedPrompt(params.prompt, imagePaths);
    const retried = await dshRpc<{ accepted?: boolean }>(baseUrl, "session.prompt", {
      sessionId: params.sessionId,
      mode: "queue",
      content: [{ type: "text", text: degraded }]
    });
    if (retried.ok) {
      return {
        threadId: params.sessionId,
        action: "started",
        openedThread: false,
        transport: "http",
        warning: `DSH 会话模型不支持图片输入，已降级为文本投递并附 ${imagePaths.length} 张图片的本地路径（可用 analyze_image 查看）。`
      };
    }
    throw new Error(
      `DSH session delivery rejected: ${retried.error.message || retried.error.code || "unknown error"}`
    );
  }
  throw new Error(`DSH session delivery rejected: ${rejection}`);
}

function buildImagePathDegradedPrompt(prompt: string, imagePaths: string[]): string {
  const lines = imagePaths.map((imagePath, index) => `${index + 1}. ${imagePath}`);
  return [
    prompt,
    "",
    `[图片附件（共 ${imagePaths.length} 张）]`,
    "本会话模型不支持图片输入，图片未随消息上传；图片位于本机，请按需使用 analyze_image 工具（或直接读取文件）查看后再判断。",
    ...lines
  ].join("\n");
}

/**
 * Deliver a plain message to the route's bound DSH primary session. Used by
 * the agent-adapter fallback path (`createAgentAdapter("dsh").deliver`).
 */
export async function notifyDshSession(message: string, imagePaths: string[] = []): Promise<{ sessionId: string }> {
  const binding = readDshPrimaryBinding();
  if (!binding) throw new Error("The configured route has no DSH primary binding.");
  await sendDshSessionMessage({
    sessionId: binding.sessionId,
    prompt: message,
    cwd: binding.cwd,
    baseUrl: binding.baseUrl,
    imagePaths,
    modelSelection: binding.modelSelection
  });
  return { sessionId: binding.sessionId };
}
