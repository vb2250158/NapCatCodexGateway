<!-- docs-language-switch -->
<div align="center">
<a href="./agent-context-injection_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent 上下文注入说明

> 状态：现行指南。已按 `src/routing/agentPacket.ts`、角色知识实现和路由测试核对。

本文面向配置 RabiRoute 的用户，说明 RabiRoute 投递消息给 Agent 时，会自动向消息上下文中注入哪些内容，以及最终建议格式。

上下文注入的目标是让 Agent 快速知道“这条消息从哪里来、当前角色是谁、可以关注哪些计划和记忆、有哪些 Rabi 接口可用”。它不负责把所有历史、所有计划或所有记忆全文塞进 prompt。

消息模板应该尽量薄。RabiRoute 负责自动包装事件信息、角色路径、计划/记忆索引、日志路径和接口文档链接；用户配置的 route 模板只需要写少量补充要求，甚至可以为空。

Agent 自己需要看的接口说明是 [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)。本文件主要帮助用户理解“为什么模板不用写很多”和“最终发给 Agent 的消息大概长什么样”。

## 统一触发管线

上下文不再由各个入口分别调用角色知识。所有入口先转换成标准触发，再进入 `RabiContextManager`：

```text
Codex SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
RabiRoute QQ / Webhook / 语音 / 手动触发 / 心跳消息投递
Manager 或 UI 预览
  -> 标准 ContextTrigger
  -> RabiContextManager
  -> roleKnowledgeSnapshot + 统一生命周期策略
  -> RoleKnowledgeContextView
  -> Codex additionalContext 或 AgentPacket
```

入口适配器只提供角色、消息或工具信号、session/turn/event 身份和来源；它们不决定关键词得分、计划归档、记忆活跃窗口或 `viewedAt`。入口默认使用聚焦上下文，推理期触发只注入本轮新增的相关必读项，预览则禁止产生知识副作用。

## 注入原则

默认注入只放轻量信息：

- 当前事件的必要信息；跨人格消息还会带来源/目标人格、两端 Route、会话关联、被回复消息和当前跳数。
- QQ 消息里的 CQ reply / at 代码解析；引用链会按消息记录递归展开，at 映射集中显示。
- 当前人格、逻辑消息端和会话下，由 `recentMessageLimits` 允许的最近双向消息；当前事件自身不会再在窗口中重复。`heartbeat` 与独立 `plan_feedback` 事件是固定例外，不读取或注入历史消息。
- 角色和路由路径，以及精简人格核心指令。
- Agent 需要关注的接口文档链接，以及查询可联系人格和显式跨人格投递的简短提示。
- 当前输入高相关的少量计划、记忆和技能摘要，默认最多 3 项。
- 全量计划、记忆和技能的按需查询路径。

默认不注入：

- 全量聊天记录。
- 全量计划详情。
- 近期记忆全文。
- 沉淀记忆全文。
- 无关的当前计划、近期记忆和技能索引。
- 诊断详情。

Agent 需要更多内容时，应根据上下文里的路径、ID 或接口文档按需查询。

## 身份关系上下文

群聊里的显示名、群主/管理员标记、当前 Route、当前工作目录和关键词相似度都不能单独说明“谁是谁”或“这是谁负责的项目”。人格可维护独立的身份关系记忆；消息投递时，RabiRoute 只按 `platform + endpointIdentityNamespace + senderStableId` 精确查找当前账号。Route 配置 ID 只记录投递来源，不参与身份键；NapCat 有机器人 QQ 号时优先用它作为消息端命名空间，实例名只在缺少该标识时回退使用。企业微信、飞书和微信只有在消息记录带有稳定的消息端命名空间时才查询；缺少该标识时宁可不匹配，也不把不同账号下的同名 ID 合并。因此同一个账号换 Route 不会被拆成不同的人，也不会把两个消息端误当成一个账号。

第一次命中一个稳定但陌生的账号时，系统会自动创建一个独立的“待认识”候选参与者；同一稳定账号以后复用这条候选。显示名只作为候选别名。处理 Agent 发现明确自述、新称呼或可核对的关系时，可以通过候选观察接口追加最小证据；没有新线索时不重复写入。`[身份关系]` 只注入当前账号、已确认参与者、候选参与者、当前群或项目范围内的关系卡，以及尚未解决的冲突。追加事件在多台电脑同步后若形成并发分支，会明确标为冲突；冲突记录不能自动确认身份，需由人格提交一次完整修正来收敛。它不复制聊天正文，也不进入计划/近期记忆的关键词召回和回调流程。候选映射只能用于核对；不能据此称呼真人、授予权限、推断项目归属，或把讨论变成当前项目的计划。

身份关系只回答“谁在说话、已有何种已确认或候选关系”。随后会生成一条 `[情景记录]`：它只读取已经适用于当前会话的项目关系卡，把项目列为讨论线索；不会从 Route、当前工作目录、昵称或关键词推断项目。情景记录明确允许 Agent 自然参与有价值的讨论、澄清问题或提出建议，但默认禁止据此查询、创建、更新或转交项目计划、任务和长期项目记忆。只有另外拿到明确的项目范围、请求和授权，处理端才可以进入项目管理或执行流程。

当这份 AgentPacket 进入实际投递链路后，RabiRoute 会在当前人格下保存一份不含聊天正文的情景记录。记录只保留会话键、消息 ID、路由、身份/项目线索、未解决证据和“可参与 / 不可管理”的判断；人格页可回看最近记录，供人工发现误判。它不改变发送结果，也不自动写计划、任务或记忆；每个人格最多保留最近 200 条。情景记录是可从原始会话和关系卡重建的派生物，不参加多电脑人格同步；原始聊天记录仍以统一会话记录为准。

## 统一双向会话账本

最近消息不再从 `group-messages.jsonl`、`voice-transcripts.jsonl`、`wecom-messages.jsonl` 等分散文件各自拼一份单向摘要。它们仍保留为协议审计和兼容证据；Agent 自动上下文的真源是人格目录下的统一账本：

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

账本记录双向消息，包括 QQ 自身回复、ASR/TTS、WeCom、Remote Agent、Role Panel、RabiLink 及其他已接入消息端。每条记录区分逻辑 `adapter`、物理 `transport`、方向、说话人、会话、状态和安全附件元数据；不把私有绝对路径写进附件记录。

自动注入有三个同时必须满足的范围：

1. 当前绑定人格。
2. 当前逻辑消息端，例如 `napcat`、`speech`、`wecom` 或 `remoteAgent`。
3. 当前会话，例如 QQ 群/私聊对话、WeCom chat 或语音 `sessionId`。

入站和出站合计占用同一条数额度。`personaConfig.json.recentMessageLimits` 对普通消息端分别配置 `0–200`，未设置时默认 `12`；`0` 只关闭该端的自动注入，不停止记录。`heartbeat` 始终按 `0` 处理，即使旧配置保留了非零值也不会读取账本或生成 `[最近消息]` 段。独立的 `plan_feedback` 计划审批事件同样固定为 `0`，并且不写统一会话账本；计划审批 JSONL 本身就是该事件的审计真源。这里没有另一个“只保留 360 条”之类的 `current` 条数上限。

人格可在 `personaConfig.json` 选择注入策略：

```json
{
  "contextInjection": {
    "mode": "focused",
    "relevantKnowledgeLimit": 3,
    "personaMaxChars": 1600
  }
}
```

`focused` 是安全默认值：只注入当前会话窗口、相关摘要和精简人格工作集；`relevantKnowledgeLimit` 限制高相关知识项为 `1–12`，`personaMaxChars` 限制 Codex Hook 人格摘录为 `800–6000` 字符。需要临时回滚旧行为时可设为 `"mode": "legacy"`，恢复全量活动索引、旧 5/12 项召回上限和 3200 字符人格摘录。未包含该字段的旧配置可直接读取，不要求迁移私有值。

归档按记录时间戳处理，不是日期一到就删除：归档检查发现任意记录已超过 72 小时时，会把当前文件连续前缀中已超过 24 小时的完整记录收进 `<firstSequence>~<lastSequence>.jsonl`。自动上下文只读 `current.jsonl`；归档不丢失，Agent 可根据注入的路径显式查证。

## 用户模板定位

用户不应该被要求在每条 route 规则里重复写完整消息模板。默认情况下，用户模板可以为空。

用户模板只用于补充这条规则的特殊要求，例如：

```text
请用更短的群聊草稿回应。
```

或：

```text
这条规则只做记录，不要生成外发草稿。
```

RabiRoute 会把用户模板内容放到最终消息的 `[用户模板补充]` 段落。没有补充内容时，该段落可以省略。

这意味着：

- 事件信息不需要用户手写。
- 角色文件路径不需要用户手写。
- 日志路径不需要用户手写。
- 计划和记忆索引不需要用户手写。
- Agent 接口文档链接不需要用户手写。
- 用户只写额外意图或特殊限制。

## 默认注入内容

事件信息：

```text
事件类型
事件时间
当前时间
route kind
route profile
消息来源
发送者
消息正文
```

角色信息：

```text
角色 ID
角色文件路径
角色目录
运行数据目录
```

这些文件和目录路径会尽量写成相对当前 RabiRoute 工作区的路径，避免把本机绝对路径和用户名注入消息或公开示例。

日志路径：

```text
群聊日志路径
私聊日志路径
心跳日志路径
手动触发日志路径
语音转写日志路径
角色面板消息路径
```

Rabi 内置能力：

```text
Agent 需要关注的 Rabi 接口文档链接
计划目录
记忆目录
```

计划和记忆上下文：

```text
更新记忆与计划的说明文档路径
精简 API 提示：计划、记忆和技能的按需查询/维护路径
高相关计划/记忆摘要：类型 + ID + 标题 + focus
命中技能摘要：技能 ID + 标题 + summary + GET 路径
全量活动索引：focused 模式只提供查询路径；legacy 模式才直接展开
```

## 命中召回与处理前确认

`[记忆与计划]` 在默认 `focused` 模式只显示高相关摘要和全量索引的查询路径，不展开无关的当前计划、近期记忆或技能。近期记忆统一指 `memory/recent/` 里的记忆；记忆活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个，只用于生命周期与相关项排序。

除此之外，RabiRoute 还会在投递消息给 Agent 之前，根据当前用户消息做轻量相关性打分，把高相关条目列入 `[处理前上下文确认]`。这个确认协议不只服务聊天回复，也适用于发布任务、更新计划、写入记忆或执行外部动作。

相关性打分发生在 Agent 投递或推理检查点的热路径上，必须保持轻量。它不应该全量分词、扫描知识正文或读取大量聊天记录。

计划和记忆的可检索关键词由 Agent 在写入或更新时主动提供。RabiRoute 只维护 ID、标题和 `keywords` 索引；消息到来时先排除 `archiveStatus=已归档` 的计划，再对其余元信息做打分。已归档计划即使 ID、标题或关键词完全匹配也不会进入召回候选，只能按明确计划 ID 或归档视图读取。

新增或更新近期记忆时，`keywords` 必须存在且至少包含一个关键词。

相关性打分覆盖当前仍有操作价值的内容：

- 近期记忆，包括默认已显示的活跃近期记忆，以及不默认显示但尚未沉淀的近期记忆。
- `archiveStatus=未归档` 的计划；状态配置的 `views` 包含 current 时进入默认当前计划索引，其余计划按各自配置的视图参与筛选。状态名称与顺序都来自所属人格的 `personaConfig.json.planWorkflow`。
- 沉淀记忆，只参与标题和 `keywords` 打分，不默认注入全文。
- 角色技能，只参与 `id`、标题、摘要和 `keywords` 打分，不默认注入正文。

如果用户消息包含这些条目的 ID、标题或 `keywords`，RabiRoute 会把得分最高的条目以 ID + 标题 + focus/summary + GET 路径的形式加入 `[处理前上下文确认]`，`focused` 默认最多 3 条；`legacy` 保持旧的 5 条必读 / 12 条命中上限。

近期记忆或沉淀记忆进入处理前确认队列时，RabiRoute 会刷新该条记忆的 `viewedAt`。按 ID 查看近期记忆或沉淀记忆也会刷新 `viewedAt`；更新近期记忆会同时刷新 `updatedAt` 和 `viewedAt`。

已归档计划和其他更老的历史内容不参与常规打分。用户明确要求查看归档计划或历史记录时，再按需查询。

处理前确认只注入索引和查询路径，不注入全文。Agent 在回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须按 GET 路径读取确认队列里的每一项；如果无法读取或内容不足，应说明上下文无法确认或先追问。

MVP 使用 ID、标题 `includes` 和 Agent 写入的 `keywords` 做打分。不在投递前做智能分词。后续如果需要更复杂的中文分词，也应作为写入/更新时的离线辅助，不进入消息投递热路径。

## 按需注入内容

这些内容不默认进入每条消息，只在 route 模板、用户请求、手动触发或 Agent 明确需要时进入上下文：

- 计划详情。
- 近期记忆全文。
- 沉淀记忆摘要。
- 全量计划列表。
- 计划归档。
- 近期记忆列表。
- 沉淀记忆列表。
- gateway / NapCat / heartbeat 诊断摘要。

## 自动包装格式

最终投递给 Agent 的消息由 RabiRoute 自动包装生成。首段固定为 `[消息源]`，下一段固定为 `[消息内容]`。事件信息、最近消息、引用解析、角色路径和协作要求全部排在消息内容之后。空字段、未启用能力和没有人格绑定的段落会被省略或替换。

四种来源分别使用不同身份字段：消息端必须提供 `messageAdapter`、`conversationType`、`conversationId`、`messageId`，以及 `senderName` 或 `senderId`；Agent 必须提供实际 `agentAdapter`、会话名称和完整会话 ID；计划必须提供计划名称和计划 ID；系统必须提供事件类型、名称和 ID，必要时可补充触发方类型、名称和 ID。

`contextBlocks` 放事件、附件、最近消息等补充上下文，`controlBlocks` 放初始化、回复合同和协作要求。固定顺序是消息源、消息内容、上下文块、控制块。上下文块和控制块不得包含 `[消息源]`、`[消息内容]` 或 `[投递源]`，正文中的 `[标题]` 会被引用化，不能伪造同级控制板块。

旧 `[投递源]`、旧嵌套信封和旧 Agent 回复会在新信封渲染前移除。旧重放记录没有保存结构化来源时，系统明确标为“历史投递记录”，不猜原消息端、Agent 或会话。

现行结构：

```text
[消息源]
消息源类型：<消息端 | Agent | 计划 | 系统>
<该类型的名称、完整 ID、会话、计划或路线字段>
消息包发送时间：<本次投递时刻>

[消息内容]
<message>

[事件信息]
事件：<事件说明>
路由类型：<routeKind>
事件时间：<time>
当前时间：<currentTime>

[最近消息]
最近 <recentMessageLimit> 条双向消息：
<recentMessages>

[消息代码解析]
[CQ:reply,id=<messageId>] : <被引用消息摘要>
  [CQ:reply,id=<messageId>] : <更早的被引用消息摘要>
[CQ:at,qq=<qq>] : <群名片或昵称>

[角色和路径]
角色：<agentRoleId>
角色文件：<agentRolePath>
角色目录：<agentRoleDir>
运行数据目录：<dataDir>
计划目录：<agentRoleDir>/plans
记忆目录：<agentRoleDir>/memory

[记忆与计划]
更新记忆与计划的说明文档：<agentInterfaceDocPath>
可用 API 提示：
- 查看/更新计划：GET /api/roles/<roleId>/plans、GET /api/roles/<roleId>/plans/{planId}、POST /api/roles/<roleId>/plans、PATCH /api/roles/<roleId>/plans/{planId}
- 查看记忆：GET /api/roles/<roleId>/memory、GET /api/roles/<roleId>/memory/recent、GET /api/roles/<roleId>/memory/recent/{memoryId}、GET /api/roles/<roleId>/memory/consolidated、GET /api/roles/<roleId>/memory/consolidated/{memoryId}
- 新增近期记忆：POST /api/roles/<roleId>/memory/recent
- 更新指定近期记忆：PATCH /api/roles/<roleId>/memory/recent/{memoryId}
- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；关键词命中召回会刷新 viewedAt

当前计划：
- <planId>：<planTitle>

近期记忆：
- <memoryId>：<memoryTitle>

可用技能：
- <skillId>：<skillTitle> - <skillSummary>（GET /api/roles/<roleId>/skills/<skillId>）

命中技能：
- <skillId>：<skillTitle> - <skillSummary>（GET /api/roles/<roleId>/skills/<skillId>）

命中召回：
- <itemId>：<itemTitle>

[处理前上下文确认]
- <高相关必读项及 GET 路径>

[日志]
群聊日志：<groupLogPath>
私聊日志：<privateLogPath>
心跳日志：<heartbeatLogPath>
手动触发日志：<manualTriggerLogPath>
语音转写日志：<voiceTranscriptLogPath>
角色面板记录：<rolePanelLogPath>
当前双向会话：<conversationCurrentPath>
历史会话归档：<conversationArchiveDir>
会话归档索引：<conversationArchiveIndexPath>

[回传]
明确发送 API：<sendApiUrl>
发送请求模板：<sendRequestJson>
来源上下文（仅供审计和跨人格联系，不可作为发送参数）：<replyContextJson>

[跨人格联系]
查询：GET /api/personas?addressable=true
投递：POST /api/personas/{personaId}/messages
来源 Route：replyContext.runtimeRouteId
来源凭据：replyContext.personaMessagingCapability
要求：每次业务投递使用稳定且唯一的 deliveryId；回复时沿用 personaConversationId、引用当前 messageId，并增加 personaMessageHopCount，不得超过 personaMessageMaxHops

[发送要求]
<按 outputAdapter、replyToSource 和来源消息生成的回传说明>

[远端 Agent 设备]
<仅在 route 启用 remoteAgent 消息端时注入本机 Manager API 提示>

[用户模板补充]
<用户在 route 模板里写的可选补充要求；为空时省略本段>
```

`heartbeat` 和 `plan_feedback` 包都会省略整个 `[最近消息]` 段，并把模板变量 `{recentMessageLimit}` 设为 `0`、`{recentMessages}` 设为空字符串，避免自定义模板重新携带历史正文。心跳日志和统一会话账本仍照常记录；计划审批则只保留专用 feedback 审计、AgentPacket 和投递日志，不重复写角色面板时间线或统一会话账本。

处理端写出的 Codex 最终文本只属于当前任务记录，不代表来源用户、主人格或另一个 Agent 已经收到。需要向消息端发送时，处理端必须从 `sendRequestJson` 开始，填写 `sender.agentType` 和当前完整 `sender.sessionId`，再明确提交 `routeId`、`channel`、渠道专用 `params` 和 `payload`，并取得该渠道回执；不得把 `replyContextJson` 原样提交，也不得根据来源自动猜测目标。NapCat 群聊引用消息含图片时，必须按原图顺序填写 `params.replyImageDescriptions`，逐张写明实际内容和图片表达的意思；不能查看、缺少描述或数量不一致时不得发送。需要交给主人格、秘书或计划 Agent 时，必须调用 Manager 线程桥并携带发送任务自己的完整 ID 和 Agent 类型。只生成回复草稿、审批问题或阶段摘要而没有进入上述出口，不能标记为已回复或已通知。

跨人格能力凭据只证明“当前 AgentPacket 所属 Route 与人格”，不会出现在 `GET /api/personas`、目标 timeline 或投递回执中。`sourceRouteId` 不能单独证明发送身份。目标人格收到跨人格消息后，普通回复不会自动返回来源；需要回复时必须显式反向 POST，并使用收到的会话、引用和跳数字段。

`[消息代码解析]` 只在当前消息或引用链里存在可解析 CQ 码时出现。RabiRoute 会从本 route 的群聊/私聊消息记录中按 `messageId` 追溯 `CQ:reply`；AgentPacket 也会把成功外发的 Outbox 记录作为本地兜底。NapCat 实时入口发现引用 ID 尚未落盘时，会在路由投递前调用 OneBot `get_msg`，把查到的群聊/私聊消息标记为 `lookupSource=onebot_get_msg` 后缓存，再继续追溯下一层引用。接口失败只记录 warning，不阻塞当前消息。展开持续到没有引用、仍无法解析、出现循环或达到安全上限为止。每条引用摘要最多显示 200 字，超过后以 `……(更多信息调用接口查看)` 截断；展开过程中遇到的 `CQ:at` 会去重后集中显示为 `[CQ:at,qq=xxxx] : 群名片或昵称`。本段不额外显示当前消息 ID，也不重复输出纯文本正文。

当 `voice_transcript` 明确来自 RabiPC 的 `speech` 消息端或 RabiSpeech 时，`AgentPacket` 会把本轮输出收敛为 `voice_chat`，在来源上下文写入 `characterTtsDialogue=true`，并生成 `channel=speech`、带当前 `sessionId` 的发送模板。`[发送要求]` 会明确要求 Agent 进入 `character-tts-dialogue` 状态，把与屏幕回复同义的短句 POST 到明确发送 API；Outbox 再按当前人格 `voice/voice-profile.json` 的声线、模型、语言、语速、`sessionId` 和自动播放设置进入 RabiSpeech 主机级 FIFO。同一 `sessionId` 的 ASR 与 TTS 会作为双向上下文共用 `speech` 额度。QQ、角色面板、普通文字和其它 `voice_transcript` 来源不受这个自动切换影响。

语音是唯一有这类“先记录、再决定是否唤醒”的专用策略之一：Route `speechPushMode=hot` 时每段 ASR 立即投递；`keyword` 时只在命中人格 `speechTriggerKeywords` 时投递，其他转写仍在账本中。空关键词不回退 `hot`。普通已匹配消息端则直接进入 Desktop `steer/start`；Heartbeat 的忙碌跳过由独立开关控制。

语音处理主机、声纹 ID 和语音账号兼容数据文件路径只会出现在语音转写记录中。QQ、角色面板及其他非音频事件不会显示这些语音专属字段。

## 示例：QQ 群消息

```text
[消息源]
消息源类型：消息端
消息端：napcat
会话类型：group
会话名称：群 <group-id>
会话 ID：napcat:group:<group-id>
发送者名称：Alice
发送者 ID：<sender-id>
消息 ID：<message-id>
消息路线：default-main
消息路线 ID：default-main

[消息内容]
Rabi，帮我看看计划和记忆机制怎么设计。

[事件信息]
事件：QQ 群聊消息提醒
路由类型：group_message
事件时间：2026/6/8 20:12:00
当前时间：2026/6/8 20:12:03

[角色和路径]
角色：Rabi
角色文件：data/roles/Rabi/persona.md
角色目录：data/roles/Rabi
运行数据目录：data/route/default-main
计划目录：data/roles/Rabi/plans
记忆目录：data/roles/Rabi/memory

[记忆与计划]
更新记忆与计划的说明文档：docs/rabi-agent-interfaces.md
可用 API 提示：
- 查看/更新计划：GET /api/roles/Rabi/plans、GET /api/roles/Rabi/plans/{planId}、POST /api/roles/Rabi/plans、PATCH /api/roles/Rabi/plans/{planId}
- 查看记忆：GET /api/roles/Rabi/memory、GET /api/roles/Rabi/memory/recent、GET /api/roles/Rabi/memory/recent/{memoryId}、GET /api/roles/Rabi/memory/consolidated、GET /api/roles/Rabi/memory/consolidated/{memoryId}
- 新增近期记忆：POST /api/roles/Rabi/memory/recent
- 更新指定近期记忆：PATCH /api/roles/Rabi/memory/recent/{memoryId}
- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；关键词命中召回会刷新 viewedAt

当前计划：
- plan-001：完善计划和记忆机制文档

近期记忆：
- memory-001：用户希望计划和记忆由 Agent 主动维护
- memory-002：近期记忆和当前计划默认只注入 ID 与标题

命中召回：
- memory-003：更新记忆与计划的说明文档路径

[日志]
群聊日志：data/route/default-main/group-messages.jsonl
私聊日志：data/route/default-main/private-messages.jsonl
心跳日志：data/route/default-main/heartbeat-events.jsonl
手动触发日志：data/route/default-main/manual-trigger-events.jsonl
角色面板记录：data/roles/Rabi/role-panel/messages.jsonl
语音转写日志：data/route/default-main/voice-transcripts.jsonl

[发送]
明确发送 API：`<managerBaseUrl>/api/agent/send`；安装版从 Host `status --json` 发现本代地址，源码模式由 Manager 标准输出提供。
发送请求模板：{"deliveryId":"<稳定发送 ID>","sender":{"agentType":"primary_persona","sessionId":"<当前主人格完整会话 ID>"},"routeId":"default-main","channel":"napcat","params":{"target":"group","groupId":"example-group-id","replyToMessageId":"<能引用时填源消息 ID；不引用时填空字符串>","replyImageDescriptions":[]},"payload":{"type":"text","text":"<发送正文>"}}
Codex 主人格 Route 开启“仅允许主人格发送消息”Hook 后，`sender.sessionId` 必须填写该 Route 绑定的 `codexThreadId`。
来源上下文（仅供审计）：{"runtimeRouteId":"default-main","routeProfileId":"default-main","routeKind":"group_message","targetType":"group","messageId":"example-message-id","groupId":"example-group-id"}

[用户模板补充]
需要回应时给短而自然的群聊草稿。
```

## 示例：自动或显式记忆整理触发

记忆整理入口属于 `manual_trigger` 类消息，投递方式和普通手动触发一致。Manager 会在最不活跃记忆到达 72 小时时自动产生 `triggerId=memory-consolidation`，也接受用户手动触发；两者都会重新评估时间窗口并创建待整理 run。Manager API 仍可显式创建 request。

当前实现先创建可查询的 consolidation request 和 pending run；负责 outbox 或回复发送的链路可以随后把 request 投递给 Agent。Agent 返回结果后，RabiRoute 通过 result 接口落盘沉淀记忆并标记输入近期记忆。

```text
[消息源]
消息源类型：系统
事件类型：manual_trigger
事件名称：自动到点触发
事件 ID：memory-consolidation
消息路线：default-main
消息路线 ID：default-main

[消息内容]
执行本次记忆整理。

[事件信息]
事件：自动到点触发
路由类型：manual_trigger
触发 ID：memory-consolidation
触发名称：记忆整理
事件时间：2026/6/8 23:00:00
当前时间：2026/6/8 23:00:00

[角色和路径]
角色：Rabi
角色目录：data/roles/Rabi
记忆目录：data/roles/Rabi/memory
Agent 需要关注的 Rabi 接口：docs/rabi-agent-interfaces.md

[待整理记忆]
- memory-001：用户希望计划和记忆由 Agent 主动维护
  用户希望计划和记忆都由 Agent 主动维护，RabiRoute 负责提供接口。

- memory-002：记忆整理触发机制
  记忆整理是 RabiRoute 内置 manual_trigger，可自动触发也可由用户主动触发。

[系统处理要求]
请将以上近期记忆整理为稳定、简洁、可长期保留的沉淀记忆。只返回沉淀记忆内容，不需要解释触发原因，不需要选择输入范围，不需要修改原始近期记忆。
```

## 模板变量边界

普通 route 规则不需要手写上下文索引。现行模板值中可直接使用以下路径和回传字段：

```text
{agentInterfaceDocPath}
{plansDir}
{memoryDir}
{recentMessages}
{recentMessageLimit}
{recentMessageEndpoint}
{recentConversationKey}
{conversationCurrentPath}
{conversationArchiveDir}
{conversationArchiveIndexPath}
{sendApiUrl}
{sendRequestJson}
{replyContextJson}
{rolePanelLogPath}
```

当前计划、近期记忆、技能和命中召回由自动包装器直接生成，目前不是供 route 模板自由拼装的独立模板变量。完整的用户可用变量以 [路由配置](routing-configuration.md) 和 `templateValuesForDecision()` 为准。

## 边界

上下文注入不是长期记忆数据库，也不是计划执行器。它只负责把 Agent 当前处理消息所需的轻量索引和路径交给 Agent。

如果 Agent 需要更多信息，应通过接口文档中的计划/记忆接口按 ID 查询；如果 Agent 需要维护记忆，应写近期记忆；如果 Agent 收到记忆整理触发，只返回沉淀记忆。
