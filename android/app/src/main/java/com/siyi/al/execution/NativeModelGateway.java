package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.api.OpenAiCompatibleClient;
import com.siyi.al.execution.secure.AlSecretStore;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeRouter;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.function.Supplier;

public final class NativeModelGateway implements TurnBridgeGateway {
    private final AlSecretStore secrets;
    private final OpenAiCompatibleClient client;
    private volatile BridgeRouter bridgeRouter;
    private volatile Supplier<BridgeRouter> bridgeRouterProvider;

    public NativeModelGateway(AlSecretStore secrets, OpenAiCompatibleClient client) {
        this.secrets = secrets;
        this.client = client;
    }

    public void setBridgeRouter(BridgeRouter bridgeRouter) {
        this.bridgeRouter = bridgeRouter;
    }

    public void setBridgeRouterProvider(Supplier<BridgeRouter> provider) {
        this.bridgeRouterProvider = provider;
    }

    private BridgeRouter currentBridgeRouter() {
        Supplier<BridgeRouter> provider = bridgeRouterProvider;
        return provider == null ? bridgeRouter : provider.get();
    }

    @Override
    public boolean hasBridge() {
        BridgeRouter current = currentBridgeRouter();
        return current != null && current.isEnabled();
    }

    @Override
    public String bridgeDeviceId() {
        BridgeRouter current = currentBridgeRouter();
        if (current == null || !current.isEnabled()) {
            throw new IllegalStateException("Bridge router is not configured");
        }
        return current.deviceId();
    }

    @Override
    public BridgeResult executeBridgeTurn(TurnSubmission submission) throws Exception {
        BridgeRouter current = currentBridgeRouter();
        if (current == null) throw new IllegalStateException("Bridge router is not configured");
        return current.execute(submission);
    }

    public BridgeResult executeFallback(TurnSubmission submission) throws Exception {
        JSONObject snapshot = new JSONObject(submission.snapshotJson);
        FallbackCognitionPacketCodec.FallbackContext packet =
            new FallbackCognitionPacketCodec().decode(snapshot);
        if ("cognition-v3".equals(packet.contract)) {
            FallbackCognitionPacketCodec.FallbackExecution execution = packet.fallbackExecution;
            if (execution == null) throw new IllegalArgumentException("missing cognition-v3 fallbackExecution");
            String memory = call(
                execution.cognition.configId,
                execution.cognition.system,
                execution.cognition.messages,
                1400
            );
            String rawReply = call(
                execution.expression.configId,
                execution.expression.system + "\n\n【临时认知结果】\n" + (memory == null ? "" : memory),
                execution.expression.messages,
                1000
            );
            return BridgeResult.success("fallback", rawReply);
        }
        String packetType = snapshot.optString("packetType", "");
        boolean cognitionV2 = "cognition-v2".equals(packetType);
        if (!packetType.isEmpty() && !cognitionV2) {
            throw new IllegalArgumentException("UNSUPPORTED_FALLBACK_PACKET: " + packetType);
        }
        String cognitionConfigId = cognitionV2
            ? snapshot.optString("cognitionConfigId", snapshot.optString("memoryConfigId", ""))
            : snapshot.getString("memoryConfigId");
        String cognitionSystem = cognitionV2
            ? snapshot.optString("cognitionSystem", snapshot.optString("memorySystem", ""))
            : snapshot.getString("memorySystem");
        JSONArray cognitionMessages = cognitionV2
            ? snapshot.optJSONArray("cognitionMessages")
            : snapshot.optJSONArray("memoryMessages");
        String memory = call(
            cognitionConfigId,
            cognitionSystem,
            cognitionMessages == null ? new JSONArray() : cognitionMessages,
            snapshot.optInt("memoryMaxTokens", 1400)
        );
        JSONArray allMessages = cognitionV2
            ? snapshot.optJSONArray("expressionMessages")
            : snapshot.optJSONArray("chatMessages");
        JSONArray selected = new JSONArray();
        if (allMessages != null) {
            int start = Math.max(0, allMessages.length() - 200);
            for (int index = start; index < allMessages.length(); index += 1) selected.put(allMessages.opt(index));
        }
        String expressionConfigId = cognitionV2
            ? snapshot.optString("expressionConfigId", snapshot.optString("chatConfigId", ""))
            : snapshot.getString("chatConfigId");
        String expressionSystem = cognitionV2
            ? snapshot.optString("expressionSystem", snapshot.optString("chatSystem", ""))
            : snapshot.getString("chatSystem");
        String rawReply = call(
            expressionConfigId,
            expressionSystem + "\n\n【临时认知结果】\n" + (memory == null ? "" : memory),
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
