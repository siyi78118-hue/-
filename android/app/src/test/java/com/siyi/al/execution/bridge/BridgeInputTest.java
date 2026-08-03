package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.BridgeAuthority;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeInputTest {
    @Test
    public void preparedV3SubmissionEmitsTheExactPinnedEnvelopeAndRemoteIdentity() throws Exception {
        JSONArray messages = new JSONArray()
            .put(batchMessage("msg_v3_1", "第一泡", 1000L))
            .put(batchMessage("msg_v3_2", "第二泡", 1100L))
            .put(batchMessage("msg_v3_3", "第三泡", 1200L));
        JSONObject cursor = new JSONObject()
            .put("nativeCompletedTurnId", "turn_pc_before")
            .put("nativeCompletedGroupId", "grp_before")
            .put("nativeCompletedSequence", 7L)
            .put("uiAppliedTurnId", "turn_pc_before")
            .put("uiAppliedGroupId", "grp_before")
            .put("uiAppliedSequence", 7L)
            .put("localSequence", 8L)
            .put("clearedThroughSequence", 2L)
            .put("clearEpoch", 3L);
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_remote_v3")
            .put("characterId", "yuqi")
            .put("deviceId", "device1")
            .put("deviceSeq", 8L)
            .put("createdAt", 1300L)
            .put("kind", "DIRECT_REPLY")
            .put("message", messages.getJSONObject(2))
            .put("context", new JSONObject()
                .put("currentBatch", new JSONObject()
                    .put("batchId", "batch_v3")
                    .put("messageIds", new JSONArray().put("msg_v3_1").put("msg_v3_2").put("msg_v3_3"))
                    .put("messages", messages)
                    .put("startedAt", 1000L)
                    .put("committedAt", 1300L))
                .put("visibilityCursor", cursor))
            .put("authority", new JSONObject()
                .put("algorithm", "al-authority-v1")
                .put("roleId", "yuqi")
                .put("laneKey", "private_chat")
                .put("rootSourceId", "msg_v3_1")
                .put("lineageKey", "lin_v3")
                .put("claimedLineageRevision", 1L)
                .put("retryOfTurnId", JSONObject.NULL));
        JSONObject checkpoint = new JSONObject()
            .put("version", 1)
            .put("localTurnId", "local_v3")
            .put("attemptId", "attempt_local_v3_1")
            .put("attemptSequence", 1)
            .put("authoritativeTurnId", "turn_remote_v3")
            .put("authorityLineageKey", "lin_v3")
            .put("claimedLineageRevision", 1L)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 8L)
            .put("inputClearEpoch", 3L)
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", openOutcome());
        TurnSubmission prepared = new TurnSubmission(
            "local_v3", "yuqi", "msg_v3_3", TurnKind.DIRECT_REPLY,
            "{}", "{}", null, 1300L,
            "turn_remote_v3", checkpoint.toString()
        );
        BridgeConfig config = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17891", "",
            "device1", "123456789012", "", "", 1200, 90000, 60, 1000
        );

        JSONObject projected = BridgeInput.envelope(prepared, config);

        assertEquals(
            BridgeAuthority.canonicalJson(envelope),
            BridgeAuthority.canonicalJson(projected)
        );
        assertEquals("turn_remote_v3", prepared.authoritativeTurnId);
        assertEquals(3, projected.getJSONObject("context")
            .getJSONObject("currentBatch").getJSONArray("messages").length());
        assertEquals(8L, projected.getJSONObject("context")
            .getJSONObject("visibilityCursor").getLong("localSequence"));
    }

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

    @Test
    public void directCurrentBatchCarriesEveryOrderedMessagePayload() throws Exception {
        JSONArray batchMessages = new JSONArray()
            .put(new JSONObject()
                .put("messageId", "msg_batch_1")
                .put("speakerId", "user")
                .put("speakerType", "user")
                .put("recipientId", "yuqi")
                .put("content", "你明明答应过我，我真的很失望")
                .put("sentAt", 1000))
            .put(new JSONObject()
                .put("messageId", "msg_batch_2")
                .put("speakerId", "user")
                .put("speakerType", "user")
                .put("recipientId", "yuqi")
                .put("content", "算了")
                .put("sentAt", 2000));
        TurnSubmission submission = new TurnSubmission(
            "turn_batch_1",
            "yuqi",
            "msg_batch_2",
            TurnKind.DIRECT_REPLY,
            new JSONObject()
                .put("deviceSeq", 3)
                .put("message", batchMessages.getJSONObject(1))
                .put("options", new JSONObject()
                    .put("batchId", "batch_1")
                    .put("batchMessageIds", new JSONArray()
                        .put("msg_batch_1")
                        .put("msg_batch_2"))
                    .put("batchMessages", batchMessages)
                    .put("batchStartedAt", 1000)
                    .put("batchCommittedAt", 3000))
                .toString(),
            "{}",
            null,
            3000
        );
        BridgeConfig config = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17891", "",
            "device1", "123456789012", "", "", 1200, 90000, 60, 1000
        );

        JSONObject currentBatch = BridgeInput.envelope(submission, config)
            .getJSONObject("context")
            .getJSONObject("currentBatch");

        assertEquals(2, currentBatch.getJSONArray("messages").length());
        assertEquals(
            "你明明答应过我，我真的很失望",
            currentBatch.getJSONArray("messages").getJSONObject(0).getString("content")
        );
        assertEquals(
            "msg_batch_2",
            currentBatch.getJSONArray("messages").getJSONObject(1).getString("messageId")
        );
    }

    @Test
    public void v3MomentReplyUsesOneExplicitMomentForItsLaneAndTriggerContext() throws Exception {
        JSONObject input = new JSONObject()
            .put("momentId", "moment_authoritative_7")
            .put("scheduledFor", 4000L)
            .put("comment", "这条我看见了");
        JSONObject snapshot = new JSONObject()
            .put("scene", new JSONObject().put("kind", "moment_reply"))
            .put("_alBridgeProtocol", new JSONObject()
                .put("version", 3)
                .put("owner", "room-v12"));
        TurnSubmission submission = new TurnSubmission(
            "local_moment_reply", "yuqi", "moment-trigger-7", TurnKind.MOMENT_REPLY,
            input.toString(), snapshot.toString(), "cloud-7", 4000L
        );
        JSONObject cursor = new JSONObject()
            .put("nativeCompletedTurnId", JSONObject.NULL)
            .put("nativeCompletedGroupId", JSONObject.NULL)
            .put("nativeCompletedSequence", 0L)
            .put("uiAppliedTurnId", JSONObject.NULL)
            .put("uiAppliedGroupId", JSONObject.NULL)
            .put("uiAppliedSequence", 0L)
            .put("localSequence", 1L)
            .put("clearedThroughSequence", 0L)
            .put("clearEpoch", 0L)
            .put("clearedAt", 0L)
            .put("chatOpen", false)
            .put("quotedMessageId", JSONObject.NULL);
        String lane = BridgeInput.laneKey(submission);

        JSONObject envelope = BridgeInput.prepareV3Envelope(
            submission, "device1", "turn_local_moment_reply", lane,
            BridgeInput.rootSourceId(submission), "lineage_moment_7", 1L, null, cursor
        );

        assertEquals("moment_interaction:moment_authoritative_7", lane);
        assertEquals(
            "moment_authoritative_7",
            envelope.getJSONObject("trigger").getJSONObject("context").getString("momentId")
        );
        assertEquals(false, envelope.getJSONObject("trigger").getJSONObject("context")
            .getJSONObject("snapshot").has("_alBridgeProtocol"));
        assertEquals(1, envelope.getJSONObject("context").length());
        assertEquals(1L, envelope.getJSONObject("context")
            .getJSONObject("visibilityCursor").getLong("localSequence"));
    }

    @Test
    public void everyAutomaticKindUsesHistoricalWirePrefixAndStripsOnlyTheLocalMarker() throws Exception {
        TurnKind[] kinds = new TurnKind[]{
            TurnKind.ROLE_PLAN_CHAT,
            TurnKind.ROLE_PLAN_MOMENT,
            TurnKind.ROLE_PLAN_CHAT_PRIVATE,
            TurnKind.ROLE_PLAN_MOMENT_PRIVATE,
            TurnKind.PROACTIVE_CHAT,
            TurnKind.PROACTIVE_MOMENT,
            TurnKind.MOMENT_INTERACTION,
            TurnKind.MOMENT_REPLY
        };
        for (TurnKind kind : kinds) {
            String suffix = kind.name().toLowerCase(java.util.Locale.ROOT);
            JSONObject input = new JSONObject()
                .put("scheduledFor", 5000L)
                .put("momentId", "moment_" + suffix);
            JSONObject snapshot = new JSONObject()
                .put("semantic", "kept_" + suffix)
                .put("momentId", "moment_" + suffix)
                .put("_alBridgeProtocol", new JSONObject()
                    .put("version", 3)
                    .put("owner", "room-v12"));
            TurnSubmission submission = new TurnSubmission(
                "cloud_" + suffix, "yuqi", "source_" + suffix, kind,
                input.toString(), snapshot.toString(), "job_" + suffix, 5000L
            );
            JSONObject cursor = emptyCursor(1L);
            String remoteTurnId = BridgeInput.wireTurnId(submission.turnId, kind);
            JSONObject envelope = BridgeInput.prepareV3Envelope(
                submission, "device1", remoteTurnId, BridgeInput.laneKey(submission),
                BridgeInput.rootSourceId(submission), "lineage_" + suffix, 1L, null, cursor
            );

            assertEquals("turn_cloud_" + suffix, remoteTurnId);
            assertEquals("trigger_source_" + suffix,
                envelope.getJSONObject("authority").getString("rootSourceId"));
            JSONObject embedded = envelope.getJSONObject("trigger").getJSONObject("context")
                .getJSONObject("snapshot");
            assertEquals("kept_" + suffix, embedded.getString("semantic"));
            assertEquals(false, embedded.has("_alBridgeProtocol"));
        }
    }

    private static JSONObject batchMessage(String messageId, String content, long sentAt) throws Exception {
        return new JSONObject()
            .put("messageId", messageId)
            .put("speakerId", "user")
            .put("speakerType", "user")
            .put("recipientId", "yuqi")
            .put("content", content)
            .put("sentAt", sentAt);
    }

    private static JSONObject openOutcome() throws Exception {
        return new JSONObject()
            .put("type", "open")
            .put("route", JSONObject.NULL)
            .put("relayMessageId", JSONObject.NULL)
            .put("failure", JSONObject.NULL)
            .put("result", JSONObject.NULL)
            .put("redactedAt", JSONObject.NULL);
    }

    private static JSONObject emptyCursor(long localSequence) throws Exception {
        return new JSONObject()
            .put("nativeCompletedTurnId", JSONObject.NULL)
            .put("nativeCompletedGroupId", JSONObject.NULL)
            .put("nativeCompletedSequence", 0L)
            .put("uiAppliedTurnId", JSONObject.NULL)
            .put("uiAppliedGroupId", JSONObject.NULL)
            .put("uiAppliedSequence", 0L)
            .put("localSequence", localSequence)
            .put("clearedThroughSequence", 0L)
            .put("clearEpoch", 0L)
            .put("clearedAt", 0L)
            .put("chatOpen", false)
            .put("quotedMessageId", JSONObject.NULL);
    }
}
