package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.json.JSONObject;

public class BridgeRouterTest {
    @Test public void changedRouteDeviceRejectsPinnedV3BeforeMirrorOrNetwork() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig changed = new BridgeConfig(
            true, BridgeMode.AUTO, "http://192.168.1.8:17891", "https://relay.example",
            "device_changed", "pairing-secret-123", "device-token-123456",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 2, 1
        );
        JSONObject checkpoint = new JSONObject().put("normalizedEnvelope", new JSONObject()
            .put("deviceId", "device_pinned"));
        TurnSubmission prepared = new TurnSubmission(
            "turn_local", "yuqi", "msg_1", TurnKind.DIRECT_REPLY, "{}", "{}", null, 1L,
            "turn_remote", checkpoint.toString()
        );
        BridgeRouter router = new BridgeRouter(
            changed, succeeding("lan", events), succeeding("cloud", events), fallback("fallback", events),
            new BridgeRouter.MessageMirror() {
                @Override public void persistSubmission(TurnSubmission value) { events.add("mirror-user"); }
                @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("mirror-reply"); }
            }
        );

        assertThrows(IllegalStateException.class, () -> router.execute(prepared));
        assertTrue(events.isEmpty());
    }

    @Test public void pinnedV3TerminalNeverUsesLegacyMessageMirrors() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(
            config(BridgeMode.LAN),
            value -> {
                events.add("lan");
                return BridgeResult.canonicalTerminal(
                    new JSONObject()
                        .put("terminalDisposition", "action_only")
                        .put("replyParts", new org.json.JSONArray())
                        .put("actions", new org.json.JSONArray()),
                    "{}", "lan", null
                );
            },
            failing("cloud", events),
            fallback("fallback", events),
            recordingMirror(events)
        );

        BridgeResult result = router.execute(preparedV3Submission());

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, result.kind);
        assertEquals(Arrays.asList("lan"), events);
    }

    @Test public void pinnedV3FailureNeverAuthorizesLegacyFallback() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(
            config(BridgeMode.AUTO),
            value -> {
                events.add("lan");
                throw new BridgeDeadlineException("turn_local");
            },
            value -> {
                events.add("cloud");
                throw new BridgeFinalException("REMOTE_FINAL", true);
            },
            fallback("fallback", events),
            recordingMirror(events)
        );

        assertThrows(BridgeFinalException.class, () -> router.execute(preparedV3Submission()));
        assertEquals(Arrays.asList("lan", "cloud"), events);
    }

    @Test public void v3DisabledBeforeRemoteCallMayUseLocalFallbackDraft() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig disabled = new BridgeConfig(
            false, BridgeMode.AUTO, "", "", "device_123456", "", "", "", 500, 2000, 2, 1
        );
        BridgeRouter router = new BridgeRouter(
            disabled,
            value -> { throw new AssertionError("LAN must not run"); },
            value -> { throw new AssertionError("cloud must not run"); },
            fallback("fallback", events),
            recordingMirror(events)
        );

        BridgeResult result = router.execute(preparedV3Submission());

        assertTrue(result.fallback);
        assertEquals(Arrays.asList("fallback"), events);
    }

    @Test public void v3OnlyExplicitNotAcceptedFailureMayUseFallback() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(
            config(BridgeMode.AUTO),
            value -> { events.add("lan"); throw new BridgeFinalException("NOT_ACCEPTED_ALLOW_FALLBACK", true); },
            value -> { events.add("cloud"); throw new BridgeFinalException("NOT_ACCEPTED_ALLOW_FALLBACK", true); },
            fallback("fallback", events),
            recordingMirror(events)
        );

        BridgeResult result = router.execute(preparedV3Submission());

        assertTrue(result.fallback);
        assertEquals(Arrays.asList("lan", "cloud", "fallback"), events);
    }

    @Test public void v3UnknownRouteFailureNeverUsesFallback() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(
            config(BridgeMode.AUTO),
            value -> { events.add("lan"); throw new IllegalStateException("unknown route failure"); },
            value -> { events.add("cloud"); throw new IllegalStateException("unknown route failure"); },
            fallback("fallback", events),
            recordingMirror(events)
        );

        assertThrows(IllegalStateException.class, () -> router.execute(preparedV3Submission()));
        assertEquals(Arrays.asList("lan", "cloud"), events);
    }

    @Test public void autoPrefersLanAndFallsBackToCloud() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = router(BridgeMode.AUTO, events, failing("lan", events), succeeding("cloud", events), fallback("fallback", events));

        BridgeResult result = router.execute(submission());

        assertEquals(Arrays.asList("mirror-user", "lan", "cloud", "mirror-reply"), events);
        assertEquals(Arrays.asList("lan", "cloud"), result.attemptedRoutes);
        assertEquals("cloud", result.origin);
        assertFalse(result.fallback);
    }

    @Test public void autoUsesExistingAiOnlyAfterBothBridgeRoutesFail() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = router(BridgeMode.AUTO, events, failing("lan", events), failing("cloud", events), fallback("fallback", events));

        BridgeResult result = router.execute(submission());

        assertEquals(Arrays.asList("lan", "cloud", "fallback"), result.attemptedRoutes);
        assertEquals("fallback", result.origin);
        assertTrue(result.fallback);
    }

    @Test public void manualLanAndCloudModesNeverTryTheOtherBridgeRoute() throws Exception {
        List<String> lanEvents = new ArrayList<>();
        BridgeResult lan = router(BridgeMode.LAN, lanEvents, failing("lan", lanEvents), succeeding("cloud", lanEvents), fallback("fallback", lanEvents)).execute(submission());
        assertEquals(Arrays.asList("lan", "fallback"), lan.attemptedRoutes);

        List<String> cloudEvents = new ArrayList<>();
        BridgeResult cloud = router(BridgeMode.CLOUD, cloudEvents, succeeding("lan", cloudEvents), failing("cloud", cloudEvents), fallback("fallback", cloudEvents)).execute(submission());
        assertEquals(Arrays.asList("cloud", "fallback"), cloud.attemptedRoutes);
    }

    @Test public void proactiveTurnWithoutUserMessageSkipsUserMirrorAndStillUsesLan() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig config = new BridgeConfig(true, BridgeMode.LAN, "http://192.168.1.8:17891", "https://relay.example", "device_123456", "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 2, 1);
        BridgeRouter.MessageMirror mirror = new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("mirror-user"); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("mirror-reply"); }
        };
        BridgeRouter router = new BridgeRouter(config, succeeding("lan", events), failing("cloud", events), fallback("fallback", events), mirror);
        TurnSubmission proactive = new TurnSubmission("turn_proactive_1", "yuqi", "job_proactive_1", TurnKind.PROACTIVE_CHAT, "{}", "{}", "job_1", 1784400000000L);

        BridgeResult result = router.execute(proactive);

        assertEquals(Arrays.asList("lan", "mirror-reply"), events);
        assertEquals("lan", result.origin);
        assertFalse(result.fallback);
    }

    @Test public void deliberateAutomaticSkipCompletesWithoutMirroringAnEmptyReply() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig config = new BridgeConfig(true, BridgeMode.LAN, "http://192.168.1.8:17891", "https://relay.example", "device_123456", "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 2, 1);
        BridgeRouter.MessageMirror mirror = new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("mirror-user"); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("mirror-reply"); }
        };
        BridgeRouter router = new BridgeRouter(config, value -> { events.add("lan"); return BridgeResult.skipped("codex", "{}"); }, failing("cloud", events), fallback("fallback", events), mirror);
        TurnSubmission proactive = new TurnSubmission("turn_proactive_skip", "yuqi", "job_skip", TurnKind.PROACTIVE_CHAT, "{}", "{}", "job_skip", 1784400000000L);

        BridgeResult result = router.execute(proactive);

        assertTrue(result.skipped);
        assertEquals(Arrays.asList("lan"), events);
    }

    @Test public void transientLanAndCloudFailuresNeverInvokeFallbackBeforeDeadline() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = router(
            BridgeMode.AUTO,
            events,
            value -> { events.add("lan"); throw new BridgePendingException("LAN temporarily unreachable"); },
            value -> { events.add("cloud"); throw new BridgePendingException("cloud result still pending"); },
            fallback("fallback", events)
        );

        try {
            router.execute(submission());
            throw new AssertionError("expected BridgePendingException");
        } catch (BridgePendingException expected) {
            assertEquals(Arrays.asList("mirror-user", "lan", "cloud"), events);
        }
    }

    @Test public void acceptedCloudHandoffNeverFallsBack() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = router(
            BridgeMode.CLOUD,
            events,
            value -> { throw new AssertionError("LAN must not run"); },
            value -> { events.add("cloud"); throw new BridgeAcceptedException("cloud"); },
            fallback("fallback", events)
        );

        try {
            router.execute(submission());
            throw new AssertionError("expected BridgeAcceptedException");
        } catch (BridgeAcceptedException expected) {
            assertEquals(Arrays.asList("mirror-user", "cloud"), events);
        }
    }

    @Test public void explicitFinalFailureMayAuthorizeTheLegacyFallback() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeRouter router = router(
            BridgeMode.LAN,
            events,
            value -> { events.add("lan"); throw new BridgeFinalException("ROLE_FAILED", true); },
            succeeding("cloud", events),
            fallback("fallback", events)
        );

        BridgeResult result = router.execute(submission());

        assertEquals(Arrays.asList("lan", "fallback"), result.attemptedRoutes);
        assertTrue(result.fallback);
    }

    private static BridgeRouter router(
        BridgeMode mode,
        List<String> events,
        BridgeRouter.RouteClient lan,
        BridgeRouter.RouteClient cloud,
        BridgeRouter.FallbackExecutor fallback
    ) {
        return new BridgeRouter(config(mode), lan, cloud, fallback, recordingMirror(events));
    }

    private static BridgeConfig config(BridgeMode mode) {
        return new BridgeConfig(true, mode, "http://192.168.1.8:17891", "https://relay.example", "device_123456", "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 2, 1);
    }

    private static BridgeRouter.MessageMirror recordingMirror(List<String> events) {
        return new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("mirror-user"); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("mirror-reply"); }
        };
    }

    private static BridgeRouter.RouteClient failing(String route, List<String> events) {
        return submission -> { events.add(route); throw new IllegalStateException(route + " unavailable"); };
    }

    private static BridgeRouter.RouteClient succeeding(String route, List<String> events) {
        return submission -> { events.add(route); return BridgeResult.success(route, route + " reply"); };
    }

    private static BridgeRouter.FallbackExecutor fallback(String route, List<String> events) {
        return submission -> { events.add(route); return BridgeResult.success(route, route + " reply"); };
    }

    private static TurnSubmission submission() {
        return new TurnSubmission("turn_phone_1", "yuqi", "msg_phone_1", TurnKind.DIRECT_REPLY, "{\"text\":\"你好\"}", "{}", null, 1784400000000L);
    }

    private static TurnSubmission preparedV3Submission() throws Exception {
        JSONObject checkpoint = new JSONObject().put("normalizedEnvelope", new JSONObject()
            .put("deviceId", "device_123456"));
        return new TurnSubmission(
            "turn_local", "yuqi", "msg_1", TurnKind.DIRECT_REPLY,
            "{}", "{}", null, 1L, "turn_remote", checkpoint.toString()
        );
    }
}
