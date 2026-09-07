import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rabiContextManager, type RabiContextTriggerKind } from "../context/rabiContextManager.js";
import { listPlans, type PlanItem } from "../roleKnowledge.js";
import { ensurePersonaPlanWorkflow, planStatusDefinition } from "../personaPlanWorkflow.js";
import { buildRoleKnowledgeContextView } from "../routing/roleKnowledgeContext.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { agentCommunicationToolDenial } from "./agentCommunicationHookPolicy.js";
import {
  hasEffectiveProgress,
  isCompletePangHuProgressReceipt,
  isPangHuWorkspace,
  stablePangHuProgressDeliveryId,
  type PangHuProgressNotificationDelivery,
  type PangHuProgressNotificationResult
} from "./panghuProgressNotificationGate.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { appendPersonaChatReply } from "../personaChatHistory.js";

const STORE_VERSION = 7;
const MAX_CONTEXT_CHARS = 6200;
const CONTROL_PATTERN = /\[rabi:(use|bind)\s+([^\]\r\n]{1,80})\]|\[rabi:(status|refresh|off)\]/i;

export type CodexHookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export type PlanTaskCompletionDelivery = {
  roleId: string;
  roleDir: string;
  plan: PlanItem;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceCwd?: string;
  finalMessage: string;
  gatewayId?: string;
};

export type PlanTaskCompletionResult = {
  status: "ignored" | "duplicate" | "delivered" | "failed";
  reason: string;
  planId?: string;
  turnId?: string;
  gatewayId?: string;
  error?: string;
};

export type PangHuProgressNotificationState = {
  sessionId: string;
  roleId?: string;
  planId?: string;
  turnId?: string;
  updatedAt: string;
  fingerprint: string;
  status: PangHuProgressNotificationResult["status"];
  deliveryId?: string;
  sentMessageId?: string;
  platformReferenceReadback?: boolean;
  error?: string;
};

export type AgentRequestStopResult = {
  status: "ignored" | "scheduled" | "failed";
  reason: string;
  requestIds?: string[];
  turnId?: string;
  error?: string;
};

export type ProjectFileChangeReminderResult = {
  status: "ignored" | "delivered" | "failed";
  reason: string;
  planId?: string;
  planIds?: string[];
  turnId?: string;
  files?: string[];
  error?: string;
};

export type CodexHookSessionBinding = {
  sessionId: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
  lastEventName?: CodexHookEventName;
  cwd?: string;
  baseFingerprint?: string;
  lastTurnId?: string;
  turnContextKeys?: string[];
  lastPlanCompletionPlanId?: string;
  lastPlanCompletionTurnId?: string;
  lastPlanCompletionAt?: string;
  lastPlanCompletionStatus?: PlanTaskCompletionResult["status"];
  lastPlanCompletionError?: string;
};

export type PlanTaskCompletionState = {
  sessionId: string;
  roleId?: string;
  planId?: string;
  turnId?: string;
  updatedAt: string;
  status: PlanTaskCompletionResult["status"];
  gatewayId?: string;
  error?: string;
};

export type ProjectFileChangeState = {
  files: string[];
  workspaces: string[];
};

type CodexHookSessionStoreFile = {
  version: number;
  sessions: Record<string, CodexHookSessionBinding>;
  planTaskCompletions: Record<string, PlanTaskCompletionState>;
  pangHuProgressNotifications: Record<string, PangHuProgressNotificationState>;
  projectFileChanges: Record<string, Record<string, ProjectFileChangeState>>;
  projectFileChangeReminders: Record<string, Record<string, string>>;
};

export type CodexHookContextRequest = {
  agentType?: string;
  sessionId: string;
  eventName: CodexHookEventName;
  prompt?: string;
  source?: string;
  cwd?: string;
  managerBaseUrl?: string;
  turnId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
};

export type CodexHookContextResult = {
  completionDeliveries?: import("./agentCompletionDelivery.js").CompletionDeliveryResult[];
  action: "none" | "bind" | "status" | "refresh" | "off";
  binding: CodexHookSessionBinding | null;
  additionalContext: string;
  planTaskCompletion?: PlanTaskCompletionResult;
  projectFileChangeReminder?: ProjectFileChangeReminderResult;
  pangHuProgressNotification?: PangHuProgressNotificationResult;
  agentRequestStop?: AgentRequestStopResult;
  toolDecision?: { permissionDecision: "deny"; reason: string };
};

export type CodexHookControl =
  | { action: "bind"; roleId: string }
  | { action: "status" | "refresh" | "off" };

export class CodexHookPlanStorageUnavailableError extends Error {
  readonly code = "PLAN_STORAGE_STARTUP_UNAVAILABLE";
  readonly statusCode = 503;

  constructor() {
    super("Plan storage recovery is not ready. Retry after the current startup recovery attempt completes.");
    this.name = "CodexHookPlanStorageUnavailableError";
  }
}

export type CodexHookContextServiceOptions = {
  deliverAgentCompletion?: (request: CodexHookContextRequest) => Promise<import("./agentCompletionDelivery.js").CompletionDeliveryResult[]>;
  rolesRoot: () => string;
  storePath: string;
  deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  hookEnabled?: (request: CodexHookContextRequest) => boolean;
  isManagedAgentSession?: (request: CodexHookContextRequest) => boolean;
  recordAgentRequestStop?: (request: CodexHookContextRequest) => Promise<AgentRequestStopResult> | AgentRequestStopResult;
  findPangHuProgressIssue?: (plan: PlanItem) => PangHuProgressNotificationDelivery["issue"] | undefined;
  deliverPangHuProgressNotification?: (delivery: PangHuProgressNotificationDelivery) => Promise<PangHuProgressNotificationResult>;
  planStorageReady?: () => boolean;
  chatHistoryRoleIds?: (request: CodexHookContextRequest) => readonly string[];
  onChatHistoryChanged?: (roleId: string) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function section(title: string, content: string | string[]): string {
  const text = (Array.isArray(content) ? content.join("\n") : content).trim();
  return text ? `[${title}]\n${text}` : "";
}

function excerpt(value: string, limit: number, tail = 0): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  if (tail > 0 && limit > tail + 80) {
    const headLength = limit - tail - 45;
    return `${text.slice(0, headLength).trimEnd()}\n\n[...Rabi context clipped...]\n\n${text.slice(-tail).trimStart()}`;
  }
  return `${text.slice(0, Math.max(0, limit - 35)).trimEnd()}\n[...Rabi context clipped...]`;
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
    recordDataMutationAudit({
      group: "agent-session",
      event: "codex_hook_context_written",
      owner: "codex-hook-context",
      action: "persist-state",
      target: { type: "hook-context-store", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `runtime/${path.basename(filePath)}` },
      outcome: "committed",
      after: { digest: crypto.createHash("sha256").update(content).digest("hex") }
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "agent-session",
      event: "codex_hook_context_write_failed",
      owner: "codex-hook-context",
      action: "persist-state",
      target: { type: "hook-context-store", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `runtime/${path.basename(filePath)}` },
      outcome: "failed",
      error
    });
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizeManagerBaseUrl(value: string | undefined): string {
  const resolved = String(value || process.env.GATEWAY_MANAGER_URL || "").trim().replace(/\/+$/, "");
  if (!resolved) throw new Error("Manager base URL is required for Codex hook context.");
  return resolved;
}

function normalizedWorkspace(value: string | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const resolved = path.resolve(text).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fingerprint(values: string[]): string {
  return crypto.createHash("sha256").update(values.join("\0")).digest("hex");
}

function planTaskCompletionKey(sessionId: string, planId: string | undefined, turnId: string | undefined): string {
  return fingerprint(["plan_task_completion", sessionId, planId || "", turnId || ""]);
}

function boundedJson(value: unknown, limit: number): string {
  if (value == null) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return excerpt(text, limit, Math.min(800, Math.floor(limit / 4)));
}

function triggerKind(eventName: CodexHookEventName): RabiContextTriggerKind {
  if (eventName === "SessionStart") return "session_start";
  if (eventName === "UserPromptSubmit") return "user_prompt";
  if (eventName === "PreToolUse") return "reasoning_pre_tool";
  return "reasoning_post_tool";
}

function triggerSignal(request: CodexHookContextRequest): string {
  if (request.eventName === "UserPromptSubmit") return String(request.prompt || "");
  if (request.eventName === "SessionStart") return "";
  return [
    request.toolName ? `tool_name: ${request.toolName}` : "",
    request.toolInput == null ? "" : `tool_input:\n${boundedJson(request.toolInput, 12_000)}`,
    request.eventName === "PostToolUse" && request.toolResponse != null
      ? `tool_response:\n${boundedJson(request.toolResponse, 18_000)}`
      : ""
  ].filter(Boolean).join("\n\n");
}

function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function filePathsFromPatch(value: unknown): string[] {
  const patch = value && typeof value === "object" && typeof (value as Record<string, unknown>).patch === "string"
    ? (value as Record<string, unknown>).patch as string
    : toolText(value);
  return patch.split(/\r?\n/)
    .map((line) => line.match(/^(?:\*\*\*|\+\+\+)\s+(?:Add|Update|Delete) File:\s+(.+)$/)?.[1]?.trim() || "")
    .filter(Boolean);
}

function filePathsFromToolInput(toolName: string | undefined, input: unknown): string[] {
  const name = String(toolName || "").toLowerCase();
  const text = toolText(input);
  if (name.includes("apply_patch") || name.includes("applypatch")) return filePathsFromPatch(input);
  if (/(^|[._-])(edit|write|create|delete|move|copy)([._-]|$)/.test(name)) {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return [record.path, record.filePath, record.file_path, record.destination, record.destinationPath]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim());
  }
  if (!/(bash|shell|command|terminal|exec)/.test(name)) return [];
  const command = input && typeof input === "object"
    ? String((input as Record<string, unknown>).command || (input as Record<string, unknown>).cmd || "")
    : text;
  if (!/(?:>|>>|\b(?:set-content|add-content|out-file|copy-item|move-item|remove-item|new-item|touch)\b)/i.test(command)) return [];
  const powerShellPath = (verb: string, option: string) => [...command.matchAll(new RegExp(`\\b${verb}\\b[^\\r\\n;|&]*?-${option}\\s+['\"]?([^\\s'\";|&]+)`, "gi"))];
  const directPathMatches = [
    ...powerShellPath("set-content", "(?:path|literalpath)"),
    ...powerShellPath("add-content", "(?:path|literalpath)"),
    ...powerShellPath("out-file", "(?:filepath|literalpath)"),
    ...powerShellPath("new-item", "(?:path|literalpath)"),
    ...powerShellPath("remove-item", "(?:path|literalpath)"),
    ...powerShellPath("copy-item", "destination"),
    ...powerShellPath("move-item", "destination")
  ];
  const redirectMatches = [...command.matchAll(/(?:^|\s)>>?\s*['\"]?([^\s'\";|&]+)/g)];
  const touchMatches = [...command.matchAll(/\btouch\b\s+['\"]?([^\s'\";|&]+)/gi)];
  return [...directPathMatches, ...redirectMatches, ...touchMatches].map((match) => match[1]).filter(Boolean);
}

function successfulWriteResponse(value: unknown): boolean {
  const text = toolText(value).trim();
  if (!text) return false;
  return !/(?:\bfailed\b|\berror\b|\bno changes?\b|\bunchanged\b|exit code\s*[1-9])/i.test(text);
}

function projectRelativePaths(workspaces: string[], cwd: string | undefined, candidates: string[]): string[] {
  if (!cwd || workspaces.length === 0) return [];
  return [...new Set(candidates.flatMap((candidate) => {
    const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    const root = workspaces.find((workspace) => {
      const normalizedRoot = normalizedWorkspace(workspace);
      const resolved = normalizedWorkspace(absolutePath);
      return normalizedRoot && (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`));
    });
    if (!root) return [];
    const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
    return relative && !relative.startsWith("../") ? [relative] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

function matchedProjectWorkspaces(workspaces: string[], cwd: string | undefined, candidates: string[]): string[] {
  if (!cwd) return [];
  return [...new Set(candidates.flatMap((candidate) => {
    const resolved = normalizedWorkspace(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
    return workspaces.filter((workspace) => {
      const root = normalizedWorkspace(workspace);
      return root && (resolved === root || resolved.startsWith(`${root}/`));
    }).map(normalizedWorkspace);
  }))];
}

function retainNewest<T>(record: Record<string, T>, maximumEntries: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-maximumEntries));
}

export function parseCodexHookControl(prompt: string): CodexHookControl | null {
  const match = String(prompt || "").match(CONTROL_PATTERN);
  if (!match) return null;
  if (match[1]) {
    const roleId = sanitizeRoleId(match[2]);
    if (!roleId) throw new Error("Rabi role ID is invalid.");
    return { action: "bind", roleId };
  }
  return { action: match[3].toLowerCase() as "status" | "refresh" | "off" };
}

export class CodexHookContextService {
  private readonly rolesRoot: () => string;
  private readonly storePath: string;
  private readonly deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  private readonly hookEnabled?: (request: CodexHookContextRequest) => boolean;
  private readonly isManagedAgentSession?: (request: CodexHookContextRequest) => boolean;
  private readonly recordAgentRequestStop?: (request: CodexHookContextRequest) => Promise<AgentRequestStopResult> | AgentRequestStopResult;
  private readonly findPangHuProgressIssue?: (plan: PlanItem) => PangHuProgressNotificationDelivery["issue"] | undefined;
  private readonly deliverPangHuProgressNotification?: (delivery: PangHuProgressNotificationDelivery) => Promise<PangHuProgressNotificationResult>;
  private readonly planStorageReady?: () => boolean;
  private readonly chatHistoryRoleIds?: CodexHookContextServiceOptions["chatHistoryRoleIds"];
  private readonly onChatHistoryChanged?: CodexHookContextServiceOptions["onChatHistoryChanged"];

  private readonly deliverAgentCompletion?: CodexHookContextServiceOptions["deliverAgentCompletion"];

  constructor(options: CodexHookContextServiceOptions) {
    this.deliverAgentCompletion = options.deliverAgentCompletion;
    this.rolesRoot = options.rolesRoot;
    this.storePath = path.resolve(options.storePath);
    this.deliverPlanTaskCompletion = options.deliverPlanTaskCompletion;
    this.hookEnabled = options.hookEnabled;
    this.isManagedAgentSession = options.isManagedAgentSession;
    this.recordAgentRequestStop = options.recordAgentRequestStop;
    this.findPangHuProgressIssue = options.findPangHuProgressIssue;
    this.deliverPangHuProgressNotification = options.deliverPangHuProgressNotification;
    this.planStorageReady = options.planStorageReady;
    this.chatHistoryRoleIds = options.chatHistoryRoleIds;
    this.onChatHistoryChanged = options.onChatHistoryChanged;
  }

  listRoles(): string[] {
    const root = path.resolve(this.rolesRoot());
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && Boolean(sanitizeRoleId(entry.name)))
      .filter((entry) => fs.existsSync(path.join(root, entry.name, "persona.md")))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  listBindings(): CodexHookSessionBinding[] {
    return Object.values(this.readStore().sessions)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getBinding(sessionId: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    return this.readStore().sessions[id] ?? null;
  }

  bindSession(sessionId: string, roleId: string): CodexHookSessionBinding {
    const id = this.requireSessionId(sessionId);
    const role = this.requireRole(roleId);
    const store = this.readStore();
    const previous = store.sessions[id];
    const timestamp = nowIso();
    const binding: CodexHookSessionBinding = {
      sessionId: id,
      roleId: role.roleId,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    store.sessions[id] = binding;
    this.writeStore(store);
    return binding;
  }

  unbindSession(sessionId: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    const store = this.readStore();
    const previous = store.sessions[id] ?? null;
    if (previous) {
      delete store.sessions[id];
      this.writeStore(store);
    }
    return previous;
  }

  async handleHook(request: CodexHookContextRequest): Promise<CodexHookContextResult> {
    // Stop may read plans and persists completion/progress state. Fence it
    // before any observer, role lookup or internal mutation while recovery is
    // incomplete; non-mutating context hooks remain available.
    if (request.eventName === "Stop" && this.planStorageReady?.() === false) {
      throw new CodexHookPlanStorageUnavailableError();
    }
    const toolDecision = agentCommunicationToolDenial(
      request,
      this.isManagedAgentSession?.(request) === true
    );
    if (toolDecision) {
      return {
        action: "none",
        binding: this.getBinding(request.sessionId),
        additionalContext: "",
        toolDecision
      };
    }
    const enabled = !this.hookEnabled || this.hookEnabled(request);
    if (request.eventName === "Stop") {
      const result = await this.handleStop(request, enabled);
      if (!result.additionalContext.trim() && result.planTaskCompletion?.status !== "failed"
        && result.agentRequestStop?.status !== "failed" && result.projectFileChangeReminder?.status !== "failed"
        && result.pangHuProgressNotification?.status !== "failed" && this.deliverAgentCompletion) {
        result.completionDeliveries = await this.deliverAgentCompletion(request);
      }
      return result;
    }
    if (!enabled) {
      const binding = this.getBinding(request.sessionId);
      return {
        action: "none",
        binding,
        additionalContext: ""
      };
    }
    return this.handleContext(request);
  }

  handleContext(request: CodexHookContextRequest): CodexHookContextResult {
    const sessionId = this.requireSessionId(request.sessionId);
    if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(request.eventName)) {
      throw new Error(`Unsupported Codex hook event: ${request.eventName}`);
    }
    const prompt = request.eventName === "UserPromptSubmit" ? String(request.prompt || "") : "";
    const control = request.eventName === "UserPromptSubmit" ? parseCodexHookControl(prompt) : null;
    let binding = this.getBinding(sessionId);
    let action: CodexHookContextResult["action"] = control?.action ?? "none";
    let forceBase = request.eventName === "SessionStart";

    if (control?.action === "off") {
      this.unbindSession(sessionId);
      return {
        action,
        binding: null,
        additionalContext: "[Rabi Codex]\nRabi PC 已解除当前 Codex 会话的人格绑定。后续不得继续沿用此前注入的人格、计划、记忆或角色技能。"
      };
    }

    if (control?.action === "bind") {
      binding = this.bindSession(sessionId, control.roleId);
      forceBase = true;
    }

    if (control?.action === "status") {
      return {
        action,
        binding,
        additionalContext: binding
          ? `[Rabi Codex 绑定状态]\n当前会话人格：${binding.roleId}\n绑定由 Rabi PC Manager 管理。`
          : "[Rabi Codex 绑定状态]\n当前会话没有绑定 Rabi 人格。"
      };
    }

    if (control?.action === "refresh") {
      if (!binding) {
        return {
          action,
          binding: null,
          additionalContext: "[Rabi Codex]\n当前会话没有绑定 Rabi 人格，无法刷新。"
        };
      }
      this.requireRole(binding.roleId);
      forceBase = true;
    }

    if (request.eventName === "PostToolUse") {
      this.recordProjectFileChange(sessionId, request);
    }

    if (!binding) return { action, binding: null, additionalContext: "" };

    const role = this.requireRole(binding.roleId);
    const persona = readText(path.join(role.roleDir, "persona.md"));
    const growth = readText(path.join(role.roleDir, "growth.md"));
    const skills = readText(path.join(role.roleDir, "skills.md"));
    const baseFingerprint = fingerprint([persona, growth, skills]);
    const includeBase = forceBase || binding.baseFingerprint !== baseFingerprint;
    const managerBaseUrl = normalizeManagerBaseUrl(request.managerBaseUrl);
    const turnId = String(request.turnId || "").trim() || undefined;
    const sameTurn = Boolean(turnId && binding.lastTurnId === turnId);
    const seenContextKeys = new Set(sameTurn ? binding.turnContextKeys ?? [] : []);
    const contextResolution = rabiContextManager.resolve({
      kind: triggerKind(request.eventName),
      source: "codex_hook",
      roleId: role.roleId,
      roleDir: role.roleDir,
      signalText: triggerSignal(request),
      sessionId,
      turnId: request.turnId,
      eventId: request.toolUseId,
      toolName: request.toolName,
      seenContextKeys: [...seenContextKeys]
    });
    const isReasoningCheckpoint = contextResolution.policy.presentation === "recall_delta";
    const unseenEntries = contextResolution.entries.filter((entry) => !seenContextKeys.has(entry.key));
    const shouldRender = includeBase
      || (contextResolution.shouldInject && (!isReasoningCheckpoint || unseenEntries.length > 0));
    const visibleRequiredItems = isReasoningCheckpoint
      ? unseenEntries.flatMap((entry) => entry.item ? [entry.item] : [])
      : contextResolution.knowledge.requiredReadItems;
    const visibleItemIds = new Set(visibleRequiredItems.map((item) => `${item.type}:${item.id}`));
    const visibleKnowledge = isReasoningCheckpoint
      ? {
          ...contextResolution.knowledge,
          requiredReadItems: visibleRequiredItems,
          matchedItems: contextResolution.knowledge.matchedItems.filter((item) => visibleItemIds.has(`${item.type}:${item.id}`)),
          matchedSkills: contextResolution.knowledge.matchedSkills.filter((item) => visibleItemIds.has(`role_skill:${item.id}`))
        }
      : contextResolution.knowledge;
    const view = buildRoleKnowledgeContextView(role.roleId, visibleKnowledge);
    const focusedContext = view.mode === "focused";
    const blocks: string[] = [];

    if (includeBase) {
      blocks.push(section("Rabi Codex 会话人格", [
        "当前 Codex 会话已由 Rabi PC Manager 显式绑定人格。绑定只对当前 session_id 生效。",
        `角色 ID：${role.roleId}`,
        `Rabi Manager：${managerBaseUrl}`,
        "人格、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理；Codex Hook 只是触发器和注入器。"
      ]));
      blocks.push(section(focusedContext ? "人格核心指令" : "人格工作集", [
        focusedContext
          ? `这是精简人格工作集；完整真源位于 ${path.join(role.roleDir, "persona.md")}，只有当前任务明确涉及更深边界时才按需读取。`
          : "",
        excerpt(
          persona,
          visibleKnowledge.contextInjection.personaMaxChars,
          focusedContext ? 500 : 700
        )
      ]));
      if (!focusedContext && growth) blocks.push(section("成长规则摘要", excerpt(growth, 350)));
      if (!focusedContext && skills) blocks.push(section("角色技能摘要", excerpt(skills, 350)));
      if (focusedContext && (growth || skills)) {
        blocks.push(section("人格扩展按需读取", [
          growth ? `成长规则：${path.join(role.roleDir, "growth.md")}` : "",
          skills ? `技能索引：${path.join(role.roleDir, "skills.md")}` : ""
        ]));
      }
    }

    if (shouldRender && (!isReasoningCheckpoint || includeBase)) {
      blocks.push(section("记忆与计划", [
        `Rabi Manager API 基址：${managerBaseUrl}`,
        ...view.apiHintLines,
        "",
        "可用技能：",
        view.activeSkillIndex,
        "",
        "当前计划：",
        view.activePlanIndex,
        "",
        "近期记忆：",
        view.recentMemoryIndex,
        "",
        "命中技能：",
        view.matchedSkillIndex,
        "",
        "命中召回：",
        view.matchedIndex
      ]));
      blocks.push(section("处理前上下文确认", [
        "下列 GET 路径均相对于上方 Rabi Manager API 基址。",
        ...view.requiredReadLines
      ]));
    } else if (shouldRender) {
      blocks.push(section("Rabi 推理期上下文刷新", [
        `触发点：${request.eventName}`,
        request.toolName ? `工具：${request.toolName}` : "",
        `Rabi Manager API 基址：${managerBaseUrl}`,
        "本次只注入本轮新命中的增量；人格、计划、记忆、技能及 viewedAt 仍由同一 Rabi PC Manager 管理。"
      ]));
      blocks.push(section("推理期命中召回", [
        "命中技能：",
        view.matchedSkillIndex,
        "",
        "命中计划或记忆：",
        view.matchedIndex
      ]));
      blocks.push(section("处理前上下文确认", [
        "下列 GET 路径均相对于上方 Rabi Manager API 基址。",
        ...view.requiredReadLines
      ]));
    }

    const deliveredKeys = shouldRender
      ? [...seenContextKeys, ...contextResolution.entries.map((entry) => entry.key)].slice(-80)
      : [...seenContextKeys].slice(-80);
    const timestamp = nowIso();
    const nextBinding: CodexHookSessionBinding = {
      ...binding,
      updatedAt: timestamp,
      lastEventAt: timestamp,
      lastEventName: request.eventName,
      cwd: request.cwd || binding.cwd,
      baseFingerprint,
      lastTurnId: request.eventName === "SessionStart" ? undefined : turnId ?? binding.lastTurnId,
      turnContextKeys: request.eventName === "SessionStart" ? [] : deliveredKeys
    };
    this.replaceBinding(nextBinding);
    return {
      action,
      binding: nextBinding,
      additionalContext: shouldRender
        ? excerpt(blocks.filter(Boolean).join("\n\n"), MAX_CONTEXT_CHARS, 1400)
        : ""
    };
  }

  private async handleStop(request: CodexHookContextRequest, planCompletionEnabled: boolean): Promise<CodexHookContextResult> {
    await this.recordChatReply(request);
    const agentRequestStop = await this.recordAgentRequestStopResult(request);
    const progress = planCompletionEnabled ? await this.handlePangHuProgressStop(request) : undefined;
    if (progress?.status === "failed") {
      return {
        action: "none",
        binding: this.getBinding(request.sessionId),
        additionalContext: "[Rabi PangHu 进度通知门禁]\n本轮产生了有效进展，但工作群同步没有取得完整回执；保持当前任务进行中，修复发送或回读后重试。",
        pangHuProgressNotification: progress,
        planTaskCompletion: {
          status: "failed",
          reason: "panghu_progress_notification_required",
          planId: progress.planId,
          turnId: progress.turnId,
          error: progress.error || progress.reason
        },
        agentRequestStop
      };
    }
    const projectFileChangeReminder = await this.handleProjectFileChangeStop(request);
    if (projectFileChangeReminder.result.status === "delivered") {
      if (planCompletionEnabled) void this.handlePlanStop(request).catch(() => undefined);
      return {
        action: "none",
        binding: this.getBinding(request.sessionId),
        additionalContext: projectFileChangeReminder.message,
        planTaskCompletion: {
          status: "ignored",
          reason: planCompletionEnabled ? "deferred_after_project_file_change_reminder" : "hook_disabled_by_codex_endpoint",
          turnId: request.turnId
        },
        agentRequestStop,
        ...(progress ? { pangHuProgressNotification: progress } : {}),
        projectFileChangeReminder: projectFileChangeReminder.result
      };
    }
    const planResult = planCompletionEnabled
      ? await this.handlePlanStop(request)
      : {
          action: "none" as const,
          binding: this.getBinding(request.sessionId),
          additionalContext: "",
          planTaskCompletion: {
            status: "ignored" as const,
            reason: "hook_disabled_by_codex_endpoint",
            turnId: request.turnId
          }
        };
    const additionalContext = [planResult.additionalContext, projectFileChangeReminder.message].filter(Boolean).join("\n\n");
    return {
      ...planResult,
      additionalContext,
      agentRequestStop,
      ...(progress ? { pangHuProgressNotification: progress } : {}),
      projectFileChangeReminder: projectFileChangeReminder.result
    };
  }

  private async recordChatReply(request: CodexHookContextRequest): Promise<void> {
    if (!request.turnId?.trim() || !request.lastAssistantMessage?.trim()) return;
    const sessionId = this.requireSessionId(request.sessionId);
    const binding = this.getBinding(sessionId);
    if (binding?.cwd && request.cwd && normalizedWorkspace(binding.cwd) !== normalizedWorkspace(request.cwd)) return;
    const roleIds = new Set(this.chatHistoryRoleIds?.(request) ?? []);
    if (binding) roleIds.add(binding.roleId);
    // No guessed persona and no cross-persona fanout for ambiguous task ownership.
    if (roleIds.size !== 1) return;
    const role = this.requireRole([...roleIds][0]);
    const record = await appendPersonaChatReply(role.roleDir, {
      sessionId, turnId: request.turnId.trim(), text: request.lastAssistantMessage
    });
    if (record) this.onChatHistoryChanged?.(role.roleId);
  }

  private recordProjectFileChange(sessionId: string, request: CodexHookContextRequest): void {
    const turnId = String(request.turnId || "").trim();
    const candidates = filePathsFromToolInput(request.toolName, request.toolInput);
    if (!turnId || candidates.length === 0 || !successfulWriteResponse(request.toolResponse)) return;
    const workspaces = this.taskBindingWorkspaces(sessionId);
    const files = projectRelativePaths(workspaces, request.cwd, candidates);
    const changedWorkspaces = files.length > 0 ? matchedProjectWorkspaces(workspaces, request.cwd, candidates) : [];
    if (files.length === 0) return;
    const store = this.readStore();
    const current = store.projectFileChanges[sessionId]?.[turnId];
    const changed = new Set(current?.files ?? []);
    const workspaceSet = new Set(current?.workspaces ?? []);
    files.forEach((file) => changed.add(file));
    changedWorkspaces.forEach((workspace) => workspaceSet.add(workspace));
    store.projectFileChanges[sessionId] = retainNewest({
      ...store.projectFileChanges[sessionId],
      [turnId]: { files: [...changed].sort((left, right) => left.localeCompare(right)), workspaces: [...workspaceSet].sort((left, right) => left.localeCompare(right)) }
    }, 64);
    this.writeStore(store);
  }

  private async handleProjectFileChangeStop(request: CodexHookContextRequest): Promise<{ result: ProjectFileChangeReminderResult; message: string }> {
    const sessionId = this.requireSessionId(request.sessionId);
    const turnId = String(request.turnId || "").trim();
    const store = this.readStore();
    const state = turnId ? store.projectFileChanges[sessionId]?.[turnId] : undefined;
    const files = state?.files ?? [];
    const changedWorkspaces = state?.workspaces ?? [];
    if (!turnId) return { result: { status: "failed", reason: "missing_turn_id", error: "Project file changes cannot be associated with a Stop turn." }, message: "" };
    if (store.projectFileChangeReminders[sessionId]?.[turnId]) {
      return { result: { status: "ignored", reason: "turn_already_reminded", turnId, files }, message: "" };
    }
    if (files.length === 0) return { result: { status: "ignored", reason: "no_confirmed_project_file_change", turnId }, message: "" };
    const matches = this.listRoles().flatMap((roleId) => {
      const role = this.requireRole(roleId);
      return listPlans(role.roleDir)
        .filter((plan) => plan.taskBinding?.agentType === "codex"
          && plan.taskBinding.sessionId === sessionId
          && changedWorkspaces.includes(normalizedWorkspace(plan.taskBinding.workspace)))
        .map((plan) => ({ ...role, plan }));
    });
    if (matches.length === 0) return { result: { status: "ignored", reason: "no_matching_plan_task_binding", turnId, files }, message: "" };
    const plans = matches.map((match) => match.plan);
    const reminders = retainNewest({ ...store.projectFileChangeReminders[sessionId], [turnId]: nowIso() }, 64);
    store.projectFileChangeReminders[sessionId] = reminders;
    const remainingChanges = { ...store.projectFileChanges[sessionId] };
    delete remainingChanges[turnId];
    store.projectFileChanges[sessionId] = remainingChanges;
    this.writeStore(store);
    return {
      result: { status: "delivered", reason: "project_file_changes_detected", planId: plans[0]?.id, planIds: plans.map((plan) => plan.id), turnId, files },
      message: [
        "[Rabi 计划检查提醒]",
        `本轮已修改项目文件：${files.join("、")}。`,
        `请检查绑定计划${plans.map((plan) => `“${plan.title}”`).join("、")}的 status、currentStep、steps、证据和附件是否需要按实际进展更新。`,
        "本提醒不会自动修改计划。"
      ].join("\n")
    };
  }

  private taskBindingWorkspaces(sessionId: string): string[] {
    return [...new Set(this.listRoles().flatMap((roleId) => {
      const role = this.requireRole(roleId);
      return listPlans(role.roleDir)
        .filter((plan) => plan.taskBinding?.agentType === "codex" && plan.taskBinding.sessionId === sessionId)
        .map((plan) => String(plan.taskBinding?.workspace || "").trim())
        .filter(Boolean);
    }))];
  }

  private async handlePangHuProgressStop(request: CodexHookContextRequest): Promise<PangHuProgressNotificationResult | undefined> {
    const sessionId = this.requireSessionId(request.sessionId);
    const matches = this.listRoles().flatMap((roleId) => {
      const role = this.requireRole(roleId);
      const workflow = ensurePersonaPlanWorkflow(role.roleDir).workflow;
      return listPlans(role.roleDir)
        .filter((plan) => (planStatusDefinition(workflow, plan.status)?.views.includes("current") === true)
          && plan.taskBinding?.agentType === "codex"
          && plan.taskBinding.sessionId === sessionId
          && isPangHuWorkspace(plan.taskBinding.workspace || request.cwd))
        .map((plan) => ({ ...role, plan }));
    });
    if (matches.length === 0) return undefined;
    if (matches.length > 1) return { status: "failed", reason: "multiple_panghu_plan_task_bindings", turnId: request.turnId, error: `Codex session ${sessionId} is bound to multiple PangHu plans: ${matches.map((match) => match.plan.id).join(", ")}` };
    const { roleId, roleDir, plan } = matches[0];
    const turnId = String(request.turnId || "").trim();
    const finalMessage = String(request.lastAssistantMessage || "").trim();
    if (!turnId) return { status: "failed", reason: "missing_turn_id", planId: plan.id, error: "PangHu progress notification requires turn_id." };
    if (!hasEffectiveProgress(finalMessage)) return { status: "ignored", reason: "no_effective_progress", planId: plan.id, turnId };
    const issue = this.findPangHuProgressIssue?.(plan);
    if (!issue?.groupId || !issue.sourceMessageId) return { status: "failed", reason: "PANGHU_PROGRESS_NOTIFICATION_CONTEXT_REQUIRED", planId: plan.id, turnId, error: "PangHu progress notification requires a managed work-group issue mapping with groupId and sourceMessageId." };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
      message: finalMessage, currentStepId: plan.currentStepId || "", currentStep: plan.currentStep || "", nextAction: plan.nextAction || "", waitingFor: plan.waitingFor || ""
    })).digest("hex");
    const store = this.readStore();
    const previous = store.pangHuProgressNotifications[plan.id];
    if (previous?.status === "sent" && previous.fingerprint === fingerprint) return { status: "duplicate", reason: "same_progress_already_sent", planId: plan.id, turnId, deliveryId: previous.deliveryId, sentMessageId: previous.sentMessageId, platformReferenceReadback: previous.platformReferenceReadback };
    if (!this.deliverPangHuProgressNotification) return { status: "failed", reason: "delivery_unavailable", planId: plan.id, turnId, deliveryId: stablePangHuProgressDeliveryId(plan.id, sessionId, turnId), error: "PangHu progress notification delivery is not configured." };
    const deliveryId = stablePangHuProgressDeliveryId(plan.id, sessionId, turnId);
    try {
      const result = await this.deliverPangHuProgressNotification({ roleId, roleDir, plan, issue, sourceSessionId: sessionId, sourceTurnId: turnId, sourceCwd: request.cwd, finalMessage, gatewayId: plan.taskBinding?.completionHook?.gatewayId });
      const complete = isCompletePangHuProgressReceipt(result);
      const state: PangHuProgressNotificationState = { sessionId, roleId, planId: plan.id, turnId, updatedAt: nowIso(), fingerprint, status: complete ? "sent" : "failed", deliveryId: result.deliveryId || deliveryId, sentMessageId: result.sentMessageId, platformReferenceReadback: result.platformReferenceReadback, error: complete ? undefined : result.error || result.reason };
      store.pangHuProgressNotifications[plan.id] = state;
      this.writeStore(store);
      return complete ? { ...result, status: "sent", planId: plan.id, turnId, deliveryId: result.deliveryId || deliveryId } : { ...result, status: "failed", planId: plan.id, turnId, deliveryId: result.deliveryId || deliveryId, error: result.error || result.reason };
    } catch (error) {
      return { status: "failed", reason: "delivery_failed", planId: plan.id, turnId, deliveryId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async recordAgentRequestStopResult(request: CodexHookContextRequest): Promise<AgentRequestStopResult> {
    if (!this.recordAgentRequestStop) {
      return { status: "ignored", reason: "agent_request_stop_not_configured", turnId: request.turnId };
    }
    try {
      return await this.recordAgentRequestStop(request);
    } catch (error) {
      return {
        status: "failed",
        reason: "agent_request_stop_failed",
        turnId: request.turnId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async handlePlanStop(request: CodexHookContextRequest): Promise<CodexHookContextResult> {
    const sessionId = this.requireSessionId(request.sessionId);
    const binding = this.getBinding(sessionId);
    const matches = this.listRoles().flatMap((roleId) => {
      const role = this.requireRole(roleId);
      const workflow = ensurePersonaPlanWorkflow(role.roleDir).workflow;
      return listPlans(role.roleDir)
        .filter((plan) => (
          (planStatusDefinition(workflow, plan.status)?.views.includes("current") === true)
          && plan.taskBinding?.agentType === "codex"
          && plan.taskBinding.sessionId === sessionId
          && plan.taskBinding.completionHook?.enabled === true
        ))
        .map((plan) => ({ ...role, plan }));
    });
    if (matches.length === 0) {
      return {
        action: "none",
        binding,
        additionalContext: "",
        planTaskCompletion: { status: "ignored", reason: "no_enabled_plan_task_binding", turnId: request.turnId }
      };
    }
    if (matches.length > 1) {
      return this.recordPlanCompletion(binding, undefined, request, {
        status: "failed",
        reason: "multiple_plan_task_bindings",
        turnId: request.turnId,
        error: `Codex session ${sessionId} is bound to multiple plans: ${matches.map((match) => `${match.roleId}/${match.plan.id}`).join(", ")}`
      });
    }

    const { roleId, roleDir, plan } = matches[0];
    const turnId = String(request.turnId || "").trim();
    const finalMessage = String(request.lastAssistantMessage || "").trim();
    const gatewayId = plan.taskBinding?.completionHook?.gatewayId;
    if (binding && binding.roleId !== roleId) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "role_binding_mismatch",
        planId: plan.id,
        turnId,
        gatewayId,
        error: `Codex session ${sessionId} is context-bound to role ${binding.roleId}, but its plan task belongs to role ${roleId}.`
      });
    }
    if (!turnId) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "missing_turn_id",
        planId: plan.id,
        gatewayId,
        error: "Codex Stop hook did not provide turn_id; completion delivery was not attempted."
      });
    }
    const completionState = Object.values(this.readStore().planTaskCompletions)
      .find((state) => (
        state.sessionId === sessionId
        && state.planId === plan.id
        && state.turnId === turnId
        && state.status !== "ignored"
      ));
    if (completionState) {
      return {
        action: "none",
        binding,
        additionalContext: "",
        planTaskCompletion: {
          status: "duplicate",
          reason: "turn_already_processed",
          planId: plan.id,
          turnId,
          gatewayId
        }
      };
    }
    if (!finalMessage) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "ignored",
        reason: "missing_final_message",
        planId: plan.id,
        turnId,
        gatewayId
      });
    }

    const expectedWorkspace = normalizedWorkspace(plan.taskBinding?.workspace);
    const actualWorkspace = normalizedWorkspace(request.cwd);
    if (expectedWorkspace && actualWorkspace && expectedWorkspace !== actualWorkspace) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "workspace_mismatch",
        planId: plan.id,
        turnId,
        gatewayId,
        error: `Plan task workspace does not match the Stop hook cwd: ${plan.taskBinding?.workspace} != ${request.cwd}`
      });
    }
    if (!this.deliverPlanTaskCompletion) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "delivery_unavailable",
        planId: plan.id,
        turnId,
        gatewayId,
        error: "Rabi plan task completion delivery is not configured."
      });
    }

    try {
      await this.deliverPlanTaskCompletion({
        roleId,
        roleDir,
        plan,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        sourceCwd: request.cwd,
        finalMessage: excerpt(finalMessage, 12_000, 4_000),
        gatewayId
      });
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "delivered",
        reason: request.stopHookActive ? "stop_continuation_completed" : "stop_completed",
        planId: plan.id,
        turnId,
        gatewayId
      });
    } catch (error) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "delivery_failed",
        planId: plan.id,
        turnId,
        gatewayId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private recordPlanCompletion(
    binding: CodexHookSessionBinding | null,
    roleId: string | undefined,
    request: CodexHookContextRequest,
    result: PlanTaskCompletionResult
  ): CodexHookContextResult {
    const timestamp = nowIso();
    const sessionId = this.requireSessionId(request.sessionId);
    const store = this.readStore();
    const nextBinding: CodexHookSessionBinding | null = binding
      ? {
          ...binding,
          updatedAt: timestamp,
          lastEventAt: timestamp,
          lastEventName: "Stop",
          cwd: request.cwd || binding.cwd,
          lastPlanCompletionPlanId: result.planId ?? binding.lastPlanCompletionPlanId,
          lastPlanCompletionTurnId: result.turnId ?? binding.lastPlanCompletionTurnId,
          lastPlanCompletionAt: timestamp,
          lastPlanCompletionStatus: result.status,
          lastPlanCompletionError: result.error
        }
      : null;
    if (nextBinding) store.sessions[nextBinding.sessionId] = nextBinding;
    const completionKey = planTaskCompletionKey(sessionId, result.planId, result.turnId);
    store.planTaskCompletions[completionKey] = {
      sessionId,
      roleId,
      planId: result.planId,
      turnId: result.turnId,
      updatedAt: timestamp,
      status: result.status,
      gatewayId: result.gatewayId,
      error: result.error
    };
    this.writeStore(store);
    return { action: "none", binding: nextBinding, additionalContext: "", planTaskCompletion: result };
  }

  doctor(): Record<string, unknown> {
    const rolesRoot = path.resolve(this.rolesRoot());
    return {
      ok: true,
      rolesRoot,
      rolesRootAvailable: fs.existsSync(rolesRoot),
      roleIds: fs.existsSync(rolesRoot) ? this.listRoles() : [],
      storePath: this.storePath,
      bindings: this.listBindings().map(({ sessionId, roleId, updatedAt }) => ({ sessionId, roleId, updatedAt })),
      planTaskCompletions: Object.values(this.readStore().planTaskCompletions)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    };
  }

  private requireSessionId(sessionId: string): string {
    const id = String(sessionId || "").trim();
    if (!id || id.length > 240) throw new Error("A real Codex session ID is required.");
    return id;
  }

  private requireRole(roleId: string): { roleId: string; roleDir: string } {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) throw new Error("Rabi role ID is invalid.");
    const roleDir = roleFolderPath(this.rolesRoot(), safeRoleId);
    if (!fs.existsSync(path.join(roleDir, "persona.md"))) {
      throw new Error(`Rabi role not found: ${safeRoleId}`);
    }
    return { roleId: safeRoleId, roleDir };
  }

  private readStore(): CodexHookSessionStoreFile {
    if (!fs.existsSync(this.storePath)) {
      const empty: CodexHookSessionStoreFile = { version: STORE_VERSION, sessions: {}, planTaskCompletions: {}, pangHuProgressNotifications: {}, projectFileChanges: {}, projectFileChangeReminders: {} };
      this.writeStore(empty);
      return empty;
    }
    const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<CodexHookSessionStoreFile>;
    return {
      version: STORE_VERSION,
      sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
      planTaskCompletions: raw.planTaskCompletions && typeof raw.planTaskCompletions === "object"
        ? raw.planTaskCompletions
        : {},
      pangHuProgressNotifications: raw.pangHuProgressNotifications && typeof raw.pangHuProgressNotifications === "object"
        ? raw.pangHuProgressNotifications
        : {},
      projectFileChanges: raw.projectFileChanges && typeof raw.projectFileChanges === "object" ? raw.projectFileChanges : {},
      projectFileChangeReminders: raw.projectFileChangeReminders && typeof raw.projectFileChangeReminders === "object" ? raw.projectFileChangeReminders : {}
    };
  }

  private writeStore(store: CodexHookSessionStoreFile): void {
    writeJsonAtomic(this.storePath, {
      version: STORE_VERSION,
      sessions: store.sessions,
      planTaskCompletions: store.planTaskCompletions,
      pangHuProgressNotifications: store.pangHuProgressNotifications,
      projectFileChanges: store.projectFileChanges,
      projectFileChangeReminders: store.projectFileChangeReminders
    });
  }

  private replaceBinding(binding: CodexHookSessionBinding): void {
    const store = this.readStore();
    store.sessions[binding.sessionId] = binding;
    this.writeStore(store);
  }
}
