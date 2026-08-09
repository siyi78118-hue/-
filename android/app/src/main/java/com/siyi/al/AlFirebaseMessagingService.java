package com.siyi.al;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.AlExecutionWakeWorker;
import com.siyi.al.execution.AlNotificationFactory;
import com.siyi.al.execution.RolePlanCoordinator;
import com.siyi.al.execution.RolePlanOccurrenceKey;
import com.siyi.al.execution.RoleDeletionDispatchPolicy;
import androidx.core.app.NotificationManagerCompat;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import java.util.Map;
import org.json.JSONObject;

public class AlFirebaseMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("role-plan".equals(data.get("type"))) {
            handleRolePlan(data, remoteMessage);
            return;
        }
        if (!"proactive".equals(data.get("type"))) {
            super.onMessageReceived(remoteMessage);
            return;
        }
        String characterId = text(data.get("charId"));
        String jobId = text(data.get("jobId"));
        String kindName = "moment".equals(data.get("kind")) ? "moment" : "chat";
        if (characterId.isEmpty() || jobId.isEmpty()) return;

        AlExecutionDatabase database = AlExecutionDatabase.get(this);
        RoomExecutionStore store = new RoomExecutionStore(database);
        RoleDeletionDispatchPolicy.TombstoneReader tombstone = store::isRoleDeleteTombstoned;
        if (RoleDeletionDispatchPolicy.blocked(tombstone, characterId)) return;
        String safeJobId = jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
        String turnId = "cloud_" + safeJobId;
        long now = System.currentTimeMillis();
        TurnKind kind = "moment".equals(kindName) ? TurnKind.PROACTIVE_MOMENT : TurnKind.PROACTIVE_CHAT;
        CharacterSnapshotEntity[] snapshotHolder = new CharacterSnapshotEntity[1];
        boolean[] submitted = new boolean[1];
        try {
            boolean accepted = store.runRoleSideEffectIfNotDeleted(characterId, () -> {
                CharacterSnapshotEntity candidate =
                    database.executionDao().latestSnapshot(snapshotId(characterId, kindName, jobId));
                if (candidate == null) {
                    candidate = database.executionDao().latestSnapshot(characterId + ":" + kindName);
                }
                snapshotHolder[0] = candidate;
                if (candidate == null || candidate.contextJson == null
                    || candidate.contextJson.trim().isEmpty()) {
                    store.recordRolePreflightDiagnosticIfActive(
                        turnId, characterId, "WARN", "SNAPSHOT_MISSING", kindName + ":" + jobId, now);
                    return;
                }
                if (!snapshotAllowsAutomaticTask(candidate, jobId)) {
                    store.recordRolePreflightDiagnosticIfActive(
                        turnId, characterId, "WARN", "JOB_MISMATCH", kindName + ":" + jobId, now);
                    return;
                }
                store.submitTurn(new TurnSubmission(
                    turnId, characterId, turnId, kind, "{}", candidate.contextJson, jobId, now));
                store.recordRoleDispatchDiagnosticsIfActive(
                    turnId, characterId, null, now,
                    "FCM_RECEIVED", kindName + ":" + jobId,
                    "FCM_PRIORITY", priorityDetail(remoteMessage));
                submitted[0] = true;
            });
            if (!accepted || !submitted[0] || snapshotHolder[0] == null) return;
        } catch (RuntimeException error) {
            if (RoleDeletionDispatchPolicy.suppressFailure(tombstone, characterId)) return;
            throw error;
        }
        final int[] notificationId = {-1};
        boolean notificationStage = store.runRoleSideEffectIfNotDeleted(characterId, () -> {
            notificationId[0] = showPending(turnId, snapshotHolder[0].characterName);
            RoleDeletionDispatchPolicy.cancelPostedNotificationIfDeleted(
                tombstone, characterId, notificationId[0],
                id -> NotificationManagerCompat.from(this).cancel(id));
        });
        if (!notificationStage) {
            if (notificationId[0] >= 0) NotificationManagerCompat.from(this).cancel(notificationId[0]);
            return;
        }
        if (!store.runRoleSideEffectIfNotDeleted(characterId, () ->
            AlExecutionWakeWorker.enqueue(this))) {
            if (notificationId[0] >= 0) NotificationManagerCompat.from(this).cancel(notificationId[0]);
        }
    }

    private void handleRolePlan(Map<String, String> data, RemoteMessage remoteMessage) {
        String characterId = text(data.get("charId"));
        String planId = text(data.get("planId"));
        String occurrenceId = text(data.get("occurrenceId"));
        String jobId = text(data.get("jobId"));
        String kindName = text(data.get("kind"));
        if (characterId.isEmpty() || planId.isEmpty() || occurrenceId.isEmpty() || jobId.isEmpty()) return;
        if ("role_schedule".equals(kindName)) return;

        AlExecutionDatabase database = AlExecutionDatabase.get(this);
        RoomExecutionStore store = new RoomExecutionStore(database);
        RoleDeletionDispatchPolicy.TombstoneReader tombstone = store::isRoleDeleteTombstoned;
        if (RoleDeletionDispatchPolicy.blocked(tombstone, characterId)) return;
        String turnId = "cloud_" + jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
        long now = System.currentTimeMillis();
        CharacterSnapshotEntity[] snapshotHolder = new CharacterSnapshotEntity[1];
        boolean[] dispatched = new boolean[1];
        String occurrenceTurnId = "plan_" + occurrenceId.replaceAll("[^a-zA-Z0-9_-]", "_");
        boolean dispatchStage = store.runRoleSideEffectIfNotDeleted(characterId, () -> {
            CharacterSnapshotEntity candidate =
                database.executionDao().latestSnapshot(rolePlanSnapshotId(characterId, planId));
            snapshotHolder[0] = candidate;
            if (candidate == null || candidate.contextJson == null
                || candidate.contextJson.trim().isEmpty()) {
                store.recordRolePreflightDiagnosticIfActive(
                    turnId, characterId, "WARN", "ROLE_PLAN_SNAPSHOT_MISSING", planId, now);
                return;
            }
            if (!matchesSnapshotJob(candidate, jobId)) {
                store.recordRolePreflightDiagnosticIfActive(
                    turnId, characterId, "WARN", "ROLE_PLAN_JOB_MISMATCH", planId + ":" + jobId, now);
                return;
            }
            try {
                JSONObject context = new JSONObject(candidate.contextJson);
                if (!planId.equals(text(context.optString("rolePlanId", "")))) return;
            } catch (Exception ignored) {
                return;
            }
            if (!new RolePlanCoordinator(this).dispatchCurrent(planId, jobId, now)) return;
            String attemptId = null;
            com.siyi.al.execution.db.ExecutionAttemptEntity activeAttempt =
                store.activeAttempt(occurrenceTurnId);
            if (activeAttempt != null) attemptId = activeAttempt.attemptId;
            store.recordRoleDispatchDiagnosticsIfActive(
                occurrenceTurnId, characterId, attemptId, now,
                "ROLE_PLAN_FCM", planId + ":" + occurrenceId,
                "FCM_PRIORITY", priorityDetail(remoteMessage));
            dispatched[0] = true;
        });
        if (!dispatchStage || !dispatched[0] || snapshotHolder[0] == null) return;
        final int[] notificationId = {-1};
        boolean notificationStage = store.runRoleSideEffectIfNotDeleted(characterId, () -> {
            notificationId[0] = showPending(occurrenceTurnId, snapshotHolder[0].characterName);
            RoleDeletionDispatchPolicy.cancelPostedNotificationIfDeleted(
                tombstone, characterId, notificationId[0],
                id -> NotificationManagerCompat.from(this).cancel(id));
        });
        if (!notificationStage) {
            if (notificationId[0] >= 0) NotificationManagerCompat.from(this).cancel(notificationId[0]);
            return;
        }
        if (!store.runRoleSideEffectIfNotDeleted(characterId, () ->
            AlExecutionWakeWorker.enqueue(this))) {
            if (notificationId[0] >= 0) NotificationManagerCompat.from(this).cancel(notificationId[0]);
        }
    }

    static String rolePlanSnapshotId(String characterId, String planId) {
        return text(characterId) + ":role-plan:" + text(planId);
    }

    static String snapshotId(String characterId, String kindName, String jobId) {
        return text(characterId) + ":" + text(kindName) + ":" + text(jobId);
    }

    static boolean matchesSnapshotJob(CharacterSnapshotEntity snapshot, String jobId) {
        String incoming = text(jobId);
        if (snapshot == null || incoming.isEmpty()) return false;
        try {
            String current = text(new JSONObject(snapshot.contextJson).optString("cloudJobId", ""));
            return !current.isEmpty() && current.equals(incoming);
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean snapshotAllowsAutomaticTask(CharacterSnapshotEntity snapshot, String jobId) {
        if (!matchesSnapshotJob(snapshot, jobId)) return false;
        try {
            return new JSONObject(snapshot.contextJson).optBoolean("automaticTasksEnabled", true);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String text(String value) {
        return value == null ? "" : value.trim();
    }

    private static String priorityDetail(RemoteMessage message) {
        return "original=" + message.getOriginalPriority() + ";delivered=" + message.getPriority();
    }

    private int showPending(String turnId, String title) {
        int notificationId = AlNotificationFactory.messageNotificationId(turnId);
        try {
            AlNotificationFactory factory = new AlNotificationFactory(this);
            factory.ensureChannels();
            NotificationManagerCompat.from(this).notify(
                notificationId,
                factory.pendingMessageNotification(title, turnId.hashCode())
            );
            return notificationId;
        } catch (SecurityException ignored) {
            // Notification permission may be disabled; execution still continues.
            return -1;
        }
    }
}
