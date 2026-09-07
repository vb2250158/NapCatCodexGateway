package com.rabi.link;

import android.content.Context;
import android.content.SharedPreferences;

/** Phone-owned settings shared by standalone-phone and optional-glasses conversation modes. */
public final class RabiConversationSettings {
    private static final String PREFS = "rabi_conversation_settings";
    private static final String KEY_INPUT_MODE = "inputMode";
    static final String KEY_DIRECT_VIDEO = "directVideoEnabled";

    static SharedPreferences videoPreferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean directVideoEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_DIRECT_VIDEO, false);
    }

    public static void setDirectVideoEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_DIRECT_VIDEO, enabled).apply();
    }
    private static final String KEY_PROACTIVITY_PREFERENCE = "proactivityPreference";
    private static final String KEY_AUTO_START_VOICE_SERVICE = "autoStartVoiceService";
    private static final String KEY_AUDIO_RETENTION_HOURS = "audioRetentionHours";
    private static final String KEY_AUDIO_MAX_STORAGE_MB = "audioMaxStorageMb";
    private static final String KEY_AUDIO_RESERVE_FREE_MB = "audioReserveFreeMb";

    public enum InputMode {
        PAUSED,
        PHONE,
        GLASSES;

        public static InputMode fromPersisted(String value, InputMode fallback) {
            try {
                return InputMode.valueOf(value == null ? "" : value.trim().toUpperCase(java.util.Locale.ROOT));
            } catch (IllegalArgumentException error) {
                return fallback;
            }
        }
    }

    public enum ProactivityPreference {
        AGENT_DECIDES("agent_decides"),
        QUIET("quiet"),
        BALANCED("balanced"),
        PROACTIVE("proactive");

        public final String wireValue;

        ProactivityPreference(String wireValue) {
            this.wireValue = wireValue;
        }

        public static ProactivityPreference fromPersisted(String value) {
            String normalized = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
            for (ProactivityPreference candidate : values()) {
                if (candidate.wireValue.equals(normalized)) return candidate;
            }
            return AGENT_DECIDES;
        }
    }

    public final InputMode inputMode;
    public final ProactivityPreference proactivityPreference;
    public final boolean autoStartVoiceService;
    public final boolean continuousListening;
    public final boolean glassesEnabled;
    public final boolean autoPlayAgentVoice;
    public final String ttsModel;
    public final String ttsVoice;
    public final int audioRetentionHours;
    public final int audioMaxStorageMb;
    public final int audioReserveFreeMb;

    public RabiConversationSettings(
            InputMode inputMode,
            ProactivityPreference proactivityPreference,
            boolean autoStartVoiceService,
            boolean autoPlayAgentVoice,
            String ttsModel,
            String ttsVoice
    ) {
        this(inputMode, proactivityPreference, autoStartVoiceService, autoPlayAgentVoice,
                ttsModel, ttsVoice, 6, 8192, 1024);
    }

    public RabiConversationSettings(
            InputMode inputMode,
            ProactivityPreference proactivityPreference,
            boolean autoStartVoiceService,
            boolean autoPlayAgentVoice,
            String ttsModel,
            String ttsVoice,
            int audioRetentionHours,
            int audioMaxStorageMb,
            int audioReserveFreeMb
    ) {
        this.inputMode = inputMode == null ? InputMode.PHONE : inputMode;
        this.proactivityPreference = proactivityPreference == null
                ? ProactivityPreference.AGENT_DECIDES : proactivityPreference;
        this.autoStartVoiceService = autoStartVoiceService;
        this.continuousListening = autoStartVoiceService && this.inputMode != InputMode.PAUSED;
        this.glassesEnabled = this.inputMode == InputMode.GLASSES;
        this.autoPlayAgentVoice = autoPlayAgentVoice;
        this.ttsModel = clean(ttsModel, "local-tts/gpt-sovits");
        this.ttsVoice = clean(ttsVoice, "Rabi");
        this.audioRetentionHours = clamp(audioRetentionHours, 0, 168);
        this.audioMaxStorageMb = clamp(audioMaxStorageMb, 1024, 65536);
        this.audioReserveFreeMb = clamp(audioReserveFreeMb, 256, 16384);
    }

    public static RabiConversationSettings load(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        InputMode legacyMode = !values.getBoolean("continuousListening", true)
                ? InputMode.PAUSED
                : values.getBoolean("glassesEnabled", false) ? InputMode.GLASSES : InputMode.PHONE;
        InputMode inputMode = InputMode.fromPersisted(values.getString(KEY_INPUT_MODE, ""), legacyMode);
        boolean autoStartVoiceService = values.contains(KEY_AUTO_START_VOICE_SERVICE)
                ? values.getBoolean(KEY_AUTO_START_VOICE_SERVICE, true)
                : inputMode != InputMode.PAUSED;
        return new RabiConversationSettings(
                inputMode,
                ProactivityPreference.fromPersisted(values.getString(KEY_PROACTIVITY_PREFERENCE, "agent_decides")),
                autoStartVoiceService,
                values.getBoolean("autoPlayAgentVoice", true),
                values.getString("ttsModel", "local-tts/gpt-sovits"),
                values.getString("ttsVoice", "Rabi"),
                values.getInt(KEY_AUDIO_RETENTION_HOURS, 6),
                values.getInt(KEY_AUDIO_MAX_STORAGE_MB, 8192),
                values.getInt(KEY_AUDIO_RESERVE_FREE_MB, 1024)
        );
    }

    public void save(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_INPUT_MODE, inputMode.name())
                .putString(KEY_PROACTIVITY_PREFERENCE, proactivityPreference.wireValue)
                .putBoolean(KEY_AUTO_START_VOICE_SERVICE, autoStartVoiceService)
                .putBoolean("autoPlayAgentVoice", autoPlayAgentVoice)
                .putString("ttsModel", ttsModel)
                .putString("ttsVoice", ttsVoice)
                .putInt(KEY_AUDIO_RETENTION_HOURS, audioRetentionHours)
                .putInt(KEY_AUDIO_MAX_STORAGE_MB, audioMaxStorageMb)
                .putInt(KEY_AUDIO_RESERVE_FREE_MB, audioReserveFreeMb)
                .remove("asrModel")
                .remove("asrLanguage")
                .remove("vadThreshold")
                .remove("silenceMs")
                .remove("continuousListening")
                .remove("glassesEnabled")
                .apply();
    }

    private static String clean(String value, String fallback) {
        String result = value == null ? "" : value.trim();
        return result.isEmpty() ? fallback : result;
    }

    static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
