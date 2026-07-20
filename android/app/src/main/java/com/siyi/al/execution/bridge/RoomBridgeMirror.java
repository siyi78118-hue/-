package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

public final class RoomBridgeMirror implements BridgeRouter.MessageMirror {
    private final AlExecutionDao dao;
    private final String deviceId;

    public RoomBridgeMirror(AlExecutionDao dao, String deviceId) {
        this.dao = dao;
        this.deviceId = deviceId == null || deviceId.trim().isEmpty() ? "phone" : deviceId.trim();
    }

    @Override public void persistSubmission(TurnSubmission submission) throws Exception {
        if (submission.kind != TurnKind.DIRECT_REPLY) return;
        JSONObject raw = BridgeInput.userMessage(submission);
        String content = raw.optString("content", "");
        if (content.trim().isEmpty()) throw new IllegalArgumentException("raw user message is empty");
        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = submission.sourceMessageId;
        entity.turnId = submission.turnId;
        entity.characterId = submission.characterId;
        entity.speakerId = "user";
        entity.speakerType = "user";
        entity.recipientId = submission.characterId;
        entity.content = content;
        entity.sentAt = raw.optLong("sentAt", submission.createdAt);
        entity.origin = "phone";
        entity.deviceId = deviceId;
        entity.deviceSeq = BridgeInput.deviceSeq(submission);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = nextSyncSeq();
        dao.insertRawMessage(entity);
    }

    @Override public void persistReply(TurnSubmission submission, BridgeResult result) throws Exception {
        JSONObject response = new JSONObject(result.responseJson == null ? "{}" : result.responseJson);
        JSONObject remoteReply = response.optJSONObject("reply");
        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = remoteReply == null
            ? "msg_reply_" + sha256(submission.turnId).substring(0, 24)
            : remoteReply.optString("messageId", "msg_reply_" + sha256(submission.turnId).substring(0, 24));
        entity.turnId = response.optString("turnId", submission.turnId);
        entity.characterId = submission.characterId;
        entity.speakerId = submission.characterId;
        entity.speakerType = "character";
        entity.recipientId = "user";
        entity.content = result.replyText;
        entity.sentAt = remoteReply == null
            ? System.currentTimeMillis()
            : remoteReply.optLong("sentAt", System.currentTimeMillis());
        entity.origin = result.fallback ? "fallback" : result.origin;
        entity.deviceId = result.fallback ? deviceId + ":fallback" : "pc:" + deviceId;
        entity.deviceSeq = Math.max(1L, entity.sentAt);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = result.fallback ? nextSyncSeq() : 0L;
        dao.insertRawMessage(entity);
    }

    public boolean persistCloudInboxReply(String raw) throws Exception {
        JSONObject response = new JSONObject(raw == null ? "{}" : raw);
        JSONObject reply = response.optJSONObject("reply");
        String remoteTurnId = response.optString("turnId", "").trim();
        if (remoteTurnId.isEmpty()) return false;

        String localTurnId = remoteTurnId.startsWith("turn_cloud_")
            ? remoteTurnId.substring("turn_".length())
            : remoteTurnId;
        ChatTurnEntity turn = dao.turn(localTurnId);
        if (turn == null && !localTurnId.equals(remoteTurnId)) {
            localTurnId = remoteTurnId;
            turn = dao.turn(localTurnId);
        }

        if (reply == null) {
            String remoteState = response.optString("state", "").trim();
            if (turn == null || !response.optBoolean("terminal", false) || !"failed".equals(remoteState)) {
                return false;
            }
            boolean retryable = response.optBoolean("allowFallback", false);
            return dao.importCloudBacklogFailure(
                localTurnId,
                retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
                "REMOTE_REPLY_FAILED",
                "回复暂时没有送达，请重试",
                System.currentTimeMillis()
            );
        }
        String content = reply.optString("content", "").trim();
        String messageId = reply.optString("messageId", "").trim();
        long sentAt = reply.optLong("sentAt", 0L);
        if (content.isEmpty() || messageId.isEmpty() || sentAt <= 0L) return false;

        String characterId = reply.optString("characterId", "").trim();
        if (characterId.isEmpty() && turn != null) characterId = turn.characterId;
        if (characterId.isEmpty()) characterId = response.optString("characterId", "").trim();
        if (characterId.isEmpty()) return false;

        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = messageId;
        entity.turnId = remoteTurnId;
        entity.characterId = characterId;
        entity.speakerId = entity.characterId;
        entity.speakerType = "character";
        entity.recipientId = "user";
        entity.content = content;
        entity.sentAt = sentAt;
        entity.origin = reply.optString("origin", "codex");
        entity.deviceId = "pc:" + deviceId;
        entity.deviceSeq = Math.max(1L, sentAt);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = 0L;
        dao.insertRawMessage(entity);

        if (turn != null) {
            ReplyPartEntity originalPart = backlogPart(messageId, localTurnId, turn.activeAttemptId, content, sentAt);
            if (dao.importCloudBacklogReply(localTurnId, originalPart, sentAt)) return true;
        }

        String digest = sha256(messageId).substring(0, 24);
        String backfillTurnId = "cloud_backfill_" + digest;
        ChatTurnEntity backfillTurn = dao.turn(backfillTurnId);
        if (backfillTurn == null) {
            backfillTurn = new ChatTurnEntity();
            backfillTurn.turnId = backfillTurnId;
            backfillTurn.characterId = characterId;
            backfillTurn.sourceMessageId = "source_cloud_backfill_" + digest;
            backfillTurn.cloudJobId = null;
            backfillTurn.kind = TurnKind.PROACTIVE_CHAT.name();
            backfillTurn.state = "COMPLETED";
            backfillTurn.activeAttemptId = null;
            backfillTurn.inputJson = new JSONObject()
                .put("source", "cloud_backfill")
                .put("remoteTurnId", remoteTurnId)
                .toString();
            backfillTurn.snapshotJson = new JSONObject()
                .put("characterId", characterId)
                .toString();
            backfillTurn.createdAt = sentAt;
            backfillTurn.updatedAt = sentAt;
            backfillTurn.completedAt = sentAt;
            backfillTurn.uiAppliedAt = null;
            dao.insertTurn(backfillTurn);
        }
        ReplyPartEntity independentPart = backlogPart(messageId, backfillTurnId, null, content, sentAt);
        return dao.importCloudBacklogReply(backfillTurnId, independentPart, sentAt);
    }

    private static ReplyPartEntity backlogPart(
        String messageId, String turnId, String attemptId, String content, long sentAt
    ) throws Exception {
        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "reply_backfill_" + sha256(messageId).substring(0, 24);
        part.turnId = turnId;
        part.attemptId = attemptId == null || attemptId.isEmpty()
            ? "attempt_backfill_" + sha256(turnId).substring(0, 24)
            : attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = content;
        part.payloadJson = "{}";
        part.createdAt = sentAt;
        return part;
    }

    private long nextSyncSeq() {
        return Math.max(1L, Math.max(dao.maxRawSyncSeq(), dao.maxAnnotationSyncSeq()) + 1L);
    }

    private static String canonical(RawMessageEntity value) {
        return value.messageId + "\n" + value.turnId + "\n" + value.speakerId + "\n" + value.content + "\n" + value.sentAt;
    }

    private static String sha256(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (byte item : hash) out.append(String.format("%02x", item & 0xff));
        return out.toString();
    }
}
