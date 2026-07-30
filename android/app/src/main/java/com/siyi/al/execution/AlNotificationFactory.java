package com.siyi.al.execution;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.os.Build;
import android.media.RingtoneManager;
import androidx.core.app.NotificationCompat;
import com.siyi.al.MainActivity;
import com.siyi.al.R;

public final class AlNotificationFactory {
    public static final String GUARD_CHANNEL = "al_guard";
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
            AlNotificationPolicy.MESSAGE_CHANNEL,
            "AL 新消息",
            AlNotificationPolicy.messageImportance()
        );
        AudioAttributes messageAudio = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        messages.setDescription("角色消息完成后的声音、震动和锁屏提醒");
        messages.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), messageAudio);
        messages.enableVibration(true);
        messages.setVibrationPattern(new long[]{0L, 240L, 120L, 240L});
        messages.setLockscreenVisibility(AlNotificationPolicy.messageVisibility());
        NotificationChannel progress = new NotificationChannel(
            AlNotificationPolicy.PROGRESS_CHANNEL,
            "AL 消息生成进度",
            AlNotificationPolicy.progressImportance()
        );
        progress.setDescription("显示角色消息正在生成，不发出声音或震动");
        progress.setSound(null, null);
        progress.enableVibration(false);
        progress.setShowBadge(false);
        progress.setLockscreenVisibility(AlNotificationPolicy.progressVisibility());
        manager.createNotificationChannel(guard);
        manager.createNotificationChannel(messages);
        manager.createNotificationChannel(progress);
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

    public Notification messageNotification(String title, String text, int requestCode) {
        String safeTitle = title == null || title.trim().isEmpty() ? "AL" : title.trim();
        String safeText = text == null || text.trim().isEmpty() ? "收到一条新消息" : text.trim();
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            requestCode,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(context, AlNotificationPolicy.MESSAGE_CHANNEL)
            .setSmallIcon(R.drawable.ic_al_notification)
            .setContentTitle(safeTitle)
            .setContentText(safeText)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(safeText))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();
    }

    public Notification pendingMessageNotification(String title, int requestCode) {
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(context, AlNotificationPolicy.PROGRESS_CHANNEL)
            .setSmallIcon(R.drawable.ic_al_notification)
            .setContentTitle(title == null || title.trim().isEmpty() ? "AL" : title.trim())
            .setContentText("正在生成角色消息…")
            .setContentIntent(pending)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    public static int messageNotificationId(String turnId) {
        return 72000 + Math.abs(String.valueOf(turnId).hashCode() % 20000);
    }
}
