package com.siyi.al.execution.bridge;

import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ParsedReplyPart;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.db.AlExecutionDao;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

public final class RoomBridgeMirror implements BridgeRouter.MessageMirror {
    interface RoleDeletionGate {
        boolean tombstoned(String roleId);
        default boolean runIfNotDeleted(String roleId, Runnable sideEffect) {
            if (tombstoned(roleId)) return false;
            sideEffect.run();
            return !tombstoned(roleId);
        }
    }
    interface CheckedRoleWrite {
        boolean run() throws Exception;
    }

    interface CanonicalApplier {
        RoomExecutionStore.CanonicalCloudTarget resolve(
            String lineageKey, String authoritativeTurnId);
        RoomExecutionStore.DeliveryDisposition commitTerminal(
            RoomExecutionStore.CanonicalCloudTarget target, BridgeResult result, long now);
        void commitFailure(
            RoomExecutionStore.CanonicalCloudTarget target, BridgeResult result, long now);
        void recordRejected(
            RoomExecutionStore.CanonicalCloudTarget target,
            String relayMessageId,
            String reason,
            long now);
    }

    private final AlExecutionDao dao;
    private final CanonicalApplier canonicalApplier;
    private final String deviceId;
    private final RoleDeletionGate roleDeletionGate;

    public RoomBridgeMirror(AlExecutionDao dao, String deviceId) {
        this(dao, (CanonicalApplier) null, deviceId, roleId -> false);
    }

    public RoomBridgeMirror(
        AlExecutionDao dao,
        RoomExecutionStore store,
        String deviceId
    ) {
        this(dao, canonicalApplier(store), deviceId, new RoleDeletionGate() {
            @Override public boolean tombstoned(String roleId) {
                return store.isRoleDeleteTombstoned(roleId);
            }
            @Override public boolean runIfNotDeleted(String roleId, Runnable sideEffect) {
                return store.runRoleSideEffectIfNotDeleted(roleId, sideEffect);
            }
        });
    }

    RoomBridgeMirror(AlExecutionDao dao, CanonicalApplier canonicalApplier, String deviceId) {
        this(dao, canonicalApplier, deviceId, roleId -> false);
    }

    RoomBridgeMirror(
        AlExecutionDao dao, CanonicalApplier canonicalApplier, String deviceId,
        RoleDeletionGate roleDeletionGate
    ) {
        this.dao = dao;
        this.canonicalApplier = canonicalApplier;
        this.deviceId = deviceId == null || deviceId.trim().isEmpty() ? "phone" : deviceId.trim();
        this.roleDeletionGate = roleDeletionGate == null ? roleId -> false : roleDeletionGate;
    }

    @Override public void persistSubmission(TurnSubmission submission) throws Exception {
        if (submission.kind != TurnKind.DIRECT_REPLY) return;
        JSONObject raw = BridgeInput.userMessage(submission);
        String content = raw.optString("content", "");
        if (content.trim().isEmpty()) throw new IllegalArgumentException("raw user message is empty");
        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = submission.sourceMessageId;
        entity.turnId = submission.turnId;
        entity.characterId = submission.characterId;
        entity.speakerId = "user";
        entity.speakerType = "user";
        entity.recipientId = submission.characterId;
        entity.content = content;
        entity.sentAt = raw.optLong("sentAt", submission.createdAt);
        entity.origin = "phone";
        entity.deviceId = deviceId;
        entity.deviceSeq = BridgeInput.deviceSeq(submission);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = 0L;
        roleDeletionGate.runIfNotDeleted(submission.characterId, () -> {
            entity.syncSeq = nextSyncSeq();
            dao.insertRawMessage(entity);
        });
    }

    @Override public void persistReply(TurnSubmission submission, BridgeResult result) throws Exception {
        JSONObject response = new JSONObject(result.responseJson == null ? "{}" : result.responseJson);
        JSONObject remoteReply = response.optJSONObject("reply");
        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = remoteReply == null
            ? "msg_reply_" + sha256(submission.turnId).substring(0, 24)
            : remoteReply.optString("messageId", "msg_reply_" + sha256(submission.turnId).substring(0, 24));
        entity.turnId = response.optString("turnId", submission.turnId);
        entity.characterId = submission.characterId;
        entity.speakerId = submission.characterId;
        entity.speakerType = "character";
        entity.recipientId = "user";
        entity.content = result.replyText;
        entity.sentAt = remoteReply == null
            ? System.currentTimeMillis()
            : remoteReply.optLong("sentAt", System.currentTimeMillis());
        entity.origin = result.fallback ? "fallback" : result.origin;
        entity.deviceId = result.fallback ? deviceId + ":fallback" : "pc:" + deviceId;
        entity.deviceSeq = Math.max(1L, entity.sentAt);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = 0L;
        roleDeletionGate.runIfNotDeleted(submission.characterId, () -> {
            entity.syncSeq = result.fallback ? nextSyncSeq() : 0L;
            dao.insertRawMessage(entity);
        });
    }

    public boolean persistCloudInboxReply(String raw) throws Exception {
        JSONObject response = new JSONObject(raw == null ? "{}" : raw);
        if (declaredProtocolVersion(response) == 3) return persistCanonicalCloudResult(response);
        JSONObject reply = response.optJSONObject("reply");
        String remoteTurnId = response.optString("turnId", "").trim();
        if (remoteTurnId.isEmpty()) return false;

        String localTurnId = remoteTurnId.startsWith("turn_cloud_")
            ? remoteTurnId.substring("turn_".length())
            : remoteTurnId;
        ChatTurnEntity turn = dao.turn(localTurnId);
        if (turn == null && !localTurnId.equals(remoteTurnId)) {
            localTurnId = remoteTurnId;
            turn = dao.turn(localTurnId);
        }
        final String resolvedLocalTurnId = localTurnId;
        if (turn != null && roleDeletionGate.tombstoned(turn.characterId)) return true;

        if (reply == null) {
            if (response.optBoolean("terminal", false) && "skip".equals(response.optString("action", ""))) {
                if (turn == null) return false;
                boolean applied = runCheckedRoleWrite(turn.characterId,
                    () -> dao.importCloudBacklogSkip(resolvedLocalTurnId, System.currentTimeMillis()));
                return applied || roleDeletionGate.tombstoned(turn.characterId);
            }
            String remoteState = response.optString("state", "").trim();
            if (turn == null || !response.optBoolean("terminal", false) || !"failed".equals(remoteState)) {
                return false;
            }
            boolean retryable = response.optBoolean("allowFallback", false);
            boolean applied = runCheckedRoleWrite(turn.characterId, () -> dao.importCloudBacklogFailure(
                resolvedLocalTurnId,
                retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
                "REMOTE_REPLY_FAILED",
                "回复暂时没有送达，请重试",
                System.currentTimeMillis()
            ));
            return applied || roleDeletionGate.tombstoned(turn.characterId);
        }
        String content = reply.optString("content", "").trim();
        String messageId = reply.optString("messageId", "").trim();
        long sentAt = reply.optLong("sentAt", 0L);
        if (content.isEmpty() || messageId.isEmpty() || sentAt <= 0L) return false;

        String characterId = reply.optString("characterId", "").trim();
        if (characterId.isEmpty() && turn != null) characterId = turn.characterId;
        if (characterId.isEmpty()) characterId = response.optString("characterId", "").trim();
        if (characterId.isEmpty()) return false;
        final String resolvedCharacterId = characterId;
        if (roleDeletionGate.tombstoned(resolvedCharacterId)) return true;

        RawMessageEntity entity = new RawMessageEntity();
        entity.messageId = messageId;
        entity.turnId = remoteTurnId;
        entity.characterId = characterId;
        entity.speakerId = entity.characterId;
        entity.speakerType = "character";
        entity.recipientId = "user";
        entity.content = content;
        entity.sentAt = sentAt;
        entity.origin = reply.optString("origin", "codex");
        entity.deviceId = "pc:" + deviceId;
        entity.deviceSeq = Math.max(1L, sentAt);
        entity.checksum = sha256(canonical(entity));
        entity.syncSeq = 0L;
        if (!runCheckedRoleWrite(resolvedCharacterId, () -> {
            dao.insertRawMessage(entity);
            return true;
        })) return true;

        if (completedTurnAlreadyContainsReply(turn, content)) return true;

        if (turn != null) {
            String state = turn.state == null ? "" : turn.state;
            if (!("FAILED_RETRYABLE".equals(state) || "FAILED_FINAL".equals(state)
                || "INTERRUPTED".equals(state) || "CANCELLED".equals(state)
                || "BRIDGE_WAITING".equals(state)
                || "COMPLETED".equals(state))) {
                return false;
            }
            ReplyPartEntity originalPart = backlogPart(messageId, localTurnId, turn.activeAttemptId, content, sentAt);
            boolean imported = runCheckedRoleWrite(resolvedCharacterId,
                () -> dao.importCloudBacklogReply(resolvedLocalTurnId, originalPart, sentAt));
            if (imported || roleDeletionGate.tombstoned(characterId)) return true;
        }

        String digest = sha256(messageId).substring(0, 24);
        String backfillTurnId = "cloud_backfill_" + digest;
        boolean backfillApplied = runCheckedRoleWrite(resolvedCharacterId, () -> {
            ChatTurnEntity backfillTurn = dao.turn(backfillTurnId);
            if (backfillTurn == null) {
                backfillTurn = new ChatTurnEntity();
                backfillTurn.turnId = backfillTurnId;
                backfillTurn.characterId = resolvedCharacterId;
                backfillTurn.sourceMessageId = "source_cloud_backfill_" + digest;
                backfillTurn.cloudJobId = null;
                backfillTurn.kind = TurnKind.PROACTIVE_CHAT.name();
                backfillTurn.state = "COMPLETED";
                backfillTurn.activeAttemptId = null;
                backfillTurn.inputJson = new JSONObject()
                    .put("source", "cloud_backfill")
                    .put("remoteTurnId", remoteTurnId)
                    .toString();
                backfillTurn.snapshotJson = new JSONObject()
                    .put("characterId", resolvedCharacterId)
                    .toString();
                backfillTurn.createdAt = sentAt;
                backfillTurn.updatedAt = sentAt;
                backfillTurn.completedAt = sentAt;
                backfillTurn.uiAppliedAt = null;
                dao.insertTurn(backfillTurn);
            }
            ReplyPartEntity independentPart = backlogPart(messageId, backfillTurnId, null, content, sentAt);
            return dao.importCloudBacklogReply(backfillTurnId, independentPart, sentAt);
        });
        return backfillApplied || roleDeletionGate.tombstoned(characterId);
    }

    public void recordCanonicalCloudRejection(
        String relayMessageId, String reason, long now
    ) {
        if (canonicalApplier == null) {
            throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
        }
        canonicalApplier.recordRejected(null, relayMessageId, reason, now);
    }

    private boolean persistCanonicalCloudResult(JSONObject response) throws Exception {
        if (canonicalApplier == null) {
            throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
        }
        String relayMessageId = nativeNonEmptyString(response, "_relayMessageId");
        String route = nativeNonEmptyString(response, "_deliveryRoute");
        if (!"cloud".equals(route)) {
            throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
        }
        JSONObject wire = new JSONObject(response.toString());
        wire.remove("_relayMessageId");
        wire.remove("_deliveryRoute");
        BridgeResult result = null;
        RoomExecutionStore.CanonicalCloudTarget target = null;
        long now = System.currentTimeMillis();
        try {
            result = BridgeTurnStatus.parseV3(wire.toString(), "cloud", relayMessageId);
            if (roleDeletionGate.tombstoned(result.roleId)) return true;
            target = canonicalApplier.resolve(
                result.authorityLineageKey, result.authoritativeTurnId);
            if (result.kind == BridgeResult.Kind.CANONICAL_TERMINAL) {
                canonicalApplier.commitTerminal(target, result, now);
            } else if (result.kind == BridgeResult.Kind.VERIFIED_REMOTE_FAILURE) {
                canonicalApplier.commitFailure(target, result, now);
            } else {
                throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
            }
            return true;
        } catch (RuntimeException error) {
            if (BridgeClient.isCanonicalInboxRejection(error)) {
                String reason = result == null
                    ? BridgeClient.canonicalRejectionReason(error)
                    : target == null ? "target_conflict" : "apply_conflict";
                canonicalApplier.recordRejected(target, relayMessageId, reason, now);
            }
            throw error;
        }
    }

    private static CanonicalApplier canonicalApplier(RoomExecutionStore store) {
        if (store == null) throw new IllegalArgumentException("canonical store is required");
        return new CanonicalApplier() {
            @Override public RoomExecutionStore.CanonicalCloudTarget resolve(
                String lineageKey, String authoritativeTurnId
            ) {
                return store.resolveCanonicalCloudTarget(lineageKey, authoritativeTurnId);
            }

            @Override public RoomExecutionStore.DeliveryDisposition commitTerminal(
                RoomExecutionStore.CanonicalCloudTarget target, BridgeResult result, long now
            ) {
                return store.commitBridgedTerminal(
                    target.localTurnId, target.activeAttemptId, result, now);
            }

            @Override public void commitFailure(
                RoomExecutionStore.CanonicalCloudTarget target, BridgeResult result, long now
            ) {
                store.commitVerifiedRemoteFailure(
                    target.localTurnId, target.activeAttemptId, result, now);
            }

            @Override public void recordRejected(
                RoomExecutionStore.CanonicalCloudTarget target,
                String relayMessageId,
                String reason,
                long now
            ) {
                store.recordCanonicalCloudRejectionOnce(
                    target, relayMessageId, reason, now);
            }
        };
    }

    private static int declaredProtocolVersion(JSONObject value) {
        if (!value.has("protocolVersion")) return 0;
        Object raw = value.opt("protocolVersion");
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("bridge protocol version conflict");
        }
        long version = ((Number) raw).longValue();
        if (version < 1L || version > 3L) {
            throw new IllegalArgumentException("bridge protocol version conflict");
        }
        return (int) version;
    }

    private static String nativeNonEmptyString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).trim().isEmpty()) {
            throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
        }
        return (String) raw;
    }

    private boolean completedTurnAlreadyContainsReply(ChatTurnEntity turn, String content) {
        if (turn == null || !"COMPLETED".equals(turn.state)) return false;
        List<ReplyPartEntity> stored = dao.replyParts(turn.turnId);
        if (stored == null || stored.isEmpty()) return false;
        List<String> storedText = new ArrayList<>();
        for (ReplyPartEntity part : stored) {
            if ("TEXT".equals(part.type)) storedText.add(part.content);
        }
        ParsedReply parsed = new ReplyParser().parse(
            content,
            turn.turnId,
            turn.activeAttemptId == null ? "attempt_cloud_compare" : turn.activeAttemptId
        );
        List<String> incomingText = new ArrayList<>();
        for (ParsedReplyPart part : parsed.parts) {
            if ("TEXT".equals(part.type)) incomingText.add(part.content);
        }
        return !incomingText.isEmpty() && storedText.equals(incomingText);
    }

    private static ReplyPartEntity backlogPart(
        String messageId, String turnId, String attemptId, String content, long sentAt
    ) throws Exception {
        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "reply_backfill_" + sha256(messageId).substring(0, 24);
        part.turnId = turnId;
        part.attemptId = attemptId == null || attemptId.isEmpty()
            ? "attempt_backfill_" + sha256(turnId).substring(0, 24)
            : attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = content;
        part.payloadJson = "{}";
        part.createdAt = sentAt;
        return part;
    }

    private boolean runCheckedRoleWrite(String characterId, CheckedRoleWrite action) throws Exception {
        final boolean[] result = {false};
        final Exception[] failure = {null};
        boolean completed = roleDeletionGate.runIfNotDeleted(characterId, () -> {
            try {
                result[0] = action.run();
            } catch (Exception error) {
                failure[0] = error;
            }
        });
        if (failure[0] != null) throw failure[0];
        return completed && result[0];
    }

    private long nextSyncSeq() {
        return dao.allocateJournalSyncSeq(System.currentTimeMillis());
    }

    private static String canonical(RawMessageEntity value) {
        return value.messageId + "\n" + value.turnId + "\n" + value.speakerId + "\n" + value.content + "\n" + value.sentAt;
    }

    private static String sha256(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (byte item : hash) out.append(String.format("%02x", item & 0xff));
        return out.toString();
    }
}
