# Direct video between phone and PC

English | [简体中文](rabilink-direct-video.md)

Status: experimental; glasses acceptance is incomplete. A physical Android phone delivered 30 chunks and 480,000 bytes to the PC over WebRTC. The camera test failed at the Phone SDK Bluetooth connection (`success=false`), with no camera bytes. Cross-carrier Internet connectivity remains unverified.

## Transport and bandwidth

The phone sends SDK H.264 bytes directly to the PC through an ordered, reliable WebRTC DataChannel. ICE supports local and Internet candidates; only STUN is configured, with no TURN relay. A failed direct connection stops video instead of sending it through Relay. STUN discovers network addresses and does not carry video.

Relay's `POST /api/rabilink/video/offer` accepts only `deviceId` and SDP, limited to 64 KiB per request. It provides no video-chunk upload endpoint. Existing application-token authentication selects the application's configured PC, which must advertise `video-direct`. Signalling reuses the bounded request queue but does not require the speech service. The PC RabiLink plugin owns the receiver and closes sessions and files when disabled.

Received data is stored under the PC runtime directory as `data/rabilink/video/<sessionId>.h264`. A JSON sidecar records bytes, termination reason and ICE candidate types. These are raw H.264 streams, not shareable MP4 files; they are not automatically sent to an Agent or uploaded to Relay. The receiver permits two concurrent sessions, capped at 256 MiB each. Size limits, storage backpressure, disconnection or 15 seconds without data terminate a session while retaining received bytes.

## Android entry

Normal `-PmobileSlim` builds omit the large Rokid Phone SDK and disable the video switch. Explicit `-ProkidVideo` or full diagnostic builds include it. Do not bypass model checks to label a full SDK build as slim.

In a video-enabled build, enable the automatic glasses-to-PC video switch in settings, select glasses mode and start the service. Video is disabled by default. The phone establishes its direct PC channel before requesting camera data. Disabling the switch, switching to phone/paused mode, losing the network or disconnecting glasses stops video. Network recovery can start a fresh negotiation; failures never fall back to server relaying.

The SDK request specifies 15 fps and 2 Mbit/s. A 1 MiB sender buffer limit terminates overload rather than accumulating latency or silently dropping codec bytes. Actual resolution, frame rate, simultaneous audio/video, sustained use and thermal behavior still require hardware acceptance.

## Requirements and limitations

- CXR-L `client-l:1.1.0` exposes photo and audio APIs, but no public video-start API. An audio connection does not establish video availability.
- This adapter uses the existing Phone SDK `requestVideoStream` / `onVideoH264Stream` path, which needs its own device connection. That connection failed on the tested device; device compatibility and authorization require further confirmation. CXR-M is a different contract and cannot reuse this adapter or its authorization blindly.
- Upgrades must use the installed APK's signing identity. A signature mismatch must not be bypassed by uninstalling the user's application and deleting its data.
- Some NATs and firewalls prevent direct connectivity. With TURN disabled, connectivity cannot be guaranteed on every mobile network.
- Production Relay needs the new signalling endpoint and the PC needs the receiver module. Updating only the phone is insufficient.

## Verification

Run `node --import tsx --test src/manager/rabiDirectVideo.test.ts`, `src/manager/rabiLinkRelayRuntime.test.ts` and `scripts/rabilink-relay-speech-messages.test.mjs`. Tests cover ordered byte integrity, cleanup, duplicate sessions, signalling restrictions, authentication and TURN rejection.

Build `:app:assembleDebug` and `:app:assembleDebugAndroidTest` with `-PmobileSlim -PvideoAcceptance` for the isolated `com.rabi.link.videoacceptance` package. It does not replace the user's application. Start `node --import tsx scripts/test-rabi-direct-video-receiver.ts`, read the actual port from READY, and use `adb reverse` for that TCP signalling port only. Pass it as the instrumentation `signalPort` argument. `camera=false` sends synthetic bytes; `camera=true` runs a roughly 40-second camera test. Record these results separately. ICE video packets use the network, not the USB TCP forwarding channel.

Hardware acceptance requires actual camera callbacks, sustained PC reception, H.264 decoding, camera release after stopping, and separate LAN/mobile-network evidence. Only phone-to-PC transport has passed so far.
