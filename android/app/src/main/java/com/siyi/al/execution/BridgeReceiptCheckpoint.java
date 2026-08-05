package com.siyi.al.execution;

import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;

public final class BridgeReceiptCheckpoint {
    private static final Set<String> AUTHORITY_CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome"));
    private static final Set<String> AUTHORITY_OUTCOME_KEYS = new HashSet<>(Arrays.asList(
        "type", "route", "relayMessageId", "failure", "result", "redactedAt"));

    private BridgeReceiptCheckpoint() {}

    public static boolean mayReadLegacyMemoryResult(Integer bridgeProtocolVersion) {
        return bridgeProtocolVersion == null || bridgeProtocolVersion != 3;
    }

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

    public static JSONObject extractAuthorityReceiptFromV12Checkpoint(
        String checkpointJson,
        String checkpointChecksum
    ) {
        if (checkpointJson == null || checkpointChecksum == null) return null;
        try {
            JSONObject checkpoint = new JSONObject(checkpointJson);
            Object version = checkpoint.opt("version");
            if (!AUTHORITY_CHECKPOINT_KEYS.equals(keysOf(checkpoint))
                || !(version instanceof Number)
                || version instanceof Float
                || version instanceof Double
                || ((Number) version).longValue() != 1L
                || !checkpointChecksum.equals(BridgeAuthority.sha256CanonicalJson(checkpoint))) {
                return null;
            }
            JSONObject outcome = checkpoint.optJSONObject("outcome");
            if (outcome == null
                || !AUTHORITY_OUTCOME_KEYS.equals(keysOf(outcome))
                || !"committed".equals(outcome.opt("type"))
                || outcome.opt("failure") != JSONObject.NULL
                || outcome.opt("redactedAt") != JSONObject.NULL) {
                return null;
            }
            Object routeValue = outcome.opt("route");
            if (!(routeValue instanceof String)) return null;
            String route = (String) routeValue;
            Object relayValue = outcome.opt("relayMessageId");
            String relay = relayValue == JSONObject.NULL
                ? null : requireNonEmptyString(outcome, "relayMessageId");
            if (!("lan".equals(route) || "cloud".equals(route))
                || ("lan".equals(route) && relay != null)
                || ("cloud".equals(route) && relay == null)) {
                return null;
            }
            JSONObject resultJson = outcome.optJSONObject("result");
            if (resultJson == null) return null;
            BridgeResult result = BridgeTurnStatus.parseV3(
                BridgeAuthority.canonicalJson(resultJson), route, relay);
            if (result.kind != BridgeResult.Kind.CANONICAL_TERMINAL) return null;
            JSONObject extracted = result.authorityPayload();
            extracted.put("_deliveryRoute", route);
            if (relay != null) extracted.put("_relayMessageId", relay);
            return extracted;
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

    private static Set<String> keysOf(JSONObject value) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }
}
