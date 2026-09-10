package com.rabi.link.recording;

import org.junit.Test;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.ArrayList;
import static org.junit.Assert.*;

public class RecordingSafetyTest {
    @Test public void simultaneousRequestsCannotOwnTwoCaptureModes() throws Exception {
        AtomicInteger winners = new AtomicInteger();
        CountDownLatch ready = new CountDownLatch(12), start = new CountDownLatch(1);
        ArrayList<Thread> threads = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            String id = "request-" + i;
            Thread thread = new Thread(() -> {
                ready.countDown();
                try { start.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
                if (CaptureOwnership.acquire(id)) winners.incrementAndGet();
            });
            threads.add(thread); thread.start();
        }
        ready.await(); start.countDown(); for (Thread thread : threads) thread.join();
        try {
            assertEquals(1, winners.get());
            String winner = CaptureOwnership.current();
            CaptureOwnership.release("unrelated-service"); assertEquals(winner, CaptureOwnership.current());
            assertFalse(CaptureOwnership.acquire("video"));
        } finally { CaptureOwnership.release(CaptureOwnership.current()); }
        assertTrue(CaptureOwnership.acquire("audio")); CaptureOwnership.release("audio");
    }
    @Test public void savedWaveHasCorrectLengthsAndUnmodifiedAudio() throws Exception {
        File file = File.createTempFile("rabi-recording-", ".wav");
        byte[] pcm = new byte[32000]; for (int i = 0; i < pcm.length; i++) pcm[i] = (byte)i;
        try {
            try (PcmWaveWriter writer = new PcmWaveWriter(file)) { writer.write(pcm); writer.write(pcm); }
            byte[] wave = Files.readAllBytes(file.toPath());
            ByteBuffer header = ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN);
            assertEquals(64044, wave.length); assertEquals(64036, header.getInt(4));
            assertEquals(16000, header.getInt(24)); assertEquals(64000, header.getInt(40));
            assertArrayEquals(pcm, java.util.Arrays.copyOfRange(wave, 44, 32044));
        } finally { file.delete(); }
    }
}
