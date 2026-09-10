import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { requestMessageAgentManager } from "./messageAgentPool.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { sameCodexWorkspace } from "./codexTaskIdentity.js";
import { parseAgentAdapterType, type AgentAdapterType } from "./agentAdapters/types.js";
import type { RabiMessageSource } from "./shared/rabiMessage.js";
import {
  codexMemoryConsolidationAgentTitle,
  normalizeCodexMemoryConsolidationAgentModel
} from "./shared/codexMemoryConsolidationAgent.js";

export const MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION = 1;

export type MemoryConsolidationAgentBinding = {
  agentAdapter: AgentAdapterType;
  threadId: string;
  threadName: string;
  workspace: string;
  initializedAt?: string;
};

export type MemoryConsolidationAgentState = {
  schemaVersion: 1;
  updatedAt: string;
  binding?: MemoryConsolidationAgentBinding;
  pendingDelivery?: { promptHash: string; deliveryId?: string };
};

export type MemoryConsolidationAgentOptions = {
  statePath: string;
  managerBaseUrl: string;
  sourceThreadId: string;
  sourceThreadName: string;
  agentAdapter?: AgentAdapterType;
  workspace: string;
  roleId: string;
  model?: string;
};

export type MemoryConsolidationAgentDependencies = {
  request?: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  now?: () => Date;
};

function readState(filePath: string): MemoryConsolidationAgentState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryConsolidationAgentState>;
    const binding = raw.binding;
    if (raw.schemaVersion !== MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION || !binding) {
      return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
    }
    const threadId = String(binding.threadId || "").trim();
    const threadName = String(binding.threadName || "").trim();
    const workspace = String(binding.workspace || "").trim();
    if (!threadId || !threadName || !workspace) {
      return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
    }
    return {
      schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION,
      updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      ...(raw.pendingDelivery ? { pendingDelivery: raw.pendingDelivery } : {}),
      binding: {
        agentAdapter: parseAgentAdapterType(String(binding.agentAdapter || "")) ?? "codex",
        threadId,
        threadName,
        workspace,
        initializedAt: typeof binding.initializedAt === "string" && binding.initializedAt.trim()
          ? binding.initializedAt.trim()
          : undefined
      }
    };
  } catch {
    return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
  }
}

function memoryAgentAdapter(options: MemoryConsolidationAgentOptions): AgentAdapterType {
  return options.agentAdapter ?? "codex";
}

function initializationPrompt(options: MemoryConsolidationAgentOptions, binding: MemoryConsolidationAgentBinding): string {
  return [
    `[rabi:bind ${options.roleId}]`,
    "[记忆整理 Agent 初始化]",
    `主人格任务：${options.sourceThreadName}`,
    `主人格任务 ID：${options.sourceThreadId}`,
    `记忆整理任务：${binding.threadName}`,
    `记忆整理任务 ID：${binding.threadId}`,
    `工作目录：${binding.workspace}`,
    "",
    "你是持久记忆整理 Agent，只处理 memory_consolidation_request。",
    "把固定候选整理成简洁、可长期召回的 Markdown；保留稳定约束、已确认决定、长期偏好、证据入口和有效协作规则。",
    "删除整段聊天、重复过程、临时状态和无关项目；旧结论过时时写明替代关系。受控 Markdown 图片引用可保留，不改成本机绝对路径。",
    "结果 API 成功接收才算完成。禁止实施业务、修改项目、发布、外发消息或写入 taskBinding。"
  ].join("\n");
}

function threadFromResponse(
  response: Record<string, any>,
  expectedTitle: string,
  expectedWorkspace: string,
  agentAdapter: AgentAdapterType
): MemoryConsolidationAgentBinding {
  const thread = response.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const threadId = String(thread?.id || "").trim();
  const threadName = String(thread?.title || expectedTitle).trim();
  const workspace = String(thread?.cwd || expectedWorkspace).trim();
  if (!threadId || !threadName || !workspace) {
    throw new Error("Memory consolidation Agent session resolution did not return a complete binding.");
  }
  return { agentAdapter, threadId, threadName, workspace };
}

export class MemoryConsolidationAgent {
  private state: MemoryConsolidationAgentState;
  private readonly request: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  private readonly now: () => Date;
  private deliveryTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryConsolidationAgentOptions, dependencies: MemoryConsolidationAgentDependencies = {}) {
    this.state = readState(options.statePath);
    this.request = dependencies.request ?? ((payload) => requestMessageAgentManager(options.managerBaseUrl, payload));
    this.now = dependencies.now ?? (() => new Date());
  }

  async deliver(prompt: string, messageSource: RabiMessageSource): Promise<MemoryConsolidationAgentBinding> {
    if (!messageSource) throw new Error("Memory consolidation Agent delivery requires messageSource.");
    let delivered!: MemoryConsolidationAgentBinding;
    const operation = this.deliveryTail.catch(() => undefined).then(async () => {
      const promptHash = createHash("sha256").update(JSON.stringify({ prompt, messageSource })).digest("hex");
      if (this.state.pendingDelivery) {
        const pending = this.state.pendingDelivery;
        const binding = this.state.binding;
        if (!binding || pending.promptHash !== promptHash || !pending.deliveryId) {
          throw Object.assign(new Error("Memory delivery is uncertain; automatic resend is blocked."), { code: "MEMORY_DELIVERY_UNCONFIRMED" });
        }
        const receipt = await this.request({ action: "read", agentAdapter: binding.agentAdapter, threadId: binding.threadId, deliveryId: pending.deliveryId });
        if (receipt.delivery?.state !== "accepted") {
          throw Object.assign(new Error("Memory delivery receipt is not confirmed; automatic resend is blocked."), { code: "MEMORY_DELIVERY_UNCONFIRMED" });
        }
        this.state.pendingDelivery = undefined;
        binding.initializedAt ??= this.now().toISOString();
        this.persist(binding);
        delivered = structuredClone(binding);
        return;
      }
      const binding = await this.resolveBinding();
      const shouldInitialize = !binding.initializedAt;
      this.state.pendingDelivery = { promptHash };
      this.persist(binding);
      try {
        await this.request({
        action: "send",
        agentAdapter: binding.agentAdapter,
        threadId: binding.threadId,
        cwd: binding.workspace,
        messageSource,
        controlBlocks: shouldInitialize ? [initializationPrompt(this.options, binding)] : undefined,
        sandbox: "workspace-write",
        model: normalizeCodexMemoryConsolidationAgentModel(this.options.model),
        prompt
        });
      } catch (error) {
        const failure = error as { statusCode?: number; response?: Record<string, any> };
        const response = failure.response;
        const deliveryId = response?.delivery?.deliveryId ?? response?.data?.delivery?.deliveryId;
        if (typeof deliveryId === "string" && deliveryId.trim()) {
          this.state.pendingDelivery = { promptHash, deliveryId };
        } else if (response?.commitState === "not_started") {
          this.state.pendingDelivery = undefined;
        }
        this.persist(binding);
        if (this.state.pendingDelivery) {
          throw Object.assign(new Error("Memory delivery is uncertain; receipt verification is required before retry."), { code: "MEMORY_DELIVERY_UNCONFIRMED", cause: error });
        }
        throw error;
      }
      this.state.pendingDelivery = undefined;
      if (shouldInitialize) binding.initializedAt = this.now().toISOString();
      this.persist(binding);
      delivered = structuredClone(binding);
    });
    this.deliveryTail = operation;
    await operation;
    return delivered;
  }

  private async resolveBinding(): Promise<MemoryConsolidationAgentBinding> {
    const title = codexMemoryConsolidationAgentTitle(this.options.sourceThreadName);
    const saved = this.state.binding;
    const reusableSaved = saved
      && saved.agentAdapter === memoryAgentAdapter(this.options)
      && sameCodexWorkspace(saved.workspace, this.options.workspace)
      ? saved
      : undefined;
    try {
      const response = await this.request({
        action: "resolve",
        agentAdapter: memoryAgentAdapter(this.options),
        threadId: reusableSaved?.threadId,
        title,
        cwd: this.options.workspace,
        createIfMissing: false,
        lookupMode: "state_db"
      });
      const resolved = { ...threadFromResponse(response, title, this.options.workspace, memoryAgentAdapter(this.options)), initializedAt: reusableSaved?.initializedAt };
      this.assertSeparateFromPrimary(resolved);
      this.assertWorkspace(resolved);
      this.persist(resolved);
      return resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
      if (!message.includes("not found") && !message.includes("没有找到") && !message.includes("missing")) throw error;
    }

    const source = await this.request({ action: "read", agentAdapter: memoryAgentAdapter(this.options), threadId: this.options.sourceThreadId });
    const sourceStatus = String(source.thread?.status?.type || "").trim();
    if (!sourceStatus || sourceStatus === "unavailable") {
      throw new Error("目标 Agent 端当前不可用，未创建记忆整理会话；RabiRoute 不会切换到其它 Agent 端。");
    }
    const response = await this.request({
      action: "resolve",
      agentAdapter: memoryAgentAdapter(this.options),
      title,
      cwd: this.options.workspace,
      createIfMissing: true,
      lookupMode: "state_db"
    });
    const resolved = { ...threadFromResponse(response, title, this.options.workspace, memoryAgentAdapter(this.options)) };
    this.assertSeparateFromPrimary(resolved);
    this.assertWorkspace(resolved);
    this.persist(resolved);
    return resolved;
  }

  private assertSeparateFromPrimary(binding: MemoryConsolidationAgentBinding): void {
    if (binding.threadId === this.options.sourceThreadId) {
      throw new Error("Memory consolidation Agent resolution returned the Primary Persona task id; refusing role crossover.");
    }
  }

  private assertWorkspace(binding: MemoryConsolidationAgentBinding): void {
    if (!sameCodexWorkspace(binding.workspace, this.options.workspace)) {
      throw new Error("Memory consolidation Agent task resolution returned a workspace different from the Primary Persona.");
    }
  }

  private persist(binding: MemoryConsolidationAgentBinding): void {
    this.state = {
      schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      ...(this.state.pendingDelivery ? { pendingDelivery: this.state.pendingDelivery } : {}),
      binding: structuredClone(binding)
    };
    atomicWriteFileSync(this.options.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

export function memoryConsolidationAgentStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "memory", "consolidation-agent.json");
}
