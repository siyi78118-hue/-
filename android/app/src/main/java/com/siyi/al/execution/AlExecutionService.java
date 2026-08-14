package com.siyi.al.execution;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import com.siyi.al.AlExecutionPlugin;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.UrlConnectionTransport;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public final class AlExecutionService extends Service {
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private static volatile CountDownLatch testStopLatch = new CountDownLatch(0);
    enum StartupState { NEW, INITIALIZING, READY, STOPPING, STOPPED }
    private final ExecutionDrainGate drainGate = new ExecutionDrainGate();
    private final Object startupLock = new Object();
    private CountDownLatch stopLatch;
    private volatile StartupState startupState = StartupState.NEW;
    private volatile boolean initializationScheduled;
    private volatile boolean startRequested;
    private final AtomicBoolean cleanupClaimed = new AtomicBoolean(false);
    private int recoveryCallbacksInFlight;
    private ExecutorService executor;
    private ScheduledExecutorService recoveryScheduler;
    private ExecutionEngine engine;
    private AlExecutionDatabase database;
    private RoomExecutionStore executionStore;
    private BridgeReceiptDeliveryCoordinator bridgeReceiptCoordinator;
    private AutomaticScheduleSender automaticScheduleSender;
    private AlNotificationFactory notifications;
    private PowerManager.WakeLock wakeLock;

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
        stopLatch = new CountDownLatch(1);
        testStopLatch = stopLatch;
        notifications = new AlNotificationFactory(this);
        notifications.ensureChannels();
        startForeground(AlNotificationFactory.GUARD_NOTIFICATION_ID, notifications.guardNotification());
        executor = Executors.newSingleThreadExecutor();
        scheduleInitialization();
    }

    private void scheduleInitialization() {
        ExecutorService worker;
        synchronized (startupLock) {
            if (startupState == StartupState.STOPPING || startupState == StartupState.STOPPED
                || initializationScheduled) return;
            startupState = StartupState.INITIALIZING;
            initializationScheduled = true;
            worker = executor;
        }
        if (worker == null || worker.isShutdown()) {
            synchronized (startupLock) {
                initializationScheduled = false;
                if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                    startupState = StartupState.NEW;
                }
            }
            return;
        }
        try {
            worker.execute(this::initializeOnWorker);
        } catch (RejectedExecutionException rejected) {
            synchronized (startupLock) {
                initializationScheduled = false;
                if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                    startupState = StartupState.NEW;
                }
            }
        }
    }

    private void initializeOnWorker() {
        AlExecutionDatabase localDatabase = null;
        ExecutionEngine localEngine = null;
        RoomExecutionStore localStore = null;
        BridgeReceiptDeliveryCoordinator localCoordinator = null;
        AutomaticScheduleSender localAutomaticScheduleSender = null;
        PowerManager.WakeLock localWakeLock = null;
        try {
            // All Room access and complete runtime construction stays on the
            // service worker.  onCreate only owns notification/foreground
            // setup and scheduling this method.
            localDatabase = AlExecutionDatabase.get(this);
            localEngine = ExecutionRuntime.create(this);
            localStore = new RoomExecutionStore(localDatabase);
            localAutomaticScheduleSender =
                ExecutionRuntime.createAutomaticScheduleSender(this, localDatabase);
            final RoomExecutionStore coordinatorStore = localStore;
            localCoordinator = new BridgeReceiptDeliveryCoordinator(
                coordinatorStore,
                receipt -> {
                    JSONObject transportPayload = new JSONObject(receipt.wireJson)
                        .put("_checkpointChecksum", receipt.checkpointChecksum)
                        .put("_deliveryRoute", receipt.route);
                    if (receipt.relayMessageId != null) {
                        transportPayload.put("_relayMessageId", receipt.relayMessageId);
                    }
                    if (!ExecutionRuntime.confirmAppliedResult(this, transportPayload.toString())) {
                        throw new IllegalStateException("authority receipt transport is unavailable");
                    }
                },
                System::currentTimeMillis);
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            localWakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AL:Execution");
            localWakeLock.setReferenceCounted(false);
            boolean kickNow;
            synchronized (startupLock) {
                if (startupState == StartupState.STOPPING || startupState == StartupState.STOPPED) {
                    initializationScheduled = false;
                    releaseWakeLock(localWakeLock);
                    return;
                }
                // Publish the complete runtime graph as one state transition.
                // Readers can therefore observe either NEW/INITIALIZING or a
                // fully usable READY graph, never a partially initialized one.
                database = localDatabase;
                engine = localEngine;
                executionStore = localStore;
                bridgeReceiptCoordinator = localCoordinator;
                automaticScheduleSender = localAutomaticScheduleSender;
                wakeLock = localWakeLock;
                initializationScheduled = false;
                startupState = StartupState.READY;
                kickNow = startRequested;
                startRequested = false;
            }
            try {
                // Scheduler creation is deliberately after READY publication,
                // with a second state check inside the method.
                startRecoverySchedulerOnWorker();
            } catch (Throwable schedulerFailure) {
                resetPublishedInitializationAfterFailure();
                return;
            }
            if (kickNow && startupState == StartupState.READY) kick();
        } catch (Throwable error) {
            releaseWakeLock(localWakeLock);
            resetInitializationAfterFailure(localDatabase, localEngine, localStore,
                localCoordinator, localAutomaticScheduleSender, localWakeLock);
        }
    }

    private void startRecoverySchedulerOnWorker() {
        synchronized (startupLock) {
            if (startupState != StartupState.READY) return;
            if (recoveryScheduler != null && !recoveryScheduler.isShutdown()) return;
        }
        final ScheduledExecutorService candidate = Executors.newSingleThreadScheduledExecutor();
        synchronized (startupLock) {
            if (startupState != StartupState.READY) {
                candidate.shutdownNow();
                return;
            }
            recoveryScheduler = candidate;
        }
        try {
            candidate.scheduleWithFixedDelay(() -> {
                if (!beginRecoveryCallback()) return;
                try {
                    if (!isReadyForWork()) return;
                    int imported = ExecutionRuntime.drainCloudInbox(this);
                    if (!isReadyForWork()) return;
                    if (imported > 0) {
                        executionStore.recordDiagnostic(
                            "cloud-inbox", null, "INFO", "CLOUD_INBOX_IMPORTED",
                            "count=" + imported, System.currentTimeMillis()
                        );
                    }
                    if (!isReadyForWork()) return;
                    new RolePlanCoordinator(database).dispatchDue(System.currentTimeMillis());
                    if (!isReadyForWork()) return;
                    new AutomaticTaskCoordinator(database).dispatchDue(System.currentTimeMillis());
                    if (!isReadyForWork()) return;
                    kick();
                } catch (Exception error) {
                    if (isReadyForWork() && executionStore != null) {
                        executionStore.recordDiagnostic("background-scan", null, "WARN", "BACKGROUND_SCAN_FAILED", error.getMessage(), System.currentTimeMillis());
                    }
                } finally {
                    endRecoveryCallback();
                }
            }, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS, TimeUnit.SECONDS);
        } catch (RuntimeException | Error scheduleFailure) {
            synchronized (startupLock) {
                if (recoveryScheduler == candidate) recoveryScheduler = null;
            }
            candidate.shutdownNow();
            throw scheduleFailure;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        synchronized (startupLock) {
            if (startupState == StartupState.STOPPING || startupState == StartupState.STOPPED) {
                return START_NOT_STICKY;
            }
            startRequested = true;
        }
        if (startupState != StartupState.READY) scheduleInitialization();
        kick();
        return ExecutionServicePolicy.restartAfterProcessReclaim() ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (startupState == StartupState.READY) AlExecutionWakeWorker.enqueue(this, 5);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        ExecutorService worker;
        synchronized (startupLock) {
            if (shouldIgnoreDestroy(startupState)) return;
            startupState = StartupState.STOPPING;
            startRequested = false;
            worker = executor;
        }
        drainGate.close();
        if (worker == null) {
            cleanupOnWorker();
        } else {
            try {
                // Queue terminal cleanup behind any in-flight drain.  No
                // Room/runtime/wakelock resources are never released by the
                // main thread; this closure owns their terminal cleanup.
                worker.execute(this::cleanupOnWorker);
                worker.shutdown();
            } catch (RejectedExecutionException rejected) {
                worker.shutdownNow();
                // Never clean resources on this caller while the rejected
                // worker may still be running. A fallback worker waits for
                // termination and becomes the sole cleanup owner.
                deferCleanupAfterRejectedWorker(worker, this::cleanupOnWorker);
            }
        }
        super.onDestroy();
    }

    static boolean shouldIgnoreDestroy(StartupState state) {
        return state == StartupState.STOPPING || state == StartupState.STOPPED;
    }

    /** Package-private race seam used by the JVM regression test. */
    static void deferCleanupAfterRejectedWorker(ExecutorService rejectedWorker, Runnable cleanup) {
        if (rejectedWorker == null || cleanup == null) {
            throw new IllegalArgumentException("cleanup worker required");
        }
        ExecutorService waiter = Executors.newSingleThreadExecutor(r -> {
            Thread thread = new Thread(r, "al-execution-cleanup-waiter");
            thread.setDaemon(true);
            return thread;
        });
        waiter.execute(() -> {
            boolean interrupted = false;
            try {
                for (;;) {
                    try {
                        if (rejectedWorker.awaitTermination(100L, TimeUnit.MILLISECONDS)) break;
                    } catch (InterruptedException interruption) {
                        interrupted = true;
                    }
                }
            } finally {
                try {
                    cleanup.run();
                } finally {
                    waiter.shutdown();
                    if (interrupted) Thread.currentThread().interrupt();
                }
            }
        });
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void kick() {
        ExecutorService worker;
        PowerManager.WakeLock workerWakeLock;
        synchronized (startupLock) {
            if (startupState != StartupState.READY || executor == null || engine == null
                || executionStore == null || wakeLock == null) {
                if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                    startRequested = true;
                }
                worker = null;
                workerWakeLock = null;
            } else {
                startRequested = false;
                worker = executor;
                workerWakeLock = wakeLock;
            }
        }
        if (worker == null) {
            if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                scheduleInitialization();
            }
            return;
        }
        if (!drainGate.request()) return;
        try {
            worker.execute(() -> {
            acquireWakeLock(workerWakeLock);
            try {
                boolean continueDraining;
                do {
                    if (!isReadyForWork()) {
                        drainGate.finishCycle();
                        return;
                    }
                    try {
                        while (isReadyForWork() && ExecutionRuntime.drainLifecycleControl(this)) {
                            // Controls are an independent outbox; do not route them through turn execution.
                        }
                    } catch (Exception controlError) {
                        if (isReadyForWork()) executionStore.recordDiagnostic(
                            "lifecycle-control", null, "WARN", "LIFECYCLE_CONTROL_RETRY",
                            controlError.getMessage() == null ? "control delivery failed" : controlError.getMessage(),
                            System.currentTimeMillis());
                    } finally {
                        try {
                            if (!isReadyForWork()) {
                                drainGate.finishCycle();
                                return;
                            }
                            long lifecycleDelay = ExecutionRuntime.nextLifecycleDelay(this);
                            if (lifecycleDelay >= 0L) {
                                AlExecutionWakeWorker.enqueueLifecycle(this, lifecycleDelay);
                            }
                        } catch (RuntimeException scheduleError) {
                            if (isReadyForWork()) executionStore.recordDiagnostic(
                                "lifecycle-control", null, "WARN", "LIFECYCLE_CONTROL_WAKE_RETRY",
                                scheduleError.getMessage() == null ? "control wake scheduling failed" : scheduleError.getMessage(),
                                System.currentTimeMillis());
                        }
                    }
                    AutomaticScheduleSender scheduleSender = automaticScheduleSender;
                    if (isReadyForWork() && scheduleSender != null) {
                        scheduleSender.recoverExpiredLeases(System.currentTimeMillis());
                        for (int sent = 0; sent < 16; sent += 1) {
                            AutomaticScheduleSender.Outcome outcome =
                                scheduleSender.flushOne(System.currentTimeMillis());
                            if (outcome != AutomaticScheduleSender.Outcome.SYNCED
                                && outcome != AutomaticScheduleSender.Outcome.QUARANTINED) break;
                        }
                        long automaticDelay = scheduleSender.nextDelayMs(System.currentTimeMillis());
                        if (automaticDelay != Long.MAX_VALUE) {
                            long automaticSeconds = automaticDelay <= 0L ? 0L
                                : Math.max(1L, (automaticDelay + 999L) / 1000L);
                            AlExecutionWakeWorker.enqueueAutomaticScheduleSync(this, automaticSeconds);
                        }
                    }
                    if (!isReadyForWork()) {
                        drainGate.finishCycle();
                        return;
                    }
                    executionStore.recoverDueRetries(System.currentTimeMillis());
                    if (!isReadyForWork()) {
                        drainGate.finishCycle();
                        return;
                    }
                    engine.recoverInterruptedWork();
                    while (isReadyForWork() && engine.runNext()) {
                        // Drain the single Room-backed queue before checking for a concurrent wake.
                    }
                    if (!isReadyForWork()) {
                        drainGate.finishCycle();
                        return;
                    }
                    notifyCompletedTurns();
                    if (!isReadyForWork()) {
                        drainGate.finishCycle();
                        return;
                    }
                    RetryRecoveryResult retries = executionStore.recoverDueRetries(System.currentTimeMillis());
                    if (retries.nextDelaySeconds >= 0L) {
                        AlExecutionWakeWorker.enqueue(this, retries.nextDelaySeconds);
                    }
                    boolean wakeRequested = drainGate.finishCycle();
                    continueDraining = !Thread.currentThread().isInterrupted()
                        && (retries.restarted > 0 || wakeRequested);
                } while (continueDraining);
            } catch (RuntimeException error) {
                boolean restart = drainGate.abortCycle();
                if (restart && startupState == StartupState.READY && !worker.isShutdown()) kick();
                throw error;
            } finally {
                releaseWakeLock(workerWakeLock);
            }
            });
        } catch (RejectedExecutionException rejected) {
            drainGate.abortCycle();
            synchronized (startupLock) {
                if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                    startRequested = true;
                }
            }
        }
    }

    private void acquireWakeLock(PowerManager.WakeLock target) {
        if (target != null && !target.isHeld()) target.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private static void releaseWakeLock(PowerManager.WakeLock target) {
        if (target != null && target.isHeld()) target.release();
    }

    private void resetInitializationAfterFailure(
        AlExecutionDatabase localDatabase,
        ExecutionEngine localEngine,
        RoomExecutionStore localStore,
        BridgeReceiptDeliveryCoordinator localCoordinator,
        AutomaticScheduleSender localAutomaticScheduleSender,
        PowerManager.WakeLock localWakeLock
    ) {
        synchronized (startupLock) {
            if (database == localDatabase) database = null;
            if (engine == localEngine) engine = null;
            if (executionStore == localStore) executionStore = null;
            if (bridgeReceiptCoordinator == localCoordinator) bridgeReceiptCoordinator = null;
            if (automaticScheduleSender == localAutomaticScheduleSender) automaticScheduleSender = null;
            if (wakeLock == localWakeLock) wakeLock = null;
            initializationScheduled = false;
            if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                startupState = StartupState.NEW;
            }
        }
        releaseWakeLock(localWakeLock);
    }

    private void resetPublishedInitializationAfterFailure() {
        ScheduledExecutorService scheduler;
        PowerManager.WakeLock publishedWakeLock;
        synchronized (startupLock) {
            scheduler = recoveryScheduler;
            recoveryScheduler = null;
            publishedWakeLock = wakeLock;
            wakeLock = null;
            database = null;
            engine = null;
            executionStore = null;
            bridgeReceiptCoordinator = null;
            automaticScheduleSender = null;
            initializationScheduled = false;
            if (startupState != StartupState.STOPPING && startupState != StartupState.STOPPED) {
                startupState = StartupState.NEW;
            }
        }
        if (scheduler != null) scheduler.shutdownNow();
        releaseWakeLock(publishedWakeLock);
    }

    private void cleanupOnWorker() {
        if (!cleanupClaimed.compareAndSet(false, true)) return;
        ScheduledExecutorService scheduler;
        PowerManager.WakeLock publishedWakeLock;
        CountDownLatch completedLatch;
        synchronized (startupLock) {
            scheduler = recoveryScheduler;
            recoveryScheduler = null;
        }
        if (scheduler != null) scheduler.shutdownNow();
        awaitRecoveryCallbacksStopped();
        synchronized (startupLock) {
            publishedWakeLock = wakeLock;
            wakeLock = null;
            database = null;
            engine = null;
            executionStore = null;
            bridgeReceiptCoordinator = null;
            automaticScheduleSender = null;
            initializationScheduled = false;
            startRequested = false;
            startupState = StartupState.STOPPED;
            completedLatch = stopLatch;
        }
        releaseWakeLock(publishedWakeLock);
        if (completedLatch != null) completedLatch.countDown();
    }

    /** Test-only observation of worker-owned terminal cleanup; not a control path. */
    static boolean awaitStoppedForTest(long timeoutMs) throws InterruptedException {
        return testStopLatch.await(timeoutMs, TimeUnit.MILLISECONDS);
    }

    private boolean beginRecoveryCallback() {
        synchronized (startupLock) {
            if (startupState != StartupState.READY) return false;
            recoveryCallbacksInFlight++;
            return true;
        }
    }

    private void endRecoveryCallback() {
        synchronized (startupLock) {
            if (recoveryCallbacksInFlight > 0) recoveryCallbacksInFlight--;
            startupLock.notifyAll();
        }
    }

    private void awaitRecoveryCallbacksStopped() {
        boolean interrupted = false;
        synchronized (startupLock) {
            while (recoveryCallbacksInFlight > 0) {
                try {
                    startupLock.wait();
                } catch (InterruptedException interruption) {
                    interrupted = true;
                    // The callback still owns the published graph and will
                    // signal completion in endRecoveryCallback.  Do not clear
                    // fields or publish STOPPED early.
                }
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private boolean isReadyForWork() {
        return startupState == StartupState.READY && !Thread.currentThread().isInterrupted();
    }

    private void notifyCompletedTurns() {
        SharedPreferences notified = getSharedPreferences("al.execution.notifications", MODE_PRIVATE);
        SharedPreferences acknowledged = getSharedPreferences("al.execution.cloud-acks", MODE_PRIVATE);
        SharedPreferences continued = getSharedPreferences("al.execution.role-plan-continuations", MODE_PRIVATE);
        SharedPreferences proactiveContinued = getSharedPreferences("al.execution.proactive-continuations", MODE_PRIVATE);
        SharedPreferences bridgeReceipts = getSharedPreferences("al.execution.bridge-receipts", MODE_PRIVATE);
        RolePlanCoordinator rolePlanCoordinator = new RolePlanCoordinator(this);
        rolePlanCoordinator.reconcileFailedTurns(System.currentTimeMillis());
        for (ChatTurnEntity turn : database.executionDao().completedTurns()) {
            ExecutionServicePolicy.RoleDeleteFence roleDeleteFence =
                () -> executionStore.isRoleDeleteTombstoned(turn.characterId);
            boolean roleDeleted = roleDeleteFence.isDeleted();
            // A role-delete tombstone is a hard boundary for this preloaded
            // completed row: do not emit ordinary receipts, ACKs, diagnostics,
            // continuations, notifications, or completion events after it wins.
            if (!ExecutionServicePolicy.shouldRunCompletedTurnSideEffects(roleDeleted)) continue;
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> AlExecutionPlugin.notifyCompletedTurn(turn.turnId, turn.updatedAt))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> confirmBridgeDelivery(turn, bridgeReceipts))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> acknowledgeCloudTurn(turn, acknowledged))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> continueAutomaticTask(turn, proactiveContinued))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> continueRolePlan(turn, continued))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(
                turn.characterId, () -> rolePlanCoordinator.completeForTurn(
                    turn.turnId, System.currentTimeMillis()))) {
                continue;
            }
            if (!executionStore.runRoleSideEffectIfNotDeleted(turn.characterId, () -> {
                if (roleDeleteFence.isDeleted()) return;
                java.util.List<ReplyPartEntity> notificationParts =
                    database.executionDao().replyParts(turn.turnId);
                if (roleDeleteFence.isDeleted()
                    || !AlNotificationPolicy.shouldNotifyCompletedTurn(
                        turn.terminalDisposition, notificationParts.size(), turn.deletedAt != null)) {
                    return;
                }
                String key = "turn." + turn.turnId;
                int notificationId = AlNotificationFactory.messageNotificationId(turn.turnId);
                if (notified.getBoolean(key, false) || turn.notificationShownAt != null) {
                    if (!notified.getBoolean(key, false)) {
                        notified.edit().putBoolean(key, true).commit();
                    }
                    if (turn.notificationShownAt == null) {
                        executionStore.markNotificationShown(turn.turnId, System.currentTimeMillis());
                    }
                    return;
                }
                String title = characterName(turn);
                String text = notificationText(turn);
                AlNotificationStatus.Snapshot notificationStatus = AlNotificationStatus.inspect(this);
                if (!notificationStatus.permissionGranted
                    || !notificationStatus.appEnabled
                    || !notificationStatus.channelExists
                    || notificationStatus.importance <= 0) {
                    return;
                }
                try {
                    NotificationManagerCompat.from(this).notify(
                        notificationId,
                        notifications.messageNotification(title, text, turn.turnId.hashCode())
                    );
                    if (roleDeleteFence.isDeleted()) {
                        NotificationManagerCompat.from(this).cancel(notificationId);
                        return;
                    }
                    notified.edit().putBoolean(key, true).commit();
                    if (roleDeleteFence.isDeleted()) {
                        NotificationManagerCompat.from(this).cancel(notificationId);
                        return;
                    }
                    executionStore.markNotificationShown(turn.turnId, System.currentTimeMillis());
                } catch (SecurityException ignored) {
                    // Android 13+ will deliver after the user grants notification permission.
                }
            })) {
                continue;
            }
        }
    }

    private void confirmBridgeDelivery(ChatTurnEntity turn, SharedPreferences confirmed) {
        ExecutionServicePolicy.CompletedDeliveryPath deliveryPath = completedDeliveryPath(turn);
        if (deliveryPath == ExecutionServicePolicy.CompletedDeliveryPath.JOURNAL_ONLY) {
            // Local fallback v2 is owned by FallbackJournal.  It has no cloud
            // delivery target and must never fall through to either receipt
            // writer (canonical or legacy).
            return;
        }
        if (deliveryPath == ExecutionServicePolicy.CompletedDeliveryPath.CANONICAL_RECEIPT) {
            confirmCanonicalBridgeDelivery(turn);
            return;
        }
        if (deliveryPath == ExecutionServicePolicy.CompletedDeliveryPath.NONE) {
            // A v3 row without a closed, persisted authority checkpoint is
            // ambiguous.  Fail closed instead of guessing from memoryResult.
            return;
        }
        String key = "turn." + turn.turnId;
        if (confirmed.getBoolean(key, false)) {
            if (turn.uiAppliedAt != null && turn.cloudConfirmedAt == null) {
                executionStore.markCloudConfirmed(turn.turnId, turn.uiAppliedAt);
            }
            return;
        }
        if (turn.uiAppliedAt == null) return;
        try {
            com.siyi.al.execution.db.ExecutionAttemptEntity attempt = executionStore.activeAttempt(turn.turnId);
            if (attempt == null || attempt.memoryResult == null || attempt.memoryResult.trim().isEmpty()) return;
            JSONObject response = BridgeReceiptCheckpoint.extract(attempt.memoryResult);
            if (response == null) return;
            if (ExecutionRuntime.confirmAppliedResult(this, response.toString())) {
                long confirmedAt = System.currentTimeMillis();
                executionStore.markCloudConfirmed(turn.turnId, confirmedAt);
                confirmed.edit().putBoolean(key, true).apply();
                executionStore.recordDiagnostic(
                    turn.turnId, turn.activeAttemptId, "INFO", "PHONE_RECEIPT_SENT",
                    response.optString("_relayMessageId", ""), confirmedAt
                );
            }
        } catch (Exception error) {
            executionStore.recordDiagnostic(
                turn.turnId, turn.activeAttemptId, "WARN", "PHONE_RECEIPT_PENDING",
                error.getMessage(), System.currentTimeMillis()
            );
        }
    }

    private ExecutionServicePolicy.CompletedDeliveryPath completedDeliveryPath(ChatTurnEntity turn) {
        if (turn == null) return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
        Integer checkpointVersion = null;
        String outcomeType = null;
        String outcomeRoute = null;
        if (turn.bridgeProtocolVersion != null && turn.bridgeProtocolVersion == 3) {
            if (turn.activeAttemptId == null || turn.activeAttemptId.trim().isEmpty()) {
                return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
            }
            try {
                com.siyi.al.execution.db.ExecutionAttemptEntity attempt =
                    executionStore.activeAttempt(turn.turnId);
                if (attempt == null || !turn.activeAttemptId.equals(attempt.attemptId)
                    || attempt.bridgeAuthorityCheckpointJson == null
                    || attempt.bridgeAuthorityCheckpointChecksum == null) {
                    return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
                }
                JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
                Object version = checkpoint.opt("version");
                if (!(version instanceof Number)) return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
                long versionValue = ((Number) version).longValue();
                if (((Number) version).doubleValue() != (double) versionValue
                    || versionValue < 1L || versionValue > Integer.MAX_VALUE) {
                    return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
                }
                checkpointVersion = (int) versionValue;
                JSONObject outcome = checkpoint.optJSONObject("outcome");
                if (outcome == null) return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
                Object type = outcome.opt("type");
                Object route = outcome.opt("route");
                if (!(type instanceof String) || !(route instanceof String)) {
                    return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
                }
                outcomeType = (String) type;
                outcomeRoute = (String) route;
            } catch (Exception malformedCheckpoint) {
                return ExecutionServicePolicy.CompletedDeliveryPath.NONE;
            }
        }
        return ExecutionServicePolicy.classifyCompletedDelivery(
            turn.bridgeProtocolVersion,
            turn.state,
            turn.deletedAt,
            checkpointVersion,
            turn.authorityOrigin,
            outcomeType,
            outcomeRoute
        );
    }

    private void confirmCanonicalBridgeDelivery(ChatTurnEntity turn) {
        if (turn.cloudConfirmedAt != null) return;
        try {
            BridgeReceiptDeliveryCoordinator.Outcome outcome =
                bridgeReceiptCoordinator.deliver(turn.turnId);
            if (outcome.status == BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(
                    turn.turnId, turn.activeAttemptId, "INFO", "AUTHORITY_RECEIPT_CONFIRMED",
                    outcome.receipt == null ? "" : outcome.receipt.idempotencyKey,
                    System.currentTimeMillis());
            } else if (outcome.status == BridgeReceiptDeliveryCoordinator.OutcomeStatus.RETRYABLE) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(
                    turn.turnId, turn.activeAttemptId, "WARN", "AUTHORITY_RECEIPT_PENDING",
                    outcome.reason, System.currentTimeMillis());
            }
        } catch (Exception error) {
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(
                turn.turnId, turn.activeAttemptId, "WARN", "AUTHORITY_RECEIPT_PENDING",
                error.getMessage(), System.currentTimeMillis());
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
            boolean moment = TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind)
                || TurnKind.ROLE_PLAN_MOMENT.name().equals(turn.kind)
                || TurnKind.ROLE_PLAN_MOMENT_PRIVATE.name().equals(turn.kind);
            body.put("kind", moment ? "moment" : "chat");
            body.put("outcome", "generated-native");
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/ack",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                body.toString()
            );
            if (response.status >= 200 && response.status < 300) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                acknowledged.edit().putBoolean(key, true).apply();
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "ACK_OK", "status=" + response.status, System.currentTimeMillis());
            } else {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ACK_FAILED", "status=" + response.status, System.currentTimeMillis());
            }
        } catch (Exception error) {
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ACK_FAILED", error.getMessage(), System.currentTimeMillis());
            // Keep the ack pending. The sticky service retries it on the next kick.
        }
    }

    private void continueRolePlan(ChatTurnEntity turn, SharedPreferences continued) {
        if (!isRolePlanKind(turn.kind) || turn.cloudJobId == null || turn.cloudJobId.trim().isEmpty()) return;
        String continuationKey = "turn." + turn.turnId;
        if (continued.getBoolean(continuationKey, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            JSONObject plan = snapshot.optJSONObject("rolePlan");
            JSONObject schedule = plan == null ? null : plan.optJSONObject("schedule");
            String planId = plan == null ? "" : plan.optString("planId", "").trim();
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            if (plan == null || schedule == null || planId.isEmpty() || endpoint.isEmpty() || deviceId.isEmpty()) return;

            long after = Math.max(System.currentTimeMillis(), plan.optLong("nextRunAt", System.currentTimeMillis()));
            Long nextRunAt = RolePlanSchedule.nextOccurrence(schedule, after);
            long now = System.currentTimeMillis();
            if (nextRunAt == null) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                plan.put("status", "completed");
                plan.put("completedAt", now);
                plan.put("lastRunAt", now);
                plan.put("cloudJobId", JSONObject.NULL);
                persistRolePlanContinuation(turn, snapshot, plan, null, now);
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                continued.edit().putBoolean(continuationKey, true).apply();
                return;
            }

            String safeDeviceId = safeId(deviceId);
            String safePlanId = safeId(planId);
            String jobId = "rpl_" + safeDeviceId + "_" + safePlanId + "_" + nextRunAt;
            JSONObject body = new JSONObject();
            body.put("deviceId", safeDeviceId);
            body.put("jobId", jobId);
            body.put("planId", planId);
            body.put("occurrenceId", planId + ":" + nextRunAt);
            body.put("charId", turn.characterId);
            body.put("dueAt", isoTime(nextRunAt));
            body.put("type", "role-plan");
            body.put("kind", plan.optString("type", "private_message"));
            body.put("source", plan.optString("source", "spoken"));
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/schedule",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                body.toString()
            );
            if (response.status < 200 || response.status >= 300) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ROLE_PLAN_RESCHEDULE_FAILED", "status=" + response.status, now);
                return;
            }
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            plan.put("status", "active");
            plan.put("nextRunAt", nextRunAt);
            plan.put("lastRunAt", now);
            plan.put("cloudJobId", jobId);
            plan.put("updatedAt", now);
            persistRolePlanContinuation(turn, snapshot, plan, jobId, now);
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            continued.edit().putBoolean(continuationKey, true).apply();
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "ROLE_PLAN_RESCHEDULED", jobId, now);
        } catch (Exception error) {
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "ROLE_PLAN_RESCHEDULE_FAILED", error.getMessage(), System.currentTimeMillis());
        }
    }

    private void continueAutomaticTask(ChatTurnEntity turn, SharedPreferences continued) {
        boolean moment = TurnKind.PROACTIVE_MOMENT.name().equals(turn.kind);
        if (!moment && !TurnKind.PROACTIVE_CHAT.name().equals(turn.kind)) return;
        String continuationKey = "turn." + turn.turnId;
        if (continued.getBoolean(continuationKey, false)) return;
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            if (!snapshot.optBoolean("automaticTasksEnabled", false)) return;
            String endpoint = snapshot.optString("timerEndpoint", "").replaceAll("/+$", "");
            String deviceId = snapshot.optString("deviceId", "").trim();
            JSONObject previousJob = snapshot.optJSONObject("proactiveJob");
            String kind = moment ? "moment" : "chat";
            if (endpoint.isEmpty() || deviceId.isEmpty() || previousJob == null) return;

            long now = System.currentTimeMillis();
            long nextRunAt = 0L;
            for (ReplyPartEntity part : database.executionDao().replyParts(turn.turnId)) {
                if (!"SCHEDULE".equals(part.type) || part.payloadJson == null) continue;
                String value = new JSONObject(part.payloadJson).optString("nextProactiveAt", "");
                long parsed = parseIso(value);
                if (parsed > now) { nextRunAt = parsed; break; }
            }
            boolean hasExplicitSchedule = nextRunAt > now;
            boolean dice = AutomaticTaskContinuationPolicy.useDiceContinuation(previousJob.optString("mode", "planned"), hasExplicitSchedule);
            JSONObject dicePolicy = "dice".equals(previousJob.optString("mode", ""))
                ? previousJob
                : snapshot.optJSONObject("continuationDice");
            if (nextRunAt <= now && dice) {
                if (dicePolicy == null) dicePolicy = new JSONObject();
                long interval = dicePolicy.optLong("intervalMs", dicePolicy.optLong("diceIntervalMs", 60_000L));
                double chance = dicePolicy.optDouble("rollChance", 0.5d);
                int maxRolls = dicePolicy.optInt("maxRolls", 120);
                nextRunAt = now + AutomaticTaskContinuationPolicy.delayMs(interval, chance, maxRolls, Math.random());
            }
            if (nextRunAt <= now) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                continued.edit().putBoolean(continuationKey, true).apply();
                return;
            }

            String prefix = moment ? "mom" : "pro";
            String jobId = prefix + "_" + safeId(deviceId) + "_" + safeId(turn.characterId) + "_native_" + Long.toString(now, 36);
            JSONObject nextJob = new JSONObject();
            nextJob.put("deviceId", deviceId);
            nextJob.put("jobId", jobId);
            nextJob.put("charId", turn.characterId);
            nextJob.put("dueAt", isoTime(nextRunAt));
            nextJob.put("type", "proactive");
            nextJob.put("kind", kind);
            nextJob.put("mode", dice ? "dice" : "planned");
            if (dice) {
                if (dicePolicy == null) dicePolicy = new JSONObject();
                nextJob.put("rollChance", dicePolicy.optDouble("rollChance", 0.5d));
                nextJob.put("diceIntervalMs", dicePolicy.optLong("intervalMs", dicePolicy.optLong("diceIntervalMs", 60_000L)));
                nextJob.put("maxRolls", dicePolicy.optInt("maxRolls", 120));
                nextJob.put("dicePrecomputed", true);
            }
            HttpResponse response = new UrlConnectionTransport().post(
                endpoint + "/schedule",
                Collections.singletonMap("Content-Type", "application/json; charset=utf-8"),
                nextJob.toString()
            );
            if (response.status < 200 || response.status >= 300) {
                if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
                executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "PROACTIVE_RESCHEDULE_FAILED", "status=" + response.status, now);
                return;
            }
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            snapshot.put("cloudJobId", jobId);
            snapshot.put("scheduledFor", nextRunAt);
            snapshot.put("proactiveJob", nextJob);
            snapshot.put("createdAt", isoTime(now));
            persistAutomaticSnapshot(turn, snapshot, kind, jobId, nextRunAt, now);
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            AutomaticTaskAlarmScheduler.schedule(this, jobId, nextRunAt);
            AlExecutionWakeWorker.enqueueAutomatic(this, jobId, nextRunAt);
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            continued.edit().putBoolean(continuationKey, true).apply();
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "INFO", "PROACTIVE_RESCHEDULED", jobId, now);
        } catch (Exception error) {
            if (executionStore.isRoleDeleteTombstoned(turn.characterId)) return;
            executionStore.recordDiagnostic(turn.turnId, turn.activeAttemptId, "WARN", "PROACTIVE_RESCHEDULE_FAILED", error.getMessage(), System.currentTimeMillis());
        }
    }

    private void persistAutomaticSnapshot(ChatTurnEntity turn, JSONObject context, String kind, String jobId, long scheduledFor, long now) throws Exception {
        CharacterSnapshotEntity row = new CharacterSnapshotEntity();
        row.characterId = turn.characterId;
        row.characterName = context.optString("characterName", "AL");
        row.playerName = context.optString("playerName", "我");
        row.systemPrompt = context.optString("chatSystem", "");
        row.momentSystemPrompt = "moment".equals(kind) ? context.optString("chatSystem", "") : "";
        row.contextJson = context.toString();
        row.chatConfigId = context.optString("chatConfigId", "chat-v1");
        row.memoryConfigId = context.optString("memoryConfigId", "memory-v1");
        row.createdAt = now;
        row.scheduledFor = scheduledFor;
        row.automaticKind = kind;
        row.cloudJobId = jobId;
        row.automaticTasksEnabled = true;
        row.jobSnapshot = false;
        row.snapshotId = turn.characterId + ":" + kind;
        database.executionDao().upsertSnapshot(row);
        CharacterSnapshotEntity jobRow = new CharacterSnapshotEntity();
        jobRow.snapshotId = row.snapshotId + ":" + jobId;
        jobRow.characterId = row.characterId;
        jobRow.characterName = row.characterName;
        jobRow.playerName = row.playerName;
        jobRow.systemPrompt = row.systemPrompt;
        jobRow.momentSystemPrompt = row.momentSystemPrompt;
        jobRow.contextJson = row.contextJson;
        jobRow.chatConfigId = row.chatConfigId;
        jobRow.memoryConfigId = row.memoryConfigId;
        jobRow.createdAt = row.createdAt;
        jobRow.scheduledFor = row.scheduledFor;
        jobRow.automaticKind = row.automaticKind;
        jobRow.cloudJobId = row.cloudJobId;
        jobRow.automaticTasksEnabled = true;
        jobRow.jobSnapshot = true;
        database.executionDao().upsertSnapshot(jobRow);
    }

    private static long parseIso(String value) {
        if (value == null || value.trim().isEmpty()) return 0L;
        try {
            java.text.SimpleDateFormat formatter = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", java.util.Locale.US);
            return formatter.parse(value.trim()).getTime();
        } catch (Exception ignored) { return 0L; }
    }

    private void persistRolePlanContinuation(ChatTurnEntity turn, JSONObject snapshot, JSONObject plan, String jobId, long now) throws Exception {
        RolePlanEntity row = new RolePlanEntity();
        row.planId = plan.getString("planId");
        row.characterId = turn.characterId;
        row.status = plan.optString("status", "active");
        row.nextRunAt = plan.has("nextRunAt") && !plan.isNull("nextRunAt") ? plan.optLong("nextRunAt") : null;
        row.updatedAt = now;
        row.planJson = plan.toString();
        database.executionDao().upsertRolePlans(Collections.singletonList(row));
        if (row.nextRunAt != null) RolePlanAlarmScheduler.schedule(this, row.planId, row.nextRunAt);

        snapshot.put("rolePlan", plan);
        snapshot.put("cloudJobId", jobId == null ? "" : jobId);
        String snapshotId = turn.characterId + ":role-plan:" + row.planId;
        CharacterSnapshotEntity stable = database.executionDao().latestSnapshot(snapshotId);
        if (stable != null) {
            stable.contextJson = snapshot.toString();
            stable.createdAt = now;
            database.executionDao().upsertSnapshot(stable);
        }
    }

    private static boolean isRolePlanKind(String kind) {
        return TurnKind.ROLE_PLAN_CHAT.name().equals(kind)
            || TurnKind.ROLE_PLAN_MOMENT.name().equals(kind)
            || TurnKind.ROLE_PLAN_CHAT_PRIVATE.name().equals(kind)
            || TurnKind.ROLE_PLAN_MOMENT_PRIVATE.name().equals(kind);
    }

    private static String safeId(String value) {
        return value == null ? "" : value.trim().replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    private static String isoTime(long value) {
        java.text.SimpleDateFormat formatter = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        formatter.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return formatter.format(new java.util.Date(value));
    }

    private String notificationText(ChatTurnEntity turn) {
        return AlNotificationText.fromParts(database.executionDao().replyParts(turn.turnId));
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
