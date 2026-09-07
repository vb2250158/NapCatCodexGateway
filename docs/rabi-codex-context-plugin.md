<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-codex-context-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context 插件

> 状态：0.4 统一上下文与计划任务完成 Hook 版本。计划完成提醒仍为实验能力；源码位于 `plugins/rabi-codex-context/`。

该插件只注册并执行自身 `PLUGIN_ROOT` 下的 Hook。安装、升级和运行均不改写其他插件的 `hooks.json`、市场条目或启用状态，可与独立的语言风格 Hook 同时加载。

## 人格聊天记录

Manager 在 `Stop` 收到非空 `last_assistant_message`（或 `lastAssistantMessage`）和 `turn_id`（或 `turnId`）时，将完整正文追加到唯一归属人格的 `chat-history/final-replies.jsonl`。归属复用显式 Hook 绑定、Route 任务及计划/秘书/消息处理任务绑定；归属冲突或缺失时不写入。Codex 和通过同一 Hook API 上报的 DSH 回复共用此入口，不读取桌面聊天数据库或补录旧消息。

`GET /api/roles/:roleId/chat-history?limit=50&cursor=<byte-offset>` 返回 `entries` 和 `nextCursor`，按追加顺序倒序读取；cursor 省略时从最新位置开始，`nextCursor=null` 表示已到最早记录。正文不截断，分页最多 100 条且达到约 1 MiB 后提前返回游标。`sessionId + turnId + 正文` 的摘要用于重复回调去重。追加成功后发布 `persona_chat_history_changed`，WebGUI 仅在聊天记录标签激活时读取，支持重连刷新与手动翻页。该记录动作独立于计划完成通知开关，并保留现有启动恢复门禁。

## 唯一边界

Rabi PC / RabiRoute Manager 是以下事实的唯一管理者：

- 人格目录与配置；
- Codex `session_id → RoleId` 绑定；
- 计划、近期记忆、沉淀记忆和角色技能；
- 关键词召回、`viewedAt`、计划归档、记忆编辑窗口与整理流程。

Codex 插件只做薄转发：把 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop` 原样提交给 Manager；上下文事件把 Manager 返回的 `additionalContext` 注入 Codex，`Stop` 只上报官方提供的 `session_id`、`turn_id`、`cwd` 和 `last_assistant_message`。插件不扫描角色目录、不解析计划记忆、不评分关键词、不保存绑定，也没有离线知识缓存。

```text
Codex Hook 事件
  -> POST /api/codex-hook/context
  -> Rabi PC Manager 会话绑定
  -> RabiContextManager 统一触发策略、召回与副作用
  -> roleKnowledgeSnapshot() 唯一调用入口
  -> 共享 RoleKnowledgeContextView
  -> additionalContext
  -> Codex Hook 注入

RabiRoute 消息投递
  -> message_delivery 标准触发
  -> 同一个 RabiContextManager
  -> AgentPacket

Codex Stop
  -> Manager 按计划 taskBinding 精确匹配执行会话
  -> 角色面板 timeline
  -> Forwarding / AgentPacket
  -> 提醒人格 Route 绑定的精确处理会话
```

## 统一触发策略

| 标准触发 | 来源 | 上下文形式 | 生命周期 |
|---|---|---|---|
| `session_start` | Codex `SessionStart` | 完整入口上下文 | 正常归档；按需重发人格 |
| `user_prompt` | Codex `UserPromptSubmit` | 完整入口上下文 | 正常召回并刷新命中记忆 |
| `reasoning_pre_tool` | Codex `PreToolUse` | 本轮新命中的增量 | 不重复归档；新命中才刷新 `viewedAt` |
| `reasoning_post_tool` | Codex `PostToolUse` | 本轮新命中的增量 | 同上，可发现工具结果产生的新计划或记忆 |
| `message_delivery` | RabiRoute 正常消息投递 | 完整入口上下文 | 服从现有计划、记忆和整理机制 |
| `preview` | Manager / UI 预览调用方 | 完整预览 | 不归档、不刷新 `viewedAt`、不创建整理 run |

推理期 Hook 不会把每个工具输入和输出复制进 prompt。Manager 只用有界文本对同一套 ID、标题和 `keywords` 元信息评分；没有知识命中或明确 Rabi 知识路径时返回空上下文。相同 `turn_id` 下按“条目类型 + ID + 修订时间”去重，避免 Pre/Post 重复注入和重复刷新 `viewedAt`。

## WebGUI Hook 管理

Codex 处理端配置面板显示三组 Hook 开关，并直接说明触发时机：

| 开关 | Codex Hook | 何时触发 | 默认值 |
|---|---|---|---|
| 会话入口上下文 | `SessionStart` / `UserPromptSubmit` | 打开、恢复、清空或压缩任务，以及用户提交新消息时 | 开启 |
| 推理期上下文刷新 | `PreToolUse` / `PostToolUse` | Codex 调用工具前后；只注入本轮新命中的计划、记忆或技能上下文 | 开启 |
| 计划任务会话完成通知 | `Stop` | 绑定计划的执行任务输出本轮最终回答后，经 Rabi 投递到该人格 Route 绑定的会话 | 开启 |

配置分别写入 `codexHooks.sessionContextEnabled`、`codexHooks.reasoningContextEnabled` 和 `codexHooks.planTaskCompletionEnabled`。开关只控制 Manager 是否响应对应 Hook；插件中的 Hook 注册保持不变，因此重新开启不需要重装插件。没有 Route 精确绑定到计划执行任务时，Manager 对该执行任务继续使用默认开启值，让独立计划任务仍可上报 `Stop`；提醒目标 Route 自己关闭完成通知时则失败关闭。

## 计划任务完成 Hook

计划可用 `taskBinding` 精确绑定一个 Codex 执行会话。存在 `taskBinding` 且省略 `completionHook` 时，完成通知默认开启；可用 `completionHook.enabled=false` 对单个计划关闭。当该会话完成一轮并产生最终回答后，`Stop` Hook 把官方 `last_assistant_message` 交给 Manager。Manager 以计划文件为“计划 ↔ 执行会话”真源，以 Route/gateway 为提醒人格目标会话真源；提醒继续走现有角色面板、Forwarding、AgentPacket 和 Agent adapter 链路。

- 同一 `sessionId + turnId` 持久化去重。
- Hook 不读取 transcript 猜测结果，也不自动修改计划状态、步骤或记忆。
- 目标 Codex 会话必须已精确绑定，且不得与执行会话相同；workspace、人格或 gateway 冲突时失败关闭。
- 成功时 `Stop` 不输出任何 Hook JSON；投递失败时只返回非阻塞 `systemMessage` 警告，不阻断 Codex 最终回答。
- 完成记录写入私有运行文件 `data/codex-hook/sessions.json`，不得提交。

## Codex-only 模式

只使用 Codex 的用户仍需安装并运行 Rabi 的 Manager 上下文服务，但不需要启动消息网关、Relay 或发现服务：

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

该模式不启动 Route 配置轮询；人格、计划、记忆和技能仍在每次 Hook 请求时从 Manager 当前 `rolesDir` 读取，显式修改 Manager 配置后也会立即使用新的目录。这样知识服务可以在 NAS 工作区长期运行，而不会为了未启动的 Gateway 反复扫描和迁移 Route 配置。

人格目录通过 Rabi PC / Manager 的 `rolesDir` 配置管理。插件不再提供 `source add`，也不再使用用户目录下的插件私有 `roles/`。

### 从 0.1 插件迁移

0.1 版插件保存在插件用户目录里的角色根注册和 session 绑定不会自动迁移到 Manager。升级到 0.4 后，先启动 Rabi PC Manager，再按准确的完整 `session_id` 重新绑定人格；不要根据任务标题、工作区或最近时间猜测 ID。旧实现只保留在 `archive/plugins/rabi-codex-context-v0.1.0-local-context/` 作为只读迁移参考，不能重新接回活动调用链。

新的绑定写入 Manager 私有运行数据 `data/codex-hook/sessions.json`。该文件、旧插件用户目录和任何真实人格数据都不得提交。

## 会话控制

任务内严格控制标记：

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

标记由 Manager 解释。普通自然语言不会修改绑定。Rabi PC 也可以通过准确的完整 session ID 主动管理绑定：

```text
PUT    /api/codex-hook/sessions/{sessionId}  { "roleId": "YeYu" }
GET    /api/codex-hook/sessions/{sessionId}
DELETE /api/codex-hook/sessions/{sessionId}
```

不要用任务标题、工作目录或最近时间猜测 session ID。

## Manager API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/codex-hook/context` | 接收原始 Hook 事件并生成统一上下文 |
| GET | `/api/codex-hook/roles` | 列出 Manager 当前人格 |
| GET | `/api/codex-hook/sessions` | 列出 Manager 持有的 Codex 绑定 |
| GET/PUT/DELETE | `/api/codex-hook/sessions/{sessionId}` | 查询、主动绑定或解除 |
| GET | `/api/codex-hook/doctor` | 检查 rolesRoot、角色和绑定状态 |

绑定状态保存于 RabiRoute 私有运行目录 `data/codex-hook/sessions.json`，不属于插件数据，也不得提交。

## 召回与整理

Manager 让所有标准触发通过 `RabiContextManager` 调用现有 `roleKnowledgeSnapshot()`：

- 使用同一套 ID、标题、`keywords` 评分；
- 使用同一套进行中计划与活跃近期记忆加成；
- 生成同一套 `[处理前上下文确认]` 和 GET 路径；
- 命中近期/沉淀记忆时刷新 `viewedAt`；
- 继续服从现有计划归档、记忆编辑窗口、校验和 consolidation API。

Hook 不直接注入命中条目的全文。Codex 必须按 Manager 返回的 GET 路径阅读全文，再通过既有计划/记忆 API 更新；不能直接改 JSON 冒充生命周期成功。

## 安装与验收

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

安装或更新后新建 Codex 任务，并在 `/hooks` 审阅信任命令。验收要求：

1. Manager 离线时插件不使用本地知识回退。
2. 未绑定会话收到空上下文。
3. `[rabi:use <RoleId>]` 同一轮由 Manager 完成绑定和注入。
4. 关键词命中走 `roleKnowledgeSnapshot()` 并刷新对应记忆 `viewedAt`。
5. 两个 session 可绑定不同人格，互不串线。
6. Rabi PC 可以按完整 session ID 主动绑定和解除。
7. `SessionStart` 在启动、恢复、清空和压缩时向 Manager 请求重新注入。
8. `PreToolUse` / `PostToolUse` 只在命中相关知识或明确 Rabi 知识路径时注入推理期增量。
9. 同一 turn 的重复命中不会重复注入或重复刷新 `viewedAt`；条目更新后允许重新注入。
10. 正常 RabiRoute 消息投递与 Codex Hook 共用 `RabiContextManager`，代码中没有第二个 snapshot 调用入口。
11. 绑定计划的 `Stop` 只向指定人格 Route 投递一次最终回答提醒；计划顶层为 `暂停` 时忽略提醒，未绑定、重复 turn、workspace/人格/gateway 冲突和源目标同会话均失败关闭或忽略。
12. 完成提醒成功时 Hook stdout 为空；失败只产生非阻塞系统警告。更新插件后必须在 `/hooks` 重新审阅并信任新增的 `Stop` Hook。

代码和本地 mock 测试不等于 Desktop 实机验收。未在两个真实 Codex Desktop 任务之间观察到提醒前，本能力保持实验状态。
