<!-- docs-language-switch -->
<div align="center">
English | <a href="./agent-context-injection.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Agent Context Injection

> Status: current guide. Checked against `src/routing/agentPacket.ts`, role-knowledge behavior, and routing tests.

RabiRoute wraps a routed event before delivering it to a handler. The wrapper tells the handler where the event came from, which role is active, which lightweight plan/memory/skill indexes matter, where logs live, and how a reply must return through RabiRoute.

The route template should stay thin. Users normally add only rule-specific instructions; RabiRoute generates the stable event and context sections.

## Packet minimization boundaries

Default `focused` mode renders one required-reading list with IDs, summaries and GET endpoints, omitting empty indexes and duplicate recall summaries. Codex Hooks use the same view. Full instructions for plan and memory mutations, cross-persona delivery and remote tasks are read on demand from the corresponding sections of `rabi-agent-interfaces_en.md`; the operation stops if those instructions cannot be read. Packets retain authorization, dynamic Manager identity, idempotency, applicable strong ETag / If-Match and readback requirements. Explicit `legacy` configuration retains the previous index view for existing rollback workflows. Migrate through `contextInjection.mode=focused`; remove this compatibility branch once legacy configurations and their rollback requirement have been retired.

The explicit send request appears only once, in `[回传参数]`; delivery requirements reference that template while retaining the current workflow, target, source credentials and requirement receipts. Focused or immediately addressed discussion references a message ID when the complete same-ID message already appears in recent history. Truncated, unnumbered or absent messages retain their excerpt. History limits and reply chains are unchanged.

Configured secretary names, IDs, workspaces and responsibilities appear only for current plan, secretary or delegation intent, or a plan-feedback event. Remote-task instructions additionally require current remote-execution intent and an enabled remote endpoint. These gates only select instructions; they neither create tasks nor grant permission. Other operations remain discoverable through the interface document.

The shared packet contains no named person's companionship or heartbeat policy; the bound persona file and current template own those behaviors. Identity facts, candidate/conflict boundaries, explicit targets, attachments and reply evidence remain available.

## Unified trigger pipeline

Context entry points no longer call role knowledge independently. Each adapter emits a normalized trigger for `RabiContextManager`:

```text
Codex SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
RabiRoute QQ / webhook / voice / manual-trigger / heartbeat delivery
Manager or UI preview
  -> normalized ContextTrigger
  -> RabiContextManager
  -> roleKnowledgeSnapshot plus one lifecycle policy
  -> RoleKnowledgeContextView
  -> Codex additionalContext or AgentPacket
```

Adapters provide role, message or tool signal, session/turn/event identity, and source. They do not own keyword scoring, plan archival, memory activity windows, or `viewedAt`. Entry triggers use focused context by default, reasoning triggers add only newly relevant required reads for the turn, and preview forbids knowledge side effects.

## Injection principles

Default injection is lightweight:

- Essential event fields. A cross-persona message also carries source/target personas, both Routes, conversation correlation, the replied-to message, and the current hop count.
- CQ `reply` / `at` explanations for QQ messages. Reply chains are expanded from message records, while at mappings are collected together.
- Recent bidirectional messages allowed by the current endpoint's persona-owned `recentMessageLimits` value. The current event is excluded from this window because it already has its own section. `heartbeat` and the independent `plan_feedback` event are fixed exceptions and never read or inject message history.
- Role, route, and workspace-relative paths plus a compact persona core.
- A link to the Rabi Agent interface guide plus compact persona-discovery and explicit cross-persona delivery instructions.
- Up to three highly relevant plan, memory, and skill summaries by default.
- On-demand paths for complete plan, memory, and skill indexes.
- Log paths.
- The send API and serialized `replyContext`.

It does not inject every chat log, unrelated active indexes, complete plan body, complete memory body, consolidated-memory corpus, or full diagnostic report. The handler must fetch a specific item by ID when it needs details.

## Identity-relation context

A display name, group-owner or administrator flag, current Route, current workspace, and keyword similarity cannot independently establish who someone is or which project they own. A persona may keep separate identity-relation knowledge. On delivery, RabiRoute performs an exact lookup by `platform + endpointIdentityNamespace + senderStableId`. The Route configuration ID is delivery provenance only. For NapCat, a bot QQ ID takes precedence as the endpoint namespace; a renameable instance name is only the fallback. WeCom, Feishu, and Weixin are queried only when their message record carries a stable endpoint namespace; without one, the system declines to match rather than merge equal-looking IDs from different accounts. Moving the same account to another Route therefore does not create another person, and different endpoints are not silently treated as one account.

When an unfamiliar stable account first appears, the system automatically creates a separate “getting to know” candidate participant, and later messages from the same stable account reuse it. A display name is only a candidate alias. When explicit self-description, a new form of address, or another reviewable relationship clue appears, the processing Agent may append minimal evidence through the candidate-observation API; it writes nothing when no new clue was learned. `[Identity relations]` contains only the current account, confirmed participant, candidate mappings, relations scoped to the current conversation or project, and unresolved ambiguity. If append-only events form concurrent branches after multi-PC synchronization, the record is explicitly conflicted; it cannot confirm identity automatically until the persona submits one complete correction that supersedes those branches. It does not copy chat bodies or enter plan/recent-memory keyword recall and callback handling. A candidate is a verification lead only: it cannot be used to address a real person, grant authority, infer project ownership, or turn a discussion into a plan for the current project.

Identity relations answer only who is speaking and which confirmed or candidate relations are known. The next `[Situation record]` reads only project relation cards that already apply to this conversation and presents them as discussion leads; it never infers a project from the Route, current workspace, display name, or keywords. The record explicitly permits the Agent to join a useful discussion, clarify a question, or offer a suggestion, while defaulting to no query, creation, update, or handoff of project plans, tasks, or long-term project memory. A handler may enter project-management or execution flow only after it has separate, explicit project scope, request, and authorization.

Once that AgentPacket enters the actual delivery path, RabiRoute retains a persona-local situation record without chat text. It contains only the conversation key, message IDs, Route, identity/project leads, unresolved evidence, and the participate-versus-manage decision. The Persona page can review recent records to find a mistaken assessment. This does not change send outcomes or automatically write plans, tasks, or memory. Each persona keeps the latest 200 records. Because a situation record is derived from the original conversation and relation cards, it does not join multi-PC persona synchronization; the canonical bidirectional conversation record remains the source for the original chat.

## Canonical bidirectional conversation ledger

Automatic recent context no longer builds separate one-way summaries from `group-messages.jsonl`, `voice-transcripts.jsonl`, `wecom-messages.jsonl`, and similar protocol files. Those files remain audit and compatibility evidence. The automatic-context source of truth is:

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

The ledger includes both directions: QQ replies sent by the role, ASR/TTS, WeCom, Remote Agent, role panel, RabiLink, and other integrated endpoint traffic. Each record keeps the logical adapter, physical transport, direction, speaker, conversation, status, and safe attachment metadata without persisting private absolute attachment paths.

Automatic injection must match all three scopes: the current persona, the current logical endpoint, and the current conversation (for example a QQ group/private peer, WeCom chat, or speech `sessionId`). Inbound and outbound records share one count budget. `personaConfig.json.recentMessageLimits` independently configures ordinary endpoint values from `0` to `200`; the schema default is `12`, and `0` disables only automatic injection, never recording. `heartbeat` is always treated as `0`: even when a legacy config keeps a non-zero value, AgentPacket does not read the ledger or generate a recent-message section. The independent `plan_feedback` event is also fixed at `0` and does not enter the unified conversation ledger because its dedicated feedback JSONL is the audit source of truth. There is no separate 360-entry or other count cap on `current.jsonl`.

Personas may select the injection policy in `personaConfig.json`:

```json
{
  "contextInjection": {
    "mode": "focused",
    "relevantKnowledgeLimit": 3,
    "personaMaxChars": 1600
  }
}
```

`focused` is the safe default: it injects the current conversation window, relevant summaries, and a compact persona workset. `relevantKnowledgeLimit` accepts `1–12`; `personaMaxChars` accepts `800–6000` for the Codex Hook excerpt. Set `"mode": "legacy"` to restore full active indexes, the previous 5/12 recall limits, and the 3200-character persona excerpt. Existing files without this field remain readable and require no private-value migration.

Archival follows record timestamps rather than deleting data at a calendar boundary. When an archive check finds any record older than 72 hours, the complete contiguous prefix older than 24 hours moves to `<firstSequence>~<lastSequence>.jsonl`. Automatic context reads only `current.jsonl`. Archives remain preserved and can be queried explicitly through the injected paths.

## User template role

A route template may be empty. Use it only for an extra constraint such as:

```text
Keep any group-chat draft short.
```

or:

```text
Record this event, but do not produce an external reply.
```

RabiRoute places this text in the `[User template supplement]` section. Event fields, role paths, logs, plan/memory indexes, and reply instructions do not need to be repeated in every rule.

## Current wrapper

Every RabiRoute delivery starts with the exact wire section `[消息源]`, immediately followed by `[消息内容]`. Event details, recent messages, reference parsing and role paths follow under `[相关上下文]`. Generic collaboration rules are not injected. Empty or disabled sections are omitted.

Each source type has its own required identity. `message_adapter` requires `messageAdapter`, `conversationType`, `conversationId`, `messageId`, and either `senderName` or `senderId`. `agent` requires the actual `agentAdapter`, session name, and complete session ID. `plan` requires the plan name and ID. `system` requires event type, name, and ID, with optional actor type, name, and ID.

`contextBlocks` carry event, attachment, and recent-message context. `controlBlocks` carry reply parameters and current delivery requirements. The fixed order is source, message content, context blocks, then control blocks. Neither block type may contain `[消息源]`, `[消息内容]`, or `[投递源]`; bracketed headings in message content are quoted so they cannot impersonate peer control sections.

Legacy `[投递源]` wrappers, nested envelopes, and old Agent response wrappers are removed before the new envelope is rendered. When an old replay record did not persist structured provenance, RabiRoute labels it as `历史投递记录` instead of guessing the original endpoint, Agent, or session.

```text
[消息源]
消息源类型：<消息端 | Agent | 计划 | 系统>
<type-specific name, complete ID, session, plan, or Route fields>
消息包发送时间：<time of this delivery>

[消息内容]
<message>

[事件信息]
事件：<event label>
路由类型：<routeKind>
事件时间：<time>

[最近消息]
最近 <recentMessageLimit> 条双向消息：
<recentMessages>

[Message code parsing]
[CQ:reply,id=<messageId>] : <referenced-message preview>
  [CQ:reply,id=<messageId>] : <earlier referenced-message preview>
[CQ:at,qq=<qq>] : <group card or nickname>

[Role and paths]
Role: <agentRoleId>
Role file: <agentRolePath>
Role directory: <agentRoleDir>
Runtime data directory: <dataDir>
Plans: <plansDir>
Memory: <memoryDir>

[Memory and plans]
Interface guide: <agentInterfaceDocPath>
On-demand read endpoints and the interface document
Read the applicable contract before mutations or delivery; stop if unavailable
Retain authorization, dynamic Manager identity, idempotency, applicable strong ETag / If-Match and readback requirements

[Pre-action context confirmation]
<required-read items and GET endpoints>

[Logs]
Group, private, heartbeat, manual-trigger, role-panel, and voice-transcript paths
Current bidirectional conversation: <conversationCurrentPath>
Conversation archive: <conversationArchiveDir>
Conversation archive index: <conversationArchiveIndexPath>

[Reply parameters]
Send API: <sendApiUrl>
Explicit send template: <sendRequestJson>
Source context for audit and cross-persona contact only: <replyContextJson>

[Send requirements]
<instructions derived from outputAdapter, source, and replyToSource>

[Remote Agent devices]
<requires current remote-execution intent and an enabled remoteAgent endpoint>

[User template supplement]
<optional route template>
```

For `heartbeat` and `plan_feedback`, the entire recent-message section is omitted. `{recentMessageLimit}` is `0` and `{recentMessages}` is an empty string, so a custom template cannot reintroduce historical message bodies. Heartbeat audit logs and the unified ledger continue to be recorded for explicit on-demand inspection. Plan feedback keeps only its dedicated feedback audit, AgentPacket, and delivery logs; it is not duplicated into the role-panel timeline or unified conversation ledger.

Codex final text is only a record in the current handler task. It does not prove that the source user, Primary Persona, or another Agent received anything. A platform send must start from `sendRequestJson`, fill `sender.agentType` and the current complete `sender.sessionId`, submit an exact `routeId`, `channel`, channel-specific `params`, and `payload`, and obtain that channel's receipt. When a Codex Primary Route enables **Only Primary Persona Can Send Messages**, the sender must be `primary_persona` and its `sender.sessionId` must exactly match that Route's `codexThreadId`; other Agent endpoints follow their injected template. A NapCat group request must keep `params.replyToMessageId`: use the source message ID whenever a quote is possible, or `""` for an intentional unquoted message. If the quoted message contains images, `params.replyImageDescriptions` must describe every image in original order, including what is visible and what it communicates; an unreadable image, missing description, or count mismatch blocks sending. The handler must not submit `replyContextJson` as the destination or infer a destination from the source. A handoff to the Primary Persona, Secretary, or Plan Agent must use the Manager thread bridge with the sender's complete task ID and Agent type. A draft, approval question, or progress summary that never enters one of these exits cannot be marked replied or notified.

The cross-persona capability proves only the Route and persona that own the current AgentPacket. It is never returned by `GET /api/personas`, the target timeline, or delivery receipts. `sourceRouteId` alone does not authenticate a sender. After a target persona receives a cross-persona message, an ordinary reply does not return to the source automatically; it must explicitly POST back with the received conversation, reply-reference, and hop fields.

`[Message code parsing]` appears only when the current message or its reply chain contains parseable CQ codes. RabiRoute follows `CQ:reply` by `messageId` through the current route's group/private message records, while AgentPacket also accepts successful Outbox sends as a local fallback. When the live NapCat path sees a referenced ID that has not been stored, the adapter calls OneBot `get_msg` before routing, caches the returned group/private record with `lookupSource=onebot_get_msg`, and continues with the next reply level. API failures are logged as warnings and do not block the current message. Expansion stops when no reply remains, the reference still cannot be resolved, a cycle is detected, or the safety depth limit is reached. Each referenced preview is capped at 200 characters and then uses `……(更多信息调用接口查看)`. Any `CQ:at` found during the walk is deduplicated and emitted together as `[CQ:at,qq=xxxx] : group card or nickname`. This section does not add the current message ID and does not repeat the plain text body.

When a `voice_transcript` explicitly comes from the RabiPC `speech` message endpoint or RabiSpeech, `AgentPacket` resolves that turn to `voice_chat`, writes `characterTtsDialogue=true` into the source context, and generates a send template with `channel=speech` and the current `sessionId`. `[Send requirements]` tells the handler to enter character-TTS dialogue mode and POST a short spoken line, semantically identical to the visible reply, to the explicit send API. Outbox resolves model, voice, language, speed, and speaking instructions from the current persona's `voice/voice-profile.json`, preserves the original `sessionId`, and enters the host-wide FIFO. Same-session ASR and TTS then share the persona's `speech` recent-context budget. QQ, the role panel, ordinary text inputs, and other `voice_transcript` sources do not inherit this switch.

Speech also has an explicit record-before-wake policy. Route `speechPushMode=hot` delivers every completed ASR segment immediately. `keyword` records every segment and delivers only when the persona-owned `speechTriggerKeywords` matches; an empty keyword list never falls back to hot. Matched ordinary endpoint messages otherwise enter Desktop `steer/start` directly, while Heartbeat's busy skip remains a separate switch.

The processing host, voiceprint IDs, and compatibility voice-account data path appear only on voice-transcript records. QQ, role-panel, and other non-audio events omit these voice-specific fields.

When no role is bound, RabiRoute uses a direct-message section instead of role knowledge. It still injects the event, logs, reply context, and delivery requirements.

## Workspace-relative paths

Role and log paths are rendered relative to the RabiRoute workspace when possible:

```text
data/roles/Rabi/persona.md
data/roles/Rabi/plans
data/roles/Rabi/memory
data/route/default-main/group-messages.jsonl
docs/rabi-agent-interfaces.md
```

This avoids leaking usernames or machine-specific absolute paths into prompts and public examples.

## Recall and required reads

In default `focused` mode, `[Memory and plans]` contains read endpoints and the operation-contract entry. Required IDs, summaries and GET endpoints appear once in `[Pre-action context confirmation]`. Explicit `legacy` mode retains full indexes. Current plans are unarchived plans whose persona status definition includes the `current` view; other plans participate in the views configured by `personaConfig.json.planWorkflow`. Status labels and ordering also come from that persona workflow. `archiveStatus=已归档` plans are excluded before keyword scoring even when ID, title, or keywords match; only an explicit plan-ID read or Archived view can return them. A recent memory is considered active using the later of `updatedAt` and `viewedAt`; the default direct-display window is 24 hours.

Before delivery, RabiRoute performs lightweight matching over metadata only:

- plan, memory, and skill IDs;
- titles;
- Agent-maintained `keywords`;
- small ranking bonuses for active plans and active recent memories.

It does not tokenize or scan every body on the hot path. The top relevant items, normally up to five, become `[Pre-action context confirmation]` entries with GET endpoints. The handler must read these items before replying, changing plans or memories, creating tasks, or taking an external action. If an item cannot be read or is insufficient, the handler should state the uncertainty or ask the user.

Matching a recent or consolidated memory refreshes its `viewedAt`. Reading a memory by ID also refreshes `viewedAt`; updating recent memory refreshes both `updatedAt` and `viewedAt`.

## Automatic or explicit memory consolidation

Memory consolidation uses a `manual_trigger` event with `triggerId=memory-consolidation`, produced automatically at the earliest 72-hour deadline or requested manually, plus an explicit Manager API request. The trigger reevaluates the current 72/24-hour thresholds before creating a pending run.

When a pending run is attached, the wrapper includes:

- `runId`;
- the result endpoint;
- the consolidation instruction;
- eligible recent-memory bodies.

The handler returns consolidated memories to the result endpoint; it does not move files or choose the input set.

## Template-value boundary

Advanced route templates can use actual values such as:

```text
{agentInterfaceDocPath}
{plansDir}
{memoryDir}
{recentMessages}
{recentMessageLimit}
{recentMessageEndpoint}
{recentConversationKey}
{conversationCurrentPath}
{conversationArchiveDir}
{conversationArchiveIndexPath}
{sendApiUrl}
{sendRequestJson}
{replyContextJson}
{rolePanelLogPath}
```

Focused match summaries and full-index query paths are produced by the wrapper itself. Legacy mode expands the active-plan, recent-memory, and skill indexes. None of these are independent free-form route-template variables. See [Routing Configuration](routing-configuration_en.md) for the broader template vocabulary.

## Boundary

Context injection is not a long-term-memory database, planner, or executor. It provides a compact evidence index and safe return path. The handler reads details by ID, writes recent memory when appropriate, and submits replies through RabiRoute rather than bypassing the message adapter.
