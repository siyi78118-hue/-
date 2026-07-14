package com.siyi.al.execution;

import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;

public interface ExecutionStore {
    ChatTurnEntity submitTurn(TurnSubmission submission);

    ExecutionAttemptEntity startRetry(String turnId, long now);

    ExecutionAttemptEntity activeAttempt(String turnId);

    void markFailed(
        String turnId,
        String attemptId,
        String code,
        String detail,
        boolean retryable,
        long now
    );

    void commitReply(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        long now
    );

    void cancelTurn(String turnId, long now, boolean deleted);

    ChatTurnEntity turn(String turnId);

    List<ReplyPartEntity> replyParts(String turnId);

    TurnState displayState(String turnId);

    List<ChangeEventEntity> changesAfter(long cursor, int limit);

    List<ChatTurnEntity> unappliedCompletedTurns(int limit);

    void acknowledgeUiApplied(String turnId, long now);
}
