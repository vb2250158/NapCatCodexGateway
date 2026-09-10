import { canonicalJson } from "./routeCatalogMutationLedger";

export function sameGatewayValue(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined
    ? left === right
    : canonicalJson(left) === canonicalJson(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge independent edits; arrays are atomic and overlapping changes fail closed. */
export function mergeGatewayDraft<T>(base: T, draft: T, current: T, field = "配置"): T {
  if (sameGatewayValue(base, draft)) return current;
  if (sameGatewayValue(base, current) || sameGatewayValue(draft, current)) return draft;
  if (isRecord(base) && isRecord(draft) && isRecord(current)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(current)])) {
      const value = mergeGatewayDraft(base[key], draft[key], current[key], `${field}.${key}`);
      if (value !== undefined) result[key] = value;
    }
    return result as T;
  }
  throw new Error(`配置冲突：${field} 已被其他操作修改。请核对最新配置后重试。`);
}

export function cloneGatewayValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
