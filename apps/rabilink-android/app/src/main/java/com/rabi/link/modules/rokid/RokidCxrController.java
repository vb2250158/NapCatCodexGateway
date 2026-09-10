package com.rabi.link.modules.rokid;

import android.content.Context;

import com.rokid.cxr.Caps;
import com.rokid.cxr.link.CXRLink;
import com.rokid.cxr.link.callbacks.ICXRSessionCbk;
import com.rokid.cxr.link.callbacks.ICustomCmdCbk;
import com.rokid.cxr.link.callbacks.IGlassAppCbk;
import com.rokid.cxr.link.utils.CxrDefs;
import com.rokid.cxr.link.utils.GlassInfo;


public final class RokidCxrController {
    static final String GLASS_ASR_PACKAGE = "com.rabi.link.glass";
    static final String GLASS_ASR_ENTRY = GLASS_ASR_PACKAGE + ".GlassAudioClientActivity";
    static final String NATIVE_VOICE_CLIENT_KEY = "rabi_native_voice_client";
    static final String NATIVE_VOICE_REPLY_KEY = "rabi_native_voice_reply";

    public interface Listener {
        void onLog(String line);

        void onCxrConnectionChanged(boolean connected);

        void onGlassBtConnectionChanged(boolean connected);

        void onGlassDeviceInfo(GlassInfo info);

        void onPhoto(byte[] data);

        void onGlassAppResult(String status, String summary, String error);

        void onNativeVoiceProtocol(String payload, String channel, String clientId);

        void onAudioPcm(byte[] data, int offset, int length);
    }

    private final CXRLink cxrLink;
    private final Listener listener;
    private final RokidCxrLinkState linkState = new RokidCxrLinkState();
    private final RokidAudioCapture audioCapture = new RokidAudioCapture();
    private String sessionType = "";
    private final String targetPackage;

    public RokidCxrController(Context context, Listener listener) {
        this(context, listener, GLASS_ASR_PACKAGE);
    }

    RokidCxrController(Context context, Listener listener, String targetPackage) {
        this.targetPackage = targetPackage;
        this.cxrLink = new CXRLink(context.getApplicationContext());
        this.listener = listener;
        RokidCxrCallbacks.install(cxrLink, linkState, audioCapture, listener);
        installCustomCmdCallback();
    }

    public void disconnect() {
        cxrLink.disconnect();
    }

    boolean isCxrConnected() {
        return linkState.isCxrConnected();
    }

    boolean isGlassBtConnected() {
        return linkState.isGlassBtConnected();
    }

    boolean isLinkReady() {
        return linkState.isLinkReady();
    }

    boolean isCustomViewOpened() {
        return linkState.isCustomViewOpened();
    }

    boolean isCustomViewSession() {
        return "CUSTOMVIEW".equals(sessionType);
    }

    boolean isCustomAppSession() {
        return "CUSTOMAPP".equals(sessionType);
    }

    Object getSessionState() {
        return cxrLink.getCXRSessionState();
    }

    int getAudioBytes() {
        return audioCapture.bytes();
    }

    byte[] copyAudioPcm() {
        return audioCapture.copyPcm();
    }

    boolean connectCustomViewSession(String token) {
        prepareSessionSwitch();
        boolean configured = cxrLink.configCXRSession(
                new CxrDefs.CXRSession(CxrDefs.CXRSessionType.CUSTOMVIEW),
                new ICXRSessionCbk() {
                    @Override
                    public void onSessionAvailable(CxrDefs.CXRSessionReason reason) {
                        log("onSessionAvailable reason=" + reason);
                    }

                    @Override
                    public void onSessionStart(CxrDefs.CXRSessionReason reason) {
                        log("onSessionStart reason=" + reason);
                    }

                    @Override
                    public void onSessionPause(CxrDefs.CXRSessionReason reason) {
                        log("onSessionPause reason=" + reason);
                    }

                    @Override
                    public void onSessionUnavailable(CxrDefs.CXRSessionReason reason) {
                        log("onSessionUnavailable reason=" + reason);
                    }
                }
        );
        log("configCXRSession CUSTOMVIEW=" + configured);
        sessionType = "CUSTOMVIEW";
        boolean connected = cxrLink.connect(token);
        log("connect=" + connected);
        return connected;
    }

    boolean connectStatusOnly(String token) {
        prepareSessionSwitch();
        sessionType = "STATUS";
        boolean connected = cxrLink.connect(token);
        log("connectStatusOnly=" + connected);
        return connected;
    }

    public boolean connectGlassAppSession(String token) {
        prepareSessionSwitch();
        boolean configured = cxrLink.configCXRSession(
                new CxrDefs.CXRSession(CxrDefs.CXRSessionType.CUSTOMAPP, targetPackage),
                new ICXRSessionCbk() {
                    @Override
                    public void onSessionAvailable(CxrDefs.CXRSessionReason reason) {
                        log("onGlassAppSessionAvailable reason=" + reason);
                    }

                    @Override
                    public void onSessionStart(CxrDefs.CXRSessionReason reason) {
                        log("onGlassAppSessionStart reason=" + reason);
                    }

                    @Override
                    public void onSessionPause(CxrDefs.CXRSessionReason reason) {
                        log("onGlassAppSessionPause reason=" + reason);
                    }

                    @Override
                    public void onSessionUnavailable(CxrDefs.CXRSessionReason reason) {
                        log("onGlassAppSessionUnavailable reason=" + reason);
                    }
                }
        );
        log("configCXRSession CUSTOMAPP package=" + targetPackage + " result=" + configured);
        sessionType = "CUSTOMAPP";
        boolean connected = cxrLink.connect(token);
        log("connectGlassAppSession=" + connected);
        return connected;
    }

    void queryGlassAsrApp() {
        log("appIsInstalled target=" + GLASS_ASR_PACKAGE);
        cxrLink.appIsInstalled(glassAppCallback());
    }

    void installGlassAsrApp(String apkPath) {
        log("appUploadAndInstall target=" + targetPackage);
        cxrLink.appUploadAndInstall(apkPath, glassAppCallback());
    }

    public void startGlassAsrApp() {
        closeCustomViewBeforeGlassAppStart();
        log("appStart entry=" + GLASS_ASR_ENTRY);
        cxrLink.appStart(GLASS_ASR_ENTRY, glassAppCallback());
    }

    public void startGlassVideoApp() {
        closeCustomViewBeforeGlassAppStart();
        cxrLink.appStart(targetPackage + ".GlassVideoActivity", glassAppCallback());
    }

    boolean sendVideoCommand(String payload) {
        Caps caps = new Caps(); caps.write("protocol"); caps.write(payload);
        Integer result = cxrLink.sendCustomCmd(com.rabi.link.protocol.RabiGlassVideoProtocol.CHANNEL, caps);
        return result != null && result == 0;
    }

    void stopGlassAsrApp() {
        log("appStop target=" + GLASS_ASR_PACKAGE);
        cxrLink.appStop(glassAppCallback());
    }

    boolean sendNativeVoiceCustomCmd(String payload) {
        Caps caps = new Caps();
        caps.write("protocol");
        caps.write(payload);
        Integer result = cxrLink.sendCustomCmd(NATIVE_VOICE_CLIENT_KEY, caps);
        log("sendCustomCmd key=" + NATIVE_VOICE_CLIENT_KEY + " result=" + result + " payload=" + redactedProtocol(payload));
        return result != null && result == 0;
    }

    public void getGlassDeviceInfo() {
        cxrLink.getGlassDeviceInfo();
        log("已请求 getGlassDeviceInfo。链路状态 " + linkState.summary());
    }

    boolean setBrightnessAndVolume(int brightnessValue, int volumeValue) {
        boolean brightness = cxrLink.setGlassBrightness(brightnessValue);
        boolean volume = cxrLink.setGlassVolume(volumeValue);
        log("setGlassBrightness(" + brightnessValue + ")=" + brightness);
        log("setGlassVolume(" + volumeValue + ")=" + volume);
        return brightness && volume;
    }

    boolean openHelloCustomView() {
        boolean opened = cxrLink.customViewOpen(RokidProbeText.customViewBoxPayload(
                RokidProbeDefaults.CUSTOM_VIEW_HELLO_MESSAGE
        ));
        log("customViewOpen=" + opened);
        return opened;
    }

    boolean updateHelloCustomView() {
        boolean updated = cxrLink.customViewUpdate(RokidProbeText.customViewPayload(
                RokidProbeDefaults.CUSTOM_VIEW_TITLE,
                RokidProbeDefaults.updatedCustomViewMessage()
        ));
        log("customViewUpdate=" + updated);
        return updated;
    }

    boolean closeCustomView() {
        boolean closed = cxrLink.customViewClose();
        log("customViewClose=" + closed);
        return closed;
    }

    boolean startAudioStream() {
        audioCapture.reset();
        RokidCxrCallbacks.installAudioCallback(cxrLink, audioCapture, listener);
        log("setCXRAudioCbk refreshed before startAudioStream");
        boolean started = cxrLink.startAudioStream(RokidProbeDefaults.AUDIO_STREAM_MODE);
        log("startAudioStream(" + RokidProbeDefaults.AUDIO_STREAM_MODE + ")=" + started);
        return started;
    }

    void disableDiagnosticAudioBuffer() { audioCapture.setRetainPcm(false); }

    boolean stopAudioStream() {
        boolean stopped = cxrLink.stopAudioStream();
        log("stopAudioStream=" + stopped + " totalBytes=" + getAudioBytes());
        return stopped;
    }

    boolean takePhoto() {
        boolean requested = cxrLink.takePhoto(
                RokidProbeDefaults.PHOTO_WIDTH,
                RokidProbeDefaults.PHOTO_HEIGHT,
                RokidProbeDefaults.PHOTO_JPEG_QUALITY
        );
        log("takePhoto(" + RokidProbeDefaults.PHOTO_WIDTH + "," + RokidProbeDefaults.PHOTO_HEIGHT + "," + RokidProbeDefaults.PHOTO_JPEG_QUALITY + ")=" + requested);
        return requested;
    }

    private void prepareSessionSwitch() {
        try {
            cxrLink.disconnect();
        } catch (Throwable error) {
            log("disconnect before session switch failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        audioCapture.reset();
        linkState.reset();
    }

    private void closeCustomViewBeforeGlassAppStart() {
        if (!isCustomViewOpened()) {
            return;
        }
        try {
            boolean closed = cxrLink.customViewClose();
            log("customViewClose before appStart=" + closed);
        } catch (Throwable error) {
            log("customViewClose before appStart failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private IGlassAppCbk glassAppCallback() {
        return new IGlassAppCbk() {
            @Override
            public void onInstallAppResult(boolean success) {
                glassAppResult(success ? "ok" : "failed", "onInstallAppResult=" + success, "");
            }

            @Override
            public void onUnInstallAppResult(boolean success) {
                glassAppResult(success ? "ok" : "failed", "onUnInstallAppResult=" + success, "");
            }

            @Override
            public void onOpenAppResult(boolean success) {
                glassAppResult(success ? "started" : "failed", "onOpenAppResult=" + success, "");
            }

            @Override
            public void onStopAppResult(boolean success) {
                glassAppResult(success ? "ok" : "failed", "onStopAppResult=" + success, "");
            }

            @Override
            public void onGlassAppResume(boolean resumed) {
                glassAppResult(resumed ? "started" : "ok", "onGlassAppResume=" + resumed, "");
            }

            @Override
            public void onQueryAppResult(boolean installed) {
                glassAppResult(installed ? "ok" : "partial", "onQueryAppResult installed=" + installed, installed ? "" : "眼镜端应用尚未安装");
            }
        };
    }

    private void installCustomCmdCallback() {
        cxrLink.setCXRCustomCmdCbk(new ICustomCmdCbk() {
            @Override
            public void onCustomCmdResult(String key, byte[] payload) {
                if (!NATIVE_VOICE_REPLY_KEY.equals(key) && !com.rabi.link.protocol.RabiGlassVideoProtocol.REPLY.equals(key)) {
                    log("ignore custom cmd key=" + key + " bytes=" + (payload == null ? 0 : payload.length));
                    return;
                }
                String protocol = protocolFromCaps(payload);
                log("custom cmd result key=" + key + " protocol=" + redactedProtocol(protocol));
                if (!protocol.isEmpty()) {
                    listener.onNativeVoiceProtocol(protocol, "CXRCustomCmd", key);
                }
            }
        });
        log("CXR custom cmd callback registered key=" + NATIVE_VOICE_REPLY_KEY);
    }

    private String protocolFromCaps(byte[] payload) {
        if (payload == null || payload.length == 0) {
            return "";
        }
        try {
            Caps caps = Caps.fromBytes(payload);
            if (caps == null) {
                return "";
            }
            for (int i = 0; i < caps.size(); i++) {
                Caps.Value value = caps.at(i);
                if (value != null && value.type() == Caps.Value.TYPE_STRING) {
                    String text = value.getString();
                    if (text != null && text.startsWith("RABI_")) {
                        return text;
                    }
                }
            }
            return caps.toString();
        } catch (Throwable error) {
            log("parse custom cmd caps failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return "";
        }
    }

    private static String redactedProtocol(String protocol) {
        if (protocol == null) {
            return "";
        }
        if (protocol.startsWith("RABI_GLASS_ROKID_AI_CONFIG_B64:")) {
            return "RABI_GLASS_ROKID_AI_CONFIG_B64:<redacted>";
        }
        return protocol;
    }

    private void glassAppResult(String status, String summary, String error) {
        log(summary + (error == null || error.isEmpty() ? "" : " error=" + error));
        listener.onGlassAppResult(status, summary, error);
    }

    private void log(String line) {
        listener.onLog(line);
    }
}
