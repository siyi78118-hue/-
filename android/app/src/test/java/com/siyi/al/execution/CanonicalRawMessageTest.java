package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;

import com.siyi.al.execution.db.RawMessageEntity;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class CanonicalRawMessageTest {
    @Test
    public void derivesEveryFrozenRawMessageVectorFromExactlyElevenFields() throws Exception {
        JSONObject fixture = new JSONObject(new String(
            Files.readAllBytes(fixturePath()), StandardCharsets.UTF_8));
        JSONArray vectors = fixture.getJSONArray("vectors");
        for (int index = 0; index < vectors.length(); index += 1) {
            JSONObject vector = vectors.getJSONObject(index);
            JSONObject value = vector.getJSONObject("rawMessage");
            RawMessageEntity row = new RawMessageEntity();
            row.messageId = value.getString("messageId");
            row.turnId = value.getString("turnId");
            row.characterId = value.getString("characterId");
            row.speakerId = value.getString("speakerId");
            row.speakerType = value.getString("speakerType");
            row.recipientId = value.getString("recipientId");
            row.content = value.getString("content");
            row.sentAt = value.getLong("sentAt");
            row.origin = value.getString("origin");
            row.deviceId = value.getString("deviceId");
            row.deviceSeq = value.getLong("deviceSeq");

            assertEquals(vector.getString("canonicalJson"),
                RoomExecutionStore.canonicalRawMessageJson(row));
            assertEquals(vector.getString("rawMessageChecksum"),
                RoomExecutionStore.canonicalRawMessageChecksum(row));
            assertNotEquals(vector.getString("canonicalItemChecksum"),
                RoomExecutionStore.canonicalRawMessageChecksum(row));
        }
    }

    @Test
    public void recoveryAcceptsOnlyKnownHistoricalChecksumSchemes() throws Exception {
        RawMessageEntity row = new RawMessageEntity();
        row.messageId = "legacy-message";
        row.turnId = "legacy-turn";
        row.characterId = "yuqi";
        row.speakerId = "user";
        row.speakerType = "user";
        row.recipientId = "yuqi";
        row.content = "旧消息正文";
        row.sentAt = 123456789L;
        row.origin = "phone";
        row.deviceId = "phone:visible";
        row.deviceSeq = 1L;
        row.syncSeq = 1L;
        String canonical = RoomExecutionStore.canonicalRawMessageChecksum(row);

        row.checksum = canonical;
        assertEquals(canonical, RoomExecutionStore.recoverableRawMessageChecksum(row));

        row.checksum = row.messageId;
        assertEquals(canonical, RoomExecutionStore.recoverableRawMessageChecksum(row));

        row.checksum = "a8a8c00f8d77454372d895280c8f6e34c832cc3eaa22e8eeb519a455e1fc4297";
        assertEquals(canonical, RoomExecutionStore.recoverableRawMessageChecksum(row));

        row.checksum = "unknown-corruption";
        assertThrows(IllegalStateException.class,
            () -> RoomExecutionStore.recoverableRawMessageChecksum(row));
    }

    private static Path fixturePath() {
        Path fromRoot = Paths.get("tests", "fixtures", "canonical-raw-message-v1.json");
        if (Files.exists(fromRoot)) return fromRoot;
        Path fromAndroid = Paths.get("..", "tests", "fixtures", "canonical-raw-message-v1.json");
        if (Files.exists(fromAndroid)) return fromAndroid;
        return Paths.get("..", "..", "tests", "fixtures", "canonical-raw-message-v1.json");
    }
}
