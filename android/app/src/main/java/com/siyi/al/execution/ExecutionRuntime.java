package com.siyi.al.execution;

import android.content.Context;
import androidx.core.app.NotificationManagerCompat;
import com.siyi.al.execution.api.OpenAiCompatibleClient;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.api.UrlConnectionTransport;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.secure.AlSecretStore;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeRouter;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.bridge.FallbackJournal;
import com.siyi.al.execution.bridge.RoomBridgeMirror;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

public final class ExecutionRuntime {
    public static final class ReconcileResult {
        public enum Status { RECOVERED, NOOP, RETRYABLE, CONFLICT }
        public final Status status;
        public final int requeued;
        private ReconcileResult(Status status, int requeued) {
            this.status = status;
            this.requeued = requeued;
        }
        public static ReconcileResult recovered(int count) {
            return new ReconcileResult(Status.RECOVERED, count);
        }
        public static ReconcileResult noop() { return new ReconcileResult(Status.NOOP, 0); }
        public static ReconcileResult retryable() { return new ReconcileResult(Status.RETRYABLE, 0); }
        public static ReconcileResult conflict() { return new ReconcileResult(Status.CONFLICT, 0); }
        public boolean shouldRetry() { return status == Status.RETRYABLE; }
    }
    private static AutomaticScheduleSender automaticScheduleSender;
    private static String automaticScheduleEndpoint = "";
    private ExecutionRuntime() {}

    static ExecutionEngine create(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        drainRoleNotificationCancellations(context, database);
        AlSecretStore secrets = new AlSecretStore(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        NativeModelGateway gateway = new NativeModelGateway(
            secrets,
            new OpenAiCompatibleClient(new UrlConnectionTransport())
        );
        gateway.setBridgeRouterProvider(() -> {
            BridgeConfig bridgeConfig = secrets.loadBridgeConfig();
            RoomExecutionStore bridgeStore = new RoomExecutionStore(database, bridgeConfig.deviceId);
            FallbackJournal fallbackJournal = new FallbackJournal(database.executionDao(), bridgeConfig.deviceId);
            RoomBridgeMirror mirror = new RoomBridgeMirror(
                database.executionDao(), bridgeStore, bridgeConfig.deviceId);
            BridgeClient bridgeClient = new BridgeClient(
                bridgeConfig,
                fallbackJournal,
                (turnId, raw) -> store.recordBridgeStatusIfActive(
                    turnId, raw, System.currentTimeMillis()
                ),
                cloudInboxConsumer(mirror, bridgeStore, bridgeConfig.deviceId)
            );
            return new BridgeRouter(
                bridgeConfig,
                bridgeClient.lanRoute(),
                bridgeClient.cloudRoute(),
                gateway::executeFallback,
                mirror
            );
        });
        return new ExecutionEngine(store, gateway, new ReplyParser(), System::currentTimeMillis);
    }

    static int drainCloudInbox(Context context) throws Exception {
        return drainCloudInboxInternal(context, null, null);
    }

    static synchronized AutomaticScheduleSender createAutomaticScheduleSender(
        Context context, AlExecutionDatabase database
    ) {
        BridgeConfig config = new AlSecretStore(context).loadBridgeConfig();
        if (!config.hasCloud()) return null;
        String endpoint = config.cloudUrl.replaceAll("/+$", "") + "/v2/schedule-transitions";
        if (automaticScheduleSender == null || !endpoint.equals(automaticScheduleEndpoint)) {
            automaticScheduleSender = new AutomaticScheduleSender(
                database, new UrlConnectionTransport(), endpoint, System::currentTimeMillis);
            automaticScheduleEndpoint = endpoint;
        }
        return automaticScheduleSender;
    }

    static int drainAutomaticScheduleOutbox(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        AutomaticScheduleSender sender = createAutomaticScheduleSender(context, database);
        if (sender == null) return 0;
        sender.recoverExpiredLeases(System.currentTimeMillis());
        int completed = 0;
        for (int index = 0; index < 16; index += 1) {
            AutomaticScheduleSender.Outcome outcome = sender.flushOne(System.currentTimeMillis());
            if (outcome == AutomaticScheduleSender.Outcome.SYNCED
                || outcome == AutomaticScheduleSender.Outcome.QUARANTINED) {
                completed += 1;
                continue;
            }
            break;
        }
        return completed;
    }

    public static int reconcileRemotePausedSchedules(Context context) {
        return reconcileRemotePausedSchedulesResult(context).requeued;
    }

    public static ReconcileResult reconcileRemotePausedSchedulesResult(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        AutomaticScheduleSender sender = createAutomaticScheduleSender(context, database);
        if (sender == null) return ReconcileResult.noop();
        RoomExecutionStore store = new RoomExecutionStore(database);
        int requeued = 0;
        int conflicts = 0;
        int retryable = 0;
        long now = System.currentTimeMillis();
        for (com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority
                : database.executionDao().scheduledAutomaticScheduleAuthorities()) {
            try {
                AutomaticScheduleSender.RemoteScheduleStatus remote = sender.fetchStatus(authority);
                RoomExecutionStore.RemoteReconcileResult outcome =
                    store.reconcileRemotePausedScheduleIfExact(remote, now);
                if (outcome == RoomExecutionStore.RemoteReconcileResult.RECOVERED) requeued += 1;
                if (outcome == RoomExecutionStore.RemoteReconcileResult.CONFLICT) conflicts += 1;
            } catch (RuntimeException error) {
                retryable += 1;
            }
        }
        if (retryable > 0) return ReconcileResult.retryable();
        if (conflicts > 0) return ReconcileResult.conflict();
        if (requeued > 0) return ReconcileResult.recovered(requeued);
        return ReconcileResult.noop();
    }


    /** Return the next authority-outbox wake delay in seconds, or -1 when none/config absent. */
    static long nextAutomaticScheduleDelay(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        AutomaticScheduleSender sender = createAutomaticScheduleSender(context, database);
        if (sender == null) return -1L;
        long delayMs = sender.nextDelayMs(System.currentTimeMillis());
        if (delayMs == Long.MAX_VALUE) return -1L;
        return delayMs <= 0L ? 0L : Math.max(1L, (delayMs + 999L) / 1000L);
    }

    /** Test-only ingress seam: transport is injected, while config/journal/mirror/consumer stay real. */
    static int drainCloudInboxForTesting(
        Context context, BridgeClient.Transport transport, AtomicInteger persistCalls
    ) throws Exception {
        if (transport == null) throw new IllegalArgumentException("cloud transport required");
        return drainCloudInboxInternal(context, transport, persistCalls);
    }

    private static int drainCloudInboxInternal(
        Context context, BridgeClient.Transport transport, AtomicInteger persistCalls
    ) throws Exception {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        drainRoleNotificationCancellations(context, database);
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        if (!config.hasCloud()) return 0;
        FallbackJournal journal = new FallbackJournal(database.executionDao(), config.deviceId);
        RoomExecutionStore store = new RoomExecutionStore(database, config.deviceId);
        RoomBridgeMirror mirror = new RoomBridgeMirror(database.executionDao(), store, config.deviceId);
        BridgeClient.CloudInboxConsumer consumer = cloudInboxConsumer(mirror, store, config.deviceId);
        if (persistCalls != null) {
            BridgeClient.CloudInboxConsumer delegate = consumer;
            consumer = new BridgeClient.CloudInboxConsumer() {
                @Override public boolean persist(String raw) throws Exception {
                    persistCalls.incrementAndGet();
                    return delegate.persist(raw);
                }
                @Override public void recordRejected(String relayMessageId, String reason, long now)
                    throws Exception {
                    delegate.recordRejected(relayMessageId, reason, now);
                }
                @Override public boolean applyLifecycleControl(
                    String raw, String relayMessageId, Long relayExpiresAt, long now
                ) throws Exception {
                    return delegate.applyLifecycleControl(raw, relayMessageId, relayExpiresAt, now);
                }
            };
        }
        BridgeClient client = transport == null
            ? new BridgeClient(config, journal, null, consumer)
            : BridgeClient.forTestingTransport(config, journal, transport, consumer);
        return client.drainCloudInbox();
    }

    static boolean drainLifecycleControl(Context context) throws Exception {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        drainRoleNotificationCancellations(context, database);
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        if (!config.enabled) return false;
        RoomExecutionStore store = new RoomExecutionStore(database, config.deviceId);
        BridgeClient client = new BridgeClient(config);
        boolean lan = (config.mode == BridgeMode.AUTO || config.mode == BridgeMode.LAN)
            && config.hasLan();
        boolean cloud = (config.mode == BridgeMode.CLOUD || config.mode == BridgeMode.AUTO)
            && config.hasCloud();
        if (config.mode == BridgeMode.AUTO) {
            return LifecycleControlSender.drainOneAuto(
                store,
                lan ? client.lifecycleControlRoute(false) : null,
                cloud ? client.lifecycleControlRoute(true) : null,
                System.currentTimeMillis());
        }
        if (lan) {
            return LifecycleControlSender.drainOne(
                store, client.lifecycleControlRoute(false), false, System.currentTimeMillis());
        }
        if (cloud) {
            return LifecycleControlSender.drainOne(
                store, client.lifecycleControlRoute(true), true, System.currentTimeMillis());
        }
        return false;
    }

    private static int drainRoleNotificationCancellations(
        Context context, AlExecutionDatabase database
    ) {
        Context app = context.getApplicationContext();
        RoomExecutionStore store = new RoomExecutionStore(database);
        return store.drainPendingRoleNotificationCancellations(
            notificationId -> NotificationManagerCompat.from(app).cancel(notificationId));
    }

    /** Return the next store-owned lifecycle wake delay in seconds, or -1 when none is due. */
    static long nextLifecycleDelay(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        long now = System.currentTimeMillis();
        return nextLifecycleDelayForControls(store.lifecycleControls(), now);
    }

    static long nextLifecycleDelayForControls(
        java.util.List<LifecycleControl> controls, long now
    ) {
        long next = Long.MAX_VALUE;
        if (controls == null) return -1L;
        for (LifecycleControl control : controls) {
            if (!LifecycleControl.CLEAR_KIND.equals(control.controlKind)
                && !LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind)) continue;
            long candidate = LifecycleControlSender.nextEligibleAt(control, now);
            if (candidate < next) next = candidate;
        }
        if (next == Long.MAX_VALUE) return -1L;
        if (next <= now) return 0L;
        long millis = next - now;
        return Math.max(1L, (millis + 999L) / 1000L);
    }

    private static BridgeClient.CloudInboxConsumer cloudInboxConsumer(
        RoomBridgeMirror mirror, RoomExecutionStore store, String verifiedPeerId
    ) {
        return new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) throws Exception {
                return mirror.persistCloudInboxReply(raw);
            }

            @Override public void recordRejected(
                String relayMessageId, String reason, long now
            ) {
                mirror.recordCanonicalCloudRejection(relayMessageId, reason, now);
            }

            @Override public boolean applyLifecycleControl(
                String raw, String relayMessageId, Long relayExpiresAt, long now
            ) throws Exception {
                JSONObject ack = new JSONObject(raw == null ? "{}" : raw);
                try {
                    LifecycleControlSender.validateAppliedAckShape(ack);
                } catch (IllegalArgumentException invalid) {
                    return false;
                }
                if (verifiedPeerId == null || verifiedPeerId.trim().isEmpty()
                    || !verifiedPeerId.equals(ack.optString("peerId", ""))
                    || !LifecycleControlSender.validInboundRelayMessageId(relayMessageId)
                    || relayExpiresAt == null
                    || !LifecycleControlSender.validRelayExpiry(now, relayExpiresAt)) {
                    throw new IllegalArgumentException("lifecycle applied ACK authority conflict");
                }
                String controlId = ack.optString("controlId", "").trim();
                LifecycleControl control = store.lifecycleControl(controlId);
                if (control == null) {
                    try {
                        return store.recordUnknownLifecycleAckTerminal(
                            verifiedPeerId, relayMessageId, relayExpiresAt,
                            ack.getString("controlId"), ack.getString("controlChecksum"),
                            ack.getString("checksum"), now);
                    } catch (IllegalArgumentException conflict) {
                        return false;
                    }
                }
                if ((!LifecycleControl.CLEAR_KIND.equals(control.controlKind)
                    && !LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind))
                    || relayMessageId == null || relayExpiresAt == null) return false;
                try {
                    LifecycleControlSender.validateAppliedAck(ack, control);
                    boolean roleDelete = LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind);
                    return store.applyLifecycleControl(
                        control.controlId, control.semanticChecksum,
                        roleDelete ? null : nullableLong(ack.opt("clearEpoch")),
                        roleDelete ? null : nullableLong(ack.opt("clearedThroughSequence")),
                        ack.getLong("appliedAt"), now, relayMessageId);
                } catch (IllegalArgumentException conflict) {
                    if (!LifecycleControlSender.isAppliedAckConflict(conflict)) throw conflict;
                    if (store.recordLifecycleAppliedAckConflict(
                        control.controlId,
                        control.semanticChecksum,
                        LifecycleControlSender.appliedAckConflictChecksum(ack),
                        relayMessageId,
                        now)) {
                        return true;
                    }
                    return store.quarantineLifecycleRelayAcceptedExact(
                        control.controlId, control.semanticChecksum,
                        control.relayMessageId, control.relayExpiresAt,
                        relayMessageId,
                        LifecycleControlSender.appliedAckConflictChecksum(ack),
                        now);
                }
            }
        };
    }

    private static Long nullableLong(Object value) {
        if (value == null || JSONObject.NULL.equals(value)) return null;
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) {
            throw new IllegalArgumentException("lifecycle applied integer conflict");
        }
        return ((Number) value).longValue();
    }

    static boolean confirmAppliedResult(Context context, String responseJson) throws Exception {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        FallbackJournal journal = new FallbackJournal(database.executionDao(), config.deviceId);
        return new BridgeClient(config, journal).confirmAppliedResult(responseJson);
    }
}
