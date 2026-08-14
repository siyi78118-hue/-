package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** The one durable Android schedule authority row for a character/kind stream. */
@Entity(
    tableName = "automatic_schedule_authorities",
    indices = {
        @Index(value = {"characterId", "kind"}, unique = true),
        @Index(value = {"state", "dueAt"})
    }
)
public final class AutomaticScheduleAuthorityEntity {
    @PrimaryKey @NonNull public String streamKey = "";
    @NonNull public String characterId = "";
    @NonNull public String kind = "";
    @NonNull public String owner = "android-v1";
    @NonNull public String authorityEpoch = "";
    public long generation;
    @NonNull public String state = "disabled";
    public String activeJobId;
    public Long dueAt;
    @NonNull public String semanticJson = "{}";
    @NonNull public String semanticChecksum = "";
    @NonNull public String cloudSyncState = "waiting";
    public long conversationSequence;
    public long createdAt;
    public long updatedAt;
}
