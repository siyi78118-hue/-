package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "conversation_cursors")
public final class ConversationCursorEntity {
    @PrimaryKey @NonNull public String characterId = "";
    @Nullable public String nativeCompletedTurnId;
    @Nullable public String nativeCompletedGroupId;
    public long nativeCompletedSequence;
    @Nullable public String uiAppliedTurnId;
    @Nullable public String uiAppliedGroupId;
    public long uiAppliedSequence;
    public long localSequence;
    public long clearedThroughSequence;
    public long clearEpoch;
    public long clearedAt;
    public boolean chatOpen;
    public long updatedAt;
}
