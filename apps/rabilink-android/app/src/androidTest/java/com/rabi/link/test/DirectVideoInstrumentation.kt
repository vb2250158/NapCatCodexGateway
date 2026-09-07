package com.rabi.link.test

import android.app.Instrumentation
import android.os.Bundle
import com.rabi.link.modules.rokid.RabiDirectVideoSender
import com.rabi.link.modules.rokid.RabiGlassBridge
import com.rabi.link.modules.rokid.RabiGlassBridgeFactory
import org.json.JSONObject
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Explicit, bounded hardware acceptance; never included in the production APK. */
class DirectVideoInstrumentation : Instrumentation() {
    private lateinit var args: Bundle
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); args = arguments; start() }
    override fun onStart() {
        var sender: RabiDirectVideoSender? = null
        var bridge: RabiGlassBridge? = null
        val ready = CountDownLatch(1)
        val bytes = AtomicLong()
        val chunks = AtomicLong()
        var lastStatus = ""
        val trace = java.util.Collections.synchronizedList(mutableListOf<String>())
        val result = Bundle()
        try {
            val port = args.getString("signalPort")!!.toInt()
            require(port in 1..65535)
            val camera = args.getString("camera") == "true"
            runOnMainSync {
                sender = RabiDirectVideoSender(targetContext, object : RabiDirectVideoSender.Listener {
                    override fun exchangeOffer(sdp: String): JSONObject {
                        val body = JSONObject().put("deviceId", "android-video-acceptance").put("sdp", sdp).toString().toByteArray()
                        // The explicit loopback test port is mapped through adb reverse, not a production connection.
                        Socket("127.0.0.1", port).use { socket ->
                            socket.soTimeout = 30000
                            val output = socket.getOutputStream()
                            output.write("POST /offer HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            output.write(body); output.flush()
                            val response = socket.getInputStream().bufferedReader().readText()
                            require(response.startsWith("HTTP/1.1 200")) { "Signalling rejected" }
                            return JSONObject(response.substringAfter("\r\n\r\n"))
                        }
                    }
                    override fun onReady() { ready.countDown() }
                    override fun onStopped(reason: String) { lastStatus = reason }
                })
                sender!!.start()
            }
            check(ready.await(50, TimeUnit.SECONDS)) { "Direct channel did not open: $lastStatus" }
            if (camera) {
                runOnMainSync {
                    val preferences = targetContext.getSharedPreferences("rokid_probe", 0)
                    bridge = RabiGlassBridgeFactory.create(targetContext, object : RabiGlassBridge.Listener {
                        override fun onNativeVoiceLog(line: String) {
                            if (line.startsWith("Video")) lastStatus = line
                            if (trace.size < 60 && Regex("callback|failed|unavailable|skipped|rejected|groupFormed|timeout").containsMatchIn(line)
                                && !Regex("(?i)token|secret|authorization").containsMatchIn(line))
                                trace.add(line.substringBefore("target=").substringBefore("reason="))
                        }
                        override fun onNativeAsrText(text: String, channel: String, clientId: String) {}
                        override fun onNativeTtsAck(text: String, channel: String, clientId: String) {}
                        override fun onNativeCommandAck(kind: String, text: String, channel: String, clientId: String) {}
                        override fun onNativeStatus(text: String, channel: String, clientId: String) {}
                        override fun onNativeVoiceError(kind: String, text: String, channel: String, clientId: String) { lastStatus = kind }
                        override fun onGlassAudioPcm(pcm: ByteArray) {}
                        override fun onGlassReviewRequested() {}
                        override fun onGlassVideoState(state: String) { lastStatus = state }
                        override fun onGlassVideoH264(data: ByteArray) {
                            bytes.addAndGet(data.size.toLong()); chunks.incrementAndGet(); sender?.sendH264(data)
                        }
                    }, preferences.getString("native_voice_access_key", ""), preferences.getString("native_voice_secret_key", ""))
                    bridge?.startVideoStream(15, 2_000_000)
                }
                check(bridge != null) { "Rokid bridge failed to load" }
                Thread.sleep(40_000)
                check(chunks.get() >= 15 && bytes.get() > 0) { "No continuous camera data: $lastStatus" }
            } else {
                repeat(30) { index ->
                    val data = ByteArray(16000) { ((it + index) % 251).toByte() }
                    sender!!.sendH264(data); bytes.addAndGet(data.size.toLong()); chunks.incrementAndGet()
                    Thread.sleep(33)
                }
                Thread.sleep(1000)
            }
            result.putString("result", "passed")
        } catch (error: Throwable) { result.putString("result", "failed"); result.putString("error", error.message ?: error.javaClass.simpleName) }
        finally {
            runOnMainSync { bridge?.stop(); sender?.dispose() }
            result.putLong("bytes", bytes.get()); result.putLong("chunks", chunks.get())
            result.putString("trace", trace.joinToString("\n"))
            finish(if (result.getString("result") == "passed") -1 else 0, result)
        }
    }
}
