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
import org.json.JSONObject;

final class ExecutionRuntime {
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
                (turnId, raw) -> store.recordDiagnostic(
                    turnId, null, "INFO", "BRIDGE_STATUS", raw, System.currentTimeMillis()
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
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        drainRoleNotificationCancellations(context, database);
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        if (!config.hasCloud()) return 0;
        FallbackJournal journal = new FallbackJournal(database.executionDao(), config.deviceId);
        RoomExecutionStore store = new RoomExecutionStore(database, config.deviceId);
        RoomBridgeMirror mirror = new RoomBridgeMirror(database.executionDao(), store, config.deviceId);
        BridgeClient client = new BridgeClient(config, journal, null, cloudInboxConsumer(mirror, store, config.deviceId));
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
