package com.siyi.al.execution;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Closed, deterministic wire codec for lifecycle controls and redacted checkpoints. */
public final class LifecycleControlCodec {
    private static final Set<String> CLEAR_WIRE_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "controlVersion", "controlId", "roleId",
        "peerId", "clearEpoch", "clearedThroughSequence", "requestedAt",
        "inputCursorChecksum", "checksum"
    ));
    private static final Set<String> ROLE_DELETE_WIRE_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "controlVersion", "controlId", "roleId", "peerId",
        "requestedAt", "backupReceipt", "checksum"
    ));
    private static final Set<String> RECEIPT_KEYS = new HashSet<>(Arrays.asList(
        "receiptVersion", "receiptId", "roleId", "manifestChecksum",
        "snapshotSha256", "logicalChecksum", "createdAt", "receiptChecksum"
    ));

    private LifecycleControlCodec() { }

    public static final class Encoded {
        public final JSONObject semantic;
        public final String semanticChecksum;
        public final String controlId;

        Encoded(JSONObject semantic) throws JSONException {
            this.semantic = new JSONObject(semantic.toString());
            validateSemantic(this.semantic);
            this.semanticChecksum = semanticChecksum(this.semantic);
            this.controlId = controlId(this.semantic);
        }
    }

    public static Encoded encodeConversationClear(
        String characterId, String peerId, long clearEpoch,
        long clearedThroughSequence, long requestedAt, String inputCursorChecksum
    ) throws JSONException {
        requireId(characterId, "characterId");
        requireId(peerId, "peerId");
        requireSafeNonNegative(clearEpoch, "clearEpoch");
        requireSafeNonNegative(clearedThroughSequence, "clearedThroughSequence");
        requirePositiveSafe(requestedAt, "requestedAt");
        requireChecksum(inputCursorChecksum, "inputCursorChecksum");
        JSONObject basis = new JSONObject()
            .put("contract", "android-lifecycle-control-id-v1")
            .put("controlKind", LifecycleControl.CLEAR_KIND)
            .put("characterId", characterId)
            .put("peerId", peerId)
            .put("clearEpoch", clearEpoch)
            .put("clearedThroughSequence", clearedThroughSequence)
            .put("requestedAt", requestedAt)
            .put("inputCursorChecksum", inputCursorChecksum);
        String controlId = "ctl_" + BridgeAuthority.sha256CanonicalJson(basis);
        JSONObject wire = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "CONVERSATION_CLEAR")
            .put("controlVersion", "conversation_clear_v1")
            .put("controlId", controlId)
            .put("roleId", characterId)
            .put("peerId", peerId)
            .put("clearEpoch", clearEpoch)
            .put("clearedThroughSequence", clearedThroughSequence)
            .put("requestedAt", requestedAt)
            .put("inputCursorChecksum", inputCursorChecksum);
        wire.put("checksum", checksumWithoutField(wire));
        return new Encoded(wire);
    }

    public static Encoded encodeRoleDelete(
        String roleId, String peerId, long requestedAt, JSONObject backupReceipt
    ) throws JSONException {
        requireId(roleId, "roleId");
        requireId(peerId, "peerId");
        requirePositiveSafe(requestedAt, "requestedAt");
        if (backupReceipt == null) throw new IllegalArgumentException("backupReceipt is required");
        validateBackupReceipt(backupReceipt);
        if (!roleId.equals(backupReceipt.getString("roleId"))
            || backupReceipt.getLong("createdAt") > requestedAt) {
            throw new IllegalArgumentException("backup receipt role/time binding conflict");
        }
        String receiptChecksum = backupReceipt.getString("receiptChecksum");
        JSONObject basis = new JSONObject()
            .put("contract", "android-lifecycle-control-id-v1")
            .put("controlKind", LifecycleControl.ROLE_DELETE_KIND)
            .put("roleId", roleId)
            .put("peerId", peerId)
            .put("requestedAt", requestedAt)
            .put("backupReceiptChecksum", receiptChecksum);
        JSONObject wire = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "ROLE_DELETE")
            .put("controlVersion", "role_delete_v1")
            .put("controlId", "ctl_" + BridgeAuthority.sha256CanonicalJson(basis))
            .put("roleId", roleId)
            .put("peerId", peerId)
            .put("requestedAt", requestedAt)
            .put("backupReceipt", new JSONObject(backupReceipt.toString()));
        wire.put("checksum", checksumWithoutField(wire));
        return new Encoded(wire);
    }

    public static String semanticChecksum(JSONObject semantic) {
        validateSemantic(semantic);
        return BridgeAuthority.sha256CanonicalJson(semantic);
    }

    public static String controlId(JSONObject semantic) throws JSONException {
        validateSemantic(semantic);
        if (CLEAR_WIRE_KEYS.equals(keysOf(semantic)) || ROLE_DELETE_WIRE_KEYS.equals(keysOf(semantic))) {
            return semantic.getString("controlId");
        }
        throw new IllegalArgumentException("lifecycle wire control id is unavailable");
    }

    public static void validateSemantic(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("lifecycle semantic is required");
        if (CLEAR_WIRE_KEYS.equals(keysOf(value))) {
            validateClearWire(value);
            return;
        }
        if (ROLE_DELETE_WIRE_KEYS.equals(keysOf(value))) {
            validateRoleDeleteWire(value);
            return;
        }
        throw new IllegalArgumentException("unknown lifecycle wire shape");
    }

    /** Replace semantic/result payload with the exact non-semantic clear tombstone. */
    public static JSONObject redactCheckpoint(
        JSONObject checkpoint, String controlId, long clearEpoch,
        long clearedThroughSequence, long redactedAt, boolean localV2
    ) throws JSONException {
        if (checkpoint == null || controlId == null || controlId.trim().isEmpty()) {
            throw new IllegalArgumentException("checkpoint/controlId is required");
        }
        requireSafeNonNegative(clearEpoch, "clearEpoch");
        requireSafeNonNegative(clearedThroughSequence, "clearedThroughSequence");
        requirePositiveSafe(redactedAt, "redactedAt");
        JSONObject next = new JSONObject(checkpoint.toString());
        next.put("normalizedEnvelope", JSONObject.NULL);
        JSONObject result = new JSONObject()
            .put("contract", "conversation-clear-redacted-v1")
            .put("controlId", controlId)
            .put("clearEpoch", clearEpoch)
            .put("clearedThroughSequence", clearedThroughSequence);
        JSONObject outcome = new JSONObject()
            .put("type", "redacted")
            .put("route", JSONObject.NULL)
            .put("relayMessageId", JSONObject.NULL)
            .put("failure", JSONObject.NULL)
            .put("result", result)
            .put("redactedAt", redactedAt);
        next.put("outcome", outcome);
        if (localV2) {
            next.put("fallbackExecution", JSONObject.NULL);
            next.put("journalSyncSeq", 0L);
        }
        return next;
    }

    public static JSONObject validateBackupReceipt(JSONObject value) {
        validateBackupReceiptShape(value);
        try {
            return new JSONObject(value.toString());
        } catch (Exception error) {
            throw new IllegalArgumentException("backup receipt clone conflict", error);
        }
    }

    private static Set<String> keysOf(JSONObject object) {
        Set<String> keys = new HashSet<>();
        JSONArray names = object.names();
        if (names == null) return keys;
        for (int i = 0; i < names.length(); i++) keys.add(names.optString(i));
        return keys;
    }

    private static String requireString(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof String) || ((String) value).trim().isEmpty()) {
            throw new IllegalArgumentException("invalid " + key);
        }
        return (String) value;
    }

    private static void requireId(Object value, String name) {
        if (!(value instanceof String) || ((String) value).trim().isEmpty() || !value.equals(((String) value).trim())) {
            throw new IllegalArgumentException("invalid " + name);
        }
    }

    private static void requireSafeInteger(Object value, String name) {
        if (!(value instanceof Number)
            || value instanceof Float || value instanceof Double
            || ((Number) value).longValue() < 0L
            || ((Number) value).longValue() > 9007199254740991L
            || ((Number) value).longValue() != ((Number) value).doubleValue()) {
            throw new IllegalArgumentException("invalid " + name);
        }
    }

    private static void requireSafeNonNegative(long value, String name) {
        if (value < 0L || value > 9007199254740991L) throw new IllegalArgumentException("invalid " + name);
    }

    private static void requirePositiveSafe(long value, String name) {
        if (value <= 0L || value > 9007199254740991L) throw new IllegalArgumentException("invalid " + name);
    }

    private static void requireChecksum(Object value, String name) {
        if (!(value instanceof String) || !((String) value).matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("invalid " + name);
        }
    }

    private static void validateClearWire(JSONObject value) {
        if (!(value.opt("protocolVersion") instanceof Number)
            || value.opt("protocolVersion") instanceof Float || value.opt("protocolVersion") instanceof Double
            || ((Number) value.opt("protocolVersion")).longValue() != 3L
            || !"CONVERSATION_CLEAR".equals(value.opt("type"))
            || !"conversation_clear_v1".equals(value.opt("controlVersion"))
            || !(value.opt("controlId") instanceof String)
            || !((String) value.opt("controlId")).matches("ctl_[a-f0-9]{64}")) {
            throw new IllegalArgumentException("lifecycle wire header conflict");
        }
        requireId(value.opt("roleId"), "roleId");
        requireId(value.opt("peerId"), "peerId");
        requireSafeInteger(value.opt("clearEpoch"), "clearEpoch");
        requireSafeInteger(value.opt("clearedThroughSequence"), "clearedThroughSequence");
        requireSafeInteger(value.opt("requestedAt"), "requestedAt");
        requirePositiveSafe(((Number) value.opt("requestedAt")).longValue(), "requestedAt");
        requireChecksum(value.opt("inputCursorChecksum"), "inputCursorChecksum");
        requireChecksum(value.opt("checksum"), "checksum");
        JSONObject basis = new JSONObject();
        try {
            JSONArray names = value.names();
            for (int i = 0; i < names.length(); i++) {
                String name = names.getString(i);
                if (!"checksum".equals(name)) basis.put(name, value.get(name));
            }
            if (!value.getString("checksum").equals(BridgeAuthority.sha256CanonicalJson(basis))) {
                throw new IllegalArgumentException("lifecycle wire checksum conflict");
            }
            JSONObject controlBasis = new JSONObject()
                .put("contract", "android-lifecycle-control-id-v1")
                .put("controlKind", LifecycleControl.CLEAR_KIND)
                .put("characterId", value.getString("roleId"))
                .put("peerId", value.getString("peerId"))
                .put("clearEpoch", value.getLong("clearEpoch"))
                .put("clearedThroughSequence", value.getLong("clearedThroughSequence"))
                .put("requestedAt", value.getLong("requestedAt"))
                .put("inputCursorChecksum", value.getString("inputCursorChecksum"));
            if (!value.getString("controlId").equals(
                "ctl_" + BridgeAuthority.sha256CanonicalJson(controlBasis))) {
                throw new IllegalArgumentException("lifecycle control id conflict");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle wire conflict", error);
        }
    }

    private static void validateRoleDeleteWire(JSONObject value) {
        if (!(value.opt("protocolVersion") instanceof Number)
            || value.opt("protocolVersion") instanceof Float || value.opt("protocolVersion") instanceof Double
            || ((Number) value.opt("protocolVersion")).longValue() != 3L
            || !"ROLE_DELETE".equals(value.opt("type"))
            || !"role_delete_v1".equals(value.opt("controlVersion"))
            || !(value.opt("controlId") instanceof String)
            || !((String) value.opt("controlId")).matches("ctl_[a-f0-9]{64}")) {
            throw new IllegalArgumentException("role-delete wire header conflict");
        }
        requireId(value.opt("roleId"), "roleId");
        requireId(value.opt("peerId"), "peerId");
        Object requestedAt = value.opt("requestedAt");
        if (!(requestedAt instanceof Number) || requestedAt instanceof Float || requestedAt instanceof Double) {
            throw new IllegalArgumentException("invalid requestedAt");
        }
        requireSafeInteger(requestedAt, "requestedAt");
        requirePositiveSafe(((Number) requestedAt).longValue(), "requestedAt");
        JSONObject receipt = value.optJSONObject("backupReceipt");
        validateBackupReceipt(receipt);
        if (!value.optString("roleId", "").equals(receipt.optString("roleId", ""))
            || ((Number) receipt.opt("createdAt")).longValue() > ((Number) requestedAt).longValue()) {
            throw new IllegalArgumentException("backup receipt role/time binding conflict");
        }
        requireChecksum(value.opt("checksum"), "checksum");
        try {
            if (!value.getString("checksum").equals(checksumWithoutField(value))) {
                throw new IllegalArgumentException("role-delete wire checksum conflict");
            }
            JSONObject basis = new JSONObject()
                .put("contract", "android-lifecycle-control-id-v1")
                .put("controlKind", LifecycleControl.ROLE_DELETE_KIND)
                .put("roleId", value.getString("roleId"))
                .put("peerId", value.getString("peerId"))
                .put("requestedAt", value.getLong("requestedAt"))
                .put("backupReceiptChecksum", receipt.getString("receiptChecksum"));
            if (!value.getString("controlId").equals("ctl_" + BridgeAuthority.sha256CanonicalJson(basis))) {
                throw new IllegalArgumentException("role-delete control id conflict");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("role-delete wire conflict", error);
        }
    }

    private static String checksumWithoutField(JSONObject value) {
        return checksumWithoutNamedField(value, "checksum");
    }

    private static String checksumWithoutNamedField(JSONObject value, String excludedField) {
        JSONObject basis = new JSONObject();
        try {
            JSONArray names = value.names();
            if (names != null) for (int i = 0; i < names.length(); i++) {
                String name = names.getString(i);
                if (!excludedField.equals(name)) basis.put(name, value.get(name));
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle checksum serialization failed", error);
        }
        return BridgeAuthority.sha256CanonicalJson(basis);
    }

    public static String backupReceiptChecksum(JSONObject value) {
        validateBackupReceiptShape(value);
        return checksumWithoutNamedField(value, "receiptChecksum");
    }

    private static void validateBackupReceiptShape(JSONObject value) {
        if (value == null || !RECEIPT_KEYS.equals(keysOf(value))) {
            throw new IllegalArgumentException("backup receipt keys conflict");
        }
        if (!"yuqi-backup-receipt-v1".equals(requireString(value, "receiptVersion"))) {
            throw new IllegalArgumentException("backup receipt version conflict");
        }
        String receiptId = requireString(value, "receiptId");
        if (!receiptId.matches("bkrcpt_[a-f0-9]{24}")) {
            throw new IllegalArgumentException("backup receipt id conflict");
        }
        requireId(value.opt("roleId"), "roleId");
        for (String key : new String[] {"manifestChecksum", "snapshotSha256", "logicalChecksum", "receiptChecksum"}) {
            String checksum = requireString(value, key);
            if (!checksum.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("backup checksum conflict");
        }
        Object createdAt = value.opt("createdAt");
        if (!(createdAt instanceof Number) || createdAt instanceof Float || createdAt instanceof Double) {
            throw new IllegalArgumentException("invalid createdAt");
        }
        requirePositiveSafe(((Number) createdAt).longValue(), "createdAt");
        if (!((String) value.opt("receiptChecksum")).equals(
            checksumWithoutNamedField(value, "receiptChecksum"))) {
            throw new IllegalArgumentException("backup receipt checksum conflict");
        }
        try {
            JSONObject idBasis = new JSONObject()
                .put("contract", "yuqi-backup-receipt-id-v1")
                .put("roleId", value.getString("roleId"))
                .put("manifestChecksum", value.getString("manifestChecksum"))
                .put("snapshotSha256", value.getString("snapshotSha256"))
                .put("logicalChecksum", value.getString("logicalChecksum"))
                .put("createdAt", value.getLong("createdAt"));
            String expectedId = "bkrcpt_" + BridgeAuthority.sha256CanonicalJson(idBasis).substring(0, 24);
            if (!receiptId.equals(expectedId)) {
                throw new IllegalArgumentException("backup receipt id conflict");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("backup receipt identity conflict", error);
        }
    }
}
