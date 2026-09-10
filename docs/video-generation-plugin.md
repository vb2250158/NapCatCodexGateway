[English](video-generation-plugin_en.md) | 简体中文

# 媒体工作台

图片节点支持 Z-Image Turbo 文生图，输出 PNG，使用官方配套 8 步、CFG 1、res_multistep/simple 和 AuraFlow shift 3。图片与 H3 共用 ComfyUI 进程及串行队列。模型管理可扫描或按需下载主模型、Qwen 3 4B 编码器和 AE VAE；不自动下载。当前共用一个模型根目录，切换目录前须停止服务；目录需包含 diffusion_models、text_encoders、vae 子目录。图像尺寸提供 1K 比例预设和 2048×2048，服务端限制 256–2048 且为 32 的倍数。生成图可导入视频参考；此版本未提供图片编辑模型、批量生成或参考图生图。

画布支持节点拖动、左键框选、中键平移、小地图、节点复制与移除；选中节点下方显示编辑区。项目、卡片和参数自动保存到服务端，刷新后按项目 ID 恢复；保存失败与并发冲突会显示错误。生成任务和资产由服务持久化，详见[媒体项目与自动保存](video-projects.md)。

音频卡片通过 RabiSpeech 合成，按模型能力显示音色、语速、语言和风格参数。固定音色从本机 VITS 配置读取；停顿标签在浏览器中拼接静音片段。生成音频随项目保存，也可上传为视频参考，上传仍须满足参考素材限制。


画幅预设包括 16:9、4:3、1:1、3:4、9:16、21:9；分辨率提供 480P、720P 目标档位，以短边为基准并将宽高对齐到 32 的倍数。页面显示实际尺寸，例如 16:9 的 720P 档为 1280×736。超过 1032192 总像素的组合不可选；切换画幅若超限则保留当前设置并提示先降低分辨率。页面当前仅提供上述画幅与清晰度预设；自定义尺寸可通过受保护的任务 API 提交。

`io.rabiroute.manager.video` 在 RibiWebGUI 提供独立的“媒体工作台”页面（`/#/video`），与语音服务并列。Manager 管理插件、鉴权、进程租约和事件；插件管理任务与结果；本机 ComfyUI 执行 H3 推理。不会进入 Agent 或自动发送生成视频。

创作页提供文生视频、首尾帧和多模态参考三个入口。深色工作区内，居中的预览卡与紧凑编辑器组成创作区域；左侧工具栏按需展开作品历史，选择作品后收起。预览下可下载或复用参数，图片、视频、音频参考横向排列，点击编号插入提示词。首尾帧可交换，模型与视频参数集中在编辑器底部。时长通过参数弹层中的滑条调整，范围约 0.92–10.83 秒，每步 17 帧，自动对齐 H3 支持的帧数；任务 API 保留宽高、帧数和种子字段。筛选历史不打断当前预览，窄屏保留侧栏开关与纵向创作区域。

文字与首尾帧使用 MiniMax H3 FL2VA INT8，多图、视频、音频参考使用独立的 Ref2VA INT8。两种底模均提供标准与快速路线，并可选择生成声音；具体候选、依赖与旧 API 兼容规则见[视频工作流配置与验收](video-workflow-profiles.md)。声音参考属于生成条件，不保证配音、对口型或直接复制原声。运行环境、模型可用性、真实推理和画面验收分别确认。首尾帧必须与输出尺寸完全一致。

## 本机安装

模型和推理环境不随 Rabi 安装包分发，也不会随页面打开自动安装。在“媒体工作台 → 模型管理”中配置本机模型目录，点击“安装运行环境”，再点击“下载模型”。需要 NVIDIA CUDA 显卡。下载范围以当前 catalog 为准，模型管理显示所选模型的文件大小；共享文件复用，不按路线重复下载。新增下载检查大小与官方 SHA-256；已有文件检查大小和 safetensors 头，不重复下载。失败下载保留独立临时文件，重试重新下载缺失模型；不覆盖或自动删除已有文件。

目录设置仅在本机保存，留空使用 `components/video/ComfyUI/models`。修改目录不搬移模型，服务启动使用当前目录。目录设置和安装接口仅允许本机同源访问，且不能与推理同时进行。关闭程序会停止下载，重启不会自动重试。全新机器的 CUDA 驱动兼容性须在目标机器验证。

也可使用下列手工导入流程。部署者准备支持 H3 的 ComfyUI Git 源码、具备 CUDA/PyTorch/ComfyUI 依赖的本机 Python，以及以下四个模型（旧 FL2VA 无声 8 步路线；完整标准、声音与 Ref2VA 依赖见工作流文档）：

- `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `vae/minimax_h3_video_vae_fp16.safetensors`
- `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`

在视频插件包目录执行：

```powershell
.\Install-RabiVideo.ps1 -InstallRoot C:\RabiPC -ComfySourceRoot C:\Sources\ComfyUI -PythonExecutable C:\VideoPython\Scripts\python.exe -ModelSourceRoot D:\VideoModels
```

安装器导出指定 Git HEAD 的源码，把模型复制到本机 `components/video/ComfyUI/models` 并检查 safetensors 可解析。已有组件目录不会被覆盖；失败保留 staging 供排查。Python 环境属于该电脑，换机须重新指定，不能把虚拟环境目录直接当可迁移包。模型遵循其上游许可证，Rabi 的 MIT 许可不替代模型许可。

安装后从 Rabi 页面开关启动。插件只启动固定组件目录的 ComfyUI，绑定操作系统分配的本机回环端口，不接收任意脚本或工作流。插件停用及 Host 退出会回收其子进程；重启不会自动恢复生成。

## API

### 多模态参考

Ref2VA 按需安装，复用文本编码器与视频 VAE，额外需要约 20.1 GiB 的 Ref2VA 和音频 VAE 权重。未下载 Ref2VA 不影响已安装的 FL2VA。两个新增文件为 `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` 和 `vae/minimax_h3_audio_vae_fp32.safetensors`。

先安装运行环境，再通过 `POST /api/video/assets?kind=image`（或 `video`、`audio`）上传原始二进制。解码校验成功后返回素材 ID；`GET /api/video/assets/:id` 预览，附加 `?metadata=1` 读取类型、尺寸和时长。

参考任务使用 `model: "minimax-h3-ref2va"`、`references: ["上传返回的素材ID"]`，可选布尔值 `generateAudio`、`referenceVideoSound`，不能混入首尾帧。最多 9 张 PNG（每张 9 MB、最大 4096×4096）、3 段 H.264 MP4（每段 64 MB、24 FPS、2–15 秒、最多 1920×1080 像素）、3 段 WAV（每段 16 MB、最长 15 秒、最多双声道、96 kHz）。损坏或超限素材不发布可用 ID。

提示词以 `<Picture 1>`、`<Video 1>`、`<Audio 1>` 引用素材，编号按类型从 1 开始。启用参考视频原声时，其音轨排在独立音频之前。点击素材编号插入提示词，移除素材同步修正编号。复用参考任务恢复已保存素材；旧首尾帧任务仍需重新选图。素材在本机 `data/video/assets` 保存，未完成上传文件保留，不自动删除。

### 通用接口

使用 Host 当前 READY 发布并经 `/meta` 核对的 Manager 地址。其他电脑使用 Rabi 已有的受鉴权局域网入口，不直接暴露 ComfyUI。现有 RabiLink Relay 尚未接入视频 API。

| 请求 | 结果 |
| --- | --- |
| `GET /api/video/status` | 服务状态、模型、状态标签、最近 100 个任务 |
| `GET /api/video/models` | 本机运行环境、模型安装状态与进度 |
| `GET /api/video/models/settings` | 本机模型目录及 revision |
| `PATCH /api/video/models/settings` | `{modelRoot: string或null, expectedRevision: number}` |
| `POST /api/video/models/runtime` | 按需安装运行环境 |
| `POST /api/video/models/:id/download` | 下载清单中的模型；不接受任意 URL |
| `POST /api/video/runtime/start` | 启动并检查节点和模型枚举 |
| `POST /api/video/runtime/stop` | 没有待完成任务时停止 |
| `POST /api/video/jobs` | 使用 `Idempotency-Key` 创建或回读同一任务 |
| `GET /api/video/jobs` | 最近 100 个任务 |
| `GET /api/video/jobs/:id` | 单个任务 |
| `POST /api/video/jobs/:id/cancel` | 取消尚未开始的任务 |
| `GET /api/video/jobs/:id/video` | MP4，支持单段字节范围读取 |
| `GET /api/video/jobs/:id/image` | PNG 图片结果 |
| `GET /api/video/projects` / `POST /api/video/projects` | 列表 / 创建项目 |
| `GET /api/video/projects/:id` / `PUT /api/video/projects/:id` | 读取 / 携带 revision 保存 |

```json
{"model":"minimax-h3-fl2va","prompt":"A paper boat floats on a quiet pond, locked camera.","width":512,"height":512,"frames":22,"seed":1}
```

可选 `firstFrame` / `lastFrame` 为 PNG 原始 Base64，每张最多 9 MB。宽高为不小于 256 的 32 倍数，总像素不超过 1032192；帧数为 `17k+5`，范围 22–260，24 FPS。512×512、22 帧只适合快速冒烟测试。

同一个幂等键与相同参数回读原任务，参数变化返回 409；丢响应必须重放原键。队列最多 8 个待完成任务。失败或进度连接丢失时停止插件自己的生成进程，并中断未开始任务，避免未知 GPU 工作与下一任务重叠；没有自动重提。执行中的任务不能单独取消，关闭 Rabi 会中断它。

任务保存在本机 `data/video/jobs`，输入与成品在 `data/video/provider-input`、`data/video/provider-output`，运行日志在 `logs/video`。当前不自动删除历史、压缩或迁移文件。API 不返回本机文件路径。`succeeded` 说明本次 H3 回执对应的 MP4 已存在且容器头有效，不代表画面、动作和质量已由人工验收。

Manager `/api/events` 的 `plugin_event` 发布 `video.changed` 和 `video.progress`。客户端重新连接后回读快照。

## 验证

在本机源码目录执行：

```powershell
node --test plugins/builtin/io.rabiroute.manager.video/1.0.0/service.test.mjs
npm run build
npm run check:config
```

上线还须通过新安装版本验证插件启停、真实生成、视频播放、Host 退出后租约回收及目标电脑的鉴权访问。
