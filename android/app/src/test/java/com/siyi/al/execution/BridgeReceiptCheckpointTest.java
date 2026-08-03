package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

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

    @Test public void acceptsCompleteV3SkipWithoutItemsOrRelayIdentity() throws Exception {
        String response = "{"
            + "\"protocolVersion\":3,\"turnId\":\"turn_skip\",\"roleId\":\"yuqi\","
            + "\"authorityOrigin\":\"pc\",\"authorityLineageKey\":\"lin_skip\","
            + "\"visibleGroupId\":\"" + AuthorityIdentity.groupId("lin_skip") + "\",\"lineageRevision\":2,\"turnRevision\":4,"
            + "\"laneKey\":\"private_chat\",\"laneRevision\":8,"
            + "\"inputVisibilitySequence\":12,\"inputClearEpoch\":3,"
            + "\"generationFingerprint\":null,\"releaseId\":\"release_v3\","
            + "\"commitPayloadVersion\":\"pc-visible-commit-v2\","
            + "\"commitChecksum\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
            + "\"terminalDisposition\":\"skip\",\"replyParts\":[],\"actions\":[],"
            + "\"ok\":true,\"terminal\":true,\"recoveryAckSeq\":9}";
        String checkpoint = new org.json.JSONObject()
            .put("origin", "lan")
            .put("bridgeResponse", new org.json.JSONObject(response))
            .toString();

        org.json.JSONObject extracted = BridgeReceiptCheckpoint.extract(checkpoint);

        assertNotNull(extracted);
        assertEquals("skip", extracted.getString("terminalDisposition"));
        assertEquals("lan", extracted.getString("_deliveryRoute"));
        assertFalse(extracted.has("_relayMessageId"));
        assertFalse(extracted.has("ok"));
        assertFalse(extracted.has("terminal"));
        assertFalse(extracted.has("recoveryAckSeq"));
    }

    @Test public void rejectsPartialV3ReceiptEvenWhenRelayIdentityExists() throws Exception {
        org.json.JSONObject partial = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_partial")
            .put("terminalDisposition", "skip")
            .put("replyParts", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray())
            .put("_relayMessageId", "relay_partial");
        String checkpoint = new org.json.JSONObject()
            .put("origin", "cloud")
            .put("bridgeResponse", partial)
            .toString();

        assertNull(BridgeReceiptCheckpoint.extract(checkpoint));
    }
}
