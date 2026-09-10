<!-- docs-language-switch -->
<div align="center">
简体中文 | <a href="./README_en.md">English</a>
</div>
<!-- /docs-language-switch -->

# Rabi Agent

Rabi Agent 是一个没有界面的局域网工作进程，不是完整 RabiRoute 客户端。它主动连接 Rabi Manager，领取任务，并投给接入时指定的远端任务：Codex Desktop 使用 IPC，DSH 使用本机 session.prompt。

- 需要 Node.js 22.13+ 和已启动的目标 Agent 宿主。
- 不包含 Manager、Gateway、WebGUI、配对码、UDP 扫描或设备密码。
- 使用现有局域网连接 Token；接入时固定发布公钥 SHA-256 指纹，更新时先核对指纹，再验证 Ed25519 签名和每个文件的 SHA-256。
- 收到更新请求后自行下载、校验和切换。新版本 30 秒内未连接成功时保留旧版本。
- `--bootstrap` 写当前用户私有配置并创建当前用户登录启动项；启动项不含 Token。

首次接入、配置字段和提示词见 [局域网 Rabi Agent 接入与更新](../../docs/lan-rabi-agent-bootstrap.md)。

```bash
node rabi-agent.mjs --bootstrap
```

启动前仅为该进程提供 `RABI_MANAGER_URL`、`RABI_LAN_LINK_TOKEN`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS`、`RABI_AGENT_CODEX_THREAD_ID` 和 `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。不要把 Token 传到命令行、日志、仓库或任务文本。

- 作为路由的远端 Agent 处理端，用户在 WebGUI 复制接入提示词，在目标电脑的当前 Agent 任务内完成自动配置，然后选择远端Agent(<IP地址>)。接入程序支持 Codex Desktop 与 DSH。DSH 环境变量为 RABI_AGENT_TYPE=dsh、RABI_AGENT_DSH_URL、RABI_AGENT_DSH_SESSION_ID；完整步骤见下方接入文档。

0.2.0 将电脑作为实例，原有单任务配置映射为稳定的 default Agent。每个实例可以增加多个 Agent；配置保存在执行电脑，Manager 统一管理。安装发布目录的固定 npm 依赖后，扫描、任务操作与 Hook 安装使用共用的管理模块。
