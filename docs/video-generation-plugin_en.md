[English](video-generation-plugin_en.md) | [简体中文](video-generation-plugin.md)

# Media Workbench

Image nodes support Z-Image Turbo text-to-image with PNG output and the official eight-step CFG 1 res_multistep/simple workflow, with AuraFlow shift 3. Images and H3 share the managed ComfyUI process and serial queue. Model management scans or downloads the diffusion model, Qwen 3 4B encoder and AE VAE on demand. A single model root is shared; stop the service before changing it. Image dimensions must be multiples of 32 between 256 and 2048. Generated images can become video references. Image editing, reference-conditioned image generation and batches are not implemented.

Canvas nodes support dragging, left-button marquee selection, middle-button panning, a minimap, duplication and removal. Editors sit below selected nodes. Projects, cards and parameters save automatically on the server and restore by project ID after refresh. Save failures and concurrent conflicts display errors. Jobs and assets are persisted separately; see [media projects and autosave](video-projects_en.md).

Audio cards synthesize through RabiSpeech and display voice, speed, language and style controls according to model capabilities. Fixed voices come from the local VITS configuration; pause tags insert silence in the browser. Generated audio is saved with the project and can be uploaded as a video reference, subject to reference limits.


Aspect presets include 16:9, 4:3, 1:1, 3:4, 9:16 and 21:9. The 480P and 720P target tiers use the short edge and align both dimensions to multiples of 32. Actual dimensions are displayed, for example 1280×736 for 16:9 at the 720P tier. Combinations above 1032192 total pixels are unavailable; an oversized aspect change preserves the current settings and asks for a lower resolution first. The page currently offers the listed aspect and resolution presets; custom dimensions can be submitted through the protected job API.

`io.rabiroute.manager.video` adds a separate Media Workbench page at `/#/video`, alongside Speech. Manager owns plugin lifecycle, authentication, process leases and events. The plugin owns jobs and results; local ComfyUI performs H3 inference. Requests do not enter an Agent and videos are not automatically sent anywhere.

The dark workbench provides text, first/last frame and multimodal reference modes in a centered preview card and compact composer. The left toolbar opens job history on demand; selecting a job closes it. Download and parameter reuse sit below the preview. Image, video and audio references form a horizontal strip with clickable prompt labels; frames can be swapped. The bottom toolbar opens model selection and video parameters. A duration slider spans approximately 0.92–10.83 seconds in 17-frame steps, matching H3's supported frame counts. The job API retains width, height, frame count and seed fields. Filtering history preserves the preview; narrow screens retain the history toggle and a vertical creation area.

Text and first/last frames use MiniMax H3 FL2VA INT8; image, video and audio references use separate Ref2VA INT8 weights. Both models offer standard and fast routes with optional generated audio. See [workflow profiles and validation](video-workflow-profiles_en.md) for candidates, dependencies and compatibility with older API requests. Audio references condition generation; they do not guarantee dubbing, lip sync or direct soundtrack copying. Environment readiness, model availability, inference and visual acceptance remain separate checks. First/last images must match output dimensions.

## Local installation

Models and inference dependencies are optional and never installed merely by opening the page. Open Media Workbench → Model Management, configure a local model directory, install the runtime, then download the model. An NVIDIA CUDA GPU is required. The current catalog defines the download set and model management displays its file sizes. Shared files are reused across routes. New downloads verify official SHA-256 hashes and sizes; existing files are checked for size and safetensors headers and are not downloaded again. Failed downloads retain unique temporary files; retries download missing models anew without overwriting existing files.

Directory settings stay on this computer. An empty setting uses `components/video/ComfyUI/models`. Changing it does not move files. Configuration and installation require a local same-origin request and a stopped inference service. Exiting stops downloads; restarting does not retry them. Fresh-machine CUDA compatibility requires acceptance on the target computer.

Manual import is also available. Prepare an H3-capable ComfyUI Git checkout, a local Python environment with CUDA/PyTorch/ComfyUI dependencies, and these models (the legacy silent eight-step FL2VA route; see workflow documentation for standard, audio and Ref2VA dependencies):

- `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `vae/minimax_h3_video_vae_fp16.safetensors`
- `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`

From the video plugin package:

```powershell
.\Install-RabiVideo.ps1 -InstallRoot C:\RabiPC -ComfySourceRoot C:\Sources\ComfyUI -PythonExecutable C:\VideoPython\Scripts\python.exe -ModelSourceRoot D:\VideoModels
```

The installer exports the selected Git HEAD, copies models to local `components/video/ComfyUI/models`, and checks that safetensors files parse. It refuses to overwrite an existing component and retains failed staging for diagnosis. Python belongs to that computer and must be configured again on another computer. A virtual environment is not a portable runtime. Upstream model licenses apply independently of Rabi's MIT license.

Start from the Rabi page. Only the fixed installed ComfyUI component is launched, using an OS-assigned loopback port. API requests cannot supply scripts or arbitrary workflows. Disabling the plugin or exiting Host reclaims its child process. Restart does not resume generation automatically.

## API

### Multimodal references

Ref2VA installs on demand and shares the text encoder and video VAE. Its additional diffusion and audio VAE weights require about 20.1 GiB. Missing Ref2VA files do not block installed FL2VA models. The additional files are `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` and `vae/minimax_h3_audio_vae_fp32.safetensors`.

Install the runtime before uploading raw binary data to `POST /api/video/assets?kind=image` (or `video`, `audio`). Successful decoding returns an asset ID. `GET /api/video/assets/:id` previews it; add `?metadata=1` for type, dimensions and duration.

Reference jobs use `model: "minimax-h3-ref2va"`, `references: ["returned asset ID"]` and optional boolean `generateAudio` / `referenceVideoSound`. First/last frames cannot be mixed into this mode. Limits: nine PNG images (9 MB each, up to 4096×4096), three H.264 MP4 videos (64 MB each, 24 FPS, 2–15 seconds, up to 1920×1080 pixels), and three WAV clips (16 MB each, up to 15 seconds, stereo and 96 kHz). Invalid or oversized media do not receive readable IDs.

Prompts reference `<Picture 1>`, `<Video 1>` and `<Audio 1>`, numbered separately from one. Enabled video soundtracks precede standalone audio. Click a label to insert it; removing assets updates existing labels. Reusing reference jobs restores saved assets; first/last frame jobs require selecting images again. Assets reside in local `data/video/assets`; incomplete files are retained without automatic deletion.

### Common endpoints

Use the current Manager address published by Host READY and verified against `/meta`. Other computers use Rabi's authenticated LAN entry, never a directly exposed ComfyUI port. RabiLink Relay does not yet forward video APIs.

| Request | Result |
| --- | --- |
| `GET /api/video/status` | Service readiness, models, state labels and latest 100 jobs |
| `GET /api/video/models` | Local runtime/model installation state and progress |
| `GET /api/video/models/settings` | Local model directory and revision |
| `PATCH /api/video/models/settings` | `{modelRoot: string or null, expectedRevision: number}` |
| `POST /api/video/models/runtime` | Install optional inference dependencies |
| `POST /api/video/models/:id/download` | Download a catalog model; arbitrary URLs are rejected |
| `POST /api/video/runtime/start` | Start and check nodes and enumerated models |
| `POST /api/video/runtime/stop` | Stop when no jobs remain pending |
| `POST /api/video/jobs` | Create or replay using `Idempotency-Key` |
| `GET /api/video/jobs` | Latest 100 jobs |
| `GET /api/video/jobs/:id` | One job |
| `POST /api/video/jobs/:id/cancel` | Cancel a queued job |
| `GET /api/video/jobs/:id/video` | MP4 with single byte-range support |
| `GET /api/video/jobs/:id/image` | PNG result |
| `GET /api/video/projects` / `POST /api/video/projects` | List / create a project |
| `GET /api/video/projects/:id` / `PUT /api/video/projects/:id` | Read / save with revision |

```json
{"model":"minimax-h3-fl2va","prompt":"A paper boat floats on a quiet pond, locked camera.","width":512,"height":512,"frames":22,"seed":1}
```

Optional `firstFrame` and `lastFrame` accept raw PNG Base64, at most 9 MB each. Dimensions are multiples of 32, at least 256, with at most 1032192 pixels. Frame counts follow `17k+5`, from 22 to 260, at 24 FPS. A 512×512, 22-frame request is a smoke test only.

The same key and parameters return the original job; changed parameters return 409. Replay the original key after a lost response. At most eight jobs may remain pending. Failure or lost progress connection stops the plugin's provider and interrupts queued jobs, preventing unknown GPU work from overlapping another job. No automatic resubmission occurs. A running job cannot be cancelled individually; exiting Rabi interrupts it.

Local jobs reside under `data/video/jobs`, inputs/results under `data/video/provider-input` and `data/video/provider-output`, and logs under `logs/video`. History is not automatically deleted, compressed or migrated. APIs do not reveal local file paths. `succeeded` means the MP4 referenced by this H3 receipt exists and has a valid container header; visual quality and motion still require review.

Manager `/api/events` emits `plugin_event` messages named `video.changed` and `video.progress`. Clients reread a snapshot after reconnecting.

## Validation

Run from a local source directory:

```powershell
node --test plugins/builtin/io.rabiroute.manager.video/1.0.0/service.test.mjs
npm run build
npm run check:config
```

Deployment acceptance additionally requires the new installed version, plugin start/stop, actual inference and playback, lease cleanup on Host exit, and authenticated access from the target computer.
