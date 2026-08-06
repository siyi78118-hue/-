package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeReceiptCheckpointTest {
    @Test public void onlyLegacyProtocolsMayReadMemoryResultBridgeFields() {
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(null));
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(1));
        assertEquals(true, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(2));
        assertEquals(false, BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(3));
    }

    @Test public void extractsCurrentObjectShapedBridgeResponse() throws Exception {
        String checkpoint = "{\"bridgeResponse\":{\"_relayMessageId\":\"relay_1\",\"reply\":{}}}";

        assertEquals("relay_1", BridgeReceiptCheckpoint.extract(checkpoint).getString("_relayMessageId"));
    }

    @Test public void extractsLegacyStringShapedBridgeResponse() throws Exception {
        String checkpoint = "{\"bridgeResponse\":\"{\\\"_relayMessageId\\\":\\\"relay_old\\\",\\\"reply\\\":{}}\"}";

        assertEquals("relay_old", BridgeReceiptCheckpoint.extract(checkpoint).getString("_relayMessageId"));
    }

    @Test public void ignoresLegacyMemoryTextThatWasNeverABridgeCheckpoint() {
        assertNull(BridgeReceiptCheckpoint.extract("[events | 2026-07-17 19:02] old summary"));
    }

    @Test public void ignoresCheckpointWithoutRelayIdentity() {
        assertNull(BridgeReceiptCheckpoint.extract("{\"bridgeResponse\":{\"reply\":{}}}"));
    }

    @Test public void acceptsCompleteV3SkipWithoutItemsOrRelayIdentity() throws Exception {
        String response = "{"
            + "\"protocolVersion\":3,\"turnId\":\"turn_skip\",\"roleId\":\"yuqi\","
            + "\"authorityOrigin\":\"pc\",\"authorityLineageKey\":\"lin_skip\","
            + "\"visibleGroupId\":\"" + AuthorityIdentity.groupId("lin_skip") + "\",\"lineageRevision\":2,\"turnRevision\":4,"
            + "\"laneKey\":\"private_chat\",\"laneRevision\":8,"
            + "\"inputVisibilitySequence\":12,\"inputClearEpoch\":3,"
            + "\"generationFingerprint\":null,\"releaseId\":\"release_v3\","
            + "\"commitPayloadVersion\":\"pc-visible-commit-v2\","
            + "\"commitChecksum\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
            + "\"terminalDisposition\":\"skip\",\"replyParts\":[],\"actions\":[],"
            + "\"ok\":true,\"terminal\":true,\"recoveryAckSeq\":9}";
        String checkpoint = new org.json.JSONObject()
            .put("origin", "lan")
            .put("bridgeResponse", new org.json.JSONObject(response))
            .toString();

        org.json.JSONObject extracted = BridgeReceiptCheckpoint.extract(checkpoint);

        assertNotNull(extracted);
        assertEquals("skip", extracted.getString("terminalDisposition"));
        assertEquals("lan", extracted.getString("_deliveryRoute"));
        assertFalse(extracted.has("_relayMessageId"));
        assertFalse(extracted.has("ok"));
        assertFalse(extracted.has("terminal"));
        assertFalse(extracted.has("recoveryAckSeq"));
    }

    @Test public void rejectsPartialV3ReceiptEvenWhenRelayIdentityExists() throws Exception {
        org.json.JSONObject partial = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_partial")
            .put("terminalDisposition", "skip")
            .put("replyParts", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray())
            .put("_relayMessageId", "relay_partial");
        String checkpoint = new org.json.JSONObject()
            .put("origin", "cloud")
            .put("bridgeResponse", partial)
            .toString();

        assertNull(BridgeReceiptCheckpoint.extract(checkpoint));
    }

    @Test public void wishedForExtractAuthorityReceiptFromV12CheckpointUsesTerminalOutcome() throws Exception {
        String lineage = "lineage_v12";
        org.json.JSONObject result = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_v12_remote")
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineage)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineage))
            .put("lineageRevision", 2L)
            .put("turnRevision", 4L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("generationFingerprint", org.json.JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", "skip")
            .put("replyParts", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray());
        org.json.JSONObject envelope = new org.json.JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", "turn_v12_remote")
            .put("characterId", "yuqi")
            .put("deviceId", "device_123456")
            .put("deviceSeq", 12L)
            .put("createdAt", 1784400000000L);
        org.json.JSONObject checkpoint = new org.json.JSONObject()
            .put("version", 1L)
            .put("localTurnId", "local_v12")
            .put("attemptId", "attempt_v12")
            .put("attemptSequence", 1L)
            .put("authoritativeTurnId", "turn_v12_remote")
            .put("authorityLineageKey", lineage)
            .put("claimedLineageRevision", 2L)
            .put("retryOfTurnId", org.json.JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", new org.json.JSONObject()
                .put("type", "committed")
                .put("route", "cloud")
                .put("relayMessageId", "relay_v12")
                .put("failure", org.json.JSONObject.NULL)
                .put("result", result)
                .put("redactedAt", org.json.JSONObject.NULL));
        String checkpointJson = BridgeAuthority.canonicalJson(checkpoint);

        org.json.JSONObject receipt = BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
            checkpointJson, BridgeAuthority.sha256CanonicalJson(checkpoint));

        assertNotNull(receipt);
        assertEquals("turn_v12_remote", receipt.getString("turnId"));
        assertEquals("cloud", receipt.getString("_deliveryRoute"));
        assertEquals("relay_v12", receipt.getString("_relayMessageId"));
        assertEquals("skip", receipt.getString("terminalDisposition"));
    }

    @Test public void acceptsTheSharedClosedLocalFallbackReceipt() throws Exception {
        JSONObject checkpoint = validLocalCheckpoint();

        JSONObject receipt = BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
            checkpoint.toString(), BridgeAuthority.sha256CanonicalJson(checkpoint));

        assertNotNull(receipt);
        assertEquals(2L, receipt.getLong("receiptVersion"));
        assertEquals(JSONObject.NULL, receipt.getJSONObject("semantic").get("retryOfTurnId"));
    }

    @Test public void acceptsRoomStyleAutomaticReceiptForEveryTerminalDisposition() throws Exception {
        for (String disposition : new String[] {"visible", "action_only", "skip"}) {
            JSONObject checkpoint = automaticCheckpointForDisposition(disposition);

            JSONObject receipt = extractLocal(checkpoint);

            assertNotNull(disposition, receipt);
            assertEquals(disposition, receipt.getJSONObject("semantic").getString("terminalDisposition"));
        }
    }

    @Test public void rejectsAutomaticReceiptWhenInputChecksumIsTampered() throws Exception {
        JSONObject checkpoint = automaticCheckpointForDisposition("visible");
        JSONObject input = checkpoint.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").getJSONObject("input");
        input.put("checksum", repeat('f', 64));
        resealLocalReceipt(checkpoint);

        assertNull(extractLocal(checkpoint));
    }

    @Test public void rejectsUnknownAndMissingFieldsInsideARehashedLocalReceipt() throws Exception {
        JSONObject extraSemantic = validLocalCheckpoint();
        extraSemantic.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").put("secret", "must-not-pass");
        resealLocalReceipt(extraSemantic);
        assertNull(extractLocal(extraSemantic));

        JSONObject missingRetry = validLocalCheckpoint();
        missingRetry.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").remove("retryOfTurnId");
        resealLocalReceipt(missingRetry);
        assertNull(extractLocal(missingRetry));

        JSONObject extraManifest = validLocalCheckpoint();
        extraManifest.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("manifest").put("secret", "must-not-pass");
        assertNull(extractLocal(extraManifest));

        JSONObject nestedMessageSecret = validLocalCheckpoint();
        JSONObject semantic = nestedMessageSecret.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic");
        JSONObject replyItem = semantic.getJSONArray("replyItems").getJSONObject(0);
        replyItem.getJSONObject("message").put("secret", "must-not-pass");
        replyItem.put("checksum", BridgeAuthority.sha256CanonicalJson(replyItem.getJSONObject("message")));
        semantic.getJSONArray("visibleItems").put(0, new JSONObject(replyItem.getJSONObject("message").toString()));
        resealLocalReceipt(nestedMessageSecret);
        assertNull(extractLocal(nestedMessageSecret));
    }

    @Test public void rejectsARehashedVisibleProjectionThatDisagreesWithTheReplyItem() throws Exception {
        JSONObject checkpoint = validLocalCheckpoint();
        checkpoint.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").getJSONArray("visibleItems")
            .getJSONObject(0).put("content", "forged visible text");
        resealLocalReceipt(checkpoint);

        assertNull(extractLocal(checkpoint));
    }

    @Test public void acceptsOneClosedDirectImageAndRejectsAForeignUserProjection() throws Exception {
        JSONObject checkpoint = directImageCheckpoint();

        assertNotNull(extractLocal(checkpoint));

        JSONObject forgedSpeaker = new JSONObject(checkpoint.toString());
        JSONObject inputMessage = forgedSpeaker.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").getJSONObject("input").getJSONObject("batch")
            .getJSONArray("items").getJSONObject(0).getJSONObject("message");
        inputMessage.put("speakerId", "foreign");
        JSONObject item = forgedSpeaker.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic").getJSONObject("input").getJSONObject("batch")
            .getJSONArray("items").getJSONObject(0);
        item.put("checksum", BridgeAuthority.sha256CanonicalJson(inputMessage));
        resealLocalReceipt(forgedSpeaker);
        assertNull(extractLocal(forgedSpeaker));
    }

    @Test public void rejectsSignedSecretsInsideStructuredActionPayloads() throws Exception {
        JSONObject moment = localActionCheckpoint(
            "moment_like",
            "moment:moment_1",
            "sha256:" + repeat('a', 64),
            new JSONObject()
                .put("momentId", "moment_1")
                .put("like", true)
                .put("comment", "")
                .put("replyToCommentId", JSONObject.NULL)
                .put("secret", "must-not-pass"));
        assertNull(extractLocal(moment));

        JSONObject relationship = localActionCheckpoint(
            "relationship_transition",
            "relationship:yuqi",
            "sha256:" + repeat('b', 64),
            new JSONObject()
                .put("baseAction", JSONObject.NULL)
                .put("phaseAction", new JSONObject()
                    .put("from", "friend")
                    .put("to", "close")
                    .put("label", "closer")
                    .put("reason", "shared evidence")
                    .put("confidence", 0.8)
                    .put("evidenceMessageIds", new org.json.JSONArray().put("msg_1"))
                    .put("explicitAcknowledgedChange", true)
                    .put("changedAt", 1001L))
                .put("expectedSceneRevision", 1L)
                .put("label", "close")
                .put("changedAt", 1001L)
                .put("secret", "must-not-pass"));
        assertNull(extractLocal(relationship));

        JSONObject plan = localActionCheckpoint(
            "role_plan_update",
            "role_plan:plan_1",
            "sha256:" + repeat('c', 64),
            new JSONObject()
                .put("op", "update")
                .put("planId", "plan_1")
                .put("patch", new JSONObject().put("title", "明天早安"))
                .put("secret", "must-not-pass"));
        assertNull(extractLocal(plan));
    }

    @Test public void rejectsRehashedActionsThatTargetAForeignRoleOrLineage() throws Exception {
        JSONObject foreignRole = localActionCheckpoint(
            "relationship_transition",
            "relationship:foreign",
            "sha256:" + repeat('e', 64),
            relationshipPayload());
        assertNull(extractLocal(foreignRole));

        JSONObject foreignLineage = localActionCheckpoint(
            "role_plan_create",
            "lineage_create:lin_foreign:role_plan_create",
            "1",
            new JSONObject()
                .put("op", "create")
                .put("type", "private_message")
                .put("source", "spoken")
                .put("title", "早安")
                .put("intent", "明早问候")
                .put("schedule", new JSONObject()
                    .put("kind", "once")
                    .put("at", "2026-08-07T09:00:00+08:00"))
                .put("timeConfidence", "explicit"));
        assertNull(extractLocal(foreignLineage));
    }

    @Test public void rejectsARehashedActionWhoseRevisionDoesNotMatchThePinnedTarget() throws Exception {
        JSONObject checkpoint = automaticCheckpointForDisposition("action_only");
        JSONObject receipt = checkpoint.getJSONObject("outcome").getJSONObject("result");
        JSONObject action = receipt.getJSONObject("semantic").getJSONArray("actions").getJSONObject(0);
        action.put("targetRevision", "sha256:" + repeat('e', 64));
        JSONObject basis = new JSONObject()
            .put("kind", action.getString("kind"))
            .put("targetKey", action.getString("targetKey"))
            .put("targetRevision", action.getString("targetRevision"))
            .put("payload", action.getJSONObject("payload"));
        action.put("checksum", BridgeAuthority.sha256CanonicalJson(basis));
        resealReceipt(receipt);

        assertNull(extractLocal(checkpoint));
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }

    private static JSONObject extractLocal(JSONObject checkpoint) throws Exception {
        return BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
            checkpoint.toString(), BridgeAuthority.sha256CanonicalJson(checkpoint));
    }

    private static JSONObject validLocalCheckpoint() throws Exception {
        JSONObject receipt = readFixture("android-fallback-authority-v2.json");
        JSONObject semantic = receipt.getJSONObject("semantic");
        if (!semantic.has("retryOfTurnId")) semantic.put("retryOfTurnId", JSONObject.NULL);
        resealReceipt(receipt);
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 3L)
            .put("turnId", semantic.getString("authoritativeTurnId"))
            .put("characterId", semantic.getString("roleId"))
            .put("deviceId", semantic.getString("deviceId"));
        return new JSONObject()
            .put("version", 2L)
            .put("localTurnId", semantic.getString("authoritativeTurnId"))
            .put("attemptId", "attempt_local_fallback")
            .put("attemptSequence", 1L)
            .put("authoritativeTurnId", semantic.getString("authoritativeTurnId"))
            .put("authorityLineageKey", semantic.getString("authorityLineageKey"))
            .put("claimedLineageRevision", semantic.getLong("lineageRevisionAtCreation"))
            .put("retryOfTurnId", semantic.get("retryOfTurnId"))
            .put("laneKey", semantic.getString("laneKey"))
            .put("inputVisibilitySequence", semantic.getJSONObject("input").getLong("visibilitySequence"))
            .put("inputClearEpoch", semantic.getJSONObject("input").getLong("clearEpoch"))
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", new JSONObject()
                .put("type", "committed")
                .put("route", "local")
                .put("relayMessageId", JSONObject.NULL)
                .put("failure", JSONObject.NULL)
                .put("result", receipt)
                .put("redactedAt", JSONObject.NULL))
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", semantic.getString("deviceId"))
                .put("cognition", new JSONObject().put("configId", "cog").put("system", "").put("messages", "[]"))
                .put("expression", new JSONObject().put("configId", "expr").put("system", "").put("messages", "[]")))
            .put("journalSyncSeq", semantic.getLong("journalSyncSeq"));
    }

    private static JSONObject directImageCheckpoint() throws Exception {
        JSONObject checkpoint = validLocalCheckpoint();
        JSONObject receipt = checkpoint.getJSONObject("outcome").getJSONObject("result");
        JSONObject semantic = receipt.getJSONObject("semantic");
        String roleId = semantic.getString("roleId");
        String messageId = "msg_direct_image_001";
        String lineageKey = AuthorityIdentity.lineageKey(roleId, semantic.getString("laneKey"), messageId);
        String groupId = AuthorityIdentity.groupId(lineageKey);
        String base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Zb8AAAAASUVORK5CYII=";
        JSONObject attachment = new JSONObject()
            .put("attachmentId", "att_direct_image_001")
            .put("messageId", messageId)
            .put("kind", "image")
            .put("mime", "image/png")
            .put("name", "image.png")
            .put("width", 1L)
            .put("height", 1L)
            .put("bytes", Base64.getDecoder().decode(base64).length)
            .put("dataUrl", "data:image/png;base64," + base64);
        JSONObject message = new JSONObject()
            .put("messageId", messageId)
            .put("speakerId", "user")
            .put("speakerType", "user")
            .put("recipientId", roleId)
            .put("content", "看图")
            .put("sentAt", 1000L)
            .put("attachments", new org.json.JSONArray().put(attachment));
        JSONObject item = new JSONObject()
            .put("sequence", 0L)
            .put("messageId", messageId)
            .put("message", message)
            .put("checksum", BridgeAuthority.sha256CanonicalJson(message));
        JSONObject batchHeader = new JSONObject()
            .put("batchId", "batch_direct_image_001")
            .put("sourceMessageId", messageId)
            .put("messageIds", new org.json.JSONArray().put(messageId))
            .put("startedAt", 1000L)
            .put("committedAt", 1000L);
        String batchChecksum = BridgeAuthority.sha256CanonicalJson(batchHeader);
        JSONObject batch = new JSONObject()
            .put("batchId", "batch_direct_image_001")
            .put("characterId", roleId)
            .put("sourceMessageId", messageId)
            .put("startedAt", 1000L)
            .put("committedAt", 1000L)
            .put("checksum", batchChecksum)
            .put("items", new org.json.JSONArray().put(item));
        semantic
            .put("rootSourceId", messageId)
            .put("authorityLineageKey", lineageKey)
            .put("turnKind", "DIRECT_REPLY")
            .put("visibleGroupId", groupId)
            .put("input", new JSONObject()
                .put("kind", "direct")
                .put("batch", batch)
                .put("visibilitySequence", 7L)
                .put("clearEpoch", 0L)
                .put("checksum", batchChecksum));
        JSONObject replyMessage = semantic.getJSONArray("replyItems").getJSONObject(0)
            .getJSONObject("message");
        String replyMessageId = AuthorityIdentity.messageId(groupId, 0L);
        replyMessage.put("messageId", replyMessageId);
        semantic.getJSONArray("replyItems").getJSONObject(0)
            .put("messageId", replyMessageId)
            .put("checksum", BridgeAuthority.sha256CanonicalJson(replyMessage));
        semantic.getJSONArray("visibleItems").put(0, new JSONObject(replyMessage.toString()));
        checkpoint.put("authorityLineageKey", lineageKey)
            .put("inputVisibilitySequence", 7L)
            .put("inputClearEpoch", 0L);
        resealReceipt(receipt);
        return checkpoint;
    }

    private static JSONObject automaticCheckpointForDisposition(String disposition) throws Exception {
        JSONObject checkpoint = validLocalCheckpoint();
        JSONObject semantic = checkpoint.getJSONObject("outcome").getJSONObject("result")
            .getJSONObject("semantic");
        JSONObject targetMoment = new JSONObject()
            .put("momentId", "moment_local_1")
            .put("authorId", "yuqi")
            .put("content", "今天的风很轻")
            .put("createdAt", 1000L);
        JSONObject triggerContext = new JSONObject()
            .put("input", new JSONObject().put("targetMoment", targetMoment));
        semantic.getJSONObject("input").getJSONObject("trigger")
            .put("context", new JSONObject(triggerContext.toString()));
        JSONObject inputBasis = new JSONObject(semantic.getJSONObject("input").toString());
        inputBasis.remove("checksum");
        semantic.getJSONObject("input").put(
            "checksum", BridgeAuthority.sha256CanonicalJson(inputBasis));
        JSONObject normalizedEnvelope = checkpoint.getJSONObject("normalizedEnvelope");
        normalizedEnvelope.put("trigger", new JSONObject()
            .put("context", new JSONObject(triggerContext.toString())));
        checkpoint.put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(normalizedEnvelope));
        semantic.put("terminalDisposition", disposition);
        if ("action_only".equals(disposition)) {
            semantic.put("replyItems", new JSONArray());
            semantic.put("visibleItems", new JSONArray());
            String groupId = semantic.getString("visibleGroupId");
            JSONObject payload = new JSONObject()
                .put("momentId", "moment_local_1")
                .put("like", true)
                .put("comment", "")
                .put("replyToCommentId", JSONObject.NULL);
            String kind = "moment_like";
            String targetKey = "moment:moment_local_1";
            String targetRevision = "sha256:" + BridgeAuthority.sha256CanonicalJson(targetMoment);
            JSONObject action = new JSONObject()
                .put("actionId", AuthorityIdentity.actionId(groupId, 0L))
                .put("ordinal", 0L)
                .put("kind", kind)
                .put("targetKey", targetKey)
                .put("targetRevision", targetRevision)
                .put("payload", payload)
                .put("checksum", BridgeAuthority.sha256CanonicalJson(new JSONObject()
                    .put("kind", kind)
                    .put("targetKey", targetKey)
                    .put("targetRevision", targetRevision)
                    .put("payload", payload)));
            semantic.put("actions", new JSONArray().put(action));
        } else if ("skip".equals(disposition)) {
            semantic.put("replyItems", new JSONArray());
            semantic.put("visibleItems", new JSONArray());
            semantic.put("actions", new JSONArray());
        }
        resealLocalReceipt(checkpoint);
        return checkpoint;
    }

    private static JSONObject localActionCheckpoint(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload
    ) throws Exception {
        JSONObject checkpoint = validLocalCheckpoint();
        JSONObject receipt = checkpoint.getJSONObject("outcome").getJSONObject("result");
        JSONObject semantic = receipt.getJSONObject("semantic");
        String groupId = semantic.getString("visibleGroupId");
        JSONObject basis = new JSONObject()
            .put("kind", kind)
            .put("targetKey", targetKey)
            .put("targetRevision", targetRevision)
            .put("payload", new JSONObject(payload.toString()));
        JSONObject action = new JSONObject()
            .put("actionId", AuthorityIdentity.actionId(groupId, 0L))
            .put("ordinal", 0L)
            .put("kind", kind)
            .put("targetKey", targetKey)
            .put("targetRevision", targetRevision)
            .put("payload", new JSONObject(payload.toString()))
            .put("checksum", BridgeAuthority.sha256CanonicalJson(basis));
        semantic.put("terminalDisposition", "action_only")
            .put("replyItems", new org.json.JSONArray())
            .put("visibleItems", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray().put(action));
        resealReceipt(receipt);
        return checkpoint;
    }

    private static JSONObject relationshipPayload() throws Exception {
        return new JSONObject()
            .put("baseAction", JSONObject.NULL)
            .put("phaseAction", new JSONObject()
                .put("from", "friend")
                .put("to", "close")
                .put("label", "closer")
                .put("reason", "shared evidence")
                .put("confidence", 0.8)
                .put("evidenceMessageIds", new org.json.JSONArray().put("msg_1"))
                .put("explicitAcknowledgedChange", true)
                .put("changedAt", 1001L))
            .put("expectedSceneRevision", 1L)
            .put("label", "close")
            .put("changedAt", 1001L);
    }

    private static void resealLocalReceipt(JSONObject checkpoint) throws Exception {
        resealReceipt(checkpoint.getJSONObject("outcome").getJSONObject("result"));
    }

    private static void resealReceipt(JSONObject receipt) throws Exception {
        JSONObject semantic = receipt.getJSONObject("semantic");
        String checksum = BridgeAuthority.sha256CanonicalJson(semantic);
        receipt.put("commitChecksum", checksum);
        receipt.getJSONObject("manifest")
            .put("semantic", new JSONObject(semantic.toString()))
            .put("commitChecksum", checksum);
    }

    private static JSONObject readFixture(String name) throws Exception {
        File root = new File(System.getProperty("user.dir", "."));
        File fixture = new File(root, "tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../../tests/fixtures/" + name);
        if (!fixture.isFile()) throw new IllegalStateException("fixture is missing: " + name);
        return new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
    }
}
