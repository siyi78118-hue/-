package com.siyi.al.execution.bridge;

import org.json.JSONObject;

final class BridgeTurnStatus {
    final String turnId;
    final String state;
    final boolean terminal;
    final boolean allowFallback;
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
        String errorCode, String replyText, long retryAfterMs, long recoveryAckSeq, String origin,
        String route, String displayStage, String technicalStage, String stageModel, String stageEffort,
        long stageElapsedMs, long totalElapsedMs, String raw
    ) {
        this.turnId = turnId;
        this.state = state;
        this.terminal = terminal;
        this.allowFallback = allowFallback;
        this.errorCode = errorCode;
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

    boolean committed() { return terminal && !replyText.isEmpty(); }
    boolean failedFinal() { return terminal && replyText.isEmpty(); }

    BridgeResult toResult(String route) {
        if (!committed()) throw new IllegalStateException("bridge turn is not committed");
        return BridgeResult.success(origin.isEmpty() ? route : origin, replyText, raw);
    }
}
