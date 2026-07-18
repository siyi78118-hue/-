package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class BridgeClientTest {
    @Test public void lanSignatureMatchesThePcRuntimeProtocol() throws Exception {
        assertEquals(
            "a691a19665109ef88332e8ee1cba83dbd6f5eaad0248a76090e06394732e0e06",
            BridgeClient.signLanRequest("pairing-secret-123", "POST", "/v1/turns", 1784400000000L, "nonce123", "{}")
        );
    }
}
