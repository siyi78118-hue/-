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

    private static AlExecutionDao dao(List<RawMessageEntity> inserted) {
        return dao(inserted, new ArrayList<>(), null);
    }

    private static AlExecutionDao dao(
        List<RawMessageEntity> inserted, List<ReplyPartEntity> imported, ChatTurnEntity turn
    ) {
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] { AlExecutionDao.class },
            (proxy, method, args) -> {
                if ("insertRawMessage".equals(method.getName())) {
                    inserted.add((RawMessageEntity) args[0]);
                    return 1L;
                }
                if ("turn".equals(method.getName())) {
                    return turn != null && turn.turnId.equals(args[0]) ? turn : null;
                }
                if ("importCloudBacklogReply".equals(method.getName())) {
                    imported.add((ReplyPartEntity) args[1]);
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
