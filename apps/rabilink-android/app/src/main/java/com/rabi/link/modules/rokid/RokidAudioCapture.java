package com.rabi.link.modules.rokid;

import java.io.ByteArrayOutputStream;

final class RokidAudioCapture {
    private final Object lock = new Object();
    private int bytes;
    private ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private boolean retainPcm = true;
    void setRetainPcm(boolean retain) { synchronized (lock) { retainPcm = retain; if (!retain) buffer.reset(); } }

    void reset() {
        synchronized (lock) {
            bytes = 0;
            buffer = new ByteArrayOutputStream();
        }
    }

    void append(byte[] data, int offset, int length) {
        synchronized (lock) {
            bytes += Math.max(length, 0);
            if (retainPcm && data != null && length > 0 && offset >= 0 && offset < data.length) {
                buffer.write(data, offset, Math.min(length, data.length - offset));
            }
        }
    }

    int bytes() {
        synchronized (lock) {
            return bytes;
        }
    }

    byte[] copyPcm() {
        synchronized (lock) {
            return buffer.toByteArray();
        }
    }
}
