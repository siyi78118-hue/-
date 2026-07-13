package com.siyi.al.execution;

import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

public final class AlExecutionWakeWorker extends Worker {
    private static final String WORK_NAME = "al-execution-wake";

    public AlExecutionWakeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
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

    public static void enqueue(Context context, long delaySeconds) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest.Builder builder = new OneTimeWorkRequest.Builder(AlExecutionWakeWorker.class)
            .setConstraints(constraints)
            .addTag(WORK_NAME);
        if (delaySeconds > 0) builder.setInitialDelay(delaySeconds, TimeUnit.SECONDS);
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
            WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            builder.build()
        );
    }
}
