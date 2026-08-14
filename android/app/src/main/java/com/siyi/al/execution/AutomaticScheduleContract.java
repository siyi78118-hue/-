package com.siyi.al.execution;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Closed cross-language contract for one automatic schedule generation. */
public final class AutomaticScheduleContract {
    public enum Operation { SCHEDULE, PAUSE, DISABLE }
    public enum TerminalDisposition { VISIBLE, ACTION_ONLY, SKIP, FAILED }

    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$");
    private static final Pattern SHA = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern EPOCH = Pattern.compile("^[a-f0-9]{32}$");
    private static final Set<String> OWNER = set("android-v1", "web-v1");
    private static final Set<String> OPERATION = set("schedule", "pause", "disable");
    private static final Set<String> KIND = set("chat", "moment");
    private static final Set<String> MODE = set("planned", "dice");
    private static final Set<String> SOURCE_TYPE = set(
        "bootstrap", "settings_change", "direct_input", "direct_terminal",
        "proactive_terminal", "failure_retry", "lifecycle", "migration_claim"
    );
    private static final Set<String> TRANSITION_KEYS = set(
        "authorityEpoch", "characterId", "deviceId", "dueAt",
        "expectedPreviousJobId", "generation", "jobId", "kind", "mode",
        "operation", "owner", "policyChecksum", "policyRevision",
        "protocolVersion", "scheduleChecksum", "sourceChecksum", "sourceId",
        "sourceType", "streamKey", "transitionChecksum"
    );

    private AutomaticScheduleContract() {}

    public static final class Source {
        public final String type;
        public final String id;
        public final String checksum;
        public final long conversationSequence;
        public final long occurredAt;

        public Source(String type, String id, String checksum, long conversationSequence) {
            this(type, id, checksum, conversationSequence, 0L);
        }

        public Source(String type, String id, String checksum, long conversationSequence, long occurredAt) {
            require(SOURCE_TYPE.contains(type), "source type");
            requireId(id, "source id");
            requireSha(checksum, "source checksum");
            requireSafeNonNegative(conversationSequence, "conversation sequence");
            requireSafeNonNegative(occurredAt, "source occurredAt");
            this.type = type;
            this.id = id;
            this.checksum = checksum;
            this.conversationSequence = conversationSequence;
            this.occurredAt = occurredAt;
        }
    }

    public static final class Policy {
        public final long revision;
        public final long minDelayMs;
        public final long maxDelayMs;
        public final String checksum;
        public final String mode;
        public final String explicitAt;

        public Policy(long revision, String checksum, String mode,
                      long minDelayMs, long maxDelayMs, String explicitAt) {
            require(revision >= 1L && revision <= MAX_SAFE_INTEGER, "policy revision");
            requireSha(checksum, "policy checksum");
            require(MODE.contains(mode), "policy mode");
            require(minDelayMs >= 0L && minDelayMs <= maxDelayMs, "policy delay");
            require(maxDelayMs <= MAX_SAFE_INTEGER, "policy delay");
            if (explicitAt != null) {
                try {
                    long value = Long.parseLong(explicitAt);
                    require(value > 0L && value <= MAX_SAFE_INTEGER, "policy explicitAt");
                } catch (NumberFormatException error) {
                    throw invalid("policy explicitAt");
                }
            }
            this.revision = revision;
            this.checksum = checksum;
            this.mode = mode;
            this.minDelayMs = minDelayMs;
            this.maxDelayMs = maxDelayMs;
            this.explicitAt = explicitAt;
        }
    }

    public static final class ValidatedTransition {
        public final JSONObject value;
        public final String transitionCanonicalJson;
        public final String transitionChecksum;
        public final String streamKey;
        public final String jobId;
        public final String scheduleCanonicalJson;
        public final String scheduleChecksum;

        private ValidatedTransition(JSONObject value, String transitionCanonicalJson,
                                    String transitionChecksum, String streamKey, String jobId,
                                    String scheduleCanonicalJson, String scheduleChecksum) {
            this.value = value;
            this.transitionCanonicalJson = transitionCanonicalJson;
            this.transitionChecksum = transitionChecksum;
            this.streamKey = streamKey;
            this.jobId = jobId;
            this.scheduleCanonicalJson = scheduleCanonicalJson;
            this.scheduleChecksum = scheduleChecksum;
        }
    }

    public static ValidatedTransition create(
        String operation, String owner, String authorityEpoch, long generation,
        String expectedPreviousJobId, String deviceId, String characterId, String kind,
        String streamKey, String jobId, Long dueAt, String mode,
        Source source, long policyRevision, String policyChecksum
    ) {
        JSONObject value = new JSONObject();
        put(value, "protocolVersion", 2);
        put(value, "operation", operation);
        put(value, "owner", owner);
        put(value, "authorityEpoch", authorityEpoch);
        put(value, "generation", generation);
        put(value, "expectedPreviousJobId", expectedPreviousJobId);
        put(value, "deviceId", deviceId);
        put(value, "characterId", characterId);
        put(value, "kind", kind);
        put(value, "streamKey", streamKey);
        put(value, "jobId", jobId);
        put(value, "dueAt", dueAt);
        put(value, "mode", mode);
        put(value, "sourceType", source.type);
        put(value, "sourceId", source.id);
        put(value, "sourceChecksum", source.checksum);
        put(value, "policyRevision", policyRevision);
        put(value, "policyChecksum", policyChecksum);
        String transitionChecksum = BridgeAuthority.sha256CanonicalJson(transitionBasis(value));
        put(value, "transitionChecksum", transitionChecksum);
        if ("schedule".equals(operation)) {
            String prefix = "moment".equals(kind) ? "mom" : "pro";
            put(value, "jobId", prefix + "_" + transitionChecksum.substring(0, 16) + "_" + generation);
        }
        put(value, "scheduleChecksum", BridgeAuthority.sha256CanonicalJson(scheduleBasis(value)));
        return validateTransition(value);
    }

    public static ValidatedTransition validateTransition(JSONObject input) {
        require(input != null, "shape");
        requireExactKeys(input, TRANSITION_KEYS);
        require(integer(input, "protocolVersion") == 2L, "protocolVersion");
        String operation = string(input, "operation");
        String owner = string(input, "owner");
        String kind = string(input, "kind");
        String sourceType = string(input, "sourceType");
        require(OPERATION.contains(operation) && OWNER.contains(owner)
            && KIND.contains(kind) && SOURCE_TYPE.contains(sourceType), "enum");
        String deviceId = string(input, "deviceId");
        String characterId = string(input, "characterId");
        String sourceId = string(input, "sourceId");
        requireId(deviceId, "deviceId");
        requireId(characterId, "characterId");
        requireId(sourceId, "sourceId");
        String epoch = string(input, "authorityEpoch");
        require(EPOCH.matcher(epoch).matches(), "authorityEpoch");
        long generation = integer(input, "generation");
        long policyRevision = integer(input, "policyRevision");
        require(generation >= 1L && policyRevision >= 1L, "revision");
        String previous = nullableString(input, "expectedPreviousJobId");
        if (previous != null) requireId(previous, "expectedPreviousJobId");
        requireSha(string(input, "sourceChecksum"), "sourceChecksum");
        requireSha(string(input, "policyChecksum"), "policyChecksum");
        String transitionChecksum = string(input, "transitionChecksum");
        String scheduleChecksum = string(input, "scheduleChecksum");
        requireSha(transitionChecksum, "transitionChecksum");
        requireSha(scheduleChecksum, "scheduleChecksum");
        String streamKey = string(input, "streamKey");
        require(streamKey.equals(streamKey(deviceId, characterId, kind)), "streamKey");

        String jobId = nullableString(input, "jobId");
        if ("schedule".equals(operation)) {
            requireId(jobId, "jobId");
            require(nullableInteger(input, "dueAt") != null && nullableInteger(input, "dueAt") > 0L,
                "dueAt");
            require(MODE.contains(nullableString(input, "mode")), "mode");
            String prefix = "moment".equals(kind) ? "mom" : "pro";
            require(jobId.equals(prefix + "_" + transitionChecksum.substring(0, 16) + "_" + generation),
                "jobId");
        } else {
            require(jobId == null && nullableInteger(input, "dueAt") == null
                && nullableString(input, "mode") == null, "inactive");
        }

        String transitionJson = BridgeAuthority.canonicalJson(transitionBasis(input));
        String scheduleJson = BridgeAuthority.canonicalJson(scheduleBasis(input));
        require(BridgeAuthority.sha256CanonicalJson(transitionBasis(input)).equals(transitionChecksum),
            "transition checksum");
        require(BridgeAuthority.sha256CanonicalJson(scheduleBasis(input)).equals(scheduleChecksum),
            "schedule checksum");
        return new ValidatedTransition(cloneObject(input), transitionJson,
            transitionChecksum, streamKey, jobId, scheduleJson, scheduleChecksum);
    }

    public static String streamKey(String deviceId, String characterId, String kind) {
        requireId(deviceId, "deviceId");
        requireId(characterId, "characterId");
        require(KIND.contains(kind), "kind");
        return "active:" + encodeURIComponent(deviceId) + ":" + encodeURIComponent(characterId) + ":" + kind;
    }

    private static JSONObject transitionBasis(JSONObject value) {
        return copyExcept(value, "protocolVersion", "jobId", "transitionChecksum", "scheduleChecksum");
    }

    private static JSONObject scheduleBasis(JSONObject value) {
        return copyExcept(value, "protocolVersion", "scheduleChecksum");
    }

    private static JSONObject copyExcept(JSONObject input, String... excluded) {
        Set<String> skip = set(excluded);
        JSONObject output = new JSONObject();
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!skip.contains(key)) put(output, key, required(input, key));
        }
        return output;
    }

    private static void requireExactKeys(JSONObject input, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) actual.add(keys.next());
        require(actual.equals(expected), "keys");
    }

    private static long integer(JSONObject input, String key) {
        Object value = required(input, key);
        require(value instanceof Integer || value instanceof Long, key);
        long result = ((Number) value).longValue();
        require(result >= 0L && result <= MAX_SAFE_INTEGER, key);
        return result;
    }

    private static Long nullableInteger(JSONObject input, String key) {
        Object value = required(input, key);
        if (value == JSONObject.NULL) return null;
        require(value instanceof Integer || value instanceof Long, key);
        long result = ((Number) value).longValue();
        require(result >= 0L && result <= MAX_SAFE_INTEGER, key);
        return result;
    }

    private static String string(JSONObject input, String key) {
        Object value = required(input, key);
        require(value instanceof String, key);
        return (String) value;
    }

    private static String nullableString(JSONObject input, String key) {
        Object value = required(input, key);
        if (value == JSONObject.NULL) return null;
        require(value instanceof String, key);
        return (String) value;
    }

    private static Object required(JSONObject input, String key) {
        if (!input.has(key)) throw invalid(key);
        try {
            return input.get(key);
        } catch (Exception error) {
            throw invalid(key);
        }
    }

    private static JSONObject cloneObject(JSONObject input) {
        try {
            return new JSONObject(input.toString());
        } catch (Exception error) {
            throw invalid("shape");
        }
    }

    private static void put(JSONObject output, String key, Object value) {
        try {
            output.put(key, value == null ? JSONObject.NULL : value);
        } catch (Exception error) {
            throw new IllegalStateException("cannot construct automatic schedule contract", error);
        }
    }

    private static String encodeURIComponent(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        StringBuilder output = new StringBuilder();
        final char[] hex = "0123456789ABCDEF".toCharArray();
        for (byte current : bytes) {
            int item = current & 0xff;
            char character = (char) item;
            if ((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9') || "-_.!~*'()".indexOf(character) >= 0) {
                output.append(character);
            } else {
                output.append('%').append(hex[item >>> 4]).append(hex[item & 15]);
            }
        }
        return output.toString();
    }

    private static void requireId(String value, String field) {
        require(value != null && ID.matcher(value).matches(), field);
    }

    private static void requireSha(String value, String field) {
        require(value != null && SHA.matcher(value).matches(), field);
    }

    private static void requireSafeNonNegative(long value, String field) {
        require(value >= 0L && value <= MAX_SAFE_INTEGER, field);
    }

    private static void require(boolean condition, String field) {
        if (!condition) throw invalid(field);
    }

    private static IllegalArgumentException invalid(String field) {
        return new IllegalArgumentException("invalid automatic schedule " + field);
    }

    private static Set<String> set(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }
}
