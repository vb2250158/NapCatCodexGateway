# 计划与记忆摘要搜索

English: [Knowledge search](knowledge-search_en.md)

Manager 为每个人格维护一份派生内存索引。文件仍是事实源；搜索不写入计划或记忆，也不会刷新阅读时间。Agent 使用 Rabi 自带的 `rabi-knowledge-search` 技能，在线先查询摘要，再按需读取现有详情接口。

## 接口

全部接口沿用 Manager 的身份发现、鉴权及只读约束。

| 请求 | 用途 |
| --- | --- |
| `GET /api/roles/:roleId/knowledge/search?query=主题&limit=10` | 关键词摘要搜索 |
| `GET /api/roles/:roleId/knowledge/search?query=正文片段&mode=fulltext&limit=10` | 显式内存全文搜索 |
| `GET /api/roles/:roleId/knowledge/cache/status` | 就绪状态、版本、条目数、读取和索引计数、刷新异常 |
| `POST /api/roles/:roleId/knowledge/cache/reload`，正文 `{}` | 排障时检查目录差异 |
| 同上，正文 `{"kind":"plan","id":"example"}` | 强制重新读取指定条目 |
| 同上，正文 `{"all":true}` | 后台重建整个人格索引 |

日常刷新自动执行，Agent 无需调用 reload。`kind=plan|recent|consolidated` 限定类型，`archived=1` 将归档条目一并纳入。默认 limit 为 10，最大 100。关键词按 NFKC 和大小写规范化，匹配 ID、完整标题和 keywords；空白分隔查询词取并集。中文查询应提取主题关键词；全文模式对预先整理的文本做子串搜索，不会隐式退回磁盘扫描。

响应 `data.items` 包含 ID、类型、标题、focus、keywords、状态、归档标志、更新时间、阅读时间、版本、最多 160 字符的 excerpt、matchedBy 和详情地址。分页使用 `data.nextCursor`，保持查询条件；索引版本变化返回 409，重新从第一页查询。冷索引返回 503。详细记忆读取沿用现有阅读时间策略。

## 刷新与成本

Manager 持有关键词到条目引用、条目摘要与搜索文本、条目到旧关键词的映射。关键词查询只访问命中集合；全文查询扫描内存文本。两种热查询均不访问文件系统。基础信息变化更新摘要；关键词映射仅在 ID、标题或 keywords 变化时重建，viewedAt 变化不重建映射。

单条近期记忆创建、修改和阅读成功后只回读并发布该条投影，不再捕获整个人格的知识快照。现有写入锁、版本和幂等合同保持有效。存储层为兼容旧格式执行的身份检查与新索引读取计数分别统计，不能将索引零读取理解为所有写入零扫描。

启动先建立监听，再由有界读取 Worker 收集文件。API 提交直接发布单条变更；监听合并约 150 毫秒内的事件。Worker 核对文件指纹，只解析变化文件；重复事件不重复更新关键词。约每 60 秒检查目录元数据，修复遗漏事件；远程共享目录使用这一后台校验。目录枚举仍随条目数增长，但不位于搜索请求路径。

全量重建继续提供上一份有效索引，通过变更序号拒绝过期构建结果。文件解析失败或读取异常保留有效记录，并自动重试；未完成的冷索引不作为完整结果返回。删除清理旧关键词；身份冲突明确报告异常。缓存状态中的 filesRead 仅统计已接收 Worker 批次的文件读取，不代表进程总 I/O。

## 验证

`roleKnowledgeSearch.test.ts` 验证旧词清理、阅读时间、隔离和游标；`knowledgeSearchService.test.ts` 验证自动监听、无变化校验零正文读取、热搜索不调用存储及重建并发；`knowledgeSearchRoutes.test.ts` 验证 HTTP 摘要与参数合同。性能数值应使用相同数据集另行测量，不能用结构测试声称线上延迟收益。
