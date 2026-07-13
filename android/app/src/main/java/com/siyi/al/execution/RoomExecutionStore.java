package com.siyi.al.execution;

import androidx.annotation.NonNull;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

public final class RoomExecutionStore implements ExecutionStore {
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
            ChatTurnEntity existing = dao.turnBySourceMessage(submission.sourceMessageId);
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
                result.set(dao.turnBySourceMessage(submission.sourceMessageId));
                return;
            }
            dao.insertAttempt(newAttempt(turn.turnId, attemptId, 1, now));
            insertTurnChange(turn.turnId, "TURN_QUEUED", now);
            result.set(turn);
        });
        return result.get();
    }

    @Override
    public ExecutionAttemptEntity startRetry(String turnId, long now) {
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
            if (!attemptId.equals(turn.activeAttemptId)) {
                throw new StaleAttemptException(turnId, attemptId);
            }
            String state = retryable
                ? TurnState.FAILED_RETRYABLE.name()
                : TurnState.FAILED_FINAL.name();
            dao.markTurnFailed(turnId, attemptId, state, now);
            dao.markAttemptFailed(attemptId, state, code, detail, retryable, now);
            insertTurnChange(turnId, "TURN_FAILED", now);
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
        dao.commitReply(turnId, attemptId, parts, now);
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
