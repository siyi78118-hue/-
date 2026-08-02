package com.siyi.al.execution;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Deterministic identifiers shared with the PC authority store.  All lengths
 * are UTF-8 byte lengths, deliberately not Java UTF-16 code-unit lengths.
 * Ordinals are restricted to the JavaScript-safe integer protocol domain
 * 0..9007199254740991; Node production callers validate them upstream.
 */
public final class AuthorityIdentity {
    private static final long MAX_SAFE_ORDINAL = 9007199254740991L;
    private AuthorityIdentity() {}

    public static String lineageKey(String roleId, String laneKey, String rootSourceId) {
        return "lin_" + authorityHash("al-turn-lineage-v1", roleId, laneKey, rootSourceId);
    }

    public static String groupId(String lineageKey) {
        return "grp_" + authorityHash("al-visible-group-v1", lineageKey);
    }

    public static String messageId(String groupId, long ordinal) {
        return "msg_" + authorityHash("al-visible-message-v1", groupId, decimalOrdinal(ordinal));
    }

    public static String actionId(String groupId, long ordinal) {
        return "act_" + authorityHash("al-visible-action-v1", groupId, decimalOrdinal(ordinal));
    }

    private static String decimalOrdinal(long ordinal) {
        if (ordinal < 0 || ordinal > MAX_SAFE_ORDINAL) {
            throw new IllegalArgumentException("authority ordinal is outside the safe protocol range");
        }
        return Long.toString(ordinal);
    }

    private static String authorityHash(String namespace, String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update((namespace + "\u0000").getBytes(StandardCharsets.UTF_8));
            for (String value : values) {
                String text = value == null ? "" : value;
                int byteLength = text.getBytes(StandardCharsets.UTF_8).length;
                digest.update((byteLength + ":" + text).getBytes(StandardCharsets.UTF_8));
            }
            return hex(digest.digest());
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }
}
