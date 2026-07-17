package com.siyi.al.execution;

public final class AutomaticTaskContinuationPolicy {
    private AutomaticTaskContinuationPolicy() {}

    public static boolean useDiceContinuation(String previousMode, boolean hasExplicitSchedule) {
        return !hasExplicitSchedule || "dice".equals(previousMode);
    }

    public static long delayMs(long intervalMs, double chance, int maxRolls, double random) {
        long interval = Math.max(60_000L, intervalMs);
        double boundedChance = Math.max(0d, Math.min(1d, chance));
        int max = Math.max(1, maxRolls);
        double boundedRandom = Math.max(0d, Math.min(Math.nextDown(1d), random));
        int rolls;
        if (boundedChance <= 0d) rolls = max;
        else if (boundedChance >= 1d) rolls = 1;
        else rolls = (int) Math.floor(Math.log(1d - boundedRandom) / Math.log(1d - boundedChance)) + 1;
        rolls = Math.max(1, Math.min(max, rolls));
        return interval * rolls;
    }
}
