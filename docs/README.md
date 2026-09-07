<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 文档

这里同时包含现行使用说明、实验集成、设计方案、调研和历史交接。文件存在不代表功能已经完成；阅读前先看状态。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| 当前事实 | 已按代码、Schema、WebGUI 和测试核对，可作为当前版本口径。 |
| 现行指南 | 对应已实现功能，但仍应随代码变化持续复核。 |
| 实验集成 | 代码入口存在，外部系统或真机链路仍需环境验收。 |
| 待校准 | 文档包含有效信息，但已经发现过时或互相矛盾的描述；优先参考“当前能力与成熟度”。 |
| 设计中 | 方案、需求或路线图，不代表当前代码已经实现。 |
| 历史参考 | 旧路线、研究或交接记录，不是当前主链。 |

## 先看这里

- [RibiWebGUI 使用手册](user-guide/README.md) — **现行指南**。第一次使用时从这里开始，完成一条真实投递，并学会看状态、改规则和处理常见失败。
- [快速上手](getting-started.md) — **现行指南**。完成安装，启动 Manager，并确认浏览器能打开控制台。
- [界面与状态](user-guide/interface-and-status.md) — **现行指南**。看懂当前 Route、Manager 连接、未保存修改、运行状态，以及设置页的截图、滑词菜单和登录启动。
- [界面主题](user-guide/interface-theme.md) — **现行指南**。统一 WebGUI 与 Windows 托盘的浅色、深色、跟随系统和受限自定义主题。
- [运行、日志与排障](user-guide/operations-and-troubleshooting.md) — **现行指南**。消息没有送达时，从诊断摘要开始逐项找到断点。
- [安全、回传与数据](user-guide/safety-and-data.md) — **现行指南**。在启用外部回复或共享诊断材料前，确认权限和隐私边界。
- [当前能力与成熟度](current-capabilities.md) — **当前事实**。核对哪些能力已经验证，哪些仍需要真实账号、网络或设备验收。

## 本机安装、配置与恢复

- [配置与接入](configuration.md) — **现行指南**。查看 28 个内置 Manager 插件、`provides/requires/optional` 依赖、单一初始化入口、声明式路由、共享资源生命周期、WebGUI/Desktop 扩展入口，以及 AstrBot ChatUI-only 配置。
- [常驻性能记录与查看](performance-monitoring.md) — **现行指南**。按开关持续记录 Manager、Gateway 和 WebGUI 的近期性能，查看趋势、慢操作和独立 JSONL 文件。
- [排障](troubleshooting.md) — NapCat、编码、Codex Desktop 任务归属、模型与审批边界。
- [Windows 启动与打包](windows-launcher-and-packaging.md) — Windows 安装、启动和打包方式。
- [NapCat 无值守](napcat-unattended.md) — QQ 登录状态、快速登录、Manager 恢复和守护边界。

## 路由、人格与处理端

- [路由配置](routing-configuration.md) — **现行指南**。`personaConfig.json`、route kind、regex、schedule、pipeline 和模板变量。
- [路由与人格](routing-and-personas.md) — **现行指南**。route 与 role 的边界、人格包和消息模板判断框架。
- [Agent 上下文注入](agent-context-injection.md) — **现行指南**。人格级统一双向账本、分消息端/会话的最近消息额度、归档边界，以及 `AgentPacket` 中的人格目录、跨人格投递凭据、路径和回复上下文。
- [Rabi Agent 接口](rabi-agent-interfaces.md) — **当前合同**。处理端如何回复、查询可联系人格、进行带幂等回执的单向跨人格投递，以及使用 thread bridge、计划、记忆、Remote Agent 和多实例 API。
- [计划和记忆机制](plan-and-memory-model.md) — **现行指南**。Role Knowledge 的文件真源、召回和整理副作用。
- [动态整理记录统一规范](dynamic-record-lifecycle.md) — **现行指南**。统一归档、记忆沉淀、物理分卷、保留策略和 24/72 小时动态窗口的边界与验收。
- [Pipeline presets](pipeline-presets.md) — Agent 会话、明确外部目标和 Outbox 状态；其中 FenneNote 输出章节仅为归档兼容说明。
- [Agent 端接入：历史问题、正确边界与验证手册](agent-adapter-integration-lessons.md) — **现行指南**。会话重复创建、工具缺失、owner 倒置和桌面启动依赖的复盘与验证方法。
- [标准 Agent 端接入需求](agent-adapter-standard-requirements.md) — **现行指南**。发现、认证、任务、幂等创建、投递、结果、工具、生命周期、UI、安全和验收要求。
- [Codex Desktop Agent 接入与验收合同](codex-desktop-agent-acceptance.md) — **当前事实**。稳定 ID、按需扫描、自动初始化、Desktop 唯一 owner 和元数据 bootstrap 安全门。
- [Rabi Codex Context 插件](rabi-codex-context-plugin.md) — **统一 Manager 版本**。Hook 只转发真实 Codex session 事件并注入 Rabi PC 返回的统一人格、计划、记忆与技能上下文。
- [多电脑人格数据同步](persona-data-sync.md) — **实验支持**。同一 RabiLink 应用下的 PC 通过局域网直连优先、Relay 受限中转兜底；后端按文件/连接事件自动补账，人格页可手动同步、预览证据和处理基础冲突。

## 架构与维护

- [架构说明](architecture.md) — **当前事实**。项目边界、Codex Desktop owner 和现有 Outbox / 未来 Action Queue 已分开说明。
- [从 DSH 学习的插件化设计理念](dsh-plugin-architecture-lessons.md) — **调研与实施总结**。说明 28 个内置 Manager 插件迁移、WebGUI/Desktop 最小扩展宿主、贡献点、进程隔离边界和第三方表现 Extension Host 后续路线。
- [DSH 如何使用 Cordis](dsh-cordis-runtime-analysis.md) — **实现调查**。说明 profile、Loader、Fiber、服务 realm、浏览器插件树、动态代码和进程沙箱的真实边界。
- [RabiRoute 插件平台目标架构](manager-plugin-implementation-hot-swap.md) — **当前架构**。定义最小插件内核、独立能力包、统一 SDK、多宿主扩展、generation 原子切换、树外插件验收和一次性删除旧运行时。
- [插件 Bundle 与热替换](plugin-bundles.md) — **当前实现说明**。单一 Profile、独立插件包、统一 SDK、generation 热替换和浏览器 revision 回滚。
- [代码架构](code-architecture.md) — **当前事实**。后端、Manager、消息端、Role Knowledge、WebGUI 和桌面模块地图。
- [项目功能手册](project-function-map.md) — **当前事实**。按功能、成熟度、副作用、API 和代码入口定位；成熟度仍与当前能力页交叉核对。
- [路径与目录规范](path-and-directory-conventions.md) — **当前维护规范**。区分软件目录、公开示例、本机运行数据和日志，并规定 API 中相对路径与业务 ID 的写法。
- [PR 安全门禁](maintainer-security-gates.md) — **现行维护指南**。秘钥扫描、生产依赖审计、CodeQL、最小权限和合并保护要求。
- [Windows 启动与打包](windows-launcher-and-packaging.md) — **现行指南**。RabiRoute Desktop 的用户入口、内部本机后端和打包边界。
- [Manager 运行稳定性与故障证据](manager-runtime-resilience.md) — **现行指南**。崩溃日志、单实例、人格索引非致命持久化、watchdog 退避恢复与浸泡验收。
- [NapCat 无值守](napcat-unattended.md) — **现行指南**。登录态、quick login、Manager 一键恢复和守护边界。

## 实验集成

- [YeYu Gamer Manager 本机接入](yeyu-gamer-manager-integration.md) — **实验集成**。固定连接本机 8877，只读 health/meta/snapshot/capabilities，并用独立 `rabiroute.token` 创建 plan-only Agent work item；默认关闭，真实安装联调待验收。
- [企业微信接入](wecom-integration.md) — WeCom 智能机器人 WebSocket 与 Outbox 回发。
- [飞书独立消息端接入](feishu-integration.md) — 飞书应用事件订阅、签名/加密回调、持久去重与来源 chat 回发。
- [语音交互工作站](voice-interaction-workstation.md) — 历史工作站接线记录；FenneNote/OumuQ 已停止维护，现行入口是 RabiPC + RabiSpeech。
- [RabiSpeech 本机 TTS / ASR 服务](rabispeech-plugin.md) — 本机直接 API、热投递/人格关键词唤醒、人格声线与语言、双向 ASR/TTS 记录、不透明声纹/聚类证据和 RabiLink 中转。滑词菜单的朗读子功能会把选中文字送进本机 TTS 队列。
- [远端调用 TTS 与 ASR](user-guide/speech-api.md) — 应用 token、目标 PC、可复制命令、验收与错误恢复。
- [Rabi 语音客户端](../desktop/rabi-voice-client/README.md) — 把会议室 Windows 电脑作为局域网远程麦克风和喇叭，切句与模型仍留在 RabiSpeech 主机。
- [本地语音模型下载说明](local-speech-model-downloads.md) — 使用模型管理页按需下载，并查看每个 TTS/ASR 模型的来源、隔离环境与验证要求。
- [RabiSpeech 性能与功能报告](rabispeech-performance-report.md) — 六个 TTS、五个主要 ASR 的冷/热态、效果、硬件与 CUDA 问题。
- [RabiLink Relay](rabilink-relay-server.md) — Relay server、PC worker、远程 WebGUI、统一会话账本和下行流。
- [RabiLink Cloudflare Worker](rabilink-relay-cloudflare-worker.md) — Relay 边缘代理实现。
- [RabiLink 眼镜端三条路线对比](rabilink-glasses-route-comparison.md) — 原生灵珠智能体、AIUI 与原生 App 的宿主、生命周期、设备能力、发布成本和当前建议。
- [Rabi 移动设备消息端](mobile-message-endpoint.md) — **实验集成**。手机独立聊天、可选眼镜、可靠队列、通知、附件、配置助手和真机验收边界。
- [RabiLink 手机边缘枢纽](rabilink-phone-edge-hub.md) — 手机/穿戴设备契约和 Android SDK。
- [手机与电脑视频直连](rabilink-direct-video.md) — **实验接入**。直连视频的带宽边界、SDK 条件、构建方式和真机验证结果。
- [RabiLink 智能手表 / 手环健康消息端](rabilink-wearable-health.md) — **实验集成**。手机配置、结构化健康时间线、Agent 查询 API、阈值告警和小米 ADB 过渡桥。
- [AIUI 到手机 / 原生眼镜方案的功能等价清单](rabilink-aiui-native-parity.md) — 按代码、自动化与真机证据逐项记录迁移完成度。
- [RabiLink AIUI 常驻边界](rabilink-aiui-residency-plan.md) — 已实现链路与常驻能力限制混合文档，阅读时区分代码事实和计划。
- [RabiLink 主动智能需求](rabilink-active-intelligence-requirements.md) — 用户状态、情景识别、群消息命中计划/记忆后的处理闭环和主动介入的目标合同与实施追踪，不等同于全部完成。
- [RabiLink 原生应用设计](rabilink-glasses-app-design.md) — 手机/眼镜体验设计。
- [小爱接入技术路线](xiaoai-integration/xiaoai-rabiroute-intercept-route.md) — 小爱桥接方案，包含未实现 API 和未来路线。
- [红外网关调研](xiaoai-integration/ir-remote-gateway-research.md) — 调研资料。
- [小米手环心率探针交接](xiaomi-band-heart-rate-probe-handoff.md) — 真机探针与交接记录，不是核心路由能力。

## 设计与历史

- [主动智能系统设计总纲](../主动智能设计思路.md) — **设计中**。描述持续感知、用户性格与偏好、心理状态、情景识别、主动行动、记忆和设备分工；当前实现范围以“当前能力与成熟度”为准。
- [对话消息收集、消息组与四类 Agent 协作](group-message-batching-and-triage-plan.md)（[HTML 架构预览](group-message-batching-and-triage-plan.html)）— **实验支持**。自然语言消息可先立即记录并等待合并，再综合引用消息对应的 Agent 会话、原消息组、会话、说话人和消息端熟悉度，交给动态 Codex 消息处理 Agent；真实群聊/私聊和四类 Agent 完整联调仍待验收。
- [人格路由工作台计划](persona-route-workbench-plan.md) — **部分实现**。语音关键词和分端上下文控件已实现；Dry-run RouteDecision / AgentPacket 预览尚未实现。
- [Windows 托盘任务窗口计划](rabiroute-windows-tray-task-window-plan.md) — 设计记录；实际实现以 `desktop/tray-task-window/` 和打包文档为准。
- [UE/UX 审计与重构](rabiroute-ue-ux-audit-and-refactor.md) — 阶段性审计。
- [局域网 Rabi Agent 接入与更新](lan-rabi-agent-bootstrap.md) — **实验集成**。查看无界面节点接入、局域网连接 Token、Rabi Web 更新请求和现有 Codex Desktop task owner 的限制。
- [手机 App Webhook 历史方案](mobile-app-webhook-integration.md) — **历史参考**，当前 RabiLink 主链不再以手机桥作为必经中转。

归档材料位于 [`archive/`](../archive/README.md)，可构建客户端位于 [`apps/`](../apps/README.md)，共享 SDK 位于 [`packages/`](../packages/README.md)，可复制样板位于 [`examples/`](../examples/README.md)。

## 文档维护规则

1. 先核对代码、配置 Schema、API、WebGUI 和测试，再更新中文事实页。
2. 行为准确后再人工维护英文版本；不要把旧文档直接批量翻译。
3. 设计稿必须明确写“设计中”或“历史参考”，不能混进当前能力表。
4. 运行语义文件（`AGENTS.md`、`SKILL.md`、persona、prompt、memory、plan）不做机械翻译。
