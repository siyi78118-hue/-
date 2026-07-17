package com.siyi.al.execution;

import android.content.Context;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanOccurrenceEntity;
import java.util.List;
import org.json.JSONObject;

public final class RolePlanCoordinator {
    private final AlExecutionDatabase database;
    private final RoomExecutionStore store;

    public RolePlanCoordinator(Context context) {
        this(AlExecutionDatabase.get(context));
    }

    RolePlanCoordinator(AlExecutionDatabase database) {
        this.database = database;
        this.store = new RoomExecutionStore(database);
    }

    public int dispatchDue(long now) {
        int queued = 0;
        List<RolePlanEntity> plans = database.executionDao().dueRolePlans(now, 50);
        for (RolePlanEntity plan : plans) {
            if (plan.nextRunAt != null && claimAndQueue(plan, plan.nextRunAt, cloudJobId(plan), now)) queued += 1;
        }
        return queued;
    }

    public boolean dispatch(String planId, long scheduledFor, String jobId, long now) {
        RolePlanEntity plan = database.executionDao().rolePlan(planId);
        if (plan == null || plan.nextRunAt == null || plan.nextRunAt.longValue() != scheduledFor) return false;
        return claimAndQueue(plan, scheduledFor, jobId, now);
    }

    public boolean dispatchCurrent(String planId, String jobId, long now) {
        RolePlanEntity plan = database.executionDao().rolePlan(planId);
        return plan != null && plan.nextRunAt != null && claimAndQueue(plan, plan.nextRunAt, jobId, now);
    }

    public void completeForTurn(String turnId, long now) {
        RolePlanOccurrenceEntity occurrence = database.executionDao().rolePlanOccurrenceByTurn(turnId);
        if (occurrence != null) database.executionDao().completeRolePlanOccurrence(occurrence.occurrenceId, now);
    }

    private boolean claimAndQueue(RolePlanEntity plan, long scheduledFor, String jobId, long now) {
        try {
            JSONObject planJson = new JSONObject(plan.planJson);
            String type = planJson.optString("type", "");
            if (!RolePlanRecoveryPolicy.claimable(plan.status, type, scheduledFor, now)) return false;
            CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(plan.characterId + ":role-plan:" + plan.planId);
            if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) {
                store.recordDiagnostic("plan_" + safe(plan.planId), null, "WARN", "ROLE_PLAN_SNAPSHOT_MISSING", plan.planId, now);
                return false;
            }

            String occurrenceId = RolePlanOccurrenceKey.of(plan.planId, scheduledFor);
            String turnId = "plan_" + safe(occurrenceId);
            RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
            occurrence.occurrenceId = occurrenceId;
            occurrence.planId = plan.planId;
            occurrence.characterId = plan.characterId;
            occurrence.state = "CLAIMED";
            occurrence.turnId = turnId;
            occurrence.jobId = jobId == null ? "" : jobId;
            occurrence.scheduledFor = scheduledFor;
            occurrence.claimedAt = now;
            occurrence.updatedAt = now;
            if (database.executionDao().insertRolePlanOccurrence(occurrence) == -1L) return false;

            JSONObject context = new JSONObject(snapshot.contextJson);
            context.put("scheduledFor", scheduledFor);
            context.put("executedAt", now);
            context.put("delayMs", Math.max(0L, now - scheduledFor));
            context.put("timingContext", RolePlanRecoveryPolicy.timingContext(scheduledFor, now));
            if (jobId != null && !jobId.trim().isEmpty()) context.put("cloudJobId", jobId.trim());
            String source = planJson.optString("source", "spoken");
            boolean privateDecision = "private_decision".equals(source);
            TurnKind kind = "moment_post".equals(type)
                ? (privateDecision ? TurnKind.ROLE_PLAN_MOMENT_PRIVATE : TurnKind.ROLE_PLAN_MOMENT)
                : (privateDecision ? TurnKind.ROLE_PLAN_CHAT_PRIVATE : TurnKind.ROLE_PLAN_CHAT);
            JSONObject input = new JSONObject();
            input.put("planId", plan.planId);
            input.put("occurrenceId", occurrenceId);
            input.put("scheduledFor", scheduledFor);
            input.put("executedAt", now);
            ChatTurnEntity turn = store.submitTurn(new TurnSubmission(
                turnId, plan.characterId, occurrenceId, kind, input.toString(), context.toString(), jobId, now
            ));
            if (turn == null) {
                database.executionDao().failRolePlanOccurrence(occurrenceId, "TURN_QUEUE_FAILED", now);
                return false;
            }
            store.recordDiagnostic(turnId, turn.activeAttemptId, "INFO", "ROLE_PLAN_CLAIMED", RolePlanRecoveryPolicy.timingContext(scheduledFor, now), now);
            return true;
        } catch (Exception error) {
            store.recordDiagnostic("plan_" + safe(plan.planId), null, "ERROR", "ROLE_PLAN_CLAIM_FAILED", error.getMessage(), now);
            return false;
        }
    }

    private static String cloudJobId(RolePlanEntity plan) {
        try { return new JSONObject(plan.planJson).optString("cloudJobId", "").trim(); }
        catch (Exception ignored) { return ""; }
    }

    private static String safe(String value) {
        return String.valueOf(value == null ? "" : value).replaceAll("[^a-zA-Z0-9_-]", "_");
    }
}
