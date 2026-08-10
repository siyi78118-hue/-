package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AlNotificationStatusTest {
    @Test
    public void healthyRequiresPermissionAppChannelSoundVibrationAndPublicVisibility() {
        assertTrue(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(false, true, true, 4, true, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, false, true, 4, true, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, true, false, 4, true, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, true, true, 3, true, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, false, true, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, true, false, 1));
        assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, 0));
        assertTrue(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, -1000, 30));
        assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, -1000, 29));
    }

    @Test
    public void summaryNamesTheFirstActionableProblem() {
        assertTrue(AlNotificationStatus.summary(false, true, true, 4, true, true, 1).contains("权限"));
        assertTrue(AlNotificationStatus.summary(true, true, true, 4, false, true, 1).contains("声音"));
        assertTrue(AlNotificationStatus.summary(true, true, true, 4, true, true, 1).contains("正常"));
        assertEquals(
            AlNotificationStatus.summary(true, true, true, 4, true, true, 1),
            AlNotificationStatus.summary(true, true, true, 4, true, true, -1000, 30)
        );
        assertFalse(
            AlNotificationStatus.summary(true, true, true, 4, true, true, -1000, 29)
                .equals(AlNotificationStatus.summary(true, true, true, 4, true, true, -1000, 30))
        );
    }
}
