package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import com.siyi.al.execution.BridgeReceiptDeliveryCoordinator.AuthoritySnapshot;

public class BridgeReceiptDeliveryCoordinatorTest {
    @Test public void uiNotAppliedDoesNotSendAReceipt() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_visible", "turn_visible", "visible", null, null, false));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator.Outcome outcome = coordinator(store, transport).deliver("turn_visible");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.NOT_READY, outcome.status);
        assertTrue(transport.sent.isEmpty());
        assertNull(outcome.receipt);
    }

    @Test public void redactedAuthorityDoesNotSendAGroupReceipt() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_redacted", "turn_redacted", "visible", null, 120L, true));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator.Outcome outcome = coordinator(store, transport).deliver("turn_redacted");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.REDACTED, outcome.status);
        assertTrue(transport.sent.isEmpty());
    }

    @Test public void skipWithoutItemsOrRelayProducesOneStableReceipt() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_skip", "turn_skip", "skip", null, 130L, false));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator.Outcome outcome = coordinator(store, transport).deliver("turn_skip");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, outcome.status);
        assertEquals(1, transport.sent.size());
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt = transport.sent.get(0);
        assertEquals(3, receipt.protocolVersion);
        assertEquals("AUTHORITY_DELIVERY_RECEIPT", receipt.type);
        assertEquals("phone-1", receipt.peerId);
        assertEquals("turn_skip", receipt.turnId);
        assertEquals("skip", receipt.terminalDisposition);
        assertEquals(130L, receipt.deliveredAt);
        assertNull(receipt.relayMessageId);
        assertEquals(1, store.confirmCalls);
        assertEquals(receipt.idempotencyKey, BridgeAuthority.sha256CanonicalJson(new JSONObject(receipt.wireJson)));
        assertEquals(
            Arrays.asList(
                "authorityLineageKey", "commitChecksum", "deliveredAt", "peerId",
                "protocolVersion", "terminalDisposition", "turnId", "type", "visibleGroupId"),
            sortedKeys(receipt.wireJson));
    }

    @Test public void localAndRemoteTurnIdsRemainSeparateInTheClosedReceipt() throws Exception {
        FakeStore store = new FakeStore(snapshot("local_turn", "pc_turn", "visible", null, 141L, false));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator.Outcome outcome = coordinator(store, transport).deliver("local_turn");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, outcome.status);
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt = outcome.receipt;
        assertEquals("local_turn", receipt.localTurnId);
        assertEquals("pc_turn", receipt.turnId);
        assertEquals("phone-1", receipt.peerId);
        assertFalse(receipt.wireJson.contains("replyParts"));
        assertFalse(receipt.wireJson.contains("actions"));
    }

    @Test public void visibleReceiptIsStableAcrossDuplicateEventsAndRestart() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_visible", "pc_visible", "visible", null, 140L, false));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator first = coordinator(store, transport);
        BridgeReceiptDeliveryCoordinator.Outcome firstOutcome = first.deliver("turn_visible");
        BridgeReceiptDeliveryCoordinator.Outcome secondOutcome = first.deliver("turn_visible");
        BridgeReceiptDeliveryCoordinator.Outcome afterRestart = coordinator(store, transport).deliver("turn_visible");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, firstOutcome.status);
        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, secondOutcome.status);
        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, afterRestart.status);
        assertEquals(1, transport.sent.size());
        assertTrue(firstOutcome.receipt.sameIdentity(afterRestart.receipt));
        assertEquals(firstOutcome.receipt.deliveredAt, afterRestart.receipt.deliveredAt);
        assertEquals(firstOutcome.receipt.idempotencyKey, afterRestart.receipt.idempotencyKey);
    }

    @Test public void networkFailureRetriesWithSameReceiptIdentityAndDeliveredAt() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_visible", "pc_visible", "visible", null, 150L, false));
        RecordingTransport transport = new RecordingTransport();
        transport.failOnce = true;
        BridgeReceiptDeliveryCoordinator coordinator = coordinator(store, transport);

        BridgeReceiptDeliveryCoordinator.Outcome failed = coordinator.deliver("turn_visible");
        BridgeReceiptDeliveryCoordinator.Outcome retried = coordinator.deliver("turn_visible");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.RETRYABLE, failed.status);
        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, retried.status);
        assertEquals(2, transport.sent.size());
        assertTrue(transport.sent.get(0).sameIdentity(transport.sent.get(1)));
        assertEquals(transport.sent.get(0).deliveredAt, transport.sent.get(1).deliveredAt);
        assertEquals(transport.sent.get(0).idempotencyKey, transport.sent.get(1).idempotencyKey);
    }

    @Test public void confirmationUsesInjectedClockAndReplayKeepsTheFirstConfirmationTime()
        throws Exception {
        FakeStore store = new FakeStore(snapshot(
            "turn_confirmed_at", "pc_confirmed_at", "visible", null, 155L, false));
        RecordingTransport transport = new RecordingTransport();

        BridgeReceiptDeliveryCoordinator.Outcome first =
            coordinator(store, transport, 999L).deliver("turn_confirmed_at");
        BridgeReceiptDeliveryCoordinator.Outcome replay =
            coordinator(store, transport, 1200L).deliver("turn_confirmed_at");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, first.status);
        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, replay.status);
        assertEquals(155L, first.receipt.deliveredAt);
        assertEquals(Long.valueOf(999L), store.firstConfirmedAt);
        assertEquals(1, store.confirmCalls);
        assertEquals(1, transport.sent.size());
    }

    @Test public void remoteAcceptanceWithLocalCasFailureRetriesSameReceiptAndRejectsChangedAuthority() throws Exception {
        FakeStore store = new FakeStore(snapshot("turn_visible", "pc_visible", "visible", null, 160L, false));
        RecordingTransport transport = new RecordingTransport();
        store.confirmResult = BridgeReceiptDeliveryCoordinator.ConfirmationResult.RETRYABLE;
        BridgeReceiptDeliveryCoordinator coordinator = coordinator(store, transport);

        BridgeReceiptDeliveryCoordinator.Outcome first = coordinator.deliver("turn_visible");
        store.confirmResult = BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        BridgeReceiptDeliveryCoordinator.Outcome second = coordinator.deliver("turn_visible");

        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.RETRYABLE, first.status);
        assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, second.status);
        assertEquals(2, transport.sent.size());
        assertTrue(transport.sent.get(0).sameIdentity(transport.sent.get(1)));

        FakeStore changed = mutatedStore(
            snapshot("local_changed", "pc_visible", "visible", null, 160L, false),
            mutation("remote turn", value -> value.put("turnId", "pc_changed")), true);
        RecordingTransport changedTransport = new RecordingTransport();
        try {
            coordinator(changed, changedTransport).deliver("local_changed");
            fail("changed authority must be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("receipt"));
        }
        assertEquals(1, changed.confirmCalls);
        assertEquals(0, changed.confirmPushes);
    }

    @Test public void changedAuthorityFieldsFailClosedWithZeroStoreWrites() throws Exception {
        List<MutationCase> cases = Arrays.asList(
            mutation("remote turn", value -> value.put("turnId", "pc_changed")),
            mutation("lineage", value -> {
                value.put("authorityLineageKey", "lineage_changed");
                value.put("visibleGroupId", AuthorityIdentity.groupId("lineage_changed"));
            }),
            mutation("group", value -> value.put("visibleGroupId", AuthorityIdentity.groupId("forged"))),
            mutation("commit checksum", value -> value.put("commitChecksum", repeat('b', 64))),
            mutation("disposition", value -> {
                value.put("terminalDisposition", "skip");
                value.put("replyParts", new JSONArray());
            }),
            mutation("route", value -> {}),
            mutation("relay", value -> {}));
        for (MutationCase mutation : cases) {
            AuthoritySnapshotPair pair = mutatedPair(
                snapshot("local_" + mutation.name, "pc_" + mutation.name, "visible", null, 170L, false),
                mutation,
                true);
            FakeStore store = new FakeStore(pair.canonical);
            store.presented = pair.presented;
            RecordingTransport transport = new RecordingTransport();
            try {
                coordinator(store, transport).deliver(pair.presented.localTurnId);
                fail(mutation.name + " must be rejected");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("authority")
                    || expected.getMessage().contains("receipt"));
            }
            assertEquals(0, store.confirmPushes);
        }
    }

    @Test public void changedCheckpointChecksumIsRejectedBeforeTransport() throws Exception {
        AuthoritySnapshotPair pair = mutatedPair(
            snapshot("local_checksum", "pc_checksum", "visible", null, 180L, false),
            mutation("checksum", value -> value.put("turnId", "pc_changed")),
            false);
        FakeStore store = new FakeStore(pair.canonical);
        store.presented = pair.presented;
        RecordingTransport transport = new RecordingTransport();

        try {
            coordinator(store, transport).deliver("local_checksum");
            fail("stale checkpoint checksum must be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("checksum"));
        }
        assertTrue(transport.sent.isEmpty());
        assertEquals(0, store.confirmCalls);
    }

    @Test public void changedPeerIsRejectedByExactCasWithoutAWrite() throws Exception {
        AuthoritySnapshot canonical = snapshot("local_peer", "pc_peer", "visible", null, 181L, false);
        AuthoritySnapshotPair pair = new AuthoritySnapshotPair(
            canonical,
            new AuthoritySnapshot(
                canonical.localTurnId, canonical.checkpointJson, canonical.checkpointChecksum,
                canonical.uiAppliedAt, canonical.redacted, canonical.cloudConfirmed,
                "foreign-phone", canonical.route, canonical.relayMessageId));
        FakeStore store = new FakeStore(pair.canonical);
        store.presented = pair.presented;
        RecordingTransport transport = new RecordingTransport();
        try {
            coordinator(store, transport).deliver("local_peer");
            fail("foreign peer must be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("receipt"));
        }
        assertEquals(0, store.confirmPushes);
    }

    @Test public void twoCoordinatorsShareOneCasAndSendIdenticalBytes() throws Exception {
        FakeStore store = new FakeStore(snapshot("local_concurrent", "pc_concurrent", "visible", null, 190L, false));
        RecordingTransport firstTransport = new RecordingTransport();
        RecordingTransport secondTransport = new RecordingTransport();
        CountDownLatch bothSendersEntered = new CountDownLatch(2);
        firstTransport.sendBarrier = bothSendersEntered;
        secondTransport.sendBarrier = bothSendersEntered;
        BridgeReceiptDeliveryCoordinator first = coordinator(store, firstTransport);
        BridgeReceiptDeliveryCoordinator second = coordinator(store, secondTransport);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<BridgeReceiptDeliveryCoordinator.Outcome> one = pool.submit(
                () -> first.deliver("local_concurrent"));
            Future<BridgeReceiptDeliveryCoordinator.Outcome> two = pool.submit(
                () -> second.deliver("local_concurrent"));
            assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, one.get().status);
            assertEquals(BridgeReceiptDeliveryCoordinator.OutcomeStatus.CONFIRMED, two.get().status);
        } finally {
            pool.shutdownNow();
        }
        assertEquals(2, firstTransport.sent.size() + secondTransport.sent.size());
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt firstReceipt = firstTransport.sent.isEmpty()
            ? secondTransport.sent.get(0) : firstTransport.sent.get(0);
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt secondReceipt = firstTransport.sent.isEmpty()
            ? secondTransport.sent.get(1) : secondTransport.sent.get(0);
        assertTrue(firstReceipt.sameIdentity(secondReceipt));
        assertEquals(firstReceipt.wireJson, secondReceipt.wireJson);
        assertEquals(firstReceipt.idempotencyKey, secondReceipt.idempotencyKey);
        assertEquals(1, store.confirmPushes);
    }

    private static BridgeReceiptDeliveryCoordinator coordinator(
        FakeStore store, RecordingTransport transport
    ) {
        return coordinator(store, transport, 900L);
    }

    private static BridgeReceiptDeliveryCoordinator coordinator(
        FakeStore store, RecordingTransport transport, long now
    ) {
        return new BridgeReceiptDeliveryCoordinator(store, transport, () -> now);
    }

    private static AuthoritySnapshot snapshot(
        String localTurnId, String remoteTurnId, String disposition, String relayMessageId,
        Long uiAppliedAt, boolean redacted
    ) throws Exception {
        String lineageKey = "lineage_" + remoteTurnId;
        JSONObject payload = new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", remoteTurnId)
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineageKey))
            .put("lineageRevision", 1)
            .put("turnRevision", 1)
            .put("laneKey", "private_chat")
            .put("laneRevision", 1)
            .put("inputVisibilitySequence", 1)
            .put("inputClearEpoch", 0)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", disposition)
            .put("replyParts", replyParts(disposition, lineageKey))
            .put("actions", new JSONArray());
        String route = relayMessageId == null ? "lan" : "cloud";
        JSONObject checkpoint = new JSONObject()
            .put("version", 1)
            .put("localTurnId", localTurnId)
            .put("attemptId", "attempt_" + localTurnId)
            .put("attemptSequence", 1)
            .put("authoritativeTurnId", remoteTurnId)
            .put("authorityLineageKey", lineageKey)
            .put("claimedLineageRevision", 1)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 1)
            .put("inputClearEpoch", 0)
            .put("normalizedEnvelope", new JSONObject()
                .put("protocolVersion", 3)
                .put("turnId", remoteTurnId)
                .put("characterId", "yuqi")
                .put("deviceId", "device_123456")
                .put("deviceSeq", 1)
                .put("createdAt", 1784400000000L)
                .put("authority", new JSONObject()
                    .put("lineageKey", lineageKey)
                    .put("claimedLineageRevision", 1)
                    .put("laneKey", "private_chat")
                    .put("retryOfTurnId", JSONObject.NULL))
                .put("context", new JSONObject().put("visibilityCursor", new JSONObject()
                    .put("nativeCompletedTurnId", JSONObject.NULL)
                    .put("nativeCompletedGroupId", JSONObject.NULL)
                    .put("nativeCompletedSequence", 0)
                    .put("uiAppliedTurnId", JSONObject.NULL)
                    .put("uiAppliedGroupId", JSONObject.NULL)
                    .put("uiAppliedSequence", 0)
                    .put("localSequence", 1)
                    .put("clearedThroughSequence", 0)
                    .put("clearEpoch", 0)
                    .put("clearedAt", JSONObject.NULL)
                    .put("chatOpen", false)
                    .put("quotedMessageId", JSONObject.NULL))))
            .put("envelopeChecksum", repeat('e', 64))
            .put("outcome", new JSONObject()
                .put("type", "committed")
                .put("route", route)
                .put("relayMessageId", relayMessageId == null ? JSONObject.NULL : relayMessageId)
                .put("failure", JSONObject.NULL)
                .put("result", payload)
                .put("redactedAt", JSONObject.NULL));
        String checkpointJson = BridgeAuthority.canonicalJson(checkpoint);
        return new AuthoritySnapshot(
            localTurnId,
            checkpointJson,
            BridgeAuthority.sha256CanonicalJson(checkpoint),
            uiAppliedAt,
            redacted,
            false,
            "phone-1",
            route,
            relayMessageId);
    }

    private static JSONArray replyParts(String disposition, String lineageKey) throws Exception {
        if (!"visible".equals(disposition)) return new JSONArray();
        String groupId = AuthorityIdentity.groupId(lineageKey);
        JSONObject part = new JSONObject()
            .put("content", "hello")
            .put("speakerId", "yuqi")
            .put("speakerType", "character")
            .put("recipientId", "user")
            .put("messageId", AuthorityIdentity.messageId(groupId, 0))
            .put("ordinal", 0);
        JSONObject semantic = new JSONObject(part.toString());
        semantic.remove("messageId");
        semantic.remove("ordinal");
        part.put("itemChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
        return new JSONArray().put(part);
    }

    private static AuthoritySnapshotPair mutatedPair(
        AuthoritySnapshot canonical, MutationCase mutation, boolean recomputeChecksum
    ) throws Exception {
        JSONObject checkpoint = new JSONObject(canonical.checkpointJson);
        JSONObject outcome = checkpoint.getJSONObject("outcome");
        JSONObject result = outcome.getJSONObject("result");
        if ("route".equals(mutation.name)) {
            outcome.put("route", "lan".equals(outcome.getString("route")) ? "cloud" : "lan");
        } else if ("relay".equals(mutation.name)) {
            outcome.put("relayMessageId", "relay_changed");
        } else {
            mutation.mutate(result);
        }
        String checkpointJson = BridgeAuthority.canonicalJson(checkpoint);
        String checksum = recomputeChecksum
            ? BridgeAuthority.sha256CanonicalJson(checkpoint) : canonical.checkpointChecksum;
        AuthoritySnapshot presented = new AuthoritySnapshot(
            canonical.localTurnId,
            checkpointJson,
            checksum,
            canonical.uiAppliedAt,
            canonical.redacted,
            canonical.cloudConfirmed,
            canonical.peerId,
            checkpoint.optString("origin", canonical.route),
            outcome.isNull("relayMessageId") ? null : outcome.getString("relayMessageId"));
        return new AuthoritySnapshotPair(canonical, presented);
    }

    private static FakeStore mutatedStore(AuthoritySnapshot canonical, MutationCase mutation, boolean recompute)
        throws Exception {
        AuthoritySnapshotPair pair = mutatedPair(canonical, mutation, recompute);
        FakeStore store = new FakeStore(pair.canonical);
        store.presented = pair.presented;
        return store;
    }

    private static MutationCase mutation(String name, Mutation mutation) {
        return new MutationCase(name, mutation);
    }

    private static String repeat(char value, int length) {
        char[] values = new char[length];
        Arrays.fill(values, value);
        return new String(values);
    }

    private static List<String> sortedKeys(String wireJson) throws Exception {
        List<String> keys = new ArrayList<>();
        JSONObject value = new JSONObject(wireJson);
        java.util.Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        Collections.sort(keys);
        return keys;
    }

    private interface Mutation {
        void apply(JSONObject value) throws Exception;
    }

    private static final class MutationCase {
        private final String name;
        private final Mutation mutation;

        MutationCase(String name, Mutation mutation) {
            this.name = name;
            this.mutation = mutation;
        }

        void mutate(JSONObject value) throws Exception {
            mutation.apply(value);
        }
    }

    private static final class AuthoritySnapshotPair {
        private final AuthoritySnapshot canonical;
        private final AuthoritySnapshot presented;

        AuthoritySnapshotPair(AuthoritySnapshot canonical, AuthoritySnapshot presented) {
            this.canonical = canonical;
            this.presented = presented;
        }
    }

    private static final class FakeStore implements BridgeReceiptDeliveryCoordinator.Store {
        private final AuthoritySnapshot canonical;
        private AuthoritySnapshot presented;
        private final String expectedRemoteTurnId;
        private final String expectedLineage;
        private final String expectedGroup;
        private final String expectedCommit;
        private final String expectedDisposition;
        private final String expectedPeer;
        private final String expectedRoute;
        private final String expectedRelay;
        private final long expectedDeliveredAt;
        private final String expectedCheckpointChecksum;
        private BridgeReceiptDeliveryCoordinator.ConfirmationResult confirmResult
            = BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        private int confirmCalls;
        private int confirmPushes;
        private boolean confirmed;
        private Long firstConfirmedAt;

        FakeStore(AuthoritySnapshot canonical) throws Exception {
            this.canonical = canonical;
            this.presented = canonical;
            JSONObject checkpoint = new JSONObject(canonical.checkpointJson);
            JSONObject payload = checkpoint.getJSONObject("outcome").getJSONObject("result");
            assertNotNull(payload);
            expectedRemoteTurnId = payload.getString("turnId");
            expectedLineage = payload.getString("authorityLineageKey");
            expectedGroup = payload.getString("visibleGroupId");
            expectedCommit = payload.getString("commitChecksum");
            expectedDisposition = payload.getString("terminalDisposition");
            expectedPeer = canonical.peerId;
            expectedRoute = checkpoint.getJSONObject("outcome").getString("route");
            expectedRelay = checkpoint.getJSONObject("outcome").isNull("relayMessageId")
                ? null : checkpoint.getJSONObject("outcome").getString("relayMessageId");
            expectedDeliveredAt = canonical.uiAppliedAt == null ? -1L : canonical.uiAppliedAt;
            expectedCheckpointChecksum = canonical.checkpointChecksum;
        }

        @Override public synchronized BridgeReceiptDeliveryCoordinator.AuthoritySnapshot readAuthority(
            String localTurnId
        ) {
            if (!presented.localTurnId.equals(localTurnId)) return null;
            return new AuthoritySnapshot(
                presented.localTurnId, presented.checkpointJson, presented.checkpointChecksum,
                presented.uiAppliedAt, presented.redacted, confirmed,
                presented.peerId, presented.route, presented.relayMessageId);
        }

        @Override public synchronized BridgeReceiptDeliveryCoordinator.ConfirmationResult confirmCloudReceiptExact(
            BridgeReceiptDeliveryCoordinator.AuthorityReceipt expected,
            long confirmedAt
        ) {
            confirmCalls += 1;
            if (!expected.localTurnId.equals(canonical.localTurnId)
                || !expected.turnId.equals(expectedRemoteTurnId)
                || !expected.authorityLineageKey.equals(expectedLineage)
                || !expected.visibleGroupId.equals(expectedGroup)
                || !expected.commitChecksum.equals(expectedCommit)
                || !expected.terminalDisposition.equals(expectedDisposition)
                || expected.deliveredAt != expectedDeliveredAt
                || !expected.peerId.equals(expectedPeer)
                || !expected.checkpointChecksum.equals(expectedCheckpointChecksum)
                || !equals(expected.route, expectedRoute)
                || !equals(expected.relayMessageId, expectedRelay)) {
                return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFLICT;
            }
            if (confirmResult == BridgeReceiptDeliveryCoordinator.ConfirmationResult.RETRYABLE) {
                return confirmResult;
            }
            if (!confirmed) confirmPushes += 1;
            if (!confirmed) firstConfirmedAt = confirmedAt;
            confirmed = true;
            return BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED;
        }

        private static boolean equals(String left, String right) {
            return left == null ? right == null : left.equals(right);
        }
    }

    private static final class RecordingTransport implements BridgeReceiptDeliveryCoordinator.Transport {
        private final List<BridgeReceiptDeliveryCoordinator.AuthorityReceipt> sent =
            Collections.synchronizedList(new ArrayList<>());
        private boolean failOnce;
        private CountDownLatch sendBarrier;

        @Override public void send(BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt) throws Exception {
            sent.add(receipt);
            if (sendBarrier != null) {
                sendBarrier.countDown();
                if (!sendBarrier.await(5L, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("concurrent receipt send barrier timeout");
                }
            }
            if (failOnce) {
                failOnce = false;
                throw new Exception("network unavailable");
            }
        }
    }
}
