package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class TurnStateMachineTest {
    @Test
    public void committedReplyAlwaysDisplaysCompleted() {
        assertEquals(
            TurnState.COMPLETED,
            TurnStateMachine.deriveDisplayState(true, TurnState.FAILED_RETRYABLE)
        );
    }

    @Test
    public void staleAttemptCannotMoveCompletedTurnBackToFailed() {
        assertThrows(
            IllegalStateException.class,
            () -> TurnStateMachine.requireTransition(
                TurnState.COMPLETED,
                TurnState.FAILED_RETRYABLE
            )
        );
    }

    @Test
    public void normalPipelineTransitionsAreLegal() {
        TurnStateMachine.requireTransition(TurnState.QUEUED, TurnState.MEMORY_RUNNING);
        TurnStateMachine.requireTransition(TurnState.MEMORY_RUNNING, TurnState.MEMORY_DONE);
        TurnStateMachine.requireTransition(TurnState.MEMORY_DONE, TurnState.CHAT_RUNNING);
        TurnStateMachine.requireTransition(TurnState.CHAT_RUNNING, TurnState.CHAT_DONE);
        TurnStateMachine.requireTransition(TurnState.CHAT_DONE, TurnState.COMMITTED);
        TurnStateMachine.requireTransition(TurnState.COMMITTED, TurnState.NOTIFIED);
        TurnStateMachine.requireTransition(TurnState.NOTIFIED, TurnState.COMPLETED);
    }

    @Test
    public void cancelledAndFinalFailuresAreTerminal() {
        assertThrows(
            IllegalStateException.class,
            () -> TurnStateMachine.requireTransition(TurnState.CANCELLED, TurnState.QUEUED)
        );
        assertThrows(
            IllegalStateException.class,
            () -> TurnStateMachine.requireTransition(TurnState.FAILED_FINAL, TurnState.QUEUED)
        );
    }
}
