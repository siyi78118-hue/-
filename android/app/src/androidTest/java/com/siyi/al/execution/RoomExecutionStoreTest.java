package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.Collections;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RoomExecutionStoreTest {
    private AlExecutionDatabase database;
    private RoomExecutionStore store;

    @Before
    public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries()
            .build();
        store = new RoomExecutionStore(database);
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void retryUsesFreshAttemptAndCommitClearsFailure() {
        store.submitTurn(submission("turn-1", "msg-1"));
        String firstAttempt = store.activeAttempt("turn-1").attemptId;
        store.markFailed("turn-1", firstAttempt, "TIMEOUT", "read timeout", true, 2L);

        ExecutionAttemptEntity retry = store.startRetry("turn-1", 3L);
        assertNotEquals(firstAttempt, retry.attemptId);
        prepareChatDone("turn-1", retry.attemptId);

        store.commitReply(
            "turn-1",
            retry.attemptId,
            Collections.singletonList(textPart("turn-1", retry.attemptId, "收到")),
            4L
        );

        assertEquals(TurnState.COMPLETED, store.displayState("turn-1"));
        assertEquals(1, store.replyParts("turn-1").size());
    }

    @Test
    public void lateOldAttemptCannotCommitAfterRetry() {
        store.submitTurn(submission("turn-2", "msg-2"));
        String oldAttempt = store.activeAttempt("turn-2").attemptId;
        store.markFailed("turn-2", oldAttempt, "TIMEOUT", "read timeout", true, 2L);
        String activeAttempt = store.startRetry("turn-2", 3L).attemptId;

        assertThrows(
            StaleAttemptException.class,
            () -> store.commitReply(
                "turn-2",
                oldAttempt,
                Collections.singletonList(textPart("turn-2", oldAttempt, "旧回复")),
                4L
            )
        );

        prepareChatDone("turn-2", activeAttempt);
        store.commitReply(
            "turn-2",
            activeAttempt,
            Collections.singletonList(textPart("turn-2", activeAttempt, "新回复")),
            5L
        );
        assertEquals("新回复", store.replyParts("turn-2").get(0).content);
    }

    @Test
    public void duplicateSubmissionKeepsOneAttempt() {
        store.submitTurn(submission("turn-3", "msg-3"));
        store.submitTurn(submission("turn-3", "msg-3"));
        assertEquals(1, database.executionDao().attempts("turn-3").size());
    }

    @Test
    public void cancelledTurnRejectsLateReplyCommit() {
        store.submitTurn(submission("turn-4", "msg-4"));
        String cancelledAttempt = store.activeAttempt("turn-4").attemptId;

        store.cancelTurn("turn-4", 2L, false);

        assertThrows(
            StaleAttemptException.class,
            () -> store.commitReply(
                "turn-4",
                cancelledAttempt,
                Collections.singletonList(textPart("turn-4", cancelledAttempt, "迟到回复")),
                3L
            )
        );
        assertEquals(TurnState.CANCELLED, store.displayState("turn-4"));
    }

    @Test
    public void completedTurnRemainsInUiInboxUntilAcknowledged() {
        store.submitTurn(submission("turn-ui-inbox", "msg-ui-inbox"));
        String attemptId = store.activeAttempt("turn-ui-inbox").attemptId;
        prepareChatDone("turn-ui-inbox", attemptId);
        store.commitReply(
            "turn-ui-inbox",
            attemptId,
            Collections.singletonList(textPart("turn-ui-inbox", attemptId, "通知已经收到的正文")),
            10L
        );

        assertEquals(1, store.unappliedCompletedTurns(10).size());
        store.acknowledgeUiApplied("turn-ui-inbox", 11L);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
    }

    private void prepareChatDone(String turnId, String attemptId) {
        store.markStage(turnId, attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, 3L);
        store.saveMemoryResult(turnId, attemptId, "无相关记忆", 3L);
        store.markStage(turnId, attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, 3L);
        store.saveRawReply(turnId, attemptId, "模型原始回复", 3L);
    }

    private static TurnSubmission submission(String turnId, String messageId) {
        return new TurnSubmission(
            turnId,
            "char-1",
            messageId,
            TurnKind.DIRECT_REPLY,
            "{\"text\":\"你好\"}",
            "{\"messages\":[]}",
            null,
            1L
        );
    }

    private static ReplyPartEntity textPart(String turnId, String attemptId, String text) {
        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "part_" + turnId + "_0";
        part.turnId = turnId;
        part.attemptId = attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = text;
        part.payloadJson = "{}";
        part.createdAt = 4L;
        return part;
    }
}
