package com.rabi.link.protocol;

import java.net.URI;

/** Control travels over the paired CXR link; media is restricted to the phone's LAN. */
public final class RabiGlassVideoProtocol {
    public static final String CHANNEL = "rabi_video_control";
    public static final String REPLY = "rabi_video_status";
    public static final String PREFIX = "RABI_VIDEO:";
    public static final long LEASE_MS = 15000;
    private RabiGlassVideoProtocol() { }

    public static boolean isLocalReceiver(String value) {
        try {
            URI uri = new URI(value);
            if (!"rtmp".equals(uri.getScheme()) || uri.getPort() != 1936
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || !uri.getPath().matches("/rabi/[a-f0-9]{32}")) return false;
            String[] parts = uri.getHost().split("\\.");
            if (parts.length != 4) return false;
            int[] ip = new int[4];
            for (int i = 0; i < 4; i++) {
                if (!parts[i].matches("[0-9]{1,3}")) return false;
                ip[i] = Integer.parseInt(parts[i]);
                if (ip[i] > 255) return false;
            }
            return ip[0] == 10 || (ip[0] == 192 && ip[1] == 168)
                    || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31);
        } catch (Exception ignored) { return false; }
    }
}
