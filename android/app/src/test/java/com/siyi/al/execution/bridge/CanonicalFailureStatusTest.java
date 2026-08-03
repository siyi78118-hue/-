package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import com.siyi.al.execution.BridgeAuthority;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class CanonicalFailureStatusTest {
    @Test
    public void sharedFailureVectorsHaveStableUtf8CanonicalChecksums() throws Exception {
        JSONObject fixture = readFixture("canonical-failure-status-v1.json");
        assertEquals(1, fixture.getInt("version"));
        assertEquals("utf8-canonical-json-v1", fixture.getString("canonicalization"));
        JSONArray vectors = fixture.getJSONArray("vectors");
        for (int index = 0; index < vectors.length(); index += 1) {
            JSONObject wire = vectors.getJSONObject(index).getJSONObject("wire");
            JSONObject validated = BridgeAuthority.validateCanonicalFailureStatus(new JSONObject(wire.toString()));
            JSONObject checksumBasis = new JSONObject(wire.toString());
            checksumBasis.remove("rawStatusChecksum");
            assertEquals(wire.getString("rawStatusChecksum"), BridgeAuthority.sha256CanonicalJson(checksumBasis));
            assertEquals(BridgeAuthority.canonicalJson(wire), BridgeAuthority.canonicalJson(validated));
        }
    }

    @Test
    public void failureValidatorRejectsUnknownMissingCoercedAndChangedFields() throws Exception {
        JSONObject wire = readFixture("canonical-failure-status-v1.json")
            .getJSONArray("vectors").getJSONObject(2).getJSONObject("wire");

        JSONObject unknown = new JSONObject(wire.toString()).put("secret", "must-not-pass");
        assertInvalid(unknown);

        JSONObject coerced = new JSONObject(wire.toString()).put("retryAllowed", "true");
        assertInvalid(coerced);

        for (Object invalidFingerprint : new Object[] { "", 1L, true, new JSONObject() }) {
            assertInvalid(new JSONObject(wire.toString()).put("generationFingerprint", invalidFingerprint));
        }

        String[] closedFields = new String[] {
            "protocolVersion", "type", "turnId", "roleId", "authorityLineageKey", "lineageRevision",
            "turnRevision", "laneKey", "laneRevision", "retryOfTurnId", "inputVisibilitySequence",
            "inputClearEpoch", "generationFingerprint", "releaseId", "state", "errorCode",
            "failureClass", "retryAllowed", "failedAt", "rawStatusChecksum"
        };
        for (String requiredField : closedFields) {
            JSONObject missingField = new JSONObject(wire.toString());
            missingField.remove(requiredField);
            assertInvalid(missingField);
        }

        Map<String, Object> changedBasisFields = new LinkedHashMap<>();
        changedBasisFields.put("protocolVersion", 4L);
        changedBasisFields.put("type", "BACKLOG_FAILED_CHANGED");
        changedBasisFields.put("turnId", wire.getString("turnId") + "_changed");
        changedBasisFields.put("roleId", wire.getString("roleId") + "_changed");
        changedBasisFields.put("authorityLineageKey", wire.getString("authorityLineageKey") + "_changed");
        changedBasisFields.put("lineageRevision", wire.getLong("lineageRevision") + 1L);
        changedBasisFields.put("turnRevision", wire.getLong("turnRevision") + 1L);
        changedBasisFields.put("laneKey", wire.getString("laneKey") + "_changed");
        changedBasisFields.put("laneRevision", wire.getLong("laneRevision") + 1L);
        changedBasisFields.put("retryOfTurnId", wire.getString("retryOfTurnId") + "_changed");
        changedBasisFields.put("inputVisibilitySequence", wire.getLong("inputVisibilitySequence") + 1L);
        changedBasisFields.put("inputClearEpoch", wire.getLong("inputClearEpoch") + 1L);
        changedBasisFields.put("generationFingerprint", wire.getString("generationFingerprint") + "_changed");
        changedBasisFields.put("releaseId", wire.getString("releaseId") + "_changed");
        changedBasisFields.put("state", "queued");
        changedBasisFields.put("errorCode", "YUQI_DETERMINISTIC_EXECUTION_FAILURE");
        changedBasisFields.put("failureClass", "deterministic");
        changedBasisFields.put("retryAllowed", !wire.getBoolean("retryAllowed"));
        changedBasisFields.put("failedAt", wire.getLong("failedAt") + 1L);
        for (Map.Entry<String, Object> changedField : changedBasisFields.entrySet()) {
            assertInvalid(new JSONObject(wire.toString()).put(changedField.getKey(), changedField.getValue()));
        }

        assertInvalid(new JSONObject(wire.toString()).put("rawStatusChecksum", "invalid"));
        assertInvalid(new JSONObject(wire.toString()).put(
            "rawStatusChecksum", "0000000000000000000000000000000000000000000000000000000000000000"));
    }

    @Test
    public void checkpointOutcomeNamesAreClosedBeforeRoomPersistsThem() {
        assertEquals("open", BridgeAuthority.CheckpointOutcome.OPEN.wireName());
        assertEquals("verified_remote_failure", BridgeAuthority.CheckpointOutcome.VERIFIED_REMOTE_FAILURE.wireName());
        assertEquals("committed", BridgeAuthority.CheckpointOutcome.COMMITTED.wireName());
        assertEquals("redacted", BridgeAuthority.CheckpointOutcome.REDACTED.wireName());
        assertThrows(IllegalArgumentException.class, () -> BridgeAuthority.CheckpointOutcome.fromWire("OPEN"));
    }

    @Test
    public void canonicalJsonMatchesTheFixedPcVectorForNestedUnicodeAndControlCharacters() throws Exception {
        JSONObject value = new JSONObject()
            .put("\u4e2d\u6587", new JSONObject().put("slash", "/").put("emoji", "\uD83C\uDF27\uFE0F"))
            .put("b", new JSONArray().put(new JSONObject().put("z", "\uD83D\uDE42").put("a", "a/b\n\u0001")))
            .put("a", JSONObject.NULL);

        assertEquals(
            "{\"a\":null,\"b\":[{\"a\":\"a/b\\n\\u0001\",\"z\":\"\uD83D\uDE42\"}],\"\u4e2d\u6587\":{\"emoji\":\"\uD83C\uDF27\uFE0F\",\"slash\":\"/\"}}",
            BridgeAuthority.canonicalJson(value)
        );
        assertEquals(
            "27a60309369c09579fa307178dbd9f2bf7eaed8f60672276b9edfe336d4efd71",
            BridgeAuthority.sha256CanonicalJson(value)
        );
    }

    @Test
    public void canonicalJsonMatchesEcmaScriptNumberFormattingAndRejectsNonFiniteNumbers() throws Exception {
        JSONObject value = new JSONObject()
            .put("one", 1.0d)
            .put("quarter", 1.25d)
            .put("negativeZero", -0.0d)
            .put("small", 1e-7d)
            .put("huge", 1e21d)
            .put("nested", new JSONArray().put(new JSONObject()
                .put("integerLike", 10000000.0d)
                .put("threshold", 0.000001d)));

        assertEquals(
            "{\"huge\":1e+21,\"negativeZero\":0,\"nested\":[{\"integerLike\":10000000,\"threshold\":0.000001}],\"one\":1,\"quarter\":1.25,\"small\":1e-7}",
            BridgeAuthority.canonicalJson(value)
        );
        assertEquals(
            "3849e83a6745e20bc91a86af3f007eaa60b6e0528f3000d4d80e2aff34338404",
            BridgeAuthority.sha256CanonicalJson(value)
        );
        assertThrows(IllegalArgumentException.class, () -> BridgeAuthority.canonicalJson(Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> BridgeAuthority.canonicalJson(Double.POSITIVE_INFINITY));
        assertThrows(IllegalArgumentException.class, () -> BridgeAuthority.canonicalJson(Double.NEGATIVE_INFINITY));
    }

    private static void assertInvalid(JSONObject candidate) {
        assertThrows(IllegalArgumentException.class,
            () -> BridgeAuthority.validateCanonicalFailureStatus(candidate));
    }

    private static JSONObject readFixture(String name) throws Exception {
        File root = new File(System.getProperty("user.dir", "."));
        File fixture = new File(root, "tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../tests/fixtures/" + name);
        if (!fixture.isFile()) fixture = new File(root, "../../tests/fixtures/" + name);
        if (!fixture.isFile()) throw new IllegalStateException("fixture is missing: " + name);
        return new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
    }
}
