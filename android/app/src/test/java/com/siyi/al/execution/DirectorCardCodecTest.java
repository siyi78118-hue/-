package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

public class DirectorCardCodecTest {
    @Test
    public void parsesMemoryPackAndNormalizesDirector() throws Exception {
        DirectorCardCodec codec = new DirectorCardCodec();
        DirectorCardCodec.Context context = new DirectorCardCodec.Context(
            "proactive-chat",
            1_722_158_800_000L,
            1_722_148_000_000L,
            "familiar",
            "low",
            Arrays.asList("msg_1")
        );
        DirectorCardCodec.Result result = codec.parse(
            "{\"memoryPack\":\"[2026-07-27] 约好下班说一声\","
                + "\"director\":{\"scene\":\"proactive-chat\",\"timeGap\":\"hours\","
                + "\"silenceCause\":\"temporary_absence\",\"replyImpulse\":\"share\","
                + "\"evidenceMessageIds\":[\"msg_1\",\"missing\"],\"confidence\":0.8}}",
            context
        );

        assertEquals("[2026-07-27] 约好下班说一声", result.memoryPack);
        assertEquals("proactive-chat", result.director.getString("scene"));
        assertEquals(1, result.director.getJSONArray("evidenceMessageIds").length());
        assertEquals("memory-ai", result.directorSource);
    }

    @Test
    public void malformedMemoryFallsBackWithoutLosingUsefulText() {
        DirectorCardCodec.Result result = new DirectorCardCodec().parse(
            "昨天约好下班说一声",
            DirectorCardCodec.Context.chat()
        );

        assertEquals("昨天约好下班说一声", result.memoryPack);
        assertEquals("fallback", result.directorSource);
        assertTrue(result.director.optDouble("confidence") <= 0.5);
    }

    @Test
    public void promptKeepsMemoryAndDirectorAsSeparateSections() {
        DirectorCardCodec.Result result = new DirectorCardCodec().parse(
            "普通记忆文本",
            DirectorCardCodec.Context.chat()
        );
        String prompt = result.formatPrompt("姜隽倚", "虞栖");

        assertTrue(prompt.contains("【记忆 AI 本轮筛选结果】"));
        assertTrue(prompt.contains("【本轮隐藏导演卡】"));
        assertTrue(prompt.contains("不是台词提纲"));
    }
}
