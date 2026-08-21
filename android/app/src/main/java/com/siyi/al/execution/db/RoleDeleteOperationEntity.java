package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** Durable metadata-only journal for one role-delete operation. */
@Entity(
    tableName = "role_delete_operations",
    indices = {
        @Index(name = "index_role_delete_operations_control_id", value = {"control_id"}, unique = true),
        @Index(name = "index_role_delete_operations_character_id_state_updated_at",
            value = {"character_id", "state", "updatedAt"})
    }
)
public final class RoleDeleteOperationEntity {
    @PrimaryKey @NonNull public String operationId = "";
    @NonNull @ColumnInfo(name = "control_id") public String controlId = "";
    @NonNull @ColumnInfo(name = "character_id") public String characterId = "";
    @NonNull public String operationChecksum = "";
    @NonNull public String state = "prepared";
    @NonNull public String phase = "prepared";
    @NonNull public String cursorJson = "{}";
    public long affectedCount;
    @NonNull public String sourceSnapshotChecksum = "";
    public long createdAt;
    public long updatedAt;
    @Nullable public String lastError;
}
