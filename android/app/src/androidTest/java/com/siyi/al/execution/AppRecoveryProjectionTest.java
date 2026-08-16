package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.LifecycleControlEntity;
import com.siyi.al.execution.db.MemoryRecordEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanHistoryEntity;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class AppRecoveryProjectionTest {
    private AlExecutionDatabase database;
    private RoomExecutionStore store;

    @Before public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries().build();
        store = new RoomExecutionStore(database, "device_gateway");
        seedRole("yuqi", "虞栖");
    }

    @After public void tearDown() {
        database.close();
    }

    @Test public void recoveryProjectionsAreClosedPagedChecksummedAndReadOnly() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "restore-rich-turn", "yuqi", "restore-source", TurnKind.DIRECT_REPLY,
            "{}", "{}", null, 10L);
        store.submitTurn(submission);
        String attemptId = store.activeAttempt("restore-rich-turn").attemptId;

        ReplyPartEntity text = part("restore-part-1", attemptId, 0, "TEXT", "第一泡", "{}", 20L);
        ReplyPartEntity moment = part(
            "restore-part-2", attemptId, 1, "MOMENT_CREATE", "",
            new JSONObject().put("momentId", "moment-1").put("text", "动态正文").toString(), 21L);
        database.executionDao().insertReplyParts(Arrays.asList(text, moment));

        MemoryRecordEntity memory = new MemoryRecordEntity();
        memory.memoryId = "restore-memory-1";
        memory.sourceKey = "event:restore-1";
        memory.characterId = "yuqi";
        memory.type = "EVENT";
        memory.title = "恢复事件";
        memory.content = "记忆正文";
        memory.vectorJson = "[0.25,-0.5]";
        memory.eventTime = 30L;
        memory.createdAt = 31L;
        memory.updatedAt = 32L;
        memory.manual = true;
        database.executionDao().upsertMemory(Collections.singletonList(memory));

        RolePlanEntity plan = new RolePlanEntity();
        plan.planId = "restore-plan-1";
        plan.characterId = "yuqi";
        plan.status = "active";
        plan.planJson = new JSONObject().put("planId", plan.planId)
            .put("characterId", "yuqi").put("status", "active").toString();
        plan.nextRunAt = 50L;
        plan.updatedAt = 40L;
        RolePlanHistoryEntity history = new RolePlanHistoryEntity();
        history.historyId = "restore-history-1";
        history.planId = plan.planId;
        history.historyJson = new JSONObject().put("historyId", history.historyId)
            .put("planId", plan.planId).put("event", "created").toString();
        history.createdAt = 41L;
        database.executionDao().replaceRolePlans(
            "yuqi", Collections.singletonList(plan), Collections.singletonList(history));

        long replies = count("reply_parts");
        long memories = count("memory_records");
        long plans = count("role_plans");

        JSONObject replyPage1 = store.readAppRecoveryReplyParts("yuqi", 0L, "", 1);
        assertPage(replyPage1, "android-app-recovery-reply-part-v1", 1, true);
        JSONObject replyPage2 = store.readAppRecoveryReplyParts(
            "yuqi",
            replyPage1.getJSONObject("nextCursor").getLong("afterCreatedAt"),
            replyPage1.getJSONObject("nextCursor").getString("afterId"), 1);
        assertPage(replyPage2, "android-app-recovery-reply-part-v1", 1, false);
        assertEquals(replyPage1.getString("snapshotToken"), replyPage2.getString("snapshotToken"));
        assertEquals("restore-part-1", replyPage1.getJSONArray("rows").getJSONObject(0).getString("replyPartId"));
        assertEquals("restore-part-2", replyPage2.getJSONArray("rows").getJSONObject(0).getString("replyPartId"));

        JSONObject memoryPage = store.readAppRecoveryMemoryRecords("yuqi", 0L, "", 10);
        assertPage(memoryPage, "android-app-recovery-memory-v1", 1, false);
        JSONObject memoryRow = memoryPage.getJSONArray("rows").getJSONObject(0);
        assertExactKeys(memoryRow, "memoryId", "sourceKey", "characterId", "type", "title",
            "content", "vectorJson", "eventTime", "createdAt", "updatedAt", "manual", "sourceChecksum");
        assertTrue(memoryRow.getString("sourceChecksum").matches("[0-9a-f]{64}"));

        JSONObject planPage = store.readAppRecoveryRolePlans("yuqi", 0L, "", 10);
        assertPage(planPage, "android-app-recovery-role-plan-v1", 1, false);
        assertEquals(1, planPage.getJSONArray("rows").getJSONObject(0)
            .getJSONArray("history").length());

        JSONObject momentPage = store.readAppRecoveryMomentEvidence("yuqi", 0L, "", 10);
        assertPage(momentPage, "android-app-recovery-moment-evidence-v1", 1, false);
        assertEquals("MOMENT_CREATE",
            momentPage.getJSONArray("rows").getJSONObject(0).getString("type"));

        assertEquals(replies, count("reply_parts"));
        assertEquals(memories, count("memory_records"));
        assertEquals(plans, count("role_plans"));
    }

    @Test public void everyRecoveryProjectionRejectsATombstonedRole() throws Exception {
        LifecycleControlEntity tombstone = new LifecycleControlEntity();
        tombstone.controlId = "role-delete-yuqi";
        tombstone.controlKind = LifecycleControl.ROLE_DELETE_KIND;
        tombstone.characterId = "yuqi";
        tombstone.peerId = "device_gateway";
        tombstone.requestedAt = 100L;
        tombstone.semanticJson = "{}";
        tombstone.semanticChecksum = "a".repeat(64);
        tombstone.state = "waiting";
        tombstone.updatedAt = 100L;
        database.executionDao().insertLifecycleControl(tombstone);

        assertThrows(IllegalStateException.class,
            () -> store.readAppRecoveryReplyParts("yuqi", 0L, "", 10));
        assertThrows(IllegalStateException.class,
            () -> store.readAppRecoveryMemoryRecords("yuqi", 0L, "", 10));
        assertThrows(IllegalStateException.class,
            () -> store.readAppRecoveryRolePlans("yuqi", 0L, "", 10));
        assertThrows(IllegalStateException.class,
            () -> store.readAppRecoveryMomentEvidence("yuqi", 0L, "", 10));
    }

    private void seedRole(String characterId, String name) {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "recovery-snapshot-" + characterId;
        snapshot.characterId = characterId;
        snapshot.characterName = name;
        snapshot.playerName = "我";
        snapshot.systemPrompt = "compiled";
        snapshot.momentSystemPrompt = "";
        snapshot.contextJson = "{}";
        snapshot.chatConfigId = "chat-v1";
        snapshot.memoryConfigId = "memory-v1";
        snapshot.createdAt = 1L;
        database.executionDao().upsertSnapshot(snapshot);
    }

    private ReplyPartEntity part(
        String id, String attemptId, int sequence, String type,
        String content, String payload, long createdAt
    ) {
        ReplyPartEntity row = new ReplyPartEntity();
        row.replyPartId = id;
        row.turnId = "restore-rich-turn";
        row.attemptId = attemptId;
        row.sequence = sequence;
        row.type = type;
        row.content = content;
        row.payloadJson = payload;
        row.createdAt = createdAt;
        return row;
    }

    private void assertPage(JSONObject page, String contract, int rows, boolean hasMore)
        throws Exception {
        assertExactKeys(page, "contract", "characterId", "snapshotToken", "nextCursor",
            "hasMore", "rows", "pageChecksum");
        assertEquals(contract, page.getString("contract"));
        assertEquals("yuqi", page.getString("characterId"));
        assertTrue(page.getString("snapshotToken").matches("sha256:[0-9a-f]{64}"));
        assertTrue(page.getString("pageChecksum").matches("[0-9a-f]{64}"));
        assertEquals(rows, page.getJSONArray("rows").length());
        assertEquals(hasMore, page.getBoolean("hasMore"));
        assertExactKeys(page.getJSONObject("nextCursor"), "afterCreatedAt", "afterId");
    }

    private static void assertExactKeys(JSONObject value, String... keys) {
        HashSet<String> actual = new HashSet<>();
        java.util.Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) actual.add(iterator.next());
        assertEquals(new HashSet<>(Arrays.asList(keys)), actual);
    }

    private long count(String table) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase()
            .query("SELECT COUNT(*) FROM " + table);
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }
}
