package com.siyi.al.execution;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class AlPlanAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String planId = intent.getStringExtra("planId");
        long scheduledFor = intent.getLongExtra("scheduledFor", 0L);
        if (planId == null || planId.trim().isEmpty() || scheduledFor <= 0L) return;
        AlExecutionWakeWorker.enqueuePlan(context, planId, scheduledFor);
    }
}
