package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "conversation_authorities",
    indices = @Index(value = {"characterId", "laneKey", "rootSourceId"}, unique = true)
)
public final class ConversationAuthorityEntity {
    @PrimaryKey @NonNull public String authorityLineageKey = "";
    @NonNull public String characterId = "";
    @NonNull public String laneKey = "";
    @NonNull public String rootSourceId = "";
    @NonNull public String latestTurnId = "";
    public long revision;
    @NonNull public String state = "OPEN";
    @Nullable public String visibleGroupId;
    @Nullable public String commitChecksum;
    @Nullable public String commitPayloadVersion;
    @Nullable public String authorityOrigin;
    @Nullable public String terminalDisposition;
    public long updatedAt;
}
