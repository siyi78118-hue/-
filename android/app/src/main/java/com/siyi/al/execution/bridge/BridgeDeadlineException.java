package com.siyi.al.execution.bridge;

public final class BridgeDeadlineException extends Exception {
    private final String turnId;

    public BridgeDeadlineException(String turnId) {
        super("bridge turn deadline exceeded: " + turnId);
        this.turnId = turnId == null ? "" : turnId;
    }

    public String turnId() { return turnId; }
}
