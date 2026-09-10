import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HotPatchBundleJournalRecord = Readonly<{
  operationId: string;
  fingerprint: string;
  state: "pending" | "committed" | "indeterminate" | "failed";
  updatedAt: string;
  result?: unknown;
  error?: string;
}>;

export class HotPatchBundleJournal {
  constructor(private readonly root: string) {}

  async begin(operationId: string, payload: unknown, requireNew = false): Promise<HotPatchBundleJournalRecord> {
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const file = this.file(operationId);
    return this.withLock(file, async () => {
    try {
      const current = JSON.parse(await fs.readFile(file, "utf8")) as HotPatchBundleJournalRecord;
      if (current.fingerprint !== fingerprint) throw new Error("Hot patch bundle operation ID was reused with different contents.");
      if (requireNew) throw new Error("Hot patch bundle operation already exists; reconcile the original operation without replaying it.");
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const record: HotPatchBundleJournalRecord = { operationId, fingerprint, state: "pending", updatedAt: new Date().toISOString() };
    await this.write(file, record);
    return record;
    });
  }

  async mark(operationId: string, state: HotPatchBundleJournalRecord["state"], result?: unknown, error?: unknown): Promise<HotPatchBundleJournalRecord> {
    const file = this.file(operationId);
    return this.withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, "utf8")) as HotPatchBundleJournalRecord;
    if (current.state !== "pending") {
      if (current.state === state) return current;
      throw new Error(`Hot patch bundle journal outcome is already recorded (${current.state}).`);
    }
    if (state === "pending") throw new Error("Hot patch bundle journal cannot reset a pending operation.");
    const next: HotPatchBundleJournalRecord = { ...current, state, updatedAt: new Date().toISOString(), result, error: error instanceof Error ? error.message : error === undefined ? undefined : String(error) };
    await this.write(file, next);
    return next;
    });
  }

  async read(operationId: string): Promise<HotPatchBundleJournalRecord | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(operationId), "utf8")) as HotPatchBundleJournalRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private file(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) throw new Error("Invalid hot patch bundle operation ID.");
    return path.join(this.root, `${operationId}.json`);
  }

  private async write(file: string, value: HotPatchBundleJournalRecord): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx");
      try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  private async withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.root, { recursive: true });
    const lock = `${file}.lock`;
    const deadline = Date.now() + 5_000;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    while (true) {
      try { handle = await fs.open(lock, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Hot patch bundle journal is locked; inspect the original owner before recovery.");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await action(); }
    finally { await handle.close(); await fs.unlink(lock); }
  }
}
