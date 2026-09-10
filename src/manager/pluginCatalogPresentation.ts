import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";

export type PluginCatalogInput = Pick<PluginGeneration, "id" | "sequence" | "records" | "contributions">;

function contributionPayload(generation: PluginCatalogInput, host?: "web" | "desktop") {
  const pluginIds = new Map(generation.records.map(record => [record.identity.instanceId, record.identity.pluginId]));
  return generation.contributions.contributions.flatMap(contribution => {
    const value = contribution.value && typeof contribution.value === "object" && !Array.isArray(contribution.value)
      ? contribution.value as Record<string, unknown> : {};
    const hosts = Array.isArray(value.hosts) ? value.hosts.filter(item => typeof item === "string") as string[] : [];
    if (host && !hosts.includes(host)) return [];
    return [{ instanceId: contribution.instanceId, pluginId: pluginIds.get(contribution.instanceId) ?? "", kind: contribution.kind, id: contribution.id, ...value }];
  });
}

export function renderPluginCatalog(generation: PluginCatalogInput, host?: "web" | "desktop") {
  return {
    schemaVersion: 2, generation: generation.id, host: host || "all",
    revision: { plugins: generation.sequence, contributions: generation.contributions.revision },
    plugins: generation.records.map(record => ({
      instanceId: record.identity.instanceId, pluginId: record.identity.pluginId,
      manifest: {
        id: record.manifest.id, version: record.manifest.version, kind: "package",
        hosts: Object.keys(record.manifest.entries), capabilities: record.manifest.provides
      },
      host: record.identity.host, scope: "global", status: record.status, missingCapabilities: record.missingCapabilities,
      ...(record.error ? { error: record.error } : {})
    })),
    contributions: contributionPayload(generation, host)
  };
}
