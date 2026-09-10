import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { ManagerSourcePatchService, SourcePatchBundleRequest } from "./sourcePatchService.js";
import { SourcePatchCompiler } from "./sourcePatchCompiler.js";
import { HotPatchResourceStore } from "../plugin-kernel/hotPatchResourceStore.js";
import { readSourcePatchCatalog, sourcePatchDependencyHash, type SourcePatchDefinition } from "./sourcePatchCatalog.js";

type CandidateBuilder = (options: Readonly<{ sourcePath: string; sourceContent?: string; outputDirectory: string; resourceData?: HotPatchResourceStore["data"] }>) => Promise<Readonly<{ changed: boolean; sha256: string }>>;

export class SourcePatchWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private watchedFiles = new Set<string>();
  private catalogDirty = false;
  private editSequence = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pending = new Set<string>();
  private readonly lastOperationHash = new Map<string, string>();
  private closed = false;

  private constructor(
    private readonly root: string,
    private definitions: readonly SourcePatchDefinition[],
    private readonly service: ManagerSourcePatchService,
    private readonly runtime: GenerationRuntime,
    private readonly outputDirectory: string,
    private readonly buildCandidate: CandidateBuilder,
    private readonly onError: (error: unknown) => void,
    private readonly compiler: SourcePatchCompiler,
    private dependencyFiles: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}

  static async start(options: Readonly<{ root: string; sourceRoot?: string; service: ManagerSourcePatchService; runtime: GenerationRuntime; outputDirectory: string; enabled?: boolean; onError?: (error: unknown) => void }>): Promise<SourcePatchWatcher | undefined> {
    if (options.enabled === false) return undefined;
    const sourceRoot = await fsp.realpath(options.sourceRoot ?? options.root);
    let definitions: readonly SourcePatchDefinition[];
    try { definitions = await readSourcePatchCatalog(sourceRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") definitions = []; else throw error; }
    const compiler = new SourcePatchCompiler();
    const watcher = new SourcePatchWatcher(sourceRoot, definitions, options.service, options.runtime, options.outputDirectory, compiler.build.bind(compiler), options.onError ?? (() => undefined), compiler, new Map());
    try { await watcher.refreshWatches(definitions); }
    catch (error) { watcher.stop(); throw error; }
    for (const definition of definitions) if (!options.service.status().modules.some(module => module.id === definition.id)) watcher.pending.add(definition.id);
    if (watcher.pending.size) watcher.timer = setTimeout(() => { watcher.timer = undefined; void watcher.apply(); }, 200);
    return watcher;
  }

  private async refreshWatches(definitions: readonly SourcePatchDefinition[]): Promise<void> {
    const dependencyGraph = await this.compiler.inspect(this.root, definitions.map(entry => entry.source));
    const dependencyFiles = new Map(definitions.map((entry, index) => [entry.id, new Set(Object.keys(dependencyGraph.modules[index]!.files))] as const));
    const watchedFiles = new Set([path.join(this.root, "source-patches", "modules.json"), ...definitions.flatMap(entry => [entry.source, ...(entry.resources ?? [])].map(file => path.resolve(this.root, file)))]);
    for (const files of dependencyFiles.values()) for (const file of files) watchedFiles.add(file);
    const directories = new Set<string>();
    for (const file of watchedFiles) {
      let directory = path.dirname(file);
      while (directory !== this.root) {
        try { if ((await fsp.stat(directory)).isDirectory()) break; }
        catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        directory = path.dirname(directory);
      }
      directories.add(directory);
    }
    if (this.closed) return;
    const added = new Map<string, fs.FSWatcher>();
    try {
      for (const directory of directories) {
        if (this.watchers.has(directory)) continue;
        const handle = fs.watch(directory, (_event, filename) => {
          if (filename === null) {
            for (const file of this.watchedFiles) if (file.startsWith(directory + path.sep)) this.schedule(file);
          } else {
            const file = path.resolve(directory, filename.toString());
            for (const watched of this.watchedFiles) if (watched === file || watched.startsWith(file + path.sep)) this.schedule(watched);
          }
        });
        handle.on("error", error => { this.onError(error); this.stop(); });
        added.set(directory, handle);
      }
    } catch (error) { for (const handle of added.values()) handle.close(); throw error; }
    for (const [directory, handle] of added) this.watchers.set(directory, handle);
    for (const [directory, handle] of this.watchers) if (!directories.has(directory)) { handle.close(); this.watchers.delete(directory); }
    this.watchedFiles = watchedFiles;
    this.dependencyFiles = dependencyFiles;
    this.definitions = definitions;
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    clearTimeout(this.timer);
    this.pending.clear();
    void this.compiler.close().catch(this.onError);
  }

  private schedule(changedPath: string): void {
    if (this.closed) return;
    this.editSequence++;
    if (changedPath === path.join(this.root, "source-patches", "modules.json")) this.catalogDirty = true;
    const definitions = this.definitions.filter(entry => path.resolve(this.root, entry.source) === changedPath
      || (entry.resources ?? []).some(resource => path.resolve(this.root, resource) === changedPath)
      || this.dependencyFiles.get(entry.id)?.has(changedPath));
    for (const definition of definitions) this.pending.add(definition.id);
    if (!definitions.length && !this.catalogDirty) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.apply(); }, 200);
  }

  private async apply(): Promise<void> {
    if (this.closed || this.running || (!this.pending.size && !this.catalogDirty)) return;
    this.running = true;
    let definitions: readonly SourcePatchDefinition[] = [];
    const sequence = this.editSequence;
    try {
      if (this.catalogDirty) {
        this.catalogDirty = false;
        const catalog = await readSourcePatchCatalog(this.root);
        await this.refreshWatches(catalog);
        for (const entry of catalog) this.pending.add(entry.id);
      } else { await this.refreshWatches(this.definitions); }
      definitions = this.definitions.filter(definition => this.pending.has(definition.id)).sort((left, right) => left.id.localeCompare(right.id));
      this.pending.clear();
      for (const group of this.groups(definitions)) {
        if (this.closed) return;
        try { await this.applyGroup(group, sequence); }
        catch (error) { if (!this.closed) this.onError(error); }
      }
    } catch (error) {
      if (sequence === this.editSequence) this.pending.clear();
      if (!this.closed) this.onError(error);
    }
    finally {
      this.running = false;
      if ((this.pending.size || this.catalogDirty) && !this.closed && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.apply(); }, 200);
    }
  }

  private groups(definitions: readonly SourcePatchDefinition[]): SourcePatchDefinition[][] {
    const parents = new Map(definitions.map(entry => [entry.id, entry.id]));
    const owners = new Map<string, string>();
    const find = (id: string): string => { while (parents.get(id) !== id) id = parents.get(id)!; return id; };
    for (const entry of definitions) {
      const files = [...(this.dependencyFiles.get(entry.id) ?? []), ...(entry.resources ?? []).map(file => path.resolve(this.root, file))];
      for (const file of files) {
        const owner = owners.get(file);
        if (owner) parents.set(find(entry.id), find(owner));
        else owners.set(file, entry.id);
      }
    }
    const groups = new Map<string, SourcePatchDefinition[]>();
    for (const entry of definitions) {
      const id = find(entry.id);
      const group = groups.get(id) ?? [];
      group.push(entry);
      groups.set(id, group);
    }
    return [...groups.values()];
  }

  private async applyGroup(definitions: readonly SourcePatchDefinition[], sequence: number): Promise<void> {
      const snapshots = await Promise.all(definitions.map(async definition => {
        const sourcePath = path.resolve(this.root, definition.source);
        return { definition, sourcePath, sourceContent: await fsp.readFile(sourcePath, "utf8") };
      }));
      const resources = await HotPatchResourceStore.capture(this.root, [...new Set(definitions.flatMap(definition => definition.resources ?? []))]);
      const entries: SourcePatchBundleRequest["entries"][number][] = [];
      const additions: Array<{ id: string; sha256: string; contract: Readonly<Record<string, unknown>>; dependencies?: Readonly<Record<string, unknown>> }> = [];
      for (const { definition, sourcePath, sourceContent } of snapshots) {
        const resourceStore = new HotPatchResourceStore(Object.fromEntries((definition.resources ?? []).map(name => [name, resources.data[name]!])));
        const candidate = await this.buildCandidate({ sourcePath, sourceContent, outputDirectory: this.outputDirectory, resourceData: resourceStore.data });
        if (this.closed) return;
        const module = this.service.status().modules.find(entry => entry.id === definition.id);
        const contract = { ...(definition.contract ?? {}), resources: resourceStore.hashes };
        if (!module) {
          additions.push({ id: definition.id, sha256: candidate.sha256, contract, dependencies: definition.dependencies });
          continue;
        }
        if (module.state !== "ready" || module.uncertainOperation || !("active" in module) || !module.active || !("activeCandidateSha256" in module)) {
          throw new Error(`Source patch module is unavailable or requires reconciliation: ${definition.id}.`);
        }
        if ("dependencyHash" in module && module.dependencyHash !== sourcePatchDependencyHash(definition.dependencies)) throw new Error(`Source patch dependency changes require an explicit module-owned migration: ${definition.id}.`);
        if (candidate.sha256 === module.activeCandidateSha256 && JSON.stringify(contract) === JSON.stringify(module.active.snapshot.contract ?? {})) continue;
        entries.push({ moduleId: definition.id, candidateSha256: candidate.sha256, expectedRevision: module.active.snapshot.revision, contract });
      }
      if (this.closed) return;
      if (sequence !== this.editSequence) {
        for (const entry of definitions) this.pending.add(entry.id);
        return;
      }
      for (const addition of additions) {
        if (this.closed || sequence !== this.editSequence) {
          for (const entry of definitions) this.pending.add(entry.id);
          return;
        }
        await this.service.ensureModule(addition.id, addition.sha256, addition.contract, addition.dependencies);
      }
      if (!entries.length || this.closed) return;
      const identity = this.runtime.current();
      const binding = {
        applicationGenerationId: identity.applicationGenerationId,
        managerInstanceId: identity.managerInstanceId,
        pluginGenerationId: identity.id,
      };
      const operationHash = createHash("sha256").update(JSON.stringify({ entries, ...binding })).digest("hex");
      const group = entries.map(entry => entry.moduleId).join(",");
      if (this.lastOperationHash.get(group) === operationHash) return;
      this.lastOperationHash.set(group, operationHash);
      const operationId = `auto-${operationHash.slice(0, 32)}`;
      const operation = entries.length === 1
        ? await this.service.publish({ operationId, action: "apply", ...entries[0]!, ...binding })
        : await this.service.publishBundle({ operationId, action: "apply-bundle", entries, ...binding });
      if (operation.state !== "committed") throw new Error(`Automatic source patch ${operationId} is ${operation.state}; it was not retried.`);
  }
}
