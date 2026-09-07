<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-codex-context-plugin.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context plugin

> Status: 0.4 unified-context and plan-task completion Hook version. Completion reminders remain experimental. Source lives in `plugins/rabi-codex-context/`.

The plugin registers and executes only hooks under its own `PLUGIN_ROOT`. Installation, upgrades, and runtime do not rewrite another plugin's `hooks.json`, marketplace entry, or enabled state, so an independent language-style hook can load alongside it.

## Persona chat history

When `Stop` supplies a nonempty `last_assistant_message` (or `lastAssistantMessage`) and `turn_id` (or `turnId`), Manager appends the full reply to `chat-history/final-replies.jsonl` under its unique owning persona. Ownership reuses explicit Hook bindings and Route, plan, secretary, and message-processing task bindings. Missing or conflicting ownership produces no record. Codex and DSH replies reported through the same Hook API use this entry point; desktop chat databases and historical messages are not imported.

`GET /api/roles/:roleId/chat-history?limit=50&cursor=<byte-offset>` returns `entries` and `nextCursor` in reverse append order. Omitting the cursor starts at the newest position; `nextCursor=null` means the beginning was reached. Reply bodies are not truncated. Pages allow up to 100 records and return early with a cursor after approximately 1 MiB. A digest of `sessionId + turnId + body` deduplicates replayed callbacks. A successful append publishes `persona_chat_history_changed`; WebGUI reads only while the chat-history tab is active and supports reconnect refresh and manual pagination. Recording is independent of the plan-completion notification switch and retains the existing startup recovery gate.

## Single ownership boundary

Rabi PC / RabiRoute Manager is the sole owner of persona configuration, Codex session bindings, plans, recent and consolidated memory, role skills, recall scoring, `viewedAt`, plan archival, memory edit windows, and consolidation.

The Codex plugin is a thin forwarder. It sends `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` to Manager. Context events inject Manager's `additionalContext`; `Stop` forwards only the official `session_id`, `turn_id`, `cwd`, and `last_assistant_message`. The plugin does not scan role directories, parse plans or memories, score keywords, store bindings, or keep an offline knowledge cache.

```text
Codex hook event
  -> POST /api/codex-hook/context
  -> Rabi PC Manager session binding
  -> RabiContextManager trigger policy, recall, and side effects
  -> sole roleKnowledgeSnapshot() call site
  -> shared RoleKnowledgeContextView
  -> additionalContext
  -> Codex hook injection

RabiRoute message delivery
  -> normalized message_delivery trigger
  -> the same RabiContextManager
  -> AgentPacket

Codex Stop
  -> Manager matches the exact plan taskBinding
  -> role-panel timeline
  -> Forwarding / AgentPacket
  -> the reminder persona Route's exact handler session
```

## Unified trigger policy

| Normalized trigger | Source | Context shape | Lifecycle |
|---|---|---|---|
| `session_start` | Codex `SessionStart` | full entry context | normal archival; persona resent when needed |
| `user_prompt` | Codex `UserPromptSubmit` | full entry context | normal recall and matched-memory refresh |
| `reasoning_pre_tool` | Codex `PreToolUse` | newly relevant turn delta | no repeated archival; new hits refresh `viewedAt` |
| `reasoning_post_tool` | Codex `PostToolUse` | newly relevant turn delta | same, including knowledge created or changed by a tool |
| `message_delivery` | normal RabiRoute delivery | full entry context | existing plan, memory, and consolidation rules |
| `preview` | Manager or UI caller | full preview | no archival, `viewedAt` refresh, or consolidation run |

Reasoning hooks do not copy every tool input or output into the model context. Manager scores bounded text against the same ID, title, and `keywords` metadata and returns nothing when no role knowledge or explicit Rabi knowledge path matches. A `turn_id` ledger deduplicates by item type, ID, and revision time, so Pre/Post do not repeatedly inject or refresh the same item.

## WebGUI Hook management

The Codex handler panel exposes three Hook switches and states exactly when each one fires:

| Switch | Codex Hook | Trigger time | Default |
|---|---|---|---|
| Task-entry context | `SessionStart` / `UserPromptSubmit` | When a task starts, resumes, clears, or compacts, and when the user submits a new message | On |
| Reasoning-time context refresh | `PreToolUse` / `PostToolUse` | Before and after Codex calls a tool; only newly matched plan, memory, or skill context for the turn is injected | On |
| Plan-task completion notification | `Stop` | After the plan-bound execution task outputs its final answer for the turn; Rabi delivers to the task bound to that persona Route | On |

The fields are `codexHooks.sessionContextEnabled`, `codexHooks.reasoningContextEnabled`, and `codexHooks.planTaskCompletionEnabled`. These switches control only whether Manager responds to each Hook. The plugin registration remains unchanged, so re-enabling a Hook does not require reinstalling the plugin. If no Route is bound exactly to a plan execution task, Manager keeps the default-on value for that source task so standalone plan tasks can still report `Stop`; a reminder target Route that disables completion notifications fails closed.

## Plan-task completion Hook

A plan may use `taskBinding` to bind one exact Codex execution session. When `taskBinding` exists and `completionHook` is omitted, completion notification defaults to enabled; set `completionHook.enabled=false` to disable it for one plan. After that session finishes a turn, the `Stop` Hook sends the official `last_assistant_message` to Manager. The plan file is the source of truth for plan-to-execution-session binding; the Route/gateway is the source of truth for the reminder persona's target session. Delivery reuses the existing role-panel, Forwarding, AgentPacket, and Agent-adapter path.

- A persisted `sessionId + turnId` key deduplicates delivery. Top-level paused plans ignore completion reminders so the bound task is not re-driven while paused.
- The Hook does not inspect transcripts or automatically update plan status, steps, or memory.
- A Codex target must have an exact task binding and must differ from the execution session. Workspace, persona, or gateway conflicts fail closed.
- Success emits no Stop Hook output. Delivery failure returns only a non-blocking `systemMessage` warning and does not block the final Codex answer.
- Completion state is private runtime data under `data/codex-hook/sessions.json` and must not be committed.

## Codex-only mode

A Codex-only user still runs the Rabi Manager context service, but may disable automatic gateway startup:

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

This mode does not start Route-config polling. Persona, plan, memory, and skill data is still read from Manager's current `rolesDir` for each Hook request, and an explicit Manager-config change takes effect immediately. This keeps the knowledge service stable on NAS workspaces without repeatedly scanning or migrating Route configuration for Gateways that are not running.

Manage `rolesDir` through Rabi PC / Manager configuration. The plugin no longer supports `source add` or a private plugin-owned `roles/` directory.

### Migrating from plugin 0.1

Role-root registrations and session bindings stored in the plugin user directory by version 0.1 are not migrated automatically. After upgrading to 0.4, start Rabi PC Manager and bind each persona again with the exact complete `session_id`; never infer it from a task title, workspace, or recent timestamp. The former implementation remains only as a read-only migration reference under `archive/plugins/rabi-codex-context-v0.1.0-local-context/` and must not return to the active call path.

New bindings live in Manager-private runtime data at `data/codex-hook/sessions.json`. Do not commit that file, the old plugin user directory, or any real persona data.

## Session controls

Use strict markers inside a task:

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

Manager interprets the markers. Ordinary prose never changes a binding. Rabi PC may also bind proactively with the exact complete session ID:

```text
PUT    /api/codex-hook/sessions/{sessionId}  { "roleId": "YeYu" }
GET    /api/codex-hook/sessions/{sessionId}
DELETE /api/codex-hook/sessions/{sessionId}
```

Never infer a session ID from a task title, workspace, or timestamp.

## Manager API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/codex-hook/context` | Accept a raw Hook event and build unified context |
| GET | `/api/codex-hook/roles` | List Manager-owned personas |
| GET | `/api/codex-hook/sessions` | List Manager-owned Codex bindings |
| GET/PUT/DELETE | `/api/codex-hook/sessions/{sessionId}` | Inspect, proactively bind, or remove a binding |
| GET | `/api/codex-hook/doctor` | Inspect rolesRoot, roles, and bindings |

Binding state lives in private RabiRoute runtime data at `data/codex-hook/sessions.json`. It is not plugin data and must not be committed.

## Recall and consolidation

Manager routes every normalized trigger through `RabiContextManager`, the sole caller of the existing `roleKnowledgeSnapshot()`. This preserves the same ID/title/keyword scoring, active-item boosts, required-read protocol, memory `viewedAt` refresh, plan archival, edit windows, validation, and consolidation APIs used by normal RabiRoute Agent packets.

The Hook does not embed full matched items. Codex must read every Manager GET path in `[处理前上下文确认]`, then use the existing plan and memory APIs for changes. It must not edit JSON directly and claim that the Manager lifecycle succeeded.

## Installation and acceptance

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

After installation or update, start a new Codex task and review/trust the changed commands through `/hooks`, including the new `Stop` Hook. Verify Manager outages never trigger plugin-local knowledge fallback, unbound sessions emit no context, marker binding injects in the same turn, keyword matches refresh memory `viewedAt`, sessions remain isolated, Rabi PC can bind exact sessions proactively, `SessionStart` reinjects after startup/resume/clear/compaction, Pre/Post reasoning hooks emit only relevant deltas, same-turn duplicates stay silent, and normal message delivery uses the same context manager.

For completion reminders, verify one bound Stop turn reaches only the selected persona Route, repeated turns stay deduplicated, and workspace/persona/gateway conflicts plus a source-equals-target Codex task fail closed. Successful Stop handling must emit no stdout; failures may emit only a non-blocking system warning. Until the reminder is observed between two real Codex Desktop tasks, this capability remains experimental even when local tests pass.
