export function buildLanAgentBootstrapPrompt(input: { managerUrl: string; token: string; publicKeySha256: string }): string {
  const url = new URL(input.managerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("请使用目标电脑可访问的 Manager 局域网地址。");
  }
  if (!input.token.trim() || !/^[a-f0-9]{64}$/i.test(input.publicKeySha256)) throw new Error("缺少连接密钥或发布公钥指纹，请刷新后重试。");
  return `请把这台电脑接入以下 Rabi Manager。完成环境检查、下载、校验、私有配置与启动，并确认 Manager 显示节点在线。

连接信息（仅限本次私密安装，不要写入仓库、日志、截图或命令历史）：
Manager URL: ${url.origin}
LAN connection Token: ${input.token.trim()}
Release public key SHA-256: ${input.publicKeySha256}

1. 检查 Node.js 22.13+；缺少时从 Node.js 官方来源安装到当前用户可用的位置并验证版本。识别用户当前粘贴提示词的宿主是 Codex/ChatGPT Desktop 还是 DSH。通过当前任务上下文或宿主的正式发现接口取得本任务完整 ID 和工作目录，不猜 ID，不让用户填写 UUID。Codex 必须使用已打开的 Desktop 任务；DSH 必须发现本机实际 API 地址并通过 session.list 核对当前会话。宿主或任务不可用时停止并说明缺少项，不启动备用 Runtime。
2. 用 Authorization: Bearer <上面的 Token> 请求 GET ${url.origin}/api/lan-agent/releases/manifest，读取 JSON 的 release 字段。对 release.publicKey 的 SPKI DER 求 SHA-256，要求同时等于上面的固定指纹和 release.publicKeySha256；用 Ed25519 验证 JSON.stringify({version, platform, minNodeVersion, files}) 的签名（signature 是 Base64）。任何校验失败立即停止。
3. 下载 release.files 的每个文件，只允许与 Manager 同源的 downloadUrl；拒绝绝对文件路径、空路径段、. 和 ..。逐个核对 sha256 和 size。安装到当前用户私有的 RabiAgent/releases/<version>：Windows 用 %LOCALAPPDATA%/RabiAgent，macOS 用 ~/Library/Application Support/RabiAgent，Linux 用 ~/.local/share/RabiAgent。不要安装完整 RabiRoute。
4. 已有私有配置时保留稳定 nodeId；否则生成由字母、数字、点、下划线、短横线组成的唯一节点 ID。仅为安装子进程设置 RABI_MANAGER_URL、RABI_LAN_LINK_TOKEN、RABI_NODE_ID、RABI_AGENT_DEFAULT_CWD、RABI_AGENT_ALLOWED_CWDS（JSON 数组）、RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256。Codex 设置 RABI_AGENT_TYPE=codex-desktop 与 RABI_AGENT_CODEX_THREAD_ID；DSH 设置 RABI_AGENT_TYPE=dsh、RABI_AGENT_DSH_URL（实际本机 API 地址）与 RABI_AGENT_DSH_SESSION_ID。工作目录采用当前任务目录，权限只覆盖该目录。
5. 在已校验的发布目录运行 npm install --omit=dev，安装 package.json 固定版本的 Agent 元数据 CLI 依赖（真实消息仍由已打开的 Desktop 执行）。然后从已校验的发布目录以隐藏、脱离终端的子进程运行 node rabi-agent.mjs --bootstrap；该进程会常驻，不等待它退出。它保存当前用户私有配置、注册登录启动项并启动无界面 Agent。不要把连接密钥保存在公开文件，不改 Desktop 启动配置、不接管 Desktop 端口、不使用配对码或旧 Remote Agent 协议。
6. 带同一 Bearer 凭据请求 GET ${url.origin}/api/lan-agent/nodes，确认自己的 nodeId 为 connected。报告节点名称、版本和连接结果；失败只报告具体步骤和脱敏错误，不盲目重装或无限重试。
7. 告诉用户：回到 WebGUI 的路由规则/消息适配器，添加“远端 Agent”，选择此实例中的 Agent 并保存；本机也会作为实例显示，IP 变化不影响绑定。`;
}
