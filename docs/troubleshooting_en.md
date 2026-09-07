<!-- docs-language-switch -->
<div align="center">
English | <a href="./troubleshooting.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Troubleshooting

## Transient Manager degradation

Search `logs/manager/manager-operations-YYYY-MM-DD.jsonl` for `manager_watch_degraded` and `manager_watch_recovered`. `source=config` identifies configuration watching; `source=plugin_tree` identifies plugin-directory watching. Records include child PID, attempt, duration, timeout limit, cumulative timeouts and restarts, and last success time. Failures include redacted error details and stacks. Ordinary unchanged refreshes do not repeat records, and recovery preserves earlier failures in the log. `operationId` identifies the Manager instance, watcher, and scan attempt.

Rediscover the current Manager address through Host, then read `/meta` for current health. Historical timeout counters do not mean the application is still degraded.

> Status: current guide. The formal Codex path is Desktop IPC plus the target task owner; real messages do not use a shared port, per-route stdio process, or fallback Runtime.

## Forwarded QQ messages show only an ID or `[object Object]`

RabiRoute resolves NapCat `forward` segments through OneBot `get_forward_msg`. On success, it keeps the outer content in `originalRawMessage`, writes expanded text to `rawMessage`, and stores structured `forwardedMessages` nodes.

If resolution fails, the outer message is still recorded and `napcat-adapter.log.jsonl` receives `forward_message_resolve_error`.

Check the route's OneBot HTTP endpoint, `get_forward_msg` response, record expiry/access, and the `forward_message_resolved` log entry.

## NapCat is connected but no handler receives the message

Inspect `data/route/<configName>/`:

- A group/private message JSONL means the QQ-to-RabiRoute path works.
- `agent-packets.jsonl` means a rule matched and a packet was built.
- No packet means you should check enabled message-triggered `automationRules` in `personaConfig.json`, then `trigger.routeKinds`, `trigger.regex`, and target-group filters.

## `send_group_msg` fails with `EventChecker Failed` or `1006514`

OneBot HTTP may answer while the QQ core cannot send. Inspect NapCat/QQ logs for quick-login failure, QR login state, clock skew, device checks, and network errors.

Recommended order:

1. Confirm/recover QQ login in NapCat WebUI.
2. Synchronize Windows time when NapCat reports ServerTime drift.
3. Restart NapCat/QQ and retest OneBot HTTP plus WebSocket.
4. Compare `gateway-status.json`, inbound message logs, and packet logs to separate receive, route, and send failures.

Non-zero OneBot `retcode` becomes `failed` and preserves draft data. RabiRoute has no persistent automatic retry queue; resend explicitly after the login is repaired.

## Chinese text or multiline corruption on Windows

Avoid hand-built Chinese JSON through PowerShell `Invoke-WebRequest`. Use:

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "Unicode test\nSecond line"
```

Validate configuration with:

```powershell
npm run check:config
```

Use real line breaks in WebUI. Do not save a visible literal `\n` or double-escape JSON.

## Codex receives no delivery

Check in order:

1. Open Codex/ChatGPT Desktop and verify that it can enter the target task.
2. Rescan Codex in RibiWebGUI. The selector should show unarchived task names plus last activity time, not internal IDs.
3. Check the saved `codexThreadId` and `codexCwd`. A valid ID is reused and `codexCwd` controls the current turn even when the task's saved default cwd differs, after a Desktop rename, with a stale SQLite title, with a display title longer than 240, or after a completed goal.
4. Only an explicitly cleared, invalid, or genuinely missing ID falls back to `codexThreadName + codexCwd` lookup. A SQLite title changing to the first prompt does not invalidate a good ID. One or more exact matches bind the unique latest `updatedAt`; only zero matches may create. An archived saved binding creates a new task at the next real delivery or save commit point and persists the replacement ID without reusing another same-name task. A genuinely new task name longer than 240 is safely truncated and the actual name is persisted.
5. Inspect packet/status and Manager logs for route miss, Desktop IPC readiness, owner loading, an invalid task ID, or a requested workspace outside the allowed set.
6. `no-client-found` causes a `codex://threads/<id>` open and a short retry. When the exact ID can no longer be read from local state after that retry, RabiRoute creates a replacement and delivers the message; for a plan task, it also updates the original plan binding and returns a warning. When the task still exists, it neither switches to a background Runtime nor creates a task.

Do not set `CODEX_APP_SERVER_WS_URL`, a fixed port 4510, or a separate stdio process to repair delivery. They are not the real-message transport.

## `Missing monitorThreadId` or fixed thread not found

The saved binding is missing, the ID no longer exists, or the requested `codexCwd` is outside the allowed set. A different saved default cwd is not an error by itself.

Check that the ID still exists, normalize moved/case/symlink-changed paths, and confirm whether the task is archived, deleted, or owned by another account/`CODEX_HOME`. An archived fixed binding is replaced on the next real delivery; deleted or cross-account targets still require reselection.

## No `codex_app__*` thread tools in a background turn

Task-tool injection and RabiRoute delivery health are separate. Prompt changes cannot create an unavailable tool. Use the local bridge:

```http
POST <managerBaseUrl>/api/agent/threads
```

It supports `list`, `read`, `resolve`, `create`, and `send` inside configured Codex workspaces. Creation only bootstraps an empty task; real prompts still go to the Desktop owner. See [Rabi Interfaces for Handlers](rabi-agent-interfaces_en.md). Do not create repeated same-named Desktop tasks or substitute an internal sub-agent for a formal task.

## UI still shows old delivery errors after an upgrade

Rebuild and restart the Manager and gateways. Distinguish historical JSONL/stderr entries from the current startup. If new logs still show removed Desktop/stdio behavior, verify the startup directory and `dist/` timestamps; an old build is still running.

## Codex model or tools differ from expectations

RabiRoute does not override the target Desktop task's model, tools, sandbox, or approvals. Adjust them in that task. If delivery appears in another task, reselect the exact item and verify `codexCwd`; do not substitute a visible name for the opaque ID.

## Approval rejected or turn stopped

Command, file, network, and tool permissions are handled by the target Desktop task. Desktop approval governs Agent execution only; it does not authorize RabiRoute to write to QQ, documents, devices, or other external systems. Those actions still go through Outbox and adapter policy.

## Ordinary group messages are not forwarded

Ambient group messages are not forwarded unconditionally. Add a `group_message` rule with a focused regex, for example:

```text
requirement|build failed|reminder|please record
```
