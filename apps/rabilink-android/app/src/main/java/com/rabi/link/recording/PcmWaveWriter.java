package com.rabi.link.recording;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/** 16 kHz mono PCM with a recoverable header, bounded below the RIFF size limit. */
public final class PcmWaveWriter implements AutoCloseable {
    private final RandomAccessFile output;
    private long bytes;
    private long checkpoint;
    public PcmWaveWriter(File file) throws IOException {
        output = new RandomAccessFile(file, "rw");
        output.setLength(0); header();
    }
    public void write(byte[] pcm) throws IOException {
        if ((pcm.length & 1) != 0) throw new IOException("Unaligned PCM");
        if (bytes + pcm.length > 0xfffffff0L - 44) throw new IOException("Recording size limit");
        output.seek(44 + bytes); output.write(pcm); bytes += pcm.length;
        if (bytes - checkpoint >= 160000) { header(); output.getFD().sync(); checkpoint = bytes; }
    }
    private void number(long n, int count) throws IOException { for (int i = 0; i < count; i++) output.write((int)(n >> (8 * i)) & 255); }
    private void header() throws IOException {
        output.seek(0); output.writeBytes("RIFF"); number(36 + bytes, 4); output.writeBytes("WAVEfmt ");
        number(16, 4); number(1, 2); number(1, 2); number(16000, 4); number(32000, 4); number(2, 2); number(16, 2);
        output.writeBytes("data"); number(bytes, 4);
    }
    @Override public void close() throws IOException { try { header(); output.getFD().sync(); } finally { output.close(); } }
}
