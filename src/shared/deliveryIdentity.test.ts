import assert from "node:assert/strict";
import test from "node:test";
import { deliveryIdFromPrompt, withoutLegacyTransportSuffix, deliveryUserMessagesFromRollout } from "./deliveryIdentity.js";
import { renderRabiDelivery } from "./rabiMessage.js";
import { ensureCodexDesktopDeliveryMarkerForTest } from "../codexRuntime.js";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const other = "12345678-1234-4567-8123-123456789abc";
const envelope = { messageSource: { type: "agent" as const, agentAdapter: "codex" as const, sessionName: "Sender", sessionId: "sender" }, messageContent: "Original evidence" };

test("JSON reply identity survives the real runtime marker preparation byte-for-byte", () => {
  const prompt = renderRabiDelivery({ ...envelope, controlBlocks: [`[回传参数]\n${JSON.stringify({ deliveryId: id, responsePolicy: "none" }, null, 2)}`] });
  for (const requested of [undefined, id]) {
    assert.deepEqual(ensureCodexDesktopDeliveryMarkerForTest(prompt, requested), { prompt, deliveryId: id });
  }
  assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(prompt, other), /conflicts/);
  const historical = `${prompt}\n\n[投递编号]\ndeliveryId: ${other}`;
  assert.equal(deliveryIdFromPrompt(historical), id);
  assert.equal(withoutLegacyTransportSuffix(historical), prompt);
  assert.equal(withoutLegacyTransportSuffix(historical + "\n"), undefined);
  assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(historical), /reconcile instead of resending/);
});

test("standalone envelope ID survives transport without an appended marker", () => {
  const prompt = renderRabiDelivery({ ...envelope, deliveryId: id });
  assert.deepEqual(ensureCodexDesktopDeliveryMarkerForTest(prompt), { prompt, deliveryId: id });
});

test("receipt extraction ignores assistant/tool quotes and unframed JSON", () => {
  const prompt = renderRabiDelivery({ ...envelope, deliveryId: id });
  const record = (role: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text: prompt }] } });
  assert.deepEqual(deliveryUserMessagesFromRollout([record("assistant"), record("tool"), record("user")].join("\n")), [prompt]);
  assert.equal(deliveryIdFromPrompt(`quoted\n${prompt}`), "");
  assert.equal(deliveryIdFromPrompt(`{"deliveryId":"${id}"}`), "");
  assert.equal(withoutLegacyTransportSuffix(`${prompt}\n\n[投递编号]\ndeliveryId: ${other}\nextra`), undefined);
});
