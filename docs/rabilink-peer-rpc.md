# 跨电脑接口调用

[English](rabilink-peer-rpc_en.md) | 简体中文

状态：实验支持。当前提供只读能力调用，使用局域网直连、公网 WebRTC 打洞尝试和受限 Relay 中转。自动化验证包含真实本机 WebRTC 数据通道、LAN 优先、直连失败后的 Relay 回退及应用隔离；跨运营商公网和真实双 PC 持续运行仍需各自验收。

## 调用另一台 PC

两台 PC 使用同一个 RabiLink 应用 token，并在线运行包含 `peer-rpc-v1` 的版本。Relay 也需要包含 `/api/rabilink/peer/proxy`。调用方通过当前 Host `status --json` 的 `managerBaseUrl` 读取 `/meta`，核对健康状态、application generation 和 Manager 实例后，再调用本机接口：

- `GET /api/rabilink/peer/list`：返回设备登记及 `summary` 分类计数。每项包含 `deviceKind`（如 `pc`、`phone`、`glasses`、`watch`）、目标 ID、在线状态、能力及 LAN 地址。缺失或非法类型统一为 `unknown`，不根据名称或能力猜测硬件。`summary.total` 是登记数，不是电脑数。
- `GET /api/rabilink/peer/list?deviceKind=pc&online=true`：仅查看明确上报为 PC 且在线的登记；摘要对应筛选后的结果。不带筛选时保留未知及离线记录。
- `POST /api/rabilink/peer/call`：按目标 ID 调用。控制入口仅允许回环访问；远端数据入口只接受加密协议。

请求示例：

```json
{
  "targetDeviceId": "pc-b",
  "capability": "plans",
  "operation": "list",
  "input": { "roleId": "Example" }
}
```

返回的 `transport` 为 `lan`、`p2p` 或 `relay`。`reply.ok` 才表示业务成功；`reply` 同时包含请求 ID、目标设备和运行实例身份。`plans.list` 只返回计划 ID、标题、状态和更新时间；`persona.manifest` 查询指定人格的文件清单。`system.describe` 不需要业务授权，返回当前实例与已开放操作。

## 目标电脑授权

PC 在事件连接和 worker 请求中明确上报 `deviceKind=pc`；手机和眼镜沿用已有的 `deviceKind` 上报。新版 Relay 保留已登记类型，旧客户端后续省略该字段不会清空它。历史登记不会按名称批量改写，需设备重新明确上报。客户端上报属于自述分类，不作为权限凭据；支持自定义类型扩展。

目标 PC 的运行数据根目录下 `data/rabilink/peer-access.json` 是唯一授权源；不存在、格式错误或超过 64 KiB 时关闭业务访问。修改后下次请求直接生效，不需要重启。

```json
{
  "schemaVersion": 1,
  "operations": ["plans.list", "persona.manifest"],
  "roleIds": ["Example"]
}
```

授权面向整个可信 RabiLink 应用组。共享 token 的成员具有相同的密码学身份，设备 ID 是寻址和误投检查，不是成员之间的独立身份认证。不要把互不信任的电脑放进同一个应用。加入应用不会自动开放业务查询、任意 Manager 路径、任务执行、消息发送或文件修改。

## 传输与生命周期

设备发现与人格同步复用同一模块。调用方每次从 Relay 获取当前设备地址，先用加密 `system.describe` 校验目标和 generation，再发送绑定该 generation 的请求。请求与回复统一使用应用密钥派生的 AES-256-GCM 加密，LAN 不传应用 token；Relay 只转发密文，固定到 `/api/rabilink/peer/receive`，不能由调用者指定 URL。

先尝试最多四个登记的私有 IPv4 地址，每个发现请求最多两秒。LAN 不可用时，经 Relay 交换加密 SDP，用现有 werift 实现建立一次 WebRTC DataChannel；STUN 只帮助发现地址，没有 TURN。一次直连尝试最多十二秒，单连接只完成一次调用，最多同时八条连接。连接失败后只读请求可使用 Relay，业务拒绝不会被改成成功。请求有效期最多两分钟，明文请求或结果最多 1 MiB，传输包有独立大小限制。

Manager RabiLink 插件拥有调用入口和 WebRTC 连接；停用时撤销路由、关闭连接并等待已接受的 HTTP 操作。旧 generation 的请求失败关闭，调用者重新发现后再发起新请求。

本协议版本只注册只读业务操作。新增写操作前必须扩展目标端的持久化请求去重、结果查询和不确定状态恢复，不能直接把写函数注册进现有只读重试流程。

## 现有功能的兼容边界

人格同步的设备发现已迁入共用模块。它原有的 LAN 文件传输、合并和 `/persona-sync/proxy` 继续为现有版本及写入合同服务；统一只读 RPC 不代替同步写入。退出条件是写入协议完成持久化去重及双 PC 验收、所有受支持 PC 已升级，届时把旧入口改成转换层并移除内部调用。视频仍保留独立通道和“禁止服务器承载视频字节”的带宽合同。

验证入口：`src/rabiPeer.test.ts`、`scripts/rabilink-relay-peers.test.mjs`，以及现有 Relay runtime、persona LAN 与同步 Coordinator 回归。自动化传输成功不代替远程 Relay 部署或公网验收。
