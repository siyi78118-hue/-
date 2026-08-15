package com.siyi.al.execution;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class AlPeriodicRecoveryWorker extends Worker {
    private static final int MAX_WORK_ATTEMPTS = 3;
    public AlPeriodicRecoveryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull @Override public Result doWork() {
        try {
            new RolePlanCoordinator(getApplicationContext()).dispatchDue(System.currentTimeMillis());
            AutomaticTaskCoordinator automatic =
                new AutomaticTaskCoordinator(getApplicationContext());
            automatic.recoverPersistedDeliveryIntents(getApplicationContext());
            automatic.reconcileSchedulers(getApplicationContext());
            automatic.dispatchDue(System.currentTimeMillis());
            AlExecutionService.requestRun(getApplicationContext());
            RolePlanAlarmScheduler.rescheduleAll(getApplicationContext());
            return Result.success();
        } catch (RuntimeException error) {
            return getRunAttemptCount() + 1 < MAX_WORK_ATTEMPTS
                ? Result.retry() : Result.failure();
        }
    }
}
