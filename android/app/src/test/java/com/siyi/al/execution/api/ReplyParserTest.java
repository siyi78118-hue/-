package com.siyi.al.execution.api;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class ReplyParserTest {
    private final ReplyParser parser = new ReplyParser();

    @Test
    public void parsesEmojiAndPaymentWithoutLeakingDirective() {
        ParsedReply parsed = parser.parse(
            "晚安🙂\n<al_send_payment>{\"type\":\"redpacket\",\"amount\":8.8,\"note\":\"早餐\"}</al_send_payment>",
            "turn-1",
            "attempt-1"
        );

        assertEquals(2, parsed.parts.size());
        assertEquals("TEXT", parsed.parts.get(0).type);
        assertEquals("晚安🙂", parsed.parts.get(0).content);
        assertEquals("REDPACKET", parsed.parts.get(1).type);
        assertFalse(parsed.parts.get(0).content.contains("al_send_payment"));
    }

    @Test
    public void separatesNaturalConsecutiveMessagesByLine() {
        ParsedReply parsed = parser.parse("刚下课\n去食堂的路上\n你吃了吗", "turn-2", "attempt-2");

        assertEquals(3, parsed.parts.size());
        assertEquals("刚下课", parsed.parts.get(0).content);
        assertEquals("去食堂的路上", parsed.parts.get(1).content);
        assertEquals("你吃了吗", parsed.parts.get(2).content);
    }

    @Test
    public void separatesLongUnbrokenMultiSentenceReplyIntoChatBubbles() {
        ParsedReply parsed = parser.parse(
            "自己的软件？听起来你还挺厉害。无非就是哪天让你请杯冷萃。又不是攒着卖钱，你紧张什么？快十一点半了，修完赶紧回去。",
            "turn-long",
            "attempt-long"
        );

        assertEquals(4, parsed.parts.size());
        assertEquals("自己的软件？听起来你还挺厉害。", parsed.parts.get(0).content);
        assertEquals("无非就是哪天让你请杯冷萃。", parsed.parts.get(1).content);
        assertEquals("又不是攒着卖钱，你紧张什么？", parsed.parts.get(2).content);
        assertEquals("快十一点半了，修完赶紧回去。", parsed.parts.get(3).content);
    }

    @Test
    public void removesLeakedTimeMetadataAndNoReplyPlaceholder() {
        ParsedReply parsed = parser.parse(
            "【发送时间 2026-07-13 15:30】下午好\n（对方没有回复）",
            "turn-3",
            "attempt-3"
        );

        assertEquals(1, parsed.parts.size());
        assertEquals("下午好", parsed.parts.get(0).content);
    }

    @Test
    public void preservesHiddenScheduleAndPaymentStatusAsMetadata() throws Exception {
        ParsedReply parsed = parser.parse(
            "行，那我收下了。\n<al_payment>{\"status\":\"received\"}</al_payment>\n" +
                "<al_schedule>{\"nextProactiveAt\":\"2026-07-13T18:30:00+08:00\"}</al_schedule>",
            "turn-4",
            "attempt-4"
        );

        assertEquals(3, parsed.parts.size());
        assertEquals("TEXT", parsed.parts.get(0).type);
        assertEquals("PAYMENT_STATUS", parsed.parts.get(1).type);
        assertEquals("received", new org.json.JSONObject(parsed.parts.get(1).payloadJson).getString("status"));
        assertEquals("SCHEDULE", parsed.parts.get(2).type);
        assertEquals(
            "2026-07-13T18:30:00+08:00",
            new org.json.JSONObject(parsed.parts.get(2).payloadJson).getString("nextProactiveAt")
        );
    }
}
