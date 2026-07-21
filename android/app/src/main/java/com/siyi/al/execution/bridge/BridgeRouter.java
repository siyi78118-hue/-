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

    public BridgeResult execute(TurnSubmission submission) throws Exception {
        if (submission.kind == TurnKind.DIRECT_REPLY) {
            mirror.persistSubmission(submission);
        }
        List<String> routes = new ArrayList<>();
        List<Exception> failures = new ArrayList<>();

        if (config.enabled) {
            if (config.mode == BridgeMode.AUTO || config.mode == BridgeMode.LAN) {
                BridgeResult result = attempt("lan", lan, submission, routes, failures);
                if (result != null) return finish(submission, result.routed(routes, false));
            }
            if (config.mode == BridgeMode.AUTO || config.mode == BridgeMode.CLOUD) {
                BridgeResult result = attempt("cloud", cloud, submission, routes, failures);
                if (result != null) return finish(submission, result.routed(routes, false));
            }
        }

        boolean fallbackAuthorized = !config.enabled;
        BridgePendingException pending = null;
        BridgeFinalException blockedFinal = null;
        for (Exception failure : failures) {
            if (failure instanceof BridgePendingException) {
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
        if (blockedFinal != null && !fallbackAuthorized) throw blockedFinal;
        if (pending != null && !fallbackAuthorized) {
            for (Exception failure : failures) if (failure != pending) pending.addSuppressed(failure);
            throw pending;
        }

        routes.add("fallback");
        try {
            BridgeResult result = fallback.execute(submission).routed(routes, true);
            return finish(submission, result);
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

    private BridgeResult finish(TurnSubmission submission, BridgeResult result) throws Exception {
        if (result.skipped) return result;
        if (result.replyText.trim().isEmpty()) throw new IllegalStateException("bridge returned an empty reply");
        mirror.persistReply(submission, result);
        return result;
    }
}
