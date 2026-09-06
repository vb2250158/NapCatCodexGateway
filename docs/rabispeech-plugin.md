<!-- docs-language-switch -->
<div align="center">
<a href="./rabispeech-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiSpeech TTS / ASR Provider 服务

RabiSpeech 是 RabiRoute 内、默认只监听回环地址的语音 Provider 服务。普通手动 TTS/ASR HTTP API 不进入 Agent，也不读取会话；常驻麦克风完成一段非空 ASR 后，由 Manager 把同一份文本广播给所有已开启“语音消息端”的 Route。各 Route 再独立执行 `speechPushMode=hot|keyword`，因此可以同时广播给多个人格，而不重复采集或重复跑 ASR。本地模型仍是默认值，OpenAI 兼容 API 与阿里云百炼 DashScope 只在本机配置显式启用后出现，不做本地到云端的静默回退。

```text
本机或任意远端客户端
  -> 本机 127.0.0.1:8781，或 RabiLink Relay + 通用应用 token
  -> RabiSpeech provider registry
  -> 本地 TTS / ASR worker，或显式启用的外部 API provider
  -> WAV 或转写结果
```

API key 只从 provider 配置点名的环境变量读取，例如 `OPENAI_API_KEY` 或 `DASHSCOPE_API_KEY`；配置、能力接口、日志和公开示例均不保存密钥。

## 当前模型

TTS：

- `onnx-vits`：固定声线，CPU，低资源。
- `gpt-sovits`：GPT-SoVITS 本地开源声线克隆；不是 OpenAI 云端 GPT TTS。
- `qwen3-tts-0.6b-base` / `qwen3-tts-1.7b-base`：本地 Qwen3-TTS 多语言参考音克隆。
- `indextts2`：中文克隆、情绪与时长控制。
- `cosyvoice3-0.5b`：本地 CosyVoice3，多语言、零样本与流式扩展能力。

ASR：

- `tiny` / `small` / `large-v3-turbo`：faster-whisper。
- `qwen3-asr-0.6b` / `qwen3-asr-1.7b`。
- `sensevoice-small`。
- `fireredasr2-aed`。

显式启用的 API 模型会和本地模型一起出现在 `/v1/models`，例如：

- `openai-api/gpt-4o-mini-tts`、`openai-api/gpt-4o-mini-transcribe`、`openai-api/whisper-1`；
- `dashscope-qwen/qwen3-tts-instruct-flash`：支持预置声线与角色发声指令；
- `dashscope-qwen/qwen3-tts-vc-2026-01-22`：使用已注册的 Qwen Voice Clone 声线。人格 `voice-profile.json` 只保存 `voice_env` 环境变量名，不保存真实 voice ID；
- `dashscope-qwen/paraformer-v2`：非实时会议转写，启用 speaker diarization，逐段返回 `speaker + start/end + text`。

会议模式复用 RabiSpeech 的本地静音切段，再提交 DashScope 异步文件转写任务。调用 `/v1/audio/transcriptions` 时选择 `model=dashscope-qwen/paraformer-v2`；语言会通过 `language_hints` 传入，已知参会人数时可额外传 `speaker_count`。结果按 `speaker + start/end + text` 返回；`SUCCESS_WITH_NO_VALID_FRAGMENT` 表示模型没有找到有效语音，RabiSpeech 将其记为空片段而不是服务故障，也不会重试。

Paraformer 文件转写的官方协议只承诺 `file_urls` 使用可公网访问的 HTTP / HTTPS URL，并明确不支持 Base64 音频、本地文件或二进制流。当前未配置正式上传器时仍存在 data URI 兼容路径；部分 DashScope 环境会把它临时转存到 OSS，但这不是公开生产合同。稳定部署应提供受控的临时上传 / OSS 签名 URL；在此之前，该兼容路径保持实验状态，不应作为高并发会议链路的可靠性保证。

角色声线从 `data/roles/<RoleId>/voice/` 读取。`voice/voice-profile.json` 是人格 TTS 配置唯一真源，统一维护模型、声线绑定、语言、语速和发声说明；Route 只维护语音消息端订阅、热/关键词投递与是否播放回复。主机麦克风、ASR 模型、VAD 和切句参数统一归 RabiSpeech。把角色 ID 传给 `voice` 即可使用角色，不需要创建 Route 或绑定 Agent。旧 Route TTS/ASR/VAD 字段仅作为兼容回退读取，不再由 WebGUI 新建或展示。TTS 播放由一条全局 FIFO 串行队列协调，跨 Route、会话、Agent、人格和模型都不抢播。

Manager 可以把显式提交到 `/api/work-events/ended` 的任务结束事件交给同一条 FIFO。语音服务页的“任务完成播报”控制来源开关、人格、模板、预览与近期回执；Manager 先清洗摘要，再从目标人格的 `voice-profile.json` 解析声线并调用本机 TTS。任务事件按日期物理分卷保留，播报账本只记录决策、摘要哈希和播放回执，不复制原始摘要。当前只完成生产者契约与消费链，真实 Codex / DSH 完成事件仍待各自接入；因此设置开启不能单独证明这些处理端已经会播报。

## 安装和运行

RabiRoute 的标准 Windows 安装包默认不安装语音识别、语音合成依赖或模型。只有需要语音功能时才执行下面的命令；`install.ps1` 会在插件私有目录安装依赖并生成 Windows 运行时，模型仍由 `install_models.ps1` 按需选择。

普通使用者也可以从 RibiWebGUI“语音服务”右上角打开“模型管理”弹窗：在紧凑环境栏安装语音运行环境，再筛选、搜索并从表格逐个“下载模型”；只有当前或最近任务存在时才显示任务行，安装说明默认折叠。旧 `/#/models` 地址仅跳回语音服务，不再保留独立侧栏页。下载操作不接受任意仓库、地址或路径；展开“模型目录”后，可通过单独校验的本机设置入口修改总目录，不能选择网络目录、磁盘根目录、安装目录或源码工作树。下载状态由后端核对管理目录及已配置模型路径中的代表文件，不再只认安装清单；“模型已下载”只说明这些文件存在，不证明校验和、独立环境或真实推理已经验收。“需独立环境”是运行要求，不是环境缺失的检测结论；后续配置见下载说明。

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\install_models.ps1 -List
.\scripts\test.ps1
```

依赖和模型准备完成后，只启动已安装的 `RabiRouteHost.exe`，再通过 RibiWebGUI 的“语音服务”开关启用 RabiSpeech。Host 创建 Manager，Manager 的语音插件持有 RabiSpeech；插件停用、应用代重建或用户退出时，同代 RabiSpeech 必须随之停止。`scripts/start.ps1` 仅供受控诊断，`scripts/install-service.ps1` 已退役并会明确失败，不能再创建独立计划任务或登录启动入口。

RabiSpeech 默认只监听 `http://127.0.0.1:8781`。首次启动生成 Git 忽略的 `config.json`；模型、参考音、输出和私有绝对路径均不提交。

RibiWebGUI“语音服务”页顶部提供整页 RabiSpeech 滑轨。开启时，已鉴权的 Manager 通过当前工作区 `scripts/start.ps1` 设置 Python 与私有依赖环境，再启动正式的 `runtime/RabiSpeech.exe`；只有轻量 `/health` 成功后才展开模型、音频流、ASR、TTS、声纹和播放参数。模型清单和预热在健康检查之后继续，不会让已经在线的服务被误报为启动失败。若启动日志显示端口冲突，Manager 只在确认占用者属于当前工作区且健康检查仍离线时终止旧进程，并重试一次；其他占用者保持失败关闭。关闭时，Manager 先核验监听端口确实属于当前工作区的 `runtime/RabiSpeech.exe` 或 `windows_host.py`，再停止进程并收起全部参数。端口归属不明时失败关闭，绝不按端口盲杀其他服务。该开关当前只支持 Windows 主机；Manager 只读模式继续禁止启停。服务切换期间旧 SSE 短暂断开属于自动重连过程，不显示成操作失败，也不触发布局抖动；运行时配置刷新不会反向提交一次无意义的设置保存。

启动失败时，Manager 返回简短结果、最后一次健康检查或启动日志中的具体原因，以及对应处理方法。语音服务页分别显示“具体原因”和“处理方法”；依赖缺失、实际冲突端口和配置错误会给出不同恢复动作。启动子进程统一使用 UTF-8 输出；日志最多返回末尾若干行，并把工作区和用户目录替换为安全占位符。

系统滑词菜单在 WebGUI“设置”页开启，操作说明见 [界面与状态](user-guide/interface-and-status.md)。“滑词朗读”是该菜单的子功能；开启后点击“朗读”，选中文字才进入本机 TTS 队列。

缓存过期清理在 `/health` 可用后转入后台，不再阻塞语音服务上线。服务关闭时仍等待正在执行的清理结束，避免清理任务脱离 RabiSpeech 生命周期。

Windows 冷启动会加载 Python 环境并扫描人格目录，Manager 最多等待 120 秒。启动进程仍在运行时不会在 60 秒处提前报错。

会议室远程声卡不改变这个控制面边界。在私有 `config.json` 启用 `remote_audio` 后，RabiSpeech 只额外开放带独立 Bearer 密钥的 TCP `8782` 音频 WebSocket 和 UDP `8783` 局域网发现。客户端只持续传 PCM、接收 WAV；VAD、切句、ASR、Route 广播、人格 TTS、FIFO 与防回流仍全部留在主机。安装见 [Rabi 语音客户端](../desktop/rabi-voice-client/README.md)。局域网直连不要求配置 RabiLink。

RabiLink 手机不依赖 ADB 进入音频流列表。每台安装持有独立、稳定的 `sourceDeviceId` 和稳定流 ID，并在建流时上报 Android 设备型号；经 Relay 自动连接后会作为单独客户端显示在 **语音服务** 顶部的共享音频流卡片，以“设备型号 + 稳定 ID 后缀”区分。该卡片位于 TTS/ASR 标签上方，因为远端设备同时承担 PCM 上行和人格语音下行。卡片把 PCM 收发、VAD、ASR 与 Route 投递分层显示，并按稳定设备 ID 关联解析公共转写及逐 Route 回执；收到 PCM 字节不再被误报为已经产生转写。多台可同时在线；首台在没有既有选择时可自动成为默认输入，后来者不抢占。`PUT /v1/audio-streams/selection`（经 Manager 时为 `/api/speech/audio-streams/selection`）只选择一路进入 VAD/ASR并持久化；所选设备离线时不回退到别的麦克风，原设备重连后自动恢复。

音频流收发、断连/恢复和 VAD/ASR/Route 阶段事件写入 `output/audio-stream-events/current.jsonl`，使用稳定事件 ID 与递增序号。事件触发检查发现超过 72 小时的记录时，只把连续前缀中超过 24 小时的完整记录无损移入 `archive/<first>~<last>.jsonl`，并原子更新 `archive/index.json`；WebGUI 通过分页读取当前文件与归档，不依赖进程内存。公共转写仍以 `data/speech/messages` 为事实真源，角色双向消息仍落各自人格目录，三者不会混写。

Android 手机/眼镜遵循同一“远端只传 PCM、主机拥有语音处理”的边界，但通过 Relay 受限 HTTP 流进入：`start` 建立虚拟远程麦克风，`chunk` 按从 1 开始的连续序号提交 16 kHz mono PCM s16le，`stop` 恢复之前的输入源。`rabilink` 消息端类型由这个专用入口强制决定，客户端不能把手机流伪装成 `speech`。RabiSpeech 在流上运行与本机相同的 VAD、切句、ASR 和声纹，然后自动提交 `messageAdapterType=rabilink` 的主机通用消息。Android 只有在 PC 确认后才提交 chunk 序号；同流重试继续按序号和 PCM 哈希幂等，ACK 丢失后即使重建临时流，稳定 `chunkId` 仍会按 `sourceDeviceId + chunkId + PCM SHA-256` 跨流去重，不重复喂给 ASR。相同 chunk ID 携带不同 PCM 会被拒绝。主机按稳定来源设备只保留最后一个已接收 chunk 的 ID 与哈希，不保存另一份原始录音。`start` 和每个成功 `chunk` 都会重置一次性 15 秒到期事件；只有到期事件触发时才停止失活流，不再固定间隔扫描。Android 不需要也不应暴露 VAD/切句/ASR 设置。

各模型下载、隔离环境和验证命令见 [本地语音模型下载说明](local-speech-model-downloads.md)。

## API 发现

先调用：

```http
GET /v1/models
```

响应包含 TTS/ASR 模型列表、安装状态、语言、功能，以及每个请求应传什么参数的 schema 和示例。其他发现接口：

```http
GET /health
GET /v1/capabilities
GET /v1/personas
GET /v1/microphone/status
GET /v1/microphone/devices
GET /v1/records
GET /openapi.json
POST /v1/audio-streams/rabilink/start
POST /v1/audio-streams/rabilink/chunk?streamId=...&sequence=1&chunkId=...
POST /v1/audio-streams/rabilink/stop
POST /v1/microphone/start
PUT /v1/microphone/settings
POST /v1/microphone/stop
```

TTS：

```bash
curl -X POST "http://127.0.0.1:8781/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"local-tts/gpt-sovits","input":"你好，这是本机语音。","voice":"Rabi","response_format":"wav"}' \
  --output speech.wav
```

常用字段：`model`、`input`、`voice`、`language`、`instructions`、`response_format`、`speed`、`sample_rate`、`play`、`session_id`、`route_id`。最终以 `/v1/models` 返回的逐模型 schema 为准。WAV 输出指定 `sample_rate` 时由 RabiSpeech 统一音频准备层本地重采样，不要求当前进程能发现 ffmpeg；只有跨音频格式转换继续依赖显式 ffmpeg 配置。

ASR：

```bash
curl -X POST "http://127.0.0.1:8781/v1/audio/transcriptions" \
  -F "file=@sample.wav" \
  -F "model=qwen3-asr-0.6b" \
  -F "language=zh" \
  -F "response_format=verbose_json"
```

必填 `file`；常用可选字段是 `model`、`language`、`response_format`、`speaker_count`、`session_id`、`route_id`。服务不接受通过请求远程安装模型或加载 Python 扩展。

为现有客户端保留两组同步兼容别名：

```http
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

它们只是请求格式兼容层；最终使用本地还是 API provider 仍由显式选择的 provider/model 决定。ASR 别名只接受 `data:audio/...;base64,...`，不会替调用方下载任意远程 URL。

## RabiPC 语音消息端

RibiWebGUI 的“语音服务”页可：

- 查询当前电脑模型、人格、设备和预热状态；
- 选择人格直接合成并播放，模型、声线、语言、语速和表达方式从人格配置只读加载；
- 在全局播放队列卡用 `0–100` 滑条和精确输入调整主机音量；设置由 RabiSpeech 持久化，每条音频开始播放时读取，因此新值从下一条开始播放的音频生效，不属于 Route 或人格配置；
- 在页面顶部切换 TTS / ASR 管理；
- 配置由 RabiSpeech 进程持有的主机麦克风、ASR 模型、动态 RMS、录音/转写双阈值、前置缓存和静音切句；运行中修改会自动恢复监听；
- 像芬妮笔记一样在当前 ASR 区域查看最近转写预览，完整文本由后台按日期持续落盘；
- 查看当前模型需要的请求参数；
- 查看当前订阅 Route 数量；本页不再配置“投递 Route”或人工会话 ID。

Windows 会按 EXE 记住上一次 Core Audio 会话倍率。RabiSpeech 启动时建立一个持续无声的共享输出会话，把旧的 `1%` 只归一一次到 `100%`，随后只保活、不再回写音量。Windows 音量合成器中的 RabiSpeech 滑条因此在服务运行期间持续可调，真实播放复用同一会话；无声保活不进入 FIFO，也不触发麦克风防回流。

芬妮笔记风格的主机链路面板统一放在“语音服务 → ASR”，按 `主机麦克风 → VAD 切句 → ASR 转写 → 广播投递 → 回复与播放` 展示真实状态、计数器、最近事件和转写预览。Route 的“消息适配器 → 语音消息端”只保留当前 Route 的热投递/人格关键词策略、人格 TTS 摘要和回复自动播放开关，不再显示主机波形、计数器、运行日志或最近转写。ASR 页的“开启 ASR 串流”独立控制整台主机是否持续录音和识别；Route 的语音消息端开关只控制各自是否接收完成的转写。没有 Route 订阅时仍持续识别并保存主机记录；关闭主机总开关会立即停止持续采集。手动上传音频识别不受该开关影响。

语音消息端投递的 `voice_transcript` 会让该 Agent 回合进入 `character-tts-dialogue` 状态。`AgentPacket` 注入 `characterTtsDialogue=true`，并生成带发送者占位、精确 `routeId`、`channel=speech` 和当前 `params.sessionId` 的发送模板；Agent 填写自己的 `sender.agentType` 与完整 `sender.sessionId`，再把与屏幕回复同义的短句交回 `/api/agent/send`。Outbox 绑定当前 Route 的人格 ID 和语音 `sessionId`，RabiSpeech 再从该人格的 `voice-profile.json` 解析模型、声线、语言、语速和表达指令，最后进入主机级 FIFO。这个自动状态只针对 `speech` / RabiSpeech 来源，不会让 QQ、角色面板或普通文字消息自动发声。

### 热投递与人格关键词

Route 的“热投递”开关直接对应 `adapterConfig.json.speechPushMode`：

- 开启（`hot`）：每段 ASR 转写完成后立即投递给已绑定 Agent；当前 Desktop turn 正在工作时使用 `steer`，否则使用 `start`。
- 关闭（`keyword`）：所有 ASR 仍然写入语音记录和人格双向会话账本；只在文本命中该人格 `personaConfig.json.speechTriggerKeywords` 中的人格名、常用称呼或唤醒词时才投递。
- 关键词列表为空时，转写会持续记录，但不会唤醒 Agent；系统不会暗中回退到 `hot`。

关键词归人格，因为同一个人格可能被多条 Route 复用；热/关键词模式归 Route，因为它决定这条语音入口的即时投递策略。

### ASR/TTS 双向上下文

常驻 ASR 的主机通用记录会保存整段 RMS、峰值、采集时间、来源、音频格式、模型、完整说话人分段和可用逐词时间；同一字段继续进入人格语音历史与会话上下文。RMS/峰值只是音频事实，主机不会据此判断身份或谁是用户。`pre_roll_ms=0` 只关闭额外前置缓冲，不得丢弃触发 VAD 的句首 PCM。

多人合成声纹预检使用 `scripts/test_multivoice_voiceprint.py`：它既能接收现有 TTS WAV，也能经回环 RabiSpeech API 自己用多个声线生成匿名音频，再合成一个文件。脚本先读取 `/v1/models` 的当前合同，完整模型 ID 直接使用，唯一短名解析为完整 ID，歧义或不可用时失败关闭。显式合成边界先调用真实本机声纹模型；可选会议 ASR 模式再按 Provider 返回的时间 turn 验证自动分段和逐 turn 声纹。Provider 的 speaker 标签少于预期但 turn 完整时，本机声纹可通过不同 voiceprint 明确纠正合并；turn 或 voiceprint 数量不足才失败关闭。该脚本不把已知边界宣传成 ASR 自动分人，输出不保存正文、声线名或原始声纹 ID，始终标记为合成数据且不能解锁正式 `validated`。

RabiSpeech 自身按日保留 ASR/TTS 文本诊断记录；一旦语音经 Route 进入人格，RabiRoute 还会把 ASR 入站和成功 TTS 出站归一到：

```text
data/roles/<RoleId>/conversation/current.jsonl
```

常驻 ASR 完成后会先把一份主机级通用消息写到 `data/speech/messages/YYYY-MM-DD.jsonl`。这份记录保留稳定 `recordId`、采集开始/完成/接收时间、Provider、模型、语言、时长、峰值、采样率、声道、音频格式、通道类型、物理传输、稳定来源设备、临时 `sourceStreamId`、`sourceHostId/sourceHostName`、完整说话人分段，以及 Provider 可用时的逐词起止时间、概率/置信度和逐词说话人标签，一段录音无论被多少 Route 消费都只落一次。稳定 `sourceDeviceId` 用于回复目标，`sourceStreamId` 只标识本次 PCM 连接，两者不得混用。随后按 `messageAdapterType` 分发：本机麦克风和普通 Rabi 语音客户端是 `speech` 消息端，手机音频流是 `rabilink` 手机消息端；Route 只消费自己已启用的消息端。每个绑定人格分别写入自己的 `voice-transcripts.jsonl` 和 `conversation/current.jsonl`，两份人格文件都保留上述来源、流、音频格式、模型、分段和逐词时间证据，同一人格被多条 Route 命中时避免重复记录。主机诊断人物名称仍在通用入口被删除，不会借逐词字段重新进入人格身份判断。

每条真正送入 ASR 的 VAD 短语音会在 RabiSpeech 私有 `output/asr-audio/` 中缓存 24 小时，诊断记录只保存安全相对引用与预计过期时间。WebGUI 通过受限的 `GET /api/speech/records/:recordId/audio` 回听，接口不接受任意文件路径；到期或文件不存在返回明确的过期状态。这个缓存不保存阈值以下的连续 PCM，也不改变公共转写、人格式会话或记忆的保留规则。

主机声纹层只提供不透明的稳定声纹 ID、未知簇、分段标签、分数和判定证据，不写入人名，也不判断声纹对应谁或谁是“用户”。当前人格应结合自己的关系、记忆和会话上下文解释某个声纹是谁、是否需要响应，并可通过 `/api/roles/:roleId/voice-identities` 写入自己追加式的 `voice/voice-identities.jsonl`。同一声纹字符串按 `sourceHostId` 分域，避免多台电脑的本地聚类碰撞。多人分段在进入人格上下文时保持原结构，Agent 不再只看到丢失说话人信息的平铺文本。

人格可通过 `GET /api/roles/:roleId/voice-transcripts` 查询这些归类的只读联结结果。返回的 summary 从完整时间/说话人筛选集合计算用户、他人、未知、冲突的分段数和说话人时长，给出 `coverageRate` 与 `unresolvedVoiceprints`；明细 `limit` 不会截断 `matchedCount` 或 summary。只需要汇总时可传 `includeDetails=false`，此时仍从完整筛选集合计算 summary，但不把转写明细或正文发给调用端。该覆盖率只在读取时派生，不会回写主机原始消息、人格会话或语音账号兼容数据文件，也不会被主动智能周期查询。多 PC 对同一声纹产生并发 `isUser` 或删除分歧时，追加事件会保留多个分支头，查询明确返回 `conflict`；人格再次确认后由新事件同时收敛全部当前分支。

RibiWebGUI 的“人格配置 → 身份关系 → 语音消息端账号”使用上述汇总模式展示最近 24 小时覆盖率、用户/他人/未知/冲突统计、未解决声纹缩写和已归类关系，不读取或展示转写正文。按钮只调用人格 `voice-identities` 兼容 API 追加明确的 `isUser=true/false/未判断` 事件，界面不维护第二份判断。第一次不知道哪个 ID 属于自己时，可主动开始“标记下一段”：界面只记住本次开始时间与当前未解决声纹的最后出现基线，等下一次 `records_changed` 后把基线之后新出现或再次出现、且具有稳定 `sourceHostId` 的未归类声纹标成候选；即使只有一个候选也不会自动写 `isUser`，多人同时说话时会同时保留多个候选供用户判断。页面进入、切换人格、人工操作后查询一次；新录音使用 RabiSpeech `records_changed`，人格关系写入和多 PC 文件合并使用 Manager SSE 事件触发一次刷新，不做覆盖率轮询。事件流重连后也会重新查询一次，补上断线期间可能错过的变化。

主机通用消息的 `recordId` 检查与追加使用同一把跨进程锁，因此相同 ASR 的并发请求、HTTP 重试或 RabiSpeech 补交只会生成一条原始消息。Manager 还会在 `data/speech/deliveries/YYYY-MM-DD.jsonl` 为每个 `recordId + Route` 保存成功或仅记录的终态 receipt；receipt 的日文件追加同样串行，不会产生交错 JSONL。已有 receipt 会被直接复用，不再次唤醒同一人格；失败终态不落成功 receipt，修复 owner/IPC 后仍可安全重试。

本机/独立语音消息端的自动最近上下文按当前人格、`speech` 逻辑消息端和同一 `sessionId` 过滤；手机音频流按当前人格、`rabilink` 逻辑消息端和来源设备过滤。两类入口使用各自的 `recentMessageLimits` 额度，`0` 只关闭自动注入，不停止记录。AgentPacket 的来源上下文保留 Route、消息端、`sourceDeviceId/sourceDeviceKind` 与 `channelType`，同时生成明确发送模板。手机来源的消息要回到 RabiLink 下行流时，调用方必须提交 `channel=rabilink`，并在 `params.targetDeviceIds` 中明确填写原始稳定设备 ID；来源设备不会再被接口自动当作发送目标。

当前默认值沿用旧 FenneNote 本机配置：`faster-whisper/small`、中文、系统默认麦克风、16 kHz、自适应 RMS 阈值、录音线 `0.01`、转写线 `0.015`、阈值以下持续 `500 ms` 切句、最短 `1000 ms`、最长 `60000 ms`、前置缓存 `1500 ms`、输入增益 `1.0`。RabiSpeech 保留原有自适应系数 `2.5` 和余量 `0.004`。这些是本机起点，不是所有麦克风的通用最优值。

如果“说了很多但某个 Route 没有消息”，在“语音服务 → ASR”的主机链路面板从左到右判断：

1. 麦克风显示“未启动”：确认“开启 ASR 串流”已打开；开关保存或服务恢复失败时查看面板错误和 RabiSpeech 状态。
2. 实时电平变化但“捕获片段”不增长：检查输入设备、底噪、录音线与动态阈值。
3. 已捕获但“识别成功”不增长：查看最近事件中的空片段、ASR 模型或识别错误。
4. 已识别但当前 Route 没有终态：确认该 Route 的语音消息端订阅和运行状态；若已关闭热投递，再检查文本是否命中该人格关键词。其他 Route 的成功不会冒充当前 Route 成功。
5. Route 成功但没有回复/播放：继续检查 Agent 投递记录、TTS 队列和播放错误。

运行事件仍只保存于当前 RabiSpeech 进程内，用于阶段、耗时和错误诊断。与芬妮笔记按日期写转写文件的方式一致，ASR/TTS 文本元数据统一追加到被 Git 忽略的 `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl`，并在服务重启后保留；WebGUI 在 ASR 页面内嵌展示最近的持久化双向记录，不再提供独立的会议记录选择、说话人摘录或导出卡片。默认不复制 ASR 原始录音。人格 TTS 的完成音频保存到对应的 `data/roles/<RoleId>/voice/cache/tts-audio/`；不属于已解析人格的直接 TTS 才使用 RabiSpeech 私有 fallback 缓存。两者都默认保留 `1440` 分钟（24 小时），按每个文件自己的 mtime 计算。服务启动时扫描一次，之后只维护最早到期的一次性 cleanup deadline；新成品只有更早到期时才重排，不做固定周期目录扫描。记录 API 与 WebGUI 只暴露 POSIX 风格的安全逻辑相对路径：人格记录为 `<RoleId>/voice/cache/tts-audio/<file>`，fallback 为 `output/tts-audio/<file>`；旧记录可继续显示单个文件名，绝不返回本机绝对路径或包含 `..`、反斜杠越界的引用。界面显示的是“预计过期时间”，进程停机或系统调度仍可能让实际删除更晚。文本记录与音频缓存互相独立，音频超过保留窗口不会删除文本记录；`GET /api/speech/records` 仅保留为诊断查询接口。

主机通用 ASR 真源 `data/speech/messages/YYYY-MM-DD.jsonl` 可按指定时间段导出为私有 Markdown 阅读视图：

```powershell
npm run export:speech-transcript -- --from "2026-07-30T08:00:00+08:00" --to "2026-07-30T10:00:00+08:00"
```

默认输出到 `data/speech/exports/`，每行格式为 `[时间] 说话人：说话内容`。工具按稳定 record ID 去重、按语音分段时间排序；公共层没有确认身份时只使用说话人标签或不透明声纹 ID，不把声纹擅自解释成某个人。时间范围为左闭右开，建议传带 UTC offset 的 ISO 时间；已有输出默认拒绝覆盖，只有显式 `--force` 才替换。Markdown 是可原子重建的派生视图，不替代公共 JSONL、人格 `voice-transcripts.jsonl` 或统一双向账本，也不触发归档、记忆沉淀或删除。

RabiSpeech 仍可在本机诊断界面保存操作员标注和声纹原型，但这些人名只是诊断兼容数据，不是 Route 或人格的身份真源。`output/speaker-embeddings.json` 保存神经 embedding、人工确认原型和未知聚类；每个可提取分段显式输出稳定、不透明的 `voiceprint_id`，其值来自该主机的 cluster。同一未知声音在服务重启后会继续从该文件匹配原 cluster；全天有界裁剪会为每个仍活跃的未知簇保留至少一个原型，避免安静说话人被更高频声音完全挤出。进入 RabiRoute 主机通用消息前会删除 `speakerName/speakerSuggestionName`；主机 profile `speaker_id` 和候选 `speaker_suggestion_id` 可保留为诊断字段，但人格的 `user/other` 分类与 AgentPacket 身份注入只使用 `sourceHostId + voiceprintId`，绝不使用主机人物资料代替人格判断。系统不把 diarization 的 `Speaker 1`、`0` 冒充身份，也不按长生命周期 `sessionId` 继承。原始注册音频不复制，embedding 不通过 API 返回；某个声纹到底是谁、是不是用户，必须由收到它的各个人格分别解释。

声纹模型在进入主进程前先由独立子进程做兼容探测。RabiSpeech 的唯一正式声纹提取后端是 ONNX Runtime + kaldi-native-fbank：16 kHz、80-bin FBank、全局均值归一化，再输出 192 维 embedding；它会在子进程中先完成一次真实推理。旧的 Windows sherpa-onnx native 特征管线因无法加载当前官方 3D-Speaker 模型而不再进入正式运行链。当前后端不可用时，主服务继续提供其他语音能力，并在 `voiceprint.reason` 暴露失败原因，不会隐式切换到另一套 runtime。人物确认原型按 `max_samples_per_profile` 保持有界，未人工确认的聚类和自动匹配样本按 `max_unconfirmed_samples` 保持有界；低于 `min_voiced_rms` 的帧和明显跨说话人重叠片段不进入 embedding 仓库。未知簇使用 complete-link 门禁：新 embedding 必须对簇内每个现存样本都达到 `cluster_threshold`，避免混合/桥接样本通过质心把不同声音误并；保守拆簇优先于错误合人。自动匹配结果不会反向成为训练原型，只有人工确认样本拥有原型解释权。

运维或 Agent 可运行 `py -3.10 scripts\speaker_model_probe.py --config config.json`，让探针按服务相同规则解析配置和相对模型路径。脚本按自身位置加载 RabiSpeech 与私有依赖，因此不要求调用者先切换工作目录。返回 192 维 embedding 只证明本机提取链可运行，不替代真实同人/异人阈值报告。

声纹匹配和多人分离是两层能力：前者回答“这段声音像谁”，后者回答“谁在什么时间说话”。Provider 已返回可靠的 `speaker + start/end` 时可以直接逐 turn 提取多人 embedding。对于 faster-whisper 这类只有 `start/end`、没有 diarization 标签的本地 ASR，RabiSpeech 还会按 `speaker_recognition.unlabeled_turn_gap_seconds`（默认 `0.5` 秒）把被静音隔开的连续时间段组成临时 `voice#turn-N`，逐轮提取 embedding，再由声纹聚类合并同一说话人。没有时间段、段间没有足够静音，或多人重叠说话时仍不能可靠分离；这项本地静音分轮不能冒充重叠语音 diarization。

本机 RabiSpeech 控制面与 Manager 镜像接口保持不变。ASR 页按已知人物或跨录音未知声纹簇展示最近话语，并保留逐录音下拉纠正。默认 ERes2NetV2 模型需显式安装；模型缺失时回退纯人工模式。模型存在但 `validated=false` 时默认只做聚类和候选提示；本机只有显式设置 `experimental_auto_assign=true` 才允许带实验标记的自动认人，而且 capability 仍不会声明正式支持。正式模式必须同时设置 `validated=true` 与 `validation_report_path`；运行时会核对报告 schema、`dataset_kind=real_person_private`、`formal_validation_eligible=true`、dataset manifest SHA-256、policy SHA-256、完整门禁结果、目标模型 ID/模型 SHA-256、hard threshold 和 min margin，任何一项不一致都会关闭正式自动认人并通过 `voiceprint.reason` 说明原因。

正式校准应为 `scripts/benchmark_speaker_models.py` 提供私有同人/异人语料、显式 `--policy` 和 `--require-pass`。脚本会检查真人数据集资格、数据集最小规模、EER、固定阈值 FAR/FRR、已知识别率和未知保留率，并把数据集 manifest、policy、模型的 SHA-256、实际 threshold/margin 与逐引擎 policy 结果写进 schema v1 报告；合成、旧版/未声明数据集或任一门禁未通过时仍写完整 JSON，但以退出码 `2` 失败关闭。该脚本已和模型探针统一为自举入口，可从仓库根目录或任意工作目录运行，不要求预先设置 `PYTHONPATH`。通过后把该私有报告路径写入 `speaker_recognition.validation_report_path`，再设置 `validated=true`。`benchmarks/speaker-validation-policy.example.json` 只是可复制调整的起始示例，不代表当前电脑、麦克风、房间或人群已经通过。

`scripts/collect_speaker_validation.py` 补齐私有语料采集入口。`devices` 列出输入设备，`record` 直接采集，`add` 导入已有 WAV，`status --policy ...` 在运行模型前检查 32 段、人物数、未知测试人物和同人/异人 pair 等规模门禁。新建、旧版或未声明 manifest 默认无正式资格；只有操作者确认目录内全部样本都是真人录音后，显式执行 `init --confirm-real-person-recordings` 才会写入 `dataset_kind=real_person_private` 与 `formal_validation_eligible=true`。默认数据放在 Git 忽略的 `benchmarks/private/speaker-validation/`；manifest 原子更新且旧版本先归档。工具不读取人格、不写人物关系、不自动开启 `validated`，数据集标签也不能被主机解释成“用户”。完整命令见插件 [README](../plugin-adapters/rabi-speech/README.md)。

合成 TTS 只能作为真人采集前的机制预检。2026-07-23 的一次本机预检使用显式启用的 `dashscope-qwen/qwen3-tts-instruct-flash`，以 4 个已知系统声线各 3 条 enroll + 3 条 test、2 个未知系统声线各 4 条 test 生成 32 条不同中文句子；采集工具统一成 16 kHz mono 后，当前 ERes2NetV2 在 threshold `0.72`、margin `0.06` 下得到 EER `2.804%`、FAR `0.236%`、FRR `5.556%`、已知识别率 `100%`、未知保留率 `100%`。该结果只证明 embedding 提取、同/异声线分离、已知识别与未知拒识机制能工作；系统音色不是真人，不能覆盖真实麦克风、房间、噪声、重叠说话、跨日变化或亲属近似声线。运行目录必须保持 Git 忽略，并用 `dataset_kind=synthetic_tts` 与 `formal_validation_eligible=false` 标注；此报告不得写入 `validation_report_path`，不得据此设置 `validated=true` 或宣称已能自动判断谁是用户。

`npm run check:rabispeech:tts-loop` 提供独立于本机模型性能报告的运行时闭环烟测。它连接已经运行的回环 RabiSpeech/Manager，先订阅 `/api/speech/events`（跳过 Manager 时订阅 `/v1/events`），再执行 TTS → 16 kHz mono WAV → ASR → 声纹证据 → 同会话记录查询。SSE 必须收到 TTS 与 ASR 两个 `records_changed` 终态后才查询一次记录；超时由单次 deadline 结束，不轮询。脚本不启停麦克风、不播放、不调用 `/api/speech/messages`，因此不会唤醒 Route。自动选模优先本地，API Provider 必须显式传 `--allow-api-provider`。输出位于 Git 忽略的 `output/acceptance/`，正文、声线和原始声纹 ID 均不写入报告，并固定保持 `formalValidationEligible=false`。完整参数见插件 [README](../plugin-adapters/rabi-speech/README.md)。

构建后运行 `npm run check:speech-ingress-separation`，可在不接触真实人格和消息端的情况下验收主机通用消息与人格关联。脚本用临时数据根和真实 `dist/index.js` 子进程处理一条 `speech` PC 麦克风记录与一条 `rabilink` 手机记录，检查同一主机库恰好两条、两个隔离人格各自只有一条 `voice-transcripts.jsonl` 和一条 `conversation/current.jsonl`、主机人物字段被删除，以及手机回复目标只来自稳定设备而不是临时 PCM 流。没有固定间隔检查，子进程通过退出事件与单次 deadline 收敛；不会访问当前 Host READY 发布的 `managerBaseUrl`、Desktop、QQ、Relay、麦克风或真实 `data/roles`。其他需要连接正式 Manager 的验收必须从 Host `status --json` 读取动态地址，并核对 `/meta` 的 `applicationGenerationId` 与 `managerInstanceId`，不能扫描或复用旧端口。

`GET /api/speech/messages?limit=200` 读取最近的主机通用语音消息；`GET /api/speech/messages?recordId=<id>` 返回指定原始消息和它最新的逐 Route 终态 receipts。这个只读入口面向本机 Agent、诊断工具和后续管理界面，不代替人格自己的 `conversation/current.jsonl`。

`POST /api/speech/messages` 不再返回模糊的 `202 Accepted`。常驻 ASR 省略 `routeId`，并显式提交 `messageAdapterType`、`channelType`、`source/transport`、来源设备、采样率和完整分段。Manager 只广播给启用了对应消息端的 Route，并在 `deliveries[]` 中返回每个 Route 的独立终态；显式 `routeId` 只保留给调试和兼容调用。Manager 等待 Gateway 子任务返回 Desktop 投递终态（最多 40 秒），但不等 Agent 生成回答、Outbox 回传或 TTS 播放完成：

- `200` + `status=delivered`：目标 Desktop owner 已成功接受 `start` 或 `steer`。
- `200` + `status=recorded`：关键词模式下未命中，文本已完整记录，但未唤醒 Agent。
- `200` + `status=recorded` + `reason=no_enabled_speech_routes`：当前没有订阅 Route，转写仍保留在 RabiSpeech 记录和 RabiRoute 主机级语音消息库中，不写入任何人格。
- `200` + `status=recorded` + `reason=no_enabled_rabilink_routes`：手机音频已识别并写入主机通用消息，但没有 Route 启用 RabiLink/手机消息端。
- `4xx/5xx`：显式 Route 不存在/未启用，或所有订阅 Route 均因 Desktop owner、IPC、超时等原因失败。

因此界面的“Desktop 已投递”和“仅记录”是两个真实终态；不能再用“Route 已受理”冒充 Desktop 已收到。

`server.tts_audio_dir`（或 `RABISPEECH_TTS_AUDIO_DIR`）现在只控制“未解析到人格”的 fallback，默认物理位置仍是 `plugin-adapters/rabi-speech/output/tts-audio/`。人格 TTS 缓存位置不受该参数改写，固定归对应角色目录。

### RabiPC 前后端契约

RibiWebGUI 不直接访问 `8781`，只访问 Manager 的 `/api/speech/*`。Manager 对浏览器使用 camelCase 字段，例如 `routeId`、`recordThreshold`、`dynamicThreshold`、`lastSubmitError`；`src/manager/speechControl.ts` 再在本机 Adapter 内映射为 RabiSpeech `/v1/*` 使用的 snake_case。RabiSpeech `/v1/events` 经 Manager `/api/speech/events` 推送麦克风电平/状态、播放队列、音频流和记录落盘变化；`records_changed` 只在 ASR/TTS 行成功写入后触发记录面板刷新，其他状态事件不会顺带查询记录。SSE 重连只做一次快照补漏。前端命令、事件流、错误 envelope 和共享状态集中在 `ribiwebgui/src/speech/speechControlClient.ts` 与 `ribiwebgui/src/stores/speechStore.ts`，页面不应新增周期 `fetch("/api/speech/...")`。

Manager 的 SSE 代理生命周期归 `src/manager/speechEventProxy.ts`：客户端断开会中止对应上游 fetch，并把随后产生的 AbortError 作为正常结束消费；不会再因 `Readable.fromWeb().pipe()` 的未处理错误终止 Manager。若旧运行实例把 `/api/speech/events` 回成 WebGUI HTML，代理与闭环验收都会按 Content-Type 失败关闭，不回退记录轮询。

直接调用 RabiSpeech `/v1/*` 时仍按 OpenAI 兼容格式和本文示例使用 snake_case；调用 RabiPC Manager `/api/speech/*` 时使用 `src/shared/speechControlContract.ts` 定义的 camelCase 契约。两者不要混用。

VAD 在达到静音窗口后始终结束当前候选片段；若有效语音不足最短时长，则立即记录 `segment_discarded` 并回到监听。这样短促碰麦、系统提示音或单个噪声尖峰不会占住整段 `max_utterance_ms` 才释放。

### 自然打断（barge-in）第一阶段

当前 TTS 仍是“完整文本合成 WAV 后进入全局 FIFO”，不是文本 token 或音频帧流式。第一阶段只缩短“用户开口到静音”的路径：当 `bargeInMode=echo_protected`（RabiSpeech 原始字段 `barge_in_mode=echo_protected`）且主机正在播放时，输入连续超过 VAD 阈值达到 `bargeInConfirmMs`（原始字段 `barge_in_confirm_ms`，默认 `200 ms`）便直接停止当前播放并清空旧队列，不等待静音收尾、ASR 或声纹。触发音频继续留在当前语段；静音收尾后照常执行完整 ASR、声纹分析、主机通用消息写入与同源 Route 回复。

该能力默认 `off`，因为当前主机链没有播放音频参考或 AEC。`echo_protected` 是“操作者已经验证上游 AEC 或物理回声隔离”的合同，不是 RabiSpeech 自动推断。WebGUI 在开启前要求显式确认；停止播放抛错时运行时发出 `barge_in_failed`、丢弃候选并恢复防回流。Windows 远程语音客户端当前播放时会停传麦克风，因此还不能通过这条模式获得自然打断；后续必须先让客户端提供连续采集与可验证 AEC 能力声明。

后续演进按以下顺序推进，且首要验收始终是“输入优先”：

1. **真实回声保护**：远端 hello/本机设备状态显式报告已验证的 AEC 能力，播放期间持续上传麦克风；用真实房间、音量和设备测误打断率，不能只信配置开关。
2. **会话纪元与取消传播**：每次打断递增当前语音会话的 `conversationEpoch`，把 epoch/生成号带到 Agent 回复、TTS 合成和播放任务；旧 epoch 的在途合成或迟到回复不得重新入队。打断只形成同一会话的新转折，不靠反复注入长模板恢复上下文。
3. **文本与音频流式**：Agent token/delta 先经过可取消的短句切分，再交给支持流式的 TTS 或有序短音频块；播放不必等待完整回答。每层都必须接受同一个取消令牌，并在打断后丢弃旧尾音。
4. **保持投递边界**：QQ 来源仍默认回 QQ，语音来源仍默认回语音；只有用户显式指定跨入口目标时才走现有 Action Gate 与消息端 policy。

关闭浏览器或离开页面不会改变 ASR 串流开关；配置写入被 Git 忽略的 `plugin-adapters/rabi-speech/microphone.json`。Manager 启动和配置重载时按 `streaming_enabled` 恢复：`true` 就启动或保持持续录音，`false` 就停止。Route 保存只改变分发订阅，不改变录音状态。旧配置没有该字段时按原 `enabled` 状态迁移，避免把原本停止的主机自动改为持续录音。旧 `route_id` 会迁移为 `null`，会话 ID 由主机内部生成和持久化，不是用户配置。

常驻录音控制接口只允许本机 RabiPC/Manager 回环调用，不加入 RabiLink 通用 token 的公网 allowlist。远端客户端可以通过 RabiLink 调用普通 TTS/ASR API，但不能用同一个通用 token 开关这台电脑的麦克风。直接手动 TTS/ASR API 与 Agent 无关；常驻 ASR 是否进入某条 Route 只由该 Route 的语音消息端订阅决定。

## RabiLink 中转

```text
客户端
  -> https://<relay>/api/rabilink/speech/*
  -> 应用通用 token 鉴权
  -> 选中的在线 PC 主动领取
  -> 固定回环 RabiSpeech
  -> 原 HTTP 请求同步返回
```

在 WebGUI 打开 RabiLink Relay 和“允许语音中转”，本机语音地址保持 `http://127.0.0.1:8781`。Manager 拒绝将语音代理目标改成局域网或公网地址。

鉴权可用：

```http
Authorization: Bearer <RabiLink 应用 token>
```

或：

```http
X-RabiLink-Token: <RabiLink 应用 token>
```

公网 Base URL 是 `https://<relay>/api/rabilink/speech`，因此常用完整路径为：

```http
GET  https://<relay>/api/rabilink/speech/health
GET  https://<relay>/api/rabilink/speech/v1/models
POST https://<relay>/api/rabilink/speech/v1/audio/speech
POST https://<relay>/api/rabilink/speech/v1/audio/transcriptions
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/start
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1&chunkId=...
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/stop
```

不要把本机的 `http://127.0.0.1:8781/v1/...` 原样交给远端客户端。普通 TTS/文件 ASR 是同步模型调用，不进入 Agent；Android 流式端点会在 PC 完成识别后自动进入主机语音库与 `rabilink` Route。`POST /api/rabilink/speech/messages` 只用于兼容/调试。可复制的 PowerShell TTS、ASR、成功判据和错误恢复见[从远端调用 TTS 与 ASR](user-guide/speech-api.md)。

Relay 只在短时内存队列中保留请求/响应体；日志不记录正文、音频、请求头或响应正文。公共 OpenAPI 真源在 `examples/rabilink-relay/rabilink-speech-api.openapi.json`。

## Provider 扩展

provider 是本机插件扩展点，不是 Agent adapter。新增实现需：

1. 实现 `TtsProvider` 或 `AsrProvider` Protocol；
2. 提供 `register(registry, settings)`；
3. 由本机管理员在 `providers.extensions` 中登记模块。

远程调用方只能选择已注册模型，不能加载代码、下载模型或改变 allowlist。

## 性能、预热与硬件

音频流事件历史先从 `current.jsonl` 尾部倒序读取，数量不足时才根据 `archive/index.json` 的序列范围读取必要归档，达到 `limit` 后立即停止。归档和当前文件扫描在工作线程中执行，扫描文件前已释放事件追加锁；能力、模型、记录、声纹和麦克风设备等只读文件或设备扫描也在工作线程中执行。实时音频客户端状态仍由 FastAPI 事件循环读取，避免跨线程遍历正在变化的连接表。

首轮包含六个 TTS 和五个主要 ASR 的实机冷/热态测试，覆盖功能、模型体积、测试硬件、建议配置、效果代理指标、CUDA DLL 与 FireRed Windows 依赖问题：

- [RabiSpeech 性能与功能报告](rabispeech-performance-report.md)
- [独立 HTML 报告](../ribiwebgui/public/reports/rabispeech-model-benchmark.html)

报告中的冷请求包含 worker 启动、模型加载/预热和首次推理；热请求只测已加载 worker 的后续推理。不同电脑必须重跑，不能把 RTX 4080 SUPER 的数字当作所有机器的 SLA。

## CUDA DLL 排障

典型现象是 CPU 能运行，但 GPU 首次推理报告缺少 `cublas64_12.dll` 或 `cudnn64_9.dll`。`nvidia-smi` 的 CUDA 数字只表示驱动兼容上限。

RabiSpeech 使用 NVIDIA 官方 Windows Python wheels，把运行库安装到插件私有 `.deps`，启动时只为该进程追加 DLL 路径，不修改系统 PATH。修复后必须执行一次真实推理，并在 `/v1/capabilities` 检查实际设备、加载状态和 `warmup_error`；只测试 import 不足以验收。

## 当前限制

- HTTP 接口当前返回完整结果，尚未承诺流式首包。
- 默认上传上限 25 MiB；大模型冷启动可能超过旧版 180 秒客户端超时，应按部署机器调整。
- 16 GiB 显存使用单个 GPU worker 按需加载；全局 FIFO 负责避免并发抢占。
- 麦克风设备由运行 RabiSpeech 的那台 PC 提供；不要选择会混入扬声器的虚拟输入。TTS 播放期间会暂停触发并清空当前片段，但真实环境的回声、连续切句和阈值仍需用户按麦克风调校。
- 公网 RabiLink 的 TTS/ASR 延迟仍需客户端所在网络单独验收；麦克风开关不经公网中转。
