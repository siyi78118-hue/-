package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.room.Room;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ConversationCursorEntity;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ConversationCursorStoreTest {
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
    public void migration10To11PreservesTurnsAndCreatesCursorTables() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v10-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(databaseName)
                .callback(new SupportSQLiteOpenHelper.Callback(10) {
                    @Override
                    public void onCreate(SupportSQLiteDatabase db) {
                        db.execSQL("CREATE TABLE `chat_turns` (" +
                            "`turnId` TEXT NOT NULL, `characterId` TEXT NOT NULL, " +
                            "`sourceMessageId` TEXT NOT NULL, `cloudJobId` TEXT, " +
                            "`kind` TEXT NOT NULL, `state` TEXT NOT NULL, `activeAttemptId` TEXT, " +
                            "`inputJson` TEXT NOT NULL, `snapshotJson` TEXT NOT NULL, " +
                            "`createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, " +
                            "`completedAt` INTEGER, `notificationShownAt` INTEGER, " +
                            "`uiAppliedAt` INTEGER, `cloudConfirmedAt` INTEGER, " +
                            "`cancelledAt` INTEGER, `deletedAt` INTEGER, PRIMARY KEY(`turnId`))");
                    }

                    @Override
                    public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) { }
                })
                .build()
        );
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        db.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('turn-1', 'yuqi', 'message-1', 'DIRECT_REPLY', 'COMPLETED', '{}', '{}', 1, 1)");

        AlExecutionDatabase.MIGRATION_10_11.migrate(db);

        assertEquals(1L, count(db, "chat_turns"));
        assertTrue(hasTable(db, "conversation_cursors"));
        assertTrue(hasTable(db, "conversation_authorities"));
        assertTrue(hasColumn(db, "conversation_authorities", "terminalDisposition"));
        assertTrue(hasColumn(db, "chat_turns", "visibleGroupId"));
        assertTrue(hasColumn(db, "chat_turns", "authorityLineageKey"));
        assertTrue(hasColumn(db, "chat_turns", "lineageRevision"));
        assertTrue(hasColumn(db, "chat_turns", "turnRevision"));
        assertTrue(hasColumn(db, "chat_turns", "pipelineReleaseId"));
        assertTrue(hasColumn(db, "chat_turns", "inputVisibilitySequence"));
        assertTrue(hasColumn(db, "chat_turns", "inputClearEpoch"));
        assertTrue(hasColumn(db, "chat_turns", "terminalDisposition"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void cursorStagesAdvanceMonotonicallyAndIdempotently() {
        store.markNativeCompleted("yuqi", "turn-1", "group-1", 7L, 1000L);
        store.markUiApplied("yuqi", "turn-1", "group-1", 7L, 1100L);
        store.markNativeCompleted("yuqi", "turn-old", "group-old", 6L, 1200L);

        ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
        assertNotNull(cursor);
        assertEquals("group-1", cursor.nativeCompletedGroupId);
        assertEquals("group-1", cursor.uiAppliedGroupId);
        assertEquals(7L, cursor.nativeCompletedSequence);
        assertEquals(7L, cursor.uiAppliedSequence);
        assertEquals(7L, cursor.localSequence);
    }

    @Test
    public void clearCursorRejectsLateGroupsAtOrBeforeClearedSequence() {
        store.markConversationCleared("yuqi", 7L, 3L, 1200L);

        assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED,
            store.classifyIncomingGroup("yuqi", "group-old", 7L));
        assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED,
            store.classifyIncomingGroup("yuqi", "group-older", 6L));
        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.classifyIncomingGroup("yuqi", "group-new", 8L));
    }

    @Test
    public void zeroSequenceIsAcceptedBeforeAnyClearEpochExists() {
        store.markNativeCompleted("yuqi", "legacy-turn", "legacy-group", 0L, 1000L);

        ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
        assertNotNull(cursor);
        assertEquals("legacy-group", cursor.nativeCompletedGroupId);
        assertEquals(0L, cursor.nativeCompletedSequence);
    }

    private static long count(SupportSQLiteDatabase db, String table) {
        android.database.Cursor cursor = db.query("SELECT COUNT(*) FROM `" + table + "`");
        try {
            cursor.moveToFirst();
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private static boolean hasTable(SupportSQLiteDatabase db, String table) {
        android.database.Cursor cursor = db.query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '" + table + "'"
        );
        try {
            return cursor.moveToFirst();
        } finally {
            cursor.close();
        }
    }

    private static boolean hasColumn(SupportSQLiteDatabase db, String table, String column) {
        android.database.Cursor cursor = db.query("PRAGMA table_info(`" + table + "`)");
        try {
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(cursor.getColumnIndexOrThrow("name")))) return true;
            }
            return false;
        } finally {
            cursor.close();
        }
    }
}
