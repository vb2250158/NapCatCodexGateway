[English](video-workflow-profiles_en.md) | 简体中文

# 视频工作流配置与验收

视频插件将用户参数转换为 ComfyUI API 图，通过既有生成队列执行。配置真源是插件 `catalog.json` 的 `models[].workflows`，图构造与参数校验在 `workflow.mjs`；前端不提供任意节点或执行脚本。

## 已实现的 H3 路线

| 输入意图 | 底模 | 标准 | 快速 |
|---|---|---|---|
| 文生、首帧、尾帧、首尾帧 | FL2VA INT8 | 20 步，不加载 LoRA | FL2VA Turbo 8 步 LoRA |
| 图片、视频、音频、混合参考 | Ref2VA INT8 | 20 步，不加载 LoRA | Ref2VA Turbo 4 步 LoRA |

各模式可独立输出声音：加载音频 VAE、解码采样器的音频输出并连接到 CreateVideo。参考视频原音是否作为条件使用，仍由 `referenceVideoSound` 决定，与输出声音开关分开。

依据：[ComfyUI 原生 H3 工作流](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)。本机节点版本未提供文档中较新的整合 Turbo 开关，因此使用等价的独立 LoRA 加载器、BasicGuider、res_multistep、simple 调度器和配套步数；不向旧节点传入它不支持的参数。

## API 与兼容

`POST /api/video/jobs` 接受可选布尔字段 `quickGeneration`。显式 false 选择标准，true 选择对应底模的快速配置。省略时保留原调用行为（FL2VA 8 步、Ref2VA 20 步），避免悄悄改变旧调用与重放语义。新增前端开关应始终提交布尔值。

任务记录包含实际 `workflowId`、`samplingSteps`。服务启动时按工作流和声音条件分别扫描所需节点与文件，通过 `availableWorkflows` 返回结果。快速依赖缺失不会使标准工作流下线；提交未就绪的组合返回 409，不降级、不丢弃参考输入。

模型管理保留全部文件的安装状态，并返回各工作流的无声基础依赖状态 `workflows`；有声运行是否就绪以服务的 `availableWorkflows` 为准。共享编码器与 VAE 沿用同一文件，不因新建路线重复下载。

## 本轮验证

- 单元与服务测试覆盖参数校验、标准与快速模型连线、独立声音、缺失加速依赖、任务幂等与失败处理。
- 16 张 API 图经过本机 ComfyUI `execution.validate_prompt` 校验：8 类输入 × 标准/快速，使用合成图片、视频、音频，全部通过。
- 7 个必需模型文件的字节数、可解析 safetensors 文件头、完整 SHA-256 均通过。Ref2VA Turbo 校验值核对 Comfy-Org/MiniMax-H3 官方仓库 LFS 元数据；已有文件直接复用，没有重复下载。
- 本轮未执行 GPU 推理，未比较速度或画质，未更新安装版或页面。参数校验不等于推理或成片验收。

## 自动候选路由

`workflowRouting.mjs` 按 catalog 中的 kind、priority、conditions 和运行时 availableWorkflows 筛选候选。快速生成不再固定绑定一个 ID。当前 FL2VA 新增官方 768p Turbo 4 步候选：产品策略限定短边至少 768、无声输出时优先；其余输入或该 LoRA 未就绪时选择兼容的 8 步候选。这个优先级是保守产品策略，不是实测速度排名或作者声称的音频能力限制。多模态素材仍只进入 Ref2VA 候选，不能跨底模复用 LoRA。

任务入队后保存所选 workflowId，构图按该 ID 执行，避免优先级或可用状态变化导致任务中途换路线。快速候选全部不可用时返回明确错误，不偷偷改成标准。路由条件支持参考类型集合；素材类型从服务端读取的资产记录取得。

本次 24 项测试、完整构建通过；增加的 native-fast 图通过本机 ComfyUI 原生校验（共 17 张图）。新增 LoRA 已存在，SHA-256 与官方 LFS 值一致，未重复下载。尚无本轮 GPU 推理、效果或加速倍数验收。

创作页固定显示 MiniMax H3，仅展示时长、比例、清晰度、生成声音、快速生成。已更新本地只读预览并检查实际开关；安装版尚未更新。

EasyCache、SageAttention，以及课程中的 Wan/LTX、口型、放大等路线仍未接入。它们需要各自的模型/节点/硬件兼容验证与适配，不能只改步数或套用 H3 LoRA。
