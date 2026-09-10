# 乐奇开发：接入依据与排障

[English](rokid-development_en.md) | 简体中文

面向 RabiLink 维护者。核对日期：2026-09-08。此页保存路线约束与证据边界，不把正在开发的功能列为已验收能力。

## 当前路线

**不采用 CXR-M。** 项目已明确排除需要商务合作的路线，不等待或索要其 CLIENT_SECRET、`.lc` 等凭据。旧资料中建议尝试 CXR-M 的内容仅保留为历史调查，不再指导本次实现。

手机侧使用 CXR-L，经乐奇 App 建立控制通道。目标是自动启动自有眼镜录像应用，把带声音的视频送到手机局域网地址；手机负责动态预览、本地录像与回看。自有应用能否安装、访问相机并持续推流，需要分别验收。

官方开放平台将 CXR-L 定位为经乐奇 App 使用眼镜 IO 的手机端工具，将 CXR-S 定位为眼镜端独立应用开发工具，并另列眼镜原生开发资料。该定位不等于连续视频 API、安装权限或特定固件兼容性保证。[官方开放平台](https://open.rokid.com/)

| 路线 | 当前判断 | 不能据此推断 |
| --- | --- | --- |
| CXR-L 控制、音频、照片 | 当前工程已接入；本轮服务及眼镜蓝牙连接为 true | 有音频接口就必然有视频接口 |
| 乐奇 App 原生 RTMP 直播 | 手动开播到手机已实测，详见录像文档 | 可通过公开 SDK 自动启动该页面的直播 |
| 自有眼镜录像组件 | 已实现并编译；安装验收受阻 | 编译通过等于眼镜可运行 |
| CXR-S / Android 相机 | 官方已说明裸机 CameraX 采集与 CXR-S 协同；本项目采集待真机验证 | 其他型号、社区样例可运行就代表当前设备可运行 |
| CXR-M | 本项目不采用 | 缺少商务凭证是当前任务的待办 |

## 官方资料登记

| 资料 | 读取情况与用途 |
| --- | --- |
| [官方开放平台](https://open.rokid.com/) | 已读取页面发布资源中的 SDK 分类与文档入口；用于确认产品定位 |
| [用户指定的官方眼镜开发文档](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=201f7e36b17b4a4389ea4c38a4f23381) | 已读取《Rokid Glasses 裸机开发简介》v1.0、快速开始 v1.1、录像 v1.0 |
| [用户指定的 CXR-L 文档](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html) | 已读取简介 v1.6、自定义应用 v1.2，以及眼镜端开发环境、SDK 导入、录音说明 |
| [官方 CXR-S 入口](https://custom.rokid.com/prod/rokid_web/57e35cd3ae294d16b1b8fc8dcbb1b7c7/pc/cn/2786298057084a82b170bf725aef6b5d.html) | 已获取动态页面外壳；未取得正文，不据此推断具体 API |

两份用户页面及关联章节已于 2026-09-08 通过官方页面实际使用的公开 GET 接口取得正文。页面外壳引用 `ar-independent-pc-document/1.0.8/umi.e325c730.js`；接口位于 `https://ar-independent-manager.rokid.com/out/`，包括 `website/selectWebsiteRelation/{websiteId}`、`catalogue/selectCatalogueTree?pagePath=...` 和 `document/selectWebDocument/{documentId}`。两站 `forbiddenConfig=false`，未使用账号凭据。后续遇到鉴权或站点禁用时停止此读取路径。网页工具拒绝与浏览器超时保留为工具故障记录，不再写成正文缺失。

## 官方正文核对结果

用户指定的精确入口：[眼镜端开发环境：打开 ADB、使用专用开发线](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html?documentId=b6c111c9eb364f4ebb68d6c76276b4b0)。该页说明通过手机 Rokid AI App 开启眼镜 ADB；手机安装应用的 API 则见下方“自定义应用”章节。后续排查先走手机 CXR-L 安装与联调路径，需要眼镜系统日志时再补充 ADB，不将开发线作为手机无线安装的前提。

1. **可以开发眼镜端应用。** 裸机简介明确描述 YodaOS-Sprite / Android 12（API 31）上的普通 Android 应用，不依赖手机协同 SDK；本机录像使用 CameraX。自有推流可沿此采集方向实现，但官方录像示例本身不提供 RTMP 推流。
2. **USB 调试需要专用开发线。** [快速开始](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=4644028a76f54fd08b05d4ff7b1ea3b2) 要求在 Rokid AI App 开启眼镜 ADB，使用开发线连接电脑，确认 `adb devices` 列出眼镜后 `adb install -r`。普通零售充电线不能代替该开发线。这是 USB 调试条件，不是 CXR-L 无线安装或日常推流必须插线的说明。
3. **CXR-L 正式提供远程安装和启动。** [自定义应用](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html?documentId=96a33d91834d47959dec5d3009401d5e) 列出 `appIsInstalled`、`appUploadAndInstall`、`appStart`。眼镜 APK 须集成 CXR-S，包名与 CUSTOMAPP 配置一致；入口使用完整 Activity 类名。推荐应用专属可读目录；内部 filesDir 也在官方允许示例中。大 APK 的蓝牙传输与超时需要单独检查。
4. **控制指令须等待应用真正启动。** CXR 与眼镜蓝牙均连接后，还须收到 `onOpenAppResult(true)` 或 `onGlassAppResume(true)`，再发送 CustomApp 自定义指令。手机上保存过“已安装”不代替最新 `appIsInstalled` 查询。
5. **官方录像 Sample 默认不含声音。** [录像](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=63b84ebbdbde4523828d9101893723a5) 使用 CameraX 录制纯视频轨；Rabi 的有声录像还须验证麦克风与混流。保存状态须等待 `VideoRecordEvent.Finalize` 且无错误；销毁时停止并解绑相机。
6. **版本约束分层处理。** 裸机 Sample 是 minSdk 31 / targetSdk 36；CXR-S 导入章节要求库 minSdk ≥ 28，并给出 `1.0-20250519.061355-45`。CXR-L 简介示例使用 client-l 1.0.4。项目当前使用 client-l 1.1.0、bridge `1.0-20260417.063502-103`、眼镜 targetSdk 34；这些差异需要对照实测，不能仅凭差异归因或盲目降级。所读章节没有给出必须使用特定商业签名的要求，也没有列出当前设备的最低固件与 ABI 兼容矩阵。

已下载官方 [GlassesBareDevSample.zip](https://rokid-ota.oss-cn-hangzhou.aliyuncs.com/toB/Document/CXR_Bare/GlassesBareDevSample.zip)，只读检查其 Gradle 和 Manifest：与文档 minSdk 31 / targetSdk 36 一致，未配置特殊签名。归档 SHA-256 为 `f3256245f99bee2fc2c42cc1aed92435a820f11f4ab2a59a8dcedcccf1dd915c`。此检查没有执行示例或完成眼镜安装。

2026-09-08 本次 `adb devices` 仅显示手机，未显示眼镜。继续核对手机 CXR-L 安装查询、文件可读性、包名、入口和 SDK 配对版本；必要时用眼镜 ADB 与官方最小 Sample 补充安装错误证据。当前无线安装失败原因未定位，本次文档更新未修改安装行为。

## 本轮安装证据

- 手机包覆盖安装成功，保留原应用数据；手机签名成功不代表眼镜包签名或安装条件成立。
- CXR-L `CUSTOMAPP` 目标为 `com.rabi.link.glass.video`；服务连接和眼镜蓝牙连接均返回 true。
- SDK 上传后返回 `onInstallAppResult=false`；没有取得具体 PackageInstaller 错误，用户确认眼镜未显示安装或权限提示。
- 已检查当前 SDK 字节码：上传使用 `ParcelFileDescriptor` 交给乐奇服务。不能仅因 APK 位于手机私有缓存目录就断言跨应用路径不可读。
- 尚未收到自有眼镜应用启动、权限或媒体首帧证据。故自动录像未验收，也未启用默认自动启动。
- 社区兼容配置曾用于构建对照，但没有构成真机通过证据。后续先核实官方条件，不继续盲目改变 targetSdk 或签名。

旧资料中的眼镜 CustomApp 成功是历史设备/构建的结果，不覆盖本轮失败。`onInstallAppResult=false` 本身不能确定签名、传输、固件或权限中的哪一项失败。

## 工程归属

- `apps/rabilink-android/app/`：手机控制、接收、预览和录像。
- `apps/rabilink-android/glass-app/`：既有眼镜音频与诊断应用。
- `apps/rabilink-android/glass-video-app/`：独立实验录像组件 `com.rabi.link.glass.video`，由手机调试包携带 `rabi-glass-video.apk`，不要求用户另装一个手机应用。
- `apps/rabilink-android/shared/`：本地接收地址校验和控制协议。

新组件使用 RootEncoder 2.4.3（Apache-2.0），许可证位于其 `src/main/assets/licenses/RootEncoder-2.4.3.txt`。控制经 CXR，H.264/AAC 经本地 RTMP；首版仍要求同 Wi-Fi 或手机热点，不自动建立 Wi-Fi Direct，也不经过 Relay。

## 验收顺序

1. 官方前置条件 → 正确设备与签名 → APK 上传和安装 → 应用启动。
2. 眼镜相机与麦克风授权 → 实际采集 → 手机接收 → 连续预览。
3. 音视频文件完整解码与回放 → 停止保存 → 后台录制 → 控制失联后停止采集。
4. 无外网但有热点时重新开播 → Rabi 冷启动自动连接 → 独立录音互斥。

没有完成的步骤继续标为待验收。预览静音不删除录像音轨；设备时钟比较须考虑同步误差，不能把截图时间写成准确的毫秒延迟。

## 后续使用入口

- [乐奇开发 Skill](../skills/rokid-development/SKILL.md)：下次开发或排障先读。
- [离线录像与真机结果](rabilink-offline-recording.md)：当前使用方式和验收状态。
- [历史语音调查](../apps/rabilink-android/docs/rokid-ai-sdk-official-voice-plan.md)：仅按需查旧接口证据，涉及 CXR-M 的建议已被本页当前路线取代。
