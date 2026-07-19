package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class YuqiProcessRecoveryTest {
    @Test public void memoryRunningRecoveryUsesTheSameRemoteTurnAndOneReply() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("yuqiE2e")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        YuqiAutomaticTriggerTest.configure(context);
        RoomExecutionStore store = new RoomExecutionStore(AlExecutionDatabase.get(context));
        long now = System.currentTimeMillis();
        String turnId = "turn_android_recovery_" + now;
        String messageId = "msg_android_recovery_" + now;
        JSONObject input = new JSONObject()
            .put("deviceSeq", now)
            .put("message", new JSONObject()
                .put("messageId", messageId).put("speakerId", "user").put("speakerType", "user")
                .put("recipientId", "yuqi").put("content", "进程恢复测试。请只回复一句，不要换行。").put("sentAt", now));
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", messageId, TurnKind.DIRECT_REPLY, input.toString(), "{}", null, now
        ));
        ExecutionAttemptEntity attempt = store.activeAttempt(turnId);
        assertNotNull(attempt);
        store.markStage(turnId, attempt.attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, now + 1L);

        ExecutionRuntime.create(context).recoverInterruptedWork();

        assertEquals(turnId, store.turn(turnId).turnId);
        assertEquals(TurnState.COMPLETED.name(), store.turn(turnId).state);
        assertEquals(1, store.replyParts(turnId).size());
    }
}
