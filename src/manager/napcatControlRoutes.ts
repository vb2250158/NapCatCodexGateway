import type http from "node:http";
import { NapcatLifecycleError } from "../shared/napcatStateContract.js";
import type {
  NapcatHealthRequest,
  NapcatLaunchRequest,
  NapcatLoginActionRequest,
  NapcatLoginPanelRequest,
  NapcatStopRequest
} from "../messageEndpoints/napcatManager.js";
export type {
  NapcatHealthRequest,
  NapcatLaunchRequest,
  NapcatLoginActionRequest,
  NapcatLoginPanelRequest
} from "../messageEndpoints/napcatManager.js";

export type NapcatAddRequest = {
  gatewayId?: string;
};

export type NapcatRemoveRequest = NapcatStopRequest;

export type NapcatControlResult = Record<string, unknown> & {
  ok?: unknown;
};

type MaybePromise<T> = T | Promise<T>;

export type NapcatControlRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  repairAll: () => MaybePromise<NapcatControlResult>;
  ensureReady: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  health: (request: NapcatHealthRequest) => MaybePromise<NapcatControlResult>;
  loginPanel: (request: NapcatLoginPanelRequest) => MaybePromise<NapcatControlResult>;
  loginAction: (request: NapcatLoginActionRequest) => MaybePromise<NapcatControlResult>;
  configureOneBot: (request: NapcatHealthRequest) => MaybePromise<NapcatControlResult>;
  add: (request: NapcatAddRequest) => MaybePromise<NapcatControlResult>;
  launch: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  restart: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  remove: (request: NapcatRemoveRequest) => MaybePromise<NapcatControlResult>;
};

type ResultStatus = (result: NapcatControlResult) => number;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function respondWithError(
  response: http.ServerResponse,
  context: NapcatControlRoutesContext,
  error: unknown
): void {
  context.jsonResponse(response, 400, { ok: false, message: errorMessage(error),
    ...(error instanceof NapcatLifecycleError ? { state: error.state } : {}) });
}

function handleBodyAction<RequestBody>(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: NapcatControlRoutesContext,
  action: (body: RequestBody) => MaybePromise<NapcatControlResult>,
  resultStatus: ResultStatus
): void {
  void context.readJsonBody<RequestBody>(request)
    .then((body) => action(body))
    .then((result) => {
      context.jsonResponse(response, resultStatus(result), result);
    })
    .catch((error) => {
      respondWithError(response, context, error);
    });
}

export function handleNapcatControlApi(
  request: http.IncomingMessage,
  url: URL,
  response: http.ServerResponse,
  context: NapcatControlRoutesContext
): boolean {
  if (request.method !== "POST") return false;

  if (url.pathname === "/api/message/napcat-repair-all") {
    void Promise.resolve()
      .then(() => context.repairAll())
      .then((result) => {
        context.jsonResponse(response, 200, result);
      })
      .catch((error) => {
        respondWithError(response, context, error);
      });
    return true;
  }

  if (url.pathname === "/api/message/napcat-ensure-ready") {
    handleBodyAction<NapcatLaunchRequest>(request, response, context, context.ensureReady, () => 200);
    return true;
  }

  if (url.pathname === "/api/message/napcat-health") {
    handleBodyAction<NapcatHealthRequest>(request, response, context, context.health, () => 200);
    return true;
  }

  if (url.pathname === "/api/message/napcat-login-panel") {
    response.setHeader("cache-control", "no-store");
    handleBodyAction<NapcatLoginPanelRequest>(request, response, context, context.loginPanel, () => 200);
    return true;
  }

  if (url.pathname === "/api/message/napcat-login-action") {
    response.setHeader("cache-control", "no-store");
    handleBodyAction<NapcatLoginActionRequest>(
      request,
      response,
      context,
      context.loginAction,
      (result) => result.ok !== false ? 200 : 400
    );
    return true;
  }

  if (url.pathname === "/api/message/napcat-configure-onebot") {
    handleBodyAction<NapcatHealthRequest>(
      request,
      response,
      context,
      context.configureOneBot,
      (result) => result.ok ? 200 : 400
    );
    return true;
  }

  if (url.pathname === "/api/message/napcat-add") {
    handleBodyAction<NapcatAddRequest>(
      request,
      response,
      context,
      context.add,
      (result) => result.ok ? 200 : 400
    );
    return true;
  }

  if (url.pathname === "/api/message/napcat-launch") {
    handleBodyAction<NapcatLaunchRequest>(
      request,
      response,
      context,
      context.launch,
      (result) => result.ok !== false ? 200 : 400
    );
    return true;
  }

  if (url.pathname === "/api/message/napcat-restart") {
    handleBodyAction<NapcatLaunchRequest>(
      request,
      response,
      context,
      context.restart,
      (result) => result.ok ? 200 : 400
    );
    return true;
  }

  if (url.pathname === "/api/message/napcat-remove") {
    handleBodyAction<NapcatRemoveRequest>(
      request,
      response,
      context,
      context.remove,
      (result) => result.ok ? 200 : 400
    );
    return true;
  }

  return false;
}
