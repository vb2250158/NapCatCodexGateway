package com.rabi.link.recording

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.*
import android.view.*
import android.widget.*
import androidx.core.content.FileProvider
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.PlayerView
import com.rabi.link.*
import com.rabi.link.modules.rokid.*
import com.rabi.link.modules.wearable.WearableHealthSettingsActivity
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.Executors

/** Daily capture UI. Services and session manifests own capture and saved-media state. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RabiRecordingHubActivity : Activity() {
    private val ink = Color.rgb(16, 42, 67)
    private val muted = Color.rgb(85, 105, 121)
    private val pink = Color.rgb(255, 109, 157)
    private val paper = Color.rgb(245, 247, 250)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var page = "home"
    private var mode = 0
    private var source = "phone"
    private var live: RabiLiveRecordingService? = null
    private var bound = false
    private var active = false
    private var renderGeneration = 0
    private lateinit var body: LinearLayout
    private lateinit var frame: LinearLayout
    private var captureStatus: TextView? = null
    private var clock: Chronometer? = null
    private var meter: ProgressBar? = null
    private var action: Button? = null
    private var persistent: TextView? = null
    private var preview: PlayerView? = null
    private var previewMessage: TextView? = null
    private var player: ExoPlayer? = null
    private var playing = ""
    private var detail: RecordingStore.Entry? = null
    private val changes = Runnable { main.post { if (active) refreshCapture() } }
    private val liveChange: () -> Unit = { changes.run() }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            live = (binder as RabiLiveRecordingService.LocalBinder).service
            live!!.listen(liveChange)
        }
        override fun onServiceDisconnected(name: ComponentName?) { live = null; refreshCapture() }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.statusBarColor = paper; window.navigationBarColor = Color.WHITE
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        page = state?.getString("page") ?: intent.getStringExtra("page") ?: "home"
        mode = state?.getInt("mode") ?: getSharedPreferences("rabi_capture_ui", MODE_PRIVATE).getInt("mode", 0)
        source = getSharedPreferences("rabi_capture_ui", MODE_PRIVATE).getString("source", "phone") ?: "phone"
        if (intent.getBooleanExtra("video", false)) mode = 2
        render()
        if (state == null && intent.getBooleanExtra("auto_video", false)) {
            mode = 2; render(); startVideo(true)
        }
    }
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent); setIntent(intent)
        page = intent?.getStringExtra("page") ?: "home"; detail = null
        if (intent?.getBooleanExtra("video", false) == true) mode = 2
        render()
    }
    override fun onSaveInstanceState(out: Bundle) { out.putString("page", page); out.putInt("mode", mode); super.onSaveInstanceState(out) }
    override fun onStart() {
        super.onStart(); active = true
        CaptureOwnership.listen(changes); RabiLocalAudioService.listeners.add(changes)
        bound = bindService(Intent(this, RabiLiveRecordingService::class.java), connection, BIND_AUTO_CREATE)
        if (detail != null) playFiles(detail!!) else refreshCapture()
    }
    override fun onStop() {
        active = false; CaptureOwnership.unlisten(changes); RabiLocalAudioService.listeners.remove(changes)
        live?.unlisten(liveChange); if (bound) unbindService(connection); bound = false; live = null
        releasePlayer(); clock?.stop(); super.onStop()
    }
    override fun onDestroy() { worker.shutdown(); main.removeCallbacksAndMessages(null); super.onDestroy() }
    override fun onBackPressed() { if (detail != null || page != "home") { detail = null; page = "home"; render() } else super.onBackPressed() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int = 18) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Float = 15f, color: Int = ink) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); setPadding(0, dp(6), 0, dp(6)); setLineSpacing(dp(2).toFloat(), 1f)
    }
    private fun button(value: String, primary: Boolean = false, click: () -> Unit) = Button(this).apply {
        text = value; textSize = 15f; isAllCaps = false; minHeight = dp(52); setTextColor(ink)
        background = rounded(if (primary) pink else Color.rgb(234, 239, 244), 14)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(4) }
        setOnClickListener { click() }
    }
    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(14), dp(18), dp(14)); background = rounded(Color.WHITE)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) }
    }.also { body.addView(it) }
    private fun render() {
        renderGeneration++; releasePlayer(); clock?.stop(); captureStatus = null; clock = null; meter = null; action = null; preview = null; previewMessage = null
        frame = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(paper) }
        val heading = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(16), dp(22), dp(8)) }
        heading.addView(label("RABI / 随身记录", 12f, muted))
        heading.addView(label(if (detail != null) "回看记录" else when (page) { "records" -> "你的记录"; "devices" -> "连接设备"; else -> "把此刻留下" }, 28f).apply { typeface = Typeface.DEFAULT_BOLD })
        frame.addView(heading)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(8), dp(18), dp(12)) }
        frame.addView(ScrollView(this).apply { isFillViewport = true; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        when { detail != null -> renderDetail(detail!!); page == "records" -> renderRecords(); page == "devices" -> renderDevices(); else -> renderHome() }
        action?.let { button -> frame.addView(button, LinearLayout.LayoutParams(-1, dp(54)).apply {
            setMargins(dp(18), dp(6), dp(18), dp(8))
        }) }
        persistent = label("", 13f).apply { setPadding(dp(18), dp(10), dp(18), dp(10)); setOnClickListener { stopAll() }; contentDescription = "当前采集状态，点按停止并保存" }
        frame.addView(persistent)
        frame.addView(navigation())
        setContentView(frame); refreshCapture()
    }
    private fun navigation() = LinearLayout(this).apply {
        setPadding(dp(8), dp(4), dp(8), dp(8)); setBackgroundColor(Color.WHITE)
        listOf("home" to "首页", "records" to "记录", "messages" to "消息", "devices" to "设备").forEach { (key, name) ->
            addView(Button(this@RabiRecordingHubActivity).apply {
                text = name; textSize = 14f; isAllCaps = false; minHeight = dp(52); setTextColor(ink)
                background = rounded(if (page == key) Color.rgb(255, 223, 234) else Color.WHITE, 14)
                isSelected = page == key; contentDescription = "$name${if (isSelected) "，已选择" else ""}"
                setOnClickListener {
                    if (key == "messages") startActivity(Intent(this@RabiRecordingHubActivity, MainActivity::class.java).putExtra("open_messages", true))
                    else { page = key; detail = null; render() }
                }
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }
    }
    private fun renderHome() {
        card().apply {
            val labels = LinearLayout(this@RabiRecordingHubActivity)
            listOf("暂停", "录音", "视频录像").forEachIndexed { index, text -> labels.addView(label(text, 15f, if (mode == index) ink else muted).apply {
                gravity = Gravity.CENTER; typeface = if (mode == index) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                minHeight = dp(48); setOnClickListener { chooseMode(index) }
            }, LinearLayout.LayoutParams(0, -2, 1f)) }
            addView(labels)
            addView(SeekBar(this@RabiRecordingHubActivity).apply {
                max = 100; progress = this@RabiRecordingHubActivity.mode * 50; minHeight = dp(48); progressTintList = android.content.res.ColorStateList.valueOf(pink)
                thumbTintList = android.content.res.ColorStateList.valueOf(ink); contentDescription = "采集模式：暂停、录音、视频录像"
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    private var dragging = false
                    override fun onStartTrackingTouch(bar: SeekBar?) { dragging = true }
                    override fun onStopTrackingTouch(bar: SeekBar?) { dragging = false; val target = (bar!!.progress + 25) / 50; main.post { chooseMode(target) } }
                    override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) {
                        if (fromUser && !dragging && bar?.isPressed == false) main.post { chooseMode((progress + 25) / 50) }
                    }
                })
            })
        }
        val capture = card()
        captureStatus = label("", 17f).also { it.typeface = Typeface.DEFAULT_BOLD; capture.addView(it) }
        if (mode == 0) {
            capture.addView(label("记录留在手机，随时可以回来查看。\n滑动选择录音或视频，再点击开始。", 15f, muted))
            capture.addView(button("查看最近记录") { page = "records"; render() })
        } else {
            clock = Chronometer(this).apply { textSize = 36f; setTextColor(ink); typeface = Typeface.MONOSPACE }.also { capture.addView(it) }
            if (mode == 1) {
                capture.addView(label("声音来源", 13f, muted))
                val row = LinearLayout(this)
                listOf("phone" to "手机麦克风", "glasses" to "眼镜麦克风").forEach { (key, value) -> row.addView(button((if (source == key) "✓ " else "") + value) {
                    if (CaptureOwnership.current().isNotEmpty()) { toast("请先停止并保存，再切换声音来源"); return@button }
                    source = key; getSharedPreferences("rabi_capture_ui", MODE_PRIVATE).edit().putString("source", source).apply(); render()
                }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(4) }) }
                capture.addView(row)
                meter = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100; progressTintList = android.content.res.ColorStateList.valueOf(pink); contentDescription = "当前声音输入电平"
                }.also { capture.addView(it, LinearLayout.LayoutParams(-1, dp(18))) }
                capture.addView(label("本地保存 WAV · 不需要电脑或互联网\n本地录音暂不自动转写；已接收的转写在记录页查看。", 13f, muted))
            } else {
                addPreview(capture)
                capture.addView(label("眼镜画面 · 视频包含声音\n预览静音，录像保留原声音。", 13f, muted))
                capture.addView(button("开播连接步骤") { showStreamGuide() })
            }
            action = button("开始", true) {
                if (CaptureOwnership.current().isNotEmpty()) stopAll()
                else if (mode == 1) startAudio() else startVideo(false)
            }
        }
        card().apply { addView(label("手机先记录，电脑稍后连接", 16f)); addView(label("离线不影响本地保存。消息和依赖电脑的处理需要恢复连接。", 13f, muted)) }
    }
    private fun chooseMode(next: Int) {
        if (next == mode) return
        android.util.Log.i("RabiCaptureUi", "selected_mode=$next active=${CaptureOwnership.current()}")
        if (CaptureOwnership.current().isNotEmpty()) stopAll()
        mode = next; getSharedPreferences("rabi_capture_ui", MODE_PRIVATE).edit().putInt("mode", mode).apply(); render()
    }
    private fun addPreview(parent: LinearLayout) {
        preview = PlayerView(this).apply { setBackgroundColor(ink); useController = detail != null }
        parent.addView(preview, LinearLayout.LayoutParams(-1, dp(220)))
        previewMessage = label("等待眼镜画面", 13f, muted).also { parent.addView(it) }
        parent.addView(button("全屏查看") {
            val view = preview ?: return@button
            val oldParent = view.parent as android.view.ViewGroup
            val position = oldParent.indexOfChild(view); val params = view.layoutParams
            oldParent.removeView(view)
            val dialog = android.app.Dialog(this, android.R.style.Theme_Material_NoActionBar_Fullscreen)
            val full = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
            full.addView(view, LinearLayout.LayoutParams(-1, 0, 1f))
            full.addView(button("退出全屏") { dialog.dismiss() }); dialog.setContentView(full)
            dialog.setOnDismissListener { full.removeView(view); if (!isDestroyed) oldParent.addView(view, position, params) }
            dialog.show()
        })
    }
    private fun startAudio() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 9044); return
        }
        prepareCapture()
        if (CaptureOwnership.current().isNotEmpty()) { toast("正在保存上一段，请保存完成后点击开始"); return }
        startForegroundService(Intent(this, RabiLocalAudioService::class.java).putExtra("source", source))
    }
    private fun startVideo(auto: Boolean) {
        prepareCapture()
        if (CaptureOwnership.current().isNotEmpty()) { toast("正在保存上一段，请保存完成后点击开始"); return }
        startForegroundService(Intent(this, RabiLiveRecordingService::class.java).apply { if (auto) action = RabiLiveRecordingService.AUTO })
    }
    private fun prepareCapture() {
        RabiConversationServiceState.setRestoreEnabled(this, false)
        RabiConversationService.pauseForLocalCapture()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9045)
    }
    private fun stopAll() {
        RabiConversationServiceState.setRestoreEnabled(this, false)
        when (CaptureOwnership.current()) {
            "audio" -> startService(Intent(this, RabiLocalAudioService::class.java).setAction(RabiLocalAudioService.STOP))
            "video" -> startService(Intent(this, RabiLiveRecordingService::class.java).setAction(RabiLiveRecordingService.STOP))
            "conversation" -> RabiConversationService.pauseForLocalCapture()
        }
    }
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, grants: IntArray) {
        super.onRequestPermissionsResult(code, permissions, grants)
        if (code == 9044) { if (grants.firstOrNull() == PackageManager.PERMISSION_GRANTED) startAudio() else toast("未获录音权限，未开始采集") }
    }
    private fun refreshCapture() {
        val owner = CaptureOwnership.current()
        val state = when (owner) { "audio" -> RabiLocalAudioService.status; "video" -> live?.status ?: "正在连接录像状态"; "conversation" -> "会话录音正在进行"; else -> if (mode == 0) "采集已暂停" else if (mode == 1) RabiLocalAudioService.status else live?.status ?: "尚未开始接收" }
        captureStatus?.text = state
        persistent?.visibility = if (owner.isEmpty()) View.GONE else View.VISIBLE
        persistent?.text = "● $state   ·   停止并保存"
        meter?.progress = RabiLocalAudioService.level
        val since = when (owner) { "audio" -> RabiLocalAudioService.started; "video" -> if (live?.receiving == true) live!!.receivedAt else 0; else -> 0 }
        clock?.let { if (since > 0) { it.base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - since); it.start() } else { it.stop(); it.text = "00:00" } }
        action?.text = if (owner.isNotEmpty()) "停止并保存" else if (mode == 1) "开始录音" else "开始接收眼镜视频"
        action?.isEnabled = !state.startsWith("正在保存") && !state.startsWith("正在停止")
        if (page == "home" && mode == 2 && detail == null) {
            val current = live
            if (current?.receiving == true) playLive("rtsp://127.0.0.1:8554/rabi/${current.streamKey}")
            else if (playing.startsWith("rtsp:")) { releasePlayer(); previewMessage?.text = "等待眼镜画面" }
        }
    }
    private fun newPlayer(): ExoPlayer = ExoPlayer.Builder(this).setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(500, 3000, 150, 300).build()).build().also {
        player = it; preview?.player = it
        it.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() { previewMessage?.text = if (playing.startsWith("rtsp:")) "实时画面 · 预览静音，录像有声音" else "正在回看 · 含原声音" }
            override fun onPlayerError(error: PlaybackException) { previewMessage?.text = "画面加载失败；录像保存不受预览影响"; playing = "" }
        })
    }
    private fun playLive(uri: String) {
        if (!active || playing == uri || preview == null) return
        releasePlayer(); playing = uri
        newPlayer().apply {
            trackSelectionParameters = trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build()
            setMediaSource(RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(MediaItem.fromUri(uri))); prepare(); playWhenReady = true
        }
    }
    private fun releasePlayer() { preview?.player = null; player?.release(); player = null; playing = "" }
    private fun showStreamGuide() {
        val current = live ?: return
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(12), dp(20), dp(12)) }
        panel.addView(label("1  眼镜与手机连接同一 Wi-Fi，或连接手机热点。\n2  在首页开始接收。\n3  复制地址与密钥，在乐奇直播中填写并开播。\n4  返回首页查看画面。", 15f))
        current.urls().forEach { url -> panel.addView(button("复制本地推流地址") { copy(url) }) }
        if (current.urls().isEmpty()) panel.addView(label("尚未发现本地网络，请先开启热点或 Wi-Fi。"))
        panel.addView(button("复制推流密钥") { copy(current.streamKey) })
        panel.addView(button("打开乐奇 App") { packageManager.getLaunchIntentForPackage("com.rokid.sprite.aiapp")?.let { startActivity(it) } ?: toast("未找到乐奇 App") })
        panel.addView(label("自动开播组件仍在安装验收中。", 13f, muted))
        panel.addView(button("测试自动连接（实验）") { if (CaptureOwnership.current().isEmpty()) startVideo(true) else if (CaptureOwnership.current() == "video") startForegroundService(Intent(this, RabiLiveRecordingService::class.java).setAction(RabiLiveRecordingService.AUTO)) })
        AlertDialog.Builder(this).setTitle("眼镜开播").setView(ScrollView(this).apply { addView(panel) }).setPositiveButton("完成", null).show()
    }
    private fun renderRecords() {
        val host = card(); host.addView(label("正在读取手机记录…", 15f, muted))
        val generation = renderGeneration
        worker.execute {
            val result = runCatching { RecordingStore(this).list() }
            val transcripts = runCatching { RabiChatStore(this).list().filter { it.kind == "voice" && it.text.isNotBlank() }.takeLast(40) }.getOrDefault(emptyList())
            main.post {
                if (isDestroyed || renderGeneration != generation) return@post
                host.removeAllViews()
                val entries = result.getOrNull()
                if (entries == null) host.addView(label("记录读取失败，原文件未更改。"))
                else if (entries.isEmpty()) host.addView(label("还没有本地记录。回到首页，留下第一段声音或画面。", 16f, muted))
                entries?.forEach { entry ->
                    val name = entry.title.ifBlank { if (entry.kind == "video") "眼镜视频" else if (entry.source == "phone") "手机录音" else "眼镜录音" }
                    val current = entry.id == live?.sessionId || entry.id == RabiLocalAudioService.sessionId
                    val duration = if (entry.kind == "audio" && entry.files.isNotEmpty()) " · ${((entry.files.sumOf { it.length() } - 44).coerceAtLeast(0) / 32000)} 秒" else ""
                    host.addView(button("$name · ${date(entry.started)}\n${if (entry.state == "legacy") "旧版 ${entry.files.size} 个分段，展开查看" else if (current) "录制中" else if (entry.state == "recording") "上次录制中断" else if (entry.state == "interrupted") "保存中断，请检查内容" else "已存手机"}$duration") {
                        if (current) toast("请先停止并保存，再回看") else { detail = entry; render() }
                    })
                }
                host.addView(label("已接收的转写", 18f).apply { typeface = Typeface.DEFAULT_BOLD })
                if (transcripts.isEmpty()) host.addView(label("暂无转写。本地录音已保存，尚未自动提交转写。", 13f, muted))
                transcripts.reversed().forEach { item -> host.addView(label("${date(item.createdAt)}\n${item.text}", 15f)) }
            }
        }
    }
    private fun renderDetail(entry: RecordingStore.Entry) {
        if (entry.state == "legacy") {
            card().apply {
                addView(label("旧版没有保存会话信息，这里保留原始分段，不猜测哪些属于同一次录像。", 14f, muted))
                entry.files.forEach { file -> addView(button("${date(file.lastModified())} · ${file.length() / 1024} KiB") {
                    detail = entry.copy(id = file.name, state = "saved", files = listOf(file)); render()
                }) }
                addView(button("返回记录") { detail = null; render() })
            }
            return
        }
        card().apply {
            addView(label(date(entry.started), 15f, muted)); addPreview(this)
            addView(label(if (entry.files.size > 1) "一次录像 · ${entry.files.size} 段连续回看" else "保存在手机的原始记录", 13f, muted))
            addView(button("播放 / 重新播放", true) { playFiles(entry) })
            addView(button(if (entry.files.size > 1) "分享全部原始分段" else "分享 / 导出") { share(entry) })
            addView(button("返回记录列表") { detail = null; render() })
        }
        if (active) playFiles(entry)
    }
    private fun playFiles(entry: RecordingStore.Entry) {
        if (entry.state == "legacy") return
        if (entry.files.isEmpty()) { previewMessage?.text = "此记录没有可播放文件"; return }
        releasePlayer(); playing = entry.id
        newPlayer().apply { setMediaItems(entry.files.map { MediaItem.fromUri(Uri.fromFile(it)) }); prepare(); playWhenReady = true }
        preview?.useController = true
        previewMessage?.text = "本机回放 · 声音已开启"
    }
    private fun share(entry: RecordingStore.Entry) {
        if (entry.files.isEmpty()) { toast("没有可导出的文件"); return }
        val uris = ArrayList(entry.files.map { FileProvider.getUriForFile(this, "$packageName.files", it) })
        val send = Intent(if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
            type = if (entry.kind == "video") "video/mp4" else "audio/wav"
            if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris.first()) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newUri(contentResolver, "本地记录", uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        }
        startActivity(Intent.createChooser(send, "保存或分享原始记录"))
    }
    private fun renderDevices() {
        card().apply {
            addView(label("乐奇眼镜", 19f).apply { typeface = Typeface.DEFAULT_BOLD })
            val authorized = !getSharedPreferences("rokid_probe", MODE_PRIVATE).getString("rokid_token", "").isNullOrBlank()
            addView(label("授权：${if (authorized) "已保存" else "尚未完成"}\n声音：${if (CaptureOwnership.current() == "audio" && source == "glasses" && RabiLocalAudioService.started > 0) "正在接收" else "尚未在本页验证连接"}\n视频：${if (live?.receiving == true) "正在接收" else "尚未收到画面"}", 14f, muted))
            addView(button("连接与授权") { if (CaptureOwnership.current().isNotEmpty()) toast("请先停止录制，再进入设备诊断") else startActivity(Intent(this@RabiRecordingHubActivity, RokidProbeActivity::class.java)) })
            addView(button("视频开播步骤") { mode = 2; showStreamGuide() })
        }
        card().apply {
            addView(label("电脑与助手", 19f)); addView(label("配置消息连接与处理助手。连接不可用时，手机仍可本地记录。", 14f, muted))
            addView(button("连接电脑 / 高级设置") { startActivity(Intent(this@RabiRecordingHubActivity, MainActivity::class.java).putExtra("open_settings", true)) })
        }
        card().apply { addView(label("手表与手环", 19f)); addView(button("管理健康设备") { startActivity(Intent(this@RabiRecordingHubActivity, WearableHealthSettingsActivity::class.java)) }) }
        card().apply {
            addView(label("启动偏好", 19f))
            addView(Switch(this@RabiRecordingHubActivity).apply {
                text = "启动时尝试自动视频（实验）"; minHeight = dp(52)
                val prefs = getSharedPreferences("rabi_live_recorder", MODE_PRIVATE)
                isChecked = prefs.getBoolean("auto_start_video", false)
                setOnCheckedChangeListener { _, enabled -> prefs.edit().putBoolean("auto_start_video", enabled).apply() }
            })
            addView(label("自有眼镜组件尚未安装验收；默认关闭。视频包含声音，不同时开启独立录音。", 13f, muted))
        }
    }
    private fun copy(value: String) { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("眼镜开播参数", value)); toast("已复制") }
    private fun toast(value: String) = Toast.makeText(this, value, Toast.LENGTH_SHORT).show()
    private fun date(value: Long) = SimpleDateFormat("MM月dd日 HH:mm", Locale.CHINA).format(Date(value))
}
