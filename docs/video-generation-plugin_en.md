[English](video-generation-plugin_en.md) | [简体中文](video-generation-plugin.md)

# Video generation plugin

`io.rabiroute.manager.video` adds a separate Video Generation page at `/#/video`, alongside Speech. Manager owns plugin lifecycle, authentication, process leases and events. The plugin owns jobs and results; local ComfyUI performs H3 inference. Requests do not enter an Agent and videos are not automatically sent anywhere.

Implemented: MiniMax H3 FL2VA INT8 with eight-step Turbo, text input, optional PNG first/last frames, serial jobs, idempotent submission, progress events, preview and download. Environment readiness, model availability, actual inference and visual acceptance are separate checks. API tests do not establish inference acceptance. Images must exactly match output dimensions. Output has no audio track.

## Local installation

Models and inference dependencies are optional and never installed merely by opening the page. Open Video Generation → Model Management, configure a local model directory, install the runtime, then download the model. An NVIDIA CUDA GPU is required. The four files total approximately 40.8 GiB. New downloads verify official SHA-256 hashes and sizes; existing files are checked for size and safetensors headers and are not downloaded again. Failed downloads retain unique temporary files; retries download missing models anew without overwriting existing files.

Directory settings stay on this computer. An empty setting uses `components/video/ComfyUI/models`. Changing it does not move files. Configuration and installation require a local same-origin request and a stopped inference service. Exiting stops downloads; restarting does not retry them. Fresh-machine CUDA compatibility requires acceptance on the target computer.

Manual import is also available. Prepare an H3-capable ComfyUI Git checkout, a local Python environment with CUDA/PyTorch/ComfyUI dependencies, and these models:

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
