<!-- docs-language-switch -->
<div align="center">
<a href="./code-architecture_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 代码架构

Android 日常入口由 `recording/RabiRecordingHubActivity` 提供四页导航；`CaptureOwnership` 协调会话录音、本地录音和录像互斥，`RecordingStore` 保存会话清单。采集与媒体文件分别由 `RabiLocalAudioService`、`RabiLiveRecordingService` 持有。`RabiConversationService` 的历史队列初始化在单线程执行器中完成，就绪前命令有序等待，避免阻塞主线程与后台录像。见[移动端记录界面](rabilink-mobile-recording-ui.md)。

跨 PC 只读调用由 `rabiPeerProtocol.ts` 拥有加密合同和目标授权分派，`rabiPeerClient.ts` 编排 LAN/P2P/Relay，`rabiPeerDirect.ts` 拥有有界 WebRTC 连接。`rabiPeerDiscovery.ts` 同时服务 RPC 与人格同步；RabiLink 插件拥有 HTTP 入口及释放，现有专用 LAN listener 额外接受加密的 `/api/rabilink/peer/receive`，不开放完整 Manager。见[跨电脑接口调用](rabilink-peer-rpc.md)。

实验视频直连由 `RabiDirectVideoSender.kt` 与 `src/manager/rabiDirectVideo.ts` 承担两端传输。RabiLink Manager 插件拥有接收器生命周期和本机文件；`rabiDirectVideoRoutes.ts` 仅接收有界 SDP，Relay 不接收视频字节。SDK 取流留在眼镜适配器。见 [能力与验收限制](rabilink-direct-video.md)。

> 状态：当前代码地图。28 个内置 Manager 插件迁移完成，定义与生命周期 hook 一一对应。

这份文档面向需要改代码的人。它不重复解释 RabiRoute 的产品定位；产品边界见 [架构说明](architecture.md)。这里主要说明代码里的 Module 怎么分工、一条消息怎么流动、改某类功能应该先看哪里。

## 事件驱动红线

业务状态变化默认必须由拥有者发出事件，再由 Route、人格、客户端或控制面响应；有可靠事件能力的链路禁止用固定间隔 HTTP 请求、全目录扫描或 JSONL 重读来发现“有没有变化”。cursor 只用于事件流断线后的补漏与幂等恢复，不是轮询节拍；settle、重试、超时和 Heartbeat 可以使用一次性定时事件，但定时器触发后必须处理明确工作，不能空转扫描。低层音频 stall watchdog 和 SSE/WS transport keepalive 不读取业务状态，属于连接安全机制。只有宿主或上游明确没有事件、SSE、WS 或变更通知，而且移除轮询会损坏现有功能时，才允许登记受控例外；例外必须限制生命周期和读取范围、使用长等待或分钟级低频、支持停止与退避，并在文档中写明原因。当前受控例外只有五类：Android 前台服务仅在系统已知离线时每五分钟检查一次 OS 当前网络，以覆盖少数厂商漏发默认网络回调，恢复后立即停止且不查询 Relay/消息/cursor；DashScope 远端异步会议 ASR 在请求 deadline 内查询任务终态；用户显式启用、上游没有推送接口的小米健康 ADB Companion；Rokid AIUI QuickJS 的 25 秒前台事件背书下行等待；以及 AIUI 页面可见时最低 60 秒一次、宿主没有变更事件的眼镜电量刷新。

## 总览

RabiRoute 的代码可以按运行角色分成以下主要区域：

```text
src/index.ts
  -> 启动消息端 Adapter
  -> 接收入口事件
  -> 写入 history
  -> forwarding
       -> RouteDecision
       -> AgentPacket
       -> Agent Adapter

src/manager.ts
  -> manager/controlPlaneRoutes.ts
       -> 配置读写
       -> Gateway 进程启停
       -> Adapter 扫描和修复
       -> WebGUI 静态文件和 HTTP 控制面

ribiwebgui/
  -> 浏览器配置界面

desktop/tray-task-window/
  -> Windows 托盘和任务窗口

plugin-adapters/
  -> 外部平台插件/桥接示例

apps/
  -> 可独立构建的 RabiLink Android 与 Rokid AIUI 客户端

packages/
  -> 供端侧应用复用的 Android SDK

examples/
  -> 可复制的配置、Hook、插件与协议样例

skills/
  -> Agent 使用指南
```

软件目录、公开示例、本机数据、运行状态和日志的完整归属见[路径与目录规范](path-and-directory-conventions.md)。项目级固定目录统一由 `src/shared/projectDirectoryLayout.ts` 给出，受限相对路径统一由 `src/shared/pathPolicy.ts` 校验。路线运行数据与人格资料分别使用 `routeDataDir` 和 `personaDataDir`；旧配置中的 `dataDir` 只在配置边界兼容读取。

## 客户端应用与共享 SDK

- `apps/rabilink-android/`：同一工程内维护手机控制端和 `glass-app` 眼镜端模块。
- `apps/rabilink-aiui/`：面向 Rokid AIUI/灵珠生态的独立客户端工程。
- `packages/android-sdk/`：Android 客户端共享的 RabiRoute 事件、消息与状态契约。

这些目录是 RabiRoute 的端侧消费者，不是 Manager 配置或运行数据的事实源。可直接复制的小样例仍放在 `examples/`；新增完整产品时应进入 `apps/`，跨应用共享且有稳定接口的代码才进入 `packages/`。

## 后端入口

### `src/index.ts`

`index.ts` 是单个 Gateway 子进程的入口。

它负责：

- 读取 `config.ts` 解析出的运行时配置。
- 根据 `MESSAGE_ADAPTER_TYPE` / `MESSAGE_ADAPTER_TYPES` 创建消息端 Adapter。
- 处理 `--manual-trigger` 这类一次性手动触发。
- 更新基础 `gateway-status.json`。

它不负责：

- 管理多个 Gateway。
- 编辑配置文件。
- 拼 Agent prompt。
- 决定 WebGUI 返回什么。

多 Gateway 场景由 manager 启动多个 `index.ts` 子进程完成。

### `src/config.ts`

`config.ts` 是 Gateway 子进程的环境变量配置入口。manager 会把每条 Route 的 `adapterConfig.json` 转成环境变量，再启动 `index.ts`。

这里的原则是：

- `config.ts` 只面向单个 Gateway 子进程。
- 跨 Gateway 的配置归一化不要继续塞进这里。
- Route 配置文件的 normalize / validate 应优先放在 `src/shared/gatewayConfigModel.ts`。

## 消息主链路

### Platform Adapter

消息端 Adapter 在 `src/adapters/`。RabiLink Relay 例外：它是由 Manager 持有的系统级转接服务，不是消息端；眼镜端经它收发，当前内部仍保留 `rabilink` 兼容键：

- `napcatAdapter.ts`：接 OneBot / NapCat WebSocket，处理 QQ 群聊、私聊、回复链和 @ 识别；引用消息未落盘时，通过 `napcatReplyMessages.ts` 调用 `get_msg` 递归补齐并缓存，查询失败不阻塞当前路由。
- `wecomAdapter.ts`：接企业微信智能机器人 WebSocket 长连接，处理企业微信群聊消息、写企业微信消息日志，并把回传目标交给 outbox。当前成熟度仍是 experimental，企业微信群聊字段尽量对齐 NapCat，专用字段只作为补充。
- `weixinAdapter.ts` + `weixinOpenClaw.ts`：个人微信实验原型，负责显式请求后的 iLink 二维码登录、长轮询、安全会话恢复、文本投递，以及来源会话的文本或受控本地文件回复。Windows 使用当前用户 DPAPI 保护 token、同步游标、账号标识和 context token；非 Windows 使用权限受限的本机随机密钥与 AES-256-GCM。网络超时或 5xx 只进入“暂时不可达、凭据保留”，仅服务端 `-14` 或 HTTP 401/403 明确拒绝才标记失效。历史消息不参与当前登录判断；入站媒体仍只记录，尚未完成真实账号长期验收。
- `feishuAdapter.ts` + `feishu.ts`：飞书企业自建应用消息端，负责 URL challenge、原始请求体签名与 Verification Token 校验、Encrypt Key 解密、`event_id` 持久去重、`chat_id` 上下文隔离和来源 chat 文本回传。凭据或事件订阅确认缺失时监听与出站都失败关闭，不回退到通用 Webhook。
- `webhookAdapter.ts`：接通用 Webhook、小爱及旧 FenneNote 兼容回调，并转成语音转写事件；显式命中 record-first 白名单时交给 `rabilinkObservationRecorder.ts` 写统一观察账本，不逐句投递 Agent。新本机语音入口使用 RabiSpeech。
- `rabilinkAdapter.ts` / `rabilinkRelayWorker.ts`：本地兼容入口与 Relay worker；observation 可先写统一会话账本，主动下行走独立消息流。
- `heartbeatAdapter.ts`：定时触发心跳消息。
- `messageAdapter.ts`：消息端 Adapter 的最小 Interface。

Xiaomi Home 是 Manager 持有的插件消息端，不在 Gateway 内复制常驻 listener。`src/integrations/xiaomiHome/` 统一拥有 Home Assistant REST/WebSocket 客户端、受保护单账号凭据、设置 revision、事件监听、动作 receipt 和录像 artifact；Route 卡片通过 `/api/agent/xiaomi-home/auth` 同时提交候选地址、候选令牌和设置 revision。Manager 必须先用候选令牌验证候选 origin，再原子替换设置与地址绑定凭据；运行时不得把旧地址的凭据装入新地址。认证 mutation 还接受当前 lifecycle fence 与 `Idempotency-Key`，非回环地址默认要求 HTTPS。

`rolePanel` 和 `remoteAgent` 出现在 MessageAdapter 类型中，但它们的真实入口由 Manager 提供：角色面板走 Manager/托盘 timeline，Remote Agent v3 由 RabiGUI 主动扫描连接远端 bridge。Gateway 子进程只上报对应状态，不另开网络 listener。

Adapter 的职责是协议翻译和轻量入口判断。它们应该把事件转成 RabiRoute 内部 record，然后交给 `forwarding.ts`。Adapter 不应该知道 prompt 怎么拼，也不应该知道处理端怎么投递。

每个消息端的接收/发送权限由 `GatewayDefinition.messageAdapterPolicies` 表达。旧的 `messageInputsDisabled` 和 `messageAdaptersDisabled` 只作为兼容字段保留；新逻辑应该通过 shared helper 读取 policy，不要在某个 adapter 或 manager 路由里手写第二套判断。

### History / Event Store

`src/history.ts` 管 JSONL 事件记录：

- 群聊：`group-messages.jsonl`
- 私聊：`private-messages.jsonl`
- 心跳：`heartbeat-events.jsonl`
- 手动触发：`manual-trigger-events.jsonl`
- 语音转写：`voice-transcripts.jsonl`
- 企业微信：`wecom-messages.jsonl`
- 个人微信：`weixin-messages.jsonl`
- Agent 投递记录：`agent-packets.jsonl`
- Adapter 日志：`*-adapter.log.jsonl`

这些文件保留入口协议和调试证据，但不再各自担任 Agent 最近上下文的唯一来源。QQ 自身回复、ASR/TTS、WeCom、Remote Agent、Role Panel、RabiLink 等入站/出站消息会同时归一到人格级双向账本。

### `src/messageContextStore.ts`

`messageContextStore` 是双向会话上下文的唯一实现，`src/messageContext.ts` 只是兼容 facade：

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

- `current.jsonl` 没有条数上限，只按时间窗口归档。
- 归档检查发现任意记录超过 72 小时时，把连续前缀中已超过 24 小时的完整记录移入 `n~m.jsonl`；不按自然日删除。
- Agent 自动上下文只读 `current.jsonl`，归档保留给 Agent 显式查证。
- 查询必须同时匹配当前人格、逻辑消息端和会话；入站和出站合计占用同一条数额度。
- 附件只保留类型、文件名、MIME、大小等安全元数据，不存私有绝对路径。

### `src/forwarding.ts`

`forwarding.ts` 现在是消息主链路的编排器。

它负责：

- 在低信号过滤和规则判断前，先把入站事件写入所有相关人格的统一账本。
- 遍历启用的 RouteProfile。
- 匹配“收到消息后运行脚本”的人格自动化，并交给受限脚本执行器；脚本结果不进入 AgentPacket。
- 调用 RouteDecision 判断是否命中规则。
- 按角色数据目录补写事件记录。
- 调用 AgentPacket 构造处理端消息。
- 写 `agent-packets.jsonl`。
- 调用 Agent Adapter 投递。

它不再负责：

- 具体规则匹配。
- 模板变量生成。
- 角色记忆和计划注入。
- replyContext 构造细节。

### `src/automation/personaAutomationRuntime.ts`

人格自动化运行时把“什么时候触发”和“触发后做什么”拆开。消息触发沿用 `RouteDecision` 的 route kind、正则、群和说话人匹配；定时触发由 `heartbeatAdapter.ts` 使用现有一次性调度器唤醒。通知 Agent 的动作回到 forwarding / AgentPacket 主链，运行脚本的动作留在本模块。

脚本执行必须同时满足：Route 本机明确授权、脚本真实路径位于当前人格 `scripts/` 目录、扩展名为 `.cmd` / `.bat` / `.py`。进程只继承启动所需的系统环境变量，不继承 Manager token、密码和消息正文；同一路由同一规则不重叠运行，超时会停止进程树。`automation-executions.jsonl` 只记录本机执行状态，用于重复领取保护和排障，不属于人格同步数据。

配置的通用结构和兼容迁移归 `src/shared/gatewayConfigModel.ts` 与 `src/manager/configMigration.ts`。旧消息模板规则只在读取边界转换，运行模块不维护第二套旧 Schema。

通用消息投递文案由 `shared/agentCommunicationPolicy.ts`、`agentThreads.ts`、`messageAgentPool.ts` 和计划秘书模块分层持有。稳定规则只出现一次；人格自动化模板只描述人格、消息端或定时任务的差异。接口字段、安全边界和回执要求保留在实际投递提示中，完整操作说明放在文档或 Skill。

外发语言风格由 `languageStyleValidation.ts` 读取人格绑定的 Skill JSON，`agentSendLanguageStyle.ts` 在 Outbox 前执行默认校验，`manager/languageStyleRoutes.ts` 提供通用校验 API。`styleValidation=0` 只跳过当前请求，不修改人格绑定。Codex Hook 调用同一 API，但只在失败时提示。

这些已经拆到 `src/routing/`。

## Routing Module

### `src/routing/routeDecision.ts`

`RouteDecision` 是“分诊单”。

它回答：

- 当前 RouteProfile 是否命中。
- 命中了哪些 notification rules。
- route kind 是什么。
- 用于匹配的 route variables 是什么。
- 原始消息转换后的 route text 是什么。
- 回复消息转换后的 replied route text 是什么。

它不读角色文件，不拼 prompt，不投递 Agent。

适合在这里加的能力：

- `route-decisions.jsonl`
- decision replay
- 更完整的 route reason
- 规则匹配测试

不适合在这里加的能力：

- 角色记忆召回。
- Agent prompt 文案。
- 外部发送。

### `src/routing/agentPacket.ts`

`AgentPacket` 是“转运包”。

它回答：

- 处理端最终收到什么消息。
- 模板变量如何展开。
- 角色路径、计划、记忆、日志路径如何注入。
- `replyContextJson` 如何构造。
- 当前人格、逻辑消息端和会话最近双向消息如何从 `conversation/current.jsonl` 取得。
- 当前消息明确要求 Agent 处理多电脑人格同步时，如何只为本次任务注入同应用 peer 查询、当前人格同步和冲突终态合同；普通消息不携带该提示。Manager 的事件驱动自动对账器独立运行，不由 AgentPacket 创建或拥有。
- 当前消息询问全天/区间声纹、用户与他人发言或说话人身份时，如何注入当前人格的 `voice-transcripts` 查询和 `voice-identities` 追加修正合同；证据不足必须保持 unknown。
- 当前 Route 配置持久计划管理秘书且本轮涉及计划、秘书、委派或计划反馈时，如何把每个秘书槽的完整任务 ID、名称、workspace 和控制面边界注入主任务；计划的业务 `taskBinding` 仍指向独立业务任务，秘书及其临时子 Agent只做计划盘点、查重、状态核对、结果消费和续投，不修改业务文件。

它依赖 RouteDecision，但不重新决定路由。

适合在这里加的能力：

- packet log
- prompt profile
- 不同处理端的 packet format
- Agent 上下文注入测试

不适合在这里加的能力：

- RouteProfile 是否命中。
- NapCat / Webhook 协议判断。
- Manager 控制面 HTTP 逻辑。

`src/routing/agentCapabilityHints.ts` 单独拥有这些按当前意图出现的能力提示和触发词。它只返回调用合同，不读取人格数据、不执行 HTTP，也不决定身份或同步目标；AgentPacket 负责把返回的行作为当前任务表现出来。这样新增能力提示不会继续把 packet 编排器变成另一套业务控制面。

### `src/routing/types.ts`

这里放 forwarding / decision / packet 共享的类型，例如：

- `ForwardRouteKind`
- `ForwardRecord`
- `ForwardTemplateValues`
- `ForwardLogKind`

如果一个类型只属于某个具体 Module，不要放到这里。

## Agent Adapter

Agent 端 Adapter 在 `src/agentAdapters/`：

- `agentAdapter.ts`：兼容创建入口，从运行时注册表取得处理端 Adapter。
- `contracts.ts`：处理端 Adapter 与定义合同。
- `builtinAgentAdapters.ts`：内置 Adapter 定义，保留既有消息渲染和真实投递入口。
- `types.ts`：Agent Adapter 配置输入与兼容 normalize。
- `managerApi.ts`：manager 用于扫描、安装、登录、打开处理端的控制面能力。
- `astrbotAdapter.ts`：AstrBot 投递实现。

`src/runtime/cordisHost.ts` 是 Cordis 兼容边界，`src/runtime/cordisRoot.ts` 提供 Gateway/Manager 共用的根 Context 生命周期：同 key 初始化并发去重、失败后重试、销毁等待初始化，以及幂等根销毁。`gatewayCordisRoot.ts` 和 `managerCordisRoot.ts` 提供对称但彼此独立的宿主单例。常驻 Gateway 在同一根下挂载 Agent Adapter Registry、Message Adapter Registry 和 Contribution Registry；销毁单个 Fiber 只移除对应定义，销毁根 Context 会撤销三个 Registry 的全部定义与副作用。`src/runtime/messageAdapterRuntime.ts` 提供消息端 Definition 注册和实例 Fiber。通用 Webhook Fiber 持有 HTTP listener；Heartbeat Fiber 持有定时器；NapCat Fiber 等待全部启用实例的 WebSocket listener 就绪，并在卸载时终止客户端、关闭多实例端口、阻止新消息处理和写入 `disabled`。任一 NapCat 实例启动失败会回滚先前 listener。`src/index.ts` 只识别调用类型并动态加载一次性命令或常驻 Gateway 入口；一次性命令不能启动 Message Adapter Runtime 或 Contribution Runtime。常驻入口只组合 `MessageAdapterRegistry` 中的九种消息端，并在正常退出或启动失败时销毁整个根 Context。共享 `MessageEndpointType` 描述 Route 可接收的全部来源，`GatewayMessageAdapterType` 只描述可由 Gateway Fiber 挂载的类型；纯 `speech`、`rolePanel`、`wearable` 或 `remoteAgent` Route 不启动子进程。Cordis API 不进入路由、消息模板、Webhook payload 解析或具体处理端实现。类型解析、Gateway 配置枚举、Manager 扫描元数据和快速配置输入都读取共享 Agent Adapter manifest。Manager 启动时由 `src/plugin-kernel/` 装载独立插件包，并从 generation 的不可变快照生成 Plugin Catalog。插件声明 WebGUI 页面、导航、设置区、状态卡、主题，以及 Desktop 命令、菜单、快捷键和主题；`GET /api/plugins/catalog` 返回完整实例清单，并可按 `web`、`desktop` 筛选表现贡献。Manager 启动期间任一步骤失败都会停止已启动资源、关闭 HTTP/SSE、移除信号监听并销毁 Manager 根。Desktop/WebGUI 是“一切皆插件”模型中的最小宿主，其可扩展入口由该插件贡献目录提供。WebGUI 与 Desktop 通过宿主拥有的可信注册表解析贡献。注册表可以增加新的 renderer、route、handler 和 resource contract；导航和命令引用仍须解析到同一插件实例和注册批次。未知、未注册、跨插件或宿主不支持的贡献失败关闭。两个宿主都按本地能力注册表判断 `requiredCapabilities`，不会使用插件 manifest 代替宿主能力。第三方任意表现代码仍需受控 Extension Host。

DSH 普通插件在同一 Node 进程内运行，Cordis `isolate` 只隔离服务作用域。RabiRoute 要求未知或高风险第三方扩展在独立进程运行，不把进程内 Context 当作安全沙箱。第三方任意表现代码的受控 Extension Host 属于后续路线。

其他处理端在根目录还有：

- `codexRuntime.ts`：Codex 业务适配层，负责固定线程身份、thread/turn 选择、运行中 steer 和运行状态上报。
- `codexRolloutActivity.ts`：从 Desktop 任务记录末尾向前分块读取，只检查最近一轮是否结束；读取异步执行，并按文件版本缓存结果。
- `codexDesktopBridge.ts`：Codex 任务只读模型的唯一入口。完整 ID、cwd、归档和 rollout 定位来自 Desktop 状态；对外显示名称统一覆盖为左侧聊天栏索引中的当前名称；随后通过 Desktop IPC 向目标任务 owner start/steer。
- `codexAppServerClient.ts`：短生命周期元数据驱动，用于创建、命名空任务和读取 `model/list`；不得执行真实 prompt。
- `agentThreads.ts`：受控的本机任务桥，提供 list/read/resolve/create/rename/send；完整 ID 定位既有任务，workspace 决定本次投递目录，`rename` 只改 Desktop 可见名称。

Codex 任务有三个不同归口的事实：完整任务 ID 决定任务身份；每次 Route 或计划投递的 workspace 决定该轮执行目录；当前显示名只由 Desktop 左侧聊天栏决定。任务保存的默认 cwd、SQLite `threads.title`、首轮 prompt、Route 的 `codexThreadName` 和运行状态里的 `monitorThreadName` 都不能否定有效任务 ID。`codexThreadName` 只在没有有效 ID 时作为首次查找/创建提示；一旦 ID 有效，改名或默认 cwd 不同都不会改变绑定，也不会触发重建。
- `copilotCli.ts`
- `marvis.ts`

Agent Adapter 的职责是“把 AgentPacket 的消息投给处理端”。不要让它反向定义 RabiRoute 的路由语义。

### Codex adapter 的内部边界

```text
AgentPacket
  -> codexRuntime.ts             task identity / delivery policy
  -> codexDesktopBridge.ts       Desktop IPC transport
  -> Codex/ChatGPT Desktop       target task owner
  -> visible task + turn
```

- Provider 是 OpenAI；adapter 不复制 provider 的账号、鉴权或模型目录。
- Agent/runtime 是 Codex；稳定 adapter id 仍是 `codex`。
- Transport 是 Codex Desktop IPC；Desktop webview 是目标任务实际轮次的 owner。RabiRoute 不为消息执行另启 app-server，也没有备用 transport。
- Host 是必需的 Codex/ChatGPT Desktop。任务未加载时只允许通过 `codex://threads/<id>` 唤醒 Desktop；加载失败就停止投递。
- Model、工具、沙箱和审批由目标 Desktop 任务拥有。兼容字段 `agentModel` 不再覆盖 Desktop 任务设置。
- 已匹配的普通消息不经过另一层忙碌队列：Desktop owner 先尝试 `steer` 活跃 turn，只在没有活跃 turn 时 `start`。Heartbeat 的忙碌跳过和语音的关键词唤醒是各自消息端的显式例外。
- Heartbeat 判断目标任务是否仍在工作时，只读取任务记录末尾附近的数据，不得同步读取或拆分整个 JSONL 文件。文件正在追加时忽略末尾未写完的一行；超大的无关记录会跳过，避免任务长期运行后拖住 Manager 或 Route 子进程。
- Codex 活跃状态按时间合并两类证据：Desktop IPC 只提供当前连接内的临时活跃标记，rollout 的最近 turn/terminal 事件提供可持久查证的生命周期。较新的 terminal 会清除较旧的 IPC 活跃标记；若新一轮 IPC 活跃时间晚于已写入的旧 terminal，则在 rollout 追上前仍保持活跃。IPC 断开时清空连接内标记，不能让旧连接把已完成任务长期显示为运行中。
- `src/messageAgentPool.ts` 不拥有 Codex 任务运行状态。`/api/agent/threads` 的精确读取把 Desktop 是否在线、当前连接的活跃事件和 Codex rollout 终态归一为 `active / idle / notLoaded / unavailable`；消息池只在一次分配期间用内存 reservation 防止并发抢占，不把这些状态写入文件。`agents.json` 只保存消息处理任务的完整 ID、左侧聊天栏名称、workspace、序号和初始化信息；`routing-affinity.json` 只保存消息组与消息端/会话/说话人的恢复线索。Desktop 离线或状态不可读时，消息组仍留在 `pending.json`，恢复后继续原任务，不能依据本地快照扩容。
- `src/forwarding.ts` 在 NapCat 消息组带 `replyToMessageId` 时，通过 `src/messageProcessing/managerClient.ts` 按 `channel + sentMessageId + routeId` 查询 Agent 发送记录。匹配当前消息处理任务完整 ID 的发送会话会在 `src/messageAgentPool.ts` 获得可叠加的 `6000` 分；原消息组、消息端、会话和说话人熟悉度继续计分并按总分排序。查询完成会写 `message_processing_reply_sender_lookup_completed`，查询错误写 `message_processing_reply_sender_lookup_failed` 并取消这项加分；找到发送者后还会写不含正文的 `message_processing_reply_sender_weight_applied`，记录候选会话、最终任务及是否命中。
- 消息处理看板也不保存任务忙闲。每次读取看板时，Manager 按任务 ID 向 Codex 获取当前名称和 `active / idle / notLoaded / unavailable`，只在本次响应中显示；读取失败时显示“当前无法确认”，不沿用上一次空闲或繁忙。
- Route 的 `codexPlanAssistantSessions` 保存 1–8 个持久 Desktop 计划管理秘书槽，只负责任务身份和初始化记录；统一模型由 Manager 的 `codexPlanAssistantModel` 拥有，WebGUI 不在秘书条目中复制模型状态。秘书槽不写入计划 `taskBinding`；`taskBinding` 始终绑定独立业务任务。秘书负责计划/记忆维护、任务查重与绑定、状态核对、结果消费和续投，禁止执行调查、实现、测试或业务文件修改。控制面写入按 `planId` keyed lease 隔离：同计划单 writer、不同计划并行，共享 JSON 采用锁内最新值合并与原子替换。锁通过完整候选文件和原子 hard-link 发布，stale/损坏锁在热路径失败关闭，只能在 quiescent 维护窗口显式修复；同 key 的认领/澄清 lease 覆盖 reservation、外发、验证和终态回执，结果不明确时禁止自动重发。全局 audit 使用前后 ledger 快照，只把身份稳定的错误判为 invalid；plan-scoped strict audit 才是单计划收口门，reconcile 只跳过 active 计划。该层目前仍是实验能力，不能因为代码或 mock 通过就宣称真实 Desktop 多任务已验收。
`codexDesktopBridge.ts` 必须保持 transport-only：它不读取 route rule、不拼 AgentPacket、不决定业务外发。`codexAppServerClient.ts` 只保留“创建空任务、恢复用户名称”的元数据能力，不得接收真实 prompt 或执行 turn；元数据操作完成后立即退出。

Desktop 任务审批与 `src/outbox.ts` 的 Action Gate 是两道不同边界：前者控制 Agent 执行权限，后者控制 QQ、文档、设备和外部 API 等业务动作。任何代码都不能把一次任务审批传播成业务外发授权。

## 消息处理需求状态

`src/messageProcessing/board.ts` 是 Manager 拥有的消息处理状态机，`src/messageProcessing/persistence.ts` 负责把状态保存到运行期 `data/.runtime/message-processing-board.json`。业务规则不直接决定文件位置。Manager 启动时同步读取现有快照；运行期间把连续变更合并为最新待写快照，由 Worker 使用紧凑 JSON 和原子替换保存，避免大型状态文件的序列化、`fsync` 和重命名阻塞 HTTP 主线程。`/meta.messageProcessingPersistence` 报告待写、写入、重试、最近耗时和错误。Gateway 在消息组进入 Codex 消息处理任务前登记需求，投递成功后记录精确 Desktop 任务；消息处理 Agent 通过结果接口提交回复、不回复或结构化转交，Outbox 再用 `replyContext.messageProcessingRequirementId` 回写真实发送结果。直接 @、直接回复、私聊和计划进展是必须处理项；普通群讨论仍由 Agent 判断是否参与。

`src/napcatMedia.ts` 在 NapCat 消息进入时把图片 URL 立即转成受限大小的本地运行文件，并把成功或失败写进消息附件记录；`src/messageProcessing/sourceEvidence.ts` 再从当前消息组和可追溯引用链生成消息 ID、附件清单和可投递图片路径。`src/messageProcessing/managedAttachmentDelivery.ts` 按 `requirementId + attachmentId + contentHash` 把可读图片复制到目标 Agent 工作区内的受管缓存，拒绝缓存路径中的符号链接，并按每批最多八张生成稳定批次身份。正文只进入第一批；后续批次只说明批次位置。附件复制失败时仍投递一次正文并列出不可用附件，要求处理端等待附件恢复或转交，不能推断图片内容。`messageAgentPool.ts` 使用持久批次回执复用已经成功的批次，避免同一 requirement 重试时重复投递。`src/agentThreads.ts` 继续只接受目标工作区内、实际存在的受支持图片路径，`src/codexDesktopBridge.ts` 把它们转换成 Desktop `localImage` 输入。`board.ts` 保留聚合需求的全部来源证据，并单独保存 Agent 已核对的 `sourceEvidenceReview`。回复 outcome 可以先进入 `awaiting_send`；发送审批再按 `proposedSend.params.replyToMessageId` 解析本次主消息、明确回复链和正文实际引用的附件。只有这个精确子集中的附件不可读才阻止回复；静默关闭仍必须覆盖整个聚合需求。`AgentPacket` 先给出宽泛最近消息，再给出当前消息；当前消息前五分钟内最接近的讨论片段和引用证据位于最近消息之后；已经完整显示的同 ID 消息只保留指向最近消息的引用，供处理端结合已经读过的历史解释纠正和短追问。

`src/replyImageDescriptions.ts` 在 NapCat 群聊引用发送进入幂等 reservation 前，按精确 Route、群、实例和 `replyToMessageId` 读取来源消息。受跟踪发送已经通过 send-context 审批时，图片检查只使用该需求的精确来源消息和已审核正式记录；历史 `conversationKey` 不能改写正式群号，同 ID 的其它历史副本也不能替代该证据。正式群、Route、实例或目标不一致，记录不唯一，或图片附件未审核时失败关闭；没有受跟踪审批的普通发送不使用这项回退。来源含图片时，`params.replyImageDescriptions` 必须与图片数量和原顺序一一对应；来源找不到、图片不可读、描述缺失或空泛都会阻止发送。真实平台发送成功后，每张 `napcat-media` 图片旁会创建或追加图片同名 `.md`，记录来源消息、图片序号、发送 Agent 类型与完整会话、`deliveryId`、QQ 回执和本次理解。幂等回执只保存说明文件映射，不把描述正文复制进按平台消息 ID 查询的运维结果；Manager 另写不含正文和图片路径的 `agent_reply_image_descriptions_archived` 事件。

`src/messageProcessing/sendContextReview.ts` 负责消息处理需求的发送前上下文核对。单条回复使用 `GET .../send-context?sourceMessageId=...` 读取以本次来源消息和明确回复链为起点的有界上下文，生成 `contextVersion`；如果精确来源已超出近期窗口，只能从该人格的正式 `group-messages.jsonl` 按需求登记的 Route 和消息 ID 恢复一条唯一记录，缺失、重复或 Route 冲突时拒绝。POST 审批根据精确 `proposedSend` 校验来源归属、`sourceEvidenceReview`、`projectFactAssessment`、实际引用附件和已核对的上下文 ID，再把两分钟内有效的凭证绑定到需求、完整发送会话和精确发送请求。群引用回复的来源 owner 只从 `kind=message_reply` 的需求中选择；`plan_progress_notification` 等派生通知不能拥有原群消息的引用回复权。存在同一 Route、同一 `messageGroupId` 和同一 `sourceMessageId` 的历史重复时，只归属 `createdAt` 最新的 canonical `message_reply`；没有 `message_reply` 时失败关闭，不能由计划通知承接。计划通知缺少顶层 `messageGroupId` 时仍可使用 `source.replyContext.messageGroupId` 保存和核对证据，但不参与引用回复 ownership。消息组或 Route 不同、最新项无法唯一确定、回复链缺失、引用附件不可读或正文使用了未纳入事实核验的消息时失败关闭。`/api/agent/send` 在 Outbox 与幂等 reservation 前重新读取当前上下文；出现新消息、已有 Agent 回复、新的 canonical requirement、需求不再等待发送，或发送者、目标、引用消息、正文变化时同样失败关闭。凭证只保存在 Manager 内存中，进程重启后自动失效。任何 Agent 回复到某个已登记需求的来源消息时都必须携带对应 `tracking.requirementId`，不能通过主人格或另一 Agent 绕过看板。

Agent 任务间的回复责任由 `src/agentRequests/` 单独保存到 `data/.runtime/agent-requests.json`。`/api/agent/threads` 只在 Desktop owner 接受投递后把请求改为等待回复；回复必须带原 `requestId`、结果和下一步。Codex `Stop` 只记录目标轮次已经结束并安排五分钟后的提醒，不阻止最终回答；`PreToolUse` 在 Route 开启强制开关时拒绝绕过 Rabi 的持久任务投递工具。消息处理转交收到正式回复后，原发布任务重新进入 `processing`，继续决定外发、审批或下一次转交。

计划关联只来自 `/api/agent/threads` 的结构化 `messageProcessing.planId`，不从标题或文本猜测。`roleKnowledge.updatePlan()` 成功写入后发布进程内更新事件；Manager 对已关联来源比较计划快照，并为状态、当前步骤、下一步、等待事项和步骤进度变化生成通知需求。看板通过 Manager SSE 事件读取同一状态，不轮询聊天日志或计划目录，也不建立第二个统计真源。

## Outbox / Action Gate

`src/outbox.ts` 处理 Agent 回传。

当前重点是聊天消息 reply：

- 解析 Agent 回传请求。
- 找原始 source message。
- 检查 pipeline 是否允许自动回复。
- NapCat 群聊在 `replyToSource=true` 且存在源 `messageId` 时，由 Outbox 统一补 OneBot reply 段；人格和处理端不需要手写 CQ reply，并会避免重复添加。
- NapCat 本地群文件必须位于 `messageAdapterPolicies.napcat.allowedFileRoots`，Outbox 校验真实路径和普通文件类型后调用 `src/napcat.ts` 的 `upload_group_file` 封装；可选说明文本在上传成功后单独发送，避免文本失败导致重复上传大文件。
- 允许时调用对应消息端发送封装，例如 NapCat HTTP 或企业微信智能机器人 SDK。
- 不允许时返回 `blocked` 并附带 draft 数据；发送失败时返回 `failed` 并保留 draft 数据；未选择外部输出时可以返回 `draft` 或把结果保留在 Agent 会话。

当前 Outbox 已是 QQ、WeCom、个人微信来源会话文本/受控文件、RabiLink 和角色面板的真实回传层，并为旧 FenneNote Route 保留兼容，但还没有通用持久化审批中心。长期方向是把它深化为通用 Action Gate：

`src/agentSend.ts` 在 Manager HTTP 边界先校验明确发送合同：稳定 `deliveryId`、调用方声明的 `sender.agentType + sender.sessionId`、精确 `routeId`、`channel`、渠道专用 `params` 和 `payload` 都是必填结构，来源 `replyContext` 不参与目标选择。消息处理回复还必须带与最新上下文核对绑定的 `tracking.requirementId + tracking.sendContextReviewToken`。`src/manager/agentSendIdempotency.ts` 随后在运行期 `data/agent-send-idempotency/` 持久化 reservation，再允许唯一请求进入 Outbox；同 ID 同请求的并发只保留一个结果，不同发送者或其它字段冲突。回执不存在时返回 `missing`；Manager 重启后，只有同 Route Outbox 明确没有同 ID 请求和终态记录时，`reserved/sending` 才能用原 payload 重试一次。Outbox 已记录请求但没有终态、payload 摘要不一致或重试仍无终态时转为 `uncertain` 并禁止再发。`GET /api/agent/send/receipts/:deliveryId` 返回持久回执，`GET /api/agent/send/traces?channel=...&sentMessageId=...` 可以从平台回执反查发送者会话；QQ 等通道仍需使用 `sentMessageId` 做真实平台回读。

```text
Agent output
  -> action request
  -> draft / approval
  -> send adapter
  -> external system
```

也就是说，QQ reply 只是 Action Gate 的一个 Adapter，不应该成为所有外部动作的唯一形状。

## Manager 控制面

### `src/manager.ts`

`manager.ts` 只是入口：

```ts
import { startManager } from "./manager/controlPlaneRoutes.js";

startManager();
```

不要再把控制面逻辑塞回这个文件。


### Manager 插件运行时

源码热补丁的清单校验由 `sourcePatchCatalog.ts` 统一提供给构建与监听；`SourcePatchWatcher` 自动发现新模块并按依赖分组编译。`ManagerSourcePatchService` 持有动态注册记录、不可变基线、模块 Worker 和发布回执，插件通过通用 `host.manager.source-patches@1` 调用导出函数，不向核心增加模块名分支。新增模块的依赖初值与后续迁移边界见[源码热补丁](source-hot-patches.md)。

正式 Manager 只通过 `startManager()` 初始化。`src/plugin-kernel/` 负责 Manifest 校验、包 revision 隔离、单一 Profile、能力图、权限、generation 和 effect 释放。默认构建从 `dist/plugins/profiles/desktop.json` 与 `dist/plugins/packages/` 加载；树外插件可通过 `RABIROUTE_PLUGIN_PROFILE` 和 `RABIROUTE_PLUGIN_PACKAGE_ROOTS` 选择独立 Profile 与额外包根目录。运行时不读取旧配置格式，也不从源码插件目录加载。

`plugins/builtin/` 中的 28 个内置能力各自拥有独立包 ID、Manifest、Manager 入口和中英文说明。它们与树外插件都通过 `@rabiroute/plugin-sdk` 使用 `services`、`contributions`、`permissions` 和 `effects`。宿主提供版本化原语能力；插件通过 `provides`、`requires` 和 `optional` 组合，不通过中央包枚举互相调用。

`GenerationRuntime` 按真实依赖组件切换。revision、配置、权限和依赖 revision 不变时复用现有实例；变化只重载受影响组件。缺少必需能力的实例进入 `waiting_dependency`。候选激活或 effect 发布失败时，旧组件继续服务；不相关组件照常更新。成功发布后释放旧 effect scope。Manager API 从 generation 的不可变 service 与 contribution 快照生成 Plugin Catalog；Web 模块按包 ID、版本和 SHA-256 revision 发布不可变资源。

```text
plugins/contracts/plugin-sdk/
plugins/builtin/<package-id>/1.0.0/
plugins/profiles/desktop.json
src/plugin-kernel/
dist/plugins/
data/plugins/.runtime/
```

### Manager 插件持有的运行资源

28 个实例的资源激活函数都把关键卸载步骤放在各自的单一 disposer 中。Manager 根 Fiber 还持有 `managerReadWorkerPool`、`managerCatalogWorkerPool`、`managerPerformanceWorkerPool` 和 `CoalescingMessageProcessingBoardPersistence`。Manager 退出和启动失败回收显式串行执行 `managerPluginKernel.dispose() -> managerSharedResourcesRuntime.unmount() -> managerCordisRoot.dispose()`。共享资源 Runtime 先停止持久化服务并刷新待写数据，再停止读取池；任一停止失败时仍继续清理其余资源，最后汇总第一个错误。读取池拒绝新任务、取消排队和共享请求、终止活动与空闲 Worker，并等待子进程退出。Cordis 同一 Fiber 的多个 disposer 通过 `Promise.all(...)` 并行执行，不能依赖多个 `ctx.effect()` 的登记顺序。一个插件需要按以下顺序停止：

```text
unregister routes
→ stop accepting new requests
→ drain accepted requests
→ stop plugin-owned workers/processes/timers/sockets/services
→ await resource exit
```

`ManagerPluginRequestTracker` 拒绝新工作，并同时等待 HTTP response 与 `trackOperation()` 登记的实际业务 Promise。拥有外部资源的插件先移除路由批次，再等待已接收的发送、任务、配置写入、扫描和回调，最后在同一个 disposer 中停止资源。Remote Agent 回调使用插件级 `AbortSignal` 并等待真正结束；NapCat 由 `napcatLifecycleOwner.ts` 按路由绑定维护持久进程记录，停止前核对 PID、创建时间和程序路径；删除、停用及启动恢复都使用同一入口，普通 QQ 不作为发现目标；FenneNote 等待转发任务退出。RabiLink 保存活动运行 Promise，停止时 abort 并等待运行结束；停止期间排队的配置会在 stop 完成后重启，但第二次 `stop()` 会先清除目标 signature，从而取消该排队重启。人格同步 LAN Server 关闭 listener 和活动 Socket；本地 WebGUI、Speech、SSE 与 Relay 回写都绑定停止信号。配置 watcher 的 `afterReload` 和 Rabi 身份配置 PATCH 都等待异步 Relay 同步。`GenerationRuntime` 按依赖组件生成候选并发布不可变快照，发布成功后逆序释放旧 effect scope；候选失败时释放候选资源并继续使用旧 revision。

Manager 端点、身份、完整必需插件集与 handler READY 不等待计划存储的 NAS 恢复；READY 后父进程主线程不得触碰远端文件系统。`managerWatchBroker.ts` 只对本地根目录使用原生 watcher；UNC 配置与插件根由可终止子进程执行有界 `readdir/stat`，超时后必须确认旧 child 退出再重建。`gatewayDiagnosticsSnapshot.ts` 把人格、状态和日志诊断交给 `managerReadWorker`，`/gateways` 与 `/api/gateways` 只读取带单调 revision 的深冻结内存快照；刷新失败保留上一份快照并显式标为 stale/degraded。人格 manifest 也遵循同一边界：GET 只读父进程发布的不可变快照，扫描、哈希和计划锁全部在 one-shot child 中完成。后台 watcher 或快照降级进入 `/health` 诊断，但不能阻塞回环控制面。

内置与树外 Manager 插件都在 Manager 进程内执行，并受同一 Manifest、能力图、权限和 effect scope 约束。当前插件合同面向可信扩展；需要运行不可信代码时，应新增独立进程宿主并定义跨进程能力合同，不能把进程内权限检查当作安全沙箱。

业务事实仍由原模块拥有：Route 配置归配置仓库，运行状态归 `RuntimeRegistry`，消息处理记录归 `MessageProcessingBoardStore`，Outbox 归外发模块，计划和记忆归 Role Knowledge。插件只拥有自己的注册和运行资源。

### `src/manager/controlPlaneRoutes.ts`

这是 Manager 的最小 HTTP 宿主与插件组合根。中心 HTTP 链只保留局域网鉴权、只读写门禁、插件路由分发、Manager SSE、插件目录/对账、静态资源、控制路径 JSON 404 和其他路径 WebGUI HTML 回退。`/manager` 与所有 `/manager/*` 都按控制路径处理。生产业务路由使用稳定 `routeId` 和真实 `exact` 或 `prefix` matcher；`dynamic` 只保留为扩展合同。Registry 拒绝重复 `routeId`，也拒绝 method 重叠时的 `exact/exact`、`exact/prefix` 与 `prefix/prefix` 路径冲突。`/meta`、`/manager-config` 等非 `/api` 路径也使用显式静态声明。

它还负责创建共享服务、组装插件 hook、启动 HTTP server、维护配置 watcher 和执行进程级关闭。新增业务 HTTP 分支应进入对应插件的专用 route/service 模块，不再直接追加到中央请求链。

可能遍历大量历史文件的读操作不能直接占用 Manager 的 HTTP 主线程。`manager/managerReadWorkerPool.ts` 用有界常驻低优先级子进程执行语音历史、人格同步冲突、记忆目录、Agent 扫描、性能 JSONL 解析、性能汇总和响应 JSON 序列化，并分别限制同时执行数、等待队列和执行时限；所有池合计最多执行 6 项重任务，避免一次 Agent 扫描让其他只读请求长期排队。一个池的子进程退出无法确认时，只拒绝该池的新任务并保留其并发额度；其他读池仍可使用剩余的全局额度，不能被跨池封锁。请求断开或超时时终止对应子进程，后续请求再创建替代进程。子进程在请求之间复用模块缓存，避免记忆目录读取反复支付进程启动和模块加载成本。范围相同且只要统计的并发语音请求、相同参数的并发 Agent 扫描及相同性能查询共享一个任务。性能池同时执行 1 项、等待 1 项、超时 60 秒；队列满时返回 503，不在主线程回退。Codex 任务扫描按 200 条分页，Desktop 任务目录阶段最多等待 8 秒，并记录 `manager.agent_scan.desktop_ready` 与 `manager.agent_scan.codex_catalog`；WebGUI 只在用户要求时继续加载后续页。消息处理看板列表只构建界面摘要，附件、原始回复上下文和完整证据由单项详情接口读取。计划目录冷读使用异步并发文件 I/O，同一人格的并发请求共享一个缓存填充任务；热读直接复用内存目录，文件监听只刷新变化项。Manager 开始监听后在后台预热各人格计划目录，不延迟 HTTP 就绪。单计划创建、修改和绑定更新提交后只读取该计划的投影，并增量更新父进程中的完整目录缓存；只有会改变整套状态定义或其它角色级元数据的命令才重新读取完整目录。`messageContextStore.ts` 先用归档索引的起止时间过滤文件，再读取可能命中的正文。性能存储启动时按流逐条读取已有 JSONL，不整文件读取和拆分。冲突目录没有快照时立即返回 202，再交给独立的单子进程目录池限速整理，避免占用语音名额或用满速目录遍历争抢磁盘。`manager/operationalLog.ts` 接收 Manager 和 Gateway 的统一数据变动事件，按时间片异步追加到同一份日分片；记录包含 owner、action、target、dataSource、outcome 和请求追踪字段，不包含业务正文。失败批次保留在内存中退避重试，并通过 `/meta.operationalLog` 和 Manager 健康状态报告降级。默认按 30 天和 512 MiB 历史分片上限清理。正常退出会等待消息处理快照和操作日志完成写入，再结束进程。控制面诊断通过 `manager/jsonlTail.ts` 从文件尾部读取有限记录，同一次响应使用请求级缓存，避免不同卡片重复读取同一份日志。`/meta.readWorkers`、`/meta.catalogWorkers`、`/meta.agentScanWorkers`、`/meta.performanceWorkers`、`/meta.messageProcessingPersistence`、`/meta.operationalLog` 和 `/meta.httpLimits` 提供不含业务正文的运行诊断；各子进程状态中的 `executionMode`、`workerPids`、`globalActive`、`globalMaxConcurrency`、`terminationBlocked`、`workers` 与 `spawnedWorkers` 用于检查隔离方式、总预算和异常重启。

它已经接入：

- `ManagerConfigRepository`
- `RuntimeRegistry`
- `statusPayload`
- `agentAdapters/managerApi`
- `agentThreads`：为缺少 Codex Desktop 连接器工具的后台 Agent 提供受限的正式线程查询、读取、创建和续投能力。
- `messageEndpoints/*`
- `outbox`
- `roleKnowledge`
- `manager/personaCatalog`：统一人格目录扫描、Markdown 标题解析、回退文件选择和缓存；Route 摘要与跨人格目录不得各自建立名称真源。
- `manager/personaMessageAuthority`：生成并校验同时绑定 Route 与人格的 HMAC 凭据；密钥只保存在本机运行数据中，目录、timeline 和投递回执均不返回凭据。
- `manager/personaMessagingRoutes`：保持为薄 HTTP 层，提供不暴露人格正文和本机目录的人格列表，校验来源凭据、目标 Route、跳数和持久幂等状态，再调用统一投递服务。
- `manager/rolePanelDelivery`：本地角色面板与跨人格入口共享的唯一投递语义。处理端接收成功后才写 `status=sent`；失败写 `status=failed`，不能留下错误的成功记录。
- `manager/durableDeliveryIdempotency`：Agent 普通回复和跨人格消息共用的持久 reservation/receipt 机制；同 ID 同请求只保留一个终态，内容变化冲突。只有调用方提供权威 `missing` 回读时允许一次恢复重试，结果不确定时不自动重放。

后续收敛方向：

- 新 endpoint 优先放到专门 Module，再由 `controlPlaneRoutes.ts` 接线。
- 避免在这里新增配置 normalize / validate。
- 避免在这里新增具体平台扫描细节。

`RABIROUTE_MANAGER_READ_ONLY=1` 是构建产物验收专用模式。它强制关闭 Gateway、Relay、LAN discovery、Route watcher 和人格文件 watcher 自动启动，跳过启动时的语音麦克风协调与配置目录迁移，并在 HTTP 入口拒绝 POST、PUT、PATCH、DELETE。`scripts/test-built-manager-readonly.mjs` 在临时回环端口启动当前 `dist/manager.js`，通过 stdout 就绪事件而非轮询等待，然后只读取 Gateway 摘要、人格同步 manifest/索引状态/冲突、主机通用语音消息，以及 manifest 中每个人格的语音账号兼容归类和语音会话视图。只读校准不写 manifest 缓存；证据只保存状态、索引模式、数量和构建哈希，不保存人格名、角色 ID、文件路径、转写正文、人物、token、Relay URL 或监听地址；当前 Host 管理的应用 generation 不会被重启。

### `src/manager/configRepository.ts`

管理 Route 配置与 manager 配置。

职责：

- 读取 `data/manager.json`。
- 确定 `routeRoot` / `rolesRoot`。
- 初始化示例数据目录。
- 读取和写入 `data/route/*/adapterConfig.json`。
- fallback 读取 `personaConfig.json` 里的 notification rules。
- 调用 shared config model 做 normalize / port assignment / conflict validation。

### `src/manager/configMigration.ts`

旧配置只在读取边界迁移到当前 Schema。运行模块和 WebGUI 不维护第二套旧字段语义；迁移结果由 `ManagerConfigRepository` 统一校验和写回。

### `src/shared/gatewayConfigModel.ts`

Gateway 配置的事实源 Module。

职责：

- `GatewayDefinition` / `RouteProfileDefinition` / `NotificationRuleDefinition` 类型。
- config name / role id sanitize。
- message adapters normalize。
- NapCat instances normalize。
- template / rule normalize。
- GatewayDefinition normalize。
- 校验并自动分配 RabiRoute 自己监听的端口。
- NapCat HTTP 是出站依赖地址，不是 Route 拥有的 listener；多个 Route 可以共用同一地址，配置归一化不得为了消除所谓端口冲突而改写它。

凡是“Route 配置不变量”，优先放这里。

### `src/manager/runtimeRegistry.ts`

管理 Gateway runtime 的集合和日志。

职责：

- 保存 `GatewayRuntime`。
- 根据 id 查找 runtime。
- 删除缺失 runtime。
- 截断 runtime log。

不要让控制面散落多个 `Map<string, GatewayRuntime>`。

### `src/manager/statusPayload.ts`

负责拼 manager 总状态 payload。

当前较薄，但它是状态 read model 的落点。后续如果 WebGUI 状态结构继续复杂化，应优先深化这里，而不是把 payload 拼接继续堆在 HTTP handler 里。

## Message Endpoint 管理

`src/messageEndpoints/` 放消息端的管理和扫描能力。

- `napcatManager.ts`：NapCat Shell 准备、WebUI token、OneBot 配置、健康检查、启动/停止、扫描。
- `napcatWebuiSession.ts`：仅在 Manager 内复用短期管理凭据，合并并发认证，认证明确失效后重新获取；不拥有 QQ 登录状态。
- `napcatHealthScan.ts`：按 runtime/instance 并行执行纯只读 NapCat 健康观察，在共享截止时间内返回部分结果。
- `manager/scanController.ts`：为独立消息端探针提供并发起跑、共享截止时间、超时/错误诊断和 fallback 结果。
- `manager/messageAdapterHealth.ts`：把 QQ、个人微信、RabiLink、语音等入口汇总为彼此独立的 operational health；不把单入口故障提升成全局离线。
- `webhookLikeScans.ts`：Webhook / XiaoAi 与旧 FenneNote 兼容 HTTP callback 端点扫描。
- `wecomManager.ts`：企业微信主动 WebSocket 长连接的扫描 read model，检查 SDK、bot id/secret、连接认证状态和最近消息。
- `remoteAgentManager.ts`：远端 Agent 设备发现、密码挑战、连接、任务、事件和文件回传。

这些 Module 面向 manager 控制面，不参与 Gateway 子进程的实时消息处理。

## Role Knowledge

`src/roleKnowledge.ts` 管角色计划和记忆：

- active plans
- recent memories
- consolidated memories
- memory consolidation runs
- role skills
- Agent 上下文快照

`src/personaPlanWorkflow.ts` 读取并校验每个人格 `personaConfig.json.planWorkflow`，它是状态 key、名称、说明、颜色、顺序、视图和生命周期规则的唯一真源。`src/roleKnowledge.ts` 只把 `plan.status` 当作配置 key，并通过 workflow role 与状态属性校验分析、信息不足、审批、执行、完成和归档，不包含十态枚举。v1/v2/v3 配置第一次读取时由同一模块一次性迁移为 v4：保留自定义状态及相对顺序；v1 在分析状态后加入 `roles.informationNeeded` 指向的默认定义；v2/v3 只更新仍保持旧默认 key、label 和说明的中英文说明。迁移不覆盖自定义说明，也不恢复或重新启用 Agent 已移除的状态。`archiveStatus=未归档 | 已归档` 是独立归档变量；只有配置为 `terminal` 且 `archiveEligible` 的状态可以在 `archiveAfterHours` 后归档，归档时保留原 key。`src/roleKnowledgePresentation.ts` 返回配置中的 label、description、palette、order 与 views；`src/roleKnowledgePagination.ts` 动态生成状态筛选和 `byStatus` 计数。状态配置 revision 参与展示缓存。已归档计划在普通列表和关键词召回前被排除，只能通过明确计划 ID 或归档视图读取。状态移除采用 `enabled → retiring → retired`，当前计划先迁移，旧定义继续解释归档计划和追加式历史。

计划目录的物理写入只有一个边界：`src/planStorageRepository.ts`。它拥有跨进程 lease、完整终态快照、publish/receipt 恢复、active/archive 迁移和旧布局冲突隔离；`src/roleKnowledge.ts` 只组装业务终态并调用 Repository，不直接创建、改写或移动计划目录。Manager 在可终止的 one-shot child 中依次执行 lifecycle recovery、旧布局迁移、feedback WAL recovery 和 Persona package recovery，以建立计划存储的读取/变更资格。该资格生命周期不阻塞 Manager READY；`running` 或 `degraded` 时计划变更失败关闭，降级进入 `/health`，Host 与 Tray 保持当前 application generation。`src/planAttachments.ts` 只负责附件数量/大小限制、本机路径或 Base64 读取、图片/视频签名校验、哈希及待提交字节准备，不能自行落盘；附件和 `plan.json` 必须随同一次 Repository transaction 原子发布。`src/manager/planAttachmentRoutes.ts` 只按 `roleId + planId + attachmentId` 提供受控读取，在响应前同时校验词法路径和 realpath 都没有离开该计划目录；图片/视频以内联响应返回，视频支持单段字节范围读取，公开计划 DTO 去掉本机 `path`。WebGUI 只消费该 HTTP 边界来绘制固定宽度的 16:9 图片、视频和 Markdown 简短预览卡片、普通文件卡片及页内完整预览；Markdown 卡片只流式读取正文开头并转成截断纯文本，不在卡片中执行 Markdown HTML、链接或图片。局域网资源统一通过 `managerResourceUrl` 附加当前会话认证；WebGUI 不拥有计划编辑器或任意路径读取能力。

`src/planFeedbackSubmission.ts` 是反馈写入的唯一 command service：它在同一个计划 lease 下重读计划、校验 `stepId/guidance/mentions`，再委托 `src/planFeedbackStore.ts` 以 WAL transaction 原子提交 JSONL 与附件。`src/planFeedback.ts` 只保留公开类型、读取折叠和 post-commit 状态更新，不是第二个物理写入器。同一 `feedbackId` 使用固定 `response-<feedbackId>` 结果 ID；`guidance` 只关联 `planId`，用于人格配置中 `acceptsGuidance=true` 且未进入审批的状态，`approval_suggestion` 关联审批步骤。Manager 的 `/api/roles/:roleId/plans/:planId/feedback` 在 durable commit 后立即返回稳定 `202`，Agent/秘书投递进入响应后的持久 post-commit saga。`src/manager/planQaFeedback.ts` 以 `feedback.id` 作为稳定 `deliveryId`，重试前权威 readback；已接收、仍执行、确认缺失分别进入成功、等待和安全重试。`src/manager/planFeedbackRecovery.ts` 参与同一计划存储资格恢复，处理未完成 WAL 和 post-commit/dispatching/dispatch_failed 状态，不能以不确定错误重放第二份反馈。`src/manager/planSecretaryAssignment.ts` 解析计划独立 `secretaryBinding`：已有有效绑定固定复用；未分配时按 planId 从当前启用秘书池稳定选一个并由 `controlPlaneRoutes.ts` 通过规范 `updatePlan()` 保存。启用秘书时，引导/审批正文直达业务任务，负责秘书同时收到控制通知；业务绑定不完整时完整反馈优先交给秘书。只有没有可用秘书时才走人格 Agent 回退。终态统一发布 `plan_feedback_changed`，事件不进入角色面板 timeline、兼容消息历史或统一会话账本。绑定业务任务收到引导后必须 PATCH 整个计划，并在需要时调整后续步骤，再用固定结果 ID 写无 `stepId` 的 `guidance_response`；审批仍写 `approval_response`。反馈记录本身不自动推进计划状态。

`src/context/rabiContextManager.ts` 是角色上下文触发的唯一归口。它把 `session_start`、`user_prompt`、`reasoning_pre_tool`、`reasoning_post_tool`、`message_delivery` 和无副作用 `preview` 映射为统一的召回、归档、`viewedAt` 与呈现策略，也是生产代码中 `roleKnowledgeSnapshot()` 的唯一调用方。

`AgentPacket` 把正常路由事件适配为 `message_delivery`；`manager/codexHookContext.ts` 把 Codex lifecycle Hook 适配为 session、prompt、推理期触发和计划任务 `Stop` 完成事件。上下文事件通过 `routing/roleKnowledgeContext.ts` 生成同一份“记忆与计划”视图；`Stop` 不进入召回，而是按 `roleKnowledge.ts` 保存的计划 `taskBinding` 精确匹配执行会话，并在私有状态中按 `sessionId + turnId` 去重。

计划完成提醒的实际交接由 `manager/planTaskCompletionDelivery.ts` 负责：选择同人格的唯一 gateway 或计划指定 gateway；启用秘书时把官方 Stop 结果经 Manager 线程桥直接投给 `secretaryBinding`，携带业务任务自己的 `sourceThreadId` 和 `sourceAgentType=plan_agent`，不写主人格角色面板。只有没有可用秘书时才写角色面板 timeline 并调用原 `triggerGatewayRolePanelMessage` 回退链。源目标同会话会失败关闭，避免 Stop Hook 循环。真实 prompt 始终只走 Desktop IPC，目标 Desktop owner、统一秘书模型、工具和审批没有第二真源。`manager/controlPlaneRoutes.ts` 只负责分配持久化、依赖接线和 HTTP 入口；插件只转发官方 Stop 字段，不能修改计划状态或读取 transcript 猜测完成。双真实 Desktop 任务验收前该能力保持实验状态。

注意：角色知识属于 Agent 上下文，不属于 RouteDecision。不要让路由是否命中依赖记忆内容。

## WebGUI

`ribiwebgui/` 是 Vue + Vuetify 最小宿主。页面、导航、设置区、状态卡和主题来自 Manager 的受控插件贡献目录；宿主负责路由外壳、安全渲染、连接与恢复，不维护第二份插件入口清单。

关键位置：

- `src/stores/gatewayStore.ts`：调用 manager HTTP 接口并维护配置状态。首屏使用 `/gateways?summary=1&includeConfig=1`，保留完整可编辑 Route 定义，但只取轻量运行状态；控制台、消息适配器和日志诊断页通过 `ensureDiagnostics()` 按需补取完整诊断，避免人格页和知识页反复扫描日志、消息文件与所有人格全文。
- `src/pages/RoleKnowledgePage.vue`：通过 `/api/roles/:roleId/plans` 和 `/memory` 展示当前人格计划与记忆；计划主体只读。首屏使用 `loadRolePlanPage()` 读取 8 条摘要并立即挂载，摘要包含当前步骤标题、进度和附件数量；后续摘要仍按每批 8 条后台补齐并使用 `facets=0`。视口附近通过 `loadRolePlanPreview()` 请求 `detail=preview`，只合并计划描述、当前步骤说明、阻塞信息与附件元数据，队列最多 4 并发；附件保持在折叠卡片中可见。展开卡片时 `loadFullPlanDetails()` 再调用完整单计划接口，取得全部步骤和审批合同，并独立刷新 Agent 状态与反馈；“工作留痕”继续单独读取历史。首屏全局进度只覆盖首批列表，后台目录补齐和卡片预览使用数量状态及卡片内提示。记忆先取当前分类 24 条并按最多 100 条补齐。Manager 控制面使用紧凑 JSON，单计划预览和完整详情复用预热目录缓存；冷缓存由异步并发文件读取建立，同一人格共用填充任务，文件监听只重读变化文件。目录跳转只挂载目标起点的有界窗口并提升目标预览优先级，不新增浏览器侧事实源。WebGUI 使用 Vue `KeepAlive` 保存本次浏览器会话中的计划页实例；页面失焦、隐藏或切换到其它 WebGUI 页面时只暂停观察器和读取，返回后恢复已加载详情、筛选、展开状态与阅读位置。只有显式刷新操作或浏览器重载会丢弃并重建该缓存。排序筛选弹窗立即挂载轻量外框，并在浏览器完成一帧绘制后异步挂载控件；标签候选复用首批计划响应中的 Manager facets，并通过虚拟列表只创建可见行，不为弹窗维护第二份业务数据，也不在打开时追加请求。审批合同仍由 Manager 的 `presentation.approval.stepId` 定位，只有 `ready/enabled=true` 可提交；计划级引导只提交 `planId`。反馈成功后更新本地卡片并监听 `plan_feedback_changed`。
- `App.vue` 统一将响应式 URL 同步到 `gatewayStore.syncRouteSelection`。`routeScopedNavigation.ts` 解析正式路径及插件恢复页的原始 `from`；`main.ts` 等首个路由确认后挂载。Store 只在无明确 Route 的入口选择默认配置，显式未知 Route 保持未选中；各页面不再通过双向 watcher 回写 URL。路由下拉通过 Router 历史导航切换，名称编辑仅保留当前消息适配器配置的定向地址更新。
- `src/components/PlanAttachmentGallery.vue`：描述区与审批区共用图片、视频和 Markdown 预览卡片；附件 URL、加载状态、摘要缓存与预览弹窗仍由计划页拥有，不新增查询或存储真源。
- `src/components/PlanFeedbackComposer.vue`：计划引导与审批意见共用的输入组件。`@` 引用、Enter/Shift+Enter、文件选择、剪贴板粘贴、附件预览和删除只在此处实现；页面只传入两类反馈各自的可编辑条件、提交条件和文案。
- 计划详情展开时，通过 `manager/planAgentStatusRoutes.ts` 按需读取该计划 `taskBinding` 与可选 `secretaryBinding` 的真实会话状态；页面刷新后只补查仍保持展开的计划，不在目录摘要加载完成后扫描全部绑定。`manager/planAgentStatus.ts` 按绑定的 `agentType` 分派：Codex 读取 Desktop 任务，DSH 通过 apiproxy 读取 DSH 会话；它负责 2.8 秒有界读取、同绑定请求去重、workspace 校验以及 Agent 工作状态与会话状态的分离。Windows 普通路径与 `\\?\\` 扩展路径先归一化再比较。WebGUI 的 3 秒请求预算只决定何时显示未知。打开动作只定位已核对的精确绑定：Codex 调用 `openCodexDesktopThread()`，DSH 打开带 `rabiSessionId` 的 DSH Web 页面；两者都不发送 prompt、不创建任务或会话，也不走备用 Runtime。
- `src/roleKnowledge.ts` 为近期记忆列表生成并缓存沉淀投影。投影用 `updatedAt` / `recalledAt` 计算每条记忆的 24 小时候选时间和 72 小时触发时间，返回 `triggersNextConsolidation` 与 `willEnterNextConsolidation`；记忆目录写入或外部文件变化时与目录缓存一起失效。`src/manager/memoryConsolidationScheduler.ts` 读取最早截止时间并设置一次性任务，到点后重新核对活跃时间、创建 run 并投递 Manager 内置事件。最不活跃记忆到达 72 小时时，`recentMemoryConsolidationCohort()` 固定 `triggerAt` 与 `candidateCutoffAt`，列表投影和真实整理 request 共用该结果，避免晚执行时扩大候选范围。新记忆写入 `.md`，结构化字段保存在元数据区，正文保留标准 Markdown；旧 `.json` 继续读取，同 ID 时 `.md` 优先。`RoleKnowledgePage.vue` 只消费 Manager 结果，不在浏览器复制沉淀候选算法。
- `src/memoryConsolidationAgent.ts` 只负责 Codex 独立记忆整理任务的精确 owner、持久绑定和 Desktop IPC 投递。配置开启时，`forwarding.ts` 只把 `manual_trigger + memory-consolidation` 投给“`<主人格任务名> 记忆整理`”；首次投递前确认主人格 Desktop 任务可读，默认模型为 `gpt-5.6-terra`。失败不回退给主人格或备用 Runtime。
- `GET /api/roles/:roleId/memory?counts=1` 只返回近期、沉淀、已归档来源和整理 run 的数量。`RoleKnowledgePage.vue` 在任何顶层标签首次进入时都让该请求与计划首屏并行，避免默认停留在“当前计划”时记忆标签长期显示 0；记忆正文仍只按当前可见分类分页读取。
- 记忆卡片直接渲染安全 Markdown，卡片最高 512px 且裁剪溢出，完整内容通过详情打开。`markdownPreview.ts` 只允许 HTTP(S) 图片，禁止本机绝对路径、`data:` 和脚本协议。
- `src/pages/OverviewPage.vue`：总览和运行状态。
- `src/pages/RouteConfigPage.vue`：Route 配置编辑。
- `src/pages/RuntimeLogPage.vue`：运行日志。
- `src/pages/PersonaTemplatePage.vue`：人格和模板相关页面；`persona.md` 只在首屏显示最多 420 字的纯文本摘要。
- `src/pages/PersonaDocumentPage.vue`：独立的完整人格 Markdown 阅读页。摘要页和正文页都通过受 WebGUI 访问控制保护的 `/api/roles/:roleId/persona-document` 读取当前人格文件；服务端只允许角色目录根部的单个 Markdown 文件，并限制为 2 MiB。安全 Markdown 渲染复用 `markdownPreview.ts`，链接协议受限、原始 HTML 转义、图片只显示占位。
- `src/components/PersonaAvatar.vue`：WebGUI 统一头像展示与首字回退；上传和文件安全由 Manager 负责。
- `src/utils/gatewayHelpers.ts`：前端配置辅助函数。
- `src/speech/speechControlClient.ts`：浏览器语音 HTTP Adapter；唯一知道 `/api/speech/*` 路径和 `{ code, data }` envelope 的前端 Module。
- `src/stores/speechStore.ts`：语音控制 read model、命令和共享事件流生命周期；RabiSpeech `/v1/events` 经 Manager `/api/speech/events` 推送麦克风、播放、音频流和记录落盘变化。每类事件只刷新自己的 read model，SSE 重连才做一次快照补漏，ASR 主机监视器与其他语音卡片不再周期请求后端。
- `src/manager/speechModelManager.ts`：主机级语音环境和模型权重安装边界。它只读取 `plugin-adapters/rabi-speech/model-catalog.json` 的固定别名，串行启动仓库内安装脚本，不接受浏览器提供仓库、URL 或路径，也不向响应暴露私有绝对路径。
- `src/shared/speechModelManagement.ts`、`src/pages/ModelManagementPage.vue` 与 `src/speech/speechModelManagementClient.ts`：模型管理 read model、弹窗内容和浏览器 Adapter。“语音服务”右上角按需加载该弹窗；即使 RabiSpeech 未运行，也能列出和下载权重。任务变化通过 Manager `/api/events` 的 `speech_model_management_changed` 推送，SSE 重连只补一次快照，不轮询安装状态。旧 `/#/models` 地址只兼容跳回语音服务，不再作为侧栏页面。
- `src/lazyRouteRecovery.ts`：处理 WebGUI 重新构建后，长时间未刷新的浏览器标签页仍请求旧页面文件的情况。Vue Router 确认是动态导入或 chunk 加载失败后，保留用户刚才点击的目标页面和现有 `webgui_token`，只自动重新加载一次；会话级标记阻止连续失败形成刷新循环，其他页面错误不触发恢复。
- `src/i18n/index.ts`：唯一 locale 状态、浏览器偏好持久化、`<html lang>` 和切换事件。
- `src/i18n/catalog.ts`：人工校准的英文界面词条和动态文案规则。
- `src/i18n/domLocalizer.ts`：把已登记界面文案应用到 Vue / Vuetify DOM；跳过 `data-no-i18n`、代码块、输入正文和可编辑内容。
- `src/components/LocaleSwitcher.vue`：顶栏 `中 / EN` 切换入口。
- `src/pages/ProjectDocsPage.vue`：加载并渲染 `docs/user-guide/*.md`，提供双语任务导航、全文搜索、本页目录和可分享的 `?page=` 深链接；开发者 Markdown 通过仓库链接继续保持独立事实源。

前端可以做 UI 友好的默认值和展示转换，但配置不变量不要只存在前端。需要和后端一致的规则应进入 `src/shared/gatewayConfigModel.ts` 或由 manager 返回。

局域网访问同样遵守这一边界：`src/manager/globalConfig.ts` 拥有 `webguiLan` 配置真源，`src/manager/webguiLanAccess.ts` 拥有密钥生成、地址分类和鉴权规则，`controlPlaneRoutes.ts` 只接线 HTTP 门禁与 `/api/webgui-access`。`ribiwebgui/src/managerApi.ts` 只捕获 URL token、保存当前会话凭据并适配 fetch/SSE；`webguiLanRedirect.ts` 只在 Manager 已实际监听局域网时把回环页面切换到优先局域网 origin，并保留当前 hash Route/页面和一次性 URL token；`routeScopedNavigation.ts` 统一把 Route 配置名编码进 `#/routes/<Route>/overview|adapters|persona|knowledge|speech|runtime`，识别旧短路径并保留 hash query；`App.vue` 让左侧当前 Route 与当前页面类型共同决定 URL；各页面只消费这个稳定导航合同，不各自定义 Route URL 规则。`OverviewPage.vue` 仍只展示 Manager DTO、生成当前 Route 快捷链接和提交命令，不保存第二份正式开关或密钥。

RabiLink 远程 WebGUI 也保持前端与本机 Manager 的所有权边界：Relay 的 `/manage/<账号>/<RabiGUID>/` 只拥有账号会话、目标 PC 选择、静态构建和受限代理。普通 HTTP 请求进入 `webguiRequests`，PC 侧 `rabiLinkRelayRuntime.ts` 只把允许的请求头转发到回环 Manager，并回填状态、响应头和 Base64 body；`Range` / `If-Range` 与 `206` 响应用于媒体字节读取。Manager `/api/events` 不进入一次性队列，Runtime 维持一条本机 SSE，解析事件后通过 `/worker/webgui-events` 推给 Relay 的 `webguiEventHub`，再按账号应用和 PC 身份定向发布。Relay 登录 Cookie、PC 应用 token 和局域网 `webgui_token` 不相互转发或复用；请求/响应 Base64 与事件 JSON 都有独立大小门禁。

人格头像的文件读写、类型校验、内容寻址与原子配置切换集中在 `src/personaAvatar.ts`；`src/manager/personaAvatarRoutes.ts` 负责 `/api/roles/:roleId/avatar` 和表现 DTO，`controlPlaneRoutes.ts` 只注册路由。WebGUI 和 Qt 都通过 Manager HTTP 读取头像；Qt 不再通过本地 `RoleContextRepository` 读取人格目录。头像是人格展示元数据，不进入 AgentPacket，也不改变路由匹配或处理端投递。

语音控制链路采用明确的前后端分离：

```text
SpeechServicePage / SpeechHostMonitor
  -> frontend speech store
  -> frontend speech client Adapter
  -> Manager speech Interface
  -> manager/speechControl.ts
  -> localSpeechClient Adapter
  -> RabiSpeech Python implementation
```

`src/shared/speechControlContract.ts` 是 Manager 与 WebGUI 之间的稳定 camelCase Interface，也拥有 Route 语音默认值。`src/manager/speechControl.ts` 负责 Route policy、RabiSpeech payload 映射和 read model 正规化。`POST /api/speech/messages` 会等待 Gateway 子任务返回真实终态：Desktop owner `start/steer` 成功才是 `delivered`，关键词模式未命中则是 `recorded`，失败为 4xx/5xx；它不等 Agent 回答、Outbox 或 TTS 播放结束。Python 的 snake_case、模型进程状态和回环地址不能泄漏回 Vue 页面；RabiSpeech 仍是独立的回环 Provider Runtime，不合并进 Manager。本地 Provider 默认启用；外部 API Provider 必须在本机配置显式启用、从环境变量取密钥，并通过 capability 的 `local_only` / `relay_safe` 暴露边界。

模型管理是独立的主机控制面，不属于某条 Route。`GET /api/speech/model-management` 返回环境、目录和任务状态；两个 POST 入口分别安装核心环境和单个允许清单模型，不接受任意下载仓库、地址或路径；单独的本机设置入口校验模型总目录覆盖值，目录路径只返回给本机 WebGUI。Manager 同一时间只允许一个任务，并继续受只读模式的全局写操作门禁约束。`src/manager/speechModelFiles.ts` 核对管理目录及已配置模型路径中的代表文件，下载状态不再只取决于安装清单；文件存在不等于校验和或推理就绪。弹窗使用紧凑环境栏、筛选搜索和表格，仅在存在当前或最近任务时显示任务行，说明默认折叠。模型清单中的 `runtime=core|isolated` 只说明运行环境要求，不代表已检测到环境缺失；“模型已下载”不能被展示为推理、波形或真实设备已经验收。

`src/manager/speechEventProxy.ts` 单独拥有 Manager SSE 客户端与 RabiSpeech 上游流的一对一生命周期。浏览器或验收客户端断开时只中止对应的上游 fetch；由此产生的 `AbortError` 是正常终态，必须在代理层消费，不能变成未处理 Node stream error 或拖垮 Manager。上游不是 `text/event-stream` 时在写入 SSE 响应头之前失败关闭，不把旧 Manager/WebGUI HTML 冒充事件流。

Route 的 `speechPushMode` 是语音投递策略真源：`hot` 在每段 ASR 完成后立即进入普通 `start/steer` 链；`keyword` 仍写入 ASR 账本，仅命中人格 `speechTriggerKeywords` 时唤醒。空关键词不会回退热投递。

主机级波形、五段链路、计数器、运行事件和最近转写只放在“语音服务 → ASR”的 `SpeechHostMonitor`。Route 的“消息适配器 → 语音消息端”只显示该 Route 的订阅策略：热投递/人格关键词、人格 TTS 摘要、主机与人格职责说明、Agent 回复自动播放，以及单次 ASR 广播说明；不得再次嵌入主机监视器。

locale 只允许作为浏览器侧 UI 偏好缓存，键为 `rabiroute:webgui:locale`，不是正式项目存档。route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据属于用户配置或运行事实，必须保持原文；需要保护的动态区域使用 `data-no-i18n` 明确标注。

## Windows 应用生命周期

`RabiRouteHost.exe` 是 Windows 正式运行态唯一的生命周期所有者和稳定入口。每次启动创建新的 `applicationGenerationId`，在同一个 Windows Job Object 中直接启动 Manager 与 Tray；任一必需子进程死亡、身份不匹配或健康失效时，Host 先回收整代，再按有界退避创建新代。Host 退出时 Job Object 清理其全部受管子进程；Manager 启动的 NapCat 子进程随该代回收，并在下一代绑定检查完成后按配置自动恢复；独立启动的普通 QQ、浏览器和其他外部应用不进入这个 Job。

Manager 默认绑定 `127.0.0.1:0`，由操作系统分配空闲端口。Manager READY 后把 `applicationGenerationId`、`managerInstanceId`、PID 与完整 `managerBaseUrl` 发布给 Host；Host 核验 `/meta` 后才把本代端点交给 Tray。端口不是身份，Tray 不缓存旧 URL、不扫描 `8790..8799`、不启动或停止 Manager，也不能脱离 Host 独立运行。用户退出只经 Host 的带代际 fencing 控制管道停止整棵树，不使用 Manager shutdown API。

代码生效分为三层：WebGUI 开发态可使用 Vite HMR；正式受管插件只从已构建 package/profile 产生候选 plugin generation，并在成功后原子发布；Host、Manager、Tray 与后端核心改动必须本机构建、打包并切换完整 application generation。正式安装不从 NAS 源码热跑，避免同一运行代混入新旧模块。

## Desktop Tray

`desktop/tray-task-window/` 是 Windows 最小桌面表现层。命令、快捷键、托盘菜单、设置、状态和主题由插件贡献；Qt 外壳只负责消费 Host 提供的本代 Manager 连接、窗口生命周期、安全 handler 白名单和固定恢复入口。

它主要负责：

- 请求 Host 打开当前应用、刷新状态或退出整代；不拥有 Manager 生命周期。
- 打开任务窗口。
- 展示角色计划与记忆。
- 和 manager HTTP 接口通信。

它不是 RabiRoute 的事实源。任务、记忆、配置仍应落在 `data/` 和 manager 后端。

托盘和 RibiWebGUI 使用同一个 Manager 后端。Manager 先通过 `roleKnowledgePresentation.ts` 生成计划视图分类、显示状态、状态色板、审批能力及统一排序；两端只渲染 API DTO、分类、色板和既有顺序。`DesktopRefreshService` 无 Qt 依赖，只通过 `ManagerClient` 调用 `/gateways?summary=1`、`/api/roles/:roleId/plans`、`/memory`、`/role-panel/messages` 和 `/avatar`，再生成 DTO；审批提交使用同一 `ManagerClient` 的 plan feedback API，并通过 `qt_async` 在后台等待。托盘正式运行链路不导入 `PlanRepository` 或 `RoleContextRepository`，不直接读取 `data/`。`qt_async` 是不含业务语义的通用线程池桥，`tray_app` 只负责 UI 组合、用户事件和缓存应用。隐藏面板不请求聊天/头像或重建 QWidget，菜单显示期间延迟应用刷新结果，未变化时不重建菜单或面板，超过 5 项的人格入口延迟到子菜单展开时创建。Windows 不注册隐式 `setContextMenu`；表现层 `TrayMenuController` 将左键 `Trigger` 和右键 `Context` 统一映射到已预热菜单的非阻塞 `QMenu.popup()`，双击不重复打开。短暂失败可保留并标记旧快照，Manager 真正离线时不得用缓存伪装在线。

Gateway summary 只返回人格标识、路径、头像和从文件开头提取的轻量标题等展示元数据，不读取或序列化完整 persona Markdown 正文；完整 `/gateways` 仍保留人格页所需的预览详情。

## Plugin Adapters

语音原始消息把整段 RMS 与峰值作为 PCM 响度事实，从 RabiSpeech 贯穿 `SpeechIngressStore`、Route 事件、人格 `voice-transcripts.jsonl` 和 `conversation/current.jsonl`。两项字段只服务阈值、质量和故障诊断，不参与主机身份或“谁是用户”的判断；只有人格能解释某个语音账号是谁。关闭前置缓冲也不改变音频归属：`pre_roll_ms=0` 时触发 VAD 的第一块 PCM 仍必须进入当前语段。

`plugin-adapters/` 放外部平台桥接示例：

- `napcat-rabiroute`
- `xiaoai-rabiroute`
- `rabi-speech`：独立回环 TTS / ASR Provider 服务插件；不属于消息端或 Agent 端，Manager 只代理其回环 HTTP API。Provider registry 可同时登记本地 worker、OpenAI 兼容 API 和 DashScope 原生 API；本地默认与显式云端选择不能混成自动回退。

RabiSpeech 的 `AudioTranscoder` 是所有 Provider、人格 TTS 与直接 HTTP 调用共用的成品音频准备入口。WAV 只改变采样率时使用 NumPy + SoundFile 本地重采样，不依赖宿主进程的 PATH；跨格式转换才调用显式配置或可发现的 ffmpeg。调用方与单个 Provider 不得各自维护第二套输出重采样规则。

RabiSpeech 的模型基准仍归插件自身：`scripts/benchmark_models.py` 按 TTS → WAV → ASR 顺序采集原始数据，`benchmarks/` 保存公开语料、功能元数据和无外部依赖的 HTML 模板，`skills/benchmark-rabispeech-models/` 固定操作与验收顺序。生成后的公开报告进入 `ribiwebgui/public/reports/`，由 Vite 复制到 WebGUI 静态产物；本机 Manager 和 RabiLink Relay 分别在本机根路径与已认证的远端 PC 前缀下提供 `reports/`。运行期 WAV、JSON、CSV 和日志不进入前端或仓库。

实时能力页归控制面：`src/manager/speechServiceStatus.ts` 只允许探测回环 RabiSpeech，并删去配置路径、模型目录等私有字段；`src/manager/speechRuntimeControl.ts` 拥有 WebGUI 页级启停命令、同一时刻单次 transition、启动后的真实健康等待和停止前的 Windows 进程归属核验；`src/manager/speechControl.ts` 再把模型、麦克风、播放、音频流选择、持久化语音记录和消息命令统一映射到 `speechControlContract`。`GET /api/speech/status` 把规范化结果交给 frontend speech store，`POST /api/speech/runtime/start|stop` 只控制当前工作区本机运行时。WebGUI 顶部滑轨直接投影真实在线状态；关闭时除标题、状态、错误和滑轨外不渲染其余运行参数。音频流默认使用本机声卡；启用局域网 `remote_audio` 后，`remote_audio.py` 通过独立鉴权 WebSocket 把远端客户端当成纯麦克风/喇叭，客户端不拥有 VAD、切句或模型，断线也不自动回退。主机播放音量由 RabiSpeech 持久化并通过播放状态返回，WebGUI 的全局播放队列卡只经 Manager 更新该 `0–100` 值；每条音频开始播放时冻结当时的音量，因此调整会从下一条开始播放的音频生效，不属于 Route 或人格。主机麦克风、ASR 模型、VAD 和切句参数同样只归 RabiSpeech，语音服务页经 Manager 统一维护；ASR 页的持久串流开关独立决定是否持续录音和识别，Route 页的语音消息端总开关只决定分发订阅。Manager 对每段主机 ASR 只接收一次，然后广播给全部已订阅 Route；没有订阅时仍保存主机记录，各 Route 独立执行热投递/人格关键词与回复播放策略。关闭或新增 Route 不改变录音状态。人格目录下的 `voice/voice-profile.json` 是 TTS 模型、声线、语言、语速和表达指令的唯一真源，旧 Route TTS 字段只作兼容读取。因此左侧“语音服务”显示当前电脑事实，项目文档和静态 HTML 则保留某次目标测试机基准，两者不能混成同一数据源。

Windows 系统级滑词菜单由托盘拥有。`system_selection.py` 用低级鼠标与键盘钩子识别鼠标拖选结束和 `Shift` 扩选结束，再通过 Windows UI Automation 读取当前焦点控件的文字及真实选区矩形。悬浮条优先按该矩形横向居中；鼠标向上拖选时放在上方，向下或同一行拖选时放在下方。键盘扩选合并扩选前后的系统插入符矩形；Unity 没有系统插入符时，使用同一前台窗口最近一次点击位置。普通软件不模拟 `Ctrl+C`；Unity 编辑器没有 TextPattern 时才发送带标记的临时复制输入，最多等待 900 ms，并恢复原剪贴板的完整 MIME 数据。密码控件、空选区和仍无法读取的文字直接忽略。无焦点 Qt 悬浮条显示“投递至”，并在 `readAloudEnabled` 为 true 时显示“朗读”：朗读经 Manager 查询当前 TTS 模型并调用 `/api/speech/tts` 进入 RabiSpeech 主机 FIFO；光标移到“投递至”时，托盘从当前 Manager 快照筛出已启用且运行中的人格，显示悬停菜单，点击具体人格后复用 `/api/role-panel/messages` 投递到对应 Route。划选本身不触发网络或语音动作。`selectionSpeechSettings.ts` 把 `enabled`、`readAloudEnabled`、高级选项和固定模型保存到 `data/speech/selection-reader-settings.json`，WebGUI“设置”页通过 `/api/speech/selection-reader/settings` 修改同一主机设置，浏览器不再拥有选区监听或本地设置副本。

`interfaceThemeContract.ts` 与 `desktopSettingsContract.ts` 定义主机级主题选择、内置模板和受限的自定义主题声明。`data/desktop/settings.json` 与 Manager 的 `GET/PATCH /api/desktop/settings` 是唯一真源；`theme` 保存 Desktop 可应用的主题，`webTheme` 保存 WebGUI 当前选择并兼容 Web 专属可信插件主题，`customThemes` 保存两端共享的自定义声明。浏览器旧主题键只允许一次性迁移后删除，不拥有主题选择或主题定义。WebGUI 从 `ribiwebgui/src/themes/<theme>/` 读取内置 Vuetify 色板和 CSS token，自定义主题把经过校验的语义颜色、圆角、透明度和阴影映射到同一批 token；Windows 托盘从同一自定义声明生成 Qt 调色板、菜单样式和现有窗口颜色替换表。两端将 `system` 解析为实际浅色或深色后再刷新角色面板、滑词操作条和截图窗口；悬空的 `custom:*` 选择失败关闭并回退可用主题。

`workEndEvents.ts` 是通用任务结束事件的 Manager 真源：生产者向 `/api/work-events/ended` 提交带稳定 ID 的事件，Manager 按敏感键名清洗摘要、按日期物理分卷到本机运行目录，并通过统一 Manager 事件流发布 `work_ended`。分卷是文件轮转，不是归档、过期或删除；当前源码只定义生产者契约，Codex / DSH 的真实生产者仍待各自接入。`taskCompletionAnnouncements.ts` 是独立消费策略，只保存设置和决策/哈希/回执元数据，元数据同样按接收日期分卷；索引保留最近 40 条展示记录和 4096 个幂等 ID，源分卷保留，索引损坏时由源分卷人工重建。原始摘要仍以任务事件分卷为真源；允许的事件经人格 `voice-profile.json` 解析后进入 RabiSpeech 全局 FIFO。

`io.rabiroute.manager.desktop-pet` 独立插件拥有桌宠 HTTP 路由和 effect 生命周期，`desktopPetRoutes.ts` 提供受限的资源包、绑定与设置实现。导入先落临时 staging，校验归属、路径穿越、链接、加密条目、允许类型、条目数和展开大小，再移动到 `data/roles/<RoleId>/desktop-pet/packs/`；资源读取也必须保持在解析后的包根内。WebGUI 和 Qt 只调用 `/api/desktop-pet/`，插件停用时路由随 generation 释放；`desktop_pet_controller.py` 消费同一绑定与 `work_ended`，不直接编辑人格或运行目录。

`io.rabiroute.manager.yeyu-gamer` 是独立、默认关闭的 Manager 插件。Profile 拥有启用状态与固定 loopback 配置；`src/integrations/yeyuGamer/` 校验 typed API、token 文件和 plan-only work item 合同。宿主只提供插件路由与请求排空原语，不把该集成塞回 `controlPlaneRoutes.ts` 的请求分支。

RabiSpeech 的 `speech_records.py` 是 ASR/TTS 文本记录唯一真源，参考芬妮笔记按日追加运行文件。`tts_audio_store.py` 单独拥有可重建的 TTS 音频缓存：已解析人格的成品进入 `data/roles/<RoleId>/voice/cache/tts-audio/`，非人格直接调用进入 RabiSpeech 私有 fallback；两者默认按各自 mtime 保留 24 小时。Manager 的 read model 只允许 POSIX 风格安全相对引用，兼容旧记录的单文件名，并省略绝对路径、父级穿越和反斜杠路径。WebGUI 在 ASR 页面内嵌最近持久化双向记录，显示相对缓存位置和预计过期时间；它不把路径做成文件链接，也不提供独立会议记录、选择或导出工作流。缓存超过保留窗口不改变文本记录，ASR 原始录音仍默认不复制。

`speaker_profiles.py` 拥有主机共用的人物资料与 `recordId + speakerLabel` 人工绑定；`speaker_recognition.py` 独立拥有本地神经 embedding、已确认多原型和未知聚类。供应商的 `0/1` 绝不沿常驻麦克风 `sessionId` 继承，也不再拥有声纹采样分组解释权：同一 Provider 标签跨多个不连续时间 turn 时，原始值保留在 `speaker`，声纹层生成逐 turn `speakerLabel`、分别提取 embedding，再由不透明 cluster 判断这些 turn 是同一声音还是不同声音。这样错误标签不会把不同人的音频拼成一个样本，而真正同一声音仍会收敛到同一 voiceprint。WebGUI 下拉只修正当前录音 turn，但会把该 turn embedding 标为已确认原型；后续匹配同时要求有效语音时长、最高相似度和第一/第二名差距，低置信度保持 unknown。原始注册音频不复制，向量只写入 Git 忽略的 `output/speaker-embeddings.json` 且不进入公开 API。模型存在但本机阈值尚未验证时只开放聚类和候选提示；正式自动绑定同时要求 `validated=true`、`real_person_private` 数据集资格、完整 dataset/policy/model SHA-256 和通过的目标引擎门禁，任何缺失或不一致都会失败关闭并让 `voiceprint.supported=false`。模型由 `scripts/speaker_model_probe.py` 在独立进程先做真实推理；正式提取使用 ONNX Runtime + kaldi-native-fbank 的 16 kHz / 80-bin / global-mean 后端，避开 Windows sherpa native 对官方模型的格式误判。embedding 仓库分别限制人工确认原型和未确认样本，并拒绝低 RMS 或明显跨说话人重叠片段。

`src/speechIngressStore.ts` 是 RabiRoute 主机级语音原始消息真源。RabiSpeech 把一次 ASR 的稳定 record ID、采集开始/完成/接收时间、Provider、模型、语言、时长、峰值、采样率、声道、音频格式、通道、稳定来源设备、临时音频流 ID、完整说话人分段和可用的逐词时间/置信度一次性交给 Manager；`src/shared/speechTranscript.ts` 是 Python snake_case、HTTP 返回和人格账本共用的可移植分段/逐词规范化入口，`src/routing/speechIngressForwarding.ts` 则是主机原始记录转成 `speech/rabilink` Route 事件的唯一字段映射入口。Manager 会删除主机人物名称、资料 ID、候选资料 ID 和已验证人物标志，只保留不透明声纹/聚类 ID、分段标签、分数、判定证据和逐词时间，再追加 `data/speech/messages/YYYY-MM-DD.jsonl`；相同清洗会在写入和读取人格 `conversation/current.jsonl` 时再次执行，旧记录也不能把主机人物判断重新注入人格上下文。`recordId` 检查与原始消息追加共用跨进程锁，Route receipt 日文件也串行追加，保证并发补交不产生重复或交错 JSONL。ASR 处理链与消息端类型分离：本机麦克风或普通 Rabi 语音客户端生成 `messageAdapterType=speech`，Android 手机/眼镜通过 Relay 持续传有序 PCM，在主机完成 VAD/切句/ASR/声纹后生成 `messageAdapterType=rabilink`；Android 不保存第二套 ASR/VAD 真源。`sourceDeviceId` 是稳定回复目标，`sourceStreamId` 只表示本次 PCM 连接，不能参与下行设备寻址。流序号必须从 1 连续递增；Android 只在 PC 确认后推进序号，待确认块的稳定 `chunkId` 在临时流重建后仍不变。RabiSpeech 按每个稳定 `sourceDeviceId` 保留最后一个已接收 chunk 的 `chunkId + PCM SHA-256`，只保存标识与哈希；ACK 丢失后的跨流重发不会再次进入 VAD/ASR，后续新 chunk 则按新流序号继续推进。Android 的系统网络回调与既有 RabiLink SSE `ready` 事件会立即唤醒待确认 PCM，只有服务端暂时不可用时使用一次性退避；有界最新音频缓冲会丢弃长断网期间的过旧 PCM，使恢复后追上实时流而不是永久滞后。`start` 和每个成功 chunk 都重置一次性 15 秒到期事件，到期后才回收虚拟客户端并恢复之前的音频输入，不做固定间隔扫描。Manager 只投给启用了对应消息端的 Route。`routeProfileId` 是通用 Route 选择器，不是来源类型；来源身份由 `routeKind/adapterType` 决定，手机语音不能因带 `routeProfileId` 被解释成角色面板。`forwarding.ts` 继续负责每个 Route 的人格对应关系，因此不同人格分别写 `voice-transcripts.jsonl` 和 `conversation/current.jsonl`，同一人格目录不会因多 Route 重复记录；首次写入时先初始化/追加统一会话账本，再写兼容原始历史，避免当前事件被旧历史迁移重复导入。手机流以 `routeKind=rabilink` 进入 Agent，回复 API 默认按 `sourceDeviceId` 回原设备；声纹对应谁、谁是用户以及是否需要响应，都由各人格结合自己的关系和上下文解释。

移动端下行的事实拥有权同样分层：Relay 拥有消息、明确目标和设备回执；手机拥有 cursor、可靠队列、本机播放编排、“消息连接是否应在重启后恢复”的持久意图，以及用户请求的 `PAUSED / PHONE / GLASSES` 单一模式真源；前台 Service 拥有实际运行模式、采集和连接状态；眼镜只拥有自身外设状态与扬声器播放完成事实。切换模式时 Service 先释放旧采集端，眼镜连接事件到达前或断线后保持暂停，绝不静默启用双路麦克风。Activity 通过 `RUNTIME_UPDATED` 广播重建运行卡片，不轮询业务状态。明确主动性偏好作为 `rabilink.preference` observation 和来源元数据可靠传输；App 与 Relay 不拥有介入规则。手机私有文字、控制、媒体、回执和下行队列统一使用 fsync 后原子替换，启动清理临时文件并把坏 JSON、缺失二进制和孤立附件隔离为可见错误，单个毒化项不能阻塞后续队列。`/api/rabilink/events` 的 `outbox_available` 只作事件唤醒，Android 随后用持久 cursor 查询一次增量补漏。Android 已知断网时，SSE 连接和可靠队列发送阻塞在由系统 Connectivity callback 驱动的事件门，不再固定间隔重连；仅为防止厂商漏发已注册回调，前台服务在已知离线期间每五分钟只检查一次 OS 当前网络，恢复后立即停止并回到 SSE `ready → cursor` 单次补漏，不查询 Relay 业务状态。仅网络可用但服务端失败时使用一次性 1–30 秒退避。Relay 每 15 秒发送 SSE keepalive；Android 45 秒收不到任何 SSE 字节时触发传输层停滞 deadline，重建半开连接并回到同一单次 cursor 补漏，不增加业务轮询。消息连接恢复意图与持续聆听分离：已启动的文字/媒体/下行服务会在进程或设备重启后恢复 cursor 和可靠队列，明确停止才清除恢复意图。明确 `targetDeviceIds` 的 Outbox 消息在所有目标回 `delivered` 前不按 TTL 清理；广播和仅按设备类型的消息继续受有限 TTL 约束。`delivered` 不代表 `played`：手机和眼镜分别只在自己的 `AudioTrack` marker 到达后产生 `played`，回执先落手机私有磁盘队列再补传，Relay 只持久化和发布 `outbox_receipt`。眼镜的 BEGIN、PCM 与 END 共用有序 Classic BT，避免结束控制越过音频；播放线程会等主线程确认采集暂停后才接受 PCM，Activity 销毁时未完成播放回 `playback_failed`。旧无帧协议 PCM 可兼容播放，但不得生成成功回执。

`src/acceptance/speechIngressSeparation.ts` 与 `scripts/test-speech-ingress-separation.mjs` 把上述边界组合成构建产物隔离验收。工具在临时数据根中向同一个主机原始库写入一条 PC 麦克风记录和一条手机记录，再分别调用真实 `dist/index.js --speech-message` 子进程；它要求主机库恰好保留两个逻辑消息端、两个不同人格各写一次语音历史与统一会话、PC 上下文不出现手机目标、手机回复只使用稳定 `sourceDeviceId` 而不使用临时 `sourceStreamId`，并验证主机人物猜测没有进入人格文件。子进程只使用不打开窗口/剪贴板的隔离 Agent adapter，不连接真实 Manager、Desktop、QQ 或 Relay；完成后删除临时目录，只留下脱敏数量、哈希和终态证据。

`src/identityRelations.ts` 拥有人格级通用身份关系事件，分别记录消息端账号、参与者与带会话/项目范围的关系卡。`src/routing/identityContext.ts` 只从适配器已经核实的真实发送者字段提取 `platform + endpointIdentityNamespace + senderStableId`；实际命中的 Route 第一次投递稳定陌生账号时才创建确定性的“待认识”候选。没有稳定发送者标识、身份自报只存在于转发/引用/附件内容、AgentPacket 预览、读取接口和未命中 Route 都不自动创建或合并身份。这条失败关闭边界保证不可信上下文中的“我是某人”不会变成账号映射；同一稳定发送者在本轮明确自报的称呼仍只能由下述观察接口保存为候选证据。

候选观察接口只追加新出现且带消息证据的自述、称呼或关系线索，不确认身份、不授予权限；账号已经存在确认映射后会拒绝继续修改旧候选。词汇、句式、回复节奏和长期话题等说话习惯一致性可以写成最小化辅助证据，但不能成为身份键，也不能单独把候选提升为确认。`participantLinks` 允许共用账号保留多个候选，解析层在没有唯一确认或纠正映射时保持歧义，不按置信度自动挑人。多 PC 同步时，自动候选的昵称、别名和观察证据属于可合并的非权威线索，参与者类型、确认状态、账号映射或关系卡内容的分歧仍显式保留为冲突。

`ribiwebgui/src/components/PersonaIdentityRelationsCard.vue` 负责身份定位的界面投影和受控编辑入口，但不负责推断身份。“已识别身份”按确认或纠正后的参与者聚合消息端账号；一个账号如果以多个候选链接指向多个已识别人物，就作为“共用”账号出现在每个相关人物中，但不会产生唯一人物结论。人物卡整卡打开同一个身份工作区，在其中分别维护参与者资料与说话习惯、消息端账号和关系；三类记录仍按现有 Manager API 分别追加事件，界面不会把它们伪装成一次原子保存。“未识别身份”继续按 QQ、微信、声纹等消息端分组人物仍未知、候选尚未指向已识别人物或存在冲突的账号。浏览器不复制身份判断算法，也不保留第二份人物真源。

`src/personaVoiceIdentities.ts` 拥有语音消息端账号的兼容归类事件。主机语音消息与 AgentPacket 只提供 `sourceHostId/sourceHostName` 和不透明声纹证据；人格通过 `/api/roles/:roleId/voice-identities` 把自己的 `participantId/displayName/relationship/isUser/aliases/notes` 追加到 `voice/voice-identities.jsonl`。`participantId` 只显式引用通用身份关系中已经确认或纠正的人物，不根据名字猜测归属；界面用它把声纹放入对应的“已识别身份”卡，也允许清除引用后回到按消息端分类的“未识别身份”。账号键由处理主机与声纹 ID 共同构成，避免多 PC 本地 cluster 碰撞。相同更新不重复追加，修正与删除使用新事件/tombstone，不产生 Manager 侧人物真源。新事件通过 `supersedes` 记录它收敛的当前事件头；多 PC 并发分支在 JSONL union 后仍同时存在，读取层派生冲突字段，后续人格 PUT 再显式收敛全部头，因此不会退化为文件顺序决定身份。数据尚未机械迁入通用身份关系：一段录音可能含多个声纹，而 `isUser=false` 只表示“不是当前人格”，不能安全指向某个具体参与者。

`src/personaVoiceTranscriptView.ts` 是语音账号兼容归类的只读联结层，`src/manager/personaVoiceTranscriptRoutes.ts` 只负责稳定 HTTP 边界。`GET /api/roles/:roleId/voice-transcripts` 在查询时把会话记录的原始声纹证据与当前人格归类合成 `user/other/unknown/conflict` 分段视图；它支持时间、归档和说话人筛选，并从完整筛选集合派生分类时长、覆盖率和未解决声纹汇总，明细 `limit` 不截断 `matchedCount` 或 summary。该层不回写任何派生名称、`isUser` 或统计，因此原始消息与人格解释继续保持各自唯一真源。

RibiWebGUI 通过 `personaVoiceIdentityClient.ts` 复用这两个 API，不新增浏览器声纹仓库。人格页的最近 24 小时面板使用 `includeDetails=false`，只接收 summary 和独立关系列表，不接收转写正文；加载、按钮忙碌、错误和提示属于短暂表现状态。`personaVoiceConfirmation.ts` 只维护一次用户主动确认会话的开始时间、开始时未解决声纹的 `lastSeenAt` 基线、等待/找到状态和候选复合键；候选来自下一次语音记录事件后相对基线新出现或再次出现、且有稳定主机标识的未解决声纹，只改变排序与标记，不产生或保存身份结论。页面进入、人格切换和人工操作后查询一次，并监听 RabiSpeech `records_changed`、Manager `persona_voice_identity_changed` 与 `persona_sync_manifest_changed` 事件。SSE 重连只补查一次，不运行覆盖率轮询。

`src/personaSync.ts` 只负责本地人格文件读取、归档、合并与显式冲突解决；`src/personaSyncManifestIndex.ts` 拥有可重建的持久化 manifest 索引和父进程内不可变发布快照。启动和后续刷新都由 one-shot child 完成目录遍历、SHA-256、计划包锁定与完整校验；父进程只接收结构化结果，深冻结后原子发布带单调 revision、`refreshedAt`、`refreshStartedAt` 和 `stale` 的快照。本机根只使用原生文件事件唤醒一次 child 刷新；UNC 根在任何 probe/watch 前关闭本地 watcher，使用可终止的 `worker_poll`。`GET /api/persona-sync/manifest` 只读已发布快照，不触发 `readdir/stat`、哈希、计划锁或校准；尚无快照时明确返回 503，刷新超时或失败时保留上一份并标记 stale/degraded。新 revision 经 Manager SSE 发出 `persona_sync_manifest_changed`。`src/personaSyncCoordinator.ts` 负责 peer 发现、传输编排和已解决版本发布；`src/personaSyncAutoReconciler.ts` 只拥有事件调度和 `auto-sync-state.json` 待对账标记，不复制任何合并规则。它把本机文件变化、Relay `ready` 和 `persona_sync_peer_changed` 当作唤醒信号，短时间事件合并后调用 Coordinator 做一次全量或单人格 manifest 对账；peer 离线时等待下一事件，在线临时失败时只做有界一次性退避。`src/manager/personaSyncRoutes.ts` 维护受控 HTTP 合同，并通过仅回环 `index-status/auto-status` 暴露不含正文的诊断；`src/manager/personaSyncLanServer.ts` 是默认绑定私有 IPv4 的独立数据面 listener，只允许远端访问 manifest、file 和 merge，不暴露完整 Manager/WebGUI。同步器优先访问 Relay 登记的这个专用 LAN URL，失败后调用 Relay 的 `/api/rabilink/persona-sync/proxy`，复用全局 worker 把受限请求送到目标 PC 回环 Manager。Relay 不保存主人格。JSONL 使用集合合并，普通文件使用按应用 token 哈希作用域与稳定 peer GUID 分域的共同哈希做快进；已有共同基线的单边缺失作为删除双向传播并先归档旧文件，删除与编辑并发则携带 `remoteDeleted`、peer 和基线哈希进入 `data/persona-sync/conflicts/`。同一人格、路径、peer、远端哈希、删除状态和基线哈希直接映射到固定 `evidence-<sha256>` 文件；自动对账通过一次文件定位复用证据，不再同步遍历旧冲突目录，任一身份或哈希不同仍保留独立证据。冲突列表按指定人格缩小目录范围，旧时间戳副本先按路径、peer 和内容证据归组，只读取每组代表项；首次目录整理使用异步目录迭代并缓存结果。列表、证据读取与 `keep_local/use_remote/use_merged` 解决 API 只允许回环访问；解决时校验当前本地哈希，`use_remote` 对删除冲突表示确认删除，同组旧证据与元数据一起进入 `resolved-conflicts/` 并留下审计记录。随后 Coordinator 以冲突远端哈希为新发布基线，把解决结果经 LAN/Relay 发回来源 peer；远端或本地已变化时返回 `not_published`，保留新的待对账标记而不声称收敛。同 peer/人格并发同步 single-flight，文件与基线状态锁定后原子写。`conversation/` 合并复用消息上下文锁，语音记录和人格声纹关系复用各自文件锁，避免同步覆盖与在线追加交错。读取和 merge 检查完整父路径链并拒绝符号链接/Windows junction。锁、manifest 索引、临时文件和可再生 TTS 缓存不参与同步。

本机 watcher 只负责把明确路径变化合并为后台刷新请求，不在 Manager 主线程读取目录；child 构建的新快照必须同时识别删除并保留未变化范围。UNC 的 `worker_poll` 是正常运行模式，不记为 watcher fallback；只有 child 超时、异常退出或无法确认终止时才进入 stale/degraded，且 GET 仍不得回退为同步扫描。

`ribiwebgui/src/components/PersonaSyncCard.vue` 只维护页面加载、预览、按钮忙碌、提示等可重建表现状态。它通过 `personaSyncClient.ts` 读取 peer、索引、自动状态与冲突，并提交显式同步或基础解决命令；同步、删除、冲突、重试和最终收敛含义仍全部由后端拥有。页面监听 `persona_sync_manifest_changed`、`persona_sync_auto_status`、Relay/LAN 状态事件后各补查一次，不设置业务轮询。

`src/acceptance/personaSyncDualNode.ts` 与 `scripts/test-persona-sync-dual-node.mjs` 使用两个临时人格根、真实 Relay Server、真实目标 worker/Manager 数据面和专用 LAN listener 验收该编排。它先证明 LAN-first 的 JSONL/普通文件/删除/声纹语义冲突与解决发布，再只撤掉可达的 peer URL 以强制真实 Relay fallback；报告不保存 token、端口、人格或正文。Relay stdout 与 worker SSE 状态事件拥有就绪时序，不用轮询服务状态。

这些目录可以有自己的运行脚本和 README，但不要把真实 token、QQ 号、Cookie、本机路径写进公开示例。

## 测试结构

当前后端测试集中在：

- `src/shared/gatewayConfigModel.test.ts`
- `src/manager/configRepository.test.ts`
- `src/routing/routeDecision.test.ts`

新增测试优先按 Interface 打：

- 配置规则：测 `gatewayConfigModel`。
- 配置文件读写：测 `ManagerConfigRepository`。
- 路由命中：测 `RouteDecision`。
- Agent prompt / replyContext：测 `AgentPacket`。
- 出站安全策略：测 `outbox`。

不要为了测试越过 Module Interface 去测内部 helper，除非 helper 本身已经是稳定 Interface。

## 常见修改入口

### 新增消息入口

优先新增：

```text
src/adapters/<name>Adapter.ts
```

然后在 `src/index.ts` 创建 Adapter，并在 `src/shared/gatewayConfigModel.ts` / WebGUI 类型中补配置类型。

不要把新平台逻辑塞进 `napcatAdapter.ts`。

### 新增处理端

优先新增或修改：

```text
src/agentAdapters/types.ts
src/agentAdapters/agentAdapter.ts
src/agentAdapters/<name>Adapter.ts
src/agentAdapters/managerApi.ts
```

处理端只接收 AgentPacket 生成的消息，不反向定义 RouteDecision。

### 修改路由规则

优先看：

```text
src/routing/routeDecision.ts
src/shared/gatewayConfigModel.ts
docs/routing-configuration.md
```

如果只是 prompt 文案或上下文包，不要改 RouteDecision。

### 修改 Agent 收到的消息格式

优先看：

```text
src/routing/agentPacket.ts
docs/agent-context-injection.md
docs/rabi-agent-interfaces.md
```

不要在 Adapter 里拼 prompt。

### 修改配置界面

优先看：

```text
ribiwebgui/src/stores/gatewayStore.ts
ribiwebgui/src/pages/RouteConfigPage.vue
ribiwebgui/src/types.ts
src/shared/gatewayConfigModel.ts
```

前后端共享的不变量要回到 shared model。

### 修改 manager 控制面

优先看：

```text
src/manager/controlPlaneRoutes.ts
src/manager/configRepository.ts
src/manager/runtimeRegistry.ts
src/manager/statusPayload.ts
src/agentAdapters/managerApi.ts
src/messageEndpoints/
```

新增大块能力时，先建专门 Module，再接到 `controlPlaneRoutes.ts`。

## 架构红线

- 不把 RabiRoute 做成完整 Agent OS。
- 不让 Agent Adapter 反向定义路由语义。
- 不把 prompt 模板写死在平台 Adapter 里。
- 不把 WebGUI 做成配置事实源。
- 不把所有 manager HTTP 逻辑重新堆回 `manager.ts`。
- 不让外部写入绕过 Outbox / Action Gate。
- 不把 NapCat、FenneNote、小爱等外部工具自身能力纳入 RabiRoute 控制面；RabiRoute 只管自己是否接收消息，以及自己是否允许 Agent 通过 RabiRoute 回传/代发。
- 不把运行期 `data/`、日志、token、真实账号写进仓库。
- 不混淆 OpenAI provider、Codex agent、Desktop IPC transport、Desktop task owner 和具体 model。
- 不为 Codex 实际消息增加独立 app-server、共享 4510 或其他备用投递路径。
- Codex 模型留空时由目标 Desktop 任务决定；Route 明确配置时只在 Desktop IPC 新轮次请求中传入。DSH 模型留空时由绑定会话决定；Route 明确配置时在主人格投递前通过 owner 的 `session.selectModel` 应用。

### 人格 Hook 配置与 Agent 埋点

`shared/agentHookAutomation.ts` 拥有事件、条件和消息端的定义与校验。规则结构为 `event`、AND 语义的 `conditions[]` 和 `destination.channel/gatewayId/params`；未知条件、事件和消息端失败关闭。当前事件为 `task_completed`，条件为 `project`、`bound_plan`、`include_sessions`、`exclude_sessions`（`sessions[]` 保存完整 ID 与显示名，按 ID 匹配，排除优先），消息端为 NapCat 群／私聊和语音。后续能力需在此合同与执行入口同时注册。

完成通知按任务 ID 读取 Codex 当前任务标题，读取不到时显示“未命名任务”，不回退到计划 `taskBinding.sessionTitle`，不输出项目路径或 sessionId。`bound_plan` 条件按当前人格已发布的计划目录核对 Codex `taskBinding.sessionId`。原 `projectPath/requireBoundPlan/groupId` 等平铺字段仅在配置边界迁移，保存后删除，不保留旧执行分支；保留集合字段 `codexHooks.completionDeliveries` 作为现有配置的稳定入口。NapCat 群迁移保持原 deliveryId，语音成功和失败也写入 Outbox 的投递身份，避免重放。

`codexHooks.completionDeliveries` 由人格持有项目完成消息规则。`agentCompletionDelivery.ts` 在 Stop 完成门禁通过后按项目匹配所有会话：Git 项目使用 common directory 归并工作树，普通目录使用真实绝对路径。发送复用 `agentSend` / Outbox 的持久回执和稳定 deliveryId；并发事件 single-flight，结果不确定时停止重发。DSH 事件显式携带 agentType，不触发 Codex 项目规则。

人格页自动化分为接收消息、定制任务、Agent Hook。`configRepository` 将 `codexHooks` 保存到人格 `personaConfig.json`；该字段沿用既有序列化名称，Codex 和 DSH 共用。旧 Route 字段在保存或显式迁移时移除。`agentAdapters/hookInstallation.ts` 通过 Agent 官方插件管理器安装埋点；`plugins/rabi-codex-context` 与 `plugins/rabi-dsh-context` 随构建进入 `dist/agent-hooks`，不在各 Agent 端维护人格业务规则。

## WebGUI 单路线保存

`gatewayStore` 拥有可编辑草稿与最近确认的配置基线，`gatewayDraft.ts` 比较语义值并执行三方合并（数组整体冲突）。单路线保存使用 `PUT /gateways/:id/config`，提交固定快照与全目录强 `If-Match`、`Idempotency-Key`。读取最新目录后只合并该路线的字段；事务入队后再次 CAS，因此读取与写入之间的并发变化仍会被拒绝。

Manager 复用 Route catalog worker 的 upsert、日志、回滚和持久化回执。指定原路线 ID 的 upsert 仅写目标适配器文件及其人格配置，重命名拒绝占用其他路线名称；人格共享字段由目标人格配置拥有。批量 `POST /gateways` 继续供明确的整目录管理调用使用，WebGUI 普通保存不再调用它。

`GET /gateways/mutations/:operationId` 经同一 worker 队列屏障完成恢复并读取回执，返回 `committed` 或 `not_committed`。进程未能安全结束或队列不可用时不宣称未提交。前端在同一页面内保存提交快照以接纳迟到确认，sessionStorage 仅保留旧 v2 操作元信息。成功回执更新基线，不覆盖后续编辑；运行应用错误独立返回。

计划可选 `messageChannels` 列表，Agent 可在创建计划或 PATCH 时绑定；省略或 `[]` 均合法，不阻断建计划、执行或人格事件投递。每项为 `{channel, gatewayId, params}`，复用事件投递的 NapCat 群／个人 QQ 与语音参数。计划渠道只用于绑定 Codex 任务的最终结果；与人格规则共同匹配，同一任务、轮次、目标去重。Hook 自动通知不要求原始群消息编号，也不被旧引用式进度通知的失败阻断；Agent 主动回复仍尽量引用来源。

消息投递的结构化数据、统一渲染和回执恢复归属见[模板架构](message-delivery-templates.md)。

## 电脑实例与 Agent 管理

`shared/agentInstance.ts` 定义电脑身份和 Agent 引用，`agentInstanceBindings` 把路由绑定到实例内 Agent，IP 不参与持久身份。`agentAdapters/instanceManagement.ts` 复用现有扫描、任务与 Hook 安装逻辑；本机直接调用，远端通过 `lanAgentRegistry.ts` 的连接所有权校验 RPC 调用。`apps/rabi-agent` 持有远端私有配置，WebGUI 的 `InstanceAgentSettings.vue` 复用基本管理界面。能力范围与尚未完成的高级功能对等见[接入说明](lan-rabi-agent-bootstrap.md)。
