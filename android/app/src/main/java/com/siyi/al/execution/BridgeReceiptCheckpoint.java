package com.siyi.al.execution;

import org.json.JSONObject;

final class BridgeReceiptCheckpoint {
    private BridgeReceiptCheckpoint() {}

    static JSONObject extract(String memoryResult) {
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
}
