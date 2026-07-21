package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import org.junit.Test;

public class RoomBridgeMirrorTest {
    @Test public void automaticTurnNeverCreatesAFabricatedUserRow() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        RoomBridgeMirror mirror = new RoomBridgeMirror(dao(inserted), "phone_a");
        TurnSubmission trigger = new TurnSubmission(
            "turn_proactive_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{}", "{}", "job_1", 1784400000000L
        );

        mirror.persistSubmission(trigger);

        assertEquals(0, inserted.size());
    }

    @Test public void replyPersistsTheExactOriginSuppliedByTheBridgeResult() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        RoomBridgeMirror mirror = new RoomBridgeMirror(dao(inserted), "phone_a");
        TurnSubmission turn = new TurnSubmission(
            "turn_phone_1", "yuqi", "msg_phone_1", TurnKind.DIRECT_REPLY,
            "{\"text\":\"你好\"}", "{}", null, 1784400000000L
        );

        mirror.persistReply(turn, BridgeResult.success("cloud", "我在。"));

        assertEquals(1, inserted.size());
        assertEquals("yuqi", inserted.get(0).speakerId);
        assertEquals("character", inserted.get(0).speakerType);
        assertEquals("cloud", inserted.get(0).origin);
        assertEquals(0L, inserted.get(0).syncSeq);
    }

    @Test public void fallbackReplyUsesTheRecoverableFallbackOrigin() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        RoomBridgeMirror mirror = new RoomBridgeMirror(dao(inserted), "phone_a");
        TurnSubmission turn = new TurnSubmission(
            "turn_phone_2", "yuqi", "msg_phone_2", TurnKind.DIRECT_REPLY,
            "{\"text\":\"你好\"}", "{}", null, 1784400000100L
        );
        BridgeResult fallback = BridgeResult.success("chat-api", "我在。")
            .routed(Arrays.asList("lan", "cloud", "fallback"), true);

        mirror.persistReply(turn, fallback);

        assertEquals("fallback", inserted.get(0).origin);
        assertEquals(1L, inserted.get(0).syncSeq);
    }

    @Test public void cloudReplyPreservesThePcMessageIdentityAndOriginalTime() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        RoomBridgeMirror mirror = new RoomBridgeMirror(dao(inserted), "phone_a");
        TurnSubmission turn = new TurnSubmission(
            "cloud_proactive_job_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{}", "{}", "job_1", 1784400000100L
        );
        String raw = "{\"turnId\":\"turn_cloud_proactive_job_1\",\"reply\":{"
            + "\"messageId\":\"msg_yuqi_original_1\",\"content\":\"原时间的主动消息\","
            + "\"sentAt\":1784390000000,\"origin\":\"codex\"}}";

        mirror.persistReply(turn, BridgeResult.success("codex", "原时间的主动消息", raw));

        assertEquals(1, inserted.size());
        assertEquals("msg_yuqi_original_1", inserted.get(0).messageId);
        assertEquals("turn_cloud_proactive_job_1", inserted.get(0).turnId);
        assertEquals(1784390000000L, inserted.get(0).sentAt);
    }

    @Test public void oldCloudReplyCompletesItsOriginalAutomaticTurnExactlyOnce() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        List<ReplyPartEntity> imported = new ArrayList<>();
        ChatTurnEntity oldTurn = new ChatTurnEntity();
        oldTurn.turnId = "cloud_proactive_job_1";
        oldTurn.characterId = "yuqi";
        oldTurn.state = "FAILED_FINAL";
        oldTurn.activeAttemptId = "attempt_old_1";
        RoomBridgeMirror mirror = new RoomBridgeMirror(dao(inserted, imported, oldTurn), "phone_a");
        String raw = "{\"turnId\":\"turn_cloud_proactive_job_1\",\"state\":\"committed\","
            + "\"terminal\":true,\"reply\":{\"messageId\":\"msg_yuqi_old_1\","
            + "\"characterId\":\"yuqi\",\"content\":\"这是一条积压消息\","
            + "\"sentAt\":1784390000000,\"origin\":\"codex\"}}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(true, saved);
        assertEquals(1, inserted.size());
        assertEquals("msg_yuqi_old_1", inserted.get(0).messageId);
        assertEquals("turn_cloud_proactive_job_1", inserted.get(0).turnId);
        assertEquals(1, imported.size());
        assertEquals("cloud_proactive_job_1", imported.get(0).turnId);
        assertEquals(1784390000000L, imported.get(0).createdAt);
        assertEquals(0L, inserted.get(0).syncSeq);
    }

    @Test public void oldCloudReplyCreatesIndependentTurnWhenOriginalTurnIsMissing() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        List<ReplyPartEntity> imported = new ArrayList<>();
        List<ChatTurnEntity> insertedTurns = new ArrayList<>();
        RoomBridgeMirror mirror = new RoomBridgeMirror(
            dao(inserted, imported, insertedTurns, null, null), "phone_a"
        );
        String raw = "{\"turnId\":\"turn_cloud_proactive_missing\",\"state\":\"committed\","
            + "\"terminal\":true,\"reply\":{\"messageId\":\"msg_yuqi_missing_1\","
            + "\"characterId\":\"yuqi\",\"content\":\"迟到但必须显示的消息\","
            + "\"sentAt\":1784390001000,\"origin\":\"codex\"}}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(true, saved);
        assertEquals(1, insertedTurns.size());
        assertEquals("COMPLETED", insertedTurns.get(0).state);
        assertEquals(1, imported.size());
        assertEquals(insertedTurns.get(0).turnId, imported.get(0).turnId);
    }

    @Test public void oldCloudReplyUsesIndependentTurnWhenOriginalAlreadyHasFallbackReply() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        List<ReplyPartEntity> imported = new ArrayList<>();
        List<ChatTurnEntity> insertedTurns = new ArrayList<>();
        ChatTurnEntity oldTurn = new ChatTurnEntity();
        oldTurn.turnId = "cloud_proactive_job_conflict";
        oldTurn.characterId = "yuqi";
        oldTurn.state = "COMPLETED";
        oldTurn.activeAttemptId = "attempt_fallback";
        RoomBridgeMirror mirror = new RoomBridgeMirror(
            dao(inserted, imported, insertedTurns, oldTurn, oldTurn.turnId), "phone_a"
        );
        String raw = "{\"turnId\":\"turn_cloud_proactive_job_conflict\",\"state\":\"committed\","
            + "\"terminal\":true,\"reply\":{\"messageId\":\"msg_yuqi_pc_truth\","
            + "\"characterId\":\"yuqi\",\"content\":\"电脑端真正生成的消息\","
            + "\"sentAt\":1784390002000,\"origin\":\"codex\"}}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(true, saved);
        assertEquals(1, insertedTurns.size());
        assertEquals(insertedTurns.get(0).turnId, imported.get(imported.size() - 1).turnId);
    }

    @Test public void currentCloudReplyDoesNotCreateABackfillTurnWhileItsOriginalTurnIsRunning() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        List<ReplyPartEntity> imported = new ArrayList<>();
        List<ChatTurnEntity> insertedTurns = new ArrayList<>();
        ChatTurnEntity runningTurn = new ChatTurnEntity();
        runningTurn.turnId = "turn_msg_phone_current";
        runningTurn.characterId = "yuqi";
        runningTurn.state = "CHAT_RUNNING";
        runningTurn.activeAttemptId = "attempt_current";
        RoomBridgeMirror mirror = new RoomBridgeMirror(
            dao(inserted, imported, insertedTurns, runningTurn, runningTurn.turnId), "phone_a"
        );
        String raw = "{\"turnId\":\"turn_msg_phone_current\",\"state\":\"committed\","
            + "\"terminal\":true,\"reply\":{\"messageId\":\"msg_yuqi_current\","
            + "\"characterId\":\"yuqi\",\"content\":\"only one visible reply\","
            + "\"sentAt\":1784390003000,\"origin\":\"codex\"}}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(false, saved);
        assertEquals(0, imported.size());
        assertEquals(0, insertedTurns.size());
    }

    @Test public void oldCloudFailureEndsTheOriginalPendingTurnWithSafeText() throws Exception {
        List<RawMessageEntity> inserted = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        ChatTurnEntity turn = new ChatTurnEntity();
        turn.turnId = "turn_phone_failed_1";
        turn.characterId = "yuqi";
        turn.state = "CHAT_RUNNING";
        turn.activeAttemptId = "attempt_phone_failed_1";
        RoomBridgeMirror mirror = new RoomBridgeMirror(daoWithFailures(inserted, turn, failures), "phone_a");
        String raw = "{\"turnId\":\"turn_phone_failed_1\",\"state\":\"failed\",\"terminal\":true,"
            + "\"allowFallback\":false,\"errorCode\":\"BACKSTAGE_LEAK\"}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(true, saved);
        assertEquals(0, inserted.size());
        assertEquals(Arrays.asList(
            "turn_phone_failed_1|FAILED_FINAL|REMOTE_REPLY_FAILED|回复暂时没有送达，请重试"
        ), failures);
    }

    @Test public void cloudAutomaticSkipCompletesTheOriginalTurnWithoutAReplyBubble() throws Exception {
        List<String> skips = new ArrayList<>();
        ChatTurnEntity turn = new ChatTurnEntity();
        turn.turnId = "cloud_proactive_skip_1";
        turn.characterId = "yuqi";
        turn.state = "CHAT_RUNNING";
        turn.activeAttemptId = "attempt_skip_1";
        RoomBridgeMirror mirror = new RoomBridgeMirror(daoWithSkips(turn, skips), "phone_a");
        String raw = "{\"turnId\":\"turn_cloud_proactive_skip_1\",\"state\":\"committed\","
            + "\"terminal\":true,\"action\":\"skip\",\"reply\":null}";

        boolean saved = mirror.persistCloudInboxReply(raw);

        assertEquals(true, saved);
        assertEquals(Arrays.asList("cloud_proactive_skip_1"), skips);
    }

    private static AlExecutionDao dao(List<RawMessageEntity> inserted) {
        return dao(inserted, new ArrayList<>(), null);
    }

    private static AlExecutionDao dao(
        List<RawMessageEntity> inserted, List<ReplyPartEntity> imported, ChatTurnEntity turn
    ) {
        return dao(inserted, imported, new ArrayList<>(), turn, null);
    }

    private static AlExecutionDao dao(
        List<RawMessageEntity> inserted,
        List<ReplyPartEntity> imported,
        List<ChatTurnEntity> insertedTurns,
        ChatTurnEntity turn,
        String blockedTurnId
    ) {
        Map<String, ChatTurnEntity> turns = new LinkedHashMap<>();
        if (turn != null) turns.put(turn.turnId, turn);
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] { AlExecutionDao.class },
            (proxy, method, args) -> {
                if ("insertRawMessage".equals(method.getName())) {
                    inserted.add((RawMessageEntity) args[0]);
                    return 1L;
                }
                if ("turn".equals(method.getName())) {
                    return turns.get((String) args[0]);
                }
                if ("insertTurn".equals(method.getName())) {
                    ChatTurnEntity value = (ChatTurnEntity) args[0];
                    insertedTurns.add(value);
                    turns.put(value.turnId, value);
                    return 1L;
                }
                if ("importCloudBacklogReply".equals(method.getName())) {
                    imported.add((ReplyPartEntity) args[1]);
                    if (blockedTurnId != null && blockedTurnId.equals(args[0])) return false;
                    return true;
                }
                Class<?> type = method.getReturnType();
                if (type == long.class) return 0L;
                if (type == int.class) return 0;
                if (type == boolean.class) return false;
                return null;
            }
        );
    }

    private static AlExecutionDao daoWithFailures(
        List<RawMessageEntity> inserted, ChatTurnEntity turn, List<String> failures
    ) {
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] { AlExecutionDao.class },
            (proxy, method, args) -> {
                if ("turn".equals(method.getName())) return turn.turnId.equals(args[0]) ? turn : null;
                if ("insertRawMessage".equals(method.getName())) {
                    inserted.add((RawMessageEntity) args[0]);
                    return 1L;
                }
                if ("importCloudBacklogFailure".equals(method.getName())) {
                    failures.add(args[0] + "|" + args[1] + "|" + args[2] + "|" + args[3]);
                    return true;
                }
                Class<?> type = method.getReturnType();
                if (type == long.class) return 0L;
                if (type == int.class) return 0;
                if (type == boolean.class) return false;
                return null;
            }
        );
    }

    private static AlExecutionDao daoWithSkips(ChatTurnEntity turn, List<String> skips) {
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] { AlExecutionDao.class },
            (proxy, method, args) -> {
                if ("turn".equals(method.getName())) return turn.turnId.equals(args[0]) ? turn : null;
                if ("importCloudBacklogSkip".equals(method.getName())) {
                    skips.add((String) args[0]);
                    return true;
                }
                Class<?> type = method.getReturnType();
                if (type == long.class) return 0L;
                if (type == int.class) return 0;
                if (type == boolean.class) return false;
                return null;
            }
        );
    }
}
