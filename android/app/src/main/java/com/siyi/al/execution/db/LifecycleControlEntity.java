package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;
import androidx.room.ColumnInfo;

@Entity(
    tableName = "lifecycle_controls",
    indices = @Index(value = {"characterId", "clearEpoch"}, unique = true)
)
public final class LifecycleControlEntity {
    @PrimaryKey @NonNull public String controlId = "";
    @NonNull public String controlKind = "";
    @NonNull public String characterId = "";
    @NonNull public String peerId = "";
    @Nullable public Long clearEpoch;
    @Nullable public Long clearedThroughSequence;
    public long requestedAt;
    @NonNull public String semanticJson = "";
    @NonNull public String semanticChecksum = "";
    @NonNull public String state = "waiting";
    @Nullable public String leaseId;
    @ColumnInfo(defaultValue = "0") public long leaseAttempt;
    @Nullable public Long leasedAt;
    @Nullable public String relayMessageId;
    @Nullable public Long appliedAt;
    @Nullable public Long relayExpiresAt;
    public long updatedAt;
}
