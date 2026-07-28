package com.siyi.al.execution;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class DirectorCardCodec {
    private static final Set<String> SCENES = set("chat", "proactive-chat", "payment");
    private static final Set<String> TIME_GAPS = set("instant", "short", "hours", "overnight", "days");
    private static final Set<String> SILENCE_CAUSES = set(
        "not_applicable", "natural_pause", "temporary_absence", "conflict",
        "explicit_distance", "repeated_unexplained", "uncertain"
    );
    private static final Set<String> PRESSURES = set("none", "low", "medium", "high");
    private static final Set<String> IMPULSES = set("answer", "share", "tease", "refuse", "check_in", "repair", "pause", "skip");
    private static final Set<String> STAGES = set("new", "acquainted", "familiar", "close", "committed");

    public Result parse(String rawMemory, Context context) {
        Context safeContext = context == null ? Context.chat() : context;
        String raw = rawMemory == null ? "" : rawMemory.trim();
        String memoryPack = raw;
        JSONObject sourceDirector = null;
        List<String> issues = new ArrayList<>();
        try {
            JSONObject root = new JSONObject(raw);
            memoryPack = root.optString("memoryPack", "");
            sourceDirector = root.optJSONObject("director");
        } catch (Exception ignored) {
            issues.add("MEMORY_NOT_JSON");
        }
        JSONObject director = normalize(sourceDirector, safeContext, issues);
        String source = sourceDirector == null ? "fallback" : "memory-ai";
        return new Result(memoryPack, director, source, issues);
    }

    public static String directorText(String rawMemory, JSONObject snapshot) {
        Context context = Context.fromSnapshot(snapshot);
        Result result = new DirectorCardCodec().parse(rawMemory, context);
        return formatDirector(result.director, snapshot == null ? "我" : snapshot.optString("playerName", "我"),
            snapshot == null ? "AL" : snapshot.optString("characterName", "AL"));
    }

    private JSONObject normalize(JSONObject raw, Context context, List<String> issues) {
        JSONObject fallback = fallback(context);
        if (raw == null) {
            issues.add("DIRECTOR_NOT_OBJECT");
            return fallback;
        }
        JSONObject card = new JSONObject();
        put(card, "schemaVersion", 1);
        put(card, "scene", enumValue(raw.optString("scene"), SCENES, fallback.optString("scene")));
        put(card, "timeGap", enumValue(raw.optString("timeGap"), TIME_GAPS, fallback.optString("timeGap")));
        String silence = enumValue(raw.optString("silenceCause"), SILENCE_CAUSES, fallback.optString("silenceCause"));
        if ("chat".equals(card.optString("scene"))) silence = "not_applicable";
        put(card, "silenceCause", silence);
        put(card, "previousContactPressure", enumValue(raw.optString("previousContactPressure"), PRESSURES,
            fallback.optString("previousContactPressure")));
        put(card, "relationshipStageId", enumValue(raw.optString("relationshipStageId"), STAGES,
            fallback.optString("relationshipStageId")));
        put(card, "playerIntent", compact(raw.optString("playerIntent"), 60));
        put(card, "playerIntentConfidence", confidence(raw.optDouble("playerIntentConfidence", 0)));
        put(card, "currentMood", compact(raw.optString("currentMood"), 24));
        put(card, "moodCause", compact(raw.optString("moodCause"), 48));
        put(card, "stanceTowardPlayer", orFallback(compact(raw.optString("stanceTowardPlayer"), 36),
            fallback.optString("stanceTowardPlayer")));
        put(card, "ownLifeFocus", compact(raw.optString("ownLifeFocus"), 48));
        put(card, "noticedPoint", compact(raw.optString("noticedPoint"), 48));
        put(card, "replyImpulse", enumValue(raw.optString("replyImpulse"), IMPULSES, fallback.optString("replyImpulse")));
        put(card, "contactPressure", enumValue(raw.optString("contactPressure"), PRESSURES, fallback.optString("contactPressure")));
        put(card, "openingNeeded", raw.optBoolean("openingNeeded", false));
        put(card, "recommendedDirection", orFallback(compact(raw.optString("recommendedDirection"), 80),
            fallback.optString("recommendedDirection")));
        JSONArray avoid = new JSONArray();
        JSONArray rawAvoid = raw.optJSONArray("avoid");
        if (rawAvoid != null) {
            for (int index = 0; index < rawAvoid.length() && avoid.length() < 5; index++) {
                String value = compact(rawAvoid.optString(index), 40);
                if (!value.isEmpty()) avoid.put(value);
            }
        }
        put(card, "avoid", avoid);
        Set<String> validIds = new HashSet<>(context.latestMessageIds);
        LinkedHashSet<String> selectedIds = new LinkedHashSet<>();
        JSONArray rawIds = raw.optJSONArray("evidenceMessageIds");
        if (rawIds != null) {
            for (int index = 0; index < rawIds.length() && selectedIds.size() < 12; index++) {
                String value = rawIds.optString(index);
                if (validIds.contains(value)) selectedIds.add(value);
            }
            if (selectedIds.size() != rawIds.length()) issues.add("INVALID_EVIDENCE_IDS_REMOVED");
        }
        put(card, "evidenceMessageIds", new JSONArray(selectedIds));
        put(card, "confidence", confidence(raw.optDouble("confidence", 0)));
        return card;
    }

    private JSONObject fallback(Context context) {
        String scene = enumValue(context.scene, SCENES, "chat");
        String gap = timeGap(context.nowMs, context.lastMessageAt);
        String pressure = enumValue(context.previousContactPressure, PRESSURES, "none");
        boolean proactive = "proactive-chat".equals(scene);
        boolean opening = proactive && ("hours".equals(gap) || "overnight".equals(gap) || "days".equals(gap));
        JSONObject card = new JSONObject();
        put(card, "schemaVersion", 1);
        put(card, "scene", scene);
        put(card, "timeGap", gap);
        put(card, "silenceCause", proactive ? "uncertain" : "not_applicable");
        put(card, "previousContactPressure", pressure);
        put(card, "relationshipStageId", enumValue(context.relationshipStageId, STAGES, "new"));
        put(card, "playerIntent", "");
        put(card, "playerIntentConfidence", 0);
        put(card, "currentMood", "");
        put(card, "moodCause", "");
        put(card, "stanceTowardPlayer", proactive ? "保持自然联系，同时尊重对方节奏" : "按当前关系自然回应");
        put(card, "ownLifeFocus", "");
        put(card, "noticedPoint", "");
        put(card, "replyImpulse", proactive && "high".equals(pressure) ? "pause" : proactive ? "share" : "answer");
        put(card, "contactPressure", "low");
        put(card, "openingNeeded", opening);
        put(card, "recommendedDirection", proactive
            ? (opening ? "隔了一段时间，使用能独立看懂的自然开口或新的真实触发，不强求对方立刻回应"
                : "根据当前生活自然分享或轻量关心，不擅自判断玩家为何沉默")
            : "先按玩家消息的字面含义自然回应；潜台词证据不足时不强行心理分析");
        put(card, "avoid", new JSONArray(proactive
            ? Arrays.asList("把沉默直接解释成疏远", "连续催促回复")
            : Collections.singletonList("强行心理分析")));
        put(card, "evidenceMessageIds", new JSONArray());
        put(card, "confidence", 0.25);
        return card;
    }

    private static String formatDirector(JSONObject director, String playerName, String characterName) {
        JSONArray avoid = director.optJSONArray("avoid");
        List<String> avoidValues = new ArrayList<>();
        if (avoid != null) for (int index = 0; index < avoid.length(); index++) avoidValues.add(avoid.optString(index));
        return "【本轮隐藏导演卡】\n"
            + "以下内容只用于决定角色此刻的理解、情绪、边界和开口方向。\n"
            + "它不是台词提纲，不要求逐项表达，不得复述、解释或提及导演卡。\n"
            + "场景：" + director.optString("scene", "chat") + "；时间间隔：" + director.optString("timeGap", "instant")
            + "；关系阶段：" + director.optString("relationshipStageId", "new") + "\n"
            + "对" + compact(playerName, 24) + "意图的判断："
            + orFallback(director.optString("playerIntent"), "证据不足，按字面含义理解")
            + "（置信度 " + String.format(java.util.Locale.ROOT, "%.2f", director.optDouble("playerIntentConfidence", 0)) + "）\n"
            + compact(characterName, 24) + "当前情绪：" + orFallback(director.optString("currentMood"), "按当前语境自然形成")
            + "；原因：" + orFallback(director.optString("moodCause"), "无额外证据") + "\n"
            + "本轮态度与边界：" + director.optString("stanceTowardPlayer", "按当前关系自然回应") + "\n"
            + "自己的生活重心：" + orFallback(director.optString("ownLifeFocus"), "无须强行补充") + "\n"
            + "最值得接住的一点：" + orFallback(director.optString("noticedPoint"), "当前可见消息本身") + "\n"
            + "回复冲动：" + director.optString("replyImpulse", "answer") + "；联系压力："
            + director.optString("contactPressure", "low") + "；需要重新开口："
            + (director.optBoolean("openingNeeded") ? "是" : "否") + "\n"
            + "建议方向：" + director.optString("recommendedDirection", "自然回应") + "\n"
            + "本轮避免：" + (avoidValues.isEmpty() ? "无额外事项" : join(avoidValues, "；"));
    }

    public static final class Context {
        public final String scene;
        public final long nowMs;
        public final long lastMessageAt;
        public final String relationshipStageId;
        public final String previousContactPressure;
        public final List<String> latestMessageIds;

        public Context(String scene, long nowMs, long lastMessageAt, String relationshipStageId,
                       String previousContactPressure, List<String> latestMessageIds) {
            this.scene = scene;
            this.nowMs = nowMs;
            this.lastMessageAt = lastMessageAt;
            this.relationshipStageId = relationshipStageId;
            this.previousContactPressure = previousContactPressure;
            this.latestMessageIds = latestMessageIds == null ? Collections.emptyList() : latestMessageIds;
        }

        public static Context chat() {
            return new Context("chat", System.currentTimeMillis(), 0, "new", "none", Collections.emptyList());
        }

        public static Context fromSnapshot(JSONObject snapshot) {
            JSONObject safe = snapshot == null ? new JSONObject() : snapshot;
            JSONObject raw = safe.optJSONObject("directorContext");
            if (raw == null) raw = new JSONObject();
            List<String> ids = new ArrayList<>();
            JSONArray values = raw.optJSONArray("latestMessageIds");
            if (values != null) for (int index = 0; index < values.length(); index++) ids.add(values.optString(index));
            return new Context(
                raw.optString("scene", safe.optString("scene", "chat")),
                raw.optLong("nowMs", System.currentTimeMillis()),
                raw.optLong("lastMessageAt", 0),
                raw.optString("relationshipStageId", "new"),
                raw.optString("previousContactPressure", "none"),
                ids
            );
        }
    }

    public static final class Result {
        public final String memoryPack;
        public final JSONObject director;
        public final String directorSource;
        public final List<String> issues;

        Result(String memoryPack, JSONObject director, String directorSource, List<String> issues) {
            this.memoryPack = memoryPack;
            this.director = director;
            this.directorSource = directorSource;
            this.issues = Collections.unmodifiableList(new ArrayList<>(issues));
        }

        public String formatPrompt(String playerName, String characterName) {
            String memory = memoryPack == null || memoryPack.trim().isEmpty() ? "无相关记忆" : memoryPack.trim();
            return "【记忆 AI 本轮筛选结果】\n" + memory
                + "\n以上事件时间必须按记录理解，不得把昨天改写成今天。\n\n"
                + formatDirector(director, playerName, characterName);
        }
    }

    private static String timeGap(long now, long last) {
        if (last <= 0 || last > now) return "instant";
        long gap = now - last;
        if (gap < 5 * 60_000L) return "instant";
        if (gap < 2 * 60 * 60_000L) return "short";
        if (gap < 18 * 60 * 60_000L) return "hours";
        if (gap < 48 * 60 * 60_000L) return "overnight";
        return "days";
    }

    private static String compact(String value, int maxLength) {
        String text = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        return text.length() <= maxLength ? text : text.substring(0, maxLength);
    }

    private static String enumValue(String value, Set<String> values, String fallback) {
        return values.contains(value) ? value : fallback;
    }

    private static double confidence(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) return 0;
        return Math.max(0, Math.min(1, value));
    }

    private static String orFallback(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (Exception ignored) {
            // All values are JSON-compatible.
        }
    }

    private static Set<String> set(String... values) {
        return new HashSet<>(Arrays.asList(values));
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
