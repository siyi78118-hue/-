package com.siyi.al.execution;

public final class RolePlanOccurrenceKey {
    private RolePlanOccurrenceKey() {}
    public static String of(String planId, long scheduledFor) {
        return (planId == null ? "" : planId.trim()) + ":" + scheduledFor;
    }
    public static int notificationId(String occurrenceId) {
        return 72000 + Math.abs(String.valueOf(occurrenceId).hashCode() % 20000);
    }
}
