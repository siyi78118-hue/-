package com.siyi.al.execution.bridge;

import org.json.JSONObject;

final class BridgeTurnStatus {
    final String turnId;
    final String state;
    final boolean terminal;
    final boolean allowFallback;
    final String action;
    final String paymentStatus;
    final String relationshipStageActionJson;
    final String momentActionJson;
    final String rolePlanOperationsJson;
    final String errorCode;
    final String replyText;
    final long retryAfterMs;
    final long recoveryAckSeq;
    final String origin;
    final String route;
    final String displayStage;
    final String technicalStage;
    final String stageModel;
    final String stageEffort;
    final long stageElapsedMs;
    final long totalElapsedMs;
    final String raw;

    private BridgeTurnStatus(
        String turnId, String state, boolean terminal, boolean allowFallback,
        String errorCode, String action, String paymentStatus, String relationshipStageActionJson, String momentActionJson, String rolePlanOperationsJson, String replyText, long retryAfterMs, long recoveryAckSeq, String origin,
        String route, String displayStage, String technicalStage, String stageModel, String stageEffort,
        long stageElapsedMs, long totalElapsedMs, String raw
    ) {
        this.turnId = turnId;
        this.state = state;
        this.terminal = terminal;
        this.allowFallback = allowFallback;
        this.errorCode = errorCode;
        this.action = action == null ? "" : action.trim();
        this.paymentStatus = paymentStatus == null ? "" : paymentStatus.trim();
        this.relationshipStageActionJson = relationshipStageActionJson == null ? "" : relationshipStageActionJson.trim();
        this.momentActionJson = momentActionJson == null ? "" : momentActionJson.trim();
        this.rolePlanOperationsJson = rolePlanOperationsJson == null ? "" : rolePlanOperationsJson.trim();
        this.replyText = replyText;
        this.retryAfterMs = Math.max(100L, Math.min(10_000L, retryAfterMs <= 0L ? 1_500L : retryAfterMs));
        this.recoveryAckSeq = Math.max(0L, recoveryAckSeq);
        this.origin = origin == null ? "" : origin.trim();
        this.route = route == null ? "deep" : route.trim();
        this.displayStage = displayStage == null ? "" : displayStage.trim();
        this.technicalStage = technicalStage == null ? state : technicalStage.trim();
        this.stageModel = stageModel == null ? "" : stageModel.trim();
        this.stageEffort = stageEffort == null ? "" : stageEffort.trim();
        this.stageElapsedMs = Math.max(0L, stageElapsedMs);
        this.totalElapsedMs = Math.max(0L, totalElapsedMs);
        this.raw = raw;
    }

    static BridgeTurnStatus parse(String raw, String expectedTurnId) throws Exception {
        JSONObject root = new JSONObject(raw);
        String turnId = root.optString("turnId", "");
        if (!expectedTurnId.equals(turnId)) throw new IllegalStateException("bridge turn ID mismatch");
        JSONObject reply = root.optJSONObject("reply");
        String replyText = reply == null ? "" : reply.optString("content", "").trim();
        boolean terminal = root.optBoolean("terminal", !replyText.isEmpty());
        return new BridgeTurnStatus(
            turnId,
            root.optString("state", "queued"),
            terminal,
            root.optBoolean("allowFallback", false),
            root.optString("errorCode", ""),
            root.optString("action", replyText.isEmpty() ? "" : "send"),
            root.optString("paymentAction", ""),
            root.optJSONObject("relationshipStageAction") == null ? "" : root.optJSONObject("relationshipStageAction").toString(),
            root.optJSONObject("momentAction") == null ? "" : root.optJSONObject("momentAction").toString(),
            nonEmptyArrayJson(root, "rolePlanOperations"),
            replyText,
            root.optLong("retryAfterMs", 1_500L),
            root.optLong("recoveryAckSeq", 0L),
            root.optString("origin", reply == null ? "" : reply.optString("origin", "")),
            root.optString("route", "deep"),
            root.optString("displayStage", ""),
            root.optString("technicalStage", root.optString("state", "queued")),
            root.optString("stageModel", ""),
            root.optString("stageEffort", ""),
            root.optLong("stageElapsedMs", 0L),
            root.optLong("totalElapsedMs", 0L),
            raw
        );
    }

    private static String nonEmptyArrayJson(JSONObject root, String key) {
        org.json.JSONArray value = root.optJSONArray(key);
        return value == null || value.length() == 0 ? "" : value.toString();
    }

    boolean committed() { return terminal && "send".equals(action) && (!replyText.isEmpty() || !momentActionJson.isEmpty() || !rolePlanOperationsJson.isEmpty()); }
    boolean skipped() { return terminal && "skip".equals(action); }
    boolean failedFinal() { return terminal && !committed() && !skipped(); }

    BridgeResult toResult(String route) {
        if (!committed() && !skipped()) throw new IllegalStateException("bridge turn is not committed");
        if (skipped()) return BridgeResult.skipped(origin.isEmpty() ? route : origin, raw);
        return BridgeResult.success(origin.isEmpty() ? route : origin, replyText, raw, paymentStatus, relationshipStageActionJson, momentActionJson, rolePlanOperationsJson);
    }
}
