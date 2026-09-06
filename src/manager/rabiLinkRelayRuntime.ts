import { PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY } from "../personaSyncPlanPackage.js";

type RelayProxyRequest = {
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

export type RabiLinkRelayRuntimeConfig = {
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  deviceGuid: string;
  deviceName: string;
  claimWaitMs: number;
  localWebguiUrl: string;
  /** Direct Manager endpoints advertised only to PCs using the same application token. */
  peerUrls?: string[];
  speechProxyEnabled: boolean;
  localSpeechUrl: string;
};

export type RabiLinkRelayRuntimeStatus = {
  state: "disabled" | "incomplete" | "connecting" | "online" | "error";
  message: string;
  lastConnectedAt?: string;
  lastSuccessAt?: string;
  error?: string;
};

export type RabiLinkRelayRuntimeOptions = {
  localRequestTimeoutMs?: number;
  localRequestAttempts?: number;
  localSpeechRequestTimeoutMs?: number;
  relayWriteTimeoutMs?: number;
  relayWriteAttempts?: number;
  channelRetryDelayMs?: number;
  onStatus?: (status: RabiLinkRelayRuntimeStatus) => void;
  onEvent?: (eventType: string, data: Record<string, unknown>) => void;
};

const RETRY_DELAY_MS = 3000;
const MAX_CHANNEL_RETRY_DELAY_MS = 30_000;
const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_LOCAL_REQUEST_ATTEMPTS = 3;
const DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS = 180000;
const DEFAULT_RELAY_WRITE_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_WRITE_ATTEMPTS = 4;
const WEBGUI_EVENT_STREAM_PATHS = ["/api/events", "/api/speech/events"] as const;

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || !("cause" in error) || !error.cause) return message;
  const cause = error.cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const causeCode = typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code?: unknown }).code ?? "").trim()
    : "";
  const detail = [causeCode, causeMessage].filter(Boolean).join(" ");
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) return finish();
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function proxyRequests(body: Record<string, unknown>): RelayProxyRequest[] {
  const requests = Array.isArray(body.requests) ? body.requests : [];
  return requests.filter((item): item is RelayProxyRequest => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

async function relayJson(
  config: RabiLinkRelayRuntimeConfig,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 0
): Promise<Record<string, unknown>> {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller?.abort(upstreamSignal?.reason);
  if (controller && upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`RabiLink Relay request timed out after ${timeoutMs} ms.`)), timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(`${config.url}${pathname}`, {
      ...init,
      signal: controller?.signal || upstreamSignal
    });
  } finally {
    if (timer) clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`RabiLink Relay returned invalid JSON (${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `${response.status} ${response.statusText}`));
  }
  return body;
}

async function consumeRelayEvents(
  config: RabiLinkRelayRuntimeConfig,
  signal: AbortSignal,
  onEvent: (eventType: string, data: Record<string, unknown>) => void
): Promise<void> {
  const params = new URLSearchParams({
    ...workerIdentity(config),
    deviceName: config.deviceName,
    capabilities: workerCapabilities(config)
  });
  appendPeerUrls(params, config);
  const response = await fetch(`${config.url}/api/rabilink/events?${params}`, {
    method: "GET",
    headers: { ...relayHeaders(config), accept: "text/event-stream" },
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`RabiLink Relay event stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let hasEventFields = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (hasEventFields) onEvent(eventType, parseEventData(dataLines.join("\n")));
          eventType = "message";
          dataLines = [];
          hasEventFields = false;
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim() || "message";
          hasEventFields = true;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          hasEventFields = true;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch signal may already have closed the Relay stream.
    }
  }
}

async function publishWebguiEvent(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  eventType: string,
  data: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, "/worker/webgui-events", {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ streamPath, eventType, data, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

function parseEventData(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

async function consumeLocalWebguiEvents(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  signal: AbortSignal,
  onEvent: (eventType: string, data: Record<string, unknown>) => Promise<void>
): Promise<void> {
  const response = await fetch(safeLocalUrl(config, streamPath), {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "user-agent": "RabiRoute/1.0"
    },
    signal
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !response.body || !contentType.startsWith("text/event-stream")) {
    throw new Error(`Local Manager event stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let hasEventFields = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (hasEventFields && eventType !== "ready") await onEvent(eventType, parseEventData(dataLines.join("\n")));
          eventType = "message";
          dataLines = [];
          hasEventFields = false;
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim() || "message";
          hasEventFields = true;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          hasEventFields = true;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The runtime stop signal may already have closed the local stream.
    }
  }
}

async function forwardLocalWebguiEvents(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  signal: AbortSignal,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await consumeLocalWebguiEvents(
        config,
        streamPath,
        signal,
        (eventType, data) => publishWebguiEvent(config, streamPath, eventType, data, options, signal)
      );
      if (!signal.aborted) throw new Error("Local Manager event stream closed.");
    } catch (error) {
      if (signal.aborted || abortError(error)) return;
      failures += 1;
      await delay(Math.min(RETRY_DELAY_MS * failures, 30_000), signal);
      continue;
    }
    failures = 0;
  }
}

async function relayJsonReliably(
  config: RabiLinkRelayRuntimeConfig,
  pathname: string,
  init: RequestInit,
  attempts: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new Error("RabiLink Relay runtime stopped.");
    try {
      return await relayJson(config, pathname, { ...init, signal }, timeoutMs);
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw error;
      if (attempt < attempts) await delay(150 * attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "RabiLink Relay request failed."));
}

async function localFetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Local ${label} request timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function relayHeaders(config: RabiLinkRelayRuntimeConfig, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RabiLink-Token": config.token,
    "User-Agent": "RabiRoute/1.0"
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

function workerIdentity(config: RabiLinkRelayRuntimeConfig): Record<string, string> {
  return {
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid
  };
}

function appendPeerUrls(params: URLSearchParams, config: RabiLinkRelayRuntimeConfig): void {
  if (config.peerUrls?.length) params.set("peerUrls", JSON.stringify(config.peerUrls));
}

function workerCapabilities(config: RabiLinkRelayRuntimeConfig): string {
  return ["webgui", "persona-sync", PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY, config.speechProxyEnabled ? "speech" : ""]
    .filter(Boolean)
    .join(",");
}

function safeLocalUrl(config: RabiLinkRelayRuntimeConfig, pathname: string): string {
  const base = new URL(config.localWebguiUrl);
  const localUrl = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  localUrl.protocol = base.protocol;
  localUrl.host = base.host;
  // Relay requests arrive over loopback too; reject private directory controls here
  // before the Manager's local-socket guard could mistake them for local UI requests.
  const normalizedPath = new URL(decodeURIComponent(localUrl.pathname), base).pathname.replace(/\/+$/, "");
  if (normalizedPath === "/api/speech/model-management/settings") {
    throw new Error("Model directory settings are available only in the local WebGUI.");
  }
  return localUrl.toString();
}

function localPathname(value: string): string {
  try {
    return new URL(value || "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function isWebguiEventStreamProxy(localPath: string, headers: Record<string, string>): boolean {
  const pathname = localPathname(localPath);
  return WEBGUI_EVENT_STREAM_PATHS.some(streamPath => streamPath === pathname)
    || String(headers.accept || "").toLowerCase().includes("text/event-stream");
}

function safeSpeechUrl(config: RabiLinkRelayRuntimeConfig, pathname: string): string {
  const base = new URL(config.localSpeechUrl);
  const localUrl = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  localUrl.protocol = base.protocol;
  localUrl.host = base.host;
  return localUrl.toString();
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function compactResponse(
  method: string,
  localPath: string,
  statusCode: number,
  body: Buffer,
  requestHeaders: Record<string, string>
): Buffer {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase())) return body;
  if (!localPath.startsWith("/gateways") && !localPath.startsWith("/manager-config")) return body;
  if (statusCode < 200 || statusCode >= 300) return body;
  if (requestHeaders["idempotency-key"] || requestHeaders["if-match"]) return body;
  return Buffer.from(JSON.stringify({ code: 0, ok: true }), "utf8");
}

async function finishWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  requestId: string,
  body: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, `/worker/webgui-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ ...body, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

async function proxyWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  request: RelayProxyRequest,
  options: Required<RabiLinkRelayRuntimeOptions>,
  signal: AbortSignal
): Promise<void> {
  const requestId = stringValue(request.id);
  if (!requestId || signal.aborted) return;
  try {
    const method = stringValue(request.method).toUpperCase() || "GET";
    const localPath = stringValue(request.path) || "/";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (["accept", "content-type", "user-agent", "range", "if-range", "idempotency-key", "if-match"].includes(lower)) {
        headers[lower] = String(value || "");
      }
    }
    if (isWebguiEventStreamProxy(localPath, headers)) {
      throw new Error("SSE event streams must use the Relay event channel instead of the finite WebGUI response proxy.");
    }
    const requestBody = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    const personaSyncRequest = localPath.startsWith("/api/persona-sync/");
    const localTimeoutMs = personaSyncRequest ? Math.max(options.localRequestTimeoutMs, 30_000) : options.localRequestTimeoutMs;
    const requestAttempts = method === "GET" || method === "HEAD" ? options.localRequestAttempts : 1;
    let response: Response | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
      try {
        response = await localFetchWithTimeout(safeLocalUrl(config, localPath), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : requestBody,
          signal
        }, localTimeoutMs, personaSyncRequest ? "persona sync" : "Rabi WebGUI");
        break;
      } catch (error) {
        lastError = error;
        if (signal.aborted) return;
        if (attempt < requestAttempts) await delay(100 * attempt, signal);
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error("Local Rabi WebGUI request failed.");
    }
    if (signal.aborted) return;
    const responseContentType = response.headers.get("content-type") || "";
    if (responseContentType.toLowerCase().startsWith("text/event-stream")) {
      try {
        await response.body?.cancel();
      } catch {
        // The stream may already have closed while the protocol mismatch was detected.
      }
      throw new Error("SSE event streams must use the Relay event channel instead of the finite WebGUI response proxy.");
    }
    const rawBody = Buffer.from(await response.arrayBuffer());
    if (signal.aborted) return;
    const responseBody = compactResponse(method, localPath, response.status, rawBody, headers);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishWebguiRequest(config, requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: responseBody.toString("base64")
    }, personaSyncRequest
      ? { ...options, relayWriteTimeoutMs: Math.max(options.relayWriteTimeoutMs, 30_000) }
      : options, signal);
  } catch (error) {
    if (signal.aborted) return;
    await finishWebguiRequest(config, requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      bodyBase64: Buffer.from(error instanceof Error ? error.message : String(error), "utf8").toString("base64"),
      error: error instanceof Error ? error.message : String(error)
    }, options, signal);
  }
}

async function claimWebguiRequests(
  config: RabiLinkRelayRuntimeConfig,
  waitMs: number,
  signal: AbortSignal
): Promise<RelayProxyRequest[]> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid,
    deviceName: config.deviceName,
    waitMs: String(waitMs),
    capabilities: workerCapabilities(config)
  });
  appendPeerUrls(params, config);
  const body = await relayJson(config, `/worker/webgui-requests?${params}`, {
    method: "GET",
    headers: relayHeaders(config),
    signal
  });
  return proxyRequests(body);
}

async function finishSpeechRequest(
  config: RabiLinkRelayRuntimeConfig,
  requestId: string,
  body: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, `/worker/speech-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ ...body, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

async function proxySpeechRequest(
  config: RabiLinkRelayRuntimeConfig,
  request: RelayProxyRequest,
  options: Required<RabiLinkRelayRuntimeOptions>,
  signal: AbortSignal
): Promise<void> {
  const requestId = stringValue(request.id);
  if (!requestId || signal.aborted) return;
  try {
    const method = stringValue(request.method).toUpperCase() || "GET";
    const localPath = stringValue(request.path) || "/";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (["accept", "content-type", "user-agent"].includes(lower)) headers[lower] = String(value || "");
    }
    const requestBody = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    const managerSpeechIngress = localPath === "/api/speech/messages";
    const response = await localFetchWithTimeout(
      managerSpeechIngress ? safeLocalUrl(config, localPath) : safeSpeechUrl(config, localPath), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody,
      signal
    }, options.localSpeechRequestTimeoutMs, managerSpeechIngress ? "Rabi Manager speech ingress" : "RabiSpeech");
    if (signal.aborted) return;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishSpeechRequest(config, requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64")
    }, options, signal);
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    await finishSpeechRequest(config, requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
      bodyBase64: Buffer.from(JSON.stringify({ error: { message, type: "local_speech_proxy_error" } }), "utf8").toString("base64"),
      error: message
    }, options, signal);
  }
}

async function claimSpeechRequests(
  config: RabiLinkRelayRuntimeConfig,
  waitMs: number,
  signal: AbortSignal
): Promise<RelayProxyRequest[]> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid,
    deviceName: config.deviceName,
    waitMs: String(waitMs),
    capabilities: workerCapabilities(config)
  });
  appendPeerUrls(params, config);
  const body = await relayJson(config, `/worker/speech-requests?${params}`, {
    method: "GET",
    headers: relayHeaders(config),
    signal
  });
  return proxyRequests(body);
}

function normalizeConfig(config: RabiLinkRelayRuntimeConfig): RabiLinkRelayRuntimeConfig {
  return {
    ...config,
    url: normalizeBaseUrl(config.url),
    token: config.token.trim(),
    deviceId: config.deviceId.trim(),
    deviceGuid: config.deviceGuid.trim(),
    deviceName: config.deviceName.trim(),
    claimWaitMs: Math.max(0, Math.min(60000, Number(config.claimWaitMs) || 0)),
    localWebguiUrl: normalizeBaseUrl(config.localWebguiUrl),
    peerUrls: [...new Set((config.peerUrls || []).map(normalizeBaseUrl).filter(Boolean))].slice(0, 8),
    speechProxyEnabled: Boolean(config.speechProxyEnabled),
    localSpeechUrl: normalizeBaseUrl(config.localSpeechUrl)
  };
}

export class RabiLinkRelayRuntime {
  private signature = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private runFlight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private runtimeStatus: RabiLinkRelayRuntimeStatus = {
    state: "disabled",
    message: "RabiLink Relay 全局连接已关闭。"
  };
  private readonly options: Required<RabiLinkRelayRuntimeOptions>;
  private readonly onStatus?: (status: RabiLinkRelayRuntimeStatus) => void;
  private readonly onEvent?: (eventType: string, data: Record<string, unknown>) => void;

  constructor(options: RabiLinkRelayRuntimeOptions = {}) {
    this.onStatus = options.onStatus;
    this.onEvent = options.onEvent;
    this.options = {
      localRequestTimeoutMs: Math.max(100, Number(options.localRequestTimeoutMs) || DEFAULT_LOCAL_REQUEST_TIMEOUT_MS),
      localRequestAttempts: Math.max(1, Math.min(5, Number(options.localRequestAttempts) || DEFAULT_LOCAL_REQUEST_ATTEMPTS)),
      localSpeechRequestTimeoutMs: Math.max(1000, Number(options.localSpeechRequestTimeoutMs) || DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS),
      relayWriteTimeoutMs: Math.max(100, Number(options.relayWriteTimeoutMs) || DEFAULT_RELAY_WRITE_TIMEOUT_MS),
      relayWriteAttempts: Math.max(1, Math.min(5, Number(options.relayWriteAttempts) || DEFAULT_RELAY_WRITE_ATTEMPTS)),
      channelRetryDelayMs: Math.max(10, Math.min(
        MAX_CHANNEL_RETRY_DELAY_MS,
        Number(options.channelRetryDelayMs) || RETRY_DELAY_MS
      )),
      onStatus: options.onStatus ?? (() => undefined),
      onEvent: options.onEvent ?? (() => undefined)
    };
  }

  private setStatus(status: RabiLinkRelayRuntimeStatus): void {
    this.runtimeStatus = status;
    this.onStatus?.({ ...status });
  }

  status(): RabiLinkRelayRuntimeStatus {
    return { ...this.runtimeStatus };
  }

  sync(input: RabiLinkRelayRuntimeConfig): Promise<void> {
    const config = normalizeConfig(input);
    const signature = JSON.stringify(config);
    if (signature === this.signature) {
      return this.stopFlight?.then(() => undefined) ?? Promise.resolve();
    }
    this.signature = signature;
    if (this.stopFlight) {
      return this.stopFlight.then(async () => {
        if (this.signature === signature) await this.applyConfig(config);
      });
    }
    return this.applyConfig(config);
  }

  stop(): Promise<void> {
    this.signature = "";
    if (this.stopFlight) return this.stopFlight;
    const runFlight = this.stopLoop();
    const stopFlight = (async () => {
      await runFlight?.catch(() => {});
      this.setStatus({ state: "disabled", message: "RabiLink Relay 全局连接已关闭。" });
    })();
    const tracked = stopFlight.finally(() => {
      if (this.stopFlight === tracked) this.stopFlight = null;
    });
    this.stopFlight = tracked;
    return tracked;
  }

  private applyConfig(config: RabiLinkRelayRuntimeConfig): Promise<void> {
    const previousRun = this.stopLoop();
    const previousDone = previousRun?.catch(() => {}) ?? Promise.resolve();
    if (!config.enabled) {
      this.setStatus({ state: "disabled", message: "RabiLink Relay 全局连接已关闭。" });
      return previousDone;
    }
    if (!config.url || !config.token) {
      this.setStatus({ state: "incomplete", message: "开启 Relay 前需要填写服务器地址和应用 token。" });
      return previousDone;
    }
    if (!isLoopbackUrl(config.localWebguiUrl)) {
      this.setStatus({ state: "incomplete", message: "本机 Rabi WebGUI 地址必须使用 127.0.0.1、localhost 或 ::1。" });
      return previousDone;
    }
    if (config.speechProxyEnabled && !isLoopbackUrl(config.localSpeechUrl)) {
      this.setStatus({ state: "incomplete", message: "本机语音服务地址必须使用 127.0.0.1、localhost 或 ::1。" });
      return previousDone;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus({ state: "connecting", message: "正在连接 RabiLink Relay..." });
    const runFlight = previousDone
      .then(() => {
        if (!this.active(generation, controller.signal)) return;
        return this.run(config, generation, controller.signal);
      });
    const tracked = runFlight.finally(() => {
      if (this.runFlight === tracked) this.runFlight = null;
    });
    this.runFlight = tracked;
    return previousDone;
  }

  private stopLoop(): Promise<void> | null {
    this.generation += 1;
    this.controller?.abort(new Error("RabiLink Relay runtime stopped."));
    this.controller = null;
    return this.runFlight;
  }

  private active(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private markOnline(speechEnabled: boolean): void {
    const now = new Date().toISOString();
    this.setStatus({
      state: "online",
      message: speechEnabled
        ? "RabiLink Relay 已连接，本机 WebGUI 与语音能力已在服务器上线。"
        : "RabiLink Relay 已连接，本机已在服务器上线。",
      lastConnectedAt: this.runtimeStatus.lastConnectedAt || now,
      lastSuccessAt: now
    });
  }

  private async drainChannel(
    signal: AbortSignal,
    claim: (waitMs: number, signal: AbortSignal) => Promise<RelayProxyRequest[]>,
    proxy: (request: RelayProxyRequest) => Promise<void>
  ): Promise<void> {
    while (!signal.aborted) {
      const requests = await claim(0, signal);
      if (requests.length === 0) return;
      for (const request of requests) await proxy(request);
    }
  }

  private async run(config: RabiLinkRelayRuntimeConfig, generation: number, signal: AbortSignal): Promise<void> {
    let webguiDrain: Promise<void> | null = null;
    let speechDrain: Promise<void> | null = null;
    let webguiDrainFailures = 0;
    let speechDrainFailures = 0;
    const webguiEvents = new Map<string, Promise<void>>();
    const markChannelsOnline = (): void => {
      if (webguiDrainFailures === 0
        && (!config.speechProxyEnabled || speechDrainFailures === 0)
        && this.active(generation, signal)) {
        this.markOnline(config.speechProxyEnabled);
      }
    };
    const startWebguiEvents = (): void => {
      if (signal.aborted) return;
      for (const streamPath of WEBGUI_EVENT_STREAM_PATHS) {
        if (webguiEvents.has(streamPath)) continue;
        const running = forwardLocalWebguiEvents(config, streamPath, signal, this.options)
          .finally(() => webguiEvents.delete(streamPath));
        webguiEvents.set(streamPath, running);
      }
    };
    const drainWebgui = (): void => {
      if (webguiDrain || !this.active(generation, signal)) return;
      let retry = false;
      const attempt: Promise<void> = this.drainChannel(
        signal,
        (waitMs, channelSignal) => claimWebguiRequests(config, waitMs, channelSignal),
        (request) => proxyWebguiRequest(config, request, this.options, signal)
      ).then(() => {
        webguiDrainFailures = 0;
        markChannelsOnline();
      }).catch(async error => {
        if (!this.active(generation, signal)) return;
        webguiDrainFailures += 1;
        retry = true;
        const message = runtimeErrorMessage(error);
        this.setStatus({
          state: "error",
          message: `RabiLink WebGUI 事件处理失败：${message}`,
          lastConnectedAt: this.runtimeStatus.lastConnectedAt,
          lastSuccessAt: this.runtimeStatus.lastSuccessAt,
          error: message
        });
        await delay(Math.min(
          this.options.channelRetryDelayMs * webguiDrainFailures,
          MAX_CHANNEL_RETRY_DELAY_MS
        ), signal);
      }).finally(() => {
        if (webguiDrain === attempt) webguiDrain = null;
        if (retry && this.active(generation, signal)) drainWebgui();
      });
      webguiDrain = attempt;
    };
    const drainSpeech = (): void => {
      if (!config.speechProxyEnabled || speechDrain || !this.active(generation, signal)) return;
      let retry = false;
      const attempt: Promise<void> = this.drainChannel(
        signal,
        (waitMs, channelSignal) => claimSpeechRequests(config, waitMs, channelSignal),
        (request) => proxySpeechRequest(config, request, this.options, signal)
      ).then(() => {
        speechDrainFailures = 0;
        markChannelsOnline();
      }).catch(async error => {
        if (!this.active(generation, signal)) return;
        speechDrainFailures += 1;
        retry = true;
        const message = runtimeErrorMessage(error);
        this.setStatus({
          state: "error",
          message: `RabiLink 语音事件处理失败：${message}`,
          lastConnectedAt: this.runtimeStatus.lastConnectedAt,
          lastSuccessAt: this.runtimeStatus.lastSuccessAt,
          error: message
        });
        await delay(Math.min(
          this.options.channelRetryDelayMs * speechDrainFailures,
          MAX_CHANNEL_RETRY_DELAY_MS
        ), signal);
      }).finally(() => {
        if (speechDrain === attempt) speechDrain = null;
        if (retry && this.active(generation, signal)) drainSpeech();
      });
      speechDrain = attempt;
    };
    try {
      while (this.active(generation, signal)) {
        try {
          await consumeRelayEvents(config, signal, (eventType, data) => {
            try {
              this.onEvent?.(eventType, data);
            } catch {
              // Relay ownership and proxy delivery do not depend on observers.
            }
            if (eventType === "ready") {
              markChannelsOnline();
              startWebguiEvents();
              drainWebgui();
              drainSpeech();
            } else if (eventType === "webgui_available") {
              drainWebgui();
            } else if (eventType === "speech_available") {
              drainSpeech();
            }
          });
          if (this.active(generation, signal)) throw new Error("RabiLink Relay event stream closed.");
        } catch (error) {
          if (signal.aborted || abortError(error) || !this.active(generation, signal)) return;
          const message = runtimeErrorMessage(error);
          this.setStatus({
            state: "error",
            message: `RabiLink Relay 事件流连接失败：${message}`,
            lastConnectedAt: this.runtimeStatus.lastConnectedAt,
            lastSuccessAt: this.runtimeStatus.lastSuccessAt,
            error: message
          });
          await delay(RETRY_DELAY_MS, signal);
        }
      }
    } finally {
      await Promise.allSettled([
        ...webguiEvents.values(),
        ...(webguiDrain ? [webguiDrain] : []),
        ...(speechDrain ? [speechDrain] : [])
      ]);
    }
  }
}
