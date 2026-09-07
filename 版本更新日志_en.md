<!-- docs-language-switch -->
<div align="center">
English | <a href="./版本更新日志.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Version update

## Unreleased

### 0.2.4 source update

- NapCat lifecycle operations now follow route bindings, with one QQ account per route. Unbinding blocks new operations before verifying process identity and stopping owned instances. Login controls share binding, login and stop-failure states.
- Persona pages add paginated Agent final-reply history. Hook switches and completion-delivery rules are stored in persona configuration, with project, plan and session filters and deduplicated delivery through existing QQ or speech endpoints.
- Agent pages can install or update packaged Codex and DSH context hooks. Codex checks task model settings before delivery and avoids automatic resends when a receipt is uncertain, retaining the original task and diagnostics.
- Message envelopes include their send time. Speech synthesis receipts retain delivery tracing, and work-cycle recovery recognizes completed failure receipts instead of treating them as pending sends.
- A Windows source-build launcher reuses the installed Host and data, verifies the new generation and WebGUI content, and allows a short recovery window during final Host startup checks.
- RabiLink adds experimental direct WebRTC video. Relay carries signalling only; the PC stores bounded H.264 streams. Glass camera capture, sustained decoding and public mobile networks still require acceptance; see [direct video](docs/rabilink-direct-video_en.md). This records a source version; installer delivery is verified separately.
- Submission validation: the initial backend run had 1,870 passes, 24 failures and 3 skips out of 1,897 tests. After updating stale message-time and NapCat lifecycle assertions, all 24 failed cases passed with one test process at a time. WebGUI (262), DSH hooks (3), dynamic-address and mutation-audit checks (6), Windows Host tests, the full build, Android unit tests and acceptance APK compilation passed.
- The script run had 160 passes, 2 installation-preparation timeouts and 36 TODO cases. Both timeouts passed when rerun separately; TODO cases remain pending.

### Directory-watch degradation diagnostics

- Configuration and plugin-directory watchers now write degradation, changed failures, and recovery to the shared Manager log, retaining the watcher, attempt, child PID, duration, timeout, restart count, and redacted error stack. Ordinary status refreshes do not repeat records; earlier failures remain available after recovery.

### Source submission review and delivery limits (0.2.3, Unreleased)

- This submission publishes source only, not a Windows runtime package or installation update. Home Assistant help links reject URLs containing a username or password so credentials do not enter browser links.
- Four Medium findings remain owned by `RabiRoute maintainer` and must be fixed and retested before the next Windows runtime-package delivery: junctions beneath download targets, manifests, or temporary-file paths can bypass root restrictions; synchronous CIM and model-file probing can block Manager; an already-started directory PATCH can write after new ingress is fenced; and that PATCH has no request-body size limit. These depend on local configuration, filesystem layout, or an already-accepted request. This source submission does not treat them as resolved or claim installed-runtime acceptance.

### Plan storage lock recovery

- Stale plan lock reclamation now moves the old lock to an unused name under the reclaim fence, then publishes the candidate exclusively rather than relying on overwrite renames on SMB. Renewal or competing acquisition aborts takeover; restoration never overwrites another owner, and a failed restoration preserves the old lock as recovery evidence. This implementation note does not claim NAS runtime acceptance.

### Persona diagnostics snapshots

- Page diagnostics workers now receive and install the Manager's committed persona presentation snapshot, preventing missing snapshots from making Route persona lists or persona content unavailable. Page requests do not rescan the shared persona directory for this purpose.

### Xiaomi Home credential help

- The Xiaomi Home connection card now links to the Home Assistant home page, token management, and official documentation, with collapsible credential setup steps. Address and token errors are shown separately; guidance distinguishes Home Assistant long-lived access tokens from Xiaomi account passwords and device tokens. Paste the token directly into the connection form, not into chat.

### Screenshot hotkey recovery

- Failed hotkey registration is no longer permanently blocked by an exited thread. Added bounded backoff retries and failure notifications, with safer cancellation across the worker and Windows message queue.

### Desktop pet loading recovery

- The tray distinguishes loading, loading failure, and an authoritative empty avatar roster. Failures expose a retry action and use backoff recovery instead of silently reporting no enabled avatars. Transient request failures preserve existing pets; closing cancels retries and ignores late results.

### Sidebar brand text

- Raised sidebar button style specificity so later Vuetify capitalization rules cannot turn `GitHub` into `GITHUB`; the link target is unchanged.

### Model management

- Categories are now TTS, ASR, and speaker recognition only, defaulting to TTS with category-scoped counts and search. Added a local model root setting: empty restores the default, and an explicit value overrides it. Detection and downloads share the effective root without moving or deleting models. Saves enforce local access, lifecycle identity, settings revision, and idle-job checks.
- Replaced large dialog cards with a compact environment bar, conditional task row, and collapsed guidance so model filters, search, and the table appear sooner. The action is now labeled **Download model**. Runtime requirements use neutral wording instead of implying a detected missing environment.
- Model file detection no longer requires an `installed` download-manifest entry. It checks configured local model locations and known model files; empty directories, missing shards, and broken directory links do not count as downloaded. File checks do not replace checksum integrity or inference acceptance.

### Message adapter entries

- Removed the Xiaomi speaker / XiaoAI add menu, quick setup choice, rule category, built-in runtime registration, and discovery entry; Xiaomi Home remains available. Legacy `xiaoai` configuration fields and message-source identifiers remain readable, but no dedicated speaker receiver is registered. Remove the adapter from old Routes and use Xiaomi Home where appropriate. Historical bridge material is no longer current integration guidance.

### Plan status semantics

- The stock information-needed state is now reserved for completed analysis that still cannot form a concrete approvable proposal. A current reproduction gap, suspected historical fix, missing target package, pending QA, or pending closure decision no longer uses this state; each remains in analysis or moves to the package, QA, or closed role as appropriate.
- `planWorkflow.schemaVersion` is now 4. Migration changes only untouched stock Chinese and English descriptions in v2/v3 configurations, preserving persona customizations and Agent-retired states. The orchestration Skill and Agent context no longer refer to a nonexistent Rabi acceptance-pending status.

### Data-mutation logging

- Manager and Gateway now write configuration, plan, memory, message-record, delivery-receipt, identity, speech, health-record, attachment, and runtime-state mutations to one daily JSONL stream. Records carry the owning module, action, target, data source, outcome, revision/digest, and request trace fields without storing message bodies, credentials, health measurements, or media content.
- Failed operational-log batches remain pending and retry with backoff; `/meta.operationalLog` and Manager health report degradation. Logs retain 30 days by default with a 512 MiB cap across historical shards. An automated coverage check requires every new direct file mutation to declare an audit path or a reviewed infrastructure exclusion.

### Xiaomi Home Route authorization

- Merged the upstream Route message-endpoint placement: the current Route's Xiaomi Home cards manage connection credentials and event, device-control, and recording policy, rather than placing configuration in global Settings. The long-lived token is submitted only through one lifecycle-fenced, `Idempotency-Key`-protected request; after verification it is stored with current-user DPAPI on Windows or an access-restricted local AES-256-GCM key elsewhere. Configuration, logs, and APIs never echo it.
- The address and candidate token are verified together before runtime replacement; a credential bound to an old address is never used for a new one. Non-loopback targets require HTTPS by default; `allowInsecurePrivateHttp` permits literal private addresses only, and public HTTP is always rejected. Authentication mutations use durable receipts and an authorization revision: a duplicate key replays its result, a different intent conflicts, and a delayed old disconnect cannot remove a newer connection.

### Codex task and execution workspace

- A Codex task's complete ID now determines task identity on its own; a Route or plan binding workspace controls only the current turn. A different saved default cwd no longer blocks resolution, managed registration, opening, or continuation and does not create a replacement task. Deliveries to the same task remain serialized by task ID across workspaces.

### Codex plan-update reminders

- After a Codex task changes project files inside its plan-bound workspace, the Stop Hook reminds the Agent in that same task to check whether the bound plan needs an update. It emits at most one reminder per turn, merges multiple plans bound to the same context, and never changes plan status automatically.
- Read-only Windows Host status queries now read the active generation's control pipe directly while preserving the existing camelCase JSON contract. Startup, quit, restart, and release activation still perform complete payload validation.

### Plan status and archival

- Each persona's `personaConfig.json.planWorkflow` is now the single configuration source for its plan workflow. `plan.status` stores only an enabled status key; labels, descriptions, colors, order, views, step constraints, approval behavior, completion behavior, and archive eligibility come from configuration. The default template supplies Analyzing, Awaiting information, Awaiting approval, Executing, Awaiting package, Awaiting QA, Awaiting discussion, Paused, Completed, and Closed, but code and clients keep no second enum. Awaiting information is used after analysis has established that the goal, scope, acceptance criteria, or implementation evidence is still insufficient.
- `planWorkflow.schemaVersion=2` adds a distinct role mapping for Awaiting information. The first read of an existing v1 persona configuration preserves custom statuses and relative order while upgrading once; startup does not restore statuses an Agent later removes through the catalog API.
- Manager adds status-catalog APIs protected by `Idempotency-Key` and revision preconditions. Agents can add or update statuses; removal requires a replacement key, migrates unarchived plans first, and retains a retired definition for archived plans and history. Startup migration rewrites legacy aliases to current keys and removes retired step-phase fields.
- Archival remains independent through `archiveStatus=未归档 | 已归档`. The persona workflow config determines eligible statuses and delay, archival preserves the plan status, and archived plans are excluded from keyword recall while remaining available by explicit ID or the Archived view.

### Persona virtual-avatar entry

- Desktop-pet assets, enablement, and local presentation controls moved from global Settings to **Persona Configuration → Virtual avatar**. Packs are read and imported for the current persona, and enablement remains unavailable until a runnable pack is selected; stale enabled records without a pack no longer show an empty window. Desktop now adds or removes one pet per enabled persona, displays as many pets as are enabled, and loads window and menu labels from persona names instead of hard-coding YeYu. Local size, position, and window behavior stay in desktop settings and do not synchronize with the persona folder.

### Source Manager startup and legacy-data migration

- Fixed source Manager route/persona catalog snapshots producing different hashes after optional fields crossed child-process JSON IPC, which kept `/meta` degraded with `ROUTE_CATALOG_STARTUP_FAILED`. Route catalog hashing now follows JSON transport semantics.
- Startup migration now backfills a verifiable `history.jsonl` for legacy canonical plan directories that contain only `plan.json`. Active plans receive an imported-created record and archived plans receive an imported-archived record without inventing a previous state; later startups remain idempotent.
- Configuration watching no longer treats route directories that contain only logs or retired state and no `adapterConfig.json` as broken configuration, so keeping source-runtime directories does not degrade Manager health.
- Configuration and plugin watch workers now get a grace period to exit naturally after returning a snapshot, with termination used only after that deadline. This prevents completed workers from being recorded as `termination_failed` and keeping `/meta` degraded during Windows source startup.
- Watch-worker lifecycle confirmation now also accepts the operating-system `exit` signal. A PID that no longer exists cannot block later configuration and plugin-catalog refreshes even if Node does not emit a subsequent stream-close notification.

### Desktop runtime data directory

- Desktop now saves screenshots, region history, pin state, selected-text settings, and generated COM caches under the stable state root supplied by Host, while release directories provide code and assets only. Screenshot data previously written under `versions/<releaseId>` is migrated, so Host status, restart, and upgrade operations no longer reject the active release because a `data/` directory appeared inside it.

### Windows runtime and firewall identity

- Windows Host now synchronizes the manifest-validated Node.js runtime to the fixed `runtime/node.exe` path. Manager and child processes no longer start from the changing `versions/<releaseId>/node.exe` path. With LAN WebGUI or persona synchronization enabled, upgrades no longer trigger repeated Windows Firewall prompts just because the executable path changed. Uninstall removes the stable runtime only when it matches the active release copy by hash.

### WebGUI theme readability

- Fixed attachment names, descriptions, plan steps, approval contracts, and memory details blending into dark-theme backgrounds. Theme startup now reads Manager `webTheme` and `customThemes`; custom themes update both CSS semantic colors and the Vuetify control palette, while normal and small secondary text are validated at `4.5:1`. Page, card, and input surfaces now use theme surface tokens, and custom surface brightness must match the selected light or dark base.

### Desktop screenshot hotkeys

- Fixed system-capture and clipboard-pin shortcuts not responding in 0.2.2. Desktop now reads desktop commands published by Manager plugins and registers the configured `F1`–`F12` or modifier shortcut. Multi-monitor capture again grabs every screen at once and opens selection directly, without a monitor-picker dialog; the selection toolbar now aligns with the selection's right edge.

### Plan attachment directory moves

- After `data/` is copied as a unit or the installation root changes, attachment reads locate the same filename inside the current plan directory and verify its size and SHA-256. An absolute path in `plan.json` that still points to the previous root no longer makes image, video, or file attachments return 404.

### Plans page session cache

- Plans & Memory now retains loaded plans, details, filters, expansion state, and reading position for the current browser session. Opening the screenshot overlay, switching browser tabs, or visiting another WebGUI page pauses reads and restores the cached page on return. The full page is requested again only after selecting Refresh or reloading the browser page.

### Plan sorting and filter dialog

- The dialog now uses a wider two-column layout, grouping sorting and statuses on the left and tag search on the right. It paints the frame first and mounts controls on the next frame. The tag list creates only visible rows and reuses filter candidates already loaded by the page, so opening, closing, and reopening the dialog adds no plan-data request.

## 0.2.3 - 2026-09-01

### Single-writer Manager state and recoverable mutations

- Plan, recent-memory, plan-feedback, and background-consolidation writes now enter `RoleStorageApplication` and a bounded mutation worker. Every mutation carries an `Idempotency-Key`, expected revision, `applicationGenerationId`, `managerInstanceId`, and storage lease. Timeout, unconfirmed termination, or worker loss exposes an unknown commit state and permits only same-key recovery.
- The Manager parent and QA/feedback paths no longer write plan or feedback files directly. Reads use the read worker and writes share one mutation port, so an old QA snapshot cannot bypass CAS and overwrite a user's newer plan edit.
- Durable delivery receipts now carry an execution owner, lease, and independent heartbeat. Receipt mutation locks linearize takeover decisions with renewal: an active same-key retry reads the current receipt instead of executing a second side effect while the first sender is still running, and an old execution cannot overwrite a replacement receipt or settle terminally after ownership loss.
- Child-process stdout/stderr no longer enters HTTP, status, or log error text. The parent retains only diagnostic byte counts and stable codes, preventing local paths, parameters, or private output from escaping through an error surface.

### Plan and memory storage recovery

- Manager publishes its fenced control plane first, then starts the startup gate to recover lifecycle, legacy-migration, feedback, and package transactions in order. Read-only mode does not probe role directories; affected HTTP and background work remain gated and report temporary unavailability until recovery completes.
- Legacy plan migration publishes a complete canonical package through the lifecycle WAL, then retires legacy plan, history, feedback, and attachment artifacts through the legacy-resolution WAL. A process terminated at any publication boundary resumes from manifests and receipts instead of relying on an in-process `catch` rollback.
- Feedback transactions fully stage and verify their payload before publishing a manifest. A mid-payload exit creates no visible prepared transaction, and the next same request restages missing files. Recovery also binds each manifest to the scanned `roleDir`, preventing a misplaced or damaged manifest from writing across personas.
- Synchronous and asynchronous plan-storage leases share a dedicated Worker heartbeat, so synchronous NAS I/O or CPU work that blocks the main thread still renews ownership. Every storage publication checks heartbeat, owner, inode, reclaim fence, and deadline; any change returns `PLAN_STORAGE_LEASE_LOST`, and finalization never deletes a replacement owner's lock.
- Plan logical IDs are now separated from Windows physical-collision identity. Aliases such as `σ/ς`, `ſ/s`, and `ı/i` that share Windows filename semantics enter the same lease and reject a second logical owner before claim, package staging, or persona-sync receipt publication. Existing ASCII-lowercase storage IDs and lease hashes remain unchanged, so no directory migration is introduced.
- Memory logical IDs are separated from physical file identity. Lossy safe filenames can no longer make two memories share one file under different leases; create and consolidation paths reject physical collisions explicitly. Published consolidated memories remain immutable and only an identical same-mutation, same-run retry may reuse them. Batch publication uses a same-directory temporary file, `fsync`, and atomic replacement for each entry so the original request can converge after a mid-batch exit.

### Route catalog, WebGUI, and device clients

- Route-catalog capture, validation, mutation, and recovery now run through a dedicated startup lifecycle. Gateway, persona-presentation, and configuration revisions use canonical SHA-256 identities. After a catalog refresh, the WebGUI and AIUI mutation ledgers still replay the original `Idempotency-Key + If-Match` to query an uncertain receipt. They release records only for definitive 4xx rejections; timeout, throttling, client disconnect, and 5xx remain an unknown commit state.
- RibiWebGUI plan-feedback, Route-settings, and Xiaomi Home clients now carry the same revision/idempotency contract. Role Knowledge separates preview from full detail and cancels stale requests when cards collapse, routes change, or the page unmounts.
- Xiaomi Home configuration now appears only inside the current Route's **Message Adapters** page. Plugin contributions, Web Bundle registration, and documentation no longer retain a global Settings entry. An authorized LAN WebGUI may read Xiaomi Home health and configuration, while device and recording APIs remain loopback-only.
- The Windows tray, Android SDK, and RabiLink AIUI no longer cache a fixed Manager endpoint. They rediscover and verify `/meta` after Host generation or endpoint changes, retaining the original key and evidence for offline mutations instead of treating reconnection as a successful write. The Android SDK preserves the legacy route-read JVM descriptors; legacy revisionless mutation overloads remain linkable but fail closed before network access, while the new catalog APIs and mutation overloads require a caller-owned operation ID and strong revision.
- Xiaomi Home device actions atomically claim a complete intent digest in a local runtime receipt store before checking `expectedStateVersion` and issuing at most one Home Assistant service POST. Concurrent calls, process restarts, and lost responses only replay the receipt or perform read-only state verification; uncertain actions are never resent automatically. Bearer tokens are sent by default only to `localhost` or literal loopback/private IPs; hostnames require explicit trust, and credentials, URL paths, and redirects are rejected.
- Manager-spawned Xiaomi Home event children verify the current `applicationGenerationId + managerInstanceId + managerBaseUrl` before reading stdin or delivering to a Route, so stale or identity-less children fail closed.

### Persona synchronization and background work

- Persona-manifest scanning, hashing, and package projection moved to a worker with generation fencing, a bounded queue, and crash recovery. Plan-package synchronization preserves logical ID, storage ID, bucket, and inventory identity, routing stale or conflicting evidence into explicit reconciliation.
- Memory-consolidation schedule inspection moved to a controlled child and reports stable diagnostic codes only. The background scheduler starts only after both plan storage and the route catalog are ready.
- RabiLink Relay, the AIUI glasses surface, Android lifecycle leases, Xiaomi Home clip/event monitoring, and plugin settings gained dynamic-Manager, revision, and recovery contracts. Phones, glasses, home devices, and cross-machine networks still require acceptance in their target environments.

### Windows developer candidates and installation boundaries

- Added local developer-candidate build, publish, and apply flows. Candidates must be produced on local disk, carry a release manifest and hashes, and pass Host fenced quit plus transactional install switching. NAS storage remains source-only and is never the build, installation, or runtime directory.
- Developer apply and the release installer share a named Mutex derived from the normalized installation root and apply exact-byte CAS to the active-release pointer. A failed switch restores the old pointer and bootstrap before autostart; the old generation restarts only after the candidate is safely stopped and the previous release identity reads back exactly.
- Install, uninstall, autostart, tray, and Host tests now share the current generation and dynamic Manager address. Retired `Start-RabiRoute-Desktop.bat` and the old launcher-freshness path were removed so a second lifecycle owner cannot return.

## 0.2.2 - 2026-08-31

### Single Windows Host lifecycle and plugin runtime v2

- The Windows package now has one application-lifecycle owner: the self-contained single-file `RabiRouteHost.exe`. A per-user Mutex/named pipe enforces one Host. Each start creates a new Windows Job and `applicationGenerationId`, with Manager and tray as same-generation children. Either child failing ends the generation and invokes bounded replacement; user quit cannot be undone by a side path.
- Host creates Manager suspended, assigns it to the Job, and resumes it. After Profile `readyRequires` are satisfied, Manager emits structured READY carrying generation, PID, `managerInstanceId`, `baseUrl`, and time. Only then does Host create the tray under the same Job. The tray revalidates identity through `/meta` and cannot run standalone, scan ports, repair Manager, or stop it.
- Local and LAN automatic Manager modes both pass port `0` to the operating system. Host `--command status --json` and the tray carry this generation's `managerBaseUrl`; a fixed port is no longer the discovery contract, so another application occupying a familiar port cannot block startup.
- Manifest and Profile accept schema v2 only and reject every non-v2 version. All 29 built-in packages declare `in_process`, `isolated`, or `declarative`; Profile includes `readyRequires` and bounded restart/resource policy. Manager loader never executes isolated entry top-level code, and Process Lease Registry reclaims long-lived children.
- Plugin-generation replacement now disposes consumers before providers. `lifecycle.signal`, effects/disposers, request drain, and process leases meet at one stop boundary. A failed candidate preserves the last committed generation without half-active services or orphan children.
- Installer, login startup, desktop/Start-menu entries, and the compatibility BAT all target Host only. Retired parallel lifecycle scripts, tray self-start/self-repair, Manager HTTP application start/stop routes, and fixed-port discovery are removed from the production path.

### Desktop tray WebGUI entry

- **Open RabiRoute WebGUI** now remains visible in the main tray menu instead of disappearing after a successful plugin-catalog load; a same-name catalog contribution is deduplicated.

### Dynamic Manager ports and instance discovery

- The Host-generation plus operating-system dynamic-port architecture above supersedes this intermediate design. Manager no longer publishes endpoints through its instance-lock file or retries a small port range; structured READY, Host status, and `/meta` close the same-generation identity and URL loop.

### Rabi mobile voice-service autostart

- Settings now includes **Automatically start voice service after Rabi opens**. When enabled, an App launch starts voice service in the selected phone or glasses mode. Phone mode without microphone permission restores message transport only and does not trigger a launch-time permission prompt.
- Turning the switch off and applying it immediately stops phone and glasses capture while preserving text, media, downlink, and reliable queues. The foreground notification now says that message transport is connected instead of incorrectly claiming that Rabi is listening.

### Independent desktop-pet and YeYu Gamer plugins

- Desktop-pet pack, binding, settings, and bounded-asset APIs now belong to the independent `io.rabiroute.manager.desktop-pet` plugin under `/api/desktop-pet/roles/:roleId`. Its generation owns route registration, removal, and request draining. The Desktop client adds configurable randomized idle and sleep scheduling with bounded temporary-asset and cache scope.
- The local YeYu Gamer integration now belongs to the disabled-by-default `io.rabiroute.manager.yeyu-gamer` plugin. Its configuration lives in the single Profile, the target is fixed to `http://127.0.0.1:8877/api/v1`, and protected reads plus plan-only work-item creation use a separate local token. No claim, capability invocation, shell, click, or legacy-script surface is exposed.
- The default Profile now contains 29 independent Manager plugin packages, all migrated to schema/profile v2 and the unified execution-mode contract.

### Offline continuation when the plan control plane is unavailable

- `plan-task-orchestration` now makes one controlled recovery attempt after a Manager availability failure and searches only bounded RabiRoute source candidates. Authorized project work continues when recovery fails or no source checkout exists.
- PangHu can record intended plan changes, modified files, validation evidence, SVN revisions, and remaining work in the versioned `RabiPlanCache/pending/` queue. After Manager recovers, the agent semantically deduplicates and updates the real plan, then writes a `synced` receipt only after obtaining the real `planId` and a successful reread. The cache never replaces Manager plan state.

### Agent model selection

- The Codex Primary Persona model is now an editable combo box. When Desktop is available, it loads the current account's model catalog and matching reasoning efforts; manual input remains available when Desktop is stopped or discovery fails.
- DSH Primary Persona configuration now includes model and reasoning-effort selection. It reads `llm.models` when DSH is available, accepts manual `provider/model` input otherwise, and applies the saved choice through `session.selectModel` before the next Primary Persona delivery.

### Speech model management

- The model library now uses a table with separate columns for model, capability, purpose, size, runtime, status, source, and action. Filtering, search, error details, and weight downloads keep the same behavior.

### Shared sidebar functions

- Console is now the first item in the shared-functions section, above Speech Service. It still follows the current Route, while Message Adapters, Persona Configuration, and Plans & Memory remain in the Route configuration section.

### Message-configuration channel check

- Added **Channel check** to the top of Message configuration. The dialog now shows the current Route as **Message inputs → Manager → Agent handlers**, including Manager runtime state, message-input connectivity, and primary or secondary Agent roles. Selecting a node returns to its settings.
- Agent nodes now provide **Delivery test**. Manager sends a UUID-tagged message through the current Route’s formal Agent adapter to the selected session and returns that adapter’s receipt. Codex success also requires the test ID to appear in the target Desktop task.

### LAN Rabi Agent

- Added an experimental headless LAN Rabi Agent, Manager node/task APIs, a Rabi Web management page, and self-update flow. A node delivers only to its configured Codex Desktop task owner. Real multi-computer bootstrap, update, and reconnect acceptance remains pending.
- Release manifests expose the Ed25519 public key, signature, and public-key SHA-256 fingerprint. Bootstrap stores the fingerprint in node-private configuration; every update compares that pinned value before verifying the manifest signature and file SHA-256 values, so replacing the key and re-signing is still rejected.

### WebGUI theme colors

- Message-adapter parameters, plan descriptions and attachments, persona Markdown documents, plan status labels, and the speech waveform now follow the active theme instead of retaining fixed light surfaces or dark headings in dark mode.

### Codex Desktop sidebar Name authority

- The user-visible Codex task name now comes only from `thread_name` in the index shared with the Desktop left sidebar. app-server `thread.name` and SQLite `threads.title` no longer override names or participate in name filtering.
- Plan Secretary and Message Agent names use the Primary Persona sidebar `Name` as their prefix. Creation and rename fail closed when that Name is missing instead of falling back to the first prompt, Route name, or another raw title.
- The complete task ID plus normalized workspace remains the delivery identity, so renaming does not invalidate exact-ID delivery. The task catalog now comes directly from the sidebar index plus local task state; app-server remains only for empty-task creation and naming.
### RibiWebGUI cold start and message-board retention

- The WebGUI now renders its fixed shell immediately after LAN-address normalization. The plugin catalog and optional Web Bundles refresh in the background. A direct knowledge-page URL no longer waits for an optional Bundle; catalog delay or one Bundle failure keeps the original path and a recoverable loading state.
- The knowledge page first resolves the Route and role through `/gateways?summary=1`, displays eight plan summaries, and then serially loads the remaining pages for the same filter in the background. A Route change, hidden page, or unmount stops later reads. Full Gateway configuration still loads in the background for editing and diagnostics.
- The root HTML uses `no-store`; content-hashed static assets and revision-addressed Web Bundle modules use long-lived immutable caching. The base Bundle now only re-exports the current main WebGUI entry, avoiding a second Vue, Pinia, and page-dependency download.
- The message-processing board snapshot is now v2. An expired requirement drops message bodies, attachments, and reply context while retaining a SHA-256 replay-dedupe key for up to seven days. A matching replay returns `replay_suppressed` without another Agent delivery or board event.

### Staged plan and memory loading

- The plans page now mounts the first eight summaries as soon as their title, status, current step, progress counts, attachment count, and update time arrive instead of waiting for eight complete detail requests. Later summaries continue in background batches of eight, and background completion updates count status without keeping the first-screen global progress bar active.
- Cards near the viewport request `detail=preview`, which contains only the description, current-step detail, blocker information, and attachment metadata, with at most four concurrent requests. Image, video, and Markdown attachments remain directly visible before expansion.
- Expanding a plan fetches all steps and complete approval contracts. Agent state, plan feedback, and Work history remain separate on-demand reads.

### Plan archive consistency

- Moving a completed plan to archived now clears `currentStepId`; an archived record no longer retains a current-step pointer that is valid only for in-progress or paused plans.

### Full-suite verification stability

- `npm test` now limits Node test concurrency from 8 to 4. Worker Pool and voice-transcript deadline tests no longer compete with a large batch of child processes for local resources, while the suite still retains parallel coverage instead of reporting resource contention as a product failure.

### Codex Desktop delivery receipts and task recovery

- Every Codex Desktop delivery now has a UUID `deliveryId`, and RabiRoute returns `delivered` only after the target task rollout contains that marker. If IPC accepts `steer` without a receipt, delivery retries once as `start`; a missing marker still fails explicitly instead of treating task selection or IPC acceptance as actual delivery.
- `thread-follower-start-turn` now uses Desktop protocol version `2` with the `turnStart.request + context` payload. Idle tasks no longer receive only `no-client-found` because of the obsolete payload or protocol version.
- If a bound task is confirmed deleted after the Desktop owner accepted a delivery, RabiRoute creates and persists one replacement task, redelivers the current message, and returns the replacement warning to the caller. An archived binding likewise cannot reuse a same-named task.
- The Windows Desktop lifecycle supervisor uses Manager `/meta` availability as the health signal. If the process remains present but its control plane is unresponsive, it invokes the unified launcher and records the probe error and consecutive failure count.

### Independent plugin platform and interface themes

- Manager now loads 28 independent built-in packages through one Plugin Kernel, with seven plugins providing separate Web Bundles. Built-in and out-of-tree plugins share `@rabiroute/plugin-sdk`, the strict manifest, capability graph, permission checks, revisions, generations, and effect lifecycle.
- One Profile declares only instances, package versions, configuration, and grants. The build produces `dist/plugins/packages/` from `plugins/builtin/` and removes packages that are no longer selected by the Profile in the same build. Manager loads only built output or explicitly configured out-of-tree package roots.
- WebGUI, Desktop, and Manager consume one contribution catalog. Pages, navigation, status, settings, and themes come from plugins; WebGUI no longer owns a second built-in list of business pages or settings sections.
- Removed `rabi.manager.base`, the old Profile/Patch formats, old configuration readers, the old Reconciler and Catalog, and the process-plugin host. Production runtime performs no migration from those formats and keeps no fallback loader.
- Out-of-tree plugins use the same package shape, a separate Profile, and explicit `grants`. A failed candidate generation leaves the previous revision active; a successful switch releases the preceding routes, services, listeners, and interface contributions.
- **Interface theme** is visible again on Settings. The Desktop settings contribution uses `global.settings.sections`, and startup preserves the saved theme until the asynchronous plugin theme catalog is ready, so a light or dark selection survives refresh.
- The Role Knowledge first screen now uses bounded requests: file counts come from a dedicated `/counts` endpoint, and both frontend requests and route loading fail after 12 seconds with retry.

## 0.2.1 - 2026-08-25

### Plan directories and first-page reads

- Plan runtime data now uses one directory per plan: `plans/active/<planId>/` or `plans/archive/<planId>/` holds `plan.json`, `history.jsonl`, `feedback.jsonl`, plan attachments, and feedback attachments. Archiving moves the complete directory.
- After the Manager starts HTTP service, it asynchronously checks the legacy split layout. Migration uses same-volume rename operations without reading attachment bodies, keeps legacy reads compatible, and never overwrites a conflicting target; failures are recorded in the operational log.
- On first entry, RibiWebGUI loads only the active tab's first page: at most 8 plan summaries with priority details for those 8 plans, or at most 24 memories. Later pages load only at the scroll sentinel or after Load more. A next-page cursor no longer keeps the page in a loading state.

### Verification

- 91 focused tests covering plan storage, migration, attachment routes, feedback, history, QA, pagination, and WebGUI passed.
- TypeScript checking and `npm run webgui:build` passed.

### Runtime service fixes

- RabiSpeech audio-stream events now use reverse limited reads over the current-file tail and archive index. File scans run in worker threads without holding the event-append lock, while live client snapshots remain on the event loop. Read-only capability, model, record, speaker, and microphone-device scans also run in worker threads, preventing roughly 90 MB of archived events from blocking health requests during concurrent Speech page loading.
- Performance pages now read a bounded raw cache plus 10-second, 1-minute, and 5-minute incremental aggregates. A 720-hour disk retention no longer restores or keeps every raw sample resident, and 48-hour queries no longer synchronously scan large object arrays. Page queries no longer force a flush plus a second JSONL parse, and invalid recent-log limits fall back to the default. Persistent Manager and speech event streams no longer affect HTTP P95, top-level cards use the most recently reporting Manager runtime, and WebGUI starts theme, lightweight Route status, metadata, and network-option reads concurrently.
- Windows Relay scheduled tasks no longer inherit the default 72-hour execution limit and restart after failure. Runtime-state replacement handles an existing Windows destination file and restores an orphaned backup after an interrupted replacement.

### Local speech data and Windows desktop startup boundaries

- RabiSpeech runtime configuration, temporary files, and outputs now default to `%LOCALAPPDATA%\RabiPC\RabiSpeech`, while models default to `%LOCALAPPDATA%\RabiPC\models\rabispeech`. First startup copies a legacy package-local configuration once. `RABISPEECH_DATA_ROOT`, `RABISPEECH_MODEL_ROOT`, and the existing narrower overrides can select another local location. Model downloads, the Windows speech host, and Manager now share this layout instead of binding private runtime data to a Git checkout or installer directory.
- `Start-RabiRoute-Desktop.bat` now prefers the packaged `RabiRoute-Desktop.exe` when it exists at the project root and retains the Python desktop fallback for source environments. The clipboard-screenshot default moves from the game-conflicting bare `F3` to `Ctrl+Alt+V`, and normalization migrates the legacy default automatically.
- Manager now starts the rebuildable persona-sync manifest index asynchronously after startup, so a NAS manifest walk cannot block control-plane configuration migration and availability.

### Persona work contract and proactive-review evidence boundaries

- Persona-bound AgentPackets now append a shared per-turn work contract: separate facts, inferences, unknowns, and the smallest user-owned step; advance one verifiable action; and keep external messages, device control, deletion, payment, and third-party effects behind the Action Gate. Heartbeats are explicitly not attendance checks or default project audits.
- RabiLink proactive review prefers the role-specific `prompts/rabilink-proactive-review.md` and falls back to `prompts/proactive-review.md`. A reflection turn may briefly inspect local evidence only when the role supplies a bounded tool and the user has explicitly allowed it; raw evidence must then be deleted and cannot enter memory or outbound messages.

### Windows screenshot annotations and message-processing controls

- System screenshots now support moving and resizing the selection with eight handles, rectangle and arrow marks, editable multiline text, color selection, font-size changes, and `Ctrl+Z` undo. Copy, pin, and send bake annotations into the image. Tray and screenshot tests cover annotation bounds, history, clipboard behavior, and actions queued until the image is ready.
- Message-processing `maxAgents` now defaults to `1`. Route APIs expose worker/affinity readback, cleanup of stale helper tasks scoped to the Route and workspace, and controlled limit changes.
- For formal PangHu workspaces, the Codex `Stop` Hook sends group progress only for effective progress and deduplicates by plan/progress fingerprint. Completion notification proceeds only after Outbox returns a `sentMessageId` and platform-reference readback succeeds; missing group mapping or platform receipt keeps the task incomplete.

## 0.2.0 - 2026-08-22

### WebGUI themes and hardware display checks

- Fixed dark mode surfaces that still used light card, sidebar, app-bar, input, and dialog backgrounds. Settings, Plans & Memory, Speech, Performance, User Guide, and Model Management now use shared theme tokens.
- Theme choices now preview immediately; Save persists the selected host setting.
- Windows Chrome hardware checks covered 1600×900 and 390×844, light and dark modes, major pages, Quick setup, Add Route, Model Management, locale switching, Route switching, and the mobile drawer. No page-level JavaScript error or horizontal page overflow was observed.

### Cordis plugin runtime and Manager plugin refactor

- Added exact `cordis@4.0.0-rc.8`, with all Cordis compatibility code contained under `src/runtime/`.
- `codex`, `dsh`, `copilotCli`, `marvis`, and `astrbot` register as independent Fibers in one Agent Adapter catalog. `createAgentAdapter()`, message templates, Desktop IPC, and DSH delivery remain compatible.
- Lifecycle tests cover unloading one adapter Fiber, disposing the root Context, rejecting duplicate types, and matching the built-in manifest catalog. Type parsing, Gateway configuration enums, Manager scan metadata, and Quick Setup input now read the same manifest. The declarative Contribution Registry filters navigation, settings sections, status cards, commands, tray menus, hotkeys, and themes for WebGUI/Desktop and removes entries when the owning Fiber unloads.
- Complete message endpoints and resident Gateway plugins are now separated as `MessageEndpointType` and `GatewayMessageAdapterType`. Routes containing only `speech`, `rolePanel`, `wearable`, or `remoteAgent` no longer start empty Gateway child processes. Mixed Routes pass only the Gateway subset to the resident process, while one-shot delivery still reads the full endpoint set. `disabled` remains only a legacy configuration-read sentinel. Gateway has removed placeholder factories, the compatibility creation factory, and `legacyDisposers`; WebGUI uses the same Gateway type predicate.
- Generic Webhook, FenneNote, XiaoAI, RabiLink, Heartbeat, NapCat, WeCom, Weixin, and Feishu now have Fiber-owned lifecycles. The RabiLink Fiber acquires a cancellable Relay-worker lease after listener readiness; disposal first stops HTTP acceptance and releases the port, then releases the final lease to stop SSE, task claims, attachment downloads, completion acknowledgements, and reconnects. Wearable no longer creates a Gateway Adapter or starts the shared worker, while Manager API retains health-data ownership. A real `dist/index.js` process verified RabiLink `ready -> Ctrl+C -> disabled`, `relayWorker=disabled`, and port release. FenneNote and XiaoAI reuse generic Webhook listener readiness, port-conflict rollback, connection closure, and repeated mounting; the Gateway compatibility creation branches for all three HTTP adapters have been removed. A real built process verified simultaneous FenneNote and XiaoAI `running`, followed by `disabled` and release of both ports after Ctrl+C. Feishu startup awaits HTTP listener readiness and rejects Cordis mounting on port conflicts; disposal closes active connections and the listener, prevents incomplete requests from updating status, appending messages, or triggering Forwarding, and permits same-port remounting. Missing app credentials, Verification Token, Encrypt Key, or event-subscription confirmation prevents server creation. A real built process verified `listening -> Ctrl+C -> disabled` and port release. The Gateway entry now mounts only the nine resident message adapters from the Registry.
- The resident Gateway now uses one Cordis root Context and mounts the Agent Adapter Registry, Message Adapter Registry, and Contribution Registry under that root. `src/index.ts` only dispatches invocation types. One-shot alert, replay, manual-trigger, role-panel, plan-feedback, speech, and Direct Agent Envelope commands cannot start the Message Adapter Runtime or Contribution Runtime. The reusable `RabiCordisRoot` now serves Gateway and Manager with initialization deduplication, failure retry, initialization-aware disposal, and idempotent root disposal.
- Manager Plugin Runtime and the unified Plugin/Contribution Catalog API are implemented. The presentation Contribution Catalog publishes only `page`, `navigation`, `settings-section`, `status-card`, `command`, `tray-menu`, `hotkey`, and `theme`; `host=web|desktop` filters presentation contributions only while the instance list stays complete. Manager plugin `apply` hooks register business HTTP routes in `ManagerPluginRouteRegistry`. The public catalog carries no arbitrary `target`, `endpoint`, `query`, `body`, or `resourceRoot`.
- “Everything is a plugin” includes presentation: WebGUI and Desktop are minimal hosts, while active plugins publish pages, navigation, settings sections, status cards, commands, tray menus, hotkeys, and themes through the catalog. `manager:desktop` owns Desktop settings and command entry points, and `manager:diagnostics` owns the Log Diagnostics page and navigation; catalog outages or refresh failures immediately withdraw stale contributions and system listeners while fixed recovery entries remain. Ordinary DSH plugins run as Fibers in the same Node process, while Cordis `isolate` separates service scope only; dedicated capabilities create subprocesses and Workers explicitly. RabiRoute requires unknown or high-risk third-party extensions to use a separate process.
- Manager plugin composition is now driven by `data/manager.json.managerPlugins`. The watcher reconciles changed instances only; failed reload restores the previous definition; persona, speech, and performance effects dispose with their Fibers. This update also adds reconciliation state/APIs, WebGUI SSE catalog refresh, a versioned JSON Lines isolated-process contract, capability grants, health checks, deadlines, sanitized errors, Windows process-tree cleanup, and the public `examples/data/manager.json` starter.
- Manager plugin disposal now waits for both HTTP responses and actual business Promises registered through `ManagerPluginRequestTracker.trackOperation()`. Agent send/cancel, thread operations, Gateway configuration and replay, message processing, provider control, Desktop shutdown, message-adapter scans, and Remote Agent routes all use the same drain contract. Remote Agent callbacks receive plugin-scoped cancellation and must finish; NapCat records PIDs after launch and after readiness; batch reconciliation deactivates in reverse current activation order before desired-order activation. `/manager` and every `/manager/*` path remain control-plane JSON responses.
- Migration of all 28 built-in Manager plugins is complete. The central HTTP chain is limited to LAN authentication, the read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, JSON 404 for control paths, and WebGUI HTML fallback for all other paths.
- `manager:diagnostics` independently owns `GET /meta`, `GET /api/gateways`, and the Log Diagnostics presentation entries. `manager:desktop` independently owns Desktop settings, configuration opening, Manager start, Desktop lifecycle, and shutdown routes, including delayed shutdown timers that have not run.
- Plugin route deactivation now unregisters entry points, rejects new requests, then waits for synchronous or asynchronous responses. The default drain deadline is 30 seconds, after which unfinished responses are destroyed. Unfinished Remote Agent tasks become `interrupted`. NapCat deactivation stops only instances explicitly launched and still owned by `manager:napcat-control`, never port-scan discoveries or externally started instances.
- Unregistered or deactivated Manager control paths such as `/api/*`, `/meta`, `/gateways`, and `/manager/*` now return a JSON 404 instead of falling through to the WebGUI single-page-app HTML response.
- WebGUI and Desktop resolve presentation contributions through host-owned trusted registries that can add new renderer, route, handler, and resource contracts. Unknown, unregistered, cross-plugin, or unsupported contributions fail closed.
- Page, navigation, command, menu, hotkey, and theme references must resolve within the same plugin instance and registration batch. Catalog outages or refresh failures withdraw stale contributions while recovery entries remain available. A controlled Extension Host for arbitrary third-party presentation code remains future work.

- Production Manager startup now has one initialization path: `startManager()` mounts shared resources, composes all 28 definitions with their business hooks, and then performs initial reconciliation. Definitions use `provides/requires/optional` for the capability graph; missing requirements produce `waiting_dependency`, provider revision or active-state changes restart consumers through the capability chain, and duplicate providers reject reconciliation. `PluginCatalog.refreshDeclaration()` updates the manifest and `missingCapabilities` during reload and supports `active -> waiting_dependency -> active`.
- `ManagerPluginRouteRegistry` now uses stable `routeId` values and declarative matchers. Production Manager routes use real `exact/prefix` declarations; duplicate IDs and, when methods overlap, `exact/exact`, `exact/prefix`, and `prefix/prefix` path conflicts are rejected. Manager shutdown and startup-failure cleanup explicitly run `managerPluginRuntime.unmount() -> managerSharedResourcesRuntime.unmount() -> managerCordisRoot.dispose()` so shared Workers/Persistence cannot stop first. Shared pools and coalescing persistence support stop, drain, and restart. RabiLink stop waits for the LAN listener, sockets, Relay, SSE, WebGUI, and speech drains; a second `stop()` cancels a restart queued during shutdown, and both the configuration watcher and Rabi identity PATCH await asynchronous Relay synchronization.
- WebGUI adds trusted command/renderer registries, with active contributions controlling quick setup, Route creation, configuration opening, save, settings sections, and status cards. WebGUI and Desktop contracts are bound to `pluginId + instanceId`, so cross-plugin catalog references fail closed. The `manager:desktop` settings section owns system-selection, system-screenshot, clipboard-image hotkey, and login-startup settings. Desktop uses one frozen Registry for lifecycle and panel actions and withdraws stale contributions when catalog refresh fails. Trusted Python entry points execute in the Desktop process; stronger isolation and an owner-scoped registrar belong to the future Extension Host. AstrBot now requires `ASTRBOT_SESSION_ID` and calls only `POST /api/chat/send`; the old reconciliation short path, Agent availability endpoints, playback compatibility path, AstrBot plugin fallback, and deployment entry are removed.

- Unified validation passed: `git diff --check`, TypeScript type checking, backend build, WebGUI build, and configuration checks passed; `npm test` completed 1,360 TypeScript tests (1,359 passed and 1 skipped) plus 55 script-contract tests; all 202 Desktop Python tests passed.

### DSH can own the full Primary Agent and Plan Secretary path

- DSH setup now follows **API address → workspace → session**, with existing-session selection, typed-name resolution, idempotent create on save, complete-ID binding, automatic initialization, and session-list pagination.
- A DSH Primary Agent can use Message Agents, Plan Secretaries, dedicated memory consolidation, Hook enforcement, and **only the Primary Persona may send**. Auxiliary sessions remain bound to the selected primary adapter and workspace, and DSH failures never fall back to Codex.
- The DSH `RabiRoute Agent` plugin provides thread bridge, outbound send, plan, message-processing, memory, and Agent-communication tools and sends only the unified `messageSource` contract to Manager. Real-profile repeated delivery, restart readback, and tool-owner acceptance remain pending.

### Unified Windows desktop entry

- The Windows product entry is now `Start-RabiRoute-Desktop.bat` and `RabiRoute-Desktop.exe`. The system tray, task window, and local Manager backend form one RabiRoute Desktop runtime.
- Normal startup records one desired state and supervises missing components; exiting RabiRoute Desktop stops the local backend. If desktop dependencies are missing, Windows desktop startup fails instead of presenting Manager/WebGUI alone as a complete desktop launch.

### Unified message source and message content

- Every non-empty RabiRoute handler delivery carries `messageSource`. Source types are message endpoint, Agent, plan, and system, each with its required endpoint, session, plan, event, Route, name, and complete-ID fields.
- Every final body starts with `[消息源]`, immediately followed by `[消息内容]`; event details, recent messages, collaboration rules, and response contracts follow the message content.
- Agent sources require the actual Agent endpoint (`codex`, `dsh`, `copilotCli`, and others), session name, and complete session ID. Agent-to-Agent delivery also requires `messageSource.sessionId === sourceThreadId`.
- The Agent adapter interface now accepts only a structured envelope, never a bare string. `contextBlocks` and `controlBlocks` follow message content in that order and reject nested envelope headers.
- Non-empty Agent `create` and `send` requests both verify `sourceThreadId`; the actual Codex Desktop or DSH owner name replaces stale submitted names. Manager-owned plan progress, approval, and QA events show plan identity only, while a verified plan-task return may include its source session.
- Legacy `[投递源]` wrappers, nested envelopes, and old Agent response wrappers are migrated automatically. Old replays without structured provenance are labeled `历史投递记录`; a single replay that cannot rebuild its original source uses this controlled fallback without guessing an endpoint or Agent.

### Archived Agent tasks are replaced automatically

- When the bound Primary Persona, Message Agent, or plan secretary task is archived, the next real delivery creates a new Desktop task, persists the replacement binding, and delivers to the new task. RabiRoute does not deliver into archived history or reuse another same-name task.
- Message Agents keep their slot number, affinity history, and message associations while resetting initialization for the new task. Plan secretaries update both the Route `codexPlanAssistantSessions` entry and the plan `secretaryBinding`.
- Scans, status refreshes, and input blur remain read-only and never create tasks. Real prompts still use only `RabiRoute -> Desktop IPC -> target task owner`; no fallback Runtime is introduced.

### Windows supports a system-wide selected-text menu and screenshots

- The WebGUI **Settings** page can enable **Enable selected-text menu**. Windows applications support mouse dragging and `Shift` keyboard expansion. The bar is horizontally centered on the selection, above upward drags and below downward or same-line drags. Normal applications use UI Automation; when Unity lacks that interface, guarded temporary copy input is used and the clipboard is restored. Without a system caret, the most recent click in the same window anchors the bar. Hovering over **Send to** lists every enabled and running persona, and clicking one sends the text to that Route. **Selected-text reading** is a sub-feature: when it is on, the left button reads the text after a click; when it is off, the bar keeps only **Send to**. The TTS model selector appears only when both **Selected-text reading** and **Advanced options** are on. Selection alone never reads or sends text.
- The same page can enable **System screenshot** and configure a global shortcut. Pressing it in any application opens a screenshot preview where the user can enter text, choose an active persona, and click **Send**. The image and text reuse role-panel delivery, and Codex/DSH receive real image input. Screenshots stay in the private `.rabiroute-message-images/` directory; the tray watches configuration changes, so restarting the tray is not required.

### WebGUI page labels switch immediately

- Clicking Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, Performance, or Runtime Diagnostics immediately updates the selected state, top title, and URL and shows a shared loading message.
- Page code and data load asynchronously after the switch. If an old page chunk is no longer available, WebGUI still refreshes once and restores the intended page.
- The Chinese UI no longer rescans every added subtree for translation. English DOM localization is split into batches of at most 4 ms and 200 nodes per frame, preventing large pages such as Message Adapters from creating one translation long task during mount.

### Heavy Manager requests no longer occupy the HTTP main thread

- Codex Desktop task-catalog discovery now waits at most eight seconds. A timeout stops the short-lived metadata process, returns partial discovery results, and shows a retry hint. Performance logs add `manager.agent_scan.desktop_ready` and `manager.agent_scan.codex_catalog` to distinguish Desktop connectivity from task-catalog latency.
- The process-wide low-priority heavy-read budget increases from one to two. Agent discovery remains isolated in a child process while one execution slot stays available for memory or performance reads, avoiding queue waits close to one minute.
- Heavy read tasks moved from Worker Threads to low-priority child processes. A memory-catalog scan had produced a 2866.8 ms Manager event-loop maximum; process isolation keeps heavy reads out of the HTTP process's V8 runtime and scheduling class.
- Read tasks reuse resident child processes instead of restarting a process and reloading modules for every memory read, Agent scan, or performance query. All pools share a process-wide limit of two heavy tasks; `/meta` exposes `executionMode`, `workerPids`, the shared budget, current process count, and cumulative spawn count.
- Performance aggregation, raw JSONL parsing, and response JSON serialization use a dedicated single-process pool. Identical queries share one task, only one task may wait, and saturation returns 503 with no HTTP-main-thread fallback. Manager streams performance history one record at a time during startup.
- Agent discovery moved into a dedicated bounded child process, and concurrent identical scans share one task. Codex Desktop tasks default to pages of 200; Route settings and Quick Setup can load more instead of constructing an approximately 12 MB task list at once.
- Recent and consolidated memory enumeration, Markdown/JSON parsing, lifecycle projection, and `viewedAt` writes moved into child processes. Reading one memory no longer rescans the full directory on the HTTP main thread.
- The message-processing board now returns a summary DTO and omits attachments, raw reply context, and complete evidence from list responses; the requirement-detail API still returns the complete record.
- Added stage telemetry for Agent discovery, memory Workers, message-board summaries, and RabiSpeech `/health` and `/v1/capabilities`; `/meta.agentScanWorkers` exposes discovery queue status.
- Concurrent RabiSpeech status readers now share one local probe, adjacent calls reuse a 500 ms status result, and telemetry records `manager.speech.status.shared_flight` plus `manager.speech.status.cache_hit`, avoiding duplicate timeout requests when the service is offline.

### Older group sources can restore exact send-review evidence

- When a source message falls outside the recent window, `send-context` restores only one record with the same Route and source ID from the persona's formal group history. Missing, duplicate, or conflicting Route evidence is rejected instead of returning the misleading `found 0 context records` result.
- Reference and image checks for tracked group replies use the formal source evidence bound to that approval. A stale `conversationKey` cannot rewrite the formal group; group, Route, instance, or target mismatches and unreviewed image attachments still fail closed. Ordinary untracked sends do not use this recovery.

### Manager recovery safely resumes confirmed-missing sends and task creation

- An absent managed-send receipt now returns `missing` instead of being mislabeled `uncertain`. With the original `deliveryId` and an unchanged payload, Manager retries once only when the same Route's Outbox authoritatively contains neither a request nor a terminal record. An existing request, a different payload digest, or another non-terminal retry remains non-replayable.
- A Codex task creation reservation stuck in `creating` for more than five minutes may move through `failed_before_create` and retry only when it has no `threadId` and a second `state_db` lookup finds no task with the same name and workspace. An existing `threadId` or insufficient lookup evidence becomes `uncertain` and cannot create a duplicate.

### Incomplete plan feedback resumes after Manager recovery

- After startup, Manager scans `pending/failed` plan guidance and approvals and reads the original bound task by stable `feedbackId`. Accepted feedback only receives its missing delivery receipt; active tasks and failed readbacks wait; confirmed-missing feedback is replayed once during the current Manager process, avoiding both permanent interruption loss and blind duplicate sends.
- Business tasks now write results with stable ID `response-<feedbackId>`, and recovery recognizes that result before reading Desktop history. If Desktop accepted a turn but the IPC response timed out, Manager briefly continues readback; an active turn remains `pending` instead of being immediately marked failed or replayed.

### RabiSpeech startup failures are actionable

- Manager now launches RabiSpeech through `scripts/start.ps1`, keeping Python, private dependencies, and NVIDIA DLL paths consistent with manual startup. `/health` now performs only fast readiness detection, so model discovery and warm-up no longer make an online service appear to have timed out.
- The Speech Service page renders separate cause and recovery lines. Missing dependencies, port 8781 conflicts, configuration errors, and readiness timeouts receive matching actions, while only a sanitized startup-log tail is returned.

### Work-group issues support managed registration

- XinghaiBuilder's managed issue registration now accepts work-group issues with a verified quoted claim. It restricts the source to the configured work group `<WORK_GROUP_ID>`, verifies the source message and a matching claim receipt with `status=sent` plus `sentMessageId`, enforces unique plan/task bindings, two deduplication passes, and three-way workspace agreement, and idempotently produces a `governanceVersion=3` mapping. Tencent Sheet and direct user-request registration semantics are unchanged.
- A legacy unified-Outbox claim that was really sent but missed the dedicated receipt ledger can now be recovered only after the local outbound record and the live NapCat reply segment agree. Forged input, one-sided logs, and non-sent records remain rejected, and recovery does not resend the group message.
- Work-group `begin` no longer limits business-task types to a fixed legacy list. Structurally valid formal tasks such as `[PangHu][只读调查] ...` are validated through full task ID, workspace, plan binding, and registration mapping, while Plan Secretary titles and unstructured impersonation remain rejected.

### PangHu Main development no longer waits for an exclusive Unity workstation

- PangHu plans no longer freeze because the formal Main Unity Editor is open, importing, temporarily unavailable through MCP, or using a shared test queue. The original business task continues implementation, narrow SVN work, static asset and serialization contracts, non-Unity runners, and CLI validation; remaining GameView or interaction checks become human or later runtime acceptance.
- Plan orchestration, Plan Secretary, closure Skills, completion-message templates, and the PangHu package/QA contract now use the same rule. The Editor and another task's tests remain undisturbed, while unrelated full-suite failures are recorded without blocking matched validation or feature development.

### Package and QA use a four-stage delivery lifecycle

- Non-terminal plans expose only green `In progress`, blue `Awaiting package`, purple `Awaiting QA`, gray `Paused`, red `Awaiting approval`, and orange `Awaiting manual verification`. External decisions, permissions, information, assets, accounts, devices, owners, and receipts remain internal gap details; `manual-verify-*` appears only after development closure when a visual or interaction check remains.
- Awaiting package reads revisions, applicability, matching-test results, submission, and conflict-free readback from the plan's completed delivery steps. A later delivery-verification step does not return a plan to In progress when those five requirements are complete and only package identity or inclusion proof is missing; a missing requirement continues the original task.
- QA sending and `sentMessageId` no longer create a `package complete, send QA` main stage. Inside green QA, a missing receipt selects `send_qa_request`; a real receipt with only the verdict outstanding selects `wait_for_qa_result`. Strict audit rejects contradictory structured steps and wait text.
- QA feedback is consumed only for a structured QA step when a user or external source states an explicit QA verdict. Guidance responses, approval responses, Agent-reported test counts, and bare `passed / verified` prose cannot complete a plan.

### Plan lists support combined status and tag filters

- Status, importance, and urgency sorting now compare Manager-projected integer levels, while update-time sorting continues to compare timestamps. Importance and urgency use `0–4`; labels and colors are mapped separately. Legacy `priority` and `dueAt` remain read compatibility inputs. Highest importance now precedes high, medium, low, and unset plans.
- Removed the duplicate leading status badge from plan-directory rows. Each row now keeps exactly one trailing label for the active sort mode: status, relative update time, importance, or urgency, with distinct colors for different levels.
- **List sorting and filters** now uses extensible groups. In addition to presentation statuses, users can search and select plan `keywords` tags. Values within each group use OR matching, while plans must match both groups.
- The trigger and result summary show the active filter count, with per-group clear actions and **Clear filters**. **Done** still sends the draft to Manager, which applies it before pagination so the directory and cards share one result.
- Narrow screens stack the groups into one column. Checkboxes, close controls, and actions keep at least 44px targets with visible keyboard focus.

### Delivery prompts and language-style risk control

- Default workspace policy, proactive communication, Agent reply contracts, Message Agent initialization, and Plan Secretary notices now use compact wording. Repeated explanations moved to documentation or Skills. Current persona templates were shortened while preserving project ownership, task binding, attachment review, delivery exit, and receipt boundaries.
- Personas may bind a target language-style Skill through `languageStyle.styleSkillUrl`. `/api/agent/send` defaults to `styleValidation=1`; failures return reasons before Outbox, and the same `deliveryId` may be confirmed with `styleValidation=0`.
- Added `POST /api/language-style/validate`. The Codex language-style Hook uses the same endpoint and reports only failed checks without rewriting or blocking output.

### Codex Hook plugins remain independent

- `rabi-codex-context` Hook commands load scripts only from their own `PLUGIN_ROOT`. A regression test now forbids references or writes to `.codex`, `.agents`, `config.toml`, `marketplace.json`, or another plugin, so an independent language-style Hook can register the same lifecycle events alongside RabiRoute.

### Outbound messages are attributable to an Agent session

- `/api/agent/send` now requires `sender.agentType` and `sender.sessionId` for every message channel. Completed results and idempotency receipts retain both fields, and requests missing either field are rejected before Outbox.
- In addition to receipt lookup by `deliveryId`, maintainers can use `GET /api/agent/send/traces?channel=...&sentMessageId=...` to trace a real QQ, WeCom, speech, or other endpoint receipt back to the calling Agent type and complete session ID. Older receipts do not contain these fields and cannot be retroactively attributed.
- With Codex Message Agent mode enabled, an inbound QQ group message that quotes an Agent-sent message traces the send session by endpoint, platform message ID, and Route, then gives the matching complete session ID in the pool the largest single scheduling preference. The final choice still ranks all affinity scores; an older receipt, no matching task, or a lookup failure only removes this preference and does not block delivery.
- Every NapCat group send must explicitly include `params.replyToMessageId`. Agents should use the real source ID when one is available, or the empty string `""` for an intentional unquoted message. Omitting the field returns an actionable pre-send error that explains both choices.
- Message-processing replies now use `GET/POST /api/message-processing/requirements/:id/send-context`. The Agent submits its reply decision first, then reviews the latest bidirectional messages, prior Agent replies, and the complete source chain. Manager binds a two-minute approval to the context version, sending session, destination, and payload. A new group message, another Agent reply, a changed requirement state, or changed request is rejected; Primary Persona and other Agents cannot bypass the gate with an untracked source quote.
- NapCat now downloads inbound QQ images into the runtime directory immediately and passes each local file to Codex Desktop as a `localImage`. A failed download remains unavailable evidence; a Message Agent may retry or hand off but cannot guess from text and reply without inspecting the image.
- Message-processing requirements now include `sourceEvidenceReview`. Outcomes must cover the current source message, recursive reply chain, and every attachment with an actual observation. The nearest five-minute discussion fragment stays adjacent to the current message so another participant's correction of the Agent's prior reply is not separated from the current issue.
- Ordinary AgentPacket delivery now presents `[Recent messages]` before the current `[Message]`; focused discussion, immediately addressed context, and reply parsing remain adjacent to the current message. `heartbeat` and `plan_feedback` still omit recent messages.
- When a quoted NapCat group message contains images, `/api/agent/send` now requires `params.replyImageDescriptions` with one concrete content-and-meaning description per image in original order. A missing source, unreadable image, count mismatch, empty description, or generic `reviewed` response is rejected before an idempotency reservation and does not create a failed-send receipt.
- After the real QQ send succeeds, RabiRoute creates or appends a same-name `.md` beside every `napcat-media` image. It records the source message, image position, Agent type, complete session ID, `deliveryId`, QQ receipt ID, and description. The send result returns archive mappings without copying description text into operational trace lookups.

### Removed the duplicate Console introduction card

- The Console no longer starts with a large card that repeats the current Route, runtime state, and message inputs. It now opens directly on the status summary. Quick setup remains in the sidebar, Route restart remains in the Route list and Log diagnostics, and action failures appear inside the Route list.

### Four Plans & Memory categories

- The Plans & Memory page now has four tabs: Current Plans, Recent Memory, Consolidated Memory, and Archived. Source memories that completed consolidation no longer count as recent and appear under Archived with archived plans, while stable recallable outputs have their own Consolidated Memory tab.
- Manager memory paging and counts now expose an `archived` category. Existing source files need no migration because their current `consolidatedAt` field defines archive membership.

### Persona automation and scheduled scripts

- Persona configuration now uses generic `automationRules`: triggers are message arrival or a schedule, and actions are Agent delivery or script execution. Legacy `notificationRules` and nested heartbeat schedules migrate on read and use the new structure after saving.
- Schedules support fixed intervals, daily times, and one-off date-times. Message-triggered scripts reuse existing route-kind, regex, group, and speaker matching. Agent delivery and script execution keep separate results.
- Local scripts are disabled by default and restricted to `.cmd`, `.bat`, and `.py` files inside the current persona's `scripts/` directory. Path escape, link escape, and arbitrary command text are rejected. Scripts do not inherit Manager tokens, passwords, or message bodies, and the same rule cannot overlap on the same Route.
- The Persona page replaces the old message-template list with **When a message arrives / Scheduled tasks** tabs, groups message rules by source, and shows fields dynamically for the selected trigger and action. It reports disabled inputs, missing script permission, invalid regex, and missing schedule values inline.

### Identity positioning and conversation-situation context (experimental)

- A persona can now maintain participants, endpoint-account mappings, and relation cards scoped to specific conversations or projects by the exact key `platform + endpoint identity namespace + stable sender ID`. Candidate relations are not treated as confirmed facts, and concurrent sync branches remain conflicted until an explicit review supersedes them.
- The Persona page projects this data into **Recognized identities / Unrecognized identities**. A company QA or other shared account may appear for several recognized people with a **Shared** marker. Who may use the account and who wrote one particular message remain separate conclusions, so an account nickname no longer needs a fictional person record.
- A recognized person now uses the whole card to open one identity workspace. Basic details, endpoint accounts, speaking habits, and relations are viewed and edited in the same interface without a three-dot dropdown or long-term versus short-term relation types. Accounts and relations still save separately, so a partial success is not presented as one successful all-at-once update.
- Ordinary delivery can inject confirmed people, possible users of a shared account, and a conversation-situation assessment without chat text. Reply chains, task continuity, explicit self-identification, and speaking-habit consistency may support per-message attribution, but they cannot confirm identity alone, overwrite the shared-account relationship, or grant project authority.
- When a trusted endpoint supplies a stable sender or voiceprint identifier and the message actually matches a Route, the persona automatically creates a reusable **getting to know** candidate. Deferred review retains those endpoint clues. Client claims, forwarded or quoted content, and inputs without a stable account identifier continue to fail closed. Unit and Manager API integration tests cover exact identity keys, shared accounts, candidate/confirmed/corrected states, voice compatibility synchronization, malformed-record recovery, and AgentPacket injection. Human conflict review across synchronized peers and long-running acceptance remain pending.

### One explicit API for Agent outbound messages

- Removed legacy `POST /api/agent/replies`. Agents can only call `POST /api/agent/send` and must provide a stable `deliveryId`, exact `routeId`, `channel`, channel-specific `params`, and `payload`; source `replyContext` no longer selects the destination.
- The explicit channel overrides the Route's default pipeline. A `channel=napcat` request cannot be redirected to TTS by Route configuration; QQ, WeCom, RabiLink, speech, and other channels validate their own target parameters.
- The Message Processing board closes a send requirement only when the sent channel matches the source endpoint, the result is `sent`, and platforms such as QQ return a real platform identifier. Successful TTS synthesis cannot impersonate a QQ send.
- Durable idempotency receipts now use `data/agent-send-idempotency/` and `GET /api/agent/send/receipts/:deliveryId`; uncertain results for the same ID still fail closed and are never auto-resent.

### Persona-private Bilibili history shards

- Bilibili history jobs now require a `roleId`, and item records inside the requested window are written only to that persona's `runtime/bilibili-history/daily/YYYY-MM-DD.jsonl`. Date files are physical shards of private facts, not archives, consolidated memory, or expiry. Stable IDs, atomic writes, a rebuildable index, and per-job deduplication keep page retries from duplicating records.
- Read-only day-index queries scan shards in memory and do not write during GET or Manager read-only acceptance. Active legacy jobs without a `roleId` pause with recovery guidance instead of remaining permanently runnable.

### Mobile hot-speech delivery now requires Manager-owned device trust

- RabiLink mobile audio is now persisted by RabiSpeech before Manager delivery. Manager issues `speech_runtime_record_binding` trust evidence only when the submitted record ID, text, stable device ID, transient stream ID, and adapter type all match that persisted ASR record, and it replaces caller-provided recognition and speaker segments with the recorded evidence. Knowing an online device ID, forging trust metadata, or rewriting recognition segments cannot prove the current utterance; missing records, verification failures, and speech-runtime failures remain fail-closed.
- When Manager starts read-only, the Bilibili history bridge now pauses legacy active jobs without a `roleId` only in memory and no longer writes that compatibility migration back to runtime state.
- Android continuous capture remains privacy-sensitive. PCM RMS diagnostics are limited to debug builds and one sample every five seconds so release builds do not expose a continuous speech-activity signal or flood Logcat.

### RabiLink resident interaction and model selection

- Android foreground and message notifications use the active persona name, and the resident listening notification can request an immediate conversation review. Phone/glasses connection wording, notification channels, and recovery cues were aligned. Quick setup can select or enter the Primary Persona model, and the Rokid AIUI configuration assistant uses that selected model.
- Tray startup and one-shot health checks allow longer Manager cold-start probes to avoid false failures on NAS or cold caches. The hidden-window wrapper still runs only the fixed local health-check command.

### Manager-owned Primary Persona model settings

- Route configuration now includes Primary Persona reasoning effort, and the existing Primary Persona model setting is applied to new Codex Desktop turns. WebGUI edits both values in the Codex Agent section. They affect only the Primary Persona and do not override Message Agents, Plan Secretaries, or independently bound Plan Agents.
- Fixed an explicitly started Route continuing to deliver through its stale Gateway child after a task-binding save while `RABIROUTE_MANAGER_AUTOSTART=0`. Disabling autostart now prevents stopped Routes from being launched automatically, while a changed running Route still restarts with the new full task ID, model, and reasoning effort; disabling a running Route also stops it for real.

### Lower Manager load on Plans & Memory

- Plan-directory status and relative-time labels now stay fixed on both sides; only an overflowing title moves at a constant speed on hover or keyboard focus, and the directory no longer causes page-wide horizontal scrolling. The result count sits beside the directory title, while an independent **List sorting and filters** dialog occupies the top-right action. Only **Done** sends status/time ordering and status filters to Manager, then immediately reloads the complete plan list so directory and cards share one result.
- After all plan summaries load, WebGUI asynchronously batches the real Codex Desktop state for each bound Task Agent and optional Plan Secretary without blocking the first screen or repeating a plan in the same pass. A working Task Agent replaces directory time with a spinner; idle, timeout, failure, and missing-task results preserve time. Expanded details show Agent work state and task state, use Unknown when the three-second budget expires, and can locate an exact valid non-working binding in Codex without sending a message or creating a replacement task.
- Fixed Recent Memory reaching zero without starting consolidation. Manager now arms a one-shot task for the earliest 72-hour deadline, reevaluates activity at that time, freezes the batch's 24-hour candidate range, and delivers it automatically. `memory-consolidation` is a Manager-owned event and does not require a persona notification rule. Accepted runs record `deliveredAt`, are not redelivered after a Manager restart, and the UI shows that consolidation is in progress.

- Recent Memory cards now separate recorded time from the last true recall hit. Manager dynamically caches the next 72-hour trigger item and a `willEnterNextConsolidation` candidate boolean from each memory's update/recall time. During the final 24 hours, WebGUI shows a separate countdown panel, the least-active memory, the candidate count, and card markers. A direct ID read no longer counts as a recall hit that postpones consolidation.
- A consolidation cohort is now frozen at the least-active memory's original 72-hour trigger. The run includes only memories already beyond 24 hours at that instant; delayed execution does not append items that crossed the boundary later. Runs persist the trigger memory, original trigger time, and candidate cutoff, while UI markers and the real request share the same Manager algorithm.
- New recent and consolidated memory files use Markdown bodies with structured frontmatter; legacy JSON remains readable, and Markdown wins without duplicate counts for the same ID. WebGUI renders mixed text/images while allowing only HTTP(S) images and blocking local absolute paths and dangerous protocols.
- Codex Agent settings now include a **Dedicated Memory Consolidation Agent** switch. When enabled, automatic-deadline or manual memory consolidation goes only to the persistent Desktop task `<Primary Persona task name> 记忆整理`, defaulting to `gpt-5.6-terra`; failures do not fall back to the Primary Persona or another Runtime.
- Each memory card is capped at 512px. Overflowing body content is clipped without an internal card scrollbar, and **View details** opens the complete memory.
- Fixed Recent Memory showing `0` when Plans & Memory was opened directly. A lightweight count request now runs in parallel with the first plan screen without preloading memory bodies or requiring a tab switch.
- The recent-memory consolidation panel now shows the explicit time remaining in hours and minutes. Once due, it shows `0 min` and `trigger time reached` instead of only a generic due-state message.
- RibiWebGUI now orders its top tabs as **Current Plans / Recent Memory / Archived**. Current Plans shows the non-archived plan category instead of repeating recent memory below it; Archived continues to combine archived plans and consolidated memory.
- The plans page requests only eight summaries for the first screen, then completes the current result in visible-tab background pages of up to 50. Manager applies category, search, ordering, and filters before pagination; the browser does not maintain a second list policy.
- Recent and consolidated memory now use separate pages with at most 24 visible-category items on the first screen. Unchanged presented-plan catalogs and parsed memory directories are reused until their source files change.
- A hidden browser tab stops further loading and closes that page's Manager event connection. It performs one catch-up read when visible again, preventing duplicate knowledge tabs from continually multiplying disk reads, rendering work, and event connections.
- Persona Sync no longer writes another timestamped evidence copy every time automatic reconciliation rediscovers the same unresolved conflict. It reuses evidence when persona, path, peer, remote content, deletion state, and base hash are unchanged, while different identities or hashes remain separate conflicts. Conflict listing now builds and caches a persona-scoped catalog asynchronously, shows one representative for legacy timestamp copies, and no longer monopolizes Manager while traversing a million-file directory. One explicit resolution archives the duplicate evidence group without deleting evidence.

### Windows packages no longer include speech runtime by default

- Windows installers and portable packages now contain only the components required for the RabiRoute desktop by default. They do not build or copy the RabiSpeech Windows runtime and do not install ASR/TTS Python dependencies or models.
- Speech-plugin scripts remain available in the package. Users explicitly run `scripts\install.ps1` and select models only when speech is needed; maintainers may use `build-windows-release.ps1 -IncludeSpeech` for a package that includes the speech process host.
- RibiWebGUI now has a host-scoped **Model Management** page. It can list allowlisted TTS, ASR, and speaker models even when RabiSpeech is not installed or running, prepare the private speech environment, and download one weight set at a time.
- Downloads accept only fixed aliases from the repository `model-catalog.json`, serialize jobs, and update the page through Manager events. The UI distinguishes downloaded weights from isolated-runtime or real-inference validation; licensed ONNX-VITS packages remain manual imports.
- **Model Management** now opens on demand from a top-right button on Speech Service instead of occupying a separate sidebar page. The legacy `/#/models` address still redirects to Speech Service; installation and download APIs are unchanged.
- Fixed a long-open browser tab remaining on the previous page when **Speech Service** was selected after a WebGUI rebuild. If the old page chunk no longer exists, the UI preserves the selected address and reloads once. A session-scoped guard prevents reload loops, and ordinary speech-status errors do not trigger this recovery.

### Critical project-fact recording

- Message requirements now identify possible schedule, scope, approval, ownership, and release facts. A Message Agent cannot reply or close quietly until it supplies a typed plan, memory, or project-document reference together with verification evidence and time.
- Manager reads the referenced record and verifies that it contains an original source message ID. Project documents accept only current-project relative paths; absolute paths, parent traversal, and filesystem-link escapes fail closed.
- Sanitized regression cases cover internal target dates without publishing real group IDs, message IDs, chat text, or project schedules.

### Path, directory, and module boundaries

- Added bilingual path and directory conventions for `src/` software modules, public `examples/data/`, private `data/`, internal `data/.runtime/`, import staging, and `logs/manager/` operational logs.
- Internal interfaces now distinguish `routeDataDir` from `personaDataDir`; legacy `dataDir` is read only at the configuration compatibility boundary.
- Message-processing code now lives under `src/messageProcessing/`, and Manager operational logging lives at `src/manager/operationalLog.ts`. The message state machine is separate from JSON persistence, while `projectDirectoryLayout.ts` and `pathPolicy.ts` own fixed locations and constrained relative paths.
- Ordinary project-path conversion no longer guesses a previous workspace. Only explicit legacy-persistence reads perform compatibility migration. Public tests and interface examples use placeholder personas, message IDs, conversation IDs, and fictional dates.

### Shared NapCat HTTP endpoints

- Fixed configuration saves moving later Routes from a shared, live OneBot HTTP endpoint to the next unbound port. That drift made both referenced lookups and proactive Outbox group sends fail with `fetch failed`. Port conflict assignment now applies only to listeners owned by RabiRoute; an explicitly configured NapCat HTTP URL remains unchanged. Referenced replies and proactive sends keep the existing Outbox contract without guessed ports, automatic replay, or idempotency bypasses.

### Message-group and Message Agent configuration, phase one

- Fixed plan-progress notifications, plan/memory callback reminders, and pending Agent-to-Agent replies continuing to target an old Message Agent task after **Message Agent mode** was disabled, which made Codex Desktop switch tasks automatically. New chat messages and those unfinished follow-ups now go to the current Route's Primary Persona. Existing tasks and audit records remain but are no longer opened by these deliveries. If the Primary Persona is not Codex or lacks a complete task binding, delivery fails closed instead of silently selecting another task.
- Codex **Plan assistant tasks** now have a separate enable switch like **Message Agent mode**. Turning it off stops secretary handoff and automatic secretary-model selection while retaining the bound Desktop tasks for reuse. Manager now owns one shared `codexPlanAssistantModel`, defaulting to `gpt-5.6-terra`, instead of persisting a model per secretary. Existing bindings and legacy per-task models migrate on read, and WebGUI verifies that the running Manager preserves both the switch and shared model after save.
- With Plan Secretary enabled, Manager persists a separate `secretaryBinding` for every plan. WebGUI guidance/approval still reaches the business `taskBinding`, while the responsible Secretary simultaneously receives the control notice. Business-task Stop Hooks, ordinary progress, and state changes also go to the Secretary first instead of waking the Primary Persona by default. The Secretary escalates only decisions, approval, authorization, missing user input, cross-plan conflicts, complete closure, or safety-reviewed outbound communication. The original Primary Persona fallback remains when no usable Secretary is available so notifications are not lost.
- QQ, personal Weixin, Feishu, WeCom, role-panel, and RabiLink text chats now use message groups automatically without a per-endpoint switch. Endpoint cards retain only normal-pause, incomplete-sentence, and maximum-wait values. ASR/voice transcripts, heartbeat, commands, approvals, health alerts, and structured events continue direct delivery without added waiting.
- **Message Agent mode**, **Plan assistant tasks**, and **Hook management** are now handler capability declarations. Codex is currently the only handler that supports and displays them. Non-Codex Routes discard these accidental settings; future equivalent handlers may opt into individual features, while platforms with their own Agent orchestration do not inherit them.
- With Codex Message Agent mode enabled, heartbeat goes immediately to an independent Message Agent without conversational settling or recent chat history and is no longer affected by **Skip heartbeat while task is busy**. That switch is shown only while Message Agent mode is off. After save, WebGUI verifies that Manager preserved the new field and explicitly asks for a Manager restart if an older process drops it.
- Fixed **Trigger now** keeping its button busy until the Agent delivery finished. Manager now follows the existing background-delivery contract used by plan guidance and approval: it returns `202` as soon as the request is accepted, while the adapter log records the final success or failure. A repeated request for the same Route and rule reports the active delivery instead of spawning a second process. Message Agent Manager lookups now use a one-shot HTTP connection and wait for that connection to close, preventing Windows delivery children from asserting during post-success cleanup and being logged as failed.
- First-time Message Agent task resolution now filters the Codex app-server state index by its system-generated stable name instead of paging through the complete Desktop task catalog. Deliveries with an exact task ID remain direct, while ordinary task binding keeps complete lookup and retains its duplicate-name, workspace, and archive checks.
- Message Agent tasks now use the persona name as their stable prefix and follow the same convention as plan-assistant tasks: one task is named `<persona name> 协助处理消息`, while multiple tasks use `<persona name> 协助处理消息1, 2...`. Pool expansion and legacy-title migration rename the same complete Desktop task IDs without creating replacements or changing workspace.
- New Codex Message Agent turns default to `gpt-5.6-luna` with `medium` reasoning through the single Desktop IPC delivery path. Models used by Primary Persona, Secretary, and Plan Agents remain unchanged.
- Connected delayed fragment batching, immediate recording, recoverable queues, duplicate protection, dynamic Codex Message Agent creation, and affinity reuse. Explicit replies prefer the Agent retaining the original source message ID. When a familiar Agent is busy, a new Agent first receives its task ID and current preview before deciding to transfer or process independently. Message Agent turns use `gpt-5.6-luna` / `medium` without changing Primary, Secretary, or Plan Agent models. The four-Agent return contract is injected; live group/DM and complete four-Agent acceptance remain pending.
- Message Agent allocation now uses affinity first, any idle task as the fallback, and creates a task only when every existing worker is unavailable. Allocation, reservation, and creation are serialized, while persisted workers are merged by complete task ID. Concurrent messages can no longer register one task repeatedly or expand past an idle task merely because it has not handled the current group before.
- Message Agent, Plan Secretary, Plan Agent, and Primary Persona handoffs now share one visibility contract: Codex final text in a child task is internal only. Content that a group member, private-chat peer, or responsible person must see has to enter Outbox or the source-verified Manager thread bridge and obtain a receipt. Approval questions, reply drafts, and progress reports may no longer stop in a child task's final output.
- Heartbeat no longer forwards the complete scheduled inspection to the Primary Persona. The independent Message Agent first compares cursor-bounded group messages with plan summaries, issue mappings, business-task bindings, and the last delivery receipt, then sends concrete omissions to the Secretary or original Plan Agent. Only real progress since the previous group report, a concrete decision request, or a cross-plan conflict reaches the Primary Persona as send-ready content. No change stays quiet, and `waitingFor` follow-up runs only when due, when new evidence appears, or after a failed send.
- Codex Agent tasks now carry source identity when they send through Manager: the sender supplies its own complete task ID and responsibility type, Manager resolves the real Desktop task name, and the receiver sees the source Agent, task, session ID, and workspace above the delivered content. Unverifiable, mismatched, or archived sources fail closed. Ordinary external messages, initialization turns, and system notices keep their existing delivery path.
- Agent-to-Agent delivery keeps the existing `POST /api/agent/threads` request and adds no dedicated endpoint or CLI. `send` now returns the Desktop owner's actual `started/steered` acceptance. Missing parameters, source-verification failures, and unavailable targets report the field, reason, and retry guidance in the same response. If the target accepted the message but board tracking failed, the response is explicitly `delivered_tracking_failed`, and callers must not resend the same content.
- Agent-to-Agent sends must now provide `responsePolicy=required|none`; required responses also need `responseInstruction`. After the target owner accepts, Manager persists a `requestId`. A formal response uses the same API with `inReplyToRequestId`, `result`, and `nextAction`, and declares whether the other side must respond again. Ordinary Codex final text is not a return. If a target turn ends without the formal response, Manager reminds that exact task five minutes later and repeats the check after later unanswered turns. WebGUI's Codex Hook panel adds a per-Route **Require the RabiAgent message delivery API** switch, enabled by default and inherited by the Primary Persona, Plan Agents, Plan Secretaries, and Message Agents. When enabled, `PreToolUse` denies persistent Codex task delivery that bypasses Rabi.
- Fixed Agent-to-Agent provenance showing the first initialization prompt as the source task name. Manager still verifies the source against the complete task ID and Desktop state, then overlays the current sidebar name from the session index instead of trusting SQLite's first-message title. Message Agent initialization also resolves the Primary Persona's current name by complete ID rather than retaining a stale Route display name. Existing Primary bindings update only the display name; task ID and workspace remain unchanged.
- Codex task-name reads now converge in `codexDesktopBridge.ts`: complete ID plus workspace is the sole identity, and the Desktop left sidebar is the sole display-name source. The Agent thread bridge, Message Agents, heartbeat, and Agent-to-Agent templates no longer read or override separate task-name copies; SQLite first-message titles and Route-cached names are internal state or no-ID bootstrap hints only.
- Fixed Message Agents forwarding their complete initialized input as “the full message group,” which could make the Primary Persona receive role-overriding text such as “you are not the Primary Persona.” Continuation and Primary handoffs must now be newly composed minimal bodies; Manager rejects Agent handoffs containing role-initialization markers or targeting the source task itself, and the pool refuses to register the Primary Persona task ID as a Message Agent.
- Fixed heartbeat creating one new Message Agent task whenever the previous worker was reported busy. Heartbeat now always reuses the most recent heartbeat worker and steers later ticks into that task even while its prior turn is active; ordinary chat can still expand dynamically for distinct message groups and topics.

### Persona directory and cross-persona messaging

- Manager now exposes `GET /api/personas`, a single-persona query, cross-persona delivery, and delivery receipts. Agents can discover personas reachable through enabled Routes before delivering to one. Each send must carry the capability injected into the current AgentPacket. It is bound to both Route and persona, so changing only `sourceRouteId` cannot impersonate another sender.
- Cross-persona requests require a stable `deliveryId`: the same ID and payload execute once and reuse a durable receipt, changed content conflicts, and uncertain work is not replayed automatically. Both Routes must be enabled, multiple eligible target Routes require an explicit selection, and self-delivery or more than eight hops is rejected.
- The local role panel and cross-persona endpoint now share one delivery service. `sent` is recorded only after handler acceptance; rejection records `failed`, so the legacy endpoint no longer writes a false success first. Persona directory and Route summary now share title parsing and caching instead of scanning and applying separate fallback rules.
- Cross-persona contact is one-way: an ordinary target reply does not return automatically and must explicitly POST back with the same conversation ID, a reply reference, and an incremented hop. User-facing and Agent-facing copy consistently uses “persona,” while `roleId`, `/api/roles/*`, and `data/roles/` remain compatibility internals. Related bilingual product, configuration, architecture, interface, context, user-guide, and persona-skill documentation is synchronized. Automated contracts pass; real two-persona Desktop acceptance remains pending.

### Windows Manager and tray lifecycle pairing

- Full desktop startup now has one lightweight supervisor and an atomic `running / stopped` intent. After consecutive confirmation that either Manager or tray is missing, supervision reuses the existing port-owner, PID, and single-instance gates to restore the pair. A transient Manager outage leaves the tray running and reconnecting instead of making it exit.
- `Exit RabiRoute` persists `stopped` before shutting down Manager and tray, so fail-closed supervision cannot resurrect an intentional exit. Ordinary Manager reloads preserve the desktop-running intent. Source and packaged startup, regression tests, bilingual launch/troubleshooting guidance, and supervisor log contracts are synchronized.
- Fixed an intermittent tray report that Manager was offline after long-running tasks. The previous Codex busy check repeatedly loaded the complete task rollout; once the file grew to hundreds of megabytes, Manager could temporarily consume large amounts of memory and stop responding. The check now reads backward in chunks from the file tail and loads only the latest-turn data it needs.
- Fixed Manager reporting `active=true` for tasks already completed or idle in Codex Desktop. Manager now timestamp-merges connection-scoped IPC activity with the latest rollout lifecycle event: a newer completion, abort, or failure supersedes an old marker, a genuinely newer IPC start remains active past an older terminal, and IPC disconnect clears the connection's temporary markers.

### README first-reading path

- Reordered both README languages around use cases, first delivery, system flow, current capability, boundaries, and deeper guides while preserving the hero, Slogan, and message-gateway / policy-router / action-gate identity.
- Quick start now states a verifiable first-success signal. LAN, speech, and complex runtime details move to focused guides. The compact capability table separates verified and experimental paths and names the approval, preview, and device closures that are not complete.
- This is a public-documentation-only change. It does not alter code, configuration schemas, runtime behavior, or local `data/`, so no runtime migration is required.

### Complete Quick setup localization in WebGUI

- Completed the English mappings for message-input notes, Heartbeat and Remote Agent guidance, Agent-binding fields, dynamic states, and persona review across the three-step Quick setup wizard. A dedicated i18n regression test now guards against untranslated Chinese leaking back into the English interface.

### Persona Sync runtime isolation

- Persona Sync scanning, recursive watching, explicit change notifications, reads, merges, and Coordinator transport now share exclusions for work-cycle history/input/lock directories and temporary files. Even an older peer advertising those paths cannot cause cross-PC transfer or deletion propagation; real persona, plan, and memory content continues to synchronize.
- Windows sometimes reports only that a directory changed, or omits the changed path entirely. The previous handler rescanned one or every persona, so even a heartbeat state write could keep Manager busy for tens of seconds. Known directories now reconcile only their subtree and still detect deletions. An unknown path stops unreliable automatic watching and reports query-time reconciliation instead of repeatedly stalling Manager.

### Pull request submission security gates

- Pull requests targeting `main` now run parallel security gates: Gitleaks checks commit history for suspected secrets, `npm audit --omit=dev --audit-level=high` blocks High or Critical production dependency vulnerabilities, and CodeQL performs lightweight JavaScript / TypeScript static security analysis.
- The workflow uses a least-privilege `GITHUB_TOKEN`, the `pull_request` event instead of `pull_request_target`, non-persistent checkout credentials, and full commit-SHA pins for every external action. The PR security workflow neither installs dependencies nor executes contributor-branch build or install scripts.
- A bilingual maintainer guide now states that real credentials must be rotated, CI never auto-fixes dependencies, false-positive handling must stay narrowly scoped, and all three checks must still be marked required in the GitHub ruleset after the workflow is deployed.
- Pre-submission dependency review pins the development toolchain's `brace-expansion`, `esbuild`, `postcss`, and related `nanoid` packages to fixed releases. Both the production-only and full `npm audit` now report zero vulnerabilities, without running an automatic fix or install scripts.

### Durable Agent-reply idempotency receipts and controlled ordinary inquiries

- `/api/agent/replies` now accepts an optional stable `deliveryId`. Manager persists a reservation before Outbox delivery. Duplicate clicks, concurrent calls, lost responses, and process restarts for the same ID/payload execute once and read back the original result; changed payloads conflict, and uncertain sends are never auto-replayed.
- When `turn/completed` omits items, the Remote Agent bridge recovers the final Agent message from `item/completed` notifications for the same turn. Remote tasks can therefore retain final-reply evidence without relying on an additional callback network path.
- Added `GET /api/agent/replies/receipts/:deliveryId`. After a POST timeout or empty response, callers query the original receipt first. Delivery may be marked only after `status=sent + sentMessageId` and the required NapCat readback verification.
- XinghaiBuilder's private `work-cycle send` gains a mutually exclusive `inquiryNotification:true` contract: it requires the latest completed single-plan cycle, an explicit target group, and a real CQ `@`; it carries no reply anchor and never falls back to the issue/source message. QA, approval, and explicitly referenced ordinary replies retain their existing contracts. Runtime plans, group/account IDs, receipts, and input JSON remain in ignored `data/`; public tests use placeholders only.

### Page-wide WebGUI Speech Service switch

- The top of **Speech Service** now has a RabiSpeech switch. When off, only the page title, state, error feedback, and switch remain; model, audio-stream, ASR, TTS, voiceprint, and playback controls are not rendered without a meaningful runtime. The full page appears only after the local `/health` check really succeeds.
- Manager now exposes lifecycle commands for this workspace's local RabiSpeech runtime. Startup directly launches the formal Windows `runtime/RabiSpeech.exe` and serializes competing transitions. Shutdown first targets a process launched by this Manager; for externally launched runtimes it verifies that the listening port belongs to this workspace's `RabiSpeech.exe/windows_host.py` before stopping. Unknown ownership fails closed, and Manager read-only mode continues to reject lifecycle commands. A brief stale SSE disconnect during transition no longer produces a red error or layout shift, and runtime configuration refresh no longer writes settings back or displays a false save notice.

### Manager-owned plan presentation and paused-resume contract

- Manager now derives the shared Awaiting approval, Awaiting QA acceptance, Executing, external-wait, and Awaiting shared package stages together with ordering and counts. All actionable non-terminal stages use green, while real external waits use red; WebGUI and the Qt tray consume this DTO without reclassifying business state.
- The `implementation/development validation → Awaiting shared package → Awaiting QA acceptance → complete on QA pass; return to implementation on failure` lifecycle is required only for plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real steps and wait reasons; Agents and batch jobs must not manufacture package or QA steps for them.
- A paused plan must retain exactly one in-progress resume step addressed by `currentStepId`; plan writes, work-cycle finish preflight, and strict audit consistently fail closed on missing, mismatched, or multiple resume points.
- Thread reconciliation reuses Manager presentation and real send receipts to classify idle work as `terminal / blocked / actionable / frozen / waiting_result`, avoiding duplicate inquiries after a verified delivery that is waiting only for a result.
- Runner, MCP, device, listener, and Unity authorization gaps remain internal. Available CLI, fallback validation, retries, sending, or repair show `Executing`; no safe action shows `Paused`.
- A repair branch that applies only after a failed QA verdict is no longer treated as current local work, so a verified receipt that explicitly waits only for QA and forbids resending remains `waiting_result`; an older QA receipt does not cover a later owner review or placement confirmation, which remains `actionable`. `work-cycle begin` now gives idempotent Manager GETs bounded retries with a per-attempt timeout and creates no history snapshot or cycle before recent memory is available; side-effecting POST and PATCH requests are still never replayed automatically.
- Plan presentation no longer treats historical completion text such as “runtime screenshots sent” in `currentStep/detail` as a current send action. A result-only wait with no safe action is `Paused`; a pending CLI, repair, or send instruction is `Executing`.
- Thread reconciliation now exposes `frozen_until_dependencies`: a cross-plan dependency such as a unified package freezes only when structured evidence waits for other original owners and states that no independent CLI, control-plane, or business action remains. Owner coordination, missing contracts, pending replies, retries, and fallback paths remain actionable.

### Manager single-instance protection, failure evidence, and independent endpoint health

- Manager acquires a workspace-level file lock before loading its control plane. Concurrent starts through a mapped drive, UNC path, the tray, or direct Node execution now reject the later instance with an explicit exit code, while stale PID locks remain safely reclaimable.
- NapCat start, restart, and stop operations are serialized by the bound QQ account and recheck the live OneBot login before spawning. Concurrent actions for one account reuse a ready instance instead of creating a second QQNT/NapCat process tree.
- Message-endpoint scans are now read-only, concurrent, and bounded by one shared deadline. A stalled probe returns partial results from the other endpoints without starting a process, changing configuration, or triggering login. QQ availability requires OneBot health, never just a reachable NapCat WebUI; personal Weixin, RabiLink, speech, and other endpoints retain independent states, so one endpoint cannot become a global-offline claim.
- Manager runtime crashes are recorded in daily JSONL evidence. Persona-index persistence and configuration-snapshot probe failures degrade into diagnosable state instead of taking down the control plane. The watchdog adds a mutex, exponential recovery backoff, a recovery ledger, an installer, and a bounded soak-acceptance entry point.
- The watchdog summarizes an isolated message-endpoint error as `degraded`; only system-level Manager, Route, or Agent-delivery failures use `error`.
- RabiLink Relay remote-WebGUI 502/504 failures now return JSON or HTML with a stable error code, retry signal, `Retry-After`, and diagnostic request ID without exposing local exceptions or paths.

### Independent Feishu endpoint and protected personal-Weixin recovery

- Added a Feishu enterprise-app endpoint with raw-body signature and Verification Token checks, Encrypt Key decryption, URL challenge handling, `im.message.receive_v1` text events, durable `event_id` deduplication, `chat_id` context isolation, and source-chat text replies. Ingress and egress fail closed until credentials and event-subscription enablement are explicit.
- Personal-Weixin session material uses current-user DPAPI on Windows and an access-restricted local key with AES-256-GCM elsewhere; legacy plaintext migrates on the next canonical write. QR creation requires an explicit user request. Network timeouts and 5xx responses retain recoverable credentials, while only server `-14` or HTTP 401/403 rejection requires a new scan.

### RabiLink Android slim package and persona presentation

- Added a `mobileSlim` resident-phone build and independent export validation. It keeps only `arm64-v8a`, excludes glass diagnostics, the Rokid SDK, desktop ABIs, and local ASR/TTS models, then verifies the 25 MiB limit, zipalign, v2/v3 signatures, and SHA-256. The phone remains responsible only for capture, reconnect, notifications, and playback; RabiPC continues to own inference.
- Android caches persona avatars by version/ETag, invalidates them through Relay events, and persists Route display names and connection metadata. Persona lists, conversation titles, and notifications retain stable identity while offline. Explicit bridge separation prevents the slim phone build from packaging the glass diagnostic implementation.
- Relay auto-selects a target only when exactly one processing PC is online and fails closed when several are available. Persona avatars and mobile Route lists use constrained proxy reads, while retryable failures preserve stable error codes without exposing local paths.

## 0.1.23 - 2026-07-30

### Speaker-model cold-start resilience

- The isolated speaker-model compatibility probe window is corrected from 30 to 120 seconds, matching real dependency cold starts that can approach one minute on Windows network workspaces.
- The probe still fails closed in a child process, changes no matching thresholds, and does not enable automatic named-speaker assignment before a formal real-person benchmark passes.
- A regression test prevents future timeout reductions from misclassifying an installed ERes2NetV2 model as unavailable.

## 0.1.22 - 2026-07-30

### RabiSpeech logs, source audio, and startup resilience

- The shared audio-stream card now sits above the TTS / ASR tabs and shows PCM, VAD, ASR, Route delivery, and public transcript history per stable device. Events use a durable JSONL ledger with older-page loading.
- Only utterance clips actually sent to ASR are retained in a constrained 24-hour cache and can be replayed by record ID. Public ASR, persona conversations, and diagnostic records remain separate.
- RabiSpeech now applies bounded retries to transient Windows network error 59 on NAS storage. Local ASR model warmup runs in the background so health, ingestion, and log APIs are not blocked by model loading.

### Safe development hot reload

- Added a safe WebGUI hot-reload entry on development port `8793`; RabiSpeech reload is explicit.
- The safe launcher rejects Manager hot reload. Manager owns long-lived Route children such as NapCat, RabiLink, and personal Weixin, so file changes must not repeatedly restart those message endpoints.
- Android is updated to `0.3.1` and includes the remote device model in its display name. Native Android changes still require a rebuilt APK, and formal acceptance still requires a complete build, package, and installed-runtime update.

## 0.1.22 - 2026-07-30

### Speech-device observability and controlled replay

- Android reports its device model when opening an audio stream. Speech Service labels sources with the model plus stable-id suffix and correlates host PCM reception, VAD/ASR/Route events, host-wide transcripts, and per-Route receipts by device. Audio-stream events use monotonic sequences in a durable JSONL ledger with lossless 24-hour-hot/72-hour-trigger archival.
- VAD utterances that actually enter ASR are retained in a private host cache for 24 hours and can be replayed only through a bounded record-id endpoint; continuous all-day PCM and arbitrary paths are not accepted. A shared TTS-store registry cleans caches at their real deadlines and stops its background cleanup with the service lifecycle.
- The isolated speaker-model compatibility probe now has a bounded 120-second startup window, covering private dependency loads from Windows network workspaces that can approach one minute. Failures still fail closed without loading an incompatible model inside the service process.
- Android chat bubbles persist queued, playing, played, and failed Agent-TTS states and allow replay from the controlled cache. Playback is serialized, while expired, out-of-root, oversized, or unsupported files fail closed.

### Mobile persona list and identity labels

- The mobile Route endpoint can explicitly include installed persona profiles that do not yet have a RabiLink binding. Android shows every persona: configured profiles remain chat-capable, while unconfigured profiles stay visible with the existing setup guidance.
- Conversation rows and titles prefer persona identity over historical gateway labels, with a stable Chinese label for YeYu. The Android app version is now `0.3.1`.

### Personal-Weixin image and file boundaries

- The personal-Weixin adapter can decrypt inbound images into private runtime storage and forward them; media that cannot be read safely remains record-only. Besides text, Outbox may send a local image or file back to a source session that supplied a context token, after adapter-policy and `allowedFileRoots` real-path checks.
- Outbound media is encrypted under the iLink protocol, uploaded to the Weixin CDN, and delivered as a native image or file item. Arbitrary proactive contacts, out-of-root paths, and unsupported media remain denied.

### Safe development hot reload

- Added `dev:hot`, `dev:hot:speech`, `speech:dev`, and the isolated-only `manager:dev:isolated`. The safe default starts only WebGUI Vite HMR; RabiSpeech Uvicorn reload is opt-in, and startup rejects occupied service ports.
- Manager stays outside the safe reload loop so its owned NapCat, RabiLink, personal-Weixin, and persona sessions are not bounced. RabiSpeech uses bounded retries for transient Windows network-filesystem error 59. Development feedback still does not replace a complete build, package, and installed-runtime acceptance pass.

## 0.1.21 - 2026-07-30

### Read-only Bilibili history bridge

- Added a one-time-installed Chrome Manifest V3 extension and local Manager job API. The extension uses the browser's existing Bilibili session only for paginated history reads; it does not use the Cookie API, Local Storage, passwords, or browser-profile access. Login expiry and risk-control responses pause the job instead of triggering tight retries.
- The Manager keeps only the pairing token, cursor checkpoint, status, and aggregate counts in private runtime data; it does not persist per-item titles, BVIDs, URLs, or cookies. Jobs checkpoint each page, deduplicate by cursor, resume after Manager restarts, and can be created or awaited with `scripts/request-bilibili-history.mjs`.

### Multi-phone speech and playback reliability

- Each RabiLink Android installation now creates a stable `rabi-phone-*` device id and reuses a stable audio-stream identity across reconnects. RabiSpeech can register several phones without letting a later connection steal the selected input; only the chosen stream enters VAD/ASR, and the selection survives a temporary disconnect.
- RabiSpeech audio-stream status now reports bytes actually accepted by the host. Android soak diagnostics use PC-received network PCM as the source of truth, while ADB is optional evidence for the foreground service, wake lock, and phone-side counters rather than a production dependency.
- Fixed initial writes and playback-marker bounds for Android static `AudioTrack`, preventing valid PCM from being rejected or a marker from landing past the buffer. Added Android unit coverage and an optional emulator disconnect/recovery probe.
- Unknown voiceprint clusters now use conservative complete-link admission, with bounded confirmed and unconfirmed samples plus cross-turn tests, so a mixed sample between two speakers cannot bridge them into one cluster.

### NapCat login ownership and recovery

- NapCat readiness now checks whether the target QQ is already online in another instance. When an owner exists, RabiRoute preserves that session and returns adoptable instance details instead of launching a duplicate that competes for the account.
- RibiWebGUI distinguishes account-owned-elsewhere, expired quick login, QR required, login conflict, and account mismatch states, and can adopt an online instance. Quick login runs only when the saved identity matches the requested QQ; failures provide an explicit QR recovery path.

### Dynamic record lifecycle and speech export

- Added bilingual dynamic-record lifecycle guidance that distinguishes archival, memory consolidation, physical sharding, expiration, and rebuildable views, with shared 24-hour hot and 72-hour trigger windows plus atomicity, indexing, idempotency, and recovery acceptance criteria.
- Added `npm run export:speech-transcript` to generate a Markdown conversation transcript for a time range from host speech messages. The export is rebuildable, never mutates the date-sharded JSONL source of truth, and preserves stable ordering, speaker labels, and source record ids.

### Configuration and Windows launcher details

- The shared configuration model now backfills uncovered default whiteboard Route rules for every enabled message adapter while preserving explicit disabled rules. WebGUI adapter grouping now covers speech, RabiLink, the legacy FenneNote entry, and personal Weixin.
- The packaged Windows tray now prefers the project-bundled portable Node runtime before environment or PATH fallbacks, preventing an older machine-wide Node installation from taking ownership.

### Faster one-click NapCat startup and fresh WebUI authentication

- Route startup no longer places a full Windows process enumeration on the synchronous readiness path. An already healthy OneBot returns immediately, and a reachable WebUI no longer triggers another full QQ/OneBot timeout before it can open. In the Manager regression tests, the ready path dropped from about 4.9 seconds to 0.13 seconds, while quick login through OneBot readiness dropped from about 9.4 seconds to 1.0 second.
- Token-bearing NapCat links now go directly to `/web_login`, forcing a fresh WebUI session with the current instance token. This avoids repeated `Unauthorized` errors from stale credentials left in a tab after NapCat restarts. Explicit health checks can still enumerate Windows processes; only fast open and background readiness checks skip that expensive diagnostic.
- The safe Windows launcher now recognizes both absolute Manager paths and the relative `dist/manager.js` form used by packaged and older launchers. A healthy Manager that predates the current build can therefore reload gracefully instead of continuing to run stale code; the Node-process, port-8790 owner, and stable `/meta` gates remain required.

### Running plans accept whole-plan guidance

- RibiWebGUI now exposes **Plan guidance** for running plans outside approval. Guidance is associated only with `planId`, never a `stepId`, and is not treated as approval. It reuses the existing plan-feedback and exact `taskBinding` delivery path. The Agent rereads the whole plan, updates its description, scope, priority, or execution path, adjusts affected not-started steps, and writes a step-less `guidance_response`. Plans in approval continue to show only the approval entry inside the owning step.

### Plan approvals now reach the bound business task directly

- When a plan has a complete `taskBinding.sessionId + workspace`, approval feedback now stays exclusively on the Codex Desktop IPC path to the original business task instead of waiting for the persona Agent to forward it. An unloaded owner keeps the record `pending`; bounded retries periodically wake the same task, and only an owner-accepted `start/steer` becomes `delivered`. The persona receives waiting, success, or terminal-failure control-plane notices, all explicitly forbidding relay and duplicate processing. The full approval goes to the persona only when no complete task binding exists. A missing task, workspace mismatch, or exhausted retry budget records `failed` without falling back in full, starting a backup Runtime, creating a replacement task, or changing session identity. A deeplink open, IPC attempt, or HTTP `202` is not delivery. Approval audit, explicit plan PATCH, and `approval_response` write-back contracts remain unchanged.

### Progressive Plans & Memory loading

- Plans & Memory no longer waits for every plan, approval summary, and memory item to return and render as one payload. Manager adds a backward-compatible lightweight-summary cursor page; WebGUI immediately shows title, type, status, and ordering data for the first 8 plans. Even without scrolling, it continuously consumes later summaries. Body text, steps, approvals, and attachment metadata hydrate only for cards genuinely near the viewport; each observer turn promotes the nearest two cards with at most two concurrent requests, while full-content search requests all remaining details only when needed. Plans and memory display independently, while memory cards enter the DOM in bounded batches.
- Detail hydration no longer instantiates a large Vuetify skeleton for every plan. Only cards with a real request in flight animate; cards that have not approached the viewport keep a compact pending hint, and off-screen cards use `content-visibility` to skip layout and paint. Near-viewport detail requests move to the front of the queue, while continuous summary paging yields short rendering turns so dozens of plan cards cannot lock the browser main thread.
- The left directory still shows every returned title, while the right content area mounts eight cards first and adds bounded batches while scrolling. Jumping to a distant directory item mounts only that target card instead of creating dozens of preceding body cards.
- Cursor pages reuse a two-level incremental Manager cache. Directory watchers coalesce short bursts of writes, and per-file size/mtime entries asynchronously reread only the plan JSON files that changed. Summary requests keep serving the previous complete snapshot while disk I/O is in flight; canonical create/update APIs write through the exact cache entries and remain immediately visible. A short-TTL validation fallback remains when watchers are unavailable. Concurrent Agent writes therefore no longer reparse or rescan the entire plan set, nor do their file reads block concurrent summary requests. The larger memory request starts only after the first plan summary returns, reducing synchronous disk-I/O contention for the first screen.
- When a plan directory is deleted or moved, its Windows watcher now closes immediately and releases the cache instead of leaving a test or runtime process in a busy loop. Plan attachment downloads read the current plan file directly by `planId` rather than reusing the intentionally short-lived summary cache, so an external attachment-metadata rewrite cannot briefly expose the previous path.
- Image and video attachments now show a light loading skeleton until real media arrives, fade in on success, and show an explicit failure placeholder. Low-priority lazy thumbnails prevent black empty blocks and keep off-screen media from competing with the first screen.

### Persona-first labels in WebGUI selectors

- The sidebar Current Route selector, Quick setup persona selector, Persona configuration selector, and Speech persona selector now prefer the top-level title from `persona.md`. Route configuration names, persona IDs, disabled state, adapters, and voice readiness remain secondary details; missing persona titles fall back to the Route display name, persona ID, and configuration name.

### Full-content Plans & Memory search

- RibiWebGUI's Plans & Memory search is no longer limited to title, focus, and keywords. It now matches any content in the current category, including plan steps, current actions, waiting/blocking notes, approval contracts, attachment metadata, memory bodies, and source summaries.
- Clearing the search field now normalizes the control's empty value back to an empty query. Refresh then restores the full list for the current category instead of failing by calling `trim()` on `null`.

### Persistent plan-assistant tasks

- A Route can create and bind 1–8 persistent Codex Desktop plan-assistant tasks by exact ID plus workspace. One slot uses `<main task name> 协助处理计划`; multiple slots use numbered suffixes. Expanding from one slot renames the original task, while shrinking only detaches extra bindings and never deletes Desktop tasks.
- `协助处理计划` tasks are now explicitly plan-management secretaries. They maintain plans and memory, deduplicate and bind business tasks, inspect status, consume results, and continue the bound task. They and their temporary control-plane child agents do not investigate, modify code/Prefabs/configuration, run Unity/SVN/build/release work, or operate external systems.
- Each plan's `taskBinding` always identifies an independent business task and never a secretary task. After a business result returns, the main persona assigns a secretary to update control state and continue the original business task in the same turn. Plan pause or secretary rotation does not clear the binding. Parallel secretaries manage separate plan shards, ending with no unmanaged actionable plan and no idle actionable business task.
- Plan-management work cycles now run concurrently by `planId`: a keyed lease provides one writer for the same plan while different plans proceed in parallel. Shared ledgers, issue mappings, and receipts use cross-process locks, latest-value merge, and atomic replacement to prevent stale whole-file overwrite. Complete lock metadata is atomically published through a same-volume hard link; stale, dead-owner, or corrupt locks are no longer deleted by contenders, but fail closed and require an explicitly quiescent repair with writers paused. Claim and clarification delivery now use a same-key lease plus `reserved/sending/sent/sent_unverified/failed/uncertain` receipts, never auto-resending an ambiguous result; claim retraction acquires the same keys in sorted order. Global strict audit compares before/after ledger snapshots and marks only stable-cycle validation failures invalid, while cycles that appear, disappear, or change during validation remain incomplete observations. Plan-scoped strict audit still fails closed, explicit `--require-quiescent` is reserved for maintenance drain, and thread reconciliation skips only active plans.

### Active inquiry for waiting plans and explicit blocked state

- The current step's `approvalRequest` is now the single blocked-state source of truth. Only a complete actionable contract with `responseStatus=pending` simultaneously derives `Blocked` and `approval.ready/enabled=true`, so every blocked plan is approvable. `isBlocked` is a compatibility projection and `blockedBy` is explanatory text only; legacy non-approval blockers are downgraded to running at read time and cleaned on the next canonical write.
- Incomplete approval contracts remain approval-disabled but keep the plan running while the Agent investigates, gathers evidence, and repairs the contract. QA waits, missing inputs, execution failures, tool timeouts, external artifacts, and ordinary owner waits must continue through inquiry, retry, rerouting, decomposition, escalation, or alternatives. A real human decision to pause, cancel, narrow scope, or accept risk becomes a concrete approval contract instead of an unapprovable blocker.
- Manager now derives `waiting_package / Awaiting package` without adding a top-level plan state. A green badge appears only for a structured current package/build step after prior work is complete and the plan explicitly waits for bundling, building, package inclusion, target identity, or the user starting a build. QA, approval, material waits, and unfinished implementation are excluded. `sortBucket` places these plans below ordinary running work.
- Explicit QA failure or reproduction reopens investigation on the same plan and `taskBinding`, asks only for the minimum evidence required by the issue type, and completes acceptance only after an explicit QA pass.
- RibiWebGUI and the Qt tray continue to consume only Manager's shared `presentation`. The public Rabi plan-tracking Skill and AgentPacket now forbid hand-written `isBlocked`; each inspection must choose a verifiable next action for non-approval obstacles, and contract-external implementation stops only after the approval contract becomes complete and pending.

### Plan-step start and completion times

- Manager now writes `startedAt` when a plan step first becomes `进行中`, then writes `completedAt` while preserving the start time when it becomes `已完成`. Reopening clears the stale completion time, and resetting to `未开始` clears both. Legacy steps missing timestamps are backfilled on the next plan write without pretending to reconstruct older history.
- After a plan is expanded, RibiWebGUI shows only the start time for in-progress steps, only the completion time for completed steps, and no time for not-started steps. Manager-owned plan JSON remains the single source of truth; the browser does not infer lifecycle times.

### Experimental personal-Weixin OpenClaw/iLink prototype

- Added a dedicated `weixin` message adapter, `weixin_message` route kind, and `weixin_chat` pipeline. A Route can request an OpenClaw/iLink QR code, persist private login/sync state, long-poll personal-Weixin messages, forward text, and record media without waking the Agent.
- Outbox can send text only back to a source session that already supplied a context token. Arbitrary proactive contacts and media sends are not supported. Manager scan reports QR/login and recent-message readiness.
- WebGUI displays the QR code, scan/login status, and recent-message state, but full account lifecycle controls such as logout/switching remain unimplemented. Real-account longevity, account risk, and stability are also unverified. Tokens, sync cursors, and session context tokens must remain in private runtime `data/`.

### Secure LAN WebGUI access

- Rabi PC Manager now has an opt-in LAN WebGUI mode that is off by default. The local Console can generate or rotate a dedicated access key. After Manager restarts, listening changes from `127.0.0.1` to the LAN and the page provides `http://<Rabi-PC-IP>:8790/#/overview?webgui_token=<key>` links.
- Non-local Manager APIs, SSE, and private resources such as persona avatars pass through one backend token gate. The static WebGUI shell may load, but no state or action is available without the key. The switch and key can be managed only from the Manager PC itself through loopback or one of its own LAN addresses; other devices remain denied, and rotation immediately invalidates old links.
- WebGUI captures `webgui_token` from either the hash route or top-level query, keeps it only in the current browser session, applies it to fetch, event streams, and private resources, and removes it from the address bar. Default local behavior, RabiLink remote WebGUI, and the separate Persona Sync LAN data plane keep their existing boundaries.
- Route-scoped URLs now cover every related sidebar page: `#/routes/<Route-config-name>/overview|adapters|persona|knowledge|speech|runtime`. Menu navigation, Current Route changes, Console-to-adapter jumps, and Runtime Diagnostics links preserve the page type while updating the URL. Legacy `/routes/<Route>`, `/persona/<Route>`, `/speech`, and `/runtime` entries remain compatible and are normalized automatically. The Console can still copy a complete LAN link, while the address bar removes the key under the existing safety rule.
- Once Manager is actually listening on the LAN, a WebGUI opened locally through `localhost/127.0.0.1` uses `location.replace` to redirect to the preferred LAN IP while preserving the current Route, page, and one-time authentication parameter. It does not redirect early while a newly enabled configuration still requires restart.
- WebGUI copy actions for links, access keys, configuration addresses, and voice-client keys no longer assume that `navigator.clipboard` exists. HTTP LAN pages and embedded browsers automatically use an in-page fallback when secure clipboard permission is unavailable, avoiding `Cannot read properties of undefined (reading 'writeText')`.

### Complete RabiLink remote-WebGUI proxy

- `/manage/<account>/<RabiGUID>/` now covers ordinary Manager APIs, images, plan attachments, audio, downloads, and media preview. Video requests pass `Range` / `If-Range` to the selected PC and preserve `206`, `Content-Range`, and `Accept-Ranges`.
- Remote `/api/events` now uses a dedicated SSE channel instead of timing out as a never-ending one-shot WebGUI request. The PC worker continuously reads local Manager events, publishes them event by event to Relay, and Relay targets only the authenticated page for that account and PC without adding business polling.
- Remote `/api/speech/events` now uses its own dedicated SSE channel as well. Streams are isolated by path, each keeps only one bounded and cancellable PC upstream, and remote pages can connect or reconnect later without cross-stream delivery or a Manager restart.
- Ordinary WebGUI traffic remains on the finite-response proxy. If an old Relay mistakenly queues SSE as an ordinary request, Manager rejects it immediately, and the finite proxy cancels unexpected `text/event-stream` responses so local self-connections cannot accumulate indefinitely.
- WebGUI worker responses now have a Base64-expansion-aware size gate. The default remote WebGUI request/decoded-response limit increases to 40 MiB, while event JSON has an independent 1 MiB limit. The Relay management cookie, PC application token, and LAN `webgui_token` remain three separate authentication boundaries; none is forwarded to local Manager.
- Relay management now shows only real processing PC workers in **Connected PC Rabi**, the PC count, and application target selectors. Phones, glasses, watches, and earbuds no longer receive an incorrect **Open PC WebGUI** action and cannot be selected as processing targets through the management API. Legacy PC records with a stable RabiGUID remain visible for compatibility.
- The Windows Relay deployer now cleans up legacy supervisor processes together with their Node children and confirms that the same process remains alive after health succeeds. A stale listener on port 8788 can no longer make a restart-looping scheduled task look successfully deployed.
- The Windows local launcher now uses stable health checks and safely takes over a stale same-project Manager: it requests graceful shutdown first and terminates a process tree only after timeout and an exact command-line match to this project's `dist/manager.js`. Unknown port-8790 owners remain untouched, and a running instance older than the current build is reloaded. Local/LAN Manager startup no longer depends on Relay availability; Relay can hot-connect later.

### Plan directory, plan descriptions, and step-local approvals

- RibiWebGUI's Plans & Memory page now shows a non-duplicate `focus` description below each plan title; legacy plans whose `focus` merely falls back to the title do not repeat the same text.
- A sticky floating plan directory now sits outside the plan panel and lists plans visible under the current tab and search query. Each entry places the Manager-owned status label first, followed by a compact title with consecutive leading `[...]` category prefixes removed; per-item sequence numbers remain hidden and plan cards retain their full titles. The directory scrolls within the viewport while plan cards stay in normal page flow; selecting a title jumps to and focuses the matching card. Narrow layouts move the directory above the panel without consuming space inside an individual card.
- On desktop widths, the plan-view tabs, search field, and refresh action now stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so plan headings remain visible; narrow layouts return the toolbar to normal page flow.
- Approval contracts, missing-field guidance, feedback history, and the feedback input now render directly inside the Manager-selected step card instead of appearing below the whole step list. User feedback, Agent replies, and system records stack from oldest to newest; new replies no longer replace earlier opinions, and the input always remains below the record list. Audit persistence, background Agent notification, and plan-advancement boundaries are unchanged.
- An incomplete approval contract remains labeled approval-disabled, but it no longer locks the user out of remediation feedback. The input, attachments, and submission switch to `Add details / request changes`, allowing the user to ask the Agent to complete provenance, scope, or execution-contract fields. This feedback is not approval; formal approval returns only when the contract is complete.
- Background Agent notification no longer locks the next feedback draft. Text, pasted images, and new attachments remain editable while only another submission is delayed. A compact status row now explains whether the previous feedback is being delivered, no Route is available, the current feedback is being saved, or the step has no approval entry, including how the control will recover instead of showing unexplained disabled fields.
- Approval feedback now accepts file-picker attachments and clipboard images pasted with `Ctrl+V` inside the input. The page shows thumbnails/file cards with pre-submit removal. Manager revalidates the 8-file, 10 MiB-per-file, and 25 MiB-total limits, stores files in the persona-private runtime directory, and keeps only safe metadata plus local paths in the audit record.
- The approval field now supports `@` selection for current-plan attachments. Users can filter by filename; image candidates show fixed-size lazy-loaded thumbnails while videos and ordinary files keep type placeholders, and arrow keys plus Enter select an item. Duplicate names receive visible disambiguating numbers. WebGUI submits only attachment IDs, while Manager verifies plan ownership, snapshots the references, and delivers them with `plan_feedback`; the audit record and failed-delivery retry preserve the same references.
- Attachments travel with the feedback through the independent `plan_feedback` event. A failed background notification restores both text and attachments, while same-`feedbackId` retries must keep attachment content unchanged so audit evidence cannot be silently replaced.
- Fixed a torn build from the concurrent attachment integration that omitted the `resetApprovalAttachmentState` definition and crashed Plans & Memory during initialization; a source-level regression check now guards the lifecycle cleanup helper.

### Plan-level attachments and media preview

- Plan POST/PATCH now accepts optional `attachments`. An Agent may submit a Manager-readable local path or Base64 content. Manager revalidates the 8-file, 10 MiB-per-file, and 25 MiB-total limits, copies content into persona-private `plans/attachments/<planId>/`, and never stores Base64 in plan JSON.
- PATCH preserves attachments when the field is omitted and clears the recorded list when given an empty array. Public plan DTOs hide local paths. A constrained read endpoint returns files only by persona, plan, and attachment ID and applies both normalized-path and realpath containment checks against traversal and symlink escape.
- RibiWebGUI shows attachments below the plan description. PNG, JPEG, WebP, and GIF images plus MP4/M4V, WebM, Ogg Video, and MOV/QuickTime videos use compact, fixed-width 16:9 thumbnails that shrink only in narrower containers. Video thumbnails keep a play icon visible at rest and show their lower-right duration after the browser reads metadata, so media identity no longer depends on hover. Images open in a large-image preview; videos open in an in-page player with controls and byte-range delivery. Actual video codecs still depend on the browser. Ordinary files show name, type, and size and open or download through Manager. Thumbnails, media previews, and ordinary file links now share the authenticated resource-URL adapter, fixing LAN WebGUI attachment requests that were rejected because they lacked the token. Plan content remains Agent-maintained, with no new plan editor or arbitrary local-path access in the page.
- Plans saved before video preview remain compatible: when an old record still says `kind=file` but its managed metadata has a supported image or video MIME type, Manager restores the media kind on read. Existing MP4 files therefore gain first-frame thumbnails and preview without requiring another upload.
- The default focused AgentPacket and public plan-tracking Skill now tell Agents to place real effect previews, demo videos, design drafts, reports, or patches in top-level plan `attachments` when a plan awaits approval, instead of leaving only a non-previewable path inside the approval description.
- `.md`, `.markdown`, and related plan attachments now open an in-page document preview and use the same fixed-width 16:9 short-preview card as images and videos. The card streams only the beginning of the source and converts it to clamped plain text without executing HTML, links, or images. Clicking it renders GFM headings, lists, tables, blockquotes, and code while retaining a source-download action. The complete preview is capped at 2 MiB; raw HTML is escaped, dangerous or relative links are disabled, and remote images become text placeholders so attachment content cannot execute scripts or silently load third-party resources. The plan-tracking Skill now tells Agents to attach the real `.md` file instead of duplicating its full body in the plan description.

### Echo-protected natural barge-in, stage one (experimental)

- The resident RabiSpeech microphone adds `barge_in_mode`, defaulting to `off`. `echo_protected` may be selected only after the operator has validated upstream AEC or reliable physical input/output isolation on real hardware. During playback, input must remain above the VAD threshold for `barge_in_confirm_ms` (default `200 ms`) before the host immediately stops current playback and clears the stale FIFO queue.
- Confirmation counts only consecutive voice observed while host playback is active; audio spoken before playback begins cannot satisfy the interruption window. The triggering utterance still completes normal silence segmentation, ASR, voiceprint analysis, host persistence, and same-source Route delivery. A playback-stop failure emits `barge_in_failed`, discards the untrusted candidate, and restores feedback suppression.
- RibiWebGUI requires explicit risk confirmation before enabling `echo_protected` and keeps the active protection state visible. Neither RabiSpeech nor the Windows remote voice client currently provides verifiable AEC, and that client still pauses microphone upload during playback. Real natural interruption still requires continuous capture, an AEC capability declaration, false-interruption acceptance, conversation-epoch cancellation propagation, and streaming TTS.

### Focused context injection by default

- AgentPacket and Codex Hook now default to the current conversation window, up to three highly relevant plan/memory/skill summaries, and a compact persona workset. Full active indexes, long history, and complete bodies are fetched on demand; Action Gate, reply delivery, and required-read checks remain intact.
- Unconfigured endpoint conversation budgets change from 100 to 12 bidirectional messages. Explicit legacy `recentMessageLimit` and `recentMessageLimits` values still apply, and the current event is no longer duplicated between `[Message]` and `[Recent messages]`.
- Personas may opt into `contextInjection`; `focused` is the safe default and `legacy` restores the previous injection shape. The public example uses `relevantKnowledgeLimit=3` and `personaMaxChars=1600`. Existing private persona and secret configuration requires no rewrite.

## 0.1.20 - 2026-07-21

### Plan-task completion Hook (experimental)

- Codex handler configuration now includes **Hook management** for task-entry context, reasoning-time refresh, and plan-task completion notifications. The UI states the trigger timing for `SessionStart` / `UserPromptSubmit`, `PreToolUse` / `PostToolUse`, and `Stop`. All three default to on, and switches affect Manager response only, not plugin registration.
- Plans now accept an optional `taskBinding` that binds an execution task by complete Codex `sessionId + workspace`; `completionHook.gatewayId` may select the reminder Route for the same persona.
- When a plan has `taskBinding` but omits `completionHook`, completion notification defaults to enabled. `completionHook.enabled=false` disables one plan, while `codexHooks.planTaskCompletionEnabled=false` lets the target Route reject notifications.
- Rabi Codex Context is now version 0.4 with official `Stop` forwarding. Manager consumes `turn_id` and `last_assistant_message`, persists `sessionId + turnId` deduplication, and delivers through the existing role-panel, Forwarding, AgentPacket, and Agent-adapter path. Success emits no Hook output; failure returns only a non-blocking system warning.
- The Hook never inspects transcripts, advances plans, changes steps, or writes memory automatically. Workspace, persona, gateway, multiple-plan binding, and source-equals-target session conflicts fail closed.
- AIUI advanced Gateway configuration now covers all three `codexHooks` switches, but it does not proxy plan approval feedback. Because approval writes an audit record and notifies a real Agent, users must review the complete plan in RibiWebGUI or the tray and submit explicitly there.
- Tests cover the plan schema, Manager HTTP, Stop deduplication/failure state, plugin stdout/warnings, and the RolePanel timeline/trigger handoff. Visibility between two real Codex Desktop tasks is still unverified, so maturity remains experimental; plugin updates must be reviewed and trusted again through `/hooks`.

### Plan approval feedback and consistent dual-client UI

- Plan approval feedback now enters AgentPacket as an independent `plan_feedback` route event instead of masquerading as `role_panel_message`. It is not written to the role-panel timeline or unified conversation ledger, and its recent-message budget is fixed at `0`; plan/memory indexes and the dedicated reply context remain available. After explicitly updating the affected plan or step, the Agent uses the normal reply API to save the response body as an `approval_response` under the same `planId / stepId` and refresh the affected card. The Codex task keeps only a short processing status. Plan guidance now requires real files, complete commands, change impact, validation, rollback, and exclusions.
- Approval submission no longer waits synchronously for the Agent delivery child process. Manager returns `pending` immediately after persistence, deduplicates background delivery by `feedbackId`, applies a 45-second terminal deadline, and emits the final state as `plan_feedback_changed`. WebGUI updates only the affected card instead of reloading all plans and memory; the tray approval request boundary is reduced to five seconds.
- Plans & Memory defers offscreen card rendering, removes detail height transitions and textarea auto-growth, and updates card-level pending/notice state granularly, reducing layout and repaint work during scrolling, expansion, typing, and submission.
- `/gateways?summary=1` no longer reads or returns every complete persona Markdown body. It keeps only persona identity, path, avatar, and a title from the file prefix, avoiding repeated large persona transfers during periodic refresh while preserving persona display names.
- The current plan step can store a structured `approvalRequest`: requested decision, reason, exact file changes, complete commands, configuration/data/external targets, validation, rollback, and exclusions. Manager applies a lightweight completeness check. Missing details reject neither the plan write nor user feedback; both clients list what the Agent should add instead of turning an Agent-quality issue into a user restriction.
- `presentation.approval` now centrally returns `none / incomplete / ready`, `missing[]`, and normalized details. WebGUI and tray render the same content, and both `incomplete` and `ready` accept feedback. The tracking Skill and shared AgentPacket hints tell Agents to use user feedback to add real paths and commands and refresh the description when scope changes.
- Rabi Manager now centrally derives plan view membership, display status, approval capability, and approval-first/status/update-time ordering. RibiWebGUI and the Qt tray use the same `Current / Plans / Recent Memory / Archived` categories plus the same title/status, current-step, keyword, complete-step, and progress hierarchy.
- The plan `presentation` DTO now includes one shared status palette. RibiWebGUI and the Qt tray use the same plan-card accent and status-badge foreground/background colors instead of maintaining separate category, sorting, or status-color maps.
- Plans now support a top-level `暂停` state. It preserves the single in-progress step and `currentStepId`, uses the shared red palette, and always sorts last. Resuming changes only the top-level state back to `进行中`.
- Added `GET/POST /api/roles/:roleId/plans/:planId/feedback`. WebGUI and tray approval cards can submit guidance; Manager writes a separate `planId/stepId`-associated JSONL audit record and notifies the Agent through the `plan_feedback` system event. A recorded-but-undelivered result keeps the draft and retries with the same `feedbackId`.
- After receiving approval through QQ or another channel, an Agent can call the same endpoint with `record_only` to record the user's guidance or its handling result. Feedback never advances a plan, approves an external action, or changes status directly; only a later explicit plan PATCH does so.

### Active-intelligence user-state and scenario-recognition design

- Active intelligence now defines a versioned `CurrentUserState` with separate time, environment, activity, emotion, physical, attention, social, task, interaction, device, and safety dimensions.
- Inferred values carry confidence, evidence, observation time, expiry, and user confirmation. Deterministic facts receive no fake score, and emotion uses valence, arousal, stress, and related axes.
- Scenario recognition is now a formal layer between device events and intent, separating observations, the individual user model, current state, scenarios, and intent.
- Scenarios support macro/activity/micro levels, one primary plus concurrent secondary scenarios, alternatives, lifecycle, evidence conflicts, and user corrections.
- Intervention no longer hard-codes “low interruption first” or “always highly proactive.” State, scenarios, Agent persona, user model, value, timeliness, confidence, and risk all participate.
- Results include no interruption, background preparation, subtle prompting, proactive recommendation, confirmation, direct action, or emergency intervention.
- The RabiLink requirements now make devices observation producers, the PC context layer the rebuildable snapshot owner, RabiRoute the safe recorder/router, and the Agent persona the final decider.
- The unified state service, scenario engine, user-model storage, control surface, and physical-scenario acceptance remain target contracts rather than complete features.
- Active intelligence now defines four user-model layers: stable trait hypotheses, context-scoped learned preferences, current psychological state, and psychological situation characteristics.
- Five-Factor traits remain low-weight continuous dimensions. Explicit instruction and correction outrank inference, and Agent persona stays separate from user personality.
- The design incorporates affect dimensions, Self-Determination Theory, task load, and DIAMONDS-inspired situation characteristics while forbidding diagnosis, manipulation, and one-event labeling.
- The user model must be inspectable, correctable, deletable, pausable, and exportable.

### Resident-ASR raw messages and complete voiceprint context

- Host raw messages now include whole-utterance RMS alongside peak, capture timing, source, audio format, and ASR/voiceprint turns; the fields continue into persona voice history and conversation context as audio facts only, never host identity judgments.
- Fixed the VAD-triggering first voiced PCM block being omitted when `pre_roll_ms=0`, preventing lost utterance onsets and a false zero whole-utterance RMS when only trailing silence remained.
- `scripts/test_multivoice_voiceprint.py` can now generate multiple anonymous TTS sources itself through the loopback RabiSpeech API and optionally send the composite WAV through a real meeting-ASR model. Testing found that `paraformer-v2` assigned only two speaker labels across three intact time turns. The voiceprint layer now preserves raw `speaker`, creates independent per-turn `speakerLabel` values and embeddings for repeated disjoint labels, and lets clusters decide whether turns share a voice. The same composite therefore still reports Provider speakers `2/3`, but local voiceprints now recover `3/3` with `providerMergeCorrectedByVoiceprint=true`. Evidence omits text, voice names, and raw voiceprint IDs and remains ineligible for formal real-person calibration.
- Multi-voice preflight no longer treats a command-line model name as a valid protocol value without discovery. It reads `/v1/models` first, accepts either a full ID or one unique short name, and fails explicitly for cross-Provider ambiguity or unavailable models. The latest real three-voice loop again produced Provider speakers `2/3`, local voiceprints `3/3`, and `100%` coverage over 19 seconds while remaining `formalValidationEligible=false`.
- Android PCM outage recovery is now event-first. The default-network `onAvailable` callback and an existing RabiLink SSE reconnection immediately wake pending audio; only temporary service failures use one-shot 1–30 second backoff. Every acknowledgement-sensitive chunk has a stable `chunkId`. For each stable source device, RabiSpeech retains only the ID and PCM SHA-256 of the last accepted chunk, so a lost ACK followed by a long outage and a new transient `sourceStreamId` does not feed the same PCM into VAD/ASR again. Android retains one pending chunk plus bounded newest PCM; long outages discard obsolete sound and catch up to the live stream without unbounded memory or hidden raw-audio persistence. Unacknowledged PCM is explicitly lost on process death. Text, control, and media keep their disk-backed durable queues.
- Android event-first recovery is now stricter through a testable network-event gate. When the system knows there is no network, the SSE connection and reliable sender sleep until a Connectivity callback instead of waking every 2.5 seconds; 1–30 second backoff is reserved for an available network whose Relay/service is failing. Glasses playback waits after `PLAYBACK_BEGIN` until the main thread confirms recording is paused before the playback worker accepts PCM. An invalid new BEGIN can no longer attach failure to the previous terminal message, and Activity destruction emits `playback_failed` for unfinished playback.
- To prevent a rare Android vendor from leaving the service permanently blocked after missing an already registered default-network callback, the foreground service now runs a five-minute safety check only while the system is known offline. It reads only current OS connectivity, stops immediately after recovery, and wakes the existing SSE/reliable queues; SSE `ready` still owns the single persisted-cursor delta catch-up. The fallback never accesses Relay, scans messages, or advances the cursor, so events remain the primary path.
- Android downlink SSE now has a 45-second transport-stall deadline for the case where the OS still reports connectivity but the TCP socket is silently half-open and no keepalive arrives. Relay normally emits a keepalive every 15 seconds; expiry rebuilds only the connection and lets `ready` perform one cursor catch-up, without adding business polling. Message-transport restore intent is also persisted independently from continuous listening, so started text/media/downlink transport restores durable queues after process or device restart, while explicit Stop disables automatic restore.
- Added `npm run check:active-intelligence:physical` as the unified physical-environment acceptance status. It reads real-person voiceprint, two-PC, Android soak, Rokid real-device, and operator-observation evidence once, starts no test, and polls no device. Each of four domains reports `missing/partial/passed/stale/invalid`, and any incomplete domain returns exit code `2` by default. Synthetic TTS, missing fields, stale evidence, or hash mismatches cannot impersonate completion; the sanitized aggregate stores evidence hashes, times, and check results only, never tokens, message bodies, personas, hosts, device serials, or private paths.
- Two-PC acceptance reports now use schema v2 and separate functional `syncPassed` from formal physical `formalAcceptanceEligible`; only a successful run with explicit two-distinct-physical-host confirmation becomes candidate formal evidence. Raw reports no longer store host names, Manager URLs, peer IDs/GUIDs/names, persona IDs, or conflict paths, retaining counts, scope, transport, and conflict-type totals only. Added `npm run record:active-intelligence:physical` for allowlisted per-check `--confirm/--revoke` operator facts; it archives the previous file, stores only a SHA-256 of random environment evidence, and provides neither confirm-all nor free-text fields.
- RabiLink downlink now has device-owned receipts and protection across very long outages. Android persists `delivered/played/playback_failed` to a private receipt queue before event-triggered replay; after an SSE wake it still performs one persisted-cursor query to cover missed events. Phone and glasses report `played` only after their own `AudioTrack` marker. Glasses BEGIN/PCM/END share ordered Classic BT, and legacy unframed PCM cannot create a success receipt. Relay persists per-device receipts, emits `outbox_receipt`, and does not apply the 48-hour TTL to explicit `targetDeviceIds` until every target returns `delivered`. Reliable text/control/media queues no longer silently prune unconfirmed old work; capacity exhaustion rejects new work explicitly. A terminal local receipt is also crash-deduplication evidence, preventing replay after physical playback completed just before process death.
- RabiLink downlink cursors are now opaque values carrying a shared Relay generation. Normal restarts and multiple Relay processes using the same data directory share that generation; a `runtime-state.json` rollback or invalid cursor returns `cursorReset=true` and replays currently retained messages. Android and AIUI deduplicate by stable `deliveryId` before saving the replacement cursor. The regression first proves that a normal restart does not replay, then deliberately rolls the sequence back and reuses the same numeric `out-...` ID, proving that the new delivery is still recovered instead of remaining permanently hidden behind a client cursor that is ahead of server state.

- Resident RabiSpeech ASR no longer submits text alone. It now sends the stable `recordId`, capture/ingestion times, provider, model, language, duration, sample rate, channel, source-device metadata, complete speaker turns, and provider-supplied word timing, probability/confidence, and speaker labels. RabiRoute first writes host-wide `data/speech/messages/YYYY-MM-DD.jsonl`, then distributes by logical message endpoint; word evidence continues into persona `voice-transcripts.jsonl` and the unified conversation ledger.
- Each Route keeps the NapCat-like endpoint → Route → persona relationship: host microphones and ordinary Rabi Voice Clients reach only `speech`, while phone audio reaches only `rabilink`. Different personas receive their own `voice-transcripts.jsonl` and `conversation/current.jsonl`; both files preserve source-device, transient-stream, audio-format, provider/model, and complete speaker evidence, while multiple Routes sharing one persona do not duplicate the row. Phone replies default to the originating `sourceDeviceId`; with no matching subscription, only the host-wide record is retained.
- The complete host-raw-record to Route-event field mapping now lives in `src/routing/speechIngressForwarding.ts`, shared by the production CLI boundary and the end-to-end regression. Fixed a first-persona-voice write where the newly written `voice-transcripts.jsonl` row could be imported as legacy history during ledger initialization and then appended again to `conversation/current.jsonl`; the canonical ledger is now written before compatibility raw history. The regression now passes that exact AgentPacket `replyContext` into the real Outbox/Relay publisher, proving that downlink targets the stable `sourceDeviceId`, never the transient PCM `sourceStreamId`, and that the outbound reply returns to the same persona conversation.
- Added a restart-persistence regression for unknown voiceprint clusters. A cluster stored in `speaker-embeddings.json` remains reusable after RabiSpeech restarts, while the existing day-long pruning regression ensures a quiet speaker's cluster prototype is not completely displaced by frequent voices.
- Added a real `src/index.ts --speech-message` child-process regression and fixed the source-classification defect it exposed. Legacy type detection treated any `routeProfileId` as role-panel evidence, causing mobile audio that selected a persona to emit `targetType=role_panel/adapterType=rolePanel`. `routeProfileId` now selects a Route only; mobile audio retains its `rabilink` source and can return through the ordinary reply API to the originating device. A symmetric PC-microphone child-process regression locks `targetType=voice_transcript/adapterType=speech` and proves that host speech carries neither a mobile downlink device nor a transient stream target.
- Persona conversation records preserve opaque voiceprint IDs, unknown clusters, diarization labels, scores, and voiceprint decision evidence. Before a host-wide message or persona conversation is stored, RabiRoute removes host person names, profile/candidate-profile IDs, and verified-person flags; legacy conversation rows are scrubbed again when read. The host decides neither who a voiceprint belongs to nor who the user is, while the bound persona interprets identity through its own relationships and context.
- Host-wide records, persona ledgers, and AgentPacket now include `sourceHostId/sourceHostName`. Each persona can independently maintain append-only `voice/voice-identities.jsonl` through `GET/PUT /api/roles/:roleId/voice-identities`. Identities are scoped by processing-host plus voiceprint ID, `isUser` has no system default, and corrections/deletions append events or tombstones that merge naturally with multi-PC persona synchronization. Relationship events now record `supersedes` parent heads. Concurrent PC decisions no longer disappear through row-order replacement: GET/AgentPacket exposes conflicting fields and branch candidates, while a later persona PUT explicitly converges every current head.
- Added the persona-scoped read-only `GET /api/roles/:roleId/voice-transcripts` view. It filters a day or time range by archives and `user/other/unknown/conflict`, joining conversation evidence with the current persona's voice relationships per segment at read time. Derived names and `isUser` never rewrite raw messages, and relationship corrections affect the next query immediately. The query now also returns user/other/unknown/conflict segment counts and speaker duration, coverage rate, and unresolved voiceprints; `matchedCount` and the summary are not truncated by the detail `limit`.
- Added **Persona voiceprint classification** to the WebGUI persona page. It shows the latest 24-hour coverage, user/other/unknown/conflict statistics, abbreviated unresolved voiceprints, and classified relationships, with **This is me / Another person / Clear decision** actions. The page uses `includeDetails=false`, so it receives and displays no transcript text. Local `records_changed`, relationship writes, and multi-PC file events trigger one refresh; an event-stream reconnect performs one catch-up query without fixed polling. **Mark the next recording** now lets a user start an explicit attempt and highlights only unresolved voiceprints newly observed by the next speech-record event and addressable across PCs. Manual confirmation remains mandatory, and even one candidate is never assigned to the user automatically. Also fixed the Manager dispatcher so `PUT /api/roles/:roleId/voice-identities` reaches the real append-event handler for both manual and Agent corrections.
- The formal voiceprint calibration script now loads RabiSpeech, `.deps`, and local runtime libraries relative to itself just like the model probe, so it runs from the repository root or any cwd. A subprocess regression prevents documented Agent/operator commands from failing due to a missing `PYTHONPATH`. The local probe still proves that ERes2NetV2 emits a 192-dimensional embedding, while `validated=false` remains mandatory until a private same/different-speaker report passes.
- Added a private voiceprint-calibration corpus collector. It lists input devices, records or imports WAVs, standardizes 16 kHz mono audio, rejects low-RMS or materially clipped samples, atomically maintains and archives `speaker-cases.json`, and reports policy dataset gaps before model execution. The default directory is Git-ignored; the tool never touches persona relationships, interprets a label as the user, or enables `validated`.
- Completed a 32-clip synthetic voiceprint preflight with six anonymous system voices from the explicitly enabled `dashscope-qwen/qwen3-tts-instruct-flash`. The current ERes2NetV2 passed the example policy at threshold `0.72` / margin `0.06`, producing `2.804%` EER, `0.236%` FAR, `5.556%` FRR, and `100%` for both known identification and unknown retention. Run metadata explicitly records `dataset_kind=synthetic_tts` and `formal_validation_eligible=false`; the synthetic report is not configured as `validation_report_path`, leaves `validated=false`, and does not replace real-person, real-microphone, and real-environment calibration.
- Formal voiceprint validation now fails closed on dataset provenance. Collector manifests are ineligible by default and become `real_person_private` only through explicit `init --confirm-real-person-recordings`. Benchmark reports add dataset-manifest and policy SHA-256 proofs plus an overall gate result; synthetic TTS, legacy reports, and undeclared datasets exit with code `2` even when their metrics pass. Runtime rechecks dataset kind and eligibility, the complete gate, dataset/policy/model hashes, and thresholds, so manually setting `validated=true` cannot bypass the report.
- Added `npm run check:rabispeech:tts-loop` for runtime closed-loop acceptance. It subscribes to RabiSpeech/Manager SSE first, then uses dynamic model discovery for TTS → 16 kHz mono WAV → ASR → voiceprint evidence → both record-query layers. Each record endpoint is queried exactly once only after terminal TTS/ASR `records_changed` events; there is no polling. Local models are preferred, API Providers require explicit authorization, and the tool never starts/stops the microphone, plays audio, or delivers to a Route. Sanitized evidence omits text, voice values, and raw voiceprint IDs and remains ineligible for formal calibration.
- Fixed Manager termination when a speech-SSE client disconnected and the aborted upstream fetch escaped `Readable.fromWeb().pipe()` as an unhandled stream error. The new `speechEventProxy` owns each client/upstream lifetime, consumes normal disconnect errors, and fails closed when the upstream Content-Type is not SSE. A stale port 8790 returning WebGUI HTML can no longer be mistaken for an event stream by the acceptance tool.
- Added `npm run check:speech-ingress-separation` for isolated built-artifact acceptance. In a temporary data root, real `dist/index.js --speech-message` children process one PC-microphone `speech` record and one mobile `rabilink` record. The check proves that one host store contains exactly two raw messages, two different personas each receive one voice-history and canonical-conversation row, host person guesses never enter persona files, and mobile replies use stable `sourceDeviceId` rather than transient `sourceStreamId`. It never connects to the real port 8790, Desktop, QQ, Relay, or persona directories and removes the fixture before retaining sanitized evidence.
- Added `npm run check:persona-sync:dual-node` for dual-node built-artifact acceptance. It starts the real RabiLink Relay, a target worker/Manager data plane, and the dedicated LAN listener between two isolated persona roots. The LAN-first phase covers JSONL union, persona-voice semantic conflict and explicit convergence, bidirectional deletion, ordinary-file conflicts, and publication of a resolution. The peer URL is then made unreachable so the same Coordinator must use the real Relay fallback for file transfer and conflict-resolution publication. All readiness comes from stdout/SSE events; no polling, real token, port 8790, or persona data is used.
- Per-outcome speaker-benchmark `correct` now covers both a correctly identified known voice and a correctly rejected unknown voice. This removes the report contradiction where unknown retention was `100%` while every rejected unknown row still displayed `false`; aggregate metrics, thresholds, and production voiceprint behavior are unchanged.
- Fixed cloud TTS requests with `sample_rate` returning `502` when the resident RabiSpeech launch environment could not discover ffmpeg. WAV-to-WAV sample-rate conversion now belongs to the shared `AudioTranscoder` and uses NumPy plus SoundFile. A real `dashscope-qwen/qwen3-tts-instruct-flash` HTTP request now returns a verified 16 kHz mono PCM_16 WAV, while cross-format conversion retains its explicit ffmpeg dependency.
- Added `scripts/test-rabi-persona-sync.mjs` for two-physical-PC persona-sync acceptance. It uses the loopback Manager to discover same-application peers, performs one explicit LAN-first/Relay-fallback synchronization, reads terminal conflicts, and atomically writes sanitized JSON evidence. It records no token, Relay/LAN address, or file body and creates no background schedule, polling loop, or automatic conflict resolution. Exit codes distinguish API failure, unavailable peer, unresolved conflicts, and “LAN required but Relay used.”
- Added `RABIROUTE_MANAGER_READ_ONLY=1` and `npm run check:built-manager`. The acceptance tool starts the current `dist/manager.js` on a temporary loopback port and uses process-readiness events to read Gateway summary, persona-sync, host speech, persona voice relationships, and conversation views. It writes only sanitized statuses, counts, and build hashes and never restarts port 8790. Read-only mode skips configuration migration and microphone reconciliation, disables every autostart component, and rejects write methods at the HTTP boundary.
- Persona-sync manifests now use a rebuildable persistent index. Manager performs one asynchronous startup reconciliation and reuses unchanged SHA-256 values through size, mtime, ctime, and file identity. Recursive filesystem events then rehash only concrete changed paths and emit `persona_sync_manifest_changed` through Manager SSE. `GET /api/persona-sync/manifest` no longer hashes the complete tree on every query; only hosts without reliable events perform one functional fallback reconciliation before an explicit query. New loopback-only `GET /api/persona-sync/index-status` is covered by built read-only acceptance without writing the cache.
- Added the event-driven `src/personaSyncAutoReconciler.ts`. Local persona-file changes mark only the affected persona pending, while Relay `ready` and same-application peer availability trigger one full catch-up. Pending scope is atomically persisted in `data/persona-sync/auto-sync-state.json`, so disconnects and Manager restarts cannot erase it. Offline targets wait for another event, temporary online failures receive at most three one-shot retries, and conflicts enter `attention` without an automatic local/remote decision. Relay now emits application-isolated `persona_sync_peer_changed` SSE events for peer connection, advertised-address changes, and disconnection.
- The automatic reconciler now has lifecycle-generation protection: an old in-flight synchronization may finish after Manager stops, but it cannot clear durable pending work, overwrite `stopped`, or schedule another retry. A real Service/Coordinator/LAN integration regression takes the target node offline, writes locally, and proves that the peer-reconnect event alone converges the folders without an explicit `/sync` call or fixed polling.
- Added **Multi-PC persona sync** to the WebGUI persona page. It reuses the existing Coordinator/API to show same-application peers, manifest and automatic-reconciliation state, immediate current-persona sync, LAN/Relay outcome counts, file evidence preview, and `keep_local/use_remote`. Advanced `use_merged` remains an Agent/API action, while persona voice semantic branches return to **Persona voiceprint classification** for explicit convergence. The page stores only loading, preview, and notice state and performs one catch-up query per SSE event without duplicating merge rules or adding fixed polling.
- AgentPacket now injects same-application peer discovery, one-shot current-persona synchronization, and terminal-conflict rules only when the current routed message explicitly requests multi-PC persona synchronization. It does not widen scope to every persona by default, requires target confirmation when peer discovery is ambiguous, and adds neither prompts nor polling to ordinary messages. This makes Agent-triggered synchronization discoverable in the current task instead of depending on accidental documentation recall.
- Added `routing/agentCapabilityHints.ts` as the owner of intent-gated capability prompts. When the user asks about voiceprints, speakers, or which all-day recordings came from the user versus other people, AgentPacket injects the persona `voice-transcripts` time-range query, `user/other/unknown/conflict` summary, and append-only `voice-identities` correction contract for that task only. Uncertain evidence remains unknown, host candidates/scores never become persona identity directly, and ordinary messages add neither prompts nor coverage polling.
- Speech delivery now persists terminal receipts. Concurrent submissions, HTTP retries, and replay for the same `recordId + Route` deliver only once and reuse successful or record-only results. Failures do not write a success receipt, so a repaired Desktop owner or IPC path can still be retried.
- Host raw-speech `recordId` deduplication and daily-file append now share a cross-process lock, and daily Route-receipt writes are serialized rather than relying on single-process timing. New `GET /api/speech/messages` lists recent host records or returns one full raw record with its per-Route terminal results.
- Android phone/glasses now behave like the standalone Rabi Voice Client and only stream ordered 16 kHz mono PCM. Android no longer exposes or executes VAD, silence segmentation, ASR, or voiceprint logic. Relay adds restricted `audio-streams/rabilink/start|chunk|stop` endpoints; target-PC RabiSpeech performs VAD, segmentation, ASR, and voiceprint processing, then automatically enters the host-wide speech ingress and the RabiLink/mobile endpoint frozen by `routeProfileId`. Chunk sequences must be contiguous. Android retains pending PCM until PC acknowledgement; identical retries at the same sequence are idempotent and never enter ASR twice. PCM uploads now use a bounded executor; prolonged weak-network stalls discard stale queued audio and reconnect under a new transient `sourceStreamId` instead of allowing phone/glasses capture callbacks to consume memory without bound. `start` and every accepted chunk rearm one 15-second expiry event; expiry retires the old virtual input and restores the previous source without a two-second state scan. `/api/rabilink/speech/messages` remains compatibility/debug only. Normal replies default to the originating `sourceDeviceId`.
- Logical endpoint ownership now comes from the capture entry point: `audio-streams/rabilink/*` always produces `rabilink`, while the LAN network-sound-card path always produces `speech`. A request body or WebSocket hello cannot disguise one source as the other.
- Fixed phone audio treating the transient PCM `stream_id` as the reply device. `sourceDeviceId` now preserves the stable phone/glasses identity, while `sourceStreamId` separately identifies the current audio connection. Host raw messages also add capture start/completion times, peak level, audio format, and channels; AgentPacket builds `targetDeviceIds` only from the stable device ID.
- Removed the legacy whole-utterance disk queue, direct `audio/transcriptions` request, and manual speech-message publication bypass from the production Android conversation backend. ASR model, language, VAD threshold, and silence-window fields are no longer mobile settings. Ordered PCM streaming is now the only phone/glasses input source of truth; ASR cache and metadata are produced only by PC RabiSpeech, while Android retains only the 24-hour downlink-TTS playback cache. The mobile architecture audit now fails if these legacy entries return.
- Fixed the main app using the shared literal `rabi-glass` as the downlink device for glasses input. Glasses PCM and media now use the companion backend `deviceId` that actually polls Relay as `sourceDeviceId`, while `sourceDeviceKind=glasses` and `channelType` preserve the physical origin. Agent replies therefore return to the originating companion phone before it forwards them to the glasses.

### Multi-PC persona data synchronization

- Added `src/personaSyncManifestIndex.ts` as the sole owner of manifest-derived state. The index stores neither file bodies nor absolute paths and never participates in cross-PC synchronization. Automated regressions cover restart reuse, one-path rehash from a file event, and one-shot query reconciliation when events are unavailable. The event-driven gate also rejects reintroducing full-tree `walkFiles` hashing into manifest queries.
- PC workers under one RabiLink application token now register `persona-sync` capability and a dedicated LAN data-plane listener URL. Relay exposes same-application peer discovery. Synchronization prefers direct LAN transfer and falls back to a restricted Relay proxy that reuses the existing PC worker to reach the target loopback Manager. The listener uses an OS-assigned port by default and exposes only manifest/file/merge, so P2P no longer requires binding the complete Manager/WebGUI to the LAN.
- Manager adds persona manifest, file-read, single-file merge, and full peer-sync APIs. JSONL is union-merged by stable record identity. Ordinary files fast-forward through per-peer common hashes. Two-sided changes never overwrite local data; remote content goes to `data/persona-sync/conflicts/`, while replaced local versions are archived. Sync terminal results now include `fileConflicts/semanticConflicts`: unresolved persona-voice branches count as conflicts and return `409` in the same request even when the JSONL file union itself succeeds, avoiding Agent coverage polling.
- Locks, temporary files, symlinks, rebuildable TTS caches, and files over 16 MiB are excluded. Once an ordinary file has a common baseline, absence on either side propagates as a deletion over LAN or Relay and archives the removed version first. Concurrent deletion versus editing creates conflict evidence carrying `remoteDeleted`, peer, and baseline hash instead of spreading silently. First-sync absence remains an addition; WebGUI and event-driven automatic reconciliation do not weaken these conservative merge rules.
- Concurrent synchronization of the same peer/persona now uses a single flight. Peer baseline state and file replacement use locks plus atomic writes. Reads, creates, and merges inspect the full parent chain and reject symbolic links or Windows junctions so persona-directory links cannot expose or modify external files.
- Ordinary-file baselines are now scoped by application-token hash plus the peer's stable device GUID, preventing reuse across RabiLink applications. `conversation/` merges reuse the message-context lock, while voice transcripts and persona voice relationships reuse their own file locks, so synchronization replacement cannot interleave with live Agent appends.
- Added loopback-only persona file-conflict listing, remote-evidence reads, and resolution APIs. An Agent can choose `keep_local`, `use_remote`, or submit `use_merged` content. Manager rejects stale replacement through `expectedLocalHash`, archives the replaced local version, moves original evidence under `resolved-conflicts/`, and writes a resolution audit record. After resolution it immediately publishes the chosen result using the captured peer/remote hash over LAN first and Relay fallback; only evidence-matching endpoints return `publish.status=published`, while offline or changed peers return `not_published` instead of pretending convergence through background polling. Neither the dedicated LAN listener nor the Relay allowlist exposes conflict control. Windows `EPERM` responses for an existing contested lock are now treated as lock contention, preventing synchronization from failing while the live persona conversation is being written.
- Default `npm test` now includes the Relay persona-sync isolation regression. It creates two applications under one management account and explicitly proves that peer discovery returns only same-application PCs and that neither application can proxy persona synchronization to the other's PC. Same-token discovery, LAN URL normalization, and the successful Relay-proxy path remain covered in the same test.
- The default gate also runs the Relay event-hub and mobile-speech proxy loops. Events wake only subscribers in the owning application and on the target device, never another application. Mobile `start → binary chunk → stop` preserves the stable `source_device_id` separately from the transient `stream_id` all the way to the target PC RabiSpeech request, preventing a future regression from binding replies to the audio stream.

### Rabi Glass phone-companion reliability closeout

- The Android phone sample is now `0.2.1` (`versionCode 3`). The phone still owns the single durable conversation and `rabi-phone` cursor, while glasses microphone audio, photos, and touchpad review requests now freeze their real `glasses` source into the offline queue. Agents, the unified ledger, and cloud logs no longer misreport glasses actions as phone input.
- Glasses PCM delivery now has a real channel gate: it is acknowledged only when the phone SDK is initialized, device authentication succeeds, and both the Classic BT message and audio channels are online. Otherwise it uses the existing three-failure and deferred-retry path without advancing the downstream cursor early.
- Continuous conversation now has one input-mode state, `PAUSED / PHONE / GLASSES`. A mode transition releases the non-target capture path first so the phone and glasses microphones cannot keep uploading concurrently. Phone capture also separates reusable mode-switch pause from service destruction, with a generation guard preventing stale delayed-restart tasks from stopping a newer capture session.
- Settings now exposes an explicit proactivity preference and transports it durably as a `rabilink.preference` observation plus text, control, media, and PCM source metadata. App and Relay do not convert it into a hard-coded intervention rule. The runtime card now refreshes from Service broadcasts and shows requested/actual mode, capture, connection, Route/persona, queues, and the latest error without a one-second business-state read.
- Phone-private text, control, media, receipt, and downlink queues now share fsync plus atomic replacement. Startup removes incomplete temporary files; malformed JSON, missing binaries, and orphaned attachments enter quarantine with visible errors so poison items cannot block later work forever.
- The phone and glasses projects now share `RabiGlassAudioProtocol` for client ID, audio stream tag, control commands, and message prefixes. The mobile audit rejects reintroducing duplicated protocol literals on either packaged side.
- `npm run check:rabilink:mobile`, the Relay media regression, and both `:app:assembleDebug` / `:glass-app:assembleDebug` APK builds pass. The Android project now includes a standard Gradle 8.6 wrapper and verifies the distribution with a pinned SHA-256 instead of relying on a developer-managed Gradle path. Rokid touchpad, continuous capture, CXR reconnection, speaker output, and long-run stability still require physical-device acceptance.

### Persona avatars across management surfaces

- Persona `personaConfig.json` now accepts an optional `avatar` filename. The RibiWebGUI persona page can upload or remove PNG, JPEG, WebP, and GIF images up to 5 MB. Manager uses content-addressed files and an atomic configuration switch, retains the old avatar when replacement fails, and fails closed on malformed configuration. It serves images through `/api/roles/:roleId/avatar`, accepts only simple filenames inside the persona directory, and rejects path traversal.
- Avatars now appear in persona binding, Quick Setup, the Route overview, speech persona selection, the local Qt role-panel header, and Agent message bubbles. Missing or failed images consistently fall back to the first character of the persona ID without changing Route, Agent-adapter, or runtime persona semantics.

### Awaiting-QA-acceptance state for Qt plan cards

- Plan cards derive the green `Awaiting QA acceptance` badge only from the structured current `qa-* / verify-*` step. QA words inside implementation prose do not change the badge early, and the source plan status remains unchanged.

### Qt tray right-click latency

- Fixed intermittent waits before the tray menu and made an ordinary left click open it immediately too. Windows removes Qt's implicit `setContextMenu` entirely; presentation-only `TrayMenuController` maps both left-click `Trigger` and right-click `Context` to non-blocking `QMenu.popup()` on the prewarmed menu, while double-click does not reopen it. The role panel now completes an invisible QWidget/native-layout warmup before the tray icon becomes clickable, so the first persona selection no longer pays the near-second cold construction/layout cost. Persona actions first show, raise, and request activation synchronously inside the user-click callback, preserving Windows foreground-user permission, then apply cached DTOs on the next event-loop turn; menu rebuilding waits until the menu closes. This fixes clicks that appeared to do nothing because the panel stayed behind another window or was still paying cold-start cost. The tray remains a pure frontend of the same Manager backend as RibiWebGUI: Qt-free `DesktopRefreshService` calls only `/gateways?summary=1` and `/api/roles/:roleId/*`, persona titles are derived from Manager-provided `roleInfo` instead of reading `persona.md` on the Qt thread, and the package excludes local plan/memory repositories and never reads runtime `data/`. Generic `qt_async` runs all Manager I/O outside the UI thread. Coverage locks frontend/backend boundaries, left/right 100 ms popup entry, panel cold-start warmup, synchronous persona activation, slow I/O, and a 50-persona stress case.

### Optional RabiSpeech cloud providers and meeting transcription

- Rabi LAN Voice Client has moved from a `config.json`-only console program to a standalone Windows GUI that shares RabiRoute's visual language. It directly configures discovery or an explicit host, stream token, node identity, input/output devices, and chunk size, while showing connection, host capture request, playback, resolved endpoint, and live microphone level. Existing `--headless` and `--list-devices` modes remain available, and disconnects still never silently fall back to host audio.
- RabiSpeech keeps local TTS/ASR as the defaults and adds explicit opt-in OpenAI-compatible and native Alibaba Cloud Model Studio (DashScope) providers. Models continue to use dynamic `/v1/models` discovery, with no silent local-to-cloud fallback.
- DashScope support covers `qwen3-tts-instruct-flash`, `qwen3-tts-vc-2026-01-22` voice cloning, and `paraformer-v2` meeting diarization. Persona configuration stores only the environment-variable name for the provider voice ID. The public example prioritizes meeting accuracy and does not expose an additional real-time ASR model. Meeting results contain `speaker + start/end + text`, with optional `speaker_count` when the participant count is known.
- API keys come only from named environment variables such as `OPENAI_API_KEY` and `DASHSCOPE_API_KEY`. Remote endpoints require HTTPS, and capabilities update `local_only` / `relay_safe` when an external provider is enabled.
- FenneNote and OumuQ serve only as references for previously validated request contracts; RabiSpeech does not restore runtime dependencies on either archived project.
- ASR and TTS text, model, session, Route, voice, and speaker turns share one append-only daily runtime JSONL record. The UI follows FenneNote's recent-transcript preview instead of exposing a separate meeting-record selection/export card; diagnostic records survive service restarts, while raw input audio is not duplicated by default.
- The speech-endpoint toggle is now the current Route's subscription to host ASR. Enabling any Route makes RabiSpeech capture and transcribe once, then broadcast the same segment to every subscribed Route, each applying its own hot/persona-keyword policy. Disabling one Route removes only that subscription, and the microphone stops only after the final subscription is disabled. The Speech Service page removes delivery-Route and editable-session controls and exclusively owns host microphone, ASR/VAD, silence timing, utterance limits, pre-roll, and gain sliders; Route pages no longer duplicate those settings.
- Host waveform, five-stage pipeline, counters, runtime logs, and recent transcripts now live only under **Speech Service → ASR**. A Route's **Speech endpoint** keeps only hot/persona-keyword delivery, the persona TTS summary, responsibility guidance, Agent-reply autoplay, and the single-ASR broadcast explanation.
- The global playback queue now exposes a `0–100` host-volume slider with exact numeric input. RabiSpeech is the sole owner and persists it in runtime-only `output/playback-settings.json`, rather than a Route or persona; each audio item reads the current value when playback starts. Windows playback moved from `winsound` to SoundFile / PortAudio, fixing streamed WAV headers that could produce an error chime. Real Windows 11 testing confirmed that Volume Mixer uses the process image and still shows `Python` when only the Core Audio label changes; installation and Windows release builds now generate and launch `runtime/RabiSpeech.exe` with RabiSpeech product resources.
- Fixed stale per-executable Core Audio attenuation that could leave the Windows mixer showing an inactive `1%` RabiSpeech row, silently reduce playback, and prevent idle adjustment. RabiSpeech now keeps one persistent silent shared-mode render session for the service lifetime: startup normalizes it to `100%` once, then keeps it alive without rewriting the value, so the system slider remains adjustable. The silent session does not enter the FIFO or trigger microphone feedback suppression.
- Persona `voice/voice-profile.json` is now the single source of truth for TTS model, voice, language, speed, and speaking instructions. The host owns ASR/VAD, while Routes retain only speech subscription, hot/keyword delivery, and reply-playback policy; legacy Route TTS/ASR/VAD fields are read-only compatibility inputs. Finalized persona TTS audio goes to the matching `voice/cache/tts-audio/`, while non-persona direct calls use a private fallback; both default to a 24-hour per-file timestamp window. The independent text ledger remains, and WebGUI exposes only a safe relative cache reference (or a legacy filename) plus expected expiry. Manager omits absolute and traversal paths.
- Added local speaker profiles and explicit `sessionId + diarization label` binding APIs. The service generates stable profile IDs, retains each original label, and adds the resolved profile ID, display name, and decision source to transcript segments. New `PUT /v1/speaker-identities` and Manager `PUT /api/speech/speaker-identities` endpoints let Agents and tools atomically find or create a person, idempotently merge aliases, and bind a label; ambiguous matches return `409`. The human entry remains on the Speech Service ASR page with collapsible unknown/known groups and a latest-ten-utterance preview for each diarization cluster. No validated automatic voiceprint matcher is currently available, so capability discovery reports it as unsupported and enrollment audio is not stored by default.
- Speaker models are now compatibility-probed in an isolated child process before native loading. An incompatible model format or runtime leaves the main RabiSpeech service online and reports the reason through capabilities. Confirmed prototypes and unconfirmed samples have separate capacity limits; low-RMS and materially overlapping multi-speaker segments do not enter the embedding store, and automatic matches never promote themselves into training prototypes. WebGUI now distinguishes clustering-only, explicitly enabled experimental auto-identification, calibrated auto-identification, and an unavailable matcher instead of masking those states with fixed copy.
- Fixed the Windows sherpa-onnx failure to load the installed official 3D-Speaker ONNX model. Speaker extraction now uses ONNX Runtime plus kaldi-native-fbank and must complete real 192-dimensional inference in a child process before becoming available. The current host reports `available=true`, `experimental=true`, and `auto_assign=false`: it performs stable unknown-voice clustering without host-side automatic person identification. The standalone probe now loads RabiSpeech and private dependencies relative to the script instead of depending on the caller's working directory.
- The speaker benchmark now supports an explicit `--policy` plus `--require-pass` gate covering real-dataset scale, EER, FAR/FRR, known-speaker accuracy, and unknown retention. Reports now carry the target model SHA-256, hard threshold, minimum margin, and per-engine result. Formal auto-identification requires a passing `validation_report_path`; runtime no longer trusts an isolated `validated=true`. Persona judgment uses only the canonical cluster-derived `voiceprintId`, never host profile or candidate IDs.

### Event-driven main path and idle-cost reduction

- The event-architecture gate now skips `.pytest_cache` at recursive traversal entry, so an unreadable test cache cannot abort source inspection. Polling prohibitions and the controlled-exception list are unchanged.

- Relay now exposes `/api/rabilink/events` SSE. PC workers, Manager WebGUI/speech proxies, and Android downlink claim work only after `task/webgui/speech/outbox_available`; cursors are reconnect recovery only. AIUI and legacy clients without SSE may still use a bounded `waitMs`, but Relay waits on the same internal event and performs one post-subscription recovery check instead of scanning business queues. An active PC SSE connection is also the online source of truth for same-application discovery; during reconnect overlap, the PC becomes offline only when its last active connection closes, without a polling heartbeat.
- RabiSpeech now exposes `/v1/events`, proxied by Manager `/api/speech/events`, for microphone level/state, playback-queue, audio-stream, and `records_changed` events. Record events are emitted only after an ASR/TTS row is persisted. WebGUI no longer runs the 400ms/1s/3s/15s speech status loops or the five-second record refresh; SSE reconnect performs one snapshot recovery pass.
- Manager Route configuration moved from a two-second full mtime scan to filesystem events. Relay state and Copilot login completion use Manager SSE; NapCat profile refresh follows WebSocket connection events, and placeholder endpoints no longer rewrite status every 30 seconds.
- RabiLink proactive review removed its five-second JSONL scan. Only record-only observations and manual review-request appends wake it; ordinary direct messages already enter Route/Agent delivery and no longer cause a redundant ledger read. Continuous-speech observations now retain their source `routeProfileId`; automatic review selects its reply Route from pending records, and multi-Route batches require per-Route delivery instead of falling back to the default persona. Settle/busy retries and reflection remain one-shot timer events. Android Health Connect no longer queries by the minute. Rokid AIUI and Xiaomi Health's ADB Provider lack reliable event primitives, so preserving foreground proactive downlink and health collection requires two documented exceptions: a 25-second foreground long wait and an explicitly enabled minute-scale Companion poll.
- The event-driven gate now scans production sources for the backend, WebGUI, Android main app, RabiSpeech, desktop voice client, tray, and AIUI. Fixed interval/fixed-delay business scheduling fails by default; only explicitly documented SSE keepalives are accepted. Android audio-stall recovery now derives one 45-second deadline from the last successful read. Relay attachments and RabiSpeech TTS caches use one startup scan plus the earliest expiry deadline instead of periodic directory scans. The gate reports the remaining controlled exceptions for DashScope remote asynchronous jobs, AIUI foreground wait/battery refresh, and Xiaomi Health ADB low-frequency collection.
- Remote Agent authentication timeout now shuts down a WebSocket according to its `CONNECTING/OPEN` state and absorbs the expected handshake-abort error. The timeout permanently settles as one explicit failure instead of raising an unhandled close race or later persisting delayed authentication.

### ASR hot delivery, persona keywords, and real delivery state

- Routes now use `speechPushMode=hot|keyword`, edited through one **Hot delivery** switch. On sends every completed ASR segment immediately. Off still records every transcript and wakes the Agent only when the current persona's `speechTriggerKeywords` matches. An empty keyword list remains record-only and never silently falls back to hot.
- `speechTriggerKeywords` belongs to persona `personaConfig.json` and can contain the persona name, common forms of address, and wake phrases. Several Routes bound to the same persona reuse the same list.
- `POST /api/speech/messages` replaces the old `202 accepted` response with synchronous terminal receipts. When the resident microphone omits `routeId`, Manager broadcasts and returns one `deliveries[]` entry per subscribed Route. `200 delivered` means at least one Desktop accepted start/steer; `200 recorded` means record-only or no current subscribers; only an all-subscriber failure returns 5xx. Explicit `routeId` remains for debugging/compatibility calls. The monitor never treats another Route's success as delivery for the current Route.
- Matched ordinary endpoint messages continue directly to the Desktop owner: `steer` an active turn and `start` an idle task. Heartbeat's `heartbeatSkipWhenAgentBusy` remains a separate exception and does not suppress ordinary traffic.

### Unified bidirectional ledger and per-endpoint context

- Added the persona-scoped `data/roles/<RoleId>/conversation/current.jsonl` ledger. QQ self replies, ASR/TTS, WeCom, Remote Agent, role panel, RabiLink, and other inbound/outbound messages now share one evidence format; attachments retain only public-safe metadata.
- Persona `recentMessageLimits` now configures 11 logical endpoints independently from `0` to `200`, with a schema default of `100`. Zero disables auto-injection only. AgentPacket reads only the current persona, logical endpoint, and conversation, with inbound and outbound records sharing the budget; same-session ASR/TTS share the `speech` budget.
- `current.jsonl` has no entry-count cap. When an archive check finds data older than 72 hours, the complete contiguous prefix older than 24 hours moves to `archive/<firstSequence>~<lastSequence>.jsonl` and updates `index.json`. Automatic context never reads archives, which remain available for explicit Agent queries.
- The speaker registry is one host-wide `output/speaker-profiles.json`: person profiles are reusable across Routes, personas, and later meetings, while each mapping remains an explicit `sessionId + speakerLabel` binding. No separate meeting-record section was added.
- Synchronized the repository and local TTS/ASR skills. The voice-workstation guide now covers hot/persona-keyword delivery, bidirectional context, 24-hour cache retention, and speaker contracts; the benchmark guide separates local baselines from explicit API-provider smoke tests; and a repository `character-tts-dialogue` skill now matches the installed local copy.

## 0.1.19 - 2026-07-20

### Live NapCat reply-message hydration

- When a NapCat group or private event contains a CQ reply whose message ID is not in local history, RabiRoute now follows the chain through OneBot `get_msg` before route delivery and caches each result with `lookupSource=onebot_get_msg`. Each lookup has a timeout; failures emit warnings without failing the current delivery.
- `AgentPacket` still prefers the active persona directory, while also using Gateway message history and successful Outbox records for missing references. Persona-bound Routes can therefore resolve messages just recovered through `get_msg`, with explicit precedence for current, history, and Outbox records.
- Added regressions for `get_msg` normalization, recursive caching, failure degradation, split persona/Gateway directories, and Outbox fallback. The bilingual context-injection and code-architecture guides are synchronized.
- `npm test` passes all 255 backend tests, while `npm run build` and `npm run check:config` pass. The frontend build retains only the existing runtime asset-resolution and large-chunk warnings.

## 0.1.18 - 2026-07-20

### Multi-client directory ownership

- Moved the independently buildable Android phone/glasses client and Rokid AIUI client from `examples/` to `apps/`, leaving `examples/` for small copyable configuration and integration samples.
- Moved the shared Android SDK from `sdk/android/` to `packages/android-sdk/` and renamed the Android glasses module from the ambiguous `glass-asr` to `glass-app`; application IDs, protocols, and runtime behavior are unchanged.
- Added bilingual `apps/` and `packages/` guides and synchronized build scripts, architecture documentation, and developer entry paths.

### QQ reply-chain and mention context

- `AgentPacket` now adds a message-code parsing section that follows CQ reply references by `messageId` through the current Route's group/private records and collects CQ mention names encountered along the chain.
- Referenced previews are capped at 200 characters. Missing records, cycles, and the maximum depth stop safely; the current message body and ID are not duplicated, and handlers can use the existing interfaces when full content is required.
- Added AgentPacket regression coverage and synchronized the bilingual context-injection guide.

### Role panel and Route configuration cleanup

- Qt role-panel chat now groups messages by date, keeps sender and time inside each bubble, and renders compact attachment rows. The bounded composer sends with `Enter`, keeps `Shift+Enter` for line breaks, and the window returns to ordinary movable-window behavior.
- Collapsed plan cards add a current-step summary, preferring the structured `Step N · title` form while expanded cards retain full steps and blocker details.
- WebGUI no longer presents the Manager-provided role panel as a configurable message adapter. Legacy `rolePanel` configuration remains compatible, and built-in role-panel delivery and persona rules are unchanged.

### Mobile conversation navigation and Rabi Glass HUD polish

- The normal Android entry is now a QQ-style conversation list with RabiLink Route avatars, latest message, time, and per-conversation unread state. Tapping a persona opens detail and Back returns to the list; wearable and other non-chat Routes are no longer treated as personas.
- Normal chat no longer mixes persona selection or configuration mode. Settings, the separate Configuration Assistant, and chat detail have explicit roles; drafts, read state, notification deep links, legacy migration, and delivery state are scoped by `routeProfileId`.
- Text, media, and speech freeze the target Route before background queuing, preventing cross-conversation delivery after navigation. Normal notifications aggregate per conversation and clear when that detail is read.
- Attachment, composer, and Send controls use one 52dp height. The phone app is now `0.3.0` (`versionCode 3`).
- Rabi Glass adds explicit Connect, Listen, Upload, Speak, Paused, and Error HUD states. Capture pauses during downlink PCM and resumes after an audio-length-based delay to reduce reply audio feeding back into the next uplink.
- The mobile audit now asserts conversation-list navigation, RabiLink contact eligibility, per-conversation unread state, explicit targets, and `singleTop` notification navigation. Physical Rokid glasses interaction still requires device validation.

## 0.1.17 - 2026-07-20

### Manager-owned Codex context

- Added the normalized `RabiContextManager` trigger layer so AgentPacket `message_delivery` and Codex `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` share the sole `roleKnowledgeSnapshot()` path, required-read GET protocol, `viewedAt`, plan archival, and memory-consolidation lifecycle. Entry events receive a lightweight full view; reasoning checkpoints inject only newly relevant items for the current turn.
- Manager now exposes Codex Hook context, role-list, session-binding, and doctor APIs. Bindings use the exact complete `session_id` and stay in private runtime data, while existing plan, memory, and skill APIs remain the knowledge authority. Preview policy does not archive plans, refresh `viewedAt`, or create a consolidation run. Knowledge-only `managerAutostart=false` mode no longer starts Route-config polling, avoiding repeated NAS migration scans that can exhaust Windows SMB handles.
- Upgraded `rabi-codex-context` to `0.3.0`. The active plugin only forwards Hook events and injects Manager-produced `additionalContext`; plugin-owned role roots, bindings, file scanning, and keyword scoring were removed, and the 0.1 implementation moved to a read-only migration archive.

### Android first-run setup and unified mobile UI

- Added shared `RabiMobileUi` components and `RabiSetupGuide` for consistent color, spacing, fields, actions, guidance cards, and collapsed sections across home, wearable, Rokid, RabiRoute SDK, Xiaomi Provider/OAuth, and advanced diagnostic screens.
- The phone scans for LAN Rabi PCs and automatically selects a single online worker after login. Failure reasons, expected values, source locations, and fixes now stay beside each field, while device IDs, polling windows, models, and thresholds default to Advanced settings.
- Wearable “save and enable” validates RabiLink, Health Connect, or the Xiaomi key and saves only a disabled draft when prerequisites are missing. Rokid opens with a six-step guide while SDK matrices and raw logs move under advanced diagnostics. UI and build completion do not replace physical Rokid or long-running wearable validation.

### Migration and versions

- Bumped the project to `0.1.17`, the Android phone example to `0.2.0` (`versionCode 2`), and the Codex Context plugin to `0.3.0`.
- Version 0.1 role-root registrations and session bindings in the plugin user directory are not migrated automatically. Start Rabi PC Manager and bind each persona again with the exact complete `session_id`; `source add` and plugin-local knowledge fallback have been removed.
- Manager stores new bindings in runtime-only `data/codex-hook/sessions.json`. Do not commit that file, local personas, the old plugin user directory, logs, or real credentials.

### Validation

- `npm test` passed all 248 backend tests. Knowledge-only mode also stayed healthy on the real NAS workspace for a 35-second window with 7 consecutive knowledge-API checks.
- `node --test plugins/rabi-codex-context/test/*.test.mjs` passed all 6 plugin tests.
- Android `:app:assembleDebug` passed from a local isolated output directory with Gradle 8.6, JDK 17, and the project Android SDK; only existing deprecated-API and native-strip warnings remain.
- `npm run check:config` and `npm run build` passed. The full build completed TypeScript, the Codex contract check, Vue type checking, and a 638-module Vite production build, with only the existing runtime asset-resolution and large-chunk warnings.

## 0.1.16 - 2026-07-19

### Structured plan steps and current position

- New plans must now provide a complete ordered `steps` array. An in-progress plan uses `currentStepId` to identify the only in-progress step, and every step must be complete before the plan can be completed or archived.
- Qt plan cards now lead with every step, completed progress, and a `Current: step N` callout, with the current row highlighted. The old six-row preview is gone. Legacy plans without steps show an explicit migration notice instead of deriving progress from two summaries.
- Agent plan summaries, public examples, the plan-tracking skill, and bilingual API documentation now share the structured-step contract, backed by backend and Qt regression tests.

### Standalone mobile endpoint and reliable Rabi Glass conversations

- The Android example is now a complete phone-first Rabi message endpoint. After setup it opens multi-route persona chat, stores text, voice, images, video, audio, and arbitrary files in one private conversation ledger, and treats glasses as optional microphone, speaker, HUD, camera, and touchpad peripherals.
- A phone foreground service owns stable uplink queues, a persistent downlink cursor, ASR/TTS recovery, post-boot message recovery, two persistent notifications, and ordinary Agent message notifications. Every message carries a `routeProfileId` and cannot be broadcast to unselected personas.
- Configuration-assistant requests carry an explicit marker to the selected Rabi PC. Writes, deletion, stop, overwrite, and external actions remain behind the existing safety gates, and completion may be claimed only after a successful API response and read-back verification.
- Relay and Outbox now support bidirectional attachments and attachment-only messages, while public RabiLink identity responses no longer expose the application token. Added the mobile audit command, Relay/Outbox/routing regressions, and phone smoke evidence; physical Rokid glasses validation remains a release gate.

### Smartwatch and fitness-band health endpoint

- Added a dedicated `wearable` endpoint, structured role health timeline, and Manager API for heart rate, sleep sessions, sleep stages, current sleep state, history, 24-hour summaries, and per-device threshold policy.
- Routine observations are recorded without entering chat or waking the Agent. Only high/low heart-rate thresholds or sleep-state transitions produce `wearable_health_alert` events through the existing Route and Agent delivery path.
- Android supports Health Connect. The Xiaomi path adds a phone-configured, dry-run-by-default PC ADB companion, scheduled-task installer, and dedicated Route configurator. Authentication secrets stay in Android Keystore and never enter Relay, logs, or Agent context.
- Added coverage for deduplication, cooldowns, sensitive-metadata removal, Relay allowlisting, Manager queries, and alert delivery. Automation proves the protocol and implementation only; long-running heart-rate and sleep stability still requires real-device validation.

### Rabi Codex Context plugin and knowledge-only Manager mode

- Added the first independently installable `rabi-codex-context` Codex plugin prototype. It explicitly binds a real session ID to a Rabi persona and uses `SessionStart` / `UserPromptSubmit` hooks to inject a bounded persona working set, plan/memory indexes, and a small amount of keyword-matched content.
- Unbound sessions receive no context, and `use`, `status`, `refresh`, and `off` require strict control markers. The plugin neither copies role knowledge nor becomes a second memory source of truth, and it does not require Rabi PC to remain running.
- Manager now supports `RABIROUTE_MANAGER_AUTOSTART=0` for knowledge-interface-only use without starting gateways, Relay, or LAN discovery. Role-panel delivery reports success only after an Agent packet was actually delivered.
- Updated the public Rabi plans and recent memories for the mobile endpoint, wearable health, Codex session binding, and structured-plan contract. Local Rabi context was updated through Manager APIs while private runtime `data/` remains uncommitted.

## 0.1.15 - 2026-07-18

### Character-TTS closure for the speech message endpoint

- Fixed RabiSpeech transcripts reaching Codex while `AgentPacket` omitted mandatory reply-delivery instructions, which left the answer visible in the task without entering TTS.
- A `voice_transcript` from `speech` / RabiSpeech now enters `character-tts-dialogue` state and is forced to `voice_chat`; QQ, the role panel, and ordinary text inputs keep their existing behavior.
- After the handler returns semantically identical visible/spoken text through the normal reply API, Outbox revalidates the source and speech-output policy, freezes the Route persona, voice, model, language, instructions, `sessionId`, and autoplay choice, and enters the host-wide RabiSpeech FIFO. Added AgentPacket and Outbox regression coverage.

### Consolidated RabiPC speech control plane

- Manager now has a dedicated `speechControl` interface and shared camelCase contract for models, personas, audio inputs, microphone, playback, TTS, ASR, and accepted speech messages. Python snake_case, loopback URLs, and model-runtime details no longer leak into Vue pages.
- RibiWebGUI now uses a shared speech client/store, ASR host input-level waveform, host monitor, and event/queue status. The speech page and Route configuration no longer poll independently or duplicate defaults; the backend fills `voice_chat` and speech-variable defaults for speech-enabled Routes.
- RabiSpeech microphone and persona-voice handling gained clearer runtime and failure boundaries, with regression coverage for Manager mapping, the frontend contract, microphone behavior, and persona voices.

### Rabi Glass phone backend and media observations

- The Android example adds a phone-side `RabiGlassPcBackend` and a thin glasses client. Glasses only capture/play PCM, send device media, and render the HUD; they store no Relay configuration. The phone owns Relay, selected PC, cursor, and glasses settings, while the selected Rabi PC owns ASR, TTS, Agent context, and the Action Gate.
- The phone home screen is now a focused glasses companion: duplicate Route/Agent/workspace/thread configuration is removed in favor of remote WebGUI, and cross-transport start/stop controls are idempotent so one recording cannot be submitted twice.
- Relay now exposes allowlisted device-media upload/download paths, stores image, video, and audio attachments per application with a default seven-day expiry, and lets the PC worker materialize only controlled paths before recording public-safe metadata in the unified ledger.
- The speech proxy remains limited to TTS and ASR. It cannot reach remote WebGUI proxying, worker APIs, host microphone control, or arbitrary local paths. The bilingual glasses-route, AIUI residency, and active-intelligence docs were updated accordingly.

### Recent-memory overwrite guard

- `updateRecentMemory` no longer lets a handler overwrite a recent memory that has been inactive for more than 24 hours from stale context. The handler must first read it by ID to refresh the view window, or record a new correction.
- This gate applies only to recent-memory edits; it does not change plans, consolidated memories, raw chat logs, or speech transcripts as their respective sources of truth. Added coverage for rejection before reading and successful update after reading.

### Codex Desktop stable-ID continuation

- Fixed `/api/agent/threads` rejecting display titles longer than 240 before reading a valid task ID, which made settings saves return HTTP 400. A valid ID plus workspace now binds first regardless of long title metadata.
- When an empty task truly must be created, RabiRoute safely truncates an overlong name to Codex's 240-character contract and persists the actual name instead of deferring the same failure to `thread/name/set`.
- Fixed the first routed message reaching the correct task but rewriting Desktop SQLite `title` to the first prompt, which made the second message treat the name-ID pair as stale and create a same-name task.
- A persisted binding now uses full task ID plus normalized workspace as stable identity. An existing unarchived ID in the same workspace is reused without comparing mutable title metadata; name lookup/creation runs only when the ID is empty, invalid, or genuinely missing.
- Settings scans and name resolution now read the short-lived app-server's user-facing task name and cross-check it against Desktop's local task ID and archive state. The app-server still reads metadata only and never receives a real prompt or executes a turn.
- If a saved task is archived, RabiRoute may bind the newest unique active same-name task in the same workspace; with no candidate it fails closed and never creates a replacement.
- Explicitly typing a new Rabi name still clears the old ID before name lookup or idempotent creation. Added repeated-delivery coverage after title mutation and synchronized the integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill.

## 0.1.14 - 2026-07-18

### Codex Desktop archived-binding guard

- Fixed a persisted Codex Desktop task being mistaken for “missing” after archival, which previously allowed Rabi to create a same-name replacement. Exact-ID reads now preserve archived state and require restoring the original task or selecting another one.
- An archived persisted binding returns a conflict and stops delivery before name lookup or creation. Normal pickers and name lookup still show only unarchived tasks, and idempotent creation remains limited to zero matches.
- Added Manager API and Desktop-state regression coverage and synchronized the bilingual integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill. Archiving a task can no longer silently change Rabi's delivery target.

## 0.1.13 - 2026-07-18

### Codex Desktop same-name task continuation

- Fixed rebinding when a saved ID is missing, stale, or no longer paired with its name: one or more exact same-name/workspace candidates now bind the unique latest `updatedAt`, and creation is permitted only when there are zero matches.
- A tied maximum or entirely unusable timestamps remain ambiguous and require selection. Resolution never depends on database return order and never creates another same-name task in that case.
- Added resolver and Manager API regression coverage and synchronized the bilingual integration standard, acceptance contract, troubleshooting guide, and Agent-creation Skill. Codex/ChatGPT Desktop remains the only real-message owner; port 4510 lifecycle and the no-fallback-Runtime boundary are unchanged.

## 0.1.12 - 2026-07-17

### Windows installer and GitHub Releases

- Added a per-user Windows x64 installer and portable ZIP pipeline that embeds a pinned Node.js runtime, Manager, RibiWebGUI, production dependencies, and the tray entry, so a clean PC does not need Node.js preinstalled.
- Moved Vue, Vuetify, Pinia, frontend Markdown, and icon fonts to development dependencies so the release payload does not duplicate frontend sources already compiled into WebGUI; production dependencies now contain only Manager runtime packages.
- The installer defaults to `%LOCALAPPDATA%\Programs\RabiRoute` and asks the loopback Manager shutdown API to stop gracefully before upgrades and uninstall. The payload excludes top-level `data/`, and neither an upgrade nor uninstall proactively removes local routes, personas, or logs.
- A `v*` tag now runs tests, configuration checks, tray packaging, release privacy checks, and a packaged Manager smoke test on a clean Windows runner, then uploads the setup EXE, portable ZIP, and `SHA256SUMS.txt` to GitHub Releases.
- Windows binaries are not code-signed yet. The README and packaging guide retain the SmartScreen unknown-publisher warning and SHA-256 verification guidance; code signing, stable/nightly channels, and in-app updates remain future decisions based on real release cadence.

### RabiPC speech endpoint and local models

- Added the standalone local-only `rabi-speech` plugin and RabiPC Speech Service page. TTS and ASR are top-level tabs below Rabi Persona; only Routes with an explicitly enabled speech endpoint subscribe to resident ASR, and normal API calls never enter an Agent.
- TTS now covers ONNX-VITS, GPT-SoVITS, Qwen3-TTS 0.6B/1.7B, IndexTTS2, and CosyVoice3. ASR covers faster-whisper tiny/small/large-v3-turbo, Qwen3-ASR 0.6B/1.7B, SenseVoiceSmall, and FireRedASR2-AED. Active providers use installed local models or loopback workers only; cloud speech APIs are absent from the active runtime.
- `GET /v1/models` returns installation/availability state, a request schema, required/optional parameters, and examples for all 13 models. The provider contract remains extensible, while remote requests cannot download models, load code, or change the allowlist.
- TTS supports direct Rabi persona-name calls, persona-owned voice/cache data, multiple voices, and one host-wide FIFO across Routes, sessions, Agents, personas, and models. Resident ASR supports a real audio device, pre-roll, separate record/transcribe thresholds, adaptive noise, silence segmentation, restart restore, and subscription-based broadcast to Route speech endpoints.

### RabiLink, public boundary, and legacy migration

- RabiLink is the Manager-owned system transport. One generic application token proxies model discovery, TTS, and ASR while RabiSpeech remains loopback-only; public microphone start/stop paths are not allowlisted.
- OumuQ and FenneNote are end-of-maintenance archives. Their TTS routing, persona voices, resident transcription, and threshold controls move to RabiSpeech and the RabiPC speech endpoint; active providers no longer depend on either legacy project or paid cloud APIs.
- Rabi speech Skills now target RabiSpeech and `data/roles/<RoleId>/voice/`. Wiki evidence extraction is limited to voice, emotion, delivery, dialogue examples, and indexes, while `persona.md` remains read-only.

### Downloads, performance report, and Windows runtimes

- Added per-model download guidance and isolated-runtime installers. CUDA/cuDNN DLLs live in plugin-private dependencies and affect only the service process search path rather than the system PATH.
- The performance report covers tested/recommended hardware, model size, cold start/warm-up, warm requests, capability limits, three bar charts for TTS latency, ASR latency, and ASR character accuracy, plus exact dialogue samples. Public cold/warm and Relay-reconnect timings are reported separately.
- WebGUI build, configuration checks, 203 RabiRoute tests, and 16 RabiSpeech tests passed. Runtime WAV files, models, logs, tokens, real reference audio, private paths, and machine configuration remain ignored.

## 0.1.11 - 2026-07-17

### RibiWebGUI product user guide

- Renamed the WebGUI footer entry from Project Docs to User Guide. `/#/docs` no longer treats the developer function map as default product help and now renders the manually maintained Chinese and English Markdown under `docs/user-guide/`.
- Organized the guide around first delivery, interface state, message adapters, handlers, persona rules, operations, safety, and support: nine topics and 18 Markdown files including the landing page. Fifteen placeholders specify the exact future screenshot and callouts.
- Added multi-token full-text search, an on-page outline, locale-aware page selection, Markdown internal links, and shareable `?page=` deep links. Architecture, schemas, APIs, and the function map remain deeper developer material.
- Corrected the public capability boundary against the current UI: Log Diagnostics has manual triggers but no Delivery replay control. Replay remains available through the Manager API and ledger. Updated both READMEs, documentation indexes, capability pages, function maps, and code architecture.
- Updated the public Rabi example's WebGUI plan and recent memory with the new user-guide boundary, and recorded sanitized real screenshots as follow-up work.
- The full build, all 197 automated tests, and configuration validation pass. Browser acceptance covers full-text search, internal links, invalid deep-link fallback, locale switching, and overflow-free layouts at 1600px and 390px widths.
- This changes the WebGUI documentation entry and public guidance only. Route schemas, routing, handler delivery, and Outbox behavior are unchanged, with no runtime migration required.

### README brand story and onboarding path

- Restored the brand-first hierarchy in both README languages with “Let Agents connect everything around us.” as the core slogan, grounded by signals from chat, voice, devices, and time. “RabiRoute does not own the Agent. It owns the context and the gates.” now summarizes the architecture boundary.
- Reordered the README as a product landing page: highlights, the shortest Quick Start, message flow, current capabilities, and deeper documentation. The standalone maintainer-grant framing is gone, while maturity, Outbox, Codex Desktop ownership, and no-hidden-fallback facts remain explicit.
- Updated the public example Rabi and local runtime Rabi product-boundary memory to distinguish the vision slogan from the gateway, routing, and action-gate boundary, so later approval-oriented edits do not erase the project story.
- This change updates public documentation and Rabi project context only. Runtime code, configuration schemas, startup flows, and local runtime data behavior are unchanged; no migration is required.

### MIT open-source license

- Added the standard MIT `LICENSE` at the repository root with `Copyright (c) 2026 vb2250158`, explicitly allowing use, copying, modification, merging, publication, distribution, sublicensing, and sale of software copies under the standard warranty disclaimer.
- Added matching MIT badges and license links to both README languages, and declared `license: MIT` in `package.json` and `package-lock.json`; the license text remains the single source of truth.
- This change affects public licensing and package metadata only. It does not change runtime code, configuration schemas, startup flows, or local `data/`, so no runtime configuration migration is required.

### Three documented RabiLink glasses routes

- Added “Three glasses routes” to RibiWebGUI Project Docs, comparing the native Lingzhu agent, AIUI, and native Android app at the same level through a capability-ownership architecture and a horizontal table covering host, entry, wake/ASR/TTS/HUD/lifecycle/Agent ownership, overall freedom, release cost, fit, and maturity.
- Clarified that all three routes share RabiLink Relay, RabiRoute, the unified conversation ledger, the PC Agent, and the Outbox safety gate. Current guidance uses AIUI as the primary custom experience, the native Lingzhu agent as a lightweight compatibility entry, and the app as the deep-device and independent-lifecycle branch.
- Added reviewed Chinese and English route-selection guides to the documentation index. This change affects documentation and presentation only; Relay, Route, Agent, and device protocols are unchanged.
- Updated the public example Rabi active plan and recent memory with the three routes, capability ownership, the freedom gradient, and the shared-backend boundary so later Agents do not mistake the historical phone-app design for the only main path.

### Six-view tray role-panel layout

- The PySide6 floating panel now exposes Chat, Current, Plans, Recent Memory, Archived, and Diagnostics as first-level navigation destinations instead of hiding the last three in the overflow menu.
- The header removes repeated status text and consistently shows the selected role, Manager/Gateway state, and current Route. The left sidebar remains Route-only; directory actions, manual triggers, refresh, and sidebar collapse remain secondary overflow actions.
- Tray colors and component styling now align with RibiWebGUI's `RabiLight` theme: mist-blue backgrounds, white cards, deep navy text, teal interaction states, 8px radii, and light borders, with complete button, input, menu, focus, and scrollbar states.
- Current is explicitly grouped into in-progress plans and recent memory, while Diagnostics uses a read-only status table. The composer still appears only in Chat, and the plan/memory sources of truth and read-only boundary are unchanged.
- Trigger keywords now use progressive disclosure: collapsed cards keep one responsive line, reveal more complete keywords as width grows, and mark any hidden remainder with `……`; expanded cards reveal the full keyword set.
- Expanded plans now use a clear action-summary layout with Current Step and Next Action side by side. The reader accepts optional source `steps`; when real steps exist it shows completed counts, a progress bar, status-aware rows, and Reveal All, while plans without steps never receive inferred progress.
- Added Qt layout regression coverage for the six primary views, composer visibility, Current grouping, the Diagnostics table, and overflow-menu boundaries.

### Runtime Chinese/English switching in RibiWebGUI

- Added a top-bar `中 / EN` menu. `ribiwebgui/src/i18n/index.ts` is the single locale owner, stores the browser preference under `rabiroute:webgui:locale`, and keeps `<html lang>` synchronized. Locale is a UI preference and is never written to Route, role, or Manager configuration.
- Added manually reviewed English copy, dynamic-status rules, and a DOM localizer for navigation, Console, Message Adapters, Persona, Logs & Diagnostics, Quick Setup, and related dialogs. `data-no-i18n`, code blocks, input bodies, and editable content are skipped; Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime data stay verbatim.
- User Guide selects the Chinese or English Markdown under `docs/user-guide/` for the active locale and renders it with `marked`, avoiding a third page-content source.
- Added five pure translation tests. The WebGUI production build passes with 626 transformed modules. Browser acceptance covered locale switching, Chinese restoration, Quick Setup, rule editing, public message-adapter settings, and a 700px narrow layout against isolated example data.

### Bilingual open-source docs and examples

- Added manually maintained Chinese/English counterparts and top-level language links across README, architecture, configuration, getting started, troubleshooting, message adapters, RabiLink, AIUI, Android SDK, example personas, and archive guides.
- The English User Guide renders `docs/user-guide/*_en.md` directly instead of creating a third documentation source. Agent runtime semantics, personas, and skills are not mechanically translated.
- The public Rabi example plan and recent memory now record WebGUI locale switching, the tray `RabiLight` theme, and structured expanded plans without including runtime `data/`, real accounts, tokens, logs, or machine-private paths.

## 0.1.10 - 2026-07-16

### Codex first delivery and personality initialization stability

- Newly created Codex Desktop tasks will wait for a limited time before the first real message appears in the Desktop read-only index with the same task ID; a short delay in the index will no longer be misjudged as the task does not exist, and tasks with the same name will not be re-created as a result. After the wait is completed, the real message is still delivered to the task owner only through Desktop IPC.
- Added "Automatic initialization session" to the routing configuration page: first reuse and save transaction parsing or idempotent creation, and persist "visible name + complete task ID + workspace", and then deliver the role file, memory, plan and required reading context to the same Desktop task through the role panel and formal AgentPacket chain. If the save fails, no delivery will be performed. If the initial delivery fails, only the saved task ID will be retried.
- Added a special acceptance contract for Codex Desktop, and added the name and ID rebinding, on-demand scanning, unique owner, no fallback and `127.0.0.1:4510` independent life cycle into Agent creation Skill and project-level Agent access control. RabiRoute does not write `CODEX_APP_SERVER_WS_URL`, does not listen for 4510, and does not close or restart Desktop for delivery.
- Regression covers new task index delay, initialization save/delivery sequence and save failure negative examples; all 195 tests, configuration checks, Codex contract checks, backend builds and 607 module WebGUI production builds passed. In the local Desktop real-machine smoke test, existing session delivery and personality initialization both returned `202`, the message was visible in the bound task, and the number of tasks remained unchanged.

## 0.1.9 - 2026-07-16

### NapCat Group file outbound and controlled build product delivery

- NapCat Outbox's local group file no longer relies on the ordinary message `file` segment, uniformly checks `messageAdapterPolicies.napcat.allowedFileRoots` and then calls OneBot `upload_group_file`, supporting the delivery of large files such as APK.
- After the file is uploaded successfully, you can continue to send the reference text; if the description text fails, the result will still retain the fact that "the file has been uploaded" to avoid repeated uploading of large packages during automatic retries. Added `sentFileName` and optional `sentFileId` to the returned results, and the outbound audit record file size and real path.
- Agent can send local group files through unified Outbox request; runtime routing is open on demand `file` output and configure build product whitelist. Only after the actual API returns success can the file be declared as sent, preventing the processor from directly rejecting delivery due to old text permission assumptions.

### Example Rabi full plan efficiency inspection

- The general "One Plan, One Session Task Continuous Tracking" Skill adds forced efficiency invariants: when the plan is not finalized and there is no effective blocking, the bound session task must be in the starting or running state; heartbeat must enumerate all plans and immediately continue or resume all tasks that can be advanced but are idle, failed, or `systemError`.
- Blocking no longer allows writing just "wait". It is necessary to record the evidence, the person in charge who can relieve the blockage, issues to be confirmed, contact results, review time and actions after the blockage is relieved; take the initiative to find the person in charge for confirmation when the blockage is first discovered, and continue to follow up or escalate if no conclusion is reached by the time limit.
- Example Rabi personality and heartbeat template synchronization requires that "the number of advanceable but idle plans is 0" is met at the end of the inspection. During the runtime, the personality can copy the same Skill and perform confirmation by the person in charge through its own authorized message channel.

### RabiLink Glasses Cloud Log

- Relay adds the `POST /api/rabilink/devices/logs` batch entry for application token authentication, and the `GET /manage/api/device-logs` query entry for account session authentication.
- A new "Glasses Cloud Log" has been added to the management console, which can be filtered by device, source, level and keywords, and displays application versions, modes and sessions.
- Logs are written to `data/rabilink-relay/device-logs/<accountId>.jsonl` by account, supporting stable client ID idempotence, retention upper limit and client/server dual desensitization.
- RabiLink AIUI `1.0.17` Added a new non-blocking offline log queue: retain up to 500 entries for 7 days, and re-transmit 20 entries in each batch after being connected to the Internet; the page is persisted first when exiting, without waiting for the network.
- Cloud logs only include running status, errors, and security console summaries; ASR original text, configuration requirements, Agent replies, tokens, and passwords are not uploaded. Normal AIUI does not have permission to read the system global logcat. System-level logs require future privileged device bridge access to the same entrance.
- Added log storage, authentication, account isolation, desensitization, deduplication and AIUI upload regression testing.

### Codex automatic session parsing and complete list- The Codex drop-down of RibiWebGUI is changed to read all unarchived Desktop tasks, and the first 100 items are no longer fixed, and front-end string comparison is no longer used to hide tasks under UNC, mapped disks or extended paths; the interface still only displays the task name and the last session time, and does not display the internal ID.
- Added unified `resolve` entry: accurate binding of valid IDs; automatic search of illegal/invalid IDs by name and normalized cwd; automatic rebinding of unique matches, empty tasks created with zero matches, multiple returned candidates with the same name for user selection. Neither the user nor the AI ​​needs to manually change the UUID.
- When the old configuration mistakenly writes route names such as `RabiLink` into `codexThreadId`, it will automatically move back to `codexThreadName` at the configuration read boundary; invalid IDs will no longer block name resolution at runtime.
- Windows working directory comparison of uniformly normalized drive letters, UNC, and `\\?\UNC`, while preserving failed shutdown when exact ID exists but cwd conflicts.
- The main routing page and quick configuration share the backend resolver, and creation/ambiguity errors are no longer swallowed silently; `offset` paging is added to the thread bridge list, and documents and Agent access Skills are synchronized to record this historical lesson.
- The native complete package has been rebuilt and installed; the backend is consistent with the WebGUI product, and the running scan verification can read 837 Desktop tasks.

## 0.1.8 - 2026-07-15

### Codex Desktop single task owner (final fix)

> This section overrides all older Codex Desktop IPC, app-server fallback and shared 4510 history below this file; older entries are only used to explain version evolution and do not represent current behavior.

- Real messages from the native `codex` adapter are only delivered to the target task owner of Codex/ChatGPT Desktop through Desktop IPC; the messages, run status, and results appear immediately in the desktop task, inheriting the task's own model, tools, sandbox, and approvals.
- Desktop is a required host for native routing. Fails explicitly when the target task cannot be loaded or IPC is unavailable, does not start the isolated app-server, does not connect to the share 4510, and does not have a hidden fallback.
- Removed the Manager's global ownership of `127.0.0.1:4510`, and the desktop configuration entry that persistently writes to `CODEX_APP_SERVER_WS_URL`; legacy environment overrides will not be passed into the short-lived metadata process.
- Route configuration with internal `codexThreadId` as source of truth. The RibiWebGUI drop-down displays "task name + last session time" but hides the ID; when directly entering a name that does not exist, an empty task is first created, and then the Desktop owner receives the first real message and retains the user name.
- The project-locked app-server can only temporarily create and name empty tasks, and does not receive real prompts or perform turns. The old isolated stdio and shared 4510 scenarios are kept in the archive and marked as failed scenarios.
- Added Desktop IPC owner, deeplink wakeup, precise task ID, working directory verification, no fallback and title preservation regression tests.

### Public example: All plan-plan-session tasks

- Example Rabi has added a new general "One Plan, One Session Task Continuous Tracking" Skill, and its scope of application has been expanded from bugs/problems to all plans such as travel planning, research, design, implementation, writing, troubleshooting, etc.
- Once the plan is created, it is necessary to locate or create a formal session task; read the plan, complete task history and binding memory before each round of processing, synchronize write-back and read-back verification after each round, and only stop tracking when the plan enters the final state of completion, cancellation, invalidation or formal replacement.
- Xinghai Architect's ten-minute group takeover, project approval and deterministic closed-loop scripts are converged into the business adaptation layer: the group takeover is only responsible for observation, public claim and duplication prevention, and the universal plan life cycle is unified and reused as an example Skill.

### QQ source citation and Xinghai group chat readability

- When the Agent replies to the NapCat group chat through the normal reply interface, as long as the sources `messageId` and `replyToSource=true` are provided at the same time, Outbox will automatically generate a real OneBot reference reply; both strings and message segment arrays are supported, and existing reply segments will not be added repeatedly.
- The group chat protocol of Xinghai Constructors has been tightened to "one message only corresponds to one session task": claims, plans, approvals, implementations and QA verifications always refer to the original question, and the module and core phenomenon are clearly stated in the first line of the text.
- Heartbeat can only send a maximum of 1-3 messages with real status changes at a time; it is forbidden to continuously send internal reporting techniques such as "I found it out, plan A, can it be changed like this" without leaving the source.

### Codex mission continuation and investigation authority- Xinghai Task Management Skill adds an unclosed task promotion cycle: heartbeat gives priority to reading the true status of existing tasks, active does not interrupt, idle/failed/blocked continues to the next step, and continues to advance until plan approval, implementation, verification or explicit termination.
- Before creating or continuing a task, you must read the current task history and related old tasks, and inject key conclusions, rejected plans, and unfinished actions into subsequent prompts to avoid repeated investigations of tasks by only looking at the latest news.
- RabiRoute The create/send of Agent thread bridge is changed to `workspace-write` by default; Windows sandbox supports using `danger-full-access` to restore the original task when `CreateProcessAsUserW failed: 1312` appears. Operation permissions are separated from business approval, and only investigation is still allowed before approval.

### NapCat Merge forwarding records

- NapCat adapter adds QQ merge forwarding parsing: identify structured `forward` message segments and `CQ:forward`, and query internal chat records through OneBot `get_forward_msg`.
- The outer original message continues to be saved as an audit fact; the expanded time, sender, text, and image, video, voice, and file tags enter `rawMessage` and structured `forwardedMessages`, which can be read directly by historical search, recent context, and Agent.
- If the query fails, the message will not be lost, only `forward_message_resolve_error` will be recorded; if the query succeeds, the forwarding ID and number of nodes will be recorded. A maximum of 100 nodes are reserved for a single forwarding packet, and the rendered text will be explicitly truncated if it is too long.

### Agent Codex official thread bridge

- Manager adds a native `POST /api/agent/threads` interface to provide four formal thread operations of `list`, `read`, `create`, `send` for background Agents that lack the `codex_app__*` connector tool.
- Thread listing and reads use Codex Desktop task state as the read-only source of truth. `create` uses the metadata process only to bootstrap an empty task; both the initial real prompt and later `send` calls go to the target task owner through Desktop IPC.
- Thread creation and renewal are only allowed to use the current RabiRoute configured Codex workspace to prevent the Agent from starting tasks in any directory through the interface; when creating, the security boundary of "only doing investigations and solutions without authorization" is fixed and injected.
- Creating a thread will return `threadId`, source and `initialTurnStatus`; even if the initial turn fails, the created thread can be retained and retried with `send` to avoid repeated creation.
- The one-question-one-thread rule of Xinghai Builder can call the same Manager thread bridge when the connector tool is not injected; this is a call entry replacement, not a second execution runtime or delivery fallback.

### Heartbeat Busy Protection

- A new `heartbeatSkipWhenAgentBusy` switch is added to the route; after enabling it, when the Codex session is still active/in-progress, this heartbeat record will be `skipped/agent_busy` and will no longer be stacked and delivered to the same session.
- Busy judgment is combined with the latest turn final state of Desktop IPC active tasks and Desktop rollout; it can still avoid stacking heartbeats on the working target task when the process has just started or missed the status change.
- RibiWebGUI's "Message Adapter → Scheduled Trigger" and quick configuration add the "Skip heartbeat when session is working" check option; ordinary group chats, private chats and other message types are not affected.
- Supplement configuration normalization and heartbeat busyness judgment tests, and synchronize configuration documents and project function maps.

### NapCat One-click recovery (2026-07-15)- The routing page converges "Open/Auto-Start" to "Open NapCat": with one click, check the existing session, start the binding instance, use the existing quick login, wait for QQ / OneBot to be ready, and automatically repair the HTTP / WebSocket configuration when the account is logged in but the connection does not take effect.
- No longer restart or log in again when the account is online and the account matches; the health check continues to remain read-only, and side effects of startup, login, or configuration repair will only be triggered after the user explicitly clicks on it.
- Verification codes, new device confirmation, code scanning, and the same account being occupied by other windows are not automatically bypassed; the interface only opens the authenticated WebUI of the correct instance and gives a single-step prompt to the user.
- Added automatic and quick login to OneBot-ready management side regression test, covering binding account selection, WebUI authentication and final health status.
- The remote WebGUI coverage audit of RabiLink AIUI will explicitly list the action interface as a prohibited agent to prevent the glasses configuration interface from bypassing the local user click trigger NapCat startup, login or repair.

### Planning and memory writing specifications

- A new single line `focus` topic field is added to plans, recent memories and accumulated memories; new entries must be filled in explicitly. A plan only advances one goal, and a memory only records one fact, preference, conclusion or problem.
- Added global default and personality level `knowledgeLimits`, which performs back-end hard verification on title, topic, body/steps, source summary, keyword length, number of keywords, and total number of text characters; `400` is returned if the limit is exceeded, and no longer silently truncates.
- Added `GET /api/roles/:roleId/knowledge-validation` for auditing old files and manual changes; GameDailyRabi uses a tighter schedule of 1800, memorizes a total character limit of 1500, and splits strips by single topic in a heartbeat.
- Corrected the role knowledge routing priority, `memory/recent`, `memory/consolidated` and other specific resources are matched before the general `memory/:id`; added interface regression, recent memory reading and writing will no longer be misinterpreted as ID query.
- The daily game steward personality has been written into the single-game queue, authoritative evidence, artificial takeover, lightning simulator, natural resources and Blighted City exclusion rules; independent routing is changed to `8798` to avoid conflicts with existing character ports.

### ChatGPT desktop / Codex integration boundary

- RabiRoute remains stable adapter id `codex`: OpenAI is the provider, Codex is the agent/runtime, Desktop IPC is the transport, Codex/ChatGPT Desktop is the task owner, and the specific GPT version is the target task's own model.
- The official delivery of this machine only passes Desktop IPC; the Desktop is not started, the target task cannot be loaded, or the IPC contract fails to close, the user environment is not rewritten, and the backup execution runtime is not started.
- Fixed the thread to use the complete `threadId` as the identity and continue to verify the working directory; the thread name and last session time are only used for user selection to avoid mistaken delivery to historical threads with the same name.

### Models and safe defaults

- Native Route does not override models, tools, sandboxes or approvals; these capabilities are all inherited from the target Desktop task. Compatible fields `agentModel` / `sandbox` must not make another set of task settings.
- Desktop task approval and tool authorization are still handled by the Desktop owner; RabiRoute does not emulate, relax, or replace these capabilities through a secondary runtime.
- Codex runtime approval is independent of RabiRoute Outbox / Action Gate. Approval of Agent execution does not mean that QQ, documents, devices or external APIs have obtained outgoing permissions.

### Runtime and state reliability- Native Route only scans Desktop installations with Desktop IPC ready status, task discovery comes from Desktop status library, real messages go through Desktop owner start/steer.
- Project root-locked `@openai/codex` only serves empty task metadata bootstrap; standalone Remote Agent bridge owns and locks its own unattended stdio runtime on the remote device, neither is allowed to take over the local Desktop.
- The Remote Agent's stdio client preserves concurrent initialization gates, request timeouts, connection close cleanup, and fail-closed server requests; this boundary does not apply to the native Desktop Route.
- Agent status reporting adds gateway process generation and monotonic sequence; Manager only accepts the status of the current process and is updated sequentially, and clears the old status when starting, stopping, and exiting to prevent old asynchronous results from overwriting the new status.
- Codex scans provide Desktop task candidates; the actual identity is confirmed and persisted with the full `codexThreadId` in the Desktop state and the normalized working directory.

### Remote Agent bridge

- The independent bridge is upgraded to the protocol v3 bidirectional HMAC-SHA256 challenge, and the well-known default password is removed; when not configured, a high-entropy temporary password is generated every time it is started, and the Manager strictly verifies the protocol version, challenge, server proof, and device id.
- Both the remote working directory and the return file first pass `realpath` and are verified by allowing the root/current task cwd to prevent junction or symlink from crossing the boundary; the default file synchronization limit is 10 MiB for a single file and 25 MiB for a single task. The Codex defaults to `workspaceWrite` and the network is prohibited.
- Tasks with the same thread target are serialized to the terminal; there is a limited wait when returning to the active turn, and independent threads are created if they cannot be reused safely. `turn/completed` directly extracts the final `agentMessage` return, failure, interruption, unknown status, system error and app-server exit all fail to close, and no longer relies on network callback to end the task.
- Callback and app-server terminal event deduplication; path attachment only allows current task cwd. Optional `REMOTE_AGENT_PUBLIC_CONTROL_URL` only accepts `ws://` / `wss://` addresses with no credentials, no query/fragment, and fixed control path.

### Documentation and Troubleshooting

- README, configuration, architecture, code map, function map, Agent access skills and troubleshooting documents are unified into the "Desktop single task owner, no execution fallback" caliber.
- Troubleshooting portal checks if Desktop is running, IPC is ready, full task ID, working directory and delivery records; fixes with fixed port or user-level `CODEX_APP_SERVER_WS_URL` are prohibited.
- Old unawakened Desktop IPC, isolated stdio and shared 4510 implementations are moved into archives with failure reasons; the live runtime, API and frontend only accept the canonical adapter id `codex`.

### RabiLink AIUI Craft Delivery Chain- RabiLink AIUI Changed from conversational page tool to immersive application entrance, removed unconsumed `description/schema`; the page was changed to 480×352 single surface navigation, Relay state is separated from credential editing, left and right keys switch surfaces, and up and down keys retain vertical scrolling.
- Fixed the vertical stacking caused by the implicit flex main axis in Ink, all horizontal containers are explicitly declared `flex-direction: row`; the maximum height of the theme is separated from the real 352px surface, and the first screen Relay state is no longer cropped in the real Ink rendering.
- `pages/home/index.ink` is now the single maintained page source. Craft staging and local AIX packaging generate the traditional four-file page through the same pipeline and use esbuild to inline local `utils`, so Craft no longer has to resolve relative modules.
- Local AIX root completion `AGENTS.md`, `.aixignore` and automatically generated UUID `VERSION`; added official Ink 0.14 browser run smoke test with official AIX WASM reader Check the package to prevent "Node check passed but Craft module loading failed" from appearing again.

### RabiLink AIUI Active intelligent closed loop (2026-07-14)- The connection dialogue is changed to record-first observation: Glasses ASR only writes unified `rabilink-conversation.jsonl`, and does not interrupt the Codex sentence by sentence; the fixed thread is automatically reviewed when it is idle, the touchpad click can start the review immediately or steer the current turn, and the cycle reflection will also recheck the user goals and unfinished items when there is no new transcription.
- Codex, timers and planners can be written to active downlink without `taskId` at any time through the Rabi output safety gate; Relay outbox is decoupled from the task life cycle and retained for 48 hours by default. AIUI reads the backlog on the first connection, continues to consume according to the cursor and broadcasts in native TTS order.
- User observation, Agent downlink and review control events are written to the same timeline; they are mechanically divided by date or six-hour slot, and no summary is generated. Cross-process locks, atomic index replacement, and orphaned volume recovery ensure no records are missed when Manager/Gateway is used concurrently with Codex offline across volumes.
- The configuration assistant uses the same page AIUI native `SpeechRecognition` and `LanguageModel`. The model can only call the existing RabiLink/WebGUI configuration interface through the whitelist toolcall; after the TTS is completed, the next round of configuration ASR is resumed, and the outer Lingzhu agent can still pass in strict `intent`.
- The confirmed root cause of "Configuration Assistant stopped after saying a word" in Locating Real Glasses: Official `speechSynthesis` is currently not committed to the utterance life cycle event, and the old page is waiting for `onend`, causing the state to be unable to be released; AIUI 1.0.14 uses the document-defined `enqueue` instead. mode, and use a bounded text duration watchdog to ensure that the ASR state machine continues to advance.
- "Switch to connection dialog" in configuration mode is changed to be processed first by the configuration ASR state machine, no longer waiting for `LanguageModel` understanding; the regression test also asserts that this control statement will not create a model prompt.
- Three Playwright/Chrome Ink tests explicitly allow ephemeral ports assigned by the operating system to avoid `ERR_UNSAFE_PORT` false failures when randomly assigned to the browser's safe port list.
- The persistent TTS queue increases the upper limit of 3 automatic attempts for a single item; bad messages are retained for retry but moved out of the queue, subsequent active messages are no longer permanently blocked, and failed items can be recovered by clicking on the touchpad of the connection dialogue.
- The page will no longer persist the injected token; old plaintext tokens and cursor/TTS storage keys containing first and last fragments will be migrated to stable fingerprints without credential fragments. Offline observation, cursor and to-be-broadcasted TTS are isolated by fingerprint, and switching tokens will not cause misinformation or mis-broadcasting across accounts.
- The review of cursors and running evidence is further tightened: the cursor is atomically replaced with temporary files in the same directory and can be recovered from a damaged state; the running proof only accepts the current version, within 20 minutes, and the combination of startup and Relay/configuration activities of the same page session, and old packages and isolated historical events are no longer misjudged as the success of the current real machine.
- AIX reuses a UUID with the same batch of Craft staging/installation manifests and verifies them file by file; device readiness only accepts CXR evidence within 10 minutes or current direct connection to ADB, and historical power reports no longer pretend to be current glasses connections. Final 1.0.14 still awaits user authorization upload, review, phone addition and real glasses ASR/TTS/touchpad verification.
- Added desensitized `examples/data/route/RabiLink` + `roles/RabiActive` paired templates, and completed the complete sample package readability and port conflict regression; only enable `main`, RabiLink, voice, Xiaoai and enterprise WeChat templates after the first copy sample is configured and then explicitly enabled.
- WebGUI quickly started to fill in the necessary step of "enable PC RabiLink Route", making it clear that the global connection only allows PC to be online before Route decided to unify the ledger, fix the Codex thread and RabiActive personality; use Vue Router for internal jumps, and no longer jump back to the server root path under the remote prefix.
- Cloudflare Worker CORS added AIUI Bearer `Authorization` and mobile target switching `PATCH`; public network and Worker smoke test added no pre-task active delivery, stable `deliveryId` retry deduplication and summing `stream=1` Only consumption verification.
- Added optional `rabilinkRecordFirstSources`: FenneNote or named webhook resident transcribers can use stable message identity into the same RabiLink JSONL as idle reviewerThe callbacks with the same message ID, or the same production-side timestamp and body will be deduplicated and will not create Codex turn sentence by sentence; they will be left blank by default to avoid mistaking the PC microphone for background recording on the glasses.
- The local AIUI acceptance matrix has been expanded to 20 items, and a new resident transliteration record-first item has been added; webhook retries with production-side timestamps but no explicit message IDs also use stable observation identities to deduplicate. live E2E and `goal-evidence` share a list of key implementation files. The report is bound to the release version, AIX SHA256, implementation summary and default 60-minute aging. Reports generated by old deployments or old code will be clearly marked as `stale-live-e2e` and will no longer pretend to be current active intelligent closed loops.### RabiLink PC Global Connection

- `data/Config.json.rabiLinkRelay.enabled` is now an explicit global switch instead of being inferred from the presence of a URL and token. Legacy configuration without the field is migrated using the previous inference rule.
- Manager adds a new resident Relay runtime: immediately registers the PC and acts as a proxy for the remote RibiWebGUI after the global switch is turned on, and no longer requires a certain `rabilink` route to be started first.
- The "Rabi instance" of RibiWebGUI adds an immediately effective "Connect to Server" switch and connection status; when the credentials are incomplete, it refuses to open and retains the original status.
- The route-level RabiLink worker continues to be responsible for receiving message tasks and returning Agent replies; remote WebGUI requests are uniformly received by the Manager to avoid multiple routes competing for the same request.

## 0.1.7 - 2026-07-09

### Active Intelligence General Outline

- Added the proactive-intelligence design note, organizing goals, device responsibilities, event types, intent understanding, action levels, memory systems, mobile apps, local agents, privacy, security, and MVP scenarios into one system overview.
- The document makes it clear that the core of active intelligence is not question answering or single device capabilities, but continuous perception, multi-device context fusion, low-intrusion active decision-making and local Agent execution closed loop.
- Supplement the L0-L5 action level, active behavior scoring model and high-risk operation confirmation boundary to provide a unified product judgment caliber for subsequent RabiLink, mobile app, glasses HUD, behavior log and memory management implementation.

### RabiLink Native active intelligent design

- Added `docs/rabilink-glasses-app-design.md`, converging the next stage of RabiLink into mobile phone resident recording bridge, Relay/local Agent connector, mobile phone configuration console and `Rabi Glass` low-interference HUD.
- The document clarifies that the first version does not rely on the native ASR/TTS of the glasses: the main link first uses mobile phone recording, VAD sentence segmentation, mobile phone ASR, Relay task, PC Rabi worker, RabiRoute `rabilink` route and global downlink messages.
- Retain Rokid/Lingzhu official assistant and existing testing capabilities as compatibility and troubleshooting paths, and store the test entrance as `RabiLink Lab` to prevent the test bench from continuing to occupy the main process of ordinary users.
- Supplement the privacy boundary of resident awareness: explicit opening, continuous status prompts, original audio/pictures not saved for a long time by default, and saving, uploading, delivering, retrying and clearing are designed to be visible and controllable.

### RabiLink AIUI Implementation Progress (2026-07-13)

- Added AIUI example on the glasses side, the product mode converges to "Connection Dialog" and "Configuration Assistant"; the connection dialog uses the glasses' native ASR/TTS, the configuration assistant is normalized by the Rokid native Agent intent, and the page no longer maintains assistant tasks or private ASRs.
- Added `/rokid/rabilink/input` input event and `/rokid/rabilink/messages?stream=1` continuous downward contract; glasses do not hold worker taskId, and ordinary Agent replies and active messages without previous tasks share the application-level ordered queue.
- RabiRoute `/api/agent/replies` supports `targetType=rabilink`, `proactive=true`, and appends active messages to Relay `/worker/messages` through the route output policy; the Manager will pass the actual route/global Relay configuration to the publisher.
- AIUI 1.0.5 has passed source code audit, real HTTP Relay integration, Ink operation, AIX package inspection and 18/18 local acceptance; upload, review, mobile phone synchronization and real glasses ASR/touchpad/active broadcast still need to be independently accepted when the device is available.
- AIUI The page tool no longer sets `token` as required before calling: when `rabilinkToken` is not bound, the HUD is first rendered and displayed waiting for connection. After binding, only variable references are still allowed; finally, the AIX audit will reject the old package, and the real Ink smoke test completely omits the token by default field to override the first time the scene is opened.

## 0.1.6 - 2026-07-08

### RibiWebGUI UI/UX- The quick configuration pop-up window complements the loading during saving, the saving failure prompt and the display of blocking reasons to avoid silent closing or no feedback when saving fails.
- The log diagnosis page puts the culture in the manual trigger area and directly displays the results after the trigger succeeds or fails, making it easier to continue viewing the latest logs from the same page.
- The personality message template rule page adds in-place prompts for routing type wide matching, regular, heartbeat plan and empty template description to help discover high-risk rules before saving.
- NapCat The "Open WebUI" of the QQ instance card will give priority to using the WebUI login Token read by the Manager to open the login address with the token, avoiding the need to manually enter the token when entering NapCat from the Rabi entrance.

### Project Function Manual and Agent Context

- Added `docs/project-function-map.md` and the RibiWebGUI `/#/docs` search page. They index each function's source of truth, consumers, activation point, side effects, code entry, and design boundary for feature work, troubleshooting, and Agent handoff.
- Added `docs/persona-route-workbench-plan.md` to clarify that the personality page should be transformed into a "rule preview and diagnosis workbench for bound routes" instead of a multi-personality smart hit or duplicate routing configuration page.
- `personaConfig.json` Added `recentMessageLimit`, AgentPacket will be configured with the latest message summary according to route/persona; the default is 10, set to 0 to turn it off, and additionally configure the read and write and packet injection tests.
- RabiLink adapter is detached as an independent module, and the Relay worker and local replies query are separated from the general webhook adapter, retaining the general entry responsibilities of webhook/FenneNote/XiaoAi.
- Codex delivery link adds visibility guarantee for Windows Codex App: new listening thread, long-unloaded thread resume, Desktop IPC delivery and app-server fallback will try to start/focus `Codex.exe`, and write the result to the `lastCodexAppVisibility*` diagnostic field.

### Windows desktop startup and full package boundaries

- Windows launcher, tray frozen mode and packaging scripts will check whether the backend `dist/manager.js` and `ribiwebgui/dist` are missing or expired, and automatically build them according to the scenario.
- `docs/windows-launcher-and-packaging.md` is now the source of truth for Windows startup and packaging. It clarifies that `RabiRoute-Desktop.exe` is the entry for the complete desktop application, not a self-contained single-file package.
- The packaging script will output `RabiRoute-Desktop.new.exe` when it cannot overwrite the running `RabiRoute-Desktop.exe` to avoid the build result from directly failing or misleading users.

### RabiLink Server Console and Remote PC WebGUI- The Relay management entrance is unified as `/manage`. After logging in, enter the "RabiLink Server Console"; the same server supports multiple accounts, and each browser session only maintains one current login account. The applications, tokens, PC Rabi connection records and session status between accounts are isolated from each other.
- The server console displays the PC Rabi instances connected under the current account and provides an "Open PC WebGUI" entry. `/manage/<account>/<RabiGUID>/#/routes` loads the server-hosted RibiWebGUI static frontend and forwards reads and writes through the Relay worker to that PC's local Manager.
- Relay now provides a WebGUI request queue, worker claim/response APIs, HTML/JavaScript/CSS path-prefix rewriting, and configurable body-size and wait limits. The server does not keep a copy of PC configuration; the PC Manager remains the source of truth.
- Application tokens continue to display previews in the console card by default, but the "Copy token" button after login will copy the full token at any time and is no longer limited to a single display window after creation or regeneration.
- Relay tightens the application token master-slave relationship: the old public token no longer participates in RabiLink task authentication. The glasses task must be bound to the Rabi PC currently selected by the application; an error is returned directly when the PC is not selected, the bound PC does not exist, or is offline, and no target tasks will be created that will be claimed by multiple PCs.
- Added `AGENT_TOKEN` OpenAPI public/template import version: the publisher token is not written at the plug-in level, `submitRabiLinkTask` uses body `token`, `getRabiLinkMessages` uses query `token`, and is bound to the respective agent tool parameters RabiLink application token.
- RabiLinkMessage The plug-in description supplements the GitHub instructions link and points to the RabiRoute icon in OpenAPI `info.x-logo` to facilitate the supplement of the introduction and icon after the public plug-in is imported.
- The server console has added a "recent log" card isolated by account: recording plug-in submission, downstream polling, PC Rabi receipt/reply, remote WebGUI request and other desensitized summaries to facilitate confirmation of whether the message reaches the server without exposing the complete token.
- The Relay worker will carry its own PC identity when sending back ordinary message tasks and remote WebGUI responses. The server only accepts the PC Rabi return packet selected by the current application to avoid data cross-talk between multiple PCs under the same account or different accounts.
- The Cloudflare Worker agent no longer supports injecting public forwarding tokens; public/multi-account modes must pass in their respective RabiLink application tokens through plug-in authentication or agent tool parameters, and the test script also uses `RABILINK_RELAY_APP_TOKEN`.
- Relay server no longer reads the old `RABILINK_RELAY_TOKEN`, and the deployment script no longer accepts the old public token parameter; PC workers officially use `RABILINK_RELAY_APP_TOKEN`, the console and mobile terminals no longer automatically select the first PC Rabi, and an error will be clearly returned when the target is not bound.
- The old `/admin` console entry is removed from the Relay server and Caddy deployment configurations, and the official entry only remains `/manage`; the `/webgui` subpath of the remote PC WebGUI is still redirected to the new path as a declared compatible entry.
- RabiLink The worker startup environment is changed to issue `RABILINK_RELAY_APP_TOKEN`, and `npm run relay:rabilink:legacy:check` is added to prevent the old public token, old `/admin` entry and automatic selection of PC logic from being reflowed.
- The runtime configuration field naming is changed to `rabiLinkRelayAppToken`, and the old route-level `rabiLinkRelayToken` is only read as a migration-compatible field; the route fallback name is also changed from legacy to route-level fallback to avoid mistakenly returning to the old semantics in subsequent implementations.
- The old mobile phone App Webhook / WebSocket access solution is clearly marked as a historical document; RabiLink quick configuration, project function map and document homepage are all changed to point to the current Relay main link to avoid subsequent implementation from the old mobile phone bridge solution.
- `npm run relay:rabilink:legacy:check` extended to documentation and WebGUI help entries, preventing old mobile webhook documentation, old "RabiLink direct" naming, or old help links from becoming current implementation entries again.
- `npm run relay:rabilink:legacy:check` Continue to add account isolation guards and fullBureau legacy scan: Console state, log API, application additions, deletions, and remote WebGUI target resolution must be filtered according to the application collection of the current account; old public tokens, old `/admin`, old mobile phone bridge API, automatic PC selection, and old naming can only appear in the history/migration locations of the explicit whitelist.
- The deployment script uploads `ribiwebgui/dist` and the required static assets so the server can host the remote PC WebGUI independently. The old `/manage/<account>/<RabiGUID>/webgui/...` path remains a compatibility entry.

### Mobile APK binding to RabiLink

- Android RabiLink SDK adds server mobile state, PC list, remote Manager configuration, Route list and Codex binding reading and writing capabilities.
- The mobile phone sample APK is adjusted to the main process of "Connect to server -> Select PC Rabi -> Select Route -> Select Codex workspace/session -> Save binding", and LAN scanning is downgraded to a backup diagnostic entrance.
- The default server address of the public example uses the `https://rabi.example.com` placeholder to avoid writing the real service domain name into the submittable source code.

### Rokid Glasses Test APK

- The glasses side test APK is renamed to `Rabi Glass Test`, and uses a pure black background to achieve Rokid optical transparency to avoid the Android translucent window from revealing the launcher or the residue of the glasses main menu.
- The glasses HUD is condensed into a single-line operation bar at the bottom: send text, ping, status, diagnosis, register offline and clear offline. Focus is maintained by an explicit ring index, and the selection is enlarged and centered, no longer falling on the post or title.
- The touchpad/direction key interaction is changed to a "previous/next/confirm" three-action model: sliding only switches the focus once when you let go, and repeated key/touch events will be deduplicated to avoid skipping two buttons with one swipe.
- Before starting the glasses CustomApp, it will try to close the old CustomView, and the Activity uses the stable startup mode and hides the system bar to reduce repeated startups and overlay residues.

### Local verification

- `npm run build` passed.
- `node --check scripts/rabilink-relay-server.mjs` passed.
- `:app:assembleDebug` passed, the mobile phone APK was successfully installed, and the glasses APK was successfully installed after retrying and the CustomApp was started.
- `ar-glasses-gui-design` skill verification passed.
- Online Relay has been deployed and verified that `https://rabiroute.cottongame.com/health` and `/manage` are accessible, and the console page has been updated with "copy complete token at any time" logic.

## 0.1.5 - 2026-07-07

### NapCat WebUI connection maintenance

- The QQ instance card of RibiWebGUI is changed to the active action of "Open WebUI": before opening, the discovered NapCat instance will be automatically added to the configuration, the instance will be enabled, the port and login information will be completed, and the OneBot HTTP/WS configuration will be written when it can be repaired.
- NapCat health check supplements the diagnosis that the WebUI is reachable but does not read the QQ login status, prompting the user to first complete the QR code scan or front-end login in the NapCat WebUI; RabiRoute only maintains the connection configuration and does not replace the NapCat/QQ login.
- The WebGUI build target is adjusted to `esnext`, which retains the current front-end syntax output and avoids incorrect downgrading of modern syntax during the build phase.
- `.gitignore` Add root directory `.venv-tray/` to prevent native tray packaging virtual environments from entering submission candidates.

### RabiLink Relay direct connection- RabiLink The main link is adjusted from "mobile phone bridge transfer" to "computer side RabiLink worker directly connected to the public network Relay": Rokid/Lingzhu plug-in submits the task to Relay, and the PC where Rabi is located directly receives the task and delivers it to the current RabiRoute/Codex Route and write incremental replies back to Relay.
- Relay server adds server side `/admin` WebGUI: supports first-time account registration, account and password login, creation/start/stop/delete RabiLink application, regeneration of independent `rbl_...` application token; the complete token is only displayed once when creating or regenerating.
- The Relay task queue is identified and isolated by application token. Rokid/Lingzhu plug-in, computer-side worker, task message query and global downlink message list can only access the tasks of the corresponding application; the old `RABILINK_RELAY_TOKEN` was only reserved as a compatible global token at that time, and has been abandoned from RabiLink task authentication since 0.1.6.
- WebGUI's `rabilink` endpoint adds Relay address, token, device name, collection wait, and reply idle-timeout settings. The token is saved in private local `data/route/<config-name>/adapterConfig.json` and is no longer written to the public example.
- The formal interfaces of Relay workers are unified into `/worker/tasks`, `/worker/tasks/<taskId>/messages`, `/worker/tasks/<taskId>/finish`, and no longer rely on `/phone/tasks`.
- Rokid/Lingzhu side continues to use global downlink `/rokid/rabilink/messages` to pull messages: no taskId is required, pull it one sentence at a time, each message has its own taskId, until the PC worker finish ends this round.

## 0.1.4 - 2026-07-06

This update merges the RabiLink mobile bridge, Rokid/Lingzhu public network relay, Android probe engineering and delivery compensation capabilities into the public engineering structure of RabiRoute, and cleans up the old `android-band-probe` / `vela-band-probe` example naming.

### RabiLink bridges with Rokid- Added `rabilink` message side configuration: support `/rabilink` inbound, independent `rabilink` route kind, `rabilink-voice-transcripts.jsonl` record, RabiLink dedicated outbox reply file and WebGUI quick configuration, no longer confuse mobile bridge messages as ordinary `voice_transcript`.
- Added RabiLink Relay service script, deployment script and Rokid OpenAPI example, which are used to transfer Rokid/Lingzhu Cloud plug-in to mobile phone RabiLink via public network relay, and then send it to computer RabiRoute/Codex.
- Rokid/Lingzhu plug-in public OpenAPI is changed to continue to pull downlink messages through the global `/rokid/rabilink/messages`, and the glasses end is no longer required to press `taskId` to pull; each downlink message comes with `taskId`, and the glasses end should be pulled to say one sentence until Rabi/Codex The side is completed and then finished by the mobile phone bridge.
- The default long polling waiting time of the Relay server is uniformly adjusted to 60 seconds, covering Rokid request waiting, task messages pulling, global downlink message pulling and mobile phone bridge picking tasks, reducing frequent empty polling on the glasses side.
- Mobile phone bridge finish will wake up Rokid global downlink long polling even if it does not come with the final text, to prevent the glasses end from continuing to display thinking when "it has ended but there is no new sentence".
- Added a dedicated OpenAPI for "Import Tool" on the Rizon plug-in details page: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json`; it only imports `submitRabiLinkTask` and `getRabiLinkMessages` to avoid the old taskId debugging tool from affecting formal agent polling.
- Added the preferred Postman Collection for "Import Tool" on the Rizon plug-in details page: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json`; used to bypass the occasional URL prefix conversion misjudgment when importing the Rizon OpenAPI tool. The Postman tool import is changed to a complete HTTPS URL, no longer using the `{{base_url}}` variable, and providing a URL import entry through `/rokid/rabilink/tools.postman.json`.
- Added Android RabiLink SDK and `examples/android-rabi-link-probe/` test projects to uniformly carry Xiaomi Health, Rokid, RabiRoute manager discovery and relay bridge probes.
- RabiLink webhook adds a new `/rabilink/replies` read-only packet return interface. The Android mobile phone bridge reads the Codex/RabiRoute reply from the callback service to avoid relying on only binding the local Manager port in a LAN environment.
- Android RabiLink probe enhances resident bridge status display, bridge log echo and scan button status; LAN scanning and public network Relay bridge operation are independent of each other. Repeated clicks will be disabled during scanning but the running bridge will not be blocked.
- Added `examples/rabi-link-vela-probe/`, replacing the old Vela bracelet probe naming.

### Delivery Compensation and Desktop Reliability

- Codex Desktop IPC adds wakeup, app-server fallback and delayed retry logging when encountering `no-client-found` to reduce message loss when the target thread is not loaded.
- Forwarding adds delivery replay ledger, route delivery result log and manager replay API to facilitate replaying failed or missed delivery messages from the WebGUI/diagnosis.
- The Windows tray startup script supports locating Node from environment variables, project directories or workspace `tools`, and avoids accidentally killing Qt tray parent and child processes.
- Added health/message-adapter watchdog startup script and tray icon packaging configuration.

### Public security- RabiLink relay, Rokid OpenAPI, Android probe default values ​​have been desensitized to placeholder domain names, empty tokens or sample paths.
- The active RabiLink OpenAPI import is now a runtime file under `data/rabilink-relay/` and is ignored by Git. The repository keeps only sanitized examples under `examples/rabilink-relay/`, preventing real domains, server addresses, or token-related runtime configuration from being published.
- `.gitignore` Add root directory `.tmp/`, `out/`, `reports/` and tray exe backup exclusions to avoid submitting native run output.
- Public example Rabi persona adds RabiLink bridge boundary memory; native Rabi run memory also records synchronously but does not commit.

### Local verification

- `npm test` passed, 86 tests covering paths such as RabiLink outbound, delivery replay, Codex IPC fallback, route configuration, NapCat/WeCom, memory and role skills.
- `npm run build:backend` passed.
- `npm run relay:rabilink:openapi:check`, `npm run relay:rabilink:worker:check`, `node --check scripts/rabilink-relay-server.mjs` and `git diff --cached --check` pass.
- RabiLink OpenAPI cleaned up and ran again `npm run relay:rabilink:openapi:check`, `node --check scripts/rabilink-relay-server.mjs`, PowerShell deployment script parsing and `git diff --check`, all passed.
- RabiLink After the tool import is changed to the Postman Collection preferred, run `npm run relay:rabilink:openapi:check`, `node --check scripts/check-rabilink-openapi.mjs`, skill quick validate and `git diff --check` again, all pass; `git diff --check` only prompts the workspace CRLF newline conversion.
- The local Relay smoke verification passes: submit the task, write/finish on the mobile phone side, and pull the Rokid end from the global message queue to the downstream message with `taskId`; the second task will not reread the historical messages of the first task.

## 2026-07-06

This update puts the RabiRoute dedicated GitHub pull/submit check skill into the warehouse, making it easier for agents on other computers to directly reuse the same set of collaboration rules.

### Agent collaboration

- Added `skills/rabi-github-pull/` to record how to check the local status, read the update log, backup the runtime configuration before pulling, and upgrade the local configuration according to `examples/data/` and migration instructions.
- Added `skills/rabi-github-submit/` to document how to check changes before committing, update the project log, synchronize Rabi local/public example context, and avoid committing runtime private data.
- The description documents of `rabi-github-pull` and `rabi-github-submit` retain the original pull, migration, desensitization, submission and push rules to facilitate direct reading and reuse in the Chinese collaboration environment.
- The README directory structure supplements the two GitHub collaboration skill entrances to facilitate discovery after cloning the repository in the new environment.

### Local verification

- `git diff --check` Passed.

## 2026-07-04

This update adds Xiaomi Band/Xiaomi Health Data Probe handover data, making it easier to continue to verify "whether the Android APK can pull the complete heart rate list" on another computer.

### Xiaomi bracelet probe- Added Android test APK project `examples/android-rabi-link-probe/`, used to detect BLE, Health Connect, Xiaomi Health local Provider and Xiaomi Health Cloud SDK/OAuth data link.
- Android probe supports Xiaomi Health Cloud default heart rate type pulling, full SDK data type deep scanning, paging/sharding pulling, raw HTTP recording, automatic saving ZIP, sharing ZIP, completion notification and diagnosis summary.
- Added Vela fast application probe project `examples/rabi-link-vela-probe/`, which is used to verify the basic capabilities and interconnect communication boundaries of wearable end fast applications.
- Added handover document `docs/xiaomi-band-heart-rate-probe-handoff.md`, recording current conclusions, build commands, mobile phone independent test process, ADB test process, ZIP parsing method and blocking points.
- Updated `.gitignore` to exclude Android/Vela build products, logs, decompilation output, node_modules, APK/RPK and native heart rate results package.

### Current verification status

- Ordinary APK direct reading of Xiaomi Health Provider is still subject to permission restrictions; `heartrate/recent` only proves that it can read the latest heart rate.
- Health Connect currently does not read the data written by Xiaomi Health.
- The full heart rate list of Xiaomi Health Cloud still lacks the `mi-health-cloud-*.zip` evidence package exported by the real mobile phone, which has not yet been certified.

### Local verification

- `examples/android-rabi-link-probe/scripts/Export-RabiLinkProbeApk.ps1 -Build` Passed, debug APK generated.
- `examples/android-rabi-link-probe/scripts/Convert-MiHealthCloudJsonToMarkdown.ps1` Verified raw dataSource / dataPoint parsing with mock ZIP.
- `adb devices -l` is continuously empty on the original machine, and the actual machine verification needs to be continued on the new computer.

## 2026-06-30

This update adds the Enterprise WeChat/WeCom intelligent robot message terminal, allowing RabiRoute to access group chat messages through the Enterprise WeChat WebSocket long connection, and send them back to the original Enterprise WeChat group chat through the unified outbox.

### Enterprise WeChat messaging terminal

- Added `wecom` message adapter, `wecom_chat` pipeline preset and `wecom_message` route kind; enterprise WeChat messages will be written to `wecom-messages.jsonl`, and then enter forwarding, RouteDecision and AgentPacket.
- Added `src/wecom.ts` SDK packaging to centrally handle enterprise WeChat intelligent robot connection, text/Markdown sending, media uploading and sending, and error normalization.
- `/api/agent/replies` supports postback to enterprise WeChat group chat according to `replyContextJson` or explicit `adapterType: "wecom"`, and adheres to the output switch and payload type restrictions of `messageAdapterPolicies.wecom`.
- Manager and RabiWebGUI add new enterprise WeChat configuration, status scanning, message log and adapter log views; WeCom does not declare the local ingress port.
- Added `docs/wecom-integration.md` and `examples/data/route/wecom/adapterConfig.json`, public examples only use placeholder Bot ID, secret and local path.

### Local verification

- `npm test` Overrides WeCom pipeline, gateway config model and outbox return paths.
- `npm run build:backend` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-18

This update adds a searchable Skill Library to the Rabi character context, so that the skills in the character directory can be recalled as lightly as plans and memories.

### Character skill library- Added `skills/*.md` convention to the role directory; each skill uses Markdown body and frontmatter, including `id`, `title`, `summary`, `keywords`, `updatedAt` and `status`.
- `roleKnowledge` will read skill meta-information and incorporate `role_skill` into the same set of lightweight recall and pre-processing confirmation processes in planning/memory.
- AgentPacket injects `id + title + summary + GET path` for available and matched skills, but not the skill body by default.
- Manager adds new read-only interfaces `GET /api/roles/:roleId/skills` and `GET /api/roles/:roleId/skills/:skillId`; the list returns meta information, and a single query returns the complete text.
- Added companion response, RabiRoute description and configuration troubleshooting three example skills to the public Rabi example, and updated the Agent interface and context injection documentation.

### Local verification

- `npm run test` Passed, covering the paths of skill meta-information reading, skill recall, and AgentPacket not injecting skill text.
- `npm run build:backend` passed.

## 2026-06-18

This update adds file transfer capabilities to the remote Agent, allowing the host to send files along with the task, and the remote end can also bring product files back to the local machine.

### Remote Agent File Transfer

- `/api/remote-agent/tasks` supports `filePaths`, `files` and `attachments`; the manager will read the content of the local file and send it to the remote bridge through the authenticated WebSocket control channel along with the task.
- The remote bridge will save the task file to the remote runtime inbox directory, and list the file name, size, sha256 and actual path in the remote Codex task prompt.
- Remote callback supports `artifactPath`, `logPath` and `files[].path`; bridge will read the content of the remote local file and send it back to the manager.
- Manager will save the returned file to `data/remote-agent-files/<taskId>/`, and record the local save path, size and sha256 in the task event `savedFiles`.
- File transfers have no size limit by default; if you need to protect a specific deployment, you can set the limit explicitly via `REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES` and `REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES`.
- The Bridge control port will verify that `127.0.0.1:<port>/health` is indeed returned to itself; if the local loopback is occupied by the old service, the port will be automatically postponed to prevent the remote Codex callback from hitting the old process.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` Passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` passed.
- `npm run build:backend` passed.
- Started the native bridge through the Rabi Manager API, scanned connections, posted messages and files to the Codex session in the project root, and successfully returned `result.txt` containing intact non-ASCII text.

## 0.1.3 - 2026-06-18

This update corrects the NapCat WebUI port probing and health check backfill behavior, and upgrades the project version from `0.1.2` to `0.1.3`.

### NapCat Health Check

- NapCat The health check request will carry the gateway id and instance id, so that the manager can accurately backfill the detection results to the corresponding instance.
- Manager will read the actual port in NapCat `webui.json` and try to correct it to the actual port of the local machine when the configured WebUI address is unreachable.
- Health scans and single health checks will write the corrected WebUI address back to the adapter configuration, and explain the automatic correction results in the response diagnostics.
- RabiWebGUI will give priority to the corrected WebUI URL returned by the backend to prevent the frontend from continuing to save expired ports.

### Codex thread discovery- Codex App will traverse the threads with the same name and select the first readable thread to reduce the misjudgment of duplicate threads when the latest thread with the same name is unreadable.
- Desktop IPC fallback calls revert to normal app-server delivery, with the Codex App itself handling readable thread selection.

### Version and Verification

- The project version number is synchronized to `0.1.3`, covering `package.json` and `package-lock.json`.
- `npm test` passed.
- `npm run build` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-18

This update fixes the issue where the remote Agent occasionally encounters `Remote Agent connection timed out` when multiple network cards, VPNs, or LAN address announcements are inconsistent.

### Remote Agent control connection

- After Rabi manager scans the remote bridge, it will give priority to using the actual source IP of the UDP discovery response to splice the WebSocket control address, instead of fully trusting the host self-reported by the bridge.
- The remote bridge control port still comes from the real port in the discovery response; the process of automatic port deferral and the GUI eliminating the need to manually fill in the port remains unchanged.
- Added a new regression test to cover the control URL generation when "bridge self-reported address and actual source address are different", reducing the probability of successful scan but connect timeout in a multi-network card environment.

### Local verification

- `npm test` passed, 62 tests covering remote Agent password handshake, control URL generation, task attribution, NapCat startup plan, configuration migration, message return, plan/memory recall and gateway config model and other paths.
- `npm run build:backend` Passed.

## 2026-06-17

This update adjusts the remote Agent to the unattended mode of "RabiGUI master scan and connect", and no longer requires the remote plug-in package to configure the manager address or token.

### Remote Agent master connection

- `plugin-adapters/remote-agent-rabiroute` Zero-configuration startup: default password `123456`, control port automatically finds available ports starting from `8797`, UDP discovery automatically selects available ports from `8798-8818` range.
- Rabi manager adds `/api/remote-agent/scan`, `/api/remote-agent/connect` and `/api/remote-agent/disconnect`, and RabiGUI scans the LAN remote bridge, enters the password to connect and remembers the password.
- The remote Agent password is passed through the WebSocket first packet handshake, and URL query is no longer included; the task result still verifies the device ownership, and the local Codex callback only accepts local requests from the remote machine.
- The remote Agent message panel of RabiGUI has been changed to "Scan LAN -> Select device -> Enter password -> Connect" and does not provide port input; port occupation is automatically handled by bridge and manager scanning.

### NapCat Start reliability

- NapCat Automatic startup will recognize the outer shell launcher, give priority to the inner `launcher-user.bat`, and fill in the `-q` quick login parameter if there is a botUserId.
- The startup and restart interface will wait for OneBot `/get_status` or WebUI to be reachable before returning results. When timeout occurs, diagnostic information will be brought back to RabiGUI.
- Added NapCat launch plan unit test, covering outer shell redirection and existing quick login parameter retention.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` passed.
- `npm run build:backend` Passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` Passed.
- `node --import tsx --test src/messageEndpoints/napcatManager.test.ts` Passed.
- `npm test` passed, 61 tests cover the remote Agent password handshake, NapCat startup plan, task attribution, configuration migration, message return, plan/memory recall and gateway config model and other paths.
- `npm run webgui:build` passed.

## 0.1.2 - 2026-06-16This update corrects the fallback behavior of Codex Desktop IPC when no desktop client accepts fixed threads, and upgrades the project version from `0.1.1` to `0.1.2`.

### Codex Delivery

- Desktop IPC allows the app-server fallback to be used when encountering `no-client-found`, so that delivery can continue even when there is an existing bound thread and no desktop client.
- App-server fallback can force the creation of a new thread when an unreadable duplicate thread with the same name is clearly encountered to avoid unreadable duplicate threads blocking necessary delivery.
- Clear `lastNotificationError` and `lastNotificationErrorAt` to empty strings after successful delivery to ensure that the status file does not retain stale error values.

### Testing and Versioning

- Added `src/codexDesktopIpc.test.ts` to override the default behavior of allowing fallback and environment variables to turn off fallback.
- The project version number is synchronized to `0.1.2`, covering `package.json` and `package-lock.json`.
- `npm test` passed.
- `npm run build:backend` passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 0.1.1 - 2026-06-16

This update completes Codex delivery, manual trigger execution context and XiaoAI bridge default port, and upgrades the project version from `0.1.0` to `0.1.1`.

### Codex delivery and trigger context

- The Windows tray will URL-encode the gateway id before manually triggering the manager API to prevent special characters from damaging the `/gateways/:id/manual-trigger` path.
- Codex App / Desktop IPC Delivery uniformly uses explicit model selection functions and no longer reads the native Codex configuration file as an implicit default.
- When Codex App finds a thread with the same name but the current channel is unreadable, it will refuse to automatically create a duplicate thread to avoid spreading messages to multiple listening threads with the same name.
- Codex Desktop IPC allows app-server fallback by default, but will give priority to refreshing the discovered listening threads to avoid automatic creation when there are already threads.

### Agent Packet and XiaoAI

- Manual triggering and heartbeat events inject execution requirements, reminding the handler to execute in the current Codex session and output visible results.
- When `plan-*` is referenced in the manual trigger template, the active/archived plan summary in the role directory will be read and the specified plan content will be injected.
- XiaoAI bridge default port is adjusted from `8798` to `8799`, and the local speaker direct playback branch in the current configuration is removed.

### Version and Verification

- The project version number is synchronized to `0.1.1`, covering `package.json` and `package-lock.json`.
- `npm test` Passed, 56 tests covering forwarding, configuration warehouse, Agent packet, heartbeat schedules, route identity and gateway config model.
- `npm run build:backend` Passed.
- `py -m py_compile desktop/tray-task-window/rabiroute_tray/manager_client.py` Passed.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-16

This update fixes the startup and discovery self-healing capabilities of the remote Agent bridge, preventing the remote device from registering until the manager is ready and discovery happens to get the correct network card address.

### Remote Agent connection reliability- `plugin-adapters/remote-agent-rabiroute` Upgrade to `0.1.1`: The bridge will save the selected manager, continue LAN discovery in the background, retreat and reconnect after disconnection, and keep running when the manager is not found for the first time and wait for subsequent online.
- Bridge discovery now simultaneously detects general broadcasts and directed broadcasts for each network card, reducing the probability of discovery failures caused by cross-network card, ZeroTier/Tailscale or router broadcast policies.
- Manager's Remote Agent discovery supports `REMOTE_AGENT_PUBLIC_HOST` / `GATEWAY_MANAGER_PUBLIC_HOST` explicit advertisement addresses; when not set will bypass WSL, TAP, vEthernet and link-local addresses in favor of real LAN/VPN addresses.

### Local verification

- `node --check plugin-adapters/remote-agent-rabiroute/index.mjs` passed.
- `npm run build:backend` passed.
- `node --import tsx --test src/messageEndpoints/remoteAgentManager.test.ts` Passed.
- `npm test` Passed, 58 tests cover remote Agent task ownership, configuration migration, message return, plan/memory recall and gateway config model and other paths.

## 2026-06-11

This update continues to push the multi-processor boundary of RabiRoute to "local personality scheduling remote Agent device", while tightening the plan/memory context injection and configuration migration links.

### Remote Agent and Multiprocessor

- Added `remoteAgent` message terminal type and independent `plugin-adapters/remote-agent-rabiroute` bridge; the remote machine only needs to run the bridge, and the local personality delivers the task through the RabiRoute API. The remote result is returned and then injected into the local personality thread.
- Manager adds remote Agent device discovery, task delivery and task event interfaces, and displays online remote devices, default device/cwd/thread settings and connection entries on the WebGUI routing configuration page.
- The Remote Agent REST portal now requires `REMOTE_AGENT_TOKEN` for non-native requests. The task event will also verify that the event source device must match the device to which the task belongs to avoid forging task completion results in the same network segment.
- Agent packet injects the remote device API, default device and task delivery example when `remoteAgent` is enabled, but still requires the remote Agent not to directly reply to QQ. As a result, it returns to the local personality and then uses the normal reply/Action Gate.

### Planning, Memory and Configuration

- Plan/memory recall is upgraded to `[Pre-action context check]`: use only ID, title, and `keywords` for lightweight scoring, inject the required GET path into the Agent, and do not insert the full body directly.
- Refresh `viewedAt` when recent memory and precipitated memory enter the must-read confirmation queue to reduce the probability of premature precipitation of memories that are still in use.
- Gateway Configuration read and write further splits adapter configuration and persona rules, adds configuration migration assistance, retains route historical data and merges old rules into `personaConfig.json`.
- Route identity and path resolution are centralized into shared helpers to avoid route/config/persona path escape and old runtime id caliber drift.

### WebGUI, Tray and Packaging

- RibiWebGUI supplements remote Agent message side configuration, route miss/delivery status display, built-in rolePanel rule protection and read-only status optimization.
- Windows tray packaging supplements the application identity and version information files. The tray entry continues to reuse the manager API and does not submit the generated exe.

### Local verification

- `npm test` Passed, 56 tests covering forwarding, remote agent task event ownership verification, configuration warehouse migration, plan/memory recall, route identity and gateway config model.
- `npm run build:backend` Passed.
- `npm run build` Passed; Vite still prompts static asset runtime resolution and large chunk warnings.
- `git diff --check` Passed, Windows workspace CRLF prompt only.

## 2026-06-10This update continues to consolidate RabiRoute into the scheduling layer of "message portal + role panel + returnable Agent": the Codex adapter name is unified to `codex`, the role panel becomes a built-in local message terminal, and timed triggering supports rule-level schedules. NapCat multi-instance status and port ownership are more diagnosable, and public Rabi Sample synchronization plan/memory knowledge package.

### Routing, Agent and Backhaul

- Agent adapter types are uniformly migrated from `codexDesktop` / `codexApp` to `codex`, old configurations are automatically upgraded when reading and saving, and Codex Desktop IPC is still the default verified delivery channel.
- Added `rolePanel` message terminal and `role_panel_message` routing type. The tray character panel can deliver local chat messages to the Agent bound to the current route, and write Agent replies back to the character panel timeline.
- Agent reply postbacks can locate routes based on clear QQ group/private chat targets or original message logs; NapCat outbound policies are simplified to `outputEnabled` and `supportedOutputs`, and the old `outputMode`, whitelist, and pipeline filter fields are no longer sent as new versions.
- Manager adds a new Agent running status reporting interface, and Copilot CLI and Marvis status are reported to the Manager process instead, reducing misjudgments caused by reading stale state files.

### Timing trigger, NapCat and configuration

- Heartbeat scheduled triggering supports the configuration of each notification rule `schedules`, including interval triggering, interval triggering within a time window, daily fixed time and one-time triggering; trigger records will be marked with route/rule/schedule.
- Gateway Added NapCat to the configuration model for master instance resolution, master instance field synchronization and port ownership collection. Automatic port allocation will avoid occupation by manager, WS, HTTP, Webhook, etc.
- NapCat health check adds `online` / `good` judgments for OneBot `get_status` and supports restarting a single NapCat instance from the WebGUI request.
- When deleting the route configuration, only the corresponding `adapterConfig.json` will be removed, and the historical JSONL records in the route directory will be retained.

### WebGUI, Tray and Examples

- RibiWebGUI displays the role panel as a fixed built-in portal, supplementing route deletion, NapCat restart, offline status display, dirty configuration protection and heartbeat schedule editing/migration portals.
- The Windows tray window has been upgraded from a read-only plan/memory board to a role panel: select routes on the left, the main area displays chat, plans and memories, and supports sending text and file attachments.
- Public examples of Rabi personality completion plan index, archive directory, multiple precipitated memories and recent memories, using desensitized content to illustrate product boundaries, configuration sources, message links, action safety gates, routing types, WebGUI/tray positioning and open source release hygiene.
- README, configuration documents, Agent interface documents and pipeline documents are synchronized to use `codex`, new version of message side strategy and role panel/postback semantics.

### Migration instructions

- `agentAdapters: ["codexDesktop"]` or `["codexApp"]` in old configurations are automatically upgraded to `["codex"]`.
- `outputMode`, `allowedGroups`, `allowedUsers`, `allowBroadcast`, `enabledPipelines`, `disabledPipelines` in old `messageAdapterPolicies` Field is ignored; use `outputEnabled` and `supportedOutputs` when control sending is required.
- The old heartbeat global interval will still be used as a compatible schedule; the new version recommends maintaining `schedules` on the heartbeat notification rule.

### Local verification- `npm test` Passed, covering Agent adapter, configuration warehouse, outbox postback, memory reach, routing decisions, Agent packet, heartbeat schedules and gateway config model.
- `npm run check:config` passed; the missing local route configuration was skipped according to script rules, and the runtime and public example persona configuration verification passed.
- `npm run build` passed, completing TypeScript compilation, WebGUI `vue-tsc` and Vite production build; Vite only prompts static resource runtime analysis and large chunk warnings.
- `git diff --check` Passed.
- The desensitization scan covers public source code, documents, examples and change logs. The hit items are field names, security reminders or placeholder examples. No real tokens, cookies, passwords, local user paths or runtime private chat contents were found.

## 2026-06-08

This supplement includes data format migration instructions in the README, Windows tray exe packaging boundaries, and adds plan/memory context, Agent return interface, multiple NapCat instances, and document and code organization after manager split to facilitate local packaging verification after upgrading from the old runtime `data/` to the new version of the configuration structure.

### Documentation

- README adds "Current Data Format" to clarify the responsibility boundaries of `data/route/<configName>/adapterConfig.json` and `data/roles/<RoleId>/personaConfig.json`.
- README adds old file migration relationships: `routeConfig.json` moves to `adapterConfig.json`, `roleMessageConfig.json` moves to `personaConfig.json`.
- README clarifies that `data/gateways.json` and `data/roles/<RoleId>/routes.json` are no longer used as new moderator configuration entries.
- README adds Windows exe packaging command and runtime boundary: `RabiRoute-Desktop.exe` only packages the PySide6 tray entry, and does not build in Node.js, manager/WebGUI build products or runtime `data/`.
- README document index supplements plan/memory, Agent interface and code architecture entry.
- Added `docs/plan-and-memory-model.md`, `docs/rabi-agent-interfaces.md` and `docs/agent-context-injection.md` to account for character planning, recent memory, sunk memory, context injection and Agent postback boundaries.
- Added `docs/code-architecture.md` to sort out the modification entrances for the backend entrance, message main link, routing module, manager control plane, WebGUI, tray window and plug-in directory.
- The local absolute paths in public sample documents are uniformly replaced with placeholder paths to avoid submitting private workspace paths.

### Routing, Agent and Context

- `forwarding.ts` calls the route decision and agent packet constructs of `src/routing/` instead, reducing the coupling of rule matching, template assembly and context injection in the main link.
- Added a new plan and memory reading layer, which injects lightweight plans/recent memory indexes into the Agent by default, and performs lightweight recall of current messages through keywords.
- Added Agent normal reply return interface boundary, the reply is first returned to RabiRoute, and then the outbox decides to send, draft or block based on the pipeline, source log and policy.
- Example Rabi personality supplement `plans/` and `memory/` expose the structure, showing the data form of plans, recent memories, precipitated memories and memory organization runs.

### Manager and message terminal

- Manager unpacks the configuration repository, runtime registry, scan control, role context routing, control plane routing and stateful payloads from a single large file.
- NapCat/OneBot configuration is changed to a multi-instance model, and each instance independently saves the WS port, HTTP address, WebUI address, token, startup command and working directory.
- Added NapCat manager auxiliary logic to support WebUI token reading, OneBot network configuration check/repair, HTTP health, WebUI login and controlled exit.
- WebGUI routing configuration page synchronization supports multiple NapCat instances, instance scanning, WebUI token backfill, Agent session scanning and more complete pipeline/policy configuration.

### Desktop task window- The tray task window uses the plan/memory model to read the role context, and completes the current plan, short-term/long-term view, recent/precipitated memory, task list and running status display.
- Windows launcher and tray lifecycle control continue to maintain manager ownership boundaries: only the manager owned by this launcher is closed.

### Test

- Added `npm test` script.
- Added Node test coverage for route decision, gateway config model and manager config repository.

### Local verification

- `npm test` Passed, covering route decision, agent packet, gateway config model and manager config repository.
- The local runtime `data/` has been generated in the new format `adapterConfig.json` and `personaConfig.json`, the old files are retained for rollback reference.
- `npm run check:config` passed.
- `npm run build` passed.
- `scripts/build-desktop-exe.ps1 -SkipNodeBuild` Passed, local `RabiRoute-Desktop.exe` has been generated.
- The new version of manager has been restarted, and `http://127.0.0.1:8790/meta` is working normally.

## 2026-06-07

This update further expands RabiRoute from a single QQ/Codex routing to a multi-entry and multi-processing framework of "context routing + action security gate", and completes the Windows desktop entrance, Xiaoai speaker bridge research, Pipeline preset and RibiWebGUI substantial reconstruction.

### Routing and Pipeline

- Added `pipelinePreset` / `pipeline` configuration, built-in three types of output intentions: `qq_chat`, `voice_chat`, `webhook_task`.
- Added input, output, TTS, reflow control and manual trigger related fields to template variables.
- Added `manual_trigger` to the routing type, which supports the manager API to actively trigger specified rules.
- Webhook voice events add device ID, device name, region and session information.
- The default template for voice transcription has been changed to allow entry into the outgoing process when authorization is sufficient to avoid treating voice transcripts as read-only input.

### Agent and output adaptation

- Agent adapter extends to `copilotCli`, `marvis` and `astrbot`.
- Copilot CLI supports configurable binaries, working directories, parameters and timeouts.
- Marvis adapter supports opening desktop, copying prompt words and handover via URL/desktop portal.
- AstrBot adapter uses environment variables to log in and cache short-term tokens, without submitting real passwords or tokens.
- Manager adds Agent scanning, Copilot installation/login/status query, FenneNote playback/reply forwarding and graceful shutdown API.

### RibiWebGUI

- WebGUI page changed to console, message adapter, Rabi personality, log diagnostics and routing directory guidance.
- The routing configuration page is restructured into a more complete message entry, Agent, Pipeline, template rules and manual trigger configuration interface.
- Overview page enhances running status, connection diagnosis, quick actions and routing selection.
- The personality template page enhances template variables, rule editing and personality configuration display.
- Enhanced diagnostic information and manager status display on the run log page.
- The overall style has been updated to improve the scannability and mobile layout of dense configuration interfaces.

### Windows Desktop Portal

- Added and unified Windows startup entry to `Start-RabiRoute-Desktop.bat`.
- Added PySide6/Qt tray task panel, which read-only displays the current task, short-term/long-term plan, short-term/long-term memory, task list and running status.
- The tray panel reads status through the manager API and can request graceful shutdown when the launcher has the manager life cycle.
- The desktop layer maintains cross-platform boundaries: Qt panel, manager client, task repository, role context repository and life cycle control remain reusable, Windows only provides the first launcher.

### Xiaoai and external devices- Added `plugin-adapters/xiaoai-rabiroute`, providing XiaoAI transcript bridge and speak placeholder.
- Added `examples/data/route/xiaoai/adapterConfig.json` and related `personaConfig` fragments.
- Added Xiaoai interception routing, LX06 flashing checklist, infrared remote control gateway research and Home Assistant/BroadLink selection instructions.
- This time, the local `open-xiaoai` vendor checkout will not be submitted, only RabiRoute's own bridging code and documentation will be submitted.

### Documentation, Examples and Release Hygiene

- README updates project boundaries to make clear RabiRoute saves migratable context, routing decisions, action safety gates and observable records.
- Added `docs/pipeline-presets.md`, Windows launcher/packaging documentation, WebGUI build skill and RabiRoute build skill.
- Example `.env.example` Add Copilot/Marvis adaptation configuration placeholder.
- `.gitignore` Add Python virtual environment, cache, logs and local vendor checkout ignore rules.
- The local absolute path has been cleaned before publishing, and only the placeholder path, localhost example and environment variable name are retained in the public content.

### Verify

- `npm run build` passed.
- `npm run check:config` passed; during local operation, `data/` missing configuration items were skipped according to script rules, and the example route and Rabi role configuration verification passed.
- The desensitization scan covered modified and newly added files to be submitted, and no real tokens, cookies, passwords or local absolute paths were found.

### Additional updates

- Windows entry merged into `Start-RabiRoute-Desktop.bat`, removed old `Start-RabiRoute-Windows.bat` forked with `scripts/start-rabiroute-windows.ps1`.
- Added `RabiRoute-Desktop.spec` and `scripts/build-desktop-exe.ps1` to support PyInstaller local packaging root directory `RabiRoute-Desktop.exe`; exe will not be submitted to the source code warehouse, and public release packages will not be enabled for the time being.
- The packaged tray exe locates the project root directory from its own directory in freeze mode and automatically starts `node dist/manager.js` when the manager is not running.
- When the tray exits, manager shutdown will be called first, and the managed process will be terminated directly when it owns the manager process to reduce background residue.
- Manager configuration is split into `data/route/<configName>/adapterConfig.json` and `data/roles/<RoleId>/personaConfig.json`, routing adapter and personality template rules are no longer mixed in the same file.
- The WebGUI routing configuration page is synchronized to use the `adapterConfig.json` path, and the Copilot CLI session drop-down only displays the Copilot session name.
- `.gitignore` Added `/build/` to avoid committing the PyInstaller temporary directory and the native path analysis files therein.

## 2026-06-05

This update organizes the configuration structure of RabiRoute from the old single file/routes format into two clear data fields, and synchronizes the still valuable WebGUI, Webhook, Codex thread binding and voice workstation capabilities in the old branch.

### Configuration structure

- Route configuration migrated to `data/route/<config-name>/adapterConfig.json`.
- Persona configuration and message-template rules migrated to `data/roles/<role-name>/persona.md` and `data/roles/<role-name>/personaConfig.json`.
- Removed old `examples/data/gateways.json` and `examples/data/roles/Rabi/routes.json` from public examples.
- Added `examples/data/route/main/adapterConfig.json` and `examples/data/roles/Rabi/personaConfig.json` to sample data.
- Configuration check script changes to check `adapterConfig.json` and `personaConfig.json`.

### WebGUI- The top operation bar has been changed to a fixed suspension. When scrolling the page, you can still refresh, start the manager, add routing configuration, open the directory and save the configuration.
- Routing configuration and personality configuration are displayed in two major data fields: `data/route` / `data/roles`.
- The personality configuration and message template rule areas are displayed only after the routing configuration points to the personality.
- The message adapter settings are changed to centralized cards and details panel.
- When adding new message template rules, use the secondary pop-up window to edit; multiple rules can be switched through labels.
- Added "Open Configuration File" entry to all configuration areas.

### Routing and Adapters

- A new independent field `webhookPort` is added to the Webhook port to avoid confusion with NapCat WebSocket's `gatewayPort`.
- Webhook adapter uses `WEBHOOK_PORT`, falling back to `GATEWAY_PORT` when not configured.
- NapCat adapter increases the active connection count to avoid misjudgment when multiple WebSocket connections are made.
- The default template for voice transcription is updated to the FenneNote / Codex local voice input scenario, which is not automatically forwarded to QQ/NapCat by default.

### Codex Delivery

- Codex App and Codex Desktop IPC Enhance pinned thread auto-discovery.
- When the thread name of the old state binding is inconsistent with the current configuration, the old binding will be cleaned up and error information will be recorded to avoid messages being delivered to the wrong thread.
- Codex Desktop IPC Preserves batch posting and on-the-fly steer logic.

### Documentation and Skills

- The documents are uniformly changed to the new caliber `data/route` / `data/roles`.
- Added `docs/voice-interaction-workstation.md`, illustrating public secure wiring methods for FenneNote, RabiRoute, character dialogue, and OumuQ TTS.
- Added `skills/rabiroute-voice-workstation/SKILL.md`.
- Update `skills/create-rabiroute-persona` to avoid subsequent generation of old `routes.json`.
- Added NapCat unattended and login stability instructions.

### Compatibility Notes

- The old `data/gateways.json` / `routes.json` configuration format is not retained this time.
- The old branch has been archived as `archive/*` tag; the main branch continues to evolve in the new format.
- The QClaw branches are too different and are not merged directly. If necessary, it should be re-implemented as an optional adapter or plug-in according to the current main branch.

### Verify

- `npm run build` Passed.
- `npm run check:config` passed.
- The local manager has been restarted with the new build and confirmed that `8790`, `8789`, `8791` are listening properly.
- A desensitization scan has been performed before release, public examples and documents use placeholder values, and no runtime `data/`, logs, tokens, cookies or real accounts have been submitted.
