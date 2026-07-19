package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class YuqiLanRoundTripTest {
    @Test public void realAndroidTurnReturnsFromLanCodexAndKeepsSpeakerAttribution() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("yuqiE2e")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        YuqiAutomaticTriggerTest.configure(context);
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        long now = System.currentTimeMillis();
        String turnId = "turn_android_e2e_" + now;
        String messageId = "msg_android_e2e_" + now;
        String userText = "这是端到端链路测试。请自然地简短回复一句，不要换行。";
        JSONObject input = new JSONObject()
            .put("deviceSeq", now)
            .put("message", new JSONObject()
                .put("messageId", messageId).put("speakerId", "user").put("speakerType", "user")
                .put("recipientId", "yuqi").put("content", userText).put("sentAt", now));
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", messageId, TurnKind.DIRECT_REPLY, input.toString(), "{}", null, now
        ));

        assertTrue(ExecutionRuntime.create(context).runNext());

        ChatTurnEntity turn = store.turn(turnId);
        assertEquals(TurnState.COMPLETED.name(), turn.state);
        List<ReplyPartEntity> replyParts = store.replyParts(turnId);
        assertFalse(replyParts.isEmpty());
        assertFalse(replyParts.get(0).content.trim().isEmpty());
        ExecutionAttemptEntity attempt = store.activeAttempt(turnId);
        assertNotNull(attempt);
        JSONObject checkpoint = new JSONObject(attempt.memoryResult);
        assertEquals("codex", checkpoint.getString("origin"));
        assertFalse(checkpoint.getBoolean("fallback"));
        assertEquals("lan", checkpoint.getJSONArray("attemptedRoutes").getString(0));

        RawMessageEntity mirroredUser = null;
        RawMessageEntity mirroredReply = null;
        int userRows = 0;
        int characterRows = 0;
        for (RawMessageEntity row : database.executionDao().recentRawMessages("yuqi", 100)) {
            if (turnId.equals(row.turnId) && "user".equals(row.speakerType)) { mirroredUser = row; userRows += 1; }
            if (turnId.equals(row.turnId) && "character".equals(row.speakerType)) { mirroredReply = row; characterRows += 1; }
        }
        assertEquals(1, userRows);
        assertEquals(1, characterRows);
        assertNotNull(mirroredUser);
        assertEquals("user", mirroredUser.speakerId);
        assertEquals(userText, mirroredUser.content);
        assertNotNull(mirroredReply);
        assertEquals("yuqi", mirroredReply.speakerId);
        assertEquals("codex", mirroredReply.origin);
        assertEquals(replyParts.get(0).content, mirroredReply.content);
    }
}
