package com.siyi.al.execution;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.UrlConnectionTransport;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class AlExecutionService extends Service {
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private final ExecutionDrainGate drainGate = new ExecutionDrainGate();
    private ExecutorService executor;
    private ScheduledExecutorService recoveryScheduler;
    private ExecutionEngine engine;
    private AlExecutionDatabase database;
    private RoomExecutionStore executionStore;
    private AlNotificationFactory notifications;
    private PowerManager.WakeLock wakeLock;

    public static void requestRun(Context context) {
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, AlExecutionService.class));
        } catch (RuntimeException error) {
            if (isForegroundStartRestricted(error)) {
                AlExecutionWakeWorker.enqueue(app);
                return;
            }
            throw error;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = new AlNotificationFactory(this);
        notifications.ensureChannels();
        startForeground(AlNotificationFactory.GUARD_NOTIFICATION_ID, notifications.guardNotification());
        executor = Executors.newSingleThreadExecutor();
        engine = ExecutionRuntime.create(this);
        database = AlExecutionDatabase.get(this);
        executionStore = new RoomExecutionStore(database);
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AL:Execution");
        wakeLock.setReferenceCounted(false);
        recoveryScheduler = Executors.newSingleThreadScheduledExecutor();
        recoveryScheduler.scheduleWithFixedDelay(() -> {
            try {
                int imported = ExecutionRuntime.drainCloudInbox(this);
                if (imported > 0) {
                    executionStore.recordDiagnostic(
                        "cloud-inbox", null, "INFO", "CLOUD_INBOX_IMPORTED",
                        "count=" + imported, System.currentTimeMillis()
                    );
                }
                new RolePlanCoordinator(database).dispatchDue(System.currentTimeMillis());
                new AutomaticTaskCoordinator(database).dispatchDue(System.currentTimeMillis());
                kick();
            } catch (Exception error) {
                executionStore.recordDiagnostic("background-scan", null, "WARN", "BACKGROUND_SCAN_FAILED", error.getMessage(), System.currentTimeMillis());
            }
        }, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        kick();
        return ExecutionServicePolicy.restartAfterProcessReclaim() ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        AlExecutionWakeWorker.enqueue(this, 5);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        if (recoveryScheduler != null) recoveryScheduler.shutdownNow();
        drainGate.close();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void kick() {
        if (!drainGate.request()) return;
        executor.execute(() -> {
            acquireWakeLock();
            try {
                boolean continueDraining;
                do {
                    executionStore.recoverDueRetries(System.currentTimeMillis());
                    engine.recoverInterruptedWork();
                    while (!Thread.currentThread().isInterrupted() && engine.runNext()) {
                        // Drain the single Room-backed queue before checking for a concurrent wake.
                    }
                    notifyCompletedTurns();
                    RetryRecoveryResult retries = executionStore.recoverDueRetries(System.currentTimeMillis());
                    if (retries.nextDelaySeconds >= 0L) {
                        AlExecutionWakeWorker.enqueue(this, retries.nextDelaySeconds);
                    }
                    boolean wakeRequested = drainGate.finishCycle();
                    continueDraining = !Thread.currentThread().isInterrupted()
                        && (retries.restarted > 0 || wakeRequested);
                } while (continueDraining);
            } catch (RuntimeException error) {
                boolean restart = drainGate.abortCycle();
                if (restart && executor != null && !executor.isShutdown()) kick();
                throw error;
            } finally {
                if (wakeLock.isHeld()) wakeLock.release();
            }
        });
    }

    private void acquireWakeLock() {
        if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private void notifyCompletedTurns() {
        SharedPreferences notified = getSharedPreferences("al.execution.notifications", MODE_PRIVATE);
        SharedPreferences acknowledged = getSharedPreferences("al.execution.cloud-acks", MODE_PRIVATE);
        SharedPreferences continued = getSharedPreferences("al.execution.role-plan-continuations", MODE_PRIVATE);
        SharedPreferences proactiveContinued = getSharedPreferences("al.execution.proactive-continuations", MODE_PRIVATE);
        SharedPreferences bridgeReceipts = getSharedPreferences("al.execution.bridge-receipts", MODE_PRIVATE);
        RolePlanCoordinator rolePlanCoordinator = new RolePlanCoordinator(this);
        rolePlanCoordinator.reconcileFailedTurns(System.currentTimeMillis());
        for (ChatTurnEntity turn : database.executionDao().completedTurns()) {
            confirmBridgeDelivery(turn, bridgeReceipts);
            acknowledgeCloudTurn(turn, acknowledged);
            continueAutomaticTask(turn, proactiveContinued);
            continueRolePlan(turn, continued);
            rolePlanCoordinator.completeForTurn(turn.turnId, System.currentTimeMillis());
            String key = "turn." + turn.turnId;
            if (notified.getBoolean(key, false)) continue;
            String title = characterName(turn);
            String text = notificationText(turn);
            try {
                NotificationManagerCompat.from(this).notify(
                    AlNotificationFactory.messageNotificationId(turn.turnId),
                    notifications.messageNotification(title, text, turn.turnId.hashCode())
                );
                notified.edit().putBoolean(key, true).apply();
            } catch (SecurityException ignored) {
                // Android 13+ will deliver after the user grants notification permission.
            }
        }
    }

    private void confirmBridgeDelivery(ChatTurnEntity turn, SharedPreferences confirmed) {
        String key = "turn." + turn.turnId;
        if (confirmed.getBoolean(key, false)) return;
        try {
            com.siyi.al.execution.db.ExecutionAttemptEntity attempt = executionStore.activeAttempt(turn.turnId);
            if (attempt == null || attempt.memoryResult == null || attempt.memoryResult.trim().isEmpty()) return;
            JSONObject response = BridgeReceiptCheckpoint.extract(attempt.memoryResult);
            if (response == null) return;
            if (ExecutionRuntime.confirmCloudResult(this, response.toString())) {
                confirmed.edit().putBoolean(key, true).apply();
                executionStore.recordDiagnostic(
                    turn.turnId, turn.activeAttemptId, "INFO", "PHONE_RECEIPT_SENT",
                    response.optString("_relayMessageId", ""), System.currentTimeMillis()
                );
            }
        } catch (Exception error) {
            executionStore.recordDiagnostic(
                turn.turnId, turn.activeAttemptId, "WARN", "PHONE_RECEIPT_PENDING",
                error.getMessage(), System.currentTimeMillis()
            );
        }
    }

    private void acknowledgeCloudTurn(ChatTurnEntity turn, SharedPreferences acknowledged) {
        if (turn.cloudJobId == null || turn.cloudJobId.trim().isEmpty()) return;
        String key = "turn." + turn.turnId;
        if (acknowledged.getBoolean(key, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            if (endpoint.isEmpty() || deviceId.isEmpty()) return;
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            body.put("jobId", turn.cloudJobId);
            body.put("charId", turn.characterId);
            boolean moment = TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind)
                || TurnKind.ROLE_PLAN_MOMENT.name().equals(turn.kind)
                || TurnKind.ROLE_PLAN_MOMENT_PRIVATE.name().equals(turn.kind);
            body.put("kind", moment ? "moment" : "chat");
            body.put("outcome", "generated-native");
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/ack",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                body.toString()
            );
            if (response.status >= 200 && response.status < 300) {
                acknowledged.edit().putBoolean(key, true).apply();
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "ACK_OK", "status=" + response.status, System.currentTimeMillis());
            } else {
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ACK_FAILED", "status=" + response.status, System.currentTimeMillis());
            }
        } catch (Exception error) {
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ACK_FAILED", error.getMessage(), System.currentTimeMillis());
            // Keep the ack pending. The sticky service retries it on the next kick.
        }
    }

    private void continueRolePlan(ChatTurnEntity turn, SharedPreferences continued) {
        if (!isRolePlanKind(turn.kind) || turn.cloudJobId == null || turn.cloudJobId.trim().isEmpty()) return;
        String continuationKey = "turn." + turn.turnId;
        if (continued.getBoolean(continuationKey, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            JSONObject plan = snapshot.optJSONObject("rolePlan");
            JSONObject schedule = plan == null ? null : plan.optJSONObject("schedule");
            String planId = plan == null ? "" : plan.optString("planId", "").trim();
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            if (plan == null || schedule == null || planId.isEmpty() || endpoint.isEmpty() || deviceId.isEmpty()) return;

            long after = Math.max(System.currentTimeMillis(), plan.optLong("nextRunAt", System.currentTimeMillis()));
            Long nextRunAt = RolePlanSchedule.nextOccurrence(schedule, after);
            long now = System.currentTimeMillis();
            if (nextRunAt == null) {
                plan.put("status", "completed");
                plan.put("completedAt", now);
                plan.put("lastRunAt", now);
                plan.put("cloudJobId", JSONObject.NULL);
                persistRolePlanContinuation(turn, snapshot, plan, null, now);
                continued.edit().putBoolean(continuationKey, true).apply();
                return;
            }

            String safeDeviceId = safeId(deviceId);
            String safePlanId = safeId(planId);
            String jobId = "rpl_" + safeDeviceId + "_" + safePlanId + "_" + nextRunAt;
            JSONObject body = new JSONObject();
            body.put("deviceId", safeDeviceId);
            body.put("jobId", jobId);
            body.put("planId", planId);
            body.put("occurrenceId", planId + ":" + nextRunAt);
            body.put("charId", turn.characterId);
            body.put("dueAt", isoTime(nextRunAt));
            body.put("type", "role-plan");
            body.put("kind", plan.optString("type", "private_message"));
            body.put("source", plan.optString("source", "spoken"));
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/schedule",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                body.toString()
            );
            if (response.status < 200 || response.status >= 300) {
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ROLE_PLAN_RESCHEDULE_FAILED", "status=" + response.status, now);
                return;
            }
            plan.put("status", "active");
            plan.put("nextRunAt", nextRunAt);
            plan.put("lastRunAt", now);
            plan.put("cloudJobId", jobId);
            plan.put("updatedAt", now);
            persistRolePlanContinuation(turn, snapshot, plan, jobId, now);
            continued.edit().putBoolean(continuationKey, true).apply();
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "ROLE_PLAN_RESCHEDULED", jobId, now);
        } catch (Exception error) {
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ROLE_PLAN_RESCHEDULE_FAILED", error.getMessage(), System.currentTimeMillis());
        }
    }

    private void continueAutomaticTask(ChatTurnEntity turn, SharedPreferences continued) {
        boolean moment = TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind);
        if (!moment && !TurnKind.PROACTIVE_CHAT.name().equals(turn.kind)) return;
        String continuationKey = "turn." + turn.turnId;
        if (continued.getBoolean(continuationKey, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            if (!snapshot.optBoolean("automaticTasksEnabled", false)) return;
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            JSONObject previousJob = snapshot.optJSONObject("proactiveJob");
            String kind = moment ? "moment" : "chat";
            if (endpoint.isEmpty() || deviceId.isEmpty() || previousJob == null) return;

            long now = System.currentTimeMillis();
            long nextRunAt = 0L;
            for (ReplyPartEntity part : database.executionDao().replyParts(turn.turnId)) {
                if (!"SCHEDULE".equals(part.type) || part.payloadJson == null) continue;
                String value = new JSONObject(part.payloadJson).optString("nextProactiveAt", "");
                long parsed = parseIso(value);
                if (parsed > now) { nextRunAt = parsed; break; }
            }
            boolean hasExplicitSchedule = nextRunAt > now;
            boolean dice = AutomaticTaskContinuationPolicy.useDiceContinuation(previousJob.optString("mode", "planned"), hasExplicitSchedule);
            JSONObject dicePolicy = "dice".equals(previousJob.optString("mode", ""))
                ? previousJob
                : snapshot.optJSONObject("continuationDice");
            if (nextRunAt <= now && dice) {
                if (dicePolicy == null) dicePolicy = new JSONObject();
                long interval = dicePolicy.optLong("intervalMs", dicePolicy.optLong("diceIntervalMs", 60_000L));
                double chance = dicePolicy.optDouble("rollChance", 0.5d);
                int maxRolls = dicePolicy.optInt("maxRolls", 120);
                nextRunAt = now + AutomaticTaskContinuationPolicy.delayMs(interval, chance, maxRolls, Math.random());
            }
            if (nextRunAt <= now) {
                continued.edit().putBoolean(continuationKey, true).apply();
                return;
            }

            String prefix = moment ? "mom" : "pro";
            String jobId = prefix + "_" + safeId(deviceId) + "_" + safeId(turn.characterId) + "_native_" + Long.toString(now, 36);
            JSONObject nextJob = new JSONObject();
            nextJob.put("deviceId", deviceId);
            nextJob.put("jobId", jobId);
            nextJob.put("charId", turn.characterId);
            nextJob.put("dueAt", isoTime(nextRunAt));
            nextJob.put("type", "proactive");
            nextJob.put("kind", kind);
            nextJob.put("mode", dice ? "dice" : "planned");
            if (dice) {
                if (dicePolicy == null) dicePolicy = new JSONObject();
                nextJob.put("rollChance", dicePolicy.optDouble("rollChance", 0.5d));
                nextJob.put("diceIntervalMs", dicePolicy.optLong("intervalMs", dicePolicy.optLong("diceIntervalMs", 60_000L)));
                nextJob.put("maxRolls", dicePolicy.optInt("maxRolls", 120));
                nextJob.put("dicePrecomputed", true);
            }
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/schedule",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                nextJob.toString()
            );
            if (response.status < 200 || response.status >= 300) {
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "PROACTIVE_RESCHEDULE_FAILED", "status=" + response.status, now);
                return;
            }
            snapshot.put("cloudJobId", jobId);
            snapshot.put("scheduledFor", nextRunAt);
            snapshot.put("proactiveJob", nextJob);
            snapshot.put("createdAt", isoTime(now));
            persistAutomaticSnapshot(turn, snapshot, kind, jobId, nextRunAt, now);
            AutomaticTaskAlarmScheduler.schedule(this, jobId, nextRunAt);
            continued.edit().putBoolean(continuationKey, true).apply();
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "PROACTIVE_RESCHEDULED", jobId, now);
        } catch (Exception error) {
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "PROACTIVE_RESCHEDULE_FAILED", error.getMessage(), System.currentTimeMillis());
        }
    }

    private void persistAutomaticSnapshot(ChatTurnEntity turn, JSONObject context, String kind, String jobId, long scheduledFor, long now) throws Exception {
        CharacterSnapshotEntity row = new CharacterSnapshotEntity();
        row.characterId = turn.characterId;
        row.characterName = context.optString("characterName", "AL");
        row.playerName = context.optString("playerName", "我");
        row.systemPrompt = context.optString("chatSystem", "");
        row.momentSystemPrompt = "moment".equals(kind) ? context.optString("chatSystem", "") : "";
        row.contextJson = context.toString();
        row.chatConfigId = context.optString("chatConfigId", "chat-v1");
        row.memoryConfigId = context.optString("memoryConfigId", "memory-v1");
        row.createdAt = now;
        row.scheduledFor = scheduledFor;
        row.automaticKind = kind;
        row.cloudJobId = jobId;
        row.automaticTasksEnabled = true;
        row.jobSnapshot = false;
        row.snapshotId = turn.characterId + ":" + kind;
        database.executionDao().upsertSnapshot(row);
        CharacterSnapshotEntity jobRow = new CharacterSnapshotEntity();
        jobRow.snapshotId = row.snapshotId + ":" + jobId;
        jobRow.characterId = row.characterId;
        jobRow.characterName = row.characterName;
        jobRow.playerName = row.playerName;
        jobRow.systemPrompt = row.systemPrompt;
        jobRow.momentSystemPrompt = row.momentSystemPrompt;
        jobRow.contextJson = row.contextJson;
        jobRow.chatConfigId = row.chatConfigId;
        jobRow.memoryConfigId = row.memoryConfigId;
        jobRow.createdAt = row.createdAt;
        jobRow.scheduledFor = row.scheduledFor;
        jobRow.automaticKind = row.automaticKind;
        jobRow.cloudJobId = row.cloudJobId;
        jobRow.automaticTasksEnabled = true;
        jobRow.jobSnapshot = true;
        database.executionDao().upsertSnapshot(jobRow);
    }

    private static long parseIso(String value) {
        if (value == null || value.trim().isEmpty()) return 0L;
        try {
            java.text.SimpleDateFormat formatter = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", java.util.Locale.US);
            return formatter.parse(value.trim()).getTime();
        } catch (Exception ignored) { return 0L; }
    }

    private void persistRolePlanContinuation(ChatTurnEntity turn, JSONObject snapshot, JSONObject plan, String jobId, long now) throws Exception {
        RolePlanEntity row = new RolePlanEntity();
        row.planId = plan.getString("planId");
        row.characterId = turn.characterId;
        row.status = plan.optString("status", "active");
        row.nextRunAt = plan.has("nextRunAt") && !plan.isNull("nextRunAt") ? plan.optLong("nextRunAt") : null;
        row.updatedAt = now;
        row.planJson = plan.toString();
        database.executionDao().upsertRolePlans(Collections.singletonList(row));
        if (row.nextRunAt != null) RolePlanAlarmScheduler.schedule(this, row.planId, row.nextRunAt);

        snapshot.put("rolePlan", plan);
        snapshot.put("cloudJobId", jobId == null ? "" : jobId);
        String snapshotId = turn.characterId + ":role-plan:" + row.planId;
        CharacterSnapshotEntity stable = database.executionDao().latestSnapshot(snapshotId);
        if (stable != null) {
            stable.contextJson = snapshot.toString();
            stable.createdAt = now;
            database.executionDao().upsertSnapshot(stable);
        }
    }

    private static boolean isRolePlanKind(String kind) {
        return TurnKind.ROLE_PLAN_CHAT.name().equals(kind)
            || TurnKind.ROLE_PLAN_MOMENT.name().equals(kind)
            || TurnKind.ROLE_PLAN_CHAT_PRIVATE.name().equals(kind)
            || TurnKind.ROLE_PLAN_MOMENT_PRIVATE.name().equals(kind);
    }

    private static String safeId(String value) {
        return value == null ? "" : value.trim().replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    private static String isoTime(long value) {
        java.text.SimpleDateFormat formatter = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        formatter.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return formatter.format(new java.util.Date(value));
    }

    private String notificationText(ChatTurnEntity turn) {
        return AlNotificationText.fromParts(database.executionDao().replyParts(turn.turnId));
    }

    private static String characterName(ChatTurnEntity turn) {
        try {
            String value = new JSONObject(turn.snapshotJson).optString("characterName", "").trim();
            if (!value.isEmpty()) return value;
        } catch (Exception ignored) {}
        return "AL";
    }

    private static boolean isForegroundStartRestricted(RuntimeException error) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && isForegroundStartRestrictedApi31(error);
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static boolean isForegroundStartRestrictedApi31(RuntimeException error) {
        return error instanceof ForegroundServiceStartNotAllowedException;
    }
}
