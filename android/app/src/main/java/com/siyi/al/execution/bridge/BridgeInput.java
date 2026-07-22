package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import org.json.JSONObject;

final class BridgeInput {
    private BridgeInput() {}

    static JSONObject source(TurnSubmission submission) throws Exception {
        return new JSONObject(submission.inputJson);
    }

    static JSONObject userMessage(TurnSubmission submission) throws Exception {
        JSONObject input = source(submission);
        JSONObject supplied = input.optJSONObject("message");
        JSONObject message = supplied == null ? new JSONObject() : new JSONObject(supplied.toString());
        String content = message.optString("content", "");
        if (content.trim().isEmpty()) content = input.optString("text", "");
        if (content.trim().isEmpty()) content = input.optString("userText", "");
        message.put("messageId", wireMessageId(message.optString("messageId", submission.sourceMessageId)));
        message.put("speakerId", "user");
        message.put("speakerType", "user");
        message.put("recipientId", submission.characterId);
        message.put("content", content);
        message.put("sentAt", message.optLong("sentAt", submission.createdAt));
        return message;
    }

    static String wireMessageId(String value) {
        String messageId = value == null ? "" : value.trim();
        if (messageId.startsWith("msg_")) return messageId;
        if (messageId.startsWith("pay_")) return "msg_" + messageId;
        return messageId;
    }

    static long deviceSeq(TurnSubmission submission) throws Exception {
        return source(submission).optLong("deviceSeq", Math.max(1L, submission.createdAt));
    }

    static String wireTurnId(TurnSubmission submission) {
        return submission.turnId.startsWith("turn_")
            ? submission.turnId
            : (submission.kind == com.siyi.al.execution.TurnKind.DIRECT_REPLY
                ? submission.turnId
                : "turn_" + submission.turnId);
    }

    static JSONObject envelope(TurnSubmission submission, BridgeConfig config) throws Exception {
        String wireTurnId = wireTurnId(submission);
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 2)
            .put("turnId", wireTurnId)
            .put("characterId", submission.characterId)
            .put("deviceId", config.deviceId)
            .put("deviceSeq", deviceSeq(submission))
            .put("createdAt", Math.max(1L, submission.createdAt))
            .put("kind", submission.kind.name());
        if (submission.kind == com.siyi.al.execution.TurnKind.DIRECT_REPLY) {
            envelope.put("message", userMessage(submission));
            return envelope;
        }

        JSONObject input = source(submission);
        JSONObject snapshot = new JSONObject(submission.snapshotJson);
        String triggerId = submission.sourceMessageId.startsWith("trigger_")
            ? submission.sourceMessageId
            : "trigger_" + submission.sourceMessageId;
        JSONObject context = new JSONObject()
            .put("input", input)
            .put("snapshot", snapshot);
        if (submission.cloudJobId != null) context.put("cloudJobId", submission.cloudJobId);
        envelope.put("trigger", new JSONObject()
            .put("triggerId", triggerId)
            .put("triggerType", submission.kind.name().toLowerCase(java.util.Locale.ROOT))
            .put("scheduledFor", Math.max(1L, input.optLong("scheduledFor", submission.createdAt)))
            .put("executedAt", Math.max(1L, submission.createdAt))
            .put("context", context));
        return envelope;
    }
}
