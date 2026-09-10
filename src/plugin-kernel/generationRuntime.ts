import { randomUUID } from "node:crypto";
import { runPluginActivation } from "./pluginActivationContext.js";
import { planCapabilityGraph, type CapabilityGraphPlan } from "./capabilityGraph.js";
import { ContributionRegistryDraft, type ContributionRegistrySnapshot, type RegisteredPluginContribution } from "./contributionRegistry.js";
import { EffectScope } from "./effectScope.js";
import { GrantedPermissions } from "./permissionGate.js";
import { createBuiltinPluginExecutor, type PluginExecutor } from "./pluginExecutor.js";
import { ServiceRegistryDraft, type ServiceRegistrySnapshot } from "./serviceRegistry.js";
import type {
  HostService,
  PluginCandidate,
  PluginContext,
  PluginContribution,
  PluginEffectDisposer,
  PluginEffectStarter,
  PluginHost,
  PluginIdentity,
  PluginManifest,
  PluginRuntimeRecord,
  PluginServiceRegistration
} from "./types.js";

export type PluginGeneration = Readonly<{
  id: string;
  sequence: number;
  createdAt: string;
  host: PluginHost;
  applicationGenerationId: string;
  managerInstanceId: string;
  readyRequires: readonly string[];
  readiness: Readonly<{
    state: "ready" | "degraded";
    missingCapabilities: readonly string[];
  }>;
  records: readonly PluginRuntimeRecord[];
  services: ServiceRegistrySnapshot;
  contributions: ContributionRegistrySnapshot;
  cleanupDiagnostics: readonly PluginCleanupDiagnostic[];
}>;

export type PluginCleanupDiagnostic = Readonly<{
  instanceId: string;
  activationId: string;
  phase: "rollback" | "superseded" | "runtime_failure" | "shutdown";
  message: string;
}>;

export type GenerationSwitchResult = Readonly<{
  changed: boolean;
  generation: PluginGeneration;
  previousGenerationId?: string;
}>;

export type PluginRuntimeFailureEvent = Readonly<{
  identity: PluginIdentity;
  error: Readonly<{ code: "runtime_failed"; message: string }>;
  generation: PluginGeneration;
}>;

export type GenerationRuntimeOptions = Readonly<{
  host: PluginHost;
  hostServices?: readonly HostService[];
  grantedPermissions?: (identity: PluginIdentity) => readonly string[];
  applicationIdentity?: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>;
  readyRequires?: readonly string[];
  executor?: PluginExecutor;
  activationTimeoutMs?: number;
  onRuntimeFailure?: (event: PluginRuntimeFailureEvent) => void | Promise<void>;
}>;

export type GenerationSwitchOptions = Readonly<{ readyRequires?: readonly string[] }>;

export class RequiredPluginCapabilitiesUnavailableError extends Error {
  readonly code = "required_plugin_capabilities_unavailable";

  constructor(
    readonly missingCapabilities: readonly string[],
    readonly diagnostics: readonly PluginRuntimeRecord[] = []
  ) {
    const failures = diagnostics
      .filter(record => record.status !== "active" || record.error)
      .slice(0, 8)
      .map(record => `${record.identity.instanceId}: ${record.error?.message ?? record.status}`);
    super(`Required plugin capabilities are unavailable: ${missingCapabilities.join(", ")}${
      failures.length ? `. Plugin diagnostics: ${failures.join("; ")}` : ""
    }`);
    this.name = "RequiredPluginCapabilitiesUnavailableError";
  }
}

export function selectReadyPluginCandidates(
  candidates: readonly PluginCandidate[],
  readyRequires: readonly string[],
  hostCapabilities: readonly string[] = []
): readonly PluginCandidate[] {
  const hostCapabilitySet = new Set(hostCapabilities.map(capability => capability.trim()).filter(Boolean));
  const plan = planCapabilityGraph(candidates, hostCapabilitySet);
  const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
  const selected = new Set<string>();
  const pending = readyRequires.map(capability => capability.trim()).filter(Boolean);
  while (pending.length) {
    const capability = pending.pop()!;
    if (hostCapabilitySet.has(capability)) continue;
    const providerId = plan.providers.get(capability);
    if (!providerId || selected.has(providerId)) continue;
    selected.add(providerId);
    const provider = byId.get(providerId);
    if (provider) pending.push(...provider.manifest.requires);
  }
  return Object.freeze(candidates.filter(candidate => selected.has(candidate.instanceId.trim())));
}

type ActivePluginState = Readonly<{
  identity: PluginIdentity;
  manifest: PluginManifest;
  signature: string;
  scope: EffectScope;
  services: readonly PluginServiceRegistration[];
  contributions: readonly RegisteredPluginContribution[];
}>;

type ComponentFailure = Readonly<{ instanceId: string; error: unknown }>;

function errorSummary(error: unknown, code = "activation_failed") {
  return Object.freeze({ code, message: error instanceof Error ? error.message : String(error) });
}

function failedRecord(identity: PluginIdentity, manifest: PluginManifest, error: unknown, code = "activation_failed"): PluginRuntimeRecord {
  return Object.freeze({
    identity,
    manifest,
    status: "failed",
    missingCapabilities: Object.freeze([]),
    error: errorSummary(error, code)
  });
}

function waitingRecord(identity: PluginIdentity, manifest: PluginManifest, missing: readonly string[]): PluginRuntimeRecord {
  return Object.freeze({
    identity,
    manifest,
    status: "waiting_dependency",
    missingCapabilities: Object.freeze([...missing])
  });
}

function activeRecord(state: ActivePluginState, updateError?: unknown): PluginRuntimeRecord {
  return Object.freeze({
    identity: state.identity,
    manifest: state.manifest,
    status: "active",
    missingCapabilities: Object.freeze([]),
    ...(updateError ? { error: errorSummary(updateError, "update_failed_using_previous_revision") } : {})
  });
}

function pluginIdentity(
  candidate: PluginCandidate,
  host: PluginHost,
  applicationGenerationId: string,
  managerInstanceId: string
): PluginIdentity {
  if (!candidate.manifest.entries[host]) throw new Error(`Plugin does not provide a ${host} entry: ${candidate.manifest.id}.`);
  const instanceId = candidate.instanceId.trim();
  const revision = candidate.revision.trim();
  if (!instanceId || !revision) throw new Error("Plugin instanceId and revision are required.");
  return Object.freeze({
    applicationGenerationId,
    managerInstanceId,
    activationId: randomUUID(),
    instanceId,
    pluginId: candidate.manifest.id,
    version: candidate.manifest.version,
    revision,
    host
  });
}

function candidateSignature(candidate: PluginCandidate, granted: readonly string[]): string {
  return JSON.stringify({
    revision: candidate.revision,
    manifest: candidate.manifest,
    config: candidate.config,
    entry: candidate.entry,
    policy: candidate.policy,
    granted: [...granted].sort()
  });
}

function dependencyComponents(
  candidates: readonly PluginCandidate[],
  plan: CapabilityGraphPlan
): readonly (readonly string[])[] {
  const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
  const adjacency = new Map<string, Set<string>>([...byId.keys()].map(instanceId => [instanceId, new Set<string>()]));
  for (const candidate of byId.values()) {
    for (const capability of [...candidate.manifest.requires, ...candidate.manifest.optional]) {
      const provider = plan.providers.get(capability);
      if (!provider || provider === candidate.instanceId) continue;
      adjacency.get(candidate.instanceId)!.add(provider);
      adjacency.get(provider)!.add(candidate.instanceId);
    }
  }
  const activationPosition = new Map(plan.activationOrder.map((instanceId, index) => [instanceId, index]));
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const instanceId of [...byId.keys()].sort()) {
    if (seen.has(instanceId)) continue;
    const pending = [instanceId];
    const component: string[] = [];
    seen.add(instanceId);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const adjacent of adjacency.get(current) ?? []) {
        if (seen.has(adjacent)) continue;
        seen.add(adjacent);
        pending.push(adjacent);
      }
    }
    component.sort((left, right) =>
      (activationPosition.get(left) ?? Number.MAX_SAFE_INTEGER) - (activationPosition.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    );
    components.push(component);
  }
  return Object.freeze(components.sort((left, right) => {
    const leftPosition = Math.min(...left.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    const rightPosition = Math.min(...right.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    return leftPosition - rightPosition || left[0]!.localeCompare(right[0]!);
  }).map(component => Object.freeze(component)));
}

function contributionKey(contribution: Pick<PluginContribution, "kind" | "id">): string {
  return `${contribution.kind.trim()}\0${contribution.id.trim()}`;
}

async function cleanupStates(
  states: readonly ActivePluginState[],
  phase: PluginCleanupDiagnostic["phase"]
): Promise<readonly PluginCleanupDiagnostic[]> {
  const unique = [...new Map(states.map(state => [state.scope, state])).values()].reverse();
  const settled = await Promise.allSettled(unique.map(state => state.scope.dispose()));
  return Object.freeze(settled.flatMap((result, index) => result.status === "rejected"
    ? [Object.freeze({
        instanceId: unique[index]!.identity.instanceId,
        activationId: unique[index]!.identity.activationId,
        phase,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason)
      })]
    : []));
}

function buildGenerationSnapshots(
  states: Iterable<ActivePluginState>,
  hostServices: readonly HostService[],
  sequence: number
): Readonly<{ services: ServiceRegistrySnapshot; contributions: ContributionRegistrySnapshot }> {
  const services = new ServiceRegistryDraft(hostServices);
  const contributions = new ContributionRegistryDraft();
  for (const state of states) {
    for (const service of state.services) services.register(state.identity.instanceId, service.capability, service.value);
    for (const contribution of state.contributions) contributions.register(state.identity.instanceId, contribution);
  }
  return Object.freeze({ services: services.snapshot(sequence), contributions: contributions.snapshot(sequence) });
}

export class GenerationRuntime {
  readonly #host: PluginHost;
  readonly #hostServices: readonly HostService[];
  readonly #grantedPermissions: (identity: PluginIdentity) => readonly string[];
  readonly #applicationGenerationId: string;
  readonly #managerInstanceId: string;
  readonly #defaultReadyRequires: readonly string[];
  readonly #executor: PluginExecutor;
  readonly #activationTimeoutMs: number;
  readonly #onRuntimeFailure?: (event: PluginRuntimeFailureEvent) => void | Promise<void>;
  #mutationTail: Promise<void> = Promise.resolve();
  #disposed = false;
  #sequence = 0;
  #current: PluginGeneration;
  #active = new Map<string, ActivePluginState>();

  constructor(options: GenerationRuntimeOptions) {
    this.#host = options.host;
    this.#hostServices = Object.freeze([...(options.hostServices ?? [])]);
    this.#grantedPermissions = options.grantedPermissions ?? (() => []);
    this.#applicationGenerationId = options.applicationIdentity?.applicationGenerationId.trim() || randomUUID();
    this.#managerInstanceId = options.applicationIdentity?.managerInstanceId.trim() || randomUUID();
    this.#defaultReadyRequires = Object.freeze([...(options.readyRequires ?? [])].sort());
    this.#executor = options.executor ?? createBuiltinPluginExecutor();
    this.#activationTimeoutMs = Math.max(1, Math.floor(options.activationTimeoutMs ?? 30_000));
    this.#onRuntimeFailure = options.onRuntimeFailure;
    this.#current = Object.freeze({
      id: randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires: this.#defaultReadyRequires,
      readiness: Object.freeze({
        state: this.#defaultReadyRequires.length ? "degraded" : "ready",
        missingCapabilities: this.#defaultReadyRequires
      }),
      records: Object.freeze([]),
      services: new ServiceRegistryDraft(this.#hostServices).snapshot(0),
      contributions: new ContributionRegistryDraft().snapshot(0),
      cleanupDiagnostics: Object.freeze([])
    });
  }

  current(): PluginGeneration {
    return this.#current;
  }

  publishSourcePatch<T>(expectedGenerationId: string, operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      if (this.#disposed) throw new Error("Plugin GenerationRuntime is disposed.");
      if (this.#current.id !== expectedGenerationId) throw new Error("Source patch plugin generation is no longer active.");
      return operation();
    });
  }

  switch(candidates: readonly PluginCandidate[], options: GenerationSwitchOptions = {}): Promise<GenerationSwitchResult> {
    return this.#enqueue(() => this.#switchNow(candidates, options));
  }

  async #switchNow(candidates: readonly PluginCandidate[], options: GenerationSwitchOptions): Promise<GenerationSwitchResult> {
    if (this.#disposed) throw new Error("Plugin GenerationRuntime is disposed.");
    const readyRequires = Object.freeze([...(options.readyRequires ?? this.#defaultReadyRequires)].sort());
    const hostCapabilities = new Set(this.#hostServices.map(service => service.capability));
    const plan = planCapabilityGraph(candidates, hostCapabilities);
    const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
    const identities = new Map<string, PluginIdentity>();
    const granted = new Map<string, readonly string[]>();
    const signatures = new Map<string, string>();
    for (const [instanceId, candidate] of byId) {
      const identity = pluginIdentity(
        candidate,
        this.#host,
        this.#applicationGenerationId,
        this.#managerInstanceId
      );
      const permissions = Object.freeze([...this.#grantedPermissions(identity)].sort());
      identities.set(instanceId, identity);
      granted.set(instanceId, permissions);
      signatures.set(instanceId, candidateSignature(candidate, permissions));
    }

    const desiredIds = new Set(byId.keys());
    const unchanged = candidates.length === this.#active.size
      && [...byId.keys()].every(instanceId => this.#active.get(instanceId)?.signature === signatures.get(instanceId))
      && this.#current.records.every(record => record.status === "active" && !record.error)
      && JSON.stringify(this.#current.readyRequires) === JSON.stringify(readyRequires);
    if (unchanged) return Object.freeze({ changed: false, generation: this.#current });

    const previous = this.#current;
    const previousActive = this.#active;
    const nextActive = new Map<string, ActivePluginState>();
    const records: PluginRuntimeRecord[] = [];
    const claimedContributionKeys = new Set<string>();
    const scopesToDispose = new Set<EffectScope>();
    const preparedToCommit: ActivePluginState[] = [];
    const componentForInstance = new Map<string, readonly string[]>();

    for (const component of dependencyComponents(candidates, plan)) {
      for (const instanceId of component) componentForInstance.set(instanceId, component);
      const waiting = component.filter(instanceId => plan.waiting.has(instanceId));
      if (waiting.length) {
        for (const instanceId of component) {
          const candidate = byId.get(instanceId)!;
          records.push(waitingRecord(identities.get(instanceId)!, candidate.manifest, plan.waiting.get(instanceId) ?? []));
          const old = previousActive.get(instanceId);
          if (old) scopesToDispose.add(old.scope);
        }
        continue;
      }

      const componentUnchanged = component.every(instanceId =>
        previousActive.get(instanceId)?.signature === signatures.get(instanceId)
      );
      if (componentUnchanged) {
        for (const instanceId of component) {
          const state = previousActive.get(instanceId)!;
          nextActive.set(instanceId, state);
          records.push(activeRecord(state));
          for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
        }
        continue;
      }

      const serviceValues = new Map<string, PluginServiceRegistration>();
      for (const service of this.#hostServices) {
        serviceValues.set(service.capability, Object.freeze({ capability: service.capability, providerInstanceId: "host", value: service.value }));
      }
      const prepared: ActivePluginState[] = [];
      let failure: ComponentFailure | undefined;

      try {
        for (const instanceId of component) {
          const candidate = byId.get(instanceId)!;
          const identity = identities.get(instanceId)!;
          const permissions = new GrantedPermissions(candidate.manifest.permissions, granted.get(instanceId)!);
          const declaredProvides = new Set(candidate.manifest.provides);
          const provided = new Set<string>();
          const pluginServices: PluginServiceRegistration[] = [];
          const pluginContributions: RegisteredPluginContribution[] = [];
          const componentContributionKeys = new Set(prepared.flatMap(state => state.contributions.map(contributionKey)));
          const scope = new EffectScope({
            disposalTimeoutMs: candidate.policy?.resources.shutdownTimeoutMs
          });
          const context: PluginContext = Object.freeze({
            identity,
            config: candidate.config,
            services: Object.freeze({
              require<T>(capability: string): T {
                if (!candidate.manifest.requires.includes(capability) && !candidate.manifest.optional.includes(capability)) {
                  throw new Error(`Plugin did not declare required capability: ${capability}.`);
                }
                const service = serviceValues.get(capability.trim());
                if (!service) throw new Error(`Required plugin service is unavailable: ${capability.trim()}.`);
                return service.value as T;
              },
              optional<T>(capability: string): T | undefined {
                if (!candidate.manifest.optional.includes(capability) && !candidate.manifest.requires.includes(capability)) {
                  throw new Error(`Plugin did not declare optional capability: ${capability}.`);
                }
                return serviceValues.get(capability.trim())?.value as T | undefined;
              },
              provide<T>(capability: string, value: T): void {
                if (!declaredProvides.has(capability)) throw new Error(`Plugin did not declare provided capability: ${capability}.`);
                if (provided.has(capability)) throw new Error(`Plugin provided a capability more than once: ${capability}.`);
                if (serviceValues.has(capability)) throw new Error(`Plugin service capability is already registered: ${capability}.`);
                const registration = Object.freeze({ capability, providerInstanceId: instanceId, value });
                serviceValues.set(capability, registration);
                pluginServices.push(registration);
                provided.add(capability);
              }
            }),
            contributions: Object.freeze({
              register(contribution: PluginContribution): void {
                const kind = contribution.kind.trim();
                const id = contribution.id.trim();
                if (!kind || !id) throw new Error("Plugin contribution kind and id are required.");
                const key = contributionKey({ kind, id });
                if (claimedContributionKeys.has(key) || componentContributionKeys.has(key)) {
                  throw new Error(`Plugin contribution is already registered: ${kind}/${id}.`);
                }
                componentContributionKeys.add(key);
                pluginContributions.push(Object.freeze({ instanceId, kind, id, value: contribution.value }));
              }
            }),
            permissions,
            lifecycle: Object.freeze({
              signal: scope.signal(),
              fail: (error: unknown) => { void this.#enqueue(() => this.#handleRuntimeFailure(identity, error)); }
            }),
            effects: Object.freeze({
              add: (starter: PluginEffectStarter, label?: string) => scope.add(starter, label),
              adopt: (disposer: PluginEffectDisposer, label?: string) => scope.adopt(disposer, label)
            })
          });

          try {
            const module = await this.#executor.prepare(candidate, identity);
            let activationTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.resolve(module.activate(context)),
                new Promise<never>((_, reject) => {
                  activationTimer = setTimeout(() => {
                    reject(new Error(`Plugin activation timed out after ${this.#activationTimeoutMs}ms: ${instanceId}.`));
                  }, this.#activationTimeoutMs);
                })
              ]);
            } finally {
              if (activationTimer) clearTimeout(activationTimer);
            }
            const missingProvides = [...declaredProvides].filter(capability => !provided.has(capability));
            if (missingProvides.length) throw new Error(`Plugin did not provide declared capabilities: ${missingProvides.join(", ")}.`);
            prepared.push(Object.freeze({
              identity,
              manifest: candidate.manifest,
              signature: signatures.get(instanceId)!,
              scope,
              services: Object.freeze(pluginServices),
              contributions: Object.freeze(pluginContributions)
            }));
          } catch (error) {
            await scope.dispose().catch(() => {});
            throw Object.freeze({ instanceId, error }) satisfies ComponentFailure;
          }
        }

      } catch (error) {
        failure = error && typeof error === "object" && "instanceId" in error && "error" in error
          ? error as ComponentFailure
          : Object.freeze({ instanceId: component[0]!, error });
        for (const state of [...prepared].reverse()) await state.scope.dispose().catch(() => {});
      }

      if (!failure) {
        preparedToCommit.push(...prepared);
        for (const state of prepared) {
          nextActive.set(state.identity.instanceId, state);
          records.push(activeRecord(state));
          for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
          const old = previousActive.get(state.identity.instanceId);
          if (old && old.scope !== state.scope) scopesToDispose.add(old.scope);
        }
        continue;
      }

      let preserved = false;
      for (const instanceId of component) {
        const old = previousActive.get(instanceId);
        if (!old) continue;
        preserved = true;
        nextActive.set(instanceId, old);
        records.push(activeRecord(old, failure.error));
        for (const contribution of old.contributions) claimedContributionKeys.add(contributionKey(contribution));
      }
      for (const instanceId of component) {
        if (previousActive.has(instanceId)) continue;
        const candidate = byId.get(instanceId)!;
        const error = instanceId === failure.instanceId
          ? failure.error
          : new Error(`Plugin activation was cancelled because dependency component ${failure.instanceId} failed.`);
        records.push(failedRecord(identities.get(instanceId)!, candidate.manifest, error));
      }
      if (!preserved) {
        for (const state of prepared) scopesToDispose.add(state.scope);
      }
    }

    for (const [instanceId, state] of previousActive) {
      if (!desiredIds.has(instanceId) || !nextActive.has(instanceId)) scopesToDispose.add(state.scope);
    }

    const sequence = this.#sequence + 1;
    try {
      buildGenerationSnapshots(nextActive.values(), this.#hostServices, sequence);
    } catch (error) {
      await cleanupStates(preparedToCommit, "rollback");
      throw error;
    }

    const cleanupDiagnostics: PluginCleanupDiagnostic[] = [];
    for (const state of preparedToCommit) {
      if (nextActive.get(state.identity.instanceId)?.scope !== state.scope) continue;
      try {
        await runPluginActivation(state.identity, () => state.scope.commit());
      } catch (error) {
        const component = componentForInstance.get(state.identity.instanceId) ?? [state.identity.instanceId];
        const componentSet = new Set(component);
        const rollbackStates = preparedToCommit.filter(item => componentSet.has(item.identity.instanceId));
        cleanupDiagnostics.push(...await cleanupStates(rollbackStates, "rollback"));
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (componentSet.has(records[index]!.identity.instanceId)) records.splice(index, 1);
        }
        for (const instanceId of component) {
          nextActive.delete(instanceId);
          const old = previousActive.get(instanceId);
          if (old) {
            nextActive.set(instanceId, old);
            scopesToDispose.delete(old.scope);
            records.push(activeRecord(old, error));
          } else {
            const candidate = byId.get(instanceId)!;
            records.push(failedRecord(
              identities.get(instanceId)!,
              candidate.manifest,
              instanceId === state.identity.instanceId
                ? error
                : new Error(`Plugin effect commit was cancelled because dependency component ${state.identity.instanceId} failed.`)
            ));
          }
        }
      }
    }

    // Rebuild after any component rollback. Validation and effect commits both
    // finish before the single generation pointer below becomes observable.
    const committedSnapshots = buildGenerationSnapshots(nextActive.values(), this.#hostServices, sequence);
    const serviceSnapshot = committedSnapshots.services;
    const contributionSnapshot = committedSnapshots.contributions;
    const missingReadyCapabilities = readyRequires.filter(capability => !serviceSnapshot.services.has(capability));
    if (missingReadyCapabilities.length) {
      await cleanupStates(preparedToCommit, "rollback");
      throw new RequiredPluginCapabilitiesUnavailableError(
        Object.freeze(missingReadyCapabilities),
        Object.freeze([...records])
      );
    }
    const hasDegradedPlugins = records.some(record => record.status !== "active" || Boolean(record.error));
    const generation: PluginGeneration = Object.freeze({
      id: randomUUID(),
      sequence,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires,
      readiness: Object.freeze({
        state: hasDegradedPlugins ? "degraded" : "ready",
        missingCapabilities: Object.freeze(missingReadyCapabilities)
      }),
      records: Object.freeze(records.sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId))),
      services: serviceSnapshot,
      contributions: contributionSnapshot,
      cleanupDiagnostics: Object.freeze([...cleanupDiagnostics])
    });

    this.#sequence = sequence;
    this.#active = nextActive;
    this.#current = generation;
    const retainedScopes = new Set([...nextActive.values()].map(state => state.scope));
    const supersededStates = [...previousActive.values()].filter(state =>
      scopesToDispose.has(state.scope) && !retainedScopes.has(state.scope)
    );
    cleanupDiagnostics.push(...await cleanupStates(supersededStates, "superseded"));
    const published = cleanupDiagnostics.length
      ? Object.freeze({ ...generation, cleanupDiagnostics: Object.freeze([...cleanupDiagnostics]) })
      : generation;
    this.#current = published;
    return Object.freeze({ changed: true, generation: published, previousGenerationId: previous.id });
  }

  dispose(): Promise<void> {
    return this.#enqueue(() => this.#disposeNow());
  }

  async #handleRuntimeFailure(identity: PluginIdentity, error: unknown): Promise<void> {
    if (this.#disposed) return;
    const failedState = this.#active.get(identity.instanceId);
    if (!failedState || failedState.identity.activationId !== identity.activationId) return;

    const removed = new Set<string>([identity.instanceId]);
    let changed = true;
    while (changed) {
      changed = false;
      const removedCapabilities = new Set([...this.#active.values()]
        .filter(state => removed.has(state.identity.instanceId))
        .flatMap(state => [...state.manifest.provides]));
      for (const state of this.#active.values()) {
        if (removed.has(state.identity.instanceId)) continue;
        if (state.manifest.requires.some(capability => removedCapabilities.has(capability))) {
          removed.add(state.identity.instanceId);
          changed = true;
        }
      }
    }

    const previous = this.#current;
    const removedStates = [...this.#active.values()].filter(state => removed.has(state.identity.instanceId));
    const remaining = new Map([...this.#active.entries()].filter(([instanceId]) => !removed.has(instanceId)));
    this.#active = remaining;
    const sequence = this.#sequence + 1;
    const serviceRegistry = new ServiceRegistryDraft(this.#hostServices);
    const contributionRegistry = new ContributionRegistryDraft();
    for (const state of remaining.values()) {
      for (const service of state.services) serviceRegistry.register(state.identity.instanceId, service.capability, service.value);
      for (const contribution of state.contributions) contributionRegistry.register(state.identity.instanceId, contribution);
    }
    const serviceSnapshot = serviceRegistry.snapshot(sequence);
    const available = new Set(serviceSnapshot.services.keys());
    const records = [
      ...[...remaining.values()].map(state => activeRecord(state)),
      ...previous.records.filter(record =>
        !remaining.has(record.identity.instanceId) && !removed.has(record.identity.instanceId)
      ),
      ...removedStates.map(state => state.identity.instanceId === identity.instanceId
        ? failedRecord(state.identity, state.manifest, error, "runtime_failed")
        : waitingRecord(
          state.identity,
          state.manifest,
          state.manifest.requires.filter(capability => !available.has(capability))
        ))
    ].sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId));
    const missingReadyCapabilities = previous.readyRequires.filter(capability => !available.has(capability));
    const hasDegradedPlugins = records.some(record => record.status !== "active" || Boolean(record.error));
    const generation: PluginGeneration = Object.freeze({
      id: randomUUID(),
      sequence,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires: previous.readyRequires,
      readiness: Object.freeze({
        state: missingReadyCapabilities.length || hasDegradedPlugins ? "degraded" : "ready",
        missingCapabilities: Object.freeze(missingReadyCapabilities)
      }),
      records: Object.freeze(records),
      services: serviceSnapshot,
      contributions: contributionRegistry.snapshot(sequence),
      cleanupDiagnostics: Object.freeze([])
    });
    this.#sequence = sequence;
    this.#current = generation;
    const summary = errorSummary(error, "runtime_failed") as Readonly<{ code: "runtime_failed"; message: string }>;
    try {
      void Promise.resolve(this.#onRuntimeFailure?.(Object.freeze({ identity, error: summary, generation }))).catch(() => {});
    } catch {
      // Health invalidation is observational, but it must be attempted before cleanup can block.
    }
    const cleanupDiagnostics = await cleanupStates(removedStates, "runtime_failure");
    const published = cleanupDiagnostics.length
      ? Object.freeze({ ...generation, cleanupDiagnostics })
      : generation;
    this.#current = published;
  }

  async #disposeNow(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#active;
    this.#active = new Map();
    const cleanupDiagnostics = await cleanupStates([...active.values()], "shutdown");
    if (cleanupDiagnostics.length) {
      this.#current = Object.freeze({
        ...this.#current,
        cleanupDiagnostics: Object.freeze([...this.#current.cleanupDiagnostics, ...cleanupDiagnostics])
      });
      throw new AggregateError(cleanupDiagnostics.map(item => new Error(item.message)), "Plugin cleanup failed during shutdown.");
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
