package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class YuqiProcessRecoveryTest {
    @Test public void automaticAuthoritySurvivesDatabaseRestartAndStatusReadsAreNoOps() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "yuqi-automatic-restart-" + System.nanoTime();
        context.deleteDatabase(databaseName);
        AutomaticScheduleAuthorityEntity expected;
        AlExecutionDatabase first = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            expected = new AutomaticScheduleStore(first, "device_gateway").configure(
                "yuqi", "chat", "00112233445566778899aabbccddeeff",
                new AutomaticScheduleContract.Source("bootstrap", "restart-test", repeat('b'), 0L, 1_000L),
                new AutomaticScheduleContract.Policy(1L, repeat('a'), "planned", 90_000L, 90_000L, null),
                1_000L
            );
        } finally {
            first.close();
        }

        AlExecutionDatabase reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(reopened, "device_gateway");
            for (int index = 0; index < 60; index += 1) {
                AutomaticScheduleStore.Status status = schedules.status("yuqi", "chat");
                assertNotNull(status);
                assertEquals(expected.generation, status.generation);
                assertEquals(expected.activeJobId, status.activeJobId);
                assertEquals(expected.dueAt, status.dueAt);
            }
            assertEquals(1, reopened.executionDao().automaticScheduleAuthorities().size());
            AutomaticScheduleOutboxEntity pending = reopened.executionDao().nextAutomaticScheduleOutbox();
            assertNotNull(pending);
            assertEquals(expected.generation, pending.generation);
        } finally {
            reopened.close();
            context.deleteDatabase(databaseName);
        }
    }

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

    private static String repeat(char value) {
        return new String(new char[64]).replace('\0', value);
    }
}
