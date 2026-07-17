package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class AutomaticTaskRecoveryPolicyTest {
    @Test public void onlyCurrentEnabledDueCloudJobIsRecovered() {
        assertTrue(AutomaticTaskRecoveryPolicy.claimable(true, "job-new", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(false, "job-new", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(true, "job-old", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(true, "job-new", "job-new", 1001L, 1000L));
    }
}
