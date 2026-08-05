package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

public class BridgeReceiptCheckpointTest {
    @Test public void onlyLegacyProtocolsMayReadMemoryResultBridgeFields() {
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(null));
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(1));
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(2));
        assertEquals(false, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(3));
    }

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

    @Test public void wishedForExtractAuthorityReceiptFromV12CheckpointUsesTerminalOutcome() throws Exception {
        String lineage = "lineage_v12";
        org.json.JSONObject result = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_v12_remote")
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineage)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineage))
            .put("lineageRevision", 2L)
            .put("turnRevision", 4L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("generationFingerprint", org.json.JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", "skip")
            .put("replyParts", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray());
        org.json.JSONObject envelope = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_v12_remote")
            .put("characterId", "yuqi")
            .put("deviceId", "device_123456")
            .put("deviceSeq", 12L)
            .put("createdAt", 1784400000000L);
        org.json.JSONObject checkpoint = new org.json.JSONObject()
            .put("version", 1L)
            .put("localTurnId", "local_v12")
            .put("attemptId", "attempt_v12")
            .put("attemptSequence", 1L)
            .put("authoritativeTurnId", "turn_v12_remote")
            .put("authorityLineageKey", lineage)
            .put("claimedLineageRevision", 2L)
            .put("retryOfTurnId", org.json.JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", new org.json.JSONObject()
                .put("type", "committed")
                .put("route", "cloud")
                .put("relayMessageId", "relay_v12")
                .put("failure", org.json.JSONObject.NULL)
                .put("result", result)
                .put("redactedAt", org.json.JSONObject.NULL));
        String checkpointJson = BridgeAuthority.canonicalJson(checkpoint);

        org.json.JSONObject receipt = BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
            checkpointJson, BridgeAuthority.sha256CanonicalJson(checkpoint));

        assertNotNull(receipt);
        assertEquals("turn_v12_remote", receipt.getString("turnId"));
        assertEquals("cloud", receipt.getString("_deliveryRoute"));
        assertEquals("relay_v12", receipt.getString("_relayMessageId"));
        assertEquals("skip", receipt.getString("terminalDisposition"));
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }
}
