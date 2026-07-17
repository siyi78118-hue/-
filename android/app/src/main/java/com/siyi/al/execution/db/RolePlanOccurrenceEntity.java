package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "role_plan_occurrences",
    indices = { @Index("planId"), @Index(value = {"turnId"}, unique = true) }
)
public class RolePlanOccurrenceEntity {
    @PrimaryKey @NonNull public String occurrenceId = "";
    @NonNull public String planId = "";
    @NonNull public String characterId = "";
    @NonNull public String state = "PENDING";
    @NonNull public String turnId = "";
    @NonNull public String jobId = "";
    @NonNull public String errorCode = "";
    public long scheduledFor;
    public Long claimedAt;
    public Long completedAt;
    public long updatedAt;
}
