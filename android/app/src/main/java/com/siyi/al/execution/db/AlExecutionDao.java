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

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertYuqiAnnotation(YuqiAnnotationEntity annotation);

    @Query("SELECT * FROM yuqi_raw_messages WHERE characterId = :characterId ORDER BY sentAt DESC LIMIT :limit")
    List<RawMessageEntity> recentRawMessages(String characterId, int limit);

    @Query("SELECT * FROM yuqi_raw_messages WHERE messageId = :messageId LIMIT 1")
    RawMessageEntity rawMessage(String messageId);

    @Query("SELECT * FROM yuqi_raw_messages WHERE characterId = :characterId AND syncSeq > :afterSeq ORDER BY syncSeq ASC, messageId ASC LIMIT :limit")
    List<RawMessageEntity> rawMessagesAfterSync(String characterId, long afterSeq, int limit);

    @Query("SELECT COALESCE(MAX(syncSeq), 0) FROM yuqi_raw_messages")
    long maxRawSyncSeq();

    @Query("SELECT COALESCE(MAX(syncSeq), 0) FROM yuqi_annotations")
    long maxAnnotationSyncSeq();

    @Query("SELECT * FROM yuqi_annotations WHERE syncSeq > :afterSeq ORDER BY syncSeq ASC, annotationId ASC LIMIT :limit")
    List<YuqiAnnotationEntity> annotationsAfterSync(long afterSeq, int limit);

    @Query("SELECT COUNT(*) FROM yuqi_annotations WHERE status = 'proposed'")
    int pendingYuqiAnnotationCount();

    @Query("SELECT COUNT(*) FROM yuqi_raw_messages WHERE syncSeq > :afterSeq")
    int rawMessageCountAfterSync(long afterSeq);

    @Query("SELECT COUNT(*) FROM yuqi_evidence_facts WHERE status = 'verified'")
    int verifiedYuqiFactCount();

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

    @Query("SELECT o.* FROM role_plan_occurrences o INNER JOIN chat_turns t ON t.turnId = o.turnId WHERE o.state = 'CLAIMED' AND t.state IN ('FAILED_FINAL', 'CANCELLED') ORDER BY o.updatedAt ASC LIMIT :limit")
    List<RolePlanOccurrenceEntity> failedRolePlanOccurrences(int limit);

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

    @Query("SELECT * FROM chat_turns WHERE state = 'FAILED_RETRYABLE' AND deletedAt IS NULL ORDER BY updatedAt ASC")
    List<ChatTurnEntity> retryableTurns();

    @Query("SELECT * FROM chat_turns WHERE kind = 'DIRECT_REPLY' AND characterId = :characterId AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT 1")
    ChatTurnEntity latestDirectTurn(String characterId);

    @Query("SELECT * FROM chat_turns WHERE state = 'COMPLETED' AND deletedAt IS NULL ORDER BY completedAt DESC LIMIT 50")
    List<ChatTurnEntity> completedTurns();

    @Query("SELECT * FROM chat_turns WHERE state = 'COMPLETED' AND deletedAt IS NULL AND uiAppliedAt IS NULL ORDER BY completedAt ASC LIMIT :limit")
    List<ChatTurnEntity> unappliedCompletedTurns(int limit);

    @Query("SELECT * FROM chat_turns WHERE state = 'COMPLETED' AND deletedAt IS NULL ORDER BY completedAt DESC LIMIT :limit")
    List<ChatTurnEntity> recentCompletedTurns(int limit);

    @Query("UPDATE chat_turns SET uiAppliedAt = :now WHERE turnId = :turnId AND state = 'COMPLETED' AND uiAppliedAt IS NULL")
    int acknowledgeUiApplied(String turnId, long now);

    @Query("UPDATE chat_turns SET notificationShownAt = :now WHERE turnId = :turnId AND state = 'COMPLETED' AND notificationShownAt IS NULL")
    int markNotificationShown(String turnId, long now);

    @Query("UPDATE chat_turns SET cloudConfirmedAt = :now WHERE turnId = :turnId AND state = 'COMPLETED' AND uiAppliedAt IS NOT NULL AND cloudConfirmedAt IS NULL")
    int markCloudConfirmed(String turnId, long now);

    @Query("SELECT * FROM execution_attempts WHERE state IN ('MEMORY_RUNNING', 'MEMORY_DONE', 'CHAT_RUNNING', 'CHAT_DONE') ORDER BY startedAt ASC")
    List<ExecutionAttemptEntity> recoverableAttempts();

    @Query("SELECT COALESCE(MAX(sequence), 0) FROM execution_attempts WHERE turnId = :turnId")
    int maxAttemptSequence(String turnId);

    @Query("SELECT * FROM reply_parts WHERE turnId = :turnId ORDER BY sequence ASC")
    List<ReplyPartEntity> replyParts(String turnId);

    @Query("SELECT COUNT(*) FROM reply_parts WHERE turnId = :turnId")
    int replyPartCount(String turnId);

    @Query("UPDATE chat_turns SET activeAttemptId = :attemptId, state = 'QUEUED', updatedAt = :now, completedAt = NULL, notificationShownAt = NULL, uiAppliedAt = NULL, cloudConfirmedAt = NULL WHERE turnId = :turnId")
    int activateAttempt(String turnId, String attemptId, long now);

    @Query("UPDATE chat_turns SET inputJson = :inputJson, snapshotJson = :snapshotJson, updatedAt = :now WHERE turnId = :turnId AND state IN ('FAILED_RETRYABLE','FAILED_FINAL','INTERRUPTED')")
    int replaceRetryPayload(String turnId, String inputJson, String snapshotJson, long now);

    @Query("UPDATE chat_turns SET state = :state, updatedAt = :now WHERE turnId = :turnId AND activeAttemptId = :attemptId")
    int updateTurnState(String turnId, String attemptId, String state, long now);

    @Query("UPDATE execution_attempts SET stage = :stage, state = :state, heartbeatAt = :now WHERE attemptId = :attemptId")
    int updateAttemptStage(String attemptId, String stage, String state, long now);

    @Query("UPDATE execution_attempts SET memoryResult = :memoryResult, stage = 'CHAT', state = 'MEMORY_DONE', heartbeatAt = :now WHERE attemptId = :attemptId")
    int saveMemoryResult(String attemptId, String memoryResult, long now);

    @Query("UPDATE execution_attempts SET rawReply = :rawReply, stage = 'COMMIT', state = 'CHAT_DONE', heartbeatAt = :now WHERE attemptId = :attemptId")
    int saveRawReply(String attemptId, String rawReply, long now);

    @Query("UPDATE chat_turns SET state = 'COMPLETED', updatedAt = :now, completedAt = :now, notificationShownAt = NULL, uiAppliedAt = NULL, cloudConfirmedAt = NULL WHERE turnId = :turnId AND activeAttemptId = :attemptId AND state = 'CHAT_DONE'")
    int completeTurn(String turnId, String attemptId, long now);

    @Query("UPDATE chat_turns SET state = 'COMPLETED', updatedAt = :now, completedAt = :now, notificationShownAt = NULL, uiAppliedAt = NULL, cloudConfirmedAt = NULL WHERE turnId = :turnId AND activeAttemptId = :attemptId AND state = 'CHAT_RUNNING'")
    int completeSkippedTurn(String turnId, String attemptId, long now);

    @Query("UPDATE execution_attempts SET stage = 'FINISHED', state = 'COMPLETED', heartbeatAt = :now, finishedAt = :now, errorCode = NULL, errorDetail = NULL, retryable = 0 WHERE attemptId = :attemptId")
    int completeAttempt(String attemptId, long now);

    @Query("UPDATE chat_turns SET state = :state, updatedAt = :now WHERE turnId = :turnId AND activeAttemptId = :attemptId AND state != 'COMPLETED'")
    int markTurnFailed(String turnId, String attemptId, String state, long now);

    @Query("UPDATE execution_attempts SET state = :state, errorCode = :code, errorDetail = :detail, retryable = :retryable, heartbeatAt = :now, finishedAt = :now WHERE attemptId = :attemptId AND state != 'COMPLETED'")
    int markAttemptFailed(String attemptId, String state, String code, String detail, boolean retryable, long now);

    @Query("UPDATE chat_turns SET state = 'COMPLETED', updatedAt = :completedAt, completedAt = :completedAt, notificationShownAt = NULL, uiAppliedAt = NULL, cloudConfirmedAt = NULL, cancelledAt = NULL, deletedAt = NULL WHERE turnId = :turnId")
    int completeImportedCloudTurn(String turnId, long completedAt);

    @Query("UPDATE execution_attempts SET stage = 'FINISHED', state = 'COMPLETED', heartbeatAt = :completedAt, finishedAt = :completedAt, errorCode = NULL, errorDetail = NULL, retryable = 0 WHERE attemptId = :attemptId")
    int completeImportedCloudAttempt(String attemptId, long completedAt);

    @Query("UPDATE chat_turns SET state = :state, updatedAt = :now WHERE turnId = :turnId AND state != 'COMPLETED'")
    int failImportedCloudTurn(String turnId, String state, long now);

    @Query("UPDATE execution_attempts SET stage = 'FINISHED', state = :state, errorCode = :code, errorDetail = :detail, retryable = :retryable, heartbeatAt = :now, finishedAt = :now WHERE attemptId = :attemptId")
    int failImportedCloudAttempt(String attemptId, String state, String code, String detail, boolean retryable, long now);

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

    @Query("SELECT * FROM diagnostics WHERE turnId = :turnId AND code = 'BRIDGE_STATUS' ORDER BY createdAt DESC, diagnosticId DESC LIMIT 1")
    DiagnosticEntity latestBridgeStatus(String turnId);

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

    @Transaction
    default void commitSkip(String turnId, String attemptId, long now) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || attemptId == null || !attemptId.equals(turn.activeAttemptId) || !"CHAT_RUNNING".equals(turn.state)) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        if (replyPartCount(turnId) != 0 || completeSkippedTurn(turnId, attemptId, now) != 1) {
            throw new StaleAttemptException(turnId, attemptId);
        }
        completeAttempt(attemptId, now);
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_SKIPPED";
        change.payloadJson = "{\"turnId\":\"" + turnId + "\",\"action\":\"skip\"}";
        change.createdAt = now;
        insertChange(change);
    }

    @Transaction
    default boolean importCloudBacklogReply(String turnId, ReplyPartEntity part, long completedAt) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null) return false;
        List<ReplyPartEntity> existing = replyParts(turnId);
        boolean replyAlreadyStored = false;
        if (!existing.isEmpty()) {
            for (ReplyPartEntity value : existing) {
                if (value.replyPartId.equals(part.replyPartId) && value.content.equals(part.content)) {
                    replyAlreadyStored = true;
                    break;
                }
            }
            if (!replyAlreadyStored) return false;
        }
        String state = turn.state == null ? "" : turn.state;
        if (!("FAILED_RETRYABLE".equals(state) || "FAILED_FINAL".equals(state)
            || "INTERRUPTED".equals(state) || "CANCELLED".equals(state)
            || "COMPLETED".equals(state))) return false;
        if (!replyAlreadyStored) insertReplyParts(java.util.Collections.singletonList(part));
        if ("COMPLETED".equals(state) && replyAlreadyStored) return true;
        if (completeImportedCloudTurn(turnId, completedAt) != 1) return false;
        if (turn.activeAttemptId != null && !turn.activeAttemptId.isEmpty()) {
            completeImportedCloudAttempt(turn.activeAttemptId, completedAt);
        }
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "REPLY_COMMITTED";
        change.payloadJson = "{\"turnId\":\"" + turnId + "\",\"origin\":\"cloud_backfill\"}";
        change.createdAt = completedAt;
        insertChange(change);
        return true;
    }

    @Transaction
    default boolean importCloudBacklogFailure(
        String turnId,
        String state,
        String code,
        String detail,
        long now
    ) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || "COMPLETED".equals(turn.state)) return false;
        if (failImportedCloudTurn(turnId, state, now) != 1) return false;
        if (turn.activeAttemptId != null && !turn.activeAttemptId.isEmpty()) {
            failImportedCloudAttempt(
                turn.activeAttemptId,
                state,
                code,
                detail,
                "FAILED_RETRYABLE".equals(state),
                now
            );
        }
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_FAILED";
        change.payloadJson = "{\"turnId\":\"" + turnId + "\"}";
        change.createdAt = now;
        insertChange(change);
        return true;
    }

    @Transaction
    default boolean importCloudBacklogSkip(String turnId, long now) {
        ChatTurnEntity turn = turn(turnId);
        if (turn == null || replyPartCount(turnId) != 0) return false;
        if (!"COMPLETED".equals(turn.state) && completeImportedCloudTurn(turnId, now) != 1) return false;
        if (turn.activeAttemptId != null && !turn.activeAttemptId.isEmpty()) {
            completeImportedCloudAttempt(turn.activeAttemptId, now);
        }
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_SKIPPED";
        change.payloadJson = "{\"turnId\":\"" + turnId + "\",\"action\":\"skip\",\"origin\":\"cloud_backfill\"}";
        change.createdAt = now;
        insertChange(change);
        return true;
    }
}
