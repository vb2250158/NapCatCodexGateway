const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const validId = new RegExp(`^${uuid}$`, "i");
const transportSuffix = new RegExp(`\\n\\n\\[投递编号\\]\\ndeliveryId: (${uuid})(?![\\s\\S])`, "i");

/** Only the exact suffix emitted by the historical Desktop transport is removable. */
export function withoutLegacyTransportSuffix(prompt: string): string | undefined {
  const text = prompt.replace(/\r\n/g, "\n");
  const match = transportSuffix.exec(text);
  if (!match || text.split("[投递编号]").length !== 2) return undefined;
  return text.slice(0, match.index);
}

export function currentEnvelopeDeliveryId(prompt: string): string {
  const text = prompt.replace(/\r\n/g, "\n");
  if (!text.startsWith("[消息源]\n")) return "";
  const headerEnd = text.indexOf("\n\n[消息内容]\n");
  if (headerEnd < 0) return "";
  const headerId = /^投递 ID：([^\n]+)$/m.exec(text.slice(0, headerEnd))?.[1];
  if (headerId && validId.test(headerId)) return headerId;
  const parts = text.split("\n\n[回传参数]\n");
  if (parts.length !== 2) return "";
  try {
    const parameters = JSON.parse(parts[1]);
    return (parameters.responsePolicy === "required" || parameters.responsePolicy === "none")
      && typeof parameters.deliveryId === "string" && validId.test(parameters.deliveryId)
      ? parameters.deliveryId : "";
  } catch { return ""; }
}

/** Shared by the runtime marker writer and Desktop receipt reader. */
export function deliveryIdFromPrompt(prompt: string): string {
  prompt = prompt.replace(/\r\n/g, "\n");
  const current = currentEnvelopeDeliveryId(prompt);
  if (current) return current;
  const prefix = withoutLegacyTransportSuffix(prompt);
  if (prefix) {
    const original = currentEnvelopeDeliveryId(prefix);
    if (original) return original;
  }
  const tail = transportSuffix.exec(prompt)?.[1];
  if (tail) return tail;
  const legacyContract = prompt.startsWith("[消息源]\n")
    ? prompt.split("\n\n[Agent 回复合同]\n")[1]
    : prompt.startsWith("[Agent 回复合同]\n") ? prompt.slice("[Agent 回复合同]\n".length) : prompt;
  return new RegExp(`^(?:本次投递 |本批投递 )?deliveryId[：:] *(${uuid})(?:\\n|$)`, "i")
    .exec(legacyContract || "")?.[1] || "";
}

/** Only accepted user text is receipt evidence; tools and assistant quotations are not. */
export function deliveryUserMessagesFromRollout(text: string): string[] {
  return text.split("\n").flatMap(line => {
    try {
      const record = JSON.parse(line);
      if (record.type !== "response_item" || record.payload?.type !== "message"
        || record.payload.role !== "user" || !Array.isArray(record.payload.content)) return [];
      return [record.payload.content.filter((item: { type?: string }) => item.type === "input_text")
        .map((item: { text?: string }) => item.text || "").join("\n")];
    } catch { return []; }
  });
}
