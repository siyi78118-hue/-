package com.siyi.al.execution;

import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.HttpTransport;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import java.io.IOException;
import java.util.Collections;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONObject;

/** Crash-safe sender for immutable Room schedule transitions. It never invokes the planner. */
public final class AutomaticScheduleSender {
    public enum Outcome { NONE, LOST_RACE, SYNCED, RETRY, QUARANTINED }

    static final long LEASE_MS = 60_000L;
    private static final long BASE_RETRY_MS = 15_000L;
    private static final long MAX_RETRY_MS = 15L * 60_000L;
    private final OutboxAccess outbox;
    private final HttpTransport transport;
    private final String endpoint;
    private final ExecutionClock clock;

    public AutomaticScheduleSender(AlExecutionDatabase database, HttpTransport transport,
                                   String endpoint, ExecutionClock clock) {
        this(new RoomOutboxAccess(database), transport, endpoint, clock);
    }

    AutomaticScheduleSender(OutboxAccess outbox, HttpTransport transport,
                            String endpoint, ExecutionClock clock) {
        if (outbox == null || transport == null || endpoint == null || endpoint.isEmpty() || clock == null) {
            throw new IllegalArgumentException("automatic schedule sender dependencies are required");
        }
        this.outbox = outbox;
        this.transport = transport;
        this.endpoint = endpoint;
        this.clock = clock;
    }

    interface OutboxAccess {
        AutomaticScheduleOutboxEntity next(long now, long expiredBefore);
        AutomaticScheduleOutboxEntity claim(
            AutomaticScheduleOutboxEntity candidate, String leaseId, long now, long expiredBefore);
        boolean sync(AutomaticScheduleOutboxEntity claimed, long now);
        boolean retry(AutomaticScheduleOutboxEntity claimed, String errorCode,
                      long nextAttemptAt, long now);
        boolean quarantine(AutomaticScheduleOutboxEntity claimed, String errorCode, long now);
        long nextDelayMs(long now, long leaseMs);
        int recoverExpiredLeases(long now, long expiredBefore);
    }

    public Outcome flushOne(long now) {
        long expiredBefore = now - LEASE_MS;
        AutomaticScheduleOutboxEntity candidate = outbox.next(now, expiredBefore);
        if (candidate == null) return Outcome.NONE;
        String leaseId = leaseIdentity(candidate, now);
        AutomaticScheduleOutboxEntity claimed = outbox.claim(candidate, leaseId, now, expiredBefore);
        if (claimed == null) return Outcome.LOST_RACE;

        HttpResponse response;
        try {
            response = transport.post(endpoint,
                Collections.singletonMap("Content-Type", "application/json"), claimed.payloadJson);
        } catch (IOException error) {
            return retry(claimed, "NETWORK_IO", now);
        } catch (RuntimeException error) {
            return retry(claimed, "TRANSPORT_RUNTIME", now);
        }

        if (response.status >= 200 && response.status < 300 && responseOk(response)) {
            return outbox.sync(claimed, now) ? Outcome.SYNCED : Outcome.LOST_RACE;
        }
        String errorCode = responseErrorCode(response);
        if (response.status == 409 && isAuthorityConflict(errorCode)) {
            return outbox.quarantine(claimed, errorCode, now)
                ? Outcome.QUARANTINED : Outcome.LOST_RACE;
        }
        return retry(claimed, errorCode.isEmpty() ? "HTTP_" + response.status : errorCode, now);
    }

    public int recoverExpiredLeases(long now) {
        return outbox.recoverExpiredLeases(now, now - LEASE_MS);
    }

    public long nextDelayMs(long now) {
        return outbox.nextDelayMs(now, LEASE_MS);
    }

    private Outcome retry(AutomaticScheduleOutboxEntity claimed, String errorCode, long now) {
        long multiplier = 1L << Math.min(5L, Math.max(0L, claimed.leaseAttempt - 1L));
        long delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * multiplier);
        return outbox.retry(claimed, sanitizeError(errorCode), now + delay, now)
            ? Outcome.RETRY : Outcome.LOST_RACE;
    }

    private String leaseIdentity(AutomaticScheduleOutboxEntity candidate, long now) {
        return "schedule-lease-" + candidate.generation + "-" + clock.now() + "-" + now
            + "-" + UUID.randomUUID().toString().replace("-", "");
    }

    private static boolean responseOk(HttpResponse response) {
        if (!response.contentType.toLowerCase(Locale.ROOT).contains("application/json")) return false;
        try {
            JSONObject body = new JSONObject(response.body);
            Object ok = body.get("ok");
            return ok instanceof Boolean && (Boolean) ok;
        } catch (Exception error) {
            return false;
        }
    }

    private static String responseErrorCode(HttpResponse response) {
        try {
            JSONObject body = new JSONObject(response.body);
            Object code = body.has("code") ? body.get("code") : body.opt("error");
            return code instanceof String ? sanitizeError((String) code) : "";
        } catch (Exception error) {
            return "HTTP_" + response.status;
        }
    }

    private static boolean isAuthorityConflict(String code) {
        return "SCHEDULE_AUTHORITY_CONFLICT".equals(code)
            || "SCHEDULE_CHECKSUM_CONFLICT".equals(code)
            || "SCHEDULE_CONTRACT_INVALID".equals(code);
    }

    private static String sanitizeError(String value) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.ROOT)
            .replaceAll("[^A-Z0-9_:-]", "_");
        if (normalized.isEmpty()) return "UNKNOWN";
        return normalized.length() <= 96 ? normalized : normalized.substring(0, 96);
    }

    private static final class RoomOutboxAccess implements OutboxAccess {
        private final AlExecutionDatabase database;
        private final AlExecutionDao dao;

        RoomOutboxAccess(AlExecutionDatabase database) {
            if (database == null) throw new IllegalArgumentException("automatic schedule database is required");
            this.database = database;
            this.dao = database.executionDao();
        }

        @Override public AutomaticScheduleOutboxEntity next(long now, long expiredBefore) {
            return dao.nextAutomaticScheduleOutboxForSend(now, expiredBefore);
        }

        @Override public AutomaticScheduleOutboxEntity claim(
            AutomaticScheduleOutboxEntity candidate, String leaseId, long now, long expiredBefore
        ) {
            final AutomaticScheduleOutboxEntity[] result = new AutomaticScheduleOutboxEntity[1];
            database.runInTransaction(() -> {
                int changed = dao.claimAutomaticScheduleOutboxExact(
                    candidate.outboxId, candidate.payloadChecksum, expiredBefore, leaseId, now, now);
                if (changed != 1) return;
                AutomaticScheduleOutboxEntity claimed = dao.automaticScheduleOutbox(candidate.outboxId);
                if (claimed == null || !"pending".equals(claimed.state)
                    || !leaseId.equals(claimed.leaseId) || claimed.leasedAt == null
                    || claimed.leasedAt != now) {
                    throw new IllegalStateException("automatic schedule lease authority conflict");
                }
                String expectedCloudState = "pending".equals(candidate.state) ? "pending" : "waiting";
                advanceCurrentAuthorityIfSameGeneration(
                    claimed, expectedCloudState, "pending", now, "lease");
                result[0] = claimed;
            });
            return result[0];
        }

        @Override public boolean sync(AutomaticScheduleOutboxEntity claimed, long now) {
            return complete(claimed, "synced", now);
        }

        @Override public boolean retry(AutomaticScheduleOutboxEntity claimed, String errorCode,
                                       long nextAttemptAt, long now) {
            final boolean[] result = { false };
            database.runInTransaction(() -> {
                if (dao.retryAutomaticScheduleOutboxExact(
                        claimed.outboxId, claimed.payloadChecksum, claimed.leaseId,
                        claimed.leaseAttempt, claimed.leasedAt, errorCode, nextAttemptAt, now) != 1) return;
                advanceCurrentAuthorityIfSameGeneration(
                    claimed, "pending", "waiting", now, "retry");
                result[0] = true;
            });
            return result[0];
        }

        @Override public boolean quarantine(AutomaticScheduleOutboxEntity claimed,
                                            String errorCode, long now) {
            final boolean[] result = { false };
            database.runInTransaction(() -> {
                if (dao.quarantineAutomaticScheduleOutboxExact(
                        claimed.outboxId, claimed.payloadChecksum, claimed.leaseId,
                        claimed.leaseAttempt, claimed.leasedAt, errorCode, now) != 1) return;
                advanceCurrentAuthorityIfSameGeneration(
                    claimed, "pending", "quarantined", now, "quarantine");
                result[0] = true;
            });
            return result[0];
        }

        @Override public long nextDelayMs(long now, long leaseMs) {
            Long next = dao.nextAutomaticScheduleOutboxAt(leaseMs);
            if (next == null) return Long.MAX_VALUE;
            return Math.max(0L, next - now);
        }

        @Override public int recoverExpiredLeases(long now, long expiredBefore) {
            final int[] recovered = { 0 };
            database.runInTransaction(() -> {
                for (AutomaticScheduleOutboxEntity expired
                        : dao.expiredAutomaticScheduleOutboxes(expiredBefore)) {
                    if (expired.leaseId == null || expired.leasedAt == null) {
                        throw new IllegalStateException("automatic schedule expired lease shape conflict");
                    }
                    if (dao.retryAutomaticScheduleOutboxExact(
                            expired.outboxId, expired.payloadChecksum, expired.leaseId,
                            expired.leaseAttempt, expired.leasedAt,
                            "LEASE_EXPIRED", now, now) != 1) {
                        continue;
                    }
                    advanceCurrentAuthorityIfSameGeneration(
                        expired, "pending", "waiting", now, "expired lease");
                    recovered[0] += 1;
                }
            });
            return recovered[0];
        }

        private boolean complete(AutomaticScheduleOutboxEntity claimed, String state, long now) {
            final boolean[] result = { false };
            database.runInTransaction(() -> {
                if (dao.syncAutomaticScheduleOutboxExact(
                        claimed.outboxId, claimed.payloadChecksum, claimed.leaseId,
                        claimed.leaseAttempt, claimed.leasedAt, now) != 1) return;
                advanceCurrentAuthorityIfSameGeneration(
                    claimed, "pending", state, now, "completion");
                result[0] = true;
            });
            return result[0];
        }

        /**
         * The authority table intentionally retains only the newest generation. Older outbox
         * generations still have to reach D1 in order, but must not overwrite that newer local
         * projection. The exact current generation advances with its outbox in the same Room
         * transaction; an older generation advances only its own immutable outbox row.
         */
        private void advanceCurrentAuthorityIfSameGeneration(
            AutomaticScheduleOutboxEntity outboxRow, String expectedState,
            String nextState, long now, String operation
        ) {
            AutomaticScheduleAuthorityEntity current =
                dao.automaticScheduleAuthority(outboxRow.streamKey);
            if (current == null || current.generation < outboxRow.generation) {
                throw new IllegalStateException(
                    "automatic schedule " + operation + " authority generation conflict");
            }
            if (current.generation > outboxRow.generation) return;
            if (!outboxRow.payloadChecksum.equals(current.semanticChecksum)
                || dao.updateAutomaticScheduleCloudSyncExact(
                    outboxRow.streamKey, outboxRow.generation, outboxRow.payloadChecksum,
                    expectedState, nextState, now) != 1) {
                throw new IllegalStateException(
                    "automatic schedule " + operation + " authority conflict");
            }
        }
    }
}
