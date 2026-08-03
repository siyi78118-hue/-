package com.siyi.al.execution;

import com.siyi.al.execution.bridge.BridgeResult;

public interface TurnBridgeGateway extends ModelGateway {
    boolean hasBridge();
    String bridgeDeviceId();
    BridgeResult executeBridgeTurn(TurnSubmission submission) throws Exception;
}
