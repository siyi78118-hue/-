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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

public final class RoomExecutionStore implements ExecutionStore, ExecutionEngineStore {
    public enum DeliveryDisposition { APPLY, REDACTED }

    private final AlExecutionDatabase database;
    private final AlExecutionDao dao;

    public RoomExecutionStore(AlExecutionDatabase database) {
        this.database = database;
        this.dao = database.executionDao();
    }

    @Override
    public ChatTurnEntity submitTurn(TurnSubmission submission) {
        AtomicReference<ChatTurnEntity> result = new AtomicReference<>();
        database.runInTransaction(() -> {
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
            turn.snapshotJson = submission.snapshotJson;
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
            boolean replacesPayload = inputJson != null || snapshotJson != null;
            if (replacesPayload) {
                if (inputJson == null || inputJson.trim().isEmpty() || snapshotJson == null || snapshotJson.trim().isEmpty()) {
                    throw new IllegalArgumentException("retry inputJson and snapshotJson are both required");
                }
                if (dao.replaceRetryPayload(turnId, inputJson, snapshotJson, now) != 1) {
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

    private static String requireCharacterId(String characterId) {
        if (characterId == null || characterId.trim().isEmpty()) {
            throw new IllegalArgumentException("characterId is required");
        }
        return characterId.trim();
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
