package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class AuthorityIdentityTest {
    @Test
    public void sharedIdentityVectorsUseUtf8LengthAndDecimalOrdinals() throws Exception {
        JSONObject fixture = readFixture("authority-identity-v1.json");
        assertEquals("al-authority-v1", fixture.getString("algorithm"));
        JSONArray vectors = fixture.getJSONArray("vectors");
        for (int index = 0; index < vectors.length(); index += 1) {
            JSONObject vector = vectors.getJSONObject(index);
            String lineageKey = AuthorityIdentity.lineageKey(
                vector.getString("roleId"),
                vector.getString("laneKey"),
                vector.getString("rootSourceId")
            );
            String groupId = AuthorityIdentity.groupId(lineageKey);
            long ordinal = vector.getLong("ordinal");
            assertEquals(vector.getString("lineageKey"), lineageKey);
            assertEquals(vector.getString("groupId"), groupId);
            assertEquals(vector.getString("messageId"), AuthorityIdentity.messageId(groupId, ordinal));
            assertEquals(vector.getString("actionId"), AuthorityIdentity.actionId(groupId, ordinal));
            assertEquals(
                vector.getString("remoteRetryTurnId"),
                AuthorityIdentity.remoteRetryTurnId(vector.getString("attemptId"))
            );
        }
    }

    @Test
    public void identityRejectsOrdinalsOutsideTheJavaScriptSafeIntegerProtocolDomain() {
        assertThrows(IllegalArgumentException.class,
            () -> AuthorityIdentity.messageId("grp_test", -1L));
        assertThrows(IllegalArgumentException.class,
            () -> AuthorityIdentity.actionId("grp_test", -1L));
        assertThrows(IllegalArgumentException.class,
            () -> AuthorityIdentity.messageId("grp_test", 9007199254740992L));
        assertThrows(IllegalArgumentException.class,
            () -> AuthorityIdentity.actionId("grp_test", 9007199254740992L));
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
