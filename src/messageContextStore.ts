import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRabiLinkConversationTimeline } from "./rabilinkConversationLedger.js";
import type { SpeechTranscriptSegment } from "./shared/speechControlContract.js";
import { normalizeSpeechTranscriptSegment } from "./shared/speechTranscript.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

export const MESSAGE_CONTEXT_FILE = "message-context.jsonl";
export const MESSAGE_CONTEXT_DIR = "conversation";
export const MESSAGE_CONTEXT_CURRENT_FILE = "current.jsonl";
export const MESSAGE_CONTEXT_ARCHIVE_DIR = "archive";
export const MESSAGE_CONTEXT_ARCHIVE_INDEX_FILE = "index.json";
/** Message count is the default automatic-injection budget; callers may opt into an additional character cap. */
export const DEFAULT_MESSAGE_CONTEXT_MAX_CHARS = Number.MAX_SAFE_INTEGER;
export const DEFAULT_MESSAGE_CONTEXT_ARCHIVE_TRIGGER_OLDER_THAN_HOURS = 72;
export const DEFAULT_MESSAGE_CONTEXT_ARCHIVE_INCLUDE_OLDER_THAN_HOURS = 24;

const LOCK_FILE = ".message-context.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type MessageContextDirection = "inbound" | "outbound" | "system";

export type MessageContextAttachment = {
  id?: string;
  kind?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

export type MessageContextSpeechSegment = SpeechTranscriptSegment;

export type MessageContextRecord = {
  schemaVersion?: 1;
  id?: string;
  sequence?: number;
  recordedAt?: string;
  time: number;
  direction: MessageContextDirection;
  /** Logical message endpoint used for policy and recent-message limits. */
  adapter: string;
  /** Physical transport used to carry the logical endpoint, for example wearable over RabiLink. */
  transport?: string;
  gatewayId?: string;
  instanceId?: string;
  channel?: string;
  conversationKey?: string;
  kind?: string;
  status?: string;
  sender?: string;
  target?: string;
  text: string;
  messageId?: string | number;
  replyToMessageId?: string | number;
  sessionId?: string;
  routeProfileId?: string;
  source?: string;
  channelType?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  /** Transient capture-stream identity; never use this as a reply-device target. */
  sourceStreamId?: string;
  sourceArea?: string;
  sourceHostId?: string;
  sourceHostName?: string;
  provider?: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  audioFormat?: string;
  channels?: number;
  ingestedAt?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
  rms?: number;
  speakerId?: string;
  speakerName?: string;
  speakerKind?: string;
  speakerConfidence?: number;
  speakerDecision?: string;
  voiceprintId?: string;
  speakerVerified?: boolean;
  segments?: MessageContextSpeechSegment[];
  attachments?: MessageContextAttachment[];
};

export type MessageContextHistoryKind =
  | "group"
  | "private"
  | "wecom"
  | "feishu"
  | "voice"
  | "heartbeat"
  | "manual_trigger"
  | "role_panel";

export type MessageContextArchiveItem = {
  file: string;
  startedAt: string;
  endedAt: string;
  entryCount: number;
  firstSequence: number;
  lastSequence: number;
};

export type MessageContextArchiveIndex = {
  schemaVersion: 1;
  nextSequence: number;
  legacyImportedAt?: string;
  archives: MessageContextArchiveItem[];
};

export type AppendMessageContextOptions = {
  now?: number;
  archiveCheck?: boolean;
  triggerOlderThanHours?: number;
  includeOlderThanHours?: number;
};

export type AppendMessageContextResult = {
  record: MessageContextRecord;
  appended: boolean;
  archivedPath?: string;
};

export type RecentMessageContextQuery = {
  limit: number;
  adapter?: string;
  channel?: string;
  conversationKey?: string;
  /** Exclude events already represented elsewhere in the current Agent packet. */
  excludedMessageIds?: readonly string[];
  maxChars?: number;
  /** Archives are full-fidelity evidence and are opt-in, never automatic Agent context. */
  includeArchives?: boolean;
  /** Optional epoch-second window used to skip archive files before their bodies are read. */
  from?: number;
  to?: number;
};

type RecentMessageContextOptions = Omit<RecentMessageContextQuery, "limit">;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function messageText(value: unknown): string {
  return String(value ?? "").trim();
}

function oneLine(value: unknown): string {
  return messageText(value).replace(/\s+/g, " ");
}

function optionalText(value: unknown): string | undefined {
  return oneLine(value) || undefined;
}

function optionalId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return optionalText(value);
}

function timestamp(value: unknown): number {
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate / 1_000 : 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed >= 100_000_000_000 ? parsed / 1_000 : parsed;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeAttachmentName(value: unknown): string | undefined {
  const text = oneLine(value);
  if (!text) return undefined;
  const name = path.posix.basename(text.replace(/\\/g, "/"));
  return name.slice(0, 200) || undefined;
}

function safeAttachments(value: unknown): MessageContextAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.slice(0, 16).flatMap((entry) => {
    const item = objectValue(entry);
    const attachment: MessageContextAttachment = {
      id: optionalText(item.id ?? item.attachmentId),
      kind: optionalText(item.kind ?? item.type),
      name: safeAttachmentName(item.name ?? item.fileName),
      mimeType: optionalText(item.mimeType ?? item.contentType),
      size: optionalNumber(item.size)
    };
    return Object.values(attachment).some((field) => field != null) ? [attachment] : [];
  });
  return result.length > 0 ? result : undefined;
}

function safeSpeechSegments(value: unknown): MessageContextSpeechSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.slice(0, 10_000)
    .map((entry, index) => normalizeSpeechTranscriptSegment(entry, index))
    .filter((segment): segment is MessageContextSpeechSegment => Boolean(segment));
  return result.length ? result : undefined;
}

function attachmentOnlyText(attachments: MessageContextAttachment[] | undefined): string {
  if (!attachments?.length) return "";
  const labels = attachments.slice(0, 4).map((item) => item.name || item.kind || item.mimeType || "附件");
  const remainder = attachments.length > labels.length ? `，另有 ${attachments.length - labels.length} 个` : "";
  return `[附件消息] ${labels.join("、")}${remainder}`;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function atomicWrite(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, text, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function messageContextDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), MESSAGE_CONTEXT_DIR);
}

export function messageContextCurrentPath(dataDir: string): string {
  return path.join(messageContextDir(dataDir), MESSAGE_CONTEXT_CURRENT_FILE);
}

export function messageContextArchiveDir(dataDir: string): string {
  return path.join(messageContextDir(dataDir), MESSAGE_CONTEXT_ARCHIVE_DIR);
}

export function messageContextArchiveIndexPath(dataDir: string): string {
  return path.join(messageContextArchiveDir(dataDir), MESSAGE_CONTEXT_ARCHIVE_INDEX_FILE);
}

export function messageContextLockPath(dataDir: string): string {
  return path.join(messageContextDir(dataDir), LOCK_FILE);
}

function legacyContextPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), MESSAGE_CONTEXT_FILE);
}

function acquireLock(dataDir: string): () => void {
  const dir = messageContextDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = messageContextLockPath(dataDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs >= LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for message context lock: ${lockPath}`);
      Atomics.wait(lockWaitBuffer, 0, 0, 10);
    }
  }
}

function inferredChannel(adapter: string, kind: string | undefined, item: Record<string, unknown>): string {
  if (optionalText(item.channel)) return optionalText(item.channel)!;
  if (adapter === "rolePanel") return "rolePanel";
  if (adapter === "wecom") return "wecom";
  if (adapter === "weixin") return "weixin";
  if (["speech", "fennenote", "xiaoai"].includes(adapter) || kind === "asr" || kind === "tts") return adapter;
  if (adapter === "rabilink") return "rabilink";
  if (adapter === "heartbeat") return "heartbeat";
  if (adapter === "system") return kind === "manual_trigger" ? "manual" : "system";
  if (kind === "group" || item.groupId != null) return "napcat";
  if (kind === "private" || item.userId != null) return "napcat";
  return adapter;
}

export function resolveMessageConversationKey(input: {
  adapter: string;
  gatewayId?: unknown;
  instanceId?: unknown;
  channel?: string;
  conversationKey?: unknown;
  groupId?: unknown;
  userId?: unknown;
  conversationId?: unknown;
  chatId?: unknown;
  roleId?: unknown;
  routeProfileId?: unknown;
  sessionId?: unknown;
  sourceDeviceId?: unknown;
  sourceDeviceName?: unknown;
  source?: unknown;
  triggerId?: unknown;
  target?: unknown;
}): string {
  const explicit = optionalText(input.conversationKey);
  if (explicit) return explicit;
  const adapter = optionalText(input.adapter) || "unknown";
  const gatewayId = optionalText(input.gatewayId);
  const instanceId = optionalText(input.instanceId);
  const scope = [adapter, gatewayId ? `gateway:${gatewayId}` : "", instanceId ? `instance:${instanceId}` : ""]
    .filter(Boolean)
    .join(":");
  if (adapter === "napcat") {
    const groupId = optionalText(input.groupId);
    return groupId
      ? `${scope}:group:${groupId}`
      : `${scope}:private:${optionalText(input.userId ?? input.target) || "default"}`;
  }
  if (adapter === "wecom") {
    return `${scope}:${optionalText(input.conversationId ?? input.chatId ?? input.groupId ?? input.userId ?? input.target) || "default"}`;
  }
  if (adapter === "feishu") {
    return `${scope}:chat:${optionalText(input.chatId ?? input.groupId ?? input.target) || "default"}`;
  }
  if (adapter === "weixin") {
    return `${scope}:session:${optionalText(input.sessionId ?? input.userId ?? input.target) || "default"}`;
  }
  if (adapter === "rolePanel") {
    return `${scope}:${optionalText(input.roleId ?? input.routeProfileId ?? input.target) || "default"}`;
  }
  if (adapter === "heartbeat" || adapter === "system") {
    return `${scope}:${optionalText(input.channel) || "event"}:${optionalText(input.triggerId ?? input.target) || "default"}`;
  }
  const sessionId = optionalText(input.sessionId);
  if (sessionId) return `${scope}:session:${sessionId}`;
  const routeProfileId = optionalText(input.routeProfileId);
  if (routeProfileId) return `${scope}:route:${routeProfileId}`;
  const source = optionalText(input.sourceDeviceId ?? input.sourceDeviceName ?? input.source ?? input.target);
  return `${scope}:${optionalText(input.channel) || adapter}:${source || "default"}`;
}

function stableRecordId(record: MessageContextRecord): string {
  if (optionalText(record.id)) return optionalText(record.id)!;
  const scope = [record.gatewayId, record.instanceId, record.adapter, record.transport, record.conversationKey, record.direction]
    .map((item) => oneLine(item))
    .join("|");
  const identity = record.messageId == null
    ? `${scope}|${record.time}|${oneLine(record.text)}`
    : `${scope}|${record.messageId}`;
  return `message-context-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function normalizeRecord(record: MessageContextRecord, sequence?: number): MessageContextRecord | undefined {
  const attachments = safeAttachments(record.attachments);
  const text = messageText(record.text) || attachmentOnlyText(attachments);
  if (!text) return undefined;
  const time = timestamp(record.time) || Math.floor(Date.now() / 1_000);
  const adapter = optionalText(record.adapter) || "unknown";
  const portableVoiceIdentity = adapter === "speech" || adapter === "rabilink";
  const transport = optionalText(record.transport) || adapter;
  const gatewayId = optionalText(record.gatewayId);
  const instanceId = optionalText(record.instanceId);
  const channel = optionalText(record.channel) || inferredChannel(adapter, optionalText(record.kind), record as MessageContextRecord & Record<string, unknown>);
  const routeProfileId = optionalText(record.routeProfileId);
  const sessionId = optionalText(record.sessionId);
  const target = optionalText(record.target);
  const normalized: MessageContextRecord = {
    schemaVersion: 1,
    sequence: sequence ?? positiveInteger(record.sequence),
    recordedAt: optionalText(record.recordedAt) || new Date(time * 1_000).toISOString(),
    time,
    direction: record.direction === "outbound" || record.direction === "system" ? record.direction : "inbound",
    adapter,
    transport,
    gatewayId,
    instanceId,
    channel,
    conversationKey: resolveMessageConversationKey({
      adapter,
      gatewayId,
      instanceId,
      channel,
      conversationKey: record.conversationKey,
      routeProfileId,
      sessionId,
      sourceDeviceId: record.sourceDeviceId,
      sourceDeviceName: record.sourceDeviceName,
      source: record.source,
      target
    }),
    kind: optionalText(record.kind),
    status: optionalText(record.status) || (record.direction === "outbound" ? "sent" : record.direction === "system" ? "system" : "accepted"),
    sender: optionalText(record.sender),
    target,
    text,
    messageId: optionalId(record.messageId),
    replyToMessageId: optionalId(record.replyToMessageId),
    sessionId,
    routeProfileId,
    source: optionalText(record.source),
    channelType: optionalText(record.channelType),
    sourceDeviceId: optionalText(record.sourceDeviceId),
    sourceDeviceName: optionalText(record.sourceDeviceName),
    sourceDeviceKind: optionalText(record.sourceDeviceKind),
    sourceStreamId: optionalText(record.sourceStreamId),
    sourceArea: optionalText(record.sourceArea),
    sourceHostId: optionalText(record.sourceHostId),
    sourceHostName: optionalText(record.sourceHostName),
    provider: optionalText(record.provider),
    model: optionalText(record.model),
    language: optionalText(record.language),
    sampleRate: optionalNumber(record.sampleRate),
    audioFormat: optionalText(record.audioFormat),
    channels: optionalNumber(record.channels),
    ingestedAt: optionalText(record.ingestedAt),
    startedAt: optionalText(record.startedAt),
    endedAt: optionalText(record.endedAt),
    durationSeconds: optionalNumber(record.durationSeconds),
    peak: optionalNumber(record.peak),
    rms: optionalNumber(record.rms),
    speakerId: portableVoiceIdentity ? undefined : optionalText(record.speakerId),
    speakerName: portableVoiceIdentity ? undefined : optionalText(record.speakerName),
    speakerKind: portableVoiceIdentity ? undefined : optionalText(record.speakerKind),
    speakerConfidence: optionalNumber(record.speakerConfidence),
    speakerDecision: optionalText(record.speakerDecision),
    voiceprintId: optionalText(record.voiceprintId),
    speakerVerified: portableVoiceIdentity ? undefined : optionalBoolean(record.speakerVerified),
    segments: safeSpeechSegments(record.segments),
    attachments
  };
  normalized.id = stableRecordId({ ...normalized, id: record.id });
  return normalized;
}

function storedRecord(item: Record<string, unknown>): MessageContextRecord | undefined {
  const adapter = optionalText(item.adapter ?? item.adapterType) || "unknown";
  const transport = optionalText(item.transport) || adapter;
  const gatewayId = optionalText(item.gatewayId ?? item.runtimeRouteId);
  const instanceId = optionalText(item.instanceId);
  const kind = optionalText(item.kind);
  const channel = inferredChannel(adapter, kind, item);
  return normalizeRecord({
    id: optionalText(item.id),
    sequence: positiveInteger(item.sequence),
    recordedAt: optionalText(item.recordedAt),
    time: timestamp(item.time),
    direction: item.direction === "outbound" || item.direction === "system" ? item.direction : "inbound",
    adapter,
    transport,
    gatewayId,
    instanceId,
    channel,
    conversationKey: resolveMessageConversationKey({
      adapter,
      gatewayId,
      instanceId,
      channel,
      conversationKey: item.conversationKey,
      groupId: item.groupId,
      userId: item.userId,
      conversationId: item.conversationId,
      chatId: item.chatId,
      roleId: item.roleId,
      routeProfileId: item.routeProfileId,
      sessionId: item.sessionId,
      sourceDeviceId: item.sourceDeviceId,
      sourceDeviceName: item.sourceDeviceName,
      source: item.source,
      triggerId: item.triggerId,
      target: item.target
    }),
    kind,
    status: optionalText(item.status),
    sender: optionalText(item.sender),
    target: optionalText(item.target),
    text: messageText(item.text),
    messageId: optionalId(item.messageId),
    replyToMessageId: optionalId(item.replyToMessageId),
    sessionId: optionalText(item.sessionId),
    routeProfileId: optionalText(item.routeProfileId),
    source: optionalText(item.source),
    channelType: optionalText(item.channelType),
    sourceDeviceId: optionalText(item.sourceDeviceId),
    sourceDeviceName: optionalText(item.sourceDeviceName),
    sourceDeviceKind: optionalText(item.sourceDeviceKind),
    sourceStreamId: optionalText(item.sourceStreamId),
    sourceArea: optionalText(item.sourceArea),
    sourceHostId: optionalText(item.sourceHostId),
    sourceHostName: optionalText(item.sourceHostName),
    provider: optionalText(item.provider),
    model: optionalText(item.model),
    language: optionalText(item.language),
    sampleRate: optionalNumber(item.sampleRate),
    audioFormat: optionalText(item.audioFormat),
    channels: optionalNumber(item.channels),
    ingestedAt: optionalText(item.ingestedAt),
    startedAt: optionalText(item.startedAt),
    endedAt: optionalText(item.endedAt),
    durationSeconds: optionalNumber(item.durationSeconds),
    peak: optionalNumber(item.peak),
    rms: optionalNumber(item.rms),
    speakerId: optionalText(item.speakerId),
    speakerName: optionalText(item.speakerName),
    speakerKind: optionalText(item.speakerKind),
    speakerConfidence: optionalNumber(item.speakerConfidence),
    speakerDecision: optionalText(item.speakerDecision),
    voiceprintId: optionalText(item.voiceprintId ?? item.voiceprintProfileId),
    speakerVerified: optionalBoolean(item.speakerVerified),
    segments: safeSpeechSegments(item.segments),
    attachments: safeAttachments(item.attachments)
  }, positiveInteger(item.sequence));
}

function recordsFromFile(filePath: string): MessageContextRecord[] {
  return parseJsonl(filePath).flatMap((item) => {
    const record = storedRecord(item);
    return record ? [record] : [];
  });
}

function archiveItemFromFile(filePath: string): MessageContextArchiveItem | undefined {
  const records = recordsFromFile(filePath);
  const first = records[0];
  const last = records[records.length - 1];
  const firstSequence = positiveInteger(first?.sequence);
  const lastSequence = positiveInteger(last?.sequence);
  if (!first || !last || !firstSequence || !lastSequence) return undefined;
  return {
    file: path.basename(filePath),
    startedAt: first.recordedAt!,
    endedAt: last.recordedAt!,
    entryCount: records.length,
    firstSequence,
    lastSequence
  };
}

type ArchiveSequenceRange = Pick<MessageContextArchiveItem, "file" | "firstSequence" | "lastSequence">;

function archiveRangeFromFileName(file: string): ArchiveSequenceRange | undefined {
  const match = path.basename(file).match(/^(\d+)~(\d+)\.jsonl$/i);
  const firstSequence = positiveInteger(match?.[1]);
  const lastSequence = positiveInteger(match?.[2]);
  if (!firstSequence || !lastSequence || lastSequence < firstSequence) return undefined;
  return { file: path.basename(file), firstSequence, lastSequence };
}

function archiveRangeContains(container: ArchiveSequenceRange, item: ArchiveSequenceRange): boolean {
  return container.firstSequence <= item.firstSequence && container.lastSequence >= item.lastSequence;
}

function compactContainedArchives<T extends ArchiveSequenceRange>(items: T[]): T[] {
  return items.filter((item, index) => !items.some((candidate, candidateIndex) => (
    candidateIndex !== index
    && archiveRangeContains(candidate, item)
    && (
      candidate.firstSequence < item.firstSequence
      || candidate.lastSequence > item.lastSequence
      || candidate.file.localeCompare(item.file) < 0
    )
  )));
}

function discoveredArchives(dataDir: string, knownArchives: readonly MessageContextArchiveItem[] = []): MessageContextArchiveItem[] {
  const archiveDir = messageContextArchiveDir(dataDir);
  if (!fs.existsSync(archiveDir)) return [];
  const knownFiles = new Set(knownArchives.map((item) => path.basename(item.file)));
  const candidates = compactContainedArchives(fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter((item) => item.isFile() && !knownFiles.has(item.name))
    .flatMap((item) => {
      const range = archiveRangeFromFileName(item.name);
      if (!range || knownArchives.some((known) => archiveRangeContains(known, range))) return [];
      return [range];
    }));
  return candidates.flatMap((item) => {
      try {
        const archive = archiveItemFromFile(path.join(archiveDir, item.file));
        return archive ? [archive] : [];
      } catch {
        return [];
      }
    });
}

function sortArchives(items: MessageContextArchiveItem[]): MessageContextArchiveItem[] {
  return compactContainedArchives(items).sort((left, right) => (
    left.firstSequence - right.firstSequence || left.lastSequence - right.lastSequence
  ));
}

function compareRecords(left: MessageContextRecord, right: MessageContextRecord): number {
  const leftSequence = positiveInteger(left.sequence);
  const rightSequence = positiveInteger(right.sequence);
  if (leftSequence && rightSequence && leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (left.time !== right.time) return left.time - right.time;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

export function readMessageContextArchiveIndex(dataDir: string): MessageContextArchiveIndex {
  let raw: Partial<MessageContextArchiveIndex> = {};
  try {
    raw = JSON.parse(fs.readFileSync(messageContextArchiveIndexPath(dataDir), "utf8")) as Partial<MessageContextArchiveIndex>;
  } catch {
    raw = {};
  }
  const indexed = Array.isArray(raw.archives)
    ? raw.archives.filter((item): item is MessageContextArchiveItem => Boolean(
      item && typeof item.file === "string" && typeof item.startedAt === "string" && typeof item.endedAt === "string"
      && positiveInteger(item.entryCount) && positiveInteger(item.firstSequence) && positiveInteger(item.lastSequence)
    ))
    : [];
  const byFile = new Map(indexed.map((item) => [path.basename(item.file), { ...item, file: path.basename(item.file) }]));
  for (const item of discoveredArchives(dataDir, [...byFile.values()])) byFile.set(item.file, item);
  const archives = sortArchives([...byFile.values()]);
  const currentLastSequence = Math.max(0, ...recordsFromFile(messageContextCurrentPath(dataDir))
    .map((item) => positiveInteger(item.sequence) || 0));
  const discoveredNext = Math.max(currentLastSequence, ...archives.map((item) => item.lastSequence), 0) + 1;
  return {
    schemaVersion: 1,
    nextSequence: Math.max(1, positiveInteger(raw.nextSequence) || 1, discoveredNext),
    legacyImportedAt: optionalText(raw.legacyImportedAt),
    archives
  };
}

function writeIndex(dataDir: string, index: MessageContextArchiveIndex): void {
  atomicWrite(messageContextArchiveIndexPath(dataDir), `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: Math.max(1, index.nextSequence),
    legacyImportedAt: index.legacyImportedAt,
    archives: sortArchives(index.archives)
  } satisfies MessageContextArchiveIndex, null, 2)}\n`);
}

function writeCurrent(dataDir: string, records: MessageContextRecord[]): void {
  atomicWrite(messageContextCurrentPath(dataDir), records.map((item) => JSON.stringify(item)).join("\n") + (records.length ? "\n" : ""));
}

function dedupeKey(item: MessageContextRecord): string {
  return item.id || stableRecordId(item);
}

function dedupeRecords(records: MessageContextRecord[]): MessageContextRecord[] {
  const byId = new Map<string, MessageContextRecord>();
  for (const record of [...records].sort(compareRecords)) {
    if (!byId.has(dedupeKey(record))) byId.set(dedupeKey(record), record);
  }
  return [...byId.values()].sort(compareRecords);
}

function migrateLegacyIfNeeded(dataDir: string, index: MessageContextArchiveIndex): MessageContextRecord[] {
  const current = recordsFromFile(messageContextCurrentPath(dataDir));
  if (index.legacyImportedAt) return current;
  const migrated = dedupeRecords([...legacyItems(dataDir), ...current]);
  let sequence = Math.max(1, ...index.archives.map((item) => item.lastSequence + 1));
  const sequenced = migrated.map((item) => normalizeRecord(item, sequence++)!).filter(Boolean);
  writeCurrent(dataDir, sequenced);
  index.nextSequence = sequence;
  index.legacyImportedAt = new Date().toISOString();
  return sequenced;
}

function findExistingRecord(
  dataDir: string,
  index: MessageContextArchiveIndex,
  current: MessageContextRecord[],
  candidate: MessageContextRecord
): MessageContextRecord | undefined {
  const key = dedupeKey(candidate);
  const currentMatch = current.find((item) => dedupeKey(item) === key);
  if (currentMatch) return currentMatch;
  for (const archive of [...index.archives].reverse()) {
    const archived = recordsFromFile(path.join(messageContextArchiveDir(dataDir), path.basename(archive.file)))
      .find((item) => dedupeKey(item) === key);
    if (archived) return archived;
  }
  return undefined;
}

function archiveEligiblePrefix(
  dataDir: string,
  index: MessageContextArchiveIndex,
  records: MessageContextRecord[],
  options: AppendMessageContextOptions
): { records: MessageContextRecord[]; archivedPath?: string } {
  if (options.archiveCheck === false || records.length === 0) return { records };
  const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const triggerHours = Math.max(1, Number(options.triggerOlderThanHours) || DEFAULT_MESSAGE_CONTEXT_ARCHIVE_TRIGGER_OLDER_THAN_HOURS);
  const includeHours = Math.max(1, Number(options.includeOlderThanHours) || DEFAULT_MESSAGE_CONTEXT_ARCHIVE_INCLUDE_OLDER_THAN_HOURS);
  const triggerBefore = (nowMs - triggerHours * 60 * 60 * 1_000) / 1_000;
  if (!records.some((item) => item.time <= triggerBefore)) return { records };
  const includeBefore = (nowMs - includeHours * 60 * 60 * 1_000) / 1_000;
  let prefixLength = 0;
  while (prefixLength < records.length && records[prefixLength].time <= includeBefore) prefixLength += 1;
  if (prefixLength === 0) return { records };
  const archived = records.slice(0, prefixLength);
  const remaining = records.slice(prefixLength);
  const firstSequence = positiveInteger(archived[0]?.sequence);
  const lastSequence = positiveInteger(archived[archived.length - 1]?.sequence);
  if (!firstSequence || !lastSequence) return { records };
  const archiveDir = messageContextArchiveDir(dataDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedPath = path.join(archiveDir, `${firstSequence}~${lastSequence}.jsonl`);
  if (!fs.existsSync(archivedPath)) {
    atomicWrite(archivedPath, archived.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
  index.archives = sortArchives([
    ...index.archives.filter((item) => path.basename(item.file) !== path.basename(archivedPath)),
    {
      file: path.basename(archivedPath),
      startedAt: archived[0].recordedAt!,
      endedAt: archived[archived.length - 1].recordedAt!,
      entryCount: archived.length,
      firstSequence,
      lastSequence
    }
  ]);
  writeCurrent(dataDir, remaining);
  return { records: remaining, archivedPath };
}

export function appendMessageContextToDir(
  dataDir: string,
  input: MessageContextRecord,
  options: AppendMessageContextOptions = {}
): AppendMessageContextResult | undefined {
  const release = acquireLock(dataDir);
  try {
    const index = readMessageContextArchiveIndex(dataDir);
    let current = migrateLegacyIfNeeded(dataDir, index);
    const archived = archiveEligiblePrefix(dataDir, index, current, options);
    current = archived.records;
    const candidate = normalizeRecord(input, index.nextSequence);
    if (!candidate) return undefined;
    const existing = findExistingRecord(dataDir, index, current, candidate);
    if (existing) {
      writeIndex(dataDir, index);
      recordDataMutationAudit({
        group: "conversation",
        event: "message_context_replayed",
        owner: "message-context",
        action: "append",
        target: { type: "message-context", id: existing.id ?? dedupeKey(existing) },
        dataSource: { kind: "ledger", id: `${MESSAGE_CONTEXT_DIR}/${MESSAGE_CONTEXT_CURRENT_FILE}` },
        outcome: "replayed",
        after: existing.sequence ? { revision: String(existing.sequence) } : undefined,
        result: archived.archivedPath ? "archive_rotated" : undefined
      });
      return { record: existing, appended: false, archivedPath: archived.archivedPath };
    }
    try {
      fs.mkdirSync(path.dirname(messageContextCurrentPath(dataDir)), { recursive: true });
      fs.appendFileSync(messageContextCurrentPath(dataDir), `${JSON.stringify(candidate)}\n`, "utf8");
      index.nextSequence += 1;
      writeIndex(dataDir, index);
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "conversation",
        event: "message_context_append_failed",
        owner: "message-context",
        action: "append",
        target: { type: "message-context", id: candidate.id ?? dedupeKey(candidate) },
        dataSource: { kind: "ledger", id: `${MESSAGE_CONTEXT_DIR}/${MESSAGE_CONTEXT_CURRENT_FILE}` },
        outcome: "failed",
        after: candidate.sequence ? { revision: String(candidate.sequence) } : undefined,
        result: "current_or_index_write_failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "conversation",
      event: "message_context_appended",
      owner: "message-context",
      action: "append",
      target: { type: "message-context", id: candidate.id ?? dedupeKey(candidate) },
      dataSource: { kind: "ledger", id: `${MESSAGE_CONTEXT_DIR}/${MESSAGE_CONTEXT_CURRENT_FILE}` },
      outcome: "committed",
      after: candidate.sequence ? { revision: String(candidate.sequence) } : undefined,
      result: archived.archivedPath ? "archive_rotated" : undefined,
      changes: [{ field: "attachmentCount", to: candidate.attachments?.length ?? 0 }]
    });
    return { record: candidate, appended: true, archivedPath: archived.archivedPath };
  } finally {
    release();
  }
}

export function messageContextFromHistoryRecord(
  historyKind: MessageContextHistoryKind,
  rawRecord: unknown,
  adapterOverride?: string
): MessageContextRecord | undefined {
  const item = objectValue(rawRecord);
  const text = messageText(item.rawMessage ?? item.text);
  const time = timestamp(item.time);
  const self = item.isSelf === true || item.direction === "assistant" || item.direction === "agent";
  const routeProfileId = optionalText(item.routeProfileId);
  const sessionId = optionalText(item.sessionId);
  const gatewayId = optionalText(item.gatewayId ?? item.runtimeRouteId);
  const instanceId = optionalText(item.instanceId);
  const transport = optionalText(item.transport);
  const messageId = optionalId(item.messageId ?? item.id);
  const replyToMessageId = optionalId(item.repliedMessageId ?? item.replyToMessageId);
  if (historyKind === "role_panel" || item.adapterType === "rolePanel" || item.roleId != null) {
    const roleId = optionalText(item.roleId);
    return normalizeRecord({ time, direction: self ? "outbound" : "inbound", adapter: "rolePanel", transport: transport || "rolePanel",
      gatewayId, instanceId, channel: "rolePanel",
      conversationKey: resolveMessageConversationKey({ adapter: "rolePanel", gatewayId, instanceId, roleId, routeProfileId }), kind: "message",
      status: optionalText(item.status) || (self ? "sent" : "accepted"), sender: optionalText(item.sender ?? item.senderName) || (self ? "Agent" : "User"),
      target: roleId, text, messageId, replyToMessageId, routeProfileId, attachments: safeAttachments(item.attachments) });
  }
  if (historyKind === "group" || historyKind === "private") {
    const adapter = optionalText(item.adapterType) || adapterOverride || "napcat";
    const group = historyKind === "group";
    const target = optionalText(group ? item.groupId : item.userId);
    return normalizeRecord({ time, direction: self ? "outbound" : "inbound", adapter, transport: transport || adapter,
      gatewayId, instanceId, channel: adapter,
      conversationKey: resolveMessageConversationKey({ adapter, gatewayId, instanceId, groupId: group ? item.groupId : undefined, userId: group ? undefined : item.userId, sessionId: item.sessionId }),
      kind: historyKind, status: self ? "sent" : "accepted", sender: optionalText(self ? item.botNickname ?? item.senderName : item.senderName ?? item.userId),
      target, text, messageId, replyToMessageId, attachments: safeAttachments(item.attachments ?? item.segments) });
  }
  if (historyKind === "wecom") {
    const target = optionalText(item.conversationId ?? item.chatId ?? item.groupId ?? item.userId);
    return normalizeRecord({ time, direction: self ? "outbound" : "inbound", adapter: "wecom", transport: transport || "wecom",
      gatewayId, instanceId, channel: "wecom",
      conversationKey: resolveMessageConversationKey({ adapter: "wecom", gatewayId, instanceId, conversationId: item.conversationId, chatId: item.chatId, groupId: item.groupId, userId: item.userId }),
      kind: optionalText(item.messageType) || "message", status: self ? "sent" : "accepted", sender: optionalText(item.senderName ?? item.senderId ?? item.userId),
      target, text, messageId, replyToMessageId, attachments: safeAttachments(item.attachments ?? item.segments) });
  }
  if (historyKind === "feishu") {
    const target = optionalText(item.chatId ?? item.groupId);
    return normalizeRecord({ time, direction: self ? "outbound" : "inbound", adapter: "feishu", transport: transport || "feishu",
      gatewayId, instanceId, channel: "feishu",
      conversationKey: resolveMessageConversationKey({ adapter: "feishu", gatewayId, instanceId, chatId: item.chatId, groupId: item.groupId }),
      kind: optionalText(item.messageType) || "message", status: self ? "sent" : "accepted", sender: optionalText(item.senderName ?? item.userId),
      target, text, messageId, replyToMessageId, attachments: safeAttachments(item.attachments ?? item.segments) });
  }
  if (historyKind === "voice") {
    const outbound = self || item.kind === "tts";
    const adapter = optionalText(item.adapterType) || adapterOverride || "speech";
    const target = optionalText(item.sourceDeviceName ?? item.sourceDeviceId ?? item.routeProfileId ?? item.source);
    return normalizeRecord({ time, direction: outbound ? "outbound" : "inbound", adapter, transport: transport || adapter,
      gatewayId, instanceId, channel: adapter,
      conversationKey: resolveMessageConversationKey({ adapter, gatewayId, instanceId, routeProfileId, sessionId, sourceDeviceId: item.sourceDeviceId, sourceDeviceName: item.sourceDeviceName, source: item.source }),
      kind: optionalText(item.kind) || (outbound ? "tts" : "asr"), status: outbound ? "sent" : "accepted",
      sender: optionalText(item.senderName ?? item.source) || (outbound ? "Agent" : undefined), target, text, messageId,
      replyToMessageId, sessionId, routeProfileId,
      source: optionalText(item.source), channelType: optionalText(item.channelType),
      sourceDeviceId: optionalText(item.sourceDeviceId), sourceDeviceName: optionalText(item.sourceDeviceName),
      sourceDeviceKind: optionalText(item.sourceDeviceKind), sourceStreamId: optionalText(item.sourceStreamId),
      sourceArea: optionalText(item.sourceArea),
      sourceHostId: optionalText(item.sourceHostId), sourceHostName: optionalText(item.sourceHostName),
      provider: optionalText(item.provider), model: optionalText(item.model), language: optionalText(item.language),
      sampleRate: optionalNumber(item.sampleRate), audioFormat: optionalText(item.audioFormat), channels: optionalNumber(item.channels),
      ingestedAt: optionalText(item.ingestedAt), startedAt: optionalText(item.startedAt), endedAt: optionalText(item.endedAt),
      durationSeconds: optionalNumber(item.durationSeconds), peak: optionalNumber(item.peak), rms: optionalNumber(item.rms),
      speakerId: optionalText(item.speakerId), speakerName: optionalText(item.speakerName), speakerKind: optionalText(item.speakerKind),
      speakerConfidence: optionalNumber(item.speakerConfidence), speakerDecision: optionalText(item.speakerDecision),
      voiceprintId: optionalText(item.voiceprintId ?? item.voiceprintProfileId), speakerVerified: optionalBoolean(item.speakerVerified),
      segments: safeSpeechSegments(item.segments),
      attachments: safeAttachments(item.attachments) });
  }
  const manual = historyKind === "manual_trigger";
  const channel = manual ? "manual" : "heartbeat";
  const target = optionalText(manual ? item.triggerId ?? item.triggerName : "heartbeat");
  const adapter = manual ? "system" : "heartbeat";
  return normalizeRecord({ time, direction: "system", adapter, transport: transport || "internal", gatewayId, instanceId, channel,
    conversationKey: resolveMessageConversationKey({ adapter, gatewayId, instanceId, channel, triggerId: item.triggerId, target }), kind: historyKind,
    status: "accepted", sender: optionalText(item.senderName) || "RabiRoute", target, text, messageId });
}

const successfulOutboxEvents = new Set([
  "reply_sent", "group_file_uploaded", "group_file_caption_sent", "wecom_reply_sent", "weixin_reply_sent", "feishu_reply_sent", "rabispeech_tts_sent",
  "fennenote_playback_sent", "fennenote_reply_sent", "role_panel_reply_sent", "rabilink_reply_queued",
  "rabilink_proactive_queued", "agent_reply_retained"
]);

function outboxAdapter(event: string, data: Record<string, unknown>): string {
  if (event.startsWith("wecom_")) return "wecom";
  if (event.startsWith("weixin_")) return "weixin";
  if (event.startsWith("feishu_")) return "feishu";
  if (event.startsWith("rabispeech_")) return "speech";
  if (event.startsWith("fennenote_")) return "fennenote";
  if (event.startsWith("role_panel_")) return "rolePanel";
  if (event.startsWith("rabilink_")) return "rabilink";
  if (event === "agent_reply_retained") {
    return optionalText(data.logicalAdapter ?? data.adapterType)
      || (optionalText(data.targetType) === "voice_transcript" ? "speech" : "napcat");
  }
  return optionalText(data.adapterType) || "napcat";
}

export function messageContextFromOutboxEvent(event: string, message: string, rawData: unknown, time = Math.floor(Date.now() / 1_000)): MessageContextRecord | undefined {
  if (!successfulOutboxEvents.has(event)) return undefined;
  const data = objectValue(rawData);
  const text = messageText(data.text ?? message);
  if (event === "role_panel_reply_sent" && text === "Sent to role panel timeline." && !safeAttachments(data.attachments)?.length) return undefined;
  const adapter = outboxAdapter(event, data);
  const transport = optionalText(data.transport) || adapter;
  const gatewayId = optionalText(data.gatewayId ?? data.runtimeRouteId);
  const instanceId = optionalText(data.instanceId);
  const targetType = optionalText(data.targetType);
  const target = optionalText(targetType === "group" ? data.groupId : targetType === "private" ? data.userId : data.roleId ?? data.routeProfileId ?? data.groupId ?? data.userId);
  const routeProfileId = optionalText(data.routeProfileId);
  const sessionId = optionalText(data.sessionId);
  return normalizeRecord({ time, direction: "outbound", adapter, transport, gatewayId, instanceId, channel: adapter,
    conversationKey: resolveMessageConversationKey({ adapter, gatewayId, instanceId, conversationKey: data.conversationKey, groupId: data.groupId, userId: data.userId,
      conversationId: data.conversationId, chatId: data.chatId, roleId: data.roleId, routeProfileId, sessionId, target }),
    kind: optionalText(data.payloadKind ?? data.payloadType) || (event === "rabispeech_tts_sent" ? "tts" : event),
    status: event.startsWith("rabilink_") ? "sent" : event === "agent_reply_retained" ? "retained" : "sent", sender: "Agent", target, text,
    messageId: optionalId(data.sentMessageId ?? data.sentFileId ?? data.deliveryId), replyToMessageId: optionalId(data.messageId), sessionId, routeProfileId,
    speakerId: optionalText(data.speakerId), speakerName: optionalText(data.speakerName), speakerKind: optionalText(data.speakerKind),
    speakerConfidence: optionalNumber(data.speakerConfidence), speakerDecision: optionalText(data.speakerDecision),
    voiceprintId: optionalText(data.voiceprintId ?? data.voiceprintProfileId), speakerVerified: optionalBoolean(data.speakerVerified),
    attachments: safeAttachments(data.attachments) });
}

function legacyHistoryItems(dataDir: string): MessageContextRecord[] {
  const read = (fileName: string, kind: MessageContextHistoryKind, adapter?: string) => parseJsonl(path.join(dataDir, fileName)).flatMap((item) => {
    const record = messageContextFromHistoryRecord(kind, item, adapter);
    return record ? [record] : [];
  });
  return [
    ...read("group-messages.jsonl", "group"), ...read("private-messages.jsonl", "private"), ...read("wecom-messages.jsonl", "wecom"), ...read("weixin-messages.jsonl", "private", "weixin"), ...read("feishu-messages.jsonl", "feishu"),
    ...read("voice-transcripts.jsonl", "voice"), ...read("heartbeat-events.jsonl", "heartbeat"), ...read("manual-trigger-events.jsonl", "manual_trigger")
  ];
}

function legacyOutboxItems(dataDir: string): MessageContextRecord[] {
  return parseJsonl(path.join(dataDir, "outbox-adapter.log.jsonl")).flatMap((item) => {
    const data = objectValue(item.data);
    const record = messageContextFromOutboxEvent(oneLine(item.event), messageText(data.text ?? item.message), data, timestamp(item.time));
    return record ? [record] : [];
  });
}

function rolePanelItems(dataDir: string): MessageContextRecord[] {
  return parseJsonl(path.join(dataDir, "role-panel", "messages.jsonl")).flatMap((item) => {
    const record = messageContextFromHistoryRecord("role_panel", { ...item, rawMessage: item.text, isSelf: item.direction === "assistant" || item.direction === "agent" });
    return record ? [record] : [];
  });
}

function rabiLinkItems(dataDir: string): MessageContextRecord[] {
  return readRabiLinkConversationTimeline(dataDir).flatMap((entry) => {
    const item = entry as unknown as Record<string, unknown>;
    const text = messageText(entry.text);
    const outbound = ["agent_to_user", "assistant", "outbound"].includes(oneLine(entry.direction));
    const routeProfileId = optionalText(entry.routeProfileId);
    const sessionId = optionalText(entry.sessionId);
    const logicalAdapter = optionalText(item.adapterType) || (optionalText(entry.sourceDeviceKind) === "wearable" ? "wearable" : "rabilink");
    const record = normalizeRecord({ time: timestamp(entry.time ?? entry.recordedAt), direction: outbound ? "outbound" : "inbound",
      adapter: logicalAdapter, transport: optionalText(entry.transport) || "rabilink", channel: logicalAdapter,
      conversationKey: resolveMessageConversationKey({ adapter: logicalAdapter, routeProfileId, sessionId,
        sourceDeviceId: entry.sourceDeviceId, sourceDeviceName: entry.sourceDeviceName }), kind: optionalText(entry.kind) || "message",
      status: outbound ? "sent" : "accepted", sender: optionalText(entry.sender ?? entry.source) || (outbound ? "Agent" : "User"),
      target: routeProfileId, text, messageId: optionalId(entry.messageId ?? entry.entryId), replyToMessageId: optionalId(entry.taskId),
      sessionId, routeProfileId, attachments: safeAttachments(entry.attachments) });
    return record ? [record] : [];
  });
}

function legacyItems(dataDir: string): MessageContextRecord[] {
  return [
    ...recordsFromFile(legacyContextPath(dataDir)),
    ...legacyHistoryItems(dataDir),
    ...legacyOutboxItems(dataDir),
    ...rolePanelItems(dataDir),
    ...rabiLinkItems(dataDir)
  ];
}

function archiveOverlapsQuery(item: MessageContextArchiveItem, query: RecentMessageContextQuery): boolean {
  const startedAt = Date.parse(item.startedAt) / 1_000;
  const endedAt = Date.parse(item.endedAt) / 1_000;
  if (Number.isFinite(query.from) && Number.isFinite(endedAt) && endedAt < Number(query.from)) return false;
  if (Number.isFinite(query.to) && Number.isFinite(startedAt) && startedAt > Number(query.to)) return false;
  return true;
}

function archiveRecords(dataDir: string, query: RecentMessageContextQuery): MessageContextRecord[] {
  return readMessageContextArchiveIndex(dataDir).archives
    .filter(item => archiveOverlapsQuery(item, query))
    .flatMap((item) => recordsFromFile(path.join(messageContextArchiveDir(dataDir), path.basename(item.file))));
}

function normalizeQuery(limitOrQuery: number | RecentMessageContextQuery, options: RecentMessageContextOptions): RecentMessageContextQuery {
  return typeof limitOrQuery === "number" ? { limit: limitOrQuery, ...options } : limitOrQuery;
}

function charCost(item: MessageContextRecord): number {
  return item.text.length + (item.segments?.reduce((total, segment) => total + segment.text.length + 40, 0) ?? 0) + 160;
}

export function recentMessageContextItems(dataDirs: string[], limitOrQuery: number | RecentMessageContextQuery, options: RecentMessageContextOptions = {}): MessageContextRecord[] {
  const query = normalizeQuery(limitOrQuery, options);
  const limit = Math.max(0, Math.floor(query.limit));
  if (limit === 0) return [];
  const maxChars = Math.max(1, Math.floor(query.maxChars ?? DEFAULT_MESSAGE_CONTEXT_MAX_CHARS));
  const dirs = [...new Set(dataDirs.filter(Boolean).map((item) => path.resolve(item)))];
  const all = dirs.flatMap((dataDir) => {
    const indexExists = fs.existsSync(messageContextArchiveIndexPath(dataDir));
    const current = recordsFromFile(messageContextCurrentPath(dataDir));
    const compatibleCurrent = indexExists || current.length ? current : legacyItems(dataDir);
    return query.includeArchives ? [...archiveRecords(dataDir, query), ...compatibleCurrent] : compatibleCurrent;
  });
  const filtered = dedupeRecords(all).filter((item) =>
    (!query.adapter || item.adapter === query.adapter)
    && (!query.channel || item.channel === query.channel)
    && (!query.conversationKey || item.conversationKey === query.conversationKey)
    && (!Number.isFinite(query.from) || item.time >= Number(query.from))
    && (!Number.isFinite(query.to) || item.time <= Number(query.to))
    && (!query.excludedMessageIds?.length || !query.excludedMessageIds.includes(String(item.messageId ?? "")))
  );
  const selected: MessageContextRecord[] = [];
  let chars = 0;
  for (let index = filtered.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const item = filtered[index];
    const cost = charCost(item);
    if (selected.length > 0 && chars + cost > maxChars) continue;
    selected.push(item);
    chars += cost;
  }
  return selected.reverse();
}

function formatTime(value: number): string {
  return value ? new Date(value * 1_000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export function formatMessageContextItem(item: MessageContextRecord): string {
  const direction = item.direction === "outbound" ? "出站" : item.direction === "system" ? "系统" : "入站";
  const participants = [item.sender, item.target ? `→ ${item.target}` : ""].filter(Boolean).join(" ");
  const ids = [item.messageId == null ? "" : `messageId=${item.messageId}`, item.replyToMessageId == null ? "" : `replyTo=${item.replyToMessageId}`].filter(Boolean).join(" | ");
  const speakerTurns = item.segments?.length
    ? item.segments.map(segment => {
        const speaker = segment.voiceprintId
          || segment.speakerClusterId
          || segment.speakerLabel
          || segment.speaker
          || "未知声纹";
        return `${speaker}：${segment.text}`;
      }).join("\n  ")
    : "";
  const body = speakerTurns || item.text;
  const host = item.sourceHostName || item.sourceHostId;
  return `- ${formatTime(item.time)} | ${direction} | ${item.channel || item.adapter}/${item.kind || "message"} | ${item.status || "accepted"}${host ? ` | host=${host}` : ""}${participants ? ` | ${participants}` : ""}${ids ? ` | ${ids}` : ""}\n  ${body.replace(/\r?\n/g, "\n  ")}`;
}

export function recentMessageContextText(dataDirs: string[], limitOrQuery: number | RecentMessageContextQuery, options: RecentMessageContextOptions = {}): string {
  const query = normalizeQuery(limitOrQuery, options);
  const maxChars = Math.max(1, Math.floor(query.maxChars ?? DEFAULT_MESSAGE_CONTEXT_MAX_CHARS));
  const items = recentMessageContextItems(dataDirs, query);
  if (!items.length) return "- 暂无";
  const formatted = items.map(formatMessageContextItem);
  const selected: string[] = [];
  let chars = 0;
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const value = formatted[index];
    if (selected.length > 0 && chars + value.length + 1 > maxChars) continue;
    selected.push(value);
    chars += value.length + 1;
  }
  const text = selected.reverse().join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
