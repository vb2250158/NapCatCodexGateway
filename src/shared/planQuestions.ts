import { RoleStorageValidationError } from "./roleStorageValidationError.js";

export type PlanQuestion = {
  id: string;
  prompt: string;
  context?: string;
  options: { id: string; label: string; description?: string; recommended?: boolean; requiresText?: boolean }[];
  placeholder?: string;
  required: boolean;
  requireOption?: boolean;
};
export type PlanQuestionAnswer = { optionId?: string; text?: string };

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
  const ids = new Set<string>();
  return (value as unknown[]).map(v => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail("invalid question.");
    const q = v as Record<string, unknown>, id = text(q.id, 100, true);
    if (ids.has(id)) fail("duplicate question id.");
    ids.add(id);
    if (q.required !== undefined && typeof q.required !== "boolean") fail("required must be boolean.");
    if (q.requireOption !== undefined && typeof q.requireOption !== "boolean") fail("requireOption must be boolean.");
    const raw = q.options ?? [];
    if (!Array.isArray(raw) || raw.length > 6) fail("expected at most 6 options.");
    const optionIds = new Set<string>();
    const options = (raw as unknown[]).map(v => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return fail("invalid option.");
      const o = v as Record<string, unknown>, optionId = text(o.id, 100, true);
      if (optionIds.has(optionId)) fail("duplicate option id.");
      optionIds.add(optionId);
      if (o.recommended !== undefined && typeof o.recommended !== "boolean") fail("recommended must be boolean.");
      if (o.requiresText !== undefined && typeof o.requiresText !== "boolean") fail("requiresText must be boolean.");
      return { requiresText: o.requiresText === true, id: optionId, label: text(o.label, 200, true), description: text(o.description, 500) || undefined, recommended: o.recommended === true };
    });
    return { requireOption: q.requireOption === true, id, prompt: text(q.prompt, 500, true), context: text(q.context, 1000) || undefined, options,
      placeholder: text(q.placeholder, 300) || undefined, required: q.required !== false };
  });
}

/** Preserve the question and chosen label in the existing durable feedback text. */
export function planQuestionReply(questions: PlanQuestion[], answers: Record<string, PlanQuestionAnswer>): { text: string; valid: boolean } {
  let valid = true;
  const parts: string[] = [];
  for (const q of questions) {
    const a = answers[q.id] ?? {}, text = (a.text ?? "").trim();
    const option = q.options.find(o => o.id === a.optionId);
    if ((a.optionId && !option) || (q.required && !option && !text) || (q.requireOption && !option) || (option?.requiresText && !text)) valid = false;
    if (option || text) parts.push(`${q.prompt}\n${[option?.label, text].filter(Boolean).join("\n")}`);
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
