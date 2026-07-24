package com.siyi.al.execution;

import org.json.JSONObject;

final class RolePlanCompletion {
    static final class Result {
        final JSONObject planJson;
        final String status;
        final Long nextRunAt;

        Result(JSONObject planJson, String status, Long nextRunAt) {
            this.planJson = planJson;
            this.status = status;
            this.nextRunAt = nextRunAt;
        }
    }

    private RolePlanCompletion() {}

    static Result advance(JSONObject source, long scheduledFor, long completedAt) throws Exception {
        JSONObject plan = new JSONObject(source.toString());
        JSONObject schedule = plan.optJSONObject("schedule");
        Long nextRunAt = schedule == null
            ? null
            : RolePlanSchedule.nextOccurrence(schedule, Math.max(scheduledFor, completedAt));
        plan.put("lastRunAt", completedAt);
        plan.put("lastScheduledFor", scheduledFor);
        plan.put("updatedAt", completedAt);
        plan.put("cloudJobId", JSONObject.NULL);
        if (nextRunAt == null) {
            plan.put("status", "completed");
            plan.put("completedAt", completedAt);
            plan.put("nextRunAt", JSONObject.NULL);
            return new Result(plan, "completed", null);
        }
        plan.put("status", "active");
        plan.put("nextRunAt", nextRunAt);
        plan.remove("completedAt");
        return new Result(plan, "active", nextRunAt);
    }

    static Result fail(JSONObject source, long scheduledFor, long failedAt, String errorCode) throws Exception {
        JSONObject plan = new JSONObject(source.toString());
        plan.put("status", "failed");
        plan.put("nextRunAt", scheduledFor);
        plan.put("lastErrorCode", errorCode == null ? "TURN_FAILED_FINAL" : errorCode);
        plan.put("lastFailedAt", failedAt);
        plan.put("updatedAt", failedAt);
        return new Result(plan, "failed", scheduledFor);
    }
}
