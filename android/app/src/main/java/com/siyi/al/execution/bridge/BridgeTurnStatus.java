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
    final String raw;

    private BridgeTurnStatus(
        String turnId, String state, boolean terminal, boolean allowFallback,
        String errorCode, String replyText, long retryAfterMs, long recoveryAckSeq, String raw
    ) {
        this.turnId = turnId;
        this.state = state;
        this.terminal = terminal;
        this.allowFallback = allowFallback;
        this.errorCode = errorCode;
        this.replyText = replyText;
        this.retryAfterMs = Math.max(100L, Math.min(10_000L, retryAfterMs <= 0L ? 1_500L : retryAfterMs));
        this.recoveryAckSeq = Math.max(0L, recoveryAckSeq);
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
            raw
        );
    }

    boolean committed() { return terminal && !replyText.isEmpty(); }
    boolean failedFinal() { return terminal && replyText.isEmpty(); }

    BridgeResult toResult(String route) {
        if (!committed()) throw new IllegalStateException("bridge turn is not committed");
        return BridgeResult.success(route, replyText, raw);
    }
}
