import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCompletionRule } from "../src/persona/agentCompletionRules";

test("completion rule creation works with LAN HTTP crypto and starts disabled", () => {
  const lanCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  assert.equal("randomUUID" in lanCrypto, false);
  const first = createAgentCompletionRule(lanCrypto);
  const second = createAgentCompletionRule(lanCrypto);
  assert.match(first.id, /^completion-[a-f0-9]{32}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.enabled, false);
  assert.equal(first.destination.params.targetId, "");
  assert.deepEqual(first.conditions, []);
  assert.equal(first.event, "task_completed");
});
