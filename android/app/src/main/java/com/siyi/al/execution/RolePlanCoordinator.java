package com.siyi.al.execution;

import android.content.Context;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanOccurrenceEntity;
import java.util.List;
import java.util.Collections;
import org.json.JSONObject;

public final class RolePlanCoordinator {
    private final AlExecutionDatabase database;
    private final RoomExecutionStore store;
    private final Context context;

    public RolePlanCoordinator(Context context) {
        this(AlExecutionDatabase.get(context), context.getApplicationContext());
    }

    RolePlanCoordinator(AlExecutionDatabase database) {
        this(database, null);
    }

    private RolePlanCoordinator(AlExecutionDatabase database, Context context) {
        this.database = database;
        this.store = new RoomExecutionStore(database);
        this.context = context;
    }

    public int dispatchDue(long now) {
        int queued = 0;
        List<RolePlanEntity> plans = database.executionDao().dueRolePlans(now, 50);
        for (RolePlanEntity plan : plans) {
            if (plan.nextRunAt != null
                && claimAndQueueUnderRoleGate(plan, plan.nextRunAt, cloudJobId(plan), now, false)) {
                queued += 1;
            }
        }
        return queued;
    }

    public boolean dispatch(String planId, long scheduledFor, String jobId, long now) {
        RolePlanEntity plan = database.executionDao().rolePlan(planId);
        if (plan == null || plan.nextRunAt == null || plan.nextRunAt.longValue() != scheduledFor) return false;
        return claimAndQueueUnderRoleGate(plan, scheduledFor, jobId, now, false);
    }

    public boolean dispatchCurrent(String planId, String jobId, long now) {
        RolePlanEntity plan = database.executionDao().rolePlan(planId);
        return plan != null && plan.nextRunAt != null
            && claimAndQueueUnderRoleGate(plan, plan.nextRunAt, jobId, now, false);
    }

    public boolean runNow(String planId, long now) {
        RolePlanEntity plan = database.executionDao().rolePlan(planId);
        return plan != null
            && claimAndQueueUnderRoleGate(plan, now, "manual_" + safe(planId) + "_" + now, now, true);
    }

    public void completeForTurn(String turnId, long now) {
        RolePlanOccurrenceEntity occurrence = database.executionDao().rolePlanOccurrenceByTurn(turnId);
        if (occurrence == null || "COMPLETED".equals(occurrence.state)) return;
        final Long[] nextAlarm = new Long[] { null };
        store.runRoleSideEffectIfNotDeleted(occurrence.characterId, () -> {
            database.runInTransaction(() -> {
                RolePlanEntity plan = database.executionDao().rolePlan(occurrence.planId);
                if (plan != null && store.isRoleDeleteTombstoned(plan.characterId)) return;
                if (plan != null
                    && "active".equals(plan.status)
                    && plan.nextRunAt != null
                    && plan.nextRunAt.longValue() == occurrence.scheduledFor) {
                    try {
                        RolePlanCompletion.Result advanced = RolePlanCompletion.advance(
                            new JSONObject(plan.planJson), occurrence.scheduledFor, now
                        );
                        plan.status = advanced.status;
                        plan.nextRunAt = advanced.nextRunAt;
                        plan.updatedAt = now;
                        plan.planJson = advanced.planJson.toString();
                        database.executionDao().upsertRolePlans(Collections.singletonList(plan));
                        updateSnapshotPlan(plan, advanced.planJson, now);
                        nextAlarm[0] = advanced.nextRunAt;
                    } catch (Exception error) {
                        throw new IllegalStateException("ROLE_PLAN_ADVANCE_FAILED", error);
                    }
                }
                database.executionDao().completeRolePlanOccurrence(occurrence.occurrenceId, now);
            });
            if (context != null && nextAlarm[0] != null) {
                RolePlanAlarmScheduler.schedule(context, occurrence.planId, nextAlarm[0]);
            }
        });
    }

    public int reconcileFailedTurns(long now) {
        int failed = 0;
        for (RolePlanOccurrenceEntity occurrence : database.executionDao().failedRolePlanOccurrences(50)) {
            final boolean[] reconciled = {false};
            boolean gateCompleted = store.runRoleSideEffectIfNotDeleted(
                occurrence.characterId,
                () -> {
                    database.runInTransaction(() -> {
                        RolePlanEntity plan = database.executionDao().rolePlan(occurrence.planId);
                        if (plan != null && store.isRoleDeleteTombstoned(plan.characterId)) return;
                        if (plan != null
                            && "active".equals(plan.status)
                            && plan.nextRunAt != null
                            && plan.nextRunAt.longValue() == occurrence.scheduledFor) {
                            try {
                                RolePlanCompletion.Result marked = RolePlanCompletion.fail(
                                    new JSONObject(plan.planJson), occurrence.scheduledFor, now, "TURN_FAILED_FINAL"
                                );
                                plan.status = marked.status;
                                plan.nextRunAt = marked.nextRunAt;
                                plan.updatedAt = now;
                                plan.planJson = marked.planJson.toString();
                                database.executionDao().upsertRolePlans(Collections.singletonList(plan));
                                updateSnapshotPlan(plan, marked.planJson, now);
                            } catch (Exception error) {
                                throw new IllegalStateException("ROLE_PLAN_FAILURE_RECONCILE_FAILED", error);
                            }
                        }
                        database.executionDao().failRolePlanOccurrence(
                            occurrence.occurrenceId, "TURN_FAILED_FINAL", now
                        );
                        reconciled[0] = true;
                    });
                }
            );
            if (gateCompleted && reconciled[0]) failed += 1;
        }
        return failed;
    }

    private void updateSnapshotPlan(RolePlanEntity plan, JSONObject planJson, long now) throws Exception {
        store.assertRoleAcceptsSemanticWrite(plan.characterId);
        String snapshotId = plan.characterId + ":role-plan:" + plan.planId;
        CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(snapshotId);
        if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) return;
        JSONObject contextJson = new JSONObject(snapshot.contextJson);
        contextJson.put("rolePlan", planJson);
        contextJson.put("scheduledFor", plan.nextRunAt == null ? JSONObject.NULL : plan.nextRunAt);
        contextJson.put("cloudJobId", "");
        snapshot.contextJson = contextJson.toString();
        snapshot.scheduledFor = plan.nextRunAt;
        snapshot.cloudJobId = "";
        snapshot.createdAt = now;
        database.executionDao().upsertSnapshot(snapshot);
    }

    private boolean claimAndQueue(RolePlanEntity plan, long scheduledFor, String jobId, long now, boolean force) {
        try {
            JSONObject planJson = new JSONObject(plan.planJson);
            store.assertRoleAcceptsSemanticWrite(plan.characterId);
            String type = planJson.optString("type", "");
            boolean runnableType = "private_message".equals(type) || "moment_post".equals(type);
            if (force ? (!"active".equals(plan.status) || !runnableType)
                : !RolePlanRecoveryPolicy.claimable(plan.status, type, scheduledFor, now)) return false;
            CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(plan.characterId + ":role-plan:" + plan.planId);
            if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) {
                store.recordRolePreflightDiagnosticIfActive(
                    "plan_" + safe(plan.planId), plan.characterId,
                    "WARN", "ROLE_PLAN_SNAPSHOT_MISSING", plan.planId, now);
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
            ChatTurnEntity turn = store.submitRolePlanOccurrence(occurrence, new TurnSubmission(
                turnId, plan.characterId, occurrenceId, kind, input.toString(), context.toString(), jobId, now
            ));
            return turn != null;
        } catch (Exception error) {
            // submitRolePlanOccurrence wraps every Room transaction failure.
            // The transaction has already rolled back its occurrence, turn,
            // attempt and claim diagnostic; writing a second ordinary
            // diagnostic here would create an orphan after a delete/fault race.
            if (error instanceof RoomExecutionStore.AtomicRolePlanSubmissionException) {
                return false;
            }
            if (store.isRoleDeleteTombstoned(plan.characterId)) return false;
            store.recordDiagnostic("plan_" + safe(plan.planId), null, "ERROR", "ROLE_PLAN_CLAIM_FAILED", error.getMessage(), now);
            return false;
        }
    }

    private boolean claimAndQueueUnderRoleGate(
        RolePlanEntity plan, long scheduledFor, String jobId, long now, boolean force
    ) {
        final boolean[] queued = {false};
        boolean gateCompleted = store.runRoleSideEffectIfNotDeleted(
            plan.characterId,
            () -> queued[0] = claimAndQueue(plan, scheduledFor, jobId, now, force)
        );
        return gateCompleted && queued[0];
    }

    private static String cloudJobId(RolePlanEntity plan) {
        try { return new JSONObject(plan.planJson).optString("cloudJobId", "").trim(); }
        catch (Exception ignored) { return ""; }
    }

    private static String safe(String value) {
        return String.valueOf(value == null ? "" : value).replaceAll("[^a-zA-Z0-9_-]", "_");
    }
}
