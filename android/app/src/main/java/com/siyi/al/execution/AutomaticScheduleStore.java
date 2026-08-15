package com.siyi.al.execution;

import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.AutomaticScheduleEventEntity;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import com.siyi.al.execution.db.LifecycleControlEntity;
import java.util.List;
import org.json.JSONObject;

/** The only Android writer allowed to advance an automatic chat or moment stream. */
public final class AutomaticScheduleStore {
    public static final String OWNER = "android-v1";
    private final AlExecutionDatabase database;
    private final AlExecutionDao dao;
    private final String deviceId;
    private final int faultAfterWrite;

    public AutomaticScheduleStore(AlExecutionDatabase database, String deviceId) {
        this(database, deviceId, 0);
    }

    AutomaticScheduleStore(AlExecutionDatabase database, String deviceId, int faultAfterWrite) {
        if (database == null || deviceId == null || deviceId.isEmpty()) {
            throw new IllegalArgumentException("automatic schedule store identity is required");
        }
        this.database = database;
        this.dao = database.executionDao();
        this.deviceId = deviceId;
        this.faultAfterWrite = faultAfterWrite;
    }

    public static final class Status {
        public final String streamKey;
        public final String state;
        public final long generation;
        public final String activeJobId;
        public final Long dueAt;
        public final String cloudSyncState;
        public final long conversationSequence;

        private Status(AutomaticScheduleAuthorityEntity row) {
            this.streamKey = row.streamKey;
            this.state = row.state;
            this.generation = row.generation;
            this.activeJobId = row.activeJobId;
            this.dueAt = row.dueAt;
            this.cloudSyncState = row.cloudSyncState;
            this.conversationSequence = row.conversationSequence;
        }
    }

    public AutomaticScheduleAuthorityEntity configure(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Source source, AutomaticScheduleContract.Policy policy, long now
    ) {
        return transitionAutomaticSchedule(characterId, kind, authorityEpoch,
            AutomaticScheduleContract.Operation.SCHEDULE, source, policy, now);
    }

    public AutomaticScheduleAuthorityEntity pauseForConversationInternal(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Source source, long now
    ) {
        return transitionAutomaticSchedule(characterId, kind, authorityEpoch,
            AutomaticScheduleContract.Operation.PAUSE, source, null, now);
    }

    public AutomaticScheduleAuthorityEntity finalizeDirectInternal(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Source source, AutomaticScheduleContract.Policy policy,
        AutomaticScheduleContract.TerminalDisposition disposition, long now
    ) {
        requireDisposition(disposition);
        return transitionAutomaticSchedule(characterId, kind, authorityEpoch,
            AutomaticScheduleContract.Operation.SCHEDULE, source, policy, now);
    }

    public boolean claim(String streamKey, String authorityEpoch, long generation,
                         String jobId, long now) {
        int changed = dao.claimAutomaticScheduleAuthorityExact(
            streamKey, authorityEpoch, generation, jobId, now);
        if (changed == 1) return true;
        AutomaticScheduleAuthorityEntity current = dao.automaticScheduleAuthority(streamKey);
        return current != null && OWNER.equals(current.owner) && "claimed".equals(current.state)
            && current.generation == generation && authorityEpoch.equals(current.authorityEpoch)
            && jobId != null && jobId.equals(current.activeJobId);
    }

    public AutomaticScheduleAuthorityEntity finalizeAutomatic(
        String characterId, String kind, String authorityEpoch,
        long claimedGeneration, String claimedJobId,
        AutomaticScheduleContract.Source source, AutomaticScheduleContract.Policy policy,
        AutomaticScheduleContract.TerminalDisposition disposition, long now
    ) {
        requireDisposition(disposition);
        String streamKey = AutomaticScheduleContract.streamKey(deviceId, characterId, kind);
        AutomaticScheduleAuthorityEntity current = dao.automaticScheduleAuthority(streamKey);
        if (isExactSourceReplay(current, source, policy)) return current;
        if (current == null || !"claimed".equals(current.state)
            || current.generation != claimedGeneration
            || !authorityEpoch.equals(current.authorityEpoch)
            || claimedJobId == null || !claimedJobId.equals(current.activeJobId)) {
            throw new IllegalStateException("automatic schedule claimed source conflict");
        }
        return transitionAutomaticSchedule(characterId, kind, authorityEpoch,
            AutomaticScheduleContract.Operation.SCHEDULE, source, policy, now);
    }

    public AutomaticScheduleAuthorityEntity disable(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Source source, long now
    ) {
        return transitionAutomaticSchedule(characterId, kind, authorityEpoch,
            AutomaticScheduleContract.Operation.DISABLE, source, null, now);
    }

    /**
     * Role-delete path: called only while RoomExecutionStore's outer
     * transaction is open. It emits the normal v2 disable transition for each
     * existing chat/moment authority, binding the lifecycle control identity
     * into sourceChecksum. No nested Room transaction is opened.
     */
    void disableForRoleDeleteInTransaction(
        String characterId, String controlId, String controlChecksum, long now
    ) {
        int writeOrdinal = 0;
        for (String kind : new String[] {"chat", "moment"}) {
            String streamKey = AutomaticScheduleContract.streamKey(deviceId, characterId, kind);
            AutomaticScheduleAuthorityEntity current = dao.automaticScheduleAuthority(streamKey);
            if (current == null || "disabled".equals(current.state)) continue;
            assertCurrentAuthority(current, current.authorityEpoch);
            AutomaticScheduleOutboxEntity predecessor = dao.automaticScheduleOutbox(
                streamKey + ":" + current.generation);
            if (!exactOutboxForAuthority(predecessor, current)) {
                throw new IllegalStateException("role delete predecessor outbox conflict");
            }
            if ("quarantined".equals(predecessor.state)
                && dao.restoreQuarantinedAutomaticScheduleOutboxExact(
                    predecessor.outboxId, predecessor.streamKey, predecessor.generation,
                    predecessor.operation, predecessor.payloadChecksum, predecessor.payloadJson,
                    now, now) != 1) {
                throw new IllegalStateException("role delete quarantined predecessor restore conflict");
            }
            JSONObject sourceBasis;
            try {
                sourceBasis = new JSONObject()
                    .put("characterId", characterId)
                    .put("controlId", controlId)
                    .put("controlChecksum", controlChecksum)
                    .put("kind", kind);
            } catch (Exception error) {
                throw new IllegalStateException("role delete disable source checksum", error);
            }
            String sourceChecksum = BridgeAuthority.sha256CanonicalJson(sourceBasis);
            AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
                "lifecycle", "role_delete_" + controlId + "_" + kind,
                sourceChecksum, current.conversationSequence, now);
            if (isExactSourceReplay(current, source, null)) continue;
            if (isSourceIdentityConflict(current, source)) {
                throw new IllegalStateException("role delete disable source conflict");
            }
            AutomaticScheduleContract.ValidatedTransition transition =
                AutomaticScheduleContract.create(
                    "disable", OWNER, current.authorityEpoch, current.generation + 1L,
                    current.activeJobId, deviceId, characterId, kind, streamKey,
                    null, null, null, source, currentPolicyRevision(current),
                    currentPolicyChecksum(current));
            AutomaticScheduleAuthorityEntity next = authorityRow(
                current, transition, current.conversationSequence, now);
            AutomaticScheduleOutboxEntity outbox = outboxRow(transition, now);
            AutomaticScheduleEventEntity event = eventRow(
                current, next, transition, source,
                AutomaticScheduleContract.Operation.DISABLE, now);
            if (dao.upsertAutomaticScheduleAuthority(next) <= 0L) {
                throw new IllegalStateException("role delete disable authority write conflict");
            }
            maybeFault(++writeOrdinal);
            if (dao.insertAutomaticScheduleOutbox(outbox) <= 0L) {
                throw new IllegalStateException("role delete disable outbox write conflict");
            }
            maybeFault(++writeOrdinal);
            if (dao.insertAutomaticScheduleEvent(event) <= 0L) {
                throw new IllegalStateException("role delete disable event write conflict");
            }
            maybeFault(++writeOrdinal);
        }
    }

    private static boolean exactOutboxForAuthority(
        AutomaticScheduleOutboxEntity outbox, AutomaticScheduleAuthorityEntity authority
    ) {
        if (outbox == null || authority == null || authority.semanticJson == null) return false;
        try {
            JSONObject semantic = parse(authority.semanticJson);
            String operation = requiredString(semantic, "operation");
            return ("waiting".equals(outbox.state) || "pending".equals(outbox.state)
                    || "synced".equals(outbox.state) || "quarantined".equals(outbox.state))
                && outbox.outboxId.equals(authority.streamKey + ":" + authority.generation)
                && outbox.streamKey.equals(authority.streamKey)
                && outbox.generation == authority.generation
                && outbox.operation.equals(operation)
                && outbox.payloadChecksum.equals(authority.semanticChecksum)
                && outbox.state.equals(authority.cloudSyncState)
                && outbox.payloadJson.equals(authority.semanticJson);
        } catch (RuntimeException error) {
            return false;
        }
    }

    public AutomaticScheduleAuthorityEntity migrateLegacyCandidate(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Source source, AutomaticScheduleContract.Policy policy, long now
    ) {
        if (!"migration_claim".equals(source.type)) {
            throw new IllegalArgumentException("automatic schedule migration source is required");
        }
        return configure(characterId, kind, authorityEpoch, source, policy, now);
    }

    public Status status(String characterId, String kind) {
        AutomaticScheduleAuthorityEntity row = dao.automaticScheduleAuthority(
            AutomaticScheduleContract.streamKey(deviceId, characterId, kind));
        return row == null ? null : new Status(row);
    }

    public AutomaticScheduleAuthorityEntity transitionAutomaticSchedule(
        String characterId, String kind, String authorityEpoch,
        AutomaticScheduleContract.Operation operation,
        AutomaticScheduleContract.Source source,
        AutomaticScheduleContract.Policy policy,
        long now
    ) {
        if (operation == AutomaticScheduleContract.Operation.SCHEDULE && policy == null) {
            throw new IllegalArgumentException("automatic schedule policy is required");
        }
        if (operation != AutomaticScheduleContract.Operation.SCHEDULE && policy != null) {
            throw new IllegalArgumentException("inactive automatic schedule cannot carry policy");
        }
        final AutomaticScheduleAuthorityEntity[] result = new AutomaticScheduleAuthorityEntity[1];
        database.runInTransaction(() -> {
            String streamKey = AutomaticScheduleContract.streamKey(deviceId, characterId, kind);
            AutomaticScheduleAuthorityEntity current = dao.automaticScheduleAuthority(streamKey);
            assertCurrentAuthority(current, authorityEpoch);
            assertRoleAllows(characterId, operation);
            if (current != null && source.conversationSequence < current.conversationSequence) {
                throw new IllegalStateException("automatic schedule conversation sequence is stale");
            }
            if (isSourceIdentityConflict(current, source)) {
                throw new IllegalStateException("automatic schedule source checksum conflict");
            }
            if (isExactSourceReplay(current, source, policy)) {
                result[0] = current;
                return;
            }

            long generation = current == null ? 1L : Math.addExact(current.generation, 1L);
            String previousJobId = current == null ? null : current.activeJobId;
            AutomaticScheduleContract.ValidatedTransition transition;
            if (operation == AutomaticScheduleContract.Operation.SCHEDULE) {
                AutomaticSchedulePlanner planner = new AutomaticSchedulePlanner(
                    deviceId, characterId, kind, authorityEpoch, generation, previousJobId);
                transition = planner.next(source, policy, now).transition;
            } else {
                transition = AutomaticScheduleContract.create(
                    wire(operation), OWNER, authorityEpoch, generation, previousJobId,
                    deviceId, characterId, kind, streamKey, null, null, null,
                    source, currentPolicyRevision(current), currentPolicyChecksum(current)
                );
            }

            AutomaticScheduleAuthorityEntity next = authorityRow(
                current, transition, source.conversationSequence, now);
            AutomaticScheduleOutboxEntity outbox = outboxRow(transition, now);
            AutomaticScheduleEventEntity event = eventRow(
                current, next, transition, source, operation, now);

            if (dao.upsertAutomaticScheduleAuthority(next) <= 0L) {
                throw new IllegalStateException("automatic schedule authority write conflict");
            }
            maybeFault(1);
            if (dao.insertAutomaticScheduleOutbox(outbox) <= 0L) {
                throw new IllegalStateException("automatic schedule outbox write conflict");
            }
            maybeFault(2);
            if (dao.insertAutomaticScheduleEvent(event) <= 0L) {
                throw new IllegalStateException("automatic schedule event write conflict");
            }
            maybeFault(3);
            result[0] = next;
        });
        return result[0];
    }

    private void assertCurrentAuthority(AutomaticScheduleAuthorityEntity current, String epoch) {
        if (current == null) return;
        if (!OWNER.equals(current.owner) || !epoch.equals(current.authorityEpoch)) {
            throw new IllegalStateException("automatic schedule authority conflict");
        }
        AutomaticScheduleContract.validateTransition(parse(current.semanticJson));
    }

    private void assertRoleAllows(String characterId, AutomaticScheduleContract.Operation operation) {
        List<LifecycleControlEntity> controls = dao.roleDeleteControlsForCharacter(characterId);
        if (!controls.isEmpty() && operation != AutomaticScheduleContract.Operation.DISABLE) {
            throw new IllegalStateException("automatic schedule role is deleted");
        }
    }

    private boolean isSourceIdentityConflict(AutomaticScheduleAuthorityEntity current,
                                             AutomaticScheduleContract.Source source) {
        if (current == null) return false;
        JSONObject value = parse(current.semanticJson);
        String storedType = requiredString(value, "sourceType");
        String storedId = requiredString(value, "sourceId");
        String storedChecksum = requiredString(value, "sourceChecksum");
        return storedType.equals(source.type) && storedId.equals(source.id)
            && !storedChecksum.equals(source.checksum);
    }

    private boolean isExactSourceReplay(AutomaticScheduleAuthorityEntity current,
                                        AutomaticScheduleContract.Source source,
                                        AutomaticScheduleContract.Policy policy) {
        if (current == null) return false;
        JSONObject value = parse(current.semanticJson);
        if (!requiredString(value, "sourceType").equals(source.type)
            || !requiredString(value, "sourceId").equals(source.id)
            || !requiredString(value, "sourceChecksum").equals(source.checksum)) return false;
        String storedPolicyChecksum = requiredString(value, "policyChecksum");
        long storedPolicyRevision = requiredLong(value, "policyRevision");
        if (policy == null) return true;
        if (!storedPolicyChecksum.equals(policy.checksum) || storedPolicyRevision != policy.revision) {
            throw new IllegalStateException("automatic schedule replay policy conflict");
        }
        return true;
    }

    private AutomaticScheduleAuthorityEntity authorityRow(
        AutomaticScheduleAuthorityEntity current,
        AutomaticScheduleContract.ValidatedTransition transition,
        long conversationSequence, long now
    ) {
        JSONObject value = transition.value;
        AutomaticScheduleAuthorityEntity row = new AutomaticScheduleAuthorityEntity();
        row.streamKey = transition.streamKey;
        row.characterId = requiredString(value, "characterId");
        row.kind = requiredString(value, "kind");
        row.owner = requiredString(value, "owner");
        row.authorityEpoch = requiredString(value, "authorityEpoch");
        row.generation = requiredLong(value, "generation");
        String operation = requiredString(value, "operation");
        row.state = "schedule".equals(operation) ? "scheduled"
            : ("pause".equals(operation) ? "paused_for_conversation" : "disabled");
        row.activeJobId = transition.jobId;
        row.dueAt = optionalLong(value, "dueAt");
        row.semanticJson = BridgeAuthority.canonicalJson(value);
        row.semanticChecksum = transition.scheduleChecksum;
        row.cloudSyncState = "waiting";
        row.conversationSequence = conversationSequence;
        row.createdAt = current == null ? now : current.createdAt;
        row.updatedAt = now;
        return row;
    }

    private AutomaticScheduleOutboxEntity outboxRow(
        AutomaticScheduleContract.ValidatedTransition transition, long now
    ) {
        JSONObject value = transition.value;
        AutomaticScheduleOutboxEntity row = new AutomaticScheduleOutboxEntity();
        row.streamKey = transition.streamKey;
        row.generation = requiredLong(value, "generation");
        row.outboxId = row.streamKey + ":" + row.generation;
        row.operation = requiredString(value, "operation");
        row.payloadJson = BridgeAuthority.canonicalJson(value);
        row.payloadChecksum = transition.scheduleChecksum;
        row.state = "waiting";
        row.nextAttemptAt = now;
        row.createdAt = now;
        row.updatedAt = now;
        return row;
    }

    private AutomaticScheduleEventEntity eventRow(
        AutomaticScheduleAuthorityEntity current, AutomaticScheduleAuthorityEntity next,
        AutomaticScheduleContract.ValidatedTransition transition,
        AutomaticScheduleContract.Source source,
        AutomaticScheduleContract.Operation operation, long now
    ) {
        AutomaticScheduleEventEntity row = new AutomaticScheduleEventEntity();
        row.streamKey = next.streamKey;
        row.generation = next.generation;
        row.eventType = wire(operation);
        row.eventId = row.streamKey + ":" + row.generation + ":" + row.eventType;
        row.previousJobId = current == null ? null : current.activeJobId;
        row.nextJobId = next.activeJobId;
        row.previousDueAt = current == null ? null : current.dueAt;
        row.nextDueAt = next.dueAt;
        row.sourceType = source.type;
        row.sourceId = source.id;
        row.sourceChecksum = source.checksum;
        row.resultCode = "COMMITTED";
        row.createdAt = now;
        return row;
    }

    private long currentPolicyRevision(AutomaticScheduleAuthorityEntity current) {
        return current == null ? 1L : requiredLong(parse(current.semanticJson), "policyRevision");
    }

    private String currentPolicyChecksum(AutomaticScheduleAuthorityEntity current) {
        return current == null ? repeat('0', 64)
            : requiredString(parse(current.semanticJson), "policyChecksum");
    }

    private static String wire(AutomaticScheduleContract.Operation operation) {
        return operation.name().toLowerCase(java.util.Locale.ROOT);
    }

    private static void requireDisposition(AutomaticScheduleContract.TerminalDisposition disposition) {
        if (disposition == null) {
            throw new IllegalArgumentException("automatic schedule terminal disposition is required");
        }
    }

    private void maybeFault(int step) {
        if (faultAfterWrite == step) {
            throw new IllegalStateException("automatic schedule injected fault after write " + step);
        }
    }

    private static JSONObject parse(String value) {
        try {
            return new JSONObject(value);
        } catch (Exception error) {
            throw new IllegalStateException("automatic schedule semantic authority conflict", error);
        }
    }

    private static String requiredString(JSONObject value, String key) {
        try {
            Object item = value.get(key);
            if (!(item instanceof String)) throw new IllegalStateException();
            return (String) item;
        } catch (Exception error) {
            throw new IllegalStateException("automatic schedule semantic authority conflict", error);
        }
    }

    private static long requiredLong(JSONObject value, String key) {
        try {
            Object item = value.get(key);
            if (!(item instanceof Integer) && !(item instanceof Long)) throw new IllegalStateException();
            return ((Number) item).longValue();
        } catch (Exception error) {
            throw new IllegalStateException("automatic schedule semantic authority conflict", error);
        }
    }

    private static Long optionalLong(JSONObject value, String key) {
        try {
            Object item = value.get(key);
            if (item == JSONObject.NULL) return null;
            if (!(item instanceof Integer) && !(item instanceof Long)) throw new IllegalStateException();
            return ((Number) item).longValue();
        } catch (Exception error) {
            throw new IllegalStateException("automatic schedule semantic authority conflict", error);
        }
    }

    private static String repeat(char value, int count) {
        char[] output = new char[count];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }
}
