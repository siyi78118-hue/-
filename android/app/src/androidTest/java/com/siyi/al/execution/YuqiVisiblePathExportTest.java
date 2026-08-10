package com.siyi.al.execution;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

import android.os.Bundle;
import android.content.Context;
import androidx.room.Room;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Focused producer contract for the metadata-only Android visible-path export.
 * The production database is read through Room; this test never inserts canned
 * rows or accepts caller-authored JSONL as evidence.
 */
@RunWith(AndroidJUnit4.class)
public class YuqiVisiblePathExportTest {
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Set<String> KINDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "DIRECT_REPLY", "ROLE_PLAN_CHAT", "ROLE_PLAN_MOMENT", "ROLE_PLAN_CHAT_PRIVATE",
        "ROLE_PLAN_MOMENT_PRIVATE", "PROACTIVE_CHAT", "PROACTIVE_MOMENT",
        "MOMENT_INTERACTION", "MOMENT_REPLY")));
    private static final Set<String> DISPOSITIONS = Collections.singleton("visible");

    private AlExecutionDatabase database;
    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @After
    public void tearDown() {
        if (database != null) database.close();
        database = null;
    }

    @Test
    public void daoExposesBoundedVisibleRowsReadOnly() {
        database = openExistingRoomDatabase();
        long count = database.executionDao()
            .visiblePathRowCountInWindow("candidate-release", 1L, Long.MAX_VALUE);
        List<ChatTurnEntity> rows = database.executionDao()
            .visiblePathRowsInWindow("candidate-release", 1L, Long.MAX_VALUE);
        assertNotNull(rows);
        org.junit.Assert.assertEquals(count, rows.size());
    }

    @Test
    public void daoCandidateWindowExcludesForeignReleaseRows() {
        AlExecutionDatabase fixture = Room.inMemoryDatabaseBuilder(
            context, AlExecutionDatabase.class).allowMainThreadQueries().build();
        try {
            fixture.executionDao().insertTurn(visibleTurn("visible-candidate", "candidate-release"));
            fixture.executionDao().insertTurn(visibleTurn("visible-foreign", "stable-release"));
            List<ChatTurnEntity> rows = fixture.executionDao().visiblePathRowsInWindow(
                "candidate-release", 100L, 300L);
            org.junit.Assert.assertEquals(1, rows.size());
            org.junit.Assert.assertEquals("visible-candidate", rows.get(0).turnId);
            org.junit.Assert.assertEquals(1L, fixture.executionDao().visiblePathRowCountInWindow(
                "candidate-release", 100L, 300L));
        } finally {
            fixture.close();
        }
    }

    @Test
    public void exporterRejectsMissingRunIdentityBeforeOpeningOutput() {
        assertThrows(IllegalArgumentException.class, () -> ExportRequest.from(
            context, new Bundle()));
    }

    /**
     * This is intentionally a focused instrumentation entry point.  The
     * formal runner supplies all arguments; with no arguments the test fails
     * closed instead of manufacturing a report or treating an empty database
     * as evidence.
     */
    @Test
    public void exportCurrentDeviceVisiblePathArtifact() throws Exception {
        database = openExistingRoomDatabase();
        final ExportRequest request = ExportRequest.from(
            context, InstrumentationRegistry.getArguments());
        final AtomicReference<List<ChatTurnEntity>> rows = new AtomicReference<>();
        database.runInTransaction(() -> {
            long count = database.executionDao().visiblePathRowCountInWindow(
                request.candidateReleaseId, request.selectionFrom, request.selectionTo);
            List<ChatTurnEntity> selected = database.executionDao().visiblePathRowsInWindow(
                request.candidateReleaseId, request.selectionFrom, request.selectionTo);
            if (count != selected.size()) throw new IllegalStateException("VISIBLE_PATH_SELECTION_CHANGED");
            rows.set(selected);
        });
        AndroidVisiblePathExporter.export(database, rows.get(), request);
    }

    private AlExecutionDatabase openExistingRoomDatabase() {
        File source = context.getDatabasePath("al-execution.db");
        if (!source.isFile()) throw new IllegalStateException("VISIBLE_PATH_ROOM_DATABASE_UNAVAILABLE");
        // No migrations or destructive fallback are registered: an old/invalid
        // source fails closed instead of being changed to look like v15.
        return Room.databaseBuilder(context, AlExecutionDatabase.class, "al-execution.db").build();
    }

    private static ChatTurnEntity visibleTurn(String turnId, String pipelineReleaseId) {
        ChatTurnEntity turn = new ChatTurnEntity();
        turn.turnId = turnId;
        turn.characterId = "yuqi";
        turn.sourceMessageId = turnId + "-source";
        turn.kind = "DIRECT_REPLY";
        turn.state = "COMPLETED";
        turn.createdAt = 100L;
        turn.updatedAt = 200L;
        turn.completedAt = 200L;
        turn.uiAppliedAt = 200L;
        turn.pipelineReleaseId = pipelineReleaseId;
        return turn;
    }

    private static final class ExportRequest {
        final File output;
        final String candidateReleaseId;
        final String deviceSerial;
        final String runId;
        final long selectionFrom;
        final long selectionTo;

        private ExportRequest(
            File output, String candidateReleaseId,
            String deviceSerial, String runId, long selectionFrom, long selectionTo
        ) {
            this.output = output;
            this.candidateReleaseId = candidateReleaseId;
            this.deviceSerial = deviceSerial;
            this.runId = runId;
            this.selectionFrom = selectionFrom;
            this.selectionTo = selectionTo;
        }

        static ExportRequest from(Context context, Bundle args) {
            if (args == null) throw new IllegalArgumentException("visible path arguments are required");
            String outputPath = nonEmpty(args.getString("visiblePathOutputPath"), "visiblePathOutputPath");
            File output = new File(outputPath);
            if (!output.isAbsolute()) throw new IllegalArgumentException("visible path output must be absolute");
            try {
                output = output.getCanonicalFile();
            } catch (IOException error) {
                throw new IllegalArgumentException("visible path output cannot be canonicalized", error);
            }
            File parent = output.getParentFile();
            if (parent == null || !parent.isDirectory()) {
                throw new IllegalArgumentException("visible path output parent is unavailable");
            }
            if (output.exists()) throw new IllegalArgumentException("visible path output already exists");
            if (!"visible-path-android.jsonl".equals(output.getName())) {
                throw new IllegalArgumentException("visible path output filename is not fixed");
            }
            try {
                File filesRoot = context.getFilesDir().getCanonicalFile();
                File cacheRoot = context.getCacheDir().getCanonicalFile();
                if (!within(output, filesRoot) && !within(output, cacheRoot)) {
                    throw new IllegalArgumentException("visible path output escapes app evidence storage");
                }
            } catch (IOException error) {
                throw new IllegalArgumentException("visible path evidence root cannot be canonicalized", error);
            }
            String candidateId = nonEmpty(args.getString("candidateReleaseId"), "candidateReleaseId");
            if (!candidateId.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new IllegalArgumentException("candidate release id is invalid");
            }
            String deviceSerial = nonEmpty(args.getString("deviceSerial"), "deviceSerial");
            if (!deviceSerial.matches("[A-Za-z0-9._:-]{1,128}")) {
                throw new IllegalArgumentException("device serial is invalid");
            }
            String runId = nonEmpty(args.getString("runId"), "runId");
            if (!runId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) {
                throw new IllegalArgumentException("run id is invalid");
            }
            long from = safeLong(args, "selectionFrom");
            long to = safeLong(args, "selectionTo");
            if (from <= 0L || to < from || to > System.currentTimeMillis()) {
                throw new IllegalArgumentException("selection bounds are invalid");
            }
            return new ExportRequest(output, candidateId, deviceSerial, runId, from, to);
        }

        private static boolean within(File path, File root) throws IOException {
            String candidate = path.getCanonicalPath();
            String base = root.getCanonicalPath();
            return candidate.equals(base) || candidate.startsWith(base + File.separator);
        }

        private static long safeLong(Bundle args, String key) {
            if (!args.containsKey(key)) throw new IllegalArgumentException(key + " is required");
            long value = args.getLong(key, Long.MIN_VALUE);
            if (value <= 0L || value > MAX_SAFE_INTEGER) {
                throw new IllegalArgumentException(key + " is not a safe positive integer");
            }
            return value;
        }

        private static String nonEmpty(String value, String key) {
            if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(key + " is required");
            return value;
        }
    }

    private static final class AndroidVisiblePathExporter {
        private AndroidVisiblePathExporter() {}

        static void export(
            AlExecutionDatabase database, List<ChatTurnEntity> turns, ExportRequest request
        ) throws Exception {
            if (turns == null || turns.isEmpty()) {
                throw new IllegalStateException("VISIBLE_PATH_ROWS_UNAVAILABLE");
            }
            List<JSONObject> samples = new ArrayList<>();
            Set<String> turnIds = new HashSet<>();
            Set<String> tupleKeys = new HashSet<>();
            Map<String, Integer> kindCounts = new HashMap<>();
            for (ChatTurnEntity turn : turns) {
                validateTurn(turn, request, database, turnIds, tupleKeys);
                JSONObject sample = sampleFor(turn);
                samples.add(sample);
                kindCounts.put(turn.kind, kindCounts.containsKey(turn.kind)
                    ? kindCounts.get(turn.kind) + 1 : 1);
            }
            if (kindCounts.containsKey("DIRECT_REPLY") == false
                || kindCounts.get("DIRECT_REPLY") < 20) {
                throw new IllegalStateException("VISIBLE_PATH_DIRECT_SAMPLES_INCOMPLETE");
            }
            for (String kind : KINDS) {
                if (!kindCounts.containsKey(kind) || kindCounts.get(kind) < 1) {
                    throw new IllegalStateException("VISIBLE_PATH_KIND_SAMPLES_INCOMPLETE:" + kind);
                }
            }
            long startedAt = request.selectionFrom;
            long completedAt = request.selectionTo;
            if (completedAt < startedAt) throw new IllegalStateException("visible path clock moved backwards");
            JSONArray rawRows = new JSONArray();
            for (JSONObject sample : samples) rawRows.put(sample);
            JSONObject selectionBasis = new JSONObject()
                .put("producer", "room_authority_export_v1")
                .put("rows", rawRows);
            String selectionChecksum = BridgeAuthority.sha256CanonicalJson(selectionBasis);
            SupportSQLiteDatabase readable = database.getOpenHelper().getReadableDatabase();
            int roomUserVersion = readable.getVersion();
            if (roomUserVersion != AlExecutionDatabase.SCHEMA_VERSION) {
                throw new IllegalStateException("VISIBLE_PATH_ROOM_SCHEMA_UNSUPPORTED");
            }
            JSONObject attestationBasis = new JSONObject()
                .put("candidateReleaseId", request.candidateReleaseId)
                .put("completedAt", completedAt)
                .put("databaseUserVersion", roomUserVersion)
                .put("deviceSerial", request.deviceSerial)
                .put("producer", "room_authority_export_v1")
                .put("rowCount", samples.size())
                .put("runId", request.runId)
                .put("selectionChecksum", selectionChecksum)
                .put("startedAt", startedAt);
            JSONObject attestation = new JSONObject(attestationBasis.toString())
                .put("attestationChecksum", BridgeAuthority.sha256CanonicalJson(attestationBasis));
            JSONObject metadata = new JSONObject()
                .put("recordType", "metadata")
                .put("schemaVersion", "yuqi-v3-visible-path-android-v1")
                .put("candidateReleaseId", request.candidateReleaseId)
                .put("deviceSerial", request.deviceSerial)
                .put("runId", request.runId)
                .put("startedAt", startedAt)
                .put("completedAt", completedAt)
                .put("producerAttestation", attestation);
            writeJsonl(request.output, metadata, samples);
        }

        private static JSONObject sampleFor(ChatTurnEntity turn) throws Exception {
            long uiAppliedAt = turn.uiAppliedAt;
            long elapsed = uiAppliedAt - turn.createdAt;
            JSONObject basis = new JSONObject()
                .put("turnIdSha256", sha256(turn.turnId))
                .put("kind", turn.kind)
                .put("pipelineReleaseId", turn.pipelineReleaseId)
                .put("authorityLineageKeySha256", sha256(turn.authorityLineageKey))
                .put("visibleGroupIdSha256", sha256(turn.visibleGroupId))
                .put("createdAt", turn.createdAt)
                .put("uiAppliedAt", uiAppliedAt)
                .put("elapsedMs", elapsed)
                .put("terminalDisposition", turn.terminalDisposition);
            return basis;
        }

        private static void validateTurn(
            ChatTurnEntity turn, ExportRequest request, AlExecutionDatabase database,
            Set<String> turnIds, Set<String> tupleKeys
        ) throws Exception {
            if (turn == null || !turnIds.add(turn.turnId)) throw new IllegalStateException("VISIBLE_PATH_DUPLICATE_TURN");
            if (!KINDS.contains(turn.kind)) throw new IllegalStateException("VISIBLE_PATH_UNKNOWN_KIND");
            if (!request.candidateReleaseId.equals(turn.pipelineReleaseId)) {
                throw new IllegalStateException("VISIBLE_PATH_FOREIGN_RELEASE");
            }
            if (turn.bridgeProtocolVersion == null || turn.bridgeProtocolVersion != 3
                || turn.deletedAt != null || turn.uiAppliedAt == null
                || turn.createdAt <= 0L || turn.createdAt > MAX_SAFE_INTEGER
                || turn.uiAppliedAt <= 0L || turn.uiAppliedAt > MAX_SAFE_INTEGER
                || turn.uiAppliedAt < turn.createdAt
                || turn.createdAt < request.selectionFrom
                || turn.uiAppliedAt > request.selectionTo) {
                throw new IllegalStateException("VISIBLE_PATH_TURN_LIFECYCLE_INVALID");
            }
            if (!DISPOSITIONS.contains(turn.terminalDisposition)
                || !nonEmpty(turn.authorityLineageKey)
                || !nonEmpty(turn.visibleGroupId)
                || !nonEmpty(turn.pipelineReleaseId)
                || !nonEmpty(turn.commitPayloadVersion)
                || !nonEmpty(turn.generationFingerprint)
                || !nonEmpty(turn.laneKey)
                || !hex64(turn.bridgeCommitChecksum)
                || !safeNonNegative(turn.lineageRevision)
                || !safeNonNegative(turn.turnRevision)
                || !safeNonNegative(turn.laneRevision)
                || !safeNonNegative(turn.inputVisibilitySequence)
                || !safeNonNegative(turn.inputClearEpoch)) {
                throw new IllegalStateException("VISIBLE_PATH_TURN_AUTHORITY_INVALID");
            }
            String tuple = turn.turnId + "|" + turn.authorityLineageKey + "|" + turn.visibleGroupId;
            if (!tupleKeys.add(tuple)) throw new IllegalStateException("VISIBLE_PATH_DUPLICATE_TUPLE");
            if (turn.activeAttemptId == null) throw new IllegalStateException("VISIBLE_PATH_ATTEMPT_MISSING");
            ExecutionAttemptEntity attempt = database.executionDao().attempt(turn.activeAttemptId);
            if (attempt == null || !turn.turnId.equals(attempt.turnId)
                || !"COMPLETED".equals(attempt.state) || attempt.finishedAt == null
                || !hex64(attempt.bridgeAuthorityCheckpointChecksum)
                || attempt.bridgeAuthorityCheckpointJson == null) {
                throw new IllegalStateException("VISIBLE_PATH_RECEIPT_INVALID");
            }
            JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
            JSONObject receipt;
            long version = checkpoint.optLong("version", -1L);
            if (version == 1L) {
                receipt = BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
                    attempt.bridgeAuthorityCheckpointJson, attempt.bridgeAuthorityCheckpointChecksum);
            } else if (version == 2L) {
                receipt = BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
                    attempt.bridgeAuthorityCheckpointJson, attempt.bridgeAuthorityCheckpointChecksum);
            } else {
                receipt = null;
            }
            if (receipt == null) throw new IllegalStateException("VISIBLE_PATH_RECEIPT_INVALID");
            JSONObject semantic = receipt.optJSONObject("semantic");
            JSONObject authority = semantic == null ? receipt : semantic;
            boolean localReceipt = semantic != null && receipt.has("receiptVersion");
            JSONObject release = authority.optJSONObject("release");
            String releaseId = authority.optString("releaseId",
                release == null ? "" : release.optString("releaseId", ""));
            String receiptCommitChecksum = authority.optString("commitChecksum",
                receipt.optString("commitChecksum", ""));
            String receiptTurnId = authority.optString("turnId",
                authority.optString("authoritativeTurnId", ""));
            if (!turn.turnId.equals(receiptTurnId)
                || !exactLong(authority, "protocolVersion", 3L)
                || !request.candidateReleaseId.equals(releaseId)
                || (turn.authorityOrigin != null && !turn.authorityOrigin.equals(
                    authority.optString("authorityOrigin", "")))
                || !turn.authorityLineageKey.equals(authority.optString("authorityLineageKey", ""))
                || !turn.visibleGroupId.equals(authority.optString("visibleGroupId", ""))
                || (!localReceipt && !turn.commitPayloadVersion.equals(
                    authority.optString("commitPayloadVersion", "")))
                || (!localReceipt && !turn.generationFingerprint.equals(
                    authority.optString("generationFingerprint", "")))
                || !turn.laneKey.equals(authority.optString("laneKey", ""))
                || !(exactLong(authority, "lineageRevision", turn.lineageRevision)
                    || exactLong(authority, "lineageRevisionAtCreation", turn.lineageRevision))
                || !exactLong(authority, "turnRevision", turn.turnRevision)
                || !exactLong(authority, "laneRevision", turn.laneRevision)
                || !exactLong(authority, "inputVisibilitySequence", turn.inputVisibilitySequence)
                || !exactLong(authority, "inputClearEpoch", turn.inputClearEpoch)
                || !turn.bridgeCommitChecksum.equals(receiptCommitChecksum)
                || !turn.terminalDisposition.equals(authority.optString("terminalDisposition", ""))) {
                throw new IllegalStateException("VISIBLE_PATH_RECEIPT_TUPLE_INVALID");
            }
        }

        private static boolean nonEmpty(String value) {
            return value != null && !value.trim().isEmpty();
        }

        private static boolean safeNonNegative(Long value) {
            return value != null && value >= 0L && value <= MAX_SAFE_INTEGER;
        }

        private static boolean exactLong(JSONObject value, String key, long expected) {
            Object raw = value.opt(key);
            return raw instanceof Number
                && !(raw instanceof Float)
                && !(raw instanceof Double)
                && ((Number) raw).longValue() == expected;
        }

        private static boolean hex64(String value) {
            return value != null && value.matches("[a-f0-9]{64}");
        }

        private static String sha256(String value) throws Exception {
            if (!nonEmpty(value)) throw new IllegalStateException("identity is empty");
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte part : digest) result.append(String.format("%02x", part & 0xff));
            return result.toString();
        }

        private static void writeJsonl(File output, JSONObject metadata, List<JSONObject> samples)
            throws Exception {
            if (output.exists()) throw new IllegalStateException("VISIBLE_PATH_OUTPUT_EXISTS");
            File temp = File.createTempFile("visible-path-android-", ".jsonl", output.getParentFile());
            boolean published = false;
            try {
                try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                    new FileOutputStream(temp), StandardCharsets.UTF_8))) {
                    writer.write(BridgeAuthority.canonicalJson(metadata));
                    writer.newLine();
                    for (JSONObject sample : samples) {
                        writer.write(BridgeAuthority.canonicalJson(sample));
                        writer.newLine();
                    }
                }
                if (output.exists() || !temp.renameTo(output)) {
                    throw new IllegalStateException("VISIBLE_PATH_OUTPUT_PUBLISH_FAILED");
                }
                published = true;
            } finally {
                if (!published && temp.exists()) temp.delete();
            }
        }
    }
}
