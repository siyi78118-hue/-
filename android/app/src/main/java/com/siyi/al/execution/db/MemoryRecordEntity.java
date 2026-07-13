package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "memory_records",
    indices = {
        @Index(value = {"sourceKey"}, unique = true),
        @Index(value = {"characterId", "type", "eventTime"})
    }
)
public class MemoryRecordEntity {
    @PrimaryKey @NonNull public String memoryId = "";
    @NonNull public String sourceKey = "";
    @NonNull public String characterId = "";
    @NonNull public String type = "EVENT";
    @NonNull public String title = "";
    @NonNull public String content = "";
    @NonNull public String vectorJson = "[]";
    public long eventTime;
    public long createdAt;
    public long updatedAt;
    public boolean manual;
}
