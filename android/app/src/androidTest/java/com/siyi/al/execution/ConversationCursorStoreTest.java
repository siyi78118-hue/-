package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import androidx.room.Room;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.AutomaticScheduleEventEntity;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
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
    public void migration11To12PreservesPopulatedHistoryAndLeavesAuthorityCheckpointNull() {
        ChatTurnEntity entityContract = new ChatTurnEntity();
        assertNull(entityContract.bridgeProtocolVersion);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v11-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV11Helper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        insertPopulatedV11History(db);

        AlExecutionDatabase.MIGRATION_11_12.migrate(db);

        assertTrue(hasColumn(db, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertTrue(hasColumn(db, "execution_attempts", "bridgeAuthorityCheckpointChecksum"));
        assertTrue(hasColumn(db, "chat_turns", "bridgeProtocolVersion"));
        assertFalse(columnIsNotNull(db, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertFalse(columnIsNotNull(db, "execution_attempts", "bridgeAuthorityCheckpointChecksum"));
        assertFalse(columnIsNotNull(db, "chat_turns", "bridgeProtocolVersion"));
        android.database.Cursor attempt = db.query(
            "SELECT turnId, sequence, stage, state, startedAt, heartbeatAt, finishedAt, "
                + "memoryResult, rawReply, errorCode, errorDetail, retryable, crashCount, "
                + "bridgeAuthorityCheckpointJson, bridgeAuthorityCheckpointChecksum "
                + "FROM execution_attempts WHERE attemptId = 'attempt-11'"
        );
        try {
            assertTrue(attempt.moveToFirst());
            assertEquals("turn-11", attempt.getString(0));
            assertEquals(7, attempt.getInt(1));
            assertEquals("FINISHED", attempt.getString(2));
            assertEquals("FAILED_FINAL", attempt.getString(3));
            assertEquals(101L, attempt.getLong(4));
            assertEquals(102L, attempt.getLong(5));
            assertEquals(103L, attempt.getLong(6));
            assertEquals("{\"legacyMemory\":\"保留\"}", attempt.getString(7));
            assertEquals("raw-bytes-\uD83C\uDF27\uFE0F", attempt.getString(8));
            assertEquals("OLD_ERROR", attempt.getString(9));
            assertEquals("旧失败", attempt.getString(10));
            assertEquals(0, attempt.getInt(11));
            assertEquals(4, attempt.getInt(12));
            assertTrue(attempt.isNull(13));
            assertTrue(attempt.isNull(14));
        } finally {
            attempt.close();
        }
        android.database.Cursor turn = db.query(
            "SELECT turnId, characterId, sourceMessageId, cloudJobId, kind, state, activeAttemptId, "
                + "inputJson, snapshotJson, createdAt, updatedAt, completedAt, notificationShownAt, "
                + "uiAppliedAt, cloudConfirmedAt, cancelledAt, deletedAt, visibleGroupId, "
                + "authorityLineageKey, authorityOrigin, commitPayloadVersion, lineageRevision, "
                + "turnRevision, laneKey, laneRevision, generationFingerprint, pipelineReleaseId, "
                + "inputVisibilitySequence, inputClearEpoch, bridgeCommitChecksum, terminalDisposition, "
                + "bridgeProtocolVersion "
                + "FROM chat_turns WHERE turnId = 'turn-11'"
        );
        try {
            assertTrue(turn.moveToFirst());
            assertEquals("turn-11", turn.getString(0));
            assertEquals("yuqi", turn.getString(1));
            assertEquals("message-11", turn.getString(2));
            assertEquals("cloud-11", turn.getString(3));
            assertEquals("DIRECT_REPLY", turn.getString(4));
            assertEquals("FAILED_FINAL", turn.getString(5));
            assertEquals("attempt-11", turn.getString(6));
            assertEquals("{\"message\":\"历史\"}", turn.getString(7));
            assertEquals("{\"scene\":\"旧快照\"}", turn.getString(8));
            assertFalse(turn.getString(8).contains("_alBridgeProtocol"));
            for (int index = 9; index <= 15; index += 1) assertEquals(index - 8L, turn.getLong(index));
            assertTrue(turn.isNull(16));
            assertEquals("group-11", turn.getString(17));
            assertEquals("lineage-11", turn.getString(18));
            assertEquals("pc", turn.getString(19));
            assertEquals("canonical-v2", turn.getString(20));
            assertEquals(2L, turn.getLong(21));
            assertEquals(4L, turn.getLong(22));
            assertEquals("lane-11", turn.getString(23));
            assertEquals(8L, turn.getLong(24));
            assertEquals("fingerprint-11", turn.getString(25));
            assertEquals("release-11", turn.getString(26));
            assertEquals(9L, turn.getLong(27));
            assertEquals(3L, turn.getLong(28));
            assertEquals("checksum-11", turn.getString(29));
            assertEquals("visible", turn.getString(30));
            assertTrue(turn.isNull(31));
        } finally {
            turn.close();
        }
        assertEquals(1L, count(db, "conversation_authorities"));
        android.database.Cursor authority = db.query(
            "SELECT authorityLineageKey, characterId, laneKey, rootSourceId, latestTurnId, revision, "
                + "state, visibleGroupId, commitChecksum, commitPayloadVersion, authorityOrigin, "
                + "terminalDisposition, updatedAt FROM conversation_authorities "
                + "WHERE authorityLineageKey = 'lineage-11'"
        );
        try {
            assertTrue(authority.moveToFirst());
            assertEquals("lineage-11", authority.getString(0));
            assertEquals("yuqi", authority.getString(1));
            assertEquals("lane-11", authority.getString(2));
            assertEquals("message-11", authority.getString(3));
            assertEquals("remote-turn-11", authority.getString(4));
            assertEquals(2L, authority.getLong(5));
            assertEquals("COMMITTED", authority.getString(6));
            assertEquals("group-11", authority.getString(7));
            assertEquals("checksum-11", authority.getString(8));
            assertEquals("canonical-v2", authority.getString(9));
            assertEquals("pc", authority.getString(10));
            assertEquals("visible", authority.getString(11));
            assertEquals(104L, authority.getLong(12));
        } finally {
            authority.close();
        }
        assertEquals("{\"_alBridgeProtocol\":{\"version\":99,\"owner\":\"caller\",\"extra\":true},\"note\":\"原样\"}",
            stringValue(db, "SELECT snapshotJson FROM chat_turns WHERE turnId = 'turn-11-malformed'"));
        assertEquals("{\"_alBridgeProtocol\":{\"version\":3,\"owner\":\"room-v12\"},\"note\":\"历史碰巧同值\"}",
            stringValue(db, "SELECT snapshotJson FROM chat_turns WHERE turnId = 'turn-11-exact-marker'"));
        assertNull(stringValue(db,
            "SELECT bridgeProtocolVersion FROM chat_turns WHERE turnId = 'turn-11-exact-marker'"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration11To12IsRestartStableAndContinuousAfter10To11() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v10-v12-" + System.nanoTime();
        SupportSQLiteOpenHelper helper10 = createV10Helper(context, databaseName);
        SupportSQLiteDatabase db10 = helper10.getWritableDatabase();
        db10.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('turn-10', 'yuqi', 'message-10', 'DIRECT_REPLY', 'QUEUED', '{\"v\":10}', '{\"legacy\":true}', 10, 10)");
        db10.execSQL("INSERT INTO execution_attempts (attemptId, turnId, sequence, stage, state, startedAt, heartbeatAt, finishedAt, memoryResult, rawReply, errorCode, errorDetail, retryable, crashCount) VALUES ('attempt-10', 'turn-10', 1, 'QUEUED', 'QUEUED', 10, 10, NULL, NULL, NULL, NULL, NULL, 0, 0)");
        helper10.close();

        SupportSQLiteOpenHelper helper12 = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db12 = helper12.getWritableDatabase();
        assertTrue(hasColumn(db12, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertTrue(hasColumn(db12, "execution_attempts", "bridgeAuthorityCheckpointChecksum"));
        assertTrue(hasColumn(db12, "chat_turns", "bridgeProtocolVersion"));
        assertEquals("{\"legacy\":true}", stringValue(db12,
            "SELECT snapshotJson FROM chat_turns WHERE turnId = 'turn-10'"));
        assertNull(stringValue(db12,
            "SELECT bridgeAuthorityCheckpointJson FROM execution_attempts WHERE attemptId = 'attempt-10'"));
        helper12.close();

        SupportSQLiteOpenHelper reopened = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase reopenedDb = reopened.getWritableDatabase();
        assertEquals(1L, count(reopenedDb, "chat_turns"));
        assertEquals(1L, count(reopenedDb, "execution_attempts"));
        assertTrue(hasColumn(reopenedDb, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertTrue(hasColumn(reopenedDb, "chat_turns", "bridgeProtocolVersion"));
        reopened.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void freshV12SchemaContainsNullableAuthorityCheckpointColumns() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-fresh-v12-" + System.nanoTime();
        AlExecutionDatabase fresh = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries()
            .build();
        SupportSQLiteDatabase db = fresh.getOpenHelper().getWritableDatabase();
        assertTrue(hasColumn(db, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertTrue(hasColumn(db, "execution_attempts", "bridgeAuthorityCheckpointChecksum"));
        assertTrue(hasColumn(db, "chat_turns", "bridgeProtocolVersion"));
        assertTrue(hasTable(db, "lifecycle_controls"));
        assertTrue(hasTable(db, "lifecycle_inbound_ack_tombstones"));
        assertTrue(columnIsNotNull(db, "lifecycle_controls", "leaseAttempt"));
        assertEquals("0", columnDefault(db, "lifecycle_controls", "leaseAttempt"));
        assertFalse(columnIsNotNull(db, "execution_attempts", "bridgeAuthorityCheckpointJson"));
        assertFalse(columnIsNotNull(db, "execution_attempts", "bridgeAuthorityCheckpointChecksum"));
        assertFalse(columnIsNotNull(db, "chat_turns", "bridgeProtocolVersion"));
        fresh.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration12To13CreatesLifecycleControlsAndPreservesPopulatedV12Rows() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v12-v13-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        insertPopulatedV11History(db);

        AlExecutionDatabase.MIGRATION_12_13.migrate(db);

        assertTrue(hasTable(db, "lifecycle_controls"));
        assertEquals(0L, count(db, "lifecycle_controls"));
        assertTrue(hasColumn(db, "lifecycle_controls", "controlId"));
        assertTrue(hasColumn(db, "lifecycle_controls", "controlKind"));
        assertTrue(hasColumn(db, "lifecycle_controls", "characterId"));
        assertTrue(hasColumn(db, "lifecycle_controls", "peerId"));
        assertTrue(hasColumn(db, "lifecycle_controls", "semanticJson"));
        assertTrue(hasColumn(db, "lifecycle_controls", "semanticChecksum"));
        assertTrue(hasColumn(db, "lifecycle_controls", "state"));
        assertTrue(hasColumn(db, "lifecycle_controls", "leaseAttempt"));
        assertTrue(columnIsNotNull(db, "lifecycle_controls", "leaseAttempt"));
        assertTrue(hasColumn(db, "lifecycle_controls", "relayMessageId"));
        assertTrue(hasColumn(db, "lifecycle_controls", "appliedAt"));
        assertEquals("{\"message\":\"历史\"}", stringValue(db,
            "SELECT inputJson FROM chat_turns WHERE turnId = 'turn-11'"));
        assertEquals("{\"legacyMemory\":\"保留\"}", stringValue(db,
            "SELECT memoryResult FROM execution_attempts WHERE attemptId = 'attempt-11'"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration13To14CreatesUnknownAckTombstonesAndPreservesControls() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v13-v14-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        AlExecutionDatabase.MIGRATION_12_13.migrate(db);
        db.execSQL("INSERT INTO lifecycle_controls (controlId, controlKind, characterId, peerId, clearEpoch, clearedThroughSequence, requestedAt, semanticJson, semanticChecksum, state, leaseAttempt, updatedAt) VALUES ('ctl_keep', 'conversation_clear_v1', 'yuqi', 'device-1', 1, 2, 100, '{}', '" + repeat('a', 64) + "', 'waiting', 0, 100)");

        AlExecutionDatabase.MIGRATION_13_14.migrate(db);

        assertTrue(hasTable(db, "lifecycle_inbound_ack_tombstones"));
        assertEquals(0L, count(db, "lifecycle_inbound_ack_tombstones"));
        assertEquals(1L, count(db, "lifecycle_controls"));
        assertTrue(hasColumn(db, "lifecycle_inbound_ack_tombstones", "ackKey"));
        assertTrue(hasColumn(db, "lifecycle_inbound_ack_tombstones", "relayExpiresAt"));
        assertTrue(hasColumn(db, "lifecycle_inbound_ack_tombstones", "reasonCode"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration14To15CreatesDurableRoleNotificationCancellationQueue() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v14-v15-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        AlExecutionDatabase.MIGRATION_12_13.migrate(db);
        AlExecutionDatabase.MIGRATION_13_14.migrate(db);
        db.execSQL("INSERT INTO lifecycle_controls (controlId, controlKind, characterId, peerId, requestedAt, semanticJson, semanticChecksum, state, leaseAttempt, updatedAt) VALUES ('ctl_keep_v15', 'role_delete_v1', 'yuqi', 'device-1', 100, '{}', '" + repeat('a', 64) + "', 'waiting', 0, 100)");

        AlExecutionDatabase.MIGRATION_14_15.migrate(db);

        assertTrue(hasTable(db, "role_notification_cancellations"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "cancellation_key"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "control_id"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "character_id"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "notification_id"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "intent_checksum"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "state"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "created_at"));
        assertTrue(hasColumn(db, "role_notification_cancellations", "updated_at"));
        assertEquals(1L, count(db, "lifecycle_controls"));
        assertEquals(0L, count(db, "role_notification_cancellations"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration15To16CreatesEmptyAutomaticAuthorityTablesWithoutRewritingLegacyCandidates() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v15-v16-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        AlExecutionDatabase.MIGRATION_12_13.migrate(db);
        AlExecutionDatabase.MIGRATION_13_14.migrate(db);
        AlExecutionDatabase.MIGRATION_14_15.migrate(db);
        String contextJson = "[{\"speaker\":\"用户\",\"text\":\"旧聊天必须原样保留\"}]";
        db.execSQL("CREATE TABLE `character_snapshots` ("
            + "`snapshotId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `characterName` TEXT NOT NULL, "
            + "`playerName` TEXT NOT NULL, `systemPrompt` TEXT NOT NULL, `momentSystemPrompt` TEXT NOT NULL, "
            + "`contextJson` TEXT NOT NULL, `chatConfigId` TEXT NOT NULL, `memoryConfigId` TEXT NOT NULL, "
            + "`createdAt` INTEGER NOT NULL, `scheduledFor` INTEGER, `automaticKind` TEXT, `cloudJobId` TEXT, "
            + "`automaticTasksEnabled` INTEGER NOT NULL, `jobSnapshot` INTEGER NOT NULL, PRIMARY KEY(`snapshotId`))");
        db.execSQL("CREATE INDEX `index_character_snapshots_characterId_createdAt` ON `character_snapshots` (`characterId`, `createdAt`)");
        db.execSQL("CREATE INDEX `index_character_snapshots_cloudJobId_scheduledFor` ON `character_snapshots` (`cloudJobId`, `scheduledFor`)");
        db.execSQL("INSERT INTO character_snapshots (snapshotId, characterId, characterName, playerName, "
            + "systemPrompt, momentSystemPrompt, contextJson, chatConfigId, memoryConfigId, createdAt, "
            + "scheduledFor, automaticKind, cloudJobId, automaticTasksEnabled, jobSnapshot) VALUES "
            + "('snapshot-v15', 'yuqi', '虞栖', '用户', 'system', 'moment', ?, 'chat', 'memory', 100, "
            + "1786728600000, 'chat', 'pro_legacy_candidate', 1, 0)", new Object[]{ contextJson });
        db.execSQL("INSERT INTO lifecycle_controls (controlId, controlKind, characterId, peerId, requestedAt, "
            + "semanticJson, semanticChecksum, state, leaseAttempt, updatedAt) VALUES "
            + "('ctl-v15', 'role_delete_v1', 'other-role', 'device-1', 101, '{}', '" + repeat('a', 64)
            + "', 'waiting', 0, 101)");
        db.execSQL("INSERT INTO role_notification_cancellations (cancellation_key, control_id, character_id, "
            + "notification_id, intent_checksum, state, created_at, updated_at) VALUES "
            + "('cancel-v15', 'ctl-v15', 'other-role', 7, '" + repeat('b', 64)
            + "', 'waiting', 102, 102)");
        db.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, "
            + "snapshotJson, createdAt, updatedAt) VALUES "
            + "('turn-v15', 'yuqi', 'message-v15', 'DIRECT_REPLY', 'QUEUED', "
            + "'{\"message\":\"原样保留\"}', '{\"snapshot\":\"旧值\"}', 103, 104)");

        AlExecutionDatabase.MIGRATION_15_16.migrate(db);
        AlExecutionDatabase.MIGRATION_16_17.migrate(db);
        AlExecutionDatabase.MIGRATION_16_17.migrate(db);

        assertTrue(hasTable(db, "role_delete_operations"));
        assertTrue(hasColumn(db, "role_delete_operations", "operationId"));
        assertTrue(hasColumn(db, "role_delete_operations", "control_id"));
        assertTrue(hasColumn(db, "role_delete_operations", "updatedAt"));
        assertEquals(0L, count(db, "role_delete_operations"));
        assertTrue(hasTable(db, "automatic_schedule_authorities"));
        assertTrue(hasTable(db, "automatic_schedule_outbox"));
        assertTrue(hasTable(db, "automatic_schedule_events"));
        assertTrue(hasColumn(db, "automatic_schedule_authorities", "authorityEpoch"));
        assertTrue(hasColumn(db, "automatic_schedule_authorities", "conversationSequence"));
        assertTrue(hasColumn(db, "automatic_schedule_outbox", "payloadChecksum"));
        assertTrue(hasColumn(db, "automatic_schedule_outbox", "leaseAttempt"));
        assertTrue(hasColumn(db, "automatic_schedule_events", "sourceChecksum"));
        assertFalse(hasColumn(db, "automatic_schedule_events", "semanticJson"));
        assertFalse(hasColumn(db, "automatic_schedule_events", "payloadJson"));
        assertEquals(0L, count(db, "automatic_schedule_authorities"));
        assertEquals(0L, count(db, "automatic_schedule_outbox"));
        assertEquals(0L, count(db, "automatic_schedule_events"));
        assertEquals(contextJson, stringValue(db,
            "SELECT contextJson FROM character_snapshots WHERE snapshotId = 'snapshot-v15'"));
        assertEquals("pro_legacy_candidate", stringValue(db,
            "SELECT cloudJobId FROM character_snapshots WHERE snapshotId = 'snapshot-v15'"));
        assertEquals(1L, count(db, "lifecycle_controls"));
        assertEquals(1L, count(db, "role_notification_cancellations"));
        assertEquals("{\"message\":\"原样保留\"}", stringValue(db,
            "SELECT inputJson FROM chat_turns WHERE turnId = 'turn-v15'"));
        assertEquals("role_delete_v1", stringValue(db,
            "SELECT controlKind FROM lifecycle_controls WHERE controlId = 'ctl-v15'"));
        assertEquals(repeat('b', 64), stringValue(db,
            "SELECT intent_checksum FROM role_notification_cancellations WHERE cancellation_key = 'cancel-v15'"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void automaticScheduleDaoEnforcesGenerationLeaseAndAuthorityCas() {
        AutomaticScheduleAuthorityEntity authority = new AutomaticScheduleAuthorityEntity();
        authority.streamKey = "yuqi:chat";
        authority.characterId = "yuqi";
        authority.kind = "chat";
        authority.authorityEpoch = "epoch_authority_123456";
        authority.generation = 2L;
        authority.state = "scheduled";
        authority.activeJobId = "job_2";
        authority.dueAt = 2000L;
        authority.semanticJson = "{\"generation\":2}";
        authority.semanticChecksum = repeat('a', 64);
        authority.createdAt = 1000L;
        authority.updatedAt = 1000L;
        assertTrue(database.executionDao().upsertAutomaticScheduleAuthority(authority) > 0L);
        assertEquals(0, database.executionDao().claimAutomaticScheduleAuthorityExact(
            authority.streamKey, authority.authorityEpoch, 1L, authority.activeJobId, 1100L));
        assertEquals(1, database.executionDao().claimAutomaticScheduleAuthorityExact(
            authority.streamKey, authority.authorityEpoch, 2L, authority.activeJobId, 1100L));
        assertEquals("claimed", database.executionDao()
            .automaticScheduleAuthority(authority.streamKey).state);

        AutomaticScheduleOutboxEntity first = scheduleOutbox("yuqi:chat:1", "yuqi:chat", 1L, 1000L, 'b');
        AutomaticScheduleOutboxEntity second = scheduleOutbox("yuqi:chat:2", "yuqi:chat", 2L, 1001L, 'c');
        assertTrue(database.executionDao().insertAutomaticScheduleOutbox(first) > 0L);
        assertTrue(database.executionDao().insertAutomaticScheduleOutbox(second) > 0L);
        assertEquals(first.outboxId, database.executionDao().nextAutomaticScheduleOutbox().outboxId);
        assertEquals(0, database.executionDao().claimAutomaticScheduleOutboxExact(
            second.outboxId, second.payloadChecksum, 0L, "lease-2", 1200L, 1200L));
        assertEquals(1, database.executionDao().claimAutomaticScheduleOutboxExact(
            first.outboxId, first.payloadChecksum, 0L, "lease-1", 1200L, 1200L));
        AutomaticScheduleOutboxEntity claimed = database.executionDao().automaticScheduleOutbox(first.outboxId);
        assertEquals(1L, claimed.leaseAttempt);
        assertEquals(0, database.executionDao().syncAutomaticScheduleOutboxExact(
            first.outboxId, first.payloadChecksum, "wrong-lease", 1L, 1200L, 1300L));
        assertEquals(1, database.executionDao().syncAutomaticScheduleOutboxExact(
            first.outboxId, first.payloadChecksum, "lease-1", 1L, 1200L, 1300L));
        assertEquals(second.outboxId, database.executionDao().nextAutomaticScheduleOutbox().outboxId);

        AutomaticScheduleEventEntity event = new AutomaticScheduleEventEntity();
        event.eventId = "yuqi:chat:2:claimed";
        event.streamKey = "yuqi:chat";
        event.generation = 2L;
        event.eventType = "claimed";
        event.sourceType = "alarm";
        event.sourceId = "job_2";
        event.sourceChecksum = repeat('d', 64);
        event.resultCode = "CLAIMED";
        event.createdAt = 1400L;
        assertTrue(database.executionDao().insertAutomaticScheduleEvent(event) > 0L);
        assertEquals(event.eventId,
            database.executionDao().automaticScheduleEvents(event.streamKey).get(0).eventId);
    }

    @Test
    public void migration10To16AndFresh16AreRestartStableAndNewerVersionRejects() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v10-v16-chain-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV10Helper(context, databaseName);
        SupportSQLiteDatabase old = helper.getWritableDatabase();
        old.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('chain-v15-turn', 'yuqi', 'chain-v15-message', 'DIRECT_REPLY', 'QUEUED', '{}', '{}', 1, 1)");
        helper.close();
        AlExecutionDatabase current = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .addMigrations(
                AlExecutionDatabase.MIGRATION_10_11,
                AlExecutionDatabase.MIGRATION_11_12,
                AlExecutionDatabase.MIGRATION_12_13,
                AlExecutionDatabase.MIGRATION_13_14,
                AlExecutionDatabase.MIGRATION_14_15,
                AlExecutionDatabase.MIGRATION_15_16, AlExecutionDatabase.MIGRATION_16_17)
            .allowMainThreadQueries().build();
        SupportSQLiteDatabase upgraded = current.getOpenHelper().getWritableDatabase();
        assertEquals(17L, userVersion(upgraded));
        assertEquals(1L, count(upgraded, "chat_turns"));
        assertTrue(hasTable(upgraded, "role_notification_cancellations"));
        current.close();

        AlExecutionDatabase reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .addMigrations(AlExecutionDatabase.MIGRATION_14_15, AlExecutionDatabase.MIGRATION_15_16, AlExecutionDatabase.MIGRATION_16_17)
            .allowMainThreadQueries().build();
        assertEquals(17L, userVersion(reopened.getOpenHelper().getWritableDatabase()));
        assertTrue(hasTable(reopened.getOpenHelper().getWritableDatabase(), "role_delete_operations"));
        reopened.close();
        context.deleteDatabase(databaseName);

        String freshName = "cursor-fresh-v16-" + System.nanoTime();
        AlExecutionDatabase fresh = Room.databaseBuilder(context, AlExecutionDatabase.class, freshName)
            .allowMainThreadQueries().build();
        assertEquals(17L, userVersion(fresh.getOpenHelper().getWritableDatabase()));
        assertTrue(hasTable(fresh.getOpenHelper().getWritableDatabase(), "role_notification_cancellations"));
        assertTrue(hasTable(fresh.getOpenHelper().getWritableDatabase(), "role_delete_operations"));
        assertTrue(hasTable(fresh.getOpenHelper().getWritableDatabase(), "automatic_schedule_authorities"));
        assertTrue(hasTable(fresh.getOpenHelper().getWritableDatabase(), "automatic_schedule_outbox"));
        assertTrue(hasTable(fresh.getOpenHelper().getWritableDatabase(), "automatic_schedule_events"));
        fresh.close();
        context.deleteDatabase(freshName);

        String newerName = "cursor-newer-v18-" + System.nanoTime();
        SupportSQLiteOpenHelper helper16 = new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(newerName)
                .callback(new SupportSQLiteOpenHelper.Callback(18) {
                    @Override public void onCreate(SupportSQLiteDatabase db) { }
                    @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) { }
                })
                .build()
        );
        helper16.getWritableDatabase();
        helper16.close();
        AlExecutionDatabase incompatible = Room.databaseBuilder(context, AlExecutionDatabase.class, newerName)
            .allowMainThreadQueries().build();
        try {
            incompatible.getOpenHelper().getWritableDatabase();
            fail("v17 must not silently downgrade or repair a newer database");
        } catch (IllegalStateException expected) {
            assertNotNull(expected.getMessage());
            String message = expected.getMessage().toLowerCase();
            assertTrue(message.contains("migration") || message.contains("version"));
        } finally {
            incompatible.close();
            context.deleteDatabase(newerName);
        }
    }

    @Test
    public void migration13To14FailureAtIndexRollsBackTableAndPreservesV13Rows() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v13-v14-fault-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        AlExecutionDatabase.MIGRATION_12_13.migrate(db);
        db.execSQL("INSERT INTO lifecycle_controls (controlId, controlKind, characterId, peerId, requestedAt, semanticJson, semanticChecksum, state, leaseAttempt, updatedAt) VALUES ('ctl_fault', 'conversation_clear_v1', 'yuqi', 'device-1', 100, '{}', '" + repeat('a', 64) + "', 'waiting', 0, 100)");
        db.execSQL("CREATE TABLE migration_conflict_v14 (id INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX index_lifecycle_inbound_ack_tombstones_peerId_inboundRelayMessageId ON migration_conflict_v14 (id)");
        long before = count(db, "lifecycle_controls");
        boolean failed = false;
        db.beginTransaction();
        try {
            AlExecutionDatabase.MIGRATION_13_14.migrate(db);
            db.setTransactionSuccessful();
        } catch (RuntimeException expected) {
            failed = true;
        } finally {
            db.endTransaction();
        }
        assertTrue(failed);
        assertFalse(hasTable(db, "lifecycle_inbound_ack_tombstones"));
        assertEquals(before, count(db, "lifecycle_controls"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void fullTenToSixteenChainPreservesPopulatedRowsAndIsRestartStable() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v10-v16-history-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV10Helper(context, databaseName);
        SupportSQLiteDatabase old = helper.getWritableDatabase();
        old.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('chain-turn', 'yuqi', 'chain-message', 'DIRECT_REPLY', 'QUEUED', '{}', '{}', 1, 1)");
        helper.close();
        AlExecutionDatabase current = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .addMigrations(
                AlExecutionDatabase.MIGRATION_10_11,
                AlExecutionDatabase.MIGRATION_11_12,
                AlExecutionDatabase.MIGRATION_12_13,
                AlExecutionDatabase.MIGRATION_13_14,
                AlExecutionDatabase.MIGRATION_14_15,
                AlExecutionDatabase.MIGRATION_15_16, AlExecutionDatabase.MIGRATION_16_17)
            .allowMainThreadQueries().build();
        SupportSQLiteDatabase upgraded = current.getOpenHelper().getWritableDatabase();
        assertEquals(17L, userVersion(upgraded));
        assertEquals(1L, count(upgraded, "chat_turns"));
        assertTrue(hasTable(upgraded, "lifecycle_inbound_ack_tombstones"));
        assertTrue(hasTable(upgraded, "role_notification_cancellations"));
        assertTrue(hasTable(upgraded, "automatic_schedule_authorities"));
        assertTrue(hasTable(upgraded, "automatic_schedule_outbox"));
        assertTrue(hasTable(upgraded, "automatic_schedule_events"));
        current.close();
        AlExecutionDatabase reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .addMigrations(
                AlExecutionDatabase.MIGRATION_13_14,
                AlExecutionDatabase.MIGRATION_14_15,
                AlExecutionDatabase.MIGRATION_15_16, AlExecutionDatabase.MIGRATION_16_17)
            .allowMainThreadQueries().build();
        assertEquals(17L, userVersion(reopened.getOpenHelper().getWritableDatabase()));
        assertEquals(1L, count(reopened.getOpenHelper().getWritableDatabase(), "chat_turns"));
        assertEquals(0L, count(reopened.getOpenHelper().getWritableDatabase(), "automatic_schedule_authorities"));
        reopened.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void migration12To13FailureAtCreateIndexRollsBackTableAndKeepsV12History() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-v12-v13-fault-" + System.nanoTime();
        SupportSQLiteOpenHelper helper = createV12UpgradeHelper(context, databaseName);
        SupportSQLiteDatabase db = helper.getWritableDatabase();
        insertPopulatedV11History(db);
        long versionBefore = userVersion(db);
        long turnsBefore = count(db, "chat_turns");
        long attemptsBefore = count(db, "execution_attempts");
        db.execSQL("CREATE TABLE migration_conflict (id INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX index_lifecycle_controls_characterId_clearEpoch "
            + "ON migration_conflict (id)");

        boolean failed = false;
        db.beginTransaction();
        try {
            AlExecutionDatabase.MIGRATION_12_13.migrate(db);
            db.setTransactionSuccessful();
        } catch (RuntimeException expected) {
            failed = true;
        } finally {
            db.endTransaction();
        }

        assertTrue(failed);
        assertEquals(versionBefore, userVersion(db));
        assertEquals(12L, versionBefore);
        assertEquals(turnsBefore, count(db, "chat_turns"));
        assertEquals(attemptsBefore, count(db, "execution_attempts"));
        assertFalse(hasTable(db, "lifecycle_controls"));
        assertTrue(hasTable(db, "migration_conflict"));
        helper.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void newerVersionIsNotSilentlyRepairedOrDowngraded() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "cursor-newer-v17-" + System.nanoTime();
        SupportSQLiteOpenHelper helper12 = createV12UpgradeHelper(context, databaseName);
        helper12.getWritableDatabase();
        helper12.close();
        SupportSQLiteOpenHelper helper17 = new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(databaseName)
                .callback(new SupportSQLiteOpenHelper.Callback(18) {
                    @Override public void onCreate(SupportSQLiteDatabase db) { }
                    @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) { }
                })
                .build()
        );
        helper17.getWritableDatabase();
        helper17.close();
        AlExecutionDatabase incompatible = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries()
            .build();
        try {
            incompatible.getOpenHelper().getWritableDatabase();
            fail("v17 must not silently downgrade or repair a newer database");
        } catch (IllegalStateException expected) {
            assertNotNull(expected.getMessage());
            String message = expected.getMessage().toLowerCase();
            assertTrue(message.contains("migration") || message.contains("version")
                || message.contains("identity") || message.contains("schema"));
        } finally {
            incompatible.close();
            context.deleteDatabase(databaseName);
        }
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

    private static AutomaticScheduleOutboxEntity scheduleOutbox(
        String outboxId, String streamKey, long generation, long createdAt, char checksumChar
    ) {
        AutomaticScheduleOutboxEntity row = new AutomaticScheduleOutboxEntity();
        row.outboxId = outboxId;
        row.streamKey = streamKey;
        row.generation = generation;
        row.operation = "schedule";
        row.payloadJson = "{\"generation\":" + generation + "}";
        row.payloadChecksum = repeat(checksumChar, 64);
        row.state = "waiting";
        row.nextAttemptAt = createdAt;
        row.createdAt = createdAt;
        row.updatedAt = createdAt;
        return row;
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

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }

    private static String stringValue(SupportSQLiteDatabase db, String sql) {
        android.database.Cursor cursor = db.query(sql);
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.isNull(0) ? null : cursor.getString(0);
        } finally {
            cursor.close();
        }
    }

    private static long userVersion(SupportSQLiteDatabase db) {
        android.database.Cursor cursor = db.query("PRAGMA user_version");
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private static SupportSQLiteOpenHelper createV10Helper(Context context, String name) {
        return new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(name)
                .callback(new SupportSQLiteOpenHelper.Callback(10) {
                    @Override public void onCreate(SupportSQLiteDatabase db) {
                        createV10Tables(db);
                    }
                    @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) { }
                })
                .build()
        );
    }

    private static SupportSQLiteOpenHelper createV11Helper(Context context, String name) {
        return new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(name)
                .callback(new SupportSQLiteOpenHelper.Callback(11) {
                    @Override public void onCreate(SupportSQLiteDatabase db) {
                        createV10Tables(db);
                        AlExecutionDatabase.MIGRATION_10_11.migrate(db);
                    }
                    @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) { }
                })
                .build()
        );
    }

    private static SupportSQLiteOpenHelper createV12UpgradeHelper(Context context, String name) {
        return new FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(name)
                .callback(new SupportSQLiteOpenHelper.Callback(12) {
                    @Override public void onCreate(SupportSQLiteDatabase db) {
                        createV10Tables(db);
                        AlExecutionDatabase.MIGRATION_10_11.migrate(db);
                        AlExecutionDatabase.MIGRATION_11_12.migrate(db);
                    }
                    @Override public void onUpgrade(SupportSQLiteDatabase db, int oldVersion, int newVersion) {
                        if (oldVersion == 10) AlExecutionDatabase.MIGRATION_10_11.migrate(db);
                        if (oldVersion <= 11) AlExecutionDatabase.MIGRATION_11_12.migrate(db);
                    }
                })
                .build()
        );
    }

    private static void createV10Tables(SupportSQLiteDatabase db) {
        db.execSQL("CREATE TABLE `chat_turns` ("
            + "`turnId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `sourceMessageId` TEXT NOT NULL, "
            + "`cloudJobId` TEXT, `kind` TEXT NOT NULL, `state` TEXT NOT NULL, `activeAttemptId` TEXT, "
            + "`inputJson` TEXT NOT NULL, `snapshotJson` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, "
            + "`updatedAt` INTEGER NOT NULL, `completedAt` INTEGER, `notificationShownAt` INTEGER, "
            + "`uiAppliedAt` INTEGER, `cloudConfirmedAt` INTEGER, `cancelledAt` INTEGER, `deletedAt` INTEGER, "
            + "PRIMARY KEY(`turnId`))");
        db.execSQL("CREATE TABLE `execution_attempts` ("
            + "`attemptId` TEXT NOT NULL, `turnId` TEXT NOT NULL, `sequence` INTEGER NOT NULL, "
            + "`stage` TEXT NOT NULL, `state` TEXT NOT NULL, `startedAt` INTEGER NOT NULL, "
            + "`heartbeatAt` INTEGER NOT NULL, `finishedAt` INTEGER, `memoryResult` TEXT, `rawReply` TEXT, "
            + "`errorCode` TEXT, `errorDetail` TEXT, `retryable` INTEGER NOT NULL, `crashCount` INTEGER NOT NULL, "
            + "PRIMARY KEY(`attemptId`), FOREIGN KEY(`turnId`) REFERENCES `chat_turns`(`turnId`) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX `index_execution_attempts_turnId` ON `execution_attempts` (`turnId`)");
        db.execSQL("CREATE UNIQUE INDEX `index_execution_attempts_turnId_sequence` ON `execution_attempts` (`turnId`, `sequence`)");
        db.execSQL("CREATE INDEX `index_execution_attempts_stage_heartbeatAt` ON `execution_attempts` (`stage`, `heartbeatAt`)");
    }

    private static void insertPopulatedV11History(SupportSQLiteDatabase db) {
        db.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, cloudJobId, kind, state, activeAttemptId, inputJson, snapshotJson, createdAt, updatedAt, completedAt, notificationShownAt, uiAppliedAt, cloudConfirmedAt, cancelledAt, deletedAt, visibleGroupId, authorityLineageKey, authorityOrigin, commitPayloadVersion, lineageRevision, turnRevision, laneKey, laneRevision, generationFingerprint, pipelineReleaseId, inputVisibilitySequence, inputClearEpoch, bridgeCommitChecksum, terminalDisposition) VALUES ('turn-11', 'yuqi', 'message-11', 'cloud-11', 'DIRECT_REPLY', 'FAILED_FINAL', 'attempt-11', '{\"message\":\"历史\"}', '{\"scene\":\"旧快照\"}', 1, 2, 3, 4, 5, 6, 7, NULL, 'group-11', 'lineage-11', 'pc', 'canonical-v2', 2, 4, 'lane-11', 8, 'fingerprint-11', 'release-11', 9, 3, 'checksum-11', 'visible')");
        db.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('turn-11-malformed', 'yuqi', 'message-11-malformed', 'DIRECT_REPLY', 'QUEUED', '{\"message\":\"保留\"}', '{\"_alBridgeProtocol\":{\"version\":99,\"owner\":\"caller\",\"extra\":true},\"note\":\"原样\"}', 11, 11)");
        db.execSQL("INSERT INTO chat_turns (turnId, characterId, sourceMessageId, kind, state, inputJson, snapshotJson, createdAt, updatedAt) VALUES ('turn-11-exact-marker', 'yuqi', 'message-11-exact-marker', 'DIRECT_REPLY', 'QUEUED', '{\"message\":\"保留\"}', '{\"_alBridgeProtocol\":{\"version\":3,\"owner\":\"room-v12\"},\"note\":\"历史碰巧同值\"}', 12, 12)");
        db.execSQL("INSERT INTO execution_attempts (attemptId, turnId, sequence, stage, state, startedAt, heartbeatAt, finishedAt, memoryResult, rawReply, errorCode, errorDetail, retryable, crashCount) VALUES ('attempt-11', 'turn-11', 7, 'FINISHED', 'FAILED_FINAL', 101, 102, 103, '{\"legacyMemory\":\"保留\"}', 'raw-bytes-\uD83C\uDF27\uFE0F', 'OLD_ERROR', '旧失败', 0, 4)");
        db.execSQL("INSERT INTO conversation_authorities (authorityLineageKey, characterId, laneKey, rootSourceId, latestTurnId, revision, state, visibleGroupId, commitChecksum, commitPayloadVersion, authorityOrigin, terminalDisposition, updatedAt) VALUES ('lineage-11', 'yuqi', 'lane-11', 'message-11', 'remote-turn-11', 2, 'COMMITTED', 'group-11', 'checksum-11', 'canonical-v2', 'pc', 'visible', 104)");
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

    private static boolean columnIsNotNull(SupportSQLiteDatabase db, String table, String column) {
        android.database.Cursor cursor = db.query("PRAGMA table_info(`" + table + "`)");
        try {
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(cursor.getColumnIndexOrThrow("name")))) {
                    return cursor.getInt(cursor.getColumnIndexOrThrow("notnull")) != 0;
                }
            }
            throw new AssertionError("missing column " + table + "." + column);
        } finally {
            cursor.close();
        }
    }

    private static String columnDefault(SupportSQLiteDatabase db, String table, String column) {
        android.database.Cursor cursor = db.query("PRAGMA table_info(`" + table + "`)");
        try {
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(cursor.getColumnIndexOrThrow("name")))) {
                    return cursor.getString(cursor.getColumnIndexOrThrow("dflt_value"));
                }
            }
            throw new AssertionError("missing column " + table + "." + column);
        } finally {
            cursor.close();
        }
    }
}
