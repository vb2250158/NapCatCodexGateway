# 手机与电脑视频直连

[English](rabilink-direct-video_en.md) | 简体中文

状态：实验接入，尚未完成眼镜真机验收。Android 手机与电脑的 WebRTC 数据通道已实测传递 30 块、480,000 字节；本次眼镜测试在 Phone SDK 蓝牙连接阶段返回 `success=false`，未收到摄像头数据。公网跨运营商打洞尚待验证。

## 传输与带宽

另有独立于 CXR-L 取帧 API 的官方直播入口：[Rokid FAQ](https://global.rokid.com/pages/faq) 说明 Hi Rokid App 可配置自定义 RTMP 地址与推流密钥，眼镜连接 Wi-Fi 或手机热点后开播。这不等于 CXR-L 提供自动开播 API，也不自动具备手机到电脑的公网打洞能力。本项目正在验证原生直播到本地接收端的路线，尚未取得这条路线的真机画面证据。

手机使用 WebRTC 的可靠有序 DataChannel 将眼镜 SDK 返回的 H.264 数据直接传到电脑。局域网与公网共用 ICE 协商；两端只有 STUN 配置，没有 TURN 中继。打洞失败会停止，不把视频改走 Relay。STUN 用于发现网络地址，不承载视频。

Relay 的 `POST /api/rabilink/video/offer` 只接受 `deviceId` 与 SDP，总请求上限 64 KiB；不提供视频块上传入口。认证仍使用已有 RabiLink 应用 token，并固定到该应用选中的、声明 `video-direct` 的 PC。它复用有限请求队列传递协商信息，但不依赖语音服务开关。PC 的 RabiLink 插件持有视频接收器，停用插件时关闭会话与文件。

直连数据在电脑保存为运行数据目录下 `data/rabilink/video/<sessionId>.h264`，旁边的 JSON 保存接收字节数、结束原因和 ICE 候选类型。它是 H.264 原始码流，不是可直接作为 MP4 分享的文件，也不会自动送给 Agent。视频不上传 Relay。当前接收器最多同时接收两路，每路最多 256 MiB；达到限制、落盘背压、连接断开或 15 秒没有数据时结束，保留已经收到的数据。

## Android 入口

本地原签名可放在 `apps/rabilink-android/secrets/rokid/signing/debug.keystore`。该目录由 `/secrets/` 忽略规则保护，不能提交；构建优先使用此文件的 Android 默认调试别名和密码，其次才使用既有 Vela 签名配置或本机默认调试签名。覆盖更新前必须比对 APK 证书指纹。设备 `.lc` 和私有 SDK 资料也只保存在 `secrets/rokid/`，不会自动打包进应用。

已恢复与目标手机原包匹配的签名，并完成保留配置的 0.3.20 覆盖更新。CXR-M 属于本项目尚未取得的商务合作接入条件，当前不作为可用路线。官方 Maven 的 `client-m:1.2.2` 虽然包含 `openCameraVideo()` / `MediaStreamListener.onCameraFrame()`，但 SDK 下载、`.lc` 文件存在、持有签名都不代表获得 CXR-M 使用权限；不能把任务写成仅缺 `CLIENT_SECRET`。

普通 `-PmobileSlim` 包不包含大型 Rokid Phone SDK；视频开关显示为不可用。只有显式 `-ProkidVideo` 或完整诊断构建才包含它。不要通过删除模型检测来把完整 SDK 包伪装成精简包。

在含视频 SDK 的包中，设置页开启“眼镜模式自动直传视频到电脑”，选择眼镜模式并开始服务。开关默认关闭。手机先完成与电脑的直连，再请求眼镜视频；关闭开关、切换为手机/暂停模式、断网或断开眼镜都会停止视频。重新建立网络连接后可以重新协商。连接失败不会自动退到服务器中继。

SDK 请求为 15 fps、2 Mbit/s。发送缓冲最多 1 MiB，超限立即结束，避免无限积压或静默丢弃码流。实际帧率、分辨率、音视频同时使用、持续运行和温度仍需目标眼镜验证。

## 已知接入条件

- 2026-09-08 核对官方 Maven：CXR-L 最新稳定版 `1.1.2` 与 `1.2.X-20260814.092024-1` 快照的 `CXRLink` / `ExternalAppClient` 公开接口仍提供拍照与音频流，没有连续视频启动与帧回调接口。项目仍固定 `1.1.0`，不为不存在的视频能力升级依赖。不能由音频已连接推断视频已经可用；周期拍照也不能标成视频推流。
- 本实现接到仓库已有的 Phone SDK `requestVideoStream` / `onVideoH264Stream`。它需要该 SDK 自己与眼镜建立连接；本次设备连接失败，需继续确认设备型号、SDK 支持与授权。CXR-M 是另一套接入合同，不能直接套用本适配器或混用授权。
- 覆盖安装必须使用现有 APK 的原签名。本机签名与当前手机包不一致时，保留原应用；不卸载清数据来绕过签名。
- 公网 NAT 或防火墙可能阻止直连。没有 TURN 时不能承诺所有移动网络都能打通。
- 正式 Relay 需部署新增的协商接口，电脑需包含新的接收模块；仅更新手机不能启用完整链路。

## 验证

代码验证：`node --import tsx --test src/manager/rabiDirectVideo.test.ts`，并运行 `src/manager/rabiLinkRelayRuntime.test.ts` 与 `scripts/rabilink-relay-speech-messages.test.mjs`。覆盖直连字节完整性、会话释放、重复会话拒绝、信令限界、认证以及拒绝 TURN 配置。

隔离手机测试使用 `-PmobileSlim -PvideoAcceptance` 构建 `:app:assembleDebug` 和 `:app:assembleDebugAndroidTest`，生成独立的 `com.rabi.link.videoacceptance` 包，不覆盖用户应用。启动 `node --import tsx scripts/test-rabi-direct-video-receiver.ts`，从它的 READY 输出读取实际端口，再用 `adb reverse` 只转发此 TCP 协商端口。通过 instrumentation 参数 `signalPort` 指定该端口；`camera=false` 测试合成数据，`camera=true` 进行约 40 秒摄像头测试。二者必须分开记录。ICE 视频数据仍走网络，不走这条 USB TCP 转发。

完成真机验收需同时有摄像头回调、电脑持续接收、实际 H.264 解码、停止后摄像头释放，以及局域网和移动网络各自的证据。当前仅完成手机到电脑的数据通道验证。
