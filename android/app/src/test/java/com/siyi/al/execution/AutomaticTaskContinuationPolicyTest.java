package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class AutomaticTaskContinuationPolicyTest {
    @Test public void precomputesNextSuccessfulDiceWindow() {
        assertEquals(60_000L, AutomaticTaskContinuationPolicy.delayMs(60_000L, 0.5, 10, 0.1));
        assertEquals(180_000L, AutomaticTaskContinuationPolicy.delayMs(60_000L, 0.5, 10, 0.8));
        assertEquals(600_000L, AutomaticTaskContinuationPolicy.delayMs(60_000L, 0.0, 10, 0.2));
    }

    @Test public void plannedFollowUpMovesIntoDiceContinuation() {
        assertEquals(true, AutomaticTaskContinuationPolicy.useDiceContinuation("planned", false));
        assertEquals(true, AutomaticTaskContinuationPolicy.useDiceContinuation("dice", false));
        assertEquals(false, AutomaticTaskContinuationPolicy.useDiceContinuation("planned", true));
    }
}
