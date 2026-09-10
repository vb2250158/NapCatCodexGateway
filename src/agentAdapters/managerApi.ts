import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentAdapterType } from "./types.js";
import {
  agentAdapterManifest,
  type AgentAdapterMaturity
} from "../shared/agentAdapterCapabilities.js";
import { resolvePersistedProjectPath } from "../shared/projectPaths.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import { CodexDesktopBridge } from "../codexDesktopBridge.js";
import { listCodexModels, listCodexThreads, type CodexModelCatalogEntry } from "../codexRuntime.js";
import {
  DEFAULT_DSH_BASE_URL,
  DSH_RABIROUTE_TOOL_NAMES,
  EXPECTED_DSH_RABIROUTE_PLUGIN_VERSION,
  listDshModels,
  listDshSessions,
  type DshModelCatalogEntry,
  readDshRabiRoutePluginStatus,
  type DshRabiRoutePluginStatus
} from "../dshSessionBridge.js";

type AgentMaturity = AgentAdapterMaturity;

export type AgentScanModel = {
  id: string;
  name: string;
  provider?: string;
  providerName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: Array<{ id: string; description?: string }>;
};

type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

export type AgentSessionPageQuery = {
  limit: number;
  offset: number;
  query?: string;
};

export type AgentSessionPage = {
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
};

export type AgentScanOptions = {
  codexLimit?: number;
  codexOffset?: number;
  codexQuery?: string;
  codexCatalogTimeoutMs?: number;
  dshLimit?: number;
  dshOffset?: number;
  dshQuery?: string;
  dshBaseUrl?: string;
};

export type AgentScanPerformanceOperation = {
  operation: string;
  durationMs: number;
  error: boolean;
};

type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

export type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  sessionPage?: AgentSessionPage;
  models?: AgentScanModel[];
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean; details?: string[] }>;
  warnings?: string[];
  transport?: { protocol: string; mode: string };
  host?: { name: string; required: boolean };
};

function agentScanManifestFields(type: AgentAdapterType): Pick<
  AgentScanResult,
  "type" | "label" | "maturity" | "transport" | "host"
> {
  const manifest = agentAdapterManifest(type);
  return {
    type: manifest.type,
    label: manifest.label,
    maturity: manifest.maturity,
    transport: { ...manifest.transport },
    ...(manifest.host ? { host: { ...manifest.host } } : {})
  };
}

export type GatewayDefinitionLike = {
  id?: string;
  name?: string;
  routeName?: string;
  configName?: string;
  agentAdapters?: AgentAdapterType[];
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
  copilotThreadName?: string;
  copilotCwd?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
};

export type AgentScanRuntimeSnapshot = {
  definition: GatewayDefinitionLike;
};

type CopilotSessionEntry = {
  id: string;
  name: string;
  cwd?: string;
  userNamed?: boolean;
  updatedAt?: string;
};

type AstrbotSessionScan = {
  authVerified: boolean;
  authMessage?: string;
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  source: "api" | "local-db" | "none";
};

export type AstrbotLoginTestRequest = {
  url?: string;
  username?: string;
  password?: string;
};

export type MarvisOpenRequest = {
  appId?: string;
  url?: string;
};

export type AgentManagerApiContext = {
  rootDir: string;
  runtimes?: Iterable<AgentScanRuntimeSnapshot>;
  getRuntimes?: () => Iterable<AgentScanRuntimeSnapshot>;
  projects?: AgentScanProject[];
  codexSessions?: AgentScanSession[];
  codexBins?: string[];
  threadNames?: string[];
  cwdOptions?: string[];
  copilotSessions?: CopilotSessionEntry[];
  copilotBins?: string[];
  marvisAppIds?: string[];
  checkHttpEndpoint?: (url: string, timeoutMs?: number) => Promise<boolean>;
  resolveWingetCopilot?: () => string | null;
  listCodexSessions?: (
    query: AgentSessionPageQuery,
    options?: { signal?: AbortSignal }
  ) => Promise<AgentScanSession[]>;
  isCodexDesktopReady?: () => Promise<boolean>;
  listCodexModels?: (cwd: string, timeoutMs?: number) => Promise<CodexModelCatalogEntry[]>;
  dshSessions?: AgentScanSession[];
  listDshSessions?: (query: AgentSessionPageQuery & { baseUrl: string }) => Promise<AgentScanSession[]>;
  listDshModels?: (baseUrl: string) => Promise<{ models: DshModelCatalogEntry[]; warnings: string[] }>;
  readDshRabiRoutePluginStatus?: (baseUrl: string) => Promise<DshRabiRoutePluginStatus>;
};



export async function scanDshAgentAdapter(
  ctx: AgentManagerApiContext,
  options: Pick<AgentScanOptions, "dshLimit" | "dshOffset" | "dshQuery" | "dshBaseUrl"> = {}
): Promise<{ agents: { dsh: AgentScanResult }; cwdOptions: string[] }> {
  const dshLimit = Math.max(1, Math.min(500, Math.floor(options.dshLimit ?? 200)));
  const dshOffset = Math.max(0, Math.floor(options.dshOffset ?? 0));
  const dshQuery = String(options.dshQuery || "").trim() || undefined;
  const runtimes = getRuntimeList(ctx);
  const checkEndpoint = ctx.checkHttpEndpoint ?? checkHttpEndpoint;
  const configuredDshUrls = [
    options.dshBaseUrl?.trim().replace(/\/+$/, ""),
    ...runtimes.map((runtime) => runtime.definition.dshBaseUrl?.trim().replace(/\/+$/, ""))
  ].filter(Boolean) as string[];
  const dshUrls = [...new Set([...configuredDshUrls, DEFAULT_DSH_BASE_URL])];
  const dshEndpoints = await Promise.all(dshUrls.map(async (url) => ({
    label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 DSH apiproxy" : "DSH apiproxy",
    url,
    healthy: await checkEndpoint(url)
  })));
  const dshBaseUrl = configuredDshUrls[0] || DEFAULT_DSH_BASE_URL;
  const dshEndpointHealthy = dshEndpoints.some((endpoint) => endpoint.url === dshBaseUrl && endpoint.healthy);
  const pluginStatusPromise = dshEndpointHealthy
    ? (ctx.readDshRabiRoutePluginStatus ?? readDshRabiRoutePluginStatus)(dshBaseUrl)
        .then((status) => ({ status, error: "" }))
        .catch((error) => ({ status: undefined, error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ status: undefined, error: "" });
  const shouldReadDshModels = dshEndpointHealthy && (
    ctx.listDshModels != null
    || (ctx.dshSessions == null && ctx.listDshSessions == null && ctx.readDshRabiRoutePluginStatus == null)
  );
  const modelCatalogPromise = shouldReadDshModels
    ? (ctx.listDshModels ?? listDshModels)(dshBaseUrl)
        .then((catalog) => ({ catalog, error: "" }))
        .catch((error) => ({ catalog: { models: [], warnings: [] }, error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ catalog: { models: [], warnings: [] }, error: "" });
  let dshSessionWarning = "";
  let rawDshSessions: AgentScanSession[] = ctx.dshSessions ?? [];
  if (!ctx.dshSessions && (ctx.listDshSessions || dshEndpointHealthy)) {
    try {
      const listSessions = ctx.listDshSessions ?? (async (query: AgentSessionPageQuery & { baseUrl: string }) => (
        await listDshSessions({
          baseUrl: query.baseUrl,
          query: query.query,
          limit: query.limit,
          offset: query.offset
        })
      ).map((session) => ({
        id: session.id,
        name: session.title,
        projectPath: session.cwd,
        updatedAt: session.updatedAt
      })));
      const query = {
        baseUrl: dshBaseUrl,
        limit: dshLimit + 1,
        offset: dshOffset,
        query: dshQuery
      };
      try {
        rawDshSessions = await listSessions(query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/HTTP 404\b/i.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        rawDshSessions = await listSessions(query);
      }
    } catch (error) {
      dshSessionWarning = `读取 DSH 会话失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const dshHasMore = rawDshSessions.length > dshLimit;
  const dshSessions = rawDshSessions.slice(0, dshLimit);
  const dshSessionPage: AgentSessionPage = {
    offset: dshOffset,
    limit: dshLimit,
    returned: dshSessions.length,
    hasMore: dshHasMore,
    ...(dshHasMore ? { nextOffset: dshOffset + dshSessions.length } : {})
  };
  const configuredDshCwds = runtimes
    .map((runtime) => resolvePersistedProjectPath(runtime.definition.dshCwd, ctx.rootDir))
    .filter((value): value is string => Boolean(value));
  const dshProjects = projectOptionsFromPaths([
    ...configuredDshCwds,
    ...dshSessions.map((session) => session.projectPath).filter((value): value is string => Boolean(value))
  ]);
  const [pluginRead, modelRead] = await Promise.all([pluginStatusPromise, modelCatalogPromise]);
  const pluginStatus = pluginRead.status;
  const pluginVersionMatches = pluginStatus?.version === EXPECTED_DSH_RABIROUTE_PLUGIN_VERSION;
  const pluginToolCoverage = DSH_RABIROUTE_TOOL_NAMES.every((name) => pluginStatus?.tools.includes(name));
  const pluginHealthy = Boolean(
    pluginStatus?.active
    && pluginVersionMatches
    && pluginStatus.enforceAgentCommunication === true
    && pluginToolCoverage
  );
  const pluginDetails = pluginStatus ? [
    `Manager：${pluginStatus.managerBaseUrl || "未报告"}`,
    `Agent 通信约束：${pluginStatus.enforceAgentCommunication === true ? "已启用" : "未启用"}`,
    `模型工具：${pluginStatus.tools.length}/${DSH_RABIROUTE_TOOL_NAMES.length}`
  ] : [];
  const pluginWarnings = [
    ...(pluginRead.error ? [`读取 DSH RabiRoute Agent 插件状态失败：${pluginRead.error}。请安装或更新 dsh-private-plugins，并重启 DSH。`] : []),
    ...(pluginStatus && !pluginStatus.active ? ["DSH 已发现 RabiRoute Agent 插件，但运行组件尚未激活；请检查 tools/systemPrompt 依赖并重启 DSH。"] : []),
    ...(pluginStatus?.version && !pluginVersionMatches ? [`DSH RabiRoute Agent 插件版本为 ${pluginStatus.version}，RabiRoute 当前要求 ${EXPECTED_DSH_RABIROUTE_PLUGIN_VERSION}；请更新插件并重启 DSH。`] : []),
    ...(pluginStatus && pluginStatus.enforceAgentCommunication !== true ? ["DSH RabiRoute Agent 的 Agent 通信约束未启用；请设置 enforceAgentCommunication=true 并重启 DSH。"] : []),
    ...(pluginStatus && !pluginToolCoverage ? [`DSH RabiRoute Agent 模型工具不完整；应包含 ${DSH_RABIROUTE_TOOL_NAMES.join("、")}。`] : [])
  ];
  return {
    agents: { dsh: {
      ...agentScanManifestFields("dsh"),
      installed: dshEndpoints.some((endpoint) => endpoint.healthy),
      endpoints: dshEndpoints,
      projects: dshProjects,
      sessions: dshSessions,
      sessionPage: dshSessionPage,
      models: modelRead.catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        providerName: model.providerName,
        ...(model.description ? { description: model.description } : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        reasoningEfforts: model.reasoningEfforts
      })),
      plugins: [{
        id: "rabiroute-agent",
        name: "RabiRoute Agent",
        installed: Boolean(pluginStatus),
        healthy: pluginHealthy,
        ...(pluginStatus?.version ? { version: pluginStatus.version } : {}),
        ...(pluginDetails.length ? { details: pluginDetails } : {})
      }],
      warnings: [
        ...pluginWarnings,
        ...(modelRead.error ? [`读取 DSH 模型目录失败：${modelRead.error}`] : []),
        ...modelRead.catalog.warnings.map((warning) => `DSH 模型目录：${warning}`),
        ...(dshSessionWarning ? [dshSessionWarning] : []),
        ...(dshEndpoints.some((endpoint) => endpoint.healthy) ? [] : ["DSH apiproxy 不可用；请启动 DSH 并确认服务地址。"]),
        ...(dshSessions.length === 0 && !dshSessionWarning ? ["未发现 DSH 会话；保存配置时可按名称和工作目录创建。"] : []),
        "RabiRoute 可以发现、创建、重命名、绑定 DSH 会话，并通过 session.prompt（mode=queue）投递。",
        "DSH 支持主人格、计划秘书、消息处理和独立记忆整理会话；请在当前实例核对任务可用性和实际投递结果。"
      ]
    } },
    cwdOptions: dshProjects.map((project) => project.path)
  };
}


export async function scanAgentAdapters(
  ctx: AgentManagerApiContext,
  options: AgentScanOptions = {}
): Promise<Record<string, unknown>> {
  const codexLimit = Math.max(1, Math.min(500, Math.floor(options.codexLimit ?? 200)));
  const codexOffset = Math.max(0, Math.floor(options.codexOffset ?? 0));
  const codexQuery = String(options.codexQuery || "").trim() || undefined;
  const codexCatalogTimeoutMs = Math.max(100, Math.min(30_000, Math.floor(options.codexCatalogTimeoutMs ?? 8_000)));
  const performanceOperations: AgentScanPerformanceOperation[] = [];
  const runtimes = getRuntimeList(ctx);
  const checkEndpoint = ctx.checkHttpEndpoint ?? checkHttpEndpoint;
  const copilotSessions = ctx.copilotSessions ?? readCopilotSessions();
  const copilotSessionNames = [...new Set(copilotSessions.map((s) => s.name))];
  const cwdOptions = ctx.cwdOptions ?? collectCwdOptions(ctx.rootDir, runtimes, copilotSessions);
  let codexDesktopReady = false;
  const desktopBridge = new CodexDesktopBridge({ requestTimeoutMs: 1_200 });
  const desktopReadyStartedAt = performance.now();
  let desktopReadyFailed = false;
  try {
    codexDesktopReady = await (ctx.isCodexDesktopReady ?? (() => desktopBridge.isReady()))();
    desktopReadyFailed = !codexDesktopReady;
  } finally {
    desktopBridge.close();
    performanceOperations.push({
      operation: PERFORMANCE_OPERATIONS.managerAgentScanDesktopReady,
      durationMs: performance.now() - desktopReadyStartedAt,
      error: desktopReadyFailed
    });
  }
  const shouldReadCodexModels = codexDesktopReady && (ctx.listCodexModels != null || ctx.codexSessions == null);
  const codexModelsPromise = shouldReadCodexModels
    ? (ctx.listCodexModels ?? listCodexModels)(ctx.rootDir, codexCatalogTimeoutMs)
        .then((models) => ({ models, error: "" }))
        .catch((error) => ({ models: [] as CodexModelCatalogEntry[], error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ models: [] as CodexModelCatalogEntry[], error: "" });
  let codexSessionWarning = "";
  let discoveredCodexSessions: AgentScanSession[] = [];
  if (!ctx.codexSessions) {
    const catalogStartedAt = performance.now();
    let catalogFailed = false;
    const catalogController = new AbortController();
    let catalogTimer: NodeJS.Timeout | undefined;
    try {
      const listSessions = ctx.listCodexSessions ?? (async (
        query: AgentSessionPageQuery,
        listOptions?: { signal?: AbortSignal }
      ) => (await listCodexThreads({
        query: query.query,
        limit: query.limit,
        offset: query.offset,
        allowedWorkspaces: [],
        signal: listOptions?.signal
      })).map((thread) => ({
        id: thread.id,
        name: thread.title,
        projectPath: thread.cwd,
        updatedAt: thread.updatedAt
      })));
      const timeout = new Promise<never>((_resolve, reject) => {
        catalogTimer = setTimeout(() => {
          catalogController.abort();
          reject(new Error(`Codex Desktop task catalog timed out after ${codexCatalogTimeoutMs} ms.`));
        }, codexCatalogTimeoutMs);
      });
      discoveredCodexSessions = await Promise.race([
        listSessions({
          limit: codexLimit + 1,
          offset: codexOffset,
          query: codexQuery
        }, { signal: catalogController.signal }),
        timeout
      ]);
    } catch (error) {
      catalogFailed = true;
      codexSessionWarning = catalogController.signal.aborted
        ? `读取 Codex Desktop 任务目录超时（${codexCatalogTimeoutMs} ms）；页面已继续加载，请稍后点击扫描重试。`
        : `读取 Codex Desktop 任务失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (catalogTimer) clearTimeout(catalogTimer);
      performanceOperations.push({
        operation: PERFORMANCE_OPERATIONS.managerAgentScanCodexCatalog,
        durationMs: performance.now() - catalogStartedAt,
        error: catalogFailed
      });
    }
  }
  const codexModelRead = await codexModelsPromise;
  const rawCodexSessions = ctx.codexSessions ?? discoveredCodexSessions;
  const codexHasMore = rawCodexSessions.length > codexLimit;
  const codexSessions = rawCodexSessions.slice(0, codexLimit);
  const codexSessionPage: AgentSessionPage = {
    offset: codexOffset,
    limit: codexLimit,
    returned: codexSessions.length,
    hasMore: codexHasMore,
    ...(codexHasMore ? { nextOffset: codexOffset + codexSessions.length } : {})
  };
  const codexSessionNames = [...new Set(codexSessions.map((session) => session.name))];
  const configThreadNames = runtimes.flatMap((runtime) => {
    const adapters = runtime.definition.agentAdapters ?? ["codex"];
    return [
      adapters.includes("codex") ? runtime.definition.codexThreadName : undefined,
      adapters.includes("copilotCli") ? runtime.definition.copilotThreadName : undefined
    ].filter(Boolean) as string[];
  });
  const threadNames = ctx.threadNames ?? [...new Set([...copilotSessionNames, ...codexSessionNames, ...configThreadNames])];

  const codexBins = ctx.codexBins ?? await detectCodexBins(ctx.rootDir);
  const copilotBins = ctx.copilotBins ?? await detectCopilotBins(ctx.resolveWingetCopilot);
  const marvisAppIds = ctx.marvisAppIds ?? detectMarvisAppIds();
  const projects = ctx.projects ?? projectOptionsFromPaths([
    ...cwdOptions,
    ...codexSessions.map((session) => session.projectPath).filter((value): value is string => Boolean(value))
  ]);
  const copilotScanSessions: AgentScanSession[] = copilotSessions.map((session) => ({
    id: session.id,
    name: session.name,
    projectPath: session.cwd,
    updatedAt: session.updatedAt,
    userNamed: session.userNamed
  }));

  const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  const copilotLoggedIn = readCopilotLoggedIn(copilotHome);

  const configuredAstrbotUrls = runtimes.map((runtime) => runtime.definition.astrbotUrl?.trim()).filter(Boolean) as string[];
  const configuredAstrbotPasswords = runtimes.map((runtime) => runtime.definition.astrbotPassword?.trim()).filter(Boolean) as string[];
  const configuredAstrbotUsernames = runtimes.map((runtime) => runtime.definition.astrbotUsername?.trim()).filter(Boolean) as string[];
  const astrbotUrls = [...new Set([
    ...configuredAstrbotUrls,
    process.env.ASTRBOT_URL,
    "http://127.0.0.1:6185"
  ].filter(Boolean) as string[])];
  const dshScan = await scanDshAgentAdapter({ ...ctx, runtimes }, options);
  const dshAgent = dshScan.agents.dsh;

  const astrbotEndpoints = await Promise.all(astrbotUrls.map(async (url) => ({
    label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 AstrBot" : "AstrBot",
    url,
    healthy: await checkEndpoint(url)
  })));

  const astrbotPasswordPresent = Boolean(process.env.ASTRBOT_PASSWORD?.trim() || configuredAstrbotPasswords.length > 0);
  const astrbotBaseUrl = (configuredAstrbotUrls[0] || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const astrbotUsername = configuredAstrbotUsernames[0] || process.env.ASTRBOT_USERNAME || "";
  const astrbotPassword = configuredAstrbotPasswords[0] || process.env.ASTRBOT_PASSWORD || "";
  let astrbotSessionScan: AstrbotSessionScan = {
    authVerified: false,
    authMessage: astrbotPasswordPresent ? "已填写 AstrBot 凭据，尚未验证 Dashboard 登录。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。",
    projects: [],
    sessions: [],
    source: "none"
  };
  if (astrbotPasswordPresent && astrbotEndpoints.some((endpoint) => endpoint.healthy)) {
    const login = await loginAstrbotDashboard(astrbotBaseUrl, astrbotUsername, astrbotPassword);
    if (login.token) {
      astrbotSessionScan = await scanAstrbotViaDashboardApi(astrbotBaseUrl, astrbotUsername, login.token);
    } else {
      astrbotSessionScan.authMessage = `已填写 AstrBot 凭据，但 Dashboard 登录未通过：${login.message || "未知错误"}`;
    }
  }
  if (astrbotSessionScan.sessions.length === 0 || astrbotSessionScan.projects.length === 0) {
    const localScan = await scanAstrbotLocalDb();
    astrbotSessionScan = {
      ...astrbotSessionScan,
      projects: astrbotSessionScan.projects.length ? astrbotSessionScan.projects : localScan.projects,
      sessions: astrbotSessionScan.sessions.length ? astrbotSessionScan.sessions : localScan.sessions,
      source: astrbotSessionScan.source === "api" ? "api" : localScan.source
    };
  }

  const agents: Record<AgentAdapterType, AgentScanResult> = {
    codex: buildCodexAgentScan({
      codexBins,
      projects,
      sessions: codexSessions,
      sessionPage: codexSessionPage,
      desktopReady: codexDesktopReady,
      models: codexModelRead.models,
      sessionWarning: [
        codexSessionWarning,
        codexModelRead.error ? `读取 Codex 模型目录失败：${codexModelRead.error}` : ""
      ].filter(Boolean).join("；")
    }),
    copilotCli: {
      ...agentScanManifestFields("copilotCli"),
      installed: copilotBins.length > 0,
      installCandidates: copilotBins.map((binPath) => ({ label: path.basename(binPath), path: binPath })),
      auth: {
        required: true,
        loggedIn: copilotLoggedIn,
        loginUrl: "https://github.com/login/device",
        message: copilotLoggedIn ? "已发现 Copilot 登录状态。" : `未在 ${copilotHome} 发现登录状态。`
      },
      projects,
      sessions: copilotScanSessions,
      warnings: [
        "尚未完成真实端到端烟测：需确认 --name 会复用同一会话，且连续两次注入不会新开线程。",
        ...(copilotScanSessions.length === 0 ? ["未发现 Copilot session-state；会话下拉需要先运行过 Copilot CLI。"] : [])
      ]
    },
    marvis: {
      ...agentScanManifestFields("marvis"),
      installed: marvisAppIds.length > 0,
      installCandidates: marvisAppIds.map((id) => ({ label: id })),
      warnings: [
        "当前 Marvis 适配更像打开 App/复制 prompt 的人工接力，不是可靠的线程消息注入。",
        "不能列会话、不能创建会话，也不能验证同会话重复注入；不要标为 verified。"
      ]
    },
    astrbot: {
      ...agentScanManifestFields("astrbot"),
      installed: astrbotEndpoints.some((endpoint) => endpoint.healthy),
      auth: {
        required: true,
        loggedIn: astrbotSessionScan.authVerified,
        message: astrbotSessionScan.authMessage
      },
      endpoints: astrbotEndpoints,
      projects: astrbotSessionScan.projects,
      sessions: astrbotSessionScan.sessions,
      warnings: [
        ...(astrbotSessionScan.source === "local-db" ? ["已从本机 AstrBot 数据库读取项目/会话；发送前仍需 Dashboard 登录或 API Key 验证。"] : []),
        ...(astrbotSessionScan.sessions.length === 0 ? ["未读取到 AstrBot WebChat 会话；可以在 AstrBot ChatUI 创建对话后重新扫描。"] : []),
        "尚未自动执行真实消息注入烟测；同会话连续两次发送需用户确认后再测。",
      ]
    },
    dsh: dshAgent
  };

  return {
    __performanceOperations: performanceOperations,
    agents,
    legacy: {
      threadNames,
      cwdOptions,
      copilotSessions: copilotSessions.map((s) => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
      copilotBins: [...new Set(copilotBins)],
      marvisAppIds: [...new Set(marvisAppIds)]
    },
    threadNames,
    cwdOptions,
    copilotSessions: copilotSessions.map((s) => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
    copilotBins: [...new Set(copilotBins)],
    marvisAppIds: [...new Set(marvisAppIds)]
  };
}

export function buildCodexAgentScan(input: {
  codexBins: string[];
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  sessionPage?: AgentSessionPage;
  desktopReady?: boolean;
  models?: CodexModelCatalogEntry[];
  sessionWarning?: string;
}): AgentScanResult {
  const codexBins = [...new Set(input.codexBins.filter(Boolean))];
  return {
    ...agentScanManifestFields("codex"),
    installed: input.desktopReady === true || codexBins.length > 0,
    installCandidates: codexBins.map((binPath) => ({
      label: binPath.endsWith("codex.js") ? "@openai/codex" : path.basename(binPath),
      path: binPath
    })),
    projects: input.projects,
    // Desktop state supplies task identity; delivery is accepted only by the
    // Desktop owner for the exact opaque task id.
    sessions: input.sessions,
    ...(input.sessionPage ? { sessionPage: input.sessionPage } : {}),
    models: (input.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      reasoningEfforts: model.reasoningEfforts
    })),
    warnings: [
      ...(input.desktopReady === false ? ["Codex/ChatGPT Desktop 未就绪；RabiRoute 不会启动备用 Runtime，请先打开 Desktop。"] : []),
      ...(codexBins.length === 0 ? ["未发现项目锁定的 @openai/codex；已有 Desktop 任务仍可投递，但无法从新名称创建空任务。"] : []),
      ...(input.sessionWarning ? [input.sessionWarning] : [])
    ]
  };
}

export async function testAstrbotLogin(
  request: AstrbotLoginTestRequest
): Promise<Record<string, unknown> & { ok: boolean }> {
  const baseUrl = (request.url?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const username = request.username?.trim() || process.env.ASTRBOT_USERNAME || "";
  const password = request.password?.trim() || process.env.ASTRBOT_PASSWORD || "";
  if (!password) {
    return { ok: false, status: 400, message: "缺少 AstrBot 密码。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }

    if (!response.ok || body.status === "error" || body.error) {
      const rawMessage = body.message || body.error || body.detail || text || `HTTP ${response.status}`;
      const credentialHint = response.status === 401 || response.status === 403 || /password|credential|用户名|密码|登录|auth/i.test(rawMessage);
      return {
        ok: false,
        status: response.status,
        message: credentialHint ? `AstrBot 登录失败：账号或密码可能不正确。(${rawMessage})` : `AstrBot 登录失败：${rawMessage}`
      };
    }

    if (!body.data?.token) {
      return { ok: false, status: response.status, message: "AstrBot 登录响应里没有 token，可能 API 版本不匹配。" };
    }

    const token = body.data.token;
    const sessions = await scanAstrbotViaDashboardApi(baseUrl, username, token);
    const counts = sessions.source === "api"
      ? ` 已读取 ${sessions.projects.length} 个项目、${sessions.sessions.length} 个会话。`
      : "";
    return { ok: true, status: response.status, message: `AstrBot 登录验证成功。${counts}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message: message.includes("abort") ? "AstrBot 登录验证超时。" : `AstrBot 登录验证失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function getCopilotStatus(ctx: AgentManagerApiContext): Promise<Record<string, unknown>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let installed = false;
  let binPath = ctx.resolveWingetCopilot?.() ?? "";
  if (binPath) {
    installed = true;
  } else {
    const whereCmd = process.platform === "win32" ? "where.exe" : "which";
    try {
      const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: 2000 });
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .find((p) => !p.endsWith(".ps1"));
      if (first) {
        installed = true;
        binPath = first;
      }
    } catch {
      // not installed
    }
  }
  const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  return { installed, binPath, loggedIn: readCopilotLoggedIn(copilotHome), copilotHome };
}

export function openMarvis(_ctx: AgentManagerApiContext, request: MarvisOpenRequest): Record<string, unknown> {
  const appId = request.appId?.trim() || process.env.MARVIS_APP_ID?.trim() || "Tencent.Marvis";
  const url = request.url?.trim() || process.env.MARVIS_URL?.trim() || "https://marvis.qq.com/";
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [`shell:AppsFolder\\${appId}`]);
    return { ok: true, mode: "desktop", target: appId, message: `已尝试打开 Marvis 应用：${appId}` };
  }

  openUrlWithDefaultApp(url);
  return { ok: true, mode: "url", target: url, message: `已尝试打开 Marvis 页面：${url}` };
}

function getRuntimeList(ctx: AgentManagerApiContext): AgentScanRuntimeSnapshot[] {
  const source = ctx.getRuntimes ? ctx.getRuntimes() : ctx.runtimes;
  return source ? [...source] : [];
}

function readCopilotSessions(): CopilotSessionEntry[] {
  const copilotSessionStateDir = path.join(os.homedir(), ".copilot", "session-state");
  const sessions: CopilotSessionEntry[] = [];
  try {
    for (const entry of fs.readdirSync(copilotSessionStateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const yamlPath = path.join(copilotSessionStateDir, entry.name, "workspace.yaml");
      if (!fs.existsSync(yamlPath)) continue;
      try {
        const yamlContent = fs.readFileSync(yamlPath, "utf8");
        const idMatch = yamlContent.match(/^id:\s*(.+)$/m);
        const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
        const cwdMatch = yamlContent.match(/^cwd:\s*(.+)$/m);
        const userNamedMatch = yamlContent.match(/^user_named:\s*(.+)$/m);
        const updatedMatch = yamlContent.match(/^updated_at:\s*(.+)$/m);
        if (idMatch && nameMatch) {
          sessions.push({
            id: idMatch[1].trim(),
            name: nameMatch[1].trim(),
            cwd: cwdMatch?.[1].trim(),
            userNamed: userNamedMatch?.[1].trim() === "true",
            updatedAt: updatedMatch?.[1].trim()
          });
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // dir not found
  }
  return sessions;
}

function collectCwdOptions(rootDir: string, runtimes: AgentScanRuntimeSnapshot[], copilotSessions: CopilotSessionEntry[]): string[] {
  const copilotCwds = [...new Set(copilotSessions.map((s) => s.cwd).filter(Boolean) as string[])].filter(fs.existsSync);
  const cwdSet = new Set<string>(copilotCwds);
  if (fs.existsSync(rootDir)) cwdSet.add(rootDir);
  for (const rt of runtimes) {
    const codexCwd = resolvePersistedProjectPath(rt.definition.codexCwd, rootDir) ?? "";
    const copilotCwd = resolvePersistedProjectPath(rt.definition.copilotCwd, rootDir) ?? "";
    if (codexCwd && fs.existsSync(codexCwd)) cwdSet.add(codexCwd);
    if (copilotCwd && fs.existsSync(copilotCwd)) cwdSet.add(copilotCwd);
  }
  try {
    const parentDir = path.dirname(rootDir);
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) cwdSet.add(path.join(parentDir, entry.name));
    }
  } catch {
    // skip
  }
  return [...cwdSet];
}

async function detectCodexBins(rootDir: string): Promise<string[]> {
  const localRuntime = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  return fs.existsSync(localRuntime) ? [localRuntime] : [];
}

async function detectCopilotBins(resolveWingetCopilot?: () => string | null): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const whereCmd = process.platform === "win32" ? "where.exe" : "which";
  const copilotBins: string[] = [];
  try {
    const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: 2000 });
    copilotBins.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch {
    // not found
  }
  const wingetBin = resolveWingetCopilot?.();
  if (wingetBin && fs.existsSync(wingetBin)) {
    copilotBins.unshift(wingetBin);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const userProfile = process.env.USERPROFILE ?? "";
    const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(wingetBase)) {
        if (entry.startsWith("GitHub.Copilot")) {
          const exe = path.join(wingetBase, entry, "copilot.exe");
          if (fs.existsSync(exe)) copilotBins.unshift(exe);
        }
      }
    } catch {
      // skip
    }
    for (const root of [
      path.join(localAppData, "Programs", "Microsoft VS Code"),
      path.join(localAppData, "Programs", "Microsoft VS Code Insiders"),
      path.join(userProfile, ".vscode", "extensions")
    ]) {
      try {
        const extDir = path.join(root, "resources", "app", "extensions");
        if (!fs.existsSync(extDir)) continue;
        for (const entry of fs.readdirSync(extDir)) {
          if (!entry.startsWith("github.copilot-chat")) continue;
          for (const binName of ["copilot.exe", "copilot", "cli/copilot.exe"]) {
            const p = path.join(extDir, entry, "dist", binName);
            if (fs.existsSync(p)) copilotBins.push(p);
          }
        }
      } catch {
        // skip
      }
    }
    try {
      const vsDir = path.join(localAppData, "Microsoft", "VisualStudio");
      if (fs.existsSync(vsDir)) {
        for (const vsVer of fs.readdirSync(vsDir, { withFileTypes: true })) {
          if (!vsVer.isDirectory()) continue;
          const extRoot = path.join(vsDir, vsVer.name, "Extensions");
          if (!fs.existsSync(extRoot)) continue;
          for (const extId of fs.readdirSync(extRoot, { withFileTypes: true })) {
            if (!extId.isDirectory()) continue;
            const distDir = path.join(extRoot, extId.name, "service", "dist");
            if (!fs.existsSync(distDir)) continue;
            for (const f of fs.readdirSync(distDir)) {
              if (f.startsWith("copilot-agent") && f.endsWith(".exe")) {
                copilotBins.push(path.join(distDir, f));
              }
            }
          }
        }
      }
    } catch {
      // skip
    }
  }
  return copilotBins;
}

function detectMarvisAppIds(): string[] {
  const marvisAppIds = ["Tencent.Marvis"];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    for (const base of [appData, localAppData]) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().includes("marvis")) {
            marvisAppIds.push(entry.name);
          }
        }
      } catch {
        // skip
      }
    }
  }
  return marvisAppIds;
}

function readCopilotLoggedIn(copilotHome: string): boolean {
  try {
    const configPath = path.join(copilotHome, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/[^\n]*\n/gm, "");
      const cfg = JSON.parse(raw) as { loggedInUsers?: unknown[] };
      return Array.isArray(cfg.loggedInUsers) && cfg.loggedInUsers.length > 0;
    }
  } catch {
    // ignore
  }
  return false;
}

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectOptionsFromPaths(paths: string[]): AgentScanProject[] {
  const byNormalized = new Map<string, AgentScanProject>();
  for (const item of paths) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = normalizeComparablePath(trimmed);
    if (!normalized || byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, {
      label: path.basename(trimmed) || trimmed,
      path: trimmed,
      exists: fs.existsSync(trimmed)
    });
  }
  return [...byNormalized.values()];
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loginAstrbotDashboard(baseUrl: string, username: string, password: string): Promise<{ token?: string; message?: string }> {
  if (!password) {
    return { message: "缺少 AstrBot 密码。" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4200);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }
    if (!response.ok || body.status === "error" || body.error) {
      return { message: body.message || body.error || body.detail || `HTTP ${response.status}` };
    }
    return { token: body.data?.token, message: body.data?.token ? undefined : "登录响应缺少 token。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message.includes("abort") ? "登录请求超时。" : message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAstrbotJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const body = await response.json() as { status?: string; data?: T };
    if (body.status === "error") return null;
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function scanAstrbotViaDashboardApi(baseUrl: string, _username: string, token: string): Promise<AstrbotSessionScan> {
  type ProjectApiItem = { project_id?: string; title?: string; emoji?: string; updated_at?: string };
  type SessionApiItem = { session_id?: string; platform_id?: string; display_name?: string; updated_at?: string };
  const projectsRaw = await fetchAstrbotJson<ProjectApiItem[]>(`${baseUrl}/api/chatui_project/list`, token);
  const sessionsRaw = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chat/sessions?platform_id=webchat`, token);
  if (!projectsRaw && !sessionsRaw) {
    return { authVerified: true, projects: [], sessions: [], source: "none", authMessage: "已登录，但未读取到项目/会话 API。" };
  }
  const projects: AgentScanProject[] = (projectsRaw ?? []).map((project) => {
    const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
    const pathValue = project.title || label;
    return {
      id: project.project_id,
      label,
      path: pathValue,
      exists: pathValue ? fs.existsSync(pathValue) : false
    };
  });
  const sessions: AgentScanSession[] = (sessionsRaw ?? []).map((session) => ({
    id: session.session_id,
    name: session.display_name || session.session_id || "未命名会话",
    updatedAt: session.updated_at
  }));
  for (const project of projectsRaw ?? []) {
    if (!project.project_id) continue;
    const projectSessions = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chatui_project/get_sessions?project_id=${encodeURIComponent(project.project_id)}`, token);
    for (const session of projectSessions ?? []) {
      const existing = sessions.find((item) => item.id === session.session_id);
      if (existing) {
        existing.projectId = project.project_id;
        existing.projectPath = project.title;
      } else {
        sessions.push({
          id: session.session_id,
          name: session.display_name || session.session_id || "未命名会话",
          projectId: project.project_id,
          projectPath: project.title,
          updatedAt: session.updated_at
        });
      }
    }
  }
  return { authVerified: true, projects, sessions, source: "api", authMessage: `已通过 Dashboard API 读取 ${projects.length} 个项目、${sessions.length} 个会话。` };
}

async function scanAstrbotLocalDb(): Promise<Pick<AstrbotSessionScan, "projects" | "sessions" | "source">> {
  const dbPath = path.join(os.homedir(), ".astrbot", "data", "data_v4.db");
  if (!fs.existsSync(dbPath)) {
    return { projects: [], sessions: [], source: "none" };
  }
  const pyCandidates = [
    "py",
    "python",
    path.join(process.env.LOCALAPPDATA ?? "", "AstrBot", "backend", "python", "python.exe")
  ].filter(Boolean);
  const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
projects = [dict(r) for r in con.execute("select project_id, title, emoji, updated_at from chatui_projects order by updated_at desc limit 100")]
sessions = [dict(r) for r in con.execute("""select s.session_id, s.display_name, s.updated_at, p.project_id, p.title as project_title
from platform_sessions s
left join session_project_relations rel on rel.session_id=s.session_id
left join chatui_projects p on p.project_id=rel.project_id
where s.platform_id='webchat'
order by s.updated_at desc limit 200""")]
print(json.dumps({"projects": projects, "sessions": sessions}, ensure_ascii=False))
con.close()
`.trim();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const py of pyCandidates) {
    try {
      const args = path.basename(py).toLowerCase() === "py"
        ? ["-3", "-c", script, dbPath]
        : ["-c", script, dbPath];
      const { stdout } = await execFileAsync(py, args, {
        timeout: 3000,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" }
      });
      const parsed = JSON.parse(stdout) as {
        projects?: Array<{ project_id?: string; title?: string; emoji?: string; updated_at?: string }>;
        sessions?: Array<{ session_id?: string; display_name?: string; updated_at?: string; project_id?: string; project_title?: string }>;
      };
      const projects: AgentScanProject[] = (parsed.projects ?? []).map((project) => {
        const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
        const pathValue = project.title || label;
        return {
          id: project.project_id,
          label,
          path: pathValue,
          exists: pathValue ? fs.existsSync(pathValue) : false
        };
      });
      const sessions: AgentScanSession[] = (parsed.sessions ?? []).map((session) => ({
        id: session.session_id,
        name: session.display_name || session.session_id || "未命名会话",
        projectId: session.project_id,
        projectPath: session.project_title,
        updatedAt: session.updated_at
      }));
      return { projects, sessions, source: "local-db" };
    } catch {
      // try next interpreter
    }
  }
  return { projects: [], sessions: [], source: "none" };
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function openUrlWithDefaultApp(url: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}
