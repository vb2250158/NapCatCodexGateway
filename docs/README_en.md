<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Documentation

Development and maintenance: [installed Web hot patches](web-hot-patches_en.md) covers automatic production builds, version pinning and managed rollback.

- [Offline glasses recording and live preview](rabilink-offline-recording_en.md): record glasses streams on the phone and watch locally; device acceptance is in progress.

This directory contains current guides, experimental integrations, designs, research, and historical handoffs. The existence of a file does not mean its feature is complete; check its status before relying on it.

## Status definitions

| Status | Meaning |
| --- | --- |
| Current fact | Checked against code, schemas, WebGUI, and tests; safe as the current version's public position. |
| Current guide | Covers implemented behavior but still needs continuous review as code evolves. |
| Experimental integration | A code entry exists, while the external system or hardware path still requires environment-specific acceptance. |
| Needs refresh | Contains useful material but is known to include stale or conflicting statements. Prefer Current Capabilities. |
| Planned | A proposal, requirement, or roadmap rather than an implemented loop. |
| Historical | A superseded path, research record, or handoff rather than the current primary path. |

## Start here

- [RibiWebGUI User Guide](user-guide/README_en.md) — **Current guide**. Start here on your first use to complete a real delivery, read status, change rules, and recover from common failures.
- [Getting Started](getting-started_en.md) — **Current guide**. Install RabiRoute, start Manager, and confirm that the console opens.
- [Interface and status](user-guide/interface-and-status_en.md) — **Current guide**. Understand the current Route, Manager connection, unsaved changes, runtime state, and Settings-page screenshots, selected-text menu, and login startup.
- [Interface theme](user-guide/interface-theme_en.md) — **Current guide**. Shared light, dark, follow-system, and bounded custom themes for WebGUI and the Windows tray.
- [Runtime, logs, and troubleshooting](user-guide/operations-and-troubleshooting_en.md) — **Current guide**. When a message does not arrive, start with the diagnosis summary and locate the break.
- [Safety, replies, and data](user-guide/safety-and-data_en.md) — **Current guide**. Check permissions and privacy before enabling external replies or sharing diagnostics.
- [Current Capabilities and Maturity](current-capabilities_en.md) — **Current fact**. Check what is verified and what still needs a real account, network, or device acceptance run.

## Local installation, configuration, and recovery

- [Configuration](configuration_en.md) — **Current guide** for the 28 built-in Manager plugins, `provides/requires/optional` dependencies, the single initialization path, declarative routes, shared-resource lifecycle, WebGUI/Desktop extension entries, and AstrBot ChatUI-only configuration.
- [Resident performance recording and inspection](performance-monitoring_en.md) — **Current guide** for optional continuous Manager, Gateway, and WebGUI metrics, trends, slow operations, and independent JSONL files.
- [Troubleshooting](troubleshooting_en.md) — NapCat, encoding, Codex Desktop task ownership, models, and approval boundaries.
- [Windows launcher and packaging](windows-launcher-and-packaging_en.md) — Windows installation, startup, and packaging.
- [Unattended NapCat](napcat-unattended_en.md) — QQ login state, quick login, Manager recovery, and supervision boundaries.

## Routing, personas, and handlers

- [Install Rabi knowledge search](../skills/rabi-knowledge-search/README_en.md) — Project maintainers can install the skill to search plans and memories first when online, and use ordinary search when offline.

- [Routing configuration](routing-configuration_en.md) — **Current guide** for `personaConfig.json`, route kinds, regex, pipelines, and template variables.
- [Routing and personas](routing-and-personas_en.md) — **Current guide** for route/role boundaries and persona decision templates.
- [Agent context injection](agent-context-injection_en.md) — **Current guide** for the persona-scoped bidirectional ledger, per-endpoint/conversation recent-message budgets, archival boundaries, persona-directory and cross-persona credentials, paths, and reply context inside `AgentPacket`.
- [Rabi Agent interfaces](rabi-agent-interfaces_en.md) — **Current contract** for handler replies, persona discovery, idempotent one-way cross-persona delivery, receipts, thread bridge, plans, memory, Remote Agent, and role skills.
- [Long-term maintenance and self-repair](rabi-maintenance_en.md) — **Maintenance workflow** for a stable intake task, original issue ownership, recovery verification, and periodic code-quality work.
- [Plans and memory](plan-and-memory-model_en.md) — **Current guide** for Role Knowledge sources, recall, explicit consolidation, and side effects.
- [Unified dynamic record lifecycle](dynamic-record-lifecycle_en.md) — **Current guide** for archival, memory consolidation, physical sharding, retention, and the 24/72-hour dynamic windows.
- [Pipeline presets](pipeline-presets_en.md) — Agent-session defaults, explicit external targets, and Outbox statuses; FenneNote output is archival compatibility only.
- [Agent Adapter Integration Lessons](agent-adapter-integration-lessons_en.md) — **Current guide** for duplicate sessions, missing tools, inverted ownership, desktop startup dependencies, and verification.
- [Standard Agent Adapter Requirements](agent-adapter-standard-requirements_en.md) — **Current guide** for discovery, authentication, tasks, idempotent creation, delivery, results, tools, lifecycle, UI, security, and acceptance.
- [Codex Desktop Agent Integration and Acceptance Contract](codex-desktop-agent-acceptance_en.md) — **Current fact** for stable IDs, side-effect-free scanning, automatic initialization, the Desktop owner boundary, and metadata bootstrap gates.
- [Rabi Codex Context plugin](rabi-codex-context-plugin_en.md) — **Unified Manager version** where hooks only forward real Codex session events and inject Rabi PC-owned persona, plan, memory, and skill context.
- [Multi-PC persona data synchronization](persona-data-sync_en.md) — **Experimental**. PCs in one RabiLink application prefer direct LAN transfer and fall back to restricted Relay transit. Backend file/connection events drive automatic catch-up, while the persona page supports immediate sync, evidence preview, and basic conflict resolution.

## Architecture and maintenance

- [Mobile recording interface](rabilink-mobile-recording-ui_en.md) — Four-page navigation, capture modes, offline storage, session replay and compatibility boundaries.

- [Rokid development sources and troubleshooting](rokid-development_en.md) — SDK route, official-source reading status, installation evidence and development skill; CXR-M is excluded.

- [Architecture](architecture_en.md) — **Current fact**. Product boundaries, the Codex Desktop owner, current Outbox, and future Action Queue are separated.
- [Plugin architecture lessons from DSH](dsh-plugin-architecture-lessons_en.md) — **Research and implementation summary**. Covers the completed migration of 28 built-in Manager plugins, WebGUI/Desktop minimal extension hosts, contribution points, process-isolation boundaries, and the future third-party presentation Extension Host.
- [How DSH uses Cordis](dsh-cordis-runtime-analysis_en.md) — **Implementation research**. Explains profiles, Loader, Fibers, service realms, the browser plugin tree, dynamic code, and process-sandbox boundaries.
- [RabiRoute plugin platform target architecture](manager-plugin-implementation-hot-swap_en.md) — **Current architecture**. Defines a minimal Plugin Kernel, independent capability packages, one SDK, multi-host extension, atomic generation switching, out-of-tree plugin acceptance, and one complete removal of the old runtime.
- [Plugin Bundles and hot replacement](plugin-bundles_en.md) — **Current implementation guide**. one Profile, independent packages, the shared SDK, generation hot replacement, and browser revision rollback.
- [Source hot patches](source-hot-patches_en.md) — **In development**. Source mode watches code and declared resources, compiles and validates changes, preserves state, and switches without stopping the service; the document states the installed-runtime acceptance boundary.
- [Code architecture](code-architecture_en.md) — **Current fact**. Backend, Manager, endpoint, Role Knowledge, WebGUI, and desktop module map.
- [Project function map](project-function-map_en.md) — **Current fact**. Locate behavior by maturity, side effect, API, and code owner.
- [Path and directory conventions](path-and-directory-conventions_en.md) — **Current maintainer guide**. Separates software, public samples, local runtime data, and logs, and defines relative-path and business-ID interfaces.
- [Pull request security gates](maintainer-security-gates_en.md) — **Current maintainer guide** for secret scanning, production dependency auditing, CodeQL, least privilege, and merge protection.
- [Windows launcher and packaging](windows-launcher-and-packaging_en.md) — **Current guide** for the RabiRoute Desktop user entry, its local backend, and packaging boundary.
- [Manager runtime resilience and incident evidence](manager-runtime-resilience_en.md) — **Current guide** for crash logs, single-instance protection, non-fatal persona-index persistence, watchdog backoff, and soak acceptance.
- [Unattended NapCat](napcat-unattended_en.md) — **Current guide** for login state, quick login, Manager recovery, and supervision boundaries.

## Experimental integrations

- [Local YeYu Gamer Manager integration](yeyu-gamer-manager-integration_en.md) — **Experimental integration**. Fixed local port 8877, typed health/meta/snapshot/capability reads, and plan-only Agent work-item creation through a dedicated `rabiroute.token`; disabled by default pending live installation acceptance.
- [WeCom integration](wecom-integration_en.md)
- [Feishu endpoint integration](feishu-integration_en.md) — enterprise-app event callbacks, signature/encryption checks, durable deduplication, and source-chat text replies.
- [Video generation plugin](video-generation-plugin_en.md) — Install local H3, submit video jobs, follow progress, and preview or download results.
- [Voice interaction workstation](voice-interaction-workstation_en.md) — historical wiring; FenneNote/OumuQ are retired in favor of RabiPC + RabiSpeech.
- [RabiSpeech local TTS / ASR service](rabispeech-plugin_en.md) — direct APIs, hot/persona-keyword delivery, persona voice and language, bidirectional ASR/TTS records, opaque voiceprint/cluster evidence, RabiPC, and RabiLink relay. The selected-text menu's reading sub-feature can enqueue host TTS.
- [Call TTS and ASR remotely](user-guide/speech-api_en.md) — application token, target PC, copyable commands, acceptance, and error recovery.
- [Rabi Voice Client](../desktop/rabi-voice-client/README_en.md) — use a meeting-room Windows PC as a LAN microphone and speaker while segmentation and models stay on the RabiSpeech host.
- [Local speech model downloads](local-speech-model-downloads_en.md) — use Model Management for on-demand weights and review each TTS/ASR model's source, isolated runtime, and validation requirements.
- [RabiSpeech performance report](rabispeech-performance-report_en.md) — six TTS and five main ASR models, cold/warm timing, quality indicators, hardware, and CUDA issues.
- [Cross-PC API calls](rabilink-peer-rpc_en.md) — Query another PC by device ID, configure target grants and inspect the actual LAN, P2P or Relay result.
- [RabiLink Relay](rabilink-relay-server_en.md)
- [RabiLink Cloudflare Worker](rabilink-relay-cloudflare-worker_en.md)
- [RabiLink glasses three-route comparison](rabilink-glasses-route-comparison_en.md) — host, lifecycle, device capability, release cost, and current guidance for native Lingzhu agent, AIUI, and native app routes.
- [Rabi mobile message endpoint](mobile-message-endpoint_en.md) — **Experimental integration** for standalone phone chat, optional glasses, reliable queues, notifications, attachments, configuration assistance, and device acceptance boundaries.
- [RabiLink phone edge hub](rabilink-phone-edge-hub_en.md)
- [Phone-to-PC direct video](rabilink-direct-video_en.md) — experimental signalling and direct transport; camera capture and cross-network acceptance remain pending.
- [RabiLink wearable health endpoint](rabilink-wearable-health_en.md) — **Experimental integration** for phone settings, structured health history, Agent queries, alert thresholds, and the Xiaomi ADB fallback.
- [AIUI-to-phone/native-glasses parity checklist](rabilink-aiui-native-parity_en.md) — migration status separated by code, automation, and real-device evidence.
- [RabiLink AIUI residency boundaries](rabilink-aiui-residency-plan_en.md)
- [RabiLink proactive-intelligence requirements](rabilink-active-intelligence-requirements_en.md) — target contract and implementation tracker for user state, scenario recognition, plan/memory closure after group-message recall, and intervention decisions.
- [RabiLink native app design](rabilink-glasses-app-design_en.md)
- [XiaoAI integration route](xiaoai-integration/xiaoai-rabiroute-intercept-route_en.md)
- [IR gateway research](xiaoai-integration/ir-remote-gateway-research_en.md)
- [Xiaomi Band heart-rate probe handoff](xiaomi-band-heart-rate-probe-handoff_en.md)

## Designs and history


- [Proactive-intelligence system design overview](../主动智能设计思路_en.md) — **Planned**. Covers user modeling, scenarios, proactive action, memory, and device responsibilities. See Current Capabilities for implementation status.
- [Conversational message collection, message groups, and four-Agent collaboration](group-message-batching-and-triage-plan_en.md) — **Experimental**. Natural-language traffic may be recorded immediately, settled into batches, and sent to dynamic Codex Message Agents by a combined ranking of the quoted message's Agent session, prior message group, conversation, speaker, and endpoint familiarity. Live group/DM and complete four-Agent acceptance remain pending.
- [Persona route workbench plan](persona-route-workbench-plan_en.md) — **Partially implemented**. Speech-keyword and per-endpoint context controls are live; side-effect-free RouteDecision/AgentPacket preview is not implemented.
- [Windows tray task-window plan](rabiroute-windows-tray-task-window-plan_en.md) — design record; use `desktop/tray-task-window/` and the packaging guide for the actual implementation.
- [UE/UX audit and refactor](rabiroute-ue-ux-audit-and-refactor_en.md) — phase audit.
- [Remote Agent setup and updates](lan-rabi-agent-bootstrap_en.md) — **Experimental integration**. Copy a prompt to connect another computer, manage its Agents in the current Manager, and select them as route handlers.
- [Historical mobile-app Webhook plan](mobile-app-webhook-integration_en.md) — **Historical**. The current RabiLink path no longer requires a phone bridge as the main relay.

Archived material is under [`archive/`](../archive/README_en.md). Buildable clients live under [`apps/`](../apps/README_en.md), reusable SDKs under [`packages/`](../packages/README_en.md), and copyable samples under [`examples/`](../examples/README_en.md).

## Documentation maintenance

1. Check code, schemas, APIs, WebGUI, and tests before updating the Chinese fact source.
2. Maintain the English version manually only after behavior is accurate; do not batch-translate stale documents.
3. Design documents must be labeled Planned or Historical instead of appearing in the current-capability list.
4. Runtime-semantic Markdown (`AGENTS.md`, `SKILL.md`, personas, prompts, memories, and plans) must not be translated mechanically.

- [Delivery templates and ownership](message-delivery-templates_en.md): renderer ownership, scenario differences and historical receipt retirement for developers.

- [Plan and memory summary search](knowledge-search_en.md)
