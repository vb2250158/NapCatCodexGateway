package com.rabi.link.modules.rokid

import android.content.Context
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pGroup
import android.net.wifi.p2p.WifiP2pInfo
import android.os.Handler
import android.os.Looper
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.rabi.link.protocol.RabiGlassAudioProtocol
import com.rokid.security.phone.sdk.api.PSecuritySDK
import com.rokid.security.phone.sdk.api.bluetooth.classic.listener.IClassicBTClientListener
import com.rokid.security.phone.sdk.api.msg.listener.IMessageListener
import com.rokid.security.phone.sdk.api.wifip2p.listener.IWifiP2PClientListener
import com.rokid.security.phone.sdk.base.data.DeviceInfo
import com.rokid.security.phone.sdk.base.data.EngineParam
import com.rokid.security.phone.sdk.base.data.EnvType
import com.rokid.security.phone.sdk.base.data.NetServiceType
import com.rokid.security.phone.sdk.base.data.UserAuthInfo
import com.rokid.security.phone.sdk.base.utils.log.L
import com.rokid.security.phone.sdk.base.utils.net.SecuritySDKEnv
import com.rokid.security.phone.core.ability.asr.AsrConnectClient
import com.rokid.security.phone.core.ability.asr.AsrEngine
import com.rokid.security.phone.core.ability.bean.BaseConfig
import com.rokid.security.phone.core.ability.tts.TtsConnectClient
import com.rokid.security.phone.core.ability.tts.TtsEngine
import com.rokid.security.phone.sdk.server.UrlConfig
import com.rokid.security.phone.sdk.server.usercenter.UserManager
import com.rokid.security.sdk.base.common.GlassVideoStreamParam
import com.rokid.security.sdk.base.common.out.GlassDeviceInfo
import java.nio.ByteBuffer
import java.time.Duration
import java.time.Instant
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

final class RokidNativeVoiceBridge(
    context: Context,
    private val listener: RabiGlassBridge.Listener,
    initialAccessKey: String,
    initialSecretKey: String
) : RabiGlassBridge {

    private val appContext = context.applicationContext
    private var listenerRegistered = false
    private var sdkInitRequested = false
    private var accessKey: String = initialAccessKey.trim()
    private var secretKey: String = initialSecretKey.trim()
    @Volatile private var phoneVoiceProbeInitialized = false
    @Volatile private var phoneAsrFeeding = false
    private var phoneAsrBytes = 0
    private var phoneAsrLastLoggedBytes = 0
    private var phoneTtsBytes = 0
    private var lastPhoneTtsText = ""
    private val glassAudioLock = Any()
    @Volatile private var glassAudioCapturing = false
    @Volatile private var lastGlassReviewAt = 0L
    private val glassPlaybackLock = Any()
    private var pendingGlassPlaybackId = ""
    private var pendingGlassPlaybackState = ""
    private var pendingGlassPlaybackLatch: CountDownLatch? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var videoStreamActive = false
    private var videoRequestPending = false
    private var videoFps = 15
    private var videoBitrate = 2_000_000
    private var videoStreamGeneration = 0
    private var lastVideoAt = 0L
    @Volatile private var phoneDeviceAudioHandshakeGeneration = 0
    @Volatile private var phoneDeviceVideoAudioHandshakeGeneration = 0
    @Volatile private var phoneDeviceVideoAudioHandshakeActive = false
    @Volatile private var phoneDeviceVideoSeen = false
    @Volatile private var phoneDeviceAudioSeen = false
    @Volatile private var phoneDeviceAudioRequestedAfterVideo = false
    @Volatile private var phoneBtScanGeneration = 0
    @Volatile private var phoneBtScanFoundCount = 0
    @Volatile private var phoneBtAutoConnectGeneration = 0
    @Volatile private var phoneBtAutoConnectRequested = false
    private var phoneBtScanListenerRegistered = false
    @Volatile private var phoneP2pProbeGeneration = 0

    @Volatile private var phoneP2pPeerCount = 0
    @Volatile private var phoneP2pMatchedPeer: WifiP2pDevice? = null
    private var phoneP2pListenerRegistered = false

    data class PhoneVoiceAuthProbe(
        val configured: Boolean,
        val sdkHasAppAuthorization: Boolean,
        val xUserAuthorizationPresent: Boolean,
        val xUserAuthorizationLength: Int,
        val xAppAuthorizationPresent: Boolean,
        val xAppAuthorizationLength: Int,
        val appCredentialPresent: Boolean,
        val appCredentialLength: Int,
        val userCredentialPresent: Boolean,
        val userCredentialLength: Int,
        val glassDeviceInfoPresent: Boolean,
        val glassDeviceIdPresent: Boolean
    ) {
        val readyForOnlineVoice: Boolean
            get() = configured && sdkHasAppAuthorization && xAppAuthorizationPresent

        fun summary(): String {
            return "configured=$configured sdkAppAuth=$sdkHasAppAuthorization " +
                "xUser=${xUserAuthorizationPresent}/${xUserAuthorizationLength} " +
                "xApp=${xAppAuthorizationPresent}/${xAppAuthorizationLength} " +
                "appCredential=${appCredentialPresent}/${appCredentialLength} " +
                "userCredential=${userCredentialPresent}/${userCredentialLength} " +
                "glassDeviceInfo=$glassDeviceInfoPresent glassDeviceId=$glassDeviceIdPresent " +
                "ready=$readyForOnlineVoice"
        }
    }

    data class PhoneGlassDeviceInfoProbe(
        val present: Boolean,
        val deviceIdPresent: Boolean,
        val deviceIdLength: Int,
        val deviceTypePresent: Boolean,
        val deviceSubTypePresent: Boolean,
        val btMacPresent: Boolean,
        val wifiMacPresent: Boolean,
        val p2pMacPresent: Boolean,
        val osVersionPresent: Boolean
    ) {
        val readyForAppToken: Boolean
            get() = present && deviceIdPresent

        fun summary(): String {
            return "present=$present deviceId=${deviceIdPresent}/${deviceIdLength} " +
                "deviceType=$deviceTypePresent deviceSubType=$deviceSubTypePresent " +
                "btMac=$btMacPresent wifiMac=$wifiMacPresent p2pMac=$p2pMacPresent " +
                "osVersion=$osVersionPresent readyForAppToken=$readyForAppToken"
        }
    }

    data class PhoneBtAuthProbe(
        val sdkInitialized: Boolean,
        val classicServicePresent: Boolean,
        val classicConnected: Boolean,
        val messageChannelConnected: Boolean,
        val audioChannelConnected: Boolean,
        val fileChannelConnected: Boolean,
        val streamChannelConnected: Boolean,
        val deviceAuthenticated: Boolean
    ) {
        val readyForDeviceMessages: Boolean
            get() = classicServicePresent && classicConnected && messageChannelConnected && deviceAuthenticated

        val readyForAudioPlayback: Boolean
            get() = readyForDeviceMessages && audioChannelConnected

        fun summary(): String {
            return "sdkInit=$sdkInitialized classicService=$classicServicePresent " +
                "classicConnected=$classicConnected message=$messageChannelConnected " +
                "audio=$audioChannelConnected file=$fileChannelConnected stream=$streamChannelConnected " +
                "deviceAuth=$deviceAuthenticated readyForDeviceMessages=$readyForDeviceMessages " +
                    "readyForAudioPlayback=$readyForAudioPlayback"
        }
    }

    data class PhoneP2pProbe(
        val servicePresent: Boolean,
        val connected: Boolean?,
        val peerCount: Int,
        val matchedPeerPresent: Boolean
    ) {
        val readyForDeviceMedia: Boolean
            get() = servicePresent && connected == true

        fun summary(): String {
            return "service=$servicePresent connected=$connected peers=$peerCount matchedPeer=$matchedPeerPresent readyForDeviceMedia=$readyForDeviceMedia"
        }
    }

    private val phoneAsrListener = object : AsrConnectClient.AsrListener {
        override fun onStart() {
            log("Phone SDK ASR listener onStart")
            listener.onNativeCommandAck("phone_asr_start", "started", PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }

        override fun onPartialResult(text: String?) {
            log("Phone SDK ASR partial=$text")
            listener.onNativeCommandAck("phone_asr_partial", text.orEmpty(), PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }

        override fun onFinalResult(text: String?) {
            log("Phone SDK ASR final=$text")
            listener.onNativeAsrText(text.orEmpty(), PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }

        override fun onError(code: Int, message: String?) {
            log("Phone SDK ASR error code=$code message=$message")
            listener.onNativeVoiceError("phone_asr", "$code:${message.orEmpty()}", PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }

        override fun onFinish() {
            log("Phone SDK ASR listener onFinish bytes=$phoneAsrBytes")
            listener.onNativeCommandAck("phone_asr_finish", "bytes=$phoneAsrBytes", PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }
    }

    private val phoneTtsListener = object : TtsConnectClient.TtsListener {
        override fun onAudioStreamResult(text: ByteArray?) {
            val size = text?.size ?: 0
            phoneTtsBytes += size
            if (phoneTtsBytes > 0 && phoneTtsBytes % PHONE_VOICE_LOG_STEP_BYTES < size) {
                log("Phone SDK TTS audio bytes=$phoneTtsBytes")
            }
        }

        override fun onStart() {
            log("Phone SDK TTS listener onStart text=$lastPhoneTtsText")
        }

        override fun onError(code: Int) {
            log("Phone SDK TTS error code=$code")
            listener.onNativeVoiceError("phone_tts", code.toString(), PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }

        override fun onFinish() {
            val summary = "$lastPhoneTtsText bytes=$phoneTtsBytes"
            log("Phone SDK TTS listener onFinish $summary")
            listener.onNativeTtsAck(summary, PHONE_SDK_CHANNEL, PHONE_SDK_CLIENT_ID)
        }
    }

    private val messageListener = object : IMessageListener {
        override fun onClassicBTTextMessage(msg: String, clientId: String) {
            super.onClassicBTTextMessage(msg, clientId)
            handleTextMessage("ClassicBT", msg, clientId)
        }

        override fun onP2PTextMessage(msg: String, clientId: String) {
            super.onP2PTextMessage(msg, clientId)
            handleTextMessage("P2P", msg, clientId)
        }

        override fun onBTStreamDataReceived(tag: String, data: ByteArray, clientId: String) {
            super.onBTStreamDataReceived(tag, data, clientId)
            log("Phone SDK 收到 BT stream tag=$tag bytes=${data.size} clientId=$clientId")
            if (tag == RabiGlassAudioProtocol.AUDIO_STREAM_TAG && glassAudioCapturing) {
                listener.onGlassAudioPcm(data)
            }
            if (tag == PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG) {
                handlePhoneDeviceVideoAudioAudio("onBTStreamDataReceived", data.size)
            }
        }

        override fun onNv21Data(data: ByteArray, width: Int, height: Int) {
            super.onNv21Data(data, width, height)
            handlePhoneDeviceVideoAudioVideo("onNv21Data", data.size, "${width}x$height")
        }

        override fun onVideoH264Stream(buffer: ByteBuffer) {
            super.onVideoH264Stream(buffer)
            if (videoStreamActive && buffer.hasRemaining()) {
                val copy = buffer.duplicate()
                if (copy.remaining() > 1024 * 1024) {
                    mainHandler.post { stopVideoStream(); listener.onGlassVideoState("视频帧超出传输上限") }
                } else {
                    val bytes = ByteArray(copy.remaining())
                    copy.get(bytes)
                    lastVideoAt = android.os.SystemClock.elapsedRealtime()
                    listener.onGlassVideoH264(bytes)
                }
            }
            handlePhoneDeviceVideoAudioVideo("onVideoH264Stream", buffer.remaining(), "h264")
        }

        override fun onAudioStream(buffer: ByteBuffer) {
            super.onAudioStream(buffer)
            handlePhoneDeviceVideoAudioAudio("onAudioStream", buffer.remaining())
        }

        override fun onClassicBTAudioStream(buffer: ByteArray) {
            super.onClassicBTAudioStream(buffer)
            handlePhoneDeviceVideoAudioAudio("onClassicBTAudioStream", buffer.size)
        }
    }

    private val phoneBtScanListener = object : IClassicBTClientListener {
        override fun onDeviceFound(device: BluetoothDevice) {
            phoneBtScanFoundCount++
            log("Phone SDK BT scan found ${describeBluetoothDevice(device)}")
            if (phoneBtAutoConnectGeneration > 0 && !phoneBtAutoConnectRequested && isLikelyRokidGlassDevice(device)) {
                phoneBtAutoConnectRequested = true
                log("Phone SDK device link scan candidate selected ${describeBluetoothDevice(device)}")
                val service = runCatching { PSecuritySDK.getClassicBlueToothClientService() }.getOrNull()
                if (service == null) {
                    log("Phone SDK device link scan connect skipped: ClassicBluetooth service is null")
                    return
                }
                runCatching { service.stopScan() }
                connectPhoneBtDevice(service, device, "scan", autoStartP2p = true)
            }
        }

        override fun onScanFinished() {
            phoneBtScanGeneration++
            log("Phone SDK BT scan finished found=$phoneBtScanFoundCount")
            if (phoneBtAutoConnectGeneration > 0 && !phoneBtAutoConnectRequested) {
                log("Phone SDK device link scan fallback to bonded candidates")
                phoneBtAutoConnectRequested = true
                connectPhoneBtBondedGlass(autoStartP2p = true)
            }
            probePhoneBtAuth(logResult = true)
        }

        override fun onConnect(success: Boolean) {
            log("Phone SDK BT client listener onConnect success=$success")
            probePhoneBtAuth(logResult = true)
            if (success) {
                mainHandler.postDelayed({
                    probePhoneGlassDeviceInfo(logResult = true)
                    probePhoneP2pConnection()
                }, PHONE_BT_CONNECT_PROBE_DELAY_MS)
            }
        }

        override fun onConnectionRejected(reason: String, code: Int) {
            log("Phone SDK BT connection rejected code=$code reason=$reason")
            probePhoneBtAuth(logResult = true)
        }
    }

    private val phoneP2pListener = object : IWifiP2PClientListener {
        override fun onWifiP2pEnabled(enabled: Boolean) {
            log("Phone SDK P2P listener onWifiP2pEnabled enabled=$enabled")
        }

        override fun onConnectionInfoAvailable(info: WifiP2pInfo) {
            log("Phone SDK P2P connection info groupFormed=${info.groupFormed} isGroupOwner=${info.isGroupOwner} ownerAddress=${info.groupOwnerAddress?.hostAddress.orEmpty()}")
            probePhoneP2p(logResult = true)
            if (info.groupFormed) mainHandler.post { requestPendingVideo() }
        }

        override fun onSelfDeviceAvailable(device: WifiP2pDevice) {
            log("Phone SDK P2P self device ${describeWifiP2pDevice(device)}")
        }

        override fun onPeersAvailable(devices: List<WifiP2pDevice>) {
            phoneP2pPeerCount = devices.size
            val targetName = currentLikelyRokidBluetoothName()
            val matched = devices.firstOrNull { device ->
                targetName.isNotBlank() && device.deviceName == targetName
            } ?: devices.firstOrNull { isLikelyRokidP2pName(it.deviceName.orEmpty()) }
            phoneP2pMatchedPeer = matched
            log(
                "Phone SDK P2P peers available total=${devices.size} targetName=${targetName.ifBlank { "<none>" }} " +
                    "matched=${matched != null} " +
                    devices.take(8).joinToString(prefix = "[", postfix = "]") { describeWifiP2pDevice(it) }
            )
        }
    }

    override fun start() {
        initPhoneSdk()
        registerMessageListener()
    }

    override fun stop() {
        stopVideoStream()
        synchronized(glassPlaybackLock) {
            if (pendingGlassPlaybackId.isNotEmpty() && pendingGlassPlaybackState.isEmpty()) {
                pendingGlassPlaybackState = "playback_failed"
                pendingGlassPlaybackLatch?.countDown()
            }
        }
        destroyPhoneVoiceProbe()
        destroyEngine()
    }

    fun updateUserAuth(accessKey: String, secretKey: String) {
        this.accessKey = accessKey.trim()
        this.secretKey = secretKey.trim()
        log("Phone SDK voice auth updated configured=${isUserAuthConfigured()}")
        destroyEngine()
        sdkInitRequested = false
        listenerRegistered = false
        start()
    }

    private fun destroyEngine() {
        runCatching {
            PSecuritySDK.getMessageService()?.removeMessageListener(messageListener)
            listenerRegistered = false
            log("Phone SDK message listener removed")
        }.onFailure {
            log("removeMessageListener failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        runCatching {
            PSecuritySDK.getMobileEngineService().destroy()
            log("Phone SDK mobile engine destroyed")
        }.onFailure {
            log("Phone SDK destroy failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    fun sendTtsTest(text: String) {
        val payload = "$TTS_PREFIX$text"
        sendPayload(payload, "native TTS text=$text")
    }

    fun pingGlass() {
        sendPayload(PING_CMD, "native ping")
    }

    fun queryGlassStatus() {
        sendPayload(STATUS_CMD, "native status")
    }

    fun queryGlassDiagnostics() {
        sendPayload(DIAG_CMD, "native diagnostics")
    }

    fun startGlassAsr() {
        sendPayload(ASR_START_CMD, "native ASR start")
    }

    fun stopGlassAsr() {
        sendPayload(ASR_STOP_CMD, "native ASR stop")
    }

    override fun sendAudioPcmToGlass(messageId: String, pcm: ByteArray): Boolean {
        if (pcm.isEmpty()) return false
        val stableMessageId = messageId.trim().take(200)
        if (stableMessageId.isEmpty()) return false
        if (Looper.myLooper() == Looper.getMainLooper()) {
            log("send Rabi PC audio to glasses rejected on main thread")
            return false
        }
        return runCatching {
            val channel = buildPhoneBtAuthProbe()
            if (!channel.readyForAudioPlayback) {
                throw IllegalStateException("glasses audio channel is not ready: ${channel.summary()}")
            }
            val completion = CountDownLatch(1)
            synchronized(glassPlaybackLock) {
                if (pendingGlassPlaybackId.isNotEmpty()) throw IllegalStateException("another glasses playback is pending")
                pendingGlassPlaybackId = stableMessageId
                pendingGlassPlaybackState = ""
                pendingGlassPlaybackLatch = completion
            }
            sendPlaybackPayload(
                RabiGlassAudioProtocol.PREFIX_PLAYBACK_BEGIN + JSONObject()
                    .put("messageId", stableMessageId)
                    .put("bytes", pcm.size)
                    .toString(),
                "glasses playback begin"
            )
            var offset = 0
            while (offset < pcm.size) {
                val end = minOf(offset + 4096, pcm.size)
                val chunk = pcm.copyOfRange(offset, end)
                val service = PSecuritySDK.getMessageService()
                    ?: throw IllegalStateException("phone message service unavailable")
                service.sendAudioStreamDataByClassicBT(chunk)
                offset = end
            }
            sendPlaybackPayload(
                RabiGlassAudioProtocol.PREFIX_PLAYBACK_END + JSONObject()
                    .put("messageId", stableMessageId)
                    .put("bytes", pcm.size)
                    .toString(),
                "glasses playback end"
            )
            val timeoutMs = maxOf(15_000L, pcm.size * 1000L / 32_000L + 15_000L)
            val completed = completion.await(timeoutMs, TimeUnit.MILLISECONDS)
            val state = synchronized(glassPlaybackLock) { pendingGlassPlaybackState }
            completed && state == "played"
        }.getOrElse {
            log("send Rabi PC audio to glasses failed: ${it.javaClass.simpleName}: ${it.message}")
            false
        }.also {
            synchronized(glassPlaybackLock) {
                if (pendingGlassPlaybackId == stableMessageId) {
                    pendingGlassPlaybackId = ""
                    pendingGlassPlaybackState = ""
                    pendingGlassPlaybackLatch = null
                }
            }
        }
    }

    override fun sendGlassAudioStatus(status: String) {
        sendPayload(RabiGlassAudioProtocol.PREFIX_STATUS + status, "glasses audio status")
    }

    override fun sendGlassTranscript(text: String) {
        sendPayload(RabiGlassAudioProtocol.PREFIX_TRANSCRIPT + text.replace('\n', ' ').take(320), "glasses transcript")
    }

    override fun sendGlassReplyText(text: String) {
        sendPayload(RabiGlassAudioProtocol.PREFIX_REPLY + text.replace('\n', ' ').take(320), "glasses reply")
    }

    override fun sendGlassDeviceState(batteryLevel: Int, charging: Boolean) {
        sendPayload(RabiGlassAudioProtocol.PREFIX_DEVICE + "$batteryLevel:${if (charging) 1 else 0}", "glasses device state")
    }

    override fun handleIncomingProtocol(channel: String, msg: String, clientId: String) {
        handleTextMessage(channel, msg, clientId)
    }

    fun initPhoneVoiceProbe(): Boolean {
        initPhoneSdk()
        val authProbe = probePhoneVoiceAuthorization(logResult = true)
        if (!authProbe.readyForOnlineVoice) {
            log("Phone SDK ASR/TTS probe not ready for online voice; ${authProbe.summary()}")
            return false
        }
        if (phoneVoiceProbeInitialized) {
            log("Phone SDK ASR/TTS probe already initialized asrConnected=${phoneAsrConnected()} ttsConnected=${phoneTtsConnected()}")
            return true
        }
        val result = runCatching {
            AsrEngine.init(BaseConfig().apply {
                serverUrl = UrlConfig.WS_ASR
            }, phoneAsrListener)
            TtsEngine.init(BaseConfig().apply {
                serverUrl = UrlConfig.WS_TTS
            }, phoneTtsListener)
            phoneVoiceProbeInitialized = true
            log("Phone SDK ASR/TTS probe init requested asrWs=${UrlConfig.WS_ASR} ttsWs=${UrlConfig.WS_TTS} ${authProbe.summary()}")
        }.onFailure {
            log("Phone SDK ASR/TTS probe init failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        return result.isSuccess
    }

    fun startPhoneAsrFeed(): Boolean {
        if (!initPhoneVoiceProbe()) {
            return false
        }
        phoneAsrBytes = 0
        phoneAsrLastLoggedBytes = 0
        phoneAsrFeeding = true
        return runCatching {
            AsrEngine.startSpeech()
            log("Phone SDK ASR start requested; feed CXR PCM through onAudioStream")
        }.onFailure {
            phoneAsrFeeding = false
            log("Phone SDK ASR start failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun stopPhoneAsrFeed(): Boolean {
        phoneAsrFeeding = false
        return runCatching {
            AsrEngine.stopSpeech()
            log("Phone SDK ASR stop requested bytes=$phoneAsrBytes asrConnected=${phoneAsrConnected()}")
        }.onFailure {
            log("Phone SDK ASR stop failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun feedPhoneAsrAudio(data: ByteArray?, offset: Int, length: Int) {
        if (!phoneAsrFeeding || data == null || length <= 0 || offset < 0 || offset >= data.size) {
            return
        }
        val safeLength = minOf(length, data.size - offset)
        val chunk = data.copyOfRange(offset, offset + safeLength)
        phoneAsrBytes += chunk.size
        runCatching {
            AsrEngine.doSpeechVoice(chunk)
        }.onFailure {
            phoneAsrFeeding = false
            log("Phone SDK ASR feed failed after bytes=$phoneAsrBytes: ${it.javaClass.simpleName}: ${it.message}")
        }
        if (phoneAsrBytes - phoneAsrLastLoggedBytes >= PHONE_VOICE_LOG_STEP_BYTES) {
            phoneAsrLastLoggedBytes = phoneAsrBytes
            log("Phone SDK ASR fed CXR PCM bytes=$phoneAsrBytes asrConnected=${phoneAsrConnected()}")
        }
    }

    fun sendPhoneTts(text: String): Boolean {
        if (!initPhoneVoiceProbe()) {
            return false
        }
        val speech = text.ifBlank { "Rabi 手机侧 Rokid TTS 测试" }
        lastPhoneTtsText = speech
        phoneTtsBytes = 0
        return runCatching {
            TtsEngine.playTts(speech)
            log("Phone SDK TTS request text=$speech ttsConnected=${phoneTtsConnected()}")
        }.onFailure {
            log("Phone SDK TTS request failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun isPhoneAsrFeeding(): Boolean {
        return phoneAsrFeeding
    }

    fun isPhoneVoiceOnlineReady(): Boolean {
        return buildPhoneVoiceAuthorizationProbe().readyForOnlineVoice
    }

    fun probePhoneVoiceAuthorization(logResult: Boolean): PhoneVoiceAuthProbe {
        initPhoneSdk()
        val probe = buildPhoneVoiceAuthorizationProbe()
        if (logResult) {
            log("Phone SDK voice auth probe ${probe.summary()}")
        }
        return probe
    }

    fun probePhoneGlassDeviceInfo(logResult: Boolean): PhoneGlassDeviceInfoProbe {
        initPhoneSdk()
        val probe = buildPhoneGlassDeviceInfoProbe()
        if (logResult) {
            log("Phone SDK glass device info probe ${probe.summary()}")
        }
        return probe
    }

    fun probePhoneBtAuth(logResult: Boolean): PhoneBtAuthProbe {
        initPhoneSdk()
        val probe = buildPhoneBtAuthProbe()
        if (logResult) {
            log("Phone SDK BT/Auth probe ${probe.summary()}")
        }
        return probe
    }

    fun probePhoneP2p(logResult: Boolean): PhoneP2pProbe {
        initPhoneSdk()
        val probe = buildPhoneP2pProbe()
        if (logResult) {
            log("Phone SDK P2P probe ${probe.summary()}")
        }
        return probe
    }

    fun startPhoneBtScan(durationMs: Long = PHONE_BT_SCAN_DURATION_MS): Boolean {
        initPhoneSdk()
        val service = runCatching { PSecuritySDK.getClassicBlueToothClientService() }
            .onFailure { log("Phone SDK BT scan service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK BT scan skipped: ClassicBluetooth service is null")
            return false
        }
        return runCatching {
            if (!phoneBtScanListenerRegistered) {
                service.addClientListener(phoneBtScanListener)
                phoneBtScanListenerRegistered = true
                log("Phone SDK BT scan listener registered")
            }
            phoneBtScanFoundCount = 0
            val generation = ++phoneBtScanGeneration
            service.startScan(durationMs)
            log("Phone SDK BT scan requested durationMs=$durationMs")
            mainHandler.postDelayed({
                if (phoneBtScanGeneration == generation) {
                    runCatching { service.stopScan() }
                        .onFailure { log("Phone SDK BT scan stop failed: ${it.javaClass.simpleName}: ${it.message}") }
                    phoneBtScanGeneration++
                    log("Phone SDK BT scan timeout stop requested found=$phoneBtScanFoundCount")
                    probePhoneBtAuth(logResult = true)
                }
            }, durationMs + PHONE_BT_SCAN_TIMEOUT_MARGIN_MS)
        }.onFailure {
            log("Phone SDK BT scan request failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun connectPhoneBtBondedGlass(): Boolean {
        return connectPhoneBtBondedGlass(autoStartP2p = false)
    }

    private fun connectPhoneBtBondedGlass(autoStartP2p: Boolean): Boolean {
        initPhoneSdk()
        val service = runCatching { PSecuritySDK.getClassicBlueToothClientService() }
            .onFailure { log("Phone SDK BT connect service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK BT connect skipped: ClassicBluetooth service is null")
            return false
        }
        val adapter = runCatching { BluetoothAdapter.getDefaultAdapter() }
            .onFailure { log("Phone SDK BT connect adapter unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (adapter == null) {
            log("Phone SDK BT connect skipped: BluetoothAdapter is null")
            return false
        }
        val bondedDevices = runCatching { adapter.bondedDevices.orEmpty() }
            .onFailure { log("Phone SDK BT bonded list failed: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrDefault(emptySet())
        val candidates = bondedDevices
            .filter { isLikelyRokidGlassDevice(it) }
            .sortedBy { runCatching { it.name }.getOrNull().orEmpty() }
        log(
            "Phone SDK BT bonded candidates total=${bondedDevices.size} " +
                "rokidLike=${candidates.size} " +
                candidates.joinToString(prefix = "[", postfix = "]") { describeBluetoothDevice(it) }
        )
        val target = candidates.firstOrNull()
        if (target == null) {
            log("Phone SDK BT connect skipped: no bonded Rokid/Glasses candidate")
            return false
        }
        return runCatching {
            if (!phoneBtScanListenerRegistered) {
                service.addClientListener(phoneBtScanListener)
                phoneBtScanListenerRegistered = true
                log("Phone SDK BT scan listener registered")
            }
            runCatching { service.stopScan() }
            log("Phone SDK BT connect requested target=${describeBluetoothDevice(target)}")
            connectPhoneBtDevice(service, target, "bonded", autoStartP2p)
        }.onFailure {
            log("Phone SDK BT connect request failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun probePhoneDeviceLink(): Boolean {
        initPhoneSdk()
        val service = runCatching { PSecuritySDK.getClassicBlueToothClientService() }
            .onFailure { log("Phone SDK device link service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK device link skipped: ClassicBluetooth service is null")
            return false
        }
        return runCatching {
            if (!phoneBtScanListenerRegistered) {
                service.addClientListener(phoneBtScanListener)
                phoneBtScanListenerRegistered = true
                log("Phone SDK BT scan listener registered")
            }
            phoneBtScanFoundCount = 0
            phoneBtAutoConnectRequested = false
            phoneBtAutoConnectGeneration = ++phoneBtScanGeneration
            runCatching { service.stopScan() }
            service.startScan(PHONE_DEVICE_LINK_SCAN_DURATION_MS)
            log("Phone SDK device link probe scan requested durationMs=$PHONE_DEVICE_LINK_SCAN_DURATION_MS")
            mainHandler.postDelayed({
                if (phoneBtAutoConnectGeneration > 0 && !phoneBtAutoConnectRequested) {
                    phoneBtAutoConnectRequested = true
                    log("Phone SDK device link scan timeout found=$phoneBtScanFoundCount; fallback to bonded candidates")
                    runCatching { service.stopScan() }
                    connectPhoneBtBondedGlass(autoStartP2p = true)
                }
                phoneBtAutoConnectGeneration = 0
            }, PHONE_DEVICE_LINK_SCAN_DURATION_MS + PHONE_BT_SCAN_TIMEOUT_MARGIN_MS)
        }.onFailure {
            log("Phone SDK device link probe failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun probePhoneP2pConnection(): Boolean {
        initPhoneSdk()
        val service = runCatching { PSecuritySDK.getWifiP2PClientService() }
            .onFailure { log("Phone SDK P2P service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK P2P probe skipped: WifiP2PClientService is null")
            return false
        }
        return runCatching {
            if (!phoneP2pListenerRegistered) {
                service.addWifiP2PClientListener(phoneP2pListener)
                phoneP2pListenerRegistered = true
                log("Phone SDK P2P listener registered")
            }
            phoneP2pPeerCount = 0
            phoneP2pMatchedPeer = null
            val generation = ++phoneP2pProbeGeneration
            service.isConnect { connected ->
                log("Phone SDK P2P isConnect callback connected=$connected")
                logPhoneP2pDetails(service, "isConnect")
                if (connected) {
                    probePhoneP2p(logResult = true)
                } else {
                    service.sendConnectP2pRequest { success ->
                        log("Phone SDK P2P sendConnectP2pRequest callback success=$success")
                        if (!success) {
                            discoverPhoneP2pPeers(generation)
                        } else {
                            mainHandler.postDelayed({
                                if (phoneP2pProbeGeneration == generation) {
                                    probePhoneP2p(logResult = true)
                                }
                            }, PHONE_P2P_CONNECT_PROBE_DELAY_MS)
                        }
                    }
                }
            }
            log("Phone SDK P2P probe requested")
            mainHandler.postDelayed({
                if (phoneP2pProbeGeneration == generation) {
                    phoneP2pProbeGeneration++
                    log("Phone SDK P2P probe timeout after ${PHONE_P2P_PROBE_TIMEOUT_MS}ms peers=$phoneP2pPeerCount matched=${phoneP2pMatchedPeer != null}")
                    logPhoneP2pDetails(service, "timeout")
                    probePhoneP2p(logResult = true)
                    runCatching {
                        service.stopPeerDiscovery { result ->
                            log("Phone SDK P2P stopPeerDiscovery after timeout success=${result.isSuccess}")
                        }
                    }
                }
            }, PHONE_P2P_PROBE_TIMEOUT_MS)
        }.onFailure {
            log("Phone SDK P2P probe request failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    fun requestPhoneOfficialSystemInfo(): Boolean {
        initPhoneSdk()
        registerMessageListener()
        val payload = """{"type":"$OFFICIAL_GET_SYSTEM_INFO","message":""}"""
        var classicRequested = false
        var p2pRequested = false
        runCatching {
            PSecuritySDK.getMessageService()?.sendTextMessageByClassicBT(payload, OFFICIAL_MAIN_CLIENT_ID)
            classicRequested = true
        }.onFailure {
            log("Phone SDK official system info ClassicBT send failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        runCatching {
            PSecuritySDK.getMessageService()?.sendTextMessageByP2P(payload, OFFICIAL_MAIN_CLIENT_ID)
            p2pRequested = true
        }.onFailure {
            log("Phone SDK official system info P2P send failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        log("Phone SDK official system info requested classic=$classicRequested p2p=$p2pRequested clientId=$OFFICIAL_MAIN_CLIENT_ID payload=$payload")
        mainHandler.postDelayed({
            log("Phone SDK official system info timeout after ${PHONE_OFFICIAL_SYSTEM_INFO_TIMEOUT_MS}ms; check ClassicBT/P2P message callbacks")
            probePhoneBtAuth(logResult = true)
            probePhoneGlassDeviceInfo(logResult = true)
        }, PHONE_OFFICIAL_SYSTEM_INFO_TIMEOUT_MS)
        return classicRequested || p2pRequested
    }

    fun requestPhoneDeviceAudioHandshake(): Boolean {
        initPhoneSdk()
        val service = runCatching { PSecuritySDK.getAbsDeviceInfoService() }
            .onFailure { log("Phone SDK device service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK device audio handshake skipped: AbsDeviceInfoService is null")
            return false
        }
        return runCatching {
            val generation = ++phoneDeviceAudioHandshakeGeneration
            service.requestAudioStream(PHONE_DEVICE_AUDIO_HANDSHAKE_TAG) { success ->
                phoneDeviceAudioHandshakeGeneration++
                log("Phone SDK device audio handshake callback success=$success")
                val probe = buildPhoneGlassDeviceInfoProbe()
                log("Phone SDK glass device info after audio handshake ${probe.summary()}")
                runCatching {
                    service.stopAudioStream(PHONE_DEVICE_AUDIO_HANDSHAKE_TAG) { stopped ->
                        log("Phone SDK device audio handshake stop callback success=$stopped")
                    }
                }.onFailure {
                    log("Phone SDK device audio handshake stop failed: ${it.javaClass.simpleName}: ${it.message}")
                }
            }
            log("Phone SDK device audio handshake requested tag=$PHONE_DEVICE_AUDIO_HANDSHAKE_TAG")
            mainHandler.postDelayed({
                if (phoneDeviceAudioHandshakeGeneration == generation) {
                    log("Phone SDK device audio handshake timeout after ${PHONE_DEVICE_AUDIO_HANDSHAKE_TIMEOUT_MS}ms")
                }
            }, PHONE_DEVICE_AUDIO_HANDSHAKE_TIMEOUT_MS)
        }.onFailure {
            log("Phone SDK device audio handshake request failed: ${it.javaClass.simpleName}: ${it.message}")
        }.isSuccess
    }

    override fun startVideoStream(fps: Int, bitrate: Int) {
        if (videoStreamActive) return
        if (phoneDeviceVideoAudioHandshakeActive) {
            listener.onGlassVideoState("视频诊断正在占用摄像头")
            return
        }
        start()
        val service = PSecuritySDK.getAbsDeviceInfoService()
        if (service == null) { listener.onGlassVideoState("眼镜视频服务不可用"); return }
        val current = ++videoStreamGeneration
        videoStreamActive = true
        videoRequestPending = true
        videoFps = fps.coerceIn(1, 30)
        videoBitrate = bitrate.coerceIn(128_000, 8_000_000)
        lastVideoAt = android.os.SystemClock.elapsedRealtime()
        try {
            val wifi = PSecuritySDK.getWifiP2PClientService()
            requireNotNull(wifi) { "P2P service unavailable" }
            if (!phoneP2pListenerRegistered) {
                wifi.addWifiP2PClientListener(phoneP2pListener)
                phoneP2pListenerRegistered = true
            }
            wifi.isConnect { connected ->
                mainHandler.post {
                    if (current != videoStreamGeneration) return@post
                    if (connected) requestPendingVideo()
                    else if (PSecuritySDK.getClassicBlueToothClientService()?.isConnected() == true) probePhoneP2pConnection()
                    else {
                        val candidates = BluetoothAdapter.getDefaultAdapter()?.bondedDevices.orEmpty().filter { isLikelyRokidGlassDevice(it) }
                        if (candidates.size != 1 || !connectPhoneBtBondedGlass(autoStartP2p = true)) {
                            stopVideoStream()
                            listener.onGlassVideoState("无法确定唯一已配对眼镜，请检查 Rokid 连接")
                        }
                    }
                }
            }
            mainHandler.postDelayed(object : Runnable {
                override fun run() {
                    if (current != videoStreamGeneration || !videoStreamActive) return
                    if (android.os.SystemClock.elapsedRealtime() - lastVideoAt >= (if (videoRequestPending) 30_000 else 10_000)) {
                        stopVideoStream()
                        listener.onGlassVideoState("眼镜视频超时，未收到连续画面")
                    } else mainHandler.postDelayed(this, 10_000)
                }
            }, 10_000)
        } catch (error: Exception) {
            stopVideoStream()
            log("Video start failed: ${error.javaClass.simpleName}")
            listener.onGlassVideoState("眼镜视频启动失败")
        }
    }

    override fun stopVideoStream() {
        videoStreamGeneration++
        if (!videoStreamActive) return
        videoStreamActive = false
        videoRequestPending = false
        try {
            PSecuritySDK.getAbsDeviceInfoService()?.stopVideoStream("RabiDirectVideo") { success ->
                log("Video stop acknowledged=$success")
            }
        } catch (error: Exception) { log("Video stop failed: ${error.javaClass.simpleName}") }
    }

    private fun requestPendingVideo() {
        if (!videoStreamActive || !videoRequestPending) return
        videoRequestPending = false
        lastVideoAt = android.os.SystemClock.elapsedRealtime()
        val current = videoStreamGeneration
        try {
            PSecuritySDK.getAbsDeviceInfoService()?.requestVideoStream("RabiDirectVideo", GlassVideoStreamParam().apply {
                fps = videoFps
                bitrate = videoBitrate
            }) { success ->
                mainHandler.post {
                    if (current != videoStreamGeneration) return@post
                    if (!success) { stopVideoStream(); listener.onGlassVideoState("眼镜拒绝启动视频") }
                    else listener.onGlassVideoState("已请求眼镜视频，等待画面")
                }
            }
        } catch (error: Exception) {
            stopVideoStream()
            log("Video capture request failed: ${error.javaClass.simpleName}")
            listener.onGlassVideoState("眼镜视频启动失败")
        }
    }

    fun requestPhoneDeviceVideoAudioHandshake(): Boolean {
        if (videoStreamActive) { log("Video probe unavailable while direct video is running"); return false }
        initPhoneSdk()
        registerMessageListener()
        val service = runCatching { PSecuritySDK.getAbsDeviceInfoService() }
            .onFailure { log("Phone SDK device service unavailable: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (service == null) {
            log("Phone SDK device video/audio handshake skipped: AbsDeviceInfoService is null")
            return false
        }
        return runCatching {
            val generation = ++phoneDeviceVideoAudioHandshakeGeneration
            phoneDeviceVideoAudioHandshakeActive = true
            phoneDeviceVideoSeen = false
            phoneDeviceAudioSeen = false
            phoneDeviceAudioRequestedAfterVideo = false
            val param = GlassVideoStreamParam().apply {
                fps = PHONE_DEVICE_VIDEO_HANDSHAKE_FPS
                bitrate = PHONE_DEVICE_VIDEO_HANDSHAKE_BITRATE
            }
            runCatching {
                service.stopVideoStream(PHONE_DEVICE_VIDEO_AUDIO_VIDEO_TAG) {}
                service.stopAudioStream(PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG) {}
            }
            service.requestVideoStream(PHONE_DEVICE_VIDEO_AUDIO_VIDEO_TAG, param) { success ->
                log("Phone SDK device video/audio handshake video callback success=$success")
                if (!success) {
                    finishPhoneDeviceVideoAudioHandshake(generation, "video callback false")
                }
            }
            log(
                "Phone SDK device video/audio handshake requested video tag=$PHONE_DEVICE_VIDEO_AUDIO_VIDEO_TAG " +
                    "fps=$PHONE_DEVICE_VIDEO_HANDSHAKE_FPS bitrate=$PHONE_DEVICE_VIDEO_HANDSHAKE_BITRATE"
            )
            mainHandler.postDelayed({
                if (phoneDeviceVideoAudioHandshakeGeneration == generation && phoneDeviceVideoAudioHandshakeActive && !phoneDeviceVideoSeen) {
                    log("Phone SDK device video/audio handshake video timeout after ${PHONE_DEVICE_VIDEO_TIMEOUT_MS}ms")
                    finishPhoneDeviceVideoAudioHandshake(generation, "video timeout")
                }
            }, PHONE_DEVICE_VIDEO_TIMEOUT_MS)
        }.onFailure {
            log("Phone SDK device video/audio handshake request failed: ${it.javaClass.simpleName}: ${it.message}")
            phoneDeviceVideoAudioHandshakeActive = false
        }.isSuccess
    }

    fun applyPhoneVoiceAuthorization(): PhoneVoiceAuthProbe {
        initPhoneSdk()
        if (!isUserAuthConfigured()) {
            log("Phone SDK voice auth apply skipped: AK/SK not configured")
            return probePhoneVoiceAuthorization(logResult = true)
        }
        val deviceInfo = currentPhoneSdkGlassDeviceInfo()
        if (deviceInfo == null || deviceInfo.deviceId.isBlank()) {
            log("Phone SDK voice auth apply skipped: GlassDeviceInfo missing; connect CXR/Phone SDK and retry")
            return probePhoneVoiceAuthorization(logResult = true)
        }
        val appToken = runCatching { generatePhoneVoiceAppToken(deviceInfo) }
            .onFailure {
                log("Phone SDK voice auth token generation failed: ${it.javaClass.simpleName}: ${it.message}")
            }
            .getOrDefault("")
        if (appToken.isBlank()) {
            log("Phone SDK voice auth apply skipped: generated app token is blank")
            return probePhoneVoiceAuthorization(logResult = true)
        }
        suppressRokidSdkSensitiveLogs()
        runCatching {
            SecuritySDKEnv.updateHeaders(deviceInfo.toPhoneSdkDeviceInfo(appToken))
        }.onFailure {
            log("Phone SDK voice auth header apply failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        suppressRokidSdkSensitiveLogs()
        val probe = buildPhoneVoiceAuthorizationProbe()
        log("Phone SDK voice auth apply result ${probe.summary()}")
        return probe
    }

    private fun buildPhoneVoiceAuthorizationProbe(): PhoneVoiceAuthProbe {
        val headers = runCatching { SecuritySDKEnv.headers }.getOrElse { emptyMap() }
        val deviceInfo = currentPhoneSdkGlassDeviceInfo()
        val appAuthorizationPresent = headerPresent(headers, HEADER_X_APP_AUTHORIZATION)
        return PhoneVoiceAuthProbe(
            configured = isUserAuthConfigured(),
            sdkHasAppAuthorization = appAuthorizationPresent,
            xUserAuthorizationPresent = headerPresent(headers, HEADER_X_USER_AUTHORIZATION),
            xUserAuthorizationLength = headerLength(headers, HEADER_X_USER_AUTHORIZATION),
            xAppAuthorizationPresent = appAuthorizationPresent,
            xAppAuthorizationLength = headerLength(headers, HEADER_X_APP_AUTHORIZATION),
            appCredentialPresent = headerPresent(headers, HEADER_APP_CREDENTIAL),
            appCredentialLength = headerLength(headers, HEADER_APP_CREDENTIAL),
            userCredentialPresent = headerPresent(headers, HEADER_USER_CREDENTIAL),
            userCredentialLength = headerLength(headers, HEADER_USER_CREDENTIAL),
            glassDeviceInfoPresent = deviceInfo != null,
            glassDeviceIdPresent = deviceInfo?.deviceId?.isNotBlank() == true
        )
    }

    private fun buildPhoneBtAuthProbe(): PhoneBtAuthProbe {
        val classicService = runCatching { PSecuritySDK.getClassicBlueToothClientService() }
            .onFailure { log("Phone SDK getClassicBlueToothClientService failed: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        return PhoneBtAuthProbe(
            sdkInitialized = runCatching { PSecuritySDK.getMobileEngineService().isInit() }.getOrDefault(false),
            classicServicePresent = classicService != null,
            classicConnected = runCatching { classicService?.isConnected() == true }.getOrDefault(false),
            messageChannelConnected = runCatching { classicService?.isMessageChanelConnect() == true }.getOrDefault(false),
            audioChannelConnected = runCatching { classicService?.isAudioChanelConnect() == true }.getOrDefault(false),
            fileChannelConnected = runCatching { classicService?.isFileChanelConnect() == true }.getOrDefault(false),
            streamChannelConnected = runCatching { classicService?.isStreamChanelConnect() == true }.getOrDefault(false),
            deviceAuthenticated = currentPhoneSdkDeviceAuthenticated()
        )
    }

    private fun buildPhoneP2pProbe(): PhoneP2pProbe {
        val service = runCatching { PSecuritySDK.getWifiP2PClientService() }
            .onFailure { log("Phone SDK getWifiP2PClientService failed: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        var connected: Boolean? = null
        if (service != null) {
            runCatching {
                service.isConnect { result ->
                    connected = result
                    log("Phone SDK P2P status callback connected=$result")
                }
            }.onFailure {
                log("Phone SDK P2P isConnect failed: ${it.javaClass.simpleName}: ${it.message}")
            }
        }
        return PhoneP2pProbe(
            servicePresent = service != null,
            connected = connected,
            peerCount = phoneP2pPeerCount,
            matchedPeerPresent = phoneP2pMatchedPeer != null
        )
    }

    private fun discoverPhoneP2pPeers(generation: Int) {
        val service = runCatching { PSecuritySDK.getWifiP2PClientService() }.getOrNull()
        if (service == null) {
            log("Phone SDK P2P discover skipped: service is null")
            return
        }
        runCatching {
            service.disconnect()
            service.initialize { result ->
                log("Phone SDK P2P initialize callback success=${result.isSuccess}")
                if (result.isSuccess) {
                    service.startDiscoverPeers { discoverResult ->
                        log("Phone SDK P2P startDiscoverPeers callback success=${discoverResult.isSuccess}")
                    }
                }
            }
            mainHandler.postDelayed({
                val matched = phoneP2pMatchedPeer
                if (phoneP2pProbeGeneration == generation && matched != null) {
                    service.connectDevice(matched) { result ->
                        log("Phone SDK P2P connectDevice callback success=${result.isSuccess} target=${describeWifiP2pDevice(matched)}")
                        probePhoneP2p(logResult = true)
                    }
                }
            }, PHONE_P2P_CONNECT_MATCH_DELAY_MS)
        }.onFailure {
            log("Phone SDK P2P discover request failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun connectPhoneBtDevice(
        service: com.rokid.security.phone.sdk.api.bluetooth.classic.api.AbsClassicBluetoothClientService,
        target: BluetoothDevice,
        source: String,
        autoStartP2p: Boolean
    ) {
        runCatching {
            service.connectToServer(target) { success ->
                log("Phone SDK BT connect callback source=$source success=$success target=${describeBluetoothDevice(target)}")
                mainHandler.postDelayed({
                    probePhoneBtAuth(logResult = true)
                    probePhoneGlassDeviceInfo(logResult = true)
                    if (success && autoStartP2p) {
                        log("Phone SDK device link BT connected; probing P2P next")
                        probePhoneP2pConnection()
                    }
                }, PHONE_BT_CONNECT_PROBE_DELAY_MS)
                Unit
            }
        }.onFailure {
            log("Phone SDK BT connect failed source=$source target=${describeBluetoothDevice(target)} ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun logPhoneP2pDetails(service: com.rokid.security.phone.sdk.api.wifip2p.api.AbsP2PClientService, source: String) {
        runCatching {
            service.requestConnectionInfo { info ->
                log("Phone SDK P2P connectionInfo source=$source ${describeWifiP2pInfo(info)}")
            }
        }.onFailure {
            log("Phone SDK P2P requestConnectionInfo failed source=$source ${it.javaClass.simpleName}: ${it.message}")
        }
        runCatching {
            service.getGroupInfo { group ->
                log("Phone SDK P2P groupInfo source=$source ${describeWifiP2pGroup(group)}")
            }
        }.onFailure {
            log("Phone SDK P2P getGroupInfo failed source=$source ${it.javaClass.simpleName}: ${it.message}")
        }
        runCatching {
            service.getIP2PConnectControl()?.getKeepP2PConnectState({ keep ->
                log("Phone SDK P2P keepConnect source=$source state=$keep")
            }, { message, code ->
                log("Phone SDK P2P keepConnect source=$source error code=$code message=$message")
            })
        }.onFailure {
            log("Phone SDK P2P getKeepP2PConnectState failed source=$source ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun buildPhoneGlassDeviceInfoProbe(): PhoneGlassDeviceInfoProbe {
        val deviceInfo = currentPhoneSdkGlassDeviceInfo()
        return PhoneGlassDeviceInfoProbe(
            present = deviceInfo != null,
            deviceIdPresent = deviceInfo?.deviceId?.isNotBlank() == true,
            deviceIdLength = deviceInfo?.deviceId?.length ?: 0,
            deviceTypePresent = deviceInfo?.deviceType?.isNotBlank() == true,
            deviceSubTypePresent = deviceInfo?.deviceSubType?.isNotBlank() == true,
            btMacPresent = deviceInfo?.btMac?.isNotBlank() == true,
            wifiMacPresent = deviceInfo?.wifiMac?.isNotBlank() == true,
            p2pMacPresent = deviceInfo?.p2pMac?.isNotBlank() == true,
            osVersionPresent = deviceInfo?.osVersion?.isNotBlank() == true
        )
    }

    fun stopPhoneVoiceProbe() {
        destroyPhoneVoiceProbe()
    }

    private fun destroyPhoneVoiceProbe() {
        phoneAsrFeeding = false
        runCatching {
            AsrEngine.destroy()
            TtsEngine.destroy()
            phoneVoiceProbeInitialized = false
            log("Phone SDK ASR/TTS probe destroyed")
        }.onFailure {
            log("Phone SDK ASR/TTS probe destroy failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun sendPayload(payload: String, description: String) {
        registerMessageListener()
        var p2pRequested = false
        var btRequested = false
        runCatching {
            PSecuritySDK.getMessageService()?.sendTextMessageByP2P(payload, RabiGlassAudioProtocol.CLIENT_ID)
            p2pRequested = true
        }.onFailure {
            log("send P2P payload failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        runCatching {
            PSecuritySDK.getMessageService()?.sendTextMessageByClassicBT(payload, RabiGlassAudioProtocol.CLIENT_ID)
            btRequested = true
        }.onFailure {
            log("send BT payload failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        log("Phone SDK send $description p2p=$p2pRequested bt=$btRequested clientId=${RabiGlassAudioProtocol.CLIENT_ID} payload=$payload")
    }

    private fun sendPlaybackPayload(payload: String, description: String) {
        registerMessageListener()
        val service = PSecuritySDK.getMessageService()
            ?: throw IllegalStateException("phone message service unavailable")
        service.sendTextMessageByClassicBT(payload, RabiGlassAudioProtocol.CLIENT_ID)
        log("Phone SDK send $description over ordered ClassicBT clientId=${RabiGlassAudioProtocol.CLIENT_ID}")
    }

    private fun initPhoneSdk() {
        if (sdkInitRequested) {
            return
        }
        sdkInitRequested = true
        suppressRokidSdkSensitiveLogs()
        val engineService = runCatching { PSecuritySDK.getMobileEngineService() }
            .onFailure { log("getMobileEngineService failed: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
        if (engineService == null) {
            log("Phone SDK mobile engine service unavailable")
            return
        }

        val userAuthInfo = UserAuthInfo("", "")
        if (isUserAuthConfigured()) {
            log("Phone SDK auth is stored but not injected: SDK init logs UserAuthInfo to logcat")
        }
        val param = EngineParam(
            clientIds = arrayListOf("SecurityPhone", RabiGlassAudioProtocol.CLIENT_ID, "RabiGlassAsr", "com.rabi.link"),
            userAuthInfo = userAuthInfo,
            banServiceList = arrayListOf(NetServiceType.TranslateService),
            envType = EnvType.PUBLIC
        )
        runCatching {
            engineService.initSDK(param) { result ->
                log("Phone SDK init result=${result.isSuccess} authConfigured=${isUserAuthConfigured()} authInjected=false")
                suppressRokidSdkSensitiveLogs()
                registerMessageListener()
            }
            log("Phone SDK init requested from ${appContext.packageName} authConfigured=${isUserAuthConfigured()} authInjected=false")
            if (!isUserAuthConfigured()) {
                log("Phone SDK voice auth is empty; online ASR/TTS may stay unavailable")
            }
            suppressRokidSdkSensitiveLogs()
        }.onFailure {
            log("Phone SDK init failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun registerMessageListener() {
        if (listenerRegistered) {
            return
        }
        runCatching {
            val messageService = PSecuritySDK.getMessageService()
            if (messageService == null) {
                log("Phone SDK message service unavailable")
                return
            }
            messageService.addMessageListener(messageListener)
            listenerRegistered = true
            log("Phone SDK message listener registered")
        }.onFailure {
            log("addMessageListener failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private fun handleTextMessage(channel: String, msg: String, clientId: String) {
        log("Phone SDK text channel=$channel clientId=$clientId msg=$msg")
        if (msg.startsWith(RabiGlassAudioProtocol.PREFIX_PLAYBACK_RECEIPT)) {
            val payload = runCatching { JSONObject(msg.removePrefix(RabiGlassAudioProtocol.PREFIX_PLAYBACK_RECEIPT)) }.getOrNull()
            val messageId = payload?.optString("messageId", "")?.trim().orEmpty()
            val state = payload?.optString("state", "")?.trim().orEmpty()
            val validState = state == "played" || state == "playback_failed"
            synchronized(glassPlaybackLock) {
                if (messageId == pendingGlassPlaybackId && validState && pendingGlassPlaybackState.isEmpty()) {
                    pendingGlassPlaybackState = state
                    pendingGlassPlaybackLatch?.countDown()
                }
            }
            listener.onNativeCommandAck("glass_playback_receipt", "state=$state", channel, clientId)
            return
        }
        if (msg == RabiGlassAudioProtocol.COMMAND_START) {
            val started = synchronized(glassAudioLock) {
                if (glassAudioCapturing) return@synchronized false
                glassAudioCapturing = true
                true
            }
            if (started) sendGlassAudioStatus("持续聆听中 · 单击可提示 Rabi")
            return
        }
        if (msg == RabiGlassAudioProtocol.COMMAND_STOP) {
            val stopped = synchronized(glassAudioLock) {
                if (!glassAudioCapturing) return@synchronized null
                glassAudioCapturing = false
                true
            }
            if (stopped == null) return
            sendGlassAudioStatus("已暂停持续聆听")
            return
        }
        if (msg == RabiGlassAudioProtocol.COMMAND_REVIEW) {
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - lastGlassReviewAt < 800) return
            lastGlassReviewAt = now
            listener.onGlassReviewRequested()
            sendGlassAudioStatus("已推送审阅请求 · 等待 Rabi")
            return
        }
        if (msg == RabiGlassAudioProtocol.COMMAND_STATUS_REQUEST) {
            sendGlassAudioStatus(if (glassAudioCapturing) "录音中" else "手机后端在线")
            return
        }
        val officialSystemInfo = parseOfficialSystemInfoResponse(msg)
        if (officialSystemInfo != null) {
            log("Phone SDK official system info response channel=$channel clientId=$clientId ${officialSystemInfo.summary}")
            listener.onNativeCommandAck("phone_system_info", officialSystemInfo.summary, channel, clientId)
        } else if (msg.startsWith(ASR_PREFIX)) {
            listener.onNativeAsrText(msg.removePrefix(ASR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ASR_ERR_PREFIX)) {
            listener.onNativeVoiceError("asr", msg.removePrefix(ASR_ERR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(TTS_ACK_PREFIX)) {
            listener.onNativeTtsAck(msg.removePrefix(TTS_ACK_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(TTS_ERR_PREFIX)) {
            listener.onNativeVoiceError("tts", msg.removePrefix(TTS_ERR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(PONG_PREFIX)) {
            listener.onNativeCommandAck("ping", msg.removePrefix(PONG_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(STATUS_PREFIX)) {
            listener.onNativeStatus(msg.removePrefix(STATUS_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(OFFLINE_CMD_STATUS_PREFIX)) {
            listener.onNativeCommandAck("offline_cmd", msg.removePrefix(OFFLINE_CMD_STATUS_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(OFFLINE_CMD_TRIGGER_PREFIX)) {
            listener.onNativeAsrText(msg.removePrefix(OFFLINE_CMD_TRIGGER_PREFIX).trim(), "$channel/offline_cmd", clientId)
        } else if (msg.startsWith(OFFLINE_CMD_ERR_PREFIX)) {
            listener.onNativeVoiceError("offline_cmd", msg.removePrefix(OFFLINE_CMD_ERR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(GLASS_ANDROID_STATUS_PREFIX)) {
            listener.onNativeCommandAck("glass_android_voice", msg.removePrefix(GLASS_ANDROID_STATUS_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(GLASS_ANDROID_ASR_PREFIX)) {
            listener.onNativeAsrText(msg.removePrefix(GLASS_ANDROID_ASR_PREFIX).trim(), "$channel/glass_android", clientId)
        } else if (msg.startsWith(GLASS_ANDROID_ASR_PARTIAL_PREFIX)) {
            listener.onNativeCommandAck("glass_android_asr_partial", msg.removePrefix(GLASS_ANDROID_ASR_PARTIAL_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(GLASS_ANDROID_TTS_ACK_PREFIX)) {
            listener.onNativeTtsAck(msg.removePrefix(GLASS_ANDROID_TTS_ACK_PREFIX).trim(), "$channel/glass_android", clientId)
        } else if (msg.startsWith(GLASS_ANDROID_ASR_START_ACK_PREFIX)) {
            listener.onNativeCommandAck("glass_android_asr_start", msg.removePrefix(GLASS_ANDROID_ASR_START_ACK_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(GLASS_ANDROID_ASR_STOP_ACK_PREFIX)) {
            listener.onNativeCommandAck("glass_android_asr_stop", msg.removePrefix(GLASS_ANDROID_ASR_STOP_ACK_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(GLASS_ANDROID_ERR_PREFIX)) {
            listener.onNativeVoiceError("glass_android_voice", msg.removePrefix(GLASS_ANDROID_ERR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ROKID_AI_STATUS_PREFIX)) {
            listener.onNativeCommandAck("glass_rokid_ai_status", msg.removePrefix(ROKID_AI_STATUS_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ROKID_AI_ASR_PREFIX)) {
            listener.onNativeAsrText(msg.removePrefix(ROKID_AI_ASR_PREFIX).trim(), "$channel/rokid_ai_sdk", clientId)
        } else if (msg.startsWith(ROKID_AI_ASR_PARTIAL_PREFIX)) {
            listener.onNativeCommandAck("glass_rokid_ai_asr_partial", msg.removePrefix(ROKID_AI_ASR_PARTIAL_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ROKID_AI_TTS_REQUEST_PREFIX)) {
            listener.onNativeTtsAck(msg.removePrefix(ROKID_AI_TTS_REQUEST_PREFIX).trim(), "$channel/rokid_ai_sdk", clientId)
        } else if (msg.startsWith(ROKID_AI_STATE_PREFIX)) {
            listener.onNativeCommandAck("glass_rokid_ai_state", msg.removePrefix(ROKID_AI_STATE_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ROKID_AI_ERROR_PREFIX)) {
            listener.onNativeVoiceError("glass_rokid_ai", msg.removePrefix(ROKID_AI_ERROR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ASR_START_ACK_PREFIX)) {
            listener.onNativeCommandAck("asr_start", msg.removePrefix(ASR_START_ACK_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ASR_START_ERR_PREFIX)) {
            listener.onNativeVoiceError("asr_start", msg.removePrefix(ASR_START_ERR_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ASR_STOP_ACK_PREFIX)) {
            listener.onNativeCommandAck("asr_stop", msg.removePrefix(ASR_STOP_ACK_PREFIX).trim(), channel, clientId)
        } else if (msg.startsWith(ASR_STOP_ERR_PREFIX)) {
            listener.onNativeVoiceError("asr_stop", msg.removePrefix(ASR_STOP_ERR_PREFIX).trim(), channel, clientId)
        }
    }

    private fun parseOfficialSystemInfoResponse(msg: String): OfficialSystemInfoResponse? {
        return runCatching {
            val root = JSONObject(msg)
            val type = root.optString("type", "")
            if (type == OFFICIAL_CUSTOM_BUSINESS_ACTION) {
                val extra = root.optString("extra", "")
                if (extra.isNotBlank()) {
                    return parseOfficialSystemInfoResponse(extra)
                }
            }
            if (type != OFFICIAL_SYSTEM_INFO_RESPONSE) {
                return null
            }
            val messageRaw = root.opt("message")
            val message = when (messageRaw) {
                is JSONObject -> messageRaw
                is String -> if (messageRaw.isBlank()) JSONObject() else JSONObject(messageRaw)
                else -> JSONObject()
            }
            val deviceId = message.optString("deviceId", "")
            val deviceTypeId = message.optString("deviceTypeId", "")
            val osType = message.optString("osType", "")
            val version = message.optString("version", "")
            val powerValue = message.optString("powerValue", "")
            val summary = "deviceId=${deviceId.isNotBlank()}/${deviceId.length} " +
                "deviceTypeId=${deviceTypeId.isNotBlank()}/${deviceTypeId.length} " +
                "osType=${osType.isNotBlank()} version=${version.isNotBlank()} power=${powerValue.isNotBlank()}"
            OfficialSystemInfoResponse(summary)
        }.getOrNull()
    }

    private fun log(line: String) {
        listener.onNativeVoiceLog(line)
    }

    private fun isUserAuthConfigured(): Boolean {
        return accessKey.isNotBlank() && secretKey.isNotBlank()
    }

    private fun phoneAsrConnected(): Boolean {
        return runCatching { AsrEngine.mAsrConnectClient?.mEventStatus?.isNotBlank() == true }.getOrDefault(false)
    }

    private fun phoneTtsConnected(): Boolean {
        return runCatching { TtsEngine.mTtsConnectClient?.mEventStatus?.isNotBlank() == true }.getOrDefault(false)
    }

    private fun handlePhoneDeviceVideoAudioVideo(source: String, bytes: Int, detail: String) {
        if (!phoneDeviceVideoAudioHandshakeActive || phoneDeviceVideoSeen) {
            return
        }
        phoneDeviceVideoSeen = true
        val generation = phoneDeviceVideoAudioHandshakeGeneration
        log("Phone SDK device video/audio handshake first video source=$source bytes=$bytes detail=$detail")
        val service = runCatching { PSecuritySDK.getAbsDeviceInfoService() }.getOrNull()
        if (service == null) {
            finishPhoneDeviceVideoAudioHandshake(generation, "device service missing after video")
            return
        }
        phoneDeviceAudioRequestedAfterVideo = true
        runCatching {
            service.requestAudioStream(PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG) { success ->
                log("Phone SDK device video/audio handshake audio callback success=$success")
                if (!success) {
                    finishPhoneDeviceVideoAudioHandshake(generation, "audio callback false")
                }
            }
            log("Phone SDK device video/audio handshake requested audio tag=$PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG after first video")
            mainHandler.postDelayed({
                if (phoneDeviceVideoAudioHandshakeGeneration == generation && phoneDeviceVideoAudioHandshakeActive && !phoneDeviceAudioSeen) {
                    log("Phone SDK device video/audio handshake audio timeout after ${PHONE_DEVICE_AUDIO_AFTER_VIDEO_TIMEOUT_MS}ms")
                    finishPhoneDeviceVideoAudioHandshake(generation, "audio timeout")
                }
            }, PHONE_DEVICE_AUDIO_AFTER_VIDEO_TIMEOUT_MS)
        }.onFailure {
            log("Phone SDK device video/audio handshake audio request failed: ${it.javaClass.simpleName}: ${it.message}")
            finishPhoneDeviceVideoAudioHandshake(generation, "audio request failed")
        }
    }

    private fun handlePhoneDeviceVideoAudioAudio(source: String, bytes: Int) {
        if (!phoneDeviceVideoAudioHandshakeActive || phoneDeviceAudioSeen) {
            return
        }
        phoneDeviceAudioSeen = true
        val generation = phoneDeviceVideoAudioHandshakeGeneration
        log("Phone SDK device video/audio handshake first audio source=$source bytes=$bytes")
        finishPhoneDeviceVideoAudioHandshake(generation, "audio received")
    }

    private fun finishPhoneDeviceVideoAudioHandshake(generation: Int, reason: String) {
        if (phoneDeviceVideoAudioHandshakeGeneration != generation) {
            return
        }
        phoneDeviceVideoAudioHandshakeGeneration++
        phoneDeviceVideoAudioHandshakeActive = false
        val service = runCatching { PSecuritySDK.getAbsDeviceInfoService() }.getOrNull()
        runCatching {
            service?.stopAudioStream(PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG) { stopped ->
                log("Phone SDK device video/audio handshake stop audio callback success=$stopped")
            }
            service?.stopVideoStream(PHONE_DEVICE_VIDEO_AUDIO_VIDEO_TAG) { stopped ->
                log("Phone SDK device video/audio handshake stop video callback success=$stopped")
            }
        }.onFailure {
            log("Phone SDK device video/audio handshake stop failed: ${it.javaClass.simpleName}: ${it.message}")
        }
        val probe = buildPhoneGlassDeviceInfoProbe()
        log(
            "Phone SDK device video/audio handshake finish reason=$reason " +
                "video=$phoneDeviceVideoSeen audioRequested=$phoneDeviceAudioRequestedAfterVideo audio=$phoneDeviceAudioSeen"
        )
        log("Phone SDK glass device info after video/audio handshake ${probe.summary()}")
    }

    private fun currentPhoneSdkGlassDeviceInfo(): GlassDeviceInfo? {
        return runCatching { PSecuritySDK.getAbsDeviceInfoService()?.getGlassDeviceInfo() }
            .onFailure { log("Phone SDK getGlassDeviceInfo failed: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull()
    }

    private fun currentPhoneSdkDeviceAuthenticated(): Boolean {
        return runCatching {
            val authClass = Class.forName(PHONE_SDK_AUTH_IMPL_CLASS)
            val instance = authClass.getField("INSTANCE").get(null)
            authClass.getMethod("isAuthenticated").invoke(instance) as? Boolean ?: false
        }.onFailure {
            log("Phone SDK auth status reflection failed: ${it.javaClass.simpleName}: ${it.message}")
        }.getOrDefault(false)
    }

    private fun describeBluetoothDevice(device: BluetoothDevice): String {
        val rawName = runCatching { device.name }.getOrNull().orEmpty()
        val name = safeBluetoothDeviceName(rawName)
        val address = runCatching { device.address }.getOrNull().orEmpty()
        val suffix = if (address.length >= 5) address.takeLast(5) else "n/a"
        return "name=$name addressSuffix=$suffix"
    }

    private fun isLikelyRokidGlassDevice(device: BluetoothDevice): Boolean {
        val name = runCatching { device.name }.getOrNull().orEmpty()
        return isLikelyRokidGlassName(name)
    }

    private fun safeBluetoothDeviceName(name: String): String {
        val trimmed = name.trim()
        if (trimmed.isBlank()) {
            return "unknown"
        }
        if (isLikelyRokidGlassName(trimmed)) {
            return trimmed
        }
        return "nonRokidDevice"
    }

    private fun isLikelyRokidGlassName(name: String): Boolean {
        return name.contains("Rokid", ignoreCase = true) ||
            name.contains("Glasses", ignoreCase = true)
    }

    private fun currentLikelyRokidBluetoothName(): String {
        val adapter = runCatching { BluetoothAdapter.getDefaultAdapter() }.getOrNull() ?: return ""
        val bondedDevices = runCatching { adapter.bondedDevices.orEmpty() }.getOrDefault(emptySet())
        return bondedDevices
            .firstOrNull { isLikelyRokidGlassDevice(it) }
            ?.let { runCatching { it.name }.getOrNull().orEmpty() }
            .orEmpty()
    }

    private fun isLikelyRokidP2pName(name: String): Boolean {
        return name.contains("Rokid", ignoreCase = true) ||
            name.contains("Glass", ignoreCase = true) ||
            name.contains("Glasses", ignoreCase = true)
    }

    private fun describeWifiP2pDevice(device: WifiP2pDevice): String {
        val name = device.deviceName?.takeIf { it.isNotBlank() } ?: "unknown"
        val safeName = if (isLikelyRokidP2pName(name)) name else "nonRokidDevice"
        val address = device.deviceAddress.orEmpty()
        val suffix = if (address.length >= 5) address.takeLast(5) else "n/a"
        return "name=$safeName addressSuffix=$suffix status=${device.status}"
    }

    private fun describeWifiP2pInfo(info: WifiP2pInfo?): String {
        if (info == null) {
            return "present=false"
        }
        return "present=true groupFormed=${info.groupFormed} isGroupOwner=${info.isGroupOwner} ownerAddress=${info.groupOwnerAddress?.hostAddress.orEmpty()}"
    }

    private fun describeWifiP2pGroup(group: WifiP2pGroup?): String {
        if (group == null) {
            return "present=false"
        }
        val owner = group.owner?.let { describeWifiP2pDevice(it) } ?: "<none>"
        return "present=true network=${safeWifiP2pNetworkName(group.networkName)} isGroupOwner=${group.isGroupOwner} owner=$owner clients=${group.clientList?.size ?: 0}"
    }

    private fun safeWifiP2pNetworkName(name: String?): String {
        val raw = name.orEmpty()
        if (raw.isBlank()) {
            return "<empty>"
        }
        return if (raw.startsWith("DIRECT-", ignoreCase = true)) {
            "DIRECT-*"
        } else {
            "<redacted>"
        }
    }

    private fun generatePhoneVoiceAppToken(deviceInfo: GlassDeviceInfo): String {
        val userId: String = runCatching { UserManager.getUserInfo()?.id }.getOrNull().orEmpty()
        val deviceId: String = deviceInfo.deviceId
        return JWT.create()
            .withHeader(mapOf("alg" to "HS256", "typ" to "JWT"))
            .withClaim("uid", userId)
            .withClaim("deviceType", PHONE_VOICE_TOKEN_DEVICE_TYPE)
            .withClaim("deviceId", deviceId)
            .withClaim("appId", accessKey)
            .withExpiresAt(Date.from(Instant.now().plus(PHONE_VOICE_TOKEN_DURATION)))
            .sign(Algorithm.HMAC256(secretKey))
    }

    private fun GlassDeviceInfo.toPhoneSdkDeviceInfo(appToken: String): DeviceInfo {
        return DeviceInfo(
            deviceId,
            deviceType,
            btMac,
            wifiMac,
            p2pMac,
            appToken,
            deviceSubType,
            osVersion,
            productId
        )
    }

    private fun headerPresent(headers: Map<String, String>, key: String): Boolean {
        return headers[key]?.isNotBlank() == true
    }

    private fun headerLength(headers: Map<String, String>, key: String): Int {
        return headers[key]?.length ?: 0
    }

    private fun suppressRokidSdkSensitiveLogs() {
        runCatching {
            L.setTAG("Mobile-SDK", ROKID_SDK_LOG_LEVEL_OFF)
            log("Phone SDK logcat disabled before init to avoid leaking UserAuthInfo")
        }.onFailure {
            log("disable Phone SDK logcat failed: ${it.javaClass.simpleName}: ${it.message}")
        }
    }

    private companion object {
        const val ROKID_SDK_LOG_LEVEL_OFF = 6
        const val OFFICIAL_MAIN_CLIENT_ID = "RokidESecurity"
        const val PHONE_SDK_CHANNEL = "PhoneSDK"
        const val PHONE_SDK_CLIENT_ID = "RabiPhoneVoice"
        const val PHONE_DEVICE_AUDIO_HANDSHAKE_TAG = "RabiPhoneDeviceInfoProbe"
        const val PHONE_DEVICE_VIDEO_AUDIO_VIDEO_TAG = "RabiPhoneDeviceVideoProbe"
        const val PHONE_DEVICE_VIDEO_AUDIO_AUDIO_TAG = "RabiPhoneDeviceAudioAfterVideoProbe"
        const val PHONE_DEVICE_AUDIO_HANDSHAKE_TIMEOUT_MS = 5000L
        const val PHONE_DEVICE_VIDEO_TIMEOUT_MS = 10000L
        const val PHONE_DEVICE_AUDIO_AFTER_VIDEO_TIMEOUT_MS = 7000L
        const val PHONE_DEVICE_VIDEO_HANDSHAKE_FPS = 15
        const val PHONE_DEVICE_VIDEO_HANDSHAKE_BITRATE = 2_000_000
        const val PHONE_BT_SCAN_DURATION_MS = 8000L
        const val PHONE_DEVICE_LINK_SCAN_DURATION_MS = 12000L
        const val PHONE_BT_SCAN_TIMEOUT_MARGIN_MS = 1000L
        const val PHONE_BT_CONNECT_PROBE_DELAY_MS = 1000L
        const val PHONE_P2P_PROBE_TIMEOUT_MS = 15000L
        const val PHONE_P2P_CONNECT_PROBE_DELAY_MS = 2000L
        const val PHONE_P2P_CONNECT_MATCH_DELAY_MS = 5000L
        const val PHONE_OFFICIAL_SYSTEM_INFO_TIMEOUT_MS = 5000L
        const val PHONE_SDK_AUTH_IMPL_CLASS = "com.rokid.security.phone.sdk.server.auth.AuthServiceImpl"
        const val PHONE_VOICE_LOG_STEP_BYTES = 65536
        const val PHONE_VOICE_TOKEN_DEVICE_TYPE = "Glass"
        const val HEADER_X_USER_AUTHORIZATION = "x-user-authorization"
        const val HEADER_X_APP_AUTHORIZATION = "x-app-authorization"
        const val HEADER_APP_CREDENTIAL = "appCredential"
        const val HEADER_USER_CREDENTIAL = "userCredential"
        const val ASR_PREFIX = "RABI_ASR:"
        const val ASR_ERR_PREFIX = "RABI_ASR_ERR:"
        const val TTS_PREFIX = "RABI_TTS:"
        const val TTS_ACK_PREFIX = "RABI_TTS_OK:"
        const val TTS_ERR_PREFIX = "RABI_TTS_ERR:"
        const val PING_CMD = "RABI_PING"
        const val STATUS_CMD = "RABI_STATUS"
        const val DIAG_CMD = "RABI_DIAG"
        const val ASR_START_CMD = "RABI_ASR_START"
        const val ASR_STOP_CMD = "RABI_ASR_STOP"
        const val PONG_PREFIX = "RABI_PONG:"
        const val STATUS_PREFIX = "RABI_STATUS:"
        const val ASR_START_ACK_PREFIX = "RABI_ASR_START_OK:"
        const val ASR_START_ERR_PREFIX = "RABI_ASR_START_ERR:"
        const val ASR_STOP_ACK_PREFIX = "RABI_ASR_STOP_OK:"
        const val ASR_STOP_ERR_PREFIX = "RABI_ASR_STOP_ERR:"
        const val OFFLINE_CMD_STATUS_PREFIX = "RABI_OFFLINE_CMD_STATUS:"
        const val OFFLINE_CMD_TRIGGER_PREFIX = "RABI_OFFLINE_CMD:"
        const val OFFLINE_CMD_ERR_PREFIX = "RABI_OFFLINE_CMD_ERR:"
        const val GLASS_ANDROID_STATUS_PREFIX = "RABI_GLASS_ANDROID_STATUS:"
        const val GLASS_ANDROID_ASR_PREFIX = "RABI_GLASS_ANDROID_ASR:"
        const val GLASS_ANDROID_ASR_PARTIAL_PREFIX = "RABI_GLASS_ANDROID_ASR_PARTIAL:"
        const val GLASS_ANDROID_ASR_START_ACK_PREFIX = "RABI_GLASS_ANDROID_ASR_START_OK:"
        const val GLASS_ANDROID_ASR_STOP_ACK_PREFIX = "RABI_GLASS_ANDROID_ASR_STOP_OK:"
        const val GLASS_ANDROID_TTS_ACK_PREFIX = "RABI_GLASS_ANDROID_TTS_OK:"
        const val GLASS_ANDROID_ERR_PREFIX = "RABI_GLASS_ANDROID_ERR:"
        const val ROKID_AI_STATUS_PREFIX = "RABI_ROKID_AI_STATUS:"
        const val ROKID_AI_ASR_PREFIX = "RABI_ROKID_AI_ASR:"
        const val ROKID_AI_ASR_PARTIAL_PREFIX = "RABI_ROKID_AI_ASR_PARTIAL:"
        const val ROKID_AI_TTS_REQUEST_PREFIX = "RABI_ROKID_AI_TTS_REQUEST:"
        const val ROKID_AI_STATE_PREFIX = "RABI_ROKID_AI_STATE:"
        const val ROKID_AI_ERROR_PREFIX = "RABI_ROKID_AI_ERROR:"
        const val OFFICIAL_GET_SYSTEM_INFO = "GET_SYSTEM_INFO"
        const val OFFICIAL_SYSTEM_INFO_RESPONSE = "SYSTEM_INFO_RESPONSE"
        const val OFFICIAL_CUSTOM_BUSINESS_ACTION = "custom_business_action"

        val PHONE_VOICE_TOKEN_DURATION: Duration = Duration.ofDays(7)
    }

    private data class OfficialSystemInfoResponse(val summary: String)
}
