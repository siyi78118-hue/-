package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RoleDeletionDispatchPolicyTest {
    @Test
    public void tombstoneBlocksBeforeSemanticReadsAndAfterSubmit() {
        final boolean[] deleted = new boolean[] { false };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        assertFalse(RoleDeletionDispatchPolicy.blocked(reader, "yuqi"));
        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.blocked(reader, "yuqi"));
    }

    @Test
    public void tombstoneSubmitFailureIsSuppressedButOrdinaryFailureIsNot() {
        RoleDeletionDispatchPolicy.TombstoneReader deleted = roleId -> true;
        RoleDeletionDispatchPolicy.TombstoneReader live = roleId -> false;

        assertTrue(RoleDeletionDispatchPolicy.suppressFailure(deleted, "yuqi"));
        assertFalse(RoleDeletionDispatchPolicy.suppressFailure(live, "yuqi"));
    }

    @Test
    public void proactiveChatPreflightAndPostSubmitRaceAreBlocked() {
        final boolean[] deleted = new boolean[] { false };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        assertFalse(RoleDeletionDispatchPolicy.blocked(reader, "chat-role"));
        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.blocked(reader, "chat-role"));
    }

    @Test
    public void proactiveMomentPostSubmitRaceSuppressesPresentation() {
        final boolean[] deleted = new boolean[] { false };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        assertFalse(RoleDeletionDispatchPolicy.blocked(reader, "moment-role"));
        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.blocked(reader, "moment-role"));
    }

    @Test
    public void rolePlanPostDispatchRaceSuppressesPresentation() {
        final boolean[] deleted = new boolean[] { false };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        assertFalse(RoleDeletionDispatchPolicy.blocked(reader, "plan-role"));
        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.blocked(reader, "plan-role"));
    }

    @Test
    public void automaticRecoveryTombstoneFailureDoesNotBecomeRecoveryDiagnostic() {
        final boolean[] deleted = new boolean[] { false };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        assertFalse(RoleDeletionDispatchPolicy.suppressFailure(reader, "recovery-role"));
        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.suppressFailure(reader, "recovery-role"));
    }

    @Test
    public void postNotificationDeletionRaceCancelsTheSameDeterministicNotification() {
        final boolean[] deleted = new boolean[] { false };
        final int[] cancelled = new int[] { -1 };
        RoleDeletionDispatchPolicy.TombstoneReader reader = roleId -> deleted[0];

        deleted[0] = true;
        assertTrue(RoleDeletionDispatchPolicy.cancelPostedNotificationIfDeleted(
            reader, "yuqi", 731, notificationId -> cancelled[0] = notificationId));
        assertEquals(731, cancelled[0]);
    }
}
