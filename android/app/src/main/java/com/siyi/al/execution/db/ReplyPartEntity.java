package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.ForeignKey;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "reply_parts",
    foreignKeys = @ForeignKey(
        entity = ChatTurnEntity.class,
        parentColumns = "turnId",
        childColumns = "turnId",
        onDelete = ForeignKey.CASCADE
    ),
    indices = {
        @Index(value = {"turnId", "sequence"}, unique = true),
        @Index(value = {"attemptId"})
    }
)
public class ReplyPartEntity {
    @PrimaryKey @NonNull public String replyPartId = "";
    @NonNull public String turnId = "";
    @NonNull public String attemptId = "";
    public int sequence;
    @NonNull public String type = "TEXT";
    @NonNull public String content = "";
    @NonNull public String payloadJson = "{}";
    public long createdAt;
}
