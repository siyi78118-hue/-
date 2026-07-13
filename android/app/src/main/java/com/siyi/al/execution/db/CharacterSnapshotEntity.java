package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "character_snapshots",
    indices = @Index(value = {"characterId", "createdAt"})
)
public class CharacterSnapshotEntity {
    @PrimaryKey @NonNull public String snapshotId = "";
    @NonNull public String characterId = "";
    @NonNull public String characterName = "";
    @NonNull public String playerName = "";
    @NonNull public String systemPrompt = "";
    @NonNull public String momentSystemPrompt = "";
    @NonNull public String contextJson = "[]";
    @NonNull public String chatConfigId = "";
    @NonNull public String memoryConfigId = "";
    public long createdAt;
}
