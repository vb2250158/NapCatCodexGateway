package com.rabi.link.modules.rokid;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class RabiDurableAudioSpoolTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    private static RabiDurableAudioSpool.Policy policy(long maxSegmentBytes) {
        return new RabiDurableAudioSpool.Policy(maxSegmentBytes, 5_000L, 1_000_000L, 0L, 0L);
    }

    private static RabiDurableAudioSpool.Policy policyWithRetention(long maxSegmentBytes, long retentionMs) {
        return new RabiDurableAudioSpool.Policy(maxSegmentBytes, 5_000L, 1_000_000L, 0L, retentionMs);
    }

    @Test
    public void offlineCaptureSealsOrderedChecksummedShardsWithoutDroppingOldPcm() throws Exception {
        AtomicLong now = new AtomicLong(1_000L);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(), policy(4L), now::get, file -> Long.MAX_VALUE);
        assertTrue(spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a").accepted);
        now.addAndGet(100L);
        assertTrue(spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a").accepted);

        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        assertNotNull(first);
        assertEquals(1L, first.sequence);
        assertArrayEquals(new byte[]{1, 2, 3, 4}, spool.readPcm(first));
        first = spool.assignServerSequence(first, 1L);
        assertTrue(spool.acknowledge(first.id, 1L, 4L, first.sha256));
        RabiDurableAudioSpool.Segment second = spool.nextUpload();
        assertNotNull(second);
        assertEquals(2L, second.sequence);
        assertArrayEquals(new byte[]{5, 6, 7, 8}, spool.readPcm(second));
    }

    @Test
    public void processRestartRecoversResidualPartialAndKeepsMonotonicSequence() throws Exception {
        File root = temporary.newFolder();
        File segments = new File(root, "segments");
        assertTrue(segments.mkdirs());
        File partial = new File(segments, "00000000000000000007-0000000001200.pcm.partial");
        try (FileOutputStream output = new FileOutputStream(partial)) { output.write(new byte[]{9, 8, 7, 6}); }
        Files.write(new File(partial.getPath() + ".meta").toPath(), new JSONObject()
                .put("schemaVersion", 1)
                .put("sequence", 7L)
                .put("startedAt", 1_200L)
                .put("source", "glasses")
                .put("routeProfileId", "route-glass")
                .toString().getBytes(StandardCharsets.UTF_8));

        AtomicLong now = new AtomicLong(2_000L);
        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(root, policy(4L), now::get, file -> Long.MAX_VALUE);
        RabiDurableAudioSpool.Segment first = recovered.nextUpload();
        assertNotNull(first);
        assertEquals(7L, first.sequence);
        assertEquals("glasses", first.source);
        assertEquals("route-glass", first.routeProfileId);
        assertEquals("crash_recovery", new JSONObject(new String(
                Files.readAllBytes(first.metadataFile.toPath()), StandardCharsets.UTF_8)).getString("sealReason"));
        assertEquals(4L, recovered.health().getLong("totalCapturedBytes"));
        assertEquals(4L, recovered.health().getLong("pendingBytes"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
        first = recovered.assignServerSequence(first, 1L);
        recovered.acknowledge(first.id, 1L, first.bytes, first.sha256);
        recovered.append(new byte[]{1, 1, 2, 2}, "phone", "route-a");
        assertEquals(8L, recovered.nextUpload().sequence);
    }

    @Test
    public void residualPartialWithoutOwnershipIsQuarantinedAndRecordedAsGap() throws Exception {
        File root = temporary.newFolder();
        File segments = new File(root, "segments");
        assertTrue(segments.mkdirs());
        File partial = new File(segments, "00000000000000000003-0000000001200.pcm.partial");
        try (FileOutputStream output = new FileOutputStream(partial)) { output.write(new byte[]{9, 8, 7, 6}); }

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(root, policy(4L),
                () -> 2_000L, file -> Long.MAX_VALUE);

        assertNull(recovered.nextUpload());
        assertEquals(4L, recovered.health().getLong("rejectedBytes"));
        assertEquals(0L, recovered.health().getLong("uncapturedGapBytes"));
        assertEquals(4L, recovered.health().getLong("quarantinedAudioBytes"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
        String audit = new String(Files.readAllBytes(new File(root, "audit.jsonl").toPath()), StandardCharsets.UTF_8);
        assertTrue(audit.contains("partial_missing_ownership"));
    }

    @Test
    public void duplicateAcknowledgementIsIdempotentAndLostResponseCanBeReconciled() throws Exception {
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(),
                new RabiDurableAudioSpool.Policy(4L, 5_000L, 1_000_000L, 0L, 60_000L),
                () -> 5_000L, file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        RabiDurableAudioSpool.Segment pending = spool.assignServerSequence(spool.nextUpload(), 11L);
        assertTrue(spool.reconcileLastServerAck(11L, pending.id, pending.bytes, pending.sha256));
        assertTrue(spool.acknowledge(pending.id, 11L, pending.bytes, pending.sha256));
        assertNull(spool.nextUpload());
    }

    @Test
    public void acknowledgementReceiptTransactionRecoversEveryCommitCutpointExactlyOnce() throws Exception {
        assertAcknowledgementTransactionCutpoint("ack_receipt_committed");
        assertAcknowledgementTransactionCutpoint("ack_metadata_committed");
        assertAcknowledgementTransactionCutpoint("ack_state_committed");
    }

    @Test
    public void fullAcknowledgementJournalRejectsBeforeMetadataMutationWithoutGapOrQuarantine() throws Exception {
        File root = temporary.newFolder("ack-capacity");
        AtomicLong now = new AtomicLong(12_000L);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
            root,
                policyWithRetention(4L, 60_000L),
                now::get,
                file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> { }, 1, 1_000_000L);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        RabiDurableAudioSpool.Segment first = spool.assignServerSequence(spool.nextUpload(), 11L);
        assertTrue(spool.acknowledge(first.id, 11L, first.bytes, first.sha256));
        assertEquals(1L, spool.health().getLong("ackJournalRecords"));
        RabiDurableAudioSpool.Segment second = spool.assignServerSequence(spool.nextUpload(), 12L);
        try {
            spool.acknowledge(second.id, 12L, second.bytes, second.sha256);
            throw new AssertionError("expected durable acknowledgement journal capacity failure");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("capacity exhausted"));
        }
        JSONObject secondMetadata = new JSONObject(new String(
                Files.readAllBytes(second.metadataFile.toPath()), StandardCharsets.UTF_8));
        assertEquals("uploading", secondMetadata.getString("uploadState"));
        assertFalse(secondMetadata.has("acknowledgedAt"));
        assertEquals(4L, spool.health().getLong("totalAcknowledgedBytes"));
        assertEquals(1L, spool.health().getLong("pendingSegments"));
        assertTrue(spool.health().getBoolean("accountingBalanced"));

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), now::get, file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> { }, 1, 1_000_000L);
        assertEquals(4L, recovered.health().getLong("totalAcknowledgedBytes"));
        assertEquals(1L, recovered.health().getLong("totalAcknowledgedSegments"));
        assertEquals(1L, recovered.health().getLong("pendingSegments"));
        assertEquals(second.id, recovered.nextUpload().id);
        assertEquals(0L, recovered.health().getLong("quarantineItems"));
        assertEquals(0L, recovered.health().getLong("capturedGapBytes"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));

        now.set(100_000L);
        recovered.updatePolicy(policy(4L));
        RabiDurableAudioSpool restarted = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> { }, 1, 1_000_000L);
        assertEquals(4L, restarted.health().getLong("totalAcknowledgedBytes"));
        assertEquals(1L, restarted.health().getLong("totalAcknowledgedSegments"));
        assertEquals(1L, restarted.health().getLong("pendingSegments"));
        assertEquals(0L, restarted.health().getLong("quarantineItems"));
        assertTrue(restarted.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void uploadFailureMarkerCannotOverwriteCommittedAcknowledgementReceipt() throws Exception {
        File root = temporary.newFolder("ack-failure-marker");
        AtomicBoolean armed = new AtomicBoolean(false);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), () -> 12_000L, file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> {
                    if (armed.get() && "ack_receipt_committed".equals(stage)) {
                        throw new IllegalStateException("injected crash before backend failure marker");
                    }
                });
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        RabiDurableAudioSpool.Segment pending = spool.assignServerSequence(spool.nextUpload(), 11L);
        armed.set(true);
        IllegalStateException interruption;
        try {
            spool.acknowledge(pending.id, 11L, pending.bytes, pending.sha256);
            throw new AssertionError("expected injected acknowledgement interruption");
        } catch (IllegalStateException expected) {
            interruption = expected;
        }
        spool.markUploadFailure(pending, interruption);
        assertEquals(4L, spool.health().getLong("totalAcknowledgedBytes"));
        assertEquals(0L, spool.health().getLong("pendingSegments"));
        JSONObject metadata = new JSONObject(new String(
                Files.readAllBytes(pending.metadataFile.toPath()), StandardCharsets.UTF_8));
        assertEquals("acked", metadata.getString("uploadState"));

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(
                root, policy(4L), () -> 13_000L, file -> Long.MAX_VALUE);
        assertEquals(4L, recovered.health().getLong("totalAcknowledgedBytes"));
        assertEquals(1L, recovered.health().getLong("totalAcknowledgedSegments"));
        assertEquals(0L, recovered.health().getLong("quarantineItems"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void acknowledgementReceiptRecoversSealedMetadataWithClearedServerAssignment() throws Exception {
        File root = temporary.newFolder("ack-sealed-recovery");
        AtomicBoolean armed = new AtomicBoolean(false);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), () -> 12_000L, file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> {
                    if (armed.get() && "ack_receipt_committed".equals(stage)) {
                        throw new IllegalStateException("injected crash after receipt");
                    }
                });
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        RabiDurableAudioSpool.Segment pending = spool.assignServerSequence(spool.nextUpload(), 11L);
        armed.set(true);
        try {
            spool.acknowledge(pending.id, 11L, pending.bytes, pending.sha256);
            throw new AssertionError("expected injected acknowledgement interruption");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("after receipt"));
        }
        JSONObject interrupted = new JSONObject(new String(
                Files.readAllBytes(pending.metadataFile.toPath()), StandardCharsets.UTF_8));
        interrupted.put("uploadState", "sealed").put("serverSequence", 0L);
        RabiReliableQueueFiles.writeAtomically(
                pending.metadataFile, interrupted.toString().getBytes(StandardCharsets.UTF_8));

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), () -> 13_000L, file -> Long.MAX_VALUE);
        assertEquals(4L, recovered.health().getLong("totalAcknowledgedBytes"));
        assertEquals(0L, recovered.health().getLong("pendingSegments"));
        assertEquals(0L, recovered.health().getLong("quarantineItems"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
        JSONObject completed = new JSONObject(new String(
                Files.readAllBytes(pending.metadataFile.toPath()), StandardCharsets.UTF_8));
        assertEquals("acked", completed.getString("uploadState"));
        assertEquals(11L, completed.getLong("serverSequence"));
    }

    @Test
    public void acknowledgedCleanupCutpointsRecoverWithoutFakeGapQuarantineOrDoubleAccounting() throws Exception {
        assertAcknowledgedCleanupCutpoint("cleanup_before_pcm_delete");
        assertAcknowledgedCleanupCutpoint("cleanup_between_pcm_and_metadata_delete");
        assertAcknowledgedCleanupCutpoint("cleanup_after_metadata_delete_before_state");
    }

    @Test
    public void acknowledgementJournalRetainsTheFullTupleSetBeyondPcmMetadataRetention() throws Exception {
        File root = temporary.newFolder();
        AtomicLong now = new AtomicLong(1_000L);
        long sixHours = 6L * 60L * 60L * 1000L;
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                root,
                new RabiDurableAudioSpool.Policy(4L, 5_000L, 1_000_000L, 0L, sixHours),
                now::get,
                file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        for (long serverSequence = 11L; serverSequence <= 12L; serverSequence++) {
            RabiDurableAudioSpool.Segment segment = spool.nextUpload();
            segment = spool.assignServerSequence(segment, serverSequence);
            assertTrue(spool.acknowledge(segment.id, serverSequence, segment.bytes, segment.sha256));
        }
        now.addAndGet(sixHours + 1L);
        spool.updatePolicy(new RabiDurableAudioSpool.Policy(4L, 5_000L, 1_000_000L, 0L, sixHours));
        assertEquals(0, fileCount(new File(root, "segments"), ".json"));
        assertEquals(0, fileCount(new File(root, "segments"), ".pcm"));

        JSONObject journal = spool.acknowledgedJournal(0L);
        JSONArray records = journal.getJSONArray("records");
        assertEquals(2, records.length());
        assertEquals("audio-00000000000000000001", records.getJSONObject(0).getString("chunkId"));
        assertEquals(11L, records.getJSONObject(0).getLong("serverSequence"));
        assertEquals("audio-00000000000000000002", records.getJSONObject(1).getString("chunkId"));
        assertEquals(12L, records.getJSONObject(1).getLong("serverSequence"));
        assertEquals(96L, journal.getLong("retentionHours"));

        RabiDurableAudioSpool restarted = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE);
        assertEquals(2, restarted.acknowledgedJournal(0L).getJSONArray("records").length());
        assertEquals(8L, restarted.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, restarted.health().getLong("totalAcknowledgedSegments"));
        assertTrue(restarted.health().getBoolean("accountingBalanced"));
    }

    @Test(expected = IllegalStateException.class)
    public void acknowledgedShardStillRejectsConflictingFourTuple() throws Exception {
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(),
                new RabiDurableAudioSpool.Policy(4L, 5_000L, 1_000_000L, 0L, 60_000L),
                () -> 5_000L, file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        RabiDurableAudioSpool.Segment pending = spool.assignServerSequence(spool.nextUpload(), 11L);
        assertTrue(spool.acknowledge(pending.id, 11L, pending.bytes, pending.sha256));
        spool.acknowledge(pending.id, 12L, pending.bytes, pending.sha256);
    }

    @Test
    public void stateBoundarySealsWithoutRestartingRecorderAndPreservesRouteMetadata() throws Exception {
        AtomicLong now = new AtomicLong(10_000L);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(), policy(64L), now::get, file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2}, "phone", "route-a");
        spool.append(new byte[]{3, 4}, "phone", "route-b");
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        assertEquals("route-a", first.routeProfileId);
        assertNotNull(spool.nextUpload("phone", "route-a"));
        assertNull(spool.nextUpload("phone", "route-b"));
        spool.boundary("test_end");
        first = spool.assignServerSequence(first, 1L);
        spool.acknowledge(first.id, 1L, first.bytes, first.sha256);
        assertEquals("route-b", spool.nextUpload().routeProfileId);
    }

    @Test
    public void storageLowRejectsCurrentPcmExplicitlyAndWritesAuditableGap() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root,
                new RabiDurableAudioSpool.Policy(64L, 5_000L, 128L, 100L, 0L),
                () -> 9_000L, file -> 50L);
        RabiDurableAudioSpool.AppendResult result = spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        assertFalse(result.accepted);
        assertEquals("storage_low", result.failure);
        String audit = new String(Files.readAllBytes(new File(root, "audit.jsonl").toPath()), StandardCharsets.UTF_8);
        assertTrue(audit.contains("storage_low"));
        assertTrue(audit.contains("gapId"));
        assertTrue(audit.contains("previousSequence"));
        assertTrue(audit.contains("nextSequence"));
        assertEquals(4L, spool.health().getLong("rejectedBytes"));
        assertEquals(4L, spool.health().getLong("uncapturedGapBytes"));
        assertEquals(0L, spool.health().getLong("totalCapturedBytes"));
        assertTrue(spool.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void oversizedPcmIsSplitOnEvenBoundariesWithoutByteLoss() throws Exception {
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(), policy(4L),
                () -> 10_000L, file -> Long.MAX_VALUE);
        byte[] input = new byte[]{0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
        assertTrue(spool.append(input, "phone", "route-a").accepted);
        spool.boundary("test_end");
        byte[] output = new byte[0];
        long expectedSequence = 1L;
        while (spool.nextUpload() != null) {
            RabiDurableAudioSpool.Segment segment = spool.nextUpload();
            assertEquals(expectedSequence++, segment.sequence);
            assertTrue(segment.bytes <= 4L);
            assertEquals(0L, segment.bytes & 1L);
            byte[] part = spool.readPcm(segment);
            byte[] joined = new byte[output.length + part.length];
            System.arraycopy(output, 0, joined, 0, output.length);
            System.arraycopy(part, 0, joined, output.length, part.length);
            output = joined;
            segment = spool.assignServerSequence(segment, segment.sequence);
            spool.acknowledge(segment.id, segment.sequence, segment.bytes, segment.sha256);
        }
        assertArrayEquals(input, output);
        assertEquals(4L, expectedSequence);
    }

    @Test
    public void storagePressureReclaimsOnlyAcknowledgedShardBeforeRejectingCapture() throws Exception {
        AtomicLong now = new AtomicLong(10_000L);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(),
                new RabiDurableAudioSpool.Policy(4L, 5_000L, 4L, 0L, 60_000L),
                now::get, file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        RabiDurableAudioSpool.Segment first = spool.assignServerSequence(spool.nextUpload(), 1L);
        spool.acknowledge(first.id, 1L, first.bytes, first.sha256);

        assertTrue(spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a").accepted);
        assertEquals(0L, spool.health().getLong("rejectedBytes"));
        assertEquals(2L, spool.nextUpload().sequence);
    }

    @Test
    public void corruptMetadataPoisonsPairAndContinuesWithNextSequence() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = twoSealedShards(root);
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        Files.write(first.metadataFile.toPath(), "not-json".getBytes(StandardCharsets.UTF_8));

        RabiDurableAudioSpool.Segment second = spool.nextUpload();
        assertNotNull(second);
        assertEquals(2L, second.sequence);
        assertFalse(first.pcmFile.exists());
        assertTrue(spool.health().getLong("quarantineItems") >= 1L);
        assertTrue(spool.health().getLong("rejectedBytes") >= 4L);
        assertEquals(4L, spool.health().getLong("quarantinedAudioBytes"));
        assertEquals(4L, spool.health().getLong("pendingBytes"));
        assertTrue(spool.health().getBoolean("accountingBalanced"));
        JSONObject persisted = new JSONObject(new String(
                Files.readAllBytes(new File(root, "state.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(1L, persisted.getLong("pendingSegments"));
    }

    @Test
    public void missingPcmPoisonsMetadataAndContinuesWithNextSequence() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = twoSealedShards(root);
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        assertTrue(first.pcmFile.delete());

        RabiDurableAudioSpool.Segment second = spool.nextUpload();
        assertNotNull(second);
        assertEquals(2L, second.sequence);
        assertFalse(first.metadataFile.exists());
        assertTrue(spool.health().getLong("rejectedBytes") >= 4L);
        assertEquals(4L, spool.health().getLong("capturedGapBytes"));
        assertEquals(4L, spool.health().getLong("pendingBytes"));
        assertTrue(spool.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void checksumMismatchPoisonsPairAndUnblocksNextSequence() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = twoSealedShards(root);
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        Files.write(first.pcmFile.toPath(), new byte[]{9, 9, 9, 9});
        try {
            spool.readPcm(first);
            throw new AssertionError("expected poisoned segment");
        } catch (RabiDurableAudioSpool.PoisonedSegmentException expected) {
            assertTrue(expected.getMessage().contains("checksum"));
        }
        assertEquals(2L, spool.nextUpload().sequence);
        assertFalse(first.metadataFile.exists());
        assertFalse(first.pcmFile.exists());
        assertEquals(4L, spool.health().getLong("quarantinedAudioBytes"));
        assertTrue(spool.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void quarantineIsRetainedUntilExplicitUserConfirmedClear() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = twoSealedShards(root);
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        Files.write(first.pcmFile.toPath(), new byte[]{9, 9, 9, 9});
        try { spool.readPcm(first); } catch (RabiDurableAudioSpool.PoisonedSegmentException expected) { }
        assertTrue(spool.quarantineManifest().getLong("items") >= 1L);
        assertTrue(spool.quarantineManifest().getLong("bytes") > 0L);

        assertTrue(spool.clearQuarantineAfterUserConfirmation());
        assertEquals(0L, spool.quarantineManifest().getLong("items"));
        assertEquals(0L, spool.quarantineManifest().getLong("bytes"));
    }

    @Test
    public void failedPairIsolationKeepsQueueBlockedAndRestartResumesTransaction() throws Exception {
        File root = temporary.newFolder();
        AtomicBoolean failOnce = new AtomicBoolean(true);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root, policy(4L), () -> 10_000L,
                file -> Long.MAX_VALUE, (source, destination) -> {
                    if (destination.getParentFile().getName().startsWith(".quarantine-txn-")
                            && failOnce.compareAndSet(true, false)) {
                        throw new IllegalStateException("injected quarantine move failure");
                    }
                    Files.move(source.toPath(), destination.toPath());
                });
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        RabiDurableAudioSpool.Segment first = spool.nextUpload();
        Files.write(first.metadataFile.toPath(), "not-json".getBytes(StandardCharsets.UTF_8));

        assertNull(spool.nextUpload());
        assertEquals(2L, spool.health().getLong("pendingSegments"));
        assertTrue(spool.health().getString("lastFailure").startsWith("quarantine_transaction_"));

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(root, policy(4L),
                () -> 11_000L, file -> Long.MAX_VALUE);
        assertEquals(2L, recovered.nextUpload().sequence);
        assertEquals(1L, recovered.health().getLong("pendingSegments"));
        assertTrue(recovered.health().getLong("quarantineItems") >= 1L);
        assertTrue(recovered.health().getLong("rejectedBytes") >= 4L);
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
    }

    @Test
    public void auditRotationHasStableIndexAndRecoversAfterIndexCorruption() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root, policy(16L),
                () -> 20_000L, file -> Long.MAX_VALUE);
        spool.recordGap("one", 2L, "phone", "route-a");
        spool.recordGap("two", 4L, "glasses", "route-b");
        java.lang.reflect.Method rotate = RabiDurableAudioSpool.class.getDeclaredMethod("rotateAudit");
        rotate.setAccessible(true);
        rotate.invoke(spool);

        File indexFile = new File(root, "audit-index.json");
        JSONObject index = new JSONObject(new String(Files.readAllBytes(indexFile.toPath()), StandardCharsets.UTF_8));
        JSONObject segment = index.getJSONArray("segments").getJSONObject(0);
        assertEquals("audit-segment-00000000000000000001", segment.getString("segmentId"));
        assertEquals(2L, segment.getLong("records"));
        assertFalse(segment.getString("firstEventId").isEmpty());
        assertFalse(segment.getString("lastEventId").isEmpty());
        assertEquals(64, segment.getString("sha256").length());

        Files.write(indexFile.toPath(), "broken-index".getBytes(StandardCharsets.UTF_8));
        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(root, policy(16L),
                () -> 21_000L, file -> Long.MAX_VALUE);
        recovered.recordGap("three", 6L, "phone", "route-c");
        JSONObject rebuilt = new JSONObject(new String(Files.readAllBytes(indexFile.toPath()), StandardCharsets.UTF_8));
        assertEquals(2, rebuilt.getInt("schemaVersion"));
        String active = new String(Files.readAllBytes(new File(root, "audit.jsonl").toPath()), StandardCharsets.UTF_8);
        assertTrue(active.contains("\"eventSequence\":3"));
        assertEquals(12L, recovered.health().getLong("rejectedBytes"));
    }

    @Test
    public void auditCrashTailIsPreservedAndValidPrefixContinuesMonotonically() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root, policy(16L),
                () -> 30_000L, file -> Long.MAX_VALUE);
        spool.recordGap("before-crash", 2L, "phone", "route-a");
        try (FileOutputStream output = new FileOutputStream(new File(root, "audit.jsonl"), true)) {
            output.write("{broken-tail".getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(root, policy(16L),
                () -> 31_000L, file -> Long.MAX_VALUE);
        recovered.recordGap("after-crash", 2L, "phone", "route-a");
        String audit = new String(Files.readAllBytes(new File(root, "audit.jsonl").toPath()), StandardCharsets.UTF_8);
        assertFalse(audit.contains("broken-tail"));
        assertTrue(audit.contains("\"eventSequence\":2"));
        assertTrue(recovered.health().getLong("auditFailures") >= 1L);
        File[] tails = root.listFiles((directory, name) -> name.startsWith("audit-recovery-tail-") && name.endsWith(".txt"));
        assertNotNull(tails);
        assertEquals(1, tails.length);
    }

    @Test
    public void legacyAuditRowsRecoverWithoutRewritingEvidenceOrResettingNewSequences() throws Exception {
        File root = temporary.newFolder();
        File legacyFile = new File(root, "audit-segment-00000000000000000001.jsonl");
        String legacy = "{\"time\":1000,\"event\":\"gap\",\"details\":{}}\n";
        Files.write(legacyFile.toPath(), legacy.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(root, "audit.jsonl").toPath(),
                "{\"id\":\"prior\",\"eventSequence\":41,\"time\":2000,\"event\":\"gap\",\"details\":{}}\n".getBytes(StandardCharsets.UTF_8));
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root, policy(16L), () -> 30_000L, file -> Long.MAX_VALUE);
        spool.recordGap("new", 2L, "phone", "route-a");
        assertEquals(legacy, new String(Files.readAllBytes(legacyFile.toPath()), StandardCharsets.UTF_8));
        JSONObject index = new JSONObject(new String(Files.readAllBytes(new File(root, "audit-index.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(1, index.getJSONArray("segments").getJSONObject(0).getInt("legacyRecords"));
        assertTrue(new String(Files.readAllBytes(new File(root, "audit.jsonl").toPath()), StandardCharsets.UTF_8).contains("\"eventSequence\":42"));
    }

    @Test
    public void concurrentCaptureAndUploadPreservePendingByteConservation() throws Exception {
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(temporary.newFolder(), policy(16L),
                System::currentTimeMillis, file -> Long.MAX_VALUE);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        CountDownLatch done = new CountDownLatch(2);
        for (int worker = 0; worker < 2; worker++) {
            final String route = "route-" + worker;
            workers.execute(() -> {
                try {
                    for (int index = 0; index < 100; index++) {
                        assertTrue(spool.append(new byte[]{1, 2}, "phone", route).accepted);
                    }
                } finally {
                    done.countDown();
                }
            });
        }
        done.await();
        workers.shutdownNow();
        spool.boundary("test_end");
        long bytes = 0L;
        long expectedSequence = 1L;
        while (spool.nextUpload() != null) {
            RabiDurableAudioSpool.Segment segment = spool.nextUpload();
            assertEquals(expectedSequence++, segment.sequence);
            bytes += spool.readPcm(segment).length;
            segment = spool.assignServerSequence(segment, segment.sequence);
            spool.acknowledge(segment.id, segment.sequence, segment.bytes, segment.sha256);
        }
        assertEquals(400L, bytes);
        assertNull(spool.nextUpload());
    }

    private RabiDurableAudioSpool twoSealedShards(File root) throws Exception {
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root, policy(4L),
                () -> 10_000L, file -> Long.MAX_VALUE);
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        return spool;
    }

    private void assertAcknowledgementTransactionCutpoint(String targetStage) throws Exception {
        File root = temporary.newFolder("ack-transaction-" + targetStage);
        AtomicLong now = new AtomicLong(10_000L);
        AtomicBoolean armed = new AtomicBoolean(false);
        AtomicBoolean fired = new AtomicBoolean(false);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), now::get, file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> {
                    if (armed.get() && targetStage.equals(stage) && fired.compareAndSet(false, true)) {
                        throw new IllegalStateException("injected acknowledgement crash at " + stage);
                    }
                });
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        RabiDurableAudioSpool.Segment first = spool.assignServerSequence(spool.nextUpload(), 21L);
        assertTrue(spool.acknowledge(first.id, 21L, first.bytes, first.sha256));
        RabiDurableAudioSpool.Segment second = spool.assignServerSequence(spool.nextUpload(), 22L);
        armed.set(true);
        try {
            spool.acknowledge(second.id, 22L, second.bytes, second.sha256);
            throw new AssertionError("expected injected acknowledgement crash");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains(targetStage));
        }
        assertTrue(fired.get());

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(
                root, policyWithRetention(4L, 60_000L), now::get, file -> Long.MAX_VALUE);
        assertEquals(8L, recovered.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, recovered.health().getLong("totalAcknowledgedSegments"));
        assertEquals(0L, recovered.health().getLong("pendingSegments"));
        assertEquals(2L, recovered.health().getLong("ackJournalRecords"));
        assertEquals(0L, recovered.health().getLong("quarantineItems"));
        assertEquals(0L, recovered.health().getLong("capturedGapBytes"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));

        now.set(100_000L);
        recovered.updatePolicy(policy(4L));
        RabiDurableAudioSpool restarted = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE);
        assertEquals(8L, restarted.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, restarted.health().getLong("totalAcknowledgedSegments"));
        assertEquals(0L, restarted.health().getLong("pendingSegments"));
        assertEquals(0L, restarted.health().getLong("quarantineItems"));
        assertTrue(restarted.health().getBoolean("accountingBalanced"));

        RabiDurableAudioSpool restartedAgain = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE);
        assertEquals(8L, restartedAgain.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, restartedAgain.health().getLong("totalAcknowledgedSegments"));
        assertTrue(restartedAgain.health().getBoolean("accountingBalanced"));
    }

    private void assertAcknowledgedCleanupCutpoint(String targetStage) throws Exception {
        File root = temporary.newFolder("cleanup-" + targetStage);
        AtomicLong now = new AtomicLong(10_000L);
        AtomicBoolean armed = new AtomicBoolean(false);
        AtomicBoolean fired = new AtomicBoolean(false);
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                root,
                new RabiDurableAudioSpool.Policy(4L, 5_000L, 1_000_000L, 0L, 60_000L),
                now::get,
                file -> Long.MAX_VALUE,
                (source, destination) -> Files.move(source.toPath(), destination.toPath()),
                stage -> {
                    if (armed.get() && targetStage.equals(stage) && fired.compareAndSet(false, true)) {
                        throw new IllegalStateException("injected cleanup crash at " + stage);
                    }
                });
        spool.append(new byte[]{1, 2, 3, 4}, "phone", "route-a");
        spool.append(new byte[]{5, 6, 7, 8}, "phone", "route-a");
        for (long serverSequence = 21L; serverSequence <= 22L; serverSequence++) {
            RabiDurableAudioSpool.Segment segment = spool.nextUpload();
            segment = spool.assignServerSequence(segment, serverSequence);
            assertTrue(spool.acknowledge(segment.id, serverSequence, segment.bytes, segment.sha256));
        }
        assertEquals(2, spool.acknowledgedJournal(0L).getJSONArray("records").length());
        now.set(100_000L);
        armed.set(true);
        try {
            spool.updatePolicy(policy(4L));
            throw new AssertionError("expected injected acknowledged cleanup crash");
        } catch (RuntimeException expected) {
            assertTrue(expected.getMessage().contains(targetStage));
        }
        assertTrue(fired.get());

        RabiDurableAudioSpool recovered = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE);
        assertEquals(8L, recovered.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, recovered.health().getLong("totalAcknowledgedSegments"));
        assertEquals(0L, recovered.health().getLong("pendingSegments"));
        assertEquals(0L, recovered.health().getLong("quarantineItems"));
        assertEquals(0L, recovered.health().getLong("quarantinedAudioBytes"));
        assertEquals(0L, recovered.health().getLong("capturedGapBytes"));
        assertEquals(0L, recovered.health().getLong("rejectedBytes"));
        assertTrue(recovered.health().getBoolean("accountingBalanced"));
        assertEquals(2, recovered.acknowledgedJournal(0L).getJSONArray("records").length());
        assertEquals(0, fileCount(new File(root, "segments"), ".json"));
        assertEquals(0, fileCount(new File(root, "segments"), ".pcm"));
        assertEquals(0, fileCount(new File(root, "cleanup-tombstones"), ".json"));

        RabiDurableAudioSpool restarted = new RabiDurableAudioSpool(
                root, policy(4L), now::get, file -> Long.MAX_VALUE);
        assertEquals(8L, restarted.health().getLong("totalAcknowledgedBytes"));
        assertEquals(2L, restarted.health().getLong("totalAcknowledgedSegments"));
        assertEquals(2, restarted.acknowledgedJournal(0L).getJSONArray("records").length());
        assertTrue(restarted.health().getBoolean("accountingBalanced"));
    }

    private static int fileCount(File directory, String suffix) {
        File[] files = directory.listFiles((parent, name) -> name.endsWith(suffix));
        return files == null ? 0 : files.length;
    }
}
