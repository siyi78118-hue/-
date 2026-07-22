package com.siyi.al.execution.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class BridgeResult {
    public final String origin;
    public final String replyText;
    public final String responseJson;
    public final List<String> attemptedRoutes;
    public final boolean fallback;
    public final boolean skipped;
    public final String paymentStatus;

    private BridgeResult(String origin, String replyText, String responseJson, List<String> attemptedRoutes, boolean fallback, boolean skipped, String paymentStatus) {
        this.origin = origin == null ? "" : origin;
        this.replyText = replyText == null ? "" : replyText;
        this.responseJson = responseJson == null ? "{}" : responseJson;
        this.attemptedRoutes = Collections.unmodifiableList(new ArrayList<>(attemptedRoutes));
        this.fallback = fallback;
        this.skipped = skipped;
        this.paymentStatus = paymentStatus == null ? "" : paymentStatus.trim();
    }

    public static BridgeResult success(String origin, String replyText) {
        return new BridgeResult(origin, replyText, "{}", Collections.singletonList(origin), "fallback".equals(origin), false, "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, "");
    }

    public static BridgeResult success(String origin, String replyText, String responseJson, String paymentStatus) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin), false, paymentStatus);
    }

    public static BridgeResult skipped(String origin, String responseJson) {
        return new BridgeResult(origin, "", responseJson, Collections.singletonList(origin), false, true, "");
    }

    BridgeResult routed(List<String> routes, boolean usedFallback) {
        return new BridgeResult(origin, replyText, responseJson, routes, usedFallback, skipped, paymentStatus);
    }
}
