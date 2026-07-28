package com.siyi.al.execution;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

public final class LiveReplyQualityGate {
    private static final Pattern HIDDEN_TAGS = Pattern.compile(
        "<(?:al_schedule|al_plan|al_payment|al_send_payment|al_relationship_stage|al_moment_action)>\\s*[\\s\\S]*?\\s*</(?:al_schedule|al_plan|al_payment|al_send_payment|al_relationship_stage|al_moment_action)>",
        Pattern.CASE_INSENSITIVE
    );

    public Report inspect(String rawReply, Context context) {
        Context safe = context == null ? Context.chat() : context;
        String visible = visibleText(rawReply);
        List<String> hard = new ArrayList<>();
        List<String> soft = new ArrayList<>();
        if (Pattern.compile("\\b(?:end_turn|turn_end)\\b|<al_[a-z_]+>", Pattern.CASE_INSENSITIVE).matcher(visible).find()) {
            add(hard, "CONTROL_MARKER_LEAK");
        }
        if (Pattern.compile("^\\s*\\{[\\s\\S]*\"(?:reply|text|usedFactIds)\"\\s*:", Pattern.CASE_INSENSITIVE).matcher(visible).find()) {
            add(hard, "JSON_WRAPPER_LEAK");
        }
        if (Pattern.compile("(?:^|\\n)\\s*\\*[^*\\n]{1,100}\\*\\s*(?:$|\\n)|（\\s*(?:她|他|我)[^）]{0,80}）|\\[\\s*旁白\\s*\\]").matcher(visible).find()) {
            add(hard, "NARRATION_LEAK");
        }
        if (periodConflict(visible, safe.nowMs)) add(hard, "TIME_PERIOD_CONFLICT");
        if (!safe.lastAssistantText.isEmpty() && similarity(visible, safe.lastAssistantText) >= 0.9) {
            add(hard, "NEAR_DUPLICATE_REPLY");
        }
        long gap = safe.nowMs - safe.lastMessageAt;
        String firstBubble = firstBubble(visible);
        if ("proactive-chat".equals(safe.scene) && gap >= 2 * 60 * 60_000L
            && Pattern.compile("^(?:然后|还有呢|所以呢|那就|可是|但是|而且|至于|接着)").matcher(firstBubble).find()) {
            add(hard, "PROACTIVE_OPENING_MISSING");
        }
        int questions = countMatches(visible, "[？?]");
        if (questions >= 3) add(soft, "QUESTION_OVERLOAD");
        List<String> bubbles = bubbles(visible);
        if (bubbles.size() >= 2) {
            boolean allQuestions = true;
            for (String bubble : bubbles) if (!Pattern.compile("[？?]\\s*$").matcher(bubble).find()) allQuestions = false;
            if (allQuestions) add(soft, "ALL_BUBBLES_QUESTIONS");
        }
        boolean responsePressure = Pattern.compile("(?:怎么|为什么).{0,6}(?:不回|没回)|(?:回我|理我|在吗|干嘛呢|说话)").matcher(visible).find();
        if ("proactive-chat".equals(safe.scene) && "high".equals(safe.previousContactPressure) && responsePressure) {
            add(soft, "REPEATED_CONTACT_PRESSURE");
        }
        if ("proactive-chat".equals(safe.scene)
            && ("low".equals(safe.directorContactPressure) || "skip".equals(safe.directorReplyImpulse))
            && responsePressure) {
            add(soft, "DIRECTOR_PRESSURE_CONFLICT");
        }
        if (bubbles.size() == 1 && visible.length() > 180 && countMatches(visible, "[，。；！？!?]") >= 5) {
            add(soft, "OVERSIZED_SINGLE_BUBBLE");
        }
        boolean rewrite = !"payment".equals(safe.scene) && (!hard.isEmpty() || soft.size() >= 2);
        return new Report(hard, soft, visible, rewrite);
    }

    public boolean shouldRewrite(Report report) {
        return report != null && report.rewriteNeeded;
    }

    public String buildRewriteInstruction(String rawReply, Report report, String directorText, Context context) {
        Context safe = context == null ? Context.chat() : context;
        String codes = join(report == null ? Collections.<String>emptyList() : report.codes, ", ");
        String now = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.SIMPLIFIED_CHINESE).format(new Date(safe.nowMs));
        return "请重写下面这次回复。\n\n"
            + "只输出修正后的可见聊天正文，不输出 JSON、分析、标签、系统说明或导演卡。\n"
            + "保留原意、角色态度和关系边界，不要自动变得更温柔、更亲密。\n"
            + "如果需要多条气泡，用换行分隔。每轮只允许这一次重写。\n\n"
            + "当前场景：" + safe.scene + "；当前设备时间：" + now + "\n"
            + "需要修正的问题代码：" + (codes.isEmpty() ? "UNKNOWN" : codes)
            + (directorText == null || directorText.trim().isEmpty() ? "" : "\n\n本轮方向参考：\n" + directorText)
            + "\n\n原可见回复：\n" + visibleText(rawReply);
    }

    public static String visibleText(String rawReply) {
        return HIDDEN_TAGS.matcher(rawReply == null ? "" : rawReply)
            .replaceAll("")
            .replaceAll("\\n{3,}", "\n\n")
            .trim();
    }

    public static List<String> hiddenDirectives(String rawReply) {
        List<String> values = new ArrayList<>();
        Matcher matcher = HIDDEN_TAGS.matcher(rawReply == null ? "" : rawReply);
        while (matcher.find()) values.add(matcher.group().trim());
        return values;
    }

    public static String reattachDirectives(String visibleReply, List<String> directives) {
        StringBuilder result = new StringBuilder(visibleText(visibleReply));
        if (directives != null) for (String directive : directives) {
            if (directive == null || directive.trim().isEmpty()) continue;
            if (result.length() > 0) result.append('\n');
            result.append(directive.trim());
        }
        return result.toString();
    }

    public static final class Context {
        public final String scene;
        public final long nowMs;
        public final long lastMessageAt;
        public final String previousContactPressure;
        public final String lastAssistantText;
        public final String directorContactPressure;
        public final String directorReplyImpulse;

        public Context(String scene, long nowMs, long lastMessageAt, String previousContactPressure,
                       String lastAssistantText, String directorContactPressure, String directorReplyImpulse) {
            this.scene = scene;
            this.nowMs = nowMs;
            this.lastMessageAt = lastMessageAt;
            this.previousContactPressure = previousContactPressure;
            this.lastAssistantText = lastAssistantText == null ? "" : lastAssistantText;
            this.directorContactPressure = directorContactPressure == null ? "" : directorContactPressure;
            this.directorReplyImpulse = directorReplyImpulse == null ? "" : directorReplyImpulse;
        }

        public static Context chat() {
            return new Context("chat", System.currentTimeMillis(), 0, "none", "", "", "");
        }

        public static Context payment() {
            return new Context("payment", System.currentTimeMillis(), 0, "none", "", "", "");
        }

        public static Context proactive(long nowMs, long lastMessageAt, String previousContactPressure, String lastAssistantText) {
            return new Context("proactive-chat", nowMs, lastMessageAt, previousContactPressure, lastAssistantText, "", "");
        }

        public static Context fromSnapshot(JSONObject snapshot, String rawMemory) {
            DirectorCardCodec.Context directorContext = DirectorCardCodec.Context.fromSnapshot(snapshot);
            DirectorCardCodec.Result result = new DirectorCardCodec().parse(rawMemory, directorContext);
            JSONObject director = result.director;
            JSONObject raw = snapshot == null ? null : snapshot.optJSONObject("directorContext");
            return new Context(
                directorContext.scene,
                directorContext.nowMs,
                directorContext.lastMessageAt,
                directorContext.previousContactPressure,
                raw == null ? "" : raw.optString("lastAssistantText", ""),
                director.optString("contactPressure", ""),
                director.optString("replyImpulse", "")
            );
        }
    }

    public static final class Report {
        public final List<String> hardCodes;
        public final List<String> softCodes;
        public final List<String> codes;
        public final String visibleText;
        public final boolean rewriteNeeded;

        Report(List<String> hardCodes, List<String> softCodes, String visibleText, boolean rewriteNeeded) {
            this.hardCodes = Collections.unmodifiableList(new ArrayList<>(hardCodes));
            this.softCodes = Collections.unmodifiableList(new ArrayList<>(softCodes));
            List<String> combined = new ArrayList<>(hardCodes);
            combined.addAll(softCodes);
            this.codes = Collections.unmodifiableList(combined);
            this.visibleText = visibleText;
            this.rewriteNeeded = rewriteNeeded;
        }
    }

    private static boolean periodConflict(String text, long nowMs) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(nowMs <= 0 ? System.currentTimeMillis() : nowMs);
        int hour = calendar.get(Calendar.HOUR_OF_DAY);
        String current = hour < 5 ? "late" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "night";
        String cleaned = text.replaceAll("昨晚|昨天晚上|今早说过|早上说过|下午说过|晚上说过", "");
        if (Pattern.compile("(?:现在|这会儿|此刻).{0,3}(?:凌晨|半夜|深夜)").matcher(cleaned).find() && !"late".equals(current)) return true;
        if (Pattern.compile("(?:现在|这会儿|此刻).{0,3}(?:早上|上午|清晨)").matcher(cleaned).find() && !"morning".equals(current)) return true;
        if (Pattern.compile("(?:现在|这会儿|此刻).{0,3}(?:中午|下午)").matcher(cleaned).find() && !"afternoon".equals(current)) return true;
        return Pattern.compile("(?:现在|这会儿|此刻).{0,3}(?:晚上|夜里)").matcher(cleaned).find() && !"night".equals(current);
    }

    private static double similarity(String left, String right) {
        String a = comparable(left);
        String b = comparable(right);
        if (a.isEmpty() || b.isEmpty()) return 0;
        if (a.equals(b)) return 1;
        List<String> ag = grams(a);
        List<String> bg = grams(b);
        List<String> copy = new ArrayList<>(bg);
        int overlap = 0;
        for (String gram : ag) {
            int index = copy.indexOf(gram);
            if (index >= 0) {
                overlap++;
                copy.remove(index);
            }
        }
        return (2.0 * overlap) / (ag.size() + bg.size());
    }

    private static String comparable(String value) {
        return (value == null ? "" : value).toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{P}\\p{S}]+", "");
    }

    private static List<String> grams(String value) {
        if (value.length() < 2) return Collections.singletonList(value);
        List<String> grams = new ArrayList<>();
        for (int index = 0; index < value.length() - 1; index++) grams.add(value.substring(index, index + 2));
        return grams;
    }

    private static List<String> bubbles(String visible) {
        List<String> result = new ArrayList<>();
        for (String value : visible.split("\\n+")) if (!value.trim().isEmpty()) result.add(value.trim());
        return result;
    }

    private static String firstBubble(String visible) {
        List<String> values = bubbles(visible);
        return values.isEmpty() ? "" : values.get(0);
    }

    private static int countMatches(String value, String regex) {
        int count = 0;
        Matcher matcher = Pattern.compile(regex).matcher(value);
        while (matcher.find()) count++;
        return count;
    }

    private static void add(List<String> values, String value) {
        if (!values.contains(value)) values.add(value);
    }

    private static String join(List<String> values, String separator) {
        StringBuilder result = new StringBuilder();
        for (String value : values) {
            if (result.length() > 0) result.append(separator);
            result.append(value);
        }
        return result.toString();
    }
}
