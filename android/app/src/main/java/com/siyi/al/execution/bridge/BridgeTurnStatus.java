package com.siyi.al.execution.bridge;

import com.siyi.al.execution.AuthorityIdentity;
import com.siyi.al.execution.BridgeAuthority;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeTurnStatus {
    public static final class CanonicalPayloadRejectedException extends IllegalArgumentException {
        CanonicalPayloadRejectedException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Set<String> CANONICAL_RESULT_KEYS = immutableSet(
        "protocolVersion", "turnId", "roleId", "authorityOrigin", "authorityLineageKey",
        "visibleGroupId", "lineageRevision", "turnRevision", "laneKey", "laneRevision",
        "inputVisibilitySequence", "inputClearEpoch", "generationFingerprint", "releaseId",
        "commitPayloadVersion", "commitChecksum", "terminalDisposition", "replyParts", "actions");
    private static final Set<String> CANONICAL_FAILURE_KEYS = immutableSet(
        "protocolVersion", "type", "turnId", "roleId", "authorityLineageKey",
        "lineageRevision", "turnRevision", "laneKey", "laneRevision", "retryOfTurnId",
        "inputVisibilitySequence", "inputClearEpoch", "generationFingerprint", "releaseId",
        "state", "errorCode", "failureClass", "retryAllowed", "failedAt", "rawStatusChecksum");
    private static final Set<String> RESULT_TRANSPORT_KEYS = immutableSet(
        "ok", "accepted", "terminal", "recoveryAckSeq");
    private static final Set<String> FAILURE_TRANSPORT_KEYS = immutableSet(
        "ok", "accepted", "terminal", "recoveryAckSeq", "allowFallback", "action", "retryAfterMs");
    private static final Set<String> STRUCTURED_V2_KEYS = immutableSet(
        "turnId", "state", "terminal", "allowFallback", "action", "reply", "replyParts",
        "actions", "deliveryItems", "origin", "updatedAt", "retryAfterMs", "paymentAction",
        "momentAction", "relationshipStageAction", "rolePlanOperations", "lifeAdjustment");
    private static final Set<String> STRUCTURED_V2_TRANSPORT_KEYS = immutableSet(
        "ok", "accepted", "recoveryAckSeq");
    private static final Set<String> REPLY_PART_REQUIRED_KEYS = immutableSet(
        "content", "speakerId", "speakerType", "recipientId", "messageId", "ordinal", "itemChecksum");
    private static final Set<String> REPLY_PART_ALLOWED_KEYS = immutableSet(
        "content", "speakerId", "speakerType", "recipientId", "contentType", "attachment",
        "attachments", "replyToMessageId", "messageId", "ordinal", "itemChecksum");
    private static final Set<String> ACTION_KEYS = immutableSet(
        "actionId", "ordinal", "actionChecksum", "kind", "targetKey", "targetRevision", "payload");
    private static final Set<String> ACTION_KINDS = immutableSet(
        "payment_accept", "payment_decline", "moment_create", "moment_like", "moment_comment",
        "moment_reply", "role_plan_create", "role_plan_update", "role_plan_cancel",
        "role_plan_pause", "role_plan_resume", "role_plan_complete", "life_episode_create",
        "life_episode_update", "life_episode_cancel", "relationship_transition");
    final String turnId;
    final String state;
    final boolean terminal;
    final boolean allowFallback;
    final String action;
    final String paymentStatus;
    final String relationshipStageActionJson;
    final String momentActionJson;
    final String rolePlanOperationsJson;
    final String lifeAdjustmentJson;
    final String errorCode;
    final String replyText;
    final long retryAfterMs;
    final long recoveryAckSeq;
    final String origin;
    final String route;
    final String displayStage;
    final String technicalStage;
    final String stageModel;
    final String stageEffort;
    final long stageElapsedMs;
    final long totalElapsedMs;
    final String raw;
    final boolean structuredV2;
    final List<String> replyPartsJson;
    final List<String> actionsJson;

    private BridgeTurnStatus(
        String turnId, String state, boolean terminal, boolean allowFallback,
        String errorCode, String action, String paymentStatus, String relationshipStageActionJson, String momentActionJson, String rolePlanOperationsJson, String lifeAdjustmentJson, String replyText, long retryAfterMs, long recoveryAckSeq, String origin,
        String route, String displayStage, String technicalStage, String stageModel, String stageEffort,
        long stageElapsedMs, long totalElapsedMs, String raw, boolean structuredV2,
        List<String> replyPartsJson, List<String> actionsJson
    ) {
        this.turnId = turnId;
        this.state = state;
        this.terminal = terminal;
        this.allowFallback = allowFallback;
        this.errorCode = errorCode;
        this.action = action == null ? "" : action.trim();
        this.paymentStatus = paymentStatus == null ? "" : paymentStatus.trim();
        this.relationshipStageActionJson = relationshipStageActionJson == null ? "" : relationshipStageActionJson.trim();
        this.momentActionJson = momentActionJson == null ? "" : momentActionJson.trim();
        this.rolePlanOperationsJson = rolePlanOperationsJson == null ? "" : rolePlanOperationsJson.trim();
        this.lifeAdjustmentJson = lifeAdjustmentJson == null ? "" : lifeAdjustmentJson.trim();
        this.replyText = replyText;
        this.retryAfterMs = Math.max(100L, Math.min(10_000L, retryAfterMs <= 0L ? 1_500L : retryAfterMs));
        this.recoveryAckSeq = Math.max(0L, recoveryAckSeq);
        this.origin = origin == null ? "" : origin.trim();
        this.route = route == null ? "deep" : route.trim();
        this.displayStage = displayStage == null ? "" : displayStage.trim();
        this.technicalStage = technicalStage == null ? state : technicalStage.trim();
        this.stageModel = stageModel == null ? "" : stageModel.trim();
        this.stageEffort = stageEffort == null ? "" : stageEffort.trim();
        this.stageElapsedMs = Math.max(0L, stageElapsedMs);
        this.totalElapsedMs = Math.max(0L, totalElapsedMs);
        this.raw = raw;
        this.structuredV2 = structuredV2;
        this.replyPartsJson = immutableList(replyPartsJson);
        this.actionsJson = immutableList(actionsJson);
    }

    static BridgeTurnStatus parse(String raw, String expectedTurnId) throws Exception {
        JSONObject root = new JSONObject(raw);
        String turnId = root.optString("turnId", "");
        if (!expectedTurnId.equals(turnId)) throw new IllegalStateException("bridge turn ID mismatch");
        StructuredV2 structured = parseStructuredV2(root);
        JSONObject reply = root.optJSONObject("reply");
        String replyText = structured == null
            ? (reply == null ? "" : reply.optString("content", "").trim())
            : structured.replyText;
        boolean terminal = structured == null
            ? root.optBoolean("terminal", !replyText.isEmpty())
            : true;
        return new BridgeTurnStatus(
            turnId,
            root.optString("state", "queued"),
            terminal,
            root.optBoolean("allowFallback", false),
            root.optString("errorCode", ""),
            structured == null
                ? root.optString("action", replyText.isEmpty() ? "" : "send")
                : structured.action,
            root.optString("paymentAction", ""),
            root.optJSONObject("relationshipStageAction") == null ? "" : root.optJSONObject("relationshipStageAction").toString(),
            root.optJSONObject("momentAction") == null ? "" : root.optJSONObject("momentAction").toString(),
            nonEmptyArrayJson(root, "rolePlanOperations"),
            root.optJSONObject("lifeAdjustment") == null ? "" : root.optJSONObject("lifeAdjustment").toString(),
            replyText,
            root.optLong("retryAfterMs", 1_500L),
            root.optLong("recoveryAckSeq", 0L),
            root.optString("origin", reply == null ? "" : reply.optString("origin", "")),
            root.optString("route", "deep"),
            root.optString("displayStage", ""),
            root.optString("technicalStage", root.optString("state", "queued")),
            root.optString("stageModel", ""),
            root.optString("stageEffort", ""),
            root.optLong("stageElapsedMs", 0L),
            root.optLong("totalElapsedMs", 0L),
            raw,
            structured != null,
            structured == null ? Collections.emptyList() : structured.replyPartsJson,
            structured == null ? Collections.emptyList() : structured.actionsJson
        );
    }

    private static StructuredV2 parseStructuredV2(JSONObject root) {
        boolean anyStructured = root.has("replyParts") || root.has("actions");
        if (!anyStructured) return null;
        Set<String> actualKeys = keys(root);
        Set<String> allowedKeys = new HashSet<>(STRUCTURED_V2_KEYS);
        allowedKeys.addAll(STRUCTURED_V2_TRANSPORT_KEYS);
        if (!actualKeys.containsAll(STRUCTURED_V2_KEYS) || !allowedKeys.containsAll(actualKeys)) {
            throw new IllegalArgumentException("canonical v2 result keys conflict");
        }
        requireNonEmptyString(root, "turnId");
        if (!"committed".equals(requireString(root, "state"))) {
            throw new IllegalArgumentException("canonical v2 state conflict");
        }
        requireNonEmptyString(root, "origin");
        requireSafeInteger(root, "updatedAt", false);
        if (requireSafeInteger(root, "retryAfterMs", false) != 0L) {
            throw new IllegalArgumentException("canonical v2 retry delay conflict");
        }
        if (root.has("ok")) requireExactBoolean(root, "ok", true);
        if (root.has("accepted")) requireExactBoolean(root, "accepted", true);
        if (root.has("recoveryAckSeq")) requireSafeInteger(root, "recoveryAckSeq", false);
        JSONArray parts = requireArray(root, "replyParts");
        JSONArray actions = requireArray(root, "actions");
        JSONArray deliveries = requireArray(root, "deliveryItems");
        requireExactBoolean(root, "terminal", true);
        if (root.has("allowFallback")) requireExactBoolean(root, "allowFallback", false);
        String action = requireString(root, "action");
        if (!("send".equals(action) || "skip".equals(action))) {
            throw new IllegalArgumentException("canonical v2 action conflict");
        }

        validateV2ReplyParts(parts);
        validateV2Actions(actions);
        if (("skip".equals(action) && (parts.length() != 0 || actions.length() != 0))
            || ("send".equals(action) && parts.length() == 0 && actions.length() == 0)) {
            throw new IllegalArgumentException("canonical v2 disposition conflict");
        }
        String replyText = validateV2Summary(root, parts);
        validateV2DeliveryItems(deliveries, parts, actions);
        validateV2CompatibilityFields(root, actions);
        return new StructuredV2(
            action, replyText, canonicalList(parts), canonicalList(actions));
    }

    private static void validateV2ReplyParts(JSONArray parts) {
        Set<String> identities = new HashSet<>();
        for (int ordinal = 0; ordinal < parts.length(); ordinal += 1) {
            JSONObject part = requireObject(parts, ordinal, "canonical v2 reply part");
            Set<String> partKeys = keys(part);
            if (!partKeys.containsAll(REPLY_PART_REQUIRED_KEYS)
                || !REPLY_PART_ALLOWED_KEYS.containsAll(partKeys)) {
                throw new IllegalArgumentException("canonical v2 reply part keys conflict");
            }
            if (requireSafeInteger(part, "ordinal", false) != ordinal) {
                throw new IllegalArgumentException("canonical v2 reply part ordinal conflict");
            }
            if (!identities.add(requireNonEmptyString(part, "messageId"))) {
                throw new IllegalArgumentException("canonical v2 reply part identity conflict");
            }
            if (requireNonEmptyString(part, "content").trim().isEmpty()
                || requireNonEmptyString(part, "speakerId").isEmpty()
                || !"character".equals(requireString(part, "speakerType"))
                || !"user".equals(requireString(part, "recipientId"))) {
                throw new IllegalArgumentException("canonical v2 reply part identity conflict");
            }
            validateOptionalReplyFields(part);
            String checksum = requireChecksum(part, "itemChecksum");
            JSONObject semantic = copyObject(part);
            semantic.remove("messageId");
            semantic.remove("ordinal");
            semantic.remove("itemChecksum");
            if (!checksum.equals(BridgeAuthority.sha256CanonicalJson(semantic))) {
                throw new IllegalArgumentException("canonical v2 reply part checksum conflict");
            }
        }
    }

    private static void validateV2Actions(JSONArray actions) {
        Set<String> identities = new HashSet<>();
        for (int ordinal = 0; ordinal < actions.length(); ordinal += 1) {
            JSONObject action = requireObject(actions, ordinal, "canonical v2 action");
            if (!keys(action).equals(ACTION_KEYS)
                || requireSafeInteger(action, "ordinal", false) != ordinal
                || !identities.add(requireNonEmptyString(action, "actionId"))) {
                throw new IllegalArgumentException("canonical v2 action identity conflict");
            }
            String kind = requireString(action, "kind");
            if (!ACTION_KINDS.contains(kind)) {
                throw new IllegalArgumentException("canonical v2 action kind conflict");
            }
            requireNonEmptyString(action, "targetKey");
            requireNonEmptyString(action, "targetRevision");
            if (!(required(action, "payload") instanceof JSONObject)) {
                throw new IllegalArgumentException("canonical v2 action payload conflict");
            }
            JSONObject semantic = actionSemantic(action, kind);
            if (!requireChecksum(action, "actionChecksum")
                .equals(BridgeAuthority.sha256CanonicalJson(semantic))) {
                throw new IllegalArgumentException("canonical v2 action checksum conflict");
            }
        }
    }

    private static String validateV2Summary(JSONObject root, JSONArray parts) {
        Object rawReply = required(root, "reply");
        if (parts.length() == 0) {
            if (rawReply != JSONObject.NULL) {
                throw new IllegalArgumentException("canonical v2 reply summary conflict");
            }
            return "";
        }
        if (!(rawReply instanceof JSONObject)) {
            throw new IllegalArgumentException("canonical v2 reply summary conflict");
        }
        JSONObject reply = (JSONObject) rawReply;
        JSONObject first = requireObject(parts, 0, "canonical v2 reply part");
        if (!keys(reply).equals(keys(first))) {
            throw new IllegalArgumentException("canonical v2 reply summary keys conflict");
        }
        StringBuilder joined = new StringBuilder();
        for (int index = 0; index < parts.length(); index += 1) {
            if (index > 0) joined.append('\n');
            joined.append(requireString(requireObject(parts, index, "canonical v2 reply part"), "content"));
        }
        for (String key : keys(first)) {
            Object expected = "content".equals(key) ? joined.toString() : required(first, key);
            if (!BridgeAuthority.canonicalJson(expected)
                .equals(BridgeAuthority.canonicalJson(required(reply, key)))) {
                throw new IllegalArgumentException("canonical v2 reply summary conflict");
            }
        }
        return joined.toString();
    }

    private static void validateV2DeliveryItems(
        JSONArray delivery, JSONArray parts, JSONArray actions
    ) {
        if (delivery.length() != parts.length() + actions.length()) {
            throw new IllegalArgumentException("canonical v2 delivery item count conflict");
        }
        for (int index = 0; index < delivery.length(); index += 1) {
            JSONObject item = requireObject(delivery, index, "canonical v2 delivery item");
            if (!keys(item).equals(immutableSet("kind", "id", "checksum"))) {
                throw new IllegalArgumentException("canonical v2 delivery item keys conflict");
            }
            boolean message = index < parts.length();
            JSONObject source = message
                ? requireObject(parts, index, "canonical v2 reply part")
                : requireObject(actions, index - parts.length(), "canonical v2 action");
            String expectedId = requireString(source, message ? "messageId" : "actionId");
            String expectedChecksum = requireString(source, message ? "itemChecksum" : "actionChecksum");
            if (!(message ? "message" : "action").equals(requireString(item, "kind"))
                || !expectedId.equals(requireString(item, "id"))
                || !expectedChecksum.equals(requireString(item, "checksum"))) {
                throw new IllegalArgumentException("canonical v2 delivery item conflict");
            }
        }
    }

    private static void validateV2CompatibilityFields(JSONObject root, JSONArray actions) {
        String payment = null;
        JSONObject moment = null;
        JSONObject relationship = null;
        JSONObject life = null;
        JSONArray rolePlans = new JSONArray();
        for (int index = 0; index < actions.length(); index += 1) {
            JSONObject action = requireObject(actions, index, "canonical v2 action");
            String kind = requireString(action, "kind");
            JSONObject payload = copyObject((JSONObject) required(action, "payload"));
            if ("payment_accept".equals(kind) || "payment_decline".equals(kind)) {
                if (payment != null) throw new IllegalArgumentException("canonical v2 payment conflict");
                payment = "payment_accept".equals(kind) ? "received" : "refused";
            } else if (kind.startsWith("moment_")) {
                if (moment != null) throw new IllegalArgumentException("canonical v2 moment conflict");
                moment = payload;
            } else if ("relationship_transition".equals(kind)) {
                if (relationship != null) throw new IllegalArgumentException("canonical v2 relationship conflict");
                relationship = payload;
            } else if (kind.startsWith("role_plan_")) {
                put(rolePlans, payload);
            } else if (kind.startsWith("life_episode_")) {
                if (life != null) throw new IllegalArgumentException("canonical v2 life conflict");
                life = payload;
            }
        }
        validateNullableStringProjection(root, "paymentAction", payment);
        validateNullableObjectProjection(root, "momentAction", moment);
        validateNullableObjectProjection(root, "relationshipStageAction", relationship);
        validateNullableObjectProjection(root, "lifeAdjustment", life);
        Object rawRolePlans = required(root, "rolePlanOperations");
        if (!(rawRolePlans instanceof JSONArray)
            || !BridgeAuthority.canonicalJson(rawRolePlans).equals(BridgeAuthority.canonicalJson(rolePlans))) {
            throw new IllegalArgumentException("canonical v2 role plan projection conflict");
        }
    }

    private static void validateNullableStringProjection(
        JSONObject root, String key, String expected
    ) {
        Object actual = required(root, key);
        if (expected == null ? actual != JSONObject.NULL
            : !(actual instanceof String) || !expected.equals(actual)) {
            throw new IllegalArgumentException("canonical v2 " + key + " projection conflict");
        }
    }

    private static void validateNullableObjectProjection(
        JSONObject root, String key, JSONObject expected
    ) {
        Object actual = required(root, key);
        if (expected == null) {
            if (actual != JSONObject.NULL) {
                throw new IllegalArgumentException("canonical v2 " + key + " projection conflict");
            }
            return;
        }
        if (!(actual instanceof JSONObject)
            || !BridgeAuthority.canonicalJson(actual).equals(BridgeAuthority.canonicalJson(expected))) {
            throw new IllegalArgumentException("canonical v2 " + key + " projection conflict");
        }
    }

    private static List<String> canonicalList(JSONArray values) {
        List<String> output = new ArrayList<>();
        for (int index = 0; index < values.length(); index += 1) {
            output.add(BridgeAuthority.canonicalJson(required(values, index)));
        }
        return Collections.unmodifiableList(output);
    }

    private static final class StructuredV2 {
        final String action;
        final String replyText;
        final List<String> replyPartsJson;
        final List<String> actionsJson;

        StructuredV2(
            String action, String replyText, List<String> replyPartsJson, List<String> actionsJson
        ) {
            this.action = action;
            this.replyText = replyText;
            this.replyPartsJson = replyPartsJson;
            this.actionsJson = actionsJson;
        }
    }

    public static BridgeResult parseV3(
        String raw, String deliveryRoute, String relayMessageId
    ) {
        try {
            return parseV3Unchecked(raw, deliveryRoute, relayMessageId);
        } catch (CanonicalPayloadRejectedException error) {
            throw error;
        } catch (IllegalArgumentException error) {
            throw new CanonicalPayloadRejectedException(error.getMessage(), error);
        }
    }

    private static BridgeResult parseV3Unchecked(
        String raw, String deliveryRoute, String relayMessageId
    ) {
        if (!("lan".equals(deliveryRoute) || "cloud".equals(deliveryRoute))) {
            throw new IllegalArgumentException("v3 bridge route conflict");
        }
        if (("lan".equals(deliveryRoute) && relayMessageId != null)
            || ("cloud".equals(deliveryRoute)
                && (relayMessageId == null || relayMessageId.isEmpty()))) {
            throw new IllegalArgumentException("v3 bridge relay identity conflict");
        }
        final JSONObject root;
        try {
            root = new JSONObject(raw);
        } catch (Exception error) {
            throw new IllegalArgumentException("v3 bridge result JSON conflict", error);
        }
        requireExactInteger(root, "protocolVersion", 3L, "v3 bridge result");
        if (root.has("type")) {
            validateFailureTransportFields(root);
            JSONObject failure = extractAuthorityPayload(
                root, CANONICAL_FAILURE_KEYS, FAILURE_TRANSPORT_KEYS);
            JSONObject validated = BridgeAuthority.validateCanonicalFailureStatus(failure);
            return BridgeResult.verifiedRemoteFailure(validated, raw, deliveryRoute, relayMessageId);
        }
        validateResultTransportFields(root);
        JSONObject result = extractAuthorityPayload(
            root, CANONICAL_RESULT_KEYS, RESULT_TRANSPORT_KEYS);
        validateCanonicalTerminal(result);
        return BridgeResult.canonicalTerminal(result, raw, deliveryRoute, relayMessageId);
    }

    private static JSONObject extractAuthorityPayload(
        JSONObject root, Set<String> authorityKeys, Set<String> transportKeys
    ) {
        Set<String> actual = keys(root);
        Set<String> allowed = new HashSet<>(authorityKeys);
        allowed.addAll(transportKeys);
        if (!actual.containsAll(authorityKeys) || !allowed.containsAll(actual)) {
            throw new IllegalArgumentException("v3 bridge result keys conflict");
        }
        JSONObject payload = new JSONObject();
        for (String key : authorityKeys) put(payload, key, required(root, key));
        return payload;
    }

    private static void validateResultTransportFields(JSONObject value) {
        validateCommonTransportFields(value);
    }

    private static void validateFailureTransportFields(JSONObject value) {
        validateCommonTransportFields(value);
        if (value.has("allowFallback")) requireExactBoolean(value, "allowFallback", false);
        if (value.has("action") && !"failed".equals(requireString(value, "action"))) {
            throw new IllegalArgumentException("v3 bridge action conflict");
        }
        if (value.has("retryAfterMs") && requireSafeInteger(value, "retryAfterMs", false) != 0L) {
            throw new IllegalArgumentException("v3 bridge retry delay conflict");
        }
    }

    private static void validateCommonTransportFields(JSONObject value) {
        if (value.has("ok")) requireExactBoolean(value, "ok", true);
        if (value.has("accepted")) requireExactBoolean(value, "accepted", true);
        if (value.has("terminal")) requireExactBoolean(value, "terminal", true);
        if (value.has("recoveryAckSeq")) requireSafeInteger(value, "recoveryAckSeq", false);
    }

    private static void validateCanonicalTerminal(JSONObject value) {
        requireExactInteger(value, "protocolVersion", 3L, "canonical result");
        String turnId = requireNonEmptyString(value, "turnId");
        String roleId = requireNonEmptyString(value, "roleId");
        if (!"pc".equals(requireString(value, "authorityOrigin"))) {
            throw new IllegalArgumentException("canonical result origin conflict");
        }
        String lineageKey = requireNonEmptyString(value, "authorityLineageKey");
        String groupId = requireNonEmptyString(value, "visibleGroupId");
        if (!AuthorityIdentity.groupId(lineageKey).equals(groupId)) {
            throw new IllegalArgumentException("canonical result group identity conflict");
        }
        requireSafeInteger(value, "lineageRevision", false);
        requireSafeInteger(value, "turnRevision", false);
        requireNonEmptyString(value, "laneKey");
        requireSafeInteger(value, "laneRevision", false);
        requireSafeInteger(value, "inputVisibilitySequence", false);
        requireSafeInteger(value, "inputClearEpoch", false);
        requireNullableNonEmptyString(value, "generationFingerprint");
        requireNonEmptyString(value, "releaseId");
        requireNonEmptyString(value, "commitPayloadVersion");
        requireChecksum(value, "commitChecksum");
        String disposition = requireString(value, "terminalDisposition");
        if (!Arrays.asList("visible", "action_only", "skip").contains(disposition)) {
            throw new IllegalArgumentException("canonical result disposition conflict");
        }
        JSONArray parts = requireArray(value, "replyParts");
        JSONArray actions = requireArray(value, "actions");
        Set<String> messageIds = new HashSet<>();
        for (int ordinal = 0; ordinal < parts.length(); ordinal += 1) {
            JSONObject part = requireObject(parts, ordinal, "canonical reply part");
            Set<String> partKeys = keys(part);
            if (!partKeys.containsAll(REPLY_PART_REQUIRED_KEYS)
                || !REPLY_PART_ALLOWED_KEYS.containsAll(partKeys)) {
                throw new IllegalArgumentException("canonical reply part keys conflict");
            }
            String messageId = requireNonEmptyString(part, "messageId");
            if (!messageIds.add(messageId)
                || !AuthorityIdentity.messageId(groupId, ordinal).equals(messageId)) {
                throw new IllegalArgumentException("canonical reply part identity conflict");
            }
            if (requireSafeInteger(part, "ordinal", false) != ordinal) {
                throw new IllegalArgumentException("canonical reply part ordinal conflict");
            }
            String content = requireNonEmptyString(part, "content");
            if (content.trim().isEmpty()
                || !roleId.equals(requireString(part, "speakerId"))
                || !"character".equals(requireString(part, "speakerType"))
                || !"user".equals(requireString(part, "recipientId"))) {
                throw new IllegalArgumentException("canonical reply part identity conflict");
            }
            validateOptionalReplyFields(part);
            String checksum = requireChecksum(part, "itemChecksum");
            JSONObject semantic = copyObject(part);
            semantic.remove("messageId");
            semantic.remove("ordinal");
            semantic.remove("itemChecksum");
            if (!checksum.equals(BridgeAuthority.sha256CanonicalJson(semantic))) {
                throw new IllegalArgumentException("canonical reply part checksum conflict");
            }
        }
        Set<String> actionIds = new HashSet<>();
        for (int ordinal = 0; ordinal < actions.length(); ordinal += 1) {
            JSONObject action = requireObject(actions, ordinal, "canonical action");
            if (!keys(action).equals(ACTION_KEYS)) {
                throw new IllegalArgumentException("canonical action keys conflict");
            }
            String actionId = requireNonEmptyString(action, "actionId");
            if (!actionIds.add(actionId)
                || !AuthorityIdentity.actionId(groupId, ordinal).equals(actionId)) {
                throw new IllegalArgumentException("canonical action identity conflict");
            }
            if (requireSafeInteger(action, "ordinal", false) != ordinal) {
                throw new IllegalArgumentException("canonical action ordinal conflict");
            }
            String kind = requireString(action, "kind");
            if (!ACTION_KINDS.contains(kind)) {
                throw new IllegalArgumentException("canonical action kind conflict");
            }
            requireNonEmptyString(action, "targetKey");
            requireNonEmptyString(action, "targetRevision");
            if (!(required(action, "payload") instanceof JSONObject)) {
                throw new IllegalArgumentException("canonical action payload conflict");
            }
            String checksum = requireChecksum(action, "actionChecksum");
            JSONObject semantic = actionSemantic(action, kind);
            if (!checksum.equals(BridgeAuthority.sha256CanonicalJson(semantic))) {
                throw new IllegalArgumentException("canonical action checksum conflict");
            }
        }
        if (("visible".equals(disposition) && parts.length() == 0)
            || ("action_only".equals(disposition) && (parts.length() != 0 || actions.length() == 0))
            || ("skip".equals(disposition) && (parts.length() != 0 || actions.length() != 0))) {
            throw new IllegalArgumentException("canonical result disposition shape conflict");
        }
        if (turnId.isEmpty()) throw new IllegalArgumentException("canonical result turn conflict");
    }

    private static void validateOptionalReplyFields(JSONObject value) {
        if (value.has("contentType") && !(required(value, "contentType") instanceof String)) {
            throw new IllegalArgumentException("canonical reply content type conflict");
        }
        if (value.has("replyToMessageId")) {
            Object replyTo = required(value, "replyToMessageId");
            if (!(replyTo == JSONObject.NULL || (replyTo instanceof String && !((String) replyTo).isEmpty()))) {
                throw new IllegalArgumentException("canonical reply target conflict");
            }
        }
        if (value.has("attachment") && !(required(value, "attachment") instanceof JSONObject)) {
            throw new IllegalArgumentException("canonical reply attachment conflict");
        }
        if (value.has("attachments") && !(required(value, "attachments") instanceof JSONArray)) {
            throw new IllegalArgumentException("canonical reply attachments conflict");
        }
    }

    private static JSONObject actionSemantic(JSONObject action, String kind) {
        JSONObject semantic = new JSONObject();
        put(semantic, "kind", kind);
        put(semantic, "targetKey", required(action, "targetKey"));
        put(semantic, "targetRevision", required(action, "targetRevision"));
        put(semantic, "payload", copyObject((JSONObject) required(action, "payload")));
        return semantic;
    }

    private static JSONObject requireObject(JSONArray value, int index, String label) {
        Object raw = required(value, index);
        if (!(raw instanceof JSONObject)) throw new IllegalArgumentException(label + " must be an object");
        return (JSONObject) raw;
    }

    private static JSONArray requireArray(JSONObject value, String key) {
        Object raw = required(value, key);
        if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("canonical result " + key + " conflict");
        return (JSONArray) raw;
    }

    private static String requireChecksum(JSONObject value, String key) {
        String checksum = requireString(value, key);
        if (!checksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("canonical result " + key + " conflict");
        }
        return checksum;
    }

    private static String requireNonEmptyString(JSONObject value, String key) {
        String result = requireString(value, key);
        if (result.isEmpty()) throw new IllegalArgumentException("canonical result " + key + " conflict");
        return result;
    }

    private static String requireString(JSONObject value, String key) {
        Object raw = required(value, key);
        if (!(raw instanceof String)) throw new IllegalArgumentException("canonical result " + key + " conflict");
        return (String) raw;
    }

    private static void requireNullableNonEmptyString(JSONObject value, String key) {
        Object raw = required(value, key);
        if (raw == JSONObject.NULL) return;
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("canonical result " + key + " conflict");
        }
    }

    private static void requireExactInteger(JSONObject value, String key, long expected, String label) {
        if (requireSafeInteger(value, key, false) != expected) {
            throw new IllegalArgumentException(label + " " + key + " conflict");
        }
    }

    private static long requireSafeInteger(JSONObject value, String key, boolean positive) {
        Object raw = required(value, key);
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("canonical result " + key + " integer conflict");
        }
        long number = ((Number) raw).longValue();
        if (number < (positive ? 1L : 0L) || number > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("canonical result " + key + " range conflict");
        }
        return number;
    }

    private static void requireExactBoolean(JSONObject value, String key, boolean expected) {
        Object raw = required(value, key);
        if (!(raw instanceof Boolean) || ((Boolean) raw) != expected) {
            throw new IllegalArgumentException("v3 bridge " + key + " conflict");
        }
    }

    private static Object required(JSONObject value, String key) {
        if (!value.has(key)) throw new IllegalArgumentException("v3 bridge result missing " + key);
        return value.opt(key);
    }

    private static Object required(JSONArray value, int index) {
        if (index < 0 || index >= value.length()) throw new IllegalArgumentException("v3 bridge array conflict");
        return value.opt(index);
    }

    private static JSONObject copyObject(JSONObject value) {
        try {
            return new JSONObject(value.toString());
        } catch (Exception error) {
            throw new IllegalArgumentException("v3 bridge object copy conflict", error);
        }
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalArgumentException("v3 bridge object projection conflict", error);
        }
    }

    private static void put(JSONArray target, Object value) {
        target.put(value);
    }

    private static Set<String> keys(JSONObject value) {
        Set<String> output = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) output.add(iterator.next());
        return output;
    }

    private static Set<String> immutableSet(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }

    private static List<String> immutableList(List<String> values) {
        return Collections.unmodifiableList(new ArrayList<>(values));
    }

    private static String nonEmptyArrayJson(JSONObject root, String key) {
        org.json.JSONArray value = root.optJSONArray(key);
        return value == null || value.length() == 0 ? "" : value.toString();
    }

    boolean committed() {
        if (structuredV2) {
            return terminal && "send".equals(action)
                && (!replyPartsJson.isEmpty() || !actionsJson.isEmpty());
        }
        return terminal && "send".equals(action)
            && (!replyText.isEmpty() || !momentActionJson.isEmpty() || !rolePlanOperationsJson.isEmpty());
    }
    boolean skipped() { return terminal && "skip".equals(action); }
    boolean failedFinal() { return terminal && !committed() && !skipped(); }

    BridgeResult toResult(String route) {
        if (!committed() && !skipped()) throw new IllegalStateException("bridge turn is not committed");
        if (structuredV2) {
            return BridgeResult.structuredLegacy(
                origin.isEmpty() ? route : origin, replyText, raw, skipped(), paymentStatus,
                relationshipStageActionJson, momentActionJson, rolePlanOperationsJson, lifeAdjustmentJson,
                replyPartsJson, actionsJson);
        }
        if (skipped()) return BridgeResult.skipped(origin.isEmpty() ? route : origin, raw);
        return BridgeResult.success(origin.isEmpty() ? route : origin, replyText, raw, paymentStatus, relationshipStageActionJson, momentActionJson, rolePlanOperationsJson);
    }
}
