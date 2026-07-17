package com.siyi.al.execution;

public final class RolePlanRecoveryPolicy {
    private RolePlanRecoveryPolicy() {}
    public static boolean claimable(String status, String type, long scheduledFor, long now) {
        return "active".equals(status)
            && ("private_message".equals(type) || "moment_post".equals(type))
            && scheduledFor <= now;
    }
    public static String timingContext(long scheduledFor, long executedAt) {
        return "scheduledFor=" + scheduledFor + ";executedAt=" + executedAt + ";delayMs=" + Math.max(0L, executedAt - scheduledFor);
    }
}
