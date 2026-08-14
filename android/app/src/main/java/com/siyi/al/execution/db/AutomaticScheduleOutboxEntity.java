package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** Immutable generation transition awaiting ordered synchronization to D1. */
@Entity(
    tableName = "automatic_schedule_outbox",
    indices = {
        @Index(value = {"streamKey", "generation"}, unique = true),
        @Index(value = {"state", "updatedAt"})
    }
)
public final class AutomaticScheduleOutboxEntity {
    @PrimaryKey @NonNull public String outboxId = "";
    @NonNull public String streamKey = "";
    public long generation;
    @NonNull public String operation = "schedule";
    @NonNull public String payloadJson = "{}";
    @NonNull public String payloadChecksum = "";
    @NonNull public String state = "waiting";
    public String leaseId;
    public long leaseAttempt;
    public Long leasedAt;
    public long nextAttemptAt;
    @NonNull public String lastErrorCode = "";
    public long createdAt;
    public long updatedAt;
}
