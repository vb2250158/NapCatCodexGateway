import type { AgentCompletionDeliveryRule } from "@shared/gatewayConfigModel";

/** getRandomValues also works on the HTTP LAN console, where randomUUID is unavailable. */
export function createAgentCompletionRule(random: Pick<Crypto, "getRandomValues"> = globalThis.crypto): AgentCompletionDeliveryRule {
  const bytes = random.getRandomValues(new Uint8Array(16));
  const id = `completion-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
  return { id, enabled: false, event: "task_completed", conditions: [],
    destination: { channel: "napcat", gatewayId: "", params: { target: "group", targetId: "", instanceId: "" } } };
}
