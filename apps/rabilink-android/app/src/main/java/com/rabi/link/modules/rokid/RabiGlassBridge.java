package com.rabi.link.modules.rokid;

/**
 * Stable, dependency-free boundary used by the resident conversation service.
 *
 * <p>The full Rokid Phone SDK implementation is optional in the mobile-slim
 * build. Keeping the foreground service typed to this interface prevents
 * missing diagnostic SDK classes from breaking normal phone PCM streaming.</p>
 */
public interface RabiGlassBridge {
    interface Listener {
        void onNativeVoiceLog(String line);

        void onNativeAsrText(String text, String channel, String clientId);

        void onNativeTtsAck(String text, String channel, String clientId);

        void onNativeCommandAck(String kind, String text, String channel, String clientId);

        void onNativeStatus(String text, String channel, String clientId);

        void onNativeVoiceError(String kind, String text, String channel, String clientId);

        void onGlassAudioPcm(byte[] pcm);

        void onGlassReviewRequested();

        default void onGlassVideoH264(byte[] bytes) {}

        default void onGlassVideoState(String state) {}
    }

    void start();

    void stop();

    void startVideoStream(int fps, int bitrate);

    void stopVideoStream();

    boolean sendAudioPcmToGlass(String messageId, byte[] pcm);

    void sendGlassAudioStatus(String status);

    void sendGlassTranscript(String text);

    void sendGlassReplyText(String text);

    void sendGlassDeviceState(int batteryLevel, boolean charging);

    void handleIncomingProtocol(String channel, String message, String clientId);
}
