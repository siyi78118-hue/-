package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "role_plans",
    indices = {
        @Index(value = {"characterId", "status", "nextRunAt"})
    }
)
public class RolePlanEntity {
    @PrimaryKey @NonNull public String planId = "";
    @NonNull public String characterId = "";
    @NonNull public String status = "active";
    @NonNull public String planJson = "{}";
    public Long nextRunAt;
    public long updatedAt;
}
