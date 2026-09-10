import { Script } from "node:vm";
import { HotPatchRuntime, type HotPatchChange, type HotPatchImplementation, type HotPatchStateMigration } from "./hotPatchRuntime.js";
import type { HotPatchResourceData } from "./hotPatchResourceStore.js";

export type HotPatchSourceMap = Readonly<Record<string, unknown>>;

export type CompiledHotPatchModule = Readonly<{
  schemaVersion: 1;
  sourceHash: string;
  compatibilityHash: string;
  implementations: Readonly<Record<string, string>>;
  sourceMaps: Readonly<Record<string, HotPatchSourceMap>>;
  dependencies: readonly string[];
  functionNames: readonly string[];
  initializationSource: string;
  environmentDescriptors: string;
  exported: readonly string[];
  resources?: HotPatchResourceData;
}>;

export class HotPatchModule {
  readonly runtime: HotPatchRuntime;
  readonly exports: Readonly<Record<string, unknown>>;
  private compiled: CompiledHotPatchModule;
  private previous?: CompiledHotPatchModule;

  constructor(readonly id: string, compiled: CompiledHotPatchModule, dependencies: Readonly<Record<string, unknown>> = {}, contract: Readonly<Record<string, unknown>> = {}) {
    this.runtime = new HotPatchRuntime(32, contract, compiled.resources);
    const resolvedDependencies: Record<string, unknown> = { ...dependencies };
    if (Object.hasOwn(resolvedDependencies, "__rabiResources")) throw new Error("Hot patch resources are a runtime-owned dependency.");
    if (compiled.dependencies.includes("__rabiResources")) {
      resolvedDependencies.__rabiResources = Object.freeze({
        read: (path: string) => this.runtime.readResource(path),
        text: (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(this.runtime.readResource(path))
      });
    }
    if (compiled.schemaVersion !== 1 || !id.trim()) throw new Error("Invalid hot patch module identity or schema.");
    this.compiled = compiled;
    const names = Object.keys(compiled.implementations);
    for (const name of compiled.dependencies) {
      if (!Object.hasOwn(resolvedDependencies, name)) throw new Error(`Missing hot patch dependency: ${name}`);
    }
    for (const name of names) this.runtime.register(name, compileImplementation(compiled.implementations[name]!, id));
    const factorySource = `(function(__rabiPatchRuntime,__rabiPatchDependencies){"use strict";
      ${compiled.dependencies.map(name => `const ${name}=__rabiPatchDependencies[${JSON.stringify(name)}];`).join("\n")}
      let __rabiPatchEnvironment;
      ${compiled.functionNames.map(name => `const ${name}=function(...arguments_){return __rabiPatchRuntime.bind(${JSON.stringify(name)},__rabiPatchEnvironment).apply(this,arguments_);};`).join("\n")}
      __rabiPatchEnvironment=Object.defineProperties({}, {${compiled.environmentDescriptors}});
      ${compiled.initializationSource}
      return Object.freeze({${compiled.exported.map(name => `get ${name}(){return ${name}}`).join(",")}});
    })`;
    const factory = new Script(factorySource, { filename: `hot-patch:${id}:initialize` }).runInThisContext();
    this.exports = factory(this.runtime, resolvedDependencies);
  }

  apply(compiled: CompiledHotPatchModule, expectedRevision: number, contract: Readonly<Record<string, unknown>> = {}): number {
    return this.applyPreparedModule(compiled, this.prepare(compiled), expectedRevision, contract);
  }

  prepare(compiled: CompiledHotPatchModule): HotPatchChange[] {
    return this.prepareChanges(compiled);
  }

  validatePrepared(compiled: CompiledHotPatchModule, expectedRevision: number, contract: Readonly<Record<string, unknown>> = {}): void {
    this.runtime.validate({ baseRevision: expectedRevision, changes: this.prepareChanges(compiled), contract, resources: compiled.resources });
  }

  applyPreparedModule(compiled: CompiledHotPatchModule, changes: HotPatchChange[], expectedRevision: number, contract: Readonly<Record<string, unknown>> = {}): number {
    const revision = this.runtime.apply({ baseRevision: expectedRevision, changes, contract, resources: compiled.resources });
    this.previous = this.compiled;
    this.compiled = compiled;
    return revision;
  }

  applyWithStateMigration(compiled: CompiledHotPatchModule, expectedRevision: number, state: Record<string, unknown>, migrate: HotPatchStateMigration, contract: Readonly<Record<string, unknown>>): number {
    const changes = this.prepareChanges(compiled);
    const revision = this.runtime.applyWithStateMigration({ baseRevision: expectedRevision, changes, contract, resources: compiled.resources }, state, migrate);
    this.previous = this.compiled;
    this.compiled = compiled;
    return revision;
  }

  rollback(expectedRevision: number): number {
    if (!this.previous) throw new Error("No previous hot patch module is retained.");
    const revision = this.runtime.rollback(expectedRevision);
    const current = this.compiled;
    this.compiled = this.previous;
    this.previous = current;
    return revision;
  }

  rollbackWithStateMigration(expectedRevision: number, state: Record<string, unknown>, migrate: HotPatchStateMigration): number {
    if (!this.previous) throw new Error("No previous hot patch module is retained.");
    const revision = this.runtime.rollbackWithStateMigration(expectedRevision, state, migrate);
    const current = this.compiled;
    this.compiled = this.previous;
    this.previous = current;
    return revision;
  }

  snapshot() { return Object.freeze({ moduleId: this.id, sourceHash: this.compiled.sourceHash, ...this.runtime.snapshot() }); }

  private prepareChanges(compiled: CompiledHotPatchModule): HotPatchChange[] {
    if (compiled.schemaVersion !== 1 || compiled.compatibilityHash !== this.compiled.compatibilityHash
      || compiled.initializationSource !== this.compiled.initializationSource
      || compiled.environmentDescriptors !== this.compiled.environmentDescriptors
      || JSON.stringify(compiled.exported) !== JSON.stringify(this.compiled.exported)
      || JSON.stringify(compiled.dependencies) !== JSON.stringify(this.compiled.dependencies)
      || JSON.stringify(compiled.functionNames) !== JSON.stringify(this.compiled.functionNames)
      || JSON.stringify(Object.keys(compiled.implementations).sort()) !== JSON.stringify(Object.keys(this.compiled.implementations).sort())) {
      throw new Error("Hot patch module requires an explicit state or dependency migration.");
    }
    return Object.entries(compiled.implementations)
      .filter(([name, code]) => code !== this.compiled.implementations[name])
      .map(([id, code]) => ({ id, implementation: compileImplementation(code, this.id) }));
  }
}

function compileImplementation(source: string, moduleId: string): HotPatchImplementation {
  const value: unknown = new Script(`"use strict"; (${source})`, { filename: `hot-patch:${moduleId}` }).runInThisContext();
  if (typeof value !== "function") throw new Error("Hot patch implementation is not a function.");
  return value as HotPatchImplementation;
}
