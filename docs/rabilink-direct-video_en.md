# Direct video between phone and PC

English | [简体中文](rabilink-direct-video.md)

Status: experimental; glasses acceptance is incomplete. A physical Android phone delivered 30 chunks and 480,000 bytes to the PC over WebRTC. The camera test failed at the Phone SDK Bluetooth connection (`success=false`), with no camera bytes. Cross-carrier Internet connectivity remains unverified.

## Transport and bandwidth

A separate native live-streaming entry exists independently of the CXR-L frame API. The [Rokid FAQ](https://global.rokid.com/pages/faq) describes setting a custom RTMP URL and stream key in Hi Rokid, then streaming over Wi-Fi or a phone hotspot. This does not establish an automatic-start CXR-L API or public-network phone-to-PC hole punching. Native streaming to a local receiver is under investigation; this route has no verified device picture yet.

The phone sends SDK H.264 bytes directly to the PC through an ordered, reliable WebRTC DataChannel. ICE supports local and Internet candidates; only STUN is configured, with no TURN relay. A failed direct connection stops video instead of sending it through Relay. STUN discovers network addresses and does not carry video.

Relay's `POST /api/rabilink/video/offer` accepts only `deviceId` and SDP, limited to 64 KiB per request. It provides no video-chunk upload endpoint. Existing application-token authentication selects the application's configured PC, which must advertise `video-direct`. Signalling reuses the bounded request queue but does not require the speech service. The PC RabiLink plugin owns the receiver and closes sessions and files when disabled.

Received data is stored under the PC runtime directory as `data/rabilink/video/<sessionId>.h264`. A JSON sidecar records bytes, termination reason and ICE candidate types. These are raw H.264 streams, not shareable MP4 files; they are not automatically sent to an Agent or uploaded to Relay. The receiver permits two concurrent sessions, capped at 256 MiB each. Size limits, storage backpressure, disconnection or 15 seconds without data terminate a session while retaining received bytes.

## Android entry

Place an original local signing key at `apps/rabilink-android/secrets/rokid/signing/debug.keystore`. The `/secrets/` ignore rule protects this directory from normal Git additions; never commit it. Builds prefer this key with the standard Android debug alias and password, then the existing Vela configuration or the machine's default debug key. Compare APK certificate fingerprints before updating an installed app. Device `.lc` files and private SDK material also stay under `secrets/rokid/` and are not automatically bundled into the app.

The original signing key has been recovered and version 0.3.20 has been installed while preserving configuration. CXR-M requires commercial partnership access that this project has not obtained, so it is not an available route here. Although the official Maven `client-m:1.2.2` artifact exposes `openCameraVideo()` and `MediaStreamListener.onCameraFrame()`, downloading an SDK or possessing a `.lc` file and signing key does not establish CXR-M access. The remaining requirement must not be described as merely a missing `CLIENT_SECRET`.

Normal `-PmobileSlim` builds omit the large Rokid Phone SDK and disable the video switch. Explicit `-ProkidVideo` or full diagnostic builds include it. Do not bypass model checks to label a full SDK build as slim.

In a video-enabled build, enable the automatic glasses-to-PC video switch in settings, select glasses mode and start the service. Video is disabled by default. The phone establishes its direct PC channel before requesting camera data. Disabling the switch, switching to phone/paused mode, losing the network or disconnecting glasses stops video. Network recovery can start a fresh negotiation; failures never fall back to server relaying.

The SDK request specifies 15 fps and 2 Mbit/s. A 1 MiB sender buffer limit terminates overload rather than accumulating latency or silently dropping codec bytes. Actual resolution, frame rate, simultaneous audio/video, sustained use and thermal behavior still require hardware acceptance.

## Requirements and limitations

- Official Maven artifacts checked on 2026-09-08: CXR-L stable `1.1.2` and snapshot `1.2.X-20260814.092024-1` still expose photo and audio streaming through `CXRLink` / `ExternalAppClient`, without a continuous-video start or frame callback API. The project stays on `1.1.0`; there is no video capability to unlock by upgrading. Audio connectivity does not establish video availability, and repeated photos must not be labelled video streaming.
- This adapter uses the existing Phone SDK `requestVideoStream` / `onVideoH264Stream` path, which needs its own device connection. That connection failed on the tested device; device compatibility and authorization require further confirmation. CXR-M is a different contract and cannot reuse this adapter or its authorization blindly.
- Upgrades must use the installed APK's signing identity. A signature mismatch must not be bypassed by uninstalling the user's application and deleting its data.
- Some NATs and firewalls prevent direct connectivity. With TURN disabled, connectivity cannot be guaranteed on every mobile network.
- Production Relay needs the new signalling endpoint and the PC needs the receiver module. Updating only the phone is insufficient.

## Verification

Run `node --import tsx --test src/manager/rabiDirectVideo.test.ts`, `src/manager/rabiLinkRelayRuntime.test.ts` and `scripts/rabilink-relay-speech-messages.test.mjs`. Tests cover ordered byte integrity, cleanup, duplicate sessions, signalling restrictions, authentication and TURN rejection.

Build `:app:assembleDebug` and `:app:assembleDebugAndroidTest` with `-PmobileSlim -PvideoAcceptance` for the isolated `com.rabi.link.videoacceptance` package. It does not replace the user's application. Start `node --import tsx scripts/test-rabi-direct-video-receiver.ts`, read the actual port from READY, and use `adb reverse` for that TCP signalling port only. Pass it as the instrumentation `signalPort` argument. `camera=false` sends synthetic bytes; `camera=true` runs a roughly 40-second camera test. Record these results separately. ICE video packets use the network, not the USB TCP forwarding channel.

Hardware acceptance requires actual camera callbacks, sustained PC reception, H.264 decoding, camera release after stopping, and separate LAN/mobile-network evidence. Only phone-to-PC transport has passed so far.
