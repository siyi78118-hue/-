package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** Metadata-only, durable intent to cancel one deterministic role message notification. */
@Entity(
    tableName = "role_notification_cancellations",
    indices = {
        @Index(value = {"control_id", "notification_id"}, unique = true),
        @Index(value = {"state", "created_at"})
    }
)
public final class RoleNotificationCancellationEntity {
    @PrimaryKey @NonNull @ColumnInfo(name = "cancellation_key") public String cancellationKey = "";
    @NonNull @ColumnInfo(name = "control_id") public String controlId = "";
    @NonNull @ColumnInfo(name = "character_id") public String characterId = "";
    @ColumnInfo(name = "notification_id") public int notificationId;
    @NonNull @ColumnInfo(name = "intent_checksum") public String intentChecksum = "";
    @NonNull public String state = "waiting";
    @ColumnInfo(name = "created_at") public long createdAt;
    @ColumnInfo(name = "updated_at") public long updatedAt;
}
