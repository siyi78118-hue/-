package com.siyi.al.execution;

import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.List;

final class AlNotificationText {
    private AlNotificationText() {}

    static String fromParts(List<ReplyPartEntity> parts) {
        StringBuilder text = new StringBuilder();
        if (parts != null) {
            for (ReplyPartEntity part : parts) {
                String value = visibleText(part);
                if (value.isEmpty()) continue;
                if (text.length() > 0) text.append('\n');
                text.append(value);
            }
        }
        return text.length() == 0 ? "收到一条新消息" : text.toString();
    }

    private static String visibleText(ReplyPartEntity part) {
        if (part == null || part.type == null) return "";
        if ("TEXT".equals(part.type)) return part.content == null ? "" : part.content.trim();
        if ("REDPACKET".equals(part.type)) return "给你发了一个红包";
        if ("TRANSFER".equals(part.type)) return "向你发起了一笔转账";
        return "";
    }
}
