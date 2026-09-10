<!-- docs-language-switch -->
<div align="center">
English | <a href="./personas-and-rules.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Personas and message rules

A Route decides how messages enter and which handler receives them. A persona supplies identity, background, and decision guidance. They are stored separately and can be reused independently.

## Configure follow-ups when a task ends

Open Persona → Automation → Agent Hook → Plan task follow-up. This is off by default. Add rules, select statuses from this persona's catalog, enter the follow-up text, and save. The first matching enabled rule wins; empty status selections or prompts never trigger.

Only the uniquely bound Codex plan task receives the follow-up. It does not contact anyone else or change plan status. Configure a cooldown between follow-ups; each turn receives at most one, and unchanged steps, next actions, waiting details and rules do not trigger again. The cooldown does not schedule a wake-up. Terminal or archived plans are excluded. When Manager is unavailable, report diagnostics without inventing follow-ups from cached configuration.

Install or update the Hook from the Agent page when first using this feature. Subsequent rule changes only require saving the persona. Independently installed local execution guards must use advisory output instead of fixed Stop blocks so they cannot override the persona switch.

## Route and persona boundaries

| Content | Owner |
| --- | --- |
| Sources, ports, handler, workspace, pipeline | Route |
| Selected persona | Route `agentRoleId` |
| Persona avatar, text, rules, plans, memory, skills | Persona directory |
| Desktop-pet animation assets | Persona `desktop-pet/` directory |
| Whether this PC shows the pet, plus its size, position, and window behavior | Current PC desktop settings |
| Route served by a rule | Rule `configName` |

One persona can serve several Routes. Editing its text or rules affects every bound Route that matches the relevant `configName`.

## Configure a persona

Open **Persona Configuration** and select an existing role under **Persona binding**. The summary at the top always shows the current persona plus message-rule and scheduled-task counts. The tabs below divide the formerly continuous page into focused sections:

- **Profile**: persona binding, avatar, and the `persona.md` summary.
- **Expression & voice**: language-style validation, persona TTS settings, and speech wake-up keywords.
- **Virtual avatar**: desktop-pet animation assets for the current persona and whether this PC displays the pet.
- **Identity relations**: recognized identities, unrecognized accounts, and voiceprint classification.
- **Message context**: recent-message limits per endpoint and Route variables.
- **Automation**: message triggers, scheduled tasks, and available template variables.
- **Chat log**: final replies captured by Hooks from this persona's tasks and Agent-to-Agent messages sent through the managed thread interface, newest received first. Load earlier replies, see source task names and click to locate them in Codex, or refresh manually; new replies are inserted at the top while retaining loaded records, expanded details, and the reading position.

When no persona is selected, **Expression & voice**, **Virtual avatar**, **Identity relations**, and **Chat log** are unavailable. Profile settings, Route variables, and default message rules remain accessible.

History starts with Hook replies received after this feature becomes available; it does not import earlier conversations. Install Agent Hooks and bind the task to a persona or its Route/plan. Tasks without an unambiguous persona owner are not recorded under any persona. The complete body supplied by the Hook is retained and displayed as a Markdown preview, including headings, emphasis, lists, code blocks, and tables. Web links can be opened; local-path links remain text, and embedded HTML is not executed. Replayed callbacks appear once, while different later replies in the same turn are retained. The plan-task completion notification switch only controls notifications; it does not disable recording received final replies.

After selecting a persona, use the same configuration card to set or replace its avatar. PNG, JPEG, WebP, and GIF images up to 5 MB are supported. The avatar follows the persona into selectors, the Route overview, speech persona selection, and the local role panel; the first character of the persona ID is used as the fallback. Because the image belongs to the persona directory, it does not need to be uploaded again for each Route.

Use **Open persona configuration** to edit the full text. Do not mechanically translate runtime-semantic files; language and wording changes can change Agent behavior.

## Configure a virtual avatar

Open **Virtual avatar**, select or import a GIF, PNG, or ZIP animation pack for the current persona, then turn on **Enable on this PC**. The switch stays unavailable until a runnable pack is selected, and no empty window is shown. Each enabled persona gets its own pet: enabling several personas displays several pets, while disabling one removes only that persona's pet. Window names use persona names.

Animation assets live under the current persona's `desktop-pet/packs/` directory and can travel with persona-folder synchronization. Size, position, opacity, always-on-top, click-through, locking, fullscreen hiding, result bubbles, and frame rate remain display preferences for this PC and do not synchronize with the persona.

After selecting a pack, the page lists the total number of actions, animation entries, and static images, grouped by idle and sleep, task and connection feedback, mouse interactions, random idle actions, and other actions. Each entry shows its trigger, format, and looping behavior; PNG sequences also show frame count and frame rate. Counts refer to available action entries. Single-frame PNG entries count as static images; GIF frame counts are not guessed.

Click **Preview** beside an action, then **Play preview** to view, replay, or stop the asset on this page. PNG sequences follow the pack's frame rate and looping settings; GIF previews follow the file's own settings. Previewing never triggers the desktop pet or changes its binding, and closes when switching packs or personas. Actions without an automatic trigger are listed as manually played.

## Let personas contact each other

After the relevant Routes are enabled, an Agent can discover which personas can receive messages and explicitly send a one-way message to another persona. You do not need to copy the target into local rules or add another network adapter. RabiRoute verifies that the message comes from the persona bound to the current Route and reports success only after the target handler accepts it.

The target persona's ordinary reply does not return to the source automatically. To answer, it must explicitly send another cross-persona message. RabiRoute keeps correlation for that exchange and limits repeated back-and-forth hops. After a timeout, the Agent checks the result under the original delivery ID instead of blindly resending under a new one, preventing one lost response from creating duplicate target work.

User-facing copy uses **persona**. Existing `roleId`, `/api/roles/*`, and `data/roles/` names remain compatibility internals; no directory migration is required.

## Synchronize the current persona across PCs

After selecting a persona, use **Multi-PC persona sync** in the page header to open a dedicated persona-folder synchronization workspace. Choose another PC using the same RabiLink application token on the left. Changed Files then shows, without writing files, what would be pulled, pushed, deleted, automatically merged, or require confirmation. Synchronization starts only after you select **Pull and synchronize**. Automatic synchronization runs in the backend and does not require the page to remain open. A local persona-file change, peer availability change, or Relay reconnection triggers one manifest reconciliation. LAN is preferred, with restricted Relay transit only when direct access is unavailable. Unfinished scope is persisted locally, so disconnects and Manager restarts do not forget it; an offline target waits for a connection event instead of fixed-interval business queries.

The page shows automatic-reconciliation state, and **Sync current persona** runs it immediately. Results distinguish pull, push, already converged, LAN/Relay transport, and conflict counts. Two-sided ordinary-file edits or concurrent deletion versus editing never use last-writer-wins replacement. They enter **Human confirmation required**:

- **Keep local** retains the current file and tries to publish that decision back to the source PC.
- **Use remote / Accept remote deletion** explicitly accepts the remote content or deletion intent.
- **Manual merge** lets the local Agent submit reviewed content through the `use_merged` API.

Concurrent voice-account classification branches do not let the file-conflict dialog guess who is the user. Confirm them again under **Voice endpoint accounts** in **Identity relations** so a new classification event explicitly converges the branch. Relay performs discovery and transit only; it stores no server-side master persona. Synchronization also does not replace independent backups or Git/SVN.

## Recognize a person across endpoint accounts

After selecting a persona, **Identity positioning** is divided into two cards:

- **Recognized identities** is organized by person. One person's name and confirmed QQ, Weixin, voice, and other endpoint accounts appear on the same person card. Selecting the whole card opens one identity workspace where basic details, endpoint accounts, speaking habits, and relations can be viewed and edited without separate three-dot-menu dialogs.
- **Unrecognized identities** is organized by endpoint type. An account stays here when its people are unknown, its candidates do not yet point to recognized people, or its evidence conflicts. Matching display names do not merge accounts automatically.

The **Relations** section uses one relation model for people, organizations, and projects; it does not split records into long-term and short-term types. Temporary roles in the current message, such as who proposed an idea or who is replying to whom, remain in automatically created Situation records instead of becoming another manually maintained relation type. Basic details and speaking habits save together, while accounts and relations save inside their own sections so a partial failure is not presented as a successful all-at-once update.

When an endpoint supplies an account identifier that does not change with its display name and the message matches a rule for the current persona, an unfamiliar account appears automatically as a “getting to know” candidate. This means only that the persona can accumulate clues for the account. It does not mean RabiRoute already knows the person. The account moves to a person card only after confirmation.

A self-reported name, another person's claim, a temporary display name, or long-term consistency in vocabulary, sentence patterns, and response rhythm may help review a candidate, but none can confirm identity alone. If a claim exists only in forwarded, quoted, or attached content, or the endpoint cannot supply a stable account identifier, the system keeps the account unrecognized instead of attaching it automatically to an existing person.

Several people may use one account. Once the allowed user set is known, attach the account to every relevant person card and mark it **Shared**. This identifies who may use the account, not who wrote the current message. The system may combine explicit self-identification, reply chains, task continuity, and speaking-habit consistency for per-message attribution, while retaining confidence and uncertainty. Recent activity by one person must not turn the whole account into their permanent account. When correcting an identity, retain the real endpoint account and retire any fictional person record created from its nickname so the history remains traceable.

## Classify voice accounts under Identity positioning

After a persona is selected, **Identity positioning** presents text accounts such as QQ and WeCom together with **Voice endpoint accounts**. Each processing-host and voiceprint-ID pair is one voice account, and a recording with several speakers may reference several accounts. The voice section shows the latest 24-hour classification coverage, speech attributed to the user, speech attributed to other people, unknown/conflicting segments, and relationships already stored by this persona. **This is me** is only the current persona's explicit interpretation of a voiceprint on its processing host. Neither RabiSpeech nor the RabiRoute host decides who a person is or assigns any voiceprint to the user by default.

For an unresolved voiceprint, choose:

- **This is me**: mark the current `sourceHostId + voiceprintId` relationship as the user according to this persona.
- **Another person**: explicitly mark it as not the user.
- **Clear decision**: retain the relationship event while removing the `isUser` conclusion, returning it to unknown.

The page requests only statistics, abbreviated voiceprints, duration, last-seen time, and relationships; it neither requests nor displays transcript text. New recordings, local relationship corrections, and multi-PC persona synchronization each trigger one event-driven refresh. Reconnecting the event stream performs one catch-up query instead of fixed-interval coverage polling. The current version keeps existing voice classifications in the persona's `voice/voice-identities.jsonl` while presenting them inside Identity relations. A later unified-data migration must preserve those classifications. Multi-PC conflicts remain visible until a later explicit confirmation converges the branches.

On first use, an opaque voiceprint ID may be impossible to recognize. Select **Mark the next recording**, then speak one continuous sentence by yourself through the PC, phone, or glasses you want to classify, preferably in a quiet environment. When the next recording event completes, unresolved voiceprints newly observed during that attempt move to the front and receive an **Observed this time** marker. This only narrows the candidates: it starts no second recorder, performs no automatic identification, and never assigns the user merely because one candidate appeared. If other people spoke at the same time, confirm only a voiceprint you can identify confidently or capture again.

## How persona automation is composed

Each rule answers two questions: when it runs, and what happens next.

Triggers are:

- **When a message arrives**: select one or more message sources, with optional text, group, and speaker filters.
- **Scheduled task**: use a fixed interval, a daily time, or a one-off date and time.

Actions are:

- **Notify Agent**: send the current message or scheduled task to this persona, with optional extra decision guidance.
- **Run script**: run a `.cmd`, `.bat`, or `.py` file from the current persona's `scripts/` directory.

The same model therefore covers message-to-Agent, schedule-to-Agent, message-to-script, and schedule-to-script rules. New trigger or action types can extend this model without creating another independent rules screen.

The interface separates **When a message arrives** from **Scheduled tasks**. Message rules are then grouped into chat, voice and devices, manual and system, and other sources. The editor asks for the trigger first and the action second, showing only fields relevant to the current choices.

## Common Route kinds

| Kind | Use it for |
| --- | --- |
| `private` | QQ private messages |
| `direct_at` | A direct group mention |
| `direct_reply` | A direct reply to the account or role conversation |
| `indirect_reply` | Wider reply-chain observation; potentially noisy |
| `group_message` | Ambient group messages, normally with a narrow regex |
| `heartbeat` | Schedules and manual validation |
| `manual_trigger` | Explicit UI or API triggers only |
| `role_panel_message` | Built-in persona messages shared by local role panel and cross-persona delivery |
| `plan_feedback` | Independent plan-approval system events without recent messages |
| `voice_transcript` | FenneNote, XiaoAI, and related transcripts |
| `wecom_message` | WeCom group events |
| `rabilink` | RabiLink events |

The interface groups available kinds by adapters on the current Route. A message rule with no selected source matches every received message, and the page displays a warning. Start with private messages, direct replies, or narrow keywords before adding broader group-message matches.

## Keep regex focused

Do not forward every ambient group message with an empty regex. Begin with terms that express the intended work, for example:

```text
requirement|error|build failed|reminder|please record
```

Regex decides whether the rule matches, not whether the Agent must reply. The persona guidance should still distinguish new facts, tasks, risks, acknowledgements, and polite responses.

## Scheduled tasks

Schedule triggers support:

- recurring intervals;
- a daily time;
- a one-off date and time.

A scheduled task requires the Route's Scheduled Tasks input. Agent actions carry the current task, persona/plan/memory indexes, and required paths without automatic chat history. Script actions go directly to the local script executor instead of passing through the Agent.

## Script restrictions

Scripts are disabled by default. The current Route must explicitly enable **Allow this Route to run persona scripts**. This permission stays on the local PC and is not synchronized with the persona.

- A script must remain physically inside the current persona's `scripts/` directory; links and `..` cannot escape it.
- Only `.cmd`, `.bat`, and `.py` are accepted. Arbitrary command text is not.
- Manager tokens, passwords, and message bodies are not exposed as script environment variables.
- The same rule cannot overlap on the same Route, and a timeout stops its process tree.
- Script execution and Agent delivery keep separate results; one cannot impersonate the other's success.

Enter paths relative to the persona `scripts/` directory, such as `daily-check.py` or `tools/check.cmd`. Enter one argument per line. Validate non-destructive scripts with a test persona before using tasks that modify files or call external systems.

## What belongs in the template

Use the template for decision guidance, not to reconstruct the whole event. RabiRoute already injects the event, persona and log paths, knowledge indexes, and reply context. Ordinary endpoints may also receive their configured recent context; Heartbeat never does.

A concise work template can say:

```text
Classify this as information, question, task, risk, or decision.
Act only when facts, blockers, or next actions changed.
Use the injected RabiRoute reply interface for external output.
```

Conversational wording alone cannot grant send permission. Pipeline and message-adapter policy still gate real output.

## Save and validate

Close the rule dialog, then select **Save configuration**. The change applies to the next message or scheduled event. Legacy message-template rules appear automatically in the new interface; after saving, the persona file uses the new `automationRules` structure.

The current WebGUI has no side-effect-free RouteDecision or AgentPacket preview. Use manual trigger for validation only when you intend to enter the real delivery path.

## Continue

- Validate rules and delivery: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
- Understand reply permission: [Safety, replies, and data](safety-and-data_en.md).
