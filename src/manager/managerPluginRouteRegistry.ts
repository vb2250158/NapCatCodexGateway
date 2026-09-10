import type { IncomingMessage, ServerResponse } from "node:http";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";

export type ManagerPluginRouteHandler = (
  request: IncomingMessage,
  url: URL,
  response: ServerResponse
) => boolean;

export type ManagerPluginRouteMatch =
  | { kind: "exact"; path: string; methods?: readonly string[] }
  | { kind: "prefix"; pathPrefix: string; methods?: readonly string[] }
  | {
      kind: "dynamic";
      description: string;
      methods?: readonly string[];
      test(request: IncomingMessage, url: URL): boolean;
    };

export type ManagerPluginRouteDeclaration = {
  routeId: string;
  match: ManagerPluginRouteMatch;
  handler: ManagerPluginRouteHandler;
};

export type ManagerPluginRouteSnapshotEntry = {
  instanceId: string;
  routeCount: number;
  routes: Array<{
    routeId: string;
    match: {
      kind: ManagerPluginRouteMatch["kind"];
      methods: string[];
      path?: string;
      pathPrefix?: string;
      description?: string;
    };
  }>;
};

type NormalizedManagerPluginRoute = {
  instanceId: string;
  routeId: string;
  methods: string[];
  match: ManagerPluginRouteMatch;
  handler: ManagerPluginRouteHandler;
};

type ManagerPluginRouteBatch = {
  instanceId: string;
  activationId?: string;
  routes: readonly NormalizedManagerPluginRoute[];
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeMethods(methods: readonly string[] | undefined): string[] {
  const normalized = (methods?.length ? methods : ["*"])
    .map(method => required(method, "Manager plugin route method").toUpperCase());
  return [...new Set(normalized)];
}

function normalizeMatch(match: ManagerPluginRouteMatch, routeId: string): ManagerPluginRouteMatch {
  const methods = normalizeMethods(match.methods);
  if (match.kind === "exact") {
    return {
      kind: "exact",
      path: required(match.path, `Manager plugin route path ${routeId}`),
      methods
    };
  }
  if (match.kind === "prefix") {
    return {
      kind: "prefix",
      pathPrefix: required(match.pathPrefix, `Manager plugin route pathPrefix ${routeId}`),
      methods
    };
  }
  return {
    kind: "dynamic",
    description: required(match.description, `Manager plugin dynamic route description ${routeId}`),
    methods,
    test: match.test
  };
}

function methodMatches(methods: readonly string[], method: string | undefined): boolean {
  return methods.includes("*") || methods.includes((method ?? "GET").toUpperCase());
}

function methodsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.includes("*") || right.includes("*") || left.some(method => right.includes(method));
}

function staticPathsOverlap(
  left: NormalizedManagerPluginRoute,
  right: NormalizedManagerPluginRoute
): boolean {
  if (left.match.kind === "dynamic" || right.match.kind === "dynamic") return false;
  if (left.match.kind === "exact" && right.match.kind === "exact") {
    return left.match.path === right.match.path;
  }
  if (left.match.kind === "exact" && right.match.kind === "prefix") {
    return left.match.path.startsWith(right.match.pathPrefix);
  }
  if (left.match.kind === "prefix" && right.match.kind === "exact") {
    return right.match.path.startsWith(left.match.pathPrefix);
  }
  if (left.match.kind === "prefix" && right.match.kind === "prefix") {
    return left.match.pathPrefix.startsWith(right.match.pathPrefix)
      || right.match.pathPrefix.startsWith(left.match.pathPrefix);
  }
  return false;
}

function routeDescription(route: NormalizedManagerPluginRoute): string {
  if (route.match.kind === "exact") return route.match.path;
  if (route.match.kind === "prefix") return `${route.match.pathPrefix}*`;
  return route.match.description;
}

function routeMatches(
  route: NormalizedManagerPluginRoute,
  request: IncomingMessage,
  url: URL
): boolean {
  if (!methodMatches(route.methods, request.method)) return false;
  if (route.match.kind === "exact") return url.pathname === route.match.path;
  if (route.match.kind === "prefix") return url.pathname.startsWith(route.match.pathPrefix);
  return route.match.test(request, url);
}

export class ManagerPluginRouteRegistry {
  private readonly batches: ManagerPluginRouteBatch[] = [];

  constructor(private readonly publishedActivations?: () => ReadonlySet<string>) {}

  register(instanceId: string, declarations: readonly ManagerPluginRouteDeclaration[]): () => void {
    const activationId = currentPluginActivation()?.activationId;
    if (this.publishedActivations && !activationId) throw new Error("Managed plugin routes require a plugin activation context.");
    const normalizedInstanceId = required(instanceId, "Manager plugin route instanceId");
    const existingRoutes = this.batches.flatMap(batch => batch.routes);
    const routes = declarations.map(declaration => {
      const routeId = required(declaration.routeId, "Manager plugin routeId");
      const match = normalizeMatch(declaration.match, routeId);
      return {
        instanceId: normalizedInstanceId,
        routeId,
        methods: normalizeMethods(match.methods),
        match,
        handler: declaration.handler
      };
    });
    const routeIds = new Map(existingRoutes.map(route => [route.routeId, route.instanceId]));
    for (const route of routes) {
      const routeOwner = routeIds.get(route.routeId);
      if (routeOwner && routeOwner !== normalizedInstanceId) {
        throw new Error(`Manager plugin routeId already registered: ${route.routeId}`);
      }
      routeIds.set(route.routeId, normalizedInstanceId);
    }
    const combined = [...existingRoutes, ...routes];
    for (let leftIndex = 0; leftIndex < combined.length; leftIndex += 1) {
      const left = combined[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < combined.length; rightIndex += 1) {
        const right = combined[rightIndex]!;
        if (left.instanceId === right.instanceId) continue;
        if (!methodsOverlap(left.methods, right.methods) || !staticPathsOverlap(left, right)) continue;
        throw new Error(
          `Manager plugin routes overlap: ${left.routeId} (${left.methods.join("|")} ${routeDescription(left)}) and ${right.routeId} (${right.methods.join("|")} ${routeDescription(right)})`
        );
      }
    }
    const batch = { instanceId: normalizedInstanceId, activationId, routes };
    this.batches.push(batch);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.batches.indexOf(batch);
      if (index >= 0) this.batches.splice(index, 1);
    };
  }

  private activeBatches(): readonly ManagerPluginRouteBatch[] {
    const published = this.publishedActivations?.();
    const latestByInstance = new Map<string, ManagerPluginRouteBatch>();
    const instanceOrder: string[] = [];
    for (const batch of this.batches) {
      if (published && (!batch.activationId || !published.has(batch.activationId))) continue;
      if (!latestByInstance.has(batch.instanceId)) instanceOrder.push(batch.instanceId);
      latestByInstance.set(batch.instanceId, batch);
    }
    return instanceOrder.map(instanceId => latestByInstance.get(instanceId)!);
  }

  handle(request: IncomingMessage, url: URL, response: ServerResponse): boolean {
    for (const batch of this.activeBatches()) {
      for (const route of batch.routes) {
        if (!routeMatches(route, request, url)) continue;
        if (route.handler(request, url, response)) return true;
      }
    }
    return false;
  }

  snapshot(): ManagerPluginRouteSnapshotEntry[] {
    const entries = new Map<string, ManagerPluginRouteSnapshotEntry>();
    for (const batch of this.activeBatches()) {
      const current = entries.get(batch.instanceId) ?? {
        instanceId: batch.instanceId,
        routeCount: 0,
        routes: []
      };
      for (const route of batch.routes) {
        current.routeCount += 1;
        current.routes.push({
          routeId: route.routeId,
          match: {
            kind: route.match.kind,
            methods: [...route.methods],
            ...(route.match.kind === "exact" ? { path: route.match.path } : {}),
            ...(route.match.kind === "prefix" ? { pathPrefix: route.match.pathPrefix } : {}),
            ...(route.match.kind === "dynamic" ? { description: route.match.description } : {})
          }
        });
      }
      entries.set(batch.instanceId, current);
    }
    return [...entries.values()].map(entry => ({
      instanceId: entry.instanceId,
      routeCount: entry.routeCount,
      routes: entry.routes.map(route => ({
        routeId: route.routeId,
        match: { ...route.match, methods: [...route.match.methods] }
      }))
    }));
  }
}
