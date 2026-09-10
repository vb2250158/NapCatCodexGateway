/** Persona-owned Stop rules. Status keys come from the persona's workflow catalog. */
export type PlanFollowupRule = {
  id: string;
  enabled: boolean;
  statusKeys: string[];
  prompt: string;
};
export type PlanFollowupSettings = {
  enabled: boolean;
  cooldownSeconds: number;
  rules: PlanFollowupRule[];
};

export function normalizePlanFollowup(value: unknown): PlanFollowupSettings {
  const raw = value && typeof value === "object" ? value as Partial<PlanFollowupSettings> : {};
  const ids = new Set<string>();
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).flatMap(rule => {
    if (!rule || typeof rule.id !== "string" || !rule.id.trim() || ids.has(rule.id.trim())) return [];
    ids.add(rule.id.trim());
    return [{ id: rule.id.trim(), enabled: rule.enabled === true,
      statusKeys: [...new Set((Array.isArray(rule.statusKeys) ? rule.statusKeys : [])
        .filter((key): key is string => typeof key === "string" && Boolean(key.trim())).map(key => key.trim()))],
      prompt: typeof rule.prompt === "string" ? rule.prompt.trim().slice(0, 4000) : "" }];
  });
  return { enabled: raw.enabled === true,
    cooldownSeconds: typeof raw.cooldownSeconds === "number" && Number.isFinite(raw.cooldownSeconds)
      ? Math.min(86400, Math.max(0, Math.round(raw.cooldownSeconds))) : 300,
    rules };
}
