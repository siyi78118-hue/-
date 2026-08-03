package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.TurnKind;
import java.util.ArrayList;
import java.util.List;

public final class BridgeRouter {
    public interface RouteClient {
        BridgeResult execute(TurnSubmission submission) throws Exception;
    }

    public interface FallbackExecutor {
        BridgeResult execute(TurnSubmission submission) throws Exception;
    }

    public interface MessageMirror {
        void persistSubmission(TurnSubmission submission) throws Exception;
        void persistReply(TurnSubmission submission, BridgeResult result) throws Exception;
    }

    private final BridgeConfig config;
    private final RouteClient lan;
    private final RouteClient cloud;
    private final FallbackExecutor fallback;
    private final MessageMirror mirror;

    public BridgeRouter(BridgeConfig config, RouteClient lan, RouteClient cloud, FallbackExecutor fallback, MessageMirror mirror) {
        this.config = config == null ? BridgeConfig.disabled() : config;
        this.lan = lan;
        this.cloud = cloud;
        this.fallback = fallback;
        this.mirror = mirror;
    }

    public boolean isEnabled() { return config.enabled; }
    public String deviceId() { return config.deviceId; }

    public BridgeResult execute(TurnSubmission submission) throws Exception {
        boolean canonicalV3 = submission.bridgeAuthorityCheckpointJson != null;
        if (canonicalV3) {
            String pinnedDeviceId = new org.json.JSONObject(submission.bridgeAuthorityCheckpointJson)
                .getJSONObject("normalizedEnvelope").getString("deviceId");
            if (!config.deviceId.equals(pinnedDeviceId)) {
                throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT: bridge device changed");
            }
        }
        if (!canonicalV3 && submission.kind == TurnKind.DIRECT_REPLY) {
            mirror.persistSubmission(submission);
        }
        List<String> routes = new ArrayList<>();
        List<Exception> failures = new ArrayList<>();

        if (config.enabled) {
            if (config.mode == BridgeMode.AUTO || config.mode == BridgeMode.LAN) {
                BridgeResult result = attempt("lan", lan, submission, routes, failures);
                if (result != null) return finish(submission, result.routed(routes, false), canonicalV3);
            }
            if (config.mode == BridgeMode.AUTO || config.mode == BridgeMode.CLOUD) {
                BridgeResult result = attempt("cloud", cloud, submission, routes, failures);
                if (result != null) return finish(submission, result.routed(routes, false), canonicalV3);
            }
        }

        boolean fallbackAuthorized = !config.enabled;
        BridgePendingException pending = null;
        BridgeAcceptedException accepted = null;
        BridgeFinalException blockedFinal = null;
        for (Exception failure : failures) {
            if (failure instanceof BridgeAcceptedException) {
                accepted = (BridgeAcceptedException) failure;
            } else if (failure instanceof BridgePendingException) {
                pending = (BridgePendingException) failure;
            } else if (failure instanceof BridgeDeadlineException) {
                fallbackAuthorized = true;
            } else if (failure instanceof BridgeFinalException) {
                BridgeFinalException finalFailure = (BridgeFinalException) failure;
                if (finalFailure.allowFallback()) fallbackAuthorized = true;
                else blockedFinal = finalFailure;
            } else {
                // Legacy route clients predate explicit failure categories.
                fallbackAuthorized = true;
            }
        }
        if (accepted != null) {
            for (Exception failure : failures) if (failure != accepted) accepted.addSuppressed(failure);
            throw accepted;
        }
        if (canonicalV3) {
            Exception terminal = blockedFinal != null
                ? blockedFinal
                : pending != null ? pending : failures.isEmpty() ? null : failures.get(failures.size() - 1);
            if (terminal == null) {
                throw new BridgeFinalException("BRIDGE_V3_ROUTE_UNAVAILABLE", false);
            }
            for (Exception failure : failures) if (failure != terminal) terminal.addSuppressed(failure);
            throw terminal;
        }
        if (blockedFinal != null && !fallbackAuthorized) throw blockedFinal;
        if (pending != null && !fallbackAuthorized) {
            for (Exception failure : failures) if (failure != pending) pending.addSuppressed(failure);
            throw pending;
        }

        routes.add("fallback");
        try {
            BridgeResult result = fallback.execute(submission).routed(routes, true);
            return finish(submission, result, false);
        } catch (Exception error) {
            for (Exception failure : failures) error.addSuppressed(failure);
            throw error;
        }
    }

    private BridgeResult attempt(String name, RouteClient client, TurnSubmission submission, List<String> routes, List<Exception> failures) {
        routes.add(name);
        try {
            return client.execute(submission);
        } catch (Exception error) {
            failures.add(error);
            return null;
        }
    }

    private BridgeResult finish(
        TurnSubmission submission,
        BridgeResult result,
        boolean canonicalV3
    ) throws Exception {
        if (canonicalV3) {
            if (result.kind == BridgeResult.Kind.LEGACY_V2 || result.fallback) {
                throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT: v3 route returned legacy result");
            }
            return result;
        }
        if (result.skipped) return result;
        if (result.replyText.trim().isEmpty()) throw new IllegalStateException("bridge returned an empty reply");
        mirror.persistReply(submission, result);
        return result;
    }
}
