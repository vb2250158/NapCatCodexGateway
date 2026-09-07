package com.rabi.link.modules.rokid;

import com.rabi.link.RabiConversationSettings;
import com.rabi.link.RabiConversationTarget;

import org.json.JSONArray;
import org.json.JSONObject;

import android.os.Build;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Phone-owned backend for the thin glasses client. No Agent or model runs on Android. */
public final class RabiGlassPcBackend {
    public static final String SOURCE_PHONE = "phone";
    public static final String SOURCE_GLASSES = "glasses";
    private static final int MAX_CONTROL_QUEUE_ITEMS = 2000;
    private static final int MAX_MEDIA_QUEUE_ITEMS = 500;
    private static final int EVENT_STREAM_READ_TIMEOUT_MS = 45_000;
    private static final int AUDIO_CAPTURE_QUEUE_CAPACITY = 256;
    private static final long AUDIO_CAPTURE_QUEUE_MAX_BYTES = 2L * 1024L * 1024L;

    public interface Listener {
        void onStatus(String status);
        void onTranscript(String text, String routeProfileId);
        void onDeliveryState(String clientMessageId, String routeProfileId, String state, String failure);
        ReplyDeliveryResult onReply(String messageId, String routeProfileId, String text, byte[] pcm, JSONArray attachments);
        void onPersonaAvatarChanged(String roleId, String avatarVersion, String avatarUrl);
        void onError(String message);
    }

    public static final class ReplyDeliveryResult {
        public final boolean delivered;
        public final boolean playbackRequested;
        public final boolean played;
        public final String outputDeviceKind;
        public final String playbackFailure;

        public ReplyDeliveryResult(boolean delivered, boolean playbackRequested, boolean played,
                                   String outputDeviceKind, String playbackFailure) {
            this.delivered = delivered;
            this.playbackRequested = playbackRequested;
            this.played = played;
            this.outputDeviceKind = clean(outputDeviceKind).isEmpty() ? SOURCE_PHONE : clean(outputDeviceKind);
            this.playbackFailure = clean(playbackFailure);
        }
    }

    private final ScheduledExecutorService uploadExecutor = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService eventExecutor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService audioStreamExecutor = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService audioWriteExecutor = Executors.newSingleThreadExecutor();
    private final RabiBoundedAudioWriteQueue audioWriteQueue =
            new RabiBoundedAudioWriteQueue(AUDIO_CAPTURE_QUEUE_CAPACITY, AUDIO_CAPTURE_QUEUE_MAX_BYTES);
    private final AtomicBoolean audioWriteDrainActive = new AtomicBoolean();
    private final AtomicBoolean audioSpoolClosed = new AtomicBoolean();
    private final Object audioWriteIoLock = new Object();
    private final Object audioStreamQueueLock = new Object();
    private final RabiSingleDrainGate audioStreamDrainGate = new RabiSingleDrainGate();
    private final AtomicBoolean eventLoopActive = new AtomicBoolean();
    private final AtomicBoolean eventReconnectRequested = new AtomicBoolean();
    private final AtomicLong audioStreamRecoveryGeneration = new AtomicLong();
    private final RabiNetworkWakeGate networkWakeGate = new RabiNetworkWakeGate();
    private final android.content.SharedPreferences preferences;
    private final android.content.Context context;
    private final File replyQueueDirectory;
    private final File mediaQueueDirectory;
    private final File controlQueueDirectory;
    private final File diagnosticQueueDirectory;
    private final File receiptQueueDirectory;
    private final Listener listener;
    private volatile boolean running;
    private volatile HttpURLConnection eventConnection;
    private volatile boolean drainScheduled;
    private String baseUrl = "";
    private String token = "";
    private String deviceId = "rabi-glass";
    private volatile RabiConversationSettings settings;
    private String lastDiagnosticKey = "";
    private long lastDiagnosticAt;
    private final RabiDurableAudioSpool audioSpool;
    private String activeAudioStreamId = "";
    private String activeAudioStreamSource = "";
    private String activeAudioStreamRoute = "";
    private String desiredAudioStreamSource = "";
    private String desiredAudioStreamRoute = "";
    private long audioStreamSequence;
    private int audioStreamChunkFailures;
    private boolean audioStreamRetryWaiting;
    private boolean audioStorageFailureReported;
    private volatile boolean audioStreamKeepaliveUnsupported;
    private ScheduledFuture<?> audioStreamKeepaliveFuture;
    private int eventReconnectAttempt;

    public RabiGlassPcBackend(android.content.Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences("rabi_glass_phone_backend", android.content.Context.MODE_PRIVATE);
        this.listener = listener;
        this.settings = RabiConversationSettings.load(this.context);
        this.replyQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/reply-queue");
        this.replyQueueDirectory.mkdirs();
        this.mediaQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/media-queue");
        this.mediaQueueDirectory.mkdirs();
        this.controlQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/control-queue");
        this.controlQueueDirectory.mkdirs();
        this.diagnosticQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/diagnostic-queue");
        this.diagnosticQueueDirectory.mkdirs();
        this.receiptQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/receipt-queue");
        this.receiptQueueDirectory.mkdirs();
        try {
            this.audioSpool = new RabiDurableAudioSpool(
                    new File(this.context.getFilesDir(), "rabi-conversation/audio-spool"),
                    audioPolicy(this.settings));
        } catch (Throwable error) {
            throw new IllegalStateException("无法恢复手机本地录音队列", error);
        }
        recoverReliableQueueDirectories();
    }

    private void recoverReliableQueueDirectories() {
        for (File directory : new File[]{replyQueueDirectory, mediaQueueDirectory, controlQueueDirectory,
                diagnosticQueueDirectory, receiptQueueDirectory}) {
            RabiReliableQueueFiles.cleanupTemporaryFiles(directory);
        }
        for (File binary : RabiReliableQueueFiles.list(mediaQueueDirectory, ".bin")) {
            File metadata = new File(mediaQueueDirectory, binary.getName().replace(".bin", ".json"));
            if (!metadata.exists()) quarantineQueueItem(mediaQueueDirectory, "媒体", "orphan_binary", binary);
        }
    }

    private JSONObject readQueueJson(File queueDirectory, String label, File metadata, File... related) {
        try {
            return new JSONObject(new String(RabiReliableQueueFiles.read(metadata), StandardCharsets.UTF_8));
        } catch (Throwable error) {
            File[] evidence = new File[related.length + 1];
            evidence[0] = metadata;
            System.arraycopy(related, 0, evidence, 1, related.length);
            quarantineQueueItem(queueDirectory, label, "invalid_json_" + error.getClass().getSimpleName(), evidence);
            return null;
        }
    }

    private boolean quarantineQueueItem(File queueDirectory, String label, String reason, File... evidence) {
        try {
            RabiReliableQueueFiles.quarantine(queueDirectory, reason, evidence);
            listener.onError(label + "可靠队列发现损坏项目，已隔离并继续处理后续项目");
            return true;
        } catch (Throwable error) {
            listener.onError(label + "可靠队列损坏且无法隔离 · " + shortError(error));
            return false;
        }
    }

    public void configure(String baseUrl, String token, String deviceId) {
        if (!this.baseUrl.equals(trimSlash(baseUrl)) || !this.token.equals(clean(token))) {
            audioStreamKeepaliveUnsupported = false;
        }
        this.baseUrl = trimSlash(baseUrl);
        this.token = clean(token);
        this.deviceId = clean(deviceId).isEmpty() ? "rabi-glass" : clean(deviceId);
        HttpURLConnection current = eventConnection;
        if (running && current != null) {
            eventReconnectRequested.set(true);
            current.disconnect();
        }
        if (running) ensureEventLoop();
    }

    public boolean configured() {
        return !baseUrl.isEmpty() && !token.isEmpty();
    }

    public void reloadSettings() {
        settings = RabiConversationSettings.load(context);
        audioSpool.updatePolicy(audioPolicy(settings));
    }

    private static RabiDurableAudioSpool.Policy audioPolicy(RabiConversationSettings settings) {
        long mib = 1024L * 1024L;
        return new RabiDurableAudioSpool.Policy(
                160L * 1024L,
                5_000L,
                settings.audioMaxStorageMb * mib,
                settings.audioReserveFreeMb * mib,
                settings.audioRetentionHours * 60L * 60L * 1000L);
    }

    public void start() {
        if (running) return;
        running = true;
        requestDrain(0);
        requestAudioStreamDrain();
        ensureEventLoop();
    }

    public void stop() {
        running = false;
        audioWriteQueue.closeAdmission();
        networkWakeGate.close();
        cancelAudioStreamKeepalive();
        HttpURLConnection current = eventConnection;
        if (current != null) current.disconnect();
        enqueueAudioControl(this::stopActiveAudioStream);
        CountDownLatch audioWritesClosed = new CountDownLatch(1);
        try {
            audioWriteExecutor.execute(() -> {
                try {
                    closeAudioSpoolDurably();
                } finally {
                    audioWritesClosed.countDown();
                }
            });
            if (!awaitDrainOrTakeOver(audioWritesClosed, 10L, TimeUnit.SECONDS, this::closeAudioSpoolDurably)) {
                listener.onStatus("录音关闭等待超过 10 秒 · 已转为同步落盘，完成前不会丢弃队列");
            }
        } catch (Throwable error) {
            closeAudioSpoolDurably();
        }
        audioWriteExecutor.shutdownNow();
        uploadExecutor.shutdownNow();
        eventExecutor.shutdownNow();
        audioStreamExecutor.shutdown();
    }

    public void beginAudioStream(String sourceDeviceKind) {
        String source = normalizedSourceKind(sourceDeviceKind);
        String route = routeProfileId();
        updateDesiredAudioStream(source, route);
        requestAudioStreamDrain();
    }

    public void streamPcmFromSource(byte[] pcm, String sourceDeviceKind) {
        byte[] copy = pcm == null ? new byte[0] : pcm.clone();
        if (copy.length == 0) return;
        String source = normalizedSourceKind(sourceDeviceKind);
        String route = routeProfileId();
        if (!running || !audioWriteQueue.isAccepting()) {
            audioSpool.recordGap("capture_after_backend_stop", copy.length, source, route);
            return;
        }
        updateDesiredAudioStream(source, route);
        if (!audioWriteQueue.offer(copy, source, route)) {
            if (!audioStorageFailureReported) {
                audioStorageFailureReported = true;
                listener.onError("录音落盘队列已满 · 已记录背压缺口，采集线程继续运行");
            }
            if (!audioWriteQueue.isAccepting()) {
                flushAudioBackpressureGaps();
                return;
            }
        }
        requestAudioWriteDrain();
    }

    public void onNetworkAvailable() {
        networkWakeGate.setAvailable(true);
        requestDrain(0);
        scheduleAudioStreamRecovery(0);
    }

    public void onNetworkUnavailable() {
        networkWakeGate.setAvailable(false);
        audioStreamRecoveryGeneration.incrementAndGet();
        cancelAudioStreamKeepalive();
        HttpURLConnection current = eventConnection;
        if (current != null) current.disconnect();
        enqueueAudioControl(() -> {
            audioStreamRetryWaiting = true;
            listener.onStatus("网络已断开 · 当前待确认 PCM 将在联网后自动续传");
        });
    }

    public void pauseAudioStream() {
        synchronized (audioStreamQueueLock) {
            desiredAudioStreamSource = "";
            desiredAudioStreamRoute = "";
        }
        enqueueAudioBoundary("capture_paused", () -> enqueueAudioControl(this::stopActiveAudioStream));
    }

    public void recordAudioGap(String reason, long estimatedBytes, String sourceDeviceKind) {
        String source = normalizedSourceKind(sourceDeviceKind);
        String route = routeProfileId();
        if (!audioWriteQueue.isAccepting()) {
            audioSpool.boundary(reason);
            audioSpool.recordGap(reason, estimatedBytes, source, route);
            return;
        }
        enqueueAudioWriteControl(() -> {
            audioSpool.boundary(reason);
            audioSpool.recordGap(reason, estimatedBytes, source, route);
        });
    }

    private void requestAudioWriteDrain() {
        if (audioWriteExecutor.isShutdown() || !audioWriteDrainActive.compareAndSet(false, true)) return;
        try {
            audioWriteExecutor.execute(() -> {
                try {
                    drainAudioWritesNow();
                    flushAudioBackpressureGaps();
                } finally {
                    audioWriteDrainActive.set(false);
                    if (audioWriteQueue.hasWork()) requestAudioWriteDrain();
                }
            });
        } catch (RejectedExecutionException ignored) {
            audioWriteDrainActive.set(false);
        }
    }

    private void drainAudioWritesNow() {
        synchronized (audioWriteIoLock) {
            RabiBoundedAudioWriteQueue.Entry item;
            while ((item = audioWriteQueue.poll()) != null) {
                RabiDurableAudioSpool.AppendResult written = audioSpool.append(item.pcm, item.source, item.route);
                if (!written.accepted) {
                    if (!audioStorageFailureReported) {
                        audioStorageFailureReported = true;
                        listener.onError("手机录音未能落盘 · 已留下缺口记录，请检查存储水位");
                    }
                    continue;
                }
                audioStorageFailureReported = false;
                requestAudioStreamDrain();
            }
        }
    }

    private void flushAudioBackpressureGaps() {
        synchronized (audioWriteIoLock) {
            List<RabiBoundedAudioWriteQueue.Gap> gaps = audioWriteQueue.takeRejected();
            if (gaps.isEmpty()) return;
            audioSpool.boundary("capture_backpressure");
            for (RabiBoundedAudioWriteQueue.Gap gap : gaps) {
                String reason = audioWriteQueue.isAccepting() ? "capture_backpressure" : "capture_after_backend_stop";
                audioSpool.recordGap(reason, gap.bytes, gap.source, gap.route);
            }
        }
    }

    private void closeAudioSpoolDurably() {
        synchronized (audioWriteIoLock) {
            if (audioSpoolClosed.compareAndSet(false, true)) {
                drainAndCloseAudioQueue(audioWriteQueue, audioSpool);
            }
        }
    }

    static void drainAndCloseAudioQueue(RabiBoundedAudioWriteQueue queue, RabiDurableAudioSpool spool) {
        RabiBoundedAudioWriteQueue.Entry entry;
        while ((entry = queue.poll()) != null) spool.append(entry.pcm, entry.source, entry.route);
        List<RabiBoundedAudioWriteQueue.Gap> gaps = queue.takeRejected();
        if (!gaps.isEmpty()) spool.boundary("capture_after_backend_stop");
        for (RabiBoundedAudioWriteQueue.Gap gap : gaps) {
            spool.recordGap("capture_after_backend_stop", gap.bytes, gap.source, gap.route);
        }
        spool.close();
    }

    static boolean awaitDrainOrTakeOver(CountDownLatch completed, long timeout, TimeUnit unit,
                                         Runnable synchronousTakeover) {
        boolean interrupted = false;
        try {
            if (completed.await(timeout, unit)) return true;
        } catch (InterruptedException error) {
            interrupted = true;
        }
        synchronousTakeover.run();
        if (interrupted) Thread.currentThread().interrupt();
        return false;
    }

    private void enqueueAudioBoundary(String reason) {
        enqueueAudioBoundary(reason, null);
    }

    private void enqueueAudioBoundary(String reason, Runnable afterBoundary) {
        enqueueAudioWriteControl(() -> {
            audioSpool.boundary(reason);
            if (afterBoundary != null) afterBoundary.run();
        });
    }

    private void enqueueAudioWriteControl(Runnable control) {
        if (audioWriteExecutor.isShutdown()) return;
        try {
            audioWriteExecutor.execute(() -> {
                drainAudioWritesNow();
                flushAudioBackpressureGaps();
                control.run();
            });
        } catch (RejectedExecutionException ignored) {
        }
    }

    private void enqueueAudioControl(Runnable command) {
        if (audioStreamExecutor.isShutdown()) return;
        try {
            audioStreamExecutor.execute(command);
        } catch (RejectedExecutionException ignored) {
        }
    }

    private void updateDesiredAudioStream(String sourceDeviceKind, String routeProfileId) {
        synchronized (audioStreamQueueLock) {
            desiredAudioStreamSource = sourceDeviceKind;
            desiredAudioStreamRoute = clean(routeProfileId);
        }
    }

    private void requestAudioStreamDrain() {
        if (audioStreamExecutor.isShutdown()) return;
        audioStreamDrainGate.request(audioStreamExecutor, this::drainAudioStream);
    }

    private void drainAudioStream() {
        if (!networkWakeGate.isAvailable()) {
            audioStreamRetryWaiting = true;
            return;
        }
        try {
            boolean recovering = audioStreamRetryWaiting || audioSpool.nextUpload() != null;
            audioStreamRetryWaiting = false;
            while (true) {
                RabiDurableAudioSpool.Segment head = audioSpool.nextUpload();
                String source;
                String route;
                if (head != null) {
                    source = head.source;
                    route = head.routeProfileId;
                } else {
                    synchronized (audioStreamQueueLock) {
                        source = desiredAudioStreamSource;
                        route = desiredAudioStreamRoute;
                    }
                }
                if (source.isEmpty()) return;
                ensureAudioStream(source, route);
                if (head == null) break;
                flushAudioStreamChunk();
            }
            if (recovering) listener.onStatus("网络连接正常 · 持续聆听中");
        } catch (Throwable error) {
            handleAudioStreamFailure(error);
        }
    }

    private void handleAudioStreamFailure(Throwable error) {
        audioStreamChunkFailures += 1;
        audioStreamRetryWaiting = true;
        if (audioStreamChunkFailures >= 3) resetAudioStreamTransportForRetry();
        listener.onError("音频流中断 · " + shortError(error));
        if (networkWakeGate.isAvailable()) scheduleAudioStreamRecovery(audioStreamRetryDelayMs(audioStreamChunkFailures));
    }

    private void scheduleAudioStreamRecovery(long delayMs) {
        if (audioStreamExecutor.isShutdown()) return;
        long generation = audioStreamRecoveryGeneration.incrementAndGet();
        try {
            audioStreamExecutor.schedule(() -> {
                if (generation != audioStreamRecoveryGeneration.get() || !networkWakeGate.isAvailable()) return;
                if (generation != audioStreamRecoveryGeneration.get()
                        || (desiredAudioStreamSource.isEmpty() && audioSpool.nextUpload() == null)) return;
                audioStreamDrainGate.request(audioStreamExecutor, this::drainAudioStream);
            }, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
        }
    }

    private static long audioStreamRetryDelayMs(int failures) {
        if (failures <= 1) return 1_000L;
        if (failures == 2) return 2_000L;
        if (failures == 3) return 5_000L;
        if (failures == 4) return 10_000L;
        return 30_000L;
    }

    private void ensureAudioStream(String sourceDeviceKind, String routeProfileId) throws Exception {
        if (!configured()) throw new IllegalStateException("RabiLink 尚未配置");
        String route = clean(routeProfileId);
        if (!activeAudioStreamId.isEmpty()
                && activeAudioStreamSource.equals(sourceDeviceKind)
                && activeAudioStreamRoute.equals(route)) return;
        if (!activeAudioStreamId.isEmpty()) {
            stopActiveAudioStream();
            desiredAudioStreamSource = sourceDeviceKind;
            desiredAudioStreamRoute = route;
        }
        String suffix = SOURCE_GLASSES.equals(sourceDeviceKind) ? "glasses" : "phone";
        String streamId = safeStreamId(deviceId + "-" + suffix + "-" + routeKey(route) + "-audio");
        boolean glasses = SOURCE_GLASSES.equals(sourceDeviceKind);
        String deviceModel = glasses ? "" : clean(Build.MODEL);
        String deviceLabel = deviceLabel(deviceId, glasses, deviceModel);
        JSONObject body = new JSONObject()
                .put("stream_id", streamId)
                .put("name", deviceLabel)
                .put("device_kind", glasses ? "glasses" : "mobile")
                .put("device_model", deviceModel)
                .put("source_device_id", deviceId)
                .put("source_device_kind", sourceDeviceKind)
                .put("channel_type", "audio_stream")
                .put("proactivity_preference", settings.proactivityPreference.wireValue)
                .put("route_profile_id", route)
                .put("session_id", deviceId);
        JSONObject streamState = jsonRequest("POST", "/api/rabilink/speech/v1/audio-streams/rabilink/start",
                "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 60000);
        if (!supportsDurableChunkProtocol(streamState)) {
            try {
                JSONObject stopBody = new JSONObject().put("stream_id", streamId);
                jsonRequest("POST", "/api/rabilink/speech/v1/audio-streams/rabilink/stop",
                        "application/json; charset=utf-8",
                        stopBody.toString().getBytes(StandardCharsets.UTF_8), 60000);
            } catch (Throwable ignored) { }
            throw new IllegalStateException("Rabi PC 音频服务版本过旧，未发送 PCM；请先更新支持持久 ACK v2 的 RabiSpeech");
        }
        activeAudioStreamId = streamId;
        activeAudioStreamSource = sourceDeviceKind;
        activeAudioStreamRoute = route;
        audioStreamSequence = resumeAudioStreamSequence(findAudioStreamSequence(streamState, streamId));
        String serverChunkId = findAudioStreamChunkId(streamState, streamId);
        long serverChunkBytes = findAudioStreamChunkBytes(streamState, streamId);
        String serverChecksum = findAudioStreamChecksum(streamState, streamId);
        if (!audioSpool.reconcileLastServerAck(audioStreamSequence, serverChunkId,
                serverChunkBytes, serverChecksum)) {
            RabiDurableAudioSpool.Segment head = audioSpool.nextUpload();
            if (head != null && head.serverSequence > 0L && head.serverSequence != audioStreamSequence + 1L) {
                audioSpool.resetHeadServerAssignment();
            }
        }
        audioStreamChunkFailures = 0;
        audioStreamRetryWaiting = false;
        audioStorageFailureReported = false;
        armAudioStreamKeepalive();
        listener.onStatus("手机音频流已接入 Rabi PC");
    }

    static String deviceLabel(String stableDeviceId, boolean glasses, String deviceModel) {
        String value = clean(stableDeviceId);
        int split = value.lastIndexOf('-');
        String suffix = split >= 0 && split + 1 < value.length() ? value.substring(split + 1) : value;
        if (suffix.length() > 6) suffix = suffix.substring(suffix.length() - 6);
        String base = glasses ? "Rabi Glass" : "Rabi Android";
        String model = clean(deviceModel);
        if (!model.isEmpty()) base += " · " + model;
        return suffix.isEmpty() ? base : base + " · " + suffix;
    }

    static boolean supportsDurableChunkProtocol(JSONObject streamState) {
        JSONObject protocol = streamState == null ? null : streamState.optJSONObject("rabilink_chunk_protocol");
        return protocol != null
                && protocol.optInt("version", 0) >= 2
                && protocol.optBoolean("durable_ack_tuple", false)
                && protocol.optBoolean("cross_process_claim", false)
                && "retain_without_ack".equals(protocol.optString("ambiguous_replay_policy", ""));
    }

    private static long findAudioStreamSequence(JSONObject streamState, String streamId) {
        JSONArray clients = streamState == null ? null : streamState.optJSONArray("clients");
        for (int index = 0; clients != null && index < clients.length(); index++) {
            JSONObject client = clients.optJSONObject(index);
            if (client != null && clean(streamId).equals(clean(client.optString("id", "")))) {
                return client.optLong("last_sequence", 0L);
            }
        }
        return 0L;
    }

    private static String findAudioStreamChecksum(JSONObject streamState, String streamId) {
        JSONArray clients = streamState == null ? null : streamState.optJSONArray("clients");
        for (int index = 0; clients != null && index < clients.length(); index++) {
            JSONObject client = clients.optJSONObject(index);
            if (client != null && clean(streamId).equals(clean(client.optString("id", "")))) {
                return client.optString("last_chunk_sha256", "");
            }
        }
        return "";
    }

    private static String findAudioStreamChunkId(JSONObject streamState, String streamId) {
        JSONArray clients = streamState == null ? null : streamState.optJSONArray("clients");
        for (int index = 0; clients != null && index < clients.length(); index++) {
            JSONObject client = clients.optJSONObject(index);
            if (client != null && clean(streamId).equals(clean(client.optString("id", "")))) {
                return client.optString("last_chunk_id", "");
            }
        }
        return "";
    }

    private static long findAudioStreamChunkBytes(JSONObject streamState, String streamId) {
        JSONArray clients = streamState == null ? null : streamState.optJSONArray("clients");
        for (int index = 0; clients != null && index < clients.length(); index++) {
            JSONObject client = clients.optJSONObject(index);
            if (client != null && clean(streamId).equals(clean(client.optString("id", "")))) {
                return client.optLong("last_chunk_bytes", -1L);
            }
        }
        return -1L;
    }

    static long resumeAudioStreamSequence(long serverSequence) {
        return Math.max(0L, serverSequence);
    }

    static long nextPendingAudioSequence(long serverSequence, boolean hasPending) {
        return hasPending ? resumeAudioStreamSequence(serverSequence) + 1L : 0L;
    }

    private void flushAudioStreamChunk() throws Exception {
        if (activeAudioStreamId.isEmpty()) return;
        RabiDurableAudioSpool.Segment pending = audioSpool.nextUpload(activeAudioStreamSource, activeAudioStreamRoute);
        if (pending == null) return;
        long serverSequence = pending.serverSequence;
        if (serverSequence <= 0L) {
            serverSequence = audioStreamSequence + 1L;
            pending = audioSpool.assignServerSequence(pending, serverSequence);
        }
        String path = "/api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId="
                + encode(activeAudioStreamId) + "&sequence=" + serverSequence
                + "&chunkId=" + encode(pending.id);
        byte[] pcm;
        try {
            pcm = audioSpool.readPcm(pending);
        } catch (RabiDurableAudioSpool.PoisonedSegmentException poisoned) {
            if (!poisoned.isolated) throw poisoned;
            listener.onError("录音分片校验失败 · 已隔离并记录缺口，后续分片继续补传");
            return;
        }
        try {
            JSONObject acknowledgement = new JSONObject(new String(
                    request("POST", path, "application/octet-stream", pcm, 60000), StandardCharsets.UTF_8));
            if (!acknowledgement.optBoolean("ok", false)
                    || acknowledgement.optLong("accepted_bytes", -1L) != pending.bytes
                    || acknowledgement.optLong("sequence", -1L) != serverSequence
                    || !pending.id.equals(acknowledgement.optString("chunk_id", ""))
                    || !pending.sha256.equalsIgnoreCase(acknowledgement.optString("sha256", ""))) {
                throw new IllegalStateException("Rabi PC 未返回完整录音分片确认");
            }
            audioSpool.acknowledge(pending.id, serverSequence, pending.bytes, pending.sha256);
        } catch (Throwable error) {
            audioSpool.markUploadFailure(pending, error);
            throw error;
        }
        audioStreamSequence = serverSequence;
        audioStreamChunkFailures = 0;
        audioStreamRetryWaiting = false;
        armAudioStreamKeepalive();
    }

    static long audioStreamKeepaliveDelayMs() {
        return 5_000L;
    }

    private synchronized void armAudioStreamKeepalive() {
        cancelAudioStreamKeepaliveLocked();
        if (audioStreamExecutor.isShutdown() || activeAudioStreamId.isEmpty()
                || audioStreamKeepaliveUnsupported || !networkWakeGate.isAvailable()) return;
        try {
            audioStreamKeepaliveFuture = audioStreamExecutor.schedule(
                    () -> enqueueAudioControl(this::sendAudioStreamKeepalive),
                    audioStreamKeepaliveDelayMs(),
                    TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
        }
    }

    private void sendAudioStreamKeepalive() {
        if (activeAudioStreamId.isEmpty() || !networkWakeGate.isAvailable()) return;
        String streamId = activeAudioStreamId;
        try {
            request("POST",
                    "/api/rabilink/speech/v1/audio-streams/rabilink/keepalive?streamId=" + encode(streamId),
                    "application/octet-stream", new byte[0], 60_000);
            audioStreamChunkFailures = 0;
            audioStreamRetryWaiting = false;
            if (streamId.equals(activeAudioStreamId)) armAudioStreamKeepalive();
        } catch (Throwable error) {
            if (shouldDisableAudioStreamKeepalive(error)) {
                audioStreamKeepaliveUnsupported = true;
                cancelAudioStreamKeepalive();
                listener.onStatus("当前 Relay 版本不支持音频保活，继续按 PCM 事件自动恢复");
                return;
            }
            handleAudioStreamFailure(error);
        }
    }

    static boolean shouldDisableAudioStreamKeepalive(Throwable error) {
        return clean(error == null ? "" : error.getMessage()).startsWith("Relay HTTP 404:");
    }

    private synchronized void cancelAudioStreamKeepalive() {
        cancelAudioStreamKeepaliveLocked();
    }

    private void cancelAudioStreamKeepaliveLocked() {
        ScheduledFuture<?> current = audioStreamKeepaliveFuture;
        audioStreamKeepaliveFuture = null;
        if (current != null) current.cancel(false);
    }

    private void stopActiveAudioStream() {
        cancelAudioStreamKeepalive();
        if (activeAudioStreamId.isEmpty()) {
            resetAudioStream();
            return;
        }
        String streamId = activeAudioStreamId;
        try {
            JSONObject body = new JSONObject().put("stream_id", streamId);
            jsonRequest("POST", "/api/rabilink/speech/v1/audio-streams/rabilink/stop",
                    "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 60000);
        } catch (Throwable ignored) {
        } finally {
            resetAudioStream();
        }
    }

    private void resetAudioStream() {
        cancelAudioStreamKeepalive();
        activeAudioStreamId = "";
        activeAudioStreamSource = "";
        activeAudioStreamRoute = "";
        audioStreamSequence = 0;
        audioStreamChunkFailures = 0;
        audioStreamRetryWaiting = false;
        audioStorageFailureReported = false;
        audioStreamRecoveryGeneration.incrementAndGet();
    }

    private void resetAudioStreamTransportForRetry() {
        cancelAudioStreamKeepalive();
        activeAudioStreamId = "";
        activeAudioStreamSource = "";
        activeAudioStreamRoute = "";
        audioStreamSequence = 0;
    }

    private static String safeStreamId(String value) {
        String normalized = clean(value).replaceAll("[^A-Za-z0-9._-]", "-");
        return normalized.length() > 100 ? normalized.substring(0, 100) : normalized;
    }

    public void retryFailedItems() {
        File[] deferred = RabiReliableQueueFiles.list(replyQueueDirectory, ".json");
        for (File file : deferred) try {
            JSONObject item = readQueueJson(replyQueueDirectory, "延迟回复", file);
            if (item == null) continue;
            persistDeferredReply(item, item.optInt("failures", 3), 0);
        } catch (Throwable ignored) { }
        listener.onStatus("已重新启用失败项重试"); requestDrain(0);
    }

    private void drainQueues() {
        drainControlQueue();
        drainMediaQueue();
        drainDeferredReplies();
        drainReceiptQueue();
        drainDiagnostics();
    }

    private synchronized void requestDrain(long delayMs) {
        if (!running || drainScheduled) return;
        drainScheduled = true;
        uploadExecutor.schedule(() -> {
            synchronized (RabiGlassPcBackend.this) { drainScheduled = false; }
            if (!networkWakeGate.isAvailable()) return;
            drainQueues();
            if (networkWakeGate.isAvailable() && hasPendingQueueItems()) requestDrain(5000);
        }, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
    }

    private boolean hasPendingQueueItems() {
        return hasFiles(replyQueueDirectory, ".json")
                || hasFiles(mediaQueueDirectory, ".json")
                || hasFiles(controlQueueDirectory, ".json")
                || hasFiles(receiptQueueDirectory, ".json")
                || hasFiles(diagnosticQueueDirectory, ".json");
    }

    private static boolean hasFiles(File directory, String suffix) {
        return RabiReliableQueueFiles.list(directory, suffix).length > 0;
    }

    public synchronized void queueDiagnostic(String event, String level, String state) {
        try {
            long now = System.currentTimeMillis();
            String safeEvent = clean(event).replaceAll("[^a-zA-Z0-9._:-]", "_");
            String safeState = clean(state).replaceAll("https?://\\S+|rbl_[0-9A-Za-z_-]+", "[redacted]");
            String diagnosticKey = safeEvent + "\n" + level + "\n" + safeState;
            if (diagnosticKey.equals(lastDiagnosticKey) && now - lastDiagnosticAt < 60_000L) return;
            lastDiagnosticKey = diagnosticKey;
            lastDiagnosticAt = now;
            JSONObject value = new JSONObject().put("id", "mobile-" + now + "-" + UUID.randomUUID())
                    .put("time", new java.util.Date(now).toInstant().toString())
                    .put("event", safeEvent.substring(0, Math.min(80, safeEvent.length())))
                    .put("level", "error".equals(level) ? "error" : "info")
                    .put("message", safeState.substring(0, Math.min(160, safeState.length())));
            File file = new File(diagnosticQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            RabiReliableQueueFiles.writeAtomically(file, value.toString().getBytes(StandardCharsets.UTF_8));
            pruneFiles(diagnosticQueueDirectory, ".json", 500, 7L * 24L * 60L * 60L * 1000L);
            requestDrain(0);
        } catch (Throwable ignored) { }
    }

    private void drainDiagnostics() {
        if (!configured()) return;
        File[] pending = RabiReliableQueueFiles.list(diagnosticQueueDirectory, ".json");
        if (pending.length == 0) return;
        JSONArray logs = new JSONArray(); List<File> batch = new ArrayList<>();
        for (int index = 0; index < Math.min(20, pending.length); index++) {
            JSONObject item = readQueueJson(diagnosticQueueDirectory, "诊断", pending[index]);
            if (item == null) continue;
            logs.put(item);
            batch.add(pending[index]);
        }
        if (logs.length() == 0) return;
        try {
            JSONObject body = new JSONObject().put("deviceId", deviceId).put("deviceKind", deviceId.contains("glass") ? "glasses" : "phone")
                    .put("deviceName", deviceId.contains("glass") ? "Rabi Glass" : "Rabi 移动端")
                    .put("source", "rabi-mobile-endpoint").put("logs", logs);
            jsonRequest("POST", "/api/rabilink/devices/logs", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
            for (File file : batch) file.delete();
        } catch (Throwable ignored) { }
    }

    private static void pruneFiles(File directory, String suffix, int maximum, long maxAgeMs) {
        File[] files = directory.listFiles((parent, name) -> name.endsWith(suffix)); if (files == null) return;
        Arrays.sort(files, Comparator.comparing(File::getName)); long cutoff = System.currentTimeMillis() - maxAgeMs;
        int excess = Math.max(0, files.length - maximum);
        for (int index = 0; index < files.length; index++) if (index < excess || files[index].lastModified() < cutoff) files[index].delete();
    }

    public void requestConversationReview() {
        requestConversationReview(SOURCE_PHONE);
    }

    public void requestConversationReview(String sourceDeviceKind) {
        try {
            long now = System.currentTimeMillis();
            String origin = normalizedSourceKind(sourceDeviceKind);
            JSONObject body = new JSONObject()
                    .put("text", origin.equals("glasses")
                            ? "用户在眼镜连接会话模式单击触摸板，要求现在审阅会话记录。"
                            : "用户在手机持续会话中点击提示，要求现在审阅会话记录。")
                    .put("type", "rabilink.review_request")
                    .put("deliveryMode", "observe")
                    .put("reviewRequested", true)
                    .put("source", "rabilink-" + origin + "-review")
                    .put("sender", origin.equals("glasses") ? "Rokid Glass" : "RabiLink Phone")
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", origin.equals("glasses") ? "Rabi Glass" : "RabiLink Phone")
                    .put("sourceDeviceKind", origin)
                    .put("channelType", "control")
                    .put("proactivityPreference", settings.proactivityPreference.wireValue)
                    .put("transport", "phone-control-backend")
                    .put("clientMessageId", origin + "-review-" + now + "-" + UUID.randomUUID())
                    .put("sessionId", deviceId)
                    .put("routeProfileId", routeProfileId())
                    .put("capturedAt", now);
            controlQueueDirectory.mkdirs();
            ensureQueueCapacity(controlQueueDirectory, ".json", MAX_CONTROL_QUEUE_ITEMS, "文字与控制");
            File target = new File(controlQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            RabiReliableQueueFiles.writeAtomically(target, body.toString().getBytes(StandardCharsets.UTF_8));
            listener.onStatus("审阅提示已进入手机待传队列");
            requestDrain(0);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    public void submitText(String text) {
        submitText(text, routeProfileId(), "", false);
    }

    public void submitText(String text, String routeProfileId, String clientMessageId) {
        submitText(text, routeProfileId, clientMessageId, false);
    }

    public void submitConfigurationRequest(String text) {
        submitText(text, routeProfileId(), "", true);
    }

    public void submitConfigurationRequest(String text, String routeProfileId, String clientMessageId) {
        submitText(text, routeProfileId, clientMessageId, true);
    }

    public void submitProactivityPreference(String preference) {
        try {
            RabiConversationSettings.ProactivityPreference selected =
                    RabiConversationSettings.ProactivityPreference.fromPersisted(preference);
            long now = System.currentTimeMillis();
            JSONObject body = new JSONObject()
                    .put("text", "用户明确更新了主动性偏好：" + selected.wireValue)
                    .put("type", "rabilink.preference")
                    .put("deliveryMode", "observe")
                    .put("preferenceKind", "proactivity")
                    .put("preferenceValue", selected.wireValue)
                    .put("explicitPreference", true)
                    .put("source", "rabilink-phone-settings")
                    .put("sender", "RabiLink Phone")
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", "RabiLink Phone")
                    .put("sourceDeviceKind", SOURCE_PHONE)
                    .put("channelType", "settings")
                    .put("transport", "phone-control-backend")
                    .put("clientMessageId", "phone-proactivity-" + now + "-" + UUID.randomUUID())
                    .put("sessionId", deviceId)
                    .put("routeProfileId", routeProfileId())
                    .put("capturedAt", now);
            ensureQueueCapacity(controlQueueDirectory, ".json", MAX_CONTROL_QUEUE_ITEMS, "文字与控制");
            File target = new File(controlQueueDirectory,
                    String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            RabiReliableQueueFiles.writeAtomically(target, body.toString().getBytes(StandardCharsets.UTF_8));
            listener.onStatus("主动性偏好已进入手机可靠待传队列");
            requestDrain(0);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    private void submitText(String text, String routeProfileId, String clientMessageId, boolean configurationRequest) {
        String value = clean(text);
        if (value.isEmpty()) return;
        try {
            long now = System.currentTimeMillis();
            String stableClientMessageId = clean(clientMessageId).isEmpty() ? "phone-text-" + now + "-" + UUID.randomUUID() : clean(clientMessageId);
            JSONObject body = new JSONObject().put("text", value).put("type", configurationRequest ? "rabilink.configuration_request" : "rabilink.message")
                    .put("deliveryMode", "direct").put("source", "rabilink-phone-chat")
                    .put("configurationRequested", configurationRequest)
                    .put("sender", "RabiLink Phone").put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", "RabiLink Phone").put("sourceDeviceKind", "phone")
                    .put("channelType", configurationRequest ? "configuration" : "chat")
                    .put("proactivityPreference", settings.proactivityPreference.wireValue)
                    .put("transport", "phone-chat-backend").put("clientMessageId", stableClientMessageId)
                    .put("sessionId", deviceId).put("routeProfileId", clean(routeProfileId)).put("capturedAt", now);
            ensureQueueCapacity(controlQueueDirectory, ".json", MAX_CONTROL_QUEUE_ITEMS, "文字与控制");
            File target = new File(controlQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            RabiReliableQueueFiles.writeAtomically(target, body.toString().getBytes(StandardCharsets.UTF_8));
            listener.onStatus(configurationRequest ? "配置请求已进入 Rabi PC 安全队列" : "文本消息已进入手机待传队列"); requestDrain(0);
        } catch (Throwable error) { listener.onError(shortError(error)); }
    }

    private void drainControlQueue() {
        if (!configured()) return;
        File[] pending = RabiReliableQueueFiles.list(controlQueueDirectory, ".json");
        if (pending.length == 0) return;
        for (File item : pending) {
            JSONObject queued = readQueueJson(controlQueueDirectory, "文字与控制", item);
            if (queued == null) continue;
            try {
                byte[] body = RabiReliableQueueFiles.read(item);
                String clientMessageId = queued.optString("clientMessageId", "");
                String routeProfileId = queued.optString("routeProfileId", "");
                listener.onDeliveryState(clientMessageId, routeProfileId, "sending", "");
                jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body, 20000);
                if (!item.delete()) throw new IllegalStateException("无法确认审阅提示队列项");
                String type = queued.optString("type", "");
                listener.onStatus("rabilink.review_request".equals(type)
                        ? "已推送审阅请求 · 等待 Rabi"
                        : "rabilink.configuration_request".equals(type)
                                ? "配置请求已送达 Rabi PC"
                                 : "消息已送达 Rabi PC");
                listener.onDeliveryState(clientMessageId, routeProfileId, "sent", "");
            } catch (Throwable error) {
                listener.onDeliveryState(queued.optString("clientMessageId", ""), queued.optString("routeProfileId", ""), "failed", shortError(error));
                listener.onError(shortError(error));
                return;
            }
        }
    }

    public void submitMedia(byte[] data, String contentType, String fileName, String caption) {
        submitMedia(data, contentType, fileName, caption, routeProfileId(), "");
    }

    public void submitMedia(byte[] data, String contentType, String fileName, String caption,
                            String routeProfileId, String clientMessageId) {
        byte[] copy = data == null ? new byte[0] : data.clone();
        try {
            if (copy.length == 0) throw new IllegalArgumentException("媒体内容为空");
            persistMedia(copy, contentType, fileName, caption, routeProfileId, clientMessageId, SOURCE_PHONE);
            listener.onStatus("媒体已进入手机可靠待传队列");
            requestDrain(0);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    public void submitMediaFromSource(byte[] data, String contentType, String fileName, String caption, String sourceDeviceKind) {
        byte[] copy = data == null ? new byte[0] : data.clone();
        try {
            if (copy.length == 0) throw new IllegalArgumentException("媒体内容为空");
            persistMedia(copy, contentType, fileName, caption, routeProfileId(), "", normalizedSourceKind(sourceDeviceKind));
            listener.onStatus("媒体已进入手机可靠待传队列");
            requestDrain(0);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    private void persistMedia(byte[] data, String contentType, String fileName, String caption,
                              String routeProfileId, String clientMessageId, String sourceDeviceKind) throws Exception {
        mediaQueueDirectory.mkdirs();
        ensureQueueCapacity(mediaQueueDirectory, ".json", MAX_MEDIA_QUEUE_ITEMS, "媒体");
        String id = String.format(java.util.Locale.US, "%013d-%s", System.currentTimeMillis(), UUID.randomUUID());
        File binary = new File(mediaQueueDirectory, id + ".bin");
        File metadata = new File(mediaQueueDirectory, id + ".json");
        RabiReliableQueueFiles.writeAtomically(binary, data);
        JSONObject value = new JSONObject().put("contentType", clean(contentType)).put("fileName", clean(fileName))
                .put("caption", clean(caption)).put("clientMessageId", clean(clientMessageId).isEmpty() ? "queued-media-" + id : clean(clientMessageId))
                .put("routeProfileId", clean(routeProfileId))
                .put("sourceDeviceKind", sourceDeviceKind)
                .put("proactivityPreference", settings.proactivityPreference.wireValue)
                .put("capturedAt", System.currentTimeMillis());
        RabiReliableQueueFiles.writeAtomically(metadata, value.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void drainMediaQueue() {
        if (!configured()) return;
        File[] pending = RabiReliableQueueFiles.list(mediaQueueDirectory, ".json");
        if (pending.length == 0) return;
        for (File metadata : pending) {
            File binary = new File(mediaQueueDirectory, metadata.getName().replace(".json", ".bin"));
            if (!binary.exists()) {
                quarantineQueueItem(mediaQueueDirectory, "媒体", "missing_binary", metadata);
                continue;
            }
            JSONObject value = readQueueJson(mediaQueueDirectory, "媒体", metadata, binary);
            if (value == null) continue;
            try {
                listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "sending", "");
                byte[] data = RabiReliableQueueFiles.read(binary);
                listener.onStatus("手机正在慢传媒体 · 剩余 " + pending.length);
                String path = "/api/rabilink/devices/media?fileName=" + encode(value.optString("fileName", "media.bin"));
                JSONObject receipt = new JSONObject(new String(request("POST", path,
                        value.optString("contentType", "application/octet-stream"), data, 10 * 60 * 1000), StandardCharsets.UTF_8));
                publishMediaObservation(value.optString("caption", ""), receipt.getJSONObject("attachment"),
                        value.optString("clientMessageId"), value.optLong("capturedAt", metadata.lastModified()),
                        value.optString("routeProfileId", ""),
                        normalizedSourceKind(value.optString("sourceDeviceKind", SOURCE_PHONE)),
                        value.optString("proactivityPreference", "agent_decides"));
                if (!binary.delete() || !metadata.delete()) throw new IllegalStateException("无法确认媒体队列项");
                listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "sent", "");
                listener.onStatus("媒体已进入 Rabi PC 消息端");
            } catch (Throwable error) {
                listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "failed", shortError(error));
                listener.onError(shortError(error));
                return;
            }
        }
    }

    private void eventLoop() {
        while (running) {
            try {
                if (!networkWakeGate.awaitAvailable()) return;
                if (!configured()) {
                    listener.onStatus("等待配置 RabiLink 事件流");
                    return;
                }
                String cursor = preferences.getString("cursor:" + deviceId, "");
                String deviceKind = deviceId.contains("glass") ? "glasses" : "phone";
                URL url = new URL(baseUrl + "/api/rabilink/events?deviceId=" + encode(deviceId)
                        + "&deviceKind=" + encode(deviceKind) + "&after=" + encode(cursor));
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                eventConnection = connection;
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setRequestProperty("X-RabiLink-Token", token);
                connection.setConnectTimeout(15000);
                // Transport-level stall deadline: Relay emits a keepalive every 15 seconds.
                // A silent half-open socket must reconnect and run the ready -> cursor catch-up path.
                connection.setReadTimeout(EVENT_STREAM_READ_TIMEOUT_MS);
                if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) {
                    throw new IllegalStateException("RabiLink 事件流连接失败 · HTTP " + connection.getResponseCode());
                }
                eventReconnectAttempt = 0;
                listener.onStatus("RabiLink 事件流已连接");
                onNetworkAvailable();
                requestDrain(0);
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String event = "message";
                    StringBuilder eventData = new StringBuilder();
                    String line;
                    while (running && (line = reader.readLine()) != null) {
                        if (line.startsWith("event:")) {
                            event = line.substring(6).trim();
                        } else if (line.startsWith("data:")) {
                            eventData.append(line.substring(5).trim());
                        } else if (line.isEmpty()) {
                            if ("ready".equals(event) || "outbox_available".equals(event)) fetchAvailableReplies();
                            if ("persona_avatar_changed".equals(event)) {
                                try {
                                    JSONObject data = new JSONObject(eventData.toString());
                                    listener.onPersonaAvatarChanged(data.optString("roleId", ""), data.optString("avatarVersion", ""), data.optString("avatarUrl", ""));
                                } catch (Throwable ignored) { }
                            }
                            event = "message";
                            eventData.setLength(0);
                        }
                    }
                }
            } catch (Throwable error) {
                if (!running) return;
                if (error instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (eventReconnectRequested.getAndSet(false)) {
                    eventReconnectAttempt = 0;
                    continue;
                }
                if (!networkWakeGate.isAvailable()) continue;
                listener.onError(shortError(error));
                long delayMs = eventReconnectDelayMs(++eventReconnectAttempt);
                try {
                    if (!networkWakeGate.awaitRetry(delayMs)) return;
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            } finally {
                HttpURLConnection current = eventConnection;
                eventConnection = null;
                if (current != null) current.disconnect();
            }
        }
    }

    private void ensureEventLoop() {
        networkWakeGate.wake();
        if (!running || !eventLoopActive.compareAndSet(false, true)) return;
        try {
            eventExecutor.execute(() -> {
                try {
                    eventLoop();
                } finally {
                    eventLoopActive.set(false);
                    if (running && configured()) ensureEventLoop();
                }
            });
        } catch (RejectedExecutionException error) {
            eventLoopActive.set(false);
        }
    }

    private static long eventReconnectDelayMs(int failures) {
        if (failures <= 1) return 1_000L;
        if (failures == 2) return 2_500L;
        if (failures == 3) return 5_000L;
        if (failures == 4) return 10_000L;
        return 30_000L;
    }

    private void fetchAvailableReplies() throws Exception {
        String cursor = preferences.getString("cursor:" + deviceId, "");
        String deviceKind = deviceId.contains("glass") ? "glasses" : "phone";
        JSONObject page = jsonRequest("GET", "/api/rabilink/devices/messages?deviceId=" + encode(deviceId)
                + "&deviceKind=" + deviceKind + "&after=" + encode(cursor) + "&waitMs=0&stream=1", null, null, 20000);
        String next = page.optString("nextCursor", page.optString("cursor", cursor));
        boolean cursorReset = page.optBoolean("cursorReset", false);
        JSONArray messages = page.optJSONArray("messages");
        for (int index = 0; messages != null && index < messages.length(); index++) {
            JSONObject item = messages.optJSONObject(index);
            String text = item == null ? "" : item.optString("text", "").trim();
            JSONArray attachments = item == null ? null : item.optJSONArray("attachments");
            if (text.isEmpty() && (attachments == null || attachments.length() == 0)) continue;
            String messageId = item.optString("deliveryId", item.optString("id", "message-" + index));
            if (wasDelivered(messageId)) continue;
            try {
                deliverReply(item);
            } catch (Throwable error) {
                int failures = preferences.getInt("replyFailures:" + deviceId + ":" + messageId, 0) + 1;
                preferences.edit().putInt("replyFailures:" + deviceId + ":" + messageId, failures).apply();
                if (!shouldDeferReplyDelivery(failures)) throw error;
                long retryDelayMs = deferredReplyRetryDelayMs(failures);
                persistDeferredReply(item, failures, System.currentTimeMillis() + retryDelayMs);
                requestDrain(retryDelayMs);
                listener.onStatus(deferredReplyNotice());
            }
        }
        if (!next.isEmpty()) preferences.edit().putString("cursor:" + deviceId, next).apply();
        if (cursorReset) listener.onStatus("RabiLink 下行游标已重建，正在按本机幂等记录补齐保留消息");
    }

    private synchronized void deliverReply(JSONObject item) throws Exception {
        String text = item.optString("text", "").trim();
        String messageId = item.optString("deliveryId", item.optString("id", "message"));
        String routeProfileId = item.optString("routeProfileId", "");
        JSONArray sourceAttachments = item.optJSONArray("attachments");
        if (text.isEmpty() && (sourceAttachments == null || sourceAttachments.length() == 0)) return;
        if (wasDelivered(messageId)) {
            cleanupCompletedReply(messageId);
            return;
        }
        JSONArray presentation = item.optJSONArray("presentation");
        boolean wantsTts = !text.isEmpty() && (presentation == null || presentation.length() == 0);
        for (int index = 0; !text.isEmpty() && presentation != null && index < presentation.length(); index++) if ("tts".equals(presentation.optString(index))) wantsTts = true;
        if (wantsTts) listener.onStatus("Rabi PC 正在合成移动端回复");
        byte[] pcm = wantsTts ? cachedReply(messageId) : new byte[0];
        if (wantsTts && pcm == null) {
            byte[] wav = request("POST", "/api/rabilink/speech/v1/audio/speech", "application/json; charset=utf-8",
                    new JSONObject().put("model", settings.ttsModel).put("input", text).put("voice", settings.ttsVoice)
                            .put("response_format", "wav").put("sample_rate", 16000).put("play", false).put("session_id", deviceId)
                            .toString().getBytes(StandardCharsets.UTF_8), 240000);
            pcm = wavPcm(wav); persistReply(messageId, pcm);
        }
        JSONArray attachments = materializeIncomingAttachments(sourceAttachments, messageId);
        ReplyDeliveryResult delivery = listener.onReply(messageId, routeProfileId, text, pcm, attachments);
        if (shouldRetryReplyDelivery(delivery)) throw new IllegalStateException("回复尚未被当前输出设备确认");
        // Text/attachments reaching the local ledger is the delivery terminal.
        // Playback is a separate observable outcome and must never re-deliver
        // the already visible reply.
        queueMessageReceipt(item, delivery.outputDeviceKind, "delivered", "", true);
        boolean playbackFailed = delivery.playbackRequested && !delivery.played;
        if (playbackFailed) {
            queueMessageReceipt(item, delivery.outputDeviceKind, "playback_failed",
                    delivery.playbackFailure.isEmpty() ? "输出设备未确认播放完成" : delivery.playbackFailure, false);
            requestDrain(0);
        }
        if (delivery.played) queueMessageReceipt(item, delivery.outputDeviceKind, "played", "", true);
        markDelivered(messageId);
        cleanupCompletedReply(messageId);
        requestDrain(0);
        listener.onStatus(playbackFailed ? playbackFailureNotice() : "Rabi 回复已投递到移动设备消息端");
    }

    static boolean shouldRetryReplyDelivery(ReplyDeliveryResult delivery) {
        return delivery == null || !delivery.delivered;
    }

    static boolean shouldDeferReplyDelivery(int failures) {
        return failures >= 3;
    }

    static long deferredReplyRetryDelayMs(int failures) {
        if (failures <= 3) return 30_000L;
        return Math.min(10L * 60L * 1000L, 30_000L * failures);
    }

    static String deferredReplyNotice() {
        return "回复暂未送达 · 连续尝试 3 次后已暂缓，网络恢复后自动重试";
    }

    static String playbackFailureNotice() {
        return "回复已收到 · 语音播放未完成，可在会话中点按重播";
    }

    private void cleanupCompletedReply(String messageId) {
        replyFile(messageId).delete();
        deferredReplyFile(messageId).delete();
        preferences.edit().remove("replyFailures:" + deviceId + ":" + messageId).apply();
    }

    private void queueMessageReceipt(JSONObject item, String outputDeviceKind, String state, String failure,
                                     boolean terminal) throws Exception {
        String messageId = item.optString("id", "");
        String deliveryId = item.optString("deliveryId", "");
        String receiptIdentity = clean(deliveryId).isEmpty() ? messageId : deliveryId;
        String key = Base64.encodeToString((receiptIdentity + ":" + outputDeviceKind + ":" + state).getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (key.length() > 180) key = key.substring(0, 180) + "-" + Integer.toHexString(receiptIdentity.hashCode());
        JSONObject body = new JSONObject()
                .put("messageId", messageId)
                .put("deliveryId", deliveryId)
                .put("deviceId", deviceId)
                .put("deviceKind", clean(outputDeviceKind).isEmpty() ? SOURCE_PHONE : clean(outputDeviceKind))
                .put("state", state)
                .put("terminal", terminal);
        if (!clean(failure).isEmpty()) body.put("failure", clean(failure).substring(0, Math.min(240, clean(failure).length())));
        RabiReliableQueueFiles.writeAtomically(new File(receiptQueueDirectory, key + ".json"),
                body.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void ensureQueueCapacity(File directory, String suffix, int maximum, String label) {
        if (RabiReliableQueueFiles.list(directory, suffix).length >= maximum) {
            throw new IllegalStateException(label + "可靠队列已满；请恢复连接或清理已确认项目后重试");
        }
    }

    private void drainReceiptQueue() {
        if (!configured()) return;
        File[] pending = RabiReliableQueueFiles.list(receiptQueueDirectory, ".json");
        for (File file : pending) {
            JSONObject receipt = readQueueJson(receiptQueueDirectory, "移动端播放回执", file);
            if (receipt == null) continue;
            try {
                byte[] body = receipt.toString().getBytes(StandardCharsets.UTF_8);
                jsonRequest("POST", "/api/rabilink/devices/message-receipts",
                        "application/json; charset=utf-8", body, 20000);
                if (receipt.optBoolean("terminal", false)) {
                    String localMessageId = receipt.optString("deliveryId", "");
                    if (localMessageId.isEmpty()) localMessageId = receipt.optString("messageId", "");
                    if (!localMessageId.isEmpty()) markDelivered(localMessageId);
                }
                if (!file.delete()) throw new IllegalStateException("无法确认移动端播放回执队列项");
            } catch (Throwable error) {
                listener.onError("移动端播放回执待网络恢复后重试 · " + shortError(error));
                return;
            }
        }
    }

    private File deferredReplyFile(String messageId) { return new File(replyQueueDirectory, replyFile(messageId).getName().replace(".pcm", ".json")); }

    private void persistDeferredReply(JSONObject item, int failures, long nextRetryAt) throws Exception {
        String messageId = item.optString("deliveryId", item.optString("id", "message"));
        JSONObject saved = new JSONObject(item.toString()).put("failures", failures).put("nextRetryAt", nextRetryAt);
        RabiReliableQueueFiles.writeAtomically(deferredReplyFile(messageId),
                saved.toString().getBytes(StandardCharsets.UTF_8));
    }

    private JSONArray materializeIncomingAttachments(JSONArray input, String messageId) throws Exception {
        JSONArray result = new JSONArray();
        if (input == null) return result;
        File directory = new File(context.getFilesDir(), "rabi-conversation/incoming/" + Integer.toHexString(messageId.hashCode()));
        directory.mkdirs();
        for (int index = 0; index < Math.min(8, input.length()); index++) {
            JSONObject item = input.optJSONObject(index); if (item == null) continue;
            String downloadPath = item.optString("downloadPath", "");
            if (!downloadPath.startsWith("/api/rabilink/devices/media/")) continue;
            String fileName = new File(item.optString("fileName", "attachment.bin")).getName();
            byte[] data = request("GET", downloadPath, null, null, 10 * 60 * 1000);
            File target = new File(directory, fileName);
            RabiReliableQueueFiles.writeAtomically(target, data);
            result.put(new JSONObject(item.toString()).put("localPath", target.getAbsolutePath()));
        }
        return result;
    }

    private void drainDeferredReplies() {
        if (!configured()) return;
        for (File file : RabiReliableQueueFiles.list(replyQueueDirectory, ".json")) {
            JSONObject item = readQueueJson(replyQueueDirectory, "延迟回复", file);
            if (item == null) continue;
            try {
            if (item.optLong("nextRetryAt", 0) > System.currentTimeMillis()) continue;
            try { deliverReply(item); }
            catch (Throwable error) {
                int failures = item.optInt("failures", 3) + 1;
                persistDeferredReply(item, failures, System.currentTimeMillis() + deferredReplyRetryDelayMs(failures));
            }
            } catch (Throwable error) { listener.onError(shortError(error)); }
        }
    }

    private File replyFile(String messageId) {
        String key = Base64.encodeToString(messageId.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (key.length() > 180) key = key.substring(0, 180) + "-" + Integer.toHexString(messageId.hashCode());
        return new File(replyQueueDirectory, key + ".pcm");
    }

    private byte[] cachedReply(String messageId) throws Exception {
        File file = replyFile(messageId);
        if (!file.exists()) return null;
        return RabiReliableQueueFiles.read(file);
    }

    private void persistReply(String messageId, byte[] pcm) throws Exception {
        RabiReliableQueueFiles.writeAtomically(replyFile(messageId), pcm);
    }

    private boolean wasDelivered(String messageId) {
        if (preferences.getString("delivered:" + deviceId + ":" + messageId, null) != null) return true;
        for (File receipt : RabiReliableQueueFiles.list(receiptQueueDirectory, ".json")) {
            JSONObject value = readQueueJson(receiptQueueDirectory, "移动端播放回执", receipt);
            if (value == null) continue;
            if (!value.optBoolean("terminal", false)) continue;
            if (messageId.equals(value.optString("deliveryId", ""))
                    || messageId.equals(value.optString("messageId", ""))) return true;
        }
        return false;
    }

    private void markDelivered(String messageId) {
        long now = System.currentTimeMillis();
        String prefix = "delivered:" + deviceId + ":";
        android.content.SharedPreferences.Editor editor = preferences.edit()
                .putString(prefix + messageId, Long.toString(now));
        List<Map.Entry<String, ?>> delivered = new ArrayList<>();
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith(prefix)) continue;
            long savedAt;
            try { savedAt = Long.parseLong(String.valueOf(entry.getValue())); }
            catch (NumberFormatException error) { savedAt = 0; }
            if (savedAt < now - 48L * 60L * 60L * 1000L) editor.remove(entry.getKey());
            else delivered.add(entry);
        }
        delivered.sort(Comparator.comparingLong(entry -> {
            try { return Long.parseLong(String.valueOf(entry.getValue())); }
            catch (NumberFormatException error) { return 0L; }
        }));
        for (int index = 0; index < Math.max(0, delivered.size() - 1999); index++) {
            editor.remove(delivered.get(index).getKey());
        }
        if (!editor.commit()) throw new IllegalStateException("无法持久化移动端已投递状态");
    }

    private void publishMediaObservation(String caption, JSONObject attachment, String clientMessageId, long capturedAt,
                                         String routeProfileId, String sourceDeviceKind,
                                         String proactivityPreference) throws Exception {
        long now = System.currentTimeMillis();
        boolean glasses = SOURCE_GLASSES.equals(normalizedSourceKind(sourceDeviceKind));
        String kind = attachment.optString("kind", "file");
        String text = clean(caption);
        if (text.isEmpty()) text = "眼镜发送了一条" + ("image".equals(kind) ? "照片" : "video".equals(kind) ? "视频" : "媒体") + "消息。";
        JSONObject body = new JSONObject().put("text", text).put("type", "rabilink.observation")
                .put("deliveryMode", "observe").put("source", "rabilink-glasses-phone-backend")
                .put("sourceDeviceId", deviceId).put("sourceDeviceName", glasses ? "Rabi Glass" : "Rabi 移动端")
                .put("sourceDeviceKind", glasses ? "glasses" : "phone")
                .put("channelType", "media")
                .put("proactivityPreference", RabiConversationSettings.ProactivityPreference
                        .fromPersisted(proactivityPreference).wireValue)
                .put("transport", "phone-media-backend")
                .put("clientMessageId", clean(clientMessageId).isEmpty() ? "glass-media-" + now + "-" + UUID.randomUUID() : clientMessageId)
                .put("routeProfileId", routeProfileId)
                .put("sessionId", deviceId)
                .put("capturedAt", capturedAt > 0 ? capturedAt : now)
                .put("attachments", new JSONArray().put(attachment));
        jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
    }

    public String reliableQueueSummary() {
        JSONObject audio = audioSpool.health();
        return "录音待传 " + audio.optInt("pendingSegments", 0)
                + " · 待落盘 " + audioWriteQueue.size()
                + " · 本地 " + String.format(java.util.Locale.US, "%.1f MiB", audio.optLong("storedBytes", 0L) / 1048576.0)
                + " · 隔离 " + audio.optLong("quarantineItems", 0L)
                + " · 文字/控制 " + RabiReliableQueueFiles.list(controlQueueDirectory, ".json").length
                + " · 媒体 " + RabiReliableQueueFiles.list(mediaQueueDirectory, ".json").length
                + " · 下行 " + RabiReliableQueueFiles.list(replyQueueDirectory, ".json").length
                + " · 回执 " + RabiReliableQueueFiles.list(receiptQueueDirectory, ".json").length;
    }

    private static String routeKey(String route) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(clean(route).getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder(12);
            for (int index = 0; index < 6; index++) value.append(String.format(java.util.Locale.US, "%02x", digest[index] & 0xff));
            return value.toString();
        } catch (Throwable ignored) {
            return Integer.toHexString(clean(route).hashCode());
        }
    }

    public JSONObject audioSpoolHealth() {
        JSONObject health = audioSpool.health();
        try {
            health.put("captureQueueItems", audioWriteQueue.size())
                    .put("captureBufferedBytes", audioWriteQueue.queuedBytes());
        } catch (Throwable ignored) { }
        return health;
    }

    public boolean clearAudioQuarantineAfterUserConfirmation() {
        return audioSpool.clearQuarantineAfterUserConfirmation();
    }

    private JSONObject jsonRequest(String method, String path, String contentType, byte[] body, int timeout) throws Exception {
        return new JSONObject(new String(request(method, path, contentType, body, timeout), StandardCharsets.UTF_8));
    }

    public JSONObject exchangeVideoOffer(String sdp) throws Exception {
        if (!configured()) throw new IllegalStateException("RabiLink is not configured");
        byte[] body = new JSONObject().put("deviceId", deviceId).put("sdp", sdp).toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > 64 * 1024) throw new IllegalArgumentException("Video signalling is too large");
        return jsonRequest("POST", "/api/rabilink/video/offer", "application/json", body, 30000);
    }

    private byte[] request(String method, String path, String contentType, byte[] body, int timeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method); connection.setConnectTimeout(15000); connection.setReadTimeout(timeout);
        connection.setRequestProperty("X-RabiLink-Token", token); connection.setRequestProperty("Accept", "application/json, audio/wav");
        if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type", contentType); connection.setFixedLengthStreamingMode(body.length); try (OutputStream out = connection.getOutputStream()) { out.write(body); } }
        int status = connection.getResponseCode();
        byte[] response = readAll(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
        connection.disconnect();
        if (status < 200 || status >= 300) throw new IllegalStateException("Relay HTTP " + status + ": " + new String(response, StandardCharsets.UTF_8));
        return response;
    }

    private static byte[] wavPcm(byte[] wav) { if (wav == null || wav.length < 44) throw new IllegalArgumentException("TTS response is not WAV"); ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN); int offset = 12; while (offset + 8 <= wav.length) { int id = b.getInt(offset), size = b.getInt(offset + 4), start = offset + 8; if (id == 0x61746164 && size >= 0 && start + size <= wav.length) { byte[] pcm = new byte[size]; System.arraycopy(wav, start, pcm, 0, size); return pcm; } offset = start + size + (size & 1); } throw new IllegalArgumentException("TTS WAV has no data chunk"); }
    private static byte[] readAll(InputStream input) throws Exception { if (input == null) return new byte[0]; try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int read; while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read); return out.toByteArray(); } }
    private static String encode(String value) throws Exception { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
    private static String clean(String value) { return value == null ? "" : value.trim(); }
    private static String normalizedSourceKind(String value) {
        return SOURCE_GLASSES.equalsIgnoreCase(clean(value)) ? SOURCE_GLASSES : SOURCE_PHONE;
    }
    private static String trimSlash(String value) { String result = clean(value); while (result.endsWith("/")) result = result.substring(0, result.length() - 1); return result; }
    private static String shortError(Throwable error) { String text = error.getMessage(); if (text == null || text.trim().isEmpty()) text = error.getClass().getSimpleName(); text = text.replace('\n', ' '); return text.length() > 160 ? text.substring(0, 160) : text; }
    private String routeProfileId() { return RabiConversationTarget.load(context); }
}
