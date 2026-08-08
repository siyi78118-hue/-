package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExecutionServicePolicyTest {
    @Test
    public void serviceRemainsStickyAfterOrdinaryProcessReclaim() {
        assertTrue(ExecutionServicePolicy.restartAfterProcessReclaim());
    }

    @Test
    public void localV2CompletedFallbackIsJournalOnly() {
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.JOURNAL_ONLY,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, 2, "android_fallback", "committed", "local"));
        assertFalse(ExecutionServicePolicy.shouldUseCanonicalReceipt(3, "COMPLETED", null));
    }

    @Test
    public void remoteV1CompletedCheckpointUsesCanonicalCoordinator() {
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.CANONICAL_RECEIPT,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, 1, "pc", "committed", "lan"));
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.CANONICAL_RECEIPT,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, 1, "pc", "committed", "cloud"));
        assertTrue(ExecutionServicePolicy.shouldUseCanonicalReceipt(
            3, "COMPLETED", null, 1, "pc", "committed", "lan"));
    }

    @Test
    public void redactedLocalFallbackNeverUsesAnyReceiptWriter() {
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.NONE,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", 213L, 2, "android_fallback", "redacted", "local"));
        assertFalse(ExecutionServicePolicy.shouldUseCanonicalReceipt(
            3, "COMPLETED", 213L, 1, "pc", "redacted", "lan"));
        assertEquals("CANCELLED",
            ExecutionServicePolicy.publicDisplayState("COMPLETED", 213L));
        assertTrue(ExecutionServicePolicy.isRedacted(213L));
        assertEquals("COMPLETED",
            ExecutionServicePolicy.publicDisplayState("COMPLETED", null));
        assertFalse(ExecutionServicePolicy.isRedacted(null));
    }

    @Test
    public void malformedOrUnknownV3AuthorityFailsClosedWithoutLegacyFallback() {
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.NONE,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, 2, "android_fallback", "committed", "cloud"));
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.NONE,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, null, "pc", "committed", "lan"));
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.NONE,
            ExecutionServicePolicy.classifyCompletedDelivery(
                3, "COMPLETED", null, 1, "pc", "open", "lan"));
    }

    @Test
    public void legacyCompletedTurnsKeepLegacyReceiptPathAndNotificationPolicy() {
        assertEquals(
            ExecutionServicePolicy.CompletedDeliveryPath.LEGACY_RECEIPT,
            ExecutionServicePolicy.classifyCompletedDelivery(
                2, "COMPLETED", null, null, null, null, null));
        assertTrue(AlNotificationPolicy.shouldNotifyCompletedTurn("visible", 1, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("skip", 0, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("action_only", 1, false));
        assertFalse(AlNotificationPolicy.shouldNotifyCompletedTurn("redacted", 1, false));
    }

    @Test
    public void lifecycleWakePolicyUsesLeaseAndRefreshExpiryInsteadOfTurnRecovery() {
        LifecycleControl pending = new LifecycleControl(
            "ctl_" + repeat('a'), LifecycleControl.CLEAR_KIND, "yuqi", "device-1",
            1L, 7L, 100L, "{}", repeat('b'), LifecycleControl.PENDING,
            "lease", 1L, 1_000L, null, null, null, 100L);
        LifecycleControl accepted = new LifecycleControl(
            "ctl_" + repeat('a'), LifecycleControl.CLEAR_KIND, "yuqi", "device-1",
            1L, 7L, 100L, "{}", repeat('b'), LifecycleControl.RELAY_ACCEPTED,
            null, 1L, null, "ctlmsg_" + repeat('c'), null, 100_000_000L, 100L);

        assertEquals(61_000L, LifecycleControlSender.nextEligibleAt(pending, 1_000L));
        assertEquals(
            100_000_000L - LifecycleControlSender.REFRESH_WINDOW_MILLIS,
            LifecycleControlSender.nextEligibleAt(accepted, 1_000L));
    }

    @Test
    public void lifecycleWakeUsesAnIndependentUniqueWorkName() {
        assertFalse(AlExecutionWakeWorker.lifecycleWorkName()
            .equals(AlExecutionWakeWorker.generalWorkName()));
    }

    private static String repeat(char value) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < 64; index += 1) result.append(value);
        return result.toString();
    }
}
