package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;

import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.Arrays;
import org.junit.Test;

public class AlNotificationTextTest {
    @Test
    public void joinsEveryVisibleReplyPartInOrder() {
        ReplyPartEntity first = part("TEXT", "第一句");
        ReplyPartEntity second = part("TEXT", "第二句");
        ReplyPartEntity redPacket = part("REDPACKET", "");

        assertEquals(
            "第一句\n第二句\n给你发了一个红包",
            AlNotificationText.fromParts(Arrays.asList(first, second, redPacket))
        );
    }

    @Test
    public void fallsBackWhenNoVisiblePartExists() {
        assertEquals("收到一条新消息", AlNotificationText.fromParts(Arrays.asList(part("UNKNOWN", "ignored"))));
    }

    private static ReplyPartEntity part(String type, String content) {
        ReplyPartEntity part = new ReplyPartEntity();
        part.type = type;
        part.content = content;
        return part;
    }
}
