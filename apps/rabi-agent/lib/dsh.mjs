import { randomUUID } from "node:crypto";

export function normalizeDshBinding(value) {
  const url = new URL(String(value?.baseUrl || ""));
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("DSH must use its explicitly discovered local API address.");
  const sessionId = String(value?.sessionId || "").trim();
  if (!sessionId) throw new Error("DSH requires an existing session ID discovered by the target Agent.");
  return { baseUrl: url.origin, sessionId };
}

export async function sendDshTask(binding, prompt) {
  const { baseUrl, sessionId } = normalizeDshBinding(binding);
  const rpcId = randomUUID();
  const method = "session.prompt";
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload: { sessionId, mode: "queue", content: [{ type: "text", text: prompt }] } }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`DSH task delivery failed: HTTP ${response.status}`);
  const body = await response.json();
  if (body.rpcId !== rpcId || body.result?.ok !== true) throw new Error("DSH rejected the task or returned a mismatched receipt; check the bound session and service.");
}
