package com.siyi.al.execution.db;

import android.content.Context;
import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;

@Database(
    entities = {
        ChatTurnEntity.class,
        ExecutionAttemptEntity.class,
        ReplyPartEntity.class,
        MemoryRecordEntity.class,
        CharacterSnapshotEntity.class,
        DiagnosticEntity.class,
        ChangeEventEntity.class,
        RolePlanEntity.class,
        RolePlanHistoryEntity.class,
        RolePlanOccurrenceEntity.class,
        RawMessageEntity.class,
        EvidenceFactEntity.class,
        SyncCursorEntity.class,
        YuqiAnnotationEntity.class,
        ConversationCursorEntity.class,
        ConversationAuthorityEntity.class
    },
    version = 12,
    exportSchema = false
)
public abstract class AlExecutionDatabase extends RoomDatabase {
    private static volatile AlExecutionDatabase instance;
    private static final Migration MIGRATION_1_2 = new Migration(1, 2) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE chat_turns ADD COLUMN uiAppliedAt INTEGER");
        }
    };
    private static final Migration MIGRATION_2_3 = new Migration(2, 3) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `role_plans` (`planId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `status` TEXT NOT NULL, `planJson` TEXT NOT NULL, `nextRunAt` INTEGER, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`planId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_role_plans_characterId_status_nextRunAt` ON `role_plans` (`characterId`, `status`, `nextRunAt`)");
            database.execSQL("CREATE TABLE IF NOT EXISTS `role_plan_history` (`historyId` TEXT NOT NULL, `planId` TEXT NOT NULL, `historyJson` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`historyId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_role_plan_history_planId_createdAt` ON `role_plan_history` (`planId`, `createdAt`)");
        }
    };
    private static final Migration MIGRATION_3_4 = new Migration(3, 4) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `role_plan_occurrences` (`occurrenceId` TEXT NOT NULL, `planId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `state` TEXT NOT NULL, `turnId` TEXT NOT NULL, `jobId` TEXT NOT NULL, `errorCode` TEXT NOT NULL, `scheduledFor` INTEGER NOT NULL, `claimedAt` INTEGER, `completedAt` INTEGER, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`occurrenceId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_role_plan_occurrences_planId` ON `role_plan_occurrences` (`planId`)");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_role_plan_occurrences_turnId` ON `role_plan_occurrences` (`turnId`)");
        }
    };
    private static final Migration MIGRATION_4_5 = new Migration(4, 5) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE character_snapshots ADD COLUMN scheduledFor INTEGER");
            database.execSQL("ALTER TABLE character_snapshots ADD COLUMN automaticKind TEXT");
            database.execSQL("ALTER TABLE character_snapshots ADD COLUMN cloudJobId TEXT");
            database.execSQL("ALTER TABLE character_snapshots ADD COLUMN automaticTasksEnabled INTEGER NOT NULL DEFAULT 0");
            database.execSQL("ALTER TABLE character_snapshots ADD COLUMN jobSnapshot INTEGER NOT NULL DEFAULT 0");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_character_snapshots_cloudJobId_scheduledFor` ON `character_snapshots` (`cloudJobId`, `scheduledFor`)");
        }
    };
    private static final Migration MIGRATION_5_6 = new Migration(5, 6) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `yuqi_raw_messages` (`messageId` TEXT NOT NULL, `turnId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `speakerId` TEXT NOT NULL, `speakerType` TEXT NOT NULL, `recipientId` TEXT NOT NULL, `content` TEXT NOT NULL, `sentAt` INTEGER NOT NULL, `origin` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `deviceSeq` INTEGER NOT NULL, `checksum` TEXT NOT NULL, `syncSeq` INTEGER NOT NULL, PRIMARY KEY(`messageId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_raw_messages_characterId_sentAt` ON `yuqi_raw_messages` (`characterId`, `sentAt`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_raw_messages_turnId` ON `yuqi_raw_messages` (`turnId`)");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_yuqi_raw_messages_deviceId_deviceSeq` ON `yuqi_raw_messages` (`deviceId`, `deviceSeq`)");
            database.execSQL("CREATE TABLE IF NOT EXISTS `yuqi_evidence_facts` (`factId` TEXT NOT NULL, `characterId` TEXT NOT NULL, `subjectId` TEXT NOT NULL, `predicate` TEXT NOT NULL, `objectJson` TEXT NOT NULL, `evidenceMode` TEXT NOT NULL, `sourceMessageIdsJson` TEXT NOT NULL, `exactQuotesJson` TEXT NOT NULL, `status` TEXT NOT NULL, `confidence` REAL NOT NULL, `origin` TEXT NOT NULL, `checksum` TEXT NOT NULL, `updatedAt` INTEGER NOT NULL, `syncSeq` INTEGER NOT NULL, PRIMARY KEY(`factId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_evidence_facts_characterId_status` ON `yuqi_evidence_facts` (`characterId`, `status`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_evidence_facts_subjectId_predicate` ON `yuqi_evidence_facts` (`subjectId`, `predicate`)");
            database.execSQL("CREATE TABLE IF NOT EXISTS `yuqi_sync_cursors` (`peerId` TEXT NOT NULL, `ackSeq` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`peerId`))");
        }
    };
    private static final Migration MIGRATION_6_7 = new Migration(6, 7) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `yuqi_annotations` (`annotationId` TEXT NOT NULL, `turnId` TEXT NOT NULL, `sourceMessageId` TEXT, `presetVersion` TEXT NOT NULL, `userCorrection` TEXT NOT NULL, `desiredBehavior` TEXT NOT NULL, `status` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `syncSeq` INTEGER NOT NULL, `checksum` TEXT NOT NULL, PRIMARY KEY(`annotationId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_annotations_status_createdAt` ON `yuqi_annotations` (`status`, `createdAt`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_yuqi_annotations_turnId` ON `yuqi_annotations` (`turnId`)");
        }
    };
    private static final Migration MIGRATION_7_8 = new Migration(7, 8) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            // PC-origin replies are inbound copies; only phone-authored rows belong in recovery uploads.
            database.execSQL(
                "UPDATE yuqi_raw_messages SET syncSeq = 0 "
                    + "WHERE speakerType = 'character' AND deviceId LIKE 'pc:%' AND origin != 'fallback'"
            );
        }
    };
    private static final Migration MIGRATION_8_9 = new Migration(8, 9) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            // A canonical user message may own several first-class retry turns.
            // turnId remains the idempotency key through the table primary key.
            database.execSQL("DROP INDEX IF EXISTS `index_chat_turns_sourceMessageId`");
            database.execSQL(
                "CREATE INDEX IF NOT EXISTS `index_chat_turns_sourceMessageId` "
                    + "ON `chat_turns` (`sourceMessageId`)"
            );
        }
    };
    private static final Migration MIGRATION_9_10 = new Migration(9, 10) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE chat_turns ADD COLUMN notificationShownAt INTEGER");
            database.execSQL("ALTER TABLE chat_turns ADD COLUMN cloudConfirmedAt INTEGER");
        }
    };
    public static final Migration MIGRATION_10_11 = new Migration(10, 11) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `conversation_cursors` ("
                + "`characterId` TEXT NOT NULL, `nativeCompletedTurnId` TEXT, "
                + "`nativeCompletedGroupId` TEXT, `nativeCompletedSequence` INTEGER NOT NULL, "
                + "`uiAppliedTurnId` TEXT, `uiAppliedGroupId` TEXT, "
                + "`uiAppliedSequence` INTEGER NOT NULL, `localSequence` INTEGER NOT NULL, "
                + "`clearedThroughSequence` INTEGER NOT NULL, `clearEpoch` INTEGER NOT NULL, "
                + "`clearedAt` INTEGER NOT NULL, `chatOpen` INTEGER NOT NULL, "
                + "`updatedAt` INTEGER NOT NULL, PRIMARY KEY(`characterId`))");
            database.execSQL("CREATE TABLE IF NOT EXISTS `conversation_authorities` ("
                + "`authorityLineageKey` TEXT NOT NULL, `characterId` TEXT NOT NULL, "
                + "`laneKey` TEXT NOT NULL, `rootSourceId` TEXT NOT NULL, "
                + "`latestTurnId` TEXT NOT NULL, `revision` INTEGER NOT NULL, "
                + "`state` TEXT NOT NULL, `visibleGroupId` TEXT, `commitChecksum` TEXT, "
                + "`commitPayloadVersion` TEXT, `authorityOrigin` TEXT, "
                + "`terminalDisposition` TEXT, `updatedAt` INTEGER NOT NULL, "
                + "PRIMARY KEY(`authorityLineageKey`))");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS "
                + "`index_conversation_authorities_characterId_laneKey_rootSourceId` "
                + "ON `conversation_authorities` (`characterId`, `laneKey`, `rootSourceId`)");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `visibleGroupId` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `authorityLineageKey` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `authorityOrigin` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `commitPayloadVersion` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `lineageRevision` INTEGER");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `turnRevision` INTEGER");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneKey` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneRevision` INTEGER");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `generationFingerprint` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `pipelineReleaseId` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `inputVisibilitySequence` INTEGER");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `inputClearEpoch` INTEGER");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `bridgeCommitChecksum` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `terminalDisposition` TEXT");
        }
    };
    public static final Migration MIGRATION_11_12 = new Migration(11, 12) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE `execution_attempts` ADD COLUMN `bridgeAuthorityCheckpointJson` TEXT");
            database.execSQL("ALTER TABLE `execution_attempts` ADD COLUMN `bridgeAuthorityCheckpointChecksum` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `bridgeProtocolVersion` INTEGER");
        }
    };

    public abstract AlExecutionDao executionDao();

    public static AlExecutionDatabase get(Context context) {
        if (instance == null) {
            synchronized (AlExecutionDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                        context.getApplicationContext(),
                        AlExecutionDatabase.class,
                        "al-execution.db"
                    ).addMigrations(
                        MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5,
                        MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9,
                        MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12
                    ).build();
                }
            }
        }
        return instance;
    }
}
