package com.siyi.al.execution;

import com.siyi.al.execution.bridge.BridgeResult;

public interface TurnBridgeGateway extends ModelGateway {
    boolean hasBridge();
    String bridgeDeviceId();
    BridgeResult executeBridgeTurn(TurnSubmission submission) throws Exception;

    /**
     * Executes against the same authenticated identity that was pinned while
     * preparing the submission.  Legacy gateways retain the old behavior;
     * production gateways must revalidate before crossing the network.
     */
    default BridgeResult executeBridgeTurnPinned(
        TurnSubmission submission, String expectedDeviceId
    ) throws Exception {
        String actual = bridgeDeviceId();
        if (expectedDeviceId == null || !expectedDeviceId.equals(actual)) {
            throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT: bridge device changed");
        }
        return executeBridgeTurn(submission);
    }
}
