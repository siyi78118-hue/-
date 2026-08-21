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
        ConversationAuthorityEntity.class,
        LifecycleControlEntity.class,
        LifecycleInboundAckTombstoneEntity.class,
        RoleNotificationCancellationEntity.class,
        RoleDeleteOperationEntity.class,
        AutomaticScheduleAuthorityEntity.class,
        AutomaticScheduleOutboxEntity.class,
        AutomaticScheduleEventEntity.class
    },
    version = AlExecutionDatabase.SCHEMA_VERSION,
    exportSchema = false
)
public abstract class AlExecutionDatabase extends RoomDatabase {
    public static final int SCHEMA_VERSION = 17;
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
            // Historical v10 installations do not all carry Room's current
            // foreign-key/index contract. Rebuild the table in the migration
            // itself so reopen validation does not depend on the old DDL or a
            // test fixture.
            database.execSQL("CREATE TABLE `execution_attempts_v11` ("
                + "`attemptId` TEXT NOT NULL, `turnId` TEXT NOT NULL, `sequence` INTEGER NOT NULL, "
                + "`stage` TEXT NOT NULL, `state` TEXT NOT NULL, `startedAt` INTEGER NOT NULL, "
                + "`heartbeatAt` INTEGER NOT NULL, `finishedAt` INTEGER, `memoryResult` TEXT, `rawReply` TEXT, "
                + "`errorCode` TEXT, `errorDetail` TEXT, `retryable` INTEGER NOT NULL, `crashCount` INTEGER NOT NULL, "
                + "PRIMARY KEY(`attemptId`), FOREIGN KEY(`turnId`) REFERENCES `chat_turns`(`turnId`) ON DELETE CASCADE)");
            database.execSQL("INSERT INTO `execution_attempts_v11` ("
                + "`attemptId`, `turnId`, `sequence`, `stage`, `state`, `startedAt`, `heartbeatAt`, "
                + "`finishedAt`, `memoryResult`, `rawReply`, `errorCode`, `errorDetail`, `retryable`, `crashCount`) "
                + "SELECT `attemptId`, `turnId`, `sequence`, `stage`, `state`, `startedAt`, `heartbeatAt`, "
                + "`finishedAt`, `memoryResult`, `rawReply`, `errorCode`, `errorDetail`, `retryable`, `crashCount` "
                + "FROM `execution_attempts`");
            database.execSQL("DROP TABLE `execution_attempts`");
            database.execSQL("ALTER TABLE `execution_attempts_v11` RENAME TO `execution_attempts`");
            database.execSQL("CREATE INDEX `index_execution_attempts_turnId` ON `execution_attempts` (`turnId`)");
            database.execSQL("CREATE UNIQUE INDEX `index_execution_attempts_turnId_sequence` ON `execution_attempts` (`turnId`, `sequence`)");
            database.execSQL("CREATE INDEX `index_execution_attempts_stage_heartbeatAt` ON `execution_attempts` (`stage`, `heartbeatAt`)");
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
            database.execSQL("CREATE UNIQUE INDEX "
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
            // Room validates entity indices after every upgrade. Older v10 databases
            // may have been created without the current ChatTurn indices, so make
            // the canonical index set explicit as part of the first authority
            // migration. IF NOT EXISTS keeps this safe for databases that already
            // carried one or more of these indices.
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_chat_turns_sourceMessageId` ON `chat_turns` (`sourceMessageId`)");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_chat_turns_cloudJobId` ON `chat_turns` (`cloudJobId`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_chat_turns_state_createdAt` ON `chat_turns` (`state`, `createdAt`)");
        }
    };
    public static final Migration MIGRATION_11_12 = new Migration(11, 12) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE `execution_attempts` ADD COLUMN `bridgeAuthorityCheckpointJson` TEXT");
            database.execSQL("ALTER TABLE `execution_attempts` ADD COLUMN `bridgeAuthorityCheckpointChecksum` TEXT");
            database.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `bridgeProtocolVersion` INTEGER");
        }
    };
    public static final Migration MIGRATION_12_13 = new Migration(12, 13) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `lifecycle_controls` ("
                + "`controlId` TEXT NOT NULL, `controlKind` TEXT NOT NULL, `characterId` TEXT NOT NULL, "
                + "`peerId` TEXT NOT NULL, `clearEpoch` INTEGER, `clearedThroughSequence` INTEGER, "
                + "`requestedAt` INTEGER NOT NULL, `semanticJson` TEXT NOT NULL, "
                + "`semanticChecksum` TEXT NOT NULL, `state` TEXT NOT NULL, `leaseId` TEXT, "
                + "`leaseAttempt` INTEGER NOT NULL DEFAULT 0, `leasedAt` INTEGER, `relayMessageId` TEXT, "
                + "`appliedAt` INTEGER, `relayExpiresAt` INTEGER, `updatedAt` INTEGER NOT NULL, "
                + "PRIMARY KEY(`controlId`))");
            database.execSQL("CREATE UNIQUE INDEX `index_lifecycle_controls_characterId_clearEpoch` "
                + "ON `lifecycle_controls` (`characterId`, `clearEpoch`)");
        }
    };
    public static final Migration MIGRATION_13_14 = new Migration(13, 14) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `lifecycle_inbound_ack_tombstones` ("
                + "`ackKey` TEXT NOT NULL, `peerId` TEXT NOT NULL, "
                + "`inboundRelayMessageId` TEXT NOT NULL, `relayExpiresAt` INTEGER NOT NULL, "
                + "`controlId` TEXT NOT NULL, `controlChecksum` TEXT NOT NULL, "
                + "`ackChecksum` TEXT NOT NULL, `reasonCode` TEXT NOT NULL, "
                + "`createdAt` INTEGER NOT NULL, PRIMARY KEY(`ackKey`))");
            database.execSQL("CREATE UNIQUE INDEX "
                + "`index_lifecycle_inbound_ack_tombstones_peerId_inboundRelayMessageId` "
                + "ON `lifecycle_inbound_ack_tombstones` (`peerId`, `inboundRelayMessageId`)");
        }
    };
    public static final Migration MIGRATION_14_15 = new Migration(14, 15) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `role_notification_cancellations` ("
                + "`cancellation_key` TEXT NOT NULL, `control_id` TEXT NOT NULL, "
                + "`character_id` TEXT NOT NULL, `notification_id` INTEGER NOT NULL, "
                + "`intent_checksum` TEXT NOT NULL, `state` TEXT NOT NULL, "
                + "`created_at` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL, "
                + "PRIMARY KEY(`cancellation_key`))");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS "
                + "`index_role_notification_cancellations_control_id_notification_id` "
                + "ON `role_notification_cancellations` (`control_id`, `notification_id`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS "
                + "`index_role_notification_cancellations_state_created_at` "
                + "ON `role_notification_cancellations` (`state`, `created_at`)");
        }
    };
    public static final Migration MIGRATION_15_16 = new Migration(15, 16) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `automatic_schedule_authorities` ("
                + "`streamKey` TEXT NOT NULL, `characterId` TEXT NOT NULL, `kind` TEXT NOT NULL, "
                + "`owner` TEXT NOT NULL, `authorityEpoch` TEXT NOT NULL, `generation` INTEGER NOT NULL, "
                + "`state` TEXT NOT NULL, `activeJobId` TEXT, `dueAt` INTEGER, "
                + "`semanticJson` TEXT NOT NULL, `semanticChecksum` TEXT NOT NULL, "
                + "`cloudSyncState` TEXT NOT NULL, `conversationSequence` INTEGER NOT NULL, "
                + "`createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`streamKey`), "
                + "CHECK(`owner` IN ('android-v1','web-v1')), "
                + "CHECK(`kind` IN ('chat','moment')), "
                + "CHECK(`generation` >= 1), "
                + "CHECK(`state` IN ('disabled','paused_for_conversation','scheduled','claimed','terminal_pending_next')), "
                + "CHECK(`cloudSyncState` IN ('waiting','pending','synced','superseded','quarantined'))) ");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS "
                + "`index_automatic_schedule_authorities_characterId_kind` "
                + "ON `automatic_schedule_authorities` (`characterId`, `kind`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_automatic_schedule_authorities_state_dueAt` "
                + "ON `automatic_schedule_authorities` (`state`, `dueAt`)");

            database.execSQL("CREATE TABLE IF NOT EXISTS `automatic_schedule_outbox` ("
                + "`outboxId` TEXT NOT NULL, `streamKey` TEXT NOT NULL, `generation` INTEGER NOT NULL, "
                + "`operation` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `payloadChecksum` TEXT NOT NULL, "
                + "`state` TEXT NOT NULL, `leaseId` TEXT, `leaseAttempt` INTEGER NOT NULL, `leasedAt` INTEGER, "
                + "`nextAttemptAt` INTEGER NOT NULL, `lastErrorCode` TEXT NOT NULL, "
                + "`createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`outboxId`), "
                + "CHECK(`generation` >= 1), CHECK(`operation` IN ('schedule','pause','disable')), "
                + "CHECK(`state` IN ('waiting','pending','synced','superseded','quarantined'))) ");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_automatic_schedule_outbox_streamKey_generation` "
                + "ON `automatic_schedule_outbox` (`streamKey`, `generation`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_automatic_schedule_outbox_state_updatedAt` "
                + "ON `automatic_schedule_outbox` (`state`, `updatedAt`)");

            database.execSQL("CREATE TABLE IF NOT EXISTS `automatic_schedule_events` ("
                + "`eventId` TEXT NOT NULL, `streamKey` TEXT NOT NULL, `generation` INTEGER NOT NULL, "
                + "`eventType` TEXT NOT NULL, `previousJobId` TEXT, `nextJobId` TEXT, "
                + "`previousDueAt` INTEGER, `nextDueAt` INTEGER, `sourceType` TEXT NOT NULL, "
                + "`sourceId` TEXT NOT NULL, `sourceChecksum` TEXT NOT NULL, `resultCode` TEXT NOT NULL, "
                + "`createdAt` INTEGER NOT NULL, PRIMARY KEY(`eventId`))");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_automatic_schedule_events_streamKey_generation_createdAt` "
                + "ON `automatic_schedule_events` (`streamKey`, `generation`, `createdAt`)");
        }
    };

    public static final Migration MIGRATION_16_17 = new Migration(16, 17) {
        @Override public void migrate(SupportSQLiteDatabase database) {
            database.execSQL("CREATE TABLE IF NOT EXISTS `role_delete_operations` ("
                + "`operationId` TEXT NOT NULL, `control_id` TEXT NOT NULL, `character_id` TEXT NOT NULL, "
                + "`operationChecksum` TEXT NOT NULL, `state` TEXT NOT NULL, `phase` TEXT NOT NULL, "
                + "`cursorJson` TEXT NOT NULL, `affectedCount` INTEGER NOT NULL, "
                + "`sourceSnapshotChecksum` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, "
                + "`updatedAt` INTEGER NOT NULL, `lastError` TEXT, PRIMARY KEY(`operationId`), "
                + "CHECK(`state` IN ('prepared','running','completed','failed','unknown')), "
                + "CHECK(`phase` IN ('prepared','freeze_created','deleting','complete','failed','unknown','legacy_control_recovered'))) ");
            database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_role_delete_operations_control_id` "
                + "ON `role_delete_operations` (`control_id`)");
            database.execSQL("CREATE INDEX IF NOT EXISTS `index_role_delete_operations_character_id_state_updated_at` "
                + "ON `role_delete_operations` (`character_id`, `state`, `updatedAt`)");
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
                        MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13,
                        MIGRATION_13_14, MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17
                    ).build();
                }
            }
        }
        return instance;
    }
}
