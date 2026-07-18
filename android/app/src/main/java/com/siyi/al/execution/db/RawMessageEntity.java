package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "yuqi_raw_messages", indices = {
    @Index(value = {"characterId", "sentAt"}),
    @Index(value = {"turnId"}),
    @Index(value = {"deviceId", "deviceSeq"}, unique = true)
})
public class RawMessageEntity {
    @PrimaryKey @NonNull public String messageId = "";
    @NonNull public String turnId = "";
    @NonNull public String characterId = "yuqi";
    @NonNull public String speakerId = "user";
    @NonNull public String speakerType = "user";
    @NonNull public String recipientId = "yuqi";
    @NonNull public String content = "";
    public long sentAt;
    @NonNull public String origin = "phone";
    @NonNull public String deviceId = "phone";
    public long deviceSeq;
    @NonNull public String checksum = "";
    public long syncSeq;
}
