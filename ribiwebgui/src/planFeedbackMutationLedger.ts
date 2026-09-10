export type PendingPlanFeedbackIntent = Readonly<{
  roleId: string;
  planId: string;
  signature: string;
  feedbackId: string;
}>;

export const PLAN_FEEDBACK_PENDING_STORAGE_KEY = "rabiroute.plan-feedback.pending.v1";

type PlanFeedbackMutationStorage = Pick<Storage, "getItem" | "setItem">;

function safeSessionStorage(): PlanFeedbackMutationStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isPendingIntent(value: unknown): value is PendingPlanFeedbackIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<PendingPlanFeedbackIntent>;
  return Boolean(
    String(intent.roleId || "").trim()
    && String(intent.planId || "").trim()
    && /^[a-f0-9]{64}$/.test(String(intent.signature || ""))
    && /^[A-Za-z0-9._:-]{1,170}$/.test(String(intent.feedbackId || ""))
  );
}

export class PlanFeedbackMutationLedger {
  private readonly memory = new Map<string, PendingPlanFeedbackIntent>();
  private readonly storage: PlanFeedbackMutationStorage | null;

  constructor(
    storage: PlanFeedbackMutationStorage | null | undefined = undefined,
    private readonly cryptoProvider: Pick<Crypto, "randomUUID"> = globalThis.crypto
  ) {
    this.storage = storage === undefined ? safeSessionStorage() : storage;
  }

  private key(roleId: string, planId: string): string {
    return `${roleId}\u0000${planId}`;
  }

  private snapshot(): Map<string, PendingPlanFeedbackIntent> {
    const result = new Map<string, PendingPlanFeedbackIntent>();
    try {
      const parsed = JSON.parse(this.storage?.getItem(PLAN_FEEDBACK_PENDING_STORAGE_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isPendingIntent(value)) result.set(key, value);
        }
      }
    } catch {
      // The module ledger remains available for the lifetime of this page session.
    }
    for (const [key, value] of this.memory) result.set(key, value);
    return result;
  }

  private persist(snapshot: Map<string, PendingPlanFeedbackIntent>): void {
    this.memory.clear();
    for (const [key, value] of snapshot) this.memory.set(key, value);
    try {
      this.storage?.setItem(PLAN_FEEDBACK_PENDING_STORAGE_KEY, JSON.stringify(Object.fromEntries(snapshot)));
    } catch {
      // Memory is updated first so a remounted component can still reuse the feedbackId.
    }
  }

  retain(roleId: string, planId: string, signature: string): PendingPlanFeedbackIntent {
    const normalizedRoleId = String(roleId || "").trim();
    const normalizedPlanId = String(planId || "").trim();
    if (!normalizedRoleId || !normalizedPlanId || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new Error("Plan feedback mutation identity is invalid.");
    }
    const snapshot = this.snapshot();
    const key = this.key(normalizedRoleId, normalizedPlanId);
    const existing = snapshot.get(key);
    if (existing?.signature === signature) {
      this.persist(snapshot);
      return existing;
    }
    if (existing) {
      throw new Error("Plan feedback is still unresolved; retry the same content before submitting edited feedback.");
    }
    const feedbackId = typeof this.cryptoProvider?.randomUUID === "function"
      ? this.cryptoProvider.randomUUID()
      : `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pending = Object.freeze({ roleId: normalizedRoleId, planId: normalizedPlanId, signature, feedbackId });
    snapshot.set(key, pending);
    this.persist(snapshot);
    return pending;
  }

  complete(roleId: string, planId: string): void {
    const snapshot = this.snapshot();
    snapshot.delete(this.key(String(roleId || "").trim(), String(planId || "").trim()));
    this.persist(snapshot);
  }
}

export const planFeedbackMutationLedger = new PlanFeedbackMutationLedger();
