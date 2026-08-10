package com.siyi.al.execution;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

public final class AlNotificationStatus {
    private AlNotificationStatus() {}

    public static Snapshot inspect(Context context) {
        Context app = context.getApplicationContext();
        new AlNotificationFactory(app).ensureChannels();
        boolean permissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        boolean appEnabled = NotificationManagerCompat.from(app).areNotificationsEnabled();
        boolean channelExists = true;
        int importance = NotificationManager.IMPORTANCE_HIGH;
        boolean hasSound = true;
        boolean vibrationEnabled = true;
        int lockscreenVisibility = Notification.VISIBILITY_PUBLIC;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = app.getSystemService(NotificationManager.class);
            NotificationChannel channel = manager == null
                ? null
                : manager.getNotificationChannel(AlNotificationPolicy.MESSAGE_CHANNEL);
            channelExists = channel != null;
            importance = channel == null ? NotificationManager.IMPORTANCE_NONE : channel.getImportance();
            hasSound = channel != null && channel.getSound() != null;
            vibrationEnabled = channel != null && channel.shouldVibrate();
            lockscreenVisibility = channel == null ? Notification.VISIBILITY_PRIVATE : channel.getLockscreenVisibility();
        }
        boolean healthy = isHealthy(
            permissionGranted,
            appEnabled,
            channelExists,
            importance,
            hasSound,
            vibrationEnabled,
            lockscreenVisibility,
            Build.VERSION.SDK_INT
        );
        return new Snapshot(
            permissionGranted,
            appEnabled,
            channelExists,
            importance,
            hasSound,
            vibrationEnabled,
            lockscreenVisibility,
            healthy,
            summary(permissionGranted, appEnabled, channelExists, importance, hasSound, vibrationEnabled,
                lockscreenVisibility, Build.VERSION.SDK_INT)
        );
    }

    public static Intent settingsIntent(Context context) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, AlNotificationPolicy.MESSAGE_CHANNEL);
        } else {
            intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + context.getPackageName())
            );
        }
        return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static boolean isHealthy(
        boolean permissionGranted,
        boolean appEnabled,
        boolean channelExists,
        int importance,
        boolean hasSound,
        boolean vibrationEnabled,
        int lockscreenVisibility
    ) {
        return isHealthy(permissionGranted, appEnabled, channelExists, importance, hasSound,
            vibrationEnabled, lockscreenVisibility, Build.VERSION_CODES.Q);
    }

    static boolean isHealthy(
        boolean permissionGranted,
        boolean appEnabled,
        boolean channelExists,
        int importance,
        boolean hasSound,
        boolean vibrationEnabled,
        int lockscreenVisibility,
        int sdkInt
    ) {
        // Android 11+ no longer respects app-supplied channel lockscreen
        // visibility. The connected gate checks the actual posted message.
        boolean lockscreenHealthy = sdkInt >= Build.VERSION_CODES.R
            || lockscreenVisibility == Notification.VISIBILITY_PUBLIC;
        return permissionGranted
            && appEnabled
            && channelExists
            && importance >= NotificationManager.IMPORTANCE_HIGH
            && hasSound
            && vibrationEnabled
            && lockscreenHealthy;
    }

    static String summary(
        boolean permissionGranted,
        boolean appEnabled,
        boolean channelExists,
        int importance,
        boolean hasSound,
        boolean vibrationEnabled,
        int lockscreenVisibility
    ) {
        return summary(permissionGranted, appEnabled, channelExists, importance, hasSound,
            vibrationEnabled, lockscreenVisibility, Build.VERSION_CODES.Q);
    }

    static String summary(
        boolean permissionGranted,
        boolean appEnabled,
        boolean channelExists,
        int importance,
        boolean hasSound,
        boolean vibrationEnabled,
        int lockscreenVisibility,
        int sdkInt
    ) {
        if (!permissionGranted) return "通知权限未开启，请进入系统设置允许 AL 通知";
        if (!appEnabled) return "AL 的应用通知已被系统关闭";
        if (!channelExists) return "新消息通知渠道尚未建立，请重新打开 AL";
        if (importance < NotificationManager.IMPORTANCE_HIGH) return "新消息通知重要级别过低，请在系统设置中改为重要";
        if (!hasSound) return "新消息通知声音已关闭，请在系统设置中选择提示音";
        if (!vibrationEnabled) return "新消息通知震动已关闭";
        if (sdkInt < Build.VERSION_CODES.R && lockscreenVisibility != Notification.VISIBILITY_PUBLIC) return "锁屏消息正文未公开显示，请检查系统锁屏通知设置";
        return "通知正常：角色消息会响铃、震动并在锁屏显示正文";
    }

    public static final class Snapshot {
        public final boolean permissionGranted;
        public final boolean appEnabled;
        public final boolean channelExists;
        public final int importance;
        public final boolean hasSound;
        public final boolean vibrationEnabled;
        public final int lockscreenVisibility;
        public final boolean healthy;
        public final String summary;

        Snapshot(
            boolean permissionGranted,
            boolean appEnabled,
            boolean channelExists,
            int importance,
            boolean hasSound,
            boolean vibrationEnabled,
            int lockscreenVisibility,
            boolean healthy,
            String summary
        ) {
            this.permissionGranted = permissionGranted;
            this.appEnabled = appEnabled;
            this.channelExists = channelExists;
            this.importance = importance;
            this.hasSound = hasSound;
            this.vibrationEnabled = vibrationEnabled;
            this.lockscreenVisibility = lockscreenVisibility;
            this.healthy = healthy;
            this.summary = summary;
        }
    }
}
