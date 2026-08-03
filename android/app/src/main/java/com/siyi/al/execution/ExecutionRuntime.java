package com.siyi.al.execution;

import android.content.Context;
import com.siyi.al.execution.api.OpenAiCompatibleClient;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.api.UrlConnectionTransport;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.secure.AlSecretStore;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeRouter;
import com.siyi.al.execution.bridge.FallbackJournal;
import com.siyi.al.execution.bridge.RoomBridgeMirror;

final class ExecutionRuntime {
    private ExecutionRuntime() {}

    static ExecutionEngine create(Context context) {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        AlSecretStore secrets = new AlSecretStore(context);
        NativeModelGateway gateway = new NativeModelGateway(
            secrets,
            new OpenAiCompatibleClient(new UrlConnectionTransport())
        );
        gateway.setBridgeRouterProvider(() -> {
            BridgeConfig bridgeConfig = secrets.loadBridgeConfig();
            FallbackJournal fallbackJournal = new FallbackJournal(database.executionDao(), bridgeConfig.deviceId);
            RoomBridgeMirror mirror = new RoomBridgeMirror(
                database.executionDao(), store, bridgeConfig.deviceId);
            BridgeClient bridgeClient = new BridgeClient(
                bridgeConfig,
                fallbackJournal,
                (turnId, raw) -> store.recordDiagnostic(
                    turnId, null, "INFO", "BRIDGE_STATUS", raw, System.currentTimeMillis()
                ),
                cloudInboxConsumer(mirror)
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
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        if (!config.hasCloud()) return 0;
        FallbackJournal journal = new FallbackJournal(database.executionDao(), config.deviceId);
        RoomExecutionStore store = new RoomExecutionStore(database);
        RoomBridgeMirror mirror = new RoomBridgeMirror(database.executionDao(), store, config.deviceId);
        BridgeClient client = new BridgeClient(config, journal, null, cloudInboxConsumer(mirror));
        return client.drainCloudInbox();
    }

    private static BridgeClient.CloudInboxConsumer cloudInboxConsumer(RoomBridgeMirror mirror) {
        return new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) throws Exception {
                return mirror.persistCloudInboxReply(raw);
            }

            @Override public void recordRejected(
                String relayMessageId, String reason, long now
            ) {
                mirror.recordCanonicalCloudRejection(relayMessageId, reason, now);
            }
        };
    }

    static boolean confirmAppliedResult(Context context, String responseJson) throws Exception {
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        AlSecretStore secrets = new AlSecretStore(context);
        BridgeConfig config = secrets.loadBridgeConfig();
        FallbackJournal journal = new FallbackJournal(database.executionDao(), config.deviceId);
        return new BridgeClient(config, journal).confirmAppliedResult(responseJson);
    }
}
