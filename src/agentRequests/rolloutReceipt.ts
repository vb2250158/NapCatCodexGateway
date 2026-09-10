import fs from "node:fs";
import { createInterface } from "node:readline";
import { deliveryIdFromPrompt, deliveryUserMessagesFromRollout } from "../shared/deliveryIdentity.js";

export function promptConfirmsDelivery(prompt: string, deliveryId: string): boolean {
  if (!deliveryId) return false;
  if (deliveryIdFromPrompt(prompt) === deliveryId) return true;
  // Historical plan feedback used a feedback ID in its Manager-generated body.
  // Keep this exact envelope/field check until those pending records are closed.
  const normalized = prompt.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("[消息源]\n")) return false;
  const body = normalized.split("\n\n[消息内容]\n")[1];
  return Boolean(body && /^(\[计划引导：|\[计划审批：|\[QA失败回传：)/.test(body)
    && body.split("\n")[3] === `反馈 ID：${deliveryId}`);
}

/** Point lookup in the exact task's accepted user messages, without a tail-size cutoff. */
export async function* readRolloutUserMessages(filePath: string): AsyncGenerator<string> {
  const size = (await fs.promises.stat(filePath)).size;
  if (!size) return;
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8", end: size - 1, signal: AbortSignal.timeout(30_000)
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      for (const prompt of deliveryUserMessagesFromRollout(line)) yield prompt;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function findRolloutDeliveryReceipt(filePath: string, deliveryId: string): Promise<boolean> {
  if (!deliveryId) return false;
  for await (const prompt of readRolloutUserMessages(filePath)) {
    if (promptConfirmsDelivery(prompt, deliveryId)) return true;
  }
  return false;
}
