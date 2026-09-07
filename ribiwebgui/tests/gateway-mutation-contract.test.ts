import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boundedRouteCatalogMutationFetch,
  committedRouteCatalogRevision,
  GATEWAY_MUTATION_TIMEOUT_MS,
  RouteCatalogMutationLedger,
  routeCatalogMutationFailureIsDefinitive
} from "../src/routeCatalogMutationLedger.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const store = fs.readFileSync(path.join(root, "src", "stores", "gatewayStore.ts"), "utf8");
const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");

test("Gateway mutations retain a stable operation id and fence with the loaded route catalog hash", () => {
  assert.match(types, /routeCatalog\?: RouteCatalogVersion/);
  assert.match(store, /routeCatalogMutationLedger\.retain\([\s\S]*?"save"/);
  assert.match(store, /routeCatalogMutationLedger\.retain\([\s\S]*?"delete"/);
  assert.match(store, /"idempotency-key": pendingMutation\.operationId/);
  assert.match(store, /"if-match": `"\$\{pendingMutation\.expectedContentHash\}"`/);
  assert.match(store, /value\?\.routeConfigHash/);
  assert.match(store, /applyRouteCatalogVersion\(body\.routeCatalog\)/);
  assert.match(store, /committedRouteCatalogRevision\(body, pendingMutation\)/);
  assert.equal(GATEWAY_MUTATION_TIMEOUT_MS, 35_000);
  assert.match(store, /boundedRouteCatalogMutationFetch\(`\$\{apiBase\}\/gateways`/);
});

test("Gateway accepts only a matching committed Route receipt", async () => {
  const ledger = new RouteCatalogMutationLedger(null, webcrypto as unknown as Crypto);
  const pending = await ledger.retain("save", { gateways: [{ id: "route-1" }] }, "a".repeat(64));
  const committedHash = "b".repeat(64);
  assert.equal(committedRouteCatalogRevision({
    receipt: { state: "committed", operationId: pending.operationId, routeConfigHash: committedHash },
    routeCatalog: { routeConfigHash: committedHash }
  }, pending), committedHash);
  assert.throws(() => committedRouteCatalogRevision({
    receipt: { state: "committed", operationId: "another-operation", routeConfigHash: committedHash },
    routeCatalog: { routeConfigHash: committedHash }
  }, pending), /matching committed receipt/);
  assert.throws(() => committedRouteCatalogRevision({
    receipt: { state: "committed", operationId: pending.operationId, routeConfigHash: committedHash },
    routeCatalog: { routeConfigHash: "c".repeat(64) }
  }, pending), /strong committed routeConfigHash/);
});

test("Gateway retires only definitive client rejections and preserves uncertain failures", () => {
  for (const status of [400, 401, 403, 404, 409, 412, 413, 415, 422]) {
    assert.equal(routeCatalogMutationFailureIsDefinitive(status), true, `HTTP ${status}`);
  }
  for (const status of [0, 408, 425, 429, 499, 500, 502, 503, 504]) {
    assert.equal(routeCatalogMutationFailureIsDefinitive(status), false, `HTTP ${status}`);
  }
  assert.match(store, /routeCatalogMutationFailureIsDefinitive\(response\.status\)[\s\S]{0,180}routeCatalogMutationLedger\.complete\(pending\)/);
});

test("Gateway lost-response ledger survives generation changes and unavailable sessionStorage", async () => {
  let stored = "";
  let storageThrows = false;
  const storage = {
    getItem() {
      if (storageThrows) throw new Error("storage disabled");
      return stored;
    },
    setItem(_key: string, value: string) {
      if (storageThrows) throw new Error("storage disabled");
      stored = value;
    }
  };
  const ledger = new RouteCatalogMutationLedger(storage, webcrypto as unknown as Crypto);
  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  const first = await ledger.retain("save", { gateways: [{ enabled: true, id: "route-1" }] }, oldHash);

  await assert.rejects(
    boundedRouteCatalogMutationFetch("/gateways", { method: "POST" }, {
      timeoutMs: 1,
      fetchImpl: (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })) as typeof fetch
    }),
    /retry will reuse the same Idempotency-Key/
  );
  assert.equal(
    (await ledger.retain("save", { gateways: [{ id: "route-1", enabled: true }] }, oldHash)).operationId,
    first.operationId,
    "timeout/503 paths do not complete the ledger entry"
  );

  // A Manager generation change updates the live hash, but an uncertain durable
  // operation must first replay its original key and precondition for receipt lookup.
  const afterGenerationChange = await ledger.retain(
    "save",
    { gateways: [{ id: "route-1", enabled: true }] },
    newHash
  );
  assert.equal(afterGenerationChange.operationId, first.operationId);
  assert.equal(afterGenerationChange.expectedContentHash, oldHash);

  await assert.rejects(
    ledger.retain("save", { gateways: [{ id: "route-2", enabled: true }] }, newHash),
    /still unresolved/
  );
  await assert.rejects(
    ledger.retain("delete", { id: "route-1" }, newHash),
    /still unresolved/
  );

  storageThrows = true;
  const withoutSessionStorage = await ledger.retain(
    "save",
    { gateways: [{ enabled: true, id: "route-1" }] },
    newHash
  );
  assert.equal(withoutSessionStorage.operationId, first.operationId);

  ledger.complete(first);
  const nextLogicalAttempt = await ledger.retain(
    "save",
    { gateways: [{ id: "route-1", enabled: true }] },
    newHash
  );
  assert.notEqual(nextLogicalAttempt.operationId, first.operationId);
  assert.equal(nextLogicalAttempt.expectedContentHash, newHash);
});

test("Gateway ledger falls back to memory when the sessionStorage getter throws", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("storage disabled", "SecurityError");
    }
  });
  try {
    const ledger = new RouteCatalogMutationLedger(undefined, webcrypto as unknown as Crypto);
    const value = { gateways: [{ id: "route-memory" }] };
    const first = await ledger.retain("save", value, "a".repeat(64));
    const retry = await ledger.retain("save", value, "b".repeat(64));
    assert.equal(retry.operationId, first.operationId);
    assert.equal(retry.expectedContentHash, first.expectedContentHash);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("Gateway revision state is scoped to Manager lifecycle identity", () => {
  assert.match(types, /applicationGenerationId\?: string/);
  assert.match(types, /managerInstanceId\?: string/);
  assert.match(store, /nextMeta\.applicationGenerationId/);
  assert.match(store, /nextMeta\.managerInstanceId/);
  assert.match(store, /!applicationGenerationId \|\| !managerInstanceId/);
  assert.match(store, /managerLifecycleKey\.value !== nextLifecycleKey[\s\S]{0,120}routeCatalogRevisionHash\.value = ""/);
  assert.match(store, /const mutationLifecycleKey = await loadMeta\(true\)/);
  assert.match(store, /await loadMeta\(true\) !== mutationLifecycleKey/);
  assert.match(store, /routeCatalogMutationLedger\.retain\([\s\S]{0,160}routeCatalogRevisionHash\.value/);
  assert.match(store, /routeCatalogMutationFailureIsDefinitive\(response\.status\)[\s\S]{0,180}routeCatalogMutationLedger\.complete\(pending\)[\s\S]{0,300}response\.status !== 412[\s\S]{0,300}loadRouteSummaries/);
  assert.match(store, /loadRouteSummaries\(\)[\s\S]{0,300}await loadMeta\(true\) !== expectedLifecycleKey/);
});
