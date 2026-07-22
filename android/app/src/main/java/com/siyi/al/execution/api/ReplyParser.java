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
    private static final Pattern RELATIONSHIP_STAGE = Pattern.compile("<al_relationship_stage>([\\s\\S]*?)</al_relationship_stage>", Pattern.CASE_INSENSITIVE);
    private static final Pattern MOMENT_ACTION = Pattern.compile("<al_moment_action>([\\s\\S]*?)</al_moment_action>", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCHEDULE = Pattern.compile("<al_schedule>([\\s\\S]*?)</al_schedule>", Pattern.CASE_INSENSITIVE);
    private static final Pattern PLAN = Pattern.compile("<al_plan>([\\s\\S]*?)</al_plan>", Pattern.CASE_INSENSITIVE);
    private static final Pattern NO_REPLY = Pattern.compile("^[（(]?对方没有回复[）)]?[。！!]?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern CONTROL_MARKER_SUFFIX = Pattern.compile(
        "(?:^|\\s+)(?:<\\s*)?(?:end[\\s_-]*turn|turn[\\s_-]*end)(?:\\s*>)?\\s*$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern SENTENCE = Pattern.compile("[^。！？!?]+[。！？!?]+|[^。！？!?]+$");
    private static final int MAX_TEXT_PARTS = 12;
    private static final int LONG_SINGLE_BUBBLE = 30;

    public ParsedReply parse(String raw, String turnId, String attemptId) {
        String source = raw == null ? "" : raw;
        List<ParsedReplyPart> parts = new ArrayList<>();
        List<String> textBubbles = new ArrayList<>();
        JSONObject payment = payment(source);
        JSONObject paymentStatus = directive(PAYMENT_STATUS, source);
        JSONObject relationshipStage = directive(RELATIONSHIP_STAGE, source);
        JSONObject momentAction = directive(MOMENT_ACTION, source);
        JSONObject schedule = directive(SCHEDULE, source);
        JSONObject plan = directive(PLAN, source);
        String clean = unwrapTextJson(clean(source));
        for (String line : clean.split("\\n+")) {
            String content = CONTROL_MARKER_SUFFIX.matcher(line.trim()).replaceFirst("").trim();
            if (content.isEmpty() || NO_REPLY.matcher(content).matches()) continue;
            textBubbles.addAll(bubbleChunks(content));
        }
        for (String bubble : collapseTextBubbles(textBubbles)) {
            add(parts, turnId, attemptId, "TEXT", bubble, "{}");
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
        if (relationshipStage != null && !relationshipStage.optString("to", "").trim().isEmpty()) {
            add(parts, turnId, attemptId, "RELATIONSHIP_STAGE", "", relationshipStage.toString());
        }
        if (momentAction != null && !momentAction.optString("momentId", "").trim().isEmpty()
            && (momentAction.optBoolean("like", false) || !momentAction.optString("comment", "").trim().isEmpty())) {
            add(parts, turnId, attemptId, "MOMENT_ACTION", "", momentAction.toString());
        }
        if (schedule != null && !schedule.optString("nextProactiveAt", "").trim().isEmpty()) {
            add(parts, turnId, attemptId, "SCHEDULE", "", schedule.toString());
        }
        if (plan != null && plan.optJSONArray("operations") != null && plan.optJSONArray("operations").length() > 0) {
            add(parts, turnId, attemptId, "PLAN", "", plan.toString());
        }
        return new ParsedReply(parts);
    }

    private static List<String> collapseTextBubbles(List<String> bubbles) {
        if (bubbles.size() <= MAX_TEXT_PARTS) return bubbles;
        List<String> collapsed = new ArrayList<>(bubbles.subList(0, MAX_TEXT_PARTS - 1));
        collapsed.add(String.join("\n", bubbles.subList(MAX_TEXT_PARTS - 1, bubbles.size())));
        return collapsed;
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
            .replaceAll("(?is)<al_plan>[\\s\\S]*?</al_plan>", "")
            .replaceAll("(?is)<al_payment>[\\s\\S]*?</al_payment>", "")
            .replaceAll("(?is)<al_relationship_stage>[\\s\\S]*?</al_relationship_stage>", "")
            .replaceAll("(?is)<al_moment_action>[\\s\\S]*?</al_moment_action>", "")
            .replaceAll("(?m)^```(?:json)?|```$", "")
            .replaceAll("(?m)^(?:【|\\[)\\s*(?:发送时间|历史消息元数据).*?(?:】|\\])\\s*", "")
            .trim();
    }

    private static List<String> bubbleChunks(String content) {
        if (content.length() <= LONG_SINGLE_BUBBLE) {
            List<String> single = new ArrayList<>();
            single.add(content);
            return single;
        }
        List<String> flattenedLines = splitFlattenedChineseLines(content);
        if (flattenedLines.size() > 1) {
            List<String> bubbles = new ArrayList<>();
            for (String line : flattenedLines) bubbles.addAll(sentenceChunks(line));
            return bubbles;
        }
        return sentenceChunks(content);
    }

    private static List<String> sentenceChunks(String content) {
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

    private static List<String> splitFlattenedChineseLines(String content) {
        List<String> chunks = new ArrayList<>();
        int start = 0;
        int index = 0;
        while (index < content.length()) {
            int codePoint = content.codePointAt(index);
            if (!Character.isWhitespace(codePoint) && !Character.isSpaceChar(codePoint)) {
                index += Character.charCount(codePoint);
                continue;
            }
            int whitespaceStart = index;
            while (index < content.length()) {
                int whitespace = content.codePointAt(index);
                if (!Character.isWhitespace(whitespace) && !Character.isSpaceChar(whitespace)) break;
                index += Character.charCount(whitespace);
            }
            if (whitespaceStart <= start || index >= content.length()) continue;
            int left = content.codePointBefore(whitespaceStart);
            int right = content.codePointAt(index);
            if (isChineseMessageBoundaryLeft(left) && isHan(right)) {
                String chunk = content.substring(start, whitespaceStart).trim();
                if (!chunk.isEmpty()) chunks.add(chunk);
                start = index;
            }
        }
        String tail = content.substring(start).trim();
        if (!tail.isEmpty()) chunks.add(tail);
        if (chunks.size() < 2) {
            chunks.clear();
            chunks.add(content);
        }
        return chunks;
    }

    private static boolean isChineseMessageBoundaryLeft(int codePoint) {
        return isHan(codePoint)
            || (codePoint >= 0x1F300 && codePoint <= 0x1FAFF)
            || "。！？!?…".indexOf(codePoint) >= 0;
    }

    private static boolean isHan(int codePoint) {
        return Character.UnicodeScript.of(codePoint) == Character.UnicodeScript.HAN;
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
