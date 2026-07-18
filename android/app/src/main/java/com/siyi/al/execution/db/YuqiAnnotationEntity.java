package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "yuqi_annotations", indices = {
    @Index(value = {"status", "createdAt"}),
    @Index(value = {"turnId"})
})
public class YuqiAnnotationEntity {
    @PrimaryKey @NonNull public String annotationId = "";
    @NonNull public String turnId = "";
    public String sourceMessageId;
    @NonNull public String presetVersion = "1.0.0";
    @NonNull public String userCorrection = "";
    @NonNull public String desiredBehavior = "";
    @NonNull public String status = "proposed";
    public long createdAt;
    public long syncSeq;
    @NonNull public String checksum = "";
}
