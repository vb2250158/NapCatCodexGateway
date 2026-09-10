import fs from "node:fs";
import path from "node:path";
import {
  autoAssignGatewayPorts,
  ensureDefaultPersonaRules,
  ensureDefaultPersonaAutomations,
  mergePersonaAutomationRules,
  normalizeGatewayDefinition,
  validateGatewayPortConflicts,
  type GatewayConfigFile,
  type GatewayDefinition,
  type NotificationRuleDefinition
} from "../shared/gatewayConfigModel.js";
import { toPersistedProjectPath } from "../shared/projectPaths.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath as resolveAdapterConfigPath,
  personaConfigPath as resolvePersonaConfigPath,
  routeFolderPath
} from "../shared/routePaths.js";
import { normalizeAgentAdapters } from "../agentAdapters/types.js";
import { normalizePipelineDefinition } from "../pipelines.js";
import {
  mergeNotificationRules,
  migrateLegacyConfigs,
  readPersonaConfigFragment,
  readPersonaConfigFragmentAsync,
  writePersonaConfig as writePersonaConfigFile,
  writePersonaRules
} from "./configMigration.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type ManagerConfig = {
  routeDir?: string;
  rolesDir?: string;
};

export type ManagerConfigRepositoryOptions = {
  rootDir: string;
  managerPort: number;
  routeRoot?: string;
  rolesRoot?: string;
};

export function migrateLegacyCopilotThreadName(
  definition: Partial<GatewayDefinition>
): Partial<GatewayDefinition> {
  const adapters = normalizeAgentAdapters(definition.agentAdapters);
  const legacyThreadName = definition.codexThreadName?.trim();
  if (adapters.length !== 1 || adapters[0] !== "copilotCli" || definition.copilotThreadName?.trim() || !legacyThreadName) {
    return definition;
  }

  const migrated = {
    ...definition,
    copilotThreadName: legacyThreadName
  };
  delete migrated.codexThreadName;
  return migrated;
}

export class ManagerConfigRepository {
  readonly rootDir: string;
  private currentManagerPort: number;
  routeRoot: string;
  rolesRoot: string;

  constructor(options: ManagerConfigRepositoryOptions) {
    this.rootDir = options.rootDir;
    this.currentManagerPort = options.managerPort;
    const cfg = this.readManagerConfig();
    this.routeRoot = path.resolve(this.rootDir, options.routeRoot ?? cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
    this.rolesRoot = path.resolve(this.rootDir, options.rolesRoot ?? cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
  }

  get managerConfigPath(): string {
    return path.join(this.rootDir, "data", "manager.json");
  }

  readManagerConfig(): ManagerConfig {
    if (!fs.existsSync(this.managerConfigPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.managerConfigPath, "utf8")) as ManagerConfig;
    } catch {
      return {};
    }
  }

  refreshManagerConfig(): ManagerConfig {
    const cfg = this.readManagerConfig();
    this.routeRoot = path.resolve(this.rootDir, cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
    this.rolesRoot = path.resolve(this.rootDir, cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
    return cfg;
  }

  writeManagerConfig(cfg: ManagerConfig): void {
    const existed = fs.existsSync(this.managerConfigPath);
    try {
      fs.mkdirSync(path.dirname(this.managerConfigPath), { recursive: true });
      fs.writeFileSync(this.managerConfigPath, JSON.stringify(cfg, null, 2), "utf8");
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "config",
        event: "manager_config_write_failed",
        owner: "config-repository",
        action: existed ? "replace" : "create",
        target: { type: "manager-config", id: "manager" },
        dataSource: { kind: "file", id: "data/manager.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "config",
      event: "manager_config_written",
      owner: "config-repository",
      action: existed ? "replace" : "create",
      target: { type: "manager-config", id: "manager" },
      dataSource: { kind: "file", id: "data/manager.json" },
      outcome: "committed",
      changes: Object.keys(cfg).sort().map(field => ({ field }))
    });
    this.routeRoot = path.resolve(this.rootDir, cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
    this.rolesRoot = path.resolve(this.rootDir, cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
  }

  ensureDataDirs(): void {
    const exampleDataDir = path.join(this.rootDir, "examples", "data");
    const exampleManagerConfig = path.join(exampleDataDir, "manager.json");
    if (!fs.existsSync(this.managerConfigPath) && fs.existsSync(exampleManagerConfig)) {
      fs.mkdirSync(path.dirname(this.managerConfigPath), { recursive: true });
      fs.copyFileSync(exampleManagerConfig, this.managerConfigPath, fs.constants.COPYFILE_EXCL);
      recordDataMutationAudit({
        group: "config",
        event: "default_manager_config_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "manager-config", id: "manager" },
        dataSource: { kind: "file", id: "data/manager.json" },
        outcome: "committed"
      });
      this.refreshManagerConfig();
    }
    if (!fs.existsSync(this.rolesRoot) && fs.existsSync(path.join(exampleDataDir, "roles"))) {
      fs.mkdirSync(path.dirname(this.rolesRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "roles"), this.rolesRoot, { recursive: true, force: false, errorOnExist: false });
      recordDataMutationAudit({
        group: "persona",
        event: "default_roles_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "role-catalog", id: "roles" },
        dataSource: { kind: "file", id: "data/roles" },
        outcome: "committed"
      });
    }
    if (!fs.existsSync(this.routeRoot) && fs.existsSync(path.join(exampleDataDir, "route"))) {
      fs.mkdirSync(path.dirname(this.routeRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "route"), this.routeRoot, { recursive: true, force: false, errorOnExist: false });
      recordDataMutationAudit({
        group: "route",
        event: "default_routes_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "route-catalog", id: "routes" },
        dataSource: { kind: "file", id: "data/route" },
        outcome: "committed"
      });
    }
    fs.mkdirSync(this.rolesRoot, { recursive: true });
    fs.mkdirSync(this.routeRoot, { recursive: true });
    // Do not synchronously traverse and rewrite every role on Manager startup.
    // rolesRoot may be NAS-backed; a broad legacy migration here can prevent the
    // local control-plane listener from ever coming up. Call migrateLegacyConfigs
    // only from an explicit maintenance/migration workflow.
  }

  async ensureDataDirsAsync(): Promise<void> {
    const exists = async (target: string): Promise<boolean> => {
      try {
        await fs.promises.access(target);
        return true;
      } catch {
        return false;
      }
    };
    const exampleDataDir = path.join(this.rootDir, "examples", "data");
    const exampleManagerConfig = path.join(exampleDataDir, "manager.json");
    if (!await exists(this.managerConfigPath) && await exists(exampleManagerConfig)) {
      await fs.promises.mkdir(path.dirname(this.managerConfigPath), { recursive: true });
      let copied = false;
      try {
        await fs.promises.copyFile(exampleManagerConfig, this.managerConfigPath, fs.constants.COPYFILE_EXCL);
        copied = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (copied) {
        recordDataMutationAudit({
          group: "config",
          event: "default_manager_config_installed",
          owner: "config-repository",
          action: "install-default",
          target: { type: "manager-config", id: "manager" },
          dataSource: { kind: "file", id: "data/manager.json" },
          outcome: "committed"
        });
      }
      this.refreshManagerConfig();
    }
    if (!await exists(this.rolesRoot) && await exists(path.join(exampleDataDir, "roles"))) {
      await fs.promises.mkdir(path.dirname(this.rolesRoot), { recursive: true });
      await fs.promises.cp(path.join(exampleDataDir, "roles"), this.rolesRoot, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      recordDataMutationAudit({
        group: "persona",
        event: "default_roles_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "role-catalog", id: "roles" },
        dataSource: { kind: "file", id: "data/roles" },
        outcome: "committed"
      });
    }
    if (!await exists(this.routeRoot) && await exists(path.join(exampleDataDir, "route"))) {
      await fs.promises.mkdir(path.dirname(this.routeRoot), { recursive: true });
      await fs.promises.cp(path.join(exampleDataDir, "route"), this.routeRoot, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      recordDataMutationAudit({
        group: "route",
        event: "default_routes_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "route-catalog", id: "routes" },
        dataSource: { kind: "file", id: "data/route" },
        outcome: "committed"
      });
    }
    await Promise.all([
      fs.promises.mkdir(this.rolesRoot, { recursive: true }),
      fs.promises.mkdir(this.routeRoot, { recursive: true })
    ]);
  }

  get managerPort(): number {
    return this.currentManagerPort;
  }

  setManagerPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Manager port must be an integer from 1 to 65535; received ${port}.`);
    }
    this.currentManagerPort = port;
  }

  adapterConfigPath(configName: string): string {
    return resolveAdapterConfigPath(this.routeRoot, configName);
  }

  readRoleMessageConfig(roleId: string | undefined): Partial<GatewayDefinition> {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return {};
    return readPersonaConfigFragment(this.personaConfigPath(safeRoleId));
  }

  async readRoleMessageConfigAsync(roleId: string | undefined): Promise<Partial<GatewayDefinition>> {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return {};
    return readPersonaConfigFragmentAsync(this.personaConfigPath(safeRoleId));
  }

  personaConfigPath(roleId: string): string {
    return resolvePersonaConfigPath(this.rolesRoot, roleId);
  }

  writePersonaRules(roleId: string, rules: NotificationRuleDefinition[] | undefined): void {
    writePersonaRules(this.personaConfigPath(roleId), rules);
  }

  writePersonaConfig(
    roleId: string,
    fragment: Pick<
      GatewayDefinition,
      "automationRules" | "notificationRules" | "recentMessageLimit" | "recentMessageLimits" | "speechTriggerKeywords" | "languageStyle" | "codexHooks"
    >
  ): void {
    writePersonaConfigFile(this.personaConfigPath(roleId), {
      ...fragment,
      automationRules: fragment.automationRules === undefined
        ? undefined
        : ensureDefaultPersonaAutomations(fragment.automationRules),
      notificationRules: fragment.notificationRules === undefined
        ? undefined
        : ensureDefaultPersonaRules(mergeNotificationRules(fragment.notificationRules))
    });
  }

  private configPathValue(value: unknown): string | undefined {
    return toPersistedProjectPath(value, this.rootDir);
  }

  migrateLegacyConfigs(): void {
    migrateLegacyConfigs({ routeRoot: this.routeRoot, rolesRoot: this.rolesRoot });
  }

  normalize(definition: GatewayDefinition): GatewayDefinition {
    return normalizeGatewayDefinition(definition, {
      managerPort: this.managerPort,
      routeDataDir: (configName) => path.relative(this.rootDir, routeFolderPath(this.routeRoot, configName)).replace(/\\/g, "/"),
      rolesDir: path.relative(this.rootDir, this.rolesRoot).replace(/\\/g, "/"),
      normalizeAgentAdapters,
      normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
    });
  }

  readConfig(): GatewayConfigFile {
    this.ensureDataDirs();
    const gateways: GatewayDefinition[] = [];
    for (const routeEntry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
      const configName = sanitizeConfigName(routeEntry.name);
      const configPath = this.adapterConfigPath(configName);
      if (!fs.existsSync(configPath)) continue;
      const raw = migrateLegacyCopilotThreadName(
        JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>
      );
      const personaConfig = this.readRoleMessageConfig(raw.agentRoleId);
      gateways.push(this.normalize({
        ...raw,
        ...personaConfig,
        id: configName,
        configName,
        agentRoleId: raw.agentRoleId,
        rolesDir: raw.rolesDir,
        agentRoleFile: raw.agentRoleFile
      } as GatewayDefinition));
    }
    return { gateways };
  }

  private removeConfigFilesMissingFrom(activeConfigNames: Set<string>): void {
    if (!fs.existsSync(this.routeRoot)) return;
    for (const routeEntry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
      const configName = sanitizeConfigName(routeEntry.name);
      if (!configName || activeConfigNames.has(configName)) continue;
      const configPath = this.adapterConfigPath(configName);
      if (fs.existsSync(configPath)) {
        try { fs.unlinkSync(configPath); } catch { /* non-fatal */ }
      }
    }
  }

  writeConfig(config: GatewayConfigFile, scope?: { configName: string; previousId: string }): GatewayConfigFile {
    if (!Array.isArray(config.gateways)) throw new Error("routes must be an array");
    const normalized = { gateways: config.gateways.map((definition) => this.normalize(definition)) };
    autoAssignGatewayPorts(normalized.gateways, this.managerPort);
    validateGatewayPortConflicts(normalized.gateways);
    const activeConfigNames = new Set<string>();
    const groupedByRole = new Map<string, Pick<
      GatewayDefinition,
      "automationRules" | "notificationRules" | "recentMessageLimit" | "recentMessageLimits" | "speechTriggerKeywords" | "languageStyle" | "codexHooks"
    >>();
    for (let i = 0; i < normalized.gateways.length; i += 1) {
      const definition = normalized.gateways[i];
      const raw = config.gateways[i];
      const oldConfigName = routeRuntimeParts(raw.id).configName || sanitizeConfigName(raw.configName);
      const configName = sanitizeConfigName(definition.configName) || definition.id;
      activeConfigNames.add(configName);
      if (scope && configName !== scope.configName) continue;
      if (oldConfigName && oldConfigName !== configName) {
        const oldConfigPath = this.adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
      const configPath = this.adapterConfigPath(configName);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(this.adapterConfigItem(definition), null, 2), "utf8");
      const roleId = sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId;
      if (roleId) {
        const previous = groupedByRole.get(roleId);
        groupedByRole.set(roleId, {
          recentMessageLimit: previous?.recentMessageLimit ?? definition.recentMessageLimit,
          recentMessageLimits: previous?.recentMessageLimits ?? definition.recentMessageLimits,
          speechTriggerKeywords: previous?.speechTriggerKeywords ?? definition.speechTriggerKeywords,
          languageStyle: previous?.languageStyle ?? definition.languageStyle,
          codexHooks: previous?.codexHooks ?? definition.codexHooks,
          automationRules: mergePersonaAutomationRules(previous?.automationRules, definition.automationRules),
          notificationRules: mergeNotificationRules(previous?.notificationRules, definition.notificationRules)
        });
      }
    }
    for (const [roleId, fragment] of groupedByRole.entries()) {
      this.writePersonaConfig(roleId, fragment);
    }
    if (scope) {
      const previousName = routeRuntimeParts(scope.previousId).configName || sanitizeConfigName(scope.previousId);
      if (previousName && previousName !== scope.configName) {
        const oldPath = this.adapterConfigPath(previousName);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    } else this.removeConfigFilesMissingFrom(activeConfigNames);
    return normalized;
  }

  private adapterConfigItem(definition: GatewayDefinition): Partial<GatewayDefinition> {
    const {
      notificationRules: _notificationRules,
      automationRules: _automationRules,
      roleNotificationRules: _roleNotificationRules,
      roleRouteNames: _roleRouteNames,
      routeProfiles: _routeProfiles,
      dataDir: _dataDir,
      recentMessageLimit: _recentMessageLimit,
      recentMessageLimits: _recentMessageLimits,
      speechTriggerKeywords: _speechTriggerKeywords,
      languageStyle: _languageStyle,
      rabiLinkRelayEnabled: _rabiLinkRelayEnabled,
      rabiLinkRelayUrl: _rabiLinkRelayUrl,
      rabiLinkRelayToken: _rabiLinkRelayToken,
      rabiLinkRelayDeviceId: _rabiLinkRelayDeviceId,
      rabiLinkRelayClaimWaitMs: _rabiLinkRelayClaimWaitMs,
      rabiLinkRelayReplyIdleTimeoutMs: _rabiLinkRelayReplyIdleTimeoutMs,
      ...adapterOnly
    } = definition;
    return {
      ...adapterOnly,
      ...(definition.agentRoleId ? { codexHooks: undefined } : {}),
      remoteAgentDefaultCwd: this.configPathValue(adapterOnly.remoteAgentDefaultCwd),
      codexCwd: this.configPathValue(adapterOnly.codexCwd),
      copilotCwd: this.configPathValue(adapterOnly.copilotCwd),
      rolesDir: this.configPathValue(adapterOnly.rolesDir),
      routesDir: this.configPathValue(adapterOnly.routesDir),
      napcatInstances: Array.isArray(adapterOnly.napcatInstances)
        ? adapterOnly.napcatInstances.map((instance) => ({
            ...instance,
            workingDir: this.configPathValue(instance.workingDir)
          }))
        : adapterOnly.napcatInstances
    };
  }
}
