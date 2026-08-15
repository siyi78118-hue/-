package com.siyi.al.execution;

import androidx.annotation.NonNull;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ConversationAuthorityEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.DiagnosticEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.LifecycleControlEntity;
import com.siyi.al.execution.db.LifecycleInboundAckTombstoneEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.RolePlanOccurrenceEntity;
import com.siyi.al.execution.db.RoleNotificationCancellationEntity;
import com.siyi.al.execution.bridge.BridgeInput;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentHashMap;
import java.time.Instant;
import org.json.JSONObject;
import org.json.JSONArray;
import org.json.JSONException;

public final class RoomExecutionStore implements ExecutionStore, ExecutionEngineStore,
    BridgeReceiptDeliveryCoordinator.Store {
    public enum DeliveryDisposition { APPLY, REDACTED }
    interface TestDeliveryDispositionObserver {
        void onDisposition(DeliveryDisposition disposition);
    }
    private static volatile TestDeliveryDispositionObserver testDeliveryDispositionObserver;

    static void setTestDeliveryDispositionObserver(TestDeliveryDispositionObserver observer) {
        testDeliveryDispositionObserver = observer;
    }

    private static void observeTestDeliveryDisposition(DeliveryDisposition disposition) {
        TestDeliveryDispositionObserver observer = testDeliveryDispositionObserver;
        if (observer == null || disposition == null) return;
        try {
            observer.onDisposition(disposition);
        } catch (Throwable ignored) {
            // Test-only observation must never alter the transaction outcome.
        }
    }
    /** A role-plan claim failed inside its atomic Room transaction. */
    public static final class AtomicRolePlanSubmissionException extends IllegalStateException {
        public AtomicRolePlanSubmissionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
    public static final class CanonicalCloudTarget {
        public final String localTurnId;
        public final String activeAttemptId;

        public CanonicalCloudTarget(String localTurnId, String activeAttemptId) {
            this.localTurnId = localTurnId;
            this.activeAttemptId = activeAttemptId;
        }
    }
    interface TerminalFaultHook {
        void after(String boundary);
    }

    static final String FAULT_CHECKPOINT = "checkpoint_terminal_cas";
    static final String FAULT_REPLY_PARTS = "reply_part_batch";
    static final String FAULT_RAW_MESSAGES = "raw_message_batch";
    static final String FAULT_AUTHORITY = "authority_cas";
    static final String FAULT_TURN = "turn_finalizer";
    static final String FAULT_ATTEMPT = "active_attempt_finalizer";
    static final String FAULT_NATIVE_CURSOR = "native_cursor_update";
    static final String FAULT_UI_CURSOR = "skip_ui_cursor_update";
    static final String FAULT_CHANGE = "change_event_insert";
    static final String FAULT_FAILURE_CHECKPOINT = "checkpoint_failure_cas";
    static final String FAULT_FAILURE_TURN = "turn_failure_cas";
    static final String FAULT_FAILURE_ATTEMPT = "attempt_failure_cas";
    static final String FAULT_FAILURE_CHANGE = "failure_change_event";
    static final String FAULT_FAILURE_DIAGNOSTIC = "failure_diagnostic";
    static final String FAULT_LOCAL_JOURNAL = "local_journal_sequence";

    private final AlExecutionDatabase database;
    private final AlExecutionDao dao;
    private final TerminalFaultHook terminalFaultHook;
    private final String storeOwnedPeerId;
    /**
     * Process-local role boundary.  The retained lifecycle tombstone remains
     * the durable authority across process death; this monitor closes the
     * check-to-side-effect window while this process is alive.
     */
    private static final ConcurrentHashMap<String, Object> ROLE_SIDE_EFFECT_GATES =
        new ConcurrentHashMap<>();
    private static final Set<String> CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome"
    ));
    private static final Set<String> LOCAL_CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome", "fallbackExecution",
        "journalSyncSeq"
    ));
    private static final Set<String> LOCAL_REDACTED_RESULT_KEYS = new HashSet<>(Arrays.asList(
        "contract", "authorityLineageKey", "authoritativeTurnId",
        "inputVisibilitySequence", "inputClearEpoch", "draftDisposition"
    ));
    private static final Set<String> OUTCOME_KEYS = new HashSet<>(Arrays.asList(
        "type", "route", "relayMessageId", "failure", "result", "redactedAt"
    ));
    private static final Set<String> CANONICAL_RESULT_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "turnId", "roleId", "authorityOrigin", "authorityLineageKey",
        "visibleGroupId", "lineageRevision", "turnRevision", "laneKey", "laneRevision",
        "inputVisibilitySequence", "inputClearEpoch", "generationFingerprint", "releaseId",
        "commitPayloadVersion", "commitChecksum", "terminalDisposition", "replyParts", "actions"
    ));
    private static final Set<String> CANONICAL_RESULT_METADATA_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "turnId", "roleId", "authorityOrigin", "authorityLineageKey",
        "visibleGroupId", "lineageRevision", "turnRevision", "laneKey", "laneRevision",
        "inputVisibilitySequence", "inputClearEpoch", "generationFingerprint", "releaseId",
        "commitPayloadVersion", "commitChecksum", "terminalDisposition"
    ));
    private static final Set<String> CANONICAL_ACTION_KEYS = new HashSet<>(Arrays.asList(
        "actionId", "ordinal", "kind", "targetKey", "targetRevision", "payload", "actionChecksum"
    ));
    private static final String ROLE_NOTIFICATION_CANCELLATION_CONTRACT =
        "android-role-notification-cancellation-v1";

    public RoomExecutionStore(AlExecutionDatabase database) {
        this(database, null, boundary -> {});
    }

    RoomExecutionStore(AlExecutionDatabase database, TerminalFaultHook terminalFaultHook) {
        this(database, null, terminalFaultHook);
    }

    public RoomExecutionStore(AlExecutionDatabase database, String storeOwnedPeerId) {
        this(database, storeOwnedPeerId, boundary -> {});
    }

    RoomExecutionStore(
        AlExecutionDatabase database,
        String storeOwnedPeerId,
        TerminalFaultHook terminalFaultHook
    ) {
        this.database = database;
        this.dao = database.executionDao();
        this.terminalFaultHook = terminalFaultHook;
        this.storeOwnedPeerId = storeOwnedPeerId == null ? null : storeOwnedPeerId.trim();
        validatePersistedLifecycleControls();
        validatePersistedLifecycleInboundAckTombstones();
        validatePersistedRoleNotificationCancellations();
    }

    private void validatePersistedLifecycleControls() {
        for (LifecycleControlEntity row : dao.lifecycleControls()) {
            validatePersistedLifecycleControl(row);
        }
    }

    private void validatePersistedLifecycleInboundAckTombstones() {
        for (LifecycleInboundAckTombstoneEntity row : dao.lifecycleInboundAckTombstones()) {
            if (row == null || row.ackKey == null || !row.ackKey.matches("[a-f0-9]{64}")
                || row.peerId == null || row.inboundRelayMessageId == null
                || row.controlId == null || row.controlChecksum == null || row.ackChecksum == null
                || !"unknown_control".equals(row.reasonCode)
                || row.relayExpiresAt <= 0L || row.relayExpiresAt > LifecycleControlSender.MAX_SAFE_INTEGER
                || row.createdAt <= 0L || row.createdAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
                throw new IllegalStateException("lifecycle unknown ACK tombstone authority conflict");
            }
            requireBridgeIdentity(row.peerId, "lifecycle unknown ACK peer");
            requireBridgeIdentity(row.inboundRelayMessageId, "lifecycle unknown ACK relay");
            requireBridgeIdentity(row.controlId, "lifecycle unknown ACK control");
            requireLowerSha(row.controlChecksum, "lifecycle unknown ACK control checksum");
            requireLowerSha(row.ackChecksum, "lifecycle unknown ACK checksum");
            if (!row.ackKey.equals(unknownLifecycleAckKey(
                row.peerId, row.inboundRelayMessageId, row.relayExpiresAt,
                row.controlId, row.controlChecksum, row.ackChecksum, row.reasonCode))) {
                throw new IllegalStateException("lifecycle unknown ACK tombstone authority conflict");
            }
        }
    }

    private void validatePersistedRoleNotificationCancellations() {
        for (RoleNotificationCancellationEntity row : dao.roleNotificationCancellations()) {
            validatePersistedRoleNotificationCancellation(row);
        }
    }

    private void validatePersistedRoleNotificationCancellation(
        RoleNotificationCancellationEntity row
    ) {
        if (row == null || row.cancellationKey == null || row.controlId == null
            || row.characterId == null || row.intentChecksum == null
            || row.state == null || !"waiting".equals(row.state)
            || !row.cancellationKey.matches("rncan_[a-f0-9]{64}")
            || !row.intentChecksum.matches("[a-f0-9]{64}")
            || !RoleNotificationCancellationContract.isValidNotificationId(row.notificationId)
            || row.createdAt <= 0L || row.updatedAt < row.createdAt
            || row.createdAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || row.updatedAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalStateException("role notification cancellation authority conflict");
        }
        LifecycleControlEntity control = dao.lifecycleControl(row.controlId);
        if (control == null || !LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind)
            || !row.characterId.equals(control.characterId)) {
            throw new IllegalStateException("role notification cancellation control conflict");
        }
        String expectedChecksum = roleNotificationCancellationChecksum(
            row.controlId, row.characterId, row.notificationId, row.createdAt);
        if (!row.intentChecksum.equals(expectedChecksum)
            || !row.cancellationKey.equals("rncan_" + expectedChecksum)) {
            throw new IllegalStateException("role notification cancellation checksum conflict");
        }
    }

    private static String roleNotificationCancellationChecksum(
        String controlId, String characterId, int notificationId, long createdAt
    ) {
        try {
            JSONObject basis = new JSONObject()
                .put("contract", ROLE_NOTIFICATION_CANCELLATION_CONTRACT)
                .put("controlId", controlId)
                .put("characterId", characterId)
                .put("notificationId", notificationId)
                .put("createdAt", createdAt);
            return BridgeAuthority.sha256CanonicalJson(basis);
        } catch (JSONException error) {
            throw new IllegalStateException("role notification cancellation checksum failed", error);
        }
    }

    private static void validatePersistedLifecycleControl(LifecycleControlEntity row) {
            if (row == null || row.controlId == null || row.controlId.trim().isEmpty()
                || row.controlKind == null || row.characterId == null || row.peerId == null
                || row.requestedAt <= 0L || row.updatedAt <= 0L || row.leaseAttempt < 0L
                || row.requestedAt > LifecycleControlSender.MAX_SAFE_INTEGER
                || row.updatedAt > LifecycleControlSender.MAX_SAFE_INTEGER
                || row.leaseAttempt > LifecycleControlSender.MAX_SAFE_INTEGER
            || row.semanticJson == null || row.semanticChecksum == null) {
            throw new IllegalStateException("lifecycle control authority conflict");
        }
        try {
            JSONObject semantic = new JSONObject(row.semanticJson);
            LifecycleControlCodec.validateSemantic(semantic);
            if (!row.semanticChecksum.equals(LifecycleControlCodec.semanticChecksum(semantic))
                || !row.controlId.equals(LifecycleControlCodec.controlId(semantic))) {
                throw new IllegalStateException("lifecycle control checksum conflict");
            }
            boolean clear = LifecycleControl.CLEAR_KIND.equals(row.controlKind);
            boolean roleDelete = LifecycleControl.ROLE_DELETE_KIND.equals(row.controlKind);
            if (!clear && !roleDelete
                || (clear && (row.clearEpoch == null || row.clearedThroughSequence == null))
                || (roleDelete && (row.clearEpoch != null || row.clearedThroughSequence != null))) {
                throw new IllegalStateException("lifecycle control kind conflict");
            }
            if (!row.characterId.equals(semantic.getString("roleId"))
                || !row.peerId.equals(semantic.getString("peerId"))
                || row.requestedAt != semantic.getLong("requestedAt")) {
                throw new IllegalStateException("lifecycle control projection conflict");
            }
            if (clear && (row.clearEpoch.longValue() != semantic.getLong("clearEpoch")
                || row.clearedThroughSequence.longValue() != semantic.getLong("clearedThroughSequence"))) {
                throw new IllegalStateException("lifecycle clear projection conflict");
            }
            if (roleDelete && (row.clearEpoch != null || row.clearedThroughSequence != null)) {
                throw new IllegalStateException("lifecycle role-delete projection conflict");
            }
            if ((row.leasedAt != null && !safeNonNegative(row.leasedAt))
                || (row.relayExpiresAt != null && !safeNonNegative(row.relayExpiresAt))
                || (row.appliedAt != null && !safeNonNegative(row.appliedAt))
                || (row.leasedAt != null && row.relayExpiresAt != null
                    && row.relayExpiresAt < row.leasedAt)
                || (row.appliedAt != null && row.appliedAt < row.requestedAt)) {
                throw new IllegalStateException("lifecycle timestamp conflict");
            }
            LifecycleControl persisted = LifecycleControl.fromEntity(row);
            if (row.relayMessageId != null
                && !LifecycleControlSender.relayMessageId(persisted).equals(row.relayMessageId)) {
                throw new IllegalStateException("lifecycle relay identity conflict");
            }
            if ((LifecycleControl.PENDING.equals(row.state)
                    || LifecycleControl.RELAY_ACCEPTED.equals(row.state))
                && row.leaseId != null
                && !LifecycleControlSender.leaseId(persisted, row.leaseAttempt).equals(row.leaseId)) {
                throw new IllegalStateException("lifecycle lease identity conflict");
            }
            switch (row.state) {
                case LifecycleControl.WAITING:
                    if (row.leaseAttempt != 0L || row.leaseId != null || row.leasedAt != null || row.relayMessageId != null
                        || row.relayExpiresAt != null || row.appliedAt != null) {
                        throw new IllegalStateException("lifecycle waiting lease conflict");
                    }
                    break;
                case LifecycleControl.PENDING:
                    if (row.leaseId == null || row.leasedAt == null
                        || (row.relayMessageId == null) != (row.relayExpiresAt == null)
                        || row.appliedAt != null || row.leaseAttempt <= 0L) {
                        throw new IllegalStateException("lifecycle pending lease conflict");
                    }
                    break;
                case LifecycleControl.RELAY_ACCEPTED:
                    if (row.leaseId != null || row.leasedAt != null || row.relayExpiresAt == null
                        || row.relayMessageId == null || row.appliedAt != null || row.leaseAttempt <= 0L) {
                        throw new IllegalStateException("lifecycle relay lease conflict");
                    }
                    break;
                case LifecycleControl.APPLIED:
                    if (row.appliedAt == null || row.appliedAt <= 0L) {
                        throw new IllegalStateException("lifecycle applied timestamp conflict");
                    }
                    if ((row.relayMessageId == null) != (row.relayExpiresAt == null)
                        || row.leaseId != null || row.leasedAt != null) {
                        throw new IllegalStateException("lifecycle applied relay conflict");
                    }
                    break;
                case LifecycleControl.QUARANTINED:
                    if (row.leaseId != null || row.leasedAt != null || row.relayMessageId != null
                        || row.relayExpiresAt != null || row.appliedAt != null) {
                        throw new IllegalStateException("lifecycle quarantine lease conflict");
                    }
                    break;
                default:
                    throw new IllegalStateException("lifecycle state conflict");
            }
        } catch (JSONException error) {
            throw new IllegalStateException("lifecycle semantic conflict", error);
        }
    }

    private static boolean safeNonNegative(Long value) {
        return value != null && value >= 0L && value <= 9007199254740991L;
    }

    @Override
    public ChatTurnEntity submitTurn(TurnSubmission submission) {
        AtomicReference<ChatTurnEntity> result = new AtomicReference<>();
        database.runInTransaction(() -> result.set(submitTurnInTransaction(submission)));
        return result.get();
    }

    AutomaticTaskCoordinator.DispatchOutcome claimAutomaticTurn(
        AutomaticTaskCoordinator.ClaimToken token, String snapshotJson, long now
    ) {
        AtomicReference<AutomaticTaskCoordinator.DispatchOutcome> result =
            new AtomicReference<>(AutomaticTaskCoordinator.DispatchOutcome.STALE);
        database.runInTransaction(() -> {
            AutomaticScheduleAuthorityEntity authority =
                dao.automaticScheduleAuthorityForCharacterKind(token.characterId, token.kind);
            if (!matchesAutomaticClaim(authority, token) || authority.dueAt == null
                || authority.dueAt > now) {
                return;
            }
            String turnId = automaticTurnId(token.jobId);
            ChatTurnEntity existing = dao.turn(turnId);
            if ("claimed".equals(authority.state)) {
                if (existing != null && exactAutomaticTurn(existing, token)) {
                    result.set(AutomaticTaskCoordinator.DispatchOutcome.REPLAY);
                } else if (existing == null) {
                    throw new IllegalStateException("automatic claimed turn is missing");
                } else {
                    throw new IllegalStateException("automatic claimed turn identity conflict");
                }
                return;
            }
            if (!"scheduled".equals(authority.state)
                || dao.claimAutomaticScheduleAuthorityExact(
                    authority.streamKey, token.authorityEpoch, token.generation,
                    token.jobId, now) != 1) {
                return;
            }
            if (existing != null) {
                if (!exactAutomaticTurn(existing, token)) {
                    throw new IllegalStateException("automatic claim turn identity conflict");
                }
                result.set(AutomaticTaskCoordinator.DispatchOutcome.REPLAY);
                return;
            }
            JSONObject pinnedSnapshot;
            try {
                pinnedSnapshot = new JSONObject(snapshotJson == null ? "{}" : snapshotJson);
                pinnedSnapshot.put("_automaticScheduleAuthority", token.toJson());
            } catch (Exception error) {
                throw new IllegalArgumentException("automatic claim snapshot is invalid", error);
            }
            TurnKind turnKind = "moment".equals(token.kind)
                ? TurnKind.PROACTIVE_MOMENT : TurnKind.PROACTIVE_CHAT;
            ChatTurnEntity created = submitTurnInTransaction(new TurnSubmission(
                turnId, token.characterId, turnId, turnKind, "{}",
                pinnedSnapshot.toString(), token.jobId, now));
            if (created == null || !exactAutomaticTurn(created, token)) {
                throw new IllegalStateException("automatic claim turn creation conflict");
            }
            result.set(AutomaticTaskCoordinator.DispatchOutcome.CLAIMED);
        });
        return result.get();
    }

    private static boolean matchesAutomaticClaim(
        AutomaticScheduleAuthorityEntity authority, AutomaticTaskCoordinator.ClaimToken token
    ) {
        return authority != null && AutomaticScheduleStore.OWNER.equals(authority.owner)
            && token.characterId.equals(authority.characterId)
            && token.kind.equals(authority.kind)
            && token.authorityEpoch.equals(authority.authorityEpoch)
            && token.generation == authority.generation
            && token.jobId.equals(authority.activeJobId)
            && ("scheduled".equals(authority.state) || "claimed".equals(authority.state));
    }

    private static boolean exactAutomaticTurn(
        ChatTurnEntity turn, AutomaticTaskCoordinator.ClaimToken token
    ) {
        String expectedKind = "moment".equals(token.kind)
            ? TurnKind.PROACTIVE_MOMENT.name() : TurnKind.PROACTIVE_CHAT.name();
        return turn != null && token.characterId.equals(turn.characterId)
            && token.jobId.equals(turn.cloudJobId) && expectedKind.equals(turn.kind);
    }

    public static String automaticTurnId(String jobId) {
        return "cloud_" + jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    public static final class AutomaticFinalization {
        public final boolean advanced;
        public final String previousJobId;
        public final AutomaticScheduleAuthorityEntity authority;

        private AutomaticFinalization(
            boolean advanced, String previousJobId, AutomaticScheduleAuthorityEntity authority
        ) {
            this.advanced = advanced;
            this.previousJobId = previousJobId;
            this.authority = authority;
        }

        static AutomaticFinalization stale() {
            return new AutomaticFinalization(false, null, null);
        }
    }

    /**
     * The single terminal writer for direct and proactive chat/moment streams.
     * Turn proof, schedule transition and outbox/event rows share one Room transaction.
     */
    public AutomaticFinalization finalizeAutomaticScheduleForTurn(String turnId, long now) {
        AtomicReference<AutomaticFinalization> result =
            new AtomicReference<>(AutomaticFinalization.stale());
        database.runInTransaction(() -> {
            ChatTurnEntity turn = dao.turn(turnId);
            if (turn == null || turn.deletedAt != null || isRoleDeleteTombstoned(turn.characterId)) return;
            boolean direct = TurnKind.DIRECT_REPLY.name().equals(turn.kind);
            boolean moment = TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind);
            boolean proactive = moment || TurnKind.PROACTIVE_CHAT.name().equals(turn.kind);
            if (!direct && !proactive) return;
            AutomaticScheduleAuthorityEntity current =
                dao.automaticScheduleAuthorityForCharacterKind(
                    turn.characterId, moment ? "moment" : "chat");
            if (current == null || "disabled".equals(current.state)) return;

            AutomaticScheduleContract.TerminalDisposition disposition =
                terminalDispositionForAutomaticSchedule(turn);
            if (disposition == null) return;
            JSONObject currentSemantic;
            try {
                currentSemantic = new JSONObject(current.semanticJson);
                AutomaticScheduleContract.validateTransition(currentSemantic);
            } catch (Exception error) {
                throw new IllegalStateException("automatic schedule authority conflict", error);
            }
            String deviceId = currentSemantic.optString("deviceId", "");
            String epoch = currentSemantic.optString("authorityEpoch", "");
            String resultChecksum = automaticTerminalChecksum(turn, disposition);
            String sourceType = disposition == AutomaticScheduleContract.TerminalDisposition.FAILED
                ? "failure_retry" : (direct ? "direct_terminal" : "proactive_terminal");
            AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
                sourceType,
                automaticTerminalSourceId(turn, direct),
                resultChecksum,
                current.conversationSequence,
                automaticTerminalOccurredAt(turn, now));
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, deviceId);
            String previousJobId = current.activeJobId;
            AutomaticScheduleAuthorityEntity next;
            if (direct) {
                AutomaticScheduleContract.Source pauseSource = directInputSource(turn);
                String currentSourceType = currentSemantic.optString("sourceType", "");
                String currentSourceId = currentSemantic.optString("sourceId", "");
                String currentSourceChecksum = currentSemantic.optString("sourceChecksum", "");
                boolean ownsPause = "direct_input".equals(currentSourceType)
                    && pauseSource.id.equals(currentSourceId)
                    && pauseSource.checksum.equals(currentSourceChecksum);
                boolean exactTerminalReplay = sourceType.equals(currentSourceType)
                    && source.id.equals(currentSourceId)
                    && source.checksum.equals(currentSourceChecksum);
                if (sourceType.equals(currentSourceType) && source.id.equals(currentSourceId)
                    && !source.checksum.equals(currentSourceChecksum)) {
                    throw new IllegalStateException("automatic schedule source checksum conflict");
                }
                if (!ownsPause && !exactTerminalReplay) return;
                AutomaticScheduleContract.Policy policy =
                    automaticPolicyForTurn(turn, currentSemantic);
                next = schedules.finalizeDirectInternal(
                    turn.characterId, "chat", epoch, source, policy, disposition, now);
            } else {
                AutomaticTaskCoordinator.ClaimToken token = automaticClaimTokenFromTurn(turn);
                AutomaticScheduleContract.Policy policy =
                    automaticPolicyForTurn(turn, currentSemantic);
                next = schedules.finalizeAutomatic(
                    turn.characterId, moment ? "moment" : "chat", epoch,
                    token.generation, token.jobId, source, policy, disposition, now);
            }
            result.set(new AutomaticFinalization(
                next.generation > current.generation, previousJobId, next));
        });
        return result.get();
    }

    private AutomaticTaskCoordinator.ClaimToken automaticClaimTokenFromTurn(ChatTurnEntity turn) {
        try {
            JSONObject token = new JSONObject(turn.snapshotJson)
                .getJSONObject("_automaticScheduleAuthority");
            HashMap<String, String> raw = new HashMap<>();
            raw.put("charId", token.getString("characterId"));
            raw.put("kind", token.getString("kind"));
            raw.put("jobId", token.getString("jobId"));
            raw.put("authorityEpoch", token.getString("authorityEpoch"));
            Object generation = token.get("generation");
            if (!(generation instanceof Integer) && !(generation instanceof Long)) {
                throw new IllegalArgumentException("automatic claim generation is invalid");
            }
            raw.put("generation", String.valueOf(((Number) generation).longValue()));
            return AutomaticTaskCoordinator.ClaimToken.from(raw);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("automatic terminal claim conflict", error);
        }
    }

    private AutomaticScheduleContract.TerminalDisposition terminalDispositionForAutomaticSchedule(
        ChatTurnEntity turn
    ) {
        if (TurnState.FAILED_FINAL.name().equals(turn.state)) {
            return AutomaticScheduleContract.TerminalDisposition.FAILED;
        }
        if (!TurnState.COMPLETED.name().equals(turn.state)) return null;
        String value = turn.terminalDisposition;
        if (value == null || value.trim().isEmpty()) {
            value = dao.replyPartCount(turn.turnId) > 0 ? "visible" : "skip";
        }
        switch (value) {
            case "visible": return AutomaticScheduleContract.TerminalDisposition.VISIBLE;
            case "action_only": return AutomaticScheduleContract.TerminalDisposition.ACTION_ONLY;
            case "skip":
                return TurnKind.DIRECT_REPLY.name().equals(turn.kind)
                    ? null : AutomaticScheduleContract.TerminalDisposition.SKIP;
            default: throw new IllegalStateException("automatic terminal disposition conflict");
        }
    }

    private AutomaticScheduleContract.Policy automaticPolicyForTurn(
        ChatTurnEntity turn, JSONObject currentSemantic
    ) {
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            long revision = currentSemantic.getLong("policyRevision");
            String checksum = currentSemantic.getString("policyChecksum");
            String mode = currentSemantic.optString("mode", "");
            if (!("planned".equals(mode) || "dice".equals(mode))) {
                mode = snapshot.optString("automaticPolicyMode", "planned");
            }
            if (snapshot.has("automaticPolicyRevision")
                && snapshot.getLong("automaticPolicyRevision") != revision) {
                throw new IllegalStateException("automatic policy revision conflict");
            }
            if (snapshot.has("automaticPolicyChecksum")
                && !checksum.equals(snapshot.getString("automaticPolicyChecksum"))) {
                throw new IllegalStateException("automatic policy checksum conflict");
            }
            long minDelay = snapshot.getLong("automaticPolicyMinDelayMs");
            long maxDelay = snapshot.getLong("automaticPolicyMaxDelayMs");
            String explicitAt = explicitAutomaticTime(turn);
            return new AutomaticScheduleContract.Policy(
                revision, checksum, mode, minDelay, maxDelay, explicitAt);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("automatic terminal policy conflict", error);
        }
    }

    private String explicitAutomaticTime(ChatTurnEntity turn) {
        for (ReplyPartEntity part : dao.replyParts(turn.turnId)) {
            if (!"SCHEDULE".equals(part.type) || part.payloadJson == null) continue;
            try {
                JSONObject payload = new JSONObject(part.payloadJson);
                Object value = payload.opt("nextProactiveAt");
                long timestamp;
                if (value instanceof Integer || value instanceof Long) {
                    timestamp = ((Number) value).longValue();
                } else if (value instanceof String) {
                    String text = ((String) value).trim();
                    try {
                        timestamp = Long.parseLong(text);
                    } catch (NumberFormatException ignored) {
                        timestamp = Instant.parse(text).toEpochMilli();
                    }
                } else {
                    continue;
                }
                if (timestamp > 0L && timestamp <= 9007199254740991L) {
                    return String.valueOf(timestamp);
                }
            } catch (Exception ignored) {
                // Invalid model scheduling hints are ignored; deterministic policy remains authoritative.
            }
        }
        return null;
    }

    private String automaticTerminalChecksum(
        ChatTurnEntity turn, AutomaticScheduleContract.TerminalDisposition disposition
    ) {
        if (turn.bridgeCommitChecksum != null
            && turn.bridgeCommitChecksum.matches("[a-f0-9]{64}")) {
            return turn.bridgeCommitChecksum;
        }
        try {
            JSONObject basis = new JSONObject()
                .put("completedAt", turn.completedAt == null ? JSONObject.NULL : turn.completedAt)
                .put("disposition", disposition.name().toLowerCase(java.util.Locale.ROOT))
                .put("state", turn.state)
                .put("turnId", turn.turnId)
                .put("updatedAt", turn.updatedAt);
            JSONArray parts = new JSONArray();
            for (ReplyPartEntity part : dao.replyParts(turn.turnId)) {
                parts.put(new JSONObject()
                    .put("content", part.content)
                    .put("payloadJson", part.payloadJson)
                    .put("replyPartId", part.replyPartId)
                    .put("sequence", part.sequence)
                    .put("type", part.type));
            }
            basis.put("parts", parts);
            ExecutionAttemptEntity attempt = turn.activeAttemptId == null
                ? null : dao.attempt(turn.activeAttemptId);
            if (disposition == AutomaticScheduleContract.TerminalDisposition.FAILED) {
                basis.put("failure", attempt == null ? JSONObject.NULL : new JSONObject()
                    .put("errorCode", attempt.errorCode == null ? JSONObject.NULL : attempt.errorCode)
                    .put("errorDetail", attempt.errorDetail == null ? JSONObject.NULL : attempt.errorDetail)
                    .put("finishedAt", attempt.finishedAt == null ? JSONObject.NULL : attempt.finishedAt)
                    .put("retryable", attempt.retryable));
            }
            return BridgeAuthority.sha256CanonicalJson(basis);
        } catch (Exception error) {
            throw new IllegalStateException("automatic terminal checksum conflict", error);
        }
    }

    private static String automaticTerminalSourceId(ChatTurnEntity turn, boolean direct) {
        try {
            String identity = BridgeAuthority.sha256CanonicalJson(
                new JSONObject().put("turnId", turn.turnId));
            return (direct ? "direct-terminal:" : "automatic-terminal:")
                + identity.substring(0, 32);
        } catch (Exception error) {
            throw new IllegalStateException("automatic terminal identity conflict", error);
        }
    }

    private static long automaticTerminalOccurredAt(ChatTurnEntity turn, long fallback) {
        if (turn.completedAt != null && turn.completedAt > 0L) return turn.completedAt;
        if (turn.updatedAt > 0L) return turn.updatedAt;
        return fallback;
    }

    /**
     * Atomically claims a role-plan occurrence and creates its turn/attempt.
     * The tombstone check, unique occurrence insert, turn creation and claim
     * diagnostic all share one Room transaction, so a deletion race cannot
     * leave an orphan occurrence or diagnostic behind.
     */
    public ChatTurnEntity submitRolePlanOccurrence(
        RolePlanOccurrenceEntity occurrence,
        TurnSubmission submission
    ) {
        AtomicReference<ChatTurnEntity> result = new AtomicReference<>();
        try {
            database.runInTransaction(() -> {
                if (occurrence == null || submission == null
                    || occurrence.occurrenceId == null || occurrence.occurrenceId.trim().isEmpty()
                    || occurrence.turnId == null || occurrence.turnId.trim().isEmpty()
                    || occurrence.characterId == null
                    || !occurrence.characterId.equals(submission.characterId)
                    || !occurrence.turnId.equals(submission.turnId)
                    || !occurrence.occurrenceId.equals(submission.sourceMessageId)) {
                    throw new IllegalArgumentException("role plan occurrence/turn identity conflict");
                }
                assertRoleAcceptsSemanticWrite(occurrence.characterId);
                if (dao.rolePlanOccurrence(occurrence.occurrenceId) != null
                    || dao.turn(occurrence.turnId) != null) {
                    result.set(null);
                    return;
                }
                if (dao.insertRolePlanOccurrence(occurrence) == -1L) {
                    result.set(null);
                    return;
                }
                terminalFaultHook.after("role_plan_occurrence_insert");
                ChatTurnEntity turn = submitTurnInTransaction(submission);
                if (turn == null || !occurrence.turnId.equals(turn.turnId)) {
                    throw new IllegalStateException("role plan turn creation conflict");
                }
                terminalFaultHook.after("role_plan_turn_attempt");
                insertDiagnostic(
                    turn.turnId,
                    turn.activeAttemptId,
                    "INFO",
                    "ROLE_PLAN_CLAIMED",
                    "role-plan occurrence claimed",
                    occurrence.updatedAt > 0L ? occurrence.updatedAt : System.currentTimeMillis()
                );
                terminalFaultHook.after("role_plan_diagnostic");
                result.set(turn);
            });
        } catch (RuntimeException error) {
            throw new AtomicRolePlanSubmissionException(
                "ROLE_PLAN_ATOMIC_SUBMISSION_FAILED", error);
        }
        return result.get();
    }

    private ChatTurnEntity submitTurnInTransaction(TurnSubmission submission) {
        if (submission == null || submission.turnId == null || submission.turnId.trim().isEmpty()) {
            throw new IllegalArgumentException("turn submission is required");
        }
        String safeSnapshotJson = snapshotForNewTurn(submission.snapshotJson, submission.characterId);
        ChatTurnEntity existing = dao.turn(submission.turnId);
        if (existing != null) return existing;
        assertRoleAcceptsSemanticWrite(submission.characterId);
        assertManagedAutomaticSubmission(submission);
        long now = submission.createdAt > 0 ? submission.createdAt : System.currentTimeMillis();
        String attemptId = newAttemptId(submission.turnId, 1);
        ChatTurnEntity turn = new ChatTurnEntity();
        turn.turnId = submission.turnId;
        turn.characterId = submission.characterId;
        turn.sourceMessageId = submission.sourceMessageId;
        turn.cloudJobId = submission.cloudJobId;
        turn.kind = submission.kind.name();
        turn.state = TurnState.QUEUED.name();
        turn.activeAttemptId = attemptId;
        turn.inputJson = submission.inputJson;
        turn.snapshotJson = safeSnapshotJson;
        turn.bridgeProtocolVersion = "yuqi".equals(submission.characterId) ? 3 : null;
        turn.createdAt = now;
        turn.updatedAt = now;
        if (dao.insertTurn(turn) == -1L) return dao.turn(submission.turnId);
        dao.insertAttempt(newAttempt(turn.turnId, attemptId, 1, now));
        insertTurnChange(turn.turnId, "TURN_QUEUED", now);
        insertDiagnostic(turn.turnId, attemptId, "INFO", "TURN_QUEUED", turn.kind, now);
        if (TurnKind.DIRECT_REPLY.equals(submission.kind)) {
            pauseAutomaticChatForDirectInput(turn, now);
        }
        return turn;
    }

    private void assertManagedAutomaticSubmission(TurnSubmission submission) {
        String kind;
        if (TurnKind.PROACTIVE_CHAT.equals(submission.kind)) kind = "chat";
        else if (TurnKind.PROACTIVE_MOMENT.equals(submission.kind)) kind = "moment";
        else return;
        AutomaticScheduleAuthorityEntity authority =
            dao.automaticScheduleAuthorityForCharacterKind(submission.characterId, kind);
        if (authority == null) return; // Authority-v0 history remains recoverable until migration.
        try {
            JSONObject tokenJson = new JSONObject(submission.snapshotJson)
                .getJSONObject("_automaticScheduleAuthority");
            HashMap<String, String> raw = new HashMap<>();
            raw.put("charId", tokenJson.getString("characterId"));
            raw.put("kind", tokenJson.getString("kind"));
            raw.put("jobId", tokenJson.getString("jobId"));
            raw.put("authorityEpoch", tokenJson.getString("authorityEpoch"));
            Object generation = tokenJson.get("generation");
            if (!(generation instanceof Integer) && !(generation instanceof Long)) {
                throw new IllegalArgumentException("automatic generation is invalid");
            }
            raw.put("generation", String.valueOf(((Number) generation).longValue()));
            AutomaticTaskCoordinator.ClaimToken token =
                AutomaticTaskCoordinator.ClaimToken.from(raw);
            if (!"claimed".equals(authority.state) || !matchesAutomaticClaim(authority, token)
                || !token.jobId.equals(submission.cloudJobId)
                || !automaticTurnId(token.jobId).equals(submission.turnId)) {
                throw new IllegalStateException("automatic submission authority conflict");
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("automatic submission authority conflict", error);
        }
    }

    private void pauseAutomaticChatForDirectInput(ChatTurnEntity turn, long now) {
        AutomaticScheduleAuthorityEntity current =
            dao.automaticScheduleAuthorityForCharacterKind(turn.characterId, "chat");
        if (current == null || "disabled".equals(current.state)) return;
        try {
            ChatTurnEntity claimedTurn = "claimed".equals(current.state)
                && current.activeJobId != null ? dao.turnForCloudJob(current.activeJobId) : null;
            if ("claimed".equals(current.state)
                && (claimedTurn == null || !turn.characterId.equals(claimedTurn.characterId)
                    || !TurnKind.PROACTIVE_CHAT.name().equals(claimedTurn.kind))) {
                throw new IllegalStateException("automatic claimed turn authority conflict");
            }
            JSONObject semantic = new JSONObject(current.semanticJson);
            String deviceId = semantic.getString("deviceId");
            String epoch = semantic.getString("authorityEpoch");
            long conversationSequence = Math.addExact(current.conversationSequence, 1L);
            if (conversationSequence > 9007199254740991L) {
                throw new IllegalStateException("automatic conversation sequence overflow");
            }
            AutomaticScheduleContract.Source identity = directInputSource(turn);
            AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
                identity.type, identity.id, identity.checksum, conversationSequence, now);
            new AutomaticScheduleStore(database, deviceId).pauseForConversationInternal(
                turn.characterId, "chat", epoch, source, now);
            if (claimedTurn != null && !TurnState.COMPLETED.name().equals(claimedTurn.state)
                && !TurnState.CANCELLED.name().equals(claimedTurn.state)) {
                String claimedAttemptId = claimedTurn.activeAttemptId;
                if (claimedAttemptId != null) dao.cancelAttempt(claimedAttemptId, now);
                dao.cancelTurn(claimedTurn.turnId, now, false);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("automatic direct-input pause conflict", error);
        }
    }

    private static AutomaticScheduleContract.Source directInputSource(ChatTurnEntity turn) {
        try {
            JSONObject basis = new JSONObject()
                .put("characterId", turn.characterId)
                .put("createdAt", turn.createdAt)
                .put("inputJson", turn.inputJson)
                .put("snapshotJson", turn.snapshotJson)
                .put("sourceMessageId", turn.sourceMessageId)
                .put("turnId", turn.turnId);
            String checksum = BridgeAuthority.sha256CanonicalJson(basis);
            return new AutomaticScheduleContract.Source(
                "direct_input", "direct:" + checksum.substring(0, 32), checksum, 0L, turn.createdAt);
        } catch (Exception error) {
            throw new IllegalStateException("automatic direct-input identity conflict", error);
        }
    }

    @Override
    public ExecutionAttemptEntity startRetry(String turnId, long now) {
        return startRetry(turnId, now, null, null);
    }

    @Override
    public ExecutionAttemptEntity startRetry(String turnId, long now, String inputJson, String snapshotJson) {
        AtomicReference<ExecutionAttemptEntity> result = new AtomicReference<>();
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (dao.replyPartCount(turnId) > 0) {
                throw new TurnAlreadyCompletedException(turnId);
            }
            TurnState currentState = TurnState.valueOf(turn.state);
            if (!TurnStateMachine.canStartRetry(currentState)) {
                throw new IllegalStateException("Turn is not retryable while " + currentState);
            }
            assertCurrentRetryAttempt(turn, currentState);
            boolean storeOwnedV3 = isStoreOwnedV3(turn);
            if (storeOwnedV3) {
                List<MemberCheckpoint> members = validateCheckpointSet(
                    turn, dao.attempts(turn.turnId), true);
                if (!members.isEmpty()) {
                    assertLatestPreparedState(turn, members.get(members.size() - 1).checkpoint);
                }
            }
            boolean replacesPayload = inputJson != null || snapshotJson != null;
            if (replacesPayload) {
                if (inputJson == null || inputJson.trim().isEmpty() || snapshotJson == null || snapshotJson.trim().isEmpty()) {
                    throw new IllegalArgumentException("retry inputJson and snapshotJson are both required");
                }
                String replacementSnapshot;
                if (storeOwnedV3) {
                    if (!turn.inputJson.equals(inputJson) || !turn.snapshotJson.equals(snapshotJson)) {
                        throw bridgeAuthorityConflict(turnId);
                    }
                    // Exact v3 retries reuse the already-pinned bytes.  Even an
                    // otherwise harmless UPDATE would change updatedAt and make
                    // the retry depend on caller-owned replacement semantics.
                    replacementSnapshot = null;
                } else {
                    replacementSnapshot = snapshotForLegacyRetry(snapshotJson);
                }
                if (replacementSnapshot != null
                    && dao.replaceRetryPayload(turnId, inputJson, replacementSnapshot, now) != 1) {
                    throw new IllegalStateException("Unable to replace retry payload for " + turnId);
                }
            }
            int sequence = dao.maxAttemptSequence(turnId) + 1;
            String attemptId = newAttemptId(turnId, sequence);
            ExecutionAttemptEntity attempt = newAttempt(turnId, attemptId, sequence, now);
            dao.insertAttempt(attempt);
            if (dao.activateAttempt(turnId, attemptId, now) != 1) {
                throw new IllegalStateException("Unable to activate retry for " + turnId);
            }
            insertTurnChange(turnId, "TURN_RETRIED", now);
            result.set(attempt);
        });
        return result.get();
    }

    @Override
    public ExecutionAttemptEntity activeAttempt(String turnId) {
        ChatTurnEntity turn = requireTurn(turnId);
        return turn.activeAttemptId == null ? null : dao.attempt(turn.activeAttemptId);
    }

    public CanonicalCloudTarget resolveCanonicalCloudTarget(
        String authorityLineageKey,
        String authoritativeTurnId
    ) {
        AtomicReference<CanonicalCloudTarget> resolved = new AtomicReference<>();
        database.runInTransaction(() -> {
            String safeLineage = requireBridgeIdentity(
                authorityLineageKey, "cloud authority lineage");
            String safeRemoteTurn = requireBridgeIdentity(
                authoritativeTurnId, "cloud authoritative turn");
            List<ChatTurnEntity> owners = dao.canonicalBridgeLineageOwners(safeLineage);
            if (owners == null || owners.size() != 1) {
                throw bridgeAuthorityConflict("bridge-cloud-inbox");
            }
            ChatTurnEntity turn = owners.get(0);
            String localTurnId = turn == null ? "bridge-cloud-inbox" : turn.turnId;
            if (turn == null || !isStoreOwnedV3(turn)
                || !safeLineage.equals(turn.authorityLineageKey)
                || turn.activeAttemptId == null) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            assertRoleAcceptsSemanticWrite(turn.characterId);
            List<ExecutionAttemptEntity> attempts = dao.attempts(localTurnId);
            List<MemberCheckpoint> members = validateCheckpointSet(turn, attempts, true);
            int matchingMembers = 0;
            for (MemberCheckpoint member : members) {
                if (safeRemoteTurn.equals(member.checkpoint.optString(
                    "authoritativeTurnId", ""))) matchingMembers += 1;
            }
            ExecutionAttemptEntity active = dao.attempt(turn.activeAttemptId);
            if (matchingMembers != 1 || active == null
                || !localTurnId.equals(active.turnId)
                || active.sequence != dao.maxAttemptSequence(localTurnId)) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            JSONObject activeCheckpoint = validateCheckpoint(turn, active, false);
            assertCanonicalBridgeLifecycle(turn, active, false, activeCheckpoint);
            resolved.set(new CanonicalCloudTarget(localTurnId, active.attemptId));
        });
        if (resolved.get() == null) throw bridgeAuthorityConflict("bridge-cloud-inbox");
        return resolved.get();
    }

    @Override
    public TurnSubmission prepareBridgeSubmission(TurnSubmission base, String bridgeDeviceId, long now) {
        AtomicReference<TurnSubmission> result = new AtomicReference<>();
        database.runInTransaction(() -> result.set(prepareBridgeSubmissionInternal(base, bridgeDeviceId, now)));
        return result.get();
    }

    private TurnSubmission prepareBridgeSubmissionInternal(TurnSubmission base, String bridgeDeviceId, long now) {
        try {
            return prepareBridgeSubmissionCore(base, bridgeDeviceId, now);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(base.turnId);
        }
    }

    private TurnSubmission prepareBridgeSubmissionCore(TurnSubmission base, String bridgeDeviceId, long now)
        throws Exception {
        ChatTurnEntity turn = requireTurn(base.turnId);
        assertRoleAcceptsSemanticWrite(turn.characterId);
        if (!turn.characterId.equals(base.characterId)
            || !turn.sourceMessageId.equals(base.sourceMessageId)
            || !turn.kind.equals(base.kind.name())
            || !turn.inputJson.equals(base.inputJson)
            || !turn.snapshotJson.equals(base.snapshotJson)) {
            throw bridgeAuthorityConflict(base.turnId);
        }
        if (turn.activeAttemptId == null) throw bridgeAuthorityConflict(turn.turnId);
        ExecutionAttemptEntity attempt = dao.attempt(turn.activeAttemptId);
        if (attempt == null || !attempt.turnId.equals(turn.turnId)) throw bridgeAuthorityConflict(turn.turnId);
        List<ExecutionAttemptEntity> allAttempts = dao.attempts(turn.turnId);
        boolean storeOwnedV3 = isStoreOwnedV3(turn);
        List<MemberCheckpoint> members = validateCheckpointSet(turn, allAttempts, storeOwnedV3);
        if (!storeOwnedV3) return base;
        assertCanonicalBridgeLifecycle(turn, attempt, true, null);
        String safeDeviceId = requireBridgeIdentity(bridgeDeviceId, "bridge device id");
        if (attempt.bridgeAuthorityCheckpointJson != null || attempt.bridgeAuthorityCheckpointChecksum != null) {
            JSONObject checkpoint = validateCheckpoint(turn, attempt, true);
            assertLatestPreparedState(turn, checkpoint);
            if (!"open".equals(checkpoint.getJSONObject("outcome").getString("type"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (!safeDeviceId.equals(checkpointEnvelope(checkpoint).optString("deviceId", ""))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return submissionFromCheckpoint(turn, checkpoint);
        }

        JSONObject priorCheckpoint = members.isEmpty() ? null : members.get(members.size() - 1).checkpoint;
        if (priorCheckpoint != null) assertLatestPreparedState(turn, priorCheckpoint);

        if (priorCheckpoint != null && "open".equals(priorCheckpoint.getJSONObject("outcome").optString("type"))) {
            JSONObject envelope = checkpointEnvelope(priorCheckpoint);
            if (!safeDeviceId.equals(envelope.optString("deviceId", ""))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject checkpoint = checkpointFor(
                turn, attempt,
                priorCheckpoint.getString("authoritativeTurnId"),
                priorCheckpoint.getString("authorityLineageKey"),
                priorCheckpoint.getLong("claimedLineageRevision"),
                nullableString(priorCheckpoint, "retryOfTurnId"),
                priorCheckpoint.getString("laneKey"),
                priorCheckpoint.getLong("inputVisibilitySequence"),
                priorCheckpoint.getLong("inputClearEpoch"),
                envelope
            );
            writeCheckpointOrReject(turn, attempt, checkpoint);
            return submissionFromCheckpoint(turn, checkpoint);
        }

        String laneKey = BridgeInput.laneKey(base);
        String rootSourceId = BridgeInput.rootSourceId(base);
        String lineageKey = AuthorityIdentity.lineageKey(turn.characterId, laneKey, rootSourceId);
        String retryOfTurnId = null;
        String authoritativeTurnId;
        long expectedAuthorityRevision;
        long claimedLineageRevision;
        long previousVisibilitySequence = turn.inputVisibilitySequence == null ? 0L : turn.inputVisibilitySequence;
        long previousClearEpoch = turn.inputClearEpoch == null ? 0L : turn.inputClearEpoch;

        ConversationAuthorityEntity authority = dao.conversationAuthority(lineageKey);
        if (priorCheckpoint == null) {
            authoritativeTurnId = BridgeInput.wireTurnId(turn.turnId, TurnKind.valueOf(turn.kind));
            expectedAuthorityRevision = 0L;
            claimedLineageRevision = 1L;
            if (authority != null) throw bridgeAuthorityConflict(turn.turnId);
        } else {
            JSONObject priorOutcome = priorCheckpoint.getJSONObject("outcome");
            if (!"verified_remote_failure".equals(priorOutcome.optString("type"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject failure = BridgeAuthority.validateCanonicalFailureStatus(
                priorOutcome.getJSONObject("failure")
            );
            if (!failure.getBoolean("retryAllowed")
                || !priorCheckpoint.getString("authoritativeTurnId").equals(failure.getString("turnId"))
                || !lineageKey.equals(priorCheckpoint.getString("authorityLineageKey"))
                || !lineageKey.equals(failure.getString("authorityLineageKey"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            retryOfTurnId = priorCheckpoint.getString("authoritativeTurnId");
            authoritativeTurnId = AuthorityIdentity.remoteRetryTurnId(attempt.attemptId);
            expectedAuthorityRevision = failure.getLong("lineageRevision");
            if (expectedAuthorityRevision >= 9007199254740991L) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            claimedLineageRevision = expectedAuthorityRevision + 1L;
            if (authority == null || !"OPEN".equals(authority.state)
                || authority.revision != expectedAuthorityRevision
                || !retryOfTurnId.equals(authority.latestTurnId)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }

        ConversationCursorEntity cursor = cursorFor(turn.characterId, now);
        JSONObject visibilityCursor = visibilityCursorFor(turn, cursor, priorCheckpoint == null);
        long inputVisibilitySequence = cursor.localSequence + 1L;
        if (inputVisibilitySequence <= 0L || inputVisibilitySequence > 9007199254740991L) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        visibilityCursor.put("localSequence", inputVisibilitySequence);
        JSONObject envelope = BridgeInput.prepareV3Envelope(
            base, safeDeviceId, authoritativeTurnId, laneKey, rootSourceId, lineageKey,
            claimedLineageRevision, retryOfTurnId, visibilityCursor
        );

        cursor.localSequence = inputVisibilitySequence;
        cursor.updatedAt = now;
        saveCursor(cursor);
        if (authority == null) {
            authority = new ConversationAuthorityEntity();
            authority.authorityLineageKey = lineageKey;
            authority.characterId = turn.characterId;
            authority.laneKey = laneKey;
            authority.rootSourceId = rootSourceId;
            authority.latestTurnId = authoritativeTurnId;
            authority.revision = claimedLineageRevision;
            authority.state = "OPEN";
            authority.updatedAt = now;
            if (dao.insertConversationAuthority(authority) == -1L) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (dao.pinPreparedBridgeTurn(
                turn.turnId, attempt.attemptId, lineageKey, claimedLineageRevision,
                laneKey, inputVisibilitySequence, cursor.clearEpoch, now
            ) != 1) throw bridgeAuthorityConflict(turn.turnId);
        } else {
            if (dao.compareAndSetConversationAuthority(
                lineageKey, expectedAuthorityRevision, authoritativeTurnId, claimedLineageRevision,
                "OPEN", null, null, null, null, null, now
            ) != 1) throw bridgeAuthorityConflict(turn.turnId);
            if (dao.advancePreparedBridgeTurn(
                turn.turnId, attempt.attemptId, lineageKey, laneKey,
                priorCheckpoint.getLong("claimedLineageRevision"), previousVisibilitySequence,
                previousClearEpoch, claimedLineageRevision, inputVisibilitySequence,
                cursor.clearEpoch, now
            ) != 1) throw bridgeAuthorityConflict(turn.turnId);
        }
        JSONObject checkpoint = checkpointFor(
            turn, attempt, authoritativeTurnId, lineageKey, claimedLineageRevision,
            retryOfTurnId, laneKey, inputVisibilitySequence, cursor.clearEpoch, envelope
        );
        writeCheckpointOrReject(turn, attempt, checkpoint);
        return submissionFromCheckpoint(turn, checkpoint);
    }

    public RetryRecoveryResult recoverDueRetries(long now) {
        int restarted = 0;
        long nextDelaySeconds = -1L;
        Map<String, Long> latestDirectCreatedAtByCharacter = new HashMap<>();
        for (ChatTurnEntity turn : dao.retryableTurns()) {
            if (TurnKind.DIRECT_REPLY.name().equals(turn.kind)) {
                boolean storeOwnedV3 = isStoreOwnedV3(turn);
                Long latestCreatedAt = latestDirectCreatedAtByCharacter.get(turn.characterId);
                if (latestCreatedAt == null) {
                    ChatTurnEntity latest = dao.latestDirectTurn(turn.characterId);
                    latestCreatedAt = latest == null ? turn.createdAt : latest.createdAt;
                    latestDirectCreatedAtByCharacter.put(turn.characterId, latestCreatedAt);
                }
                if (AlBackgroundPolicy.skipOlderDirectRetry(
                    storeOwnedV3, turn.createdAt, latestCreatedAt)) continue;
            }
            if (turn.activeAttemptId == null) continue;
            ExecutionAttemptEntity attempt = dao.attempt(turn.activeAttemptId);
            if (attempt == null || !attempt.retryable) continue;
            long delaySeconds = AlBackgroundPolicy.transientRetryDelaySeconds(attempt.sequence);
            if (delaySeconds < 0L) continue;
            long failedAt = attempt.finishedAt == null ? turn.updatedAt : attempt.finishedAt;
            long dueAt = failedAt + delaySeconds * 1000L;
            if (dueAt <= now) {
                try {
                    startRetry(turn.turnId, now);
                    restarted += 1;
                } catch (IllegalStateException ignored) {
                    // A foreground retry or a late completion won the race.
                }
                continue;
            }
            long remaining = Math.max(1L, (dueAt - now + 999L) / 1000L);
            if (nextDelaySeconds < 0L || remaining < nextDelaySeconds) {
                nextDelaySeconds = remaining;
            }
        }
        return new RetryRecoveryResult(restarted, nextDelaySeconds);
    }

    @Override
    public void markFailed(
        String turnId,
        String attemptId,
        String code,
        String detail,
        boolean retryable,
        long now
    ) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (!attemptId.equals(turn.activeAttemptId)
                || TurnState.COMPLETED.name().equals(turn.state)
                || dao.replyPartCount(turnId) > 0) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            ExecutionAttemptEntity failedAttempt = dao.attempt(attemptId);
            boolean effectiveRetryable = retryable
                && failedAttempt != null
                && AlBackgroundPolicy.transientRetryDelaySeconds(failedAttempt.sequence) >= 0L;
            String state = effectiveRetryable
                ? TurnState.FAILED_RETRYABLE.name()
                : TurnState.FAILED_FINAL.name();
            if (dao.markTurnFailed(turnId, attemptId, state, now) != 1) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            if (dao.markAttemptFailed(attemptId, state, code, detail, effectiveRetryable, now) != 1) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            insertTurnChange(turnId, "TURN_FAILED", now);
            String diagnosticCode = retryable && !effectiveRetryable ? "TURN_RETRY_EXHAUSTED" : "TURN_FAILED";
            insertDiagnostic(turnId, attemptId, "ERROR", diagnosticCode, code + ": " + detail, now);
        });
    }

    @Override
    public void commitReply(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        long now
    ) {
        if (parts == null || parts.isEmpty()) {
            throw new IllegalArgumentException("reply parts are required");
        }
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (!attemptId.equals(turn.activeAttemptId)) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            if (turn.inputVisibilitySequence != null
                && classifyIncomingGroup(turn.characterId, groupId(turn), turn.inputVisibilitySequence)
                    == DeliveryDisposition.REDACTED) {
                throw new IllegalStateException("LATE_RESULT_REDACTED: " + turnId);
            }
            assertRoleAcceptsSemanticWrite(turn.characterId);
            dao.commitReply(turnId, attemptId, parts, now);
            markNativeCompletedInternal(
                turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
        });
    }

    @Override
    public void commitSkip(String turnId, String attemptId, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (!attemptId.equals(turn.activeAttemptId)) throw new StaleAttemptException(turnId, attemptId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            dao.commitSkip(turnId, attemptId, now);
            markNativeCompletedInternal(
                turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
        });
    }

    @Override
    public DeliveryDisposition commitAndroidFallback(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        String terminalDisposition,
        long now
    ) {
        AtomicReference<DeliveryDisposition> disposition = new AtomicReference<>();
        database.runInTransaction(() -> disposition.set(commitAndroidFallbackInternal(
            turnId, attemptId, parts, terminalDisposition, now)));
        return disposition.get();
    }

    private DeliveryDisposition commitAndroidFallbackInternal(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        String terminalDisposition,
        long now
    ) {
        try {
            if (now <= 0L || now > 9007199254740991L
                || !("visible".equals(terminalDisposition)
                    || "action_only".equals(terminalDisposition)
                    || "skip".equals(terminalDisposition))) {
                throw bridgeAuthorityConflict(turnId);
            }
            List<ReplyPartEntity> suppliedParts = parts == null
                ? java.util.Collections.emptyList() : parts;
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (!isStoreOwnedV3(turn) || !attemptId.equals(turn.activeAttemptId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            ExecutionAttemptEntity attempt = dao.attempt(attemptId);
            if (attempt == null || !turnId.equals(attempt.turnId)
                || attempt.sequence != dao.maxAttemptSequence(turnId)) {
                throw bridgeAuthorityConflict(turnId);
            }

            JSONObject storedCheckpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
            Object rawVersion = storedCheckpoint.opt("version");
            if (rawVersion instanceof Number && !(rawVersion instanceof Float)
                && !(rawVersion instanceof Double) && ((Number) rawVersion).longValue() == 2L) {
                return validateExactLocalFallbackReplay(
                    turn, attempt, storedCheckpoint, suppliedParts, terminalDisposition);
            }

            validateCheckpointSet(turn, dao.attempts(turnId), true);
            JSONObject checkpoint = validateCheckpoint(turn, attempt, false);
            assertCanonicalBridgeLifecycle(turn, attempt, false, checkpoint);
            if (!"open".equals(checkpoint.getJSONObject("outcome").getString("type"))) {
                throw bridgeAuthorityConflict(turnId);
            }
            assertLatestPreparedState(turn, checkpoint);

            boolean direct = TurnKind.DIRECT_REPLY.name().equals(turn.kind);
            if (direct && "skip".equals(terminalDisposition)) throw bridgeAuthorityConflict(turnId);
            if ("skip".equals(terminalDisposition) && !suppliedParts.isEmpty()) {
                throw bridgeAuthorityConflict(turnId);
            }
            if (!"skip".equals(terminalDisposition) && suppliedParts.isEmpty()) {
                throw bridgeAuthorityConflict(turnId);
            }

            JSONObject envelope = checkpointEnvelope(checkpoint);
            FallbackCognitionPacketCodec.FallbackContext fallback =
                new FallbackCognitionPacketCodec().decode(new JSONObject(turn.snapshotJson));
            if (!"cognition-v3".equals(fallback.contract) || fallback.fallbackExecution == null
                || !fallback.deviceId.equals(envelope.getString("deviceId"))) {
                throw bridgeAuthorityConflict(turnId);
            }
            ConversationCursorEntity cursor = dao.conversationCursor(turn.characterId);
            if (cursor == null || checkpoint.getLong("inputClearEpoch") > cursor.clearEpoch) {
                throw bridgeAuthorityConflict(turnId);
            }
            boolean redacted = checkpoint.getLong("inputClearEpoch") < cursor.clearEpoch
                || checkpoint.getLong("inputVisibilitySequence") <= cursor.clearedThroughSequence;
            if (redacted) {
                return commitRedactedAndroidFallback(
                    turn, attempt, checkpoint, terminalDisposition, now);
            }

            String lineageKey = checkpoint.getString("authorityLineageKey");
            String visibleGroupId = AuthorityIdentity.groupId(lineageKey);
            List<ReplyPartEntity> committedParts = buildLocalFallbackParts(
                turn, attempt, suppliedParts, visibleGroupId, terminalDisposition, now);
            long journalSyncSeq = dao.allocateJournalSyncSeq(now);
            if (journalSyncSeq <= 0L || journalSyncSeq > 9007199254740991L) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_LOCAL_JOURNAL);
            JSONObject receipt = localFallbackReceipt(
                turn, attempt, checkpoint, fallback, committedParts,
                terminalDisposition, visibleGroupId, journalSyncSeq, now);
            JSONObject nextCheckpoint = new JSONObject(checkpoint.toString())
                .put("version", 2)
                .put("fallbackExecution", new JSONObject(
                    new JSONObject(turn.snapshotJson).getJSONObject("fallbackExecution").toString()))
                .put("journalSyncSeq", journalSyncSeq)
                .put("outcome", new JSONObject()
                    .put("type", "committed")
                    .put("route", "local")
                    .put("relayMessageId", JSONObject.NULL)
                    .put("failure", JSONObject.NULL)
                    .put("result", receipt)
                    .put("redactedAt", JSONObject.NULL));
            String nextJson = BridgeAuthority.canonicalJson(nextCheckpoint);
            String nextChecksum = BridgeAuthority.sha256CanonicalJson(nextCheckpoint);
            if (dao.compareAndSetBridgeAuthorityCheckpoint(
                attemptId, turnId,
                attempt.bridgeAuthorityCheckpointJson,
                attempt.bridgeAuthorityCheckpointChecksum,
                nextJson,
                nextChecksum
            ) != 1) throw bridgeAuthorityConflict(turnId);
            terminalFaultHook.after(FAULT_CHECKPOINT);

            if (!committedParts.isEmpty()) {
                dao.insertReplyParts(committedParts);
                terminalFaultHook.after(FAULT_REPLY_PARTS);
            }

            JSONObject semantic = receipt.getJSONObject("semantic");
            JSONObject release = semantic.getJSONObject("release");
            long committedLineageRevision = checkpoint.getLong("claimedLineageRevision") + 1L;
            if (committedLineageRevision > 9007199254740991L) {
                throw bridgeAuthorityConflict(turnId);
            }
            ConversationAuthorityEntity authority = dao.conversationAuthority(lineageKey);
            if (authority == null || !"OPEN".equals(authority.state)
                || !checkpoint.getString("authoritativeTurnId").equals(authority.latestTurnId)
                || checkpoint.getLong("claimedLineageRevision") != authority.revision
                || dao.compareAndSetConversationAuthority(
                    lineageKey,
                    authority.revision,
                    authority.latestTurnId,
                    committedLineageRevision,
                    "COMMITTED",
                    visibleGroupId,
                    receipt.getString("commitChecksum"),
                    "android-fallback-commit-v2",
                    "android_fallback",
                    terminalDisposition,
                    now
                ) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_AUTHORITY);

            Long uiAppliedAt = "skip".equals(terminalDisposition) ? now : null;
            if (dao.finalizeCanonicalBridgeTurn(
                turnId, attemptId, visibleGroupId, lineageKey,
                "android_fallback", "android-fallback-commit-v2",
                checkpoint.getLong("claimedLineageRevision"), attempt.sequence,
                checkpoint.getString("laneKey"), attempt.sequence,
                semantic.getString("agencySnapshotChecksum"),
                release.getString("releaseId"),
                checkpoint.getLong("inputVisibilitySequence"),
                checkpoint.getLong("inputClearEpoch"),
                receipt.getString("commitChecksum"),
                terminalDisposition,
                checkpoint.getLong("claimedLineageRevision"),
                checkpoint.getLong("inputVisibilitySequence"),
                checkpoint.getLong("inputClearEpoch"),
                null, uiAppliedAt, now
            ) != 1) throw bridgeAuthorityConflict(turnId);
            terminalFaultHook.after(FAULT_TURN);
            if (dao.finalizeCanonicalBridgeAttempt(attemptId, turnId, now) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_ATTEMPT);

            applyLocalFallbackCursor(
                cursor, turnId, visibleGroupId,
                checkpoint.getLong("inputVisibilitySequence"),
                "skip".equals(terminalDisposition), now);
            insertLocalFallbackChange(turnId, lineageKey, visibleGroupId, terminalDisposition, now);
            terminalFaultHook.after(FAULT_CHANGE);
            return DeliveryDisposition.APPLY;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    private DeliveryDisposition commitRedactedAndroidFallback(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        String draftDisposition,
        long now
    ) throws Exception {
        JSONObject metadata = new JSONObject()
            .put("contract", "android-fallback-redacted-v1")
            .put("authorityLineageKey", checkpoint.getString("authorityLineageKey"))
            .put("authoritativeTurnId", checkpoint.getString("authoritativeTurnId"))
            .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
            .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
            .put("draftDisposition", draftDisposition);
        JSONObject nextCheckpoint = new JSONObject(checkpoint.toString())
            .put("version", 2)
            .put("fallbackExecution", new JSONObject(
                new JSONObject(turn.snapshotJson).getJSONObject("fallbackExecution").toString()))
            .put("journalSyncSeq", 0L)
            .put("outcome", new JSONObject()
                .put("type", "redacted")
                .put("route", "local")
                .put("relayMessageId", JSONObject.NULL)
                .put("failure", JSONObject.NULL)
                .put("result", metadata)
                .put("redactedAt", now));
        String nextJson = BridgeAuthority.canonicalJson(nextCheckpoint);
        String nextChecksum = BridgeAuthority.sha256CanonicalJson(nextCheckpoint);
        if (dao.compareAndSetBridgeAuthorityCheckpoint(
            attempt.attemptId, turn.turnId,
            attempt.bridgeAuthorityCheckpointJson,
            attempt.bridgeAuthorityCheckpointChecksum,
            nextJson,
            nextChecksum
        ) != 1) throw bridgeAuthorityConflict(turn.turnId);
        terminalFaultHook.after(FAULT_CHECKPOINT);

        ConversationAuthorityEntity authority = dao.conversationAuthority(
            checkpoint.getString("authorityLineageKey"));
        long nextRevision = checkpoint.getLong("claimedLineageRevision") + 1L;
        if (authority == null || nextRevision > 9007199254740991L
            || !"OPEN".equals(authority.state)
            || !checkpoint.getString("authoritativeTurnId").equals(authority.latestTurnId)
            || authority.revision != checkpoint.getLong("claimedLineageRevision")
            || dao.compareAndSetConversationAuthority(
                checkpoint.getString("authorityLineageKey"),
                authority.revision,
                authority.latestTurnId,
                nextRevision,
                "CANCELLED",
                null,
                null,
                null,
                null,
                null,
                now
            ) != 1) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        terminalFaultHook.after(FAULT_AUTHORITY);
        if (dao.finalizeLocalFallbackRedactedTurn(
            turn.turnId, attempt.attemptId, now) != 1) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        terminalFaultHook.after(FAULT_TURN);
        if (dao.finalizeCanonicalBridgeAttempt(
            attempt.attemptId, turn.turnId, now) != 1) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        terminalFaultHook.after(FAULT_ATTEMPT);
        insertLocalFallbackRedactedChange(
            turn.turnId, checkpoint.getString("authorityLineageKey"), now);
        terminalFaultHook.after(FAULT_CHANGE);
        return DeliveryDisposition.REDACTED;
    }

    @Override
    public DeliveryDisposition commitBridgedTerminal(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now
    ) {
        AtomicReference<DeliveryDisposition> disposition = new AtomicReference<>();
        database.runInTransaction(() -> disposition.set(
            commitBridgedTerminalInternal(turnId, attemptId, result, now)));
        observeTestDeliveryDisposition(disposition.get());
        return disposition.get();
    }

    @Override
    public DeliveryDisposition commitBridgedTerminalWithPeer(
        String turnId,
        String attemptId,
        BridgeResult result,
        String authenticatedPeerId,
        long now
    ) {
        AtomicReference<DeliveryDisposition> disposition = new AtomicReference<>();
        database.runInTransaction(() -> {
            if (tryConsumeLateRoleDeleteResult(
                turnId, result, authenticatedPeerId, BridgeResult.Kind.CANONICAL_TERMINAL)) {
                disposition.set(DeliveryDisposition.REDACTED);
                return;
            }
            disposition.set(commitBridgedTerminalInternal(
                turnId, attemptId, result, now, authenticatedPeerId));
        });
        observeTestDeliveryDisposition(disposition.get());
        return disposition.get();
    }

    private DeliveryDisposition commitBridgedTerminalInternal(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now
    ) {
        return commitBridgedTerminalInternal(turnId, attemptId, result, now, null);
    }

    private DeliveryDisposition commitBridgedTerminalInternal(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now,
        String authenticatedPeerId
    ) {
        try {
            if (result == null || result.kind != BridgeResult.Kind.CANONICAL_TERMINAL
                || now <= 0L || now > 9007199254740991L) {
                throw bridgeAuthorityConflict(turnId);
            }
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (!attemptId.equals(turn.activeAttemptId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            ExecutionAttemptEntity activeAttempt = dao.attempt(attemptId);
            boolean clearTombstoneReplay = isConversationClearTombstoneReplay(turn, activeAttempt);
            if (!clearTombstoneReplay && !isStoreOwnedV3(turn)) {
                throw bridgeAuthorityConflict(turnId);
            }
            if (activeAttempt == null || !turnId.equals(activeAttempt.turnId)
                || activeAttempt.sequence != dao.maxAttemptSequence(turnId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            List<ExecutionAttemptEntity> attempts = dao.attempts(turnId);
            validateCheckpointSet(turn, attempts, true);
            JSONObject activeCheckpoint = validateCheckpoint(turn, activeAttempt, false);
            assertCanonicalBridgeLifecycle(turn, activeAttempt, false, activeCheckpoint);
            MemberCheckpoint receiptMember = uniqueReceiptMember(
                turn, attempts, result.authoritativeTurnId);
            validateCanonicalTerminalResult(turn, activeCheckpoint, receiptMember.checkpoint, result);

            JSONObject activeOutcome = activeCheckpoint.getJSONObject("outcome");
            String activeOutcomeType = activeOutcome.getString("type");
            if ("redacted".equals(activeOutcomeType)
                && "conversation-clear-redacted-v1".equals(
                    activeOutcome.optJSONObject("result") == null
                        ? null : activeOutcome.optJSONObject("result").optString("contract"))) {
                // A canonical result that was already in flight when a
                // conversation clear won is a validated tombstone replay. It
                // must be consumed without resurrecting COMMITTED authority,
                // semantic parts, raw messages, diagnostics, or cursor state.
                validateConversationClearTombstone(
                    turn, activeAttempt, activeCheckpoint, activeOutcome, false, true);
                assertAuthenticatedPeerMatchesClearControl(
                    authenticatedPeerId, activeOutcome, turnId);
                return DeliveryDisposition.REDACTED;
            }
            assertAuthenticatedPeerMatchesCheckpoint(authenticatedPeerId, activeCheckpoint, turnId);
            if ("committed".equals(activeOutcomeType) || "redacted".equals(activeOutcomeType)
                || TurnState.COMPLETED.name().equals(turn.state)) {
                return validateExactCanonicalTerminalReplay(
                    turn, activeAttempt, activeCheckpoint, result);
            }
            if (!"open".equals(activeOutcomeType)) throw bridgeAuthorityConflict(turnId);
            assertLatestPreparedState(turn, activeCheckpoint);

            ConversationCursorEntity cursor = dao.conversationCursor(turn.characterId);
            if (cursor == null || result.inputClearEpoch > cursor.clearEpoch) {
                throw bridgeAuthorityConflict(turnId);
            }
            boolean redacted = result.inputClearEpoch < cursor.clearEpoch
                || result.inputVisibilitySequence <= cursor.clearedThroughSequence;
            DeliveryDisposition deliveryDisposition = redacted
                ? DeliveryDisposition.REDACTED
                : DeliveryDisposition.APPLY;

            List<ReplyPartEntity> replyParts = redacted
                ? java.util.Collections.emptyList()
                : buildCanonicalReplyParts(turn, activeAttempt, result, now);
            List<RawMessageEntity> rawMessages = redacted
                ? java.util.Collections.emptyList()
                : buildCanonicalRawMessages(turn, receiptMember.checkpoint, result);
            assertCanonicalProjectionIsWritable(turn, result, replyParts, rawMessages);

            JSONObject outcome = terminalOutcome(result, redacted, now);
            String nextCheckpointJson = checkpointWithOutcomeJson(activeCheckpoint, outcome);
            String nextCheckpointChecksum = BridgeAuthority.sha256CanonicalJson(
                new JSONObject(nextCheckpointJson));
            if (dao.compareAndSetBridgeAuthorityCheckpoint(
                attemptId, turnId,
                activeAttempt.bridgeAuthorityCheckpointJson,
                activeAttempt.bridgeAuthorityCheckpointChecksum,
                nextCheckpointJson,
                nextCheckpointChecksum
            ) != 1) throw bridgeAuthorityConflict(turnId);
            terminalFaultHook.after(FAULT_CHECKPOINT);

            if (!replyParts.isEmpty()) {
                dao.insertReplyParts(replyParts);
                terminalFaultHook.after(FAULT_REPLY_PARTS);
            }
            for (RawMessageEntity message : rawMessages) {
                if (dao.insertRawMessage(message) == -1L) throw bridgeAuthorityConflict(turnId);
            }
            if (!rawMessages.isEmpty()) terminalFaultHook.after(FAULT_RAW_MESSAGES);

            ConversationAuthorityEntity authority = dao.conversationAuthority(result.authorityLineageKey);
            if (authority == null || !"OPEN".equals(authority.state)
                || !turn.characterId.equals(authority.characterId)
                || !result.laneKey.equals(authority.laneKey)
                || !activeCheckpoint.getString("authoritativeTurnId").equals(authority.latestTurnId)
                || activeCheckpoint.getLong("claimedLineageRevision") != authority.revision
                || dao.compareAndSetConversationAuthority(
                    result.authorityLineageKey,
                    authority.revision,
                    result.authoritativeTurnId,
                    result.lineageRevision,
                    "COMMITTED",
                    result.visibleGroupId,
                    result.commitChecksum,
                    result.commitPayloadVersion,
                    result.authorityOrigin,
                    result.terminalDisposition,
                    now
                ) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_AUTHORITY);

            Long deletedAt = redacted ? now : null;
            Long uiAppliedAt = !redacted && "skip".equals(result.terminalDisposition) ? now : null;
            if (dao.finalizeCanonicalBridgeTurn(
                turnId, attemptId, result.visibleGroupId, result.authorityLineageKey,
                result.authorityOrigin, result.commitPayloadVersion, result.lineageRevision,
                result.turnRevision, result.laneKey, result.laneRevision,
                result.generationFingerprint, result.releaseId,
                result.inputVisibilitySequence, result.inputClearEpoch,
                result.commitChecksum, result.terminalDisposition,
                activeCheckpoint.getLong("claimedLineageRevision"),
                activeCheckpoint.getLong("inputVisibilitySequence"),
                activeCheckpoint.getLong("inputClearEpoch"),
                deletedAt, uiAppliedAt, now
            ) != 1) throw bridgeAuthorityConflict(turnId);
            terminalFaultHook.after(FAULT_TURN);
            if (dao.finalizeCanonicalBridgeAttempt(attemptId, turnId, now) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_ATTEMPT);

            if (!redacted) {
                applyCanonicalCursor(cursor, turnId, result, "skip".equals(result.terminalDisposition), now);
            }
            insertCanonicalTerminalChange(turnId, result, redacted, now);
            terminalFaultHook.after(FAULT_CHANGE);
            return deliveryDisposition;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    @Override
    public void commitVerifiedRemoteFailure(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now
    ) {
        database.runInTransaction(() -> commitVerifiedRemoteFailureInternal(
            turnId, attemptId, result, now));
        observeTestDeliveryDisposition(DeliveryDisposition.APPLY);
    }

    @Override
    public void commitVerifiedRemoteFailureWithPeer(
        String turnId,
        String attemptId,
        BridgeResult result,
        String authenticatedPeerId,
        long now
    ) {
        AtomicReference<DeliveryDisposition> disposition = new AtomicReference<>();
        database.runInTransaction(() -> {
            if (tryConsumeLateRoleDeleteResult(
                turnId, result, authenticatedPeerId, BridgeResult.Kind.VERIFIED_REMOTE_FAILURE)) {
                disposition.set(DeliveryDisposition.REDACTED);
                return;
            }
            commitVerifiedRemoteFailureInternal(
                turnId, attemptId, result, now, authenticatedPeerId);
            disposition.set(DeliveryDisposition.APPLY);
        });
        observeTestDeliveryDisposition(disposition.get());
    }

    /**
     * A v3 LAN result can arrive after role deletion has durably removed its
     * turn.  Only the authenticated, store-owned peer and the retained
     * role-delete control authorize this zero-write terminal outcome.  This is
     * deliberately shared by canonical terminals and verified failures; all
     * other routes/kinds continue through the ordinary turn-bound validators.
     */
    private boolean tryConsumeLateRoleDeleteResult(
        String turnId,
        BridgeResult result,
        String authenticatedPeerId,
        BridgeResult.Kind expectedKind
    ) {
        if (dao.turn(turnId) != null) return false;
        if (result == null || result.kind != expectedKind || result.protocolVersion != 3
            || !"lan".equals(result.origin) || result.deliveryRoute == null
            || !"lan".equals(result.deliveryRoute) || result.relayMessageId != null
            || result.roleId == null || result.roleId.trim().isEmpty()
            || authenticatedPeerId == null || authenticatedPeerId.trim().isEmpty()) {
            throw bridgeAuthorityConflict(turnId);
        }
        LifecycleControl control = roleDeleteControl(result.roleId);
        if (control == null || !LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind)
            || !authenticatedPeerId.equals(control.peerId)) {
            throw bridgeAuthorityConflict(turnId);
        }
        return true;
    }

    /**
     * Peer-aware LAN entry points must bind the authenticated transport peer to
     * the device identity frozen in the validated checkpoint before any
     * ordinary terminal/failure mutation is attempted.  The legacy overloads
     * pass null and intentionally retain their historical behavior.
     */
    private static void assertAuthenticatedPeerMatchesCheckpoint(
        String authenticatedPeerId,
        JSONObject checkpoint,
        String turnId
    ) {
        if (authenticatedPeerId == null) return;
        try {
            String checkpointPeer = requireNativeNonEmptyString(
                checkpointEnvelope(checkpoint), "deviceId", turnId);
            if (!authenticatedPeerId.equals(checkpointPeer)) {
                throw bridgeAuthorityConflict(turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    private void assertAuthenticatedPeerMatchesClearControl(
        String authenticatedPeerId,
        JSONObject outcome,
        String turnId
    ) {
        if (authenticatedPeerId == null) return;
        try {
            JSONObject result = outcome.getJSONObject("result");
            LifecycleControlEntity control = dao.lifecycleControl(result.getString("controlId"));
            if (control == null || !LifecycleControl.CLEAR_KIND.equals(control.controlKind)
                || !authenticatedPeerId.equals(control.peerId)) {
                throw bridgeAuthorityConflict(turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    private void commitVerifiedRemoteFailureInternal(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now
    ) {
        commitVerifiedRemoteFailureInternal(turnId, attemptId, result, now, null);
    }

    private void commitVerifiedRemoteFailureInternal(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now,
        String authenticatedPeerId
    ) {
        try {
            if (result == null || result.kind != BridgeResult.Kind.VERIFIED_REMOTE_FAILURE
                || now <= 0L || now > 9007199254740991L) {
                throw bridgeAuthorityConflict(turnId);
            }
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            ExecutionAttemptEntity attempt = dao.attempt(attemptId);
            boolean clearTombstoneReplay = isConversationClearTombstoneReplay(turn, attempt);
            if ((!clearTombstoneReplay && !isStoreOwnedV3(turn))
                || !attemptId.equals(turn.activeAttemptId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            if (attempt == null || !turnId.equals(attempt.turnId)
                || attempt.sequence != dao.maxAttemptSequence(turnId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            List<ExecutionAttemptEntity> attempts = dao.attempts(turnId);
            validateCheckpointSet(turn, attempts, true);
            JSONObject checkpoint = validateCheckpoint(turn, attempt, false);
            assertCanonicalBridgeLifecycle(turn, attempt, false, checkpoint);
            JSONObject currentOutcome = checkpoint.getJSONObject("outcome");
            if (clearTombstoneReplay
                && "redacted".equals(currentOutcome.optString("type"))
                && "conversation-clear-redacted-v1".equals(
                    currentOutcome.optJSONObject("result") == null
                        ? null : currentOutcome.optJSONObject("result").optString("contract"))) {
                validateCanonicalFailureResult(turn, checkpoint, result);
                validateConversationClearTombstone(
                    turn, attempt, checkpoint, currentOutcome, false, true);
                assertAuthenticatedPeerMatchesClearControl(
                    authenticatedPeerId, currentOutcome, turnId);
                return;
            }
            assertAuthenticatedPeerMatchesCheckpoint(authenticatedPeerId, checkpoint, turnId);
            validateCanonicalFailureResult(turn, checkpoint, result);
            if ("verified_remote_failure".equals(currentOutcome.getString("type"))) {
                if (!BridgeAuthority.canonicalJson(currentOutcome.getJSONObject("failure"))
                    .equals(BridgeAuthority.canonicalJson(result.authorityPayload()))
                    || !result.deliveryRoute.equals(currentOutcome.getString("route"))
                    || !sameNullable(result.relayMessageId,
                        nullableString(currentOutcome, "relayMessageId"))
                    || !currentOutcome.isNull("result")
                    || !currentOutcome.isNull("redactedAt")) {
                    throw bridgeAuthorityConflict(turnId);
                }
                String expectedState = result.retryAllowed
                    ? TurnState.FAILED_RETRYABLE.name()
                    : TurnState.FAILED_FINAL.name();
                if (!expectedState.equals(turn.state) || !expectedState.equals(attempt.state)) {
                    throw bridgeAuthorityConflict(turnId);
                }
                return;
            }
            if (!"open".equals(currentOutcome.getString("type"))) {
                throw bridgeAuthorityConflict(turnId);
            }
            assertLatestPreparedState(turn, checkpoint);
            JSONObject outcome = new JSONObject()
                .put("type", "verified_remote_failure")
                .put("route", result.deliveryRoute)
                .put("relayMessageId", result.relayMessageId == null ? JSONObject.NULL : result.relayMessageId)
                .put("failure", result.authorityPayload())
                .put("result", JSONObject.NULL)
                .put("redactedAt", JSONObject.NULL);
            String nextJson = checkpointWithOutcomeJson(checkpoint, outcome);
            String nextChecksum = BridgeAuthority.sha256CanonicalJson(new JSONObject(nextJson));
            if (dao.compareAndSetBridgeAuthorityCheckpoint(
                attemptId, turnId, attempt.bridgeAuthorityCheckpointJson,
                attempt.bridgeAuthorityCheckpointChecksum, nextJson, nextChecksum
            ) != 1) throw bridgeAuthorityConflict(turnId);
            terminalFaultHook.after(FAULT_FAILURE_CHECKPOINT);
            String state = result.retryAllowed
                ? TurnState.FAILED_RETRYABLE.name()
                : TurnState.FAILED_FINAL.name();
            if (dao.finalizeCanonicalBridgeFailureTurn(turnId, attemptId, state, now) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_FAILURE_TURN);
            if (dao.finalizeCanonicalBridgeFailureAttempt(
                attemptId, turnId, state, result.errorCode, result.retryAllowed, now) != 1) {
                throw bridgeAuthorityConflict(turnId);
            }
            terminalFaultHook.after(FAULT_FAILURE_ATTEMPT);
            insertCanonicalFailureChange(turnId, result, now);
            terminalFaultHook.after(FAULT_FAILURE_CHANGE);
            insertCanonicalFailureDiagnostic(turnId, attemptId, result, now);
            terminalFaultHook.after(FAULT_FAILURE_DIAGNOSTIC);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    @Override
    public void cancelTurn(String turnId, long now, boolean deleted) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (dao.replyPartCount(turnId) > 0 || TurnState.COMPLETED.name().equals(turn.state)) {
                throw new TurnAlreadyCompletedException(turnId);
            }
            String attemptId = turn.activeAttemptId;
            if (dao.cancelTurn(turnId, now, deleted) != 1) {
                throw new IllegalStateException("Unable to cancel turn " + turnId);
            }
            if (attemptId != null) dao.cancelAttempt(attemptId, now);
            insertTurnChange(turnId, deleted ? "TURN_DELETED" : "TURN_CANCELLED", now);
        });
    }

    public AutomaticTaskCleanupResult clearAutomaticTasks(long now) {
        int[] counts = new int[4];
        database.runInTransaction(() -> {
            counts[1] = dao.cancelAutomaticAttempts(now);
            counts[0] = dao.cancelAutomaticTurns(now);
            counts[2] = dao.acknowledgeCompletedAutomaticTurns(now);
            counts[3] = dao.deleteProactiveSnapshots();
        });
        return new AutomaticTaskCleanupResult(counts[0], counts[1], counts[2], counts[3]);
    }

    @Override
    public ChatTurnEntity turn(String turnId) {
        return dao.turn(turnId);
    }

    @Override
    public List<ReplyPartEntity> replyParts(String turnId) {
        return dao.replyParts(turnId);
    }

    @Override
    public TurnState displayState(String turnId) {
        ChatTurnEntity turn = requireTurn(turnId);
        TurnState stored = TurnState.valueOf(turn.state);
        return TurnStateMachine.deriveDisplayState(dao.replyPartCount(turnId) > 0, stored);
    }

    @Override
    public List<ChangeEventEntity> changesAfter(long cursor, int limit) {
        return dao.changesAfter(cursor, Math.max(1, Math.min(limit, 500)));
    }

    public List<DiagnosticEntity> latestDiagnostics(int limit) {
        return dao.latestDiagnostics(Math.max(1, Math.min(limit, 500)));
    }

    public DiagnosticEntity latestBridgeStatus(String turnId) {
        return dao.latestBridgeStatus(turnId);
    }

    public void recordDiagnostic(
        String turnId,
        String attemptId,
        String level,
        String code,
        String detail,
        long now
    ) {
        insertDiagnostic(turnId, attemptId, level, code, detail, now);
    }

    /**
     * Persist a bridge status only while its live turn and role authority still
     * exist. A late LAN response after role deletion is transport evidence, not
     * a semantic diagnostic, and must be suppressed in the same Room boundary.
     */
    public boolean recordBridgeStatusIfActive(String turnId, String detail, long now) {
        AtomicReference<Boolean> inserted = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            ChatTurnEntity turn = dao.turn(turnId);
            if (turn == null || isRoleDeleteTombstoned(turn.characterId)) return;
            ExecutionAttemptEntity attempt = turn.activeAttemptId == null
                ? null : dao.attempt(turn.activeAttemptId);
            if (isConversationClearTombstoneReplay(turn, attempt)) return;
            insertDiagnostic(turnId, turn.activeAttemptId, "INFO", "BRIDGE_STATUS", detail, now);
            inserted.set(true);
        });
        return Boolean.TRUE.equals(inserted.get());
    }

    /**
     * Inserts the two dispatch diagnostics only if the role-delete tombstone
     * is still absent.  The check and both inserts share one Room transaction;
     * a later role-delete transaction removes the rows as part of its normal
     * cleanup, so a deletion race cannot leave an orphan dispatch diagnostic.
     */
    public boolean recordRoleDispatchDiagnosticsIfActive(
        String turnId,
        String characterId,
        String attemptId,
        long now,
        String firstCode,
        String firstDetail,
        String secondCode,
        String secondDetail
    ) {
        AtomicReference<Boolean> inserted = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            if (isRoleDeleteTombstoned(characterId)) return;
            ChatTurnEntity turn = dao.turn(turnId);
            if (turn == null || !Objects.equals(turn.characterId, characterId)) return;
            insertDiagnostic(turnId, attemptId, "INFO", firstCode, firstDetail, now);
            insertDiagnostic(turnId, attemptId, "INFO", secondCode, secondDetail, now);
            inserted.set(true);
        });
        return Boolean.TRUE.equals(inserted.get());
    }

    public boolean recordRoleDiagnosticIfActive(
        String turnId,
        String characterId,
        String attemptId,
        String level,
        String code,
        String detail,
        long now
    ) {
        AtomicReference<Boolean> inserted = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            if (isRoleDeleteTombstoned(characterId)) return;
            ChatTurnEntity turn = dao.turn(turnId);
            if (turn == null || !Objects.equals(turn.characterId, characterId)) return;
            insertDiagnostic(turnId, attemptId, level, code, detail, now);
            inserted.set(true);
        });
        return Boolean.TRUE.equals(inserted.get());
    }

    /** Role-scoped preflight diagnostic for a turn that may not exist yet. */
    public boolean recordRolePreflightDiagnosticIfActive(
        String diagnosticId,
        String characterId,
        String level,
        String code,
        String detail,
        long now
    ) {
        AtomicReference<Boolean> inserted = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            if (isRoleDeleteTombstoned(characterId)) return;
            ChatTurnEntity turn = dao.turn(diagnosticId);
            if (turn != null && !Objects.equals(turn.characterId, characterId)) return;
            insertDiagnostic(diagnosticId, null, level, code, detail, now);
            inserted.set(true);
        });
        return Boolean.TRUE.equals(inserted.get());
    }

    public void recordCanonicalCloudRejectionOnce(
        CanonicalCloudTarget target,
        String relayMessageId,
        String reason,
        long now
    ) {
        String safeRelay = requireBridgeIdentity(relayMessageId, "cloud relay message");
        if (!Arrays.asList(
            "protocol_conflict", "parse_conflict", "target_conflict", "apply_conflict"
        ).contains(reason)) {
            throw bridgeAuthorityConflict(target == null ? "bridge-cloud-inbox" : target.localTurnId);
        }
        database.runInTransaction(() -> {
            try {
                String detail = BridgeAuthority.canonicalJson(new JSONObject()
                    .put("reason", reason)
                    .put("redacted", true)
                    .put("relayMessageId", safeRelay));
                if (dao.diagnosticCountByCodeAndDetail(
                    "BRIDGE_CLOUD_RESULT_PENDING", detail) == 0) {
                    insertDiagnostic(
                        target == null ? "bridge-cloud-inbox" : target.localTurnId,
                        target == null ? null : target.activeAttemptId,
                        "WARN", "BRIDGE_CLOUD_RESULT_PENDING", detail, now);
                }
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw bridgeAuthorityConflict(
                    target == null ? "bridge-cloud-inbox" : target.localTurnId);
            }
        });
    }

    @Override
    public List<ChatTurnEntity> unappliedCompletedTurns(int limit) {
        return dao.unappliedCompletedTurns(Math.max(1, Math.min(limit, 500)));
    }

    @Override
    public List<ChatTurnEntity> recentCompletedTurns(int limit) {
        return dao.recentCompletedTurns(Math.max(1, Math.min(limit, 50)));
    }

    @Override
    public void markNotificationShown(String turnId, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (turn.notificationShownAt != null) return;
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (dao.markNotificationShown(turnId, now) != 1) {
                throw new IllegalStateException("Unable to record notification for " + turnId);
            }
        });
    }

    @Override
    public void acknowledgeUiApplied(String turnId, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (turn.uiAppliedAt == null && dao.acknowledgeUiApplied(turnId, now) != 1) {
                throw new IllegalStateException("Unable to acknowledge UI result for " + turnId);
            }
            markUiAppliedInternal(
                turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
        });
    }

    @Override
    public ConversationCursorEntity getConversationCursor(String characterId) {
        return dao.conversationCursor(requireCharacterId(characterId));
    }

    public JSONObject androidRoomBackupHead(String characterId, long capturedAt) {
        String safeCharacterId = requireCharacterId(characterId);
        if (capturedAt <= 0L || capturedAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("Android Room backup capturedAt is invalid");
        }
        AtomicReference<JSONObject> result = new AtomicReference<>();
        database.runInTransaction(() -> {
            ConversationCursorEntity persistedCursor = dao.conversationCursor(safeCharacterId);
            ConversationCursorEntity cursor = persistedCursor == null
                ? new ConversationCursorEntity() : persistedCursor;
            if (persistedCursor == null) cursor.characterId = safeCharacterId;
            LifecycleControlEntity lifecycle = dao.latestLifecycleControlForCharacter(safeCharacterId);
            if (lifecycle != null) validatePersistedLifecycleControl(lifecycle);
            try {
                JSONObject cursorProjection = new JSONObject()
                    .put("characterId", safeCharacterId)
                    .put("nativeCompletedTurnId", cursor.nativeCompletedTurnId == null
                        ? JSONObject.NULL : cursor.nativeCompletedTurnId)
                    .put("nativeCompletedGroupId", cursor.nativeCompletedGroupId == null
                        ? JSONObject.NULL : cursor.nativeCompletedGroupId)
                    .put("nativeCompletedSequence", cursor.nativeCompletedSequence)
                    .put("uiAppliedTurnId", cursor.uiAppliedTurnId == null
                        ? JSONObject.NULL : cursor.uiAppliedTurnId)
                    .put("uiAppliedGroupId", cursor.uiAppliedGroupId == null
                        ? JSONObject.NULL : cursor.uiAppliedGroupId)
                    .put("uiAppliedSequence", cursor.uiAppliedSequence)
                    .put("localSequence", cursor.localSequence)
                    .put("clearedThroughSequence", cursor.clearedThroughSequence)
                    .put("clearEpoch", cursor.clearEpoch)
                    .put("clearedAt", cursor.clearedAt)
                    .put("chatOpen", cursor.chatOpen)
                    .put("updatedAt", cursor.updatedAt)
                    .put("cursorChecksum", conversationCursorChecksum(safeCharacterId, cursor));
                JSONObject lifecycleProjection = lifecycle == null ? null : new JSONObject()
                    .put("controlId", lifecycle.controlId)
                    .put("controlKind", lifecycle.controlKind)
                    .put("peerId", lifecycle.peerId)
                    .put("state", lifecycle.state)
                    .put("semanticChecksum", lifecycle.semanticChecksum)
                    .put("clearEpoch", lifecycle.clearEpoch == null ? JSONObject.NULL : lifecycle.clearEpoch)
                    .put("clearedThroughSequence", lifecycle.clearedThroughSequence == null
                        ? JSONObject.NULL : lifecycle.clearedThroughSequence)
                    .put("requestedAt", lifecycle.requestedAt)
                    .put("appliedAt", lifecycle.appliedAt == null ? JSONObject.NULL : lifecycle.appliedAt)
                    .put("updatedAt", lifecycle.updatedAt);
                JSONObject basis = new JSONObject()
                    .put("headVersion", "android-room-backup-head-v1")
                    .put("roleId", safeCharacterId)
                    .put("roomSchemaVersion", AlExecutionDatabase.SCHEMA_VERSION)
                    .put("cursor", cursorProjection)
                    .put("lifecycleHead", lifecycleProjection == null ? JSONObject.NULL : lifecycleProjection)
                    .put("capturedAt", capturedAt);
                JSONObject head = new JSONObject(basis.toString())
                    .put("checksum", BridgeAuthority.sha256CanonicalJson(basis));
                result.set(AndroidRoomBackupHead.validate(head, safeCharacterId));
            } catch (Exception error) {
                if (error instanceof IllegalArgumentException) {
                    throw (IllegalArgumentException) error;
                }
                throw new IllegalStateException("Android Room backup head projection conflict", error);
            }
        });
        return result.get();
    }

    public void markNativeCompleted(
        String characterId,
        String turnId,
        String visibleGroupId,
        long localSequence,
        long now
    ) {
        database.runInTransaction(() -> {
            markNativeCompletedInternal(characterId, turnId, visibleGroupId, localSequence, now);
        });
    }

    private void markNativeCompletedInternal(
        String characterId, String turnId, String visibleGroupId, long localSequence, long now
    ) {
        assertRoleAcceptsSemanticWrite(characterId);
        ConversationCursorEntity cursor = cursorFor(characterId, now);
        if ((cursor.clearEpoch > 0L && localSequence <= cursor.clearedThroughSequence)
            || localSequence < cursor.localSequence) return;
        boolean advancesNative = localSequence > cursor.nativeCompletedSequence
            || (localSequence == cursor.nativeCompletedSequence
                && (cursor.nativeCompletedGroupId == null || cursor.nativeCompletedGroupId.equals(visibleGroupId)));
        if (!advancesNative) return;
        cursor.nativeCompletedTurnId = turnId;
        cursor.nativeCompletedGroupId = visibleGroupId;
        cursor.nativeCompletedSequence = localSequence;
        cursor.localSequence = Math.max(cursor.localSequence, localSequence);
        cursor.updatedAt = now;
        saveCursor(cursor);
    }

    public void markUiApplied(
        String characterId,
        String turnId,
        String visibleGroupId,
        long localSequence,
        long now
    ) {
        database.runInTransaction(() -> {
            markUiAppliedInternal(characterId, turnId, visibleGroupId, localSequence, now);
        });
    }

    private void markUiAppliedInternal(
        String characterId, String turnId, String visibleGroupId, long localSequence, long now
    ) {
        assertRoleAcceptsSemanticWrite(characterId);
        ConversationCursorEntity cursor = cursorFor(characterId, now);
        if (cursor.clearEpoch > 0L && localSequence <= cursor.clearedThroughSequence) return;
        // A later local turn may have advanced localSequence before an older
        // completed result is applied in the UI.  That result is still valid
        // when it is newer than the UI anchor; only the clear boundary and a
        // stale UI sequence suppress it.
        if (localSequence < cursor.uiAppliedSequence) return;
        boolean advancesUi = localSequence > cursor.uiAppliedSequence
            || (localSequence == cursor.uiAppliedSequence
                && (cursor.uiAppliedGroupId == null || cursor.uiAppliedGroupId.equals(visibleGroupId)));
        if (!advancesUi) return;
        cursor.uiAppliedTurnId = turnId;
        cursor.uiAppliedGroupId = visibleGroupId;
        cursor.uiAppliedSequence = localSequence;
        cursor.localSequence = Math.max(cursor.localSequence, localSequence);
        cursor.updatedAt = now;
        saveCursor(cursor);
    }

    public DeliveryDisposition classifyIncomingGroup(String characterId, String visibleGroupId, long localSequence) {
        if (isRoleDeleteTombstoned(characterId)) return DeliveryDisposition.REDACTED;
        ConversationCursorEntity cursor = dao.conversationCursor(requireCharacterId(characterId));
        return cursor != null && cursor.clearEpoch > 0L && localSequence <= cursor.clearedThroughSequence
            ? DeliveryDisposition.REDACTED
            : DeliveryDisposition.APPLY;
    }

    void markConversationCleared(
        String characterId,
        long clearedThroughSequence,
        long clearEpoch,
        long now
    ) {
        database.runInTransaction(() -> {
            ConversationCursorEntity cursor = cursorFor(characterId, now);
            cursor.clearedThroughSequence = Math.max(cursor.clearedThroughSequence, clearedThroughSequence);
            cursor.clearEpoch = Math.max(cursor.clearEpoch, clearEpoch);
            cursor.clearedAt = Math.max(cursor.clearedAt, now);
            cursor.updatedAt = now;
            saveCursor(cursor);
            dao.clearReplyPartsThroughSequence(characterId, cursor.clearedThroughSequence);
        });
    }

    @Override
    public LifecycleControl createConversationClear(String characterId, String expectedCursorChecksum) {
        return createConversationClear(characterId, expectedCursorChecksum, null);
    }

    public LifecycleControl createConversationClear(
        String characterId,
        String expectedCursorChecksum,
        Runnable durableWakePrearm
    ) {
        if (storeOwnedPeerId == null || storeOwnedPeerId.isEmpty()) {
            throw new IllegalStateException("store-owned bridge peer is not configured");
        }
        if (expectedCursorChecksum == null || !expectedCursorChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("expected cursor checksum is invalid");
        }
        return createConversationClear(characterId, storeOwnedPeerId, expectedCursorChecksum,
            System.currentTimeMillis(), durableWakePrearm);
    }

    public static String conversationCursorChecksum(String characterId, ConversationCursorEntity cursor) {
        if (characterId == null || characterId.trim().isEmpty()) {
            throw new IllegalArgumentException("characterId is required");
        }
        ConversationCursorEntity value = cursor == null ? new ConversationCursorEntity() : cursor;
        JSONObject basis = new JSONObject();
        try {
            basis.put("contract", "conversation-cursor-clear-v1");
            basis.put("characterId", characterId);
            basis.put("nativeCompletedTurnId", value.nativeCompletedTurnId == null ? JSONObject.NULL : value.nativeCompletedTurnId);
            basis.put("nativeCompletedGroupId", value.nativeCompletedGroupId == null ? JSONObject.NULL : value.nativeCompletedGroupId);
            basis.put("nativeCompletedSequence", value.nativeCompletedSequence);
            basis.put("uiAppliedTurnId", value.uiAppliedTurnId == null ? JSONObject.NULL : value.uiAppliedTurnId);
            basis.put("uiAppliedGroupId", value.uiAppliedGroupId == null ? JSONObject.NULL : value.uiAppliedGroupId);
            basis.put("uiAppliedSequence", value.uiAppliedSequence);
            basis.put("localSequence", value.localSequence);
            basis.put("clearedThroughSequence", value.clearedThroughSequence);
            basis.put("clearEpoch", value.clearEpoch);
            basis.put("clearedAt", value.clearedAt);
            basis.put("chatOpen", value.chatOpen);
            basis.put("updatedAt", value.updatedAt);
        } catch (Exception error) {
            throw new IllegalStateException("cursor checksum serialization failed", error);
        }
        return BridgeAuthority.sha256CanonicalJson(basis);
    }

    LifecycleControl createConversationClear(
        String characterId,
        String peerId,
        String expectedCursorChecksum,
        long requestedAt
    ) {
        return createConversationClear(
            characterId, peerId, expectedCursorChecksum, requestedAt, null);
    }

    LifecycleControl createConversationClear(
        String characterId,
        String peerId,
        String expectedCursorChecksum,
        long requestedAt,
        Runnable durableWakePrearm
    ) {
        String safeCharacterId = requireCharacterId(characterId);
        if (peerId == null || peerId.trim().isEmpty() || !peerId.equals(peerId.trim())) {
            throw new IllegalArgumentException("store-owned bridge peer is required");
        }
        if (requestedAt <= 0L || requestedAt > 9007199254740991L) {
            throw new IllegalArgumentException("requestedAt is invalid");
        }
        if (expectedCursorChecksum == null || !expectedCursorChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("expected cursor checksum is invalid");
        }
        AtomicReference<LifecycleControl> result = new AtomicReference<>();
        database.runInTransaction(() -> {
            ConversationCursorEntity cursor = dao.conversationCursor(safeCharacterId);
            boolean newCursor = cursor == null;
            if (newCursor) {
                cursor = new ConversationCursorEntity();
                cursor.characterId = safeCharacterId;
            }
            // Every persisted v3 member must carry a native safe visibility
            // sequence before a clear can touch any row.  A null/negative/
            // overflow sequence is an authority conflict, not a legacy row.
            if (dao.invalidV3VisibilitySequence(safeCharacterId) != null) {
                throw new IllegalStateException("conversation clear v3 visibility sequence conflict");
            }
            String currentCursorChecksum = conversationCursorChecksum(safeCharacterId, cursor);
            LifecycleControlEntity existing = cursor.clearEpoch > 0L
                ? dao.lifecycleControlForClear(safeCharacterId, cursor.clearEpoch) : null;
            if (existing != null) {
                boolean semanticExact;
                String semanticInputChecksum = null;
                try {
                    JSONObject semantic = new JSONObject(existing.semanticJson);
                    semanticExact = existing.semanticChecksum.equals(LifecycleControlCodec.semanticChecksum(semantic));
                    semanticInputChecksum = semantic.optString("inputCursorChecksum", null);
                } catch (Exception error) {
                    semanticExact = false;
                }
                boolean replayPreClear = expectedCursorChecksum.equals(semanticInputChecksum);
                boolean resumePostClear = expectedCursorChecksum.equals(currentCursorChecksum)
                    && !LifecycleControl.APPLIED.equals(existing.state);
                if ((!replayPreClear && !resumePostClear)
                    || !peerId.equals(existing.peerId) || !semanticExact) {
                    throw new IllegalStateException("conversation clear identity conflict");
                }
                if (replayPreClear || !LifecycleControl.APPLIED.equals(existing.state)) {
                    if (!LifecycleControl.APPLIED.equals(existing.state)
                        && durableWakePrearm != null) {
                        durableWakePrearm.run();
                    }
                    result.set(LifecycleControl.fromEntity(existing));
                    return;
                }
            }
            if (!expectedCursorChecksum.equals(currentCursorChecksum)) {
                throw new IllegalStateException("conversation clear cursor conflict");
            }
            if (newCursor && dao.insertConversationCursor(cursor) == -1L) {
                throw new IllegalStateException("conversation clear cursor race");
            }
            long clearEpoch = cursor.clearEpoch + 1L;
            long clearedThroughSequence = cursor.localSequence;
            LifecycleControlCodec.Encoded encoded;
            try {
                encoded = LifecycleControlCodec.encodeConversationClear(
                    safeCharacterId, peerId, clearEpoch, clearedThroughSequence, requestedAt,
                    expectedCursorChecksum
                );
            } catch (Exception error) {
                throw new IllegalStateException("conversation clear semantic conflict", error);
            }
            Set<String> cancelledLineages = new HashSet<>();
            for (ChatTurnEntity turn : dao.turnsThroughClear(safeCharacterId, clearedThroughSequence)) {
                if (turn.bridgeProtocolVersion == null) continue;
                if (turn.activeAttemptId == null) {
                    throw new IllegalStateException("conversation clear missing active v3 member");
                }
                ExecutionAttemptEntity active = dao.attempt(turn.activeAttemptId);
                if (active == null || active.bridgeAuthorityCheckpointJson == null
                    || active.bridgeAuthorityCheckpointChecksum == null) {
                    throw new IllegalStateException("conversation clear missing active v3 checkpoint");
                }
                JSONObject activeRoot;
                try {
                    activeRoot = new JSONObject(active.bridgeAuthorityCheckpointJson);
                } catch (Exception error) {
                    throw new IllegalStateException("conversation clear checkpoint conflict", error);
                }
                if ("redacted".equals(activeRoot.optJSONObject("outcome") == null
                    ? null : activeRoot.optJSONObject("outcome").optString("type"))) {
                    // A prior clear is not a trust boundary.  Re-validate every
                    // persisted member and its lifecycle/authority tombstone
                    // before allowing a later epoch to touch any semantics.
                    for (ExecutionAttemptEntity candidate : dao.attempts(turn.turnId)) {
                        boolean hasJson = candidate.bridgeAuthorityCheckpointJson != null;
                        boolean hasChecksum = candidate.bridgeAuthorityCheckpointChecksum != null;
                        if (!hasJson || !hasChecksum) {
                            throw new IllegalStateException("conversation clear tombstone conflict");
                        }
                        validateCheckpoint(turn, candidate, false);
                    }
                    continue;
                }
                // Re-run the complete Task 13C closure against the persisted
                // member before changing any bytes; a self-consistent forged
                // checksum is not a washable redaction input.
                validateCheckpointSet(turn, dao.attempts(turn.turnId), true);
                JSONObject validatedActive = validateCheckpoint(turn, active, false);
                assertCanonicalBridgeLifecycle(turn, active, false, validatedActive);
                for (ExecutionAttemptEntity attempt : dao.attempts(turn.turnId)) {
                    if (attempt.bridgeAuthorityCheckpointJson == null
                        || attempt.bridgeAuthorityCheckpointChecksum == null) continue;
                    JSONObject validatedAttempt = validateCheckpoint(turn, attempt, false);
                    String checkpointPeer;
                    try {
                        checkpointPeer = requireNativeNonEmptyString(
                            checkpointEnvelope(validatedAttempt), "deviceId", turn.turnId);
                    } catch (Exception error) {
                        throw new IllegalStateException("conversation clear checkpoint peer conflict", error);
                    }
                    if (!peerId.equals(checkpointPeer)) {
                        throw new IllegalStateException("conversation clear checkpoint peer conflict");
                    }
                    String tombstone = BridgeReceiptCheckpoint.redactForConversationClear(
                        attempt.bridgeAuthorityCheckpointJson,
                        attempt.bridgeAuthorityCheckpointChecksum,
                        encoded.controlId, clearEpoch, clearedThroughSequence, requestedAt
                    );
                    if (tombstone == null) {
                        throw new IllegalStateException("conversation clear checkpoint conflict");
                    }
                    String tombstoneChecksum;
                    try {
                        tombstoneChecksum = BridgeAuthority.sha256CanonicalJson(new JSONObject(tombstone));
                    } catch (Exception error) {
                        throw new IllegalStateException("conversation clear checkpoint conflict", error);
                    }
                    if (dao.compareAndSetBridgeAuthorityCheckpoint(
                        attempt.attemptId, turn.turnId,
                        attempt.bridgeAuthorityCheckpointJson,
                        attempt.bridgeAuthorityCheckpointChecksum,
                        tombstone, tombstoneChecksum
                    ) != 1) {
                        throw new IllegalStateException("conversation clear checkpoint race");
                    }
                }
                String lineageKey = turn.authorityLineageKey;
                if (lineageKey == null || lineageKey.trim().isEmpty()) {
                    throw new IllegalStateException("conversation clear missing v3 authority lineage");
                }
                if (!cancelledLineages.contains(lineageKey)) {
                    ConversationAuthorityEntity authority = dao.conversationAuthority(lineageKey);
                    if (authority == null || !turn.characterId.equals(authority.characterId)
                        || authority.latestTurnId == null || authority.revision < 0L) {
                        throw new IllegalStateException("conversation clear authority conflict");
                    }
                    if ("OPEN".equals(authority.state) || "COMMITTED".equals(authority.state)) {
                        if (dao.compareAndSetConversationAuthority(
                            lineageKey, authority.revision, authority.latestTurnId, authority.revision + 1L,
                            "CANCELLED", null, null, null, null, null, requestedAt
                        ) != 1) {
                            throw new IllegalStateException("conversation clear authority race");
                        }
                    } else if (!"CANCELLED".equals(authority.state)) {
                        throw new IllegalStateException("conversation clear authority state conflict");
                    }
                    cancelledLineages.add(lineageKey);
                }
                terminalFaultHook.after("lifecycle_checkpoint");
            }
            dao.clearRawMessagesThroughSequence(safeCharacterId, clearedThroughSequence);
            dao.clearAttemptSemanticsThroughSequence(safeCharacterId, clearedThroughSequence, requestedAt);
            dao.clearTurnSemanticsThroughSequence(safeCharacterId, clearedThroughSequence, requestedAt);
            dao.clearDiagnosticsThroughSequence(safeCharacterId, clearedThroughSequence);
            String redactedEventPayload;
            try {
                redactedEventPayload = BridgeAuthority.canonicalJson(new JSONObject()
                    .put("contract", "conversation-clear-v1")
                    .put("state", "redacted")
                    .put("clearEpoch", clearEpoch)
                    .put("clearedThroughSequence", clearedThroughSequence));
            } catch (Exception error) {
                throw new IllegalStateException("conversation clear audit serialization conflict", error);
            }
            dao.redactChangeEventsThroughSequence(
                safeCharacterId, clearedThroughSequence, redactedEventPayload);
            terminalFaultHook.after("lifecycle_semantics");
            cursor.clearedThroughSequence = clearedThroughSequence;
            cursor.clearEpoch = clearEpoch;
            cursor.clearedAt = requestedAt;
            cursor.updatedAt = requestedAt;
            saveCursor(cursor);
            terminalFaultHook.after("lifecycle_cursor");
            LifecycleControlEntity row = encodedToEntity(
                encoded, safeCharacterId, peerId, requestedAt
            );
            if (dao.insertLifecycleControl(row) != 1L) {
                throw new IllegalStateException("conversation clear already exists");
            }
            terminalFaultHook.after("lifecycle_control");
            dao.clearReplyPartsThroughSequence(safeCharacterId, clearedThroughSequence);
            if (durableWakePrearm != null) durableWakePrearm.run();
            result.set(LifecycleControl.fromEntity(row));
        });
        return result.get();
    }

    private static LifecycleControlEntity encodedToEntity(
        LifecycleControlCodec.Encoded encoded,
        String characterId,
        String peerId,
        long now
    ) {
        LifecycleControlEntity row = new LifecycleControlEntity();
        row.controlId = encoded.controlId;
        row.controlKind = LifecycleControl.CLEAR_KIND;
        row.characterId = characterId;
        row.peerId = peerId;
        try {
            JSONObject semantic = encoded.semantic;
            row.clearEpoch = semantic.getLong("clearEpoch");
            row.clearedThroughSequence = semantic.getLong("clearedThroughSequence");
            row.requestedAt = semantic.getLong("requestedAt");
        } catch (Exception error) {
            throw new IllegalStateException("conversation clear semantic conflict", error);
        }
        row.semanticJson = BridgeAuthority.canonicalJson(encoded.semantic);
        row.semanticChecksum = encoded.semanticChecksum;
        row.state = LifecycleControl.WAITING;
        row.leaseAttempt = 0L;
        row.updatedAt = now;
        return row;
    }

    public LifecycleControl createRoleDelete(
        String characterId,
        String expectedCursorChecksum,
        JSONObject backupReceipt,
        Runnable durableWakePrearm
    ) {
        if (storeOwnedPeerId == null || storeOwnedPeerId.isEmpty()) {
            throw new IllegalStateException("store-owned bridge peer is not configured");
        }
        if (expectedCursorChecksum == null || !expectedCursorChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("expected cursor checksum is invalid");
        }
        return createRoleDelete(
            characterId, storeOwnedPeerId, expectedCursorChecksum, backupReceipt,
            System.currentTimeMillis(), durableWakePrearm, null);
    }

    public LifecycleControl createRoleDelete(
        String characterId,
        String expectedCursorChecksum,
        JSONObject backupReceipt,
        Runnable durableWakePrearm,
        RoleDeletionDispatchPolicy.NotificationCanceller notificationCanceller
    ) {
        if (storeOwnedPeerId == null || storeOwnedPeerId.isEmpty()) {
            throw new IllegalStateException("store-owned bridge peer is not configured");
        }
        if (expectedCursorChecksum == null || !expectedCursorChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("expected cursor checksum is invalid");
        }
        return createRoleDelete(
            characterId, storeOwnedPeerId, expectedCursorChecksum, backupReceipt,
            System.currentTimeMillis(), durableWakePrearm, notificationCanceller);
    }

    public LifecycleControl roleDeleteControl(String characterId) {
        String safeCharacterId = requireCharacterId(characterId);
        List<LifecycleControlEntity> rows = dao.roleDeleteControlsForCharacter(safeCharacterId);
        if (rows.isEmpty()) return null;
        if (rows.size() != 1) throw new IllegalStateException("role delete authority set conflict");
        validatePersistedLifecycleControl(rows.get(0));
        return LifecycleControl.fromEntity(rows.get(0));
    }

    public boolean isRoleDeleteTombstoned(String characterId) {
        return roleDeleteControl(characterId) != null;
    }

    /**
     * Runs one observable role-scoped side effect only while holding the
     * process-local deletion gate.  Role deletion takes the same gate before
     * persisting its tombstone, so it cannot commit between the tombstone
     * check and the beginning of the effect.  The durable tombstone remains
     * the source of truth after process restart.
     */
    public boolean runRoleSideEffectIfNotDeleted(String characterId, Runnable sideEffect) {
        String safeCharacterId = requireCharacterId(characterId);
        if (sideEffect == null) throw new IllegalArgumentException("role side effect is required");
        Object gate = ROLE_SIDE_EFFECT_GATES.computeIfAbsent(safeCharacterId, ignored -> new Object());
        synchronized (gate) {
            if (roleDeleteControl(safeCharacterId) != null) return false;
            sideEffect.run();
            return roleDeleteControl(safeCharacterId) == null;
        }
    }

    /**
     * Marks a completed/unapplied turn as metadata-only deleted under the
     * retained role-delete authority.  No semantic payload, cursor, receipt,
     * or diagnostic is written; the existing deletedAt column makes all
     * completed/recovery selectors hide it and makes exact replays idempotent.
     */
    public boolean suppressRoleDeletedTurn(String turnId, String characterId, long now) {
        String safeTurnId = requireBridgeIdentity(turnId, "role delete turn");
        String safeCharacterId = requireCharacterId(characterId);
        if (!safeNonNegative(now) || now == 0L) {
            throw new IllegalArgumentException("role delete suppression time is invalid");
        }
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        Object roleGate = ROLE_SIDE_EFFECT_GATES.computeIfAbsent(
            safeCharacterId, ignored -> new Object());
        synchronized (roleGate) {
            database.runInTransaction(() -> {
            if (roleDeleteControl(safeCharacterId) == null) {
                throw new IllegalStateException("role delete tombstone required");
            }
            ChatTurnEntity turn = dao.turn(safeTurnId);
            if (turn == null) {
                result.set(true);
                return;
            }
            if (!safeCharacterId.equals(turn.characterId)) {
                throw new IllegalStateException("role delete turn target conflict");
            }
            if (turn.deletedAt != null) {
                result.set(true);
                return;
            }
            if (dao.suppressRoleDeletedTurn(safeTurnId, safeCharacterId, now) == 1) {
                result.set(true);
                return;
            }
            ChatTurnEntity after = dao.turn(safeTurnId);
            if (after == null || after.deletedAt != null) {
                result.set(true);
                return;
            }
            throw new IllegalStateException("role delete suppression conflict");
            });
        }
        return Boolean.TRUE.equals(result.get());
    }

    public void assertRoleAcceptsSemanticWrite(String characterId) {
        if (roleDeleteControl(characterId) != null) {
            throw new IllegalStateException("role delete tombstone prevents semantic write");
        }
    }

    @Override
    public void assertBridgeSubmissionStillAllowed(TurnSubmission submission) {
        if (submission == null) throw new IllegalArgumentException("bridge submission is required");
        ChatTurnEntity turn = requireTurn(submission.turnId);
        if (!submission.characterId.equals(turn.characterId)
            || !submission.sourceMessageId.equals(turn.sourceMessageId)
            || !submission.inputJson.equals(turn.inputJson)
            || !submission.snapshotJson.equals(turn.snapshotJson)) {
            throw bridgeAuthorityConflict(submission.turnId);
        }
        assertRoleAcceptsSemanticWrite(turn.characterId);
    }

    LifecycleControl createRoleDelete(
        String characterId,
        String peerId,
        String expectedCursorChecksum,
        JSONObject backupReceipt,
        long requestedAt,
        Runnable durableWakePrearm
    ) {
        return createRoleDelete(
            characterId, peerId, expectedCursorChecksum, backupReceipt, requestedAt,
            durableWakePrearm, null);
    }

    LifecycleControl createRoleDelete(
        String characterId,
        String peerId,
        String expectedCursorChecksum,
        JSONObject backupReceipt,
        long requestedAt,
        Runnable durableWakePrearm,
        RoleDeletionDispatchPolicy.NotificationCanceller notificationCanceller
    ) {
        String safeCharacterId = requireCharacterId(characterId);
        if (peerId == null || peerId.trim().isEmpty() || !peerId.equals(peerId.trim())) {
            throw new IllegalArgumentException("store-owned bridge peer is required");
        }
        if (expectedCursorChecksum == null || !expectedCursorChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("expected cursor checksum is invalid");
        }
        if (requestedAt <= 0L || requestedAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("requestedAt is invalid");
        }
        JSONObject verifiedReceipt = LifecycleControlCodec.validateBackupReceipt(backupReceipt);
        AtomicReference<LifecycleControl> result = new AtomicReference<>();
        Object roleGate = ROLE_SIDE_EFFECT_GATES.computeIfAbsent(
            safeCharacterId, ignored -> new Object());
        synchronized (roleGate) {
        database.runInTransaction(() -> {
            List<LifecycleControlEntity> existingRows = dao.roleDeleteControlsForCharacter(safeCharacterId);
            if (!existingRows.isEmpty()) {
                if (existingRows.size() != 1) {
                    throw new IllegalStateException("role delete authority set conflict");
                }
                LifecycleControlEntity existing = existingRows.get(0);
                validatePersistedLifecycleControl(existing);
                try {
                    JSONObject semantic = new JSONObject(existing.semanticJson);
                    JSONObject persistedReceipt = semantic.getJSONObject("backupReceipt");
                    if (!peerId.equals(existing.peerId)
                        || !safeCharacterId.equals(existing.characterId)
                        || !BridgeAuthority.canonicalJson(verifiedReceipt).equals(
                            BridgeAuthority.canonicalJson(persistedReceipt))) {
                        throw new IllegalStateException("role delete identity conflict");
                    }
                } catch (IllegalStateException error) {
                    throw error;
                } catch (Exception error) {
                    throw new IllegalStateException("role delete identity conflict", error);
                }
                if (!LifecycleControl.APPLIED.equals(existing.state) && durableWakePrearm != null) {
                    durableWakePrearm.run();
                }
                result.set(LifecycleControl.fromEntity(existing));
                return;
            }

            ConversationCursorEntity cursor = dao.conversationCursor(safeCharacterId);
            String currentCursorChecksum = conversationCursorChecksum(safeCharacterId, cursor);
            if (!expectedCursorChecksum.equals(currentCursorChecksum)) {
                throw new IllegalStateException("role delete cursor conflict");
            }
            LifecycleControlCodec.Encoded encoded;
            try {
                encoded = LifecycleControlCodec.encodeRoleDelete(
                    safeCharacterId, peerId, requestedAt, verifiedReceipt);
            } catch (Exception error) {
                throw new IllegalStateException("role delete semantic conflict", error);
            }
            LifecycleControlEntity row = encodedToRoleDeleteEntity(
                encoded, safeCharacterId, peerId, requestedAt);
            List<String> roleTurnIds = dao.turnIdsForCharacter(safeCharacterId);
            if (dao.insertLifecycleControl(row) != 1L) {
                throw new IllegalStateException("role delete already exists");
            }
            insertRoleNotificationCancellationIntents(
                row.controlId, safeCharacterId, roleTurnIds, requestedAt);
            terminalFaultHook.after("role_delete_control");

            dao.deleteAnnotationsForRole(safeCharacterId);
            dao.deleteDiagnosticsForRole(safeCharacterId);
            dao.deleteChangesForRole(safeCharacterId);
            dao.deleteRawMessagesForRole(safeCharacterId);
            dao.deleteReplyPartsForRole(safeCharacterId);
            dao.deleteAttemptsForRole(safeCharacterId);
            dao.deleteTurnsForRole(safeCharacterId);
            terminalFaultHook.after("role_delete_turn_children");

            dao.deleteMemoryForRole(safeCharacterId);
            dao.deleteEvidenceForRole(safeCharacterId);
            dao.deleteSnapshotsForRole(safeCharacterId);
            dao.deleteRolePlanOccurrencesForRole(safeCharacterId);
            dao.deleteRolePlanHistoryForCharacter(safeCharacterId);
            dao.deleteRolePlansForCharacter(safeCharacterId);
            terminalFaultHook.after("role_delete_role_data");

            dao.deleteConversationAuthoritiesForRole(safeCharacterId);
            dao.deleteConversationCursorForRole(safeCharacterId);
            terminalFaultHook.after("role_delete_authority");

            dao.deletePriorLifecycleAckTombstonesForRole(safeCharacterId, row.controlId);
            dao.deletePriorLifecycleControlsForRole(safeCharacterId, row.controlId);
            terminalFaultHook.after("role_delete_lifecycle");
            if (durableWakePrearm != null) durableWakePrearm.run();
            result.set(LifecycleControl.fromEntity(row));
        });
        }
        // NotificationManager is an external side effect.  Drain only after
        // the tombstone, cancellation intents, and semantic deletion commit.
        // A callback failure leaves the waiting rows durable for restart retry.
        if (notificationCanceller != null) {
            drainPendingRoleNotificationCancellations(notificationCanceller);
        }
        return result.get();
    }

    private void insertRoleNotificationCancellationIntents(
        String controlId, String characterId, List<String> turnIds, long createdAt
    ) {
        for (int notificationId :
            RoleNotificationCancellationContract.notificationIdsForTurns(turnIds)) {
            String checksum = roleNotificationCancellationChecksum(
                controlId, characterId, notificationId, createdAt);
            RoleNotificationCancellationEntity intent = new RoleNotificationCancellationEntity();
            intent.cancellationKey = "rncan_" + checksum;
            intent.controlId = controlId;
            intent.characterId = characterId;
            intent.notificationId = notificationId;
            intent.intentChecksum = checksum;
            intent.state = "waiting";
            intent.createdAt = createdAt;
            intent.updatedAt = createdAt;
            if (dao.insertRoleNotificationCancellation(intent) != 1L) {
                throw new IllegalStateException("role notification cancellation already exists");
            }
        }
    }

    /**
     * Drains metadata-only cancellation intents.  Every row is validated and
     * joined to its retained role-delete control before the first external
     * cancel call, so corrupt/foreign rows fail closed with zero cancellation.
     */
    public int drainPendingRoleNotificationCancellations(
        RoleDeletionDispatchPolicy.NotificationCanceller canceller
    ) {
        if (canceller == null) throw new IllegalArgumentException("notification canceller is required");
        List<RoleNotificationCancellationEntity> all = dao.roleNotificationCancellations();
        for (RoleNotificationCancellationEntity row : all) {
            validatePersistedRoleNotificationCancellation(row);
        }
        int completed = 0;
        for (RoleNotificationCancellationEntity row : all) {
            if (!"waiting".equals(row.state)) continue;
            canceller.cancel(row.notificationId);
            int deleted = dao.deleteRoleNotificationCancellationExact(
                row.cancellationKey, row.controlId, row.characterId, row.notificationId,
                row.intentChecksum, row.state, row.createdAt, row.updatedAt);
            if (deleted == 1) completed++;
        }
        return completed;
    }

    private static LifecycleControlEntity encodedToRoleDeleteEntity(
        LifecycleControlCodec.Encoded encoded,
        String characterId,
        String peerId,
        long requestedAt
    ) {
        LifecycleControlEntity row = new LifecycleControlEntity();
        row.controlId = encoded.controlId;
        row.controlKind = LifecycleControl.ROLE_DELETE_KIND;
        row.characterId = characterId;
        row.peerId = peerId;
        row.clearEpoch = null;
        row.clearedThroughSequence = null;
        row.requestedAt = requestedAt;
        row.semanticJson = BridgeAuthority.canonicalJson(encoded.semantic);
        row.semanticChecksum = encoded.semanticChecksum;
        row.state = LifecycleControl.WAITING;
        row.leaseAttempt = 0L;
        row.updatedAt = requestedAt;
        return row;
    }

    public void recordTerminalReceipt(
        String turnId,
        String authorityLineageKey,
        String laneKey,
        String rootSourceId,
        String visibleGroupId,
        long lineageRevision,
        String authorityOrigin,
        String commitPayloadVersion,
        String bridgeCommitChecksum,
        String terminalDisposition,
        long inputVisibilitySequence,
        long inputClearEpoch,
        long now
    ) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (hasTerminalReceipt(turn)) {
                if (sameReceipt(
                    turn, authorityLineageKey, visibleGroupId, commitPayloadVersion,
                    bridgeCommitChecksum, terminalDisposition
                )) return;
                throw bridgeAuthorityConflict(turnId);
            }
            ConversationAuthorityEntity authority = dao.conversationAuthority(authorityLineageKey);
            if (authority == null) {
                authority = new ConversationAuthorityEntity();
                authority.authorityLineageKey = authorityLineageKey;
                authority.characterId = turn.characterId;
                authority.laneKey = laneKey;
                authority.rootSourceId = rootSourceId;
                authority.latestTurnId = turnId;
                authority.revision = 0L;
                authority.state = "OPEN";
                authority.updatedAt = now;
                if (dao.insertConversationAuthority(authority) == -1L) {
                    authority = dao.conversationAuthority(authorityLineageKey);
                }
            }
            if (authority == null || !turn.characterId.equals(authority.characterId)
                || !laneKey.equals(authority.laneKey) || !rootSourceId.equals(authority.rootSourceId)) {
                throw bridgeAuthorityConflict(turnId);
            }
            if ("COMMITTED".equals(authority.state)) {
                if (visibleGroupId.equals(authority.visibleGroupId)
                    && bridgeCommitChecksum.equals(authority.commitChecksum)
                    && commitPayloadVersion.equals(authority.commitPayloadVersion)
                    && terminalDisposition.equals(authority.terminalDisposition)) return;
                throw bridgeAuthorityConflict(turnId);
            }
            if (lineageRevision <= authority.revision || dao.compareAndSetConversationAuthority(
                authorityLineageKey, authority.revision, turnId, lineageRevision, "COMMITTED",
                visibleGroupId, bridgeCommitChecksum, commitPayloadVersion, authorityOrigin,
                terminalDisposition, now
            ) != 1) throw bridgeAuthorityConflict(turnId);
            if (dao.writeTerminalReceipt(
                turnId, visibleGroupId, authorityLineageKey, authorityOrigin, commitPayloadVersion,
                lineageRevision, lineageRevision, laneKey, lineageRevision, inputVisibilitySequence,
                inputClearEpoch, bridgeCommitChecksum, terminalDisposition, now
            ) != 1) throw bridgeAuthorityConflict(turnId);
        });
    }

    @Override
    public BridgeReceiptDeliveryCoordinator.AuthoritySnapshot readAuthority(String localTurnId) {
        AtomicReference<BridgeReceiptDeliveryCoordinator.AuthoritySnapshot> result =
            new AtomicReference<>();
        database.runInTransaction(() -> result.set(readAuthorityInternal(localTurnId)));
        return result.get();
    }

    private BridgeReceiptDeliveryCoordinator.AuthoritySnapshot readAuthorityInternal(
        String localTurnId
    ) {
        try {
            ChatTurnEntity turn = requireTurn(localTurnId);
            if (!isStoreOwnedV3(turn)
                || !TurnState.COMPLETED.name().equals(turn.state)
                || turn.activeAttemptId == null) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            ExecutionAttemptEntity attempt = dao.attempt(turn.activeAttemptId);
            if (attempt == null
                || !localTurnId.equals(attempt.turnId)
                || attempt.sequence != dao.maxAttemptSequence(localTurnId)) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            JSONObject checkpoint = validateCheckpoint(turn, attempt, false);
            assertCanonicalBridgeLifecycle(turn, attempt, false, checkpoint);
            JSONObject outcome = checkpoint.getJSONObject("outcome");
            String outcomeType = outcome.getString("type");
            boolean redacted = "redacted".equals(outcomeType);
            if (!(redacted || "committed".equals(outcomeType))
                || redacted != (turn.deletedAt != null)) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            String route = requireNativeNonEmptyString(outcome, "route", localTurnId);
            String relayMessageId = nullableString(outcome, "relayMessageId");
            if (!("lan".equals(route) || "cloud".equals(route))
                || ("lan".equals(route) && relayMessageId != null)
                || ("cloud".equals(route) && relayMessageId == null)) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            if (!redacted && BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
                    attempt.bridgeAuthorityCheckpointJson,
                    attempt.bridgeAuthorityCheckpointChecksum) == null) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            String peerId = requireNativeNonEmptyString(
                checkpointEnvelope(checkpoint), "deviceId", localTurnId);
            return new BridgeReceiptDeliveryCoordinator.AuthoritySnapshot(
                localTurnId,
                attempt.bridgeAuthorityCheckpointJson,
                attempt.bridgeAuthorityCheckpointChecksum,
                turn.uiAppliedAt,
                redacted,
                turn.cloudConfirmedAt != null,
                peerId,
                route,
                relayMessageId);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(localTurnId);
        }
    }

    @Override
    public BridgeReceiptDeliveryCoordinator.ConfirmationResult confirmCloudReceiptExact(
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt,
        long confirmedAt
    ) {
        AtomicReference<BridgeReceiptDeliveryCoordinator.ConfirmationResult> result =
            new AtomicReference<>();
        database.runInTransaction(() -> result.set(
            confirmCloudReceiptExactInternal(receipt, confirmedAt)));
        return result.get();
    }

    private BridgeReceiptDeliveryCoordinator.ConfirmationResult confirmCloudReceiptExactInternal(
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt,
        long confirmedAt
    ) {
        if (receipt == null || receipt.localTurnId == null
            || confirmedAt <= 0L || confirmedAt > 9007199254740991L) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
        }
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot snapshot;
        try {
            snapshot = readAuthorityInternal(receipt.localTurnId);
        } catch (RuntimeException error) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
        }
        if (!matchesAuthorityReceipt(snapshot, receipt)) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
        }
        ChatTurnEntity turn = dao.turn(receipt.localTurnId);
        if (turn == null) return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
        if (turn.cloudConfirmedAt != null) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        }
        if (dao.compareAndSetCloudConfirmedExact(
                receipt.localTurnId,
                turn.activeAttemptId,
                confirmedAt,
                receipt.deliveredAt,
                receipt.authorityLineageKey,
                receipt.visibleGroupId,
                receipt.commitChecksum,
                receipt.terminalDisposition,
                receipt.checkpointChecksum) == 1) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        }
        try {
            BridgeReceiptDeliveryCoordinator.AuthoritySnapshot refreshed =
                readAuthorityInternal(receipt.localTurnId);
            ChatTurnEntity refreshedTurn = dao.turn(receipt.localTurnId);
            if (!matchesAuthorityReceipt(refreshed, receipt) || refreshedTurn == null) {
                return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
            }
            if (refreshedTurn.cloudConfirmedAt == null) {
                return BridgeReceiptDeliveryCoordinator.ConfirmationResult.RETRYABLE;
            }
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        } catch (RuntimeException error) {
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
        }
    }

    private static boolean matchesAuthorityReceipt(
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot snapshot,
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt
    ) {
        try {
            if (snapshot == null || snapshot.redacted || snapshot.uiAppliedAt == null
                || receipt.protocolVersion != 3
                || !"AUTHORITY_DELIVERY_RECEIPT".equals(receipt.type)
                || !snapshot.localTurnId.equals(receipt.localTurnId)
                || !snapshot.checkpointChecksum.equals(receipt.checkpointChecksum)
                || snapshot.uiAppliedAt.longValue() != receipt.deliveredAt
                || !snapshot.peerId.equals(receipt.peerId)
                || !snapshot.route.equals(receipt.route)
                || !sameNullable(snapshot.relayMessageId, receipt.relayMessageId)
                || !receipt.turnId.equals(receipt.authoritativeTurnId)) {
                return false;
            }
            JSONObject payload = BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
                snapshot.checkpointJson, snapshot.checkpointChecksum);
            if (payload == null
                || !receipt.turnId.equals(payload.getString("turnId"))
                || !receipt.authorityLineageKey.equals(payload.getString("authorityLineageKey"))
                || !receipt.visibleGroupId.equals(payload.getString("visibleGroupId"))
                || !receipt.commitChecksum.equals(payload.getString("commitChecksum"))
                || !receipt.terminalDisposition.equals(payload.getString("terminalDisposition"))) {
                return false;
            }
            JSONObject wire = new JSONObject()
                .put("protocolVersion", 3)
                .put("type", "AUTHORITY_DELIVERY_RECEIPT")
                .put("peerId", receipt.peerId)
                .put("turnId", receipt.turnId)
                .put("authorityLineageKey", receipt.authorityLineageKey)
                .put("visibleGroupId", receipt.visibleGroupId)
                .put("commitChecksum", receipt.commitChecksum)
                .put("terminalDisposition", receipt.terminalDisposition)
                .put("deliveredAt", receipt.deliveredAt);
            String wireJson = BridgeAuthority.canonicalJson(wire);
            return wireJson.equals(receipt.wireJson)
                && BridgeAuthority.sha256CanonicalJson(wire).equals(receipt.idempotencyKey);
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public List<LifecycleControl> lifecycleControls() {
        List<LifecycleControl> result = new java.util.ArrayList<>();
        for (LifecycleControlEntity row : dao.lifecycleControls()) {
            validatePersistedLifecycleControl(row);
            result.add(LifecycleControl.fromEntity(row));
        }
        return result;
    }

    @Override
    public LifecycleControl lifecycleControl(String controlId) {
        if (controlId == null || controlId.trim().isEmpty()) return null;
        LifecycleControlEntity row = dao.lifecycleControl(controlId);
        if (row == null) return null;
        validatePersistedLifecycleControl(row);
        return LifecycleControl.fromEntity(row);
    }

    @Override
    public LifecycleControl claimLifecycleControl(long now) {
        if (now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("invalid lifecycle claim time");
        }
        AtomicReference<LifecycleControl> claimed = new AtomicReference<>();
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.nextLifecycleControl(
                now - LifecycleControlSender.LEASE_MILLIS,
                now > LifecycleControlSender.MAX_SAFE_INTEGER - LifecycleControlSender.REFRESH_WINDOW_MILLIS
                    ? LifecycleControlSender.MAX_SAFE_INTEGER
                    : now + LifecycleControlSender.REFRESH_WINDOW_MILLIS);
            if (row == null) return;
            validatePersistedLifecycleControl(row);
            long nextAttempt = row.leaseAttempt + 1L;
            if (nextAttempt <= 0L || nextAttempt > LifecycleControlSender.MAX_SAFE_INTEGER) {
                throw new IllegalStateException("lifecycle lease attempt exhausted");
            }
            String nextLeaseId = LifecycleControlSender.leaseId(
                LifecycleControl.fromEntity(row), nextAttempt);
            String expectedState = row.state;
            String nextRelayId = row.relayMessageId;
            Long nextRelayExpiry = row.relayExpiresAt;
            int updated = dao.claimLifecycleControlExact(
                row.controlId, row.semanticChecksum, expectedState,
                row.leaseId, row.leaseAttempt, row.leasedAt,
                row.relayMessageId, row.relayExpiresAt,
                LifecycleControl.PENDING, nextLeaseId, nextAttempt, now,
                nextRelayId, nextRelayExpiry, now);
            if (updated == 1) {
                claimed.set(LifecycleControl.fromEntity(dao.lifecycleControl(row.controlId)));
            }
        });
        return claimed.get();
    }

    @Override
    public boolean acceptLifecycleRelay(
        String controlId,
        String semanticChecksum,
        String leaseId,
        long leaseAttempt,
        long leasedAt,
        String relayMessageId,
        long relayExpiresAt,
        long now
    ) {
        if (controlId == null || semanticChecksum == null || leaseId == null
            || relayMessageId == null || now <= 0L
            || now > LifecycleControlSender.MAX_SAFE_INTEGER
            || !LifecycleControlSender.validRelayExpiry(now, relayExpiresAt)) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            String expectedRelayMessageId = LifecycleControlSender.relayMessageId(
                LifecycleControl.fromEntity(row));
            if (!expectedRelayMessageId.equals(relayMessageId)) return;
            if (LifecycleControl.RELAY_ACCEPTED.equals(row.state)
                && relayMessageId.equals(row.relayMessageId)
                && Long.valueOf(relayExpiresAt).equals(row.relayExpiresAt)) {
                result.set(true);
                return;
            }
            if (!LifecycleControl.PENDING.equals(row.state)
                || !leaseId.equals(row.leaseId) || row.leaseAttempt != leaseAttempt
                || row.leasedAt == null || row.leasedAt.longValue() != leasedAt
                || ((row.relayMessageId == null) != (row.relayExpiresAt == null))) return;
            result.set(dao.acceptLifecycleRelayExact(
                controlId, semanticChecksum, leaseId, leaseAttempt, leasedAt,
                row.relayMessageId, row.relayExpiresAt,
                relayMessageId, relayExpiresAt, now) == 1);
        });
        return result.get();
    }

    @Override
    public boolean applyLifecycleControl(
        String controlId,
        String semanticChecksum,
        Long clearEpoch,
        Long clearedThroughSequence,
        long appliedAt,
        long now
    ) {
        return applyLifecycleControl(
            controlId, semanticChecksum, clearEpoch, clearedThroughSequence,
            appliedAt, now, null);
    }

    @Override
    public boolean applyLifecycleControl(
        String controlId,
        String semanticChecksum,
        Long clearEpoch,
        Long clearedThroughSequence,
        long appliedAt,
        long now,
        String inboundRelayMessageId
    ) {
        if (controlId == null || semanticChecksum == null || appliedAt <= 0L
            || appliedAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            if (LifecycleControl.APPLIED.equals(row.state)) {
                if (row.appliedAt != null && row.appliedAt.longValue() == appliedAt) {
                    if (Objects.equals(row.clearEpoch, clearEpoch)
                        && Objects.equals(row.clearedThroughSequence, clearedThroughSequence)) {
                        result.set(true);
                    } else {
                        result.set(recordAppliedAckConflictInTransaction(
                            row, semanticChecksum, inboundRelayMessageId, now));
                    }
                    return;
                }
                result.set(recordAppliedAckConflictInTransaction(
                    row, semanticChecksum, inboundRelayMessageId, now));
                return;
            }
            if (!Objects.equals(row.clearEpoch, clearEpoch)
                || !Objects.equals(row.clearedThroughSequence, clearedThroughSequence)) return;
            boolean lan = row.relayMessageId == null && row.relayExpiresAt == null;
            boolean cloud = row.state.equals(LifecycleControl.RELAY_ACCEPTED)
                && row.relayMessageId != null && row.relayExpiresAt != null;
            if (!(lan || cloud) || (lan && !LifecycleControl.PENDING.equals(row.state))
                || now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER) return;
            result.set(dao.applyLifecycleControlExact(
                controlId, semanticChecksum, row.state, row.leaseId, row.leaseAttempt,
                row.leasedAt, row.relayMessageId, row.relayExpiresAt,
                row.relayMessageId, row.relayExpiresAt, appliedAt, now) == 1);
        });
        return result.get();
    }

    @Override
    public boolean applyLifecycleControl(
        String controlId,
        String semanticChecksum,
        Long clearEpoch,
        Long clearedThroughSequence,
        String leaseId,
        long leaseAttempt,
        Long leasedAt,
        long appliedAt,
        long now
    ) {
        if (controlId == null || semanticChecksum == null || leaseId == null
            || leaseId.trim().isEmpty() || leaseAttempt <= 0L
            || leaseAttempt > LifecycleControlSender.MAX_SAFE_INTEGER
            || leasedAt == null || leasedAt <= 0L
            || leasedAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || appliedAt <= 0L || appliedAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            if (!LifecycleControl.PENDING.equals(row.state)
                || !leaseId.equals(row.leaseId)
                || row.leaseAttempt != leaseAttempt
                || row.leasedAt == null || row.leasedAt.longValue() != leasedAt
                || row.relayMessageId != null || row.relayExpiresAt != null
                || !Objects.equals(row.clearEpoch, clearEpoch)
                || !Objects.equals(row.clearedThroughSequence, clearedThroughSequence)) return;
            result.set(dao.applyLifecycleControlExact(
                controlId, semanticChecksum, LifecycleControl.PENDING,
                leaseId, leaseAttempt, leasedAt, null, null,
                null, null, appliedAt, now) == 1);
        });
        return result.get();
    }

    @Override
    public boolean recordLifecycleAppliedAckConflict(
        String controlId,
        String expectedControlChecksum,
        String conflictChecksum,
        String inboundRelayMessageId,
        long now
    ) {
        if (controlId == null || expectedControlChecksum == null || now <= 0L
            || now > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !expectedControlChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            result.set(recordAppliedAckConflictInTransaction(
                row, conflictChecksum, inboundRelayMessageId, now));
        });
        return result.get();
    }

    @Override
    public boolean recordUnknownLifecycleAckTerminal(
        String peerId,
        String inboundRelayMessageId,
        long relayExpiresAt,
        String controlId,
        String controlChecksum,
        String ackChecksum,
        long createdAt
    ) {
        if (storeOwnedPeerId == null || storeOwnedPeerId.isEmpty()
            || !storeOwnedPeerId.equals(peerId)) {
            throw new IllegalArgumentException("lifecycle unknown ACK peer is not store-owned");
        }
        requireBridgeIdentity(peerId, "lifecycle unknown ACK peer");
        requireBridgeIdentity(inboundRelayMessageId, "lifecycle unknown ACK relay");
        requireBridgeIdentity(controlId, "lifecycle unknown ACK control");
        requireLowerSha(controlChecksum, "lifecycle unknown ACK control checksum");
        requireLowerSha(ackChecksum, "lifecycle unknown ACK checksum");
        if (createdAt <= 0L || createdAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || relayExpiresAt <= createdAt
            || relayExpiresAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || !LifecycleControlSender.validRelayExpiry(createdAt, relayExpiresAt)) {
            throw new IllegalArgumentException("lifecycle unknown ACK relay expiry conflict");
        }
        final String reasonCode = "unknown_control";
        final String ackKey = unknownLifecycleAckKey(
            peerId, inboundRelayMessageId, relayExpiresAt,
            controlId, controlChecksum, ackChecksum, reasonCode);
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleInboundAckTombstoneEntity existing =
                dao.lifecycleInboundAckTombstone(peerId, inboundRelayMessageId);
            if (existing != null) {
                if (!ackKey.equals(existing.ackKey)
                    || existing.relayExpiresAt != relayExpiresAt
                    || !controlId.equals(existing.controlId)
                    || !controlChecksum.equals(existing.controlChecksum)
                    || !ackChecksum.equals(existing.ackChecksum)
                    || !reasonCode.equals(existing.reasonCode)) {
                    throw new IllegalArgumentException("lifecycle unknown ACK authority conflict");
                }
                result.set(true);
                return;
            }
            LifecycleInboundAckTombstoneEntity row = new LifecycleInboundAckTombstoneEntity();
            row.ackKey = ackKey;
            row.peerId = peerId;
            row.inboundRelayMessageId = inboundRelayMessageId;
            row.relayExpiresAt = relayExpiresAt;
            row.controlId = controlId;
            row.controlChecksum = controlChecksum;
            row.ackChecksum = ackChecksum;
            row.reasonCode = reasonCode;
            row.createdAt = createdAt;
            long inserted = dao.insertLifecycleInboundAckTombstone(row);
            if (inserted == -1L) {
                LifecycleInboundAckTombstoneEntity raced =
                    dao.lifecycleInboundAckTombstone(peerId, inboundRelayMessageId);
                if (raced == null || !ackKey.equals(raced.ackKey)
                    || raced.relayExpiresAt != relayExpiresAt
                    || !controlId.equals(raced.controlId)
                    || !controlChecksum.equals(raced.controlChecksum)
                    || !ackChecksum.equals(raced.ackChecksum)
                    || !reasonCode.equals(raced.reasonCode)) {
                    throw new IllegalArgumentException("lifecycle unknown ACK authority conflict");
                }
            }
            result.set(true);
        });
        return result.get();
    }

    private static String unknownLifecycleAckKey(
        String peerId, String inboundRelayMessageId, long relayExpiresAt,
        String controlId, String controlChecksum, String ackChecksum, String reasonCode
    ) {
        try {
            JSONObject basis = new JSONObject()
                .put("contract", "android-lifecycle-unknown-applied-ack-v1")
                .put("peerId", peerId)
                .put("inboundRelayMessageId", inboundRelayMessageId)
                .put("relayExpiresAt", relayExpiresAt)
                .put("controlId", controlId)
                .put("controlChecksum", controlChecksum)
                .put("ackChecksum", ackChecksum)
                .put("reasonCode", reasonCode);
            return BridgeAuthority.sha256CanonicalJson(basis);
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle unknown ACK key failed", error);
        }
    }

    private static void requireLowerSha(String value, String name) {
        if (value == null || !value.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException(name);
        }
    }

    private boolean recordAppliedAckConflictInTransaction(
        LifecycleControlEntity row,
        String conflictChecksum,
        String inboundRelayMessageId,
        long now
    ) {
        if (row == null || !LifecycleControl.APPLIED.equals(row.state)) return false;
        String detail = lifecycleAppliedAckConflictDetail(
            row.controlId, inboundRelayMessageId, conflictChecksum);
        if (dao.diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail) == 0) {
            insertDiagnostic(
                "lifecycle-control", null, "WARN",
                "LIFECYCLE_CONTROL_QUARANTINED", detail, now);
        }
        // The persisted APPLIED proof remains the authority.  The changed inbound
        // proof is handled as closed and may now be ACKed without re-polling it.
        return true;
    }

    @Override
    public boolean quarantineLifecycleControl(String controlId, String semanticChecksum, long now) {
        if (controlId == null || semanticChecksum == null || now <= 0L
            || now > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            if (LifecycleControl.QUARANTINED.equals(row.state)) {
                result.set(true);
                return;
            }
            // The legacy three-argument entry point has no lease snapshot and
            // therefore can only operate on an unleased waiting row.  Pending
            // rows must use the exact lease overload below; otherwise an old
            // worker could quarantine a replacement worker's lease.
            if (!LifecycleControl.WAITING.equals(row.state)
                || row.leaseAttempt != 0L || row.leaseId != null || row.leasedAt != null
                || row.relayMessageId != null || row.relayExpiresAt != null) return;
            result.set(dao.quarantineLifecycleControlExact(
                controlId, semanticChecksum, row.state, row.leaseId, row.leaseAttempt,
                row.leasedAt, row.relayMessageId, row.relayExpiresAt, now) == 1);
        });
        return result.get();
    }

    @Override
    public boolean quarantineLifecycleControl(
        String controlId,
        String semanticChecksum,
        String leaseId,
        long leaseAttempt,
        Long leasedAt,
        long now
    ) {
        if (controlId == null || semanticChecksum == null || leaseId == null
            || leaseId.trim().isEmpty() || leaseAttempt <= 0L
            || leaseAttempt > LifecycleControlSender.MAX_SAFE_INTEGER
            || leasedAt == null || leasedAt <= 0L
            || leasedAt > LifecycleControlSender.MAX_SAFE_INTEGER
            || now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            if (!LifecycleControl.PENDING.equals(row.state)
                || !leaseId.equals(row.leaseId)
                || row.leaseAttempt != leaseAttempt
                || row.leasedAt == null || row.leasedAt.longValue() != leasedAt
                || row.relayMessageId != null || row.relayExpiresAt != null) return;
            result.set(dao.quarantineLifecycleControlExact(
                controlId, semanticChecksum, LifecycleControl.PENDING,
                leaseId, leaseAttempt, leasedAt, null, null, now) == 1);
        });
        return result.get();
    }

    @Override
    public boolean quarantineLifecycleRelayAcceptedExact(
        String controlId, String semanticChecksum,
        String relayMessageId, long relayExpiresAt, long now
    ) {
        return quarantineLifecycleRelayAcceptedExact(
            controlId, semanticChecksum, relayMessageId, relayExpiresAt,
            null, null, now);
    }

    @Override
    public boolean quarantineLifecycleRelayAcceptedExact(
        String controlId,
        String semanticChecksum,
        String relayMessageId,
        long relayExpiresAt,
        String inboundRelayMessageId,
        String conflictChecksum,
        long now
    ) {
        if (controlId == null || semanticChecksum == null || relayMessageId == null
            || now <= 0L || now > LifecycleControlSender.MAX_SAFE_INTEGER
            || relayExpiresAt <= 0L || relayExpiresAt > LifecycleControlSender.MAX_SAFE_INTEGER) return false;
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        database.runInTransaction(() -> {
            LifecycleControlEntity row = dao.lifecycleControl(controlId);
            if (row == null || !semanticChecksum.equals(row.semanticChecksum)) return;
            validatePersistedLifecycleControl(row);
            String detail = lifecycleAppliedAckConflictDetail(
                row.controlId, inboundRelayMessageId, conflictChecksum);
            if (LifecycleControl.QUARANTINED.equals(row.state)) {
                result.set(dao.diagnosticCountByCodeAndDetail(
                    "LIFECYCLE_CONTROL_QUARANTINED", detail) == 1);
                return;
            }
            if (!LifecycleControl.RELAY_ACCEPTED.equals(row.state)
                || !relayMessageId.equals(row.relayMessageId)
                || row.relayExpiresAt == null || row.relayExpiresAt.longValue() != relayExpiresAt) return;
            boolean quarantined = dao.quarantineLifecycleRelayAcceptedExact(
                controlId, semanticChecksum, relayMessageId, relayExpiresAt, now) == 1;
            if (!quarantined) return;
            if (dao.diagnosticCountByCodeAndDetail("LIFECYCLE_CONTROL_QUARANTINED", detail) == 0) {
                insertDiagnostic(
                    "lifecycle-control", null, "WARN", "LIFECYCLE_CONTROL_QUARANTINED", detail, now);
            }
            result.set(true);
        });
        return result.get();
    }

    private static String lifecycleAppliedAckConflictDetail(
        String controlId, String inboundRelayMessageId, String conflictChecksum
    ) {
        try {
            return BridgeAuthority.canonicalJson(new JSONObject()
                .put("redacted", true)
                .put("reason", "applied_ack_conflict")
                .put("controlId", limit(controlId, 96))
                .put("inboundRelayMessageId",
                    inboundRelayMessageId == null ? JSONObject.NULL : limit(inboundRelayMessageId, 96))
                .put("controlChecksum", LifecycleControlSender.appliedAckConflictChecksum(
                    conflictChecksum)));
        } catch (JSONException error) {
            throw new IllegalStateException("lifecycle ACK diagnostic serialization conflict", error);
        }
    }

    @Override
    public void markCloudConfirmed(String turnId, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            assertRoleAcceptsSemanticWrite(turn.characterId);
            if (turn.cloudConfirmedAt != null) return;
            if (turn.uiAppliedAt == null) {
                throw new IllegalStateException("Cannot confirm cloud delivery before UI landing for " + turnId);
            }
            if (dao.markCloudConfirmed(turnId, now) != 1) {
                throw new IllegalStateException("Unable to record cloud confirmation for " + turnId);
            }
        });
    }

    @Override
    public ChatTurnEntity claimNext(long now) {
        return dao.nextRunnableTurn();
    }

    @Override
    public List<ExecutionAttemptEntity> recoverableAttempts() {
        return dao.recoverableAttempts();
    }

    @Override
    public void markStage(
        String turnId,
        String attemptId,
        TurnState state,
        AttemptStage stage,
        long now
    ) {
        dao.markStage(turnId, attemptId, state.name(), stage.name(), now);
        String code = state == TurnState.MEMORY_RUNNING ? "MEMORY_STARTED"
            : state == TurnState.CHAT_RUNNING ? "CHAT_STARTED"
            : "STAGE_CHANGED";
        insertDiagnostic(turnId, attemptId, "INFO", code, state.name(), now);
    }

    @Override
    public void markBridgeWaiting(String turnId, String attemptId, String route, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (!attemptId.equals(turn.activeAttemptId)
                || !TurnState.MEMORY_RUNNING.name().equals(turn.state)) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            dao.markStage(
                turnId,
                attemptId,
                TurnState.BRIDGE_WAITING.name(),
                AttemptStage.BRIDGE.name(),
                now
            );
            String safeRoute = "cloud".equals(route) ? "cloud" : "bridge";
            insertDiagnostic(
                turnId,
                attemptId,
                "INFO",
                "BRIDGE_STATUS",
                "{\"route\":\"" + safeRoute + "\",\"displayStage\":\"消息已到云端，正在等待电脑接收…\","
                    + "\"technicalStage\":\"cloud_accepted\"}",
                now
            );
        });
    }

    @Override
    public void saveMemoryResult(String turnId, String attemptId, String memory, long now) {
        dao.saveMemoryCheckpoint(turnId, attemptId, memory, now);
        insertDiagnostic(turnId, attemptId, "INFO", "MEMORY_DONE", "memory checkpoint saved", now);
    }

    @Override
    public void saveRawReply(String turnId, String attemptId, String rawReply, long now) {
        dao.saveRawReplyCheckpoint(turnId, attemptId, rawReply, now);
        insertDiagnostic(turnId, attemptId, "INFO", "CHAT_DONE", "chat checkpoint saved", now);
    }

    @Override
    public void markInterrupted(String turnId, String attemptId, String code, long now) {
        database.runInTransaction(() -> {
            ChatTurnEntity turn = requireTurn(turnId);
            if (!attemptId.equals(turn.activeAttemptId)) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            dao.markTurnFailed(turnId, attemptId, TurnState.INTERRUPTED.name(), now);
            dao.markAttemptFailed(
                attemptId,
                TurnState.INTERRUPTED.name(),
                code,
                "The process stopped while the chat request outcome was unknown",
                true,
                now
            );
            insertTurnChange(turnId, "TURN_INTERRUPTED", now);
        });
    }

    private ConversationCursorEntity cursorFor(String characterId, long now) {
        String safeCharacterId = requireCharacterId(characterId);
        ConversationCursorEntity cursor = dao.conversationCursor(safeCharacterId);
        if (cursor != null) return cursor;
        cursor = new ConversationCursorEntity();
        cursor.characterId = safeCharacterId;
        cursor.updatedAt = now;
        if (dao.insertConversationCursor(cursor) != -1L) return cursor;
        ConversationCursorEntity existing = dao.conversationCursor(safeCharacterId);
        if (existing == null) throw new IllegalStateException("Unable to create conversation cursor for " + safeCharacterId);
        return existing;
    }

    private void saveCursor(ConversationCursorEntity cursor) {
        if (dao.updateConversationCursor(
            cursor.characterId,
            cursor.nativeCompletedTurnId,
            cursor.nativeCompletedGroupId,
            cursor.nativeCompletedSequence,
            cursor.uiAppliedTurnId,
            cursor.uiAppliedGroupId,
            cursor.uiAppliedSequence,
            cursor.localSequence,
            cursor.clearedThroughSequence,
            cursor.clearEpoch,
            cursor.clearedAt,
            cursor.chatOpen,
            cursor.updatedAt
        ) != 1) throw new IllegalStateException("Unable to update conversation cursor for " + cursor.characterId);
    }

    private void applyCanonicalCursor(
        ConversationCursorEntity cursor,
        String localTurnId,
        BridgeResult result,
        boolean applyUi,
        long now
    ) {
        long sequence = result.inputVisibilitySequence;
        cursor.localSequence = Math.max(cursor.localSequence, sequence);
        if (sequence > cursor.nativeCompletedSequence) {
            cursor.nativeCompletedTurnId = localTurnId;
            cursor.nativeCompletedGroupId = result.visibleGroupId;
            cursor.nativeCompletedSequence = sequence;
        } else if (sequence == cursor.nativeCompletedSequence
            && (!localTurnId.equals(cursor.nativeCompletedTurnId)
                || !result.visibleGroupId.equals(cursor.nativeCompletedGroupId))) {
            throw bridgeAuthorityConflict(localTurnId);
        }
        cursor.updatedAt = now;
        saveCursor(cursor);
        terminalFaultHook.after(FAULT_NATIVE_CURSOR);
        if (applyUi) {
            if (sequence > cursor.uiAppliedSequence) {
                cursor.uiAppliedTurnId = localTurnId;
                cursor.uiAppliedGroupId = result.visibleGroupId;
                cursor.uiAppliedSequence = sequence;
            } else if (sequence == cursor.uiAppliedSequence
                && (!localTurnId.equals(cursor.uiAppliedTurnId)
                    || !result.visibleGroupId.equals(cursor.uiAppliedGroupId))) {
                throw bridgeAuthorityConflict(localTurnId);
            }
            cursor.updatedAt = now;
            saveCursor(cursor);
            terminalFaultHook.after(FAULT_UI_CURSOR);
        }
    }

    private void assertCanonicalCursorAfterReplay(ChatTurnEntity turn, BridgeResult result) {
        ConversationCursorEntity cursor = dao.conversationCursor(turn.characterId);
        if (cursor == null || cursor.localSequence < result.inputVisibilitySequence
            || cursor.nativeCompletedSequence < result.inputVisibilitySequence) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if (cursor.nativeCompletedSequence == result.inputVisibilitySequence
            && (!turn.turnId.equals(cursor.nativeCompletedTurnId)
                || !result.visibleGroupId.equals(cursor.nativeCompletedGroupId))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if ("skip".equals(result.terminalDisposition)) {
            if (cursor.uiAppliedSequence < result.inputVisibilitySequence) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (cursor.uiAppliedSequence == result.inputVisibilitySequence
                && (!turn.turnId.equals(cursor.uiAppliedTurnId)
                    || !result.visibleGroupId.equals(cursor.uiAppliedGroupId))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }
    }

    private static JSONObject terminalOutcome(
        BridgeResult result,
        boolean redacted,
        long now
    ) throws Exception {
        return new JSONObject()
            .put("type", redacted ? "redacted" : "committed")
            .put("route", result.deliveryRoute)
            .put("relayMessageId", result.relayMessageId == null ? JSONObject.NULL : result.relayMessageId)
            .put("failure", JSONObject.NULL)
            .put("result", redacted ? canonicalResultMetadata(result) : result.authorityPayload())
            .put("redactedAt", redacted ? now : JSONObject.NULL);
    }

    private List<ReplyPartEntity> buildLocalFallbackParts(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        List<ReplyPartEntity> supplied,
        String visibleGroupId,
        String terminalDisposition,
        long now
    ) throws Exception {
        List<ReplyPartEntity> committed = new java.util.ArrayList<>();
        int textOrdinal = 0;
        int actionOrdinal = 0;
        Set<String> singleCompatibility = new HashSet<>();
        JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
        for (int index = 0; index < supplied.size(); index += 1) {
            ReplyPartEntity source = supplied.get(index);
            if (source == null || !turn.turnId.equals(source.turnId)
                || !attempt.attemptId.equals(source.attemptId)
                || source.sequence != index || source.type == null
                || source.content == null || source.payloadJson == null) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (!"TEXT".equals(source.type)) {
                List<JSONObject> actions = localFallbackActions(
                    turn, checkpoint, source, visibleGroupId, actionOrdinal, singleCompatibility);
                for (JSONObject action : actions) {
                    validateGeneratedLocalAction(turn, checkpoint, action);
                    ActionProjection projection = projectCanonicalAction(action, singleCompatibility);
                    ReplyPartEntity row = new ReplyPartEntity();
                    row.replyPartId = action.getString("actionId");
                    row.turnId = turn.turnId;
                    row.attemptId = attempt.attemptId;
                    row.sequence = textOrdinal + actionOrdinal;
                    row.type = projection.type;
                    row.content = "";
                    row.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
                        .put("version", 2)
                        .put("canonicalAction", action)
                        .put("legacyPayload", projection.legacyPayload));
                    row.createdAt = now;
                    committed.add(row);
                    actionOrdinal += 1;
                }
                continue;
            }
            if (actionOrdinal != 0) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (source.content.trim().isEmpty()
                || !BridgeAuthority.canonicalJson(new JSONObject(source.payloadJson)).equals("{}")) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            ReplyPartEntity row = new ReplyPartEntity();
            row.replyPartId = AuthorityIdentity.messageId(visibleGroupId, textOrdinal);
            row.turnId = turn.turnId;
            row.attemptId = attempt.attemptId;
            row.sequence = textOrdinal;
            row.type = "TEXT";
            row.content = source.content;
            row.payloadJson = "{}";
            row.createdAt = now;
            committed.add(row);
            textOrdinal += 1;
        }
        if ("visible".equals(terminalDisposition) && textOrdinal == 0) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if ("action_only".equals(terminalDisposition)
            && (textOrdinal != 0 || actionOrdinal == 0)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if ("skip".equals(terminalDisposition) && !committed.isEmpty()) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        return committed;
    }

    static void validateGeneratedLocalAction(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        JSONObject action
    ) throws Exception {
        LocalFallbackActionAuthority.validateAgainstPinnedInput(
            action.getString("kind"),
            action.getString("targetKey"),
            action.getString("targetRevision"),
            action.getJSONObject("payload"),
            turn.characterId,
            checkpoint.getString("authorityLineageKey"),
            checkpoint.getLong("claimedLineageRevision"),
            checkpointEnvelope(checkpoint));
    }

    private List<JSONObject> localFallbackActions(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        ReplyPartEntity source,
        String visibleGroupId,
        int firstOrdinal,
        Set<String> singleCompatibility
    ) throws Exception {
        JSONObject legacy = new JSONObject(source.payloadJson);
        List<JSONObject> actions = new java.util.ArrayList<>();
        if ("PAYMENT_STATUS".equals(source.type)) {
            if (!new HashSet<>(Arrays.asList("status")).equals(keysOf(legacy))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            String status = legacy.getString("status");
            if (!("received".equals(status) || "refused".equals(status))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject payment = checkpointEnvelope(checkpoint)
                .getJSONObject("context").getJSONObject("payment");
            String messageId = payment.getString("messageId");
            JSONObject payload = new JSONObject().put("messageId", messageId);
            actions.add(localCanonicalAction(
                visibleGroupId, firstOrdinal,
                "received".equals(status) ? "payment_accept" : "payment_decline",
                "payment:" + messageId,
                "sha256:" + BridgeAuthority.sha256CanonicalJson(payment),
                payload));
            return actions;
        }
        if ("MOMENT_ACTION".equals(source.type)) {
            String momentId = legacy.getString("momentId");
            boolean like = legacy.opt("like") instanceof Boolean && legacy.getBoolean("like");
            String comment = legacy.opt("comment") instanceof String
                ? legacy.getString("comment") : "";
            Object rawReply = legacy.opt("replyToCommentId");
            String replyToCommentId = rawReply instanceof String && !((String) rawReply).isEmpty()
                ? (String) rawReply : null;
            String kind;
            String namespace;
            String targetId;
            if (replyToCommentId != null && !comment.trim().isEmpty() && !like) {
                kind = "moment_reply";
                namespace = "comment";
                targetId = replyToCommentId;
            } else if (!comment.trim().isEmpty() && replyToCommentId == null) {
                kind = "moment_comment";
                namespace = "moment";
                targetId = momentId;
            } else if (like && comment.isEmpty() && replyToCommentId == null) {
                kind = "moment_like";
                namespace = "moment";
                targetId = momentId;
            } else {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject triggerInput = checkpointEnvelope(checkpoint)
                .getJSONObject("trigger").getJSONObject("context").getJSONObject("input");
            JSONObject target = "comment".equals(namespace)
                ? triggerInput.getJSONObject("targetComment")
                : triggerInput.getJSONObject("targetMoment");
            String targetField = "comment".equals(namespace) ? "commentId" : "momentId";
            if (!targetId.equals(target.getString(targetField))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject payload = new JSONObject()
                .put("momentId", momentId)
                .put("like", like)
                .put("comment", comment)
                .put("replyToCommentId", replyToCommentId == null ? JSONObject.NULL : replyToCommentId);
            actions.add(localCanonicalAction(
                visibleGroupId, firstOrdinal, kind, namespace + ":" + targetId,
                "sha256:" + BridgeAuthority.sha256CanonicalJson(target), payload));
            return actions;
        }
        if ("RELATIONSHIP_STAGE".equals(source.type)) {
            JSONObject envelope = checkpointEnvelope(checkpoint);
            JSONObject scene = envelope.optJSONObject("context") == null
                ? null : envelope.getJSONObject("context").optJSONObject("scene");
            if (scene == null && envelope.optJSONObject("trigger") != null) {
                scene = envelope.getJSONObject("trigger").getJSONObject("context")
                    .optJSONObject("scene");
            }
            if (scene == null || !(scene.opt("stagePersonaRevision") instanceof Number)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            long revision = exactSafeInteger(scene, "stagePersonaRevision", false);
            if (legacy.optLong("expectedSceneRevision", -1L) != revision
                || !(legacy.opt("baseAction") instanceof JSONObject || legacy.isNull("baseAction"))
                || !(legacy.opt("phaseAction") instanceof JSONObject || legacy.isNull("phaseAction"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject relationship = scene.getJSONObject("relationshipStage");
            JSONObject target = new JSONObject()
                .put("relationshipStage", relationship)
                .put("stagePersonaRevision", revision);
            actions.add(localCanonicalAction(
                visibleGroupId, firstOrdinal, "relationship_transition",
                "relationship:" + turn.characterId,
                "sha256:" + BridgeAuthority.sha256CanonicalJson(target),
                new JSONObject(legacy.toString())));
            return actions;
        }
        if ("PLAN".equals(source.type)) {
            JSONArray operations = legacy.getJSONArray("operations");
            if (operations.length() == 0) throw bridgeAuthorityConflict(turn.turnId);
            JSONObject envelope = checkpointEnvelope(checkpoint);
            JSONObject context = envelope.optJSONObject("context");
            if (context == null && envelope.optJSONObject("trigger") != null) {
                context = envelope.getJSONObject("trigger").getJSONObject("context");
            }
            JSONObject triggerInput = context == null ? null : context.optJSONObject("input");
            for (int index = 0; index < operations.length(); index += 1) {
                JSONObject operation = new JSONObject(operations.getJSONObject(index).toString());
                String op = operation.getString("op");
                if (!Arrays.asList("create", "update", "cancel", "pause", "resume", "complete")
                    .contains(op)) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                String kind = "role_plan_" + op;
                String targetKey;
                String targetRevision;
                if ("create".equals(op)) {
                    targetKey = "lineage_create:" + checkpoint.getString("authorityLineageKey")
                        + ":" + kind;
                    targetRevision = String.valueOf(checkpoint.getLong("claimedLineageRevision"));
                } else {
                    String planId = operation.getString("planId");
                    JSONObject rolePlan = triggerInput == null ? null : triggerInput.optJSONObject("rolePlan");
                    if (rolePlan == null || !planId.equals(rolePlan.optString("planId", ""))) {
                        throw bridgeAuthorityConflict(turn.turnId);
                    }
                    targetKey = "role_plan:" + planId;
                    targetRevision = "sha256:" + BridgeAuthority.sha256CanonicalJson(rolePlan);
                }
                actions.add(localCanonicalAction(
                    visibleGroupId, firstOrdinal + actions.size(), kind,
                    targetKey, targetRevision, operation));
            }
            return actions;
        }
        throw bridgeAuthorityConflict(turn.turnId);
    }

    private static JSONObject localCanonicalAction(
        String visibleGroupId,
        int ordinal,
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload
    ) throws Exception {
        LocalFallbackActionAuthority.validate(kind, targetKey, targetRevision, payload);
        JSONObject semantic = new JSONObject()
            .put("kind", kind)
            .put("targetKey", targetKey)
            .put("targetRevision", targetRevision)
            .put("payload", new JSONObject(payload.toString()));
        return new JSONObject()
            .put("actionId", AuthorityIdentity.actionId(visibleGroupId, ordinal))
            .put("ordinal", ordinal)
            .put("kind", kind)
            .put("targetKey", targetKey)
            .put("targetRevision", targetRevision)
            .put("payload", new JSONObject(payload.toString()))
            .put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
    }

    private static JSONObject localFallbackReceipt(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        FallbackCognitionPacketCodec.FallbackContext fallback,
        List<ReplyPartEntity> parts,
        String terminalDisposition,
        String visibleGroupId,
        long journalSyncSeq,
        long now
    ) throws Exception {
        JSONObject envelope = checkpointEnvelope(checkpoint);
        JSONObject authority = envelope.getJSONObject("authority");
        JSONObject compactSemantic = new JSONObject(fallback.semanticView.toString());
        String contractChecksum = BridgeAuthority.sha256CanonicalJson(new JSONObject()
            .put("contract", "cognition-v3-fallback-v1")
            .put("codecVersion", 1));
        JSONObject release = new JSONObject()
            .put("releaseId", "android_fallback:" + contractChecksum)
            .put("contract", "cognition-v3-fallback-v1")
            .put("codecVersion", 1)
            .put("contractChecksum", contractChecksum);
        release.put("releaseChecksum", BridgeAuthority.sha256CanonicalJson(new JSONObject()
            .put("origin", "android_fallback")
            .put("contract", "cognition-v3-fallback-v1")
            .put("contractChecksum", contractChecksum)
            .put("codecVersion", 1)));

        JSONArray replyItems = new JSONArray();
        JSONArray visibleItems = new JSONArray();
        JSONArray actions = new JSONArray();
        long visibleSentAt = localFallbackVisibleSentAt(envelope);
        for (ReplyPartEntity part : parts) {
            if (!"TEXT".equals(part.type)) {
                JSONObject canonical = new JSONObject(part.payloadJson)
                    .getJSONObject("canonicalAction");
                actions.put(new JSONObject()
                    .put("actionId", canonical.getString("actionId"))
                    .put("ordinal", canonical.getLong("ordinal"))
                    .put("kind", canonical.getString("kind"))
                    .put("targetKey", canonical.getString("targetKey"))
                    .put("targetRevision", canonical.getString("targetRevision"))
                    .put("payload", new JSONObject(canonical.getJSONObject("payload").toString()))
                    .put("checksum", canonical.getString("actionChecksum")));
                continue;
            }
            JSONObject message = new JSONObject()
                .put("messageId", part.replyPartId)
                .put("speakerId", turn.characterId)
                .put("speakerType", "character")
                .put("recipientId", "user")
                .put("content", part.content)
                .put("sentAt", visibleSentAt)
                .put("attachments", new JSONArray());
            replyItems.put(new JSONObject()
                .put("ordinal", replyItems.length())
                .put("messageId", part.replyPartId)
                .put("message", message)
                .put("checksum", BridgeAuthority.sha256CanonicalJson(message)));
            visibleItems.put(new JSONObject(message.toString()));
        }
        JSONObject input = localFallbackInput(turn, checkpoint, actions);
        JSONObject semantic = new JSONObject()
            .put("protocolVersion", 2)
            .put("contract", "android-fallback-authority-v2")
            .put("authorityOrigin", "android_fallback")
            .put("roleId", turn.characterId)
            .put("laneKey", checkpoint.getString("laneKey"))
            .put("rootSourceId", authority.getString("rootSourceId"))
            .put("authorityLineageKey", checkpoint.getString("authorityLineageKey"))
            .put("authoritativeTurnId", checkpoint.getString("authoritativeTurnId"))
            .put("lineageRevisionAtCreation", checkpoint.getLong("claimedLineageRevision"))
            .put("retryOfTurnId", checkpoint.get("retryOfTurnId"))
            .put("turnRevision", attempt.sequence)
            .put("deviceId", envelope.getString("deviceId"))
            .put("turnKind", turn.kind)
            .put("terminalDisposition", terminalDisposition)
            .put("input", input)
            .put("compactSemanticSnapshot", compactSemantic)
            .put("agencySnapshotChecksum", BridgeAuthority.sha256CanonicalJson(compactSemantic))
            .put("visibleGroupId", visibleGroupId)
            .put("replyItems", replyItems)
            .put("visibleItems", visibleItems)
            .put("actions", actions)
            .put("release", release)
            .put("journalSyncSeq", journalSyncSeq);
        String commitChecksum = BridgeAuthority.sha256CanonicalJson(semantic);
        JSONObject manifest = new JSONObject()
            .put("payloadVersion", "android-fallback-commit-v2")
            .put("authorityOrigin", "android_fallback")
            .put("semantic", new JSONObject(semantic.toString()))
            .put("commitChecksum", commitChecksum);
        return new JSONObject()
            .put("receiptVersion", 2)
            .put("semantic", semantic)
            .put("manifest", manifest)
            .put("commitChecksum", commitChecksum);
    }

    static JSONObject localFallbackInput(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        JSONArray actions
    ) throws Exception {
        JSONObject envelope = checkpointEnvelope(checkpoint);
        JSONObject input;
        if (TurnKind.DIRECT_REPLY.name().equals(turn.kind)) {
            JSONObject batch = envelope.getJSONObject("context").getJSONObject("currentBatch");
            JSONArray messages = batch.getJSONArray("messages");
            JSONArray ids = batch.getJSONArray("messageIds");
            if (messages.length() == 0 || messages.length() != ids.length()) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONArray items = new JSONArray();
            for (int index = 0; index < messages.length(); index += 1) {
                JSONObject message = new JSONObject(messages.getJSONObject(index).toString());
                if (!ids.getString(index).equals(message.getString("messageId"))) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                items.put(new JSONObject()
                    .put("sequence", index)
                    .put("messageId", message.getString("messageId"))
                    .put("message", message)
                    .put("checksum", BridgeAuthority.sha256CanonicalJson(message)));
            }
            JSONObject batchHeader = new JSONObject()
                .put("batchId", batch.getString("batchId"))
                .put("sourceMessageId", turn.sourceMessageId)
                .put("messageIds", new JSONArray(ids.toString()))
                .put("startedAt", batch.getLong("startedAt"))
                .put("committedAt", batch.getLong("committedAt"));
            JSONObject normalizedBatch = new JSONObject()
                .put("batchId", batch.getString("batchId"))
                .put("characterId", turn.characterId)
                .put("sourceMessageId", turn.sourceMessageId)
                .put("startedAt", batch.getLong("startedAt"))
                .put("committedAt", batch.getLong("committedAt"))
                .put("checksum", BridgeAuthority.sha256CanonicalJson(batchHeader))
                .put("items", items);
            input = new JSONObject()
                .put("kind", "direct")
                .put("batch", normalizedBatch)
                .put("visibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
                .put("clearEpoch", checkpoint.getLong("inputClearEpoch"));
            if (actions != null && actions.length() > 0) {
                input.put("pinnedActionContext",
                    LocalFallbackActionAuthority.receiptActionContext(envelope, actions));
            }
        } else {
            JSONObject trigger = new JSONObject(envelope.getJSONObject("trigger").toString());
            input = new JSONObject()
                .put("kind", "automatic")
                .put("trigger", trigger)
                .put("visibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
                .put("clearEpoch", checkpoint.getLong("inputClearEpoch"));
        }
        if ("automatic".equals(input.getString("kind"))) {
            input.put("checksum", BridgeAuthority.sha256CanonicalJson(
                new JSONObject(input.toString())));
        } else {
            input.put("checksum", input.getJSONObject("batch").getString("checksum"));
        }
        return input;
    }

    private static long localFallbackVisibleSentAt(JSONObject envelope) throws Exception {
        if (envelope.optJSONObject("trigger") != null) {
            return exactSafeInteger(envelope.getJSONObject("trigger"), "executedAt", true);
        }
        return exactSafeInteger(envelope, "createdAt", true);
    }

    private DeliveryDisposition validateExactLocalFallbackReplay(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        List<ReplyPartEntity> supplied,
        String terminalDisposition
    ) throws Exception {
        JSONObject validated = validateLocalCheckpoint(turn, attempt, checkpoint, true);
        JSONObject outcome = validated.getJSONObject("outcome");
        if ("redacted".equals(outcome.getString("type"))) {
            JSONObject metadata = outcome.getJSONObject("result");
            if (!terminalDisposition.equals(metadata.getString("draftDisposition"))
                || dao.replyPartCount(turn.turnId) != 0) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return DeliveryDisposition.REDACTED;
        }
        JSONObject receipt = outcome.getJSONObject("result");
        JSONObject semantic = receipt.getJSONObject("semantic");
        if (!terminalDisposition.equals(semantic.getString("terminalDisposition"))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        List<ReplyPartEntity> expected = buildLocalFallbackParts(
            turn, attempt, supplied, semantic.getString("visibleGroupId"),
            terminalDisposition, turn.completedAt == null ? turn.updatedAt : turn.completedAt);
        assertReplyPartsEqual(expected, dao.replyParts(turn.turnId), turn.turnId);
        ConversationAuthorityEntity authority = dao.conversationAuthority(
            semantic.getString("authorityLineageKey"));
        if (authority == null || !"COMMITTED".equals(authority.state)
            || !semantic.getString("visibleGroupId").equals(authority.visibleGroupId)
            || !receipt.getString("commitChecksum").equals(authority.commitChecksum)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        assertLocalFallbackCursorAfterReplay(turn, semantic);
        return DeliveryDisposition.APPLY;
    }

    private void applyLocalFallbackCursor(
        ConversationCursorEntity cursor,
        String localTurnId,
        String visibleGroupId,
        long sequence,
        boolean applyUi,
        long now
    ) {
        cursor.localSequence = Math.max(cursor.localSequence, sequence);
        if (sequence > cursor.nativeCompletedSequence) {
            cursor.nativeCompletedTurnId = localTurnId;
            cursor.nativeCompletedGroupId = visibleGroupId;
            cursor.nativeCompletedSequence = sequence;
        } else if (sequence == cursor.nativeCompletedSequence
            && (!localTurnId.equals(cursor.nativeCompletedTurnId)
                || !visibleGroupId.equals(cursor.nativeCompletedGroupId))) {
            throw bridgeAuthorityConflict(localTurnId);
        }
        if (applyUi) {
            cursor.uiAppliedTurnId = localTurnId;
            cursor.uiAppliedGroupId = visibleGroupId;
            cursor.uiAppliedSequence = Math.max(cursor.uiAppliedSequence, sequence);
        }
        cursor.updatedAt = now;
        saveCursor(cursor);
        terminalFaultHook.after(FAULT_NATIVE_CURSOR);
        if (applyUi) terminalFaultHook.after(FAULT_UI_CURSOR);
    }

    private void assertLocalFallbackCursorAfterReplay(
        ChatTurnEntity turn,
        JSONObject semantic
    ) throws Exception {
        ConversationCursorEntity cursor = dao.conversationCursor(turn.characterId);
        JSONObject input = semantic.getJSONObject("input");
        long sequence = TurnKind.DIRECT_REPLY.name().equals(turn.kind)
            ? turn.inputVisibilitySequence : input.getLong("visibilitySequence");
        if (cursor == null || cursor.nativeCompletedSequence < sequence) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if (cursor.nativeCompletedSequence == sequence
            && (!turn.turnId.equals(cursor.nativeCompletedTurnId)
                || !semantic.getString("visibleGroupId").equals(cursor.nativeCompletedGroupId))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void insertLocalFallbackChange(
        String turnId,
        String lineageKey,
        String visibleGroupId,
        String terminalDisposition,
        long now
    ) throws Exception {
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "skip".equals(terminalDisposition) ? "TURN_SKIPPED" : "REPLY_COMMITTED";
        change.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
            .put("turnId", turnId)
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", visibleGroupId)
            .put("authorityOrigin", "android_fallback")
            .put("terminalDisposition", terminalDisposition));
        change.createdAt = now;
        dao.insertChange(change);
    }

    private void insertLocalFallbackRedactedChange(
        String turnId,
        String lineageKey,
        long now
    ) throws Exception {
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_REDACTED";
        change.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
            .put("turnId", turnId)
            .put("authorityLineageKey", lineageKey)
            .put("authorityOrigin", "android_fallback")
            .put("redacted", true));
        change.createdAt = now;
        dao.insertChange(change);
    }

    private static JSONObject canonicalResultMetadata(BridgeResult result) throws Exception {
        JSONObject source = result.authorityPayload();
        JSONObject metadata = new JSONObject();
        for (String key : Arrays.asList(
            "protocolVersion", "turnId", "roleId", "authorityOrigin", "authorityLineageKey",
            "visibleGroupId", "lineageRevision", "turnRevision", "laneKey", "laneRevision",
            "inputVisibilitySequence", "inputClearEpoch", "generationFingerprint", "releaseId",
            "commitPayloadVersion", "commitChecksum", "terminalDisposition"
        )) metadata.put(key, source.get(key));
        return metadata;
    }

    private static String checkpointWithOutcomeJson(
        JSONObject checkpoint,
        JSONObject outcome
    ) throws Exception {
        JSONObject next = new JSONObject(checkpoint.toString()).put("outcome", outcome);
        return BridgeAuthority.canonicalJson(next);
    }

    private static boolean sameTerminalReceipt(ChatTurnEntity turn, BridgeResult result) {
        return result.visibleGroupId.equals(turn.visibleGroupId)
            && result.authorityLineageKey.equals(turn.authorityLineageKey)
            && result.authorityOrigin.equals(turn.authorityOrigin)
            && result.commitPayloadVersion.equals(turn.commitPayloadVersion)
            && turn.lineageRevision != null && result.lineageRevision == turn.lineageRevision
            && turn.turnRevision != null && result.turnRevision == turn.turnRevision
            && result.laneKey.equals(turn.laneKey)
            && turn.laneRevision != null && result.laneRevision == turn.laneRevision
            && sameNullable(result.generationFingerprint, turn.generationFingerprint)
            && result.releaseId.equals(turn.pipelineReleaseId)
            && turn.inputVisibilitySequence != null
            && result.inputVisibilitySequence == turn.inputVisibilitySequence
            && turn.inputClearEpoch != null && result.inputClearEpoch == turn.inputClearEpoch
            && result.commitChecksum.equals(turn.bridgeCommitChecksum)
            && result.terminalDisposition.equals(turn.terminalDisposition);
    }

    private static void assertReplyPartsEqual(
        List<ReplyPartEntity> expected,
        List<ReplyPartEntity> actual,
        String turnId
    ) {
        if (expected.size() != actual.size()) throw bridgeAuthorityConflict(turnId);
        for (int index = 0; index < expected.size(); index += 1) {
            ReplyPartEntity left = expected.get(index);
            ReplyPartEntity right = actual.get(index);
            if (!left.replyPartId.equals(right.replyPartId)
                || !left.turnId.equals(right.turnId)
                || !left.attemptId.equals(right.attemptId)
                || left.sequence != right.sequence
                || !left.type.equals(right.type)
                || !left.content.equals(right.content)
                || !left.payloadJson.equals(right.payloadJson)
                || left.createdAt != right.createdAt) {
                throw bridgeAuthorityConflict(turnId);
            }
        }
    }

    private static void assertRawMessagesEqual(
        List<RawMessageEntity> expected,
        List<RawMessageEntity> actual,
        String turnId
    ) {
        if (expected.size() != actual.size()) throw bridgeAuthorityConflict(turnId);
        Map<String, RawMessageEntity> byId = new HashMap<>();
        for (RawMessageEntity row : actual) byId.put(row.messageId, row);
        if (byId.size() != actual.size()) throw bridgeAuthorityConflict(turnId);
        for (RawMessageEntity left : expected) {
            RawMessageEntity right = byId.get(left.messageId);
            if (right == null
                || !left.turnId.equals(right.turnId)
                || !left.characterId.equals(right.characterId)
                || !left.speakerId.equals(right.speakerId)
                || !left.speakerType.equals(right.speakerType)
                || !left.recipientId.equals(right.recipientId)
                || !left.content.equals(right.content)
                || left.sentAt != right.sentAt
                || !left.origin.equals(right.origin)
                || !left.deviceId.equals(right.deviceId)
                || left.deviceSeq != right.deviceSeq
                || !left.checksum.equals(right.checksum)
                || right.syncSeq != 0L) {
                throw bridgeAuthorityConflict(turnId);
            }
        }
    }

    private void insertCanonicalTerminalChange(
        String turnId,
        BridgeResult result,
        boolean redacted,
        long now
    ) throws Exception {
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = redacted ? "TURN_REDACTED"
            : "skip".equals(result.terminalDisposition) ? "TURN_SKIPPED" : "REPLY_COMMITTED";
        change.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
            .put("turnId", turnId)
            .put("authorityLineageKey", result.authorityLineageKey)
            .put("visibleGroupId", result.visibleGroupId)
            .put("terminalDisposition", result.terminalDisposition));
        change.createdAt = now;
        dao.insertChange(change);
    }

    private void insertCanonicalFailureChange(
        String turnId,
        BridgeResult result,
        long now
    ) throws Exception {
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_FAILED";
        change.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
            .put("turnId", turnId)
            .put("authorityLineageKey", result.authorityLineageKey)
            .put("authoritativeTurnId", result.authoritativeTurnId)
            .put("retryAllowed", result.retryAllowed));
        change.createdAt = now;
        dao.insertChange(change);
    }

    private void insertCanonicalFailureDiagnostic(
        String turnId,
        String attemptId,
        BridgeResult result,
        long now
    ) throws Exception {
        insertDiagnostic(
            turnId,
            attemptId,
            "ERROR",
            "BRIDGE_REMOTE_FAILURE",
            BridgeAuthority.canonicalJson(new JSONObject()
                .put("redacted", true)
                .put("errorCode", result.errorCode)
                .put("retryAllowed", result.retryAllowed)
                .put("rawStatusChecksum", result.rawStatusChecksum)),
            now
        );
    }

    private List<MemberCheckpoint> validateCheckpointSet(
        ChatTurnEntity turn,
        List<ExecutionAttemptEntity> attempts,
        boolean storeOwnedV3
    ) {
        List<MemberCheckpoint> ascending = new java.util.ArrayList<>();
        for (ExecutionAttemptEntity candidate : attempts) {
            boolean hasJson = candidate.bridgeAuthorityCheckpointJson != null;
            boolean hasChecksum = candidate.bridgeAuthorityCheckpointChecksum != null;
            if (hasJson != hasChecksum) throw bridgeAuthorityConflict(turn.turnId);
            if (!storeOwnedV3) {
                if (hasJson) throw bridgeAuthorityConflict(turn.turnId);
                continue;
            }
            // The checkpoint is written before the first remote call.  A
            // null/null historical attempt therefore proves that it never
            // became a remote member (for example configuration failed while
            // obtaining bridgeDeviceId).  A one-sided row is always corrupt.
            if (!hasJson) continue;
            JSONObject checkpoint = validateCheckpoint(turn, candidate, false);
            ascending.add(new MemberCheckpoint(candidate, checkpoint));
        }
        if (storeOwnedV3 && ascending.isEmpty()
            && (turn.authorityLineageKey != null || turn.lineageRevision != null
                || turn.laneKey != null || turn.inputVisibilitySequence != null
                || turn.inputClearEpoch != null)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        java.util.Collections.reverse(ascending);
        Map<String, MemberAggregate> grouped = new java.util.LinkedHashMap<>();
        for (MemberCheckpoint member : ascending) {
            try {
                String remoteId = member.checkpoint.getString("authoritativeTurnId");
                String immutable = immutableMemberTuple(member.checkpoint);
                MemberAggregate aggregate = grouped.get(remoteId);
                if (aggregate == null) {
                    aggregate = new MemberAggregate(member, immutable);
                    grouped.put(remoteId, aggregate);
                } else if (!aggregate.immutableTuple.equals(immutable)) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                JSONObject outcome = member.checkpoint.getJSONObject("outcome");
                if (!"open".equals(outcome.getString("type"))) {
                    String terminal = BridgeAuthority.canonicalJson(outcome);
                    if (aggregate.terminal != null
                        && !aggregate.terminalOutcome.equals(terminal)) {
                        throw bridgeAuthorityConflict(turn.turnId);
                    }
                    if (aggregate.terminal == null) {
                        aggregate.terminal = member;
                        aggregate.terminalOutcome = terminal;
                    }
                }
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }
        List<MemberCheckpoint> representatives = new java.util.ArrayList<>();
        for (MemberAggregate aggregate : grouped.values()) {
            MemberCheckpoint outcome = aggregate.terminal == null ? aggregate.first : aggregate.terminal;
            // The first attempt owns the deterministic remote identity.  A later
            // unknown-outcome retry may hold the one closed terminal proof for
            // that same member, so keep the identity owner and outcome source
            // separate while walking the member chain.
            representatives.add(new MemberCheckpoint(aggregate.first.attempt, outcome.checkpoint));
        }
            MemberCheckpoint previousDistinct = null;
            for (MemberCheckpoint member : representatives) {
            if (previousDistinct == null) {
                assertDeterministicMember(turn, member, null);
                previousDistinct = member;
                continue;
            }
            try {
                String previousRemote = previousDistinct.checkpoint.getString("authoritativeTurnId");
                String currentRemote = member.checkpoint.getString("authoritativeTurnId");
                if (previousRemote.equals(currentRemote)) continue;
                assertAuthorizedChild(turn, previousDistinct, member);
                assertDeterministicMember(turn, member, previousDistinct);
                if (!previousRemote.equals(nullableString(member.checkpoint, "retryOfTurnId"))
                    || member.checkpoint.getLong("claimedLineageRevision")
                        != previousDistinct.checkpoint.getLong("claimedLineageRevision") + 1L) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                previousDistinct = member;
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }
        return representatives;
    }

    private MemberCheckpoint uniqueReceiptMember(
        ChatTurnEntity turn,
        List<ExecutionAttemptEntity> attempts,
        String authoritativeTurnId
    ) {
        MemberCheckpoint selected = null;
        String immutable = null;
        for (ExecutionAttemptEntity candidate : attempts) {
            if (candidate.bridgeAuthorityCheckpointJson == null) continue;
            JSONObject checkpoint = validateCheckpoint(turn, candidate, false);
            try {
                if (!authoritativeTurnId.equals(checkpoint.getString("authoritativeTurnId"))) continue;
                String tuple = immutableMemberTuple(checkpoint);
                if (selected == null || candidate.sequence < selected.attempt.sequence) {
                    selected = new MemberCheckpoint(candidate, checkpoint);
                    immutable = tuple;
                } else if (!tuple.equals(immutable)) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }
        if (selected == null) throw bridgeAuthorityConflict(turn.turnId);
        return selected;
    }

    private static void validateCanonicalTerminalResult(
        ChatTurnEntity turn,
        JSONObject activeCheckpoint,
        JSONObject receiptCheckpoint,
        BridgeResult result
    ) {
        try {
            JSONObject payload = result.authorityPayload();
            if (payload == null || !CANONICAL_RESULT_KEYS.equals(keysOf(payload))
                || result.protocolVersion != 3
                || !turn.characterId.equals(result.roleId)
                || !"pc".equals(result.authorityOrigin)
                || !result.authorityLineageKey.equals(activeCheckpoint.getString("authorityLineageKey"))
                || !result.authorityLineageKey.equals(receiptCheckpoint.getString("authorityLineageKey"))
                || !result.authoritativeTurnId.equals(receiptCheckpoint.getString("authoritativeTurnId"))
                || result.lineageRevision != receiptCheckpoint.getLong("claimedLineageRevision") + 1L
                || !result.laneKey.equals(activeCheckpoint.getString("laneKey"))
                || !result.laneKey.equals(receiptCheckpoint.getString("laneKey"))
                || result.inputVisibilitySequence != receiptCheckpoint.getLong("inputVisibilitySequence")
                || result.inputClearEpoch != receiptCheckpoint.getLong("inputClearEpoch")
                || !AuthorityIdentity.groupId(result.authorityLineageKey).equals(result.visibleGroupId)
                || result.turnRevision <= 0L || result.laneRevision <= 0L
                || result.lineageRevision <= 0L || result.lineageRevision > 9007199254740991L
                || result.turnRevision > 9007199254740991L
                || result.laneRevision > 9007199254740991L
                || result.inputVisibilitySequence <= 0L
                || result.inputVisibilitySequence > 9007199254740991L
                || result.inputClearEpoch < 0L || result.inputClearEpoch > 9007199254740991L
                || result.releaseId == null || result.releaseId.isEmpty()
                || result.commitPayloadVersion == null || result.commitPayloadVersion.isEmpty()
                || result.commitChecksum == null || !result.commitChecksum.matches("[a-f0-9]{64}")) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONArray payloadParts = payload.getJSONArray("replyParts");
            JSONArray payloadActions = payload.getJSONArray("actions");
            if (payloadParts.length() != result.replyPartsJson.size()
                || payloadActions.length() != result.actionsJson.size()) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            for (int index = 0; index < payloadParts.length(); index += 1) {
                if (!BridgeAuthority.canonicalJson(payloadParts.get(index))
                    .equals(result.replyPartsJson.get(index))) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
            }
            for (int index = 0; index < payloadActions.length(); index += 1) {
                if (!BridgeAuthority.canonicalJson(payloadActions.get(index))
                    .equals(result.actionsJson.get(index))) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
            }
            if (!("visible".equals(result.terminalDisposition)
                || "action_only".equals(result.terminalDisposition)
                || "skip".equals(result.terminalDisposition))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            boolean visible = "visible".equals(result.terminalDisposition);
            boolean actionOnly = "action_only".equals(result.terminalDisposition);
            if ((visible && payloadParts.length() == 0)
                || (actionOnly && (payloadParts.length() != 0 || payloadActions.length() == 0))
                || ("skip".equals(result.terminalDisposition)
                    && (payloadParts.length() != 0 || payloadActions.length() != 0))
                || (TurnKind.DIRECT_REPLY.name().equals(turn.kind)
                    && "skip".equals(result.terminalDisposition))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static void validateCanonicalFailureResult(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        BridgeResult result
    ) {
        try {
            JSONObject failure = BridgeAuthority.validateCanonicalFailureStatus(result.authorityPayload());
            if (result.protocolVersion != 3
                || !turn.characterId.equals(result.roleId)
                || !checkpoint.getString("authoritativeTurnId").equals(result.authoritativeTurnId)
                || !checkpoint.getString("authorityLineageKey").equals(result.authorityLineageKey)
                || checkpoint.getLong("claimedLineageRevision") != result.lineageRevision
                || !checkpoint.getString("laneKey").equals(result.laneKey)
                || checkpoint.getLong("inputVisibilitySequence") != result.inputVisibilitySequence
                || checkpoint.getLong("inputClearEpoch") != result.inputClearEpoch
                || !sameNullable(nullableString(checkpoint, "retryOfTurnId"), result.retryOfTurnId)
                || result.turnRevision <= 0L || result.laneRevision <= 0L
                || !"failed".equals(failure.getString("state"))
                || !("transient".equals(result.failureClass)
                    || "deterministic".equals(result.failureClass))
                || !("YUQI_TRANSIENT_EXECUTION_FAILURE".equals(result.errorCode)
                    || "YUQI_DETERMINISTIC_EXECUTION_FAILURE".equals(result.errorCode))
                || result.retryAllowed != failure.getBoolean("retryAllowed")
                || result.failedAt <= 0L
                || !result.rawStatusChecksum.equals(failure.getString("rawStatusChecksum"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private List<ReplyPartEntity> buildCanonicalReplyParts(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        BridgeResult result,
        long now
    ) {
        List<ReplyPartEntity> rows = new java.util.ArrayList<>();
        Set<String> identities = new HashSet<>();
        try {
            for (int ordinal = 0; ordinal < result.replyPartsJson.size(); ordinal += 1) {
                JSONObject canonicalItem = new JSONObject(result.replyPartsJson.get(ordinal));
                String messageId = canonicalItem.getString("messageId");
                if (!identities.add(messageId) || canonicalItem.getLong("ordinal") != ordinal
                    || !AuthorityIdentity.messageId(result.visibleGroupId, ordinal).equals(messageId)) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                JSONObject semantic = new JSONObject(canonicalItem.toString());
                semantic.remove("messageId");
                semantic.remove("ordinal");
                String itemChecksum = semantic.getString("itemChecksum");
                semantic.remove("itemChecksum");
                if (!itemChecksum.equals(BridgeAuthority.sha256CanonicalJson(semantic))) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                ReplyPartEntity row = new ReplyPartEntity();
                row.replyPartId = messageId;
                row.turnId = turn.turnId;
                row.attemptId = attempt.attemptId;
                row.sequence = ordinal;
                row.type = "TEXT";
                row.content = canonicalItem.getString("content");
                row.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
                    .put("version", 1)
                    .put("canonicalItem", canonicalItem));
                row.createdAt = now;
                rows.add(row);
            }
            Set<String> singleCompatibility = new HashSet<>();
            for (int ordinal = 0; ordinal < result.actionsJson.size(); ordinal += 1) {
                JSONObject action = new JSONObject(result.actionsJson.get(ordinal));
                String actionId = action.getString("actionId");
                if (!CANONICAL_ACTION_KEYS.equals(keysOf(action))
                    || !identities.add(actionId)
                    || action.getLong("ordinal") != ordinal
                    || !AuthorityIdentity.actionId(result.visibleGroupId, ordinal).equals(actionId)) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                JSONObject semantic = new JSONObject()
                    .put("kind", action.getString("kind"))
                    .put("targetKey", action.getString("targetKey"))
                    .put("targetRevision", action.getString("targetRevision"))
                    .put("payload", action.getJSONObject("payload"));
                if (!action.getString("actionChecksum").equals(
                    BridgeAuthority.sha256CanonicalJson(semantic))) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                ActionProjection projection = projectCanonicalAction(action, singleCompatibility);
                ReplyPartEntity row = new ReplyPartEntity();
                row.replyPartId = actionId;
                row.turnId = turn.turnId;
                row.attemptId = attempt.attemptId;
                row.sequence = result.replyPartsJson.size() + ordinal;
                row.type = projection.type;
                row.content = "";
                row.payloadJson = BridgeAuthority.canonicalJson(new JSONObject()
                    .put("version", 1)
                    .put("canonicalAction", action)
                    .put("legacyPayload", projection.legacyPayload));
                row.createdAt = now;
                rows.add(row);
            }
            return rows;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static ActionProjection projectCanonicalAction(
        JSONObject action,
        Set<String> singleCompatibility
    ) throws Exception {
        String kind = action.getString("kind");
        JSONObject payload = new JSONObject(action.getJSONObject("payload").toString());
        if ("payment_accept".equals(kind) || "payment_decline".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "payment");
            return new ActionProjection("PAYMENT_STATUS", new JSONObject()
                .put("status", "payment_accept".equals(kind) ? "received" : "refused"));
        }
        if ("moment_create".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "moment");
            return new ActionProjection("MOMENT_CREATE", payload);
        }
        if ("moment_like".equals(kind) || "moment_comment".equals(kind)
            || "moment_reply".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "moment");
            return new ActionProjection("MOMENT_ACTION", payload);
        }
        if ("role_plan_create".equals(kind) || "role_plan_update".equals(kind)
            || "role_plan_cancel".equals(kind) || "role_plan_pause".equals(kind)
            || "role_plan_resume".equals(kind) || "role_plan_complete".equals(kind)) {
            return new ActionProjection("PLAN", new JSONObject()
                .put("operations", new JSONArray().put(payload)));
        }
        if ("life_episode_create".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "life");
            return new ActionProjection("LIFE_EPISODE", payload);
        }
        if ("life_episode_update".equals(kind) || "life_episode_cancel".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "life");
            return new ActionProjection("LIFE_ADJUSTMENT", payload);
        }
        if ("relationship_transition".equals(kind)) {
            assertSingleCompatibility(singleCompatibility, "relationship");
            return new ActionProjection("RELATIONSHIP_STAGE", payload);
        }
        throw new IllegalArgumentException("canonical action kind conflict");
    }

    private static void assertSingleCompatibility(Set<String> values, String namespace) {
        if (!values.add(namespace)) throw new IllegalArgumentException(
            "canonical action compatibility conflict");
    }

    private List<RawMessageEntity> buildCanonicalRawMessages(
        ChatTurnEntity turn,
        JSONObject receiptCheckpoint,
        BridgeResult result
    ) {
        List<RawMessageEntity> rows = new java.util.ArrayList<>();
        if (result.replyPartsJson.isEmpty()) return rows;
        try {
            long sourceTime = receiptCheckpoint.getJSONObject("normalizedEnvelope").getLong("createdAt");
            long maximumBase = 9007199254740991L - (result.replyPartsJson.size() - 1L);
            long baseSentAt = Math.min(sourceTime, maximumBase);
            if (baseSentAt <= 0L) throw bridgeAuthorityConflict(turn.turnId);
            String deviceId = "pc-group:" + result.visibleGroupId;
            for (int ordinal = 0; ordinal < result.replyPartsJson.size(); ordinal += 1) {
                JSONObject item = new JSONObject(result.replyPartsJson.get(ordinal));
                RawMessageEntity row = new RawMessageEntity();
                row.messageId = item.getString("messageId");
                row.turnId = result.authoritativeTurnId;
                row.characterId = result.roleId;
                row.speakerId = item.getString("speakerId");
                row.speakerType = item.getString("speakerType");
                row.recipientId = item.getString("recipientId");
                row.content = item.getString("content");
                row.sentAt = baseSentAt + ordinal;
                row.origin = result.authorityOrigin;
                row.deviceId = deviceId;
                row.deviceSeq = ordinal + 1L;
                row.syncSeq = 0L;
                row.checksum = canonicalRawMessageChecksum(row);
                rows.add(row);
            }
            return rows;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void assertCanonicalProjectionIsWritable(
        ChatTurnEntity turn,
        BridgeResult result,
        List<ReplyPartEntity> parts,
        List<RawMessageEntity> rawMessages
    ) {
        if (dao.replyPartCount(turn.turnId) != 0
            || !dao.canonicalCharacterMessages(result.authoritativeTurnId).isEmpty()) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        for (ReplyPartEntity part : parts) {
            if (dao.replyPart(part.replyPartId) != null) throw bridgeAuthorityConflict(turn.turnId);
        }
        for (RawMessageEntity row : rawMessages) {
            if (dao.rawMessage(row.messageId) != null
                || dao.rawMessageByDeviceSequence(row.deviceId, row.deviceSeq) != null) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        }
    }

    private DeliveryDisposition validateExactCanonicalTerminalReplay(
        ChatTurnEntity turn,
        ExecutionAttemptEntity activeAttempt,
        JSONObject activeCheckpoint,
        BridgeResult result
    ) {
        try {
            JSONObject outcome = activeCheckpoint.getJSONObject("outcome");
            boolean redacted = "redacted".equals(outcome.getString("type"));
            if (!(redacted || "committed".equals(outcome.getString("type")))
                || !TurnState.COMPLETED.name().equals(turn.state)
                || !TurnState.COMPLETED.name().equals(activeAttempt.state)
                || turn.completedAt == null
                || !sameTerminalReceipt(turn, result)
                || !result.deliveryRoute.equals(outcome.getString("route"))
                || !sameNullable(result.relayMessageId,
                    nullableString(outcome, "relayMessageId"))
                || !outcome.isNull("failure")
                || (redacted
                    ? turn.deletedAt == null || outcome.getLong("redactedAt") != turn.deletedAt
                    : !outcome.isNull("redactedAt"))
                || !BridgeAuthority.canonicalJson(outcome.getJSONObject("result"))
                    .equals(BridgeAuthority.canonicalJson(
                        redacted ? canonicalResultMetadata(result) : result.authorityPayload()))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            ConversationAuthorityEntity authority = dao.conversationAuthority(result.authorityLineageKey);
            if (authority == null || !"COMMITTED".equals(authority.state)
                || !result.authoritativeTurnId.equals(authority.latestTurnId)
                || result.lineageRevision != authority.revision
                || !result.visibleGroupId.equals(authority.visibleGroupId)
                || !result.commitChecksum.equals(authority.commitChecksum)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            MemberCheckpoint receiptMember = uniqueReceiptMember(
                turn, dao.attempts(turn.turnId), result.authoritativeTurnId);
            if (redacted) {
                if (turn.deletedAt == null || dao.replyPartCount(turn.turnId) != 0
                    || !dao.canonicalCharacterMessages(result.authoritativeTurnId).isEmpty()) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                return DeliveryDisposition.REDACTED;
            }
            List<ReplyPartEntity> expectedParts = buildCanonicalReplyParts(
                turn, activeAttempt, result, turn.completedAt);
            assertReplyPartsEqual(expectedParts, dao.replyParts(turn.turnId), turn.turnId);
            List<RawMessageEntity> expectedMessages = buildCanonicalRawMessages(
                turn, receiptMember.checkpoint, result);
            assertRawMessagesEqual(expectedMessages,
                dao.canonicalCharacterMessages(result.authoritativeTurnId), turn.turnId);
            assertCanonicalCursorAfterReplay(turn, result);
            return DeliveryDisposition.APPLY;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void assertCurrentRetryAttempt(ChatTurnEntity turn, TurnState currentState) {
        if (turn.activeAttemptId == null || turn.activeAttemptId.isEmpty()) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        ExecutionAttemptEntity active = dao.attempt(turn.activeAttemptId);
        int maximumSequence = dao.maxAttemptSequence(turn.turnId);
        boolean expectsRetryable = currentState == TurnState.FAILED_RETRYABLE
            || currentState == TurnState.INTERRUPTED;
        if (active == null
            || !turn.turnId.equals(active.turnId)
            || active.sequence <= 0
            || active.sequence != maximumSequence
            || !currentState.name().equals(active.state)
            || active.finishedAt == null
            || active.retryable != expectsRetryable) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static void assertCanonicalBridgeLifecycle(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        boolean preparing,
        JSONObject checkpoint
    ) {
        if (turn == null || attempt == null
            || turn.activeAttemptId == null
            || !turn.activeAttemptId.equals(attempt.attemptId)
            || !turn.turnId.equals(attempt.turnId)) {
            throw bridgeAuthorityConflict(turn == null ? "bridge-cloud-inbox" : turn.turnId);
        }
        String turnState = turn.state;
        String attemptState = attempt.state;
        String stage = attempt.stage;
        boolean unfinished = attempt.finishedAt == null;
        String outcomeType = null;
        if (checkpoint != null) {
            JSONObject outcome = checkpoint.optJSONObject("outcome");
            outcomeType = outcome == null ? null : outcome.optString("type", null);
        }
        boolean valid;
        if (preparing) {
            valid = TurnState.MEMORY_RUNNING.name().equals(turnState)
                && TurnState.MEMORY_RUNNING.name().equals(attemptState)
                && AttemptStage.MEMORY.name().equals(stage)
                && unfinished
                && !attempt.retryable;
        } else if (TurnState.MEMORY_RUNNING.name().equals(turnState)) {
            valid = turnState.equals(attemptState)
                && AttemptStage.MEMORY.name().equals(stage)
                && unfinished
                && !attempt.retryable;
        } else if (TurnState.BRIDGE_WAITING.name().equals(turnState)) {
            valid = turnState.equals(attemptState)
                && AttemptStage.BRIDGE.name().equals(stage)
                && unfinished
                && !attempt.retryable;
        } else if (TurnState.FAILED_RETRYABLE.name().equals(turnState)
            || TurnState.INTERRUPTED.name().equals(turnState)) {
            valid = turnState.equals(attemptState)
                && (AttemptStage.MEMORY.name().equals(stage)
                    || AttemptStage.BRIDGE.name().equals(stage)
                    || AttemptStage.FINISHED.name().equals(stage))
                && !unfinished
                && attempt.retryable;
        } else if (TurnState.FAILED_FINAL.name().equals(turnState)) {
            valid = turnState.equals(attemptState)
                && (AttemptStage.MEMORY.name().equals(stage)
                    || AttemptStage.BRIDGE.name().equals(stage)
                    || AttemptStage.FINISHED.name().equals(stage))
                && !unfinished
                && !attempt.retryable;
        } else if (TurnState.COMPLETED.name().equals(turnState)) {
            valid = TurnState.COMPLETED.name().equals(attemptState)
                && AttemptStage.FINISHED.name().equals(stage)
                && !unfinished
                && !attempt.retryable
                && turn.completedAt != null;
        } else {
            valid = false;
        }
        if (valid && !preparing) {
            boolean localOpenState = TurnState.MEMORY_RUNNING.name().equals(turnState)
                || TurnState.BRIDGE_WAITING.name().equals(turnState);
            boolean failedState = TurnState.FAILED_RETRYABLE.name().equals(turnState)
                || TurnState.INTERRUPTED.name().equals(turnState)
                || TurnState.FAILED_FINAL.name().equals(turnState);
            if (localOpenState) {
                valid = "open".equals(outcomeType);
            } else if (failedState) {
                valid = AttemptStage.FINISHED.name().equals(stage)
                    ? "verified_remote_failure".equals(outcomeType)
                    : "open".equals(outcomeType);
            } else if (TurnState.COMPLETED.name().equals(turnState)) {
                valid = "committed".equals(outcomeType) || "redacted".equals(outcomeType);
            }
        }
        if (!valid) throw bridgeAuthorityConflict(turn.turnId);
    }

    private static void assertAuthorizedChild(
        ChatTurnEntity turn,
        MemberCheckpoint parent,
        MemberCheckpoint child
    ) {
        try {
            JSONObject outcome = parent.checkpoint.getJSONObject("outcome");
            if (!"verified_remote_failure".equals(outcome.getString("type"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject failure = BridgeAuthority.validateCanonicalFailureStatus(
                outcome.getJSONObject("failure"));
            long parentRevision = parent.checkpoint.getLong("claimedLineageRevision");
            if (!failure.getBoolean("retryAllowed")
                || parentRevision >= 9007199254740991L
                || !parent.checkpoint.getString("authoritativeTurnId").equals(
                    failure.getString("turnId"))
                || !turn.characterId.equals(failure.getString("roleId"))
                || !parent.checkpoint.getString("authorityLineageKey").equals(
                    failure.getString("authorityLineageKey"))
                || parentRevision != failure.getLong("lineageRevision")
                || !parent.checkpoint.getString("laneKey").equals(failure.getString("laneKey"))
                || parent.checkpoint.getLong("inputVisibilitySequence")
                    != failure.getLong("inputVisibilitySequence")
                || parent.checkpoint.getLong("inputClearEpoch")
                    != failure.getLong("inputClearEpoch")
                || !sameNullable(
                    nullableString(parent.checkpoint, "retryOfTurnId"),
                    nullableString(failure, "retryOfTurnId")
                )
                || !parent.checkpoint.getString("authoritativeTurnId").equals(
                    nullableString(child.checkpoint, "retryOfTurnId"))
                || child.checkpoint.getLong("claimedLineageRevision") != parentRevision + 1L) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static void assertDeterministicMember(
        ChatTurnEntity turn,
        MemberCheckpoint member,
        MemberCheckpoint parent
    ) {
        try {
            if (isConversationClearTombstoneCheckpoint(turn, member.checkpoint)) {
                assertConversationClearTombstoneMember(turn, member);
                return;
            }
            TurnSubmission persisted = new TurnSubmission(
                turn.turnId, turn.characterId, turn.sourceMessageId, TurnKind.valueOf(turn.kind),
                turn.inputJson, turn.snapshotJson, turn.cloudJobId, turn.createdAt
            );
            String expectedLane = BridgeInput.laneKey(persisted);
            String expectedRoot = BridgeInput.rootSourceId(persisted);
            String expectedLineage = AuthorityIdentity.lineageKey(turn.characterId, expectedLane, expectedRoot);
            JSONObject checkpoint = member.checkpoint;
            JSONObject envelopeAuthority = checkpointEnvelope(checkpoint).getJSONObject("authority");
            if (!expectedLane.equals(checkpoint.getString("laneKey"))
                || !expectedLineage.equals(checkpoint.getString("authorityLineageKey"))
                || !expectedRoot.equals(envelopeAuthority.getString("rootSourceId"))
                || !"al-authority-v1".equals(envelopeAuthority.getString("algorithm"))
                || !turn.characterId.equals(envelopeAuthority.getString("roleId"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (parent == null) {
                String expectedRemote = BridgeInput.wireTurnId(turn.turnId, TurnKind.valueOf(turn.kind));
                if (!expectedRemote.equals(checkpoint.getString("authoritativeTurnId"))
                    || nullableString(checkpoint, "retryOfTurnId") != null
                    || checkpoint.getLong("claimedLineageRevision") != 1L) {
                    throw bridgeAuthorityConflict(turn.turnId);
                }
                return;
            }
            String expectedRemote = AuthorityIdentity.remoteRetryTurnId(member.attempt.attemptId);
            if (!expectedRemote.equals(checkpoint.getString("authoritativeTurnId"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static boolean isConversationClearTombstoneReplay(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt
    ) {
        if (turn == null || turn.bridgeProtocolVersion == null
            || turn.bridgeProtocolVersion != 3 || attempt == null
            || attempt.bridgeAuthorityCheckpointJson == null
            || attempt.bridgeAuthorityCheckpointChecksum == null) {
            return false;
        }
        try {
            JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
            return isConversationClearTombstoneCheckpoint(turn, checkpoint);
        } catch (Exception error) {
            return false;
        }
    }

    private static boolean isConversationClearTombstoneCheckpoint(
        ChatTurnEntity turn,
        JSONObject checkpoint
    ) {
        if (turn == null || turn.bridgeProtocolVersion == null
            || turn.bridgeProtocolVersion != 3 || checkpoint == null) return false;
        JSONObject outcome = checkpoint.optJSONObject("outcome");
        JSONObject result = outcome == null ? null : outcome.optJSONObject("result");
        return exactSafeInteger(checkpoint, "version", false) == 1L
            && outcome != null
            && "redacted".equals(outcome.optString("type"))
            && result != null
            && "conversation-clear-redacted-v1".equals(result.optString("contract"));
    }

    private static void assertConversationClearTombstoneMember(
        ChatTurnEntity turn,
        MemberCheckpoint member
    ) {
        try {
            JSONObject checkpoint = member.checkpoint;
            String retryOf = nullableString(checkpoint, "retryOfTurnId");
            String expectedRemote = retryOf == null
                ? BridgeInput.wireTurnId(turn.turnId, TurnKind.valueOf(turn.kind))
                : AuthorityIdentity.remoteRetryTurnId(member.attempt.attemptId);
            String lineage = checkpoint.getString("authorityLineageKey");
            String lane = checkpoint.getString("laneKey");
            if (!expectedRemote.equals(checkpoint.getString("authoritativeTurnId"))
                || turn.authorityLineageKey == null
                || !lineage.equals(turn.authorityLineageKey)
                || turn.laneKey == null || !lane.equals(turn.laneKey)
                || turn.lineageRevision == null
                || turn.lineageRevision != checkpoint.getLong("claimedLineageRevision")
                || turn.inputVisibilitySequence == null
                || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
                || turn.inputClearEpoch == null
                || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch")
                || !"{}".equals(turn.inputJson)
                || !"{}".equals(turn.snapshotJson)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static String immutableMemberTuple(JSONObject checkpoint) {
        try {
            JSONObject value = new JSONObject()
                .put("authoritativeTurnId", checkpoint.getString("authoritativeTurnId"))
                .put("authorityLineageKey", checkpoint.getString("authorityLineageKey"))
                .put("claimedLineageRevision", checkpoint.getLong("claimedLineageRevision"))
                .put("retryOfTurnId", checkpoint.get("retryOfTurnId"))
                .put("laneKey", checkpoint.getString("laneKey"))
                .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
                .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
                .put("envelopeChecksum", checkpoint.getString("envelopeChecksum"));
            return BridgeAuthority.canonicalJson(value);
        } catch (Exception error) {
            throw new IllegalArgumentException("invalid bridge member", error);
        }
    }

    private void assertLatestPreparedState(ChatTurnEntity turn, JSONObject checkpoint) {
        try {
            if (!checkpoint.getString("authorityLineageKey").equals(turn.authorityLineageKey)
                || !checkpoint.getString("laneKey").equals(turn.laneKey)
                || turn.lineageRevision == null
                || turn.lineageRevision != checkpoint.getLong("claimedLineageRevision")
                || turn.inputVisibilitySequence == null
                || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
                || turn.inputClearEpoch == null
                || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch")) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            ConversationAuthorityEntity authority = dao.conversationAuthority(turn.authorityLineageKey);
            if (authority == null || !"OPEN".equals(authority.state)
                || !turn.characterId.equals(authority.characterId)
                || !turn.laneKey.equals(authority.laneKey)
                || !checkpoint.getString("authoritativeTurnId").equals(authority.latestTurnId)
                || checkpoint.getLong("claimedLineageRevision") != authority.revision) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            ConversationCursorEntity cursor = dao.conversationCursor(turn.characterId);
            if (cursor == null
                || cursor.localSequence < checkpoint.getLong("inputVisibilitySequence")
                || cursor.clearEpoch < checkpoint.getLong("inputClearEpoch")) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private JSONObject visibilityCursorFor(
        ChatTurnEntity owner,
        ConversationCursorEntity cursor,
        boolean firstV3Member
    ) {
        try {
            Anchor nativeAnchor = resolveCursorAnchor(
                owner.characterId, cursor.nativeCompletedTurnId,
                cursor.nativeCompletedGroupId, cursor.nativeCompletedSequence, firstV3Member
            );
            Anchor uiAnchor = resolveCursorAnchor(
                owner.characterId, cursor.uiAppliedTurnId,
                cursor.uiAppliedGroupId, cursor.uiAppliedSequence, firstV3Member
            );
            assertSafeCursorNumber(cursor.nativeCompletedSequence, owner.turnId);
            assertSafeCursorNumber(cursor.uiAppliedSequence, owner.turnId);
            assertSafeCursorNumber(cursor.localSequence, owner.turnId);
            assertSafeCursorNumber(cursor.clearedThroughSequence, owner.turnId);
            assertSafeCursorNumber(cursor.clearEpoch, owner.turnId);
            assertSafeCursorNumber(cursor.clearedAt, owner.turnId);
            if (cursor.uiAppliedSequence > cursor.nativeCompletedSequence
                || cursor.nativeCompletedSequence > cursor.localSequence
                || cursor.clearedThroughSequence > cursor.localSequence
                || (nativeAnchor != null && uiAnchor != null
                    && cursor.nativeCompletedSequence == cursor.uiAppliedSequence
                    && (!nativeAnchor.turnId.equals(uiAnchor.turnId)
                        || !nativeAnchor.groupId.equals(uiAnchor.groupId)))
                || (nativeAnchor != null && uiAnchor != null
                    && nativeAnchor.turnId.equals(uiAnchor.turnId)
                    && nativeAnchor.groupId.equals(uiAnchor.groupId)
                    && cursor.nativeCompletedSequence != cursor.uiAppliedSequence)) {
                throw bridgeAuthorityConflict(owner.turnId);
            }
            return new JSONObject()
                .put("nativeCompletedTurnId", nativeAnchor == null ? JSONObject.NULL : nativeAnchor.turnId)
                .put("nativeCompletedGroupId", nativeAnchor == null ? JSONObject.NULL : nativeAnchor.groupId)
                .put("nativeCompletedSequence", cursor.nativeCompletedSequence)
                .put("uiAppliedTurnId", uiAnchor == null ? JSONObject.NULL : uiAnchor.turnId)
                .put("uiAppliedGroupId", uiAnchor == null ? JSONObject.NULL : uiAnchor.groupId)
                .put("uiAppliedSequence", cursor.uiAppliedSequence)
                .put("localSequence", cursor.localSequence)
                .put("clearedThroughSequence", cursor.clearedThroughSequence)
                .put("clearEpoch", cursor.clearEpoch)
                .put("clearedAt", cursor.clearedAt)
                .put("chatOpen", cursor.chatOpen)
                .put("quotedMessageId", JSONObject.NULL);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(owner.turnId);
        }
    }

    private Anchor resolveCursorAnchor(
        String characterId,
        String localTurnId,
        String localGroupId,
        long sequence,
        boolean firstV3Member
    ) {
        if (localTurnId == null && localGroupId == null) {
            if (sequence != 0L) throw bridgeAuthorityConflict(characterId);
            return null;
        }
        if (localTurnId == null || localGroupId == null || sequence < 0L
            || sequence > 9007199254740991L) {
            throw bridgeAuthorityConflict(characterId);
        }
        ChatTurnEntity anchor = dao.turn(localTurnId);
        if (anchor == null || !characterId.equals(anchor.characterId)
            || !TurnState.COMPLETED.name().equals(anchor.state) || anchor.deletedAt != null) {
            throw bridgeAuthorityConflict(characterId);
        }
        String expectedLocalGroup = groupId(anchor);
        if (sequence == 0L) {
            if (!firstV3Member || anchor.bridgeProtocolVersion != null
                || (anchor.inputVisibilitySequence != null && anchor.inputVisibilitySequence != 0L)
                || (!localGroupId.equals(expectedLocalGroup) && !localGroupId.equals(anchor.turnId))) {
                throw bridgeAuthorityConflict(characterId);
            }
        } else {
            if (!localGroupId.equals(expectedLocalGroup)) {
                throw bridgeAuthorityConflict(characterId);
            }
            if (anchor.bridgeProtocolVersion != null && anchor.bridgeProtocolVersion == 3
                && (anchor.inputVisibilitySequence == null
                    || anchor.inputVisibilitySequence != sequence)) {
                throw bridgeAuthorityConflict(characterId);
            }
        }
        String remoteTurnId = BridgeInput.wireTurnId(anchor.turnId, TurnKind.valueOf(anchor.kind));
        String remoteGroupId = anchor.visibleGroupId == null ? remoteTurnId : anchor.visibleGroupId;
        if (anchor.bridgeProtocolVersion != null && anchor.bridgeProtocolVersion == 3) {
            for (ExecutionAttemptEntity candidate : dao.attempts(anchor.turnId)) {
                if (candidate.bridgeAuthorityCheckpointJson == null) continue;
                try {
                    JSONObject checkpoint = validateCheckpoint(anchor, candidate, false);
                    JSONObject outcome = checkpoint.getJSONObject("outcome");
                    long checkpointVersion = exactSafeInteger(checkpoint, "version", false);
                    if (checkpointVersion == 1L && "committed".equals(outcome.getString("type"))) {
                        // Canonical PC results carry their authoritative turn at
                        // result.turnId.  validateCheckpoint has already closed the
                        // complete v1 result shape before this projection.
                        Object resultTurnId = outcome.getJSONObject("result").opt("turnId");
                        if (!(resultTurnId instanceof String) || ((String) resultTurnId).isEmpty()) {
                            throw bridgeAuthorityConflict(characterId);
                        }
                        remoteTurnId = (String) resultTurnId;
                    } else if (checkpointVersion == 2L
                        && "committed".equals(outcome.getString("type"))) {
                        // The validated v2 local fallback receipt intentionally has
                        // no top-level result.turnId. Reuse the existing extractor
                        // (rather than a second receipt validator) and bind the
                        // semantic authority back to the checkpoint tuple.
                        JSONObject receipt = BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
                            candidate.bridgeAuthorityCheckpointJson,
                            candidate.bridgeAuthorityCheckpointChecksum);
                        if (receipt == null) throw bridgeAuthorityConflict(characterId);
                        JSONObject semantic = receipt.optJSONObject("semantic");
                        String fallbackTurnId = semantic == null
                            ? null : semantic.optString("authoritativeTurnId", null);
                        if (fallbackTurnId == null || fallbackTurnId.isEmpty()
                            || !fallbackTurnId.equals(checkpoint.getString("authoritativeTurnId"))) {
                            throw bridgeAuthorityConflict(characterId);
                        }
                        remoteTurnId = fallbackTurnId;
                    } else {
                        remoteTurnId = checkpoint.getString("authoritativeTurnId");
                    }
                    remoteGroupId = anchor.visibleGroupId == null ? remoteTurnId : anchor.visibleGroupId;
                    break;
                } catch (Exception error) {
                    throw bridgeAuthorityConflict(characterId);
                }
            }
        }
        if (sequence == 0L) remoteGroupId = remoteTurnId;
        return new Anchor(remoteTurnId, remoteGroupId);
    }

    private static void assertSafeCursorNumber(long value, String turnId) {
        if (value < 0L || value > 9007199254740991L) throw bridgeAuthorityConflict(turnId);
    }

    private JSONObject checkpointFor(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        String authoritativeTurnId,
        String lineageKey,
        long claimedRevision,
        String retryOfTurnId,
        String laneKey,
        long inputVisibilitySequence,
        long inputClearEpoch,
        JSONObject envelope
    ) {
        try {
            return new JSONObject()
                .put("version", 1)
                .put("localTurnId", turn.turnId)
                .put("attemptId", attempt.attemptId)
                .put("attemptSequence", attempt.sequence)
                .put("authoritativeTurnId", authoritativeTurnId)
                .put("authorityLineageKey", lineageKey)
                .put("claimedLineageRevision", claimedRevision)
                .put("retryOfTurnId", retryOfTurnId == null ? JSONObject.NULL : retryOfTurnId)
                .put("laneKey", laneKey)
                .put("inputVisibilitySequence", inputVisibilitySequence)
                .put("inputClearEpoch", inputClearEpoch)
                .put("normalizedEnvelope", new JSONObject(envelope.toString()))
                .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
                .put("outcome", openOutcome());
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void writeCheckpointOrReject(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint
    ) {
        String json = BridgeAuthority.canonicalJson(checkpoint);
        String checksum = BridgeAuthority.sha256CanonicalJson(checkpoint);
        if (dao.writeBridgeAuthorityCheckpoint(attempt.attemptId, turn.turnId, json, checksum) == 1) return;
        ExecutionAttemptEntity stored = dao.attempt(attempt.attemptId);
        if (stored == null || !json.equals(stored.bridgeAuthorityCheckpointJson)
            || !checksum.equals(stored.bridgeAuthorityCheckpointChecksum)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private JSONObject validateCheckpoint(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        boolean requireCurrentPins
    ) {
        try {
            if (attempt.bridgeAuthorityCheckpointJson == null
                || attempt.bridgeAuthorityCheckpointChecksum == null) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
            Object checkpointVersion = checkpoint.opt("version");
            if (checkpointVersion instanceof Number
                && !(checkpointVersion instanceof Float)
                && !(checkpointVersion instanceof Double)
                && ((Number) checkpointVersion).longValue() == 2L) {
                return validateLocalCheckpoint(turn, attempt, checkpoint, requireCurrentPins);
            }
            String checkpointLocalTurnId = requireNativeNonEmptyString(
                checkpoint, "localTurnId", turn.turnId);
            String checkpointAttemptId = requireNativeNonEmptyString(
                checkpoint, "attemptId", turn.turnId);
            String authoritativeTurnId = requireNativeNonEmptyString(
                checkpoint, "authoritativeTurnId", turn.turnId);
            String authorityLineageKey = requireNativeNonEmptyString(
                checkpoint, "authorityLineageKey", turn.turnId);
            String laneKey = requireNativeNonEmptyString(checkpoint, "laneKey", turn.turnId);
            String envelopeChecksum = requireNativeNonEmptyString(
                checkpoint, "envelopeChecksum", turn.turnId);
            if (!CHECKPOINT_KEYS.equals(keysOf(checkpoint))
                || exactSafeInteger(checkpoint, "version", false) != 1L
                || !turn.turnId.equals(checkpointLocalTurnId)
                || !attempt.attemptId.equals(checkpointAttemptId)
                || attempt.sequence != exactSafeInteger(checkpoint, "attemptSequence", true)
                || !attempt.bridgeAuthorityCheckpointChecksum.equals(
                    BridgeAuthority.sha256CanonicalJson(checkpoint))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject outcome = checkpoint.getJSONObject("outcome");
            if (!OUTCOME_KEYS.equals(keysOf(outcome))) throw bridgeAuthorityConflict(turn.turnId);
            String outcomeType = outcome.getString("type");
            if (!Arrays.asList("open", "verified_remote_failure", "committed", "redacted").contains(outcomeType)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            validateCheckpointOutcome(turn, checkpoint, outcome);
            if ("redacted".equals(outcomeType)
                && outcome.opt("route") == JSONObject.NULL
                && "conversation-clear-redacted-v1".equals(
                    outcome.optJSONObject("result") == null
                        ? null : outcome.optJSONObject("result").optString("contract"))) {
                validateConversationClearTombstone(
                    turn, attempt, checkpoint, outcome, false, requireCurrentPins);
                return checkpoint;
            }
            JSONObject envelope = checkpointEnvelope(checkpoint);
            long claimedRevision = exactSafeInteger(checkpoint, "claimedLineageRevision", true);
            long inputVisibilitySequence = exactSafeInteger(
                checkpoint, "inputVisibilitySequence", true);
            long inputClearEpoch = exactSafeInteger(checkpoint, "inputClearEpoch", false);
            JSONObject authority = envelope.getJSONObject("authority");
            JSONObject cursor = envelope.getJSONObject("context").getJSONObject("visibilityCursor");
            assertClosedVisibilityCursor(cursor, turn.turnId);
            if (exactSafeInteger(envelope, "protocolVersion", false) != 3L
                || exactSafeInteger(envelope, "deviceSeq", true) != inputVisibilitySequence
                || exactSafeInteger(envelope, "createdAt", true) <= 0L
                || !authoritativeTurnId.equals(requireNativeNonEmptyString(
                    envelope, "turnId", turn.turnId))
                || !turn.characterId.equals(requireNativeNonEmptyString(
                    envelope, "characterId", turn.turnId))
                || !authorityLineageKey.equals(requireNativeNonEmptyString(
                    authority, "lineageKey", turn.turnId))
                || claimedRevision != exactSafeInteger(authority, "claimedLineageRevision", true)
                || !laneKey.equals(requireNativeNonEmptyString(
                    authority, "laneKey", turn.turnId))
                || !envelopeChecksum.matches("[a-f0-9]{64}")
                || !envelopeChecksum.equals(BridgeAuthority.sha256CanonicalJson(envelope))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            String retryOf = nullableString(checkpoint, "retryOfTurnId");
            String envelopeRetryOf = nullableString(authority, "retryOfTurnId");
            if (!sameNullable(retryOf, envelopeRetryOf)) throw bridgeAuthorityConflict(turn.turnId);
            if (inputVisibilitySequence != exactSafeInteger(cursor, "localSequence", true)
                || inputClearEpoch != exactSafeInteger(cursor, "clearEpoch", false)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            TurnSubmission persisted = new TurnSubmission(
                turn.turnId, turn.characterId, turn.sourceMessageId, TurnKind.valueOf(turn.kind),
                turn.inputJson, turn.snapshotJson, turn.cloudJobId, turn.createdAt
            );
            String expectedLane = BridgeInput.laneKey(persisted);
            String expectedRoot = BridgeInput.rootSourceId(persisted);
            String expectedLineage = AuthorityIdentity.lineageKey(
                turn.characterId, expectedLane, expectedRoot);
            String deviceId = requireNativeNonEmptyString(envelope, "deviceId", turn.turnId);
            JSONObject reconstructed = BridgeInput.prepareV3Envelope(
                persisted,
                deviceId,
                authoritativeTurnId,
                expectedLane,
                expectedRoot,
                expectedLineage,
                claimedRevision,
                retryOf,
                new JSONObject(cursor.toString())
            );
            if (!expectedLane.equals(laneKey)
                || !expectedLineage.equals(authorityLineageKey)
                || !BridgeAuthority.canonicalJson(reconstructed).equals(
                    BridgeAuthority.canonicalJson(envelope))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (requireCurrentPins && (!checkpoint.getString("authorityLineageKey").equals(turn.authorityLineageKey)
                || !checkpoint.getString("laneKey").equals(turn.laneKey)
                || turn.lineageRevision == null
                || turn.lineageRevision != checkpoint.getLong("claimedLineageRevision")
                || turn.inputVisibilitySequence == null
                || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
                || turn.inputClearEpoch == null
                || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return checkpoint;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private JSONObject validateLocalCheckpoint(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        boolean requireCurrentPins
    ) {
        try {
            if (!LOCAL_CHECKPOINT_KEYS.equals(keysOf(checkpoint))
                || exactSafeInteger(checkpoint, "version", false) != 2L
                || !turn.turnId.equals(requireNativeNonEmptyString(
                    checkpoint, "localTurnId", turn.turnId))
                || !attempt.attemptId.equals(requireNativeNonEmptyString(
                    checkpoint, "attemptId", turn.turnId))
                || attempt.sequence != exactSafeInteger(checkpoint, "attemptSequence", true)
                || exactSafeInteger(checkpoint, "journalSyncSeq", false) < 0L
                || !attempt.bridgeAuthorityCheckpointChecksum.equals(
                    BridgeAuthority.sha256CanonicalJson(checkpoint))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject outcome = checkpoint.optJSONObject("outcome");
            if (outcome != null && "redacted".equals(outcome.optString("type"))
                && "conversation-clear-redacted-v1".equals(
                    outcome.optJSONObject("result") == null
                        ? null : outcome.optJSONObject("result").optString("contract"))) {
                validateConversationClearTombstone(
                    turn, attempt, checkpoint, outcome, true, requireCurrentPins);
                return checkpoint;
            }
            JSONObject fallbackExecution = checkpoint.optJSONObject("fallbackExecution");
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            JSONObject persistedExecution = snapshot.optJSONObject("fallbackExecution");
            if (fallbackExecution == null || persistedExecution == null
                || !BridgeAuthority.canonicalJson(fallbackExecution).equals(
                    BridgeAuthority.canonicalJson(persistedExecution))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            new FallbackCognitionPacketCodec().decode(snapshot);
            if (outcome != null && "redacted".equals(outcome.opt("type"))) {
                validateLocalRedactedCheckpoint(
                    turn, attempt, checkpoint, outcome, requireCurrentPins);
                return checkpoint;
            }
            if (outcome == null || !OUTCOME_KEYS.equals(keysOf(outcome))
                || !"committed".equals(outcome.opt("type"))
                || !"local".equals(outcome.opt("route"))
                || outcome.opt("relayMessageId") != JSONObject.NULL
                || outcome.opt("failure") != JSONObject.NULL
                || outcome.opt("redactedAt") != JSONObject.NULL) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject receipt = BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
                attempt.bridgeAuthorityCheckpointJson,
                attempt.bridgeAuthorityCheckpointChecksum);
            if (receipt == null
                || exactSafeInteger(receipt, "receiptVersion", true) != 2L
                || outcome.optJSONObject("result") == null
                || !BridgeAuthority.canonicalJson(receipt).equals(
                    BridgeAuthority.canonicalJson(outcome.getJSONObject("result")))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject semantic = receipt.getJSONObject("semantic");
            JSONObject envelope = checkpointEnvelope(checkpoint);
            if (!turn.characterId.equals(semantic.getString("roleId"))
                || !turn.kind.equals(semantic.getString("turnKind"))
                || !"android_fallback".equals(semantic.getString("authorityOrigin"))
                || !checkpoint.getString("authorityLineageKey").equals(
                    semantic.getString("authorityLineageKey"))
                || !checkpoint.getString("authoritativeTurnId").equals(
                    semantic.getString("authoritativeTurnId"))
                || !checkpoint.getString("laneKey").equals(semantic.getString("laneKey"))
                || checkpoint.getLong("claimedLineageRevision")
                    != semantic.getLong("lineageRevisionAtCreation")
                || checkpoint.getLong("journalSyncSeq") != semantic.getLong("journalSyncSeq")
                || !envelope.getString("deviceId").equals(semantic.getString("deviceId"))
                || !AuthorityIdentity.groupId(checkpoint.getString("authorityLineageKey"))
                    .equals(semantic.getString("visibleGroupId"))
                || !TurnState.COMPLETED.name().equals(turn.state)
                || !"android_fallback".equals(turn.authorityOrigin)
                || !receipt.getString("commitChecksum").equals(turn.bridgeCommitChecksum)
                || !semantic.getString("visibleGroupId").equals(turn.visibleGroupId)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            if (requireCurrentPins && (!checkpoint.getString("authorityLineageKey").equals(
                    turn.authorityLineageKey)
                || !checkpoint.getString("laneKey").equals(turn.laneKey)
                || turn.inputVisibilitySequence == null
                || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
                || turn.inputClearEpoch == null
                || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch"))) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return checkpoint;
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void validateLocalRedactedCheckpoint(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        JSONObject outcome,
        boolean requireCurrentPins
    ) throws Exception {
        Object redactedAt = outcome.opt("redactedAt");
        JSONObject result = outcome.optJSONObject("result");
        if (!OUTCOME_KEYS.equals(keysOf(outcome))
            || !"local".equals(outcome.opt("route"))
            || outcome.opt("relayMessageId") != JSONObject.NULL
            || outcome.opt("failure") != JSONObject.NULL
            || !(redactedAt instanceof Number)
            || redactedAt instanceof Float || redactedAt instanceof Double
            || ((Number) redactedAt).longValue() <= 0L
            || result == null || !LOCAL_REDACTED_RESULT_KEYS.equals(keysOf(result))
            || exactSafeInteger(checkpoint, "journalSyncSeq", false) != 0L
            || !"android-fallback-redacted-v1".equals(result.opt("contract"))
            || !checkpoint.getString("authorityLineageKey").equals(
                requireNativeNonEmptyString(result, "authorityLineageKey", turn.turnId))
            || !checkpoint.getString("authoritativeTurnId").equals(
                requireNativeNonEmptyString(result, "authoritativeTurnId", turn.turnId))
            || checkpoint.getLong("inputVisibilitySequence")
                != exactSafeInteger(result, "inputVisibilitySequence", true)
            || checkpoint.getLong("inputClearEpoch")
                != exactSafeInteger(result, "inputClearEpoch", false)
            || !Arrays.asList("visible", "action_only", "skip").contains(
                requireNativeNonEmptyString(result, "draftDisposition", turn.turnId))
            || !TurnState.COMPLETED.name().equals(turn.state)
            || turn.deletedAt == null
            || turn.deletedAt != ((Number) redactedAt).longValue()
            || turn.visibleGroupId != null || turn.bridgeCommitChecksum != null
            || turn.commitPayloadVersion != null || turn.terminalDisposition != null
            || dao.replyPartCount(turn.turnId) != 0
            || !AttemptStage.FINISHED.name().equals(attempt.stage)
            || !TurnState.COMPLETED.name().equals(attempt.state)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if (requireCurrentPins && (!checkpoint.getString("authorityLineageKey").equals(
                turn.authorityLineageKey)
            || !checkpoint.getString("laneKey").equals(turn.laneKey)
            || turn.inputVisibilitySequence == null
            || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
            || turn.inputClearEpoch == null
            || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch"))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private void validateConversationClearTombstone(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt,
        JSONObject checkpoint,
        JSONObject outcome,
        boolean localV2,
        boolean requireCurrentPins
    ) throws Exception {
        JSONObject result = outcome.optJSONObject("result");
        Set<String> resultKeys = new HashSet<>(Arrays.asList(
            "contract", "controlId", "clearEpoch", "clearedThroughSequence"
        ));
        Object redactedAt = outcome.opt("redactedAt");
        if (!OUTCOME_KEYS.equals(keysOf(outcome))
            || outcome.opt("route") != JSONObject.NULL
            || outcome.opt("relayMessageId") != JSONObject.NULL
            || outcome.opt("failure") != JSONObject.NULL
            || result == null || !resultKeys.equals(keysOf(result))
            || !"conversation-clear-redacted-v1".equals(result.opt("contract"))
            || !(result.opt("controlId") instanceof String)
            || !((String) result.opt("controlId")).matches("ctl_[a-f0-9]{64}")
            || !(redactedAt instanceof Number) || redactedAt instanceof Float
            || redactedAt instanceof Double || ((Number) redactedAt).longValue() <= 0L
            || exactSafeInteger(result, "clearEpoch", false) < 0L
            || exactSafeInteger(result, "clearedThroughSequence", false) < 0L
            || checkpoint.opt("normalizedEnvelope") != JSONObject.NULL
            || (localV2 && (checkpoint.opt("fallbackExecution") != JSONObject.NULL
                || exactSafeInteger(checkpoint, "journalSyncSeq", false) != 0L))
            || !TurnState.COMPLETED.name().equals(turn.state)
            || turn.deletedAt == null || turn.deletedAt != ((Number) redactedAt).longValue()
            || turn.visibleGroupId != null || turn.bridgeCommitChecksum != null
            || turn.commitPayloadVersion != null || turn.terminalDisposition != null
            || dao.replyPartCount(turn.turnId) != 0
            || !AttemptStage.FINISHED.name().equals(attempt.stage)
            || !TurnState.COMPLETED.name().equals(attempt.state)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        LifecycleControlEntity control = dao.lifecycleControl(result.optString("controlId", ""));
        if (control == null || !LifecycleControl.CLEAR_KIND.equals(control.controlKind)
            || !turn.characterId.equals(control.characterId) || control.semanticJson == null
            || !control.semanticChecksum.equals(LifecycleControlCodec.semanticChecksum(
                new JSONObject(control.semanticJson)))
            || !control.controlId.equals(result.optString("controlId"))
            || control.clearEpoch == null || control.clearEpoch.longValue() != result.getLong("clearEpoch")
            || control.clearedThroughSequence == null
            || control.clearedThroughSequence.longValue() != result.getLong("clearedThroughSequence")
            || control.requestedAt != ((Number) redactedAt).longValue()
            || control.state == null) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        JSONObject controlWire = new JSONObject(control.semanticJson);
        if (!LifecycleControlCodec.controlId(controlWire).equals(control.controlId)
            || !controlWire.getString("roleId").equals(turn.characterId)
            || controlWire.getLong("clearEpoch") != result.getLong("clearEpoch")
            || controlWire.getLong("clearedThroughSequence") != result.getLong("clearedThroughSequence")
            || controlWire.getLong("requestedAt") != ((Number) redactedAt).longValue()) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        ConversationAuthorityEntity authority = dao.conversationAuthority(
            checkpoint.getString("authorityLineageKey"));
        if (authority == null || !"CANCELLED".equals(authority.state)
            || !turn.characterId.equals(authority.characterId)
            || !checkpoint.getString("laneKey").equals(authority.laneKey)
            || !checkpoint.getString("authorityLineageKey").equals(
                AuthorityIdentity.lineageKey(
                    authority.characterId, authority.laneKey, authority.rootSourceId))
            || !checkpoint.getString("authoritativeTurnId").equals(authority.latestTurnId)
            || authority.revision != checkpoint.getLong("claimedLineageRevision") + 1L
            || authority.visibleGroupId != null || authority.commitChecksum != null
            || authority.commitPayloadVersion != null || authority.authorityOrigin != null
            || authority.terminalDisposition != null) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if (requireCurrentPins && (!checkpoint.getString("authorityLineageKey").equals(turn.authorityLineageKey)
            || !checkpoint.getString("laneKey").equals(turn.laneKey)
            || turn.inputVisibilitySequence == null
            || turn.inputVisibilitySequence != checkpoint.getLong("inputVisibilitySequence")
            || turn.inputClearEpoch == null
            || turn.inputClearEpoch != checkpoint.getLong("inputClearEpoch"))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static void validateCheckpointOutcome(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        JSONObject outcome
    ) throws Exception {
        String type = outcome.getString("type");
        Object route = outcome.get("route");
        Object relay = outcome.get("relayMessageId");
        Object failure = outcome.get("failure");
        Object result = outcome.get("result");
        Object redactedAt = outcome.get("redactedAt");
        if ("open".equals(type)) {
            if (route != JSONObject.NULL || relay != JSONObject.NULL || failure != JSONObject.NULL
                || result != JSONObject.NULL || redactedAt != JSONObject.NULL) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return;
        }
        if ("redacted".equals(type)) {
            boolean conversationTombstone = route == JSONObject.NULL && relay == JSONObject.NULL;
            boolean legacyLocalRedaction = "local".equals(route) && relay == JSONObject.NULL;
            if ((!conversationTombstone && !legacyLocalRedaction)
                || failure != JSONObject.NULL || !(result instanceof JSONObject)
                || !(redactedAt instanceof Number) || redactedAt instanceof Float
                || redactedAt instanceof Double || ((Number) redactedAt).longValue() <= 0L) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return;
        }
        if (!(route instanceof String)
            || !("lan".equals(route) || "cloud".equals(route))
            || ("lan".equals(route) && relay != JSONObject.NULL)
            || ("cloud".equals(route) && (!(relay instanceof String) || ((String) relay).isEmpty()))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        if ("verified_remote_failure".equals(type)) {
            if (!(failure instanceof JSONObject) || result != JSONObject.NULL || redactedAt != JSONObject.NULL) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            JSONObject closedFailure = BridgeAuthority.validateCanonicalFailureStatus((JSONObject) failure);
            if (!checkpoint.getString("authoritativeTurnId").equals(closedFailure.getString("turnId"))
                || !turn.characterId.equals(closedFailure.getString("roleId"))
                || !checkpoint.getString("authorityLineageKey").equals(
                    closedFailure.getString("authorityLineageKey"))
                || !checkpoint.getString("laneKey").equals(closedFailure.getString("laneKey"))
                || checkpoint.getLong("claimedLineageRevision")
                    != closedFailure.getLong("lineageRevision")
                || checkpoint.getLong("inputVisibilitySequence")
                    != closedFailure.getLong("inputVisibilitySequence")
                || checkpoint.getLong("inputClearEpoch") != closedFailure.getLong("inputClearEpoch")
                || !sameNullable(
                    nullableString(checkpoint, "retryOfTurnId"),
                    nullableString(closedFailure, "retryOfTurnId")
                )) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return;
        }
        if ("committed".equals(type)) {
            if (failure != JSONObject.NULL || !(result instanceof JSONObject) || redactedAt != JSONObject.NULL) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            validatePersistedTerminalOutcome(
                turn, checkpoint, (JSONObject) result, (String) route,
                relay == JSONObject.NULL ? null : (String) relay, false);
            if (!TurnState.COMPLETED.name().equals(turn.state)
                || !sameTerminalReceipt(turn, (JSONObject) result)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return;
        }
        throw bridgeAuthorityConflict(turn.turnId);
    }

    private static void validatePersistedTerminalOutcome(
        ChatTurnEntity turn,
        JSONObject checkpoint,
        JSONObject result,
        String route,
        String relayMessageId,
        boolean redacted
    ) throws Exception {
        if (!redacted) {
            BridgeResult parsed = BridgeTurnStatus.parseV3(
                BridgeAuthority.canonicalJson(result), route, relayMessageId);
            if (parsed.kind != BridgeResult.Kind.CANONICAL_TERMINAL
                || !turn.characterId.equals(parsed.roleId)
                || !checkpoint.getString("authorityLineageKey").equals(parsed.authorityLineageKey)
                || !checkpoint.getString("laneKey").equals(parsed.laneKey)) {
                throw bridgeAuthorityConflict(turn.turnId);
            }
            return;
        }
        if (!CANONICAL_RESULT_METADATA_KEYS.equals(keysOf(result))
            || exactSafeInteger(result, "protocolVersion", false) != 3L
            || !turn.characterId.equals(requireNativeNonEmptyString(
                result, "roleId", turn.turnId))
            || !"pc".equals(requireNativeNonEmptyString(
                result, "authorityOrigin", turn.turnId))
            || !checkpoint.getString("authorityLineageKey").equals(
                requireNativeNonEmptyString(result, "authorityLineageKey", turn.turnId))
            || !checkpoint.getString("laneKey").equals(
                requireNativeNonEmptyString(result, "laneKey", turn.turnId))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        String lineage = result.getString("authorityLineageKey");
        if (!AuthorityIdentity.groupId(lineage).equals(
                requireNativeNonEmptyString(result, "visibleGroupId", turn.turnId))
            || exactSafeInteger(result, "lineageRevision", true) <= 0L
            || exactSafeInteger(result, "turnRevision", true) <= 0L
            || exactSafeInteger(result, "laneRevision", true) <= 0L
            || exactSafeInteger(result, "inputVisibilitySequence", true) <= 0L
            || exactSafeInteger(result, "inputClearEpoch", false) < 0L
            || !requireNativeNonEmptyString(result, "commitChecksum", turn.turnId)
                .matches("[a-f0-9]{64}")
            || !Arrays.asList("visible", "action_only", "skip").contains(
                requireNativeNonEmptyString(result, "terminalDisposition", turn.turnId))) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        assertNullableString(result, "generationFingerprint", turn.turnId);
        requireNativeNonEmptyString(result, "turnId", turn.turnId);
        requireNativeNonEmptyString(result, "releaseId", turn.turnId);
        requireNativeNonEmptyString(result, "commitPayloadVersion", turn.turnId);
    }

    private static boolean sameTerminalReceipt(ChatTurnEntity turn, JSONObject result) {
        try {
            Object fingerprint = result.get("generationFingerprint");
            String parsedFingerprint = fingerprint == JSONObject.NULL ? null : (String) fingerprint;
            return turn.characterId.equals(result.getString("roleId"))
                && result.getString("visibleGroupId").equals(turn.visibleGroupId)
                && result.getString("authorityLineageKey").equals(turn.authorityLineageKey)
                && result.getString("authorityOrigin").equals(turn.authorityOrigin)
                && result.getString("commitPayloadVersion").equals(turn.commitPayloadVersion)
                && turn.lineageRevision != null
                && result.getLong("lineageRevision") == turn.lineageRevision
                && turn.turnRevision != null
                && result.getLong("turnRevision") == turn.turnRevision
                && result.getString("laneKey").equals(turn.laneKey)
                && turn.laneRevision != null
                && result.getLong("laneRevision") == turn.laneRevision
                && sameNullable(parsedFingerprint, turn.generationFingerprint)
                && result.getString("releaseId").equals(turn.pipelineReleaseId)
                && turn.inputVisibilitySequence != null
                && result.getLong("inputVisibilitySequence") == turn.inputVisibilitySequence
                && turn.inputClearEpoch != null
                && result.getLong("inputClearEpoch") == turn.inputClearEpoch
                && result.getString("commitChecksum").equals(turn.bridgeCommitChecksum)
                && result.getString("terminalDisposition").equals(turn.terminalDisposition);
        } catch (Exception error) {
            return false;
        }
    }

    private static JSONObject checkpointEnvelope(JSONObject checkpoint) throws Exception {
        return checkpoint.getJSONObject("normalizedEnvelope");
    }

    private static long exactSafeInteger(JSONObject value, String key, boolean positive) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("bridge integer field is invalid");
        }
        long number = ((Number) raw).longValue();
        if ((positive ? number <= 0L : number < 0L) || number > 9007199254740991L) {
            throw new IllegalArgumentException("bridge integer field is outside the safe range");
        }
        return number;
    }

    private static void assertClosedVisibilityCursor(JSONObject cursor, String turnId) {
        try {
            Set<String> expected = new HashSet<>(Arrays.asList(
                "nativeCompletedTurnId", "nativeCompletedGroupId", "nativeCompletedSequence",
                "uiAppliedTurnId", "uiAppliedGroupId", "uiAppliedSequence", "localSequence",
                "clearedThroughSequence", "clearEpoch", "clearedAt", "chatOpen", "quotedMessageId"
            ));
            if (!expected.equals(keysOf(cursor))) throw bridgeAuthorityConflict(turnId);
            exactSafeInteger(cursor, "nativeCompletedSequence", false);
            exactSafeInteger(cursor, "uiAppliedSequence", false);
            exactSafeInteger(cursor, "localSequence", true);
            exactSafeInteger(cursor, "clearedThroughSequence", false);
            exactSafeInteger(cursor, "clearEpoch", false);
            exactSafeInteger(cursor, "clearedAt", false);
            if (!(cursor.opt("chatOpen") instanceof Boolean)) throw bridgeAuthorityConflict(turnId);
            assertNullableString(cursor, "nativeCompletedTurnId", turnId);
            assertNullableString(cursor, "nativeCompletedGroupId", turnId);
            assertNullableString(cursor, "uiAppliedTurnId", turnId);
            assertNullableString(cursor, "uiAppliedGroupId", turnId);
            assertNullableString(cursor, "quotedMessageId", turnId);
        } catch (RuntimeException error) {
            throw error;
        }
    }

    private static void assertNullableString(JSONObject value, String key, String turnId) {
        Object raw = value.opt(key);
        if (raw != JSONObject.NULL && (!(raw instanceof String) || ((String) raw).isEmpty())) {
            throw bridgeAuthorityConflict(turnId);
        }
    }

    private static String requireNativeNonEmptyString(
        JSONObject value,
        String key,
        String turnId
    ) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw bridgeAuthorityConflict(turnId);
        }
        return (String) raw;
    }

    private static JSONObject openOutcome() throws Exception {
        return new JSONObject()
            .put("type", "open")
            .put("route", JSONObject.NULL)
            .put("relayMessageId", JSONObject.NULL)
            .put("failure", JSONObject.NULL)
            .put("result", JSONObject.NULL)
            .put("redactedAt", JSONObject.NULL);
    }

    private TurnSubmission submissionFromCheckpoint(ChatTurnEntity turn, JSONObject checkpoint) {
        try {
            return new TurnSubmission(
                turn.turnId,
                turn.characterId,
                turn.sourceMessageId,
                TurnKind.valueOf(turn.kind),
                turn.inputJson,
                turn.snapshotJson,
                turn.cloudJobId,
                checkpointEnvelope(checkpoint).getLong("createdAt"),
                checkpoint.getString("authoritativeTurnId"),
                BridgeAuthority.canonicalJson(checkpoint)
            );
        } catch (Exception error) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
    }

    private static boolean isStoreOwnedV3(ChatTurnEntity turn) {
        if (turn.bridgeProtocolVersion == null) return false;
        if (turn.bridgeProtocolVersion != 3 || !hasExactStoreMarker(turn.snapshotJson)) {
            throw bridgeAuthorityConflict(turn.turnId);
        }
        return true;
    }

    private static boolean hasExactStoreMarker(String snapshotJson) {
        try {
            JSONObject snapshot = new JSONObject(snapshotJson);
            JSONObject marker = snapshot.optJSONObject("_alBridgeProtocol");
            return marker != null && keysOf(marker).equals(new HashSet<>(Arrays.asList("version", "owner")))
                && marker.opt("version") instanceof Integer
                && marker.getInt("version") == 3
                && marker.opt("owner") instanceof String
                && "room-v12".equals(marker.getString("owner"));
        } catch (Exception error) {
            return false;
        }
    }

    private static String snapshotForLegacyRetry(String snapshotJson) {
        try {
            JSONObject snapshot = new JSONObject(snapshotJson);
            if (!snapshot.has("_alBridgeProtocol")) return snapshotJson;
            snapshot.remove("_alBridgeProtocol");
            return snapshot.toString();
        } catch (Exception error) {
            throw new IllegalArgumentException("snapshotJson is invalid", error);
        }
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }

    static String canonicalRawMessageJson(RawMessageEntity row) {
        if (row == null) throw new IllegalArgumentException("raw message is required");
        return BridgeAuthority.canonicalJson(canonicalRawMessageObject(row));
    }

    static String canonicalRawMessageChecksum(RawMessageEntity row) {
        return BridgeAuthority.sha256CanonicalJson(canonicalRawMessageObject(row));
    }

    private static JSONObject canonicalRawMessageObject(RawMessageEntity row) {
        try {
            return new JSONObject()
                .put("messageId", row.messageId)
                .put("turnId", row.turnId)
                .put("characterId", row.characterId)
                .put("speakerId", row.speakerId)
                .put("speakerType", row.speakerType)
                .put("recipientId", row.recipientId)
                .put("content", row.content)
                .put("sentAt", row.sentAt)
                .put("origin", row.origin)
                .put("deviceId", row.deviceId)
                .put("deviceSeq", row.deviceSeq);
        } catch (Exception error) {
            throw new IllegalArgumentException("canonical raw message conflict", error);
        }
    }

    private static String nullableString(JSONObject value, String key) throws Exception {
        Object raw = value.get(key);
        return raw == JSONObject.NULL ? null : (String) raw;
    }

    private static boolean sameNullable(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    private static String requireBridgeIdentity(String value, String label) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        return value;
    }

    private static final class Anchor {
        final String turnId;
        final String groupId;

        Anchor(String turnId, String groupId) {
            this.turnId = turnId;
            this.groupId = groupId;
        }
    }

    private static final class MemberCheckpoint {
        final ExecutionAttemptEntity attempt;
        final JSONObject checkpoint;

        MemberCheckpoint(ExecutionAttemptEntity attempt, JSONObject checkpoint) {
            this.attempt = attempt;
            this.checkpoint = checkpoint;
        }
    }

    private static final class MemberAggregate {
        final MemberCheckpoint first;
        final String immutableTuple;
        MemberCheckpoint terminal;
        String terminalOutcome;

        MemberAggregate(MemberCheckpoint first, String immutableTuple) {
            this.first = first;
            this.immutableTuple = immutableTuple;
        }
    }

    private static final class ActionProjection {
        final String type;
        final JSONObject legacyPayload;

        ActionProjection(String type, JSONObject legacyPayload) {
            this.type = type;
            this.legacyPayload = legacyPayload;
        }
    }

    private static String requireCharacterId(String characterId) {
        if (characterId == null || characterId.trim().isEmpty()) {
            throw new IllegalArgumentException("characterId is required");
        }
        return characterId.trim();
    }

    static String snapshotForNewTurn(String snapshotJson, String characterId) {
        try {
            JSONObject snapshot = new JSONObject(snapshotJson == null ? "{}" : snapshotJson);
            snapshot.remove("_alBridgeProtocol");
            if ("yuqi".equals(characterId)) {
                snapshot.put("_alBridgeProtocol", new JSONObject()
                    .put("version", 3)
                    .put("owner", "room-v12"));
            }
            return snapshot.toString();
        } catch (Exception error) {
            throw new IllegalArgumentException("snapshotJson is invalid", error);
        }
    }

    private static String groupId(ChatTurnEntity turn) {
        return turn.visibleGroupId == null || turn.visibleGroupId.trim().isEmpty()
            ? turn.turnId
            : turn.visibleGroupId;
    }

    private static long visibilitySequence(ChatTurnEntity turn) {
        return turn.inputVisibilitySequence == null ? 0L : turn.inputVisibilitySequence;
    }

    private static boolean hasTerminalReceipt(ChatTurnEntity turn) {
        return turn.authorityLineageKey != null
            && turn.visibleGroupId != null
            && turn.commitPayloadVersion != null
            && turn.bridgeCommitChecksum != null
            && turn.terminalDisposition != null;
    }

    private static boolean sameReceipt(
        ChatTurnEntity turn,
        String authorityLineageKey,
        String visibleGroupId,
        String commitPayloadVersion,
        String bridgeCommitChecksum,
        String terminalDisposition
    ) {
        return authorityLineageKey.equals(turn.authorityLineageKey)
            && visibleGroupId.equals(turn.visibleGroupId)
            && commitPayloadVersion.equals(turn.commitPayloadVersion)
            && bridgeCommitChecksum.equals(turn.bridgeCommitChecksum)
            && terminalDisposition.equals(turn.terminalDisposition);
    }

    private static IllegalStateException bridgeAuthorityConflict(String turnId) {
        return new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
    }

    private ChatTurnEntity requireTurn(String turnId) {
        ChatTurnEntity turn = dao.turn(turnId);
        if (turn == null) throw new IllegalArgumentException("Unknown turn: " + turnId);
        return turn;
    }

    private void insertTurnChange(String turnId, String type, long now) {
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = type;
        change.payloadJson = "{\"turnId\":\"" + turnId + "\"}";
        change.createdAt = now;
        dao.insertChange(change);
    }

    private void insertDiagnostic(
        String turnId,
        String attemptId,
        String level,
        String code,
        String detail,
        long now
    ) {
        DiagnosticEntity diagnostic = new DiagnosticEntity();
        diagnostic.turnId = limit(turnId, 96);
        diagnostic.attemptId = limit(attemptId, 128);
        diagnostic.level = limit(level == null ? "INFO" : level, 16);
        diagnostic.code = limit(code == null ? "UNKNOWN" : code, 64);
        diagnostic.detail = limit(redact(detail), 600);
        diagnostic.createdAt = now > 0 ? now : System.currentTimeMillis();
        dao.insertDiagnostic(diagnostic);
    }

    private static String redact(String value) {
        if (value == null) return "";
        return value
            .replaceAll("sk-[A-Za-z0-9_-]{8,}", "sk-***")
            .replaceAll("(?i)Bearer\\s+[A-Za-z0-9._~-]{8,}", "Bearer ***");
    }

    private static String limit(String value, int maxLength) {
        String safe = value == null ? "" : value;
        return safe.length() <= maxLength ? safe : safe.substring(0, maxLength);
    }

    private static ExecutionAttemptEntity newAttempt(
        String turnId,
        String attemptId,
        int sequence,
        long now
    ) {
        ExecutionAttemptEntity attempt = new ExecutionAttemptEntity();
        attempt.attemptId = attemptId;
        attempt.turnId = turnId;
        attempt.sequence = sequence;
        attempt.stage = AttemptStage.QUEUED.name();
        attempt.state = TurnState.QUEUED.name();
        attempt.startedAt = now;
        attempt.heartbeatAt = now;
        return attempt;
    }

    @NonNull
    private static String newAttemptId(String turnId, int sequence) {
        return "attempt_" + turnId + "_" + sequence + "_" + UUID.randomUUID();
    }
}
