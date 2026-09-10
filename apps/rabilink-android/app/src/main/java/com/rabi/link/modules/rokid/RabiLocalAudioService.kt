package com.rabi.link.modules.rokid

import android.app.*
import android.content.Intent
import android.os.*
import androidx.core.app.NotificationCompat
import com.rabi.link.R
import com.rabi.link.recording.*
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture
import com.rokid.cxr.link.utils.GlassInfo
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.CopyOnWriteArraySet

/** Local capture reuses the phone AudioRecord owner or paired CXR audio, without Relay dependencies. */
class RabiLocalAudioService : Service(), RokidCxrController.Listener {
    companion object {
        const val STOP = "com.rabi.link.recording.AUDIO_STOP"
        private const val NOTICE = 7440
        private const val CHANNEL = "rabi_local_audio"
        @Volatile var status = "尚未开始录音"; private set
        @Volatile var started = 0L; private set
        @Volatile var level = 0; private set
        @Volatile var sessionId = ""; private set
        val listeners = CopyOnWriteArraySet<Runnable>()
    }
    private val main = Handler(Looper.getMainLooper())
    private var phone: RabiPhoneAudioCapture? = null
    private var glasses: RokidCxrController? = null
    private val queue = ArrayBlockingQueue<ByteArray>(128)
    @Volatile private var accepting = false
    @Volatile private var failure = false
    private var active = false
    private var writerStarted = false
    private var glassAudioStarted = false
    private var lastUi = 0L
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "本地录音", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopCapture(); return START_NOT_STICKY }
        startForeground(NOTICE, notification())
        if (active) return START_NOT_STICKY
        if (!CaptureOwnership.acquire("audio")) { update("请先停止当前采集，等待保存完成"); stopSelf(); return START_NOT_STICKY }
        active = true
        try {
            check(filesDir.usableSpace >= 256L * 1024 * 1024) { "可用空间不足 256 MiB" }
            val source = intent?.getStringExtra("source") ?: "phone"
            val entry = RecordingStore(this).create("audio", source)
            sessionId = entry.id; started = 0; failure = false; accepting = true
            val writer = PcmWaveWriter(File(entry.directory, "audio.wav"))
            writerStarted = true
            Thread({
                try {
                    writer.use {
                        while (accepting || queue.isNotEmpty()) {
                            val data = queue.poll(250, TimeUnit.MILLISECONDS) ?: continue
                            if (filesDir.usableSpace < 256L * 1024 * 1024) throw java.io.IOException("space")
                            it.write(data)
                        }
                    }
                } catch (_: Exception) { failure = true; main.post { stopCapture() } }
                finally {
                    try { RecordingStore(this).finish(entry.id, if (failure) "interrupted" else "saved") }
                    catch (_: Exception) { failure = true }
                    main.post {
                        active = false; accepting = false; level = 0; sessionId = ""
                        update(if (failure) "保存中断，已写入内容保留在记录页" else "录音已保存到手机")
                        CaptureOwnership.release("audio"); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
                    }
                }
            }, "rabi-local-audio-writer").start()
            update(if (source == "glasses") "正在连接眼镜声音" else "正在开启手机麦克风")
            if (source == "glasses") {
                val token = getSharedPreferences("rokid_probe", MODE_PRIVATE).getString("rokid_token", "").orEmpty()
                check(token.isNotBlank()) { "请先在设备页完成乐奇授权" }
                stopService(Intent(this, RokidDeviceStatusSyncService::class.java))
                glasses = RokidCxrController(this, this)
                glasses!!.disableDiagnosticAudioBuffer()
                check(glasses!!.connectCustomViewSession(token)) { "眼镜连接失败" }
                main.postDelayed({ if (accepting && started == 0L) { failure = true; update("未收到眼镜声音，请检查连接"); stopCapture() } }, 15000)
            } else {
                phone = RabiPhoneAudioCapture(this, object : RabiPhoneAudioCapture.Listener {
                    override fun onPcm(pcm: ByteArray) = receive(pcm)
                    override fun onPlaybackSuppressed() = Unit
                    override fun onGap(reason: String, estimatedBytes: Long) { main.post { failure = true; stopCapture() } }
                    override fun onStatus(status: String) = Unit
                    override fun onDiagnostic(event: String, level: String, state: String) = Unit
                }).also { it.start() }
            }
        } catch (error: Exception) {
            failure = true; update(error.message ?: "无法开始录音"); stopCapture()
            if (!writerStarted) { active = false; sessionId = ""; CaptureOwnership.release("audio"); stopSelf() }
        }
        return START_NOT_STICKY
    }
    private fun receive(pcm: ByteArray) {
        if (!accepting) return
        if (!queue.offer(pcm.copyOf())) { failure = true; main.post { stopCapture() }; return }
        var peak = 0
        for (i in 0 until pcm.size - 1 step 2) peak = maxOf(peak, kotlin.math.abs(((pcm[i].toInt() and 255) or (pcm[i + 1].toInt() shl 8)).toShort().toInt()))
        level = peak * 100 / 32768
        if (SystemClock.elapsedRealtime() - lastUi > 250) {
            lastUi = SystemClock.elapsedRealtime()
            main.post { if (accepting) { if (started == 0L) { started = System.currentTimeMillis(); update("正在录音 · 已存手机") }; listeners.forEach { it.run() } } }
        }
    }
    private fun stopCapture() {
        phone?.close(true); phone = null
        glasses?.let { it.stopAudioStream(); it.disconnect() }; glasses = null
        accepting = false
        if (active) update("正在保存录音") else stopSelf()
    }
    private fun update(value: String) { status = value; listeners.forEach { it.run() }; if (active) getSystemService(NotificationManager::class.java).notify(NOTICE, notification()) }
    private fun notification(): Notification = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.rabiroute_icon)
        .setContentTitle("Rabi · 本地录音").setContentText(status).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, RabiRecordingHubActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "停止并保存", PendingIntent.getService(this, 1, Intent(this, javaClass).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)).build()
    private fun ready() { if (accepting && !glassAudioStarted && glasses?.isLinkReady == true) { glassAudioStarted = true; if (glasses?.startAudioStream() != true) { failure = true; stopCapture() } } }
    override fun onLog(line: String?) = Unit
    override fun onCxrConnectionChanged(connected: Boolean) { main.post { if (connected) ready() else if (glassAudioStarted) { failure = true; stopCapture() } } }
    override fun onGlassBtConnectionChanged(connected: Boolean) = onCxrConnectionChanged(connected)
    override fun onGlassDeviceInfo(info: GlassInfo?) = Unit
    override fun onPhoto(data: ByteArray?) = Unit
    override fun onAudioPcm(data: ByteArray?, offset: Int, length: Int) { if (data != null && offset >= 0 && length > 0 && offset + length <= data.size) receive(data.copyOfRange(offset, offset + length)) }
    override fun onGlassAppResult(result: String?, summary: String?, error: String?) = Unit
    override fun onNativeVoiceProtocol(payload: String?, channel: String?, clientId: String?) = Unit
    override fun onDestroy() { stopCapture(); super.onDestroy() }
}
