package com.siyi.al.execution;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class AutomaticTaskAlarmScheduler {
    private AutomaticTaskAlarmScheduler() {}
    public static void schedule(Context context, String jobId, long scheduledFor) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null || jobId == null || jobId.trim().isEmpty()) return;
        PendingIntent pending = PendingIntent.getBroadcast(
            context,
            AlNotificationFactory.messageNotificationId(jobId),
            new Intent(context, AlAutomaticAlarmReceiver.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        } else {
            alarms.set(AlarmManager.RTC_WAKEUP, scheduledFor, pending);
        }
    }
}
