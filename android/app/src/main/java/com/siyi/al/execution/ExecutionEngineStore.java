package com.siyi.al.execution;

import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.bridge.BridgeResult;
import java.util.List;

public interface ExecutionEngineStore {
    ChatTurnEntity claimNext(long now);
    List<ExecutionAttemptEntity> recoverableAttempts();
    ChatTurnEntity turn(String turnId);
    ExecutionAttemptEntity activeAttempt(String turnId);
    TurnSubmission prepareBridgeSubmission(TurnSubmission base, String bridgeDeviceId, long now);
    /** Re-check retained lifecycle tombstones immediately before network dispatch. */
    default void assertBridgeSubmissionStillAllowed(TurnSubmission submission) {
        // Legacy test stores and non-Room adapters have no lifecycle authority.
    }
    RoomExecutionStore.DeliveryDisposition commitBridgedTerminal(
        String turnId, String attemptId, BridgeResult result, long now);
    /**
     * Terminal v3 result with the authenticated bridge peer captured before
     * transport.  Room implementations may consume a retained role-delete
     * tombstone when the turn was removed while the request was in flight.
     */
    default RoomExecutionStore.DeliveryDisposition commitBridgedTerminalWithPeer(
        String turnId, String attemptId, BridgeResult result, String authenticatedPeerId, long now
    ) {
        return commitBridgedTerminal(turnId, attemptId, result, now);
    }
    RoomExecutionStore.DeliveryDisposition commitAndroidFallback(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        String terminalDisposition,
        long now
    );
    void commitVerifiedRemoteFailure(
        String turnId, String attemptId, BridgeResult result, long now);
    /** Same retained-role-delete handling for a strictly parsed v3 failure. */
    default void commitVerifiedRemoteFailureWithPeer(
        String turnId, String attemptId, BridgeResult result, String authenticatedPeerId, long now
    ) {
        commitVerifiedRemoteFailure(turnId, attemptId, result, now);
    }
    void markStage(String turnId, String attemptId, TurnState state, AttemptStage stage, long now);
    void markBridgeWaiting(String turnId, String attemptId, String route, long now);
    void saveMemoryResult(String turnId, String attemptId, String memory, long now);
    void saveRawReply(String turnId, String attemptId, String rawReply, long now);
    void commitReply(String turnId, String attemptId, List<ReplyPartEntity> parts, long now);
    void commitSkip(String turnId, String attemptId, long now);
    void markInterrupted(String turnId, String attemptId, String code, long now);
    void markFailed(String turnId, String attemptId, String code, String detail, boolean retryable, long now);
}
