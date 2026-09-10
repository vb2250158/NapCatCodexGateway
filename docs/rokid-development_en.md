# Rokid development: sources and troubleshooting

English | [简体中文](rokid-development.md)

For RabiLink maintainers. Checked on 2026-09-08. This page records route constraints and evidence, not acceptance of unfinished features.

## Current route

**CXR-M is excluded.** The project does not pursue the commercial-cooperation route or request its CLIENT_SECRET or `.lc` credentials. Suggestions to try CXR-M in older research are historical and do not guide this implementation.

The phone uses CXR-L through the Rokid app. The intended flow starts our glasses recorder automatically and sends video with audio to a private phone address. The phone owns live preview, local recording and replay. Installation, camera access and sustained streaming require separate device acceptance.

The official platform describes CXR-L as phone-side access to glasses IO through the Rokid app, CXR-S as an on-device application toolkit, and separately lists native glasses development. This does not guarantee a continuous-video API, installation privileges or compatibility with a particular firmware. [Official platform](https://open.rokid.com/)

| Route | Current evidence | Does not prove |
| --- | --- | --- |
| CXR-L control, audio and photos | Integrated; service and glasses Bluetooth connections returned true this run | Audio support implies a video API |
| Native Rokid RTMP live stream | Manual streaming to the phone was device-tested | A public SDK can start that native live stream |
| Our glasses recorder | Implemented and compiled; installation acceptance is blocked | A successful build runs on the glasses |
| CXR-S / Android camera | Native CameraX capture and CXR-S coordination are documented; our capture awaits device validation | A community example or another model proves compatibility |
| CXR-M | Excluded from this project | Commercial credentials are a pending task |

## Official source register

| Source | Reading status and use |
| --- | --- |
| [Official platform](https://open.rokid.com/) | SDK descriptions and document links were read from its published page resources; supports product positioning |
| [User-supplied official glasses development document](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=201f7e36b17b4a4389ea4c38a4f23381) | Read native development introduction v1.0, quick start v1.1 and recording v1.0 |
| [User-supplied CXR-L documentation](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html) | Read introduction v1.6, CustomApp v1.2, glasses development environment, SDK import and audio recording |
| [Official CXR-S entry](https://custom.rokid.com/prod/rokid_web/57e35cd3ae294d16b1b8fc8dcbb1b7c7/pc/cn/2786298057084a82b170bf725aef6b5d.html) | Only the dynamic page shell was retrieved; no API claims are inferred from it |

Both supplied pages and related chapters were read on 2026-09-08 through the public GET endpoints used by the official page client, `ar-independent-pc-document/1.0.8/umi.e325c730.js`. Endpoints under `https://ar-independent-manager.rokid.com/out/` include `website/selectWebsiteRelation/{websiteId}`, `catalogue/selectCatalogueTree?pagePath=...` and `document/selectWebDocument/{documentId}`. Both sites returned `forbiddenConfig=false`; no credentials were used. Stop this path if authentication or site restrictions appear. Web-tool rejection and browser timeouts remain tool failure records, rather than missing-content status.

## Findings from official documentation

User-designated exact reference: [Glasses development environment: enable ADB and use a development cable](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html?documentId=b6c111c9eb364f4ebb68d6c76276b4b0). It describes enabling glasses ADB through the phone's Rokid AI App. Phone-side installation APIs are documented in the CustomApp chapter below. Investigate phone CXR-L installation and integration first; add glasses ADB when system logs are needed, without making a development cable a prerequisite for wireless installation.

1. **Native glasses apps are supported.** The native introduction describes ordinary Android apps on YodaOS-Sprite / Android 12 (API 31), independently of a phone SDK. CameraX provides local recording. This supports the capture direction for our publisher; the official recorder itself does not implement RTMP streaming.
2. **USB debugging requires a dedicated development cable.** The [quick start](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=4644028a76f54fd08b05d4ff7b1ea3b2) enables glasses ADB through Rokid AI App, connects the development cable, checks that the glasses appear in `adb devices`, then uses `adb install -r`. The retail charging cable is insufficient for that procedure. This requirement concerns USB debugging, not a permanent cable requirement for CXR-L wireless installation or everyday streaming.
3. **CXR-L officially installs and starts apps.** The [CustomApp chapter](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/3b63d21420e645e3affca478b39e4a13.html?documentId=96a33d91834d47959dec5d3009401d5e) specifies `appIsInstalled`, `appUploadAndInstall` and `appStart`. The glasses APK integrates CXR-S, matches the configured package and uses the full Activity class name. App-specific readable storage is recommended; internal filesDir is also documented. Large APK transfer and Bluetooth timeouts need separate inspection.
4. **Commands wait for the application to open.** Connected CXR and glasses Bluetooth are followed by `onOpenAppResult(true)` or `onGlassAppResume(true)` before CustomApp commands. A phone-side installed flag does not replace a current `appIsInstalled` query.
5. **The official recorder sample has no audio track.** The [recording chapter](https://custom.rokid.com/prod/rokid_web/ff28c865a9634876be98cbc293588460/pc/cn/index.html?documentId=63b84ebbdbde4523828d9101893723a5) records video-only with CameraX. Rabi must separately validate microphone capture and muxing. Saved status waits for an error-free `VideoRecordEvent.Finalize`; destruction stops recording and unbinds the camera.
6. **Version requirements apply at different layers.** The native sample uses minSdk 31 / targetSdk 36. The CXR-S import chapter requires library minSdk ≥ 28 and lists `1.0-20250519.061355-45`; the CXR-L introduction uses client-l 1.0.4. Our project uses client-l 1.1.0, bridge `1.0-20260417.063502-103` and glasses targetSdk 34. Compare these differences with device evidence rather than assigning a cause or downgrading blindly. The reviewed chapters do not require a particular commercial signing identity or provide a minimum-firmware/ABI compatibility matrix for this device.

The official [GlassesBareDevSample.zip](https://rokid-ota.oss-cn-hangzhou.aliyuncs.com/toB/Document/CXR_Bare/GlassesBareDevSample.zip) was downloaded and its Gradle and Manifest inspected: minSdk 31 / targetSdk 36 match the documentation, with no custom signing configuration. Archive SHA-256: `f3256245f99bee2fc2c42cc1aed92435a820f11f4ab2a59a8dcedcccf1dd915c`. The sample was not executed or installed on the glasses.

The current 2026-09-08 `adb devices` check shows only the phone. Continue checking CXR-L installation queries, file readability, package, entry Activity and SDK pairing on the phone. Supplement with glasses ADB and the official minimal sample if needed for installation error evidence. The wireless installation failure remains unresolved; this documentation update does not change installation behavior.

## Evidence from this installation attempt

- Updating the phone APK succeeded and preserved app data. This does not establish glasses signing or installation compatibility.
- The CXR-L CUSTOMAPP target was `com.rabi.link.glass.video`; both service and glasses Bluetooth connections returned true.
- Upload was followed by `onInstallAppResult=false`, without a specific PackageInstaller error. The user observed no installation or permission prompt on the glasses.
- Current SDK bytecode passes the APK to the Rokid service with `ParcelFileDescriptor`. A private cache path alone therefore does not establish an inaccessible-file cause.
- No glasses application startup, permission or video-frame evidence was received. Automatic recording is unaccepted and startup automation remains off by default.
- A community compatibility setting was compiled as a comparison, without device success evidence. Further changes to targetSdk or signing require official prerequisites or discriminating evidence.

Older successful CustomApp records describe earlier devices/builds and do not override this failure. The boolean callback does not identify signing, transfer, firmware or permission as the cause.

## Code ownership

- `apps/rabilink-android/app/`: phone control, receiver, preview and recording.
- `apps/rabilink-android/glass-app/`: existing glasses audio and diagnostics.
- `apps/rabilink-android/glass-video-app/`: separate experimental `com.rabi.link.glass.video` recorder, bundled as `rabi-glass-video.apk` in the phone debug build; users do not install a second phone app.
- `apps/rabilink-android/shared/`: private receiver validation and control protocol.

The new component uses RootEncoder 2.4.3 under Apache-2.0, with the license in its `src/main/assets/licenses/RootEncoder-2.4.3.txt`. CXR carries control and local RTMP carries H.264/AAC. This version still requires the same Wi-Fi or phone hotspot; it does not establish Wi-Fi Direct or send video through Relay.

## Acceptance order

1. Official prerequisites, device/signing identity, upload/install, application startup.
2. Camera/microphone consent, actual capture, phone reception and continuous preview.
3. Complete audio/video decoding and replay, saved stop, background recording and capture shutdown after control loss.
4. Restart streaming without internet using the hotspot, automatic connection on Rabi cold start and mutual exclusion with independent audio capture.

Keep incomplete stages pending. Muting preview does not remove recorded audio. Clock comparisons require synchronization error bounds; screenshot timestamps do not establish precise millisecond latency.

## Follow-up entry points

- [Rokid development skill](../skills/rokid-development/SKILL.md): read before subsequent development or diagnosis.
- [Offline recording and device results](rabilink-offline-recording_en.md): current usage and acceptance state.
- [Historical voice research](../apps/rabilink-android/docs/rokid-ai-sdk-official-voice-plan_en.md): consult earlier interface evidence as needed; this page supersedes its CXR-M route suggestions.
