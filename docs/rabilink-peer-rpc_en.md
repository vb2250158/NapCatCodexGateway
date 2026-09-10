# Cross-PC API calls

English | [简体中文](rabilink-peer-rpc.md)

Status: experimental. Read operations support LAN, a public WebRTC connection attempt, and bounded Relay fallback. Automated coverage includes real local WebRTC channels, LAN preference, Relay fallback and application isolation. Cross-carrier public connectivity and sustained operation on two physical PCs require separate acceptance.

## Call another PC

Both online PCs must use the same RabiLink application token and advertise `peer-rpc-v1`. The Relay must also include `/api/rabilink/peer/proxy`. Obtain the local `managerBaseUrl` from Host `status --json`, then verify `/meta` health, application generation and Manager instance before using:

- `GET /api/rabilink/peer/list`: registrations with a categorized `summary`. Each item has `deviceKind` (for example `pc`, `phone`, `glasses` or `watch`), target ID, online state, capabilities and LAN addresses. Missing or invalid kinds become `unknown`; names and capabilities never imply hardware. `summary.total` counts registrations, not computers.
- `GET /api/rabilink/peer/list?deviceKind=pc&online=true`: only explicitly classified online PCs. Summary counts reflect the filtered result; without filters, unknown and offline registrations remain visible.
- `POST /api/rabilink/peer/call`: address a target by ID. These control endpoints are loopback-only; the remote data endpoint only accepts encrypted packets.

```json
{
  "targetDeviceId": "pc-b",
  "capability": "plans",
  "operation": "list",
  "input": { "roleId": "Example" }
}
```

The response includes `transport` (`lan`, `p2p` or `relay`) and `reply`. Business success requires `reply.ok`; the reply also identifies the request, device and runtime instance. `plans.list` returns only plan ID, title, status and update time. `persona.manifest` returns the selected persona's file manifest. `system.describe` requires no business grant and returns the instance and exposed operations.

## Target-owned access

PC event connections and worker requests explicitly report `deviceKind=pc`. Phone and glasses clients retain their existing `deviceKind` reporting. The updated Relay preserves a registered kind when an older client later omits it. Historical entries are not rewritten from their names; devices must explicitly report their kind again. Types are self-reported categories, not authorization credentials, and support custom extensions.

The target's runtime data root contains the sole grant source, `data/rabilink/peer-access.json`. Missing, malformed or oversized files (over 64 KiB) deny business access. Changes take effect on the next request.

```json
{
  "schemaVersion": 1,
  "operations": ["plans.list", "persona.manifest"],
  "roleIds": ["Example"]
}
```

Grants cover the entire trusted application group. Members sharing a token share a cryptographic identity; device IDs provide addressing and wrong-target checks, not independent member authentication. Keep mutually untrusted PCs in separate applications. Joining does not automatically enable business reads, arbitrary Manager paths, task execution, outbound messages or file mutation.

## Transport and lifecycle

Discovery is shared with persona synchronization. Every call refreshes registered addresses, verifies the target and generation through encrypted `system.describe`, and binds its request to that generation. Requests and replies use AES-256-GCM with an application-derived key. LAN never carries the application token. Relay forwards encrypted packets only to `/api/rabilink/peer/receive`; callers cannot supply arbitrary URLs.

At most four registered private IPv4 addresses are tried, with a two-second discovery deadline each. If LAN is unavailable, encrypted SDP travels through Relay to establish a werift WebRTC DataChannel. STUN discovers addresses; TURN is not enabled. Each direct attempt has a twelve-second deadline, each connection serves one call, and at most eight connections coexist. Read requests can fall back to Relay, while business rejection remains a failure. Requests expire within two minutes; plaintext requests/results are limited to 1 MiB, with a separate wire limit.

The RabiLink Manager plugin owns routes and WebRTC connections. Disposal removes routes, closes connections and drains accepted HTTP operations. Requests bound to an old generation fail closed; callers must rediscover before issuing a new request.

This protocol version registers read operations only. Adding mutations requires durable target-side deduplication, receipt queries and uncertain-result recovery first. Do not register writes in the existing read retry flow.

## Existing contracts

Persona discovery now uses the shared module. Existing persona LAN file transfer, merge and `/persona-sync/proxy` remain required by deployed versions and mutation contracts; read RPC does not replace synchronization writes. Retirement requires durable mutation recovery, dual-PC acceptance and upgrades across all supported PCs, followed by a compatibility adapter and removal of internal legacy calls. Video retains its separate channel and prohibition on server-carried video bytes.

Checks: `src/rabiPeer.test.ts`, `scripts/rabilink-relay-peers.test.mjs`, and existing Relay runtime, persona LAN and Coordinator regressions. Automated success does not establish remote Relay deployment or public-network acceptance.
