import assert from "node:assert/strict";
import test from "node:test";
import { compileHotPatchModule, diffHotPatchModules } from "./lib/hot-patch-compiler.mjs";
import { HotPatchModule } from "../src/plugin-kernel/hotPatchModule.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHotPatchCandidate } from "./compile-hot-patch.mjs";

test("compiled symbols include source maps with original source content", () => {
  const source = "export function read(value: number) { return value + 1; }";
  const compiled = compileHotPatchModule(source, "C:/workspace/example.ts");
  const map = compiled.sourceMaps.read;
  assert.equal(map.version, 3);
  assert.deepEqual(map.sources, ["example.ts"]);
  assert.deepEqual(map.sourcesContent, [source]);
  assert.equal(typeof map.mappings, "string");
  assert.ok(map.mappings.length > 0);
});

test("generators resume in their original revision and release on completion and early return", () => {
  const source = `function value() { return 'old'; }
    export function* stream() { yield value(); yield value(); return value(); }
    export class Reader { *read() { yield* stream(); } }`;
  const module = new HotPatchModule("generators", compileHotPatchModule(source));
  const iterator = module.exports.stream();
  assert.equal(iterator.next().value, "old");
  module.apply(compileHotPatchModule(source.replace("'old'", "'new'")), 0);
  assert.equal(iterator.next().value, "old");
  assert.deepEqual(iterator.next(), { value: "old", done: true });
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
  const reader = new module.exports.Reader();
  assert.deepEqual([...reader.read()], ["new", "new"]);
  const stopped = module.exports.stream();
  stopped.next();
  stopped.return();
  assert.ok(module.runtime.snapshot().retained.every(revision => revision.leases === 0));
});

test("async generators pin queued next calls and finally blocks across source patches", async () => {
  const source = `declare const pause: () => Promise<void>;
    let closed = '';
    function value() { return 'old'; }
    export async function* stream() {
      try { await pause(); yield value(); yield value(); } finally { closed = value(); }
    }
    export function closedValue() { return closed; }`;
  let resume;
  const pause = new Promise(resolve => { resume = resolve; });
  const module = new HotPatchModule("async-generators", compileHotPatchModule(source), { pause: () => pause });
  const iterator = module.exports.stream();
  const first = iterator.next();
  const second = iterator.next();
  module.apply(compileHotPatchModule(source.replace("'old'", "'new'")), 0);
  resume();
  assert.deepEqual(await first, { value: "old", done: false });
  assert.deepEqual(await second, { value: "old", done: false });
  await iterator.return();
  assert.equal(module.exports.closedValue(), "old");
  const values = [];
  for await (const value of module.exports.stream()) values.push(value);
  assert.deepEqual(values, ["new", "new"]);
  assert.ok(module.runtime.snapshot().retained.every(revision => revision.leases === 0));
});

test("semantic errors reject candidates before changing live code or creating artifacts", async () => {
  const source = "export function read(): number { return 1; }";
  const module = new HotPatchModule("semantic", compileHotPatchModule(source));
  assert.throws(() => compileHotPatchModule(source.replace("return 1", "return 'wrong'")), /TS2322/);
  assert.throws(() => compileHotPatchModule("export function read() { return missingBinding; }"), /TS2304/);
  assert.throws(() => compileHotPatchModule("function helper(value: number) { return value; } export function read() { return helper('wrong'); }"), /TS2345/);
  assert.equal(module.exports.read(), 1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-hot-patch-types-"));
  try {
    const sourcePath = path.join(root, "module.ts");
    const outputDirectory = path.join(root, "candidates");
    await fs.writeFile(path.join(root, "contract.ts"), "export interface Input { count: number }");
    await fs.writeFile(sourcePath, "import type { Input } from './contract.js'; export function read(input: Input): number { return input.count; }");
    const baseline = await buildHotPatchCandidate({ sourcePath, outputDirectory });
    await fs.writeFile(path.join(root, "contract.ts"), "export interface Input { count: number; label?: string }");
    await assert.rejects(buildHotPatchCandidate({ sourcePath, outputDirectory, baselinePath: baseline.outputPath }), /migration/);
    await fs.writeFile(sourcePath, "import type { Input } from './contract.js'; export function read(input: Input): number { return input.missing; }");
    await assert.rejects(buildHotPatchCandidate({ sourcePath, outputDirectory, baselinePath: baseline.outputPath }), /TS2339/);
    assert.equal((await fs.readdir(outputDirectory)).length, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-hot-patch-types-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compiled internal calls, recursion and state survive function replacement", () => {
  const source = `let count = 0;
    function factorial(value: number): number { return value < 2 ? 1 : value * factorial(value - 1); }
    export function next(value: number) { count++; return { count, result: factorial(value) }; }`;
  const baseline = compileHotPatchModule(source);
  const module = new HotPatchModule("fixture", baseline);
  const callback = module.exports.next;
  assert.deepEqual(callback(4), { count: 1, result: 24 });
  const changed = compileHotPatchModule(source.replace("count++", "count += 2"));
  assert.equal(diffHotPatchModules(baseline, changed).length, 1);
  module.apply(changed, 0, { version: 1 });
  assert.deepEqual(callback(4), { count: 3, result: 24 });
  module.rollback(1);
  assert.deepEqual(callback(3), { count: 4, result: 6 });
});

test("compiled async requests preserve dependencies and old implementations", async () => {
  const source = `declare const wait: () => Promise<void>;
    function helper() { return 'old'; }
    export async function read() { await wait(); return helper(); }`;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const module = new HotPatchModule("async", compileHotPatchModule(source), { wait: () => waiting });
  const pending = module.exports.read();
  module.apply(compileHotPatchModule(source.replace("'old'", "'new'")), 0);
  release();
  assert.equal(await pending, "old");
  assert.equal(await module.exports.read(), "new");
});

test("compiler preserves local shadowing, closures and this", () => {
  const source = `let value = 10;
    export function read(value: number) { return () => value + this.offset; }
    export function globalValue() { return value; }`;
  const module = new HotPatchModule("scope", compileHotPatchModule(source));
  const closure = module.exports.read.call({ offset: 2 }, 3);
  assert.equal(closure(), 5);
  assert.equal(module.exports.globalValue(), 10);
});

test("state changes and unsupported declarations reject without replacing running code", () => {
  const source = `let count = 1; export function read() { return count; }`;
  const module = new HotPatchModule("reject", compileHotPatchModule(source));
  assert.throws(() => module.apply(compileHotPatchModule(source.replace("= 1", "= 2")), 0), /migration/);
  assert.equal(module.exports.read(), 1);
  assert.throws(() => compileHotPatchModule("export class Example { #value = 1; }"), /private/);
  assert.throws(() => compileHotPatchModule("import fs from 'node:fs'; export function read() {}"), /dependency/);
  assert.throws(() => compileHotPatchModule("export function read() { return eval('1'); }"), /unsupported/);
});

test("type declarations and unresolved runtime imports cannot bypass compatibility checks", () => {
  const source = `type Input = { value: number }; export function read(input: Input) { return input.value; }`;
  const baseline = compileHotPatchModule(source);
  const changed = compileHotPatchModule(source.replace("value: number", "value: string"));
  assert.throws(() => diffHotPatchModules(baseline, changed), /migration/);
  const module = new HotPatchModule("types", baseline);
  assert.throws(() => module.apply(changed, 0), /migration/);
  assert.equal(module.exports.read({ value: 4 }), 4);
  assert.throws(() => compileHotPatchModule(`export async function read() { return import('./dependency.js'); }`), /unsupported/);
});

test("class identity, constructed state, static methods and bound callbacks survive patches", () => {
  const source = `let calls = 0;
    export class Counter {
      count = 10;
      constructor(public offset: number) {}
      next(amount = 1) { calls++; this.count += amount; return this.count + this.offset; }
      static total() { return calls; }
    }`;
  const module = new HotPatchModule("classes", compileHotPatchModule(source));
  const Counter = module.exports.Counter;
  const instance = new Counter(2);
  const callback = instance.next.bind(instance);
  assert.equal(callback(), 13);
  module.apply(compileHotPatchModule(source.replace("this.count += amount", "this.count += amount * 2")), 0);
  assert.equal(callback(), 15);
  assert.equal(Counter.total(), 2);
  assert.equal(instance instanceof Counter, true);
  assert.equal(module.exports.Counter, Counter);
});

test("initialization keeps declaration order and may call initialized functions", () => {
  const source = `function initial() { return 10; }
    let count = initial();
    class Counter { read() { return count; } }
    const counter = new Counter();
    export function read() { return counter.read(); }`;
  const module = new HotPatchModule("initialization", compileHotPatchModule(source));
  assert.equal(module.exports.read(), 10);
  module.apply(compileHotPatchModule(source.replace("return count;", "return count + 1;")), 0);
  assert.equal(module.exports.read(), 11);
});

test("candidate compiler writes immutable content hashes and checks the baseline before publishing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-hot-patch-"));
  try {
    const sourcePath = path.join(root, "module.ts");
    const outputDirectory = path.join(root, "candidates");
    await fs.writeFile(sourcePath, "export function read() { return 1; }");
    const baseline = await buildHotPatchCandidate({ sourcePath, outputDirectory });
    const unchanged = await buildHotPatchCandidate({ sourcePath, outputDirectory, baselinePath: baseline.outputPath });
    assert.equal(unchanged.changed, false);
    await fs.writeFile(sourcePath, "export function read() { return 2; }");
    const patch = await buildHotPatchCandidate({ sourcePath, outputDirectory, baselinePath: baseline.outputPath });
    assert.notEqual(patch.sha256, baseline.sha256);
    assert.deepEqual(patch.symbols, ["read"]);
    await fs.writeFile(sourcePath, "export function read(value: number) { return value; }");
    await assert.rejects(buildHotPatchCandidate({ sourcePath, outputDirectory, baselinePath: baseline.outputPath }), /migration/);
    assert.equal((await fs.readdir(outputDirectory)).length, 2);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-hot-patch-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("module-level state migration keeps exports and supports explicit reverse rollback", () => {
  const state = { count: 1, ledger: [] };
  const source = `declare const state: { count?: number; total?: number; ledger: string[] };
    function value() { return state.count!; }
    export function read() { return value(); }
    export function record(id: string) {
      if (!state.ledger.includes(id)) { state.ledger.push(id); state.count!++; }
      return read();
    }`;
  const baseline = compileHotPatchModule(source);
  const candidate = compileHotPatchModule(source.replaceAll("state.count", "state.total"));
  const module = new HotPatchModule("state-module", baseline, { state }, { stateSchema: 1 });
  const read = module.exports.read;
  const record = module.exports.record;
  const migrate = draft => { draft.total = draft.count; delete draft.count; };
  try {
    const before = module.snapshot();
    const ledger = state.ledger;
    assert.throws(() => module.applyWithStateMigration(candidate, 0, state, draft => {
      draft.ledger.push("must-not-commit");
      throw new Error("migration rejected");
    }, { stateSchema: 2 }), /migration rejected/);
    assert.deepEqual(module.snapshot(), before);
    assert.equal(state.ledger, ledger);
    assert.deepEqual(ledger, []);
    assert.throws(() => module.applyWithStateMigration(candidate, 9, state, migrate, { stateSchema: 2 }), /base revision/);
    assert.equal(read(), 1);
    assert.equal(module.applyWithStateMigration(candidate, 0, state, migrate, { stateSchema: 2 }), 1);
    assert.equal(module.exports.read, read);
    assert.equal(module.exports.record, record);
    assert.equal(module.snapshot().sourceHash, candidate.sourceHash);
    assert.equal(record("first"), 2);
    assert.equal(record("first"), 2);
    assert.deepEqual(state, { total: 2, ledger: ["first"] });
    assert.throws(() => module.rollback(1), /reverse migration/);
    assert.throws(() => module.rollbackWithStateMigration(1, { ...state }, () => {}), /original state owner/);
    assert.equal(module.rollbackWithStateMigration(1, state, draft => {
      draft.count = draft.total; delete draft.total;
    }), 2);
    assert.equal(module.snapshot().sourceHash, baseline.sourceHash);
    assert.equal(read(), 2);
    assert.equal(record("first"), 2);
    assert.equal(record("second"), 3);
    assert.deepEqual(state, { count: 3, ledger: ["first", "second"] });
  } finally { module.runtime.close(); }
});
