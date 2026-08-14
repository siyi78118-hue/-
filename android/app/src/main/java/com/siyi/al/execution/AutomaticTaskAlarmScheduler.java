package com.siyi.al.execution;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class AutomaticTaskAlarmScheduler {
    private AutomaticTaskAlarmScheduler() {}

    /** Snapshot-only callers are deliberately ignored; an authority token is required. */
    public static void schedule(Context context, String jobId, long scheduledFor) {
        // Compatibility surface retained until the Web snapshot writer is removed in Task 6.
    }

    public static void schedule(
        Context context, AutomaticTaskCoordinator.ClaimToken token, long scheduledFor
    ) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null || token == null || scheduledFor <= 0L) return;
        PendingIntent pending = pendingIntent(
            context, token, scheduledFor, PendingIntent.FLAG_UPDATE_CURRENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        } else {
            alarms.set(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        }
    }

    public static void cancel(Context context, String jobId) {
        String safeJobId = jobId == null ? "" : jobId.trim();
        if (safeJobId.isEmpty()) return;
        PendingIntent pending = PendingIntent.getBroadcast(
            context,
            AlNotificationFactory.messageNotificationId(safeJobId),
            new Intent(context, AlAutomaticAlarmReceiver.class)
                .setAction("com.siyi.al.AUTOMATIC." + safeJobId),
            PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        if (pending == null) return;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(pending);
        pending.cancel();
    }

    private static PendingIntent pendingIntent(
        Context context, AutomaticTaskCoordinator.ClaimToken token, long scheduledFor, int flags
    ) {
        Intent intent = new Intent(context, AlAutomaticAlarmReceiver.class)
            .setAction("com.siyi.al.AUTOMATIC." + token.jobId)
            .putExtra("charId", token.characterId)
            .putExtra("kind", token.kind)
            .putExtra("jobId", token.jobId)
            .putExtra("authorityEpoch", token.authorityEpoch)
            .putExtra("generation", token.generation)
            .putExtra("scheduledFor", scheduledFor);
        return PendingIntent.getBroadcast(
            context,
            AlNotificationFactory.messageNotificationId(token.jobId),
            intent,
            flags | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
