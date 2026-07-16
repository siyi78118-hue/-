package com.siyi.al.execution.api;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

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
    public void preservesAllTextWhenReplyExceedsTheTwelveBubbleStorageLimit() {
        StringBuilder source = new StringBuilder();
        for (int index = 1; index <= 16; index++) {
            if (index > 1) source.append('\n');
            source.append("第").append(index).append("段回复。");
        }

        ParsedReply parsed = parser.parse(source.toString(), "turn-overflow", "attempt-overflow");

        assertEquals(12, parsed.parts.size());
        StringBuilder restored = new StringBuilder();
        for (ParsedReplyPart part : parsed.parts) restored.append(part.content.replace("\n", ""));
        assertEquals(source.toString().replace("\n", ""), restored.toString());
        assertEquals("第12段回复。\n第13段回复。\n第14段回复。\n第15段回复。\n第16段回复。", parsed.parts.get(11).content);
    }

    @Test
    public void emitsPlanPartWithoutLeakingDirective() {
        ParsedReply parsed = parser.parse(
            "早。\n我九点再找你。\n<al_plan>{\"operations\":[{\"op\":\"create\",\"type\":\"private_message\"}]}</al_plan>",
            "turn-plan",
            "attempt-plan"
        );

        assertEquals(3, parsed.parts.size());
        assertEquals("早。", parsed.parts.get(0).content);
        assertEquals("我九点再找你。", parsed.parts.get(1).content);
        assertEquals("PLAN", parsed.parts.get(2).type);
        assertTrue(parsed.parts.get(2).payloadJson.contains("operations"));
    }

    @Test
    public void invalidPlanJsonKeepsVisibleReply() {
        ParsedReply parsed = parser.parse(
            "知道了。<al_plan>{bad}</al_plan>",
            "turn-plan-invalid",
            "attempt-plan-invalid"
        );

        assertEquals(1, parsed.parts.size());
        assertEquals("知道了。", parsed.parts.get(0).content);
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
    public void separatesMediumTwoSentenceReplyIntoChatBubbles() {
        ParsedReply parsed = parser.parse(
            "还在纠结，食堂大概率还是那碗看不出内容的盖浇饭。有点想点外卖，但打开软件又开始决定困难。",
            "turn-medium",
            "attempt-medium"
        );

        assertEquals(2, parsed.parts.size());
        assertEquals("还在纠结，食堂大概率还是那碗看不出内容的盖浇饭。", parsed.parts.get(0).content);
        assertEquals("有点想点外卖，但打开软件又开始决定困难。", parsed.parts.get(1).content);
    }

    @Test
    public void restoresChineseChatBubblesWhenProviderFlattensLineBreaksToSpaces() {
        ParsedReply parsed = parser.parse(
            "手机静音躺床上，能十分钟摸回来已经是极限了 我又不是客服，还得主动巡逻你在不在😌 想聊天白天聊，凌晨两点的聊天质量堪忧 你现在这状态，明天上班就是行尸走肉 快睡，这是姐姐令箭，不接受反驳",
            "turn-spaces",
            "attempt-spaces"
        );

        assertEquals(5, parsed.parts.size());
        assertEquals("手机静音躺床上，能十分钟摸回来已经是极限了", parsed.parts.get(0).content);
        assertEquals("我又不是客服，还得主动巡逻你在不在😌", parsed.parts.get(1).content);
        assertEquals("想聊天白天聊，凌晨两点的聊天质量堪忧", parsed.parts.get(2).content);
        assertEquals("你现在这状态，明天上班就是行尸走肉", parsed.parts.get(3).content);
        assertEquals("快睡，这是姐姐令箭，不接受反驳", parsed.parts.get(4).content);
    }

    @Test
    public void discardsProviderEndTurnControlMarker() {
        ParsedReply parsed = parser.parse(
            "正文还在这里\nend_turn",
            "turn-marker",
            "attempt-marker"
        );

        assertEquals(1, parsed.parts.size());
        assertEquals("正文还在这里", parsed.parts.get(0).content);
    }

    @Test
    public void unwrapsMomentTextJsonInsteadOfShowingTheWrapper() {
        ParsedReply parsed = parser.parse(
            "{\"text\":\"今晚早点睡。\"}",
            "turn-moment",
            "attempt-moment"
        );

        assertEquals(1, parsed.parts.size());
        assertEquals("今晚早点睡。", parsed.parts.get(0).content);
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
