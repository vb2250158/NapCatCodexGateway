<!-- docs-language-switch -->
<div align="center">
<a href="./plugin-bundles_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 插件包、执行边界与热替换

RabiRoute 的主干负责应用生命周期、业务状态与插件内核，功能沿插件树扩展。插件不是另一套 Host：它只能在 Manager 给定的 generation、权限、依赖和进程租约里提供能力。Windows Host、Manager 和托盘的生死关系不由普通插件控制。

## 唯一正式格式

Manifest 与 Profile 都只接受 schema v2。任何其他版本都不做兼容解析；未知或退役字段会直接报错，避免一份包在不同机器上得到两套生命周期语义。

正式目录：

```text
plugins/
  profiles/desktop.json
  builtin/<package-id>/<version>/rabi.plugin.json
  builtin/<package-id>/<version>/manager.mjs
  builtin/<package-id>/<version>/web/
```

树外插件使用同样的包结构、Schema、SDK 和 Profile 实例合同。内置身份不授予额外生命周期权限。

## Manifest v2

```json
{
  "schemaVersion": 2,
  "id": "io.example.feature",
  "version": "1.0.0",
  "entries": {
    "manager": {
      "execution": "isolated",
      "module": "./manager.mjs"
    },
    "desktop": {
      "execution": "declarative",
      "resource": "./desktop.json"
    }
  },
  "provides": ["example.feature@1"],
  "requires": ["manager.core@1"],
  "optional": [],
  "permissions": ["example.read"]
}
```

`provides`、`requires`、`optional` 和 `readyRequires` 使用 `name@major`。包路径必须留在包目录内。未知字段、重复能力、无效权限和 capability 冲突均在执行前拒绝。

## 三种执行模式

| 模式 | 用途 | 隔离与限制 |
| --- | --- | --- |
| `in_process` | 随 Manager 发布、经过审阅且需要直接服务对象的可信核心插件 | 在 Manager 进程内执行；必须使用 SDK lifecycle/effect，不能另造应用 owner |
| `isolated` | 树外代码、故障面较大或需要独立进程的插件 | loader 不导入入口顶层代码；专用 Plugin Runtime Host 通过受限 RPC 和可结构化克隆数据交换；子进程由 lease 收回 |
| `declarative` | Desktop/Web 等只需声明菜单、面板、主题或资源的贡献 | 不执行插件 JavaScript；内核读取并校验声明资源，再交给对应表现适配器 |

执行模式属于 entry，不属于整包；同一个包可为不同 host 声明不同模式。不能通过 manifest 填写任意命令行、可执行路径或脱离包目录的资源。

## Profile v2

Profile 是某个部署要启用哪些实例的唯一真源：

```json
{
  "schemaVersion": 2,
  "readyRequires": ["manager.core@1"],
  "instances": [
    {
      "id": "manager:example",
      "package": "io.example.feature",
      "version": "1.0.0",
      "enabled": true,
      "config": {},
      "grants": ["example.read"],
      "policy": {
        "restart": {
          "mode": "on_failure",
          "maxAttempts": 3,
          "windowMs": 60000,
          "initialBackoffMs": 500,
          "maximumBackoffMs": 10000
        },
        "resources": {
          "memoryMb": 256,
          "maxChildProcesses": 2,
          "shutdownTimeoutMs": 5000
        }
      }
    }
  ]
}
```

`grants` 只能授予 Manifest 已声明并被部署允许的权限。`policy` 约束实例重启与资源；缺省策略由内核统一补齐，不由插件自行解释。只有所有 `readyRequires` 都已由已激活服务提供，Manager generation 才能对 Host 报 ready。

## 身份与生命周期

每个激活实例使用完整身份：

```text
applicationGenerationId
managerInstanceId
activationId
instanceId
pluginId
version
revision
host
```

外部请求、进程租约、日志和贡献都应能追到这组身份，不能只用可重复的插件名或 PID。

插件通过 `activate(context)` 注册服务、贡献和 effects。`context.lifecycle.signal` 是取消真源；effect 只能在候选 generation 提交后启动。替换或关闭时，内核先停止接受新请求并触发 signal，然后按依赖图逆序释放：消费者先于提供者，同一实例的 effect/disposer 也按受控顺序结束。

## Process Lease

插件需要长期子进程时必须经统一 Process Lease Registry 创建。租约 owner 至少包含应用代、Manager 实例、activation、插件实例和 revision。Registry 执行：

- 同一 owner/key 防重复；
- `maxChildProcesses` 资源上限；
- quiesce 后拒绝新子进程；
- 在 `shutdownTimeoutMs` 内排空，超时后终止进程树；
- generation、实例或 Manager 释放时回收所有租约。

插件直接 `spawn` 后丢失 owner 属于设计矛盾。Windows Job 会在应用代结束时兜底清理，但不能替代插件租约。

## 热替换

Profile 或包 revision 变化时，Plugin Kernel：

1. 读取并校验 v2 Manifest/Profile；
2. 建立 capability 图，拒绝缺失依赖和循环；
3. 按执行模式准备候选，不让 `isolated` 顶层代码进入 Manager；
4. 验证 `readyRequires`、权限和贡献；
5. 原子提交候选 generation，新请求只进入新图；
6. 排空旧请求，按消费者 → 提供者顺序释放旧图和租约。

候选失败不会污染当前 generation，也不会留下半激活服务或子进程。未变化且未依赖变化的实例可以保留；依赖 provider 更换时，对应消费者必须一起更换。

## 作者门禁

可信 Manager 包可使用共享 SDK、Node 内置模块和包内 `./` 模块拆分实现。入口检查拒绝其他裸依赖、跨包路径和符号链接；这不是 JavaScript 沙箱，执行权限仍由 entry 模式和宿主能力边界决定。包内业务模块随插件一起构建，不能回引源码工作树。

```powershell
npm test
npm run build
npm run check:config
```

新增插件还需验证：非 v2 Schema 被拒绝；`isolated` 顶层代码未被 Manager loader 执行；缺少 `readyRequires` 时 Manager 不报告 ready；消费者先于 provider 释放；进程租约在 reload、失败和 Manager 退出后归零；Desktop/Web 只消费声明贡献，不获得应用生命周期能力。
