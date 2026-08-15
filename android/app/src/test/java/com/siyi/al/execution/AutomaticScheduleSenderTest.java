package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import androidx.work.ExistingWorkPolicy;

import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.HttpTransport;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class AutomaticScheduleSenderTest {
    @Test
    public void replayWakeUsesKeepSoTheSameJobCannotCancelAnActiveExecution() {
        assertEquals(ExistingWorkPolicy.KEEP, AlExecutionWakeWorker.automaticReplayWorkPolicy());
    }

    @Test
    public void remoteReconcileFailuresRetryButConflictsDoNot() {
        assertTrue(ExecutionRuntime.ReconcileResult.retryable().shouldRetry());
        assertFalse(ExecutionRuntime.ReconcileResult.conflict().shouldRetry());
        assertFalse(ExecutionRuntime.ReconcileResult.noop().shouldRetry());
    }
    @Test
    public void senderPostsThePersistedBodyUnchangedAndCompletesTheExactLease() {
        FakeOutbox outbox = new FakeOutbox(row());
        RecordingTransport transport = new RecordingTransport(200);
        AutomaticScheduleSender sender = new AutomaticScheduleSender(
            outbox, transport, "https://timer.example/v2/schedule-transitions", () -> 1000L);

        AutomaticScheduleSender.Outcome outcome = sender.flushOne(1000L);

        assertEquals(AutomaticScheduleSender.Outcome.SYNCED, outcome);
        assertEquals(row().payloadJson, transport.bodies.get(0));
        assertEquals(1, outbox.synced);
        assertEquals(0, outbox.retried);
    }

    @Test
    public void retryableAndAuthorityResponsesTakeDifferentExactPaths() {
        FakeOutbox retry = new FakeOutbox(row());
        AutomaticScheduleSender retrySender = new AutomaticScheduleSender(
            retry, new RecordingTransport(503), "https://timer.example/v2/schedule-transitions", () -> 1000L);
        assertEquals(AutomaticScheduleSender.Outcome.RETRY, retrySender.flushOne(1000L));
        assertEquals(1, retry.retried);
        assertEquals(0, retry.quarantined);

        FakeOutbox conflict = new FakeOutbox(row());
        RecordingTransport authority = new RecordingTransport(
            409, "{\"error\":\"SCHEDULE_AUTHORITY_CONFLICT\"}");
        AutomaticScheduleSender conflictSender = new AutomaticScheduleSender(
            conflict, authority, "https://timer.example/v2/schedule-transitions", () -> 1000L);
        assertEquals(AutomaticScheduleSender.Outcome.QUARANTINED,
            conflictSender.flushOne(1000L));
        assertEquals(1, conflict.quarantined);
        assertEquals(0, conflict.retried);

        FakeOutbox throttled = new FakeOutbox(row());
        AutomaticScheduleSender throttledSender = new AutomaticScheduleSender(
            throttled, new RecordingTransport(429),
            "https://timer.example/v2/schedule-transitions", () -> 1000L);
        assertEquals(AutomaticScheduleSender.Outcome.RETRY, throttledSender.flushOne(1000L));
        assertEquals(1, throttled.retried);
        assertEquals(0, throttled.quarantined);
    }

    @Test
    public void scheduleStatusParserAcceptsOnlyTheClosedPausedShell() {
        AutomaticScheduleAuthorityEntity authority = authority();
        RecordingTransport transport = new RecordingTransport(200,
            "{\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\"paused\","
                + "\"generation\":7,\"jobId\":null,\"dueAt\":null,"
                + "\"nextDeliveryAttemptAt\":null,\"scheduleChecksum\":\""
                + repeat('a', 64) + "\",\"authorityEpochFingerprint\":\"00112233\","
                + "\"deliveryAttempts\":0,\"updatedAt\":1000}");
        AutomaticScheduleSender sender = new AutomaticScheduleSender(
            new FakeOutbox(null), transport, "https://timer.example/v2/schedule-transitions", () -> 1000L);

        AutomaticScheduleSender.RemoteScheduleStatus status = sender.fetchStatus(authority);

        assertEquals("paused", status.state);
        assertEquals(7L, status.generation);
        assertEquals("00112233", status.authorityEpochFingerprint);
        assertEquals("https://timer.example/v2/schedule-status", transport.urls.get(0));
    }

    @Test
    public void scheduleStatusParserRejectsExtraOrMalformedFields() {
        AutomaticScheduleAuthorityEntity authority = authority();
        RecordingTransport extra = new RecordingTransport(200,
            "{\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\"paused\","
                + "\"generation\":7,\"jobId\":null,\"dueAt\":null,\"nextDeliveryAttemptAt\":null,"
                + "\"scheduleChecksum\":\"" + repeat('a', 64) + "\",\"authorityEpochFingerprint\":\"00112233\","
                + "\"deliveryAttempts\":0,\"updatedAt\":1000,\"unexpected\":true}");
        AutomaticScheduleSender sender = new AutomaticScheduleSender(
            new FakeOutbox(null), extra, "https://timer.example/v2/schedule-transitions", () -> 1000L);
        assertThrows(IllegalArgumentException.class, () -> sender.fetchStatus(authority));
    }

    @Test
    public void scheduleStatusParserRejectsJsonCoercions() {
        AutomaticScheduleAuthorityEntity authority = authority();
        String base = "\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\"paused\","
            + "\"generation\":7,\"jobId\":null,\"dueAt\":null,\"nextDeliveryAttemptAt\":null,"
            + "\"scheduleChecksum\":\"" + repeat('a', 64) + "\",\"authorityEpochFingerprint\":\"00112233\","
            + "\"deliveryAttempts\":0,\"updatedAt\":1000";
        for (String mutation : new String[] {
            "\"ok\":\"true\"", "\"generation\":\"7\"", "\"generation\":7.0",
            "\"deliveryAttempts\":\"0\"", "\"updatedAt\":1000.5", "\"jobId\":[]"
        }) {
            String candidate = "{" + base.replaceFirst("\\\"ok\\\":true", mutation) + "}";
            RecordingTransport transport = new RecordingTransport(200, candidate);
            AutomaticScheduleSender sender = new AutomaticScheduleSender(
                new FakeOutbox(null), transport,
                "https://timer.example/v2/schedule-transitions", () -> 1000L);
            assertThrows(IllegalArgumentException.class, () -> sender.fetchStatus(authority));
        }
    }

    @Test
    public void scheduleStatusParserRejectsZeroGeneration() {
        AutomaticScheduleAuthorityEntity authority = authority();
        String response = "{\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\"paused\","
            + "\"generation\":0,\"jobId\":null,\"dueAt\":null,\"nextDeliveryAttemptAt\":null,"
            + "\"scheduleChecksum\":\"" + repeat('a', 64)
            + "\",\"authorityEpochFingerprint\":\"00112233\",\"deliveryAttempts\":0,\"updatedAt\":1000}";
        AutomaticScheduleSender sender = new AutomaticScheduleSender(new FakeOutbox(null),
            new RecordingTransport(200, response),
            "https://timer.example/v2/schedule-transitions", () -> 1000L);
        assertThrows(IllegalArgumentException.class, () -> sender.fetchStatus(authority));
    }

    @Test
    public void scheduleStatusParserAcceptsAwaitingAckAndDisabledButRejectsLegacyStates() {
        AutomaticScheduleAuthorityEntity authority = authority();
        for (String state : new String[] { "awaiting_ack", "disabled" }) {
            String response = "{\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\""
                + state + "\",\"generation\":7,\"jobId\":null,\"dueAt\":null,"
                + "\"nextDeliveryAttemptAt\":null,\"scheduleChecksum\":\"" + repeat('a', 64)
                + "\",\"authorityEpochFingerprint\":\"00112233\",\"deliveryAttempts\":0,\"updatedAt\":1000}";
            AutomaticScheduleSender sender = new AutomaticScheduleSender(new FakeOutbox(null),
                new RecordingTransport(200, response),
                "https://timer.example/v2/schedule-transitions", () -> 1000L);
            assertEquals(state, sender.fetchStatus(authority).state);
        }
        for (String state : new String[] { "claimed", "unclaimed" }) {
            String response = "{\"ok\":true,\"exists\":true,\"owner\":\"android-v1\",\"state\":\""
                + state + "\",\"generation\":7,\"jobId\":null,\"dueAt\":null,"
                + "\"nextDeliveryAttemptAt\":null,\"scheduleChecksum\":\"" + repeat('a', 64)
                + "\",\"authorityEpochFingerprint\":\"00112233\",\"deliveryAttempts\":0,\"updatedAt\":1000}";
            AutomaticScheduleSender sender = new AutomaticScheduleSender(new FakeOutbox(null),
                new RecordingTransport(200, response),
                "https://timer.example/v2/schedule-transitions", () -> 1000L);
            assertThrows(IllegalArgumentException.class, () -> sender.fetchStatus(authority));
        }
    }

    private static AutomaticScheduleAuthorityEntity authority() {
        AutomaticScheduleAuthorityEntity authority = new AutomaticScheduleAuthorityEntity();
        authority.streamKey = "active:device:yuqi:chat";
        authority.characterId = "yuqi";
        authority.kind = "chat";
        authority.owner = "android-v1";
        authority.authorityEpoch = "00112233445566778899aabbccddeeff";
        authority.generation = 7L;
        authority.activeJobId = "pro_1234567890abcdef_7";
        authority.dueAt = 1780000000000L;
        authority.semanticChecksum = repeat('a', 64);
        authority.semanticJson = "{\"deviceId\":\"device\",\"characterId\":\"yuqi\",\"kind\":\"chat\"}";
        authority.cloudSyncState = "synced";
        return authority;
    }

    private static AutomaticScheduleOutboxEntity row() {
        AutomaticScheduleOutboxEntity row = new AutomaticScheduleOutboxEntity();
        row.outboxId = "active:device:yuqi:chat:1";
        row.streamKey = "active:device:yuqi:chat";
        row.generation = 1L;
        row.payloadJson = "{\"fixed\":true}";
        row.payloadChecksum = repeat('a', 64);
        row.state = "waiting";
        row.createdAt = 1L;
        row.updatedAt = 1L;
        return row;
    }

    private static final class FakeOutbox implements AutomaticScheduleSender.OutboxAccess {
        private AutomaticScheduleOutboxEntity row;
        private int synced;
        private int retried;
        private int quarantined;

        FakeOutbox(AutomaticScheduleOutboxEntity row) { this.row = row; }

        @Override public AutomaticScheduleOutboxEntity next(long now, long expiredBefore) {
            return row;
        }
        @Override public AutomaticScheduleOutboxEntity claim(
            AutomaticScheduleOutboxEntity candidate, String leaseId, long now, long expiredBefore
        ) {
            candidate.state = "pending";
            candidate.leaseId = leaseId;
            candidate.leaseAttempt += 1L;
            candidate.leasedAt = now;
            return candidate;
        }
        @Override public boolean sync(AutomaticScheduleOutboxEntity claimed, long now) {
            synced += 1;
            row = null;
            return true;
        }
        @Override public boolean retry(
            AutomaticScheduleOutboxEntity claimed, String errorCode, long nextAttemptAt, long now
        ) {
            retried += 1;
            row = null;
            return true;
        }
        @Override public boolean quarantine(
            AutomaticScheduleOutboxEntity claimed, String errorCode, long now
        ) {
            quarantined += 1;
            row = null;
            return true;
        }
        @Override public long nextDelayMs(long now, long leaseMs) { return 0L; }
        @Override public int recoverExpiredLeases(long now, long expiredBefore) { return 0; }
    }

    private static final class RecordingTransport implements HttpTransport {
        private final int status;
        private final String response;
        private final List<String> bodies = new ArrayList<>();
        private final List<String> urls = new ArrayList<>();

        RecordingTransport(int status) { this(status, "{\"ok\":true}"); }
        RecordingTransport(int status, String response) {
            this.status = status;
            this.response = response;
        }
        @Override public HttpResponse post(String url, Map<String, String> headers, String body) {
            urls.add(url);
            bodies.add(body);
            return new HttpResponse(status, "application/json", response);
        }
    }

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }
}
