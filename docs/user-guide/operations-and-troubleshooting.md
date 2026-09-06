<!-- docs-language-switch -->
<div align="center">
<a href="./operations-and-troubleshooting_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 运行、日志与排障

排障时不要把“消息没回复”当成一个整体问题。沿着消息链逐段确认，就能判断故障在平台、规则、投递还是回传。

```text
消息端 -> 事件记录 -> 规则命中 -> AgentPacket -> 处理端 -> Outbox / 外部平台
```

## 先看诊断摘要

打开“日志诊断”。“诊断摘要”会把当前能识别的连接和配置断点放在最前面。

摘要显示“链路正常”只表示没有发现已知断点。如果消息仍未到达，继续检查下方连接详情和最近日志。

![日志诊断页先显示诊断摘要，再显示运行状态、消息端和处理端状态](../../assets/screenshots/webgui-diagnostics-zh.png)

图中的文档示例没有启动，也没有绑定真实 Desktop 任务，因此状态卡明确显示“禁用中”和“未绑定”。排障时应先处理这类可见断点，再查看更下方的连接详情和最近日志。

## 用证据判断停在哪一段

| 已有证据 | 说明 | 下一步 |
| --- | --- | --- |
| 没有消息记录 | 事件没有进入 RabiRoute | 查平台登录、连接、端口和输入 policy |
| 有消息记录，没有 `agent-packets.jsonl` | 消息进入但规则没命中 | 查人格绑定、`configName`、route kind 和 regex |
| 有 AgentPacket，Desktop 没消息 | 处理端投递失败 | 查任务 ID、工作目录、Desktop IPC 和最后错误 |
| Desktop 有结果，平台没回复 | 回传没有完成 | 查 replyContext、pipeline、输出 policy 和 Outbox 日志 |
| Outbox 为 `blocked` | policy 或目标不允许外发 | 修正明确目标或授权，不要绕过安全门 |
| Outbox 为 `failed` | 已尝试发送但平台调用失败 | 修复平台状态后明确重试 |

常见运行文件位于 `data/route/<配置名>/`。不要把运行期 JSONL、真实消息和账号信息提交到仓库。

## 手动触发的用途与副作用

“手动触发”可以执行 `manual_trigger` 或 `heartbeat` 规则，用来验证规则到处理端的链路。

它会：

- 写手动触发和路由日志。
- 构造真实 AgentPacket。
- 向处理端开始真实投递。
- 在处理端执行时使用该任务自己的权限。

它不会模拟外部 QQ 消息，也不是无副作用预览。验证群消息 regex 时，仍要使用受控的真实测试消息或检查 RouteDecision 证据。

## 最近日志怎么看

“最近日志”显示当前 Route 的最近 gateway 输出。先找最新时间，再看第一条错误，不要被旧启动周期的历史错误误导。


升级代码后如果仍看到旧行为，重新构建并重启 Manager 与 Route，再核对启动目录和 `dist/` 时间。历史日志可以保留，但不能代表本次运行状态。

## 数据变动日志

Manager 和 Gateway 会把配置、计划、记忆、消息记录、发送回执、身份、语音、健康记录、附件及运行状态等数据变动写入 `logs/manager/manager-operations-YYYY-MM-DD.jsonl`。每条记录都包含 `group`、`owner`、`action`、`target`、`dataSource` 和 `outcome`；同一个 HTTP 请求还会带 `traceId` 与 `requestId`，可用来串起“开始、提交、拒绝或失败”。日志只记录业务 ID、字段名、摘要、数量和结果，不写消息正文、凭据、健康测量值或媒体内容。

`GET /meta` 的 `operationalLog` 会报告 `healthy` 或 `degraded`、待写条数和最后一次写入错误。写盘失败时，记录会留在内存中按退避重试，同时 Manager 健康诊断会显示降级；业务写入的返回结果不由日志成败决定。

默认保留 30 天，历史分片总量上限为 512 MiB。运维人员可以在启动环境中调整：

- `RABIROUTE_OPERATION_LOG_RETENTION_DAYS`：保留天数。
- `RABIROUTE_OPERATION_LOG_MAX_BYTES`：历史日志总字节上限。
- `RABIROUTE_OPERATION_LOG_GROUPS`：逗号分隔的记录分组白名单。
- `RABIROUTE_DIAGNOSTIC_LOG_GROUPS`：为指定分组增加调用栈，只在定位调用来源时短时启用。

## NapCat 打开后显示 Unauthorized 或 Token 登录页

从 Route 页点击“打开 NapCat”时，RabiRoute 会直接打开带当前 WebUI token 的 `/web_login` 地址。这个入口会重新建立 WebUI 会话，避免 NapCat 重启后旧标签页残留的凭据继续触发 `Unauthorized`。

如果仍停在空 Token 登录页，先关闭旧 NapCat 标签页，再从当前 QQ 实例卡片重新点击“打开 NapCat”。确认实例卡片已保存 WebUI 登录密钥；升级过源码但仍打开旧地址时，需要重新构建并重启 Manager。快速启动只检查 OneBot / WebUI 是否可用，不再同步等待 Windows 全量进程枚举；完整进程列表仍可在显式健康检查和详情中读取。

## NapCat 已连接但没有 AgentPacket

先确认 `group-messages.jsonl` 或 `private-messages.jsonl` 是否出现新记录。

- 没有记录：查 QQ 登录、WebSocket Client、端口和接收 policy。
- 有记录：查人格规则的 `configName`、route kind、目标群和 regex。
- 合并转发只有 ID：查 OneBot HTTP 和 `get_forward_msg`。

## NapCat 能收不能发

OneBot HTTP 可访问不代表 QQ 核心一定能发送。检查登录状态、quick login、设备验证、Windows 时间和 NapCat 日志。

## 消息端扫描超时或显示“部分可用”

`GET /api/scan/message-adapters` 是纯只读诊断：不会启动 Route/NapCat、不会补写配置、不会触发扫码或自动修复。所有独立探针并行起跑并受共享截止时间约束；响应中的 `scan.partial=true` 表示至少一个探针超时或失败，其他已完成结果仍然可信。

状态按入口和实例分别解释。`QQ 可用` 以 OneBot 健康为准，不能用 WebUI 可打开替代；个人微信未登录只影响个人微信。业务健康巡检把单一消息端错误汇总为 `degraded`，只有 Manager、Route 或 Agent 投递等系统级错误才把整轮巡检标为 `error`。它只报告业务状态，不拥有应用生命周期。

Outbox 发送失败会保留 `failed` 和 draft 数据。当前没有通用自动重试队列；修复登录后需要明确重试，避免重复发送。

## Codex 没收到消息

按顺序检查：

1. Desktop 已打开并能进入目标任务。
2. Agent 扫描能看到该任务和工作目录。
3. 保存的任务 ID 仍存在，本轮工作目录仍在允许范围内。
4. 日志诊断显示投递协议为 `desktop-ipc`。
5. `no-client-found` 自动唤醒后是否仍失败。

不要用固定 4510、`CODEX_APP_SERVER_WS_URL` 或独立 stdio Runtime 修复真实投递；这些不是当前主链。

## RabiRoute Desktop 界面未显示

Windows 安装版只由 `RabiRouteHost.exe` 创建 Manager 与 Desktop。先从开始菜单重新打开 RabiRoute，或直接运行安装目录里的 `RabiRouteHost.exe`；第二次启动只向现有 Host 提交激活请求，不会直接拉起托盘。

查询同一代的真实状态：

```powershell
& "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command status --json
```

`state=running` 时应同时包含 `applicationGenerationId`、`managerInstanceId`、`managerBaseUrl` 和 Manager PID。再打开 `managerBaseUrl/meta`，核对 generation、instance 和 URL。Host 只有在 Manager READY 身份全部匹配后才启动 Desktop；Desktop 再次发现身份不匹配时会退出，由 Host 重建完整 generation。

若 Host 已熔断或仍未出现 Desktop，检查 `%LOCALAPPDATA%\RabiRoute\diagnostics\host\host-YYYYMMDD.log` 和最新 Desktop 证据包。不要单独运行 `main.py`、扫描端口、循环拉起托盘，或恢复退役生命周期入口。

页面切换后如果内容在 12 秒内没有加载出来，RibiWebGUI 会显示“页面加载失败”。点击“重试当前页面”会重新打开相同路径和访问参数。旧页面资源失效时，界面会先自动刷新一次；仍失败再手动重试。

## Manager 地址变化或端口已占用

RabiRoute 不依赖固定 Manager 端口。Manager 每一代都向操作系统申请可用端口，因此其他软件占用某个端口不会阻止启动，也不需要终止未知端口 owner。

重启后旧书签、旧命令行或旧浏览器标签可能仍指向上一代 URL。用 Host `status --json` 取得本代 `managerBaseUrl`，或直接从托盘重新打开 WebGUI；不要从旧端口是否响应推断当前实例。Host 会用 application generation、Manager instance 和 PID 绑定 READY，而不是靠端口占用判断 owner。

恢复后分别验证：本机或局域网 `/meta` 可用；Relay 状态可在稍后恢复为在线；远程 `/api/events` 与 `/api/speech/events` 可重连；媒体 `Range` 请求仍返回 `206`。Relay 暂时离线时，本机和局域网仍应可用，不需要反复重启 Manager。

远程 WebGUI 无法联系对应 PC Manager 时，API 会返回结构化 `RABI_PC_WEBGUI_UNAVAILABLE`，等待超时则返回 `RABI_PC_WEBGUI_TIMEOUT`；响应同时包含 `retryable`、`Retry-After` 和诊断请求 ID。浏览器页面会显示相同诊断 ID，而不是空白或静默 502。用该 ID 对照 Relay 日志，再检查 PC 的 `/meta` 与 Manager 日志；不要把 502 当成成功或立即重复写请求。

如果计划页提交审批意见时正好遇到 Manager 重启或短暂断网，页面会明确提示无法连接，并保留本次文字、附件和同一条幂等 `feedbackId`。先确认页面右上角恢复为“Manager 已连接”或 `/meta` 已响应，再直接重试；不要因为看到旧版浏览器错误 `Failed to fetch` 而重新输入或重复创建另一条审批意见。

## 人格正文不可用

人格配置显示 `Persona file is unavailable.` 时，先确认所选人格文件仍能读取。若语音页能列出人格，而路由的人格下拉框为空，可能是旧版本未把人格目录快照传给页面诊断子进程；更新到修复版本后，从托盘重新打开 WebGUI 核对正文与头像，无需重建人格文件。诊断子进程使用同一份已提交人格快照，不在页面请求中重新扫描共享目录。

## 计划状态加载失败

`PLAN_STATUS_CONFIG_INVALID` 也可能是启动迁移受阻，并不一定缺少人格状态配置。先核对人格的 `legacyAliases` 和 `/meta` 的 `planStorageStartup`；若已有别名但迁移失败，查看本机 Manager 日志中的具体失败原因。旧版本在 NAS 上覆盖旧计划锁可能返回 `EPERM`，使缺失历史补齐和后续状态转换停住。修复版本在回收隔离期间保留旧锁，通过空闲名称和排他发布接管；续租或并发竞争会中止接管并保留恢复证据。

升级前备份相关计划资料，由完整 Host 启动的 Manager 执行恢复。等待 `planStorageStartup.state=ready`，再验证当前与已归档计划列表；不要通过清空计划、删除锁目录或直接改写状态来掩盖迁移失败。

## 何时重启

适合重启的情况：

- 刚完成新构建。
- 外部连接配置变化，或调用者需要重新读取动态 Manager URL。
- Route 子进程退出。
- 日志证明运行的是旧产物。

规则、人格或普通表单改动应先保存。不要把重启当成保存，也不要在没有证据时反复重启外部平台。

## 反馈问题前准备

收集这些信息即可，不要上传整个运行目录：

- RabiRoute 版本和启动方式。
- 操作系统、Node.js 版本。
- Route 使用的消息端与处理端。
- 复现步骤和预期结果。
- 本次启动后的最小相关日志。
- 已脱敏的状态截图。

更多模板见[常见问题与获得帮助](faq-and-support.md)。
