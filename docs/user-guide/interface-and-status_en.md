<!-- docs-language-switch -->
<div align="center">
English | <a href="./interface-and-status.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Interface and status

RibiWebGUI is RabiRoute's local control console. It edits configuration, invokes Manager actions, and shows diagnostics. Local files and runtime state remain the underlying sources of truth.

## Access WebGUI from the LAN

Manager on the Rabi PC is RibiWebGUI's complete HTTP backend. The operating system assigns an available port to each Manager generation. Open the current WebGUI from the tray or read `managerBaseUrl` through `RabiRouteHost.exe --command status --json`. On another device, `127.0.0.1` points back to that device, not to the Rabi PC.

On the Rabi PC, open **Console → Directory configuration → LAN WebGUI access**, enable access, and generate a key. After restarting Manager, a WebGUI still opened locally through `localhost/127.0.0.1` automatically redirects to the preferred LAN IP while preserving the current Route, page, and authentication. You can also copy the generated link, for example:

An HTTP LAN page may not receive secure browser clipboard permission. Copy-link, copy-key, and other WebGUI copy actions try the Clipboard API first and automatically fall back to an in-page copy operation when that API is unavailable or rejected. A manual-copy message appears only when the browser rejects both mechanisms.

```text
http://<Rabi-PC-LAN-IP>:<current-manager-port>/#/routes/<Route-config-name>/overview?webgui_token=<access-key>
```

The sidebar **Current Route** selector is the only selection source. Message Adapters, Persona Configuration, and Plans & Memory stay in the Route configuration group. Console is the first item in the shared-functions group, above Speech Service, but still reads the current Route. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, and Runtime Diagnostics all use `#/routes/<Route-config-name>/<page>`, with `overview`, `adapters`, `persona`, `knowledge`, `speech`, and `runtime` respectively. Changing Current Route preserves the page type and immediately redirects the URL. **Performance** and **Settings** are host-wide pages and do not change with the selected Route. To open that Route's **Plans & Memory** directly, use the same Route configuration name with the `knowledge` page, or click **Copy Route knowledge link**:

Clicking any sidebar page label updates the selected state, top title, and URL first, then immediately shows **Page switched. Loading content…**. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, Performance, Runtime Diagnostics, and Settings load their page code and data asynchronously instead of delaying the tab switch until the complete page is ready. If a page chunk fails to load, WebGUI refreshes once and restores the intended page.

```text
http://<Rabi-PC-LAN-IP>:<current-manager-port>/#/routes/<Route-config-name>/knowledge?webgui_token=<access-key>
```

The Route configuration name is URL-encoded. Any Route-scoped link selects that Route before rendering the page. Switching the sidebar Route updates the current browser session to the same page type under the new Route. To bookmark, reopen, or share the shortcut with an authorized device on the same LAN, use a complete keyed link rather than the address bar after WebGUI has removed the key.

WebGUI keeps the URL key in the current browser session, automatically applies it to HTTP, SSE, and persona-avatar requests, and removes it from the address bar so later screenshots do not keep exposing it. Rotating the key immediately invalidates old links. The switch and key can be managed only from the Rabi PC running Manager; that PC's redirected LAN address remains manageable, while other devices cannot manage them. If the link times out, confirm the current port through Host status, then check whether Windows Firewall allows this generation's RabiRoute Manager on private/domain networks. Never publish the link in a public chat, log, or repository, and do not bookmark a previous generation's dynamic port as a permanent address.

Requests from the Rabi PC to its own LAN address are still treated as local requests. Enabling LAN access therefore does not make message sending, the tray, or local tools on that same PC require the WebGUI key. Other devices must still use the complete link with a valid key.

## Access WebGUI remotely through RabiLink

When the Rabi PC has the global RabiLink Relay connection enabled and belongs to the current Relay account, sign in at `https://rabiroute.cottongame.com/manage`, then open:

```text
https://rabiroute.cottongame.com/manage/<account>/<RabiGUID>/#/routes/<Route-config-name>/knowledge
```

The remote entry uses the same Route page names. Replace `knowledge` with `overview`, `adapters`, `persona`, `speech`, or `runtime` as needed. Settings uses the host-wide `#/settings` path, and Performance uses the host-wide `/performance` path.

Replace the final page with `overview` or another WebGUI route when needed. This remote entry does not use the LAN `webgui_token`; it uses the browser's Relay management login cookie, while the PC worker separately authenticates with its application token. Ordinary APIs, images, attachments, audio, downloads, and byte-range video playback return to the selected PC's loopback Manager, and Manager events refresh through remote SSE. If the shell opens but data, attachments, or live status do not, verify that the target PC is online in Relay, the RabiGUID is correct, and the Relay script plus `ribiwebgui/dist` were published together. Restarting only the local Manager does not update the public Relay.

## The main pages

| Area | Primary purpose | Common actions |
| --- | --- | --- |
| Console | View and operate each Route | Add, enable, restart, or delete a Route |
| Message Adapters | Message sources and Agent handlers | Scan, add, connect, and bind tasks |
| Persona Configuration | Persona, Route variables, and message rules | Add rules, regexes, and schedules |
| Plans & Memory | Plans, recent memory, consolidated memory, plan guidance, and approval records for the current persona | Search, guide running plans, expand steps, review execution contracts, submit approval feedback, and refresh Manager data |
| Speech Service | Host TTS, ASR, microphone, and playback | Inspect status, adjust parameters, and test speech |
| Performance | Manager, Route, and speech-service runtime metrics | Inspect live state and history |
| Log Diagnostics | Find path breaks and run real tests | Start, restart, trigger, and inspect logs |
| Settings | Host identity, RabiLink, directories, LAN access, and desktop entry points | Configure screenshots, the selected-text menu, login startup, access keys, and access links |
| User Guide | Task-based product instructions | Search, change page, and open deeper material |

The Codex Primary Persona model field on **Message Adapters** lists models visible to the current account when Desktop is available. If discovery fails or Desktop is not running, the model ID remains manually editable. DSH lists `provider/model` choices while its service is available and also accepts manual `provider/model` input. After saving, the DSH selection is applied to the bound session before the next Primary Persona delivery; empty values leave the handler's current model unchanged.

When Plans & Memory opens, it requests eight lightweight plan summaries and immediately shows the title, status, current step, progress counts, attachment count, and update time without waiting for first-screen plan bodies. First-screen reads use a separate bounded lane from background catalog warming; simultaneous opens of the same role and page share one read, and a summary page does not scan approval records for plans that are not shown. While visible, it continues plan titles in background batches of eight and the selected memory category in pages of up to 100. Background completion updates the loaded/total count without keeping the top global progress bar active. The directory retains returned titles, while the content area mounts only eight plan cards and 24 memory cards in a bounded reading window. When a card approaches the viewport, WebGUI reads its description, current-step detail, blocker information, and attachment directory with at most four concurrent preview requests. Image, video, and Markdown attachments remain visible before expansion: images use low-priority lazy loading, videos read preview metadata, and Markdown reads only a bounded teaser. Expanding a plan fetches every step and the complete approval contracts while checking bound Agent state and refreshing feedback. Expanding Work history then fetches revision history separately. Hiding the browser tab or leaving Plans & Memory pauses observers and background reads while preserving plans, details, filters, expansion state, and reading position for the current browser session. Returning restores that cache immediately. The full page is requested again only when the user selects Refresh or reloads the browser page.

The page reads Codex Desktop state only when the user expands a plan, and after a page refresh it checks only plans that remain expanded. It no longer starts a state scan for every loaded plan. One plan is not requested twice in the same pass, and each read has a three-second limit. Expanded details show the Task Agent, the Plan Secretary when enabled, each Agent's work state, and the matching Codex task state. A missing task has its own `Task Agent session is missing` label. A valid non-working binding can be located or awakened in Codex from the card or Agent row; this opens only the exact task ID and sends no message or replacement task.

When Manager returns `presentation.acceptsGuidance=true` for a plan outside approval, expanding the card exposes whole-plan guidance. It is associated only with `planId`, not one step; the Agent uses it to continue the plan and adjust later steps when needed, then writes a `guidance_response` without `stepId`. Approval plans continue to use the owning step's approval contract and `approval_response`.

Choose the current Route in the sidebar, then check the Manager connection in the top bar. Use the Console or Log diagnostics runtime state to decide whether that Route is running.

The **Plans & Memory** page never reads `data/` directly or derives a second status. `plan.status` stores only a key from the current persona configuration. Manager returns the key together with its configured label, description, palette, order, and views; WebGUI and the Qt tray only display those results. Agents can add, revise, or remove persona plan statuses through Manager without changing program code. Steps, wait reasons, and approval metadata never replace the configured status.

The current-step summary now shows the step's `detail` description directly below its title, so users can see what the step requires without opening the full execution plan. Steps without a description do not render an empty placeholder. When a step detail contains Verification target, Reviewer, Resources, What the reviewer does, and Pass sections, WebGUI renders them as headings, resource lists, ordered actions, and a separate result block. The legacy Verification paths / Verification steps / Pass criteria format remains compatible, ordinary detail keeps its line breaks, and long paths wrap inside the card.

The directory never introduces horizontal scrolling for the whole panel. The trailing sort label remains fixed while an overflowing title moves at a constant speed on pointer hover or keyboard focus. Reduced-motion preferences disable title movement. Choices in the list dialog remain drafts until **Done**. Closing the dialog leaves the current list unchanged; **Done** closes it and immediately calls the complete plan list once with the selected Manager-side sort and filters, updating directory and content cards together. Opening the dialog first paints its frame and current result, then mounts the sort and filter controls on the next frame without requesting the plan data again.

The wider dialog uses two columns: sorting and statuses on the left, and tag search and tags on the right. Statuses and plan `keywords` tags both support multiple selections with OR matching inside each group; a plan must match both groups. The tag section is searchable and renders only its visible rows. Filter candidates and draft selections are reused for the current page session. The trigger and result summary show the active filter count, with per-group clear actions and **Clear filters**. Narrow screens stack the columns, and checkbox and action targets remain at least 44px.

When Plans & Memory is opened directly, the page loads memory counts in parallel, so the Recent Memory, Consolidated Memory, and Archived tab numbers do not wait for the user to open those tabs. Each Recent Memory card shows both its recorded time and its last true recall-hit time; a memory that has never matched a message says `Not recalled yet`. Archived source-memory cards show the recorded time and archive time. Memory bodies render as Markdown with headings, lists, code, links, and HTTP(S) images; local absolute paths and dangerous protocols are not loaded. A memory card is capped at 512px. Extra body content is clipped without an internal card scrollbar, and **View details** opens the complete memory in a separate dialog. When the least-active memory is less than 24 hours away from the 72-hour trigger, a separate consolidation panel appears above the list with the remaining time, the memory that will trigger the run, and the expected candidate count. Candidate cards are marked. At zero, Manager automatically creates and delivers the batch; the page does not need to remain open. The cohort is frozen to memories already beyond 24 hours at the original 72-hour trigger, so late execution does not append later boundary crossings. Manager derives and caches the booleans; the browser neither treats a direct view as a recall nor recalculates the candidate set.

A complete actionable `approvalRequest` with `responseStatus=pending` uses the key referenced by `planWorkflow.roles.approval`. Ongoing analysis uses `roles.analysis`; `roles.informationNeeded` is reserved for analysis that is complete but still cannot produce a concrete approvable proposal because a missing fact affects the cause, fix, scope, or acceptance contract. It is not used for a current reproduction gap, a suspected historical fix, a missing target package, pending QA, or a pending closure decision. Approval or explicit direct authorization moves the plan to the execution-role key. Missing package or inclusion proof after development uses `roles.waitingPackage`; a confirmed package without a QA conclusion uses `roles.waitingQa`; an invalid or historically fixed issue requiring no acceptance uses `roles.closed` with evidence. Discussion, pause, completion, and closure use their configured role keys. The default template displays these as Analyzing, Awaiting information, Awaiting approval, Executing, Awaiting discussion, Paused, Awaiting package, Awaiting QA, Completed, and Closed. A persona may change keys and labels, and the interface always shows the configured label. Archival is separate, preserves the plan status key, and removes the plan from keyword recall.

The default template presents ongoing pre-approval investigation, evidence gathering, solution work, available CLI checks, retries, sending, and coordination with its Analyzing label and palette. Awaiting information appears only after that analysis is complete and the remaining gap prevents a concrete approvable proposal. After approval or explicit direct user authorization, implementation and development validation use the Executing role. A completed delivery gate that only lacks package identity or inclusion proof uses the package role; proven inclusion uses the QA role. Test infrastructure, assets, documents, owner replies, renewed authorization, or external receipts use the paused role only when no safe action remains, and their exact reason stays outside the status badge. Actual labels and colors always come from the persona configuration.

The `implementation/development validation/applicable sync and commit → Awaiting package → Awaiting QA → complete on QA pass; return to implementation on failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance continue to show their real steps and wait reasons instead of being forced into package or QA stages.

A quoted **claim** in the work group only means that the Agent publicly took ownership. For the matching item to appear under Plans & Memory, managed registration must also validate the source message, verified claim receipt, unique plan, unique business task, two deduplication passes, and the same workspace across the input, plan, and task's current execution. A Codex task's saved default cwd does not participate. A successful claim with failed registration has not entered the managed plan lifecycle.

The Agent may also add images, videos, or ordinary files to the plan itself when creating or updating it, including effect previews, demo videos, design drafts, reports, or patches already produced for a plan awaiting approval. Images, videos, and Markdown appear below the plan description in compact, fixed-width 16:9 preview cards that shrink only when the container is narrower. A Markdown card safely reads the beginning of the document and displays a clamped plain-text excerpt; it does not execute HTML, open links, or load images. Clicking it opens the in-page document preview with headings, lists, tables, blockquotes, and code blocks plus a source-download action. Video thumbnails keep a play icon visible before hover or selection, then show an `m:ss` or `h:mm:ss` duration in the lower-right corner after the browser reads media metadata. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Markdown files larger than 2 MiB remain download-only to avoid freezing the browser. The complete-document renderer escapes raw HTML, disables dangerous or relative links, and replaces remote images with text placeholders instead of loading third-party resources from attachment content. Recognized media includes PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime, with actual video codec support depending on the browser. Other files show name, type, and size and open or download through Manager. The browser never reads a local path from the plan record directly; every attachment crosses the constrained Manager endpoint, and LAN WebGUI automatically applies the current session key to thumbnails, media previews, and file links.

RabiLink remote WebGUI automatically preserves the `/manage/<account>/<RabiGUID>` prefix for thumbnails, media previews, and file links, and forwards byte-range video requests. Do not add the LAN `webgui_token` to a remote URL.

Long plan lists keep the normal page scroll, while only the external plan directory scrolls independently within the viewport. As the plan cards scroll, browser visibility observation updates the directory's current reading item; the directory adjusts its own scroll only when that highlighted item leaves the directory viewport, without continuously scanning the full list on every page-scroll event. A directory click waits for its target card to mount, temporarily locks the selected highlight, and then resumes reading-position observation after smooth scrolling settles, so intermediate cards do not make the cursor jump through the directory. On desktop widths, the plan-view tabs, search field, and refresh action stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so the destination card heading remains visible. Narrow layouts return the toolbar to normal page flow instead of letting a two-row control block occupy the viewport. Detail expansion remains animation-free, and the approval input does not repeatedly auto-grow.

After plan guidance or approval feedback is durably recorded, Agent notification continues in the background. The next draft remains editable while another submission is temporarily disabled, and a nearby status row explains the reason and recovery condition. Each plan detail also has a collapsed **Work history** section. Open it to review plan guidance, step approval feedback, Agent replies, and plan revisions; the entry remains available for approved, completed, and archived plans.

## Sidebar: select the current Route first

**Current Route** determines which configuration most pages display and edit. If changes are unsaved, the interface asks before switching.

The count beside the selector is the number of configurations. The selected value and menu items prefer the persona title, while the Route configuration name, disabled state, and adapter combination remain secondary details so multiple Routes for one persona stay distinguishable. When no persona title is available, WebGUI falls back to the Route display name, persona ID, and then configuration name. The status below does not prove that every external platform is authenticated.

The secondary navigation above the footer contains **Speech Service**, **Performance**, **Log Diagnostics**, and **Settings**; these entries sit above **User Guide**.

## Interface theme

In **Settings** > **RabiRoute desktop features**, choose **Follow system**, **Light**, **Dark**, or a saved custom theme. Use the top-bar **Save configuration** action for a built-in theme and the card's **Save and apply** action for a custom theme. The current WebGUI changes immediately. The Windows tray, role panel, selected-text action bar, and screenshot windows change on the next settings refresh, usually within ten seconds. The theme changes colors and control appearance only. See [Interface theme](interface-theme_en.md) for the full guide.

## System screenshots and persona delivery

Open **Settings** in WebGUI and find **Desktop shortcuts**:

1. Enable **System screenshot**, then set the screenshot shortcut, **Auto-copy selection**, and **Pin shortcut**. The default pin shortcut is `F3`. Every shortcut can use `F1` through `F12` alone, or `Ctrl`, `Alt`, `Shift`, or `Win` plus one letter or function key. When the other Settings edits are ready, use the single top-bar **Save configuration** action.
2. Press the screenshot shortcut in any Windows application. RabiRoute captures every monitor at once and opens selection directly across all screens without asking you to choose a monitor first. The capture window opens first without dimming the screen so you can drag to select immediately. Hovering over a window shows its selectable bounds and size; once the image is ready, the area outside that window is dimmed while the window keeps its original brightness. That window is immediately the active operation area: press `Enter` / `Ctrl+C` to copy it, `F2` to send it, or the pin shortcut to pin it. A left click can still keep the whole window as a selection awaiting confirmation. After dragging, everything outside the selection is dimmed while the selected area remains at its original brightness; drag inside the selection to reposition it, or drag a corner or edge-midpoint handle to resize it. The screenshot toolbar uses icon buttons; hover shows the text label, the active tool has a teal background and bright border, and the active color has a visible selection border. After selecting an area, use the toolbar to add a rectangle, arrow, or text in red, yellow, green, or blue; Text annotations accept unlimited multiline input; type directly on the screenshot; the input range grows with the longest line and line count, then click outside the text area to commit, click the annotation again to select it, drag it to move, drag its handles to resize the text box, double-click to edit, and use the separate text-properties bar to change the font size. `Ctrl+Z` removes the last mark. Copying, pinning, and sending bake the marks into the image. If the image is still preparing, **Copy**, **Pin**, or **Send** continues when it is ready. Dragging only creates a selection awaiting confirmation: `Enter` / `Ctrl+C` copies it, `F2` sends it, and the pin shortcut confirms and pins it. By default, confirming a pin or send also copies the selection to the clipboard; turn that off in **Auto-copy selection** and use `Ctrl+C` or **Copy** when needed. `Ctrl+A` selects the full screen. Before a region is selected, a cursor-following tip shows a 10x pixel-sampling preview, the current color swatch, and the static-image HTML color code `#RRGGBB`. Press `C` to copy it directly without confirming a region, adding screenshot history, or showing a notification. Right-clicking, pressing `Esc`, or closing the capture window cancels that capture without adding it to history; copying, pinning, or sending saves the screen capture and selected area.
3. Press `<` / `>` in the capture window to view the previous / next saved screen capture. The last area used to copy, pin, or send that capture is restored. While a selected capture is open, press the pin shortcut to pin that selected area. Otherwise, it pins an image already on the clipboard. A pinned selection keeps its original screen position and size; its drag position, zoomed size, and opacity are restored after RabiRoute Desktop restarts. It can also be copied and saved. Closing that individual pin removes it.
4. Click **Send**, add optional text, choose an active persona in **Send to persona**, and confirm. The image is sent even if the text is empty.

The screenshot and text use the role-panel delivery entry. Codex and DSH receive the screenshot as image input. The file is kept temporarily in the private project directory `.rabiroute-message-images/`; pinned images and selected-area records are stored in private `data/desktop/`. After changing the screenshot toggle, screenshot shortcut, auto-copy setting, pin shortcut, or **Windows login startup**, the tray reads the new settings automatically; restarting is not required.

## Enable selected-text menu

Open **Settings** in WebGUI and find **Enable selected-text menu**:

1. Turn on **Enable selected-text menu**. When the other Settings edits are ready, use the single top-bar **Save configuration** action. Select text with a mouse drag or with `Shift` plus an arrow key, `Home`, `End`, `PageUp`, or `PageDown`. The floating buttons are horizontally centered on the selection bounds. An upward mouse drag places them above; a downward or same-line drag places them below. Keyboard selection uses system caret bounds; when Unity has no system caret, the most recent click in the same window keeps the buttons near the text.
2. Move the cursor to **Send to** to list currently enabled and running personas. Click one item to deliver the selected text to that Route.
3. **Selected-text reading** is a sub-feature of the selected-text menu. When it is on, the left button is **Read aloud** and only a click enqueues host speech. When it is off, the bar keeps only **Send to**.
4. The **Selected-text voice model** selector appears only when both **Selected-text reading** and **Advanced options** are on.

Selection alone does not read or send. Password controls and still-unreadable selections are ignored. Normal applications never receive a simulated `Ctrl+C`; only the Unity Editor sends a guarded temporary copy when UI Automation cannot read the selection, waits for the editor to update the clipboard, and restores the original clipboard afterward. After saving, the tray reads the new settings; restarting is not required.

The footer contains four supporting actions:

- **Quick setup**: configure common paths in three steps.
- **GitHub**: open the repository.
- **User Guide**: open this task-based documentation center.
- **Open config directory**: open the local Manager configuration location.

## Top bar: connection, save, and refresh differ

`Manager connected` only means the browser can reach the Manager. It does not mean the Route, NapCat, or Codex task is ready.

| Control | Actual effect |
| --- | --- |
| 中 / EN | Changes this browser's interface language only |
| Refresh status | Reloads Manager, configuration, and runtime state; does not save edits |
| Add Route | Creates a Route and opens Quick setup |
| Save configuration | Saves the current Route on Route pages; on **Settings**, saves desktop features, selected-text menu, Rabi instance, directories, and LAN WebGUI access together; on **Performance monitor**, saves the performance-recording settings |

When the unsaved-changes notice appears, save before switching Routes or leaving. Refresh is not Save, and Restart does not save form edits.


## Route state and diagnostics

The Console and Route topology show only the persisted `Enabled` / `Disabled` configuration state. Child-process, message-input, and handler failures appear in Log Diagnostics instead of becoming a third Route switch state.

| State | Meaning | Next check |
| --- | --- | --- |
| Enabled | The Route configuration allows its configured message inputs | If a message does not arrive, inspect the message input and handler in Log Diagnostics |
| Disabled | The Route is off | Enable it intentionally, then save |
| Manager disconnected | WebGUI cannot reach the current Manager | Check the generation, instance, and dynamic URL through Host status |

An **Experimental** badge is not itself an error. It means a code path exists, while the external system or real-device loop still needs acceptance in your environment.

## Start, stop, restart, and delete

- **Start** begins the current Route's runtime entry.
- **Stop** ends the Route process without deleting configuration or history.
- **Restart** stops and starts it again after build or connection changes.
- **Delete** removes Route configuration and has a wider impact than Stop.

Manager owns Route/plugin children created through process leases. Windows Host owns the Manager/tray application generation. External programs such as NapCat, QQNT, and Codex/ChatGPT Desktop keep their own lifecycles.

## Locale boundaries

Locale is stored in this browser. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values stay unchanged.

The User Guide selects the matching language file. Developer documents, code paths, and external pages open through links; RabiRoute does not maintain a third machine-translated source.

## Continue

- No successful delivery yet: [Run your first Route](first-route_en.md).
- Unsure which source to choose: [Routes and message adapters](routes-and-adapters_en.md).
- Status looks healthy but delivery fails: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).

## Persona automation and Agent Hooks

The Available template variables button opens a dismissible reference dialog. The variable list no longer occupies the automation page.

Under Agent Hook → Event delivery, configure Event → Conditions → Destination. Task completed is currently supported; the turn must pass completion checks. Add or remove Project filter, Require a linked plan, Include sessions, and Exclude sessions conditions. Every condition must match; no conditions means all Codex tasks match.

Session conditions support searchable multi-selection and explicit paginated loading. Include sessions matches any selected session; Exclude sessions takes precedence, and all other conditions must still match. Matching uses full session IDs, so renaming does not change the rule. Names are display labels only. Empty selections cannot be enabled; scanning runs only when requested with the button.

For NapCat, choose a Route, QQ account, group or private QQ, and the corresponding ID. Speech uses the selected Route's synthesis and playback settings without QQ fields. Existing group rules migrate while preserving their project, plan requirement, destination, and enabled state; saving removes the legacy fields. New rules start disabled; complete the settings, enable the rule, and save the persona.

With a project filter, Codex projects in different repository directories remain separate; worktrees retain the relative project directory. Non-Git projects match the exact directory. Notifications show the task name, linked plan names, and final reply, without project paths or session IDs. The current Codex title takes priority over the saved plan binding title; if neither exists, the task is labelled unnamed. Require a linked plan only accepts task bindings in this persona's plans.

Repeated events reuse the receipt for the same task, turn, and target. Uncertain sending outcomes are not automatically retried; check the Route's sending log. Events without a turn ID or final reply are ignored. Rules start disabled and do not send historical messages when added.

Persona → Automation has Receive messages, Custom tasks, and Agent Hook tabs. Hook settings belong to the persona in `personaConfig.json`, survive Agent changes, and are shared by Routes using that persona. Legacy Route settings move into the persona file on save or explicit migration.

The Agent panel provides only Update Hooks in Agent for initial installation and later updates. Codex uses its official plugin installer. DSH installs into the local `web` profile and requires a plugin reload or DSH restart. Packages live in `plugins/rabi-codex-context/` and `plugins/rabi-dsh-context/`.