import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startManagerStallDiagnostics } from "./managerStallDiagnostics.js";
import { projectDirectoryLayout } from "./shared/projectDirectoryLayout.js";

type RuntimeEventKind =
  | "process_start"
  | "startup_cpu_sample"
  | "startup_failure"
  | "uncaught_exception"
  | "process_exit";

export type ManagerRuntimeEvent = {
  schemaVersion: 1;
  eventId: string;
  time: string;
  event: RuntimeEventKind;
  pid: number;
  parentPid: number;
  uptimeMs: number;
  nodeVersion: string;
  platform: NodeJS.Platform;
  exitCode?: number;
  cpuSample?: Parameters<Parameters<typeof startManagerStallDiagnostics>[0]>[0];
  error?: {
    name: string;
    message: string;
    code?: string;
    syscall?: string;
    path?: string;
    stack?: string;
  };
};

export type ManagerRuntimeDiagnosticsOptions = {
  rootDir: string;
  now?: () => Date;
  pid?: number;
  parentPid?: number;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  uptime?: () => number;
};

export type ManagerRuntimeDiagnostics = {
  startedAt: string;
  logDirectory: string;
  record(event: RuntimeEventKind, detail?: { error?: unknown; exitCode?: number; cpuSample?: ManagerRuntimeEvent["cpuSample"] }): ManagerRuntimeEvent | null;
  summary(): {
    pid: number;
    parentPid: number;
    startedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: NodeJS.Platform;
    logShard: string;
  };
};

let installedDiagnostics: ManagerRuntimeDiagnostics | null = null;

function redactedText(value: unknown, projectRoot: string): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const variants = new Set([
    projectRoot,
    projectRoot.replace(/\\/g, "/"),
    projectRoot.replace(/\//g, "\\")
  ]);
  let redacted = raw;
  for (const variant of variants) {
    if (variant) redacted = redacted.split(variant).join("<projectRoot>");
  }
  return redacted;
}

function safeError(error: unknown, projectRoot: string): ManagerRuntimeEvent["error"] {
  const candidate = error as NodeJS.ErrnoException & { path?: unknown };
  const errorObject = error instanceof Error ? error : new Error(String(error));
  const rawPath = String(candidate?.path ?? "").trim();
  let safePath = "";
  if (rawPath) {
    const relative = path.relative(projectRoot, rawPath);
    safePath = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative.replace(/\\/g, "/")
      : `<external>/${path.basename(rawPath)}`;
  }
  return {
    name: errorObject.name || "Error",
    message: redactedText(errorObject.message, projectRoot).slice(0, 4_000),
    code: String(candidate?.code ?? "").trim() || undefined,
    syscall: String(candidate?.syscall ?? "").trim() || undefined,
    path: safePath || undefined,
    stack: redactedText(errorObject.stack, projectRoot).slice(0, 16_000) || undefined
  };
}

function shardName(now: Date): string {
  return `manager-runtime-${now.toISOString().slice(0, 10)}.jsonl`;
}

export function createManagerRuntimeDiagnostics(
  options: ManagerRuntimeDiagnosticsOptions
): ManagerRuntimeDiagnostics {
  const projectRoot = path.resolve(options.rootDir);
  const logDirectory = projectDirectoryLayout(projectRoot).managerLogRoot;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;
  const nodeVersion = options.nodeVersion ?? process.version;
  const platform = options.platform ?? process.platform;
  const uptime = options.uptime ?? (() => process.uptime());
  const startupTime = now();
  const startedAt = startupTime.toISOString();
  let currentLogShard = shardName(startupTime);

  const diagnostics: ManagerRuntimeDiagnostics = {
    startedAt,
    logDirectory,
    record(event, detail = {}) {
      const recordedAt = now();
      currentLogShard = shardName(recordedAt);
      const record: ManagerRuntimeEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        time: recordedAt.toISOString(),
        event,
        pid,
        parentPid,
        uptimeMs: Math.max(0, Math.round(uptime() * 1_000)),
        nodeVersion,
        platform,
        exitCode: Number.isInteger(detail.exitCode) ? detail.exitCode : undefined,
        cpuSample: detail.cpuSample,
        error: detail.error === undefined ? undefined : safeError(detail.error, projectRoot)
      };
      try {
        fs.mkdirSync(logDirectory, { recursive: true });
        fs.appendFileSync(path.join(logDirectory, currentLogShard), `${JSON.stringify(record)}\n`, "utf8");
        return record;
      } catch (writeError) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        process.stderr.write(`[RabiRoute Manager diagnostics] failed to persist ${event}: ${message}\n`);
        return null;
      }
    },
    summary() {
      return {
        pid,
        parentPid,
        startedAt,
        uptimeSeconds: Math.max(0, Math.round(uptime())),
        nodeVersion,
        platform,
        logShard: currentLogShard
      };
    }
  };

  return diagnostics;
}

export function installManagerRuntimeDiagnostics(
  options: ManagerRuntimeDiagnosticsOptions
): ManagerRuntimeDiagnostics {
  const diagnostics = createManagerRuntimeDiagnostics(options);
  diagnostics.record("process_start");
  const stopSampling = startManagerStallDiagnostics(cpuSample => diagnostics.record("startup_cpu_sample", { cpuSample }));
  process.on("uncaughtExceptionMonitor", (error) => {
    diagnostics.record("uncaught_exception", { error });
  });
  process.once("exit", (exitCode) => {
    stopSampling();
    diagnostics.record("process_exit", { exitCode });
  });
  installedDiagnostics = diagnostics;
  return diagnostics;
}

export function managerRuntimeDiagnosticsSummary(): ReturnType<ManagerRuntimeDiagnostics["summary"]> | null {
  return installedDiagnostics?.summary() ?? null;
}
