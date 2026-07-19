package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeClientTest {
    @Test public void lanSignatureMatchesThePcRuntimeProtocol() throws Exception {
        assertEquals(
            "a691a19665109ef88332e8ee1cba83dbd6f5eaad0248a76090e06394732e0e06",
            BridgeClient.signLanRequest("pairing-secret-123", "POST", "/v1/turns", 1784400000000L, "nonce123", "{}")
        );
    }

    @Test public void legacyUserTextBecomesTheCanonicalWireMessage() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_phone_9", "yuqi", "msg_phone_9", TurnKind.DIRECT_REPLY,
            "{\"userText\":\"你好 我是姜隽侑\",\"options\":{}}", "{}", null, 1784400000000L
        );
        Method method = BridgeClient.class.getDeclaredMethod("wireEnvelope", TurnSubmission.class);
        method.setAccessible(true);
        JSONObject envelope = (JSONObject) method.invoke(new BridgeClient(BridgeConfig.disabled()), submission);
        assertEquals("你好 我是姜隽侑", envelope.getJSONObject("message").getString("content"));
    }

    @Test public void proactiveEnvelopeContainsATriggerAndNeverFabricatesAUserMessage() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_proactive_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{\"reason\":\"scheduled\",\"scheduledFor\":1784400000000}",
            "{\"relationshipStage\":\"initial\"}", "job_1", 1784400000100L
        );
        JSONObject envelope = BridgeInput.envelope(submission, config("http://lan.example"));
        assertEquals(2, envelope.getInt("protocolVersion"));
        assertFalse(envelope.has("message"));
        assertEquals("trigger_proactive_1", envelope.getJSONObject("trigger").getString("triggerId"));
        assertEquals("proactive_chat", envelope.getJSONObject("trigger").getString("triggerType"));
        assertEquals("initial", envelope.getJSONObject("trigger").getJSONObject("context")
            .getJSONObject("snapshot").getString("relationshipStage"));
    }

    @Test public void lanAcceptedTurnPollsWithFreshSignedGetsUntilCommitted() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(202,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"queued\",\"terminal\":false,\"retryAfterMs\":1}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"brain_running\",\"terminal\":false,\"retryAfterMs\":1}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"committed\",\"terminal\":true,"
                + "\"reply\":{\"content\":\"你好呀\",\"origin\":\"codex\"},\"recoveryAckSeq\":0}"));
        MutableTime time = new MutableTime(1784400000000L);
        BridgeClient client = new BridgeClient(config("http://lan.example"), null, transport, time, time);

        BridgeResult result = client.sendLan(directSubmission(1784400000000L));

        assertEquals("你好呀", result.replyText);
        assertEquals("codex", result.origin);
        assertEquals(3, transport.targets.size());
        assertTrue(transport.targets.get(0).endsWith("/v2/turns"));
        assertTrue(transport.targets.get(1).endsWith("/v2/turns/turn_phone_1"));
        assertTrue(transport.targets.get(2).endsWith("/v2/turns/turn_phone_1"));
        assertFalse(transport.nonces.get(1).equals(transport.nonces.get(2)));
    }

    private static TurnSubmission directSubmission(long createdAt) {
        return new TurnSubmission(
            "turn_phone_1", "yuqi", "msg_phone_1", TurnKind.DIRECT_REPLY,
            "{\"userText\":\"你好\",\"deviceSeq\":1}", "{}", null, createdAt
        );
    }

    private static BridgeConfig config(String lanUrl) {
        return new BridgeConfig(
            true, BridgeMode.LAN, lanUrl, "https://relay.example", "device_123456",
            "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            500, 2_000, 60, 100, 1_200_000
        );
    }

    private static final class FakeTransport implements BridgeClient.Transport {
        final ArrayDeque<BridgeClient.HttpResult> responses = new ArrayDeque<>();
        final List<String> targets = new ArrayList<>();
        final List<String> nonces = new ArrayList<>();

        @Override public BridgeClient.HttpResult request(String method, String target, String body, String[][] headers) {
            targets.add(target);
            String nonce = "";
            for (String[] header : headers) if ("X-Yuqi-Nonce".equals(header[0])) nonce = header[1];
            nonces.add(nonce);
            return responses.removeFirst();
        }
    }

    private static final class MutableTime implements BridgeClient.Clock, BridgeClient.Sleeper {
        long now;
        MutableTime(long now) { this.now = now; }
        @Override public long now() { return now; }
        @Override public void sleep(long millis) { now += Math.max(1L, millis); }
    }
}
