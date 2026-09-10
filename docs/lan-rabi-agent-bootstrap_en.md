<!-- docs-language-switch -->
<div align="center"><a href="./lan-rabi-agent-bootstrap.md">简体中文</a> | English</div>
<!-- /docs-language-switch -->

# Remote Agent setup and updates

> Status: experimental integration. Bootstrap prompts, signed downloads, local/remote instance catalogs, multiple Agents, stable route bindings and shared management operations are implemented. Real two-computer installation and host acceptance remain pending.

## Three user steps

1. Open **Remote Agent** (`#/lan-agents`) and select **Copy setup prompt**. The page uses the current Manager LAN address and pinned release public-key fingerprint. A loopback page selects a current LAN address. Enable LAN access first.
2. Start Codex or DSH on the target computer and paste the prompt into the task that should receive messages. That Agent checks Node.js 22.13+, discovers its current task and workspace, downloads and verifies the worker, writes private configuration, registers login startup and starts the background connection. Full RabiRoute installation and manual task IDs are unnecessary.
3. In the Route, open **Message adapters → Add AGENT**, choose **RemoteAgent(<IP address>)**, and save. With no nodes, the menu links to setup. The displayed IP is observed by Manager; the persisted identity is instanceId + agentId.

Local and remote computers are represented as instances in a two-level **instance → Agent** view. The local instance appears automatically. Remote instances display **RemoteAgent(<IP address>)** and contain multiple Agents. Codex and DSH describe execution capabilities rather than separate remote-instance types. Address changes do not change route identity.

The shared instance editor provides names, enablement, workspace, task names and IDs, model, reasoning effort, explicit environment scans, opening tasks and Hook installation. Hook policies remain in the current Manager's persona automation settings.

The prompt contains the connection credential. Paste it only into a private task on the target computer; never put it in a repository, group chat, logs, screenshots or command history. Clipboard fallback supports LAN HTTP pages.

## Ownership and execution

| Object | Owner | Behavior and acceptance |
| --- | --- | --- |
| Nodes, IP, connections and task states | Manager node registry | Both HTTP management and WebSocket connections require explicit authentication; offline delivery fails. |
| Route binding | Route `agentInstanceBindings[provider]` | UI saves a node reference, not another credential. Gateway receives its endpoint and credential from the current Manager generation. |
| Task, model, tools and permissions | Existing remote Codex/DSH host | Bind the installation task. No fallback Runtime or host startup modification. The host remains independent when Manager stops. |
| Background connection | Current-user Rabi Agent | Owns outbound connection, downloads, verification, login startup and updates. |
| Message path | Route → Agent adapter → Manager registry → remote worker → bound task | Codex uses Desktop IPC; DSH uses local `session.prompt` with `mode=queue`. Each host has one execution path. |

An unavailable Codex owner fails without `codex app-server`. An unavailable DSH endpoint or binding fails without switching to Codex. A busy Codex task rejects new work rather than overwriting its task association. Accepted duplicate tasks are not submitted again.

Online means the worker is connected. Task records distinguish delivery, acknowledgement, progress, completion and failure. DSH currently reports queue acceptance; read its actual reply in the bound session. Codex completion comes from Desktop broadcasts; read replies in the corresponding task. Cross-computer local image paths, remote persona-file synchronization and complete remote plan-management parity are not supported yet.

## Installation and releases

| Platform | Private directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%/RabiAgent/` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

WebGUI owns the single prompt template; this document does not duplicate it. The prompt contains the full Manager URL, existing LAN Token and pinned SHA-256 public-key fingerprint. Verify the Ed25519 manifest signature and every file's SHA-256 and size. Reject escaping paths and cross-origin downloads. Preserve Manager's private signing key across upgrades; rotation requires trusted redistribution of the fingerprint.

Process variables: `RABI_MANAGER_URL`, `RABI_LAN_LINK_TOKEN`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS`, `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`. Codex uses `RABI_AGENT_TYPE=codex-desktop` and `RABI_AGENT_CODEX_THREAD_ID`; DSH uses `RABI_AGENT_TYPE=dsh`, `RABI_AGENT_DSH_URL`, `RABI_AGENT_DSH_SESSION_ID`. The remote Agent discovers and privately stores these values without asking the user to type IDs.

`node rabi-agent.mjs --bootstrap` stays running; launch it hidden and detached from the installation terminal. Refresh the node page after setup. Online nodes can request updates; the worker downloads, verifies and switches itself, retaining the old version if the new one does not reconnect within 30 seconds. If Manager's address changes, copy a fresh prompt to update the connection; do not guess ports.

## Instance ownership and management

The local instance ID is persisted in private `agent-instance-id.json`; remote instances retain their private nodeId. Existing single-task configuration is projected as agentId=default; new Agents receive UUIDs. Each executing computer owns its configuration. Manager keeps a catalog projection, while local Agents keep their existing route configuration as the source of truth, with the existing concurrent-version guard on saves.

Both transports use `instanceManagement.ts` for scans, tasks and Hook installation. WebSocket RPC responses must belong to the requesting connection. Disconnection fails immediately; refresh after an ambiguous timeout before retrying a change. Hooks validate the registered session and associate an isolated instance identity with the current Manager persona.

Each instance links to its bound route's shared complete Agent settings, including message processing, dedicated memory consolidation and plan assistants. Worker state is scoped by instanceId, agentId and primary task ID. Moving computers or rebinding the primary never reuses workers from the previous owner. Resolved or created assistant tasks register under their owning Agent; Manager followups dispatch by that ownership and fail on offline or ambiguous identities without local fallback.

Installed Manager reads connector assets, the shared management runtime and Hook packages from its immutable release, while signing keys remain in private data. Reconnecting preserves instance identity, the Agent catalog and permitted workspaces. Disabled local task bindings remain visible and can be enabled again; a route assigned to a remote provider must first be switched back to local in route settings.

## API

- `GET /api/lan-agent/releases/manifest` and `GET /api/lan-agent/releases/<version>/node/<assetPath>`: manifest and files.
- `GET /api/lan-agent/instances`: local and remote instances with their Agents.
- `POST /api/lan-agent/instances/<instanceId>/agents`: add an Agent.
- `POST /api/lan-agent/instances/<instanceId>/agents/<agentId>/<operation>`: configure, scan, threads, hooks, context and tasks.
- `GET /api/lan-agent/nodes`: nodes and recent tasks.
- `POST /api/lan-agent/nodes/<nodeId>/tasks`: delivery, defaulting to the node's declared host when `targetAgent` is omitted; deduplicate with `idempotencyKey`.
- `POST /api/lan-agent/nodes/<nodeId>/update`: update request.
- `WS /api/lan-agent/connect`: `authenticate → authenticated → hello → connected → heartbeat`.

The existing `lan-agent` connection and release API paths remain available for installed connectors to update. The unreleased `lanAgent` provider and `lanAgentNodeId` setting have been removed; the user-facing feature is Remote Agent. Old Remote Agent v3 is a separate experimental protocol, not a delivery path or installation dependency of this adapter. Migrating it is outside this change.

## Remaining device acceptance

- Two-computer installation, Token revocation, disconnect recovery and login startup.
- Repeated messages in existing Codex/DSH tasks, absent hosts and visible actual replies.
- Startup and failed-update recovery on Windows, macOS and Linux.

## Capability boundary

The implementation unifies instance identity, catalogs, Agent management and remote transport. Instances link to their bound routes' shared complete settings. Advanced task dispatch, state isolation and Hook ownership have implementation and local contract coverage; plan responses, the message-processing board and full workflows still require acceptance with real remote hosts. A connected node or passing local fixture does not prove two-computer or complete advanced-feature parity.
