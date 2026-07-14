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
        ChangeEventEntity.class
    },
    version = 2,
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

    public abstract AlExecutionDao executionDao();

    public static AlExecutionDatabase get(Context context) {
        if (instance == null) {
            synchronized (AlExecutionDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                        context.getApplicationContext(),
                        AlExecutionDatabase.class,
                        "al-execution.db"
                    ).addMigrations(MIGRATION_1_2).build();
                }
            }
        }
        return instance;
    }
}
