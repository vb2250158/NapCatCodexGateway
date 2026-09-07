function sentResult(value) {
  const parsed = value?.parsed;
  return parsed?.status === "sent" && String(parsed?.sentMessageId || "").trim() ? parsed : null;
}

function failedResult(value) {
  const parsed = value?.parsed;
  return parsed?.status === "failed" && receiptState(value) === "completed" ? parsed : null;
}

function failedMessage(deliveryId, result) {
  const reason = String(result?.reason || result?.message || "unknown failure").trim();
  return `Idempotent Agent reply ${deliveryId} failed: ${reason}. Use a new delivery key only after confirming no sentMessageId exists.`;
}

function receiptState(value) {
  const state = String(value?.parsed?.idempotency?.state || "").trim();
  if (state) return state;
  return "";
}

async function readTerminalReceipt({ deliveryId, readReceipt, wait, receiptAttempts }) {
  let latestState = "";
  for (let attempt = 0; attempt < receiptAttempts; attempt += 1) {
    const lookup = await readReceipt();
    const sent = sentResult(lookup);
    if (sent) return { state: "completed", result: sent };
    const failed = failedResult(lookup);
    if (failed) return { state: "failed", result: failed };
    latestState = receiptState(lookup);
    if (["missing", "conflict", "uncertain"].includes(latestState)) return { state: latestState };
    if (attempt + 1 < receiptAttempts) await wait(200);
  }
  return { state: latestState || "uncertain" };
}

export async function sendWorkCycleAgentReplyWithRecovery({
  deliveryId,
  payload,
  post,
  readReceipt,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  receiptAttempts = 6
}) {
  for (let postAttempt = 0; postAttempt < 2; postAttempt += 1) {
    const posted = await post(payload);
    const sent = sentResult(posted);
    if (sent) return sent;
    const failed = failedResult(posted);
    if (failed) throw new Error(failedMessage(deliveryId, failed));
    const postedState = receiptState(posted);
    if (postedState === "conflict") {
      throw new Error(`Idempotent Agent reply ${deliveryId} conflicts with an earlier payload; start a new begin→finish cycle before changing the inquiry.`);
    }
    if (postedState === "uncertain") {
      throw new Error(`Idempotent Agent reply ${deliveryId} is uncertain; do not resend automatically.`);
    }

    const receipt = await readTerminalReceipt({ deliveryId, readReceipt, wait, receiptAttempts });
    if (receipt.state === "completed") return receipt.result;
    if (receipt.state === "failed") throw new Error(failedMessage(deliveryId, receipt.result));
    if (receipt.state === "conflict" || receipt.state === "uncertain") {
      throw new Error(`Idempotent Agent reply ${deliveryId} is ${receipt.state}; do not resend automatically.`);
    }
    if (receipt.state !== "missing") {
      throw new Error(`Idempotent Agent reply ${deliveryId} is ${receipt.state}; do not resend automatically.`);
    }
    if (postAttempt === 1) {
      throw new Error(`Idempotent Agent reply ${deliveryId} is missing after one bounded retry; do not resend automatically.`);
    }
  }
  throw new Error(`Idempotent Agent reply ${deliveryId} did not reach a terminal state.`);
}
