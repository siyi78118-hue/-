package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "role_plan_history",
    indices = {
        @Index(value = {"planId", "createdAt"})
    }
)
public class RolePlanHistoryEntity {
    @PrimaryKey @NonNull public String historyId = "";
    @NonNull public String planId = "";
    @NonNull public String historyJson = "{}";
    public long createdAt;
}
