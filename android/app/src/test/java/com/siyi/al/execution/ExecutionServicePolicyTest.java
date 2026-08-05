package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExecutionServicePolicyTest {
    @Test
    public void serviceRemainsStickyAfterOrdinaryProcessReclaim() {
        assertTrue(ExecutionServicePolicy.restartAfterProcessReclaim());
    }

    @Test
    public void everyStoreOwnedV3CompletedTurnUsesCanonicalCoordinator() {
        assertTrue(ExecutionServicePolicy.shouldUseCanonicalReceipt(3, "COMPLETED", null));
        assertTrue(ExecutionServicePolicy.shouldUseCanonicalReceipt(3, "COMPLETED", 123L));
        assertFalse(ExecutionServicePolicy.shouldUseCanonicalReceipt(1, "COMPLETED", null));
        assertFalse(ExecutionServicePolicy.shouldUseCanonicalReceipt(2, "COMPLETED", null));
        assertFalse(ExecutionServicePolicy.shouldUseCanonicalReceipt(3, "FAILED", null));
    }
}
