package com.siyi.al.execution.db;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "yuqi_evidence_facts", indices = {
    @Index(value = {"characterId", "status"}),
    @Index(value = {"subjectId", "predicate"})
})
public class EvidenceFactEntity {
    @PrimaryKey @NonNull public String factId = "";
    @NonNull public String characterId = "yuqi";
    @NonNull public String subjectId = "";
    @NonNull public String predicate = "";
    @NonNull public String objectJson = "null";
    @NonNull public String evidenceMode = "uncertain";
    @NonNull public String sourceMessageIdsJson = "[]";
    @NonNull public String exactQuotesJson = "[]";
    @NonNull public String status = "provisional";
    public double confidence;
    @NonNull public String origin = "codex";
    @NonNull public String checksum = "";
    public long updatedAt;
    public long syncSeq;
}
