package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public final class RoleNotificationCancellationContractTest {
    @Test
    public void deduplicatesCollidingDeterministicNotificationIdsInStableOrder() {
        String firstCollision = "task20e-collision-Aa";
        String secondCollision = "task20e-collision-BB";
        assertEquals(
            AlNotificationFactory.messageNotificationId(firstCollision),
            AlNotificationFactory.messageNotificationId(secondCollision)
        );

        List<Integer> ids = RoleNotificationCancellationContract.notificationIdsForTurns(
            Arrays.asList("task20e-z", firstCollision, secondCollision, "task20e-a")
        );

        assertEquals(3, ids.size());
        assertTrue(ids.get(0) < ids.get(1));
        assertTrue(ids.get(1) < ids.get(2));
    }

    @Test
    public void acceptsOnlyTheDeterministicMessageNotificationRange() {
        assertTrue(RoleNotificationCancellationContract.isValidNotificationId(72_000));
        assertTrue(RoleNotificationCancellationContract.isValidNotificationId(91_999));
        assertFalse(RoleNotificationCancellationContract.isValidNotificationId(71_999));
        assertFalse(RoleNotificationCancellationContract.isValidNotificationId(92_000));
    }
}
