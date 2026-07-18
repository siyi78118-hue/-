package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "yuqi_sync_cursors")
public class SyncCursorEntity {
    @PrimaryKey @NonNull public String peerId = "pc";
    public long ackSeq;
    public long updatedAt;
}
