---
name: source-hot-patch-development
description: 开发、验证和排障 RabiRoute 源码热补丁。用于修改增量编译、版本租约、状态保留、受管发布、回滚或接口不停服更新；先核对实际支持矩阵，不把插件重新协调当作任意源码热更新。
---

# 源码热补丁开发

## 先读与边界

- 先读 [源码热补丁](../../docs/source-hot-patches.md)、[代码架构](../../docs/code-architecture.md) 和目标功能文档，再检查工作区差异与原 owner。
- 当前能力仍在开发；文档中的未完成范围不得标为已支持。完整方案不等于任意闭包、类布局、跨模块依赖或业务数据可以自动迁移。
- 自动化验收必须包含清单修改、相对类型依赖变更、原子保存、编译中连续修改及非法清单修复。分别核对重新编译、兼容拒绝与真正激活；不要把依赖触发成功写成依赖不兼容也能自动迁移。跨模块自动发布复用受管两阶段事务。
- 不另建 Manager，不覆盖运行目录，不用重复带查询参数的 `import()` 充当补丁，不重跑构造函数恢复状态。
- 状态结构变化必须通过 `HotPatchRuntime.applyWithStateMigration` 提供显式迁移函数；迁移失败必须保留旧版本并恢复调用方状态，禁止静默重建实例或部分激活。
- 编译产物是可信开发者的本机可执行代码，`node:vm` 不是安全沙箱。网络 API 只接受受管候选 hash，不能接受并执行任意源码或路径。

## 实施顺序

源码模式或设置了 `RABIROUTE_HOT_PATCH_SOURCE_ROOT` 的安装模式下，使用内置 `SourcePatchWatcher`：只监听源码根目录中 `source-patches/modules.json` 声明的文件，自动编译并走现有受管发布。不要监听整个仓库、资源目录或任意用户路径；源码错误、兼容性错误和 `indeterminate` 结果必须停留在旧版本，禁止 watcher 自动重试或换 key。资源文件只有在对应模块把资源纳入候选契约并能证明状态迁移安全时才可自动应用。

1. 固定本轮源码、类型依赖、基线产物和对应契约；保留共享工作区他人改动。普通完整构建输出不是运行目录。
2. 用 `npm run hot-patch:compile -- --source <源码文件> --output-directory <候选目录> --baseline <基线候选文件>` 编译。类型诊断、状态/签名/依赖不兼容均先修复或明确迁移，不能绕过校验换一个基线冒充成功。
3. 先跑 `npm run test:hot-patches`，再 `npm run build`，最后 `npm run test:hot-patches:manager`。后者使用临时数据与隔离控制面，不操作安装版 Host；不能代替安装版验收。
4. 行为测试覆盖原请求跨补丁完成、新请求采用新实现、原回调和实例保留、显式状态迁移及失败恢复、错误与回滚、契约单独更新、资源释放；涉及生成器时覆盖排队 `next`、`throw`、`return` 和会继续产出的 `finally`。
5. 请求租约覆盖业务实际完成，不因客户端断开就释放在途写入。生成器须消费或显式完成清理；不能把遗弃迭代器或未追踪后台 Promise 当作已排空。当前跨进程返回迭代器明确拒绝。
6. 同步中英文专题文档及必要索引，准确区分源码、构建、隔离运行、安装版和真实业务验收。Skill 只保留流程，接口细节链接权威文档，不复制另一套状态表。

## 受管发布与核对

- 只有发布已获授权且相关在途写入和不确定操作已核对时才操作安装环境；按 [长期维护](../../docs/rabi-maintenance.md) 确认唯一发布 owner。源代码开发授权不自动提供共享实例切换窗口。
- 用 `RabiRouteHost.exe --command status --json` 动态发现完整 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`。再读 `/meta`，核对两项身份、`health.state=healthy`、`requiredReady=true` 和当前插件 generation。不得固定端口、扫描端口或读取退役锁寻找服务。
- 使用 Host 的 `source-patch` 命令转发本地请求文件，不提取真实 Host token。源码实现存在不代表安装版已有该命令；先核对运行版本能力。
- 一次发布使用唯一稳定 `operationId` 与精确基线身份；查询原操作后判断 `state`、`commitState`。传输成功或 CLI `ok` 不等于提交成功。
- `pending`、`indeterminate`、断连或进程更换时冻结原载荷，不盲目重放、换键或直接改回执。正式 `source-patch-reconcile` 仅凭已有运行身份与持久证明核对；没有证明保持未知。
- 回滚只影响后续代码入口，不撤销已提交数据、邮件或消息。读取新契约、实际响应版本及代码 hash，确认无需重启且无剩余生命周期操作后才报告本次运行验收通过。

## 跨模块变更

新增模块通过清单发现并自动注册，不允许在热补丁核心新增业务名称分支。使用 `dependencies` 声明 JSON 初始状态与参数；后续改变初值必须拒绝或通过模块拥有者的显式迁移完成，不能重置运行对象。插件消费统一的 `host.manager.source-patches@1` 服务，路由与权限仍由插件持有。新增模块验收要覆盖运行后首次创建清单、独立坏模块、代码和资源更新、Worker/PID 不变、注册中断冻结、正常重启恢复与回滚；仅验证状态列表出现新 ID 不足以通过。

多个同进程模块必须通过 `HotPatchBundle` 先全部 `prepare`/`validate`，再提交；禁止直接循环调用各模块的公开发布入口。独立 Worker 不得伪装成同一原子事务，必须由上层明确 Worker 组、状态 owner、失败回滚和持久回执边界。

独立 Worker 发布必须使用 `HotPatchProcessBundle` 的两阶段协议；发生进程重建、通信超时或回滚失败时保持操作不确定，不自动重放候选。

同一 Worker 同时只能保留一个准备令牌；新候选必须先丢弃或提交旧令牌。

跨模块业务入口必须以 `HotPatchBundle.run(...)` 包住完整异步调用；只用 Bundle 发布、不用 Bundle 请求租约时，仍可能跨模块混用版本。

## 资源快照接入

资源监听负责捕获资源并把资源快照放进候选包。模块在源码中声明 `declare const __rabiResources`，通过运行时提供的 `read(path)` 或 `text(path)` 读取；读取自动使用当前请求的代码 revision。不能直接持有可变全局资源对象。资源结构变化必须提供显式迁移；无法证明旧请求与新资源隔离时，拒绝补丁而继续使用旧版本。
