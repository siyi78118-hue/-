package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.api.OpenAiCompatibleClient;
import com.siyi.al.execution.secure.AlSecretStore;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeRouter;
import org.json.JSONArray;
import org.json.JSONObject;

public final class NativeModelGateway implements TurnBridgeGateway {
    private final AlSecretStore secrets;
    private final OpenAiCompatibleClient client;
    private volatile BridgeRouter bridgeRouter;

    public NativeModelGateway(AlSecretStore secrets, OpenAiCompatibleClient client) {
        this.secrets = secrets;
        this.client = client;
    }

    public void setBridgeRouter(BridgeRouter bridgeRouter) {
        this.bridgeRouter = bridgeRouter;
    }

    @Override
    public boolean hasBridge() {
        BridgeRouter current = bridgeRouter;
        return current != null && current.isEnabled();
    }

    @Override
    public BridgeResult executeBridgeTurn(TurnSubmission submission) throws Exception {
        BridgeRouter current = bridgeRouter;
        if (current == null) throw new IllegalStateException("Bridge router is not configured");
        return current.execute(submission);
    }

    public BridgeResult executeFallback(TurnSubmission submission) throws Exception {
        JSONObject snapshot = new JSONObject(submission.snapshotJson);
        String memory = call(
            snapshot.getString("memoryConfigId"),
            snapshot.getString("memorySystem"),
            snapshot.optJSONArray("memoryMessages") == null ? new JSONArray() : snapshot.getJSONArray("memoryMessages"),
            snapshot.optInt("memoryMaxTokens", 1400)
        );
        JSONArray allMessages = snapshot.optJSONArray("chatMessages");
        JSONArray selected = new JSONArray();
        if (allMessages != null) {
            int start = Math.max(0, allMessages.length() - 200);
            for (int index = start; index < allMessages.length(); index += 1) selected.put(allMessages.opt(index));
        }
        String rawReply = call(
            snapshot.getString("chatConfigId"),
            snapshot.getString("chatSystem") + "\n\n【临时记忆筛选结果】\n" + (memory == null ? "" : memory),
            selected,
            snapshot.optInt("chatMaxTokens", 1000)
        );
        return BridgeResult.success("fallback", rawReply);
    }

    @Override
    public String call(String configId, String system, JSONArray messages, int maxTokens) throws Exception {
        ApiConfig config = secrets.loadApiConfig(configId);
        if (config == null) throw new IllegalStateException("Missing API configuration: " + configId);
        return client.call(config, system, messages, maxTokens);
    }
}
