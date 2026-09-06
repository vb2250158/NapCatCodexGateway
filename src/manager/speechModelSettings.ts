import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import type { SpeechModelDirectorySettings } from "../shared/speechModelManagement.js";

export class SpeechModelSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function validateModelRoot(value: unknown, protectedRoots: string[], fixedDrive?: (drive: string) => boolean): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024) throw new SpeechModelSettingsError("模型目录必须是本机绝对路径。");
  const raw = value.trim();
  if (!raw) return null;
  if (!/^[a-zA-Z]:[\\/]/.test(raw) || /[\x00-\x1f<>"|?*]/.test(raw) || raw.slice(2).includes(":")) throw new SpeechModelSettingsError("模型目录必须是本机磁盘绝对路径，不能使用网络、设备或相对路径。");
  if (raw.slice(3).split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) throw new SpeechModelSettingsError("模型目录包含不支持的路径段。");
  const normalized = path.win32.normalize(raw);
  if (normalized === path.win32.parse(normalized).root) throw new SpeechModelSettingsError("不能将整个磁盘作为模型目录。");
  let existing = normalized;
  while (!fs.existsSync(existing)) {
    const parent = path.win32.dirname(existing);
    if (parent === existing) throw new SpeechModelSettingsError("模型目录所在磁盘不可访问。");
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) throw new SpeechModelSettingsError("模型目录不能指向文件。");
  const real = fs.realpathSync.native(existing);
  if (!/^[a-zA-Z]:[\\/]/.test(real)) throw new SpeechModelSettingsError("模型目录不能通过链接指向网络或设备。");
  const resolved = path.win32.resolve(real, path.win32.relative(existing, normalized));
  const within = (candidate: string, root: string) => {
    const relative = path.win32.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  };
  for (const root of protectedRoots) {
    let canonical = root;
    try { canonical = fs.realpathSync.native(root); } catch { /* lexical exclusion still applies */ }
    if (within(normalized, root) || within(resolved, canonical)) throw new SpeechModelSettingsError("模型目录不能放在程序安装或源码目录内。");
  }
  for (let ancestor = real; ; ancestor = path.win32.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, ".git"))) throw new SpeechModelSettingsError("模型目录不能放在源码工作树内。");
    if (path.win32.dirname(ancestor) === ancestor) break;
  }
  const isFixed = fixedDrive ?? ((drive: string) => {
    const script = "$d=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:RABIROUTE_MODEL_DRIVE + [char]39); if($d.DriveType -eq 3){'fixed'}";
    try {
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true,
        env: { ...process.env, RABIROUTE_MODEL_DRIVE: drive }, stdio: ["ignore", "pipe", "ignore"]
      }).trim() === "fixed";
    } catch { return false; }
  });
  if (![...new Set([real.slice(0, 2).toUpperCase(), normalized.slice(0, 2).toUpperCase()])].every(isFixed)) throw new SpeechModelSettingsError("模型目录必须位于可验证的本机固定磁盘。");
  return normalized;
}

export class SpeechModelSettingsStore {
  private readonly filePath: string;
  constructor(private readonly rootDir: string, private readonly protectedRoots: string[], private readonly validate = validateModelRoot) {
    this.filePath = path.join(rootDir, "data", "speech", "model-directory-settings.json");
  }
  private readRecord(): { revision: number; modelRoot: string | null } {
    if (!fs.existsSync(this.filePath)) return { revision: 0, modelRoot: null };
    try {
      if (fs.statSync(this.filePath).size > 8192) throw new Error("oversize");
      const row = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Number.isSafeInteger(row.revision) || row.revision < 0 || (row.modelRoot !== null && typeof row.modelRoot !== "string")) throw new Error("invalid");
      return row;
    } catch { throw new SpeechModelSettingsError("模型目录设置无法读取，请恢复本机设置文件。", 500); }
  }
  read(defaultRoot: string, environmentRoot?: string): SpeechModelDirectorySettings {
    const row = this.readRecord();
    return { revision: row.revision, configuredModelRoot: row.modelRoot, effectiveModelRoot: row.modelRoot || environmentRoot || defaultRoot, defaultModelRoot: environmentRoot || defaultRoot, source: row.modelRoot ? "configured" : environmentRoot ? "environment" : "default" };
  }
  assertConfiguredRootSafe(): void {
    const row = this.readRecord();
    if (row.modelRoot) this.validate(row.modelRoot, this.protectedRoots);
  }
  write(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechModelSettingsError("模型目录设置格式无效。");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== "modelRoot" && key !== "expectedRevision") || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !("modelRoot" in body)) throw new SpeechModelSettingsError("需要模型目录和当前设置版本。");
    const modelRoot = this.validate(body.modelRoot, this.protectedRoots);
    withFileLockSync(`${this.filePath}.lock`, () => {
      const previous = this.readRecord();
      if (previous.revision !== body.expectedRevision) throw new SpeechModelSettingsError("模型目录设置已改变，请刷新后重试。", 409);
      if (previous.modelRoot === modelRoot) return;
      atomicWriteFileSync(this.filePath, `${JSON.stringify({ revision: previous.revision + 1, modelRoot }, null, 2)}\n`);
      recordDataMutationAudit({ group: "config.speech", event: "speech_model_directory_updated", owner: "SpeechModelSettingsStore", action: "write", target: { type: "speech_model_settings", id: "model-directory" }, dataSource: { kind: "file", id: "data/speech/model-directory-settings.json" }, outcome: "committed", changes: [{ field: "modelRoot" }] });
    });
  }
}
