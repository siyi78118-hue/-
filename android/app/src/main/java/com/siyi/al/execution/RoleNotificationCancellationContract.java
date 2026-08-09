package com.siyi.al.execution;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/** Closed, metadata-only contract for durable role notification cancellation intents. */
final class RoleNotificationCancellationContract {
    static final int MIN_NOTIFICATION_ID = 72_000;
    static final int MAX_NOTIFICATION_ID = 91_999;

    private RoleNotificationCancellationContract() {}

    static boolean isValidNotificationId(int notificationId) {
        return notificationId >= MIN_NOTIFICATION_ID && notificationId <= MAX_NOTIFICATION_ID;
    }

    static List<Integer> notificationIdsForTurns(List<String> turnIds) {
        if (turnIds == null) throw new IllegalArgumentException("role notification turn IDs are required");
        TreeSet<Integer> unique = new TreeSet<>();
        for (String turnId : turnIds) {
            if (turnId == null || turnId.trim().isEmpty() || !turnId.equals(turnId.trim())) {
                throw new IllegalArgumentException("role notification turn ID is invalid");
            }
            int notificationId = AlNotificationFactory.messageNotificationId(turnId);
            if (!isValidNotificationId(notificationId)) {
                throw new IllegalStateException("role notification ID is outside the deterministic range");
            }
            unique.add(notificationId);
        }
        return new ArrayList<>(unique);
    }
}
