package com.rabi.link;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.IBinder;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.core.app.NotificationCompat;

import com.rabi.link.modules.rokid.RabiGlassPcBackend;
import com.rabi.link.modules.rokid.RokidCxrController;
import com.rabi.link.modules.rokid.RabiGlassBridge;
import com.rabi.link.modules.rokid.RabiGlassBridgeFactory;
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture;
import com.rabi.link.modules.conversation.RabiBoundedAudioCache;
import com.rabi.link.modules.conversation.RabiMobileSpeechArchive;

/** Foreground phone client. Glasses are optional; this service works with the phone alone. */
public final class RabiConversationService extends Service {
    public static final String ACTION_START = "com.rabi.link.conversation.START";
    public static final String ACTION_STOP = "com.rabi.link.conversation.STOP";
    public static final String ACTION_REVIEW = "com.rabi.link.conversation.REVIEW";
    public static final String ACTION_MEDIA = "com.rabi.link.conversation.MEDIA";
    public static final String ACTION_TEXT = "com.rabi.link.conversation.TEXT";
    public static final String ACTION_RETRY = "com.rabi.link.conversation.RETRY";
    public static final String ACTION_CONFIG = "com.rabi.link.conversation.CONFIG";
    public static final String ACTION_RESTORE = "com.rabi.link.conversation.RESTORE";
    public static final String ACTION_PREFERENCE = "com.rabi.link.conversation.PREFERENCE";
    public static final String ACTION_REPLAY_TTS = "com.rabi.link.conversation.REPLAY_TTS";
    public static final String ACTION_CLEAR_AUDIO_QUARANTINE = "com.rabi.link.conversation.CLEAR_AUDIO_QUARANTINE";
    private static final String CHANNEL = "rabi_conversation";
    private static final String LISTENING_CHANNEL = "rabi_listening";
    private static final String MESSAGE_CHANNEL = "rabi_messages";
    private static final int NOTIFICATION_ID = 7421;
    private static final int REVIEW_NOTIFICATION_ID = 7422;
    private static final long REVIEW_NOTIFICATION_REFRESH_MS = 6L * 60L * 60L * 1000L;
    private static final long NETWORK_EVENT_FALLBACK_CHECK_MS = 5L * 60L * 1000L;
    private static final String EXTRA_ROUTE_PROFILE_ID = "route_profile_id";
    private static final String EXTRA_CLIENT_MESSAGE_ID = "client_message_id";
    private static final String EXTRA_PROACTIVITY_PREFERENCE = "proactivity_preference";
    private static final String EXTRA_TTS_MESSAGE_ID = "tts_message_id";
    private static final String EXTRA_TTS_LOCAL_PATH = "tts_local_path";
    private static final long MAX_REPLAY_WAV_BYTES = 32L * 1024L * 1024L;

    private RabiPhoneAudioCapture phoneAudioCapture;
    private RabiMobileSpeechArchive speechArchive;
    private RabiGlassPcBackend backend;
    private RabiChatStore chatStore;
    private RokidCxrController glassController;
    private RabiGlassBridge glassBridge;
    private com.rabi.link.modules.rokid.RabiDirectVideoSender directVideo;
    private final android.content.SharedPreferences.OnSharedPreferenceChangeListener videoSettingsListener = (preferences, key) -> {
        if (!RabiConversationSettings.KEY_DIRECT_VIDEO.equals(key)) return;
        if (RabiConversationSettings.directVideoEnabled(this)) startDirectVideo();
        else if (directVideo != null) directVideo.stop("视频已关闭");
    };
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean shutdownComplete;
    private boolean networkKnownOffline;
    private boolean networkFallbackCheckScheduled;
    private boolean voiceServiceActive;
    private final Object phonePlaybackLock = new Object();
    private final Set<String> pendingTtsReplayIds = Collections.synchronizedSet(new HashSet<>());
    private RabiConversationSettings.InputMode inputMode = RabiConversationSettings.InputMode.PAUSED;
    private final android.os.Handler notificationHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable reviewNotificationRefresh = new Runnable() {
        @Override public void run() {
            postReviewShortcut();
            notificationHandler.postDelayed(this, REVIEW_NOTIFICATION_REFRESH_MS);
        }
    };
    private final Runnable networkEventFallbackCheck = new Runnable() {
        @Override public void run() {
            networkFallbackCheckScheduled = false;
            if (shutdownComplete || !networkKnownOffline) return;
            ConnectivityManager manager = connectivityManager;
            RabiGlassPcBackend target = backend;
            try {
                if (manager != null && manager.getActiveNetwork() != null) {
                    networkKnownOffline = false;
                    if (target != null) target.onNetworkAvailable();
                    return;
                }
            } catch (Throwable ignored) { }
            scheduleNetworkEventFallbackCheck();
        }
    };

    public static void start(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    public static void stop(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, false);
        context.startService(new Intent(context, RabiConversationService.class).setAction(ACTION_STOP));
    }

    public static void requestReview(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_REVIEW));
    }

    public static void enqueueMedia(Context context, Uri uri, String contentType, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_MEDIA)
                .setData(uri).putExtra("contentType", contentType == null ? "application/octet-stream" : contentType)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-media-" + System.currentTimeMillis() + "-" + UUID.randomUUID())
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startForegroundService(intent);
    }

    public static void enqueueMedia(Context context, Uri uri, String contentType) {
        enqueueMedia(context, uri, contentType, RabiConversationTarget.load(context));
    }

    public static void sendText(Context context, String text, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_TEXT)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-text-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendText(Context context, String text) {
        sendText(context, text, RabiConversationTarget.load(context));
    }

    public static void sendConfigurationRequest(Context context, String text, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_CONFIG)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-config-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendConfigurationRequest(Context context, String text) {
        sendConfigurationRequest(context, text, RabiConversationTarget.load(context));
    }
    public static void retryFailed(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RETRY));
    }

    /** Replays only the locally retained WAV belonging to an Agent TTS chat message. */
    public static void replayTts(Context context, String messageId, String localPath) {
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_REPLAY_TTS)
                .putExtra(EXTRA_TTS_MESSAGE_ID, messageId == null ? "" : messageId)
                .putExtra(EXTRA_TTS_LOCAL_PATH, localPath == null ? "" : localPath);
        context.startForegroundService(intent);
    }

    public static void restoreAfterBoot(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RESTORE));
    }

    public static void clearAudioQuarantineAfterUserConfirmation(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class)
                .setAction(ACTION_CLEAR_AUDIO_QUARANTINE));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        RabiConversationSettings.videoPreferences(this).registerOnSharedPreferenceChangeListener(videoSettingsListener);
        createChannel();
        chatStore = new RabiChatStore(this);
        phoneAudioCapture = new RabiPhoneAudioCapture(this, new RabiPhoneAudioCapture.Listener() {
            @Override public void onPcm(byte[] pcm) { if (backend != null) backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_PHONE); }
            @Override public void onPlaybackSuppressed() { }
            @Override public void onGap(String reason, long estimatedBytes) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.recordAudioGap(reason, estimatedBytes, RabiGlassPcBackend.SOURCE_PHONE);
            }
            @Override public void onStatus(String status) { updateStatus(status); }
            @Override public void onDiagnostic(String event, String level, String state) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.queueDiagnostic(event, level, state);
            }
        });
        speechArchive = RabiMobileSpeechArchive.tryCreate(this);
        if (speechArchive != null) try { speechArchive.cleanup(); }
        catch (Throwable ignored) { }
        backend = new RabiGlassPcBackend(this, new RabiGlassPcBackend.Listener() {
            @Override public void onStatus(String status) { updateStatus(status); if (glassBridge != null) glassBridge.sendGlassAudioStatus(status); }
            @Override public void onTranscript(String text, String routeProfileId) { chatStore.append(null, "user", "voice", text, "", "audio/pcm", routeProfileId); updateRuntime("transcript", text); if (glassBridge != null) glassBridge.sendGlassTranscript(text); updateStatus("识别 · " + shortText(text)); }
            @Override public void onDeliveryState(String clientMessageId, String routeProfileId, String state, String failure) {
                chatStore.updateDelivery(clientMessageId, state, failure);
                updateRuntime("delivery", state + (failure == null || failure.trim().isEmpty() ? "" : " · " + friendlyError(failure)));
            }
            @Override public RabiGlassPcBackend.ReplyDeliveryResult onReply(String messageId, String routeProfileId, String text, byte[] pcm, org.json.JSONArray attachments) {
                String ttsPath = persistTtsMessage(text, routeProfileId, pcm);
                if ((text != null && !text.trim().isEmpty()) || (pcm != null && pcm.length > 0)) {
                    chatStore.append(messageId, "assistant", pcm != null && pcm.length > 0 ? "tts" : "text", text,
                            pcm != null && pcm.length > 0 ? "Agent-TTS.wav" : "", pcm != null && pcm.length > 0 ? "audio/wav" : "text/plain", routeProfileId, ttsPath);
                    if (pcm != null && pcm.length > 0 && !ttsPath.isEmpty()) chatStore.updatePlayback(messageId, "ready", "");
                }
                for (int index = 0; attachments != null && index < attachments.length(); index++) {
                    org.json.JSONObject item = attachments.optJSONObject(index); if (item == null) continue;
                    chatStore.append(messageId + ":attachment:" + index, "assistant", item.optString("kind", "file"), "",
                            item.optString("fileName", "attachment.bin"), item.optString("contentType", "application/octet-stream"),
                            routeProfileId, item.optString("localPath", ""));
                }
                String replySummary = text == null || text.trim().isEmpty()
                        ? "Agent 发来了 " + (attachments == null ? 0 : attachments.length()) + " 个附件"
                        : text;
                updateRuntime("reply", replySummary); showAgentMessage(messageId, routeProfileId, replySummary);
                RabiConversationSettings settings = RabiConversationSettings.load(RabiConversationService.this);
                if (inputMode == RabiConversationSettings.InputMode.GLASSES && glassBridge != null) {
                    glassBridge.sendGlassReplyText(replySummary);
                }
                boolean playbackRequested = settings.autoPlayAgentVoice && pcm != null && pcm.length > 0;
                boolean played = false;
                boolean glassesOutput = inputMode == RabiConversationSettings.InputMode.GLASSES;
                String outputDeviceKind = glassesOutput ? RabiGlassPcBackend.SOURCE_GLASSES : RabiGlassPcBackend.SOURCE_PHONE;
                String playbackFailure = "";
                if (playbackRequested) {
                    chatStore.updatePlayback(messageId, "playing", "");
                    if (glassesOutput) {
                        played = glassBridge != null && glassBridge.sendAudioPcmToGlass(messageId, pcm);
                        if (!played) playbackFailure = glassBridge == null ? "眼镜播放通道未连接" : "眼镜未确认播放完成";
                    } else {
                        played = playOnPhone(pcm);
                        if (!played) playbackFailure = "手机未确认播放完成";
                    }
                    chatStore.updatePlayback(messageId, played ? "played" : "failed", playbackFailure);
                    updateRuntime("ttsPlayback", played ? "语音播放完成" : "语音播放失败 · " + playbackFailure);
                }
                return new RabiGlassPcBackend.ReplyDeliveryResult(true, playbackRequested, played,
                        outputDeviceKind, playbackFailure);
            }
            @Override public void onPersonaAvatarChanged(String roleId, String avatarVersion, String avatarUrl) {
                String role = roleId == null ? "" : roleId.trim();
                if (role.isEmpty()) return;
                String version = avatarVersion == null ? "" : avatarVersion.trim();
                getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE).edit()
                        .putString("version:" + role, version)
                        .putBoolean("configured:" + role, !version.isEmpty()).apply();
                sendBroadcast(new Intent(RabiPersonaAvatarEvents.ACTION_CHANGED)
                        .setPackage(getPackageName())
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_ROLE_ID, role)
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_AVATAR_VERSION, version)
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_AVATAR_URL, avatarUrl == null ? "" : avatarUrl.trim()));
            }
            @Override public void onError(String message) {
                updateRuntime("error", friendlyError(message));
                updateStatus("错误 · " + friendlyError(message));
                if (backend != null) backend.queueDiagnostic("conversation.error", "error", "conversation backend error");
            }
        });
        registerNetworkEvents();
    }

    public static void updateProactivityPreference(Context context, String preference) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class)
                .setAction(ACTION_PREFERENCE)
                .putExtra(EXTRA_PROACTIVITY_PREFERENCE, preference == null ? "agent_decides" : preference));
    }

    private void registerNetworkEvents() {
        connectivityManager = getSystemService(ConnectivityManager.class);
        if (connectivityManager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                markNetworkAvailable();
            }

            @Override public void onLost(Network network) {
                if (connectivityManager != null && connectivityManager.getActiveNetwork() != null) return;
                markNetworkUnavailable();
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback, notificationHandler);
            if (connectivityManager.getActiveNetwork() == null) markNetworkUnavailable();
            else markNetworkAvailable();
        } catch (Throwable error) {
            networkCallback = null;
            networkKnownOffline = false;
            cancelNetworkEventFallbackCheck();
            RabiGlassPcBackend target = backend;
            if (target != null) target.onNetworkAvailable();
            updateStatus("系统网络事件不可用 · 保留连接退避恢复");
        }
    }

    private void markNetworkAvailable() {
        networkKnownOffline = false;
        cancelNetworkEventFallbackCheck();
        RabiGlassPcBackend target = backend;
        if (target != null) target.onNetworkAvailable();
        startDirectVideo();
    }

    private void markNetworkUnavailable() {
        if (directVideo != null) directVideo.stop("网络已断开，视频停止");
        networkKnownOffline = true;
        RabiGlassPcBackend target = backend;
        if (target != null) target.onNetworkUnavailable();
        scheduleNetworkEventFallbackCheck();
    }

    private void scheduleNetworkEventFallbackCheck() {
        if (shutdownComplete || !networkKnownOffline || networkFallbackCheckScheduled) return;
        networkFallbackCheckScheduled = true;
        // event-driven-allow: known-offline connectivity callback safety check; no business state is read.
        notificationHandler.postDelayed(networkEventFallbackCheck, NETWORK_EVENT_FALLBACK_CHECK_MS);
    }

    private void cancelNetworkEventFallbackCheck() {
        if (!networkFallbackCheckScheduled) return;
        notificationHandler.removeCallbacks(networkEventFallbackCheck);
        networkFallbackCheckScheduled = false;
    }

    private void unregisterNetworkEvents() {
        cancelNetworkEventFallbackCheck();
        networkKnownOffline = false;
        ConnectivityManager manager = connectivityManager;
        ConnectivityManager.NetworkCallback callback = networkCallback;
        networkCallback = null;
        connectivityManager = null;
        if (manager == null || callback == null) return;
        try { manager.unregisterNetworkCallback(callback); }
        catch (Throwable ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        updateRuntime("serviceAction", action == null ? ACTION_START : action);
        if (ACTION_STOP.equals(action)) {
            RabiConversationServiceState.setRestoreEnabled(this, false);
            shutdown(true);
            return START_NOT_STICKY;
        }
        if (!ACTION_RESTORE.equals(action)) {
            RabiConversationServiceState.setRestoreEnabled(this, true);
        }
        if (ACTION_RESTORE.equals(action)) {
            if (voiceServiceActive) {
                // A delayed boot/transport restore must never downgrade an already running
                // user-started microphone session.
                promote(personaDisplayName() + " 移动端持续服务", true);
                showReviewShortcut();
                if (configureBackend()) backend.start();
                return START_STICKY;
            }
            voiceServiceActive = false;
            pauseAllCaptureModes();
            promote(personaDisplayName() + " 消息连接正常", false);
            showReviewShortcut();
            if (configureBackend()) {
                backend.start();
                updateStatus("消息连接正常 · 语音采集未启动");
            } else {
                updateStatus("等待手机重新配置 RabiLink");
            }
            return START_STICKY;
        }
        if (ACTION_PREFERENCE.equals(action)) {
            promote("正在保存主动性偏好", false);
            showReviewShortcut();
            if (configureBackend()) backend.start();
            backend.submitProactivityPreference(intent.getStringExtra(EXTRA_PROACTIVITY_PREFERENCE));
            return START_STICKY;
        }
        if (ACTION_REVIEW.equals(action)) {
            promote("正在提示 " + personaDisplayName() + " 审阅", false);
            showReviewShortcut();
            if (configureBackend()) backend.start();
            if (backend != null) backend.requestConversationReview();
            return START_STICKY;
        }
        if (ACTION_REPLAY_TTS.equals(action)) {
            promote("正在重播夜雨语音", false);
            String messageId = intent.getStringExtra(EXTRA_TTS_MESSAGE_ID);
            String localPath = intent.getStringExtra(EXTRA_TTS_LOCAL_PATH);
            queueTtsReplay(messageId, localPath);
            return START_STICKY;
        }
        if (ACTION_MEDIA.equals(action)) {
            promote("正在保存媒体到可靠队列", false);
            if (configureBackend()) backend.start();
            Uri uri = intent.getData();
            String contentType = intent.getStringExtra("contentType");
            String routeProfileId = intent.getStringExtra(EXTRA_ROUTE_PROFILE_ID);
            String clientMessageId = intent.getStringExtra(EXTRA_CLIENT_MESSAGE_ID);
            new Thread(() -> enqueueMedia(uri, contentType, routeProfileId, clientMessageId), "rabi-phone-media-import").start();
            return START_STICKY;
        }
        if (ACTION_TEXT.equals(action) || ACTION_CONFIG.equals(action)) {
            promote("正在发送文本消息", false); showReviewShortcut(); if (configureBackend()) backend.start();
            String text = intent.getStringExtra("text");
            String routeProfileId = intent.getStringExtra(EXTRA_ROUTE_PROFILE_ID);
            if (routeProfileId == null || routeProfileId.trim().isEmpty()) routeProfileId = RabiConversationTarget.load(this);
            String clientMessageId = intent.getStringExtra(EXTRA_CLIENT_MESSAGE_ID);
            if (clientMessageId == null || clientMessageId.trim().isEmpty()) clientMessageId = "phone-text-" + System.currentTimeMillis() + "-" + UUID.randomUUID();
            if (text != null && !text.trim().isEmpty()) {
                chatStore.append(clientMessageId, "user", ACTION_CONFIG.equals(action) ? "configuration" : "text", text.trim(), "", "text/plain",
                        routeProfileId, "", clientMessageId, "queued", "");
                if (ACTION_CONFIG.equals(action)) backend.submitConfigurationRequest(text, routeProfileId, clientMessageId);
                else backend.submitText(text, routeProfileId, clientMessageId);
            }
            return START_STICKY;
        }
        if (ACTION_RETRY.equals(action)) {
            promote("正在重试失败消息", false); showReviewShortcut(); if (configureBackend()) backend.start(); backend.retryFailedItems();
            return START_STICKY;
        }
        if (ACTION_CLEAR_AUDIO_QUARANTINE.equals(action)) {
            promote("正在清理隔离录音", false);
            boolean cleared = backend != null && backend.clearAudioQuarantineAfterUserConfirmation();
            updateStatus(cleared ? "隔离录音已按你的确认清理" : "隔离录音清理失败 · 原文件仍保留");
            updateRuntime("queue", backend == null ? "服务尚未初始化" : backend.reliableQueueSummary());
            return START_STICKY;
        }
        promote("正在连接 " + personaDisplayName(), false);
        showReviewShortcut();
        startConversation();
        return START_STICKY;
    }

    private void startConversation() {
        RabiConversationSettings settings = RabiConversationSettings.load(this);
        updateRuntime("desiredMode", settings.inputMode.name());
        if (!settings.continuousListening) {
            voiceServiceActive = false;
            pauseAllCaptureModes();
            promote(personaDisplayName() + " 移动端消息连接", false);
            if (configureBackend()) {
                backend.start();
                updateStatus("消息连接正常 · 语音服务已关闭");
            } else {
                updateStatus("语音服务已关闭 · 等待手机配置 RabiLink");
            }
            return;
        }
        if (!configureBackend()) {
            updateStatus("等待手机配置 RabiLink");
            return;
        }
        updateRuntime("error", "");
        String persona = personaDisplayName();
        voiceServiceActive = settings.continuousListening;
        promote(settings.continuousListening ? persona + " 移动端持续服务" : persona + " 移动端消息连接", settings.continuousListening);
        backend.start();
        applyInputMode(settings);
    }

    private void applyInputMode(RabiConversationSettings settings) {
        if (settings.inputMode == RabiConversationSettings.InputMode.PAUSED) {
            pauseAllCaptureModes();
            updateStatus("已暂停采集 · 消息连接继续保持");
            return;
        }
        if (settings.inputMode == RabiConversationSettings.InputMode.GLASSES) {
            if (glassController != null && inputMode == RabiConversationSettings.InputMode.GLASSES) {
                if (RabiConversationSettings.directVideoEnabled(this)) startDirectVideo();
                else if (directVideo != null) directVideo.stop("视频已关闭");
                return;
            }
            phoneAudioCapture.pause();
            backend.pauseAudioStream();
            setInputMode(RabiConversationSettings.InputMode.PAUSED);
            updateRuntime("glasses", "正在连接眼镜；连接完成前保持暂停，不会启用手机麦克风");
            startGlassesBackend();
            return;
        }
        stopGlassesBackend();
        backend.beginAudioStream(RabiGlassPcBackend.SOURCE_PHONE);
        startPhoneCapture();
        setInputMode(RabiConversationSettings.InputMode.PHONE);
        updateRuntime("glasses", "未使用眼镜输入");
    }

    private void pauseAllCaptureModes() {
        phoneAudioCapture.pause();
        stopGlassesBackend();
        if (backend != null) backend.pauseAudioStream();
        setInputMode(RabiConversationSettings.InputMode.PAUSED);
    }

    private void setInputMode(RabiConversationSettings.InputMode next) {
        boolean changed = inputMode != next;
        inputMode = next;
        updateRuntime("activeMode", next.name());
        updateRuntime("capture", next == RabiConversationSettings.InputMode.PHONE
                ? "手机麦克风采集中"
                : next == RabiConversationSettings.InputMode.GLASSES
                        ? "眼镜麦克风采集中" : "采集已暂停");
        if (changed && backend != null) backend.queueDiagnostic("conversation.input_mode", "info", next.name().toLowerCase(java.util.Locale.ROOT));
    }

    private void promote(String text, boolean conversation) {
        int type = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        if (conversation) {
            type |= RabiConversationSettings.load(this).glassesEnabled
                    ? android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                    : android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        voiceServiceActive = conversation;
        startForeground(REVIEW_NOTIFICATION_ID, notification(text), type);
    }

    private void startGlassesBackend() {
        if (glassBridge != null || glassController != null) return;
        android.content.SharedPreferences values = getSharedPreferences("rokid_probe", MODE_PRIVATE);
        String token = values.getString("rokid_token", "");
        if (token == null || token.trim().isEmpty()) {
            updateRuntime("glasses", "眼镜模式不可用：尚未完成 Rokid 授权");
            updateStatus("眼镜模式不可用 · 请从设置打开眼镜后端并完成授权");
            return;
        }
        glassBridge = RabiGlassBridgeFactory.create(this, new RabiGlassBridge.Listener() {
            @Override public void onNativeVoiceLog(String line) { }
            @Override public void onNativeAsrText(String text, String channel, String clientId) { }
            @Override public void onNativeTtsAck(String text, String channel, String clientId) { }
            @Override public void onNativeCommandAck(String kind, String text, String channel, String clientId) { }
            @Override public void onNativeStatus(String text, String channel, String clientId) { updateStatus("眼镜 · " + shortText(text)); }
            @Override public void onNativeVoiceError(String kind, String text, String channel, String clientId) { backend.queueDiagnostic("glasses." + kind, "error", "glasses bridge error"); }
            @Override public void onGlassAudioPcm(byte[] pcm) {
                if (backend != null && inputMode == RabiConversationSettings.InputMode.GLASSES) {
                    backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_GLASSES);
                }
            }
            @Override public void onGlassReviewRequested() { backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassVideoH264(byte[] bytes) {
                com.rabi.link.modules.rokid.RabiDirectVideoSender sender = directVideo;
                if (sender != null) sender.sendH264(bytes);
            }
            @Override public void onGlassVideoState(String state) { updateRuntime("video", state); }
        }, values.getString("native_voice_access_key", ""), values.getString("native_voice_secret_key", ""));
        if (glassBridge != null) {
            glassBridge.start();
        } else {
            updateRuntime("glasses-bridge", "手机精简包未加载可选 Rokid Phone SDK；RabiPC 语音主链不受影响");
        }
        glassController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override public void onLog(String line) { }
            @Override public void onCxrConnectionChanged(boolean connected) {
                updateRuntime("glasses", connected ? "眼镜 CXR 已连接，等待蓝牙音频通道" : "眼镜模式不可用：CXR 未连接");
                updateStatus(connected ? "眼镜 CXR 已连接 · 等待蓝牙音频通道" : "等待眼镜 CXR 连接");
            }
            @Override public void onGlassBtConnectionChanged(boolean connected) {
                if (RabiConversationSettings.load(RabiConversationService.this).inputMode
                        != RabiConversationSettings.InputMode.GLASSES) return;
                if (connected) {
                    backend.beginAudioStream(RabiGlassPcBackend.SOURCE_GLASSES);
                    setInputMode(RabiConversationSettings.InputMode.GLASSES);
                    startDirectVideo();
                    updateRuntime("glasses", "眼镜已连接，可使用麦克风、HUD 和扬声器");
                    updateStatus("眼镜蓝牙已连接 · 眼镜模式持续聆听");
                } else {
                    if (directVideo != null) directVideo.stop("眼镜已断开，视频停止");
                    backend.pauseAudioStream();
                    setInputMode(RabiConversationSettings.InputMode.PAUSED);
                    updateRuntime("glasses", "眼镜模式不可用：蓝牙音频通道未连接；可切回手机模式");
                    updateStatus("眼镜已断开 · 采集保持暂停，可切回手机模式");
                }
            }
            @Override public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) { if (info != null && glassBridge != null) glassBridge.sendGlassDeviceState(info.batteryLevel, info.ischarging); }
            @Override public void onPhoto(byte[] data) { if (data != null && data.length > 0) backend.submitMediaFromSource(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片", RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassAppResult(String status, String summary, String error) { updateStatus("眼镜 App · " + shortText(status + " " + summary)); }
            @Override public void onNativeVoiceProtocol(String payload, String channel, String clientId) { if (glassBridge != null) glassBridge.handleIncomingProtocol(channel, payload, clientId); }
            @Override public void onAudioPcm(byte[] data, int offset, int length) {
                if (backend == null || inputMode != RabiConversationSettings.InputMode.GLASSES
                        || data == null || length <= 0) return;
                int safeOffset = Math.max(0, offset);
                int safeLength = Math.min(length, data.length - safeOffset);
                if (safeLength <= 0) return;
                byte[] chunk = new byte[safeLength];
                System.arraycopy(data, safeOffset, chunk, 0, safeLength);
                backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES);
            }
        });
        boolean connectionStarted = glassController.connectGlassAppSession(token.trim());
        if (!connectionStarted) {
            updateRuntime("glasses", "眼镜模式不可用：Rokid 连接请求未启动");
            updateStatus("眼镜连接未启动 · 请检查 Rokid AI App、配对和授权");
            stopGlassesBackend();
            return;
        }
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (glassController != null) { glassController.startGlassAsrApp(); glassController.getGlassDeviceInfo(); }
        }, 1500);
        updateStatus("眼镜后台正在连接");
    }

    private void stopGlassesBackend() {
        if (directVideo != null) {
            directVideo.dispose();
            directVideo = null;
        }
        if (glassController != null) {
            glassController.disconnect();
            glassController = null;
        }
        if (glassBridge != null) {
            glassBridge.stop();
            glassBridge = null;
        }
    }

    private boolean configureBackend() {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (!relay.getConfigured()) return false;
        backend.configure(relay.getBaseUrl(), relay.getToken(), RabiMobileDeviceIdentity.load(this));
        backend.reloadSettings();
        return true;
    }

    private void startDirectVideo() {
        if (!BuildConfig.ROKID_VIDEO || shutdownComplete || networkKnownOffline || glassBridge == null || backend == null
                || inputMode != RabiConversationSettings.InputMode.GLASSES
                || !RabiConversationSettings.directVideoEnabled(this)) return;
        if (directVideo == null) {
            directVideo = new com.rabi.link.modules.rokid.RabiDirectVideoSender(this,
                    new com.rabi.link.modules.rokid.RabiDirectVideoSender.Listener() {
                        @Override public org.json.JSONObject exchangeOffer(String sdp) {
                            try { return backend.exchangeVideoOffer(sdp); }
                            catch (Exception error) { throw new IllegalStateException("Video signalling failed", error); }
                        }
                        @Override public void onReady() {
                            if (glassBridge != null && inputMode == RabiConversationSettings.InputMode.GLASSES
                                    && RabiConversationSettings.directVideoEnabled(RabiConversationService.this)) {
                                updateRuntime("video", "手机与电脑已直连，正在启动眼镜视频");
                                glassBridge.startVideoStream(15, 2_000_000);
                            }
                        }
                        @Override public void onStopped(String reason) {
                            if (glassBridge != null) glassBridge.stopVideoStream();
                            updateRuntime("video", reason);
                        }
                    });
        }
        directVideo.start();
    }

    private void enqueueMedia(Uri uri, String contentType, String routeProfileId, String clientMessageId) {
        if (uri == null) { updateStatus("媒体选择无效"); return; }
        try {
            String fileName = "phone-media-" + System.currentTimeMillis();
            try (android.database.Cursor cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) fileName = cursor.getString(0);
            }
            byte[] data;
            try (InputStream input = getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input == null) throw new IllegalStateException("无法读取媒体");
                byte[] buffer = new byte[32768];
                int read;
                int total = 0;
                while ((read = input.read(buffer)) >= 0) {
                    total += read;
                    if (total > 64 * 1024 * 1024) throw new IllegalArgumentException("媒体超过 64 MiB");
                    output.write(buffer, 0, read);
                }
                data = output.toByteArray();
            }
            String stableRoute = routeProfileId == null ? "" : routeProfileId.trim();
            String stableClientMessageId = clientMessageId == null || clientMessageId.trim().isEmpty()
                    ? "phone-media-" + System.currentTimeMillis() + "-" + UUID.randomUUID() : clientMessageId.trim();
            String kind = contentType != null && contentType.startsWith("image/") ? "image"
                    : contentType != null && contentType.startsWith("video/") ? "video"
                    : contentType != null && contentType.startsWith("audio/") ? "audio-file" : "file";
            chatStore.append(stableClientMessageId, "user", kind, "", fileName, contentType, stableRoute, uri.toString(),
                    stableClientMessageId, "queued", "");
            backend.submitMedia(data, contentType, fileName, "手机发送的媒体消息", stableRoute, stableClientMessageId);
        } catch (Throwable error) {
            updateStatus("媒体导入失败 · " + error.getMessage());
        }
    }

    private void startPhoneCapture() {
        phoneAudioCapture.start();
    }

    private boolean playOnPhone(byte[] pcm) {
        synchronized (phonePlaybackLock) {
            if (pcm == null || pcm.length < 4) return false;
            phoneAudioCapture.setPlaybackSuppressed(true);
            int minimum = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioTrack track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(Math.max(minimum, pcm.length))
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();
            CountDownLatch completed = new CountDownLatch(1);
            AtomicBoolean markerReached = new AtomicBoolean(false);
            try {
                int markerFrames = phonePlaybackMarkerFrames(pcm.length);
                int trackState = track.getState();
                if (!phonePlaybackStateReadyForWrite(trackState)) return false;
                track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
                    @Override public void onMarkerReached(AudioTrack ignored) {
                        markerReached.set(true);
                        completed.countDown();
                    }
                    @Override public void onPeriodicNotification(AudioTrack ignored) { }
                }, new android.os.Handler(getMainLooper()));
                int written = track.write(pcm, 0, pcm.length);
                if (written != pcm.length) return false;
                int markerResult = track.setNotificationMarkerPosition(markerFrames);
                if (markerResult != AudioTrack.SUCCESS) return false;
                track.play();
                long timeoutMs = Math.max(5000, (pcm.length * 1000L) / 32000L + 5000L);
                if (!completed.await(timeoutMs, TimeUnit.MILLISECONDS)) return false;
                return markerReached.get();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            } catch (Throwable ignored) {
                return false;
            } finally {
                try { track.stop(); } catch (Throwable ignored) { }
                track.release();
                phoneAudioCapture.setPlaybackSuppressed(false);
            }
        }
    }

    private void queueTtsReplay(String messageId, String localPath) {
        String safeId = messageId == null ? "" : messageId.trim();
        String safePath = localPath == null ? "" : localPath.trim();
        if (safeId.isEmpty() || safePath.isEmpty() || !pendingTtsReplayIds.add(safeId)) return;
        chatStore.updatePlayback(safeId, "queued", "");
        updateRuntime("ttsPlayback", "语音等待重播");
        new Thread(() -> {
            String failure = "";
            boolean played = false;
            try {
                chatStore.updatePlayback(safeId, "playing", "");
                updateRuntime("ttsPlayback", "正在重播夜雨语音");
                played = playOnPhone(readCachedTtsPcm(safePath));
                if (!played) failure = "手机未确认播放完成";
            } catch (Throwable error) {
                failure = replayFailure(error);
            } finally {
                pendingTtsReplayIds.remove(safeId);
                chatStore.updatePlayback(safeId, played ? "played" : "failed", failure);
                updateRuntime("ttsPlayback", played ? "语音重播完成" : "语音重播失败 · " + failure);
                // A foreground service must remain visible, but its transient replay
                // label must not get stuck after AudioTrack reaches its marker.
                notificationHandler.post(() -> promote("持续会话就绪", false));
            }
        }, "rabi-phone-tts-replay").start();
    }

    private byte[] readCachedTtsPcm(String localPath) throws IOException {
        File cacheRoot = new File(getFilesDir(), "rabi-conversation/audio-cache/tts-audio").getCanonicalFile();
        File file = new File(localPath).getCanonicalFile();
        if (!file.getParentFile().equals(cacheRoot)) throw new IOException("语音缓存位置无效");
        if (!file.isFile() || file.length() < 44L) throw new IOException("语音缓存已失效");
        if (file.length() > MAX_REPLAY_WAV_BYTES) throw new IOException("语音缓存过大");
        byte[] wav = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < wav.length) {
                int count = input.read(wav, offset, wav.length - offset);
                if (count < 0) throw new IOException("语音缓存读取不完整");
                offset += count;
            }
        }
        return pcmFromWav(wav);
    }

    static byte[] pcmFromWav(byte[] wav) throws IOException {
        if (wav == null || wav.length < 44 || wav[0] != 'R' || wav[1] != 'I' || wav[2] != 'F' || wav[3] != 'F'
                || wav[8] != 'W' || wav[9] != 'A' || wav[10] != 'V' || wav[11] != 'E') throw new IOException("不是 WAV 语音缓存");
        ByteBuffer values = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int offset = 12;
        int channels = 0, sampleRate = 0, bitsPerSample = 0, dataOffset = -1, dataSize = 0;
        while (offset + 8 <= wav.length) {
            int chunkSize = values.getInt(offset + 4);
            if (chunkSize < 0 || offset + 8L + chunkSize > wav.length) throw new IOException("WAV 数据损坏");
            boolean format = wav[offset] == 'f' && wav[offset + 1] == 'm' && wav[offset + 2] == 't' && wav[offset + 3] == ' ';
            boolean data = wav[offset] == 'd' && wav[offset + 1] == 'a' && wav[offset + 2] == 't' && wav[offset + 3] == 'a';
            if (format) {
                if (chunkSize < 16 || values.getShort(offset + 8) != 1) throw new IOException("WAV 编码不受支持");
                channels = values.getShort(offset + 10); sampleRate = values.getInt(offset + 12); bitsPerSample = values.getShort(offset + 22);
            } else if (data) { dataOffset = offset + 8; dataSize = chunkSize; break; }
            offset += 8 + chunkSize + (chunkSize & 1);
        }
        if (channels != 1 || sampleRate != 16000 || bitsPerSample != 16 || dataOffset < 0 || dataSize < 4) throw new IOException("语音格式不受支持");
        byte[] pcm = new byte[dataSize];
        System.arraycopy(wav, dataOffset, pcm, 0, dataSize);
        return pcm;
    }

    private static String replayFailure(Throwable error) {
        String message = error == null ? "未知错误" : error.getMessage();
        return message == null || message.trim().isEmpty() ? "未知错误" : shortText(message);
    }

    static int phonePlaybackMarkerFrames(int pcmByteCount) {
        return Math.max(1, (pcmByteCount / 2) - 1);
    }

    static boolean phonePlaybackStateReadyForWrite(int state) {
        return state == AudioTrack.STATE_INITIALIZED || state == AudioTrack.STATE_NO_STATIC_DATA;
    }

    private String persistTtsMessage(String text, String routeProfileId, byte[] pcm) {
        if (pcm == null || pcm.length == 0 || speechArchive == null) return "";
        try {
            speechArchive.cleanup();
            RabiConversationSettings settings = RabiConversationSettings.load(this);
            RabiBoundedAudioCache.Entry retained = speechArchive.retainTts(
                    pcm, text, "rabi-phone", routeProfileId, settings.ttsModel, settings.ttsVoice);
            return retained.file.getAbsolutePath();
        } catch (Throwable ignored) { return ""; }
    }

    private void updateStatus(String text) {
        android.content.SharedPreferences.Editor runtime = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                .putString("status", text)
                .putLong("updatedAt", System.currentTimeMillis());
        if (backend != null) runtime.putString("queue", backend.reliableQueueSummary());
        String normalized = text == null ? "" : text;
        if (normalized.contains("事件流已连接") || normalized.contains("消息连接已恢复") || normalized.contains("消息连接正常")) {
            runtime.putString("connection", "已连接 Rabi PC");
        } else if (normalized.contains("网络已断开")) {
            runtime.putString("connection", "网络离线，等待系统联网事件");
        } else if (normalized.contains("等待手机配置") || normalized.contains("等待配置")) {
            runtime.putString("connection", "RabiLink 尚未配置");
        } else if (normalized.startsWith("错误")) {
            runtime.putString("connection", "连接异常，可靠队列保留待重试");
        }
        runtime.apply();
        broadcastRuntimeUpdated();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(REVIEW_NOTIFICATION_ID, notification(text));
    }

    private void updateRuntime(String key, String value) {
        getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                .putString(key, value).putLong("updatedAt", System.currentTimeMillis()).apply();
        broadcastRuntimeUpdated();
    }

    private void broadcastRuntimeUpdated() {
        sendBroadcast(new Intent("com.rabi.link.conversation.RUNTIME_UPDATED").setPackage(getPackageName()));
    }

    private static String shortText(String text) {
        String value = text == null ? "" : text.replace('\n', ' ').trim();
        return value.length() > 80 ? value.substring(0, 80) : value;
    }

    private static String friendlyError(String message) {
        String value = message == null ? "连接失败" : message.trim();
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("unauthorized") || lower.contains("http 401")) return "RabiLink 登录已失效，请进入设置重新登录";
        return shortText(value);
    }

    private Notification notification(String text) {
        String persona = personaDisplayName();
        PendingIntent content = PendingIntent.getService(this, REVIEW_NOTIFICATION_ID,
                new Intent(this, RabiConversationService.class).setAction(ACTION_REVIEW),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, LISTENING_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon)
                .setContentTitle(voiceServiceActive ? persona + " 语音服务运行中" : persona + " 消息连接正常")
                .setContentText(voiceServiceActive ? "正在按当前模式持续采集语音" : "语音采集已关闭，消息仍可正常收发")
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .build();
    }

    private void showReviewShortcut() {
        postReviewShortcut();
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        notificationHandler.postDelayed(reviewNotificationRefresh, REVIEW_NOTIFICATION_REFRESH_MS);
    }

    private void postReviewShortcut() {
        PendingIntent action = PendingIntent.getService(this, REVIEW_NOTIFICATION_ID,
                new Intent(this, RabiConversationService.class).setAction(ACTION_REVIEW),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String persona = personaDisplayName();
        Notification value = new NotificationCompat.Builder(this, LISTENING_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon)
                .setContentTitle(voiceServiceActive ? persona + " 语音服务运行中" : persona + " 消息连接正常")
                .setContentText(voiceServiceActive ? "点一下立即让 " + persona + " 审阅当前会话" : "语音采集已关闭，消息仍可正常收发")
                .setContentIntent(action)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(REVIEW_NOTIFICATION_ID, value);
    }

    private String personaDisplayName() {
        return personaDisplayName(RabiConversationTarget.load(this));
    }

    private String personaDisplayName(String routeProfileId) {
        String id = routeProfileId == null ? "" : routeProfileId.trim();
        try {
            RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
            if (relay.getConfigured()) {
                for (com.rabiroute.sdk.RabiRouteInfo route : RabiRouteMetadataCache.INSTANCE.load(this, relay)) {
                    if (id.equals(route.getId())) {
                        String display = RabiConversationRules.INSTANCE.personaDisplayName(
                                route.getPersonaDisplayName(), route.getAgentRoleId(), route.getName(),
                                route.getConfigName(), route.getId());
                        if (display != null && !display.trim().isEmpty()) return display.trim();
                    }
                }
            }
        } catch (Throwable ignored) { }
        if (!id.isEmpty()) {
            String lower = id.toLowerCase(java.util.Locale.ROOT);
            if (lower.equals("yeyu") || lower.equals("night-rain") || lower.equals("night_rain") || id.contains("夜雨")) {
                return "夜雨";
            }
        }
        return "Rabi";
    }

    private void showAgentMessage(String messageId, String routeProfileId, String text) {
        Intent destination = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId);
        String conversationKey = routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim();
        String persona = personaDisplayName(conversationKey);
        int requestCode = conversationNotificationId(conversationKey);
        PendingIntent content = PendingIntent.getActivity(this, requestCode, destination,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification value = new NotificationCompat.Builder(this, MESSAGE_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle(persona + " · 新消息")
                .setContentText(shortText(text)).setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setGroup("rabi-conversation:" + conversationKey)
                .setContentIntent(content).setAutoCancel(true).build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(conversationNotificationId(conversationKey), value);
    }

    public static void clearConversationNotification(Context context, String routeProfileId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(conversationNotificationId(routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim()));
    }

    private static int conversationNotificationId(String conversationKey) {
        return 7500 + Math.abs(conversationKey.hashCode() % 20000);
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Rabi 持续会话", NotificationManager.IMPORTANCE_DEFAULT));
            manager.createNotificationChannel(new NotificationChannel(MESSAGE_CHANNEL, "Rabi 消息", NotificationManager.IMPORTANCE_DEFAULT));
            manager.createNotificationChannel(new NotificationChannel(LISTENING_CHANNEL, "夜雨在听", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private void shutdown(boolean explicitStop) {
        if (shutdownComplete) return;
        shutdownComplete = true;
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        unregisterNetworkEvents();
        RabiAudioShutdownSequence.run(
                () -> { if (phoneAudioCapture != null) phoneAudioCapture.close(explicitStop); },
                this::stopGlassesBackend,
                () -> { if (backend != null) backend.stop(); });
        inputMode = RabiConversationSettings.InputMode.PAUSED;
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) { manager.cancel(NOTIFICATION_ID); manager.cancel(REVIEW_NOTIFICATION_ID); }
        if (explicitStop) stopSelf();
    }

    @Override public void onDestroy() {
        RabiConversationSettings.videoPreferences(this).unregisterOnSharedPreferenceChangeListener(videoSettingsListener);
        shutdown(false);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
