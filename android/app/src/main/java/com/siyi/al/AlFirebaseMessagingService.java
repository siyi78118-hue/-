package com.siyi.al;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.AlExecutionWakeWorker;
import com.siyi.al.execution.AlNotificationFactory;
import com.siyi.al.execution.AutomaticTaskCoordinator;
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
        if (isManualCloudTimerTest(data)) {
            super.onMessageReceived(remoteMessage);
            showManualCloudTimerTest(data);
            return;
        }
        AutomaticTaskCoordinator.ClaimToken token;
        try {
            token = automaticClaimToken(data);
        } catch (IllegalArgumentException ignored) {
            return;
        }
        String characterId = token.characterId;
        AlExecutionDatabase database = AlExecutionDatabase.get(this);
        RoomExecutionStore store = new RoomExecutionStore(database);
        RoleDeletionDispatchPolicy.TombstoneReader tombstone = store::isRoleDeleteTombstoned;
        if (RoleDeletionDispatchPolicy.blocked(tombstone, characterId)) return;
        long now = System.currentTimeMillis();
        AutomaticTaskCoordinator.DispatchOutcome outcome;
        try {
            outcome = new AutomaticTaskCoordinator(this).dispatch(token, now);
            if (outcome != AutomaticTaskCoordinator.DispatchOutcome.CLAIMED) return;
        } catch (RuntimeException error) {
            if (RoleDeletionDispatchPolicy.suppressFailure(tombstone, characterId)) return;
            throw error;
        }
        CharacterSnapshotEntity snapshot =
            database.executionDao().latestSnapshot(characterId + ":" + token.kind);
        String characterName = snapshot == null ? characterId : snapshot.characterName;
        String turnId = RoomExecutionStore.automaticTurnId(token.jobId);
        final int[] notificationId = {-1};
        boolean notificationStage = store.runRoleSideEffectIfNotDeleted(characterId, () -> {
            notificationId[0] = showPending(turnId, characterName);
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

    static AutomaticTaskCoordinator.ClaimToken automaticClaimToken(Map<String, String> data) {
        java.util.HashMap<String, String> token = new java.util.HashMap<>();
        token.put("charId", data == null ? null : data.get("charId"));
        token.put("kind", data == null ? null : data.get("kind"));
        token.put("jobId", data == null ? null : data.get("jobId"));
        token.put("authorityEpoch", data == null ? null : data.get("authorityEpoch"));
        token.put("generation", data == null ? null : data.get("generation"));
        return AutomaticTaskCoordinator.ClaimToken.from(token);
    }

    static boolean isManualCloudTimerTest(Map<String, String> data) {
        return data != null && "proactive".equals(data.get("type"))
            && "true".equals(data.get("test"));
    }

    private void showManualCloudTimerTest(Map<String, String> data) {
        String jobId = text(data == null ? null : data.get("jobId"));
        int notificationId = AlNotificationFactory.messageNotificationId(
            jobId.isEmpty() ? "cloud-timer-test" : jobId);
        try {
            AlNotificationFactory factory = new AlNotificationFactory(this);
            factory.ensureChannels();
            NotificationManagerCompat.from(this).notify(
                notificationId,
                factory.messageNotification("AL 云闹钟测试", "测试推送已送达；正式主动消息时间未改变。", notificationId)
            );
        } catch (RuntimeException ignored) {
            // Notification permission can be disabled; the Capacitor foreground event still proves delivery.
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
