package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** Metadata-only schedule audit event. Chat content and prompts are forbidden here. */
@Entity(
    tableName = "automatic_schedule_events",
    indices = @Index(value = {"streamKey", "generation", "createdAt"})
)
public final class AutomaticScheduleEventEntity {
    @PrimaryKey @NonNull public String eventId = "";
    @NonNull public String streamKey = "";
    public long generation;
    @NonNull public String eventType = "";
    public String previousJobId;
    public String nextJobId;
    public Long previousDueAt;
    public Long nextDueAt;
    @NonNull public String sourceType = "";
    @NonNull public String sourceId = "";
    @NonNull public String sourceChecksum = "";
    @NonNull public String resultCode = "";
    public long createdAt;
}
