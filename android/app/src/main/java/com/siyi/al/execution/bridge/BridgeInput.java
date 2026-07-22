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
            JSONObject input = source(submission);
            JSONObject snapshot = new JSONObject(submission.snapshotJson);
            JSONObject options = input.optJSONObject("options");
            JSONObject suppliedPayment = options == null ? null : options.optJSONObject("payment");
            JSONObject context = new JSONObject();
            JSONObject scene = snapshot.optJSONObject("scene");
            if (scene != null) context.put("scene", new JSONObject(scene.toString()));
            if (suppliedPayment != null) {
                String kind = suppliedPayment.optString("kind", suppliedPayment.optString("type", "")).trim().toLowerCase(java.util.Locale.ROOT);
                double amount = Math.round(suppliedPayment.optDouble("amount", 0) * 100.0) / 100.0;
                String messageId = options.optString("paymentMessageId", submission.sourceMessageId).trim();
                if (("redpacket".equals(kind) || "transfer".equals(kind)) && amount > 0 && !messageId.isEmpty()) {
                    JSONObject payment = new JSONObject()
                        .put("kind", kind)
                        .put("amount", amount)
                        .put("note", suppliedPayment.optString("note", "").replaceAll("\\s+", " ").trim())
                        .put("messageId", messageId)
                        .put("status", suppliedPayment.optString("status", "pending").trim().toLowerCase(java.util.Locale.ROOT));
                    context.put("payment", payment);
                }
            }
            if (context.length() > 0) envelope.put("context", context);
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
        JSONObject scene = snapshot.optJSONObject("scene");
        if (scene != null) context.put("scene", new JSONObject(scene.toString()));
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
