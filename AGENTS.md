# RabiRoute Agent Guide

RabiRoute 是一个开源的消息网关 / Policy Router 项目。协作时先把它理解成“分诊和调度层”，不要把它写成完整 Agent OS、聊天机器人框架或某个处理端的外壳。

## 项目判断

- RabiRoute 负责：消息进入、事件记录、路由判断、上下文模板、处理端投递、后续审批/回传的边界。
- 处理端负责：真正回答问题、写代码、跑流程、查系统、调用工具。
- 本机 Codex 编码 Agent 的真实消息只通过 Desktop IPC 投给 Codex/ChatGPT Desktop 的目标任务 owner；Desktop 是必需宿主，任务未加载时失败关闭，不启动备用 Runtime。项目锁定的 `codex app-server` 只可用于创建、命名空任务等元数据操作，不能执行真实 prompt。

## 全局文档同步规则

- 每次修改代码、配置、示例或用户可见行为前，先查看相关文档和索引，尤其是 `README.md`、`docs/README.md`、`docs/project-function-map.md`、`docs/code-architecture.md` 以及功能附近的专题文档，避免只凭代码局部理解推进。
- 改完后必须判断文档是否会滞后：如果行为、配置方式、启动流程、架构边界、示例数据、排障路径、公开口径或首次上手体验发生变化，同步更新对应的 README、`docs/`、`examples/`、`skills/` 或 `版本更新日志.md`。
- 所有面向用户、运维、扩展者和开源使用者的 Markdown 文档默认维护中文/英文双版本。保留既有文件路径作为主版本，并在同目录使用 `_en.md` 或 `_zh.md` 作为对应翻译；两页顶部都要提供 `English | 简体中文` 直接跳转入口，文档内链接尽量保持在当前语言版本。
- 新增或修改公开文档时，应在同一次变更中同步对应语言版本。README、专题文档、示例 README、安装/排障说明、Runbook、Checklist、归档说明和版本日志都属于该规则范围。
- 双语同步必须以行为准确为前提。发现旧文档与代码、Schema、API、WebGUI 或测试不一致时，先校准中文事实源、标注功能成熟度和文档状态，再人工维护英文版；不要直接翻译过时内容。
- `AGENTS.md`、`SKILL.md`、persona、prompt、memory、plan 等会直接改变 Agent 或示例运行语义的 Markdown 不做机械翻译；确需提供多语言版本时，必须确认加载入口并单独校对，避免把语言切换 UI 或翻译文本注入运行上下文。
- 面向用户、运维、扩展者或开源使用者的变化，默认需要留下文档痕迹；内部重构只有在不影响外部理解和操作时才可以不改文档，但最终说明里应明确“已检查相关文档，无需更新”。
- 不要为了显得有动作而制造无意义文档 churn；文档更新应以提交后的真实行为为准，保持公开、安全、可复制。

## 功能修改后的打包和运行版本

- 每完成一个功能修改，先运行与改动匹配的测试，再执行 `npm run build`；该命令会编译 Manager、构建独立插件包，并同步各插件的 Web Bundle。
- 修改 Manager、WebGUI、插件 Bundle、静态资源或启动链后，必须重启实际 Manager，并从已重建的运行地址回读健康状态和目标页面。不能拿旧 Manager 进程、旧插件包或旧 Web Bundle、旧浏览器标签页、Vite 开发服务或之前的构建日志当作当前部署证据。
- 实时验证前确认根 HTML 已引用本次构建的资源 hash；需要验证浏览器页面时刷新到新文档后再判断。只要还在使用旧 Bundle，就继续打包、重启或刷新，不宣布功能已部署。
- 功能完成前必须确认没有历史遗留问题：检查本次改动涉及的旧代码、旧配置、旧路由、旧 Bundle 和旧资源引用。无外部兼容要求的遗留入口必须在同一次改动中删除；确有兼容要求时，写清保留原因、唯一迁移路径、退出条件和验证，并在代码、构建产物与实时运行中确认旧入口没有继续被使用。存在未处理遗留项时，功能不得标记完成；不能把“暂时保留”“下次再清”当作完成状态。

## 修改文档

- README 面向第一次看到项目的人：先讲定位，再讲快速上手，再讲配置和开发。
- ARCHITECTURE 面向想理解边界和演进的人：保留更深的分层、红线和路线图。
- 把公开文档当成一套有明确所有权的信息架构：README 负责产品定位、典型用途、最短首次成功路径、能力摘要、关键边界和进阶入口；`docs/getting-started.md` 负责可跟随的编号操作步骤；`docs/current-capabilities.md` 负责由代码和验收支撑的成熟度口径；`docs/architecture.md` 负责边界与深层机制；`docs/README.md` 只负责索引和状态导航。
- RabiRoute 文档必须按受众分层：README 与 `docs/user-guide/` 面向软件使用者；安装启动、配置和排障资料面向本机运维者；Agent adapter、API、Schema、代码架构、功能地图、计划/记忆机制和历史复盘面向接入开发者或维护者。`docs/README.md` 的“先看这里”只放用户完成任务所需的入口，其他资料放在清楚标名的开发/维护分组，不能因为公开可读就混进用户路径。
- `docs/README.md` 中面向用户的链接说明必须写用户目的和可获得的结果，例如“第一次使用时从这里开始，完成安装并确认消息能送达”。“保留截图位”、文档覆盖范围、编排方式、Schema 校准状态等维护信息不得写进用户说明，应移到维护清单或开发者分组。
- 压缩文档时优先去重、迁移细节并链接到权威页，不以净删行数作为完成标准。删除或缩写一项事实前，必须确认它仍在正确的中英文目标页中可发现，或者已经过时且有代码、Schema、测试或版本记录作为依据；不能把“移出 README”变成“从项目文档消失”。
- README 的首读路径应让读者依次回答“这是什么、能做什么、怎样完成第一次真实投递、怎样判断成功、当前哪些能力已验证、边界在哪里、下一步去哪里”。保留 RabiRoute 的头图、Slogan、产品叙事和辨识度，同时明确实验能力、未完成能力、安全条件与失败关闭边界。
- 面向普通使用者时先说人能看到和能操作的结果，不要用项目内部词汇或生硬直译充当说明。优先写“聊天记录 / 消息记录”而不是“会话账本”，“自动附带最近消息”而不是“上下文注入”，“收到的消息”而不是“入站事件”，“发送规则”而不是“出站策略 / Outbox policy”；`Route` 首次写成“消息路线（Route）”，handler 写成“负责实际处理的 Agent 或程序”。`AgentPacket`、Desktop IPC、task owner、JSONL 等默认移到架构、能力或排障文档；确需出现在 README 或快速上手时，必须当场解释它与用户操作、风险或成功标准的关系。
- `examples/data/` 放可公开复制的完整示例数据包，包括 `gateways.json` 和示例角色。
- `examples/roles/` 放可公开的人格示例。
- `apps/` 放可独立构建、验收和发布的客户端应用；手机端和眼镜端不得再回到 `examples/`。
- `packages/` 放被多个应用复用、但不拥有产品运行状态的 SDK 与稳定契约。
- `skills/` 放项目内可复用的 Agent 指南，例如如何创建 RabiRoute 人格。
- 新增、改造或排障任何 Agent 处理端（尤其是 Codex/ChatGPT Desktop、会话找不到、重复建会话、工具不可用或启动依赖问题）时，必须先完整读取并遵守 `skills/create-rabiroute-agent-adapter/SKILL.md`；不得跳过其中的 owner、名称 + ID、按需扫描与 4510 独立启动门禁。

## Manager 动态地址合同

- 查找资料、历史决定、预定安排或任务线索时，先读 `skills/rabi-knowledge-search/SKILL.md`；Rabi 在线时先查记忆和计划，再按需搜索文件，离线直接普通搜索。

- Rabi 故障、自修复或定期代码质量维护按 `docs/rabi-maintenance.md` 执行：查询长期维护计划的唯一 taskBinding，投递证据并跟进；已有 Bug 保留原计划任务，不重复建任务或并行抢改。
- 消息外发、跨人格、持久 Agent 正文投递及正式回传，先读 `docs/rabi-agent-interfaces.md` 的“消息投递”章节。Rabi 可用时统一走受管接口；只有当前动态发现与有界重试确认 Rabi 不可用，且排除原投递已生效后，才允许原授权内的旁路。只读任务核对不受此限制。

- 所有新增或修改的 Skill、工作流和脚本，只要访问 RabiRoute Manager，都必须使用当前 application generation 发布的完整地址，不得写死 Manager 端口。
- 安装版通过 `RabiRouteHost.exe --command status --json` 取得 `managerBaseUrl`、`applicationGenerationId` 和 `managerInstanceId`；源码模式只使用 Manager 输出的结构化 READY 地址；测试或外部调用可以显式注入完整 URL。
- 取得地址后必须读取 `<managerBaseUrl>/meta`，确认 `health.state=healthy`、`requiredReady=true`，并核对 generation 与 Manager 实例身份。generation 变化后重新发现地址，不缓存旧 URL。
- 禁止端口扫描、读取退役实例锁、直接启动或结束 Manager 进程。安装版应用生命周期只由 Host 管理。测试夹具和明确的旧任务迁移器可以保留退役端口文本用于检测，但不得把它作为当前连接目标。
- 修改 Skill、工作流或脚本后运行 `node --test scripts/dynamic-manager-active-truth.test.mjs`；该测试递归检查现有和新增入口。

## 修改代码

- 所有进入公开仓库的代码都必须采用通用设计；业务差异通过配置、稳定契约或插件表达，不按特定公司、客户或项目硬编码分支。
- 公开代码的文件名、标识符、常量、路径、默认值、注释、日志、测试和示例中，不得出现真实公司、客户、项目名称或同类私有业务标识。公司／项目专属数据只能存放在经 `git check-ignore` 确认忽略、且未被 Git 跟踪的本地文件中；不得打入公开构建产物或提交。`.gitignore` 不会自动取消已跟踪文件，不能靠新增忽略规则掩盖泄漏。
- 修改现有功能时，同步清理该调用链上的专属逻辑，迁移到通用配置入口；保留用户本地数据，核对源码、测试、文档示例与构建产物，不以改名代替通用化。不扩大为未经授权的全仓历史清理。

- 修改或排查乐奇 / Rokid / CXR、眼镜应用、推流录像与签名时，先读 `skills/rokid-development/SKILL.md`；当前项目不采用 CXR-M。

- 新平台入口优先新增 `src/adapters/` 模块，不要把所有逻辑塞进 NapCat adapter。
- 路由规则、模板渲染和处理端投递的核心在 `src/forwarding.ts`。
- Gateway 管理、RibiWebGUI API 和进程启停在 `src/manager.ts`。
- 保持 router 与 Agent adapter / handler 解耦，避免让某个处理端反向定义项目边界。

## 开源示例

这个仓库按开源项目维护。公开示例里使用占位值、localhost、模板变量和脱敏路径即可；不要把真实 QQ 号、群号、私聊内容、token、Cookie、本机用户名、私有路径或运行期 `data/` 内容写进仓库。

`.env`、`data/`、`dist/`、`logs/` 和 `node_modules/` 都是运行期或本地文件，默认不要提交。
