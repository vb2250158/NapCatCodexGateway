<!-- docs-language-switch -->
<div align="center">
English | <a href="./local-speech-model-downloads.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiSpeech local model downloads and setup

This guide covers local models only. Paid speech APIs are archived, and remote callers cannot install models or mutate the local allowlist.

## On-demand downloads from Model Management

Open **Model Management** at the top right of **Speech Service** in RibiWebGUI. The retired `/#/models` address redirects to Speech Service. The dialog uses a compact environment bar above search and the model table. The only categories are TTS, ASR, and speaker recognition, with TTS selected by default and search scoped to the selected category. A task row appears only when a job exists, and detailed guidance is collapsed by default.

1. Select **Install speech environment** the first time. This prepares plugin-private dependencies and the Windows speech host without downloading weights.
2. Select **Download model** in the model table. Manager runs only one install or download job at a time, and the page receives state changes through events instead of periodic queries.
3. Model file status and runtime requirements are separate. **Needs isolated runtime** describes a requirement, not a detected missing environment; actual inference still requires the checks described below.

Existing models are checked read-only in the download root and model locations from the current RabiSpeech configuration; no synthetic install entry is required. Checks cover known components, nonempty files, and shards named by indexes. Empty directories and broken links are not downloaded models, but these checks are not full checksum or inference validation. For models stored elsewhere, configure the matching worker model path instead of downloading again or editing status records.

Expand **Model directory** to configure one root. Saving an empty value restores the default, including an existing `RABISPEECH_MODEL_ROOT` environment override. An explicit local absolute path overrides that default; the UI displays the effective directory. Detection and subsequent UI downloads share this root and the catalog's `tts/`, `asr/`, and `speaker/` subpaths. Changing it never moves or deletes models, and separately configured worker locations remain discoverable.

Directory settings are accessible only through the local WebGUI and persist in `data/speech/model-directory-settings.json` under the installation state root, outside release payloads. Changes are rejected during install/download jobs; concurrent edits require refresh rather than silent overwrite. Network paths, drive roots, installation trees, and source worktrees are not accepted as custom roots.

The page and command line share the allowlist in `plugin-adapters/rabi-speech/model-catalog.json`. Downloads cannot supply arbitrary repositories or URLs; the root is changed only through the separately validated local settings endpoint. CLI calls still use an explicit `--root`. Licensed ONNX-VITS packages remain manual imports.

## Private runtime layout

Do not put model weights, virtual environments, real reference audio, or runtime configuration in a Git checkout or a directory replaced by an installer. On Windows the default current-user layout is:

```text
%LOCALAPPDATA%\RabiPC\
  RabiSpeech\                 # config.json, microphone selection, temporary files, outputs
  models\rabispeech\          # install manifest plus TTS / ASR / speaker weights
```

Updating RabiRoute or reinstalling RabiSpeech replaces only the code package. On first start, a legacy package-local `config.json` is copied once into this user directory and is never overwritten afterwards. To use another local drive, set both `RABISPEECH_DATA_ROOT` and `RABISPEECH_MODEL_ROOT` before launch; neither may point at Git or NAS-sync storage.

## Common downloader

```powershell
$RABI_ROUTE_ROOT = 'C:\Path\To\RabiRoute'
$MODEL_ROOT = 'D:\RabiSpeechModels'
py -3.10 -m pip install -U 'huggingface_hub[cli,hf_xet]'
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --list
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" `
  --root $MODEL_ROOT --model <alias> --download-timeout 600 --etag-timeout 120 --max-workers 2
```

The downloader installs weights only. Keep every model family in an isolated Python environment.

## TTS

| Alias | Measured weight size | Official source |
|---|---:|---|
| `tts-qwen3-0.6b` | 2.34 GiB | [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) |
| `tts-qwen3-1.7b` | 4.23 GiB | [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) |
| `tts-gpt-sovits` | 5.13 GiB pretrained bundle | [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) |
| `tts-indextts2` | 8.29 GiB checkpoints | [IndexTTS2](https://github.com/index-tts/index-tts) |
| `tts-cosyvoice3-0.5b` | 9.08 GiB | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) |
| manual | 0.12 GiB in this test | Authorized split-graph ONNX-VITS package |

Clone the matching official repository, create its isolated environment, and point the private RabiSpeech `config.json` at both the runtime and downloaded weights. GPT-SoVITS also needs offline fast-langdetect and NLTK assets; use a clean continuous 3–10 second reference. IndexTTS2 officially recommends `uv`. CosyVoice must be cloned with submodules. ONNX-VITS requires `enc_p.onnx`, `emb_g.onnx`, `dp.onnx`, `flow.onnx`, `dec.onnx`, and the matching config; RabiSpeech does not redistribute models or speaker tables. `scripts/install.ps1` installs the frontend dependencies and downloads the official OpenJTalk dictionary during installation so Japanese inference stays offline at runtime.

## ASR

| Alias | Measured weight size | Official source |
|---|---:|---|
| `asr-whisper-large-v3-turbo` | 1.51 GiB | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| `asr-qwen3-0.6b` | 1.75 GiB | [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) |
| `asr-qwen3-1.7b` | 4.38 GiB | [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) |
| `asr-sensevoice-small` | 0.88 GiB | [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) |
| `asr-fireredasr2-aed` | 4.41 GiB | [FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S) |

Qwen3-ASR, SenseVoice and FireRed each need an isolated runtime. faster-whisper is included in the RabiSpeech core dependencies; download its tiny, small, and large-v3-turbo weights with aliases `asr-whisper-tiny`, `asr-whisper-small`, and `asr-whisper-large-v3-turbo`. On this Windows/Python 3.10 host, FireRed required `torch==2.1.0+cu118`, `torchaudio==2.1.0+cu118`, `setuptools<81`, and `kaldi_native_fbank==1.22.3`; its worker must receive the source checkout through `--repository-root`.

## Validation

```powershell
Invoke-RestMethod 'http://127.0.0.1:8781/health'
Invoke-RestMethod 'http://127.0.0.1:8781/v1/models'
Invoke-RestMethod 'http://127.0.0.1:8781/v1/models/local-tts/gpt-sovits'
```

Validate every TTS model with a decodable WAV and every ASR model with both a cold and warm real-audio request. A present directory or successful import is not sufficient.

## Windows troubleshooting

- Increase Hugging Face download and ETag timeouts for multi-GiB checkpoints; use `hf_xet` and fewer workers.
- Clear inherited `PYTHONPATH` and `PYTHONHOME` before isolated workers start.
- Pin `setuptools<81` for old `pkg_resources` consumers.
- Keep model repositories and venvs on a local disk when NAS package scanning triggers WinError 59.
- Use SoundFile for local GPT-SoVITS WAV input when TorchCodec/FFmpeg shared libraries mismatch.
- `nvidia-smi` reports driver capability, not the presence of user-space cuBLAS/cuDNN DLLs. Run real inference to validate CUDA.
- If microphone discovery or start fails, reinstall `sounddevice`, allow desktop microphone access in Windows privacy settings, and rescan from the RabiPC ASR tab. Capture belongs to the resident RabiSpeech process and does not depend on browser `getUserMedia` or remote-page HTTPS.
- PortAudio/Windows normally converts a device's default rate to 16 kHz. If it reports `Invalid sample rate`, set a supported 16/48 kHz format in Windows or pass the device-supported `sample_rate` to the local `/v1/microphone/start` endpoint.
- Do not select a virtual input that mixes speaker output. Playback suppression is a second guard, not a substitute for correct device selection.

See [the performance and capability report](rabispeech-performance-report_en.md) for measured results.
