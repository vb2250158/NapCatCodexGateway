<!-- docs-language-switch -->
<div align="center">
English | <a href="./configuration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Configuration and Integrations

> Status: current reference. Fields and maturity are based on the active configuration model, Manager APIs, and scan results. See [Current Capabilities](current-capabilities_en.md) for acceptance status.

## Plugin platform

The default Profile is `dist/plugins/profiles/desktop.json`; the default package root is `dist/plugins/packages/`. Source builds generate them from `plugins/profiles/desktop.json` and `plugins/builtin/`.

Out-of-tree plugins select one Profile with `RABIROUTE_PLUGIN_PROFILE` and add package roots with `RABIROUTE_PLUGIN_PACKAGE_ROOTS`. Manifest and Profile are schema v2 only. Profile contains `readyRequires` plus `instances` with stable `id`, package, version, enablement, JSON configuration, permission `grants`, and bounded restart/resource `policy`. Any non-v2 schema and Patch stay outside the runtime path.

Manager watches the selected Profile and every package root. Unchanged revision, configuration, permissions, and dependency revisions do not reactivate. A change reloads only its dependency component. Candidate failure retains the preceding working generation, missing dependencies produce `waiting_dependency`, and missing permissions fail closed.

`GET /api/plugins/reconciliation` returns active, waiting, failed, and diagnostic state. `POST /api/plugins/reconciliation` rereads immediately. WebGUI refreshes its catalog and Web modules after `plugin_catalog_changed`. See [Plugin packages and hot replacement](plugin-bundles_en.md).

### Plugin entry-point and resource ownership

The built-in catalog registers 29 Manager plugins. Entries run as `in_process`, `isolated`, or `declarative`; Manager's loader never imports isolated entry top-level code, and every long-lived child holds a process lease. `manager:core` retains recovery, catalog, and basic-page contributions, while optional business entry points are registered by their plugins. The central HTTP chain is limited to LAN authentication, the read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, the Host-only shutdown route, JSON 404 for control paths, and WebGUI HTML fallback for all other paths. Production business routes declare stable `routeId` values with real `exact` or `prefix` matchers; `dynamic` remains only as an extension contract. The Registry rejects duplicate route IDs and overlapping path conflicts.

The presentation Contribution Catalog publishes `page`, `navigation`, `settings-section`, `status-card`, `command`, `tray-menu`, `hotkey`, and `theme`. WebGUI trusted command/renderer registries contain contracts shipped in the build. Desktop's frozen Registry contains built-ins only and consumes Manager-validated declarative contributions. Every contract binds `pluginId + instanceId`; cross-plugin references fail closed. The `manager:desktop` settings section owns system selection, screenshots, clipboard pinning, and a login-startup shortcut targeting Host. Commands may control system listeners, directory actions, and manual trigger, but never application lifecycle. Catalog failure withdraws stale contributions while retaining the Host-bound WebGUI entry.

Trusted WebGUI page extensions call `registerTrustedWebPage()` at frontend build time to register a `routeId`, `rendererId`, asynchronous component loader, page paths, and allowed navigation slots and icons. The plugin catalog may reference only registered contracts; it cannot provide remote module URLs or arbitrary scripts.

Desktop loads no third-party Python entry points. Third-party executable logic uses Manager plugin `isolated` execution. Desktop/Web extensions use only `declarative` resources and renderer/command contracts shipped by the host, so they cannot inject code into the Qt process.
The Manager root Fiber owns three shared read Worker Pools and `CoalescingMessageProcessingBoardPersistence`. On stop, persistence rejects new writes, clears timers, flushes, and waits for its active Worker. Read pools cancel queued/shared requests, terminate active and idle Workers, and wait for child exit. If one stop fails, cleanup still runs for the remaining resources before the first error is returned. Stopped resources can start again.

Routes using `ManagerPluginRequestTracker` follow one deactivation order: unregister routes, reject new requests, then wait for accepted responses to emit `finish` or `close`. Both synchronous and asynchronous handlers are counted. The default drain deadline is 30 seconds. On timeout, unfinished responses are destroyed before remaining plugin resources are released.

| Instance | Owned entry points or resources | Deactivation |
| --- | --- | --- |
| `manager:diagnostics` | `GET /meta`, `GET /api/gateways`, and the WebGUI Log Diagnostics page/navigation | Removes diagnostics routes and drains accepted requests; reads other plugin state without starting or restoring disabled plugins |
| `manager:desktop` | `/api/desktop/settings`, `/open-config-file`, plus Desktop/WebGUI settings, commands, tray entries, and hotkey declarations | Removes routes and drains requests; never starts, stops, or supervises Manager/tray |
| `manager:desktop-pet` | Desktop-pet packs, bindings, settings, and bounded assets under `/api/desktop-pet/` | Removes desktop-pet routes and drains accepted requests; the local controller stops its idle scheduler |
| `manager:yeyu-gamer` | Fixed-loopback YeYu Gamer health/meta/snapshot/capability reads and plan-only work-item creation | Removes routes and drains requests; never claims work, invokes capabilities, or starts a game |
| `manager:gateway-runtime` | Gateway configuration, lifecycle, deletion, manual trigger, Agent delivery test, replay, network-options, and reload routes; Gateway, delivery-test, and manual-trigger child processes | Removes routes, drains requests, stops instance-owned manual triggers, then stops and waits for Gateway process trees |
| `manager:agent-adapter-catalog` | Agent Adapter catalog plus `/api/scan/agents` and `/api/scan/agents/dsh`; bounded scan Worker Pool | Removes routes, cancels queued or active scans, and stops Worker process trees |
| `manager:agent-thread-control` | Agent task creation, lookup, and binding routes | Removes routes and drains requests; stable business modules retain task and record ownership |
| `manager:agent-communication` | Agent request, send, receipt, and trace routes | Removes routes and drains requests while reusing the existing Outbox, approval, receipt, and message-processing owners |
| `manager:remote-agent` | Remote Agent scan, connection, task, and event routes; active WebSockets and Hub callbacks | Removes routes and drains requests; marks unfinished tasks `interrupted`, closes WebSockets, and waits for started callbacks |
| `manager:napcat-control` | NapCat repair, health, all three login modes, OneBot configuration, add, launch, restart, and removal routes | Stops acceptance and drains requests, stops the supervisor, then stops only instances explicitly launched and still owned by this plugin; port-scan discoveries and externally started instances are not claimed |
| `manager:napcat-supervisor` | NapCat login-check queue after Manager autostart | Cancels the remaining account queue, waits for the active check, and suppresses stale completion callbacks |
| `manager:rabilink-relay` | RabiLink Relay runtime and persona-sync LAN service | Stops Relay, the sync listener, and active callbacks |
| `manager:memory-consolidation` | Memory-consolidation scheduler and instance-owned one-shot processes | Stops the scheduler, terminates those processes, and waits for the active consolidation run |
| `manager:message-processing-automation` | Agent-response reminders, plan subscription, and knowledge-callback reminders | Removes subscriptions and timers, prevents stale callbacks from rescheduling, and waits for started delivery |
| `manager:plan-feedback-delivery` | Plan-feedback recovery scans, delivery, and retry timers | Rejects new delivery, clears retry timers, and waits for active scans and delivery |

`manager:performance` creates a fresh `PerformanceApi` and HTTP handler batch on each activation. Deactivation unsubscribes performance samples, ends SSE streams, then stops monitoring. Reactivation never reuses a closed API instance.

## Codex terminology

RabiRoute keeps provider, agent/runtime, transport, host, and model separate:

| Concept | Current meaning |
| --- | --- |
| Provider | OpenAI account, service, and model capabilities. |
| Agent/runtime | Desktop-managed Codex tasks, turns, tools, and execution. Stable adapter ID: `codex`. |
| Transport | Codex Desktop IPC. |
| Host/owner | Codex/ChatGPT Desktop, which owns the visible task and actual turn. |
| Model | The model selected by the target Desktop task. |

Do not rename the adapter to `chatgpt`. Desktop IPC is the formal transport. A short-lived app-server may list user-visible task metadata and bootstrap an empty named task, but it must not execute routed prompts.

## Runtime files

```text
data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
```

`adapterConfig.json` owns endpoints, ports, handler selection, cwd, pipeline, role binding, and Route-local delivery policy. `personaConfig.json` owns persona automation rules, speech-trigger keywords, and per-endpoint recent-context budgets. A role can be reused by several routes.

`rolePanel` is a compatibility name for Manager's built-in message path, not a configurable Gateway listener. Local role-panel input and authenticated cross-persona delivery share the fixed `role_panel_message` rule and one delivery service. Success is recorded only after handler acceptance; a failed entry records an attempt.

On a clean start, the Manager copies the public `examples/data` package when available. Only the main example is enabled. Missing examples are not a runtime failure; the Manager can create a minimal NapCat-to-Codex setup.

## Representative route

```json
{
  "enabled": true,
  "messageAdapters": ["napcat", "heartbeat"],
  "messageAdapterPolicies": {
    "napcat": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"],
      "allowedFileRoots": ["C:/Path/To/Your/Project/ReleasePkg"],
      "messageGrouping": {
        "settleSeconds": 6,
        "incompleteSettleSeconds": 12,
        "maxWaitSeconds": 20
      }
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ message listener",
  "codexCwd": "C:/Path/To/Your/Project",
  "codexPlanAssistantEnabled": false,
  "codexPlanAssistantModel": "gpt-5.6-terra",
  "codexPlanAssistantSessions": [],
  "codexMemoryConsolidationAgentEnabled": false,
  "codexMemoryConsolidationAgentModel": "gpt-5.6-terra",
  "codexHooks": {
    "sessionContextEnabled": true,
    "reasoningContextEnabled": true,
    "planTaskCompletionEnabled": true,
    "agentCommunicationEnforcementEnabled": true,
    "onlyPrimaryPersonaCanSendMessages": false
  },
  "agentModel": "gpt-5.6-terra",
  "agentReasoningEffort": "high",
  "dshModelProvider": "deepseek-official",
  "dshModel": "deepseek-v4-pro",
  "dshReasoningEffort": "max",
  "agentAdapters": ["codex"],
  "primaryAgentAdapter": "codex",
  "messageProcessingAgents": {
    "codex": {
      "enabled": true,
      "model": "gpt-5.6-luna",
      "reasoningEffort": "medium",
      "maxAgents": 1
    }
  },
  "heartbeatSkipWhenAgentBusy": true,
  "personaAutomationScriptsEnabled": false,
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

## Core fields

- `messageAdapters`: configurable input types. Current IDs include `napcat`, `remoteAgent`, `heartbeat`, `speech`, `webhook`, `fennenote`, `xiaoai`, `rabilink`, `wearable`, `wecom`, `weixin`, and `feishu`. Legacy `rolePanel` entries remain compatible, but WebGUI no longer presents them as configurable because Manager provides role-panel messaging by default.
- `personaAutomationScriptsEnabled`: Route-local permission for persona automation to run local scripts. It defaults to `false`, is not stored in or synchronized with the persona, and gates script actions triggered by either messages or schedules.
- `messageAdapterPolicies`: `inputEnabled`, `outputEnabled`, `supportedOutputs`, and adapter-specific restrictions. QQ, Weixin, Feishu, WeCom, role-panel, and RabiLink text chats use message groups automatically without an off switch. `messageGrouping` exposes only ordinary settle, unfinished-fragment settle, and maximum wait values, defaulting to `6 / 12 / 20` seconds. ASR/voice transcripts, heartbeat, commands, approvals, health alerts, and structured events continue direct delivery without this wait. Chat dispatch changes only when Codex Message Agent mode is also enabled; otherwise delivery remains per-message. Legacy allow-group/user and output-mode fields are no longer active fine-grained filters.
- `supportedOutputs`: outbound payload kinds. NapCat supports `text`, `image`, `voice`, and `file` in the current policy model.
- `allowedFileRoots`: real-path allowlist for local file output. A local QQ group-file upload is blocked when this is empty or the resolved file leaves the allowlist.
- `gatewayPort`: NapCat WebSocket Client target port.
- `napcatHttpUrl`: OneBot HTTP endpoint called by RabiRoute. A Route binds exactly one NapCat; use separate Routes for separate QQ accounts. Multiple Routes may still explicitly share one NapCat and HTTP URL. Automatic port assignment applies only to listeners owned by RabiRoute and does not move an existing NapCat endpoint to an unstarted port.
- `webhookPort` / `webhookPath`: generic webhook endpoint; the port falls back to `gatewayPort`, and the default path is `/webhook`.
- `agentAdapters`: handler IDs. The current IDs are `codex`, `copilotCli`, `astrbot`, `marvis`, and `dsh`. Codex is verified; Copilot CLI, AstrBot, and DSH are experimental; Marvis is a manual handoff.
- `dshSessionId` / `dshSessionName` / `dshCwd` / `dshBaseUrl`: DSH (DeepSeek Harness) Primary Persona binding. WebGUI scans in **API address → workspace → session** order. The user may select an existing session or type a new name; save resolves by name plus workspace and creates idempotently only when there is no match. Before creation, RabiRoute calls DSH `workspace.create` to register or reuse that directory and passes the returned `workspaceId` to `session.create`; Primary Persona, Message Agent, Plan Secretary, and Memory Consolidation sessions created by RabiRoute therefore appear directly under the matching workspace group. The saved binding contains the complete `session-<uuid>`, visible name, and workspace. When the Primary Persona already has a complete ID and workspace, the configuration page shows **Locate session**. Manager reads that exact ID and verifies it is unarchived; DSH also verifies the configured workspace, while Codex does not compare the task's saved default cwd. It then opens the Codex Desktop task or DSH Web with `rabiSessionId`. It sends no prompt, creates no session, and does not change the binding. **Automatically initialize session** appears only when the Primary Persona has no complete binding; it saves and resolves the stable binding before delivering the role, plan, memory, and required-reading context to the same owner. Real messages continue through `POST /api/session.prompt` queue mode and never fall back to Codex. Enable `RabiRoute Agent` under DSH **Settings → My plugins** to expose thread, outbound-send, plan, Message Agent, memory, and Agent-communication tools. DSH refresh and session pagination use the dedicated `GET /api/scan/agents/dsh` endpoint, so they do not wait for the shared Codex, Copilot CLI, AstrBot, or Marvis scan. An anonymized test Route has passed repeated delivery, Manager/DSH restart readback, Plan Secretary delivery, Message Agent routing, a dedicated Memory Consolidation Agent, a `required` formal reply, and invalid-endpoint fail-closed checks. The dedicated scan also reads the live `RabiRoute Agent` state, version, Manager address, communication enforcement, and three model tools. Missing, inactive, or mismatched versions receive an update-and-restart diagnostic. The adapter remains experimental pending packaged/fresh-environment regression.
- `dshModelProvider` / `dshModel` / `dshReasoningEffort`: optional DSH Primary Persona model settings. When DSH is available, WebGUI reads providers, models, and reasoning efforts through `llm.models`; if discovery fails, the model remains manually editable as `provider/model`. Before the next Primary Persona delivery, Gateway reads `session.models`, calls `session.selectModel` only when the configured selection differs, and then calls `session.prompt`. Empty values preserve the bound DSH session's current settings.
- `primaryAgentAdapter`: the Route's Primary Agent. It must be one of `agentAdapters`. A matched message is delivered only to this handler, not broadcast to the other configured Agents. Older configurations use the first listed Agent; removing the current Primary Agent selects the first remaining Agent.
- Agent handlers use a base capability layer for installation, authentication, project, session, and delivery support, then explicitly opt into managed-task extensions. Codex and DSH both declare **Message Agent mode**, **Dedicated Memory Consolidation Agent**, **Plan assistant sessions**, and **Hook management**. These settings belong only to the selected Primary Agent; switching the primary filters out auxiliary bindings owned by the other adapter. DSH receives the tools through the `RabiRoute Agent` plugin. Other handlers continue to expose only capabilities they actually implement.
- `messageProcessingAgents.codex` / `messageProcessingAgents.dsh`: Message Agent eligibility, worker limit, and runtime settings for the selected Primary Agent. Only the entry matching `primaryAgentAdapter` is active. Codex uses its configured model and reasoning effort; DSH sessions keep the model configured by DSH. The feature defaults off. When enabled, chat messages form message groups and reuse or create worker sessions by topic, while ASR and structured events remain direct. Ranking and delivery share one order based on quoted Agent messages, original group, endpoint, conversation, sender, and recent use. Optional `maxAgents` accepts `1–32`; when omitted, it defaults to `1`, so the single worker is reused instead of creating another. Lowering the limit detaches excess workers without deleting owner sessions. Message, plan, memory, and pending-reply follow-ups stay on the selected Primary Agent and do not fall back to another adapter. When Codex creates or renames a Message Agent task, its prefix comes from the Desktop sidebar's displayed `Name`, never the state database's raw `name`.
- When `messageProcessingAgents.codex.enabled` is disabled, ordinary chat returns to direct Primary Persona delivery. Plan-progress notifications, knowledge-callback reminders, and pending Agent-to-Agent replies originating from linked message groups also move to the current Route's Primary Persona task. Existing Message Agent tasks and audit records remain, but these follow-ups no longer open them automatically.
- When `messageProcessingAgents.codex.enabled` is on, the same configuration area shows a Message Processing Board. It is not a second statistics system: it reads Manager-owned delivery requirements and distinguishes required replies, Agent decisions, handoffs, waiting-to-send, approval, sent, no-reply, and failed states. Explicit mentions, direct replies, and private messages are required by default. Ordinary group messages may receive proactive participation or a reasoned no-reply decision. Once a structured handoff links a plan to its source conversation, canonical plan writes generate progress-notification requirements and reuse the original Message Agent task to return the update. The board refreshes from Manager events instead of periodically scanning chat or plan files.
- `codexThreadId` / `codexThreadName` / `codexCwd`: the opaque ID identifies an existing task, the visible name is saved for display, and `codexCwd` supplies each delivery workspace. A task's saved default cwd may differ. An archived saved ID first rebinds to the unique latest active same-name task in the same workspace; if none exists it blocks and requires restore/reselection. It never permits replacement creation. Typing a new name explicitly clears the old ID before complete name lookup. Only system-owned Message Agent tasks with stable generated names use the app-server state index's name filter, avoiding a full-catalog scan on first delivery; ordinary task binding retains complete lookup. One or more exact same-name/workspace matches bind the unique latest `updatedAt`; only zero matches for an empty, invalid, or missing ID may create, and a tied or unusable maximum requires selection.
- `codexMemoryConsolidationAgentEnabled`: sends automatic-deadline and manual memory-consolidation triggers to a dedicated Codex Desktop task. It defaults off. Automatic 72-hour scheduling still runs while off, but the Primary Persona handles the request. When enabled, the task name is derived as `<Primary Persona task name> 记忆整理`, the Primary Persona does not receive the same request, and delivery failure does not fall back to the Primary Persona or another Runtime.
- `codexMemoryConsolidationAgentModel`: model for the dedicated Memory Consolidation Agent. It defaults to `gpt-5.6-terra` and affects only new turns in that task.
- `codexPlanAssistantEnabled`: enables persistent plan-secretary tasks for this Route. It defaults off; a legacy configuration that already contains `codexPlanAssistantSessions` is treated as enabled. Turning it off stops exposing secretary slots to the persona and stops applying the secretary model automatically, while retaining the bindings for reuse after it is enabled again. WebGUI route saves wait for the Manager route-catalog transaction and retain one idempotency key, so the same change is safe to retry after a temporary outage.
- `codexPlanAssistantModel`: the one model Manager applies to every Plan Secretary on the current Route. It defaults to `gpt-5.6-terra`, and WebGUI edits it once instead of storing one model per task. A legacy configuration that stored models inside secretary entries is migrated to the shared value on read. A model explicitly requested for one delivery still takes precedence.
- `codexPlanAssistantSessions`: exact persistent Desktop-task bindings used as plan-management secretary slots. Each entry keeps only the full task ID, visible name, workspace, one-based slot index, and initialization time. The list is stored separately from the enable switch and shared model, so disabling the feature or changing the model does not delete bindings. One slot is named `<Primary Persona displayed Name> 协助处理计划`; multiple slots use numbered suffixes. Expanding renames the original slot; shrinking detaches extra tasks without deleting them. Creation and renaming use the Desktop sidebar's displayed `Name` as the prefix, never the state database's raw `name`. Manager stores the currently responsible secretary in the plan's separate `secretaryBinding`; the business `taskBinding` always identifies only the execution task. Secretaries maintain plans and memory, deduplicate business tasks, inspect status, consume results, and continue the independent business task; they do not investigate, implement, test, or modify business files. Real multi-task Desktop acceptance is still pending, so the feature remains experimental.
- `codexHooks.sessionContextEnabled`: defaults to `true`. Controls `SessionStart` / `UserPromptSubmit`, triggered when a Codex task starts, resumes, clears, or compacts and when the user submits a new message.
- `codexHooks.reasoningContextEnabled`: defaults to `true`. Controls `PreToolUse` / `PostToolUse`, triggered before and after tool calls and returning only newly matched plan, memory, or skill context for the turn.
- `codexHooks.planTaskCompletionEnabled`: defaults to `true`. Controls `Stop` completion reminders after a plan-bound execution task outputs its final answer for the turn. With Plan Secretary enabled and a valid secretary task available, Manager delivers directly to the plan's `secretaryBinding`, does not write the Primary Persona role-panel timeline, and does not wake the Primary Persona by default. It falls back to the original Primary Persona path only when no usable secretary is enabled. Turning the switch off only makes Manager ignore or reject the Hook; it does not unregister or rewrite the Codex plugin Hook.
- `codexHooks.agentCommunicationEnforcementEnabled`: shown in WebGUI as **Require the RabiAgent message delivery API**, defaults to `true`, and is stored per Route. When enabled, that Route's Primary Persona, Plan Agents, Plan Secretaries, and Message Agents cannot bypass `/api/agent/threads` with persistent Codex task tools. `PreToolUse` denies the call before execution and explains the required `sourceThreadId`, `sourceAgentType`, and `responsePolicy`; `required` also needs `responseInstruction`. If the target ends a turn without a formal Rabi response, Manager reminds it five minutes after that turn ends. Turning the switch off disables only the bypass check; already tracked requests continue to be followed up.
- `codexHooks.onlyPrimaryPersonaCanSendMessages`: the field name is retained for compatibility. It defaults to `false` and applies when Codex or DSH is the Primary Agent. When enabled, `/api/agent/send` accepts only `sender.agentType=primary_persona` with a `sender.sessionId` exactly matching the active `codexThreadId` or `dshSessionId`; Plan Agents, Plan Secretaries, and Message Agents are rejected. The setting is discarded when the Primary Agent does not support managed Hooks.
- `copilotThreadName` / `copilotCwd`: independent Copilot CLI session configuration.
- `agentModel` / `agentReasoningEffort`: the model and reasoning effort Manager applies to new Codex Desktop turns for the Route's Primary Persona. Empty values preserve the target Desktop task's current settings. When Desktop is available, WebGUI uses a short-lived app-server `model/list` request to load models visible to the current account and their reasoning efforts; the model remains manually editable if discovery fails. Accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, while the selected model's catalog remains the authoritative availability source. These fields affect only the Primary Persona and do not override Message Agents, Plan Secretaries, or independently bound Plan Agents.
- `heartbeatSkipWhenAgentBusy`: applies only while Codex Message Agent mode is off. With Message Agent mode on, heartbeat goes immediately to an independent Message Agent and is not skipped because the Primary task is active. Other message kinds are unaffected.
- `speechPushMode`: Route-owned speech delivery mode. `hot` delivers every completed ASR segment immediately. `keyword` records every segment but wakes the Agent only after a persona-keyword match. WebGUI's **Hot delivery** switch maps On to `hot` and Off to `keyword`.
- `speechTriggerKeywords`: persona-owned names, common addresses, and wake phrases in `personaConfig.json`. When the list is empty and Hot delivery is off, ASR remains recorded and never silently falls back to `hot`.
- `automationRules`: persona-owned rules in `personaConfig.json`. Each rule chooses a `message` or `schedule` trigger, then a `deliver_agent` or `run_script` action. Legacy `notificationRules` and nested heartbeat `schedules` migrate on read; later saves write only the new structure.
- `recentMessageLimits`: persona-owned `0–200` auto-injection budgets for `napcat`, `remoteAgent`, `heartbeat`, `rolePanel`, `speech`, `fennenote`, `xiaoai`, `rabilink`, `wearable`, `webhook`, `wecom`, and `weixin`. The schema default is `12`; `0` disables only automatic injection. Legacy `recentMessageLimit` and explicit endpoint values remain effective.
- `contextInjection`: persona-owned focused-context policy. It defaults to `{"mode":"focused","relevantKnowledgeLimit":3,"personaMaxChars":1600}`; `mode=legacy` restores full active indexes. The numeric ranges are `1–12` and `800–6000`.
- `dataDir`, `rolesDir`, `configName`, `agentRoleId`, `agentRoleFile`: storage and role binding.

Minimal example:

```json
{
  "automationRules": [
    {
      "id": "private-agent",
      "name": "Send private messages to the Agent",
      "trigger": { "type": "message", "routeKinds": ["private"] },
      "action": { "type": "deliver_agent", "template": "" }
    },
    {
      "id": "daily-check",
      "name": "Daily check",
      "trigger": {
        "type": "schedule",
        "schedule": { "id": "daily-check-time", "type": "daily_time", "timeOfDay": "09:00" }
      },
      "action": { "type": "run_script", "scriptPath": "daily-check.py", "timeoutSeconds": 300 }
    }
  ]
}
```

Script paths are restricted to the current persona's `scripts/` directory and may use `.cmd`, `.bat`, or `.py`. Manager tokens, passwords, and message bodies are not inherited by the process. Only the system variables needed to start the script are retained, with Route, automation, persona-directory, and script-path identifiers added. Arguments are a string array, timeouts range from 5 to 3600 seconds, and the same rule on the same Route cannot overlap. Local execution records are appended to `automation-executions.jsonl`.

Windows paths may use either slash style in WebUI. Only hand-written JSON requires escaped backslashes.

## Message adapters

| Adapter | Maturity | Notes |
| --- | --- | --- |
| `napcat` | verified | Inbound OneBot WebSocket and outbound OneBot HTTP. |
| `heartbeat` | verified | Compatibility runtime for scheduled persona automations. A due rule may notify the Agent or, with local permission, run a persona script. Agent delivery and script execution keep separate results. |
| `speech` | experimental | RabiPC/RabiSpeech resident ASR. Hot delivery sends every segment; keyword mode records all segments and sends only persona-keyword matches. Successful same-session TTS joins ASR in the bidirectional persona context. |
| `rolePanel` | verified | Built-in Manager/Qt role conversation capability. It is available by default, hidden from WebGUI's configurable adapter list, and is not a network listener. |
| Plan approval | verified system event | Not a message adapter. After the feedback audit is persisted, Manager sends the guidance/approval body to the business `taskBinding` and, when Plan Secretary is enabled, sends the control notice to the responsible `secretaryBinding` instead of notifying the Primary Persona on every delivery. An incomplete business binding falls back to the Secretary first; the Primary Persona fallback is used only when no usable Secretary is enabled. The event has no configurable recent-message budget and does not enter the role timeline or unified conversation ledger. |
| `remoteAgent` | experimental | Manager discovers and connects remote bridges for tasks/events/files. |
| `webhook` | experimental | Generic POST source for systems without a dedicated adapter. |
| `fennenote` | experimental | Voice-transcript input and optional output bridge. |
| `xiaoai` | experimental/design-dependent | Dedicated integration route; verify the actual bridge environment. |
| `rabilink` | experimental | Relay/worker/device observation and downlink path. |
| `wecom` | experimental | WeCom smart-bot WebSocket and Outbox group sends. |
| `weixin` | experimental prototype | OpenClaw iLink QR login and long-poll ingress for personal Weixin. Text and allowlisted local-file replies are source-session-only; inbound media is record-only. |
| `feishu` | implemented locally; real credentials pending | Feishu enterprise-app event callback with signature/encryption checks, durable deduplication, and source-chat text replies. |
| `wearable` | experimental | Structured wearable health observations through the global RabiLink Relay worker. Samples enter a role-scoped timeline; only threshold or sleep-state alerts reach the Agent as `wearable_health_alert`. |

Named platforms should use their dedicated adapter rather than being folded into the generic webhook.

A persona may bind an outbound language style in `personaConfig.json`:

```json
"languageStyle": {
  "styleSkillUrl": "file:///C:/Users/Example/.codex/skills/direct-evidence-language-style"
}
```

The URL may reference a Skill directory, `SKILL.md`, or `references/style-data.json`. `/api/agent/send` defaults to `styleValidation=1`. A failed check stops before Outbox and returns reasons. After confirming the wording is intentional, the Agent may retry the same `deliveryId` with `styleValidation=0`.

Default delivery prompts keep only required actions, boundaries, and API fields. Full procedures belong in documentation or Skills; persona templates add only persona-, endpoint-, or schedule-specific differences.

NapCat credentials and Tencent security verification never belong in RabiRoute configuration. **Auto login when Rabi starts** is enabled by default for the NapCat bound to each Route. After the Manager begins listening, it asynchronously starts the bound instance, uses an existing quick-login account, and repairs OneBot endpoints without waiting for completion. **Start and manage login** runs the same flow on demand and exposes quick, password, and QR login in the Route card. A password is used for one request only, hashed by Manager, and then discarded; human verification remains explicit in the card.

## Handler adapters

- `codex`: reads the user-visible `Name` only from the index shared with the Desktop left sidebar and uses local task state for ID/default-cwd/archive/recency/owner metadata. The full task ID selects an existing task, while the current configuration supplies each delivery workspace. It asks the Desktop owner to start or steer the real turn through Desktop IPC. app-server `thread.name` and SQLite `threads.title` never override the sidebar Name or participate in same-name lookup.
- `copilotCli`: calls a local Copilot CLI with a dedicated session name/cwd and records output. It does not inject into an existing VS Code Copilot panel thread.
- `astrbot`: uses `ASTRBOT_URL`, Dashboard credentials, and required `ASTRBOT_SESSION_ID`. Delivery calls only ChatUI `POST /api/chat/send`; a missing Session ID fails closed. The old AstrBot plugin fallback and deployment entry are removed.
- `marvis`: writes prompt files, copies text, and opens/focuses the desktop application. It cannot reliably inject into a background session.

### Removed compatibility APIs

- Plugin reconciliation keeps only `GET/POST /api/plugins/reconciliation`; `POST /api/plugins/reconcile` is removed.
- Agent scanning uses `/api/scan/agents` and `/api/scan/agents/dsh`; `/api/agent-adapters/availability` and `/api/agent-adapters/dsh/availability` are removed.
- FenneNote playback uses `/api/fennenote/playback`; `/api/playback/request` is removed.
- AstrBot no longer exposes `/api/plug/rabiroute_agent/chat`, `/api/deploy-astrbot-adapter`, or the repository deployment script.

## Desktop-owner requirement

Codex/ChatGPT Desktop must be running for real delivery. RabiRoute may open `codex://threads/<id>` to load a task and retry briefly, but it does not start a fallback execution Runtime. Model, tools, sandbox, and approvals remain owned by the target task.

## RabiLink global configuration

The PC identity and Relay connection live in `data/Config.json`, including `rabiGuid` and `rabiLinkRelay` (`enabled`, `url`, `token`, `deviceId`, and timing options). Remote WebGUI identifies the PC at `/manage/<account>/<RabiGUID>/`; the legacy `/webgui` child path remains only for compatibility. Manager registers the PC and proxies remote RibiWebGUI independently of one route process. It also subscribes to local Manager `/api/events` and forwards non-`ready` events to the Relay's remote-WebGUI SSE; attachments, downloads, and media ranges use the same constrained WebGUI channel. A route still needs the `rabilink` message adapter to consume device observations.

The same file owns `webguiLan`, the local Manager's LAN WebGUI switch and access key. It defaults to `enabled=false`, keeping Manager on `127.0.0.1`. Enabling it from the local Console creates a random 32-byte access key when needed; after Manager restarts it listens on `0.0.0.0` while the operating system still assigns the port. Use `http://<Rabi-PC-LAN-IP>:<current-manager-port>/#/overview?webgui_token=<key>`. The browser keeps the captured key only for the current session and removes it from the address bar. Enable, generate, and rotate operations accept only requests originating from the Manager PC itself, through either loopback or one of that PC's own LAN addresses; other devices remain denied, and rotation invalidates old links immediately.

Legacy per-route Relay fields remain readable for compatibility; new configuration belongs in the global file. Public examples never include a Relay URL/token.

Record-first sources such as FenneNote can be selected through `routeVariables.rabilinkRecordFirstSources`. Configure one owning route only; do not let another direct-delivery route consume the same webhook and create duplicate Agent turns.

## WeCom

`wecomBotId`, `wecomBotSecret`, and optional `wecomWsUrl` configure the smart-bot WebSocket. Prefer `WECOM_BOT_ID`, `WECOM_BOT_SECRET`, and `WECOM_WS_URL` for real credentials. See [WeCom Integration](wecom-integration_en.md).

## Personal Weixin prototype

`weixinBaseUrl` and `weixinBotType` configure the OpenClaw/iLink prototype and default to `https://ilinkai.weixin.qq.com` and `3`. `WEIXIN_BASE_URL` and `WEIXIN_BOT_TYPE` may override them. QR-login tokens, account identifiers, sync cursors, and per-session context tokens stay protected under runtime `data/` and must never enter examples or logs. On restart, WebGUI distinguishes restoring, restored, temporarily unreachable with credentials retained, explicitly invalid, and never logged in. A QR is fetched only after the user explicitly clicks **Generate login QR**; temporary network/5xx/scan failures never clear the session, while explicit `-14` or HTTP 401/403 rejection does. Historical message counts do not imply current authentication. Outbox remains source-session-only and real-account longevity is still unverified.

## Feishu enterprise-app endpoint

`feishuAppId`, `feishuAppSecret`, `feishuVerificationToken`, and `feishuEncryptKey` configure one Feishu enterprise application. `feishuWebhookPort` and `feishuWebhookPath` configure the local callback listener. Keep `feishuEventSubscriptionEnabled` false until the platform-side HTTPS callback and `im.message.receive_v1` subscription are confirmed. The adapter handles URL challenges, validates the raw-body signature and Verification Token, decrypts Encrypt Key payloads, persists `event_id` deduplication, isolates context by source `chat_id`, and sends text only back to that source chat under adapter output policy. An incoming-bot webhook cannot replace these application credentials. See [Feishu Endpoint Integration](feishu-integration_en.md).

## Multiple routes and shared roles

Each folder under `data/route` is independently startable and may have its own endpoints and handler workspace. Several Routes may bind the same `agentRoleId`; they reuse that persona's root-level automation rules, speech keywords, and context budgets while retaining their own endpoint, pipeline, hot-delivery, handler configuration, and local script permission.

Once an ordinary message matches a rule, it is delivered directly to the Route's Primary Agent. When Codex is primary, RabiRoute uses `steer` for an active Desktop turn or `start` for an idle task. Ordinary endpoints do not need another hot-push toggle. Heartbeat's busy-skip switch and speech's hot/keyword mode are explicit exceptions.

For a Codex Primary Agent, `codexCwd` is the Primary Persona workspace. Message Agents, plan secretaries, and the memory-consolidation Agent reuse only tasks in the same normalized workspace. After the Primary Persona switches directories, old auxiliary bindings receive no further delivery: persisted Message Agents are removed from the pool, while plan-secretary and memory-consolidation tasks are resolved or created in the new workspace.

The automatic recent-context source is `data/roles/<RoleId>/conversation/current.jsonl`, scoped to the current persona, logical endpoint, and conversation. Inbound and outbound records count together. Time-based archives live under `conversation/archive/` and are not injected automatically.

When adding a new platform, create a module under `src/adapters/` and normalize it into the common event/forwarding path. Do not put unrelated protocol logic into the NapCat adapter.

## RibiWebGUI and plugins

RibiWebGUI edits runtime configuration through Manager APIs. Plugin and external integration pages should show actual scan maturity and requirements rather than treating the presence of configuration fields as proof of a verified end-to-end integration.

The optional NapCat-side entry lives under `plugin-adapters/napcat-rabiroute/`. It is not the main WebGUI or a handler gateway. Its page opens an explicitly configured or discovered current `managerBaseUrl`; it cannot start, repair, or stop Manager. Direct RibiWebGUI use does not require this NapCat plugin.
