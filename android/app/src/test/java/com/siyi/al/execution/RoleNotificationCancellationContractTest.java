package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.db.RoleNotificationCancellationEntity;
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
    public void acceptsOnlyAnExactExistingCancellationAsAnIdempotentReplay() {
        RoleNotificationCancellationEntity expected = cancellation("control", "yuqi", 72_123, "checksum", 10L);
        RoleNotificationCancellationEntity exact = cancellation("control", "yuqi", 72_123, "checksum", 10L);
        assertTrue(RoleNotificationCancellationContract.isExactReplay(exact, expected));

        RoleNotificationCancellationEntity changedRole = cancellation("control", "xumi", 72_123, "checksum", 10L);
        RoleNotificationCancellationEntity changedState = cancellation("control", "yuqi", 72_123, "checksum", 10L);
        changedState.state = "done";
        assertFalse(RoleNotificationCancellationContract.isExactReplay(changedRole, expected));
        assertFalse(RoleNotificationCancellationContract.isExactReplay(changedState, expected));
        assertFalse(RoleNotificationCancellationContract.isExactReplay(null, expected));
    }

    private static RoleNotificationCancellationEntity cancellation(
        String controlId, String characterId, int notificationId, String checksum, long createdAt
    ) {
        RoleNotificationCancellationEntity row = new RoleNotificationCancellationEntity();
        row.cancellationKey = "rncan_" + checksum;
        row.controlId = controlId;
        row.characterId = characterId;
        row.notificationId = notificationId;
        row.intentChecksum = checksum;
        row.state = "waiting";
        row.createdAt = createdAt;
        row.updatedAt = createdAt;
        return row;
    }

    @Test
    public void acceptsOnlyTheDeterministicMessageNotificationRange() {
        assertTrue(RoleNotificationCancellationContract.isValidNotificationId(72_000));
        assertTrue(RoleNotificationCancellationContract.isValidNotificationId(91_999));
        assertFalse(RoleNotificationCancellationContract.isValidNotificationId(71_999));
        assertFalse(RoleNotificationCancellationContract.isValidNotificationId(92_000));
    }
}
