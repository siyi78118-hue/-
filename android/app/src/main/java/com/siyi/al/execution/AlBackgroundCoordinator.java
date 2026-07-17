package com.siyi.al.execution;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public final class AlBackgroundCoordinator {
    private static final String PERIODIC_WORK = "al-periodic-recovery-v1";
    private AlBackgroundCoordinator() {}

    public static void ensureScheduled(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            AlPeriodicRecoveryWorker.class,
            AlBackgroundPolicy.PERIODIC_RECOVERY_MINUTES,
            TimeUnit.MINUTES
        ).setConstraints(constraints).addTag(PERIODIC_WORK).build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        );
    }
}
