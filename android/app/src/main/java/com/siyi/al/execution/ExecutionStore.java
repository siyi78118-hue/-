package com.siyi.al.execution;

import com.siyi.al.execution.db.ChangeEventEntity;
 import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;

public interface ExecutionStore {
    ChatTurnEntity submitTurn(TurnSubmission submission);

    ExecutionAttemptEntity startRetry(String turnId, long now);

    ExecutionAttemptEntity startRetry(String turnId, long now, String inputJson, String snapshotJson);

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

    void commitSkip(String turnId, String attemptId, long now);

    void cancelTurn(String turnId, long now, boolean deleted);

    ChatTurnEntity turn(String turnId);

    List<ReplyPartEntity> replyParts(String turnId);

    TurnState displayState(String turnId);

    List<ChangeEventEntity> changesAfter(long cursor, int limit);

    List<ChatTurnEntity> unappliedCompletedTurns(int limit);

    List<ChatTurnEntity> recentCompletedTurns(int limit);

    void markNotificationShown(String turnId, long now);

    void acknowledgeUiApplied(String turnId, long now);

    ConversationCursorEntity getConversationCursor(String characterId);

    LifecycleControl createConversationClear(String characterId, String expectedCursorChecksum);

    List<LifecycleControl> lifecycleControls();

    LifecycleControl lifecycleControl(String controlId);

    LifecycleControl claimLifecycleControl(long now);

    boolean acceptLifecycleRelay(
        String controlId,
        String semanticChecksum,
        String leaseId,
        long leaseAttempt,
        long leasedAt,
        String relayMessageId,
        long relayExpiresAt,
        long now
    );

    boolean applyLifecycleControl(
        String controlId,
        String semanticChecksum,
        Long clearEpoch,
        Long clearedThroughSequence,
        long appliedAt,
        long now
    );

    /** Applies an ACK while retaining the inbound relay identity for conflict dedupe. */
    default boolean applyLifecycleControl(
        String controlId,
        String semanticChecksum,
        Long clearEpoch,
        Long clearedThroughSequence,
        long appliedAt,
        long now,
        String inboundRelayMessageId
    ) {
        return applyLifecycleControl(
            controlId, semanticChecksum, clearEpoch, clearedThroughSequence, appliedAt, now);
    }

    /** Applies a LAN proof only when the exact claimed lease still owns the pending row. */
    default boolean applyLifecycleControl(
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
        return applyLifecycleControl(
            controlId, semanticChecksum, clearEpoch, clearedThroughSequence, appliedAt, now);
    }

    /** Handles a changed ACK proof against an already applied control without downgrading it. */
    default boolean recordLifecycleAppliedAckConflict(
        String controlId,
        String expectedControlChecksum,
        String conflictChecksum,
        String inboundRelayMessageId,
        long now
    ) {
        return false;
    }

    /** Durably consumes a valid applied ACK whose local control is unknown. */
    default boolean recordUnknownLifecycleAckTerminal(
        String peerId,
        String inboundRelayMessageId,
        long relayExpiresAt,
        String controlId,
        String controlChecksum,
        String ackChecksum,
        long createdAt
    ) {
        return false;
    }

    boolean quarantineLifecycleControl(String controlId, String semanticChecksum, long now);

    /** Quarantines only the pending lease snapshot supplied by the caller. */
    default boolean quarantineLifecycleControl(
        String controlId,
        String semanticChecksum,
        String leaseId,
        long leaseAttempt,
        Long leasedAt,
        long now
    ) {
        return quarantineLifecycleControl(controlId, semanticChecksum, now);
    }

    boolean quarantineLifecycleRelayAcceptedExact(
        String controlId, String semanticChecksum,
        String relayMessageId, long relayExpiresAt, long now
    );

    /** Quarantines a changed applied proof and records the inbound conflict identity. */
    default boolean quarantineLifecycleRelayAcceptedExact(
        String controlId,
        String semanticChecksum,
        String relayMessageId,
        long relayExpiresAt,
        String inboundRelayMessageId,
        String conflictChecksum,
        long now
    ) {
        return quarantineLifecycleRelayAcceptedExact(
            controlId, semanticChecksum, relayMessageId, relayExpiresAt, now);
    }

    void markCloudConfirmed(String turnId, long now);
}
