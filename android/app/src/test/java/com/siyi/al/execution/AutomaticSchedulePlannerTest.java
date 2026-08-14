package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AutomaticSchedulePlannerTest {
    @Test
    public void retryAtDifferentWallClockTimesProducesTheSamePlan() {
        AutomaticSchedulePlanner planner = new AutomaticSchedulePlanner(
            "device-a", "char-a", "chat", "00112233445566778899aabbccddeeff",
            4L, "pro_previous_3"
        );
        AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
            "proactive_terminal", "turn-terminal-4", repeat('b', 64), 9L, 1786728000000L
        );
        AutomaticScheduleContract.Policy policy = new AutomaticScheduleContract.Policy(
            7L, repeat('a', 64), "planned", 60_000L, 600_000L, null
        );

        AutomaticSchedulePlanner.Plan first = planner.next(source, policy, 1_000L);
        AutomaticSchedulePlanner.Plan replay = planner.next(source, policy, 9_999_999L);

        assertEquals(first.jobId, replay.jobId);
        assertEquals(first.dueAt, replay.dueAt);
        assertEquals(first.transitionChecksum, replay.transitionChecksum);
        assertEquals(first.semanticChecksum, replay.semanticChecksum);
        assertTrue(first.dueAt >= source.occurredAt + policy.minDelayMs);
        assertTrue(first.dueAt <= source.occurredAt + policy.maxDelayMs);
    }

    @Test
    public void changedSourceChecksumChangesTheWholePlan() {
        AutomaticSchedulePlanner planner = new AutomaticSchedulePlanner(
            "device-a", "char-a", "moment", "00112233445566778899aabbccddeeff",
            1L, null
        );
        AutomaticScheduleContract.Policy policy = new AutomaticScheduleContract.Policy(
            1L, repeat('a', 64), "planned", 10_000L, 20_000L, null
        );
        AutomaticSchedulePlanner.Plan first = planner.next(
            new AutomaticScheduleContract.Source("bootstrap", "source-1", repeat('b', 64), 0L, 100_000L),
            policy, 100_000L
        );
        AutomaticSchedulePlanner.Plan changed = planner.next(
            new AutomaticScheduleContract.Source("bootstrap", "source-1", repeat('c', 64), 0L, 100_000L),
            policy, 100_000L
        );

        assertTrue(!first.jobId.equals(changed.jobId));
        assertTrue(!first.semanticChecksum.equals(changed.semanticChecksum));
    }

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }
}
