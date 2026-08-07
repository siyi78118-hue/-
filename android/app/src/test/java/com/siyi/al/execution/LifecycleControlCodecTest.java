package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Test;

public class LifecycleControlCodecTest {
    @Test
    public void conversationClearIsClosedAndDeterministic() throws Exception {
        LifecycleControlCodec.Encoded encoded = LifecycleControlCodec.encodeConversationClear(
            "yuqi", "device-1", 4L, 17L, 130L, repeatHex('f')
        );
        assertEquals(3L, encoded.semantic.getLong("protocolVersion"));
        assertEquals("CONVERSATION_CLEAR", encoded.semantic.getString("type"));
        assertEquals("conversation_clear_v1", encoded.semantic.getString("controlVersion"));
        assertEquals("yuqi", encoded.semantic.getString("roleId"));
        assertEquals("device-1", encoded.semantic.getString("peerId"));
        assertEquals(4L, encoded.semantic.getLong("clearEpoch"));
        assertEquals(17L, encoded.semantic.getLong("clearedThroughSequence"));
        assertEquals(130L, encoded.semantic.getLong("requestedAt"));
        assertEquals(repeatHex('f'), encoded.semantic.getString("inputCursorChecksum"));
        assertNotEquals(encoded.semantic.getString("checksum"), encoded.semanticChecksum);
        assertEquals(BridgeAuthority.sha256CanonicalJson(encoded.semantic), encoded.semanticChecksum);
        assertEquals(encoded.semanticChecksum, LifecycleControlCodec.semanticChecksum(encoded.semantic));
        assertEquals(encoded.controlId, LifecycleControlCodec.controlId(encoded.semantic));
        assertTrue(encoded.controlId.startsWith("ctl_"));
    }

    @Test
    public void roleDeleteShapeUsesNullSequenceFieldsAndClosedBackupReceipt() throws Exception {
        JSONObject receipt = new JSONObject()
            .put("receiptVersion", "yuqi-backup-receipt-v1")
            .put("receiptId", "receipt-1")
            .put("roleId", "yuqi")
            .put("manifestChecksum", repeatHex('a'))
            .put("snapshotSha256", repeatHex('b'))
            .put("logicalChecksum", repeatHex('c'))
            .put("createdAt", 1L);
        receipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(receipt));
        LifecycleControlCodec.Encoded encoded = LifecycleControlCodec.encodeRoleDelete(
            "yuqi", "device-1", 100L, receipt
        );
        assertEquals(3L, encoded.semantic.getLong("protocolVersion"));
        assertEquals("ROLE_DELETE", encoded.semantic.getString("type"));
        assertEquals("role_delete_v1", encoded.semantic.getString("controlVersion"));
        assertEquals("yuqi", encoded.semantic.getString("roleId"));
        assertFalse(encoded.semantic.has("controlKind"));
        assertFalse(encoded.semantic.has("clearEpoch"));
        assertFalse(encoded.semantic.has("clearedThroughSequence"));
        assertEquals("yuqi-backup-receipt-v1", encoded.semantic.getJSONObject("backupReceipt").getString("receiptVersion"));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlCodec.encodeRoleDelete(
            "yuqi", "device-1", 0L, receipt));
    }

    @Test
    public void roleDeleteBindsBackupRoleAndCreationTime() throws Exception {
        JSONObject foreignReceipt = new JSONObject()
            .put("receiptVersion", "yuqi-backup-receipt-v1")
            .put("receiptId", "receipt-foreign")
            .put("roleId", "other-role")
            .put("manifestChecksum", repeatHex('a'))
            .put("snapshotSha256", repeatHex('b'))
            .put("logicalChecksum", repeatHex('c'))
            .put("createdAt", 90L);
        foreignReceipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(foreignReceipt));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlCodec.encodeRoleDelete(
            "yuqi", "device-1", 100L, foreignReceipt));

        JSONObject futureReceipt = new JSONObject(foreignReceipt.toString())
            .put("receiptId", "receipt-future")
            .put("roleId", "yuqi")
            .put("createdAt", 101L);
        JSONObject futureBasis = new JSONObject(futureReceipt.toString());
        futureBasis.remove("receiptChecksum");
        futureReceipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(futureBasis));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlCodec.encodeRoleDelete(
            "yuqi", "device-1", 100L, futureReceipt));
    }

    @Test
    public void unknownOrNativeCoercionIsRejected() throws Exception {
        JSONObject malformed = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "CONVERSATION_CLEAR")
            .put("controlVersion", "conversation_clear_v1")
            .put("controlId", "ctl_" + repeatHex('a'))
            .put("roleId", "yuqi")
            .put("peerId", "device-1")
            .put("clearEpoch", "4")
            .put("clearedThroughSequence", 17L)
            .put("requestedAt", 130L)
            .put("inputCursorChecksum", repeatHex('f'))
            .put("checksum", repeatHex('e'));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlCodec.validateSemantic(malformed));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlCodec.validateSemantic(
            new JSONObject(malformed.toString()).put("secret", "leak")
        ));
    }

    @Test
    public void redactedCheckpointKeepsOnlyAuthorityTombstoneFields() throws Exception {
        JSONObject root = new JSONObject()
            .put("version", 1)
            .put("localTurnId", "local-1")
            .put("attemptId", "attempt-1")
            .put("attemptSequence", 1)
            .put("authoritativeTurnId", "remote-1")
            .put("authorityLineageKey", "lineage-1")
            .put("claimedLineageRevision", 1)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("laneKey", "lane-1")
            .put("inputVisibilitySequence", 7)
            .put("inputClearEpoch", 2)
            .put("normalizedEnvelope", new JSONObject().put("secret", "payload"))
            .put("envelopeChecksum", repeatHex('e'))
            .put("outcome", new JSONObject()
                .put("type", "committed")
                .put("route", "cloud")
                .put("relayMessageId", "relay-1")
                .put("failure", JSONObject.NULL)
                .put("result", new JSONObject().put("reply", "private")));
        JSONObject tombstone = LifecycleControlCodec.redactCheckpoint(root, "ctl_abc", 3L, 7L, 200L, false);
        assertEquals(JSONObject.NULL, tombstone.get("normalizedEnvelope"));
        JSONObject outcome = tombstone.getJSONObject("outcome");
        assertEquals("redacted", outcome.getString("type"));
        assertEquals(JSONObject.NULL, outcome.get("route"));
        assertEquals(JSONObject.NULL, outcome.get("relayMessageId"));
        assertEquals(JSONObject.NULL, outcome.get("failure"));
        assertEquals(200L, outcome.getLong("redactedAt"));
        assertFalse(outcome.getJSONObject("result").has("reply"));
        assertEquals("conversation-clear-redacted-v1", outcome.getJSONObject("result").getString("contract"));
        assertEquals(3L, outcome.getJSONObject("result").getLong("clearEpoch"));
        assertEquals(7L, outcome.getJSONObject("result").getLong("clearedThroughSequence"));
    }

    private static String repeatHex(char value) {
        char[] chars = new char[64];
        Arrays.fill(chars, value);
        return new String(chars);
    }
}
