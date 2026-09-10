<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Desktop

> Status: current Windows presentation child. RabiRoute Host is the only application-lifecycle owner; tray/task-window and Manager must carry the same `applicationGenerationId`.

This PySide6/Qt application provides a tray icon and floating role panel. It reads Manager, Route, plan, and memory state, and can send text or file attachments to the Agent bound to the selected Route through the `rolePanel` message adapter.

The Qt layer is kept portable where practical. See the [Windows launcher and packaging guide](../../docs/windows-launcher-and-packaging_en.md) for the authoritative packaging boundary.

## Current capabilities

- Uses the system tray when available and falls back to a normal window otherwise.
- Relies on Host's per-user singleton and application generation for exactly one tray; Desktop has no second singleton or autostart mechanism.
- Reads Routes, runtime status, and role bindings from the Manager.
- Selects the only enabled Route on first open. It falls back to the `Rabi` persona or the first row only when enabled selection is ambiguous, so a disabled unrelated persona does not become the accidental default.
- Switches between Routes and six views: Chat, Current, Plans, Recent Memory, Archived, and Diagnostics.
- Keeps all six views visible in the primary navigation; Current is grouped into current plans and recent memory, while Diagnostics uses a read-only status/path table.
- Desktop consumes schema/profile-v2 declarative contributions from Manager to enable tray commands, panel actions, system selection, system-capture and clipboard-pin hotkeys, and `system` / `light` / `dark` / `custom:*` themes. Desktop imports no third-party Python entry points and lets no plugin register lifecycle authority. Deactivating a plugin removes its entries and listeners. **Open RabiRoute WebGUI** is a Host-bound presentation entry that opens this generation's dynamic URL rather than a plugin contribution. A plugin Manifest's `hosts` field identifies where its code runs; a Manager plugin can publish desktop entries through a contribution with `hosts: ["desktop"]`, which Desktop then validates against its frozen Registry before execution.
- Follows RibiWebGUI's `RabiLight` visual language: mist-blue page backgrounds, white surfaces, deep navy text, teal interaction accents, 8px radii, and light borders. The tray menu and the panel's More actions menu share this palette. Windows no longer registers Qt's implicit `setContextMenu`; presentation-only `TrayMenuController` handles both left-click `Trigger` and right-click `Context` and directly calls non-blocking `QMenu.popup()`, so either click immediately opens the same prewarmed menu. The role panel also completes an invisible QWidget/native-layout warmup before the tray icon becomes clickable, keeping the first persona click from paying several hundred milliseconds of construction cost. Persona actions first show, raise, and request activation synchronously inside the user-click callback, preserving Windows foreground-user permission, then apply cached DTOs and rebuild content on the next event-loop turn. Menu rebuilding likewise waits until the menu closes. The current persona and up to five persona-chat entries are shown directly, while overflow entries are created lazily when More personas opens. Running, warning, and offline states retain distinct semantic colors.
- Uses the same Rabi Manager backend as RibiWebGUI. Route summaries and persona display information come from `/gateways?summary=1`; plans, memory, role conversation, and avatars come from `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar`, while plan approval feedback uses `/api/roles/:roleId/plans/:planId/feedback`. The tray never reads `data/` or persona files directly. A Qt-free `DesktopRefreshService` assembles API snapshots and a generic Qt thread-pool bridge runs them asynchronously; refreshes, role-chat sends, approval submissions, and manual triggers keep Manager I/O off the UI thread. A hidden panel requests only the lightweight Manager/Route summary—not plans, memory, conversation, or avatars—and does not rebuild widgets, so the 10-second tray refresh cannot repeatedly trigger large role-data reads. Completed refreshes wait while the tray menu is visible, and Manager fields outside the presentation signature do not rebuild the menu or panel. Only one refresh runs at a time, while explicit manual refresh remains queued. Transient failures may label the last snapshot; persistent disconnect or identity mismatch exits the child so Host can decide whether to rebuild the generation.
- `/gateways?summary=1` contains only persona identity, path, avatar, a lightweight title extracted from the file prefix, and other presentation metadata. It neither reads nor transfers full persona Markdown bodies, avoiding repeated large persona transfers during the 10-second refresh.
- Collapsed plan cards use three summary rows: title, current step, and trigger keywords. The current-step row prefers the structured `Step N · title` form; plan and memory keywords stay on one responsive line, reveal more as the window widens, and mark hidden items with `……`. Expanding a plan hides the collapsed current-step summary and reveals every keyword plus the full plan details.
- Expanded plan cards list the complete `steps` array first, show completed/total progress, and identify the execution point with both a `Current: step N` callout and a highlighted row. Steps are no longer truncated to a six-row preview, and structured plans do not repeat `nextAction`. The status, callout, and current row become blocked only when Manager returns `presentation.tone=blocked`; raw `blockedBy` text does not let the tray invent a second blocked-state rule. Only legacy plans without `steps` keep the old current/next compatibility area.
- `plan.status` is the tray's only displayed status and stores an enabled key from the current persona's `personaConfig.json.planWorkflow`. Manager returns the matching `presentation.status`, label, description, tone, palette, sort level, and views. The tray keeps no fixed status table and never derives another state from step IDs, prose, waiting reasons, or approval metadata.
- `archiveStatus` independently controls Archived view membership. A plan may archive only when its configured status is terminal and archive-eligible, after the persona's configured delay; archival preserves `plan.status`. Archived plans do not participate in keyword recall and are available only by explicit plan ID or Archived view.
- When Manager marks the current plan/step as requiring approval, the expanded card shows Manager's approval contract and missing fields. `incomplete/enabled=false` is labeled `Approval information incomplete / approval disabled` and disables input and submission; only `ready/enabled=true` can submit. Submission waits only for Manager persistence with a five-second request boundary; a `pending` response ends loading immediately while Agent notification continues in the background. Feedback remains linked to `planId` and `stepId`, and a failed record can retry with the same `feedbackId`. This entry never advances a step or changes plan status directly.
- Reads role-panel history and sends explicit text or file messages. The chat view groups messages by date, keeps sender and time inside each bubble, and renders attachments as compact file rows so timestamps and nested cards do not interrupt the conversation. The composer grows within a bounded height, sends with `Enter`, and keeps `Shift+Enter` for line breaks. Delivery waits for Manager and Agent-adapter confirmation on a background thread, so the window remains usable; failed sends keep the draft intact.
- Labels panel input as `Local user` instead of the selected persona, and reports success only after a matched Route and Agent adapter return `delivered`. Disabled Routes, rule misses, and missing handlers surface as failures.
- After an active plugin provides `desktop.system-selection`, turning on **Enable selected-text menu** in WebGUI **Settings** allows text selection with a mouse drag or with `Shift` plus an arrow key, `Home`, `End`, `PageUp`, or `PageDown`. The floating bar is horizontally centered on the selection bounds: an upward mouse drag prefers the top side, while a downward or same-line drag prefers the bottom side. Keyboard selection first combines the system caret bounds before and after expansion; when Unity has no system caret, the most recent click in the same window keeps the bar near the text instead of a window corner. Hovering over **Send to** opens the currently enabled and running persona list; clicking one item reuses role-panel delivery for that Route. Selection alone performs no action. Normal applications use UI Automation for both text and geometry. Only when the Unity Editor does not expose the selection does the desktop send a guarded temporary `Ctrl+C`, wait for the editor to update the clipboard, read the text, and restore the original clipboard. Password controls and still-unreadable selections are ignored. **Selected-text reading** is a sub-feature: when it is on, the left button is **Read aloud** and a click enters the RabiSpeech host FIFO; when it is off, the bar keeps only **Send to**. The TTS model selector appears only when both **Selected-text reading** and **Advanced options** are on.
- Under **Settings**, enabling system screenshots and configuring a shortcut makes region capture available from any Windows application. The shortcut captures all screen pixels before opening the selection window, without waiting for widget creation or queued background work. Image saving and window discovery continue in the background. The screen is not dimmed as a whole, and you can select directly. Hovering over a window shows its selectable bounds and size; once the image is ready, the area outside that window is dimmed while the window keeps its original brightness. That window is immediately the active operation area: press `Enter` / `Ctrl+C` to copy it, `F2` to send it, or the pin shortcut to pin it. A left click can still keep the whole window as a selection awaiting confirmation. After dragging, everything outside the selection is dimmed while the selected area remains at its original brightness; drag inside the selection to reposition it without changing its size. Copy, pin, or send waits until the image is ready. Dragging only creates a selection awaiting confirmation: `Enter` or `Ctrl+C` copies it, `F2` sends it, and the pin shortcut confirms and pins it. By default, confirming a pin or send also copies the selection to the clipboard; turn that off in Settings and use `Ctrl+C` or **Copy** when needed. `Ctrl+A` selects the full screen. Before a region is selected, a cursor-following tip shows a 10x pixel-sampling preview, the current color swatch, and the static-image HTML color code `#RRGGBB`. Press `C` to copy it directly without confirming a region, adding screenshot history, or showing a notification. Right-clicking, pressing `Esc`, or closing the capture window cancels that capture without adding it to history; copying, pinning, or sending commits the screen capture and selected area. In the capture window, `<` / `>` switches to the previous / next saved screen capture. The default **Pin shortcut** is `Ctrl+Alt+V`; you can explicitly choose `F3`: while a selected capture is open, it pins that selected area; otherwise it pins an image already on the clipboard. A pinned selection keeps its original screen position and size. Its drag position, zoomed size, and opacity are restored after RabiRoute Desktop restarts; closing that individual pin removes it. Switching capture history restores the last area used to copy, pin, or send that screen capture. **Send** continues to use the role-panel entry, and Codex/DSH receive real image input. Screenshots are kept in the private project `.rabiroute-message-images/` directory, while pin and area records are kept in private `data/desktop/`; neither is part of public examples.
- On multi-monitor systems, the screenshot shortcut captures every screen and immediately opens selection without a monitor-picker dialog. The spanning overlay is positioned using the full desktop's physical pixel bounds. Rendering, selection, and window snapping share that window's coordinate mapping, supporting different resolutions, mixed scaling, and negative coordinates on monitors to the left or above. New history records preserve the physical bounds; older records remain readable.
- Packaged Desktop loads code and assets from the active `versions/<releaseId>`, while screenshot images, region history, pin state, selected-text settings, and generated COM caches are written only to the stable installation root supplied by Host. Version directories remain read-only and upgrades retain the same local data.
- Persona desktop pets read bounded animation packs, persona names, and local bindings from Manager. Each persona that is enabled and has a runnable pack gets one window, so enabling several personas displays several pets; disabling one removes only its window. A legacy `enabled=true` binding without a pack does not create an empty window. Pets support GIF / PNG sequences, persisted placement, scaling, always-on-top, locking, click-through, bubbles, and automatic fullscreen hiding. Pack-level `idleBehavior` can schedule random idle actions and a looping sleep state after prolonged inactivity. Click, drag, opening the persona panel, or a `work_ended` event with the matching `personaId` wakes only that pet. Pack import, selection, and local enablement live under WebGUI **Persona Configuration → Virtual avatar**; Qt does not scan or edit persona directories directly. A packaged Windows runtime may keep rebuildable copies of bound immutable packs under `data/cache/desktop-pet-roles/` to avoid high-frequency PNG reads exhausting NAS handles, while the shared role directory remains the source of truth.
- After a screenshot selection is confirmed, corner and edge-midpoint handles resize it. The toolbar aligns to the selection's right edge and supports rectangle, arrow, and multiline text annotations in red, yellow, green, or blue. Text can move, resize, reopen for editing, and change font size; `Ctrl+Z` removes the last mark, and copy, pin, or send bakes annotations into the image.
- **Settings → Windows login startup** synchronizes only a per-user Startup shortcut targeting `RabiRouteHost.exe`; turning it off removes that shortcut. No startup entry points directly at the tray. The tray watches screenshot and pin settings, so those changes do not require a restart.
- Keeps plan content and memory read-only; only Manager-declared approval steps accept appended feedback.
- Plan cards use Manager's configured QA presentation label, `Awaiting QA acceptance` by default, while the stable status key remains `等待 QA`; the implementation/package/QA flow applies only to plans that change project content.
- Opens role, plan, memory, project, and runtime-status directories only while the corresponding panel commands are active.
- Shows and runs declared `manual_trigger` or `heartbeat` actions only while the `manager:gateway-runtime` manual-trigger command is active.
- Withdraws stale contributions whenever the plugin catalog is unavailable or refresh fails. The Host-bound RibiWebGUI entry and local refresh remain available; application exit goes only through Host control.

Sending a message, submitting approval feedback, or triggering a rule is an explicit user action. The panel never creates, edits, completes, archives, or deletes plan and memory files directly; Manager writes approval feedback to its audit record and the Agent decides whether to update the plan.

## Out of scope

- Starting, stopping, repairing, or supervising Manager; only RabiRoute Host owns the Windows application lifecycle.
- Executing real Codex prompts; Desktop IPC still delivers them to a loaded task.
- Sending QQ/NapCat messages or bypassing Route policy.
- Hosting a new MCP server, command port, or fallback task Runtime.
- Making the core project Windows-only.

## Install and run

The installed Host starts Desktop. Use `npm run dev` or `npm run dev:hot` for source development. To validate the complete Windows application, first build the release on local disk and then start `RabiRouteHost.exe` from the build or installation directory:

```powershell
& "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe"
```

After Manager publishes an exact same-generation READY, Host starts Desktop with `--surface-child`, `--manager-url`, `--application-generation-id`, `--manager-instance-id`, and `--host-executable`. Missing arguments, a mismatched `/meta` identity, or unavailable Host make Desktop fail closed. There is no standalone mode, port search, or Manager self-start path.

Building Desktop still requires Python 3, PySide6, and the Windows UI Automation adapter:

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

The Manager plugin catalog decides when declarative contracts are active. Panel directory commands use `desktop.open-role-directory`, `desktop.open-plan-directory`, `desktop.open-memory-directory`, `desktop.open-project-directory`, and `desktop.open-runtime-directory`; manual triggers use `desktop.manual-trigger`, and system selection uses `desktop.system-selection`. Removing those capabilities removes the UI entries and stops the listener.

## Tray latency acceptance check

With the packaged tray running, measure the complete Windows tray-callback-to-visible-Qt-menu latency:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\measure-tray-menu-latency.ps1 -Samples 100
```

The script does not move the cursor and is unaffected by DPI coordinate virtualization. It simulates ordinary left-click and right-click tray notifications separately, then timestamps the menu's Windows `EVENT_OBJECT_SHOW` event. The check fails when either path has a p95 or maximum above 100ms.

## Data and message boundary

Manager remains the owner of plan and memory files under `data/roles/<RoleId>/`. The tray, like RibiWebGUI, consumes only Manager HTTP DTOs and never opens or parses those files; paths are used only for directory actions and diagnostics.

Role chat uses Manager APIs and passes through the selected Route's `rolePanel` input, template policy, and Agent adapter. It does not write plan or memory facts directly.

## Lifecycle

Desktop is not a separately persistent application. Host starts Manager, validates structured READY, and then starts Desktop in the same generation. Desktop verifies `applicationGenerationId`, `managerInstanceId`, and `managerBaseUrl` through `/meta` before becoming available.

**Exit RabiRoute** calls Host's local control channel with the current `applicationGenerationId`. Host ends the complete Windows Job and exits. Desktop never calls Manager start/shutdown HTTP APIs or kills a PID.

When Manager or Host remains unavailable, Manager identity changes, or Desktop itself fails, Desktop exits. Host closes the old Job and applies bounded whole-generation recovery. There is no resident tray reconnect loop or parallel guardian chain.

## Code layout

- `ManagerClient`: the shared Manager HTTP backend client for Routes, plans, memory, conversation, avatars, and business actions.
- `DesktopRefreshService`: Qt-free API snapshot orchestration with no local role-file access.
- `desktop_models` / `desktop_read_model`: Manager DTO conversion and rebuildable presentation caches.
- `qt_async`: generic Qt thread-pool bridge with no Manager or role business logic.
- `desktop_pet_idle`: pack-configured random-idle timing, long-inactivity timing, and non-repeating selection only; it neither loads assets nor owns the final animation state.
- `system_selection`: Windows global mouse-drag and keyboard-selection detection, UI Automation text extraction, the Unity-only clipboard fallback, selection-avoiding no-activate floating bar, active-persona hover menu, and Manager-only speech/role-panel actions. The Read aloud button is hidden when `readAloudEnabled` is false.
- `system_screenshot`: Windows global region capture, selected-area or clipboard pinning, screen and selected-area history, restart-restored pinned-image windows, and role-panel image-attachment delivery; persistent settings are owned by Manager at `/api/desktop/settings`.
- `LifecycleController`: validates Host-injected same-generation identity and sends explicit user exit to Host; it does not own Manager lifetime.
- `TaskWindow`: Route navigation, six views, composer, and rendering.
- `DesktopAdapter`: portable URL and path opening.
- `tray_app`: presentation-only composition root for menus, windows, cached DTO application, and user events.

Future macOS and Linux launchers should reuse this Manager protocol and Qt presentation layer with one platform application Host rather than fork business behavior or add a second lifecycle owner.
