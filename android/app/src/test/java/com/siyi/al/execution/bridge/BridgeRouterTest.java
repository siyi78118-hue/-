package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class BridgeRouterTest {
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

    private static BridgeRouter router(
        BridgeMode mode,
        List<String> events,
        BridgeRouter.RouteClient lan,
        BridgeRouter.RouteClient cloud,
        BridgeRouter.FallbackExecutor fallback
    ) {
        BridgeConfig config = new BridgeConfig(true, mode, "http://192.168.1.8:17891", "https://relay.example", "device_123456", "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 2, 1);
        BridgeRouter.MessageMirror mirror = new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("mirror-user"); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("mirror-reply"); }
        };
        return new BridgeRouter(config, lan, cloud, fallback, mirror);
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
}
