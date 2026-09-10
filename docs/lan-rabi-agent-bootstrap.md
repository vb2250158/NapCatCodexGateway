<!-- docs-language-switch -->
<div align="center">简体中文 | <a href="./lan-rabi-agent-bootstrap_en.md">English</a></div>
<!-- /docs-language-switch -->

# 远端 Agent 接入与更新

> 状态：实验集成。接入提示词、下载与签名校验、本机与远端实例目录、多个 Agent、稳定路由绑定和共用管理操作已实现。真实双机安装和宿主运行验收待完成。

## 用户只需三步

1. 打开 **远端 Agent** 页面（`#/lan-agents`），点击 **复制接入提示词**。页面使用当前 Manager 的局域网地址和发布公钥指纹；本机回环地址会替换为当前局域网地址。Manager 须先启用局域网访问。
2. 启动目标电脑上的 Codex 或 DSH，把提示词粘贴到想接收消息的任务里。该 Agent 检查 Node.js 22.13+、发现当前任务与工作目录，下载并验证接入程序，保存私有配置，注册登录启动项并启动后台连接。不需要安装完整 RabiRoute，也不需要手填任务 ID。
3. 回到当前路由的 **消息适配器 → 添加 AGENT**，选择 **远端Agent(<IP地址>)** 并保存。没有节点时，菜单引导进入接入页面；已接入节点使用 Manager 观察到的连接 IP 展示，保存的稳定身份是 instanceId + agentId。

本机与远端电脑统一为实例，页面采用 **实例 → Agent** 两层折叠。本机默认出现，无需接入安装。远端实例显示 **远端Agent(<IP地址>)**，内部可管理多个 Agent；Codex/DSH 是执行能力，不再是两种远端实例。IP 改变不会修改路由身份。

实例内共用配置界面包含名称、开关、工作目录、任务名称与 ID、模型、推理强度、环境扫描、打开任务和 Hook 安装。扫描由用户显式刷新触发。人格自动化中的 Hook 策略仍由当前 Manager 管理。

提示词含连接密钥，只能粘贴到目标电脑的私密任务中。不要把密钥写入仓库、群聊、日志、截图或命令历史。复制使用安全剪贴板或页面回退，支持局域网 HTTP。

## 数据与执行边界

| 对象 | 唯一拥有者 | 行为与验收 |
| --- | --- | --- |
| 节点、IP、连接和任务状态 | Manager 的节点注册表 | HTTP 管理操作与 WebSocket 连接都显式鉴权；离线投递失败。 |
| 路由绑定 | 路由配置的 `agentInstanceBindings[provider]` | 界面保存 `instanceId + agentId` 引用，不保存第二套连接凭据；Gateway 从本代 Manager 获得地址与凭据。 |
| 任务、模型、工具和权限 | 远端现有 Codex/DSH 宿主 | 实例保存各 Agent 的任务绑定，不新建备用 Runtime，不改变宿主启动配置；Manager 缺席时宿主仍独立运行。 |
| 后台连接进程 | 当前用户的 Rabi Agent | 主动连接 Manager；管理下载、校验、登录启动和更新。 |
| 真实消息路径 | 路由 → Agent adapter → Manager 节点注册表 → 远端进程 → 已绑定任务 | Codex 走 Desktop IPC；DSH 走本机 `session.prompt`，`mode=queue`。两者分别只有一条执行路径。 |

Codex owner 不可用时失败，不使用 `codex app-server`。DSH API 或绑定不可用时失败，不回退到 Codex。Codex 当前任务忙时明确拒绝新投递，避免覆盖任务关联；已接受的重复任务不重复执行。

节点在线只表示远端进程已连接。任务记录分别显示传送、领取、处理中、完成或失败。DSH 当前只回传队列接受状态，实际回复在其绑定会话查看；Codex 完成状态来自 Desktop 广播，回复在对应任务查看。本机图片路径不会直接发送到另一台电脑。完整计划助手、消息处理池与远端人格文件同步的能力对齐仍需继续验证；不能据此宣称所有本地高级功能已完整迁移。

## 安装与发布

| 平台 | 私有目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/RabiAgent/` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

提示词由 WebGUI 的统一模板生成，不再手工拼接文档里的第二份模板。它携带完整 Manager URL、现有局域网 Token 和固定发布公钥 SHA-256。资源清单使用 Ed25519 签名；逐个文件验证 SHA-256 和大小，拒绝越界路径和跨源下载。签名密钥位于 Manager 私有数据中，升级须保留；轮换须重新分发可信指纹。

接入进程变量：`RABI_MANAGER_URL`、`RABI_LAN_LINK_TOKEN`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS`、`RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。Codex 使用 `RABI_AGENT_TYPE=codex-desktop` 和 `RABI_AGENT_CODEX_THREAD_ID`；DSH 使用 `RABI_AGENT_TYPE=dsh`、`RABI_AGENT_DSH_URL`、`RABI_AGENT_DSH_SESSION_ID`。这些值由远端 Agent 发现并写入私有配置，不要求用户输入。

`node rabi-agent.mjs --bootstrap` 是常驻进程，应隐藏并脱离安装终端运行。首次接入后刷新节点页面。在线节点可请求更新；程序自行下载、校验并切换，30 秒内未连回则保留原版本。Manager 地址变更后应重新复制当前提示词更新连接，不猜端口。

## 实例身份与管理

本机 instanceId 持久保存在 Manager 私有目录的 `agent-instance-id.json`；远端 instanceId 沿用连接程序私有 `nodeId`。远端原有单任务配置读取时映射为 `agentId=default`，新增 Agent 使用 UUID。Agent 配置由执行电脑持有，Manager 保存目录投影；本机 Agent 继续以原有路由配置为事实源，保存经过原有并发版本检查。

本机与远端共用 `instanceManagement.ts` 的扫描、任务与 Hook 安装逻辑。远端通过有请求 ID 和连接所有权校验的 WebSocket RPC 调用；断线立即失败，超时后必须先刷新再决定是否重试。Hook 通过已注册 Agent 的会话 ID 校验，使用隔离的实例身份关联当前 Manager 人格。

实例中的“路由与完整 Agent 设置”进入同一消息适配器页面，包含消息处理、独立记忆整理与计划协助设置。消息处理池和记忆整理按 `instanceId + agentId + 主任务 ID` 隔离持久状态；切换电脑或重绑主任务后不会复用旧电脑的工作任务。创建或解析出的协助任务登记到所属 Agent，Manager 后续按归属分派；离线和身份歧义会失败，不降级到本机。

安装版从当前不可变版本包读取接入程序、共用管理运行库和 Hook 包，签名密钥仍保存在私有数据目录。再次粘贴接入提示词更新连接时保留原实例 ID、Agent 目录和已允许的工作目录。已绑定的本机任务关闭后仍保留在实例中，可以重新开启；远端绑定占用同一路由处理端时，应先在路由设置中切回本机。

## API

- `GET /api/lan-agent/releases/manifest` 与 `GET /api/lan-agent/releases/<version>/node/<assetPath>`：发布清单与文件。
- `GET /api/lan-agent/nodes`：连接状态、发布信息与最近任务。
- `GET /api/lan-agent/instances`：本机和远端实例及其 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents`：添加 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents/<agentId>/<operation>`：`configure`、`scan`、`threads`、`hooks`、`context`、`tasks`。
- `POST /api/lan-agent/nodes/<nodeId>/tasks`：投递；省略 `targetAgent` 时采用节点声明的宿主。使用 `idempotencyKey` 去重。
- `POST /api/lan-agent/nodes/<nodeId>/update`：更新请求。
- `WS /api/lan-agent/connect`：`authenticate → authenticated → hello → connected → heartbeat`。

保留 `lan-agent` 连接和发布 API 路径供现有安装更新；未发布的 `lanAgent` 特殊处理端类型与 `lanAgentNodeId` 配置已移除，路由统一使用实例绑定，用户入口统一称为远端 Agent。旧 Remote Agent v3 是独立实验协议，不作为本次 Agent 端的投递路径或安装依赖；其迁移不在本次范围。

## 剩余实机验收

- 两台电脑首次安装、Token 撤销、断网恢复和登录启动。
- Codex/DSH 现有任务连续消息、宿主缺席和真实回复可见性。
- Windows、macOS、Linux 启动项和更新失败恢复。
## 能力范围

当前实现统一了实例身份、目录、Agent 管理界面与远端操作传输；实例内可以进入其绑定路由的共用完整设置。高级任务的实例分派、状态隔离与 Hook 归属已有代码和本机契约测试，真实远端宿主中的计划回传、消息处理看板和完整工作流仍须逐项验收。节点在线和本机协议夹具通过不代表真实双机或所有高级能力对等验收完成。
