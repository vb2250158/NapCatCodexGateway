import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const execute = promisify(execFile);
type RunInstaller = (args: string[]) => Promise<unknown>;
const pending = new Map<string, Promise<{ message: string }>>();

/** Install only the Rabi context plugin through the Agent's own plugin manager. */
export function updateAgentHooks(rootDir: string, adapter: string, run?: RunInstaller): Promise<{ message: string }> {
  if (adapter !== "codex" && adapter !== "dsh") return Promise.reject(new Error("当前 Agent 尚未提供 Hook 更新安装包。"));
  const key = `${path.resolve(rootDir)}:${adapter}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    let cli = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const bundleRoot = path.join(rootDir, "dist", "agent-hooks");
    const packageRoot = path.join(bundleRoot, "plugins", adapter === "codex" ? "rabi-codex-context" : "rabi-dsh-context");
    const manifest = path.join(packageRoot, adapter === "codex" ? ".codex-plugin/plugin.json" : "package.json");
    if (adapter === "dsh" && !run) {
      const profileRequire = createRequire(path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "web", "package.json"));
      try { cli = path.join(path.dirname(profileRequire.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js"); }
      catch { throw new Error("未找到本机 DSH web profile 的 CLI，请先安装并配置 DSH。"); }
    }
    if (!run && (!fs.existsSync(cli) || !fs.existsSync(manifest))) {
      throw new Error("当前安装缺少 Codex Hook 安装包，请更新 RabiRoute 安装包后重试。");
    }
    const invoke = run ?? ((args: string[]) => execute(process.execPath, [cli, ...args], {
      cwd: rootDir, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024
    }));
    if (adapter === "codex") {
      await invoke(["plugin", "marketplace", "add", bundleRoot]);
      await invoke(["plugin", "add", "rabi-codex-context@rabiroute-local", "--json"]);
    } else {
      await invoke(["plugin", "--profile", "web", "add", packageRoot]);
    }
    recordDataMutationAudit({ group: "config", event: "agent_hooks_updated", owner: "agent-hook-installer",
      action: "update-hooks", dataSource: { kind: "file", id: `plugins/rabi-${adapter}-context` }, target: { type: "agent", id: adapter }, outcome: "committed" });
    return { message: adapter === "codex"
      ? "Hook 已更新到 Codex。新任务加载插件后，在 /hooks 中审阅信任命令。"
      : "Hook 已更新到本机 DSH web profile，重新加载该插件或重启 DSH 后生效。" };
  })().catch(error => {
    recordDataMutationAudit({ group: "config", event: "agent_hooks_update_failed", owner: "agent-hook-installer",
      action: "update-hooks", dataSource: { kind: "file", id: "plugins/rabi-codex-context" }, target: { type: "agent", id: adapter }, outcome: "failed", error });
    throw error;
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
