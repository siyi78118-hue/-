package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "change_events",
    indices = {@Index(value = {"turnId", "cursor"})}
)
public class ChangeEventEntity {
    @PrimaryKey(autoGenerate = true) public long cursor;
    @Nullable public String turnId;
    @NonNull public String type = "TURN_CHANGED";
    @NonNull public String payloadJson = "{}";
    public long createdAt;
}
