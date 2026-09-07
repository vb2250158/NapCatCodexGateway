import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWindowsTaskkill } from "../runtime/windowsProcessTree.js";
import type { NapcatBinding, NapcatProcessDriver, NapcatProcessIdentity } from "./napcatLifecycleOwner.js";

const execute = promisify(execFile);
export async function napcatProcessSnapshot(): Promise<NapcatProcessIdentity[]> {
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.CreationDate} | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath} })"
    ], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return (JSON.parse(stdout || "[]") as NapcatProcessIdentity[]).map(item => ({ ...item,
      napcatRoot: path.basename(item.executable).toLowerCase() === "napcatwinbootmain.exe"
        && fs.existsSync(path.join(path.dirname(item.executable), "NapCatWinBootHook.dll"))
        && ["QQ.exe", "napcat.mjs"].some(file => fs.existsSync(path.join(path.dirname(item.executable), file)))
    }));
  }
  if (process.platform !== "linux") throw new Error("NapCat process ownership is unsupported on this platform.");
  const result: NapcatProcessIdentity[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      result.push({ pid: Number(entry), parentPid: Number(fields[1]), startedAt: fields[19]!, executable: fs.readlinkSync(`/proc/${entry}/exe`) });
    } catch { /* Process exited or is not inspectable by this account. */ }
  }
  return result;
}

export function createNapcatProcessDriver(requestExit?: (binding: NapcatBinding) => Promise<void>): NapcatProcessDriver {
  return {
    snapshot: napcatProcessSnapshot,
    async requestExit(binding, processes) {
      if (!requestExit || process.platform !== "win32" || !binding.httpUrl) return;
      const url = new URL(binding.httpUrl);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return;
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`
      ], { windowsHide: true, timeout: 5000 });
      const owners = JSON.parse(stdout || "[]") as number[];
      const current = await napcatProcessSnapshot();
      if (owners.some(pid => processes.some(item => item.pid === pid && current.some(live => live.pid === pid
        && live.startedAt === item.startedAt && live.executable === item.executable)))) await requestExit(binding);
    },
    async terminate(target) {
      const current = (await napcatProcessSnapshot()).find(item => item.pid === target.pid);
      if (!current || current.startedAt !== target.startedAt || path.resolve(current.executable).toLowerCase() !== path.resolve(target.executable).toLowerCase()) return;
      try {
        if (process.platform === "win32") await runWindowsTaskkill(target.pid);
        else process.kill(target.pid, "SIGKILL");
      } catch (error) {
        if ((await napcatProcessSnapshot()).some(item => item.pid === target.pid && item.startedAt === target.startedAt)) throw error;
      }
    }
  };
}
