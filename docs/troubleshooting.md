<!-- docs-language-switch -->
<div align="center">
<a href="./troubleshooting_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 排障

## Manager 短暂降级

在 `logs/manager/manager-operations-YYYY-MM-DD.jsonl` 搜索 `manager_watch_degraded` 和 `manager_watch_recovered`。`source=config` 表示配置目录监控，`source=plugin_tree` 表示插件目录监控。每条记录包含子进程 PID、扫描次数、耗时、超时上限、累计超时和重启次数、最近成功时间；异常记录还包含经过脱敏的具体错误与堆栈。相同状态的普通刷新不重复记录，恢复后旧异常仍保留在日志中。通过 `operationId` 对应同一 Manager 实例、监控模块和扫描尝试。

先从 Host 重新获取当前 Manager 地址，再读取 `/meta` 判断当前状态；历史超时次数不表示此刻仍在降级。

> 状态：现行指南。Codex 正式链路是 Desktop IPC 与目标任务 owner；真实消息不使用共享 4510、每 route stdio 或备用 Runtime。

## QQ 合并转发只显示转发 ID 或 `[object Object]`

新版 RabiRoute 收到 NapCat 的 `forward` 消息段或 `[CQ:forward,...]` 后，会使用当前 NapCat 实例的 OneBot HTTP Server 调用 `get_forward_msg`。查询成功后：

- 外层原始消息保存在 `originalRawMessage`。
- 展开的聊天内容写入 `rawMessage`，因此历史搜索、最近消息和 AgentPacket 都能直接看到。
- 结构化节点写入 `forwardedMessages`，包含转发 ID、发送者、时间、消息 ID和规范化文本/媒体标记。
- 图片、视频、语音和文件会保留类型、文件名、摘要或 URL；能否进一步下载仍取决于 NapCat 返回字段和 URL 有效期。

查询失败时，外层消息仍会正常落盘，并在 `napcat-adapter.log.jsonl` 写入 `forward_message_resolve_error`。排查顺序：

1. 确认当前路由的 NapCat HTTP Server 在线且端口正确。
2. 确认 OneBot `get_forward_msg` 对该转发 ID 返回成功。
3. 检查转发记录是否已过期，或是否来自当前 QQ 无权读取的会话。
4. 查看 `forward_message_resolved` 日志中的转发 ID和节点数量。

## NapCat 已连接，但处理端没有收到消息

先看 `data/route/<配置名>/`：

- 有 `group-messages.jsonl` 或 `private-messages.jsonl`：说明 QQ 到 RabiRoute 已通。
- 有 `agent-packets.jsonl`：说明路由规则已命中并构造了 AgentPacket。
- 没有投递记录：检查人格 `personaConfig.json` 是否存在启用的消息触发 `automationRules`，再检查 `trigger.routeKinds`、`trigger.regex` 和目标群过滤。

## `send_group_msg` 报 `EventChecker Failed` / `1006514`

不要只看 `get_status` 返回 `online` 或 `good`。这类情况下 OneBot HTTP 可能仍能响应，但 QQ 内核在 `sendMsg` 阶段已经外发失败，常见表现是 NapCat 日志里出现：

```text
EventChecker Failed
retcode=1006514
网络连接异常
```

排查顺序：

1. 查 NapCat/QQ 日志里的 quick login 和二维码登录状态；如果 quick login 失败，通常需要重新扫码登录。
2. 如果 NapCat 启动日志提示本地时间和 ServerTime 有偏差，先同步 Windows 系统时间，再重启 NapCat/QQ。
3. 重启 NapCat/QQ 后重新扫码登录，再测 OneBot HTTP、RabiRoute WebSocket 和 `send_group_msg`。
4. RabiRoute 侧看 `data/route/<配置名>/gateway-status.json`、`group-messages.jsonl` 和 `agent-packets.jsonl`，区分“能收不能发”和“路由没有命中”。

如果目标是无值守登录，不要把 QQ 密码写进 RabiRoute 配置。用 NapCat WebUI 和 NapCat Shell 支持的 Windows 环境变量配置，详见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

当前版本会把 OneBot `retcode` 非 0 视为失败，在 Outbox 结果和日志中保留 draft 数据，但不会自动进入持久化补发队列。修复登录态后需要由用户或上层流程重新提交；通用 Action Queue / 自动补发仍属于后续演进。成功补发后应记录 NapCat 返回的 `message_id`。

## 中文消息乱码或多行发送异常

在 Windows 上，如果用 PowerShell `Invoke-WebRequest` 直接发送中文 JSON 到 OneBot HTTP，实际请求编码可能没有稳定按 UTF-8 发送，表现为 QQ 收到乱码，或多行消息内容异常。

推荐做法：

1. 用项目内 Node 脚本发送 OneBot HTTP 请求。
2. 脚本会显式设置 `Content-Type: application/json; charset=utf-8`。
3. 脚本会用 `JSON.stringify` 生成正文，不手工拼接中文 JSON 字符串。

示例：

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "中文测试\n第二行"
```

如果 `data/route` 或 `data/roles` 下的 JSON reload 失败，或 WebUI 保存后配置异常，也检查是否误写入了字面量 `\n`：

```powershell
npm run check:config
```

- JSON 文件末尾不应该多出可见的 `\n` 字符。
- 如果文件带 UTF-8 BOM，部分工具可能解析失败；`npm run check:config` 会提示并按去 BOM 后的内容检查。
- WebUI 文本框里的模板应使用真实换行，不要输入字面量 `\n`。
- 保存成 JSON 时，只允许由编辑器或序列化器按 JSON 格式转义一次。

## Codex 没有收到投递

当前正式链路是 `RabiRoute -> Codex Desktop IPC -> Desktop 任务 owner`。消息成功后应出现在目标任务里。按下面顺序检查：

1. 打开 Codex/ChatGPT Desktop，确认它本身能正常进入任务；RabiRoute 不负责启动或停止 Desktop Runtime。
2. 在 RibiWebGUI 重新扫描 Codex。任务下拉应显示未归档任务的“任务名 + 最后会话时间”，不显示内部 ID。
3. 检查 route 保存的 `codexThreadId` 和 `codexCwd`。有效 ID 会直接复用，`codexCwd` 决定本轮执行目录；任务保存的默认 cwd 不同、Desktop 改名、SQLite 标题滞后、展示标题超过 240 或 goal 完成都不会创建新任务。
4. 只有 ID 被明确清空、非法或确实不存在时才按 `codexThreadName + codexCwd` 查找；不要因 SQLite `title` 变成首条 prompt 就让有效 ID 失效。多个同名同目录任务自动绑定最后更新时间唯一最新者。保存 ID 指向已归档任务时，下一次真实投递或保存会创建新任务并更新绑定，不复用其它同名任务。新建时，超过 240 的任务名会安全截断并保存实际名称。
5. 检查 `agent-packets.jsonl`、`gateway-status.json` 和 Manager 日志，区分“路由未命中”“Desktop IPC 未就绪”“任务 owner 未加载”“任务 ID 失效”和“本轮目录不在允许范围”。
6. 若错误含 `no-client-found`，RabiRoute 会用 `codex://threads/<id>` 打开目标任务并短暂重试；重试后精确 ID 已无法从本地状态读取时，会创建替代任务并投递本次消息；如果请求来自计划任务，同时更新原计划绑定并返回警告。任务仍存在时不会切换到后台 Runtime，也不会新建任务。

不要设置 `CODEX_APP_SERVER_WS_URL` 或固定 4510 端口来修复投递；它们不是 RabiRoute 的真实消息 transport。

## `Missing monitorThreadId` / 找不到固定线程

这表示当前绑定不存在、ID 已失效，或本轮 `codexCwd` 不在允许范围。任务保存的默认 cwd 与 `codexCwd` 不同本身不是错误。检查：

- `codexThreadId` 是否仍存在；有效 ID 是稳定身份，不要求 SQLite 索引标题与 Desktop 显示名同步。
- `codexCwd` 是否已经移动、指向另一个项目，或含有无法规范化的路径差异。
- 任务是否已经归档、删除，或来自另一个账号 / `CODEX_HOME`；已归档固定任务会在真实投递时新建并更新绑定，删除或账号不一致仍需重新选择。
- 需要改绑时应从下拉选择另一任务，或输入新名称让前端明确清空旧 ID；不要手工把名称写入 ID 字段。

## Agent 回合里没有 `codex_app__*` 线程工具

RabiRoute 的投递健康与目标 Desktop 任务是否注册 `codex_app__*` 管理工具是两件事。当前回合没有这些工具时，反复修改提示词不会让工具出现。

后台 Agent 应调用本机线程桥：

```http
POST <managerBaseUrl>/api/agent/threads
```

支持 `list`、`read`、`resolve`、`create`、`send`。详细请求见 `docs/rabi-agent-interfaces.md`。该接口读取 Desktop 任务状态，创建时只做空任务 bootstrap，真实消息仍交给 Desktop owner；不要用 multi-agent 子 Agent 冒充正式任务。

不要为了消除报错在 ChatGPT desktop 里反复创建同名线程，这会增加歧义。

## 升级后 UI 仍显示旧投递错误

这通常说明后台仍在运行升级前的 Manager 或 gateway，而不是当前源码仍依赖旧链路：

1. 重新构建并重启 manager 与对应 gateway，确认没有旧 Node 进程仍在运行旧产物。
2. 区分历史 JSONL / stderr 记录和本次启动的新记录；旧日志可以保留用于审计，不要把它当成本次状态。
3. 以本次启动生成的 Agent 状态为准；`lastDeliveryChannel` 应为 `desktop-ipc`。

如果全新启动仍产生这些错误，说明实际运行的仍是旧构建，应先核对启动目录和 `dist/` 生成时间，而不是继续修桌面应用。

## Codex 模型或工具与预期不一致

- RabiRoute 不覆盖 Desktop 任务的模型、工具、沙箱或审批；`agentModel` 只是旧配置兼容字段。
- 在目标 Desktop 任务中调整模型或权限，再重新投递。
- 如果消息出现在另一个任务，重新选择下拉项并检查 `codexCwd`；不要用任务名代替完整 ID。

## Codex 审批请求被拒绝或 turn 停止

命令、文件、网络或工具权限由目标 Desktop 任务处理。先确认任务是否确实需要超出工作区写入或联网，再在 Desktop 中明确授权。Desktop 任务审批只管 Agent 执行权限，不等于允许 RabiRoute 向 QQ、文档、设备或其它外部系统写入；这些动作仍需经过 Outbox / Action Gate。

## 普通群消息没有转发

普通群消息默认不会无条件转发。需要添加 `group_message` 规则，并填写合适的 `regex`，例如：

```text
需求|报错|构建失败|提醒|记一下
```
