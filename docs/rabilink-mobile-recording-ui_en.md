# Rabi mobile: recording, messages and devices

English | [简体中文](rabilink-mobile-recording-ui.md)

Slim build 0.3.22 introduces Home, Records, Messages and Devices. Startup opens Home without requiring a computer connection. Services own capture state; changing pages or turning off the screen does not stop recording.

## Daily use

1. Tap or drag the three-position control for Pause, Audio or Video. Selecting a mode does not start capture.
2. Audio offers phone or glasses microphones. Use the fixed bottom start button and grant the system permission when requested. Phone recording works without internet; glasses audio still requires authorized CXR-L and Bluetooth connectivity.
3. Video provides live preview, fullscreen, setup steps and a fixed receiver button. Video includes audio. Live preview is muted; saved media and replay retain the original audio.
4. Select Pause or use Stop and save on Home, Messages or the notification. Switching mode stops the previous capture; another capture cannot start until saving and release finish.
5. Records combines local audio, video and received transcripts. Each new recording has one session entry; minute segments play consecutively. Sharing explicitly exports original segments rather than claiming to merge them into one file.
6. Messages retains existing chats, drafts, unread state and personas. Devices provides glasses authorization, separate audio/video state, computer connections, health devices and advanced settings.

Local audio is 16 kHz mono WAV. New local audio/video does not automatically submit transcription, so the UI does not claim it is queued for transcription when connectivity returns. Existing conversation speech processing remains under advanced settings. Received transcripts come from the original chat store without changing their historical ownership.

## State and compatibility

- Starting reception does not mean the glasses are streaming. Video timing and live pictures require received media.
- Automatic streaming through our glasses app remains under installation acceptance, disabled by default and available as an experiment in setup. Native Rokid streaming remains the tested compatibility route. CXR-M is excluded.
- Rokid controls native manual streaming. Pausing Rabi stops phone reception and saves files; end the native stream in Rokid to shut down that glasses camera.
- Saved authorization does not mean audio or video is connected. Devices shows current reception evidence separately and marks unverified connections explicitly.
- Historical video without session manifests remains an expandable collection of original segments. Similar timestamps are not treated as proof of one recording, and upgrades do not delete files.
- The old recorder Activity only redirects existing notifications and Intents to Home. Legacy continuous-conversation settings remain advanced compatibility for existing PC speech processing. Remove those capture settings after reliable local-recording submission, transcript ownership and recovery have been implemented and accepted.
- The original service still owns the raw audio queue. This change does not convert, delete or export old PCM queues. Records shows new local audio, old/new video and received text transcripts.

## Storage and failures

Cross-page testing exposed an ANR caused by old conversation-queue recovery on the main thread. Initialization now runs on one background executor after timely foreground promotion. Commands wait in order, and destruction prevents late execution. Recovery failure preserves original files and reports failure rather than claiming an established message connection.

Audio uses a bounded queue and single writer. WAV headers are checkpointed and synchronized on stop. Low space below 256 MiB or a write failure stops capture, preserves original files and marks interruption. Force-stop or power loss can still lose unfinished data and is not equivalent to normal saved stop.

Video retains the local MediaMTX receiver and original audio/video segments, with a new manifest per session. Preview errors do not stop recording. FileProvider grants the selected sharing app temporary read access. Export important records before uninstalling.

## Validation record

2026-09-08: Android build and unit tests passed, including concurrent capture exclusion and WAV length/content checks. The phone completed 80.46 seconds of recording, background continuation, saved stop and audible playback. The final installed APK recorded 49.42 seconds with mobile data and Wi-Fi disabled. Stopping from Messages saved a fully readable WAV before Wi-Fi was restored.

A 72-second LAN test stream verified phone preview, continued recording while opening Messages, saved stop and a single session entry. Both H.264/AAC segments (60.064 and 12.014 seconds) passed full decoding. The UI update does not establish successful glasses-app installation; glasses microphone and the custom glasses publisher still require separate acceptance. See [offline recording](rabilink-offline-recording_en.md) and [Rokid development sources](rokid-development_en.md).
