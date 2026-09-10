export type RouteScopedPage = "overview" | "adapters" | "persona" | "knowledge" | "speech" | "runtime";

const unscopedPagePaths: Record<RouteScopedPage, string> = {
  overview: "/overview",
  adapters: "/routes",
  persona: "/persona",
  knowledge: "/knowledge",
  speech: "/speech",
  runtime: "/runtime"
};

export function routeScopedPagePath(routeKey: string, page: RouteScopedPage): string {
  const normalized = routeKey.trim();
  return normalized ? `/routes/${encodeURIComponent(normalized)}/${page}` : unscopedPagePaths[page];
}

export function routeScopedOverviewPath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "overview");
}

export function routeScopedKnowledgePath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "knowledge");
}

export function routeScopedAdaptersPath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "adapters");
}

export function routeScopedPersonaPath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "persona");
}

export function routeScopedPersonaDocumentPath(routeKey: string): string {
  const normalized = routeKey.trim();
  return normalized ? `${routeScopedPersonaPath(normalized)}/document` : "/persona";
}

export function routeScopedPersonaSyncPath(routeKey: string): string {
  const normalized = routeKey.trim();
  return normalized ? `${routeScopedPersonaPath(normalized)}/sync` : "/persona";
}

export function routeScopedSpeechPath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "speech");
}

export function routeScopedRuntimePath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "runtime");
}

export function routeScopedPageFromPath(path: string): RouteScopedPage | "" {
  if (path === "/overview" || /^\/routes\/[^/]+\/overview$/.test(path)) return "overview";
  if (path === "/routes" || /^\/routes\/[^/]+(?:\/adapters)?$/.test(path)) return "adapters";
  if (path === "/persona" || /^\/persona\/[^/]+$/.test(path) || /^\/routes\/[^/]+\/persona(?:\/(?:document|sync))?$/.test(path)) return "persona";
  if (path === "/knowledge" || /^\/routes\/[^/]+\/knowledge$/.test(path)) return "knowledge";
  if (path === "/speech" || /^\/routes\/[^/]+\/speech$/.test(path)) return "speech";
  if (path === "/runtime" || /^\/routes\/[^/]+\/runtime$/.test(path)) return "runtime";
  return "";
}

export function showsRouteSwitcher(path: string): boolean {
  const page = routeScopedPageFromPath(path);
  return page === "adapters" || page === "persona" || page === "knowledge";
}

export function routeScopedPathForCurrentPage(routeKey: string, currentPath: string): string {
  if (/^\/routes\/[^/]+\/persona\/document$/.test(currentPath)) {
    return routeScopedPersonaDocumentPath(routeKey);
  }
  if (/^\/routes\/[^/]+\/persona\/sync$/.test(currentPath)) {
    return routeScopedPersonaSyncPath(routeKey);
  }
  const page = routeScopedPageFromPath(currentPath);
  return page ? routeScopedPagePath(routeKey, page) : "";
}

export function routeKeyFromWebguiHash(hash: string): string {
  // During lazy plugin registration the requested URL is retained in recovery.from.
  // Read that target instead of treating recovery as an unscoped first-Route visit.
  for (let depth = 0; depth < 4; depth += 1) {
    const target = hash.startsWith("#") ? hash.slice(1) : hash;
    const queryIndex = target.indexOf("?");
    if (target.slice(0, queryIndex) !== "/plugin-recovery" || queryIndex < 0) break;
    const from = new URLSearchParams(target.slice(queryIndex + 1)).get("from") || "";
    if (!from.startsWith("/") || from.startsWith("//")) return "";
    hash = `#${from}`;
  }
  const match = hash.match(/^#\/routes\/([^/?#]+)(?:\/(?:overview|adapters|persona(?:\/(?:document|sync))?|knowledge|speech|runtime))?(?:[/?#]|$)/)
    || hash.match(/^#\/persona\/([^/?#]+)(?:[/?#]|$)/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function routeScopedPageUrl(baseUrl: string, routeKey: string, page: RouteScopedPage): string {
  const normalized = routeKey.trim();
  if (!baseUrl || !normalized) return baseUrl;
  const url = new URL(baseUrl);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const queryIndex = hash.indexOf("?");
  const hashQuery = queryIndex >= 0 ? hash.slice(queryIndex + 1) : "";
  url.hash = `#${routeScopedPagePath(normalized, page)}${hashQuery ? `?${hashQuery}` : ""}`;
  return url.toString();
}

export function routeScopedOverviewUrl(baseUrl: string, routeKey: string): string {
  return routeScopedPageUrl(baseUrl, routeKey, "overview");
}

export function routeScopedKnowledgeUrl(baseUrl: string, routeKey: string): string {
  return routeScopedPageUrl(baseUrl, routeKey, "knowledge");
}
