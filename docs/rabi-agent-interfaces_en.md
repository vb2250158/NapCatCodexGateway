<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-agent-interfaces.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Interfaces for Handlers

> Status: current Agent-interface guide. The Remote Agent device path remains experimental; other interfaces have been checked against the current Manager API and tests.

These are local RabiRoute interfaces used by a handler after it receives an `AgentPacket`. They let the handler return a normal reply, work with Codex threads, maintain role plans and memories, read role skills, and optionally delegate to a connected Remote Agent device.

RabiRoute owns storage, policy checks, delayed plan archiving, explicit memory-consolidation runs, context injection, and Outbox delivery. The handler decides when a plan or memory should change and what response or task is appropriate.

## Context supplied to the handler

The packet normally includes:

```text
Rabi interface guide: docs/rabi-agent-interfaces.md
Send API: `<managerBaseUrl>/api/agent/send`; installed clients discover this generation through Host `status --json`, while source mode uses Manager stdout.
Current reply context: {...}
```

It also includes active-plan, recent-memory, and skill indexes plus `[Pre-action context confirmation]`. The handler must fetch every required-read item before replying, modifying role knowledge, publishing a task, or taking an external action.

### Local Manager mode for knowledge APIs only

When a direct Codex task needs the role plan or memory APIs but must not let Manager automatically start enabled gateways, the RabiLink Relay, or LAN discovery, set this before starting Manager:

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

The Manager still serves `/meta`, plan, memory, and validation APIs; `GET /meta` reports `managerAutostart: false`. This mode disables automatic startup for stopped Routes and disables the file watcher, but explicit runtime-control endpoints remain available. If a caller has explicitly started a Route and then saves its configuration through Manager, Manager still restarts that running Route so new task, model, and message-input settings become the real delivery state; otherwise the saved UI state could diverge from the live child process. A caller must not request start, restart, trigger, reply, or outbound actions without the corresponding authorization. Production tray startup and normal message routing remain unchanged when the variable is unset.

### Codex Hook context API

The Codex plugin must send raw Hook events to Manager instead of duplicating persona, plan, memory, or recall logic inside the plugin:

```http
POST /api/codex-hook/context
```

The body uses Codex Hook fields and must contain `hook_event_name` plus the real `session_id`. Current events provide:

- `SessionStart`: `source`;
- `UserPromptSubmit`: `turn_id` and `prompt`;
- `PreToolUse`: `turn_id`, `tool_name`, `tool_use_id`, and `tool_input`;
- `PostToolUse`: those fields plus `tool_response`.

Manager interprets strict `[rabi:*]` controls, owns the session binding, and normalizes these events as `session_start`, `user_prompt`, `reasoning_pre_tool`, or `reasoning_post_tool`. They and normal RabiRoute `message_delivery` enter the same `RabiContextManager`; it is the sole caller of `roleKnowledgeSnapshot()` and owns plan archival and `viewedAt` policy. Manager returns model-visible text in `data.additionalContext`; an unbound session returns an empty string.

Reasoning triggers return only newly relevant knowledge for the current turn. Within one `turn_id`, Manager deduplicates by item type, ID, and revision time, so repeated Pre/Post hits neither inject nor refresh `viewedAt` again. The `preview` policy does not archive plans, refresh `viewedAt`, or create a consolidation run.

Rabi PC may manage exact session bindings proactively:

```text
GET    /api/codex-hook/roles
GET    /api/codex-hook/sessions
GET    /api/codex-hook/sessions/:sessionId
PUT    /api/codex-hook/sessions/:sessionId  { "roleId": "YeYu" }
DELETE /api/codex-hook/sessions/:sessionId
GET    /api/codex-hook/doctor
```

Binding state is private Manager runtime data. The plugin must not keep another binding, role-root registry, keyword index, or memory body cache. If Manager is unavailable, fail open and say that no fresh context was injected; never fabricate success from plugin-local state.

### Wearable health queries

With the `wearable` endpoint enabled, structured observations enter a role-scoped health timeline rather than ordinary chat history. Agents query the local Manager API instead of copying complete health records into every prompt:

```text
GET   /api/roles/:roleId/health/state
GET   /api/roles/:roleId/health/history?metric=heart_rate&from=<ISO>&to=<ISO>&limit=100&order=desc
GET   /api/roles/:roleId/health/summary
GET   /api/roles/:roleId/health/config
PATCH /api/roles/:roleId/health/config
POST  /api/roles/:roleId/health/observations
```

`state` and `summary` include staleness. An Agent must not interpret `unknown` or stale data as a definite sleeping, awake, or medical state. Relay observations that match heart-rate or sleep rules become `wearable_health_alert` Agent events. Wearable authentication keys, Relay tokens, and raw sensitive metadata must never be submitted as observation fields. See [`rabilink-wearable-health_en.md`](./rabilink-wearable-health_en.md) for the full contract and acceptance boundary.

### Discovering and messaging other personas

“Persona” is the user-facing and Agent-facing term. Existing `roleId`, `/api/roles/*`, and `data/roles/` names remain as compatibility-oriented internal identifiers. Call the dedicated directory instead of decoding Route-management payloads:

```http
GET /api/personas
GET /api/personas?addressable=true
GET /api/personas/:personaId
```

The directory returns each persona's `personaId`, display name, reachability, and bound Routes. `addressable=true` keeps only personas with at least one enabled Route. A persona with exactly one enabled Route also exposes `defaultRouteId`.

To contact another persona, address the target persona and read `runtimeRouteId` plus `personaMessagingCapability` from the current `AgentPacket.replyContext`. The capability is bound to both the Route and persona and cannot be reused as another identity:

```http
POST /api/personas/:targetPersonaId/messages
Content-Type: application/json

{
  "deliveryId": "stable-unique-delivery-id",
  "sourceRouteId": "source-route",
  "sourceCapability": "value-from-replyContext.personaMessagingCapability",
  "targetRouteId": "optional-when-target-has-one-enabled-route",
  "conversationId": "optional-stable-conversation-id",
  "inReplyToMessageId": "optional-message-id-being-answered",
  "hopCount": 0,
  "text": "Please check today's build status."
}
```

`deliveryId` is required and must remain stable for one business delivery. The same ID and request execute once and retries return the completed result; the same ID with changed content returns `409`. If the outcome is uncertain, query the receipt before creating a new ID:

```http
GET /api/personas/messages/receipts/:deliveryId
```

Both source and target Routes must be enabled. If the target persona has multiple enabled Routes, `targetRouteId` is required and Manager does not guess. Self-delivery is rejected. `hopCount` must be a non-negative integer and cannot exceed `8`. HTTP `202` with `status=delivered` means the target handler accepted the message through that Route's existing `role_panel_message` path. The service records `status=sent` only after handler acceptance; a failed timeline entry records an attempt only.

Cross-persona delivery is explicitly one-way and does not create an automatic two-way chat. The target persona's ordinary reply remains in its own role panel. To answer the source persona, it must POST again with a new reply `deliveryId`, reuse the received `personaConversationId`, set `inReplyToMessageId` to the current message ID, and increment `personaMessageHopCount`. Stop when `personaMessageMaxHops` would be exceeded.

## Identity-relation memory API

Identity relations record which participant an endpoint account may represent and which person, organization, or project relations are confirmed or unresolved. Relation records do not split into long-term and short-term types; temporary roles in the current message belong to Situation records. Identity relations are persona-private. Automatic “getting to know” candidates are created only when a supported endpoint supplies a stable `senderStableId` and `endpointIdentityNamespace` from its actual sender fields and the message enters a real matched Route delivery. A nickname, group privilege, one self-description, or an identity claim quoted in message content can never trigger confirmation. An account lookup requires all of `platform`, `endpointIdentityNamespace`, and `senderStableId`; do not substitute a Route ID for any of them.

```text
GET /api/roles/:roleId/identity-relations
GET /api/roles/:roleId/identity-relations?platform=<platform>&endpointIdentityNamespace=<namespace>&senderStableId=<id>&conversationKey=<optional>
PUT /api/roles/:roleId/identity-relations
POST /api/roles/:roleId/identity-relations/observations
```

`GET` without query parameters returns the current account, participant, and relation-card views. With a complete account key, it returns that account's resolution context. A `PUT` writes exactly one `endpoint_account`, `participant`, or `relation_card` for explicit confirmation, correction, or conflict handling. `POST .../observations` is for new identity clues found by a processing Agent during conversation: it can update only the candidate participant and candidate relations already linked to that endpoint account, never write `confirmed`, and never overwrite a conflicted record. Include minimal evidence references such as a message ID, endpoint, conversation, or short verification note; never copy a private chat body in full. After multi-PC synchronization, a record with disagreeing concurrent event heads is marked with `conflicted`, exposes `conflictEventIds`, and retains each complete candidate record in `conflictCandidates` for the persona page to compare before correction; it cannot take part in automatic confirmation. To converge it, a `PUT` must explicitly provide every material field for that record, and its new event replaces all current heads.

A stable account key proves only that messages came from the same endpoint account, not that one person always controlled it. A shared account or contradictory evidence may therefore retain several candidate `participantLinks`. When the endpoint account has exactly one candidate participant, an observation may omit `participantId`; with several candidates, the caller must first use `GET` with the complete account key and then name one returned candidate ID explicitly. The system never chooses from nickname similarity, recent activity, or the highest confidence value.

Evidence has different roles. An explicit user correction, verifiable cross-endpoint ownership, and a persistent stable-account fact may support manual confirmation. A self-reported name, another person's claim, a display name, or consistency in vocabulary, sentence patterns, and response rhythm is supporting candidate evidence only. Repetition does not make those signals sufficient for a confirmed mapping. If the source cannot supply a stable sender identity, or the claim appears only inside forwarded, quoted, or attached content, the Agent must leave the identity unresolved and must not use the observation API to merge it into an existing person.

A speaking-habit profile belongs to a participant record. It can be changed only through a reviewed `PUT`; the observation endpoint must not learn it automatically from unattributed messages. Each `speakingHabits` item contains a `dimension`, natural-language `description`, optional `confidence`, and `evidenceRefs`, with at least one `messageId` whose author has already been confirmed. Allowed dimensions are `sentence_opening`, `sentence_length`, `stance_expression`, `emotion_threshold`, `analogy_source`, `punctuation`, `reader_relationship`, `value_preference`, `information_order`, `avoidance`, `imperfection`, and `scene_boundary`. A message from a shared account must not enter anyone's profile while its author remains unresolved.

```json
{
  "kind": "participant",
  "participantId": "participant-example",
  "speakingHabits": [
    {
      "dimension": "sentence_opening",
      "description": "Usually states the current judgment before adding conditions and unknowns.",
      "confidence": 0.75,
      "evidenceRefs": [
        { "messageId": "confirmed-author-message-id", "note": "The author was confirmed by review." }
      ]
    }
  ]
}
```

```json
{
  "platform": "napcat",
  "endpointIdentityNamespace": "bot:example",
  "senderStableId": "example-user",
  "participantKind": "person",
  "participantDisplayName": "a name explicitly stated by the speaker",
  "aliases": ["a new form of address from this message"],
  "conversationKey": "napcat:group:example",
  "evidenceRefs": [
    {
      "messageId": "example-message-id",
      "conversationKey": "napcat:group:example",
      "note": "Keep only the identity clue and reasoning; do not copy the full chat."
    }
  ]
}
```

The Persona page projects the same read model into **Recognized identities** and **Unrecognized identities**. A recognized person uses the whole card as its entry point, and one identity workspace displays and edits participant details, speaking habits, endpoint accounts, and relations. Participants, accounts, and relations still use separate `PUT` requests and do not form one transaction. An exclusive account appears for one person, while a shared account with a known user set appears for every possible user with a **Shared** marker even though resolution remains ambiguous. **Unrecognized identities** groups accounts by endpoint type when their people are still unknown, their candidates do not yet point to recognized people, or their evidence is conflicted. The page refreshes after an identity correction or persona-sync event. Per-message attribution for shared accounts, other candidates, and conflicts remain verification material only and must not appear as project ownership or execution authorization.

Conceptually, a voiceprint is also an endpoint account. The current generic key uses `platform=voice`, `endpointIdentityNamespace=host:<processing-host-id>`, and `senderStableId=voiceprintId`; one multi-speaker recording may reference several accounts. The current UI places voice classification inside **Identity positioning**, while existing data still uses the compatibility `voice-identities` API and file described below. Do not write the same decision through both APIs. Until the data migration is complete, “This is me / Another person”, coverage, and conflict readback remain authoritative through the compatibility interface below.

### Situation records

```text
GET /api/roles/:roleId/conversation-situations?limit=20
GET /api/roles/:roleId/conversation-situations/:situationId
```

Actual message delivery creates this read-only situation record. It contains no chat text: only conversation and message identifiers, project leads derived from relation cards, attachment or identity ambiguity, and `mayParticipate=true` with `mayCreateOrUpdateCurrentProjectRecords=false`. It lets a reviewer see whether proactive intelligence confused “may join a discussion” with “should manage the current project.” The interface cannot create, confirm, or authorize a project action.

```json
{
  "kind": "endpoint_account",
  "platform": "napcat",
  "endpointIdentityNamespace": "instance:qq-main",
  "senderStableId": "example-user-id",
  "participantLinks": [
    {
      "participantId": "participant-example",
      "status": "confirmed",
      "confidence": 1,
      "evidenceRefs": [{ "messageId": "example-message-id" }]
    }
  ]
}
```

A candidate is for verification only and cannot support real-name address, authorization, project attribution, or execution. `confirmed` establishes only the identity or relation itself; it never bypasses explicit delegation, project scope, or approval for external action. Identity relations do not enter `knowledgeMatches` and do not need a `knowledge-callback` for every message.

## Explicit send API

All outbound endpoint messages use one API. The legacy `/api/agent/replies` endpoint is removed. `/api/agent/send` does not accept an unchanged `replyContext` and infer a destination from it.

```http
POST /api/agent/send
```

```json
{
  "deliveryId": "send-example-001",
  "sender": {
    "agentType": "primary_persona",
    "sessionId": "019f0000-0000-7000-8000-000000000001"
  },
  "routeId": "main",
  "channel": "napcat",
  "styleValidation": 1,
  "params": {
    "target": "group",
    "groupId": "example-group-id",
    "instanceId": "default",
    "replyToMessageId": "example-message-id",
    "replyImageDescriptions": [
      "The image shows the background growing with a longer dynamic label, indicating that its width must follow the text."
    ]
  },
  "payload": {
    "type": "text",
    "text": "Received. I will investigate."
  },
  "tracking": {
    "requirementId": "message-requirement-001",
    "sendContextReviewToken": "<token returned by POST send-context>"
  }
}
```

`styleValidation` is the enum `1 | 0` and defaults to `1`. A persona may bind its own style Skill through `personaConfig.json.languageStyle.styleSkillUrl`; different personas may use different URLs. The URL may point to a Skill directory, `SKILL.md`, or `references/style-data.json`.

With `styleValidation=1`, a failed check returns `409` with `status=style_confirmation_required`, rule IDs, paragraphs, reasons, and evidence. No Outbox send has started. After confirming that the wording is intentional for this message, the Agent may retry the same `deliveryId` with `styleValidation=0`. This bypass applies only to that request and does not remove the persona binding.

The generic analysis endpoint does not send a message:

```http
POST /api/language-style/validate
```

```json
{
  "text": "text to inspect",
  "styleSkillUrl": "file:///path/to/style-skill",
  "scope": "outbound_message",
  "prompt": "optional source prompt"
}
```

The response contains `passed`, `status`, `violations`, `checkedRuleIds`, and `skippedRuleIds`. The Codex Stop Hook uses the same endpoint only for a failure notice; it never blocks or rewrites Codex output.

`deliveryId`, `sender.agentType`, `sender.sessionId`, and the exact enabled `routeId` are required. `sender.agentType` identifies the sending Agent role and `sender.sessionId` identifies its complete session. The injected request template is the source of truth. When a Codex Route enables **Only Primary Persona Can Send Messages**, the only accepted sender is its bound Primary Persona task: `sender.agentType=primary_persona` and `sender.sessionId` must exactly match `codexThreadId`. `channel` selects the only delivery adapter, while `params` carries the channel-specific destination. Supported channels are `napcat`, `wecom`, `weixin`, `feishu`, `rabilink`, `speech`, `fennenote`, `role_panel`, and `plan_feedback`. Source context remains available for auditing, but it cannot override `channel` or `params`. A reply associated with a message-processing requirement also carries `tracking.requirementId` and a short-lived `tracking.sendContextReviewToken` obtained for that exact sender session, destination, and payload.

For NapCat, use `target=group + groupId` or `target=private + userId`. Every group send must explicitly include `replyToMessageId`: use the real source message ID whenever one is available, or use the empty string `""` for an intentional unquoted group message. When the quoted message contains images, `replyImageDescriptions` must contain one concrete description per image in original order, covering both visible content and intended meaning. A missing source record, unreadable image, count mismatch, empty description, or generic acknowledgement is rejected before idempotent delivery. WeCom and Feishu require `chatId`; Weixin requires `sessionId`; RabiLink requires `targetDeviceIds` or `targetDeviceKinds`; speech explicitly selects RabiSpeech and never proves a QQ send.

### Message-processing requirements and board API

With Message Agent mode enabled, Manager assigns each delivered message group a `messageProcessingRequirementId` and includes it in AgentPacket `replyContext` and the worker instructions. The Agent closes a turn through a structured interface; a Codex final message alone is not a processing outcome.

```http
POST /api/message-processing/requirements/:requirementId/outcome
```

For a reply, submit the decision first so the requirement enters `awaiting_send`, complete the pre-send context review, and then call the explicit send API. Manager completes the board item only when the selected channel matches the source endpoint and the result contains the receipt required by that channel:

```json
{
  "decision": "reply",
  "reason": "The user explicitly requested confirmation of the name and prefab location."
}
```

The Agent must not rely only on the recent messages captured when AgentPacket was created. During processing, another person or Agent may already have answered. Read Manager's current bounded bidirectional context first:

```http
GET /api/message-processing/requirements/:requirementId/send-context?sourceMessageId=:sourceMessageId
```

A single reply must pass the `sourceMessageId` it will quote. The response retains bounded context while narrowing `requiredReviewIds` to that main message and the explicit reply chain derived from message records. Other messages in the aggregate requirement still contribute to the context version but do not need to be declared as evidence for this body. After deciding that the exact proposed reply still fits the conversation, submit that request for approval:

If an older source has fallen outside the recent window, Manager may recover only one record with the same Route and `sourceMessageId` from the formal `group-messages.jsonl` for that requirement's persona. A missing record, duplicate records, or conflicting Route evidence fails the GET instead of expanding to another group or historical requirement.

```http
POST /api/message-processing/requirements/:requirementId/send-context
```

```json
{
  "contextVersion": "<version returned by GET>",
  "reviewedContextIds": ["<requiredReviewIds for this sourceMessageId and explicit reply chain>"],
  "reviewedByThreadId": "<complete current session ID>",
  "reason": "No one has answered yet and the proposed text still addresses the current question.",
  "proposedSend": {
    "deliveryId": "send-example-001",
    "sender": {
      "agentType": "primary_persona",
      "sessionId": "019f0000-0000-7000-8000-000000000001"
    },
    "routeId": "main",
    "channel": "napcat",
    "params": {
      "target": "group",
      "groupId": "example-group-id",
      "instanceId": "default",
      "replyToMessageId": "example-message-id"
    },
    "payload": {
      "type": "text",
      "text": "Received. I will investigate."
    },
    "tracking": {
      "requirementId": "message-requirement-001"
    }
  }
}
```

Add the returned `sendContextReviewToken` to `tracking` and send the unchanged request. The token expires after two minutes. A new conversation item, a changed requirement state, sender session, destination, quoted message, or payload invalidates the approval and requires another read. A paraphrase is still a duplicate when another Agent already replied to the same source. A genuine follow-up with new facts must explicitly use `allowAdditionalReply=true` and explain why.

During reference and image validation, a tracked send uses only the exact formal source evidence bound to this approval. A stale requirement `conversationKey` or `replyContext.groupId` cannot redirect the source to another group. A mismatch between the formal group, Route, instance, and send target, a non-unique source record, or an image attachment not marked reviewed blocks the send. Ordinary untracked sends keep the original Route-history lookup and do not use this recovery.

This gate applies to every Agent type. When `replyToMessageId` points to the source of a known message-processing requirement, a Primary Persona or another Agent cannot omit `tracking.requirementId` to bypass the board and context review.

Ordinary group discussion may use `no_reply` with a reason. Explicit mentions, direct replies, private messages, and plan-progress notifications cannot be closed by a generic `agent_judgement`; only constrained reasons such as duplicate, already answered, withdrawn, or invalid source are accepted.

Before replying or closing any new requirement, the Message Agent must inspect the source messages, attachments, and necessary reply chain and submit `projectFactAssessment`. First read `GET /api/message-processing/requirements/{requirementId}`. Its `knowledgeMatches` are plan and memory candidates derived by Manager; the Agent reads each candidate and reports the result through `POST /api/message-processing/requirements/{requirementId}/knowledge-callback`. An `updated` or `created` callback still carries `recordType`, `recordId`, and `verifiedAt`, and the referenced plan or memory must contain the original message ID.

New requirements also carry `source.evidenceReviewRequired=true`. Manager retains the aggregate requirement's complete evidence in `source.messageIds`, `source.replyChainMessageIds`, and `source.attachments`. NapCat images are saved immediately at ingress and delivered to the Desktop turn as `localImage` input. A CQ marker, filename, or URL alone is not an image review. Before reply or closure, the outcome also submits:

```json
{
  "sourceEvidenceReview": {
    "reviewedMessageIds": ["source-message-id", "quoted-message-id"],
    "replyChainChecked": true,
    "attachmentReviews": [
      {
        "attachmentId": "source-message-id:image:1",
        "status": "reviewed",
        "observation": "The image shows a dynamic-text backing panel whose current text is shorter than its maximum width."
      }
    ],
    "evidence": "Reviewed the current message, quoted message, and image attached to the Desktop turn.",
    "reviewedAt": "2026-08-11T12:00:00.000Z",
    "reviewedByThreadId": "complete Message Agent task ID"
  }
}
```

A `reply` outcome may submit the evidence already reviewed and enter `awaiting_send`. POST send-context recalculates the exact subset from `proposedSend.params.replyToMessageId`: the selected main message, its explicit reply chain, and attachments carried by that quoted message or explicitly referenced by the body. `sourceEvidenceReview` and `projectFactAssessment` must cover that subset. Quoted group-reply ownership is calculated only among requirements with `kind=message_reply`; derived notifications such as `plan_progress_notification` do not own the right to quote-reply to the original group message. Historical duplicates with the same Route, message group, and source message allow only the canonical `message_reply` with the latest `createdAt` to continue. If no `message_reply` exists, ownership fails closed instead of falling through to a plan notification. Different groups or Routes, a non-unique newest item, a missing reply-chain record, an unavailable relevant attachment, or body evidence outside the fact assessment also fails closed. An unavailable attachment on an unrelated message in the same aggregate requirement does not block this reply. Closing the whole requirement with `no_reply` still requires complete message and attachment coverage. Source-evidence review remains separate from project-fact classification.

When the source contains a durable schedule, scope, approval, ownership, or release fact, `criticalFactDisposition` uses a typed record reference:

```json
{
  "decision": "no_reply",
  "reason": "No repeated group reply is needed, but the internal release target was recorded in the shared plan.",
  "projectFactAssessment": {
    "status": "critical",
    "reviewedMessageIds": ["msg-schedule-1"],
    "replyChainChecked": true,
    "evidence": "The source describes an internal target, not a public launch commitment.",
    "assessedAt": "2026-08-05T06:00:00.000Z",
    "facts": [
      { "kind": "schedule", "evidence": "The team is currently targeting 2030-10-15 internally." }
    ]
  },
  "criticalFactDisposition": {
    "status": "recorded",
    "record": {
      "type": "plan",
      "planId": "plan-example-release"
    },
    "evidence": "messageId=msg-schedule-1; source and reply chain verified.",
    "verifiedAt": "2026-08-05T06:00:00.000Z"
  }
}
```

Plan references use `{ "type": "plan", "planId": "..." }`; memory references use `{ "type": "memory", "memoryId": "..." }`; project documents use `{ "type": "document", "relativePath": "docs/..." }`. Document paths are relative to the current project. Absolute paths, parent traversal, and filesystem-link escapes are rejected. Manager reads the typed target and verifies that it exists and contains at least one original source message ID. A plausible ID, path, or self-reported evidence alone cannot close the item. Existing records use `status=duplicate`; incomplete assessment or recording must remain a structured handoff.

A handoff to a Secretary, Plan Agent, or Primary Persona uses `/api/agent/threads` action `send` with a structured field. Manager marks the board as handed off only after the target Desktop owner accepts the request. Include `planId` when known so later progress can return to the source group or private conversation:

```json
{
  "action": "send",
  "threadId": "<target-task-id>",
  "cwd": "C:/Path/To/Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "<message-agent-task-id>",
    "sessionName": "current Message Agent task name"
  },
  "sourceThreadId": "<message-agent-task-id>",
  "sourceAgentType": "message_processing",
  "prompt": "Handle this plan item and return the result to the source Message Agent task.",
  "messageProcessing": {
    "requirementId": "<requirement-id>",
    "outcome": "handoff",
    "targetAgentType": "plan_agent",
    "planId": "<plan-id>",
    "planTitle": "<plan-title>"
  }
}
```

No extra endpoint is required. The same request returns the delivery result directly. The target Codex Desktop task has accepted the message only when all three values below are present; this does not mean the target has completed the work:

```json
{
  "code": 0,
  "status": "delivered",
  "delivery": {
    "status": "delivered",
    "targetThreadId": "<target-task-id>",
    "acceptedBy": "codex_desktop_owner",
    "action": "started",
    "transport": "desktop-ipc"
  },
  "handoff": {
    "status": "recorded",
    "requirementId": "<requirement-id>"
  }
}
```

If `prompt`, `sourceThreadId`, or another required value is missing, the same response returns `code=-1`, `status=failed`, and actionable `error.field`, `error.message`, and `error.retryable` values. If the target task accepted the message but the message-processing board update failed, the response uses `status=delivered_tracking_failed`. Do not resend the same content to the target; handle or report `handoff.status=tracking_failed` instead.

Maintainers and WebGUI read the same Manager-owned state:

```http
GET /api/message-processing/board?routeId=<gateway-id>&limit=100
```

Items expose the stage, source message group, worker task, handoff, decision, send receipt, failure, overdue duration, and an idle-worker-without-outcome flag. This is a read-only view of Manager state, not a reconstruction from logs.

### Controlled outbound idempotency receipts

`deliveryId`, `sender.agentType`, and `sender.sessionId` are required. Before entering Outbox, Manager persists a reservation under runtime `data/agent-send-idempotency/`, and the completed result preserves the sender identity. The same ID with the same request executes once, and later POSTs return the original `sent/draft/blocked/failed` result. Reusing the ID with a different sender or any other changed request returns `409 conflict`; `reserved/sending/uncertain` states also fail closed and are never auto-replayed.

After a POST timeout or an empty receipt, query the original ID first. An absent receipt returns HTTP `404` with `idempotency.state=missing`; keep reading `in_progress`, and never automatically resend `uncertain` or `conflict`. One controlled retry is allowed only when the original `deliveryId` and payload are unchanged and Manager authoritatively finds neither a request record nor a terminal record in the same Route's Outbox. A request record without a terminal result, a different payload digest, or a recovery retry without a terminal result becomes `uncertain`:

```http
GET /api/agent/send/receipts/:deliveryId
```

When only the endpoint receipt ID is available, query up to 100 matching records by channel:

```http
GET /api/agent/send/traces?channel=napcat&sentMessageId=:platformMessageId&routeId=:optionalRouteId
```

Each match includes the `deliveryId`, completion time, Route, target, and `sender.agentType + sender.sessionId`. Older receipts have no sender field, so this attribution applies only to sends created after this contract is enabled. The sender fields are caller-declared and durably recorded for audit; they are not cryptographic authentication of an Agent session.

The caller may mark delivery only when the receipt returns `status=sent` with the real identifier required by the target channel (`sentMessageId` for QQ text), followed by any required platform readback. `deliveryId` provides Outbox request idempotency; it does not replace NapCat/external-platform existence verification and is not an automatic retry queue. Public examples use placeholders, and runtime receipt files stay out of Git.

### Character reply for the speech message endpoint

When source context contains `routeKind=voice_transcript`, `adapterType=speech`, and `characterTtsDialogue=true`, the turn came from the RabiPC speech endpoint. Use the injected send template with `channel=speech`, the exact `routeId`, `params.sessionId`, and a text payload. A successful result means the request reached RabiSpeech synthesis or its host-wide FIFO; it does not claim speaker playback and cannot complete a QQ requirement.

Only `speech` / RabiSpeech transcript ingress injects this state. Do not mark QQ, role-panel, or ordinary text requests as speech dialogue, and do not bypass Outbox to call a worker directly, because that loses source binding, policy enforcement, and session isolation.

Outbox returns one of:

```text
sent    delivered, queued to a supported local endpoint, or intentionally retained in the Agent session
draft   a non-sendable draft result
blocked rejected by policy, missing target, or missing configuration
failed  a real delivery attempt failed
```

There is no generic persistent approval center or automatic retry queue. Callers must inspect the returned status; a supplied `deliveryId` adds fail-closed request deduplication and receipt lookup only.

Phone audio may reuse the same RabiSpeech ASR chain, but its outbound channel is `rabilink`. The send request explicitly carries `params.sourceMessageId` and stable `targetDeviceIds`; the transient PCM `sourceStreamId` is never a downlink target. This cannot be redirected into the standalone `speech` channel.

### Voiceprint evidence and persona identity interpretation

Speech delivered to a persona contains only opaque voiceprint/cluster IDs, diarization labels such as `Speaker 1`, scores, and decision evidence. It carries no person names and marks no voiceprint as “the user.” The receiving persona interprets identity through its own relationships, memory, and conversation context; different personas may hold different relationship interpretations for the same voiceprint.

Every new voice message also carries `sourceHostId/sourceHostName`. A voiceprint ID is interpreted only within the processing host that produced it, so the persona identity key is **processing host + voiceprint ID**; equal cluster strings from two PCs must not be treated as one person. The persona's append-only source of truth is `data/roles/<RoleId>/voice/voice-identities.jsonl`. It travels with persona synchronization, while RabiSpeech, Manager, and Routes never fill `displayName`, `relationship`, or `isUser` on the persona's behalf.

Read or update the current persona's interpretation:

```http
GET /api/roles/:roleId/voice-identities
GET /api/roles/:roleId/voice-identities?sourceHostId=<host>&voiceprintId=<voiceprint>
PUT /api/roles/:roleId/voice-identities
Content-Type: application/json
```

```json
{
  "sourceHostId": "example-host-guid",
  "sourceHostName": "Studio PC",
  "voiceprintId": "unknown-cluster-7",
  "displayName": "Boss",
  "relationship": "my user",
  "isUser": true,
  "aliases": ["Boss"],
  "notes": "Confirmed by this persona from continuing conversation"
}
```

`isUser` has no system default. Omit it while unknown instead of writing `false`. Repeating an identical interpretation adds no event; corrections append a new event, and `deleted=true` appends a tombstone rather than rewriting shared history. Every new event automatically records the previous event heads it converges; callers neither need nor control that lineage.

When two PCs modify the same `sourceHostId + voiceprintId` concurrently from one common version, JSONL union keeps both event heads instead of silently selecting the last file row. `GET` returns `conflicted=true`, `conflictFields`, and `conflictCandidates` containing `eventId/deleted`. A disagreement in `isUser` or deletion state classifies matching transcript segments as `conflict`. If only names, relationship text, or notes diverge while every branch agrees on `isUser`, user/other classification remains usable but the relationship metadata stays marked unresolved. A later persona `PUT` automatically supersedes every current head with the persona's explicit final interpretation, allowing the next multi-PC sync to converge. AgentPacket includes the relationship file, processing host, all voiceprints, known mappings, and unresolved fields. Those rows remain persona records, never host inference.

To distinguish the current persona's confirmed user, other speakers, unknown voices, or conflicting mappings across a day or time range, use the persona-scoped read view instead of modifying raw messages:

```http
GET /api/roles/:roleId/voice-transcripts?from=<ISO>&to=<ISO>&speaker=user&limit=200&includeArchives=true
```

`speaker` accepts `user`, `other`, `unknown`, or `conflict`. At read time, the result joins `conversation/current.jsonl` (and optionally archives) with the current persona's `voice/voice-identities.jsonl`, returning record-level `personaClassification`, per-segment `classification`, and matching identity evidence. `mixed` means one recording contains several segment conclusions. The view never writes names or `isUser` into host raw messages or the persona conversation ledger; correcting a persona relationship changes the next query immediately.

`matchedCount` and `summary` are computed from the complete filtered result and are not truncated by the detail `limit`. `summary` reports total recordings and segments, recording duration, speaker duration, `user/other/unknown/conflict` statistics, classified duration, and `coverageRate`. `unresolvedVoiceprints` groups still-unknown or conflicting evidence by `sourceHostId + voiceprintId`, including segment count, duration, and last-seen time. These fields are a query-time coverage view, not another ledger, and are never written back into persona files.

When the current routed message explicitly asks about voiceprints, speakers, which recordings came from the user versus other people, or all-day classification, AgentPacket injects the time-range query, four speaker filters, relationship GET/PUT, and append-only event rules into the current persona task. Ordinary messages receive no such prompt. The Agent performs only the query required by the current request and never polls coverage. Unknown or conflicting evidence may converge only from this persona's own conversation, memory, and user confirmation, never directly from a host candidate name or high score.

The following local endpoint remains as a RabiSpeech operator-diagnostic compatibility surface. Once a human has confirmed one recording label, it may create or reuse diagnostic metadata and bind the current `recordId + speakerLabel`. These names never enter RabiRoute's host-wide ingress record or persona ledger and are not an Agent source of truth for user identity:

```http
PUT /api/speech/speaker-identities
Content-Type: application/json
```

```json
{
  "sessionId": "meeting-one",
  "recordId": "speech-0123456789abcdef",
  "speakerLabel": "Speaker 1",
  "displayName": "Qiu Yu",
  "aliases": ["秋雨"]
}
```

Supply `speakerId` when a stable profile ID is already known. Otherwise the endpoint performs a case-insensitive display-name and alias lookup, reuses the unique match and merges aliases, creates a profile when there is no match, and returns `409` when several profiles match so the caller can retry with an explicit ID. Lookup or creation, alias merging, and the `recordId + speakerLabel` binding are persisted as one host-local registry transaction; repeated requests are idempotent.

The human entry remains under **Speech Service → ASR → Speaker / voiceprint settings** and shares `output/speaker-profiles.json` with the Agent API. The page separates unknown and known speakers into collapsible cards and previews the latest ten utterances for each diarization cluster to support human confirmation and correction.

This endpoint writes RabiSpeech-local diagnostic metadata and an explicit recording binding. Manager removes names at the host-wide ingress boundary and forwards only opaque voiceprint/cluster evidence. The bound persona owns the final interpretation of who someone is and whether they are the user. Calibrated capability discovery may justify describing a score as voiceprint-match evidence, but a host match still must not be equated with a persona relationship.

### Agent-triggered multi-PC persona synchronization

PCs using the same RabiLink application token can be discovered and explicitly synchronized by a local Agent:

```http
GET /api/persona-sync/peers
POST /api/persona-sync/sync
Content-Type: application/json
```

```json
{
  "peerId": "office-pc",
  "roleId": "Rabi"
}
```

Omit `roleId` to synchronize every persona. The coordinator prefers direct LAN transfer and falls back to restricted Relay transit. The Agent must inspect per-file results, `fileConflicts`, and `semanticConflicts`. The latter is returned by the same sync request when JSONL union succeeds but compatibility voice-account classifications or general identity relations still have concurrent branches. Voice items include host, voiceprint, fields, and candidate events; identity-relation items include record kind, record ID, and candidate events. No follow-up coverage polling is required. `conflicts > 0` or HTTP `409` means unresolved conflict remains and completion must not be claimed.

A local Agent resolves ordinary-file conflicts through `GET /api/persona-sync/conflicts`, `GET /api/persona-sync/conflicts/content`, and `POST /api/persona-sync/conflicts/resolve`. Actions are `keep_local`, `use_remote`, and `use_merged`; resolution should include the listed `expectedLocalHash` to avoid overwriting a newer local edit. These three control endpoints are loopback-only and are not exposed through the LAN listener or Relay. See [Multi-PC persona data synchronization](persona-data-sync_en.md) for complete manifest, file, merge, and resolution contracts.

When the current routed message explicitly mentions multiple PCs, persona/role synchronization, or persona sync, AgentPacket injects these loopback URLs, the current `roleId`, the one-shot execution rule, and terminal-conflict criteria into the bound persona's current task. Ordinary conversation receives no such capability prompt. The default scope is the current persona; omit `roleId` only when the user explicitly requests every persona. If peer discovery is not unique, the Agent must confirm the target instead of guessing or polling for coverage.

### NapCat send with an explicit reply reference

Set `channel=napcat`, name the group, and always provide `params.replyToMessageId`. Use the source QQ message ID when the outgoing message can quote it, or `""` when the message is intentionally unquoted. RabiRoute avoids adding a duplicate reply segment. Omitting the field is rejected with guidance for the calling Agent.

```json
{
  "deliveryId": "send-qq-progress-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<current Codex Primary Persona session ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": {
    "target": "group",
    "groupId": "example-group-id",
    "instanceId": "default",
    "replyToMessageId": "example-message-id",
    "replyImageDescriptions": [
      "The first image shows compact spacing for a short dynamic label.",
      "The second image shows the background expanding with longer text, indicating that the width must adapt to content."
    ]
  },
  "payload": { "type": "text", "text": "I have taken the issue and will update this thread." }
}
```

`replyImageDescriptions` must match the quoted message's image count and order. Each item states what the Agent actually saw and what the image communicates; `reviewed` or another generic acknowledgement is not sufficient. After a successful send, RabiRoute creates or appends a same-name `.md` beside every local image. It records the source message, image position, Agent type and complete session, delivery ID, QQ receipt ID, and description. The send receipt exposes only archive mappings rather than copying description text into operational trace results. An intentionally unquoted group send uses `replyToMessageId: ""` and `replyImageDescriptions: []`.

Local QQ group-file upload uses the same endpoint with `payload.type: "file"`, an allowed `payload.path`, and a route policy whose NapCat `supportedOutputs` includes `file`. The real path must stay under `messageAdapterPolicies.napcat.allowedFileRoots`.

### WeCom

Use `channel=wecom` and provide the exact `params.chatId`. A source response may also include `params.reqId`; a proactive send omits it. Source context does not select the channel. The WeCom adapter remains experimental.

### RabiLink proactive output

Use `channel=rabilink`, `params.proactive=true`, and at least one explicit `targetDeviceIds` or `targetDeviceKinds` selector to enqueue a proactive device message when the selected Route enables RabiLink output and has a Relay configured. A non-proactive send also requires `params.sourceMessageId`. The local handler still goes through Outbox; it must not bypass RabiRoute and call the Relay directly.

## Codex thread bridge

Background Codex turns may not receive Codex Desktop thread-management tools. RabiRoute therefore exposes a local bridge:

```http
GET  /api/agent/threads?action=list&query=<text>&limit=20
POST /api/agent/threads
```

POST actions:

- `list`: list matching threads, optionally restricted by a configured cwd.
- `read`: read a thread by `threadId`. The returned task name always comes from the Codex left-sidebar index; SQLite `threads.title`, an initialization prompt, or a stale Route-cached name cannot override it.
- `resolve`: for Codex, reuse a valid saved ID when the task is unarchived, even if its saved default cwd differs; the request workspace supplies the next execution context. Mutable Desktop/SQLite title metadata and an overlong display title cannot invalidate that binding. An archived saved binding returns `409 archived` and never creates a replacement. Only when the ID is empty, invalid, or genuinely missing, resolve by visible name plus cwd. One or more exact matches bind the unique latest `updatedAt`; create one empty task only when no match exists. A tied maximum returns candidates for selection.
- `create`: idempotently resolve by task name plus configured workspace, bootstrap one empty task only when no match exists, then deliver any initial prompt to that task's Desktop owner through Desktop IPC. Concurrent calls and retries after an HTTP timeout share or reuse the same creation result instead of creating duplicate tasks. The response uses `resolution=created` for a new task and `resolution=name` for an existing same-name task. Codex task names are limited to 240 JavaScript code units; RabiRoute safely truncates longer inputs with an ellipsis and returns the actual created name for persistence.
- Manager persists the create reservation under runtime `data/.runtime/codex-thread-creations/`. It advances through `reserved → creating → thread_created → naming → initial_turn → completed`. A `creating` reservation may move through `failed_before_create` and retry with the same key only after it is older than five minutes, has no `threadId`, and a second `action=list + lookupMode=state_db` check authoritatively finds no task with the same name and workspace. An existing `threadId`, a failed index query, a candidate task, or any other insufficient evidence changes the reservation to `uncertain`; later requests return `409` and automatic recreation is forbidden.
- `rename`: rename a Desktop task by full `threadId`; the configured cwd supplies only the Desktop IPC context and does not change task identity. Persistent plan-assistant slots use this when expanding from one unnumbered assistant to multiple numbered assistants.
- `send`: ask the existing Desktop task owner to start or steer the real turn through Desktop IPC.

`send` optionally accepts up to eight absolute `imagePaths`. Every file must exist inside the target `cwd` workspace and use a PNG, JPEG, GIF, WebP, or BMP extension. After validation, Manager sends each file as Desktop `localImage` input. This is intended for message adapters to pass already-materialized source images and cannot read files outside the target workspace.

```json
{
  "action": "resolve",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "title": "Rabi",
  "cwd": "C:/Path/To/Your/Project",
  "createIfMissing": true
}
```

Callers must not edit UUIDs manually. Selecting a different task supplies its ID; typing a new name must explicitly clear the previous ID before `resolve` performs name lookup or creation. For Codex, a valid ID remains authoritative across saved-cwd or display-metadata changes, and the request workspace controls the current delivery.

After a create call times out, first call `list` with the original title and `lookupMode=state_db`. This reads the local Desktop task database and sidebar index without starting the metadata app-server, so it can find an empty task whose first prompt has not started yet. Do not infer “no side effect” from an immediate complete-mode lookup and do not create the same title again.

Formal Agent responses still validate the current-turn workspace using the shared path-canonicalization rule. Equivalent Windows drive, `\\?\` extended-drive, UNC, and extended UNC forms are not rejected merely because their string forms differ. This validation does not participate in Codex task identity.

```json
{
  "action": "create",
  "title": "[Example][Research] Compare two integrations",
  "cwd": "C:/Path/To/Your/Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000010",
    "sessionName": "current investigation session"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000010",
  "sourceAgentType": "agent",
  "responsePolicy": "none",
  "prompt": "Inspect the implementation and produce an evidence-backed comparison without modifying files.",
  "sandbox": "workspace-write"
}
```

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "cwd": "C:/Path/To/Your/Project",
  "sandbox": "workspace-write",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000002",
    "sessionName": "Plan Secretary session"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000002",
  "sourceAgentType": "plan_secretary",
  "responsePolicy": "required",
  "responseInstruction": "Return the result, verification evidence, and next action after completing the next step.",
  "prompt": "Continue with the new constraints and evidence."
}
```

Every `create` and `send` with a non-empty `prompt` must include `messageSource`. Its `type` is required and uses one of four source shapes:

| `messageSource.type` | Required identity | Optional details |
| --- | --- | --- |
| `message_adapter` | `messageAdapter`, `conversationType`, `conversationId`, `messageId`, and either `senderName` or `senderId` | `conversationName`, `messageGroupId`, Route name/ID |
| `agent` | `agentAdapter`, `sessionName`, complete `sessionId` | `agentType`, `workspace` |
| `plan` | `planName`, `planId` | `sourceAgent` only when a real Agent initiated the delivery and Manager can verify it |
| `system` | `eventType`, `eventName`, `eventId` | `actorType`, `actorName`, `actorId`, Route name/ID |

Every rendered RabiRoute delivery starts with these two wire sections. Collaboration rules, response contracts, event details, and recent messages follow them:

```text
[消息源]
消息源类型：<消息端 | Agent | 计划 | 系统>
<type-specific name, complete ID, session, plan, or Route fields>

[消息内容]
<prompt>
```

Agent callers normally use `type=agent`. `agentAdapter` names the actual endpoint, such as `codex`, `dsh`, `copilotCli`, `marvis`, or `astrbot`; both `sessionName` and the complete `sessionId` are required. Agent-to-Agent delivery also requires the sender's complete `sourceThreadId`, `sourceAgentType`, and `responsePolicy`, and `messageSource.sessionId` must equal `sourceThreadId`. `sourceAgentType` accepts `primary_persona`, `message_processing`, `plan_secretary`, `plan_agent`, or the generic `agent`. `responsePolicy` must be `required` or `none`. A required response also needs `responseInstruction`; Manager creates a `requestId` and includes the formal reply parameters in the target task's delivery. `none` means the target does not have to return a result for this delivery.

Non-empty `create` and `send` requests use the same source-verification rule. With `type=agent`, both require `sourceThreadId`; Manager reads the actual source name from the Codex Desktop or DSH owner and replaces a stale submitted name. Manager-owned plan progress, approval, and QA events show only the plan name and ID. `sourceAgent` is included only when the plan task itself returns a result and the source session is verified.

`contextBlocks` follow the message content, and `controlBlocks` follow context. Initialization, response contracts, and collaboration rules belong in control blocks. Neither field may contain `[消息源]`, `[消息内容]`, or `[投递源]`. Legacy source wrappers, nested envelopes, and old Agent response wrappers are migrated automatically. A replay whose old record lacks structured provenance is labeled `历史投递记录`; RabiRoute does not guess the source identity.

A formal response uses the same `send` action. The responder must send `inReplyToRequestId`, `result`, and `nextAction` back to the original requester and choose `responsePolicy` again. Use `required` plus a new `responseInstruction` when the requester must act and report back; use `none` when the exchange ends with this response. The reply's `messageSource.agentAdapter`, `messageSource.sessionId`, `sourceThreadId`, and workspace must identify the receiving session that is currently responding. `inReplyToRequestId` alone points to the original request; the requester or reply destination must not be presented as the reply source.

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000002",
  "cwd": "C:/Path/To/Your/Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000001",
    "sessionName": "Plan Agent session"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000001",
  "sourceAgentType": "plan_agent",
  "inReplyToRequestId": "requestId from the incoming delivery",
  "result": "The investigation and evidence checks are complete.",
  "nextAction": "The secretary updates the plan and decides whether implementation continues.",
  "responsePolicy": "none",
  "prompt": "Investigation result and evidence summary."
}
```

Ordinary Agent final text is not a formal response. At the end of each target turn, the `Stop` Hook checks unanswered requests. If the response is still missing, Manager reminds the same exact target task five minutes after that turn ends. If the reminder-triggered turn also ends without a response, the next reminder is scheduled five minutes after that later turn. Request state is available through `GET /api/agent/requests` and `GET /api/agent/requests/:requestId`; maintainers can cancel an obsolete request with `POST /api/agent/requests/:requestId/cancel`.

Desktop can occasionally report a start/steer timeout after the message has already been written to the target task. Manager reads the target rollout using the unique `deliveryId` in the prompt: when that marker is present, it commits the delivery and request/response state as successful; only an absent marker remains a retryable failure. Callers must read the request state and the target task's latest turn before retrying a timeout.

For Agent-to-Agent `create` and `send`, Manager verifies the source through the actual owner selected by `messageSource.agentAdapter + sourceThreadId`. Codex reads Desktop task state and the current sidebar name; DSH reads session name, workspace, and running state through apiproxy `session.list`. A missing source, workspace conflict, or mismatch between `sourceThreadId` and `messageSource.sessionId` fails closed. Every non-empty RabiRoute delivery starts with `[消息源]`, followed by `[消息内容]`; reminders, initialization messages, RabiLink reviews, and replays use the same envelope.

`create` and `send` accept only a Codex or DSH workspace already configured in RabiRoute. Every non-empty `prompt` requires a complete `messageSource`; `type=agent` also requires `agentAdapter`, `sessionName`, and the complete `sessionId`. Agent-to-Agent sends require a verifiable `sourceThreadId` equal to `messageSource.sessionId`. The `sandbox` field cannot override the target owner model, tools, sandbox, or approvals. Codex fails closed when Desktop, IPC, or the task owner is unavailable. DSH fails closed when its endpoint is unavailable, the session is missing, or the workspace conflicts. Neither adapter falls back to another Agent or Runtime.

Agent-to-Agent prompt text must be a newly composed handoff for the target task. Manager rejects bodies containing `[rabi:bind]`, Message Agent initialization, or Plan Secretary initialization, and rejects a handoff whose source and target IDs are identical. A complete injected prompt must never be copied across tasks. The Message Agent pool also refuses to initialize or deliver when task resolution returns the Primary Persona task ID.

The fixed developer instructions for `create` and every `send` follow-up add a workspace-delivery guard, including ordinary follow-ups that still must provide `messageSource`. Unless the current user explicitly authorizes it, the Agent must not create an additional working copy, sparse checkout, copied project, or side workspace; stricter rules in the workspace `AGENTS.md` take precedence. PangHu has no task-level exception: only the official Main, Release, and Art working copies may be used, and old isolated, sparse, or clean-working-copy instructions are revoked. The Agent may say “fixed” or “ready for acceptance” only after the change is present in the workspace the user actually runs or reviews and the applicable resource binding, build or compilation, and runtime checks are complete.

When the current Route enables **Require the RabiAgent message delivery API**, Codex Hooks deny persistent-task tools that bypass RabiRoute. The DSH `RabiRoute Agent` plugin denies Shell calls that directly access `/api/agent/threads`, `/api/agent/send`, or `session.prompt`. Both adapters must use the thread bridge with `sourceThreadId`, `sourceAgentType`, and `responsePolicy`. Ephemeral local subagent collaboration is not covered. Turning the switch off disables only the bypass check; existing required-response requests remain active. The bridge delivers to the same target owner and never starts a fallback Runtime.

## Plan API

`plan.status` stores only an enabled key from the owning persona's `personaConfig.json.planWorkflow.statuses`. The following entries are defaults, not a code enum:

```text
`分析中`  analyzing
`待补充信息` awaiting information
`待审批`  awaiting approval
`执行中`  executing
`等待打包` awaiting package
`等待 QA` awaiting QA
`待讨论` awaiting discussion
`暂停`    paused
`完成`    completed
`关闭`    closed
```

The stock information-needed status means that analysis is complete but the available information still cannot support a concrete approvable proposal, and the missing fact affects the cause, fix, implementation scope, or acceptance contract. It is not used for a current reproduction gap, a suspected historical fix, a missing target package, pending QA, or a pending closure decision; those cases remain in analysis or move, with evidence, to the package, QA, or closed role.

```http
GET   /api/roles/:roleId/plans
GET   /api/roles/:roleId/plans/:planId
POST  /api/roles/:roleId/plans
PATCH /api/roles/:roleId/plans/:planId
```

```http
GET    /api/roles/:roleId/plan-statuses
POST   /api/roles/:roleId/plan-statuses
PATCH  /api/roles/:roleId/plan-statuses/:statusKey
DELETE /api/roles/:roleId/plan-statuses/:statusKey
```

Status mutations require both `If-Match` and `Idempotency-Key`. Keys are immutable. DELETE requires `replacementKey`; Manager migrates unarchived plans first and retains the old definition as `retired` so archived plans and history remain readable.

```json
{
  "title": "Refresh routing documentation",
  "focus": "routing documentation accuracy",
  "status": "分析中",
  "archiveStatus": "未归档",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "verify-schema",
  "currentStep": "verify the active configuration schema",
  "nextAction": "update the bilingual guide",
  "blockedBy": "",
  "attachments": [
    { "name": "plan-preview.png", "mimeType": "image/png", "contentBase64": "<base64>" },
    { "name": "acceptance-checklist.pdf", "path": "C:/Path/To/acceptance-checklist.pdf" }
  ],
  "steps": [
    { "id": "inspect-current", "title": "Inspect the existing plan API", "startedAt": "2026-07-27T08:00:00.000Z", "completedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "verify-schema", "title": "Verify the structured step contract", "startedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "update-guides", "title": "Update both language guides" }
  ],
  "keywords": ["routing", "configuration", "documentation"],
  "source": {
    "kind": "agent",
    "summary": "Created from the current documentation review"
  },
  "taskBinding": {
    "agentType": "codex",
    "sessionId": "exact-source-session-id",
    "sessionTitle": "Plan execution task",
    "workspace": "C:/Path/To/Project",
    "completionHook": {
      "enabled": true,
      "gatewayId": "Role__reminder"
    }
  }
}
```

New plans must provide ordered `steps`. `plan.status` accepts only an enabled key from the persona's current status catalog. `archiveStatus` is independent and accepts only `未归档` or `已归档`. Steps store no separate status; `currentStepId` identifies the current step and `completedAt` records completion. Manager returns the key with configured label, description, palette, order, and views; WebGUI and the tray consume those fields.

Ongoing analysis, completed analysis that still cannot form a concrete approvable proposal, a complete pending approval, and approved execution use the keys referenced by `planWorkflow.roles.analysis`, `roles.informationNeeded`, `roles.approval`, and `roles.execution`. Package, QA, discussion, and pause use their configured role keys and are never derived from step text or waiting details.

Only plans that change project content, such as code, prefabs, assets, or configuration, should follow `implementation/development validation/applicable sync and commit → Awaiting package → Awaiting QA → complete on QA pass; return to implementation on failure`. QA sending and its `sentMessageId` are actions and evidence inside the purple QA stage: missing receipt means `send_qa_request`, while a receipt with only the verdict outstanding means `wait_for_qa_result`. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance follow their real steps. Agents and batch jobs must not manufacture package or QA steps for those plans, and Manager does not infer the lifecycle from a title, description, or `kind`.

`attachments` is optional. A new item may provide a Manager-readable local `path`, or `name`, optional `mimeType`, and `contentBase64`. A plan may contain up to 8 attachments, limited to 10 MiB each and 25 MiB in total. Manager copies content into the persona-private `plans/attachments/<planId>/` directory; the plan file retains safe metadata only and never Base64. Omitting `attachments` from PATCH preserves the list, while an empty array clears it. To keep selected existing items in a PATCH, send back the corresponding attachment objects returned by GET. The public plan DTO does not expose the local `path`.

Read one attachment through:

```http
GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId
```

Image and video attachments use an `inline` response. WebGUI renders PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime in compact, fixed-width 16:9 thumbnails that shrink only for a narrower container, then opens images in a large-image preview or videos in an in-page player with controls. Video reads support HTTP byte ranges, while actual codec support depends on the browser. Ordinary files use a download response. The endpoint serves only metadata-registered files whose real paths still remain inside that plan's managed directory.

Before requesting approval, the Agent must PATCH the current step with a complete `approvalRequest`. Manager completeness checks do not reject the plan write, but missing fields return `presentation.approval.state=incomplete`, `enabled=false`, and `missing[]`. The plan card lists those missing fields and disables approval input, attachments, and submission. Formal approval becomes available only after the Agent completes the approver, decision, recommendation and alternatives, reason, real paths, complete commands, external targets, validation, rollback, exclusions, request provenance, and receipt state on the same plan.

`taskBinding` may be written through POST or PATCH to bind one exact Codex execution session. The current contract accepts only `agentType=codex` and a non-empty complete `sessionId`; `completionHook.enabled` must be boolean. When enabled, the Codex `Stop` Hook sends the official `last_assistant_message` to Manager, which then reminds the target handler session through the same persona's role-panel, Forwarding, and AgentPacket path. `gatewayId` is required when the persona has multiple Routes. Delivery is deduplicated by `sessionId + turnId` and never automatically patches the plan, advances steps, or writes memory.

The reminder comes from the plan's independent business task. In the same turn, the main persona assigns a plan secretary to consume the result, update plan and memory, and continue the exact business `taskBinding.sessionId + workspace` when actionable. A secretary ID is never stored in `taskBinding`, and secretary rotation or plan pause never clears the business binding. The main persona inspects all non-terminal plans, secretary slots, and business tasks and ends only when both `actionable plans without management = 0` and `actionable but idle business tasks = 0`. These decisions and writes belong to the Agent; neither the Stop Hook nor Manager performs them automatically.

A reminder failure does not block the source Codex final answer, but Manager records the failure and the Hook may return a non-blocking system warning. Workspace, persona, gateway, and source-equals-target task conflicts fail closed. This interface remains experimental until verified between two real Desktop tasks.

### Plan guidance and approval feedback API

```http
GET  /api/roles/:roleId/plans/:planId/feedback
POST /api/roles/:roleId/plans/:planId/feedback
```

RibiWebGUI uses this endpoint for whole-plan guidance when `presentation.acceptsGuidance=true` outside approval, while WebGUI and the tray continue to use it for formal feedback on the current approval step. Both notify the Agent through the independent `plan_feedback` system event. Plan guidance carries only `planId` and must omit `stepId`:

```json
{
  "feedbackId": "webgui-guidance-12345",
  "gatewayId": "route-id",
  "text": "Narrow the overall scope first, then adjust later steps from the result.",
  "kind": "guidance",
  "author": "user",
  "source": "webgui",
  "notifyAgent": true
}
```

Approval feedback remains associated with its approval step:

```json
{
  "feedbackId": "qq-message-12345",
  "gatewayId": "route-id",
  "stepId": "review-plan",
  "text": "Approve the direction, but add the regression scope first.",
  "attachments": [
    { "name": "review.png", "mimeType": "image/png", "contentBase64": "<base64>" }
  ],
  "planAttachmentIds": ["attachment-design-preview"],
  "kind": "approval_suggestion",
  "author": "user",
  "source": "qq",
  "notifyAgent": false
}
```

`attachments` is optional. Each item uses `name`, optional `mimeType`, and `contentBase64`; a request may contain up to 8 attachments, limited to 10 MiB each and 25 MiB in total. Manager validates and materializes the content under the persona-private `plans/feedback/attachments/<feedbackId>/` directory. The audit record and Agent notification retain only safe metadata and the local path. A retry with the same `feedbackId` must keep the same text, step, and attachment content.

`planAttachmentIds` is also optional and references managed files already present in the current plan's top-level `attachments`. It accepts up to 8 unique IDs. Typing `@` in RibiWebGUI's approval field opens a list of the current plan attachments; choosing one inserts a readable `@attachment` token and submits its stable ID. Manager verifies that every ID belongs to the current plan, stores the referenced metadata and local path as an audit snapshot for this feedback, and delivers the files through the same `plan_feedback` event. WebGUI never reads or submits an arbitrary local path. A retry with the same `feedbackId` must keep the same plan-attachment references.

When feedback targets the current structured `qa-* / verify-*` step, Manager treats only a user or external-source `approval_suggestion` as a QA-verdict candidate. `guidance`, `guidance_response`, `approval_response`, `author=agent` execution reports, and bare `passed / verified` test counters remain ordinary feedback records and cannot complete or reopen QA. An explicit failure or reproduction reuses or inserts `investigate-<qaStepId>` on the same plan, resets the QA step to not started, writes the issue-type-specific minimum missing evidence to `waitingFor`, and continues the original `taskBinding.sessionId + workspace` after the evidence is complete. Only an explicit verdict such as `QA passed`, `acceptance passed`, or `confirmed no longer reproducible` completes the current QA step.

With `notifyAgent=true`, POST returns HTTP `202` immediately after durable recording, normally with `deliveryStatus=pending`. Guidance and approval feedback reuse the same exact `taskBinding` delivery path. A complete binding uses `/api/agent/threads` and Desktop IPC to the original business task; only an incomplete binding sends the full feedback to the persona Agent. An unloaded owner remains `pending` under bounded retries, and only an accepted `start/steer` becomes `delivered`. The event does not enter the role-panel timeline or unified conversation ledger, and terminal state is announced as `plan_feedback_changed`.

Agent handling notes for plan guidance use `kind=guidance_response`, `author=agent`, `source=agent`, and `notifyAgent=false`, associated only with `planId`. The Agent first reads the whole plan, updates its direction and any affected later steps, then writes the handling note without `stepId`. Approval handling continues to use `approval_response` under `planId / stepId`. Both are stored as `record_only`; feedback itself does not advance the plan.

The shared plan API hints in every AgentPacket include both guidance and approval feedback contracts plus the rule to patch the plan separately after recording. Persona Skills do not need to duplicate the common interface.

An unarchived plan is eligible for delayed archival only when its configured status has both `terminal=true` and `archiveEligible=true`. After its latest `updatedAt` exceeds `personaConfig.json.planWorkflow.archiveAfterHours`, a role-knowledge snapshot changes only `archiveStatus` to `已归档`, preserves the status key, and moves the plan directory into the archive bucket. The default template uses 72 hours, while each persona may configure a different delay. Archived plans do not participate in keyword recall.

## Recent-memory API

```http
GET   /api/roles/:roleId/memory/recent
GET   /api/roles/:roleId/memory/recent/:memoryId
GET   /api/roles/:roleId/memory?counts=1
POST  /api/roles/:roleId/memory/recent
PATCH /api/roles/:roleId/memory/recent/:memoryId
```

`counts=1` returns only recent-memory, consolidated-memory, archived-source-memory, and consolidation-run counts. It does not read or return memory card bodies; WebGUI uses it to populate tab counts when Plans & Memory is opened directly.

```json
{
  "title": "Documentation must follow implementation",
  "focus": "documentation fact-source rule",
  "content": "Verify code, schemas, APIs, WebGUI, and tests before translating or publishing a guide.",
  "keywords": ["documentation", "fact source", "tests"],
  "source": {
    "kind": "agent",
    "summary": "Confirmed during the documentation audit"
  }
}
```

`focus` must be a single line and `keywords` must contain at least one item. Reading by ID refreshes `viewedAt`; updating refreshes both `updatedAt` and `viewedAt`. A true title/keyword recall hit refreshes both `viewedAt` and `recalledAt`. Recent-memory editing uses the later of `updatedAt` and `viewedAt` inside the current fixed 24-hour window. Consolidation instead uses the later of `updatedAt` and `recalledAt`, so a direct read does not postpone the 24/72-hour clock. These windows are not yet public persona configuration fields.

For recent-memory lists, Manager dynamically supplies `lifecycle.triggersNextConsolidation` for the memory that reaches 72 hours first and `lifecycle.willEnterNextConsolidation` for each memory that will be older than the 24-hour input threshold at that same trigger time. The projection is cached with the memory catalog and invalidated after a create, update, or recall hit. Clients must not derive the candidate set from their local clocks.

## Write limits and validation

Plan and memory writes are validated for one focused subject, title/body lengths, source-summary length, per-keyword length, keyword count, and total text. Defaults can be overridden through `personaConfig.json` under `knowledgeLimits.plan` and `knowledgeLimits.memory`.

Validate all existing role knowledge with:

```http
GET /api/roles/:roleId/knowledge-validation
```

Old hand-written files remain readable, but a later write must satisfy the active limits.

## Consolidated memory

```http
GET /api/roles/:roleId/memory/consolidated
GET /api/roles/:roleId/memory/consolidated/:memoryId
```

Consolidated memories have no normal PATCH endpoint. If a stable memory is wrong, write a corrective recent memory and let a later consolidation produce a new stable record. Reading a consolidated item by ID refreshes `viewedAt`.

## Automatic or explicit memory consolidation

Current entry points:

- Trigger the built-in `manual_trigger` item with `triggerId=memory-consolidation`.
- Call the Manager API:

```http
POST /api/roles/:roleId/memory/consolidation-requests
```

```json
{
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

The default request is due only when an unconsolidated recent memory has not been updated or recalled for 72 hours. Its input contains unconsolidated memories whose latest update or recall is more than 24 hours old. `force` skips the due check but does not include memories still inside the input window. Manager automatically arms the earliest deadline and reevaluates activity when it fires.

Submit the handler result to:

```http
POST /api/roles/:roleId/memory/consolidation-runs/:runId/result
```

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "Stable documentation rule",
      "focus": "documentation fact-source rule",
      "content": "Public guides are calibrated against implementation before their English versions are maintained.",
      "keywords": ["documentation", "fact source"]
    }
  ]
}
```

RabiRoute writes the consolidated items, completes the run, and marks input memories with `consolidatedAt` and `consolidationRunId`.

## Remote Agent device API

> Maturity: experimental. The protocol and Manager API are implemented and tested, while real LAN/VPN/TLS/device environments still need end-to-end acceptance.

```http
GET  /api/remote-agent/devices
POST /api/remote-agent/tasks
```

The Manager discovers a remote `plugin-adapters/remote-agent-rabiroute` bridge and connects after the user supplies its password. Protocol v3 uses per-connection role-separated HMAC-SHA256 challenges and does not send the plaintext password over the WebSocket. Plain `ws://` authenticates peers but does not encrypt the link; use a trusted VPN or properly terminated `wss://` across untrusted networks.

Remote tasks are restricted to `REMOTE_AGENT_ALLOWED_CWDS`, use workspace-write behavior, and do not expose a danger-full-access path. File transfers have default single-file and per-task limits. Results return to the local RabiRoute personality thread; the remote device must not reply to QQ directly.

## Role skills

Role skills live under:

```text
data/roles/<RoleId>/skills/*.md
```

```http
GET /api/roles/:roleId/skills
GET /api/roles/:roleId/skills/:skillId
```

The list returns metadata; the item endpoint returns the complete Markdown body. Skill bodies are not injected into every packet. If a skill appears in required reads, the handler must fetch it before acting.

## Local YeYu Gamer Manager facade

The experimental YeYu Gamer integration is not a general Agent executor. When enabled, a local Agent can read only `/api/agent/yeyu-gamer/{health,meta,snapshot,capabilities}` through RabiRoute Manager and dispatch a work item with `mode: "plan"` to `/api/agent/yeyu-gamer/work-items`. Callers must supply the `stateVersion` from a fresh snapshot and a stable idempotency key. A successful receipt proves only that Manager recorded the plan item.

The facade accepts loopback callers only and fixes its destination to `http://127.0.0.1:8877/api/v1`. Its credential comes from the dedicated `rabiroute.token` in the local YeYu Gamer runtime and must never enter RabiRoute configuration or a response. There is no claim, decision, capability-invocation, shell, path, click, or legacy-script surface. See [Local YeYu Gamer Manager integration](yeyu-gamer-manager-integration_en.md) for configuration, requests, and acceptance without starting a game.

## Error boundary

Handlers should not directly modify consolidated memory, copy raw chat logs into memory, fetch all historical context without need, bypass Outbox, or treat RabiRoute as an Agent OS or executor queue. They should maintain focused plans and recent memories, read required evidence by ID, return consolidation results through the run API, and submit ordinary replies through `/api/agent/send`.
