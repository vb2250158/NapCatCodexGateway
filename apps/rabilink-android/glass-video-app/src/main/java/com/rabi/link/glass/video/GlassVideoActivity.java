package com.rabi.link.glass.video;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.graphics.Color;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import com.rokid.cxr.CXRServiceBridge;
import com.rokid.cxr.Caps;
import com.pedro.common.ConnectChecker;
import com.pedro.library.rtmp.RtmpCamera2;
import com.rabi.link.protocol.RabiGlassVideoProtocol;
import org.json.JSONObject;

/** Visible camera owner. Losing the phone lease releases both camera and microphone. */
public final class GlassVideoActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CXRServiceBridge bridge = new CXRServiceBridge();
    private RtmpCamera2 stream;
    private TextView status;
    private String session = "";
    private String pendingUrl = "";
    private long leaseAt;
    private boolean destroyed;
    private boolean locallyStopped;
    private int generation;
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            if (!locallyStopped && !session.isEmpty() && SystemClock.elapsedRealtime() - leaseAt > RabiGlassVideoProtocol.LEASE_MS) {
                locallyStopped = true;
                stop("手机连接超时，已停止", false);
            }
            main.postDelayed(this, 1000);
        }
    };
    private final CXRServiceBridge.MsgCallback commands = new CXRServiceBridge.MsgCallback() {
        @Override public void onReceive(String name, Caps args, byte[] bytes) {
            if (!RabiGlassVideoProtocol.CHANNEL.equals(name) || args == null) return;
            try {
                String raw = args.at(args.size() > 1 ? 1 : 0).getString();
                if (raw != null && raw.startsWith(RabiGlassVideoProtocol.PREFIX)) {
                    JSONObject data = new JSONObject(raw.substring(RabiGlassVideoProtocol.PREFIX.length()));
                    main.post(() -> command(data));
                }
            } catch (Exception ignored) { main.post(() -> report("invalid_command")); }
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL); root.setGravity(Gravity.CENTER); root.setBackgroundColor(Color.BLACK);
        status = new TextView(this); status.setTextColor(Color.WHITE); status.setTextSize(20);
        status.setText("等待 Rabi 自动连接"); root.addView(status);
        Button stop = new Button(this); stop.setText("停止录像"); stop.setOnClickListener(v -> {
            locallyStopped = true; stop("已手动停止", false);
        }); root.addView(stop); setContentView(root);
        bridge.subscribe(RabiGlassVideoProtocol.CHANNEL, commands);
        report("ready"); main.post(watchdog);
    }
    private void command(JSONObject data) {
        if (destroyed) return;
        String id = data.optString("session");
        String action = data.optString("action");
        if (id.isEmpty() || id.length() > 80) return;
        if ("stop".equals(action)) {
            if (id.equals(session)) stop("手机已停止录像", true);
            return;
        }
        if (!"start".equals(action)) return;
        org.json.JSONArray urls = data.optJSONArray("urls");
        if (urls == null || urls.length() == 0 || urls.length() > 8) { report("invalid_receiver"); return; }
        for (int i = 0; i < urls.length(); i++) {
            if (!RabiGlassVideoProtocol.isLocalReceiver(urls.optString(i))) { report("invalid_receiver"); return; }
        }
        if (locallyStopped && id.equals(session)) { report("stopped_on_glasses"); return; }
        leaseAt = SystemClock.elapsedRealtime();
        if (id.equals(session) && (stream != null || !pendingUrl.isEmpty())) return;
        stop("正在连接手机", true);
        locallyStopped = false; session = id; pendingUrl = "resolving"; leaseAt = SystemClock.elapsedRealtime();
        final int currentGeneration = generation;
        new Thread(() -> {
            String reachable = "";
            for (int i = 0; i < urls.length(); i++) {
                String candidate = urls.optString(i);
                try (java.net.Socket socket = new java.net.Socket()) {
                    java.net.URI uri = java.net.URI.create(candidate);
                    socket.connect(new java.net.InetSocketAddress(uri.getHost(), uri.getPort()), 1500);
                    reachable = candidate; break;
                } catch (Exception ignored) { }
            }
            final String selected = reachable;
            main.post(() -> {
                if (destroyed || generation != currentGeneration) return;
                if (selected.isEmpty()) { stop("连接手机热点或同一 Wi-Fi 后重试", true); report("network_unreachable"); return; }
                pendingUrl = selected; requestCapture();
            });
        }, "rabi-video-network").start();
    }
    private void requestCapture() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status.setText("请允许相机和麦克风权限"); report("permission_required");
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 9120);
            return;
        }
        begin();
    }
    private void begin() {
        if (!RabiGlassVideoProtocol.isLocalReceiver(pendingUrl) || destroyed) return;
        try {
            final int currentGeneration = generation;
            RtmpCamera2 owned = new RtmpCamera2(this, true, new ConnectChecker() {
                @Override public void onConnectionStarted(String url) { }
                @Override public void onConnectionSuccess() { main.post(() -> {
                    if (generation == currentGeneration && stream != null) { status.setText("● 视频与声音发送中"); report("publishing"); }
                }); }
                @Override public void onConnectionFailed(String reason) { main.post(() -> { if (generation == currentGeneration) stop("无法连接手机，请检查热点", true); }); }
                @Override public void onDisconnect() { main.post(() -> { if (generation == currentGeneration && stream != null) stop("手机连接已断开", true); }); }
                @Override public void onAuthError() { main.post(() -> { if (generation == currentGeneration) stop("手机拒绝接收", true); }); }
                @Override public void onAuthSuccess() { }
                @Override public void onNewBitrate(long bitrate) { }
            });
            stream = owned;
            owned.getStreamClient().setLogs(false);
            if (!owned.prepareVideo(1280, 720, 30, 2_000_000, 0)
                    || !owned.prepareAudio(64000, 32000, false)) {
                stop("相机或声音编码不可用", true); report("capture_failed"); return;
            }
            String destination = pendingUrl; pendingUrl = "";
            status.setText("正在开启相机与声音"); owned.startStream(destination);
        } catch (Exception error) { stop("无法开启相机或麦克风", true); report("capture_failed"); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != 9120) return;
        if (results.length == 2 && results[0] == PackageManager.PERMISSION_GRANTED && results[1] == PackageManager.PERMISSION_GRANTED) begin();
        else { locallyStopped = true; stop("未获得相机或麦克风权限", false); report("permission_denied"); }
    }
    private void stop(String message, boolean clearSession) {
        generation++;
        RtmpCamera2 owned = stream; stream = null; pendingUrl = "";
        if (owned != null) { try { owned.stopStream(); owned.stopPreview(); } catch (Exception ignored) { } }
        if (status != null) status.setText(message);
        report("stopped");
        if (clearSession) session = "";
    }
    private void report(String state) {
        try { Caps args = new Caps(); args.write("protocol"); args.write("RABI_VIDEO_STATUS:" + state);
            bridge.sendMessage(RabiGlassVideoProtocol.REPLY, args);
        } catch (Exception ignored) { }
        android.util.Log.i("RabiGlassVideo", state);
    }
    @Override protected void onDestroy() {
        destroyed = true; main.removeCallbacksAndMessages(null); stop("已退出录像", true); super.onDestroy();
    }
}
