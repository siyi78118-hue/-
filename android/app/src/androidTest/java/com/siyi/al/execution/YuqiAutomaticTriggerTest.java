package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.secure.AlSecretStore;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class YuqiAutomaticTriggerTest {
    @Test public void proactiveTriggerGetsOneCodexReplyAndNoUserRow() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("yuqiE2e")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        configure(context);
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        long now = System.currentTimeMillis();
        String turnId = "turn_android_trigger_" + now;
        String triggerId = "trigger_android_" + now;
        JSONObject input = new JSONObject()
            .put("scheduledFor", now)
            .put("reason", "端到端主动消息测试：自然地发一句简短问候，不要换行")
            .put("deviceSeq", now);
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", triggerId, TurnKind.PROACTIVE_CHAT,
            input.toString(), "{}", "job_android_" + now, now
        ));

        assertTrue(ExecutionRuntime.create(context).runNext());

        assertEquals(TurnState.COMPLETED.name(), store.turn(turnId).state);
        assertFalse(store.replyParts(turnId).isEmpty());
        int userRows = 0;
        int characterRows = 0;
        for (RawMessageEntity row : database.executionDao().recentRawMessages("yuqi", 100)) {
            if (!turnId.equals(row.turnId)) continue;
            if ("user".equals(row.speakerType)) userRows += 1;
            if ("character".equals(row.speakerType)) {
                characterRows += 1;
                assertEquals("yuqi", row.speakerId);
                assertEquals("codex", row.origin);
            }
        }
        assertEquals(0, userRows);
        assertEquals(1, characterRows);
    }

    static void configure(Context context) {
        new AlSecretStore(context).saveBridgeConfig(new BridgeConfig(
            true, BridgeMode.LAN, "http://127.0.0.1:17892", "", "android-e2e-device",
            "yuqi-e2e-pairing-secret-20260719", "", "", 5_000, 15_000, 1, 500, 1_200_000
        ));
    }
}
