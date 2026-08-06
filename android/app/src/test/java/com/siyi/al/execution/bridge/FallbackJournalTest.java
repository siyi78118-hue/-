package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.SyncCursorEntity;
import java.io.File;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class FallbackJournalTest {
    @Test public void packetKeepsExactSpeakerAndMarksFallbackOrigin() throws Exception {
        RawMessageEntity user = message("msg_user_1", "user", "user", "phone", 10L, "你在吗");
        RawMessageEntity reply = message("msg_reply_1", "yuqi", "character", "fallback", 11L, "在。刚才只是没接上。");
        JSONObject packet = FallbackJournal.buildPacket("phone_a", 9L, Arrays.asList(user, reply));

        assertEquals("phone_a", packet.getString("peerId"));
        assertEquals(11L, packet.getLong("lastSeq"));
        assertEquals("user", packet.getJSONArray("entries").getJSONObject(0).getJSONObject("payload").getString("speakerId"));
        assertEquals("fallback", packet.getJSONArray("entries").getJSONObject(1).getJSONObject("payload").getString("origin"));
        assertEquals(
            "f0d12a6ddc5cbfe922e02b27a527e061fd741c5d0a236fe36f98fbb8c04539b6",
            packet.getJSONArray("entries").getJSONObject(1).getString("checksum")
        );
    }

    @Test public void checksumMatchesJavascriptCanonicalJsonWhenContentContainsClosingTag() throws Exception {
        RawMessageEntity reply = message(
            "msg_slash",
            "yuqi",
            "character",
            "fallback",
            12L,
            "<al_schedule>{\"next\":\"later\"}</al_schedule>"
        );
        JSONObject packet = FallbackJournal.buildPacket("phone_a", 11L, Arrays.asList(reply));

        assertEquals(
            "05ad0d2a6abc19e6b6aa7b0b1af1b2e4dfe891107e7c8415864241b364b41af5",
            packet.getJSONArray("entries").getJSONObject(0).getString("checksum")
        );
    }

    @Test public void duplicateJournalSequencesFailClosedInsteadOfLettingAckSkipAnEntry() {
        RawMessageEntity first = message(
            "msg_duplicate_1", "user", "user", "phone", 21L, "第一条");
        RawMessageEntity second = message(
            "msg_duplicate_2", "yuqi", "character", "fallback", 21L, "第二条");

        assertThrows(IllegalArgumentException.class, () -> FallbackJournal.buildPacket(
            "phone_a", 20L, Arrays.asList(first, second)));
    }

    @Test public void authorityReceiptIsEnumeratedBeforeLaterMessageWithoutLeakingLocalModelInputs()
        throws Exception {
        JSONObject receipt = readFixture("android-fallback-authority-v2.json");
        JSONObject semantic = receipt.getJSONObject("semantic");
        if (!semantic.has("retryOfTurnId")) semantic.put("retryOfTurnId", JSONObject.NULL);
        String commitChecksum = BridgeAuthority.sha256CanonicalJson(semantic);
        receipt.put("commitChecksum", commitChecksum);
        receipt.getJSONObject("manifest")
            .put("semantic", new JSONObject(semantic.toString()))
            .put("commitChecksum", commitChecksum);
        long journalSyncSeq = semantic.getLong("journalSyncSeq");
        JSONObject checkpoint = new JSONObject()
            .put("version", 2)
            .put("localTurnId", semantic.getString("authoritativeTurnId"))
            .put("attemptId", "attempt_receipt_1")
            .put("attemptSequence", 1)
            .put("authoritativeTurnId", semantic.getString("authoritativeTurnId"))
            .put("authorityLineageKey", semantic.getString("authorityLineageKey"))
            .put("claimedLineageRevision", semantic.getLong("lineageRevisionAtCreation"))
            .put("retryOfTurnId", semantic.get("retryOfTurnId"))
            .put("laneKey", semantic.getString("laneKey"))
            .put("inputVisibilitySequence", semantic.getJSONObject("input").getLong("visibilitySequence"))
            .put("inputClearEpoch", semantic.getJSONObject("input").getLong("clearEpoch"))
            .put("normalizedEnvelope", new JSONObject()
                .put("protocolVersion", 3)
                .put("deviceId", semantic.getString("deviceId")))
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(new JSONObject()
                .put("protocolVersion", 3)
                .put("deviceId", semantic.getString("deviceId"))))
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "phone")
                .put("cognition", new JSONObject()
                    .put("configId", "secret-cognition")
                    .put("system", "private-system")
                    .put("messages", new JSONArray()))
                .put("expression", new JSONObject()
                    .put("configId", "secret-expression")
                    .put("system", "private-expression")
                    .put("messages", new JSONArray())))
            .put("journalSyncSeq", journalSyncSeq)
            .put("outcome", new JSONObject()
                .put("type", "committed")
                .put("route", "local")
                .put("relayMessageId", JSONObject.NULL)
                .put("failure", JSONObject.NULL)
                .put("result", receipt)
                .put("redactedAt", JSONObject.NULL));
        ExecutionAttemptEntity attempt = new ExecutionAttemptEntity();
        attempt.attemptId = "attempt_receipt_1";
        attempt.turnId = semantic.getString("authoritativeTurnId");
        attempt.sequence = 1;
        attempt.finishedAt = 1001L;
        attempt.bridgeAuthorityCheckpointJson = BridgeAuthority.canonicalJson(checkpoint);
        attempt.bridgeAuthorityCheckpointChecksum = BridgeAuthority.sha256CanonicalJson(checkpoint);
        RawMessageEntity later = message(
            "msg_after_receipt", "yuqi", "character", "android_fallback",
            journalSyncSeq + 1L, "稍后投影");

        JSONObject packet = FallbackJournal.buildPacket(
            "phone", journalSyncSeq - 1L, Collections.singletonList(later), Collections.emptyList(),
            Collections.singletonList(attempt), 1000);

        assertEquals(2, packet.getJSONArray("entries").length());
        JSONObject entry = packet.getJSONArray("entries").getJSONObject(0);
        assertEquals(journalSyncSeq, entry.getLong("seq"));
        assertEquals("authority_receipt", entry.getString("entityType"));
        assertEquals(semantic.getString("visibleGroupId"), entry.getString("entityId"));
        String publicEntry = entry.toString();
        assertEquals(false, publicEntry.contains("fallbackExecution"));
        assertEquals(false, publicEntry.contains("private-system"));
        assertEquals(commitChecksum, entry.getJSONObject("payload").getString("commitChecksum"));
    }

    @Test public void acknowledgeRejectsSequenceBeyondExportedEntries() {
        AtomicLong ack = new AtomicLong(0L);
        AlExecutionDao dao = ackDao(ack, 10L);
        FallbackJournal journal = new FallbackJournal(dao, "phone_a");

        assertThrows(IllegalArgumentException.class, () -> journal.acknowledge(11L));
        assertEquals(0L, ack.get());
    }

    @Test public void acknowledgeRemainsMonotonicAcrossRestartAndExactReplay() {
        AtomicLong ack = new AtomicLong(0L);
        AlExecutionDao dao = ackDao(ack, 5L, 10L);
        new FallbackJournal(dao, "phone_a").acknowledge(10L);
        new FallbackJournal(dao, "phone_a").acknowledge(5L);
        new FallbackJournal(dao, "phone_a").acknowledge(10L);

        assertEquals(10L, ack.get());
    }

    @Test public void concurrentStaleLowerAckCannotRegressAfterHigherWriter() throws Exception {
        AtomicLong ack = new AtomicLong(0L);
        AlExecutionDao dao = concurrentAckDao(ack, 5L, 10L);
        FallbackJournal first = new FallbackJournal(dao, "phone_a");
        FallbackJournal second = new FallbackJournal(dao, "phone_a");
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread high = new Thread(() -> {
            try { first.acknowledge(10L); } catch (Throwable error) { failure.set(error); }
        });
        Thread low = new Thread(() -> {
            try { second.acknowledge(5L); } catch (Throwable error) { failure.set(error); }
        });
        high.start();
        low.start();
        high.join(5000L);
        low.join(5000L);

        assertEquals(null, failure.get());
        assertEquals(10L, ack.get());
    }

    private static AlExecutionDao concurrentAckDao(AtomicLong ack, long... exportedSequences) {
        AlExecutionDao base = ackDao(ack, exportedSequences);
        CountDownLatch readers = new CountDownLatch(2);
        CountDownLatch highWritten = new CountDownLatch(1);
        AtomicLong reads = new AtomicLong();
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] {AlExecutionDao.class},
            (proxy, method, args) -> {
                String name = method.getName();
                if ("syncCursor".equals(name) && reads.getAndIncrement() < 2L) {
                    readers.countDown();
                    if (!readers.await(5L, TimeUnit.SECONDS)) throw new AssertionError("ack readers did not rendezvous");
                    SyncCursorEntity stale = new SyncCursorEntity();
                    stale.peerId = "yuqi_pc";
                    stale.ackSeq = 0L;
                    stale.updatedAt = 0L;
                    return stale;
                }
                if ("upsertSyncCursor".equals(name)) {
                    SyncCursorEntity value = (SyncCursorEntity) args[0];
                    if (value.ackSeq == 10L) highWritten.countDown();
                    if (value.ackSeq == 5L && !highWritten.await(5L, TimeUnit.SECONDS)) {
                        throw new AssertionError("high writer did not publish");
                    }
                }
                return method.invoke(base, args);
            }
        );
    }

    private static AlExecutionDao ackDao(AtomicLong ack, long... exportedSequences) {
        final java.util.List<RawMessageEntity> rows = new java.util.ArrayList<>();
        for (long sequence : exportedSequences) {
            rows.add(message("msg_ack_" + sequence, "yuqi", "character", "fallback", sequence, "ack"));
        }
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] {AlExecutionDao.class},
            (proxy, method, args) -> {
                String name = method.getName();
                if ("syncCursor".equals(name)) {
                    SyncCursorEntity value = new SyncCursorEntity();
                    value.peerId = "yuqi_pc";
                    value.ackSeq = ack.get();
                    value.updatedAt = 0L;
                    return value;
                }
                if ("rawMessagesAfterSync".equals(name)) {
                    long after = ((Number) args[1]).longValue();
                    return rows.stream().filter(row -> row.syncSeq > after)
                        .collect(java.util.stream.Collectors.toList());
                }
                if ("annotationsAfterSync".equals(name) || "authorityReceiptAttempts".equals(name)) {
                    return Collections.emptyList();
                }
                if ("upsertSyncCursor".equals(name)) {
                    SyncCursorEntity value = (SyncCursorEntity) args[0];
                    ack.set(value.ackSeq);
                    return null;
                }
                if ("insertSyncCursorIfAbsent".equals(name)) return 1L;
                if ("advanceSyncCursorMonotonic".equals(name)) {
                    long requested = ((Number) args[1]).longValue();
                    ack.updateAndGet(value -> Math.max(value, requested));
                    return 1;
                }
                if ("toString".equals(name)) return "ackDao";
                if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                if ("equals".equals(name)) return proxy == args[0];
                Class<?> returnType = method.getReturnType();
                if (returnType == boolean.class) return false;
                if (returnType == int.class || returnType == long.class) return 0;
                return null;
            }
        );
    }

    private static RawMessageEntity message(String id, String speakerId, String speakerType, String origin, long seq, String content) {
        RawMessageEntity value = new RawMessageEntity();
        value.messageId = id;
        value.turnId = "turn_1";
        value.characterId = "yuqi";
        value.speakerId = speakerId;
        value.speakerType = speakerType;
        value.recipientId = "user".equals(speakerId) ? "yuqi" : "user";
        value.content = content;
        value.sentAt = 1784400000000L + seq;
        value.origin = origin;
        value.deviceId = "fallback".equals(origin) ? "phone_a:fallback" : "phone_a";
        value.deviceSeq = seq;
        value.syncSeq = seq;
        return value;
    }

    private static JSONObject readFixture(String name) throws Exception {
        File root = new File(System.getProperty("user.dir", "."));
        File fixture = new File(root, "tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../../tests/fixtures/" + name);
        if (!fixture.isFile()) throw new IllegalStateException("fixture is missing: " + name);
        return new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
    }
}
