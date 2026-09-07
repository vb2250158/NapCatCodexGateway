export type RouteCatalogMutationKind = "save" | "delete";

export type PendingRouteCatalogMutation = Readonly<{
  kind: RouteCatalogMutationKind;
  signature: string;
  operationId: string;
  expectedContentHash: string;
}>;

export const ROUTE_CATALOG_PENDING_STORAGE_KEY = "rabiroute.route-catalog.pending.v2";
// Route-catalog writes run in a dedicated Manager worker. Its request fence
// is 30 seconds, so the browser must not abandon an otherwise valid commit
// before that worker can return its durable receipt.
export const GATEWAY_MUTATION_TIMEOUT_MS = 35_000;

export function routeCatalogMutationFailureIsDefinitive(statusCode: number): boolean {
  return Number.isInteger(statusCode)
    && statusCode >= 400
    && statusCode < 500
    && ![408, 425, 429, 499].includes(statusCode);
}

type RouteCatalogMutationStorage = Pick<Storage, "getItem" | "setItem">;

function safeSessionStorage(): RouteCatalogMutationStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export async function boundedRouteCatalogMutationFetch(
  path: string,
  init: RequestInit,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? GATEWAY_MUTATION_TIMEOUT_MS;
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (options.fetchImpl ?? globalThis.fetch)(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Manager mutation timed out after ${timeoutMs}ms; retry will reuse the same Idempotency-Key.`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const fields = Object.keys(row)
      .filter((key) => row[key] !== undefined && typeof row[key] !== "function" && typeof row[key] !== "symbol")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`Route catalog mutation contains a non-JSON value: ${typeof value}`);
}

export async function canonicalRouteCatalogMutationSignature(
  value: unknown,
  cryptoProvider: Crypto = globalThis.crypto
): Promise<string> {
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto SHA-256 is required for Route mutation idempotency.");
  const digest = await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPendingMutation(value: unknown): value is PendingRouteCatalogMutation {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingRouteCatalogMutation>;
  return (row.kind === "save" || row.kind === "delete")
    && /^[a-f0-9]{64}$/.test(String(row.signature || ""))
    && /^[A-Za-z0-9:._-]{1,256}$/.test(String(row.operationId || ""))
    && /^[a-f0-9]{64}$/.test(String(row.expectedContentHash || ""));
}

export class RouteCatalogMutationLedger {
  private readonly memory = new Map<string, PendingRouteCatalogMutation>();
  private readonly storage: RouteCatalogMutationStorage | null;

  constructor(
    storage: RouteCatalogMutationStorage | null | undefined = undefined,
    private readonly cryptoProvider: Crypto = globalThis.crypto
  ) {
    this.storage = storage === undefined ? safeSessionStorage() : storage;
  }

  private key(kind: RouteCatalogMutationKind, signature: string): string {
    return `${kind}\u0000${signature}`;
  }

  private snapshot(): Map<string, PendingRouteCatalogMutation> {
    const result = new Map<string, PendingRouteCatalogMutation>();
    try {
      const parsed = JSON.parse(this.storage?.getItem(ROUTE_CATALOG_PENDING_STORAGE_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isPendingMutation(value)) result.set(key, value);
        }
      }
    } catch {
      // The in-memory ledger remains the page-session source of truth.
    }
    for (const [key, value] of this.memory) result.set(key, value);
    return result;
  }

  private persist(snapshot: Map<string, PendingRouteCatalogMutation>): void {
    this.memory.clear();
    for (const [key, value] of snapshot) this.memory.set(key, value);
    try {
      this.storage?.setItem(ROUTE_CATALOG_PENDING_STORAGE_KEY, JSON.stringify(Object.fromEntries(snapshot)));
    } catch {
      // Memory was updated first, so retries still reuse the operation id.
    }
  }

  async retain(
    kind: RouteCatalogMutationKind,
    value: unknown,
    currentContentHash: string
  ): Promise<PendingRouteCatalogMutation> {
    const signature = await canonicalRouteCatalogMutationSignature(value, this.cryptoProvider);
    const snapshot = this.snapshot();
    const key = this.key(kind, signature);
    const existing = snapshot.get(key);
    if (existing) {
      if (snapshot.size !== 1) {
        throw new Error("Multiple unresolved Route catalog mutations were found; reload before changing the catalog.");
      }
      this.persist(snapshot);
      return existing;
    }
    if (snapshot.size > 0) {
      throw new Error("A Route catalog mutation is still unresolved; retry the same change before submitting another catalog mutation.");
    }
    const expectedContentHash = String(currentContentHash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) {
      throw new Error("A current Route catalog routeConfigHash is required for a new mutation.");
    }
    const operationId = `route-catalog:${kind}:${this.cryptoProvider.randomUUID()}`;
    const pending = Object.freeze({ kind, signature, operationId, expectedContentHash });
    snapshot.set(key, pending);
    this.persist(snapshot);
    return pending;
  }

  complete(pending: PendingRouteCatalogMutation): void {
    const snapshot = this.snapshot();
    const key = this.key(pending.kind, pending.signature);
    if (snapshot.get(key)?.operationId === pending.operationId) snapshot.delete(key);
    this.persist(snapshot);
  }
}

export function committedRouteCatalogRevision(
  value: unknown,
  pending: PendingRouteCatalogMutation
): string {
  if (!value || typeof value !== "object") {
    throw new Error("Manager Route mutation response is not an object.");
  }
  const body = value as {
    receipt?: { state?: unknown; operationId?: unknown; routeConfigHash?: unknown };
    routeCatalog?: { routeConfigHash?: unknown };
  };
  const state = String(body.receipt?.state || "").trim().toLowerCase();
  const operationId = String(body.receipt?.operationId || "").trim();
  const receiptRevision = String(body.receipt?.routeConfigHash || "").trim().toLowerCase();
  const catalogRevision = String(body.routeCatalog?.routeConfigHash || "").trim().toLowerCase();
  if (state !== "committed" || operationId !== pending.operationId) {
    throw new Error("Manager Route mutation response is missing a matching committed receipt.");
  }
  if (!/^[a-f0-9]{64}$/.test(receiptRevision)
    || !/^[a-f0-9]{64}$/.test(catalogRevision)
    || receiptRevision !== catalogRevision) {
    throw new Error("Manager Route mutation response is missing one strong committed routeConfigHash.");
  }
  return receiptRevision;
}
