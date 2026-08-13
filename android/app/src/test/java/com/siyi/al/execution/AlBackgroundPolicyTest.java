package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AlBackgroundPolicyTest {
    @Test
    public void periodicRecoveryUsesAndroidMinimumWithoutBusyLooping() {
        assertEquals(15L, AlBackgroundPolicy.PERIODIC_RECOVERY_MINUTES);
        assertEquals(15L, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS);
        assertFalse(AlBackgroundPolicy.expedite(5));
    }

    @Test
    public void immediateFcmWakeIsExpedited() {
        assertTrue(AlBackgroundPolicy.expedite(0));
    }

    @Test
    public void transientBridgeFailuresUseBoundedBackoff() {
        assertEquals(15L, AlBackgroundPolicy.transientRetryDelaySeconds(1));
        assertEquals(60L, AlBackgroundPolicy.transientRetryDelaySeconds(2));
        assertEquals(300L, AlBackgroundPolicy.transientRetryDelaySeconds(3));
        assertEquals(-1L, AlBackgroundPolicy.transientRetryDelaySeconds(4));
    }

    @Test
    public void occurrenceIdentifierIsStableAcrossWakeSources() {
        assertEquals("plan-a:1784278800000", RolePlanOccurrenceKey.of("plan-a", 1784278800000L));
        assertEquals(
            RolePlanOccurrenceKey.notificationId("plan-a:1784278800000"),
            RolePlanOccurrenceKey.notificationId("plan-a:1784278800000")
        );
    }
}
