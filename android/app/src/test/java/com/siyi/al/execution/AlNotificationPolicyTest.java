package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

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
}
