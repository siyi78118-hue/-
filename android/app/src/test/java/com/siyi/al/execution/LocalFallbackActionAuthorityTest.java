package com.siyi.al.execution;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class LocalFallbackActionAuthorityTest {
    private static final String SHA_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test public void acceptsClosedPaymentMomentRelationshipAndPlanPayloads() throws Exception {
        LocalFallbackActionAuthority.validate(
            "payment_accept", "payment:pay_1", SHA_A,
            new JSONObject().put("messageId", "pay_1"));
        LocalFallbackActionAuthority.validate(
            "moment_like", "moment:moment_1", SHA_A,
            new JSONObject()
                .put("momentId", "moment_1")
                .put("like", true)
                .put("comment", "")
                .put("replyToCommentId", JSONObject.NULL));
        LocalFallbackActionAuthority.validate(
            "relationship_transition", "relationship:yuqi", SHA_A,
            relationshipPayload());
        LocalFallbackActionAuthority.validate(
            "role_plan_create", "lineage_create:lin_1:role_plan_create", "1",
            new JSONObject()
                .put("op", "create")
                .put("type", "private_message")
                .put("source", "spoken")
                .put("title", "早安")
                .put("intent", "明早问候")
                .put("schedule", new JSONObject().put("kind", "once").put("at", "2026-08-07T09:00:00+08:00"))
                .put("timeConfidence", "explicit"));
        LocalFallbackActionAuthority.validate(
            "role_plan_update", "role_plan:plan_1", SHA_A,
            new JSONObject()
                .put("op", "update")
                .put("planId", "plan_1")
                .put("patch", new JSONObject()
                    .put("title", "新标题")
                    .put("schedule", new JSONObject()
                        .put("kind", "weekly")
                        .put("weekdays", new JSONArray().put(1).put(5))
                        .put("time", "09:00"))));
        LocalFallbackActionAuthority.validate(
            "role_plan_pause", "role_plan:plan_1", SHA_A,
            new JSONObject().put("op", "pause").put("planId", "plan_1").put("reason", "临时有事"));
    }

    @Test public void rejectsUnknownNestedFieldsAndWrongKindTargets() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "moment_like", "moment:moment_1", SHA_A,
            new JSONObject()
                .put("momentId", "moment_1")
                .put("like", true)
                .put("comment", "")
                .put("replyToCommentId", JSONObject.NULL)
                .put("secret", "leak")));
        JSONObject relationship = relationshipPayload().put("secret", "leak");
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "relationship_transition", "relationship:yuqi", SHA_A, relationship));
        JSONObject nestedRelationship = relationshipPayload();
        nestedRelationship.getJSONObject("phaseAction").put("secret", "leak");
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "relationship_transition", "relationship:yuqi", SHA_A, nestedRelationship));
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "role_plan_update", "role_plan:plan_1", SHA_A,
            new JSONObject()
                .put("op", "update")
                .put("planId", "plan_1")
                .put("patch", new JSONObject().put("title", "新标题").put("secret", "leak"))));
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "role_plan_pause", "role_plan:plan_2", SHA_A,
            new JSONObject().put("op", "pause").put("planId", "plan_1")));
        assertThrows(IllegalArgumentException.class, () -> LocalFallbackActionAuthority.validate(
            "payment_accept", "payment:pay_2", SHA_A,
            new JSONObject().put("messageId", "pay_1")));
    }

    @Test public void bindsEveryMutableActionToThePinnedInputRevision() throws Exception {
        JSONObject payment = new JSONObject()
            .put("messageId", "pay_1").put("amount", 8L).put("status", "pending");
        JSONObject paymentEnvelope = new JSONObject()
            .put("context", new JSONObject().put("payment", payment));
        LocalFallbackActionAuthority.validateAgainstPinnedInput(
            "payment_accept", "payment:pay_1",
            "sha256:" + BridgeAuthority.sha256CanonicalJson(payment),
            new JSONObject().put("messageId", "pay_1"), "yuqi", "lin_1", 1L, paymentEnvelope);

        JSONObject targetMoment = new JSONObject()
            .put("momentId", "moment_1").put("content", "风很轻").put("createdAt", 1000L);
        JSONObject momentEnvelope = new JSONObject().put("trigger", new JSONObject()
            .put("context", new JSONObject().put("input", new JSONObject()
                .put("targetMoment", targetMoment))));
        LocalFallbackActionAuthority.validateAgainstPinnedInput(
            "moment_like", "moment:moment_1",
            "sha256:" + BridgeAuthority.sha256CanonicalJson(targetMoment),
            new JSONObject().put("momentId", "moment_1").put("like", true)
                .put("comment", "").put("replyToCommentId", JSONObject.NULL),
            "yuqi", "lin_1", 1L, momentEnvelope);

        JSONObject scene = new JSONObject()
            .put("stagePersonaRevision", 1L)
            .put("relationshipStage", new JSONObject().put("base", "close").put("phase", "normal"));
        JSONObject relationshipEnvelope = new JSONObject()
            .put("context", new JSONObject().put("scene", scene));
        JSONObject relationshipTarget = new JSONObject()
            .put("relationshipStage", scene.getJSONObject("relationshipStage"))
            .put("stagePersonaRevision", 1L);
        LocalFallbackActionAuthority.validateAgainstPinnedInput(
            "relationship_transition", "relationship:yuqi",
            "sha256:" + BridgeAuthority.sha256CanonicalJson(relationshipTarget),
            relationshipPayload(), "yuqi", "lin_1", 1L, relationshipEnvelope);

        JSONObject rolePlan = new JSONObject().put("planId", "plan_1").put("title", "旧标题");
        JSONObject planEnvelope = new JSONObject().put("context", new JSONObject()
            .put("input", new JSONObject().put("rolePlan", rolePlan)));
        JSONObject update = new JSONObject().put("op", "update").put("planId", "plan_1")
            .put("patch", new JSONObject().put("title", "新标题"));
        String rolePlanRevision = "sha256:" + BridgeAuthority.sha256CanonicalJson(rolePlan);
        LocalFallbackActionAuthority.validateAgainstPinnedInput(
            "role_plan_update", "role_plan:plan_1", rolePlanRevision,
            update, "yuqi", "lin_1", 1L, planEnvelope);

        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.validateAgainstPinnedInput(
                "payment_accept", "payment:pay_1", SHA_A,
                new JSONObject().put("messageId", "pay_1"),
                "yuqi", "lin_1", 1L, paymentEnvelope));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.validateAgainstPinnedInput(
                "moment_like", "moment:moment_1", SHA_A,
                new JSONObject().put("momentId", "moment_1").put("like", true)
                    .put("comment", "").put("replyToCommentId", JSONObject.NULL),
                "yuqi", "lin_1", 1L, momentEnvelope));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.validateAgainstPinnedInput(
                "relationship_transition", "relationship:yuqi", SHA_A,
                relationshipPayload(), "yuqi", "lin_1", 1L, relationshipEnvelope));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.validateAgainstPinnedInput(
                "role_plan_update", "role_plan:plan_1", SHA_A,
                update, "yuqi", "lin_1", 1L, planEnvelope));
    }

    @Test public void directReceiptCarriesOnlyThePinnedActionContextNeededByPc() throws Exception {
        JSONObject payment = new JSONObject()
            .put("kind", "redpacket")
            .put("amount", 8L)
            .put("note", "晚饭")
            .put("messageId", "pay_1")
            .put("status", "pending");
        JSONObject relationshipStage = new JSONObject()
            .put("base", "close").put("phase", "normal");
        JSONObject scene = new JSONObject()
            .put("relationshipStage", relationshipStage)
            .put("stagePersonaRevision", 3L)
            .put("privatePrompt", "must stay local");
        JSONObject message = new JSONObject()
            .put("messageId", "msg_1")
            .put("speakerId", "user")
            .put("speakerType", "user")
            .put("recipientId", "yuqi")
            .put("content", "给你")
            .put("sentAt", 100L);
        JSONObject envelope = new JSONObject().put("context", new JSONObject()
            .put("currentBatch", new JSONObject()
                .put("batchId", "batch_1")
                .put("messageIds", new JSONArray().put("msg_1"))
                .put("messages", new JSONArray().put(message))
                .put("startedAt", 100L)
                .put("committedAt", 101L))
            .put("payment", payment)
            .put("scene", scene)
            .put("retry", new JSONObject().put("retryOfTurnId", "turn_old"))
            .put("visibilityCursor", new JSONObject().put("localSequence", 7L)));
        JSONObject checkpoint = new JSONObject()
            .put("normalizedEnvelope", envelope)
            .put("inputVisibilitySequence", 7L)
            .put("inputClearEpoch", 2L);
        com.siyi.al.execution.db.ChatTurnEntity turn =
            new com.siyi.al.execution.db.ChatTurnEntity();
        turn.characterId = "yuqi";
        turn.sourceMessageId = "msg_1";
        turn.kind = TurnKind.DIRECT_REPLY.name();

        JSONArray actions = new JSONArray()
            .put(new JSONObject().put("ordinal", 0L).put("kind", "payment_accept"))
            .put(new JSONObject().put("ordinal", 1L).put("kind", "relationship_transition"));
        JSONObject input = RoomExecutionStore.localFallbackInput(turn, checkpoint, actions);
        JSONObject context = input.getJSONObject("pinnedActionContext");
        assertEquals(1L, context.getLong("version"));
        assertEquals(payment.toString(), context.getJSONObject("payment").toString());
        assertEquals(relationshipStage.toString(),
            scene.getJSONObject("relationshipStage").toString());
        assertEquals(5, context.length());
        JSONObject checksumBasis = new JSONObject(context.toString());
        String checksum = checksumBasis.getString("checksum");
        checksumBasis.remove("checksum");
        assertEquals(BridgeAuthority.sha256CanonicalJson(checksumBasis), checksum);
        assertFalse(context.getJSONObject("scene").has("privatePrompt"));
        assertFalse(context.has("currentBatch"));
        assertFalse(context.has("retry"));
        assertFalse(context.has("visibilityCursor"));
    }

    @Test public void directReceiptRejectsUnknownFieldsInsideEveryPinnedTarget() throws Exception {
        JSONObject currentBatch = new JSONObject().put("batchId", "batch_1");
        JSONObject paymentEnvelope = new JSONObject().put("context", new JSONObject()
            .put("currentBatch", currentBatch)
            .put("payment", new JSONObject()
                .put("kind", "redpacket").put("amount", 8L).put("note", "晚饭")
                .put("messageId", "pay_1").put("status", "pending")
                .put("secret", "must stay local")));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(paymentEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "payment_accept"))));

        JSONObject momentEnvelope = directTargetEnvelope("targetMoment", new JSONObject()
            .put("momentId", "moment_1").put("content", "风很轻").put("createdAt", 1000L)
            .put("secret", "must stay local"));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(momentEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "moment_like"))));

        JSONObject commentEnvelope = directTargetEnvelope("targetComment", new JSONObject()
            .put("commentId", "comment_1").put("momentId", "moment_1")
            .put("content", "收到").put("createdAt", 1001L)
            .put("secret", "must stay local"));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(commentEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "moment_reply"))));

        JSONObject planEnvelope = directTargetEnvelope("rolePlan", new JSONObject()
            .put("planId", "plan_1").put("title", "喝茶")
            .put("secret", "must stay local"));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(planEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "role_plan_update"))));

        JSONObject nestedPlanEnvelope = directTargetEnvelope("rolePlan", new JSONObject()
            .put("planId", "plan_1").put("title", "喝茶")
            .put("schedule", new JSONObject()
                .put("kind", "once").put("at", "2026-08-07T09:00:00+08:00")
                .put("secret", "must stay local")));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(nestedPlanEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "role_plan_update"))));

        JSONObject relationshipEnvelope = new JSONObject().put("context", new JSONObject()
            .put("currentBatch", currentBatch)
            .put("scene", new JSONObject()
                .put("relationshipStage", new JSONObject()
                    .put("base", "close").put("phase", "normal")
                    .put("secret", "must stay local"))
                .put("stagePersonaRevision", 3L)));
        assertThrows(IllegalArgumentException.class, () ->
            LocalFallbackActionAuthority.receiptActionContext(relationshipEnvelope,
                new JSONArray().put(new JSONObject().put("kind", "relationship_transition"))));
    }

    @Test public void initialRoomCommitUsesTheSamePinnedInputValidatorAsReplay() throws Exception {
        JSONObject payment = new JSONObject()
            .put("messageId", "pay_1").put("amount", 8L).put("status", "pending");
        JSONObject envelope = new JSONObject()
            .put("context", new JSONObject().put("payment", payment));
        JSONObject checkpoint = new JSONObject()
            .put("authorityLineageKey", "lin_1")
            .put("claimedLineageRevision", 1L)
            .put("normalizedEnvelope", envelope);
        com.siyi.al.execution.db.ChatTurnEntity turn =
            new com.siyi.al.execution.db.ChatTurnEntity();
        turn.characterId = "yuqi";
        JSONObject action = new JSONObject()
            .put("kind", "payment_accept")
            .put("targetKey", "payment:pay_1")
            .put("targetRevision", "sha256:" + BridgeAuthority.sha256CanonicalJson(payment))
            .put("payload", new JSONObject().put("messageId", "pay_1"));
        RoomExecutionStore.validateGeneratedLocalAction(turn, checkpoint, action);
        action.put("targetRevision", SHA_A);
        assertThrows(IllegalArgumentException.class,
            () -> RoomExecutionStore.validateGeneratedLocalAction(turn, checkpoint, action));
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
                .put("evidenceMessageIds", new JSONArray().put("msg_1"))
                .put("explicitAcknowledgedChange", true)
                .put("changedAt", 1001L))
            .put("expectedSceneRevision", 1L)
            .put("label", "close")
            .put("changedAt", 1001L);
    }

    private static JSONObject directTargetEnvelope(String key, JSONObject target) throws Exception {
        return new JSONObject().put("context", new JSONObject()
            .put("currentBatch", new JSONObject().put("batchId", "batch_1"))
            .put("input", new JSONObject().put(key, target)));
    }
}
