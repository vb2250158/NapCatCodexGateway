import { createHash } from "node:crypto";
import type { PlanItem } from "../roleKnowledge.js";
import type { PersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { normalizePlanFollowup } from "../shared/planFollowup.js";

export type PlanFollowupReceipt = { fingerprint: string; turnId: string; at: number };
export function decidePlanFollowup(input: {
  config: unknown; workflow: PersonaPlanWorkflow; plan: PlanItem;
  sessionId: string; turnId?: string; stopHookActive?: boolean;
  previous?: PlanFollowupReceipt; now: number;
}): { reason: string; receipt: PlanFollowupReceipt } | null {
  const settings = normalizePlanFollowup(input.config);
  const { plan, previous } = input;
  if (!settings.enabled || input.stopHookActive || !input.turnId
    || plan.taskBinding?.agentType !== "codex" || plan.taskBinding.sessionId !== input.sessionId
    || plan.archiveStatus === "已归档") return null;
  const status = input.workflow.statuses.find(item => item.key === plan.status && item.state === "enabled");
  // Terminal plans never become implementation work merely because a rule matches.
  if (!status || status.terminal) return null;
  const rule = settings.rules.find(item => item.enabled && item.prompt && item.statusKeys.includes(plan.status));
  if (!rule) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    rule, status: plan.status, currentStepId: plan.currentStepId, steps: plan.steps,
    nextAction: plan.nextAction, waitingFor: plan.waitingFor, blockedBy: plan.blockedBy
  })).digest("hex");
  if (previous && (previous.turnId === input.turnId || previous.fingerprint === fingerprint
    || input.now - previous.at < settings.cooldownSeconds * 1000)) return null;
  return {
    reason: `人格自动化追问 · ${plan.title} · ${status.label}\n${rule.prompt}\n仅在当前授权内推进；外部依赖没有变化且无独立工作时，可记录阻塞并结束本轮。`,
    receipt: { fingerprint, turnId: input.turnId, at: input.now }
  };
}
