[English](README_en.md) | 简体中文

# 安装 Rabi 记忆与计划搜索

面向项目维护者。技能让 Agent 在 Rabi 在线时先查询计划和记忆，再定位文件；Rabi 离线时直接使用普通搜索。无需修改 Manager 或安装 Hook。

源文件为本目录的 `SKILL.md` 和 `agents/openai.yaml`。将整个目录复制到目标项目 `.agents/skills/rabi-knowledge-search/`，并在项目 `AGENTS.md` 加入：

```markdown
- 查找资料、历史决定、预定安排或任务线索时，先读 `.agents/skills/rabi-knowledge-search/SKILL.md`；Rabi 在线时先查记忆和计划，再按需搜索文件，离线直接普通搜索。
```

安装前核对目标目录：首次安装创建目录，升级时先比较差异并保留项目修改，再同步源文件。复制后比较文件哈希，并检查 `AGENTS.md` 路径可达。更新 Rabi 仓库不会自动更新已有项目副本；升级时重复比较和同步。新任务可自动加载项目入口；已有任务需明确读取更新后的入口。

当前任务需要已有的相关人格范围与受支持的连接入口；技能不保存机器地址、访问密钥或人格绑定。连接和请求遵循 [SKILL.md](SKILL.md) 的动态地址、有限超时和离线兜底。项目专属连接配置留在项目，不改写 Rabi 的通用正文。
