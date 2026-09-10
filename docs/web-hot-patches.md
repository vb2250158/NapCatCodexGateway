[English](web-hot-patches_en.md) | 简体中文

# 安装版 Web 热补丁

状态：实验能力。覆盖 WebGUI、静态资源、随页面编译的用户手册和独立 Web Bundle。首次安装本能力、修改后端、依赖锁或插件契约仍需受控完整发布；之后兼容 Web 修改可以保持 Manager 的 PID、application generation 和实例身份不变。

## 页面与版本

- 每份候选按内容 hash 保存完整 Web 输出、文档和插件入口。根 HTML 的 `data-rabi-web-release` 与 `x-rabiroute-web-revision` 指向同一候选。
- JS、CSS、字体、图片和延迟加载资源从 `/_rabiroute/web/<hash>/web/...` 读取；模块目录请求带 `webRelease=<hash>`。找不到对应模块时失败关闭，不混入另一版模块。
- 新打开或主动刷新的页面进入当前版本。已打开页面继续旧版，不强制刷新 Vue 实例，不重复提交表单，也不重新启动业务消费者。
- 根 HTML 不缓存；版本资源带 immutable 缓存策略。旧的 `/assets/...` 和无版本模块入口仅供升级前已经打开的页面使用，读取安装基线，不作为新页面的发布入口。退出条件是所有升级前页面关闭或刷新；新构建根 HTML 必须只引用版本化资源。
- 回滚仅改变后续页面选择；已提交的业务数据不会撤销。后台源码的兼容范围另见[源码热补丁](source-hot-patches.md)。

## 自动构建与激活

1. 由唯一发布 owner 完整构建并安装支持本能力的版本。操作前通过 `RabiRouteHost.exe --command status --json` 动态发现 `managerBaseUrl`，核对 `/meta` 的 `applicationGenerationId`、`managerInstanceId`、`health.state=healthy`、`health.requiredReady=true`。
2. 为 Host 配置受信任源码根 `RABIROUTE_HOT_PATCH_SOURCE_ROOT`；`RABIROUTE_HOT_PATCH_WATCH=0` 会关闭自动激活。不要指向其他任务正在清理的构建目录。
3. 只构建一次运行 `npm run webgui:build`；持续开发运行 `npm run webgui:watch`。后者监听 Web 源码、共享契约、资源及文档，串行运行类型检查和正式 Vite **生产构建**，不启动开发服务器。停止监听不关闭 Manager。
4. 构建器独占 `ribiwebgui/.web-patch-build.lock`。并发构建拒绝执行；进程异常终止留下锁时，核对记录 PID 已退出且无构建 owner 后再移除该锁，不能删除正在使用的锁。
5. 输入在构建期间变化、类型错误、缺资源、错误 hash 或不兼容后端都不会发布完成标记。监听模式在下一次有效输入变化后重新构建；不会无限重试同一失败输入。
6. 构建成功后写入 `dist/web-patches/<hash>`，最后原子替换 `dist/web-patches/latest.json`。Manager 只消费完整标记，校验后原子更新活动指针和操作回执。构建无需复制文件到安装目录。

后端兼容指纹包含编译后的 JS/MJS、非 Web JSON、`package.json` 和 `package-lock.json`。修改这些文件后，Web-only 发布拒绝执行；不得改指纹绕过门禁。

## 查询、手工发布与回滚

| 接口 | 合同 |
| --- | --- |
| `GET /api/web-patches` | 返回状态、当前/上一候选、revision、运行身份和容量限制；不写业务数据 |
| `GET /api/web-patches/operations/<operationId>` | 返回原回执；已提交为 200，服务就绪且未开始为 404，状态受阻或未就绪为 503/unknown |
| `POST /_rabiroute/host/web-patches` | 仅 loopback 和 Host 控制权限；发布已导入的候选，不接受网络源码或路径 |
| `POST /_rabiroute/host/web-patches/reconcile` | 同等权限；只核对已结束的本地持久化尝试，不重新执行发布或业务写入 |

正常运维通过 Host 转发，不读取或传播 Host token。先从当前状态取得身份、`revision` 和候选 hash，把完整请求保存到绝对路径。回滚时 `candidate` 使用状态的 `previous`；首次回滚后仍产生新的 revision：

```json
{
  "operationId": "web-release-operation-unique-id",
  "applicationGenerationId": "<current application generation>",
  "managerInstanceId": "<current Manager instance>",
  "pluginGenerationId": "<current plugin generation>",
  "candidate": "<64 lowercase hex characters>",
  "expectedRevision": 1
}
```

```powershell
& $hostExe --command web-patch --application-generation-id $generation --web-patch-request $requestPath --json
```

同一操作 ID 的载荷冻结；同键不同候选或 revision 被拒绝。Host 转发超时为未确认，先查原操作，不能换键重放。必要时保持原 `operationId`、更新为当前核实身份，通过 `web-patch-reconcile` 命令核对。结果 `committed` 返回已提交回执，`not_started` 才允许按原业务决定重试，`unknown` 继续冻结。状态文件损坏不会自动清空历史。

## 容量与维护

当前每份候选最多 8192 文件、128 MiB，总体最多保留 64 个候选；每个后端基线最多 2048 个发布回执。内存仅缓存 8 份 manifest，文件响应在读取时核对 hash，整个响应使用同一 Buffer。

本版**不自动删除磁盘旧候选或历史回执**。达到容量后停止新发布，旧服务继续；这仍需运维容量治理，不能宣称无限连续热更新。离线归档前须冻结发布、保留全部状态/回执备份、确认旧页面退出及旧后端不再恢复；不能只按文件时间删除候选。没有完成这些条件就保持容量告警，不清数据。

## 验收

运行 `npm run test:web-patches`、Host 合同测试、`node --test scripts/dynamic-manager-active-truth.test.mjs` 和 `npm run build`。真实控制面验收还须验证：

- 更新前、中、后持续 HTTP 查询；旧页面延迟资源、用户手册和独立模块仍对应旧 hash。
- 一次修改自动进入新版，再用正式 Host 命令回滚；Manager 身份与后台进程保持不变。
- 编译/完整性/持久化失败继续旧服务，超时或客户端断开不产生重复业务效果；原操作仍可查。
- 新根 HTML 和实际下载字节匹配候选 hash；不得用源码测试、单次健康检查或开发服务器代替安装版证据。
