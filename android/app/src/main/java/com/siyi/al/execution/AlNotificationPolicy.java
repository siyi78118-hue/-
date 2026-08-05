package com.siyi.al.execution;

import android.app.Notification;
import android.app.NotificationManager;

public final class AlNotificationPolicy {
    public static final String MESSAGE_CHANNEL = "al_messages_v2";
    public static final String PROGRESS_CHANNEL = "al_message_progress";

    private AlNotificationPolicy() {}

    public static int messageImportance() {
        return NotificationManager.IMPORTANCE_HIGH;
    }

    public static int progressImportance() {
        return NotificationManager.IMPORTANCE_LOW;
    }

    public static int messageVisibility() {
        return Notification.VISIBILITY_PUBLIC;
    }

    public static int progressVisibility() {
        return Notification.VISIBILITY_SECRET;
    }

    public static boolean shouldNotifyCompletedTurn(
        String terminalDisposition,
        int replyPartCount,
        boolean deleted
    ) {
        if (deleted || replyPartCount <= 0) return false;
        return terminalDisposition == null || "visible".equals(terminalDisposition);
    }
}
