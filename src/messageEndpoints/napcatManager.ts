import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { NapcatState, NapcatLifecycleError, type NapcatLoginInfo, type NapcatHealthSnapshot, type NapcatLoginPanelData } from "../shared/napcatStateContract.js";
import { KeyedAsyncLock } from "../shared/keyedAsyncLock.js";
import { NapcatWebuiSessions, type NapcatWebuiSession } from "./napcatWebuiSession.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const execFileAsync = promisify(execFile);
const napcatLifecycleLock = new KeyedAsyncLock();

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  autoLoginOnRabiStart?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
};

type GatewayDefinition = {
  id: string;
  enabled?: boolean;
  messageAdapterType?: string;
  messageAdapters?: string[];
  messageAdaptersDisabled?: string[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: Record<string, { inputEnabled?: boolean }>;
  gatewayPort: number;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
};

type GatewayRuntime = {
  definition: GatewayDefinition;
  process?: unknown;
  status?: Record<string, unknown>;
};

type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

type MessageAdapterScanResult = {
  type: "napcat";
  label: string;
  maturity: "verified";
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: Array<{
    id: string;
    label: string;
    required?: boolean;
    ok?: boolean;
    detail?: string;
    actionLabel?: string;
    url?: string;
    path?: string;
  }>;
  warnings?: string[];
};

export type NapcatManagerContext = {
  rootDir: string;
  getRuntimes(): Iterable<GatewayRuntime>;
  normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[];
  appendLog(runtime: GatewayRuntime, line: string): void;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
  launchNapcatProcess?(plan: NapcatLaunchPlan, visible: boolean, request: NapcatLaunchRequest): ChildProcess | void | Promise<ChildProcess | void>;
  runBindingOperation?<T>(request: NapcatLaunchRequest, operation: () => Promise<T>): Promise<T>;
  stopOwnedInstance?(request: NapcatStopRequest): Promise<void>;
  stopOwnedInstanceForRestart?(request: NapcatLaunchRequest): Promise<void>;
  recordNapcatLaunchPids?(request: NapcatLaunchRequest, pids: readonly string[]): void | Promise<void>;
  /** Test seam; production uses the scoped port / command-line lookup below. */
  findNapcatInstanceProcessPids?(instance: NapCatInstanceDefinition, ports: number[]): Promise<string[]>;
};

export type NapcatHealthRequest = {
  gatewayId?: string;
  instanceId?: string;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  gatewayPort?: number;
  readWebuiLoginInfo?: boolean;
  inspectProcesses?: boolean;
  botUserId?: string | number;
  botNickname?: string;
};

type NapcatConfigureRequest = NapcatHealthRequest;

type NapcatWebuiTokenInfo = {
  found: boolean;
  token?: string;
  tokenLength?: number;
  configPath?: string;
  configPort?: number;
  correctedWebuiUrl?: string;
  loginUrl?: string;
  message?: string;
  source?: "provided" | "config";
};

export type NapcatLaunchRequest = {
  gatewayId?: string;
  instanceId?: string;
  forceRestart?: boolean;
  visible?: boolean;
};

export type NapcatLoginPanelRequest = Pick<NapcatLaunchRequest, "gatewayId" | "instanceId">;

type NapcatLoginActionBase = NapcatLoginPanelRequest & {
  userId?: string;
};

export type NapcatLoginActionRequest = NapcatLoginActionBase & (
  | { action: "quick-login" }
  | { action: "refresh-qr" }
  | { action: "password-login"; password?: string }
  | { action: "captcha-login"; password?: string; ticket?: string; randstr?: string; sid?: string }
  | { action: "new-device-login"; password?: string; newDevicePullQrCodeSig?: string }
  | { action: "new-device-qr"; jumpUrl?: string }
  | { action: "new-device-poll"; bytesToken?: string }
);

type NapcatEnsureReadyRequest = NapcatLaunchRequest;

export type NapcatLaunchPlan = {
  command: string;
  cwd: string;
  commandPath: string;
  args: string[];
  commandLine: string;
  redirectedFromOuterShell: boolean;
  botUserId?: string;
  warnings: string[];
};

export type NapcatStopRequest = {
  gatewayId?: string;
  instanceId?: string;
  name?: string;
  gatewayPort?: number;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
};

type ManagedNapcatPrepareRequest = {
  id: string;
  name: string;
  index: number;
  gatewayPort: number;
  httpPort: number;
  webuiPort: number;
};

type ManagedNapcatPrepareResult = {
  instance: NapCatInstanceDefinition;
  steps: string[];
};

type NapcatOneBotResponse<T> = {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: T;
};

type NapcatWebuiResponse<T> = {
  code?: number;
  message?: string;
  data?: T;
};

const napcatWebuiSessions = new NapcatWebuiSessions();

type NapcatAccountOwner = {
  userId: string;
  nickname?: string;
  httpUrl: string;
  webuiUrl?: string;
  workingDir?: string;
  configPath?: string;
  gatewayId?: string;
  instanceId?: string;
  instanceName?: string;
  source: "configured" | "discovered";
  online?: boolean;
  good?: boolean;
  websocketUrls: string[];
  routesToGateway: boolean;
};

type NapcatAccountProbeCandidate = Omit<NapcatAccountOwner, "userId" | "nickname" | "online" | "good" | "routesToGateway"> & {
  accessToken?: string;
};

type NapcatEnsureHealth = Record<string, unknown> & {
  ok?: boolean;
  message?: string;
  loginState?: NapcatState;
  accountOwner?: NapcatAccountOwner;
  http?: { ok?: boolean; userId?: string | number; nickname?: string };
  loginInfo?: NapcatLoginInfo;
  webui?: NapcatWebuiTokenInfo & {
    url?: string;
    reachable?: boolean;
    loginInfo?: NapcatLoginInfo | null;
  };
};

type NapcatOneBotNetworkConfig = {
  network?: {
    httpServers?: Array<Record<string, unknown>>;
    httpSseServers?: Array<Record<string, unknown>>;
    httpClients?: Array<Record<string, unknown>>;
    websocketServers?: Array<Record<string, unknown>>;
    websocketClients?: Array<Record<string, unknown>>;
    plugins?: Array<Record<string, unknown>>;
  };
};

type NormalizedNapcatOneBotNetworkConfig = {
  network: {
    httpServers: Array<Record<string, unknown>>;
    httpSseServers: Array<Record<string, unknown>>;
    httpClients: Array<Record<string, unknown>>;
    websocketServers: Array<Record<string, unknown>>;
    websocketClients: Array<Record<string, unknown>>;
    plugins: Array<Record<string, unknown>>;
  };
};

async function detectNapcatProcesses(): Promise<Array<{ name: string; pid: string }>> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Where-Object {",
      "  $_.Name -match '^(NapCat|QQ|QQNT)' -or ($_.CommandLine -and $_.CommandLine -match '(?i)napcat')",
      "} |",
      "ForEach-Object { \"$($_.Name)`t$($_.ProcessId)\" }"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 3000 });
    return String(stdout).split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, pid] = line.split("\t");
        return { name, pid };
      })
      .filter((item) => Boolean(item.name && item.pid));
  } catch {
    return [];
  }
}

function portFromUrl(value: string | undefined): number {
  try {
    return Number(new URL(value || "").port || 0);
  } catch {
    return 0;
  }
}

function localUrl(port: number, pathname = ""): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function localWebuiUrlWithPort(webuiUrl: string, port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return "";
  try {
    const parsed = new URL(webuiUrl || localUrl(port, "/webui"));
    const host = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return "";
    parsed.port = String(port);
    if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/webui";
    return parsed.toString();
  } catch {
    return localUrl(port, "/webui");
  }
}

function commandLineQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function resolveCommandPath(commandPath: string, cwd: string): string {
  if (path.isAbsolute(commandPath)) return path.resolve(commandPath);
  if (commandPath.includes("\\") || commandPath.includes("/")) return path.resolve(cwd, commandPath);
  return path.resolve(cwd, commandPath);
}

function findInnerNapcatLauncher(shellDir: string): string | null {
  const direct = path.join(shellDir, "launcher-user.bat");
  if (fs.existsSync(direct)) return direct;

  const versionsDir = path.join(shellDir, "versions");
  try {
    if (!fs.existsSync(versionsDir)) return null;
    const candidates: Array<{ file: string; mtimeMs: number }> = [];
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(versionsDir, entry.name, "resources", "app", "napcat", "launcher-user.bat");
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      candidates.push({ file, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
    return candidates[0]?.file ?? null;
  } catch {
    return null;
  }
}

function commandHasQuickLoginArg(args: string[]): boolean {
  return args.some((arg) => arg === "-q" || arg === "--quick-login" || arg === "--uin");
}

function normalizeQuickLoginArgs(args: string[], botUserId: string): string[] {
  if (!botUserId || commandHasQuickLoginArg(args)) return args;
  return ["-q", botUserId, ...args.filter((arg) => arg !== botUserId)];
}

export function resolveNapcatLaunchPlan(instance: NapCatInstanceDefinition, rootDir: string): NapcatLaunchPlan {
  const command = instance.launchCommand?.trim();
  if (!command) {
    throw new Error("这个 NapCat 实例还没有填写启动命令。");
  }
  const cwd = path.resolve(rootDir, instance.workingDir?.trim() || ".");
  const parts = splitCommandLine(command);
  const commandPath = resolveCommandPath(parts[0] || command, cwd);
  const args = parts.slice(1);
  const innerLauncher = findInnerNapcatLauncher(cwd);
  const commandBase = path.basename(commandPath).toLowerCase();
  const outerShellDetected = Boolean(innerLauncher)
    && (commandBase === "napcat.bat"
      || commandBase === "napcatwinbootmain.exe");
  const warnings: string[] = [];
  const botUserId = String(instance.botUserId || "").trim();
  let resolvedPath = commandPath;
  let resolvedArgs = [...args];
  const bundledLauncher = path.join(cwd, "NapCatWinBootMain.exe");
  const bundledQq = path.join(cwd, "QQ.exe");
  const useBundledQq = outerShellDetected && fs.existsSync(bundledLauncher) && fs.existsSync(bundledQq);
  if (useBundledQq) {
    resolvedPath = bundledLauncher;
    // The outer OneKey launcher takes the QQ number as a positional argument.
    resolvedArgs = botUserId ? [botUserId] : [];
  } else if (outerShellDetected && innerLauncher) {
    resolvedPath = innerLauncher;
    if (botUserId) {
      resolvedArgs = normalizeQuickLoginArgs(resolvedArgs, botUserId);
    } else if (!botUserId) {
      warnings.push("已识别外层 NapCat Shell 并切到内层 launcher-user.bat，但实例缺少 botUserId，无法自动追加 -q。");
    }
  } else if (botUserId && path.basename(resolvedPath).toLowerCase() === "launcher-user.bat") {
    resolvedArgs = normalizeQuickLoginArgs(resolvedArgs, botUserId);
  }
  const launcherBasename = path.basename(resolvedPath).toLowerCase();
  const launchCwd = launcherBasename === "launcher-user.bat"
    || launcherBasename === "launcher-win10-user.bat"
    || launcherBasename === "napcatwinbootmain.exe"
    ? path.dirname(resolvedPath)
    : cwd;
  const commandLine = [resolvedPath, ...resolvedArgs].map(commandLineQuote).join(" ");
  return {
    command,
    cwd: launchCwd,
    commandPath: resolvedPath,
    args: resolvedArgs,
    commandLine,
    redirectedFromOuterShell: outerShellDetected && !useBundledQq,
    botUserId: botUserId || undefined,
    warnings
  };
}

export function launchNapcatProcess(plan: NapcatLaunchPlan, _visible = false): ChildProcess {
  if (process.platform === "win32") {
    const commandExt = path.extname(plan.commandPath).toLowerCase();
    const child = commandExt === ".bat" || commandExt === ".cmd"
      ? spawn("cmd.exe", ["/d", "/c", plan.commandPath, ...plan.args], {
          cwd: plan.cwd,
          detached: true,
          stdio: "ignore",
          windowsHide: true
        })
      : spawn(plan.commandPath, plan.args, {
          cwd: plan.cwd,
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
    child.unref();
    return child;
  }
  const child = spawn(plan.commandLine, [], {
    cwd: plan.cwd,
    detached: true,
    shell: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

function newToken(): string {
  return randomBytes(8).toString("hex");
}

function candidateNapcatShellDirs(rootDir: string): string[] {
  const bases = [
    path.resolve(rootDir, "..", "NapCat"),
    path.resolve(rootDir, "..", "tools", "NapCat"),
    path.resolve(rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat"),
    path.resolve(os.homedir(), "AppData", "Local", "NapCat")
  ];
  const candidates: string[] = [];
  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        if (fs.existsSync(path.join(dir, "napcat.bat")) || fs.existsSync(path.join(dir, "NapCatWinBootMain.exe"))) {
          candidates.push(dir);
        }
      }
      if (fs.existsSync(path.join(base, "napcat.bat")) || fs.existsSync(path.join(base, "NapCatWinBootMain.exe"))) {
        candidates.push(base);
      }
    } catch {
      // Ignore inaccessible template roots.
    }
  }
  return [...new Set(candidates)];
}

function candidateNapcatShellZips(rootDir: string): string[] {
  const bases = [
    path.resolve(rootDir, "..", "NapCat"),
    path.resolve(rootDir, "..", "tools", "NapCat"),
    path.resolve(rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat")
  ];
  const zips: string[] = [];
  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isFile() && /NapCat.*Shell.*\.zip$/i.test(entry.name)) {
          zips.push(path.join(base, entry.name));
        }
      }
    } catch {
      // Ignore inaccessible template roots.
    }
  }
  return zips;
}

const napcatConfigDirCache = new Map<string, string>();

function findNapcatConfigDir(shellDir: string): string | null {
  const resolvedShellDir = path.resolve(shellDir);
  const cached = napcatConfigDirCache.get(resolvedShellDir);
  if (cached && fs.existsSync(cached)) return cached;
  const direct = [
    path.join(resolvedShellDir, "napcat", "config"),
    path.join(resolvedShellDir, "config")
  ];
  for (const item of direct) {
    if (fs.existsSync(item)) {
      napcatConfigDirCache.set(resolvedShellDir, item);
      return item;
    }
  }
  const versionRoots = [
    path.join(resolvedShellDir, "versions"),
    path.join(resolvedShellDir, "NapCat.Shell", "versions")
  ];
  for (const versionsDir of versionRoots) {
    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const item = path.join(versionsDir, entry.name, "resources", "app", "napcat", "config");
        if (fs.existsSync(item)) {
          napcatConfigDirCache.set(resolvedShellDir, item);
          return item;
        }
      }
    } catch {
      // Fall through to the bounded compatibility scan.
    }
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: resolvedShellDir, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 8) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (current.dir.replace(/\\/g, "/").endsWith("/resources/app/napcat/config")) {
      napcatConfigDirCache.set(resolvedShellDir, current.dir);
      return current.dir;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["node_modules", "static", "plugins"].includes(entry.name.toLowerCase())) continue;
      stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

function copyOrExtractNapcatTemplate(rootDir: string, targetDir: string): { workingDir: string; steps: string[] } {
  const steps: string[] = ["正在获取 NapCat 目录..."];
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  if (fs.existsSync(targetDir)) {
    const existingConfigDir = findNapcatConfigDir(targetDir);
    if (existingConfigDir) {
      steps.push(`复用已存在目录：${targetDir}`);
      return { workingDir: targetDir, steps };
    }
    const sourceDir = candidateNapcatShellDirs(rootDir)
      .filter((dir) => Boolean(findNapcatConfigDir(dir)))
      .find((dir) => path.resolve(dir).toLowerCase() !== path.resolve(targetDir).toLowerCase());
    if (sourceDir) {
      steps.push(`修复未完整的 NapCat Shell 目录：${targetDir}`);
      steps.push(`补齐 NapCat Shell：${sourceDir}`);
      fs.cpSync(sourceDir, targetDir, {
        recursive: true,
        force: true,
        errorOnExist: false
      });
      const repairedConfigDir = findNapcatConfigDir(targetDir);
      if (repairedConfigDir) return { workingDir: targetDir, steps };
    }
    throw new Error(`获取 NapCat 目录失败：${targetDir} 不完整，且未找到可用于修复的完整 NapCat Shell 模板。`);
  }

  const sourceDir = candidateNapcatShellDirs(rootDir).find((dir) => Boolean(findNapcatConfigDir(dir)));
  if (sourceDir) {
    steps.push(`复制 NapCat Shell：${sourceDir}`);
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return { workingDir: targetDir, steps };
  }

  const sourceZip = candidateNapcatShellZips(rootDir)[0];
  if (sourceZip && process.platform === "win32") {
    steps.push(`解压 NapCat Shell：${sourceZip}`);
    fs.mkdirSync(targetDir, { recursive: true });
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      sourceZip,
      targetDir
    ], { stdio: "ignore" });
    const nested = candidateNapcatShellDirs(targetDir).find((dir) => path.resolve(dir).startsWith(path.resolve(targetDir)));
    return { workingDir: nested || targetDir, steps };
  }

  throw new Error("获取 NapCat 目录失败：未找到可用的 NapCat Shell 模板目录或 NapCat.Shell.zip。");
}

function writeManagedNapcatConfigs(instance: NapCatInstanceDefinition): { steps: string[]; webuiToken: string } {
  const steps = ["正在写入实例配置..."];
  const workingDir = instance.workingDir?.trim();
  if (!workingDir) throw new Error("写入实例配置失败：缺少 NapCat 工作目录。");
  const configDir = findNapcatConfigDir(workingDir);
  if (!configDir) throw new Error(`写入实例配置失败：未在 ${workingDir} 找到 napcat/config 目录。`);
  fs.mkdirSync(configDir, { recursive: true });

  const webuiPath = path.join(configDir, "webui.json");
  const existingWebui = fs.existsSync(webuiPath)
    ? JSON.parse(fs.readFileSync(webuiPath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const webuiPort = portFromUrl(instance.webuiUrl) || 6099;
  const webuiToken = newToken();
  fs.writeFileSync(webuiPath, JSON.stringify({
    ...existingWebui,
    host: existingWebui.host || "::",
    port: webuiPort,
    token: webuiToken,
    disableWebUI: false
  }, null, 2), "utf8");
  steps.push(`WebUI 端口：${webuiPort}`);

  const httpPort = portFromUrl(instance.httpUrl) || 3000;
  const wsUrl = `ws://127.0.0.1:${instance.gatewayPort}`;
  const onebotPath = path.join(configDir, `onebot11_rabiroute_${instance.id}.json`);
  fs.writeFileSync(onebotPath, JSON.stringify({
    network: {
      httpServers: [{
        enable: true,
        name: "RabiRoute HTTP",
        host: "127.0.0.1",
        port: httpPort,
        enableCors: true,
        enableWebsocket: false,
        messagePostFormat: "array",
        token: instance.accessToken || "",
        debug: false
      }],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [{
        enable: true,
        name: "RabiRoute",
        url: wsUrl,
        reportSelfMessage: false,
        messagePostFormat: "array",
        token: "",
        debug: false,
        heartInterval: 30000,
        reconnectInterval: 30000,
        verifyCertificate: true
      }],
      plugins: []
    }
  }, null, 2), "utf8");
  recordDataMutationAudit({
    group: "napcat",
    event: "napcat_instance_configs_written",
    owner: "napcat-manager",
    action: "configure-instance",
    target: { type: "napcat-instance", id: instance.id },
    dataSource: { kind: "file", id: "napcat/config" },
    outcome: "committed",
    changes: [
      { field: "webuiPort", to: webuiPort },
      { field: "httpPort", to: httpPort },
      { field: "gatewayPort", to: instance.gatewayPort }
    ]
  });
  steps.push(`HTTP 端口：${httpPort}`);
  steps.push(`WS 地址：${wsUrl}`);
  return {
    steps,
    webuiToken
  };
}

export function prepareManagedNapcatInstance(ctx: NapcatManagerContext, request: ManagedNapcatPrepareRequest): ManagedNapcatPrepareResult {
  const targetDir = path.join(ctx.rootDir, "data", "napcat", request.id, "NapCat.Shell");
  const prepared = copyOrExtractNapcatTemplate(ctx.rootDir, targetDir);
  const instance: NapCatInstanceDefinition = {
    id: request.id,
    name: request.name,
    enabled: true,
    autoLoginOnRabiStart: true,
    gatewayPort: request.gatewayPort,
    httpUrl: localUrl(request.httpPort),
    webuiUrl: localUrl(request.webuiPort, "/webui"),
    accessToken: "",
    webuiToken: "",
    launchCommand: "napcat.bat",
    workingDir: prepared.workingDir
  };
  const written = writeManagedNapcatConfigs(instance);
  instance.webuiToken = written.webuiToken;
  recordDataMutationAudit({
    group: "napcat",
    event: "napcat_instance_prepared",
    owner: "napcat-manager",
    action: "prepare-instance",
    target: { type: "napcat-instance", id: instance.id },
    dataSource: { kind: "file", id: `data/napcat/${instance.id}` },
    outcome: "committed"
  });
  return {
    instance,
    steps: [...prepared.steps, ...written.steps]
  };
}

async function portIsFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function nextFreeLocalPort(preferred: number, used = new Set<number>()): Promise<number> {
  let port = Number.isInteger(preferred) && preferred > 0 ? preferred : 3000;
  while (port <= 65535) {
    if (!used.has(port) && await portIsFree(port)) {
      used.add(port);
      return port;
    }
    port += 1;
  }
  throw new Error("没有可用端口了。");
}

async function listeningPidsForPorts(ports: number[]): Promise<string[]> {
  const wanted = new Set(ports.filter((port) => Number.isInteger(port) && port > 0).map(String));
  if (wanted.size === 0 || process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 3000 });
    const pids = new Set<string>();
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = parts[parts.length - 1] || "";
      const match = local.match(/:(\d+)$/);
      if (match && wanted.has(match[1]) && /^\d+$/.test(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function napcatWebuiLoginUrl(webuiUrl: string, token: string): string {
  try {
    const parsed = new URL(webuiUrl);
    if (/\/webui$/i.test(parsed.pathname)) parsed.pathname += "/";
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const hashIndex = webuiUrl.indexOf("#");
    const base = hashIndex >= 0 ? webuiUrl.slice(0, hashIndex) : webuiUrl;
    const fragment = hashIndex >= 0 ? webuiUrl.slice(hashIndex) : "";
    const normalizedBase = base.replace(/\/webui(?=\?|$)/i, "/webui/");
    const separator = normalizedBase.includes("?") ? "&" : "?";
    return `${normalizedBase}${separator}token=${encodeURIComponent(token)}${fragment}`;
  }
}

function addNapcatWebuiConfigCandidate(candidates: Set<string>, candidate: string | undefined): void {
  const value = candidate?.trim();
  if (!value) return;
  candidates.add(path.resolve(value));
}

function runBoundNapcatOperation<T>(ctx: NapcatManagerContext, request: NapcatLaunchRequest, operation: () => Promise<T>): Promise<T> {
  const runtime = [...ctx.getRuntimes()].find(item => item.definition.id === request.gatewayId);
  const instance = runtime && napcatInstancesFor(ctx, runtime).find(item => item.id === request.instanceId);
  if (!runtime || runtime.definition.enabled === false || !runtimeUsesNapcat(runtime.definition) || !instance || instance.enabled === false) {
    return Promise.reject(new NapcatLifecycleError(NapcatState.Unbound, "NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。"));
  }
  return ctx.runBindingOperation ? ctx.runBindingOperation(request, operation) : operation();
}

function runtimeUsesNapcat(definition: GatewayDefinition): boolean {
  if (definition.messageInputsDisabled) return false;
  if (definition.messageAdaptersDisabled?.includes("napcat")) return false;
  if (definition.messageAdapterPolicies?.napcat?.inputEnabled === false) return false;
  const adapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  return adapters.includes("napcat");
}

function napcatInstancesFor(ctx: NapcatManagerContext, runtime: GatewayRuntime): NapCatInstanceDefinition[] {
  return runtime.definition.napcatInstances ?? ctx.normalizeNapCatInstances(runtime.definition);
}

function napcatRuntimes(ctx: NapcatManagerContext): GatewayRuntime[] {
  return [...ctx.getRuntimes()].filter((runtime) => runtimeUsesNapcat(runtime.definition));
}

function addNapcatWebuiConfigCandidatesForInstance(candidates: Set<string>, ctx: NapcatManagerContext, instance: NapCatInstanceDefinition): void {
  const workingDir = instance.workingDir?.trim();
  if (workingDir) {
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "napcat", "config", "webui.json"));
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "config", "webui.json"));
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "webui.json"));
    const nestedConfigDir = findNapcatConfigDir(workingDir);
    if (nestedConfigDir) {
      addNapcatWebuiConfigCandidate(candidates, path.join(nestedConfigDir, "webui.json"));
    }
  }
  const launchCommand = instance.launchCommand?.trim();
  if (launchCommand) {
    const commandPath = launchCommand.match(/^"([^"]+)"/)?.[1] || launchCommand.split(/\s+/)[0];
    if (commandPath && (commandPath.includes("\\") || commandPath.includes("/"))) {
      const commandDir = path.dirname(path.resolve(workingDir || ctx.rootDir, commandPath));
      addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "napcat", "config", "webui.json"));
      addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "config", "webui.json"));
    }
  }
}

function napcatWebuiConfigCandidates(ctx: NapcatManagerContext, preferredInstances: NapCatInstanceDefinition[] = []): string[] {
  const candidates = new Set<string>();
  addNapcatWebuiConfigCandidate(candidates, process.env.NAPCAT_WEBUI_CONFIG);
  if (process.env.NAPCAT_CONFIG_DIR) {
    addNapcatWebuiConfigCandidate(candidates, path.join(process.env.NAPCAT_CONFIG_DIR, "webui.json"));
  }

  for (const instance of preferredInstances) {
    addNapcatWebuiConfigCandidatesForInstance(candidates, ctx, instance);
  }

  for (const runtime of ctx.getRuntimes()) {
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      addNapcatWebuiConfigCandidatesForInstance(candidates, ctx, instance);
    }
  }

  const searchRoots = [
    path.resolve(ctx.rootDir, "data", "napcat"),
    path.resolve(ctx.rootDir, "..", "NapCat"),
    path.resolve(ctx.rootDir, "..", "tools", "NapCat"),
    path.resolve(ctx.rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat"),
    path.resolve(os.homedir(), "AppData", "Local", "NapCat")
  ];
  for (const base of searchRoots) {
    try {
      if (!fs.existsSync(base)) continue;
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "napcat", "config", "webui.json"));
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "config", "webui.json"));
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "NapCat.Shell", "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "NapCat.Shell", "config", "webui.json"));
        const nestedConfigDir = findNapcatConfigDir(dir);
        if (nestedConfigDir) {
          addNapcatWebuiConfigCandidate(candidates, path.join(nestedConfigDir, "webui.json"));
        }
      }
    } catch {
      // Ignore inaccessible candidate roots.
    }
  }

  return [...candidates].filter((candidate) => fs.existsSync(candidate));
}

function normalizeLocalEndpoint(url: string | undefined): string {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const hostname = ["localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())
      ? "127.0.0.1"
      : parsed.hostname;
    return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/+$/, "").toLowerCase();
  }
}

function readWebuiConfigSummary(configPath: string): { webuiUrl?: string; token?: string; workingDir?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as {
      port?: unknown;
      token?: unknown;
      disableWebUI?: unknown;
    };
    const port = Number(parsed.port || 0);
    const token = String(parsed.token || "").trim();
    const configDir = path.dirname(configPath);
    const napcatDir = path.dirname(configDir);
    const workingDir = path.dirname(napcatDir);
    return {
      ...(port > 0 && parsed.disableWebUI !== true ? { webuiUrl: localUrl(port, "/webui") } : {}),
      ...(token ? { token } : {}),
      workingDir
    };
  } catch {
    return {};
  }
}

function addNapcatAccountProbeCandidate(
  candidates: Map<string, NapcatAccountProbeCandidate>,
  candidate: NapcatAccountProbeCandidate
): void {
  const key = normalizeLocalEndpoint(candidate.httpUrl);
  if (!key) return;
  const current = candidates.get(key);
  if (!current) {
    candidates.set(key, candidate);
    return;
  }
  candidates.set(key, {
    ...candidate,
    ...current,
    websocketUrls: [...new Set([...(current.websocketUrls || []), ...(candidate.websocketUrls || [])])],
    source: current.source === "configured" || candidate.source === "configured" ? "configured" : "discovered"
  });
}

function napcatNetworkEndpoints(config: NormalizedNapcatOneBotNetworkConfig | null): {
  httpServers: Array<{ port: number; token?: string }>;
  websocketUrls: string[];
} {
  if (!config) return { httpServers: [], websocketUrls: [] };
  const httpServers = config.network.httpServers
    .filter(isEnabledConfigItem)
    .map((item) => ({
      port: Number(item.port || 0),
      token: String(item.token || "").trim() || undefined
    }))
    .filter((item) => Number.isInteger(item.port) && item.port > 0 && item.port <= 65535);
  const websocketUrls = config.network.websocketClients
    .filter(isEnabledConfigItem)
    .map((item) => String(item.url || "").trim())
    .filter(Boolean);
  return { httpServers, websocketUrls };
}

function napcatAccountProbeCandidates(
  ctx: NapcatManagerContext,
  userId: string
): NapcatAccountProbeCandidate[] {
  const candidates = new Map<string, NapcatAccountProbeCandidate>();
  for (const runtime of napcatRuntimes(ctx)) {
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      const configuredUserId = String(instance.botUserId || "").trim();
      if (configuredUserId && configuredUserId !== userId) continue;
      const configPath = instance.webuiUrl
        ? readNapcatWebuiToken(ctx, instance.webuiUrl, instance.webuiToken, [instance]).configPath
        : undefined;
      const onebotPath = onebotConfigPathForWebuiConfig(configPath, userId);
      const endpoints = napcatNetworkEndpoints(readOneBotNetworkConfig(onebotPath));
      addNapcatAccountProbeCandidate(candidates, {
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        workingDir: instance.workingDir,
        configPath: onebotPath || undefined,
        gatewayId: runtime.definition.id,
        instanceId: instance.id,
        instanceName: instance.name,
        source: "configured",
        accessToken: instance.accessToken,
        websocketUrls: endpoints.websocketUrls
      });
    }
  }

  for (const webuiConfigPath of napcatWebuiConfigCandidates(ctx)) {
    const webui = readWebuiConfigSummary(webuiConfigPath);
    const configDir = path.dirname(webuiConfigPath);
    for (const filename of [`onebot11_${userId}.json`, `napcat_protocol_${userId}.json`]) {
      const configPath = path.join(configDir, filename);
      if (!fs.existsSync(configPath)) continue;
      const endpoints = napcatNetworkEndpoints(readOneBotNetworkConfig(configPath));
      for (const server of endpoints.httpServers) {
        addNapcatAccountProbeCandidate(candidates, {
          httpUrl: localUrl(server.port),
          webuiUrl: webui.webuiUrl,
          workingDir: webui.workingDir,
          configPath,
          source: "discovered",
          accessToken: server.token,
          websocketUrls: endpoints.websocketUrls
        });
      }
    }
  }
  return [...candidates.values()];
}

async function fetchNapcatOneBotAction<T>(
  httpUrl: string,
  action: string,
  accessToken?: string,
  timeoutMs = 1500
): Promise<NapcatOneBotResponse<T> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (accessToken?.trim()) headers.authorization = `Bearer ${accessToken.trim()}`;
  try {
    const response = await fetch(`${httpUrl.replace(/\/+$/, "")}/${action}`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({})) as NapcatOneBotResponse<T>;
    if (!response.ok || (body.retcode != null && body.retcode !== 0) || body.status === "failed") return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findNapcatAccountOwner(
  ctx: NapcatManagerContext,
  userId: string,
  target: NapCatInstanceDefinition
): Promise<NapcatAccountOwner | null> {
  if (!userId) return null;
  const targetHttp = normalizeLocalEndpoint(target.httpUrl);
  const targetWebui = normalizeLocalEndpoint(target.webuiUrl);
  const gatewayUrl = `ws://127.0.0.1:${target.gatewayPort}`;
  const probes = napcatAccountProbeCandidates(ctx, userId)
    .filter((candidate) => {
      const sameHttp = normalizeLocalEndpoint(candidate.httpUrl) === targetHttp;
      const sameWebui = candidate.webuiUrl && normalizeLocalEndpoint(candidate.webuiUrl) === targetWebui;
      return !sameHttp && !sameWebui;
    })
    .slice(0, 24);
  const results = await Promise.all(probes.map(async (candidate): Promise<NapcatAccountOwner | null> => {
    const [status, login] = await Promise.all([
      fetchNapcatOneBotAction<{ online?: boolean; good?: boolean }>(candidate.httpUrl, "get_status", candidate.accessToken),
      fetchNapcatOneBotAction<{ user_id?: string | number; nickname?: string }>(candidate.httpUrl, "get_login_info", candidate.accessToken)
    ]);
    const actualUserId = String(login?.data?.user_id || "").trim();
    if (!actualUserId || actualUserId !== userId) return null;
    if (status?.data?.online === false || status?.data?.good === false) return null;
    return {
      userId: actualUserId,
      nickname: login?.data?.nickname,
      httpUrl: candidate.httpUrl,
      webuiUrl: candidate.webuiUrl,
      workingDir: candidate.workingDir,
      configPath: candidate.configPath,
      gatewayId: candidate.gatewayId,
      instanceId: candidate.instanceId,
      instanceName: candidate.instanceName,
      source: candidate.source,
      online: status?.data?.online,
      good: status?.data?.good,
      websocketUrls: candidate.websocketUrls,
      routesToGateway: candidate.websocketUrls.includes(gatewayUrl)
    };
  }));
  return results
    .filter((owner): owner is NapcatAccountOwner => Boolean(owner))
    .sort((left, right) =>
      Number(right.routesToGateway) - Number(left.routesToGateway)
      || Number(right.source === "configured") - Number(left.source === "configured")
    )[0] ?? null;
}

function preferredNapcatInstancesForHealth(ctx: NapcatManagerContext, request: NapcatHealthRequest): NapCatInstanceDefinition[] {
  const result: NapCatInstanceDefinition[] = [];
  for (const runtime of ctx.getRuntimes()) {
    if (request.gatewayId && runtime.definition.id !== request.gatewayId) continue;
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      const matchesInstanceId = request.instanceId && instance.id === request.instanceId;
      const matchesHttp = request.httpUrl && instance.httpUrl === request.httpUrl;
      const matchesWebui = request.webuiUrl && instance.webuiUrl === request.webuiUrl;
      const matchesGatewayPort = request.gatewayPort && Number(instance.gatewayPort || 0) === Number(request.gatewayPort);
      if (matchesInstanceId || (!request.instanceId && (matchesHttp || matchesWebui || matchesGatewayPort))) {
        result.push(instance);
      }
    }
  }
  return result;
}

function expectedBotUserIdForHealth(preferredInstances: NapCatInstanceDefinition[], request: NapcatHealthRequest): string {
  return String(request.botUserId || preferredInstances.find((item) => item.botUserId)?.botUserId || "").trim();
}

function readNapcatWebuiToken(ctx: NapcatManagerContext, webuiUrl: string, providedToken?: string, preferredInstances: NapCatInstanceDefinition[] = []): NapcatWebuiTokenInfo {
  const provided = providedToken?.trim();
  if (provided) {
    return {
      found: true,
      token: provided,
      tokenLength: provided.length,
      loginUrl: napcatWebuiLoginUrl(webuiUrl, provided),
      source: "provided"
    };
  }
  let expectedPort = 0;
  try {
    expectedPort = Number(new URL(webuiUrl).port || 6099);
  } catch {
    expectedPort = 0;
  }

  const candidates = napcatWebuiConfigCandidates(ctx, preferredInstances);
  let fallback: NapcatWebuiTokenInfo | null = null;
  for (const configPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as { token?: unknown; port?: unknown; disableWebUI?: unknown };
      const fileToken = String(parsed.token || "").trim();
      const token = fileToken;
      if (!token || parsed.disableWebUI === true) continue;
      const port = Number(parsed.port || 0);
      const correctedWebuiUrl = port && port !== expectedPort
        ? localWebuiUrlWithPort(webuiUrl, port)
        : "";
      const info: NapcatWebuiTokenInfo = {
        found: true,
        token,
        tokenLength: token.length,
        configPath,
        ...(port ? { configPort: port } : {}),
        ...(correctedWebuiUrl ? { correctedWebuiUrl } : {}),
        loginUrl: napcatWebuiLoginUrl(webuiUrl, token),
        source: "config"
      };
      if (!fallback && !expectedPort) fallback = info;
      if (!expectedPort || !port || port === expectedPort) {
        return info;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return fallback ?? {
    found: false,
    message: candidates.length
      ? "已找到 NapCat webui.json，但没有读到可用 token。"
      : "未找到 NapCat config/webui.json；可在 NapCat 启动日志里查看 WebUI token。"
  };
}

function napcatWebuiBaseUrl(webuiUrl: string): string {
  return webuiUrl.replace(/\/webui\/?$/i, "").replace(/\/+$/, "");
}

async function loginNapcatWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo): Promise<NapcatWebuiSession | null> {
  const token = tokenInfo.token?.trim();
  if (!token) return null;
  return napcatWebuiSessions.open(napcatWebuiBaseUrl(webuiUrl), token);
}

async function readNapcatWebuiLoginInfo(
  webuiUrl: string,
  tokenInfo: NapcatWebuiTokenInfo,
  expectedUserId = ""
): Promise<NapcatLoginInfo | null> {
  const session = await loginNapcatWebui(webuiUrl, tokenInfo);
  if (!session) return null;
  const infoResp = await session.request("/api/QQLogin/GetQQLoginInfo");
  const infoBody = await infoResp.json().catch(() => ({})) as NapcatWebuiResponse<{ uin?: string | number; nick?: string; online?: boolean }>;
  if (infoResp.ok && infoBody.code === 0 && infoBody.data?.uin) {
    return {
      userId: infoBody.data.uin,
      nickname: infoBody.data.nick,
      online: infoBody.data.online,
      source: "webui",
      status: NapcatState.LoggedIn
    };
  }

  const statusResp = await session.request("/api/QQLogin/CheckLoginStatus");
  const statusBody = await statusResp.json().catch(() => ({})) as NapcatWebuiResponse<{ isLogin?: boolean; loginError?: string }>;
  const loginError = String(statusBody.data?.loginError || "");
  const loggedInUserId = loginError.match(/当前账号\((\d+)\)已登录/)?.[1];
  if (statusResp.ok && statusBody.code === 0 && loggedInUserId) {
    return {
      userId: loggedInUserId,
      online: false,
      source: "webui",
      status: NapcatState.LoginConflict,
      message: loginError
    };
  }

  const quickResp = await session.request("/api/QQLogin/GetQuickLoginListNew");
  const quickBody = await quickResp.json().catch(() => ({})) as NapcatWebuiResponse<Array<{ uin?: string | number; nickName?: string; isUserLogin?: boolean; isQuickLogin?: boolean }>>;
  const quickAccounts = Array.isArray(quickBody.data) ? quickBody.data : [];
  const loggedInQuick = expectedUserId
    ? quickAccounts.find((item) =>
        String(item?.uin || "").trim() === expectedUserId
        && (item.isUserLogin === true || item.isQuickLogin === true)
      )
    : quickAccounts.find((item) => item?.uin && item.isUserLogin === true)
      || quickAccounts.find((item) => item?.uin && item.isQuickLogin === true);
  if (quickResp.ok && quickBody.code === 0 && loggedInQuick?.uin) {
    return {
      userId: loggedInQuick.uin,
      nickname: loggedInQuick.nickName,
      online: false,
      source: "webui",
      status: NapcatState.QuickLoginAvailable
    };
  }
  if (/二维码.*过期|扫码|重新登录|登录态.*失效/i.test(loginError)) {
    return {
      online: false,
      source: "webui",
      status: NapcatState.QrLoginRequired,
      message: loginError
    };
  }
  if (expectedUserId && quickResp.ok && quickBody.code === 0) {
    return {
      online: false,
      source: "webui",
      status: NapcatState.QrLoginRequired,
      message: `绑定 QQ ${expectedUserId} 没有可用的快速登录身份。`
    };
  }
  if (loginError) {
    return {
      online: false,
      source: "webui",
      status: NapcatState.ManualLogin,
      message: loginError
    };
  }
  return null;
}

async function requestNapcatQuickLogin(
  webuiUrl: string,
  tokenInfo: NapcatWebuiTokenInfo,
  userId: string
): Promise<{ ok: boolean; state?: typeof NapcatState.QuickLoginInvalid | typeof NapcatState.LoginConflict | typeof NapcatState.ManualLogin; message?: string }> {
  const session = await loginNapcatWebui(webuiUrl, tokenInfo);
  if (!session) {
    return {
      ok: false,
      state: NapcatState.ManualLogin,
      message: "NapCat 管理页暂时无法自动登录。"
    };
  }
  try {
    const response = await session.request("/api/QQLogin/SetQuickLogin", { uin: userId });
    const body = await response.json().catch(() => ({})) as NapcatWebuiResponse<unknown>;
    if (response.ok && body.code === 0) return { ok: true };
    const message = String(body.message || response.statusText || "快捷登录未完成。");
    if (/登录态.*失效|身份.*失效|重新登录|扫码/i.test(message)) {
      return { ok: false, state: NapcatState.QuickLoginInvalid, message };
    }
    if (/已登录|重复登录|占用/i.test(message)) {
      return { ok: false, state: NapcatState.LoginConflict, message };
    }
    return { ok: false, state: NapcatState.ManualLogin, message };
  } catch {
    return {
      ok: false,
      state: NapcatState.ManualLogin,
      message: "快捷登录请求暂时失败。"
    };
  }
}

function publicNapcatWebuiTokenInfo(info: NapcatWebuiTokenInfo): Omit<NapcatWebuiTokenInfo, "token" | "loginUrl"> {
  const { token: _token, loginUrl: _loginUrl, ...safe } = info;
  return safe;
}

type NapcatQuickLoginAccount = {
  uin?: string | number;
  nickName?: string;
  faceUrl?: string;
  isUserLogin?: boolean;
  isQuickLogin?: boolean;
};

type NapcatWebuiLoginStatus = {
  isLogin?: boolean;
  isOffline?: boolean;
  qrcodeurl?: string;
  loginError?: string;
};

type NapcatPasswordLoginResult = {
  needCaptcha?: boolean;
  proofWaterUrl?: string;
  needNewDevice?: boolean;
  jumpUrl?: string;
  newDevicePullQrCodeSig?: string;
};

type NapcatNewDeviceQrResult = {
  str_url?: string;
  bytes_token?: string;
  uint32_guarantee_status?: number;
  ActionStatus?: string;
  ErrorCode?: number;
  ErrorInfo?: string;
};

function napcatLoginTarget(
  ctx: NapcatManagerContext,
  request: NapcatLoginPanelRequest
): { instance: NapCatInstanceDefinition; webuiUrl: string; tokenInfo: NapcatWebuiTokenInfo } {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少 gatewayId 或 instanceId。");
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const instance = napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId);
  if (!instance) throw new Error(`未找到 NapCat 实例：${instanceId}`);
  const configuredWebuiUrl = instance.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const tokenInfo = readNapcatWebuiToken(ctx, configuredWebuiUrl, instance.webuiToken, [instance]);
  return {
    instance,
    webuiUrl: tokenInfo.correctedWebuiUrl?.trim() || configuredWebuiUrl,
    tokenInfo
  };
}

async function requireNapcatWebuiSession(
  ctx: NapcatManagerContext,
  request: NapcatLoginPanelRequest
): Promise<{ instance: NapCatInstanceDefinition; session: NapcatWebuiSession }> {
  const target = napcatLoginTarget(ctx, request);
  let session: NapcatWebuiSession | null;
  try {
    session = await loginNapcatWebui(target.webuiUrl, target.tokenInfo);
  } catch (cause) {
    throw new Error(`NapCat 管理服务未响应（${target.webuiUrl}）；请启动此实例后刷新登录状态。`, { cause });
  }
  if (!session) {
    throw new Error(target.tokenInfo.message || "NapCat 管理服务暂时无法认证；请确认后台已启动并能读取 WebUI 登录密钥。");
  }
  return { instance: target.instance, session };
}

async function callNapcatWebui<T>(
  session: NapcatWebuiSession,
  pathname: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const response = await session.request(`/api/QQLogin/${pathname}`, body);
  const result = await response.json().catch(() => ({})) as NapcatWebuiResponse<T>;
  if (!response.ok || result.code !== 0) {
    throw new Error(String(result.message || response.statusText || `NapCat ${pathname} 请求失败。`));
  }
  return result.data as T;
}

async function napcatQrDataUrl(content: string | undefined): Promise<string> {
  if (!content) return "";
  return QRCode.toDataURL(content, {
    width: 280,
    margin: 1,
    errorCorrectionLevel: "M"
  });
}

export async function readNapcatLoginPanel(
  ctx: NapcatManagerContext,
  request: NapcatLoginPanelRequest
): Promise<NapcatLoginPanelData> {
  const { instance } = napcatLoginTarget(ctx, request);
  const [health, sessionResult] = await Promise.all([
    testNapcatHealth(ctx, { ...instance, ...request, readWebuiLoginInfo: false, inspectProcesses: false }),
    requireNapcatWebuiSession(ctx, request).then(value => ({ session: value.session, error: "" }),
      error => ({ session: null, error: error instanceof Error ? error.message : String(error) }))
  ]);
  const http = health.http as { userId?: string | number; nickname?: string; online?: boolean; good?: boolean };
  const expectedUserId = String(instance.botUserId || "").trim();
  if (!sessionResult.session) {
    const currentUserId = String(http.userId || "");
    const loggedIn = Boolean(currentUserId && http.online === true && http.good !== false);
    return {
      ok: true,
      state: health.state === NapcatState.AccountMismatch ? NapcatState.AccountMismatch
        : loggedIn ? NapcatState.LoggedIn : http.online === false ? NapcatState.Offline : NapcatState.Unreachable,
      loggedIn, offline: http.online === false, expectedUserId, health,
      managementAvailable: false,
      currentAccount: currentUserId ? { userId: currentUserId, nickname: http.nickname, online: http.online } : null,
      quickAccounts: [], qrCodeDataUrl: "", warnings: [sessionResult.error],
      message: health.message || (loggedIn ? `QQ ${currentUserId} 已登录。` : sessionResult.error)
    };
  }
  const session = sessionResult.session;
  const [statusResult, accountResult, quickResult] = await Promise.allSettled([
    callNapcatWebui<NapcatWebuiLoginStatus>(session, "CheckLoginStatus"),
    callNapcatWebui<{ uin?: string | number; nick?: string; online?: boolean; avatarUrl?: string }>(session, "GetQQLoginInfo"),
    callNapcatWebui<NapcatQuickLoginAccount[]>(session, "GetQuickLoginListNew")
  ]);
  const status = statusResult.status === "fulfilled" ? statusResult.value : {};
  const account = accountResult.status === "fulfilled" ? accountResult.value : {};
  const quickAccounts = quickResult.status === "fulfilled" && Array.isArray(quickResult.value)
    ? quickResult.value
        .filter((item) => String(item?.uin || "").trim())
        .slice(0, 20)
        .map((item) => ({
          userId: String(item.uin),
          nickname: item.nickName,
          avatarUrl: item.faceUrl,
          savedLogin: item.isUserLogin === true,
          quickLoginAvailable: item.isQuickLogin === true
        }))
    : [];
  const currentUserId = String(account?.uin || http.userId || "").trim();
  const offline = status.isOffline === true || account?.online === false;
  const loggedIn = !offline && (status.isLogin === true || Boolean(currentUserId && (account?.online === true || http.online === true)));
  const state = health.state === NapcatState.AccountMismatch || (expectedUserId && currentUserId && expectedUserId !== currentUserId)
    ? NapcatState.AccountMismatch : loggedIn ? NapcatState.LoggedIn : offline ? NapcatState.Offline : NapcatState.LoginRequired;
  health.webui = { ...health.webui, reachable: true,
    loginInfo: account?.uin ? { userId: account.uin, nickname: account.nick, online: !offline && loggedIn, source: "webui" } : null };
  const qrCodeContent = loggedIn ? "" : String(status.qrcodeurl || "");
  const errors = [statusResult, accountResult, quickResult]
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason));
  return {
    ok: true,
    health,
    managementAvailable: true,
    state,
    loggedIn,
    offline,
    expectedUserId,
    currentAccount: currentUserId ? {
      userId: currentUserId,
      nickname: account?.nick || (String(http.userId || "") === currentUserId ? http.nickname : undefined),
      online: account?.online,
      avatarUrl: account?.avatarUrl
    } : null,
    quickAccounts,
    qrCodeDataUrl: await napcatQrDataUrl(qrCodeContent),
    loginError: String(status.loginError || ""),
    warnings: errors,
    message: state === NapcatState.LoggedIn
      ? `QQ ${currentUserId} 已登录。`
      : state === NapcatState.AccountMismatch
        ? String(health.message || `当前账号 QQ ${currentUserId}，与此 Route 绑定 QQ ${expectedUserId} 不一致。`)
        : state === NapcatState.Offline
          ? `QQ ${currentUserId} 已登录但当前离线。`
          : "请选择快速登录、密码登录或扫码登录。"
  };
}

function requiredLoginUserId(request: NapcatLoginActionRequest): string {
  const userId = String(request.userId || "").trim();
  if (!/^\d{5,20}$/.test(userId)) throw new Error("请输入有效的 QQ 号。");
  return userId;
}

function requiredLoginPassword(request: NapcatLoginActionRequest): string {
  const password = "password" in request ? String(request.password || "") : "";
  if (!password) throw new Error("请输入 QQ 密码。");
  if (password.length > 256) throw new Error("QQ 密码长度异常。");
  return password;
}

async function runNapcatLoginActionBound(
  ctx: NapcatManagerContext,
  request: NapcatLoginActionRequest
): Promise<Record<string, unknown>> {
  const runtime = [...ctx.getRuntimes()].find(item => item.definition.id === request.gatewayId);
  const bound = runtime && napcatInstancesFor(ctx, runtime).find(item => item.id === request.instanceId);
  const expectedUserId = String(bound?.botUserId || "").trim();
  if (expectedUserId && "userId" in request && request.userId && String(request.userId).trim() !== expectedUserId) {
    throw new NapcatLifecycleError(NapcatState.AccountMismatch, "登录 QQ 与当前路由绑定的账号不一致，请使用绑定账号。");
  }
  const { session } = await requireNapcatWebuiSession(ctx, request);
  switch (request.action) {
    case "quick-login": {
      const userId = requiredLoginUserId(request);
      await callNapcatWebui<unknown>(session, "SetQuickLogin", { uin: userId });
      return { ok: true, action: request.action, message: `已向 NapCat 提交 QQ ${userId} 的快速登录请求。` };
    }
    case "refresh-qr": {
      await callNapcatWebui<unknown>(session, "RefreshQRcode");
      return { ok: true, action: request.action, message: "已刷新登录二维码。" };
    }
    case "password-login": {
      const userId = requiredLoginUserId(request);
      const passwordMd5 = createHash("md5").update(requiredLoginPassword(request), "utf8").digest("hex");
      const data = await callNapcatWebui<NapcatPasswordLoginResult>(session, "PasswordLogin", { uin: userId, passwordMd5 });
      return { ok: true, action: request.action, data: data ?? null, message: "已提交密码登录请求。" };
    }
    case "captcha-login": {
      const userId = requiredLoginUserId(request);
      const passwordMd5 = createHash("md5").update(requiredLoginPassword(request), "utf8").digest("hex");
      const ticket = String(request.ticket || "").trim();
      const randstr = String(request.randstr || "").trim();
      if (!ticket || !randstr) throw new Error("验证码结果不完整，请重新验证。");
      const data = await callNapcatWebui<NapcatPasswordLoginResult>(session, "CaptchaLogin", {
        uin: userId,
        passwordMd5,
        ticket,
        randstr,
        sid: String(request.sid || "")
      });
      return { ok: true, action: request.action, data: data ?? null, message: "已提交验证码登录请求。" };
    }
    case "new-device-login": {
      const userId = requiredLoginUserId(request);
      const passwordMd5 = createHash("md5").update(requiredLoginPassword(request), "utf8").digest("hex");
      const newDevicePullQrCodeSig = String(request.newDevicePullQrCodeSig || "").trim();
      if (!newDevicePullQrCodeSig) throw new Error("新设备验证凭据缺失，请重新获取二维码。");
      const data = await callNapcatWebui<NapcatPasswordLoginResult>(session, "NewDeviceLogin", {
        uin: userId,
        passwordMd5,
        newDevicePullQrCodeSig
      });
      return { ok: true, action: request.action, data: data ?? null, message: "已提交新设备验证登录请求。" };
    }
    case "new-device-qr": {
      const userId = requiredLoginUserId(request);
      const jumpUrl = String(request.jumpUrl || "").trim();
      let parsed: URL;
      try {
        parsed = new URL(jumpUrl);
      } catch {
        throw new Error("新设备验证地址无效，请重新发起密码登录。");
      }
      if (parsed.protocol !== "https:") throw new Error("新设备验证地址必须使用 HTTPS。");
      const data = await callNapcatWebui<NapcatNewDeviceQrResult>(session, "GetNewDeviceQRCode", { uin: userId, jumpUrl });
      return {
        ok: true,
        action: request.action,
        data: {
          ...data,
          qrCodeDataUrl: await napcatQrDataUrl(data?.str_url)
        },
        message: "已生成新设备验证二维码。"
      };
    }
    case "new-device-poll": {
      const userId = requiredLoginUserId(request);
      const bytesToken = String(request.bytesToken || "").trim();
      if (!bytesToken) throw new Error("新设备二维码凭据缺失，请重新获取。");
      const data = await callNapcatWebui<Record<string, unknown>>(session, "PollNewDeviceQR", { uin: userId, bytesToken });
      return { ok: true, action: request.action, data: data ?? null };
    }
    default:
      throw new Error("不支持的 NapCat 登录动作。");
  }
}

function normalizeOneBotNetworkConfig(config: NapcatOneBotNetworkConfig): NormalizedNapcatOneBotNetworkConfig {
  const network = config.network ?? {};
  return {
    network: {
      httpServers: Array.isArray(network.httpServers) ? network.httpServers : [],
      httpSseServers: Array.isArray(network.httpSseServers) ? network.httpSseServers : [],
      httpClients: Array.isArray(network.httpClients) ? network.httpClients : [],
      websocketServers: Array.isArray(network.websocketServers) ? network.websocketServers : [],
      websocketClients: Array.isArray(network.websocketClients) ? network.websocketClients : [],
      plugins: Array.isArray(network.plugins) ? network.plugins : []
    }
  };
}

function upsertByNameOrEndpoint(items: Array<Record<string, unknown>>, next: Record<string, unknown>, endpointKey: "port" | "url"): boolean {
  const wantedName = String(next.name || "");
  const wantedEndpoint = next[endpointKey];
  const index = items.findIndex((item) =>
    String(item.name || "") === wantedName ||
    (wantedEndpoint != null && item[endpointKey] === wantedEndpoint)
  );
  if (index >= 0) {
    const merged = { ...items[index], ...next };
    const changed = JSON.stringify(items[index]) !== JSON.stringify(merged);
    items[index] = merged;
    return changed;
  }
  items.push(next);
  return true;
}

function onebotConfigPathForWebuiConfig(configPath: string | undefined, userId: string | number | undefined): string | null {
  const uin = String(userId || "").trim();
  if (!configPath || !uin) return null;
  return path.join(path.dirname(configPath), `onebot11_${uin}.json`);
}

function napcatProtocolConfigPathForWebuiConfig(configPath: string | undefined, userId: string | number | undefined): string | null {
  const uin = String(userId || "").trim();
  if (!configPath || !uin) return null;
  return path.join(path.dirname(configPath), `napcat_protocol_${uin}.json`);
}

function readOneBotNetworkConfig(configPath: string | null): NormalizedNapcatOneBotNetworkConfig | null {
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as NapcatOneBotNetworkConfig;
    return normalizeOneBotNetworkConfig(parsed);
  } catch {
    return null;
  }
}

function isEnabledConfigItem(item: Record<string, unknown>): boolean {
  return item.enable !== false && item.enabled !== false;
}

function onebotConfigMatches(config: NormalizedNapcatOneBotNetworkConfig | null, httpPort: number, wsUrl: string): boolean {
  if (!config) return false;
  const hasHttp = config.network.httpServers.some((item) =>
    isEnabledConfigItem(item) && Number(item.port || 0) === httpPort
  );
  const hasWs = config.network.websocketClients.some((item) =>
    isEnabledConfigItem(item) && String(item.url || "").trim() === wsUrl
  );
  return hasHttp && hasWs;
}

function writeRabiRouteOneBotConfig(
  onebotPath: string,
  httpPort: number,
  wsUrl: string,
  accessToken?: string
): { changed: boolean; config: NormalizedNapcatOneBotNetworkConfig } {
  let parsed: NapcatOneBotNetworkConfig = {};
  if (fs.existsSync(onebotPath)) {
    parsed = JSON.parse(fs.readFileSync(onebotPath, "utf8").replace(/^\uFEFF/, "")) as NapcatOneBotNetworkConfig;
  }
  const config = normalizeOneBotNetworkConfig(parsed);
  const changedHttp = upsertByNameOrEndpoint(config.network.httpServers, {
    enable: true,
    name: "RabiRoute HTTP",
    host: "127.0.0.1",
    port: httpPort,
    enableCors: true,
    enableWebsocket: false,
    messagePostFormat: "array",
    token: accessToken?.trim() || "",
    debug: false
  }, "port");
  const changedWs = upsertByNameOrEndpoint(config.network.websocketClients, {
    enable: true,
    name: "RabiRoute",
    url: wsUrl,
    reportSelfMessage: false,
    messagePostFormat: "array",
    token: "",
    debug: false,
    heartInterval: 30000,
    reconnectInterval: 30000,
    verifyCertificate: true
  }, "url");
  fs.writeFileSync(onebotPath, JSON.stringify(config, null, 2), "utf8");
  recordDataMutationAudit({
    group: "napcat",
    event: "napcat_onebot_config_written",
    owner: "napcat-manager",
    action: "configure-onebot",
    target: { type: "napcat-config", id: path.basename(onebotPath) },
    dataSource: { kind: "file", id: "napcat/config/onebot.json" },
    outcome: changedHttp || changedWs ? "committed" : "no_change"
  });
  return { changed: changedHttp || changedWs, config };
}

function writeRabiRouteNapcatProtocolConfig(
  protocolPath: string | null,
  config: NormalizedNapcatOneBotNetworkConfig
): boolean {
  if (!protocolPath) return false;
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(protocolPath)) {
    parsed = JSON.parse(fs.readFileSync(protocolPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  }
  const next = {
    ...parsed,
    enable: true,
    network: {
      httpServers: config.network.httpServers,
      websocketServers: config.network.websocketServers,
      websocketClients: config.network.websocketClients
    }
  };
  const changed = JSON.stringify(parsed) !== JSON.stringify(next);
  fs.writeFileSync(protocolPath, JSON.stringify(next, null, 2), "utf8");
  recordDataMutationAudit({
    group: "napcat",
    event: "napcat_protocol_config_written",
    owner: "napcat-manager",
    action: "configure-protocol",
    target: { type: "napcat-config", id: path.basename(protocolPath) },
    dataSource: { kind: "file", id: "napcat/config/protocol.json" },
    outcome: changed ? "committed" : "no_change"
  });
  return changed;
}

function prepareOneBotConfigForLaunch(
  instance: NapCatInstanceDefinition,
  tokenInfo: NapcatWebuiTokenInfo | null
): string[] {
  const botUserId = String(instance.botUserId || "").trim();
  const httpPort = portFromUrl(instance.httpUrl);
  const wsUrl = Number(instance.gatewayPort || 0) > 0 ? `ws://127.0.0.1:${instance.gatewayPort}` : "";
  const onebotPath = onebotConfigPathForWebuiConfig(tokenInfo?.configPath, botUserId);
  if (!botUserId || !httpPort || !wsUrl || !onebotPath) return [];
  const { config } = writeRabiRouteOneBotConfig(onebotPath, httpPort, wsUrl, instance.accessToken);
  writeRabiRouteNapcatProtocolConfig(
    napcatProtocolConfigPathForWebuiConfig(tokenInfo?.configPath, botUserId),
    config
  );
  return [`已预写 QQ ${botUserId} 的 OneBot 配置：HTTP ${httpPort}，WS ${wsUrl}。`];
}

async function napcatHttpOk(httpUrl: string, token: string | undefined, timeoutMs = 4000): Promise<boolean> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${httpUrl.replace(/\/+$/, "")}/get_login_info`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({})) as NapcatOneBotResponse<unknown>;
    return body.retcode == null || body.retcode === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function napcatStatusEndpointOk(httpUrl: string | undefined, token: string | undefined, timeoutMs = 3000): Promise<boolean> {
  const url = httpUrl?.trim();
  if (!url) return false;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/get_status`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({})) as NapcatOneBotResponse<{ online?: boolean; good?: boolean }>;
    if (body.retcode != null && body.retcode !== 0) return false;
    return body.data?.online !== false && body.data?.good !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForNapcatReady(ctx: NapcatManagerContext, instance: NapCatInstanceDefinition, timeoutMs = 35000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  const httpUrl = instance.httpUrl?.trim();
  const webuiUrl = instance.webuiUrl?.trim();
  let webuiReachable = false;
  while (Date.now() < deadline) {
    if (await napcatStatusEndpointOk(httpUrl, instance.accessToken, 2500)) {
      return { ok: true, kind: "onebot-status", url: `${httpUrl?.replace(/\/+$/, "")}/get_status` };
    }
    if (webuiUrl && await ctx.checkHttpEndpoint(webuiUrl, 1200)) {
      return {
        // WebUI only proves that the launcher/UI is alive.  It does not prove
        // QQ login, OneBot HTTP, or a usable route, so lifecycle callers must
        // not report a successful recovery yet.
        ok: false,
        state: NapcatState.OnebotNotReady,
        kind: "webui",
        url: webuiUrl,
        onebotReady: false,
        message: httpUrl
          ? `NapCat WebUI 已可达；${httpUrl.replace(/\/+$/, "")}/get_status 尚未就绪，登录后会继续复查 OneBot。`
          : "NapCat WebUI 已可达。"
      };
    }
    await wait(1000);
  }
  return {
    ok: false,
    kind: "timeout",
    webuiReachable,
    message: httpUrl
      ? `启动命令已执行，${webuiUrl && webuiReachable ? "NapCat WebUI 可达，但 " : ""}${httpUrl.replace(/\/+$/, "")}/get_status 未在超时时间内返回 online/good。`
      : `启动命令已执行，但等待 ${webuiUrl || "NapCat WebUI"} 可达超时。`
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function applyOneBotConfigViaWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo, config: NormalizedNapcatOneBotNetworkConfig): Promise<string[]> {
  try {
    const session = await loginNapcatWebui(webuiUrl, tokenInfo);
    if (!session) return ["未能登录 NapCat WebUI，无法调用 WebUI API 应用配置。"];
    const steps: string[] = [];
    const setResp = await session.request("/api/OB11Config/SetConfig", { config: JSON.stringify(config) });
    const setBody = await setResp.json().catch(() => ({})) as NapcatWebuiResponse<unknown>;
    if (setResp.ok && setBody.code === 0) {
      steps.push("已通过 NapCat WebUI API 保存/应用 OB11 网络配置。");
    } else {
      steps.push(`NapCat WebUI 保存配置失败：${setBody.message || setResp.statusText || setResp.status}`);
    }
    return steps;
  } catch {
    // WebUI is optional for the process-level recovery path.  Keep transport
    // failures out of logs because a lower-level error may echo credentials.
    return ["NapCat WebUI 当前不可达，跳过 WebUI 配置应用。"];
  }
}

async function restartNapcatViaWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo): Promise<string[]> {
  try {
    const session = await loginNapcatWebui(webuiUrl, tokenInfo);
    if (!session) return ["未能登录 NapCat WebUI，改用进程级恢复。"];
    const steps: string[] = [];
    for (const endpoint of ["/api/QQLogin/RestartNapCat", "/api/Process/Restart"]) {
      const resp = await session.request(endpoint);
      const body = await resp.json().catch(() => ({})) as NapcatWebuiResponse<{ message?: string }>;
      if (resp.ok && body.code === 0) {
        steps.push(`已调用 NapCat 重启接口：${body.data?.message || body.message || endpoint}`);
        return steps;
      }
      steps.push(`NapCat 重启接口 ${endpoint} 未成功：${body.message || resp.statusText || resp.status}`);
    }
    return steps;
  } catch {
    // Do not let a refused WebUI connection abort restartNapcatInstance:
    // its caller owns the safe PID/port check and launchCommand fallback.
    return ["NapCat WebUI 当前不可达，改用进程级恢复。"];
  }
}

export async function requestNapcatBotExit(httpUrl: string | undefined, token: string | undefined): Promise<string[]> {
  const url = httpUrl?.trim();
  if (!url) return [];
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const steps: string[] = [];
  try {
    const resp = await fetch(`${url.replace(/\/+$/, "")}/bot_exit`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(2500)
    });
    const body = await resp.json().catch(() => ({})) as NapcatOneBotResponse<unknown>;
    if (resp.ok && (body.retcode == null || body.retcode === 0)) {
      steps.push("已调用 OneBot bot_exit，要求该 QQ/NapCat 退出。");
    } else {
      steps.push(`OneBot bot_exit 未成功：${body.wording || body.message || resp.statusText || resp.status}`);
    }
  } catch (error) {
    steps.push(`OneBot bot_exit 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  return steps;
}


function managedNapcatInstanceRoot(ctx: NapcatManagerContext, workingDir: string | undefined): string | null {
  const value = workingDir?.trim();
  if (!value) return null;
  const managedRoot = path.resolve(ctx.rootDir, "data", "napcat");
  let current = path.resolve(value);
  for (let i = 0; i < 8; i += 1) {
    if (path.basename(current).toLowerCase() === "napcat.shell") {
      const parent = path.dirname(current);
      const relative = path.relative(managedRoot, parent);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return parent;
      }
      return null;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return null;
}


async function waitForPortsReleased(ports: number[], timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await listeningPidsForPorts(ports);
    if (pids.length === 0) return;
    await wait(300);
  }
}

async function windowsPidsForCommandLineNeedle(needle: string | null): Promise<string[]> {
  if (process.platform !== "win32" || !needle) return [];
  const normalized = path.resolve(needle).replace(/\//g, "\\").toLowerCase();
  const quotedNeedle = normalized.replace(/'/g, "''");
  try {
    const script = [
      `$needle = '${quotedNeedle}'`,
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } |",
      "Select-Object -ExpandProperty ProcessId"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

/**
 * A mapped drive and its UNC spelling can point at the same NapCat instance
 * directory.  Matching only the configured workingDir then misses the second
 * process tree, leaving two launchers for one QQ account alive.  The QQ id is
 * part of every managed NapCat launch command, so use it as a second, scoped
 * identity when the instance declares one.
 */
async function windowsNapcatPidsForBotUserId(botUserId: string | number | undefined): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const userId = String(botUserId ?? "").trim();
  if (!/^\d{5,20}$/.test(userId)) return [];
  try {
    const script = [
      `$userId = '${userId}'`,
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.CommandLine -and $_.CommandLine -match ('(?i)napcat') -and $_.CommandLine -match ('(?<!\\S)-q\\s+' + [regex]::Escape($userId) + '(?!\\S)') } |",
      "Select-Object -ExpandProperty ProcessId"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

async function windowsNapcatParentPids(pids: string[]): Promise<string[]> {
  if (process.platform !== "win32" || pids.length === 0) return [];
  const pidList = pids.filter((pid) => /^\d+$/.test(pid));
  if (pidList.length === 0) return [];
  try {
    const script = [
      `$pids = @(${pidList.join(",")})`,
      "$parents = New-Object System.Collections.Generic.HashSet[string]",
      "foreach ($targetPid in $pids) {",
      "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\"",
      "  if (-not $proc -or -not $proc.ParentProcessId) { continue }",
      "  $parent = Get-CimInstance Win32_Process -Filter \"ProcessId = $($proc.ParentProcessId)\"",
      "  if ($parent -and $parent.CommandLine -and $parent.CommandLine.ToLowerInvariant().Contains('napcat')) {",
      "    [void]$parents.Add([string]$parent.ProcessId)",
      "  }",
      "}",
      "$parents"
    ].join("\n");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

async function napcatInstanceProcessPids(ctx: NapcatManagerContext, instance: NapCatInstanceDefinition, ports: number[]): Promise<string[]> {
  if (ctx.findNapcatInstanceProcessPids) {
    return ctx.findNapcatInstanceProcessPids(instance, ports);
  }
  const listeningPids = await listeningPidsForPorts(ports);
  const pids = new Set<string>(listeningPids);
  for (const pid of await windowsNapcatParentPids(listeningPids)) {
    pids.add(pid);
  }
  const managedRoot = managedNapcatInstanceRoot(ctx, instance.workingDir);
  for (const pid of await windowsPidsForCommandLineNeedle(managedRoot || instance.workingDir || null)) {
    pids.add(pid);
  }
  for (const pid of await windowsNapcatPidsForBotUserId(instance.botUserId)) {
    pids.add(pid);
  }
  return [...pids];
}

async function configureNapcatOneBotBound(ctx: NapcatManagerContext, request: NapcatConfigureRequest): Promise<Record<string, unknown>> {
  const httpUrl = (request.httpUrl?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const webuiUrl = request.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const gatewayPort = Number(request.gatewayPort || 0);
  const httpPort = portFromUrl(httpUrl);
  if (!httpPort) throw new Error(`无法从 HTTP 地址解析端口：${httpUrl}`);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error(`RabiRoute WS 端口无效：${request.gatewayPort || ""}`);
  }

  const preferredInstances = preferredNapcatInstancesForHealth(ctx, request);
  const expectedBotUserId = expectedBotUserIdForHealth(preferredInstances, request);
  const tokenInfo = readNapcatWebuiToken(ctx, webuiUrl, request.webuiToken);
  const webuiLoginInfo = await readNapcatWebuiLoginInfo(webuiUrl, tokenInfo, expectedBotUserId);
  const webuiLoginUserId = String(webuiLoginInfo?.userId || "").trim();
  if (webuiLoginInfo?.userId && webuiLoginInfo.online !== true) {
    throw new Error(webuiLoginInfo.status === NapcatState.LoginConflict
      ? `账号 ${webuiLoginInfo.userId} 已被其他 QQ/NapCat 会话占用；当前 NapCat 实例尚未登录。`
      : `NapCat 已发现账号 ${webuiLoginInfo.userId}，但当前实例尚未完成登录。`);
  }
  if (expectedBotUserId && webuiLoginUserId && expectedBotUserId !== webuiLoginUserId) {
    throw new Error(`当前 WebUI 登录 QQ ${webuiLoginUserId}，但此 Rabi 实例绑定 QQ ${expectedBotUserId}；请先切换到正确账号。`);
  }
  const onebotPath = onebotConfigPathForWebuiConfig(tokenInfo.configPath, webuiLoginInfo?.userId);
  if (!tokenInfo.configPath || !onebotPath || !webuiLoginInfo?.userId) {
    throw new Error(tokenInfo.message || "无法确定当前登录 QQ 对应的 NapCat OneBot 配置文件。");
  }

  const wsUrl = `ws://127.0.0.1:${gatewayPort}`;
  const { changed, config } = writeRabiRouteOneBotConfig(onebotPath, httpPort, wsUrl, request.accessToken);
  const protocolChanged = writeRabiRouteNapcatProtocolConfig(
    napcatProtocolConfigPathForWebuiConfig(tokenInfo.configPath, webuiLoginInfo.userId),
    config
  );
  const steps = [
    `已写入当前 QQ 的 OneBot 配置文件：HTTP ${httpPort}，WS ${wsUrl}。`
  ];
  if (protocolChanged) {
    steps.push("已同步写入 NapCat 新协议配置，并启用 HTTP/WS 网络项。");
  }
  steps.push(...await applyOneBotConfigViaWebui(webuiUrl, tokenInfo, config));
  await wait(1200);
  let httpReady = await napcatHttpOk(httpUrl, request.accessToken, 3000);
  let restartRequested = false;
  if (!httpReady) {
    steps.push("保存/应用后 HTTP 仍未开放，正在调用 NapCat 重启接口。");
    steps.push(...await restartNapcatViaWebui(webuiUrl, tokenInfo));
    restartRequested = true;
    for (let i = 0; i < 12; i += 1) {
      await wait(1500);
      httpReady = await napcatHttpOk(httpUrl, request.accessToken, 2500);
      if (httpReady) break;
    }
  }
  return {
    ok: true,
    changed: changed || protocolChanged,
    reloadRequired: !httpReady,
    restartRequested,
    httpReady,
    steps,
    message: httpReady
      ? `已为当前登录 QQ ${webuiLoginInfo.userId} 写入并应用 OneBot HTTP ${httpPort} 和 WS ${wsUrl}。`
      : `已为当前登录 QQ ${webuiLoginInfo.userId} 写入 OneBot HTTP ${httpPort} 和 WS ${wsUrl}，并已尝试让 NapCat 应用配置；请稍后复查。`,
    userId: webuiLoginInfo.userId,
    nickname: webuiLoginInfo.nickname,
    configPath: onebotPath,
    httpUrl,
    wsUrl
  };
}

export async function testNapcatHealth(ctx: NapcatManagerContext, request: NapcatHealthRequest): Promise<NapcatHealthSnapshot> {
  if (request.gatewayId && request.instanceId) {
    const bound = preferredNapcatInstancesForHealth(ctx, request)[0];
    if (!bound) throw new Error("未找到此 Route 绑定的 NapCat 实例。");
    request = { ...request, httpUrl: bound.httpUrl, webuiUrl: bound.webuiUrl, accessToken: bound.accessToken,
      webuiToken: bound.webuiToken, gatewayPort: bound.gatewayPort, botUserId: bound.botUserId };
  }
  const httpUrl = (request.httpUrl?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const webuiUrl = request.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const token = request.accessToken?.trim() || "";
  const gatewayPort = Number(request.gatewayPort || 0);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let http: Record<string, unknown>;
  let loginInfo: NapcatLoginInfo | null = null;
  let onebotStatus: { online?: boolean; good?: boolean } | null = null;
  try {
    const statusResponse = await fetch(`${httpUrl}/get_status`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const statusBody = await statusResponse.json().catch(() => ({})) as NapcatOneBotResponse<{ online?: boolean; good?: boolean }>;
    if (statusResponse.ok && (statusBody.retcode == null || statusBody.retcode === 0)) {
      onebotStatus = statusBody.data ?? null;
    }
    const response = await fetch(`${httpUrl}/get_login_info`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const text = await response.text();
    let body: NapcatOneBotResponse<{ user_id?: number | string; nickname?: string }> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    const failed = !response.ok
      || (body.retcode != null && body.retcode !== 0)
      || body.status === "failed";
    if (failed) {
      http = {
        ok: false,
        status: response.status,
        message: body.wording || body.message || text || `HTTP ${response.status}`
      };
    } else {
      http = {
        ok: true,
        status: response.status,
        userId: body.data?.user_id,
        nickname: body.data?.nickname,
        online: onebotStatus?.online,
        good: onebotStatus?.good
      };
      loginInfo = {
        userId: body.data?.user_id,
        nickname: body.data?.nickname,
        online: onebotStatus?.online,
        source: "onebot-http"
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    http = { ok: false, status: 0, message: message.includes("abort") ? "NapCat HTTP 检查超时。" : message };
  } finally {
    clearTimeout(timer);
  }

  const preferredInstances = preferredNapcatInstancesForHealth(ctx, request);
  let tokenInfo = readNapcatWebuiToken(ctx, webuiUrl, request.webuiToken, preferredInstances);
  let effectiveWebuiUrl = webuiUrl;
  let webuiReachable = await ctx.checkHttpEndpoint(webuiUrl, 1600);
  const correctedWebuiUrl = tokenInfo.correctedWebuiUrl?.trim();
  if (!webuiReachable && correctedWebuiUrl && correctedWebuiUrl !== webuiUrl) {
    const correctedReachable = await ctx.checkHttpEndpoint(correctedWebuiUrl, 1600);
    if (correctedReachable) {
      effectiveWebuiUrl = correctedWebuiUrl;
      webuiReachable = true;
      tokenInfo = {
        ...tokenInfo,
        loginUrl: tokenInfo.token ? napcatWebuiLoginUrl(effectiveWebuiUrl, tokenInfo.token) : tokenInfo.loginUrl
      };
    }
  }
  const shouldReadWebuiLoginInfo = request.readWebuiLoginInfo !== false;
  const expectedBotUserId = expectedBotUserIdForHealth(preferredInstances, request);
  const httpUserId = String(http.userId || "").trim();
  const httpAccountMismatch = Boolean(expectedBotUserId && httpUserId && expectedBotUserId !== httpUserId);
  const httpOnline = http.ok === true && Boolean(httpUserId) && onebotStatus?.online === true && onebotStatus.good !== false;
  let webuiLoginInfo: NapcatLoginInfo | null = null;
  if (shouldReadWebuiLoginInfo) {
    try {
      webuiLoginInfo = await readNapcatWebuiLoginInfo(effectiveWebuiUrl, tokenInfo, expectedBotUserId);
      if (!loginInfo && webuiLoginInfo?.online === true) loginInfo = webuiLoginInfo;
    } catch {
      webuiLoginInfo = null;
    }
  }
  const webuiLoginUserId = String(webuiLoginInfo?.userId || "").trim();
  const webuiLoggedIn = Boolean(webuiLoginInfo?.userId && webuiLoginInfo.online === true);
  const webuiAccountMismatch = Boolean(expectedBotUserId && webuiLoginUserId && expectedBotUserId !== webuiLoginUserId);
  const webui = {
    url: effectiveWebuiUrl,
    configuredUrl: webuiUrl,
    correctedUrl: effectiveWebuiUrl !== webuiUrl ? effectiveWebuiUrl : undefined,
    reachable: webuiReachable,
    ...publicNapcatWebuiTokenInfo(tokenInfo),
    loginInfo: webuiLoginInfo,
    loginInfoSkipped: !shouldReadWebuiLoginInfo
  };
  const onebotPath = onebotConfigPathForWebuiConfig(tokenInfo.configPath, webuiLoginInfo?.userId || expectedBotUserId);
  const httpPort = portFromUrl(httpUrl);
  const wsUrl = gatewayPort > 0 ? `ws://127.0.0.1:${gatewayPort}` : "";
  const onebotConfig = readOneBotNetworkConfig(onebotPath);
  const onebotConfigured = onebotConfigMatches(onebotConfig, httpPort, wsUrl);
  const diagnostics: string[] = [];
  if (effectiveWebuiUrl !== webuiUrl) {
    diagnostics.push(`已自动改用 NapCat webui.json 中的 WebUI 地址：${effectiveWebuiUrl}。`);
  }
  if (!http.ok && webuiReachable && tokenInfo.found && !webuiLoginInfo?.userId) {
    diagnostics.push("NapCat 管理服务可达，但还没有读到 QQ 登录态；请在当前 Route 的登录卡片中选择快速、密码或扫码登录。");
  }
  if (!http.ok && webuiLoginInfo?.status === NapcatState.LoginConflict) {
    diagnostics.push(`NapCat 返回账号占用/重复登录：${webuiLoginInfo.message || `当前账号 ${webuiLoginInfo.userId} 已登录但不在此实例内`}`);
    diagnostics.push("这不等于当前 NapCat 实例已经登录；请关闭占用该账号的 QQ/NapCat 会话，再回到当前 Route 的登录卡片继续。");
  } else if (!http.ok && webuiLoginInfo?.status === NapcatState.QuickLoginAvailable) {
    diagnostics.push(`NapCat 发现可快速登录账号 ${webuiLoginInfo.userId}，但当前实例尚未完成登录。`);
  }
  if (http.ok && onebotStatus?.online === false) {
    diagnostics.push(`${httpUrl}/get_status 返回 online:false；WS 或登录资料可能仍有旧连接，但 QQ 实际已经离线。`);
  }
  if (http.ok && onebotStatus?.good === false) {
    diagnostics.push(`${httpUrl}/get_status 返回 good:false；NapCat 进程仍在，但 OneBot 当前不可健康投递。`);
  }
  const webuiLoginDisplayUserId = String(webuiLoginInfo?.userId || "");
  if (!http.ok && webuiLoggedIn) {
    if (webuiAccountMismatch) {
      diagnostics.push(`当前 WebUI 登录 QQ ${webuiLoginDisplayUserId}，但这个 Rabi 实例绑定 QQ ${expectedBotUserId}。`);
      diagnostics.push("请先在对应 NapCat WebUI 切换到该实例绑定的 QQ，再修复 OneBot HTTP/WS 配置。");
    } else {
      diagnostics.push(`当前 WebUI 登录 QQ ${webuiLoginDisplayUserId}，但 ${httpUrl}/get_login_info 不可用。`);
      if (onebotConfigured) {
        diagnostics.push(`当前 QQ 的 OneBot 配置文件已包含 HTTP ${httpPort} 和 WS ${wsUrl}，但运行中的 NapCat 还没有开放 HTTP。`);
        diagnostics.push("请在 NapCat WebUI 保存/重载网络配置，或重启这个 NapCat 后再复查。");
      } else {
        diagnostics.push(`通常是这个 QQ 的 OneBot HTTP Server 没启用，或端口没有配置为 ${httpPort}。`);
      }
    }
  }
  if (gatewayPort > 0 && webuiLoggedIn) {
    diagnostics.push(`请确认当前 QQ 的 WebSocket Client 指向 ws://127.0.0.1:${gatewayPort}。`);
  }
  const fixAvailable = Boolean(shouldReadWebuiLoginInfo && !webuiAccountMismatch && !http.ok && webuiLoggedIn && tokenInfo.configPath && onebotPath);
  const shouldInspectProcesses = request.inspectProcesses !== false;
  const processes = shouldInspectProcesses ? await detectNapcatProcesses() : [];
  // Keep the machine-readable state in step with the explanatory message.
  // Consumers such as the watchdog must distinguish an actionable OneBot
  // configuration failure from an expired QR/login confirmation: restarting
  // the latter cannot recover the endpoint and only creates login churn.
  const state = httpAccountMismatch || webuiAccountMismatch
    ? NapcatState.AccountMismatch
    : httpOnline
    ? NapcatState.Ready
    : http.ok && onebotStatus?.online === false
      ? NapcatState.Offline
    : webuiLoginInfo?.status === NapcatState.QrLoginRequired
      ? NapcatState.QrLoginRequired
      : webuiLoginInfo?.status === NapcatState.LoginConflict
        ? NapcatState.LoginConflict
        : webuiLoginInfo?.status === NapcatState.QuickLoginAvailable
          ? NapcatState.QuickLoginAvailable
          : webuiAccountMismatch
            ? NapcatState.AccountMismatch
            : webuiReachable
              ? NapcatState.ManualLogin
              : NapcatState.Unreachable;
  const needsUserAction = state === NapcatState.QrLoginRequired
    || state === NapcatState.LoginConflict
    || state === NapcatState.AccountMismatch
    || state === NapcatState.ManualLogin;
  return {
    ok: httpOnline && !httpAccountMismatch && !webuiAccountMismatch,
    state,
    needsUserAction,
    fixAvailable,
    diagnostics,
    message: httpAccountMismatch
      ? `此 Route 绑定 QQ ${expectedBotUserId}，但 OneBot HTTP 返回 QQ ${httpUserId}${http.nickname ? ` / ${http.nickname}` : ""}；请检查此实例的 HTTP 地址。`
      : state === NapcatState.Offline ? `QQ ${httpUserId} 已离线，请重新登录。` : !http.ok
        ? webuiLoggedIn
        ? webuiAccountMismatch
          ? `NapCat 当前登录 QQ ${webuiLoginDisplayUserId}，但此 Route 绑定 QQ ${expectedBotUserId}；请在当前登录卡片切换到正确账号。`
          : onebotConfigured
          ? `已为当前 QQ ${webuiLoginDisplayUserId} 写入 OneBot HTTP/WS 配置，但 NapCat 尚未重载生效；请使用当前卡片的修复操作重新应用配置。`
          : `NapCat 已登录 ${webuiLoginDisplayUserId}，但 OneBot HTTP 未连通；请使用当前卡片的修复操作写入 HTTP/WS 配置。`
        : webuiLoginInfo?.status === NapcatState.LoginConflict
          ? `账号 ${webuiLoginInfo.userId} 已被其他 QQ/NapCat 会话占用；当前呆猫实例尚未登录。`
          : webuiLoginInfo?.status === NapcatState.QuickLoginAvailable
          ? `NapCat 已发现可快速登录账号 ${webuiLoginInfo.userId}，但当前实例尚未完成登录。`
          : webuiLoginInfo?.status === NapcatState.QrLoginRequired
          ? String(webuiLoginInfo.message || `绑定 QQ ${expectedBotUserId} 没有可用的快速登录身份，请刷新二维码并扫码登录。`)
        : webuiReachable
          ? "NapCat 管理服务可达，但当前 QQ 还未登录；请在当前 Route 的登录卡片中完成登录。"
          : undefined
      : undefined,
    http,
    webui,
    loginInfo,
    onebot: {
      configPath: onebotPath,
      currentUserId: webuiLoginInfo?.userId,
      currentNickname: webuiLoginInfo?.nickname
    },
    gatewayPort,
    wsUrl,
    process: {
      found: shouldInspectProcesses ? processes.length > 0 : Boolean(http.ok || webuiReachable),
      candidates: processes.slice(0, 8),
      inspectionSkipped: !shouldInspectProcesses
    }
  };
}

function napcatLifecycleKey(ctx: NapcatManagerContext, request: NapcatLaunchRequest | NapcatStopRequest): string {
  const gatewayId = request.gatewayId?.trim() || "unknown-route";
  const instanceId = request.instanceId?.trim() || "unknown-instance";
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  const instance = runtime
    ? napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId)
    : null;
  const botUserId = String(instance?.botUserId || "").trim();
  return botUserId ? `qq:${botUserId}` : `instance:${gatewayId}:${instanceId}`;
}

async function launchNapcatInstanceUnlocked(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = napcatInstancesFor(ctx, runtime)
    .find((item) => item.id === instanceId);
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }
  if (!request.forceRestart) {
    const currentHealth = await testNapcatHealth(ctx, {
      gatewayId,
      instanceId,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl,
      accessToken: instance.accessToken,
      webuiToken: instance.webuiToken,
      gatewayPort: instance.gatewayPort,
      readWebuiLoginInfo: false,
      inspectProcesses: false,
      botUserId: instance.botUserId
    });
    if (currentHealth.ok === true) {
      ctx.appendLog(runtime, `reuse running NapCat instance ${instance.name || instance.id}; duplicate launch was suppressed`);
      return {
        ok: true,
        state: NapcatState.AlreadyRunning,
        needsUserAction: false,
        message: `NapCat 已在运行，已忽略重复启动：${instance.name || instance.id}`,
        steps: ["已通过 OneBot 健康检查确认当前实例可用，没有创建第二棵 QQ/NapCat 进程树。"],
        health: currentHealth,
        instance: {
          id: instance.id,
          name: instance.name,
          gatewayPort: instance.gatewayPort,
          httpUrl: instance.httpUrl,
          webuiUrl: instance.webuiUrl
        }
      };
    }
  }
  const expectedUserId = String(instance.botUserId || "").trim();
  const accountOwner = await findNapcatAccountOwner(ctx, expectedUserId, instance);
  if (accountOwner) {
    const message = `QQ ${expectedUserId} 已在另一 NapCat 实例在线；为保护现有会话，没有启动重复实例。`;
    ctx.appendLog(runtime, `skip launch NapCat instance ${instance.name || instance.id}: account ${expectedUserId} already online at ${accountOwner.httpUrl}`);
    return {
      ok: false,
      state: NapcatState.AccountOnlineElsewhere,
      needsUserAction: true,
      message,
      accountOwner,
      health: {
        ok: false,
        loginState: NapcatState.AccountOnlineElsewhere,
        accountOwner,
        message
      },
      steps: [
        `已发现在线账号归属：${accountOwner.instanceName || accountOwner.workingDir || accountOwner.httpUrl}。`,
        "已保留现有登录；如需迁移，请先明确停止旧实例，再启动目标实例。"
      ],
      instance: {
        id: instance.id,
        name: instance.name,
        gatewayPort: instance.gatewayPort,
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl
      }
    };
  }
  const plan = resolveNapcatLaunchPlan(instance, ctx.rootDir);
  const tokenInfo = instance.webuiUrl
    ? readNapcatWebuiToken(ctx, instance.webuiUrl, instance.webuiToken, [instance])
    : null;
  const preflightSteps = prepareOneBotConfigForLaunch(instance, tokenInfo);
  const ports = [
    portFromUrl(instance.httpUrl),
    portFromUrl(instance.webuiUrl)
  ].filter((port) => Number.isInteger(port) && port > 0);
  const stopped: string[] = [];
  if (!request.forceRestart) {
    // A dead WebUI does not prove that its process tree has exited.  Starting a
    // second Shell in that state can leave two QQ clients fighting for the same
    // profile (or hide a port collision).  A restart owns the explicit kill;
    // a plain launch only observes and waits for the existing owner.
    const existingPids = await napcatInstanceProcessPids(ctx, instance, ports);
    if (existingPids.length > 0) {
      const observed = await waitForNapcatReady(ctx, instance, 5000);
      ctx.appendLog(runtime, `suppress duplicate NapCat launch for ${instance.name || instance.id}: existingPids=${existingPids.join(",")} ready=${observed.ok === true ? String(observed.kind || "ok") : "timeout"}`);
      return {
        ok: observed.ok === true,
        state: observed.ok === true ? NapcatState.AlreadyStarting : NapcatState.ProcessOrPortAlreadyPresent,
        needsUserAction: false,
        message: observed.ok === true
          ? `NapCat 已由现有进程启动：${instance.name || instance.id}`
          : `NapCat 端点不可达，但已有进程或端口占用；为避免重复启动，本次未拉起第二个实例：${instance.name || instance.id}`,
        steps: [
          `检测到现有 NapCat 相关进程或 HTTP/WebUI 端口持有者：${existingPids.join(", ")}。`,
          observed.ok === true
            ? `已回读确认现有实例可达：${observed.url || observed.kind || "health"}。`
            : String(observed.message || "等待现有进程恢复超时；可执行明确的重启来结束受管进程后再启动。")
        ],
        health: observed,
        instance: {
          id: instance.id,
          name: instance.name,
          gatewayPort: instance.gatewayPort,
          httpUrl: instance.httpUrl,
          webuiUrl: instance.webuiUrl
        }
      };
    }
  }
  if (request.forceRestart) {
    if (!ctx.stopOwnedInstanceForRestart) throw new Error("NapCat 进程归属管理尚未就绪，不能停止实例。");
    await ctx.stopOwnedInstanceForRestart(request);
  }
  if (ctx.launchNapcatProcess) {
    await ctx.launchNapcatProcess(plan, request.visible === true, request);
  } else {
    launchNapcatProcess(plan, request.visible === true);
  }
  const recordLaunchPids = async (): Promise<void> => {
    if (!ctx.recordNapcatLaunchPids) return;
    await ctx.recordNapcatLaunchPids(request, await napcatInstanceProcessPids(ctx, instance, ports));
  };
  await recordLaunchPids();
  const ready = await waitForNapcatReady(ctx, instance);
  const readyOk = ready.ok !== false;
  await recordLaunchPids();
  ctx.appendLog(runtime, `launch NapCat instance ${instance.name || instance.id}: ${plan.commandLine} ready=${readyOk ? String(ready.kind || "ok") : "timeout"}`);
  const steps = [
    ...preflightSteps,
    ...(stopped.length ? [`已停止旧 NapCat 进程：${stopped.join(", ")}`] : []),
    ...(plan.redirectedFromOuterShell ? [`已识别外层 NapCat Shell，改用内层启动器：${plan.commandPath}`] : []),
    ...(plan.botUserId && plan.redirectedFromOuterShell ? [`已追加 quick login 参数：-q ${plan.botUserId}`] : []),
    ...plan.warnings,
    readyOk ? `NapCat 已可达：${ready.url || ready.kind || "health"}` : String(ready.message || "NapCat 健康检查超时。")
  ];
  return {
    ok: readyOk,
    state: readyOk ? NapcatState.Ready : String(ready.state || (ready.kind === "webui" ? NapcatState.OnebotNotReady : NapcatState.StartTimeout)),
    needsUserAction: ready.kind === "webui",
    message: readyOk
      ? `已启动 NapCat：${instance.name || instance.id}`
      : ready.kind === "webui"
      ? `NapCat 后台已启动，但 OneBot 尚未就绪：${instance.name || instance.id}`
      : `NapCat 启动命令已执行，但后台未在超时时间内可达：${instance.name || instance.id}`,
    steps,
    health: ready,
    webui: instance.webuiUrl ? {
      url: instance.webuiUrl,
      ...(tokenInfo ? publicNapcatWebuiTokenInfo(tokenInfo) : {})
    } : undefined,
    launchCommand: plan.commandLine,
    stoppedPids: stopped,
    instance: {
      id: instance.id,
      name: instance.name,
      gatewayPort: instance.gatewayPort,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl
    }
  };
}

async function launchNapcatInstanceBound(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  return napcatLifecycleLock.run(
    napcatLifecycleKey(ctx, request),
    () => launchNapcatInstanceUnlocked(ctx, request)
  );
}

function napcatHealthUserId(health: NapcatEnsureHealth): string {
  return String(
    health.http?.userId
    || health.loginInfo?.userId
    || health.webui?.loginInfo?.userId
    || ""
  ).trim();
}

function napcatHealthMatchesInstance(instance: NapCatInstanceDefinition, health: NapcatEnsureHealth): boolean {
  if (health.ok !== true) return false;
  const expected = String(instance.botUserId || "").trim();
  const actual = napcatHealthUserId(health);
  return !expected || !actual || expected === actual;
}

async function recheckNapcatUntilReady(
  ctx: NapcatManagerContext,
  gatewayId: string,
  instance: NapCatInstanceDefinition,
  timeoutMs = 30000
): Promise<NapcatEnsureHealth> {
  const deadline = Date.now() + timeoutMs;
  let health = await testNapcatHealth(ctx, {
    gatewayId,
    instanceId: instance.id,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl,
    accessToken: instance.accessToken,
    webuiToken: instance.webuiToken,
    gatewayPort: instance.gatewayPort,
    readWebuiLoginInfo: true,
    inspectProcesses: false,
    botUserId: instance.botUserId
  }) as NapcatEnsureHealth;
  while (!napcatHealthMatchesInstance(instance, health) && Date.now() < deadline) {
    await wait(1500);
    health = await testNapcatHealth(ctx, {
      gatewayId,
      instanceId: instance.id,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl,
      accessToken: instance.accessToken,
      webuiToken: instance.webuiToken,
      gatewayPort: instance.gatewayPort,
      readWebuiLoginInfo: true,
      inspectProcesses: false,
      botUserId: instance.botUserId
    }) as NapcatEnsureHealth;
  }
  return health;
}

async function ensureNapcatInstanceReadyBound(
  ctx: NapcatManagerContext,
  request: NapcatEnsureReadyRequest
): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少路由或 QQ 实例信息。");
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) throw new Error("当前路由未加载，请刷新页面后重试。");
  const instance = napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId);
  if (!instance) throw new Error("没有找到这个 QQ 实例，请刷新页面后重试。");

  const healthRequest: NapcatHealthRequest = {
    gatewayId,
    instanceId,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl,
    accessToken: instance.accessToken,
    webuiToken: instance.webuiToken,
    gatewayPort: instance.gatewayPort,
    readWebuiLoginInfo: false,
    inspectProcesses: false,
    botUserId: instance.botUserId
  };
  const steps: string[] = [];
  let health = await testNapcatHealth(ctx, healthRequest) as NapcatEnsureHealth;
  if (napcatHealthMatchesInstance(instance, health)) {
    health = { ...health, loginState: NapcatState.Ready };
    return {
      ok: true,
      state: NapcatState.Ready,
      message: "NapCat 已就绪。",
      health,
      steps
    };
  }

  const expectedUserId = String(instance.botUserId || "").trim();
  const accountOwner = await findNapcatAccountOwner(ctx, expectedUserId, instance);
  if (accountOwner) {
    const message = `QQ ${expectedUserId} 已在另一 NapCat 实例在线；已保留现有登录，不会启动重复实例。`;
    health = {
      ...health,
      loginState: NapcatState.AccountOnlineElsewhere,
      accountOwner,
      message
    };
    steps.push(
      `已发现在线账号归属：${accountOwner.instanceName || accountOwner.workingDir || accountOwner.httpUrl}。`,
      accountOwner.routesToGateway
        ? "该实例已指向当前 RabiRoute 网关，可以采用它作为当前 QQ 入口。"
        : "该实例尚未指向当前 RabiRoute 网关；采用前需要检查 OneBot WebSocket 路由。"
    );
    ctx.appendLog(runtime, `preserve NapCat account owner for ${expectedUserId}: ${accountOwner.httpUrl} routesToGateway=${accountOwner.routesToGateway}`);
    return {
      ok: false,
      state: NapcatState.AccountOnlineElsewhere,
      needsUserAction: true,
      message,
      accountOwner,
      health,
      steps
    };
  }

  if (health.webui?.reachable !== true) {
    const launch = await launchNapcatInstance(ctx, {
      gatewayId,
      instanceId,
      forceRestart: false,
      visible: false
    });
    steps.push(...((launch.steps as string[] | undefined) ?? []));
    if (launch.ok === false && launch.needsUserAction !== true) {
      return { ...launch, health: { ...health, state: launch.state, loginState: launch.state }, steps };
    }
    health = await testNapcatHealth(ctx, healthRequest) as NapcatEnsureHealth;
    if (napcatHealthMatchesInstance(instance, health)) {
      health = { ...health, loginState: NapcatState.Ready };
      return {
        ok: true,
        state: NapcatState.Ready,
        message: "NapCat 已启动并就绪。",
        health,
        steps
      };
    }
  }

  if (health.webui?.reachable !== true) {
    return {
      ok: false,
      state: NapcatState.StartFailed,
      needsUserAction: false,
      message: "NapCat 暂时没有启动成功，请再点一次；仍失败时再查看详情。",
      health: { ...health, loginState: NapcatState.StartFailed },
      steps
    };
  }

  if (health.webui?.loginInfo == null) {
    health = await testNapcatHealth(ctx, {
      ...healthRequest,
      readWebuiLoginInfo: true
    }) as NapcatEnsureHealth;
    if (napcatHealthMatchesInstance(instance, health)) {
      health = { ...health, loginState: NapcatState.Ready };
      return {
        ok: true,
        state: NapcatState.Ready,
        message: "NapCat 已就绪。",
        health,
        steps
      };
    }
  }

  let webuiLoginInfo = health.webui?.loginInfo;
  if (webuiLoginInfo?.status === NapcatState.QrLoginRequired) {
    health = { ...health, loginState: NapcatState.QrLoginRequired };
    return {
      ok: false,
      state: NapcatState.QrLoginRequired,
      needsUserAction: true,
      message: "这个 QQ 没有可用的快速登录身份，请在当前登录卡片刷新二维码并扫码登录。",
      health,
      steps: [...steps, ...(webuiLoginInfo.message ? [webuiLoginInfo.message] : [])]
    };
  }
  const webuiUserId = String(webuiLoginInfo?.userId || "").trim();
  if (webuiLoginInfo?.online === true && expectedUserId && webuiUserId && expectedUserId !== webuiUserId) {
    return {
      ok: false,
      state: NapcatState.AccountMismatch,
      needsUserAction: true,
      message: "这个 NapCat 当前登录了另一个 QQ，请在当前登录卡片切换到正确账号。",
      health: { ...health, loginState: NapcatState.AccountMismatch },
      steps
    };
  }

  if (webuiLoginInfo?.online !== true
    && webuiLoginInfo?.status === NapcatState.QuickLoginAvailable
    && expectedUserId
    && webuiUserId === expectedUserId
    && health.webui?.reachable === true) {
    const webuiUrl = String(health.webui.url || instance.webuiUrl || "").trim();
    const tokenInfo = readNapcatWebuiToken(ctx, webuiUrl, instance.webuiToken, [instance]);
    const quickLogin = await requestNapcatQuickLogin(webuiUrl, tokenInfo, expectedUserId);
    if (quickLogin.ok) {
      steps.push("已自动选择并登录绑定的 QQ。");
      health = await recheckNapcatUntilReady(ctx, gatewayId, instance, 30000);
      webuiLoginInfo = health.webui?.loginInfo;
      if (napcatHealthMatchesInstance(instance, health)) {
        health = { ...health, loginState: NapcatState.Ready };
        return {
          ok: true,
          state: NapcatState.Ready,
          message: "QQ 已登录，NapCat 已就绪。",
          health,
          steps
        };
      }
    } else {
      if (quickLogin.message) steps.push(quickLogin.message);
      if (quickLogin.state === NapcatState.QuickLoginInvalid) {
        health = { ...health, loginState: NapcatState.QuickLoginInvalid };
        return {
          ok: false,
          state: NapcatState.QuickLoginInvalid,
          needsUserAction: true,
          message: "NapCat 保存的快速登录身份已失效，请在当前登录卡片选择“扫码登录”完成一次登录。",
          health,
          steps
        };
      }
      if (quickLogin.state === NapcatState.LoginConflict) {
        webuiLoginInfo = {
          ...webuiLoginInfo,
          status: NapcatState.LoginConflict,
          message: quickLogin.message
        };
      }
    }
  }

  const loggedInUserId = String(webuiLoginInfo?.userId || "").trim();
  const correctAccountLoggedIn = webuiLoginInfo?.online === true
    && (!expectedUserId || !loggedInUserId || loggedInUserId === expectedUserId);
  if (correctAccountLoggedIn && health.ok !== true) {
    try {
      const configured = await configureNapcatOneBot(ctx, healthRequest);
      steps.push(...((configured.steps as string[] | undefined) ?? []));
      health = await recheckNapcatUntilReady(ctx, gatewayId, instance, 18000);
      if (napcatHealthMatchesInstance(instance, health)) {
        health = { ...health, loginState: NapcatState.Ready };
        return {
          ok: true,
          state: NapcatState.Ready,
          message: "NapCat 已自动修复并就绪。",
          health,
          steps
        };
      }
    } catch (error) {
      steps.push(error instanceof Error ? error.message : String(error));
    }
  }

  const conflict = webuiLoginInfo?.status === NapcatState.LoginConflict;
  health = { ...health, loginState: conflict ? NapcatState.LoginConflict : NapcatState.ManualLogin };
  return {
    ok: false,
    state: conflict ? NapcatState.LoginConflict : NapcatState.ManualLogin,
    needsUserAction: true,
    message: conflict
      ? "这个 QQ 已在其他窗口登录。请先退出那个账号，再点一次。"
      : "请在当前登录卡片完成一次 QQ 登录或安全确认，完成后会自动接通。",
    health,
    steps
  };
}

export type NapcatStartupAutoLoginResult = {
  gatewayId: string;
  instanceId: string;
  ok: boolean;
  state: string;
  message?: string;
};

type NapcatEnsureReadyRunner = (
  ctx: NapcatManagerContext,
  request: NapcatEnsureReadyRequest
) => Promise<Record<string, unknown>>;

export async function autoLoginNapcatInstancesOnRabiStart(
  ctx: NapcatManagerContext,
  ensureReady: NapcatEnsureReadyRunner = ensureNapcatInstanceReady,
  signal?: AbortSignal
): Promise<NapcatStartupAutoLoginResult[]> {
  if (signal?.aborted) return [];
  const groups = new Map<string, Array<{ runtime: GatewayRuntime; instance: NapCatInstanceDefinition }>>();
  for (const runtime of ctx.getRuntimes()) {
    if (signal?.aborted) break;
    if (!runtimeUsesNapcat(runtime.definition) || runtime.definition.enabled === false) continue;
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      if (signal?.aborted) break;
      if (instance.enabled === false || instance.autoLoginOnRabiStart === false) continue;
      const botUserId = String(instance.botUserId || "").trim();
      const key = botUserId ? `qq:${botUserId}` : `instance:${runtime.definition.id}:${instance.id}`;
      const group = groups.get(key) ?? [];
      group.push({ runtime, instance });
      groups.set(key, group);
    }
  }

  const groupedResults = await Promise.all([...groups.values()].map(async (group) => {
    const results: NapcatStartupAutoLoginResult[] = [];
    if (signal?.aborted) return results;
    for (const { runtime, instance } of group) {
      if (signal?.aborted) break;
      try {
        if (signal?.aborted) break;
        const result = await ensureReady(ctx, {
          gatewayId: runtime.definition.id,
          instanceId: instance.id
        });
        const state = String(result.state || (result.ok === true ? NapcatState.Ready : "unknown"));
        const message = typeof result.message === "string" ? result.message : undefined;
        ctx.appendLog(runtime, `startup auto login instance ${instance.id}: ${state}${message ? ` (${message})` : ""}`);
        results.push({
          gatewayId: runtime.definition.id,
          instanceId: instance.id,
          ok: result.ok === true,
          state,
          message
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.appendLog(runtime, `startup auto login instance ${instance.id}: error (${message})`);
        results.push({
          gatewayId: runtime.definition.id,
          instanceId: instance.id,
          ok: false,
          state: "error",
          message
        });
      }
    }
    return results;
  }));
  return groupedResults.flat();
}

async function restartNapcatInstanceUnlocked(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  if (!ctx.stopOwnedInstanceForRestart) throw new Error("NapCat 进程归属管理尚未就绪，不能停止实例。");
  await ctx.stopOwnedInstanceForRestart(request);
  const result = await launchNapcatInstanceUnlocked(ctx, { ...request, forceRestart: false });
  return { ...result, steps: ["已核对实例归属并停止旧进程。", ...(Array.isArray(result.steps) ? result.steps : [])] };
}

async function restartNapcatInstanceBound(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  return napcatLifecycleLock.run(
    napcatLifecycleKey(ctx, request),
    () => restartNapcatInstanceUnlocked(ctx, request)
  );
}

async function stopNapcatInstanceUnlocked(ctx: NapcatManagerContext, request: NapcatStopRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId);
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }

  if (!ctx.stopOwnedInstance) throw new Error("NapCat 进程归属管理尚未就绪，不能停止实例。");
  await ctx.stopOwnedInstance(request);
  ctx.appendLog(runtime, `stop NapCat instance ${instance.id}: verified process ownership released`);
  return { ok: true, message: "NapCat 已退出并停止。", stoppedPids: [], failedPids: [] };
}

export async function stopNapcatInstance(ctx: NapcatManagerContext, request: NapcatStopRequest): Promise<Record<string, unknown>> {
  // The owner revokes and drains binding operations before stopping. Taking the
  // account lock here would deadlock a launch already queued under that owner.
  return stopNapcatInstanceUnlocked(ctx, request);
}

export function napcatStatusHasUsableConnection(status: Record<string, any>): boolean {
  const usable = (value: Record<string, any> | undefined): boolean =>
    value?.connected === true && value.online !== false && value.good !== false;
  const instances = status.napcatInstances;
  if (instances && typeof instances === "object") {
    return Object.values(instances).some((item) =>
      usable(item && typeof item === "object" ? item as Record<string, any> : undefined)
    );
  }
  return usable(status.napcat && typeof status.napcat === "object"
    ? status.napcat as Record<string, any>
    : undefined);
}

export async function scanNapcatEndpoint(ctx: NapcatManagerContext): Promise<MessageAdapterScanResult> {
  const napcatProcesses = await detectNapcatProcesses();
  const runtimes = napcatRuntimes(ctx);
  const napcatInstances = runtimes.flatMap((runtime) => napcatInstancesFor(ctx, runtime));
  const napcatWebuiEndpointRows = await Promise.all(napcatInstances.map(async (instance) => ({
    label: `${instance.name || instance.id} WebUI`,
    url: instance.webuiUrl || "http://127.0.0.1:6099/webui",
    healthy: await ctx.checkHttpEndpoint(instance.webuiUrl || "http://127.0.0.1:6099/webui", 1200)
  })));
  const napcatWebuiEndpoints = [...napcatWebuiEndpointRows.reduce((byUrl, endpoint) => {
    const existing = byUrl.get(endpoint.url);
    if (!existing || endpoint.healthy) byUrl.set(endpoint.url, endpoint);
    return byUrl;
  }, new Map<string, AdapterEndpoint>()).values()];
  const napcatWebuiToken = readNapcatWebuiToken(ctx, napcatWebuiEndpoints[0]?.url || "http://127.0.0.1:6099/webui");
  const napcatConnected = runtimes.some((runtime) =>
    napcatStatusHasUsableConnection((runtime.status ?? {}) as Record<string, any>)
  );

  return {
    type: "napcat",
    label: "NapCat / OneBot",
    maturity: "verified",
    installed: napcatProcesses.length > 0 || napcatWebuiEndpoints.some((endpoint) => endpoint.healthy),
    installCandidates: [
      { label: "NapCatQQ Shell / Windows 安装文档", url: "https://www.napcat.wiki/guide/boot/Shell" },
      { label: "NapCatQQ Releases", url: "https://github.com/NapNeko/NapCatQQ/releases" }
    ],
    endpoints: napcatWebuiEndpoints,
    requirements: [
      { id: "process", label: "NapCat 或 QQNT 后台进程", required: true, ok: napcatProcesses.length > 0, detail: napcatProcesses.length ? napcatProcesses.slice(0, 3).map(item => `${item.name}(${item.pid})`).join(", ") : "未发现本机 NapCat/QQNT 进程。" },
      { id: "route", label: "RabiRoute NapCat WS 入口", required: true, ok: runtimes.some((runtime) => Boolean(runtime.process)), detail: runtimes.length ? "已配置 NapCat 消息端。" : "还没有路由启用 NapCat。" },
      { id: "login", label: "OneBot 登录资料", required: true, ok: napcatConnected, detail: napcatConnected ? "已读取到连接或登录资料。" : "尚未看到 WS 连接或 get_login_info 成功。" },
      { id: "webui", label: "NapCat 管理服务可访问", required: false, ok: napcatWebuiEndpoints.some((endpoint) => endpoint.healthy), detail: "由 RabiRoute 后端代理登录与 OneBot 配置，不需要打开 NapCat WebUI。" },
      { id: "webui-token", label: "NapCat WebUI 登录 Token", required: true, ok: napcatWebuiToken.found, detail: napcatWebuiToken.found ? `已从 ${napcatWebuiToken.configPath} 读取到 ${napcatWebuiToken.tokenLength} 位登录密钥。` : napcatWebuiToken.message }
    ],
    warnings: [
      ...(napcatConnected ? [] : ["可在 Route 的 NapCat 卡片中写入并应用对应的 OneBot HTTP/WS 配置。"]),
      "一个 Route 只绑定一个 NapCat；需要另一个 QQ 时请新建另一个 Route。"
    ]
  };
}

export function runNapcatLoginAction(ctx: NapcatManagerContext, request: NapcatLoginActionRequest): Promise<Record<string, unknown>> {
  return runBoundNapcatOperation(ctx, request, () => runNapcatLoginActionBound(ctx, request));
}

export function configureNapcatOneBot(ctx: NapcatManagerContext, request: NapcatConfigureRequest): Promise<Record<string, unknown>> {
  return runBoundNapcatOperation(ctx, request, () => configureNapcatOneBotBound(ctx, request));
}

export function ensureNapcatInstanceReady(ctx: NapcatManagerContext, request: NapcatEnsureReadyRequest): Promise<Record<string, unknown>> {
  return runBoundNapcatOperation(ctx, request, () => ensureNapcatInstanceReadyBound(ctx, request));
}

export function launchNapcatInstance(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  return runBoundNapcatOperation(ctx, request, () => launchNapcatInstanceBound(ctx, request));
}

export function restartNapcatInstance(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  return runBoundNapcatOperation(ctx, request, () => restartNapcatInstanceBound(ctx, request));
}
