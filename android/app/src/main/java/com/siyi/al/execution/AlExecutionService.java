package com.siyi.al.execution;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.UrlConnectionTransport;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public final class AlExecutionService extends Service {
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private final AtomicBoolean draining = new AtomicBoolean(false);
    private ExecutorService executor;
    private ExecutionEngine engine;
    private AlExecutionDatabase database;
    private AlNotificationFactory notifications;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean recoveryComplete;

    public static void requestRun(Context context) {
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, AlExecutionService.class));
        } catch (RuntimeException error) {
            if (isForegroundStartRestricted(error)) {
                AlExecutionWakeWorker.enqueue(app);
                return;
            }
            throw error;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = new AlNotificationFactory(this);
        notifications.ensureChannels();
        startForeground(AlNotificationFactory.GUARD_NOTIFICATION_ID, notifications.guardNotification());
        executor = Executors.newSingleThreadExecutor();
        engine = ExecutionRuntime.create(this);
        database = AlExecutionDatabase.get(this);
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AL:Execution");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        kick();
        return ExecutionServicePolicy.restartAfterProcessReclaim() ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        AlExecutionWakeWorker.enqueue(this, 5);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void kick() {
        if (!draining.compareAndSet(false, true)) return;
        executor.execute(() -> {
            acquireWakeLock();
            try {
                if (!recoveryComplete) {
                    engine.recoverInterruptedWork();
                    recoveryComplete = true;
                }
                while (!Thread.currentThread().isInterrupted() && engine.runNext()) {
                    // Drain the single Room-backed queue before sleeping again.
                }
                notifyCompletedTurns();
            } finally {
                if (wakeLock.isHeld()) wakeLock.release();
                draining.set(false);
            }
        });
    }

    private void acquireWakeLock() {
        if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private void notifyCompletedTurns() {
        SharedPreferences notified = getSharedPreferences("al.execution.notifications", MODE_PRIVATE);
        SharedPreferences acknowledged = getSharedPreferences("al.execution.cloud-acks", MODE_PRIVATE);
        for (ChatTurnEntity turn : database.executionDao().completedTurns()) {
            acknowledgeCloudTurn(turn, acknowledged);
            String key = "turn." + turn.turnId;
            if (notified.getBoolean(key, false)) continue;
            String title = characterName(turn);
            String text = notificationText(turn);
            try {
                NotificationManagerCompat.from(this).notify(
                    72000 + Math.abs(turn.turnId.hashCode() % 20000),
                    notifications.messageNotification(title, text, turn.turnId.hashCode())
                );
                notified.edit().putBoolean(key, true).apply();
            } catch (SecurityException ignored) {
                // Android 13+ will deliver after the user grants notification permission.
            }
        }
    }

    private void acknowledgeCloudTurn(ChatTurnEntity turn, SharedPreferences acknowledged) {
        if (turn.cloudJobId == null || turn.cloudJobId.trim().isEmpty()) return;
        String key = "turn." + turn.turnId;
        if (acknowledged.getBoolean(key, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            if (endpoint.isEmpty() || deviceId.isEmpty()) return;
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            body.put("jobId", turn.cloudJobId);
            body.put("charId", turn.characterId);
            body.put("kind", TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind) ? "moment" : "chat");
            body.put("outcome", "generated-native");
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/ack",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                body.toString()
            );
            if (response.status >= 200 && response.status < 300) {
                acknowledged.edit().putBoolean(key, true).apply();
            }
        } catch (Exception ignored) {
            // Keep the ack pending. The sticky service retries it on the next kick.
        }
    }

    private String notificationText(ChatTurnEntity turn) {
        for (ReplyPartEntity part : database.executionDao().replyParts(turn.turnId)) {
            if ("TEXT".equals(part.type) && part.content != null && !part.content.trim().isEmpty()) return part.content.trim();
            if ("REDPACKET".equals(part.type)) return "给你发了一个红包";
            if ("TRANSFER".equals(part.type)) return "向你发起了一笔转账";
        }
        return "收到一条新消息";
    }

    private static String characterName(ChatTurnEntity turn) {
        try {
            String value = new JSONObject(turn.snapshotJson).optString("characterName", "").trim();
            if (!value.isEmpty()) return value;
        } catch (Exception ignored) {}
        return "AL";
    }

    private static boolean isForegroundStartRestricted(RuntimeException error) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && isForegroundStartRestrictedApi31(error);
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static boolean isForegroundStartRestrictedApi31(RuntimeException error) {
        return error instanceof ForegroundServiceStartNotAllowedException;
    }
}
