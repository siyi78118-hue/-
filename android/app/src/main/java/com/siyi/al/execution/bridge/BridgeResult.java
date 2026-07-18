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

    private BridgeResult(String origin, String replyText, String responseJson, List<String> attemptedRoutes, boolean fallback) {
        this.origin = origin == null ? "" : origin;
        this.replyText = replyText == null ? "" : replyText;
        this.responseJson = responseJson == null ? "{}" : responseJson;
        this.attemptedRoutes = Collections.unmodifiableList(new ArrayList<>(attemptedRoutes));
        this.fallback = fallback;
    }

    public static BridgeResult success(String origin, String replyText) {
        return new BridgeResult(origin, replyText, "{}", Collections.singletonList(origin), "fallback".equals(origin));
    }

    public static BridgeResult success(String origin, String replyText, String responseJson) {
        return new BridgeResult(origin, replyText, responseJson, Collections.singletonList(origin), "fallback".equals(origin));
    }

    BridgeResult routed(List<String> routes, boolean usedFallback) {
        return new BridgeResult(origin, replyText, responseJson, routes, usedFallback);
    }
}
