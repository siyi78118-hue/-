package com.siyi.al;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.AlExecutionWakeWorker;
import com.siyi.al.execution.AlNotificationFactory;
import com.siyi.al.execution.RolePlanCoordinator;
import com.siyi.al.execution.RolePlanOccurrenceKey;
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
        String safeJobId = jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
        String turnId = "cloud_" + safeJobId;
        long now = System.currentTimeMillis();
        store.recordDiagnostic(turnId, null, "INFO", "FCM_RECEIVED", kindName + ":" + jobId, now);
        store.recordDiagnostic(turnId, null, "INFO", "FCM_PRIORITY", priorityDetail(remoteMessage), now);
        CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(snapshotId(characterId, kindName, jobId));
        if (snapshot == null) {
            snapshot = database.executionDao().latestSnapshot(characterId + ":" + kindName);
        }
        if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) {
            store.recordDiagnostic(turnId, null, "WARN", "SNAPSHOT_MISSING", kindName + ":" + jobId, now);
            return;
        }
        if (!snapshotAllowsAutomaticTask(snapshot, jobId)) {
            store.recordDiagnostic(turnId, null, "WARN", "JOB_MISMATCH", kindName + ":" + jobId, now);
            return;
        }

        TurnKind kind = "moment".equals(kindName) ? TurnKind.PROACTIVE_MOMENT : TurnKind.PROACTIVE_CHAT;
        store.submitTurn(new TurnSubmission(
            turnId,
            characterId,
            turnId,
            kind,
            "{}",
            snapshot.contextJson,
            jobId,
            now
        ));
        showPending(turnId, snapshot.characterName);
        AlExecutionWakeWorker.enqueue(this);
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
        String turnId = "cloud_" + jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
        long now = System.currentTimeMillis();
        store.recordDiagnostic(turnId, null, "INFO", "ROLE_PLAN_FCM", planId + ":" + occurrenceId, now);
        store.recordDiagnostic(turnId, null, "INFO", "FCM_PRIORITY", priorityDetail(remoteMessage), now);
        CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(rolePlanSnapshotId(characterId, planId));
        if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) {
            store.recordDiagnostic(turnId, null, "WARN", "ROLE_PLAN_SNAPSHOT_MISSING", planId, now);
            return;
        }
        if (!matchesSnapshotJob(snapshot, jobId)) {
            store.recordDiagnostic(turnId, null, "WARN", "ROLE_PLAN_JOB_MISMATCH", planId + ":" + jobId, now);
            return;
        }
        try {
            JSONObject context = new JSONObject(snapshot.contextJson);
            if (!planId.equals(text(context.optString("rolePlanId", "")))) return;
        } catch (Exception ignored) {
            return;
        }
        if (!new RolePlanCoordinator(this).dispatchCurrent(planId, jobId, now)) return;
        String occurrenceTurnId = "plan_" + occurrenceId.replaceAll("[^a-zA-Z0-9_-]", "_");
        showPending(occurrenceTurnId, snapshot.characterName);
        AlExecutionWakeWorker.enqueue(this);
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

    private void showPending(String turnId, String title) {
        try {
            AlNotificationFactory factory = new AlNotificationFactory(this);
            factory.ensureChannels();
            NotificationManagerCompat.from(this).notify(
                AlNotificationFactory.messageNotificationId(turnId),
                factory.pendingMessageNotification(title, turnId.hashCode())
            );
        } catch (SecurityException ignored) {
            // Notification permission may be disabled; execution still continues.
        }
    }
}
