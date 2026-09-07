<!-- docs-language-switch -->
<div align="center">
English | <a href="./getting-started.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Getting Started

> Status: current guide. Checked against the current Manager, RibiWebGUI, Codex Desktop owner, and NapCat setup flow. See [Current Capabilities](current-capabilities_en.md) before enabling experimental integrations.

## Requirements

- Node.js 20 or newer.
- A NapCat/OneBot environment for QQ. You can skip QQ if you only want to inspect RibiWebGUI or test heartbeat/manual events.
- Optional but recommended: Codex, the verified handler integration.

## Install and start

The Windows installer launches RabiRoute Host from the Start menu. Host creates same-generation Manager and tray children and passes the operating-system-assigned Manager URL to the tray; open RibiWebGUI from the tray. Repeated launch activates the existing Host.

For a full Windows source build, double-click `Start-RabiRoute-FromSource.bat` in the repository root. Requires an existing Windows RabiRoute installation, Node.js/npm, and the .NET 9 SDK. It builds Manager, WebGUI, plugins, Host, and the tray, then activates the source build through Host while retaining installed settings and data. The first build downloads Python/Qt dependencies. Closing the command window does not stop Host; quit from the tray. Failure logs are in `logs/source-start/`. If the dependency lock differs from the installed package, update the full installation first.

To run only the backend from source (without the tray):

Windows PowerShell:

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

macOS or Linux:

```bash
cd /path/to/RabiRoute
npm install
npm run build
npm run start:manager
```

Manager prints its actual address to stdout, for example:

```text
RabiRoute manager listening at <managerBaseUrl>
```

Use that run's `<managerBaseUrl>` instead of preserving one port as a permanent default. Other integrations retain their own configured endpoints:

- NapCat reverse WebSocket: `ws://127.0.0.1:8789`
- NapCat OneBot HTTP: `http://127.0.0.1:3000`

## First route

On a clean start, the Manager prefers copying the complete public `examples/data` package into `data/`. Only the `main` route is enabled by default; experimental examples remain disabled until credentials, ports, and workspaces are configured. If examples are unavailable, the Manager can still create a minimal QQ/NapCat-to-Codex setup.

In RibiWebGUI, check:

- **Message adapters**: NapCat/OneBot and heartbeat are the normal starting choices.
- **Handler**: choose Codex, a fixed thread name, and the project workspace.
- **Route**: verify WebSocket/HTTP ports, webhook settings, handler cwd, and role binding.
- **Role**: select or create a role such as the public `Rabi` example.
- **Persona automation**: use **When a message arrives / Scheduled tasks** to choose the trigger, then notify the Agent or run a persona script.

For manual `personaConfig.json` edits, see [Routing Configuration](routing-configuration_en.md).

To copy the examples manually:

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

For a QQ-free smoke test, enable Scheduled Tasks. Script actions also require the separate local Route permission.

## Codex setup

Codex is the verified handler path. Configure:

- `agentAdapters: ["codex"]`.
- `codexThreadId`: the opaque Desktop task ID saved by RibiWebGUI.
- `codexThreadName`: the visible task name, such as `QQ message listener`.
- `codexCwd`: the project directory in which Codex should work.

A valid saved Codex ID is the stable task identity, while the configured working directory controls the next turn. A different saved default cwd, Desktop rename, stale SQLite title, or completed goal does not create a duplicate. Typing a new name explicitly clears the old ID; only then may RabiRoute search by name and workspace or create an empty task.

Codex/ChatGPT Desktop must be running for real delivery. RabiRoute uses Desktop IPC and may deeplink an unloaded task before retrying. The project-pinned app-server is used only to create and name an empty task; it never executes a routed prompt.

## NapCat setup

In NapCat WebUI configure:

- WebSocket Client: `ws://127.0.0.1:8789`
- HTTP Server: host `127.0.0.1`, port `3000`

The WebSocket carries inbound QQ events. OneBot HTTP is used for replies and proactive sends. Restart or reload NapCat networking after changing its plugin/network settings when required.

For startup and quick-login behavior, see [Unattended NapCat](napcat-unattended_en.md). QQ credentials and verification never belong in a RabiRoute gateway definition.

## Chinese text on Windows

Avoid hand-building Chinese JSON with PowerShell `Invoke-WebRequest`; request encoding can be inconsistent. Use the project script:

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "Unicode test\nSecond line"
```

Validate route/role JSON with:

```powershell
npm run check:config
```

Use real line breaks in WebUI text areas. Let JSON serialization escape them once when saving.

## Verify the path

1. Start Host in the Windows package, or run `npm run start:manager` in source mode and record stdout `<managerBaseUrl>`.
2. Open RibiWebGUI from the tray or `<managerBaseUrl>` and confirm the route is running.
3. Confirm NapCat is connected to port 8789.
4. Mention the bot in a QQ group, send a private message, or run a heartbeat/manual trigger.
5. Inspect `data/route/<configName>/` for message and `agent-packets.jsonl` records.
6. For Codex, confirm the configured thread receives the packet.

## Development commands and entry points

```powershell
npm run build
npm run start:manager
npm run manager
```

- `src/manager.ts`: configuration, route-process lifecycle, and RibiWebGUI API.
- `src/index.ts`: one gateway subprocess.
- `src/adapters/`: message protocol adapters.
- `src/forwarding.ts`: rule evaluation, packet construction, and handler delivery.
- `src/history.ts`: JSONL records.
