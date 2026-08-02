package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
            .getJSONArray("vectors").getJSONObject(0).getJSONObject("wire");

        JSONObject unknown = new JSONObject(wire.toString()).put("secret", "must-not-pass");
        assertInvalid(unknown);

        JSONObject missing = new JSONObject(wire.toString());
        missing.remove("retryAllowed");
        assertInvalid(missing);

        JSONObject coerced = new JSONObject(wire.toString()).put("retryAllowed", "true");
        assertInvalid(coerced);

        JSONObject changed = new JSONObject(wire.toString()).put("laneRevision", wire.getLong("laneRevision") + 1L);
        assertInvalid(changed);
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
