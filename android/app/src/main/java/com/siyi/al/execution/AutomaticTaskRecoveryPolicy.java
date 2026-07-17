package com.siyi.al.execution;

public final class AutomaticTaskRecoveryPolicy {
    private AutomaticTaskRecoveryPolicy() {}
    public static boolean claimable(boolean enabled, String candidateJobId, String stableJobId, long scheduledFor, long now) {
        String candidate = candidateJobId == null ? "" : candidateJobId.trim();
        String stable = stableJobId == null ? "" : stableJobId.trim();
        return enabled && !candidate.isEmpty() && candidate.equals(stable) && scheduledFor <= now;
    }
}
