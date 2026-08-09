package com.siyi.al.execution;

import android.content.Context;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import org.json.JSONObject;

public final class AutomaticTaskCoordinator {
    private final AlExecutionDatabase database;
    private final RoomExecutionStore store;
    public AutomaticTaskCoordinator(Context context) { this(AlExecutionDatabase.get(context)); }
    AutomaticTaskCoordinator(AlExecutionDatabase database) {
        this.database = database;
        this.store = new RoomExecutionStore(database);
    }

    public int dispatchDue(long now) {
        int queued = 0;
        for (CharacterSnapshotEntity candidate : database.executionDao().dueAutomaticSnapshots(now, 50)) {
            final boolean[] dispatched = {false};
            boolean gateCompleted;
            try {
                gateCompleted = store.runRoleSideEffectIfNotDeleted(
                    candidate.characterId,
                    () -> dispatched[0] = dispatchCandidate(candidate, now)
                );
            } catch (Exception error) {
                if (store.isRoleDeleteTombstoned(candidate.characterId)) continue;
                store.recordDiagnostic(
                    "automatic-recovery", null, "WARN", "LOCAL_AUTOMATIC_RECOVERY_FAILED",
                    error.getMessage(), now);
                continue;
            }
            if (gateCompleted && dispatched[0]) queued += 1;
        }
        return queued;
    }

    private boolean dispatchCandidate(CharacterSnapshotEntity candidate, long now) {
        RoleDeletionDispatchPolicy.TombstoneReader tombstone = store::isRoleDeleteTombstoned;
        try {
                String kindName = "moment".equals(candidate.automaticKind) ? "moment" : "chat";
                if (RoleDeletionDispatchPolicy.blocked(tombstone, candidate.characterId)) return false;
                CharacterSnapshotEntity stable = database.executionDao().latestSnapshot(candidate.characterId + ":" + kindName);
                String stableJobId = stable == null || stable.cloudJobId == null ? "" : stable.cloudJobId;
                if (!AutomaticTaskRecoveryPolicy.claimable(candidate.automaticTasksEnabled, candidate.cloudJobId, stableJobId, candidate.scheduledFor, now)) return false;
                String safeJobId = candidate.cloudJobId.replaceAll("[^a-zA-Z0-9_-]", "_");
                String turnId = "cloud_" + safeJobId;
                if (database.executionDao().turn(turnId) != null) return false;
                JSONObject context = new JSONObject(candidate.contextJson);
                context.put("scheduledFor", candidate.scheduledFor);
                context.put("executedAt", now);
                context.put("delayMs", Math.max(0L, now - candidate.scheduledFor));
                TurnKind kind = "moment".equals(kindName) ? TurnKind.PROACTIVE_MOMENT : TurnKind.PROACTIVE_CHAT;
                try {
                    store.submitTurn(new TurnSubmission(
                        turnId, candidate.characterId, turnId, kind, "{}", context.toString(), candidate.cloudJobId, now
                    ));
                } catch (RuntimeException error) {
                    if (RoleDeletionDispatchPolicy.suppressFailure(tombstone, candidate.characterId)) return false;
                    throw error;
                }
                if (RoleDeletionDispatchPolicy.blocked(tombstone, candidate.characterId)) return false;
                store.recordDiagnostic(turnId, null, "INFO", "LOCAL_AUTOMATIC_RECOVERY", RolePlanRecoveryPolicy.timingContext(candidate.scheduledFor, now), now);
                return true;
            } catch (Exception error) {
                if (RoleDeletionDispatchPolicy.suppressFailure(tombstone, candidate.characterId)) return false;
                store.recordDiagnostic("automatic-recovery", null, "WARN", "LOCAL_AUTOMATIC_RECOVERY_FAILED", error.getMessage(), now);
                return false;
            }
    }
}
