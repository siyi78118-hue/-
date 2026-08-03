package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.AuthorityIdentity;
import com.siyi.al.execution.BridgeAuthority;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeTurnStatusTest {
    @Test public void parsesClosedVisibleV3WithoutRequiringTheCurrentlyPolledMember() throws Exception {
        JSONObject result = canonicalResult("visible", "turn_original", 3, 1);
        JSONObject wrapper = new JSONObject(result.toString())
            .put("ok", true)
            .put("accepted", true)
            .put("terminal", true)
            .put("recoveryAckSeq", 17L);

        BridgeResult parsed = BridgeTurnStatus.parseV3(
            wrapper.toString(), "lan", null);

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, parsed.kind);
        assertEquals("turn_original", parsed.authoritativeTurnId);
        assertEquals("lin_test", parsed.authorityLineageKey);
        assertEquals(AuthorityIdentity.groupId("lin_test"), parsed.visibleGroupId);
        assertEquals(2L, parsed.lineageRevision);
        assertEquals(4L, parsed.turnRevision);
        assertEquals(8L, parsed.laneRevision);
        assertEquals("visible", parsed.terminalDisposition);
        assertEquals(3, parsed.replyPartsJson.size());
        assertEquals(1, parsed.actionsJson.size());
        assertEquals("lan", parsed.deliveryRoute);
        assertNull(parsed.relayMessageId);
        assertTrue(parsed.replyText.contains("第1段"));
        assertFalse(parsed.authorityPayloadJson.contains("recoveryAckSeq"));
    }

    @Test public void parsesActionOnlyAndSkipAsDistinctCanonicalTerminals() throws Exception {
        BridgeResult actionOnly = BridgeTurnStatus.parseV3(
            canonicalResult("action_only", "turn_action", 0, 2).toString(), "cloud", "relay_1");
        BridgeResult skip = BridgeTurnStatus.parseV3(
            canonicalResult("skip", "turn_skip", 0, 0).toString(), "lan", null);

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, actionOnly.kind);
        assertEquals("action_only", actionOnly.terminalDisposition);
        assertEquals(0, actionOnly.replyPartsJson.size());
        assertEquals(2, actionOnly.actionsJson.size());
        assertFalse(actionOnly.skipped);
        assertEquals("relay_1", actionOnly.relayMessageId);

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, skip.kind);
        assertEquals("skip", skip.terminalDisposition);
        assertEquals(0, skip.replyPartsJson.size());
        assertEquals(0, skip.actionsJson.size());
        assertTrue(skip.skipped);
    }

    @Test public void parsesOnlyAClosedVerifiedRemoteFailure() throws Exception {
        JSONObject failure = canonicalFailure(true);

        BridgeResult parsed = BridgeTurnStatus.parseV3(
            failure.toString(), "cloud", "relay_failure");

        assertEquals(BridgeResult.Kind.VERIFIED_REMOTE_FAILURE, parsed.kind);
        assertEquals("turn_failed", parsed.authoritativeTurnId);
        assertEquals("lin_failure", parsed.authorityLineageKey);
        assertEquals("transient", parsed.failureClass);
        assertTrue(parsed.retryAllowed);
        assertEquals(failure.getString("rawStatusChecksum"), parsed.rawStatusChecksum);
        assertEquals("relay_failure", parsed.relayMessageId);

        for (Object malformed : Arrays.asList("true", 1, JSONObject.NULL, new JSONArray().put(true))) {
            JSONObject changed = new JSONObject(failure.toString()).put("retryAllowed", malformed);
            assertThrows(IllegalArgumentException.class,
                () -> BridgeTurnStatus.parseV3(changed.toString(), "cloud", "relay_failure"));
        }
    }

    @Test public void rejectsUnknownMixedOrCoercedV3Shapes() throws Exception {
        JSONObject visible = canonicalResult("visible", "turn_visible", 1, 0);
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(
                new JSONObject(visible.toString()).put("route", "leak").toString(), "lan", null));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(
                new JSONObject(visible.toString()).put("lineageRevision", "2").toString(), "lan", null));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(
                new JSONObject(visible.toString()).put("type", "BACKLOG_FAILED").toString(), "lan", null));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(
                new JSONObject(visible.toString()).put("terminal", "true").toString(), "lan", null));

        JSONObject badOrdinal = canonicalResult("visible", "turn_visible", 2, 0);
        badOrdinal.getJSONArray("replyParts").getJSONObject(1).put("ordinal", 3);
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(badOrdinal.toString(), "lan", null));

        JSONObject changedItem = canonicalResult("visible", "turn_visible", 1, 0);
        changedItem.getJSONArray("replyParts").getJSONObject(0).put("content", "篡改");
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(changedItem.toString(), "lan", null));
    }

    @Test public void retainsLegacyV2ExactRequestedTurnBehavior() throws Exception {
        String raw = "{\"turnId\":\"turn_v2\",\"terminal\":true,\"action\":\"send\","
            + "\"reply\":{\"content\":\"旧回复\"}}";

        BridgeResult result = BridgeTurnStatus.parse(raw, "turn_v2").toResult("lan");

        assertEquals(BridgeResult.Kind.LEGACY_V2, result.kind);
        assertEquals("旧回复", result.replyText);
        assertThrows(IllegalStateException.class, () -> BridgeTurnStatus.parse(raw, "turn_other"));
    }

    @Test public void legacyV2ReplyWithDeliveryItemsButNoStructuredArraysStaysLegacy() throws Exception {
        String raw = "{\"turnId\":\"turn_v2_delivery\",\"terminal\":true,\"action\":\"send\","
            + "\"reply\":{\"content\":\"旧投递回复\"},"
            + "\"deliveryItems\":[{\"kind\":\"message\",\"id\":\"legacy_msg\",\"checksum\":\"legacy\"}]}";

        BridgeResult result = BridgeTurnStatus.parse(raw, "turn_v2_delivery").toResult("lan");

        assertEquals(BridgeResult.Kind.LEGACY_V2, result.kind);
        assertEquals("旧投递回复", result.replyText);
        assertEquals(0, result.replyPartsJson.size());
    }

    @Test public void structuredV2RequiresPartsActionsAndDeliveryItemsAsOneTuple() throws Exception {
        JSONObject partsOnly = canonicalV2Projection(1, 0, "send");
        partsOnly.remove("actions");
        partsOnly.remove("deliveryItems");
        JSONObject actionsOnly = canonicalV2Projection(0, 1, "send");
        actionsOnly.remove("replyParts");
        actionsOnly.remove("deliveryItems");

        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(partsOnly.toString(), "turn_v2_structured"));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(actionsOnly.toString(), "turn_v2_structured"));
    }

    @Test public void canonicalV2PreservesOrderedPartsAndActionsAndAggregatesText() throws Exception {
        JSONObject v2 = canonicalV2Projection(2, 1, "send");

        BridgeResult result = BridgeTurnStatus.parse(v2.toString(), "turn_v2_structured")
            .toResult("lan");

        assertEquals(BridgeResult.Kind.LEGACY_V2, result.kind);
        assertEquals("第1段\n第2段", result.replyText);
        assertEquals(2, result.replyPartsJson.size());
        assertEquals(1, result.actionsJson.size());
    }

    @Test public void canonicalV2PaymentOnlyActionIsCommittedWithoutTextAndSkipIsEmpty() throws Exception {
        JSONObject actionOnly = canonicalV2Projection(0, 1, "send");
        JSONObject payment = paymentAction(0);
        actionOnly.getJSONArray("actions").put(0, payment);
        actionOnly.put("deliveryItems", deliveryItems(
            actionOnly.getJSONArray("replyParts"), actionOnly.getJSONArray("actions")));
        actionOnly.put("paymentAction", "received");
        actionOnly.put("rolePlanOperations", new JSONArray());
        JSONObject skip = canonicalV2Projection(0, 0, "skip");

        BridgeResult actionResult = BridgeTurnStatus.parse(
            actionOnly.toString(), "turn_v2_structured").toResult("lan");
        BridgeResult skipResult = BridgeTurnStatus.parse(
            skip.toString(), "turn_v2_structured").toResult("lan");

        assertEquals("", actionResult.replyText);
        assertEquals(1, actionResult.actionsJson.size());
        assertEquals("received", actionResult.paymentStatus);
        assertFalse(actionResult.skipped);
        assertTrue(skipResult.skipped);
        assertEquals(0, skipResult.replyPartsJson.size());
        assertEquals(0, skipResult.actionsJson.size());
    }

    @Test public void canonicalV2StructuredShapeFailsClosed() throws Exception {
        JSONObject unknownAction = canonicalV2Projection(0, 1, "send");
        JSONObject action = unknownAction.getJSONArray("actions").getJSONObject(0);
        action.put("kind", "unknown_action");
        JSONObject semantic = new JSONObject()
            .put("kind", "unknown_action")
            .put("targetKey", action.getString("targetKey"))
            .put("targetRevision", action.getString("targetRevision"))
            .put("payload", action.getJSONObject("payload"));
        action.put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
        unknownAction.put("deliveryItems", deliveryItems(
            unknownAction.getJSONArray("replyParts"), unknownAction.getJSONArray("actions")));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(unknownAction.toString(), "turn_v2_structured"));

        JSONObject mismatchedSummary = canonicalV2Projection(2, 0, "send");
        mismatchedSummary.getJSONObject("reply").put("content", "只剩一段");
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(mismatchedSummary.toString(), "turn_v2_structured"));

        JSONObject missingDelivery = canonicalV2Projection(1, 0, "send");
        missingDelivery.getJSONArray("deliveryItems").remove(0);
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(missingDelivery.toString(), "turn_v2_structured"));
    }

    @Test public void canonicalV2CompatibilityFieldsAreAnExactBidirectionalActionProjection() throws Exception {
        JSONArray actions = new JSONArray()
            .put(canonicalAction(0, "payment_accept", new JSONObject().put("paymentId", "pay_1")))
            .put(canonicalAction(1, "moment_create", new JSONObject().put("text", "动态")))
            .put(canonicalAction(2, "role_plan_create", new JSONObject().put("planId", "plan_1")))
            .put(canonicalAction(3, "relationship_transition", new JSONObject().put("stage", "close")))
            .put(canonicalAction(4, "role_plan_cancel", new JSONObject().put("planId", "plan_2")))
            .put(canonicalAction(5, "life_episode_create", new JSONObject().put("episodeId", "life_1")));
        JSONObject value = canonicalV2Projection(0, 0, "skip");
        value.put("action", "send");
        value.put("actions", actions);
        value.put("deliveryItems", deliveryItems(value.getJSONArray("replyParts"), actions));
        value.put("paymentAction", "received");
        value.put("momentAction", new JSONObject().put("text", "动态"));
        value.put("relationshipStageAction", new JSONObject().put("stage", "close"));
        value.put("rolePlanOperations", new JSONArray()
            .put(new JSONObject().put("planId", "plan_1"))
            .put(new JSONObject().put("planId", "plan_2")));
        value.put("lifeAdjustment", new JSONObject().put("episodeId", "life_1"));

        BridgeResult parsed = BridgeTurnStatus.parse(value.toString(), "turn_v2_structured")
            .toResult("lan");
        assertEquals(6, parsed.actionsJson.size());

        for (String missing : Arrays.asList(
            "paymentAction", "momentAction", "relationshipStageAction",
            "rolePlanOperations", "lifeAdjustment")) {
            JSONObject changed = new JSONObject(value.toString());
            changed.remove(missing);
            assertThrows(IllegalArgumentException.class,
                () -> BridgeTurnStatus.parse(changed.toString(), "turn_v2_structured"));
        }
        JSONObject unknown = new JSONObject(value.toString()).put("secret", "leak");
        JSONObject badType = new JSONObject(value.toString()).put("paymentAction", new JSONArray());
        JSONObject badOrder = new JSONObject(value.toString()).put("rolePlanOperations", new JSONArray()
            .put(new JSONObject().put("planId", "plan_2"))
            .put(new JSONObject().put("planId", "plan_1")));
        for (JSONObject changed : Arrays.asList(unknown, badType, badOrder)) {
            assertThrows(IllegalArgumentException.class,
                () -> BridgeTurnStatus.parse(changed.toString(), "turn_v2_structured"));
        }

        JSONObject duplicate = new JSONObject(value.toString());
        JSONArray duplicateActions = duplicate.getJSONArray("actions");
        duplicateActions.put(canonicalAction(6, "moment_reply", new JSONObject().put("text", "重复")));
        duplicate.put("deliveryItems", deliveryItems(duplicate.getJSONArray("replyParts"), duplicateActions));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parse(duplicate.toString(), "turn_v2_structured"));
    }

    @Test public void canonicalV2ActionOnlyLifeAdjustmentSurvivesParseAndResultProjection() throws Exception {
        JSONObject lifeAdjustment = new JSONObject()
            .put("episodeId", "life_1")
            .put("summary", "去看了夜场电影");
        JSONArray actions = new JSONArray()
            .put(canonicalAction(0, "life_episode_create", lifeAdjustment));
        JSONObject value = canonicalV2Projection(0, 0, "skip")
            .put("action", "send")
            .put("actions", actions)
            .put("deliveryItems", deliveryItems(new JSONArray(), actions))
            .put("rolePlanOperations", new JSONArray())
            .put("lifeAdjustment", new JSONObject(lifeAdjustment.toString()));

        BridgeTurnStatus status = BridgeTurnStatus.parse(
            value.toString(), "turn_v2_structured");
        BridgeResult result = status.toResult("lan");

        String expected = lifeAdjustment.toString();
        assertEquals(expected, status.lifeAdjustmentJson);
        assertEquals(expected, result.lifeAdjustmentJson);
        assertEquals(1, result.actionsJson.size());
        assertEquals(
            BridgeAuthority.canonicalJson(actions.getJSONObject(0)),
            result.actionsJson.get(0));
    }

    @Test public void canonicalV2StructuredTransportFieldsAreNativeAndClosed() throws Exception {
        JSONObject valid = canonicalV2Projection(1, 0, "send")
            .put("ok", true).put("accepted", true).put("recoveryAckSeq", 7L);
        BridgeTurnStatus.parse(valid.toString(), "turn_v2_structured");
        for (JSONObject changed : Arrays.asList(
            new JSONObject(valid.toString()).put("ok", "true"),
            new JSONObject(valid.toString()).put("accepted", 1),
            new JSONObject(valid.toString()).put("recoveryAckSeq", "7"))) {
            assertThrows(IllegalArgumentException.class,
                () -> BridgeTurnStatus.parse(changed.toString(), "turn_v2_structured"));
        }
    }

    @Test public void v3RejectsSelfConsistentForgedDeterministicProjectionIds() throws Exception {
        JSONObject forgedGroup = canonicalResult("visible", "turn_visible", 1, 1)
            .put("visibleGroupId", AuthorityIdentity.groupId("lin_foreign"));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(forgedGroup.toString(), "lan", null));

        JSONObject forgedMessage = canonicalResult("visible", "turn_visible", 1, 0);
        forgedMessage.getJSONArray("replyParts").getJSONObject(0).put("messageId", "msg_forged");
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(forgedMessage.toString(), "lan", null));

        JSONObject forgedAction = canonicalResult("action_only", "turn_action", 0, 1);
        forgedAction.getJSONArray("actions").getJSONObject(0).put("actionId", "act_forged");
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(forgedAction.toString(), "cloud", "relay_action"));
    }

    @Test public void v3RouteAndRelayIdentityAreMutuallyClosed() throws Exception {
        JSONObject result = canonicalResult("skip", "turn_skip", 0, 0);
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(result.toString(), "lan", "relay_leak"));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(result.toString(), "cloud", null));
        assertThrows(IllegalArgumentException.class,
            () -> BridgeTurnStatus.parseV3(result.toString(), "cloud", ""));
    }

    @Test public void v3ResultAndFailureUseDifferentTransportAllowLists() throws Exception {
        JSONObject result = canonicalResult("skip", "turn_skip", 0, 0);
        for (JSONObject changed : Arrays.asList(
            new JSONObject(result.toString()).put("allowFallback", false),
            new JSONObject(result.toString()).put("action", "failed"),
            new JSONObject(result.toString()).put("retryAfterMs", 0L))) {
            assertThrows(IllegalArgumentException.class,
                () -> BridgeTurnStatus.parseV3(changed.toString(), "lan", null));
        }

        JSONObject failure = canonicalFailure(true)
            .put("ok", true)
            .put("accepted", true)
            .put("terminal", true)
            .put("recoveryAckSeq", 9L)
            .put("allowFallback", false)
            .put("action", "failed")
            .put("retryAfterMs", 0L);
        assertEquals(BridgeResult.Kind.VERIFIED_REMOTE_FAILURE,
            BridgeTurnStatus.parseV3(failure.toString(), "cloud", "relay_failure").kind);
    }

    private static JSONObject canonicalResult(
        String disposition, String turnId, int itemCount, int actionCount
    ) throws Exception {
        JSONArray parts = new JSONArray();
        String lineageKey = "lin_test";
        String groupId = AuthorityIdentity.groupId(lineageKey);
        for (int ordinal = 0; ordinal < itemCount; ordinal += 1) {
            JSONObject semantic = new JSONObject()
                .put("content", "第" + (ordinal + 1) + "段")
                .put("speakerId", "yuqi")
                .put("speakerType", "character")
                .put("recipientId", "user");
            parts.put(new JSONObject(semantic.toString())
                .put("messageId", AuthorityIdentity.messageId(groupId, ordinal))
                .put("ordinal", ordinal)
                .put("itemChecksum", BridgeAuthority.sha256CanonicalJson(semantic)));
        }
        JSONArray actions = new JSONArray();
        for (int ordinal = 0; ordinal < actionCount; ordinal += 1) {
            JSONObject payload = new JSONObject().put("planId", "plan_" + ordinal);
            JSONObject semantic = new JSONObject()
                .put("kind", ordinal == 0 ? "role_plan_create" : "role_plan_cancel")
                .put("targetKey", "role-plan:plan_" + ordinal)
                .put("targetRevision", "rev_" + ordinal)
                .put("payload", payload);
            actions.put(new JSONObject(semantic.toString())
                .put("actionId", AuthorityIdentity.actionId(groupId, ordinal))
                .put("ordinal", ordinal)
                .put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic)));
        }
        return new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", turnId)
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", groupId)
            .put("lineageRevision", 2L)
            .put("turnRevision", 4L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", disposition)
            .put("replyParts", parts)
            .put("actions", actions);
    }

    private static JSONObject canonicalV2Projection(
        int itemCount, int actionCount, String action
    ) throws Exception {
        JSONObject canonical = canonicalResult(
            itemCount == 0 && actionCount == 0 ? "skip" : itemCount == 0 ? "action_only" : "visible",
            "turn_v2_structured", itemCount, actionCount);
        JSONArray parts = canonical.getJSONArray("replyParts");
        JSONArray actions = canonical.getJSONArray("actions");
        JSONObject reply = null;
        if (parts.length() > 0) {
            reply = new JSONObject(parts.getJSONObject(0).toString());
            StringBuilder joined = new StringBuilder();
            for (int index = 0; index < parts.length(); index += 1) {
                if (index > 0) joined.append('\n');
                joined.append(parts.getJSONObject(index).getString("content"));
            }
            reply.put("content", joined.toString());
        }
        return new JSONObject()
            .put("turnId", "turn_v2_structured")
            .put("state", "committed")
            .put("terminal", true)
            .put("allowFallback", false)
            .put("action", action)
            .put("reply", reply == null ? JSONObject.NULL : reply)
            .put("replyParts", new JSONArray(parts.toString()))
            .put("actions", new JSONArray(actions.toString()))
            .put("deliveryItems", deliveryItems(parts, actions))
            .put("origin", "pc")
            .put("updatedAt", 1L)
            .put("retryAfterMs", 0L)
            .put("paymentAction", JSONObject.NULL)
            .put("momentAction", JSONObject.NULL)
            .put("relationshipStageAction", JSONObject.NULL)
            .put("rolePlanOperations", rolePlanPayloads(actions))
            .put("lifeAdjustment", JSONObject.NULL);
    }

    private static JSONObject paymentAction(int ordinal) throws Exception {
        String groupId = AuthorityIdentity.groupId("lin_test");
        JSONObject semantic = new JSONObject()
            .put("kind", "payment_accept")
            .put("targetKey", "payment:pay_1")
            .put("targetRevision", "rev_payment")
            .put("payload", new JSONObject().put("paymentId", "pay_1"));
        return new JSONObject(semantic.toString())
            .put("actionId", AuthorityIdentity.actionId(groupId, ordinal))
            .put("ordinal", ordinal)
            .put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
    }

    private static JSONObject canonicalAction(
        int ordinal, String kind, JSONObject payload
    ) throws Exception {
        String groupId = AuthorityIdentity.groupId("lin_test");
        JSONObject semantic = new JSONObject()
            .put("kind", kind)
            .put("targetKey", kind + ":target_" + ordinal)
            .put("targetRevision", "rev_" + ordinal)
            .put("payload", payload);
        return new JSONObject(semantic.toString())
            .put("actionId", AuthorityIdentity.actionId(groupId, ordinal))
            .put("ordinal", ordinal)
            .put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
    }

    private static JSONArray rolePlanPayloads(JSONArray actions) throws Exception {
        JSONArray result = new JSONArray();
        for (int index = 0; index < actions.length(); index += 1) {
            JSONObject action = actions.getJSONObject(index);
            if (action.getString("kind").startsWith("role_plan_")) {
                result.put(new JSONObject(action.getJSONObject("payload").toString()));
            }
        }
        return result;
    }

    private static JSONArray deliveryItems(JSONArray parts, JSONArray actions) throws Exception {
        JSONArray delivery = new JSONArray();
        for (int index = 0; index < parts.length(); index += 1) {
            JSONObject part = parts.getJSONObject(index);
            delivery.put(new JSONObject()
                .put("kind", "message")
                .put("id", part.getString("messageId"))
                .put("checksum", part.getString("itemChecksum")));
        }
        for (int index = 0; index < actions.length(); index += 1) {
            JSONObject value = actions.getJSONObject(index);
            delivery.put(new JSONObject()
                .put("kind", "action")
                .put("id", value.getString("actionId"))
                .put("checksum", value.getString("actionChecksum")));
        }
        return delivery;
    }

    private static JSONObject canonicalFailure(boolean retryAllowed) throws Exception {
        JSONObject value = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "BACKLOG_FAILED")
            .put("turnId", "turn_failed")
            .put("roleId", "yuqi")
            .put("authorityLineageKey", "lin_failure")
            .put("lineageRevision", 2L)
            .put("turnRevision", 4L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 8L)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("inputVisibilitySequence", 12L)
            .put("inputClearEpoch", 3L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("state", "failed")
            .put("errorCode", retryAllowed
                ? "YUQI_TRANSIENT_EXECUTION_FAILURE"
                : "YUQI_DETERMINISTIC_EXECUTION_FAILURE")
            .put("failureClass", retryAllowed ? "transient" : "deterministic")
            .put("retryAllowed", retryAllowed)
            .put("failedAt", 1700000000000L);
        value.put("rawStatusChecksum", BridgeAuthority.sha256CanonicalJson(value));
        return value;
    }

    private static String repeat(char value, int count) {
        char[] chars = new char[count];
        Arrays.fill(chars, value);
        return new String(chars);
    }
}
