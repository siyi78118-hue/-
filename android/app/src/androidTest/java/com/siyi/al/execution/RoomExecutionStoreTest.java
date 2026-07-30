package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.bridge.RoomBridgeMirror;
import java.util.Collections;
import org.json.JSONObject;
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
    public void retryCanReplaceCorruptInputAndSnapshotBeforeNewAttempt() {
        TurnSubmission broken = new TurnSubmission(
            "turn-repair",
            "char-1",
            "msg-repair",
            TurnKind.DIRECT_REPLY,
            "{}",
            "{\"messages\":[]}",
            null,
            1L
        );
        store.submitTurn(broken);
        String firstAttempt = store.activeAttempt("turn-repair").attemptId;
        store.markFailed("turn-repair", firstAttempt, "INVALID_INPUT", "raw user message is empty", true, 2L);
        String repairedInput = "{\"message\":{\"speakerId\":\"user\",\"content\":\"hello\"}}";
        String repairedSnapshot = "{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}";

        store.startRetry("turn-repair", 3L, repairedInput, repairedSnapshot);

        assertEquals(repairedInput, store.turn("turn-repair").inputJson);
        assertEquals(repairedSnapshot, store.turn("turn-repair").snapshotJson);
    }

    @Test
    public void legacyRetryPersistsExactlyOneCanonicalUserMessage() throws Exception {
        TurnSubmission broken = new TurnSubmission(
            "turn-legacy", "char-1", "msg-legacy", TurnKind.DIRECT_REPLY,
            "{}", "{\"messages\":[]}", null, 1L
        );
        store.submitTurn(broken);
        String firstAttempt = store.activeAttempt("turn-legacy").attemptId;
        store.markFailed("turn-legacy", firstAttempt, "INVALID_INPUT", "raw user message is empty", true, 2L);
        String input = "{\"message\":{\"messageId\":\"msg-legacy\",\"content\":\"你好\",\"sentAt\":1},\"deviceSeq\":1}";
        String snapshot = "{\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}";

        store.startRetry("turn-legacy", 3L, input, snapshot);
        TurnSubmission repaired = new TurnSubmission(
            "turn-legacy", "char-1", "msg-legacy", TurnKind.DIRECT_REPLY,
            input, snapshot, null, 1L
        );
        RoomBridgeMirror mirror = new RoomBridgeMirror(database.executionDao(), "phone_test");
        mirror.persistSubmission(repaired);
        mirror.persistSubmission(repaired);

        assertEquals("你好", new JSONObject(store.turn("turn-legacy").inputJson)
            .getJSONObject("message").getString("content"));
        int userRows = 0;
        for (RawMessageEntity row : database.executionDao().recentRawMessages("char-1", 20)) {
            if ("turn-legacy".equals(row.turnId) && "user".equals(row.speakerId)) userRows += 1;
        }
        assertEquals(1, userRows);
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
    public void freshRetryTurnCanShareCanonicalSourceMessage() {
        store.submitTurn(submission("turn-original", "msg-shared"));
        store.submitTurn(submission("turn-retry", "msg-shared"));

        assertEquals("turn-original", store.turn("turn-original").turnId);
        assertEquals("turn-retry", store.turn("turn-retry").turnId);
        assertEquals(1, database.executionDao().attempts("turn-original").size());
        assertEquals(1, database.executionDao().attempts("turn-retry").size());
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

    @Test
    public void notificationUiAndCloudStagesRemainIndependent() {
        store.submitTurn(submission("turn-delivery-stages", "msg-delivery-stages"));
        String attemptId = store.activeAttempt("turn-delivery-stages").attemptId;
        prepareChatDone("turn-delivery-stages", attemptId);
        store.commitReply(
            "turn-delivery-stages",
            attemptId,
            Collections.singletonList(textPart("turn-delivery-stages", attemptId, "通知先显示")),
            10L
        );

        store.markNotificationShown("turn-delivery-stages", 11L);
        assertEquals(Long.valueOf(10L), store.turn("turn-delivery-stages").completedAt);
        assertEquals(Long.valueOf(11L), store.turn("turn-delivery-stages").notificationShownAt);
        assertEquals(null, store.turn("turn-delivery-stages").uiAppliedAt);
        assertEquals(null, store.turn("turn-delivery-stages").cloudConfirmedAt);
        assertEquals(1, store.unappliedCompletedTurns(10).size());

        store.acknowledgeUiApplied("turn-delivery-stages", 12L);
        store.markCloudConfirmed("turn-delivery-stages", 13L);

        assertEquals(Long.valueOf(12L), store.turn("turn-delivery-stages").uiAppliedAt);
        assertEquals(Long.valueOf(13L), store.turn("turn-delivery-stages").cloudConfirmedAt);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
    }

    @Test
    public void clearAutomaticTasksCancelsOnlyProactiveWork() {
        store.submitTurn(submission("direct", "direct-msg", TurnKind.DIRECT_REPLY));
        store.submitTurn(submission("chat-auto", "chat-auto-msg", TurnKind.PROACTIVE_CHAT));
        store.submitTurn(submission("moment-auto", "moment-auto-msg", TurnKind.PROACTIVE_MOMENT));

        AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

        assertEquals(2, result.cancelledTurns);
        assertEquals(2, result.cancelledAttempts);
        assertEquals(TurnState.QUEUED, store.displayState("direct"));
        assertEquals(TurnState.CANCELLED, store.displayState("chat-auto"));
        assertEquals(TurnState.CANCELLED, store.displayState("moment-auto"));
    }

    @Test
    public void clearAutomaticTasksSuppressesCompletedInboxAndDeletesSnapshots() {
        store.submitTurn(submission("completed-auto", "completed-auto-msg", TurnKind.PROACTIVE_MOMENT));
        String attemptId = store.activeAttempt("completed-auto").attemptId;
        prepareChatDone("completed-auto", attemptId);
        store.commitReply(
            "completed-auto",
            attemptId,
            Collections.singletonList(textPart("completed-auto", attemptId, "旧朋友圈")),
            12L
        );
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "char-1:moment";
        snapshot.characterId = "char-1";
        snapshot.characterName = "角色";
        snapshot.playerName = "我";
        snapshot.systemPrompt = "";
        snapshot.momentSystemPrompt = "";
        snapshot.contextJson = "{\"cloudJobId\":\"old\"}";
        snapshot.chatConfigId = "chat-v1";
        snapshot.memoryConfigId = "memory-v1";
        snapshot.createdAt = 1L;
        database.executionDao().upsertSnapshot(snapshot);

        AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

        assertEquals(1, result.acknowledgedCompletedTurns);
        assertEquals(1, result.deletedSnapshots);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
        assertEquals(null, database.executionDao().latestSnapshot("char-1:moment"));
    }

    private void prepareChatDone(String turnId, String attemptId) {
        store.markStage(turnId, attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, 3L);
        store.saveMemoryResult(turnId, attemptId, "无相关记忆", 3L);
        store.markStage(turnId, attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, 3L);
        store.saveRawReply(turnId, attemptId, "模型原始回复", 3L);
    }

    private static TurnSubmission submission(String turnId, String messageId) {
        return submission(turnId, messageId, TurnKind.DIRECT_REPLY);
    }

    private static TurnSubmission submission(String turnId, String messageId, TurnKind kind) {
        return new TurnSubmission(
            turnId,
            "char-1",
            messageId,
            kind,
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
