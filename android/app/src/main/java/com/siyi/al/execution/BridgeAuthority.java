package com.siyi.al.execution;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Closed Android-side primitives for the v3 bridge authority contract. */
public final class BridgeAuthority {
    private static final Set<String> CANONICAL_FAILURE_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "turnId", "roleId", "authorityLineageKey", "lineageRevision",
        "turnRevision", "laneKey", "laneRevision", "retryOfTurnId", "inputVisibilitySequence",
        "inputClearEpoch", "generationFingerprint", "releaseId", "state", "errorCode",
        "failureClass", "retryAllowed", "failedAt", "rawStatusChecksum"
    )));
    private static final Set<String> TRANSIENT_FAILURE_CODES = Collections.singleton(
        "YUQI_TRANSIENT_EXECUTION_FAILURE");
    private static final Set<String> DETERMINISTIC_FAILURE_CODES = Collections.singleton(
        "YUQI_DETERMINISTIC_EXECUTION_FAILURE");

    private BridgeAuthority() {}

    public enum CheckpointOutcome {
        OPEN("open"),
        VERIFIED_REMOTE_FAILURE("verified_remote_failure"),
        COMMITTED("committed"),
        REDACTED("redacted");

        private final String wireName;

        CheckpointOutcome(String wireName) {
            this.wireName = wireName;
        }

        public String wireName() {
            return wireName;
        }

        public static CheckpointOutcome fromWire(String value) {
            if (!(value instanceof String)) throw new IllegalArgumentException("checkpoint outcome must be a string");
            for (CheckpointOutcome outcome : values()) {
                if (outcome.wireName.equals(value)) return outcome;
            }
            throw new IllegalArgumentException("unknown checkpoint outcome");
        }
    }

    public static JSONObject validateCanonicalFailureStatus(JSONObject input) {
        if (input == null) throw new IllegalArgumentException("canonical failure status is required");
        JSONObject value = copyObject(input);
        requireExactKeys(value, CANONICAL_FAILURE_KEYS, "canonical failure status");

        requireExactInteger(value, "protocolVersion", 3L);
        requireExactString(value, "type", "BACKLOG_FAILED");
        requireNonEmptyString(value, "turnId");
        requireNonEmptyString(value, "roleId");
        requireNonEmptyString(value, "authorityLineageKey");
        requireSafeNonNegativeInteger(value, "lineageRevision");
        requireSafeNonNegativeInteger(value, "turnRevision");
        requireNonEmptyString(value, "laneKey");
        requireSafeNonNegativeInteger(value, "laneRevision");
        requireNullableNonEmptyString(value, "retryOfTurnId");
        requireSafeNonNegativeInteger(value, "inputVisibilitySequence");
        requireSafeNonNegativeInteger(value, "inputClearEpoch");
        requireNullableNonEmptyString(value, "generationFingerprint");
        requireNonEmptyString(value, "releaseId");
        requireExactString(value, "state", "failed");

        String errorCode = requireString(value, "errorCode");
        String failureClass = requireString(value, "failureClass");
        if ("transient".equals(failureClass)) {
            if (!TRANSIENT_FAILURE_CODES.contains(errorCode)) {
                throw new IllegalArgumentException("invalid transient canonical failure code");
            }
        } else if ("deterministic".equals(failureClass)) {
            if (!DETERMINISTIC_FAILURE_CODES.contains(errorCode)) {
                throw new IllegalArgumentException("invalid deterministic canonical failure code");
            }
        } else {
            throw new IllegalArgumentException("invalid canonical failure class");
        }

        Object retryAllowed = getRequired(value, "retryAllowed");
        if (!(retryAllowed instanceof Boolean)) {
            throw new IllegalArgumentException("canonical failure retryAllowed must be a boolean");
        }
        if (((Boolean) retryAllowed) && !"transient".equals(failureClass)) {
            throw new IllegalArgumentException("deterministic canonical failure cannot retry");
        }
        requireSafePositiveInteger(value, "failedAt");

        String checksum = requireString(value, "rawStatusChecksum");
        if (!checksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("canonical failure checksum shape is invalid");
        }
        JSONObject checksumBasis = copyObject(value);
        checksumBasis.remove("rawStatusChecksum");
        if (!checksum.equals(sha256CanonicalJson(checksumBasis))) {
            throw new IllegalArgumentException("canonical failure checksum conflict");
        }
        return value;
    }

    public static String sha256CanonicalJson(Object value) {
        try {
            byte[] bytes = canonicalJson(value).getBytes(StandardCharsets.UTF_8);
            return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static String canonicalJson(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            java.util.ArrayList<String> keys = new java.util.ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            StringBuilder output = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index += 1) {
                if (index > 0) output.append(',');
                String key = keys.get(index);
                output.append(jsonQuote(key)).append(':').append(canonicalJson(getRequired(object, key)));
            }
            return output.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder output = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) output.append(',');
                output.append(canonicalJson(getRequired(array, index)));
            }
            return output.append(']').toString();
        }
        if (value instanceof String) return jsonQuote((String) value);
        if (value instanceof Boolean) return String.valueOf(value);
        if (value instanceof Number) return canonicalNumber((Number) value);
        throw new IllegalArgumentException("canonical JSON value type is invalid");
    }

    private static String canonicalNumber(Number value) {
        double number = value.doubleValue();
        if (!Double.isFinite(number)) {
            throw new IllegalArgumentException("canonical JSON number must be finite");
        }
        if (number == 0.0d) return "0";

        BigDecimal exact = new BigDecimal(number);
        BigDecimal shortest = null;
        long expectedBits = Double.doubleToRawLongBits(number);
        for (int precision = 1; precision <= 17; precision += 1) {
            BigDecimal candidate = exact.round(new MathContext(precision, RoundingMode.HALF_EVEN)).stripTrailingZeros();
            if (Double.doubleToRawLongBits(Double.parseDouble(candidate.toString())) == expectedBits) {
                shortest = candidate;
                break;
            }
        }
        if (shortest == null) {
            throw new IllegalArgumentException("canonical JSON number cannot be represented");
        }

        BigDecimal absolute = shortest.abs();
        if (absolute.compareTo(new BigDecimal("0.000001")) >= 0
                && absolute.compareTo(new BigDecimal("1e21")) < 0) {
            return shortest.toPlainString();
        }

        String digits = absolute.unscaledValue().toString();
        int exponent = digits.length() - absolute.scale() - 1;
        String mantissa = digits.length() == 1
            ? digits
            : digits.substring(0, 1) + "." + digits.substring(1);
        return (shortest.signum() < 0 ? "-" : "")
            + mantissa
            + "e"
            + (exponent >= 0 ? "+" : "")
            + exponent;
    }

    private static void requireExactKeys(JSONObject value, Set<String> expected, String label) {
        Set<String> actual = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) actual.add(iterator.next());
        if (!actual.equals(expected)) throw new IllegalArgumentException(label + " keys conflict");
    }

    private static String requireString(JSONObject value, String key) {
        Object raw = getRequired(value, key);
        if (!(raw instanceof String)) throw new IllegalArgumentException("canonical failure " + key + " must be a string");
        return (String) raw;
    }

    private static void requireNonEmptyString(JSONObject value, String key) {
        if (requireString(value, key).isEmpty()) {
            throw new IllegalArgumentException("canonical failure " + key + " must not be empty");
        }
    }

    private static void requireNullableNonEmptyString(JSONObject value, String key) {
        Object raw = getRequired(value, key);
        if (raw == JSONObject.NULL) return;
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("canonical failure " + key + " must be a string or null");
        }
    }

    private static void requireExactString(JSONObject value, String key, String expected) {
        if (!expected.equals(requireString(value, key))) {
            throw new IllegalArgumentException("canonical failure " + key + " conflict");
        }
    }

    private static void requireExactInteger(JSONObject value, String key, long expected) {
        if (requireSafeInteger(value, key) != expected) {
            throw new IllegalArgumentException("canonical failure " + key + " conflict");
        }
    }

    private static void requireSafeNonNegativeInteger(JSONObject value, String key) {
        if (requireSafeInteger(value, key) < 0) {
            throw new IllegalArgumentException("canonical failure " + key + " must be non-negative");
        }
    }

    private static void requireSafePositiveInteger(JSONObject value, String key) {
        if (requireSafeInteger(value, key) <= 0) {
            throw new IllegalArgumentException("canonical failure " + key + " must be positive");
        }
    }

    private static long requireSafeInteger(JSONObject value, String key) {
        Object raw = getRequired(value, key);
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("canonical failure " + key + " must be an integer");
        }
        long number = ((Number) raw).longValue();
        if (number < -9007199254740991L || number > 9007199254740991L) {
            throw new IllegalArgumentException("canonical failure " + key + " is outside the safe range");
        }
        return number;
    }

    private static String jsonQuote(String value) {
        return JSONObject.quote(value).replace("\\/", "/");
    }

    private static JSONObject copyObject(JSONObject value) {
        try {
            return new JSONObject(value.toString());
        } catch (JSONException error) {
            throw new IllegalArgumentException("canonical JSON object is invalid", error);
        }
    }

    private static Object getRequired(JSONObject value, String key) {
        try {
            return value.get(key);
        } catch (JSONException error) {
            throw new IllegalArgumentException("canonical JSON object field is missing: " + key, error);
        }
    }

    private static Object getRequired(JSONArray value, int index) {
        try {
            return value.get(index);
        } catch (JSONException error) {
            throw new IllegalArgumentException("canonical JSON array item is missing", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }
}
