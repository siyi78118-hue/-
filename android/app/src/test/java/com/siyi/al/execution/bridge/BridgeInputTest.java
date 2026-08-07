package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

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
        JSONObject targetMoment = validationMoment();
        JSONObject targetComment = targetMoment.getJSONArray("comments").getJSONObject(0);
        JSONObject input = new JSONObject()
            .put("targetMoment", targetMoment)
            .put("targetComment", targetComment)
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

        assertEquals("moment_interaction:moment_validation", lane);
        assertEquals(
            "moment_validation",
            envelope.getJSONObject("trigger").getJSONObject("context")
                .getJSONObject("targetMoment").getString("momentId")
        );
        assertEquals("comment_validation", envelope.getJSONObject("trigger")
            .getJSONObject("context").getJSONObject("targetComment").getString("commentId"));
        assertEquals(2, envelope.getJSONObject("trigger").getJSONObject("context").length());
        assertEquals(1, envelope.getJSONObject("context").length());
        assertEquals(1L, envelope.getJSONObject("context")
            .getJSONObject("visibilityCursor").getLong("localSequence"));
    }

    @Test
    public void v3MomentReplyProjectsOnlyCanonicalTargetMomentAndComment() throws Exception {
        JSONObject targetMoment = new JSONObject()
            .put("momentId", "moment_authoritative_8")
            .put("authorType", "character")
            .put("authorId", "yuqi")
            .put("text", "公开动态")
            .put("createdAt", 3900L)
            .put("likes", new JSONArray().put("user"))
            .put("comments", new JSONArray().put(new JSONObject()
                .put("commentId", "comment_authoritative_8")
                .put("authorType", "user")
                .put("authorId", "user")
                .put("text", "我看到了")
                .put("createdAt", 3950L)
                .put("replyToCommentId", JSONObject.NULL)));
        JSONObject targetComment = targetMoment.getJSONArray("comments").getJSONObject(0);
        JSONObject input = new JSONObject()
            .put("targetMoment", targetMoment)
            .put("targetComment", targetComment)
            .put("momentId", "legacy_must_not_win")
            .put("playerComment", "legacy comment")
            .put("replyToCommentId", "legacy_comment_id")
            .put("scheduledFor", 4000L);
        JSONObject snapshot = new JSONObject()
            .put("scene", new JSONObject().put("kind", "moment_reply"))
            .put("moment", new JSONObject().put("momentId", "legacy_snapshot_moment"))
            .put("playerComment", "legacy snapshot comment")
            .put("replyToCommentId", "legacy_snapshot_comment_id")
            .put("_alBridgeProtocol", new JSONObject()
                .put("version", 3)
                .put("owner", "room-v12"));
        TurnSubmission submission = new TurnSubmission(
            "local_moment_reply_8", "yuqi", "moment-trigger-8", TurnKind.MOMENT_REPLY,
            input.toString(), snapshot.toString(), "cloud-8", 4000L
        );
        JSONObject envelope = BridgeInput.prepareV3Envelope(
            submission, "device1", "turn_local_moment_reply_8",
            "moment_interaction:moment_authoritative_8", "trigger_moment-trigger-8",
            "lineage_moment_8", 1L, null, emptyCursor(1L)
        );
        JSONObject context = envelope.getJSONObject("trigger").getJSONObject("context");

        assertEquals(2, context.length());
        assertEquals(BridgeAuthority.canonicalJson(targetMoment),
            BridgeAuthority.canonicalJson(context.getJSONObject("targetMoment")));
        assertEquals(BridgeAuthority.canonicalJson(targetComment),
            BridgeAuthority.canonicalJson(context.getJSONObject("targetComment")));
        assertFalse(context.has("input"));
        assertFalse(context.has("snapshot"));
        assertFalse(context.has("moment"));
        assertFalse(context.has("momentId"));
        assertFalse(context.has("playerComment"));
        assertFalse(context.has("replyToCommentId"));
    }

    @Test
    public void v3MomentTargetsRejectFractionNonFiniteAndOverSafeCreatedAt() throws Exception {
        JSONObject validMoment = validationMoment();
        JSONObject validComment = validMoment.getJSONArray("comments").getJSONObject(0);

        JSONObject fractionMoment = new JSONObject(validMoment.toString()).put("createdAt", 1000.5d);
        assertMomentRejected(fractionMoment, validComment);

        JSONObject overflowMoment = new JSONObject(validMoment.toString())
            .put("createdAt", 9007199254740992L);
        assertMomentRejected(overflowMoment, validComment);

        JSONObject fractionComment = new JSONObject(validComment.toString()).put("createdAt", 1100.5d);
        JSONObject fractionCommentMoment = new JSONObject(validMoment.toString())
            .put("comments", new JSONArray().put(fractionComment));
        assertMomentRejected(fractionCommentMoment, fractionComment);

        JSONObject overflowComment = new JSONObject(validComment.toString())
            .put("createdAt", 9007199254740992L);
        JSONObject overflowCommentMoment = new JSONObject(validMoment.toString())
            .put("comments", new JSONArray().put(overflowComment));
        assertMomentRejected(overflowCommentMoment, overflowComment);

        JSONObject validInput = new JSONObject()
            .put("targetMoment", validMoment)
            .put("targetComment", validComment)
            .put("scheduledFor", 4000L);
        String nonFiniteMoment = validInput.toString()
            .replaceFirst("\\\"createdAt\\\":1000", "\\\"createdAt\\\":NaN");
        assertMomentRawRejected(nonFiniteMoment);
        String nonFiniteComment = validInput.toString()
            .replaceFirst("\\\"createdAt\\\":1100", "\\\"createdAt\\\":Infinity");
        assertMomentRawRejected(nonFiniteComment);
    }

    @Test
    public void v3MomentTargetsRejectAliasAuthorIdentitiesAndPlayerLike() throws Exception {
        JSONObject validMoment = validationMoment();
        JSONObject validComment = validMoment.getJSONArray("comments").getJSONObject(0);
        JSONObject wrongUser = new JSONObject(validMoment.toString())
            .put("authorType", "user").put("authorId", "character_1");
        assertMomentRejected(wrongUser, validComment);
        JSONObject wrongCharacter = new JSONObject(validMoment.toString())
            .put("authorType", "character").put("authorId", "user");
        assertMomentRejected(wrongCharacter, validComment);
        JSONObject aliasLike = new JSONObject(validMoment.toString())
            .put("likes", new JSONArray().put("player"));
        assertMomentRejected(aliasLike, validComment);
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
            if (kind == TurnKind.MOMENT_INTERACTION || kind == TurnKind.MOMENT_REPLY) {
                JSONObject targetMoment = validationMoment();
                input.put("targetMoment", targetMoment);
                input.put("targetComment", kind == TurnKind.MOMENT_REPLY
                    ? targetMoment.getJSONArray("comments").getJSONObject(0)
                    : JSONObject.NULL);
            }
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
                ;
            if (kind == TurnKind.PROACTIVE_MOMENT) {
                assertEquals(0, embedded.length());
            } else if (kind == TurnKind.MOMENT_INTERACTION || kind == TurnKind.MOMENT_REPLY) {
                assertEquals("moment_validation", embedded.getJSONObject("targetMoment")
                    .getString("momentId"));
            } else {
                JSONObject snapshotProjection = embedded.getJSONObject("snapshot");
                assertEquals("kept_" + suffix, snapshotProjection.getString("semantic"));
                assertEquals(false, snapshotProjection.has("_alBridgeProtocol"));
            }
        }
    }

    @Test
    public void v3DirectEnvelopeNeverCarriesLocalFallbackExecutionOrModelInputs() throws Exception {
        JSONObject container = new JSONObject()
            .put("contract", "cognition-v3")
            .put("schemaVersion", 3)
            .put("roleId", "yuqi")
            .put("hardConstraints", new JSONArray())
            .put("preferences", new JSONArray())
            .put("currentStances", new JSONArray())
            .put("relationship", new JSONObject())
            .put("recentGroups", new JSONArray())
            .put("verifiedFacts", new JSONArray())
            .put("lifeSignals", new JSONArray())
            .put("authorSettings", new JSONObject())
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "device1")
                .put("cognition", new JSONObject()
                    .put("configId", "memory-v3")
                    .put("system", "secret cognition")
                    .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "secret"))))
                .put("expression", new JSONObject()
                    .put("configId", "chat-v3")
                    .put("system", "secret expression")
                    .put("messages", new JSONArray())));
        TurnSubmission submission = new TurnSubmission(
            "turn_local_v3", "yuqi", "msg_v3", TurnKind.DIRECT_REPLY,
            new JSONObject().put("userText", "你好").toString(), container.toString(), null, 1000L
        );
        JSONObject cursor = emptyCursor(1L);
        JSONObject envelope = BridgeInput.prepareV3Envelope(
            submission, "device1", "turn_remote_v3", "private_chat", "msg_v3", "lineage_v3", 1L, null, cursor
        );

        String serialized = envelope.toString();
        assertEquals(-1, serialized.indexOf("fallbackExecution"));
        assertEquals(-1, serialized.indexOf("memory-v3"));
        assertEquals(-1, serialized.indexOf("secret cognition"));
        assertEquals(-1, serialized.indexOf("secret expression"));
        assertEquals(-1, serialized.indexOf("cognition-v3"));
        assertFalse(envelope.getJSONObject("context").has("snapshot"));
    }

    @Test
    public void v3AutomaticTriggerSnapshotKeepsOnlySemanticView() throws Exception {
        JSONObject container = new JSONObject()
            .put("contract", "cognition-v3")
            .put("schemaVersion", 3)
            .put("roleId", "yuqi")
            .put("hardConstraints", new JSONArray())
            .put("preferences", new JSONArray())
            .put("currentStances", new JSONArray())
            .put("relationship", new JSONObject())
            .put("recentGroups", new JSONArray())
            .put("verifiedFacts", new JSONArray())
            .put("lifeSignals", new JSONArray())
            .put("authorSettings", new JSONObject())
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "device1")
                .put("cognition", new JSONObject()
                    .put("configId", "memory-v3")
                    .put("system", "secret cognition")
                    .put("messages", new JSONArray()))
                .put("expression", new JSONObject()
                    .put("configId", "chat-v3")
                    .put("system", "secret expression")
                    .put("messages", new JSONArray())));
        TurnSubmission submission = new TurnSubmission(
            "automatic_v3", "yuqi", "trigger_v3", TurnKind.PROACTIVE_CHAT,
            new JSONObject().put("scheduledFor", 1000L).toString(), container.toString(), "job_v3", 1000L
        );
        JSONObject envelope = BridgeInput.prepareV3Envelope(
            submission, "device1", "turn_automatic_v3", "private_chat", "trigger_v3", "lineage_v3", 1L, null, emptyCursor(1L)
        );
        JSONObject snapshot = envelope.getJSONObject("trigger").getJSONObject("context").getJSONObject("snapshot");
        assertEquals("cognition-v3", snapshot.getString("contract"));
        assertEquals(false, snapshot.has("fallbackExecution"));
        assertEquals(false, snapshot.has("deviceId"));
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

    private static JSONObject validationMoment() throws Exception {
        return new JSONObject()
            .put("momentId", "moment_validation")
            .put("authorType", "character")
            .put("authorId", "yuqi")
            .put("text", "公开动态")
            .put("createdAt", 1000L)
            .put("likes", new JSONArray().put("user"))
            .put("comments", new JSONArray().put(new JSONObject()
                .put("commentId", "comment_validation")
                .put("authorType", "user")
                .put("authorId", "user")
                .put("text", "我看到了")
                .put("createdAt", 1100L)
                .put("replyToCommentId", JSONObject.NULL)));
    }

    private static void assertMomentRejected(JSONObject moment, JSONObject comment) throws Exception {
        JSONObject input = new JSONObject()
            .put("targetMoment", moment)
            .put("targetComment", comment)
            .put("scheduledFor", 4000L);
        assertMomentRawRejected(input.toString());
    }

    private static void assertMomentRawRejected(String inputJson) throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "local_validation", "yuqi", "moment-validation", TurnKind.MOMENT_REPLY,
            inputJson, "{}", "cloud-validation", 4000L
        );
        assertThrows(Exception.class, () -> BridgeInput.prepareV3Envelope(
            submission, "device1", "turn_validation", "moment_interaction:moment_validation",
            "trigger_moment-validation", "lineage_validation", 1L, null, emptyCursor(1L)
        ));
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
