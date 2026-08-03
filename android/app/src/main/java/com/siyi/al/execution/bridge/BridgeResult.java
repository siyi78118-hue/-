package com.siyi.al.execution.bridge;

import com.siyi.al.execution.BridgeAuthority;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Immutable result boundary shared by LAN and encrypted cloud bridge inputs. */
public final class BridgeResult {
    public enum Kind {
        LEGACY_V2,
        CANONICAL_TERMINAL,
        VERIFIED_REMOTE_FAILURE
    }

    public final Kind kind;
    public final String origin;
    public final String replyText;
    public final String responseJson;
    public final List<String> attemptedRoutes;
    public final boolean fallback;
    public final boolean skipped;
    public final String paymentStatus;
    public final String relationshipStageActionJson;
    public final String momentActionJson;
    public final String rolePlanOperationsJson;
    public final String lifeAdjustmentJson;

    public final int protocolVersion;
    public final String authoritativeTurnId;
    public final String roleId;
    public final String authorityOrigin;
    public final String authorityLineageKey;
    public final String visibleGroupId;
    public final long lineageRevision;
    public final long turnRevision;
    public final String laneKey;
    public final long laneRevision;
    public final long inputVisibilitySequence;
    public final long inputClearEpoch;
    public final String generationFingerprint;
    public final String releaseId;
    public final String commitPayloadVersion;
    public final String commitChecksum;
    public final String terminalDisposition;
    public final List<String> replyPartsJson;
    public final List<String> actionsJson;

    public final String retryOfTurnId;
    public final String failureClass;
    public final boolean retryAllowed;
    public final String errorCode;
    public final long failedAt;
    public final String rawStatusChecksum;

    public final String authorityPayloadJson;
    public final String deliveryRoute;
    public final String relayMessageId;

    private BridgeResult(
        String origin, String replyText, String responseJson, List<String> attemptedRoutes,
        boolean fallback, boolean skipped, String paymentStatus,
        String relationshipStageActionJson, String momentActionJson,
        String rolePlanOperationsJson
    ) {
        this(origin, replyText, responseJson, attemptedRoutes, fallback, skipped, paymentStatus,
            relationshipStageActionJson, momentActionJson, rolePlanOperationsJson, "",
            Collections.emptyList(), Collections.emptyList());
    }

    private BridgeResult(
        String origin, String replyText, String responseJson, List<String> attemptedRoutes,
        boolean fallback, boolean skipped, String paymentStatus,
        String relationshipStageActionJson, String momentActionJson,
        String rolePlanOperationsJson, String lifeAdjustmentJson,
        List<String> replyPartsJson, List<String> actionsJson
    ) {
        this.kind = Kind.LEGACY_V2;
        this.origin = origin == null ? "" : origin;
        this.replyText = replyText == null ? "" : replyText;
        this.responseJson = responseJson == null ? "{}" : responseJson;
        this.attemptedRoutes = immutableStrings(attemptedRoutes);
        this.fallback = fallback;
        this.skipped = skipped;
        this.paymentStatus = normalized(paymentStatus);
        this.relationshipStageActionJson = normalized(relationshipStageActionJson);
        this.momentActionJson = normalized(momentActionJson);
        this.rolePlanOperationsJson = normalized(rolePlanOperationsJson);
        this.lifeAdjustmentJson = normalized(lifeAdjustmentJson);

        this.protocolVersion = 2;
        this.authoritativeTurnId = null;
        this.roleId = null;
        this.authorityOrigin = null;
        this.authorityLineageKey = null;
        this.visibleGroupId = null;
        this.lineageRevision = -1L;
        this.turnRevision = -1L;
        this.laneKey = null;
        this.laneRevision = -1L;
        this.inputVisibilitySequence = -1L;
        this.inputClearEpoch = -1L;
        this.generationFingerprint = null;
        this.releaseId = null;
        this.commitPayloadVersion = null;
        this.commitChecksum = null;
        this.terminalDisposition = null;
        this.replyPartsJson = immutableStrings(replyPartsJson);
        this.actionsJson = immutableStrings(actionsJson);
        this.retryOfTurnId = null;
        this.failureClass = null;
        this.retryAllowed = false;
        this.errorCode = null;
        this.failedAt = -1L;
        this.rawStatusChecksum = null;
        this.authorityPayloadJson = null;
        this.deliveryRoute = null;
        this.relayMessageId = null;
    }

    private BridgeResult(
        Kind kind, JSONObject payload, String rawResponse, String route, String relayMessageId,
        List<String> replyPartsJson, List<String> actionsJson, String replyText
    ) {
        this.kind = kind;
        this.origin = route;
        this.replyText = replyText;
        this.responseJson = rawResponse;
        this.attemptedRoutes = Collections.singletonList(route);
        this.fallback = false;
        this.skipped = kind == Kind.CANONICAL_TERMINAL
            && "skip".equals(payload.optString("terminalDisposition", ""));
        this.paymentStatus = "";
        this.relationshipStageActionJson = "";
        this.momentActionJson = "";
        this.rolePlanOperationsJson = "";
        this.lifeAdjustmentJson = "";

        this.protocolVersion = 3;
        this.authoritativeTurnId = payload.optString("turnId", null);
        this.roleId = payload.optString("roleId", null);
        this.authorityOrigin = nullableString(payload, "authorityOrigin");
        this.authorityLineageKey = payload.optString("authorityLineageKey", null);
        this.visibleGroupId = nullableString(payload, "visibleGroupId");
        this.lineageRevision = payload.optLong("lineageRevision", -1L);
        this.turnRevision = payload.optLong("turnRevision", -1L);
        this.laneKey = payload.optString("laneKey", null);
        this.laneRevision = payload.optLong("laneRevision", -1L);
        this.inputVisibilitySequence = payload.optLong("inputVisibilitySequence", -1L);
        this.inputClearEpoch = payload.optLong("inputClearEpoch", -1L);
        this.generationFingerprint = nullableString(payload, "generationFingerprint");
        this.releaseId = payload.optString("releaseId", null);
        this.commitPayloadVersion = nullableString(payload, "commitPayloadVersion");
        this.commitChecksum = nullableString(payload, "commitChecksum");
        this.terminalDisposition = nullableString(payload, "terminalDisposition");
        this.replyPartsJson = immutableStrings(replyPartsJson);
        this.actionsJson = immutableStrings(actionsJson);

        this.retryOfTurnId = nullableString(payload, "retryOfTurnId");
        this.failureClass = nullableString(payload, "failureClass");
        this.retryAllowed = payload.opt("retryAllowed") instanceof Boolean
            && (Boolean) payload.opt("retryAllowed");
        this.errorCode = nullableString(payload, "errorCode");
        this.failedAt = payload.optLong("failedAt", -1L);
        this.rawStatusChecksum = nullableString(payload, "rawStatusChecksum");

        this.authorityPayloadJson = BridgeAuthority.canonicalJson(payload);
        this.deliveryRoute = route;
        this.relayMessageId = relayMessageId;
    }

    static BridgeResult canonicalTerminal(
        JSONObject payload, String rawResponse, String route, String relayMessageId
    ) {
        try {
            JSONArray parts = payload.getJSONArray("replyParts");
            JSONArray actions = payload.getJSONArray("actions");
            List<String> partJson = canonicalElements(parts);
            List<String> actionJson = canonicalElements(actions);
            List<String> text = new ArrayList<>();
            for (int index = 0; index < parts.length(); index += 1) {
                text.add(parts.getJSONObject(index).getString("content"));
            }
            return new BridgeResult(
                Kind.CANONICAL_TERMINAL, payload, rawResponse, route, relayMessageId,
                partJson, actionJson, String.join("\n", text));
        } catch (Exception error) {
            throw new IllegalArgumentException("canonical bridge result projection conflict", error);
        }
    }

    static BridgeResult verifiedRemoteFailure(
        JSONObject payload, String rawResponse, String route, String relayMessageId
    ) {
        return new BridgeResult(
            Kind.VERIFIED_REMOTE_FAILURE, payload, rawResponse, route, relayMessageId,
            Collections.emptyList(), Collections.emptyList(), "");
    }

    static BridgeResult structuredLegacy(
        String origin, String replyText, String responseJson, boolean skipped,
        String paymentStatus, String relationshipStageActionJson, String momentActionJson,
        String rolePlanOperationsJson, String lifeAdjustmentJson,
        List<String> replyPartsJson, List<String> actionsJson
    ) {
        return new BridgeResult(
            origin, replyText, responseJson, Collections.singletonList(origin), false, skipped,
            paymentStatus, relationshipStageActionJson, momentActionJson, rolePlanOperationsJson,
            lifeAdjustmentJson,
            replyPartsJson, actionsJson);
    }

    public JSONObject authorityPayload() {
        try {
            return authorityPayloadJson == null ? null : new JSONObject(authorityPayloadJson);
        } catch (Exception error) {
            throw new IllegalStateException("stored bridge authority payload is invalid", error);
        }
    }

    public static BridgeResult success(String origin, String replyText) {
        return new BridgeResult(origin, replyText, "{}", Collections.singletonList(origin), "fallback".equals(origin), false, "", "", "", "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, "", "", "", "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson, String paymentStatus) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, paymentStatus, "", "", "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson, String paymentStatus, String relationshipStageActionJson, String momentActionJson) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, paymentStatus, relationshipStageActionJson, momentActionJson, "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson, String paymentStatus, String relationshipStageActionJson, String momentActionJson, String rolePlanOperationsJson) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, paymentStatus, relationshipStageActionJson, momentActionJson, rolePlanOperationsJson);
    }

    public static BridgeResult skipped(String origin, String responseJson) {
        return new BridgeResult(origin, "", responseJson, Collections.singletonList(origin), false, true, "", "", "", "");
    }

    BridgeResult routed(List<String> routes, boolean usedFallback) {
        if (kind != Kind.LEGACY_V2) {
            if (usedFallback) throw new IllegalStateException("v3 bridge authority cannot use fallback");
            return this;
        }
        return new BridgeResult(origin, replyText, responseJson, routes, usedFallback, skipped, paymentStatus, relationshipStageActionJson, momentActionJson, rolePlanOperationsJson, lifeAdjustmentJson, replyPartsJson, actionsJson);
    }

    private static List<String> canonicalElements(JSONArray value) {
        try {
            List<String> output = new ArrayList<>();
            for (int index = 0; index < value.length(); index += 1) {
                output.add(BridgeAuthority.canonicalJson(value.get(index)));
            }
            return immutableStrings(output);
        } catch (Exception error) {
            throw new IllegalArgumentException("canonical bridge array projection conflict", error);
        }
    }

    private static List<String> immutableStrings(List<String> values) {
        return Collections.unmodifiableList(new ArrayList<>(values == null
            ? Collections.emptyList()
            : values));
    }

    private static String nullableString(JSONObject value, String key) {
        Object raw = value.opt(key);
        return raw == null || raw == JSONObject.NULL ? null : (String) raw;
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim();
    }
}
