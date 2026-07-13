package com.siyi.al.execution;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExecutionServicePolicyTest {
    @Test
    public void serviceRemainsStickyAfterOrdinaryProcessReclaim() {
        assertTrue(ExecutionServicePolicy.restartAfterProcessReclaim());
    }
}
