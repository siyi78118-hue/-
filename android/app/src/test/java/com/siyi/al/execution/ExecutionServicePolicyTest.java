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
}
