import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findRolloutDeliveryReceipt } from "./rolloutReceipt.js";

const deliveryId = "12345678-1234-4567-8123-123456789abc";
const prompt = `[消息源]\n投递 ID：${deliveryId}\n\n[消息内容]\nWork`;
function row(role: string, text: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } }) + "\n";
}

test("receipt lookup finds an accepted user message beyond the old 4 MiB tail", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("user", prompt) + row("assistant", "x".repeat(5 * 1024 * 1024)));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), true);
  assert.equal(await findRolloutDeliveryReceipt(file, "missing"), false);
});

test("receipt lookup rejects assistant quotations and accepts exact historical plan feedback", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-feedback-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", prompt));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), false);
  fs.appendFileSync(file, row("user", "[消息源]\n消息源类型：计划\n\n[消息内容]\n[计划审批：已直接投递到绑定业务会话]\n计划：Example\n计划 ID：plan-one\n反馈 ID：feedback-one\n意见：继续"));
  assert.equal(await findRolloutDeliveryReceipt(file, "feedback-one"), true);
  assert.equal(await findRolloutDeliveryReceipt(file, "feedback-on"), false);
  await assert.rejects(findRolloutDeliveryReceipt(path.join(root, "absent.jsonl"), deliveryId), /ENOENT/);
});
