package com.siyi.al.execution;

import androidx.annotation.NonNull;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ConversationAuthorityEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.DiagnosticEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.bridge.BridgeInput;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONArray;

public final class RoomExecutionStore implements ExecutionStore, ExecutionEngineStore {
    public enum DeliveryDisposition { APPLY, REDACTED }

    private final AlExecutionDatabase database;
    private final AlExecutionDao dao;
    private static final Set<String> CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome"
    ));
    private static final Set<String> OUTCOME_KEYS = new HashSet<>(Arrays.asList(
        "type", "route", "relayMessageId", "failure", "result", "redactedAt"
    ));

    public RoomExecutionStore(AlExecutionDatabase database) {
        this.database = database;
        this.dao = database.executionDao();
    }

    @Override
    public ChatTurnEntity submitTurn(TurnSubmission submission) {
        AtomicReference<ChatTurnEntity> result = new AtomicReference<>();
        database.runInTransaction(() -> {
            String safeSnapshotJson = snapshotForNewTurn(submission.snapshotJson, submission.characterId);
            ChatTurnEntity existing = dao.turn(submission.turnId);
            if (existing != null) {
                result.set(existing);
                return;
            }
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
            if (dao.insertTurn(turn) == -1L) {
                result.set(dao.turn(submission.turnId));
                return;
            }
            dao.insertAttempt(newAttempt(turn.turnId, attemptId, 1, now));
            insertTurnChange(turn.turnId, "TURN_QUEUED", now);
            insertDiagnostic(turn.turnId, attemptId, "INFO", "TURN_QUEUED", turn.kind, now);
            result.set(turn);
        });
        return result.get();
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
                Long latestCreatedAt = latestDirectCreatedAtByCharacter.get(turn.characterId);
                if (latestCreatedAt == null) {
                    ChatTurnEntity latest = dao.latestDirectTurn(turn.characterId);
                    latestCreatedAt = latest == null ? turn.createdAt : latest.createdAt;
                    latestDirectCreatedAtByCharacter.put(turn.characterId, latestCreatedAt);
                }
                if (turn.createdAt < latestCreatedAt) continue;
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
        ChatTurnEntity turn = requireTurn(turnId);
        if (!attemptId.equals(turn.activeAttemptId)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (turn.inputVisibilitySequence != null
            && classifyIncomingGroup(turn.characterId, groupId(turn), turn.inputVisibilitySequence)
                == DeliveryDisposition.REDACTED) {
            throw new IllegalStateException("LATE_RESULT_REDACTED: " + turnId);
        }
        dao.commitReply(turnId, attemptId, parts, now);
        markNativeCompleted(turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
    }

    @Override
    public void commitSkip(String turnId, String attemptId, long now) {
        ChatTurnEntity turn = requireTurn(turnId);
        if (!attemptId.equals(turn.activeAttemptId)) throw new StaleAttemptException(turnId, attemptId);
        dao.commitSkip(turnId, attemptId, now);
        markNativeCompleted(turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
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
        ChatTurnEntity turn = requireTurn(turnId);
        if (turn.notificationShownAt != null) return;
        if (dao.markNotificationShown(turnId, now) != 1) {
            throw new IllegalStateException("Unable to record notification for " + turnId);
        }
    }

    @Override
    public void acknowledgeUiApplied(String turnId, long now) {
        ChatTurnEntity turn = requireTurn(turnId);
        if (turn.uiAppliedAt == null && dao.acknowledgeUiApplied(turnId, now) != 1) {
            throw new IllegalStateException("Unable to acknowledge UI result for " + turnId);
        }
        markUiApplied(turn.characterId, turnId, groupId(turn), visibilitySequence(turn), now);
    }

    @Override
    public ConversationCursorEntity getConversationCursor(String characterId) {
        return dao.conversationCursor(requireCharacterId(characterId));
    }

    public void markNativeCompleted(
        String characterId,
        String turnId,
        String visibleGroupId,
        long localSequence,
        long now
    ) {
        database.runInTransaction(() -> {
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
        });
    }

    public void markUiApplied(
        String characterId,
        String turnId,
        String visibleGroupId,
        long localSequence,
        long now
    ) {
        database.runInTransaction(() -> {
            ConversationCursorEntity cursor = cursorFor(characterId, now);
            if ((cursor.clearEpoch > 0L && localSequence <= cursor.clearedThroughSequence)
                || localSequence < cursor.localSequence) return;
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
        });
    }

    public DeliveryDisposition classifyIncomingGroup(String characterId, String visibleGroupId, long localSequence) {
        ConversationCursorEntity cursor = dao.conversationCursor(requireCharacterId(characterId));
        return cursor != null && cursor.clearEpoch > 0L && localSequence <= cursor.clearedThroughSequence
            ? DeliveryDisposition.REDACTED
            : DeliveryDisposition.APPLY;
    }

    @Override
    public void markConversationCleared(
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
    public void markCloudConfirmed(String turnId, long now) {
        ChatTurnEntity turn = requireTurn(turnId);
        if (turn.cloudConfirmedAt != null) return;
        if (turn.uiAppliedAt == null) {
            throw new IllegalStateException("Cannot confirm cloud delivery before UI landing for " + turnId);
        }
        if (dao.markCloudConfirmed(turnId, now) != 1) {
            throw new IllegalStateException("Unable to record cloud confirmation for " + turnId);
        }
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
                    remoteTurnId = checkpoint.getString("authoritativeTurnId");
                    JSONObject outcome = checkpoint.getJSONObject("outcome");
                    if ("committed".equals(outcome.getString("type"))) {
                        remoteTurnId = outcome.getJSONObject("result").getString("turnId");
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
            return;
        }
        if (failure != JSONObject.NULL || !(result instanceof JSONObject)
            || !(redactedAt instanceof Number)
            || redactedAt instanceof Float || redactedAt instanceof Double
            || ((Number) redactedAt).longValue() <= 0L) {
            throw bridgeAuthorityConflict(turn.turnId);
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

    private static String nullableString(JSONObject value, String key) throws Exception {
        Object raw = value.get(key);
        return raw == JSONObject.NULL ? null : (String) raw;
    }

    private static boolean sameNullable(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    private static String requireBridgeIdentity(String value, String label) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: invalid " + label);
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
        return new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT: " + turnId);
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
