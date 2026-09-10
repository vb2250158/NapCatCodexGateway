English | [简体中文](message-delivery-templates.md)

# Message delivery structure and templates

RabiRoute owns source verification, context assembly, routing and receipts. Handlers execute tasks. Templates carry the current task and API parameters without repeating a general Agent operating policy.

## Ownership

| Data | Owner | Boundary |
| --- | --- | --- |
| Source, body, context and control rendering | `src/shared/rabiMessage.ts` | `renderRabiDelivery` adds provenance; `renderRabiDeliveryContent` serves direct and mediated delivery. |
| Route-specific data | `src/routing/agentPacket.ts` | Produces a structured `delivery`; `message` and `content` are derived presentation. |
| Agent reply parameters | `src/agentRequests/replyParameters.ts` | Generates one complete request from verified parties and request records. |
| Requests, results and evidence | `src/agentRequests/store.ts` | Persists the structured reply and actual prompt SHA-256 before sending; failed receipt persistence retains recoverable evidence. |
| Uncertain receipt recovery | `src/agentRequests/deliveryRecovery.ts` | Matches an accepted user message by digest and restores results from the record, independent of new template headings. |
| Transport | Agent adapters / Desktop IPC | Does not invent provenance, add generic collaboration policy or grant tools through text. |

## Display order

1. `[消息源]`: source type, actual adapter, Agent/event type, name, complete IDs, applicable workspace and delivery time.
2. `[消息内容]`: the current request or result. Formal replies show result and next action once. Only exact duplicates are omitted; evidence is not summarized or truncated.
3. `[相关上下文]`: included only when needed, with references, attachments, record times, relevant plans and read endpoints.
4. `[回传参数]`: delivery identity, response policy and applicable complete API parameters. Scenario-specific writeback requirements may follow. Missing destinations are never inferred.

New deliveries do not generate `[协作要求]`, `[主动协作要求]` or `[本轮工作契约]`. Task-specific restrictions such as read-only work or no restart stay in the task body. Initialization duties and bound persona instructions remain at their existing entry points rather than being repeated per message.

## Scenario inventory

| Scenario | Behavior |
| --- | --- |
| Agent creation, continuation and reply | Complete identities and reply parameters; no repeated result in the contract. |
| Chat, references and attachments | Preserve author, time, message ID and evidence; retain existing same-ID complete-message deduplication. |
| Plan guidance and approval | Keep plan, step, approval and writeback data; read stable secretary duties from the owned skill. |
| Heartbeat, manual events and consolidation | Preserve trigger and scope; no external notification without new information; record blockers and next action. |
| Message Agents | Initialization owns duties; individual deliveries carry current ownership, handoff parameters and completion conditions. |
| Persona Hook | Initial context followed by deltas; no duplicate Manager address in the same base context. |
| Voice, glasses and review | Preserve device, session, observation range and output parameters. Tool availability does not authorize capture; no hardcoded person. |
| Merged replay | Outer time identifies this replay; inner time retains original delivery time or explicitly reports missing historical data, alongside the original attempt time. |
| User result notification | Use “result of this turn” with only the task name and result body, without a separate plan name. Execution ending does not imply business acceptance. Preserve lossless splitting and per-part receipts. |
| Custom Route templates | Preserve user semantics; omit empty supplements or supplements exactly equal to the current body. |

## Historical compatibility and retirement

New deliveries use only the current renderers. Previously accepted `[Agent 回复合同]` or v2 messages may still have pending reservations without `pendingResponseEvidence`. A read-only legacy parser serves those reservations only. When new evidence exists, a digest mismatch never falls back to text parsing.

The only migration path is to inspect the original request and accepted delivery evidence, then call `reconcile_delivery`, or use the original request's normal cancellation flow. Never resend content for migration or edit runtime storage directly. Remove the legacy parser only after every old pending reservation closes and compatibility checks pass. Completion, cancellation and definite delivery failure clear temporary reply evidence.

Desktop transport and receipt reading share `src/shared/deliveryIdentity.ts`, recognizing JSON reply parameters, source-header delivery IDs and necessary legacy formats. Existing IDs preserve the exact prompt bytes; a conflicting explicit transport ID fails delivery. Receipt scans read accepted user messages only, excluding tool output and assistant quotations.

Older transport code failed to recognize JSON and appended a second `[投递编号]` after evidence had been recorded. Historical recovery may remove only one exact terminal transport block, requires the original envelope ID to equal the reservation ID, and requires the remaining prompt digest to match exactly. Quotations, altered text, repeated trailers and extra trailing text cannot recover a receipt. Missing accepted user evidence remains uncertain and never authorizes a resend. Retire this compatibility branch after all affected reservations close.

Verification covers direct/mediated rendering, provenance, complete parameters, old receipts, recovery across restart, tampering, persistence retry, chat/plan/voice scenarios and user notifications. Source tests and builds do not prove Host deployment; runtime generation and artifacts must be checked separately.

Agent source headers combine type and adapter on one line (`类型：Agent｜处理端：codex`) and use shorter session and delivery-time labels. The default Agent role is omitted; specific roles remain separate. Full session IDs, workspace paths and timestamps are retained. Replay reads both timestamp labels without rewriting historical receipt evidence.
