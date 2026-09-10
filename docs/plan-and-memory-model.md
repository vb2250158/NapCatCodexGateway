<!-- docs-language-switch -->
<div align="center">
<a href="./plan-and-memory-model_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 计划和记忆机制

待审批页面优先显示 Agent 提供的问题和选项；只有所有问题都没有选项时，才补充“按此方案执行”和“提出审批建议”两个默认选项。均不预选，选择建议必须填写具体内容。每题的“补充说明或其他答案”复用反馈输入组件，支持 @ 引用计划附件、文件选择、剪贴板粘贴和键盘提交；附件统一预览、删除并随本次反馈提交，不再显示独立的审批建议输入框。审批资料变更后必须重新确认。选项 requiresText=true 要求附加文字，问题 requireOption=true 要求明确选择；普通待补充信息仍可直接输入答案。

## 计划问题与回答

“待补充信息”要求 Agent 先查阅与问题相关的现有代码、配置、设计、文档和附件，在计划中写明资料清单、确认结果、分析卡点和仍无法确定的问题，再提出最少必要的具体询问。缺日志或复现步骤本身不构成等待理由。

待审批和待补充信息的当前步骤均可通过既有计划 POST/PATCH 保存 `questions`。WebGUI 在原有审批/引导提交区显示问题：有 `options` 时显示单选选项，无选项时显示文字输入框；两种模式都允许自由文字回答。推荐项不自动选择，必填题允许选择或输入其他答案。选项不会自动批准方案或改变计划状态，答案通过既有反馈记录保存并通知原绑定任务，由 Agent 消费后推进。

```json
{
  "id": "clarify-entry",
  "title": "确认剩余入口分支",
  "questions": [{
    "id": "entry",
    "prompt": "问题发生在哪个入口？",
    "context": "已核对配置和两个入口的调用链，剩余分支需要现场确认。",
    "options": [
      { "id": "list", "label": "列表页", "description": "继续核对列表入口的状态恢复" },
      { "id": "detail", "label": "详情页", "description": "继续核对详情入口的初始化" }
    ],
    "placeholder": "也可以描述其他入口或补充实际表现",
    "required": true
  }]
}
```

每步最多 5 题、每题最多 6 个选项；问题与选项 ID 必须在各自范围内唯一。`prompt` 最多 500 字符，`context` 1000，选项 `label` 200、`description` 500，`placeholder` 300；`required` 默认 true，选项可标 `recommended: true`。问题和所选标签随答案保存为反馈文字，合计沿用 2000 字符限制。提交前核对最新步骤和问题；问题已变化时要求刷新并重新确认，原有 ETag/幂等反馈链路继续生效。待补充信息的旧计划未提供此字段时保留自由文字反馈，不自动推断问题或补造调查结果。

> 状态：现行指南。已按 `src/roleKnowledge.ts`、Manager API 和测试核对；文中明确区分当前实现与后续计划。

本文说明 RabiRoute 中计划和记忆的运行机制：数据放在哪里、如何分层、怎样进入处理端 Agent、何时更新，以及托盘面板如何展示。

RabiRoute 仍然是消息网关和 Policy Router。计划和记忆机制用于给路由和处理端提供可追踪上下文，不把 RabiRoute 变成完整 Agent OS、项目管理器或聊天机器人框架。

最终注入给 Agent 的消息格式见 [Agent 上下文注入说明](agent-context-injection.md)。Agent 可用接口见 [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)。

## 总体模型

计划和记忆都跟随角色人格目录。一个角色拥有自己的计划、人格文件、消息日志和长期上下文。

```text
data/roles/<RoleId>/
  persona.md
  growth.md
  skills.md
  personaConfig.json
  plans/
  memory/
  identity-relations/events.jsonl
  private-messages.jsonl
  group-messages.jsonl
  voice-transcripts.jsonl
  heartbeat-events.jsonl
```

路由运行态数据跟随 route profile：

```text
data/route/<RouteName>/
  gateway-status.json
  heartbeat-events.jsonl
```

角色目录保存“这个角色长期应该知道和关注什么”。路由目录保存“这条航线当前运行成什么样”。

### 身份关系记忆

身份关系记忆的知识类型是 `identity_relation`。它与计划和近期记忆并列、人格私有，但不参与近期记忆的 24/72 小时整理。它保存消息端账号、参与者实体和关系卡三层资料，并使用追加事件而不是改写历史：

```text
data/roles/<RoleId>/identity-relations/events.jsonl
```

账号的身份键固定为 `platform + endpointIdentityNamespace + senderStableId`；Route 配置 ID、显示名、头像和当前讨论主题都不是身份键。一个账号可以有候选或已确认的参与者映射；一个参与者可以关联多个账号。关系卡表达人与人、人与组织或人与项目之间的协作、汇报、决策范围等关系，并带有 `candidate`、`confirmed`、`corrected` 或 `retired` 状态、适用群/项目范围和最小证据引用。

该资料只用于参与者解析，不能把平台权限、临时发言角色或一次讨论自动变成业务决策权。候选关系不能用于称呼、授权、项目归属或执行判断。消息投递会把适用于当前会话的项目关系卡列入“情景记录”，但这只表示可以参与讨论，不表示可管理该项目的计划、任务或长期记忆。多电脑同步会并集合并事件；同一记录出现不一致的并发事件头时，当前视图明确标记冲突并停止自动确认，不能按文件顺序任选一条。人格提交包含全部关键字段的一次修正，会 supersede 当前全部事件头并让后续同步收敛。处理端可通过身份关系 API 显式确认或纠正；消息投递时的身份关系上下文不要求提交计划/记忆回调。

## 计划机制

计划用于保存可推进、可等待、可完成、可归档的关注项。计划数据是角色要盯住的事项，不是普通聊天记录，也不是执行器队列。

`plan.status` 只保存所属人格 `personaConfig.json.planWorkflow.statuses` 中启用状态的 `key`。状态的名称、说明、颜色、顺序、所在视图、步骤约束、审批约束、完成行为和归档资格都由同一份人格配置提供；代码、WebGUI 和托盘不维护第二份状态枚举。默认模板提供以下十个状态，`key` 与显示名称彼此独立：

```text
分析中
待补充信息
待审批
执行中
等待打包
等待 QA
待讨论
暂停
完成
关闭
```

业务代码通过 `planWorkflow.roles` 查找分析、待补充信息、审批、执行、打包、QA、讨论、暂停、完成和关闭对应的 key。默认配置下，仍在调查和分析时使用“分析中”；只有分析已经完成，但现有信息仍无法形成可审批的具体方案，且缺失信息会影响原因、改法、实施范围或验收合同时，才使用“待补充信息”；完整审批合同正式等待回执时使用“待审批”；批准或用户直接授权后使用“执行中”。暂未复现、疑似历史已修复、等待目标包、等待 QA 或等待是否关闭都不属于“待补充信息”。开发侧完成但缺目标包或纳入证明时使用“等待打包”，目标包确认但缺 QA 结论时使用 QA 状态 key“等待 QA”，默认显示名称为“等待 QA 验收”；确认问题无效或历史已修复且无需验收时凭证据使用“关闭”。Manager 将 `plan.status` 的 key 与配置中的 label、description、palette、order 和 views 一起返回；客户端不解释 key，也不从步骤、`waitingFor` 或审批资料派生第二套状态。

`planWorkflow.schemaVersion=4` 保留 v3 取消步骤状态字段的结构，并收窄默认“待补充信息”说明。现有 v1/v2/v3 人格配置第一次读取时会保留自定义状态和相对顺序；v1 还会在分析状态后加入默认“待补充信息”定义。v2/v3 只替换仍使用旧默认 key、label 和说明的中英文说明，不覆盖人格自定义说明，也不会补回或重新启用被 Agent 移除的状态。

状态目录通过 `GET /api/roles/:roleId/plan-statuses` 读取；Agent 可使用同一路径的 `POST` 新增状态、`PATCH /:statusKey` 修改展示和行为、`DELETE /:statusKey` 移除状态。写请求必须携带 `If-Match` 与 `Idempotency-Key`。状态 key 不允许原地改名。移除时必须提供 `replacementKey`：Manager 先迁移仍在使用该状态的未归档计划，再把旧定义保留为 `retired`，使已归档计划和追加式历史仍可解析。只有历史引用也不存在时，后续维护才可物理删除定义。

计划按“一个计划一个目录”保存：

```text
data/roles/<RoleId>/plans/
  active/
    <planId>/
      plan.json
      history.jsonl
      feedback.jsonl
      attachments/
      feedback-attachments/<feedbackId>/
  archive/
    <planId>/
      plan.json
      history.jsonl
      feedback.jsonl
      attachments/
      feedback-attachments/<feedbackId>/
```

`plan.json` 是当前业务状态的唯一真源。计划状态与归档状态彼此独立：`status` 使用当前人格配置中的 key；`archiveStatus` 只允许 `未归档` 或 `已归档`。`active/` 放 `archiveStatus=未归档` 的计划，`archive/` 只放 `archiveStatus=已归档` 的计划。已归档计划不参加关键词召回，只能通过明确 ID 或归档视图读取。

Manager 只通过计划存储 Repository 新建、更新和归档此目录。旧布局迁移、未完成事务恢复和规范目录核对共同决定计划存储的读取/变更资格，每次尝试都在可终止的 one-shot child 中执行。Manager 端点与身份、完整必需插件集和 handler READY 不等待 NAS 恢复，Host 与 Tray 因此保持当前 application generation。资格状态为 `running` 或 `degraded` 时，现有只读端点仍可响应，计划变更请求失败关闭，`/health` 明确报告降级；资格就绪后，运行模块只使用已恢复的规范布局，不再扫描或读取旧布局。迁移不会读取附件正文；旧数据与规范目录内容相同时，以带清单和回执的事务退役重复副本，内容分歧时保存证据并失败关闭，禁止带着半迁移状态继续变更计划。计划从 `active/` 进入 `archive/` 同样是 Repository 持有 lease 的完整生命周期事务，不是裸 `rename`，也不是后台迁移。

配置为 `terminal=true` 且 `archiveEligible=true` 的计划不会立即归档。距离最后更新时间超过该人格 `planWorkflow.archiveAfterHours` 后，角色知识快照只把 `archiveStatus` 改为 `已归档`，并将整个计划目录从 `plans/active/<planId>/` 移到 `plans/archive/<planId>/`；原 `status` key 保持不变。默认模板的完成和关闭状态符合该条件，延迟为 72 小时。

计划归档不需要经过 Agent 处理。它是 RabiRoute 的机械生命周期维护，不触发 Agent 总结，不要求 Agent 判断，只更新 `archiveStatus`、`archivedAt` 和存放位置。

归档计时以计划的 `updatedAt` 为准，不以 `createdAt` 为准。计划只要被 Agent 或用户更新过，就重新进入活跃窗口。归档资格由状态定义的 `terminal` 与 `archiveEligible` 决定，延迟由 `personaConfig.json.planWorkflow.archiveAfterHours` 决定；默认模板使用 72 小时，具体人格可以调整。

## 计划字段

单个计划建议保持轻量，先满足展示、筛选和后续写入。

```json
{
  "id": "plan-rabiroute-plan-memory-model",
  "title": "完善 RabiRoute 计划和记忆机制文档",
  "focus": "计划和记忆机制文档",
  "status": "待审批",
  "archiveStatus": "未归档",
  "importance": 2,
  "urgency": 2,
  "kind": "documentation",
  "currentStepId": "confirm-contract",
  "currentStep": "确认机制说明口径",
  "nextAction": "根据确认结果更新示例和读取层",
  "waitingFor": "秋雨批准结构化步骤契约",
  "blockedBy": "秋雨尚未批准是否按当前文件、命令和界面方案更新计划契约",
  "attachments": [
    {
      "id": "attachment-preview",
      "kind": "image",
      "name": "plan-preview.png",
      "path": "C:/Path/To/data/roles/Role/plans/active/plan-id/attachments/attachment-preview-plan-preview.png",
      "size": 2048,
      "mimeType": "image/png",
      "sha256": "<sha256>"
    }
  ],
  "steps": [
    {
      "id": "inspect-current",
      "title": "检查当前模型与界面",
      "startedAt": "2026-06-08T00:00:00+08:00",
      "completedAt": "2026-06-08T00:10:00+08:00"
    },
    {
      "id": "confirm-contract",
      "title": "确认结构化步骤契约",
      "startedAt": "2026-06-08T00:10:00+08:00",
      "waitingFor": "秋雨批准结构化步骤契约",
      "blockedBy": "秋雨尚未批准是否按当前文件、命令和界面方案更新计划契约",
      "approvalRequest": {
        "approver": "秋雨",
        "request": "批准按列出的文件和命令更新计划契约。",
        "recommendation": "批准当前最小 Schema、Manager DTO、双端 UI 和文档同步方案。",
        "alternatives": ["要求缩小文件范围后重新申请", "否决并保留现状"],
        "reason": "该变更会修改公开 Plan Schema 和双端用户界面。",
        "files": [
          { "path": "src/roleKnowledge.ts", "action": "modify", "change": "新增审批合同 Schema、规范化和写入校验。" },
          { "path": "ribiwebgui/src/pages/RoleKnowledgePage.vue", "action": "modify", "change": "展示完整合同与缺失提示；资料不完整时禁用审批提交。" }
        ],
        "commands": [
          { "command": "npm run build:backend", "purpose": "编译并验证 Manager 后端。", "expectedEffect": "只生成本地 dist 构建产物。" }
        ],
        "changes": [],
        "validation": ["Node 定向测试、托盘测试和 WebGUI 构建全部通过。"],
        "rollback": ["验证失败时只回退本合同列出的源码和文档改动。"],
        "outOfScope": ["不提交、不推送、不修改运行期 data/。"],
        "requestedAt": "2026-06-08T00:10:00+08:00",
        "sourceMessageId": "example-message-id",
        "responseStatus": "pending"
      }
    },
    { "id": "update-readers", "title": "更新接口、读取层和文档" }
  ],
  "project": {
    "name": "RabiRoute",
    "path": "C:/Path/To/RabiRoute"
  },
  "source": {
    "kind": "manual",
    "summary": "用户要求说明计划和记忆机制"
  },
  "secretaryBinding": {
    "agentType": "codex",
    "sessionId": "exact-secretary-session-id",
    "sessionTitle": "主人格 协助处理计划1",
    "workspace": "C:/Path/To/RabiRoute",
    "assignedAt": "2026-06-08T00:00:00+08:00"
  },
  "taskBinding": {
    "agentType": "codex",
    "sessionId": "exact-source-session-id",
    "sessionTitle": "计划执行任务",
    "workspace": "C:/Path/To/Project",
    "completionHook": {
      "enabled": true,
      "gatewayId": "Role__reminder"
    }
  },
  "dueAt": "",
  "completedAt": "",
  "archivedAt": "",
  "createdAt": "2026-06-08T00:00:00+08:00",
  "updatedAt": "2026-06-08T00:00:00+08:00",
  "keywords": ["计划", "记忆", "机制", "文档"]
}
```

`keywords` 由 Agent 在新增或更新计划时主动填写，用于 RabiRoute 在投递前做轻量命中召回。`archiveStatus=已归档` 的计划会在召回前被排除，即使标题或关键词完全命中也不会进入候选；只有明确计划 ID 查询或归档视图能读取。RabiRoute 不在每条消息到来时对计划内容做智能分词。

`focus` 是单条计划的唯一主题声明。新增计划必须显式填写，且只能是一行；一个计划只推进一个主题，遇到无关目标或独立阻塞时应拆成另一条计划，不能继续堆进 `currentStep`。

`attachments` 是计划本体的可选附件列表。Agent 可在 POST/PATCH 中为新附件提供本机 `path`，或提供 `name`、可选 `mimeType` 与 `contentBase64`。Manager 校验后复制到该计划目录的 `plans/active/<planId>/attachments/`，计划 JSON 只保存 `id/kind/name/path/size/mimeType/sha256` 元数据，不保存 Base64。最多 8 个，单个不超过 10 MiB、总计不超过 25 MiB。PATCH 省略 `attachments` 时保留原附件；显式传 `attachments: []` 时清空计划记录中的附件列表。

整体复制运行数据或更换安装目录后，旧 `plan.json` 可能仍保留原根目录的绝对路径。Manager 不读取该旧位置，而是在当前计划的受管附件目录中按原文件名定位副本，并要求文件大小和 SHA-256 与计划元数据一致；不匹配时返回附件不存在。

WebGUI 不直接读取元数据中的本机路径，而是通过 `GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId` 获取受控文件。PNG、JPEG、WebP 和 GIF 图片，MP4/M4V、WebM、Ogg Video、MOV/QuickTime 视频，以及 Markdown 文件统一显示紧凑固定宽度的 16:9 预览卡片，仅在容器不足时等比缩小。Markdown 卡片流式读取最多 12 KiB 的正文开头，转成最多 180 字的纯文本摘要并截断显示，不执行 HTML、链接或图片；点击后才打开完整文档弹窗。点击图片打开页内大图，点击视频打开带播放控制的页内预览。视频响应支持字节范围读取，实际可播放编码仍取决于当前浏览器。Markdown 不超过 2 MiB 时可在页内预览 GFM 标题、列表、表格、引用与代码，原始 HTML、危险/相对链接和远程图片加载均被禁用，弹窗保留原文件下载入口。其它文件显示名称、类型与大小，并通过附件响应打开或下载。读取接口会再次确认真实路径仍在该计划的受管目录内，路径穿越或 symlink 越界均失败关闭。

`steps` 是计划的有序执行路径，不保存独立状态。顶层 `currentStepId` 指向当前步骤，`completedAt` 记录已经完成的步骤；后续步骤不需要“未开始”字段。计划阶段只写入 `plan.status`，状态名称和说明统一从 `personaConfig.json.planWorkflow.statuses` 读取。`detail`、`waitingFor`、`blockedBy`、`approvalRequest` 和步骤 ID 只提供执行、等待与审批证据。Manager 维护步骤的 `startedAt` 与 `completedAt`。

分析完成后，如果现有信息仍无法形成可审批的具体方案，且缺失信息会影响原因、改法、范围或验收合同，写入 `planWorkflow.roles.informationNeeded` 指向的 key，并在 `waitingFor` 中列出缺少的具体信息和提供者。信息补齐后恢复为 `roles.analysis`。不能因为暂未复现、疑似历史已修复、缺目标包、等待 QA 验收或等待是否关闭而使用该状态。明确等待讨论时写入 `roles.discussion` 指向的 key；普通暂停使用 `roles.paused`。恢复时按实际阶段选择 analysis 或 execution role 指向的 key。

需要审批的当前步骤应带完整 `approvalRequest`。`approver`、`request`、`recommendation`、`alternatives` 和 `reason` 说明审批人、决定、推荐、备选与原因；`files` 逐项写路径、`create/modify/delete/move` 和具体改动；`commands` 写完整命令、用途和预期影响；`changes` 写配置、数据库、云环境或外部系统目标；`validation`、`rollback`、`outOfScope` 分别声明验收、回退和明确排除范围；`requestedAt`、`sourceMessageId / feedbackId`、`responseStatus` 记录请求来源与回执。`files / commands / changes` 至少一类非空。缺必要栏目的审批步骤由 Manager 标为 `presentation.approval.state=incomplete`、`enabled=false`。仍可继续独立分析时使用 analysis role；只有分析已结束但无法形成可审批具体方案时使用 informationNeeded role。合同完整且 `responseStatus=pending` 后，Agent 把 `plan.status` 写为 approval role 指向的 key；Manager 同时返回 `presentation.approval.state=ready` 和 `enabled=true`，但不会替 Agent 改写状态。

Manager 在读取边界兼容旧计划：旧 `未开始` 读为 `暂停`；旧 `进行中` 按完整待审批合同、旧步骤执行标记依次映射为 `待审批 / 执行中 / 分析中`；旧 `已完成` 读为 `完成`；旧 `已归档` 读为 `status=关闭, archiveStatus=已归档`。旧 `workPhase`、`discussionState` 和手写 `isBlocked` 只参与一次兼容读取，并在下一次规范 POST/PATCH 时清理。系统不会猜测审批人、来源、推荐方案、备选或请求时间。

`secretaryBinding` 是计划当前控制面负责人的精确绑定，和业务 `taskBinding` 分开。它保存绑定 Agent 类型、完整会话 ID、展示名称、workspace、可选 DSH apiproxy 地址和分配时间。Manager 首次需要投递计划控制通知时从当前 Route 已启用的秘书池稳定选择一个并保存；秘书执行治理 `begin/finish` 时会把实际负责者更新为自己。已绑定秘书仍在当前池中时固定复用，只有绑定失效或秘书被移出配置后才重新分配。

`taskBinding` 是可选的“计划 ↔ 执行会话”精确绑定。`agentType` 决定会话所在的处理端：`codex` 使用 Codex Desktop 任务，`dsh` 使用 DSH 会话。`sessionId` 是必填的完整 ID；`sessionTitle` 只用于展示；`workspace` 决定该计划每次投递的执行目录，不要求等于 Codex 任务保存的默认 cwd。DSH 绑定仍按其 workspace 所有权校验，并可保存 `baseUrl` 指向实际 apiproxy。`completionHook.enabled=true` 仅适用于 Codex 完成回传：Manager 在该任务完成一轮后处理官方最终回答；启用并绑定计划秘书时直接投给 `secretaryBinding`，不写主人格角色面板；没有可用秘书时才回退到同人格 Route。`gatewayId` 用于多 Route 消歧。该提醒按 `sessionId + turnId` 去重，只记录阶段完成事实，不自动推进步骤、修改计划状态或写入记忆；计划状态为 `planWorkflow.roles.paused` 指向的 key 时不投递完成提醒，避免暂停期间重新驱动绑定任务。

Manager 提供只读批量状态接口 `GET /api/roles/:roleId/plan-agents/status?planId=...`，按每项绑定的 `agentType + sessionId` 查询 `taskBinding` 和可选 `secretaryBinding`，并把绑定的 workspace 作为下一轮执行目录。Codex 按完整 ID 读取 Desktop 任务，不比较任务保存的默认 cwd；DSH 通过绑定的 `baseUrl`（未保存时使用本机默认 apiproxy）读取会话并继续校验 workspace 所有权。结果把 Agent 是否工作与会话的 `active / idle / not_loaded / unavailable / archived / missing / workspace_mismatch` 分开返回；其中 `workspace_mismatch` 只适用于拥有固定 workspace 的处理端。超时或读取失败是 `unknown`，不能从计划生命周期状态猜测。`POST /api/roles/:roleId/plan-agents/:planId/open` 对 Codex 定位已核对、未归档的完整任务 ID；DSH 还要求 workspace 一致。它不发送 prompt、不创建会话，也不切换绑定。

`taskBinding` 只绑定计划的独立业务执行会话，不绑定“协助处理计划”秘书。计划管理秘书属于控制面：维护计划与记忆、查重和绑定业务任务、读取真实状态、消费结果、提醒并续投；调查、实现、测试、Unity/SVN/构建/发布和外部系统操作由业务任务负责。秘书可以开临时子 Agent 做计划盘点、查重、状态核对和结果摘要，但秘书及其子 Agent不得修改业务文件。

收到业务任务完成提醒后，负责秘书直接消费结果、PATCH 计划步骤与记忆，并在计划仍可推进时通过 `/api/agent/threads` 的 `action=send` 向该计划自身 `taskBinding.sessionId + workspace` 精确续投业务任务。普通进展、状态变化、等待条件和下一步由秘书直接处理；只有需要用户/主人格决策、批准、授权、补充输入、跨计划裁决、完整收尾或安全外发复核时才升级给主人格。计划暂停或秘书轮转不能清空业务 `taskBinding`；只有业务任务确实失效并完成受控迁移时才改绑，计划完成后可保留绑定作为历史证据。每次完成回传、heartbeat 或恢复巡检都应并行使用秘书槽管理不同计划分片，并在结束前满足 `可推进但无人管理的计划数 = 0` 与 `可推进但空闲的业务任务数 = 0`；已处于 `active/in-progress` 的业务任务不重复投递。等待审批或负责人时只执行已有授权范围内的询问、追问和补证据，不越过动作门禁。

项目正式工作副本的 Unity Editor 正在打开、导入、运行其它测试、MCP 暂不可用或共享测试排队时，计划仍继续执行。秘书不得把这些条件写成全局冻结或等待工作位，也不得停止 Editor、取消他人测试或覆盖无关改动。原业务任务继续实现、收窄 SVN 更新与合并、静态资源/Prefab/配置和直接序列化合同、非 Unity runner 与 CLI 验证；确实无法并行完成的 GameView、PlayMode 或交互项单列为人工或后续运行验收。无关全量测试失败不阻断匹配验证和功能开发，但必须保留失败事实与未运行项。

计划管理写入按 `planId` 隔离：同一计划同时只有一个控制面 writer，不同计划可以并行。共享 ledger、问题账本和发送回执在短文件锁内读取最新状态、只合并目标记录并原子替换，不能用旧的全量快照覆盖其它计划。锁元数据先完整写入候选文件，再以同卷 hard-link 原子发布；运行热路径不自动删除 stale 或损坏锁，遇到此类锁时失败关闭，只允许在已暂停 writer、确认 quiescent 的维护窗口显式修复。`claim` / `clarify` 以来源消息和稳定 key 获取独立 lease，并在外发前保存 reservation；发送结果不明确或已发送但验证失败时保留 `uncertain` / `sent_unverified`，禁止自动重发。

新一轮 `work-cycle begin` 在生成业务任务历史快照和保存 cycle 之前，先读取计划与近期记忆。Manager 的幂等 GET 使用带超时的有界重试；POST、PATCH 等可能产生副作用的请求不自动重放。近期记忆读取在重试耗尽后失败时，begin 释放计划 lease，并且不留下已启动 cycle 或本轮历史快照；错误继续返回给秘书，不能把稍后一次直接 GET 成功当成本轮 begin 已完成。

全局 strict audit 是观察视图：它对 ledger 使用前后双快照，只有 cycle 身份稳定时才把校验错误列为 `invalid`；审计期间出现、消失或变化的 cycle 只列为 `incomplete`。活动 cycle 或 plan lease 会显示 `quiescent=false`，但不会阻止其它计划；单计划完成门使用 plan-scoped strict audit。只有明确维护或最终 drain 才要求全局 quiescent。线程状态 reconcile 同样只跳过 active 计划并继续处理其它计划。

目标 Codex Route 必须已有精确任务 ID，且不得与执行会话相同。一个执行会话绑定多个计划、workspace 不一致、执行会话上下文人格与计划人格不一致、指定 gateway 不存在或未绑定该人格、同人格存在多个 gateway 却未指定 `gatewayId` 时都失败关闭。此能力在双真实 Desktop 任务验收前保持实验状态。

## 聚焦与长度校验

计划、近期记忆和沉淀记忆的写入都经过后端校验。新增计划、近期记忆或沉淀结果必须显式提供单行 `focus`；`keywords` 至少一个。超出字段长度、关键词数量或总文本长度时，API 返回 `400`，要求 Agent 拆成更聚焦的条目。读取旧文件保持兼容，现有违规条目可通过校验接口发现：

```http
GET /api/roles/:roleId/knowledge-validation
```

默认限制可由角色的 `personaConfig.json` 中 `knowledgeLimits` 收紧：

```json
{
  "knowledgeLimits": {
    "plan": {
      "titleChars": 80,
      "focusChars": 80,
      "currentStepChars": 1200,
      "stepTitleChars": 120,
      "stepDetailChars": 600,
      "stepWaitingForChars": 300,
      "stepBlockedByChars": 300,
      "approvalRequestChars": 600,
      "approvalReasonChars": 600,
      "approvalPathChars": 1000,
      "approvalDetailChars": 800,
      "approvalCommandChars": 2000,
      "approvalListItemChars": 800,
      "maxSteps": 100,
      "nextActionChars": 600,
      "waitingForChars": 300,
      "blockedByChars": 600,
      "sourceSummaryChars": 240,
      "keywordChars": 32,
      "maxKeywords": 24,
      "totalChars": 12000
    },
    "memory": {
      "titleChars": 80,
      "focusChars": 80,
      "contentChars": 4000,
      "sourceSummaryChars": 240,
      "keywordChars": 32,
      "maxKeywords": 24,
      "totalChars": 4600
    }
  }
}
```

字符数按 Unicode code point 计算；`totalChars` 统计该条目的主要文本字段和关键词。一个记忆只记录一个事实、偏好、结论或问题；一个计划只记录一个可推进目标。系统用必填单行 `focus` 和硬长度上限约束结构，语义是否混题仍由写入 Agent 负责拆分。

默认模板的计划状态含义如下；自定义人格以 `personaConfig.json.planWorkflow` 为准：

```text
分析中      Agent 正在调查、拆解或补充执行条件
待审批      审批材料已完整，等待指定审批人决定
执行中      Agent 正在执行当前步骤
等待打包    改动已完成，等待生成可交付包
等待 QA     包已交付，显示为“等待 QA 验收”
待讨论      需要讨论后才能决定下一步
暂停        明确停止继续推进，但保留当前步骤和恢复位置
完成        目标已经完成，保留一段时间供用户确认
关闭        计划已经结束，不再继续执行
```

`archiveStatus=未归档 | 已归档` 单独控制计划是否出现在普通列表中。只有当前状态配置同时满足 `terminal=true` 和 `archiveEligible=true` 的计划可以归档，归档不会改写 `status` key。

## 记忆机制

记忆用于保存 Agent 主动整理出来的上下文。它不是聊天记录的别名，也不是直接从消息日志里截取几条给用户看。

聊天记录、语音转写和心跳事件属于原始事件日志。Agent 本身可以按路径或工具查询这些日志，所以托盘面板不需要把聊天记录伪装成记忆展示。记忆应该是 Agent 看过上下文之后，认为以后仍有价值而主动写入的内容。

记忆不使用人格配置的计划状态目录。页面按记忆自身的生命周期分成三类：尚未沉淀的近期记忆、整理后仍可召回的沉淀记忆，以及已经作为沉淀输入的归档来源。归档来源以 `consolidatedAt` 为准，不新增一套计划状态字段。

推荐目录：

```text
data/roles/<RoleId>/memory/
  recent/
  consolidated/
  consolidation-runs/
```

近期记忆：

```text
memory/recent/*.md
```

近期记忆由 Agent 主动新增或更新。它记录最近一段时间里 Agent 认为值得保留的事实、偏好、判断、阶段性结论或上下文摘要。近期记忆可以通过记忆 ID 修改。写入 `consolidatedAt` 后，来源文件继续保留在 `memory/recent/` 供审计追溯，但 Manager 会把它归入“已归档”，不再计入或显示为近期记忆。

沉淀记忆：

```text
memory/consolidated/*.md
```

沉淀记忆由 RabiRoute 的定时总结流程生成。它是近期记忆经过总结后的稳定记录，在页面中使用独立的“沉淀记忆”标签并继续参与正常召回。沉淀记忆生成后，Agent 不能直接修改已有条目；如果需要修正，只能新增近期记忆说明修正原因，再由下一轮沉淀流程生成新的沉淀记录。

记忆总结记录：

```text
memory/consolidation-runs/*.json
```

用于记录每次总结的输入范围、触发时间、Agent 返回结果和写入的沉淀记忆 ID，方便排障和审计。

近期记忆和沉淀记忆的新写入使用 Markdown：生命周期、来源、关键词和追踪 ID 保存在文件开头的元数据区，正文就是可直接阅读的 Markdown。旧 `.json` 记忆继续可读；同一 ID 同时存在 `.md` 和 `.json` 时，Manager 以 `.md` 为准并只计数一次。WebGUI 支持标题、列表、表格、代码、链接和图文混排；图片只加载 HTTP(S) 地址，本机绝对路径和危险协议不会进入页面。

## 近期记忆和沉淀记忆

近期记忆有两个当前固定时间窗口：

```json
{
  "recentEditableHours": 24,
  "recentConsolidationHours": 72
}
```

默认值：

```text
recentEditableHours = 24
recentConsolidationHours = 72
```

含义：

- `recentEditableHours`：距离最后活跃时间多少小时内的近期记忆允许 Agent 通过记忆 ID 直接修改，默认 24 小时。
- `recentConsolidationHours`：显式请求记忆整理时，用于判断是否已经到期，默认 72 小时。

这两个窗口目前不是 `personaConfig.json` 的公开配置字段。创建一次 Manager API request 时可以用请求参数覆盖本轮阈值。

近期记忆现在区分“查看”和“命中召回”：按 ID 查看会刷新 `viewedAt`，当前消息通过标题或 `keywords` 真正命中并进入读取队列时会同时刷新 `viewedAt` 和 `recalledAt`。更新近期记忆会刷新 `updatedAt` 和 `viewedAt`，但不会伪造一次命中召回。

可编辑窗口和默认上下文仍按 `updatedAt` / `viewedAt` 中较新的时间判断，因此 Agent 明确读取一条旧记忆后仍可在本轮修正它。24/72 小时沉淀判断改用 `updatedAt` / `recalledAt` 中较新的时间；普通按 ID 查看不会推迟沉淀，真正命中召回或修改记忆才会重新计算沉淀时间。

上下文默认显示的记忆也是按 `recentEditableHours` 判断。默认配置下，`[记忆与计划]` 中默认列出最近 24 小时内更新或查看过的近期记忆。超过 24 小时、且尚未沉淀的近期记忆不默认显示；只有用户消息命中标题或 `keywords` 时，才作为命中召回临时列入上下文，并刷新 `viewedAt` 和 `recalledAt`。

记忆整理的输入范围和到期判断由 RabiRoute 处理，不由 Agent 判断。Manager 启动后会读取每个人格最早的 72 小时触发时间，并设置一次性到点任务；记忆在到点前发生更新或真实召回时，实际触发会重新核对并按新的活跃时间安排。用户仍可手动触发 `memory-consolidation`，也可调用 Manager API 创建 request。

默认判断策略是：最不活跃且尚未沉淀的记忆到达 72 小时时，Manager 固定本轮 `triggerAt`，并把 `triggerAt - 24 小时` 固定为候选上限。即使实际执行晚于触发时间，也不会把触发以后才跨过 24 小时边界的记忆追加进本轮；触发前发生更新或真实召回的记忆会按新的活跃时间退出候选。整理 run 保存 `triggerMemoryId`、`triggerAt`、`candidateCutoffAt` 和成功投递后的 `deliveredAt`；Manager 重启时不会重复投递已经由 Desktop 接收的同一 run。列表投影与真实 request 共用这一套算法。Manager 动态返回 `triggersNextConsolidation` 和 `willEnterNextConsolidation` 布尔值；结果随记忆目录缓存，并在新增、修改或命中召回后失效重算。WebGUI 只显示这些结果，不自行重算候选范围。`force=true` 可以跳过到期判断，但仍只收集当前超过输入窗口的记忆。

这条消息属于一种内置手动触发消息。它不是额外开一条特殊私有通道，而是作为 RabiRoute 内置的 `manual_trigger` 进入同一套模板、投递和 Agent 接收流程。

现行记忆整理有两种显式入口：

- 用户主动触发 `triggerId=memory-consolidation` 的内置手动触发项。
- 调用 `POST /api/roles/:roleId/memory/consolidation-requests`。

API 可在单次请求中覆盖 `triggerOlderThanHours`、`includeOlderThanHours` 和 `force`；默认仍为 72/24 小时。自动到点、用户手动触发和 API request 共用同一套候选算法；进入 Agent 端的消息结构保持一致，触发来源记录为 `auto`、`manual` 或 `api`。

Codex Route 可以开启独立记忆整理 Agent。开启后，自动或手动产生的 `manual_trigger + triggerId=memory-consolidation` 只投递到持久 Desktop 任务“`<主人格任务名> 记忆整理`”，默认模型为 `gpt-5.6-terra`；主人格不再接收同一请求。Desktop 不可用、owner 无法确认或投递失败时本轮明确失败，不启动备用 Runtime，也不回退给主人格。该开关只决定由独立任务还是主人格处理，不决定是否按 72 小时自动触发。

Agent 在这次交互里只需要返回沉淀后的记忆，不需要解释触发原因，不需要决定哪些记忆进入本轮整理，也不需要修改原始近期记忆。

请求可以抽象成：

```json
{
  "type": "memory_consolidation_request",
  "routeKind": "manual_trigger",
  "triggerId": "memory-consolidation",
  "triggerName": "记忆整理",
  "triggerSource": "auto",
  "roleId": "Rabi",
  "requestedAt": "2026-06-08T00:00:00+08:00",
  "window": {
    "triggerOlderThanHours": 72,
    "includeOlderThanHours": 24
  },
  "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。",
  "memories": [
    {
      "id": "memory-001",
      "focus": "计划和记忆的维护责任",
      "createdAt": "2026-06-06T12:00:00+08:00",
      "content": "用户希望计划和记忆由 Agent 主动维护，RabiRoute 提供接口。"
    }
  ]
}
```

Agent 返回可以抽象成：

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "计划和记忆维护边界",
      "focus": "计划和记忆的维护责任",
      "content": "用户希望 RabiRoute 的计划和记忆由 Agent 主动维护；RabiRoute 负责提供计划/记忆接口、自动归档和记忆沉淀触发。"
    }
  ]
}
```

当前 manager API 创建沉淀请求时返回 `{ run, memories }`，由后续投递链路把它包装成上述 Agent 消息。结果接收接口为 `POST /roles/:roleId/memory/consolidation-runs/:runId/result`，请求体可以直接使用 Agent 返回的 `memory_consolidation_result`。

Agent 返回总结后，RabiRoute 负责写入结果、记录总结轮次，并更新近期记忆的沉淀标记。Agent 不负责判断何时触发、不负责选择输入范围，也不负责移动或归档记忆文件。

RabiRoute 将结果写入：

```text
memory/consolidated/
```

本实现采用保留近期记忆文件并标记的方式。被总结过的近期记忆会写入 `consolidatedAt` 和 `consolidationRunId`，不再默认展示，也不再进入后续沉淀输入。沉淀结果写入 `memory/consolidated/`，整理轮次写入 `memory/consolidation-runs/`，两边都记录输入记忆 ID 和 run ID，方便追溯。

近期记忆适合记录：

- Agent 刚形成的阶段性判断。
- 用户刚表达、还需要观察是否稳定的偏好。
- 某个计划推进过程中的临时结论。
- 刚发生、未来一两天可能还会用到的上下文。

沉淀记忆适合记录：

- 已确认稳定的用户偏好。
- 已反复出现的项目边界。
- 角色长期需要遵守的行为约定。
- 从多条近期记忆中总结出的稳定事实。
- 已经不需要保留细节、但需要保留结论的历史上下文。

人格文件、成长文件和技能文件仍然是角色基础设定：

```text
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/growth.md
data/roles/<RoleId>/skills.md
```

它们不是沉淀记忆数据库。Agent 可以按已有规则更新这些文件，但这属于角色自我维护，不替代 `memory/recent` 和 `memory/consolidated`。

## Agent 获取机制

计划和记忆不会因为存在于托盘面板里就把全文自动塞给 Agent，但 RabiRoute 会默认注入必要索引和当前关注项。Agent 获取上下文有三种方式。

路径提示：

```text
请遵循 {agentRolePath}。
请读取 {groupLogPath} 查看群聊上下文。
请读取 {privateLogPath} 查看私聊上下文。
计划目录：{agentRoleDir}/plans
记忆目录：{agentRoleDir}/memory
Agent 需要关注的 Rabi 接口：{agentInterfaceDocPath}
```

这是当前最主要的机制。RabiRoute 在路由模板中渲染这些路径，处理端 Agent 收到消息后按需读取。

上下文注入：

```text
当前计划：
- plan-001：完善计划和记忆机制文档

近期记忆索引：
- memory-001：计划和记忆由 Agent 主动维护
- memory-002：记忆整理是内置手动触发消息
```

当前计划会以 ID 和标题的形式注入上下文，让 Agent 知道当前需要关注什么。近期记忆也会以 ID 和标题的形式自动注入，作为可进一步查询或更新的索引。默认不注入计划详情或近期记忆全文，避免每次投递都把上下文塞满。

处理前上下文确认：

```text
[处理前上下文确认]
以下条目与当前消息高相关。回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按 GET 路径读取每一项内容；不要只凭标题行动。
- memory-001：计划和记忆由 Agent 主动维护（recent_memory，score=25） GET /api/roles/Rabi/memory/recent/memory-001
```

RabiRoute 会对未归档计划、近期记忆和沉淀记忆做轻量相关性打分，只使用 ID、标题和 `keywords`。当前计划和活跃近期记忆有小幅排序加成，但无关条目不会仅因为“当前”进入必读队列。必读队列默认最多 5 条，只注入查询路径，不注入全文；Agent 在回复或执行动作前应按 ID 查询内容，无法确认时要说明不确定或先追问。

接口查询和更新：

```text
GET /roles/:roleId/plans
GET /roles/:roleId/memory
GET /roles/:roleId/memory/recent/:memoryId
GET /roles/:roleId/memory/consolidated/:memoryId
POST /roles/:roleId/plans
PATCH /roles/:roleId/plans/:planId
GET /roles/:roleId/plans/:planId/feedback
POST /roles/:roleId/plans/:planId/feedback
POST /roles/:roleId/memory/recent
PATCH /roles/:roleId/memory/recent/:memoryId
```

这些接口已由 Manager 实现。Agent adapter、角色面板或其它本机工作台可以按需查询和更新；`/roles/...` 与 `/api/roles/...` 两种路径前缀均可解析，公开示例优先使用 `/api/roles/...`。

长计划列表使用 `GET /api/roles/:roleId/plans?limit=8&cursor=<offset>&detail=summary&view=<current|plans|archived>&query=<text>` 按每批 8 条读取当前分类和搜索条件下的轻量摘要。摘要包含当前步骤标题、步骤进度和附件数量，WebGUI 收到后立即挂载，不等待正文。卡片接近视口时调用 `GET /api/roles/:roleId/plans/:planId?detail=preview`，只取得正文预览、当前步骤说明、阻塞信息和附件元数据；图片、视频和 Markdown 附件保持在折叠卡片中可见。用户展开后再调用不带 `detail` 的单计划接口读取完整步骤和审批合同；反馈、Agent 实时状态和版本历史继续使用各自的按需接口。后续摘要页使用 `facets=0` 省略已在首页取得的状态和标签统计，每页之间让出一个渲染帧，后台补齐不维持首屏全局加载状态。视口预览最多 4 个并发请求，目录跳转会把目标预览移到队首；离屏卡片使用 `content-visibility`。Manager 对计划列表使用两层增量缓存，并对未变化的计划目录复用已经整理和排序的展示结果。单计划预览和完整详情都优先复用已预热的列表缓存；目录 watcher 合并连续写入，只异步重读发生变化的计划 JSON。规范 POST/PATCH 会直接更新对应缓存项；不支持 watcher 时回退到短 TTL 校验。缓存只保存派生读取结果，计划文件仍是唯一事实源。

记忆列表可使用 `GET /api/roles/:roleId/memory?kind=<recent|consolidated|archived>&limit=24&cursor=<offset>&query=<text>` 分页读取。WebGUI 只请求当前可见的近期、沉淀或已归档记忆分类，首屏最多 24 条，滚动后再继续读取；不会在打开页面时同时传回全部记忆。Manager 对未变化的记忆目录复用解析结果，文件变化后立即使对应缓存失效。浏览器标签页隐藏时，知识页停止继续加载、断开自己的 Manager 事件连接并忽略旧请求结果；标签页重新可见后只补查一次当前分类。

计划接口可以新增计划、更新已有计划、修改状态、更新下一步或归档。记忆接口可以新增近期记忆，也可以通过记忆 ID 修改近期记忆。沉淀记忆不提供直接修改接口。

近期记忆新增和更新都要求保留 `keywords`。RabiRoute 在消息投递前只匹配 ID、标题和 `keywords`，不做智能分词。按 ID 查看近期记忆或沉淀记忆会刷新 `viewedAt`；更新近期记忆会刷新 `updatedAt` 和 `viewedAt`；近期记忆或沉淀记忆真正命中并进入处理前确认队列时会同时刷新该条记忆的 `viewedAt` 和 `recalledAt`。

## 注入时机

默认注入：

- 角色文件路径。
- 当前消息。
- 当前时间。
- 对应消息日志路径。
- route profile 和角色目录路径。
- Agent 需要关注的 Rabi 接口文档链接。
- 当前计划索引，格式为计划 ID 和标题。
- 近期记忆索引，格式为记忆 ID 和标题；默认配置下直接列出最近 24 小时内更新过的近期记忆。
- 处理前上下文确认队列，格式为类型、ID、标题、得分和 GET 路径；默认最多 5 条。

按需注入：

- 计划详情。
- 近期记忆全文。
- 沉淀记忆摘要。

用户明确询问时注入：

- 全量计划列表。
- 计划归档。
- 近期记忆列表。
- 沉淀记忆列表。
- 诊断信息。
- gateway / NapCat / heartbeat 状态。

诊断信息只用于排障，不作为计划或记忆默认注入。

## 更新机制

记忆更新由 Agent 主动发起。RabiRoute 不应该自动把聊天记录变成记忆，只提供新增、修改、读取和沉淀接口。

近期记忆可以修改。Agent 通过记忆 ID 更新已有近期记忆，用于修正措辞、补充上下文或合并重复记录。

查看记忆也是一次可编辑活跃行为。按 ID 查看近期记忆或沉淀记忆时，RabiRoute 自动刷新 `viewedAt`；更新近期记忆时自动刷新 `updatedAt` 和 `viewedAt`；真正命中召回时再刷新 `recalledAt`。近期记忆的默认注入和可编辑窗口按 `updatedAt` / `viewedAt` 中较新的时间判断，沉淀窗口按 `updatedAt` / `recalledAt` 中较新的时间判断。

沉淀记忆不可直接修改。沉淀记忆来自总结流程，生成后只作为稳定记录读取。如果后来发现沉淀记忆不准确，Agent 应新增一条近期记忆说明修正，等待下一轮沉淀生成新的稳定结论。

记忆更新不走计划状态流转。它只需要说明信息从哪里来、何时记录、适用于什么范围；如果一条记忆后来不再适用，应修正近期记忆、追加修正记忆，或通过下一轮沉淀产生新的结论，而不是标记为“已完成”。

计划更新要留下状态和来源。任何写操作都应该更新 `updatedAt`，并尽量保留 `source`，方便以后知道计划为什么出现。

建议更新规则通过 `planWorkflow.roles` 执行。默认模板中，调查、补证据或准备审批使用“分析中”，完整审批合同正式等待回执使用“待审批”，批准或用户明确直接授权后使用“执行中”；包、QA、讨论、暂停、完成和关闭也各自由对应 role 指向状态 key。自定义人格可以调整 key 和显示名称，但不能绕过角色约束。

只有当前状态定义同时满足 `terminal=true`、`archiveEligible=true` 且 `archiveStatus=未归档` 的计划，才会在超过 `planWorkflow.archiveAfterHours` 后改为 `archiveStatus=已归档` 并移动到 `archive/`。归档不改变 `plan.status`。

Qt 托盘和 RibiWebGUI 不直接创建、完成、删除或迁移计划；计划主体仍由 Agent 通过 Manager 维护。对于 Manager 标记为 `approval.enabled=true` 的当前步骤，两端可以提交正式审批建议。RibiWebGUI 只在 Manager 返回 `presentation.acceptsGuidance=true` 且计划没有进入审批步骤时提供计划级引导入口：引导只关联 `planId`，不关联某个 `stepId`，Agent 可据此调整计划说明、执行方向和后续步骤。审批和引导都只追加审计记录并可选通知 Agent，不直接修改计划状态或步骤。WebGUI 统一使用“提交并投递”和“提交”两个动作；“提交”只保存 `record_only` 记录，不要求 Route、不触发 Agent 或 QA 后处理，Agent 可在空闲时读取审阅。

计划分页接口还支持 `sort=<status|updated|importance|urgency>`、可重复的 `status=<状态 key>`、可重复的 `tag=<keywords 标签>` 和 `facets=0`。`updated` 比较 `updatedAt` 时间戳；其余三种排序比较 Manager 生成的整数等级。状态等级来自状态配置的 `order`，并通过 `statusLevel` 返回；重要程度 `importance` 和紧急程度 `urgency` 都使用 `0–4`：`0` 最高，`1` 高，`2` 中，`3` 低，`4` 未设置。旧 `priority` 字符串只在读取边界转换为重要程度整数；旧计划没有 `urgency` 时，可由 `dueAt` 转为兼容等级。排序过程不比较标签文字。响应同时返回状态 key、配置的中英文名称与说明、色板、视图和等级，WebGUI 只负责显示。筛选与排序都在分页前执行。

## 计划引导与审批意见

计划反馈是保存在同一计划目录 `feedback.jsonl` 的独立 JSONL 审计记录。`kind=guidance` 表示只关联 `planId` 的计划级引导，不能携带 `stepId`；`kind=approval_suggestion` 表示关联审批步骤的正式审批意见。它们都不是计划 JSON 的第二份副本，也不是通用 Outbox Action Queue。

读取接口返回折叠同一 `feedbackId` 投递状态后的完整 `records`。RibiWebGUI 在任何计划的详情中都可以按需读取这些记录；已批准、已完成和已归档计划仍保留计划引导历史与审批意见历史。`latest` 只用于轻量摘要与投递状态判断，不再替代完整意见历史。

```http
GET  /api/roles/:roleId/plans/:planId/feedback
POST /api/roles/:roleId/plans/:planId/feedback
```

## 计划版本留痕

计划 JSON 保存当前状态；每次创建、更新和归档还会向同一计划目录的 `history.jsonl` 追加一次完整计划快照。快照保留当时的步骤、审批合同、状态和时间，因此后续 Agent 可以复核某次审批完成前后的真实计划内容。

```http
GET /api/roles/:roleId/plans/:planId/history
```

RibiWebGUI 在计划详情中提供默认折叠的“工作留痕”。其中分别显示计划引导、步骤审批意见和计划版本记录；计划完成、整个目录移动到 `plans/archive/<planId>/` 或不再处于待审批状态，都不会让这些记录从界面消失。归档只改变计划默认所在视图和计划 JSON 的目录，不删除反馈文件、反馈附件或版本留痕。删除本地运行数据仍属于单独的人工文件操作，不是计划生命周期动作。

RibiWebGUI 提交计划引导时使用 `kind=guidance`、`author=user`、`source=webgui`、`notifyAgent=true`，且不传 `stepId`；Manager 只接受状态定义允许引导，即 `presentation.acceptsGuidance=true`，且没有进入审批步骤的计划。WebGUI 或托盘提交审批时仍使用 `kind=approval_suggestion`、`author=user`、`source=webgui|tray` 和 `notifyAgent=true`。计划引导和审批使用同一个反馈输入组件，共享 `@` 引用计划附件、键盘提交、文件选择、剪贴板粘贴、附件预览和删除能力；以后新增输入能力也应在该组件中同时提供。新上传内容写入同一计划目录的 `feedback-attachments/<feedbackId>/` 私有运行目录，JSONL 不内嵌二进制。两种反馈都会先同步记录并立即返回 `deliveryStatus=pending`：业务绑定完整时通过 `/api/agent/threads` 和 Desktop IPC 直达原业务任务；启用计划秘书时，负责 `secretaryBinding` 同时收到控制通知，主人格不接收每次自动投递通知。业务绑定不完整时完整反馈优先交给负责秘书；只有没有可用秘书时才回退给主人格。owner 未加载时保持 `pending` 并有界重试；只有目标 owner 接受 `start/steer` 才记录 `delivered`。终态发布 `plan_feedback_changed`，WebGUI 只刷新当前计划的反馈摘要。

Agent 收到 `guidance` 后，应先读取当前计划与反馈，把引导视为整个计划的方向输入；如果范围、优先级、方法或后续路径变化，显式 `PATCH` 计划并同步调整后续步骤，随后以 `kind=guidance_response`、`author=agent`、`notifyAgent=false` 回写同一 `planId`，且不带 `stepId`。收到 `approval_suggestion` 时仍更新对应计划/步骤与审批回执，并以 `approval_response` 回写同一 `planId / stepId`。两种记录本身都不会自动推进计划。

后台通知上一条反馈期间，WebGUI 允许继续编辑下一条内容，但在上一条取得终态前禁止再次提交，并显示原因与恢复条件。计划引导入口只出现在 `presentation.acceptsGuidance=true` 且未进入审批的计划；审批计划继续只显示对应步骤内的审批合同与审批输入。

## Manager 展示顺序与计划视图

Manager 的计划 API 以当前步骤的 `approvalRequest` 为唯一审批入口合同：合同完整、可提交且 `responseStatus=pending` 时，`presentation.approval.state=ready`、`enabled=true`，并要求存储状态为 `planWorkflow.roles.approval` 指向的 key；合同缺项时返回 `incomplete`，计划必须保持 `roles.analysis` 指向的 key。旧 `isBlocked` 仅为兼容投影，`blockedBy` 仅为说明，二者都不能改变计划状态。

Manager 把 `plan.status` 作为状态 key，并通过 `presentation.label / labelEn` 提供显示名称；说明、色板、顺序和视图也来自同一条状态配置。客户端显示配置名称，不直接把 key 当作界面文字，也不产生另一项显示状态。

`nextAction`、`currentStep`、步骤标题和 `waitingFor` 只解释下一步与等待原因，不能改写 `plan.status`。

内容变更计划通过 `planWorkflow.roles.execution / package / qa / completed` 对应的状态推进；QA 失败回到 `roles.analysis` 或 `roles.execution`。默认模板显示为“执行中 → 等待打包 → 等待 QA 验收 → 完成”。Agent 只在同步、提交和无冲突回读证据齐全后写 package role 的 key，只在目标包证明纳入后写 QA role 的 key；Manager 校验这些证据，但不从步骤或正文自动切换状态。QA 发送回执属于 QA 阶段内的证据，不创建额外主状态。

`presentation.status` 必须与 `plan.status` 的 key 完全相同，显示使用配置的 `label / labelEn`。状态排序取配置 `order`，视图成员关系取配置 `views`；同一状态内再按更新时间排列。归档视图只由 `archiveStatus` 决定，与任何关闭 role 的 key 无关。

秘书执行 `reconcile-thread-statuses` 时也消费同一份 Manager `presentation`，再与问题账本和最近闭环中的结构化发送/环境证据交叉核对。终态与完整待审批分别归为 `terminal / blocked`；暂停计划归为 `frozen + paused`，且固定 `implementationDispatchAllowed=false`；`waiting_package` 和具有当前、未被同一 PID/工程权威 release 证据覆盖的 `waiting_environment* + environment-owner` 唯一环境占用归为 `frozen`。结构化 dependency 当前步骤或 tracking 状态只有在明确等待其它计划原 owner 完成、同时 plan/issue/cycle 明确当前没有独立 CLI、控制面或业务动作时，才进入 `frozen_until_dependencies`；仍需联系或协调 owner、补合同、取得回复，或仍有 CLI、重试和替代路径时继续 `actionable`。QA 或普通询问已有真实 `status=sent / sentMessageId` 回执，且 issue/cycle 明确当前只等待结果、无独立本地动作、没有另一个待发送或待结果的校对/确认请求并禁止重发时，归为稳定 `waiting_result`；旧 QA 回执不能覆盖后来新增的负责人校对或位置确认。回执可来自结构化 issue evidence 或最近 cycle summary，不受后续计划更新时间和普通去重窗口影响。普通询问仅有近期发送证据时仍使用 `waiting_result_dedup`。只有仍有本地动作、缺真实发送/回执、已到追问时间且明确需要追问、存在另一项独立询问、可重试或存在替代路径的空闲计划保留为 `actionable`；已发送但仍有本地动作时不重复询问。对账结果分别返回 `frozenIdle`、`waitingResultIdle` 和 `actionableIdle`。`implementationDispatchAllowed` 只在当前仍允许实施任务继续运行时为 `true`；终态、暂停、审批阻塞以及没有实施动作可做的包、跨计划依赖、测试环境、重新授权和 QA 结论等待都返回 `false`。

对新增细分状态，`waiting_package` 返回 `frozen_until_package + wait_for_target_package`，无独立动作的跨计划依赖返回 `frozen_until_dependencies` 且 `requiredAction=null`，真实测试环境等待返回 `frozen_until_test_environment + wait_for_test_environment`，等待重新授权返回 `waiting_for_authorization + request_authorization`；这些等待的 `implementationDispatchAllowed` 都是 `false`。绿色 QA 阶段同样禁止实施投递：缺回执但仍可发送或修复时返回 `actionable + send_qa_request`；已有真实 QA 回执且只等结论时返回 `waiting_result + wait_for_qa_result`。strict audit 会拒绝“QA 步骤已写只等结论但没有本轮真实回执”的矛盾计划。CLI 或替代验证仍可执行时保持 `actionable`；普通外部资料继续使用 `inquire_until_result`。

Qt 托盘和 RibiWebGUI 的角色知识界面都消费这份 Manager DTO、阶段汇总、配置视图、状态色板和配置顺序。RibiWebGUI 使用“当前计划 / 近期记忆 / 沉淀记忆 / 已归档”四个标签；已归档同时包含 `archiveStatus=已归档` 的计划和带 `consolidatedAt` 的来源记忆。已归档计划不参加关键词召回。两端显示 `presentation.label / labelEn`；缺少有效 `presentation` 时失败关闭，不能把 key 当显示名称，也不能从步骤或正文派生替代状态。

首次进入 RibiWebGUI 只请求当前标签的一页：计划摘要最多 8 条并优先补齐这 8 条详情，记忆最多 24 条；后续页只在滚动到加载哨兵或点击“加载更多”后请求。保留下一页 cursor 不代表仍在加载，首屏不再自动遍历全部计划或记忆分页。

## 托盘视图

当前：

```text
“当前”展示 `archiveStatus=未归档` 且状态配置的 `views` 包含 current 的计划；“计划”展示配置允许进入 plan 视图的未归档计划；“已归档”只由 `archiveStatus=已归档` 决定。已归档计划不参与关键词召回。客户端显示配置 label，不从内部等待原因创建新徽标。
```

近期记忆：

```text
展示 Agent 最近主动记录、且仍处在可修改或待沉淀窗口内的记忆。
```

沉淀记忆：

```text
展示由记忆总结流程生成、Agent 不能直接修改的稳定记忆。
```

计划 / 记忆总览：

```text
展示正式计划汇总、近期记忆摘要、沉淀记忆摘要，以及它们的当前可用状态。
```

诊断：

```text
展示 manager、gateway、NapCat、heartbeat 和状态文件摘要。
```

托盘视图主要服务用户观察。是否把其中内容交给 Agent，由路由模板、摘要注入或 Manager API 决定。

计划可选 `messageChannels` 列表，Agent 可在创建计划或 PATCH 时绑定；省略或 `[]` 均合法，不阻断建计划、执行或人格事件投递。每项为 `{channel, gatewayId, params}`，复用事件投递的 NapCat 群／个人 QQ 与语音参数。计划渠道只用于绑定 Codex 任务的最终结果；与人格规则共同匹配，同一任务、轮次、目标去重。Hook 自动通知不要求原始群消息编号，也不被旧引用式进度通知的失败阻断；Agent 主动回复仍尽量引用来源。

## 计划写入校验与并发边界

计划状态配置决定是否允许 `currentStepId`。转入 `currentStep=forbidden` 的完成状态时，PATCH 必须显式传 `currentStepId: null`；历史步骤可保留，不能把人工完成虚构成所有历史步骤都执行过。

写入前的计划内容校验返回 HTTP 400、`state=invalid_request`、`commitState=not_started` 和具体原因；带幂等键的请求同时返回 `retry=correct_request_with_new_idempotency_key`。调用方确认拒绝后修正内容，使用新幂等键提交；不要无限重试旧内容。真实超时、进程丢失或提交结果无法证明时仍返回结果不确定，只能回读并使用原键和原内容恢复。历史上被误判为不确定的校验失败，可用原请求重放：存储拥有者先恢复事务、核对未变更的版本，再把确定拒绝写成终态回执；不得手改回执。

单计划写入的版本检查按规范存储位置定位目标计划，不读取全人格计划列表。当前存储写入池仍是一个有界串行队列（默认最多等待 32 项），不是无限并行写入；队列满时拒绝新增工作。客户端应限制在途请求、对临时繁忙退避，独立 GET 可使用有界并发。跨人格写入分片和批量接口需要另行验证锁、generation 隔离、过载公平性及 p95/p99 延迟后再启用。

单计划读取仍检查 active/archive 的全部文件位置，包含错放目录中的重复逻辑 ID。进程内身份缓存只保存可重建的文件 ID，最多 4096 项；每次使用前核对设备、文件身份、大小、mtime 和 ctime，新增、替换或变化文件重新解析，读取中发生变化则重试一次后明确失败。目标计划正文仍从既有入口读取，缓存不成为计划事实源。热读跳过无关文件正文与完整计划规范化；冷读和目录枚举仍随计划数增长。异步路径保持有界并发和取消，不提高读 worker 数量或进程优先级。性能改善需区分夹具热读结果与当前运行代的真实端到端验收。


计划与记忆摘要搜索及自动增量缓存接口见 [搜索合同](knowledge-search.md)。
