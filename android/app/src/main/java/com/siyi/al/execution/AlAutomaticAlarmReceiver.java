package com.siyi.al.execution;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.HashMap;

public final class AlAutomaticAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        HashMap<String, String> raw = new HashMap<>();
        raw.put("charId", intent.getStringExtra("charId"));
        raw.put("kind", intent.getStringExtra("kind"));
        raw.put("jobId", intent.getStringExtra("jobId"));
        raw.put("authorityEpoch", intent.getStringExtra("authorityEpoch"));
        raw.put("generation", String.valueOf(intent.getLongExtra("generation", 0L)));
        try {
            long scheduledFor = intent.getLongExtra("scheduledFor", 0L);
            if (scheduledFor <= 0L) return;
            AlExecutionWakeWorker.enqueueAutomatic(
                context, AutomaticTaskCoordinator.ClaimToken.from(raw), scheduledFor);
        } catch (IllegalArgumentException ignored) {
            // Stale or malformed alarms are transport noise, not semantic failures.
        }
    }
}
