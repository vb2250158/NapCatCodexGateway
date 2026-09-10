import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const bridge = read("src", "codexDesktopBridge.ts");
const runtime = read("src", "codexRuntime.ts");
const sessionResolver = read("src", "codexSessionResolver.ts");
const manager = read("src", "manager", "controlPlaneRoutes.ts");
const overview = read("ribiwebgui", "src", "pages", "OverviewPage.vue");
const routeConfig = read("ribiwebgui", "src", "pages", "RouteConfigPage.vue");
const quickSetup = read("ribiwebgui", "src", "components", "QuickSetupDialog.vue");
const gatewayStore = read("ribiwebgui", "src", "stores", "gatewayStore.ts");
const sessionBinding = read("src", "shared", "codexSessionBinding.ts");
const sessionInitialization = read("src", "shared", "codexSessionInitialization.ts");
const runtimeLog = read("ribiwebgui", "src", "pages", "RuntimeLogPage.vue");
const adapterSkill = read("skills", "create-rabiroute-agent-adapter", "SKILL.md");
const ownerFirstGate = read("skills", "create-rabiroute-agent-adapter", "references", "owner-first-design-gate.md");
const packageJson = JSON.parse(read("package.json"));
const nestedDist = path.join(root, "dist", "src");
const builtAgentThreadsPath = path.join(root, "dist", "agentThreads.js");

assert.match(bridge, /CODEX_DESKTOP_IPC_PATH[\s\S]*codex-ipc/);
assert.match(bridge, /thread-follower-start-turn/);
assert.match(bridge, /thread-follower-steer-turn/);
assert.match(bridge, /codex:\/\/threads\//);
assert.match(bridge, /不会启动备用 Runtime/);
assert.match(bridge, /no rollout found for thread id/);
assert.match(runtime, /desktopBridge\.deliver/);
assert.match(runtime, /resolveAndDeliverCodexSession/);
assert.match(sessionResolver, /resolveCodexSession/);
assert.match(sessionResolver, /dependencies\.deliver/);
assert.match(sessionResolver, /if \(exact\)/);
assert.match(sessionResolver, /if \(!exact\.archived\) return \{ kind: "id", thread: exact \}/);
assert.doesNotMatch(sessionResolver, /if \(exact\.cwd[\s\S]{0,200}workspace-mismatch/,
  "An exact task ID must not be rejected because its saved cwd differs from the next turn workspace.");
assert.match(sessionResolver, /reason: "archived"/);
assert.match(sessionResolver, /previousThread: exact/);
assert.ok(sessionResolver.indexOf('reason: "archived"') < sessionResolver.indexOf("const matches ="),
  "An archived saved binding must create a new task before any same-name lookup can reuse another task.");
assert.doesNotMatch(sessionResolver, /exact\.title\s*===\s*params\.title/,
  "Mutable Desktop/SQLite title metadata must not invalidate a stable task ID binding.");
assert.match(runtime, /bootstrapEmptyDesktopThread/);
assert.match(runtime, /thread\/start/);
assert.doesNotMatch(runtime, /turn\/start|turn\/steer/);
assert.match(runtime, /codex_app_server_ws_url/);
assert.doesNotMatch(manager, /ensureCodexSharedRuntime|stopOwnedCodexSharedRuntime/);
for (const source of [overview, routeConfig, runtimeLog]) {
  assert.doesNotMatch(source, /app-server-stdio|app-server stdio|共用同一个 Runtime/);
}
assert.match(routeConfig, /Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime/);
assert.match(routeConfig, /createIfMissing:\s*false/);
assert.match(routeConfig, /initialize(?:Codex)?PlanAssistants[\s\S]*createIfMissing:\s*true/);
assert.doesNotMatch(routeConfig, /@blur="ensureCodexThreadBinding"/);
assert.doesNotMatch(gatewayStore, /bindAgentSessionsForSave/,
  "Ordinary Route saves must not resolve or create a Desktop task; explicit initialization owns that side effect.");
assert.match(sessionBinding, /createIfMissing:\s*true/);
assert.match(routeConfig, /initializeAgentSessionForRoute/);
assert.match(routeConfig, /\/api\/role-panel\/messages/);
assert.match(routeConfig, /自动初始化会话/);
assert.ok(sessionInitialization.indexOf("await params.save()") < sessionInitialization.indexOf("await params.deliver"),
  "Automatic persona initialization must persist the canonical binding before its first Desktop-owner delivery.");
assert.match(sessionInitialization, /角色文件/);
assert.match(sessionInitialization, /记忆与计划/);
assert.match(sessionInitialization, /Desktop owner/);
assert.match(routeConfig, /onMounted\(\(\) => \{ void runAgentScan\(\); \}\)/);
assert.equal((routeConfig.match(/runAgentScan\(\)/g) ?? []).length, 2,
  "Route settings may scan only in the function declaration and its one page-entry trigger; refresh buttons call it by reference.");
assert.equal((quickSetup.match(/runAgentScan\(\)/g) ?? []).length, 2,
  "Quick setup may scan only in the function declaration and when the dialog is entered.");
assert.equal(packageJson.scripts["configure:codex-desktop"], undefined);
assert.equal(packageJson.scripts["codex:shared"], undefined);
assert.match(adapterSkill, /冻结用户可观察合同/);
assert.match(adapterSkill, /一个 adapter 只能有一条真实消息执行路径/);
assert.match(adapterSkill, /完整任务 ID 是任务身份/);
assert.match(adapterSkill, /项目和会话扫描只允许在进入设置界面时自动执行一次/);
assert.match(adapterSkill, /自动初始化会话/);
assert.match(ownerFirstGate, /同一 session ID ≠ 同一 live task owner/);
assert.match(ownerFirstGate, /RabiRoute event -> adapter -> transport -> exact session\/task owner -> turn -> observable result/);
assert.equal(fs.existsSync(nestedDist), false, "Backend build must not leave a shadow dist/src runtime tree.");
if (fs.existsSync(builtAgentThreadsPath)) {
  assert.match(fs.readFileSync(builtAgentThreadsPath, "utf8"), /codexSessionResolver/,
    "The runnable dist/agentThreads.js must contain the canonical resolver.");
}

console.log("Codex adapter contract OK: Desktop IPC is the only real-message owner; full task ID identifies an existing task while each delivery supplies its workspace; archived bindings create and persist a new task without same-name reuse.");
