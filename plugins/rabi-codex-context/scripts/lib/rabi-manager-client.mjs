import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 8000;

function discoverManagerUrlFromHost(env) {
  const candidates = [
    env.RABIROUTE_HOST_EXE,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "RabiRoute", "RabiRouteHost.exe")
  ].filter(Boolean);
  for (const executable of candidates) {
    if (!fs.existsSync(executable)) continue;
    const result = spawnSync(executable, ["--command", "status", "--json"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const descriptor = JSON.parse(result.stdout.trim());
      const baseUrl = String(descriptor.managerBaseUrl || descriptor.baseUrl || "").trim();
      if (/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) return baseUrl;
    } catch {
      // A stale or non-RabiRoute executable is not a discovery source.
    }
  }
  return "";
}

export function resolveManagerUrl(env = process.env) {
  const value = String(
    env.RABI_MANAGER_URL
    || env.RABI_CODEX_MANAGER_URL
    || discoverManagerUrlFromHost(env)
  )
    .trim()
    .replace(/\/+$/, "");
  if (!value) throw new Error("RabiRoute Host is not running and no explicit Manager URL was supplied.");
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, message: text };
  }
}

export async function requestManager(pathname, init = {}, options = {}) {
  if (pathname === "/api/codex-hook/context" && !options.managerUrl && !options.env) {
    const directory = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RabiAgent") : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "RabiAgent") : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "RabiAgent");
    const helper = path.join(directory, "hook-client.mjs");
    if (fs.existsSync(helper)) {
      const { requestInstanceHook } = await import(pathToFileURL(helper).href);
      const result = await requestInstanceHook(JSON.parse(init.body || "{}"), path.join(directory, "config.json"));
      if (result !== undefined) return result;
    }
  }
  const managerUrl = String(options.managerUrl || resolveManagerUrl(options.env)).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${managerUrl}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json; charset=utf-8" } : {}),
        ...init.headers
      },
      signal: controller.signal
    });
    const payload = await responseBody(response);
    if (!response.ok || payload?.code === -1) {
      throw new Error(String(payload?.message || `Rabi Manager request failed: HTTP ${response.status}`));
    }
    return payload?.data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Rabi Manager request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hookOutput(eventName, additionalContext, systemMessage) {
  if (!additionalContext) return null;
  return {
    ...(["SessionStart", "UserPromptSubmit"].includes(eventName) ? { continue: true } : {}),
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  };
}

function shouldExposeManagerFailure(input) {
  return String(input?.hook_event_name || "") === "SessionStart"
    || String(input?.prompt || "").toLowerCase().includes("[rabi:");
}

export async function handleHookInput(input, options = {}) {
  const eventName = String(input?.hook_event_name || "");
  if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(eventName)) return null;
  try {
    const data = await requestManager("/api/codex-hook/context", {
      method: "POST",
      body: JSON.stringify(input)
    }, options);
    if (eventName === "PreToolUse" && data?.toolDecision?.permissionDecision === "deny") {
      const reason = String(data.toolDecision.reason || "RabiRoute blocked this direct Agent task delivery.");
      return {
        systemMessage: reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      };
    }
    if (eventName === "Stop") {
      if (!input.stop_hook_active && data?.followup?.decision === "block" && data.followup.reason) {
        return { decision: "block", reason: String(data.followup.reason) };
      }
      const completion = data?.planTaskCompletion;
      const projectFileChangeReminder = data?.projectFileChangeReminder;
      const agentRequestStop = data?.agentRequestStop;
      const messages = [];
      if (agentRequestStop?.status === "failed") {
        messages.push(`Rabi Agent request Stop check failed: ${agentRequestStop.error || agentRequestStop.reason || "unknown error"}`);
      }
      if (projectFileChangeReminder?.status === "failed") {
        messages.push(`Rabi 项目文件改动后的计划检查提醒未完成：${projectFileChangeReminder.error || projectFileChangeReminder.reason || "unknown error"}`);
      }
      if (projectFileChangeReminder?.status === "delivered") {
        messages.push("本轮已修改项目文件。请检查绑定计划的 status、currentStep、steps、证据和附件是否需要按实际进展更新；RabiRoute 没有自动修改计划。");
      }
      if (completion?.status === "failed") {
        messages.push(`Rabi plan-task completion reminder failed: ${completion.error || completion.reason || "unknown error"}`);
      }
      return messages.length > 0 ? { systemMessage: messages.join("\n") } : null;
    }
    return hookOutput(eventName, String(data?.additionalContext || ""));
  } catch (error) {
    if (eventName === "Stop") {
      const message = error instanceof Error ? error.message : String(error);
      return { systemMessage: `Rabi 计划完成提醒或项目文件改动检查提醒未送达：${message}` };
    }
    if (!shouldExposeManagerFailure(input)) return null;
    const message = error instanceof Error ? error.message : String(error);
    return hookOutput(
      eventName,
      `[Rabi Codex]\nRabi PC Manager 当前不可用：${message}\n本轮没有注入人格、计划、记忆或角色技能；不得使用插件本地缓存补造上下文。`,
      "Rabi PC context service is unavailable; Codex continued without invented Rabi context."
    );
  }
}
