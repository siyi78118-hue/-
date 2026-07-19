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
        message.put("messageId", message.optString("messageId", submission.sourceMessageId));
        message.put("speakerId", "user");
        message.put("speakerType", "user");
        message.put("recipientId", submission.characterId);
        message.put("content", content);
        message.put("sentAt", message.optLong("sentAt", submission.createdAt));
        return message;
    }

    static long deviceSeq(TurnSubmission submission) throws Exception {
        return source(submission).optLong("deviceSeq", Math.max(1L, submission.createdAt));
    }
}
