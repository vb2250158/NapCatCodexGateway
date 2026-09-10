import fs from "node:fs";

/** Target-owned grants apply to the entire trusted RabiLink application. */
export function readRabiPeerAccess(file: string): { operations: string[]; roleIds: string[] } {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 64 * 1024) return { operations: [], roleIds: [] };
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.schemaVersion !== 1 || !Array.isArray(value.operations) || !Array.isArray(value.roleIds)
      || !value.operations.every((item: unknown) => typeof item === "string")
      || !value.roleIds.every((item: unknown) => typeof item === "string" && /^[\p{L}\p{N}_-]{1,100}$/u.test(item))) return { operations: [], roleIds: [] };
    return { operations: value.operations, roleIds: value.roleIds };
  } catch { return { operations: [], roleIds: [] }; }
}
