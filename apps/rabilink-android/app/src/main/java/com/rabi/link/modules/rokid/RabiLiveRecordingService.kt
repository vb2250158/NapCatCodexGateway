package com.rabi.link.modules.rokid

import android.app.*
import android.content.Intent
import android.os.*
import androidx.core.app.NotificationCompat
import com.rabi.link.R
import java.io.File
import java.lang.Process
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import com.rabi.link.recording.CaptureOwnership
import com.rabi.link.recording.RecordingStore

/** Owns the offline receiver process and local recordings. No Relay/SDK credentials. */
class RabiLiveRecordingService : Service() {
    companion object {
        const val STOP = "com.rabi.link.live.STOP"
        const val AUTO = "com.rabi.link.live.AUTO"
        private const val CHANNEL = "rabi_local_recording"
        private const val NOTICE = 7430
        private const val RESERVE = 256L * 1024 * 1024
        fun recordings(service: android.content.Context) = File(service.filesDir, "rabi-live-recordings")
    }
    inner class LocalBinder : Binder() { val service get() = this@RabiLiveRecordingService }
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val listeners = mutableSetOf<() -> Unit>()
    private var process: Process? = null
    private var stopping = false
    private var autoRequested = false
    private var videoController: RabiGlassVideoController? = null
    private var observer: FileObserver? = null
    private var wake: PowerManager.WakeLock? = null
    var running = false; private set
    var receiving = false; private set
    var receivedAt = 0L; private set
    var sessionId = ""; private set
    private var sessionDirectory: File? = null
    var status = "尚未启动接收"; private set
    val streamKey: String by lazy {
        val preferences = getSharedPreferences("rabi_live_recorder", MODE_PRIVATE)
        preferences.getString("stream_key", null) ?: UUID.randomUUID().toString().replace("-", "").also {
            preferences.edit().putString("stream_key", it).commit()
        }
    }
    fun urls(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && !it.name.startsWith("tun") && !it.name.startsWith("rmnet") }
            .flatMap { it.inetAddresses.toList() }
            .filter { it is Inet4Address && it.isSiteLocalAddress }
            .map { "rtmp://${it.hostAddress}:1936/rabi" }.distinct()
    } catch (_: Exception) { emptyList() }
    fun listen(listener: () -> Unit) { listeners.add(listener); listener() }
    fun unlisten(listener: () -> Unit) { listeners.remove(listener) }
    private fun update(message: String) {
        status = message
        android.util.Log.i("RabiLiveRecording", message)
        listeners.toList().forEach { it() }
        if (running) getSystemService(NotificationManager::class.java).notify(NOTICE, notification())
    }
    override fun onBind(intent: Intent) = LocalBinder()
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "眼镜本地录像", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) stopRecording() else {
            if (intent?.action == AUTO) autoRequested = true
            startRecording()
            if (running && autoRequested) startGlasses()
        }
        return START_NOT_STICKY
    }
    private fun startGlasses() {
        if (videoController?.isClosed == false) return
        com.rabi.link.RabiConversationServiceState.setRestoreEnabled(this, false)
        com.rabi.link.RabiConversationService.pauseForLocalCapture()
        stopService(Intent(this, RokidDeviceStatusSyncService::class.java))
        videoController = RabiGlassVideoController(this, {
            urls().map { "$it/$streamKey" }
        }, { message -> if (!receiving && !stopping) update(message) }).also { controller ->
            main.postDelayed({ if (videoController === controller && running && !stopping) controller.start() }, 1000)
        }
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, RabiLiveRecordingActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, javaClass).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.rabiroute_icon)
            .setContentTitle("眼镜本地录像").setContentText(status).setContentIntent(open)
            .setOngoing(true).addAction(0, "停止并保存", stop).build()
    }
    private fun startRecording() {
        if (running) return
        startForeground(NOTICE, notification())
        if (!CaptureOwnership.acquire("video")) { update("请先停止录音，等待保存完成"); finishForeground(); return }
        val entry = try { RecordingStore(this).create("video", "glasses") } catch (_: Exception) {
            CaptureOwnership.release("video"); update("录像目录不可写，未开始采集"); finishForeground(); return
        }
        sessionId = entry.id; sessionDirectory = entry.directory; receivedAt = 0
        val directory = entry.directory
        val streamDirectory = File(directory, "rabi/$streamKey").apply { mkdirs() }
        if (directory.usableSpace < RESERVE) { update("空间不足 256 MiB，未启动；已有录像保留"); releaseResources(); finishForeground(); return }
        if (urls().isEmpty()) { update("请先开启手机热点或连接本地 Wi-Fi；不需要互联网"); releaseResources(); finishForeground(); return }
        val executable = File(applicationInfo.nativeLibraryDir, "libmediamtx.so")
        val config = File(filesDir, "rabi-live-recorder.yml")
        try {
            config.writeText(configuration(directory))
            process = ProcessBuilder(executable.absolutePath, config.absolutePath)
                .directory(filesDir).redirectErrorStream(true).start()
            running = true
            stopping = false
            wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RabiLink:LocalRecording").apply { acquire() }
            observer = object : FileObserver(streamDirectory, MODIFY or CLOSE_WRITE or CREATE) {
                private var lastCheck = 0L
                override fun onEvent(event: Int, path: String?) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastCheck < 5000) return
                    lastCheck = now
                    if (directory.usableSpace < RESERVE) main.post {
                        update("空间不足，正在停止并保存已有录像")
                        stopRecording()
                    }
                }
            }.also { it.startWatching() }
            update("正在启动本地接收")
            val owned = process!!
            worker.execute {
                var failure = false
                try {
                    owned.inputStream.bufferedReader().useLines { lines -> lines.forEach { line ->
                        // Never expose raw native logs containing the private stream path.
                        if (line.contains("ERR")) failure = true
                        val message = when {
                            line.contains("listener opened") -> "等待眼镜推流；无需互联网"
                            line.contains("is publishing") -> "正在接收并录像（手机本地）"
                            line.contains("recording") && line.contains("stopped") -> "本段录像已保存，等待下一次推流"
                            line.contains("ERR") -> "接收器异常；请检查端口、空间及视频格式"
                            else -> null
                        }
                        if (message != null) main.post { if (process === owned && !stopping) {
                            if (line.contains("is publishing")) { receiving = true; if (receivedAt == 0L) receivedAt = System.currentTimeMillis() }
                            if (line.contains("recording") && line.contains("stopped")) receiving = false
                            update(message)
                        } }
                    } }
                    val exit = owned.waitFor()
                    main.post {
                        if (process === owned) {
                            process = null
                            running = false
                            receiving = false
                            releaseResources()
                            update(if (stopping) "已停止，录像保存在本机" else if (failure || exit != 0) "接收器已退出，请检查端口或录像空间" else "接收已结束，录像保存在本机")
                            finishForeground()
                        }
                    }
                } catch (_: Exception) {
                    owned.destroy()
                    if (!owned.waitFor(10, TimeUnit.SECONDS)) { owned.destroyForcibly(); owned.waitFor() }
                    main.post { if (process === owned) {
                        process = null
                        running = false
                        receiving = false
                        releaseResources()
                        update(if (stopping) "已停止，录像保存在本机" else "接收中断，保留已写入录像")
                        finishForeground()
                    } }
                }
            }
        } catch (_: Exception) { process?.destroy(); process = null; running = false; receiving = false; releaseResources(); update("本地接收器启动失败"); finishForeground() }
    }
    private fun configuration(directory: File): String = """
        logLevel: info
        logDestinations: [stdout]
        api: false
        metrics: false
        pprof: false
        playback: false
        rtsp: true
        rtspAddress: 127.0.0.1:8554
        rtspTransports: [tcp]
        hls: false
        webrtc: false
        srt: false
        rtmp: true
        rtmpAddress: 0.0.0.0:1936
        authInternalUsers:
          - user: any
            pass:
            ips: [127.0.0.1]
            permissions:
              - action: read
                path: rabi/$streamKey
          - user: any
            pass:
            ips: []
            permissions:
              - action: publish
                path: rabi/$streamKey
        paths:
          rabi/$streamKey:
            source: publisher
            overridePublisher: false
            record: true
            recordPath: ${directory.absolutePath}/%path/%Y-%m-%d_%H-%M-%S-%f
            recordFormat: fmp4
            recordPartDuration: 1s
            recordMaxPartSize: 16M
            recordSegmentDuration: 1m
            recordDeleteAfter: 0s
    """.trimIndent()
    private fun stopRecording() {
        videoController?.close(); videoController = null; autoRequested = false
        if (stopping) return
        val owned = process ?: run { finishForeground(); return }
        stopping = true
        update("正在停止并保存录像")
        owned.destroy() // SIGTERM lets MediaMTX close its current recording.
        Thread {
            if (!owned.waitFor(10, TimeUnit.SECONDS)) owned.destroyForcibly()
        }.start()
    }
    private fun releaseResources() {
        videoController?.close(); videoController = null; autoRequested = false
        observer?.stopWatching(); observer = null
        wake?.let { if (it.isHeld) it.release() }; wake = null
        if (sessionId.isNotEmpty()) {
            try { RecordingStore(this).finish(sessionId, if (stopping) "saved" else "interrupted") }
            catch (_: Exception) { android.util.Log.w("RabiLiveRecording", "session_manifest_save_failed") }
            sessionId = ""; sessionDirectory = null
        }
        CaptureOwnership.release("video")
    }
    private fun finishForeground() { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    override fun onDestroy() { videoController?.close(); videoController = null; process?.destroy(); releaseResources(); worker.shutdown(); listeners.clear(); super.onDestroy() }
}
