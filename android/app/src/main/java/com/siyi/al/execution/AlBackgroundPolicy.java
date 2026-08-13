package com.siyi.al.execution;

public final class AlBackgroundPolicy {
    public static final long PERIODIC_RECOVERY_MINUTES = 15L;
    public static final long FOREGROUND_SCAN_SECONDS = 15L;
    private AlBackgroundPolicy() {}
    public static boolean expedite(long delaySeconds) { return delaySeconds <= 0; }

    public static long transientRetryDelaySeconds(int attemptSequence) {
        if (attemptSequence == 1) return 15L;
        if (attemptSequence == 2) return 60L;
        if (attemptSequence == 3) return 300L;
        return -1L;
    }
}
