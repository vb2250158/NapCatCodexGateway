import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentCompletionDeliveryRule } from "../shared/gatewayConfigModel.js";
import type { CodexHookContextRequest } from "./codexHookContext.js";
import { handleAgentSend, inspectAgentSendDelivery, type AgentSendRequest } from "../agentSend.js";
import type { AgentReplyOptions } from "../outbox.js";
import type { PlanItem } from "../roleKnowledge.js";
import { AGENT_HOOK_EVENTS, agentHookRuleErrors } from "../shared/agentHookAutomation.js";

const execute = promisify(execFile);
export type CompletionDeliveryResult = { ruleId: string; status: "sent" | "failed"; reason?: string };
export type CompletionRuleOwner = { roleId: string; rule: AgentCompletionDeliveryRule };
export type CompletionTaskContext = { taskName?: string; plans: Array<{ id: string; title: string }> };

export function completionTaskContextFromPlans(sessionId: string,
  plans: readonly Pick<PlanItem, "id" | "title" | "taskBinding">[], currentTitle?: string): CompletionTaskContext {
  const bound = plans.filter(plan => plan.taskBinding?.agentType === "codex" && plan.taskBinding.sessionId === sessionId);
  return {
    taskName: currentTitle?.trim() || bound.find(plan => plan.taskBinding?.sessionTitle?.trim())?.taskBinding?.sessionTitle,
    plans: bound.map(plan => ({ id: plan.id, title: plan.title }))
  };
}

export async function deliverCompletionToEndpoint(rule: AgentCompletionDeliveryRule, hook: CodexHookContextRequest,
  deliveryId: string, routeId: string, options: AgentReplyOptions, context: CompletionTaskContext = { plans: [] }): Promise<void> {
  const taskName = context.taskName?.trim() || "未命名任务";
  const heading = ["Codex 任务完成", `任务：${taskName}`,
    ...(context.plans.length ? [`计划：${context.plans.map(plan => plan.title).join("、")}`] : [])].join("\n");
  const { channel, params } = rule.destination;
  if (channel !== "napcat" && channel !== "speech") throw new Error("不支持的消息端。");
  const request: AgentSendRequest = {
    deliveryId, sender: { agentType: "codex_hook", sessionId: hook.sessionId }, routeId,
    channel, params: channel === "napcat"
      ? { target: params.target, ...(params.target === "group" ? { groupId: params.targetId } : { userId: params.targetId }), instanceId: params.instanceId, replyToMessageId: "" }
      : { sessionId: params.sessionId || "" },
    payload: { type: "text", text: `${heading}\n\n${hook.lastAssistantMessage!.trim()}` },
    styleValidation: 0
  };
  const inspection = await inspectAgentSendDelivery(request, options);
  if (inspection.state === "uncertain") throw new Error(inspection.reason);
  const result = inspection.state === "completed" ? inspection.result : await handleAgentSend(request, options);
  if (result.status !== "sent" || (channel === "napcat" && !result.sentMessageId)) throw new Error(result.reason || "完成消息未取得发送回执。");
}

function canonicalPath(value: string): string {
  const result = path.resolve(value);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

/** Git's common directory identifies all worktrees of one project without prefix matching unrelated projects. */
export async function completionProjectIdentity(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("项目目录必须是绝对路径。");
  const real = await fs.promises.realpath(directory);
  try {
    const { stdout } = await execute("git", ["-C", real, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    const [commonDirectory, topLevel] = stdout.trim().split(/\r?\n/);
    const relativeProject = path.relative(canonicalPath(await fs.promises.realpath(topLevel)), canonicalPath(real));
    return `git:${canonicalPath(await fs.promises.realpath(commonDirectory))}:${relativeProject}`;
  } catch {
    return `folder:${canonicalPath(real)}`;
  }
}

export class AgentCompletionDeliveryService {
  private readonly pending = new Map<string, Promise<CompletionDeliveryResult[]>>();
  constructor(private readonly options: {
    rules(): CompletionRuleOwner[];
    projectIdentity?: typeof completionProjectIdentity;
    taskContext?(owner: CompletionRuleOwner, request: CodexHookContextRequest): CompletionTaskContext | Promise<CompletionTaskContext>;
    deliver(owner: CompletionRuleOwner, request: CodexHookContextRequest, deliveryId: string, context: CompletionTaskContext): Promise<void>;
  }) {}

  handle(request: CodexHookContextRequest): Promise<CompletionDeliveryResult[]> {
    if (!AGENT_HOOK_EVENTS.some(event => event.hookEvent === request.eventName) || (request.agentType && request.agentType !== "codex")
      || !request.sessionId?.trim() || !request.turnId?.trim()
      || !request.lastAssistantMessage?.trim()) return Promise.resolve([]);
    const key = JSON.stringify([request.sessionId, request.turnId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = this.deliverMatches(request).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async deliverMatches(request: CodexHookContextRequest): Promise<CompletionDeliveryResult[]> {
    const owners = this.options.rules().filter(({ rule }) => rule.enabled);
    if (!owners.length) return [];
    const identify = this.options.projectIdentity ?? completionProjectIdentity;
    const results: CompletionDeliveryResult[] = [];
    let project: string | undefined;
    const targets = new Set<string>();
    for (const owner of owners) {
      const { rule } = owner;
      try {
        const errors = agentHookRuleErrors(rule);
        if (errors.length) throw new Error(errors.join(" "));
        if (AGENT_HOOK_EVENTS.find(event => event.value === rule.event)?.hookEvent !== request.eventName) continue;
        if (rule.conditions.some(condition =>
          (condition.type === "include_sessions" && !condition.sessions?.some(session => session.id === request.sessionId))
          || (condition.type === "exclude_sessions" && condition.sessions?.some(session => session.id === request.sessionId)))) continue;
        const projectCondition = rule.conditions.find(condition => condition.type === "project");
        if (projectCondition) {
          if (!request.cwd?.trim()) continue;
          project ??= await identify(request.cwd);
          if (await identify(projectCondition.path!) !== project) continue;
        }
        const context = await this.options.taskContext?.(owner, request) ?? { plans: [] };
        if (rule.conditions.some(condition => condition.type === "bound_plan") && context.plans.length === 0) continue;
        const { channel, gatewayId, params } = rule.destination;
        // Preserve group delivery identities when migrating existing rules.
        const target = JSON.stringify(channel === "napcat" && params.target === "group"
          ? [gatewayId, params.instanceId, params.targetId]
          : [gatewayId, channel, params.target || "", params.instanceId || "", params.targetId || params.sessionId || ""]);
        if (targets.has(target)) continue;
        targets.add(target);
        const deliveryId = `agent-completion-${createHash("sha256").update(JSON.stringify([
          request.sessionId, request.turnId, target
        ])).digest("hex")}`;
        await this.options.deliver(owner, request, deliveryId, context);
        results.push({ ruleId: rule.id, status: "sent" });
      } catch (error) {
        results.push({ ruleId: rule.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
}
