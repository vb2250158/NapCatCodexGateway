package com.rabi.link.modules.rokid

import android.content.Context
import android.os.Handler
import android.os.Looper
import livekit.org.webrtc.*
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/** Direct-only, bounded H.264 transport. No media request is ever sent to Relay. */
class RabiDirectVideoSender(context: Context, private val listener: Listener) {
    interface Listener {
        fun exchangeOffer(sdp: String): JSONObject
        fun onReady()
        fun onStopped(reason: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null
    private var generation = 0
    private var signalling = false
    private var disposed = false
    @Volatile private var ready = false

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
    }

    fun start() {
        if (disposed || peer != null) return
        val current = ++generation
        signalling = false
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        val config = PeerConnection.RTCConfiguration(listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        ))
        // No TURN server is supplied; both peers reject relay candidates.
        peer = factory!!.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                if (state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.DISCONNECTED)
                    main.post { if (generation == current) stop("视频直连中断；未转服务器") }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) main.post { signal(current) }
            }
            override fun onIceCandidate(candidate: IceCandidate) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) { channel.close() }
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        })
        val connection = peer ?: run { stop("无法创建视频直连"); return }
        channel = connection.createDataChannel("rabi.h264.v1", DataChannel.Init())
        channel!!.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onStateChange() {
                main.post {
                    if (generation != current) return@post
                    when (channel?.state()) {
                        DataChannel.State.OPEN -> { ready = true; listener.onReady() }
                        DataChannel.State.CLOSED -> stop("视频连接已关闭")
                        else -> Unit
                    }
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {}
        })
        connection.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                main.post {
                    if (generation == current) connection.setLocalDescription(observer(current), description)
                }
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(error: String) { fail(current) }
            override fun onSetFailure(error: String) { fail(current) }
        }, MediaConstraints())
        main.postDelayed({ if (generation == current && !ready) stop("视频直连超时；未转服务器") }, 45_000)
    }

    private fun signal(current: Int) {
        if (current != generation || signalling) return
        val sdp = peer?.localDescription?.description ?: return
        signalling = true
        worker.execute {
            try {
                val answer = listener.exchangeOffer(sdp)
                val remoteSdp = answer.getString("sdp")
                require(answer.optBoolean("relay", true) == false && !remoteSdp.contains(" typ relay"))
                main.post {
                    if (current == generation) peer?.setRemoteDescription(observer(current),
                        SessionDescription(SessionDescription.Type.ANSWER, remoteSdp))
                }
            } catch (_: Exception) { fail(current) }
        }
    }

    private fun observer(current: Int) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) { fail(current) }
        override fun onSetFailure(error: String) { fail(current) }
    }

    private fun fail(current: Int) {
        main.post { if (generation == current) stop("视频协商失败；请检查电脑和直连网络") }
    }

    /** SDK buffers may be reused immediately. Sends copy in bounded 16 KiB chunks. */
    @Synchronized fun sendH264(bytes: ByteArray) {
        val output = channel ?: return
        if (!ready) return
        if (bytes.size > 1024 * 1024 || output.bufferedAmount() + bytes.size > 1024 * 1024) {
            ready = false
            main.post { stop("视频带宽不足，已停止以避免积压") }
            return
        }
        var offset = 0
        while (offset < bytes.size) {
            val count = minOf(16 * 1024, bytes.size - offset)
            if (!output.send(DataChannel.Buffer(ByteBuffer.wrap(bytes.copyOfRange(offset, offset + count)), true))) {
                ready = false
                main.post { stop("视频发送失败；未转服务器") }
                return
            }
            offset += count
        }
    }

    @Synchronized fun stop(reason: String) {
        generation++
        ready = false
        channel?.unregisterObserver()
        channel?.close()
        channel?.dispose()
        channel = null
        peer?.close()
        peer?.dispose()
        peer = null
        factory?.dispose()
        factory = null
        listener.onStopped(reason)
    }

    fun dispose() {
        disposed = true
        stop("视频已停止")
        worker.shutdownNow()
    }
}
