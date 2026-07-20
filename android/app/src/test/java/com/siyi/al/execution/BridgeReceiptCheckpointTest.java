package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class BridgeReceiptCheckpointTest {
    @Test public void extractsCurrentObjectShapedBridgeResponse() throws Exception {
        String checkpoint = "{\"bridgeResponse\":{\"_relayMessageId\":\"relay_1\",\"reply\":{}}}";

        assertEquals("relay_1", BridgeReceiptCheckpoint.extract(checkpoint).getString("_relayMessageId"));
    }

    @Test public void extractsLegacyStringShapedBridgeResponse() throws Exception {
        String checkpoint = "{\"bridgeResponse\":\"{\\\"_relayMessageId\\\":\\\"relay_old\\\",\\\"reply\\\":{}}\"}";

        assertEquals("relay_old", BridgeReceiptCheckpoint.extract(checkpoint).getString("_relayMessageId"));
    }

    @Test public void ignoresLegacyMemoryTextThatWasNeverABridgeCheckpoint() {
        assertNull(BridgeReceiptCheckpoint.extract("[events | 2026-07-17 19:02] old summary"));
    }

    @Test public void ignoresCheckpointWithoutRelayIdentity() {
        assertNull(BridgeReceiptCheckpoint.extract("{\"bridgeResponse\":{\"reply\":{}}}"));
    }
}
