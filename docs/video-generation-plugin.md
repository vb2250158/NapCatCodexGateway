[English](video-generation-plugin_en.md) | 简体中文

# 视频生成插件

`io.rabiroute.manager.video` 在 RibiWebGUI 提供独立的“视频生成”页面（`/#/video`），与语音服务并列。Manager 管理插件、鉴权、进程租约和事件；插件管理任务与结果；本机 ComfyUI 执行 H3 推理。不会进入 Agent 或自动发送生成视频。

当前实现：MiniMax H3 FL2VA INT8 + 8 步 Turbo、文字生成、可选 PNG 首尾帧、串行队列、幂等提交、事件进度、预览和下载。运行环境、模型可用性、真实推理和人工画面验收分别确认；API 测试通过不代表模型推理已经通过。首尾帧必须与输出尺寸完全一致，当前输出无音轨。

## 本机安装

模型和推理环境不随 Rabi 安装包分发，也不会随页面打开自动安装。在“视频生成 → 模型管理”中配置本机模型目录，点击“安装运行环境”，再点击“下载模型”。需要 NVIDIA CUDA 显卡。四个模型共约 40.8 GiB，新增下载检查大小与官方 SHA-256；已有文件检查大小和 safetensors 头，不重复下载。失败下载保留独立临时文件，重试重新下载缺失模型；不覆盖或自动删除已有文件。

目录设置仅在本机保存，留空使用 `components/video/ComfyUI/models`。修改目录不搬移模型，服务启动使用当前目录。目录设置和安装接口仅允许本机同源访问，且不能与推理同时进行。关闭程序会停止下载，重启不会自动重试。全新机器的 CUDA 驱动兼容性须在目标机器验证。

也可使用下列手工导入流程。部署者准备支持 H3 的 ComfyUI Git 源码、具备 CUDA/PyTorch/ComfyUI 依赖的本机 Python，以及以下四个模型：

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
