package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class BridgeRecoveryTest {
    @Test public void rawUserMessageIsDurableBeforeAnyTransportStarts() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig config = new BridgeConfig(true, BridgeMode.AUTO, "http://lan", "https://cloud", "device_123456", "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 500, 2000, 1, 1);
        BridgeRouter.MessageMirror mirror = new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("persisted:" + value.sourceMessageId); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("reply:" + result.origin); }
        };
        BridgeRouter.RouteClient lan = value -> {
            assertEquals("persisted:msg_phone_9", events.get(0));
            events.add("lan");
            return BridgeResult.success("lan", "收到");
        };
        BridgeRouter router = new BridgeRouter(config, lan, value -> BridgeResult.success("cloud", "unused"), value -> BridgeResult.success("fallback", "unused"), mirror);

        BridgeResult result = router.execute(new TurnSubmission("turn_phone_9", "yuqi", "msg_phone_9", TurnKind.DIRECT_REPLY, "{\"text\":\"在吗\"}", "{}", null, 1784400000000L));

        assertEquals("lan", result.origin);
        assertTrue(events.indexOf("persisted:msg_phone_9") < events.indexOf("lan"));
        assertEquals("reply:lan", events.get(events.size() - 1));
    }

    @Test public void disabledBridgeUsesFallbackButStillMirrorsBothSides() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeConfig config = BridgeConfig.disabled();
        BridgeRouter.MessageMirror mirror = new BridgeRouter.MessageMirror() {
            @Override public void persistSubmission(TurnSubmission value) { events.add("user"); }
            @Override public void persistReply(TurnSubmission value, BridgeResult result) { events.add("reply:" + result.origin); }
        };
        BridgeRouter router = new BridgeRouter(config, value -> { throw new AssertionError(); }, value -> { throw new AssertionError(); }, value -> BridgeResult.success("fallback", "旧 AI 回复"), mirror);

        BridgeResult result = router.execute(new TurnSubmission("turn_phone_2", "yuqi", "msg_phone_2", TurnKind.DIRECT_REPLY, "{\"text\":\"你好\"}", "{}", null, 2L));

        assertTrue(result.fallback);
        assertEquals(java.util.Arrays.asList("user", "reply:fallback"), events);
    }
}
