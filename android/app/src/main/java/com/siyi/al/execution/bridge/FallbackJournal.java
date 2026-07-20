package com.siyi.al.execution.bridge;

import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.SyncCursorEntity;
import com.siyi.al.execution.db.YuqiAnnotationEntity;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.ArrayList;
import java.util.Comparator;
import org.json.JSONArray;
import org.json.JSONObject;

public final class FallbackJournal {
    private static final String PC_PEER = "yuqi_pc";
    private final AlExecutionDao dao;
    private final String deviceId;

    public FallbackJournal(AlExecutionDao dao, String deviceId) {
        this.dao = dao;
        this.deviceId = deviceId == null || deviceId.trim().isEmpty() ? "phone" : deviceId.trim();
    }

    public JSONObject pendingPacket(int limit) throws Exception {
        SyncCursorEntity cursor = dao.syncCursor(PC_PEER);
        long afterSeq = cursor == null ? 0L : cursor.ackSeq;
        int safeLimit = Math.max(1, Math.min(1000, limit));
        return buildPacket(
            deviceId,
            afterSeq,
            dao.rawMessagesAfterSync("yuqi", afterSeq, safeLimit),
            dao.annotationsAfterSync(afterSeq, safeLimit),
            safeLimit
        );
    }

    public void acknowledge(long seq) {
        if (seq <= 0L) return;
        SyncCursorEntity existing = dao.syncCursor(PC_PEER);
        if (existing != null && existing.ackSeq >= seq) return;
        SyncCursorEntity cursor = new SyncCursorEntity();
        cursor.peerId = PC_PEER;
        cursor.ackSeq = seq;
        cursor.updatedAt = System.currentTimeMillis();
        dao.upsertSyncCursor(cursor);
    }

    static JSONObject buildPacket(String deviceId, long afterSeq, List<RawMessageEntity> messages) throws Exception {
        return buildPacket(deviceId, afterSeq, messages, java.util.Collections.emptyList(), 1000);
    }

    private static JSONObject buildPacket(
        String deviceId,
        long afterSeq,
        List<RawMessageEntity> messages,
        List<YuqiAnnotationEntity> annotations,
        int limit
    ) throws Exception {
        ArrayList<JSONObject> ordered = new ArrayList<>();
        long lastSeq = afterSeq;
        for (RawMessageEntity message : messages) {
            JSONObject payload = messagePayload(message);
            JSONObject entry = new JSONObject()
                .put("seq", message.syncSeq)
                .put("entityType", "message")
                .put("entityId", message.messageId)
                .put("operation", "insert")
                .put("payload", payload)
                .put("checksum", sha256(canonical(payload)))
                .put("createdAt", message.sentAt);
            ordered.add(entry);
        }
        for (YuqiAnnotationEntity annotation : annotations) {
            JSONObject payload = annotationPayload(annotation);
            ordered.add(new JSONObject()
                .put("seq", annotation.syncSeq)
                .put("entityType", "annotation")
                .put("entityId", annotation.annotationId)
                .put("operation", "insert")
                .put("payload", payload)
                .put("checksum", sha256(canonical(payload)))
                .put("createdAt", annotation.createdAt));
        }
        ordered.sort(Comparator.comparingLong(value -> value.optLong("seq")));
        JSONArray entries = new JSONArray();
        for (int index = 0; index < Math.min(limit, ordered.size()); index += 1) {
            JSONObject entry = ordered.get(index);
            entries.put(entry);
            lastSeq = Math.max(lastSeq, entry.optLong("seq"));
        }
        return new JSONObject()
            .put("peerId", deviceId)
            .put("lastCommonSeq", afterSeq)
            .put("lastSeq", lastSeq)
            .put("entries", entries);
    }

    private static JSONObject annotationPayload(YuqiAnnotationEntity value) throws Exception {
        return new JSONObject()
            .put("annotationId", value.annotationId)
            .put("createdAt", value.createdAt)
            .put("desiredBehavior", value.desiredBehavior)
            .put("presetVersion", value.presetVersion)
            .put("sourceMessageId", value.sourceMessageId == null ? JSONObject.NULL : value.sourceMessageId)
            .put("status", value.status)
            .put("turnId", value.turnId)
            .put("userCorrection", value.userCorrection);
    }

    private static JSONObject messagePayload(RawMessageEntity value) throws Exception {
        JSONObject payload = new JSONObject()
            .put("characterId", value.characterId)
            .put("content", value.content)
            .put("deviceId", value.deviceId)
            .put("deviceSeq", value.deviceSeq)
            .put("messageId", value.messageId)
            .put("origin", value.origin)
            .put("recipientId", value.recipientId)
            .put("sentAt", value.sentAt)
            .put("speakerId", value.speakerId)
            .put("speakerType", value.speakerType)
            .put("turnId", value.turnId);
        return payload;
    }

    private static String canonical(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            java.util.ArrayList<String> keys = new java.util.ArrayList<>();
            java.util.Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            java.util.Collections.sort(keys);
            StringBuilder output = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index += 1) {
                if (index > 0) output.append(',');
                String key = keys.get(index);
                output.append(jsonQuote(key)).append(':').append(canonical(object.get(key)));
            }
            return output.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder output = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) output.append(',');
                output.append(canonical(array.get(index)));
            }
            return output.append(']').toString();
        }
        if (value instanceof String) return jsonQuote((String) value);
        if (value instanceof Boolean || value instanceof Number) return String.valueOf(value);
        return jsonQuote(String.valueOf(value));
    }

    private static String jsonQuote(String value) {
        // JSONObject follows an older JSON convention and escapes '/', while
        // JavaScript JSON.stringify does not. The bridge checksum is shared
        // across Android and Node, so use the JavaScript canonical form.
        return JSONObject.quote(value).replace("\\/", "/");
    }

    private static String sha256(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder();
        for (byte item : hash) output.append(String.format("%02x", item & 0xff));
        return output.toString();
    }
}
