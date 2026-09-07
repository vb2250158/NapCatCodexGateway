[English](README_en.md) | 简体中文

# Rabi DSH Context

通过 DSH 生命周期事件把会话入口、用户消息、工具前后和轮次结束交给 Rabi Manager。人格、开关与执行决策由 Manager 管理；插件不保存第二份规则。

在 Agent 端点击“更新 Hook 到 Agent”，安装到本机 DSH `web` profile，再重新加载插件或重启 DSH。Manager 地址每次经 Host 发现并核对 `/meta`；源码或测试可通过 `RABI_MANAGER_URL` 提供完整地址。Manager 不可用时记录错误，DSH 仍可独立使用。

这是独立事件插件，可与 DSH 消息工具插件并存。旧消息工具插件自行施加的通信限制不受此插件控制。
