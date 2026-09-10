import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { cloneGatewayValue, mergeGatewayDraft } from "../src/gatewayDraft";

Object.assign(globalThis, { window: { location: { pathname: "/", hash: "" } } });
const { useGatewayStore } = await import("../src/stores/gatewayStore");

async function fixture() {
  setActivePinia(createPinia());
  const store = useGatewayStore();
  let rows: any[] = [{ id: "a", configName: "a", enabled: true }, { id: "b", configName: "b", enabled: true }];
  let beforeReply: (() => Promise<void>) | undefined;
  let loseResponse = false;
  let writes = 0;
  let recoveries = 0;
  let recoveryUnavailable = false;
  const committed = new Set<string>();
  const payload = () => ({ code: 0, data: { config: { gateways: rows }, manager: [] }, routeCatalog: { routeConfigHash: "a".repeat(64) } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/meta")) return Response.json({ applicationGenerationId: "test-generation", managerInstanceId: "test-manager" });
    if (url.endsWith("/network-options")) return Response.json({ code: 0, data: {} });
    if (url.includes("/mutations/")) {
      recoveries++;
      if (recoveryUnavailable) throw new TypeError("recovery unavailable");
      const operationId = decodeURIComponent(url.split("/mutations/")[1]);
      return Response.json({ ...payload(), receipt: { operationId, state: committed.has(operationId) ? "committed" : "not_committed" } });
    }
    if (init?.method === "PUT") {
      writes++;
      const sent = JSON.parse(String(init.body));
      const id = decodeURIComponent(url.split("/gateways/")[1].split("/")[0]);
      rows = rows.map(row => row.id === id ? sent : row);
      const operationId = (init.headers as Record<string, string>)["idempotency-key"];
      committed.add(operationId);
      if (beforeReply) await beforeReply();
      if (loseResponse) throw new TypeError("connection lost after commit");
      return Response.json({ ...payload(), receipt: { operationId, state: "committed", routeConfigHash: "a".repeat(64) } });
    }
    assert.equal(init?.method, undefined, "Saving must not replace the catalog");
    return Response.json(payload());
  }) as typeof fetch;
  await store.load();
  rows = cloneGatewayValue(store.gateways);
  return {
    store, get rows() { return rows; }, get writes() { return writes; }, get recoveries() { return recoveries; },
    delay(action: () => Promise<void>) { beforeReply = action; },
    loseResponse() { loseResponse = true; },
    recoveryUnavailable(value: boolean) { recoveryUnavailable = value; }
  };
}

test("saving one route preserves another route's local draft and remote update", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.gateways[1].name = "local draft";
  f.rows[1].heartbeatMessage = "remote update";
  await f.store.save();
  assert.equal(f.rows[0].enabled, false);
  assert.equal(f.rows[1].heartbeatMessage, "remote update");
  assert.notEqual(f.rows[1].name, "local draft");
  assert.equal(f.store.gateways[1].name, "local draft");
  assert.equal(f.store.dirty, true);
});

test("reverting an edit clears dirty without saving", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.touch();
  assert.equal(f.store.dirty, true);
  f.store.gateways[0].enabled = true;
  f.store.touch();
  assert.equal(f.store.dirty, false);
});

test("overview saves changed routes individually without changing the selected route", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.gateways[1].enabled = false;
  await f.store.saveChangedRoutes();
  assert.equal(f.writes, 2);
  assert.equal(f.store.selectedGatewayId, "a");
  assert.equal(f.store.dirty, false);
});

test("a late acknowledgement preserves newer edits and concurrent clicks share one write", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  f.delay(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  f.store.gateways[0].enabled = false;
  const first = f.store.save();
  const second = f.store.save();
  await reached;
  f.store.gateways[0].name = "edited while saving";
  release();
  await Promise.all([first, second]);
  assert.equal(f.writes, 1);
  assert.equal(f.store.gateways[0].name, "edited while saving");
  assert.equal(f.store.dirty, true);
});

test("a lost committed response is recovered without resubmitting the write", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.loseResponse();
  await f.store.save();
  assert.equal(f.writes, 1);
  assert.equal(f.recoveries, 1);
  assert.equal(f.store.saveState, "saved");
  assert.equal(f.store.dirty, false);
});

test("independent fields merge and overlapping edits fail before writing", async () => {
  assert.deepEqual(mergeGatewayDraft({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }), { a: 2, b: 2 });
  const f = await fixture();
  f.store.gateways[0].name = "local";
  f.rows[0].name = "remote";
  await assert.rejects(f.store.save(), /配置冲突/);
  assert.equal(f.writes, 0);
  assert.equal(f.store.gateways[0].name, "local");
  assert.equal(f.store.saveState, "conflict");
});

test("editing after an unresolved response recovers the earlier baseline before saving the new draft", async () => {
  const f = await fixture();
  f.loseResponse();
  f.recoveryUnavailable(true);
  f.store.gateways[0].name = "first save";
  await assert.rejects(f.store.save(), /recovery unavailable/);
  assert.equal(f.store.saveState, "confirming");
  f.store.gateways[0].name = "newer draft";
  f.recoveryUnavailable(false);
  await f.store.save();
  assert.equal(f.writes, 2);
  assert.equal(f.rows[0].name, "newer draft");
  assert.equal(f.store.dirty, false);
});
