package com.siyi.al.execution;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.siyi.al.MainActivity;
import com.siyi.al.R;

public final class AlNotificationFactory {
    public static final String GUARD_CHANNEL = "al_guard";
    public static final String MESSAGE_CHANNEL = "al_messages";
    public static final int GUARD_NOTIFICATION_ID = 71001;
    private final Context context;

    public AlNotificationFactory(Context context) {
        this.context = context.getApplicationContext();
    }

    public void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel guard = new NotificationChannel(
            GUARD_CHANNEL,
            "AL 后台运行",
            NotificationManager.IMPORTANCE_LOW
        );
        guard.setDescription("保持聊天任务在锁屏和切换应用后继续运行");
        guard.setShowBadge(false);
        NotificationChannel messages = new NotificationChannel(
            MESSAGE_CHANNEL,
            "AL 新消息",
            NotificationManager.IMPORTANCE_HIGH
        );
        manager.createNotificationChannel(guard);
        manager.createNotificationChannel(messages);
    }

    public Notification guardNotification() {
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(context, GUARD_CHANNEL)
            .setSmallIcon(R.drawable.ic_al_notification)
            .setContentTitle("AL")
            .setContentText("AL 后台守护已开启")
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }
}
