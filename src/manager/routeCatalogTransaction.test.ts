import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeRouteCatalogTransaction,
  RouteCatalogIdempotencyConflictError,
  RouteCatalogRevisionConflictError,
  type RouteCatalogSnapshot,
  type RouteCatalogTransactionInput,
  type RouteCatalogTransactionOperation
} from "./routeCatalogTransaction.js";
import {
  executeDurableRouteCatalogMutation,
  routeCatalogOperationDigest
} from "./routeCatalogDurableTransaction.js";
import { canonicalRouteCatalogDigest, routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

function transaction(
  rootDir: string,
  requestId: string,
  attemptToken: string,
  operation: RouteCatalogTransactionOperation
): RouteCatalogTransactionInput {
  return {
    requestId,
    attemptToken,
    operationId: requestId,
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    managerPort: 31_337,
    readOnly: false,
    operation
  };
}

test("scoped upsert changes only one route file, supports rename, and exposes durable recovery", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-scoped-save-"));
  try {
    const initial = executeRouteCatalogTransaction(transaction(rootDir, "seed", "seed", {
      kind: "replace", config: { gateways: [
        { id: "a", configName: "a", agentRoleId: "Shared", recentMessageLimit: 10, gatewayPort: 23001 },
        { id: "b", configName: "b", agentRoleId: "Shared", recentMessageLimit: 10, gatewayPort: 23002 }
      ] }
    }));
    const aPath = path.join(rootDir, "data", "route", "a", "adapterConfig.json");
    const before = fs.readFileSync(aPath, "utf8");
    const mutation = transaction(rootDir, "scoped", "attempt", {
      kind: "upsert", previousId: "b", expectedContentHash: initial.routeConfigHash,
      definition: { ...initial.gateways.find(row => row.id === "b")!, id: "renamed", configName: "renamed", recentMessageLimits: { napcat: 25 } }
    });
    const saved = executeRouteCatalogTransaction(mutation);
    assert.deepEqual(saved.gateways.map(row => row.id), ["a", "renamed"]);
    assert.equal(fs.readFileSync(aPath, "utf8"), before, "unrelated adapter file is untouched");
    assert.equal(saved.gateways.find(row => row.id === "renamed")?.recentMessageLimits?.napcat, 25);
    assert.equal(saved.gateways.find(row => row.id === "a")?.recentMessageLimits?.napcat, 25, "shared persona has one authoritative value");
    const replay = executeRouteCatalogTransaction(mutation);
    assert.equal(replay.routeConfigHash, saved.routeConfigHash);
    const recovered = executeRouteCatalogTransaction(transaction(rootDir, "resolve", "resolve", { kind: "capture", resolveOperationId: "scoped" }));
    assert.deepEqual(recovered.resolvedMutation, { operationId: "scoped", state: "committed" });
    const absent = executeRouteCatalogTransaction(transaction(rootDir, "absent", "absent", { kind: "capture", resolveOperationId: "never-written" }));
    assert.equal(absent.resolvedMutation?.state, "not_committed");
    assert.throws(() => executeRouteCatalogTransaction(transaction(rootDir, "collision", "collision", {
      kind: "upsert", previousId: "renamed", expectedContentHash: saved.routeConfigHash,
      definition: { ...saved.gateways[0], id: "a", configName: "a" }
    })), /different Route/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

function journalPath(rootDir: string, directory: "pending" | "receipts", operationId: string): string {
  return path.join(
    rootDir,
    "data",
    "route",
    ".rabiroute-route-catalog",
    directory,
    `${canonicalRouteCatalogDigest(operationId)}.json`
  );
}

function emptySnapshot(input: RouteCatalogTransactionInput): RouteCatalogSnapshot {
  const content = {
    routeRoot: path.resolve(input.routeRoot),
    rolesRoot: path.resolve(input.rolesRoot),
    gateways: [],
    personas: []
  };
  return Object.freeze({
    requestId: input.requestId,
    attemptToken: input.attemptToken,
    ...content,
    ...routeCatalogSnapshotIdentities(content)
  });
}

test("child transaction recaptures after each mutation and enforces the expected content revision", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-transaction-"));
  try {
    const personaDir = path.join(rootDir, "data", "roles", "DaiMao");
    fs.mkdirSync(personaDir, { recursive: true });
    fs.writeFileSync(path.join(personaDir, "persona.md"), "# 呆猫人格提示词\n", "utf8");
    fs.writeFileSync(path.join(personaDir, "avatar.png"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(personaDir, "personaConfig.json"), JSON.stringify({ avatar: "avatar.png" }));
    fs.mkdirSync(path.join(personaDir, "voice"));
    fs.writeFileSync(path.join(personaDir, "voice", "voice-profile.json"), JSON.stringify({
      default_model: "local-tts",
      language: "zh",
      speed: 1.1,
      voice_style_summary: "calm"
    }));
    const first = executeRouteCatalogTransaction(transaction(rootDir, "replace", "attempt-1", {
      kind: "replace",
      config: {
        gateways: [{
          id: "A",
          configName: "A",
          gatewayPort: 20_001,
          agentRoleId: "Rabi"
        }]
      }
    }));
    assert.equal(first.requestId, "replace");
    assert.equal(first.attemptToken, "attempt-1");
    assert.match(first.contentHash, /^[a-f0-9]{64}$/);
    assert.match(first.routeConfigHash, /^[a-f0-9]{64}$/);
    assert.match(first.presentationHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.gateways.map(item => item.id), ["A"]);
    assert.deepEqual(first.personas.map(item => ({
      roleId: item.roleId,
      isPersona: item.isPersona,
      displayName: item.displayName,
      avatarConfigured: item.avatarConfigured
    })), [
      { roleId: "DaiMao", isPersona: true, displayName: "呆猫", avatarConfigured: true },
      { roleId: "Rabi", isPersona: false, displayName: "Rabi", avatarConfigured: false }
    ]);
    assert.match(first.personas[0].avatarVersion ?? "", /^\d+-3$/);
    assert.equal(first.personas[0].files[0].content, "# 呆猫人格提示词\n");
    assert.deepEqual(first.personas[0].speech, {
      voiceReady: true,
      defaultModel: "local-tts",
      language: "zh",
      speed: 1.1,
      voiceStyleSummary: "calm"
    });

    fs.writeFileSync(path.join(personaDir, "persona.md"), "# 呆猫新标题\n", "utf8");
    const presentationRefresh = executeRouteCatalogTransaction(transaction(rootDir, "presentation", "attempt-p", {
      kind: "capture"
    }));
    assert.equal(presentationRefresh.routeConfigHash, first.routeConfigHash);
    assert.notEqual(presentationRefresh.presentationHash, first.presentationHash);
    assert.notEqual(presentationRefresh.contentHash, first.contentHash);

    const second = executeRouteCatalogTransaction(transaction(rootDir, "upsert", "attempt-2", {
      kind: "upsert",
      definition: {
        id: "B",
        configName: "B",
        gatewayPort: 20_002,
        agentRoleId: "YeYu"
      },
      expectedContentHash: first.routeConfigHash
    }));
    assert.deepEqual(second.gateways.map(item => item.id).sort(), ["A", "B"]);
    assert.notEqual(second.contentHash, first.contentHash);

    assert.throws(() => executeRouteCatalogTransaction(transaction(rootDir, "stale", "attempt-3", {
      kind: "remove",
      routeId: "A",
      expectedContentHash: first.routeConfigHash
    })), RouteCatalogRevisionConflictError);

    const removed = executeRouteCatalogTransaction(transaction(rootDir, "remove", "attempt-4", {
      kind: "remove",
      routeId: "A",
      expectedContentHash: second.routeConfigHash
    }));
    assert.deepEqual(removed.gateways.map(item => item.id), ["B"]);

    executeRouteCatalogTransaction(transaction(rootDir, "role-file", "attempt-5", {
      kind: "ensure_role_file",
      roleId: "YeYu",
      roleFile: "notes/persona.md"
    }));
    assert.equal(
      fs.readFileSync(path.join(rootDir, "data", "roles", "YeYu", "notes", "persona.md"), "utf8"),
      ""
    );

    executeRouteCatalogTransaction(transaction(rootDir, "role-folder", "attempt-6", {
      kind: "ensure_role_folder",
      roleId: "Rabi"
    }));
    assert.equal(fs.statSync(path.join(rootDir, "data", "roles", "Rabi")).isDirectory(), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("durable mutation rolls back newly-created files and nested directories when post-write capture fails", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-rollback-"));
  const input = {
    ...transaction(rootDir, "rollback-new-file", "attempt-rollback", {
      kind: "ensure_role_file",
      roleId: "YeYu",
      roleFile: "notes/nested/persona.md"
    }),
    operationId: "rollback-new-file"
  };
  const target = path.join(input.rolesRoot, "YeYu", "notes", "nested", "persona.md");
  let captures = 0;
  try {
    assert.throws(() => executeDurableRouteCatalogMutation(input, {
      capture() {
        captures += 1;
        if (captures === 2) throw new Error("post-write capture failed");
        return emptySnapshot(input);
      },
      prepare() {},
      mutate() {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "partial", "utf8");
      }
    }), /post-write capture failed/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(input.rolesRoot, "YeYu")), false);
    assert.equal(fs.existsSync(journalPath(rootDir, "pending", input.operationId)), false);
    assert.equal(fs.existsSync(journalPath(rootDir, "receipts", input.operationId)), false);

    const retried = executeDurableRouteCatalogMutation(input, {
      capture: () => emptySnapshot(input),
      prepare() {},
      mutate() {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "committed", "utf8");
      }
    });
    assert.equal(retried.routeConfigHash, emptySnapshot(input).routeConfigHash);
    assert.equal(fs.readFileSync(target, "utf8"), "committed");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("matching committed receipt wins over a stale pending journal and never rolls committed files back", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-receipt-recovery-"));
  const operationId = "receipt-before-pending-delete";
  const input = {
    ...transaction(rootDir, "commit", "attempt-commit", {
      kind: "replace",
      config: { gateways: [{ id: "A", configName: "A", gatewayPort: 20_001 }] }
    }),
    operationId
  };
  try {
    executeRouteCatalogTransaction(input);
    const adapterPath = path.join(input.routeRoot, "A", "adapterConfig.json");
    const pending = journalPath(rootDir, "pending", operationId);
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, `${JSON.stringify({
      version: 1,
      state: "applying",
      operationId,
      operationDigest: routeCatalogOperationDigest(input),
      routeRoot: path.resolve(input.routeRoot),
      rolesRoot: path.resolve(input.rolesRoot),
      fullRouteConfigSet: true,
      fullPersonaConfigSet: true,
      files: [{ target: adapterPath, existed: false }],
      directories: []
    }, null, 2)}\n`, "utf8");

    executeRouteCatalogTransaction(transaction(rootDir, "recover", "attempt-recover", { kind: "capture" }));
    assert.equal(fs.existsSync(adapterPath), true, "committed adapter was incorrectly rolled back");
    assert.equal(fs.existsSync(pending), false, "stale pending marker was not finalized");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("operationId replay ignores stale CAS and dynamic Manager port but rejects a different mutation", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-idempotency-"));
  const operationId = "stable-upstream-key";
  const config = { gateways: [{ id: "A", configName: "A", gatewayPort: 20_001 }] };
  try {
    const committed = executeRouteCatalogTransaction({
      ...transaction(rootDir, "first-request", "first-attempt", { kind: "replace", config }),
      operationId
    });
    const replayed = executeRouteCatalogTransaction({
      ...transaction(rootDir, "retry-request", "retry-attempt", {
        kind: "replace",
        config,
        expectedContentHash: "0".repeat(64)
      }),
      managerPort: 49_999,
      operationId
    });
    assert.equal(replayed.routeConfigHash, committed.routeConfigHash);
    assert.equal(replayed.requestId, "retry-request");
    assert.equal(replayed.attemptToken, "retry-attempt");
    assert.deepEqual(replayed.gateways.map(item => item.id), ["A"]);

    assert.throws(() => executeRouteCatalogTransaction({
      ...transaction(rootDir, "misuse-request", "misuse-attempt", {
        kind: "replace",
        config: { gateways: [{ id: "B", configName: "B", gatewayPort: 20_002 }] }
      }),
      operationId
    }), RouteCatalogIdempotencyConflictError);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("recovery fails closed on an out-of-root journal without deleting the evidence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-malicious-journal-"));
  const input = transaction(rootDir, "capture", "capture-attempt", { kind: "capture" });
  const operationId = "escaped-journal";
  const pending = journalPath(rootDir, "pending", operationId);
  const escaped = path.join(rootDir, "escaped.txt");
  try {
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.mkdirSync(input.rolesRoot, { recursive: true });
    fs.writeFileSync(pending, `${JSON.stringify({
      version: 1,
      state: "applying",
      operationId,
      operationDigest: "a".repeat(64),
      routeRoot: path.resolve(input.routeRoot),
      rolesRoot: path.resolve(input.rolesRoot),
      fullRouteConfigSet: false,
      fullPersonaConfigSet: false,
      files: [{ target: escaped, existed: false }],
      directories: []
    }, null, 2)}\n`, "utf8");
    assert.throws(() => executeRouteCatalogTransaction(input), /escaped its roots|outside its storage root/);
    assert.equal(fs.existsSync(pending), true, "invalid recovery evidence must remain fail-closed");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a committed receipt survives a replay capture failure and remains replayable", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-committed-replay-"));
  const input = {
    ...transaction(rootDir, "commit-replay", "attempt-commit-replay", {
      kind: "ensure_role_folder",
      roleId: "YeYu"
    }),
    operationId: "commit-replay"
  };
  const target = path.join(input.rolesRoot, "YeYu");
  try {
    executeDurableRouteCatalogMutation(input, {
      capture: () => emptySnapshot(input),
      prepare() {},
      mutate: () => { fs.mkdirSync(target, { recursive: true }); }
    });
    const receipt = journalPath(rootDir, "receipts", input.operationId);
    assert.equal(fs.existsSync(receipt), true);
    assert.throws(() => executeDurableRouteCatalogMutation(input, {
      capture: () => { throw new Error("replay capture unavailable"); },
      prepare() { throw new Error("must not prepare a committed replay"); },
      mutate() { throw new Error("must not reapply a committed replay"); }
    }), /replay capture unavailable/);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(receipt), true);

    const replayed = executeDurableRouteCatalogMutation(input, {
      capture: () => emptySnapshot(input),
      prepare() { throw new Error("must not prepare a committed replay"); },
      mutate() { throw new Error("must not reapply a committed replay"); }
    });
    assert.equal(replayed.routeConfigHash, emptySnapshot(input).routeConfigHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("captured gateways are canonically ordered before route hashes are published", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-catalog-order-"));
  try {
    const snapshot = executeRouteCatalogTransaction(transaction(rootDir, "ordered", "ordered-attempt", {
      kind: "replace",
      config: {
        gateways: [
          { id: "Z", configName: "Z", gatewayPort: 20_002 },
          { id: "A", configName: "A", gatewayPort: 20_001 }
        ]
      }
    }));
    assert.deepEqual(snapshot.gateways.map(item => item.id), ["A", "Z"]);
    assert.deepEqual(routeCatalogSnapshotIdentities(snapshot).routeConfigHash, snapshot.routeConfigHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("route catalog identities survive child-process JSON serialization", () => {
  const source = {
    routeRoot: "C:/RabiRoute/data/route",
    rolesRoot: "C:/RabiRoute/data/roles",
    gateways: [{ id: "demo", optionalLabel: undefined }],
    personas: [{
      rolesRoot: "C:/RabiRoute/data/roles",
      roleId: "Rabi",
      displayName: "Rabi",
      isPersona: true,
      avatarConfigured: false,
      avatarVersion: undefined
    }]
  };
  const transported = JSON.parse(JSON.stringify(source));
  assert.deepEqual(routeCatalogSnapshotIdentities(source), routeCatalogSnapshotIdentities(transported));
});
