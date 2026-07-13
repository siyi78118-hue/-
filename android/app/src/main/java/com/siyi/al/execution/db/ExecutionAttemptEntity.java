package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.ForeignKey;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "execution_attempts",
    foreignKeys = @ForeignKey(
        entity = ChatTurnEntity.class,
        parentColumns = "turnId",
        childColumns = "turnId",
        onDelete = ForeignKey.CASCADE
    ),
    indices = {
        @Index(value = {"turnId"}),
        @Index(value = {"turnId", "sequence"}, unique = true),
        @Index(value = {"stage", "heartbeatAt"})
    }
)
public class ExecutionAttemptEntity {
    @PrimaryKey @NonNull public String attemptId = "";
    @NonNull public String turnId = "";
    public int sequence;
    @NonNull public String stage = "QUEUED";
    @NonNull public String state = "QUEUED";
    public long startedAt;
    public long heartbeatAt;
    @Nullable public Long finishedAt;
    @Nullable public String memoryResult;
    @Nullable public String rawReply;
    @Nullable public String errorCode;
    @Nullable public String errorDetail;
    public boolean retryable;
    public int crashCount;
}
