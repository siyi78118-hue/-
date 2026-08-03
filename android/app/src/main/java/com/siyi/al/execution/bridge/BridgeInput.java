package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.TurnKind;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeInput {
    private static final Set<String> CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome"
    ));
    private static final Set<String> OUTCOME_KEYS = new HashSet<>(Arrays.asList(
        "type", "route", "relayMessageId", "failure", "result", "redactedAt"
    ));
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

    static JSONObject currentBatchMessage(JSONObject supplied, String characterId) throws Exception {
        JSONObject message = new JSONObject(supplied.toString());
        String messageId = wireMessageId(message.optString("messageId", ""));
        message.put("messageId", messageId);
        message.put("speakerId", "user");
        message.put("speakerType", "user");
        message.put("recipientId", characterId);
        JSONArray attachments = message.optJSONArray("attachments");
        if (attachments != null) {
            for (int index = 0; index < attachments.length(); index += 1) {
                attachments.getJSONObject(index).put("messageId", messageId);
            }
        }
        return message;
    }

    static long deviceSeq(TurnSubmission submission) throws Exception {
        return source(submission).optLong("deviceSeq", Math.max(1L, submission.createdAt));
    }

    static String wireTurnId(TurnSubmission submission) {
        return wireTurnId(submission.turnId, submission.kind);
    }

    public static String wireTurnId(String localTurnId, TurnKind kind) {
        return localTurnId.startsWith("turn_")
            ? localTurnId
            : (kind == TurnKind.DIRECT_REPLY ? localTurnId : "turn_" + localTurnId);
    }

    public static String rootSourceId(TurnSubmission submission) throws Exception {
        if (submission.kind == TurnKind.DIRECT_REPLY) {
            return userMessage(submission).getString("messageId");
        }
        return submission.sourceMessageId.startsWith("trigger_")
            ? submission.sourceMessageId
            : "trigger_" + submission.sourceMessageId;
    }

    public static String laneKey(TurnSubmission submission) throws Exception {
        switch (submission.kind) {
            case DIRECT_REPLY:
            case PROACTIVE_CHAT:
            case ROLE_PLAN_CHAT:
            case ROLE_PLAN_CHAT_PRIVATE:
                return "private_chat";
            case PROACTIVE_MOMENT:
            case ROLE_PLAN_MOMENT:
            case ROLE_PLAN_MOMENT_PRIVATE:
                return "public_moment";
            case MOMENT_INTERACTION:
            case MOMENT_REPLY:
                String momentId = authoritativeMomentId(submission);
                if (momentId == null) {
                    throw new IllegalArgumentException("moment interaction requires an authoritative moment id");
                }
                return "moment_interaction:" + momentId;
            default:
                throw new IllegalArgumentException("no interaction lane for " + submission.kind);
        }
    }

    public static String authoritativeMomentId(TurnSubmission submission) throws Exception {
        JSONObject input = source(submission);
        JSONObject snapshot = new JSONObject(submission.snapshotJson);
        String momentId = momentId(input);
        return momentId == null ? momentId(snapshot) : momentId;
    }

    private static String momentId(JSONObject value) {
        String direct = value.optString("momentId", "").trim();
        if (!direct.isEmpty()) return direct;
        JSONObject target = value.optJSONObject("targetMoment");
        if (target != null && !target.optString("momentId", "").trim().isEmpty()) {
            return target.optString("momentId").trim();
        }
        JSONObject moment = value.optJSONObject("moment");
        if (moment != null && !moment.optString("momentId", "").trim().isEmpty()) {
            return moment.optString("momentId").trim();
        }
        JSONObject context = value.optJSONObject("context");
        return context == null ? null : momentId(context);
    }

    static JSONObject envelope(TurnSubmission submission, BridgeConfig config) throws Exception {
        if (submission.bridgeAuthorityCheckpointJson != null) {
            return preparedV3Envelope(submission, config);
        }
        return legacyV2Envelope(submission, config.deviceId);
    }

    private static JSONObject legacyV2Envelope(TurnSubmission submission, String deviceId) throws Exception {
        String wireTurnId = wireTurnId(submission);
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 2)
            .put("turnId", wireTurnId)
            .put("characterId", submission.characterId)
            .put("deviceId", deviceId)
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
            JSONObject suppliedRetry = input.optJSONObject("retry");
            if (suppliedRetry != null) {
                context.put("retry", new JSONObject(suppliedRetry.toString()));
            }
            JSONArray suppliedMessageIds = options == null ? null : options.optJSONArray("batchMessageIds");
            JSONArray messageIds = new JSONArray();
            if (suppliedMessageIds != null) {
                for (int index = 0; index < suppliedMessageIds.length(); index += 1) {
                    messageIds.put(wireMessageId(suppliedMessageIds.optString(index, "")));
                }
            }
            String currentMessageId = envelope.getJSONObject("message").getString("messageId");
            if (messageIds.length() == 0) messageIds.put(currentMessageId);
            long messageSentAt = envelope.getJSONObject("message").getLong("sentAt");
            JSONObject currentBatch = new JSONObject()
                .put("batchId", options == null
                    ? "batch_" + currentMessageId
                    : options.optString("batchId", "batch_" + currentMessageId))
                .put("messageIds", messageIds)
                .put("startedAt", options == null
                    ? messageSentAt
                    : options.optLong("batchStartedAt", messageSentAt))
                .put("committedAt", options == null
                    ? submission.createdAt
                    : options.optLong("batchCommittedAt", submission.createdAt));
            JSONArray suppliedBatchMessages = options == null ? null : options.optJSONArray("batchMessages");
            if (suppliedBatchMessages != null && suppliedBatchMessages.length() > 0) {
                JSONArray batchMessages = new JSONArray();
                for (int index = 0; index < suppliedBatchMessages.length(); index += 1) {
                    batchMessages.put(currentBatchMessage(
                        suppliedBatchMessages.getJSONObject(index),
                        submission.characterId
                    ));
                }
                currentBatch.put("messages", batchMessages);
            }
            context.put("currentBatch", currentBatch);
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

    public static JSONObject prepareV3Envelope(
        TurnSubmission submission,
        String deviceId,
        String authoritativeTurnId,
        String laneKey,
        String rootSourceId,
        String lineageKey,
        long claimedLineageRevision,
        String retryOfTurnId,
        JSONObject visibilityCursor
    ) throws Exception {
        JSONObject envelope = legacyV2Envelope(submission, deviceId);
        envelope.put("protocolVersion", 3);
        envelope.put("turnId", authoritativeTurnId);
        envelope.put("deviceSeq", visibilityCursor.getLong("localSequence"));
        envelope.put("authority", new JSONObject()
            .put("algorithm", "al-authority-v1")
            .put("roleId", submission.characterId)
            .put("laneKey", laneKey)
            .put("rootSourceId", rootSourceId)
            .put("lineageKey", lineageKey)
            .put("claimedLineageRevision", claimedLineageRevision)
            .put("retryOfTurnId", retryOfTurnId == null ? JSONObject.NULL : retryOfTurnId));
        if (submission.kind == TurnKind.DIRECT_REPLY) {
            JSONObject context = envelope.getJSONObject("context");
            JSONObject batch = context.getJSONObject("currentBatch");
            JSONArray messages = batch.optJSONArray("messages");
            if (messages == null || messages.length() == 0) {
                messages = new JSONArray().put(new JSONObject(envelope.getJSONObject("message").toString()));
                batch.put("messages", messages);
            }
            JSONArray ids = batch.getJSONArray("messageIds");
            if (ids.length() != messages.length()) {
                throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: current batch cardinality");
            }
            for (int index = 0; index < messages.length(); index += 1) {
                JSONObject message = currentBatchMessage(messages.getJSONObject(index), submission.characterId);
                messages.put(index, message);
                if (!message.getString("messageId").equals(ids.getString(index))) {
                    throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: current batch identity");
                }
            }
            envelope.put("message", new JSONObject(messages.getJSONObject(messages.length() - 1).toString()));
            context.remove("retry");
            if (retryOfTurnId != null) {
                context.put("retry", new JSONObject()
                    .put("retryOfTurnId", retryOfTurnId)
                    .put("canonicalMessageId", rootSourceId));
            }
            context.put("visibilityCursor", new JSONObject(visibilityCursor.toString()));
        } else {
            JSONObject triggerContext = envelope.getJSONObject("trigger").optJSONObject("context");
            if (triggerContext != null) {
                JSONObject embeddedSnapshot = triggerContext.optJSONObject("snapshot");
                if (embeddedSnapshot != null) embeddedSnapshot.remove("_alBridgeProtocol");
            }
            if (submission.kind == TurnKind.MOMENT_INTERACTION
                || submission.kind == TurnKind.MOMENT_REPLY) {
                String momentId = authoritativeMomentId(submission);
                if (momentId == null) {
                    throw new IllegalArgumentException("moment interaction requires an authoritative moment id");
                }
                if (triggerContext == null) {
                    triggerContext = new JSONObject();
                    envelope.getJSONObject("trigger").put("context", triggerContext);
                }
                triggerContext.put("momentId", momentId);
            }
            envelope.put("context", new JSONObject()
                .put("visibilityCursor", new JSONObject(visibilityCursor.toString())));
        }
        return envelope;
    }

    private static JSONObject preparedV3Envelope(TurnSubmission submission, BridgeConfig config) throws Exception {
        JSONObject checkpoint = new JSONObject(submission.bridgeAuthorityCheckpointJson);
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = checkpoint.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        if (!CHECKPOINT_KEYS.equals(keys)
            || exactSafeInteger(checkpoint, "version", false) != 1L
            || exactSafeInteger(checkpoint, "attemptSequence", true) <= 0L
            || exactSafeInteger(checkpoint, "claimedLineageRevision", true) <= 0L
            || exactSafeInteger(checkpoint, "inputVisibilitySequence", true) <= 0L
            || exactSafeInteger(checkpoint, "inputClearEpoch", false) < 0L
            || !submission.turnId.equals(checkpoint.getString("localTurnId"))
            || !submission.authoritativeTurnId.equals(checkpoint.getString("authoritativeTurnId"))) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: checkpoint identity");
        }
        JSONObject outcome = checkpoint.getJSONObject("outcome");
        if (!OUTCOME_KEYS.equals(keysOf(outcome))
            || !(outcome.opt("type") instanceof String)
            || !"open".equals(outcome.getString("type"))
            || outcome.opt("route") != JSONObject.NULL
            || outcome.opt("relayMessageId") != JSONObject.NULL
            || outcome.opt("failure") != JSONObject.NULL
            || outcome.opt("result") != JSONObject.NULL
            || outcome.opt("redactedAt") != JSONObject.NULL) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: checkpoint outcome");
        }
        JSONObject envelope = checkpoint.getJSONObject("normalizedEnvelope");
        JSONObject authority = envelope.getJSONObject("authority");
        JSONObject cursor = envelope.getJSONObject("context").getJSONObject("visibilityCursor");
        if (exactSafeInteger(envelope, "protocolVersion", false) != 3L
            || exactSafeInteger(envelope, "deviceSeq", true)
                != exactSafeInteger(checkpoint, "inputVisibilitySequence", true)
            || exactSafeInteger(envelope, "createdAt", true) <= 0L
            || exactSafeInteger(authority, "claimedLineageRevision", true)
                != exactSafeInteger(checkpoint, "claimedLineageRevision", true)
            || exactSafeInteger(cursor, "localSequence", true)
                != exactSafeInteger(checkpoint, "inputVisibilitySequence", true)
            || exactSafeInteger(cursor, "clearEpoch", false)
                != exactSafeInteger(checkpoint, "inputClearEpoch", false)
            || !submission.authoritativeTurnId.equals(envelope.getString("turnId"))
            || !config.deviceId.equals(envelope.getString("deviceId"))
            || !checkpoint.getString("envelopeChecksum").equals(BridgeAuthority.sha256CanonicalJson(envelope))) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: pinned envelope");
        }
        return new JSONObject(envelope.toString());
    }

    private static long exactSafeInteger(JSONObject value, String key, boolean positive) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: integer field");
        }
        long number = ((Number) raw).longValue();
        if ((positive ? number <= 0L : number < 0L) || number > 9007199254740991L) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT: integer range");
        }
        return number;
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }
}
