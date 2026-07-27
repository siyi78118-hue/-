package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "chat_turns",
    indices = {
        @Index(value = {"sourceMessageId"}),
        @Index(value = {"cloudJobId"}, unique = true),
        @Index(value = {"state", "createdAt"})
    }
)
public class ChatTurnEntity {
    @PrimaryKey @NonNull public String turnId = "";
    @NonNull public String characterId = "";
    @NonNull public String sourceMessageId = "";
    @Nullable public String cloudJobId;
    @NonNull public String kind = "DIRECT_REPLY";
    @NonNull public String state = "QUEUED";
    @Nullable public String activeAttemptId;
    @NonNull public String inputJson = "{}";
    @NonNull public String snapshotJson = "{}";
    public long createdAt;
    public long updatedAt;
    @Nullable public Long completedAt;
    @Nullable public Long uiAppliedAt;
    @Nullable public Long cancelledAt;
    @Nullable public Long deletedAt;
}
