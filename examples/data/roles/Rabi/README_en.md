<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi

Rabi is RabiRoute's rabbit-eared guide and the character used by the default public Route.

This directory is a copyable persona example for `data/roles/Rabi/`. It shows how a companion persona can receive QQ and heartbeat events, explain routing and context in approachable language, and maintain plans and memories without changing RabiRoute's boundary as a Policy Router.

Webhook and voice-transcript input are optional extensions. They require a matching message adapter and Route configuration; they are not enabled merely by copying this persona.

Rabi's recent route also keeps live local speech capability separate from a static target-machine report. RabiSpeech is TTS/ASR infrastructure that does not enter an Agent, RabiLink is the system transport, and glasses, phones, or other clients remain the actual callers.

In version 0.3.1, plan approvals can select independent changes per question and show implementation details. Additional information returns the task to analysis; only explicitly approved scope may run. Web hot patches remain experimental: initial installation or backend changes require a full upgrade, and a successful build does not establish installed rollback acceptance.

## Directory contents

- `persona.md` defines identity, voice, boundaries, and routing behavior.
- `personaConfig.json` contains sample persona automation rules, recent-message limits, and may reference a same-directory persona image through `avatar`.
- `growth.md` describes how Rabi reflects and evolves.
- `skills.md` indexes the capabilities Rabi maintains.
- `skills/one-plan-one-task-tracking.md` is a platform-neutral plan-tracking example.
- `prompts/` contains scenario-specific runtime prompts.
- `plans/` and `memory/` demonstrate Agent-maintained context structures.
- `old/` is reserved for backups created before persona changes.

The runtime-semantic files above remain the authoritative source and are intentionally not duplicated into English variants. Translating a persona or prompt can change behavior, so language changes require a separately reviewed runtime entry.

## Rabi's story

Rabi imagines messages as parcels crossing a sea of stars. NapCat, Webhook, and heartbeat are ports; Routes are shipping lanes; personas label the intended recipient; the Agent at the destination performs the actual work.

The story grew with the project. Early RabiRoute only carried QQ messages toward Codex. As message adapters, route kinds, templates, health details, and persona-owned knowledge were separated, Rabi learned that successful delivery is not enough: every parcel also needs a reliable origin, context, policy, and return path.

That metaphor preserves the project's central boundary. RabiRoute does not become the answering bot or a complete Agent OS. It records events, applies routing policy, renders context, and delivers work to the selected handler. The handler answers, writes code, runs workflows, or calls tools.

Rabi also represents the project's preference for careful, incremental improvement. She should sound warm and playful, but never trade away factual accuracy, privacy, or action boundaries for charm.

When copied into `data/roles/Rabi/`, this example is more than a configuration bundle. It is a public demonstration of how a distinctive persona can live on top of a routing layer while keeping the router and the working Agent cleanly separated.
