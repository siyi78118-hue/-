package com.siyi.al.execution;

import androidx.annotation.Nullable;
import com.siyi.al.execution.db.LifecycleControlEntity;

/** Immutable in-memory view of a durable lifecycle control row. */
public final class LifecycleControl {
    public static final String CLEAR_KIND = "conversation_clear_v1";
    public static final String ROLE_DELETE_KIND = "role_delete_v1";
    public static final String WAITING = "waiting";
    public static final String PENDING = "pending";
    public static final String RELAY_ACCEPTED = "relay_accepted";
    public static final String APPLIED = "applied";
    public static final String QUARANTINED = "quarantined";

    public final String controlId;
    public final String controlKind;
    public final String characterId;
    public final String peerId;
    @Nullable public final Long clearEpoch;
    @Nullable public final Long clearedThroughSequence;
    public final long requestedAt;
    public final String semanticJson;
    public final String semanticChecksum;
    public final String state;
    @Nullable public final String leaseId;
    public final long leaseAttempt;
    @Nullable public final Long leasedAt;
    @Nullable public final String relayMessageId;
    @Nullable public final Long appliedAt;
    @Nullable public final Long relayExpiresAt;
    public final long updatedAt;

    public LifecycleControl(
        String controlId,
        String controlKind,
        String characterId,
        String peerId,
        @Nullable Long clearEpoch,
        @Nullable Long clearedThroughSequence,
        long requestedAt,
        String semanticJson,
        String semanticChecksum,
        String state,
        @Nullable String leaseId,
        long leaseAttempt,
        @Nullable Long leasedAt,
        @Nullable String relayMessageId,
        @Nullable Long appliedAt,
        @Nullable Long relayExpiresAt,
        long updatedAt
    ) {
        this.controlId = controlId;
        this.controlKind = controlKind;
        this.characterId = characterId;
        this.peerId = peerId;
        this.clearEpoch = clearEpoch;
        this.clearedThroughSequence = clearedThroughSequence;
        this.requestedAt = requestedAt;
        this.semanticJson = semanticJson;
        this.semanticChecksum = semanticChecksum;
        this.state = state;
        this.leaseId = leaseId;
        this.leaseAttempt = leaseAttempt;
        this.leasedAt = leasedAt;
        this.relayMessageId = relayMessageId;
        this.appliedAt = appliedAt;
        this.relayExpiresAt = relayExpiresAt;
        this.updatedAt = updatedAt;
    }

    public LifecycleControlEntity toEntity() {
        LifecycleControlEntity row = new LifecycleControlEntity();
        row.controlId = controlId;
        row.controlKind = controlKind;
        row.characterId = characterId;
        row.peerId = peerId;
        row.clearEpoch = clearEpoch;
        row.clearedThroughSequence = clearedThroughSequence;
        row.requestedAt = requestedAt;
        row.semanticJson = semanticJson;
        row.semanticChecksum = semanticChecksum;
        row.state = state;
        row.leaseId = leaseId;
        row.leaseAttempt = leaseAttempt;
        row.leasedAt = leasedAt;
        row.relayMessageId = relayMessageId;
        row.appliedAt = appliedAt;
        row.relayExpiresAt = relayExpiresAt;
        row.updatedAt = updatedAt;
        return row;
    }

    public static LifecycleControl fromEntity(LifecycleControlEntity row) {
        if (row == null) return null;
        return new LifecycleControl(
            row.controlId, row.controlKind, row.characterId, row.peerId,
            row.clearEpoch, row.clearedThroughSequence, row.requestedAt,
            row.semanticJson, row.semanticChecksum, row.state, row.leaseId,
            row.leaseAttempt, row.leasedAt, row.relayMessageId, row.appliedAt,
            row.relayExpiresAt, row.updatedAt
        );
    }
}
