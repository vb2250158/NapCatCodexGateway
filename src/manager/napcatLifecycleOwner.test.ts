import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NapcatLifecycleOwner, type NapcatBinding, type NapcatProcessIdentity } from "./napcatLifecycleOwner.js";
import { validateNapcatRouteCardinality } from "../shared/gatewayConfigModel.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-owner-test-"));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const binding = (id: string): NapcatBinding => ({ gatewayId: `route-${id}`, instanceId: id, workingDir: path.join(root, id), httpUrl: `http://127.0.0.1:${id === "a" ? 3000 : 3001}` });
  const process = (pid: number, id: string, parentPid = 0, name = "NapCatWinBootMain.exe"): NapcatProcessIdentity => ({ pid, parentPid, startedAt: `start-${pid}`, napcatRoot: name === "NapCatWinBootMain.exe", executable: path.join(root, id, name) });
  let processes: NapcatProcessIdentity[] = [];
  let failStop = false;
  const stopped: number[] = [];
  const logs: string[] = [];
  const options = { statePath: path.join(root, "ownership.json"), driver: {
    snapshot: async () => structuredClone(processes),
    terminate: async (item: NapcatProcessIdentity) => {
      if (failStop) throw new Error("cannot stop");
      stopped.push(item.pid); processes = processes.filter(current => current.pid !== item.pid);
    }
  }, log: (event: string) => { logs.push(event); } };
  return { root, binding, process, stopped, logs, options, owner: new NapcatLifecycleOwner(options),
    setProcesses: (value: NapcatProcessIdentity[]) => { processes = value; },
    setFailStop: (value: boolean) => { failStop = value; } };
}

test("one Route cannot own two QQ instances, including disabled extra configuration", async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), gatewayId: "route-a" }]), /一条路由只能/);
  assert.throws(() => validateNapcatRouteCardinality({ id: "route", gatewayPort: 8789, napcatInstances: [
    { id: "a", gatewayPort: 8789, httpUrl: "http://localhost:3000" },
    { id: "b", enabled: false, gatewayPort: 8790, httpUrl: "http://localhost:3001" }
  ] }), /一条路由只能/);
  assert.deepEqual(f.stopped, []);
});

test("correcting management endpoints and first account binding preserve the signed-in process", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  const bound = { ...f.binding("a"), botUserId: "10000", webuiUrl: "http://localhost:6100/webui" };
  await f.owner.reconcile([bound]);
  await f.owner.reconcile([{ ...bound, webuiUrl: "http://localhost:6101/webui" }]);
  assert.deepEqual(f.stopped, []);
  await f.owner.reconcile([{ ...bound, botUserId: "20000" }]);
  assert.deepEqual(f.stopped, [10]);
});

test("startup removes unbound NapCat trees, preserves bound accounts and ordinary QQ", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(11, "a", 10, "QQ.exe"), f.process(20, "unbound"), f.process(21, "unbound", 20, "QQ.exe"), f.process(30, "desktop", 0, "QQ.exe")]);
  await f.owner.reconcile([f.binding("a")]);
  assert.deepEqual(f.stopped, [20, 21]);
  assert.equal(await f.owner.run(f.binding("a"), async () => "online"), "online");
  await assert.rejects(f.owner.run(f.binding("b"), async () => "unexpected"), /未绑定/);
});

test("unbind revokes queued and late launch operations, drains an existing operation before stopping", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(20, "b")]);
  await f.owner.reconcile([f.binding("a"), f.binding("b")]);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const active = f.owner.run(f.binding("a"), async () => {
    started(); await held;
    assert.throws(() => f.owner.prepareLaunch(f.binding("a")), /未绑定/);
  });
  await ready;
  const queued = assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  const removing = f.owner.reconcile([f.binding("b")]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.stopped, []);
  assert.equal(await f.owner.run(f.binding("b"), async () => "still online"), "still online");
  release(); await Promise.all([active, queued, removing]);
  assert.deepEqual(f.stopped, [10]);
});

test("a Manager restart recovers ownership and never kills a recycled PID now owned by ordinary QQ", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(11, "a", 10, "QQ.exe")]);
  await f.owner.reconcile([f.binding("a")]);
  f.setProcesses([{ ...f.process(10, "desktop", 0, "QQ.exe"), startedAt: "reused" }, f.process(11, "a", 0, "QQ.exe")]);
  const recovered = new NapcatLifecycleOwner(f.options);
  await recovered.reconcile([]);
  assert.deepEqual(f.stopped, [11]);
});

test("stop failure is not an unbind success, blocks relaunch, and remains retryable", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  f.setFailStop(true);
  await assert.rejects(f.owner.reconcile([]), /停止失败/);
  await assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records.length, 1);
  f.setFailStop(false);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});

test("two bindings cannot share or nest a process directory", async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), workingDir: f.binding("a").workingDir }]), /共用/);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), workingDir: path.join(f.binding("a").workingDir!, "nested") }]), /共用/);
});

test("nested login/start commands reuse the same lease and restart retains the binding", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.owner.run(f.binding("a"), () => f.owner.run(f.binding("a"), async () => {
    await f.owner.stopForRestart(f.binding("a"));
    f.owner.prepareLaunch(f.binding("a"));
    f.setProcesses([f.process(12, "a")]);
    await f.owner.recordLaunch(f.binding("a"), 12);
  }));
  assert.deepEqual(f.stopped, [10]);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10, 12]);
});

test("failed explicit removal remains blocked across unchanged snapshots and can be retried", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  f.setFailStop(true);
  await assert.rejects(f.owner.remove(f.binding("a")), /停止失败/);
  const restarted = new NapcatLifecycleOwner(f.options);
  await assert.rejects(restarted.reconcile([f.binding("a")]), /停止失败/);
  f.setFailStop(false);
  await f.owner.reconcile([f.binding("a")]);
  await assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  f.setFailStop(false);
  await f.owner.remove(f.binding("a"));
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});
