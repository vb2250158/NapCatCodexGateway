import { h, type Component } from "vue";
import { webReleaseQuery } from "./webRelease";
import {
  beginTrustedWebPageReplacement,
  notifyTrustedWebPageReplacement,
  registerTrustedWebPage,
  type TrustedWebPageRegistration
} from "./pluginPages";
import {
  registerTrustedWebThemeResource,
  type TrustedWebThemeResourceRegistration
} from "./pluginThemes";
import {
  registerTrustedWebSettingsRenderer,
  registerTrustedWebStatusRenderer,
  type TrustedWebSettingsRendererRegistration,
  type TrustedWebStatusRendererRegistration
} from "./pluginRenderers";

type WebPluginModuleInstanceDescriptor = Readonly<{
  instanceId: string;
}>;

type WebPluginModuleDescriptor = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  instances: readonly WebPluginModuleInstanceDescriptor[];
}>;

type WebPluginInstanceRegistrationApi = Readonly<{
  instanceId: string;
  pluginId: string;
  version: string;
  h: typeof h;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

type WebPluginModuleRegistrationApi = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  instanceIds: readonly string[];
  h: typeof h;
  forInstance(instanceId: string): WebPluginInstanceRegistrationApi;
}>;

type WebPluginModule = Readonly<{
  activate?: (api: WebPluginModuleRegistrationApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;

type ActiveModule = Readonly<{ descriptor: WebPluginModuleDescriptor; dispose: () => void | Promise<void> }>;

const active = new Map<string, ActiveModule>();
let syncQueue: Promise<void> = Promise.resolve();

function validInstance(value: unknown): value is WebPluginModuleInstanceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const instanceId = (value as Record<string, unknown>).instanceId;
  return typeof instanceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(instanceId);
}

function validDescriptor(value: unknown): value is WebPluginModuleDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!(["id", "pluginId", "version", "rev", "entryPath"].every(key => typeof record[key] === "string")
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(record.id as string)
    && /^[a-f0-9]{64}$/.test(record.rev as string)
    && /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(record.entryPath as string)
    && Array.isArray(record.instances)
    && record.instances.length > 0
    && record.instances.every(validInstance))) return false;
  return new Set(record.instances.map(item => (item as WebPluginModuleInstanceDescriptor).instanceId)).size === record.instances.length;
}

/** Instance membership changes require a full Bundle disposer/activation even when its revision is unchanged. */
export function sameWebPluginModuleInstances(
  left: readonly WebPluginModuleInstanceDescriptor[],
  right: readonly WebPluginModuleInstanceDescriptor[]
): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left.map(instance => instance.instanceId));
  return leftIds.size === right.length && right.every(instance => leftIds.has(instance.instanceId));
}

async function list(): Promise<readonly WebPluginModuleDescriptor[]> {
  const response = await fetch(`/api/plugins/modules${webReleaseQuery()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load Web plugin modules: ${response.status}.`);
  const body = await response.json() as { code?: unknown; data?: { modules?: unknown } };
  if (body.code !== 0 || !Array.isArray(body.data?.modules) || !body.data.modules.every(validDescriptor)) {
    throw new Error("Web plugin module catalog is invalid.");
  }
  const modules = body.data.modules;
  if (new Set(modules.map(item => item.id)).size !== modules.length) throw new Error("Web plugin module catalog has duplicate ids.");
  return Object.freeze([...modules].sort((left, right) => left.id.localeCompare(right.id)));
}

function instanceRegistrationApi(
  descriptor: WebPluginModuleDescriptor,
  instanceId: string
): WebPluginInstanceRegistrationApi {
  const owner = { instanceId, pluginId: descriptor.pluginId };
  return Object.freeze({
    ...owner,
    version: descriptor.version,
    h,
    registerPage: input => registerTrustedWebPage({ ...input, ...owner }),
    registerSettingsRenderer: input => registerTrustedWebSettingsRenderer({ ...input, ...owner }),
    registerStatusRenderer: input => registerTrustedWebStatusRenderer({ ...input, ...owner }),
    registerTheme: input => registerTrustedWebThemeResource({ ...input, ...owner }),
    asComponent: value => value
  });
}

function registrationApi(descriptor: WebPluginModuleDescriptor): WebPluginModuleRegistrationApi {
  const instances = new Map(descriptor.instances.map(instance => [
    instance.instanceId,
    instanceRegistrationApi(descriptor, instance.instanceId)
  ]));
  const instanceIds = Object.freeze([...instances.keys()]);
  return Object.freeze({
    id: descriptor.id,
    pluginId: descriptor.pluginId,
    version: descriptor.version,
    instanceIds,
    h,
    forInstance(instanceId: string): WebPluginInstanceRegistrationApi {
      const api = instances.get(instanceId);
      if (!api) throw new Error(`Web Bundle does not own Manager instance: ${instanceId}.`);
      return api;
    }
  });
}

async function importModule(descriptor: WebPluginModuleDescriptor): Promise<WebPluginModule> {
  const url = `/api/plugins/modules/${encodeURIComponent(descriptor.id)}/${descriptor.rev}/${descriptor.entryPath.split("/").map(encodeURIComponent).join("/")}`;
  return await import(/* @vite-ignore */ url) as WebPluginModule;
}

async function activate(descriptor: WebPluginModuleDescriptor): Promise<ActiveModule> {
  const module = await importModule(descriptor);
  if (typeof module.activate !== "function") throw new Error(`Web plugin module does not export activate(): ${descriptor.id}.`);
  const cleanup = await module.activate(registrationApi(descriptor));
  return Object.freeze({ descriptor, dispose: typeof cleanup === "function" ? cleanup : () => {} });
}

async function dispose(module: ActiveModule): Promise<void> {
  await module.dispose();
}

async function syncNow(): Promise<void> {
  const desired = await list();
  const desiredById = new Map(desired.map(item => [item.id, item]));
  for (const [id, loaded] of [...active]) {
    const target = desiredById.get(id);
    if (target
      && target.rev === loaded.descriptor.rev
      && sameWebPluginModuleInstances(target.instances, loaded.descriptor.instances)) continue;
    const endReplacement = beginTrustedWebPageReplacement();
    try {
      await dispose(loaded);
      active.delete(id);
      if (!target) continue;
      try {
        active.set(id, await activate(target));
      } catch (error) {
        try {
          active.set(id, await activate(loaded.descriptor));
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Web plugin module update and rollback failed: ${id}.`);
        }
        throw error;
      }
    } finally {
      endReplacement();
    }
    notifyTrustedWebPageReplacement();
  }
  for (const descriptor of desired) {
    if (active.has(descriptor.id)) continue;
    active.set(descriptor.id, await activate(descriptor));
  }
}

export function refreshWebPluginModules(): Promise<void> {
  const next = syncQueue.then(syncNow);
  syncQueue = next.catch(() => {});
  return next;
}

export async function disposeWebPluginModules(): Promise<void> {
  await syncQueue;
  for (const module of [...active.values()].reverse()) await dispose(module);
  active.clear();
}
