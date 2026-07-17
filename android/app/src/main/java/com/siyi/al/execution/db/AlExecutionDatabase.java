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
        RolePlanOccurrenceEntity.class
    },
    version = 5,
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

    public abstract AlExecutionDao executionDao();

    public static AlExecutionDatabase get(Context context) {
        if (instance == null) {
            synchronized (AlExecutionDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                        context.getApplicationContext(),
                        AlExecutionDatabase.class,
                        "al-execution.db"
                    ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5).build();
                }
            }
        }
        return instance;
    }
}
