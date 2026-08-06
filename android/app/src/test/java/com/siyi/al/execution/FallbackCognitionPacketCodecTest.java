package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;

public class FallbackCognitionPacketCodecTest {
    @Test
    public void decodesV3ContainerAndSeparatesSemanticViewFallbackExecutionAndDevice() throws Exception {
        FallbackCognitionPacketCodec.FallbackContext value =
            new FallbackCognitionPacketCodec().decode(readFixture("cognition-v3.json"));

        assertEquals("cognition-v3", value.contract);
        assertEquals(3, value.semanticView.getInt("schemaVersion"));
        assertFalse(value.semanticView.has("fallbackExecution"));
        assertFalse(value.semanticView.has("deviceId"));
        assertNotNull(value.fallbackExecution);
        assertEquals("cognition-v3-fallback-v1", value.fallbackExecution.contract);
        assertEquals("device_v3", value.fallbackExecution.deviceId);
        assertEquals("memory-v3", value.fallbackExecution.cognition.configId);
        assertEquals("chat-v3", value.fallbackExecution.expression.configId);
        assertEquals("device_v3", value.deviceId);
    }

    @Test
    public void decodesV2AndV1CompatibilityFixtures() throws Exception {
        FallbackCognitionPacketCodec codec = new FallbackCognitionPacketCodec();
        assertEquals("cognition-v2", codec.decode(readFixture("cognition-v2.json")).contract);
        assertEquals("memory-v1", codec.decode(readFixture("memory-v1.json")).contract);
        assertEquals("chat-v1", codec.decode(readFixture("chat-v1.json")).contract);
    }

    @Test
    public void rejectsUnknownFallbackExecutionKeysAndNativeTypeCoercion() throws Exception {
        JSONObject raw = new JSONObject(readFixture("cognition-v3.json").toString());
        raw.getJSONObject("fallbackExecution").put("secret", "leak");
        assertThrows(IllegalArgumentException.class,
            () -> new FallbackCognitionPacketCodec().decode(raw));

        JSONObject typed = new JSONObject(readFixture("cognition-v3.json").toString());
        typed.getJSONObject("fallbackExecution").getJSONObject("cognition")
            .put("configId", 7);
        assertThrows(IllegalArgumentException.class,
            () -> new FallbackCognitionPacketCodec().decode(typed));
    }

    @Test
    public void rejectsV3SnapshotUnknownSemanticKey() throws Exception {
        JSONObject raw = new JSONObject(readFixture("cognition-v3.json").toString());
        raw.put("system", "must not be semantic snapshot data");
        assertThrows(IllegalArgumentException.class,
            () -> new FallbackCognitionPacketCodec().decode(raw));
    }

    @Test
    public void acceptsOptionalRoomMarkerButKeepsItOutOfSemanticView() throws Exception {
        JSONObject raw = new JSONObject(readFixture("cognition-v3.json").toString())
            .put("_alBridgeProtocol", new JSONObject().put("version", 3).put("owner", "room-v12"));
        FallbackCognitionPacketCodec.FallbackContext value =
            new FallbackCognitionPacketCodec().decode(raw);
        assertFalse(value.semanticView.has("_alBridgeProtocol"));
    }

    @Test
    public void rejectsEveryMissingRequiredSemanticKey() throws Exception {
        String[] required = new String[] {
            "contract", "schemaVersion", "roleId", "hardConstraints", "preferences",
            "currentStances", "relationship", "recentGroups", "verifiedFacts", "lifeSignals",
            "authorSettings", "fallbackExecution"
        };
        for (String key : required) {
            JSONObject raw = new JSONObject(readFixture("cognition-v3.json").toString());
            raw.remove(key);
            assertThrows(IllegalArgumentException.class,
                () -> new FallbackCognitionPacketCodec().decode(raw));
        }
    }

    private static JSONObject readFixture(String name) throws Exception {
        String path = "/fixtures/" + name;
        try (InputStream stream = FallbackCognitionPacketCodecTest.class.getResourceAsStream(path)) {
            if (stream == null) throw new IllegalArgumentException("missing fixture: " + path);
            return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
}
