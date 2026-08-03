package com.siyi.al.execution;

import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import org.json.JSONObject;

public final class BridgeReceiptCheckpoint {
    private BridgeReceiptCheckpoint() {}

    public static JSONObject extract(String memoryResult) {
        if (memoryResult == null || !memoryResult.trim().startsWith("{")) return null;
        try {
            JSONObject checkpoint = new JSONObject(memoryResult);
            Object value = checkpoint.opt("bridgeResponse");
            JSONObject response;
            if (value instanceof JSONObject) {
                response = (JSONObject) value;
            } else if (value instanceof String && ((String) value).trim().startsWith("{")) {
                response = new JSONObject((String) value);
            } else {
                return null;
            }
            Object protocolVersion = response.opt("protocolVersion");
            if (protocolVersion instanceof Number
                    && !(protocolVersion instanceof Float)
                    && !(protocolVersion instanceof Double)
                    && ((Number) protocolVersion).longValue() == 3L) {
                JSONObject semantic = new JSONObject(response.toString());
                String route = semantic.has("_deliveryRoute")
                    ? requireNonEmptyString(semantic, "_deliveryRoute")
                    : requireNonEmptyString(checkpoint, "origin");
                String relayMessageId = semantic.has("_relayMessageId")
                    ? requireNonEmptyString(semantic, "_relayMessageId")
                    : null;
                semantic.remove("_deliveryRoute");
                semantic.remove("_relayMessageId");
                BridgeResult result = BridgeTurnStatus.parseV3(
                    semantic.toString(), route, relayMessageId);
                if (result.kind != BridgeResult.Kind.CANONICAL_TERMINAL) return null;
                JSONObject extracted = result.authorityPayload();
                extracted.put("_deliveryRoute", result.deliveryRoute);
                if (result.relayMessageId != null) {
                    extracted.put("_relayMessageId", result.relayMessageId);
                }
                return extracted;
            }
            if (response.has("protocolVersion")) return null;
            if (!response.has("deliveryItems")
                    && response.optString("_relayMessageId", "").trim().isEmpty()) return null;
            if (!response.has("_deliveryRoute")) {
                response.put("_deliveryRoute", checkpoint.optString("origin", ""));
            }
            return response;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String requireNonEmptyString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("bridge checkpoint " + key + " conflict");
        }
        return (String) raw;
    }
}
