English | [简体中文](video-workflow-profiles.md)

# Video workflow profiles and validation

The video plugin converts user parameters into ComfyUI API graphs and executes them through the existing generation queue. `models[].workflows` in `catalog.json` owns the profiles; `workflow.mjs` builds graphs and validates parameters. The frontend cannot submit arbitrary nodes or scripts.

## Implemented H3 routes

| Input | Base model | Standard | Fast |
| --- | --- | --- | --- |
| Text, first frame, last frame, both frames | FL2VA INT8 | 20 steps, no LoRA | FL2VA Turbo eight-step LoRA |
| Image, video, audio and mixed references | Ref2VA INT8 | 20 steps, no LoRA | Ref2VA Turbo four-step LoRA |

Each mode can generate audio independently: load the audio VAE, decode the sampler's audio output and connect it to CreateVideo. `referenceVideoSound` separately controls whether a reference video's soundtrack conditions generation.

Reference: [ComfyUI native H3 workflow](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native). The node version used during implementation lacked the newer integrated Turbo option, so the graph uses a separate LoRA loader, BasicGuider, res_multistep, simple scheduling and matching step counts. Unsupported parameters are not sent to older nodes.

## API and compatibility

`POST /api/video/jobs` accepts optional boolean `quickGeneration`. Explicit false selects standard; true selects a compatible fast profile for that base model. Omission preserves the previous behavior: FL2VA eight steps and Ref2VA 20 steps. This preserves older request and replay semantics. The new frontend always sends a boolean.

Jobs record the selected `workflowId` and `samplingSteps`. At startup, the service checks required nodes and files separately for each workflow and audio setting, returning `availableWorkflows`. Missing acceleration dependencies do not disable standard workflows. Requests for unavailable combinations return 409 without dropping references or silently degrading.

Model management retains installation status for all files and exposes silent baseline dependencies per workflow in `workflows`. Audio readiness comes from the service's `availableWorkflows`. Shared encoders and VAEs are reused rather than downloaded per route.

## Implementation validation record

- Unit and service tests cover validation, standard/fast graph connections, independent audio, missing acceleration dependencies, idempotency and failures.
- Sixteen API graphs passed local ComfyUI `execution.validate_prompt`: eight input categories with standard and fast profiles, using synthetic image, video and audio fixtures.
- Seven required files passed size, readable safetensors-header and full SHA-256 checks. Ref2VA Turbo was compared with the official Comfy-Org/MiniMax-H3 LFS metadata. Existing files were reused.
- That profile-validation run did not execute GPU inference, compare speed or quality, or update the installation or page. Parameter validation is not inference or output acceptance.

## Automatic candidate routing

`workflowRouting.mjs` filters candidates using catalog kind, priority and conditions together with runtime `availableWorkflows`. Fast generation is no longer tied to one fixed ID. FL2VA adds an official 768p four-step Turbo candidate: product policy prefers it for silent output with a short edge of at least 768. Other inputs, or a missing LoRA, use the compatible eight-step candidate. This is conservative product policy, not a measured speed ranking or a claim about the author's audio capability limits. Multimodal references only use Ref2VA candidates; LoRAs are not reused across base models.

Queued jobs retain their selected workflow ID, so later priority or availability changes cannot switch their graph. When all compatible fast candidates are unavailable, submission fails explicitly instead of changing to standard. Conditions support reference-type sets obtained from server asset records.

The routing implementation recorded 24 passing tests and a full build. The extra native-fast graph passed ComfyUI validation, bringing that graph set to 17. Its existing LoRA matched the official LFS SHA-256 and was not downloaded again. GPU inference, output quality and speedup remain unverified for that run.

The creation page displays MiniMax H3 with duration, aspect ratio, resolution, generated-audio and fast-generation controls. The local read-only preview and its actual switches were checked during implementation; the installed version was not updated.

EasyCache, SageAttention, Wan/LTX, lip-sync and upscaling routes remain unimplemented. Each requires its own model, node and hardware compatibility checks and adapter; changing step counts or reusing H3 LoRAs is insufficient.
