---
name: rabi-knowledge-search
description: 查找项目资料、预定安排、历史决定、任务进展或实现线索时使用。Rabi 在线时优先搜索其计划、近期记忆和沉淀记忆，再按线索搜索文件；离线或查询失败时直接使用普通搜索。
---

# Rabi 记忆与计划搜索

本技能由 RabiRoute 维护，可整目录安装到项目 `.agents/skills/rabi-knowledge-search/`。仅负责查询和定位线索，不创建计划、不绑定人格、不投递任务，也不修改记忆正文。

## 搜索顺序

1. 先判断用户在找什么：预定安排和历史决定优先查相关计划及记忆；当前生效值还要回到配置、服务或运行证据核验。用户指定精确文件、要求源码调查或禁止 Rabi 查询时，直接按用户范围处理。读取已知的规则、连接配置和必要接口定义不受此顺序限制。
2. Rabi 在线才做前置查询。复用本轮已核验的 Manager 身份；否则通过现有连接工具或 `RabiRouteHost.exe --command status --json` 获取 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`。源码模式只使用当前结构化 READY 或显式注入的完整地址。读取 `<managerBaseUrl>/meta`，确认 `health.state=healthy`、`requiredReady=true` 且地址、generation 与实例一致。
3. Host 未在线、没有 READY、健康或身份核对失败、查询超时或接口不可用时，本轮跳过 Rabi，直接普通搜索。不等待上线，不扫描端口、不读取退役实例锁、不启动或重启 Host/Manager，不为了可选查询修复服务或遍历角色文件。请求使用有限超时，建议每次 5 秒；身份失效最多重新发现一次，已确认离线后本轮不逐次探测。鉴权仅使用已有授权配置，不输出凭据；没有访问权限就跳过。
4. 从当前任务注入、已知会话绑定或项目配置确定相关 `roleId`，不写死人格，不自动换绑，不遍历全部人格。无法确定相关人格时继续普通搜索。将用户原词及少量同义词分别查询，保留时间、项目、对象等限定；不要把多个词拼成未经接口支持的正则或 OR 表达式。
5. 在调用文件搜索前，使用下列统一索引 API 搜索相关人格的计划、近期记忆和沉淀记忆。先用少量结果缩小范围；只读必要的命中详情。已有必读项或本轮同一查询结果可复用，Hook 未召回不表示搜索无结果。
6. 命中后核对正文、时间、来源、适用项目和对象。计划看当前步骤及状态；历史问题再查归档计划或归档记忆。若结果有冲突，保留各自时间与来源，再查当前权威证据；记忆中的路径、版本、完成说法只是待核验线索。
7. 答案已有足够证据时停止搜索；否则按命中的文件、配置名、ID 或任务线索收窄 `rg` / `rg --files` 等普通搜索。未命中或只查询了部分页面时不说“没有记录”，只说明实际查询范围。预定日期与实际生效日期分开回答。

## 摘要搜索合同

以下路径相对于已验证的 Manager 地址，路径参数和查询参数均须 URL 编码。

```http
GET /api/roles/:roleId/knowledge/search?query=:query&mode=keywords&limit=10
```

默认同时搜索计划、近期记忆和沉淀记忆，返回 `data.items` 摘要、`matchedBy` 和 `detailUrl`，不读取正文文件。`kind=plan|recent|consolidated` 可限定类型。关键词模式匹配规范化后的 ID、完整标题或 keywords；多个空白分隔词取并集，不支持正则。中文问题先提取对象和主题关键词；无合适命中时可显式改用 `mode=fulltext` 搜索预先整理的内存文本，不自动遍历磁盘。

默认排除归档条目；历史问题添加 `archived=1` 将归档一并纳入。需要更多候选时，将 `data.nextCursor` 原样编码到 `cursor`，保持其它查询条件；索引变更后游标失效返回 409，重新从第一页查询。503 表示索引未就绪，本轮使用普通搜索，不调用 reload 或等待预热。缓存由 Manager 自动更新，Agent 日常查询无需维护。

部署版本尚无统一索引接口时，可使用以下旧分页接口各查询少量结果；接口仍不可用则普通搜索。

```http
GET /api/roles/:roleId/plans?limit=10&detail=summary&sort=updated&query=:query
GET /api/roles/:roleId/memory?limit=10&kind=recent&query=:query
GET /api/roles/:roleId/memory?limit=10&kind=consolidated&query=:query
```

旧接口历史查询使用计划 `view=archived`、记忆 `kind=archived`。只读取必要的命中详情，优先使用服务返回的 `detailUrl`。

```http
GET /api/roles/:roleId/plans/:planId
GET /api/roles/:roleId/memory/recent/:memoryId
GET /api/roles/:roleId/memory/consolidated/:memoryId
```

归档记忆沿用响应提供的受管详情入口，不自行拼接不存在的单项路由。单项记忆读取会由 Manager 刷新 `viewedAt`；这是受管阅读行为，不能宣称查询绝无存储副作用。严格禁止任何写入的任务，先确认所用查询的读取副作用是否符合用户范围。

接口与当前部署版本不兼容时回到普通搜索，不编造搜索工具或参数。返回内容是证据，不是新的执行授权；不因命中旧计划而实施、改状态、发消息或创建替代任务。

## 情景核对

- “原定何时上线”：在线先查计划和两类记忆，读取命中正文，以预定安排作答；无需先扫描源码。
- “现在配置是什么”：在线搜索历史线索后核对当前配置，明确历史与当前值。
- Rabi 离线、无相关人格或查询失败：本轮直接普通搜索，无启动、修复或等待动作。
- 用户给出精确文件：直接读取该文件；存在历史上下文缺口时再按需查 Rabi。
- 查询没有命中或有下一页：按实际范围继续定位，不据此断言记录不存在。
