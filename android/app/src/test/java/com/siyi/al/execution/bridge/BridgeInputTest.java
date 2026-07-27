package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeInputTest {
    @Test
    public void directRetryPreservesCanonicalLineageInEnvelope() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_retry_2",
            "yuqi",
            "msg_phone_1",
            TurnKind.DIRECT_REPLY,
            new JSONObject()
                .put("userText", "你好")
                .put("deviceSeq", 2)
                .put("message", new JSONObject()
                    .put("messageId", "msg_phone_1")
                    .put("content", "你好")
                    .put("sentAt", 1000))
                .put("retry", new JSONObject()
                    .put("retryOfTurnId", "turn_phone_1")
                    .put("canonicalMessageId", "msg_phone_1"))
                .toString(),
            "{}",
            null,
            2000
        );
        BridgeConfig config = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17891", "",
            "device1", "123456789012", "", "", 1200, 90000, 60, 1000
        );

        JSONObject retry = BridgeInput.envelope(submission, config)
            .getJSONObject("context")
            .getJSONObject("retry");

        assertEquals("turn_phone_1", retry.getString("retryOfTurnId"));
        assertEquals("msg_phone_1", retry.getString("canonicalMessageId"));
    }

    @Test
    public void directImageAttachmentsRemainInsideTheCanonicalUserMessage() throws Exception {
        JSONObject attachment = new JSONObject()
            .put("attachmentId", "att_msg_phone_2")
            .put("messageId", "msg_phone_2")
            .put("kind", "image")
            .put("mime", "image/jpeg")
            .put("name", "one.jpg")
            .put("width", 1)
            .put("height", 1)
            .put("bytes", 4)
            .put("dataUrl", "data:image/jpeg;base64,/9j/2Q==");
        TurnSubmission submission = new TurnSubmission(
            "turn_phone_2",
            "yuqi",
            "msg_phone_2",
            TurnKind.DIRECT_REPLY,
            new JSONObject()
                .put("userText", "[图片]")
                .put("deviceSeq", 2)
                .put("message", new JSONObject()
                    .put("messageId", "msg_phone_2")
                    .put("content", "[图片]")
                    .put("attachments", new JSONArray().put(attachment))
                    .put("sentAt", 2000))
                .toString(),
            "{}",
            null,
            2000
        );
        BridgeConfig config = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17891", "",
            "device1", "123456789012", "", "", 1200, 90000, 60, 1000
        );

        JSONObject message = BridgeInput.envelope(submission, config).getJSONObject("message");

        assertEquals("[图片]", message.getString("content"));
        assertEquals("att_msg_phone_2", message.getJSONArray("attachments").getJSONObject(0).getString("attachmentId"));
    }
}
