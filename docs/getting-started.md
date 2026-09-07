<!-- docs-language-switch -->
<div align="center">
<a href="./getting-started_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 快速上手

> 状态：现行指南。已按当前 Manager、RibiWebGUI、Codex Desktop owner 和 NapCat 配置流程核对。

## 准备环境

需要：

- Node.js 20+ 或更新版本。
- 一个可用的 NapCat / OneBot 环境。如果只想先体验 RibiWebGUI 和定时触发，可以暂时不接 QQ。
- 可选：Codex，用作默认处理端。

## 安装和构建

Windows 安装包直接从开始菜单运行 RabiRoute Host。Host 创建同一代 Manager 与托盘，并把操作系统分配的 Manager URL 交给托盘；从托盘打开 RibiWebGUI 即可。重复启动只激活现有 Host。

Windows 完整源码构建启动：双击仓库根目录的 `Start-RabiRoute-FromSource.bat`。需要已安装 Windows RabiRoute、Node.js/npm 和 .NET 9 SDK。脚本构建 Manager、WebGUI、插件、Host 与托盘，通过 Host 切换到源码构建版，沿用安装版配置和数据；首次构建会下载 Python/Qt 依赖。关闭命令窗口不会退出已启动的 Host，退出应用请使用托盘。失败日志在 `logs/source-start/`。依赖锁文件与安装版不一致时，需要先更新完整安装包。

只运行源码后端（不含托盘）：

Windows PowerShell：

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

macOS / Linux：

```bash
cd /path/to/RabiRoute
npm install
npm run build
npm run start:manager
```

Manager 会在标准输出打印真实地址，例如：

```text
RabiRoute manager listening at <managerBaseUrl>
```

使用这次输出的 `<managerBaseUrl>`，不要把某次端口保存成永久默认。其他集成常用端口仍按各自配置管理：

- NapCat 反向 WebSocket：`ws://127.0.0.1:8789`
- NapCat HTTP API：`http://127.0.0.1:3000`

## 配置第一条路由

首次启动时，如果没有 `data/route` 和 `data/roles`，manager 会优先复制整包 `examples/data`，这样默认 QQ 路由、Rabi 示例人格与脱敏的 RabiLink 主动智能模板会一起落地。只有 `main` 默认启用；其他接入先保持禁用，配置完成后再逐条开启。RabiLink 模板不会自动获得 Relay 地址或 token；即使发布包里没有 examples，manager 也能自己建立最小 QQ / NapCat 到 Codex 配置。

在 RibiWebGUI 里重点检查：

- `消息适配端`：默认启用 `NapCat / OneBot` 和 `定时触发`。
- `Agent 端`：选择处理端配置，填写 Codex 监听线程名，并在 `Agent 工作目录` 下拉里选择对应项目目录；没有候选时在右侧手动填写一次。
- `路由配置`：确认 NapCat WS 端口、NapCat HTTP 地址、Webhook 端口、Agent 工作目录和指向人格。
- `人格配置`：选择或创建角色。普通陪伴示例使用 `Rabi`；眼镜 record-first 与主动下行示例使用配套的 `RabiLink` Route 和 `RabiActive` 人格。
- `人格自动化`：在“收到消息时 / 定时任务”中确认触发条件，并选择通知 Agent 或运行人格脚本。

需要手动写 `personaConfig.json`、关键词规则或自动化规则时，看 [路由配置](routing-configuration.md)。

复制示例 data 包：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

如果只想本地试跑定时任务，可以启用“定时任务”入口，不用接 NapCat。运行脚本还要在当前 Route 单独打开本机脚本权限。

## 适配 Codex

RabiRoute 当前已验证的处理端是 Codex。WebUI 的 `Agent 端` 里需要确认三项：

- `Agent 配置`：选择 `Codex`。
- `Agent 会话`：下拉显示“任务名 + 最后会话时间”，选择后内部保存完整任务 ID；直接输入不存在的名称会创建 Desktop 任务。
- `Agent 工作目录`：选择或填写下一轮要处理的项目。没有有效任务 ID 时，RabiRoute 用它筛选同名任务；已有完整 ID 时，它直接作为本次投递目录，不要求等于任务保存的默认 cwd。

投递时 Codex/ChatGPT Desktop 必须已经启动。RabiRoute 会让 Desktop 加载目标任务，再通过 Desktop IPC 交付消息；成功后消息会立即出现在桌面任务中，并沿用该任务自己的工具、模型和权限。

如果下拉里没有目标项目，先在右侧输入框填入绝对路径并保存；之后同一个 RibiWebGUI 里配置其他 gateway 时，就可以从下拉里复用这个目录。

真实投递要求 Codex/ChatGPT Desktop 运行。RabiRoute 通过 Desktop IPC 复用已保存任务 ID；任务改名或 goal 完成不会新建副本。项目锁定的 app-server 只在用户明确输入新名称且没有可复用任务时创建、命名空任务，不执行真实消息。

## 配置 NapCat

在 NapCat WebUI 里配置：

- WebSocket 客户端：`ws://127.0.0.1:8789`
- HTTP 服务器：主机 `127.0.0.1`，端口 `3000`

WebSocket 客户端用于接收 QQ 消息事件。HTTP 服务器用于后续主动发送 QQ 消息或调用 OneBot API。

如果 NapCat 新增插件或修改 OneBot 网络配置后没有生效，通常需要重启 QQ/NapCat，或在 NapCat WebUI 中保存并重载网络配置。

如果希望机器重启后尽量无值守恢复 QQ 登录，见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。账号密码、quick login 和验证码处理属于 NapCat / QQNT 侧，不能写进 RabiRoute gateway 配置。

## Windows 中文消息注意

在 Windows 上测试 OneBot HTTP 外发中文或多行消息时，不建议用 PowerShell `Invoke-WebRequest` 直接拼中文 JSON；实际发送编码可能不稳定，容易出现 QQ 消息乱码。

推荐使用项目内 Node 脚本：

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "中文测试\n第二行"
```

如果修改了 `data/route` 或 `data/roles` 下的 JSON 后 reload 失败，也检查文件末尾是否混入了字面量 `\n`：

```powershell
npm run check:config
```

需要多行模板时，在 WebUI 文本框里使用真实换行；保存 JSON 时才由序列化器转义。

## 验证链路

1. 安装版启动 Host；源码模式运行 `npm run start:manager` 并记录标准输出中的 `<managerBaseUrl>`。
2. 从托盘或 `<managerBaseUrl>` 打开 RibiWebGUI，确认 gateway 为运行中。
3. 在 NapCat 侧确认 WebSocket 已连到 `127.0.0.1:8789`。
4. 在 QQ 群里 @ 机器人，或发一条私聊。
5. 查看 `data/route/<配置名>/` 下是否出现消息记录和投递记录。
6. 如果使用 Codex，确认指定线程收到了转发提示。

## 开发命令

常用命令：

```powershell
npm run build
npm run start:manager
```

开发期也可以直接用 TypeScript：

```powershell
npm run manager
```

源码入口：

- `src/manager.ts`：读取 `data/route` 和 `data/roles`、启动/停止路由进程、提供 RibiWebGUI API。
- `src/index.ts`：单个 gateway 入口。
- `src/adapters/`：消息适配端。
- `src/forwarding.ts`：路由规则匹配、模板渲染、投递处理端。
- `src/config.ts`：环境变量和默认配置。
- `src/history.ts`：JSONL 记录。
