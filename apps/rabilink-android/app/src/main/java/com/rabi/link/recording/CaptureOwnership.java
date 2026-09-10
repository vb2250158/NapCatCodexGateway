package com.rabi.link.recording;

import java.util.concurrent.CopyOnWriteArraySet;

/** Process-wide exclusion. Owners release only after hardware and pending writes are closed. */
public final class CaptureOwnership {
    private static String owner = "";
    private static final CopyOnWriteArraySet<Runnable> listeners = new CopyOnWriteArraySet<>();
    public static synchronized String current() { return owner; }
    public static synchronized boolean acquire(String next) {
        if (!owner.isEmpty() && !owner.equals(next)) return false;
        owner = next;
        changed();
        return true;
    }
    public static synchronized void release(String expected) {
        if (!owner.equals(expected)) return;
        owner = "";
        changed();
    }
    public static void listen(Runnable listener) { listeners.add(listener); }
    public static void unlisten(Runnable listener) { listeners.remove(listener); }
    private static void changed() { for (Runnable listener : listeners) listener.run(); }
    private CaptureOwnership() { }
}
