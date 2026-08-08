package com.siyi.al.execution;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/** Closed cross-runtime validator for the Room authority summary attached to a PC backup. */
public final class AndroidRoomBackupHead {
    private static final long MAX_SAFE = 9007199254740991L;
    private static final Set<String> HEAD_KEYS = set(
        "headVersion", "roleId", "roomSchemaVersion", "cursor",
        "lifecycleHead", "capturedAt", "checksum");
    private static final Set<String> CURSOR_KEYS = set(
        "characterId", "nativeCompletedTurnId", "nativeCompletedGroupId",
        "nativeCompletedSequence", "uiAppliedTurnId", "uiAppliedGroupId",
        "uiAppliedSequence", "localSequence", "clearedThroughSequence",
        "clearEpoch", "clearedAt", "chatOpen", "updatedAt", "cursorChecksum");
    private static final Set<String> LIFECYCLE_KEYS = set(
        "controlId", "controlKind", "peerId", "state", "semanticChecksum",
        "clearEpoch", "clearedThroughSequence", "requestedAt", "appliedAt", "updatedAt");
    private static final Set<String> STATES = set(
        LifecycleControl.WAITING, LifecycleControl.PENDING, LifecycleControl.RELAY_ACCEPTED,
        LifecycleControl.APPLIED, LifecycleControl.QUARANTINED);

    private AndroidRoomBackupHead() {}

    public static JSONObject validate(JSONObject raw, String expectedRoleId) {
        try {
            return validateInternal(raw, expectedRoleId);
        } catch (IllegalArgumentException exception) {
            throw exception;
        } catch (JSONException exception) {
            throw new IllegalArgumentException("Android Room backup head JSON conflict", exception);
        }
    }

    private static JSONObject validateInternal(JSONObject raw, String expectedRoleId)
        throws JSONException {
        requireKeys(raw, HEAD_KEYS, "Android Room backup head");
        if (!"android-room-backup-head-v1".equals(raw.opt("headVersion"))) {
            throw new IllegalArgumentException("Android Room backup head version conflict");
        }
        String roleId = requireId(raw.opt("roleId"), "Android Room backup head role");
        if (expectedRoleId != null && !roleId.equals(expectedRoleId)) {
            throw new IllegalArgumentException("Android Room backup head role conflict");
        }
        long schemaVersion = requireSafe(raw.opt("roomSchemaVersion"), true,
            "Android Room backup head schema");
        long capturedAt = requireSafe(raw.opt("capturedAt"), true,
            "Android Room backup head capturedAt");
        JSONObject cursor = validateCursor(raw.optJSONObject("cursor"), roleId);
        JSONObject lifecycle = raw.opt("lifecycleHead") == JSONObject.NULL
            ? null : validateLifecycle(raw.optJSONObject("lifecycleHead"));
        if (capturedAt < cursor.optLong("updatedAt")
            || (lifecycle != null && capturedAt < lifecycle.optLong("updatedAt"))
            || (lifecycle != null && LifecycleControl.CLEAR_KIND.equals(lifecycle.optString("controlKind"))
                && (lifecycle.optLong("clearEpoch") != cursor.optLong("clearEpoch")
                    || lifecycle.optLong("clearedThroughSequence")
                        != cursor.optLong("clearedThroughSequence")))) {
            throw new IllegalArgumentException("Android Room backup head lifecycle projection conflict");
        }
        JSONObject normalized = new JSONObject()
            .put("headVersion", "android-room-backup-head-v1")
            .put("roleId", roleId)
            .put("roomSchemaVersion", schemaVersion)
            .put("cursor", cursor)
            .put("lifecycleHead", lifecycle == null ? JSONObject.NULL : lifecycle)
            .put("capturedAt", capturedAt);
        String checksum = requireChecksum(raw.opt("checksum"), "Android Room backup head checksum");
        if (!checksum.equals(BridgeAuthority.sha256CanonicalJson(normalized))) {
            throw new IllegalArgumentException("Android Room backup head checksum conflict");
        }
        return new JSONObject(normalized.toString()).put("checksum", checksum);
    }

    private static JSONObject validateCursor(JSONObject raw, String roleId) throws JSONException {
        requireKeys(raw, CURSOR_KEYS, "Android Room backup cursor");
        String characterId = requireId(raw.opt("characterId"), "Android Room backup cursor role");
        if (!roleId.equals(characterId) || !(raw.opt("chatOpen") instanceof Boolean)) {
            throw new IllegalArgumentException("Android Room backup cursor authority conflict");
        }
        String nativeTurn = nullableId(raw.opt("nativeCompletedTurnId"), "native turn");
        String nativeGroup = nullableId(raw.opt("nativeCompletedGroupId"), "native group");
        long nativeSequence = requireSafe(raw.opt("nativeCompletedSequence"), false, "native sequence");
        String uiTurn = nullableId(raw.opt("uiAppliedTurnId"), "UI turn");
        String uiGroup = nullableId(raw.opt("uiAppliedGroupId"), "UI group");
        long uiSequence = requireSafe(raw.opt("uiAppliedSequence"), false, "UI sequence");
        long localSequence = requireSafe(raw.opt("localSequence"), false, "local sequence");
        long clearedThrough = requireSafe(raw.opt("clearedThroughSequence"), false, "cleared sequence");
        long clearEpoch = requireSafe(raw.opt("clearEpoch"), false, "clear epoch");
        long clearedAt = requireSafe(raw.opt("clearedAt"), false, "clearedAt");
        long updatedAt = requireSafe(raw.opt("updatedAt"), false, "updatedAt");
        requireIdentityPair(nativeTurn, nativeGroup, nativeSequence);
        requireIdentityPair(uiTurn, uiGroup, uiSequence);
        if (uiSequence > nativeSequence || nativeSequence > localSequence
            || clearedThrough > localSequence
            || (nativeSequence > 0L && nativeSequence == uiSequence
                && (!nativeTurn.equals(uiTurn) || !nativeGroup.equals(uiGroup)))) {
            throw new IllegalArgumentException("Android Room backup cursor sequence conflict");
        }
        JSONObject normalized = new JSONObject()
            .put("characterId", characterId)
            .put("nativeCompletedTurnId", nativeTurn == null ? JSONObject.NULL : nativeTurn)
            .put("nativeCompletedGroupId", nativeGroup == null ? JSONObject.NULL : nativeGroup)
            .put("nativeCompletedSequence", nativeSequence)
            .put("uiAppliedTurnId", uiTurn == null ? JSONObject.NULL : uiTurn)
            .put("uiAppliedGroupId", uiGroup == null ? JSONObject.NULL : uiGroup)
            .put("uiAppliedSequence", uiSequence)
            .put("localSequence", localSequence)
            .put("clearedThroughSequence", clearedThrough)
            .put("clearEpoch", clearEpoch)
            .put("clearedAt", clearedAt)
            .put("chatOpen", raw.opt("chatOpen"))
            .put("updatedAt", updatedAt);
        JSONObject basis = new JSONObject(normalized.toString())
            .put("contract", "conversation-cursor-clear-v1");
        String checksum = requireChecksum(raw.opt("cursorChecksum"), "Android Room backup cursor checksum");
        if (!checksum.equals(BridgeAuthority.sha256CanonicalJson(basis))) {
            throw new IllegalArgumentException("Android Room backup cursor checksum conflict");
        }
        return new JSONObject(normalized.toString()).put("cursorChecksum", checksum);
    }

    private static JSONObject validateLifecycle(JSONObject raw) throws JSONException {
        requireKeys(raw, LIFECYCLE_KEYS, "Android Room backup lifecycle head");
        String kind = requireString(raw.opt("controlKind"), "lifecycle kind");
        String state = requireString(raw.opt("state"), "lifecycle state");
        if ((!LifecycleControl.CLEAR_KIND.equals(kind) && !LifecycleControl.ROLE_DELETE_KIND.equals(kind))
            || !STATES.contains(state)) {
            throw new IllegalArgumentException("Android Room backup lifecycle state conflict");
        }
        Long clearEpoch = nullableSafe(raw.opt("clearEpoch"), "lifecycle clear epoch");
        Long clearedThrough = nullableSafe(raw.opt("clearedThroughSequence"), "lifecycle clear sequence");
        if (LifecycleControl.CLEAR_KIND.equals(kind)
            ? clearEpoch == null || clearedThrough == null
            : clearEpoch != null || clearedThrough != null) {
            throw new IllegalArgumentException("Android Room backup lifecycle projection conflict");
        }
        long requestedAt = requireSafe(raw.opt("requestedAt"), true, "lifecycle requestedAt");
        Long appliedAt = nullableSafe(raw.opt("appliedAt"), "lifecycle appliedAt");
        long updatedAt = requireSafe(raw.opt("updatedAt"), true, "lifecycle updatedAt");
        if ((LifecycleControl.APPLIED.equals(state)) != (appliedAt != null)
            || updatedAt < requestedAt
            || (appliedAt != null && (appliedAt < requestedAt || appliedAt > updatedAt))) {
            throw new IllegalArgumentException("Android Room backup lifecycle time conflict");
        }
        return new JSONObject()
            .put("controlId", requireId(raw.opt("controlId"), "lifecycle control"))
            .put("controlKind", kind)
            .put("peerId", requireId(raw.opt("peerId"), "lifecycle peer"))
            .put("state", state)
            .put("semanticChecksum", requireChecksum(raw.opt("semanticChecksum"), "lifecycle checksum"))
            .put("clearEpoch", clearEpoch == null ? JSONObject.NULL : clearEpoch)
            .put("clearedThroughSequence", clearedThrough == null ? JSONObject.NULL : clearedThrough)
            .put("requestedAt", requestedAt)
            .put("appliedAt", appliedAt == null ? JSONObject.NULL : appliedAt)
            .put("updatedAt", updatedAt);
    }

    private static void requireIdentityPair(String turn, String group, long sequence) {
        boolean absent = turn == null && group == null;
        boolean present = turn != null && group != null;
        if ((!absent && !present) || (sequence == 0L ? !absent : !present)) {
            throw new IllegalArgumentException("Android Room backup cursor identity conflict");
        }
    }

    private static Long nullableSafe(Object value, String label) {
        return value == null || value == JSONObject.NULL ? null : requireSafe(value, false, label);
    }

    private static String nullableId(Object value, String label) {
        return value == null || value == JSONObject.NULL ? null : requireId(value, label);
    }

    private static long requireSafe(Object value, boolean positive, String label) {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) {
            throw new IllegalArgumentException("invalid " + label);
        }
        long number = ((Number) value).longValue();
        if (number < (positive ? 1L : 0L) || number > MAX_SAFE) {
            throw new IllegalArgumentException("invalid " + label);
        }
        return number;
    }

    private static String requireId(Object value, String label) {
        String text = requireString(value, label);
        if (!text.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")) {
            throw new IllegalArgumentException("invalid " + label);
        }
        return text;
    }

    private static String requireChecksum(Object value, String label) {
        String text = requireString(value, label);
        if (!text.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("invalid " + label);
        return text;
    }

    private static String requireString(Object value, String label) {
        if (!(value instanceof String)) throw new IllegalArgumentException("invalid " + label);
        return (String) value;
    }

    private static void requireKeys(JSONObject value, Set<String> expected, String label) {
        if (value == null || !expected.equals(keysOf(value))) {
            throw new IllegalArgumentException(label + " keys conflict");
        }
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
}
