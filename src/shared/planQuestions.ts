import { RoleStorageValidationError } from "./roleStorageValidationError.js";

/** 审批明细只保存实际修改，界面按题或方案折叠显示。 */
export type PlanImplementation = {
  changes: { kind: "code" | "prefab" | "art" | "configuration" | "other"; path: string; target?: string; change: string }[];
  validation?: string;
  rollback?: string;
};

export type PlanQuestion = {
  id: string;
  prompt: string;
  context?: string;
  selectionMode?: "single" | "multiple";
  implementation?: PlanImplementation;
  options: { id: string; label: string; description?: string; recommended?: boolean; requiresText?: boolean; exclusive?: boolean; implementation?: PlanImplementation }[];
  placeholder?: string;
  required: boolean;
  requireOption?: boolean;
};
export type PlanQuestionAnswer = { optionId?: string; optionIds?: string[]; text?: string };

/** Questions belong to the current plan step; an empty option list is a text question. */
export function normalizePlanQuestions(value: unknown): PlanQuestion[] {
  if (value == null) return [];
  const fail = (message: string): never => { throw new RoleStorageValidationError(`Plan questions: ${message}`); };
  if (!Array.isArray(value) || value.length > 5) fail("expected at most 5 questions.");
  const text = (v: unknown, max: number, required = false): string => {
    if (v == null && !required) return "";
    if (typeof v !== "string" || v.length > max || (required && !v.trim())) return fail("invalid or oversized text.");
    return v.trim();
  };
  const implementation = (value: unknown): PlanImplementation | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid implementation.");
    const item = value as Record<string, unknown>;
    if (!Array.isArray(item.changes) || !item.changes.length || item.changes.length > 30) return fail("implementation requires 1 to 30 changes.");
    const changes = item.changes.map((value): PlanImplementation["changes"][number] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid implementation change.");
      const change = value as Record<string, unknown>;
      const kind = change.kind;
      if (kind !== "code" && kind !== "prefab" && kind !== "art" && kind !== "configuration" && kind !== "other") return fail("invalid implementation change kind.");
      return { kind, path: text(change.path, 1000, true), target: text(change.target, 500) || undefined, change: text(change.change, 3000, true) };
    });
    return { changes, validation: text(item.validation, 3000) || undefined, rollback: text(item.rollback, 3000) || undefined };
  };
  const ids = new Set<string>();
  return (value as unknown[]).map(v => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail("invalid question.");
    const q = v as Record<string, unknown>, id = text(q.id, 100, true);
    if (ids.has(id)) fail("duplicate question id.");
    ids.add(id);
    if (q.required !== undefined && typeof q.required !== "boolean") fail("required must be boolean.");
    if (q.requireOption !== undefined && typeof q.requireOption !== "boolean") fail("requireOption must be boolean.");
    const selectionMode = q.selectionMode ?? "single";
    if (selectionMode !== "single" && selectionMode !== "multiple") fail("selectionMode must be single or multiple.");
    const raw = q.options ?? [];
    if (!Array.isArray(raw) || raw.length > 6) return fail("expected at most 6 options.");
    if (selectionMode === "multiple" && raw.length === 0) fail("multiple selection requires options.");
    const optionIds = new Set<string>();
    const options = (raw as unknown[]).map(v => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return fail("invalid option.");
      const o = v as Record<string, unknown>, optionId = text(o.id, 100, true);
      if (optionIds.has(optionId)) fail("duplicate option id.");
      optionIds.add(optionId);
      if (o.recommended !== undefined && typeof o.recommended !== "boolean") fail("recommended must be boolean.");
      if (o.requiresText !== undefined && typeof o.requiresText !== "boolean") fail("requiresText must be boolean.");
      if (o.exclusive !== undefined && typeof o.exclusive !== "boolean") fail("exclusive must be boolean.");
      return { implementation: implementation(o.implementation), exclusive: o.exclusive === true, requiresText: o.requiresText === true, id: optionId, label: text(o.label, 200, true), description: text(o.description, 500) || undefined, recommended: o.recommended === true };
    });
    return { implementation: implementation(q.implementation), selectionMode: selectionMode as "single" | "multiple", requireOption: q.requireOption === true, id, prompt: text(q.prompt, 500, true), context: text(q.context, 1000) || undefined, options,
      placeholder: text(q.placeholder, 300) || undefined, required: q.required !== false };
  });
}

/** 多选允许独立变更组合；保持现状等 exclusive 选项与其它选项互斥。 */
export function selectPlanQuestionOption(question: PlanQuestion, answer: PlanQuestionAnswer, optionId: string): PlanQuestionAnswer {
  const option = question.options.find(candidate => candidate.id === optionId);
  if (!option) return answer;
  if (question.selectionMode !== "multiple") return { text: answer.text, optionId };
  const selected = answer.optionIds ?? [];
  const optionIds = selected.includes(optionId)
    ? selected.filter(id => id !== optionId)
    : option.exclusive
      ? [optionId]
      : [...selected.filter(id => !question.options.find(candidate => candidate.id === id)?.exclusive), optionId];
  return { text: answer.text, optionIds };
}

/** 按题保留所有已选标签和补充说明，继续使用现有持久反馈通道。 */
export function planQuestionReply(questions: PlanQuestion[], answers: Record<string, PlanQuestionAnswer>): { text: string; valid: boolean } {
  let valid = true;
  const parts: string[] = [];
  for (const q of questions) {
    const answer = answers[q.id] ?? {};
    if (typeof answer !== "object" || Array.isArray(answer)) { valid = false; continue; }
    if (answer.optionId !== undefined && typeof answer.optionId !== "string") { valid = false; continue; }
    if (answer.text !== undefined && typeof answer.text !== "string") { valid = false; continue; }
    const text = (answer.text ?? "").trim();
    const multiple = q.selectionMode === "multiple";
    const ids = multiple ? (answer.optionIds ?? []) : (answer.optionId ? [answer.optionId] : []);
    if ((multiple ? answer.optionId !== undefined : answer.optionIds !== undefined) ||
        !Array.isArray(ids) || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) {
      valid = false;
      continue;
    }
    const options = q.options.filter(option => ids.includes(option.id));
    if (options.length !== ids.length || (options.length > 1 && options.some(option => option.exclusive)) ||
        (q.required && !options.length && !text) || (q.requireOption && !options.length) ||
        (options.some(option => option.requiresText) && !text)) valid = false;
    if (options.length || text) parts.push(`${q.prompt}\n${[...options.map(option => option.label), text].filter(Boolean).join("\n")}`);
  }
  return { text: parts.join("\n\n"), valid };
}

/** Agent-authored choices take precedence; use the default decision only when none exist. */
export function approvalDecisionQuestions(questions: PlanQuestion[], translate: (text: string) => string = text => text): PlanQuestion[] {
  const supplied = questions.map(q => ({ ...q, id: `question:${q.id}` }));
  if (questions.some(q => q.options.length > 0)) return supplied;
  return [{ id: "approval-decision", prompt: translate("请选择审批意见"), required: true, requireOption: true,
    options: [{ id: "execute", label: translate("按此方案执行") },
      { id: "suggest", label: translate("提出审批建议"), requiresText: true }],
    placeholder: translate("选择提出审批建议时，请填写具体建议") },
    ...supplied];
}
