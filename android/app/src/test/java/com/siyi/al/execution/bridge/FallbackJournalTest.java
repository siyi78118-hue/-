package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.db.RawMessageEntity;
import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Test;

public class FallbackJournalTest {
    @Test public void packetKeepsExactSpeakerAndMarksFallbackOrigin() throws Exception {
        RawMessageEntity user = message("msg_user_1", "user", "user", "phone", 10L, "你在吗");
        RawMessageEntity reply = message("msg_reply_1", "yuqi", "character", "fallback", 11L, "在。刚才只是没接上。");
        JSONObject packet = FallbackJournal.buildPacket("phone_a", 9L, Arrays.asList(user, reply));

        assertEquals("phone_a", packet.getString("peerId"));
        assertEquals(11L, packet.getLong("lastSeq"));
        assertEquals("user", packet.getJSONArray("entries").getJSONObject(0).getJSONObject("payload").getString("speakerId"));
        assertEquals("fallback", packet.getJSONArray("entries").getJSONObject(1).getJSONObject("payload").getString("origin"));
        assertEquals(
            "f0d12a6ddc5cbfe922e02b27a527e061fd741c5d0a236fe36f98fbb8c04539b6",
            packet.getJSONArray("entries").getJSONObject(1).getString("checksum")
        );
    }

    @Test public void checksumMatchesJavascriptCanonicalJsonWhenContentContainsClosingTag() throws Exception {
        RawMessageEntity reply = message(
            "msg_slash",
            "yuqi",
            "character",
            "fallback",
            12L,
            "<al_schedule>{\"next\":\"later\"}</al_schedule>"
        );
        JSONObject packet = FallbackJournal.buildPacket("phone_a", 11L, Arrays.asList(reply));

        assertEquals(
            "05ad0d2a6abc19e6b6aa7b0b1af1b2e4dfe891107e7c8415864241b364b41af5",
            packet.getJSONArray("entries").getJSONObject(0).getString("checksum")
        );
    }

    private static RawMessageEntity message(String id, String speakerId, String speakerType, String origin, long seq, String content) {
        RawMessageEntity value = new RawMessageEntity();
        value.messageId = id;
        value.turnId = "turn_1";
        value.characterId = "yuqi";
        value.speakerId = speakerId;
        value.speakerType = speakerType;
        value.recipientId = "user".equals(speakerId) ? "yuqi" : "user";
        value.content = content;
        value.sentAt = 1784400000000L + seq;
        value.origin = origin;
        value.deviceId = "fallback".equals(origin) ? "phone_a:fallback" : "phone_a";
        value.deviceSeq = seq;
        value.syncSeq = seq;
        return value;
    }
}
