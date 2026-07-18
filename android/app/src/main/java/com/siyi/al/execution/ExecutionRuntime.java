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
        BridgeConfig bridgeConfig = secrets.loadBridgeConfig();
        BridgeClient bridgeClient = new BridgeClient(bridgeConfig);
        gateway.setBridgeRouter(new BridgeRouter(
            bridgeConfig,
            bridgeClient.lanRoute(),
            bridgeClient.cloudRoute(),
            gateway::executeFallback,
            new RoomBridgeMirror(database.executionDao(), bridgeConfig.deviceId)
        ));
        return new ExecutionEngine(store, gateway, new ReplyParser(), System::currentTimeMillis);
    }
}
