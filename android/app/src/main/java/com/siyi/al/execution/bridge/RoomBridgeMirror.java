package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.RawMessageEntity;
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
        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = "msg_reply_" + sha256(submission.turnId).substring(0, 24);
        entity.turnId = submission.turnId;
        entity.characterId = submission.characterId;
        entity.speakerId = submission.characterId;
        entity.speakerType = "character";
        entity.recipientId = "user";
        entity.content = result.replyText;
        entity.sentAt = System.currentTimeMillis();
        entity.origin = result.origin;
        entity.deviceId = result.fallback ? deviceId + ":fallback" : "pc:" + deviceId;
        entity.deviceSeq = Math.max(1L, entity.sentAt);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = nextSyncSeq();
        dao.insertRawMessage(entity);
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
