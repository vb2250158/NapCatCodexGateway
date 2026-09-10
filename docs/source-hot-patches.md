[English](source-hot-patches_en.md) | 简体中文

# 源码热补丁

状态：部分运行验收通过，完整覆盖仍在开发。2026-09-10 已在安装版验证插件目录模块自动修改与恢复（revision 0→1→2），期间 Manager 身份和模块 Worker 不变。该验收仅覆盖已接入的插件目录模块，不代表全部源码、资源或复杂闭包均可热更新。现有插件重新协调接口与本页的源码补丁接口分别维护。

Agent 开发与验收流程见 [源码热补丁开发 Skill](../skills/source-hot-patch-development/SKILL.md)。该文件在仓库内按需读取，不代表已安装到每个 Agent。

## 当前实现

### 升级与遗留项检查

- 首次取得本能力或修改热补丁运行时本身，仍需通过 Host 安装新版本；之后清单内兼容源码与资源修改由监听器自动发布，不要求每次重启。
- Developer Channel 完整替换发行包的文档、插件、Skill 和源码补丁清单；已删除文件不能从旧包重新混入。构建与验收必须来自同一冻结源码，不能复用另一任务正在清理的 `dist/`。
- 安装后重新发现 Host 地址，匹配 `/meta` 的 generation/instance，核对 `/api/source-patches`、自动监听状态以及 WebGUI 根 HTML 引用的实际资源 hash。
- 运行数据中的动态注册、活动指针和未知操作回执是恢复依据，不是可清理的旧文件。保留原因是避免重复初始化和未知操作重放；仅在原操作核对完成并经显式迁移后退出旧基线。不得以删除记录、改 ID 或重置业务数据代替迁移。

### 新增模块，不修改核心

在源码根创建模块及资源，在 `source-patches/modules.json` 的 `modules` 数组追加声明即可。例如：

```json
{
  "id": "example.counter",
  "source": "src/extensions/counter.ts",
  "resources": ["assets/counter-label.txt"],
  "dependencies": { "state": { "count": 0 }, "settings": { "step": 1 } },
  "contract": { "description": "有状态计数 / Stateful counter" }
}
```

模块用 `declare const state`、`declare const settings` 声明具名依赖，导出可调用函数。`dependencies` 是最多 64 KiB 的 JSON 初值，经结构化克隆交给模块 Worker；不是跨模块可变引用或任意函数注入。模块变量、类实例和依赖对象的运行状态在兼容代码更新时保留。改变这些初值不能冒充迁移：监听器拒绝替换已注册的依赖，不会重置当前状态。需要状态迁移时，由模块拥有者提供正向和反向迁移，使用下文的显式迁移协议；当前自动监听不执行声明结构迁移。

接入插件通过统一的 `host.manager.source-patches@1` 服务调用 `invoke(moduleId, exportedSymbol, arguments)`，结果包含实际请求版本与契约；`status()` 返回观测状态。业务 HTTP 路由、权限与入参校验仍归接入插件，不自动公开任意函数调用接口。新增模块不需要再向热补丁核心登记名称。

首次注册保存 `data/.runtime/source-patches/registrations/<moduleId>.json`：先记录 `preparing`，模块初始化成功并保存 `active` 后才开放调用。注册过程与插件 generation 切换共用串行发布边界。中断后只有 `active` 注册恢复；`preparing` 或损坏记录保持失败，不重新执行初始化。初始化代码必须无业务写入副作用；Worker 隔离不是恶意代码沙箱。注册失败不自动删除记录或换模块 ID 重试。

已注册模块的基线、已确认补丁和声明依赖可在正常重启后恢复；恢复的是代码与初始依赖，不是内存快照。清单删除模块只停止自动监听，不擅自终止正在服务的调用或删除持久记录；重新加入相同 ID 使用原实例和基线。将动态模块纳入安装包造成基线冲突时，需要显式 rebase，不能用新包覆盖旧记录。一次新增多个模块各有独立注册结果，不把首次初始化宣称为跨模块业务事务。

监听器使用有界的独立编译 Worker。清单修改会更新资源与相对 TypeScript 依赖的监听；非法清单保留上一次有效配置。编译期间再次保存会丢弃过时候选。共享依赖或资源的已有模块通过受管两阶段事务发布；无关模块分组处理，一个模块编译失败不会阻挡另一组。新模块自动编译并注册，不需要修改热补丁核心、补业务专用分支或重启 Manager。

当 `RABIROUTE_HOT_PATCH_WATCH` 未设为 `0` 时，Manager 监听源码根下的 `source-patches/modules.json` 及其声明的源码、依赖和资源。清单可以在运行后首次创建；初次扫描在后台注册缺少的模块。安装版可通过 `RABIROUTE_HOT_PATCH_SOURCE_ROOT` 指向已存在的外部源码根目录。文件变化经过 200ms 防抖后编译为不可变候选，资源内容和 SHA-256 与代码一起发布。请求租约选择对应代码和资源版本。编译、兼容性检查或发布失败保留旧版本；结果不确定时冻结原操作，不重放。未配置外部源码目录的安装包只观察自身清单路径，不扫描用户其他目录。

`scripts/lib/hot-patch-compiler.mjs` 解析 TypeScript 模块，通过符号解析保留局部遮蔽，将模块绑定引用转换成环境访问。初始模块只初始化一次；同名函数的后续实现通过稳定调用入口选择。支持具名顶层函数、递归、内部调用、异步函数、普通模块变量、普通类的实例与静态方法，以及通过 `declare` 声明并由宿主提供的依赖。类方法更新保留类身份、已有实例字段和绑定回调；构造函数及字段初始化变化仍拒绝应用。

`src/plugin-kernel/hotPatchModule.ts` 安装编译结果，并在兼容检查后应用整批函数变更；需要改变宿主状态时，使用其 `applyWithStateMigration` 与 `rollbackWithStateMigration`，由模块入口统一执行副本迁移、排空检查和版本切换。状态初始化、依赖、导出及签名变化拒绝应用，要求显式迁移。保留的回调会使用当前实现；一次已开始的异步函数调用及其关联调用仍使用原版本。函数创建的普通闭包可以执行，但已经返回的闭包正文尚不能原位替换，不应宣称支持完整闭包热更新。

`src/plugin-kernel/hotPatchRuntime.ts` 持有单调版本、整批函数表、不可变 JSON 契约和请求租约。失败不部分发布；回滚生成新的版本号，指向保留的前一份实现和契约，不撤销已经提交的业务数据。需要改变运行状态时，调用 `applyWithStateMigration`，由调用方提供显式迁移函数；迁移在发布前执行，任何迁移或补丁失败都会恢复调用方原状态并保持旧版本。保留版本达到配置上限时拒绝新补丁，等待已接受操作释放租约。基于保留表的单元测试不等于实际堆内存验收。

具名函数和普通类方法支持同步、异步生成器。迭代器创建时固定版本，后续 `next`、`throw`、`return` 及内部调用在该版本执行；异步排队恢复同样保留版本。正常结束或异常结束才释放租约，`finally` 继续 `yield` 时不会提前释放。调用方必须消费完毕或调用 `return` 并完成清理；遗弃迭代器不自动证明已排空。进程内可消费生成器，但直接把迭代器作为 IPC 返回值会关闭该迭代器并明确拒绝，尚不提供跨进程流式迭代协议。

现有 Manager 插件路由现在绑定 effect 提交时的 activation 身份，只分发当前已发布 generation 中仍 active 的注册批次。候选 effect 尚在准备或最终失败时，其路由不会抢先覆盖旧路由。这修正了插件更新的路由可见性边界，但还不等于源码函数表、依赖和文档已接入同一次发布。

`HotPatchCandidateStore` 只按 SHA-256 从指定本地目录读取有大小上限的普通文件，验证文件身份、内容 hash 和产物结构后返回不可变快照，不执行代码。它不是发布授权，也不提供远程上传接口。编译时按源码真实路径解析类型导入，并检查目标模块的 TypeScript 语义错误；错误包含文件、行列和诊断编号，不输出候选。兼容摘要纳入类型声明、导入文本及已解析的传递类型依赖内容；依赖内容变化保守拒绝并要求迁移。当前使用独立 ES2022/Bundler 编译选项，不等于项目完整 strict 检查，也不执行依赖模块；完整构建仍是验收条件。动态 `import()` 暂时明确拒绝。

## 信任与生命周期

`src/plugin-kernel/hotPatchProcess.ts` 提供独立子进程执行单元：请求与补丁队列有界，补丁和回滚保持 PID 及模块状态。同步死循环只阻塞所属执行单元；超时终止该单元，不重放已接受调用。默认停止先关闭入口，再等待已接受调用及排队补丁结束；强制停止不保证业务结果，调用方必须保留不确定状态。这不是安全沙箱；当前接入插件目录展示的只读路由，尚未接入真实业务写入。

编译结果是可执行本机代码，不是数据沙箱。`node:vm` 仅用于生成可回收的实现函数，不提供权限隔离。只允许可信开发者生成并通过正式发布流程安装；不得直接把网络请求正文交给编译或安装入口。发布 API 不接收源码或文件路径，只接收预先放入受管目录的候选 hash，并要求本机 Host 权限。

`run` 追踪返回的 Promise；HTTP 接入需要使用显式租约并同时覆盖响应和实际业务完成，不能仅在连接关闭时释放。脱离返回 Promise 的后台任务必须单独管理生命周期，当前运行时不会自动证明任意定时器或事件监听器已排空。

## Manager 接入与发布合同

执行单元启动与已接受调用使用独立预算：`startupTimeoutMs` 和 `timeoutMs` 默认均为 15 秒。缩短调用超时不同时缩短进程启动预算；初始化超时仍只终止所属单元。启动预算包含进程创建、模块加载和初始化，不是忽略初始化死循环。

只改接口说明时，可以保持当前 `candidateSha256`，提交新的 `contract`。它同样生成新版本、保留旧请求的旧契约，并支持回滚，不重建类实例或重置模块变量。函数和契约都未变化的请求拒绝；JSON 对象字段顺序改变不算契约变化。当前校验契约的可序列化结构，不自动证明描述与业务实现语义一致，发布者仍需相应行为测试。

- `source-patches/modules.json` 声明源码模块与双语接口契约。完整构建生成 `dist/source-patches/catalog.json` 和内容寻址的基线产物；运行时不依赖 TypeScript 编译器。
- `/api/plugins/catalog` 的真实格式化逻辑位于 `src/manager/pluginCatalogPresentation.ts`，运行在独立执行单元中。返回头 `x-rabiroute-source-revision` 来自实际请求租约，不从响应完成时的最新版本推测。源码更换不重开监听端口。
- `GET /api/source-patches` 返回缓存的执行单元状态、最近确认的版本和契约，不等待业务执行单元。模块分别初始化、分别就绪，一个模块失败或初始化卡住不阻止健康模块接收请求。它是观测快照，尚不能证明所有模块的文档与函数表已跨进程原子发布。
- `POST /_rabiroute/host/source-patches` 要求 loopback、当前 Host token，以及 `operationId`、`action=apply|rollback`、`moduleId`、`expectedRevision`、`applicationGenerationId`、`managerInstanceId`、`pluginGenerationId`。应用还需 `candidateSha256` 和配套 `contract`。发布队列与插件重新协调共用 generation 变更边界；旧身份拒绝。
- `GET /api/source-patches/operations/{operationId}` 查询原操作。原 ID 与相同载荷返回已保存结果，不再次执行；换载荷拒绝。`pending` / `indeterminate` 不代表成功；有不确定结果的模块禁止继续发布。公开回执不包含内部恢复证明或载荷摘要。
- `POST /_rabiroute/host/source-patches/reconcile` 使用原 `operationId`、`moduleId` 和新鲜的三项运行身份核对，不重新执行补丁。匹配的持久活动指针可证明提交；否则仅同一应用、Manager、PID 和随机执行身份下的精确版本、源码 hash、契约可证明提交或未开始。进程重建且没有持久提交证明时继续保持未知，不凭新进程的初始版本推断旧操作未执行。
- 候选目录为运行状态根下的 `data/.runtime/source-patches/candidates`。操作记录与活动源码指针保存于相邻目录。冷启动可恢复已确认源码；包基线改变时要求显式 rebase，不悄悄应用旧候选。这里恢复的是代码，不是任意堆对象或业务数据。

发布前先持久化模块准入锁，再写操作日志，二者完成后才执行补丁。准备失败且失败回执可保存时返回 `not_started`；若锁已落盘但日志及失败回执均无法保存，重启后仍禁止该模块继续发布，原日志缺失返回 404，不自动删除锁或制造成功回执。核对与同模块的启动恢复读取串行，健康和其他模块入口不等待这段核对。

Host 源码已接入 `--command source-patch` 与 `--command source-patch-reconcile`：同时传入 `--application-generation-id <动态发现的代号>` 和 `--source-patch-request <绝对 JSON 文件路径>`。文件包含上述发布或核对字段，最多 16 KiB；Host 保留原载荷，通过自己的私有权限转发到已发布的 Manager，不启动新 Host、不重启应用。并行转发上限为 4，不占用 Host 主命令循环；回执超时、超大或身份不符时返回未确认，不自动重放。CLI 的 `ok` 只表示收到了有效响应，仍须检查其中原操作的 `state` 与 `commitState`。不要提取或复制真实 Host token。该入口已通过隔离传输测试，安装版尚未部署验收。

## 待完成的验收范围

- 私有字段、继承、访问器和现存闭包的转换，以及跨进程迭代协议；当前不支持的模块声明明确拒绝。
- 自动依赖装载、声明迁移、复杂闭包原位更新，以及完整构建与补丁行为一致性。
- 与插件 generation、正式路由和文档快照的原子接入。
- Host CLI 的安装版验收、跨包基线迁移及更完整的进程与断电恢复；文件同步与故障注入测试不等于已验证任意断电场景。
- 真实 HTTP 连续请求、写入幂等、消费者独占交接、长连接与堆资源回收。
- 完整构建、受管运行环境验收及无关接口故障隔离。

## 本地测试

使用 `npm run hot-patch:compile -- --source module.ts --output-directory data/.runtime/source-patches/candidates` 生成候选。可增加 `--baseline <旧候选文件>` 检查兼容性并跳过没有实现变化的输入。输出文件以内容 SHA-256 命名，不覆盖旧候选；这一步只编译，不激活补丁。

```powershell
npm run test:hot-patches
```

HTTP 夹具通过操作系统分配的回环端口验证旧请求跨补丁完成、新请求使用新实现、监听地址不变及回滚保留计数。它不等于正式 Manager 运行验收。这些测试不启动 Manager、不写业务计划、不发送消息，也不安装补丁到正在使用的服务。

`scripts/hot-patch-manager-api.test.mjs` 使用真实目录和发布 handler，覆盖权限、原操作去重、代码恢复、回滚及故障模块隔离。完整构建后，在该测试进程设置 `RABIROUTE_HOT_PATCH_TEST_BUILT=1` 可改用 `dist/` 的 Manager 服务与原生 JavaScript 子进程；`scripts/hot-patch-process.test.mjs` 同样支持该选项，验证编译后的生成器边界及执行单元。它们仍是隔离测试，不是安装版整机验收。

完整构建后另运行 `npm run test:hot-patches:manager`：按项目现有隔离测试方式，在临时数据根启动已构建的 `startManager` 控制面及 core/diagnostics 插件，读取结构化 READY，再验证真实目录接口的源码替换、文档单独发布、回滚、原操作查询和并行健康读取。应用身份、Manager PID 和源码执行单元 PID 保持不变。夹具最后经自己的 Host 控制权限关闭测试控制面，不操作安装版 Host；它不经过产品单实例启动入口，不等于安装、冷启动或完整 Host CLI 验收。

### 隔离 Worker 的状态迁移

`HotPatchProcess` 现在支持把状态绑定到初始化时传入的命名依赖，并通过 `applyWithStateMigration` / `rollbackWithStateMigration` 在 Worker 内执行显式同步迁移。迁移源码只能由受管候选调用方提供；迁移前要求所有旧版本租约排空，迁移失败时保留旧代码和旧状态，成功后返回新的 `snapshot` 与状态证明。Worker PID、连接和有界变更队列保持不变。

状态依赖使用结构化克隆进入 Worker，调用方通过 `snapshot(stateDependency)` 获取只读证明；不把任意业务对象或函数跨进程传输。迁移执行期间若 Worker 超时，按 Worker 故障处理，已接受调用不自动重放。

### 跨模块原子发布

`HotPatchBundle` 用同一受管操作编排多个 `HotPatchModule`：先为全部模块编译并校验基线、符号和契约，再按固定顺序提交。任何模块预检失败时不改变已运行模块；提交阶段出现异常时回滚已提交模块。该编排器适用于同一进程内模块集合；独立 Worker 仍需由上层发布服务按模块组建立对应的受管边界。

### 独立 Worker 的两阶段发布

`HotPatchProcessBundle` 为独立 Worker 提供 `prepare`、`commit`、`discard` 两阶段协议。所有 Worker 先锁定候选、基线和契约，再提交代码；提交失败会回滚已提交 Worker，并丢弃其余准备令牌。准备令牌只在当前 Worker 进程内有效，Worker 重启或通信超时后不自动重放，必须按持久操作回执恢复。

准备令牌在同一 Worker 上只能存在一个；重复准备会拒绝，避免并发候选覆盖。提交、丢弃或 Worker 关闭后令牌失效。

跨模块入口还必须用同一个 `HotPatchBundle.run(...)` 包住完整异步操作；该调用一次取得所有模块租约，直到返回值/迭代器完成后才释放。只在发布时使用 Bundle、而让业务分别直接调用模块导出，不满足请求级版本固定。

### 多模块正式发布接口

`POST /_rabiroute/host/source-patches` 也接受 `action=apply-bundle`。请求包含统一 `operationId`、当前三项运行身份，以及至少两个 `entries`；每个 entry 提供 `moduleId`、候选 `candidateSha256`、`expectedRevision` 和可选 `contract`。Manager 会先让所有 Worker 准备，再统一提交；任一提交或指针持久化异常都会保留统一操作为 `indeterminate`，并在相关模块上设置 admission fence。冷启动会异步恢复该 fence，不阻塞健康模块就绪。`GET /api/source-patches/operations/{operationId}` 使用同一个操作 ID 查询，不能用新 ID 重放。

### 资源快照读取层

自动监听发现资源文件变化后，会生成带 `SHA-256` 的不可变资源快照。`src/plugin-kernel/hotPatchResourceStore.ts` 提供 revision、快照读取和请求 lease：已进入的请求可以继续读取旧资源，新请求读取新快照；旧快照在没有 lease 后回收。业务模块在 `modules.json` 声明资源路径，并在源码中声明 `__rabiResources` 依赖；运行时自动提供 `read(path)` 与 `text(path)`，但只允许在有效请求租约内读取。
