package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Proxy;
import org.json.JSONObject;
import org.junit.Test;

/** Pure 20C.1 contract tests; the Room-backed sender is exercised by instrumentation. */
public class LifecycleControlSenderTest {
    @Test
    public void identitiesAreStableAndBoundToTheClosedControlProof() {
        LifecycleControl first = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        LifecycleControl same = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        LifecycleControl changed = control(LifecycleControl.WAITING, null, null, null, null, 1L);

        assertEquals(LifecycleControlSender.leaseId(first, 1L),
            LifecycleControlSender.leaseId(same, 1L));
        assertEquals(LifecycleControlSender.relayMessageId(first),
            LifecycleControlSender.relayMessageId(same));
        assertEquals(LifecycleControlSender.idempotencyKey(first),
            LifecycleControlSender.idempotencyKey(same));
        assertNotEquals(LifecycleControlSender.leaseId(first, 1L),
            LifecycleControlSender.leaseId(changed, 1L));
        assertNotEquals(LifecycleControlSender.relayMessageId(first),
            LifecycleControlSender.relayMessageId(changed));
        assertEquals(
            "ctllease_12693e34c94869e7ad561dd5f7b94e4554c9c8071ca55cad6842afcfa8143a7b",
            LifecycleControlSender.leaseId(first, 1L));
        assertEquals(
            "ctlmsg_01571c2fad6f5c408b3dfbeb3edfcfef752832eb182270984146174b475dc8f5",
            LifecycleControlSender.relayMessageId(first));
        assertEquals(
            "ctlidem_af1e473c15eb1ff29b023dd21a438a43b0e0ed82c4bcc00fcbdd956a19f830ba",
            LifecycleControlSender.idempotencyKey(first));
    }

    @Test
    public void leaseAndRefreshBoundariesAreStrict() {
        LifecycleControl pending = control(
            LifecycleControl.PENDING, "lease-1", 100L, null, 500L, 1L);
        LifecycleControl accepted = control(
            LifecycleControl.RELAY_ACCEPTED, "lease-1", 100L, "relay-1", 100_000_000L, 1L);

        assertFalse(LifecycleControlSender.leaseExpired(pending, 60_099L));
        assertTrue(LifecycleControlSender.leaseExpired(pending, 60_100L));
        assertFalse(LifecycleControlSender.refreshable(accepted, 99L));
        assertTrue(LifecycleControlSender.refreshable(
            accepted, 100_000_000L - 24L * 60L * 60L * 1000L));
        assertTrue(LifecycleControlSender.refreshable(accepted, 100_000_000L));
    }

    @Test
    public void appliedAckInnerBodyIsClosedAndBoundToControl() throws Exception {
        LifecycleControl control = control(
            LifecycleControl.WAITING, null, null, null, null, 0L);
        JSONObject ack = LifecycleControlSender.encodeAppliedAck(control, 300L);
        LifecycleControlSender.validateAppliedAck(ack, control);
        assertEquals(10, ack.length());
        assertEquals(3L, ack.getLong("protocolVersion"));
        assertEquals("CONVERSATION_CLEAR_APPLIED", ack.getString("type"));

        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("peerId", "foreign"), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("clearEpoch", "1"), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("protocolVersion", "3"), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("type", "CONVERSATION_CLEAR"), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("checksum", repeat('e')), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("secret", "leak"), control));
        assertThrows(IllegalArgumentException.class, () -> LifecycleControlSender.validateAppliedAck(
            new JSONObject(ack.toString()).put("appliedAt", 0L), control));
    }

    @Test
    public void roleDeleteAppliedAckIsTheClosedNineFieldReceiptBoundToBackup() throws Exception {
        LifecycleControl control = roleDeleteControl(
            LifecycleControl.WAITING, null, null, null, null, 0L);
        JSONObject ack = LifecycleControlSender.encodeAppliedAck(control, 300L);

        LifecycleControlSender.validateAppliedAckShape(ack);
        LifecycleControlSender.validateAppliedAck(ack, control);
        assertEquals(9, ack.length());
        assertEquals("ROLE_DELETE_APPLIED", ack.getString("type"));
        assertEquals(
            new JSONObject(control.semanticJson).getJSONObject("backupReceipt").getString("receiptId"),
            ack.getString("backupReceiptId"));
        assertFalse(ack.has("clearEpoch"));
        assertFalse(ack.has("clearedThroughSequence"));

        JSONObject changedReceipt = new JSONObject(ack.toString())
            .put("backupReceiptId", "backup_yuqi_2");
        changedReceipt.put("checksum", BridgeAuthority.sha256CanonicalJson(
            without(changedReceipt, "checksum")));
        assertThrows(IllegalArgumentException.class,
            () -> LifecycleControlSender.validateAppliedAck(changedReceipt, control));
    }

    @Test
    public void appliedAckShapeIsSelfContainedAndRejectsNativeCoercion() throws Exception {
        LifecycleControl control = control(
            LifecycleControl.WAITING, null, null, null, null, 0L);
        JSONObject ack = LifecycleControlSender.encodeAppliedAck(control, 300L);
        LifecycleControlSender.validateAppliedAckShape(ack);

        JSONObject stringProtocol = new JSONObject(ack.toString()).put("protocolVersion", "3");
        stringProtocol.put("checksum", BridgeAuthority.sha256CanonicalJson(
            without(stringProtocol, "checksum")));
        assertThrows(IllegalArgumentException.class,
            () -> LifecycleControlSender.validateAppliedAckShape(stringProtocol));

        JSONObject arrayId = new JSONObject(ack.toString()).put("controlId", new org.json.JSONArray());
        arrayId.put("checksum", BridgeAuthority.sha256CanonicalJson(without(arrayId, "checksum")));
        assertThrows(IllegalArgumentException.class,
            () -> LifecycleControlSender.validateAppliedAckShape(arrayId));

        JSONObject extra = new JSONObject(ack.toString()).put("extra", true);
        assertThrows(IllegalArgumentException.class,
            () -> LifecycleControlSender.validateAppliedAckShape(extra));
    }

    private static JSONObject without(JSONObject source, String key) throws Exception {
        JSONObject copy = new JSONObject();
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String current = keys.next();
            if (!key.equals(current)) copy.put(current, source.get(current));
        }
        return copy;
    }

    @Test
    public void appliedAckConflictClassifierIsClosed() {
        assertTrue(LifecycleControlSender.isAppliedAckConflict(
            new IllegalArgumentException("invalid lifecycle ACK header")));
        assertTrue(LifecycleControlSender.isAppliedAckConflict(
            new IllegalArgumentException("lifecycle applied ACK authority conflict")));
        assertFalse(LifecycleControlSender.isAppliedAckConflict(
            new IllegalArgumentException("arbitrary lifecycle conflict")));
        assertFalse(LifecycleControlSender.isAppliedAckConflict(
            new IllegalStateException("SQLITE_BUSY")));
    }

    @Test
    public void drainAppliesLanProofOnlyAfterIndependentRouteSuccess() throws Exception {
        LifecycleControl clear = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] applyCalls = {0};
        ExecutionStore store = fakeStore(clear, applyCalls, new int[] {0}, new int[] {0});
        int[] routeCalls = {0};

        assertTrue(LifecycleControlSender.drainOne(
            store,
            (ignored, relayId, idempotency, expiresAt) -> {
                routeCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(true, null, 0L, 1_100L);
            },
            false,
            1_000L
        ));
        assertEquals(1, routeCalls[0]);
        assertEquals(1, applyCalls[0]);
    }

    @Test
    public void roleDeleteIsSentAndAppliedByTheSharedLifecycleDrain() throws Exception {
        LifecycleControl roleDelete = roleDeleteControl(
            LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] applyCalls = {0};
        ExecutionStore store = fakeStore(roleDelete, applyCalls, new int[] {0}, new int[] {0});
        int[] routeCalls = {0};

        assertTrue(LifecycleControlSender.drainOne(
            store,
            (ignored, relayId, idempotency, expiresAt) -> {
                routeCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(true, null, 0L, 1_100L);
            },
            false,
            1_000L
        ));
        assertEquals(1, routeCalls[0]);
        assertEquals(1, applyCalls[0]);
    }

    @Test
    public void roleDeleteLanPendingProofKeepsTheClaimForRetryWithoutCloudFallback() throws Exception {
        LifecycleControl roleDelete = roleDeleteControl(
            LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] applyCalls = {0};
        int[] lanCalls = {0};
        int[] cloudCalls = {0};
        ExecutionStore store = fakeStore(roleDelete, applyCalls, new int[] {0}, new int[] {0});

        assertFalse(LifecycleControlSender.drainOneAuto(
            store,
            (ignored, relayId, idempotency, expiresAt) -> {
                lanCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(false, null, 0L, 0L);
            },
            (ignored, relayId, idempotency, expiresAt) -> {
                cloudCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(false, relayId, expiresAt);
            },
            1_000L
        ));
        assertEquals(1, lanCalls[0]);
        assertEquals(0, applyCalls[0]);
        assertEquals(0, cloudCalls[0]);
    }

    @Test
    public void cloudAcceptanceStoresStableRelayProofExactlyOnce() throws Exception {
        LifecycleControl clear = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] acceptCalls = {0};
        ExecutionStore store = fakeStore(clear, new int[] {0}, acceptCalls, new int[] {0});
        String expectedRelay = LifecycleControlSender.relayMessageId(clear);
        long expiry = 1_000L + 86_400_000L;

        assertTrue(LifecycleControlSender.drainOne(
            store,
            (ignored, relayId, idempotency, expiresAt) -> {
                assertEquals(expectedRelay, relayId);
                assertEquals(LifecycleControlSender.idempotencyKey(clear), idempotency);
                assertEquals(expiry, expiresAt);
                return new LifecycleControlSender.ControlDelivery(false, relayId, expiresAt);
            },
            true,
            1_000L
        ));
        assertEquals(1, acceptCalls[0]);
    }

    @Test
    public void autoRouteFallsBackWithinOneClaimedLease() throws Exception {
        LifecycleControl clear = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] applyCalls = {0};
        int[] acceptCalls = {0};
        int[] claimCalls = {0};
        ExecutionStore store = fakeStore(clear, applyCalls, acceptCalls, claimCalls);
        int[] lanCalls = {0};
        int[] cloudCalls = {0};

        assertTrue(LifecycleControlSender.drainOneAuto(
            store,
            (ignored, relayId, idempotency, expiresAt) -> {
                lanCalls[0] += 1;
                throw new java.io.IOException("LAN timeout");
            },
            (ignored, relayId, idempotency, expiresAt) -> {
                cloudCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(false, relayId, expiresAt);
            },
            1_000L
        ));
        assertEquals(1, claimCalls[0]);
        assertEquals(1, lanCalls[0]);
        assertEquals(1, cloudCalls[0]);
        assertEquals(1, acceptCalls[0]);
    }

    @Test
    public void autoRouteDoesNotFallbackAfterLocalAuthorityCasFailure() throws Exception {
        LifecycleControl clear = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        int[] cloudCalls = {0};
        ExecutionStore store = (ExecutionStore) Proxy.newProxyInstance(
            ExecutionStore.class.getClassLoader(), new Class<?>[] {ExecutionStore.class},
            (proxy, method, args) -> {
                if ("claimLifecycleControl".equals(method.getName())) return clear;
                if ("applyLifecycleControl".equals(method.getName())) {
                    throw new IllegalStateException("lifecycle authority conflict");
                }
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == long.class) return 0L;
                return null;
            }
        );

        assertThrows(IllegalStateException.class, () -> LifecycleControlSender.drainOneAuto(
            store,
            (ignored, relayId, idempotency, expiresAt) ->
                new LifecycleControlSender.ControlDelivery(true, null, 0L, 1_100L),
            (ignored, relayId, idempotency, expiresAt) -> {
                cloudCalls[0] += 1;
                return new LifecycleControlSender.ControlDelivery(false, relayId, expiresAt);
            },
            1_000L
        ));
        assertEquals(0, cloudCalls[0]);
    }

    @Test
    public void nextEligibleAtUsesWaitingNowLeaseExpiryAndRelayRefreshWindow() {
        LifecycleControl waiting = control(LifecycleControl.WAITING, null, null, null, null, 0L);
        LifecycleControl pending = control(LifecycleControl.PENDING, "lease-1", 1_000L, null, null, 1L);
        LifecycleControl accepted = control(
            LifecycleControl.RELAY_ACCEPTED, "lease-1", 1_000L, "relay-1", 100_000_000L, 1L);

        assertEquals(1_000L, LifecycleControlSender.nextEligibleAt(waiting, 1_000L));
        assertEquals(61_000L, LifecycleControlSender.nextEligibleAt(pending, 1_000L));
        assertEquals(
            100_000_000L - LifecycleControlSender.REFRESH_WINDOW_MILLIS,
            LifecycleControlSender.nextEligibleAt(accepted, 1_000L));
    }

    private static ExecutionStore fakeStore(
        LifecycleControl control, int[] applyCalls, int[] acceptCalls, int[] claimCalls
    ) {
        return (ExecutionStore) Proxy.newProxyInstance(
            ExecutionStore.class.getClassLoader(), new Class<?>[] {ExecutionStore.class},
            (proxy, method, args) -> {
                if ("claimLifecycleControl".equals(method.getName())) {
                    claimCalls[0] += 1;
                    return control;
                }
                if ("applyLifecycleControl".equals(method.getName())) {
                    applyCalls[0] += 1;
                    return true;
                }
                if ("acceptLifecycleRelay".equals(method.getName())) {
                    acceptCalls[0] += 1;
                    return true;
                }
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == long.class) return 0L;
                return null;
            }
        );
    }

    private static LifecycleControl control(
        String state, String leaseId, Long leasedAt, String relayId,
        Long relayExpiresAt, long leaseAttempt
    ) {
        return new LifecycleControl(
            "ctl_" + repeat(leaseAttempt == 0L ? 'a' : 'c'), LifecycleControl.CLEAR_KIND, "yuqi", "device-1",
            1L, 7L, 100L, "{}", repeat(leaseAttempt == 0L ? 'b' : 'd'), state, leaseId, leaseAttempt,
            leasedAt, relayId, null, relayExpiresAt, 100L
        );
    }

    private static LifecycleControl roleDeleteControl(
        String state, String leaseId, Long leasedAt, String relayId,
        Long relayExpiresAt, long leaseAttempt
    ) throws Exception {
        JSONObject idBasis = new JSONObject()
            .put("contract", "yuqi-backup-receipt-id-v1")
            .put("roleId", "yuqi")
            .put("manifestChecksum", repeat('1'))
            .put("snapshotSha256", repeat('2'))
            .put("logicalChecksum", repeat('3'))
            .put("createdAt", 90L);
        JSONObject receipt = new JSONObject()
            .put("receiptVersion", "yuqi-backup-receipt-v1")
            .put("receiptId", "bkrcpt_"
                + BridgeAuthority.sha256CanonicalJson(idBasis).substring(0, 24))
            .put("roleId", "yuqi")
            .put("manifestChecksum", repeat('1'))
            .put("snapshotSha256", repeat('2'))
            .put("logicalChecksum", repeat('3'))
            .put("createdAt", 90L);
        receipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(
            without(receipt, "receiptChecksum")));
        LifecycleControlCodec.Encoded encoded = LifecycleControlCodec.encodeRoleDelete(
            "yuqi", "device-1", 100L, receipt);
        return new LifecycleControl(
            encoded.controlId, LifecycleControl.ROLE_DELETE_KIND, "yuqi", "device-1",
            null, null, 100L, encoded.semantic.toString(), encoded.semanticChecksum,
            state, leaseId, leaseAttempt, leasedAt, relayId, null, relayExpiresAt, 100L
        );
    }

    private static String repeat(char value) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < 64; index += 1) result.append(value);
        return result.toString();
    }
}
