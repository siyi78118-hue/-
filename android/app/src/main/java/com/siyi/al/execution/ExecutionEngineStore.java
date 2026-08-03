package com.siyi.al.execution;

import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;

public interface ExecutionEngineStore {
    ChatTurnEntity claimNext(long now);
    List<ExecutionAttemptEntity> recoverableAttempts();
    ChatTurnEntity turn(String turnId);
    ExecutionAttemptEntity activeAttempt(String turnId);
    TurnSubmission prepareBridgeSubmission(TurnSubmission base, String bridgeDeviceId, long now);
    void markStage(String turnId, String attemptId, TurnState state, AttemptStage stage, long now);
    void markBridgeWaiting(String turnId, String attemptId, String route, long now);
    void saveMemoryResult(String turnId, String attemptId, String memory, long now);
    void saveRawReply(String turnId, String attemptId, String rawReply, long now);
    void commitReply(String turnId, String attemptId, List<ReplyPartEntity> parts, long now);
    void commitSkip(String turnId, String attemptId, long now);
    void markInterrupted(String turnId, String attemptId, String code, long now);
    void markFailed(String turnId, String attemptId, String code, String detail, boolean retryable, long now);
}
