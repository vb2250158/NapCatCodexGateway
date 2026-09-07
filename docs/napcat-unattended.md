<!-- docs-language-switch -->
<div align="center">
<a href="./napcat-unattended_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# NapCat 无值守与登录稳定性

> 状态：现行指南。RabiRoute 可管理、扫描和启动 NapCat 实例，但 QQ 登录验证仍由 NapCat/QQNT 负责。

RabiRoute 负责接收 NapCat / OneBot 事件、记录消息、路由和投递处理端，也可以在 Manager 启动后或用户点击“启动并管理登录”时编排本机 NapCat 的启动、三种 QQ 登录方式和 OneBot 连接修复。QQ 登录凭据和安全校验仍由 NapCat / QQNT 解释；Rabi 只代理当前这次本机操作。不要把 QQ 密码、Cookie、token 写进 `data/route`、`data/roles`、示例文件或仓库。

## 推荐职责划分

- NapCat：启动 QQNT、维护 QQ 登录态，并在本机提供登录、WebSocket Client 和 HTTP Server 接口。
- RabiRoute：监听 WebSocket、调用 OneBot HTTP、展示连接状态、记录消息和路由事件；实例启用“启动 Rabi 时自动登录”后，Manager 监听成功即在后台执行启动、quick login 和 OneBot 修复。用户也可以在当前 Route 的 NapCat 卡片点击“启动并管理登录”立即进入同一流程。
- Windows Host：启动 RabiRoute；绑定实例的启动与停止由 RabiRoute 管理。

密码登录时，明文只存在于当前浏览器表单和一次 Manager 请求中；Manager 立即计算 MD5 后调用 NapCat，不把明文或 MD5 写入 Route 配置、日志或响应。RabiRoute 不绕过验证码、新设备验证或风控确认：腾讯验证码和手机 QQ 扫码仍由用户亲自完成，确认后卡片继续复查连接。

## Route 卡片内的 NapCat 登录与管理

一个 Route 只绑定一个 NapCat；另一个 QQ 应使用另一个 Route。路由页当前绑定的“启动并管理登录”按下面顺序工作，不再打开或嵌入 NapCat WebUI：

1. 目标实例已经在线且账号匹配：复用现有会话，不重启 QQNT/NapCat。
2. 目标实例未就绪：先扫描本机已配置和可发现的 OneBot HTTP 端点，用 `get_status` 与 `get_login_info` 确认这个 QQ 是否已经由另一 NapCat 实例持有。
3. 账号已在另一实例在线：保留现有会话，拒绝启动或快捷登录第二份实例；页面显示真实在线实例，可由用户明确选择“采用在线实例”。
4. 没有其他在线持有者且 NapCat 未启动：按该实例的 `launchCommand` 和 `workingDir` 隐藏启动，并等待本机管理接口。
5. 卡片通过 Manager 获取登录状态和二维码，只展示三种正式入口：快速登录、密码登录、扫码登录。
6. 快速登录只列出 NapCat 已保存的身份；密码登录遇到腾讯验证码或新设备验证时，卡片显示相应安全步骤；扫码登录由 Manager 把 NapCat 的二维码内容转换为本地图片后显示。
7. QQ 已登录但 OneBot 未连通：Rabi 自动写入并应用该实例的 HTTP / WebSocket 配置，再复查 OneBot 和 RabiRoute WS。

前端只调用 `/api/message/napcat-login-panel` 和 `/api/message/napcat-login-action`。WebUI token 与鉴权 Credential 留在 Manager 内部，登录响应使用 `Cache-Control: no-store`；Route 卡片不持有 NapCat 管理会话，也不把 WebUI 当第二个控制面。

Manager 复用短期管理会话，并合并同时发起的认证请求，避免每次刷新状态都重新登录、触发 NapCat 的认证限制。管理凭据失效时重新认证；只有明确的认证拒绝会重试，已受理的 QQ 登录或配置操作不会因普通错误重复提交。

健康检查接口保持只读；登录、启动和配置修复由 manager 的 `napcat-ensure-ready` 动作编排。启动时自动登录在 Manager 开始监听后异步执行，Manager 不等待 NapCat 检查或登录完成。

同一绑定 QQ 的启动、重启和停止动作会按账号串行执行。即使用户双击按钮、两个入口同时触发，或映射盘路径与 UNC 路径同时指向同一套 NapCat，也只允许一条生命周期操作进入；真正启动前还会再次读取 OneBot 登录状态，已就绪时直接复用，不创建第二棵 QQNT/NapCat 进程。该防重只保护进程生命周期，不会绕过扫码、验证码、设备确认或其他 QQ 安全验证。

页面把四层状态分开显示：NapCat 管理接口是否可达、QQ 登录身份、OneBot HTTP 是否在线，以及 RabiRoute WebSocket 是否已连接。管理接口可达不等于 QQ 已登录，QQ 已登录也不等于消息已经进入 RabiRoute。

QQ 卡片进入页面后读取同一次后端检查得到的账号与连接状态，并每三秒复查。保存的绑定账号用于核对目标；端点返回另一个 QQ 时，卡片显示实际账号和绑定账号，提示“账号不匹配”。OneBot 返回离线时不会显示就绪。登录成功后隐藏快速、密码和扫码表单；管理服务不可达时显示启动提示，保留可读取的 OneBot 账号信息。账号日志排除明确属于其他 QQ 的记录。

登录面板与健康检查使用 `src/shared/napcatStateContract.ts` 中的共享状态定义。登录状态与 OneBot 就绪状态分别返回；管理接口不可用不会把已登录账号变成未登录。卡片的登录状态、账号不匹配和扫码提示支持中英文切换，账号昵称和地址保持原值。

Windows Host 在托盘启动后的最终健康检查中最多等待 30 秒，避免后台启动期间的一次超时导致反复重启。只有当前 Manager 身份和就绪状态通过检查，才发布可用地址；超过期限或进程退出仍判定启动失败。

“采用在线实例”把当前 QQ 卡片的 HTTP、WebUI 和工作目录改为已确认在线且未被其他路由占用的实例。替换工作目录时先停止当前绑定的旧实例，再接管选中的在线实例；不会迁移登录凭据。若在线实例尚未指向当前网关，页面会继续要求修复 OneBot WebSocket 路由。

## 路由绑定与进程清理

路由配置是绑定关系的唯一来源。每条路由最多配置一个 QQ；保存多个实例会被拒绝。界面只展示该路由配置中的实例，不把扫描结果追加为 QQ 卡片，也不自动创建空实例。首次扫码可以在已绑定路由的实例中完成；绑定已有 QQ 后，快捷登录和密码登录不能提交另一个账号。

启动、自动登录、重启和连接修复都要求路由及 NapCat 消息端启用。开机自动登录等待路由加载及绑定清理完成后触发，避免提前读取空配置而漏掉账号。删除实例、删除路由、禁用路由或 NapCat 消息端时，后台先拒绝新的启动请求，等待正在执行的操作结束，再核对进程身份并停止实例。停止失败会保留记录并阻止重新启动，重试清理成功前不会报告解绑成功。关闭“启动 Rabi 时自动登录”只改变开机行为，不等于解绑。

Windows 下，Manager 启动和绑定关系变化时会核对 NapCat 进程。没有有效绑定的 NapCat 启动器及其子进程会被停止；独立运行的普通 QQ 客户端不作为清理目标。Rabi 不阻止用户在软件外手工启动程序；这类 NapCat 会在下一次上述核对时处理。完整 Shell 包优先使用包内 QQ 启动；缺少包内 QQ 的旧 Shell 才沿用其内层启动器。

进程记录保存在本机 `data/.runtime/napcat-process-ownership.json`，包含路由、实例、目录、PID、进程创建时间及程序路径。每次停止前重新核对身份，避免误杀占用了旧 PID 的其他程序。新实例使用全局唯一 ID 和独立目录；Manager 重启后接续管理仍有绑定的实例。HTTP 或 WebUI 地址修正不会重启已登录 QQ，已知绑定账号改为另一个 QQ 时才停止旧实例。解绑不删除 NapCat 安装文件或登录缓存。

接口通过共享状态定义返回 `unbound`、`stop-failed` 和 `account-mismatch`；对应提示维护中文和英文版本。

## 无值守登录思路

多数情况下，先在 Rabi 的 NapCat 卡片完成一次扫码登录，然后依赖 NapCat / QQNT 的 quick login。若机器重启后 quick login 经常失败，可以在 Windows 用户环境变量里给 NapCat Shell 提供账号和密码回退信息。

NapCat 侧常见变量：

```text
ACCOUNT=<QQ号>
NAPCAT_QUICK_PASSWORD=<QQ密码>
NAPCAT_QUICK_PASSWORD_MD5=<QQ密码的 MD5>
```

建议优先使用 `NAPCAT_QUICK_PASSWORD_MD5`，只在确认 NapCat 版本和部署方式需要明文密码时才设置 `NAPCAT_QUICK_PASSWORD`。如果 QQ 触发验证码或新设备扫码，Rabi 卡片会显示对应流程；人脸、短信或当前 NapCat API 未覆盖的验证仍会明确停下，不会绕过安全门。

## Windows 永久环境变量

PowerShell 示例：

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD_MD5 "<password-md5>"
```

如果必须使用明文密码：

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD "<qq-password>"
```

`setx` 写入后，只对新启动的进程生效。设置完后重启 NapCat Shell；如果 NapCat 是开机自启服务，也需要重启对应服务或重新登录 Windows 会话。

不要在命令行截图、日志、Issue、PR、文档示例或 RibiWebGUI 配置里保留真实值。需要排障时只说变量是否存在和值长度，不打印密码。

## 启动时自动登录

每个 Route 所绑定的 NapCat 都有“启动 Rabi 时自动登录”开关，默认开启。开启后，Manager 监听成功即提交后台任务：先复用已在线的正确账号，否则启动绑定的 NapCat Shell、选择已有 quick login，并修复 OneBot HTTP / WebSocket 配置。不同 Route 并发处理；绑定同一 QQ 的任务按账号串行。Manager 启动和 WebGUI 访问不等待这些步骤。

关闭开关只跳过该实例的启动时自动登录；“启动并管理登录”、健康检查、手动启动和重启仍可使用。需要扫码、验证码或新设备确认时，后台任务记录实际状态，用户之后直接在对应 Route 卡片完成验证。

## 进程守护

RabiRoute manager 会守护自己启动的路由子进程，并在 `data/route/*/adapterConfig.json` 或 `data/roles/*/personaConfig.json` 改动后自动重载受影响路由。NapCat 的启动时自动登录只运行一次；运行期间退出、掉线或登录失效后，仍由健康状态提示和用户操作处理。

由 Windows Host 启动 Rabi，再由路由中“启动 Rabi 时自动登录”启动绑定的 NapCat。不要再为同一实例配置任务计划或服务反复拉起，否则解绑后的外部守护程序仍可能启动它。

如果 NapCat 自动退出、QQ 被挤下线或 quick login 失败，先在对应 Route 点击“启动并管理登录”。自动恢复失败时，再展开详情查看 NapCat 日志、WebSocket 状态、HTTP `get_login_info` 和最近错误。

## RabiRoute 侧健康检查

RabiRoute NapCat adapter 会定期调用 OneBot `get_login_info`，默认每 60 秒一次。结果写入：

```text
data/route/<配置名>/gateway-status.json
```

可用环境变量调整频率：

```powershell
setx NAPCAT_LOGIN_REFRESH_SECONDS "30"
```

填 `0` 或负数可以关闭定期检查。这个检查只负责发现和展示登录态问题，不会替 NapCat 重新登录。

## 排查顺序

1. 在当前 Route 的 NapCat 卡片刷新登录状态，确认 QQ、OneBot HTTP 和 RabiRoute WS 各自的状态。
2. 查看 NapCat 日志里是否有 quick login、二维码登录、设备验证或 ServerTime 偏差提示。
3. 在 RibiWebGUI 看 NapCat 状态：WS 是否连接、HTTP 登录资料是否读取成功。
4. 若显示“账号在其他实例在线”，优先采用该在线实例；不要重复启动同一 QQ。只有确实需要迁移时，才先明确停止旧实例，再启动目标实例。
5. 若显示“快速登录已过期”，在卡片切到“扫码登录”并刷新二维码；不要持续点击快速登录。
6. 如果 QQ 经常掉线，先同步 Windows 时间，再重启 NapCat / QQNT。
7. 如果需要无值守，配置 Windows 开机启动 NapCat，再配置 NapCat 侧 `ACCOUNT` 和密码/MD5 环境变量。
