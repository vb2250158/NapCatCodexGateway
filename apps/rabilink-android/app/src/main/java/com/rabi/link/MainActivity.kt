package com.rabi.link

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.text.TextWatcher
import android.view.inputmethod.EditorInfo
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import com.rabi.link.modules.rokid.RokidDeviceStatusSyncService
import com.rabi.link.modules.rokid.RokidProbeActivity
import com.rabi.link.modules.wearable.WearableHealthSettingsActivity
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture

/** Phone companion: glasses backend and Relay transport, not a duplicate Rabi PC configuration UI. */
class MainActivity : Activity() {
    private val requestPhoneAudio = 9031
    private val requestPhoneMedia = 9032
    private val requestNotifications = 9033
    private val sdk = RabiRouteSdk()
    private val discoverySdk = RabiRouteSdk(timeoutMs = 160)
    private val pcs = mutableListOf<RabiLinkPc>()
    private val discoveredManagers = mutableListOf<RabiInstance>()
    private lateinit var relayUrl: EditText
    private lateinit var relayToken: EditText
    private lateinit var relayUrlHelp: TextView
    private lateinit var relayTokenHelp: TextView
    private lateinit var pcHelp: TextView
    private lateinit var pcSpinner: Spinner
    private lateinit var pcAdapter: ArrayAdapter<String>
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private lateinit var discoveredPcAction: Button
    private lateinit var advancedSettings: LinearLayout
    private lateinit var runtimeStatus: TextView
    private lateinit var runtimeTranscript: TextView
    private lateinit var runtimeReply: TextView
    private lateinit var runtimeCaptureHealth: TextView
    private lateinit var runtimeMode: TextView
    private lateinit var runtimeConnection: TextView
    private lateinit var runtimeRoute: TextView
    private lateinit var runtimeGlasses: TextView
    private lateinit var runtimeQueue: TextView
    private lateinit var runtimeError: TextView
    private val runtimeHandler = Handler(Looper.getMainLooper())
    private var captureBar: Button? = null
    private val captureListener = Runnable { runtimeHandler.post { refreshCaptureBar() } }
    private fun refreshCaptureBar() {
        val owner = com.rabi.link.recording.CaptureOwnership.current()
        captureBar?.apply {
            visibility = if (owner.isEmpty()) View.GONE else View.VISIBLE
            text = when (owner) {
                "audio" -> "● 正在录音 · 停止并保存"
                "video" -> "● 视频接收已开启 · 停止并保存"
                else -> "● 语音采集中 · 停止并保存"
            }
        }
    }
    private lateinit var inputMode: Spinner
    private lateinit var proactivityPreference: Spinner
    private lateinit var autoStartVoiceService: Switch
    private lateinit var directVideo: Switch
    private lateinit var autoPlayAgentVoice: Switch
    private lateinit var ttsModel: EditText
    private lateinit var ttsVoice: EditText
    private lateinit var audioRetentionHours: EditText
    private lateinit var audioMaxStorageMb: EditText
    private lateinit var audioReserveFreeMb: EditText
    private enum class Screen { SETUP, CONVERSATIONS, CHAT, SETTINGS, CONFIG_ASSISTANT }
    private data class ConversationRow(
        val id: String,
        val title: String,
        val chatAvailable: Boolean,
        val running: Boolean,
        val latest: RabiChatStore.Message?,
        val unread: Int,
        val route: RabiRouteInfo? = null,
    )
    private data class AvatarTarget(
        val routeId: String,
        val roleId: String,
        val title: String,
        val image: ImageView,
        val status: TextView?,
    )

    private var selectedPc: RabiLinkPc? = null
    private var busy = false
    private var showingSettings = false
    private var screen = Screen.SETUP
    private var settingsReturnScreen = Screen.CONVERSATIONS
    private var activeRouteId = ""
    private var mediaTargetRouteId = ""
    private var listScrollY = 0
    private var chatMessages: LinearLayout? = null
    private var chatScroll: ScrollView? = null
    private var composer: EditText? = null
    private var conversationListHost: LinearLayout? = null
    private var conversationListScroll: ScrollView? = null
    private var availableRoutes: List<RabiRouteInfo> = emptyList()
    private var routesLoaded = false
    private var routeLoadFailed = false
    private var routeLoadMessage = "正在读取 Rabi PC 上的聊天人格…"
    private var lastChatRuntimeAt = 0L
    private var runtimeReceiverRegistered = false
    private val avatarTargets = mutableMapOf<String, MutableList<AvatarTarget>>()
    private val runtimeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == RabiPersonaAvatarEvents.ACTION_CHANGED) {
                refreshPersonaAvatar(intent.getStringExtra(RabiPersonaAvatarEvents.EXTRA_ROLE_ID).orEmpty())
            } else {
                refreshConversationRuntime()
                refreshChatIfChanged()
            }
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (!intent.getBooleanExtra("open_messages", false) && !intent.getBooleanExtra("open_settings", false) && intentRoute(intent).isBlank()) {
            startActivity(Intent(this, com.rabi.link.recording.RabiRecordingHubActivity::class.java)
                .putExtra("video", intent.getBooleanExtra("open_offline_recorder", false))
                .putExtra("auto_video", state == null && getSharedPreferences("rabi_live_recorder", MODE_PRIVATE).getBoolean("auto_start_video", false)))
            finish()
            return
        }
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.configured) availableRoutes = RabiRouteMetadataCache.load(this, saved)
        activeRouteId = intentRoute(intent).ifBlank { state?.getString("active_route_id").orEmpty() }
        listScrollY = state?.getInt("conversation_list_scroll_y", 0) ?: 0
        val restored = runCatching { Screen.valueOf(state?.getString("screen").orEmpty()) }.getOrNull()
        when {
            !saved.configured -> showSettings(saved, true)
            intent.getBooleanExtra("open_settings", false) -> showSettings(saved, false)
            activeRouteId.isNotBlank() -> showConversationDetail(activeRouteId)
            restored == Screen.SETTINGS -> showSettings(saved, false)
            else -> showConversationList()
        }
        if (saved.configured && saved.statusSyncEnabled && com.rabi.link.recording.CaptureOwnership.current().isEmpty()) RokidDeviceStatusSyncService.start(this)
        val conversation = RabiConversationSettings.load(this)
        when (RabiConversationStartupPolicy.decide(
            saved.configured,
            RabiConversationServiceState.shouldRestore(this),
            conversation,
            checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED,
        )) {
            RabiConversationStartupPolicy.Action.START_VOICE -> RabiConversationService.restoreAfterBoot(this)
            RabiConversationStartupPolicy.Action.RESTORE_TRANSPORT -> RabiConversationService.restoreAfterBoot(this)
            RabiConversationStartupPolicy.Action.NONE -> Unit
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), requestNotifications)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val routeProfileId = intentRoute(intent)
        when {
            routeProfileId.isNotBlank() -> showConversationDetail(routeProfileId)
            intent?.getBooleanExtra("open_settings", false) == true -> showSettings()
        }
    }

    private fun intentRoute(intent: Intent?): String = intent?.getStringExtra("route_profile_id")?.trim().orEmpty()

    override fun setContentView(view: View) {
        val shell = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        shell.addView(view, LinearLayout.LayoutParams(-1, 0, 1f))
        captureBar = Button(this).apply {
            text = "● 采集正在进行 · 停止并保存"; minHeight = dp(48)
            setOnClickListener {
                when (com.rabi.link.recording.CaptureOwnership.current()) {
                    "audio" -> startService(Intent(this@MainActivity, com.rabi.link.modules.rokid.RabiLocalAudioService::class.java).setAction(com.rabi.link.modules.rokid.RabiLocalAudioService.STOP))
                    "video" -> startService(Intent(this@MainActivity, com.rabi.link.modules.rokid.RabiLiveRecordingService::class.java).setAction(com.rabi.link.modules.rokid.RabiLiveRecordingService.STOP))
                    "conversation" -> RabiConversationService.pauseForLocalCapture()
                }
                text = "正在保存，请在首页查看结果"
            }
        }
        shell.addView(captureBar)
        refreshCaptureBar()
        val navigation = LinearLayout(this).apply { setBackgroundColor(RabiMobileUi.surface) }
        listOf("home" to "首页", "records" to "记录", "messages" to "消息", "devices" to "设备").forEach { (key, label) ->
            navigation.addView(Button(this).apply {
                text = label; isAllCaps = false; minHeight = dp(52); setTextColor(Color.rgb(16, 42, 67))
                setOnClickListener {
                    if (key == "messages") showConversationList()
                    else {
                        startActivity(Intent(this@MainActivity, com.rabi.link.recording.RabiRecordingHubActivity::class.java)
                            .putExtra("page", key).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                        finish()
                    }
                }
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        shell.addView(navigation); super.setContentView(shell)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("screen", screen.name)
        outState.putString("active_route_id", activeRouteId)
        outState.putInt("conversation_list_scroll_y", conversationListScroll?.scrollY ?: listScrollY)
        super.onSaveInstanceState(outState)
    }

    override fun onBackPressed() {
        when (screen) {
            Screen.CHAT -> showConversationList()
            Screen.SETTINGS -> if (settingsReturnScreen == Screen.CHAT && activeRouteId.isNotBlank()) showConversationDetail(activeRouteId) else showConversationList()
            Screen.CONFIG_ASSISTANT -> showSettings()
            Screen.SETUP, Screen.CONVERSATIONS -> super.onBackPressed()
        }
    }

    private fun showSettings(saved: RabiLinkRelayConfig = RabiLinkRelaySettings.load(this), firstRun: Boolean = !saved.configured) {
        if (!firstRun && screen != Screen.SETTINGS && screen != Screen.SETUP) settingsReturnScreen = screen
        screen = if (firstRun) Screen.SETUP else Screen.SETTINGS
        showingSettings = true
        avatarTargets.clear()
        chatMessages = null; chatScroll = null; composer = null; conversationListHost = null; conversationListScroll = null
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        if (!firstRun) root.addView(appBar("设置", "连接、设备与诊断", "返回") { onBackPressed() })
        root.addView(primary("眼镜离线录像 · 无需联网") {
            startActivity(Intent(this, com.rabi.link.modules.rokid.RabiLiveRecordingActivity::class.java))
        })
        root.addView(buildUi(), LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        if (saved.baseUrl.isNotBlank()) {
            relayUrl.setText(saved.baseUrl)
            setUrlHelp("已填入上次验证过的服务器地址。App 会自动重新检查它是否可用。", RabiGuidanceTone.SUCCESS)
        }
        if (saved.token.isNotBlank()) {
            relayToken.setText(saved.token)
            setTokenHelp("已安全保存登录码。这里不会显示明文，也不会把它写入日志。", RabiGuidanceTone.SUCCESS)
        }
        loadConversationSettings()
        autoPrepareSetup(saved)
    }

    private fun showConversationList() {
        screen = Screen.CONVERSATIONS
        showingSettings = false
        activeRouteId = ""
        avatarTargets.clear()
        chatMessages = null; chatScroll = null; composer = null
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        root.addView(appBar("消息", "选择一个人格开始聊天", null, "设置") { showSettings() })
        conversationListHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.surface) }
        conversationListScroll = ScrollView(this).apply {
            isFillViewport = true
            addView(conversationListHost)
            setOnScrollChangeListener { _, _, scrollY, _, _ -> listScrollY = scrollY }
        }
        root.addView(conversationListScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        renderConversationList()
        loadRouteTargets()
    }

    private fun showConversationDetail(routeProfileId: String) {
        val routeId = routeProfileId.trim()
        if (routeId.isBlank()) return showConversationList()
        screen = Screen.CHAT
        showingSettings = false
        activeRouteId = routeId
        avatarTargets.clear()
        RabiConversationTarget.save(this, routeId)
        conversationListHost = null; conversationListScroll = null
        val route = availableRoutes.firstOrNull { it.id == routeId }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        root.addView(appBar(routeTitle(routeId), routeStatus(route), "返回", avatarRoute = route) { showConversationList() })
        chatMessages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(18)) }
        chatScroll = ScrollView(this).apply { addView(chatMessages) }
        root.addView(chatScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val canSend = route?.let(::isRouteChatCapable) ?: !routesLoaded
        if (canSend) {
            val bottom = row().apply { setPadding(dp(8), dp(8), dp(8), dp(10)); setBackgroundColor(Color.WHITE); gravity = Gravity.BOTTOM }
            bottom.addView(secondary("附件") { pickPhoneMedia() }, LinearLayout.LayoutParams(dp(68), dp(52)))
            composer = input("发消息给 ${routeTitle(routeId)}").apply {
                setSingleLine(false); minLines = 1; maxLines = 5
                gravity = Gravity.TOP or Gravity.START
                setPadding(dp(14), dp(12), dp(14), dp(12))
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                imeOptions = EditorInfo.IME_ACTION_SEND
                setText(RabiChatStore(this@MainActivity).draft(routeId))
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) =
                        RabiChatStore(this@MainActivity).saveDraft(routeId, value?.toString().orEmpty())
                    override fun afterTextChanged(value: Editable?) = Unit
                })
                setOnEditorActionListener { _, actionId, event ->
                    val sendAction = actionId == EditorInfo.IME_ACTION_SEND
                        || (event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN && !event.isShiftPressed)
                    if (sendAction) sendComposer()
                    sendAction
                }
            }
            bottom.addView(composer, LinearLayout.LayoutParams(0, -2, 1f).apply { setMargins(dp(8), 0, dp(8), 0) })
            bottom.addView(primary("发送") { sendComposer() }, LinearLayout.LayoutParams(dp(72), dp(52)))
            root.addView(bottom)
        } else {
            root.addView(RabiMobileUi.guidance(this, RabiSetupGuidance(
                "这个人格当前不能发送消息",
                if (route == null) "Rabi PC 已不再发布这个会话；历史消息仍可查看。" else "对应 RabiLink 消息端尚未启用。",
                "打开设置里的远程配置，启用该人格的 RabiLink 消息端。",
                RabiGuidanceTone.WARNING,
            )).apply { setOnClickListener { showSettings() } })
        }
        setContentView(root)
        renderChat()
        loadRouteTargets()
    }

    private fun showConfigurationAssistant() {
        screen = Screen.CONFIG_ASSISTANT
        showingSettings = false
        avatarTargets.clear()
        val routeId = RabiConversationTarget.load(this).ifBlank {
            availableRoutes.firstOrNull(::isRouteChatCapable)?.id.orEmpty()
        }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        root.addView(appBar("配置助手", "独立于普通聊天", "返回") { showSettings() })
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(28))
            addView(RabiMobileUi.guidance(this@MainActivity, RabiSetupGuidance(
                "先描述你想检查或调整什么",
                "配置请求会交给 ${if (routeId.isBlank()) "当前 Rabi PC" else routeTitle(routeId)}；删除、停止、覆盖和外部动作仍需经过 Rabi PC 安全门。",
                "如果你知道具体字段，优先回到设置在对应输入框中修改；这里适合不知道字段名时求助。",
                RabiGuidanceTone.INFO,
            )), full(0, 0, 0, 12))
            val request = input("例如：帮我检查为什么手机收不到夜雨的回复").apply {
                setSingleLine(false); minLines = 4; maxLines = 8
                gravity = Gravity.TOP or Gravity.START
                setPadding(dp(14), dp(12), dp(14), dp(12))
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            }
            addView(label("配置请求")); addView(request, full(0, 0, 0, 6))
            addView(RabiMobileUi.fieldHelp(this@MainActivity,
                "请写清“想达到什么结果”和“现在看到什么失败”。助手不会绕过确认，也不会把失败说成成功。"), full(0, 0, 0, 8))
            addView(primary("交给 Rabi 检查") {
                val text = request.text.toString().trim()
                if (text.isBlank()) return@primary toast("请先描述要检查的配置")
                if (routeId.isBlank()) return@primary toast("还没有可用聊天人格，请先在远程配置中启用 RabiLink 消息端")
                RabiConversationService.sendConfigurationRequest(this@MainActivity, text, routeId)
                request.text.clear()
                toast("配置请求已进入安全队列；结果会回到对应会话")
            }, full(0, 4, 0, 8))
            addView(secondary("我知道字段，打开远程配置") { openRemoteConfig() }, full(0, 0, 0, 0))
        }
        root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun appBar(title: String, subtitle: String, leading: String? = null, trailing: String? = null, avatarRoute: RabiRouteInfo? = null, action: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8)); setBackgroundColor(RabiMobileUi.surface)
            if (leading != null) addView(RabiMobileUi.compactAction(this@MainActivity, leading, action), LinearLayout.LayoutParams(-2, dp(48)).apply { setMargins(0, 0, dp(10), 0) })
            val avatar = RabiMobileUi.avatar(this@MainActivity, title)
            avatarRoute?.let { bindPersonaAvatar(it, avatar, null) }
            addView(avatar, LinearLayout.LayoutParams(dp(44), dp(44)).apply { setMargins(0, 0, dp(10), 0) })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply { text = title; textSize = 20f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.primary) })
                addView(TextView(this@MainActivity).apply { text = subtitle; textSize = 12f; maxLines = 2; setTextColor(RabiMobileUi.muted) })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            if (trailing != null) addView(RabiMobileUi.compactAction(this@MainActivity, trailing, action), LinearLayout.LayoutParams(-2, dp(48)))
        }

    private fun loadRouteTargets() {
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return
        routesLoaded = false
        routeLoadFailed = false
        routeLoadMessage = "正在读取 Rabi PC 上的聊天人格…"
        runAsync({ sdk.getMobileRoutes(relay.baseUrl, relay.token, "") }, { routes ->
            routesLoaded = true; routeLoadFailed = false
            // The mobile endpoint includes every installed persona. Routes with a
            // RabiLink adapter remain chat-capable; persona-only rows stay visible
            // with the existing configuration guidance instead of disappearing.
            availableRoutes = routes
            RabiRouteMetadataCache.save(this@MainActivity, relay, routes)
            val enabled = availableRoutes.filter(::isRouteChatCapable)
            val savedTarget = RabiConversationTarget.load(this)
            val migrationTarget = enabled.firstOrNull { it.id == savedTarget }?.id ?: enabled.singleOrNull()?.id.orEmpty()
            RabiChatStore(this).migrateLegacyMessages(migrationTarget)
            if (screen == Screen.CONVERSATIONS) renderConversationList()
            if (screen == Screen.CHAT) renderChat()
        }, error = { error ->
            routesLoaded = true; routeLoadFailed = true
            val unauthorized = error.message.orEmpty().contains("unauthorized", ignoreCase = true) || error.message.orEmpty().contains("401")
            routeLoadMessage = if (unauthorized) {
                "移动端登录已失效，请到设置重新粘贴登录码。"
            } else {
                "暂时无法从 Rabi PC 更新人格与入口状态；这不代表所有入口都已掉线。"
            }
            if (screen == Screen.CONVERSATIONS) renderConversationList()
            if (screen == Screen.CHAT) renderChat()
        })
    }

    private fun renderConversationList() {
        val host = conversationListHost ?: return
        host.removeAllViews()
        avatarTargets.clear()
        if (!routesLoaded && availableRoutes.isEmpty()) {
            host.addView(conversationEmpty("正在加载会话", routeLoadMessage, "重新加载") { loadRouteTargets() })
            return
        }
        val store = RabiChatStore(this)
        val routeIds = availableRoutes.map { it.id }.toMutableSet()
        val rows = availableRoutes.filter { RabiConversationRules.isVisibleInConversationList(it.id) }.map { route ->
            ConversationRow(route.id, personaTitle(route),
                isRouteChatCapable(route), route.running,
                store.latest(route.id), store.unreadCount(route.id), route)
        }.toMutableList()
        store.conversationIds().filter { it !in routeIds }.forEach { id ->
            rows.add(ConversationRow(id, if (id == RabiConversationRules.LEGACY_CONVERSATION_ID) "Rabi（旧会话）" else "已下线会话",
                false, false, store.latest(id), store.unreadCount(id)))
        }
        rows.sortWith(compareByDescending<ConversationRow> { it.latest?.createdAt ?: 0L }.thenBy { it.title })
        if (rows.isEmpty()) {
            host.addView(conversationEmpty(
                if (routeLoadFailed) "还没能读取聊天人格" else "还没有可聊天的人格",
                if (routeLoadFailed) routeLoadMessage else "Rabi PC 当前没有启用 RabiLink 消息端。健康手表路由不会再被误当成聊天对象。",
                if (routeLoadFailed) "重新加载" else "打开设置",
            ) { if (routeLoadFailed) loadRouteTargets() else showSettings() })
            return
        }
        if (!routesLoaded || routeLoadFailed) {
            host.addView(RabiMobileUi.guidance(this, RabiSetupGuidance(
                if (routeLoadFailed) "状态暂未刷新" else "正在刷新入口状态",
                if (routeLoadFailed) routeLoadMessage else "当前先显示上次安全缓存的人格列表。",
                if (routeLoadFailed) "检查手机与 Rabi PC 的连接后点按重试。" else "刷新完成后会自动更新每个入口。",
                if (routeLoadFailed) RabiGuidanceTone.WARNING else RabiGuidanceTone.INFO,
            )).apply { setOnClickListener { loadRouteTargets() } })
        }
        rows.forEachIndexed { index, item ->
            host.addView(conversationRow(item))
            if (index < rows.lastIndex) host.addView(View(this).apply { setBackgroundColor(RabiMobileUi.border) }, LinearLayout.LayoutParams(-1, dp(1)).apply { setMargins(dp(76), 0, 0, 0) })
        }
        conversationListScroll?.post { conversationListScroll?.scrollTo(0, listScrollY) }
    }

    private fun conversationRow(item: ConversationRow): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), dp(12), dp(14), dp(12)); setBackgroundColor(RabiMobileUi.surface)
        isClickable = true; isFocusable = true; minimumHeight = dp(76)
        val adapterStates = item.route?.let(::routeAdapterStates).orEmpty()
        val currentEndpointSummary = item.route?.let {
            RabiConversationRules.routeStatus(item.chatAvailable, item.running, adapterStates)
        }.orEmpty()
        val endpointSummary = when {
            currentEndpointSummary.isBlank() -> ""
            routeLoadFailed -> "上次状态 · 暂未刷新 · $currentEndpointSummary"
            !routesLoaded -> "上次状态 · 正在刷新 · $currentEndpointSummary"
            else -> currentEndpointSummary
        }
        contentDescription = "会话 ${item.title}${if (endpointSummary.isNotBlank()) "，$endpointSummary" else ""}${if (item.unread > 0) "，${item.unread} 条未读" else ""}"
        val avatar = RabiMobileUi.avatar(this@MainActivity, item.title)
        val avatarStatus = TextView(this@MainActivity).apply {
            textSize = 10f; setTextColor(RabiMobileUi.muted); gravity = Gravity.END
        }
        item.route?.let { bindPersonaAvatar(it, avatar, avatarStatus) }
        addView(avatar, LinearLayout.LayoutParams(dp(50), dp(50)).apply { setMargins(0, 0, dp(12), 0) })
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = item.title; textSize = 16f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.text); maxLines = 1
            })
            addView(TextView(this@MainActivity).apply {
                text = if (!item.chatAvailable) "尚未启用手机聊天 · 点按查看配置方法" else preview(item.latest)
                textSize = 13f; setTextColor(if (item.chatAvailable) RabiMobileUi.muted else Color.rgb(146, 64, 14)); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, dp(5), 0, 0)
            })
            if (item.route != null) addView(TextView(this@MainActivity).apply {
                text = endpointSummary
                textSize = 11f
                setTextColor(if (RabiConversationRules.adapterStatusNeedsAttention(adapterStates)) Color.rgb(146, 64, 14) else RabiMobileUi.secondary)
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(4), 0, 0)
            })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.END
            addView(TextView(this@MainActivity).apply { text = formatListTime(item.latest?.createdAt ?: 0); textSize = 11f; setTextColor(RabiMobileUi.muted); gravity = Gravity.END })
            if (item.route != null) addView(avatarStatus, LinearLayout.LayoutParams(-2, -2).apply { setMargins(0, dp(3), 0, 0) })
            if (item.unread > 0) addView(RabiMobileUi.unreadBadge(this@MainActivity, item.unread), LinearLayout.LayoutParams(-2, dp(24)).apply { setMargins(0, dp(7), 0, 0) })
        }, LinearLayout.LayoutParams(-2, -2))
        setOnClickListener { showConversationDetail(item.id) }
    }

    private fun conversationEmpty(title: String, reason: String, actionText: String, action: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(28), dp(72), dp(28), dp(28))
            addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.rabiroute_icon); contentDescription = "Rabi" }, LinearLayout.LayoutParams(dp(72), dp(72)))
            addView(TextView(this@MainActivity).apply { text = title; textSize = 19f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.primary); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(8)) })
            addView(TextView(this@MainActivity).apply { text = reason; textSize = 13f; setTextColor(RabiMobileUi.muted); gravity = Gravity.CENTER; setLineSpacing(0f, 1.15f) })
            addView(primary(actionText, action), LinearLayout.LayoutParams(-1, dp(52)).apply { setMargins(0, dp(18), 0, 0) })
        }

    private fun sendComposer() {
        val text = composer?.text?.toString()?.trim().orEmpty()
        if (text.isBlank() || activeRouteId.isBlank()) return
        val route = availableRoutes.firstOrNull { it.id == activeRouteId }
        if (routesLoaded && (route == null || !isRouteChatCapable(route))) {
            toast("这个会话当前不能发送，请先在设置中启用 RabiLink 消息端")
            return
        }
        RabiConversationService.sendText(this, text, activeRouteId)
        RabiChatStore(this).saveDraft(activeRouteId, "")
        composer?.text?.clear()
        runtimeHandler.postDelayed({ renderChat() }, 150)
    }

    private fun renderChat() {
        val host = chatMessages ?: return
        host.removeAllViews()
        val store = RabiChatStore(this)
        val messages = store.listForConversation(activeRouteId)
        if (messages.isEmpty()) host.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(24), dp(64), dp(24), dp(24))
            addView(TextView(this@MainActivity).apply { text = "开始和 ${routeTitle(activeRouteId)} 对话"; textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.primary); gravity = Gravity.CENTER })
            addView(TextView(this@MainActivity).apply { text = "这里的消息只属于当前会话；返回后可以选择其他人格。"; textSize = 13f; setTextColor(RabiMobileUi.muted); gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0) })
        })
        var previousDay = ""
        messages.forEach { message ->
            val mine = message.role == "user"
            val day = formatMessageDay(message.createdAt)
            if (day.isNotBlank() && day != previousDay) {
                host.addView(TextView(this).apply { text = day; textSize = 11f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.muted); gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(6)) })
                previousDay = day
            }
            val sender = if (mine) "你" else routeTitle(activeRouteId)
            val messageTime = formatMessageTime(message.createdAt)
            val group = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = if (mine) Gravity.END else Gravity.START }
            group.addView(TextView(this).apply {
                text = if (messageTime.isBlank()) sender else "$sender · $messageTime"
                textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) RabiMobileUi.muted else RabiMobileUi.secondary); setPadding(dp(4), 0, dp(4), dp(4))
            })
            val bubble = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; setPadding(dp(13), dp(10), dp(13), dp(10))
                background = panel(if (mine) RabiMobileUi.primary else Color.WHITE, if (mine) RabiMobileUi.primary else RabiMobileUi.border, 14)
                minimumWidth = dp(72)
            }
            val kindLabel = messageKindLabel(message.kind)
            if (kindLabel.isNotBlank()) bubble.addView(TextView(this).apply {
                text = kindLabel; textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) Color.rgb(190, 232, 234) else RabiMobileUi.secondary)
                setPadding(0, 0, 0, if (message.text.isBlank()) 0 else dp(5))
            })
            if (message.text.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.text; textSize = 15f; setTextColor(if (mine) Color.WHITE else RabiMobileUi.text); setLineSpacing(0f, 1.08f)
            })
            if (message.fileName.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.fileName; textSize = 13f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) Color.WHITE else RabiMobileUi.primary); setPadding(0, if (message.text.isBlank()) dp(2) else dp(8), 0, 0)
            })
            if (message.kind == "tts" && message.localPath.isNotBlank()) {
                bubble.addView(TextView(this).apply {
                    text = ttsPlaybackLabel(message); textSize = 12f
                    setTextColor(if (mine) Color.rgb(190, 232, 234) else RabiMobileUi.secondary)
                    setPadding(0, dp(7), 0, 0)
                })
                bubble.isClickable = true; bubble.contentDescription = "重播夜雨语音"
                bubble.setOnClickListener { RabiConversationService.replayTts(this, message.id, message.localPath) }
            } else if (message.localPath.isNotBlank()) {
                bubble.isClickable = true; bubble.contentDescription = "打开附件 ${message.fileName}"
                bubble.setOnClickListener { openAttachment(message) }
            }
            group.addView(bubble, LinearLayout.LayoutParams(-2, -2))
            if (mine && message.deliveryState.isNotBlank()) group.addView(TextView(this).apply {
                text = deliveryLabel(message); textSize = 11f
                setTextColor(if (message.deliveryState == "failed") Color.rgb(153, 27, 27) else RabiMobileUi.muted)
                gravity = Gravity.END; setPadding(dp(4), dp(3), dp(4), 0)
            })
            host.addView(group, LinearLayout.LayoutParams(-1, -2).apply { setMargins(if (mine) dp(42) else 0, dp(5), if (mine) 0 else dp(42), dp(5)) })
        }
        store.markRead(activeRouteId)
        RabiConversationService.clearConversationNotification(this, activeRouteId)
        chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun personaTitle(route: RabiRouteInfo): String =
        RabiConversationRules.personaDisplayName(route.personaDisplayName, route.agentRoleId, route.name, route.configName, route.id)

    private fun personaAvatarVersion(route: RabiRouteInfo): String =
        getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE).getString("version:${route.agentRoleId}", "").orEmpty()
            .ifBlank { route.avatarVersion }

    private fun personaAvatarUrl(route: RabiRouteInfo): String {
        val role = route.agentRoleId.trim()
        val version = personaAvatarVersion(route)
        val relay = RabiLinkRelaySettings.load(this)
        val configured = route.avatarConfigured || getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE).getBoolean("configured:$role", false)
        if (!configured || role.isBlank() || version.isBlank() || !relay.configured) return ""
        val encodedRole = java.net.URLEncoder.encode(role, "UTF-8")
        val encodedVersion = java.net.URLEncoder.encode(version, "UTF-8")
        return "${relay.baseUrl.trimEnd('/')}/api/rabilink/mobile/personas/$encodedRole/avatar?v=$encodedVersion"
    }

    private fun bindPersonaAvatar(route: RabiRouteInfo, image: ImageView, avatarStatus: TextView?, register: Boolean = true) {
        val role = route.agentRoleId.trim()
        val title = personaTitle(route)
        val avatarPreferences = getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE)
        val configured = route.avatarConfigured || avatarPreferences.getBoolean("configured:$role", false)
        if (register && role.isNotBlank()) {
            avatarTargets.getOrPut(role) { mutableListOf() }
                .add(AvatarTarget(route.id, role, title, image, avatarStatus))
        }
        val version = personaAvatarVersion(route)
        val url = personaAvatarUrl(route)
        if (role.isBlank() || version.isBlank() || url.isBlank()) {
            image.tag = "unavailable\u0000$role\u0000$version"
            image.setImageResource(R.drawable.ic_persona_avatar_placeholder)
            image.contentDescription = RabiAvatarLoadRules.placeholderContentDescription(title, configured)
            avatarStatus?.text = RabiAvatarLoadRules.unavailableLabel(configured)
            return
        }
        val relay = RabiLinkRelaySettings.load(this)
        RabiPersonaAvatarCache.load(this, image, url, relay.token, role, version) { state ->
            image.contentDescription = when (state) {
                RabiAvatarLoadRules.State.READY, RabiAvatarLoadRules.State.VALIDATING -> "$title 头像"
                RabiAvatarLoadRules.State.STALE -> "$title 头像（旧缓存）"
                RabiAvatarLoadRules.State.LOADING -> "$title 头像加载中"
                RabiAvatarLoadRules.State.UNAVAILABLE -> RabiAvatarLoadRules.placeholderContentDescription(title, configured = true)
            }
            if (state == RabiAvatarLoadRules.State.UNAVAILABLE) {
                image.setImageResource(R.drawable.ic_persona_avatar_placeholder)
            }
            avatarStatus?.text = when (state) {
                RabiAvatarLoadRules.State.LOADING -> "头像加载中"
                RabiAvatarLoadRules.State.VALIDATING -> "头像校验中"
                RabiAvatarLoadRules.State.READY -> ""
                RabiAvatarLoadRules.State.STALE -> "头像暂为旧缓存"
                RabiAvatarLoadRules.State.UNAVAILABLE -> RabiAvatarLoadRules.unavailableLabel(configured = true)
            }
        }
    }

    private fun refreshPersonaAvatar(changedRoleId: String) {
        val targets = avatarTargets.entries
            .filter { RabiConversationRules.shouldRefreshAvatar(changedRoleId, it.key) }
            .flatMap { it.value.toList() }
        targets.forEach { target ->
            val route = availableRoutes.firstOrNull { it.id == target.routeId } ?: return@forEach
            target.image.setImageDrawable(RabiMobileUi.avatar(this, target.title).drawable)
            bindPersonaAvatar(route, target.image, target.status, register = false)
        }
    }

    private fun routeTitle(routeId: String): String = availableRoutes.firstOrNull { it.id == routeId }?.let(::personaTitle)
        ?: if (routeId == RabiConversationRules.LEGACY_CONVERSATION_ID) "Rabi（旧会话）" else "Rabi"

    private fun routeStatus(route: RabiRouteInfo?): String = when {
        route == null && !routesLoaded -> "正在确认聊天状态…"
        route == null -> "历史会话 · 只读"
        else -> {
            val current = RabiConversationRules.routeStatus(
                isRouteChatCapable(route),
                route.running,
                routeAdapterStates(route),
            )
            when {
                routeLoadFailed -> "上次状态 · 暂未刷新 · $current"
                !routesLoaded -> "上次状态 · 正在刷新 · $current"
                else -> current
            }
        }
    }

    private fun isRouteChatCapable(route: RabiRouteInfo): Boolean {
        val advertised = route.rawJson.takeIf { it.has("chatAvailable") }?.optBoolean("chatAvailable")
        return RabiConversationRules.isChatCapable(
            route.enabled,
            route.messageAdapters,
            jsonStringList(route.rawJson.optJSONArray("messageAdaptersDisabled")),
            advertised,
        )
    }

    private fun routeAdapterStates(route: RabiRouteInfo): List<RabiAdapterPresentation> {
        val values = route.rawJson.optJSONArray("adapterStates") ?: return emptyList()
        return (0 until values.length()).mapNotNull { index ->
            values.optJSONObject(index)?.let { item ->
                val type = item.optString("type").trim()
                val label = item.optString("label").trim()
                val state = item.optString("state").trim()
                val summary = item.optString("summary").trim()
                if (type.isBlank() || summary.isBlank()) null
                else RabiAdapterPresentation(type, label, state, summary)
            }
        }
    }

    private fun jsonStringList(values: org.json.JSONArray?): List<String> =
        (0 until (values?.length() ?: 0)).mapNotNull { index ->
            values?.optString(index)?.trim()?.takeIf(String::isNotBlank)
        }

    private fun preview(message: RabiChatStore.Message?): String = when {
        message == null -> "还没有消息"
        message.text.isNotBlank() -> message.text.replace('\n', ' ')
        message.fileName.isNotBlank() -> "${messageKindLabel(message.kind).ifBlank { "附件" }} · ${message.fileName}"
        else -> messageKindLabel(message.kind).ifBlank { "新消息" }
    }

    private fun deliveryLabel(message: RabiChatStore.Message): String = when (message.deliveryState) {
        "queued" -> "等待发送"
        "sending" -> "正在发送"
        "sent" -> "已交给 Rabi PC"
        "failed" -> "发送失败${message.failure.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""}"
        else -> ""
    }

    private fun formatMessageDay(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(createdAt))
    private fun formatMessageTime(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(createdAt))
    private fun formatListTime(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(createdAt))
    private fun messageKindLabel(kind: String): String = when (kind) {
        "voice" -> "语音转写"; "tts" -> "语音回复"; "image" -> "图片"; "video" -> "视频"
        "audio-file" -> "音频文件"; "file" -> "文件"; "configuration" -> "配置请求"; else -> ""
    }

    private fun ttsPlaybackLabel(message: RabiChatStore.Message): String = when (message.playbackState) {
        "queued" -> "等待播放…"
        "playing" -> "正在播放…"
        "played" -> "已播放 · 点按重播"
        "failed" -> "播放失败${message.playbackFailure.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""} · 点按重试"
        else -> "点按播放"
    }

    private fun refreshChatIfChanged() {
        val updatedAt = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).getLong("updatedAt", 0)
        if (updatedAt <= lastChatRuntimeAt) return
        lastChatRuntimeAt = updatedAt
        if (screen == Screen.CHAT) renderChat()
        if (screen == Screen.CONVERSATIONS) renderConversationList()
    }

    private fun openAttachment(message: RabiChatStore.Message) {
        try {
            val uri = if (message.localPath.startsWith("content://")) android.net.Uri.parse(message.localPath)
                else FileProvider.getUriForFile(this, "$packageName.files", File(message.localPath))
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, message.contentType.ifBlank { "application/octet-stream" })
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (error: Throwable) { toast("没有可打开该文件的应用：${error.message ?: "未知错误"}") }
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
        }
        content.addView(RabiMobileUi.hero(
            this,
            "连接你的 Rabi",
            "App 会先自动检查；只有安全凭证、系统权限或外部设备限制无法代办时，才请你操作。",
        ), full(0, 0, 0, 12))
        status = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "正在检查当前环境",
            "App 正在读取已保存连接并寻找同一网络的 Rabi PC。",
            "请稍候，不需要先填写所有高级参数。",
        ))
        content.addView(status, full(0, 0, 0, 12))
        content.addView(serverCard(), full(0, 0, 0, 12))
        content.addView(conversationRuntimeCard(), full(0, 0, 0, 12))
        content.addView(wearableCard(), full(0, 0, 0, 12))
        content.addView(glassesCard(), full(0, 0, 0, 12))
        content.addView(mediaCard(), full(0, 0, 0, 12))
        lateinit var advancedToggle: Button
        advancedToggle = secondary("显示高级设置") {
            val visible = advancedSettings.visibility != View.VISIBLE
            advancedSettings.visibility = if (visible) View.VISIBLE else View.GONE
            advancedToggle.text = if (visible) "收起高级设置" else "显示高级设置"
        }
        content.addView(advancedToggle, full(0, 0, 0, 12))
        advancedSettings = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(conversationCard(), full(0, 0, 0, 12))
            addView(toolsCard(), full(0, 0, 0, 12))
        }
        content.addView(advancedSettings)
        return ScrollView(this).apply { addView(content) }
    }

    override fun onResume() {
        super.onResume()
        com.rabi.link.recording.CaptureOwnership.listen(captureListener)
        refreshCaptureBar()
        if (!runtimeReceiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                runtimeReceiver,
                IntentFilter().apply {
                    addAction("com.rabi.link.conversation.RUNTIME_UPDATED")
                    addAction(RabiPersonaAvatarEvents.ACTION_CHANGED)
                },
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            runtimeReceiverRegistered = true
        }
        refreshConversationRuntime()
        refreshChatIfChanged()
        if (screen == Screen.CHAT) renderChat()
        if (screen == Screen.CONVERSATIONS) renderConversationList()
        if (screen == Screen.CHAT) {
            availableRoutes.firstOrNull { it.id == activeRouteId }?.agentRoleId?.let(::refreshPersonaAvatar)
        }
    }
    override fun onPause() {
        com.rabi.link.recording.CaptureOwnership.unlisten(captureListener)
        if (runtimeReceiverRegistered) {
            unregisterReceiver(runtimeReceiver)
            runtimeReceiverRegistered = false
        }
        super.onPause()
    }

    private fun conversationRuntimeCard(): View = card().apply {
        addView(title("持续会话"))
        runtimeStatus = note("尚未启动")
        runtimeMode = runtimeLine("模式：尚未启动")
        runtimeConnection = runtimeLine("连接：尚未启动")
        runtimeRoute = runtimeLine("Route / 人格：尚未选择")
        runtimeGlasses = runtimeLine("眼镜：未使用")
        runtimeQueue = runtimeLine("可靠队列：正在读取")
        runtimeError = runtimeLine("最近错误：无")
        runtimeTranscript = runtimeLine("你：等待语音")
        runtimeReply = runtimeLine("Rabi：等待回复")
        runtimeCaptureHealth = runtimeLine("采集：尚无长时运行记录")
        addView(runtimeStatus)
        addView(runtimeMode, full(0, 2, 0, 2))
        addView(runtimeConnection, full(0, 2, 0, 2))
        addView(runtimeRoute, full(0, 2, 0, 2))
        addView(runtimeGlasses, full(0, 2, 0, 2))
        addView(runtimeQueue, full(0, 2, 0, 2))
        addView(runtimeError, full(0, 2, 0, 6))
        addView(runtimeTranscript, full(0, 2, 0, 2))
        addView(runtimeReply, full(0, 2, 0, 8))
        addView(runtimeCaptureHealth, full(0, 2, 0, 8))
        val actions = row()
        actions.addView(primary("开始 / 应用") { startConversation() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(6), 1))
        actions.addView(secondary("提示 Agent") { RabiConversationService.requestReview(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(6), 1))
        actions.addView(secondary("停止") { RabiConversationService.stop(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(primary("查看录音与转写") {
            startActivity(Intent(this@MainActivity, RabiSpeechPreviewActivity::class.java))
        }, full(0, 8, 0, 0))
    }

    private fun refreshConversationRuntime() {
        if (!::runtimeStatus.isInitialized) return
        val values = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        val settings = RabiConversationSettings.load(this)
        val desiredMode = settings.inputMode
        val activeMode = RabiConversationSettings.InputMode.fromPersisted(
            values.getString("activeMode", "PAUSED"),
            RabiConversationSettings.InputMode.PAUSED,
        )
        runtimeStatus.text = values.getString("status", "尚未启动")
        runtimeMode.text = "模式：${inputModeLabel(desiredMode)} · 当前 ${inputModeLabel(activeMode)} · ${values.getString("capture", "采集状态未知")}"
        runtimeConnection.text = "连接：${values.getString("connection", "等待服务事件")}"
        val routeId = RabiConversationTarget.load(this)
        runtimeRoute.text = "Route / 人格：${if (routeId.isBlank()) "尚未选择" else routeTitle(routeId)} · 主动性 ${proactivityLabel(settings.proactivityPreference)}"
        runtimeGlasses.text = "眼镜：${values.getString("glasses", if (desiredMode == RabiConversationSettings.InputMode.GLASSES) "等待连接状态" else "未使用眼镜输入")}"
        runtimeQueue.text = "可靠队列：${values.getString("queue", "等待服务读取")}"
        runtimeError.text = "最近错误：${values.getString("error", "").orEmpty().ifBlank { "无" }}"
        runtimeTranscript.text = "你：${values.getString("transcript", "等待语音")}"
        runtimeReply.text = "Rabi：${values.getString("reply", "等待回复")}"
        runtimeCaptureHealth.text = RabiPhoneAudioCapture.runtimeSummary(this)
    }

    private fun serverCard(): View = card().apply {
        addView(title("1. 安全连接"))
        addView(note("按顺序完成下面三项。App 能识别的会直接填好；需要你确认的内容，就在对应输入框下面告诉你去哪里拿。"))
        relayUrl = input("例如：http://192.168.1.10:8794/rabilink")
        relayToken = input("从 Rabi PC 复制的移动端登录码").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        relayUrlHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里填手机能访问的 RabiLink 地址。通常不用手填，App 找到电脑后会自动写入。")
        relayTokenHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里粘贴 Rabi PC“RabiLink / 移动端”页面显示的登录码；它是安全凭证，所以不能静默读取。")
        addView(label("① RabiLink 服务器地址")); addView(relayUrl); addView(relayUrlHelp)
        addView(label("② 移动端登录码")); addView(relayToken); addView(relayTokenHelp)
        discoveredPcAction = secondary("打开 Rabi PC 获取登录码") { openDiscoveredManager() }.apply { visibility = View.GONE }
        addView(discoveredPcAction, full(0, 0, 0, 8))
        pcAdapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_item, mutableListOf("尚未连接"))
        pcAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        pcSpinner = RabiMobileUi.spinner(this@MainActivity, Spinner(this@MainActivity).apply {
            adapter = pcAdapter
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) { selectedPc = pcs.getOrNull(position); refreshStatus("已选择目标 PC") }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        })
        pcHelp = RabiMobileUi.fieldHelp(this@MainActivity, "③ 登录成功后，这里会列出在线电脑；只有一台时 App 会自动选择。")
        addView(label("③ 处理消息的 Rabi PC")); addView(pcSpinner); addView(pcHelp)
        connectButton = primary("连接 Rabi") { connectRelay() }
        addView(connectButton, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("自动检测") { scanLocalRabi() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("使用所选 PC") { bindPc() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
    }

    private fun glassesCard(): View = card().apply {
        addView(title("4. 可选眼镜交互"))
        addView(note("手机可以独立持续会话。开启眼镜后，输入、播放、HUD 和触摸板交互切到眼镜，但仍复用同一个手机后端。"))
        addView(primary("打开眼镜后端") { openRokid("connect_glass_app") }, full(0, 0, 0, 8))
        val row = row()
        row.addView(secondary("安装眼镜 App") { openRokid("install_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("启动眼镜 App") { openRokid("start_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun mediaCard(): View = card().apply {
        addView(title("5. 照片与视频消息"))
        addView(note("照片和短视频作为可靠附件慢传：手机暂存、压缩、排队、重试，再交给 Rabi PC。当前不把公网链路描述成直播。"))
        val actions = row()
        actions.addView(primary("手机选择照片 / 视频") { pickPhoneMedia() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("打开眼镜拍照桥") { openRokid("") }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
    }

    private fun toolsCard(): View = card().apply {
        addView(title("6. 管理与诊断"))
        addView(note("知道字段时直接使用远程 WebGUI；不知道字段名时再进入独立配置助手。配置不会混进普通聊天输入框。"))
        val row = row()
        row.addView(secondary("打开远程配置") { openRemoteConfig() }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("接口测试中心") { startActivity(Intent(this@MainActivity, TestCenterActivity::class.java)) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
        addView(secondary("不知道填什么？打开配置助手") { showConfigurationAssistant() }, full(0, 8, 0, 0))
    }

    private fun wearableCard(): View = card().apply {
        addView(title("3. 智能手表 / 手环"))
        addView(note("配置小米密钥、Health Connect 持续采集、心率阈值和睡眠状态告警。健康数据会送到所选 Rabi PC 的“智能手表/手环”消息端。"))
        addView(primary("配置健康消息端") {
            startActivity(Intent(this@MainActivity, WearableHealthSettingsActivity::class.java))
        })
    }

    private fun conversationCard(): View = card().apply {
        addView(title("2. 持续会话与下行语音"))
        addView(note("这些设置同时用于手机独立模式和眼镜模式。Android 只持续采集并传输 16 kHz 单声道 PCM；VAD、切句、ASR 和声纹都由所选 Rabi PC 的 RabiSpeech 统一完成。"))
        inputMode = RabiMobileUi.spinner(this@MainActivity, Spinner(this@MainActivity).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_item,
                listOf("已暂停（保留消息连接）", "手机模式", "眼镜模式"),
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        })
        proactivityPreference = RabiMobileUi.spinner(this@MainActivity, Spinner(this@MainActivity).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_item,
                listOf("由 Agent 人格综合决定", "偏安静", "均衡", "偏主动"),
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        })
        autoStartVoiceService = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply {
            text = "Rabi 启动后自动开启语音服务"
        })
        autoPlayAgentVoice = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply { text = "收到 Agent TTS 后立即播放" })
        addView(label("当前交互模式")); addView(inputMode, full(0, 0, 0, 6))
        addView(note("眼镜模式只有在眼镜真实连接后才开始采集；连接前或断线后保持暂停，不会同时上传手机和眼镜麦克风。"))
        addView(autoStartVoiceService)
        directVideo = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply {
            text = "眼镜模式自动直传视频到电脑"
            isEnabled = BuildConfig.ROKID_VIDEO
        })
        addView(directVideo)
        directVideo.visibility = if (BuildConfig.ROKID_VIDEO) View.VISIBLE else View.GONE
        if (BuildConfig.ROKID_VIDEO) addView(note("实验 SDK 直传尚未完成眼镜取流验收。手机本地录像请使用设置页顶部的“眼镜离线录像”。"))
        addView(note("开启后，每次打开 Rabi 都会按当前交互模式启动语音服务。关闭后只保持消息连接，不会自动使用手机或眼镜麦克风。"))
        addView(label("明确主动性偏好")); addView(proactivityPreference, full(0, 0, 0, 6))
        addView(note("这是交给 PC / Route / Agent 的明确偏好，不是 App 本地决策规则。Agent 仍可根据情景、权限和动作安全门选择不打扰、准备、提示、建议、请求确认或行动。"))
        addView(autoPlayAgentVoice)
        ttsModel = input("local-tts/gpt-sovits")
        ttsVoice = input("Rabi")
        addView(label("Rabi PC TTS 模型")); addView(ttsModel, full(0, 0, 0, 6))
        addView(label("人格 / 声线")); addView(ttsVoice, full(0, 0, 0, 6))
        audioRetentionHours = input("6").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        audioMaxStorageMb = input("8192").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        audioReserveFreeMb = input("1024").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        addView(label("已确认录音保留（小时，0–168）")); addView(audioRetentionHours, full(0, 0, 0, 6))
        addView(label("录音队列上限（MiB，至少 1024）")); addView(audioMaxStorageMb, full(0, 0, 0, 6))
        addView(label("设备剩余空间水位（MiB，至少 256）")); addView(audioReserveFreeMb, full(0, 0, 0, 6))
        addView(note("未确认分片不会因保留期限被删除；只有 Rabi PC 明确确认完整字节、序号与校验和后，手机副本才进入可清理状态。达到存储水位会停止接受新的 PCM，并在本机留下可审计缺口。"))
        addView(primary("保存并应用") { startConversation() }, full(0, 0, 0, 8))
        addView(note("常驻运行会使用麦克风前台服务、采集 WakeLock、卡死检测和自动恢复。手机先把连续 PCM 写入私有动态分片，断网或 PC 离线时继续落盘，恢复联网后按序补传。小米等厂商仍可能额外限制后台应用，请在真机上核对电池优化与自启动权限。"))
        val actions = row()
        actions.addView(secondary("立即提示 Agent") { RabiConversationService.requestReview(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("停止持续会话") { RabiConversationService.stop(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(secondary("重试失败的离线消息 / TTS") { RabiConversationService.retryFailed(this@MainActivity) }, full(0, 8, 0, 0))
        addView(secondary("检查系统后台保活设置") { openBatteryOptimizationSettings() }, full(0, 8, 0, 0))
    }

    private fun loadConversationSettings() {
        val value = RabiConversationSettings.load(this)
        inputMode.setSelection(when (value.inputMode) {
            RabiConversationSettings.InputMode.PAUSED -> 0
            RabiConversationSettings.InputMode.PHONE -> 1
            RabiConversationSettings.InputMode.GLASSES -> 2
            else -> 0
        })
        proactivityPreference.setSelection(when (value.proactivityPreference) {
            RabiConversationSettings.ProactivityPreference.AGENT_DECIDES -> 0
            RabiConversationSettings.ProactivityPreference.QUIET -> 1
            RabiConversationSettings.ProactivityPreference.BALANCED -> 2
            RabiConversationSettings.ProactivityPreference.PROACTIVE -> 3
            else -> 0
        })
        autoStartVoiceService.isChecked = value.autoStartVoiceService
        directVideo.isChecked = RabiConversationSettings.directVideoEnabled(this)
        autoPlayAgentVoice.isChecked = value.autoPlayAgentVoice
        ttsModel.setText(value.ttsModel)
        ttsVoice.setText(value.ttsVoice)
        audioRetentionHours.setText(value.audioRetentionHours.toString())
        audioMaxStorageMb.setText(value.audioMaxStorageMb.toString())
        audioReserveFreeMb.setText(value.audioReserveFreeMb.toString())
    }

    private fun saveConversationSettings() {
        val previous = RabiConversationSettings.load(this)
        val next = RabiConversationSettings(
            when (inputMode.selectedItemPosition) {
                0 -> RabiConversationSettings.InputMode.PAUSED
                2 -> RabiConversationSettings.InputMode.GLASSES
                else -> RabiConversationSettings.InputMode.PHONE
            },
            when (proactivityPreference.selectedItemPosition) {
                1 -> RabiConversationSettings.ProactivityPreference.QUIET
                2 -> RabiConversationSettings.ProactivityPreference.BALANCED
                3 -> RabiConversationSettings.ProactivityPreference.PROACTIVE
                else -> RabiConversationSettings.ProactivityPreference.AGENT_DECIDES
            },
            autoStartVoiceService.isChecked,
            autoPlayAgentVoice.isChecked,
            ttsModel.text.toString(),
            ttsVoice.text.toString(),
            audioRetentionHours.text.toString().toIntOrNull() ?: 6,
            audioMaxStorageMb.text.toString().toIntOrNull() ?: 8192,
            audioReserveFreeMb.text.toString().toIntOrNull() ?: 1024
        )
        next.save(this)
        RabiConversationSettings.setDirectVideoEnabled(this, directVideo.isChecked)
        if (previous.proactivityPreference != next.proactivityPreference) {
            RabiConversationService.updateProactivityPreference(this, next.proactivityPreference.wireValue)
        }
        toast("语音服务设置已保存")
    }

    private fun startConversation() {
        saveConversationSettings()
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return toast("请先连接 RabiLink 服务器")
        val settings = RabiConversationSettings.load(this)
        if (settings.autoStartVoiceService
            && settings.inputMode == RabiConversationSettings.InputMode.PHONE
            && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), requestPhoneAudio)
            return
        }
        RabiConversationService.start(this)
        if (settings.inputMode == RabiConversationSettings.InputMode.GLASSES
            && getSharedPreferences("rokid_probe", MODE_PRIVATE).getString("rokid_token", "").isNullOrBlank()) {
            openRokid("connect_glass_app")
        }
    }

    private fun inputModeLabel(mode: RabiConversationSettings.InputMode): String = when (mode) {
        RabiConversationSettings.InputMode.PAUSED -> "已暂停"
        RabiConversationSettings.InputMode.PHONE -> "手机模式"
        RabiConversationSettings.InputMode.GLASSES -> "眼镜模式"
    }

    private fun proactivityLabel(value: RabiConversationSettings.ProactivityPreference): String = when (value) {
        RabiConversationSettings.ProactivityPreference.AGENT_DECIDES -> "由 Agent 决定"
        RabiConversationSettings.ProactivityPreference.QUIET -> "偏安静"
        RabiConversationSettings.ProactivityPreference.BALANCED -> "均衡"
        RabiConversationSettings.ProactivityPreference.PROACTIVE -> "偏主动"
    }

    private fun openBatteryOptimizationSettings() {
        val manager = getSystemService(PowerManager::class.java)
        if (manager?.isIgnoringBatteryOptimizations(packageName) == true) {
            toast("Rabi 移动端已不受系统电池优化限制")
        }
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = android.net.Uri.parse("package:$packageName")
            })
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == requestPhoneAudio && grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            RabiConversationService.start(this)
        } else if (requestCode == requestPhoneAudio) {
            showGuidance(RabiSetupGuidance(
                "麦克风权限未开启",
                "手机持续会话需要由 Android 明确授权录音；App 不能绕过系统替你打开。",
                "在系统权限页允许麦克风，或改用已连接眼镜的麦克风。",
                RabiGuidanceTone.WARNING,
            ))
        }
    }

    private fun pickPhoneMedia() {
        mediaTargetRouteId = activeRouteId
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }, requestPhoneMedia)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != requestPhoneMedia || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Throwable) { }
        val routeProfileId = mediaTargetRouteId.ifBlank { activeRouteId }
        if (routeProfileId.isBlank()) return toast("请先进入一个会话，再选择要发送的文件")
        RabiConversationService.enqueueMedia(this, uri, contentResolver.getType(uri) ?: "application/octet-stream", routeProfileId)
        if (screen == Screen.CHAT && activeRouteId == routeProfileId) runtimeHandler.postDelayed({ renderChat() }, 300)
    }

    private fun autoPrepareSetup(saved: RabiLinkRelayConfig) {
        if (saved.configured) {
            showGuidance(RabiSetupGuidance(
                "已找到上次的连接",
                "App 正在自动验证登录状态和在线 Rabi PC。",
                "验证通过后，只有一个在线 PC 时会自动选择。",
            ))
            connectRelay()
        } else {
            scanLocalRabi()
        }
    }

    private fun scanLocalRabi() {
        if (busy) return
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在自动寻找 Rabi PC",
            "正在扫描同一 Wi-Fi；找到后会把地址直接填进第一个输入框。",
            "请稍候。",
        ))
        runAsync({ discoverySdk.scanLan(applicationContext) }, { instances ->
            discoveredManagers.clear()
            discoveredManagers.addAll(instances)
            val first = instances.firstOrNull()
            if (first == null) {
                discoveredPcAction.visibility = View.GONE
                if (relayUrl.text.toString().trim().isBlank()) {
                    setUrlHelp(
                        "没有自动找到电脑。请确认手机与 Rabi PC 在同一 Wi-Fi；也可手填 http://电脑局域网IP:8794/rabilink。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "登录码要在 Rabi PC 的“RabiLink / 移动端”页面复制；App 不会猜测或生成安全凭证。",
                        RabiGuidanceTone.WARNING,
                    )
                } else {
                    setTokenHelp("登录码已经填写，连接时会安全验证。", RabiGuidanceTone.INFO)
                }
                showGuidance(RabiSetupGuidance("还差连接信息", "请按输入框下方的提示完成标橙项目。", "" , RabiGuidanceTone.WARNING))
            } else {
                discoveredPcAction.visibility = View.VISIBLE
                val pcName = first.name.ifBlank { first.computerName.ifBlank { "Rabi PC" } }
                val inferredUrl = "http://${first.host}:8794/rabilink"
                if (relayUrl.text.toString().trim().isBlank()) {
                    relayUrl.setText(inferredUrl)
                    setUrlHelp("已从 $pcName 自动检测并填入：$inferredUrl", RabiGuidanceTone.SUCCESS)
                } else {
                    setUrlHelp("已保留你填写的地址；同时检测到 $pcName 可用地址 $inferredUrl。", RabiGuidanceTone.INFO)
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "还差这一项：点下面“打开 $pcName 获取登录码”，在 RabiLink / 移动端页面复制后粘贴到这里。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                discoveredPcAction.text = "打开 $pcName 获取登录码"
                showGuidance(RabiSetupGuidance(
                    "已找到 ${instances.size} 台 Rabi PC，服务器地址已填好",
                    if (relayToken.text.toString().isBlank()) "现在只需完成标橙的“移动端登录码”。" else "连接信息已经齐全。",
                    if (relayToken.text.toString().isBlank()) "按第二个输入框下方的提示获取登录码。" else "点“连接 Rabi”。",
                    RabiGuidanceTone.SUCCESS,
                ))
                if (screen == Screen.SETUP) runtimeHandler.postDelayed({ showConversationList() }, 650)
            }
        }, complete = { setBusy(false) }, error = { error ->
            setUrlHelp(
                "自动检测失败：${error.message ?: "Android 无法完成局域网扫描"}。可手填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("自动检测没有完成", "请按服务器地址输入框下方的提示处理。", "", RabiGuidanceTone.WARNING))
        })
    }

    private fun openDiscoveredManager() {
        val instance = discoveredManagers.firstOrNull()
        if (instance == null) {
            showGuidance(RabiSetupGuidance(
                "没有可打开的 Rabi PC",
                "本轮扫描没有保留可用地址。",
                "确认手机和电脑在同一 Wi-Fi 后重新检测。",
                RabiGuidanceTone.WARNING,
            ))
            return
        }
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(instance.baseUrl)))
    }

    private fun connectRelay() {
        val url = relayBaseUrl(); val token = relayToken.text.toString().trim()
        if (url.isBlank() || token.isBlank()) {
            if (url.isBlank()) setUrlHelp(
                "这里必须填服务器地址。先点“自动检测”；仍找不到时填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            if (token.isBlank()) setTokenHelp(
                "这里必须粘贴移动端登录码。请在 Rabi PC 的“RabiLink / 移动端”页面复制；这是安全凭证，App 不能替你生成。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("连接信息还没填完整", "请完成标红输入框；每项下面都有获取方法。", "", RabiGuidanceTone.WARNING))
            if (url.isBlank() && discoveredManagers.isEmpty()) scanLocalRabi()
            return
        }
        setUrlHelp("正在验证这个服务器地址是否可由手机访问。", RabiGuidanceTone.INFO)
        setTokenHelp("正在安全验证登录码；不会把明文写入日志。", RabiGuidanceTone.INFO)
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在验证连接",
            "App 正在检查服务器、登录码和可用 Rabi PC。",
            "请稍候，不需要重复点击。",
        ))
        runAsync({
            val initial = sdk.getMobileState(url, token)
            val onlyOnlinePc = initial.workers.filter { it.online }.singleOrNull()
            if (initial.selectedWorker == null && onlyOnlinePc != null) {
                sdk.selectMobileRabiPc(url, token, onlyOnlinePc.id)
            } else initial
        }, { state ->
            RabiLinkRelaySettings.save(this, url, token); RokidDeviceStatusSyncService.start(this)
            setUrlHelp("服务器地址验证通过，已保存到本机。", RabiGuidanceTone.SUCCESS)
            setTokenHelp("登录码验证通过，已安全保存到本机。", RabiGuidanceTone.SUCCESS)
            pcs.clear(); pcs.addAll(state.workers); pcAdapter.clear()
            if (pcs.isEmpty()) pcAdapter.add("没有在线 Rabi PC") else pcAdapter.addAll(pcs.map { "${it.name} · ${if (it.online) "在线" else "离线"}" })
            pcAdapter.notifyDataSetChanged(); selectedPc = state.selectedWorker ?: pcs.firstOrNull()
            selectedPc?.let { pc -> pcSpinner.setSelection(pcs.indexOfFirst { it.id == pc.id }.coerceAtLeast(0)) }
            if (pcs.isEmpty()) {
                setPcHelp("登录已经成功，但服务器当前没有在线 Rabi PC。请在电脑启动 RabiRoute 的 RabiLink worker。", RabiGuidanceTone.WARNING)
                showGuidance(RabiSetupGuidance(
                    "RabiLink 已登录，但没有在线 PC",
                    "服务器接受了登录码，当前却没有 Rabi PC worker 在线。",
                    "在电脑启动 RabiRoute 并启用 RabiLink Relay worker，然后点“连接 Rabi”刷新。",
                    RabiGuidanceTone.WARNING,
                ))
            } else {
                val pc = selectedPc
                setPcHelp(
                    if (state.workers.size == 1) "已自动选择唯一在线电脑：${pc?.name ?: "Rabi PC"}。" else "已选择 ${pc?.name ?: "Rabi PC"}；点下拉框可以切换。",
                    RabiGuidanceTone.SUCCESS,
                )
                showGuidance(RabiSetupGuidance(
                    "连接完成",
                    "已登录 RabiLink，${pc?.name ?: "Rabi PC"} ${if (pc?.online == true) "在线" else "当前离线"}。",
                    if (state.workers.size == 1) "App 已自动选择唯一的 PC，可以开始使用。" else "如需切换电脑，选择后点“使用所选 PC”。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }, complete = { setBusy(false) }, error = { error -> showConnectionError(error) })
    }

    private fun bindPc() {
        val pc = selectedPc ?: return run {
            setPcHelp("这里还没有电脑可选。先完成前两个输入框并点“连接 Rabi”。", RabiGuidanceTone.ERROR)
            showGuidance(RabiSetupGuidance("还没有可选的 Rabi PC", "请看第三项下方的提示。", "", RabiGuidanceTone.WARNING))
        }
        val token = relayToken.text.toString().trim()
        if (token.isBlank()) {
            setTokenHelp("先在这里粘贴移动端登录码，再选择电脑。", RabiGuidanceTone.ERROR)
            return
        }
        setBusy(true)
        runAsync({ sdk.selectMobileRabiPc(relayBaseUrl(), token, pc.id) }, { state ->
            selectedPc = state.selectedWorker ?: pc
            setPcHelp("后续手机、手表和眼镜消息会交给 ${selectedPc?.name ?: "这台 Rabi PC"}。", RabiGuidanceTone.SUCCESS)
            showGuidance(RabiSetupGuidance(
                "已切换到 ${selectedPc?.name}",
                "后续手机、手表和眼镜消息会默认交给这台 Rabi PC。",
                "现在可以返回会话或继续配置设备。",
                RabiGuidanceTone.SUCCESS,
            ))
        }, complete = { setBusy(false) }, error = { error -> showConnectionError(error) })
    }

    private fun openRokid(command: String) {
        val config = RabiLinkRelaySettings.load(this)
        if (!config.configured) return showGuidance(RabiSetupGuide.missingConnection(config.baseUrl.isBlank(), config.token.isBlank(), discoveredManagers.size))
        startActivity(Intent(this, RokidProbeActivity::class.java).apply { if (command.isNotBlank()) putExtra("rokid_probe_command", command) })
    }

    private fun openRemoteConfig() {
        val url = relayBaseUrl()
        if (url.isBlank()) return showGuidance(RabiSetupGuide.missingConnection(true, relayToken.text.toString().trim().isBlank(), discoveredManagers.size))
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$url/manage")))
    }

    private fun refreshStatus(message: String) {
        if (!::status.isInitialized || busy) return
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.configured && selectedPc != null) {
            showGuidance(RabiSetupGuidance(
                "连接已就绪",
                "RabiLink 已登录，当前使用 ${selectedPc?.name}。",
                message,
                RabiGuidanceTone.SUCCESS,
            ))
        }
    }
    private fun showGuidance(value: RabiSetupGuidance) {
        if (!::status.isInitialized) return
        val styled = RabiMobileUi.guidance(this, value)
        status.text = styled.text
        status.setTextColor(styled.currentTextColor)
        status.background = styled.background
    }

    private fun setUrlHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayUrlHelp.isInitialized || !::relayUrl.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayUrlHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayUrl, tone)
    }

    private fun setTokenHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayTokenHelp.isInitialized || !::relayToken.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayTokenHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayToken, tone)
    }

    private fun setPcHelp(message: String, tone: RabiGuidanceTone) {
        if (!::pcHelp.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, pcHelp, message, tone)
    }

    private fun showConnectionError(error: Throwable) {
        val guidance = RabiSetupGuide.connectionError(error)
        val raw = error.message.orEmpty().lowercase()
        val fieldMessage = listOf(guidance.reason, guidance.action).filter { it.isNotBlank() }.joinToString(" ")
        when {
            "401" in raw || "403" in raw || "unauthorized" in raw || "forbidden" in raw ->
                setTokenHelp(fieldMessage, RabiGuidanceTone.ERROR)
            "unknownhost" in raw || "resolve host" in raw || "timeout" in raw || "timed out" in raw ||
                "cleartext" in raw || "refused" in raw || "failed to connect" in raw || "unreachable" in raw ->
                setUrlHelp(fieldMessage, RabiGuidanceTone.ERROR)
            else -> {
                setUrlHelp("服务器或网络没有完成验证，请核对地址后重试。", RabiGuidanceTone.WARNING)
                setTokenHelp("如果地址无误，请重新从 Rabi PC 复制移动端登录码。", RabiGuidanceTone.WARNING)
            }
        }
        showGuidance(RabiSetupGuidance(guidance.title, "请查看对应输入框下方的修复提示。", "", guidance.tone))
    }

    private fun relayBaseUrl() = relayUrl.text.toString().trim().trimEnd('/')
    private fun setBusy(value: Boolean) {
        busy = value
        if (::connectButton.isInitialized) {
            connectButton.isEnabled = !value
            connectButton.text = if (value) "正在检查…" else "连接 Rabi"
        }
    }
    private fun <T> runAsync(
        work: () -> T,
        success: (T) -> Unit,
        complete: () -> Unit = {},
        error: (Throwable) -> Unit = { toast(it.message ?: it.javaClass.simpleName) },
    ) { Thread { try { val result = work(); runOnUiThread { success(result); complete() } } catch (cause: Throwable) { runOnUiThread { error(cause); complete() } } }.start() }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun card() = RabiMobileUi.card(this)
    private fun title(text: String) = RabiMobileUi.title(this, text)
    private fun note(text: String) = RabiMobileUi.note(this, text)
    private fun runtimeLine(text: String) = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(RabiMobileUi.text); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }
    private fun label(text: String) = RabiMobileUi.label(this, text)
    private fun input(hint: String) = RabiMobileUi.input(this, hint)
    private fun numberInput(hint: String) = input(hint).apply { inputType = InputType.TYPE_CLASS_NUMBER }
    private fun primary(text: String, action: () -> Unit) = RabiMobileUi.primary(this, text, action)
    private fun secondary(text: String, action: () -> Unit) = RabiMobileUi.secondary(this, text, action)
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun panel(color: Int, stroke: Int, radius: Int) = RabiMobileUi.panel(this, color, stroke, radius)
    private fun dp(value: Int) = RabiMobileUi.dp(this, value)
}
