package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RolePlanRecoveryPolicyTest {
    @Test
    public void onlyActiveOverdueSendingPlansAreClaimable() {
        long now = 1_000L;
        assertTrue(RolePlanRecoveryPolicy.claimable("active", "private_message", 999L, now));
        assertTrue(RolePlanRecoveryPolicy.claimable("active", "moment_post", 999L, now));
        assertFalse(RolePlanRecoveryPolicy.claimable("paused", "private_message", 999L, now));
        assertFalse(RolePlanRecoveryPolicy.claimable("active", "role_schedule", 999L, now));
        assertFalse(RolePlanRecoveryPolicy.claimable("active", "private_message", 1_001L, now));
    }

    @Test
    public void promptTimingPreservesScheduledAndActualTimes() {
        assertEquals(
            "scheduledFor=900;executedAt=1200;delayMs=300",
            RolePlanRecoveryPolicy.timingContext(900L, 1200L)
        );
    }
}
