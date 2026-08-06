package com.siyi.al.execution;

import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeReceiptCheckpoint {
    private static final Set<String> AUTHORITY_CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome"));
    private static final Set<String> AUTHORITY_OUTCOME_KEYS = new HashSet<>(Arrays.asList(
        "type", "route", "relayMessageId", "failure", "result", "redactedAt"));
    private static final Set<String> LOCAL_AUTHORITY_CHECKPOINT_KEYS = new HashSet<>(Arrays.asList(
        "version", "localTurnId", "attemptId", "attemptSequence",
        "authoritativeTurnId", "authorityLineageKey", "claimedLineageRevision",
        "retryOfTurnId", "laneKey", "inputVisibilitySequence", "inputClearEpoch",
        "normalizedEnvelope", "envelopeChecksum", "outcome", "fallbackExecution",
        "journalSyncSeq"));
    private static final Set<String> LOCAL_RECEIPT_KEYS = new HashSet<>(Arrays.asList(
        "receiptVersion", "semantic", "manifest", "commitChecksum"));
    private static final Set<String> LOCAL_MANIFEST_KEYS = new HashSet<>(Arrays.asList(
        "payloadVersion", "authorityOrigin", "semantic", "commitChecksum"));
    private static final Set<String> LOCAL_SEMANTIC_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "contract", "authorityOrigin", "roleId", "laneKey",
        "rootSourceId", "authorityLineageKey", "authoritativeTurnId",
        "lineageRevisionAtCreation", "retryOfTurnId", "turnRevision", "deviceId",
        "turnKind", "terminalDisposition", "input", "compactSemanticSnapshot",
        "agencySnapshotChecksum", "visibleGroupId", "replyItems", "visibleItems",
        "actions", "release", "journalSyncSeq"));
    private static final Set<String> LOCAL_RELEASE_KEYS = new HashSet<>(Arrays.asList(
        "releaseId", "contract", "codecVersion", "contractChecksum", "releaseChecksum"));
    private static final Set<String> LOCAL_SNAPSHOT_KEYS = new HashSet<>(Arrays.asList(
        "contract", "schemaVersion", "roleId", "hardConstraints", "preferences",
        "currentStances", "relationship", "recentGroups", "verifiedFacts",
        "lifeSignals", "authorSettings"));
    private static final Set<String> LOCAL_REPLY_ITEM_KEYS = new HashSet<>(Arrays.asList(
        "ordinal", "messageId", "message", "checksum"));
    private static final Set<String> LOCAL_MESSAGE_KEYS = new HashSet<>(Arrays.asList(
        "messageId", "speakerId", "speakerType", "recipientId", "content",
        "sentAt", "attachments"));
    private static final Set<String> LOCAL_MESSAGE_KEYS_WITHOUT_ATTACHMENTS = new HashSet<>(Arrays.asList(
        "messageId", "speakerId", "speakerType", "recipientId", "content", "sentAt"));
    private static final Set<String> LOCAL_IMAGE_ATTACHMENT_KEYS = new HashSet<>(Arrays.asList(
        "attachmentId", "messageId", "kind", "mime", "name", "width", "height",
        "bytes", "dataUrl"));
    private static final Set<String> LOCAL_ACTION_KEYS = new HashSet<>(Arrays.asList(
        "actionId", "ordinal", "kind", "targetKey", "targetRevision", "payload",
        "checksum"));
    private static final Set<String> LOCAL_DIRECT_INPUT_KEYS = new HashSet<>(Arrays.asList(
        "kind", "batch", "visibilitySequence", "clearEpoch", "checksum"));
    private static final Set<String> LOCAL_DIRECT_INPUT_KEYS_WITH_CONTEXT = new HashSet<>(Arrays.asList(
        "kind", "batch", "pinnedActionContext", "visibilitySequence", "clearEpoch", "checksum"));
    private static final Set<String> LOCAL_AUTOMATIC_INPUT_KEYS = new HashSet<>(Arrays.asList(
        "kind", "trigger", "visibilitySequence", "clearEpoch", "checksum"));
    private static final Set<String> LOCAL_BATCH_KEYS = new HashSet<>(Arrays.asList(
        "batchId", "characterId", "sourceMessageId", "startedAt", "committedAt",
        "checksum", "items"));
    private static final Set<String> LOCAL_BATCH_ITEM_KEYS = new HashSet<>(Arrays.asList(
        "sequence", "messageId", "message", "checksum"));
    private static final Set<String> LOCAL_TRIGGER_KEYS = new HashSet<>(Arrays.asList(
        "triggerId", "triggerType", "scheduledFor", "executedAt", "context"));
    private static final Set<String> LOCAL_DISPOSITIONS = new HashSet<>(Arrays.asList(
        "visible", "action_only", "skip"));

    private BridgeReceiptCheckpoint() {}

    public static boolean mayReadLegacyMemoryResult(Integer bridgeProtocolVersion) {
        return bridgeProtocolVersion == null || bridgeProtocolVersion != 3;
    }

    public static JSONObject extract(String memoryResult) {
        if (memoryResult == null || !memoryResult.trim().startsWith("{")) return null;
        try {
            JSONObject checkpoint = new JSONObject(memoryResult);
            Object value = checkpoint.opt("bridgeResponse");
            JSONObject response;
            if (value instanceof JSONObject) {
                response = (JSONObject) value;
            } else if (value instanceof String && ((String) value).trim().startsWith("{")) {
                response = new JSONObject((String) value);
            } else {
                return null;
            }
            Object protocolVersion = response.opt("protocolVersion");
            if (protocolVersion instanceof Number
                    && !(protocolVersion instanceof Float)
                    && !(protocolVersion instanceof Double)
                    && ((Number) protocolVersion).longValue() == 3L) {
                JSONObject semantic = new JSONObject(response.toString());
                String route = semantic.has("_deliveryRoute")
                    ? requireNonEmptyString(semantic, "_deliveryRoute")
                    : requireNonEmptyString(checkpoint, "origin");
                String relayMessageId = semantic.has("_relayMessageId")
                    ? requireNonEmptyString(semantic, "_relayMessageId")
                    : null;
                semantic.remove("_deliveryRoute");
                semantic.remove("_relayMessageId");
                BridgeResult result = BridgeTurnStatus.parseV3(
                    semantic.toString(), route, relayMessageId);
                if (result.kind != BridgeResult.Kind.CANONICAL_TERMINAL) return null;
                JSONObject extracted = result.authorityPayload();
                extracted.put("_deliveryRoute", result.deliveryRoute);
                if (result.relayMessageId != null) {
                    extracted.put("_relayMessageId", result.relayMessageId);
                }
                return extracted;
            }
            if (response.has("protocolVersion")) return null;
            if (!response.has("deliveryItems")
                    && response.optString("_relayMessageId", "").trim().isEmpty()) return null;
            if (!response.has("_deliveryRoute")) {
                response.put("_deliveryRoute", checkpoint.optString("origin", ""));
            }
            return response;
        } catch (Exception ignored) {
            return null;
        }
    }

    public static JSONObject extractAuthorityReceiptFromV12Checkpoint(
        String checkpointJson,
        String checkpointChecksum
    ) {
        if (checkpointJson == null || checkpointChecksum == null) return null;
        try {
            JSONObject checkpoint = new JSONObject(checkpointJson);
            Object version = checkpoint.opt("version");
            if (!AUTHORITY_CHECKPOINT_KEYS.equals(keysOf(checkpoint))
                || !(version instanceof Number)
                || version instanceof Float
                || version instanceof Double
                || ((Number) version).longValue() != 1L
                || !checkpointChecksum.equals(BridgeAuthority.sha256CanonicalJson(checkpoint))) {
                return null;
            }
            JSONObject outcome = checkpoint.optJSONObject("outcome");
            if (outcome == null
                || !AUTHORITY_OUTCOME_KEYS.equals(keysOf(outcome))
                || !"committed".equals(outcome.opt("type"))
                || outcome.opt("failure") != JSONObject.NULL
                || outcome.opt("redactedAt") != JSONObject.NULL) {
                return null;
            }
            Object routeValue = outcome.opt("route");
            if (!(routeValue instanceof String)) return null;
            String route = (String) routeValue;
            Object relayValue = outcome.opt("relayMessageId");
            String relay = relayValue == JSONObject.NULL
                ? null : requireNonEmptyString(outcome, "relayMessageId");
            if (!("lan".equals(route) || "cloud".equals(route))
                || ("lan".equals(route) && relay != null)
                || ("cloud".equals(route) && relay == null)) {
                return null;
            }
            JSONObject resultJson = outcome.optJSONObject("result");
            if (resultJson == null) return null;
            BridgeResult result = BridgeTurnStatus.parseV3(
                BridgeAuthority.canonicalJson(resultJson), route, relay);
            if (result.kind != BridgeResult.Kind.CANONICAL_TERMINAL) return null;
            JSONObject extracted = result.authorityPayload();
            extracted.put("_deliveryRoute", route);
            if (relay != null) extracted.put("_relayMessageId", relay);
            return extracted;
        } catch (Exception ignored) {
            return null;
        }
    }

    public static JSONObject extractLocalAuthorityReceipt(
        String checkpointJson,
        String checkpointChecksum
    ) {
        if (checkpointJson == null || checkpointChecksum == null) return null;
        try {
            JSONObject checkpoint = new JSONObject(checkpointJson);
            if (!LOCAL_AUTHORITY_CHECKPOINT_KEYS.equals(keysOf(checkpoint))
                || exactInteger(checkpoint.opt("version")) != 2L
                || exactInteger(checkpoint.opt("journalSyncSeq")) <= 0L
                || !checkpointChecksum.equals(BridgeAuthority.sha256CanonicalJson(checkpoint))) {
                return null;
            }
            JSONObject outcome = checkpoint.optJSONObject("outcome");
            if (outcome == null || !AUTHORITY_OUTCOME_KEYS.equals(keysOf(outcome))
                || !"committed".equals(outcome.opt("type"))
                || !"local".equals(outcome.opt("route"))
                || outcome.opt("relayMessageId") != JSONObject.NULL
                || outcome.opt("failure") != JSONObject.NULL
                || outcome.opt("redactedAt") != JSONObject.NULL) {
                return null;
            }
            JSONObject receipt = outcome.optJSONObject("result");
            if (receipt == null || !LOCAL_RECEIPT_KEYS.equals(keysOf(receipt))
                || exactInteger(receipt.opt("receiptVersion")) != 2L) {
                return null;
            }
            JSONObject semantic = receipt.optJSONObject("semantic");
            JSONObject manifest = receipt.optJSONObject("manifest");
            Object checksum = receipt.opt("commitChecksum");
            if (semantic == null || manifest == null
                || !LOCAL_SEMANTIC_KEYS.equals(keysOf(semantic))
                || !LOCAL_MANIFEST_KEYS.equals(keysOf(manifest))
                || !(checksum instanceof String)
                || !((String) checksum).matches("[a-f0-9]{64}")
                || exactInteger(semantic.opt("journalSyncSeq"))
                    != exactInteger(checkpoint.opt("journalSyncSeq"))
                || !checkpoint.getString("authorityLineageKey").equals(
                    semantic.optString("authorityLineageKey", checkpoint.getString("authorityLineageKey")))
                || !((String) checksum).equals(BridgeAuthority.sha256CanonicalJson(semantic))
                || !((String) checksum).equals(manifest.optString("commitChecksum", ""))
                || !BridgeAuthority.canonicalJson(semantic).equals(
                    BridgeAuthority.canonicalJson(manifest.optJSONObject("semantic")))) {
                return null;
            }
            validateLocalSemantic(checkpoint, semantic);
            return new JSONObject(receipt.toString());
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void validateLocalSemantic(JSONObject checkpoint, JSONObject semantic) throws Exception {
        if (exactInteger(semantic.opt("protocolVersion")) != 2L
            || !"android-fallback-authority-v2".equals(semantic.opt("contract"))
            || !"android_fallback".equals(semantic.opt("authorityOrigin"))) {
            throw new IllegalArgumentException("local authority contract conflict");
        }
        String roleId = requireNonEmptyString(semantic, "roleId");
        String laneKey = requireNonEmptyString(semantic, "laneKey");
        String rootSourceId = requireNonEmptyString(semantic, "rootSourceId");
        String lineageKey = requireNonEmptyString(semantic, "authorityLineageKey");
        String turnId = requireNonEmptyString(semantic, "authoritativeTurnId");
        if (!AuthorityIdentity.lineageKey(roleId, laneKey, rootSourceId).equals(lineageKey)
            || !AuthorityIdentity.groupId(lineageKey).equals(
                requireNonEmptyString(semantic, "visibleGroupId"))
            || !checkpoint.getString("authorityLineageKey").equals(lineageKey)
            || !checkpoint.getString("authoritativeTurnId").equals(turnId)
            || !checkpoint.getString("laneKey").equals(laneKey)
            || exactInteger(semantic.opt("lineageRevisionAtCreation")) < 1L
            || exactInteger(semantic.opt("lineageRevisionAtCreation"))
                != exactInteger(checkpoint.opt("claimedLineageRevision"))
            || exactInteger(semantic.opt("turnRevision")) < 1L
            || exactInteger(semantic.opt("turnRevision"))
                != exactInteger(checkpoint.opt("attemptSequence"))) {
            throw new IllegalArgumentException("local authority identity conflict");
        }
        Object retry = semantic.opt("retryOfTurnId");
        Object checkpointRetry = checkpoint.opt("retryOfTurnId");
        if (!sameNullableText(retry, checkpointRetry)) {
            throw new IllegalArgumentException("local authority retry conflict");
        }
        String deviceId = requireNonEmptyString(semantic, "deviceId");
        String turnKind = requireNonEmptyString(semantic, "turnKind");
        JSONObject envelope = checkpoint.getJSONObject("normalizedEnvelope");
        if (!deviceId.equals(requireNonEmptyString(envelope, "deviceId"))) {
            throw new IllegalArgumentException("local authority device conflict");
        }
        String disposition = requireNonEmptyString(semantic, "terminalDisposition");
        if (!LOCAL_DISPOSITIONS.contains(disposition)
            || ("DIRECT_REPLY".equals(turnKind) && "skip".equals(disposition))) {
            throw new IllegalArgumentException("local authority disposition conflict");
        }

        JSONObject input = semantic.getJSONObject("input");
        validateLocalInput(input, roleId, envelope, semantic.getJSONArray("actions"));
        if (exactInteger(input.opt("visibilitySequence"))
                != exactInteger(checkpoint.opt("inputVisibilitySequence"))
            || exactInteger(input.opt("clearEpoch"))
                != exactInteger(checkpoint.opt("inputClearEpoch"))) {
            throw new IllegalArgumentException("local authority input cursor conflict");
        }

        JSONObject snapshot = semantic.getJSONObject("compactSemanticSnapshot");
        if (!LOCAL_SNAPSHOT_KEYS.equals(keysOf(snapshot))
            || !"cognition-v3".equals(snapshot.opt("contract"))
            || exactInteger(snapshot.opt("schemaVersion")) != 3L
            || !roleId.equals(snapshot.opt("roleId"))
            || !BridgeAuthority.sha256CanonicalJson(snapshot).equals(
                requireChecksum(semantic, "agencySnapshotChecksum"))) {
            throw new IllegalArgumentException("local authority snapshot conflict");
        }

        JSONArray replyItems = semantic.getJSONArray("replyItems");
        JSONArray visibleItems = semantic.getJSONArray("visibleItems");
        JSONArray actions = semantic.getJSONArray("actions");
        validateLocalReplyItems(replyItems, visibleItems, roleId,
            semantic.getString("visibleGroupId"));
        validateLocalActions(
            actions,
            semantic.getString("visibleGroupId"),
            roleId,
            semantic.getString("authorityLineageKey"),
            exactInteger(checkpoint.opt("claimedLineageRevision")),
            envelope);
        if (("visible".equals(disposition) && replyItems.length() < 1)
            || ("action_only".equals(disposition)
                && (replyItems.length() != 0 || actions.length() < 1))
            || ("skip".equals(disposition)
                && (replyItems.length() != 0 || actions.length() != 0))) {
            throw new IllegalArgumentException("local authority result shape conflict");
        }
        validateLocalRelease(semantic.getJSONObject("release"));
        if (exactInteger(semantic.opt("journalSyncSeq")) <= 0L) {
            throw new IllegalArgumentException("local authority journal conflict");
        }
    }

    private static void validateLocalInput(
        JSONObject input,
        String roleId,
        JSONObject normalizedEnvelope,
        JSONArray actions
    ) throws Exception {
        String kind = requireNonEmptyString(input, "kind");
        if (exactInteger(input.opt("visibilitySequence")) < 0L
            || exactInteger(input.opt("clearEpoch")) < 0L) {
            throw new IllegalArgumentException("local authority input cursor conflict");
        }
        requireChecksum(input, "checksum");
        if ("direct".equals(kind)) {
            boolean carriesContext = input.opt("pinnedActionContext") instanceof JSONObject;
            Set<String> expectedKeys = carriesContext
                ? LOCAL_DIRECT_INPUT_KEYS_WITH_CONTEXT : LOCAL_DIRECT_INPUT_KEYS;
            if (!expectedKeys.equals(keysOf(input))
                || (actions.length() == 0 && carriesContext)
                || (actions.length() > 0 && (!carriesContext
                    || !BridgeAuthority.canonicalJson(
                        LocalFallbackActionAuthority.receiptActionContext(
                            normalizedEnvelope, actions)).equals(
                        BridgeAuthority.canonicalJson(
                            input.getJSONObject("pinnedActionContext")))))) {
                throw new IllegalArgumentException("local authority direct input conflict");
            }
            JSONObject batch = input.getJSONObject("batch");
            if (!LOCAL_BATCH_KEYS.equals(keysOf(batch))
                || !roleId.equals(batch.opt("characterId"))
                || exactInteger(batch.opt("startedAt")) < 0L
                || exactInteger(batch.opt("committedAt")) < 0L
                || exactInteger(batch.opt("committedAt")) < exactInteger(batch.opt("startedAt"))) {
                throw new IllegalArgumentException("local authority batch conflict");
            }
            String batchId = requireNonEmptyString(batch, "batchId");
            String sourceMessageId = requireNonEmptyString(batch, "sourceMessageId");
            JSONArray items = batch.getJSONArray("items");
            if (items.length() == 0) throw new IllegalArgumentException("local authority batch conflict");
            JSONArray messageIds = new JSONArray();
            for (int ordinal = 0; ordinal < items.length(); ordinal += 1) {
                JSONObject item = items.getJSONObject(ordinal);
                if (!LOCAL_BATCH_ITEM_KEYS.equals(keysOf(item))
                    || exactInteger(item.opt("sequence")) != ordinal) {
                    throw new IllegalArgumentException("local authority batch item conflict");
                }
                String messageId = requireNonEmptyString(item, "messageId");
                JSONObject message = item.getJSONObject("message");
                validateLocalMessage(message, messageId, "user", "user", roleId, true);
                if (!requireChecksum(item, "checksum").equals(
                    BridgeAuthority.sha256CanonicalJson(message))) {
                    throw new IllegalArgumentException("local authority batch message conflict");
                }
                messageIds.put(messageId);
            }
            JSONObject header = new JSONObject()
                .put("batchId", batchId)
                .put("sourceMessageId", sourceMessageId)
                .put("messageIds", messageIds)
                .put("startedAt", batch.getLong("startedAt"))
                .put("committedAt", batch.getLong("committedAt"));
            String batchChecksum = requireChecksum(batch, "checksum");
            if (!batchChecksum.equals(BridgeAuthority.sha256CanonicalJson(header))
                || !batchChecksum.equals(input.getString("checksum"))) {
                throw new IllegalArgumentException("local authority batch commitment conflict");
            }
            return;
        }
        if (!"automatic".equals(kind) || !LOCAL_AUTOMATIC_INPUT_KEYS.equals(keysOf(input))) {
            throw new IllegalArgumentException("local authority automatic input conflict");
        }
        JSONObject trigger = input.getJSONObject("trigger");
        if (!LOCAL_TRIGGER_KEYS.equals(keysOf(trigger))
            || exactInteger(trigger.opt("scheduledFor")) < 0L
            || exactInteger(trigger.opt("executedAt")) < 0L
            || !(trigger.opt("context") instanceof JSONObject)) {
            throw new IllegalArgumentException("local authority trigger conflict");
        }
        requireNonEmptyString(trigger, "triggerId");
        requireNonEmptyString(trigger, "triggerType");
        JSONObject basis = new JSONObject(input.toString());
        basis.remove("checksum");
        if (!input.getString("checksum").equals(BridgeAuthority.sha256CanonicalJson(basis))) {
            throw new IllegalArgumentException("local authority trigger checksum conflict");
        }
    }

    private static void validateLocalReplyItems(
        JSONArray replyItems,
        JSONArray visibleItems,
        String roleId,
        String groupId
    ) throws Exception {
        if (replyItems.length() != visibleItems.length()) {
            throw new IllegalArgumentException("local authority visible projection conflict");
        }
        for (int ordinal = 0; ordinal < replyItems.length(); ordinal += 1) {
            JSONObject item = replyItems.getJSONObject(ordinal);
            if (!LOCAL_REPLY_ITEM_KEYS.equals(keysOf(item))
                || exactInteger(item.opt("ordinal")) != ordinal) {
                throw new IllegalArgumentException("local authority reply item conflict");
            }
            String messageId = requireNonEmptyString(item, "messageId");
            if (!AuthorityIdentity.messageId(groupId, ordinal).equals(messageId)) {
                throw new IllegalArgumentException("local authority reply identity conflict");
            }
            JSONObject message = item.getJSONObject("message");
            validateLocalMessage(message, messageId, roleId, "character", "user", false);
            if (!roleId.equals(message.getString("speakerId"))
                || !requireChecksum(item, "checksum").equals(
                    BridgeAuthority.sha256CanonicalJson(message))
                || !BridgeAuthority.canonicalJson(message).equals(
                    BridgeAuthority.canonicalJson(visibleItems.getJSONObject(ordinal)))) {
                throw new IllegalArgumentException("local authority visible projection conflict");
            }
        }
    }

    private static void validateLocalMessage(
        JSONObject message,
        String messageId,
        String speakerId,
        String speakerType,
        String recipientId,
        boolean allowImageAttachment
    ) throws Exception {
        Set<String> messageKeys = keysOf(message);
        boolean keyShapeValid = allowImageAttachment
            ? LOCAL_MESSAGE_KEYS.equals(messageKeys)
                || LOCAL_MESSAGE_KEYS_WITHOUT_ATTACHMENTS.equals(messageKeys)
            : LOCAL_MESSAGE_KEYS.equals(messageKeys);
        if (!keyShapeValid
            || !messageId.equals(message.opt("messageId"))
            || !speakerId.equals(message.opt("speakerId"))
            || !speakerType.equals(message.opt("speakerType"))
            || !recipientId.equals(message.opt("recipientId"))
            || !(message.opt("content") instanceof String)
            || ((String) message.opt("content")).trim().isEmpty()
            || exactInteger(message.opt("sentAt")) < 0L
            || (message.has("attachments") && !(message.opt("attachments") instanceof JSONArray))) {
            throw new IllegalArgumentException("local authority message conflict");
        }
        JSONArray attachments = message.optJSONArray("attachments");
        if (attachments == null) return;
        if (!allowImageAttachment) {
            if (attachments.length() != 0) {
                throw new IllegalArgumentException("local authority message attachment conflict");
            }
            return;
        }
        if (attachments.length() > 1) {
            throw new IllegalArgumentException("local authority message attachment conflict");
        }
        if (attachments.length() == 1) validateLocalImageAttachment(
            attachments.getJSONObject(0), messageId);
    }

    private static void validateLocalImageAttachment(JSONObject attachment, String messageId) {
        if (!LOCAL_IMAGE_ATTACHMENT_KEYS.equals(keysOf(attachment))
            || !messageId.equals(attachment.opt("messageId"))
            || !"image".equals(attachment.opt("kind"))) {
            throw new IllegalArgumentException("local authority image attachment conflict");
        }
        String attachmentId = requireNonEmptyString(attachment, "attachmentId");
        String mime = requireNonEmptyString(attachment, "mime");
        String name = requireNonEmptyString(attachment, "name");
        if (!attachmentId.startsWith("att_")
            || !("image/jpeg".equals(mime) || "image/png".equals(mime)
                || "image/webp".equals(mime))
            || name.length() > 120
            || exactInteger(attachment.opt("width")) < 1L
            || exactInteger(attachment.opt("width")) > 8192L
            || exactInteger(attachment.opt("height")) < 1L
            || exactInteger(attachment.opt("height")) > 8192L
            || exactInteger(attachment.opt("bytes")) < 1L) {
            throw new IllegalArgumentException("local authority image attachment conflict");
        }
        String dataUrl = requireNonEmptyString(attachment, "dataUrl");
        String prefix = "data:" + mime + ";base64,";
        if (!dataUrl.startsWith(prefix)) {
            throw new IllegalArgumentException("local authority image attachment conflict");
        }
        try {
            byte[] decoded = decodeBase64(dataUrl.substring(prefix.length()));
            boolean signature = "image/jpeg".equals(mime)
                ? decoded.length >= 3 && (decoded[0] & 0xff) == 0xff
                    && (decoded[1] & 0xff) == 0xd8 && (decoded[2] & 0xff) == 0xff
                : "image/png".equals(mime)
                    ? decoded.length >= 8 && (decoded[0] & 0xff) == 0x89
                        && decoded[1] == 0x50 && decoded[2] == 0x4e && decoded[3] == 0x47
                        && decoded[4] == 0x0d && decoded[5] == 0x0a
                        && decoded[6] == 0x1a && decoded[7] == 0x0a
                    : decoded.length >= 12
                        && decoded[0] == 'R' && decoded[1] == 'I'
                        && decoded[2] == 'F' && decoded[3] == 'F'
                        && decoded[8] == 'W' && decoded[9] == 'E'
                        && decoded[10] == 'B' && decoded[11] == 'P';
            if (!signature || decoded.length > 96 * 1024
                || exactInteger(attachment.opt("bytes")) != decoded.length) {
                throw new IllegalArgumentException("local authority image attachment conflict");
            }
        } catch (IllegalArgumentException invalidBase64) {
            throw new IllegalArgumentException("local authority image attachment conflict", invalidBase64);
        }
    }

    private static byte[] decodeBase64(String encoded) {
        if (encoded == null || encoded.isEmpty() || (encoded.length() % 4) != 0
            || !encoded.matches("[A-Za-z0-9+/]+={0,2}")) {
            throw new IllegalArgumentException("invalid base64");
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream((encoded.length() * 3) / 4);
        for (int index = 0; index < encoded.length(); index += 4) {
            int a = base64Value(encoded.charAt(index));
            int b = base64Value(encoded.charAt(index + 1));
            int c = encoded.charAt(index + 2) == '=' ? 0 : base64Value(encoded.charAt(index + 2));
            int d = encoded.charAt(index + 3) == '=' ? 0 : base64Value(encoded.charAt(index + 3));
            output.write((a << 2) | (b >> 4));
            if (encoded.charAt(index + 2) != '=') output.write(((b & 15) << 4) | (c >> 2));
            if (encoded.charAt(index + 3) != '=') output.write(((c & 3) << 6) | d);
        }
        return output.toByteArray();
    }

    private static int base64Value(char value) {
        if (value >= 'A' && value <= 'Z') return value - 'A';
        if (value >= 'a' && value <= 'z') return value - 'a' + 26;
        if (value >= '0' && value <= '9') return value - '0' + 52;
        if (value == '+') return 62;
        if (value == '/') return 63;
        throw new IllegalArgumentException("invalid base64");
    }

    private static void validateLocalActions(
        JSONArray actions,
        String groupId,
        String roleId,
        String lineageKey,
        long claimedLineageRevision,
        JSONObject normalizedEnvelope
    ) throws Exception {
        for (int ordinal = 0; ordinal < actions.length(); ordinal += 1) {
            JSONObject action = actions.getJSONObject(ordinal);
            if (!LOCAL_ACTION_KEYS.equals(keysOf(action))
                || exactInteger(action.opt("ordinal")) != ordinal
                || !AuthorityIdentity.actionId(groupId, ordinal).equals(action.opt("actionId"))
                || !(action.opt("payload") instanceof JSONObject)) {
                throw new IllegalArgumentException("local authority action conflict");
            }
            String kind = requireNonEmptyString(action, "kind");
            String targetKey = requireNonEmptyString(action, "targetKey");
            String targetRevision = requireNonEmptyString(action, "targetRevision");
            LocalFallbackActionAuthority.validateAgainstPinnedInput(
                kind, targetKey, targetRevision, action.getJSONObject("payload"),
                roleId, lineageKey, claimedLineageRevision, normalizedEnvelope);
            JSONObject basis = new JSONObject()
                .put("kind", kind)
                .put("targetKey", targetKey)
                .put("targetRevision", targetRevision)
                .put("payload", action.getJSONObject("payload"));
            if (!requireChecksum(action, "checksum").equals(
                BridgeAuthority.sha256CanonicalJson(basis))) {
                throw new IllegalArgumentException("local authority action checksum conflict");
            }
        }
    }

    private static void validateLocalRelease(JSONObject release) throws Exception {
        if (!LOCAL_RELEASE_KEYS.equals(keysOf(release))
            || !"cognition-v3-fallback-v1".equals(release.opt("contract"))
            || exactInteger(release.opt("codecVersion")) != 1L) {
            throw new IllegalArgumentException("local authority release conflict");
        }
        String contractChecksum = BridgeAuthority.sha256CanonicalJson(new JSONObject()
            .put("contract", "cognition-v3-fallback-v1")
            .put("codecVersion", 1L));
        String releaseChecksum = BridgeAuthority.sha256CanonicalJson(new JSONObject()
            .put("origin", "android_fallback")
            .put("contract", "cognition-v3-fallback-v1")
            .put("contractChecksum", contractChecksum)
            .put("codecVersion", 1L));
        if (!contractChecksum.equals(release.opt("contractChecksum"))
            || !("android_fallback:" + contractChecksum).equals(release.opt("releaseId"))
            || !releaseChecksum.equals(release.opt("releaseChecksum"))) {
            throw new IllegalArgumentException("local authority release conflict");
        }
    }

    private static boolean sameNullableText(Object left, Object right) {
        if (left == JSONObject.NULL && right == JSONObject.NULL) return true;
        return left instanceof String && !((String) left).isEmpty() && left.equals(right);
    }

    private static String requireChecksum(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || !((String) raw).matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("local authority " + key + " checksum conflict");
        }
        return (String) raw;
    }

    private static long exactInteger(Object value) {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) return -1L;
        long parsed = ((Number) value).longValue();
        return parsed > 9007199254740991L ? -1L : parsed;
    }

    private static String requireNonEmptyString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("bridge checkpoint " + key + " conflict");
        }
        return (String) raw;
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }
}
