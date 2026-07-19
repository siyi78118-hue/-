package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import java.lang.reflect.Method;
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
            "turn_phone_9",
            "yuqi",
            "msg_phone_9",
            TurnKind.DIRECT_REPLY,
            "{\"userText\":\"你好 我是姜隽侑\",\"options\":{}}",
            "{}",
            null,
            1784400000000L
        );

        Method method = BridgeClient.class.getDeclaredMethod("wireEnvelope", TurnSubmission.class);
        method.setAccessible(true);
        JSONObject envelope = (JSONObject) method.invoke(new BridgeClient(BridgeConfig.disabled()), submission);

        assertEquals("你好 我是姜隽侑", envelope.getJSONObject("message").getString("content"));
    }
}
