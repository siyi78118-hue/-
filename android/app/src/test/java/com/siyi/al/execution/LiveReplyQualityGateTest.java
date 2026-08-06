package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class LiveReplyQualityGateTest {
    @Test
    public void endTurnLeakRequiresRewrite() {
        LiveReplyQualityGate.Report report = new LiveReplyQualityGate().inspect(
            "晚点说\nend_turn",
            LiveReplyQualityGate.Context.chat()
        );

        assertTrue(report.hardCodes.contains("CONTROL_MARKER_LEAK"));
        assertTrue(report.rewriteNeeded);
    }

    @Test
    public void paymentNeverUsesSemanticRewrite() {
        LiveReplyQualityGate.Report report = new LiveReplyQualityGate().inspect(
            "怎么不回？在吗？",
            LiveReplyQualityGate.Context.payment()
        );

        assertFalse(report.rewriteNeeded);
    }

    @Test
    public void repeatedPressurePlusQuestionOverloadRewritesOnce() {
        LiveReplyQualityGate.Context context = LiveReplyQualityGate.Context.proactive(
            1_722_158_800_000L,
            1_722_148_000_000L,
            "high",
            ""
        );
        LiveReplyQualityGate.Report report = new LiveReplyQualityGate().inspect(
            "怎么不回？在吗？干嘛呢？",
            context
        );

        assertTrue(report.softCodes.size() >= 2);
        assertTrue(report.rewriteNeeded);
    }

    @Test
    public void validHiddenDirectiveIsExcludedFromVisibleChecks() {
        LiveReplyQualityGate.Report report = new LiveReplyQualityGate().inspect(
            "好，晚点说。\n<al_schedule>{\"at\":123}</al_schedule>",
            LiveReplyQualityGate.Context.chat()
        );

        assertTrue(report.visibleText.contains("好，晚点说。"));
        assertFalse(report.visibleText.contains("al_schedule"));
        assertFalse(report.rewriteNeeded);
    }

    @Test
    public void fallbackStatePatchCannotPersistInferredHardConstraint() throws Exception {
        JSONObject safe = LiveReplyQualityGate.sanitizeFallbackStatePatch(
            new JSONObject().put("hardConstraints", new JSONArray().put("inferred"))
                .put("pendingReview", true)
        );
        assertFalse(safe.has("hardConstraints"));
        assertTrue(safe.getBoolean("pendingReview"));
    }
}
