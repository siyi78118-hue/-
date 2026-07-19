package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.RawMessageEntity;
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
    }

    private static AlExecutionDao dao(List<RawMessageEntity> inserted) {
        return (AlExecutionDao) Proxy.newProxyInstance(
            AlExecutionDao.class.getClassLoader(),
            new Class<?>[] { AlExecutionDao.class },
            (proxy, method, args) -> {
                if ("insertRawMessage".equals(method.getName())) {
                    inserted.add((RawMessageEntity) args[0]);
                    return 1L;
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
