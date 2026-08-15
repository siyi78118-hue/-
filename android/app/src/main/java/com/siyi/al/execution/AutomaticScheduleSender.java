package com.siyi.al.execution;

import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.HttpTransport;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import java.io.IOException;
import java.util.HashSet;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;
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
    private final String statusEndpoint;
    private final ExecutionClock clock;

    public static final class RemoteScheduleStatus {
        public final String deviceId;
        public final String characterId;
        public final String kind;
        public final boolean exists;
        public final String owner;
        public final String state;
        public final long generation;
        public final String jobId;
        public final Long dueAt;
        public final Long nextDeliveryAttemptAt;
        public final String scheduleChecksum;
        public final String authorityEpochFingerprint;
        public final long deliveryAttempts;
        public final long updatedAt;

        public RemoteScheduleStatus(String deviceId, String characterId, String kind,
                                    boolean exists, String owner, String state, long generation,
                                    String jobId, Long dueAt, Long nextDeliveryAttemptAt,
                                    String scheduleChecksum, String authorityEpochFingerprint,
                                    long deliveryAttempts, long updatedAt) {
            this.deviceId = deviceId;
            this.characterId = characterId;
            this.kind = kind;
            this.exists = exists;
            this.owner = owner;
            this.state = state;
            this.generation = generation;
            this.jobId = jobId;
            this.dueAt = dueAt;
            this.nextDeliveryAttemptAt = nextDeliveryAttemptAt;
            this.scheduleChecksum = scheduleChecksum;
            this.authorityEpochFingerprint = authorityEpochFingerprint;
            this.deliveryAttempts = deliveryAttempts;
            this.updatedAt = updatedAt;
        }
    }

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
        this.statusEndpoint = endpoint.endsWith("/v2/schedule-transitions")
            ? endpoint.substring(0, endpoint.length() - "/v2/schedule-transitions".length())
                + "/v2/schedule-status"
            : endpoint.replaceAll("/+$", "") + "/v2/schedule-status";
        this.clock = clock;
    }

    public RemoteScheduleStatus fetchStatus(AutomaticScheduleAuthorityEntity authority) {
        if (authority == null || authority.semanticJson == null
            || authority.semanticJson.trim().isEmpty()) {
            throw new IllegalArgumentException("automatic schedule authority is required");
        }
        final JSONObject request;
        try {
            JSONObject semantic = new JSONObject(authority.semanticJson);
            request = new JSONObject()
                .put("deviceId", requiredString(semantic, "deviceId"))
                .put("characterId", requiredString(semantic, "characterId"))
                .put("kind", requiredString(semantic, "kind"));
        } catch (JSONException error) {
            throw new IllegalArgumentException("automatic schedule semantic is invalid", error);
        }
        HttpResponse response;
        try {
            response = transport.post(statusEndpoint,
                Collections.singletonMap("Content-Type", "application/json"), request.toString());
        } catch (IOException error) {
            throw new IllegalStateException("schedule status transport", error);
        }
        if (response.status < 200 || response.status >= 300
            || !response.contentType.toLowerCase(Locale.ROOT).contains("application/json")) {
            throw new IllegalStateException("schedule status HTTP " + response.status);
        }
        return parseStatus(request, response.body);
    }

    private static RemoteScheduleStatus parseStatus(JSONObject request, String raw) {
        try {
            JSONObject body = new JSONObject(raw);
            Object okValue = body.get("ok");
            if (!(okValue instanceof Boolean) || !((Boolean) okValue)) {
                throw new IllegalArgumentException("status not ok");
            }
            String deviceId = request.getString("deviceId");
            String characterId = request.getString("characterId");
            String kind = request.getString("kind");
            Object existsValue = body.get("exists");
            if (!(existsValue instanceof Boolean)) throw new IllegalArgumentException("invalid exists");
            boolean exists = (Boolean) existsValue;
            if (!exists) {
                requireExactKeys(body, "ok", "exists");
                return new RemoteScheduleStatus(deviceId, characterId, kind, false,
                    "", "", 0L, null, null, null, "", "", 0L, 0L);
            }
            requireExactKeys(body, "ok", "exists", "owner", "state", "generation", "jobId",
                "dueAt", "nextDeliveryAttemptAt", "scheduleChecksum",
                "authorityEpochFingerprint", "deliveryAttempts", "updatedAt");
            String owner = exactString(body.get("owner"), "owner");
            String state = exactString(body.get("state"), "state");
            if (!("paused".equals(state) || "scheduled".equals(state)
                || "awaiting_ack".equals(state) || "disabled".equals(state))) {
                throw new IllegalArgumentException("invalid schedule status state");
            }
            long generation = exactLong(body.get("generation"), "generation");
            if (generation <= 0L) throw new IllegalArgumentException("invalid generation");
            String jobId = body.isNull("jobId") ? null : exactString(body.get("jobId"), "jobId");
            Long dueAt = body.isNull("dueAt") ? null : exactLong(body.get("dueAt"), "dueAt");
            Long nextAttempt = body.isNull("nextDeliveryAttemptAt")
                ? null : exactLong(body.get("nextDeliveryAttemptAt"), "nextDeliveryAttemptAt");
            String checksum = exactString(body.get("scheduleChecksum"), "scheduleChecksum");
            String epoch = exactString(body.get("authorityEpochFingerprint"), "authorityEpochFingerprint");
            long deliveryAttempts = exactLong(body.get("deliveryAttempts"), "deliveryAttempts");
            long updatedAt = exactLong(body.get("updatedAt"), "updatedAt");
            if (!checksum.matches("[a-f0-9]{64}") || !epoch.matches("[a-f0-9]{8}"))
                throw new IllegalArgumentException("invalid schedule fingerprints");
            if (deliveryAttempts < 0L || updatedAt <= 0L) throw new IllegalArgumentException("invalid status counters");
            return new RemoteScheduleStatus(deviceId, characterId, kind, true, owner, state,
                generation, jobId, dueAt, nextAttempt, checksum, epoch, deliveryAttempts, updatedAt);
        } catch (JSONException | ClassCastException error) {
            throw new IllegalArgumentException("schedule status shape is invalid", error);
        }
    }

    private static String requiredString(JSONObject value, String key) throws JSONException {
        String result = exactString(value.get(key), key).trim();
        if (result.isEmpty() || result.length() > 256) throw new IllegalArgumentException("invalid " + key);
        return result;
    }

    private static String exactString(Object value, String key) {
        if (!(value instanceof String)) throw new IllegalArgumentException("invalid " + key);
        return (String) value;
    }

    private static long exactLong(Object value, String key) {
        if (!(value instanceof Integer) && !(value instanceof Long)) {
            throw new IllegalArgumentException("invalid " + key);
        }
        long result = ((Number) value).longValue();
        if (result < 0L) throw new IllegalArgumentException("invalid " + key);
        return result;
    }

    private static void requireExactKeys(JSONObject value, String... keys) {
        Set<String> expected = new HashSet<>();
        Collections.addAll(expected, keys);
        Set<String> actual = new HashSet<>();
        java.util.Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) actual.add(iterator.next());
        if (!expected.equals(actual)) throw new IllegalArgumentException("schedule status keys mismatch");
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
