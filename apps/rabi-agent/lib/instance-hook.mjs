import fs from "node:fs";

/** Installed beside private config; Hook callers send only their own registered session. */
export async function requestInstanceHook(input, configPath, fetcher = fetch) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sessionId = input.session_id || input.sessionId;
  const agents = config.agents || [{ agentId: "default", enabled: true, sessionId: config.agentType === "dsh" ? config.dsh?.sessionId : config.codexDesktop?.threadId }];
  const agent = agents.find(agent => agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId));
  if (!agent) return undefined;
  if (agent.enabled === false) return { action: "none", additionalContext: "" };
  const baseUrl = new URL(config.managerUrl).origin;
  const signal = AbortSignal.timeout(8000);
  const health = await fetcher(`${baseUrl}/meta`, { signal });
  const meta = await health.json();
  if (!health.ok || meta.health?.state !== "healthy" || meta.health?.requiredReady !== true) throw new Error("The connected Manager is not ready.");
  const response = await fetcher(`${baseUrl}/api/lan-agent/instances/${encodeURIComponent(config.nodeId)}/agents/${encodeURIComponent(agent.agentId)}/context`, {
    method: "POST", headers: { authorization: `Bearer ${config.lanLinkToken}`, "content-type": "application/json" }, body: JSON.stringify(input), signal
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(body.message || "Instance Hook failed.");
  return body.data;
}
