package com.siyi.al.execution;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.RolePlanEntity;

public final class RolePlanAlarmScheduler {
    private RolePlanAlarmScheduler() {}

    public static void rescheduleAll(Context context) {
        Context app = context.getApplicationContext();
        for (RolePlanEntity plan : AlExecutionDatabase.get(app).executionDao().dueOrFutureActiveRolePlans()) {
            if (plan.nextRunAt != null) schedule(app, plan.planId, plan.nextRunAt);
        }
    }

    public static void schedule(Context context, String planId, long scheduledFor) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        PendingIntent pending = PendingIntent.getBroadcast(
            context,
            RolePlanOccurrenceKey.notificationId(planId),
            new Intent(context, AlPlanAlarmReceiver.class)
                .putExtra("planId", planId)
                .putExtra("scheduledFor", scheduledFor),
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
