package com.rabi.link.modules.rokid

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.rokid.cxr.link.utils.GlassInfo
import com.rabi.link.protocol.RabiGlassVideoProtocol
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Paired CXR control only. The local recorder remains the authority for received media. */
class RabiGlassVideoController(private val context: Context, private val receiver: () -> List<String>, private val status: (String) -> Unit) : RokidCxrController.Listener {
    private val main = Handler(Looper.getMainLooper())
    private val cxr = RokidCxrController(context, this, "com.rabi.link.glass.video")
    private val session = UUID.randomUUID().toString()
    private var closed = false
    val isClosed get() = closed
    private var launched = false
    private var preparing = false
    private var acknowledged = false
    private val prefs = context.getSharedPreferences("rabi_live_recorder", Context.MODE_PRIVATE)
    private val heartbeat = object : Runnable {
        override fun run() {
            if (closed || !launched) return
            val urls = receiver()
            if (urls.isEmpty()) { status("没有可用本地网络，已停止眼镜推流"); close(); return }
            cxr.sendVideoCommand(RabiGlassVideoProtocol.PREFIX + JSONObject()
                .put("action", "start").put("session", session).put("urls", org.json.JSONArray(urls)).toString())
            main.postDelayed(this, 4000)
        }
    }
    fun start() {
        val token = context.getSharedPreferences("rokid_probe", Context.MODE_PRIVATE).getString("rokid_token", "").orEmpty()
        if (token.isBlank()) { status("请先完成一次乐奇授权"); close(); return }
        status("正在连接眼镜控制通道")
        if (!cxr.connectGlassAppSession(token)) status("眼镜控制连接失败，请检查乐奇授权与蓝牙")
        main.postDelayed({ if (!closed && !acknowledged) {
            status("眼镜尚未开始推流，请检查安装、权限和本地网络")
            close()
        } }, 90000)
    }
    private fun ready() {
        if (closed || preparing || !cxr.isLinkReady) return
        preparing = true
        if (prefs.getInt("glass_video_helper_installed", 0) == 1) launch()
        else {
            status("首次安装 Rabi 眼镜录像应用")
            Thread {
                try {
                    val apk = File(context.cacheDir, "rabi-glass-video.apk")
                    context.assets.open("rabi-glass-video.apk").use { input -> apk.outputStream().use { input.copyTo(it) } }
                    main.post { if (!closed) cxr.installGlassAsrApp(apk.absolutePath) }
                } catch (_: Exception) { main.post { if (!closed) status("眼镜应用准备失败") } }
            }.start()
        }
    }
    private fun launch() {
        status("正在启动眼镜相机应用")
        cxr.startGlassVideoApp()
    }
    fun close() {
        if (closed) return
        cxr.sendVideoCommand(RabiGlassVideoProtocol.PREFIX + JSONObject().put("action", "stop").put("session", session).toString())
        closed = true; main.removeCallbacksAndMessages(null)
        main.postDelayed({ cxr.disconnect() }, 500)
    }
    override fun onLog(line: String) { android.util.Log.i("RabiAutoVideo", line) }
    override fun onCxrConnectionChanged(connected: Boolean) { main.post { if (connected) ready() } }
    override fun onGlassBtConnectionChanged(connected: Boolean) { main.post { if (connected) ready() } }
    override fun onGlassDeviceInfo(info: GlassInfo?) { }
    override fun onPhoto(data: ByteArray?) { }
    override fun onAudioPcm(data: ByteArray?, offset: Int, length: Int) { }
    override fun onGlassAppResult(result: String?, summary: String?, error: String?) { main.post {
        if (closed) return@post
        if (summary == "onInstallAppResult=true") {
            prefs.edit().putInt("glass_video_helper_installed", 1).apply(); launch()
        } else if (result == "started" && !launched) {
            launched = true; status("等待眼镜相机与声音"); main.post(heartbeat)
        } else if (result == "failed") {
            prefs.edit().remove("glass_video_helper_installed").apply()
            status("乐奇返回眼镜应用安装或启动失败，未提供具体原因"); close()
        }
    } }
    override fun onNativeVoiceProtocol(payload: String?, channel: String?, clientId: String?) { main.post {
        if (closed) return@post
        when (payload) {
            "RABI_VIDEO_STATUS:publishing" -> { acknowledged = true; status("眼镜正在发送，等待手机确认画面") }
            "RABI_VIDEO_STATUS:permission_required" -> status("请在眼镜上允许相机与麦克风")
            "RABI_VIDEO_STATUS:permission_denied" -> { status("眼镜相机或麦克风未授权"); close() }
            "RABI_VIDEO_STATUS:capture_failed" -> { status("眼镜无法开启相机或麦克风"); close() }
            "RABI_VIDEO_STATUS:network_unreachable" -> status("眼镜无法连接手机，请连接手机热点或同一 Wi-Fi")
            "RABI_VIDEO_STATUS:stopped_on_glasses" -> { status("已在眼镜上停止推流"); close() }
        }
    } }
}
