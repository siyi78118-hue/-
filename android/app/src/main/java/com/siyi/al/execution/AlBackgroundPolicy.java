package com.siyi.al.execution;

public final class AlBackgroundPolicy {
    public static final long PERIODIC_RECOVERY_MINUTES = 15L;
    public static final long FOREGROUND_SCAN_SECONDS = 60L;
    private AlBackgroundPolicy() {}
    public static boolean expedite(long delaySeconds) { return delaySeconds <= 0; }
}
