package com.siyi.al.execution;

import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Data;
import java.util.concurrent.TimeUnit;

public final class AlExecutionWakeWorker extends Worker {
    private static final String WORK_NAME = "al-execution-wake";
    private static final String LIFECYCLE_WORK_NAME = "al-execution-lifecycle-wake";

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

    public static void enqueue(Context context, long delaySeconds) {
        enqueue(context, delaySeconds, null);
    }

    public static void enqueuePlan(Context context, String planId, long scheduledFor) {
        Data input = new Data.Builder().putString("planId", planId).putLong("scheduledFor", scheduledFor).build();
        enqueue(context, 0, input);
    }

    public static void enqueueLifecycle(Context context, long delaySeconds) {
        enqueueInternal(context, delaySeconds, null, LIFECYCLE_WORK_NAME);
    }

    private static void enqueue(Context context, long delaySeconds, Data input) {
        enqueueInternal(context, delaySeconds, input,
            input == null ? WORK_NAME : WORK_NAME + "-" + input.getString("planId"));
    }

    private static void enqueueInternal(Context context, long delaySeconds, Data input, String uniqueName) {
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
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
            uniqueName,
            ExistingWorkPolicy.REPLACE,
            builder.build()
        );
    }

    public static void cancel(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(WORK_NAME);
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(LIFECYCLE_WORK_NAME);
    }
}
