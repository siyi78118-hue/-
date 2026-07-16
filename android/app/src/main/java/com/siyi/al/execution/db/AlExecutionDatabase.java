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
        RolePlanHistoryEntity.class
    },
    version = 3,
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

    public abstract AlExecutionDao executionDao();

    public static AlExecutionDatabase get(Context context) {
        if (instance == null) {
            synchronized (AlExecutionDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                        context.getApplicationContext(),
                        AlExecutionDatabase.class,
                        "al-execution.db"
                    ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build();
                }
            }
        }
        return instance;
    }
}
