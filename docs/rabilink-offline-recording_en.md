# Glasses live stream to phone: local recording and preview

English | [简体中文](rabilink-offline-recording.md)

Status: native manual RTMP streaming has been device-tested; automatic recording with our glasses component remains blocked at installation and unaccepted. CXR-M is excluded. See [Rokid development and troubleshooting](rokid-development_en.md) for official sources, callbacks and follow-up checks.

## Use

### Automatic Rabi streaming (experimental; device acceptance in progress)

The video setup guide provides an experimental automatic connection action; Devices contains the startup recording switch, disabled by default. Initial use still requires Rokid authorization, a Bluetooth connection, and camera/microphone permission on the glasses. Rabi uses CXR-L to install and launch its own `GlassVideoActivity`, passing local phone addresses and the stream key automatically. Camera2 and RootEncoder 2.4.3 send H.264/AAC to the phone. This route does not require commercial CXR-M access or automate the native Rokid live-streaming screen.

The glasses still need the phone hotspot or the same Wi-Fi; this first implementation does not establish Wi-Fi Direct automatically. The glasses check the supplied private addresses and select a reachable receiver. Independent phone audio capture and the separate glasses status connection stop before automatic video starts to avoid contention. Recording status requires received video. The glasses provide a stop button and stop capture after 15 seconds without a renewed control lease. Repeated commands for the same session cannot override a local manual stop.

Installation, capture, permission and startup-recovery acceptance remain in progress. The manual compatibility path below has been device-tested; removing it depends on acceptance and coverage by the new route.

### Native Rokid live streaming

1. Connect the glasses to the phone hotspot, or put both devices on the same Wi-Fi. Local connectivity is required; the phone receiver does not need internet access.
2. Select Video recording on Rabi Home. This entry is independent of Relay setup and online accounts.
3. Start reception and recording; copy the local publishing address and stream key.
4. In Rokid's live-streaming screen, select custom RTMP, enter the address and key, and start streaming. This compatibility path still requires operation in Rokid's app.
5. Return to Rabi for continuous live preview. Leaving the page only closes preview; recording continues in a foreground service. Its notification can stop and save.
6. After stopping, open Records for playback or export the original files through sharing. Recordings are private app data; export before uninstalling.

## Offline and resource boundaries

Reception, preview and recording run locally without Relay, a PC or online SDK authorization. Glasses still need local Wi-Fi or a hotspot to reach the phone. Whether a particular Rokid app version can start streaming with internet disconnected requires device testing; an offline receiver alone does not prove this.

RTMP receives the stream; preview uses RTSP/TCP bound only to `127.0.0.1`. A random persistent stream key protects the publishing path. Configuration and logs are not uploaded. Other publishing paths and replacement of an active publisher are rejected.

Fragmented MP4 recordings are segmented approximately once per minute and are not automatically deleted. Parts are written every second; termination, power loss or storage failure can lose the unfinished tail. Below 256 MiB free space, reception stops while existing files remain. Live preview is muted to avoid feedback, while recordings retain incoming audio. Preview failure does not stop recording.

## Device trial on 2026-09-08

- Verified: LAN synthetic publishing; real glasses custom RTMP publishing through Rokid app 1.12.10.0815; continuous phone preview; recording segments created while preview was in the background.
- One 60.98-second real recording contains H.264 720×1280 and mono AAC at 16 kHz; full audio/video decoding passed.
- Verified: with mobile data and external Wi-Fi disabled and only the phone hotspot active, glasses publishing restarted successfully and phone preview worked. The resulting 47.118-second file contains the same audio/video formats; full decoding and in-app replay passed.
- Version 0.3.22 implements the Pause / Audio recording / Video recording slider, dynamic controls, capture exclusion and unified records. See the [recording interface](rabilink-mobile-recording-ui_en.md) for current behavior and validation.
- Legacy audio audit rows without `id/eventSequence` rebuild their index without rewriting evidence. This compatibility fix does not establish acceptable historical queue startup performance.
- Operations can pass `open_offline_recorder=true` to the main entry to open the recorder without automatically restoring messaging and audio queues. This does not start reception or broadcasting.

## Build and maintenance

`scripts/Prepare-LiveRecorderRuntime.mjs` prepares the pinned MediaMTX 1.21.0 ARM64 executable at build time, verifying both archive and executable SHA-256. The runtime and MIT license are bundled in the APK; nothing is downloaded on the phone. The first build requires Node, curl, tar and internet; verified caches can be reused.

The local media runtime increases APK size beyond the old messaging-only slim package; model-asset exclusion remains enforced. The service owns the subprocess, wake lock, space monitoring and recordings; the Activity owns preview and interaction. No Manager port, public video upload endpoint or CXR-M dependency is added.

Record acceptance separately for synthetic publishing, real glasses footage, continuous phone preview, audio/video decoding, stop/finalization, background recording and restarting with internet disconnected. Synthetic success is not device acceptance.

References: [Rokid streaming](https://global.rokid.com/pages/faq), [MediaMTX recording](https://mediamtx.org/docs/features/record), [Android RTSP playback](https://developer.android.com/media/media3/exoplayer/rtsp).
