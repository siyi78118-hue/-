package com.siyi.al.execution.api;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

public final class ReplyParser {
    private static final Pattern PAYMENT = Pattern.compile("<al_send_payment>([\\s\\S]*?)</al_send_payment>", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAYMENT_STATUS = Pattern.compile("<al_payment>([\\s\\S]*?)</al_payment>", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCHEDULE = Pattern.compile("<al_schedule>([\\s\\S]*?)</al_schedule>", Pattern.CASE_INSENSITIVE);
    private static final Pattern NO_REPLY = Pattern.compile("^[（(]?对方没有回复[）)]?[。！!]?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern SENTENCE = Pattern.compile("[^。！？!?]+[。！？!?]+|[^。！？!?]+$");
    private static final int MAX_TEXT_PARTS = 12;
    private static final int LONG_SINGLE_BUBBLE = 30;

    public ParsedReply parse(String raw, String turnId, String attemptId) {
        String source = raw == null ? "" : raw;
        List<ParsedReplyPart> parts = new ArrayList<>();
        JSONObject payment = payment(source);
        JSONObject paymentStatus = directive(PAYMENT_STATUS, source);
        JSONObject schedule = directive(SCHEDULE, source);
        String clean = unwrapTextJson(clean(source));
        for (String line : clean.split("\\n+")) {
            String content = line.trim();
            if (content.isEmpty() || NO_REPLY.matcher(content).matches()) continue;
            for (String bubble : bubbleChunks(content)) {
                add(parts, turnId, attemptId, "TEXT", bubble, "{}");
                if (parts.size() >= MAX_TEXT_PARTS) break;
            }
            if (parts.size() >= MAX_TEXT_PARTS) break;
        }
        if (payment != null) {
            String type = payment.optString("type", "").toLowerCase(Locale.ROOT);
            double amount = Math.round(payment.optDouble("amount", 0) * 100.0) / 100.0;
            if (("redpacket".equals(type) || "transfer".equals(type)) && amount > 0) {
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("type", type);
                    payload.put("amount", amount);
                    payload.put("note", payment.optString("note", "").replaceAll("\\s+", " ").trim());
                    add(parts, turnId, attemptId, type.toUpperCase(Locale.ROOT), "", payload.toString());
                } catch (JSONException ignored) {
                    // Invalid structured payment data must not discard the visible text reply.
                }
            }
        }
        if (paymentStatus != null) {
            String status = paymentStatus.optString("status", "").toLowerCase(Locale.ROOT);
            if ("received".equals(status) || "pending".equals(status) || "refused".equals(status)) {
                add(parts, turnId, attemptId, "PAYMENT_STATUS", "", paymentStatus.toString());
            }
        }
        if (schedule != null && !schedule.optString("nextProactiveAt", "").trim().isEmpty()) {
            add(parts, turnId, attemptId, "SCHEDULE", "", schedule.toString());
        }
        return new ParsedReply(parts);
    }

    private static JSONObject payment(String source) {
        return directive(PAYMENT, source);
    }

    private static JSONObject directive(Pattern pattern, String source) {
        Matcher match = pattern.matcher(source);
        if (!match.find()) return null;
        try {
            return new JSONObject(match.group(1).trim());
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String clean(String source) {
        return PAYMENT.matcher(source)
            .replaceAll("")
            .replaceAll("(?is)<al_schedule>[\\s\\S]*?</al_schedule>", "")
            .replaceAll("(?is)<al_payment>[\\s\\S]*?</al_payment>", "")
            .replaceAll("(?m)^```(?:json)?|```$", "")
            .replaceAll("(?m)^(?:【|\\[)\\s*(?:发送时间|历史消息元数据).*?(?:】|\\])\\s*", "")
            .trim();
    }

    private static List<String> bubbleChunks(String content) {
        List<String> sentences = new ArrayList<>();
        if (content.length() <= LONG_SINGLE_BUBBLE) {
            sentences.add(content);
            return sentences;
        }
        Matcher matcher = SENTENCE.matcher(content);
        while (matcher.find()) {
            String sentence = matcher.group().trim();
            if (!sentence.isEmpty()) sentences.add(sentence);
        }
        if (sentences.size() < 2) {
            sentences.clear();
            sentences.add(content);
            return sentences;
        }
        List<String> bubbles = new ArrayList<>();
        for (int i = 0; i < sentences.size(); i++) {
            String sentence = sentences.get(i);
            if (sentence.length() < 9 && i + 1 < sentences.size()) {
                sentence += sentences.get(++i);
            }
            bubbles.add(sentence);
        }
        return bubbles;
    }

    private static String unwrapTextJson(String source) {
        String candidate = source.trim();
        try {
            JSONObject object = new JSONObject(candidate);
            Object text = object.opt("text");
            if (text instanceof String) return ((String) text).replaceAll("\\s+", " ").trim();
        } catch (JSONException ignored) {
            // Ordinary chat text is not JSON and should pass through unchanged.
        }
        return source;
    }

    private static void add(List<ParsedReplyPart> parts, String turnId, String attemptId, String type, String content, String payloadJson) {
        int sequence = parts.size();
        parts.add(new ParsedReplyPart(
            "part_" + turnId + "_" + sequence,
            turnId,
            attemptId,
            sequence,
            type,
            content,
            payloadJson
        ));
    }
}
