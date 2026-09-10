import type http from "node:http";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import type { InstanceAgent } from "../shared/agentInstance.js";

export type LanAgentRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  isReleaseRequestAuthorized: (request: http.IncomingMessage) => boolean;
  isManagementRequestAuthorized: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  registry: LanAgentRegistry;
  releases: LanAgentReleaseStore;
  localAgents?: () => InstanceAgent[];
  handleInstanceHook?: (instanceId: string, agentId: string, body: Record<string, unknown>, request: http.IncomingMessage) => Promise<unknown>;
  manageLocalAgent?: (agentId: string, operation: string, body: Record<string, unknown>) => Promise<unknown>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentUnauthorized(
  response: http.ServerResponse,
  context: LanAgentRoutesContext,
  error: "LAN_AGENT_TOKEN_REQUIRED" | "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED" = "LAN_AGENT_TOKEN_REQUIRED"
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("www-authenticate", "Bearer realm=\"RabiRoute LAN Agent\"");
  context.jsonResponse(response, 401, {
    code: -1,
    error,
    message: error === "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED"
      ? "Rabi Agent management requires an explicit WebGUI access Token, including on loopback."
      : "Rabi Agent resource access requires the LAN connection Token."
  });
}

function writeAsset(response: http.ServerResponse, content: Buffer, assetPath: string): void {
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", assetPath.endsWith(".mjs") ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8");
  response.setHeader("content-length", content.byteLength);
  response.end(content);
}

export function handleLanAgentApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: LanAgentRoutesContext
): boolean {
  if (requestUrl.pathname === "/api/lan-agent/instances" && request.method === "GET") {
    if (!context.isManagementRequestAuthorized(request, requestUrl)) { agentUnauthorized(response, context, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED"); return true; }
    context.jsonResponse(response, 200, { code: 0, instances: context.registry.listInstances(context.localAgents?.()) });
    return true;
  }
  const instanceAction = requestUrl.pathname.match(/^\/api\/lan-agent\/instances\/([^/]+)\/agents(?:\/([^/]+)\/(tasks|configure|scan|threads|hooks|context))?$/);
  if (instanceAction && request.method === "POST") {
    if (!context.isManagementRequestAuthorized(request, requestUrl)) { agentUnauthorized(response, context, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED"); return true; }
    void context.readJsonBody<Record<string, unknown>>(request).then(async body => {
      const instanceId = decodeURIComponent(instanceAction[1]!);
      const agentId = instanceAction[2] ? decodeURIComponent(instanceAction[2]) : undefined;
      if (instanceId === context.registry.localInstanceId) {
        if (!agentId || !context.manageLocalAgent) throw new Error("Local Agent management is unavailable.");
        return context.manageLocalAgent(agentId, instanceAction[3] || "configure", body);
      }
      if (instanceAction[3] === "context") {
        if (!agentId || !context.handleInstanceHook) throw new Error("Instance Hook handler is unavailable.");
        return context.handleInstanceHook(instanceId, agentId, body, request);
      }
      if (instanceAction[3] === "tasks") {
        const agent = context.registry.listInstances().find(instance => instance.instanceId === instanceId)?.agents.find(agent => agent.agentId === agentId);
        if (!agent) throw new Error("Instance Agent was not found. Refresh the instance catalog.");
        if (body.provider && body.provider !== agent.provider) throw new Error("Route provider does not match the bound instance Agent.");
        const task = context.registry.assignTask({ nodeId: instanceId, agentId, targetAgent: agent.provider, message: String(body.message || ""), idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined });
        return context.registry.waitForTaskAcceptance(task.taskId);
      }
      return context.registry.manageAgent(instanceId, instanceAction[3] || "configure", { ...body, agentId }, instanceAction[3] === "hooks" ? 90_000 : 30_000);
    }).then(result => context.jsonResponse(response, 200, { code: 0, result, ...(instanceAction[3] === "context" ? { data: result } : {}) }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/lan-agent/releases/manifest") {
    if (!context.isReleaseRequestAuthorized(request)) {
      agentUnauthorized(response, context);
      return true;
    }
    try {
      context.jsonResponse(response, 200, { code: 0, release: context.releases.manifest() });
    } catch (error) {
      context.jsonResponse(response, 503, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  const releaseAssetMatch = request.method === "GET"
    ? requestUrl.pathname.match(/^\/api\/lan-agent\/releases\/([^/]+)\/([^/]+)\/(.+)$/)
    : null;
  if (releaseAssetMatch) {
    if (!context.isReleaseRequestAuthorized(request)) {
      agentUnauthorized(response, context);
      return true;
    }
    try {
      const version = decodeURIComponent(releaseAssetMatch[1] ?? "");
      const platform = decodeURIComponent(releaseAssetMatch[2] ?? "");
      const assetPath = (releaseAssetMatch[3] ?? "").split("/").map(decodeURIComponent).join("/");
      writeAsset(response, context.releases.readAsset(version, platform, assetPath), assetPath);
    } catch (error) {
      context.jsonResponse(response, 404, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/lan-agent/nodes") {
    if (!context.isManagementRequestAuthorized(request, requestUrl)) {
      agentUnauthorized(response, context, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED");
      return true;
    }
    const release = context.releases.manifest();
    context.jsonResponse(response, 200, {
      code: 0,
      nodes: context.registry.listNodes(),
      tasks: context.registry.listTasks(100),
      releaseVersion: release.version,
      releasePublicKeySha256: release.publicKeySha256
    });
    return true;
  }

  const nodeMatch = requestUrl.pathname.match(/^\/api\/lan-agent\/nodes\/([^/]+)\/(update|tasks)$/);
  if (request.method === "POST" && nodeMatch) {
    if (!context.isManagementRequestAuthorized(request, requestUrl)) {
      agentUnauthorized(response, context, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED");
      return true;
    }
    const nodeId = decodeURIComponent(nodeMatch[1] ?? "");
    const action = nodeMatch[2] ?? "";
    void context.readJsonBody<Record<string, unknown>>(request)
      .then(async body => {
        if (action === "update") {
          const version = typeof body.version === "string" && body.version.trim()
            ? body.version.trim()
            : context.releases.manifest().version;
          return context.registry.requestUpdate(nodeId, version);
        }
        const task = context.registry.assignTask({
          nodeId,
          targetAgent: String(body.targetAgent || context.registry.listNodes().find(node => node.nodeId === nodeId)?.agentTypes?.[0] || ""),
          message: String(body.message ?? ""),
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          taskId: typeof body.taskId === "string" ? body.taskId : undefined,
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined
        });
        return context.registry.waitForTaskAcceptance(task.taskId);
      })
      .then(result => context.jsonResponse(response, 202, { code: 0, result }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) }));
    return true;
  }

  return false;
}
