package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.app.Notification;
import android.app.NotificationManager;
import org.junit.Test;

public class AlNotificationPolicyTest {
    @Test
    public void completedMessagesUseFreshPublicHighImportanceChannel() {
        assertNotEquals("al_messages", AlNotificationPolicy.MESSAGE_CHANNEL);
        assertEquals(NotificationManager.IMPORTANCE_HIGH, AlNotificationPolicy.messageImportance());
        assertEquals(Notification.VISIBILITY_PUBLIC, AlNotificationPolicy.messageVisibility());
    }

    @Test
    public void progressUsesSeparateSecretLowImportanceChannel() {
        assertNotEquals(AlNotificationPolicy.MESSAGE_CHANNEL, AlNotificationPolicy.PROGRESS_CHANNEL);
        assertEquals(NotificationManager.IMPORTANCE_LOW, AlNotificationPolicy.progressImportance());
        assertEquals(Notification.VISIBILITY_SECRET, AlNotificationPolicy.progressVisibility());
    }

    @Test
    public void completedNotificationOnlyUsesVisibleTextDisposition() {
        assertTrue(AlNotificationPolicy.shouldNotifyCompletedTurn("visible", 1, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("visible", 0, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("action_only", 1, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("skip", 0, false));
    }

    @Test
    public void deletedOrRedactedCompletedTurnNeverNotifies() {
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("visible", 1, true));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("action_only", 1, true));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("skip", 0, true));
    }

    @Test
    public void legacyNullDispositionWithTextRetainsNotificationCompatibility() {
        assertTrue(AlNotificationPolicy.shouldNotifyCompletedTurn(null, 1, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn(null, 0, false));
    }
}
