import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";

export const MANAGER_READY_PREFIX = "RABIROUTE_MANAGER_READY:";
export const HOST_SHUTDOWN_PATH = "/_rabiroute/host/shutdown";

export type ManagerHostIdentity = Readonly<{
  applicationGenerationId: string;
  controlToken: string;
}>;

export type ManagerReadyDescriptor = Readonly<{
  protocolVersion: 1;
  applicationGenerationId: string;
  managerInstanceId: string;
  pid: number;
  baseUrl: string;
  readyAt: string;
}>;

function requiredEnvironmentText(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimumLength: number,
  maximumLength: number
): string {
  const value = String(environment[name] || "").trim();
  if (
    value.length < minimumLength
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is required for a Host-owned Manager process.`);
  }
  return value;
}

export function managerHostIdentityFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): ManagerHostIdentity | null {
  if (String(environment.RABIROUTE_HOSTED || "").trim() !== "1") return null;
  const applicationGenerationId = requiredEnvironmentText(
    environment,
    "RABIROUTE_APPLICATION_GENERATION_ID",
    32,
    80
  );
  if (!/^[0-9a-f-]{32,80}$/i.test(applicationGenerationId)) {
    throw new Error("RABIROUTE_APPLICATION_GENERATION_ID is invalid.");
  }
  const controlToken = requiredEnvironmentText(
    environment,
    "RABIROUTE_HOST_CONTROL_TOKEN",
    32,
    512
  );
  return Object.freeze({ applicationGenerationId, controlToken });
}

function tokenMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function managerHostRequestAuthorized(request: http.IncomingMessage, identity: ManagerHostIdentity | null): boolean {
  return Boolean(identity && isLoopbackRemoteAddress(request.socket.remoteAddress)
    && tokenMatches(request.headers["x-rabiroute-host-token"], identity.controlToken));
}

export function handleManagerHostLifecycleRequest(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  options: Readonly<{
    identity: ManagerHostIdentity | null;
    shutdown: (reason: string) => void;
    jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  }>
): boolean {
  if (requestUrl.pathname !== HOST_SHUTDOWN_PATH) return false;
  if (!options.identity) {
    options.jsonResponse(response, 404, { code: -1, message: "Manager is not owned by RabiRoute Host." });
    return true;
  }
  if (request.method !== "POST") {
    options.jsonResponse(response, 405, { code: -1, message: "method not allowed" });
    return true;
  }
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    options.jsonResponse(response, 403, { code: -1, message: "Host lifecycle control is loopback-only." });
    return true;
  }
  if (!tokenMatches(request.headers["x-rabiroute-host-token"], options.identity.controlToken)) {
    options.jsonResponse(response, 403, { code: -1, message: "Host lifecycle token is invalid." });
    return true;
  }
  options.jsonResponse(response, 202, { code: 0, message: "Manager shutdown accepted." });
  setImmediate(() => options.shutdown("host"));
  return true;
}

export function managerReadyLine(descriptor: ManagerReadyDescriptor): string {
  return `${MANAGER_READY_PREFIX}${JSON.stringify(descriptor)}`;
}
