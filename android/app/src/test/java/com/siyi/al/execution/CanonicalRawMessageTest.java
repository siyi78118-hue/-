package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

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

    private static Path fixturePath() {
        Path fromRoot = Paths.get("tests", "fixtures", "canonical-raw-message-v1.json");
        if (Files.exists(fromRoot)) return fromRoot;
        Path fromAndroid = Paths.get("..", "tests", "fixtures", "canonical-raw-message-v1.json");
        if (Files.exists(fromAndroid)) return fromAndroid;
        return Paths.get("..", "..", "tests", "fixtures", "canonical-raw-message-v1.json");
    }
}
