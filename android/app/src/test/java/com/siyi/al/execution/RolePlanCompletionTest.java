package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

public class RolePlanCompletionTest {
    @Test
    public void oncePlanBecomesCompletedAfterItsOccurrence() throws Exception {
        long scheduledFor = 1784890800000L;
        long completedAt = scheduledFor + 30_000L;
        JSONObject plan = new JSONObject()
            .put("planId", "plan_once")
            .put("status", "active")
            .put("nextRunAt", scheduledFor)
            .put("schedule", new JSONObject()
                .put("kind", "once")
                .put("at", "2026-07-24T15:00:00.000+08:00"));

        RolePlanCompletion.Result result = RolePlanCompletion.advance(plan, scheduledFor, completedAt);

        assertEquals("completed", result.status);
        assertNull(result.nextRunAt);
        assertEquals(completedAt, result.planJson.getLong("completedAt"));
        assertEquals(scheduledFor, result.planJson.getLong("lastScheduledFor"));
    }

    @Test
    public void recurringPlanAdvancesPastCompletionTimeWithoutReplayingMissedOccurrences() throws Exception {
        long scheduledFor = 1784890800000L;
        long completedAt = scheduledFor + 3L * 24L * 60L * 60L * 1000L;
        JSONObject plan = new JSONObject()
            .put("planId", "plan_daily")
            .put("status", "active")
            .put("nextRunAt", scheduledFor)
            .put("schedule", new JSONObject()
                .put("kind", "daily")
                .put("time", "15:00"));

        RolePlanCompletion.Result result = RolePlanCompletion.advance(plan, scheduledFor, completedAt);

        assertEquals("active", result.status);
        assertEquals(
            RolePlanSchedule.nextOccurrence(plan.getJSONObject("schedule"), completedAt).longValue(),
            result.nextRunAt.longValue()
        );
        assertEquals(completedAt, result.planJson.getLong("lastRunAt"));
    }

    @Test
    public void failedOccurrenceKeepsItsScheduledTimeAndMakesThePlanRetryable() throws Exception {
        long scheduledFor = 1784890800000L;
        JSONObject plan = new JSONObject()
            .put("planId", "plan_retry")
            .put("status", "active")
            .put("nextRunAt", scheduledFor)
            .put("schedule", new JSONObject().put("kind", "daily").put("time", "15:00"));

        RolePlanCompletion.Result result = RolePlanCompletion.fail(
            plan, scheduledFor, scheduledFor + 60_000L, "TURN_FAILED_FINAL"
        );

        assertEquals("failed", result.status);
        assertEquals(scheduledFor, result.nextRunAt.longValue());
        assertEquals("TURN_FAILED_FINAL", result.planJson.getString("lastErrorCode"));
    }
}
