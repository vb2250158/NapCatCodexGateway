import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildWebPatch, verifyWebPatch, WEB_PATCH_HASH, WEB_PATCH_PREFIX, webPatchHash, webPatchPath, writeWebPatchJson, type WebPatchManifest } from "./webPatchCatalog.js";
import type { WebPluginModule } from "./webPluginModules.js";

export type WebPatchIdentity = { applicationGenerationId: string; managerInstanceId: string; pluginGenerationId: string };
export type WebPatchRequest = WebPatchIdentity & { operationId: string; candidate: string; expectedRevision: number };
type Receipt = { operationId: string; fingerprint: string; state: "committed"; revision: number; active: string; previous: string };
type State = { schemaVersion: 1; backend: string; active: string; previous?: string; revision: number; operations: Receipt[] };

function validateState(saved: State, backend: string): void {
  if (!saved || saved.schemaVersion !== 1 || saved.backend !== backend || !WEB_PATCH_HASH.test(saved.active)
    || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.operations)
    || saved.operations.length > 2048 || saved.operations.length !== saved.revision) throw new Error("Invalid persisted Web patch state; do not replay.");
  const operations = new Set<string>();
  let previous: Receipt | undefined;
  for (const receipt of saved.operations) {
    if (!receipt || typeof receipt.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.operationId)
      || operations.has(receipt.operationId) || receipt.state !== "committed" || !WEB_PATCH_HASH.test(receipt.active)
      || !WEB_PATCH_HASH.test(receipt.previous) || receipt.revision !== operations.size + 1
      || (previous && receipt.previous !== previous.active)
      || receipt.fingerprint !== webPatchHash(JSON.stringify([receipt.operationId, receipt.active, receipt.revision - 1]))) {
      throw new Error("Invalid persisted Web patch receipt; do not replay.");
    }
    operations.add(receipt.operationId);
    previous = receipt;
  }
  if (previous && (saved.active !== previous.active || saved.previous !== previous.previous)) throw new Error("Web patch state and receipt disagree.");
  if (!previous && saved.previous !== undefined) throw new Error("Invalid initial Web patch state.");
}

export class WebPatchService {
  readonly ready: Promise<void>;
  readonly candidates: string;
  private baseline?: string;
  private state?: State;
  private fault?: string;
  private initializing = true;
  private closed = false;
  private queued = 0;
  private readers = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private importTail: Promise<unknown> = Promise.resolve();
  private pending?: State;
  private readonly manifests = new Map<string, WebPatchManifest>();

  constructor(private readonly options: {
    packageRoot: string; stateRoot: string; identity(): WebPatchIdentity;
    serialize<T>(generation: string, action: () => Promise<T>): Promise<T>;
    audit?(event: string, fields: Record<string, unknown>): void;
  }) {
    this.candidates = path.join(options.stateRoot, "candidates");
    this.ready = this.initialize().catch(error => { this.fault = String(error); }).finally(() => { this.initializing = false; });
  }

  private get statePath(): string { return path.join(this.options.stateRoot, "states", `${this.state!.backend}.json`); }

  private async initialize(): Promise<void> {
    this.baseline = await buildWebPatch(this.options.packageRoot, this.candidates);
    const manifest = await this.manifest(this.baseline);
    this.state = { schemaVersion: 1, backend: manifest.backend, active: this.baseline, revision: 0, operations: [] };
    const raw = await fs.readFile(this.statePath, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw !== undefined) {
      if (raw.length > 2 * 1024 * 1024) throw new Error("Web patch state is too large.");
      const saved = JSON.parse(raw) as State;
      validateState(saved, manifest.backend);
      await this.compatible(saved.active);
      this.state = saved;
    }
  }

  status() {
    return { state: this.fault ? "blocked" : this.initializing ? "starting" : "ready", baseline: this.baseline,
      backend: this.state?.backend, active: this.state?.active, previous: this.state?.previous,
      revision: this.state?.revision, queued: this.queued, activeReads: this.readers, error: this.fault,
      identity: this.options.identity(), limits: { candidateBytes: 128 * 1024 * 1024, operations: 2048, candidates: 64 } };
  }

  operation(id: string): Receipt | undefined {
    const receipt = this.state?.operations.find(record => record.operationId === id);
    return receipt ? structuredClone(receipt) : undefined;
  }

  private async manifest(revision: string): Promise<WebPatchManifest> {
    if (!WEB_PATCH_HASH.test(revision)) throw new Error("Invalid Web release revision.");
    const cached = this.manifests.get(revision);
    if (cached) return cached;
    const result = await verifyWebPatch(path.join(this.candidates, revision), revision);
    if (this.manifests.size >= 8) this.manifests.delete(this.manifests.keys().next().value!);
    this.manifests.set(revision, result);
    return result;
  }

  private async compatible(revision: string): Promise<WebPatchManifest> {
    const manifest = await this.manifest(revision);
    if (this.state && manifest.backend !== this.state.backend) throw new Error("Web patch backend changed; a coordinated full release is required.");
    return manifest;
  }

  async importCandidate(source: string, revision: string): Promise<void> {
    const result = this.importTail.then(() => this.copyCandidate(source, revision));
    this.importTail = result.catch(() => undefined);
    return result;
  }

  private async copyCandidate(source: string, revision: string): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error("Web patch service is closed.");
    const manifest = await verifyWebPatch(source, revision);
    if (!this.state || this.fault || manifest.backend !== this.state.backend) throw new Error("Web patch backend is incompatible or unavailable.");
    const destination = path.join(this.candidates, revision);
    if (await fs.stat(destination).catch(() => undefined)) { await verifyWebPatch(destination, revision); return; }
    if ((await fs.readdir(this.candidates)).filter(name => WEB_PATCH_HASH.test(name)).length >= 64) throw new Error("Web revision retention limit reached; retain current service and review old revisions offline.");
    const temporary = path.join(this.candidates, `.import-${randomUUID()}`);
    try {
      await fs.mkdir(temporary, { recursive: true });
      for (const file of manifest.files) {
        const target = path.join(temporary, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(source, file.path), target);
      }
      await fs.copyFile(path.join(source, "manifest.json"), path.join(temporary, "manifest.json"));
      await verifyWebPatch(temporary, revision);
      try { await fs.rename(temporary, destination); }
      catch (error) { if (!await fs.stat(destination).catch(() => undefined)) throw error; await verifyWebPatch(destination, revision); }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  async publish(input: WebPatchRequest): Promise<Receipt> {
    if (!input || typeof input.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.operationId) || !WEB_PATCH_HASH.test(input.candidate)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid Web patch publication.");
    if (this.closed || this.queued >= 8) throw new Error("Web patch publication is unavailable or busy.");
    const request = structuredClone(input);
    const fingerprint = webPatchHash(JSON.stringify([request.operationId, request.candidate, request.expectedRevision]));
    this.queued++;
    try {
      const result = this.tail.then(async () => {
        await this.ready;
        if (!this.state || this.fault) throw new Error("Web patch state is unavailable; query the original operation.");
        const identity = this.options.identity();
        if (Object.keys(identity).some(key => request[key as keyof WebPatchIdentity] !== identity[key as keyof WebPatchIdentity])) throw new Error("Web patch runtime identity changed.");
        const original = this.operation(request.operationId);
        if (original) { if (original.fingerprint !== fingerprint) throw new Error("Web patch operation payload conflict."); return original; }
        await this.compatible(request.candidate);
        return this.options.serialize(request.pluginGenerationId, async () => {
          if (this.closed || request.expectedRevision !== this.state!.revision) throw new Error("Web patch baseline changed.");
          if (this.state!.operations.length >= 2048) throw new Error("Web patch receipt limit reached; no history is silently discarded.");
          const receipt: Receipt = { operationId: request.operationId, fingerprint, state: "committed", revision: this.state!.revision + 1,
            active: request.candidate, previous: this.state!.active };
          const next: State = { ...this.state!, active: receipt.active, previous: receipt.previous, revision: receipt.revision,
            operations: [...this.state!.operations, receipt] };
          this.pending = next;
          try { await writeWebPatchJson(this.statePath, next); }
          catch (error) {
            const saved = await fs.readFile(this.statePath, "utf8").catch(() => undefined);
            if (saved !== JSON.stringify(next)) { this.fault = "Publication persistence is unconfirmed; do not replay."; throw error; }
          }
          this.state = next;
          this.pending = undefined;
          this.options.audit?.("web_patch_committed", { operationId: receipt.operationId, revision: receipt.revision, active: receipt.active, previous: receipt.previous });
          return structuredClone(receipt);
        });
      });
      this.tail = result.catch(() => undefined);
      return await result;
    } finally { this.queued--; }
  }

  async reconcile(operationId: string): Promise<{ state: "committed" | "not_started" | "unknown"; receipt?: Receipt }> {
    await this.tail;
    const existing = this.operation(operationId);
    if (existing) return { state: "committed", receipt: existing };
    if (!this.state || !this.pending || this.pending.operations.at(-1)?.operationId !== operationId) return { state: this.fault ? "unknown" : "not_started" };
    const raw = await fs.readFile(this.statePath, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === JSON.stringify(this.pending)) {
      await this.compatible(this.pending.active);
      this.state = this.pending;
      this.pending = undefined;
      this.fault = undefined;
      return { state: "committed", receipt: this.operation(operationId) };
    }
    if (raw === JSON.stringify(this.state) || (raw === undefined && this.state.revision === 0)) {
      this.pending = undefined;
      this.fault = undefined;
      return { state: "not_started" };
    }
    return { state: "unknown" };
  }

  async automatic(sourceRoot: string): Promise<void> {
    const pointerPath = path.join(sourceRoot, "dist/web-patches/latest.json");
    const raw = await fs.readFile(pointerPath, "utf8");
    if (raw.length > 4096) throw new Error("Web patch build marker is too large.");
    const pointer = JSON.parse(raw) as { revision: string; operationId: string };
    if (!WEB_PATCH_HASH.test(pointer.revision) || !/^[A-Za-z0-9_-]{1,128}$/.test(pointer.operationId)) throw new Error("Invalid Web patch build marker.");
    await this.ready;
    if (!this.state || this.fault || this.operation(pointer.operationId) || pointer.revision === this.state.active) return;
    await this.importCandidate(path.join(sourceRoot, "dist/web-patches", pointer.revision), pointer.revision);
    if (await fs.readFile(pointerPath, "utf8") !== raw) return;
    await this.publish({ ...this.options.identity(), operationId: pointer.operationId, candidate: pointer.revision, expectedRevision: this.state.revision });
  }

  async document(): Promise<{ revision: string; body: string } | undefined> {
    if (!this.state) return undefined;
    const revision = this.state.active;
    const source = (await this.read(revision, "web/index.html")).body.toString();
    const body = source.replace(/(<html\b)/i, `$1 data-rabi-web-release="${revision}"`)
      .replace(/((?:src|href)=["'])((?:\.\/|\/)?assets\/[^"']+)/g, (_match, prefix, asset: string) => `${prefix}${WEB_PATCH_PREFIX}${revision}/web/${asset.replace(/^\.?\//, "")}`);
    return { revision, body };
  }

  async read(revision: string, filename: string): Promise<{ body: Buffer; path: string; revision: string }> {
    webPatchPath(filename);
    this.readers++;
    try {
      const manifest = await this.compatible(revision);
      const file = manifest.files.find(entry => entry.path === filename);
      if (!file) throw new Error("Web patch asset was not found.");
      const body = await fs.readFile(path.join(this.candidates, revision, filename));
      if (webPatchHash(body) !== file.sha256) throw new Error("Web patch asset integrity failed.");
      return { body, path: filename, revision };
    } finally { this.readers--; }
  }

  async modules(modules: readonly WebPluginModule[], revision?: string | null): Promise<readonly WebPluginModule[]> {
    if (!revision) return modules;
    const manifest = await this.compatible(revision);
    return modules.map(module => manifest.modules.some(entry => entry.pluginId === module.pluginId && entry.version === module.version)
      ? { ...module, rev: revision, entryPath: "web/client.mjs" } : module);
  }

  async module(modules: readonly WebPluginModule[], id: string, revision: string, filename: string) {
    if (filename !== "web/client.mjs") return undefined;
    const module = modules.find(entry => entry.id === id);
    if (!module) return undefined;
    let manifest: WebPatchManifest;
    try { manifest = await this.compatible(revision); }
    catch { return undefined; }
    const entry = manifest.modules.find(item => item.pluginId === module.pluginId && item.version === module.version);
    if (!entry) return undefined;
    return { module: { ...module, rev: revision, entryPath: filename }, path: filename,
      source: Buffer.from(`export { activate } from "${WEB_PATCH_PREFIX}${revision}/${entry.entry}";\n`) };
  }

  async stop(): Promise<void> { this.closed = true; await Promise.all([this.ready, this.tail, this.importTail]); }
}
