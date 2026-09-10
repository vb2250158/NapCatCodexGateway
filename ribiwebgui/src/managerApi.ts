import { useI18n } from "./i18n";
import { errorResponsePresentation } from "../../src/shared/errorPresentation";
import { appendWebguiTokenQuery, captureWebguiTokenFromHref } from "./webguiAccessToken";

declare global {
  interface Window {
    __RABI_MANAGER_API_BASE__?: string;
    __RABI_MANAGER_FETCH_INSTALLED__?: boolean;
  }
}

const WEBGUI_TOKEN_SESSION_KEY = "rabiroute:webgui:access-token";

const managerPathPrefixes = [
  "/api/",
  "/manager-config",
  "/meta",
  "/gateways",
  "/network-options",
  "/open-config-file",
  "/manager",
  "/manager/"
];

function normalizedManagerApiBase(): string {
  return String(window.__RABI_MANAGER_API_BASE__ || "").replace(/\/+$/, "");
}

function shouldPrefixManagerPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  if (pathname.startsWith("/plugin/")) return false;
  return managerPathPrefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function prefixedManagerUrl(value: string): string {
  const base = normalizedManagerApiBase();
  if (!base || !value.startsWith("/")) return value;
  if (!shouldPrefixManagerPath(value)) return value;
  return `${base}${value}`;
}

export function managerAccessToken(): string {
  try {
    return window.sessionStorage.getItem(WEBGUI_TOKEN_SESSION_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function captureManagerAccessToken(): void {
  const capture = captureWebguiTokenFromHref(window.location.href);
  if (capture.token) {
    try {
      window.sessionStorage.setItem(WEBGUI_TOKEN_SESSION_KEY, capture.token);
    } catch {
      // The current page can still use loopback access when browser storage is unavailable.
    }
  }
  if (capture.sanitizedHref !== window.location.href) {
    window.history.replaceState(window.history.state, "", capture.sanitizedHref);
  }
}

function authenticatedInit(init?: RequestInit): RequestInit | undefined {
  const token = managerAccessToken();
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("x-rabiroute-webgui-token", token);
  return { ...init, headers };
}

function authenticatedRequest(request: Request, init?: RequestInit): Request {
  const headers = new Headers(request.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const token = managerAccessToken();
  if (token) headers.set("x-rabiroute-webgui-token", token);
  return new Request(request, { ...init, headers });
}

function isSameOriginManagerUrl(value: string | URL): boolean {
  const url = new URL(value.toString(), window.location.href);
  return url.origin === window.location.origin && shouldPrefixManagerPath(url.pathname);
}

export function managerEventSource(pathname: string): EventSource {
  const prefixed = prefixedManagerUrl(pathname);
  const url = appendWebguiTokenQuery(prefixed, managerAccessToken(), window.location.href);
  return new EventSource(url);
}

export function managerResourceUrl(pathname: string): string {
  if (!pathname) return pathname;
  const prefixed = prefixedManagerUrl(pathname);
  return appendWebguiTokenQuery(prefixed, managerAccessToken(), window.location.href);
}

export function installManagerFetchPrefix(): void {
  if (window.__RABI_MANAGER_FETCH_INSTALLED__) return;
  window.__RABI_MANAGER_FETCH_INSTALLED__ = true;
  captureManagerAccessToken();
  const rawFetch = window.fetch.bind(window);
  const originalFetch: typeof fetch = async (input, init) => {
    const response = await rawFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (url.origin !== window.location.origin || !shouldPrefixManagerPath(url.pathname)) return response;
    const readJson = response.json.bind(response);
    response.json = async () => {
      const payload = errorResponsePresentation(await readJson(), response.status) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || !payload.errorMessages) return payload;
      const messages = payload.errorMessages as Record<string, string>;
      const message = messages[useI18n().locale.value];
      const nested = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : undefined;
      return { ...payload, message, ...(nested ? { error: { ...nested, message } } : {}) };
    };
    return response;
  };
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string") {
      const managerRequest = isSameOriginManagerUrl(input);
      return originalFetch(prefixedManagerUrl(input), managerRequest ? authenticatedInit(init) : init);
    }
    if (input instanceof URL && input.origin === window.location.origin) {
      const next = new URL(input.toString());
      const managerRequest = shouldPrefixManagerPath(next.pathname);
      next.pathname = prefixedManagerUrl(next.pathname);
      return originalFetch(next, managerRequest ? authenticatedInit(init) : init);
    }
    if (input instanceof Request) {
      const requestUrl = new URL(input.url);
      if (requestUrl.origin === window.location.origin) {
        const next = new URL(input.url);
        const managerRequest = shouldPrefixManagerPath(next.pathname);
        next.pathname = prefixedManagerUrl(next.pathname);
        const nextRequest = new Request(next, input);
        return managerRequest
          ? originalFetch(authenticatedRequest(nextRequest, init))
          : originalFetch(nextRequest, init);
      }
    }
    return originalFetch(input, init);
  };
}

export {};
