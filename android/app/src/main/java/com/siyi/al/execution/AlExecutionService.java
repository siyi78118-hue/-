package com.siyi.al.execution;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class AlExecutionService extends Service {
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private final AtomicBoolean draining = new AtomicBoolean(false);
    private ExecutorService executor;
    private ExecutionEngine engine;
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
        AlNotificationFactory notifications = new AlNotificationFactory(this);
        notifications.ensureChannels();
        startForeground(AlNotificationFactory.GUARD_NOTIFICATION_ID, notifications.guardNotification());
        executor = Executors.newSingleThreadExecutor();
        engine = ExecutionRuntime.create(this);
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
            } finally {
                if (wakeLock.isHeld()) wakeLock.release();
                draining.set(false);
            }
        });
    }

    private void acquireWakeLock() {
        if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private static boolean isForegroundStartRestricted(RuntimeException error) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && isForegroundStartRestrictedApi31(error);
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static boolean isForegroundStartRestrictedApi31(RuntimeException error) {
        return error instanceof ForegroundServiceStartNotAllowedException;
    }
}
