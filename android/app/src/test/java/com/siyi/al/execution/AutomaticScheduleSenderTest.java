package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.HttpTransport;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class AutomaticScheduleSenderTest {
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

        RecordingTransport(int status) { this(status, "{\"ok\":true}"); }
        RecordingTransport(int status, String response) {
            this.status = status;
            this.response = response;
        }
        @Override public HttpResponse post(String url, Map<String, String> headers, String body) {
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
