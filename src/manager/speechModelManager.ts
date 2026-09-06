import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { configuredModelPaths, modelFilesPresent, speechConfigPath } from "./speechModelFiles.js";
import { SpeechModelSettingsStore } from "./speechModelSettings.js";
import type {
  SpeechManagedModel,
  SpeechManagedModelCapability,
  SpeechManagedModelRuntime,
  SpeechModelManagementJob,
  SpeechModelManagementSnapshot
} from "../shared/speechModelManagement.js";

type CatalogModel = {
  alias: string;
  capability: SpeechManagedModelCapability;
  name: string;
  family: string;
  kind: "huggingface" | "file";
  repository?: string;
  download_url?: string;
  download_mode?: string;
  target: string;
  size_gib?: number;
  runtime: SpeechManagedModelRuntime;
  purpose_zh: string;
  purpose_en: string;
};

type CatalogPayload = {
  schema_version: number;
  models: CatalogModel[];
};

type InstallManifest = {
  models?: Array<{
    alias?: string;
    status?: string;
    error?: string;
  }>;
};

function defaultModelRoot(rootDir: string): string {
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  return localAppData
    ? path.join(localAppData, "RabiPC", "models", "rabispeech")
    : path.join(rootDir, "..", "models", "rabispeech");
}

export class SpeechModelManagerError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "SpeechModelManagerError";
  }
}

export type SpeechModelManagerOptions = {
  /** Immutable version package containing the speech adapter and catalog. */
  packageRoot?: string;
  /** Stable application state root used for models and mutable manifests. */
  rootDir: string;
  platform?: NodeJS.Platform;
  modelRoot?: string;
  spawnInstaller?: typeof spawn;
  onChange?: (snapshot: SpeechModelManagementSnapshot) => void;
};

export class SpeechModelManager {
  private readonly platform: NodeJS.Platform;
  private readonly pluginRoot: string;
  private readonly settingsStore: SpeechModelSettingsStore;
  private get modelRoot(): string { return this.directorySettings().effectiveModelRoot; }
  private readonly catalog: CatalogPayload;
  private readonly spawnInstaller: typeof spawn;
  private readonly onChange?: (snapshot: SpeechModelManagementSnapshot) => void;
  private activeChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private activeJob: SpeechModelManagementJob | undefined;
  private lastJob: SpeechModelManagementJob | undefined;
  private lastOutput = "";

  constructor(private readonly options: SpeechModelManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.pluginRoot = path.join(options.packageRoot ?? options.rootDir, "plugin-adapters", "rabi-speech");
    this.settingsStore = new SpeechModelSettingsStore(options.rootDir, [options.rootDir, options.packageRoot ?? options.rootDir]);
    this.catalog = this.readCatalog();
    this.spawnInstaller = options.spawnInstaller ?? spawn;
    this.onChange = options.onChange;
  }

  directorySettings() {
    return this.settingsStore.read(path.resolve(this.options.modelRoot || defaultModelRoot(this.options.rootDir)), this.options.modelRoot ? undefined : process.env.RABISPEECH_MODEL_ROOT?.trim());
  }

  updateDirectorySettings(body: unknown) {
    if (this.activeJob) throw new SpeechModelManagerError("安装或下载进行中，不能切换模型目录。", 409);
    this.settingsStore.write(body);
    this.publish();
    return this.directorySettings();
  }

  private runtimeRoot(): string {
    const statePlugin = path.join(this.options.rootDir, "plugin-adapters", "rabi-speech");
    return fs.existsSync(path.join(statePlugin, ".deps")) ? statePlugin : this.pluginRoot;
  }

  snapshot(): SpeechModelManagementSnapshot {
    const runtimeRoot = this.runtimeRoot();
    const configPath = speechConfigPath(runtimeRoot);
    const manifest = this.readManifest();
    const manifestRows = new Map((manifest.models ?? []).map(item => [String(item.alias || ""), item]));
    return {
      platformSupported: this.platform === "win32",
      dependenciesInstalled: fs.existsSync(path.join(runtimeRoot, ".deps")),
      windowsHostInstalled: fs.existsSync(path.join(runtimeRoot, "runtime", "RabiSpeech.exe")),
      catalogVersion: this.catalog.schema_version,
      models: this.catalog.models.map(model => {
        const manifestRow = manifestRows.get(model.alias);
        const downloaded = modelFilesPresent(path.join(this.modelRoot, ...model.target.split("/")), model)
          || configuredModelPaths(model, configPath).some(candidate => modelFilesPresent(candidate, { ...model, download_mode: undefined }));
        const downloading = this.activeJob?.kind === "model"
          && this.activeJob.modelAlias === model.alias
          && this.activeJob.state === "running";
        const status = downloading
          ? "downloading"
          : downloaded
            ? "downloaded"
            : manifestRow?.status === "failed"
              ? "failed"
              : "not_downloaded";
        const source = model.repository || model.download_url || "";
        return {
          alias: model.alias,
          capability: model.capability,
          name: model.name,
          family: model.family,
          source,
          sourceUrl: model.repository ? `https://huggingface.co/${model.repository}` : source,
          ...(Number.isFinite(model.size_gib) ? { sizeGiB: Number(model.size_gib) } : {}),
          runtime: model.runtime,
          purposeZh: model.purpose_zh,
          purposeEn: model.purpose_en,
          status,
          downloaded,
          ...(manifestRow?.error ? { lastError: this.safeMessage(manifestRow.error) } : {})
        } satisfies SpeechManagedModel;
      }),
      ...(this.activeJob ? { activeJob: { ...this.activeJob } } : {}),
      ...(this.lastJob ? { lastJob: { ...this.lastJob } } : {})
    };
  }

  installRuntime(): SpeechModelManagementSnapshot {
    this.assertWindows();
    return this.startJob({
      kind: "runtime",
      command: path.join(this.runtimeRoot(), "scripts", "install.ps1"),
      args: [],
      message: "正在安装 RabiSpeech 语音运行环境。"
    });
  }

  installModel(alias: string): SpeechModelManagementSnapshot {
    this.assertWindows();
    const normalized = alias.trim();
    if (!this.catalog.models.some(model => model.alias === normalized)) {
      throw new SpeechModelManagerError("未知的语音模型，未启动下载。", 404);
    }
    this.settingsStore.assertConfiguredRootSafe();
    const runtimeRoot = this.runtimeRoot();
    if (!fs.existsSync(path.join(runtimeRoot, ".deps"))) {
      throw new SpeechModelManagerError("请先在模型管理页安装语音运行环境，再下载模型。", 409);
    }
    return this.startJob({
      kind: "model",
      modelAlias: normalized,
      command: path.join(runtimeRoot, "scripts", "install_models.ps1"),
      args: [
        "-Model", normalized,
        "-ModelRoot", this.modelRoot,
        "-MaxWorkers", "2",
        "-DownloadTimeout", "600",
        "-EtagTimeout", "120"
      ],
      message: `正在下载 ${normalized}。`
    });
  }

  stop(): void {
    if (!this.activeChild || !this.activeJob) return;
    this.activeChild.kill();
    this.lastJob = {
      ...this.activeJob,
      state: "failed",
      finishedAt: new Date().toISOString(),
      message: "安装任务因 Manager 关闭而停止。",
      error: "manager_stopped"
    };
    this.activeChild = null;
    this.activeJob = undefined;
  }

  private startJob(input: {
    kind: "runtime" | "model";
    modelAlias?: string;
    command: string;
    args: string[];
    message: string;
  }): SpeechModelManagementSnapshot {
    if (this.activeJob) {
      throw new SpeechModelManagerError("已有语音安装或模型下载任务正在运行，请等待它结束。", 409);
    }
    if (!fs.existsSync(input.command)) {
      throw new SpeechModelManagerError("语音安装脚本不存在，无法启动任务。", 500);
    }
    const job: SpeechModelManagementJob = {
      id: randomUUID(),
      kind: input.kind,
      ...(input.modelAlias ? { modelAlias: input.modelAlias } : {}),
      state: "running",
      startedAt: new Date().toISOString(),
      message: input.message
    };
    this.activeJob = job;
    this.lastOutput = "";
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = this.spawnInstaller(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", input.command, ...input.args],
        {
          cwd: path.dirname(path.dirname(input.command)),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch (error) {
      this.lastJob = {
        ...job,
        state: "failed",
        finishedAt: new Date().toISOString(),
        message: "安装或下载没有启动。",
        error: this.safeMessage(error instanceof Error ? error.message : String(error))
      };
      this.activeJob = undefined;
      this.publish();
      throw new SpeechModelManagerError("安装程序没有启动，请查看最近任务中的错误。", 500);
    }
    this.activeChild = child;
    child.stdout.on("data", chunk => this.captureOutput(chunk));
    child.stderr.on("data", chunk => this.captureOutput(chunk));
    child.once("error", error => this.finishJob(1, this.safeMessage(error.message)));
    child.once("close", code => this.finishJob(code ?? 1));
    this.publish();
    return this.snapshot();
  }

  private finishJob(exitCode: number, launchError = ""): void {
    if (!this.activeJob) return;
    const failed = exitCode !== 0 || Boolean(launchError);
    this.lastJob = {
      ...this.activeJob,
      state: failed ? "failed" : "completed",
      finishedAt: new Date().toISOString(),
      message: failed
        ? "安装或下载没有完成。"
        : this.activeJob.kind === "runtime"
          ? "语音运行环境安装完成。"
          : `${this.activeJob.modelAlias} 下载完成。`,
      ...(failed ? { error: launchError || this.lastOutput || `exit_${exitCode}` } : {})
    };
    this.activeChild = null;
    this.activeJob = undefined;
    this.publish();
  }

  private captureOutput(chunk: unknown): void {
    const text = String(chunk || "").replace(/\u001b\[[0-9;]*m/g, "");
    const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    if (lines.length) this.lastOutput = this.safeMessage(lines.at(-1) || "");
  }

  private publish(): void {
    this.onChange?.(this.snapshot());
  }

  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new SpeechModelManagerError("模型管理页的一键安装当前只支持 Windows 主机。", 409);
    }
  }

  private readCatalog(): CatalogPayload {
    const catalogPath = path.join(this.pluginRoot, "model-catalog.json");
    const value = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Partial<CatalogPayload>;
    if (!Number.isInteger(value.schema_version) || !Array.isArray(value.models) || value.models.length === 0) {
      throw new Error("RabiSpeech model catalog is invalid.");
    }
    const aliases = new Set<string>();
    for (const model of value.models) {
      if (!model?.alias || aliases.has(model.alias) || !model.target || !model.name) {
        throw new Error("RabiSpeech model catalog contains an invalid model entry.");
      }
      aliases.add(model.alias);
    }
    return value as CatalogPayload;
  }

  private readManifest(): InstallManifest {
    const manifestPath = path.join(this.modelRoot, "install-manifest.json");
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as InstallManifest;
    } catch {
      return {};
    }
  }

  private safeMessage(value: string): string {
    const replacements = [
      [this.pluginRoot, "<speech-plugin>"],
      [this.modelRoot, "<model-root>"],
      [this.options.rootDir, "<app-root>"]
    ] as const;
    let output = value.replace(/[\r\n\t]+/g, " ").trim();
    for (const [source, replacement] of replacements) {
      if (!source) continue;
      output = output.replaceAll(source, replacement);
      output = output.replaceAll(source.replaceAll("\\", "/"), replacement);
    }
    return output.slice(0, 400);
  }
}
