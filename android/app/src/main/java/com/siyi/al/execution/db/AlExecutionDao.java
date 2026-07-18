package com.siyi.al.execution.db;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import androidx.room.Transaction;
import com.siyi.al.execution.StaleAttemptException;
import java.util.List;

@Dao
public interface AlExecutionDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertTurn(ChatTurnEntity turn);

    @Insert(onConflict = OnConflictStrategy.ABORT)
    void insertAttempt(ExecutionAttemptEntity attempt);

    @Insert(onConflict = OnConflictStrategy.ABORT)
    void insertReplyParts(List<ReplyPartEntity> parts);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertMemory(List<MemoryRecordEntity> rows);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertSnapshot(CharacterSnapshotEntity snapshot);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertRolePlans(List<RolePlanEntity> plans);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertRolePlanHistory(List<RolePlanHistoryEntity> history);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertRolePlanOccurrence(RolePlanOccurrenceEntity occurrence);

    @Insert
    long insertDiagnostic(DiagnosticEntity diagnostic);

    @Insert
    long insertChange(ChangeEventEntity change);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertRawMessage(RawMessageEntity message);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertEvidenceFacts(List<EvidenceFactEntity> facts);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void upsertSyncCursor(SyncCursorEntity cursor);

    @Query("SELECT * FROM yuqi_raw_messages WHERE characterId = :characterId ORDER BY sentAt DESC LIMIT :limit")
    List<RawMessageEntity> recentRawMessages(String characterId, int limit);

    @Query("SELECT * FROM yuqi_evidence_facts WHERE characterId = :characterId ORDER BY updatedAt DESC")
    List<EvidenceFactEntity> evidenceFacts(String characterId);

    @Query("SELECT * FROM yuqi_sync_cursors WHERE peerId = :peerId LIMIT 1")
    SyncCursorEntity syncCursor(String peerId);

    @Query("SELECT * FROM chat_turns WHERE turnId = :turnId LIMIT 1")
    ChatTurnEntity turn(String turnId);

    @Query("SELECT * FROM chat_turns WHERE sourceMessageId = :sourceMessageId LIMIT 1")
    ChatTurnEntity turnBySourceMessage(String sourceMessageId);

    @Query("SELECT * FROM character_snapshots WHERE snapshotId = :snapshotId LIMIT 1")
    CharacterSnapshotEntity latestSnapshot(String snapshotId);

    @Query("SELECT * FROM character_snapshots WHERE jobSnapshot = 1 AND automaticTasksEnabled = 1 AND scheduledFor IS NOT NULL AND scheduledFor <= :now AND cloudJobId IS NOT NULL AND cloudJobId != '' ORDER BY scheduledFor ASC LIMIT :limit")
    List<CharacterSnapshotEntity> dueAutomaticSnapshots(long now, int limit);

    @Query("SELECT * FROM role_plans WHERE characterId = :characterId ORDER BY CASE WHEN nextRunAt IS NULL THEN 1 ELSE 0 END, nextRunAt ASC, updatedAt DESC")
    List<RolePlanEntity> rolePlans(String characterId);

    @Query("SELECT * FROM role_plans WHERE planId = :planId LIMIT 1")
    RolePlanEntity rolePlan(String planId);

    @Query("SELECT * FROM role_plans WHERE status = 'active' AND nextRunAt IS NOT NULL AND nextRunAt <= :now ORDER BY nextRunAt ASC LIMIT :limit")
    List<RolePlanEntity> dueRolePlans(long now, int limit);

    @Query("SELECT * FROM role_plans WHERE status = 'active' AND nextRunAt IS NOT NULL ORDER BY nextRunAt ASC LIMIT 100")
    List<RolePlanEntity> dueOrFutureActiveRolePlans();

    @Query("SELECT * FROM role_plan_occurrences WHERE occurrenceId = :occurrenceId LIMIT 1")
    RolePlanOccurrenceEntity rolePlanOccurrence(String occurrenceId);

    @Query("SELECT * FROM role_plan_occurrences WHERE turnId = :turnId LIMIT 1")
    RolePlanOccurrenceEntity rolePlanOccurrenceByTurn(String turnId);

    @Query("UPDATE role_plan_occurrences SET state = 'COMPLETED', completedAt = :now, updatedAt = :now, errorCode = '' WHERE occurrenceId = :occurrenceId AND state != 'COMPLETED'")
    int completeRolePlanOccurrence(String occurrenceId, long now);

    @Query("UPDATE role_plan_occurrences SET state = 'FAILED', errorCode = :code, updatedAt = :now WHERE occurrenceId = :occurrenceId")
    int failRolePlanOccurrence(String occurrenceId, String code, long now);

    @Query("SELECT * FROM role_plan_history WHERE planId = :planId ORDER BY createdAt DESC LIMIT :limit")
    List<RolePlanHistoryEntity> rolePlanHistory(String planId, int limit);

    @Query("DELETE FROM role_plan_history WHERE planId IN (SELECT planId FROM role_plans WHERE characterId = :characterId)")
    int deleteRolePlanHistoryForCharacter(String characterId);

    @Query("DELETE FROM role_plans WHERE characterId = :characterId")
    int deleteRolePlansForCharacter(String characterId);

    @Query("SELECT * FROM execution_attempts WHERE attemptId = :attemptId LIMIT 1")
    ExecutionAttemptEntity attempt(String attemptId);

    @Query("SELECT * FROM execution_attempts WHERE turnId = :turnId ORDER BY sequence DESC")
    List<ExecutionAttemptEntity> attempts(String turnId);

    @Query("SELECT * FROM chat_turns WHERE state IN ('QUEUED','MEMORY_DONE','CHAT_DONE') AND deletedAt IS NULL ORDER BY CASE kind WHEN 'DIRECT_REPLY' THEN 0 WHEN 'ROLE_PLAN_CHAT' THEN 1 WHEN 'ROLE_PLAN_MOMENT' THEN 1 WHEN 'ROLE_PLAN_CHAT_PRIVATE' THEN 2 WHEN 'ROLE_PLAN_MOMENT_PRIVATE' THEN 2 WHEN 'PROACTIVE_CHAT' THEN 3 WHEN 'PROACTIVE_MOMENT' THEN 4 ELSE 5 END, createdAt ASC LIMIT 1")
    ChatTurnEntity nextRunnableTurn();

    @Query("SELECT * FROM chat_turns WHERE state = 'COMPLETED' AND deletedAt IS NULL ORDER BY completedAt DESC LIMIT 50")
    List<ChatTurnEntity> completedTurns();

    @Query("SELECT * FROM chat_turns WHERE state = 'COMPLETED' AND deletedAt IS NULL AND uiAppliedAt IS NULL ORDER BY completedAt ASC LIMIT :limit")
    List<ChatTurnEntity> unappliedCompletedTurns(int limit);

    @Query("UPDATE chat_turns SET uiAppliedAt = :now WHERE turnId = :turnId AND state = 'COMPLETED' AND uiAppliedAt IS NULL")
    int acknowledgeUiApplied(String turnId, long now);

    @Query("SELECT * FROM execution_attempts WHERE state IN ('MEMORY_RUNNING', 'MEMORY_DONE', 'CHAT_RUNNING', 'CHAT_DONE') ORDER BY startedAt ASC")
    List<ExecutionAttemptEntity> recoverableAttempts();

    @Query("SELECT COALESCE(MAX(sequence), 0) FROM execution_attempts WHERE turnId = :turnId")
    int maxAttemptSequence(String turnId);

    @Query("SELECT * FROM reply_parts WHERE turnId = :turnId ORDER BY sequence ASC")
    List<ReplyPartEntity> replyParts(String turnId);

    @Query("SELECT COUNT(*) FROM reply_parts WHERE turnId = :turnId")
    int replyPartCount(String turnId);

    @Query("UPDATE chat_turns SET activeAttemptId = :attemptId, state = 'QUEUED', updatedAt = :now, completedAt = NULL, uiAppliedAt = NULL WHERE turnId = :turnId")
    int activateAttempt(String turnId, String attemptId, long now);

    @Query("UPDATE chat_turns SET state = :state, updatedAt = :now WHERE turnId = :turnId AND activeAttemptId = :attemptId")
    int updateTurnState(String turnId, String attemptId, String state, long now);

    @Query("UPDATE execution_attempts SET stage = :stage, state = :state, heartbeatAt = :now WHERE attemptId = :attemptId")
    int updateAttemptStage(String attemptId, String stage, String state, long now);

    @Query("UPDATE execution_attempts SET memoryResult = :memoryResult, stage = 'CHAT', state = 'MEMORY_DONE', heartbeatAt = :now WHERE attemptId = :attemptId")
    int saveMemoryResult(String attemptId, String memoryResult, long now);

    @Query("UPDATE execution_attempts SET rawReply = :rawReply, stage = 'COMMIT', state = 'CHAT_DONE', heartbeatAt = :now WHERE attemptId = :attemptId")
    int saveRawReply(String attemptId, String rawReply, long now);

    @Query("UPDATE chat_turns SET state = 'COMPLETED', updatedAt = :now, completedAt = :now, uiAppliedAt = NULL WHERE turnId = :turnId AND activeAttemptId = :attemptId AND state = 'CHAT_DONE'")
    int completeTurn(String turnId, String attemptId, long now);

    @Query("UPDATE execution_attempts SET stage = 'FINISHED', state = 'COMPLETED', heartbeatAt = :now, finishedAt = :now, errorCode = NULL, errorDetail = NULL, retryable = 0 WHERE attemptId = :attemptId")
    int completeAttempt(String attemptId, long now);

    @Query("UPDATE chat_turns SET state = :state, updatedAt = :now WHERE turnId = :turnId AND activeAttemptId = :attemptId")
    int markTurnFailed(String turnId, String attemptId, String state, long now);

    @Query("UPDATE execution_attempts SET state = :state, errorCode = :code, errorDetail = :detail, retryable = :retryable, heartbeatAt = :now, finishedAt = :now WHERE attemptId = :attemptId")
    int markAttemptFailed(String attemptId, String state, String code, String detail, boolean retryable, long now);

    @Query("UPDATE chat_turns SET state = 'CANCELLED', activeAttemptId = NULL, updatedAt = :now, cancelledAt = :now, deletedAt = CASE WHEN :deleted = 1 THEN :now ELSE deletedAt END WHERE turnId = :turnId AND state != 'COMPLETED'")
    int cancelTurn(String turnId, long now, boolean deleted);

    @Query("UPDATE execution_attempts SET state = 'CANCELLED', stage = 'FINISHED', heartbeatAt = :now, finishedAt = :now, errorCode = 'CANCELLED', retryable = 0 WHERE attemptId = :attemptId")
    int cancelAttempt(String attemptId, long now);

    @Query("UPDATE execution_attempts SET state = 'CANCELLED', stage = 'FINISHED', heartbeatAt = :now, finishedAt = :now, errorCode = 'CANCELLED', retryable = 0 WHERE turnId IN (SELECT turnId FROM chat_turns WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT','ROLE_PLAN_CHAT','ROLE_PLAN_MOMENT','ROLE_PLAN_CHAT_PRIVATE','ROLE_PLAN_MOMENT_PRIVATE') AND state != 'COMPLETED') AND state NOT IN ('COMPLETED','CANCELLED')")
    int cancelAutomaticAttempts(long now);

    @Query("UPDATE chat_turns SET state = 'CANCELLED', activeAttemptId = NULL, updatedAt = :now, cancelledAt = :now WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT','ROLE_PLAN_CHAT','ROLE_PLAN_MOMENT','ROLE_PLAN_CHAT_PRIVATE','ROLE_PLAN_MOMENT_PRIVATE') AND state NOT IN ('COMPLETED','CANCELLED')")
    int cancelAutomaticTurns(long now);

    @Query("UPDATE chat_turns SET uiAppliedAt = :now WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT','ROLE_PLAN_CHAT','ROLE_PLAN_MOMENT','ROLE_PLAN_CHAT_PRIVATE','ROLE_PLAN_MOMENT_PRIVATE') AND state = 'COMPLETED' AND uiAppliedAt IS NULL")
    int acknowledgeCompletedAutomaticTurns(long now);

    @Query("DELETE FROM character_snapshots")
    int deleteProactiveSnapshots();

    @Transaction
    default void replaceRolePlans(String characterId, List<RolePlanEntity> plans, List<RolePlanHistoryEntity> history) {
        deleteRolePlanHistoryForCharacter(characterId);
        deleteRolePlansForCharacter(characterId);
        if (plans != null && !plans.isEmpty()) upsertRolePlans(plans);
        if (history != null && !history.isEmpty()) upsertRolePlanHistory(history);
    }

    @Transaction
    default void markStage(
        String turnId,
        String attemptId,
        String state,
        String stage,
        long now
    ) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || attemptId == null || !attemptId.equals(turn.activeAttemptId)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (updateTurnState(turnId, attemptId, state, now) != 1
            || updateAttemptStage(attemptId, stage, state, now) != 1) {
            throw new StaleAttemptException(turnId, attemptId);
        }
    }

    @Transaction
    default void saveMemoryCheckpoint(String turnId, String attemptId, String memory, long now) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || !attemptId.equals(turn.activeAttemptId) || !"MEMORY_RUNNING".equals(turn.state)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (saveMemoryResult(attemptId, memory, now) != 1
            || updateTurnState(turnId, attemptId, "MEMORY_DONE", now) != 1) {
            throw new StaleAttemptException(turnId, attemptId);
        }
    }

    @Transaction
    default void saveRawReplyCheckpoint(String turnId, String attemptId, String rawReply, long now) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || !attemptId.equals(turn.activeAttemptId) || !"CHAT_RUNNING".equals(turn.state)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (saveRawReply(attemptId, rawReply, now) != 1
            || updateTurnState(turnId, attemptId, "CHAT_DONE", now) != 1) {
            throw new StaleAttemptException(turnId, attemptId);
        }
    }

    @Query("SELECT * FROM change_events WHERE cursor > :cursor ORDER BY cursor ASC LIMIT :limit")
    List<ChangeEventEntity> changesAfter(long cursor, int limit);

    @Query("SELECT * FROM diagnostics ORDER BY createdAt DESC, diagnosticId DESC LIMIT :limit")
    List<DiagnosticEntity> latestDiagnostics(int limit);

    @Transaction
    default void commitReply(
        String turnId,
        String attemptId,
        List<ReplyPartEntity> parts,
        long now
    ) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || attemptId == null || !attemptId.equals(turn.activeAttemptId) || !"CHAT_DONE".equals(turn.state)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (replyPartCount(turnId) == 0) {
            insertReplyParts(parts);
        }
        if (completeTurn(turnId, attemptId, now) != 1) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        completeAttempt(attemptId, now);
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "REPLY_COMMITTED";
        change.payloadJson = "{\"turnId\":\"" + turnId + "\"}";
        change.createdAt = now;
        insertChange(change);
    }
}
