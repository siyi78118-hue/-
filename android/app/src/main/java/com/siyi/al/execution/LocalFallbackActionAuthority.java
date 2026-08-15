package com.siyi.al.execution;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Closed semantic validation shared by local action generation and receipt replay. */
public final class LocalFallbackActionAuthority {
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Set<String> MOMENT_KEYS = set(
        "momentId", "like", "comment", "replyToCommentId");
    private static final Set<String> RELATIONSHIP_KEYS = set(
        "baseAction", "phaseAction", "expectedSceneRevision", "label", "changedAt");
    private static final Set<String> BASE_RELATIONSHIP_KEYS = set(
        "from", "to", "label", "reason", "confidence", "evidenceMessageIds",
        "explicitMutualChange", "changedAt");
    private static final Set<String> PHASE_RELATIONSHIP_KEYS = set(
        "from", "to", "label", "reason", "confidence", "evidenceMessageIds",
        "explicitAcknowledgedChange", "changedAt");
    private static final Set<String> PLAN_CREATE_ALLOWED = set(
        "op", "planId", "type", "source", "title", "intent", "schedule",
        "timeConfidence", "durationMs", "origin", "sourceQuote", "evidenceMessageIds");
    private static final Set<String> PLAN_CREATE_REQUIRED = set(
        "op", "type", "source", "title", "intent", "schedule", "timeConfidence");
    private static final Set<String> PLAN_UPDATE_KEYS = set("op", "planId", "patch", "reason");
    private static final Set<String> PLAN_UPDATE_REQUIRED = set("op", "planId", "patch");
    private static final Set<String> PLAN_TERMINAL_ALLOWED = set("op", "planId", "reason");
    private static final Set<String> PLAN_TERMINAL_REQUIRED = set("op", "planId");
    private static final Set<String> PLAN_PATCH_ALLOWED = set(
        "type", "source", "title", "intent", "schedule", "timeConfidence",
        "durationMs", "origin", "sourceQuote", "evidenceMessageIds");
    private static final Set<String> PINNED_PAYMENT_KEYS = set(
        "kind", "amount", "note", "messageId", "status");
    private static final Set<String> PINNED_MOMENT_ALLOWED = set(
        "momentId", "authorId", "ownerId", "content", "createdAt", "revision");
    private static final Set<String> PINNED_COMMENT_ALLOWED = set(
        "commentId", "momentId", "authorId", "ownerId", "content", "createdAt",
        "revision", "replyToCommentId");
    private static final Set<String> PINNED_ROLE_PLAN_ALLOWED = set(
        "planId", "characterId", "roleId", "type", "source", "title", "intent",
        "schedule", "timeConfidence", "durationMs", "origin", "sourceQuote",
        "evidenceMessageIds", "status", "nextRunAt", "revision", "updatedAt");
    private static final Set<String> PINNED_RELATIONSHIP_STAGE_ALLOWED = set(
        "id", "label", "content", "since", "reason", "confidence", "base", "phase");
    private static final Set<String> PINNED_RELATIONSHIP_PART_ALLOWED = set(
        "id", "label", "content", "since", "reason", "confidence");

    private LocalFallbackActionAuthority() {}

    public static void validate(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload
    ) {
        validate(kind, targetKey, targetRevision, payload, null, null);
    }

    static void validate(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload,
        String expectedRoleId,
        String expectedLineageKey
    ) {
        if (kind == null || targetKey == null || targetRevision == null || payload == null) {
            conflict();
        }
        if (kind.equals("payment_accept") || kind.equals("payment_decline")) {
            exactKeys(payload, set("messageId"));
            String messageId = text(payload, "messageId", 128);
            if (!targetKey.equals("payment:" + messageId) || !shaRevision(targetRevision)) conflict();
            return;
        }
        if (kind.equals("moment_like") || kind.equals("moment_comment") || kind.equals("moment_reply")) {
            validateMoment(kind, targetKey, targetRevision, payload);
            return;
        }
        if (kind.equals("relationship_transition")) {
            validateRelationship(targetKey, targetRevision, payload, expectedRoleId);
            return;
        }
        if (kind.startsWith("role_plan_")) {
            validateRolePlan(kind, targetKey, targetRevision, payload, expectedLineageKey);
            return;
        }
        conflict();
    }

    static void validateAgainstPinnedInput(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload,
        String expectedRoleId,
        String expectedLineageKey,
        long claimedLineageRevision,
        JSONObject normalizedEnvelope
    ) throws Exception {
        validate(kind, targetKey, targetRevision, payload, expectedRoleId, expectedLineageKey);
        if (normalizedEnvelope == null) conflict();
        JSONObject context = actionContext(normalizedEnvelope);
        if (kind.equals("payment_accept") || kind.equals("payment_decline")) {
            JSONObject payment = context == null ? null : context.optJSONObject("payment");
            if (payment == null
                || !payload.getString("messageId").equals(payment.optString("messageId", ""))
                || !targetRevision.equals("sha256:" + BridgeAuthority.sha256CanonicalJson(payment))) {
                conflict();
            }
            return;
        }
        if (kind.equals("moment_like") || kind.equals("moment_comment") || kind.equals("moment_reply")) {
            JSONObject input = context == null ? null : context.optJSONObject("input");
            String namespace = kind.equals("moment_reply") ? "comment" : "moment";
            JSONObject target = input == null ? null : input.optJSONObject(
                kind.equals("moment_reply") ? "targetComment" : "targetMoment");
            String targetId = kind.equals("moment_reply")
                ? payload.optString("replyToCommentId", "") : payload.optString("momentId", "");
            String targetField = kind.equals("moment_reply") ? "commentId" : "momentId";
            if (target == null || !targetId.equals(target.optString(targetField, ""))
                || !targetKey.equals(namespace + ":" + targetId)
                || !targetRevision.equals("sha256:" + BridgeAuthority.sha256CanonicalJson(target))) {
                conflict();
            }
            return;
        }
        if (kind.equals("relationship_transition")) {
            JSONObject scene = context == null ? null : context.optJSONObject("scene");
            if (scene == null || !(scene.opt("stagePersonaRevision") instanceof Number)
                || !(scene.opt("relationshipStage") instanceof JSONObject)) conflict();
            validatePinnedRelationshipStage(scene.getJSONObject("relationshipStage"));
            long revision = safeInteger(scene.opt("stagePersonaRevision"), 0L);
            JSONObject target = new JSONObject()
                .put("relationshipStage", scene.getJSONObject("relationshipStage"))
                .put("stagePersonaRevision", revision);
            if (safeInteger(payload.opt("expectedSceneRevision"), 0L) != revision
                || !targetRevision.equals("sha256:" + BridgeAuthority.sha256CanonicalJson(target))) {
                conflict();
            }
            return;
        }
        if (kind.equals("role_plan_create")) {
            if (claimedLineageRevision < 1L || claimedLineageRevision > MAX_SAFE_INTEGER
                || !targetRevision.equals(String.valueOf(claimedLineageRevision))) conflict();
            return;
        }
        JSONObject input = context == null ? null : context.optJSONObject("input");
        JSONObject rolePlan = input == null ? null : input.optJSONObject("rolePlan");
        if (rolePlan == null || !payload.optString("planId", "").equals(rolePlan.optString("planId", ""))
            || !targetRevision.equals("sha256:" + BridgeAuthority.sha256CanonicalJson(rolePlan))) {
            conflict();
        }
    }

    /** Minimal direct-turn authority proof that may cross the recovery journal boundary. */
    static JSONObject receiptActionContext(
        JSONObject normalizedEnvelope,
        JSONArray actions
    ) throws Exception {
        JSONObject source = normalizedEnvelope == null
            ? null : normalizedEnvelope.optJSONObject("context");
        if (source == null || !source.has("currentBatch") || actions == null) conflict();
        JSONObject payment = null;
        JSONObject scene = null;
        JSONObject targetMoment = null;
        JSONObject targetComment = null;
        JSONObject rolePlan = null;
        JSONObject sourceInput = source.optJSONObject("input");
        for (int index = 0; index < actions.length(); index += 1) {
            String kind = actions.getJSONObject(index).getString("kind");
            if (kind.equals("payment_accept") || kind.equals("payment_decline")) {
                JSONObject value = source.optJSONObject("payment");
                if (value == null) conflict();
                validatePinnedPayment(value);
                payment = new JSONObject(value.toString());
            } else if (kind.equals("relationship_transition")) {
                JSONObject value = source.optJSONObject("scene");
                if (value == null
                    || !(value.opt("relationshipStage") instanceof JSONObject)
                    || !(value.opt("stagePersonaRevision") instanceof Number)) conflict();
                validatePinnedRelationshipStage(value.getJSONObject("relationshipStage"));
                scene = new JSONObject()
                    .put("relationshipStage", new JSONObject(
                        value.getJSONObject("relationshipStage").toString()))
                    .put("stagePersonaRevision",
                        safeInteger(value.opt("stagePersonaRevision"), 0L));
            } else if (kind.equals("moment_like") || kind.equals("moment_comment")) {
                JSONObject value = sourceInput == null ? null : sourceInput.optJSONObject("targetMoment");
                if (value == null) conflict();
                validatePinnedMoment(value);
                targetMoment = new JSONObject(value.toString());
            } else if (kind.equals("moment_reply")) {
                JSONObject value = sourceInput == null ? null : sourceInput.optJSONObject("targetComment");
                if (value == null) conflict();
                validatePinnedComment(value);
                targetComment = new JSONObject(value.toString());
            } else if (kind.startsWith("role_plan_") && !kind.equals("role_plan_create")) {
                JSONObject value = sourceInput == null ? null : sourceInput.optJSONObject("rolePlan");
                if (value == null) conflict();
                validatePinnedRolePlan(value);
                rolePlan = new JSONObject(value.toString());
            } else if (!kind.equals("role_plan_create")) {
                conflict();
            }
        }
        JSONObject basis = new JSONObject()
            .put("version", 1L)
            .put("payment", payment == null ? JSONObject.NULL : payment)
            .put("scene", scene == null ? JSONObject.NULL : scene)
            .put("input", new JSONObject()
                .put("targetMoment", targetMoment == null ? JSONObject.NULL : targetMoment)
                .put("targetComment", targetComment == null ? JSONObject.NULL : targetComment)
                .put("rolePlan", rolePlan == null ? JSONObject.NULL : rolePlan));
        return new JSONObject(basis.toString())
            .put("checksum", BridgeAuthority.sha256CanonicalJson(basis));
    }

    private static void validatePinnedPayment(JSONObject value) {
        exactKeys(value, PINNED_PAYMENT_KEYS);
        enumText(value, "kind", set("redpacket", "transfer"));
        Object amount = value.opt("amount");
        if (!(amount instanceof Number) || !Double.isFinite(((Number) amount).doubleValue())
            || ((Number) amount).doubleValue() <= 0D) conflict();
        optionalText(value, "note", 600);
        text(value, "messageId", 128);
        if (!"pending".equals(text(value, "status", 32))) conflict();
    }

    private static void validatePinnedMoment(JSONObject value) {
        allowedAndRequired(value, PINNED_MOMENT_ALLOWED, set("momentId"));
        text(value, "momentId", 128);
        validateOptionalTargetFields(value);
    }

    private static void validatePinnedComment(JSONObject value) {
        allowedAndRequired(value, PINNED_COMMENT_ALLOWED, set("commentId"));
        text(value, "commentId", 128);
        if (value.has("momentId")) text(value, "momentId", 128);
        if (value.has("replyToCommentId") && !value.isNull("replyToCommentId")) {
            text(value, "replyToCommentId", 128);
        }
        validateOptionalTargetFields(value);
    }

    private static void validateOptionalTargetFields(JSONObject value) {
        if (value.has("authorId")) text(value, "authorId", 128);
        if (value.has("ownerId")) text(value, "ownerId", 128);
        if (value.has("content")) optionalText(value, "content", 12_000);
        if (value.has("createdAt")) safeInteger(value.opt("createdAt"), 0L);
        if (value.has("revision")) safeInteger(value.opt("revision"), 0L);
    }

    private static void validatePinnedRolePlan(JSONObject value) {
        allowedAndRequired(value, PINNED_ROLE_PLAN_ALLOWED, set("planId"));
        text(value, "planId", 96);
        validatePlanSemanticFields(value, false);
        if (value.has("characterId")) text(value, "characterId", 128);
        if (value.has("roleId")) text(value, "roleId", 128);
        if (value.has("status")) text(value, "status", 64);
        if (value.has("nextRunAt") && !value.isNull("nextRunAt")) {
            safeInteger(value.opt("nextRunAt"), 0L);
        }
        if (value.has("revision")) safeInteger(value.opt("revision"), 0L);
        if (value.has("updatedAt")) safeInteger(value.opt("updatedAt"), 0L);
    }

    private static void validatePinnedRelationshipStage(JSONObject value) {
        if (value == null || keysOf(value).isEmpty()
            || !PINNED_RELATIONSHIP_STAGE_ALLOWED.containsAll(keysOf(value))) conflict();
        validatePinnedRelationshipFields(value);
        for (String key : Arrays.asList("base", "phase")) {
            if (!value.has(key)) continue;
            Object part = value.opt(key);
            if (part instanceof String) {
                if (((String) part).isEmpty() || ((String) part).length() > 80) conflict();
                continue;
            }
            if (!(part instanceof JSONObject)) conflict();
            JSONObject object = (JSONObject) part;
            if (keysOf(object).isEmpty()
                || !PINNED_RELATIONSHIP_PART_ALLOWED.containsAll(keysOf(object))) conflict();
            validatePinnedRelationshipFields(object);
        }
    }

    private static void validatePinnedRelationshipFields(JSONObject value) {
        if (value.has("id")) text(value, "id", 80);
        if (value.has("label")) text(value, "label", 80);
        if (value.has("content")) optionalText(value, "content", 12_000);
        if (value.has("since")) safeInteger(value.opt("since"), 0L);
        if (value.has("reason")) optionalText(value, "reason", 500);
        if (value.has("confidence")) {
            Object raw = value.opt("confidence");
            if (!(raw instanceof Number) || !Double.isFinite(((Number) raw).doubleValue())
                || ((Number) raw).doubleValue() < 0D || ((Number) raw).doubleValue() > 1D) conflict();
        }
    }

    private static JSONObject actionContext(JSONObject envelope) {
        JSONObject context = envelope.optJSONObject("context");
        if (context != null) return context;
        JSONObject trigger = envelope.optJSONObject("trigger");
        return trigger == null ? null : trigger.optJSONObject("context");
    }

    private static void validateMoment(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload
    ) {
        exactKeys(payload, MOMENT_KEYS);
        String momentId = text(payload, "momentId", 128);
        if (!(payload.opt("like") instanceof Boolean)
            || !(payload.opt("comment") instanceof String)
            || !(payload.isNull("replyToCommentId")
                || payload.opt("replyToCommentId") instanceof String)
            || !shaRevision(targetRevision)) {
            conflict();
        }
        boolean like = payload.optBoolean("like");
        String comment = payload.optString("comment", "");
        String replyId = payload.isNull("replyToCommentId")
            ? null : text(payload, "replyToCommentId", 128);
        if (kind.equals("moment_like")) {
            if (!like || !comment.isEmpty() || replyId != null
                || !targetKey.equals("moment:" + momentId)) conflict();
            return;
        }
        if (kind.equals("moment_comment")) {
            if (comment.trim().isEmpty() || replyId != null
                || !targetKey.equals("moment:" + momentId)) conflict();
            return;
        }
        if (like || comment.trim().isEmpty() || replyId == null
            || !targetKey.equals("comment:" + replyId)) conflict();
    }

    private static void validateRelationship(
        String targetKey,
        String targetRevision,
        JSONObject payload,
        String expectedRoleId
    ) {
        exactKeys(payload, RELATIONSHIP_KEYS);
        JSONObject base = nullableObject(payload, "baseAction");
        JSONObject phase = nullableObject(payload, "phaseAction");
        if (base == null && phase == null) conflict();
        long changedAt = safeInteger(payload.opt("changedAt"), 0L);
        safeInteger(payload.opt("expectedSceneRevision"), 0L);
        text(payload, "label", 256);
        if (base != null) validateRelationshipPart(base, BASE_RELATIONSHIP_KEYS,
            "explicitMutualChange", changedAt);
        if (phase != null) validateRelationshipPart(phase, PHASE_RELATIONSHIP_KEYS,
            "explicitAcknowledgedChange", changedAt);
        if (!targetKey.startsWith("relationship:")
            || targetKey.length() <= "relationship:".length()
            || (expectedRoleId != null && !targetKey.equals("relationship:" + expectedRoleId))
            || !shaRevision(targetRevision)) conflict();
    }

    private static void validateRelationshipPart(
        JSONObject value,
        Set<String> keys,
        String booleanKey,
        long changedAt
    ) {
        exactKeys(value, keys);
        text(value, "from", 128);
        text(value, "to", 128);
        text(value, "label", 256);
        text(value, "reason", 2000);
        Object confidenceValue = value.opt("confidence");
        if (!(confidenceValue instanceof Number)) conflict();
        double confidence = ((Number) confidenceValue).doubleValue();
        if (!Double.isFinite(confidence) || confidence < 0d || confidence > 1d
            || !(value.opt(booleanKey) instanceof Boolean)
            || safeInteger(value.opt("changedAt"), 0L) != changedAt) conflict();
        JSONArray evidence = value.optJSONArray("evidenceMessageIds");
        if (evidence == null || evidence.length() > 64) conflict();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < evidence.length(); index += 1) {
            Object id = evidence.opt(index);
            if (!(id instanceof String) || ((String) id).isEmpty()
                || ((String) id).length() > 128 || !seen.add((String) id)) conflict();
        }
    }

    private static void validateRolePlan(
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload,
        String expectedLineageKey
    ) {
        String op = text(payload, "op", 32);
        if (!kind.equals("role_plan_" + op)
            || !set("create", "update", "cancel", "pause", "resume", "complete").contains(op)) {
            conflict();
        }
        if (op.equals("create")) {
            allowedAndRequired(payload, PLAN_CREATE_ALLOWED, PLAN_CREATE_REQUIRED);
            validatePlanSemanticFields(payload, true);
            if (!targetKey.matches("lineage_create:[A-Za-z0-9._:-]+:role_plan_create")
                || (expectedLineageKey != null
                    && !targetKey.equals("lineage_create:" + expectedLineageKey + ":role_plan_create"))
                || !positiveDecimalRevision(targetRevision)) conflict();
            return;
        }
        String planId = text(payload, "planId", 96);
        if (op.equals("update")) {
            allowedAndRequired(payload, PLAN_UPDATE_KEYS, PLAN_UPDATE_REQUIRED);
            JSONObject patch = payload.optJSONObject("patch");
            if (patch == null || keysOf(patch).isEmpty()
                || !PLAN_PATCH_ALLOWED.containsAll(keysOf(patch))) conflict();
            validatePlanSemanticFields(patch, false);
            if (patch.has("schedule") && !patch.has("timeConfidence")) conflict();
            if (payload.has("reason")) optionalText(payload, "reason", 240);
        } else {
            allowedAndRequired(payload, PLAN_TERMINAL_ALLOWED, PLAN_TERMINAL_REQUIRED);
            if (payload.has("reason")) optionalText(payload, "reason", 240);
        }
        if (!targetKey.equals("role_plan:" + planId) || !shaRevision(targetRevision)) conflict();
    }

    private static void validatePlanSemanticFields(JSONObject value, boolean create) {
        if (value.has("type")) enumText(value, "type", set("private_message", "moment_post", "role_schedule"));
        if (value.has("source")) enumText(value, "source", set("spoken", "accepted_request", "private_decision", "user_created"));
        if (value.has("timeConfidence")) enumText(value, "timeConfidence", set("explicit", "inferred"));
        if (value.has("origin")) enumText(value, "origin", set("ai", "user"));
        if (value.has("planId")) text(value, "planId", 96);
        if (value.has("title")) text(value, "title", 80);
        if (value.has("intent")) text(value, "intent", 600);
        if (value.has("sourceQuote")) optionalText(value, "sourceQuote", 240);
        if (value.has("durationMs")) safeInteger(value.opt("durationMs"), 1L);
        if (value.has("evidenceMessageIds")) stringArray(value.optJSONArray("evidenceMessageIds"), 12, 96);
        if (value.has("schedule")) validateSchedule(value.optJSONObject("schedule"));
        if (create && (!value.has("type") || !value.has("source") || !value.has("title")
            || !value.has("intent") || !value.has("schedule") || !value.has("timeConfidence"))) {
            conflict();
        }
    }

    private static void validateSchedule(JSONObject value) {
        if (value == null) conflict();
        String kind = text(value, "kind", 32);
        Set<String> expected;
        if (kind.equals("once")) expected = optionalKeys(set("kind", "at"), "endsAt", value);
        else if (kind.equals("interval")) expected = optionalKeys(set("kind", "startsAt", "intervalMs"), "endsAt", value);
        else if (kind.equals("daily")) expected = optionalKeys(set("kind", "time"), "endsAt", value);
        else if (kind.equals("weekly")) expected = optionalKeys(set("kind", "weekdays", "time"), "endsAt", value);
        else if (kind.equals("monthly")) expected = optionalKeys(set("kind", "day", "time"), "endsAt", value);
        else { conflict(); return; }
        exactKeys(value, expected);
        if (value.has("endsAt")) text(value, "endsAt", 128);
        if (kind.equals("once")) text(value, "at", 128);
        if (kind.equals("interval")) {
            text(value, "startsAt", 128);
            safeInteger(value.opt("intervalMs"), 300000L);
        }
        if (kind.equals("daily") || kind.equals("weekly") || kind.equals("monthly")) {
            if (!text(value, "time", 16).matches("(?:[01]?\\d|2[0-3]):[0-5]\\d")) conflict();
        }
        if (kind.equals("weekly")) {
            JSONArray weekdays = value.optJSONArray("weekdays");
            if (weekdays == null || weekdays.length() == 0 || weekdays.length() > 7) conflict();
            Set<Long> seen = new HashSet<>();
            for (int index = 0; index < weekdays.length(); index += 1) {
                long day = safeInteger(weekdays.opt(index), 0L);
                if (day > 6 || !seen.add(day)) conflict();
            }
        }
        if (kind.equals("monthly")) {
            long day = safeInteger(value.opt("day"), 1L);
            if (day > 31) conflict();
        }
    }

    private static Set<String> optionalKeys(Set<String> required, String optional, JSONObject value) {
        Set<String> result = new HashSet<>(required);
        if (value.has(optional)) result.add(optional);
        return result;
    }

    private static JSONObject nullableObject(JSONObject value, String key) {
        if (!value.has(key) || value.isNull(key)) return null;
        Object raw = value.opt(key);
        if (!(raw instanceof JSONObject)) conflict();
        return (JSONObject) raw;
    }

    private static void stringArray(JSONArray value, int maxItems, int maxLength) {
        if (value == null || value.length() > maxItems) conflict();
        for (int index = 0; index < value.length(); index += 1) {
            Object item = value.opt(index);
            if (!(item instanceof String) || ((String) item).isEmpty()
                || ((String) item).length() > maxLength) conflict();
        }
    }

    private static void enumText(JSONObject value, String key, Set<String> allowed) {
        if (!allowed.contains(text(value, key, 64))) conflict();
    }

    private static String optionalText(JSONObject value, String key, int maxLength) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).length() > maxLength) conflict();
        return (String) raw;
    }

    private static String text(JSONObject value, String key, int maxLength) {
        String result = optionalText(value, key, maxLength);
        if (result.isEmpty()) conflict();
        return result;
    }

    private static long safeInteger(Object raw, long min) {
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) conflict();
        long value = ((Number) raw).longValue();
        if (value < min || value > MAX_SAFE_INTEGER) conflict();
        return value;
    }

    private static boolean shaRevision(String value) {
        return value != null && value.matches("sha256:[a-f0-9]{64}");
    }

    private static boolean positiveDecimalRevision(String value) {
        if (value == null || !value.matches("[1-9][0-9]{0,15}")) return false;
        try {
            long parsed = Long.parseLong(value);
            return parsed > 0 && parsed <= MAX_SAFE_INTEGER;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    private static void allowedAndRequired(JSONObject value, Set<String> allowed, Set<String> required) {
        Set<String> keys = keysOf(value);
        if (!allowed.containsAll(keys) || !keys.containsAll(required)) conflict();
    }

    private static void exactKeys(JSONObject value, Set<String> expected) {
        if (value == null || !expected.equals(keysOf(value))) conflict();
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> result = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) result.add(keys.next());
        return result;
    }

    private static Set<String> set(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }

    private static void conflict() {
        throw new IllegalArgumentException("local fallback action authority conflict");
    }
}
