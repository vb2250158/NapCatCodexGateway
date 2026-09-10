package com.rabi.link.modules.rokid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * Phone-local source of truth for continuous PCM.
 *
 * Capture writes a durable .partial shard without consulting the network. Upload reads only
 * sealed shards and records its own acknowledgement state, so transport retries never block or
 * mutate the live capture file.
 */
final class RabiDurableAudioSpool {
    interface Clock { long now(); }
    interface SpaceProbe { long usableBytes(File directory); }
    interface FileMover { void move(File source, File destination) throws Exception; }
    interface Cutpoint { void reached(String stage) throws Exception; }

    static final class Policy {
        final long maxSegmentBytes;
        final long maxSegmentDurationMs;
        final long maxStorageBytes;
        final long reserveFreeBytes;
        final long acknowledgedRetentionMs;

        Policy(long maxSegmentBytes, long maxSegmentDurationMs, long maxStorageBytes,
               long reserveFreeBytes, long acknowledgedRetentionMs) {
            if (maxSegmentBytes < 2 || maxSegmentDurationMs < 1 || maxStorageBytes < maxSegmentBytes) {
                throw new IllegalArgumentException("invalid durable audio policy");
            }
            this.maxSegmentBytes = maxSegmentBytes & ~1L;
            this.maxSegmentDurationMs = maxSegmentDurationMs;
            this.maxStorageBytes = maxStorageBytes;
            this.reserveFreeBytes = Math.max(0L, reserveFreeBytes);
            this.acknowledgedRetentionMs = Math.max(0L, acknowledgedRetentionMs);
        }
    }

    static final class AppendResult {
        final boolean accepted;
        final long segmentSequence;
        final String failure;

        AppendResult(boolean accepted, long segmentSequence, String failure) {
            this.accepted = accepted;
            this.segmentSequence = segmentSequence;
            this.failure = failure == null ? "" : failure;
        }
    }

    static final class Segment {
        final long sequence;
        final String id;
        final File pcmFile;
        final File metadataFile;
        final long startedAt;
        final long endedAt;
        final long bytes;
        final String sha256;
        final String source;
        final String routeProfileId;
        final String uploadState;
        final long serverSequence;
        final long acknowledgedAt;

        Segment(JSONObject value, File pcmFile, File metadataFile) {
            sequence = value.optLong("sequence", 0L);
            id = value.optString("id", idFor(sequence));
            this.pcmFile = pcmFile;
            this.metadataFile = metadataFile;
            startedAt = value.optLong("startedAt", 0L);
            endedAt = value.optLong("endedAt", 0L);
            bytes = value.optLong("bytes", pcmFile.length());
            sha256 = value.optString("sha256", "");
            source = value.optString("source", "phone");
            routeProfileId = value.optString("routeProfileId", "");
            uploadState = value.optString("uploadState", "sealed");
            serverSequence = value.optLong("serverSequence", 0L);
            acknowledgedAt = value.optLong("acknowledgedAt", 0L);
        }
    }

    static final class PoisonedSegmentException extends Exception {
        final boolean isolated;
        PoisonedSegmentException(String reason, boolean isolated) {
            super(reason);
            this.isolated = isolated;
        }
    }

    private static final class CleanupInterruptedException extends RuntimeException {
        CleanupInterruptedException(String stage, Throwable cause) {
            super("injected durable cleanup interruption at " + stage, cause);
        }
    }

    private static final String STATE_FILE = "state.json";
    private static final String AUDIT_FILE = "audit.jsonl";
    private static final String AUDIT_INDEX_FILE = "audit-index.json";
    private static final String ACK_JOURNAL_DIRECTORY = "ack-journal";
    private static final String CLEANUP_TOMBSTONE_DIRECTORY = "cleanup-tombstones";
    private static final String QUARANTINE_TXN_PREFIX = ".quarantine-txn-";
    private static final long AUDIT_MAX_BYTES = 4L * 1024L * 1024L;
    private static final long ACK_JOURNAL_RETENTION_MS = 96L * 60L * 60L * 1000L;
    private static final long ACK_JOURNAL_MAX_BYTES = 128L * 1024L * 1024L;
    private static final int ACK_JOURNAL_MAX_RECORDS = 100_000;
    private static final long SYNC_INTERVAL_MS = 1_000L;

    private final File root;
    private final File segmentsDirectory;
    private final File ackJournalDirectory;
    private final File cleanupTombstoneDirectory;
    private final File stateFile;
    private final File auditFile;
    private Policy policy;
    private final Clock clock;
    private final SpaceProbe spaceProbe;
    private final FileMover fileMover;
    private final Cutpoint cutpoint;
    private final int ackJournalMaxRecords;
    private final long ackJournalMaxBytes;
    private long nextAuditEventSequence = 1L;
    private long nextAuditSegmentSequence = 1L;
    private long auditFailures;
    private final Set<String> auditEventIds = new HashSet<>();
    private long nextSequence;
    private File activePartial;
    private File activePartialMetadata;
    private FileOutputStream activeOutput;
    private long activeSequence;
    private long activeStartedAt;
    private long activeBytes;
    private long lastSyncAt;
    private String activeSource = "";
    private String activeRoute = "";
    private long lastCapturedAt;
    private long lastWrittenAt;
    private long lastUploadedAt;
    private long rejectedBytes;
    private long uncapturedGapBytes;
    private long totalCapturedBytes;
    private long totalAcknowledgedBytes;
    private long totalAcknowledgedSegments;
    private long acknowledgedAccountingSequence;
    private boolean inferAcknowledgedAccountingSequence;
    private long quarantinedAudioBytes;
    private long capturedGapBytes;
    private long accountedQuarantineManifestAudioBytes;
    private long accountedQuarantineManifestGapBytes;
    private long quarantineBytes;
    private long quarantineItems;
    private String lastFailure = "";
    private long totalStoredBytes;
    private long lastCleanupAt;
    private long ackJournalBytes;
    private long ackJournalRecords;
    private long ackJournalMaxSourceSequence;
    private final List<File> recoveredCleanupTombstones = new ArrayList<>();
    private final TreeSet<Long> pendingSequences = new TreeSet<>();
    private final TreeSet<Long> acknowledgedSequences = new TreeSet<>();

    RabiDurableAudioSpool(File root, Policy policy) throws Exception {
        this(root, policy, System::currentTimeMillis, File::getUsableSpace,
                RabiDurableAudioSpool::moveReplacing, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe) throws Exception {
        this(root, policy, clock, spaceProbe, RabiDurableAudioSpool::moveReplacing, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover) throws Exception {
        this(root, policy, clock, spaceProbe, fileMover, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover, Cutpoint cutpoint) throws Exception {
        this(root, policy, clock, spaceProbe, fileMover, cutpoint,
                ACK_JOURNAL_MAX_RECORDS, ACK_JOURNAL_MAX_BYTES);
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover, Cutpoint cutpoint,
                          int ackJournalMaxRecords, long ackJournalMaxBytes) throws Exception {
        if (ackJournalMaxRecords < 1 || ackJournalMaxBytes < 1L) {
            throw new IllegalArgumentException("invalid durable acknowledgement journal capacity");
        }
        this.root = root;
        this.policy = policy;
        this.clock = clock;
        this.spaceProbe = spaceProbe;
        this.fileMover = fileMover;
        this.cutpoint = cutpoint;
        this.ackJournalMaxRecords = ackJournalMaxRecords;
        this.ackJournalMaxBytes = ackJournalMaxBytes;
        this.segmentsDirectory = new File(root, "segments");
        this.ackJournalDirectory = new File(root, ACK_JOURNAL_DIRECTORY);
        this.cleanupTombstoneDirectory = new File(root, CLEANUP_TOMBSTONE_DIRECTORY);
        this.stateFile = new File(root, STATE_FILE);
        this.auditFile = new File(root, AUDIT_FILE);
        ensureDirectory(root);
        ensureDirectory(segmentsDirectory);
        ensureDirectory(ackJournalDirectory);
        ensureDirectory(cleanupTombstoneDirectory);
        recover();
    }

    synchronized AppendResult append(byte[] pcm, String source, String routeProfileId) {
        if (pcm == null || pcm.length == 0) return new AppendResult(true, activeSequence, "");
        if ((pcm.length & 1) != 0) {
            recordGap("invalid_pcm_alignment", pcm.length, source, routeProfileId);
            return new AppendResult(false, 0L, "invalid_pcm_alignment");
        }
        long now = clock.now();
        lastCapturedAt = now;
        int offset = 0;
        String normalizedSource = clean(source, "phone");
        String normalizedRoute = clean(routeProfileId, "");
        try {
            if (activeOutput != null && (!activeSource.equals(normalizedSource) || !activeRoute.equals(normalizedRoute))) {
                sealActive("state_boundary");
            }
            if (now - lastCleanupAt >= 60_000L) cleanupAcknowledged(false);
            long writtenSequence = activeSequence;
            while (offset < pcm.length) {
                if (activeOutput != null && now - activeStartedAt >= policy.maxSegmentDurationMs) {
                    sealActive("duration_boundary");
                }
                long room = activeOutput == null ? policy.maxSegmentBytes : policy.maxSegmentBytes - activeBytes;
                if (room < 2L) {
                    sealActive("size_boundary");
                    continue;
                }
                int count = (int) Math.min((long) pcm.length - offset, room);
                count &= ~1;
                if (count <= 0) throw new IllegalStateException("invalid even PCM shard boundary");
                if (!hasStorageFor(count)) {
                    if (activeOutput != null) sealActive("storage_boundary");
                    cleanupAcknowledged(true);
                    if (!hasStorageFor(count)) {
                        long rejected = pcm.length - offset;
                        recordGap("storage_low", rejected, normalizedSource, normalizedRoute);
                        return new AppendResult(false, writtenSequence, "storage_low");
                    }
                }
                if (activeOutput == null) openActive(normalizedSource, normalizedRoute, now);
                activeOutput.write(pcm, offset, count);
                offset += count;
                activeBytes += count;
                totalStoredBytes += count;
                totalCapturedBytes += count;
                writtenSequence = activeSequence;
                lastWrittenAt = now;
                if (now - lastSyncAt >= SYNC_INTERVAL_MS) syncActive(now);
                if (activeBytes >= policy.maxSegmentBytes) sealActive("size_boundary");
            }
            return new AppendResult(true, writtenSequence, "");
        } catch (Throwable error) {
            String reason = "write_" + error.getClass().getSimpleName();
            recordGap(reason, Math.max(0L, pcm.length - offset), normalizedSource, normalizedRoute);
            return new AppendResult(false, 0L, reason);
        }
    }

    synchronized void updatePolicy(Policy policy) {
        if (policy == null) return;
        this.policy = policy;
        cleanupAcknowledged(false);
    }

    synchronized void boundary(String reason) {
        try {
            sealActive(clean(reason, "state_boundary"));
        } catch (Throwable error) {
            recordGap("seal_" + error.getClass().getSimpleName(), 0L, activeSource, activeRoute);
        }
    }

    synchronized void recordGap(String reason, long estimatedBytes, String source, String routeProfileId) {
        recordGapWithId("gap-" + UUID.randomUUID(), reason, estimatedBytes, source, routeProfileId, true);
    }

    private void recordGapWithId(String gapId, String reason, long estimatedBytes,
                                 String source, String routeProfileId, boolean uncaptured) {
        String auditId = "audit-" + clean(gapId, "gap-unknown");
        if (auditEventIds.contains(auditId)) return;
        rejectedBytes += Math.max(0L, estimatedBytes);
        if (uncaptured) uncapturedGapBytes += Math.max(0L, estimatedBytes);
        lastFailure = clean(reason, "capture_gap");
        try {
            long now = clock.now();
            appendAuditWithId(auditId, "gap", new JSONObject()
                    .put("gapId", gapId)
                    .put("reason", lastFailure)
                    .put("estimatedBytes", Math.max(0L, estimatedBytes))
                    .put("accountingClass", uncaptured ? "uncaptured" : "captured")
                    .put("startedAt", now)
                    .put("endedAt", now)
                    .put("previousSequence", Math.max(0L, nextSequence - 1L))
                    .put("nextSequence", Math.max(1L, nextSequence))
                    .put("source", clean(source, "phone"))
                    .put("routeProfileId", clean(routeProfileId, "")));
        } catch (Throwable error) {
            lastFailure = "audit_gap_" + error.getClass().getSimpleName();
        }
        try { persistState(); } catch (Throwable error) {
            lastFailure = "state_gap_" + error.getClass().getSimpleName();
        }
    }

    synchronized Segment nextUpload() {
        while (!pendingSequences.isEmpty()) {
            long sequence = pendingSequences.first();
            File metadata = metadataForSequence(sequence);
            try {
                Segment segment = readSegment(metadata);
                if (segment != null && !"acked".equals(segment.uploadState)) return segment;
                pendingSequences.remove(sequence);
            } catch (Throwable error) {
                boolean isolated = poisonSequence(sequence, metadata,
                        "metadata_" + error.getClass().getSimpleName(), "unknown", "", 0L);
                if (!isolated) return null;
            }
        }
        return null;
    }

    synchronized Segment nextUpload(String source, String routeProfileId) {
        Segment segment = nextUpload();
        if (segment == null) return null;
        String normalizedSource = clean(source, "phone");
        String normalizedRoute = clean(routeProfileId, "");
        return segment.source.equals(normalizedSource) && segment.routeProfileId.equals(normalizedRoute)
                ? segment : null;
    }

    synchronized Segment assignServerSequence(Segment segment, long serverSequence) throws Exception {
        if (segment == null || serverSequence <= 0L) throw new IllegalArgumentException("invalid upload assignment");
        JSONObject value = readJson(segment.metadataFile);
        value.put("uploadState", "uploading")
                .put("serverSequence", serverSequence)
                .put("lastAttemptAt", clock.now())
                .put("attempts", value.optInt("attempts", 0) + 1);
        value.remove("lastError");
        writeJson(segment.metadataFile, value);
        return readSegment(segment.metadataFile);
    }

    synchronized boolean acknowledge(String segmentId, long serverSequence, long acceptedBytes, String checksum) throws Exception {
        File metadata = metadataForId(segmentId);
        if (!metadata.exists()) return false;
        JSONObject value = readJson(metadata);
        if (!clean(segmentId, "").equals(value.optString("id", ""))
                || value.optLong("serverSequence", 0L) != serverSequence
                || value.optLong("bytes", -1L) != acceptedBytes
                || !value.optString("sha256", "").equalsIgnoreCase(clean(checksum, ""))) {
            throw new IllegalStateException("audio acknowledgement does not match sealed shard");
        }
        if ("acked".equals(value.optString("uploadState"))) {
            ensureAckJournal(value);
            return true;
        }
        long now = clock.now();
        JSONObject receipt = new JSONObject(value.toString()).put("acknowledgedAt", now);
        ensureAckJournal(receipt);
        cutpoint.reached("ack_receipt_committed");
        completeAcknowledgement(metadata, value, receipt);
        return true;
    }

    private void completeAcknowledgement(File metadata, JSONObject value, JSONObject receipt) throws Exception {
        long localSequence = receipt.getLong("sequence");
        long acceptedBytes = receipt.getLong("bytes");
        long now = receipt.getLong("acknowledgedAt");
        value.put("uploadState", "acked")
                .put("acknowledgedAt", now)
                .put("serverSequence", receipt.getLong("serverSequence"));
        value.remove("lastError");
        writeJson(metadata, value);
        cutpoint.reached("ack_metadata_committed");
        pendingSequences.remove(localSequence);
        acknowledgedSequences.add(localSequence);
        accountAcknowledged(localSequence, acceptedBytes);
        lastUploadedAt = now;
        lastFailure = "";
        persistState();
        cutpoint.reached("ack_state_committed");
        appendAudit("acknowledged", new JSONObject().put("id", receipt.getString("id")).put("sequence", localSequence)
                .put("serverSequence", receipt.getLong("serverSequence")).put("bytes", acceptedBytes));
        cleanupAcknowledged(false);
        persistState();
    }

    synchronized void markUploadFailure(Segment segment, Throwable error) {
        if (segment == null) return;
        try {
            JSONObject current = readJson(segment.metadataFile);
            if ("acked".equals(current.optString("uploadState", ""))) return;
            File receiptFile = ackJournalForSequence(segment.sequence);
            if (receiptFile.exists()) {
                JSONObject receipt = readAckJournalRecord(receiptFile);
                if (!ackTupleMatchesMetadata(receipt, current)) {
                    throw new IllegalStateException("durable acknowledgement receipt conflicts with upload metadata");
                }
                completeAcknowledgement(segment.metadataFile, current, journalAsMetadata(receipt, current));
                return;
            }
            String detail = error == null ? "upload_failed" : clean(error.getMessage(), error.getClass().getSimpleName());
            if (detail.length() > 240) detail = detail.substring(0, 240);
            JSONObject value = current
                    .put("uploadState", "failed")
                    .put("lastError", detail)
                    .put("lastFailureAt", clock.now());
            writeJson(segment.metadataFile, value);
            lastFailure = value.optString("lastError", "upload_failed");
            appendAudit("upload_failed", new JSONObject().put("id", segment.id).put("reason", lastFailure));
            persistState();
        } catch (Throwable ignored) {
            lastFailure = "upload_state_write_failed";
        }
    }

    synchronized boolean reconcileLastServerAck(long serverSequence, String segmentId,
                                                 long acceptedBytes, String checksum) throws Exception {
        Segment segment = nextUpload();
        if (segment == null || segment.serverSequence <= 0L) return false;
        if (segment.serverSequence != serverSequence
                || !segment.id.equals(clean(segmentId, ""))
                || segment.bytes != acceptedBytes
                || !segment.sha256.equalsIgnoreCase(clean(checksum, ""))) return false;
        return acknowledge(segment.id, serverSequence, segment.bytes, segment.sha256);
    }

    synchronized void resetHeadServerAssignment() throws Exception {
        Segment segment = nextUpload();
        if (segment == null || segment.serverSequence == 0L) return;
        JSONObject value = readJson(segment.metadataFile).put("uploadState", "sealed").put("serverSequence", 0L);
        writeJson(segment.metadataFile, value);
    }

    synchronized byte[] readPcm(Segment segment) throws Exception {
        if (segment == null) return new byte[0];
        byte[] data = RabiReliableQueueFiles.read(segment.pcmFile);
        if (data.length != segment.bytes || !sha256(data).equalsIgnoreCase(segment.sha256)) {
            boolean isolated = poisonSegment(segment, "checksum_mismatch");
            throw new PoisonedSegmentException("sealed audio shard checksum mismatch", isolated);
        }
        return data;
    }

    synchronized JSONObject health() {
        JSONObject value = new JSONObject();
        try {
            long pendingAudioBytes = pendingAudioBytes();
            long accountedCapturedBytes = totalAcknowledgedBytes + pendingAudioBytes + activeBytes
                    + quarantinedAudioBytes + capturedGapBytes;
            value.put("lastCapturedAt", lastCapturedAt)
                    .put("lastWrittenAt", lastWrittenAt)
                    .put("lastUploadedAt", lastUploadedAt)
                    .put("activePartialBytes", activeBytes)
                    .put("pendingSegments", pendingSequences.size())
                    .put("pendingBytes", pendingAudioBytes)
                    .put("acknowledgedSegments", acknowledgedSequences.size())
                    .put("storedBytes", totalStoredBytes)
                    .put("quarantineBytes", quarantineBytes)
                    .put("quarantineItems", quarantineItems)
                    .put("rejectedBytes", rejectedBytes)
                    .put("uncapturedGapBytes", uncapturedGapBytes)
                    .put("totalCapturedBytes", totalCapturedBytes)
                    .put("totalAcknowledgedBytes", totalAcknowledgedBytes)
                    .put("totalAcknowledgedSegments", totalAcknowledgedSegments)
                    .put("ackJournalRecords", ackJournalRecords)
                    .put("ackJournalBytes", ackJournalBytes)
                    .put("ackJournalMaxSourceSequence", ackJournalMaxSourceSequence)
                    .put("ackJournalRetentionHours", ACK_JOURNAL_RETENTION_MS / (60L * 60L * 1000L))
                    .put("ackJournalMaxRecords", ackJournalMaxRecords)
                    .put("ackJournalMaxBytes", ackJournalMaxBytes)
                    .put("quarantinedAudioBytes", quarantinedAudioBytes)
                    .put("capturedGapBytes", capturedGapBytes)
                    .put("accountedCapturedBytes", accountedCapturedBytes)
                    .put("accountingBalanced", totalCapturedBytes == accountedCapturedBytes)
                    .put("auditFailures", auditFailures)
                    .put("nextAuditEventSequence", nextAuditEventSequence)
                    .put("lastFailure", lastFailure);
        } catch (Throwable ignored) { }
        return value;
    }

    synchronized JSONObject acknowledgedJournal(long afterSourceSequence) throws Exception {
        JSONArray records = new JSONArray();
        long maximum = Math.max(0L, afterSourceSequence);
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            long sequence = record.getLong("sourceSequence");
            maximum = Math.max(maximum, sequence);
            if (sequence > afterSourceSequence) records.put(record);
        }
        return new JSONObject()
                .put("afterSourceSequence", Math.max(0L, afterSourceSequence))
                .put("records", records)
                .put("maxSourceSequence", maximum)
                .put("retentionHours", ACK_JOURNAL_RETENTION_MS / (60L * 60L * 1000L))
                .put("maxRecords", ackJournalMaxRecords)
                .put("maxBytes", ackJournalMaxBytes);
    }

    synchronized void close() {
        boundary("process_stop");
    }

    private void recover() throws Exception {
        recoverAuditIndex();
        long persistedNext = loadState();
        recoverQuarantineTransactions();
        recoverAckJournal();
        recoverAckReceipts();
        recoverAcknowledgedCleanupTransactions();
        long maximumSequence = 0L;
        File[] files = segmentsDirectory.listFiles();
        if (files == null) files = new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        for (File file : files) {
            long sequence = sequenceFromName(file.getName());
            maximumSequence = Math.max(maximumSequence, sequence);
            if (!file.getName().endsWith(".pcm.partial")) continue;
            File partialMetadata = partialMetadataFor(file);
            JSONObject ownership = readPartialOwnershipOrNull(partialMetadata);
            String source = ownership == null ? "unknown" : ownership.optString("source", "unknown");
            String route = ownership == null ? "" : ownership.optString("routeProfileId", "");
            if (file.length() <= 0L) {
                file.delete();
                partialMetadata.delete();
                appendAudit("partial_discarded", new JSONObject().put("sequence", sequence).put("reason", "empty"));
                continue;
            }
            if (ownership == null) {
                long bytes = file.length();
                poisonSequence(sequence, partialMetadata, "partial_missing_ownership",
                        "unknown", "", bytes, file);
                continue;
            }
            if ((file.length() & 1L) != 0L) {
                poisonSequence(sequence, partialMetadata, "partial_invalid_alignment",
                        source, route, file.length(), file);
                continue;
            }
            String base = file.getName().substring(0, file.getName().length() - ".partial".length());
            File sealed = new File(segmentsDirectory, base);
            moveReplacing(file, sealed);
            long startedAt = ownership.optLong("startedAt", timestampFromName(file.getName()));
            createMetadata(sequence, startedAt, clock.now(), sealed, source, route, "crash_recovery");
            partialMetadata.delete();
            appendAudit("partial_recovered", new JSONObject().put("sequence", sequence).put("bytes", sealed.length())
                    .put("source", source).put("routeProfileId", route));
        }
        for (File pcm : pcmFiles()) {
            long sequence = sequenceFromName(pcm.getName());
            maximumSequence = Math.max(maximumSequence, sequence);
            totalStoredBytes += pcm.length();
            File metadata = metadataForSequence(sequence);
            if (!metadata.exists()) {
                File ownershipFile = partialMetadataForSealed(pcm);
                JSONObject ownership = readPartialOwnershipOrNull(ownershipFile);
                if (ownership == null) {
                    long bytes = pcm.length();
                    totalStoredBytes = Math.max(0L, totalStoredBytes - bytes);
                    poisonSequence(sequence, ownershipFile, "sealed_missing_ownership",
                            "unknown", "", bytes, pcm);
                    continue;
                }
                String source = ownership.optString("source", "unknown");
                String route = ownership.optString("routeProfileId", "");
                createMetadata(sequence, ownership.optLong("startedAt", timestampFromName(pcm.getName())),
                        clock.now(), pcm, source, route, "metadata_recovery");
                ownershipFile.delete();
                appendAudit("metadata_recovered", new JSONObject().put("sequence", sequence).put("bytes", pcm.length())
                        .put("source", source).put("routeProfileId", route));
            }
        }
        pendingSequences.clear();
        acknowledgedSequences.clear();
        for (File metadata : metadataFiles()) {
            try {
                JSONObject value = readJson(metadata);
                long sequence = value.optLong("sequence", sequenceFromName(metadata.getName()));
                if ("acked".equals(value.optString("uploadState", "sealed"))) {
                    try {
                        ensureAckJournal(value);
                    } catch (Throwable receiptError) {
                        lastFailure = "ack_receipt_" + receiptError.getClass().getSimpleName();
                        appendAudit("ack_receipt_recovery_failed", new JSONObject()
                                .put("id", value.optString("id", ""))
                                .put("sequence", sequence)
                                .put("reason", lastFailure));
                    }
                    acknowledgedSequences.add(sequence);
                    if (inferAcknowledgedAccountingSequence) {
                        acknowledgedAccountingSequence = Math.max(acknowledgedAccountingSequence, sequence);
                    } else {
                        accountAcknowledged(sequence, value.optLong("bytes", 0L));
                    }
                } else pendingSequences.add(sequence);
            } catch (Throwable error) {
                poisonSequence(sequenceFromName(metadata.getName()), metadata,
                        "metadata_" + error.getClass().getSimpleName(), "unknown", "", metadata.length());
            }
        }
        inferAcknowledgedAccountingSequence = false;
        nextSequence = Math.max(persistedNext, maximumSequence + 1L);
        measureQuarantine();
        reconcileQuarantineAccounting();
        totalStoredBytes = quarantineBytes;
        for (File pcm : pcmFiles()) totalStoredBytes += pcm.length();
        reconcileCapturedAccounting();
        persistState();
        completeRecoveredCleanupTransactions();
        cleanupAcknowledged(false);
    }

    private long loadState() {
        if (!stateFile.exists()) return 1L;
        try {
            JSONObject state = readJson(stateFile);
            lastCapturedAt = state.optLong("lastCapturedAt", 0L);
            lastWrittenAt = state.optLong("lastWrittenAt", 0L);
            lastUploadedAt = state.optLong("lastUploadedAt", 0L);
            rejectedBytes = state.optLong("rejectedBytes", 0L);
            uncapturedGapBytes = state.optLong("uncapturedGapBytes", 0L);
            totalCapturedBytes = state.optLong("totalCapturedBytes", 0L);
            totalAcknowledgedBytes = state.optLong("totalAcknowledgedBytes", 0L);
            totalAcknowledgedSegments = state.optLong("totalAcknowledgedSegments", 0L);
            if (state.has("acknowledgedAccountingSequence")) {
                acknowledgedAccountingSequence = state.optLong("acknowledgedAccountingSequence", 0L);
            } else if (totalAcknowledgedSegments > 0L) {
                inferAcknowledgedAccountingSequence = true;
            }
            quarantinedAudioBytes = state.optLong("quarantinedAudioBytes", 0L);
            capturedGapBytes = state.optLong("capturedGapBytes", 0L);
            accountedQuarantineManifestAudioBytes = state.optLong("accountedQuarantineManifestAudioBytes", 0L);
            accountedQuarantineManifestGapBytes = state.optLong("accountedQuarantineManifestGapBytes", 0L);
            auditFailures = Math.max(auditFailures, state.optLong("auditFailures", 0L));
            lastFailure = state.optString("lastFailure", "");
            return Math.max(1L, state.optLong("nextSequence", 1L));
        } catch (Throwable error) {
            JSONObject details = new JSONObject();
            try { details.put("reason", error.getClass().getSimpleName()); } catch (Throwable ignored) { }
            appendAudit("state_recovered", details);
            return 1L;
        }
    }

    private void openActive(String source, String route, long startedAt) throws Exception {
        activeSequence = nextSequence++;
        persistState();
        activeStartedAt = startedAt;
        activeBytes = 0L;
        activeSource = source;
        activeRoute = route;
        activePartial = new File(segmentsDirectory, String.format(Locale.US, "%020d-%013d.pcm.partial", activeSequence, startedAt));
        activePartialMetadata = partialMetadataFor(activePartial);
        writeJson(activePartialMetadata, new JSONObject()
                .put("schemaVersion", 1)
                .put("sequence", activeSequence)
                .put("startedAt", startedAt)
                .put("source", source)
                .put("routeProfileId", route)
                .put("pcmFileName", activePartial.getName()));
        activeOutput = new FileOutputStream(activePartial, true);
        lastSyncAt = startedAt;
        appendAudit("partial_opened", new JSONObject().put("sequence", activeSequence).put("source", source)
                .put("routeProfileId", route));
    }

    private void syncActive(long now) throws Exception {
        if (activeOutput == null) return;
        activeOutput.flush();
        activeOutput.getFD().sync();
        lastSyncAt = now;
        persistState();
    }

    private void sealActive(String reason) throws Exception {
        if (activeOutput == null) return;
        File partial = activePartial;
        File partialMetadata = activePartialMetadata;
        long sequence = activeSequence;
        long startedAt = activeStartedAt;
        long bytes = activeBytes;
        String source = activeSource;
        String route = activeRoute;
        syncActive(clock.now());
        activeOutput.close();
        activeOutput = null;
        activePartial = null;
        activePartialMetadata = null;
        activeBytes = 0L;
        activeSequence = 0L;
        activeSource = "";
        activeRoute = "";
        if (bytes <= 0L) {
            partial.delete();
            if (partialMetadata != null) partialMetadata.delete();
            persistState();
            return;
        }
        File sealed = new File(segmentsDirectory, partial.getName().substring(0, partial.getName().length() - ".partial".length()));
        moveReplacing(partial, sealed);
        createMetadata(sequence, startedAt, clock.now(), sealed, source, route, reason);
        if (partialMetadata != null) partialMetadata.delete();
        appendAudit("sealed", new JSONObject().put("sequence", sequence).put("bytes", bytes).put("reason", reason));
        persistState();
    }

    private void createMetadata(long sequence, long startedAt, long endedAt, File pcm, String source,
                                String route, String reason) throws Exception {
        byte[] body = RabiReliableQueueFiles.read(pcm);
        JSONObject value = new JSONObject()
                .put("schemaVersion", 1)
                .put("id", idFor(sequence))
                .put("sequence", sequence)
                .put("startedAt", startedAt)
                .put("endedAt", endedAt)
                .put("bytes", body.length)
                .put("sha256", sha256(body))
                .put("pcmFileName", pcm.getName())
                .put("source", clean(source, "phone"))
                .put("routeProfileId", clean(route, ""))
                .put("sealReason", clean(reason, "boundary"))
                .put("uploadState", "sealed")
                .put("serverSequence", 0L)
                .put("attempts", 0);
        writeJson(metadataForSequence(sequence), value);
        pendingSequences.add(sequence);
    }

    private void cleanupAcknowledged(boolean pressure) {
        long now = clock.now();
        lastCleanupAt = now;
        for (long sequence : new ArrayList<>(acknowledgedSequences)) {
            File metadata = metadataForSequence(sequence);
            try {
                Segment segment = readSegment(metadata);
                if (segment == null || !"acked".equals(segment.uploadState)) {
                    acknowledgedSequences.remove(sequence);
                    continue;
                }
                boolean expired = now - segment.acknowledgedAt >= policy.acknowledgedRetentionMs;
                boolean storagePressure = pressure || totalStoredBytes > policy.maxStorageBytes;
                if (!expired && !storagePressure) continue;
                ensureAckJournal(readJson(metadata));
                File tombstone = cleanupTombstoneForSequence(sequence);
                if (!tombstone.exists()) {
                    writeJson(tombstone, new JSONObject()
                            .put("schemaVersion", 1)
                            .put("id", segment.id)
                            .put("sequence", segment.sequence)
                            .put("bytes", segment.bytes)
                            .put("sha256", segment.sha256)
                            .put("source", segment.source)
                            .put("serverSequence", segment.serverSequence)
                            .put("acknowledgedAt", segment.acknowledgedAt)
                            .put("pcmFileName", segment.pcmFile.getName())
                            .put("metadataFileName", metadata.getName())
                            .put("reason", storagePressure ? "storage_pressure" : "retention_expired")
                            .put("createdAt", now));
                }
                cleanupCutpoint("cleanup_before_pcm_delete");
                if (segment.pcmFile.exists() && !segment.pcmFile.delete()) continue;
                cleanupCutpoint("cleanup_between_pcm_and_metadata_delete");
                if (metadata.exists() && !metadata.delete()) continue;
                cleanupCutpoint("cleanup_after_metadata_delete_before_state");
                totalStoredBytes = Math.max(0L, totalStoredBytes - segment.bytes);
                acknowledgedSequences.remove(sequence);
                appendAudit(storagePressure ? "acked_pruned_for_storage" : "acked_retention_expired",
                        new JSONObject().put("id", segment.id).put("bytes", segment.bytes));
                persistState();
                if (tombstone.exists() && !tombstone.delete()) {
                    lastFailure = "cleanup_tombstone_retained";
                }
            } catch (CleanupInterruptedException error) {
                throw error;
            } catch (Throwable ignored) { }
        }
    }

    private void cleanupCutpoint(String stage) {
        try {
            cutpoint.reached(stage);
        } catch (Throwable error) {
            throw new CleanupInterruptedException(stage, error);
        }
    }

    private void recoverAcknowledgedCleanupTransactions() throws Exception {
        recoveredCleanupTombstones.clear();
        for (File tombstoneFile : cleanupTombstoneFiles()) {
            JSONObject tombstone = readJson(tombstoneFile);
            long sequence = tombstone.getLong("sequence");
            String id = tombstone.getString("id");
            if (sequence <= 0L || !idFor(sequence).equals(id)) {
                throw new IllegalStateException("invalid acknowledged cleanup tombstone identity");
            }
            ensureAckJournal(tombstone);
            File pcm = safeCleanupTarget(tombstone.getString("pcmFileName"));
            File metadata = safeCleanupTarget(tombstone.getString("metadataFileName"));
            if (pcm.exists() && !pcm.delete()) throw new IllegalStateException("cannot complete acknowledged PCM cleanup");
            if (metadata.exists() && !metadata.delete()) {
                throw new IllegalStateException("cannot complete acknowledged metadata cleanup");
            }
            recoveredCleanupTombstones.add(tombstoneFile);
        }
    }

    private void completeRecoveredCleanupTransactions() {
        for (File tombstone : new ArrayList<>(recoveredCleanupTombstones)) {
            if (!tombstone.exists() || tombstone.delete()) recoveredCleanupTombstones.remove(tombstone);
        }
    }

    private File safeCleanupTarget(String fileName) {
        String leaf = new File(clean(fileName, "")).getName();
        if (leaf.isEmpty() || !leaf.equals(fileName)) {
            throw new IllegalStateException("invalid acknowledged cleanup target");
        }
        return new File(segmentsDirectory, leaf);
    }

    private void recoverAckJournal() throws Exception {
        RabiReliableQueueFiles.cleanupTemporaryFiles(ackJournalDirectory);
        RabiReliableQueueFiles.cleanupTemporaryFiles(cleanupTombstoneDirectory);
        pruneAckJournal();
        measureAckJournal();
    }

    private void recoverAckReceipts() throws Exception {
        for (File receiptFile : journalFiles()) {
            JSONObject receipt = readAckJournalRecord(receiptFile);
            long sequence = receipt.getLong("sourceSequence");
            File metadataFile = metadataForSequence(sequence);
            if (!metadataFile.exists()) continue;
            JSONObject metadata = readJson(metadataFile);
            if (!ackTupleMatchesMetadata(receipt, metadata)) {
                throw new IllegalStateException("durable acknowledgement receipt conflicts with upload metadata");
            }
            JSONObject acknowledgement = journalAsMetadata(receipt, metadata);
            if (!"acked".equals(metadata.optString("uploadState", ""))
                    || metadata.optLong("acknowledgedAt", 0L) != acknowledgement.getLong("acknowledgedAt")) {
                metadata.put("uploadState", "acked")
                        .put("acknowledgedAt", acknowledgement.getLong("acknowledgedAt"))
                        .put("serverSequence", acknowledgement.getLong("serverSequence"));
                metadata.remove("lastError");
                writeJson(metadataFile, metadata);
                appendAudit("ack_receipt_recovered", new JSONObject()
                        .put("id", acknowledgement.getString("id"))
                        .put("sequence", sequence)
                        .put("serverSequence", acknowledgement.getLong("serverSequence")));
            }
            File pcm = pcmForSequence(sequence);
            if (!pcm.exists()) {
                File tombstone = cleanupTombstoneForSequence(sequence);
                if (!tombstone.exists()) {
                    writeJson(tombstone, new JSONObject()
                            .put("schemaVersion", 1)
                            .put("id", acknowledgement.getString("id"))
                            .put("sequence", sequence)
                            .put("bytes", acknowledgement.getLong("bytes"))
                            .put("sha256", acknowledgement.getString("sha256"))
                            .put("source", acknowledgement.optString("source", "phone"))
                            .put("serverSequence", acknowledgement.getLong("serverSequence"))
                            .put("acknowledgedAt", acknowledgement.getLong("acknowledgedAt"))
                            .put("pcmFileName", metadata.optString("pcmFileName", pcm.getName()))
                            .put("metadataFileName", metadataFile.getName())
                            .put("reason", "receipt_recovery")
                            .put("createdAt", clock.now()));
                }
            }
        }
    }

    private void ensureAckJournal(JSONObject source) throws Exception {
        long sequence = source.optLong("sequence", source.optLong("sourceSequence", 0L));
        String chunkId = source.optString("id", source.optString("chunkId", ""));
        long bytes = source.optLong("bytes", source.optLong("acceptedBytes", -1L));
        String checksum = source.optString("sha256", "").toLowerCase(Locale.US);
        long serverSequence = source.optLong("serverSequence", 0L);
        long acknowledgedAt = source.optLong("acknowledgedAt", 0L);
        String sourceKind = clean(source.optString("source", "phone"), "phone");
        if (sequence <= 0L || !idFor(sequence).equals(chunkId) || bytes <= 0L
                || checksum.length() != 64 || serverSequence <= 0L || acknowledgedAt <= 0L) {
            throw new IllegalStateException("invalid acknowledged tuple for durable journal");
        }
        JSONObject record = new JSONObject()
                .put("schemaVersion", 1)
                .put("source", sourceKind)
                .put("chunkId", chunkId)
                .put("acceptedBytes", bytes)
                .put("sha256", checksum)
                .put("sourceSequence", sequence)
                .put("serverSequence", serverSequence)
                .put("ackedAt", acknowledgedAt);
        File target = ackJournalForSequence(sequence);
        if (target.exists()) {
            JSONObject existing = readAckJournalRecord(target);
            if (!sameAckTuple(existing, record)) {
                throw new IllegalStateException("durable acknowledgement journal tuple conflict");
            }
            return;
        }
        if (acknowledgedAt < clock.now() - ACK_JOURNAL_RETENTION_MS) return;
        pruneAckJournal();
        byte[] body = record.toString().getBytes(StandardCharsets.UTF_8);
        if (ackJournalRecords >= ackJournalMaxRecords || ackJournalBytes + body.length > ackJournalMaxBytes) {
            throw new IllegalStateException("durable acknowledgement journal retention capacity exhausted");
        }
        RabiReliableQueueFiles.writeAtomically(target, body);
        ackJournalRecords += 1L;
        ackJournalBytes += target.length();
        ackJournalMaxSourceSequence = Math.max(ackJournalMaxSourceSequence, sequence);
    }

    private JSONObject readAckJournalRecord(File file) throws Exception {
        JSONObject record = readJson(file);
        long sequence = record.getLong("sourceSequence");
        String chunkId = record.getString("chunkId");
        if (sequence <= 0L || !idFor(sequence).equals(chunkId)
                || record.getLong("acceptedBytes") <= 0L
                || record.getLong("serverSequence") <= 0L
                || record.getLong("ackedAt") <= 0L
                || record.getString("sha256").length() != 64) {
            throw new IllegalStateException("invalid durable acknowledgement journal record");
        }
        return record;
    }

    private boolean sameAckTuple(JSONObject first, JSONObject second) {
        return first.optLong("sourceSequence", -1L) == second.optLong("sourceSequence", -2L)
                && first.optLong("serverSequence", -1L) == second.optLong("serverSequence", -2L)
                && first.optLong("acceptedBytes", -1L) == second.optLong("acceptedBytes", -2L)
                && first.optString("chunkId", "").equals(second.optString("chunkId", ""))
                && first.optString("sha256", "").equalsIgnoreCase(second.optString("sha256", ""));
    }

    private boolean ackTupleMatchesMetadata(JSONObject receipt, JSONObject metadata) {
        long metadataServerSequence = metadata.optLong("serverSequence", 0L);
        return receipt.optLong("sourceSequence", -1L) == metadata.optLong("sequence", -2L)
                && (metadataServerSequence == 0L
                    || receipt.optLong("serverSequence", -1L) == metadataServerSequence)
                && receipt.optLong("acceptedBytes", -1L) == metadata.optLong("bytes", -2L)
                && receipt.optString("chunkId", "").equals(metadata.optString("id", ""))
                && receipt.optString("sha256", "").equalsIgnoreCase(metadata.optString("sha256", ""));
    }

    private JSONObject journalAsMetadata(JSONObject receipt, JSONObject metadata) throws Exception {
        return new JSONObject(metadata.toString())
                .put("id", receipt.getString("chunkId"))
                .put("sequence", receipt.getLong("sourceSequence"))
                .put("bytes", receipt.getLong("acceptedBytes"))
                .put("sha256", receipt.getString("sha256"))
                .put("source", receipt.getString("source"))
                .put("serverSequence", receipt.getLong("serverSequence"))
                .put("acknowledgedAt", receipt.getLong("ackedAt"));
    }

    private void pruneAckJournal() throws Exception {
        long cutoff = clock.now() - ACK_JOURNAL_RETENTION_MS;
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            if (record.getLong("ackedAt") >= cutoff) continue;
            if (!file.delete()) throw new IllegalStateException("cannot expire durable acknowledgement journal record");
        }
        measureAckJournal();
    }

    private void measureAckJournal() throws Exception {
        long bytes = 0L;
        long records = 0L;
        long maximum = 0L;
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            bytes += file.length();
            records += 1L;
            maximum = Math.max(maximum, record.getLong("sourceSequence"));
        }
        ackJournalBytes = bytes;
        ackJournalRecords = records;
        ackJournalMaxSourceSequence = maximum;
    }

    private File ackJournalForSequence(long sequence) {
        return new File(ackJournalDirectory, String.format(Locale.US, "ack-%020d.json", sequence));
    }

    private File cleanupTombstoneForSequence(long sequence) {
        return new File(cleanupTombstoneDirectory, String.format(Locale.US, "cleanup-%020d.json", sequence));
    }

    private File[] journalFiles() { return RabiReliableQueueFiles.list(ackJournalDirectory, ".json"); }
    private File[] cleanupTombstoneFiles() { return RabiReliableQueueFiles.list(cleanupTombstoneDirectory, ".json"); }

    private Segment readSegment(File metadata) throws Exception {
        JSONObject value = readJson(metadata);
        long sequence = value.optLong("sequence", sequenceFromName(metadata.getName()));
        String pcmFileName = value.optString("pcmFileName", "");
        File pcm = pcmFileName.isEmpty()
                ? pcmForSequence(sequence)
                : new File(segmentsDirectory, new File(pcmFileName).getName());
        if (!pcm.exists()) {
            if (!poisonSequence(sequence, metadata, "missing_pcm",
                    value.optString("source", "unknown"), value.optString("routeProfileId", ""),
                    Math.max(0L, value.optLong("bytes", 0L)))) {
                throw new IllegalStateException("audio quarantine transaction is pending");
            }
            return null;
        }
        return new Segment(value, pcm, metadata);
    }

    private JSONObject readJson(File file) throws Exception {
        return new JSONObject(new String(RabiReliableQueueFiles.read(file), StandardCharsets.UTF_8));
    }

    private void writeJson(File file, JSONObject value) throws Exception {
        RabiReliableQueueFiles.writeAtomically(file, value.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void persistState() throws Exception {
        long pendingAudioBytes = pendingAudioBytes();
        long accountedCapturedBytes = totalAcknowledgedBytes + pendingAudioBytes + activeBytes
                + quarantinedAudioBytes + capturedGapBytes;
        writeJson(stateFile, new JSONObject()
                .put("schemaVersion", 1)
                .put("nextSequence", nextSequence)
                .put("lastCapturedAt", lastCapturedAt)
                .put("lastWrittenAt", lastWrittenAt)
                .put("lastUploadedAt", lastUploadedAt)
                .put("pendingSegments", pendingSequences.size())
                .put("pendingBytes", pendingAudioBytes)
                .put("activePartialBytes", activeBytes)
                .put("acknowledgedSegments", acknowledgedSequences.size())
                .put("storedBytes", totalStoredBytes)
                .put("quarantineBytes", quarantineBytes)
                .put("quarantineItems", quarantineItems)
                .put("rejectedBytes", rejectedBytes)
                .put("uncapturedGapBytes", uncapturedGapBytes)
                .put("totalCapturedBytes", totalCapturedBytes)
                .put("totalAcknowledgedBytes", totalAcknowledgedBytes)
                .put("totalAcknowledgedSegments", totalAcknowledgedSegments)
                .put("acknowledgedAccountingSequence", acknowledgedAccountingSequence)
                .put("ackJournalRecords", ackJournalRecords)
                .put("ackJournalBytes", ackJournalBytes)
                .put("ackJournalMaxSourceSequence", ackJournalMaxSourceSequence)
                .put("quarantinedAudioBytes", quarantinedAudioBytes)
                .put("capturedGapBytes", capturedGapBytes)
                .put("accountedCapturedBytes", accountedCapturedBytes)
                .put("accountingBalanced", totalCapturedBytes == accountedCapturedBytes)
                .put("accountedQuarantineManifestAudioBytes", accountedQuarantineManifestAudioBytes)
                .put("accountedQuarantineManifestGapBytes", accountedQuarantineManifestGapBytes)
                .put("auditFailures", auditFailures)
                .put("lastFailure", lastFailure));
    }

    private void accountAcknowledged(long sequence, long bytes) {
        if (sequence <= acknowledgedAccountingSequence) return;
        totalAcknowledgedBytes += Math.max(0L, bytes);
        totalAcknowledgedSegments += 1L;
        acknowledgedAccountingSequence = sequence;
    }

    private void appendAudit(String event, JSONObject details) {
        String eventId = String.format(Locale.US, "audit-%020d", nextAuditEventSequence);
        appendAuditWithId(eventId, event, details);
    }

    private void appendAuditWithId(String eventId, String event, JSONObject details) {
        if (auditEventIds.contains(eventId)) return;
        try {
            if (auditFile.exists() && auditFile.length() >= AUDIT_MAX_BYTES) rotateAudit();
            long eventSequence = nextAuditEventSequence;
            JSONObject row = new JSONObject()
                    .put("id", eventId)
                    .put("eventSequence", eventSequence)
                    .put("time", clock.now())
                    .put("event", event)
                    .put("details", details);
            try (FileOutputStream stream = new FileOutputStream(auditFile, true);
                 OutputStreamWriter writer = new OutputStreamWriter(stream, StandardCharsets.UTF_8)) {
                writer.write(row.toString());
                writer.write("\n");
                writer.flush();
                stream.getFD().sync();
            }
            auditEventIds.add(eventId);
            nextAuditEventSequence = eventSequence + 1L;
        } catch (Throwable error) {
            auditFailures += 1L;
            lastFailure = "audit_write_" + error.getClass().getSimpleName();
        }
    }

    private void rotateAudit() throws Exception {
        if (!auditFile.exists() || auditFile.length() <= 0L) return;
        long segmentSequence = nextAuditSegmentSequence;
        File rotated = new File(root, String.format(Locale.US, "audit-segment-%020d.jsonl", segmentSequence));
        if (rotated.exists()) throw new IllegalStateException("audit segment already exists");
        fileMover.move(auditFile, rotated);
        nextAuditSegmentSequence = segmentSequence + 1L;
        recoverAuditIndex();
    }

    private void recoverAuditIndex() throws Exception {
        auditEventIds.clear();
        long maximumEventSequence = 0L;
        long maximumSegmentSequence = 0L;
        File[] files = root.listFiles((directory, name) -> name.startsWith("audit-")
                && !AUDIT_FILE.equals(name) && name.endsWith(".jsonl"));
        if (files == null) files = new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        JSONArray rows = new JSONArray();
        for (File file : files) {
            JSONObject summary = summarizeAuditFile(file);
            rows.put(summary);
            maximumEventSequence = Math.max(maximumEventSequence, summary.optLong("lastEventSequence", 0L));
            maximumSegmentSequence = Math.max(maximumSegmentSequence, auditSegmentSequence(file.getName()));
        }
        if (auditFile.exists()) {
            JSONObject active = summarizeAuditFile(auditFile);
            maximumEventSequence = Math.max(maximumEventSequence, active.optLong("lastEventSequence", 0L));
        }
        nextAuditEventSequence = maximumEventSequence + 1L;
        nextAuditSegmentSequence = maximumSegmentSequence + 1L;
        writeJson(new File(root, AUDIT_INDEX_FILE), new JSONObject()
                .put("schemaVersion", 2)
                .put("rebuiltAt", clock.now())
                .put("segments", rows));
    }

    private JSONObject summarizeAuditFile(File file) throws Exception {
        byte[] raw = Files.readAllBytes(file.toPath());
        String text = new String(raw, StandardCharsets.UTF_8);
        String[] lines = text.split("\n", -1);
        long firstSequence = 0L;
        long lastSequence = 0L;
        String firstId = "";
        String lastId = "";
        long records = 0L;
        long legacyRecords = 0L;
        StringBuilder recovered = new StringBuilder();
        for (int lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            String line = lines[lineIndex];
            if (line.trim().isEmpty()) continue;
            JSONObject row;
            try {
                row = new JSONObject(line);
            } catch (Throwable error) {
                boolean trailingCrashWrite = AUDIT_FILE.equals(file.getName())
                        && lineIndex == lines.length - 1 && !text.endsWith("\n");
                if (!trailingCrashWrite) {
                    if (error instanceof Exception) throw (Exception) error;
                    throw new IllegalStateException("audit segment is unreadable", error);
                }
                String tailHash = sha256(line.getBytes(StandardCharsets.UTF_8));
                File evidence = new File(root, "audit-recovery-tail-" + tailHash.substring(0, 16) + ".txt");
                RabiReliableQueueFiles.writeAtomically(evidence, line.getBytes(StandardCharsets.UTF_8));
                RabiReliableQueueFiles.writeAtomically(file, recovered.toString().getBytes(StandardCharsets.UTF_8));
                auditFailures += 1L;
                lastFailure = "audit_trailing_write_recovered";
                break;
            }
            // Legacy audit rows had only time/event/details. Keep source bytes intact
            // and give the rebuilt index a stable identity without inventing sequence numbers.
            boolean legacy = !row.has("id") && !row.has("eventSequence") && row.length() == 3
                    && row.opt("time") instanceof Number && row.opt("event") instanceof String
                    && row.opt("details") instanceof JSONObject;
            String eventId = legacy
                    ? "legacy-" + sha256((lineIndex + "\n" + line).getBytes(StandardCharsets.UTF_8))
                    : row.getString("id");
            if (legacy) legacyRecords += 1L;
            long eventSequence = row.optLong("eventSequence", 0L);
            auditEventIds.add(eventId);
            if (records == 0L) {
                firstSequence = eventSequence;
                firstId = eventId;
            }
            lastSequence = eventSequence;
            lastId = eventId;
            records += 1L;
            recovered.append(line).append('\n');
        }
        return new JSONObject()
                .put("segmentId", file.getName().replace(".jsonl", ""))
                .put("file", file.getName())
                .put("firstEventId", firstId)
                .put("lastEventId", lastId)
                .put("firstEventSequence", firstSequence)
                .put("lastEventSequence", lastSequence)
                .put("records", records)
                .put("legacyRecords", legacyRecords)
                .put("bytes", file.length())
                .put("sha256", sha256(Files.readAllBytes(file.toPath())));
    }

    private static long auditSegmentSequence(String name) {
        String value = name == null ? "" : name;
        if (!value.startsWith("audit-segment-")) return 0L;
        int start = "audit-segment-".length();
        int end = value.indexOf('.', start);
        try { return Long.parseLong(value.substring(start, end < 0 ? value.length() : end)); }
        catch (Throwable ignored) { return 0L; }
    }

    private boolean hasStorageFor(long bytes) {
        long usable = spaceProbe.usableBytes(root);
        return totalStoredBytes + bytes <= policy.maxStorageBytes
                && usable - bytes >= policy.reserveFreeBytes;
    }

    private boolean poisonSegment(Segment segment, String reason) {
        if (segment == null) return false;
        return poisonSequence(segment.sequence, segment.metadataFile, reason, segment.source,
                segment.routeProfileId, segment.bytes, segment.pcmFile);
    }

    private boolean poisonSequence(long sequence, File metadata, String reason, String source,
                                   String route, long estimatedBytes, File... related) {
        ArrayList<File> files = new ArrayList<>();
        if (metadata != null) files.add(metadata);
        File pcm = pcmForSequence(sequence);
        if (pcm.exists()) files.add(pcm);
        if (related != null) for (File file : related) if (file != null && !files.contains(file)) files.add(file);
        long pcmBytes = pcm.exists() ? pcm.length() : 0L;
        try {
            String transactionId = "audio-" + String.format(Locale.US, "%020d", sequence);
            File transaction = new File(root, QUARANTINE_TXN_PREFIX + transactionId);
            if (!transaction.exists()) ensureDirectory(transaction);
            File manifest = new File(transaction, "manifest.json");
            if (!manifest.exists()) {
                JSONArray evidence = new JSONArray();
                int index = 0;
                for (File file : files) {
                    if (file == null) continue;
                    String relative = root.toPath().relativize(file.toPath()).toString().replace('\\', '/');
                    evidence.put(new JSONObject().put("source", relative)
                            .put("staged", String.format(Locale.US, "%03d-%s", index++, file.getName())));
                }
                writeJson(manifest, new JSONObject()
                        .put("schemaVersion", 1)
                        .put("transactionId", transactionId)
                        .put("sequence", sequence)
                        .put("reason", reason)
                        .put("source", clean(source, "unknown"))
                        .put("routeProfileId", clean(route, ""))
                        .put("estimatedBytes", Math.max(estimatedBytes, pcmBytes))
                        .put("gapId", "gap-poison-" + transactionId)
                        .put("gapRecorded", false)
                        .put("evidence", evidence));
            }
            File isolated = resumeQuarantineTransaction(transaction);
            finishQuarantineRecord(isolated);
            pendingSequences.remove(sequence);
            persistState();
            return true;
        } catch (Throwable error) {
            lastFailure = "quarantine_transaction_" + error.getClass().getSimpleName();
            try { persistState(); } catch (Throwable ignored) { }
            return false;
        }
    }

    private void recoverQuarantineTransactions() throws Exception {
        File[] transactions = root.listFiles(file -> file.isDirectory()
                && file.getName().startsWith(QUARANTINE_TXN_PREFIX));
        if (transactions != null) {
            Arrays.sort(transactions, Comparator.comparing(File::getName));
            for (File transaction : transactions) finishQuarantineRecord(resumeQuarantineTransaction(transaction));
        }
        File quarantineRoot = new File(root, "quarantine");
        File[] isolated = quarantineRoot.listFiles(File::isDirectory);
        if (isolated != null) {
            Arrays.sort(isolated, Comparator.comparing(File::getName));
            for (File item : isolated) {
                if (new File(item, "manifest.json").exists()) finishQuarantineRecord(item);
            }
        }
    }

    private File resumeQuarantineTransaction(File transaction) throws Exception {
        File manifestFile = new File(transaction, "manifest.json");
        JSONObject manifest = readJson(manifestFile);
        JSONArray evidence = manifest.getJSONArray("evidence");
        for (int index = 0; index < evidence.length(); index++) {
            JSONObject row = evidence.getJSONObject(index);
            File source = new File(root, row.getString("source"));
            File staged = new File(transaction, row.getString("staged"));
            String rootPath = root.getCanonicalPath() + File.separator;
            if (!source.getCanonicalPath().startsWith(rootPath)) {
                throw new IllegalStateException("quarantine evidence escaped spool root");
            }
            if (source.exists() && !staged.exists()) fileMover.move(source, staged);
            if (source.exists() && staged.exists()) {
                throw new IllegalStateException("quarantine evidence exists in source and staging");
            }
        }
        File quarantineRoot = new File(root, "quarantine");
        ensureDirectory(quarantineRoot);
        File destination = new File(quarantineRoot, transaction.getName().substring(1));
        if (destination.exists()) throw new IllegalStateException("quarantine transaction destination already exists");
        fileMover.move(transaction, destination);
        return destination;
    }

    private void finishQuarantineRecord(File isolated) throws Exception {
        File manifestFile = new File(isolated, "manifest.json");
        JSONObject manifest = readJson(manifestFile);
        if (!manifest.optBoolean("accountingRecorded", false)) {
            long audioBytes = measureQuarantinedAudio(isolated);
            long estimatedBytes = Math.max(0L, manifest.optLong("estimatedBytes", 0L));
            manifest.put("quarantinedAudioBytes", Math.min(estimatedBytes, audioBytes))
                    .put("capturedGapBytes", Math.max(0L, estimatedBytes - audioBytes))
                    .put("accountingRecorded", true);
            writeJson(manifestFile, manifest);
        }
        if (!manifest.optBoolean("gapRecorded", false)) {
            recordGapWithId(manifest.getString("gapId"), manifest.getString("reason"),
                    manifest.optLong("estimatedBytes", 0L), manifest.optString("source", "unknown"),
                    manifest.optString("routeProfileId", ""), false);
            manifest.put("gapRecorded", true).put("completedAt", clock.now());
            writeJson(manifestFile, manifest);
        }
        measureQuarantine();
        reconcileQuarantineAccounting();
        recomputeStoredBytes();
    }

    private long pendingAudioBytes() {
        long bytes = 0L;
        for (long sequence : pendingSequences) {
            try { bytes += Math.max(0L, readJson(metadataForSequence(sequence)).optLong("bytes", 0L)); }
            catch (Throwable ignored) { }
        }
        return bytes;
    }

    private void reconcileCapturedAccounting() {
        long minimumCaptured = totalAcknowledgedBytes + pendingAudioBytes() + activeBytes
                + quarantinedAudioBytes + capturedGapBytes;
        totalCapturedBytes = Math.max(totalCapturedBytes, minimumCaptured);
    }

    private void reconcileQuarantineAccounting() {
        long audio = 0L;
        long gaps = 0L;
        File quarantineRoot = new File(root, "quarantine");
        File[] items = quarantineRoot.listFiles(File::isDirectory);
        if (items != null) for (File item : items) {
            File manifestFile = new File(item, "manifest.json");
            if (!manifestFile.exists()) continue;
            try {
                JSONObject manifest = readJson(manifestFile);
                audio += Math.max(0L, manifest.optLong("quarantinedAudioBytes", 0L));
                gaps += Math.max(0L, manifest.optLong("capturedGapBytes", 0L));
            } catch (Throwable ignored) { }
        }
        if (audio > accountedQuarantineManifestAudioBytes) {
            quarantinedAudioBytes += audio - accountedQuarantineManifestAudioBytes;
        }
        if (gaps > accountedQuarantineManifestGapBytes) {
            capturedGapBytes += gaps - accountedQuarantineManifestGapBytes;
        }
        accountedQuarantineManifestAudioBytes = audio;
        accountedQuarantineManifestGapBytes = gaps;
    }

    private static long measureQuarantinedAudio(File directory) {
        if (directory == null || !directory.exists()) return 0L;
        long bytes = 0L;
        File[] children = directory.listFiles();
        if (children == null) return 0L;
        for (File child : children) {
            if (child.isDirectory()) bytes += measureQuarantinedAudio(child);
            else if (child.getName().endsWith(".pcm") || child.getName().endsWith(".pcm.partial")) {
                bytes += child.length();
            }
        }
        return bytes;
    }

    private void recomputeStoredBytes() {
        totalStoredBytes = quarantineBytes;
        for (File pcm : pcmFiles()) totalStoredBytes += pcm.length();
        if (activePartial != null && activePartial.exists()) totalStoredBytes += activePartial.length();
    }

    private void measureQuarantine() {
        File quarantineRoot = new File(root, "quarantine");
        long[] totals = measureFiles(quarantineRoot);
        quarantineBytes = totals[0];
        File[] items = quarantineRoot.listFiles(File::isDirectory);
        quarantineItems = items == null ? 0L : items.length;
    }

    private static long[] measureFiles(File directory) {
        if (directory == null || !directory.exists()) return new long[]{0L, 0L};
        long bytes = 0L;
        long files = 0L;
        File[] children = directory.listFiles();
        if (children == null) return new long[]{0L, 0L};
        for (File child : children) {
            if (child.isDirectory()) {
                long[] nested = measureFiles(child);
                bytes += nested[0];
                files += nested[1];
            } else {
                bytes += child.length();
                files += 1L;
            }
        }
        return new long[]{bytes, files};
    }

    synchronized JSONObject quarantineManifest() {
        measureQuarantine();
        JSONObject value = new JSONObject();
        try { value.put("items", quarantineItems).put("bytes", quarantineBytes); }
        catch (Throwable ignored) { }
        return value;
    }

    synchronized boolean clearQuarantineAfterUserConfirmation() {
        File quarantineRoot = new File(root, "quarantine");
        try {
            String expected = new File(root, "quarantine").getCanonicalPath();
            if (!quarantineRoot.getCanonicalPath().equals(expected)) return false;
            File[] children = quarantineRoot.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
            long removed = quarantineBytes;
            quarantineBytes = 0L;
            quarantineItems = 0L;
            accountedQuarantineManifestAudioBytes = 0L;
            accountedQuarantineManifestGapBytes = 0L;
            totalStoredBytes = Math.max(0L, totalStoredBytes - removed);
            appendAudit("quarantine_cleared_by_user", new JSONObject().put("removedBytes", removed));
            persistState();
            return true;
        } catch (Throwable error) {
            lastFailure = "quarantine_clear_" + error.getClass().getSimpleName();
            return false;
        }
    }

    private static void deleteTree(File target) throws Exception {
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("cannot clear quarantine item");
    }

    private void quarantine(File file, String reason) {
        try {
            long bytes = file != null && file.exists() ? file.length() : 0L;
            RabiReliableQueueFiles.quarantine(root, reason, file);
            quarantineBytes += bytes;
            quarantineItems += 1L;
            totalStoredBytes += bytes;
        }
        catch (Throwable ignored) { }
    }

    private File[] metadataFiles() { return RabiReliableQueueFiles.list(segmentsDirectory, ".json"); }
    private File[] pcmFiles() { return RabiReliableQueueFiles.list(segmentsDirectory, ".pcm"); }
    private JSONObject readPartialOwnershipOrNull(File file) {
        if (file == null || !file.exists()) return null;
        try {
            JSONObject value = readJson(file);
            String source = value.optString("source", "").trim();
            if (source.isEmpty() || value.optLong("sequence", 0L) <= 0L) return null;
            return value;
        } catch (Throwable ignored) {
            return null;
        }
    }
    private File partialMetadataFor(File partial) { return new File(partial.getPath() + ".meta"); }
    private File partialMetadataForSealed(File pcm) { return new File(pcm.getPath() + ".partial.meta"); }
    private File metadataForId(String id) {
        long sequence = 0L;
        try { sequence = Long.parseLong(clean(id, "").replace("audio-", "")); } catch (NumberFormatException ignored) { }
        return metadataForSequence(sequence);
    }
    private File metadataForSequence(long sequence) { return new File(segmentsDirectory, idFor(sequence) + ".json"); }
    private File pcmForSequence(long sequence) {
        File[] matches = segmentsDirectory.listFiles((directory, name) -> name.startsWith(String.format(Locale.US, "%020d-", sequence)) && name.endsWith(".pcm"));
        return matches == null || matches.length == 0 ? new File(segmentsDirectory, idFor(sequence) + ".missing.pcm") : matches[0];
    }

    private static String idFor(long sequence) { return String.format(Locale.US, "audio-%020d", sequence); }
    private static long sequenceFromName(String name) {
        String value = name == null ? "" : name;
        if (value.startsWith("audio-")) value = value.substring(6);
        int dash = value.indexOf('-');
        int dot = value.indexOf('.');
        int end = dash >= 0 ? dash : dot >= 0 ? dot : value.length();
        try { return Long.parseLong(value.substring(0, end)); } catch (Throwable ignored) { return 0L; }
    }
    private static long timestampFromName(String name) {
        String value = name == null ? "" : name;
        int dash = value.indexOf('-');
        if (dash < 0) return System.currentTimeMillis();
        int dot = value.indexOf('.', dash + 1);
        try { return Long.parseLong(value.substring(dash + 1, dot < 0 ? value.length() : dot)); }
        catch (Throwable ignored) { return System.currentTimeMillis(); }
    }
    private static String clean(String value, String fallback) {
        String result = value == null ? "" : value.trim();
        return result.isEmpty() ? fallback : result;
    }
    private static void ensureDirectory(File directory) {
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("cannot create durable audio directory");
    }
    private static void moveReplacing(File source, File destination) throws Exception {
        try {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }
    private static String sha256(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        char[] hex = "0123456789abcdef".toCharArray();
        char[] value = new char[digest.length * 2];
        for (int index = 0; index < digest.length; index++) {
            int item = digest[index] & 0xff;
            value[index * 2] = hex[item >>> 4];
            value[index * 2 + 1] = hex[item & 15];
        }
        return new String(value);
    }
}
