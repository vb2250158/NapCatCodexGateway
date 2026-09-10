import type http from "node:http";
import type { AgentDeliveryTestResult } from "../agentDeliveryTest.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import type { DeliveryReplayRequest } from "../deliveryReplay.js";
import type { GatewayConfigFile, GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { ManualTriggerLaunchResult } from "./manualTriggerProcess.js";

export type GatewayAgentDeliveryTestRequest = {
  agentAdapterType?: AgentAdapterType;
};

export type GatewayManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
  triggerSource?: "manual" | "auto";
};

export type GatewayPayloadOptions = {
  includeDiagnostics?: boolean;
  includeConfigDefinitions?: boolean;
};

export type GatewayWeixinLoginTarget = {
  enabled: boolean;
  dataDir: string;
};

export type GatewayControlRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  redirectResponse: (response: http.ServerResponse, statusCode: number, location: string) => void;
  gatewayPayload: (options?: GatewayPayloadOptions) => Record<string, unknown>;
  writeConfig: (
    config: GatewayConfigFile,
    expectedContentHash: string | undefined,
    operationId: string
  ) => Promise<GatewayConfigFile>;
  writeGatewayConfig: (id: string, definition: GatewayDefinition, hash: string, operationId: string) => Promise<void>;
  resolveRouteMutation: (operationId: string) => Promise<{ state: "committed" | "not_committed" }>;
  loadRuntimes: () => Promise<void>;
  syncRunningGateways: () => void;
  runtimeStatuses: () => unknown[];
  networkOptionsPayload: () => Record<string, unknown>;
  startGateway: (id: string) => void;
  stopGateway: (id: string) => void;
  restartGateway: (id: string) => void;
  removeGatewayConfig: (
    id: string,
    expectedContentHash: string | undefined,
    operationId: string
  ) => Promise<void>;
  routeCatalogVersion: () => Readonly<{
    contentHash: string;
    routeConfigHash: string;
    presentationHash: string;
    revision: number;
  }>;
  weixinLoginTarget: (id: string) => GatewayWeixinLoginTarget | undefined;
  requestWeixinLogin: (dataDir: string) => void;
  triggerManualRule: (id: string, request: GatewayManualTriggerRequest) => ManualTriggerLaunchResult;
  testAgentDelivery: (id: string, request: GatewayAgentDeliveryTestRequest) => Promise<AgentDeliveryTestResult>;
  listDeliveryReplayAttempts: (id: string, limit: number, status: string | null) => Record<string, unknown>;
  replayDelivery: (id: string, request: DeliveryReplayRequest) => Promise<void>;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown, fallback = 400): number {
  const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : fallback;
}

function errorCode(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : "request_failed";
}

function publicRouteMutationError(error: unknown): Readonly<{
  statusCode: number;
  errorCode: string;
  message: string;
}> {
  switch (errorCode(error)) {
    case "ROUTE_CATALOG_REVISION_CONFLICT":
    case "route_catalog_conflict":
      return Object.freeze({
        statusCode: 412,
        errorCode: "route_catalog_conflict",
        message: "Route catalog changed; refresh and retry this update."
      });
    case "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT":
      return Object.freeze({
        statusCode: 409,
        errorCode: "route_catalog_idempotency_conflict",
        message: "Idempotency-Key was already used for a different route catalog update."
      });
    case "ROUTE_CATALOG_BUSY":
      return Object.freeze({
        statusCode: 503,
        errorCode: "route_catalog_busy",
        message: "Route catalog update queue is temporarily full."
      });
    case "ROUTE_CATALOG_TRANSACTION_FAILED":
      return Object.freeze({
        statusCode: 500,
        errorCode: "route_catalog_transaction_failed",
        message: "Route catalog update failed."
      });
    default:
      return Object.freeze({
        statusCode: errorStatus(error),
        errorCode: errorCode(error),
        message: errorMessage(error)
      });
  }
}

function expectedContentHash(
  request: http.IncomingMessage,
  _context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">
): string {
  const header = Array.isArray(request.headers["if-match"])
    ? request.headers["if-match"][0] ?? ""
    : request.headers["if-match"] ?? "";
  const raw = String(header).trim();
  if (!raw) {
    throw Object.assign(new Error("If-Match is required for route catalog mutations."), {
      statusCode: 400,
      code: "route_catalog_revision_required"
    });
  }
  if (raw === "*" || /^W\//i.test(raw)) {
    throw Object.assign(new Error("If-Match must contain the exact strong route catalog revision."), {
      statusCode: 400,
      code: "route_catalog_revision_invalid"
    });
  }
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw Object.assign(new Error("If-Match contains an invalid route catalog revision."), {
      statusCode: 400,
      code: "route_catalog_revision_invalid"
    });
  }
  return value.toLowerCase();
}

function routeMutationOperationId(request: http.IncomingMessage): string {
  const header = Array.isArray(request.headers["idempotency-key"])
    ? request.headers["idempotency-key"][0] ?? ""
    : request.headers["idempotency-key"] ?? "";
  const operationId = String(header).trim();
  if (!operationId) {
    throw Object.assign(new Error("Idempotency-Key is required for route catalog mutations."), {
      statusCode: 400,
      code: "idempotency_key_required"
    });
  }
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(operationId)) {
    throw Object.assign(new Error("Idempotency-Key is invalid for a route catalog mutation."), {
      statusCode: 400,
      code: "idempotency_key_invalid"
    });
  }
  return operationId;
}

function withRouteCatalogVersion(
  context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return { ...payload, routeCatalog: context.routeCatalogVersion() };
}

function withRouteMutationReceipt(
  context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">,
  operationId: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const routeCatalog = context.routeCatalogVersion();
  return {
    ...payload,
    receipt: {
      state: "committed",
      operationId,
      routeConfigHash: routeCatalog.routeConfigHash
    },
    routeCatalog
  };
}
function runTrackedOperation<T>(
  context: Pick<GatewayControlRoutesContext, "trackOperation">,
  operation: Promise<T>
): void {
  void (context.trackOperation?.(operation) ?? operation);
}

function decodedGatewayId(encodedId: string): string {
  return decodeURIComponent(encodedId);
}

function handleGatewayAction(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/(start|stop|restart|delete)$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  const action = match[2];
  try {
    if (action === "start") {
      context.startGateway(id);
    } else if (action === "stop") {
      context.stopGateway(id);
    } else if (action === "restart") {
      context.restartGateway(id);
    } else {
      const operationId = routeMutationOperationId(request);
      runTrackedOperation(context, context.removeGatewayConfig(
        id,
        expectedContentHash(request, context),
        operationId
      )
        .then(() => {
          context.syncRunningGateways();
          context.jsonResponse(response, 200, withRouteMutationReceipt(context, operationId, context.gatewayPayload()));
        })
        .catch(error => {
          const failure = publicRouteMutationError(error);
          context.jsonResponse(response, failure.statusCode, {
            code: -1,
            errorCode: failure.errorCode,
            message: failure.message
          });
        }));
      return true;
    }
  } catch (error) {
    if (action !== "delete") {
      context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
      return true;
    }
    const failure = publicRouteMutationError(error);
    context.jsonResponse(response, failure.statusCode, {
      code: -1,
      errorCode: failure.errorCode,
      message: failure.message
    });
    return true;
  }

  context.jsonResponse(response, 200, {
    code: 0,
    message: `requested ${action}`,
    data: context.runtimeStatuses()
  });
  return true;
}

function handleWeixinLogin(
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/weixin-login$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  const target = context.weixinLoginTarget(id);
  if (!target) {
    context.jsonResponse(response, 404, { code: -1, message: `Gateway not found: ${id}` });
    return true;
  }
  if (!target.enabled) {
    context.jsonResponse(response, 400, { code: -1, message: "该 Route 未启用个人微信消息端。" });
    return true;
  }

  try {
    context.requestWeixinLogin(target.dataDir);
    context.jsonResponse(response, 202, {
      code: 0,
      message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。"
    });
  } catch (error) {
    context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
  }
  return true;
}

function handleManualTrigger(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/manual-trigger$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  runTrackedOperation(context, context.readJsonBody<GatewayManualTriggerRequest>(request)
    .then((body) => {
      const result = context.triggerManualRule(id, body);
      context.jsonResponse(response, 202, {
        code: 0,
        message: result.alreadyRunning ? "manual trigger already running" : "manual trigger accepted",
        data: result
      });
    })
    .catch((error) => {
      context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
    }));
  return true;
}

function handleAgentDeliveryTest(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/agent-delivery-test$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  runTrackedOperation(context, context.readJsonBody<GatewayAgentDeliveryTestRequest>(request)
    .then((body) => context.testAgentDelivery(id, body))
    .then((result) => {
      context.jsonResponse(response, 200, {
        code: 0,
        message: "agent delivery test completed",
        data: result
      });
    })
    .catch((error) => {
      context.jsonResponse(response, 502, { code: -1, message: errorMessage(error) });
    }));
  return true;
}

function handleDeliveryReplay(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = requestUrl.pathname.match(/^\/gateways\/([^/]+)\/delivery-replay$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  if (request.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "50") || 50;
      const status = requestUrl.searchParams.get("status");
      context.jsonResponse(response, 200, {
        code: 0,
        ...context.listDeliveryReplayAttempts(id, limit, status)
      });
    } catch (error) {
      context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "POST") {
    runTrackedOperation(context, context.readJsonBody<DeliveryReplayRequest>(request)
      .then((body) => context.replayDelivery(id, body))
      .then(() => {
        context.jsonResponse(response, 202, {
          code: 0,
          message: "delivery replay requested",
          data: context.runtimeStatuses()
        });
      })
      .catch((error) => {
        context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
      }));
    return true;
  }

  context.jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}

export function handleGatewayControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const mutationMatch = requestUrl.pathname.match(/^\/gateways\/mutations\/([A-Za-z0-9%:._-]+)$/);
  if (request.method === "GET" && mutationMatch) {
    const operationId = decodeURIComponent(mutationMatch[1]);
    runTrackedOperation(context, context.resolveRouteMutation(operationId).then(result => {
      context.jsonResponse(response, 200, {
        ...withRouteCatalogVersion(context, context.gatewayPayload({ includeDiagnostics: false, includeConfigDefinitions: true })),
        receipt: { ...result, operationId, routeConfigHash: context.routeCatalogVersion().routeConfigHash }
      });
    }).catch(error => {
      const failure = publicRouteMutationError(error);
      context.jsonResponse(response, failure.statusCode, { code: -1, ...failure });
    }));
    return true;
  }
  const configMatch = requestUrl.pathname.match(/^\/gateways\/([^/]+)\/config$/);
  if (request.method === "PUT" && configMatch) {
    runTrackedOperation(context, context.readJsonBody<GatewayDefinition>(request).then(async definition => {
      const operationId = routeMutationOperationId(request);
      await context.writeGatewayConfig(decodeURIComponent(configMatch[1]), definition, expectedContentHash(request, context), operationId);
      // Persistence has its own result; runtime activation cannot turn a committed write into a failed save.
      let activationError: string | undefined;
      try { context.syncRunningGateways(); } catch (error) { activationError = errorMessage(error); }
      context.jsonResponse(response, 200, {
        ...withRouteMutationReceipt(context, operationId, context.gatewayPayload({ includeDiagnostics: false, includeConfigDefinitions: true })),
        activation: activationError ? { state: "failed", message: activationError } : { state: "requested" }
      });
    }).catch(error => {
      const failure = publicRouteMutationError(error);
      context.jsonResponse(response, failure.statusCode, { code: -1, ...failure });
    }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/gateways") {
    context.jsonResponse(response, 200, withRouteCatalogVersion(context, context.gatewayPayload({
      includeDiagnostics: requestUrl.searchParams.get("summary") !== "1",
      includeConfigDefinitions: requestUrl.searchParams.get("summary") !== "1"
        || requestUrl.searchParams.get("includeConfig") === "1"
    })));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/gateways") {
    let operationId = "";
    runTrackedOperation(context, context.readJsonBody<GatewayConfigFile>(request)
      .then(async (body) => {
        operationId = routeMutationOperationId(request);
        await context.writeConfig(
          body,
          expectedContentHash(request, context),
          operationId
        );
        context.syncRunningGateways();
        context.jsonResponse(response, 200, withRouteMutationReceipt(context, operationId, context.gatewayPayload()));
      })
      .catch((error) => {
        const failure = publicRouteMutationError(error);
        context.jsonResponse(response, failure.statusCode, {
          code: -1,
          errorCode: failure.errorCode,
          message: failure.message
        });
      }));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/network-options") {
    context.jsonResponse(response, 200, context.networkOptionsPayload());
    return true;
  }

  if (request.method === "POST" && handleGatewayAction(request, requestUrl.pathname, response, context)) return true;
  if (request.method === "POST" && handleWeixinLogin(requestUrl.pathname, response, context)) return true;
  if (request.method === "POST" && handleManualTrigger(request, requestUrl.pathname, response, context)) return true;
  if (request.method === "POST" && handleAgentDeliveryTest(request, requestUrl.pathname, response, context)) return true;
  if (handleDeliveryReplay(request, requestUrl, response, context)) return true;

  if (request.method === "POST" && requestUrl.pathname === "/reload") {
    runTrackedOperation(context, context.loadRuntimes()
      .then(() => {
        context.syncRunningGateways();
        if (request.headers.accept?.includes("application/json")) {
          context.jsonResponse(response, 200, {
            ok: true,
            gateways: context.runtimeStatuses(),
            routeCatalog: context.routeCatalogVersion()
          });
        } else {
          context.redirectResponse(response, 303, "/");
        }
      })
      .catch(error => {
        context.jsonResponse(response, errorStatus(error, 503), { code: -1, message: errorMessage(error) });
      }));
    return true;
  }

  return false;
}
