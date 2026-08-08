package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

/** Durable, metadata-only terminal proof for a valid unknown lifecycle ACK. */
@Entity(
    tableName = "lifecycle_inbound_ack_tombstones",
    indices = @Index(value = {"peerId", "inboundRelayMessageId"}, unique = true)
)
public final class LifecycleInboundAckTombstoneEntity {
    @PrimaryKey @NonNull public String ackKey = "";
    @NonNull public String peerId = "";
    @NonNull public String inboundRelayMessageId = "";
    public long relayExpiresAt;
    @NonNull public String controlId = "";
    @NonNull public String controlChecksum = "";
    @NonNull public String ackChecksum = "";
    @NonNull public String reasonCode = "unknown_control";
    public long createdAt;
}
