package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.net.SocketException;
import java.net.SocketTimeoutException;
import com.siyi.al.execution.bridge.BridgePendingException;
import org.junit.Test;

public class RetryPolicyTest {
    private final RetryPolicy policy = new RetryPolicy();

    @Test
    public void connectionAbortIsRetryable() {
        RetryPolicy.Decision decision = policy.classify(new SocketException("Software caused connection abort"));
        assertEquals("NETWORK_INTERRUPTED", decision.code);
        assertTrue(decision.retryable);
    }

    @Test
    public void socketTimeoutIsRetryable() {
        RetryPolicy.Decision decision = policy.classify(new SocketTimeoutException("Read timed out"));
        assertEquals("NETWORK_TIMEOUT", decision.code);
        assertTrue(decision.retryable);
    }

    @Test
    public void pendingDedicatedBridgeTurnRemainsRetryable() {
        RetryPolicy.Decision decision = policy.classify(new BridgePendingException("cloud still working"));
        assertEquals("BRIDGE_PENDING", decision.code);
        assertTrue(decision.retryable);
    }
}
