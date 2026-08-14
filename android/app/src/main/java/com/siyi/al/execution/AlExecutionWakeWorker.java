package com.siyi.al.execution;

import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Operation;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Data;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.HashMap;

public final class AlExecutionWakeWorker extends Worker {
    private static final String WORK_NAME = "al-execution-wake";
    private static final String LIFECYCLE_WORK_NAME = "al-execution-lifecycle-wake";
    private static final String LIFECYCLE_PREARM_WORK_NAME = "al-execution-lifecycle-prearm";
    private static final String AUTOMATIC_SCHEDULE_SYNC_WORK_NAME = "al-execution-automatic-schedule-sync";

    public AlExecutionWakeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            String planId = getInputData().getString("planId");
            long scheduledFor = getInputData().getLong("scheduledFor", 0L);
            RolePlanCoordinator coordinator = new RolePlanCoordinator(getApplicationContext());
            if (planId != null && !planId.trim().isEmpty() && scheduledFor > 0L) {
                coordinator.dispatch(planId, scheduledFor, "local:" + RolePlanOccurrenceKey.of(planId, scheduledFor), System.currentTimeMillis());
            } else if (getInputData().getString("automaticJobId") != null) {
                AutomaticTaskCoordinator.ClaimToken token = automaticClaimToken(getInputData());
                if (token == null) return Result.success();
                long automaticScheduledFor =
                    getInputData().getLong("automaticScheduledFor", 0L);
                new AutomaticTaskCoordinator(getApplicationContext())
                    .dispatch(token, Math.max(System.currentTimeMillis(), automaticScheduledFor));
            } else {
                coordinator.dispatchDue(System.currentTimeMillis());
                new AutomaticTaskCoordinator(getApplicationContext()).dispatchDue(System.currentTimeMillis());
            }
            try {
                while (ExecutionRuntime.drainLifecycleControl(getApplicationContext())) {
                    // Drain independent conversation-clear controls before waking turn execution.
                }
            } catch (Exception ignored) {
                // The durable row remains pending for the next lease window; service retry is still scheduled.
            } finally {
                try {
                    long lifecycleDelay = ExecutionRuntime.nextLifecycleDelay(getApplicationContext());
                    if (lifecycleDelay >= 0L) enqueueLifecycle(getApplicationContext(), lifecycleDelay);
                } catch (RuntimeException ignored) {
                    // WorkManager will retry the wake worker; the Room row remains authoritative.
                }
            }
            try {
                ExecutionRuntime.drainAutomaticScheduleOutbox(getApplicationContext());
            } finally {
                long automaticDelay = ExecutionRuntime.nextAutomaticScheduleDelay(getApplicationContext());
                if (automaticDelay >= 0L) enqueueAutomaticScheduleSync(getApplicationContext(), automaticDelay);
            }
            ContextCompat.startForegroundService(
                getApplicationContext(),
                new Intent(getApplicationContext(), AlExecutionService.class)
            );
            return Result.success();
        } catch (RuntimeException error) {
            return Result.retry();
        }
    }

    public static void enqueue(Context context) {
        enqueue(context, 0);
    }

    static String lifecycleWorkName() { return LIFECYCLE_WORK_NAME; }
    static String generalWorkName() { return WORK_NAME; }
    static String lifecyclePrearmWorkName() { return LIFECYCLE_PREARM_WORK_NAME; }
    static String automaticScheduleSyncWorkName() { return AUTOMATIC_SCHEDULE_SYNC_WORK_NAME; }

    public static void enqueue(Context context, long delaySeconds) {
        enqueue(context, delaySeconds, null);
    }

    public static void enqueuePlan(Context context, String planId, long scheduledFor) {
        Data input = new Data.Builder().putString("planId", planId).putLong("scheduledFor", scheduledFor).build();
        enqueue(context, 0, input);
    }

    public static void enqueueAutomatic(Context context, String jobId, long scheduledFor) {
        // Snapshot-only work is intentionally not scheduled; authority token required.
    }

    public static void enqueueAutomatic(
        Context context, AutomaticTaskCoordinator.ClaimToken token, long scheduledFor
    ) {
        if (token == null || scheduledFor <= 0L) return;
        long remainingMs = Math.max(0L, scheduledFor - System.currentTimeMillis());
        long delaySeconds = remainingMs == 0L ? 0L : Math.max(1L, (remainingMs + 999L) / 1000L);
        Data input = new Data.Builder()
            .putString("automaticJobId", token.jobId)
            .putString("automaticCharacterId", token.characterId)
            .putString("automaticKind", token.kind)
            .putString("automaticAuthorityEpoch", token.authorityEpoch)
            .putLong("automaticGeneration", token.generation)
            .putLong("automaticScheduledFor", scheduledFor)
            .build();
        enqueueInternal(context, delaySeconds, input, automaticWorkName(token.jobId));
    }

    public static void cancelAutomatic(Context context, String jobId) {
        String safeJobId = jobId == null ? "" : jobId.trim();
        if (safeJobId.isEmpty()) return;
        WorkManager.getInstance(context.getApplicationContext())
            .cancelUniqueWork(automaticWorkName(safeJobId));
    }

    public static void enqueueLifecycle(Context context, long delaySeconds) {
        enqueueInternal(context, delaySeconds, null, LIFECYCLE_WORK_NAME);
    }

    public static void enqueueAutomaticScheduleSync(Context context, long delaySeconds) {
        enqueueInternal(context, delaySeconds, null, AUTOMATIC_SCHEDULE_SYNC_WORK_NAME);
    }

    /**
     * Durably records an independent near-term lifecycle wake before the Room
     * transaction that created the lifecycle control is allowed to commit.
     * The worker cannot observe the control until that transaction commits;
     * if the transaction rolls back, the prearmed wake is harmless.
     */
    public static void prearmLifecycle(Context context) {
        Operation operation = enqueueInternal(context, 5L, null, LIFECYCLE_PREARM_WORK_NAME);
        try {
            operation.getResult().get(10L, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("lifecycle wake prearm interrupted", error);
        } catch (ExecutionException | TimeoutException error) {
            throw new IllegalStateException("lifecycle wake prearm failed", error);
        }
    }

    private static void enqueue(Context context, long delaySeconds, Data input) {
        enqueueInternal(context, delaySeconds, input,
            input == null ? WORK_NAME : WORK_NAME + "-" + input.getString("planId"));
    }

    private static Operation enqueueInternal(Context context, long delaySeconds, Data input, String uniqueName) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest.Builder builder = new OneTimeWorkRequest.Builder(AlExecutionWakeWorker.class)
            .setConstraints(constraints)
            .addTag(WORK_NAME);
        if (input != null) builder.setInputData(input);
        if (AlBackgroundPolicy.expedite(delaySeconds)) {
            builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        }
        if (delaySeconds > 0) builder.setInitialDelay(delaySeconds, TimeUnit.SECONDS);
        return WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
            uniqueName,
            ExistingWorkPolicy.REPLACE,
            builder.build()
        );
    }

    private static String automaticWorkName(String jobId) {
        return WORK_NAME + "-automatic-" + jobId;
    }

    private static AutomaticTaskCoordinator.ClaimToken automaticClaimToken(Data input) {
        HashMap<String, String> raw = new HashMap<>();
        raw.put("charId", input.getString("automaticCharacterId"));
        raw.put("kind", input.getString("automaticKind"));
        raw.put("jobId", input.getString("automaticJobId"));
        raw.put("authorityEpoch", input.getString("automaticAuthorityEpoch"));
        raw.put("generation", String.valueOf(input.getLong("automaticGeneration", 0L)));
        try {
            return AutomaticTaskCoordinator.ClaimToken.from(raw);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    public static void cancel(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(WORK_NAME);
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(LIFECYCLE_WORK_NAME);
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(LIFECYCLE_PREARM_WORK_NAME);
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(AUTOMATIC_SCHEDULE_SYNC_WORK_NAME);
    }
}
