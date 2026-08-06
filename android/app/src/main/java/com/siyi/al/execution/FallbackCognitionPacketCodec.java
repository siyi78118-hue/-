package com.siyi.al.execution;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Splits the local v3 fallback container into its compact semantic view and
 * its local-only model execution carrier.  The carrier never belongs to the
 * wire envelope or the semantic snapshot checksum.
 */
public final class FallbackCognitionPacketCodec {
    private static final String V3_CONTRACT = "cognition-v3";
    private static final String FALLBACK_CONTRACT = "cognition-v3-fallback-v1";
    private static final Set<String> V3_REQUIRED_KEYS = new HashSet<>(Arrays.asList(
        "contract", "schemaVersion", "roleId", "hardConstraints", "preferences",
        "currentStances", "relationship", "recentGroups", "verifiedFacts", "lifeSignals",
        "authorSettings", "fallbackExecution"
    ));
    private static final Set<String> V3_ALLOWED_KEYS = new HashSet<>(Arrays.asList(
        "contract", "schemaVersion", "roleId", "hardConstraints", "preferences",
        "currentStances", "relationship", "recentGroups", "verifiedFacts", "lifeSignals",
        "authorSettings", "fallbackExecution"
    ));
    static {
        V3_ALLOWED_KEYS.add("_alBridgeProtocol");
    }
    private static final Set<String> EXECUTION_KEYS = new HashSet<>(Arrays.asList(
        "contract", "deviceId", "cognition", "expression"
    ));
    private static final Set<String> MODEL_KEYS = new HashSet<>(Arrays.asList(
        "configId", "system", "messages"
    ));
    private static final Set<String> MESSAGE_KEYS = new HashSet<>(Arrays.asList("role", "content"));

    public FallbackContext decode(JSONObject raw) throws Exception {
        if (raw == null) throw new IllegalArgumentException("fallback packet is required");
        JSONObject container = cloneObject(raw);
        String contract = stringOrEmpty(container.opt("contract"));
        if (V3_CONTRACT.equals(contract)) return decodeV3(container);

        String packetType = stringOrEmpty(container.opt("packetType"));
        if ("cognition-v2".equals(packetType)) {
            return new FallbackContext("cognition-v2", container, null, optionalString(container, "deviceId"));
        }
        if ("chat-v1".equals(packetType)) {
            return new FallbackContext("chat-v1", container, null, optionalString(container, "deviceId"));
        }
        if (packetType.isEmpty() && container.has("memoryConfigId") && container.has("chatConfigId")) {
            return new FallbackContext("memory-v1", container, null, optionalString(container, "deviceId"));
        }
        throw new IllegalArgumentException("UNSUPPORTED_FALLBACK_PACKET: " + (packetType.isEmpty() ? contract : packetType));
    }

    private FallbackContext decodeV3(JSONObject container) throws Exception {
        Set<String> actualKeys = keysOf(container);
        if (!actualKeys.containsAll(V3_REQUIRED_KEYS) || !V3_ALLOWED_KEYS.containsAll(actualKeys)) {
            throw new IllegalArgumentException("invalid cognition-v3 snapshot keys");
        }
        if (!(container.opt("schemaVersion") instanceof Number)
            || container.opt("schemaVersion") instanceof Float
            || container.opt("schemaVersion") instanceof Double
            || container.optInt("schemaVersion", -1) != 3) {
            throw new IllegalArgumentException("invalid cognition-v3 schemaVersion");
        }
        String roleId = requireString(container, "roleId");
        if (roleId.trim().isEmpty()) throw new IllegalArgumentException("roleId is required");
        JSONObject execution = requireObject(container, "fallbackExecution");
        FallbackExecution fallback = decodeExecution(execution);
        if (container.has("_alBridgeProtocol")) {
            JSONObject marker = requireObject(container, "_alBridgeProtocol");
            requireExactKeys(marker, new HashSet<>(Arrays.asList("version", "owner")), "bridge marker");
            if (!(marker.opt("version") instanceof Number) || marker.optInt("version", -1) != 3
                || !"room-v12".equals(requireString(marker, "owner"))) {
                throw new IllegalArgumentException("invalid bridge marker");
            }
        }
        JSONObject semantic = cloneObject(container);
        semantic.remove("fallbackExecution");
        semantic.remove("_alBridgeProtocol");
        return new FallbackContext(V3_CONTRACT, semantic, fallback, fallback.deviceId);
    }

    private FallbackExecution decodeExecution(JSONObject value) throws Exception {
        requireExactKeys(value, EXECUTION_KEYS, "fallbackExecution");
        if (!FALLBACK_CONTRACT.equals(requireString(value, "contract"))) {
            throw new IllegalArgumentException("invalid fallbackExecution contract");
        }
        String deviceId = requireString(value, "deviceId");
        if (deviceId.trim().isEmpty()) throw new IllegalArgumentException("fallback deviceId is required");
        ModelInput cognition = decodeModel(requireObject(value, "cognition"));
        ModelInput expression = decodeModel(requireObject(value, "expression"));
        return new FallbackExecution(FALLBACK_CONTRACT, deviceId, cognition, expression);
    }

    private ModelInput decodeModel(JSONObject value) throws Exception {
        requireExactKeys(value, MODEL_KEYS, "fallback model");
        String configId = requireString(value, "configId");
        String system = requireString(value, "system");
        JSONArray rawMessages = requireArray(value, "messages");
        if (rawMessages.length() > 200) throw new IllegalArgumentException("too many fallback messages");
        JSONArray messages = new JSONArray();
        for (int index = 0; index < rawMessages.length(); index += 1) {
            JSONObject message = rawMessages.optJSONObject(index);
            if (message == null) throw new IllegalArgumentException("fallback message must be an object");
            requireExactKeys(message, MESSAGE_KEYS, "fallback message");
            String role = requireString(message, "role");
            String content = requireString(message, "content");
            if (role.length() > 128 || content.length() > 100_000) {
                throw new IllegalArgumentException("fallback message exceeds size limit");
            }
            messages.put(new JSONObject().put("role", role).put("content", content));
        }
        if (configId.trim().isEmpty()) throw new IllegalArgumentException("fallback configId is required");
        return new ModelInput(configId, system, messages);
    }

    private static JSONObject requireObject(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof JSONObject)) throw new IllegalArgumentException("invalid object: " + key);
        return (JSONObject) raw;
    }

    private static JSONArray requireArray(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("invalid array: " + key);
        return (JSONArray) raw;
    }

    private static String requireString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException("invalid string: " + key);
        return (String) raw;
    }

    private static String optionalString(JSONObject value, String key) {
        Object raw = value.opt(key);
        return raw == null || raw == JSONObject.NULL ? null : raw instanceof String ? (String) raw : null;
    }

    private static String stringOrEmpty(Object raw) {
        return raw instanceof String ? (String) raw : "";
    }

    private static void requireExactKeys(JSONObject value, Set<String> expected, String label) {
        Set<String> actual = keysOf(value);
        if (!expected.equals(actual)) throw new IllegalArgumentException("invalid " + label + " keys");
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> actual = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) actual.add(iterator.next());
        return actual;
    }

    private static JSONObject cloneObject(JSONObject value) throws Exception {
        return new JSONObject(value.toString());
    }

    public static final class FallbackContext {
        public final String contract;
        public final JSONObject semanticView;
        public final FallbackExecution fallbackExecution;
        public final String deviceId;

        private FallbackContext(String contract, JSONObject semanticView, FallbackExecution fallbackExecution, String deviceId) {
            this.contract = contract;
            this.semanticView = semanticView;
            this.fallbackExecution = fallbackExecution;
            this.deviceId = deviceId;
        }
    }

    public static final class FallbackExecution {
        public final String contract;
        public final String deviceId;
        public final ModelInput cognition;
        public final ModelInput expression;

        private FallbackExecution(String contract, String deviceId, ModelInput cognition, ModelInput expression) {
            this.contract = contract;
            this.deviceId = deviceId;
            this.cognition = cognition;
            this.expression = expression;
        }
    }

    public static final class ModelInput {
        public final String configId;
        public final String system;
        public final JSONArray messages;

        private ModelInput(String configId, String system, JSONArray messages) {
            this.configId = configId;
            this.system = system;
            this.messages = messages;
        }
    }
}
