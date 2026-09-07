#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { appendDeviceLogs, deviceLogFacets, readDeviceLogs } from "./rabilink-device-log-store.mjs";
import { RabiLinkEventHub } from "./rabilink-event-hub.mjs";
import { RelayProxyRequestQueue } from "./rabilink-proxy-request-queue.mjs";

const port = Number(process.env.PORT || process.env.RABILINK_RELAY_PORT || 8788);
const host = process.env.HOST || process.env.RABILINK_RELAY_HOST || "0.0.0.0";
const replyTimeoutMs = clamp(Number(process.env.RABILINK_RELAY_REPLY_TIMEOUT_MS || 60000), 1000, 120000);
const messageWaitMs = clamp(Number(process.env.RABILINK_RELAY_MESSAGE_WAIT_MS || 60000), 0, 60000);
const outboxWaitMs = clamp(Number(process.env.RABILINK_RELAY_OUTBOX_WAIT_MS || 60000), 0, 60000);
const workerTaskWaitMs = clamp(Number(process.env.RABILINK_RELAY_WORKER_TASK_WAIT_MS || 60000), 0, 60000);
const webguiRequestWaitMs = clamp(Number(process.env.RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS || 30000), 5000, 120000);
const webguiBodyMaxBytes = clamp(Number(process.env.RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES || 40 * 1024 * 1024), 1024 * 1024, 50 * 1024 * 1024);
const webguiWorkerResponseMaxBytes = Math.ceil(webguiBodyMaxBytes * 4 / 3) + 1024 * 1024;
const webguiWorkerEventMaxBytes = 1024 * 1024;
const speechRequestWaitMs = clamp(Number(process.env.RABILINK_RELAY_SPEECH_REQUEST_WAIT_MS || 180000), 5000, 10 * 60 * 1000);
const speechBodyMaxBytes = clamp(Number(process.env.RABILINK_RELAY_SPEECH_BODY_MAX_BYTES || 25 * 1024 * 1024), 1024 * 1024, 100 * 1024 * 1024);
const speechWorkerResponseMaxBytes = Math.ceil(speechBodyMaxBytes * 4 / 3) + 1024 * 1024;
const speechRetentionMs = clamp(Number(process.env.RABILINK_RELAY_SPEECH_RETENTION_MS || 60000), 5000, 10 * 60 * 1000);
const taskTtlMs = clamp(Number(process.env.RABILINK_RELAY_TASK_TTL_MS || 10 * 60 * 1000), 60000, 24 * 60 * 60 * 1000);
const outboxTtlMs = clamp(Number(process.env.RABILINK_RELAY_OUTBOX_TTL_MS || 48 * 60 * 60 * 1000), 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const leaseMs = clamp(Number(process.env.RABILINK_RELAY_LEASE_MS || 3 * 60 * 1000), 5000, 10 * 60 * 1000);
const dataDir = path.resolve(process.env.RABILINK_RELAY_DATA_DIR || path.join(process.cwd(), "data", "rabilink-relay"));
const eventLogPath = path.join(dataDir, "events.jsonl");
const accountLogDir = path.join(dataDir, "account-logs");
const deviceLogDir = path.join(dataDir, "device-logs");
const mobileProofDir = path.join(dataDir, "mobile-proofs");
const mobileDeviceStatusDir = path.join(dataDir, "mobile-device-status");
const deviceMediaDir = path.join(dataDir, "device-media");
const deviceMediaMaxBytes = clamp(Number(process.env.RABILINK_RELAY_DEVICE_MEDIA_MAX_BYTES || 64 * 1024 * 1024), 1024 * 1024, 512 * 1024 * 1024);
const deviceMediaTtlMs = clamp(Number(process.env.RABILINK_RELAY_DEVICE_MEDIA_TTL_MS || 7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
let deviceMediaCleanupTimer = null;
let deviceMediaCleanupDeadline = 0;
const mobileDeviceStatusStaleMs = clamp(
  Number(process.env.RABILINK_RELAY_MOBILE_DEVICE_STATUS_STALE_MS || 3 * 60 * 1000),
  60000,
  15 * 60 * 1000
);
const accountLogMaxRows = clamp(Number(process.env.RABILINK_RELAY_ACCOUNT_LOG_MAX_ROWS || 300), 50, 2000);
const deviceLogMaxRows = clamp(Number(process.env.RABILINK_RELAY_DEVICE_LOG_MAX_ROWS || 5000), 100, 50000);
const deviceBindingClaimTtlMs = clamp(Number(process.env.RABILINK_RELAY_DEVICE_BINDING_CLAIM_TTL_MS || 10 * 60 * 1000), 60000, 60 * 60 * 1000);
const appStorePath = path.resolve(process.env.RABILINK_RELAY_APP_STORE_FILE || path.join(dataDir, "apps.json"));
const runtimeStatePath = path.join(dataDir, "runtime-state.json");
const outboxCursorStatePath = path.join(dataDir, "outbox-cursor-state.json");
const webguiDistPath = path.resolve(process.env.RABILINK_RELAY_WEBGUI_DIST_DIR || path.join(process.cwd(), "ribiwebgui", "dist"));
const webguiAssetPath = path.resolve(process.env.RABILINK_RELAY_WEBGUI_ASSET_DIR || path.join(process.cwd(), "assets"));
const openApiFileCandidates = [
  process.env.RABILINK_RELAY_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.CURRENT.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.CURRENT.openapi.json")
].filter(Boolean);
const manualAuthOpenApiFileCandidates = [
  process.env.RABILINK_RELAY_MANUAL_AUTH_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_MANUAL_AUTH_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.MANUAL_AUTH.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.MANUAL_AUTH.openapi.json")
].filter(Boolean);
const agentTokenOpenApiFileCandidates = [
  process.env.RABILINK_RELAY_AGENT_TOKEN_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_AGENT_TOKEN_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.AGENT_TOKEN.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.AGENT_TOKEN.openapi.json")
].filter(Boolean);
const toolImportPostmanFileCandidates = [
  process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE ? path.resolve(process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE) : "",
  path.join(dataDir, "rokid-rabilink-tools-import.CURRENT.postman.json"),
  path.join(process.cwd(), "rokid-rabilink-tools-import.CURRENT.postman.json")
].filter(Boolean);
const speechOpenApiFileCandidates = [
  process.env.RABILINK_RELAY_SPEECH_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_SPEECH_OPENAPI_FILE) : "",
  path.join(dataDir, "rabilink-speech-api.openapi.json"),
  path.join(process.cwd(), "examples", "rabilink-relay", "rabilink-speech-api.openapi.json")
].filter(Boolean);
const sensitiveEventKeyPattern = /token|authorization|cookie|password|secret|text|message|content|raw|headers|body|response|reply/i;
const portablePresentationValues = new Set(["text", "tts", "notification", "haptic"]);
const portablePriorityValues = new Set(["quiet", "normal", "urgent"]);
const portableHealthMetricValues = new Set(["heart_rate", "sleep_session", "sleep_stage", "sleep_state"]);
const speechProxyPrefix = "/api/rabilink/speech";
const speechProxyPaths = new Map([
  ["GET /health", "/health"],
  ["GET /v1/models", "/v1/models"],
  ["GET /v1/capabilities", "/v1/capabilities"],
  ["GET /v1/audio-streams", "/v1/audio-streams"],
  ["GET /v1/microphone/status", "/v1/microphone/status"],
  ["GET /v1/records", "/v1/records"],
  ["POST /v1/audio/speech", "/v1/audio/speech"],
  ["POST /v1/audio/transcriptions", "/v1/audio/transcriptions"],
  ["POST /v1/audio-streams/rabilink/start", "/v1/audio-streams/rabilink/start"],
  ["POST /v1/audio-streams/rabilink/chunk", "/v1/audio-streams/rabilink/chunk"],
  ["POST /v1/audio-streams/rabilink/keepalive", "/v1/audio-streams/rabilink/keepalive"],
  ["POST /v1/audio-streams/rabilink/stop", "/v1/audio-streams/rabilink/stop"],
  ["POST /messages", "/api/speech/messages"],
  ["POST /api/v1/services/audio/tts/SpeechSynthesizer", "/api/v1/services/audio/tts/SpeechSynthesizer"],
  ["POST /api/v1/services/audio/asr/transcription", "/api/v1/services/audio/asr/transcription"]
]);
const webguiEventStreamPaths = new Set(["/api/events", "/api/speech/events"]);

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(accountLogDir, { recursive: true });
fs.mkdirSync(deviceLogDir, { recursive: true });
fs.mkdirSync(mobileProofDir, { recursive: true });
fs.mkdirSync(mobileDeviceStatusDir, { recursive: true });
fs.mkdirSync(deviceMediaDir, { recursive: true });
scheduleDeviceMediaCleanup(cleanupExpiredDeviceMedia());
if (!hasEnabledRabiLinkApps()) {
  console.warn("No enabled RabiLink app tokens exist yet. Open /manage to create the first account and app token.");
}

/** @type {Map<string, RelayTask>} */
const tasks = new Map();
/** @type {RelayOutboxMessage[]} */
const outboxMessages = [];
let nextOutboxMessageSeq = 1;
let outboxCursorGeneration = "";
let outboxCursorHighWater = 0;
const relayEventHub = new RabiLinkEventHub();
const webguiEventHub = new RabiLinkEventHub();

function scheduleLeaseAvailability(eventType, appId, targetDeviceId, leaseUntil, data = {}) {
  const delayMs = Math.max(0, Number(leaseUntil || 0) - Date.now()) + 10;
  const timer = setTimeout(() => {
    relayEventHub.publish(eventType, { appId, targetDeviceId, data: { ...data, leaseExpired: true } });
  }, Math.min(2_147_000_000, delayMs));
  timer.unref();
}
/** @type {Array<{ resolve: (value: RelayTask) => void; taskId: string; timer: NodeJS.Timeout }>} */
const waiters = [];
/** @type {Map<string, RelayWebguiRequest>} */
const webguiRequests = new Map();
const speechRequests = new RelayProxyRequestQueue({
  name: "Speech",
  idPrefix: "rabilink-speech",
  requestWaitMs: speechRequestWaitMs,
  leaseMs,
  retentionMs: speechRetentionMs
});
/** @type {Map<string, ManageSession>} */
const manageSessions = new Map();
/** @type {Map<string, Set<http.ServerResponse>>} */
const accountLogStreams = new Map();
recoverInterruptedFileReplacement(runtimeStatePath);
recoverInterruptedFileReplacement(outboxCursorStatePath);
loadRelayRuntimeState();
ensureOutboxCursorState();

function recoverInterruptedFileReplacement(targetPath) {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  if (!fs.existsSync(directory)) return;
  const backups = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && entry.name.startsWith(`${basename}.`)
      && entry.name.endsWith(".replace-backup"))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        // A concurrent cleanup may remove a stale backup.
      }
      return { filePath, mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!backups.length) return;

  if (!fs.existsSync(targetPath)) {
    const recovery = backups.shift();
    if (recovery && fs.existsSync(recovery.filePath)) {
      fs.renameSync(recovery.filePath, targetPath);
    }
  }
  for (const backup of backups) {
    try {
      fs.rmSync(backup.filePath, { force: true });
    } catch {
      // Stale backup cleanup is best effort.
    }
  }
}

function replaceFileSync(tmpPath, targetPath) {
  try {
    fs.renameSync(tmpPath, targetPath);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !fs.existsSync(targetPath)) throw error;
  }

  const backupPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.replace-backup`;
  let existingMoved = false;
  try {
    fs.renameSync(targetPath, backupPath);
    existingMoved = true;
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    if (!fs.existsSync(targetPath) && existingMoved && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
    }
    throw error;
  }
  try {
    fs.rmSync(backupPath, { force: true });
  } catch {
    // A stale backup is safer than reporting a failed state write after the target was replaced.
  }
}

function replaceMapFromArray(map, items, idKey = "id") {
  map.clear();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = typeof item[idKey] === "string" ? item[idKey] : "";
    if (!id) continue;
    map.set(id, item);
  }
}

function loadRelayRuntimeState() {
  if (!fs.existsSync(runtimeStatePath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
    replaceMapFromArray(tasks, parsed?.tasks);
    outboxMessages.splice(
      0,
      outboxMessages.length,
      ...(Array.isArray(parsed?.outboxMessages) ? parsed.outboxMessages.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [])
    );
    const storedNextSeq = Number(parsed?.nextOutboxMessageSeq);
    const maxOutboxSeq = outboxMessages.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0);
    nextOutboxMessageSeq = Math.max(Number.isFinite(storedNextSeq) ? storedNextSeq : 1, maxOutboxSeq + 1, 1);
  } catch (error) {
    console.warn(`Failed to read RabiLink runtime state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveRelayRuntimeState() {
  const tmpPath = `${runtimeStatePath}.${process.pid}.tmp`;
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    nextOutboxMessageSeq,
    tasks: [...tasks.values()],
    outboxMessages
  };
  try {
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    replaceFileSync(tmpPath, runtimeStatePath);
    ensureOutboxCursorState();
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors for a best-effort runtime cache.
    }
    console.warn(`Failed to write RabiLink runtime state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @typedef {object} RelayTask
 * @property {string} id
 * @property {string} status
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} expiresAt
 * @property {number} leaseUntil
 * @property {number} attempts
 * @property {string} text
 * @property {string} normalizedText
 * @property {string} appId
 * @property {string} appName
 * @property {string} targetDeviceId
 * @property {Record<string, unknown>} source
 * @property {unknown} raw
 * @property {RelayMessage[]} messages
 * @property {number} nextMessageSeq
 * @property {string} [replyText]
 * @property {unknown} [replyRaw]
 * @property {string} [error]
 */

/**
 * @typedef {object} RelayMessage
 * @property {string} id
 * @property {number} seq
 * @property {number} createdAt
 * @property {string} text
 * @property {boolean} final
 * @property {unknown} raw
 */

/**
 * @typedef {object} RelayOutboxMessage
 * @property {string} id
 * @property {number} seq
 * @property {string} appId
 * @property {string} taskId
 * @property {string} taskMessageId
 * @property {string} [deliveryId]
 * @property {number} createdAt
 * @property {string} text
 * @property {boolean} final
 * @property {string} status
 * @property {boolean} [proactive]
 * @property {string} [source]
 * @property {string[]} [targetDeviceIds]
 * @property {string[]} [targetDeviceKinds]
 * @property {string[]} [presentation]
 * @property {"quiet" | "normal" | "urgent"} [priority]
 * @property {Array<{
 *   deviceId: string;
 *   deviceKind: string;
 *   deliveredAt?: number;
 *   playedAt?: number;
 *   playbackFailedAt?: number;
 *   playbackFailure?: string;
 * }>} [receipts]
 */

/**
 * @typedef {object} RelayWorker
 * @property {string} id
 * @property {string} guid
 * @property {string} name
 * @property {string} appId
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {string} [lastDisconnectedAt]
 */

/**
 * @typedef {object} RelayWebguiRequest
 * @property {string} id
 * @property {string} status
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} expiresAt
 * @property {number} leaseUntil
 * @property {number} attempts
 * @property {string} appId
 * @property {string} appName
 * @property {string} targetDeviceId
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} headers
 * @property {string} bodyBase64
 * @property {RelayWebguiResponse | null} response
 * @property {string} [error]
 */

/**
 * @typedef {object} RelayWebguiResponse
 * @property {number} statusCode
 * @property {Record<string, string>} headers
 * @property {string} bodyBase64
 */

/**
 * @typedef {object} ManageSession
 * @property {string} token
 * @property {string} accountId
 * @property {string} username
 * @property {number} expiresAt
 */

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function writeOutboxCursorState(generation, highWater) {
  const tmpPath = `${outboxCursorStatePath}.${process.pid}.tmp`;
  const state = {
    version: 1,
    generation,
    highWater,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    replaceFileSync(tmpPath, outboxCursorStatePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors for a best-effort cursor continuity file.
    }
    console.warn(`Failed to write RabiLink outbox cursor state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureOutboxCursorState() {
  const runtimeHighWater = Math.max(0, nextOutboxMessageSeq - 1);
  let storedGeneration = "";
  let storedHighWater = 0;
  try {
    if (fs.existsSync(outboxCursorStatePath)) {
      const parsed = JSON.parse(fs.readFileSync(outboxCursorStatePath, "utf8"));
      storedGeneration = stringValue(parsed?.generation);
      storedHighWater = Math.max(0, Number(parsed?.highWater) || 0);
    }
  } catch (error) {
    console.warn(`Failed to read RabiLink outbox cursor state: ${error instanceof Error ? error.message : String(error)}`);
  }

  const runtimeRolledBack = Boolean(storedGeneration) && runtimeHighWater < storedHighWater;
  const generation = !storedGeneration || runtimeRolledBack ? randomUUID() : storedGeneration;
  const highWater = runtimeRolledBack ? runtimeHighWater : Math.max(storedHighWater, runtimeHighWater);
  const changed = generation !== storedGeneration || highWater !== storedHighWater;
  outboxCursorGeneration = generation;
  outboxCursorHighWater = highWater;
  if (changed) writeOutboxCursorState(generation, highWater);
}

function nowIsoAfter(value) {
  const previous = Date.parse(String(value || ""));
  return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function sanitizeSharedEventData(value, depth = 0, key = "") {
  if (depth > 6) return "[truncated]";
  if (key && sensitiveEventKeyPattern.test(key)) {
    if (value == null || value === "") return value;
    if (Array.isArray(value)) return `[redacted:${value.length}]`;
    if (typeof value === "object") return "[redacted]";
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSharedEventData(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeSharedEventData(entryValue, depth + 1, entryKey)
      ])
    );
  }
  return value;
}

function writeEvent(event, data) {
  const row = JSON.stringify({ time: nowIso(), event, data: sanitizeSharedEventData(data) });
  fs.appendFile(eventLogPath, `${row}\n`, () => {});
}

function textPreview(value, maxLength = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function accountLogPath(accountId) {
  const id = sanitizeRabiLinkId(accountId, "");
  if (!id) return "";
  return path.join(accountLogDir, `${id}.jsonl`);
}

function trimAccountLogFile(filePath) {
  fs.readFile(filePath, "utf8", (readError, text) => {
    if (readError) return;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length <= accountLogMaxRows) return;
    fs.writeFile(filePath, `${lines.slice(-accountLogMaxRows).join("\n")}\n`, () => {});
  });
}

function writeAccountLog(account, event, data = {}) {
  if (!account?.id) return;
  const filePath = accountLogPath(account.id);
  if (!filePath) return;
  const row = {
    id: randomId("log"),
    time: nowIso(),
    event,
    level: data.level || "info",
    title: data.title || event,
    detail: data.detail || "",
    appId: data.appId || "",
    appName: data.appName || "",
    workerId: data.workerId || "",
    workerName: data.workerName || "",
    deviceId: data.deviceId || "",
    deviceKind: data.deviceKind || "",
    deviceName: data.deviceName || "",
    source: data.source || "",
    appVersion: data.appVersion || "",
    sessionId: data.sessionId || "",
    taskId: data.taskId || "",
    status: data.status || "",
    method: data.method || "",
    path: data.path || "",
    messageCount: Number(data.messageCount || 0),
    waitMs: Number(data.waitMs || 0),
    textPreview: textPreview(data.textPreview || data.text || ""),
    error: textPreview(data.error || "", 220)
  };
  fs.appendFile(filePath, `${JSON.stringify(row)}\n`, (error) => {
    if (error) return;
    trimAccountLogFile(filePath);
    broadcastAccountLog(account.id, row);
  });
}

function writeAccountLogForApp(app, event, data = {}) {
  if (!app?.ownerAccountId) return;
  writeAccountLog({ id: app.ownerAccountId }, event, {
    appId: app.id,
    appName: app.name || "",
    ...data
  });
}

function readAccountLogs(account, limit = 120) {
  const filePath = accountLogPath(account?.id || "");
  if (!filePath || !fs.existsSync(filePath)) return [];
  const max = clamp(Number(limit || 120), 1, 300);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-max);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function writeSse(res, event, data, id = "") {
  if (id) res.write(`id: ${String(id).replace(/\r?\n/g, "")}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastAccountLog(accountId, row) {
  const streams = accountLogStreams.get(accountId);
  if (!streams?.size) return;
  for (const stream of streams) {
    writeSse(stream, "log", row, row.id);
  }
}

function handleAccountLogStream(req, res, account) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(": connected\n\n");
  writeSse(res, "snapshot", { logs: readAccountLogs(account, 120) });

  let streams = accountLogStreams.get(account.id);
  if (!streams) {
    streams = new Set();
    accountLogStreams.set(account.id, streams);
  }
  streams.add(res);

  // event-driven-allow: SSE protocol keepalive; no business state is queried.
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    streams.delete(res);
    if (streams.size === 0) accountLogStreams.delete(account.id);
  });
}

function rabiLinkTokenPreview(value) {
  const tokenText = String(value || "");
  return tokenText.length <= 12 ? tokenText : `${tokenText.slice(0, 8)}...${tokenText.slice(-4)}`;
}

function generateRabiLinkToken() {
  return `rbl_${randomBytes(24).toString("base64url")}`;
}

function generateRabiLinkDeviceToken() {
  return `rbd_${randomBytes(32).toString("base64url")}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeDeviceSerialNumber(value) {
  return String(value || "").trim().toUpperCase();
}

function validateDeviceSerialNumber(value) {
  const serialNumber = normalizeDeviceSerialNumber(value);
  if (!/^[0-9A-Z._:-]{4,128}$/.test(serialNumber)) {
    const error = new Error("眼镜 SN 需要 4-128 位，只能包含字母、数字、点、下划线、冒号或短横线。");
    error.statusCode = 400;
    throw error;
  }
  return serialNumber;
}

function deviceSerialPreview(value) {
  const serialNumber = normalizeDeviceSerialNumber(value);
  if (serialNumber.length <= 8) return serialNumber;
  return `${serialNumber.slice(0, 4)}...${serialNumber.slice(-4)}`;
}

function normalizeDeviceBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const serialHash = String(binding.serialHash || "").trim();
  if (!serialHash) return null;
  return {
    id: String(binding.id || randomId("glasses")).trim(),
    serialHash,
    serialPreview: String(binding.serialPreview || "已绑定眼镜").trim(),
    enabled: binding.enabled !== false,
    credentialHash: String(binding.credentialHash || "").trim(),
    createdAt: String(binding.createdAt || nowIso()),
    updatedAt: String(binding.updatedAt || binding.createdAt || nowIso()),
    claimedAt: String(binding.claimedAt || ""),
    claimExpiresAt: String(binding.claimExpiresAt || "")
  };
}

function randomId(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(String(password || ""), salt, 32).toString("hex")
  };
}

function verifyPassword(password, account) {
  if (!account?.passwordHash || !account?.passwordSalt) return false;
  const expected = Buffer.from(account.passwordHash, "hex");
  const actual = scryptSync(String(password || ""), account.passwordSalt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const split = part.indexOf("=");
      if (split < 0) return [part, ""];
      return [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
    }));
}

function cleanupManageSessions(now = Date.now()) {
  for (const [token, session] of manageSessions.entries()) {
    if (session.expiresAt <= now) manageSessions.delete(token);
  }
}

function createManageSession(account) {
  cleanupManageSessions();
  const token = randomBytes(32).toString("base64url");
  const session = {
    token,
    accountId: account.id,
    username: account.username,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  manageSessions.set(token, session);
  return session;
}

function manageSessionCookie(session) {
  return `rabilink_manage_session=${encodeURIComponent(session.token)}; Path=/manage; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearManageSessionCookie() {
  return "rabilink_manage_session=; Path=/manage; HttpOnly; SameSite=Lax; Max-Age=0";
}

function accountFromManageSession(req) {
  cleanupManageSessions();
  const token = parseCookies(req).rabilink_manage_session || "";
  if (!token) return null;
  const session = manageSessions.get(token);
  if (!session) return null;
  const account = readAppStore().accounts.find((item) => item.id === session.accountId);
  if (!account) {
    manageSessions.delete(token);
    return null;
  }
  return account;
}

function sanitizeRabiLinkId(value, fallback) {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeWorkerPeerUrls(value) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = value.split(",");
    }
  }
  const result = [];
  for (const item of items) {
    try {
      const url = new URL(String(item || "").trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
      url.pathname = "";
      url.search = "";
      url.hash = "";
      const normalized = url.toString().replace(/\/$/, "");
      if (normalized.length <= 240 && !result.includes(normalized)) result.push(normalized);
    } catch {
      // Ignore malformed peer advertisements instead of rejecting worker presence.
    }
  }
  return result.slice(0, 8);
}

function normalizeStoredWorker(worker) {
  const id = String(worker?.id || "").trim();
  if (!id) return null;
  const time = String(worker?.lastSeenAt || worker?.firstSeenAt || nowIso());
  return {
    id,
    guid: String(worker?.guid || "").trim(),
    name: String(worker?.name || id).trim() || id,
    appId: String(worker?.appId || "").trim(),
    deviceKind: normalizeWorkerDeviceKind(worker?.deviceKind),
    capabilities: normalizeWorkerCapabilities(worker?.capabilities),
    peerUrls: normalizeWorkerPeerUrls(worker?.peerUrls),
    firstSeenAt: String(worker?.firstSeenAt || time),
    lastSeenAt: String(worker?.lastSeenAt || time),
    lastDisconnectedAt: String(worker?.lastDisconnectedAt || "")
  };
}

function readAppStore() {
  if (!fs.existsSync(appStorePath)) {
    return { accounts: [], apps: [], workers: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(appStorePath, "utf8").replace(/^\uFEFF/, ""));
    return {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      apps: Array.isArray(raw.apps)
        ? raw.apps.map((app) => ({
          ...app,
          enabled: app.enabled !== false,
          tokenPreview: app.tokenPreview || rabiLinkTokenPreview(app.token),
          targetDeviceId: String(app.targetDeviceId || "").trim(),
          deviceBindings: Array.isArray(app.deviceBindings)
            ? app.deviceBindings.map(normalizeDeviceBinding).filter(Boolean)
            : []
        }))
        : [],
      workers: Array.isArray(raw.workers) ? raw.workers.map(normalizeStoredWorker).filter(Boolean) : []
    };
  } catch (error) {
    writeEvent("app_store_read_failed", { path: appStorePath, message: error instanceof Error ? error.message : String(error) });
    return { accounts: [], apps: [], workers: [] };
  }
}

function writeAppStore(store) {
  fs.mkdirSync(path.dirname(appStorePath), { recursive: true });
  fs.writeFileSync(appStorePath, JSON.stringify({
    accounts: store.accounts,
    apps: store.apps,
    workers: store.workers || []
  }, null, 2), "utf8");
}

function hasEnabledRabiLinkApps() {
  return readAppStore().apps.some((app) => app.enabled !== false && app.token);
}

function findEnabledAppByToken(value) {
  const requestText = String(value || "");
  if (!requestText) return null;
  const store = readAppStore();
  const appTokenMatch = store.apps.find((app) => app.enabled !== false && app.token === requestText);
  if (appTokenMatch) return { app: appTokenMatch, deviceBinding: null };
  if (!requestText.startsWith("rbd_")) return null;
  const credentialHash = sha256(requestText);
  for (const app of store.apps) {
    if (app.enabled === false) continue;
    const deviceBinding = (app.deviceBindings || []).find((binding) => {
      return binding.enabled !== false && binding.credentialHash === credentialHash;
    });
    if (deviceBinding) return { app, deviceBinding };
  }
  return null;
}

function workerOnline(worker) {
  const identity = {
    appId: stringValue(worker?.appId),
    deviceId: stringValue(worker?.id),
    deviceGuid: stringValue(worker?.guid)
  };
  if (relayEventHub.hasSubscriber(identity)) return true;
  const lastSeenMs = Date.parse(worker?.lastSeenAt || "");
  if (!Number.isFinite(lastSeenMs)) return false;
  const lastDisconnectedMs = Date.parse(worker?.lastDisconnectedAt || "");
  if (Number.isFinite(lastDisconnectedMs) && lastDisconnectedMs >= lastSeenMs) return false;
  return Date.now() - lastSeenMs <= Math.max(workerTaskWaitMs * 2, 120000);
}

function selectedWorkerForApp(app) {
  const targetDeviceId = stringValue(app?.targetDeviceId);
  if (!app || !targetDeviceId) return null;
  return readAppStore().workers.find((worker) => worker.appId === app.id
    && workerCanProcessMobileRequests(worker)
    && (worker.id === targetDeviceId || worker.guid === targetDeviceId)) || null;
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function publicApp(app, options = {}) {
  return {
    id: app.id,
    name: app.name,
    ownerAccountId: app.ownerAccountId,
    enabled: app.enabled !== false,
    tokenPreview: app.tokenPreview || rabiLinkTokenPreview(app.token),
    token: options.revealToken ? app.token : undefined,
    notes: app.notes || "",
    targetDeviceId: app.targetDeviceId || "",
    deviceBindings: (app.deviceBindings || []).map((binding) => ({
      id: binding.id,
      serialPreview: binding.serialPreview,
      enabled: binding.enabled !== false,
      claimed: Boolean(binding.credentialHash),
      claimedAt: binding.claimedAt || "",
      claimExpiresAt: binding.claimExpiresAt || "",
      createdAt: binding.createdAt || "",
      updatedAt: binding.updatedAt || ""
    })),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

function publicWorker(worker, app) {
  const appTokenPreview = app ? app.tokenPreview || rabiLinkTokenPreview(app.token) : "";
  return {
    id: worker.id,
    guid: worker.guid || "",
    name: worker.name || worker.id,
    appId: worker.appId || "",
    appName: app?.name || "",
    appTokenPreview,
    deviceKind: normalizeWorkerDeviceKind(worker.deviceKind),
    capabilities: normalizeWorkerCapabilities(worker.capabilities),
    peerUrls: normalizeWorkerPeerUrls(worker.peerUrls),
    firstSeenAt: worker.firstSeenAt || "",
    lastSeenAt: worker.lastSeenAt || "",
    lastDisconnectedAt: worker.lastDisconnectedAt || "",
    online: workerOnline(worker)
  };
}

function accountStorePayload(account, options = {}) {
  const store = readAppStore();
  const apps = account
    ? store.apps.filter((app) => app.ownerAccountId === account.id)
    : [];
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const workers = store.workers.filter((worker) => appsById.has(worker.appId));
  return {
    code: 0,
    ok: true,
    setupRequired: store.accounts.length === 0,
    account: account ? publicAccount(account) : null,
    apps: apps.map((app) => publicApp(app, { revealToken: true })),
    workers: workers
      .filter(workerCanProcessMobileRequests)
      .map((worker) => publicWorker(worker, appsById.get(worker.appId))),
    logs: account ? readAccountLogs(account, options.logLimit || 80) : [],
    dataPath: path.relative(process.cwd(), appStorePath).replace(/\\/g, "/")
  };
}

function normalizeWorkerCapabilities(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => /^[a-z][a-z0-9._-]{0,31}$/.test(item)))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeWorkerDeviceKind(value) {
  const kind = stringValue(value).toLowerCase();
  return /^[a-z][a-z0-9._-]{0,31}$/.test(kind) ? kind : "";
}

function workerCanProcessMobileRequests(worker) {
  const terminalKinds = new Set(["phone", "glasses", "watch", "earbuds"]);
  const pcKinds = new Set(["pc", "desktop", "server", "workstation"]);
  const deviceKind = normalizeWorkerDeviceKind(worker?.deviceKind);
  if (terminalKinds.has(deviceKind)) return false;
  if (pcKinds.has(deviceKind)) return true;
  const capabilities = normalizeWorkerCapabilities(worker?.capabilities);
  if (capabilities.some((capability) => ["tasks", "webgui", "persona-sync", "speech"].includes(capability))) return true;
  return Boolean(stringValue(worker?.guid));
}

function recordWorkerSeen(appId, deviceId, deviceName, deviceGuid = "", capabilities = null, peerUrls = null, deviceKind = null) {
  const id = sanitizeRabiLinkId(deviceId || deviceName, "rabi-pc");
  if (!id) return null;
  const guid = stringValue(deviceGuid);
  const store = readAppStore();
  let time = nowIso();
  const name = stringValue(deviceName || id) || id;
  let worker = store.workers.find((item) => item.appId === appId && (item.id === id || (guid && item.guid === guid)));
  const app = store.apps.find((item) => item.id === appId);
  let peerChangeReason = "";
  if (worker) {
    const wasOnline = workerOnline(worker);
    const previousPeerShape = JSON.stringify({
      id: worker.id || "",
      guid: worker.guid || "",
      name: worker.name || "",
      deviceKind: normalizeWorkerDeviceKind(worker.deviceKind),
      capabilities: normalizeWorkerCapabilities(worker.capabilities),
      peerUrls: normalizeWorkerPeerUrls(worker.peerUrls)
    });
    time = nowIsoAfter(worker.lastDisconnectedAt);
    worker.id = worker.id || id;
    worker.guid = guid || worker.guid || "";
    worker.name = name;
    if (deviceKind !== null) worker.deviceKind = normalizeWorkerDeviceKind(deviceKind);
    if (capabilities !== null) worker.capabilities = normalizeWorkerCapabilities(capabilities);
    if (peerUrls !== null) worker.peerUrls = normalizeWorkerPeerUrls(peerUrls);
    worker.lastSeenAt = time;
    if (!wasOnline) {
      peerChangeReason = "reconnected";
      writeAccountLogForApp(app, "pc_reconnected", {
        title: "PC Rabi 重新连接",
        detail: `${name} 已重新上线。`,
        workerId: worker.id,
        workerName: worker.name,
        status: "online"
      });
    } else if (previousPeerShape !== JSON.stringify({
      id: worker.id || "",
      guid: worker.guid || "",
      name: worker.name || "",
      deviceKind: normalizeWorkerDeviceKind(worker.deviceKind),
      capabilities: normalizeWorkerCapabilities(worker.capabilities),
      peerUrls: normalizeWorkerPeerUrls(worker.peerUrls)
    })) {
      peerChangeReason = "updated";
    }
  } else {
    worker = {
      id,
      guid,
      name,
      appId,
      deviceKind: normalizeWorkerDeviceKind(deviceKind),
      capabilities: normalizeWorkerCapabilities(capabilities),
      peerUrls: normalizeWorkerPeerUrls(peerUrls),
      firstSeenAt: time,
      lastSeenAt: time
    };
    store.workers.push(worker);
    peerChangeReason = "connected";
    writeAccountLogForApp(app, "pc_connected", {
      title: "PC Rabi 已连接",
      detail: `${name} 第一次使用这个应用 token 连接服务器。`,
      workerId: worker.id,
      workerName: worker.name,
      status: "online"
    });
  }
  writeAppStore(store);
  if (peerChangeReason) {
    relayEventHub.publish("persona_sync_peer_changed", {
      appId,
      data: {
        peerId: worker.id,
        peerGuid: worker.guid || "",
        state: "online",
        reason: peerChangeReason
      }
    });
  }
  return worker;
}

function recordWorkerDisconnected(appId, deviceId, deviceGuid = "") {
  const id = sanitizeRabiLinkId(deviceId, "");
  const guid = stringValue(deviceGuid);
  if (!appId || (!id && !guid)) return;
  if (relayEventHub.hasSubscriber({ appId, deviceId: id, deviceGuid: guid })) return;
  const store = readAppStore();
  const worker = store.workers.find(item => item.appId === appId
    && ((id && item.id === id) || (guid && item.guid === guid)));
  if (!worker) return;
  worker.lastDisconnectedAt = nowIsoAfter(worker.lastSeenAt);
  writeAppStore(store);
  const app = store.apps.find(item => item.id === appId);
  writeAccountLogForApp(app, "pc_disconnected", {
    title: "PC Rabi 事件连接已断开",
    detail: `${worker.name || worker.id} 已离线。`,
    workerId: worker.id,
    workerName: worker.name,
    status: "offline"
  });
  relayEventHub.publish("persona_sync_peer_changed", {
    appId,
    data: {
      peerId: worker.id,
      peerGuid: worker.guid || "",
      state: "offline",
      reason: "disconnected"
    }
  });
}

function createAccount(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!/^[\p{L}\p{N}_@.-]{3,48}$/u.test(username)) {
    const error = new Error("账号名需要 3-48 位，可包含中文、字母、数字、下划线、点、@ 或短横线。");
    error.statusCode = 400;
    throw error;
  }
  if (password.length < 6) {
    const error = new Error("密码至少需要 6 位。");
    error.statusCode = 400;
    throw error;
  }
  const store = readAppStore();
  if (store.accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    const error = new Error(`账号 ${username} 已存在。`);
    error.statusCode = 409;
    throw error;
  }
  const time = nowIso();
  const { hash, salt } = passwordHash(password);
  const account = {
    id: randomId("account"),
    username,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: time,
    updatedAt: time
  };
  store.accounts.push(account);
  writeAppStore(store);
  writeEvent("admin_account_created", { account: publicAccount(account) });
  return account;
}

function loginAccount(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const account = readAppStore().accounts.find((item) => item.username.toLowerCase() === username.toLowerCase());
  if (!account || !verifyPassword(password, account)) {
    const error = new Error("账号或密码不正确。");
    error.statusCode = 401;
    throw error;
  }
  return account;
}

function adminCredentials(req, url, body = {}) {
  const header = String(req.headers["x-rabilink-admin-auth"] || "");
  const basic = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i)?.[1] || "";
  const encoded = header || basic || url.searchParams.get("adminAuth") || "";
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split >= 0) {
        return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
      }
    } catch {
      return { username: "", password: "" };
    }
  }
  return {
    username: String(body.username || ""),
    password: String(body.password || "")
  };
}

function authorizeAdmin(req, url, body = {}) {
  const store = readAppStore();
  if (store.accounts.length === 0) return { ok: false, setupRequired: true, account: null };
  const credentials = adminCredentials(req, url, body);
  if (credentials.username || credentials.password) {
    const account = store.accounts.find((item) => item.username.toLowerCase() === credentials.username.toLowerCase());
    if (!account || !verifyPassword(credentials.password, account)) {
      return { ok: false, setupRequired: false, account: null };
    }
    return { ok: true, setupRequired: false, account };
  }
  const sessionAccount = accountFromManageSession(req);
  if (sessionAccount) return { ok: true, setupRequired: false, account: sessionAccount };
  return { ok: false, setupRequired: false, account: null };
}

function createAppForAccount(account, body) {
  const store = readAppStore();
  const time = nowIso();
  const tokenValue = generateRabiLinkToken();
  const baseId = sanitizeRabiLinkId(body.id, sanitizeRabiLinkId(body.name, "app"));
  let id = baseId;
  let suffix = 2;
  while (store.apps.some((app) => app.id === id)) {
    id = `${baseId}-${suffix++}`;
  }
  const app = {
    id,
    name: String(body.name || "").trim() || "RabiLink 应用",
    ownerAccountId: account.id,
    enabled: body.enabled !== false,
    token: tokenValue,
    tokenPreview: rabiLinkTokenPreview(tokenValue),
    notes: String(body.notes || "").trim(),
    targetDeviceId: String(body.targetDeviceId || "").trim(),
    deviceBindings: [],
    createdAt: time,
    updatedAt: time
  };
  store.apps.push(app);
  writeAppStore(store);
  writeEvent("admin_app_created", { app: publicApp(app) });
  writeAccountLog(account, "app_created", {
    title: "应用已创建",
    detail: `创建了应用 ${app.name}。`,
    appId: app.id,
    appName: app.name,
    status: "ok"
  });
  return app;
}

function patchOwnedApp(account, appId, body) {
  const store = readAppStore();
  const app = store.apps.find((item) => item.id === appId && item.ownerAccountId === account.id);
  if (!app) {
    const error = new Error(`RabiLink app not found: ${appId}`);
    error.statusCode = 404;
    throw error;
  }
  if (body.name !== undefined) app.name = String(body.name || "").trim() || app.name;
  if (body.notes !== undefined) app.notes = String(body.notes || "").trim();
  if (body.enabled !== undefined) app.enabled = body.enabled !== false;
  if (body.targetDeviceId !== undefined) {
    const targetDeviceId = String(body.targetDeviceId || "").trim();
    const targetWorker = targetDeviceId
      ? store.workers.find((worker) => worker.appId === app.id
        && (worker.id === targetDeviceId || worker.guid === targetDeviceId))
      : null;
    if (targetWorker && !workerCanProcessMobileRequests(targetWorker)) {
      const error = new Error(`RabiLink terminal cannot be selected as a processing Rabi PC: ${targetDeviceId}`);
      error.statusCode = 400;
      throw error;
    }
    app.targetDeviceId = targetDeviceId;
  }
  const revealToken = body.regenerateToken === true;
  if (revealToken) {
    app.token = generateRabiLinkToken();
    app.tokenPreview = rabiLinkTokenPreview(app.token);
  }
  app.updatedAt = nowIso();
  writeAppStore(store);
  writeEvent("admin_app_updated", { app: publicApp(app), regenerateToken: revealToken });
  writeAccountLog(account, "app_updated", {
    title: revealToken ? "应用 token 已重新生成" : "应用配置已更新",
    detail: revealToken ? `${app.name} 的旧 token 已失效。` : `${app.name} 的配置已保存。`,
    appId: app.id,
    appName: app.name,
    status: "ok"
  });
  return { app, revealToken };
}

function deleteOwnedApp(account, appId) {
  const store = readAppStore();
  const index = store.apps.findIndex((item) => item.id === appId && item.ownerAccountId === account.id);
  if (index < 0) {
    const error = new Error(`RabiLink app not found: ${appId}`);
    error.statusCode = 404;
    throw error;
  }
  const [removed] = store.apps.splice(index, 1);
  store.workers = (store.workers || []).filter((worker) => worker.appId !== removed.id);
  writeAppStore(store);
  writeEvent("admin_app_deleted", { app: publicApp(removed) });
  writeAccountLog(account, "app_deleted", {
    title: "应用已删除",
    detail: `删除了应用 ${removed.name}，关联 PC Rabi 记录也已移除。`,
    appId: removed.id,
    appName: removed.name,
    status: "ok"
  });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-rabilink-token,x-rabilink-admin-auth,idempotency-key,if-match",
    ...extraHeaders
  });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(text);
}

function readRawBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || webguiBodyMaxBytes);
  const label = String(options.label || "WebGUI");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      if (exceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`${label} request body is too large.`), { statusCode: 413 }));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
  });
}

function sendOpenApi(res, candidates = openApiFileCandidates) {
  const filePath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!filePath) {
    return sendJson(res, 404, { code: -1, ok: false, message: "OpenAPI document was not found." });
  }
  const text = fs.readFileSync(filePath, "utf8");
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(text);
}

function requestToken(req, url, body) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return String(req.headers["x-rabilink-token"] || bearer || url.searchParams.get("token") || body?.token || "");
}

function authorizeRabiLinkRequest(req, url, body) {
  const requestTokenValue = requestToken(req, url, body);
  const match = findEnabledAppByToken(requestTokenValue);
  if (match?.app) {
    return { ok: true, app: match.app, deviceBinding: match.deviceBinding || null, insecure: false };
  }
  return { ok: false, app: null, deviceBinding: null, insecure: false };
}

function sendRabiLinkAuthError(res, auth) {
  return sendRabiLinkError(res, auth.statusCode || 401, auth.message || "Unauthorized");
}

function sendRabiLinkError(res, statusCode, message) {
  return sendJson(res, statusCode, {
    code: -1,
    ok: false,
    status: "failed",
    done: true,
    shouldContinue: false,
    message,
    text: message,
    answer: message,
    reply: message,
    content: message
  });
}

function requireRokidAppTarget(auth, requiredCapability = "") {
  if (!auth.app) {
    const error = new Error("请使用 RabiLink服务器控制台里对应应用的 token。");
    error.statusCode = 401;
    throw error;
  }
  if (!auth.app.targetDeviceId) {
    writeAccountLogForApp(auth.app, "task_rejected_no_target", {
      title: "RabiLink 消息未转发",
      detail: "这个应用还没有选择要通讯的 Rabi PC。",
      status: "failed",
      error: "No target Rabi PC selected."
    });
    const error = new Error("这个 RabiLink 应用还没有选择要通讯的 Rabi PC。请先在 RabiLink服务器控制台为该应用选择一台已连接的 Rabi PC。");
    error.statusCode = 409;
    throw error;
  }
  const worker = selectedWorkerForApp(auth.app);
  if (!worker) {
    writeAccountLogForApp(auth.app, "task_rejected_missing_target", {
      title: "RabiLink 消息未转发",
      detail: `找不到绑定的 Rabi PC：${auth.app.targetDeviceId}`,
      workerId: auth.app.targetDeviceId,
      status: "failed",
      error: "Selected Rabi PC was not found."
    });
    const error = new Error(`找不到这个应用绑定的 Rabi PC：${auth.app.targetDeviceId}`);
    error.statusCode = 409;
    throw error;
  }
  if (!workerOnline(worker)) {
    writeAccountLogForApp(auth.app, "task_rejected_offline_target", {
      title: "RabiLink 消息未转发",
      detail: `绑定的 Rabi PC 当前未连接：${worker.name || worker.id}`,
      workerId: worker.id,
      workerName: worker.name || worker.id,
      status: "failed",
      error: "Selected Rabi PC is offline."
    });
    const error = new Error(`这个应用绑定的 Rabi PC 当前未连接：${worker.name || worker.id}`);
    error.statusCode = 503;
    throw error;
  }
  if (requiredCapability && !normalizeWorkerCapabilities(worker.capabilities).includes(requiredCapability)) {
    const error = new Error(`这个应用绑定的 Rabi PC 没有启用 ${requiredCapability} 能力。`);
    error.statusCode = 503;
    throw error;
  }
  return worker;
}

function canAccessTask(auth, task) {
  return Boolean(auth.app && task.appId === auth.app.id);
}

function workerIdentityFromBody(body = {}) {
  return {
    deviceId: stringValue(body?.deviceId || body?.workerId || body?.sourceDeviceId),
    deviceGuid: stringValue(body?.deviceGuid || body?.workerGuid || body?.sourceDeviceGuid)
  };
}

function workerIdentityMatchesTarget(targetDeviceId, identity, appId = "") {
  const target = stringValue(targetDeviceId);
  if (!target) return true;
  if (identity.deviceId === target || identity.deviceGuid === target) return true;
  if (!appId || !identity.deviceGuid) return false;
  const selectedWorker = readAppStore().workers.find((worker) => worker.appId === appId
    && (worker.id === target || worker.guid === target));
  return Boolean(selectedWorker?.guid && selectedWorker.guid === identity.deviceGuid);
}

function requireWorkerOwnsTarget(targetDeviceId, body, label, appId = "") {
  const identity = workerIdentityFromBody(body);
  if (workerIdentityMatchesTarget(targetDeviceId, identity, appId)) return identity;
  const error = new Error(`${label} can only be completed by the selected Rabi PC.`);
  error.statusCode = identity.deviceId || identity.deviceGuid ? 403 : 400;
  throw error;
}

function readBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || 0);
  const label = String(options.label || "JSON");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      if (exceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (maxBytes > 0 && total > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`${label} request body is too large.`), { statusCode: 413 }));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (exceeded) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/x-www-form-urlencoded")) {
        return resolve(Object.fromEntries(new URLSearchParams(text)));
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ text });
      }
    });
  });
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function portableRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function portableStringList(value, label, { lowercase = false, allowed = null } = {}) {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  if (items.length > 20) throw portableRequestError(`${label} accepts at most 20 values.`);
  const normalized = [];
  for (const item of items) {
    const text = stringValue(item);
    if (!text) continue;
    const next = lowercase ? text.toLowerCase() : text;
    if (next.length > 128) throw portableRequestError(`${label} contains a value longer than 128 characters.`);
    if (allowed && !allowed.has(next)) {
      throw portableRequestError(`${label} contains an unsupported value: ${next}`);
    }
    if (!normalized.includes(next)) normalized.push(next);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function persistedPortableStringList(value, { lowercase = false, allowed = null } = {}) {
  const items = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const item of items) {
    const text = stringValue(item);
    if (!text) continue;
    const next = lowercase ? text.toLowerCase() : text;
    if (next.length > 128 || (allowed && !allowed.has(next))) continue;
    if (!normalized.includes(next)) normalized.push(next);
  }
  return normalized.sort((left, right) => left.localeCompare(right)).slice(0, 20);
}

function portableDeviceKind(value, fallback = "") {
  const kind = stringValue(value || fallback).toLowerCase();
  if (!kind) return "";
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(kind)) {
    throw portableRequestError("deviceKind must be a short lowercase device category such as glasses, phone, watch, or earbuds.");
  }
  return kind;
}

function portableTransport(value, fallback = "") {
  const transport = stringValue(value || fallback).toLowerCase();
  if (!transport) return "";
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(transport)) {
    throw portableRequestError("transport must be a short transport identifier such as aiui-phone-proxy or wear-data-layer.");
  }
  return transport;
}

function portableTargetEnvelope(candidate, root = {}) {
  const targetDeviceIdsValue = candidate?.targetDeviceIds === undefined ? root?.targetDeviceIds : candidate.targetDeviceIds;
  const targetDeviceKindsValue = candidate?.targetDeviceKinds === undefined ? root?.targetDeviceKinds : candidate.targetDeviceKinds;
  const presentationValue = candidate?.presentation === undefined ? root?.presentation : candidate.presentation;
  const priorityValue = candidate?.priority === undefined ? root?.priority : candidate.priority;
  const priority = stringValue(priorityValue || "normal").toLowerCase();
  if (!portablePriorityValues.has(priority)) {
    throw portableRequestError("priority must be quiet, normal, or urgent.");
  }
  return {
    targetDeviceIds: portableStringList(targetDeviceIdsValue, "targetDeviceIds"),
    targetDeviceKinds: portableStringList(targetDeviceKindsValue, "targetDeviceKinds", { lowercase: true }),
    presentation: portableStringList(presentationValue, "presentation", { lowercase: true, allowed: portablePresentationValues }),
    priority
  };
}

function portableEnvelopeForResponse(message) {
  const priority = stringValue(message?.priority).toLowerCase();
  return {
    targetDeviceIds: persistedPortableStringList(message?.targetDeviceIds),
    targetDeviceKinds: persistedPortableStringList(message?.targetDeviceKinds, { lowercase: true }),
    presentation: persistedPortableStringList(message?.presentation, { lowercase: true, allowed: portablePresentationValues }),
    priority: portablePriorityValues.has(priority) ? priority : "normal",
    routeProfileId: stringValue(message?.routeProfileId).slice(0, 160),
    attachments: portableAttachments(message?.attachments)
  };
}

function portableAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    if (!item || typeof item !== "object") return null;
    const downloadPath = stringValue(item.downloadPath);
    if (!/^\/api\/rabilink\/devices\/media\/[^/?]+/.test(downloadPath)) return null;
    const kind = ["image", "video", "audio", "file"].includes(stringValue(item.kind)) ? stringValue(item.kind) : "file";
    return {
      id: stringValue(item.id).slice(0, 160), kind,
      fileName: safeMediaName(item.fileName || "attachment.bin"),
      contentType: stringValue(item.contentType || "application/octet-stream").slice(0, 160),
      size: Math.max(0, Number(item.size || 0)), downloadPath
    };
  }).filter(Boolean);
}

function portableDeviceIdentity(url, fallbackKind = "") {
  return {
    deviceId: stringValue(url.searchParams.get("deviceId")),
    deviceKind: portableDeviceKind(url.searchParams.get("deviceKind"), fallbackKind)
  };
}

function portableHealthNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(maximum, Math.max(minimum, number));
}

function portableHealthPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const policy = {};
  if (typeof value.enabled === "boolean") policy.enabled = value.enabled;
  if (value.heartRateHighBpm != null) policy.heartRateHighBpm = portableHealthNumber(value.heartRateHighBpm, 40, 240);
  if (value.heartRateLowBpm != null) policy.heartRateLowBpm = portableHealthNumber(value.heartRateLowBpm, 0, 150);
  if (value.heartRateAlertCooldownMinutes != null) policy.heartRateAlertCooldownMinutes = portableHealthNumber(value.heartRateAlertCooldownMinutes, 1, 1440);
  if (typeof value.sleepStateAlertEnabled === "boolean") policy.sleepStateAlertEnabled = value.sleepStateAlertEnabled;
  if (value.heartRateStaleAfterMinutes != null) policy.heartRateStaleAfterMinutes = portableHealthNumber(value.heartRateStaleAfterMinutes, 1, 1440);
  if (value.sleepStateStaleAfterMinutes != null) policy.sleepStateStaleAfterMinutes = portableHealthNumber(value.sleepStateStaleAfterMinutes, 1, 2880);
  return Object.fromEntries(Object.entries(policy).filter(([, item]) => item !== undefined));
}

function portableHealthSample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metric = stringValue(value.metric || value.type || value.kind).toLowerCase().replace(/[.\s-]+/g, "_");
  if (!portableHealthMetricValues.has(metric)) return null;
  const sample = {
    id: stringValue(value.id || value.sampleId).slice(0, 160),
    metric,
    recordedAt: stringValue(value.recordedAt || value.time || value.timestamp).slice(0, 64),
    startAt: stringValue(value.startAt || value.startTime || value.time || value.timestamp).slice(0, 64),
    endAt: stringValue(value.endAt || value.endTime).slice(0, 64),
    source: stringValue(value.source).slice(0, 64)
  };
  if (metric === "heart_rate") {
    const bpm = portableHealthNumber(value.value ?? value.bpm ?? value.heartRateBpm, 1, 300);
    if (bpm === undefined) return null;
    sample.value = Math.round(bpm);
    sample.unit = "bpm";
  }
  if (metric === "sleep_state" || metric === "sleep_session") {
    const state = stringValue(value.sleepState || value.state).toLowerCase();
    if (["sleeping", "awake", "unknown"].includes(state)) sample.sleepState = state;
  }
  if (metric === "sleep_stage") {
    const stage = stringValue(value.sleepStage || value.stage).toLowerCase();
    sample.sleepStage = ["awake", "light", "deep", "rem", "unknown"].includes(stage) ? stage : "unknown";
  }
  return Object.fromEntries(Object.entries(sample).filter(([, item]) => item !== "" && item !== undefined));
}

function portableHealthPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const samples = (Array.isArray(value.samples) ? value.samples : [])
    .slice(0, 1000)
    .map(portableHealthSample)
    .filter(Boolean);
  if (!samples.length) return undefined;
  const policy = portableHealthPolicy(value.policy);
  return {
    schemaVersion: 1,
    samples,
    ...(policy && Object.keys(policy).length ? { policy } : {})
  };
}

function messageTargetsPortableDevice(message, identity) {
  const envelope = portableEnvelopeForResponse(message);
  if (envelope.targetDeviceIds.length === 0 && envelope.targetDeviceKinds.length === 0) return true;
  return Boolean(
    (identity.deviceId && envelope.targetDeviceIds.includes(identity.deviceId))
    || (identity.deviceKind && envelope.targetDeviceKinds.includes(identity.deviceKind))
  );
}

function extractText(body) {
  if (typeof body === "string") return body.trim();
  if (!body || typeof body !== "object") return "";
  const direct = [
    body.text,
    body.message,
    body.query,
    body.prompt,
    body.input,
    body.question,
    body.content,
    body.data && typeof body.data === "object" ? body.data.text : "",
    body.data && typeof body.data === "object" ? body.data.message : ""
  ].map(stringValue).find(Boolean);
  if (direct) return direct;
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last === "string") return last.trim();
    if (last && typeof last === "object") return stringValue(last.content || last.text || last.message);
  }
  return "";
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function taskForResponse(task) {
  const input = task.raw && typeof task.raw === "object" ? task.raw : {};
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    attempts: task.attempts,
    text: task.text,
    normalizedText: task.normalizedText,
    appId: task.appId || "",
    appName: task.appName || "",
    targetDeviceId: task.targetDeviceId || "",
    source: task.source,
    type: stringValue(input.type || "rabilink"),
    deliveryMode: stringValue(input.deliveryMode),
    reviewRequested: input.reviewRequested === true,
    configurationRequested: input.configurationRequested === true,
    explicitPreference: input.explicitPreference === true,
    preferenceKind: stringValue(input.preferenceKind),
    preferenceValue: stringValue(input.preferenceValue),
    proactivityPreference: stringValue(input.proactivityPreference),
    channelType: stringValue(input.channelType),
    sender: stringValue(input.sender),
    clientMessageId: stringValue(input.clientMessageId || input.segmentId),
    sessionId: stringValue(input.sessionId || input.conversationId),
    routeProfileId: stringValue(input.routeProfileId),
    sequence: Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : 0,
    capturedAt: Number.isFinite(Number(input.capturedAt || input.createdAt)) ? Number(input.capturedAt || input.createdAt) : 0,
    sourceDeviceId: stringValue(input.sourceDeviceId || input.deviceId),
    sourceDeviceName: stringValue(input.sourceDeviceName || input.deviceName),
    sourceDeviceKind: stringValue(input.sourceDeviceKind || input.deviceKind).toLowerCase(),
    transport: stringValue(input.transport || input.sourceTransport).toLowerCase(),
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 8) : [],
    health: portableHealthPayload(input.health),
    messageCount: task.messages.length,
    nextMessageSeq: task.nextMessageSeq,
    replyText: task.replyText || "",
    error: task.error || ""
  };
}

function safeMediaName(value) {
  return path.basename(stringValue(value || "media.bin")).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "media.bin";
}

function mediaPath(appId, mediaId, fileName) {
  return path.join(deviceMediaDir, sanitizeRabiLinkId(appId, "app"), `${sanitizeRabiLinkId(mediaId, "media")}-${safeMediaName(fileName)}`);
}

function cleanupExpiredDeviceMedia() {
  const now = Date.now();
  const cutoff = now - deviceMediaTtlMs;
  let nextExpiry = 0;
  for (const appEntry of fs.readdirSync(deviceMediaDir, { withFileTypes: true })) {
    if (!appEntry.isDirectory()) continue;
    const appDirectory = path.join(deviceMediaDir, appEntry.name);
    for (const mediaEntry of fs.readdirSync(appDirectory, { withFileTypes: true })) {
      if (!mediaEntry.isFile()) continue;
      const target = path.join(appDirectory, mediaEntry.name);
      try {
        const modifiedAt = fs.statSync(target).mtimeMs;
        if (modifiedAt <= cutoff) fs.unlinkSync(target);
        else {
          const expiresAt = modifiedAt + deviceMediaTtlMs;
          if (!nextExpiry || expiresAt < nextExpiry) nextExpiry = expiresAt;
        }
      } catch (error) {
        console.warn(`Unable to expire RabiLink media ${mediaEntry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      if (fs.readdirSync(appDirectory).length === 0) fs.rmdirSync(appDirectory);
    } catch {
      // A concurrent upload may have populated the directory after the empty check.
    }
  }
  return nextExpiry;
}

function scheduleDeviceMediaCleanup(expiresAt = 0) {
  const deadline = Number(expiresAt || 0);
  if (!Number.isFinite(deadline) || deadline <= 0) return;
  if (deviceMediaCleanupTimer && deviceMediaCleanupDeadline <= deadline) return;
  if (deviceMediaCleanupTimer) clearTimeout(deviceMediaCleanupTimer);
  deviceMediaCleanupDeadline = deadline;
  const delayMs = Math.max(1, Math.min(2_147_000_000, deadline - Date.now() + 10));
  deviceMediaCleanupTimer = setTimeout(() => {
    deviceMediaCleanupTimer = null;
    deviceMediaCleanupDeadline = 0;
    scheduleDeviceMediaCleanup(cleanupExpiredDeviceMedia());
  }, delayMs);
  deviceMediaCleanupTimer.unref();
}

async function handleDeviceMediaUpload(req, url, res) {
  const auth = authorizeRabiLinkRequest(req, url, {});
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const contentType = stringValue(req.headers["content-type"] || "application/octet-stream").split(";")[0].toLowerCase();
  // Attachments are ordinary chat files, not only glasses camera media. Keep the
  // MIME value syntactically safe while allowing documents, archives and custom
  // application types; authorization, size, TTL and app isolation remain enforced.
  const allowed = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType);
  if (!allowed) return sendRabiLinkError(res, 415, "Unsupported attachment content type.");
  const raw = await readRawBody(req, { maxBytes: deviceMediaMaxBytes, label: "Mobile attachment" });
  if (!raw.length) return sendRabiLinkError(res, 400, "Media body is empty.");
  const mediaId = `rbm_${randomUUID()}`;
  const fileName = safeMediaName(url.searchParams.get("fileName") || `media-${Date.now()}`);
  const target = mediaPath(auth.app.id, mediaId, fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw);
  scheduleDeviceMediaCleanup(fs.statSync(target).mtimeMs + deviceMediaTtlMs);
  return sendJson(res, 201, {
    code: 0,
    ok: true,
    attachment: {
      id: mediaId,
      fileName,
      contentType,
      size: raw.length,
      kind: contentType.startsWith("image/") ? "image"
        : contentType.startsWith("video/") ? "video"
          : contentType.startsWith("audio/") ? "audio" : "file",
      downloadPath: `/api/rabilink/devices/media/${encodeURIComponent(mediaId)}?fileName=${encodeURIComponent(fileName)}`
    }
  });
}

function handleDeviceMediaDownload(req, url, res) {
  const auth = authorizeRabiLinkRequest(req, url, {});
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/api\/rabilink\/devices\/media\/([^/]+)$/);
  const mediaId = match ? decodeURIComponent(match[1]) : "";
  const fileName = safeMediaName(url.searchParams.get("fileName") || "media.bin");
  const target = mediaPath(auth.app.id, mediaId, fileName);
  if (!fs.existsSync(target)) return sendRabiLinkError(res, 404, "Media attachment was not found.");
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(fs.statSync(target).size),
    "cache-control": "private, no-store"
  });
  fs.createReadStream(target).pipe(res);
}

function createTask(raw, req, auth = { app: null }) {
  loadRelayRuntimeState();
  const text = extractText(raw);
  if (!text) {
    const error = new Error("Missing text/message/query/content in request body.");
    error.statusCode = 400;
    throw error;
  }
  const now = Date.now();
  const task = {
    id: `rabilink-relay-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + taskTtlMs,
    leaseUntil: 0,
    attempts: 0,
    text,
    normalizedText: normalizeText(text),
    appId: auth.app?.id || "",
    appName: auth.app?.name || "",
    targetDeviceId: auth.app?.targetDeviceId || "",
    source: {
      userAgent: String(req.headers["user-agent"] || ""),
      ip: String(req.socket.remoteAddress || ""),
      rokidRequestId: stringValue(raw?.requestId || raw?.id || raw?.messageId),
      sender: stringValue(raw?.sender || raw?.user || raw?.deviceId),
      appId: auth.app?.id || "",
      appName: auth.app?.name || "",
      targetDeviceId: auth.app?.targetDeviceId || ""
    },
    raw,
    messages: [],
    nextMessageSeq: 1
  };
  tasks.set(task.id, task);
  saveRelayRuntimeState();
  writeEvent("task_created", taskForResponse(task));
  writeAccountLogForApp(auth.app, "task_created", {
    title: "收到 RabiLink 消息",
    detail: `${task.source.sender || "外部入口"} 提交了一条消息，等待 ${task.targetDeviceId || "Rabi PC"} 领取。`,
    taskId: task.id,
    workerId: task.targetDeviceId || "",
    status: task.status,
    text: task.text
  });
  relayEventHub.publish("task_available", {
    appId: task.appId,
    targetDeviceId: task.targetDeviceId,
    data: { taskId: task.id }
  });
  return task;
}

function webguiRequestForResponse(request) {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
    attempts: request.attempts,
    appId: request.appId || "",
    appName: request.appName || "",
    targetDeviceId: request.targetDeviceId || "",
    method: request.method,
    path: request.path,
    headers: request.headers,
    bodyBase64: request.bodyBase64 || "",
    error: request.error || ""
  };
}

function cleanupWebguiRequests(now = Date.now()) {
  for (const [id, request] of webguiRequests.entries()) {
    if (request.status !== "done" && request.status !== "failed" && request.expiresAt <= now) {
      request.status = "failed";
      request.updatedAt = now;
      request.error = "WebGUI request timed out before the Rabi PC returned a response.";
      finishWebguiWaiters(request);
      writeEvent("webgui_request_expired", webguiRequestForResponse(request));
      const app = readAppStore().apps.find((item) => item.id === request.appId);
      writeAccountLogForApp(app, "webgui_request_expired", {
        title: "PC WebGUI 请求超时",
        detail: `${request.method} ${request.path}`,
        workerId: request.targetDeviceId,
        taskId: request.id,
        status: request.status,
        method: request.method,
        path: request.path,
        error: request.error
      });
    }
    if ((request.status === "done" || request.status === "failed") && request.updatedAt + taskTtlMs <= now) {
      webguiRequests.delete(id);
    }
  }
}

function canWorkerClaimWebguiRequest(request, appId = "", deviceId = "", deviceGuid = "") {
  if (appId && request.appId !== appId) return false;
  if (!workerIdentityMatchesTarget(request.targetDeviceId, { deviceId, deviceGuid }, request.appId)) return false;
  return true;
}

function hasClaimableWebguiRequests(appId = "", deviceId = "", deviceGuid = "") {
  cleanupWebguiRequests();
  const now = Date.now();
  for (const request of webguiRequests.values()) {
    if (!canWorkerClaimWebguiRequest(request, appId, deviceId, deviceGuid)) continue;
    if (request.status === "queued") return true;
    if (request.status === "leased" && request.leaseUntil <= now) return true;
  }
  return false;
}

function claimWebguiRequests(limit, deviceId, appId = "", deviceGuid = "") {
  cleanupWebguiRequests();
  const now = Date.now();
  const result = [];
  for (const request of webguiRequests.values()) {
    if (result.length >= limit) break;
    if (!canWorkerClaimWebguiRequest(request, appId, deviceId, deviceGuid)) continue;
    if (request.status === "leased" && request.leaseUntil <= now) {
      request.status = "queued";
      request.leaseUntil = 0;
    }
    if (request.status !== "queued") continue;
    request.status = "leased";
    request.updatedAt = now;
    request.leaseUntil = now + leaseMs;
    request.attempts += 1;
    result.push(webguiRequestForResponse(request));
    scheduleLeaseAvailability("webgui_available", request.appId, request.targetDeviceId, request.leaseUntil, { requestId: request.id });
    writeEvent("webgui_request_leased", webguiRequestForResponse(request));
    const app = readAppStore().apps.find((item) => item.id === request.appId);
    writeAccountLogForApp(app, "webgui_request_leased", {
      title: "PC Rabi 已领取 WebGUI 请求",
      detail: `${request.method} ${request.path}`,
      workerId: deviceId || request.targetDeviceId,
      taskId: request.id,
      status: request.status,
      method: request.method,
      path: request.path
    });
  }
  return result;
}

function finishWebguiWaiters(request) {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (waiter.taskId !== request.id) continue;
    clearTimeout(waiter.timer);
    waiters.splice(index, 1);
    waiter.resolve(request);
  }
}

function waitForWebguiRequest(request, timeoutMs) {
  if (request.status === "done" || request.status === "failed") return Promise.resolve(request);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((item) => item.taskId === request.id && item.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      resolve(request);
    }, timeoutMs);
    waiters.push({ taskId: request.id, resolve, timer });
  });
}

function finishWebguiRequest(requestId, body) {
  const request = webguiRequests.get(requestId);
  if (!request) {
    const error = new Error(`WebGUI request not found: ${requestId}`);
    error.statusCode = 404;
    throw error;
  }
  const ok = body?.ok !== false && Number(body?.statusCode || 0) >= 100;
  request.status = ok ? "done" : "failed";
  request.updatedAt = Date.now();
  request.leaseUntil = 0;
  request.response = ok
    ? {
      statusCode: clamp(Number(body.statusCode || 200), 100, 599),
      headers: normalizeProxyResponseHeaders(body.headers),
      bodyBase64: stringValue(body.bodyBase64)
    }
    : null;
  request.error = ok ? "" : stringValue(body?.error || "Rabi PC failed to proxy WebGUI request.");
  finishWebguiWaiters(request);
  writeEvent(ok ? "webgui_request_done" : "webgui_request_failed", webguiRequestForResponse(request));
  const app = readAppStore().apps.find((item) => item.id === request.appId);
  writeAccountLogForApp(app, ok ? "webgui_request_done" : "webgui_request_failed", {
    title: ok ? "PC WebGUI 请求已返回" : "PC WebGUI 请求失败",
    detail: `${request.method} ${request.path}`,
    workerId: request.targetDeviceId,
    taskId: request.id,
    status: request.status,
    method: request.method,
    path: request.path,
    error: request.error || ""
  });
  return request;
}

function normalizeProxyRequestHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (!["accept", "content-type", "user-agent", "range", "if-range", "idempotency-key", "if-match"].includes(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return result;
}

function normalizeRouteMutationHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (!["idempotency-key", "if-match"].includes(lower)) continue;
    result[lower] = Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
  }
  return result;
}

function mobileRouteMutationHeaders(req, envelopeHeaders = {}) {
  const outer = normalizeRouteMutationHeaders(req?.headers);
  const envelope = normalizeRouteMutationHeaders(envelopeHeaders);
  for (const name of ["idempotency-key", "if-match"]) {
    if (outer[name] && envelope[name] && outer[name] !== envelope[name]) {
      const error = new Error(`Conflicting ${name} Route mutation headers.`);
      error.statusCode = 400;
      throw error;
    }
  }
  return {
    ...(outer["idempotency-key"] || envelope["idempotency-key"]
      ? { "idempotency-key": outer["idempotency-key"] || envelope["idempotency-key"] }
      : {}),
    ...(outer["if-match"] || envelope["if-match"]
      ? { "if-match": outer["if-match"] || envelope["if-match"] }
      : {})
  };
}

function mobileMutationResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (!["idempotency-key", "if-match", "etag", "x-rabiroute-operation-id", "x-rabiroute-content-hash"].includes(lower)) continue;
    result[lower] = String(value || "").trim();
  }
  return result;
}

function normalizeProxyResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive", "set-cookie"].includes(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return result;
}

function createWebguiRequest(req, target, localPath, rawBody) {
  const now = Date.now();
  const request = {
    id: `rabilink-webgui-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + webguiRequestWaitMs,
    leaseUntil: 0,
    attempts: 0,
    appId: target.app.id,
    appName: target.app.name || "",
    targetDeviceId: target.worker.id,
    method: String(req.method || "GET").toUpperCase(),
    path: localPath,
    headers: normalizeProxyRequestHeaders(req.headers),
    bodyBase64: Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody.toString("base64") : "",
    response: null
  };
  webguiRequests.set(request.id, request);
  writeEvent("webgui_request_created", webguiRequestForResponse(request));
  writeAccountLogForApp(target.app, "webgui_request_created", {
    title: "创建 PC WebGUI 请求",
    detail: `${request.method} ${localPath}`,
    workerId: target.worker.id,
    workerName: target.worker.name || target.worker.id,
    taskId: request.id,
    status: request.status,
    method: request.method,
    path: localPath
  });
  relayEventHub.publish("webgui_available", {
    appId: request.appId,
    targetDeviceId: request.targetDeviceId,
    data: { requestId: request.id }
  });
  return request;
}

function createMobileWebguiRequest(app, worker, method, localPath, body = null, mutationHeaders = {}) {
  const now = Date.now();
  const bodyBuffer = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const request = {
    id: `rabilink-webgui-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + webguiRequestWaitMs,
    leaseUntil: 0,
    attempts: 0,
    appId: app.id,
    appName: app.name || "",
    targetDeviceId: worker.id,
    method: String(method || "GET").toUpperCase(),
    path: localPath,
    headers: {
      accept: "application/json",
      ...(body == null ? {} : { "content-type": "application/json; charset=utf-8" }),
      ...normalizeRouteMutationHeaders(mutationHeaders)
    },
    bodyBase64: bodyBuffer.length > 0 ? bodyBuffer.toString("base64") : "",
    response: null
  };
  webguiRequests.set(request.id, request);
  writeEvent("webgui_request_created", webguiRequestForResponse(request));
  writeAccountLogForApp(app, "webgui_request_created", {
    title: "创建手机端 PC WebGUI 请求",
    detail: `${request.method} ${localPath}`,
    workerId: worker.id,
    workerName: worker.name || worker.id,
    taskId: request.id,
    status: request.status,
    method: request.method,
    path: localPath
  });
  relayEventHub.publish("webgui_available", {
    appId: request.appId,
    targetDeviceId: request.targetDeviceId,
    data: { requestId: request.id }
  });
  return request;
}

function speechRequestForLog(request) {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
    attempts: request.attempts,
    appId: request.appId,
    appName: request.appName,
    targetDeviceId: request.targetDeviceId,
    method: request.method,
    path: request.path,
    requestBytes: request.bodyBase64 ? Buffer.byteLength(request.bodyBase64, "base64") : 0,
    responseBytes: request.response?.bodyBase64 ? Buffer.byteLength(request.response.bodyBase64, "base64") : 0,
    error: request.error || ""
  };
}

function canWorkerClaimSpeechRequest(request, appId = "", deviceId = "", deviceGuid = "") {
  if (appId && request.appId !== appId) return false;
  return workerIdentityMatchesTarget(request.targetDeviceId, { deviceId, deviceGuid }, request.appId);
}

function createSpeechRequest(req, auth, worker, localPath, rawBody) {
  const request = speechRequests.create({
    appId: auth.app.id,
    appName: auth.app.name || "",
    targetDeviceId: worker.id,
    method: req.method,
    path: localPath,
    headers: normalizeProxyRequestHeaders(req.headers),
    bodyBase64: Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody.toString("base64") : ""
  });
  writeEvent("speech_request_created", speechRequestForLog(request));
  writeAccountLogForApp(auth.app, "speech_request_created", {
    title: "创建本机语音请求",
    detail: `${request.method} ${request.path}`,
    workerId: worker.id,
    workerName: worker.name || worker.id,
    taskId: request.id,
    status: request.status,
    method: request.method,
    path: request.path
  });
  relayEventHub.publish("speech_available", {
    appId: request.appId,
    targetDeviceId: request.targetDeviceId,
    data: { requestId: request.id }
  });
  return request;
}

function sendSpeechProxyResponse(res, request) {
  if (request.status !== "done" || !request.response) {
    const timedOut = String(request.error || "").toLowerCase().includes("timed out");
    return sendJson(res, timedOut ? 504 : 502, {
      code: -1,
      ok: false,
      request_id: request.id,
      message: request.error || "Rabi PC speech service failed to return a response."
    });
  }
  const body = request.response.bodyBase64
    ? Buffer.from(request.response.bodyBase64, "base64")
    : Buffer.alloc(0);
  res.writeHead(request.response.statusCode, {
    ...normalizeProxyResponseHeaders(request.response.headers),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-rabilink-token",
    "cache-control": "no-store",
    "x-rabilink-speech-request-id": request.id
  });
  res.end(body);
}

async function handleSpeechProxy(req, url, res) {
  const auth = authorizeRabiLinkRequest(req, url, {});
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  if (auth.deviceBinding) {
    return sendJson(res, 403, { code: -1, ok: false, message: "Speech API requires the RabiLink application token." });
  }
  const worker = requireRokidAppTarget(auth, "speech");
  const suffix = url.pathname.slice(speechProxyPrefix.length) || "/";
  const localPathname = speechProxyPaths.get(`${String(req.method || "GET").toUpperCase()} ${suffix}`);
  if (!localPathname) {
    return sendJson(res, 404, { code: -1, ok: false, message: "RabiSpeech proxy path is not enabled." });
  }
  const search = new URLSearchParams(url.searchParams);
  search.delete("token");
  const localPath = `${localPathname}${search.toString() ? `?${search}` : ""}`;
  const rawBody = ["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase())
    ? Buffer.alloc(0)
    : await readRawBody(req, { maxBytes: speechBodyMaxBytes, label: "Speech" });
  const request = createSpeechRequest(req, auth, worker, localPath, rawBody);
  const finalRequest = await speechRequests.waitForCompletion(request, speechRequestWaitMs);
  speechRequests.cleanup();
  writeEvent(finalRequest.status === "done" ? "speech_request_done" : "speech_request_failed", speechRequestForLog(finalRequest));
  writeAccountLogForApp(auth.app, finalRequest.status === "done" ? "speech_request_done" : "speech_request_failed", {
    title: finalRequest.status === "done" ? "本机语音请求已返回" : "本机语音请求失败",
    detail: `${finalRequest.method} ${finalRequest.path}`,
    workerId: finalRequest.targetDeviceId,
    taskId: finalRequest.id,
    status: finalRequest.status,
    method: finalRequest.method,
    path: finalRequest.path,
    error: finalRequest.error || ""
  });
  return sendSpeechProxyResponse(res, finalRequest);
}

// Reuse the bounded request/response queue for signalling, never for camera data.
async function handleDirectVideoOffer(req, url, res) {
  const auth = authorizeRabiLinkRequest(req, url, {});
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  if (auth.deviceBinding) return sendJson(res, 403, { error: "Application token required." });
  const worker = requireRokidAppTarget(auth, "video-direct");
  const rawBody = await readRawBody(req, { maxBytes: 64 * 1024, label: "Video signalling" });
  let offer;
  try { offer = JSON.parse(rawBody.toString("utf8")); } catch { return sendJson(res, 400, { error: "Invalid SDP offer." }); }
  if (!offer || typeof offer !== "object" || Object.keys(offer).some(key => !["sdp", "deviceId"].includes(key))
      || typeof offer.sdp !== "string" || !offer.sdp.startsWith("v=0") || offer.sdp.length > 60 * 1024
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(offer.deviceId || "") || / typ relay(?: |\r|\n|$)/.test(offer.sdp)) {
    return sendJson(res, 400, { error: "Only direct video SDP signalling is accepted." });
  }
  const request = createSpeechRequest(req, auth, worker, "/api/rabilink/video/offer", rawBody);
  const completed = await speechRequests.waitForCompletion(request, speechRequestWaitMs);
  speechRequests.cleanup();
  return sendSpeechProxyResponse(res, completed);
}

function cleanupTasks() {
  loadRelayRuntimeState();
  const now = Date.now();
  let changed = false;
  for (const [id, task] of tasks.entries()) {
    if (task.status !== "done" && task.status !== "failed" && task.expiresAt <= now) {
      task.status = "expired";
      task.updatedAt = now;
      task.error = "Task expired before RabiLink worker returned a result.";
      changed = true;
      finishWaiters(task);
      writeEvent("task_expired", taskForResponse(task));
      const app = readAppStore().apps.find((item) => item.id === task.appId);
      writeAccountLogForApp(app, "task_expired", {
        title: "RabiLink 任务已超时",
        detail: "PC Rabi 没有在有效期内完成这条消息。",
        workerId: task.targetDeviceId || "",
        taskId: task.id,
        status: task.status,
        text: task.text,
        error: task.error
      });
    }
    if ((task.status === "done" || task.status === "failed" || task.status === "expired") && task.updatedAt + taskTtlMs <= now) {
      tasks.delete(id);
      changed = true;
    }
  }
  changed = cleanupOutboxMessages(now) || changed;
  cleanupWebguiRequests(now);
  if (changed) saveRelayRuntimeState();
}

function cleanupOutboxMessages(now = Date.now()) {
  const retained = outboxMessages.filter((message) => {
    if (Number(message?.createdAt || 0) + outboxTtlMs > now) return true;
    const explicitTargets = persistedPortableStringList(message?.targetDeviceIds);
    if (explicitTargets.length === 0) return false;
    const receipts = Array.isArray(message?.receipts) ? message.receipts : [];
    return explicitTargets.some((deviceId) => !receipts.some((receipt) =>
      stringValue(receipt?.deviceId) === deviceId && Number(receipt?.deliveredAt) > 0));
  });
  if (retained.length === outboxMessages.length) return false;
  outboxMessages.splice(0, outboxMessages.length, ...retained);
  return true;
}

function canWorkerClaimTask(task, appId = "", deviceId = "", deviceGuid = "") {
  if (appId && task.appId !== appId) return false;
  if (!workerIdentityMatchesTarget(task.targetDeviceId, { deviceId, deviceGuid }, task.appId)) return false;
  return true;
}

function claimTasks(limit, deviceId, appId = "", deviceGuid = "") {
  cleanupTasks();
  const now = Date.now();
  const result = [];
  let changed = false;
  for (const task of tasks.values()) {
    if (result.length >= limit) break;
    if (!canWorkerClaimTask(task, appId, deviceId, deviceGuid)) continue;
    if (task.status === "leased" && task.leaseUntil <= now) {
      task.status = "queued";
      task.leaseUntil = 0;
      changed = true;
    }
    if (task.status !== "queued") continue;
    task.status = "leased";
    task.updatedAt = now;
    task.leaseUntil = now + leaseMs;
    task.attempts += 1;
    task.source = { ...task.source, leasedBy: deviceId || "" };
    result.push(taskForResponse(task));
    scheduleLeaseAvailability("task_available", task.appId, task.targetDeviceId, task.leaseUntil, { taskId: task.id });
    changed = true;
    writeEvent("task_leased", taskForResponse(task));
    const app = readAppStore().apps.find((item) => item.id === task.appId);
    writeAccountLogForApp(app, "task_leased", {
      title: "PC Rabi 已领取消息",
      detail: `${deviceId || "Rabi PC"} 已领取任务。`,
      workerId: deviceId || "",
      taskId: task.id,
      status: task.status,
      text: task.text
    });
  }
  if (changed) saveRelayRuntimeState();
  return result;
}

function hasClaimableTasks(appId = "", deviceId = "", deviceGuid = "") {
  cleanupTasks();
  const now = Date.now();
  for (const task of tasks.values()) {
    if (!canWorkerClaimTask(task, appId, deviceId, deviceGuid)) continue;
    if (task.status === "queued") return true;
    if (task.status === "leased" && task.leaseUntil <= now) return true;
  }
  return false;
}

function findTaskOrThrow(taskId) {
  loadRelayRuntimeState();
  const task = tasks.get(taskId);
  if (!task) {
    const error = new Error(`Task not found: ${taskId}`);
    error.statusCode = 404;
    throw error;
  }
  return task;
}

function appendTaskMessages(taskId, body, options = {}) {
  const task = findTaskOrThrow(taskId);
  const inputMessages = Array.isArray(body?.messages) ? body.messages : [body];
  const created = [];
  for (const item of inputMessages) {
    const text = extractText(item);
    if (!text) continue;
    const seq = task.nextMessageSeq;
    task.nextMessageSeq += 1;
    const message = {
      id: `msg-${String(seq).padStart(6, "0")}`,
      seq,
      createdAt: Date.now(),
      text,
      final: Boolean(item?.final || options.final),
      raw: item
    };
    task.messages.push(message);
    created.push(message);
  }
  if (created.length === 0) {
    const error = new Error("Missing text/message/query/content in message body.");
    error.statusCode = 400;
    throw error;
  }
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.replyText = created.map((message) => message.text).join("\n");
  if (task.status !== "done" && task.status !== "failed") {
    task.status = options.finish ? "done" : "streaming";
  }
  if (options.finish) {
    task.status = "done";
  }
  appendOutboxMessages(task, created);
  saveRelayRuntimeState();
  finishWaiters(task);
  writeEvent(options.finish ? "task_messages_finished" : "task_messages_appended", {
    task: taskForResponse(task),
    messages: created.map(messageForResponse)
  });
  const app = readAppStore().apps.find((item) => item.id === task.appId);
  writeAccountLogForApp(app, options.finish ? "task_messages_finished" : "task_messages_appended", {
    title: options.finish ? "PC Rabi 返回最终回复" : "PC Rabi 返回增量回复",
    detail: `新增 ${created.length} 条下行消息。`,
    workerId: task.source?.leasedBy || task.targetDeviceId || "",
    taskId: task.id,
    status: task.status,
    messageCount: created.length,
    text: created.map((message) => message.text).join("\n")
  });
  return { task, messages: created };
}

function appendOutboxMessages(task, messages) {
  for (const message of messages) {
    const seq = nextOutboxMessageSeq;
    nextOutboxMessageSeq += 1;
    outboxMessages.push({
      id: `out-${String(seq).padStart(9, "0")}`,
      seq,
      appId: task.appId || "",
      taskId: task.id,
      taskMessageId: message.id,
      createdAt: message.createdAt,
      text: message.text,
      final: message.final,
      status: task.status
    });
  }
  saveRelayRuntimeState();
  relayEventHub.publish("outbox_available", {
    appId: task.appId || "",
    data: { cursor: currentOutboxCursor() }
  });
}

function outboxCursorToken(sequence = nextOutboxMessageSeq - 1) {
  ensureOutboxCursorState();
  const safeSequence = Math.max(0, Number.isFinite(Number(sequence)) ? Math.floor(Number(sequence)) : 0);
  return `oc1.${outboxCursorGeneration}.${safeSequence}`;
}

function decodeOutboxCursor(after) {
  loadRelayRuntimeState();
  ensureOutboxCursorState();
  const requested = stringValue(after);
  if (!requested) return { sequence: 0, reset: false, reason: "" };

  const opaque = requested.match(/^oc1\.([0-9a-f-]{36})\.(\d+)$/i);
  if (opaque) {
    if (opaque[1] !== outboxCursorGeneration) {
      return { sequence: 0, reset: true, reason: "relay_generation_changed" };
    }
    const sequence = Number(opaque[2]);
    return Number.isSafeInteger(sequence)
      ? { sequence, reset: false, reason: "" }
      : { sequence: 0, reset: true, reason: "invalid_cursor" };
  }

  const legacy = requested.match(/^out-(\d+)$/);
  if (legacy) {
    const sequence = Number(legacy[1]);
    const maximumIssued = Math.max(outboxCursorHighWater, nextOutboxMessageSeq - 1);
    if (!Number.isSafeInteger(sequence)) return { sequence: 0, reset: true, reason: "invalid_cursor" };
    if (sequence > maximumIssued) return { sequence: 0, reset: true, reason: "cursor_ahead_of_relay_state" };
    return { sequence, reset: false, reason: "" };
  }

  return { sequence: 0, reset: true, reason: "invalid_cursor" };
}

function currentOutboxCursor() {
  loadRelayRuntimeState();
  return outboxCursorToken(nextOutboxMessageSeq - 1);
}

function messageForResponse(message) {
  return {
    id: message.id,
    seq: message.seq,
    createdAt: message.createdAt,
    text: message.text,
    final: message.final
  };
}

function outboxMessageForResponse(message) {
  return {
    id: message.id,
    seq: message.seq,
    appId: message.appId || "",
    taskId: message.taskId,
    taskMessageId: message.taskMessageId,
    deliveryId: stringValue(message.deliveryId),
    createdAt: message.createdAt,
    text: message.text,
    final: message.final,
    status: message.status,
    proactive: message.proactive === true,
    source: stringValue(message.source),
    receipts: Array.isArray(message.receipts)
      ? message.receipts.map((receipt) => ({
          deviceId: stringValue(receipt?.deviceId),
          deviceKind: stringValue(receipt?.deviceKind),
          ...(Number(receipt?.deliveredAt) > 0 ? { deliveredAt: Number(receipt.deliveredAt) } : {}),
          ...(Number(receipt?.playedAt) > 0 ? { playedAt: Number(receipt.playedAt) } : {}),
          ...(Number(receipt?.playbackFailedAt) > 0 ? { playbackFailedAt: Number(receipt.playbackFailedAt) } : {}),
          ...(stringValue(receipt?.playbackFailure) ? { playbackFailure: stringValue(receipt.playbackFailure).slice(0, 240) } : {})
        }))
      : [],
    ...portableEnvelopeForResponse(message)
  };
}

function hasOpenTasks(appId = "") {
  cleanupTasks();
  for (const task of tasks.values()) {
    if (appId && task.appId !== appId) continue;
    if (!isTerminalTask(task)) return true;
  }
  return false;
}

function outboxMessagesAfter(after, appId = "", identity = { deviceId: "", deviceKind: "" }) {
  const cursor = decodeOutboxCursor(after);
  return outboxMessages.filter((message) => {
    if (appId && message.appId !== appId) return false;
    return Number(message.seq) > cursor.sequence && messageTargetsPortableDevice(message, identity);
  });
}

function scannedOutboxMessagesAfter(sequence, appId = "") {
  return outboxMessages.filter((message) => {
    if (appId && message.appId !== appId) return false;
    return Number(message.seq) > sequence;
  });
}

function outboxMessagesResponse(after, appId = "", continuous = false, identity = { deviceId: "", deviceKind: "" }) {
  cleanupTasks();
  const cursorState = decodeOutboxCursor(after);
  const scannedMessages = scannedOutboxMessagesAfter(cursorState.sequence, appId);
  const messages = scannedMessages.filter((message) => messageTargetsPortableDevice(message, identity));
  const last = scannedMessages[scannedMessages.length - 1];
  const nextSequence = last ? Number(last.seq) : cursorState.sequence;
  const nextCursor = outboxCursorToken(nextSequence);
  const openTasks = hasOpenTasks(appId);
  const text = messages.map((message) => message.text).join("\n");
  const shouldContinue = continuous || openTasks;
  return {
    code: 0,
    ok: true,
    status: messages.length > 0 ? "messages" : shouldContinue ? "idle" : "done",
    done: !shouldContinue,
    shouldContinue,
    cursor: nextCursor,
    nextCursor,
    cursorReset: cursorState.reset,
    cursorResetReason: cursorState.reason,
    messages: messages.map(outboxMessageForResponse),
    text,
    answer: text,
    reply: text,
    content: text,
    error: ""
  };
}

function markOutboxTimeout(response, waitMs, continuous = false) {
  if (response.messages.length > 0 || !response.shouldContinue || waitMs <= 0 || continuous) {
    return response;
  }
  const text = `RabiLink 下行消息等待超时：${waitMs}ms 内没有收到电脑端 Rabi/Codex 回复。`;
  return {
    ...response,
    code: -1,
    ok: false,
    status: "timeout",
    done: true,
    shouldContinue: false,
    text,
    answer: text,
    reply: text,
    content: text,
    error: text
  };
}

async function waitForOutboxResponse(req, after, timeoutMs, appId, continuous, identity) {
  let cursor = stringValue(after);
  let response = outboxMessagesResponse(cursor, appId, continuous, identity);
  if (response.messages.length > 0 || !response.shouldContinue || timeoutMs <= 0) return response;

  const deadline = Date.now() + timeoutMs;
  let closed = false;
  let currentWaiter = null;
  const close = () => {
    closed = true;
    currentWaiter?.cancel();
  };
  req.once("close", close);
  req.once("aborted", close);
  try {
    while (!closed && response.messages.length === 0 && response.shouldContinue) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs <= 0) break;
      currentWaiter = relayEventHub.waitFor("outbox_available", { appId }, remainingMs);

      // Register first, then read again so an append between the initial read and
      // event subscription cannot be stranded until the request deadline.
      const recovery = outboxMessagesResponse(cursor, appId, continuous, identity);
      if (recovery.messages.length > 0
        || !recovery.shouldContinue
        || stringValue(recovery.nextCursor) !== cursor) {
        currentWaiter.cancel();
        currentWaiter = null;
        response = recovery;
      } else {
        await currentWaiter.promise;
        currentWaiter = null;
        response = outboxMessagesResponse(cursor, appId, continuous, identity);
      }
      cursor = stringValue(response.nextCursor || cursor);
    }
  } finally {
    currentWaiter?.cancel();
    req.off("close", close);
    req.off("aborted", close);
  }
  return markOutboxTimeout(response, timeoutMs, continuous);
}

async function claimAfterRelayEvent(req, eventType, identity, timeoutMs, claim) {
  let claimed = claim();
  if (claimed.length > 0 || timeoutMs <= 0) return claimed;

  const deadline = Date.now() + timeoutMs;
  let closed = false;
  let currentWaiter = null;
  const close = () => {
    closed = true;
    currentWaiter?.cancel();
  };
  req.once("close", close);
  req.once("aborted", close);
  try {
    while (!closed && claimed.length === 0) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs <= 0) break;
      currentWaiter = relayEventHub.waitFor(eventType, identity, remainingMs);

      // Subscribe before the recovery claim so a request published between the
      // first empty claim and waiter registration cannot be lost.
      claimed = claim();
      if (claimed.length > 0) {
        currentWaiter.cancel();
        currentWaiter = null;
        break;
      }
      await currentWaiter.promise;
      currentWaiter = null;
      claimed = claim();
    }
  } finally {
    currentWaiter?.cancel();
    req.off("close", close);
    req.off("aborted", close);
  }
  return claimed;
}

function taskMessagesResponse(task, after) {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^msg-/, ""));
  const messages = task.messages.filter((message) => {
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
  const last = messages[messages.length - 1] || task.messages[task.messages.length - 1];
  const done = task.status === "done" || task.status === "failed" || task.status === "expired";
  const shouldContinue = !done;
  return {
    code: task.status === "failed" ? -1 : 0,
    ok: task.status !== "failed" && task.status !== "expired",
    status: task.status === "done" ? "done" : task.status === "failed" || task.status === "expired" ? "failed" : "streaming",
    taskId: task.id,
    done,
    shouldContinue,
    cursor: last?.id || afterText || "",
    nextCursor: last?.id || afterText || "",
    messages: messages.map(messageForResponse),
    text: messages.map((message) => message.text).join("\n"),
    answer: messages.map((message) => message.text).join("\n"),
    reply: messages.map((message) => message.text).join("\n"),
    content: messages.map((message) => message.text).join("\n"),
    error: task.error || ""
  };
}

function isTerminalTask(task) {
  return task.status === "done" || task.status === "failed" || task.status === "expired";
}

function finishTask(taskId, body) {
  const task = findTaskOrThrow(taskId);
  const ok = body?.ok !== false && body?.status !== "failed";
  const replyText = stringValue(body?.replyText || body?.text || body?.answer || body?.content || body?.message);
  if (ok && replyText) {
    appendTaskMessages(taskId, { text: replyText, final: true, raw: body }, { finish: true, final: true });
  }
  task.status = ok ? "done" : "failed";
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.replyText = replyText;
  task.replyRaw = body;
  task.error = ok ? "" : stringValue(body?.error || body?.reason || "RabiLink worker reported failure.");
  saveRelayRuntimeState();
  finishWaiters(task);
  writeEvent(ok ? "task_done" : "task_failed", taskForResponse(task));
  const app = readAppStore().apps.find((item) => item.id === task.appId);
  writeAccountLogForApp(app, ok ? "task_done" : "task_failed", {
    title: ok ? "RabiLink 任务已完成" : "RabiLink 任务失败",
    detail: ok ? "PC Rabi 已提交最终状态。" : task.error,
    workerId: task.source?.leasedBy || task.targetDeviceId || "",
    taskId: task.id,
    status: task.status,
    text: replyText,
    error: task.error || ""
  });
  return task;
}

function finishWaiters(task) {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (waiter.taskId !== task.id) continue;
    clearTimeout(waiter.timer);
    waiters.splice(index, 1);
    waiter.resolve(task);
  }
}

function waitForTask(task, timeoutMs) {
  if (task.status === "done" || task.status === "failed") return Promise.resolve(task);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((item) => item.taskId === task.id && item.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      loadRelayRuntimeState();
      resolve(tasks.get(task.id) || task);
    }, timeoutMs);
    waiters.push({ taskId: task.id, resolve, timer });
  });
}

function rokidResponse(task) {
  if (task.status === "done") {
    const text = task.replyText || "已转交 Codex 处理。";
    return {
      code: 0,
      ok: true,
      status: "done",
      taskId: task.id,
      text,
      answer: text,
      reply: text,
      content: text
    };
  }
  if (task.status === "failed") {
    const text = task.error || "RabiLink 转发失败。";
    return {
      code: -1,
      ok: false,
      status: "failed",
      taskId: task.id,
      text,
      answer: text,
      reply: text,
      content: text
    };
  }
  const text = "已收到，正在转交电脑端 RabiLink 和 Codex 处理。";
  return {
    code: 0,
    ok: true,
    status: "pending",
    taskId: task.id,
    text,
    answer: text,
    reply: text,
    content: text
  };
}

async function handleRokid(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
  const task = createTask(body, req, auth);
  const wait = url.searchParams.get("wait");
  const shouldWait = wait == null || wait === "1" || wait.toLowerCase() === "true";
  const timeout = clamp(Number(url.searchParams.get("timeoutMs") || replyTimeoutMs), 1000, 120000);
  const finalTask = shouldWait ? await waitForTask(task, timeout) : task;
  sendJson(res, 200, rokidResponse(finalTask));
}

function handleRokidCreateTask(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
  const outboxCursor = currentOutboxCursor();
  const task = createTask(body, req, auth);
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: "pending",
    taskId: task.id,
    cursor: outboxCursor,
    nextCursor: outboxCursor,
    text: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    answer: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    reply: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    content: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。"
  });
}

function handleRokidTaskRead(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/rokid\/rabilink\/tasks\/([^/]+)$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  loadRelayRuntimeState();
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, {
    code: -1,
    ok: false,
    status: "failed",
    taskId,
    text: "没有找到这条 RabiLink 任务，可能已经过期。",
    answer: "没有找到这条 RabiLink 任务，可能已经过期。",
    reply: "没有找到这条 RabiLink 任务，可能已经过期。",
    content: "没有找到这条 RabiLink 任务，可能已经过期。"
  });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  cleanupTasks();
  const response = rokidResponse(task);
  writeAccountLogForApp(auth.app, "task_status_read", {
    title: "插件查询任务状态",
    detail: `状态：${response.status}`,
    taskId: task.id,
    status: response.status
  });
  sendJson(res, 200, response);
}

async function handleRokidTaskMessages(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/rokid\/rabilink\/tasks\/([^/]+)\/messages$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  loadRelayRuntimeState();
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, {
    code: -1,
    ok: false,
    status: "failed",
    taskId,
    done: true,
    shouldContinue: false,
    messages: [],
    text: "没有找到这条 RabiLink 任务，可能已经过期。",
    answer: "没有找到这条 RabiLink 任务，可能已经过期。",
    reply: "没有找到这条 RabiLink 任务，可能已经过期。",
    content: "没有找到这条 RabiLink 任务，可能已经过期。"
  });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  cleanupTasks();
  const after = url.searchParams.get("after") || url.searchParams.get("cursor") || "";
  const response = taskMessagesResponse(task, after);
  writeAccountLogForApp(auth.app, "task_messages_read", {
    title: response.messages.length > 0 ? "插件读取到任务回复" : "插件读取任务状态",
    detail: response.messages.length > 0 ? `读取到 ${response.messages.length} 条任务回复。` : `暂无新任务回复，状态：${response.status}。`,
    taskId: task.id,
    status: response.status,
    messageCount: response.messages.length,
    text: response.text || ""
  });
  sendJson(res, 200, response);
}

async function handleRokidOutboxMessages(req, url, res, body, options = {}) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  cleanupTasks();
  const appId = auth.app?.id || "";
  const identity = portableDeviceIdentity(url, stringValue(options.defaultDeviceKind));
  if (options.requireDeviceIdentity && !identity.deviceId && !identity.deviceKind) {
    throw portableRequestError("Portable message polling requires deviceId or deviceKind.");
  }
  const continuous = ["1", "true", "yes"].includes(String(url.searchParams.get("stream") || "").toLowerCase());
  const tailOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("tail") || "").toLowerCase());
  const hasCursor = url.searchParams.has("after") || url.searchParams.has("cursor");
  const after = tailOnly
    ? currentOutboxCursor()
    : hasCursor
    ? url.searchParams.get("after") || url.searchParams.get("cursor") || ""
    : currentOutboxCursor();
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || outboxWaitMs), 0, 60000);
  const response = await waitForOutboxResponse(req, after, waitMs, appId, continuous, identity);
  if (res.writableEnded || res.destroyed) return;
  writeAccountLogForApp(auth.app, "outbox_messages_read", {
    title: response.messages.length > 0 ? "设备读取到下行消息" : "设备读取下行快照",
    detail: response.messages.length > 0 ? `读取到 ${response.messages.length} 条下行消息。` : `暂无新下行消息，状态：${response.status}。`,
    status: response.status,
    messageCount: response.messages.length,
    deviceId: identity.deviceId,
    deviceKind: identity.deviceKind,
    text: response.text || ""
  });
  sendJson(res, 200, response);
}

function handlePortableMessageReceipt(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const appId = auth.app?.id || "";
  const deviceId = stringValue(body?.deviceId).slice(0, 160);
  const deviceKind = portableDeviceKind(body?.deviceKind, "phone");
  const messageId = stringValue(body?.messageId).slice(0, 160);
  const deliveryId = stringValue(body?.deliveryId).slice(0, 200);
  const state = stringValue(body?.state).toLowerCase();
  if (!deviceId) throw portableRequestError("Portable message receipts require deviceId.");
  if (!messageId && !deliveryId) throw portableRequestError("Portable message receipts require messageId or deliveryId.");
  if (!new Set(["delivered", "played", "playback_failed"]).has(state)) {
    throw portableRequestError("Portable message receipt state must be delivered, played, or playback_failed.");
  }
  loadRelayRuntimeState();
  const message = outboxMessages.find((candidate) => candidate.appId === appId
    && ((messageId && candidate.id === messageId) || (deliveryId && candidate.deliveryId === deliveryId)));
  if (!message) return sendJson(res, 404, { code: -1, ok: false, message: "RabiLink outbound message not found." });
  if (!messageTargetsPortableDevice(message, { deviceId, deviceKind })) {
    return sendJson(res, 403, { code: -1, ok: false, message: "Receipt device is not a target of this outbound message." });
  }
  const now = Date.now();
  const receipts = Array.isArray(message.receipts) ? message.receipts : [];
  let receipt = receipts.find((candidate) => stringValue(candidate?.deviceId) === deviceId
    && stringValue(candidate?.deviceKind) === deviceKind);
  if (!receipt) {
    receipt = { deviceId, deviceKind };
    receipts.push(receipt);
  }
  if (state === "delivered") {
    if (!(Number(receipt.deliveredAt) > 0)) receipt.deliveredAt = now;
  } else if (state === "played") {
    if (!(Number(receipt.deliveredAt) > 0)) receipt.deliveredAt = now;
    if (!(Number(receipt.playedAt) > 0)) receipt.playedAt = now;
    delete receipt.playbackFailure;
    delete receipt.playbackFailedAt;
  } else {
    receipt.playbackFailedAt = now;
    receipt.playbackFailure = stringValue(body?.failure || body?.detail || "playback failed").slice(0, 240);
  }
  message.receipts = receipts;
  saveRelayRuntimeState();
  const responseReceipt = outboxMessageForResponse(message).receipts.find((candidate) => candidate.deviceId === deviceId
    && candidate.deviceKind === deviceKind);
  relayEventHub.publish("outbox_receipt", {
    appId,
    data: {
      messageId: message.id,
      deliveryId: stringValue(message.deliveryId),
      deviceId,
      deviceKind,
      state,
      receiptAt: now,
      routeProfileId: stringValue(message.routeProfileId)
    }
  });
  writeEvent("outbox_message_receipt", {
    appId,
    messageId: message.id,
    deliveryId: stringValue(message.deliveryId),
    deviceId,
    deviceKind,
    state
  });
  writeAccountLogForApp(auth.app, "outbox_message_receipt", {
    title: state === "played" ? "设备已完成播放" : state === "delivered" ? "设备已接收下行消息" : "设备播放失败",
    detail: `设备 ${deviceKind || "device"} 上报 ${state} 回执。`,
    deviceId,
    deviceKind,
    status: state
  });
  sendJson(res, 200, {
    code: 0,
    ok: true,
    messageId: message.id,
    deliveryId: stringValue(message.deliveryId),
    receipt: responseReceipt
  });
}

function handleRelayEventStream(req, url, res, body = {}) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const appId = auth.app?.id || "";
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceKind = stringValue(url.searchParams.get("deviceKind") || body?.deviceKind);
  const capabilities = normalizeWorkerCapabilities(url.searchParams.get("capabilities") || body?.capabilities || "");
  const peerUrls = url.searchParams.has("peerUrls") ? normalizeWorkerPeerUrls(url.searchParams.get("peerUrls")) : null;
  if (deviceId || deviceGuid) {
    recordWorkerSeen(appId, deviceId || deviceName || deviceGuid, deviceName || deviceId || deviceGuid, deviceGuid, capabilities, peerUrls, deviceKind);
  }
  const subscription = relayEventHub.subscribe(res, { appId, deviceId, deviceGuid, deviceKind });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    subscription.close();
    recordWorkerDisconnected(appId, deviceId, deviceGuid);
  };
  res.once("close", close);
  req.once("aborted", close);

  if (hasClaimableTasks(appId, deviceId, deviceGuid)) {
    subscription.emit("task_available", { type: "task_available", recovery: true });
  }
  if (capabilities.includes("webgui") && hasClaimableWebguiRequests(appId, deviceId, deviceGuid)) {
    subscription.emit("webgui_available", { type: "webgui_available", recovery: true });
  }
  const speechPredicate = (request) => canWorkerClaimSpeechRequest(request, appId, deviceId, deviceGuid);
  if ((capabilities.includes("speech") || capabilities.includes("video-direct")) && speechRequests.hasClaimable(speechPredicate)) {
    subscription.emit("speech_available", { type: "speech_available", recovery: true });
  }
  const identity = { deviceId, deviceKind };
  const after = url.searchParams.get("after") || url.searchParams.get("cursor") || "";
  if (outboxMessagesResponse(after, appId, true, identity).messages.length > 0) {
    subscription.emit("outbox_available", { type: "outbox_available", recovery: true, cursor: currentOutboxCursor() });
  }
}

function handleRokidInput(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
  const outboxCursor = currentOutboxCursor();
  const event = createTask({
    ...body,
    type: stringValue(body?.type || "voice_transcript"),
    source: stringValue(body?.source || "rabilink-aiui")
  }, req, auth);
  sendJson(res, 202, {
    code: 0,
    ok: true,
    status: "accepted",
    eventId: event.id,
    cursor: outboxCursor,
    nextCursor: outboxCursor,
    acceptedAt: event.createdAt
  });
}

function handleDeviceLogs(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.app) return sendRabiLinkError(res, 401, "请使用 RabiLink服务器控制台里对应应用的 token。");
  const entries = Array.isArray(body?.logs) ? body.logs : (Array.isArray(body?.entries) ? body.entries : []);
  if (!entries.length) return sendRabiLinkError(res, 400, "logs 至少需要包含一条设备日志。");
  const result = appendDeviceLogs({
    directory: deviceLogDir,
    accountId: auth.app.ownerAccountId,
    appId: auth.app.id,
    appName: auth.app.name || "",
    body,
    maxRows: deviceLogMaxRows
  });
  const first = result.accepted[0] || {};
  writeAccountLogForApp(auth.app, "device_logs_ingested", {
    title: "眼镜日志已上传",
    detail: `${first.deviceName || body.deviceName || body.deviceId || "未识别设备"} · ${first.source || body.source || "unknown"} · ${result.acceptedCount} 条`,
    level: result.accepted.some((row) => row.level === "error" || row.level === "fatal") ? "error" : "info",
    status: "stored",
    deviceId: first.deviceId || body.deviceId || "",
    deviceKind: first.deviceKind || body.deviceKind || "",
    deviceName: first.deviceName || body.deviceName || "",
    source: first.source || body.source || "",
    appVersion: first.appVersion || body.appVersion || "",
    sessionId: first.sessionId || body.sessionId || "",
    messageCount: result.acceptedCount,
    textPreview: first.message || ""
  });
  return sendJson(res, 202, {
    code: 0,
    ok: true,
    status: "stored",
    accepted: result.acceptedCount,
    duplicates: result.duplicateCount,
    lastId: result.accepted.at(-1)?.id || "",
    serverTime: nowIso()
  });
}

function bindDeviceSerialToApp(account, appId, body) {
  const serialNumber = validateDeviceSerialNumber(body.serialNumber || body.sn);
  const serialHash = sha256(serialNumber);
  const store = readAppStore();
  const app = store.apps.find((item) => item.id === appId && item.ownerAccountId === account.id);
  if (!app) {
    const error = new Error(`RabiLink app not found: ${appId}`);
    error.statusCode = 404;
    throw error;
  }
  const duplicate = store.apps.find((item) => {
    return item.ownerAccountId === account.id
      && item.id !== app.id
      && (item.deviceBindings || []).some((binding) => binding.enabled !== false && binding.serialHash === serialHash);
  });
  if (duplicate) {
    const error = new Error(`这副眼镜已经绑定到应用 ${duplicate.name}。`);
    error.statusCode = 409;
    throw error;
  }
  const time = nowIso();
  app.deviceBindings = Array.isArray(app.deviceBindings) ? app.deviceBindings : [];
  let binding = app.deviceBindings.find((item) => item.serialHash === serialHash);
  if (binding) {
    binding.enabled = true;
    binding.credentialHash = "";
    binding.claimedAt = "";
    binding.claimExpiresAt = new Date(Date.now() + deviceBindingClaimTtlMs).toISOString();
    binding.updatedAt = time;
  } else {
    binding = {
      id: randomId("glasses"),
      serialHash,
      serialPreview: deviceSerialPreview(serialNumber),
      enabled: true,
      credentialHash: "",
      createdAt: time,
      updatedAt: time,
      claimedAt: "",
      claimExpiresAt: new Date(Date.now() + deviceBindingClaimTtlMs).toISOString()
    };
    app.deviceBindings.push(binding);
  }
  app.updatedAt = time;
  writeAppStore(store);
  writeAccountLog(account, "glasses_sn_bound", {
    title: "眼镜 SN 已绑定",
    detail: `${binding.serialPreview} 已绑定到 ${app.name}，等待眼镜首次领取设备凭证。`,
    appId: app.id,
    appName: app.name,
    deviceId: binding.id,
    status: "pending"
  });
  return { app, binding };
}

function claimDeviceToken(body) {
  const serialNumber = validateDeviceSerialNumber(body.serialNumber || body.sn);
  const serialHash = sha256(serialNumber);
  const store = readAppStore();
  let app = null;
  let binding = null;
  for (const candidate of store.apps) {
    if (candidate.enabled === false) continue;
    const match = (candidate.deviceBindings || []).find((item) => item.enabled !== false && item.serialHash === serialHash);
    if (!match) continue;
    app = candidate;
    binding = match;
    break;
  }
  if (!app || !binding) {
    const error = new Error("这副眼镜尚未在 RabiLink服务器控制台绑定。请登录 /manage，把页面显示的 SN 绑定到目标应用。");
    error.statusCode = 404;
    error.code = "DEVICE_NOT_BOUND";
    throw error;
  }
  if (binding.credentialHash) {
    const error = new Error("这副眼镜已经领取过设备凭证。如本地凭证已丢失，请在服务器后台重新绑定同一 SN 后再试。");
    error.statusCode = 409;
    error.code = "DEVICE_ALREADY_CLAIMED";
    throw error;
  }
  const claimExpiresAt = Date.parse(binding.claimExpiresAt || "");
  if (!Number.isFinite(claimExpiresAt) || claimExpiresAt <= Date.now()) {
    const error = new Error("这副眼镜的首次领取窗口已过期。请在服务器后台对同一 SN 再点一次“绑定 / 重置”。");
    error.statusCode = 410;
    error.code = "DEVICE_CLAIM_EXPIRED";
    throw error;
  }
  const token = generateRabiLinkDeviceToken();
  const time = nowIso();
  binding.credentialHash = sha256(token);
  binding.claimedAt = time;
  binding.claimExpiresAt = "";
  binding.updatedAt = time;
  app.updatedAt = time;
  writeAppStore(store);
  writeAccountLogForApp(app, "glasses_device_token_claimed", {
    title: "眼镜设备凭证已领取",
    detail: `${binding.serialPreview} 已完成首次绑定。`,
    appId: app.id,
    appName: app.name,
    deviceId: binding.id,
    status: "online"
  });
  return {
    token,
    app: publicApp(app),
    device: {
      id: binding.id,
      serialPreview: binding.serialPreview,
      claimedAt: binding.claimedAt
    }
  };
}

function handlePortableInput(req, url, res, body) {
  const sourceDeviceKind = portableDeviceKind(body?.sourceDeviceKind || body?.deviceKind, "other");
  const transport = portableTransport(body?.transport || body?.sourceTransport, "direct-network");
  const health = portableHealthPayload(body?.health);
  if (health) {
    return handleRokidInput(req, url, res, {
      text: stringValue(body?.text || "Wearable health observation"),
      type: "wearable.health",
      deliveryMode: "observe",
      source: "rabilink-wearable",
      sourceDeviceId: stringValue(body?.sourceDeviceId || body?.deviceId),
      sourceDeviceName: stringValue(body?.sourceDeviceName || body?.deviceName),
      sourceDeviceKind,
      transport,
      clientMessageId: stringValue(body?.clientMessageId),
      capturedAt: portableHealthNumber(body?.capturedAt, 0, Number.MAX_SAFE_INTEGER),
      routeProfileId: stringValue(body?.routeProfileId).slice(0, 160),
      health
    });
  }
  const input = {
    ...body,
    type: stringValue(body?.type || "rabilink.observation"),
    deliveryMode: stringValue(body?.deliveryMode || "observe"),
    source: stringValue(body?.source || "rabilink-portable-device"),
    sourceDeviceId: stringValue(body?.sourceDeviceId || body?.deviceId),
    sourceDeviceName: stringValue(body?.sourceDeviceName || body?.deviceName),
    sourceDeviceKind,
    transport
  };
  return handleRokidInput(req, url, res, input);
}

function handleWorkerMessageAppend(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
  loadRelayRuntimeState();
  const candidates = Array.isArray(body?.messages) ? body.messages : [body];
  const source = stringValue(body?.source || body?.sender || "Rabi");
  const created = [];
  const accepted = [];
  let deduplicatedCount = 0;
  for (const [index, candidate] of candidates.slice(0, 50).entries()) {
    const text = extractText(candidate);
    const portableEnvelope = portableTargetEnvelope(candidate, body);
    const attachments = portableAttachments(candidate?.attachments === undefined ? body?.attachments : candidate.attachments);
    if (!text && attachments.length === 0) continue;
    const proactive = candidate?.proactive === undefined
      ? body?.proactive !== false
      : candidate.proactive !== false;
    const final = candidate?.final === undefined
      ? body?.final !== false
      : candidate.final !== false;
    const rootDeliveryId = stringValue(body?.deliveryId || body?.idempotencyKey);
    const deliveryId = stringValue(candidate?.deliveryId || candidate?.idempotencyKey)
      || (rootDeliveryId && candidates.length > 1 ? `${rootDeliveryId}:${index}` : rootDeliveryId);
    const taskId = stringValue(candidate?.taskId || body?.taskId);
    const existing = deliveryId
      ? outboxMessages.find((message) => message.appId === (auth.app?.id || "") && message.deliveryId === deliveryId)
      : null;
    if (existing) {
      const existingPortableEnvelope = portableEnvelopeForResponse(existing);
      const samePayload = existing.text === text
        && existing.taskId === taskId
        && existing.proactive === proactive
        && existing.final === final
        && JSON.stringify(existingPortableEnvelope) === JSON.stringify({ ...portableEnvelope, routeProfileId: stringValue(candidate?.routeProfileId || body?.routeProfileId).slice(0, 160), attachments });
      if (!samePayload) {
        return sendJson(res, 409, {
          code: -1,
          ok: false,
          message: "RabiLink outbound delivery id was reused with a different payload."
        });
      }
      accepted.push(existing);
      deduplicatedCount += 1;
      continue;
    }
    const seq = nextOutboxMessageSeq;
    nextOutboxMessageSeq += 1;
    const message = {
      id: `out-${String(seq).padStart(9, "0")}`,
      seq,
      appId: auth.app?.id || "",
      taskId,
      taskMessageId: stringValue(candidate?.id) || `push-${randomUUID()}`,
      deliveryId,
      createdAt: Date.now(),
      text,
      final,
      status: proactive ? "proactive" : "reply",
      proactive,
      source: stringValue(candidate?.source || source),
      routeProfileId: stringValue(candidate?.routeProfileId || body?.routeProfileId).slice(0, 160),
      attachments,
      ...portableEnvelope
    };
    outboxMessages.push(message);
    created.push(message);
    accepted.push(message);
  }
  if (!accepted.length) {
    return sendJson(res, 400, { code: -1, ok: false, message: "RabiLink outbound message text and attachments are empty." });
  }
  if (created.length) {
    saveRelayRuntimeState();
    relayEventHub.publish("outbox_available", {
      appId: auth.app?.id || "",
      data: { cursor: currentOutboxCursor() }
    });
  }
  const proactiveCount = created.filter((message) => message.proactive).length;
  const replyCount = created.length - proactiveCount;
  if (created.length) {
    writeEvent("outbound_messages_appended", {
      appId: auth.app?.id || "",
      messageCount: created.length,
      proactiveCount,
      replyCount,
      source
    });
    writeAccountLogForApp(auth.app, "outbound_messages_appended", {
      title: "Rabi 下行队列新增消息",
      detail: `新增 ${created.length} 条下行消息（回复 ${replyCount}，主动 ${proactiveCount}）。`,
      messageCount: created.length,
      proactiveCount,
      replyCount,
      source
    });
  }
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: "queued",
    deduplicated: deduplicatedCount > 0,
    deduplicatedCount,
    nextCursor: outboxCursorToken(accepted[accepted.length - 1].seq),
    messages: accepted.map(outboxMessageForResponse)
  });
}

async function handleWorkerTasks(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 10);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const appId = auth.app?.id || "";
  if (deviceId || deviceName) {
    const declaredCapabilities = url.searchParams.has("capabilities")
      ? normalizeWorkerCapabilities(url.searchParams.get("capabilities"))
      : null;
    const peerUrls = url.searchParams.has("peerUrls") ? normalizeWorkerPeerUrls(url.searchParams.get("peerUrls")) : null;
    recordWorkerSeen(appId, deviceId || deviceName, deviceName || deviceId, deviceGuid, declaredCapabilities, peerUrls);
  }
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
  const claimed = await claimAfterRelayEvent(
    req,
    "task_available",
    { appId, deviceId, deviceGuid },
    waitMs,
    () => claimTasks(limit, deviceId, appId, deviceGuid)
  );
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: claimed.length > 0 ? "claimed" : "empty",
    shouldContinue: true,
    tasks: claimed
  });
}

async function handleWorkerWebguiRequests(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 5);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const appId = auth.app?.id || "";
  if (deviceId || deviceName) {
    const capabilities = url.searchParams.has("capabilities")
      ? normalizeWorkerCapabilities(url.searchParams.get("capabilities"))
      : null;
    const peerUrls = url.searchParams.has("peerUrls") ? normalizeWorkerPeerUrls(url.searchParams.get("peerUrls")) : null;
    recordWorkerSeen(appId, deviceId || deviceName, deviceName || deviceId, deviceGuid, capabilities, peerUrls);
  }
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
  const claimed = await claimAfterRelayEvent(
    req,
    "webgui_available",
    { appId, deviceId, deviceGuid },
    waitMs,
    () => claimWebguiRequests(limit, deviceId, appId, deviceGuid)
  );
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: claimed.length > 0 ? "claimed" : "empty",
    shouldContinue: true,
    requests: claimed
  });
}

async function handleWorkerSpeechRequests(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 5);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const appId = auth.app?.id || "";
  if (deviceId || deviceName) {
    const capabilities = normalizeWorkerCapabilities(url.searchParams.get("capabilities") || "speech");
    if (!capabilities.includes("speech") && !capabilities.includes("video-direct")) capabilities.push("speech");
    const peerUrls = url.searchParams.has("peerUrls") ? normalizeWorkerPeerUrls(url.searchParams.get("peerUrls")) : null;
    recordWorkerSeen(appId, deviceId || deviceName, deviceName || deviceId, deviceGuid, capabilities, peerUrls);
  }
  const predicate = (request) => canWorkerClaimSpeechRequest(request, appId, deviceId, deviceGuid);
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
  const claimed = await claimAfterRelayEvent(
    req,
    "speech_available",
    { appId, deviceId, deviceGuid },
    waitMs,
    () => speechRequests.claim(limit, predicate)
  );
  if (res.writableEnded || res.destroyed) return;
  for (const request of claimed) {
    writeEvent("speech_request_leased", speechRequestForLog(request));
    scheduleLeaseAvailability("speech_available", request.appId, request.targetDeviceId, request.leaseUntil, { requestId: request.id });
  }
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: claimed.length > 0 ? "claimed" : "empty",
    shouldContinue: true,
    requests: claimed.map((request) => speechRequests.forTransport(request))
  });
}

function handleWorkerWebguiResponse(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/webgui-requests\/([^/]+)\/response$/);
  const requestId = match ? decodeURIComponent(match[1]) : "";
  const request = webguiRequests.get(requestId);
  if (!request) return sendJson(res, 404, { code: -1, ok: false, message: `WebGUI request not found: ${requestId}` });
  if (auth.app?.id !== request.appId) {
    return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  }
  requireWorkerOwnsTarget(request.targetDeviceId, body, "WebGUI request", request.appId);
  if (request.status === "done" || request.status === "failed") {
    return sendJson(res, 200, {
      code: 0,
      ok: request.status === "done",
      deduplicated: true,
      request: webguiRequestForResponse(request)
    });
  }
  const finished = finishWebguiRequest(requestId, body);
  sendJson(res, 200, { code: 0, ok: true, request: webguiRequestForResponse(finished) });
}

function handleWorkerWebguiEvent(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const identity = workerIdentityFromBody(body);
  const store = readAppStore();
  const worker = store.workers.find((item) => item.appId === auth.app?.id
    && ((identity.deviceGuid && item.guid === identity.deviceGuid) || (identity.deviceId && item.id === identity.deviceId)));
  if (!worker) return sendJson(res, 403, { code: -1, ok: false, message: "WebGUI events can only be published by a registered Rabi PC." });
  const streamPath = stringValue(body?.streamPath) || "/api/events";
  if (!webguiEventStreamPaths.has(streamPath)) {
    return sendJson(res, 400, { code: -1, ok: false, message: `Unsupported WebGUI event stream: ${streamPath}` });
  }
  const eventType = stringValue(body?.eventType).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96);
  if (!eventType || eventType === "ready") {
    return sendJson(res, 400, { code: -1, ok: false, message: "A non-ready WebGUI event type is required." });
  }
  const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
  if (eventType === "persona_avatar_changed") {
    // The phone receives only role id + opaque version + Relay-relative URL; no NAS path escapes this boundary.
    relayEventHub.publish(eventType, { appId: auth.app.id, data });
    return sendJson(res, 202, { code: 0, ok: true });
  }
  webguiEventHub.publish(eventType, {
    appId: auth.app.id,
    targetDeviceId: worker.guid || worker.id,
    channel: streamPath,
    data
  });
  return sendJson(res, 202, { code: 0, ok: true });
}

function handleWorkerSpeechResponse(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/speech-requests\/([^/]+)\/response$/);
  const requestId = match ? decodeURIComponent(match[1]) : "";
  const request = speechRequests.get(requestId);
  if (!request) return sendJson(res, 404, { code: -1, ok: false, message: `Speech request not found: ${requestId}` });
  if (auth.app?.id !== request.appId) {
    return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  }
  requireWorkerOwnsTarget(request.targetDeviceId, body, "Speech request", request.appId);
  const completed = speechRequests.complete(requestId, {
    ...body,
    headers: normalizeProxyResponseHeaders(body?.headers)
  });
  if (!completed.request) return sendJson(res, 404, { code: -1, ok: false, message: `Speech request not found: ${requestId}` });
  sendJson(res, 200, {
    code: 0,
    ok: completed.request.status === "done",
    deduplicated: completed.deduplicated,
    request: speechRequestForLog(completed.request)
  });
}

function handleTaskResult(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/result$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const taskBefore = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, taskBefore)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  requireWorkerOwnsTarget(taskBefore.targetDeviceId, body, "RabiLink task", taskBefore.appId);
  const task = finishTask(taskId, body);
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function handleTaskMessagesAppend(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/messages$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const taskBefore = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, taskBefore)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  requireWorkerOwnsTarget(taskBefore.targetDeviceId, body, "RabiLink task", taskBefore.appId);
  const result = appendTaskMessages(taskId, body, { finish: false });
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: result.task.status,
    task: taskForResponse(result.task),
    messages: result.messages.map(messageForResponse)
  });
}

function handleTaskFinish(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/finish$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  requireWorkerOwnsTarget(task.targetDeviceId, body, "RabiLink task", task.appId);
  if (isTerminalTask(task)) {
    return sendJson(res, 200, {
      code: 0,
      ok: task.status === "done",
      status: task.status,
      deduplicated: true,
      task: taskForResponse(task)
    });
  }
  const finalText = extractText(body);
  const appended = finalText
    ? appendTaskMessages(taskId, { text: finalText, final: true, raw: body }, { finish: true, final: true })
    : { task, messages: [] };
  task.status = body?.ok === false || body?.status === "failed" ? "failed" : "done";
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.error = task.status === "failed" ? stringValue(body?.error || body?.reason || "RabiLink worker reported failure.") : "";
  saveRelayRuntimeState();
  finishWaiters(task);
  writeEvent(task.status === "done" ? "task_finished" : "task_failed", taskForResponse(task));
  sendJson(res, 200, {
    code: task.status === "done" ? 0 : -1,
    ok: task.status === "done",
    status: task.status,
    task: taskForResponse(task),
    messages: appended.messages.map(messageForResponse)
  });
}

function handleTaskRead(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  loadRelayRuntimeState();
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, { code: -1, ok: false, message: `Task not found: ${taskId}` });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RabiLink服务器控制台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --ink: #112033;
      --title: #0c2a4a;
      --muted: #667586;
      --line: rgba(17, 32, 51, .1);
      --brand: #102a43;
      --accent: #19bfc1;
      --brand-ink: #ffffff;
      --warn: #9a6700;
      --danger: #dc2626;
      --soft: rgba(25, 191, 193, .12);
      --field: rgba(255, 255, 255, .86);
      --field-hover: rgba(236, 252, 255, .74);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(12, 42, 74, .04) 1px, transparent 1px),
        linear-gradient(0deg, rgba(12, 42, 74, .032) 1px, transparent 1px),
        linear-gradient(180deg, #fbfdff 0%, #f2f8fa 52%, #f8fbfd 100%);
      background-size: 40px 40px, 40px 40px, auto;
      color: var(--ink);
      font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    }
    button, input, textarea { font: inherit; }
    .shell { width: min(1160px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 44px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px; background: linear-gradient(135deg, var(--brand), #0f8b8d); color: var(--brand-ink); font-weight: 900; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 32px); line-height: 1.1; letter-spacing: 0; }
    .subtitle { margin-top: 4px; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
    .card { position: relative; background: rgba(255, 255, 255, .92); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 10px 24px rgba(15, 23, 42, .07); backdrop-filter: blur(14px); }
    .card.combo-layer { z-index: 60; }
    .card + .card { margin-top: 16px; }
    .title-row { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 14px; }
    .title { color: var(--title); font-size: 16px; font-weight: 800; }
    .note { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .rabi-field {
      position: relative;
      display: block;
      min-width: 0;
    }
    .rabi-field input,
    .rabi-field textarea,
    .combo-trigger {
      width: 100%;
      min-height: 48px;
      border: 1px solid rgba(17, 32, 51, .18);
      border-radius: 8px;
      padding: 17px 12px 7px;
      background: var(--field);
      color: var(--ink);
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    .rabi-field textarea { min-height: 82px; resize: vertical; }
    .rabi-field input:focus,
    .rabi-field textarea:focus,
    .combo.open .combo-trigger,
    .combo-trigger:focus { border-color: rgba(25, 191, 193, .72); box-shadow: 0 0 0 3px rgba(25, 191, 193, .14); background: #fff; }
    .field-label {
      position: absolute;
      left: 11px;
      top: -7px;
      z-index: 1;
      max-width: calc(100% - 22px);
      padding: 0 5px;
      background: linear-gradient(180deg, rgba(255, 255, 255, .96), rgba(255, 255, 255, .96));
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .form { display: grid; gap: 12px; }
    .password-field input { padding-right: 50px; }
    .password-field button {
      position: absolute;
      right: 4px;
      top: 4px;
      display: inline-grid;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      background: transparent;
      color: var(--muted);
    }
    .password-field button:hover { background: var(--field-hover); color: var(--title); }
    .password-field svg { width: 20px; height: 20px; stroke: currentColor; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .device-binding-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 12px; }
    .device-binding-row .rabi-field { margin: 0; }
    .device-binding-list { color: var(--muted); font-size: 12px; line-height: 1.6; margin-top: 8px; overflow-wrap: anywhere; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 13px;
      background: var(--soft);
      color: #0f8b8d;
      cursor: pointer;
      font-weight: 720;
    }
    button.primary { background: var(--brand); color: var(--brand-ink); box-shadow: 0 8px 18px rgba(17, 32, 51, .16); }
    button.danger { background: #fff0ee; color: var(--danger); }
    button:disabled { opacity: .55; cursor: wait; }
    .status { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .pill { display: inline-flex; align-items: center; min-height: 30px; border-radius: 999px; padding: 5px 10px; background: var(--soft); color: #0f8b8d; font-size: 13px; font-weight: 800; }
    .pill.warn { background: #fff6df; color: var(--warn); }
    .alert { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: #fff0ee; color: var(--danger); border: 1px solid #ffd1ca; }
    .notice { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: var(--soft); color: #0f8b8d; border: 1px solid rgba(25, 191, 193, .28); }
    .app-list { display: grid; gap: 12px; }
    .app { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: rgba(255, 255, 255, .74); }
    .app-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .app-name { color: var(--title); font-weight: 850; }
    .app-id { color: var(--muted); font-size: 13px; word-break: break-all; }
    .meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
    .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: rgba(255, 255, 255, .82); min-width: 0; }
    .tile > span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; font-weight: 750; }
    .tile b { display: block; min-height: 20px; overflow-wrap: anywhere; font-size: 13px; }
    .switch-field { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--title); font-weight: 800; user-select: none; }
    .switch-field input { position: absolute; opacity: 0; pointer-events: none; }
    .switch-track { position: relative; width: 54px; height: 28px; border-radius: 999px; background: rgba(17, 32, 51, .42); box-shadow: inset 0 1px 2px rgba(17, 32, 51, .14); transition: background .16s ease; }
    .switch-thumb { position: absolute; left: -2px; top: -2px; width: 32px; height: 32px; border-radius: 50%; background: #fffaf0; box-shadow: 0 8px 18px rgba(17, 32, 51, .2); transition: transform .16s ease; }
    .switch-field input:checked + .switch-track { background: var(--accent); }
    .switch-field input:checked + .switch-track .switch-thumb { transform: translateX(26px); }
    .switch-field input:focus-visible + .switch-track { box-shadow: 0 0 0 3px rgba(25, 191, 193, .18), inset 0 1px 2px rgba(17, 32, 51, .14); }
    .combo { position: relative; min-width: 0; z-index: 1; }
    .combo.open { z-index: 70; }
    .combo-trigger { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 48px; text-align: left; color: var(--ink); cursor: pointer; }
    .combo-trigger::after { content: ""; width: 7px; height: 7px; border-right: 2px solid #667586; border-bottom: 2px solid #667586; transform: rotate(45deg); margin-top: -4px; }
    .combo-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 750; }
    .combo-panel { position: absolute; z-index: 80; left: 0; right: 0; top: calc(100% + 4px); display: grid; gap: 8px; border: 1px solid rgba(17, 32, 51, .14); border-radius: 8px; padding: 8px; background: #fff; box-shadow: 0 18px 34px rgba(15, 23, 42, .14); }
    .combo-search { min-height: 38px !important; padding: 8px 10px !important; border-radius: 8px !important; font-size: 13px; }
    .combo-options { display: grid; gap: 4px; max-height: 220px; overflow: auto; }
    .combo-option { display: grid; gap: 2px; width: 100%; border: 1px solid transparent; border-radius: 8px; padding: 8px 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
    .combo-option:hover, .combo-option.active { border-color: rgba(25, 191, 193, .42); background: rgba(236, 252, 255, .82); }
    .combo-option strong { min-width: 0; color: var(--title); font-size: 13px; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .combo-option span { min-width: 0; color: var(--muted); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .worker-list { display: grid; gap: 10px; }
    .worker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: rgba(255, 255, 255, .74); }
    .worker-name { color: var(--title); font-weight: 850; overflow-wrap: anywhere; }
    .worker-meta { margin-top: 3px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .worker-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .webgui { display: inline-flex; align-items: center; min-height: 26px; border-radius: 6px; padding: 4px 9px; background: rgba(25, 191, 193, .12); color: #0f8b8d; font-size: 12px; font-weight: 760; text-decoration: none; }
    .webgui:hover { background: #d1fae5; }
    .webgui.disabled { color: var(--muted); background: #eef1f0; pointer-events: none; }
    .dot { display: inline-flex; align-items: center; min-height: 26px; border-radius: 999px; padding: 4px 9px; background: var(--soft); color: #0f8b8d; font-size: 12px; font-weight: 760; }
    .dot.idle { background: #eef1f0; color: var(--muted); }
    .log-list { display: grid; gap: 8px; max-height: 360px; overflow: auto; padding-right: 2px; }
    .device-log-toolbar { display: grid; grid-template-columns: repeat(3, minmax(140px, 1fr)) minmax(180px, 1.5fr) auto; gap: 8px; margin-bottom: 12px; }
    .device-log-toolbar select, .device-log-toolbar input { width: 100%; min-height: 38px; border: 1px solid rgba(17, 32, 51, .18); border-radius: 6px; background: #fff; color: var(--ink); padding: 0 10px; }
    .log-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: rgba(255, 255, 255, .74); }
    .log-title { color: var(--title); font-weight: 850; overflow-wrap: anywhere; }
    .log-detail { margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .log-meta { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; color: var(--muted); font-size: 12px; }
    .log-badge { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 3px 8px; background: #eef1f0; color: var(--muted); font-weight: 760; }
    .log-badge.ok { background: var(--soft); color: #0f8b8d; }
    .log-badge.failed { background: #fff0ee; color: var(--danger); }
    .log-text { margin-top: 6px; border-left: 3px solid rgba(25, 191, 193, .32); padding-left: 8px; color: var(--ink); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .empty { padding: 28px; text-align: center; color: var(--muted); border: 1px dashed rgba(17, 32, 51, .18); border-radius: 8px; background: rgba(255, 255, 255, .7); }
    .hidden { display: none !important; }
    @media (max-width: 820px) {
      .topbar { align-items: start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .meta { grid-template-columns: 1fr; }
      .shell { width: min(100% - 20px, 1160px); padding-top: 18px; }
      .device-log-toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="mark">Rb</div>
        <div>
          <h1>RabiLink服务器控制台</h1>
          <div class="subtitle">管理控制台：账号、应用 token、PC Rabi 连接和远程 WebGUI</div>
        </div>
      </div>
      <div class="actions">
        <button id="refreshButton">刷新</button>
        <button id="logoutButton" class="danger hidden">退出</button>
      </div>
    </div>

    <div id="alert" class="alert hidden"></div>
    <div id="notice" class="notice hidden"></div>
    <div class="status">
      <span id="setupPill" class="pill warn">等待初始化</span>
      <span id="accountPill" class="pill">未登录</span>
      <span id="countPill" class="pill">0 个应用</span>
      <span id="workerCountPill" class="pill">0 台 PC Rabi</span>
    </div>

    <section class="grid">
      <div>
        <div id="loginCard" class="card">
          <div class="title-row">
            <div>
              <div id="authTitle" class="title">登录</div>
              <div id="authNote" class="note">使用服务器账号进入 RabiLink服务器控制台。</div>
            </div>
          </div>
          <div class="form">
            <label class="rabi-field"><span class="field-label">账号</span><input id="username" autocomplete="username" /></label>
            <label class="rabi-field password-field">
              <span class="field-label">密码</span>
              <input id="password" type="password" autocomplete="current-password" />
              <button id="togglePasswordButton" type="button" aria-label="显示密码" title="显示密码"></button>
            </label>
          </div>
          <div class="actions">
            <button id="loginButton" class="primary">登录</button>
            <button id="registerButton">注册账号</button>
          </div>
        </div>

        <div id="appCard" class="card hidden">
          <div class="title-row">
            <div>
              <div class="title">创建应用</div>
              <div class="note">为 Rokid、手机或调试入口生成独立 token。</div>
            </div>
          </div>
          <div class="form">
            <label class="rabi-field"><span class="field-label">应用名称</span><input id="appName" value="Rokid Glass" /></label>
            <label class="rabi-field"><span class="field-label">备注</span><textarea id="appNotes" placeholder="例如：生产眼镜、测试手机、家里局域网"></textarea></label>
          </div>
          <div class="actions">
            <button id="createAppButton" class="primary">创建应用</button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="title-row">
            <div>
              <div class="title">已连接的 PC Rabi</div>
              <div class="note">这里只显示具备任务、WebGUI、人格同步或语音处理能力的 PC；手机、眼镜、手表和耳机终端不会计入，也不会提供 PC WebGUI 入口。</div>
            </div>
          </div>
          <div id="workers" class="worker-list"></div>
          <div id="workersEmpty" class="empty">还没有 PC Rabi 上线。启动已绑定服务器 token 的 RabiRoute 后会自动出现。</div>
        </div>

        <div class="card">
          <div class="title-row">
            <div>
              <div class="title">应用列表</div>
              <div class="note">卡片默认显示 token 预览，登录后可以随时复制完整 token；每个应用可以指定要通讯的 Rabi PC。</div>
            </div>
          </div>
          <div id="apps" class="app-list"></div>
          <div id="empty" class="empty">还没有应用。先登录或完成首次注册，然后创建一个 RabiLink 应用。</div>
        </div>

        <div id="logsCard" class="card hidden">
          <div class="title-row">
            <div>
              <div class="title">最近日志</div>
              <div class="note">只显示当前账号的脱敏事件，用来确认插件、PC Rabi 和远程 WebGUI 是否连通。</div>
            </div>
            <button id="refreshLogsButton" type="button">刷新日志</button>
          </div>
          <div id="logs" class="log-list"></div>
          <div id="logsEmpty" class="empty">还没有日志。提交消息、连接 PC Rabi 或打开 WebGUI 后会显示在这里。</div>
        </div>

        <div id="deviceLogsCard" class="card hidden">
          <div class="title-row">
            <div>
              <div class="title">眼镜云日志</div>
              <div class="note">集中查看当前账号下所有眼镜应用上报的脱敏日志；可按设备、来源、级别和关键词筛选。</div>
            </div>
          </div>
          <div class="device-log-toolbar">
            <select id="deviceLogDevice"><option value="">全部设备</option></select>
            <select id="deviceLogSource"><option value="">全部来源</option></select>
            <select id="deviceLogLevel"><option value="">全部级别</option><option value="debug">debug</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option><option value="fatal">fatal</option></select>
            <input id="deviceLogQuery" placeholder="搜索事件、消息或设备" />
            <button id="refreshDeviceLogsButton" type="button">查询日志</button>
          </div>
          <div id="deviceLogs" class="log-list"></div>
          <div id="deviceLogsEmpty" class="empty">还没有眼镜日志。新版本 AIUI 连接 Relay 后会自动批量上报。</div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const apiBase = "/manage/api";
    const credentialStorageKey = "rabilinkManageCredentials";
    const legacyCredentialStorageKey = "rabilinkAdminCredentials";
    const state = { account: null, apps: [], workers: [], logs: [], deviceLogs: [], deviceLogFacets: {}, revealed: {}, credentials: loadCredentials(), setupRequired: false };
    let logStream = null;
    let logStreamAccountId = "";
    const el = (id) => document.getElementById(id);

    function encodeAuth(username, password) {
      return btoa(unescape(encodeURIComponent(username + ":" + password)));
    }

    function passwordIcon(visible) {
      return visible
        ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3l18 18" stroke-width="2" stroke-linecap="round"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" stroke-width="2" stroke-linecap="round"/><path d="M9.9 4.2A9.7 9.7 0 0 1 12 4c5 0 8.7 4 10 8a12.5 12.5 0 0 1-2.4 3.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.1 6.4A12.3 12.3 0 0 0 2 12c1.3 4 5 8 10 8 1.4 0 2.8-.3 4-.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke-width="2"/></svg>';
    }

    function setPasswordVisible(visible) {
      const passwordInput = el("password");
      const toggleButton = el("togglePasswordButton");
      passwordInput.type = visible ? "text" : "password";
      toggleButton.innerHTML = passwordIcon(visible);
      toggleButton.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
      toggleButton.title = visible ? "隐藏密码" : "显示密码";
    }

    function consoleAccountFromPath() {
      const prefix = "/manage/";
      if (!window.location.pathname.startsWith(prefix)) return "";
      const segment = window.location.pathname.slice(prefix.length).split("/")[0] || "";
      try { return decodeURIComponent(segment); } catch { return segment; }
    }

    function consolePathFor(username) {
      return "/manage/" + encodeURIComponent(username);
    }

    function setConsolePath(username, replace = true) {
      if (!username) return;
      const target = consolePathFor(username);
      if (window.location.pathname === target) return;
      const method = replace ? "replaceState" : "pushState";
      window.history[method](null, "", target);
    }

    function loadCredentials() {
      try {
        const current = localStorage.getItem(credentialStorageKey);
        const legacy = localStorage.getItem(legacyCredentialStorageKey);
        const parsed = JSON.parse(current || legacy || "null");
        if (parsed && !current) {
          localStorage.setItem(credentialStorageKey, JSON.stringify(parsed));
          localStorage.removeItem(legacyCredentialStorageKey);
        }
        return parsed;
      } catch { return null; }
    }

    function saveCredentials(username, password) {
      state.credentials = { username, auth: encodeAuth(username, password) };
      localStorage.setItem(credentialStorageKey, JSON.stringify(state.credentials));
      localStorage.removeItem(legacyCredentialStorageKey);
    }

    function clearCredentials() {
      state.credentials = null;
      localStorage.removeItem(credentialStorageKey);
      localStorage.removeItem(legacyCredentialStorageKey);
    }

    function headers(json) {
      const result = {};
      if (json) result["content-type"] = "application/json";
      if (state.credentials?.auth) result["x-rabilink-admin-auth"] = state.credentials.auth;
      return result;
    }

    async function request(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.code !== 0) throw new Error(body.message || body.error || "HTTP " + response.status);
      return body;
    }

    function flash(id, text) {
      const node = el(id);
      node.textContent = text || "";
      node.classList.toggle("hidden", !text);
    }

    function setBusy(button, busy) {
      button.disabled = Boolean(busy);
    }

    async function load() {
      flash("alert", "");
      try {
        const body = await request(apiBase + "/state");
        state.account = body.account;
        state.apps = body.apps || [];
        state.workers = body.workers || [];
        state.logs = body.logs || [];
        state.setupRequired = Boolean(body.setupRequired);
        if (state.account?.username) {
          const pathAccount = consoleAccountFromPath();
          if (pathAccount && pathAccount !== state.account.username) {
            flash("notice", "当前浏览器已登录 " + state.account.username + "，已切回该账号控制台。");
          }
          setConsolePath(state.account.username);
        }
        connectLogStream();
        await loadDeviceLogs();
      } catch (error) {
        state.account = null;
        state.apps = [];
        state.workers = [];
        state.logs = [];
        state.deviceLogs = [];
        state.deviceLogFacets = {};
        state.setupRequired = !state.credentials;
        closeLogStream();
        if (state.credentials) flash("alert", error.message);
      }
      render();
    }

    async function login() {
      const username = el("username").value.trim();
      const password = el("password").value;
      setBusy(el("loginButton"), true);
      flash("alert", "");
      try {
        await request(apiBase + "/login", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "已登录。");
        setConsolePath(username, false);
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("loginButton"), false);
      }
    }

    async function registerAccount() {
      const username = el("username").value.trim();
      const password = el("password").value;
      setBusy(el("registerButton"), true);
      flash("alert", "");
      try {
        await request(apiBase + "/accounts", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "账号已创建。");
        setConsolePath(username, false);
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("registerButton"), false);
      }
    }

    async function createApp() {
      setBusy(el("createAppButton"), true);
      flash("alert", "");
      try {
        const body = await request(apiBase + "/apps", {
          method: "POST",
          body: JSON.stringify({ name: el("appName").value, notes: el("appNotes").value })
        });
        if (body.app?.token) state.revealed[body.app.id] = body.app.token;
        el("appNotes").value = "";
        flash("notice", "应用已创建，可随时复制完整 token。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("createAppButton"), false);
      }
    }

    async function loadLogs() {
      if (!state.account) return;
      try {
        const body = await request(apiBase + "/logs?limit=120");
        state.logs = body.logs || [];
        renderLogs();
      } catch (error) {
        flash("alert", error.message);
      }
    }

    function replaceSelectOptions(id, values, emptyLabel) {
      const select = el(id);
      const selected = select.value;
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel;
      select.appendChild(empty);
      for (const value of values || []) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = [...select.options].some((option) => option.value === selected) ? selected : "";
    }

    async function loadDeviceLogs() {
      if (!state.account) return;
      const params = new URLSearchParams({ limit: "200", deviceKind: "glasses" });
      const deviceId = el("deviceLogDevice").value;
      const source = el("deviceLogSource").value;
      const level = el("deviceLogLevel").value;
      const query = el("deviceLogQuery").value.trim();
      if (deviceId) params.set("deviceId", deviceId);
      if (source) params.set("source", source);
      if (level) params.set("level", level);
      if (query) params.set("query", query);
      try {
        const body = await request(apiBase + "/device-logs?" + params.toString());
        state.deviceLogs = body.logs || [];
        state.deviceLogFacets = body.facets || {};
        renderDeviceLogs();
      } catch (error) {
        flash("alert", error.message);
      }
    }

    function closeLogStream() {
      if (!logStream) return;
      logStream.close();
      logStream = null;
      logStreamAccountId = "";
    }

    function upsertLog(log) {
      if (!log?.id) return;
      state.logs = [log, ...state.logs.filter((item) => item.id !== log.id)].slice(0, 120);
      renderLogs();
    }

    function connectLogStream() {
      if (!state.account || typeof EventSource === "undefined") return;
      if (logStream && logStreamAccountId === state.account.id) return;
      closeLogStream();
      logStreamAccountId = state.account.id;
      logStream = new EventSource(apiBase + "/logs/stream");
      logStream.addEventListener("snapshot", (event) => {
        const body = JSON.parse(event.data || "{}");
        state.logs = body.logs || [];
        renderLogs();
      });
      logStream.addEventListener("log", (event) => {
        upsertLog(JSON.parse(event.data || "{}"));
      });
      logStream.onerror = () => {
        closeLogStream();
        if (state.account) window.setTimeout(connectLogStream, 2000);
      };
    }

    async function patchApp(id, patch) {
      const body = await request(apiBase + "/apps/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      if (body.app?.token) {
        state.revealed[body.app.id] = body.app.token;
        flash("notice", "token 已重新生成，旧 token 已失效。");
      }
      await load();
    }

    async function bindDeviceSerial(id, node) {
      const input = node.querySelector(".device-sn");
      const serialNumber = input.value.trim();
      if (!serialNumber) {
        flash("alert", "请填写眼镜页面显示的完整 SN。");
        input.focus();
        return;
      }
      const button = node.querySelector(".bind-device");
      setBusy(button, true);
      try {
        await request(apiBase + "/apps/" + encodeURIComponent(id) + "/devices", {
          method: "POST",
          body: JSON.stringify({ serialNumber })
        });
        input.value = "";
        flash("notice", "眼镜 SN 已绑定，眼镜将在下一次连接事件中领取设备凭证。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(button, false);
      }
    }

    async function deleteApp(id, name) {
      if (!confirm("删除 RabiLink 应用「" + name + "」？")) return;
      await request(apiBase + "/apps/" + encodeURIComponent(id), { method: "DELETE" });
      delete state.revealed[id];
      flash("notice", "应用已删除。");
      await load();
    }

    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {}
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      try {
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected");
      } finally {
        document.body.removeChild(textarea);
      }
    }

    async function copyToken(id) {
      const app = state.apps.find((item) => item.id === id);
      const token = app?.token || state.revealed[id];
      if (!token) {
        flash("notice", "未拿到完整 token，请刷新后重试。");
        return;
      }
      try {
        await copyText(token);
        flash("notice", "token 已复制。");
      } catch {
        flash("error", "当前浏览器不允许自动复制，请手动选择 token 复制。");
      }
    }

    function workerLabel(worker) {
      if (!worker) return "未指定";
      return worker.name && worker.name !== worker.id ? worker.name + " (" + worker.id + ")" : worker.id;
    }

    function workerGuid(worker) {
      return worker?.guid || worker?.id || "";
    }

    function workerWebguiUrl(worker) {
      if (!state.account || !workerGuid(worker)) return "";
      return "/manage/" + encodeURIComponent(state.account.username) + "/" + encodeURIComponent(workerGuid(worker)) + "/#/routes";
    }

    function workersForApp(appId) {
      return state.workers.filter((worker) => worker.appId === appId);
    }

    function targetOptionsForApp(app) {
      const appWorkers = workersForApp(app.id);
      const options = [];
      for (const worker of appWorkers) {
        options.push({
          value: worker.id,
          title: workerLabel(worker),
          subtitle: (worker.guid ? "GUID " + worker.guid + " · " : "") + (worker.online ? "在线" : "最近离线")
        });
      }
      if (app.targetDeviceId && !appWorkers.some((worker) => worker.id === app.targetDeviceId)) {
        options.push({
          value: app.targetDeviceId,
          title: app.targetDeviceId,
          subtitle: "未上线"
        });
      }
      return options;
    }

    function closeCombos(except) {
      document.querySelectorAll(".combo.open").forEach((node) => {
        if (node !== except) {
          node.classList.remove("open");
          setComboLayer(node, false);
        }
      });
      document.querySelectorAll(".combo-panel").forEach((node) => {
        if (!except || !except.contains(node)) node.classList.add("hidden");
      });
      if (!except) {
        document.querySelectorAll(".card.combo-layer").forEach((node) => node.classList.remove("combo-layer"));
      }
    }

    function setComboLayer(combo, enabled) {
      const card = combo?.closest(".card");
      if (card) card.classList.toggle("combo-layer", enabled);
    }

    function renderTargetCombo(combo, app) {
      const trigger = combo.querySelector(".combo-trigger");
      const valueNode = combo.querySelector(".combo-value");
      const panel = combo.querySelector(".combo-panel");
      const search = combo.querySelector(".combo-search");
      const optionsNode = combo.querySelector(".combo-options");
      const options = targetOptionsForApp(app);
      const selected = options.find((option) => option.value === (app.targetDeviceId || ""));
      valueNode.textContent = selected?.title || "未选择 Rabi PC";

      function paintOptions(filterText = "") {
        const normalized = filterText.trim().toLowerCase();
        const visibleOptions = options.filter((option) => !normalized
          || option.title.toLowerCase().includes(normalized)
          || option.subtitle.toLowerCase().includes(normalized)
          || option.value.toLowerCase().includes(normalized));
        optionsNode.innerHTML = "";
        for (const option of visibleOptions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "combo-option";
          button.classList.toggle("active", option.value === (app.targetDeviceId || ""));
          button.innerHTML = "<strong></strong><span></span>";
          button.querySelector("strong").textContent = option.title;
          button.querySelector("span").textContent = option.subtitle;
          button.addEventListener("click", () => {
            closeCombos();
            if (option.value !== (app.targetDeviceId || "")) {
              patchApp(app.id, { targetDeviceId: option.value }).catch((error) => flash("alert", error.message));
            }
          });
          optionsNode.appendChild(button);
        }
        if (visibleOptions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.style.padding = "12px";
          empty.textContent = options.length === 0 ? "暂无使用这个应用 token 连接的 Rabi PC" : "没有匹配的 Rabi PC";
          optionsNode.appendChild(empty);
        }
      }

      paintOptions();
      trigger.addEventListener("click", () => {
        const isOpen = combo.classList.contains("open");
        closeCombos(combo);
        combo.classList.toggle("open", !isOpen);
        panel.classList.toggle("hidden", isOpen);
        setComboLayer(combo, !isOpen);
        if (!isOpen) {
          search.value = "";
          paintOptions();
          window.setTimeout(() => search.focus(), 0);
        }
      });
      search.addEventListener("input", () => paintOptions(search.value));
    }

    function renderWorkers() {
      const container = el("workers");
      container.innerHTML = "";
      el("workersEmpty").classList.toggle("hidden", state.workers.length > 0);
      for (const worker of state.workers) {
        const node = document.createElement("div");
        node.className = "worker";
        node.innerHTML =
          '<div>' +
            '<div class="worker-name"></div>' +
            '<div class="worker-meta"></div>' +
          '</div>' +
          '<div class="worker-actions"><a class="webgui" target="_blank" rel="noopener">打开 PC WebGUI</a><span class="dot"></span></div>';
        node.querySelector(".worker-name").textContent = workerLabel(worker);
        const appLabel = worker.appName || worker.appId || "-";
        const tokenLabel = worker.appTokenPreview ? "（" + worker.appTokenPreview + "）" : "";
        node.querySelector(".worker-meta").textContent =
          "应用 token：" + appLabel + tokenLabel + " · GUID：" + (worker.guid || "-") + " · 最近连接：" + (worker.lastSeenAt || "-");
        const webgui = node.querySelector(".webgui");
        const webguiUrl = workerWebguiUrl(worker);
        if (webguiUrl) {
          webgui.href = webguiUrl;
        } else {
          webgui.removeAttribute("href");
          webgui.classList.add("disabled");
        }
        const dot = node.querySelector(".dot");
        dot.textContent = worker.online ? "在线" : "最近离线";
        dot.classList.toggle("idle", !worker.online);
        container.appendChild(node);
      }
    }

    function formatLogTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value || "-";
      return date.toLocaleTimeString("zh-CN", { hour12: false });
    }

    function renderLogs() {
      const container = el("logs");
      container.innerHTML = "";
      el("logsEmpty").classList.toggle("hidden", state.logs.length > 0);
      for (const log of state.logs) {
        const node = document.createElement("div");
        node.className = "log-item";
        node.innerHTML =
          '<div>' +
            '<div class="log-title"></div>' +
            '<div class="log-detail"></div>' +
            '<div class="log-text hidden"></div>' +
          '</div>' +
          '<div class="log-meta"><span class="log-badge time"></span><span class="log-badge status"></span></div>';
        node.querySelector(".log-title").textContent = log.title || log.event || "日志";
        const bits = [];
        if (log.detail) bits.push(log.detail);
        if (log.appName) bits.push("应用：" + log.appName);
        if (log.workerName || log.workerId) bits.push("PC：" + (log.workerName || log.workerId));
        if (log.deviceName || log.deviceId) bits.push("设备：" + (log.deviceName || log.deviceId));
        if (log.source) bits.push("来源：" + log.source);
        if (log.appVersion) bits.push("版本：" + log.appVersion);
        if (log.taskId) bits.push("ID：" + log.taskId);
        if (log.error) bits.push("错误：" + log.error);
        node.querySelector(".log-detail").textContent = bits.join(" · ") || "-";
        const textNode = node.querySelector(".log-text");
        if (log.textPreview) {
          textNode.textContent = log.textPreview;
          textNode.classList.remove("hidden");
        }
        node.querySelector(".time").textContent = formatLogTime(log.time);
        const status = node.querySelector(".status");
        status.textContent = log.status || log.level || "-";
        status.classList.toggle("ok", ["ok", "done", "messages", "online", "queued", "leased", "streaming", "pending", "idle"].includes(String(log.status || "").toLowerCase()));
        status.classList.toggle("failed", ["failed", "expired"].includes(String(log.status || "").toLowerCase()) || log.level === "error");
        container.appendChild(node);
      }
    }

    function renderDeviceLogs() {
      replaceSelectOptions("deviceLogDevice", state.deviceLogFacets.devices, "全部设备");
      replaceSelectOptions("deviceLogSource", state.deviceLogFacets.sources, "全部来源");
      const container = el("deviceLogs");
      container.innerHTML = "";
      el("deviceLogsEmpty").classList.toggle("hidden", state.deviceLogs.length > 0);
      for (const log of state.deviceLogs) {
        const node = document.createElement("div");
        node.className = "log-item";
        node.innerHTML =
          '<div>' +
            '<div class="log-title"></div>' +
            '<div class="log-detail"></div>' +
            '<div class="log-text"></div>' +
          '</div>' +
          '<div class="log-meta"><span class="log-badge time"></span><span class="log-badge status"></span></div>';
        node.querySelector(".log-title").textContent = log.event || "设备日志";
        const bits = ["设备：" + (log.deviceName || log.deviceId || "未识别")];
        if (log.source) bits.push("来源：" + log.source);
        if (log.appVersion) bits.push("版本：" + log.appVersion);
        if (log.mode) bits.push("模式：" + log.mode);
        if (log.sessionId) bits.push("会话：" + log.sessionId);
        node.querySelector(".log-detail").textContent = bits.join(" · ");
        node.querySelector(".log-text").textContent = log.message || "-";
        node.querySelector(".time").textContent = formatLogTime(log.time);
        const status = node.querySelector(".status");
        status.textContent = log.level || "info";
        status.classList.toggle("ok", log.level === "info" || log.level === "debug");
        status.classList.toggle("failed", log.level === "error" || log.level === "fatal");
        container.appendChild(node);
      }
    }

    function render() {
      const loggedIn = Boolean(state.account);
      el("loginCard").classList.toggle("hidden", loggedIn && !state.setupRequired);
      el("appCard").classList.toggle("hidden", !loggedIn);
      el("logsCard").classList.toggle("hidden", !loggedIn);
      el("deviceLogsCard").classList.toggle("hidden", !loggedIn);
      el("logoutButton").classList.toggle("hidden", !state.credentials);
      el("setupPill").textContent = state.setupRequired ? "首次初始化" : "已初始化";
      el("setupPill").classList.toggle("warn", state.setupRequired);
      el("accountPill").textContent = state.account ? "账号：" + state.account.username : "未登录";
      el("countPill").textContent = state.apps.length + " 个应用";
      el("workerCountPill").textContent = state.workers.length + " 台 PC Rabi";
      el("authTitle").textContent = state.setupRequired ? "首次注册" : "登录";
      el("authNote").textContent = state.setupRequired ? "创建服务器上的第一个管理账号。" : "每个浏览器只保留一个当前登录账号，用于进入 RabiLink服务器控制台。";
      el("registerButton").textContent = state.setupRequired ? "创建第一个账号" : "新增账号";
      renderWorkers();
      renderLogs();
      renderDeviceLogs();

      const container = el("apps");
      container.innerHTML = "";
      el("empty").classList.toggle("hidden", state.apps.length > 0);
      for (const app of state.apps) {
        const token = app.tokenPreview || (state.revealed[app.id] ? "完整 token 已加载" : "");
        const node = document.createElement("div");
        node.className = "app";
        node.innerHTML =
          '<div class="app-head">' +
            '<div><div class="app-name"></div><div class="app-id"></div></div>' +
            '<label class="switch-field"><input class="enabled" type="checkbox"><span class="switch-track"><span class="switch-thumb"></span></span><b>启用</b></label>' +
          '</div>' +
          '<div class="meta">' +
            '<div class="tile"><span>Token</span><b class="token"></b></div>' +
            '<div class="tile"><span>备注</span><b class="notes"></b></div>' +
            '<div class="tile"><div class="rabi-field combo target-worker"><span class="field-label">通讯 Rabi PC</span><button class="combo-trigger" type="button"><span class="combo-value"></span></button><div class="combo-panel hidden"><input class="combo-search" placeholder="搜索 Rabi PC / GUID"><div class="combo-options"></div></div></div></div>' +
            '<div class="tile"><span>更新时间</span><b class="updated"></b></div>' +
          '</div>' +
          '<div class="device-binding-row"><div class="rabi-field"><span class="field-label">眼镜 SN</span><input class="device-sn" autocomplete="off" placeholder="输入眼镜上显示的完整 SN"></div><button class="bind-device" type="button">绑定 / 重置</button></div>' +
          '<div class="device-binding-list"></div>' +
          '<div class="actions">' +
            '<button class="copy">复制 token</button>' +
            '<button class="regen">重新生成 token</button>' +
            '<button class="danger delete">删除</button>' +
          '</div>';
        node.querySelector(".app-name").textContent = app.name;
        node.querySelector(".app-id").textContent = app.id;
        node.querySelector(".enabled").checked = app.enabled !== false;
        node.querySelector(".token").textContent = token;
        node.querySelector(".notes").textContent = app.notes || "-";
        node.querySelector(".updated").textContent = app.updatedAt || "-";
        const bindings = Array.isArray(app.deviceBindings) ? app.deviceBindings : [];
        node.querySelector(".device-binding-list").textContent = bindings.length
          ? bindings.map((item) => item.serialPreview + " · " + (item.claimed ? "已领取" : "等待眼镜领取")).join("；")
          : "尚未绑定眼镜 SN。";
        renderTargetCombo(node.querySelector(".target-worker"), app);
        node.querySelector(".enabled").addEventListener("change", (event) => patchApp(app.id, { enabled: event.target.checked }).catch((error) => flash("alert", error.message)));
        node.querySelector(".copy").addEventListener("click", () => copyToken(app.id));
        node.querySelector(".regen").addEventListener("click", () => patchApp(app.id, { regenerateToken: true }).catch((error) => flash("alert", error.message)));
        node.querySelector(".bind-device").addEventListener("click", () => bindDeviceSerial(app.id, node));
        node.querySelector(".device-sn").addEventListener("keydown", (event) => { if (event.key === "Enter") bindDeviceSerial(app.id, node); });
        node.querySelector(".delete").addEventListener("click", () => deleteApp(app.id, app.name).catch((error) => flash("alert", error.message)));
        container.appendChild(node);
      }
    }

    el("refreshButton").addEventListener("click", load);
    el("refreshLogsButton").addEventListener("click", loadLogs);
    el("refreshDeviceLogsButton").addEventListener("click", loadDeviceLogs);
    el("deviceLogDevice").addEventListener("change", loadDeviceLogs);
    el("deviceLogSource").addEventListener("change", loadDeviceLogs);
    el("deviceLogLevel").addEventListener("change", loadDeviceLogs);
    el("deviceLogQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") loadDeviceLogs(); });
    el("loginButton").addEventListener("click", login);
    el("registerButton").addEventListener("click", registerAccount);
    el("togglePasswordButton").addEventListener("click", () => {
      const passwordInput = el("password");
      setPasswordVisible(passwordInput.type !== "text");
      passwordInput.focus();
    });
    el("createAppButton").addEventListener("click", createApp);
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".combo")) closeCombos();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeCombos();
    });
    el("logoutButton").addEventListener("click", () => {
      request(apiBase + "/logout", { method: "POST" }).catch(() => {});
      closeLogStream();
      clearCredentials();
      state.account = null;
      state.apps = [];
      state.workers = [];
      state.logs = [];
      state.deviceLogs = [];
      state.deviceLogFacets = {};
      window.history.replaceState(null, "", "/manage");
      flash("notice", "已退出。");
      render();
    });
    setPasswordVisible(false);
    load();
  </script>
</body>
</html>`;
}

function manageApiPath(url) {
  if (url.pathname.startsWith("/manage/api/")) return url.pathname.slice("/manage/api".length) || "/";
  return "";
}

function manageWebguiMatch(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "manage" || parts[1] === "api" || parts.length < 3) return null;
  let restParts = parts.slice(3);
  const legacyWebgui = restParts[0] === "webgui";
  if (restParts[0] === "webgui") {
    restParts = restParts.slice(1);
  }
  return {
    username: decodeURIComponent(parts[1]),
    targetRef: decodeURIComponent(parts[2]),
    legacyWebgui,
    restPath: restParts.length > 0 ? `/${restParts.map((part) => decodeURIComponent(part)).join("/")}` : "/"
  };
}

function resolveOwnedWebguiTarget(account, targetRef, url) {
  const store = readAppStore();
  const ownedApps = store.apps.filter((app) => app.ownerAccountId === account.id && app.enabled !== false);
  const appsById = new Map(ownedApps.map((app) => [app.id, app]));
  const ownedWorkers = store.workers
    .filter((worker) => appsById.has(worker.appId))
    .filter(workerCanProcessMobileRequests);
  const requestedAppId = stringValue(url.searchParams.get("appId"));
  const requestedApp = requestedAppId ? appsById.get(requestedAppId) : null;
  let worker = ownedWorkers.find((item) => item.guid === targetRef)
    || ownedWorkers.find((item) => item.id === targetRef);
  if (worker && requestedApp && worker.appId !== requestedApp.id) {
    worker = null;
  }
  if (worker) {
    return { app: appsById.get(worker.appId), worker };
  }
  const app = appsById.get(targetRef);
  if (app) {
    const appWorkers = ownedWorkers.filter((item) => item.appId === app.id);
    if (!app.targetDeviceId) {
      const error = new Error(`No Rabi PC is selected for this app: ${app.name || app.id}`);
      error.statusCode = 409;
      throw error;
    }
    const selected = app.targetDeviceId
      ? appWorkers.find((item) => item.id === app.targetDeviceId || item.guid === app.targetDeviceId)
      : null;
    worker = selected || null;
    if (worker) return { app, worker };
  }
  const error = new Error(`Rabi PC not found or offline for this account: ${targetRef}`);
  error.statusCode = 404;
  throw error;
}

function contentTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".eot") return "application/vnd.ms-fontobject";
  return "application/octet-stream";
}

function safeChildPath(rootPath, requestPath) {
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^[/\\]+/, "");
  const candidate = path.resolve(rootPath, normalized);
  const relative = path.relative(rootPath, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return candidate;
}

function remoteWebguiPrefix(account, targetRef) {
  return `/manage/${encodeURIComponent(account.username)}/${encodeURIComponent(targetRef)}`;
}

function remoteWebguiManagerPath(restPath) {
  return restPath === "/manager-config"
    || restPath === "/meta"
    || restPath === "/network-options"
    || restPath === "/open-config-file"
    || restPath === "/manager"
    || restPath.startsWith("/manager/")
    || restPath === "/gateways"
    || restPath.startsWith("/gateways/")
    || restPath === "/api"
    || restPath.startsWith("/api/");
}

function rewriteRemoteWebguiAssetUrls(text, externalPrefix) {
  return text
    .replaceAll('"/assets/', `"${externalPrefix}/assets/`)
    .replaceAll("'/assets/", `'${externalPrefix}/assets/`)
    .replaceAll("`/assets/", "`" + externalPrefix + "/assets/")
    .replaceAll("url(/assets/", `url(${externalPrefix}/assets/`)
    .replaceAll('url("/assets/', `url("${externalPrefix}/assets/`)
    .replaceAll("url('/assets/", `url('${externalPrefix}/assets/`);
}

function remoteWebguiIndexHtml(externalPrefix) {
  const indexPath = path.join(webguiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) return "";
  const bootstrap = `<base href="${externalPrefix}/"><script>window.__RABI_MANAGER_API_BASE__=${JSON.stringify(externalPrefix)};</script>`;
  let text = fs.readFileSync(indexPath, "utf8");
  text = text.replace(/<base\s+[^>]*>/gi, "");
  text = text.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`);
  return rewriteRemoteWebguiAssetUrls(text, externalPrefix);
}

function sendRemoteWebguiStatic(req, res, match, account) {
  const externalPrefix = remoteWebguiPrefix(account, match.targetRef);
  if (match.restPath === "/" || !path.extname(match.restPath)) {
    const index = remoteWebguiIndexHtml(externalPrefix);
    if (!index) return sendText(res, 503, "RabiRoute WebGUI build is missing on the RabiLink server.");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : index);
    return true;
  }

  if (match.restPath.startsWith("/reports/")) {
    const reportRelativePath = match.restPath.slice("/reports/".length);
    const filePath = safeChildPath(path.join(webguiDistPath, "reports"), reportRelativePath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return sendText(res, 404, "Remote WebGUI report was not found.");
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": contentTypeForFile(filePath),
      "cache-control": "no-store",
      "content-length": String(body.byteLength),
      "x-content-type-options": "nosniff"
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  if (match.restPath.startsWith("/assets/")) {
    const assetRelativePath = match.restPath.slice("/assets/".length);
    const candidatePaths = [
      safeChildPath(path.join(webguiDistPath, "assets"), assetRelativePath),
      safeChildPath(webguiAssetPath, assetRelativePath)
    ].filter(Boolean);
    const filePath = candidatePaths.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filePath) return sendText(res, 404, "Remote WebGUI asset was not found.");
    const contentType = contentTypeForFile(filePath);
    let body = fs.readFileSync(filePath);
    if (/text\/javascript|text\/css|application\/json/.test(contentType)) {
      body = Buffer.from(rewriteRemoteWebguiAssetUrls(body.toString("utf8"), externalPrefix), "utf8");
    }
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": contentType.startsWith("font/") || contentType.startsWith("image/") ? "public, max-age=3600" : "no-store",
      "content-length": String(body.byteLength)
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  return sendText(res, 404, "Remote WebGUI static file was not found.");
}

function rewriteWebguiText(text, externalPrefix, contentType) {
  let next = text
    .replaceAll("\"/api/", `"${externalPrefix}/api/`)
    .replaceAll("'/api/", `'${externalPrefix}/api/`)
    .replaceAll("`/api/", "`" + externalPrefix + "/api/")
    .replaceAll("\"/manager-config", `"${externalPrefix}/manager-config`)
    .replaceAll("'/manager-config", `'${externalPrefix}/manager-config`)
    .replaceAll("`/manager-config", "`" + externalPrefix + "/manager-config")
    .replaceAll("\"/assets/", `"${externalPrefix}/assets/`)
    .replaceAll("'/assets/", `'${externalPrefix}/assets/`)
    .replaceAll("`/assets/", "`" + externalPrefix + "/assets/");
  if (contentType.includes("text/html") && !/<base\s/i.test(next)) {
    next = next.replace(/<head([^>]*)>/i, `<head$1><base href="${externalPrefix}/">`);
  }
  return next;
}

function webguiProxyFailurePayload(request) {
  const timedOut = request.status !== "failed";
  return {
    statusCode: timedOut ? 504 : 502,
    body: {
      code: -1,
      ok: false,
      error: timedOut ? "RABI_PC_WEBGUI_TIMEOUT" : "RABI_PC_WEBGUI_UNAVAILABLE",
      stage: "pc_webgui_proxy",
      retryable: true,
      request_id: request.id,
      message: timedOut
        ? "Rabi PC 未在时限内返回 Manager/WebGUI 请求。请确认目标 PC 在线并检查 Relay worker 后重试。"
        : "Rabi PC 本机 Manager/WebGUI 未能返回请求。请检查 PC 健康守护和 Manager 诊断后重试。"
    }
  };
}

function sendWebguiProxyResponse(res, request, externalPrefix) {
  if (request.status !== "done" || !request.response) {
    const failure = webguiProxyFailurePayload(request);
    const headers = {
      "cache-control": "no-store",
      "retry-after": "3",
      "x-rabiroute-error-code": failure.body.error,
      "x-rabiroute-request-id": request.id
    };
    const accept = String(request.headers?.accept || "").toLowerCase();
    if (String(request.path || "").startsWith("/api/") || accept.includes("application/json")) {
      return sendJson(res, failure.statusCode, failure.body, headers);
    }
    const requestId = String(request.id || "").replace(/[^A-Za-z0-9_-]/g, "");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RabiRoute PC 暂不可用</title></head><body style="font-family:system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6"><h1>Rabi PC 暂时没有返回控制台</h1><p>${failure.body.message}</p><p>诊断编号：<code>${requestId}</code></p><p>此错误可以重试；页面不会把空白 502 当作成功。</p></body></html>`;
    res.writeHead(failure.statusCode, {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(html))
    });
    res.end(html);
    return;
  }
  const headers = normalizeProxyResponseHeaders(request.response.headers);
  const contentType = headers["content-type"] || "application/octet-stream";
  let body = Buffer.from(request.response.bodyBase64 || "", "base64");
  if (/text\/html|javascript|text\/css|application\/json/.test(contentType)) {
    body = Buffer.from(rewriteWebguiText(body.toString("utf8"), externalPrefix, contentType), "utf8");
  }
  res.writeHead(request.response.statusCode || 200, {
    ...headers,
    "content-type": contentType,
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendRemoteWebguiEvents(req, res, target, streamPath) {
  const subscription = webguiEventHub.subscribe(res, {
    appId: target.app.id,
    deviceId: target.worker.id,
    deviceGuid: target.worker.guid,
    channel: streamPath
  });
  const close = () => subscription.close();
  req.once("close", close);
  res.once("close", close);
  return true;
}

function mobileWorkersForApp(app) {
  const store = readAppStore();
  return store.workers
    .filter((worker) => worker.appId === app.id)
    .filter(workerCanProcessMobileRequests)
    .map((worker) => publicWorker(worker, app));
}

function handlePeerDiscovery(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const peers = readAppStore().workers
    .filter(worker => worker.appId === auth.app.id)
    .filter(worker => !(deviceId && worker.id === deviceId) && !(deviceGuid && worker.guid === deviceGuid))
    .map(worker => publicWorker(worker, auth.app))
    .sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
  return sendJson(res, 200, {
    code: 0,
    ok: true,
    appId: auth.app.id,
    peers
  });
}

async function handlePersonaSyncProxy(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const targetDeviceId = stringValue(body?.targetDeviceId);
  const worker = readAppStore().workers.find(item => item.appId === auth.app.id
    && (item.id === targetDeviceId || item.guid === targetDeviceId));
  if (!worker) return sendJson(res, 404, { code: -1, ok: false, message: `Persona sync peer not found: ${targetDeviceId}` });
  if (!workerOnline(worker)) return sendJson(res, 503, { code: -1, ok: false, message: `Persona sync peer is offline: ${worker.name || worker.id}` });
  if (!normalizeWorkerCapabilities(worker.capabilities).includes("persona-sync")) {
    return sendJson(res, 409, { code: -1, ok: false, message: `Peer ${worker.name || worker.id} does not advertise persona-sync.` });
  }
  const method = stringValue(body?.method || "GET").toUpperCase();
  if (!new Set(["GET", "POST"]).has(method)) return sendJson(res, 405, { code: -1, ok: false, message: "Persona sync proxy only supports GET and POST." });
  const localPath = stringValue(body?.path);
  if (!/^\/api\/persona-sync\/(?:manifest(?:\?|$)|files\/|merge$)/.test(localPath)) {
    return sendJson(res, 400, { code: -1, ok: false, message: "Persona sync proxy path is not allowed." });
  }
  const bodyBase64 = stringValue(body?.bodyBase64);
  if (bodyBase64 && Buffer.byteLength(bodyBase64, "base64") > 24 * 1024 * 1024) {
    return sendJson(res, 413, { code: -1, ok: false, message: "Persona sync proxy body is too large." });
  }
  const now = Date.now();
  const request = {
    id: `rabilink-persona-sync-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + webguiRequestWaitMs,
    leaseUntil: 0,
    attempts: 0,
    appId: auth.app.id,
    appName: auth.app.name || "",
    targetDeviceId: worker.id,
    method,
    path: localPath,
    headers: {
      accept: stringValue(body?.accept || "application/json"),
      ...(method === "POST" ? { "content-type": "application/json; charset=utf-8" } : {})
    },
    bodyBase64,
    response: null
  };
  webguiRequests.set(request.id, request);
  writeEvent("persona_sync_proxy_created", webguiRequestForResponse(request));
  relayEventHub.publish("webgui_available", {
    appId: request.appId,
    targetDeviceId: request.targetDeviceId,
    data: { requestId: request.id }
  });
  const finished = await waitForWebguiRequest(request, webguiRequestWaitMs);
  if (finished.status !== "done" || !finished.response) {
    return sendJson(res, finished.status === "failed" ? 502 : 504, {
      code: -1,
      ok: false,
      message: finished.error || "Persona sync peer did not return a response."
    });
  }
  const headers = normalizeProxyResponseHeaders(finished.response.headers);
  const responseBody = Buffer.from(finished.response.bodyBase64 || "", "base64");
  res.writeHead(finished.response.statusCode || 200, {
    ...headers,
    "content-length": String(responseBody.byteLength),
    "cache-control": "no-store"
  });
  res.end(responseBody);
}

function selectedMobileWorker(app, workers = mobileWorkersForApp(app)) {
  if (app.targetDeviceId) {
    const selected = workers.find((worker) => worker.id === app.targetDeviceId || worker.guid === app.targetDeviceId);
    if (selected) return selected;
  }
  // A first-run phone must not require a manual picker when exactly one
  // eligible, online Rabi PC exists for this app.  Do not guess when there
  // are multiple candidates; that still requires an explicit selection.
  const online = workers.filter((worker) => worker.online);
  if (!app.targetDeviceId && online.length === 1) return online[0];
  return null;
}

function mobileDeviceStatusPath(appId) {
  const id = sanitizeRabiLinkId(appId, "");
  return id ? path.join(mobileDeviceStatusDir, `${id}.json`) : "";
}

function normalizeMobileDeviceStatus(body = {}) {
  const level = Number(body?.batteryLevel ?? body?.level);
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    const error = new Error("batteryLevel must be a number between 0 and 100.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof body?.charging !== "boolean") {
    const error = new Error("charging must be a boolean.");
    error.statusCode = 400;
    throw error;
  }
  const observedAtMs = Date.parse(stringValue(body?.observedAt));
  return {
    batteryLevel: Math.round(level),
    charging: body.charging,
    observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : nowIso(),
    receivedAt: nowIso(),
    source: "rokid-cxr-phone"
  };
}

function publicMobileDeviceStatus(status) {
  if (!status) return null;
  const receivedAtMs = Date.parse(status.receivedAt || "");
  if (!Number.isFinite(receivedAtMs)) return null;
  const ageMs = Math.max(0, Date.now() - receivedAtMs);
  return {
    batteryLevel: status.batteryLevel,
    charging: status.charging === true,
    observedAt: status.observedAt || status.receivedAt,
    receivedAt: status.receivedAt,
    source: "rokid-cxr-phone",
    stale: ageMs > mobileDeviceStatusStaleMs,
    ageMs,
    staleAfterMs: mobileDeviceStatusStaleMs
  };
}

function readMobileDeviceStatus(app) {
  const filePath = mobileDeviceStatusPath(app?.id || "");
  if (!filePath) return null;
  recoverInterruptedFileReplacement(filePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    return publicMobileDeviceStatus(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    writeEvent("mobile_device_status_read_failed", {
      appId: app?.id || "",
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function writeMobileDeviceStatus(app, body = {}) {
  const status = normalizeMobileDeviceStatus(body);
  const filePath = mobileDeviceStatusPath(app?.id || "");
  if (!filePath) {
    const error = new Error("RabiLink app id is missing.");
    error.statusCode = 400;
    throw error;
  }
  const stored = { schemaVersion: 1, appId: app.id, ...status };
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    replaceFileSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
  const result = publicMobileDeviceStatus(stored);
  writeEvent("mobile_device_status_updated", {
    appId: app.id,
    batteryLevel: result.batteryLevel,
    charging: result.charging,
    source: result.source
  });
  return result;
}

function mobileStatePayload(app) {
  const workers = mobileWorkersForApp(app);
  return {
    code: 0,
    ok: true,
    app: publicApp(app),
    selectedTargetDeviceId: app.targetDeviceId || "",
    selectedWorker: selectedMobileWorker(app, workers),
    deviceStatus: readMobileDeviceStatus(app),
    workers
  };
}

function mobileProofPath(appId) {
  const id = sanitizeRabiLinkId(appId, "");
  if (!id) return "";
  return path.join(mobileProofDir, `${id}.jsonl`);
}

function normalizeMobileProofType(value) {
  const type = stringValue(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return type.slice(0, 80) || "runtime";
}

function normalizeMobileProofDetail(value, maxLength = 220) {
  return textPreview(stringValue(value), maxLength);
}

function normalizeMobileProofBody(body = {}) {
  const device = body?.device && typeof body.device === "object" && !Array.isArray(body.device) ? body.device : {};
  const runtime = body?.runtime && typeof body.runtime === "object" && !Array.isArray(body.runtime) ? body.runtime : {};
  return {
    event: normalizeMobileProofType(body?.event || body?.type),
    detail: normalizeMobileProofDetail(body?.detail || body?.summary || ""),
    sessionId: normalizeMobileProofDetail(body?.sessionId || runtime.sessionId || "", 120),
    routeId: normalizeMobileProofDetail(body?.routeId || runtime.routeId || "", 120),
    panelId: normalizeMobileProofDetail(body?.panelId || runtime.panelId || "", 120),
    action: normalizeMobileProofDetail(body?.action || runtime.action || "", 120),
    status: normalizeMobileProofDetail(body?.status || runtime.status || "", 80),
    device: {
      serialNumber: normalizeMobileProofDetail(device.serialNumber || body?.serialNumber || "", 120),
      userAgent: normalizeMobileProofDetail(device.userAgent || body?.userAgent || "", 220),
      model: normalizeMobileProofDetail(device.model || "", 120),
      platform: normalizeMobileProofDetail(device.platform || "", 120)
    },
    runtime: {
      appName: normalizeMobileProofDetail(runtime.appName || body?.appName || "RabiLink AIUI", 120),
      appVersion: normalizeMobileProofDetail(runtime.appVersion || body?.appVersion || "", 80),
      aiuiVersion: normalizeMobileProofDetail(runtime.aiuiVersion || body?.aiuiVersion || "", 80)
    }
  };
}

function writeMobileProof(app, req, body = {}) {
  const workers = mobileWorkersForApp(app);
  const selected = selectedMobileWorker(app, workers);
  const normalized = normalizeMobileProofBody(body);
  const row = {
    id: randomId("proof"),
    time: nowIso(),
    appId: app.id,
    appName: app.name || "",
    event: normalized.event,
    detail: normalized.detail,
    sessionId: normalized.sessionId,
    routeId: normalized.routeId,
    panelId: normalized.panelId,
    action: normalized.action,
    status: normalized.status,
    selectedTargetDeviceId: app.targetDeviceId || "",
    selectedWorker: selected ? {
      id: selected.id || "",
      guid: selected.guid || "",
      name: selected.name || "",
      online: !!selected.online
    } : null,
    device: {
      ...normalized.device,
      userAgent: normalized.device.userAgent || textPreview(req.headers["user-agent"] || "", 220)
    },
    runtime: normalized.runtime
  };
  const filePath = mobileProofPath(app.id);
  if (filePath) fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
  writeEvent("mobile_runtime_proof", row);
  writeAccountLogForApp(app, "mobile_runtime_proof", {
    title: "AIUI 运行证明",
    detail: row.detail || row.event,
    workerId: row.selectedWorker?.id || row.selectedTargetDeviceId || "",
    workerName: row.selectedWorker?.name || "",
    status: row.status || row.event,
    textPreview: `${row.runtime.appName || "RabiLink AIUI"} ${row.event}`
  });
  return row;
}

function readMobileProofs(app, limit = 20) {
  const filePath = mobileProofPath(app?.id || "");
  if (!filePath || !fs.existsSync(filePath)) return [];
  const max = clamp(Number(limit || 20), 1, 100);
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-max)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function patchMobileAppTarget(app, targetDeviceId) {
  const store = readAppStore();
  const storedApp = store.apps.find((item) => item.id === app.id);
  if (!storedApp) {
    const error = new Error(`RabiLink app not found: ${app.id}`);
    error.statusCode = 404;
    throw error;
  }
  const normalized = stringValue(targetDeviceId);
  if (normalized) {
    const worker = store.workers.find((item) => item.appId === app.id
      && workerCanProcessMobileRequests(item)
      && (item.id === normalized || item.guid === normalized));
    if (!worker) {
      const error = new Error(`Rabi PC not found for this app token: ${normalized}`);
      error.statusCode = 404;
      throw error;
    }
    storedApp.targetDeviceId = worker.id;
  } else {
    storedApp.targetDeviceId = "";
  }
  storedApp.updatedAt = nowIso();
  writeAppStore(store);
  return storedApp;
}

function mobileWorkerTarget(app, url, body = {}) {
  const requested = stringValue(url.searchParams.get("targetDeviceId") || url.searchParams.get("rabiGuid") || body?.targetDeviceId || body?.rabiGuid);
  const workers = mobileWorkersForApp(app);
  const worker = requested
    ? workers.find((item) => item.id === requested || item.guid === requested)
    : selectedMobileWorker(app, workers);
  if (!requested && !app.targetDeviceId && !worker) {
    const error = new Error("No Rabi PC is selected for this app token.");
    error.statusCode = 409;
    throw error;
  }
  if (!worker) {
    const error = new Error("No Rabi PC is connected for this app token.");
    error.statusCode = 404;
    throw error;
  }
  if (!worker.online) {
    const error = new Error(`Rabi PC is offline or stale: ${worker.name || worker.id}`);
    error.statusCode = 503;
    throw error;
  }
  return worker;
}

async function mobileProxyJson(app, worker, method, localPath, body = null, mutationHeaders = {}) {
  const request = createMobileWebguiRequest(app, worker, method, localPath, body, mutationHeaders);
  const finalRequest = await waitForWebguiRequest(request, webguiRequestWaitMs);
  if (finalRequest.status !== "done" || !finalRequest.response) {
    const error = new Error(finalRequest.error || "Rabi PC WebGUI request timed out.");
    error.statusCode = finalRequest.status === "failed" ? 502 : 504;
    throw error;
  }
  const responseBody = Buffer.from(finalRequest.response.bodyBase64 || "", "base64").toString("utf8");
  let parsed = {};
  try {
    parsed = responseBody.trim() ? JSON.parse(responseBody) : {};
  } catch {
    parsed = { code: -1, message: responseBody };
  }
  return {
    statusCode: finalRequest.response.statusCode || 200,
    headers: mobileMutationResponseHeaders(finalRequest.response.headers),
    body: parsed
  };
}

async function mobileProxyRaw(app, worker, method, localPath) {
  const request = createMobileWebguiRequest(app, worker, method, localPath, null);
  const finalRequest = await waitForWebguiRequest(request, webguiRequestWaitMs);
  if (finalRequest.status !== "done" || !finalRequest.response) {
    const error = new Error(finalRequest.error || "Rabi PC media proxy timed out.");
    error.statusCode = finalRequest.status === "failed" ? 502 : 504;
    throw error;
  }
  return {
    statusCode: finalRequest.response.statusCode || 200,
    headers: finalRequest.response.headers || {},
    body: Buffer.from(finalRequest.response.bodyBase64 || "", "base64")
  };
}

function normalizeMobileWebguiPath(value) {
  const raw = stringValue(value);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /^https?:\/\//i.test(raw)) {
    const error = new Error("Invalid PC WebGUI path.");
    error.statusCode = 400;
    throw error;
  }
  return raw;
}

function mobileWebguiPathAllowed(method, rawPath) {
  const upperMethod = String(method || "GET").toUpperCase();
  const pathname = rawPath.split("?")[0] || "/";
  if (upperMethod === "GET") {
    return pathname === "/gateways"
      || pathname === "/manager-config"
      || pathname === "/meta"
      || pathname === "/network-options"
      || pathname === "/api/gateways"
      || pathname === "/api/scan/agents"
      || pathname === "/api/scan/message-adapters"
      || pathname === "/api/agent/copilot-status"
      || pathname === "/api/remote-agent/devices";
  }
  if (upperMethod === "POST") {
    return pathname === "/gateways"
      || pathname === "/manager-config"
      || pathname === "/reload"
      || pathname === "/open-config-file"
      || /^\/gateways\/[^/]+\/(?:start|stop|restart|delete|manual-trigger)$/.test(pathname)
      || pathname === "/api/message/napcat-health"
      || pathname === "/api/message/napcat-configure-onebot"
      || pathname === "/api/message/napcat-repair-all"
      || pathname === "/api/message/napcat-add"
      || pathname === "/api/message/napcat-launch"
      || pathname === "/api/message/napcat-restart"
      || pathname === "/api/message/napcat-remove"
      || pathname === "/api/agent/copilot-install"
      || pathname === "/api/agent/copilot-login"
      || pathname === "/api/agent/marvis-open"
      || pathname === "/api/agent/astrbot-login-test"
      || pathname === "/api/remote-agent/scan"
      || pathname === "/api/remote-agent/connect"
      || pathname === "/api/remote-agent/disconnect";
  }
  if (upperMethod === "PATCH") {
    return pathname === "/api/rabi/identity";
  }
  return false;
}

async function handleMobileWebguiApi(req, url, res, body, app) {
  const method = req.method === "GET" ? "GET" : stringValue(body?.method || req.method || "POST").toUpperCase();
  const localPath = normalizeMobileWebguiPath(req.method === "GET" ? url.searchParams.get("path") : body?.path);
  if (!mobileWebguiPathAllowed(method, localPath)) {
    return sendJson(res, 403, {
      code: -1,
      ok: false,
      message: `PC WebGUI path is not allowed for mobile AIUI: ${method} ${localPath}`
    });
  }
  const worker = mobileWorkerTarget(app, url, body);
  const mutationHeaders = mobileRouteMutationHeaders(req, body?.headers);
  const result = await mobileProxyJson(
    app,
    worker,
    method,
    localPath,
    method === "GET" ? null : body?.body ?? {},
    mutationHeaders
  );
  return sendJson(res, result.statusCode, result.body, result.headers);
}

async function handleMobileApi(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  if (!auth.app) return sendRabiLinkError(res, 401, "请使用 RabiLink服务器控制台里对应应用的 token。");
  const app = auth.app;
  const avatarMatch = url.pathname.match(/^\/api\/rabilink\/mobile\/personas\/([^/]+)\/avatar$/);
  if (req.method === "GET" && avatarMatch) {
    const roleId = decodeURIComponent(avatarMatch[1]).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96);
    if (!roleId) return sendJson(res, 400, { code: -1, ok: false, message: "Invalid persona id." });
    const worker = mobileWorkerTarget(app, url, body);
    const result = await mobileProxyRaw(app, worker, "GET", `/api/roles/${encodeURIComponent(roleId)}/avatar${url.search || ""}`);
    const contentType = String(result.headers["content-type"] || "image/jpeg");
    res.writeHead(result.statusCode, {
      "content-type": contentType,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff"
    });
    return res.end(result.body);
  }
  if (req.method === "GET" && url.pathname === "/api/rabilink/mobile/state") {
    return sendJson(res, 200, mobileStatePayload(app));
  }
  if (req.method === "POST" && url.pathname === "/api/rabilink/mobile/device-status") {
    const deviceStatus = writeMobileDeviceStatus(app, body || {});
    return sendJson(res, 200, { code: 0, ok: true, deviceStatus });
  }
  if (req.method === "GET" && url.pathname === "/api/rabilink/mobile/proofs") {
    return sendJson(res, 200, {
      code: 0,
      ok: true,
      proofs: readMobileProofs(app, url.searchParams.get("limit") || 20)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/rabilink/mobile/proof") {
    const proof = writeMobileProof(app, req, body || {});
    return sendJson(res, 200, { code: 0, ok: true, proof });
  }
  if ((req.method === "PATCH" || req.method === "POST") && url.pathname === "/api/rabilink/mobile/target") {
    const updated = patchMobileAppTarget(app, body?.targetDeviceId || body?.rabiGuid || "");
    return sendJson(res, 200, mobileStatePayload(updated));
  }
  if (url.pathname === "/api/rabilink/mobile/webgui") {
    return await handleMobileWebguiApi(req, url, res, body, app);
  }

  const routeMatch = url.pathname.match(/^\/api\/rabilink\/mobile\/routes(?:\/([^/]+)(?:\/(agent-options|agent-binding))?)?$/);
  if (!routeMatch) return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });

  const worker = mobileWorkerTarget(app, url, body);
  const rabiGuid = worker.guid || worker.id;
  const routeId = routeMatch[1] ? decodeURIComponent(routeMatch[1]) : "";
  const action = routeMatch[2] || "";
  if (req.method === "GET" && !routeId && !action) {
    const result = await mobileProxyJson(app, worker, "GET", `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes?includeProfiles=true&presentation=mobile`);
    return sendJson(res, result.statusCode, result.body);
  }
  if (req.method === "GET" && routeId && action === "agent-options") {
    const result = await mobileProxyJson(app, worker, "GET", `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes/${encodeURIComponent(routeId)}/agent-options`);
    return sendJson(res, result.statusCode, result.body);
  }
  if ((req.method === "PATCH" || req.method === "POST") && routeId && action === "agent-binding") {
    const mutationHeaders = mobileRouteMutationHeaders(req);
    const result = await mobileProxyJson(
      app,
      worker,
      "PATCH",
      `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes/${encodeURIComponent(routeId)}/agent-binding`,
      body || {},
      mutationHeaders
    );
    return sendJson(res, result.statusCode, result.body, result.headers);
  }
  return sendJson(res, 405, { code: -1, ok: false, message: "Method not allowed" });
}

async function handleManageWebgui(req, url, res) {
  const match = manageWebguiMatch(url);
  if (!match) return false;
  const auth = authorizeAdmin(req, url);
  if (!auth.ok) {
    if (req.method === "GET") return redirect(res, "/manage");
    return sendText(res, 401, "Unauthorized");
  }
  if (auth.account.username !== match.username) {
    const target = `/manage/${encodeURIComponent(auth.account.username)}`;
    if (req.method === "GET") return redirect(res, target);
    return sendText(res, 403, "Forbidden");
  }
  const target = resolveOwnedWebguiTarget(auth.account, match.targetRef, url);
  const externalPrefix = remoteWebguiPrefix(auth.account, match.targetRef);
  if (match.legacyWebgui && req.method === "GET") {
    const targetUrl = `${externalPrefix}${match.restPath === "/" ? "/" : match.restPath}${url.search}`;
    return redirect(res, targetUrl, 308);
  }
  if (!remoteWebguiManagerPath(match.restPath)) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method Not Allowed");
    return sendRemoteWebguiStatic(req, res, match, auth.account);
  }
  if (req.method === "GET" && webguiEventStreamPaths.has(match.restPath)) {
    return sendRemoteWebguiEvents(req, res, target, match.restPath);
  }
  const proxySearch = new URLSearchParams(url.searchParams);
  proxySearch.delete("appId");
  const localPath = `${match.restPath}${proxySearch.toString() ? `?${proxySearch}` : ""}`;
  const rawBody = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readRawBody(req);
  const proxyRequest = createWebguiRequest(req, target, localPath, rawBody);
  const finalRequest = await waitForWebguiRequest(proxyRequest, webguiRequestWaitMs);
  sendWebguiProxyResponse(res, finalRequest, externalPrefix);
  return true;
}

async function handleAdminApi(req, url, res) {
  const body = req.method === "GET" ? {} : await readBody(req);
  const apiPath = manageApiPath(url);
  if (req.method === "GET" && apiPath === "/state") {
    const auth = authorizeAdmin(req, url, body);
    if (!auth.ok && !auth.setupRequired) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
    const headers = auth.account ? { "set-cookie": manageSessionCookie(createManageSession(auth.account)) } : {};
    return sendJson(res, 200, accountStorePayload(auth.account), headers);
  }
  if (req.method === "POST" && apiPath === "/login") {
    const account = loginAccount(body);
    const session = createManageSession(account);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) }, { "set-cookie": manageSessionCookie(session) });
  }
  if (req.method === "POST" && apiPath === "/accounts") {
    const account = createAccount(body);
    const session = createManageSession(account);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) }, { "set-cookie": manageSessionCookie(session) });
  }
  if (req.method === "POST" && apiPath === "/logout") {
    return sendJson(res, 200, { code: 0, ok: true }, { "set-cookie": clearManageSessionCookie() });
  }
  const auth = authorizeAdmin(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  if (req.method === "GET" && apiPath === "/logs/stream") {
    return handleAccountLogStream(req, res, auth.account);
  }
  if (req.method === "POST" && apiPath === "/apps") {
    const app = createAppForAccount(auth.account, body);
    return sendJson(res, 200, { code: 0, ok: true, app: publicApp(app, { revealToken: true }) });
  }
  const deviceBindingMatch = apiPath.match(/^\/apps\/([^/]+)\/devices$/);
  if (deviceBindingMatch && req.method === "POST") {
    const { app, binding } = bindDeviceSerialToApp(auth.account, decodeURIComponent(deviceBindingMatch[1]), body);
    return sendJson(res, 200, {
      code: 0,
      ok: true,
      app: publicApp(app),
      device: {
        id: binding.id,
        serialPreview: binding.serialPreview,
        claimed: false,
        updatedAt: binding.updatedAt
      }
    });
  }
  if (req.method === "GET" && apiPath === "/logs") {
    return sendJson(res, 200, {
      code: 0,
      ok: true,
      logs: readAccountLogs(auth.account, url.searchParams.get("limit") || 120)
    });
  }
  if (req.method === "GET" && apiPath === "/device-logs") {
    const query = {
      limit: url.searchParams.get("limit") || 160,
      deviceId: url.searchParams.get("deviceId") || "",
      deviceKind: url.searchParams.get("deviceKind") || "",
      source: url.searchParams.get("source") || "",
      appId: url.searchParams.get("appId") || "",
      level: url.searchParams.get("level") || "",
      sessionId: url.searchParams.get("sessionId") || "",
      query: url.searchParams.get("query") || "",
      from: url.searchParams.get("from") || "",
      to: url.searchParams.get("to") || ""
    };
    const logs = readDeviceLogs({ directory: deviceLogDir, accountId: auth.account.id, ...query });
    const facetRows = readDeviceLogs({ directory: deviceLogDir, accountId: auth.account.id, limit: 500 });
    return sendJson(res, 200, {
      code: 0,
      ok: true,
      logs,
      facets: deviceLogFacets(facetRows)
    });
  }
  const appMatch = apiPath.match(/^\/apps\/([^/]+)$/);
  if (appMatch && req.method === "PATCH") {
    const { app, revealToken } = patchOwnedApp(auth.account, decodeURIComponent(appMatch[1]), body);
    return sendJson(res, 200, { code: 0, ok: true, app: publicApp(app, { revealToken }) });
  }
  if (appMatch && req.method === "DELETE") {
    deleteOwnedApp(auth.account, decodeURIComponent(appMatch[1]));
    return sendJson(res, 200, { code: 0, ok: true });
  }
  return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (url.pathname.startsWith("/manage/") && manageWebguiMatch(url)) {
      return await handleManageWebgui(req, url, res);
    }
    if (req.method === "GET" && (url.pathname === "/manage" || url.pathname === "/manage/" || /^\/manage\/[^/]+\/?$/.test(url.pathname))) {
      return sendHtml(res, adminPageHtml());
    }
    if (url.pathname.startsWith("/manage/api/")) {
      return await handleAdminApi(req, url, res);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      cleanupTasks();
      const store = readAppStore();
      return sendJson(res, 200, {
        code: 0,
        ok: true,
        name: "RabiLink Relay",
        time: nowIso(),
        admin: {
          url: "/manage",
          accounts: store.accounts.length,
          apps: store.apps.length,
          enabledApps: store.apps.filter((app) => app.enabled !== false).length,
          publicTokenConfigured: false,
          publicTokenAccepted: false
        },
        queue: {
          total: tasks.size,
          queued: [...tasks.values()].filter((task) => task.status === "queued").length,
          leased: [...tasks.values()].filter((task) => task.status === "leased").length,
          outbox: outboxMessages.length,
          outboxTtlMs,
          speech: speechRequests.counts()
        }
      });
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.json" || url.pathname === "/openapi/rokid-rabilink-plugin.json")) {
      return sendOpenApi(res);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.manual-auth.json" || url.pathname === "/openapi/rokid-rabilink-plugin.manual-auth.json")) {
      return sendOpenApi(res, manualAuthOpenApiFileCandidates);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.agent-token.json" || url.pathname === "/openapi/rokid-rabilink-plugin.agent-token.json")) {
      return sendOpenApi(res, agentTokenOpenApiFileCandidates);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/tools.postman.json" || url.pathname === "/openapi/rokid-rabilink-tools.postman.json")) {
      return sendOpenApi(res, toolImportPostmanFileCandidates);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/video/offer") {
      return handleDirectVideoOffer(req, url, res);
    }
    if (req.method === "GET" && (url.pathname === `${speechProxyPrefix}/openapi.json` || url.pathname === "/openapi/rabilink-speech-api.json")) {
      return sendOpenApi(res, speechOpenApiFileCandidates);
    }
    if (url.pathname === speechProxyPrefix || url.pathname.startsWith(`${speechProxyPrefix}/`)) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,authorization,x-rabilink-token");
      res.setHeader("access-control-max-age", "86400");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "cache-control": "no-store" });
        return res.end();
      }
      return await handleSpeechProxy(req, url, res);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/devices/media") {
      return await handleDeviceMediaUpload(req, url, res);
    }
    if (req.method === "GET" && /^\/api\/rabilink\/devices\/media\/[^/]+$/.test(url.pathname)) {
      return handleDeviceMediaDownload(req, url, res);
    }
    if (req.method === "GET" && url.pathname === "/api/rabilink/events") {
      return handleRelayEventStream(req, url, res);
    }
    const webguiWorkerResponse = /^\/worker\/webgui-requests\/[^/]+\/response$/.test(url.pathname);
    const webguiWorkerEvent = url.pathname === "/worker/webgui-events";
    const speechWorkerResponse = /^\/worker\/speech-requests\/[^/]+\/response$/.test(url.pathname);
    const personaSyncProxy = url.pathname === "/api/rabilink/persona-sync/proxy";
    const body = req.method === "GET"
      ? {}
      : await readBody(req, webguiWorkerResponse
        ? { maxBytes: webguiWorkerResponseMaxBytes, label: "WebGUI worker response" }
        : webguiWorkerEvent
          ? { maxBytes: webguiWorkerEventMaxBytes, label: "WebGUI worker event" }
          : speechWorkerResponse
            ? { maxBytes: speechWorkerResponseMaxBytes, label: "Speech worker response" }
            : personaSyncProxy
              ? { maxBytes: 32 * 1024 * 1024, label: "Persona sync proxy" }
              : {});
    if (req.method === "POST" && url.pathname === "/api/rabilink/devices/token") {
      const claimed = claimDeviceToken(body);
      return sendJson(res, 200, {
        code: 0,
        ok: true,
        token: claimed.token,
        app: claimed.app,
        device: claimed.device
      });
    }
    if (url.pathname === "/api/rabilink/mobile/state"
      || url.pathname === "/api/rabilink/mobile/device-status"
      || url.pathname === "/api/rabilink/mobile/proof"
      || url.pathname === "/api/rabilink/mobile/proofs"
      || url.pathname === "/api/rabilink/mobile/target"
      || url.pathname === "/api/rabilink/mobile/webgui"
      || url.pathname.startsWith("/api/rabilink/mobile/personas/")
      || url.pathname.startsWith("/api/rabilink/mobile/routes")) {
      return await handleMobileApi(req, url, res, body);
    }
    if (req.method === "POST" && (url.pathname === "/rokid/rabilink" || url.pathname === "/api/rokid/rabilink")) {
      return await handleRokid(req, url, res, body);
    }
    if (req.method === "POST" && (url.pathname === "/rokid/rabilink/tasks" || url.pathname === "/api/rokid/rabilink/tasks")) {
      return handleRokidCreateTask(req, url, res, body);
    }
    if (req.method === "POST" && (url.pathname === "/rokid/rabilink/input" || url.pathname === "/api/rokid/rabilink/input")) {
      return handleRokidInput(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/devices/input") {
      return handlePortableInput(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/devices/message-receipts") {
      return handlePortableMessageReceipt(req, url, res, body);
    }
    if (req.method === "GET" && url.pathname === "/api/rabilink/peers") {
      return handlePeerDiscovery(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/persona-sync/proxy") {
      return await handlePersonaSyncProxy(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/api/rabilink/devices/logs") {
      return handleDeviceLogs(req, url, res, body);
    }
    if (req.method === "GET" && /^\/rokid\/rabilink\/tasks\/[^/]+$/.test(url.pathname)) {
      return handleRokidTaskRead(req, url, res, body);
    }
    if (req.method === "GET" && /^\/rokid\/rabilink\/tasks\/[^/]+\/messages$/.test(url.pathname)) {
      return await handleRokidTaskMessages(req, url, res, body);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/messages" || url.pathname === "/api/rokid/rabilink/messages")) {
      return await handleRokidOutboxMessages(req, url, res, body, { defaultDeviceKind: "glasses" });
    }
    if (req.method === "GET" && url.pathname === "/api/rabilink/devices/messages") {
      return await handleRokidOutboxMessages(req, url, res, body, { requireDeviceIdentity: true });
    }
    if (req.method === "GET" && url.pathname === "/worker/tasks") {
      return await handleWorkerTasks(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/worker/messages") {
      return handleWorkerMessageAppend(req, url, res, body);
    }
    if (req.method === "GET" && url.pathname === "/worker/webgui-requests") {
      return await handleWorkerWebguiRequests(req, url, res, body);
    }
    if (req.method === "GET" && url.pathname === "/worker/speech-requests") {
      return await handleWorkerSpeechRequests(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/webgui-requests\/[^/]+\/response$/.test(url.pathname)) {
      return handleWorkerWebguiResponse(req, url, res, body);
    }
    if (req.method === "POST" && url.pathname === "/worker/webgui-events") {
      return handleWorkerWebguiEvent(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/speech-requests\/[^/]+\/response$/.test(url.pathname)) {
      return handleWorkerSpeechResponse(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/messages$/.test(url.pathname)) {
      return handleTaskMessagesAppend(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/finish$/.test(url.pathname)) {
      return handleTaskFinish(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/result$/.test(url.pathname)) {
      return handleTaskResult(req, url, res, body);
    }
    if (req.method === "GET" && /^\/worker\/tasks\/[^/]+$/.test(url.pathname)) {
      return handleTaskRead(req, url, res, body);
    }
    return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    const message = error instanceof Error ? error.message : String(error);
    writeEvent("request_error", { path: url.pathname, message });
    if (url.pathname === "/rokid/rabilink"
      || url.pathname === "/api/rokid/rabilink"
      || url.pathname.startsWith("/rokid/rabilink/")
      || url.pathname.startsWith("/api/rokid/rabilink/")) {
      return sendRabiLinkError(res, statusCode, message);
    }
    return sendJson(res, statusCode, { code: error?.code || -1, ok: false, message });
  }
});

server.listen(port, host, () => {
  console.log(`RabiLink Relay listening on http://${host}:${port}`);
  console.log(`Data dir: ${dataDir}`);
});
