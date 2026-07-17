package com.siyi.al.execution;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class AlPeriodicRecoveryWorker extends Worker {
    public AlPeriodicRecoveryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull @Override public Result doWork() {
        try {
            new RolePlanCoordinator(getApplicationContext()).dispatchDue(System.currentTimeMillis());
            new AutomaticTaskCoordinator(getApplicationContext()).dispatchDue(System.currentTimeMillis());
            AlExecutionService.requestRun(getApplicationContext());
            RolePlanAlarmScheduler.rescheduleAll(getApplicationContext());
            return Result.success();
        } catch (RuntimeException error) {
            return Result.retry();
        }
    }
}
