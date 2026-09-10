import { HotPatchModule, type CompiledHotPatchModule } from "./hotPatchModule.js";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";

export type HotPatchChildRequest = Readonly<{
  id: number;
  operation: "initialize" | "call" | "invoke" | "prepare" | "commit" | "discard" | "apply" | "rollback" | "apply-migration" | "rollback-migration" | "snapshot";
  moduleId?: string;
  compiled?: CompiledHotPatchModule;
  symbol?: string;
  arguments?: readonly unknown[];
  expectedRevision?: number;
  contract?: Readonly<Record<string, unknown>>;
  dependencies?: Readonly<Record<string, unknown>>;
  stateDependency?: string;
  migrationSource?: string;
  token?: string;
}>;

export type HotPatchChildResponse = Readonly<{
  id: number;
  value?: unknown;
  error?: string;
}>;

let module: HotPatchModule | undefined;
let dependencies: Readonly<Record<string, unknown>> = {};
let prepared: { token: string; compiled: CompiledHotPatchModule; changes: ReturnType<HotPatchModule["prepare"]>; expectedRevision: number; contract: Readonly<Record<string, unknown>> } | undefined;
const executionId = randomUUID();

process.on("message", (request: HotPatchChildRequest) => {
  void dispatch(request).then(
    value => send({ id: request.id, value }),
    error => send({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  );
});
process.on("disconnect", () => process.exit(0));

async function dispatch(request: HotPatchChildRequest): Promise<unknown> {
  if (request.operation === "initialize") {
    if (module || !request.moduleId || !request.compiled) throw new Error("Invalid hot patch child initialization.");
    dependencies = request.dependencies ?? {};
    module = new HotPatchModule(request.moduleId, request.compiled, dependencies, request.contract);
    return { pid: process.pid, executionId, snapshot: module.snapshot() };
  }
  if (!module) throw new Error("Hot patch child has not initialized.");
  if (request.operation === "prepare") {
    if (!request.compiled || request.expectedRevision === undefined) throw new Error("Invalid hot patch prepare request.");
    if (prepared) throw new Error("Hot patch worker already has a prepared publication.");
    const changes = module.prepare(request.compiled);
    module.validatePrepared(request.compiled, request.expectedRevision, request.contract);
    const token = randomUUID();
    prepared = { token, compiled: request.compiled, changes, expectedRevision: request.expectedRevision, contract: request.contract ?? {} };
    return { pid: process.pid, executionId, token, snapshot: module.snapshot() };
  }
  if (request.operation === "commit") {
    if (!request.token || !prepared || request.token !== prepared.token) throw new Error("Hot patch prepare token is missing or stale.");
    const current = prepared;
    prepared = undefined;
    module.applyPreparedModule(current.compiled, current.changes, current.expectedRevision, current.contract);
    return { pid: process.pid, executionId, snapshot: module.snapshot() };
  }
  if (request.operation === "discard") {
    if (request.token && prepared?.token !== request.token) throw new Error("Hot patch prepare token is missing or stale.");
    prepared = undefined;
    return { pid: process.pid, executionId, snapshot: module.snapshot() };
  }
  if (request.operation === "snapshot") return { pid: process.pid, executionId, snapshot: module.snapshot(), ...(request.stateDependency ? { state: structuredClone(migrationState(request.stateDependency)) } : {}) };
  if (request.operation === "apply") {
    if (!request.compiled || request.expectedRevision === undefined) throw new Error("Invalid hot patch apply request.");
    module.apply(request.compiled, request.expectedRevision, request.contract);
    return { pid: process.pid, executionId, snapshot: module.snapshot() };
  }
  if (request.operation === "apply-migration") {
    if (!request.compiled || request.expectedRevision === undefined || !request.migrationSource) throw new Error("Invalid hot patch migration request.");
    const migrate = compileMigration(request.migrationSource);
    const state = migrationState(request.stateDependency);
    module.applyWithStateMigration(request.compiled, request.expectedRevision, state, migrate, request.contract ?? {});
    return { pid: process.pid, executionId, snapshot: module.snapshot(), state: structuredClone(state) };
  }
  if (request.operation === "rollback") {
    if (request.expectedRevision === undefined) throw new Error("Invalid hot patch rollback request.");
    module.rollback(request.expectedRevision);
    return { pid: process.pid, executionId, snapshot: module.snapshot() };
  }
  if (request.operation === "rollback-migration") {
    if (request.expectedRevision === undefined || !request.migrationSource) throw new Error("Invalid hot patch rollback migration request.");
    const migrate = compileMigration(request.migrationSource);
    const state = migrationState(request.stateDependency);
    module.rollbackWithStateMigration(request.expectedRevision, state, migrate);
    return { pid: process.pid, executionId, snapshot: module.snapshot(), state: structuredClone(state) };
  }
  if (request.operation === "call" || request.operation === "invoke") {
    const implementation = request.symbol && Object.hasOwn(module.exports, request.symbol) ? module.exports[request.symbol] : undefined;
    if (typeof implementation !== "function" || !Array.isArray(request.arguments)) throw new Error("Unknown hot patch export or invalid arguments.");
    if (request.operation === "call") return transferableResult(await module.runtime.runFresh(() => implementation(...request.arguments!)));
    const lease = module.runtime.acquire();
    try {
      const value = await transferableResult(await lease.run(() => implementation(...request.arguments!)));
      return { revision: lease.revision, contract: lease.contract, value };
    } finally { lease.release(); }
  }
  throw new Error("Unknown hot patch child operation.");
}

async function transferableResult(value: unknown): Promise<unknown> {
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Generator]" || tag === "[object AsyncGenerator]") {
    await (value as Iterator<unknown> | AsyncIterator<unknown>).return?.();
    throw new Error("Hot patch generators must be consumed within their execution unit; IPC streaming is not supported.");
  }
  return value;
}

function send(response: HotPatchChildResponse): void {
  if (!process.connected) return;
  try {
    process.send?.(response, error => { if (error) process.exitCode = 1; });
  } catch {
    process.exit(1);
  }
}

function compileMigration(source: string): (state: Record<string, unknown>) => void {
  const value: unknown = new Script(`"use strict"; (${source})`, { filename: "hot-patch:migration" }).runInThisContext();
  if (typeof value !== "function") throw new Error("Hot patch state migration must be a function.");
  return value as (state: Record<string, unknown>) => void;
}

function migrationState(name: string | undefined): Record<string, unknown> {
  if (!name || !Object.hasOwn(dependencies, name)) throw new Error("Unknown hot patch state dependency.");
  const state = dependencies[name];
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Hot patch state dependency must be an object.");
  return state as Record<string, unknown>;
}
