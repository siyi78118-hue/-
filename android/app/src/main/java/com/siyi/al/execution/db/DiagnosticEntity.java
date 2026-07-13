package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
    tableName = "diagnostics",
    indices = {@Index(value = {"turnId", "createdAt"}), @Index(value = {"code", "createdAt"})}
)
public class DiagnosticEntity {
    @PrimaryKey(autoGenerate = true) public long diagnosticId;
    @Nullable public String turnId;
    @Nullable public String attemptId;
    @NonNull public String level = "INFO";
    @NonNull public String code = "";
    @NonNull public String detail = "";
    public long createdAt;
}
